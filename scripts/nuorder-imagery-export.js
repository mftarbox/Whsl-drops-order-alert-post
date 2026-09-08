// NuOrder Imagery Export workflow: every Wholesale WIP item linked to a WIP2027 item gets its
// images exported to the NuOrder Imagery Dropbox folder, gated purely on WIP2027's own "NuOrder
// Images Exported" checkbox (boolean_mm61mp3r) - if it's checked, nothing to do; if unchecked,
// attempt the export, and only check the box once the export completes without error.
//
// CHANGED 2026-09-08 (Shelly's request, second round the same day): the trigger used to also
// require Wholesale WIP's "Add to NuOrder" status to be "Add", and used to flip that same status
// to "Update NetSuite" once an export was attempted. Both of those are gone now - this feature no
// longer reads OR writes "Add to NuOrder" at all. Shelly asked for the trigger to instead be
// "NuOrder Images Exported" checked/unchecked, full stop - she referred to it by Wholesale WIP's
// mirror column (lookup_mm613cyz), but mirror/lookup columns can't be read via Monday's API at
// all (same platform limitation as Planning Indicator - see docs/spec.md), so this reads the real
// underlying field on WIP2027 instead (the one the mirror just displays), confirmed with her
// before building. Practical effect: this is now a standing "keep Dropbox in sync with whatever
// images exist" process for every linked item, independent of where that item sits in the NuOrder
// pipeline - see docs/spec.md decision 26.
//
// Split out of the original combined run.js on 2026-09-08 (Shelly's request - see docs/spec.md
// decision 25) into its own standalone workflow/script, so it can be run (and re-run) on its own
// - including manually, e.g. right after adding an image to an item that failed export for lack
// of one - without also re-running the Dropped-rework feature. The Celigo "Monday to NetSuite"
// sync trigger that used to fire at the end of the combined script now lives in its own
// celigo-sync.js, chained to run automatically after this workflow completes (see
// .github/workflows/celigo-sync.yml).

import { mondayGraphQL, getAssets } from './lib/monday.js';
import { uploadFile as uploadToDropbox } from './lib/dropbox.js';
import { sendSlackAlert } from './lib/slack.js';
import { isManualRun, isEightPmMountain } from './lib/schedule.js';
import { getWholesaleWipItems, chunk, isChecked } from './lib/wholesale-wip.js';

const SOURCE = 'NuOrder Imagery Export';

const WIP2027_BOARD = 18388071004;
const COL_WIP2027_IMAGE = 'files2__1'; // WIP2027 Image column (the real field - see lib/wholesale-wip.js note)
const COL_WIP2027_IMAGES_EXPORTED = 'boolean_mm61mp3r'; // WIP2027 "NuOrder Images Exported" checkbox
// The "New Pic!" button (button_mm615zp0, also on WIP2027) isn't read by this script at all - it's
// wired via a native monday board automation that unchecks COL_WIP2027_IMAGES_EXPORTED directly,
// which is what actually causes this script to re-detect and re-export on its next run.

// Confirmed live on 2026-08-08 by resolving Shelly's original share link's folder name against
// a full account-wide Dropbox search - there's a second, unrelated "NuOrder Imagery" folder
// nested under /Apps/nuorder-imagery-netsuite-sync from an earlier integration attempt; this is
// deliberately NOT that one.
const DROPBOX_IMAGERY_FOLDER = '/NuOrder Imagery';

// Batched in chunks of 100 - same reason as dropped-alert.js's getPlanningIndicators() (Monday's
// items(ids:) 100-ID cap, PLUS its default limit:25 truncation when `limit` isn't explicitly
// passed - see docs/spec.md decision 22 for the full incident writeup).
async function getWip2027ImageExportState(itemIds) {
  if (itemIds.length === 0) return {};
  const map = {};
  for (const batch of chunk(itemIds, 100)) {
    const data = await mondayGraphQL(
      `
      query ($itemIds: [ID!]) {
        items(ids: $itemIds, limit: 100) {
          id
          column_values(ids: ["${COL_WIP2027_IMAGES_EXPORTED}", "${COL_WIP2027_IMAGE}"]) {
            id
            value
            ... on CheckboxValue { checked }
          }
        }
      }
      `,
      { itemIds: batch },
    );

    for (const item of data.items) {
      const cv = Object.fromEntries(item.column_values.map((c) => [c.id, c]));
      let files = [];
      try {
        const parsed = cv[COL_WIP2027_IMAGE]?.value ? JSON.parse(cv[COL_WIP2027_IMAGE].value) : null;
        files = parsed?.files || [];
      } catch {
        files = [];
      }
      map[item.id] = {
        imagesExported: isChecked(cv[COL_WIP2027_IMAGES_EXPORTED]),
        files,
      };
    }
  }
  return map;
}

async function markImagesExported(wip2027Id) {
  await mondayGraphQL(
    `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
    `,
    {
      boardId: WIP2027_BOARD,
      itemId: wip2027Id,
      columnId: COL_WIP2027_IMAGES_EXPORTED,
      value: JSON.stringify({ checked: 'true' }),
    },
  );
}

// Exports every image in WIP2027's Image column, renamed to "{Master SKU}-0{sequence}.{ext}"
// (e.g. "10176-3232-01.png", confirmed with Shelly against real filenames on 2026-08-07 - the
// convention is a literal "0" + a single-digit sequence, since up to 5 images is the practical
// max). Sequence follows the order files appear in the column (upload order). Binary content,
// file type, and file size pass through completely untouched - only the filename changes.
async function exportImagesToDropbox(target, files) {
  if (files.length === 0) {
    // Shelly's call, 2026-09-08: a missing image is a real export failure, not a silent skip -
    // it needs a Slack alert like any other export problem, and "Add to NuOrder" should still
    // flip to "Update NetSuite" afterward (handled by the caller's `finally` block) so the item
    // doesn't get stuck at "Add" forever with no downstream signal. Throwing here (rather than
    // just letting the loop below no-op on an empty array) is what makes that happen - an empty
    // `files` array would otherwise iterate zero times and return "successfully" with zero
    // uploads, which would incorrectly mark the item as exported.
    throw new Error('No images found on linked WIP2027 item');
  }

  const assetIds = files.map((f) => String(f.assetId));
  const assets = await getAssets(assetIds);
  const assetById = Object.fromEntries(assets.map((a) => [a.id, a]));

  for (let i = 0; i < files.length; i++) {
    const fileRef = files[i];
    const asset = assetById[String(fileRef.assetId)];
    if (!asset) {
      throw new Error(`Could not resolve asset metadata for asset id ${fileRef.assetId}`);
    }

    const res = await fetch(asset.public_url);
    if (!res.ok) {
      throw new Error(`Failed to download asset ${fileRef.assetId} (${res.status})`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    const ext = asset.file_extension || '';
    const filename = `${target.masterSku}-0${i + 1}${ext}`;

    await uploadToDropbox(`${DROPBOX_IMAGERY_FOLDER}/${filename}`, buffer);
  }
}

async function processNuOrderImageExports(wipItems) {
  // No "Add to NuOrder" filter anymore (removed 2026-09-08, Shelly's call) - every linked item is
  // a candidate, gated purely on whether its images are already exported (checked below).
  const targets = wipItems.filter((i) => i.wip2027Id);
  if (targets.length === 0) {
    console.log('No Wholesale WIP items linked to a WIP2027 item - nothing to check for imagery export.');
    return;
  }

  console.log(`Checking imagery export status for ${targets.length} linked item(s)...`);
  const exportState = await getWip2027ImageExportState(targets.map((t) => t.wip2027Id));

  for (const target of targets) {
    const state = exportState[target.wip2027Id];
    if (!state) {
      console.warn(`  No WIP2027 data found for linked item ${target.wip2027Id} (Wholesale WIP item ${target.name}) - skipping.`);
      continue;
    }
    if (state.imagesExported) {
      // Checked - nothing to do. This is now the whole trigger: unchecked means "try to export",
      // checked means "leave it alone" (Shelly's call, 2026-09-08). Un-checked again by the
      // "New Pic!" button on WIP2027, which is what causes a re-export on a later run.
      continue;
    }
    if (!target.masterSku) {
      console.warn(`  Skipping imagery export for ${target.name} - no Master SKU value found.`);
      continue;
    }
    // No "no images found" skip here - an empty Image column falls through into the try block
    // below, where exportImagesToDropbox() explicitly throws so it's treated as a real export
    // failure (Slack alert), not a silent skip (see docs/spec.md decision 24). Since "Add to
    // NuOrder" is no longer touched at all (decision 26), a failure here just leaves the
    // checkbox unchecked and gets retried again on the next run, same as any of the skips above.

    try {
      await exportImagesToDropbox(target, state.files);
      await markImagesExported(target.wip2027Id);
      console.log(
        `  Exported ${state.files.length} image(s) for ${target.name} (Master SKU ${target.masterSku}) to Dropbox and marked as exported.`,
      );
    } catch (err) {
      console.error(`  Failed to export imagery for ${target.name}: ${err.message}`);
      await sendSlackAlert(
        `Failed to export NuOrder imagery for "${target.name}" (Master SKU ${target.masterSku || '(none)'}): ${err.message}`,
        { source: SOURCE },
      );
    }
  }
}

async function main() {
  if (!isManualRun() && !isEightPmMountain()) {
    // This cron fires twice a day (once for MST, once for MDT) so it always lands on 8pm
    // Mountain regardless of daylight saving. One of the two ticks is always a no-op by design.
    console.log('Not 8pm Mountain time right now - skipping this tick.');
    return;
  }

  console.log('Fetching Wholesale WIP items...');
  const wipItems = await getWholesaleWipItems();

  await processNuOrderImageExports(wipItems);
  console.log('Done.');
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await sendSlackAlert(`Fatal error - the run aborted before finishing:\n\`\`\`${err.stack || err.message}\`\`\``, {
    fatal: true,
    source: SOURCE,
  });
  process.exit(1);
});

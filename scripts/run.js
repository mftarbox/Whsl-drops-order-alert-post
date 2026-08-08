// Daily check: Wholesale WIP styles moved to "Dropped" -> matching not-fulfilled NetSuite
// wholesale orders (by Master SKU) -> create/update a Monday pulse on Wholesale Sales L10.
// Plus three related features that piggyback on the same daily run (see docs/spec.md for the
// full design and reasoning behind each piece):
//   1. Side effect of a drop: Wholesale WIP's "Add to NuOrder" flips to "Remove".
//   2. Side effect of a drop: a "close these order lines" CSV pulse on Sales Ops L10.
//   3. Independent trigger: Wholesale WIP items at "Add to NuOrder" = "Add" get their WIP2027
//      images exported to the NuOrder Imagery Dropbox folder.
//   4. Slack alerts to #whsl_ops_workflow_alerts on both fatal and per-item/per-order errors.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mondayGraphQL, getAssets, mondayUploadFile } from './lib/monday.js';
import { runSuiteQL, getRecord, getSalesOrderLines } from './lib/netsuite.js';
import { uploadFile as uploadToDropbox } from './lib/dropbox.js';
import { sendSlackAlert } from './lib/slack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'state', 'state.json');

// --- Board / column IDs (verified live against the actual boards on 2026-08-07/08) ---
const WHOLESALE_WIP_BOARD = 18419234689;
const WIP2027_BOARD = 18388071004;
const L10_BOARD = 3552781534;
const L10_GROUP = 'new_group_mkn8x1ye'; // "Wholesale Order Board"
const L10_PERSON_COLUMN = 'person';

const COL_BOARD_RELATION = 'board_relation_mm5z9qmh'; // Wholesale WIP -> WIP2027 Source Item link
const COL_MASTER_SKU = 'formula_mm5z9x2x'; // Wholesale WIP Master SKU (already includes 800-swap)
const COL_REWORK_CHECKBOX = 'boolean_mm60zwwz'; // "Rework Alert Sent" on Wholesale WIP
const COL_PLANNING_INDICATOR = 'status_1__1'; // Planning Indicator, read from WIP2027 directly
const COL_ADD_TO_NUORDER = 'color_mm5zz20q'; // Wholesale WIP "Add to NuOrder" status (Add/Remove/Synced)
// NOTE: Wholesale WIP also has a Planning Indicator column, but it's a "lookup"/mirror type,
// which monday.com's API cannot read or filter on at all (confirmed directly against the
// account). That's why this script reads status_1__1 on WIP2027 instead, using the
// board_relation link above to know which WIP2027 items are wholesale-relevant. The same
// limitation applies to Wholesale WIP's own Image column, which is why feature 3 below reads
// WIP2027's real files2__1 field instead.

const COL_WIP2027_IMAGE = 'files2__1'; // WIP2027 Image column (the real field - see note above)
const COL_WIP2027_IMAGES_EXPORTED = 'boolean_mm61mp3r'; // WIP2027 "NuOrder Images Exported" checkbox
// The "New Pic!" button (button_mm615zp0, also on WIP2027) isn't read by this script at all - it's
// wired via a native monday board automation that unchecks COL_WIP2027_IMAGES_EXPORTED directly,
// which is what actually causes this script to re-detect and re-export on its next run.

const SALES_OPS_BOARD = 7017226460;
const SALES_OPS_GROUP = 'new_group72329__1'; // "ToDo"
const SALES_OPS_PRIORITY_COLUMN = 'status_1_mkm2z4qr';
const SALES_OPS_PRIORITY_HIGH_LABEL = 'High Priority';
const NETSUITE_CLOSE_ITEMS_IMPORT_URL =
  'https://4775967.app.netsuite.com/app/setup/assistants/nsimport/importassistant.nl?recid=235&new=T';

// Confirmed live on 2026-08-08 by resolving Shelly's original share link's folder name against
// a full account-wide Dropbox search - there's a second, unrelated "NuOrder Imagery" folder
// nested under /Apps/nuorder-imagery-netsuite-sync from an earlier integration attempt; this is
// deliberately NOT that one.
const DROPBOX_IMAGERY_FOLDER = '/NuOrder Imagery';

const isManualRun = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

function isEightPmMountain() {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(hourStr) === 20;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function isChecked(checkboxColumnValue) {
  if (!checkboxColumnValue) return false;
  if (typeof checkboxColumnValue.checked === 'boolean') return checkboxColumnValue.checked;
  if (typeof checkboxColumnValue.checked === 'string') return checkboxColumnValue.checked === 'true';
  return checkboxColumnValue.text === 'v';
}

async function getWholesaleWipItems() {
  const data = await mondayGraphQL(
    `
    query ($boardId: ID!, $columnIds: [String!]) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values(ids: $columnIds) {
              id
              text
              value
              ... on BoardRelationValue { linked_item_ids }
              ... on FormulaValue { display_value }
              ... on CheckboxValue { checked }
            }
          }
        }
      }
    }
    `,
    {
      boardId: WHOLESALE_WIP_BOARD,
      columnIds: [COL_BOARD_RELATION, COL_MASTER_SKU, COL_REWORK_CHECKBOX, COL_ADD_TO_NUORDER],
    },
  );

  return data.boards[0].items_page.items.map((item) => {
    const cv = Object.fromEntries(item.column_values.map((c) => [c.id, c]));
    return {
      id: item.id,
      name: item.name,
      wip2027Id: cv[COL_BOARD_RELATION]?.linked_item_ids?.[0],
      masterSku: cv[COL_MASTER_SKU]?.display_value || cv[COL_MASTER_SKU]?.text,
      reworkAlertSent: isChecked(cv[COL_REWORK_CHECKBOX]),
      addToNuOrder: cv[COL_ADD_TO_NUORDER]?.text || null,
    };
  });
}

async function getPlanningIndicators(itemIds) {
  if (itemIds.length === 0) return {};
  const data = await mondayGraphQL(
    `
    query ($itemIds: [ID!]) {
      items(ids: $itemIds) {
        id
        column_values(ids: ["${COL_PLANNING_INDICATOR}"]) {
          text
        }
      }
    }
    `,
    { itemIds },
  );
  const map = {};
  for (const item of data.items) {
    map[item.id] = item.column_values[0]?.text;
  }
  return map;
}

// --- Feature 1: Add to NuOrder -> Remove -------------------------------------------------
// Unconditional side effect of a style dropping - fires regardless of whether any NetSuite
// orders end up matching, and before the Wholesale L10 / Sales Ops L10 pulses. The existing
// Celigo integration then automatically unchecks NetSuite's "NuOrder Active" checkbox on the
// matching item(s) on its own - nothing to build for that part.
async function setAddToNuOrderToRemove(itemId) {
  await mondayGraphQL(
    `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
    `,
    {
      boardId: WHOLESALE_WIP_BOARD,
      itemId,
      columnId: COL_ADD_TO_NUORDER,
      value: JSON.stringify({ label: 'Remove' }),
    },
  );
}

async function findMatchingOrderLines(masterSku) {
  const sql = `
    SELECT
      so.id AS so_internal_id,
      so.tranid AS order_number,
      so.entity AS customer_id,
      sol.item AS item_id,
      item.custitem8 AS master_sku,
      item.itemtype AS item_type,
      ABS(sol.quantity) AS qty_ordered,
      COALESCE(ABS(shipped.qty_shipped), 0) AS qty_shipped
    FROM transaction so
    JOIN transactionline sol ON sol.transaction = so.id AND sol.mainline = 'F'
    JOIN item ON item.id = sol.item
    LEFT JOIN (
      SELECT pl.previousdoc AS so_id, pl.previousline AS so_line, SUM(ifl.quantity) AS qty_shipped
      FROM PreviousTransactionLineLink pl
      JOIN transactionline ifl ON ifl.transaction = pl.nextdoc AND ifl.id = pl.nextline
      WHERE pl.linktype = 'ShipRcpt'
      GROUP BY pl.previousdoc, pl.previousline
    ) shipped ON shipped.so_id = sol.transaction AND shipped.so_line = sol.id
    WHERE so.type = 'SalesOrd'
      AND so.cseg_order_class = 7
      AND so.status IN ('B','D','E')
      AND item.custitem8 = '${escapeSql(masterSku)}'
      AND ABS(sol.quantity) > COALESCE(ABS(shipped.qty_shipped), 0)
  `;
  return runSuiteQL(sql);
}

// NetSuite's REST record API has no generic "item" endpoint - each item subtype needs its own
// endpoint name (confirmed: /record/v1/item 404s with "Record type 'item' does not exist").
// All Wholesale-relevant items seen so far are InvtPart ("inventoryitem"), but this maps the
// other common subtypes too and falls back to inventoryitem if something unexpected shows up.
const ITEM_TYPE_TO_RECORD_TYPE = {
  InvtPart: 'inventoryitem',
  NonInvtPart: 'noninventoryitem',
  Assembly: 'assemblyitem',
  Kit: 'kititem',
  Group: 'itemgroup',
  Service: 'serviceitem',
};

function recordTypeForItemType(itemType) {
  return ITEM_TYPE_TO_RECORD_TYPE[itemType] || 'inventoryitem';
}

// Shopify title = custitem_nu_sales_title, variant size = custitem35, sort position = custitem42
// (all confirmed with Shelly on 2026-08-07 against a real item record - see docs/spec.md
// decision 15). Items missing a position sort last rather than breaking the sort.
async function getItemDetails(itemId, itemType) {
  try {
    const rec = await getRecord(recordTypeForItemType(itemType), itemId, [
      'custitem_nu_sales_title',
      'custitem35',
      'custitem42',
    ]);
    const position = Number(rec.custitem42);
    return {
      shopifyTitle: rec.custitem_nu_sales_title || '(no title on file)',
      size: rec.custitem35?.refName || '(no size on file)',
      position: Number.isFinite(position) ? position : Number.MAX_SAFE_INTEGER,
    };
  } catch (err) {
    console.warn(`  Could not fetch item details for item ${itemId}: ${err.message}`);
    await sendSlackAlert(`Could not fetch item details for NetSuite item ${itemId}: ${err.message}`);
    return { shopifyTitle: '(unknown)', size: '(unknown)', position: Number.MAX_SAFE_INTEGER };
  }
}

function buildNetSuiteOrderUrl(soInternalId) {
  const accountId = process.env.NETSUITE_ACCOUNT_ID;
  return `https://${accountId}.app.netsuite.com/app/accounting/transactions/salesord.nl?id=${soInternalId}`;
}

// Builds the rich comment posted to the pulse (both on first creation and on every later
// append) - see docs/spec.md decision 15. Only reflects drops found in *this* run, per Shelly's
// call on 2026-08-07 (not a full cumulative history across every past alert on this order).
function buildCommentBody({ orderNumber, customerName, soInternalId, skuRows, variantRows }) {
  const skuLines = skuRows.map((r) => `${r.masterSku} | ${r.shopifyTitle}`).join('<br>');
  const variantLines = variantRows.map((r) => `${r.size} | ${r.qtyOrdered}`).join('<br>');
  return [
    `<b>Order:</b> ${orderNumber}`,
    `<b>Customer:</b> ${customerName}`,
    `<b>NetSuite Sales Order:</b> ${buildNetSuiteOrderUrl(soInternalId)}`,
    '',
    '<b>Dropped Master SKU | Shopify Title</b>',
    skuLines,
    '',
    '<b>Variant Size | Qty Ordered</b>',
    variantLines,
  ].join('<br>');
}

async function getCustomerName(customerId) {
  try {
    const cust = await getRecord('customer', customerId, ['entityid']);
    return cust.entityId || `Customer ${customerId}`;
  } catch (err) {
    console.warn(`  Could not fetch customer ${customerId}: ${err.message}`);
    await sendSlackAlert(`Could not fetch NetSuite customer ${customerId}: ${err.message}`);
    return `Customer ${customerId}`;
  }
}

// Resolves the NetSuite employee whose email should be assigned to the pulse:
// - Get the order's salesrep.
// - If that employee's custentity_shin_inside_rep is true, use the salesrep themselves.
// - Otherwise use whoever is in that employee's custentity_assigned_inside_rep field.
async function resolvePersonEmail(soInternalId) {
  const so = await getRecord('salesorder', soInternalId, ['salesrep']);
  const salesRepId = so.salesRep?.id;
  if (!salesRepId) return null;

  const rep = await getRecord('employee', salesRepId, [
    'custentity_shin_inside_rep',
    'custentity_assigned_inside_rep',
    'email',
  ]);

  const isInsideRep = rep.custentity_shin_inside_rep === true || rep.custentity_shin_inside_rep === 'true';
  if (isInsideRep) {
    return rep.email || null;
  }

  const assignedId = rep.custentity_assigned_inside_rep?.id;
  if (!assignedId) return null;

  const assignedRep = await getRecord('employee', assignedId, ['email']);
  return assignedRep.email || null;
}

async function getMondayUserByEmail(email) {
  if (!email) return null;
  const data = await mondayGraphQL(
    `
    query ($emails: [String!]) {
      users(emails: $emails) {
        id
        name
        email
      }
    }
    `,
    { emails: [email] },
  );
  return data.users?.[0] || null;
}

// monday's `state` field on an item is "active", "archived", or "deleted". A fully deleted item
// simply won't come back in the items() query at all, so an empty result means "gone" too.
async function getPulseState(pulseId) {
  const data = await mondayGraphQL(
    `
    query ($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        state
      }
    }
    `,
    { itemId: pulseId },
  );
  return data.items?.[0]?.state || null;
}

async function postComment(pulseId, commentBody) {
  const data = await mondayGraphQL(
    `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
    `,
    { itemId: pulseId, body: commentBody },
  );
  return data.create_update.id;
}

async function createOrUpdatePulse({ orderNumber, customerName, personMondayId, commentBody }, state) {
  const existing = state[orderNumber];

  if (existing?.pulseId) {
    const pulseState = await getPulseState(existing.pulseId);
    if (pulseState === 'active') {
      await postComment(existing.pulseId, commentBody);
      console.log(`  Appended update to existing pulse ${existing.pulseId} for order ${orderNumber}.`);
      return existing.pulseId;
    }
    console.log(
      `  Existing pulse ${existing.pulseId} for order ${orderNumber} is no longer active (state: ${
        pulseState || 'not found'
      }) - creating a new pulse instead.`,
    );
  }

  const itemName = `${orderNumber} has drops - ${customerName}`;
  const columnValues = personMondayId
    ? { [L10_PERSON_COLUMN]: { personsAndTeams: [{ id: Number(personMondayId), kind: 'person' }] } }
    : {};

  const data = await mondayGraphQL(
    `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
    `,
    {
      boardId: L10_BOARD,
      groupId: L10_GROUP,
      itemName,
      columnValues: JSON.stringify(columnValues),
    },
  );

  const newPulseId = data.create_item.id;
  state[orderNumber] = { pulseId: newPulseId, createdAt: new Date().toISOString() };
  console.log(`  Created pulse ${newPulseId} for order ${orderNumber} ("${itemName}").`);

  await postComment(newPulseId, commentBody);
  return newPulseId;
}

async function markReworkAlertSent(itemId) {
  await mondayGraphQL(
    `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
    `,
    {
      boardId: WHOLESALE_WIP_BOARD,
      itemId,
      columnId: COL_REWORK_CHECKBOX,
      value: JSON.stringify({ checked: 'true' }),
    },
  );
}

// --- Feature 2: Sales Ops L10 "close items" CSV pulse ------------------------------------
// Reuses the exact same NetSuite rows already fetched for the Wholesale L10 rep pulses (see
// main()) - no separate matching query. Per matched order line we additionally need "Closed"
// and "Line ID" (= Line Unique Key), which come from a NetSuite record-level fetch of that
// order's item sublist (see lib/netsuite.js getSalesOrderLines) rather than another SuiteQL
// call, since both fields error out via bulk SuiteQL in this account. Cached per order for the
// life of a run, and each line is only ever handed out once (queued by item id) so two rows
// referencing the exact same item on an order can't both grab the same underlying line.
async function resolveOrderLineDetails(soInternalId, itemId, lineQueueCache) {
  if (!lineQueueCache.has(soInternalId)) {
    let lines = [];
    try {
      lines = await getSalesOrderLines(soInternalId);
    } catch (err) {
      console.warn(`  Could not fetch line details for order ${soInternalId}: ${err.message}`);
      await sendSlackAlert(
        `Could not fetch NetSuite line details (isClosed/Line ID) for order internal id ${soInternalId}: ${err.message}`,
      );
    }
    const queueByItem = new Map();
    for (const line of lines) {
      const key = String(line.itemId);
      if (!queueByItem.has(key)) queueByItem.set(key, []);
      queueByItem.get(key).push(line);
    }
    lineQueueCache.set(soInternalId, queueByItem);
  }

  const queueByItem = lineQueueCache.get(soInternalId);
  const queue = queueByItem.get(String(itemId));
  if (!queue || queue.length === 0) return null;
  return queue.shift();
}

function buildCloseItemsCsv(rows) {
  const header = 'Internal ID,Closed,Line ID';
  const lines = rows.map((r) => `${r.internalId},${r.closed},${r.lineId}`);
  return [header, ...lines].join('\n') + '\n';
}

async function createSalesOpsCsvPulse(masterSku, csvRows) {
  const itemName = `${masterSku} dropped - Close items on Sales Orders`;
  const columnValues = {
    [SALES_OPS_PRIORITY_COLUMN]: { label: SALES_OPS_PRIORITY_HIGH_LABEL },
  };

  const data = await mondayGraphQL(
    `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
    `,
    {
      boardId: SALES_OPS_BOARD,
      groupId: SALES_OPS_GROUP,
      itemName,
      columnValues: JSON.stringify(columnValues),
    },
  );
  const pulseId = data.create_item.id;

  const commentBody = [
    `<b>${masterSku}</b> dropped - the attached CSV lists every affected sales order line to close in NetSuite.`,
    '',
    `Close Sales Order Items CSV Import mapping: <a href="${NETSUITE_CLOSE_ITEMS_IMPORT_URL}">${NETSUITE_CLOSE_ITEMS_IMPORT_URL}</a>`,
  ].join('<br>');
  const updateId = await postComment(pulseId, commentBody);

  const csvContent = buildCloseItemsCsv(csvRows);
  await mondayUploadFile({
    query: `mutation ($file: File!) { add_file_to_update (update_id: ${updateId}, file: $file) { id } }`,
    fieldName: 'variables[file]',
    filename: `${masterSku}-close-items.csv`,
    buffer: Buffer.from(csvContent, 'utf8'),
    mimeType: 'text/csv',
  });

  console.log(`  Created Sales Ops L10 pulse ${pulseId} for "${masterSku}" with ${csvRows.length} line(s).`);
  return pulseId;
}

// --- Feature 3: NuOrder imagery export to Dropbox -----------------------------------------
// Independent of the Dropped trigger above - runs every time this script runs (same 8pm
// Mountain cadence), gated purely on Wholesale WIP's real "Add to NuOrder" status column and
// WIP2027's own "NuOrder Images Exported" checkbox (idempotency + re-trigger, see docs/spec.md).
async function getWip2027ImageExportState(itemIds) {
  if (itemIds.length === 0) return {};
  const data = await mondayGraphQL(
    `
    query ($itemIds: [ID!]) {
      items(ids: $itemIds) {
        id
        column_values(ids: ["${COL_WIP2027_IMAGES_EXPORTED}", "${COL_WIP2027_IMAGE}"]) {
          id
          value
          ... on CheckboxValue { checked }
        }
      }
    }
    `,
    { itemIds },
  );

  const map = {};
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
  const targets = wipItems.filter((i) => i.addToNuOrder === 'Add' && i.wip2027Id);
  if (targets.length === 0) {
    console.log('No items at Add to NuOrder = Add with a linked WIP2027 item - nothing to check for imagery export.');
    return;
  }

  console.log(`Checking imagery export status for ${targets.length} item(s) at Add to NuOrder = Add...`);
  const exportState = await getWip2027ImageExportState(targets.map((t) => t.wip2027Id));

  for (const target of targets) {
    const state = exportState[target.wip2027Id];
    if (!state) {
      console.warn(`  No WIP2027 data found for linked item ${target.wip2027Id} (Wholesale WIP item ${target.name}) - skipping.`);
      continue;
    }
    if (state.imagesExported) {
      continue; // Already exported, and "New Pic!" hasn't been pressed to reset it since.
    }
    if (!target.masterSku) {
      console.warn(`  Skipping imagery export for ${target.name} - no Master SKU value found.`);
      continue;
    }
    if (state.files.length === 0) {
      console.warn(`  Skipping imagery export for ${target.name} - no images found on linked WIP2027 item.`);
      continue;
    }

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
      );
    }
  }
}

async function main() {
  if (!isManualRun && !isEightPmMountain()) {
    // This cron fires twice a day (once for MST, once for MDT) so it always lands on 8pm
    // Mountain regardless of daylight saving. One of the two ticks is always a no-op by design.
    console.log('Not 8pm Mountain time right now - skipping this tick.');
    return;
  }

  const state = loadState();

  console.log('Fetching Wholesale WIP items...');
  const wipItems = await getWholesaleWipItems();

  // --- Feature 3 (independent of the Dropped trigger below) ---
  await processNuOrderImageExports(wipItems);

  const candidates = wipItems.filter((i) => !i.reworkAlertSent && i.wip2027Id);

  if (candidates.length === 0) {
    console.log('Nothing to check for drops - no unprocessed items with a linked WIP2027 item.');
    saveState(state);
    console.log('Done.');
    return;
  }

  console.log(`Checking Planning Indicator on WIP2027 for ${candidates.length} linked item(s)...`);
  const indicators = await getPlanningIndicators(candidates.map((c) => c.wip2027Id));
  const droppedItems = candidates.filter((c) => indicators[c.wip2027Id] === 'Dropped');
  console.log(`${droppedItems.length} item(s) newly Dropped.`);

  // Aggregate every matching line across ALL dropped styles found in this run, grouped by
  // order - so if two styles drop in the same run and both hit the same order, that order gets
  // one combined comment instead of two separate ones (per Shelly's call on 2026-08-07).
  const orderMatches = new Map();
  const lineQueueCache = new Map(); // so_internal_id -> Map(item_id -> [line, ...]), see Feature 2

  for (const item of droppedItems) {
    console.log(`Processing dropped style: ${item.name} (Master SKU ${item.masterSku || '(none)'})`);

    // --- Feature 1: unconditional side effect, fires before everything else below ---
    try {
      await setAddToNuOrderToRemove(item.id);
      console.log(`  Set "Add to NuOrder" to Remove on ${item.name}.`);
    } catch (err) {
      console.error(`  Failed to set "Add to NuOrder" to Remove on ${item.name}: ${err.message}`);
      await sendSlackAlert(`Failed to set "Add to NuOrder" to Remove on "${item.name}": ${err.message}`);
    }

    if (!item.masterSku) {
      console.warn('  Skipping order matching - no Master SKU value found.');
      continue;
    }

    let rows;
    try {
      rows = await findMatchingOrderLines(item.masterSku);
    } catch (err) {
      console.error(`  NetSuite query failed: ${err.message}`);
      await sendSlackAlert(`NetSuite order-matching query failed for "${item.name}" (Master SKU ${item.masterSku}): ${err.message}`);
      continue;
    }
    console.log(`  ${rows.length} matching not-fulfilled order line(s) found.`);

    // --- Feature 2 accumulator: one CSV per dropped style, across every matched order ---
    const csvRows = [];

    for (const row of rows) {
      if (!orderMatches.has(row.order_number)) {
        orderMatches.set(row.order_number, {
          soInternalId: row.so_internal_id,
          customerId: row.customer_id,
          skuMap: new Map(),
          variantRows: [],
        });
      }
      const agg = orderMatches.get(row.order_number);
      const details = await getItemDetails(row.item_id, row.item_type);

      if (!agg.skuMap.has(row.master_sku)) {
        agg.skuMap.set(row.master_sku, { shopifyTitle: details.shopifyTitle });
      }
      agg.variantRows.push({ size: details.size, qtyOrdered: row.qty_ordered, position: details.position });

      const lineDetails = await resolveOrderLineDetails(row.so_internal_id, row.item_id, lineQueueCache);
      if (lineDetails) {
        csvRows.push({
          internalId: row.so_internal_id,
          closed: lineDetails.isClosed,
          lineId: lineDetails.lineUniqueKey,
        });
      } else {
        console.warn(
          `  Could not match a NetSuite order line for item ${row.item_id} on order ${row.order_number} - omitting from close-items CSV.`,
        );
      }
    }

    if (csvRows.length > 0) {
      try {
        await createSalesOpsCsvPulse(item.masterSku, csvRows);
      } catch (err) {
        console.error(`  Failed to create Sales Ops L10 close-items pulse for ${item.masterSku}: ${err.message}`);
        await sendSlackAlert(`Failed to create Sales Ops L10 close-items pulse for Master SKU ${item.masterSku}: ${err.message}`);
      }
    }

    try {
      await markReworkAlertSent(item.id);
      console.log(`  Marked "Rework Alert Sent" on ${item.name}.`);
    } catch (err) {
      console.error(`  Failed to check "Rework Alert Sent" on ${item.name}: ${err.message}`);
      await sendSlackAlert(`Failed to check "Rework Alert Sent" on "${item.name}": ${err.message}`);
    }
  }

  for (const [orderNumber, agg] of orderMatches) {
    try {
      const customerName = await getCustomerName(agg.customerId);
      const email = await resolvePersonEmail(agg.soInternalId);
      const mondayUser = await getMondayUserByEmail(email);

      if (email && !mondayUser) {
        console.warn(`  No Monday user found for email ${email} - pulse will be created with no assignee.`);
      }

      const skuRows = [...agg.skuMap.entries()].map(([masterSku, v]) => ({
        masterSku,
        shopifyTitle: v.shopifyTitle,
      }));
      const variantRows = [...agg.variantRows].sort((a, b) => a.position - b.position);
      const commentBody = buildCommentBody({
        orderNumber,
        customerName,
        soInternalId: agg.soInternalId,
        skuRows,
        variantRows,
      });

      await createOrUpdatePulse(
        { orderNumber, customerName, personMondayId: mondayUser?.id, commentBody },
        state,
      );
      saveState(state);
    } catch (err) {
      console.error(`  Failed to process order ${orderNumber}: ${err.message}`);
      await sendSlackAlert(`Failed to process order ${orderNumber}: ${err.message}`);
    }
  }

  saveState(state);
  console.log('Done.');
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await sendSlackAlert(`Fatal error - the run aborted before finishing:\n\`\`\`${err.stack || err.message}\`\`\``, {
    fatal: true,
  });
  process.exit(1);
});

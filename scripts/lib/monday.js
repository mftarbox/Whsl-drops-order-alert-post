// Minimal monday.com GraphQL client. No external dependencies - uses Node's built-in fetch.

const MONDAY_TOKEN = requireEnv('MONDAY_API_TOKEN');
const API_URL = 'https://api.monday.com/v2';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function mondayGraphQL(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: MONDAY_TOKEN,
      'Content-Type': 'application/json',
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// Added 2026-09-23 (Shelly's request) so dropped-alert.js's Catalog/NuOrder L10 and Sales Ops L10
// pulse-creation features can check for an existing pulse before creating a new one, instead of
// relying purely on the "Rework Alert Sent" checkbox as the only guard against duplicates (a
// partial failure - e.g. the checkbox update itself failing after the pulse already got created -
// otherwise leaves the item looking unprocessed on the next run, creating a second pulse for the
// same drop). Monday's API only supports substring matching on the name column (`contains_text`,
// no true exact-match operator - confirmed via get_column_type_info), so this fetches the (small)
// set of substring matches and filters down to an exact name match itself. Matches ANY item with
// that exact name anywhere on the board, regardless of group or status - not scoped to "active"
// items only, since a duplicate is a duplicate even if the original was later moved/completed.
export async function findItemByExactName(boardId, name) {
  const data = await mondayGraphQL(
    `
    query ($boardId: ID!, $name: CompareValue!) {
      boards(ids: [$boardId]) {
        items_page(limit: 25, query_params: { rules: [{ column_id: "name", compare_value: $name, operator: contains_text }] }) {
          items { id name }
        }
      }
    }
    `,
    { boardId, name },
  );
  const items = data.boards?.[0]?.items_page?.items || [];
  return items.find((item) => item.name === name) || null;
}

// Resolves file column asset IDs (parsed from a files-type column's raw `value` JSON) to
// downloadable metadata. `public_url` is a presigned S3 link valid for ~1 hour - fine since
// this is only ever used to immediately download and re-upload to Dropbox in the same run.
//
// Audited 2026-08-21 alongside the items(ids:) default-limit bug found elsewhere (see
// getPlanningIndicators() in run.js): confirmed via Monday's own schema introspection that
// `assets(ids:)`, unlike `items(ids:)`/`users(...)`, has NO `limit` argument at all - so there's
// no missing-limit bug to fix here (and no way to add one - `assets(ids: $ids, limit: 100)` is a
// GraphQL schema error, not a fix). This is only ever called with one Wholesale WIP item's own
// image files at a time (exportImagesToDropbox notes up to ~5 images is the practical max per
// item), so even if `assets` has its own undocumented default page size, it isn't reachable here.
export async function getAssets(assetIds) {
  if (!assetIds.length) return [];
  const data = await mondayGraphQL(
    `
    query ($ids: [ID!]!) {
      assets(ids: $ids) {
        id
        name
        public_url
        file_extension
        file_size
      }
    }
    `,
    { ids: assetIds },
  );
  return data.assets || [];
}

// monday's file-upload mutations (add_file_to_update, add_file_to_column, etc.) require a
// multipart/form-data POST to a separate REST-ish endpoint - they can't be sent as normal JSON
// GraphQL requests. Node 20's built-in FormData/Blob make this possible with no extra
// dependencies. `query` should be the full mutation string with the file argument named to
// match `fieldName` (e.g. `mutation ($file: File!) { add_file_to_update (update_id: 123, file: $file) { id } }`
// paired with fieldName "variables[file]").
export async function mondayUploadFile({ query, fieldName, filename, buffer, mimeType }) {
  const form = new FormData();
  form.append('query', query);
  form.append(fieldName, new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);

  const res = await fetch('https://api.monday.com/v2/file', {
    method: 'POST',
    headers: { Authorization: MONDAY_TOKEN },
    body: form,
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Monday file upload error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// Shared Wholesale WIP board access - used by both dropped-alert.js (the Dropped trigger) and
// nuorder-imagery-export.js (the independent Add-to-NuOrder imagery feature). Split out
// 2026-09-08 when the original single-script automation (run.js) was broken into separate
// GitHub Actions workflows per feature (see docs/spec.md decision 25) - both features need the
// exact same board fetch, so this stays in one place rather than being copy-pasted into both.
import { mondayGraphQL } from './monday.js';

// --- Board / column IDs (verified live against the actual boards on 2026-08-07/08) ---
export const WHOLESALE_WIP_BOARD = 18419234689;

export const COL_BOARD_RELATION = 'board_relation_mm5z9qmh'; // Wholesale WIP -> WIP2027 Source Item link
export const COL_MASTER_SKU = 'formula_mm5z9x2x'; // Wholesale WIP Master SKU (already includes 800-swap)
export const COL_REWORK_CHECKBOX = 'boolean_mm60zwwz'; // "Rework Alert Sent" on Wholesale WIP
export const COL_ADD_TO_NUORDER = 'color_mm5zz20q'; // Wholesale WIP "Add to NuOrder" status (Add/Remove/Synced)
// CHANGED 2026-09-23 (Shelly's request): dropped-alert.js used to read Planning Indicator from
// WIP2027's real status_1__1 column via the board_relation link above, because Wholesale WIP's
// OLD Planning Indicator column was a "lookup"/mirror type, which monday.com's API cannot read or
// filter on at all. Wholesale WIP has since gotten a new native status column, "WHSL Planning
// Indicator" (color_mm79m1dk), which the API CAN read directly - so this now fetches it straight
// off Wholesale WIP like every other column here, and dropped-alert.js no longer needs the
// WIP2027 link for detection at all. The same lookup/mirror limitation still applies to Wholesale
// WIP's own Image column, though, which is why nuorder-imagery-export.js still reads WIP2027's
// real files2__1 field instead.
export const COL_PLANNING_INDICATOR = 'color_mm79m1dk'; // Wholesale WIP "WHSL Planning Indicator" (native status)

// Added 2026-09-23 (Shelly's request) for the dropped-styles digest email + Catalog/NuOrder L10
// "Remove" pulse features in dropped-alert.js - both native text columns living directly on
// Wholesale WIP, no WIP2027 link or NetSuite lookup needed for either.
export const COL_PRODUCT_TYPE = 'text_mm4mg5an'; // Wholesale WIP "Product Type"
export const COL_PRINT_TITLE = 'text_mm4mef1k'; // Wholesale WIP "Print Title"

export function isChecked(checkboxColumnValue) {
  if (!checkboxColumnValue) return false;
  if (typeof checkboxColumnValue.checked === 'boolean') return checkboxColumnValue.checked;
  if (typeof checkboxColumnValue.checked === 'string') return checkboxColumnValue.checked === 'true';
  return checkboxColumnValue.text === 'v';
}

// Splits an array into chunks of at most `size` - used to stay under Monday's hard 100-item cap
// on both items_page pages and the root-level items(ids:) query (see 2026-08-21 bugs in
// docs/spec.md decision 22).
export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Bug found 2026-08-21: this originally fetched a single un-paginated items_page(limit: 100),
// silently missing every item beyond the first 100 Monday happened to return - on a 338-item
// board (as of 2026-08-20's bulk item creation), up to 238 items were invisible every run,
// regardless of their actual drop status. A real "Dropped" style (SHN-3191, Master SKU
// 10471-3191) was missed this way. Fixed to page through the full board via items_page's cursor
// until exhausted. See docs/spec.md decision 22 for the full incident writeup.
export async function getWholesaleWipItems() {
  const columnIds = [
    COL_BOARD_RELATION,
    COL_MASTER_SKU,
    COL_REWORK_CHECKBOX,
    COL_ADD_TO_NUORDER,
    COL_PLANNING_INDICATOR,
    COL_PRODUCT_TYPE,
    COL_PRINT_TITLE,
  ];
  const rawItems = [];
  let cursor = null;

  do {
    const data = await mondayGraphQL(
      cursor
        ? `
          query ($cursor: String!, $columnIds: [String!]) {
            next_items_page(limit: 100, cursor: $cursor) {
              cursor
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
          `
        : `
          query ($boardId: ID!, $columnIds: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 100) {
                cursor
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
      cursor ? { cursor, columnIds } : { boardId: WHOLESALE_WIP_BOARD, columnIds },
    );

    const page = cursor ? data.next_items_page : data.boards[0].items_page;
    rawItems.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  return rawItems.map((item) => {
    const cv = Object.fromEntries(item.column_values.map((c) => [c.id, c]));
    return {
      id: item.id,
      name: item.name,
      wip2027Id: cv[COL_BOARD_RELATION]?.linked_item_ids?.[0],
      masterSku: cv[COL_MASTER_SKU]?.display_value || cv[COL_MASTER_SKU]?.text,
      reworkAlertSent: isChecked(cv[COL_REWORK_CHECKBOX]),
      addToNuOrder: cv[COL_ADD_TO_NUORDER]?.text || null,
      planningIndicator: cv[COL_PLANNING_INDICATOR]?.text || null,
      productType: cv[COL_PRODUCT_TYPE]?.text || null,
      printTitle: cv[COL_PRINT_TITLE]?.text || null,
    };
  });
}

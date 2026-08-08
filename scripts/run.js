// Daily check: Wholesale WIP styles moved to "Dropped" -> matching not-fulfilled NetSuite
// wholesale orders (by Master SKU) -> create/update a Monday pulse on Wholesale Sales L10.
//
// See docs/spec.md for the full design and the reasoning behind each piece below.
// This is the first version of this script - it has NOT yet been run against production
// secrets. Expect to need a debugging pass on the first real (or manually triggered) run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mondayGraphQL } from './lib/monday.js';
import { runSuiteQL, getRecord } from './lib/netsuite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'state', 'state.json');

// --- Board / column IDs (verified live against the actual boards on 2026-08-07) ---
const WHOLESALE_WIP_BOARD = 18419234689;
const WIP2027_BOARD = 18388071004; // not queried directly here except by item id, see below
const L10_BOARD = 3552781534;
const L10_GROUP = 'new_group_mkn8x1ye'; // "Wholesale Order Board"
const L10_PERSON_COLUMN = 'person';

const COL_BOARD_RELATION = 'board_relation_mm5z9qmh'; // Wholesale WIP -> WIP2027 Source Item link
const COL_MASTER_SKU = 'formula_mm5z9x2x'; // Wholesale WIP Master SKU (already includes 800-swap)
const COL_REWORK_CHECKBOX = 'boolean_mm60zwwz'; // "Rework Alert Sent" on Wholesale WIP
const COL_PLANNING_INDICATOR = 'status_1__1'; // Planning Indicator, read from WIP2027 directly
// NOTE: Wholesale WIP also has a Planning Indicator column, but it's a "lookup"/mirror type,
// which monday.com's API cannot read or filter on at all (confirmed directly against the
// account). That's why this script reads status_1__1 on WIP2027 instead, using the
// board_relation link above to know which WIP2027 items are wholesale-relevant.

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
    { boardId: WHOLESALE_WIP_BOARD, columnIds: [COL_BOARD_RELATION, COL_MASTER_SKU, COL_REWORK_CHECKBOX] },
  );

  return data.boards[0].items_page.items.map((item) => {
    const cv = Object.fromEntries(item.column_values.map((c) => [c.id, c]));
    return {
      id: item.id,
      name: item.name,
      wip2027Id: cv[COL_BOARD_RELATION]?.linked_item_ids?.[0],
      masterSku: cv[COL_MASTER_SKU]?.display_value || cv[COL_MASTER_SKU]?.text,
      reworkAlertSent: isChecked(cv[COL_REWORK_CHECKBOX]),
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
  await mondayGraphQL(
    `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
    `,
    { itemId: pulseId, body: commentBody },
  );
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
  const candidates = wipItems.filter((i) => !i.reworkAlertSent && i.wip2027Id);

  if (candidates.length === 0) {
    console.log('Nothing to check - no unprocessed items with a linked WIP2027 item.');
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

  for (const item of droppedItems) {
    console.log(`Processing dropped style: ${item.name} (Master SKU ${item.masterSku || '(none)'})`);

    if (!item.masterSku) {
      console.warn('  Skipping - no Master SKU value found.');
      continue;
    }

    let rows;
    try {
      rows = await findMatchingOrderLines(item.masterSku);
    } catch (err) {
      console.error(`  NetSuite query failed: ${err.message}`);
      continue;
    }
    console.log(`  ${rows.length} matching not-fulfilled order line(s) found.`);

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
    }

    try {
      await markReworkAlertSent(item.id);
      console.log(`  Marked "Rework Alert Sent" on ${item.name}.`);
    } catch (err) {
      console.error(`  Failed to check "Rework Alert Sent" on ${item.name}: ${err.message}`);
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
    }
  }

  saveState(state);
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

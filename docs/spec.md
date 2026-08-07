# Design spec: Wholesale WIP "Dropped" → NetSuite Order Rework Alert

Full history of decisions and platform findings from building this automation (2026-08-07 build session). Kept here as the record of *why* the code looks the way it does.

## Goal

When a style's Planning Indicator moves to Dropped on Wholesale WIP, find every not-yet-fulfilled NetSuite wholesale order with a line item matching that style's Master SKU, and create/update a Monday pulse per affected order on Wholesale Sales L10 → Wholesale Order Board.

## Decisions

1. Trigger read: WIP2027's real `status_1__1` field, not Wholesale WIP's mirror column - monday.com's API cannot read or filter "lookup" (mirror) column types at all (confirmed directly: `"This column type is not supported yet in the API"`). Wholesale WIP's `board_relation_mm5z9qmh` link is used to scope WIP2027's 1,776 items down to the ~20 wholesale-relevant ones.
2. Delivery: scheduled GitHub Actions polling, not a live Monday webhook.
3. Cadence: once daily at 8:00 PM Mountain time. GitHub Actions cron is fixed UTC and doesn't observe daylight saving, so the workflow schedules two cron ticks (covering both MST and MDT) and the script itself checks the current Mountain hour, no-opping on whichever tick isn't actually 8pm right now.
4. Wholesale identifier: NetSuite `cseg_order_class` (a **custom** "Order Class" segment field, distinct from the standard NetSuite `class` field, which also exists on transactions but isn't the one used) = internal ID 7, confirmed via `BUILTIN.DF(cseg_order_class)` → "Wholesale".
5. "Not fulfilled" (header): order status B (Pending Fulfillment), D (Partially Fulfilled), or E (Pending Billing/Partially Fulfilled).
6. "Not fulfilled" (line level): required - a partially-fulfilled order should only trigger if the *specific line* matching the dropped SKU still has remaining quantity. `quantityFulfilled` isn't exposed to NetSuite's Search/SuiteQL API at all, so remaining quantity is computed via NetSuite's standard `PreviousTransactionLineLink` table (`linktype = 'ShipRcpt'`) joined back to the shipped Item Fulfillment lines, summed and compared to `quantity` (which is stored negative for outbound transactions like Sales Orders - use `ABS()`).
7. Destination: Wholesale Sales L10 (board 3552781534), group "Wholesale Order Board" (`new_group_mkn8x1ye`).
8. Idempotency: checkbox column "Rework Alert Sent" (`boolean_mm60zwwz`) added to Wholesale WIP - only unprocessed + Dropped items are considered.
9. No backfill - only styles that move to Dropped after this automation went live. (As of go-live, none of the 20 wholesale-relevant styles were sitting at Dropped, so no manual pre-check of the new checkbox was needed.)
10. Pulse name: `"{Order #} has drops - {Customer Name}"`.
11. Pulse `person`: order's `salesrep` (an employee) → if that employee's `custentity_shin_inside_rep` is true, use the salesrep; if false, use that same employee's `custentity_assigned_inside_rep` instead. Both fields live on the **Employee** record, not the Customer record (an early assumption that was wrong - customer-record fetches for these field IDs silently returned nothing rather than erroring, which is what surfaced the mistake). The resolved employee is matched to a Monday user by email (`users(emails: [...])`).
12. All other pulse columns (Priority, Status, Due Date, Notes, External ID) intentionally left blank for now.
13. An order that later matches a second dropped SKU gets an update/comment appended to its existing pulse rather than a duplicate pulse, tracked via `state/state.json` (order # → Monday pulse ID), committed back to the repo by the workflow each run.
14. No additional notification channel - the Monday pulse itself is sufficient.

## Platform quirks discovered along the way (useful if this ever breaks)

- monday.com's GraphQL API flatly cannot read/filter `lookup` (mirror) column types - not a reliability quirk, a hard "not supported" error.
- NetSuite's SuiteQL metadata-catalog endpoint (`/services/rest/query/v1/suiteql/metadata-catalog/...`) 500s for `salesorder`, `item`, and `transaction` record types due to unrelated dangling custom field references (`custbody_nu_shipping_calc_error`, `custitem_shinesty_forecast_end_date`) somewhere in the account's customization. Worth a NetSuite admin cleaning up eventually; the record-level metadata endpoint (`ns_getRecordTypeMetadata` equivalent, REST record API) works fine and was used instead to confirm field names.
- The standard `class` field can't be referenced bare in SuiteQL in this account (parser errors) - `cseg_order_class` works fine. To resolve a custom segment's display label from its internal ID in SuiteQL, use `BUILTIN.DF(field_name)` - the segment's own table name isn't queryable directly.
- `quantityFulfilled` on sales order lines: exists on the record, but explicitly `NOT_EXPOSED - Not available for channel SEARCH`. Use the `PreviousTransactionLineLink` / `ShipRcpt` approach instead.
- `salesrep` (on salesorder) and any field on `customer` error out completely via bulk SuiteQL (generic "unexpected SuiteScript error"), but read fine via a single-record REST fetch (`/services/rest/record/v1/...`). The script uses SuiteQL only for the order/line matching query, then per-matched-order record fetches for rep resolution.
- `transactionline.quantity` is stored **negative** for outbound transactions (Sales Orders, Item Fulfillments) per NetSuite's internal sign convention - always `ABS()` it.

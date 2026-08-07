# Whsl Drops Order Alert (post)

Automation: when a style's Planning Indicator moves to **Dropped** on the Shinesty "Wholesale WIP" Monday board, find every not-yet-fulfilled NetSuite wholesale order with a line item matching that style's Master SKU, and create/update a Monday pulse per affected order on **Wholesale Sales L10 → Wholesale Order Board**, so sales reps know to rework the order with the buyer.

Runs daily via GitHub Actions at 8:00 PM Mountain time. See `docs/spec.md` for the full design and decision log.

## Status

Code written 2026-08-07, **not yet run against production secrets**. First real (or manually-triggered) run should be treated as a test - watch the Action's logs closely.

## Setup (one-time)

1. Add these repository secrets (Settings → Secrets and variables → Actions → New repository secret):
   - `MONDAY_API_TOKEN`
   - `NETSUITE_ACCOUNT_ID`
   - `NETSUITE_CONSUMER_KEY`
   - `NETSUITE_CONSUMER_SECRET`
   - `NETSUITE_TOKEN_ID`
   - `NETSUITE_TOKEN_SECRET`
2. Copy `daily-check.yml` (delivered alongside this repo, since this bridge can't write directly into `.github/workflows/`) into `.github/workflows/daily-check.yml` in this repo, then commit and push it.
3. That's it - the schedule is in the workflow file itself.

## Testing

Go to the repo's **Actions** tab → "Wholesale Drops Order Alert" → **Run workflow** to trigger it manually any time (this bypasses the 8pm-Mountain check in the script). Watch the run's logs for each step: fetching Wholesale WIP items, checking Planning Indicator on WIP2027, the NetSuite query per dropped style, and pulse creation/update.

## How it works

1. Read Wholesale WIP's ~20 items (`board_relation_mm5z9qmh` link to WIP2027, `formula_mm5z9x2x` Master SKU, `boolean_mm60zwwz` "Rework Alert Sent" checkbox).
2. For items not yet marked processed, check their linked WIP2027 item's real `status_1__1` (Planning Indicator) field - **not** Wholesale WIP's own mirror of that field, since monday.com's API can't read/filter "lookup"-type (mirror) columns at all.
3. For each newly-Dropped style, query NetSuite (SuiteQL) for Wholesale orders (`cseg_order_class = 7`) that are not fulfilled (status Pending Fulfillment / Partially Fulfilled / Pending Billing-Partially Fulfilled) with a line matching the dropped Master SKU (`item.custitem8`) that still has quantity remaining (computed via NetSuite's `PreviousTransactionLineLink` / `ShipRcpt` join, since `quantityFulfilled` isn't exposed to NetSuite's search API).
4. For each matching order: resolve the responsible person (order's `salesrep` employee; if that employee's `custentity_shin_inside_rep` is true use them, otherwise use their `custentity_assigned_inside_rep`), match that person's NetSuite email to a Monday user, and create a new pulse (or add an update to an existing one, tracked in `state/state.json`) on Wholesale Sales L10 → Wholesale Order Board.
5. Mark the Wholesale WIP item's "Rework Alert Sent" checkbox so it isn't reprocessed.

## Layout

- `.github/workflows/daily-check.yml` — the scheduled GitHub Actions workflow (add manually, see Setup)
- `scripts/run.js` — main orchestration script
- `scripts/lib/netsuite.js` — NetSuite REST + SuiteQL client (hand-rolled OAuth 1.0a signing)
- `scripts/lib/monday.js` — monday.com GraphQL client
- `state/state.json` — order # → Monday pulse ID map, committed back by the workflow each run
- `docs/spec.md` — full design spec and decision log

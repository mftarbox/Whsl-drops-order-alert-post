// Celigo NetSuite Sync workflow: triggers two Celigo flows on-demand, one after the other.
//   1. "Monday to NetSuite" - syncs NetSuite's NuOrder Active / NuOrder Sync checkboxes off
//      whatever Wholesale WIP's "Add to NuOrder" column currently says. This fully replaces that
//      flow's separate Celigo-side schedule (Shelly's call, 2026-08-10).
//   2. "NetSuite Item to NuOrder Product & Size Create/Update" - added 2026-09-08 (Shelly's
//      request, see docs/spec.md decision 26) as a second step in this same workflow, run right
//      after flow 1. Each flow gets its own try/catch (same pattern as everywhere else in this
//      codebase) so a failure in one doesn't block or get masked by the other.
//
// Split out into its own workflow/script on 2026-09-08 (see docs/spec.md decision 25) when the
// original combined run.js was broken up into three separate workflows. Both the Dropped Rework
// Alert workflow (Feature 1's "Remove" flip) and the NuOrder Imagery Export workflow (Feature 3's
// "Update NetSuite" flip) can change "Add to NuOrder", so both need Celigo to run afterward -
// rather than duplicate the trigger call in both places, this script is the one place it lives,
// and .github/workflows/celigo-sync.yml auto-fires it via `workflow_run` after either of the
// other two workflows completes (in addition to its own workflow_dispatch for on-demand use).
//
// Same "is this the real 8pm Mountain tick" gate as the other two workflows, applied here too so
// this doesn't also fire (redundantly) on the twice-daily cron tick that isn't actually 8pm -
// Dropped Rework Alert and NuOrder Imagery Export both no-op on that tick, but a `workflow_run`
// trigger fires whenever the upstream workflow *completes* (even if it did nothing), so without
// this same gate, Celigo would get triggered on both daily ticks instead of just the real one.
// A manual run (whether of this workflow directly, or of the upstream one that chained into it)
// always goes through regardless of the hour, same convention as the other two scripts.
//
// Worth knowing: on a normal day this now fires up to twice - once after Dropped Rework Alert's
// real run, once after NuOrder Imagery Export's real run - instead of once, like the old combined
// script did. Celigo's flow just re-syncs off current Monday state, so firing it twice in a row
// is harmless, just slightly redundant. Flag it to Shelly if that turns out to matter (e.g. Celigo
// run-count/cost).
import { runCeligoFlow } from './lib/celigo.js';
import { sendSlackAlert } from './lib/slack.js';
import { isManualRun, isEightPmMountain } from './lib/schedule.js';

const SOURCE = 'Celigo NetSuite Sync';

// Celigo's native "Monday to NetSuite" sync flow - grabbed from the flow's URL in integrator.io
// (https://integrator.io/integrations/66f5896552a1b5dd437da348/flowBuilder/<this id>), 2026-08-10.
const CELIGO_MONDAY_TO_NETSUITE_FLOW_ID = '6a7520cb8d2dd2212253f91d';

// "NetSuite Item to NuOrder Product & Size Create/Update" - same integration
// (66f5896552a1b5dd437da348), different flow, added 2026-09-08 per Shelly's request:
// https://integrator.io/integrations/66f5896552a1b5dd437da348/flowBuilder/66e07296960e3ef4199b3c02
const CELIGO_NETSUITE_ITEM_TO_NUORDER_FLOW_ID = '66e07296960e3ef4199b3c02';

async function main() {
  if (!isManualRun() && !isEightPmMountain()) {
    console.log('Not 8pm Mountain time right now - skipping this tick.');
    return;
  }

  // Never throws past these - a Celigo failure shouldn't affect this workflow's exit code, same
  // convention as every other non-fatal error path across all three scripts (log + Slack alert
  // only, per Shelly's call). Each flow is wrapped independently so one failing doesn't block or
  // mask the other.
  try {
    await runCeligoFlow(CELIGO_MONDAY_TO_NETSUITE_FLOW_ID);
    console.log('Triggered Celigo Monday-to-NetSuite sync flow.');
  } catch (err) {
    console.error(`Failed to trigger Celigo Monday-to-NetSuite sync flow: ${err.message}`);
    await sendSlackAlert(`Failed to trigger Celigo Monday-to-NetSuite sync flow: ${err.message}`, { source: SOURCE });
  }

  try {
    await runCeligoFlow(CELIGO_NETSUITE_ITEM_TO_NUORDER_FLOW_ID);
    console.log('Triggered Celigo NetSuite Item to NuOrder Product & Size Create/Update flow.');
  } catch (err) {
    console.error(`Failed to trigger Celigo NetSuite Item to NuOrder Product & Size Create/Update flow: ${err.message}`);
    await sendSlackAlert(
      `Failed to trigger Celigo NetSuite Item to NuOrder Product & Size Create/Update flow: ${err.message}`,
      { source: SOURCE },
    );
  }

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

// Minimal Slack Incoming Webhook client. Two independent uses, two independent webhooks:
//   - sendSlackAlert: error/fatal alerts to #whsl_ops_workflow_alerts (SLACK_ALERTS_WEBHOOK_URL).
//   - sendSlackBlocks: the Feature 3 drop digest to #wholesale-drops (WHOLESALE_DROPS_SLACK_WEBHOOK_URL).
// Slack Incoming Webhooks are bound to one fixed channel at creation, so a second destination
// channel needs its own webhook URL/secret rather than a runtime parameter - see
// WHOLESALE_DROPS_SLACK_WEBHOOK_URL below.
//
// Neither function should ever throw - a Slack outage or misconfigured webhook should never be
// able to take down the actual automation run. Failures here are only ever logged to the console.

const ALERTS_WEBHOOK_URL = process.env.SLACK_ALERTS_WEBHOOK_URL;
const DROPS_WEBHOOK_URL = process.env.WHOLESALE_DROPS_SLACK_WEBHOOK_URL;

async function postToSlackWebhook(webhookUrl, payload, { envVarName, label }) {
  if (!webhookUrl) {
    console.warn(`${envVarName} not set - skipping ${label}.`);
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`${label} POST failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`${label} failed to send: ${err.message}`);
  }
}

// fatal: true = the whole run is aborting because of this. fatal: false = a single item/order
// failed and was skipped, but the run is continuing. Shelly asked for alerts on both tiers
// (2026-08-08).
//
// source: which workflow sent this alert (added 2026-09-08 when the original single-script
// automation was split into three separate GitHub Actions workflows - see docs/spec.md decision
// 25). Defaults to the original combined workflow's name so nothing breaks if some caller doesn't
// pass one, but every current caller does.
export async function sendSlackAlert(message, { fatal = false, source = 'Wholesale Drops Order Alert' } = {}) {
  const prefix = fatal ? ':red_circle: *FATAL ERROR*' : ':warning: *Error*';
  const text = `${prefix} - ${source} workflow\n${message}`;
  await postToSlackWebhook(ALERTS_WEBHOOK_URL, { text }, { envVarName: 'SLACK_ALERTS_WEBHOOK_URL', label: 'Slack alert' });
}

// Added 2026-09-23 (Shelly's request) for Feature 3: posts a Block Kit message - built by the
// caller (see buildDropDigestSlackBlocks in dropped-alert.js) - to #wholesale-drops instead of the
// error-alerts channel. `text` is the required Block Kit fallback/notification text, `blocks` is
// the full block array (already chunked to <=50 blocks per call by the caller, since Slack rejects
// a single message with more than that).
export async function sendSlackBlocks(text, blocks) {
  await postToSlackWebhook(
    DROPS_WEBHOOK_URL,
    { text, blocks },
    { envVarName: 'WHOLESALE_DROPS_SLACK_WEBHOOK_URL', label: 'drop digest Slack post' },
  );
}

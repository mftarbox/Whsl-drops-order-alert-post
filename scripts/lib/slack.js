// Minimal Slack Incoming Webhook client for error alerts to #whsl_ops_workflow_alerts.
//
// This must never throw - a Slack outage or misconfigured webhook should never be able to take
// down the actual automation run. Failures here are only ever logged to the console.

const WEBHOOK_URL = process.env.SLACK_ALERTS_WEBHOOK_URL;

// fatal: true = the whole run is aborting because of this. fatal: false = a single item/order
// failed and was skipped, but the run is continuing. Shelly asked for alerts on both tiers
// (2026-08-08).
export async function sendSlackAlert(message, { fatal = false } = {}) {
  if (!WEBHOOK_URL) {
    console.warn('SLACK_ALERTS_WEBHOOK_URL not set - skipping Slack alert. Message was:', message);
    return;
  }

  const prefix = fatal ? ':red_circle: *FATAL ERROR*' : ':warning: *Error*';
  const text = `${prefix} - Wholesale Drops Order Alert workflow\n${message}`;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn(`Slack alert POST failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`Slack alert failed to send: ${err.message}`);
  }
}

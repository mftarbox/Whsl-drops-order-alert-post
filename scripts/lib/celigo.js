// Minimal Celigo (integrator.io) client. No external dependencies - uses Node's built-in fetch.
//
// Used to trigger the existing native "Monday to NetSuite" Celigo flow on-demand at the very end
// of this script's run, instead of relying solely on Celigo's own separate schedule for that flow
// (2026-08-10, Shelly's request - see docs/spec.md for the full history). Confirmed via Celigo's
// own API docs that POST /v1/flows/{flowId}/run runs a flow on-demand regardless of whether it
// also has a native schedule configured - the two are independent, so this doesn't require (and
// shouldn't require) changing anything about the flow's existing schedule in Celigo.
//
// CELIGO_API_TOKEN was generated on Shelly's Celigo login, which has access via a shared account
// rather than an owned one - Celigo's UI rejects setting ANY access-scope field (even toggling
// "Full access" on) on a token generated this way ("Scope fields cannot be set on shared account
// tokens. Permissions are inherited from the account share."). The working fix was to generate
// the token with only name/description/expiration set and no scope fields touched at all -
// permissions are inherited automatically from whatever the account share already grants.

const API_BASE = process.env.CELIGO_API_BASE || 'https://api.integrator.io';

// Deliberately checked lazily, inside the function, NOT at module load time. This module is
// imported unconditionally at the top of run.js - if the token check ran at import time (like
// lib/monday.js and lib/dropbox.js do, since those ARE hard requirements for the whole script),
// a missing/misconfigured CELIGO_API_TOKEN would crash the entire run before any of the other,
// already-working features even got a chance to execute. Since finishRun() already wraps this
// call in its own try/catch (log + Slack alert only, per Shelly's call), the failure needs to
// surface there, not at import time.
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function runCeligoFlow(flowId) {
  const apiToken = requireEnv('CELIGO_API_TOKEN');
  const res = await fetch(`${API_BASE}/v1/flows/${flowId}/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Celigo flow run failed for flow ${flowId} (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

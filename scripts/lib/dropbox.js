// Minimal Dropbox client. No external dependencies - uses Node's built-in fetch.
//
// Modern Dropbox apps don't support permanent access tokens - this exchanges the long-lived
// refresh token (generated once via a manual OAuth authorize-code flow, see docs/spec.md) for
// a short-lived access token on demand, then uploads files via the Content API.

const APP_KEY = requireEnv('DROPBOX_APP_KEY');
const APP_SECRET = requireEnv('DROPBOX_APP_SECRET');
const REFRESH_TOKEN = requireEnv('DROPBOX_REFRESH_TOKEN');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Cached for the lifetime of this process (each GitHub Actions run is a fresh process, so this
// just avoids redundant refreshes within a single run that exports multiple styles' images).
let cachedAccessToken = null;

async function getAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Dropbox token refresh failed: ${JSON.stringify(data)}`);
  }
  cachedAccessToken = data.access_token;
  return cachedAccessToken;
}

// Uploads in "overwrite" mode - a file already at this exact path/name gets replaced in place,
// rather than Dropbox auto-renaming the new upload into a "(1)" duplicate. Per Shelly's
// requirement, binary content/type/size must pass through completely untouched - only the
// destination filename differs from the source (renaming happens by the caller, not here).
export async function uploadFile(dropboxPath, buffer) {
  const accessToken = await getAccessToken();

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    body: buffer,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Dropbox upload failed for "${dropboxPath}" (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

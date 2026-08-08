// Minimal NetSuite REST client using Token-Based Authentication (OAuth 1.0a, HMAC-SHA256).
// No external dependencies - uses Node's built-in crypto and fetch.

import crypto from 'node:crypto';

const ACCOUNT_ID = requireEnv('NETSUITE_ACCOUNT_ID');
const CONSUMER_KEY = requireEnv('NETSUITE_CONSUMER_KEY');
const CONSUMER_SECRET = requireEnv('NETSUITE_CONSUMER_SECRET');
const TOKEN_ID = requireEnv('NETSUITE_TOKEN_ID');
const TOKEN_SECRET = requireEnv('NETSUITE_TOKEN_SECRET');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// NetSuite's REST domain uses the account id lowercased with underscores turned into dashes
// (e.g. account "1234567_SB1" -> domain "1234567-sb1.suitetalk.api.netsuite.com").
const DOMAIN_ACCOUNT = ACCOUNT_ID.toLowerCase().replace(/_/g, '-');
const BASE_URL = `https://${DOMAIN_ACCOUNT}.suitetalk.api.netsuite.com`;

// The OAuth "realm" NetSuite expects is the account id uppercased with dashes turned into underscores.
const REALM = ACCOUNT_ID.toUpperCase().replace(/-/g, '_');

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildAuthHeader(method, urlString) {
  const oauthParams = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_token: TOKEN_ID,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  const urlObj = new URL(urlString);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

  const queryParams = {};
  urlObj.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });

  const allParams = { ...oauthParams, ...queryParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(CONSUMER_SECRET)}&${percentEncode(TOKEN_SECRET)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const headerString = Object.keys(headerParams)
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(', ');

  return `OAuth realm="${REALM}", ${headerString}`;
}

async function netsuiteFetch(method, path, { query, body, headers } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }

  const authHeader = buildAuthHeader(method, url.toString());

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`NetSuite ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Runs a SuiteQL query, paginating through all results.
export async function runSuiteQL(sql) {
  const allRows = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const data = await netsuiteFetch('POST', '/services/rest/query/v1/suiteql', {
      query: { limit, offset },
      body: { q: sql },
      // NetSuite requires this header on SuiteQL query requests.
      headers: { Prefer: 'transient' },
    });
    allRows.push(...(data.items || []));
    if (!data.hasMore) break;
    offset += limit;
  }

  return allRows;
}

// Fetches specific fields off a single record via the REST record API
// (used for fields that error out via SuiteQL - salesrep, employee custom fields - but read fine per-record).
export async function getRecord(recordType, id, fields) {
  return netsuiteFetch('GET', `/services/rest/record/v1/${recordType}/${id}`, {
    query: { fields: fields.join(',') },
  });
}

// Fetches a sales order's item sublist for the Sales Ops L10 "close items" CSV feature.
// `isClosed` and a globally-unique per-line key both error out via bulk SuiteQL in this account
// (see run.js/docs/spec.md for the "closed"/"line" SuiteQL quirks), but come through fine on the
// record's expanded item sublist. Confirmed live against a real order (MSO-4061, 2026-08-08):
// GET /record/v1/salesorder/{id}?expandSubResources=true returns `item.items[]`, each with
// `item.id` (the item's internal id), `line` (the simple 1/2/3 sequence), `lineUniqueKey` (the
// globally-unique key Shelly confirmed is what "Line ID" means for this CSV), and `isClosed`.
export async function getSalesOrderLines(soInternalId) {
  const data = await netsuiteFetch('GET', `/services/rest/record/v1/salesorder/${soInternalId}`, {
    query: { expandSubResources: true },
  });
  return (data.item?.items || []).map((line) => ({
    itemId: line.item?.id,
    line: line.line,
    lineUniqueKey: line.lineUniqueKey,
    isClosed: line.isClosed === true,
  }));
}

// Minimal monday.com GraphQL client. No external dependencies - uses Node's built-in fetch.

const MONDAY_TOKEN = requireEnv('MONDAY_API_TOKEN');
const API_URL = 'https://api.monday.com/v2';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function mondayGraphQL(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: MONDAY_TOKEN,
      'Content-Type': 'application/json',
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

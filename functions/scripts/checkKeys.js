/*
 Simple local check for API keys.
 - Loads .env.local if present, else .env
 - Prints presence of GOOGLE_API_KEY and ANTHROPIC_API_KEY
 - Optionally pings Gemini and Anthropic endpoints if keys exist
 Usage:
   node scripts/checkKeys.js
*/

const fs = require('fs');
const path = require('path');
const https = require('https');

function loadEnv() {
  const envLocalPath = path.resolve(__dirname, '..', '.env.local');
  const envPath = path.resolve(__dirname, '..', '.env');
  const dotenv = require('dotenv');
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath });
    console.log(`Loaded .env.local`);
  } else if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`Loaded .env`);
  } else {
    console.log('No .env.local or .env found under functions/.');
  }
}

function logPresence() {
  const google = process.env.GOOGLE_API_KEY ? 'present' : 'missing';
  const anthropic = process.env.ANTHROPIC_API_KEY ? 'present' : 'missing';
  console.log('Key presence:', { GOOGLE_API_KEY: google, ANTHROPIC_API_KEY: anthropic });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + (u.search || ''),
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function pingGemini() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, reason: 'GOOGLE_API_KEY missing' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${key}`;
  try {
    const res = await httpPost(url, { contents: [{ parts: [{ text: 'ping' }] }] });
    const ok = res.status === 200;
    return { ok, status: res.status, sample: ok ? 'candidates returned' : res.body.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function pingAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'ANTHROPIC_API_KEY missing' };
  const url = `https://api.anthropic.com/v1/messages`;
  try {
    const res = await httpPost(
      url,
      {
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      },
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    );
    const ok = res.status === 200;
    return { ok, status: res.status, sample: ok ? 'message returned' : res.body.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

(async function main() {
  loadEnv();
  logPresence();
  const results = {};
  results.gemini = await pingGemini();
  results.anthropic = await pingAnthropic();
  console.log('Ping results:', results);
})();

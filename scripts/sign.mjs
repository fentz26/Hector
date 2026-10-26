#!/usr/bin/env node
// Signs the Firefox build with Mozilla as an unlisted (private) add-on, so it
// installs permanently in Firefox, Zen and other Firefox-based browsers.
//   AMO_JWT_ISSUER=user:… AMO_JWT_SECRET=… node scripts/sign.mjs
// Keys: addons.mozilla.org → Developer Hub → Manage API Keys. They are read
// from the environment only and never written anywhere. Run
// `node scripts/build.mjs` first (or use scripts/release.mjs); each signed
// version must be new. Writes dist/hector-v26.01-signed.xpi.
// No dependencies: Node's fetch, FormData and crypto.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://addons.mozilla.org/api/v5';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const [year, n = '0'] = version.split('.');
const label = `v${year}.${n.padStart(2, '0')}`;
const GUID = 'hector@fentz26.github.io';
const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!issuer || !secret) {
  console.error('Set AMO_JWT_ISSUER and AMO_JWT_SECRET (addons.mozilla.org → Developer Hub → Manage API Keys).');
  process.exit(1);
}

// A fresh short-lived token per request, as AMO asks.
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

async function amo(path, { method = 'GET', json, form, raw = false } = {}) {
  const headers = { Authorization: `JWT ${jwt()}` };
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, { method, headers, body });
  if (raw) {
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const out = join(root, 'dist', `hector-${label}-signed.xpi`);
const versionPath = `/addons/addon/${encodeURIComponent(GUID)}/versions/v${version}/`;

// Already uploaded (an earlier run stopped before downloading): fetch it.
async function existing() {
  try {
    return await amo(versionPath);
  } catch (err) {
    if ([401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

async function finish(ver) {
  console.log('Waiting for Mozilla to sign it (usually a few minutes)…');
  for (let i = 0; ver?.file?.status !== 'public'; i++) {
    if (ver?.file?.status === 'disabled') throw new Error('Mozilla did not sign this version (disabled). Check the Developer Hub.');
    if (i > 120) throw new Error('Signing is taking long. Run this again later to fetch the signed file.');
    await wait(5000);
    ver = await amo(versionPath);
  }
  writeFileSync(out, await amo(ver.file.url, { raw: true }));
  console.log(`Signed: ${out}`);
  console.log('Install it from about:addons → gear → Install Add-on From File…');
}

const already = await existing();
if (already) {
  console.log(`${label} is already on addons.mozilla.org; fetching the signed file.`);
  await finish(already);
  process.exit(0);
}

const zip = join(root, 'dist', `hector-firefox-${label}.zip`);
console.log(`Uploading ${zip} (${label}, unlisted)…`);
const form = new FormData();
form.append('upload', new Blob([readFileSync(zip)]), `hector-firefox-${label}.zip`);
form.append('channel', 'unlisted');
let upload = await amo('/addons/upload/', { method: 'POST', form });

for (let i = 0; !upload.processed; i++) {
  if (i > 60) throw new Error('Validation is taking too long; try again later.');
  await wait(3000);
  upload = await amo(`/addons/upload/${upload.uuid}/`);
}
if (!upload.valid) {
  const msgs = upload.validation?.messages?.filter((m) => m.type === 'error').map((m) => `- ${m.message}`) || [];
  throw new Error(`Mozilla's validator rejected the build:\n${msgs.join('\n')}`);
}
console.log('Validated. Creating the version…');

// The first time creates the (unlisted) add-on; later, a new version of it.
let created;
try {
  await amo(`/addons/addon/${encodeURIComponent(GUID)}/`);
  created = await amo(`/addons/addon/${encodeURIComponent(GUID)}/versions/`, { method: 'POST', json: { upload: upload.uuid } });
} catch (err) {
  if (err.status !== 404 && err.status !== 401 && err.status !== 403) throw err;
  const addon = await amo(`/addons/addon/${encodeURIComponent(GUID)}/`, { method: 'PUT', json: { version: { upload: upload.uuid } } });
  created = addon.latest_unlisted_version || addon.version;
}

await finish(created);

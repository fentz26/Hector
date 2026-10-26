#!/usr/bin/env node
// Makes a new release: bumps the version, builds, and signs the Firefox build.
//   AMO_JWT_ISSUER=user:… AMO_JWT_SECRET=… node scripts/release.mjs
//   … node scripts/release.mjs --keep     (release the current version as is)
// Versions are year.release: v26.01, v26.02, …; the first release in a new
// year starts again at .01 (v27.01). The manifest stores them without the
// padding ("26.2"), which is all browsers accept. Without the API keys it
// bumps and builds only.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'manifest.json');
const text = readFileSync(file, 'utf8');
const { version } = JSON.parse(text);
const label = (v) => {
  const [y, n = '0'] = v.split('.');
  return `v${y}.${n.padStart(2, '0')}`;
};

let next = version;
if (!process.argv.includes('--keep')) {
  const year = new Date().getFullYear() % 100;
  const [y, n = '0'] = version.split('.').map(Number);
  next = y === year ? `${year}.${n + 1}` : `${year}.1`;
  // Only the version line changes; the rest of the file stays as written.
  writeFileSync(file, text.replace(`"version": "${version}"`, `"version": "${next}"`));
  console.log(`${label(version)} → ${label(next)}`);
} else {
  console.log(`Releasing ${label(next)}`);
}

const run = (script) => execFileSync(process.execPath, [join(root, 'scripts', script)], { stdio: 'inherit', env: process.env });
run('build.mjs');
if (process.env.AMO_JWT_ISSUER && process.env.AMO_JWT_SECRET) run('sign.mjs');
else console.log('Built. Set AMO_JWT_ISSUER and AMO_JWT_SECRET to sign it too.');

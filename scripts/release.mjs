#!/usr/bin/env node
// Makes and ships a release: bumps the version, builds, signs the Firefox
// build with Mozilla, publishes it as a GitHub release, and adds it to
// updates.json, from which every installed Hector updates itself.
//   AMO_JWT_ISSUER=user:… AMO_JWT_SECRET=… node scripts/release.mjs
//   … node scripts/release.mjs --keep        release the current version as is
//   … node scripts/release.mjs --no-publish  stop after signing
// Versions are year.release: v26.01, v26.02, …; the first release in a new
// year starts again at .01 (v27.01). The manifest stores them without the
// padding ("26.2"), which is all browsers accept. Without the API keys it
// bumps and builds only. Publishing uses the GitHub CLI (gh), from main.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'fentz26/Hector';
const GUID = 'hector@fentz26.github.io';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'manifest.json');
const args = process.argv.slice(2);
const sh = (cmd, list, opts = {}) => execFileSync(cmd, list, { cwd: root, encoding: 'utf8', ...opts }).trim();
const label = (v) => {
  const [y, n = '0'] = v.split('.');
  return `v${y}.${n.padStart(2, '0')}`;
};

const signing = Boolean(process.env.AMO_JWT_ISSUER && process.env.AMO_JWT_SECRET);
const publish = signing && !args.includes('--no-publish');
if (publish) {
  // Publish from a clean, up-to-date main, so the release is what's pushed.
  if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') throw new Error('Release from the main branch (git checkout main).');
  if (sh('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit or stash your changes first.');
  sh('git', ['pull', '--ff-only', '--quiet']);
  sh('git', ['fetch', '--tags', '--quiet']);
}

const text = readFileSync(file, 'utf8');
const { version } = JSON.parse(text);
let next = version;
if (!args.includes('--keep')) {
  const year = new Date().getFullYear() % 100;
  const [y, n = '0'] = version.split('.').map(Number);
  next = y === year ? `${year}.${n + 1}` : `${year}.1`;
  // Only the version line changes; the rest of the file stays as written.
  writeFileSync(file, text.replace(`"version": "${version}"`, `"version": "${next}"`));
  console.log(`${label(version)} → ${label(next)}`);
} else {
  console.log(`Releasing ${label(next)}`);
}
const tag = label(next);

const run = (script) => execFileSync(process.execPath, [join(root, 'scripts', script)], { stdio: 'inherit', env: process.env });
run('build.mjs');
if (!signing) {
  console.log('Built. Set AMO_JWT_ISSUER and AMO_JWT_SECRET to sign and publish it.');
  process.exit(0);
}
run('sign.mjs');
if (!publish) process.exit(0);

const xpi = join(root, 'dist', `hector-${tag}-signed.xpi`);
const chromeZip = join(root, 'dist', `hector-chrome-${tag}.zip`);
if (!existsSync(xpi)) throw new Error(`${xpi} is missing.`);

// 1. The version bump, so the release's tag points at it.
if (sh('git', ['status', '--porcelain', 'manifest.json'])) {
  sh('git', ['commit', '--quiet', '-m', `Release ${tag}`, 'manifest.json']);
  sh('git', ['push', '--quiet', 'origin', 'main']);
}

// 2. The GitHub release, with what changed since the last one.
const previous = sh('git', ['tag', '--list', 'v*', '--sort=-v:refname']).split('\n').filter((t) => t && t !== tag)[0];
const log = sh('git', ['log', '--no-merges', '--format=- %s', previous ? `${previous}..HEAD` : 'HEAD', '--', '.', ':!updates.json'])
  .split('\n')
  .filter((l) => l && !/^- Release v/.test(l) && !/^- updates\.json/.test(l))
  .slice(0, 60)
  .join('\n');
const notes = `${previous ? `Changes since ${previous}:` : 'First release.'}\n\n${log}\n\n**Firefox / Zen:** open \`hector-${tag}-signed.xpi\` below to install. Installed copies update by themselves.\n**Chrome / Edge:** unzip \`hector-chrome-${tag}.zip\` and load it unpacked (chrome://extensions → Developer mode).`;
sh('gh', ['release', 'create', tag, xpi, chromeZip, '--repo', REPO, '--title', `Hector ${tag}`, '--notes', notes, '--target', 'main']);
console.log(`Published https://github.com/${REPO}/releases/tag/${tag}`);

// 3. updates.json: Firefox installs the newest version listed.
const updatesFile = join(root, 'updates.json');
const updates = existsSync(updatesFile) ? JSON.parse(readFileSync(updatesFile, 'utf8')) : { addons: {} };
const entry = (updates.addons[GUID] ||= { updates: [] });
entry.updates = [
  {
    version: next,
    update_link: `https://github.com/${REPO}/releases/download/${tag}/hector-${tag}-signed.xpi`,
    update_hash: `sha256:${createHash('sha256').update(readFileSync(xpi)).digest('hex')}`,
  },
  ...entry.updates.filter((u) => u.version !== next),
].slice(0, 20);
writeFileSync(updatesFile, `${JSON.stringify(updates, null, 2)}\n`);
sh('git', ['add', 'updates.json']);
sh('git', ['commit', '--quiet', '-m', `updates.json: ${tag}`]);
sh('git', ['push', '--quiet', 'origin', 'main']);
console.log(`updates.json lists ${tag}. Installed copies will update within a day.`);

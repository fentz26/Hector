#!/usr/bin/env node
// Packages the extension for Chrome and Firefox into dist/.
//   node scripts/build.mjs
// Produces dist/hectatree-chrome-<version>.zip and dist/hectatree-firefox-<version>.zip
// (zipping uses the system `zip` command).
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const FILES = ['src', 'icons', 'LICENSE'];

rmSync(dist, { recursive: true, force: true });

function stage(target, transform) {
  const dir = join(dist, target);
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) cpSync(join(root, f), join(dir, f), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(transform(structuredClone(manifest)), null, 2)}\n`);
  const zip = join(dist, `hectatree-${target}-${manifest.version}.zip`);
  execFileSync('zip', ['-qr', zip, '.', '-x', '*/._*', '._*', '*.DS_Store'], { cwd: dir });
  console.log(zip);
  if (target === 'firefox') {
    copyFileSync(zip, join(dist, `hectatree-${manifest.version}.xpi`));
  }
}

stage('chrome', (m) => m);

stage('firefox', (m) => {
  m.background = { scripts: [m.background.service_worker] };
  m.browser_specific_settings = { gecko: { id: 'hectatree@fentz26.github.io', strict_min_version: '128.0' } };
  return m;
});

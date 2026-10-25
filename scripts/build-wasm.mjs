#!/usr/bin/env node
// Rebuilds src/wasm/hector_core.wasm from wasm/ (needs Rust with the
// wasm32-unknown-unknown target). The built file is committed, so a normal
// `node scripts/build.mjs` does not need Rust.
//   node scripts/build-wasm.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'wasm'); // run from here so wasm/rust-toolchain.toml (Rust 1.99.1) applies
const manifest = join(crate, 'Cargo.toml');
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: crate, stdio: 'inherit' });
// The target directory may be redirected (CARGO_TARGET_DIR, .cargo/config).
const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: crate, encoding: 'utf8' }));
const built = join(meta.target_directory, 'wasm32-unknown-unknown', 'release', 'hector_core.wasm');
mkdirSync(join(root, 'src', 'wasm'), { recursive: true });
copyFileSync(built, join(root, 'src', 'wasm', 'hector_core.wasm'));
console.log(`src/wasm/hector_core.wasm <- ${built}`);

// Uses DBX's official packager; only the manifest and single HTML asset enter the archive.
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const dbx = path.resolve(root, '../..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const stage = path.join(root, '.dbx-dev/stage');
const output = path.join(root, 'dist', `${manifest.id}-${manifest.version}-universal`);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(path.dirname(output), { recursive: true });
await cp(path.join(root, 'manifest.json'), path.join(stage, 'manifest.json'));
await cp(path.join(root, 'ui'), path.join(stage, 'ui'), { recursive: true });
const result = spawnSync(process.env.CARGO || 'cargo', [
  'run', '--locked', '--manifest-path', path.join(dbx, 'plugins/sdk/packager/Cargo.toml'), '--',
  stage, output + '.dbxp', '--artifact-metadata', output + '.artifact.json', '--target', 'universal',
], { cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: path.join(root, '.dbx-dev/cargo-target') } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

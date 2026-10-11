import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runTsc } from './tsc-runner.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
const code = await runTsc(projectRoot, 'tsconfig.portable.json');
if (code !== 0) process.exit(code);
await import('./copy-static.mjs');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const worldgenManifest = JSON.parse(await readFile(path.join(projectRoot, 'public', 'worldgen', 'runtime-manifest.json'), 'utf8'));
const buildMeta = {
  product: 'descendants-generated-world',
  version: packageJson.version,
  reproducible: true,
  worldgen: worldgenManifest,
};
await mkdir(path.join(projectRoot, 'dist'), { recursive: true });
await writeFile(path.join(projectRoot, 'dist', 'build-meta.json'), `${JSON.stringify(buildMeta, null, 2)}\n`, 'utf8');
console.log(`Portable generated-world build ${packageJson.version}.`);

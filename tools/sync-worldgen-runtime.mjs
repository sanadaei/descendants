import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = path.join(projectRoot, 'vendor', 'worldgen-engine');
const executionRoot = path.join(projectRoot, 'vendor', 'i2x-worldgen-runtime');
const publicRoot = path.join(projectRoot, 'public', 'worldgen');
const distRoot = path.join(executionRoot, 'dist');
const settingRoot = path.join(executionRoot, 'setting-packs', 'descendants');
const sourcePackage = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
const sourceRecipe = JSON.parse(await readFile(path.join(sourceRoot, 'setting-packs', 'descendants', 'default.recipe.json'), 'utf8'));
const executionManifest = JSON.parse(await readFile(path.join(executionRoot, 'runtime-manifest.json'), 'utf8'));

if (sourcePackage.name !== '@descendants/worldgen-engine' || sourcePackage.version !== '1.5.0') {
  throw new Error(`Unsupported Worldgen source authority: ${sourcePackage.name}@${sourcePackage.version}`);
}
if (executionManifest.engineName !== sourcePackage.name || executionManifest.engineVersion !== sourcePackage.version) {
  throw new Error('I2X execution runtime identity disagrees with Worldgen 1.5 source authority.');
}
if (executionManifest.recipeId !== sourceRecipe.id || executionManifest.recipeSeed !== sourceRecipe.seed || executionManifest.ticksPerDay !== sourceRecipe.clock?.ticksPerDay) {
  throw new Error('I2X execution runtime recipe identity disagrees with Worldgen 1.5 source authority.');
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

for (const required of [path.join(distRoot, 'index.js'), path.join(settingRoot, 'default.recipe.json')]) {
  const info = await stat(required).catch(() => null);
  if (!info?.isFile()) throw new Error(`I2X Worldgen execution asset missing: ${required}`);
}

const files = (await walk(executionRoot)).filter((file) => !file.endsWith('runtime-manifest.json')).sort();
const digest = createHash('sha256');
for (const file of files) {
  digest.update(path.relative(executionRoot, file).replaceAll(path.sep, '/'));
  digest.update(await readFile(file));
}
const runtimeSha256 = digest.digest('hex');
if (runtimeSha256 !== executionManifest.runtimeSha256) {
  throw new Error(`I2X Worldgen execution runtime hash drift: ${runtimeSha256} != ${executionManifest.runtimeSha256}`);
}

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });
await cp(distRoot, path.join(publicRoot, 'dist'), { recursive: true, force: true });
await cp(settingRoot, path.join(publicRoot, 'setting-packs', 'descendants'), { recursive: true, force: true });
await writeFile(path.join(publicRoot, 'runtime-manifest.json'), `${JSON.stringify(executionManifest, null, 2)}\n`, 'utf8');
console.log(`Synced I2X execution runtime ${executionManifest.engineVersion} / ${executionManifest.recipeId} / ${executionManifest.runtimeSha256}`);

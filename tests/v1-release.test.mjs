import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('1.0.0 promotes the provider-backed sandbox with generated-world release contracts', async () => {
  const version = (await read('VERSION')).trim();
  const pkg = JSON.parse(await read('package.json'));
  const contract = JSON.parse(await read('VERSION_CONTRACT.json'));
  const worldgen = JSON.parse(await read('public/worldgen/runtime-manifest.json'));
  assert.equal(version, '1.0.0');
  assert.equal(pkg.version, version);
  assert.equal(contract.appVersion, version);
  assert.equal(worldgen.engineVersion, '1.5.0');
  assert.equal(worldgen.recipeId, 'descendants-sandbox-default');
  assert.match(worldgen.runtimeSha256, /^[0-9a-f]{64}$/);
});

test('1.0.0 production bootstrap selects real Worldgen by default without gameplay forks', async () => {
  const main = await read('src/main.ts');
  const realProvider = await read('src/worldbridge/realWorldProvider.ts');
  assert.match(main, /createRealWorldRuntime/);
  assert.match(main, /params\.get\('mockWorld'\) === '1'/);
  assert.match(main, /await createRealWorldRuntime/);
  assert.match(realProvider, /WorldProvider/);
  assert.doesNotMatch(realProvider, /from ['"].*worldgen-engine\/src/);

  const sandboxFiles = (await readdir(path.join(root, 'src', 'sandbox'))).filter((name) => name.endsWith('.ts'));
  for (const name of sandboxFiles) {
    const source = await read(path.join('src', 'sandbox', name));
    assert.doesNotMatch(source, /worldgen-engine\//, `sandbox gameplay must not import Worldgen implementation: ${name}`);
  }
});

test('1.0.0 production UI keeps direct-play contracts inside the Descendants terminal shell without the obsolete expedition-management home screen', async () => {
  const app = await read('src/sandbox/app.ts');
  for (const action of ['launch','rescue','research','a11y-scale','a11y-contrast','a11y-motion','export','import']) {
    assert.match(app, new RegExp(`data-action=[\"']${action}[\"']`), `missing UI action ${action}`);
  }
  for (const label of ['Exploration','Body / Equipment','Knowledge','Inventory','Chronicle']) assert.match(app, new RegExp(label.replace('/', '\\/')));
  for (const key of ['F1','F2','F3','F4','F5']) assert.match(app, new RegExp(key));
  assert.doesNotMatch(app, /type ViewId = .*expeditions/);
  assert.match(app, /desc-pda-hardware/);
  assert.match(app, /DESCENDANTS FIELD TERMINAL/);
  assert.match(app, /type PdaTab = .*'residents'.*'system'/);
  assert.match(app, /REMOTE \/ CURRENT STATUS UNKNOWN/);
  assert.match(app, /projectChronicle\(this\.state, this\.chronicleViewpoint\(\)\)/);
  assert.match(app, /avoid','withdraw','defend','advance','protect-wounded','capture','break-contact/);
  assert.match(app, /Skip to main content/);
  assert.match(app, /prefers-reduced-motion/);
});

test('1.0.0 production tree has no Content Studio or fixed Legacy ADV startup route', async () => {
  const main = await read('src/main.ts');
  const readme = await read('README.md');
  const versioning = await read('docs/VERSIONING.md');
  const architecture = await read('docs/ARCHITECTURE.md');
  assert.match(readme, /The Descendants of Criminals 1\.0\.0/);
  assert.doesNotMatch(main, /params\.get\('legacy'\)|params\.get\('lineage'\)/);
  assert.doesNotMatch(main, /GameApp|loadRuntimeContent|debugScene|studio/i);
  assert.match(readme, /Content Studio.*removed/i);
  assert.match(versioning, /製品版は \*\*1\.0\.0\*\*/);
  assert.match(architecture, /Active product runtime/);
  for (const rel of ['public/studio.html','public/studio.js','public/studio.css','public/studio','release/authoring-studio','tools/package-studio-app.mjs','src/studio-runtime.ts','src/content','src/core','src/ui','src/persistence','src/lineage','content','public/content','public/golden','resources']) {
    await assert.rejects(access(path.join(root, rel)), undefined, `legacy Studio artifact must be absent: ${rel}`);
  }
  await access(path.join(root, 'docs', 'IMPLEMENTATION_REPORT_1.0.0.md'));
  await access(path.join(root, 'docs', 'HUMAN_QA_CHECKLIST_1.0.0.md'));
});


test('desktop launch contract rebuilds the portable UI and exposes only Run_desktop.bat', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts.desktop, 'npm run build:portable && electron .');

  const launcher = await read('Run_desktop.bat');
  assert.match(launcher, /npm ci --no-audit --no-fund/i);
  assert.match(launcher, /npm run desktop/i);
  assert.match(launcher, /node_modules\\electron\\dist\\electron\.exe/i);

  const rootEntries = await readdir(root);
  assert.deepEqual(rootEntries.filter((name) => name.toLowerCase().endsWith('.bat')).sort(), ['Run_desktop.bat']);
});

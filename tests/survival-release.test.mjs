import { readSandboxUiSource } from '../tools/read-sandbox-ui.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('survival release is self-contained around the original Worldgen 1.5 authority', async () => {
  const sync = await read('tools/sync-worldgen-runtime.mjs');
  assert.match(sync, /vendor['"],\s*['"]worldgen-engine/);
  assert.match(sync, /vendor['"],\s*['"]i2x-worldgen-runtime/);
  assert.doesNotMatch(sync, /path\.resolve\(projectRoot, ['"]\.\.['"], ['"]worldgen-engine['"]\)/);
  const pkg = JSON.parse(await read('vendor/worldgen-engine/package.json'));
  assert.equal(pkg.name, '@descendants/worldgen-engine');
  assert.equal(pkg.version, '1.5.0');
  await access(new URL('vendor/worldgen-engine/dist/index.js', root));
  await access(new URL('vendor/worldgen-engine/setting-packs/descendants/default.recipe.json', root));
  const runtime = JSON.parse(await read('vendor/i2x-worldgen-runtime/runtime-manifest.json'));
  assert.match(runtime.runtimeSha256, /^[0-9a-f]{64}$/);
  assert.equal(runtime.buildSource, 'vendor/worldgen-engine/src');
});

test('survival release identifies the open-ended generations game and contains no Inquiry product route', async () => {
  const readFirst = await read('SURVIVAL_GENERATIONS_READ_FIRST.md');
  assert.doesNotMatch(readFirst, /30年/);
  assert.match(readFirst, /勝敗[^\n]*ありません|勝利条件[^\n]*ありません|敗北条件[^\n]*ありません/i);
  assert.match(readFirst, /1日|日々/);
  assert.doesNotMatch(readFirst, /\+7日|\+30日/);
  assert.match(readFirst, /F1/);
  assert.match(readFirst, /世代/);
  assert.match(readFirst, /推理[^\n]*Inquiry[^\n]*使いません/i);
  const app = await readSandboxUiSource();
  assert.doesNotMatch(app, /Inquiry|INQUIRY|inquiry/);
});

test('Pass22 remains archived provenance and is not imported by production source', async () => {
  await access(new URL('provenance/pass22-original/FOUR_INSTANCE_STATE_PASS22.json', root));
  const campaign = await read('src/sandbox/survivalCampaign.ts');
  const app = await readSandboxUiSource();
  assert.doesNotMatch(`${campaign}\n${app}`, /pass22-original|FOUR_INSTANCE_STATE_PASS22/);
});


test('release records the exact three original source ZIP digests', async () => {
  const origins = await read('provenance/ORIGIN_ASSETS.md');
  assert.match(origins, /a80088dabc9c51bffb7c1fde8309e9a0500820849f7151b9b8a6790c0ab11cb6/);
  assert.match(origins, /0f654ed4d0d34e083ae52c2704ac3662c51b17b092bf77cd8e77f6c9c4f4fb14/);
  assert.match(origins, /e0ca618517046230e78b1f92faaafde37f916dbed9025c981f96767f27d6810c/);
});


test('reference ledger gate scopes the local ZONE_PDA design source outside numbered references', () => {
  const run = spawnSync(process.execPath, ['tools/check-references.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Research reference gate: PASS/);
});

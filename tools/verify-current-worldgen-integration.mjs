import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  ContentPackRegistry,
  WorldgenEngine,
  parseWorldRecipe,
  snapshotDigest,
  validateSnapshotConformance,
} from '../vendor/worldgen-engine/dist/index.js';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { advanceSandboxDays } from '../.test-dist/sandbox/engine.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { assertSnapshotIdentity } from '../.test-dist/worldbridge/providerGuard.js';
import { createRealWorldRuntime } from '../.test-dist/worldbridge/realWorldProvider.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const worldgenRoot = path.join(projectRoot, 'vendor', 'worldgen-engine');
const sharedRoot = path.join(projectRoot, 'provenance', 'worldgen-1.5', 'shared-contract');
const recipePath = path.join(worldgenRoot, 'setting-packs', 'descendants', 'default.recipe.json');
const packRoot = path.join(worldgenRoot, 'setting-packs', 'descendants', 'content-packs');
const worldgenPackage = JSON.parse(fs.readFileSync(path.join(worldgenRoot, 'package.json'), 'utf8'));
const rawRecipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
const recipe = parseWorldRecipe(JSON.stringify(rawRecipe));
const content = new ContentPackRegistry();
for (const ref of rawRecipe.contentPacks ?? []) {
  content.register(JSON.parse(fs.readFileSync(path.join(packRoot, `${ref.id}.json`), 'utf8')));
}
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedContractHash = fs.readFileSync(path.join(sharedRoot, 'CONTRACT_SHA256'), 'utf8').trim();
const contractHashes = [
  sha(path.join(sharedRoot, 'src', 'world-contract.ts')),
  sha(path.join(worldgenRoot, 'src', 'contract.ts')),
  sha(path.join(projectRoot, 'src', 'worldbridge', 'contract.ts')),
];
assert.ok(contractHashes.every((hash) => hash === expectedContractHash), `frozen WorldProvider contract drift: ${contractHashes.join(', ')}`);
console.log(`merge-gate 1/5 contract hash: PASS ${expectedContractHash}`);

const engine = new WorldgenEngine(undefined, content);
const provider = await engine.generate(recipe);
const manifest = await provider.getManifest();
assert.equal(manifest.contractVersion, '1.0.0');
assert.equal(manifest.engineVersion, worldgenPackage.version);
assert.equal(manifest.recipeId, rawRecipe.id);
const generatedSnapshot = await provider.exportSnapshot();
assert.deepEqual(validateSnapshotConformance(generatedSnapshot), []);
console.log(`merge-gate 2/5 generated snapshot: PASS engine=${manifest.engineVersion}`);

const realState = await createInitialSandboxState(provider, {
  seed: 0x1500,
  clockPolicy: {
    worldTicksPerDay: rawRecipe.clock.ticksPerDay,
    activeRadiusKm: 25,
    activeDetailRank: 0,
    epochWorldTick: manifest.currentTick,
    epochGameMinute: 0,
  },
});
const originFine = await provider.queryArea({ center: structuredClone(realState.settlement.position), radiusKm: 2.5, requestedDetailRank: 0, observerId: realState.world.originEntityId, includeKnowledgeProjection: true });
const originCohortIds = new Set(originFine.entities.filter((entry) => entry.kind === 'population-cohort' && entry.components.settlementId === realState.world.originEntityId).map((entry) => entry.id));
const providerOriginIndividuals = originFine.entities.filter((entry) => entry.kind === 'individual' && originCohortIds.has(entry.components.cohortId)).map((entry) => entry.id).sort();
assert.ok(providerOriginIndividuals.length > 0);
assert.deepEqual(realState.agents.map((entry) => entry.id).sort(), providerOriginIndividuals);
assert.ok(realState.agents.every((entry) => entry.worldEntityId === entry.id && entry.identityAnchorId && (entry.worldProvenanceIds?.length ?? 0) > 0));
assert.equal(realState.world.providerEngineVersion, worldgenPackage.version);
const mockProvider = new MockWorldProvider();
const mockState = await createInitialSandboxState(mockProvider, { seed: 0x1500 });
await advanceSandboxDays(provider, realState, 1);
await advanceSandboxDays(mockProvider, mockState, 1);
assert.equal(realState.clock.day, 2);
assert.equal(mockState.clock.day, 2);
console.log('merge-gate 3/5 shared gameplay path mock+real: PASS');

const query = { center: structuredClone(realState.settlement.position), radiusKm: 2, requestedDetailRank: 0 };
const fineBefore = await provider.queryArea(query);
const anchorBefore = new Map(fineBefore.entities.filter((entity) => entity.kind === 'identity-anchor').map((entity) => [entity.id, entity]));
const idsBefore = fineBefore.entities
  .filter((entity) => entity.kind === 'individual' && entity.components.__lodMaterialized === true)
  .map((entity) => { const anchorId = entity.components.identityAnchorId; const anchor = typeof anchorId === 'string' ? anchorBefore.get(anchorId) : undefined; return [entity.id, anchorId, [...(anchor?.provenanceIds ?? [])].sort()]; })
  .sort((a, b) => a[0].localeCompare(b[0]));
assert.ok(idsBefore.length > 0);
const coarse = await provider.exportSnapshot(2);
assert.equal(coarse.entities.some((entity) => entity.components.__lodMaterialized === true), false);
const resumedLod = engine.fromSnapshot(recipe, structuredClone(coarse));
const fineAfter = await resumedLod.queryArea(query);
const anchorAfter = new Map(fineAfter.entities.filter((entity) => entity.kind === 'identity-anchor').map((entity) => [entity.id, entity]));
const idsAfter = fineAfter.entities
  .filter((entity) => entity.kind === 'individual' && entity.components.__lodMaterialized === true)
  .map((entity) => { const anchorId = entity.components.identityAnchorId; const anchor = typeof anchorId === 'string' ? anchorAfter.get(anchorId) : undefined; return [entity.id, anchorId, [...(anchor?.provenanceIds ?? [])].sort()]; })
  .sort((a, b) => a[0].localeCompare(b[0]));
assert.deepEqual(idsAfter, idsBefore);
assertSnapshotIdentity(coarse, await resumedLod.exportSnapshot(2));
const saveState = structuredClone(realState);
saveState.world.providerSnapshot = structuredClone(coarse);
const loaded = importSandboxSave(JSON.stringify(saveState));
assert.equal(loaded.world.providerSnapshot.manifest.currentTick, coarse.manifest.currentTick);
console.log('merge-gate 4/5 stable IDs/provenance save-load+LOD: PASS');

const manifestVariables = [...manifest.variableDefinitions.map((definition) => definition.id)].sort();
assert.deepEqual(realState.world.discoveredVariableIds, manifestVariables);
const sandboxSources = fs.readdirSync(path.join(projectRoot, 'src', 'sandbox')).filter((name) => name.endsWith('.ts'));
for (const name of sandboxSources) {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'sandbox', name), 'utf8');
  assert.doesNotMatch(source, /worldgen-engine\//, `gameplay imports Worldgen implementation: ${name}`);
}
console.log(`merge-gate 5/5 manifest-driven variables: PASS (${manifestVariables.length})`);
if (process.argv.includes('--merge-gates-only')) {
  console.log('CURRENT WORLDGEN INTEGRATION: ALL 5 MERGE GATES PASS');
  process.exit(0);
}

// Deterministic current-engine continuation from the exact same persisted world, without regenerating history.
const baseForReplay = structuredClone(coarse);
const pA = engine.fromSnapshot(recipe, structuredClone(baseForReplay));
const pB = engine.fromSnapshot(recipe, structuredClone(baseForReplay));
const stateA = importSandboxSave(JSON.stringify({ ...saveState, world: { ...saveState.world, providerSnapshot: structuredClone(baseForReplay) } }));
const stateB = importSandboxSave(JSON.stringify({ ...saveState, world: { ...saveState.world, providerSnapshot: structuredClone(baseForReplay) } }));
await advanceSandboxDays(pA, stateA, 30);
for (let i = 0; i < 30; i += 1) await advanceSandboxDays(pB, stateB, 1);
assert.equal(snapshotDigest(stateA.world.providerSnapshot), snapshotDigest(stateB.world.providerSnapshot));
assert.equal(stateA.diagnostics.replayHash, stateB.diagnostics.replayHash);
console.log(`deterministic 30-day replay: PASS ${snapshotDigest(stateA.world.providerSnapshot)}`);

async function withSettingPackServer(run) {
  const root = path.join(worldgenRoot, 'setting-packs', 'descendants');
  const server = http.createServer((request, response) => {
    try {
      const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
      const file = path.resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) return response.writeHead(403).end('forbidden');
      const body = fs.readFileSync(file);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind setting-pack fixture server');
    return await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
const runtimeUrl = pathToFileURL(path.join(worldgenRoot, 'dist', 'index.js')).href;
await withSettingPackServer(async (baseUrl) => {
  const runtime = await createRealWorldRuntime({
    runtimeUrl,
    recipeUrl: `${baseUrl}default.recipe.json`,
    snapshot: structuredClone(coarse),
  });
  const loadedManifest = await runtime.provider.getManifest();
  assert.equal(loadedManifest.engineVersion, worldgenPackage.version);
  assert.equal(loadedManifest.contractVersion, '1.0.0');
  assert.equal(runtime.recipeId, rawRecipe.id);
});
console.log('production runtime adapter from persisted snapshot: PASS');
console.log('CURRENT WORLDGEN INTEGRATION: ALL 5 MERGE GATES PASS');

import { readSandboxUiSource } from '../tools/read-sandbox-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { queryGeneratedWorldArea } from '../.test-dist/sandbox/localExploration.js';
import { addObservedKnowledge } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { buildLegacyKnowledgeShadow } from '../.test-dist/sandbox/knowledgeLegacyAdapter.js';
import { sandboxRepository } from '../.test-dist/sandbox/storage.js';
import { selectF3KnowledgeReadModel, isI1CF3ReadSwitchEnabled } from '../.test-dist/sandbox/knowledgeF3Projection.js';
import { selectWorldGraphReadModel, isI1DWorldReadSwitchEnabled } from '../.test-dist/sandbox/knowledgeGraphProjection.js';
import { providerVisibleRouteAlternatives } from '../.test-dist/sandbox/routePlanning.js';
import { assertImportedSaveProviderCompatible } from '../.test-dist/sandbox/worldMutationSafety.js';

async function fixture(seed = 0x1c0a501) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed, population: 14 });
  const holder = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(holder);
  return { provider, state, holder };
}

async function assertShadowReads(provider, state, holder) {
  const f3 = selectF3KnowledgeReadModel(state, holder.id, true);
  assert.equal(f3.source, 'shadow', JSON.stringify(f3.comparison.mismatches, null, 2));
  assert.equal(f3.comparison.equal, true);
  assert.equal(f3.renderIdentityEqual, true);

  const area = await queryGeneratedWorldArea(provider, state, holder.id, state.settlement.position);
  const world = selectWorldGraphReadModel(state, holder.id, area, true);
  assert.equal(world.source, 'shadow', JSON.stringify(world.comparison.mismatches, null, 2));
  assert.equal(world.comparison.equal, true);
  assert.equal(world.entityIdentityEqual, true);

  const targetId = world.graph.targetableEntityIds[0];
  assert.ok(targetId, 'consolidation fixture must expose at least one knowledge-bounded expedition target');
  const target = world.entities.find((entry) => entry.id === targetId);
  assert.ok(target?.spatial, 'target action ID must resolve to the exact provider entity used by WORLD read');
  const routes = providerVisibleRouteAlternatives(area, world.entities, state.world.originEntityId, targetId, 3);
  assert.ok(Array.isArray(routes));
  return { f3, world, target, routes };
}

test('I1 consolidation keeps F3/WORLD V2 read switches default OFF', () => {
  assert.equal(isI1CF3ReadSwitchEnabled(), false);
  assert.equal(isI1DWorldReadSwitchEnabled(), false);
});

test('I1 consolidation shares the exact F10 provider-compatibility rule with a pure helper', async () => {
  const { provider, state } = await fixture();
  const manifest = await provider.getManifest();
  assert.doesNotThrow(() => assertImportedSaveProviderCompatible(state, manifest));
  assert.throws(() => assertImportedSaveProviderCompatible(state, { ...manifest, recipeId: `${manifest.recipeId}:other` }), /Save WorldProvider identity does not match/);
  assert.throws(() => assertImportedSaveProviderCompatible(state, { ...manifest, contractVersion: '9.9.9' }), /Save WorldProvider identity does not match/);
});

test('I1 consolidation F10-equivalent export/import preserves persisted knowledge and knowledge-bounded target identity', async () => {
  const { provider, state, holder } = await fixture(0x1c0a502);
  const before = await assertShadowReads(provider, state, holder);
  const exported = sandboxRepository.exportJson(state);
  assert.match(exported, /"knowledgeStore"\s*:/);
  const restored = sandboxRepository.importJson(exported);
  assertImportedSaveProviderCompatible(restored, await provider.getManifest());
  assert.ok(restored.knowledgeStore);
  const after = await assertShadowReads(provider, restored, restored.agents.find((agent) => agent.id === holder.id));
  assert.equal(after.target.id, before.target.id);
  assert.deepEqual(after.world.graph.targetableEntityIds, before.world.graph.targetableEntityIds);
});

test('I1 consolidation migrates a legacy schemaVersion=1 export without sidecar and then emits persisted sidecar', async () => {
  const { provider, state, holder } = await fixture(0x1c0a503);
  const legacy = structuredClone(state);
  delete legacy.knowledgeStore;
  const restored = sandboxRepository.importJson(JSON.stringify(legacy));
  assert.ok(restored.knowledgeStore);
  assertImportedSaveProviderCompatible(restored, await provider.getManifest());
  await assertShadowReads(provider, restored, restored.agents.find((agent) => agent.id === holder.id));
  const reexported = sandboxRepository.exportJson(restored);
  assert.match(reexported, /"knowledgeStore"\s*:/);
});

test('I1 consolidation reconciles a structurally valid stale sidecar before F3/WORLD reads', async () => {
  const { provider, state, holder } = await fixture(0x1c0a504);
  const staleSnapshot = structuredClone(state.knowledgeStore);
  const entry = addObservedKnowledge(state, [holder.id], ['site:i1-consolidation-stale'], 'A post-sidecar legacy observation.', 0.77, undefined, [], { promoteToSettlement: false });
  state.knowledgeStore = staleSnapshot;
  const restored = sandboxRepository.importJson(JSON.stringify(state));
  assert.ok(restored.knowledgeStore.claims.some((claim) => claim.value?.legacyKnowledgeId === entry.id));
  await assertShadowReads(provider, restored, restored.agents.find((agent) => agent.id === holder.id));
});

test('I1 consolidation rejects structurally invalid sidecar instead of allowing fail-open UI reads', async () => {
  const { state } = await fixture(0x1c0a505);
  const invalid = structuredClone(state);
  invalid.knowledgeStore = { schema: 'invalid', evidence: [], claims: [] };
  assert.throws(() => sandboxRepository.importJson(JSON.stringify(invalid)), /invalid knowledgeStore sidecar|Unsupported knowledge-store schema/i);
});

test('I1 consolidation exported sidecar identity equals deterministic legacy-derived shadow', async () => {
  const { state } = await fixture(0x1c0a506);
  const expected = buildLegacyKnowledgeShadow(state).snapshot();
  const restored = sandboxRepository.importJson(sandboxRepository.exportJson(state));
  assert.deepEqual(restored.knowledgeStore, expected);
});

test('I1 consolidation F10 and target-selection source wiring uses the verified repository/read seams', async () => {
  const app = await readSandboxUiSource();
  const safety = await readFile(new URL('../src/sandbox/worldMutationSafety.ts', import.meta.url), 'utf8');
  assert.match(app, /data-action="export"/);
  assert.match(app, /data-action="import"/);
  assert.match(app, /this\.repository\.exportJson\(this\.state\)/);
  assert.match(app, /this\.repository\.importJson\(await file\.text\(\)\)/);
  assert.match(app, /assertImportedSaveProviderCompatible\(next, manifest\)/);
  assert.match(app, /await this\.persistCurrentState\(\)/);
  assert.match(app, /window\.location\.reload\(\)/);
  assert.match(app, /if \(action==='set-prep-target'\) \{ const entity=this\.visibleWorldEntities\(\)\.find\(\(entry\)=>entry\.id===button\.dataset\.entityId\)/);
  assert.match(app, /const read = selectWorldGraphReadModel\(this\.state, controlled\.id, this\.#worldProjection\)/);
  assert.match(safety, /export function assertImportedSaveProviderCompatible/);
});

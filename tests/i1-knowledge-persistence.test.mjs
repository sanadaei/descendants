import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { legacyKnowledgeShadowSnapshot, restoreLegacyKnowledgeShadow, syncLegacyKnowledgeShadow } from '../.test-dist/sandbox/knowledgeLegacyAdapter.js';
import { createVolatileSandboxRepository, importSandboxSave, sandboxRepository, buildSaveEnvelope, unwrapStoredSave } from '../.test-dist/sandbox/storage.js';
import { selectF3KnowledgeReadModel } from '../.test-dist/sandbox/knowledgeF3Projection.js';
import { selectWorldGraphReadModel } from '../.test-dist/sandbox/knowledgeGraphProjection.js';
import { queryGeneratedWorldArea } from '../.test-dist/sandbox/localExploration.js';

async function fixture() {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed: 0x1e5a9e, population: 14 });
  const holder = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(holder);
  return { provider, state, holder };
}

function snapshotIdentity(snapshot) {
  return {
    schema: snapshot.schema,
    evidence: snapshot.evidence.map((entry) => [entry.id, entry.sourceKind, entry.sourceEntityId ?? null, entry.observerIds]),
    claims: snapshot.claims.map((entry) => [entry.id, entry.subjectId, entry.knownBy, entry.institutional, entry.evidenceIds, entry.stale ?? false]),
  };
}

test('I1-E bootstrap state carries a persisted KnowledgeStore snapshot identical to the active shadow', async () => {
  const { state } = await fixture();
  const shadow = legacyKnowledgeShadowSnapshot(state);
  assert.ok(state.knowledgeStore);
  assert.deepEqual(state.knowledgeStore, shadow);
  assert.ok(shadow.evidence.length > 0);
  assert.ok(shadow.claims.length > 0);
});

test('I1-E export/import roundtrip preserves evidence/claim IDs and personal/institutional scope exactly', async () => {
  const { state, holder } = await fixture();
  const entry = addObservedKnowledge(state, [holder.id], ['site:i1e-roundtrip'], 'Persisted I1-E roundtrip claim.', 0.82, undefined, [], { promoteToSettlement: false });
  institutionalizeKnowledgeRecord(state, holder.id, entry.id);
  const before = syncLegacyKnowledgeShadow(state);
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  const after = legacyKnowledgeShadowSnapshot(restored);
  assert.deepEqual(snapshotIdentity(after), snapshotIdentity(before));
  assert.deepEqual(after.evidence.map((item) => item.id), before.evidence.map((item) => item.id));
  assert.deepEqual(after.claims.map((item) => item.id), before.claims.map((item) => item.id));
});

test('I1-E legacy schemaVersion=1 save without knowledgeStore migrates deterministically from legacy knowledge', async () => {
  const { state } = await fixture();
  const expected = legacyKnowledgeShadowSnapshot(state);
  const legacy = structuredClone(state);
  delete legacy.knowledgeStore;
  const restored = importSandboxSave(JSON.stringify(legacy));
  assert.ok(restored.knowledgeStore);
  assert.deepEqual(restored.knowledgeStore, expected);
  const outcome = restoreLegacyKnowledgeShadow(structuredClone(legacy));
  assert.equal(outcome.migrated, true);
  assert.equal(outcome.reconciled, false);
  assert.equal(outcome.source, 'legacy-rebuilt');
});

test('I1-E structurally invalid persisted KnowledgeStore is rejected instead of silently imported', async () => {
  const { state } = await fixture();
  const broken = structuredClone(state);
  broken.knowledgeStore = { schema: 'wrong-schema', evidence: [], claims: [] };
  assert.throws(() => importSandboxSave(JSON.stringify(broken)), /invalid knowledgeStore sidecar|Unsupported knowledge-store schema/i);
});

test('I1-E stale but structurally valid sidecar is reconciled to legacy mutation authority', async () => {
  const { state, holder } = await fixture();
  const stale = structuredClone(state);
  const beforeCount = stale.knowledgeStore.claims.length;
  const entry = addObservedKnowledge(stale, [holder.id], ['site:i1e-stale'], 'A legacy mutation after an old sidecar snapshot.', 0.71, undefined, [], { promoteToSettlement: false });
  // Simulate a direct/debug JSON snapshot that bypassed repository.save/export by restoring the older sidecar.
  stale.knowledgeStore = structuredClone(state.knowledgeStore);
  assert.equal(stale.knowledgeStore.claims.length, beforeCount);
  const restored = importSandboxSave(JSON.stringify(stale));
  assert.ok(restored.knowledgeStore.claims.some((claim) => claim.value?.legacyKnowledgeId === entry.id));
  const explicit = structuredClone(stale);
  const result = restoreLegacyKnowledgeShadow(explicit);
  assert.equal(result.migrated, false);
  assert.equal(result.reconciled, true);
  assert.equal(result.source, 'legacy-reconciled');
});

test('I1-E save envelope checksum covers the persisted KnowledgeStore snapshot', async () => {
  const { state } = await fixture();
  const envelope = buildSaveEnvelope(state, null);
  assert.ok(envelope.state.knowledgeStore);
  const unwrapped = unwrapStoredSave(envelope);
  assert.deepEqual(unwrapped.state.knowledgeStore, envelope.state.knowledgeStore);
  const corrupted = structuredClone(envelope);
  corrupted.state.knowledgeStore.claims[0].confidence = Math.max(0, corrupted.state.knowledgeStore.claims[0].confidence - 0.01);
  assert.throws(() => unwrapStoredSave(corrupted), /checksum mismatch/i);
});

test('I1-E volatile repository persists the sidecar and restores it on load', async () => {
  const { state, holder } = await fixture();
  const repo = createVolatileSandboxRepository(state);
  const entry = addObservedKnowledge(state, [holder.id], ['site:i1e-volatile'], 'Volatile repository persistence claim.', 0.68, undefined, [], { promoteToSettlement: false });
  await repo.save(state);
  const loaded = await repo.load();
  assert.ok(loaded?.knowledgeStore);
  assert.ok(loaded.knowledgeStore.claims.some((claim) => claim.value?.legacyKnowledgeId === entry.id));
});

test('I1-E F3 shadow read remains identical after export/import', async () => {
  const { state, holder } = await fixture();
  const before = selectF3KnowledgeReadModel(state, holder.id, true);
  assert.equal(before.source, 'shadow');
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  const after = selectF3KnowledgeReadModel(restored, holder.id, true);
  assert.equal(after.source, 'shadow');
  assert.deepEqual(after.personal.map((entry) => entry.id), before.personal.map((entry) => entry.id));
  assert.deepEqual(after.institutional.map((entry) => entry.id), before.institutional.map((entry) => entry.id));
  assert.equal(after.comparison.equal, true);
});

test('I1-E WORLD shadow visibility/targetability remains identical after export/import', async () => {
  const { provider, state, holder } = await fixture();
  const area = await queryGeneratedWorldArea(provider, state, holder.id, state.settlement.position);
  const before = selectWorldGraphReadModel(state, holder.id, area, true);
  assert.equal(before.source, 'shadow');
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  const after = selectWorldGraphReadModel(restored, holder.id, area, true);
  assert.equal(after.source, 'shadow');
  assert.deepEqual(after.graph.entityIds, before.graph.entityIds);
  assert.deepEqual(after.graph.markerIds, before.graph.markerIds);
  assert.deepEqual(after.graph.targetableEntityIds, before.graph.targetableEntityIds);
  assert.equal(after.comparison.equal, true);
});

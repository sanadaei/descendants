import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { queryGeneratedWorldArea } from '../.test-dist/sandbox/localExploration.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { providerVisibleRouteAlternatives } from '../.test-dist/sandbox/routePlanning.js';
import {
  buildLegacyWorldGraphProjection,
  buildShadowWorldGraphProjection,
  I1D_WORLD_READ_STORAGE_KEY,
  isI1DWorldReadSwitchEnabled,
  materializeWorldEntities,
  selectWorldGraphReadModel,
} from '../.test-dist/sandbox/knowledgeGraphProjection.js';

async function fixture() {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed: 0x1d2ead, population: 14 });
  const holder = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(holder);
  const area = await queryGeneratedWorldArea(provider, state, holder.id, state.settlement.position);
  return { provider, state, holder, area };
}

function routeIdentity(routes) {
  return routes.map((route) => ({
    id: route.id,
    nodeEntityIds: route.nodeEntityIds,
    relationIds: route.relationIds,
    evidenceIds: route.evidenceIds,
    waypointEntityIds: route.waypointEntityIds,
    waypointRelationIds: route.waypointRelationIds,
    relationSignatures: route.relationSignatures,
    distanceKm: route.distanceKm,
    stretchFromShortest: route.stretchFromShortest,
    overlapWithShortest: route.overlapWithShortest,
  }));
}

test('I1-D2 WORLD read switch defaults to exact legacy provider entity objects', async () => {
  const { state, holder, area } = await fixture();
  const legacy = buildLegacyWorldGraphProjection(state, holder.id, area);
  const expected = materializeWorldEntities(area, legacy);
  const read = selectWorldGraphReadModel(state, holder.id, area, false);
  assert.equal(read.source, 'legacy');
  assert.equal(read.entityIdentityEqual, true);
  assert.deepEqual(read.entities.map((entry) => entry.id), expected.map((entry) => entry.id));
  assert.ok(read.entities.every((entry, index) => entry === expected[index]));
});

test('I1-D2 enabled selects shadow membership while preserving exact provider entity identity/order', async () => {
  const { state, holder, area } = await fixture();
  const legacyEntities = materializeWorldEntities(area, buildLegacyWorldGraphProjection(state, holder.id, area));
  const read = selectWorldGraphReadModel(state, holder.id, area, true);
  assert.equal(read.source, 'shadow', JSON.stringify(read.comparison.mismatches, null, 2));
  assert.equal(read.entityIdentityEqual, true);
  assert.deepEqual(read.entities.map((entry) => entry.id), legacyEntities.map((entry) => entry.id));
  assert.ok(read.entities.every((entry, index) => entry === legacyEntities[index]));
  assert.deepEqual(read.graph.markerIds, buildLegacyWorldGraphProjection(state, holder.id, area).markerIds);
  assert.deepEqual(read.graph.targetableEntityIds, buildLegacyWorldGraphProjection(state, holder.id, area).targetableEntityIds);
});

test('I1-D2 hidden provider entities remain absent when shadow read is enabled', async () => {
  const { state, holder, area } = await fixture();
  const legacy = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entry) => !legacy.entityIds.includes(entry.id));
  assert.ok(hidden);
  const read = selectWorldGraphReadModel(state, holder.id, area, true);
  assert.equal(read.source, 'shadow');
  assert.equal(read.entities.some((entry) => entry.id === hidden.id), false);
  assert.equal(read.graph.targetableEntityIds.includes(hidden.id), false);
});

test('I1-D2 fails closed to legacy when shadow knowledge is deliberately stale', async () => {
  const { state, holder, area } = await fixture();
  const visible = state.knowledge.find((entry) => !entry.lost && entry.holderIds.includes(holder.id) && entry.subjectIds.some((id) => area.entities.some((entity) => entity.id === id && entity.id !== state.world.originEntityId)));
  assert.ok(visible);
  visible.lost = true; // intentionally bypass shadow synchronization
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const read = selectWorldGraphReadModel(state, holder.id, area, true);
    assert.equal(read.source, 'legacy');
    assert.equal(read.fallbackReason, 'projection-mismatch');
    assert.equal(read.comparison.equal, false);
    const legacyEntities = materializeWorldEntities(area, buildLegacyWorldGraphProjection(state, holder.id, area));
    assert.ok(read.entities.every((entry, index) => entry === legacyEntities[index]));
  } finally {
    console.warn = originalWarn;
  }
});

test('I1-D2 target action identity is identical because targetable IDs are preserved', async () => {
  const { state, holder, area } = await fixture();
  const legacy = buildLegacyWorldGraphProjection(state, holder.id, area);
  const read = selectWorldGraphReadModel(state, holder.id, area, true);
  assert.equal(read.source, 'shadow');
  assert.deepEqual(read.graph.targetableEntityIds, legacy.targetableEntityIds);
  for (const id of read.graph.targetableEntityIds) {
    const entity = read.entities.find((entry) => entry.id === id);
    assert.ok(entity?.spatial, `target action ${id} must resolve to the same spatial provider entity`);
    assert.equal(entity.id, id);
  }
});

test('I1-D2 provider-visible route/topology alternatives are identical under shadow WORLD read', async () => {
  const { state, holder, area } = await fixture();
  const legacyGraph = buildLegacyWorldGraphProjection(state, holder.id, area);
  const legacyEntities = materializeWorldEntities(area, legacyGraph);
  const read = selectWorldGraphReadModel(state, holder.id, area, true);
  assert.equal(read.source, 'shadow');
  for (const targetId of legacyGraph.targetableEntityIds) {
    const legacyRoutes = providerVisibleRouteAlternatives(area, legacyEntities, state.world.originEntityId, targetId, 3);
    const shadowRoutes = providerVisibleRouteAlternatives(area, read.entities, state.world.originEntityId, targetId, 3);
    assert.deepEqual(routeIdentity(shadowRoutes), routeIdentity(legacyRoutes), `route identity diverged for ${targetId}`);
  }
});

test('I1-D2 preserves institutional settlement visibility and expedition isolation', async () => {
  const { state, holder, area } = await fixture();
  const before = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entity) => entity.id !== state.world.originEntityId && !before.entityIds.includes(entity.id));
  assert.ok(hidden);
  const entry = addObservedKnowledge(state, [holder.id], [hidden.id], 'I1-D2 institutional route evidence.', 0.75, undefined, [], { promoteToSettlement: false });
  institutionalizeKnowledgeRecord(state, holder.id, entry.id);
  const other = state.agents.find((agent) => agent.alive && agent.id !== holder.id && !agent.expeditionId);
  assert.ok(other);
  const settlementRead = selectWorldGraphReadModel(state, other.id, area, true);
  assert.equal(settlementRead.source, 'shadow');
  assert.ok(settlementRead.entities.some((candidate) => candidate.id === hidden.id));
  other.expeditionId = 'expedition:i1d2-boundary';
  const expeditionRead = selectWorldGraphReadModel(state, other.id, area, true);
  assert.equal(expeditionRead.source, 'shadow');
  assert.equal(expeditionRead.entities.some((candidate) => candidate.id === hidden.id), false);
});

test('I1-D2 WORLD read storage flag is explicit opt-in and uses the documented localStorage key', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
  });
  try {
    assert.equal(isI1DWorldReadSwitchEnabled(), false);
    globalThis.localStorage.setItem(I1D_WORLD_READ_STORAGE_KEY, '1');
    assert.equal(isI1DWorldReadSwitchEnabled(), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

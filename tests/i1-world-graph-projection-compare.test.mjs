import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { syncLegacyKnowledgeShadow } from '../.test-dist/sandbox/knowledgeLegacyAdapter.js';
import { queryGeneratedWorldArea } from '../.test-dist/sandbox/localExploration.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import {
  buildLegacyWorldGraphProjection,
  buildShadowWorldGraphProjection,
  compareWorldGraphProjections,
  compareWorldGraphProjectionsIfEnabled,
  materializeWorldEntities,
} from '../.test-dist/sandbox/knowledgeGraphProjection.js';

async function fixture() {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed: 0x1d5eed, population: 12 });
  const holder = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(holder);
  const area = await queryGeneratedWorldArea(provider, state, holder.id, state.settlement.position);
  return { provider, state, holder, area };
}

test('I1-D legacy and KnowledgeStore WORLD entity/marker/target order match at bootstrap', async () => {
  const { state, holder, area } = await fixture();
  const result = compareWorldGraphProjections(state, holder.id, area);
  assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
  const legacy = buildLegacyWorldGraphProjection(state, holder.id, area);
  const shadow = buildShadowWorldGraphProjection(state, holder.id, area);
  assert.deepEqual(shadow.entityIds, legacy.entityIds);
  assert.deepEqual(shadow.markerIds, legacy.markerIds);
  assert.deepEqual(shadow.targetableEntityIds, legacy.targetableEntityIds);
});

test('I1-D hidden provider entity without personal/institutional/contact basis stays unplotted', async () => {
  const { state, holder, area } = await fixture();
  const legacy = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entity) => entity.id !== state.world.originEntityId && !legacy.entityIds.includes(entity.id));
  assert.ok(hidden, 'mock WORLD area should include at least one provider entity outside current knowledge');
  const shadow = buildShadowWorldGraphProjection(state, holder.id, area);
  assert.equal(shadow.entityIds.includes(hidden.id), false);
  assert.equal(shadow.rows.some((row) => row.entityId === hidden.id), false);
});

test('I1-D personal observation reveals only the observed subject to that holder', async () => {
  const { state, holder, area } = await fixture();
  const before = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entity) => entity.id !== state.world.originEntityId && !before.entityIds.includes(entity.id));
  assert.ok(hidden);
  addObservedKnowledge(state, [holder.id], [hidden.id], 'I1-D holder-only map evidence.', 0.8, undefined, [], { promoteToSettlement: false });
  const result = compareWorldGraphProjections(state, holder.id, area);
  assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
  const shadow = buildShadowWorldGraphProjection(state, holder.id, area);
  assert.ok(shadow.entityIds.includes(hidden.id));
  const other = state.agents.find((agent) => agent.alive && agent.id !== holder.id && !agent.expeditionId);
  assert.ok(other);
  const otherShadow = buildShadowWorldGraphProjection(state, other.id, area);
  assert.equal(otherShadow.entityIds.includes(hidden.id), false);
});

test('I1-D institutional promotion exposes a subject to another settlement holder but not through hidden truth', async () => {
  const { state, holder, area } = await fixture();
  const before = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entity) => entity.id !== state.world.originEntityId && !before.entityIds.includes(entity.id));
  assert.ok(hidden);
  const entry = addObservedKnowledge(state, [holder.id], [hidden.id], 'I1-D Archive map evidence.', 0.77, undefined, [], { promoteToSettlement: false });
  institutionalizeKnowledgeRecord(state, holder.id, entry.id);
  const other = state.agents.find((agent) => agent.alive && agent.id !== holder.id && !agent.expeditionId);
  assert.ok(other);
  const result = compareWorldGraphProjections(state, other.id, area);
  assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
  const shadow = buildShadowWorldGraphProjection(state, other.id, area);
  const row = shadow.rows.find((candidate) => candidate.entityId === hidden.id);
  assert.ok(row);
  assert.ok(row.basis.some((basis) => basis.kind === 'institutional-claim' && basis.id === entry.id));
});

test('I1-D stale/lost knowledge removes the map basis rather than tracking hidden provider state', async () => {
  const { state, holder, area } = await fixture();
  const before = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entity) => entity.id !== state.world.originEntityId && !before.entityIds.includes(entity.id));
  assert.ok(hidden);
  const entry = addObservedKnowledge(state, [holder.id], [hidden.id], 'I1-D temporary map evidence.', 0.62, undefined, [], { promoteToSettlement: false });
  assert.ok(buildShadowWorldGraphProjection(state, holder.id, area).entityIds.includes(hidden.id));
  entry.lost = true;
  syncLegacyKnowledgeShadow(state);
  const result = compareWorldGraphProjections(state, holder.id, area);
  assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
  assert.equal(buildShadowWorldGraphProjection(state, holder.id, area).entityIds.includes(hidden.id), false);
});

test('I1-D targetability matches existing visible marker + spatial rules exactly', async () => {
  const { state, holder, area } = await fixture();
  const shadow = buildShadowWorldGraphProjection(state, holder.id, area);
  const entities = materializeWorldEntities(area, shadow);
  const expected = entities.filter((entity) => entity.id !== state.world.originEntityId && entity.spatial).map((entity) => entity.id);
  assert.deepEqual(shadow.targetableEntityIds, expected);
  assert.equal(compareWorldGraphProjections(state, holder.id, area).equal, true);
});

test('I1-D comparator detects deliberately stale shadow knowledge instead of silently plotting divergence', async () => {
  const { state, holder, area } = await fixture();
  syncLegacyKnowledgeShadow(state);
  const before = compareWorldGraphProjections(state, holder.id, area);
  assert.equal(before.equal, true);
  const visible = state.knowledge.find((entry) => !entry.lost && entry.holderIds.includes(holder.id) && entry.subjectIds.some((id) => area.entities.some((entity) => entity.id === id && entity.id !== state.world.originEntityId)));
  assert.ok(visible);
  visible.lost = true; // deliberately bypass normal sync path
  const after = compareWorldGraphProjections(state, holder.id, area);
  assert.equal(after.equal, false);
  assert.ok(after.mismatches.some((mismatch) => ['entity-count','entity-order','unexpected-shadow-entity','marker-count','marker-order','target-count','target-order'].includes(mismatch.field)));
});

test('I1-D diagnostic hook is OFF by default and compare-only when explicitly enabled', async () => {
  const { state, holder, area } = await fixture();
  const before = JSON.stringify(state);
  assert.equal(compareWorldGraphProjectionsIfEnabled(state, holder.id, area, false), null);
  const result = compareWorldGraphProjectionsIfEnabled(state, holder.id, area, true);
  assert.ok(result);
  assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
  assert.equal(JSON.stringify(state), before);
});

test('I1-D expedition viewpoint does not inherit settlement institutional map reachability', async () => {
  const { state, holder, area } = await fixture();
  const before = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entity) => entity.id !== state.world.originEntityId && !before.entityIds.includes(entity.id));
  assert.ok(hidden);
  const entry = addObservedKnowledge(state, [holder.id], [hidden.id], 'I1-D institutional-only expedition boundary.', 0.74, undefined, [], { promoteToSettlement: false });
  institutionalizeKnowledgeRecord(state, holder.id, entry.id);
  const other = state.agents.find((agent) => agent.alive && agent.id !== holder.id && !agent.expeditionId);
  assert.ok(other);
  assert.ok(buildShadowWorldGraphProjection(state, other.id, area).entityIds.includes(hidden.id));
  other.expeditionId = 'expedition:i1d-boundary';
  const result = compareWorldGraphProjections(state, other.id, area);
  assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
  assert.equal(buildShadowWorldGraphProjection(state, other.id, area).entityIds.includes(hidden.id), false);
});

test('I1-D directly known external actor follows existing settlement/expedition visibility policy without provider-wide disclosure', async () => {
  const { state, holder, area } = await fixture();
  const legacyBefore = buildLegacyWorldGraphProjection(state, holder.id, area);
  const hidden = area.entities.find((entity) => entity.id !== state.world.originEntityId && !legacyBefore.entityIds.includes(entity.id));
  assert.ok(hidden);
  state.externalActors.push({
    entityId: hidden.id,
    kind: hidden.kind,
    name: 'Known outside contact',
    population: null,
    position: hidden.spatial ? structuredClone(hidden.spatial) : null,
    lastObservedTick: state.clock.worldTick,
    confidence: 0.7,
    disposition: null,
    localTrust: 0,
    tradeExperience: 0,
    migrationBalance: 0,
    conflictPressure: 0,
  });
  const settlementResult = compareWorldGraphProjections(state, holder.id, area);
  assert.equal(settlementResult.equal, true, JSON.stringify(settlementResult.mismatches, null, 2));
  const row = buildShadowWorldGraphProjection(state, holder.id, area).rows.find((candidate) => candidate.entityId === hidden.id);
  assert.ok(row?.basis.some((basis) => basis.kind === 'known-external-actor'));
  holder.expeditionId = 'expedition:i1d-external';
  const expeditionResult = compareWorldGraphProjections(state, holder.id, area);
  assert.equal(expeditionResult.equal, true, JSON.stringify(expeditionResult.mismatches, null, 2));
  assert.equal(buildShadowWorldGraphProjection(state, holder.id, area).entityIds.includes(hidden.id), false);
});

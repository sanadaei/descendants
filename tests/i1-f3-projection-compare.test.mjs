import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import {
  addObservedKnowledge,
  conductDirectConversation,
  institutionalizeKnowledgeRecord,
} from '../.test-dist/sandbox/knowledgeSimulation.js';
import { syncLegacyKnowledgeShadow } from '../.test-dist/sandbox/knowledgeLegacyAdapter.js';
import {
  buildLegacyF3Projection,
  buildShadowF3Projection,
  compareF3KnowledgeProjections,
  compareF3KnowledgeProjectionsIfEnabled,
} from '../.test-dist/sandbox/knowledgeF3Projection.js';

async function stateFixture() {
  const provider = new MockWorldProvider();
  return createInitialSandboxState(provider, { seed: 0x1c5eed, population: 12 });
}

function settlementPeople(state) {
  return state.agents.filter((agent) => agent.alive && !agent.expeditionId && (!agent.residence || agent.residence === 'settlement'));
}

test('I1-C baseline machine-compare matches personal/institutional F3 projections for every settlement holder', async () => {
  const state = await stateFixture();
  for (const holder of settlementPeople(state)) {
    const result = compareF3KnowledgeProjections(state, holder.id);
    assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
    assert.equal(result.legacyCounts.personal, result.shadowCounts.personal);
    assert.equal(result.legacyCounts.institutional, result.shadowCounts.institutional);
  }
});

test('I1-C direct personal observation preserves claim text, confidence, order and personal-only access', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const entry = addObservedKnowledge(state, [holder.id], ['site:i1c-personal'], 'I1-C exact personal projection claim.', 0.734, undefined, ['cause:a', 'cause:b'], { promoteToSettlement: false });
  const legacy = buildLegacyF3Projection(state, holder.id);
  const shadow = buildShadowF3Projection(state, holder.id).projection;
  assert.equal(compareF3KnowledgeProjections(state, holder.id).equal, true);
  const legacyRow = legacy.personal.find((row) => row.legacyKnowledgeId === entry.id);
  const shadowRow = shadow.personal.find((row) => row.legacyKnowledgeId === entry.id);
  assert.ok(legacyRow && shadowRow);
  assert.equal(shadowRow.claim, legacyRow.claim);
  assert.equal(shadowRow.confidence, legacyRow.confidence);
  assert.deepEqual(shadowRow.subjectIds, legacyRow.subjectIds);
  assert.equal(shadowRow.institutional, false);
  assert.equal(shadow.institutional.some((row) => row.legacyKnowledgeId === entry.id), false);
});

test('I1-C explicit Archive promotion preserves institutional scope while personal access remains visible to holder', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const entry = addObservedKnowledge(state, [holder.id], ['site:i1c-archive'], 'I1-C archive parity claim.', 0.81, undefined, [], { promoteToSettlement: false });
  institutionalizeKnowledgeRecord(state, holder.id, entry.id);
  const resultForHolder = compareF3KnowledgeProjections(state, holder.id);
  assert.equal(resultForHolder.equal, true, JSON.stringify(resultForHolder.mismatches, null, 2));
  const other = settlementPeople(state).find((agent) => agent.id !== holder.id);
  assert.ok(other);
  const resultForOther = compareF3KnowledgeProjections(state, other.id);
  assert.equal(resultForOther.equal, true, JSON.stringify(resultForOther.mismatches, null, 2));
  const shadowOther = buildShadowF3Projection(state, other.id).projection;
  assert.ok(shadowOther.institutional.some((row) => row.legacyKnowledgeId === entry.id));
});

test('I1-C conversation transfer preserves knownBy/access scope without silent institutionalization', async () => {
  const state = await stateFixture();
  const [speaker, listener] = settlementPeople(state);
  assert.ok(speaker && listener);
  const entry = addObservedKnowledge(state, [speaker.id], ['site:i1c-conversation'], 'I1-C conversation parity claim.', 0.69, undefined, [], { promoteToSettlement: false });
  conductDirectConversation(state, speaker.id, listener.id, entry.id);
  for (const holder of [speaker, listener]) {
    const result = compareF3KnowledgeProjections(state, holder.id);
    assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
    const shadow = buildShadowF3Projection(state, holder.id).projection;
    const row = shadow.personal.find((candidate) => candidate.legacyKnowledgeId === entry.id);
    assert.ok(row);
    assert.equal(row.institutional, false);
    assert.ok(row.knownBy.includes(speaker.id));
    assert.ok(row.knownBy.includes(listener.id));
  }
});

test('I1-C WorldProvider-seeded claim keeps provider-projection provenance without claiming hidden truth', async () => {
  const state = await stateFixture();
  const seeded = state.knowledge.find((entry) => entry.sourceWorldKnowledgeId);
  assert.ok(seeded);
  const holder = state.agents.find((agent) => agent.knowledgeIds.includes(seeded.id));
  assert.ok(holder);
  const shadow = buildShadowF3Projection(state, holder.id).projection;
  const row = shadow.personal.find((candidate) => candidate.legacyKnowledgeId === seeded.id);
  assert.ok(row);
  assert.equal(row.provenance.providerProjection, true);
  assert.equal(row.provenance.sourceKind, 'institutional-report');
  assert.equal(row.provenance.physicalEvidence, false);
  assert.equal(compareF3KnowledgeProjections(state, holder.id).equal, true);
});

test('I1-C physical evidence projection keeps source entity and provenance semantics', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const entry = addObservedKnowledge(state, [holder.id], ['entity:observed'], 'I1-C physical evidence parity claim.', 0.88, undefined, ['event:field'], { promoteToSettlement: false });
  entry.physicalEvidenceSourceEntityId = 'entity:physical-source';
  syncLegacyKnowledgeShadow(state);
  const result = compareF3KnowledgeProjections(state, holder.id);
  assert.equal(result.equal, true, JSON.stringify(result.mismatches, null, 2));
  const shadow = buildShadowF3Projection(state, holder.id).projection;
  const row = shadow.personal.find((candidate) => candidate.legacyKnowledgeId === entry.id);
  assert.ok(row);
  assert.equal(row.provenance.sourceEntityId, 'entity:physical-source');
  assert.equal(row.provenance.physicalEvidence, true);
  assert.equal(row.provenance.truthLinkCount, 1);
});

test('I1-C comparator detects a deliberately stale shadow instead of silently accepting divergence', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const entry = addObservedKnowledge(state, [holder.id], ['site:i1c-stale'], 'Original compare text.', 0.51, undefined, [], { promoteToSettlement: false });
  const before = compareF3KnowledgeProjections(state, holder.id);
  assert.equal(before.equal, true);
  entry.claim = 'Legacy changed without the normal shadow sync path.';
  const after = compareF3KnowledgeProjections(state, holder.id);
  assert.equal(after.equal, false);
  assert.ok(after.mismatches.some((mismatch) => mismatch.legacyKnowledgeId === entry.id && mismatch.field === 'claim-text'));
});

test('I1-C feature-gated diagnostic is OFF by default and can compare without changing legacy state', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const before = JSON.stringify(state);
  assert.equal(compareF3KnowledgeProjectionsIfEnabled(state, holder.id, false), null);
  const enabled = compareF3KnowledgeProjectionsIfEnabled(state, holder.id, true);
  assert.ok(enabled);
  assert.equal(enabled.equal, true, JSON.stringify(enabled.mismatches, null, 2));
  assert.equal(JSON.stringify(state), before);
});

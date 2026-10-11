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
  I1C_F3_READ_STORAGE_KEY,
  isI1CF3ReadSwitchEnabled,
  selectF3KnowledgeReadModel,
} from '../.test-dist/sandbox/knowledgeF3Projection.js';

async function stateFixture() {
  const provider = new MockWorldProvider();
  return createInitialSandboxState(provider, { seed: 0x1c2ead, population: 12 });
}

function settlementPeople(state) {
  return state.agents.filter((agent) => agent.alive && !agent.expeditionId && (!agent.residence || agent.residence === 'settlement'));
}

function renderIdentity(entry) {
  return {
    id: entry.id,
    subjectIds: entry.subjectIds,
    claim: entry.claim,
    confidence: entry.confidence,
    carrier: entry.carrier,
    holderIds: entry.holderIds,
    sourceKnowledgeId: entry.sourceKnowledgeId ?? null,
    sourceWorldKnowledgeId: entry.sourceWorldKnowledgeId ?? null,
    truthLinkIds: entry.truthLinkIds,
    lost: entry.lost,
    physicalEvidenceSourceEntityId: entry.physicalEvidenceSourceEntityId ?? null,
    requiresPhysicalSample: entry.requiresPhysicalSample ?? null,
  };
}

function legacyEntries(state, holderId) {
  const projection = buildLegacyF3Projection(state, holderId);
  const byId = new Map(state.knowledge.map((entry) => [entry.id, entry]));
  return {
    personal: projection.personal.map((row) => byId.get(row.legacyKnowledgeId)),
    institutional: projection.institutional.map((row) => byId.get(row.legacyKnowledgeId)),
  };
}

test('I1-C read switch defaults to legacy authority and preserves exact existing entry objects', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const expected = legacyEntries(state, holder.id);
  const read = selectF3KnowledgeReadModel(state, holder.id, false);
  assert.equal(read.source, 'legacy');
  assert.equal(read.renderIdentityEqual, true);
  assert.deepEqual(read.personal.map((entry) => entry.id), expected.personal.map((entry) => entry.id));
  assert.deepEqual(read.institutional.map((entry) => entry.id), expected.institutional.map((entry) => entry.id));
  if (read.personal.length) assert.equal(read.personal[0], expected.personal[0]);
});

test('I1-C read switch enabled selects KnowledgeStore projection with render/action identity intact', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const expected = legacyEntries(state, holder.id);
  const read = selectF3KnowledgeReadModel(state, holder.id, true);
  assert.equal(read.source, 'shadow', JSON.stringify(read.comparison.mismatches, null, 2));
  assert.equal(read.renderIdentityEqual, true);
  assert.equal(read.fallbackReason, undefined);
  assert.deepEqual(read.personal.map(renderIdentity), expected.personal.map(renderIdentity));
  assert.deepEqual(read.institutional.map(renderIdentity), expected.institutional.map(renderIdentity));
  if (read.personal.length) assert.notEqual(read.personal[0], expected.personal[0], 'shadow read rows must be materialized clones, not legacy object aliases');
});

test('I1-C read switch preserves personal conversation transfer and institutional Archive access', async () => {
  const state = await stateFixture();
  const [speaker, listener, observer] = settlementPeople(state);
  assert.ok(speaker && listener && observer);
  const entry = addObservedKnowledge(state, [speaker.id], ['site:i1c-read'], 'I1-C read switch access claim.', 0.77, undefined, [], { promoteToSettlement: false });
  conductDirectConversation(state, speaker.id, listener.id, entry.id);
  institutionalizeKnowledgeRecord(state, speaker.id, entry.id);
  for (const holder of [speaker, listener]) {
    const read = selectF3KnowledgeReadModel(state, holder.id, true);
    assert.equal(read.source, 'shadow');
    assert.ok(read.personal.some((candidate) => candidate.id === entry.id));
    assert.equal(read.institutional.some((candidate) => candidate.id === entry.id), false, 'personal rows are not duplicated in institutional section');
  }
  const otherRead = selectF3KnowledgeReadModel(state, observer.id, true);
  assert.equal(otherRead.source, 'shadow');
  assert.ok(otherRead.institutional.some((candidate) => candidate.id === entry.id));
});

test('I1-C read switch returns detached shadow rows so F3 rendering cannot mutate legacy authority accidentally', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const read = selectF3KnowledgeReadModel(state, holder.id, true);
  const row = read.personal[0] ?? read.institutional[0];
  assert.ok(row);
  const legacy = state.knowledge.find((entry) => entry.id === row.id);
  assert.ok(legacy);
  const originalClaim = legacy.claim;
  row.claim = 'mutated detached projection';
  row.subjectIds.push('mutated:subject');
  assert.equal(legacy.claim, originalClaim);
  assert.equal(legacy.subjectIds.includes('mutated:subject'), false);
});

test('I1-C read switch fails closed to legacy when shadow projection is stale', async () => {
  const state = await stateFixture();
  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const entry = addObservedKnowledge(state, [holder.id], ['site:i1c-read-stale'], 'Before stale mutation.', 0.61, undefined, [], { promoteToSettlement: false });
  const before = selectF3KnowledgeReadModel(state, holder.id, true);
  assert.equal(before.source, 'shadow');
  entry.claim = 'Changed without shadow synchronization.';
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const after = selectF3KnowledgeReadModel(state, holder.id, true);
    assert.equal(after.source, 'legacy');
    assert.equal(after.fallbackReason, 'projection-mismatch');
    assert.equal(after.renderIdentityEqual, false);
    assert.ok(after.personal.some((candidate) => candidate.id === entry.id && candidate.claim === entry.claim));
  } finally {
    console.warn = originalWarn;
  }
});

test('I1-C read switch preserves provider and physical-evidence compatibility metadata used by existing F3 actions', async () => {
  const state = await stateFixture();
  const providerEntry = state.knowledge.find((entry) => entry.sourceWorldKnowledgeId);
  assert.ok(providerEntry);
  const providerHolder = state.agents.find((agent) => agent.knowledgeIds.includes(providerEntry.id));
  assert.ok(providerHolder);
  const providerRead = selectF3KnowledgeReadModel(state, providerHolder.id, true);
  const providerRow = providerRead.personal.find((entry) => entry.id === providerEntry.id) ?? providerRead.institutional.find((entry) => entry.id === providerEntry.id);
  assert.ok(providerRow);
  assert.equal(providerRow.sourceWorldKnowledgeId, providerEntry.sourceWorldKnowledgeId);
  assert.deepEqual(providerRow.truthLinkIds, providerEntry.truthLinkIds);

  const holder = settlementPeople(state)[0];
  assert.ok(holder);
  const physical = addObservedKnowledge(state, [holder.id], ['entity:i1c-read-physical'], 'Physical evidence read candidate.', 0.83, undefined, ['event:physical'], { promoteToSettlement: false });
  physical.physicalEvidenceSourceEntityId = 'entity:physical-source';
  physical.requiresPhysicalSample = true;
  syncLegacyKnowledgeShadow(state);
  const physicalRead = selectF3KnowledgeReadModel(state, holder.id, true);
  const physicalRow = physicalRead.personal.find((entry) => entry.id === physical.id);
  assert.ok(physicalRow);
  assert.equal(physicalRow.physicalEvidenceSourceEntityId, 'entity:physical-source');
  assert.equal(physicalRow.requiresPhysicalSample, true);
});

test('I1-C read storage flag is opt-in and uses the documented localStorage key', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
  });
  try {
    assert.equal(isI1CF3ReadSwitchEnabled(), false);
    globalThis.localStorage.setItem(I1C_F3_READ_STORAGE_KEY, '1');
    assert.equal(isI1CF3ReadSwitchEnabled(), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('I1-C read switch enabled matches legacy render/action identity for every settlement holder in baseline fixture', async () => {
  const state = await stateFixture();
  for (const holder of settlementPeople(state)) {
    const expected = legacyEntries(state, holder.id);
    const read = selectF3KnowledgeReadModel(state, holder.id, true);
    assert.equal(read.source, 'shadow', `${holder.id}: ${JSON.stringify(read.comparison.mismatches)}`);
    assert.equal(read.renderIdentityEqual, true);
    assert.deepEqual(read.personal.map(renderIdentity), expected.personal.map(renderIdentity));
    assert.deepEqual(read.institutional.map(renderIdentity), expected.institutional.map(renderIdentity));
  }
});

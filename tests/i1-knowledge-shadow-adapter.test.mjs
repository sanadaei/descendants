import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import {
  addObservedKnowledge,
  conductDirectConversation,
  institutionalizeKnowledgeRecord,
} from '../.test-dist/sandbox/knowledgeSimulation.js';
import {
  hasLegacyKnowledgeShadow,
  legacyKnowledgeShadowSnapshot,
  syncLegacyKnowledgeShadow,
} from '../.test-dist/sandbox/knowledgeLegacyAdapter.js';

async function stateFixture() {
  const provider = new MockWorldProvider();
  return createInitialSandboxState(provider, { seed: 0x1b5eed, population: 12 });
}

function claimsForLegacy(snapshot, legacyId) {
  return snapshot.claims.filter((claim) => claim.value?.legacyKnowledgeId === legacyId);
}

test('I1-B bootstrap shadows provider-seeded legacy knowledge without changing legacy state', async () => {
  const state = await stateFixture();
  assert.equal(hasLegacyKnowledgeShadow(state), true);
  const before = JSON.stringify(state);
  const snapshot = legacyKnowledgeShadowSnapshot(state);
  assert.equal(JSON.stringify(state), before);
  assert.equal(snapshot.evidence.length, state.knowledge.length);
  assert.ok(snapshot.claims.length >= state.knowledge.length);
  const seeded = state.knowledge.find((entry) => entry.sourceWorldKnowledgeId);
  assert.ok(seeded);
  const claims = claimsForLegacy(snapshot, seeded.id);
  assert.ok(claims.length > 0);
  assert.deepEqual(claims[0].knownBy.slice().sort(), seeded.holderIds.slice().sort());
  assert.equal(claims[0].institutional, state.settlement.localKnowledgeIds.includes(seeded.id));
  const evidence = snapshot.evidence.find((entry) => entry.id === `legacy-evidence:${seeded.id}`);
  assert.match(evidence.provenanceText, /WorldProvider knowledge projection \(not hidden World Truth\)/);
});

test('I1-B addObservedKnowledge shadow-write mirrors personal scope and keeps F3 legacy arrays authoritative', async () => {
  const state = await stateFixture();
  const holder = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(holder);
  const legacyCount = state.knowledge.length;
  const entry = addObservedKnowledge(state, [holder.id], ['site:test-shadow'], 'A directly observed test condition.', 0.73, undefined, [], { promoteToSettlement: false });
  assert.equal(state.knowledge.length, legacyCount + 1);
  assert.equal(state.settlement.localKnowledgeIds.includes(entry.id), false);
  const snapshot = legacyKnowledgeShadowSnapshot(state);
  const claims = claimsForLegacy(snapshot, entry.id);
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].knownBy, [holder.id]);
  assert.equal(claims[0].institutional, false);
  assert.equal(claims[0].value.text, entry.claim);
});

test('I1-B direct conversation updates shadow knownBy but does not silently institutionalize', async () => {
  const state = await stateFixture();
  const people = state.agents.filter((agent) => agent.alive && !agent.expeditionId && (!agent.residence || agent.residence === 'settlement'));
  assert.ok(people.length >= 2);
  const [speaker, listener] = people;
  const entry = addObservedKnowledge(state, [speaker.id], ['site:conversation-shadow'], 'A personally held conversation test claim.', 0.66, undefined, [], { promoteToSettlement: false });
  conductDirectConversation(state, speaker.id, listener.id, entry.id);
  const snapshot = legacyKnowledgeShadowSnapshot(state);
  const claims = claimsForLegacy(snapshot, entry.id);
  assert.equal(claims.length, 1);
  assert.ok(claims[0].knownBy.includes(speaker.id));
  assert.ok(claims[0].knownBy.includes(listener.id));
  assert.equal(claims[0].institutional, false);
  assert.equal(state.settlement.localKnowledgeIds.includes(entry.id), false);
});

test('I1-B archive action flips only shadow institutional access that already exists in legacy state', async () => {
  const state = await stateFixture();
  const author = state.agents.find((agent) => agent.alive && !agent.expeditionId && (!agent.residence || agent.residence === 'settlement'));
  assert.ok(author);
  const entry = addObservedKnowledge(state, [author.id], ['site:archive-shadow'], 'A claim selected for explicit archive promotion.', 0.81, undefined, [], { promoteToSettlement: false });
  let snapshot = legacyKnowledgeShadowSnapshot(state);
  assert.equal(claimsForLegacy(snapshot, entry.id)[0].institutional, false);
  institutionalizeKnowledgeRecord(state, author.id, entry.id);
  assert.equal(state.settlement.localKnowledgeIds.includes(entry.id), true);
  snapshot = legacyKnowledgeShadowSnapshot(state);
  assert.equal(claimsForLegacy(snapshot, entry.id)[0].institutional, true);
  assert.equal(state.knowledge.find((item) => item.id === entry.id)?.carrier, 'record');
});

test('I1-B explicit resync marks lost legacy knowledge stale without deleting provenance', async () => {
  const state = await stateFixture();
  const entry = state.knowledge[0];
  assert.ok(entry);
  entry.lost = true;
  const snapshot = syncLegacyKnowledgeShadow(state);
  const claims = claimsForLegacy(snapshot, entry.id);
  assert.ok(claims.length > 0);
  assert.ok(claims.every((claim) => claim.stale === true));
  assert.ok(snapshot.evidence.some((evidence) => evidence.id === `legacy-evidence:${entry.id}`));
});

test('I1-E persists the shadow sidecar as an optional schemaVersion=1 knowledgeStore field', async () => {
  const state = await stateFixture();
  const snapshot = legacyKnowledgeShadowSnapshot(state);
  assert.ok(snapshot.claims.length > 0);
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('descendants-knowledge-store-v1'), true);
  assert.equal(Object.hasOwn(state, 'knowledgeStore'), true);
  assert.deepEqual(state.knowledgeStore, snapshot);
  assert.equal(Object.hasOwn(state, 'knowledgeShadow'), false);
});

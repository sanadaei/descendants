import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeStore } from '../.test-dist/sandbox/knowledgeStore.js';

const rumorEvidence = () => ({
  id: 'evidence:rumor:relay',
  observedAt: 12,
  sourceKind: 'rumor',
  sourceEntityId: 'person:scout',
  observerIds: ['person:listener'],
  provenanceText: 'Scout report heard at the settlement.',
});

const rumorClaim = () => ({
  id: 'claim:relay:location:rumor',
  subjectId: 'landmark:relay-tower',
  predicate: 'location',
  value: { region: 'greenfold', precisionKm: 8 },
  confidence: 0.42,
  knownBy: ['person:listener'],
  institutional: false,
  evidenceIds: ['evidence:rumor:relay'],
  firstKnownAt: 12,
  lastUpdatedAt: 12,
});

test('I1-A store preserves personal and institutional knowledge as separate scopes', () => {
  const store = new KnowledgeStore();
  store.recordEvidence(rumorEvidence());
  store.recordClaim(rumorClaim());
  store.recordEvidence({
    id: 'evidence:archive:road', observedAt: 13, sourceKind: 'institutional-report', observerIds: [],
    provenanceText: 'Settlement archive route ledger.',
  });
  store.recordClaim({
    id: 'claim:road:passable', subjectId: 'terrain:old-service-road', predicate: 'passable', value: true,
    confidence: 0.88, knownBy: [], institutional: true, evidenceIds: ['evidence:archive:road'],
    firstKnownAt: 13, lastUpdatedAt: 13,
  });
  assert.deepEqual(store.claimsKnownBy('person:listener').map((entry) => entry.id), ['claim:relay:location:rumor']);
  assert.deepEqual(store.institutionalClaims().map((entry) => entry.id), ['claim:road:passable']);
});

test('I1-A store refuses claims whose evidence does not exist', () => {
  const store = new KnowledgeStore();
  assert.throws(() => store.recordClaim({
    ...rumorClaim(), evidenceIds: ['evidence:hidden-world-truth'],
  }), /references missing evidence/);
});

test('I1-A supersession preserves old provenance while marking prior knowledge stale', () => {
  const store = new KnowledgeStore();
  store.recordEvidence(rumorEvidence());
  store.recordClaim(rumorClaim());
  store.recordEvidence({
    id: 'evidence:observation:relay', observedAt: 24, sourceKind: 'direct-observation', sourceEntityId: 'landmark:relay-tower',
    observerIds: ['person:listener'], provenanceText: 'Direct field observation.',
  });
  store.recordClaim({
    id: 'claim:relay:location:observed', subjectId: 'landmark:relay-tower', predicate: 'location',
    value: { x: 14, y: -3, precisionKm: 0.1 }, confidence: 0.96, knownBy: ['person:listener'], institutional: false,
    evidenceIds: ['evidence:observation:relay'], firstKnownAt: 24, lastUpdatedAt: 24,
  });
  store.supersedeClaim('claim:relay:location:rumor', 'claim:relay:location:observed');
  assert.equal(store.claim('claim:relay:location:rumor')?.stale, true);
  assert.deepEqual(store.claim('claim:relay:location:observed')?.supersedes, ['claim:relay:location:rumor']);
  assert.equal(store.evidenceForClaim('claim:relay:location:rumor')[0]?.sourceKind, 'rumor');
});

test('I1-A read results are defensive clones and cannot mutate store state', () => {
  const store = new KnowledgeStore();
  store.recordEvidence(rumorEvidence());
  store.recordClaim(rumorClaim());
  const claim = store.claim('claim:relay:location:rumor');
  assert.ok(claim);
  claim.knownBy.push('person:intruder');
  claim.value.region = 'secret-updated-location';
  assert.deepEqual(store.claim('claim:relay:location:rumor')?.knownBy, ['person:listener']);
  assert.equal(store.claim('claim:relay:location:rumor')?.value.region, 'greenfold');
});

test('I1-A snapshot roundtrip preserves stable caller-supplied evidence and claim identities', () => {
  const store = new KnowledgeStore();
  store.recordEvidence(rumorEvidence());
  store.recordClaim(rumorClaim());
  const snapshot = store.snapshot();
  const restored = KnowledgeStore.fromSnapshot(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.equal(restored.evidence('evidence:rumor:relay')?.id, 'evidence:rumor:relay');
  assert.equal(restored.claim('claim:relay:location:rumor')?.id, 'claim:relay:location:rumor');
});

test('I1-A validation rejects invalid confidence and backwards knowledge timestamps', () => {
  const store = new KnowledgeStore();
  store.recordEvidence(rumorEvidence());
  assert.throws(() => store.recordClaim({ ...rumorClaim(), confidence: 1.01 }), /confidence/);
  assert.throws(() => store.recordClaim({ ...rumorClaim(), id: 'claim:bad-time', firstKnownAt: 20, lastUpdatedAt: 19 }), /cannot precede/);
});

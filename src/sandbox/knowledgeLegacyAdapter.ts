import type { KnowledgeRecord } from '../worldbridge/contract.js';
import { KnowledgeStore, type EvidenceRecordV2, type KnowledgeClaimV2, type KnowledgeSourceKind, type KnowledgeStoreSnapshotV1 } from './knowledgeStore.js';
import type { KnowledgeEntry, SandboxGameState } from './types.js';

const shadowStores = new WeakMap<SandboxGameState, KnowledgeStore>();

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function providerKnowledgeById(state: SandboxGameState): Map<string, KnowledgeRecord> {
  return new Map(state.world.providerSnapshot.knowledge.map((record) => [record.id, record]));
}

function sourceKindFor(entry: KnowledgeEntry): KnowledgeSourceKind {
  if (entry.physicalEvidenceSourceEntityId) return 'artifact';
  if (entry.sourceKnowledgeId) return 'derived';
  if (entry.sourceWorldKnowledgeId) return 'institutional-report';
  if (entry.carrier === 'oral') return 'conversation';
  if (entry.carrier === 'record' || entry.carrier === 'institution') return 'institutional-report';
  return 'direct-observation';
}

function provenanceText(entry: KnowledgeEntry, providerRecord?: KnowledgeRecord): string {
  const pieces = [
    `Legacy KnowledgeEntry ${entry.id}`,
    `carrier=${entry.carrier}`,
    `${entry.truthLinkIds.length} causal/provenance link${entry.truthLinkIds.length === 1 ? '' : 's'} retained only by legacy state`,
  ];
  if (entry.sourceWorldKnowledgeId) pieces.push('origin=WorldProvider knowledge projection (not hidden World Truth)');
  if (providerRecord) pieces.push(`provider-holder=${providerRecord.holderId}`);
  if (entry.sourceKnowledgeId) pieces.push('origin=derived from prior local knowledge');
  if (entry.physicalEvidenceSourceEntityId) pieces.push('origin=physical evidence source');
  return pieces.join('; ');
}

function legacyEvidence(entry: KnowledgeEntry, providerRecord?: KnowledgeRecord): EvidenceRecordV2 {
  const evidence: EvidenceRecordV2 = {
    id: `legacy-evidence:${entry.id}`,
    observedAt: entry.acquiredDay,
    sourceKind: sourceKindFor(entry),
    observerIds: unique(entry.holderIds),
    provenanceText: provenanceText(entry, providerRecord),
  };
  if (entry.physicalEvidenceSourceEntityId) evidence.sourceEntityId = entry.physicalEvidenceSourceEntityId;
  return evidence;
}

function legacyClaims(state: SandboxGameState, entry: KnowledgeEntry): KnowledgeClaimV2[] {
  const institutional = state.settlement.localKnowledgeIds.includes(entry.id);
  const subjects = unique(entry.subjectIds);
  const normalizedSubjects = subjects.length ? subjects : [`legacy-knowledge:${entry.id}`];
  return normalizedSubjects.map((subjectId, index) => ({
    id: `legacy-claim:${entry.id}:${index + 1}`,
    subjectId,
    predicate: 'legacy-claim',
    value: {
      text: entry.claim,
      legacyKnowledgeId: entry.id,
      carrier: entry.carrier,
      sourceKind: sourceKindFor(entry),
    },
    confidence: entry.confidence,
    knownBy: unique(entry.holderIds),
    institutional,
    evidenceIds: [`legacy-evidence:${entry.id}`],
    firstKnownAt: entry.acquiredDay,
    lastUpdatedAt: entry.acquiredDay,
    ...(entry.lost ? { stale: true } : {}),
  }));
}

/**
 * I1-B compatibility adapter. Rebuilds a read-only V2 shadow projection from the current legacy
 * KnowledgeEntry / settlement.localKnowledgeIds state. It never mutates legacy knowledge, F3,
 * map projection, or WorldProvider state.
 */
export function buildLegacyKnowledgeShadow(state: SandboxGameState): KnowledgeStore {
  const store = new KnowledgeStore();
  const providerRecords = providerKnowledgeById(state);
  for (const entry of state.knowledge) {
    const providerRecord = entry.sourceWorldKnowledgeId ? providerRecords.get(entry.sourceWorldKnowledgeId) : undefined;
    store.recordEvidence(legacyEvidence(entry, providerRecord));
    for (const claim of legacyClaims(state, entry)) store.recordClaim(claim);
  }
  return store;
}

/** Shadow-write synchronization. I1-E persists the same sidecar snapshot inside the save state. */
export function syncLegacyKnowledgeShadow(state: SandboxGameState): KnowledgeStoreSnapshotV1 {
  const store = buildLegacyKnowledgeShadow(state);
  const snapshot = store.snapshot();
  shadowStores.set(state, store);
  state.knowledgeStore = snapshot;
  return structuredClone(snapshot);
}

export interface LegacyKnowledgeRestoreResult {
  snapshot: KnowledgeStoreSnapshotV1;
  migrated: boolean;
  reconciled: boolean;
  source: 'persisted' | 'legacy-rebuilt' | 'legacy-reconciled';
}

function canonicalSnapshot(snapshot: KnowledgeStoreSnapshotV1): KnowledgeStoreSnapshotV1 {
  return KnowledgeStore.fromSnapshot(snapshot).snapshot();
}

function snapshotFingerprint(snapshot: KnowledgeStoreSnapshotV1): string {
  return JSON.stringify(snapshot);
}

/**
 * Restores the persisted I1-E sidecar when present. Legacy schemaVersion=1 saves that lack the
 * optional field are deterministically migrated from their existing KnowledgeEntry/Archive state.
 * While legacy knowledge remains the mutation authority, a persisted sidecar that disagrees with
 * the legacy state is rejected rather than silently trusting either representation.
 */
export function restoreLegacyKnowledgeShadow(state: SandboxGameState): LegacyKnowledgeRestoreResult {
  const rebuiltStore = buildLegacyKnowledgeShadow(state);
  const rebuilt = rebuiltStore.snapshot();
  if (state.knowledgeStore === undefined) {
    state.knowledgeStore = rebuilt;
    shadowStores.set(state, rebuiltStore);
    return { snapshot: structuredClone(rebuilt), migrated: true, reconciled: false, source: 'legacy-rebuilt' };
  }
  const persisted = canonicalSnapshot(state.knowledgeStore);
  if (snapshotFingerprint(persisted) !== snapshotFingerprint(rebuilt)) {
    // During I1-E legacy KnowledgeEntry remains the mutation authority. A structurally valid but stale
    // sidecar can exist in direct JSON/debug snapshots that did not pass through repository.save/export.
    // Reconcile deterministically from legacy rather than allowing epistemic split-brain state.
    state.knowledgeStore = rebuilt;
    shadowStores.set(state, rebuiltStore);
    return { snapshot: structuredClone(rebuilt), migrated: false, reconciled: true, source: 'legacy-reconciled' };
  }
  state.knowledgeStore = persisted;
  shadowStores.set(state, KnowledgeStore.fromSnapshot(persisted));
  return { snapshot: structuredClone(persisted), migrated: false, reconciled: false, source: 'persisted' };
}

/** Returns the latest sidecar snapshot, restoring persisted state before falling back to migration. */
export function legacyKnowledgeShadowSnapshot(state: SandboxGameState): KnowledgeStoreSnapshotV1 {
  const existing = shadowStores.get(state);
  if (existing) return existing.snapshot();
  return restoreLegacyKnowledgeShadow(state).snapshot;
}

/** Test/diagnostic helper: true when this in-memory state has an attached/restored sidecar. */
export function hasLegacyKnowledgeShadow(state: SandboxGameState): boolean {
  return shadowStores.has(state);
}

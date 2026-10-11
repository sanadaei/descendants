export type KnowledgeSourceKind =
  | 'direct-observation'
  | 'conversation'
  | 'artifact'
  | 'rumor'
  | 'institutional-report'
  | 'expedition-report'
  | 'derived';

export interface EvidenceRecordV2 {
  id: string;
  observedAt: number;
  sourceKind: KnowledgeSourceKind;
  sourceEntityId?: string;
  observerIds: string[];
  provenanceText: string;
}

export interface KnowledgeClaimV2 {
  id: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  confidence: number;
  knownBy: string[];
  institutional: boolean;
  evidenceIds: string[];
  firstKnownAt: number;
  lastUpdatedAt: number;
  supersedes?: string[];
  stale?: boolean;
}

export interface KnowledgeStoreSnapshotV1 {
  schema: 'descendants-knowledge-store-v1';
  evidence: EvidenceRecordV2[];
  claims: KnowledgeClaimV2[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireId(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be non-empty.`);
}

function requireFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function requireConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Knowledge confidence must be a finite value from 0 through 1.');
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeEvidence(input: EvidenceRecordV2): EvidenceRecordV2 {
  requireId(input.id, 'Evidence id');
  requireFiniteTime(input.observedAt, 'Evidence observedAt');
  if (!input.provenanceText.trim()) throw new Error('Evidence provenanceText must be non-empty.');
  const observerIds = unique(input.observerIds);
  const normalized: EvidenceRecordV2 = {
    id: input.id,
    observedAt: input.observedAt,
    sourceKind: input.sourceKind,
    observerIds,
    provenanceText: input.provenanceText,
  };
  if (input.sourceEntityId !== undefined) normalized.sourceEntityId = input.sourceEntityId;
  return normalized;
}

function normalizeClaim(input: KnowledgeClaimV2): KnowledgeClaimV2 {
  requireId(input.id, 'Knowledge claim id');
  requireId(input.subjectId, 'Knowledge claim subjectId');
  requireId(input.predicate, 'Knowledge claim predicate');
  requireFiniteTime(input.firstKnownAt, 'Knowledge claim firstKnownAt');
  requireFiniteTime(input.lastUpdatedAt, 'Knowledge claim lastUpdatedAt');
  if (input.lastUpdatedAt < input.firstKnownAt) throw new Error('Knowledge claim lastUpdatedAt cannot precede firstKnownAt.');
  requireConfidence(input.confidence);
  const normalized: KnowledgeClaimV2 = {
    id: input.id,
    subjectId: input.subjectId,
    predicate: input.predicate,
    value: clone(input.value),
    confidence: input.confidence,
    knownBy: unique(input.knownBy),
    institutional: input.institutional,
    evidenceIds: unique(input.evidenceIds),
    firstKnownAt: input.firstKnownAt,
    lastUpdatedAt: input.lastUpdatedAt,
  };
  if (input.supersedes !== undefined) normalized.supersedes = unique(input.supersedes);
  if (input.stale !== undefined) normalized.stale = input.stale;
  return normalized;
}

export class KnowledgeStore {
  readonly #evidence = new Map<string, EvidenceRecordV2>();
  readonly #claims = new Map<string, KnowledgeClaimV2>();

  static fromSnapshot(snapshot: KnowledgeStoreSnapshotV1): KnowledgeStore {
    if (snapshot.schema !== 'descendants-knowledge-store-v1') {
      throw new Error(`Unsupported knowledge-store schema: ${String(snapshot.schema)}`);
    }
    const store = new KnowledgeStore();
    for (const evidence of snapshot.evidence) store.recordEvidence(evidence);
    for (const claim of snapshot.claims) store.recordClaim(claim);
    return store;
  }

  recordEvidence(input: EvidenceRecordV2): EvidenceRecordV2 {
    const evidence = normalizeEvidence(input);
    if (this.#evidence.has(evidence.id)) throw new Error(`Duplicate evidence id: ${evidence.id}`);
    this.#evidence.set(evidence.id, evidence);
    return clone(evidence);
  }

  recordClaim(input: KnowledgeClaimV2): KnowledgeClaimV2 {
    const claim = normalizeClaim(input);
    if (this.#claims.has(claim.id)) throw new Error(`Duplicate knowledge claim id: ${claim.id}`);
    for (const evidenceId of claim.evidenceIds) {
      if (!this.#evidence.has(evidenceId)) throw new Error(`Knowledge claim ${claim.id} references missing evidence ${evidenceId}.`);
    }
    for (const supersededId of claim.supersedes ?? []) {
      if (!this.#claims.has(supersededId)) throw new Error(`Knowledge claim ${claim.id} supersedes missing claim ${supersededId}.`);
    }
    this.#claims.set(claim.id, claim);
    return clone(claim);
  }

  evidence(id: string): EvidenceRecordV2 | null {
    const value = this.#evidence.get(id);
    return value ? clone(value) : null;
  }

  claim(id: string): KnowledgeClaimV2 | null {
    const value = this.#claims.get(id);
    return value ? clone(value) : null;
  }

  claimsKnownBy(personId: string): KnowledgeClaimV2[] {
    return [...this.#claims.values()].filter((claim) => claim.knownBy.includes(personId)).map(clone);
  }

  institutionalClaims(): KnowledgeClaimV2[] {
    return [...this.#claims.values()].filter((claim) => claim.institutional).map(clone);
  }

  claimsForSubject(subjectId: string): KnowledgeClaimV2[] {
    return [...this.#claims.values()].filter((claim) => claim.subjectId === subjectId).map(clone);
  }

  evidenceForClaim(claimId: string): EvidenceRecordV2[] {
    const claim = this.#claims.get(claimId);
    if (!claim) return [];
    return claim.evidenceIds.map((id) => this.#evidence.get(id)).filter((entry): entry is EvidenceRecordV2 => entry !== undefined).map(clone);
  }

  supersedeClaim(oldClaimId: string, newClaimId: string): void {
    const oldClaim = this.#claims.get(oldClaimId);
    const newClaim = this.#claims.get(newClaimId);
    if (!oldClaim) throw new Error(`Missing old knowledge claim: ${oldClaimId}`);
    if (!newClaim) throw new Error(`Missing new knowledge claim: ${newClaimId}`);
    oldClaim.stale = true;
    newClaim.supersedes = unique([...(newClaim.supersedes ?? []), oldClaimId]);
  }

  markClaimStale(claimId: string): void {
    const claim = this.#claims.get(claimId);
    if (!claim) throw new Error(`Missing knowledge claim: ${claimId}`);
    claim.stale = true;
  }

  snapshot(): KnowledgeStoreSnapshotV1 {
    return {
      schema: 'descendants-knowledge-store-v1',
      evidence: [...this.#evidence.values()].map(clone),
      claims: [...this.#claims.values()].map(clone),
    };
  }
}

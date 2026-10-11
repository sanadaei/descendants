import type { KnowledgeCarrier, KnowledgeEntry, SandboxGameState } from './types.js';
import { legacyKnowledgeShadowSnapshot } from './knowledgeLegacyAdapter.js';
import type { KnowledgeClaimV2, KnowledgeSourceKind, KnowledgeStoreSnapshotV1 } from './knowledgeStore.js';

export const I1C_F3_COMPARE_STORAGE_KEY = 'descendants.i1c.f3-compare.v1';
export const I1C_F3_READ_STORAGE_KEY = 'descendants.i1c.f3-read-v2.v1';

export interface F3KnowledgeProjectionRow {
  legacyKnowledgeId: string;
  claim: string;
  confidence: number;
  subjectIds: string[];
  carrier: KnowledgeCarrier;
  lost: boolean;
  knownBy: string[];
  institutional: boolean;
  provenance: {
    sourceKind: KnowledgeSourceKind;
    observerIds: string[];
    sourceEntityId?: string;
    providerProjection: boolean;
    derivedFromPriorKnowledge: boolean;
    physicalEvidence: boolean;
    truthLinkCount: number;
  };
}

export interface F3KnowledgeProjection {
  holderId: string | null;
  personal: F3KnowledgeProjectionRow[];
  institutional: F3KnowledgeProjectionRow[];
}

export type F3ProjectionMismatchField =
  | 'personal-count'
  | 'institutional-count'
  | 'personal-order'
  | 'institutional-order'
  | 'missing-shadow-row'
  | 'unexpected-shadow-row'
  | 'claim-text'
  | 'confidence'
  | 'subject-ids'
  | 'carrier'
  | 'lost-state'
  | 'known-by'
  | 'institutional-scope'
  | 'provenance-source-kind'
  | 'provenance-observers'
  | 'provenance-source-entity'
  | 'provenance-provider-projection'
  | 'provenance-derived-source'
  | 'provenance-physical-evidence'
  | 'provenance-truth-link-count'
  | 'shadow-internal-consistency';

export interface F3ProjectionMismatch {
  field: F3ProjectionMismatchField;
  legacyKnowledgeId?: string;
  legacy: unknown;
  shadow: unknown;
}

export interface F3ProjectionComparison {
  enabled: true;
  equal: boolean;
  holderId: string | null;
  legacyCounts: { personal: number; institutional: number };
  shadowCounts: { personal: number; institutional: number };
  mismatches: F3ProjectionMismatch[];
}

type LegacyClaimValue = {
  text: string;
  legacyKnowledgeId: string;
  carrier: KnowledgeCarrier;
  sourceKind: KnowledgeSourceKind;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(unique(left))) === JSON.stringify(sorted(unique(right)));
}

function sourceKindForLegacy(entry: KnowledgeEntry): KnowledgeSourceKind {
  if (entry.physicalEvidenceSourceEntityId) return 'artifact';
  if (entry.sourceKnowledgeId) return 'derived';
  if (entry.sourceWorldKnowledgeId) return 'institutional-report';
  if (entry.carrier === 'oral') return 'conversation';
  if (entry.carrier === 'record' || entry.carrier === 'institution') return 'institutional-report';
  return 'direct-observation';
}

function legacyRow(state: SandboxGameState, entry: KnowledgeEntry): F3KnowledgeProjectionRow {
  return {
    legacyKnowledgeId: entry.id,
    claim: entry.claim,
    confidence: entry.confidence,
    subjectIds: [...entry.subjectIds],
    carrier: entry.carrier,
    lost: entry.lost,
    knownBy: unique(entry.holderIds),
    institutional: state.settlement.localKnowledgeIds.includes(entry.id),
    provenance: {
      sourceKind: sourceKindForLegacy(entry),
      observerIds: unique(entry.holderIds),
      ...(entry.physicalEvidenceSourceEntityId ? { sourceEntityId: entry.physicalEvidenceSourceEntityId } : {}),
      providerProjection: Boolean(entry.sourceWorldKnowledgeId),
      derivedFromPriorKnowledge: Boolean(entry.sourceKnowledgeId),
      physicalEvidence: Boolean(entry.physicalEvidenceSourceEntityId),
      truthLinkCount: entry.truthLinkIds.length,
    },
  };
}

/** Exact legacy F3 access semantics. This remains the player-facing authority during I1-C. */
export function buildLegacyF3Projection(state: SandboxGameState, holderId: string | null): F3KnowledgeProjection {
  const holder = holderId ? state.agents.find((agent) => agent.id === holderId) : undefined;
  const personal = holder ? state.knowledge.filter((entry) => holder.knowledgeIds.includes(entry.id)) : [];
  const personalIds = new Set(personal.map((entry) => entry.id));
  const institutionalIds = new Set(state.settlement.localKnowledgeIds);
  const institutional = state.knowledge.filter((entry) => institutionalIds.has(entry.id) && !personalIds.has(entry.id));
  return {
    holderId,
    personal: personal.map((entry) => legacyRow(state, entry)),
    institutional: institutional.map((entry) => legacyRow(state, entry)),
  };
}

function legacyValue(claim: KnowledgeClaimV2): LegacyClaimValue | null {
  if (!claim.value || typeof claim.value !== 'object' || Array.isArray(claim.value)) return null;
  const value = claim.value as Partial<LegacyClaimValue>;
  if (typeof value.text !== 'string' || typeof value.legacyKnowledgeId !== 'string' || typeof value.carrier !== 'string' || typeof value.sourceKind !== 'string') return null;
  if (!['memory', 'oral', 'record', 'institution'].includes(value.carrier)) return null;
  if (!['direct-observation', 'conversation', 'artifact', 'rumor', 'institutional-report', 'expedition-report', 'derived'].includes(value.sourceKind)) return null;
  return value as LegacyClaimValue;
}

function truthLinkCountFromProvenance(text: string): number | null {
  const match = text.match(/(?:^|; )(\d+) causal\/provenance link(?:s)? retained only by legacy state(?:;|$)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function shadowRows(snapshot: KnowledgeStoreSnapshotV1): { rows: F3KnowledgeProjectionRow[]; mismatches: F3ProjectionMismatch[] } {
  const evidenceById = new Map(snapshot.evidence.map((entry) => [entry.id, entry]));
  const grouped = new Map<string, KnowledgeClaimV2[]>();
  const groupOrder: string[] = [];
  const mismatches: F3ProjectionMismatch[] = [];

  for (const claim of snapshot.claims) {
    const value = legacyValue(claim);
    if (!value) {
      mismatches.push({ field: 'shadow-internal-consistency', legacy: 'legacy claim value', shadow: claim.value });
      continue;
    }
    if (!grouped.has(value.legacyKnowledgeId)) {
      grouped.set(value.legacyKnowledgeId, []);
      groupOrder.push(value.legacyKnowledgeId);
    }
    grouped.get(value.legacyKnowledgeId)?.push(claim);
  }

  const rows: F3KnowledgeProjectionRow[] = [];
  for (const legacyKnowledgeId of groupOrder) {
    const claims = grouped.get(legacyKnowledgeId) ?? [];
    const first = claims[0];
    if (!first) continue;
    const firstValue = legacyValue(first);
    if (!firstValue) continue;
    const evidence = evidenceById.get(`legacy-evidence:${legacyKnowledgeId}`);
    const subjectIds = claims.map((claim) => claim.subjectId);
    const confidenceValues = unique(claims.map((claim) => String(claim.confidence)));
    const knownByValues = unique(claims.map((claim) => JSON.stringify(sorted(unique(claim.knownBy)))));
    const institutionalValues = unique(claims.map((claim) => String(claim.institutional)));
    const staleValues = unique(claims.map((claim) => String(claim.stale === true)));
    const textValues = unique(claims.map((claim) => legacyValue(claim)?.text ?? ''));
    const carrierValues = unique(claims.map((claim) => legacyValue(claim)?.carrier ?? ''));
    const sourceKindValues = unique(claims.map((claim) => legacyValue(claim)?.sourceKind ?? ''));
    if ([confidenceValues, knownByValues, institutionalValues, staleValues, textValues, carrierValues, sourceKindValues].some((values) => values.length !== 1)) {
      mismatches.push({
        field: 'shadow-internal-consistency',
        legacyKnowledgeId,
        legacy: 'all per-subject claims agree on shared F3 fields',
        shadow: { confidenceValues, knownByValues, institutionalValues, staleValues, textValues, carrierValues, sourceKindValues },
      });
    }
    if (!evidence) {
      mismatches.push({ field: 'shadow-internal-consistency', legacyKnowledgeId, legacy: `legacy-evidence:${legacyKnowledgeId}`, shadow: null });
    }
    const provenanceText = evidence?.provenanceText ?? '';
    rows.push({
      legacyKnowledgeId,
      claim: firstValue.text,
      confidence: first.confidence,
      subjectIds,
      carrier: firstValue.carrier,
      lost: first.stale === true,
      knownBy: unique(first.knownBy),
      institutional: first.institutional,
      provenance: {
        sourceKind: evidence?.sourceKind ?? firstValue.sourceKind,
        observerIds: unique(evidence?.observerIds ?? first.knownBy),
        ...(evidence?.sourceEntityId ? { sourceEntityId: evidence.sourceEntityId } : {}),
        providerProjection: provenanceText.includes('origin=WorldProvider knowledge projection (not hidden World Truth)'),
        derivedFromPriorKnowledge: provenanceText.includes('origin=derived from prior local knowledge'),
        physicalEvidence: provenanceText.includes('origin=physical evidence source'),
        truthLinkCount: truthLinkCountFromProvenance(provenanceText) ?? -1,
      },
    });
  }
  return { rows, mismatches };
}

/** V2 sidecar projection of the same F3 personal/institutional access semantics. */
export function buildShadowF3Projection(state: SandboxGameState, holderId: string | null): { projection: F3KnowledgeProjection; mismatches: F3ProjectionMismatch[] } {
  const { rows, mismatches } = shadowRows(legacyKnowledgeShadowSnapshot(state));
  const personal = holderId ? rows.filter((row) => row.knownBy.includes(holderId)) : [];
  const personalIds = new Set(personal.map((row) => row.legacyKnowledgeId));
  const institutional = rows.filter((row) => row.institutional && !personalIds.has(row.legacyKnowledgeId));
  return { projection: { holderId, personal, institutional }, mismatches };
}

function compareScalar(
  mismatches: F3ProjectionMismatch[],
  field: F3ProjectionMismatchField,
  legacyKnowledgeId: string,
  legacy: unknown,
  shadow: unknown,
): void {
  if (JSON.stringify(legacy) !== JSON.stringify(shadow)) mismatches.push({ field, legacyKnowledgeId, legacy, shadow });
}

function compareRow(mismatches: F3ProjectionMismatch[], legacy: F3KnowledgeProjectionRow, shadow: F3KnowledgeProjectionRow): void {
  const id = legacy.legacyKnowledgeId;
  compareScalar(mismatches, 'claim-text', id, legacy.claim, shadow.claim);
  compareScalar(mismatches, 'confidence', id, legacy.confidence, shadow.confidence);
  compareScalar(mismatches, 'subject-ids', id, legacy.subjectIds, shadow.subjectIds);
  compareScalar(mismatches, 'carrier', id, legacy.carrier, shadow.carrier);
  compareScalar(mismatches, 'lost-state', id, legacy.lost, shadow.lost);
  compareScalar(mismatches, 'known-by', id, sorted(unique(legacy.knownBy)), sorted(unique(shadow.knownBy)));
  compareScalar(mismatches, 'institutional-scope', id, legacy.institutional, shadow.institutional);
  compareScalar(mismatches, 'provenance-source-kind', id, legacy.provenance.sourceKind, shadow.provenance.sourceKind);
  compareScalar(mismatches, 'provenance-observers', id, sorted(unique(legacy.provenance.observerIds)), sorted(unique(shadow.provenance.observerIds)));
  compareScalar(mismatches, 'provenance-source-entity', id, legacy.provenance.sourceEntityId ?? null, shadow.provenance.sourceEntityId ?? null);
  compareScalar(mismatches, 'provenance-provider-projection', id, legacy.provenance.providerProjection, shadow.provenance.providerProjection);
  compareScalar(mismatches, 'provenance-derived-source', id, legacy.provenance.derivedFromPriorKnowledge, shadow.provenance.derivedFromPriorKnowledge);
  compareScalar(mismatches, 'provenance-physical-evidence', id, legacy.provenance.physicalEvidence, shadow.provenance.physicalEvidence);
  compareScalar(mismatches, 'provenance-truth-link-count', id, legacy.provenance.truthLinkCount, shadow.provenance.truthLinkCount);
}

function compareSection(
  mismatches: F3ProjectionMismatch[],
  section: 'personal' | 'institutional',
  legacyRows: F3KnowledgeProjectionRow[],
  shadowRowsValue: F3KnowledgeProjectionRow[],
): void {
  const countField = section === 'personal' ? 'personal-count' : 'institutional-count';
  const orderField = section === 'personal' ? 'personal-order' : 'institutional-order';
  if (legacyRows.length !== shadowRowsValue.length) mismatches.push({ field: countField, legacy: legacyRows.length, shadow: shadowRowsValue.length });
  const legacyOrder = legacyRows.map((row) => row.legacyKnowledgeId);
  const shadowOrder = shadowRowsValue.map((row) => row.legacyKnowledgeId);
  if (JSON.stringify(legacyOrder) !== JSON.stringify(shadowOrder)) mismatches.push({ field: orderField, legacy: legacyOrder, shadow: shadowOrder });

  const shadowById = new Map(shadowRowsValue.map((row) => [row.legacyKnowledgeId, row]));
  for (const legacy of legacyRows) {
    const shadow = shadowById.get(legacy.legacyKnowledgeId);
    if (!shadow) {
      mismatches.push({ field: 'missing-shadow-row', legacyKnowledgeId: legacy.legacyKnowledgeId, legacy, shadow: null });
      continue;
    }
    compareRow(mismatches, legacy, shadow);
  }
  const legacyIds = new Set(legacyRows.map((row) => row.legacyKnowledgeId));
  for (const shadow of shadowRowsValue) {
    if (!legacyIds.has(shadow.legacyKnowledgeId)) mismatches.push({ field: 'unexpected-shadow-row', legacyKnowledgeId: shadow.legacyKnowledgeId, legacy: null, shadow });
  }
}

/** Machine comparison only. It does not choose the rendering authority. */
export function compareF3KnowledgeProjections(state: SandboxGameState, holderId: string | null): F3ProjectionComparison {
  const legacy = buildLegacyF3Projection(state, holderId);
  const shadowResult = buildShadowF3Projection(state, holderId);
  const shadow = shadowResult.projection;
  const mismatches = [...shadowResult.mismatches];
  compareSection(mismatches, 'personal', legacy.personal, shadow.personal);
  compareSection(mismatches, 'institutional', legacy.institutional, shadow.institutional);
  return {
    enabled: true,
    equal: mismatches.length === 0,
    holderId,
    legacyCounts: { personal: legacy.personal.length, institutional: legacy.institutional.length },
    shadowCounts: { personal: shadow.personal.length, institutional: shadow.institutional.length },
    mismatches,
  };
}

export function isI1CF3CompareModeEnabled(): boolean {
  try {
    return typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.getItem(I1C_F3_COMPARE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * I1-C feature-gated diagnostic hook. Default OFF. When enabled it compares both projections and
 * reports only to the browser console; the caller continues to render the legacy F3 projection.
 */
export function compareF3KnowledgeProjectionsIfEnabled(
  state: SandboxGameState,
  holderId: string | null,
  enabled = isI1CF3CompareModeEnabled(),
): F3ProjectionComparison | null {
  if (!enabled) return null;
  const result = compareF3KnowledgeProjections(state, holderId);
  if (!result.equal) console.warn('[Descendants I1-C] F3 legacy/shadow projection mismatch', result);
  return result;
}


export interface F3KnowledgeReadModel {
  source: 'legacy' | 'shadow';
  holderId: string | null;
  personal: KnowledgeEntry[];
  institutional: KnowledgeEntry[];
  comparison: F3ProjectionComparison;
  renderIdentityEqual: boolean;
  fallbackReason?: 'projection-mismatch' | 'render-identity-mismatch';
}

const F3_RENDER_IDENTITY_FIELDS = [
  'id', 'subjectIds', 'claim', 'confidence', 'carrier', 'holderIds', 'sourceKnowledgeId',
  'sourceWorldKnowledgeId', 'truthLinkIds', 'lost', 'physicalEvidenceSourceEntityId',
  'requiresPhysicalSample',
] as const satisfies readonly (keyof KnowledgeEntry)[];

function readIdentity(entry: KnowledgeEntry): unknown[] {
  return F3_RENDER_IDENTITY_FIELDS.map((field) => structuredClone(entry[field]));
}

function materializeShadowEntry(state: SandboxGameState, row: F3KnowledgeProjectionRow): KnowledgeEntry | null {
  const legacy = state.knowledge.find((entry) => entry.id === row.legacyKnowledgeId);
  if (!legacy) return null;
  // I1-C read candidate: V2 owns the epistemic/read fields; legacy-only action/provenance
  // compatibility fields stay attached until I1-E save/schema migration can carry them natively.
  return {
    ...structuredClone(legacy),
    id: row.legacyKnowledgeId,
    subjectIds: [...row.subjectIds],
    claim: row.claim,
    confidence: row.confidence,
    carrier: row.carrier,
    holderIds: [...row.knownBy],
    lost: row.lost,
  };
}

function materializeShadowSection(state: SandboxGameState, rows: F3KnowledgeProjectionRow[]): KnowledgeEntry[] | null {
  const entries: KnowledgeEntry[] = [];
  for (const row of rows) {
    const entry = materializeShadowEntry(state, row);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}

function legacyEntriesForProjection(state: SandboxGameState, projection: F3KnowledgeProjection): { personal: KnowledgeEntry[]; institutional: KnowledgeEntry[] } {
  const byId = new Map(state.knowledge.map((entry) => [entry.id, entry]));
  const personal = projection.personal.map((row) => byId.get(row.legacyKnowledgeId)).filter((entry): entry is KnowledgeEntry => Boolean(entry));
  const institutional = projection.institutional.map((row) => byId.get(row.legacyKnowledgeId)).filter((entry): entry is KnowledgeEntry => Boolean(entry));
  return { personal, institutional };
}

function sameReadIdentity(left: readonly KnowledgeEntry[], right: readonly KnowledgeEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (JSON.stringify(readIdentity(left[i]!)) !== JSON.stringify(readIdentity(right[i]!))) return false;
  }
  return true;
}

export function isI1CF3ReadSwitchEnabled(): boolean {
  try {
    return typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.getItem(I1C_F3_READ_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * I1-C read-switch candidate. Default OFF. When enabled, KnowledgeStore projection supplies the
 * F3 row membership/order and epistemic fields. Legacy-only compatibility metadata is retained on
 * the materialized rows so existing conversation/archive/research/anomaly actions keep their IDs
 * and behavior. Any projection or render/action identity mismatch fails closed to the legacy read.
 */
export function selectF3KnowledgeReadModel(
  state: SandboxGameState,
  holderId: string | null,
  enabled = isI1CF3ReadSwitchEnabled(),
): F3KnowledgeReadModel {
  const legacyProjection = buildLegacyF3Projection(state, holderId);
  const legacyEntries = legacyEntriesForProjection(state, legacyProjection);
  const comparison = compareF3KnowledgeProjections(state, holderId);
  if (!enabled) {
    return {
      source: 'legacy', holderId, personal: legacyEntries.personal, institutional: legacyEntries.institutional,
      comparison, renderIdentityEqual: true,
    };
  }
  if (!comparison.equal) {
    console.warn('[Descendants I1-C read] projection mismatch; falling back to legacy F3 read', comparison);
    return {
      source: 'legacy', holderId, personal: legacyEntries.personal, institutional: legacyEntries.institutional,
      comparison, renderIdentityEqual: false, fallbackReason: 'projection-mismatch',
    };
  }
  const shadow = buildShadowF3Projection(state, holderId).projection;
  const shadowPersonal = materializeShadowSection(state, shadow.personal);
  const shadowInstitutional = materializeShadowSection(state, shadow.institutional);
  if (!shadowPersonal || !shadowInstitutional) {
    console.warn('[Descendants I1-C read] shadow materialization mismatch; falling back to legacy F3 read');
    return {
      source: 'legacy', holderId, personal: legacyEntries.personal, institutional: legacyEntries.institutional,
      comparison, renderIdentityEqual: false, fallbackReason: 'render-identity-mismatch',
    };
  }
  const renderIdentityEqual = sameReadIdentity(legacyEntries.personal, shadowPersonal)
    && sameReadIdentity(legacyEntries.institutional, shadowInstitutional);
  if (!renderIdentityEqual) {
    console.warn('[Descendants I1-C read] render/action identity mismatch; falling back to legacy F3 read');
    return {
      source: 'legacy', holderId, personal: legacyEntries.personal, institutional: legacyEntries.institutional,
      comparison, renderIdentityEqual: false, fallbackReason: 'render-identity-mismatch',
    };
  }
  return {
    source: 'shadow', holderId, personal: shadowPersonal, institutional: shadowInstitutional,
    comparison, renderIdentityEqual: true,
  };
}

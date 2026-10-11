import type { AreaProjection, WorldEntity } from '../worldbridge/contract.js';
import { legacyKnowledgeShadowSnapshot } from './knowledgeLegacyAdapter.js';
import type { KnowledgeClaimV2, KnowledgeStoreSnapshotV1 } from './knowledgeStore.js';
import type { SandboxGameState } from './types.js';

export const I1D_WORLD_COMPARE_STORAGE_KEY = 'descendants.i1d.world-compare.v1';
export const I1D_WORLD_READ_STORAGE_KEY = 'descendants.i1d.world-read-v2.v1';

export type WorldKnowledgeBasisKind = 'origin' | 'personal-claim' | 'institutional-claim' | 'known-external-actor';

export interface WorldKnowledgeBasis {
  kind: WorldKnowledgeBasisKind;
  id: string;
}

export interface WorldGraphProjectionRow {
  entityId: string;
  marker: boolean;
  targetable: boolean;
  basis: WorldKnowledgeBasis[];
}

export interface WorldGraphProjection {
  observerId: string;
  observerExpeditionId: string | null;
  entityIds: string[];
  markerIds: string[];
  targetableEntityIds: string[];
  rows: WorldGraphProjectionRow[];
}

export type WorldGraphMismatchField =
  | 'entity-count'
  | 'entity-order'
  | 'marker-count'
  | 'marker-order'
  | 'target-count'
  | 'target-order'
  | 'missing-shadow-entity'
  | 'unexpected-shadow-entity'
  | 'targetability'
  | 'epistemic-basis-missing'
  | 'shadow-internal-consistency';

export interface WorldGraphProjectionMismatch {
  field: WorldGraphMismatchField;
  entityId?: string;
  legacy: unknown;
  shadow: unknown;
}

export interface WorldGraphProjectionComparison {
  enabled: true;
  equal: boolean;
  observerId: string;
  legacyCounts: { entities: number; markers: number; targetable: number };
  shadowCounts: { entities: number; markers: number; targetable: number };
  mismatches: WorldGraphProjectionMismatch[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function observer(state: SandboxGameState, observerId: string) {
  return state.agents.find((agent) => agent.id === observerId) ?? null;
}

function legacyKnownSubjects(state: SandboxGameState, observerId: string): Map<string, WorldKnowledgeBasis[]> {
  const controlled = observer(state, observerId);
  const bases = new Map<string, WorldKnowledgeBasis[]>();
  const add = (subjectId: string, basis: WorldKnowledgeBasis): void => {
    const existing = bases.get(subjectId) ?? [];
    if (!existing.some((entry) => entry.kind === basis.kind && entry.id === basis.id)) existing.push(basis);
    bases.set(subjectId, existing);
  };
  add(state.world.originEntityId, { kind: 'origin', id: state.world.originEntityId });
  if (!controlled) return bases;

  const personalIds = new Set(controlled.knowledgeIds);
  const institutionalIds = new Set(state.settlement.localKnowledgeIds);
  for (const entry of state.knowledge) {
    if (entry.lost) continue;
    const personallyKnown = personalIds.has(entry.id);
    const institutionallyReachable = !controlled.expeditionId && institutionalIds.has(entry.id);
    if (!personallyKnown && !institutionallyReachable) continue;
    for (const subjectId of entry.subjectIds) {
      if (personallyKnown) add(subjectId, { kind: 'personal-claim', id: entry.id });
      if (institutionallyReachable) add(subjectId, { kind: 'institutional-claim', id: entry.id });
    }
  }
  for (const actor of state.externalActors) {
    if (!controlled.expeditionId || bases.has(actor.entityId)) {
      add(actor.entityId, { kind: 'known-external-actor', id: actor.entityId });
    }
  }
  return bases;
}

function legacyClaimKnowledgeId(claim: KnowledgeClaimV2): string {
  if (claim.value && typeof claim.value === 'object' && !Array.isArray(claim.value)) {
    const value = claim.value as Record<string, unknown>;
    if (typeof value.legacyKnowledgeId === 'string' && value.legacyKnowledgeId) return value.legacyKnowledgeId;
  }
  return claim.id;
}

function shadowKnownSubjects(state: SandboxGameState, observerId: string, snapshot: KnowledgeStoreSnapshotV1): Map<string, WorldKnowledgeBasis[]> {
  const controlled = observer(state, observerId);
  const bases = new Map<string, WorldKnowledgeBasis[]>();
  const add = (subjectId: string, basis: WorldKnowledgeBasis): void => {
    const existing = bases.get(subjectId) ?? [];
    if (!existing.some((entry) => entry.kind === basis.kind && entry.id === basis.id)) existing.push(basis);
    bases.set(subjectId, existing);
  };
  add(state.world.originEntityId, { kind: 'origin', id: state.world.originEntityId });
  if (!controlled) return bases;

  for (const claim of snapshot.claims) {
    if (claim.stale === true) continue;
    const personallyKnown = claim.knownBy.includes(observerId);
    const institutionallyReachable = !controlled.expeditionId && claim.institutional;
    if (!personallyKnown && !institutionallyReachable) continue;
    const knowledgeId = legacyClaimKnowledgeId(claim);
    if (personallyKnown) add(claim.subjectId, { kind: 'personal-claim', id: knowledgeId });
    if (institutionallyReachable) add(claim.subjectId, { kind: 'institutional-claim', id: knowledgeId });
  }
  for (const actor of state.externalActors) {
    if (!controlled.expeditionId || bases.has(actor.entityId)) {
      add(actor.entityId, { kind: 'known-external-actor', id: actor.entityId });
    }
  }
  return bases;
}

function project(area: AreaProjection, state: SandboxGameState, observerId: string, bases: Map<string, WorldKnowledgeBasis[]>): WorldGraphProjection {
  const entities = area.entities.filter((entry) => bases.has(entry.id));
  const origin = state.world.originEntityId;
  const rows = entities.map((entry): WorldGraphProjectionRow => ({
    entityId: entry.id,
    marker: entry.id !== origin,
    targetable: entry.id !== origin && Boolean(entry.spatial),
    basis: structuredClone(bases.get(entry.id) ?? []),
  }));
  const controlled = observer(state, observerId);
  return {
    observerId,
    observerExpeditionId: controlled?.expeditionId ?? null,
    entityIds: rows.map((row) => row.entityId),
    markerIds: rows.filter((row) => row.marker).map((row) => row.entityId),
    targetableEntityIds: rows.filter((row) => row.targetable).map((row) => row.entityId),
    rows,
  };
}

/** Exact I1-D legacy WORLD membership semantics extracted from SandboxApp.visibleWorldEntities(). */
export function buildLegacyWorldGraphProjection(state: SandboxGameState, observerId: string, area: AreaProjection): WorldGraphProjection {
  return project(area, state, observerId, legacyKnownSubjects(state, observerId));
}

/** KnowledgeStore-derived WORLD membership projection. Does not mutate provider, legacy knowledge, or UI state. */
export function buildShadowWorldGraphProjection(state: SandboxGameState, observerId: string, area: AreaProjection): WorldGraphProjection {
  return project(area, state, observerId, shadowKnownSubjects(state, observerId, legacyKnowledgeShadowSnapshot(state)));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function basisIsValid(row: WorldGraphProjectionRow): boolean {
  return row.basis.length > 0 && row.basis.every((basis) => basis.kind === 'origin' || basis.kind === 'personal-claim' || basis.kind === 'institutional-claim' || basis.kind === 'known-external-actor');
}

export function compareWorldGraphProjections(state: SandboxGameState, observerId: string, area: AreaProjection): WorldGraphProjectionComparison {
  const legacy = buildLegacyWorldGraphProjection(state, observerId, area);
  const shadow = buildShadowWorldGraphProjection(state, observerId, area);
  const mismatches: WorldGraphProjectionMismatch[] = [];

  if (legacy.entityIds.length !== shadow.entityIds.length) mismatches.push({ field: 'entity-count', legacy: legacy.entityIds.length, shadow: shadow.entityIds.length });
  if (!sameIds(legacy.entityIds, shadow.entityIds)) mismatches.push({ field: 'entity-order', legacy: legacy.entityIds, shadow: shadow.entityIds });
  if (legacy.markerIds.length !== shadow.markerIds.length) mismatches.push({ field: 'marker-count', legacy: legacy.markerIds.length, shadow: shadow.markerIds.length });
  if (!sameIds(legacy.markerIds, shadow.markerIds)) mismatches.push({ field: 'marker-order', legacy: legacy.markerIds, shadow: shadow.markerIds });
  if (legacy.targetableEntityIds.length !== shadow.targetableEntityIds.length) mismatches.push({ field: 'target-count', legacy: legacy.targetableEntityIds.length, shadow: shadow.targetableEntityIds.length });
  if (!sameIds(legacy.targetableEntityIds, shadow.targetableEntityIds)) mismatches.push({ field: 'target-order', legacy: legacy.targetableEntityIds, shadow: shadow.targetableEntityIds });

  const shadowById = new Map(shadow.rows.map((row) => [row.entityId, row]));
  const legacyById = new Map(legacy.rows.map((row) => [row.entityId, row]));
  for (const row of legacy.rows) {
    const counterpart = shadowById.get(row.entityId);
    if (!counterpart) {
      mismatches.push({ field: 'missing-shadow-entity', entityId: row.entityId, legacy: row, shadow: null });
      continue;
    }
    if (row.targetable !== counterpart.targetable) mismatches.push({ field: 'targetability', entityId: row.entityId, legacy: row.targetable, shadow: counterpart.targetable });
  }
  for (const row of shadow.rows) {
    if (!legacyById.has(row.entityId)) mismatches.push({ field: 'unexpected-shadow-entity', entityId: row.entityId, legacy: null, shadow: row });
    if (!basisIsValid(row)) mismatches.push({ field: 'epistemic-basis-missing', entityId: row.entityId, legacy: 'explicit knowledge/contact/origin basis', shadow: row.basis });
  }

  const shadowUnique = unique(shadow.entityIds);
  if (shadowUnique.length !== shadow.entityIds.length) mismatches.push({ field: 'shadow-internal-consistency', legacy: 'unique entity ids', shadow: shadow.entityIds });

  return {
    enabled: true,
    equal: mismatches.length === 0,
    observerId,
    legacyCounts: { entities: legacy.entityIds.length, markers: legacy.markerIds.length, targetable: legacy.targetableEntityIds.length },
    shadowCounts: { entities: shadow.entityIds.length, markers: shadow.markerIds.length, targetable: shadow.targetableEntityIds.length },
    mismatches,
  };
}

export function isI1DWorldCompareModeEnabled(): boolean {
  try {
    return typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.getItem(I1D_WORLD_COMPARE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Compare-only diagnostic hook. Default OFF; legacy visibleWorldEntities remains the map/target authority. */
export function compareWorldGraphProjectionsIfEnabled(
  state: SandboxGameState,
  observerId: string,
  area: AreaProjection,
  enabled = isI1DWorldCompareModeEnabled(),
): WorldGraphProjectionComparison | null {
  if (!enabled) return null;
  const result = compareWorldGraphProjections(state, observerId, area);
  if (!result.equal) console.warn('[Descendants I1-D] WORLD legacy/shadow graph projection mismatch', result);
  return result;
}

/** Diagnostic helper for tests/audits: resolves current projected WorldEntity rows by entity identity. */
export function materializeWorldEntities(area: AreaProjection, graph: WorldGraphProjection): WorldEntity[] {
  const byId = new Map(area.entities.map((entry) => [entry.id, entry]));
  return graph.entityIds.map((id) => byId.get(id)).filter((entry): entry is WorldEntity => Boolean(entry));
}


export type WorldGraphReadSource = 'legacy' | 'shadow';
export type WorldGraphReadFallbackReason = 'projection-mismatch' | 'entity-identity-mismatch';

export interface WorldGraphReadSelection {
  source: WorldGraphReadSource;
  entities: WorldEntity[];
  graph: WorldGraphProjection;
  comparison: WorldGraphProjectionComparison;
  entityIdentityEqual: boolean;
  fallbackReason?: WorldGraphReadFallbackReason;
}

export function isI1DWorldReadSwitchEnabled(): boolean {
  try {
    return typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.getItem(I1D_WORLD_READ_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function exactEntityIdentity(left: readonly WorldEntity[], right: readonly WorldEntity[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * I1-D2 fail-closed WORLD read selector.
 *
 * Default OFF: exact legacy membership/entity objects remain authoritative.
 * Enabled: the KnowledgeStore graph may choose membership only when the full I1-D comparator is equal
 * and materialization resolves to the exact same AreaProjection entity objects in the exact same order.
 * Route/topology and target-action code therefore continue to consume the original provider entities.
 */
export function selectWorldGraphReadModel(
  state: SandboxGameState,
  observerId: string,
  area: AreaProjection,
  enabled = isI1DWorldReadSwitchEnabled(),
): WorldGraphReadSelection {
  const legacyGraph = buildLegacyWorldGraphProjection(state, observerId, area);
  const legacyEntities = materializeWorldEntities(area, legacyGraph);
  const comparison = compareWorldGraphProjections(state, observerId, area);
  if (!enabled) {
    return {
      source: 'legacy',
      entities: legacyEntities,
      graph: legacyGraph,
      comparison,
      entityIdentityEqual: true,
    };
  }

  if (!comparison.equal) {
    console.warn('[Descendants I1-D2] WORLD shadow read rejected: projection mismatch; using legacy WORLD authority', comparison);
    return {
      source: 'legacy',
      entities: legacyEntities,
      graph: legacyGraph,
      comparison,
      entityIdentityEqual: false,
      fallbackReason: 'projection-mismatch',
    };
  }

  const shadowGraph = buildShadowWorldGraphProjection(state, observerId, area);
  const shadowEntities = materializeWorldEntities(area, shadowGraph);
  const entityIdentityEqual = exactEntityIdentity(legacyEntities, shadowEntities);
  if (!entityIdentityEqual) {
    console.warn('[Descendants I1-D2] WORLD shadow read rejected: provider entity identity/order mismatch; using legacy WORLD authority', {
      observerId,
      legacyIds: legacyEntities.map((entry) => entry.id),
      shadowIds: shadowEntities.map((entry) => entry.id),
    });
    return {
      source: 'legacy',
      entities: legacyEntities,
      graph: legacyGraph,
      comparison,
      entityIdentityEqual: false,
      fallbackReason: 'entity-identity-mismatch',
    };
  }

  return {
    source: 'shadow',
    entities: shadowEntities,
    graph: shadowGraph,
    comparison,
    entityIdentityEqual: true,
  };
}

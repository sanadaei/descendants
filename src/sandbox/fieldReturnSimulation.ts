import type { AreaProjection, JsonValue, SpatialRef } from '../worldbridge/contract.js';
import { clamp } from './stateUtils.js';
import type { ExpeditionReturnTravelState, ExpeditionState, SandboxGameState } from './types.js';

export interface ProviderReturnTerrainAssessment {
  risk: number;
  speedFactor: number;
  terrainEvidenceIds: string[];
  navigationAnchorIds: string[];
  drivers: string[];
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function distance(a: SpatialRef, b: SpatialRef): number {
  if (a.frameId !== b.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

/**
 * Read only explicit observer-bounded terrain/navigation fields. Tags and numeric weights are
 * gameplay traversal evidence, not a terrain classifier inferred from hidden provider truth.
 */
export function providerReturnTerrainAssessment(projection: AreaProjection | null | undefined): ProviderReturnTerrainAssessment {
  if (!projection) return { risk: 0, speedFactor: 1, terrainEvidenceIds: [], navigationAnchorIds: [], drivers: [] };
  let risk = 0;
  const terrainEvidenceIds: string[] = [];
  const navigationAnchorIds: string[] = [];
  const drivers: string[] = [];
  for (const entity of projection.entities) {
    const c = entity.components;
    const numeric = [finiteNumber(c.travelDifficulty), finiteNumber(c.terrainDifficulty), finiteNumber(c.mobilityPenalty)]
      .filter((entry): entry is number => entry !== undefined)
      .map((entry) => clamp(entry, 0, 1));
    let local = numeric.length ? Math.max(...numeric) : 0;
    const tags = new Set((entity.tags ?? []).map((entry) => entry.toLowerCase()));
    if (tags.has('rough-terrain')) local = Math.max(local, 0.34);
    if (tags.has('dense-forest')) local = Math.max(local, 0.28);
    if (tags.has('steep')) local = Math.max(local, 0.48);
    if (tags.has('swamp') || tags.has('flooded')) local = Math.max(local, 0.58);
    if (tags.has('deep-snow')) local = Math.max(local, 0.52);
    if (local > 0) {
      risk = Math.max(risk, local);
      terrainEvidenceIds.push(entity.id);
      drivers.push(`${entity.id}:${local.toFixed(2)}`);
    }
    if (c.navigationAnchor === true || tags.has('navigation-anchor') || tags.has('navigation-beacon')) navigationAnchorIds.push(entity.id);
  }
  risk = clamp(risk, 0, 1);
  return {
    risk,
    speedFactor: clamp(1 - risk * 0.55, 0.35, 1),
    terrainEvidenceIds: [...new Set(terrainEvidenceIds)].sort(),
    navigationAnchorIds: [...new Set(navigationAnchorIds)].sort(),
    drivers: [...new Set(drivers)].sort(),
  };
}

export function beginOffNetworkReturn(state: SandboxGameState, expedition: ExpeditionState): ExpeditionReturnTravelState {
  expedition.status = 'returning';
  expedition.returnTravelMode = 'off-network-bearing';
  const target = structuredClone(state.settlement.position);
  const remaining = distance(expedition.position, target);
  if (!expedition.returnTravel || expedition.returnTravel.status !== 'active') {
    expedition.returnTravel = {
      mode: 'off-network-bearing', status: 'active',
      startedDay: state.clock.day, startedMinute: state.clock.minuteOfDay, startedTick: state.clock.worldTick,
      origin: structuredClone(expedition.position), target,
      initialDistanceKm: Number.isFinite(remaining) ? remaining : 0,
      travelledDistanceKm: 0, remainingDistanceKm: Number.isFinite(remaining) ? remaining : 0,
      lastIntervalDistanceKm: 0, uncertaintyKm: 0,
      lastSpeedFactor: 1, lastTerrainRisk: 0,
      terrainEvidenceIds: [], navigationAnchorIds: [],
    };
  }
  return expedition.returnTravel;
}

export function recordOffNetworkReturnProgress(
  state: SandboxGameState,
  expedition: ExpeditionState,
  beforeDistanceKm: number,
  afterDistanceKm: number,
  projection: AreaProjection,
  assessment: ProviderReturnTerrainAssessment,
): ExpeditionReturnTravelState {
  const travel = beginOffNetworkReturn(state, expedition);
  const interval = Math.max(0, Number.isFinite(beforeDistanceKm) && Number.isFinite(afterDistanceKm) ? beforeDistanceKm - afterDistanceKm : 0);
  travel.lastIntervalDistanceKm = interval;
  travel.travelledDistanceKm = Math.max(0, travel.travelledDistanceKm + interval);
  travel.remainingDistanceKm = Math.max(0, Number.isFinite(afterDistanceKm) ? afterDistanceKm : travel.remainingDistanceKm);
  travel.lastSpeedFactor = assessment.speedFactor;
  travel.lastTerrainRisk = assessment.risk;
  travel.lastProviderTick = projection.tick;
  travel.terrainEvidenceIds = [...assessment.terrainEvidenceIds];
  travel.navigationAnchorIds = [...assessment.navigationAnchorIds];
  const drift = interval * (0.025 + assessment.risk * 0.09);
  travel.uncertaintyKm = Math.max(0, travel.uncertaintyKm + drift);
  if (assessment.navigationAnchorIds.length) travel.uncertaintyKm = Math.min(travel.uncertaintyKm * 0.35, 0.5);
  return travel;
}


export function interruptOffNetworkReturn(state: SandboxGameState, expedition: ExpeditionState, reason: string): void {
  const travel = expedition.returnTravel;
  if (!travel || travel.status !== 'active') return;
  travel.status = 'interrupted';
  travel.lastIntervalDistanceKm = 0;
  travel.completedDay = state.clock.day;
  travel.completedMinute = state.clock.minuteOfDay;
  void reason;
}

export function completeOffNetworkReturn(state: SandboxGameState, expedition: ExpeditionState): void {
  const travel = expedition.returnTravel;
  if (!travel) return;
  travel.status = 'completed';
  travel.remainingDistanceKm = 0;
  travel.lastIntervalDistanceKm = 0;
  travel.completedDay = state.clock.day;
  travel.completedMinute = state.clock.minuteOfDay;
}

import type { AdvanceResult, SpatialRef, WorldProvider, WorldTick } from './contract.js';

export interface GameClockState {
  day: number;
  minuteOfDay: number;
  worldTick: WorldTick;
}

export interface WorldClockPolicy {
  worldTicksPerDay: number;
  activeRadiusKm: number;
  activeDetailRank: number;
  /** Provider tick corresponding to epochGameMinute. Required when generated worlds begin after burn-in. */
  epochWorldTick?: number;
  /** Absolute in-game minute ((day-1)*1440+minuteOfDay) corresponding to epochWorldTick. */
  epochGameMinute?: number;
}

export const DEFAULT_MOCK_CLOCK_POLICY: WorldClockPolicy = {
  worldTicksPerDay: 24,
  activeRadiusKm: 25,
  activeDetailRank: 0,
};

export function normalizeClock(day: number, minuteOfDay: number, worldTick: WorldTick): GameClockState {
  const totalMinutes = Math.max(0, Math.floor((day - 1) * 1440 + minuteOfDay));
  return {
    day: Math.floor(totalMinutes / 1440) + 1,
    minuteOfDay: totalMinutes % 1440,
    worldTick: Math.max(0, Math.floor(worldTick)),
  };
}

export function addGameMinutes(clock: GameClockState, minutes: number): GameClockState {
  return normalizeClock(clock.day, clock.minuteOfDay + Math.max(0, Math.floor(minutes)), clock.worldTick);
}

export function gameClockToWorldTick(clock: GameClockState, policy: WorldClockPolicy): WorldTick {
  const ticksPerDay = Math.max(1, Math.floor(policy.worldTicksPerDay));
  const absoluteMinute = Math.max(0, (clock.day - 1) * 1440 + clock.minuteOfDay);
  if (policy.epochWorldTick !== undefined && policy.epochGameMinute !== undefined) {
    const elapsedMinutes = Math.max(0, absoluteMinute - policy.epochGameMinute);
    return Math.max(clock.worldTick, Math.floor(policy.epochWorldTick + elapsedMinutes * ticksPerDay / 1440));
  }
  return Math.max(clock.worldTick, Math.floor(absoluteMinute * ticksPerDay / 1440));
}

export async function advanceWorldClock(
  provider: WorldProvider,
  clock: GameClockState,
  policy: WorldClockPolicy,
  activeCenter?: SpatialRef,
  observationOwnerIds: string[] = [],
): Promise<{ clock: GameClockState; result: AdvanceResult }> {
  const toTick = gameClockToWorldTick(clock, policy);
  const request = {
    toTick,
    ...(activeCenter ? {
      activeRegions: [{ center: activeCenter, radiusKm: policy.activeRadiusKm, requestedDetailRank: policy.activeDetailRank }],
    } : {}),
    ...(observationOwnerIds.length ? { observationOwnerIds } : {}),
  };
  const result = await provider.advance(request);
  if (result.toTick < result.fromTick || result.toTick > toTick) {
    throw new Error(`WorldProvider returned non-monotonic advance result ${result.fromTick} -> ${result.toTick} for requested ${toTick}.`);
  }
  return { clock: { ...clock, worldTick: result.toTick }, result };
}

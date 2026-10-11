import type { JsonValue, SpatialRef, WorldProvider } from '../worldbridge/contract.js';
import { clamp, nextStateId, settlementAgents } from './stateUtils.js';
import type { ExternalConflictObservation, ExternalConflictObservationKind, ExpeditionState, SandboxAgent, SandboxGameState, SettlementResourceKey } from './types.js';

const KINDS = new Set<ExternalConflictObservationKind>(['violence','route-disruption','displacement','resource-loss','recovery']);
const RECENT_CONFLICT_DAYS = 7;

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}
function finiteNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function spatial(value: JsonValue | undefined): SpatialRef | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  const raw = value as Record<string, JsonValue>;
  if (typeof raw.frameId !== 'string' || typeof raw.x !== 'number' || typeof raw.y !== 'number') return undefined;
  return { frameId: raw.frameId, x: raw.x, y: raw.y, ...(typeof raw.z === 'number' ? { z: raw.z } : {}) };
}

interface ParsedConflictEvidence {
  kind: ExternalConflictObservationKind;
  severity: number;
  injuredIndividualIds: string[];
  displacedIndividualIds: string[];
  displacedHouseholdIds: string[];
  returnedToSettlementIndividualIds: string[];
  returnedToSettlementHouseholdIds: string[];
  affectedRouteEntityIds: string[];
  routePassability?: 'unknown' | 'degraded' | 'impassable';
  resourceLoss: Partial<Record<SettlementResourceKey, number>>;
  location?: SpatialRef;
}

const RESOURCE_KEYS: SettlementResourceKey[] = ['food','water','medicine','timber','scrap','fuel','cloth','records'];
function resourceLoss(value: JsonValue | undefined): Partial<Record<SettlementResourceKey, number>> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  const raw = value as Record<string, JsonValue>;
  const result: Partial<Record<SettlementResourceKey, number>> = {};
  for (const key of RESOURCE_KEYS) {
    const amount = finiteNumber(raw[key]);
    if (amount !== null && amount > 0) result[key] = amount;
  }
  return result;
}

function parseEvidence(payload: Record<string, JsonValue>): ParsedConflictEvidence | null {
  const kind = payload.observedConflictKind;
  const rawSeverity = finiteNumber(payload.conflictSeverity);
  if (typeof kind !== 'string' || !KINDS.has(kind as ExternalConflictObservationKind)) return null;
  const recovery = kind === 'recovery';
  const returnedToSettlementIndividualIds = [...new Set(strings(payload.returnedToSettlementIndividualIds))];
  const returnedToSettlementHouseholdIds = [...new Set(strings(payload.returnedToSettlementHouseholdIds))];
  if (recovery && !returnedToSettlementIndividualIds.length && !returnedToSettlementHouseholdIds.length) return null;
  if (!recovery && (rawSeverity === null || rawSeverity <= 0)) return null;
  const severity = recovery ? clamp(rawSeverity ?? 0, 0, 100) : clamp(rawSeverity!, 0, 100);
  const location = spatial(payload.observedLocation);
  const routePassability = typeof payload.routePassability === 'string' && ['unknown','degraded','impassable'].includes(payload.routePassability)
    ? payload.routePassability as 'unknown' | 'degraded' | 'impassable'
    : undefined;
  return {
    kind: kind as ExternalConflictObservationKind,
    severity,
    injuredIndividualIds: [...new Set(strings(payload.injuredIndividualIds))],
    displacedIndividualIds: [...new Set(strings(payload.displacedIndividualIds))],
    displacedHouseholdIds: [...new Set(strings(payload.displacedHouseholdIds))],
    returnedToSettlementIndividualIds,
    returnedToSettlementHouseholdIds,
    affectedRouteEntityIds: [...new Set(strings(payload.affectedRouteEntityIds))],
    ...(routePassability ? { routePassability } : {}),
    resourceLoss: resourceLoss(payload.settlementResourceLoss),
    ...(location ? { location } : {}),
  };
}

function recordObservedTrauma(state: SandboxGameState, agent: SandboxAgent, observation: ExternalConflictObservation): void {
  const severity = observation.severity;
  // The provider explicitly establishes injury and its severity. The local medical model translates that
  // observed severity into HP/pathology without choosing an unreported victim or cause.
  const damage = clamp(severity * 0.28, 5, 32);
  const preHealth = agent.health;
  agent.health = clamp(agent.health - damage, 1, 100);
  const symptom = severity >= 75 ? 'severe conflict trauma / mobility impairment' : severity >= 45 ? 'open wound / conflict trauma' : 'minor conflict injury';
  const existing = agent.pathology.find((entry) => entry.pathologyId === 'traumatic-wound' && entry.status === 'active');
  if (existing) {
    existing.severity = clamp(Math.max(existing.severity, severity) + severity * 0.18, 0, 100);
    if (!existing.observedSymptoms.includes(symptom)) existing.observedSymptoms.push(symptom);
    for (const cause of observation.provenanceIds) if (!existing.suspectedCauses.includes(cause)) existing.suspectedCauses.push(cause);
  } else {
    agent.pathology.push({
      id: nextStateId(state, 'case'), pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity,
      contagious: false, observedSymptoms: [symptom], suspectedCauses: [...observation.provenanceIds], treatmentsTried: [], status: 'active',
    });
  }
  if (severity >= 60 && !agent.memories.some((memory) => memory.kind === 'trauma' && memory.sourceIds.includes(observation.providerSourceId))) {
    agent.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'trauma', text: `I was injured during provider-observed external conflict (${observation.providerSourceId}).`, salience: Math.round(clamp(45 + severity * 0.45, 45, 92)), sourceIds: [...observation.provenanceIds] });
    if (agent.memories.length > 80) agent.memories.splice(0, agent.memories.length - 80);
  }
  state.chronicle.push({
    id: nextStateId(state, 'chronicle'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'medicine',
    title: `${agent.name} injured in observed external conflict`,
    text: `Provider-observed conflict severity ${severity.toFixed(0)} affected ${agent.name}; local observed HP ${preHealth.toFixed(0)} → ${agent.health.toFixed(0)} and traumatic-wound care was recorded.`,
    entityIds: [agent.id, observation.sourceEntityId, observation.providerSourceId],
  });
}

function applyExplicitLocalConsequences(state: SandboxGameState, observation: ExternalConflictObservation): void {
  const local = new Map(settlementAgents(state).map((agent) => [agent.id, agent]));
  const allLiving = new Map(state.agents.filter((agent) => agent.alive).map((agent) => [agent.id, agent]));
  const households = new Map(state.settlement.households.map((household) => [household.id, household]));

  const displaceAgent = (agent: SandboxAgent, mode: 'individual' | 'household'): void => {
    agent.residence = 'unknown';
    agent.expeditionId = null;
    agent.currentPlan = null;
    agent.currentTask = 'rest';
    agent.experience[mode === 'household' ? 'displacement:household-observed-day' : 'displacement:observed-day'] = state.clock.day;
    if (!agent.memories.some((memory) => memory.kind === 'trauma' && memory.sourceIds.includes(observation.providerSourceId))) {
      const text = mode === 'household'
        ? `My household was displaced during provider-observed external conflict (${observation.providerSourceId}).`
        : `I was displaced during provider-observed external conflict (${observation.providerSourceId}).`;
      agent.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'trauma', text, salience: Math.round(clamp(50 + observation.severity * 0.35, 50, 90)), sourceIds: [...observation.provenanceIds] });
      if (agent.memories.length > 80) agent.memories.splice(0, agent.memories.length - 80);
    }
  };

  const returnAgent = (agent: SandboxAgent, mode: 'individual' | 'household'): void => {
    if (agent.residence !== 'unknown') return;
    agent.residence = 'settlement';
    agent.expeditionId = null;
    agent.currentPlan = null;
    agent.currentTask = 'rest';
    agent.experience[mode === 'household' ? 'displacement:household-return-day' : 'displacement:return-day'] = state.clock.day;
    agent.experience[mode === 'household' ? 'displacement:household-return-minute' : 'displacement:return-minute'] = state.clock.minuteOfDay;
    agent.memories.push({
      id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'social',
      text: mode === 'household'
        ? `My household's return to the settlement after displacement was provider-observed (${observation.providerSourceId}).`
        : `My return to the settlement after displacement was provider-observed (${observation.providerSourceId}).`,
      salience: 72, sourceIds: [...observation.provenanceIds],
    });
    if (agent.memories.length > 80) agent.memories.splice(0, agent.memories.length - 80);
  };

  for (const id of observation.injuredIndividualIds) {
    const agent = local.get(id);
    if (agent?.alive) recordObservedTrauma(state, agent, observation);
  }

  // Household movement is accepted only when the provider explicitly names the household ID.
  // We move only members physically in the settlement at that moment; an away member is not teleported into an unknown state.
  for (const householdId of observation.displacedHouseholdIds ?? []) {
    const household = households.get(householdId);
    if (!household) continue;
    const displacedMemberIds = household.memberIds.filter((id) => local.has(id));
    household.displacement = {
      status: 'displaced', displacedDay: state.clock.day, displacedMinuteOfDay: state.clock.minuteOfDay,
      displacementProviderSourceId: observation.providerSourceId, displacedMemberIds: [...displacedMemberIds],
      displacementProvenanceIds: [...observation.provenanceIds],
    };
    for (const id of displacedMemberIds) {
      const agent = local.get(id);
      if (agent?.alive) displaceAgent(agent, 'household');
    }
    state.chronicle.push({
      id: nextStateId(state, 'chronicle'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'external',
      title: `Household ${household.id} displaced by provider observation`,
      text: `Provider observation ${observation.providerSourceId} explicitly identified household ${household.id} as displaced; ${displacedMemberIds.length} member(s) physically present in the settlement moved outside ordinary local systems. No household movement was inferred from individual IDs.`,
      entityIds: [household.id, ...displacedMemberIds, observation.sourceEntityId, observation.providerSourceId],
    });
  }

  // Individual evidence remains individual evidence. It must never upgrade the containing household to a household displacement episode.
  for (const id of observation.displacedIndividualIds) {
    const agent = local.get(id);
    if (!agent?.alive) continue;
    displaceAgent(agent, 'individual');
  }

  // A household return only closes a prior provider-explicit household episode. This avoids treating a generic "return" as proof
  // about a household that was never observed moving as a unit.
  for (const householdId of observation.returnedToSettlementHouseholdIds ?? []) {
    const household = households.get(householdId);
    const episode = household?.displacement;
    if (!household || !episode || episode.status !== 'displaced') continue;
    const returnedMemberIds: string[] = [];
    for (const id of episode.displacedMemberIds) {
      const agent = allLiving.get(id);
      if (!agent || agent.residence !== 'unknown') continue;
      returnAgent(agent, 'household');
      returnedMemberIds.push(id);
    }
    household.displacement = {
      ...episode, status: 'returned', returnedDay: state.clock.day, returnedMinuteOfDay: state.clock.minuteOfDay,
      returnProviderSourceId: observation.providerSourceId, returnProvenanceIds: [...observation.provenanceIds],
    };
    state.chronicle.push({
      id: nextStateId(state, 'chronicle'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'external',
      title: `Household ${household.id} returned after observed displacement`,
      text: `Provider observation ${observation.providerSourceId} explicitly returned household ${household.id}; ${returnedMemberIds.length} previously displaced member(s) re-entered ordinary settlement systems. Members in another known physical state were not teleported.`,
      entityIds: [household.id, ...returnedMemberIds, observation.sourceEntityId, observation.providerSourceId],
    });
  }

  for (const id of observation.returnedToSettlementIndividualIds ?? []) {
    const agent = allLiving.get(id);
    if (!agent || agent.residence !== 'unknown') continue;
    returnAgent(agent, 'individual');
    state.chronicle.push({
      id: nextStateId(state, 'chronicle'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'external',
      title: `${agent.name} returned after observed displacement`,
      text: `Provider observation ${observation.providerSourceId} explicitly placed ${agent.name} back at the settlement; ordinary local labor, food, water and care systems now include them again.`,
      entityIds: [agent.id, observation.sourceEntityId, observation.providerSourceId],
    });
  }
  for (const [key, amount] of Object.entries(observation.resourceLoss) as Array<[SettlementResourceKey, number]>) {
    state.settlement.resources[key] = Math.max(0, state.settlement.resources[key] - amount);
  }
}

/**
 * Import only provider-observed physical conflict consequences attached to the accepted provider result.
 * Generic command/intervention records are intentionally ignored: issuing a conflict command is not evidence
 * that a route was damaged, a resident was injured, or anyone was displaced.
 */
export async function materializeProviderObservedConflict(
  provider: WorldProvider,
  state: SandboxGameState,
  sourceEntityId: string,
  sourceIds: string[],
): Promise<ExternalConflictObservation[]> {
  if (!sourceIds.length) return [];
  let snapshot;
  try { snapshot = await provider.exportSnapshot(0); } catch { return []; }
  const source = new Set(sourceIds);
  const existing = new Set((state.externalConflictObservations ?? []).map((entry) => entry.providerSourceId));
  const created: ExternalConflictObservation[] = [];
  const candidates: Array<{ id: string; tick: number; payload: Record<string, JsonValue>; location?: SpatialRef; provenanceIds: string[] }> = [];
  for (const event of snapshot.events) {
    if (!source.has(event.id) || event.kind.startsWith('command.')) continue;
    candidates.push({ id: event.id, tick: event.tick, payload: event.data, ...(event.location ? { location: event.location } : {}), provenanceIds: [event.id, ...event.provenanceIds, ...event.causeIds] });
  }
  for (const record of snapshot.causalRecords) {
    if (!source.has(record.id) || record.kind !== 'observation' || record.hiddenTruth) continue;
    candidates.push({ id: record.id, tick: record.tick ?? state.clock.worldTick, payload: record.payload, provenanceIds: [record.id, ...record.parentIds] });
  }
  for (const candidate of candidates) {
    if (existing.has(candidate.id)) continue;
    const parsed = parseEvidence(candidate.payload);
    if (!parsed) continue;
    const observation: ExternalConflictObservation = {
      id: nextStateId(state, 'external-conflict'), sourceEntityId, providerSourceId: candidate.id, providerTick: candidate.tick,
      day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: parsed.kind, severity: parsed.severity,
      injuredIndividualIds: parsed.injuredIndividualIds, displacedIndividualIds: parsed.displacedIndividualIds, displacedHouseholdIds: parsed.displacedHouseholdIds,
      returnedToSettlementIndividualIds: parsed.returnedToSettlementIndividualIds, returnedToSettlementHouseholdIds: parsed.returnedToSettlementHouseholdIds,
      affectedRouteEntityIds: parsed.affectedRouteEntityIds, ...(parsed.routePassability ? { routePassability: parsed.routePassability } : {}), resourceLoss: parsed.resourceLoss,
      provenanceIds: [...new Set([candidate.id, ...candidate.provenanceIds])],
      ...(parsed.location ?? candidate.location ? { location: structuredClone(parsed.location ?? candidate.location!) } : {}),
    };
    (state.externalConflictObservations ??= []).push(observation);
    created.push(observation);
    existing.add(candidate.id);
    applyExplicitLocalConsequences(state, observation);
    state.chronicle.push({
      id: nextStateId(state, 'chronicle'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'external',
      title: `Provider-observed external ${observation.kind}`,
      text: `${sourceEntityId}: observed severity ${observation.severity.toFixed(0)}.${observation.affectedRouteEntityIds.length ? ` Affected route/entity references: ${observation.affectedRouteEntityIds.join(', ')}.` : ''}${observation.routePassability ? ` Explicit route passability: ${observation.routePassability}.` : ''}${observation.injuredIndividualIds.length ? ` Explicit injured individual IDs: ${observation.injuredIndividualIds.join(', ')}.` : ''}${observation.displacedIndividualIds.length ? ` Explicit displaced individual IDs: ${observation.displacedIndividualIds.join(', ')}.` : ''}${observation.displacedHouseholdIds?.length ? ` Explicit displaced household IDs: ${observation.displacedHouseholdIds.join(', ')}.` : ''}${observation.returnedToSettlementIndividualIds?.length ? ` Explicit returned-to-settlement individual IDs: ${observation.returnedToSettlementIndividualIds.join(', ')}.` : ''}${observation.returnedToSettlementHouseholdIds?.length ? ` Explicit returned-to-settlement household IDs: ${observation.returnedToSettlementHouseholdIds.join(', ')}.` : ''}${Object.keys(observation.resourceLoss).length ? ` Explicit settlement resource loss: ${Object.entries(observation.resourceLoss).map(([key,value]) => `${key} ${Number(value).toFixed(1)}`).join(', ')}.` : ''}`,
      entityIds: [sourceEntityId, candidate.id, ...observation.injuredIndividualIds, ...observation.affectedRouteEntityIds],
    });
  }
  return created;
}

export function recentObservedConflict(state: SandboxGameState, maxAgeDays = RECENT_CONFLICT_DAYS): ExternalConflictObservation[] {
  return (state.externalConflictObservations ?? []).filter((entry) => state.clock.day - entry.day <= maxAgeDays);
}

export function observedConflictGuardDemand(state: SandboxGameState): number {
  return recentObservedConflict(state)
    .filter((entry) => entry.kind === 'violence' || entry.kind === 'displacement')
    .reduce((sum, entry) => sum + entry.severity / 45, 0);
}

export function latestObservedRouteDisruptionForEntity(
  state: SandboxGameState,
  entityId: string,
  maxAgeDays = RECENT_CONFLICT_DAYS,
): ExternalConflictObservation | undefined {
  return recentObservedConflict(state, maxAgeDays)
    .filter((entry) => entry.kind === 'route-disruption' && entry.affectedRouteEntityIds.includes(entityId))
    .sort((a, b) => b.day - a.day || b.minuteOfDay - a.minuteOfDay || b.severity - a.severity)[0];
}

export function latestObservedRouteDisruptionForEntities(
  state: SandboxGameState,
  entityIds: Iterable<string>,
  maxAgeDays = RECENT_CONFLICT_DAYS,
): ExternalConflictObservation | undefined {
  const ids = new Set(entityIds);
  if (!ids.size) return undefined;
  return recentObservedConflict(state, maxAgeDays)
    .filter((entry) => entry.kind === 'route-disruption' && entry.affectedRouteEntityIds.some((id) => ids.has(id)))
    .sort((a, b) => b.severity - a.severity || b.day - a.day || b.minuteOfDay - a.minuteOfDay || a.id.localeCompare(b.id))[0];
}

export function expeditionObservedRouteConflictRisk(state: SandboxGameState, expedition: ExpeditionState): number {
  if (expedition.status !== 'outbound') return 0;
  const targetIds = new Set<string>();
  if (expedition.destinationEntityId) targetIds.add(expedition.destinationEntityId);
  if (expedition.routeEntityId) targetIds.add(expedition.routeEntityId);
  for (const id of expedition.routePlan?.evidenceIds ?? []) targetIds.add(id);
  for (const order of expedition.orders) if (!order.completed && order.targetEntityId) targetIds.add(order.targetEntityId);
  if (!targetIds.size) return 0;
  const severity = recentObservedConflict(state)
    .filter((entry) => entry.kind === 'route-disruption' && entry.affectedRouteEntityIds.some((id) => targetIds.has(id)))
    .reduce((max, entry) => Math.max(max, entry.severity), 0);
  return clamp(severity / 2500, 0, 0.04);
}

import { agentAbilityFactors } from './aging.js';
import { adjustResourceStock, reconcileResourceLedgerToAggregates } from './resourceLedger.js';
import type { AreaProjection, SpatialRef, WorldEntity, WorldProvider } from '../worldbridge/contract.js';
import { issueProviderCommandOnce, nextProviderCommandId } from './providerMutationJournal.js';
import { chance, randomInt } from './rng.js';
import { reserveDirectActivity, reservedHoursByKindDuringCurrentInterval, reservedHoursDuringCurrentInterval } from './directPlay.js';
import { addObservedKnowledge } from './knowledgeSimulation.js';
import { anomalyCommunicationSupport } from './anomalyUtilization.js';
import { createEncounter, resolveEncounterRound, setEncounterInstruction } from './encounterSimulation.js';
import { expeditionObservedRouteConflictRisk } from './externalConflictSimulation.js';
import { providerVisibleRouteAlternatives, providerVisibleRouteInvalidations } from './routePlanning.js';
import { activeBlockedCampHours, advanceBlockedCampDecision, applyProviderBoundedFieldExposure, blockedRetryRequested, completeRetryDecision, interruptActiveFieldDecision } from './fieldDecisionSimulation.js';
import { beginOffNetworkReturn, completeOffNetworkReturn, interruptOffNetworkReturn, providerReturnTerrainAssessment, recordOffNetworkReturnProgress } from './fieldReturnSimulation.js';
import { promoteRendezvousRequestAfterVerifiedLink, resolveRendezvousRequest, transmittedRendezvousPosition } from './rendezvousSimulation.js';
import { advanceRendezvousLifecycle, createResponderRendezvousPlan, ensureLegacyResponderRendezvousPlan, rendezvousFreezesMovement, rendezvousSearchWaypoint, syncResponderTurnback } from './rendezvousEncounterSimulation.js';
import { addChronicle, addExpeditionChronicle, agentAgeYears, clamp, effectiveSkill, findAgent, nextStateId, settlementAgents } from './stateUtils.js';
import { revealExpeditionChronicleToSettlement } from './chronicleVisibility.js';
import { depositCarriedResourcesAtSettlement } from './localExploration.js';
import type {
  CommunicationStatus, ExpeditionControlMode, ExpeditionDoctrine, ExpeditionOrder, ExpeditionOrderKind,
  ExpeditionAlterationKind, ExpeditionPace, ExpeditionRoutePlan, ExpeditionState, SandboxAgent, SandboxGameState, SandboxStepSummary,
} from './types.js';

export interface LaunchExpeditionOptions {
  leaderId: string;
  memberIds: string[];
  controlMode: ExpeditionControlMode;
  doctrineId: string;
  destination?: SpatialRef;
  targetEntityId?: string;
  routeEntityId?: string;
  routeWaypoint?: SpatialRef;
  routePlan?: Omit<ExpeditionRoutePlan, 'currentWaypointIndex'> & { currentWaypointIndex?: number };
  rescueOfExpeditionId?: string;
  supplies?: Partial<ExpeditionState['supplies']>;
  pace?: ExpeditionPace;
}

function distance(a: SpatialRef, b: SpatialRef): number {
  if (a.frameId !== b.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function doctrineFor(state: SandboxGameState, id: string): ExpeditionDoctrine {
  const doctrine = state.doctrines.find((entry) => entry.id === id);
  if (!doctrine) throw new Error(`Unknown expedition doctrine: ${id}`);
  return doctrine;
}

export interface ExpeditionMemberReadiness {
  ready: boolean;
  minimumHealth: number;
  maximumFatigue: number;
  reasons: string[];
}

const FIELD_FOOD_PER_PERSON_DAY = 1.7;
const FIELD_WATER_PER_PERSON_DAY = 2.4;
const LAUNCH_EMERGENCY_RESERVE_HOURS = 8;

export interface ExpeditionSupplyReadiness {
  ready: boolean;
  estimatedOutboundHours: number;
  foodDays: number;
  waterDays: number;
  minimumFood: number;
  minimumWater: number;
  reasons: string[];
}

export interface SettlementSupplyReserveReadiness {
  ready: boolean;
  minimumReserveDays: number;
  remainingFoodDays: number;
  remainingWaterDays: number;
  reasons: string[];
}

function expeditionTravelSpeedKmPerHour(state: SandboxGameState, memberIds: string[], pace: ExpeditionPace): number {
  const members = memberIds.map((id) => findAgent(state, id)).filter((agent): agent is SandboxAgent => Boolean(agent?.alive));
  const avgScouting = members.reduce((sum, agent) => sum + effectiveSkill(state,agent,'scouting'), 0) / Math.max(1, members.length);
  const paceSpeed = pace === 'cautious' ? 0.72 : pace === 'fast' ? 1.28 : 1;
  return Math.max(0.5, (2.4 + avgScouting / 80) * paceSpeed);
}

export function expeditionSupplyReadiness(
  state: SandboxGameState,
  memberIds: string[],
  destination: SpatialRef | null | undefined,
  pace: ExpeditionPace,
  supplies: ExpeditionState['supplies'],
  routeWaypoints?: SpatialRef | SpatialRef[] | null,
  plannedRouteDistanceKm?: number | null,
): ExpeditionSupplyReadiness {
  const uniqueMembers = [...new Set(memberIds)];
  const partySize = Math.max(1, uniqueMembers.length);
  const speed = expeditionTravelSpeedKmPerHour(state, uniqueMembers, pace);
  const orderedWaypoints = !routeWaypoints ? [] : Array.isArray(routeWaypoints) ? routeWaypoints : [routeWaypoints];
  const outboundPoints = destination ? [state.settlement.position, ...orderedWaypoints, destination] : [];
  const geometricOutboundDistance = destination
    ? outboundPoints.slice(1).reduce((sum, point, index) => sum + distance(outboundPoints[index]!, point), 0)
    : 0;
  const outboundDistance = destination && Number.isFinite(plannedRouteDistanceKm) && Number(plannedRouteDistanceKm) >= 0
    ? Number(plannedRouteDistanceKm)
    : geometricOutboundDistance;
  const estimatedOutboundHours = Number.isFinite(outboundDistance) ? outboundDistance / speed : Number.POSITIVE_INFINITY;
  const protectedHours = (destination ? estimatedOutboundHours : 4) + LAUNCH_EMERGENCY_RESERVE_HOURS;
  const minimumFood = partySize * FIELD_FOOD_PER_PERSON_DAY * protectedHours / 24;
  const minimumWater = partySize * FIELD_WATER_PER_PERSON_DAY * protectedHours / 24;
  const foodDays = supplies.food / (partySize * FIELD_FOOD_PER_PERSON_DAY);
  const waterDays = supplies.water / (partySize * FIELD_WATER_PER_PERSON_DAY);
  const reasons: string[] = [];
  if (!Number.isFinite(estimatedOutboundHours)) reasons.push('WORLD target is outside the expedition coordinate frame');
  if (supplies.food + 1e-9 < minimumFood) reasons.push(`food ${supplies.food.toFixed(1)} < outbound reserve ${minimumFood.toFixed(1)}`);
  if (supplies.water + 1e-9 < minimumWater) reasons.push(`water ${supplies.water.toFixed(1)} < outbound reserve ${minimumWater.toFixed(1)}`);
  return { ready: reasons.length === 0, estimatedOutboundHours, foodDays, waterDays, minimumFood, minimumWater, reasons };
}

export function settlementSupplyReserveReadiness(
  state: SandboxGameState,
  supplies: ExpeditionState['supplies'],
  doctrine: ExpeditionDoctrine,
): SettlementSupplyReserveReadiness {
  const locals = settlementAgents(state);
  const children = locals.filter((agent) => agentAgeYears(state, agent) < 13).length;
  const adults = Math.max(0, locals.length - children);
  const dailyFoodNeed = Math.max(0.001, adults * 1.8 + children * 1.05);
  const dailyWaterNeed = Math.max(0.001, adults * 2.5 + children * 1.65);
  const remainingFoodDays = Math.max(0, state.settlement.resources.food - supplies.food) / dailyFoodNeed;
  const remainingWaterDays = Math.max(0, state.settlement.resources.water - supplies.water) / dailyWaterNeed;
  const minimumReserveDays = 1 + (1 - doctrine.riskTolerance) * 1.5;
  const reasons: string[] = [];
  if (remainingFoodDays + 1e-9 < minimumReserveDays) reasons.push(`settlement food reserve ${remainingFoodDays.toFixed(1)}d < doctrine minimum ${minimumReserveDays.toFixed(1)}d`);
  if (remainingWaterDays + 1e-9 < minimumReserveDays) reasons.push(`settlement water reserve ${remainingWaterDays.toFixed(1)}d < doctrine minimum ${minimumReserveDays.toFixed(1)}d`);
  return { ready: reasons.length === 0, minimumReserveDays, remainingFoodDays, remainingWaterDays, reasons };
}

export function expeditionMemberReadiness(agent: SandboxAgent, doctrine: ExpeditionDoctrine): ExpeditionMemberReadiness {
  const minimumHealth = Math.min(90, Math.max(60, Math.ceil(doctrine.retreatHealth + 10)));
  const maximumFatigue = 70;
  const reasons: string[] = [];
  if (!agent.alive) reasons.push('not alive');
  if (agent.health < minimumHealth) reasons.push(`HP ${agent.health.toFixed(0)} < launch minimum ${minimumHealth}`);
  if (agent.fatigue > maximumFatigue) reasons.push(`fatigue ${agent.fatigue.toFixed(0)} > launch maximum ${maximumFatigue}`);
  const severePathology = agent.pathology.filter((entry) => entry.status === 'active').sort((a, b) => b.severity - a.severity)[0];
  if (severePathology && severePathology.severity >= 30) reasons.push(`${severePathology.pathologyId} severity ${severePathology.severity.toFixed(0)} requires local care`);
  return { ready: reasons.length === 0, minimumHealth, maximumFatigue, reasons };
}

function knownSubjectIds(state: SandboxGameState, agentId: string): Set<string> {
  const agent = findAgent(state, agentId);
  const ids = new Set<string>([state.world.originEntityId]);
  for (const knowledgeId of agent?.knowledgeIds ?? []) {
    const entry = state.knowledge.find((candidate) => candidate.id === knowledgeId);
    for (const subject of entry?.subjectIds ?? []) ids.add(subject);
  }
  return ids;
}

function defaultSupplies(memberCount: number): ExpeditionState['supplies'] {
  return { food: Math.max(8, memberCount * 4), water: Math.max(12, memberCount * 6), medicine: Math.max(1, Math.ceil(memberCount / 2)), tools: Math.max(1, Math.ceil(memberCount / 2)) };
}

function takeSettlementSupplies(state: SandboxGameState, supplies: ExpeditionState['supplies']): void {
  reconcileResourceLedgerToAggregates(state, 'legacy expedition stock');
  const mapping: Array<[keyof ExpeditionState['supplies'], keyof SandboxGameState['settlement']['resources']]> = [['food','food'],['water','water'],['medicine','medicine'],['tools','scrap']];
  for (const [expKey, settlementKey] of mapping) {
    if (state.settlement.resources[settlementKey] < supplies[expKey]) throw new Error(`Insufficient ${settlementKey} for expedition.`);
  }
  for (const [expKey, settlementKey] of mapping) adjustResourceStock(state, settlementKey, -supplies[expKey], 'Expedition departure');
}

export function launchExpedition(state: SandboxGameState, options: LaunchExpeditionOptions): ExpeditionState {
  const memberIds = [...new Set([options.leaderId, ...options.memberIds])];
  if (memberIds.length < 1 || memberIds.length > 8) throw new Error('Expedition size must be 1-8 people.');
  const doctrine = doctrineFor(state, options.doctrineId);
  for (const id of memberIds) {
    const agent = findAgent(state, id);
    if (!agent?.alive) throw new Error(`Expedition member unavailable: ${id}`);
    if (agent.expeditionId) throw new Error(`${agent.name} is already on an expedition.`);
    const readiness = expeditionMemberReadiness(agent, doctrine);
    if (!readiness.ready) throw new Error(`${agent.name} is not fit to depart: ${readiness.reasons.join('; ')}.`);
  }
  const requestedSupplies = { ...defaultSupplies(memberIds.length), ...(options.supplies ?? {}) };
  const supplies: ExpeditionState['supplies'] = {
    food: Math.max(0, Number(requestedSupplies.food) || 0),
    water: Math.max(0, Number(requestedSupplies.water) || 0),
    medicine: Math.max(0, Number(requestedSupplies.medicine) || 0),
    tools: Math.max(0, Number(requestedSupplies.tools) || 0),
  };
  const routeReadinessWaypoints = options.routePlan?.waypoints ?? options.routeWaypoint;
  const supplyReadiness = expeditionSupplyReadiness(state, memberIds, options.destination, options.pace ?? 'normal', supplies, routeReadinessWaypoints, options.routePlan?.plannedDistanceKm);
  if (!supplyReadiness.ready) throw new Error(`Expedition loadout is not field-sufficient: ${supplyReadiness.reasons.join('; ')}.`);
  const settlementReserve = settlementSupplyReserveReadiness(state, supplies, doctrine);
  if (!settlementReserve.ready) throw new Error(`Expedition loadout would breach settlement reserve: ${settlementReserve.reasons.join('; ')}.`);
  takeSettlementSupplies(state, supplies);
  const expedition: ExpeditionState = {
    id: nextStateId(state, 'expedition'), leaderId: options.leaderId, memberIds, controlMode: options.controlMode, doctrineId: options.doctrineId, pace: options.pace ?? 'normal',
    status: options.destination ? 'outbound' : 'exploring', position: structuredClone(state.settlement.position), destination: options.destination ? structuredClone(options.destination) : null,
    ...(options.destination && options.targetEntityId ? { destinationEntityId: options.targetEntityId } : {}),
    ...(options.destination && options.routeEntityId && options.routeWaypoint ? { routeEntityId: options.routeEntityId, routeWaypoint: structuredClone(options.routeWaypoint), routeWaypointReached: false } : {}),
    ...(options.destination && options.routePlan ? { routePlan: { ...structuredClone(options.routePlan), currentWaypointIndex: Math.max(0, Math.floor(options.routePlan.currentWaypointIndex ?? 0)) } } : {}),
    departureDay: state.clock.day, departureMinute: state.clock.minuteOfDay, returnDay: null, communication: 'connected', silentHours: 0, supplies,
    orders: [], observations: [], discoveredEntityIds: [], rescueOfExpeditionId: options.rescueOfExpeditionId ?? null, missingReason: '', communicationReports: [], alterations: [],
  };
  expedition.communicationReports?.push({
    id: nextStateId(state, 'comm'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, status: 'connected',
    text: `${expedition.id} departure position verified at settlement.`, confidence: 1, verified: true, verifiedPosition: structuredClone(expedition.position), sourceIds: [expedition.id],
  });
  state.expeditions.push(expedition);
  for (const id of memberIds) { const agent = findAgent(state, id); if (agent) { agent.expeditionId = expedition.id; agent.residence = 'expedition'; } }
  const routeLabel = expedition.routePlan ? `provider-topology:${expedition.routePlan.relationIds.join('>')}` : expedition.routeEntityId ? `via=${expedition.routeEntityId}` : 'direct';
  const routeEvidenceIds = expedition.routePlan?.evidenceIds ?? (expedition.routeEntityId ? [expedition.routeEntityId] : []);
  addChronicle(state, { kind: 'expedition', title: 'Expedition departed', text: `${memberIds.length} people departed under doctrine ${options.doctrineId}; pace=${options.pace ?? 'normal'}; control=${options.controlMode}; route=${routeLabel}.`, entityIds: [expedition.id, ...memberIds, ...routeEvidenceIds] });
  return expedition;
}

export function saveDoctrine(state: SandboxGameState, doctrine: Omit<ExpeditionDoctrine, 'id'> & { id?: string }): ExpeditionDoctrine {
  const normalized: ExpeditionDoctrine = {
    id: doctrine.id ?? nextStateId(state, 'doctrine'), name: doctrine.name, riskTolerance: clamp(doctrine.riskTolerance, 0, 1), retreatHealth: clamp(doctrine.retreatHealth),
    maxSilentHours: Math.max(1, Math.floor(doctrine.maxSilentHours)), campBeforeDark: doctrine.campBeforeDark, prioritizeRescue: doctrine.prioritizeRescue,
    contactPolicy: doctrine.contactPolicy, encounterInstruction: doctrine.encounterInstruction,
  };
  const index = state.doctrines.findIndex((entry) => entry.id === normalized.id);
  if (index >= 0) state.doctrines[index] = normalized; else state.doctrines.push(normalized);
  return normalized;
}

export function addExpeditionOrder(
  state: SandboxGameState,
  expeditionId: string,
  kind: ExpeditionOrderKind,
  detail: string,
  options: { target?: SpatialRef; targetEntityId?: string; epistemicBasisIds?: string[] } = {},
): ExpeditionOrder {
  const expedition = state.expeditions.find((entry) => entry.id === expeditionId);
  if (!expedition || !['outbound','exploring','returning'].includes(expedition.status)) throw new Error('Expedition is not available for orders.');
  const basis = [...new Set(options.epistemicBasisIds ?? [])];
  const leaderKnown = new Set(findAgent(state, expedition.leaderId)?.knowledgeIds ?? []);
  const knownSubjects = knownSubjectIds(state, expedition.leaderId);
  const unfoundedBasis = basis.some((id) => !leaderKnown.has(id) && !state.knowledge.some((entry) => entry.id === id && state.settlement.localKnowledgeIds.includes(id)));
  const unfoundedTarget = Boolean(options.targetEntityId && !knownSubjects.has(options.targetEntityId));
  const order: ExpeditionOrder = {
    id: nextStateId(state, 'order'), kind, issuedDay: state.clock.day, issuedMinute: state.clock.minuteOfDay, issuerId: expedition.controlMode === 'expedition' ? expedition.leaderId : state.settlement.leaderId,
    detail, epistemicBasisIds: basis, unfounded: unfoundedBasis || unfoundedTarget, completed: false,
    ...(options.target ? { target: structuredClone(options.target) } : {}), ...(options.targetEntityId ? { targetEntityId: options.targetEntityId } : {}),
  };
  expedition.orders.push(order);
  return order;
}

function consumeSupplies(expedition: ExpeditionState, hours: number): void {
  const factor = hours / 24;
  expedition.supplies.food = Math.max(0, expedition.supplies.food - expedition.memberIds.length * FIELD_FOOD_PER_PERSON_DAY * factor);
  expedition.supplies.water = Math.max(0, expedition.supplies.water - expedition.memberIds.length * FIELD_WATER_PER_PERSON_DAY * factor);
}

function absoluteMinute(state: SandboxGameState): number { return (state.clock.day - 1) * 1440 + state.clock.minuteOfDay; }

function nightHoursDuringCurrentInterval(state: SandboxGameState, hours: number): number {
  if (hours <= 0) return 0;
  const end = absoluteMinute(state); const start = end - hours * 60;
  let nightMinutes = 0;
  const firstDay = Math.floor(start / 1440) - 1; const lastDay = Math.floor(end / 1440) + 1;
  for (let day = firstDay; day <= lastDay; day += 1) {
    const base = day * 1440;
    for (const [nightStart, nightEnd] of [[base, base + 360], [base + 1080, base + 1440]] as const) {
      nightMinutes += Math.max(0, Math.min(end, nightEnd) - Math.max(start, nightStart));
    }
  }
  return Math.min(hours, nightMinutes / 60);
}

function applyCampRest(state: SandboxGameState, expedition: ExpeditionState, hours: number, reason: 'direct' | 'doctrine' | 'field-decision'): void {
  if (hours <= 0) return;
  const hasFood = expedition.supplies.food > 0; const hasWater = expedition.supplies.water > 0;
  for (const id of expedition.memberIds) {
    const agent = findAgent(state, id); if (!agent?.alive) continue;
    const recovery = hours * (hasFood && hasWater ? 5.2 : hasWater ? 3.1 : 1.2);
    agent.fatigue = clamp(agent.fatigue - recovery * agentAbilityFactors(state,agent).recovery);
    agent.needs.rest = clamp(agent.needs.rest - hours * 4.5);
    if (hasFood && hasWater && agent.health < 100) agent.health = clamp(agent.health + hours * 0.18);
  }
  if (reason === 'doctrine' && expedition.lastDoctrineCampDay !== state.clock.day) {
    expedition.lastDoctrineCampDay = state.clock.day;
    addExpeditionChronicle(state, expedition.id, {
      kind: 'expedition', title: 'Doctrine camp before dark',
      text: `${expedition.id} suspended travel during darkness under camp-before-dark doctrine.`,
      entityIds: [expedition.id, ...expedition.memberIds],
    });
  }
}

export function campExpedition(state: SandboxGameState, expeditionId: string, durationHours = 6): void {
  const expedition = state.expeditions.find((entry) => entry.id === expeditionId);
  if (!expedition || !['outbound','exploring','returning'].includes(expedition.status)) throw new Error('Expedition is not available to camp.');
  if (expedition.controlMode !== 'expedition') throw new Error('Direct camp requires expedition control.');
  const hours = Math.max(1, Math.min(12, Number(durationHours) || 6));
  reserveDirectActivity(state, expedition.memberIds, 'camp', Math.round(hours * 60), `Field camp for ${hours.toFixed(1)} hours.`);
  addExpeditionChronicle(state, expedition.id, {
    kind: 'expedition', title: 'Expedition camp established',
    text: `${expedition.id} established a field camp for ${hours.toFixed(1)} hours. Travel is suspended while the party rests.`,
    entityIds: [expedition.id, ...expedition.memberIds],
  });
}

export function resolveControlledEncounterRound(state: SandboxGameState, encounterId: string): { resolved: boolean; instruction: string } {
  const encounter = state.encounters.find((entry) => entry.id === encounterId);
  if (!encounter || encounter.status === 'resolved') throw new Error('No active encounter is available.');
  const expedition = state.expeditions.find((entry) => entry.id === encounter.expeditionId);
  if (!expedition || expedition.controlMode !== 'expedition') throw new Error('Direct WEDO stepping requires expedition control.');
  const doctrine = doctrineFor(state, expedition.doctrineId);
  const living = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent?.alive));
  const minimumHealth = living.length ? Math.min(...living.map((agent) => agent.health)) : 0;
  if (minimumHealth < doctrine.retreatHealth) {
    const fallback = doctrine.prioritizeRescue ? 'protect-wounded' : 'withdraw';
    if (encounter.instruction !== fallback) setEncounterInstruction(state, encounter.id, fallback);
  }
  reserveDirectActivity(state, expedition.memberIds, 'combat', 10, `Resolved one WEDO round in ${encounter.id}.`, encounter.id);
  const result = resolveEncounterRound(state, encounter.id);
  if (result.status === 'resolved') {
    const survivors = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent?.alive));
    if (!survivors.length) expedition.status = 'destroyed';
    else if (survivors.some((agent) => agent.health < doctrine.retreatHealth)) beginOffNetworkReturn(state, expedition);
    addExpeditionChronicle(state, expedition.id, {
      kind: 'expedition',
      title: 'Encounter resolved',
      text: `${encounter.id} resolved under ${result.instruction}; ${encounter.casualties.length} expedition casualties recorded.`,
      entityIds: [encounter.id, expedition.id, ...expedition.memberIds],
    });
  }
  return { resolved: result.status === 'resolved', instruction: result.instruction };
}

function moveToward(expedition: ExpeditionState, target: SpatialRef, state: SandboxGameState, hours: number, speedMultiplier = 1, fatigueMultiplier = 1): void {
  if (expedition.position.frameId !== target.frameId) return;
  const dx = target.x - expedition.position.x; const dy = target.y - expedition.position.y; const dz = (target.z ?? 0) - (expedition.position.z ?? 0);
  const magnitude = Math.hypot(dx, dy, dz); if (magnitude <= 0.001) return;
  const members = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent): agent is SandboxAgent => Boolean(agent?.alive));
  const pace = expedition.pace ?? 'normal';
  const fatigueRate = pace === 'cautious' ? 1.15 : pace === 'fast' ? 2.35 : 1.7;
  const speedKmPerHour = expeditionTravelSpeedKmPerHour(state, expedition.memberIds, pace);
  const travel = Math.min(magnitude, speedKmPerHour * hours * clamp(speedMultiplier, 0.1, 2));
  expedition.position.x += dx / magnitude * travel; expedition.position.y += dy / magnitude * travel;
  if (expedition.position.z !== undefined || target.z !== undefined) expedition.position.z = (expedition.position.z ?? 0) + dz / magnitude * travel;
  for (const agent of members) if (agent) agent.fatigue = clamp(agent.fatigue + hours * fatigueRate * Math.max(0.1, fatigueMultiplier) / Math.max(.3,agentAbilityFactors(state,agent).physical));
}

function remainingProviderRouteRelationIds(plan: ExpeditionRoutePlan): string[] {
  if (!plan.relationIds.length) return [];
  if (plan.waypointRelationIds?.length === plan.waypoints.length) {
    const remaining = [...plan.waypointRelationIds.slice(plan.currentWaypointIndex), plan.relationIds[plan.relationIds.length - 1]!];
    return [...new Set(remaining)];
  }
  const fallbackIndex = Math.min(Math.max(0, plan.currentWaypointIndex), Math.max(0, plan.relationIds.length - 1));
  return plan.relationIds.slice(fallbackIndex);
}

function relationSignaturesFor(plan: ExpeditionRoutePlan, ids: string[]): string[] {
  const signatures = plan.relationSignatures ?? [];
  const byId = new Map(plan.relationIds.map((id, index) => [id, signatures[index] ?? '']));
  return ids.map((id) => byId.get(id) ?? '');
}

function remainingProviderRouteEvidenceIds(plan: ExpeditionRoutePlan): Set<string> {
  const ids = new Set(remainingProviderRouteRelationIds(plan));
  for (let index = plan.currentWaypointIndex; index < plan.waypointEntityIds.length; index += 1) ids.add(plan.waypointEntityIds[index]!);
  return ids;
}

function explicitImpassableRouteEvidence(state: SandboxGameState, expedition: ExpeditionState, plan: ExpeditionRoutePlan): { reason: string; evidenceIds: string[] } | undefined {
  if (expedition.communication !== 'connected') return undefined;
  const remaining = remainingProviderRouteEvidenceIds(plan);
  const observation = [...(state.externalConflictObservations ?? [])]
    .filter((entry) => entry.kind === 'route-disruption' && entry.routePassability === 'impassable' && entry.affectedRouteEntityIds.some((id) => remaining.has(id)))
    .sort((a, b) => b.providerTick - a.providerTick || b.severity - a.severity || a.id.localeCompare(b.id))[0];
  if (!observation) return undefined;
  const affected = observation.affectedRouteEntityIds.filter((id) => remaining.has(id));
  return { reason: `provider-observed routePassability=impassable for ${affected.join(', ')}`, evidenceIds: [observation.providerSourceId, ...affected, ...observation.provenanceIds] };
}

function currentPhysicalProviderRouteNode(state: SandboxGameState, expedition: ExpeditionState, projection: AreaProjection): { id: string; spatial: SpatialRef } | undefined {
  const plan = expedition.routePlan;
  if (!plan) return undefined;
  const candidates: Array<{ id: string; spatial: SpatialRef }> = projection.entities
    .filter((entity) => plan.nodeEntityIds.includes(entity.id) && entity.spatial && distance(expedition.position, entity.spatial) < 0.3)
    .map((entity) => ({ id: entity.id, spatial: structuredClone(entity.spatial!) }));
  if (plan.nodeEntityIds[0] === state.world.originEntityId && distance(expedition.position, state.settlement.position) < 0.3) {
    candidates.push({ id: state.world.originEntityId, spatial: structuredClone(state.settlement.position) });
  }
  if (plan.currentWaypointIndex > 0) {
    const index = plan.currentWaypointIndex - 1;
    const id = plan.waypointEntityIds[index];
    const spatial = plan.waypoints[index];
    if (id && spatial && plan.nodeEntityIds.includes(id) && distance(expedition.position, spatial) < 0.3) candidates.push({ id, spatial: structuredClone(spatial) });
  }
  if (expedition.destinationEntityId && expedition.destination && plan.nodeEntityIds.includes(expedition.destinationEntityId) && distance(expedition.position, expedition.destination) < 0.3) {
    candidates.push({ id: expedition.destinationEntityId, spatial: structuredClone(expedition.destination) });
  }
  return candidates.sort((a, b) => a.id.localeCompare(b.id))[0];
}

function routeReplanVisibleEntities(state: SandboxGameState, expedition: ExpeditionState, projection: AreaProjection, currentNode: { id: string; spatial: SpatialRef }): WorldEntity[] {
  const byId = new Map(projection.entities.map((entity) => [entity.id, entity]));
  if (!byId.has(currentNode.id)) byId.set(currentNode.id, { id: currentNode.id, kind: currentNode.id === state.world.originEntityId ? 'settlement' : 'known-route-node', spatial: structuredClone(currentNode.spatial), components: {}, provenanceIds: [] });
  if (expedition.destinationEntityId && expedition.destination && !byId.has(expedition.destinationEntityId)) {
    byId.set(expedition.destinationEntityId, { id: expedition.destinationEntityId, kind: 'known-destination', spatial: structuredClone(expedition.destination), components: {}, provenanceIds: [...(expedition.routePlan?.evidenceIds ?? [])] });
  }
  return [...byId.values()];
}

function replannedRouteSupplyCovered(state: SandboxGameState, expedition: ExpeditionState, plannedDistanceKm: number): boolean {
  const living = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent): agent is SandboxAgent => Boolean(agent?.alive));
  const speed = expeditionTravelSpeedKmPerHour(state, living.map((agent) => agent.id), expedition.pace ?? 'normal');
  const protectedHours = plannedDistanceKm / Math.max(0.5, speed) + LAUNCH_EMERGENCY_RESERVE_HOURS;
  const requiredFood = living.length * FIELD_FOOD_PER_PERSON_DAY * protectedHours / 24;
  const requiredWater = living.length * FIELD_WATER_PER_PERSON_DAY * protectedHours / 24;
  return expedition.supplies.food + 1e-9 >= requiredFood && expedition.supplies.water + 1e-9 >= requiredWater;
}

/**
 * Validate a persisted provider-topology itinerary before movement. Missing relations are never treated
 * as removal. Positive invalidation evidence stops movement first, then replans only when the party is
 * physically at a known provider graph node visible/known at its actual current position.
 */
function validateOrReplanProviderRoute(state: SandboxGameState, expedition: ExpeditionState, projection: AreaProjection, summary: SandboxStepSummary, allowBlockedRetry = false): boolean {
  const plan = expedition.routePlan;
  if (!plan || expedition.status !== 'outbound') return true;
  const remainingIds = remainingProviderRouteRelationIds(plan);
  const invalidations = providerVisibleRouteInvalidations(projection, remainingIds, relationSignaturesFor(plan, remainingIds));
  const impassable = explicitImpassableRouteEvidence(state, expedition, plan);
  const reasons = [
    ...invalidations.map((entry) => ({ reason: `${entry.relationId}: ${entry.reason}`, evidenceIds: entry.evidenceIds })),
    ...(impassable ? [impassable] : []),
  ];
  if (!reasons.length && plan.topologyStatus !== 'blocked') {
    plan.topologyStatus = 'active';
    plan.lastValidatedTick = projection.tick;
    return true;
  }

  const wasBlocked = plan.topologyStatus === 'blocked';
  if (wasBlocked && !allowBlockedRetry && !reasons.length) {
    plan.lastValidatedTick = projection.tick;
    return false;
  }
  const mayAttemptReplan = !wasBlocked || allowBlockedRetry;
  const evidenceIds = [...new Set(reasons.flatMap((entry) => entry.evidenceIds))];
  const reasonText = reasons.length ? reasons.map((entry) => entry.reason).join('; ') : (plan.blockedReason ?? 'previous explicit topology invalidation remains unresolved');
  plan.topologyStatus = 'blocked';
  plan.blockedAtTick ??= projection.tick;
  plan.blockedReason = reasonText;
  plan.blockedEvidenceIds = evidenceIds.length ? evidenceIds : [...(plan.blockedEvidenceIds ?? [])];
  plan.lastValidatedTick = projection.tick;

  const currentNode = currentPhysicalProviderRouteNode(state, expedition, projection);
  if (mayAttemptReplan && currentNode && expedition.destinationEntityId) {
    const visible = routeReplanVisibleEntities(state, expedition, projection, currentNode);
    const prohibited = new Set<string>([
      ...invalidations.map((entry) => entry.relationId),
      ...(impassable?.evidenceIds ?? []),
    ]);
    const alternatives = providerVisibleRouteAlternatives(projection, visible, currentNode.id, expedition.destinationEntityId, 4)
      .filter((candidate) => !candidate.relationIds.some((id) => prohibited.has(id)) && !candidate.evidenceIds.some((id) => prohibited.has(id)));
    const replacement = alternatives[0];
    if (replacement) {
      const previousRelations = [...plan.relationIds];
      const previousReplans = plan.replanCount ?? 0;
      expedition.routePlan = {
        kind: 'provider-topology', nodeEntityIds: [...replacement.nodeEntityIds], relationIds: [...replacement.relationIds], evidenceIds: [...replacement.evidenceIds],
        waypointEntityIds: [...replacement.waypointEntityIds], waypoints: structuredClone(replacement.waypoints), waypointRelationIds: [...replacement.waypointRelationIds],
        currentWaypointIndex: 0, plannedDistanceKm: replacement.distanceKm, basisTick: replacement.basisTick, relationSignatures: [...replacement.relationSignatures],
        topologyStatus: 'active', replanCount: previousReplans + 1, lastValidatedTick: projection.tick,
      };
      addExpeditionChronicle(state, expedition.id, {
        kind: 'expedition', title: 'Provider topology route replanned',
        text: `${expedition.id} stopped before traversing invalidated topology and replanned from physically occupied provider node ${currentNode.id}. ${previousRelations.join(' → ')} became ${replacement.relationIds.join(' → ')}.`,
        entityIds: [expedition.id, currentNode.id, ...previousRelations, ...replacement.evidenceIds, ...evidenceIds],
      });
      summary.expeditionUpdates.push(`${expedition.id} replanned after explicit provider topology invalidation.`);
      const supplyCovered = replannedRouteSupplyCovered(state, expedition, replacement.distanceKm);
      if (!supplyCovered) {
        beginOffNetworkReturn(state, expedition);
        addExpeditionChronicle(state, expedition.id, {
          kind: 'expedition', title: 'Replan exceeded field supply reserve',
          text: `${expedition.id} found a provider-visible detour, but remaining food/water no longer covered the replanned distance plus emergency reserve; the expedition began returning.`,
          entityIds: [expedition.id, ...replacement.evidenceIds],
        });
        summary.expeditionUpdates.push(`${expedition.id} began returning because the replanned route exceeded remaining field supply reserve.`);
      }
      return supplyCovered;
    }
  }

  if (!wasBlocked || reasons.length) {
    addExpeditionChronicle(state, expedition.id, {
      kind: 'expedition', title: 'Provider topology route blocked',
      text: `${expedition.id} stopped at its actual field position because the persisted route has explicit invalidation evidence and no provider-visible detour can be justified from a physically occupied known graph node. Missing topology was not treated as a shortcut. ${reasonText}`,
      entityIds: [expedition.id, ...remainingIds, ...evidenceIds],
    });
    summary.expeditionUpdates.push(`${expedition.id} stopped because its provider-topology route is explicitly invalid and no visible detour is justified.`);
  }
  return false;
}

function moveOutboundAlongPlannedRoute(expedition: ExpeditionState, state: SandboxGameState, movementHours: number): void {
  if (!expedition.destination || movementHours <= 0) return;
  let remainingHours = movementHours;
  const speed = expeditionTravelSpeedKmPerHour(state, expedition.memberIds, expedition.pace ?? 'normal');
  const plan = expedition.routePlan;
  if (plan) {
    while (remainingHours > 1e-9 && plan.currentWaypointIndex < plan.waypoints.length) {
      const index = plan.currentWaypointIndex;
      const waypoint = plan.waypoints[index]!;
      const segmentDistance = distance(expedition.position, waypoint);
      const segmentHours = Number.isFinite(segmentDistance) && speed > 0 ? Math.min(remainingHours, segmentDistance / speed) : remainingHours;
      moveToward(expedition, waypoint, state, segmentHours);
      remainingHours = Math.max(0, remainingHours - segmentHours);
      if (distance(expedition.position, waypoint) >= 0.3) return;
      plan.currentWaypointIndex += 1;
      const waypointEntityId = plan.waypointEntityIds[index];
      addExpeditionChronicle(state, expedition.id, {
        kind: 'expedition',
        title: 'Provider topology waypoint reached',
        text: `${expedition.id} physically reached provider-visible route waypoint ${waypointEntityId ?? index + 1}; ${plan.currentWaypointIndex}/${plan.waypoints.length} intermediate waypoints complete.`,
        entityIds: [expedition.id, ...expedition.memberIds, ...(waypointEntityId ? [waypointEntityId] : []), ...plan.relationIds],
      });
    }
    if (remainingHours > 0) moveToward(expedition, expedition.destination, state, remainingHours);
    return;
  }
  if (expedition.routeWaypoint && !expedition.routeWaypointReached) {
    const routeDistance = distance(expedition.position, expedition.routeWaypoint);
    const routeHours = Number.isFinite(routeDistance) && speed > 0 ? Math.min(remainingHours, routeDistance / speed) : remainingHours;
    moveToward(expedition, expedition.routeWaypoint, state, routeHours);
    if (distance(expedition.position, expedition.routeWaypoint) < 0.3) {
      expedition.routeWaypointReached = true;
      addExpeditionChronicle(state, expedition.id, {
        kind: 'expedition',
        title: 'Route waypoint reached',
        text: `${expedition.id} reached the deliberately selected route waypoint ${expedition.routeEntityId ?? 'known route'} and continued toward the destination.`,
        entityIds: [expedition.id, ...expedition.memberIds, ...(expedition.routeEntityId ? [expedition.routeEntityId] : [])],
      });
      remainingHours = Math.max(0, remainingHours - routeHours);
      if (remainingHours > 0) moveToward(expedition, expedition.destination, state, remainingHours);
    }
    return;
  }
  moveToward(expedition, expedition.destination, state, remainingHours);
}

function manifestSupportsSemantic(state: SandboxGameState, token: string): boolean {
  const needle = token.toLowerCase();
  return state.world.manifest.variableDefinitions.some((definition) => `${definition.id} ${definition.namespace} ${definition.semantic}`.toLowerCase().includes(needle));
}

function recordCommunicationReport(state: SandboxGameState, expedition: ExpeditionState, status: CommunicationStatus, anomalyCount: number): void {
  const reports = expedition.communicationReports ?? (expedition.communicationReports = []);
  let text = `${expedition.id} communication status: ${status}.`;
  let confidence = status === 'connected' ? 0.96 : status === 'delayed' ? 0.62 : status === 'silent' ? 0.25 : 0.18;
  let perceivedPosition: SpatialRef | undefined;
  if (status === 'falsified') {
    perceivedPosition = { ...expedition.position, x: expedition.position.x + randomInt(state, -18, 18), y: expedition.position.y + randomInt(state, -18, 18) };
    text = `Unverified relay claims ${expedition.id} is near ${perceivedPosition.x.toFixed(1)}, ${perceivedPosition.y.toFixed(1)}; the report cannot be reconciled with the last verified route.`;
    confidence = 0.28;
  } else if (status === 'altered') {
    text = anomalyCount > 0
      ? `Signal from ${expedition.id} contains anomalously repeated coordinates or phrases; content and sender state cannot be assumed authentic.`
      : `Signal from ${expedition.id} is structurally altered and cannot be authenticated.`;
    confidence = 0.2;
  }
  const report = {
    id: nextStateId(state, 'comm'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, status, text, confidence,
    ...(perceivedPosition ? { perceivedPosition } : {}), ...(status === 'connected' ? { verifiedPosition: structuredClone(expedition.position) } : {}), verified: status === 'connected', sourceIds: [expedition.id],
  };
  reports.push(report);
  if (reports.length > 80) reports.splice(0, reports.length - 80);
  if (report.verified) revealExpeditionChronicleToSettlement(state, expedition.id, report.id);
  if (status === 'falsified' || status === 'altered') {
    const entry = addObservedKnowledge(state, [state.settlement.leaderId], [expedition.id], text, confidence);
    entry.carrier = 'oral';
  }
}

function updateCommunication(state: SandboxGameState, expedition: ExpeditionState, hours: number, projection?: AreaProjection): void {
  const km = distance(state.settlement.position, expedition.position);
  const communicationSupport = anomalyCommunicationSupport(state);
  const chanceSilent = Math.max(0, clamp((km - 10) / 85, 0, 0.72) + (expedition.supplies.tools <= 0 ? 0.12 : 0) - communicationSupport);
  const anomalyCount = projection?.entities.filter((entity) => entity.kind === 'anomaly').length ?? 0;
  const hasCommunicationSemantics = manifestSupportsSemantic(state, 'communication');
  const hasAnomalySemantics = manifestSupportsSemantic(state, 'anomal');
  const roll = randomInt(state, 1, 10000) / 10000;
  const distortion = Math.min(0.18, chanceSilent * (hasCommunicationSemantics ? 0.09 : 0.02) + anomalyCount * (hasAnomalySemantics ? 0.018 : 0.006));
  let status: CommunicationStatus = 'connected';
  if (hasAnomalySemantics && anomalyCount > 0 && roll < distortion * 0.38) status = 'altered';
  else if (hasCommunicationSemantics && roll < distortion) status = 'falsified';
  else if (roll < distortion + chanceSilent * 0.12) status = 'unknown';
  else if (roll < distortion + chanceSilent * 0.42) status = 'silent';
  else if (roll < distortion + chanceSilent * 0.70) status = 'delayed';
  const previous = expedition.communication;
  expedition.communication = status;
  expedition.silentHours = status === 'connected' ? 0 : expedition.silentHours + hours;
  if (status !== previous || status === 'falsified' || status === 'altered') recordCommunicationReport(state, expedition, status, anomalyCount);
}

function entityName(entity: WorldEntity): string {
  return typeof entity.components.name === 'string' ? entity.components.name : `${entity.kind} ${entity.id}`;
}

function projectionObservationText(projection: AreaProjection): string {
  if (!projection.entities.length) return 'No provider-backed entity was observed in the nearby area.';
  return projection.entities.slice(0, 5).map((entity) => `${entityName(entity)} [${entity.kind}]`).join(', ');
}

function recordProjection(state: SandboxGameState, expedition: ExpeditionState, projection: AreaProjection, summary: SandboxStepSummary): void {
  const entityIds = projection.entities.map((entity) => entity.id).filter((id) => id !== state.world.originEntityId);
  const newIds = entityIds.filter((id) => !expedition.discoveredEntityIds.includes(id));
  expedition.discoveredEntityIds.push(...newIds);
  const text = projectionObservationText(projection);
  expedition.observations.push({
    id: nextStateId(state, 'observation'), day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, location: structuredClone(expedition.position),
    entityIds, worldObservationIds: [...projection.observationIds], text, confidence: projection.effectiveDetailRank <= 1 ? 0.82 : 0.6,
  });
  if (expedition.observations.length > 120) expedition.observations.splice(0, expedition.observations.length - 120);
  if (newIds.length) {
    addObservedKnowledge(state, expedition.memberIds, newIds, `Expedition observed: ${text}`, 0.76, undefined, [], { promoteToSettlement: false });
    summary.knowledgeUpdates.push(`${expedition.id} discovered ${newIds.join(', ')}.`);
  }
}

async function maybeIssueContactCommand(provider: WorldProvider, state: SandboxGameState, expedition: ExpeditionState, summary: SandboxStepSummary): Promise<void> {
  const order = expedition.orders.find((entry) => entry.kind === 'contact' && !entry.completed && entry.targetEntityId);
  if (!order?.targetEntityId) return;
  if (maybeRefuseOrder(state, expedition, order, summary)) return;
  const policy = doctrineFor(state, expedition.doctrineId).contactPolicy;
  if (policy === 'avoid') { order.completed = true; order.resolution = 'doctrine prevented contact'; return; }
  const providerCommandId = order.providerCommandId ?? (order.providerCommandId = nextProviderCommandId(state, `expedition-contact-${order.id}`));
  const { result } = await issueProviderCommandOnce(provider, state, {
    id: providerCommandId, issuedTick: state.clock.worldTick, issuerId: expedition.leaderId, kind: policy === 'observe' ? 'social.observe' : 'social.contact', targets: [order.targetEntityId], location: structuredClone(expedition.position),
    payload: { policy, detail: order.detail, unfounded: order.unfounded }, epistemicBasisIds: [...order.epistemicBasisIds],
  });
  // Accepted and rejected are both terminal provider receipts for this order. A deliberate retry
  // must be expressed as a new order, which receives a new stable command ID.
  order.completed = true; order.resolution = result.accepted ? 'accepted by provider' : `provider rejected: ${result.reason ?? 'unknown reason'}`;
}

function maybeHazard(state: SandboxGameState, expedition: ExpeditionState, projection: AreaProjection, hours: number, summary: SandboxStepSummary): void {
  const doctrine = doctrineFor(state, expedition.doctrineId);
  const anomalyCount = projection.entities.filter((entity) => entity.kind === 'anomaly').length;
  const unknownCount = projection.entities.filter((entity) => !expedition.discoveredEntityIds.includes(entity.id)).length;
  const pace = expedition.pace ?? 'normal';
  const paceRisk = pace === 'cautious' ? 0.72 : pace === 'fast' ? 1.38 : 1;
  const hazardChance = clamp((0.004 + anomalyCount * 0.01 + unknownCount * 0.0015 + expeditionObservedRouteConflictRisk(state, expedition)) * hours * paceRisk, 0, 0.3);
  if (!chance(state, hazardChance)) return;
  const living = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent) => Boolean(agent?.alive));
  const victim = living[randomInt(state, 0, Math.max(0, living.length - 1))]; if (!victim) return;
  const severity = randomInt(state, 4, 22); victim.health = clamp(victim.health - severity);
  summary.expeditionUpdates.push(`${victim.name} suffered a field hazard (${severity}).`);
  if (victim.health < doctrine.retreatHealth) beginOffNetworkReturn(state, expedition);
  if (chance(state, 0.06 + anomalyCount * 0.04)) {
    const encounter = createEncounter(state, expedition, doctrine.encounterInstruction, Math.max(1, randomInt(state, 1, 3)));
    summary.encounterUpdates.push(`${encounter.id} queued; awaiting high-level instruction before automatic resolution.`);
  }
}

export function markExpeditionLossState(
  state: SandboxGameState,
  expeditionId: string,
  kind: 'capture' | 'time-displacement' | 'refusal-to-return' | 'joined-community' | 'unknown',
  detail: string,
  sourceEntityIds: string[] = [],
): ExpeditionState {
  const expedition = state.expeditions.find((entry) => entry.id === expeditionId);
  if (!expedition) throw new Error(`Unknown expedition: ${expeditionId}`);
  const recoverable = kind === 'capture' || kind === 'time-displacement' || kind === 'unknown';
  interruptOffNetworkReturn(state, expedition, `Return interrupted by loss state: ${kind}.`);
  expedition.lossState = { kind, sinceDay: state.clock.day, detail, recoverable, sourceEntityIds: [...sourceEntityIds] };
  expedition.missingReason = detail;
  if (kind === 'capture') { expedition.status = 'captured'; expedition.communication = 'silent'; for (const id of expedition.memberIds) { const agent = findAgent(state, id); if (agent?.alive) agent.residence = 'unknown'; } }
  else if (kind === 'time-displacement') { expedition.status = 'time-displaced'; expedition.communication = 'altered'; for (const id of expedition.memberIds) { const agent = findAgent(state, id); if (agent?.alive) agent.residence = 'unknown'; } }
  else if (kind === 'refusal-to-return' || kind === 'joined-community') {
    expedition.status = 'joined-elsewhere'; expedition.communication = 'delayed';
    for (const id of expedition.memberIds) {
      const agent = findAgent(state, id);
      if (agent?.alive) { agent.expeditionId = null; agent.residence = 'external'; }
    }
  } else { expedition.status = 'missing'; expedition.communication = 'unknown'; for (const id of expedition.memberIds) { const agent = findAgent(state, id); if (agent?.alive) agent.residence = 'unknown'; } }
  addExpeditionChronicle(state, expedition.id, { kind: 'expedition', title: `Expedition loss state: ${kind}`, text: detail, entityIds: [expedition.id, ...expedition.memberIds, ...sourceEntityIds] }, { reportableToSettlement: false });
  return expedition;
}

export function recordExpeditionAlteration(
  state: SandboxGameState,
  expeditionId: string,
  agentId: string,
  kind: ExpeditionAlterationKind,
  detail: string,
  sourceEntityIds: string[] = [],
): void {
  const expedition = state.expeditions.find((entry) => entry.id === expeditionId);
  const agent = findAgent(state, agentId);
  if (!expedition || !agent?.alive || !expedition.memberIds.includes(agentId)) throw new Error('Expedition alteration target is unavailable.');
  let persistent = true;
  if (kind === 'memory-change') {
    const candidate = agent.memories.length ? agent.memories[randomInt(state, 0, agent.memories.length - 1)] : undefined;
    if (candidate) {
      agent.memories = agent.memories.filter((memory) => memory.id !== candidate.id);
      agent.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'trauma', text: `A discontinuity is felt around a missing memory (${candidate.kind}); the original content is no longer accessible.`, salience: 88, sourceIds: [...sourceEntityIds, expedition.id] });
    } else {
      agent.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'trauma', text: 'A subjective memory discontinuity was experienced, but no prior memory can be identified as the missing content.', salience: 72, sourceIds: [...sourceEntityIds, expedition.id] });
    }
  } else if (kind === 'personality-change') {
    const personality = agent.personality ?? (agent.personality = { curiosity: 50, caution: 50, sociability: 50, autonomy: 50, empathy: 50 });
    const axes = ['curiosity','caution','sociability','autonomy','empathy'] as const;
    const axis = axes[randomInt(state, 0, axes.length - 1)] ?? 'autonomy';
    let delta = randomInt(state, -24, 24); if (Math.abs(delta) < 8) delta = delta < 0 ? -8 : 8;
    personality[axis] = clamp(personality[axis] + delta);
    detail = `${detail} Persistent ${axis} shift ${delta > 0 ? '+' : ''}${delta}.`;
  } else if (kind === 'body-change') {
    const sourceTag = sourceEntityIds[0]?.replace(/[^a-zA-Z0-9_-]/g, '-') ?? 'unresolved';
    const tag = `field-body-change:${sourceTag}`;
    if (!agent.genetics.anomalyTraits.includes(tag)) agent.genetics.anomalyTraits.push(tag);
    const delta = randomInt(state, -12, 8); agent.health = clamp(agent.health + delta);
    detail = `${detail} Body-state marker ${tag}; immediate health delta ${delta}.`;
  } else if (kind === 'parasitism') {
    const sourceTag = sourceEntityIds[0]?.replace(/[^a-zA-Z0-9_-]/g, '-') ?? 'unknown';
    const pathologyId = `anomalous-parasitism:${sourceTag}`;
    if (!agent.pathology.some((entry) => entry.pathologyId === pathologyId && entry.status === 'active')) {
      agent.pathology.push({ id: nextStateId(state, 'case'), pathologyId, onsetDay: state.clock.day, severity: randomInt(state, 12, 48), contagious: false, observedSymptoms: ['foreign-organism/structure indicators'], suspectedCauses: [...sourceEntityIds], treatmentsTried: [], status: 'active' });
    }
  } else if (kind === 'anomalous-pregnancy') {
    const ongoing = state.pregnancies.find((entry) => entry.outcome === 'ongoing' && entry.pregnantAgentId === agent.id);
    const male = expedition.memberIds.map((id) => findAgent(state, id)).find((entry) => entry?.alive && entry.sex === 'male' && entry.id !== agent.id);
    const tag = `field-conception:${sourceEntityIds[0] ?? expedition.id}`;
    if (ongoing) {
      if (!ongoing.anomalyTags.includes(tag)) ongoing.anomalyTags.push(tag);
    } else if (agent.sex === 'female' && male && Math.floor((state.clock.day - agent.bornDay) / 365) >= 18 && Math.floor((state.clock.day - agent.bornDay) / 365) <= 45) {
      state.pregnancies.push({ id: nextStateId(state, 'pregnancy'), parentIds: [agent.id, male.id], pregnantAgentId: agent.id, conceptionDay: state.clock.day, expectedDay: state.clock.day + randomInt(state, 266, 286), outcome: 'ongoing', anomalyTags: [tag] });
    } else {
      persistent = false;
      detail = `${detail} No physiologically established pregnancy was produced in the current party state.`;
    }
  }
  const alterations = expedition.alterations ?? (expedition.alterations = []);
  alterations.push({ id: nextStateId(state, 'alteration'), day: state.clock.day, kind, agentId, detail, sourceEntityIds: [...sourceEntityIds], persistent });
  if (alterations.length > 80) alterations.splice(0, alterations.length - 80);
  addExpeditionChronicle(state, expedition.id, { kind: kind === 'parasitism' || kind === 'anomalous-pregnancy' ? 'medicine' : 'expedition', title: `Expedition alteration: ${kind}`, text: `${agent.name}: ${detail}`, entityIds: [expedition.id, agent.id, ...sourceEntityIds] });
}

function maybeAnomalousAlteration(state: SandboxGameState, expedition: ExpeditionState, anomalies: WorldEntity[], hours: number, summary: SandboxStepSummary): void {
  if (!anomalies.length || !chance(state, Math.min(0.018, anomalies.length * hours * 0.00006))) return;
  const members = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent?.alive));
  const victim = members[randomInt(state, 0, Math.max(0, members.length - 1))]; if (!victim) return;
  const kinds: ExpeditionAlterationKind[] = ['memory-change','personality-change','body-change','anomalous-pregnancy','parasitism'];
  let kind = kinds[randomInt(state, 0, kinds.length - 1)] ?? 'body-change';
  if (kind === 'anomalous-pregnancy' && victim.sex !== 'female') kind = 'body-change';
  recordExpeditionAlteration(state, expedition.id, victim.id, kind, 'Provider-projected anomalous exposure changed the party member without assigning moral value to the effect.', anomalies.map((entry) => entry.id));
  summary.expeditionUpdates.push(`${expedition.id}: ${victim.name} underwent ${kind}.`);
}

function maybeExceptionalLossState(state: SandboxGameState, expedition: ExpeditionState, projection: AreaProjection, hours: number, summary: SandboxStepSummary): void {
  if (!['outbound','exploring','returning'].includes(expedition.status)) return;
  const anomalies = projection.entities.filter((entity) => entity.kind === 'anomaly');
  const societies = projection.entities.filter((entity) => entity.kind === 'settlement' || entity.kind === 'organization' || entity.kind === 'polity');
  maybeAnomalousAlteration(state, expedition, anomalies, hours, summary);
  if (anomalies.length && chance(state, Math.min(0.025, anomalies.length * hours * 0.00008))) {
    markExpeditionLossState(state, expedition.id, 'time-displacement', 'The party vanished across a locally inconsistent time interval; its last coordinates remain physically meaningful but its current time is unverified.', anomalies.map((entry) => entry.id));
    summary.expeditionUpdates.push(`${expedition.id} entered a time-displaced loss state.`);
    return;
  }
  const doctrine = doctrineFor(state, expedition.doctrineId);
  if (societies.length && doctrine.contactPolicy === 'assertive' && chance(state, Math.min(0.02, hours * 0.00006 * societies.length * (0.5 + doctrine.riskTolerance)))) {
    markExpeditionLossState(state, expedition.id, 'capture', 'Contact escalated into detention/capture; the party remains alive but ordinary command and communication are unavailable.', societies.map((entry) => entry.id));
    summary.expeditionUpdates.push(`${expedition.id} was captured after external contact.`);
    return;
  }
  const members = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent) => Boolean(agent?.alive));
  const avgBelongingNeed = members.reduce((sum, agent) => sum + (agent?.needs.belonging ?? 0), 0) / Math.max(1, members.length);
  const avgMorale = members.reduce((sum, agent) => sum + (agent?.morale ?? 50), 0) / Math.max(1, members.length);
  if (societies.length && expedition.status === 'returning' && avgBelongingNeed > 82 && avgMorale < 24 && chance(state, Math.min(0.08, hours * 0.00025))) {
    markExpeditionLossState(state, expedition.id, 'refusal-to-return', 'The surviving party refused the return order and integrated into another community. This is a social outcome, not a game-over flag.', societies.map((entry) => entry.id));
    summary.expeditionUpdates.push(`${expedition.id} refused return and joined an external community.`);
  }
}

function relationTrustToIssuer(state: SandboxGameState, expedition: ExpeditionState, issuerId: string): number {
  const leader = findAgent(state, expedition.leaderId);
  if (!leader) return 0;
  if (leader.id === issuerId) return 100;
  return leader.relations.find((relation) => relation.targetId === issuerId)?.trust ?? 35;
}

function maybeRefuseOrder(state: SandboxGameState, expedition: ExpeditionState, order: ExpeditionOrder, summary?: SandboxStepSummary): boolean {
  const leader = findAgent(state, expedition.leaderId);
  if (!leader?.alive) return false;
  const trust = relationTrustToIssuer(state, expedition, order.issuerId);
  const compliance = leader.authority.obedience * 0.46 + leader.morale * 0.34 + trust * 0.20 - (leader.personality?.autonomy ?? 50) * 0.12 - (order.unfounded ? 36 : 0);
  const threshold = leader.authority.refusalThreshold * 0.72;
  if (compliance >= threshold) return false;
  order.completed = true; order.refused = true; order.resolution = `refused: compliance ${compliance.toFixed(1)} < threshold ${threshold.toFixed(1)}`;
  leader.memories.push({ id: nextStateId(state, 'memory'), day: state.clock.day, kind: 'order', text: `Refused order ${order.id}: ${order.detail}`, salience: order.unfounded ? 76 : 58, sourceIds: [order.id, order.issuerId] });
  if (leader.memories.length > 80) leader.memories.splice(0, leader.memories.length - 80);
  leader.authority.obedience = clamp(leader.authority.obedience - (order.unfounded ? 1.5 : 0.4));
  summary?.expeditionUpdates.push(`${expedition.id} refused ${order.kind} order${order.unfounded ? ' as epistemically unfounded' : ''}.`);
  addExpeditionChronicle(state, expedition.id, { kind: 'expedition', title: 'Expedition order refused', text: `${leader.name} refused ${order.kind}: ${order.detail}${order.unfounded ? ' The order lacked an in-world epistemic basis.' : ''}`, entityIds: [expedition.id, leader.id, order.id] });
  return true;
}

function advanceOrders(state: SandboxGameState, expedition: ExpeditionState, summary: SandboxStepSummary): void {
  const order = expedition.orders.find((entry) => !entry.completed && entry.kind !== 'contact');
  if (!order) return;
  if (maybeRefuseOrder(state, expedition, order, summary)) return;
  if (order.kind === 'return') { interruptActiveFieldDecision(state, expedition, 'Superseded by an accepted return order.'); beginOffNetworkReturn(state, expedition); order.completed = true; order.resolution = 'accepted'; }
  if (order.kind === 'hold' || order.kind === 'camp' || order.kind === 'observe' || order.kind === 'avoid') {
    order.completed = true; order.resolution = 'accepted';
    if (order.kind === 'camp') {
      reserveDirectActivity(state, expedition.memberIds, 'camp', 360, 'Field camp established from an accepted expedition order.');
      addExpeditionChronicle(state, expedition.id, { kind: 'expedition', title: 'Expedition camp established', text: `${expedition.id} established a six-hour field camp.`, entityIds: [expedition.id, order.id, ...expedition.memberIds] });
    }
  }
  if (order.kind === 'move' && order.target) {
    expedition.destination = structuredClone(order.target); expedition.status = 'outbound'; delete expedition.arrivedDay; delete expedition.arrivedMinute;
    if (order.targetEntityId) expedition.destinationEntityId = order.targetEntityId; else delete expedition.destinationEntityId;
    delete expedition.routeEntityId; delete expedition.routeWaypoint; delete expedition.routeWaypointReached; delete expedition.routePlan; delete expedition.returnTravelMode; delete expedition.returnTravel;
    if (distance(expedition.position, order.target) < 0.3) {
      order.completed = true; order.resolution = 'arrived';
      addExpeditionChronicle(state, expedition.id, { kind: 'expedition', title: 'Expedition arrived at ordered position', text: `${expedition.id} reached the ordered field position.`, entityIds: [expedition.id, order.id, ...expedition.memberIds] });
    }
  }
}

function maybeTurnBackForSupplyReserve(state: SandboxGameState, expedition: ExpeditionState, doctrine: ExpeditionDoctrine, summary: SandboxStepSummary): void {
  if (expedition.status === 'returning') return;
  const living = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent): agent is SandboxAgent => Boolean(agent?.alive));
  if (!living.length) return;
  const speed = expeditionTravelSpeedKmPerHour(state, living.map((agent) => agent.id), expedition.pace ?? 'normal');
  const returnHours = distance(expedition.position, state.settlement.position) / speed;
  const reserveHours = 4 + (1 - doctrine.riskTolerance) * 8;
  const protectedHours = Math.max(0, returnHours) + reserveHours;
  const requiredFood = living.length * FIELD_FOOD_PER_PERSON_DAY * protectedHours / 24;
  const requiredWater = living.length * FIELD_WATER_PER_PERSON_DAY * protectedHours / 24;
  if (expedition.supplies.food + 1e-9 >= requiredFood && expedition.supplies.water + 1e-9 >= requiredWater) return;
  interruptActiveFieldDecision(state, expedition, 'Interrupted by field-supply reserve doctrine.');
  beginOffNetworkReturn(state, expedition);
  const limiting = expedition.supplies.water < requiredWater ? 'water' : 'food';
  addExpeditionChronicle(state, expedition.id, {
    kind: 'expedition',
    title: 'Supply reserve turnback',
    text: `${expedition.id} began returning before depletion because ${limiting} reserves no longer covered the estimated route home plus doctrine safety margin.`,
    entityIds: [expedition.id, ...living.map((agent) => agent.id)],
  });
  summary.expeditionUpdates.push(`${expedition.id} began returning under field-supply reserve doctrine.`);
}

function finishReturn(state: SandboxGameState, expedition: ExpeditionState, summary: SandboxStepSummary): void {
  interruptActiveFieldDecision(state, expedition, 'Expedition returned before the field decision completed.');
  completeOffNetworkReturn(state, expedition);
  resolveRendezvousRequest(expedition, 'Resolved when the requesting expedition physically returned to the settlement.');
  expedition.status = 'returned'; expedition.returnDay = state.clock.day; expedition.communication = 'connected'; expedition.position = structuredClone(state.settlement.position);
  for (const id of expedition.memberIds) { const agent = findAgent(state, id); if (agent) { agent.expeditionId = null; agent.residence = 'settlement'; } }
  const returnedResourceLots = depositCarriedResourcesAtSettlement(state, expedition.memberIds);
  if (returnedResourceLots.length) summary.expeditionUpdates.push(`${expedition.id} returned ${returnedResourceLots.length} provenance-tracked resource lot(s).`);
  delete expedition.routeEntityId; delete expedition.routeWaypoint; delete expedition.routeWaypointReached; delete expedition.routePlan;
  adjustResourceStock(state, 'food', expedition.supplies.food, 'Expedition return'); adjustResourceStock(state, 'water', expedition.supplies.water, 'Expedition return'); adjustResourceStock(state, 'medicine', expedition.supplies.medicine, 'Expedition return'); adjustResourceStock(state, 'scrap', expedition.supplies.tools, 'Expedition return');
  summary.expeditionUpdates.push(`${expedition.id} returned.`);
  revealExpeditionChronicleToSettlement(state, expedition.id, `return:${expedition.id}:${state.clock.day}:${state.clock.minuteOfDay}`, { includeNonRoutine: true });
  addChronicle(state, { kind: 'expedition', title: 'Expedition returned', text: `${expedition.id} returned with ${expedition.observations.length} observations.`, entityIds: [expedition.id, ...expedition.memberIds] });
}


function assessMissing(state: SandboxGameState, expedition: ExpeditionState, hours: number, summary: SandboxStepSummary): void {
  const doctrine = doctrineFor(state, expedition.doctrineId);
  if (!['silent','unknown','altered'].includes(expedition.communication)) return;
  if (expedition.silentHours <= doctrine.maxSilentHours * 3) return;
  if (!chance(state, Math.min(0.15, hours / 48))) return;
  const reason = expedition.communication === 'unknown' ? 'communication and location are both unverified' : expedition.communication === 'altered' ? 'communication is anomalously altered and current party state is unverified' : 'extended communication loss';
  markExpeditionLossState(state, expedition.id, 'unknown', reason);
  summary.expeditionUpdates.push(`${expedition.id} is now missing.`);
}

export async function simulateExpeditionsInterval(provider: WorldProvider, state: SandboxGameState, hours: number, summary: SandboxStepSummary): Promise<void> {
  for (const expedition of state.expeditions.filter((entry) => ['outbound','exploring','returning'].includes(entry.status))) {
    const livingMembers = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent) => Boolean(agent?.alive));
    if (livingMembers.length === 0) {
      expedition.status = 'destroyed';
      expedition.communication = 'unknown';
      for (const id of expedition.memberIds) { const agent = findAgent(state, id); if (agent) { agent.expeditionId = null; agent.residence = 'unknown'; } }
      summary.expeditionUpdates.push(`${expedition.id} has no surviving members.`);
      continue;
    }
    const unresolvedEncounter = [...state.encounters].reverse().find((entry) => entry.expeditionId === expedition.id && entry.status !== 'resolved');
    if (unresolvedEncounter) {
      if (expedition.controlMode === 'expedition') {
        consumeSupplies(expedition, hours);
        updateCommunication(state, expedition, hours);
        continue;
      }
      for (let rounds = 0; rounds < 4 && unresolvedEncounter.status !== 'resolved'; rounds += 1) resolveEncounterRound(state, unresolvedEncounter.id, summary);
      if (unresolvedEncounter.status !== 'resolved') {
        consumeSupplies(expedition, hours);
        updateCommunication(state, expedition, hours);
        continue;
      }
    }
    const doctrine = doctrineFor(state, expedition.doctrineId);
    ensureLegacyResponderRendezvousPlan(state, expedition, expedition.destination ? distance(expedition.position, expedition.destination) / Math.max(0.5, expeditionTravelSpeedKmPerHour(state, expedition.memberIds, expedition.pace ?? 'normal')) : 0);
    const reservedHours = reservedHoursDuringCurrentInterval(state, expedition.leaderId, hours);
    const directCampHours = reservedHoursByKindDuringCurrentInterval(state, expedition.leaderId, 'camp', hours);
    const doctrineCampHours = doctrine.campBeforeDark ? Math.max(0, nightHoursDuringCurrentInterval(state, hours) - directCampHours) : 0;
    const fieldCampHours = activeBlockedCampHours(expedition, hours);
    const movementHours = Math.max(0, hours - reservedHours - doctrineCampHours - fieldCampHours);
    consumeSupplies(expedition, hours);
    applyCampRest(state, expedition, directCampHours, 'direct');
    applyCampRest(state, expedition, doctrineCampHours, 'doctrine');
    applyCampRest(state, expedition, fieldCampHours, 'field-decision');
    advanceBlockedCampDecision(state, expedition, fieldCampHours);
    maybeTurnBackForSupplyReserve(state, expedition, doctrine, summary);
    syncResponderTurnback(state, expedition, 'Responder field supplies no longer cover the physical return reserve.');
    if (expedition.supplies.food <= 0 || expedition.supplies.water <= 0) {
      for (const id of expedition.memberIds) { const agent = findAgent(state, id); if (agent?.alive) agent.health = clamp(agent.health - hours * (expedition.supplies.water <= 0 ? 1.8 : 0.7)); }
      if (doctrine.riskTolerance < 0.8) { interruptActiveFieldDecision(state, expedition, 'Interrupted because field supplies were depleted.'); beginOffNetworkReturn(state, expedition); }
    }
    let routeMovementAllowed = true;
    const retryRequested = blockedRetryRequested(expedition);
    if (expedition.status === 'outbound' && expedition.routePlan) {
      const routeProjection = await provider.queryArea({ center: structuredClone(expedition.position), radiusKm: 12, requestedDetailRank: 0, observerId: expedition.leaderId, includeKnowledgeProjection: true });
      routeMovementAllowed = validateOrReplanProviderRoute(state, expedition, routeProjection, summary, retryRequested);
      if (retryRequested) {
        const routeActive = expedition.routePlan?.topologyStatus === 'active';
        const retrySucceeded = routeActive && routeMovementAllowed;
        completeRetryDecision(state, expedition, retrySucceeded, retrySucceeded
          ? 'Provider-visible route replanning succeeded from the unchanged physical position.'
          : routeActive
            ? 'A provider-visible detour was found, but remaining field supplies forced a return instead of outbound recommitment.'
            : 'No provider-visible traversable route could be justified from the unchanged physical position.');
      }
    }
    const haltedByBlockedRoute = expedition.status === 'outbound' && expedition.routePlan?.topologyStatus === 'blocked' && !routeMovementAllowed;
    let returnPreProjection: AreaProjection | undefined;
    let returnTerrain = undefined as ReturnType<typeof providerReturnTerrainAssessment> | undefined;
    let returnDistanceBefore = 0;
    const searchWaypoint = rendezvousSearchWaypoint(expedition);
    if (expedition.status === 'returning') {
      beginOffNetworkReturn(state, expedition);
      returnPreProjection = await provider.queryArea({ center: structuredClone(expedition.position), radiusKm: 5, requestedDetailRank: 0, observerId: expedition.leaderId, includeKnowledgeProjection: true });
      returnTerrain = providerReturnTerrainAssessment(returnPreProjection);
      returnDistanceBefore = distance(expedition.position, state.settlement.position);
      const fatigueMultiplier = 1 + returnTerrain.risk * 0.65;
      moveToward(expedition, state.settlement.position, state, movementHours, returnTerrain.speedFactor, fatigueMultiplier);
    }
    else if (rendezvousFreezesMovement(expedition)) {
      // Waiting/contact phases are physical holds at the evidence/contact point.
    }
    else if (searchWaypoint) moveToward(expedition, searchWaypoint, state, movementHours * 0.78, 1.08);
    else if (expedition.destination && routeMovementAllowed) moveOutboundAlongPlannedRoute(expedition, state, movementHours);
    else if (haltedByBlockedRoute) {
      // Explicitly blocked provider topology freezes outbound movement. The party remains at its actual position.
      // Once blocked, route planning is retried only by an explicit retry-replan field decision.
    } else {
      const driftTarget: SpatialRef = { ...expedition.position, x: expedition.position.x + randomInt(state, -2, 2), y: expedition.position.y + randomInt(state, -2, 2) };
      moveToward(expedition, driftTarget, state, movementHours * 0.6);
    }
    const projection = await provider.queryArea({ center: structuredClone(expedition.position), radiusKm: 5, requestedDetailRank: 0, observerId: expedition.leaderId, includeKnowledgeProjection: true });
    updateCommunication(state, expedition, hours, projection);
    promoteRendezvousRequestAfterVerifiedLink(state, expedition);
    if (expedition.status === 'returning' && returnPreProjection && returnTerrain) {
      recordOffNetworkReturnProgress(state, expedition, returnDistanceBefore, distance(expedition.position, state.settlement.position), returnPreProjection, returnTerrain);
      const shelteredHours = Math.min(hours, directCampHours + doctrineCampHours);
      applyProviderBoundedFieldExposure(state, expedition, projection, shelteredHours, true, summary);
      applyProviderBoundedFieldExposure(state, expedition, projection, Math.max(0, hours - shelteredHours), false, summary);
    }
    if (haltedByBlockedRoute) {
      const shelteredHours = Math.min(hours, directCampHours + doctrineCampHours + fieldCampHours);
      applyProviderBoundedFieldExposure(state, expedition, projection, shelteredHours, true, summary);
      applyProviderBoundedFieldExposure(state, expedition, projection, Math.max(0, hours - shelteredHours), false, summary);
    }
    if (expedition.rendezvousPlan && ['waiting','searching'].includes(expedition.rendezvousPlan.status)) {
      applyProviderBoundedFieldExposure(state, expedition, projection, hours, false, summary);
      const minimumHealth = Math.min(...expedition.memberIds.map((id) => findAgent(state, id)?.health ?? 100));
      const exposureAbortDose = 7.5 + doctrine.riskTolerance * 2;
      if ((expedition.fieldExposure?.cumulativeDose ?? 0) >= exposureAbortDose || minimumHealth < doctrine.retreatHealth) {
        syncResponderTurnback(state, expedition, 'Responder exposure/health state crossed the doctrine field-safety boundary.');
        if (expedition.status !== 'returning') {
          beginOffNetworkReturn(state, expedition);
          syncResponderTurnback(state, expedition, 'Responder exposure/health state crossed the doctrine field-safety boundary.');
        }
      }
    }
    if (expedition.communication !== 'connected' && expedition.silentHours > doctrine.maxSilentHours && expedition.status !== 'returning' && !(expedition.rescueOfExpeditionId && doctrine.prioritizeRescue)) {
      interruptActiveFieldDecision(state, expedition, 'Interrupted by the expedition doctrine communication limit.');
      beginOffNetworkReturn(state, expedition);
      addExpeditionChronicle(state, expedition.id, { kind: 'expedition', title: 'Doctrine communication limit reached', text: `${expedition.id} began returning after ${expedition.silentHours.toFixed(1)} silent/unverified hours exceeded doctrine limit ${doctrine.maxSilentHours}.`, entityIds: [expedition.id, ...expedition.memberIds] });
      summary.expeditionUpdates.push(`${expedition.id} began returning under max-silent-hours doctrine.`);
    }
    recordProjection(state, expedition, projection, summary);
    await maybeIssueContactCommand(provider, state, expedition, summary);
    maybeHazard(state, expedition, projection, haltedByBlockedRoute ? 0 : movementHours, summary);
    maybeExceptionalLossState(state, expedition, projection, movementHours, summary);
    if (!['outbound','exploring','returning'].includes(expedition.status)) continue;
    advanceOrders(state, expedition, summary);
    if (expedition.status === 'outbound' && expedition.destination && distance(expedition.position, expedition.destination) < 0.3) {
      expedition.status = 'exploring'; expedition.arrivedDay = state.clock.day; expedition.arrivedMinute = state.clock.minuteOfDay;
      delete expedition.destinationEntityId;
      delete expedition.routeEntityId;
      delete expedition.routeWaypoint;
      delete expedition.routeWaypointReached;
      delete expedition.routePlan;
      addExpeditionChronicle(state, expedition.id, {
        kind: 'expedition',
        title: 'Expedition arrived at destination',
        text: `${expedition.id} reached its ordered destination and began local exploration.`,
        entityIds: [expedition.id, ...expedition.memberIds],
      });
    }
    if (expedition.rendezvousPlan && !['aborted','completed'].includes(expedition.rendezvousPlan.status)) advanceRendezvousLifecycle(state, expedition, projection, hours, summary);
    if (expedition.status === 'returning' && distance(expedition.position, state.settlement.position) < 0.3) finishReturn(state, expedition, summary);
    assessMissing(state, expedition, hours, summary);
  }
}

export function launchRescueExpedition(state: SandboxGameState, missingExpeditionId: string, leaderId: string, memberIds: string[], controlMode: ExpeditionControlMode = 'expedition'): ExpeditionState {
  const missing = state.expeditions.find((entry) => entry.id === missingExpeditionId);
  if (!missing || ['returned','destroyed','joined-elsewhere'].includes(missing.status)) throw new Error('Rescue target is not available for a field search.');
  const communicationLoss = ['silent','unknown','altered','delayed'].includes(missing.communication) || missing.silentHours > 0;
  const classifiedRecoverable = ['missing','captured','time-displaced'].includes(missing.status);
  const rendezvousPosition = transmittedRendezvousPosition(missing);
  if (!communicationLoss && !classifiedRecoverable && !rendezvousPosition) throw new Error('No observable communication-loss or transmitted rendezvous evidence supports a rescue search.');
  const doctrine = state.doctrines.find((entry) => entry.prioritizeRescue) ?? state.doctrines[0];
  if (!doctrine) throw new Error('No doctrine available for rescue expedition.');
  const verified = [...(missing.communicationReports ?? [])].reverse().find((entry) => entry.verified && entry.verifiedPosition);
  const searchTarget = rendezvousPosition ?? verified?.verifiedPosition ?? missing.destination ?? state.settlement.position;
  const responder = launchExpedition(state, { leaderId, memberIds, controlMode, doctrineId: doctrine.id, destination: structuredClone(searchTarget), rescueOfExpeditionId: missing.id });
  const evidence = missing.rendezvousRequest?.status === 'transmitted' && missing.rendezvousRequest.verifiedPosition
    ? {
        id: missing.rendezvousRequest.id,
        day: missing.rendezvousRequest.transmittedDay ?? missing.rendezvousRequest.requestedDay,
        minute: missing.rendezvousRequest.transmittedMinute ?? missing.rendezvousRequest.requestedMinute,
        position: missing.rendezvousRequest.verifiedPosition,
        sourceIds: [missing.rendezvousRequest.id, missing.id],
      }
    : verified?.verifiedPosition
      ? { id: verified.id, day: verified.day, minute: verified.minuteOfDay, position: verified.verifiedPosition, sourceIds: [verified.id, ...verified.sourceIds] }
      : { id: `intended-search-area:${missing.id}`, day: state.clock.day, minute: state.clock.minuteOfDay, position: searchTarget, sourceIds: [missing.id] };
  const etaHours = distance(state.settlement.position, searchTarget) / Math.max(0.5, expeditionTravelSpeedKmPerHour(state, responder.memberIds, responder.pace ?? 'normal'));
  const plan = createResponderRendezvousPlan(state, responder, missing.id, evidence, etaHours);
  if (missing.destination) {
    plan.intendedTargetPosition = structuredClone(missing.destination);
    plan.intendedTargetSourceIds = [`intended-route:${missing.id}`];
  }
  return responder;
}

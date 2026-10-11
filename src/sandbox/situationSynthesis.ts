import type { AreaProjection } from '../worldbridge/contract.js';
import { findAgent, settlementAgents } from './stateUtils.js';
import type { ExpeditionState, SandboxGameState } from './types.js';
import { recentObservedConflict } from './externalConflictSimulation.js';

export type SituationSeverity = 'info' | 'watch' | 'urgent';
export interface SituationSignal {
  id: string;
  severity: SituationSeverity;
  title: string;
  detail: string;
  basisIds: string[];
}

function pushUnique(signals: SituationSignal[], signal: SituationSignal): void {
  if (!signals.some((entry) => entry.id === signal.id)) signals.push(signal);
}

function settlementSignals(state: SandboxGameState): SituationSignal[] {
  const signals: SituationSignal[] = [];
  const locals = settlementAgents(state);
  const population = Math.max(1, locals.length);
  const r = state.settlement.resources;
  if (r.water < population * 1.5) pushUnique(signals, { id: 'settlement:water-low', severity: 'urgent', title: 'Accessible water reserve is low', detail: `${r.water.toFixed(0)} water remains for ${population} local people.`, basisIds: [state.settlement.id] });
  else if (r.water < population * 3) pushUnique(signals, { id: 'settlement:water-watch', severity: 'watch', title: 'Water reserve is narrowing', detail: `${r.water.toFixed(0)} water remains for ${population} local people.`, basisIds: [state.settlement.id] });
  if (r.food < population * 1.5) pushUnique(signals, { id: 'settlement:food-low', severity: 'urgent', title: 'Accessible food reserve is low', detail: `${r.food.toFixed(0)} food remains for ${population} local people.`, basisIds: [state.settlement.id] });
  const visibleCases = locals.flatMap((agent) => agent.pathology.filter((entry) => entry.status === 'active').map((entry) => ({ agent, entry })));
  const injuries = visibleCases.filter(({ entry }) => entry.pathologyId === 'traumatic-wound');
  const illnesses = visibleCases.filter(({ entry }) => entry.pathologyId !== 'traumatic-wound');
  if (injuries.length) {
    const severe = injuries.filter(({ entry }) => entry.severity >= 55).length;
    pushUnique(signals, { id: 'settlement:injury', severity: severe ? 'urgent' : 'watch', title: severe ? 'Severe recorded injury needs attention' : 'Recorded injury is recovering', detail: `${injuries.length} locally observable traumatic wound(s); ${severe} severe.`, basisIds: injuries.map(({ agent }) => agent.id) });
  }
  if (illnesses.length) {
    const severe = illnesses.filter(({ entry }) => entry.severity >= 55).length;
    pushUnique(signals, { id: 'settlement:pathology', severity: severe ? 'urgent' : 'watch', title: severe ? 'Severe recorded illness needs attention' : 'Recorded illness is active', detail: `${illnesses.length} locally observable illness/infection case(s); ${severe} severe.`, basisIds: illnesses.map(({ agent }) => agent.id) });
  }
  const displacedHouseholds = state.settlement.households.filter((household) => household.displacement?.status === 'displaced');
  if (displacedHouseholds.length) {
    const members = displacedHouseholds.flatMap((household) => household.displacement?.displacedMemberIds ?? []);
    pushUnique(signals, {
      id: 'settlement:displaced-households', severity: 'urgent',
      title: 'Provider-confirmed households remain displaced',
      detail: `${displacedHouseholds.length} household${displacedHouseholds.length===1?' remains':'s remain'} in an explicit provider-observed displacement episode (${members.length} originally present member${members.length===1?'':'s'}). Individual displacement evidence alone never creates this household state.`,
      basisIds: displacedHouseholds.map((household) => household.id),
    });
  }
  const recentlyReturnedHouseholds = state.settlement.households.filter((household) => household.displacement?.status === 'returned' && Number(household.displacement.returnedDay ?? -999) >= state.clock.day - 2);
  if (recentlyReturnedHouseholds.length) {
    pushUnique(signals, {
      id: 'settlement:household-displacement-returns', severity: 'info',
      title: 'Provider-confirmed households have returned',
      detail: `${recentlyReturnedHouseholds.length} household${recentlyReturnedHouseholds.length===1?' has':'s have'} an explicit observed return after an explicit household displacement episode. Only members actually displaced in that episode are eligible to re-enter from unknown residence.`,
      basisIds: recentlyReturnedHouseholds.map((household) => household.id),
    });
  }
  const displacedLocals = state.agents.filter((agent) => agent.alive && agent.residence === 'unknown' && Number(agent.experience['displacement:observed-day'] ?? -1) > 0);
  if (displacedLocals.length) {
    pushUnique(signals, {
      id: 'settlement:displaced-residents', severity: 'urgent',
      title: 'Residents remain displaced / whereabouts unknown',
      detail: `${displacedLocals.length} locally known resident${displacedLocals.length===1?' remains':'s remain'} outside ordinary settlement labor, food, water and care systems. Time passage alone does not establish a return.`,
      basisIds: displacedLocals.map((agent) => agent.id),
    });
  }
  const recentReturns = locals.filter((agent) => Number(agent.experience['displacement:return-day'] ?? -999) >= state.clock.day - 2);
  if (recentReturns.length) {
    pushUnique(signals, {
      id: 'settlement:displacement-returns', severity: 'info',
      title: 'Provider-observed returns are re-entering settlement life',
      detail: `${recentReturns.length} previously displaced resident${recentReturns.length===1?' has':'s have'} an explicit observed return and now rejoin ordinary local labor, food, water and care systems.`,
      basisIds: recentReturns.map((agent) => agent.id),
    });
  }
  const recentMigrants = locals.filter((agent) => Number(agent.experience['migration:arrival-day'] ?? -999) >= state.clock.day - 2);
  if (recentMigrants.length) {
    const occupancy = locals.length / Math.max(1, state.settlement.housingCapacity);
    pushUnique(signals, {
      id: 'settlement:recent-migration', severity: occupancy > .95 ? 'watch' : 'info',
      title: 'Negotiated arrivals are entering settlement life',
      detail: `${recentMigrants.length} recent migrant(s); local population ${locals.length}/${state.settlement.housingCapacity} housing capacity. They now share ordinary food, water, labor and care systems.`,
      basisIds: recentMigrants.map((agent) => agent.id),
    });
  }
  const observedExternalConflict = [...recentObservedConflict(state)].sort((a, b) => b.severity - a.severity || b.day - a.day)[0];
  if (observedExternalConflict) {
    const urgent = observedExternalConflict.severity >= 70;
    pushUnique(signals, {
      id: `external-observed-conflict:${observedExternalConflict.id}`, severity: urgent ? 'urgent' : 'watch',
      title: `Provider-observed external ${observedExternalConflict.kind}`,
      detail: `Observed severity ${observedExternalConflict.severity.toFixed(0)} from ${observedExternalConflict.sourceEntityId}.${observedExternalConflict.affectedRouteEntityIds.length ? ` Explicit affected route/entity reference(s): ${observedExternalConflict.affectedRouteEntityIds.join(', ')}.` : ''}${observedExternalConflict.injuredIndividualIds.length ? ` Explicit injured local ID reference(s): ${observedExternalConflict.injuredIndividualIds.join(', ')}.` : ''}`,
      basisIds: [...observedExternalConflict.provenanceIds],
    });
  }
  const externalPressure = state.externalActors.filter((entry) => entry.confidence >= 0.45 && entry.conflictPressure >= 20).sort((a, b) => b.conflictPressure - a.conflictPressure)[0];
  if (externalPressure) {
    const urgent = externalPressure.conflictPressure >= 60;
    pushUnique(signals, {
      id: `external-pressure:${externalPressure.entityId}`, severity: urgent ? 'urgent' : 'watch',
      title: urgent ? 'Known external conflict pressure is high' : 'Known external conflict pressure is rising',
      detail: `${externalPressure.name}: conflict pressure ${externalPressure.conflictPressure.toFixed(1)}, local trust ${externalPressure.localTrust.toFixed(1)}. This observed relationship increases autonomous guard demand.`,
      basisIds: [externalPressure.entityId],
    });
  }
  for (const expedition of state.expeditions.filter((entry) => !['returned','destroyed','joined-elsewhere'].includes(entry.status))) {
    const report = expedition.communicationReports?.at(-1);
    if (!report) continue;
    if (!report.verified || report.status !== 'connected') {
      pushUnique(signals, { id: `comm:${expedition.id}`, severity: report.status === 'silent' || report.status === 'unknown' ? 'urgent' : 'watch', title: `Field report from ${expedition.id} is not verified`, detail: report.text, basisIds: [report.id, expedition.id] });
    }
  }
  for (const project of state.researchProjects ?? []) {
    if (project.status !== 'active' || !project.sampleItemId) continue;
    const sample = state.directPlay?.inventory.find((item) => item.id === project.sampleItemId && item.quantity > 0);
    const holder = sample ? findAgent(state, sample.ownerId) : undefined;
    if (!sample || holder?.expeditionId || holder?.residence === 'external' || holder?.residence === 'unknown') {
      pushUnique(signals, { id: `research-blocked:${project.id}`, severity: 'watch', title: 'Research is waiting for its physical sample', detail: `${project.id} cannot progress until its committed sample is physically back at the settlement.`, basisIds: [project.id, project.sampleItemId] });
    }
  }
  if (!signals.length) signals.push({ id: 'settlement:stable', severity: 'info', title: 'No immediate locally observed pressure', detail: 'Current accessible stocks, recorded cases and received field reports do not indicate an urgent situation.', basisIds: [state.settlement.id] });
  return signals.slice(0, 6);
}

function fieldSignals(state: SandboxGameState, expedition: ExpeditionState, projection?: AreaProjection | null): SituationSignal[] {
  const signals: SituationSignal[] = [];
  const doctrine = state.doctrines.find((entry) => entry.id === expedition.doctrineId);
  const living = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent?.alive));
  const activeEncounter = [...state.encounters].reverse().find((entry) => entry.expeditionId === expedition.id && entry.status !== 'resolved');
  if (activeEncounter) pushUnique(signals, { id: `encounter:${activeEncounter.id}`, severity: 'urgent', title: 'WEDO encounter is active', detail: `Directive ${activeEncounter.instruction}; resolve the next round before ordinary travel continues.`, basisIds: [activeEncounter.id, expedition.id] });
  const lowHealth = living.filter((agent) => agent.health < (doctrine?.retreatHealth ?? 40));
  if (lowHealth.length) pushUnique(signals, { id: `health:${expedition.id}`, severity: 'urgent', title: 'Doctrine retreat threshold is crossed', detail: `${lowHealth.map((agent) => agent.name).join(', ')} below ${doctrine?.retreatHealth ?? 40} HP.`, basisIds: lowHealth.map((agent) => agent.id) });
  const tired = living.filter((agent) => agent.fatigue >= 72);
  if (tired.length) pushUnique(signals, { id: `fatigue:${expedition.id}`, severity: 'watch', title: 'Party fatigue is high', detail: `${tired.length}/${living.length} surviving members are at 72+ fatigue; a physical camp can trade time and supplies for recovery.`, basisIds: tired.map((agent) => agent.id) });
  const foodDays = living.length ? expedition.supplies.food / (living.length * 1.7) : 0;
  const waterDays = living.length ? expedition.supplies.water / (living.length * 2.4) : 0;
  if (Math.min(foodDays, waterDays) < 1) pushUnique(signals, { id: `supplies:${expedition.id}`, severity: 'urgent', title: 'Field supplies are below one day', detail: `Approx. food ${foodDays.toFixed(1)}d / water ${waterDays.toFixed(1)}d at current party size.`, basisIds: [expedition.id] });
  else if (Math.min(foodDays, waterDays) < 2.5) pushUnique(signals, { id: `supplies:${expedition.id}`, severity: 'watch', title: 'Field supply margin is narrowing', detail: `Approx. food ${foodDays.toFixed(1)}d / water ${waterDays.toFixed(1)}d.`, basisIds: [expedition.id] });
  if (expedition.communication !== 'connected') pushUnique(signals, { id: `field-comm:${expedition.id}`, severity: expedition.silentHours > (doctrine?.maxSilentHours ?? 18) ? 'urgent' : 'watch', title: `Communication is ${expedition.communication}`, detail: `${expedition.silentHours.toFixed(1)} unverified/silent hour(s); doctrine limit ${doctrine?.maxSilentHours ?? 18}.`, basisIds: [expedition.id, ...(expedition.communicationReports?.at(-1) ? [expedition.communicationReports.at(-1)!.id] : [])] });
  const projected = projection?.entities.filter((entity) => entity.id !== state.world.originEntityId) ?? [];
  if (projected.length) pushUnique(signals, { id: `projection:${expedition.id}:${projection?.tick ?? 0}`, severity: 'info', title: 'Generated local features are within observer range', detail: `${projected.length} provider-projected feature(s) are currently visible in LOCAL. Select one to inspect rather than treating it as an objective.`, basisIds: projected.slice(0, 6).map((entry) => entry.id) });
  if (expedition.arrivedDay === state.clock.day && expedition.arrivedMinute !== undefined) pushUnique(signals, { id: `arrival:${expedition.id}:${expedition.arrivedDay}`, severity: 'info', title: 'The party has just reached its selected field destination', detail: `Arrival confirmed at D${expedition.arrivedDay} ${String(Math.floor(expedition.arrivedMinute / 60)).padStart(2,'0')}:${String(expedition.arrivedMinute % 60).padStart(2,'0')}.`, basisIds: [expedition.id] });
  if (!signals.length) signals.push({ id: `field:stable:${expedition.id}`, severity: 'info', title: 'No immediate party-observed pressure', detail: 'Current body state, supplies, communication and LOCAL projection do not demand an immediate response.', basisIds: [expedition.id] });
  return signals.slice(0, 6);
}

export function synthesizeVisibleSituations(state: SandboxGameState, expedition?: ExpeditionState | null, projection?: AreaProjection | null): SituationSignal[] {
  return expedition ? fieldSignals(state, expedition, projection) : settlementSignals(state);
}

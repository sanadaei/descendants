import { simulateNaturalMortality } from './lifeCourseSimulation.js';
import type { WorldProvider } from '../worldbridge/contract.js';
import { addGameMinutes, advanceWorldClock, gameClockToWorldTick } from '../worldbridge/worldClock.js';
import { simulateExpeditionsInterval } from './expeditionSimulation.js';
import { refreshExternalActors } from './externalSimulation.js';
import { simulateKnowledgeInterval } from './knowledgeSimulation.js';
import { simulateResearchInterval } from './researchSimulation.js';
import { simulateSettlementInterval } from './settlementSimulation.js';
import { synchronizeIncidentLedger, synchronizeIncidentResponseOperations } from './incidentService.js';
import { evaluateSurvivalCampaign } from './survivalCampaign.js';
import { ageResourceLots, ensureResourceLedgerState, reconcileResourceLedgerToAggregates, regenerateResourceSources } from './resourceLedger.js';
import { findAgent, livingAgents, settlementAgents } from './stateUtils.js';
import type { SandboxGameState, SandboxStepSummary } from './types.js';
import { assertProviderAligned, ProviderMutationUncertainError, restoreSandboxState } from './worldMutationSafety.js';

const MAX_STEP_MINUTES = 6 * 60;

function emptySummary(state: SandboxGameState): SandboxStepSummary {
  return { from: structuredClone(state.clock), to: structuredClone(state.clock), births: [], deaths: [], leadershipChanges: [], expeditionUpdates: [], encounterUpdates: [], knowledgeUpdates: [], settlementUpdates: [] };
}

function replayDigest(state: SandboxGameState): string {
  const payload = JSON.stringify({
    seed: state.seed, rngState: state.rngState, sequence: state.sequence, day: state.clock.day, minute: state.clock.minuteOfDay, tick: state.clock.worldTick,
    leader: state.settlement.leaderId, resources: state.settlement.resources,
    agents: state.agents.map((agent) => [agent.id, agent.alive, Math.round(agent.health * 100) / 100, Math.round(agent.fatigue * 100) / 100, agent.currentTask, agent.expeditionId]),
    expeditions: state.expeditions.map((entry) => [entry.id, entry.status, Math.round(entry.position.x * 100) / 100, Math.round(entry.position.y * 100) / 100, entry.communication, entry.doctrineId, entry.pace ?? 'normal', entry.supplies.food, entry.supplies.water, entry.supplies.medicine, entry.supplies.tools, entry.routePlan ? [entry.routePlan.topologyStatus ?? 'active', entry.routePlan.replanCount ?? 0, entry.routePlan.currentWaypointIndex, entry.routePlan.basisTick ?? null, entry.routePlan.relationIds, entry.routePlan.blockedAtTick ?? null] : null]),
    knowledge: state.knowledge.map((entry) => [entry.id, entry.lost, entry.holderIds.length, entry.requiresPhysicalSample ?? false, entry.physicalEvidenceSourceEntityId ?? null, entry.claim, entry.confidence, entry.entityObservation ?? null, entry.treatmentObservation ?? null]),
    research: (state.researchProjects ?? []).map((entry) => [entry.id, entry.status, Math.round(entry.progress * 100) / 100, Math.round(entry.confidence * 10000) / 10000, entry.resultKnowledgeId ?? null, entry.sampleItemId ?? null, entry.sampleSourceEntityId ?? null]),
    anomalyPractices: (state.anomalyPractices ?? []).map((entry) => [entry.id, entry.domain, entry.attempts, Math.round(entry.mastery * 100) / 100, Math.round(entry.stability * 100) / 100, entry.lastOutcome]),
    learning: state.agents.map((a)=>[a.id,a.bornDay,a.deathDay,a.causeOfDeath,a.skills,a.aptitude??null,a.education??null,a.naming??null]),
    researchApplications: state.researchApplications??[],
    policies: (state.policyProposals ?? []).map((entry) => [entry.id, entry.task, entry.delta, entry.status, entry.supporterIds.length, entry.opponentIds.length]),
    external: state.externalActors.map((entry) => [entry.entityId, Math.round(entry.localTrust * 100) / 100, entry.tradeExperience, entry.migrationBalance, Math.round(entry.conflictPressure * 100) / 100]),
    externalContacts: (state.externalContacts ?? []).map((entry) => [entry.externalPersonId, entry.societyEntityId ?? null, entry.interactionCount, entry.lastContactDay, entry.lastContactMinute, entry.knowledgeIds.length]),
    providerMutations: state.providerMutations ? [state.providerMutations.nextCommandOrdinal, state.providerMutations.retiredThroughOrdinal ?? 0, state.providerMutations.retiredAcceptedCount ?? 0, state.providerMutations.retiredRejectedCount ?? 0, state.providerMutations.retiredEventCount ?? 0, state.providerMutations.retiredCausalRecordCount ?? 0, state.providerMutations.commandReceipts.map((entry) => [entry.commandId, entry.accepted, entry.providerTick])] : null,
    directPlay: state.directPlay ? {
      equipment: state.directPlay.equipment.map((entry) => [entry.id, entry.ownerId, entry.equipped]),
      inventory: state.directPlay.inventory.map((entry) => [entry.id, entry.ownerId, entry.kind, entry.quantity, entry.sourceEntityId ?? null, entry.resourceKey ?? null, entry.resourceSubtype ?? null, entry.resourceUnit ?? null, entry.resourceSourceId ?? null, entry.resourceCondition ?? null, entry.resourceFreshness ?? null, entry.resourceContaminationRisk ?? null, entry.resourceWaterQuality ?? null, entry.acquiredDay, entry.acquiredMinuteOfDay ?? null]),
      activities: state.directPlay.directActivities.slice(-32).map((entry) => [entry.id, entry.kind, entry.startAbsoluteMinute, entry.endAbsoluteMinute, entry.completed]),
    } : null,
    incidentLedger: state.incidentLedger ? [
      state.incidentLedger.lastSyncAt,
      ...state.incidentLedger.entries.map((entry) => [
        entry.key, entry.phase, entry.firstSeenAt, entry.lastSeenAt, entry.lastUpdatedAt, entry.terminalAt ?? null,
        entry.occurrenceCount, entry.visibleSyncCount, entry.lastUrgency, entry.lastCauseRefs,
        entry.lastResolutionEvidence ? [
          entry.lastResolutionEvidence.id, entry.lastResolutionEvidence.kind, entry.lastResolutionEvidence.observedAt, entry.lastResolutionEvidence.occurrenceNumber,
          entry.lastResolutionEvidence.subjectIds, entry.lastResolutionEvidence.supportingOperationIds,
          entry.lastResolutionEvidence.metric ?? null, entry.lastResolutionEvidence.observedValue ?? null,
          entry.lastResolutionEvidence.thresholdValue ?? null, entry.lastResolutionEvidence.comparison ?? null,
        ] : null,
      ]),
    ] : null,
    incidentDispatch: state.incidentDispatch ? [
      state.incidentDispatch.nextDispatchOrdinal,
      ...state.incidentDispatch.teams.map((team) => [
        team.id, team.contextKey, team.incidentId, team.memberIds, team.phase, team.assignedAt, team.dispatchedAt ?? null, team.stoodDownAt ?? null, team.lastUpdatedAt, team.dispatchOrdinal,
      ]),
    ] : null,
    incidentResponseOperations: state.incidentResponseOperations ? [
      state.incidentResponseOperations.nextObservationOrdinal,
      ...state.incidentResponseOperations.operations.map((operation) => [
        operation.id, operation.teamId, operation.contextKey, operation.incidentId, operation.phase,
        operation.startedAt, operation.lastAdvancedAt,
        operation.plannedMobilizationMinutes, operation.plannedWorkMinutes, operation.plannedReturnMinutes,
        operation.mobilizationMinutesRemaining, operation.workMinutesRemaining, operation.returnMinutesRemaining,
        operation.arrivedAt ?? null, operation.workCompletedAt ?? null, operation.completedAt ?? null, operation.abortedAt ?? null,
        operation.observations.map((observation) => [observation.id, observation.ordinal, observation.kind, observation.observedAt, observation.incidentVisibility]),
      ]),
    ] : null,
    incidentResponseResources: state.incidentResponseResources ? state.incidentResponseResources.reservations.map((reservation) => [
      reservation.id, reservation.operationId, reservation.teamId, reservation.contextKey, reservation.sourceKind, reservation.sourceExpeditionId ?? null,
      reservation.phase, reservation.reservedAt, reservation.lastUpdatedAt, reservation.settledAt ?? null,
      reservation.reserved.food, reservation.reserved.water, reservation.reserved.medicine, reservation.reserved.tools,
      reservation.consumed.food, reservation.consumed.water, reservation.consumed.medicine, reservation.consumed.tools,
      reservation.returned.food, reservation.returned.water, reservation.returned.medicine, reservation.returned.tools, reservation.heldLots ?? null,
    ]) : null,
    incidentResponseEvidenceUses: state.incidentResponseEvidenceUses ? [
      state.incidentResponseEvidenceUses.nextUseOrdinal,
      ...state.incidentResponseEvidenceUses.uses.map((use) => [
        use.id, use.ordinal, use.operationId, use.reservationId, use.contextKey, use.incidentId,
        use.evidenceId, use.evidenceKind, use.evidenceOccurrenceNumber, use.recordedAt, use.medicine, use.tools,
      ]),
    ] : null,
    incidentResponseDebriefs: state.incidentResponseDebriefs ? state.incidentResponseDebriefs.debriefs.map((debrief) => [
      debrief.id, debrief.operationId, debrief.teamId, debrief.contextKey, debrief.incidentId, debrief.terminalPhase, debrief.generatedAt, debrief.lastRefreshedAt, debrief.memberIds,
      [debrief.chronology.startedAt, debrief.chronology.arrivedAt ?? null, debrief.chronology.workCompletedAt ?? null, debrief.chronology.terminalAt],
      debrief.observations.map((observation) => [observation.id, observation.ordinal, observation.kind, observation.observedAt, observation.incidentVisibility]),
      debrief.positiveEvidence.map((evidence) => [evidence.id, evidence.kind, evidence.observedAt, evidence.occurrenceNumber, evidence.subjectIds, evidence.supportingOperationIds, evidence.metric ?? null, evidence.observedValue ?? null, evidence.thresholdValue ?? null, evidence.comparison ?? null]),
      debrief.evidenceResourceUses.map((use) => [use.id, use.ordinal, use.reservationId, use.evidenceId, use.evidenceKind, use.evidenceOccurrenceNumber, use.recordedAt, use.medicine, use.tools]),
      debrief.resourceReservation ? [debrief.resourceReservation.id, debrief.resourceReservation.phase, debrief.resourceReservation.lastUpdatedAt, debrief.resourceReservation.settledAt ?? null, debrief.resourceReservation.reserved, debrief.resourceReservation.consumed, debrief.resourceReservation.returned] : null,
    ]) : null,
    incidentResponseReadiness: state.incidentResponseReadiness ? [
      state.incidentResponseReadiness.policyActivatedAt,
      ...state.incidentResponseReadiness.entries.map((entry) => [entry.memberId, entry.operationId, entry.contextKey, entry.dutyMinutes, entry.recoveryStartedAt, entry.recoveryUntil]),
    ] : null,
    campaign: state.campaign ? [
      state.campaign.schemaVersion, state.campaign.startDay, state.campaign.phase, state.campaign.lastEvaluatedDay,
      state.campaign.foundingAgentIds, state.campaign.completedMilestoneIds, state.campaign.strategicAdvanceDays,
    ] : null,
    dailyLoop: state.dailyLoop ? [
      state.dailyLoop.schemaVersion, state.dailyLoop.phase,
      [state.dailyLoop.currentPlan.day, state.dailyLoop.currentPlan.status, state.dailyLoop.currentPlan.assignments.map((entry)=>[entry.agentId,entry.task,entry.note??null]), state.dailyLoop.currentPlan.policies.expedition, state.dailyLoop.currentPlan.policies.medical, state.dailyLoop.currentPlan.committedDay??null, state.dailyLoop.currentPlan.committedMinuteOfDay??null],
      [state.dailyLoop.lastMorningSnapshot.day, state.dailyLoop.lastMorningSnapshot.minuteOfDay],
      state.dailyLoop.lastMorningReport ? [state.dailyLoop.lastMorningReport.day, state.dailyLoop.lastMorningReport.residentDeltas.map((entry)=>[entry.agentId,entry.severity,Math.round(entry.healthDelta*100)/100])] : null,
      state.dailyLoop.executionSession ? [state.dailyLoop.executionSession.startedDay,state.dailyLoop.executionSession.startedMinuteOfDay,state.dailyLoop.executionSession.targetAbsoluteMinute,state.dailyLoop.executionSession.status,[state.dailyLoop.executionSession.accumulated.births,state.dailyLoop.executionSession.accumulated.deaths,state.dailyLoop.executionSession.accumulated.expeditionUpdates,state.dailyLoop.executionSession.accumulated.settlementUpdates],state.dailyLoop.executionSession.interruption?.kind??null,state.dailyLoop.executionSession.interruption?.subjectIds??[]] : null,
    ] : null,
    resourceLedger: state.resourceLedger ? [
      state.resourceLedger.schemaVersion,
      state.resourceLedger.sources.map((source) => [source.id, source.resourceKey, source.kind, source.subtype, source.worldEntityIds, source.worldProvenanceIds, source.renewable, source.accessibleStock, source.carryingCapacity, source.regenerationPerDay, source.depletionFraction, source.lastHarvestDay ?? null, source.lastHarvestMinuteOfDay ?? null]),
      state.resourceLedger.lots.map((lot) => [lot.id, lot.resourceKey, lot.subtype, lot.quantity, lot.unit, lot.sourceId, lot.worldEntityIds, lot.worldProvenanceIds, lot.createdDay, lot.createdMinuteOfDay, lot.harvesterIds, lot.condition, lot.freshness, lot.contaminationRisk, lot.waterQuality ?? null, lot.processingHistory.map((step) => [step.kind,step.day,step.minuteOfDay,step.agentIds,step.note]), lot.parentLotIds, lot.storageLocationId ?? null, lot.containerId ?? null, (lot.custodyHistory??[]).map((step)=>[step.holderId??null,step.storageLocationId??null,step.day,step.minuteOfDay,step.note])]),
      state.resourceLedger.allocationGroups.map((group) => [group.id,group.name,group.memberIds,group.createdDay,group.createdMinuteOfDay,group.updatedDay,group.updatedMinuteOfDay]),
      state.resourceLedger.allocationRules.map((rule) => [rule.id,rule.name,rule.groupId,rule.resourceKey,rule.lotIds,rule.subtypes,rule.amountPerPersonPerDay,rule.priority,rule.exclusive,rule.enabled,rule.createdDay,rule.createdMinuteOfDay,rule.updatedDay,rule.updatedMinuteOfDay]),
      state.resourceLedger.recentDistributions.map((event) => [event.id,event.resourceKey,event.day,event.minuteOfDay,event.lines.map((line) => [line.agentId,line.lotId,line.quantity])]),
    ] : null,
  });
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { hash ^= payload.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}

function updateContinuity(state: SandboxGameState): void {
  const localPopulation = settlementAgents(state).length;
  const expeditionPopulation = livingAgents(state).filter((agent) => agent.expeditionId !== null).length;
  if (localPopulation === 0) state.status = 'local-collapse';
  else if (state.status === 'local-collapse') state.status = 'running';
  if (localPopulation === 0 && expeditionPopulation > 0) return;
  if (livingAgents(state).length === 0) state.status = 'local-collapse';
}

function validateLeaderControl(state: SandboxGameState): void {
  const leader = findAgent(state, state.settlement.leaderId);
  if (!leader?.alive) return;
  if (leader.expeditionId) {
    const expedition = state.expeditions.find((entry) => entry.id === leader.expeditionId);
    if (expedition?.controlMode === 'settlement') {
      // The expedition leader can be the same individual only when control stays with them; otherwise
      // social succession at the settlement is required on the next local simulation interval.
      leader.authority.legitimacy = Math.max(0, leader.authority.legitimacy - 1);
    }
  }
}

async function simulateChunk(provider: WorldProvider, state: SandboxGameState, minutes: number, summary: SandboxStepSummary, forceProviderSync: boolean): Promise<void> {
  ensureResourceLedgerState(state);
  const previousDay = state.clock.day;
  state.clock = addGameMinutes(state.clock, minutes);
  const dayBoundary = state.clock.day !== previousDay;
  const activeExpedition = state.expeditions.some((entry) => ['outbound', 'exploring', 'returning'].includes(entry.status));
  if (forceProviderSync || dayBoundary || activeExpedition) {
    const bridged = await advanceWorldClock(provider, state.clock, state.clockPolicy, state.settlement.position, [state.settlement.leaderId]);
    state.clock = bridged.clock;
    state.diagnostics.lastWorldAdvanceFrom = bridged.result.fromTick;
    state.diagnostics.lastWorldAdvanceTo = bridged.result.toTick;
  } else {
    // Settlement-only substeps do not need to invoke the provider every six hours. Keep the
    // logical game/world clock current and synchronize at day boundaries or before return.
    state.clock = { ...state.clock, worldTick: gameClockToWorldTick(state.clock, state.clockPolicy) };
  }
  const hours = minutes / 60;
  if (dayBoundary) { regenerateResourceSources(state, 1); ageResourceLots(state, 1); }
  simulateNaturalMortality(state, summary);
  simulateSettlementInterval(state, hours, summary);
  await simulateExpeditionsInterval(provider, state, hours, summary);
  simulateKnowledgeInterval(state, hours, summary);
  simulateResearchInterval(state, hours, summary);
  validateLeaderControl(state);
  if (state.clock.day !== previousDay || state.diagnostics.stepCount === 0) await refreshExternalActors(provider, state, summary);
  updateContinuity(state);
  synchronizeIncidentLedger(state);
  synchronizeIncidentResponseOperations(state);
  evaluateSurvivalCampaign(state);
  reconcileResourceLedgerToAggregates(state, 'simulation interval');
  state.diagnostics.stepCount += 1;
  state.diagnostics.replayHash = replayDigest(state);
}

export async function advanceSandbox(provider: WorldProvider, state: SandboxGameState, minutes: number): Promise<SandboxStepSummary> {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('advanceSandbox requires a positive minute count.');
  const committed = structuredClone(state);
  const summary = emptySummary(state);
  try {
    let remaining = Math.floor(minutes);
    while (remaining > 0) {
      const chunk = Math.min(MAX_STEP_MINUTES, remaining);
      const finalChunk = remaining <= chunk;
      await simulateChunk(provider, state, chunk, summary, finalChunk);
      remaining -= chunk;
    }
    state.world.providerSnapshot = await provider.exportSnapshot(2);
    state.world.manifest = structuredClone(state.world.providerSnapshot.manifest);
    await assertProviderAligned(provider, state);
    summary.to = structuredClone(state.clock);
    return summary;
  } catch (error) {
    // Game state is transactional even when the provider cannot be rolled back through the frozen contract.
    // The caller must reload/reconstruct the provider from the last committed providerSnapshot before mutating again.
    restoreSandboxState(state, committed);
    if (error instanceof ProviderMutationUncertainError) throw error;
    throw new ProviderMutationUncertainError(`World advance failed; game state was rolled back and provider resynchronization is required. ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

export async function advanceSandboxHours(provider: WorldProvider, state: SandboxGameState, hours: number): Promise<SandboxStepSummary> {
  return advanceSandbox(provider, state, Math.max(1, Math.floor(hours * 60)));
}

export async function advanceSandboxDays(provider: WorldProvider, state: SandboxGameState, days: number): Promise<SandboxStepSummary> {
  return advanceSandbox(provider, state, Math.max(1, Math.floor(days * 1440)));
}

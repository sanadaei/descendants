import type { AreaProjection, JsonValue } from '../worldbridge/contract.js';
import { addExpeditionChronicle, clamp, findAgent, nextStateId } from './stateUtils.js';
import { beginOffNetworkReturn } from './fieldReturnSimulation.js';
import type { ExpeditionFieldDecision, ExpeditionFieldDecisionKind, ExpeditionState, SandboxGameState, SandboxStepSummary } from './types.js';

export interface ProviderExposureAssessment {
  risk: number;
  sourceEntityIds: string[];
  drivers: string[];
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Derive field exposure only from observations carried by the current area report.
 * Proximity, season, or remembered weather alone never create exposure risk.
 * Numeric weights are gameplay calibration rather than medical diagnosis.
 */
export function providerExposureAssessment(projection: AreaProjection | null | undefined): ProviderExposureAssessment {
  if (!projection) return { risk: 0, sourceEntityIds: [], drivers: [] };
  let risk = 0;
  const sourceEntityIds: string[] = [];
  const drivers: string[] = [];
  for (const entity of projection.entities) {
    const c = entity.components;
    const explicit = [finiteNumber(c.exposureRisk), finiteNumber(c.environmentalRisk), finiteNumber(c.weatherSeverity)]
      .filter((entry): entry is number => entry !== undefined)
      .map((entry) => clamp(entry, 0, 1));
    let local = explicit.length ? Math.max(...explicit) : 0;
    const temperatureC = finiteNumber(c.temperatureC);
    if (temperatureC !== undefined) {
      if (temperatureC <= 0) local = Math.max(local, Math.min(1, (5 - temperatureC) / 30));
      else if (temperatureC >= 35) local = Math.max(local, Math.min(1, (temperatureC - 30) / 25));
    }
    const tags = new Set([...(entity.tags ?? []), ...stringArray(c.domainHints)].map((entry) => entry.toLowerCase()));
    if (tags.has('storm') || tags.has('severe-weather')) local = Math.max(local, 0.72);
    if (tags.has('extreme-cold') || tags.has('extreme-heat')) local = Math.max(local, 0.78);
    if (tags.has('high-wind') || tags.has('wet')) local = Math.max(local, 0.42);
    if (local <= 0) continue;
    risk = Math.max(risk, local);
    sourceEntityIds.push(entity.id);
    drivers.push(`${entity.id}:${local.toFixed(2)}`);
  }
  return { risk: clamp(risk, 0, 1), sourceEntityIds: [...new Set(sourceEntityIds)].sort(), drivers: [...new Set(drivers)].sort() };
}

export function issueBlockedFieldDecision(
  state: SandboxGameState,
  expeditionId: string,
  kind: ExpeditionFieldDecisionKind,
  options: { durationHours?: number } = {},
): ExpeditionState {
  const expedition = state.expeditions.find((entry) => entry.id === expeditionId);
  if (!expedition || expedition.status !== 'outbound' || expedition.routePlan?.topologyStatus !== 'blocked') throw new Error('A blocked outbound route is required for a field decision.');
  if (expedition.controlMode !== 'expedition') throw new Error('Direct blocked-route field decisions require expedition control.');
  const decision: ExpeditionFieldDecision = {
    id: nextStateId(state, 'field-decision'), kind, status: 'active',
    issuedDay: state.clock.day, issuedMinute: state.clock.minuteOfDay, issuedTick: state.clock.worldTick,
    communicationAtDecision: expedition.communication,
    ...(kind === 'wait-camp' ? (() => { const hours = Math.max(1, Math.min(24, Number(options.durationHours) || 6)); return { remainingHours: hours, initialHours: hours }; })() : {}),
  };
  expedition.fieldDecision = decision;
  if (kind === 'return') {
    beginOffNetworkReturn(state, expedition);
    decision.status = 'completed';
    decision.completedDay = state.clock.day;
    decision.completedMinute = state.clock.minuteOfDay;
    decision.result = 'Return initiated on a direct physical bearing outside the recorded road network.';
  }
  addExpeditionChronicle(state, expedition.id, {
    kind: 'expedition', title: `Blocked-route field decision: ${kind}`,
    text: kind === 'wait-camp'
      ? `${expedition.id} は現地待機を選択。物資と通信時間を消費しつつ、遮蔽物で観測済みの環境負荷を抑えます。`
      : kind === 'retry-replan'
        ? `${expedition.id} は現在地を維持し、次の現地観測を待って経路を再確認します。`
        : `${expedition.id} abandoned the blocked outbound route and began a direct physical return bearing. This does not assert a known road home.`,
    entityIds: [expedition.id, decision.id, ...(expedition.routePlan.blockedEvidenceIds ?? [])],
  });
  return expedition;
}

export function activeBlockedCampHours(expedition: ExpeditionState, intervalHours: number): number {
  const decision = expedition.fieldDecision;
  if (expedition.status !== 'outbound' || expedition.routePlan?.topologyStatus !== 'blocked' || decision?.status !== 'active' || decision.kind !== 'wait-camp') return 0;
  return Math.max(0, Math.min(intervalHours, decision.remainingHours ?? 0));
}

export function blockedRetryRequested(expedition: ExpeditionState): boolean {
  return expedition.status === 'outbound' && expedition.routePlan?.topologyStatus === 'blocked' && expedition.fieldDecision?.status === 'active' && expedition.fieldDecision.kind === 'retry-replan';
}

export function completeRetryDecision(state: SandboxGameState, expedition: ExpeditionState, succeeded: boolean, detail: string): void {
  const decision = expedition.fieldDecision;
  if (!decision || decision.status !== 'active' || decision.kind !== 'retry-replan') return;
  decision.status = succeeded ? 'completed' : 'failed';
  decision.completedDay = state.clock.day;
  decision.completedMinute = state.clock.minuteOfDay;
  decision.result = detail;
}

export function interruptActiveFieldDecision(state: SandboxGameState, expedition: ExpeditionState, detail: string): void {
  const decision = expedition.fieldDecision;
  if (!decision || decision.status !== 'active') return;
  decision.status = 'failed';
  decision.completedDay = state.clock.day;
  decision.completedMinute = state.clock.minuteOfDay;
  decision.result = detail;
  addExpeditionChronicle(state, expedition.id, {
    kind: 'expedition',
    title: 'Blocked-route field decision interrupted',
    text: `${expedition.id} could not continue ${decision.kind}: ${detail}`,
    entityIds: [expedition.id, decision.id],
  });
}

export function advanceBlockedCampDecision(state: SandboxGameState, expedition: ExpeditionState, elapsedCampHours: number): void {
  const decision = expedition.fieldDecision;
  if (!decision || decision.status !== 'active' || decision.kind !== 'wait-camp' || elapsedCampHours <= 0) return;
  decision.remainingHours = Math.max(0, (decision.remainingHours ?? 0) - elapsedCampHours);
  if ((decision.remainingHours ?? 0) <= 1e-9) {
    decision.status = 'completed';
    decision.completedDay = state.clock.day;
    decision.completedMinute = state.clock.minuteOfDay;
    decision.result = `Completed ${decision.initialHours ?? elapsedCampHours}h bounded wait/camp; route remains blocked until an explicit retry/replan or return decision.`;
    addExpeditionChronicle(state, expedition.id, {
      kind: 'expedition', title: 'Blocked-route field camp completed', text: `${expedition.id} completed the bounded wait/camp. No route restoration was inferred from time passage alone.`, entityIds: [expedition.id, decision.id],
    });
  }
}

export function applyProviderBoundedFieldExposure(
  state: SandboxGameState,
  expedition: ExpeditionState,
  projection: AreaProjection,
  hours: number,
  sheltered: boolean,
  summary: SandboxStepSummary,
): void {
  if (hours <= 0) return;
  const assessment = providerExposureAssessment(projection);
  const shelterFactor = sheltered ? (expedition.supplies.tools > 0 ? 0.35 : 0.62) : 1;
  const dose = assessment.risk * hours * shelterFactor;
  const exposure = expedition.fieldExposure ?? (expedition.fieldExposure = { cumulativeDose: 0, lastIntervalDose: 0, lastRisk: 0, sourceEntityIds: [], sheltered: false });
  exposure.cumulativeDose = Math.max(0, exposure.cumulativeDose + dose);
  exposure.lastIntervalDose = dose;
  exposure.lastRisk = assessment.risk;
  exposure.lastProviderTick = projection.tick;
  exposure.sourceEntityIds = [...assessment.sourceEntityIds];
  exposure.sheltered = sheltered;
  if (dose <= 0) return;
  const living = expedition.memberIds.map((id) => findAgent(state, id)).filter((agent) => Boolean(agent?.alive));
  const healthLoss = Math.max(0, dose - 0.75) * 0.32;
  for (const agent of living) {
    if (!agent) continue;
    agent.fatigue = clamp(agent.fatigue + dose * (sheltered ? 0.45 : 1.05));
    agent.needs.safety = clamp(agent.needs.safety + dose * 0.8);
    if (healthLoss > 0) agent.health = clamp(agent.health - healthLoss);
    if (exposure.cumulativeDose >= 3.5) {
      const severity = clamp(6 + (exposure.cumulativeDose - 3.5) * 4.2 + assessment.risk * 7, 0, 72);
      const existing = agent.pathology.find((entry) => entry.pathologyId === 'field-exposure-burden' && entry.status === 'active');
      if (existing) {
        existing.severity = Math.max(existing.severity, severity);
        existing.suspectedCauses = [...new Set([...existing.suspectedCauses, ...assessment.sourceEntityIds])];
      } else {
        agent.pathology.push({
          id: nextStateId(state, 'case'), pathologyId: 'field-exposure-burden', onsetDay: state.clock.day,
          severity, contagious: false,
          observedSymptoms: ['field exposure fatigue / impaired recovery'],
          suspectedCauses: [...assessment.sourceEntityIds], treatmentsTried: [], status: 'active',
        });
      }
    }
  }
  if (healthLoss > 0.01) summary.expeditionUpdates.push(`${expedition.id} accumulated provider-observed environmental exposure while ${sheltered ? 'sheltered in camp' : 'halted without camp shelter'}.`);
}

import { adjustResourceStock, consumeResourceLots, reconcileResourceLedgerToAggregates, restoreReservedResourceLots } from './resourceLedger.js';
import type { AreaProjection } from '../worldbridge/contract.js';
import { synthesizeVisibleSituations, type SituationSeverity, type SituationSignal } from './situationSynthesis.js';
import type {
  ExpeditionState,
  IncidentDispatchStateV1,
  IncidentDispatchTeam,
  IncidentLedgerEntry,
  IncidentPositiveResolutionEvidence,
  IncidentLedgerStateV1,
  IncidentResponseObservation,
  IncidentResponseObservationKind,
  IncidentResponseOperation,
  IncidentResponseOperationStateV1,
  IncidentResponseResourceAmounts,
  IncidentResponseResourceReservation,
  IncidentResponseResourceSourceKind,
  IncidentResponseResourceStateV1,
  IncidentResponseEvidenceResourceUse,
  IncidentResponseEvidenceResourceUseStateV1,
  IncidentResponseDebrief,
  IncidentResponseDebriefStateV1,
  IncidentResponseReadinessEntry,
  IncidentResponseReadinessStateV1,
  SandboxGameState,
} from './types.js';

export type IncidentUrgency = 'low' | 'medium' | 'high' | 'critical';
export type IncidentPhase = 'candidate' | 'eligible' | 'queued' | 'presented' | 'resolved' | 'expired' | 'withdrawn';

export interface IncidentPresentation {
  title: string;
  summary: string;
  sourceLabel: string;
  visibleStakeText: string;
}

export interface IncidentCandidate {
  id: string;
  templateId: string;
  causeRefs: string[];
  subjectIds: string[];
  siteNodeIds: string[];
  requiredKnowledgeClaimIds: string[];
  urgency: IncidentUrgency;
  earliestAt?: number;
  expiresAt?: number;
  cooldownKey?: string;
  cooldownMinutes?: number;
  causalDedupeKey?: string;
  eligible: boolean;
  knowledgeSafe: boolean;
  legacySeverity: SituationSeverity;
  presentation: IncidentPresentation;
}

export interface IncidentRecord extends Omit<IncidentCandidate, 'eligible' | 'knowledgeSafe'> {
  phase: IncidentPhase;
  priorityScore: number;
  repetitionDebt: number;
}

export interface IncidentPipelineContext {
  nowMinute: number;
  lastPresentedAt?: Readonly<Record<string, number>>;
  exposureCounts?: Readonly<Record<string, number>>;
  maxVisible?: number;
}

export interface IncidentPipelineAudit {
  candidateCount: number;
  ineligibleCount: number;
  knowledgeRejectedCount: number;
  timeRejectedCount: number;
  cooldownRejectedCount: number;
  dedupedCount: number;
  eligibleCount: number;
  presentedCount: number;
}

export interface IncidentProjection {
  incidents: IncidentRecord[];
  audit: IncidentPipelineAudit;
}

export type F1IncidentReadSource = 'legacy' | 'incident';
export type F1IncidentFallbackReason = 'incident-projection-empty';

export interface F1IncidentReadModel {
  source: F1IncidentReadSource;
  rows: SituationSignal[];
  incidents: IncidentRecord[];
  audit: IncidentPipelineAudit;
  fallbackReason?: F1IncidentFallbackReason;
}

export const I2_F1_INCIDENT_STORAGE_KEY = 'descendants.i2.f1-incidents.v1';
const INCIDENT_LEDGER_MAX_ENTRIES = 256;
const INCIDENT_DISPATCH_MAX_TEAMS = 192;
const INCIDENT_DISPATCH_MAX_TEAM_SIZE = 4;
const INCIDENT_DISPATCH_MAX_ACTIVE_TEAMS_PER_INCIDENT = 3;
const INCIDENT_DISPATCH_MAX_ACTIVE_TEAMS_PER_CONTEXT = 4;
const INCIDENT_RESPONSE_MAX_OPERATIONS = 192;
const INCIDENT_RESPONSE_MAX_OBSERVATIONS_PER_OPERATION = 8;
const INCIDENT_RESPONSE_MAX_RESOURCE_RESERVATIONS = 192;
const INCIDENT_RESPONSE_MAX_EVIDENCE_RESOURCE_USES = 192;
const INCIDENT_RESPONSE_MAX_DEBRIEFS = 192;
const INCIDENT_RESPONSE_MAX_READINESS_ENTRIES = 256;
const INCIDENT_RESPONSE_RECOVERY_RATIO = 0.25;
const INCIDENT_RESPONSE_RECOVERY_QUANTUM_MINUTES = 15;
const INCIDENT_RESPONSE_RECOVERY_MAX_MINUTES = 240;
const INCIDENT_RESPONSE_ROSTER_PRIMARY_LIMIT = 4;
const INCIDENT_RESPONSE_ROSTER_RESERVE_LIMIT = 4;
const INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS = 8;
const INCIDENT_RESPONSE_EXTERNAL_RECEIPT_REGISTRY_MAX_ENTRIES = 32;
const INCIDENT_RESPONSE_MAX_DEBRIEF_POSITIVE_EVIDENCE = 8;
const INCIDENT_RESPONSE_MOBILIZATION_MINUTES = 30;
const INCIDENT_RESPONSE_RETURN_MINUTES = 30;
const INCIDENT_RESPONSE_RESOURCE_EPSILON = 1e-9;

export type IncidentContextKey = 'settlement' | `expedition:${string}`;

export interface IncidentLedgerSyncAudit {
  contextCount: number;
  activatedCount: number;
  refreshedCount: number;
  reactivatedCount: number;
  withdrawnCount: number;
  expiredCount: number;
  prunedCount: number;
  activeCount: number;
  terminalCount: number;
  legacyResolutionDowngradedCount: number;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => Boolean(value)))];
}

function stateAbsoluteMinute(state: SandboxGameState): number {
  // Preserve I2-A's time coordinate so cooldown/expiry values remain comparable across the handoff.
  return state.clock.day * 1440 + state.clock.minuteOfDay;
}

export function incidentContextKey(expedition?: ExpeditionState | null): IncidentContextKey {
  return expedition ? `expedition:${expedition.id}` : 'settlement';
}

function ledgerEntryKey(contextKey: IncidentContextKey, incidentId: string): string {
  return `${contextKey}|${incidentId}`;
}

function urgencyForSeverity(severity: SituationSeverity): IncidentUrgency {
  if (severity === 'urgent') return 'high';
  if (severity === 'watch') return 'medium';
  return 'low';
}

function severityForUrgency(urgency: IncidentUrgency): SituationSeverity {
  if (urgency === 'critical' || urgency === 'high') return 'urgent';
  if (urgency === 'medium') return 'watch';
  return 'info';
}

function urgencyBase(urgency: IncidentUrgency): number {
  if (urgency === 'critical') return 100;
  if (urgency === 'high') return 80;
  if (urgency === 'medium') return 50;
  return 20;
}

function situationTemplateId(signal: SituationSignal): string {
  const [family] = signal.id.split(':', 1);
  return `legacy-situation:${family || 'generic'}`;
}

/**
 * Compatibility ingestion seam for I2-A. SituationSignal is already player-visible, observer-bounded
 * synthesis. This adapter deliberately does not inspect hidden provider entities or provider truth.
 */
export function incidentCandidateFromVisibleSituation(signal: SituationSignal): IncidentCandidate {
  const causes = unique(signal.basisIds);
  return {
    id: `incident:${signal.id}`,
    templateId: situationTemplateId(signal),
    causeRefs: causes,
    subjectIds: causes,
    siteNodeIds: [],
    requiredKnowledgeClaimIds: [],
    urgency: urgencyForSeverity(signal.severity),
    cooldownKey: `situation:${signal.id}`,
    cooldownMinutes: signal.severity === 'info' ? 360 : signal.severity === 'watch' ? 120 : 60,
    causalDedupeKey: `situation:${signal.id}`,
    eligible: true,
    knowledgeSafe: true,
    legacySeverity: signal.severity,
    presentation: {
      title: signal.title,
      summary: signal.detail,
      sourceLabel: 'VISIBLE SITUATION / OBSERVER-BOUNDED',
      visibleStakeText: signal.detail,
    },
  };
}

function activeInTime(candidate: IncidentCandidate, nowMinute: number): boolean {
  if (candidate.earliestAt !== undefined && nowMinute < candidate.earliestAt) return false;
  if (candidate.expiresAt !== undefined && nowMinute >= candidate.expiresAt) return false;
  return true;
}

function underCooldown(candidate: IncidentCandidate, context: IncidentPipelineContext): boolean {
  if (!candidate.cooldownKey || !candidate.cooldownMinutes || !context.lastPresentedAt) return false;
  const last = context.lastPresentedAt[candidate.cooldownKey];
  return last !== undefined && Number.isFinite(last) && context.nowMinute < last + candidate.cooldownMinutes;
}

function repetitionDebt(candidate: IncidentCandidate, context: IncidentPipelineContext): number {
  if (!candidate.cooldownKey || !context.exposureCounts) return 0;
  const count = Math.max(0, Math.floor(context.exposureCounts[candidate.cooldownKey] ?? 0));
  return Math.min(30, count * 4);
}

function score(candidate: IncidentCandidate, context: IncidentPipelineContext): number {
  const causeSalience = Math.min(12, unique(candidate.causeRefs).length * 2);
  const deadlinePressure = candidate.expiresAt === undefined
    ? 0
    : Math.max(0, Math.min(20, 20 - Math.floor((candidate.expiresAt - context.nowMinute) / 60)));
  const stablePenalty = candidate.id.includes(':stable') ? 15 : 0;
  return urgencyBase(candidate.urgency) + causeSalience + deadlinePressure - repetitionDebt(candidate, context) - stablePenalty;
}

function compareCandidates(left: IncidentCandidate, right: IncidentCandidate, context: IncidentPipelineContext): number {
  const delta = score(right, context) - score(left, context);
  if (delta !== 0) return delta;
  return left.id.localeCompare(right.id);
}

/**
 * I2 ordering is explicit: eligibility -> knowledge gate -> time/cooldown suppression -> causal dedupe -> ranking.
 * No ranking result can make an ineligible or hidden-information candidate visible.
 */
export function projectIncidents(candidates: readonly IncidentCandidate[], context: IncidentPipelineContext): IncidentProjection {
  const audit: IncidentPipelineAudit = {
    candidateCount: candidates.length,
    ineligibleCount: 0,
    knowledgeRejectedCount: 0,
    timeRejectedCount: 0,
    cooldownRejectedCount: 0,
    dedupedCount: 0,
    eligibleCount: 0,
    presentedCount: 0,
  };

  const eligible: IncidentCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.eligible) { audit.ineligibleCount += 1; continue; }
    if (!candidate.knowledgeSafe) { audit.knowledgeRejectedCount += 1; continue; }
    if (!activeInTime(candidate, context.nowMinute)) { audit.timeRejectedCount += 1; continue; }
    if (underCooldown(candidate, context)) { audit.cooldownRejectedCount += 1; continue; }
    eligible.push(structuredClone(candidate));
  }

  const byDedupe = new Map<string, IncidentCandidate>();
  for (const candidate of eligible) {
    const key = candidate.causalDedupeKey || candidate.id;
    const existing = byDedupe.get(key);
    if (!existing) { byDedupe.set(key, candidate); continue; }
    audit.dedupedCount += 1;
    if (compareCandidates(candidate, existing, context) < 0) byDedupe.set(key, candidate);
  }

  const ranked = [...byDedupe.values()].sort((left, right) => compareCandidates(left, right, context));
  audit.eligibleCount = ranked.length;
  const maxVisible = Math.max(1, Math.floor(context.maxVisible ?? 6));
  const incidents = ranked.slice(0, maxVisible).map((candidate, index): IncidentRecord => ({
    id: candidate.id,
    templateId: candidate.templateId,
    causeRefs: unique(candidate.causeRefs),
    subjectIds: unique(candidate.subjectIds),
    siteNodeIds: unique(candidate.siteNodeIds),
    requiredKnowledgeClaimIds: unique(candidate.requiredKnowledgeClaimIds),
    urgency: candidate.urgency,
    ...(candidate.earliestAt !== undefined ? { earliestAt: candidate.earliestAt } : {}),
    ...(candidate.expiresAt !== undefined ? { expiresAt: candidate.expiresAt } : {}),
    ...(candidate.cooldownKey ? { cooldownKey: candidate.cooldownKey } : {}),
    ...(candidate.cooldownMinutes !== undefined ? { cooldownMinutes: candidate.cooldownMinutes } : {}),
    ...(candidate.causalDedupeKey ? { causalDedupeKey: candidate.causalDedupeKey } : {}),
    legacySeverity: candidate.legacySeverity,
    presentation: structuredClone(candidate.presentation),
    phase: index === 0 ? 'presented' : 'queued',
    priorityScore: score(candidate, context),
    repetitionDebt: repetitionDebt(candidate, context),
  }));
  audit.presentedCount = incidents.length;
  return { incidents, audit };
}

export function createEmptyIncidentLedger(nowMinute = 0): IncidentLedgerStateV1 {
  return { schemaVersion: 1, resolutionPolicyVersion: 1, lastSyncAt: Math.max(0, Math.floor(nowMinute)), entries: [] };
}

function contextsForLedger(state: SandboxGameState): Array<{ key: IncidentContextKey; expedition: ExpeditionState | null }> {
  const contexts: Array<{ key: IncidentContextKey; expedition: ExpeditionState | null }> = [{ key: 'settlement', expedition: null }];
  for (const expedition of state.expeditions) {
    if (['returned','destroyed','joined-elsewhere'].includes(expedition.status)) continue;
    contexts.push({ key: incidentContextKey(expedition), expedition });
  }
  return contexts;
}

function syncLedgerContext(
  ledger: IncidentLedgerStateV1,
  contextKey: IncidentContextKey,
  incidents: readonly IncidentRecord[],
  nowMinute: number,
  audit: IncidentLedgerSyncAudit,
): void {
  const currentKeys = new Set<string>();
  for (const incident of incidents) {
    const key = ledgerEntryKey(contextKey, incident.id);
    currentKeys.add(key);
    const existing = ledger.entries.find((entry) => entry.key === key);
    if (!existing) {
      ledger.entries.push({
        key,
        contextKey,
        incidentId: incident.id,
        templateId: incident.templateId,
        ...(incident.causalDedupeKey ? { causalDedupeKey: incident.causalDedupeKey } : {}),
        ...(incident.expiresAt !== undefined ? { expiresAt: incident.expiresAt } : {}),
        phase: 'active',
        firstSeenAt: nowMinute,
        lastSeenAt: nowMinute,
        lastUpdatedAt: nowMinute,
        occurrenceCount: 1,
        visibleSyncCount: 1,
        lastUrgency: incident.urgency,
        lastCauseRefs: unique(incident.causeRefs),
      });
      audit.activatedCount += 1;
      continue;
    }
    const reactivated = existing.phase !== 'active';
    if (reactivated) {
      existing.phase = 'active';
      existing.occurrenceCount += 1;
      delete existing.terminalAt;
      existing.visibleSyncCount += 1;
      audit.reactivatedCount += 1;
    } else {
      audit.refreshedCount += 1;
    }
    const nextCauseRefs = unique(incident.causeRefs);
    const materiallyChanged = existing.lastSeenAt !== nowMinute
      || existing.templateId !== incident.templateId
      || existing.causalDedupeKey !== incident.causalDedupeKey
      || existing.expiresAt !== incident.expiresAt
      || existing.lastUrgency !== incident.urgency
      || existing.lastCauseRefs.length !== nextCauseRefs.length
      || existing.lastCauseRefs.some((value, index) => value !== nextCauseRefs[index]);
    existing.templateId = incident.templateId;
    if (incident.causalDedupeKey) existing.causalDedupeKey = incident.causalDedupeKey;
    else delete existing.causalDedupeKey;
    if (incident.expiresAt !== undefined) existing.expiresAt = incident.expiresAt;
    else delete existing.expiresAt;
    existing.lastSeenAt = nowMinute;
    if (materiallyChanged) existing.lastUpdatedAt = nowMinute;
    if (!reactivated && materiallyChanged) existing.visibleSyncCount += 1;
    existing.lastUrgency = incident.urgency;
    existing.lastCauseRefs = nextCauseRefs;
  }

  for (const entry of ledger.entries) {
    if (entry.contextKey !== contextKey || entry.phase !== 'active' || currentKeys.has(entry.key)) continue;
    entry.phase = entry.expiresAt !== undefined && nowMinute >= entry.expiresAt ? 'expired' : 'withdrawn';
    entry.terminalAt = nowMinute;
    entry.lastUpdatedAt = nowMinute;
    if (entry.phase === 'expired') audit.expiredCount += 1;
    else audit.withdrawnCount += 1;
  }
}

function pruneIncidentLedger(ledger: IncidentLedgerStateV1): number {
  if (ledger.entries.length <= INCIDENT_LEDGER_MAX_ENTRIES) return 0;
  const active = ledger.entries.filter((entry) => entry.phase === 'active');
  const terminal = ledger.entries
    .filter((entry) => entry.phase !== 'active')
    .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt || left.key.localeCompare(right.key));
  const keepTerminal = Math.max(0, INCIDENT_LEDGER_MAX_ENTRIES - active.length);
  const next = [...active, ...terminal.slice(0, keepTerminal)].sort((left, right) => left.key.localeCompare(right.key));
  const pruned = ledger.entries.length - next.length;
  ledger.entries = next;
  return pruned;
}

/**
 * I2-B persistence seam. Synchronization only consumes observer-safe SituationSignal projections.
 * It intentionally omits LOCAL-only projected entities because an AreaProjection is not available
 * at canonical save/load boundaries. Missing current visibility withdraws an incident; it never
 * proves that the underlying world cause was resolved.
 */
export function synchronizeIncidentLedger(state: SandboxGameState): IncidentLedgerSyncAudit {
  const nowMinute = stateAbsoluteMinute(state);
  const ledger = state.incidentLedger ?? createEmptyIncidentLedger(nowMinute);
  const audit: IncidentLedgerSyncAudit = {
    contextCount: 0,
    activatedCount: 0,
    refreshedCount: 0,
    reactivatedCount: 0,
    withdrawnCount: 0,
    expiredCount: 0,
    prunedCount: 0,
    activeCount: 0,
    terminalCount: 0,
    legacyResolutionDowngradedCount: 0,
  };
  if (ledger.resolutionPolicyVersion !== 1) {
    for (const entry of ledger.entries) {
      if (entry.phase !== 'resolved' || entry.lastResolutionEvidence) continue;
      entry.phase = 'withdrawn';
      entry.terminalAt ??= nowMinute;
      entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt, nowMinute);
      audit.legacyResolutionDowngradedCount += 1;
    }
    ledger.resolutionPolicyVersion = 1;
  }
  for (const context of contextsForLedger(state)) {
    const projection = deriveVisibleIncidentProjection(state, context.expedition, null);
    syncLedgerContext(ledger, context.key, projection.incidents, nowMinute, audit);
    audit.contextCount += 1;
  }
  const liveContextKeys = new Set(contextsForLedger(state).map((context) => context.key));
  for (const entry of ledger.entries) {
    if (entry.phase !== 'active' || liveContextKeys.has(entry.contextKey as IncidentContextKey)) continue;
    entry.phase = 'withdrawn';
    entry.terminalAt = nowMinute;
    entry.lastUpdatedAt = nowMinute;
    audit.withdrawnCount += 1;
  }
  ledger.lastSyncAt = nowMinute;
  audit.prunedCount = pruneIncidentLedger(ledger);
  audit.activeCount = ledger.entries.filter((entry) => entry.phase === 'active').length;
  audit.terminalCount = ledger.entries.length - audit.activeCount;
  state.incidentLedger = ledger;
  ensureIncidentDispatchState(state);
  ensureIncidentResponseOperationState(state);
  backfillIncidentResponseOperations(state);
  ensureIncidentResponseResourceState(state);
  backfillIncidentResponseResources(state);
  ensureIncidentResponseEvidenceResourceUseState(state);
  pruneIncidentResponseEvidenceResourceUseHistory(state);
  ensureIncidentResponseDebriefState(state);
  synchronizeIncidentResponseDebriefs(state);
  ensureIncidentResponseReadinessState(state);
  synchronizeIncidentResponseReadiness(state);
  return audit;
}

export function activeIncidentLedgerEntries(state: SandboxGameState, expedition?: ExpeditionState | null): IncidentLedgerEntry[] {
  const contextKey = incidentContextKey(expedition);
  return (state.incidentLedger?.entries ?? [])
    .filter((entry) => entry.contextKey === contextKey && entry.phase === 'active')
    .map((entry) => structuredClone(entry));
}

function completedSupportingOperationIds(state: SandboxGameState, entry: IncidentLedgerEntry): string[] {
  return (state.incidentResponseOperations?.operations ?? [])
    .filter((operation) => operation.contextKey === entry.contextKey && operation.incidentId === entry.incidentId && operation.phase === 'completed')
    .map((operation) => operation.id)
    .sort()
    .slice(-32);
}

function positiveEvidenceBase(
  state: SandboxGameState,
  entry: IncidentLedgerEntry,
  kind: IncidentPositiveResolutionEvidence['kind'],
  subjectIds: readonly string[],
): IncidentPositiveResolutionEvidence {
  return {
    id: `incident-resolution-evidence:${entry.occurrenceCount.toString(36)}:${entry.key}`,
    kind,
    observedAt: stateAbsoluteMinute(state),
    occurrenceNumber: entry.occurrenceCount,
    subjectIds: unique(subjectIds),
    supportingOperationIds: completedSupportingOperationIds(state, entry),
  };
}

function numericPositiveEvidence(
  state: SandboxGameState,
  entry: IncidentLedgerEntry,
  kind: IncidentPositiveResolutionEvidence['kind'],
  subjectIds: readonly string[],
  metric: NonNullable<IncidentPositiveResolutionEvidence['metric']>,
  observedValue: number,
  thresholdValue: number,
  comparison: 'gte' | 'lt',
): IncidentPositiveResolutionEvidence {
  return {
    ...positiveEvidenceBase(state, entry, kind, subjectIds),
    metric,
    observedValue: Math.round(observedValue * 1_000_000) / 1_000_000,
    thresholdValue: Math.round(thresholdValue * 1_000_000) / 1_000_000,
    comparison,
  };
}

function settlementPopulation(state: SandboxGameState): number {
  return Math.max(1, state.agents.filter((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement').length);
}

/**
 * I2-F explicit positive-evidence gate. Every supported resolution rule asserts a present,
 * observer-safe fact. Mere signal absence, elapsed time, operation completion, dispatch, or return
 * never qualifies. Unsupported incident families fail closed.
 */
export function derivePositiveIncidentResolutionEvidence(
  state: SandboxGameState,
  incidentId: string,
  expedition?: ExpeditionState | null,
): IncidentPositiveResolutionEvidence | null {
  const contextKey = incidentContextKey(expedition);
  const entry = state.incidentLedger?.entries.find((candidate) => candidate.contextKey === contextKey && candidate.incidentId === incidentId);
  if (!entry || entry.phase === 'expired') return null;

  const localPopulation = settlementPopulation(state);
  if (contextKey === 'settlement' && incidentId === 'incident:settlement:water-low') {
    const threshold = localPopulation * 1.5;
    if (state.settlement.resources.water < threshold) return null;
    return numericPositiveEvidence(state, entry, 'settlement-resource-threshold', [state.settlement.id], 'water', state.settlement.resources.water, threshold, 'gte');
  }
  if (contextKey === 'settlement' && incidentId === 'incident:settlement:water-watch') {
    const threshold = localPopulation * 3;
    if (state.settlement.resources.water < threshold) return null;
    return numericPositiveEvidence(state, entry, 'settlement-resource-threshold', [state.settlement.id], 'water', state.settlement.resources.water, threshold, 'gte');
  }
  if (contextKey === 'settlement' && incidentId === 'incident:settlement:food-low') {
    const threshold = localPopulation * 1.5;
    if (state.settlement.resources.food < threshold) return null;
    return numericPositiveEvidence(state, entry, 'settlement-resource-threshold', [state.settlement.id], 'food', state.settlement.resources.food, threshold, 'gte');
  }

  if (contextKey === 'settlement' && (incidentId === 'incident:settlement:injury' || incidentId === 'incident:settlement:pathology')) {
    const subjects = entry.lastCauseRefs;
    if (!subjects.length) return null;
    const injury = incidentId.endsWith(':injury');
    for (const subjectId of subjects) {
      const agent = state.agents.find((candidate) => candidate.id === subjectId);
      if (!agent?.alive || agent.expeditionId !== null || (agent.residence ?? 'settlement') !== 'settlement') return null;
      const stillActive = agent.pathology.some((pathology) => pathology.status === 'active' && (injury ? pathology.pathologyId === 'traumatic-wound' : pathology.pathologyId !== 'traumatic-wound'));
      if (stillActive) return null;
    }
    return positiveEvidenceBase(state, entry, 'recorded-case-cleared', subjects);
  }

  if (contextKey === 'settlement' && incidentId === 'incident:settlement:displaced-households') {
    const households = entry.lastCauseRefs.map((id) => state.settlement.households.find((household) => household.id === id));
    if (!households.length || households.some((household) => !household || household.displacement?.status !== 'returned' || household.displacement.returnedDay === undefined || !household.displacement.returnProviderSourceId)) return null;
    return positiveEvidenceBase(state, entry, 'provider-return-observed', entry.lastCauseRefs);
  }

  if (contextKey === 'settlement' && incidentId === 'incident:settlement:displaced-residents') {
    const agents = entry.lastCauseRefs.map((id) => state.agents.find((agent) => agent.id === id));
    if (!agents.length || agents.some((agent) => !agent?.alive || (agent.residence ?? 'settlement') !== 'settlement' || Number(agent.experience['displacement:return-day'] ?? -1) < 1)) return null;
    return positiveEvidenceBase(state, entry, 'provider-return-observed', entry.lastCauseRefs);
  }

  if (incidentId.startsWith('incident:research-blocked:')) {
    const projectId = incidentId.slice('incident:research-blocked:'.length);
    const project = state.researchProjects?.find((candidate) => candidate.id === projectId);
    if (!project?.sampleItemId) return null;
    const sample = state.directPlay?.inventory.find((item) => item.id === project.sampleItemId && item.quantity > 0);
    const holder = sample ? state.agents.find((agent) => agent.id === sample.ownerId) : undefined;
    if (!sample || !holder?.alive || holder.expeditionId !== null || (holder.residence ?? 'settlement') !== 'settlement') return null;
    return positiveEvidenceBase(state, entry, 'research-sample-present', [project.id, sample.id, holder.id]);
  }

  const contextExp = contextExpedition(state, contextKey);
  if (!contextExp) {
    if (contextKey === 'settlement' && incidentId.startsWith('incident:comm:')) {
      const expeditionId = incidentId.slice('incident:comm:'.length);
      const remote = state.expeditions.find((candidate) => candidate.id === expeditionId);
      const report = remote?.communicationReports?.at(-1);
      if (!remote || remote.communication !== 'connected' || !report?.verified || report.status !== 'connected') return null;
      return positiveEvidenceBase(state, entry, 'communication-restored', [remote.id, report.id]);
    }
    return null;
  }

  if (incidentId === `incident:health:${contextExp.id}`) {
    const threshold = state.doctrines.find((doctrine) => doctrine.id === contextExp.doctrineId)?.retreatHealth ?? 40;
    const subjects = entry.lastCauseRefs;
    const agents = subjects.map((id) => state.agents.find((agent) => agent.id === id));
    if (!agents.length || agents.some((agent) => !agent?.alive || agent.expeditionId !== contextExp.id || agent.health < threshold)) return null;
    return numericPositiveEvidence(state, entry, 'field-health-threshold', subjects, 'health', Math.min(...agents.map((agent) => agent!.health)), threshold, 'gte');
  }

  if (incidentId === `incident:fatigue:${contextExp.id}`) {
    const subjects = entry.lastCauseRefs;
    const agents = subjects.map((id) => state.agents.find((agent) => agent.id === id));
    if (!agents.length || agents.some((agent) => !agent?.alive || agent.expeditionId !== contextExp.id || agent.fatigue >= 72)) return null;
    return numericPositiveEvidence(state, entry, 'field-fatigue-threshold', subjects, 'fatigue', Math.max(...agents.map((agent) => agent!.fatigue)), 72, 'lt');
  }

  if (incidentId === `incident:supplies:${contextExp.id}`) {
    const living = contextExp.memberIds.map((id) => state.agents.find((agent) => agent.id === id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent?.alive));
    if (!living.length) return null;
    const foodDays = contextExp.supplies.food / (living.length * 1.7);
    const waterDays = contextExp.supplies.water / (living.length * 2.4);
    const supplyDays = Math.min(foodDays, waterDays);
    if (supplyDays < 2.5) return null;
    return numericPositiveEvidence(state, entry, 'field-supply-threshold', [contextExp.id], 'supply-days', supplyDays, 2.5, 'gte');
  }

  if (incidentId === `incident:field-comm:${contextExp.id}`) {
    if (contextExp.communication !== 'connected') return null;
    return positiveEvidenceBase(state, entry, 'communication-restored', [contextExp.id]);
  }

  if (incidentId.startsWith('incident:encounter:')) {
    const encounterId = incidentId.slice('incident:encounter:'.length);
    const encounter = state.encounters.find((candidate) => candidate.id === encounterId && candidate.expeditionId === contextExp.id);
    if (!encounter || encounter.status !== 'resolved') return null;
    return positiveEvidenceBase(state, entry, 'encounter-resolved', [encounter.id, contextExp.id]);
  }

  return null;
}

/**
 * I2-F terminal transition. The caller cannot assert resolution directly: the function derives
 * and records a supported positive observation from canonical observer-safe state. `false` means
 * either the incident is unknown/expired or no explicit positive criterion is currently satisfied.
 */
export function resolvePersistedIncident(state: SandboxGameState, incidentId: string, expedition?: ExpeditionState | null): boolean {
  const ledger = state.incidentLedger;
  if (!ledger) return false;
  const key = ledgerEntryKey(incidentContextKey(expedition), incidentId);
  const entry = ledger.entries.find((candidate) => candidate.key === key);
  if (!entry || entry.phase === 'expired') return false;
  if (entry.phase === 'resolved' && entry.lastResolutionEvidence) return true;
  const evidence = derivePositiveIncidentResolutionEvidence(state, incidentId, expedition);
  if (!evidence) return false;
  const nowMinute = stateAbsoluteMinute(state);
  entry.phase = 'resolved';
  entry.terminalAt = nowMinute;
  entry.lastUpdatedAt = nowMinute;
  entry.lastResolutionEvidence = evidence;
  ledger.lastSyncAt = Math.max(ledger.lastSyncAt, nowMinute);
  synchronizeIncidentResponseDebriefs(state);
  return true;
}

export function deriveVisibleIncidentProjection(
  state: SandboxGameState,
  expedition?: ExpeditionState | null,
  localProjection?: AreaProjection | null,
  context: Partial<IncidentPipelineContext> = {},
): IncidentProjection {
  const signals = synthesizeVisibleSituations(state, expedition, localProjection);
  const nowMinute = stateAbsoluteMinute(state);
  return projectIncidents(signals.map(incidentCandidateFromVisibleSituation), {
    nowMinute,
    maxVisible: 6,
    ...context,
  });
}

function incidentRows(incidents: readonly IncidentRecord[]): SituationSignal[] {
  return incidents.map((incident) => ({
    id: incident.id,
    severity: severityForUrgency(incident.urgency),
    title: incident.presentation.title,
    detail: incident.presentation.summary,
    basisIds: structuredClone(incident.causeRefs),
  }));
}

export function isI2F1IncidentAdapterEnabled(): boolean {
  try {
    return typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage.getItem(I2_F1_INCIDENT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Feature-flagged F1 adapter. Default OFF. When enabled it uses only observer-safe SituationSignal input.
 * If the incident projection unexpectedly becomes empty while legacy has visible rows, it fails closed to legacy.
 */
export function selectF1IncidentReadModel(
  state: SandboxGameState,
  expedition?: ExpeditionState | null,
  localProjection?: AreaProjection | null,
  enabled = isI2F1IncidentAdapterEnabled(),
): F1IncidentReadModel {
  const legacy = synthesizeVisibleSituations(state, expedition, localProjection);
  const projection = deriveVisibleIncidentProjection(state, expedition, localProjection);
  if (!enabled) return { source: 'legacy', rows: legacy, incidents: projection.incidents, audit: projection.audit };
  const rows = incidentRows(projection.incidents);
  if (legacy.length > 0 && rows.length === 0) {
    return { source: 'legacy', rows: legacy, incidents: projection.incidents, audit: projection.audit, fallbackReason: 'incident-projection-empty' };
  }
  return { source: 'incident', rows, incidents: projection.incidents, audit: projection.audit };
}


export interface IncidentResponseRosterServiceStat {
  memberId: string;
  terminalResponseCount: number;
  dutyMinutes: number;
  lastTerminalAt?: number;
}

export interface IncidentResponseRosterPlan {
  contextKey: IncidentContextKey;
  generatedAt: number;
  eligibleMemberIds: string[];
  committedMemberIds: string[];
  recoveringMemberIds: string[];
  primaryMemberIds: string[];
  reserveMemberIds: string[];
  overflowMemberIds: string[];
  serviceStats: IncidentResponseRosterServiceStat[];
  maxPrimaryMembers: number;
  maxReserveMembers: number;
}


export type IncidentResponseLogisticsBlocker =
  | 'incident-inactive'
  | 'team-capacity'
  | 'responder-capacity'
  | 'resource-shortfall';

export interface IncidentResponseLogisticsPlan {
  contextKey: IncidentContextKey;
  incidentId: string;
  generatedAt: number;
  requestedTeamSize: number;
  incidentActive: boolean;
  rosterMemberIds: string[];
  plannedMemberIds: string[];
  rosterReady: boolean;
  teamSlotReady: boolean;
  resourceReady: boolean;
  readyToAssign: boolean;
  readyToDispatch: boolean;
  blockers: IncidentResponseLogisticsBlocker[];
  mobilizationEstimateMinutes: number;
  workEstimateMinutes: number;
  returnEstimateMinutes: number;
  totalEstimateMinutes: number;
  projectedTerminalAt?: number;
  nextKnownRecoveryAt?: number;
  nextKnownOperationTerminalAt?: number;
  resourceSourceKind: IncidentResponseResourceSourceKind;
  resourceSourceExpeditionId?: string;
  requiredResources: IncidentResponseResourceAmounts;
  availableResources: IncidentResponseResourceAmounts;
  shortfallResources: IncidentResponseResourceAmounts;
}

export interface IncidentResponseCoordinationRequest {
  incidentId: string;
  teamSize: number;
}

export type IncidentResponseCoordinationDisposition = 'staged-now' | 'review';

export type IncidentResponseCoordinationBlocker = IncidentResponseLogisticsBlocker
  | 'coordination-team-capacity'
  | 'coordination-responder-capacity'
  | 'coordination-resource-shortfall';

export interface IncidentResponseCoordinationItem {
  requestIndex: number;
  incidentId: string;
  requestedTeamSize: number;
  disposition: IncidentResponseCoordinationDisposition;
  plannedMemberIds: string[];
  blockers: IncidentResponseCoordinationBlocker[];
  requiredResources: IncidentResponseResourceAmounts;
  availableResourcesBefore: IncidentResponseResourceAmounts;
  shortfallResources: IncidentResponseResourceAmounts;
  totalEstimateMinutes: number;
  projectedTerminalAt?: number;
  nextReviewAt?: number;
}

export interface IncidentResponseCoordinationPlan {
  contextKey: IncidentContextKey;
  generatedAt: number;
  requestCount: number;
  maxRequests: number;
  items: IncidentResponseCoordinationItem[];
  stagedRequestCount: number;
  reviewRequestCount: number;
  stagedMemberIds: string[];
  requestedResources: IncidentResponseResourceAmounts;
  stagedResources: IncidentResponseResourceAmounts;
  remainingResources: IncidentResponseResourceAmounts;
  nextReviewAt?: number;
}

export interface IncidentResponseCoordinationExecution {
  contextKey: IncidentContextKey;
  planGeneratedAt: number;
  requestIndex: number;
  incidentId: string;
  requestedTeamSize: number;
  memberIds: string[];
  team: IncidentDispatchTeam;
  operationId: string;
  resourceReservationId: string;
  reservedResources: IncidentResponseResourceAmounts;
}

export interface IncidentResponseCoordinationBatchExecutionItem extends IncidentResponseCoordinationExecution {
  batchPosition: number;
  originalRequestIndex: number;
}

export interface IncidentResponseCoordinationBatchReplanItem {
  originalRequestIndex: number;
  disposition: IncidentResponseCoordinationDisposition;
  plannedMemberIds: string[];
  blockers: IncidentResponseCoordinationBlocker[];
  nextReviewAt?: number;
}

export interface IncidentResponseCoordinationBatchExecution {
  contextKey: IncidentContextKey;
  startedAt: number;
  selectedRequestIndices: number[];
  executions: IncidentResponseCoordinationBatchExecutionItem[];
  remainingRequestIndices: number[];
  postExecutionReplan: IncidentResponseCoordinationBatchReplanItem[];
}

export type IncidentResponseCoordinationReadbackStatus =
  | 'assigned'
  | 'mobilizing'
  | 'working'
  | 'returning'
  | 'completed'
  | 'aborted'
  | 'stood-down'
  | 'missing';

export interface IncidentResponseCoordinationReadbackItem {
  batchPosition: number;
  originalRequestIndex: number;
  incidentId: string;
  requestedTeamSize: number;
  teamId: string;
  operationId: string;
  resourceReservationId: string;
  memberIds: string[];
  retained: boolean;
  status: IncidentResponseCoordinationReadbackStatus;
  teamPhase?: IncidentDispatchTeam['phase'];
  operationPhase?: IncidentResponseOperation['phase'];
  resourcePhase?: IncidentResponseResourceReservation['phase'];
  assignedAt?: number;
  dispatchedAt?: number;
  terminalAt?: number;
  reservedResources?: IncidentResponseResourceAmounts;
  consumedResources?: IncidentResponseResourceAmounts;
  returnedResources?: IncidentResponseResourceAmounts;
  debriefId?: string;
  positiveEvidenceCount: number;
  evidenceResourceUseCount: number;
}

export interface IncidentResponseCoordinationReadback {
  contextKey: IncidentContextKey;
  receiptStartedAt: number;
  readAt: number;
  selectedRequestIndices: number[];
  items: IncidentResponseCoordinationReadbackItem[];
  retainedCount: number;
  activeCount: number;
  terminalCount: number;
  missingCount: number;
}

export interface IncidentResponseCoordinationRetryPlan {
  contextKey: IncidentContextKey;
  generatedAt: number;
  originalRequestIndex: number;
  incidentId: string;
  requestedTeamSize: number;
  disposition: IncidentResponseCoordinationDisposition;
  plannedMemberIds: string[];
  blockers: IncidentResponseCoordinationBlocker[];
  requiredResources: IncidentResponseResourceAmounts;
  availableResourcesBefore: IncidentResponseResourceAmounts;
  shortfallResources: IncidentResponseResourceAmounts;
  nextReviewAt?: number;
  canExecuteNow: boolean;
}

export interface IncidentResponseCoordinationRetryExecution {
  retryPlan: IncidentResponseCoordinationRetryPlan;
  batch: IncidentResponseCoordinationBatchExecution;
}


export interface IncidentResponseExternalRetryReceipt {
  originalRequestIndex: number;
  receipt: IncidentResponseCoordinationBatchExecution;
}

export interface IncidentResponseExternalReceiptRegistryEntry {
  id: string;
  ordinal: number;
  registeredAt: number;
  contextKey: IncidentContextKey;
  requests: IncidentResponseCoordinationRequest[];
  receipt: IncidentResponseCoordinationBatchExecution;
  pendingRequestIndices: number[];
  retryReceipts: IncidentResponseExternalRetryReceipt[];
}

export interface IncidentResponseExternalReceiptRegistryV1 {
  schemaVersion: 1;
  nextOrdinal: number;
  maxEntries: number;
  entries: IncidentResponseExternalReceiptRegistryEntry[];
}

export type IncidentResponseExternalRetryQueueDisposition = 'ready-now' | 'review';

export interface IncidentResponseExternalRetryQueueItem {
  registryEntryId: string;
  registryOrdinal: number;
  originalRequestIndex: number;
  incidentId: string;
  requestedTeamSize: number;
  disposition: IncidentResponseExternalRetryQueueDisposition;
  blockers: IncidentResponseCoordinationBlocker[];
  plannedMemberIds: string[];
  nextReviewAt?: number;
}

export interface IncidentResponseExternalRetryQueueGuidance {
  contextKey: IncidentContextKey;
  generatedAt: number;
  registryEntryCount: number;
  readbackRetainedCount: number;
  readbackActiveCount: number;
  readbackTerminalCount: number;
  readbackMissingCount: number;
  items: IncidentResponseExternalRetryQueueItem[];
  readyNowCount: number;
  reviewCount: number;
  nextReviewAt?: number;
}

export interface IncidentResponseExternalRetryQueueExecution {
  guidanceBefore: IncidentResponseExternalRetryQueueGuidance;
  selectedItem: IncidentResponseExternalRetryQueueItem;
  retry: IncidentResponseCoordinationRetryExecution;
  registryEntry: IncidentResponseExternalReceiptRegistryEntry;
  guidanceAfter: IncidentResponseExternalRetryQueueGuidance;
}

export interface IncidentResponseExternalRetryQueueSelection {
  registryEntryId: string;
  originalRequestIndex: number;
}

export interface IncidentResponseExternalRetryQueueBatchExecution {
  contextKey: IncidentContextKey;
  startedAt: number;
  selections: IncidentResponseExternalRetryQueueSelection[];
  guidanceBefore: IncidentResponseExternalRetryQueueGuidance;
  executions: IncidentResponseExternalRetryQueueExecution[];
  guidanceAfter: IncidentResponseExternalRetryQueueGuidance;
}

export type IncidentResponseExternalBatchReadbackStatus = IncidentResponseCoordinationReadbackStatus | 'pending';

export interface IncidentResponseExternalBatchReadbackItem {
  registryEntryId: string;
  registryOrdinal: number;
  originalRequestIndex: number;
  incidentId: string;
  requestedTeamSize: number;
  receiptRecorded: boolean;
  retained: boolean;
  status: IncidentResponseExternalBatchReadbackStatus;
  teamId?: string;
  operationId?: string;
  resourceReservationId?: string;
  memberIds: string[];
  reservedResources?: IncidentResponseResourceAmounts;
  consumedResources?: IncidentResponseResourceAmounts;
  returnedResources?: IncidentResponseResourceAmounts;
  debriefId?: string;
  positiveEvidenceCount: number;
  evidenceResourceUseCount: number;
}

export interface IncidentResponseExternalBatchReadback {
  contextKey: IncidentContextKey;
  readAt: number;
  selections: IncidentResponseExternalRetryQueueSelection[];
  items: IncidentResponseExternalBatchReadbackItem[];
  recordedCount: number;
  pendingCount: number;
  retainedCount: number;
  activeCount: number;
  terminalCount: number;
  missingCount: number;
  reservedResources: IncidentResponseResourceAmounts;
  consumedResources: IncidentResponseResourceAmounts;
  returnedResources: IncidentResponseResourceAmounts;
}

export interface IncidentResponseExternalBatchRetryPlanItem extends IncidentResponseExternalRetryQueueItem {}

export interface IncidentResponseExternalBatchRetryPlan {
  contextKey: IncidentContextKey;
  generatedAt: number;
  selections: IncidentResponseExternalRetryQueueSelection[];
  items: IncidentResponseExternalBatchRetryPlanItem[];
  readyNowCount: number;
  reviewCount: number;
  canExecuteAtomicBatch: boolean;
  nextReviewAt?: number;
}

export interface IncidentResponseExternalBatchRetryExecution {
  retryPlan: IncidentResponseExternalBatchRetryPlan;
  batch: IncidentResponseExternalRetryQueueBatchExecution;
}

export type IncidentResponseExternalBatchReadbackFilter = 'all' | 'recorded' | 'pending' | 'active' | 'terminal' | 'missing';

export interface IncidentResponseExternalBatchReadbackView {
  contextKey: IncidentContextKey;
  readAt: number;
  filter: IncidentResponseExternalBatchReadbackFilter;
  query: string;
  selections: IncidentResponseExternalRetryQueueSelection[];
  items: IncidentResponseExternalBatchReadbackItem[];
  recordedCount: number;
  pendingCount: number;
  retainedCount: number;
  activeCount: number;
  terminalCount: number;
  missingCount: number;
  reservedResources: IncidentResponseResourceAmounts;
  consumedResources: IncidentResponseResourceAmounts;
  returnedResources: IncidentResponseResourceAmounts;
}

export interface IncidentResponseExternalBatchReadbackSnapshotV1 {
  schemaVersion: 1;
  authority: 'external-observer-snapshot';
  exportedAt: number;
  view: IncidentResponseExternalBatchReadbackView;
}

export interface IncidentResponseExternalReviewBatchReplan {
  contextKey: IncidentContextKey;
  generatedAt: number;
  selections: IncidentResponseExternalRetryQueueSelection[];
  items: IncidentResponseExternalBatchRetryPlanItem[];
  readySelections: IncidentResponseExternalRetryQueueSelection[];
  reviewSelections: IncidentResponseExternalRetryQueueSelection[];
  readyNowCount: number;
  reviewCount: number;
  canExecuteReadySubset: boolean;
  nextReviewAt?: number;
}

export interface IncidentDispatchCapacity {
  contextKey: IncidentContextKey;
  incidentId: string;
  incidentActive: boolean;
  eligibleMemberIds: string[];
  committedMemberIds: string[];
  recoveringMemberIds: string[];
  availableMemberIds: string[];
  activeContextTeamCount: number;
  activeIncidentTeamCount: number;
  maxTeamSize: number;
  maxActiveTeamsPerContext: number;
  maxActiveTeamsPerIncident: number;
  remainingContextTeamSlots: number;
  remainingIncidentTeamSlots: number;
  canAssign: boolean;
}

export function ensureIncidentDispatchState(state: SandboxGameState): IncidentDispatchStateV1 {
  const dispatch = state.incidentDispatch ?? (state.incidentDispatch = { schemaVersion: 1, nextDispatchOrdinal: 1, teams: [] });
  dispatch.schemaVersion = 1;
  dispatch.nextDispatchOrdinal = Math.max(1, Math.floor(dispatch.nextDispatchOrdinal || 1));
  dispatch.teams ??= [];
  return dispatch;
}

export function ensureIncidentResponseOperationState(state: SandboxGameState): IncidentResponseOperationStateV1 {
  const operations = state.incidentResponseOperations ?? (state.incidentResponseOperations = { schemaVersion: 1, nextObservationOrdinal: 1, operations: [] });
  operations.schemaVersion = 1;
  operations.nextObservationOrdinal = Math.max(1, Math.floor(operations.nextObservationOrdinal || 1));
  operations.operations ??= [];
  pruneIncidentResponseOperationHistory(state);
  return operations;
}

export function ensureIncidentResponseResourceState(state: SandboxGameState): IncidentResponseResourceStateV1 {
  const resources = state.incidentResponseResources ?? (state.incidentResponseResources = { schemaVersion: 1, reservations: [] });
  resources.schemaVersion = 1;
  resources.reservations ??= [];
  pruneIncidentResponseResourceHistory(state);
  return resources;
}

export function ensureIncidentResponseEvidenceResourceUseState(state: SandboxGameState): IncidentResponseEvidenceResourceUseStateV1 {
  const uses = state.incidentResponseEvidenceUses ?? (state.incidentResponseEvidenceUses = { schemaVersion: 1, nextUseOrdinal: 1, uses: [] });
  uses.schemaVersion = 1;
  uses.nextUseOrdinal = Math.max(1, Math.floor(uses.nextUseOrdinal || 1));
  uses.uses ??= [];
  pruneIncidentResponseEvidenceResourceUseHistory(state);
  return uses;
}

export function ensureIncidentResponseDebriefState(state: SandboxGameState): IncidentResponseDebriefStateV1 {
  const debriefs = state.incidentResponseDebriefs ?? (state.incidentResponseDebriefs = { schemaVersion: 1, debriefs: [] });
  debriefs.schemaVersion = 1;
  debriefs.debriefs ??= [];
  pruneIncidentResponseDebriefHistory(state);
  return debriefs;
}

export function incidentResponseRecoveryMinutes(dutyMinutes: number): number {
  const boundedDuty = Math.max(0, Math.floor(dutyMinutes));
  if (boundedDuty === 0) return 0;
  const quantized = Math.ceil((boundedDuty * INCIDENT_RESPONSE_RECOVERY_RATIO) / INCIDENT_RESPONSE_RECOVERY_QUANTUM_MINUTES) * INCIDENT_RESPONSE_RECOVERY_QUANTUM_MINUTES;
  return Math.min(INCIDENT_RESPONSE_RECOVERY_MAX_MINUTES, Math.max(INCIDENT_RESPONSE_RECOVERY_QUANTUM_MINUTES, quantized));
}

export function ensureIncidentResponseReadinessState(state: SandboxGameState): IncidentResponseReadinessStateV1 {
  const nowMinute = stateAbsoluteMinute(state);
  const readiness = state.incidentResponseReadiness ?? (state.incidentResponseReadiness = { schemaVersion: 1, policyActivatedAt: nowMinute, entries: [] });
  readiness.schemaVersion = 1;
  readiness.policyActivatedAt = Math.max(0, Math.floor(readiness.policyActivatedAt ?? nowMinute));
  readiness.entries ??= [];
  if (readiness.entries.length > INCIDENT_RESPONSE_MAX_READINESS_ENTRIES) readiness.entries = readiness.entries.slice(-INCIDENT_RESPONSE_MAX_READINESS_ENTRIES);
  return readiness;
}

function responseOperationTerminalAt(operation: IncidentResponseOperation): number | null {
  if (operation.phase === 'completed') return operation.completedAt ?? null;
  if (operation.phase === 'aborted') return operation.abortedAt ?? null;
  return null;
}

export interface IncidentResponseReadinessSyncAudit {
  policyActivatedAt: number;
  terminalOperationCount: number;
  activeRecoveryCount: number;
  recoveringMemberCount: number;
}

export function synchronizeIncidentResponseReadiness(state: SandboxGameState): IncidentResponseReadinessSyncAudit {
  const readiness = ensureIncidentResponseReadinessState(state);
  const nowMinute = stateAbsoluteMinute(state);
  const teams = new Map((state.incidentDispatch?.teams ?? []).map((team) => [team.id, team] as const));
  const latest = new Map<string, IncidentResponseReadinessEntry>();
  let terminalOperationCount = 0;
  for (const operation of state.incidentResponseOperations?.operations ?? []) {
    const terminalAt = responseOperationTerminalAt(operation);
    if (terminalAt === null || terminalAt <= readiness.policyActivatedAt) continue;
    terminalOperationCount += 1;
    const team = teams.get(operation.teamId);
    if (!team) continue;
    const dutyMinutes = Math.max(0, terminalAt - operation.startedAt);
    const recoveryUntil = terminalAt + incidentResponseRecoveryMinutes(dutyMinutes);
    if (recoveryUntil <= nowMinute) continue;
    for (const memberId of team.memberIds) {
      const entry: IncidentResponseReadinessEntry = {
        memberId,
        operationId: operation.id,
        contextKey: operation.contextKey,
        dutyMinutes,
        recoveryStartedAt: terminalAt,
        recoveryUntil,
      };
      const previous = latest.get(memberId);
      if (!previous || entry.recoveryUntil > previous.recoveryUntil || (entry.recoveryUntil === previous.recoveryUntil && entry.operationId > previous.operationId)) latest.set(memberId, entry);
    }
  }
  readiness.entries = [...latest.values()].sort((left, right) => left.recoveryUntil - right.recoveryUntil || left.memberId.localeCompare(right.memberId));
  if (readiness.entries.length > INCIDENT_RESPONSE_MAX_READINESS_ENTRIES) readiness.entries = readiness.entries.slice(-INCIDENT_RESPONSE_MAX_READINESS_ENTRIES);
  return {
    policyActivatedAt: readiness.policyActivatedAt,
    terminalOperationCount,
    activeRecoveryCount: readiness.entries.length,
    recoveringMemberCount: new Set(readiness.entries.map((entry) => entry.memberId)).size,
  };
}

export function incidentResponseReadinessEntries(state: SandboxGameState): IncidentResponseReadinessEntry[] {
  synchronizeIncidentResponseReadiness(state);
  return ensureIncidentResponseReadinessState(state).entries.map((entry) => structuredClone(entry));
}

function zeroResponseResourceAmounts(): IncidentResponseResourceAmounts {
  return { food: 0, water: 0, medicine: 0, tools: 0 };
}

function roundResourceAmount(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

function activeDispatchTeam(team: IncidentDispatchTeam): boolean {
  return team.phase === 'assigned' || team.phase === 'dispatched';
}

function activeResponseOperation(operation: IncidentResponseOperation): boolean {
  return operation.phase === 'mobilizing' || operation.phase === 'working' || operation.phase === 'returning';
}

function contextExpedition(state: SandboxGameState, contextKey: IncidentContextKey): ExpeditionState | null {
  if (contextKey === 'settlement') return null;
  return state.expeditions.find((entry) => entry.id === contextKey.slice('expedition:'.length)) ?? null;
}

function eligibleIncidentResponderIds(state: SandboxGameState, contextKey: IncidentContextKey): string[] {
  const expedition = contextExpedition(state, contextKey);
  if (contextKey !== 'settlement' && !expedition) return [];
  const allowed = expedition ? new Set(expedition.memberIds) : null;
  return state.agents
    .filter((agent) => agent.alive && agent.role !== 'child')
    .filter((agent) => expedition
      ? allowed!.has(agent.id) && agent.expeditionId === expedition.id && agent.residence === 'expedition'
      : agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement')
    .map((agent) => agent.id)
    .sort();
}

function activeLedgerIncident(state: SandboxGameState, contextKey: IncidentContextKey, incidentId: string): boolean {
  return Boolean(state.incidentLedger?.entries.some((entry) => entry.contextKey === contextKey && entry.incidentId === incidentId && entry.phase === 'active'));
}

function responseWorkMinutes(state: SandboxGameState, contextKey: IncidentContextKey, incidentId: string): number {
  const entry = state.incidentLedger?.entries.find((candidate) => candidate.contextKey === contextKey && candidate.incidentId === incidentId);
  const urgency = entry?.lastUrgency ?? 'medium';
  if (urgency === 'critical') return 240;
  if (urgency === 'high') return 180;
  if (urgency === 'medium') return 120;
  return 60;
}

function responseResourceBudgetForTeamSize(
  state: SandboxGameState,
  contextKey: IncidentContextKey,
  incidentId: string,
  teamSize: number,
): IncidentResponseResourceAmounts {
  const workMinutes = responseWorkMinutes(state, contextKey, incidentId);
  const totalHours = (INCIDENT_RESPONSE_MOBILIZATION_MINUTES + workMinutes + INCIDENT_RESPONSE_RETURN_MINUTES) / 60;
  const boundedTeamSize = Math.max(1, Math.min(INCIDENT_DISPATCH_MAX_TEAM_SIZE, Math.floor(teamSize)));
  const urgency = state.incidentLedger?.entries.find((entry) => entry.contextKey === contextKey && entry.incidentId === incidentId)?.lastUrgency ?? 'medium';
  const urgencyReserve = urgency === 'critical' ? 1 : urgency === 'high' ? 0.75 : urgency === 'medium' ? 0.5 : 0.25;
  return {
    food: roundResourceAmount(boundedTeamSize * totalHours * 0.04),
    water: roundResourceAmount(boundedTeamSize * totalHours * 0.06),
    medicine: roundResourceAmount(boundedTeamSize * 0.05 * urgencyReserve),
    tools: roundResourceAmount(boundedTeamSize * 0.05),
  };
}

function responseResourceBudget(state: SandboxGameState, team: IncidentDispatchTeam): IncidentResponseResourceAmounts {
  return responseResourceBudgetForTeamSize(state, team.contextKey as IncidentContextKey, team.incidentId, team.memberIds.length);
}

function responseResourceSource(state: SandboxGameState, contextKey: IncidentContextKey): {
  sourceKind: 'settlement' | 'expedition';
  sourceExpeditionId?: string;
  available: IncidentResponseResourceAmounts;
  mutate: (delta: IncidentResponseResourceAmounts) => void;
} {
  if (contextKey === 'settlement') {
    return {
      sourceKind: 'settlement',
      available: {
        food: state.settlement.resources.food,
        water: state.settlement.resources.water,
        medicine: state.settlement.resources.medicine,
        tools: state.settlement.resources.scrap,
      },
      mutate: (delta) => {
        adjustResourceStock(state, 'food', delta.food, 'Incident resource transfer');
        adjustResourceStock(state, 'water', delta.water, 'Incident resource transfer');
        adjustResourceStock(state, 'medicine', delta.medicine, 'Incident resource transfer');
        adjustResourceStock(state, 'scrap', delta.tools, 'Incident resource transfer');
      },
    };
  }
  const expeditionId = contextKey.slice('expedition:'.length);
  const expedition = state.expeditions.find((entry) => entry.id === expeditionId);
  if (!expedition) throw new Error(`Incident response resource source expedition does not exist: ${expeditionId}`);
  return {
    sourceKind: 'expedition',
    sourceExpeditionId: expedition.id,
    available: {
      food: expedition.supplies.food,
      water: expedition.supplies.water,
      medicine: expedition.supplies.medicine,
      tools: expedition.supplies.tools,
    },
    mutate: (delta) => {
      expedition.supplies.food = roundResourceAmount(expedition.supplies.food + delta.food);
      expedition.supplies.water = roundResourceAmount(expedition.supplies.water + delta.water);
      expedition.supplies.medicine = roundResourceAmount(expedition.supplies.medicine + delta.medicine);
      expedition.supplies.tools = roundResourceAmount(expedition.supplies.tools + delta.tools);
    },
  };
}

function subtractResourceAmounts(left: IncidentResponseResourceAmounts, right: IncidentResponseResourceAmounts): IncidentResponseResourceAmounts {
  return {
    food: roundResourceAmount(left.food - right.food),
    water: roundResourceAmount(left.water - right.water),
    medicine: roundResourceAmount(left.medicine - right.medicine),
    tools: roundResourceAmount(left.tools - right.tools),
  };
}

function operationProgressRatio(operation: IncidentResponseOperation): number {
  const planned = operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  if (planned <= 0) return operation.phase === 'completed' ? 1 : 0;
  const remaining = operation.mobilizationMinutesRemaining + operation.workMinutesRemaining + operation.returnMinutesRemaining;
  return Math.max(0, Math.min(1, (planned - remaining) / planned));
}

function consumedForProgress(reserved: IncidentResponseResourceAmounts, progress: number): IncidentResponseResourceAmounts {
  // Food/water represent bounded operating rations. Medicine and tools are availability reserves only
  // until a future explicit evidence-bearing action consumes them.
  return {
    food: roundResourceAmount(reserved.food * progress),
    water: roundResourceAmount(reserved.water * progress),
    medicine: 0,
    tools: 0,
  };
}

function pruneIncidentResponseResourceHistory(state: SandboxGameState): number {
  const resourceState = state.incidentResponseResources;
  if (!resourceState) return 0;
  const retainedOperationIds = new Set((state.incidentResponseOperations?.operations ?? []).map((operation) => operation.id));
  const linked = resourceState.reservations.filter((reservation) => retainedOperationIds.has(reservation.operationId));
  const live = linked.filter((reservation) => reservation.phase === 'reserved');
  const terminal = linked
    .filter((reservation) => reservation.phase !== 'reserved')
    .sort((left, right) => (right.settledAt ?? right.lastUpdatedAt) - (left.settledAt ?? left.lastUpdatedAt) || left.id.localeCompare(right.id));
  const keepTerminal = Math.max(0, INCIDENT_RESPONSE_MAX_RESOURCE_RESERVATIONS - live.length);
  const next = [...live, ...terminal.slice(0, keepTerminal)]
    .sort((left, right) => left.reservedAt - right.reservedAt || left.id.localeCompare(right.id));
  const pruned = resourceState.reservations.length - next.length;
  resourceState.reservations = next;
  return pruned;
}

function pruneIncidentResponseEvidenceResourceUseHistory(state: SandboxGameState): number {
  const useState = state.incidentResponseEvidenceUses;
  if (!useState) return 0;
  const operationIds = new Set((state.incidentResponseOperations?.operations ?? []).map((operation) => operation.id));
  const reservationIds = new Set((state.incidentResponseResources?.reservations ?? []).map((reservation) => reservation.id));
  const linked = useState.uses
    .filter((use) => operationIds.has(use.operationId) && reservationIds.has(use.reservationId))
    .sort((left, right) => right.recordedAt - left.recordedAt || right.ordinal - left.ordinal || left.id.localeCompare(right.id))
    .slice(0, INCIDENT_RESPONSE_MAX_EVIDENCE_RESOURCE_USES)
    .sort((left, right) => left.ordinal - right.ordinal);
  const pruned = useState.uses.length - linked.length;
  useState.uses = linked;
  return pruned;
}

function debriefTerminalAt(operation: IncidentResponseOperation): number | null {
  if (operation.phase === 'completed') return operation.completedAt ?? null;
  if (operation.phase === 'aborted') return operation.abortedAt ?? null;
  return null;
}

function clonePositiveEvidence(evidence: IncidentPositiveResolutionEvidence): IncidentPositiveResolutionEvidence {
  return structuredClone(evidence);
}

function debriefSourceRefreshAt(
  operation: IncidentResponseOperation,
  reservation: IncidentResponseResourceReservation | undefined,
  uses: readonly IncidentResponseEvidenceResourceUse[],
  positiveEvidence: readonly IncidentPositiveResolutionEvidence[],
): number {
  return Math.max(
    operation.completedAt ?? operation.abortedAt ?? operation.lastAdvancedAt,
    ...operation.observations.map((observation) => observation.observedAt),
    reservation?.lastUpdatedAt ?? 0,
    ...uses.map((use) => use.recordedAt),
    ...positiveEvidence.map((evidence) => evidence.observedAt),
  );
}

function pruneIncidentResponseDebriefHistory(state: SandboxGameState): number {
  const debriefState = state.incidentResponseDebriefs;
  if (!debriefState) return 0;
  const operationIds = new Set((state.incidentResponseOperations?.operations ?? []).map((operation) => operation.id));
  const linked = debriefState.debriefs
    .filter((debrief) => operationIds.has(debrief.operationId))
    .sort((left, right) => right.chronology.terminalAt - left.chronology.terminalAt || left.id.localeCompare(right.id))
    .slice(0, INCIDENT_RESPONSE_MAX_DEBRIEFS)
    .sort((left, right) => left.chronology.startedAt - right.chronology.startedAt || left.id.localeCompare(right.id));
  const pruned = debriefState.debriefs.length - linked.length;
  debriefState.debriefs = linked;
  return pruned;
}

function synchronizeOneIncidentResponseDebrief(
  state: SandboxGameState,
  operation: IncidentResponseOperation,
): IncidentResponseDebrief | null {
  const terminalAt = debriefTerminalAt(operation);
  if (terminalAt === null) return null;
  const team = state.incidentDispatch?.teams.find((candidate) => candidate.id === operation.teamId);
  if (!team) return null;
  const reservation = state.incidentResponseResources?.reservations.find((candidate) => candidate.operationId === operation.id);
  const uses = (state.incidentResponseEvidenceUses?.uses ?? [])
    .filter((use) => use.operationId === operation.id)
    .sort((left, right) => left.ordinal - right.ordinal);
  const ledger = state.incidentLedger?.entries.find((entry) => entry.contextKey === operation.contextKey && entry.incidentId === operation.incidentId);
  const currentEvidence = ledger?.lastResolutionEvidence;
  const debriefs = ensureIncidentResponseDebriefState(state);
  const suffix = operation.id.startsWith('incident-response:') ? operation.id.slice('incident-response:'.length) : operation.id;
  const id = `incident-response-debrief:${suffix}`;
  const existing = debriefs.debriefs.find((candidate) => candidate.operationId === operation.id);
  const positiveEvidence = currentEvidence?.supportingOperationIds.includes(operation.id)
    ? [clonePositiveEvidence(currentEvidence)].slice(-INCIDENT_RESPONSE_MAX_DEBRIEF_POSITIVE_EVIDENCE)
    : [];
  const terminalPhase = operation.phase as 'completed' | 'aborted';
  const next: IncidentResponseDebrief = {
    id,
    operationId: operation.id,
    teamId: operation.teamId,
    contextKey: operation.contextKey,
    incidentId: operation.incidentId,
    terminalPhase,
    generatedAt: existing?.generatedAt ?? terminalAt,
    lastRefreshedAt: debriefSourceRefreshAt(operation, reservation, uses, positiveEvidence),
    memberIds: [...team.memberIds].sort(),
    chronology: {
      startedAt: operation.startedAt,
      ...(operation.arrivedAt !== undefined ? { arrivedAt: operation.arrivedAt } : {}),
      ...(operation.workCompletedAt !== undefined ? { workCompletedAt: operation.workCompletedAt } : {}),
      terminalAt,
    },
    observations: operation.observations.map((observation) => structuredClone(observation)),
    positiveEvidence,
    evidenceResourceUses: uses.map((use) => structuredClone(use)),
    ...(reservation ? { resourceReservation: structuredClone(reservation) } : {}),
  };
  if (existing) Object.assign(existing, next);
  else debriefs.debriefs.push(next);
  return existing ?? next;
}

export interface IncidentResponseDebriefSyncAudit {
  terminalOperationCount: number;
  createdCount: number;
  refreshedCount: number;
  prunedCount: number;
  debriefCount: number;
}

/**
 * I2-H observer-safe projection seam. Debriefs are deterministic structured snapshots of already
 * persisted response facts. They do not infer whether a response caused an Incident to resolve.
 */
export function synchronizeIncidentResponseDebriefs(state: SandboxGameState): IncidentResponseDebriefSyncAudit {
  const debriefs = ensureIncidentResponseDebriefState(state);
  const beforeIds = new Set(debriefs.debriefs.map((debrief) => debrief.operationId));
  let terminalOperationCount = 0;
  let createdCount = 0;
  let refreshedCount = 0;
  for (const operation of ensureIncidentResponseOperationState(state).operations) {
    if (debriefTerminalAt(operation) === null) continue;
    terminalOperationCount += 1;
    const existed = beforeIds.has(operation.id);
    if (synchronizeOneIncidentResponseDebrief(state, operation)) {
      if (existed) refreshedCount += 1;
      else createdCount += 1;
    }
  }
  const prunedCount = pruneIncidentResponseDebriefHistory(state);
  return { terminalOperationCount, createdCount, refreshedCount, prunedCount, debriefCount: debriefs.debriefs.length };
}

export function incidentResponseDebriefs(
  state: SandboxGameState,
  incidentId?: string,
  expedition?: ExpeditionState | null,
): IncidentResponseDebrief[] {
  synchronizeIncidentResponseDebriefs(state);
  const contextKey = incidentContextKey(expedition);
  return ensureIncidentResponseDebriefState(state).debriefs
    .filter((debrief) => debrief.contextKey === contextKey && (!incidentId || debrief.incidentId === incidentId))
    .map((debrief) => structuredClone(debrief));
}

function pruneIncidentResponseOperationHistory(state: SandboxGameState): number {
  const operations = state.incidentResponseOperations;
  if (!operations) return 0;
  const retainedTeamIds = new Set((state.incidentDispatch?.teams ?? []).map((team) => team.id));
  const linked = operations.operations.filter((operation) => retainedTeamIds.has(operation.teamId));
  const active = linked.filter(activeResponseOperation);
  const terminal = linked
    .filter((operation) => !activeResponseOperation(operation))
    .sort((left, right) => {
      const leftTerminal = left.completedAt ?? left.abortedAt ?? left.lastAdvancedAt;
      const rightTerminal = right.completedAt ?? right.abortedAt ?? right.lastAdvancedAt;
      return rightTerminal - leftTerminal || left.id.localeCompare(right.id);
    });
  const keepTerminal = Math.max(0, INCIDENT_RESPONSE_MAX_OPERATIONS - active.length);
  const next = [...active, ...terminal.slice(0, keepTerminal)].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  const pruned = operations.operations.length - next.length;
  operations.operations = next;
  return pruned;
}

function appendResponseObservation(
  state: SandboxGameState,
  operation: IncidentResponseOperation,
  kind: IncidentResponseObservationKind,
  observedAt: number,
  incidentVisibility: IncidentResponseObservation['incidentVisibility'],
): IncidentResponseObservation {
  const operations = ensureIncidentResponseOperationState(state);
  const ordinal = operations.nextObservationOrdinal++;
  const observation: IncidentResponseObservation = {
    id: `incident-response-observation:${ordinal.toString(36)}`,
    ordinal,
    kind,
    observedAt,
    incidentVisibility,
  };
  operation.observations.push(observation);
  if (operation.observations.length > INCIDENT_RESPONSE_MAX_OBSERVATIONS_PER_OPERATION) {
    operation.observations.splice(0, operation.observations.length - INCIDENT_RESPONSE_MAX_OBSERVATIONS_PER_OPERATION);
  }
  return observation;
}

function teamMembersOperationallyAvailable(state: SandboxGameState, team: IncidentDispatchTeam): boolean {
  const eligible = new Set(eligibleIncidentResponderIds(state, team.contextKey as IncidentContextKey));
  return team.memberIds.every((memberId) => eligible.has(memberId));
}

function createIncidentResponseOperation(state: SandboxGameState, team: IncidentDispatchTeam, startAt = team.dispatchedAt): IncidentResponseOperation {
  const operations = ensureIncidentResponseOperationState(state);
  const existing = operations.operations.find((operation) => operation.teamId === team.id);
  if (existing) return existing;
  if (team.phase !== 'dispatched' || team.dispatchedAt === undefined) throw new Error('Incident response operation requires a dispatched team.');
  const effectiveStartAt = Math.max(team.dispatchedAt, Math.floor(startAt ?? team.dispatchedAt));
  const plannedWorkMinutes = responseWorkMinutes(state, team.contextKey as IncidentContextKey, team.incidentId);
  const operation: IncidentResponseOperation = {
    id: `incident-response:${team.dispatchOrdinal.toString(36)}`,
    teamId: team.id,
    contextKey: team.contextKey,
    incidentId: team.incidentId,
    phase: 'mobilizing',
    startedAt: effectiveStartAt,
    lastAdvancedAt: effectiveStartAt,
    plannedMobilizationMinutes: INCIDENT_RESPONSE_MOBILIZATION_MINUTES,
    plannedWorkMinutes,
    plannedReturnMinutes: INCIDENT_RESPONSE_RETURN_MINUTES,
    mobilizationMinutesRemaining: INCIDENT_RESPONSE_MOBILIZATION_MINUTES,
    workMinutesRemaining: plannedWorkMinutes,
    returnMinutesRemaining: INCIDENT_RESPONSE_RETURN_MINUTES,
    observations: [],
  };
  operations.operations.push(operation);
  pruneIncidentResponseOperationHistory(state);
  return operation;
}

function backfillIncidentResponseOperations(state: SandboxGameState): number {
  const dispatch = ensureIncidentDispatchState(state);
  const operations = ensureIncidentResponseOperationState(state);
  const existing = new Set(operations.operations.map((operation) => operation.teamId));
  const migrationStart = stateAbsoluteMinute(state);
  let created = 0;
  for (const team of dispatch.teams) {
    if (team.phase !== 'dispatched' || existing.has(team.id)) continue;
    createIncidentResponseOperation(state, team, migrationStart);
    existing.add(team.id);
    created += 1;
  }
  return created;
}

function assertResourceBudgetAvailable(available: IncidentResponseResourceAmounts, budget: IncidentResponseResourceAmounts): void {
  for (const key of ['food', 'water', 'medicine', 'tools'] as const) {
    if (available[key] + INCIDENT_RESPONSE_RESOURCE_EPSILON < budget[key]) {
      throw new Error(`Incident response dispatch lacks reserved ${key} capacity.`);
    }
  }
}

function reserveIncidentResponseResources(
  state: SandboxGameState,
  team: IncidentDispatchTeam,
  operation: IncidentResponseOperation,
  budget: IncidentResponseResourceAmounts,
): IncidentResponseResourceReservation {
  const resourceState = ensureIncidentResponseResourceState(state);
  const existing = resourceState.reservations.find((reservation) => reservation.operationId === operation.id);
  if (existing) return existing;
  const source = responseResourceSource(state, team.contextKey as IncidentContextKey);
  assertResourceBudgetAvailable(source.available, budget);
  const heldLots: NonNullable<IncidentResponseResourceReservation['heldLots']> = {};
  if (source.sourceKind === 'settlement') {
    for (const key of ['food', 'water', 'medicine', 'tools'] as const) heldLots[key] = consumeResourceLots(state, { resourceKey: key === 'tools' ? 'scrap' : key, amount: budget[key] });
  } else source.mutate({ food: -budget.food, water: -budget.water, medicine: -budget.medicine, tools: -budget.tools });
  const reservation: IncidentResponseResourceReservation = {
    id: `incident-response-resource:${team.dispatchOrdinal.toString(36)}`,
    operationId: operation.id,
    teamId: team.id,
    contextKey: team.contextKey,
    sourceKind: source.sourceKind,
    ...(source.sourceExpeditionId ? { sourceExpeditionId: source.sourceExpeditionId } : {}),
    phase: 'reserved',
    reservedAt: operation.startedAt,
    lastUpdatedAt: operation.startedAt,
    ...(source.sourceKind === 'settlement' ? { heldLots } : {}),
    reserved: structuredClone(budget),
    consumed: zeroResponseResourceAmounts(),
    returned: zeroResponseResourceAmounts(),
  };
  resourceState.reservations.push(reservation);
  pruneIncidentResponseResourceHistory(state);
  return reservation;
}

function backfillIncidentResponseResources(state: SandboxGameState): number {
  const resourceState = ensureIncidentResponseResourceState(state);
  const existing = new Set(resourceState.reservations.map((reservation) => reservation.operationId));
  const migrationAt = stateAbsoluteMinute(state);
  let created = 0;
  for (const operation of ensureIncidentResponseOperationState(state).operations) {
    if (existing.has(operation.id)) continue;
    const source = responseResourceSource(state, operation.contextKey as IncidentContextKey);
    resourceState.reservations.push({
      id: `incident-response-resource:legacy:${operation.id}`,
      operationId: operation.id,
      teamId: operation.teamId,
      contextKey: operation.contextKey,
      sourceKind: source.sourceKind,
      ...(source.sourceExpeditionId ? { sourceExpeditionId: source.sourceExpeditionId } : {}),
      phase: 'legacy-unfunded',
      reservedAt: migrationAt,
      lastUpdatedAt: migrationAt,
      reserved: zeroResponseResourceAmounts(),
      consumed: zeroResponseResourceAmounts(),
      returned: zeroResponseResourceAmounts(),
    });
    existing.add(operation.id);
    created += 1;
  }
  pruneIncidentResponseResourceHistory(state);
  return created;
}

function synchronizeIncidentResponseResourceReservation(
  state: SandboxGameState,
  operation: IncidentResponseOperation,
  atMinute: number,
): void {
  const reservation = state.incidentResponseResources?.reservations.find((entry) => entry.operationId === operation.id);
  if (!reservation || reservation.phase !== 'reserved') return;
  reservation.consumed = consumedForProgress(reservation.reserved, operationProgressRatio(operation));
  reservation.lastUpdatedAt = atMinute;
  if (activeResponseOperation(operation)) return;
  reservation.returned = subtractResourceAmounts(reservation.reserved, reservation.consumed);
  const source = responseResourceSource(state, reservation.contextKey as IncidentContextKey);
  if (reservation.heldLots) {
    for (const key of ['food', 'water', 'medicine', 'tools'] as const) restoreReservedResourceLots(state, reservation.heldLots[key] ?? [], reservation.reserved[key] > 0 ? reservation.returned[key] / reservation.reserved[key] : 0);
  } else source.mutate(reservation.returned);
  reservation.phase = 'settled';
  reservation.settledAt = operation.completedAt ?? operation.abortedAt ?? atMinute;
  reservation.lastUpdatedAt = reservation.settledAt;
}

function standDownTeamAt(team: IncidentDispatchTeam, atMinute: number): void {
  team.phase = 'stood-down';
  team.stoodDownAt = atMinute;
  team.lastUpdatedAt = atMinute;
}

function abortResponseOperation(
  state: SandboxGameState,
  operation: IncidentResponseOperation,
  team: IncidentDispatchTeam,
  kind: 'team-unavailable' | 'operator-stand-down',
  atMinute: number,
): void {
  if (!activeResponseOperation(operation)) return;
  operation.phase = 'aborted';
  operation.abortedAt = atMinute;
  operation.lastAdvancedAt = atMinute;
  appendResponseObservation(state, operation, kind, atMinute, 'not-checked');
  standDownTeamAt(team, atMinute);
  synchronizeIncidentResponseResourceReservation(state, operation, atMinute);
}

export interface IncidentResponseOperationSyncAudit {
  activeBefore: number;
  advancedCount: number;
  phaseTransitionCount: number;
  completedCount: number;
  abortedCount: number;
  observationCount: number;
  stoodDownCount: number;
  activeAfter: number;
}

/**
 * Advance dispatched I2-D response work using canonical elapsed game time only. Operational phase
 * completion is not Incident resolution. The sole Incident-related observation is whether the same
 * observer-safe ledger signal is currently visible when work completes.
 */
export function synchronizeIncidentResponseOperations(state: SandboxGameState): IncidentResponseOperationSyncAudit {
  const operations = ensureIncidentResponseOperationState(state);
  const dispatch = ensureIncidentDispatchState(state);
  const nowMinute = stateAbsoluteMinute(state);
  const audit: IncidentResponseOperationSyncAudit = {
    activeBefore: operations.operations.filter(activeResponseOperation).length,
    advancedCount: 0,
    phaseTransitionCount: 0,
    completedCount: 0,
    abortedCount: 0,
    observationCount: 0,
    stoodDownCount: 0,
    activeAfter: 0,
  };

  const ordered = operations.operations
    .filter(activeResponseOperation)
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));

  for (const operation of ordered) {
    const team = dispatch.teams.find((candidate) => candidate.id === operation.teamId);
    if (!team || team.phase !== 'dispatched') continue;
    if (!teamMembersOperationallyAvailable(state, team)) {
      abortResponseOperation(state, operation, team, 'team-unavailable', nowMinute);
      audit.abortedCount += 1;
      audit.observationCount += 1;
      audit.stoodDownCount += 1;
      continue;
    }

    let elapsed = Math.max(0, nowMinute - operation.lastAdvancedAt);
    if (elapsed <= 0) continue;
    audit.advancedCount += 1;
    let cursor = operation.lastAdvancedAt;
    let workCompletedThisSync = false;
    let completedThisSync = false;

    while (elapsed > 0 && activeResponseOperation(operation)) {
      if (operation.phase === 'mobilizing') {
        const step = Math.min(elapsed, operation.mobilizationMinutesRemaining);
        operation.mobilizationMinutesRemaining -= step;
        cursor += step;
        elapsed -= step;
        if (operation.mobilizationMinutesRemaining === 0) {
          operation.phase = 'working';
          operation.arrivedAt = cursor;
          audit.phaseTransitionCount += 1;
        }
        continue;
      }
      if (operation.phase === 'working') {
        const step = Math.min(elapsed, operation.workMinutesRemaining);
        operation.workMinutesRemaining -= step;
        cursor += step;
        elapsed -= step;
        if (operation.workMinutesRemaining === 0) {
          operation.phase = 'returning';
          operation.workCompletedAt = cursor;
          workCompletedThisSync = true;
          audit.phaseTransitionCount += 1;
        }
        continue;
      }
      const step = Math.min(elapsed, operation.returnMinutesRemaining);
      operation.returnMinutesRemaining -= step;
      cursor += step;
      elapsed -= step;
      if (operation.returnMinutesRemaining === 0) {
        operation.phase = 'completed';
        operation.completedAt = cursor;
        standDownTeamAt(team, cursor);
        completedThisSync = true;
        audit.phaseTransitionCount += 1;
        audit.completedCount += 1;
        audit.stoodDownCount += 1;
      }
    }

    operation.lastAdvancedAt = activeResponseOperation(operation) ? nowMinute : cursor;
    synchronizeIncidentResponseResourceReservation(state, operation, nowMinute);
    if (workCompletedThisSync) {
      appendResponseObservation(
        state,
        operation,
        'post-response-visibility',
        nowMinute,
        activeLedgerIncident(state, operation.contextKey as IncidentContextKey, operation.incidentId) ? 'visible' : 'not-visible',
      );
      audit.observationCount += 1;
    }
    if (completedThisSync) {
      appendResponseObservation(state, operation, 'return-complete', nowMinute, 'not-checked');
      audit.observationCount += 1;
    }
  }

  pruneIncidentDispatchHistory(dispatch);
  pruneIncidentResponseOperationHistory(state);
  pruneIncidentResponseResourceHistory(state);
  pruneIncidentResponseEvidenceResourceUseHistory(state);
  synchronizeIncidentResponseDebriefs(state);
  synchronizeIncidentResponseReadiness(state);
  audit.activeAfter = operations.operations.filter(activeResponseOperation).length;
  return audit;
}

export function incidentResponseOperations(
  state: SandboxGameState,
  incidentId?: string,
  expedition?: ExpeditionState | null,
): IncidentResponseOperation[] {
  const contextKey = incidentContextKey(expedition);
  return ensureIncidentResponseOperationState(state).operations
    .filter((operation) => operation.contextKey === contextKey && (!incidentId || operation.incidentId === incidentId))
    .map((operation) => structuredClone(operation));
}

export function incidentResponseResourceReservations(
  state: SandboxGameState,
  incidentId?: string,
  expedition?: ExpeditionState | null,
): IncidentResponseResourceReservation[] {
  const contextKey = incidentContextKey(expedition);
  const operationIds = new Set(ensureIncidentResponseOperationState(state).operations
    .filter((operation) => operation.contextKey === contextKey && (!incidentId || operation.incidentId === incidentId))
    .map((operation) => operation.id));
  return ensureIncidentResponseResourceState(state).reservations
    .filter((reservation) => operationIds.has(reservation.operationId))
    .map((reservation) => structuredClone(reservation));
}

const MEDICINE_EVIDENCE_KINDS = new Set<IncidentPositiveResolutionEvidence['kind']>(['recorded-case-cleared', 'field-health-threshold']);
const TOOL_EVIDENCE_KINDS = new Set<IncidentPositiveResolutionEvidence['kind']>(['communication-restored', 'encounter-resolved', 'research-sample-present']);

function normalizedEvidenceUseAmount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) throw new Error('Incident response evidence resource use requires finite non-negative amounts.');
  return roundResourceAmount(value);
}

/**
 * I2-G explicit reconciliation seam. A positive I2-F evidence record authorizes, but does not prove
 * the causal effectiveness of, bounded medicine/tool usage associated with one completed response.
 * The operator must confirm the amount. The function only reclassifies previously returned reserve
 * into canonical consumption and never mutates health, hidden cause truth, or Incident resolution.
 */
export function applyIncidentResponseEvidenceResourceUse(
  state: SandboxGameState,
  incidentId: string,
  requested: { medicine?: number; tools?: number },
  expedition?: ExpeditionState | null,
): IncidentResponseEvidenceResourceUse {
  const medicine = normalizedEvidenceUseAmount(requested.medicine);
  const tools = normalizedEvidenceUseAmount(requested.tools);
  if (medicine <= INCIDENT_RESPONSE_RESOURCE_EPSILON && tools <= INCIDENT_RESPONSE_RESOURCE_EPSILON) throw new Error('Incident response evidence resource use requires a positive medicine or tools amount.');

  const contextKey = incidentContextKey(expedition);
  const entry = state.incidentLedger?.entries.find((candidate) => candidate.contextKey === contextKey && candidate.incidentId === incidentId);
  const evidence = entry?.lastResolutionEvidence;
  if (!entry || entry.phase !== 'resolved' || !evidence || evidence.occurrenceNumber !== entry.occurrenceCount) {
    throw new Error('Incident response evidence resource use requires current explicit positive resolution evidence.');
  }
  if (medicine > INCIDENT_RESPONSE_RESOURCE_EPSILON && !MEDICINE_EVIDENCE_KINDS.has(evidence.kind)) throw new Error(`Positive evidence kind ${evidence.kind} does not authorize medicine reconciliation.`);
  if (tools > INCIDENT_RESPONSE_RESOURCE_EPSILON && !TOOL_EVIDENCE_KINDS.has(evidence.kind)) throw new Error(`Positive evidence kind ${evidence.kind} does not authorize tools reconciliation.`);

  const useState = ensureIncidentResponseEvidenceResourceUseState(state);
  const operations = ensureIncidentResponseOperationState(state).operations
    .filter((operation) => operation.contextKey === contextKey && operation.incidentId === incidentId && operation.phase === 'completed' && evidence.supportingOperationIds.includes(operation.id))
    .sort((left, right) => (right.completedAt ?? right.lastAdvancedAt) - (left.completedAt ?? left.lastAdvancedAt) || right.id.localeCompare(left.id));
  if (operations.length === 0) throw new Error('Incident response evidence resource use requires a completed supporting response operation.');

  let selected: { operation: IncidentResponseOperation; reservation: IncidentResponseResourceReservation } | null = null;
  for (const operation of operations) {
    const reservation = ensureIncidentResponseResourceState(state).reservations.find((candidate) => candidate.operationId === operation.id);
    if (!reservation || reservation.phase !== 'settled') continue;
    if (useState.uses.some((use) => use.operationId === operation.id && use.evidenceId === evidence.id)) continue;
    if (reservation.returned.medicine + INCIDENT_RESPONSE_RESOURCE_EPSILON < medicine) continue;
    if (reservation.returned.tools + INCIDENT_RESPONSE_RESOURCE_EPSILON < tools) continue;
    selected = { operation, reservation };
    break;
  }
  if (!selected) throw new Error('No completed supporting response has enough returned reserve for the requested evidence-grounded resource use.');

  const source = responseResourceSource(state, contextKey);
  const debit = { food: 0, water: 0, medicine, tools };
  assertResourceBudgetAvailable(source.available, debit);
  source.mutate({ food: 0, water: 0, medicine: -medicine, tools: -tools });

  const { operation, reservation } = selected;
  reservation.consumed.medicine = roundResourceAmount(reservation.consumed.medicine + medicine);
  reservation.consumed.tools = roundResourceAmount(reservation.consumed.tools + tools);
  reservation.returned.medicine = roundResourceAmount(reservation.returned.medicine - medicine);
  reservation.returned.tools = roundResourceAmount(reservation.returned.tools - tools);
  const recordedAt = stateAbsoluteMinute(state);
  reservation.lastUpdatedAt = Math.max(reservation.lastUpdatedAt, recordedAt);

  const ordinal = useState.nextUseOrdinal++;
  const use: IncidentResponseEvidenceResourceUse = {
    id: `incident-response-evidence-use:${ordinal.toString(36)}`,
    ordinal,
    operationId: operation.id,
    reservationId: reservation.id,
    contextKey,
    incidentId,
    evidenceId: evidence.id,
    evidenceKind: evidence.kind,
    evidenceOccurrenceNumber: evidence.occurrenceNumber,
    recordedAt,
    medicine,
    tools,
  };
  useState.uses.push(use);
  pruneIncidentResponseEvidenceResourceUseHistory(state);
  synchronizeIncidentResponseDebriefs(state);
  return structuredClone(use);
}

export function incidentResponseEvidenceResourceUses(
  state: SandboxGameState,
  incidentId?: string,
  expedition?: ExpeditionState | null,
): IncidentResponseEvidenceResourceUse[] {
  const contextKey = incidentContextKey(expedition);
  return ensureIncidentResponseEvidenceResourceUseState(state).uses
    .filter((use) => use.contextKey === contextKey && (!incidentId || use.incidentId === incidentId))
    .map((use) => structuredClone(use));
}

export function deriveIncidentResponseRosterPlan(
  state: SandboxGameState,
  expedition?: ExpeditionState | null,
): IncidentResponseRosterPlan {
  const contextKey = incidentContextKey(expedition);
  const eligibleMemberIds = eligibleIncidentResponderIds(state, contextKey);
  const dispatch = ensureIncidentDispatchState(state);
  synchronizeIncidentResponseReadiness(state);
  const recovering = new Set((state.incidentResponseReadiness?.entries ?? []).filter((entry) => entry.contextKey === contextKey).map((entry) => entry.memberId));
  const activeContextTeams = dispatch.teams.filter((team) => team.contextKey === contextKey && activeDispatchTeam(team));
  const committedMemberIds = unique(activeContextTeams.flatMap((team) => team.memberIds)).sort();
  const committed = new Set(committedMemberIds);
  const recoveringMemberIds = eligibleMemberIds.filter((id) => recovering.has(id)).sort();
  const policyActivatedAt = state.incidentResponseReadiness?.policyActivatedAt ?? stateAbsoluteMinute(state);
  const teams = new Map(dispatch.teams.map((team) => [team.id, team] as const));
  const stats = new Map<string, IncidentResponseRosterServiceStat>();
  for (const memberId of eligibleMemberIds) stats.set(memberId, { memberId, terminalResponseCount: 0, dutyMinutes: 0 });
  for (const operation of state.incidentResponseOperations?.operations ?? []) {
    if (operation.contextKey !== contextKey) continue;
    const terminalAt = responseOperationTerminalAt(operation);
    if (terminalAt === null || terminalAt <= policyActivatedAt) continue;
    const team = teams.get(operation.teamId);
    if (!team) continue;
    const dutyMinutes = Math.max(0, terminalAt - operation.startedAt);
    for (const memberId of team.memberIds) {
      const stat = stats.get(memberId);
      if (!stat) continue;
      stat.terminalResponseCount += 1;
      stat.dutyMinutes += dutyMinutes;
      stat.lastTerminalAt = stat.lastTerminalAt === undefined ? terminalAt : Math.max(stat.lastTerminalAt, terminalAt);
    }
  }
  const rank = (leftId: string, rightId: string): number => {
    const left = stats.get(leftId)!;
    const right = stats.get(rightId)!;
    if (left.dutyMinutes !== right.dutyMinutes) return left.dutyMinutes - right.dutyMinutes;
    if (left.terminalResponseCount !== right.terminalResponseCount) return left.terminalResponseCount - right.terminalResponseCount;
    const leftLast = left.lastTerminalAt ?? -1;
    const rightLast = right.lastTerminalAt ?? -1;
    if (leftLast !== rightLast) return leftLast - rightLast;
    return left.memberId.localeCompare(right.memberId);
  };
  const available = eligibleMemberIds.filter((id) => !committed.has(id) && !recovering.has(id)).sort(rank);
  const primaryMemberIds = available.slice(0, INCIDENT_RESPONSE_ROSTER_PRIMARY_LIMIT);
  const reserveMemberIds = available.slice(INCIDENT_RESPONSE_ROSTER_PRIMARY_LIMIT, INCIDENT_RESPONSE_ROSTER_PRIMARY_LIMIT + INCIDENT_RESPONSE_ROSTER_RESERVE_LIMIT);
  const overflowMemberIds = available.slice(INCIDENT_RESPONSE_ROSTER_PRIMARY_LIMIT + INCIDENT_RESPONSE_ROSTER_RESERVE_LIMIT);
  return {
    contextKey,
    generatedAt: stateAbsoluteMinute(state),
    eligibleMemberIds,
    committedMemberIds,
    recoveringMemberIds,
    primaryMemberIds,
    reserveMemberIds,
    overflowMemberIds,
    serviceStats: [...stats.values()].sort((left, right) => left.memberId.localeCompare(right.memberId)),
    maxPrimaryMembers: INCIDENT_RESPONSE_ROSTER_PRIMARY_LIMIT,
    maxReserveMembers: INCIDENT_RESPONSE_ROSTER_RESERVE_LIMIT,
  };
}

export function deriveIncidentResponseLogisticsPlan(
  state: SandboxGameState,
  incidentId: string,
  teamSize = 1,
  expedition?: ExpeditionState | null,
): IncidentResponseLogisticsPlan {
  const requestedTeamSize = Math.floor(teamSize);
  if (requestedTeamSize < 1 || requestedTeamSize > INCIDENT_DISPATCH_MAX_TEAM_SIZE) {
    throw new Error(`Incident response logistics team size must be 1-${INCIDENT_DISPATCH_MAX_TEAM_SIZE}.`);
  }
  const contextKey = incidentContextKey(expedition);
  const nowMinute = stateAbsoluteMinute(state);
  const capacity = deriveIncidentDispatchCapacity(state, incidentId, expedition);
  const roster = deriveIncidentResponseRosterPlan(state, expedition);
  const rosterMemberIds = [...roster.primaryMemberIds, ...roster.reserveMemberIds, ...roster.overflowMemberIds]
    .filter((id) => capacity.availableMemberIds.includes(id));
  const plannedMemberIds = rosterMemberIds.slice(0, requestedTeamSize);
  const rosterReady = plannedMemberIds.length === requestedTeamSize;
  const teamSlotReady = capacity.remainingContextTeamSlots > 0 && capacity.remainingIncidentTeamSlots > 0;
  const requiredResources = responseResourceBudgetForTeamSize(state, contextKey, incidentId, requestedTeamSize);
  const resourceSource = responseResourceSource(state, contextKey);
  const availableResources = structuredClone(resourceSource.available);
  const shortfallResources: IncidentResponseResourceAmounts = {
    food: roundResourceAmount(Math.max(0, requiredResources.food - availableResources.food)),
    water: roundResourceAmount(Math.max(0, requiredResources.water - availableResources.water)),
    medicine: roundResourceAmount(Math.max(0, requiredResources.medicine - availableResources.medicine)),
    tools: roundResourceAmount(Math.max(0, requiredResources.tools - availableResources.tools)),
  };
  const resourceReady = shortfallResources.food <= INCIDENT_RESPONSE_RESOURCE_EPSILON
    && shortfallResources.water <= INCIDENT_RESPONSE_RESOURCE_EPSILON
    && shortfallResources.medicine <= INCIDENT_RESPONSE_RESOURCE_EPSILON
    && shortfallResources.tools <= INCIDENT_RESPONSE_RESOURCE_EPSILON;
  const blockers: IncidentResponseLogisticsBlocker[] = [];
  if (!capacity.incidentActive) blockers.push('incident-inactive');
  if (!teamSlotReady) blockers.push('team-capacity');
  if (!rosterReady) blockers.push('responder-capacity');
  if (!resourceReady) blockers.push('resource-shortfall');
  const workEstimateMinutes = responseWorkMinutes(state, contextKey, incidentId);
  const totalEstimateMinutes = INCIDENT_RESPONSE_MOBILIZATION_MINUTES + workEstimateMinutes + INCIDENT_RESPONSE_RETURN_MINUTES;
  const recoveryTimes = (state.incidentResponseReadiness?.entries ?? [])
    .filter((entry) => entry.contextKey === contextKey && entry.recoveryUntil > nowMinute)
    .map((entry) => entry.recoveryUntil)
    .sort((a, b) => a - b);
  const activeTeamIds = new Set(ensureIncidentDispatchState(state).teams
    .filter((team) => team.contextKey === contextKey && activeDispatchTeam(team))
    .map((team) => team.id));
  const projectedOperationTerminals = (state.incidentResponseOperations?.operations ?? [])
    .filter((operation) => operation.contextKey === contextKey && activeTeamIds.has(operation.teamId) && activeResponseOperation(operation))
    .map((operation) => nowMinute + operation.mobilizationMinutesRemaining + operation.workMinutesRemaining + operation.returnMinutesRemaining)
    .sort((a, b) => a - b);
  const readyToAssign = capacity.incidentActive && teamSlotReady && rosterReady;
  const readyToDispatch = readyToAssign && resourceReady;
  return {
    contextKey,
    incidentId,
    generatedAt: nowMinute,
    requestedTeamSize,
    incidentActive: capacity.incidentActive,
    rosterMemberIds,
    plannedMemberIds,
    rosterReady,
    teamSlotReady,
    resourceReady,
    readyToAssign,
    readyToDispatch,
    blockers,
    mobilizationEstimateMinutes: INCIDENT_RESPONSE_MOBILIZATION_MINUTES,
    workEstimateMinutes,
    returnEstimateMinutes: INCIDENT_RESPONSE_RETURN_MINUTES,
    totalEstimateMinutes,
    ...(readyToDispatch ? { projectedTerminalAt: nowMinute + totalEstimateMinutes } : {}),
    ...(recoveryTimes.length ? { nextKnownRecoveryAt: recoveryTimes[0] } : {}),
    ...(projectedOperationTerminals.length ? { nextKnownOperationTerminalAt: projectedOperationTerminals[0] } : {}),
    resourceSourceKind: resourceSource.sourceKind,
    ...(resourceSource.sourceExpeditionId ? { resourceSourceExpeditionId: resourceSource.sourceExpeditionId } : {}),
    requiredResources,
    availableResources,
    shortfallResources,
  };
}


function addResponseResourceAmounts(
  left: IncidentResponseResourceAmounts,
  right: IncidentResponseResourceAmounts,
): IncidentResponseResourceAmounts {
  return {
    food: roundResourceAmount(left.food + right.food),
    water: roundResourceAmount(left.water + right.water),
    medicine: roundResourceAmount(left.medicine + right.medicine),
    tools: roundResourceAmount(left.tools + right.tools),
  };
}

function responseResourceShortfall(
  required: IncidentResponseResourceAmounts,
  available: IncidentResponseResourceAmounts,
): IncidentResponseResourceAmounts {
  return {
    food: roundResourceAmount(Math.max(0, required.food - available.food)),
    water: roundResourceAmount(Math.max(0, required.water - available.water)),
    medicine: roundResourceAmount(Math.max(0, required.medicine - available.medicine)),
    tools: roundResourceAmount(Math.max(0, required.tools - available.tools)),
  };
}

function hasResponseResourceShortfall(amounts: IncidentResponseResourceAmounts): boolean {
  return amounts.food > INCIDENT_RESPONSE_RESOURCE_EPSILON
    || amounts.water > INCIDENT_RESPONSE_RESOURCE_EPSILON
    || amounts.medicine > INCIDENT_RESPONSE_RESOURCE_EPSILON
    || amounts.tools > INCIDENT_RESPONSE_RESOURCE_EPSILON;
}

/**
 * I2-P multi-response coordination is intentionally a pure planning read model. Requests retain
 * operator order. Earlier requests may consume virtual responder/team/resource staging capacity
 * inside this single derived plan, but no team, reservation, schedule, or World truth is written.
 */
export function deriveIncidentResponseCoordinationPlan(
  state: SandboxGameState,
  requests: readonly IncidentResponseCoordinationRequest[],
  expedition?: ExpeditionState | null,
): IncidentResponseCoordinationPlan {
  if (requests.length < 1 || requests.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) {
    throw new Error(`Incident response coordination requires 1-${INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS} requests.`);
  }
  const contextKey = incidentContextKey(expedition);
  const generatedAt = stateAbsoluteMinute(state);
  const source = responseResourceSource(state, contextKey);
  let remainingResources = structuredClone(source.available);
  let requestedResources = zeroResponseResourceAmounts();
  let stagedResources = zeroResponseResourceAmounts();
  const virtuallyCommitted = new Set<string>();
  let virtualContextTeamCount = 0;
  const virtualIncidentTeamCounts = new Map<string, number>();
  const stagedReleaseTimes: number[] = [];
  const items: IncidentResponseCoordinationItem[] = [];

  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex]!;
    const teamSize = Math.floor(request.teamSize);
    const base = deriveIncidentResponseLogisticsPlan(state, request.incidentId, teamSize, expedition);
    requestedResources = addResponseResourceAmounts(requestedResources, base.requiredResources);
    const capacity = deriveIncidentDispatchCapacity(state, request.incidentId, expedition);
    const candidateMemberIds = base.rosterMemberIds.filter((memberId) => !virtuallyCommitted.has(memberId));
    const plannedMemberIds = candidateMemberIds.slice(0, teamSize);
    const virtualRosterReady = plannedMemberIds.length === teamSize;
    const virtualContextSlots = Math.max(0, capacity.remainingContextTeamSlots - virtualContextTeamCount);
    const virtualIncidentSlots = Math.max(0, capacity.remainingIncidentTeamSlots - (virtualIncidentTeamCounts.get(request.incidentId) ?? 0));
    const virtualTeamSlotReady = virtualContextSlots > 0 && virtualIncidentSlots > 0;
    const availableResourcesBefore = structuredClone(remainingResources);
    const shortfallResources = responseResourceShortfall(base.requiredResources, remainingResources);
    const virtualResourceReady = !hasResponseResourceShortfall(shortfallResources);
    const blockers: IncidentResponseCoordinationBlocker[] = [];
    if (!base.incidentActive) blockers.push('incident-inactive');
    if (!base.teamSlotReady) blockers.push('team-capacity');
    else if (!virtualTeamSlotReady) blockers.push('coordination-team-capacity');
    if (!base.rosterReady) blockers.push('responder-capacity');
    else if (!virtualRosterReady) blockers.push('coordination-responder-capacity');
    if (!base.resourceReady) blockers.push('resource-shortfall');
    else if (!virtualResourceReady) blockers.push('coordination-resource-shortfall');

    const stagedNow = blockers.length === 0;
    let projectedTerminalAt: number | undefined;
    if (stagedNow) {
      for (const memberId of plannedMemberIds) virtuallyCommitted.add(memberId);
      virtualContextTeamCount += 1;
      virtualIncidentTeamCounts.set(request.incidentId, (virtualIncidentTeamCounts.get(request.incidentId) ?? 0) + 1);
      remainingResources = subtractResourceAmounts(remainingResources, base.requiredResources);
      stagedResources = addResponseResourceAmounts(stagedResources, base.requiredResources);
      projectedTerminalAt = generatedAt + base.totalEstimateMinutes;
      stagedReleaseTimes.push(projectedTerminalAt);
    }

    const reviewCandidates = [
      base.nextKnownRecoveryAt,
      base.nextKnownOperationTerminalAt,
      ...stagedReleaseTimes,
    ].filter((value): value is number => value !== undefined && value > generatedAt)
      .sort((left, right) => left - right);

    items.push({
      requestIndex,
      incidentId: request.incidentId,
      requestedTeamSize: teamSize,
      disposition: stagedNow ? 'staged-now' : 'review',
      plannedMemberIds,
      blockers,
      requiredResources: structuredClone(base.requiredResources),
      availableResourcesBefore,
      shortfallResources,
      totalEstimateMinutes: base.totalEstimateMinutes,
      ...(projectedTerminalAt !== undefined ? { projectedTerminalAt } : {}),
      ...(!stagedNow && reviewCandidates.length ? { nextReviewAt: reviewCandidates[0] } : {}),
    });
  }

  const reviewTimes = items.map((item) => item.nextReviewAt).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const stagedMemberIds = [...virtuallyCommitted].sort();
  return {
    contextKey,
    generatedAt,
    requestCount: requests.length,
    maxRequests: INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS,
    items,
    stagedRequestCount: items.filter((item) => item.disposition === 'staged-now').length,
    reviewRequestCount: items.filter((item) => item.disposition === 'review').length,
    stagedMemberIds,
    requestedResources,
    stagedResources,
    remainingResources,
    ...(reviewTimes.length ? { nextReviewAt: reviewTimes[0] } : {}),
  };
}

/**
 * I2-Q executes exactly one operator-selected request from a freshly re-derived I2-P coordination
 * plan. The coordination plan remains advisory: this helper delegates all canonical mutation to the
 * existing I2-C assignment and I2-E dispatch/resource seams. Review/invalid selections are no-ops.
 * If a downstream invariant unexpectedly fails after assignment, the entire sandbox state is restored
 * to the pre-call snapshot so the helper never leaves a partial assignment/reservation behind.
 */
export function executeIncidentResponseCoordinationRequest(
  state: SandboxGameState,
  requests: readonly IncidentResponseCoordinationRequest[],
  requestIndex: number,
  expedition?: ExpeditionState | null,
): IncidentResponseCoordinationExecution {
  const selectedIndex = Math.floor(requestIndex);
  if (!Number.isFinite(requestIndex) || selectedIndex !== requestIndex || selectedIndex < 0 || selectedIndex >= requests.length) {
    throw new Error('Incident response coordination execution requires a valid operator-selected request index.');
  }
  const snapshot = structuredClone(state);
  try {
    const plan = deriveIncidentResponseCoordinationPlan(state, requests, expedition);
    const item = plan.items.find((entry) => entry.requestIndex === selectedIndex);
    if (!item) throw new Error('Selected incident response coordination request is unavailable.');
    if (item.disposition !== 'staged-now') {
      throw new Error(`Selected incident response coordination request requires review: ${item.blockers.join(', ') || 'not-staged'}.`);
    }
    if (item.plannedMemberIds.length !== item.requestedTeamSize) {
      throw new Error('Selected incident response coordination request has incomplete responder staging.');
    }
    const assigned = assignIncidentResponseTeam(state, item.incidentId, item.plannedMemberIds, expedition);
    const team = dispatchIncidentResponseTeam(state, assigned.id);
    const operation = state.incidentResponseOperations?.operations.find((entry) => entry.teamId === team.id);
    const reservation = state.incidentResponseResources?.reservations.find((entry) => entry.teamId === team.id);
    if (!operation || !reservation) throw new Error('Incident response coordination execution did not produce canonical operation/resource records.');
    for (const key of ['food', 'water', 'medicine', 'tools'] as const) {
      if (Math.abs(reservation.reserved[key] - item.requiredResources[key]) > INCIDENT_RESPONSE_RESOURCE_EPSILON) {
        throw new Error(`Incident response coordination execution resource mismatch for ${key}.`);
      }
    }
    return {
      contextKey: plan.contextKey,
      planGeneratedAt: plan.generatedAt,
      requestIndex: item.requestIndex,
      incidentId: item.incidentId,
      requestedTeamSize: item.requestedTeamSize,
      memberIds: [...team.memberIds],
      team,
      operationId: operation.id,
      resourceReservationId: reservation.id,
      reservedResources: structuredClone(reservation.reserved),
    };
  } catch (error) {
    const mutable = state as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutable)) delete mutable[key];
    Object.assign(mutable, snapshot as unknown as Record<string, unknown>);
    throw error;
  }
}

/**
 * I2-R atomically commits an explicit operator-selected batch. Only selected requests participate in
 * batch staging; unselected requests remain advisory and are returned as post-execution replan
 * guidance. Every selected request is re-derived immediately before its own canonical I2-C/I2-E
 * execution. If any selected request becomes review-only or any downstream seam fails, the entire
 * batch restores the pre-call sandbox snapshot, so partial teams/reservations never survive.
 */
export function executeIncidentResponseCoordinationBatch(
  state: SandboxGameState,
  requests: readonly IncidentResponseCoordinationRequest[],
  selectedRequestIndices: readonly number[],
  expedition?: ExpeditionState | null,
): IncidentResponseCoordinationBatchExecution {
  if (selectedRequestIndices.length < 1 || selectedRequestIndices.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) {
    throw new Error(`Incident response coordination batch requires 1-${INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS} selected requests.`);
  }
  const normalized = selectedRequestIndices.map((value) => Math.floor(value));
  if (normalized.some((value, index) => !Number.isFinite(selectedRequestIndices[index]) || value !== selectedRequestIndices[index] || value < 0 || value >= requests.length)) {
    throw new Error('Incident response coordination batch requires valid operator-selected request indices.');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Incident response coordination batch cannot select the same request more than once.');
  }

  const snapshot = structuredClone(state);
  const startedAt = stateAbsoluteMinute(state);
  const contextKey = incidentContextKey(expedition);
  try {
    const executions: IncidentResponseCoordinationBatchExecutionItem[] = [];
    for (let batchPosition = 0; batchPosition < normalized.length; batchPosition += 1) {
      const pendingOriginalIndices = normalized.slice(batchPosition);
      const pendingRequests = pendingOriginalIndices.map((index) => requests[index]!);
      const freshPlan = deriveIncidentResponseCoordinationPlan(state, pendingRequests, expedition);
      const selected = freshPlan.items[0];
      if (!selected || selected.disposition !== 'staged-now') {
        throw new Error(`Selected incident response coordination batch request requires review at original index ${pendingOriginalIndices[0]}: ${selected?.blockers.join(', ') || 'not-staged'}.`);
      }
      const execution = executeIncidentResponseCoordinationRequest(state, pendingRequests, 0, expedition);
      executions.push({
        ...execution,
        batchPosition,
        originalRequestIndex: pendingOriginalIndices[0]!,
      });
    }

    const selectedSet = new Set(normalized);
    const remainingRequestIndices = requests.map((_, index) => index).filter((index) => !selectedSet.has(index));
    const postExecutionReplan: IncidentResponseCoordinationBatchReplanItem[] = [];
    if (remainingRequestIndices.length) {
      const remainingRequests = remainingRequestIndices.map((index) => requests[index]!);
      const replan = deriveIncidentResponseCoordinationPlan(state, remainingRequests, expedition);
      for (const item of replan.items) {
        postExecutionReplan.push({
          originalRequestIndex: remainingRequestIndices[item.requestIndex]!,
          disposition: item.disposition,
          plannedMemberIds: [...item.plannedMemberIds],
          blockers: [...item.blockers],
          ...(item.nextReviewAt !== undefined ? { nextReviewAt: item.nextReviewAt } : {}),
        });
      }
    }

    return {
      contextKey,
      startedAt,
      selectedRequestIndices: [...normalized],
      executions,
      remainingRequestIndices,
      postExecutionReplan,
    };
  } catch (error) {
    const mutable = state as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutable)) delete mutable[key];
    Object.assign(mutable, snapshot as unknown as Record<string, unknown>);
    throw error;
  }
}

/**
 * I2-S readback projects one external I2-R receipt onto currently retained canonical response
 * records. The receipt is not sandbox authority and is never persisted by this helper. Existing
 * team/operation/resource/debrief records remain the only source of current status.
 */
export function deriveIncidentResponseCoordinationReadback(
  state: SandboxGameState,
  receipt: IncidentResponseCoordinationBatchExecution,
  expedition?: ExpeditionState | null,
): IncidentResponseCoordinationReadback {
  const contextKey = incidentContextKey(expedition);
  if (receipt.contextKey !== contextKey) throw new Error('Incident response coordination readback receipt context does not match the requested canonical context.');
  if (receipt.executions.length !== receipt.selectedRequestIndices.length) throw new Error('Incident response coordination readback receipt execution count is inconsistent.');
  const seenTeams = new Set<string>();
  const seenOperations = new Set<string>();
  const seenReservations = new Set<string>();
  const dispatch = ensureIncidentDispatchState(state);
  const operations = ensureIncidentResponseOperationState(state).operations;
  const reservations = ensureIncidentResponseResourceState(state).reservations;
  synchronizeIncidentResponseDebriefs(state);
  const debriefs = ensureIncidentResponseDebriefState(state).debriefs;
  const uses = ensureIncidentResponseEvidenceResourceUseState(state).uses;
  const items: IncidentResponseCoordinationReadbackItem[] = [];

  for (let index = 0; index < receipt.executions.length; index += 1) {
    const execution = receipt.executions[index]!;
    if (execution.contextKey !== contextKey) throw new Error('Incident response coordination readback execution context mismatch.');
    if (execution.batchPosition !== index || execution.originalRequestIndex !== receipt.selectedRequestIndices[index]) {
      throw new Error('Incident response coordination readback receipt ordering is inconsistent.');
    }
    if (seenTeams.has(execution.team.id) || seenOperations.has(execution.operationId) || seenReservations.has(execution.resourceReservationId)) {
      throw new Error('Incident response coordination readback receipt contains duplicate canonical identifiers.');
    }
    seenTeams.add(execution.team.id);
    seenOperations.add(execution.operationId);
    seenReservations.add(execution.resourceReservationId);
    const team = dispatch.teams.find((entry) => entry.id === execution.team.id);
    const operation = operations.find((entry) => entry.id === execution.operationId);
    const reservation = reservations.find((entry) => entry.id === execution.resourceReservationId);

    if (!team || !operation || !reservation) {
      items.push({
        batchPosition: execution.batchPosition,
        originalRequestIndex: execution.originalRequestIndex,
        incidentId: execution.incidentId,
        requestedTeamSize: execution.requestedTeamSize,
        teamId: execution.team.id,
        operationId: execution.operationId,
        resourceReservationId: execution.resourceReservationId,
        memberIds: [...execution.memberIds],
        retained: false,
        status: 'missing',
        positiveEvidenceCount: 0,
        evidenceResourceUseCount: 0,
      });
      continue;
    }

    if (team.contextKey !== contextKey || operation.contextKey !== contextKey || reservation.contextKey !== contextKey
      || team.incidentId !== execution.incidentId || operation.incidentId !== execution.incidentId
      || operation.teamId !== team.id || reservation.teamId !== team.id || reservation.operationId !== operation.id
      || team.memberIds.length !== execution.memberIds.length
      || !team.memberIds.every((memberId, memberIndex) => memberId === [...execution.memberIds].sort()[memberIndex])) {
      throw new Error('Incident response coordination readback canonical linkage mismatch.');
    }
    const debrief = debriefs.find((entry) => entry.operationId === operation.id);
    const evidenceResourceUseCount = uses.filter((entry) => entry.operationId === operation.id).length;
    const terminalAt = operation.completedAt ?? operation.abortedAt;
    let status: IncidentResponseCoordinationReadbackStatus;
    if (operation.phase === 'completed' || operation.phase === 'aborted') status = operation.phase;
    else if (team.phase === 'stood-down') status = 'stood-down';
    else status = operation.phase;
    items.push({
      batchPosition: execution.batchPosition,
      originalRequestIndex: execution.originalRequestIndex,
      incidentId: execution.incidentId,
      requestedTeamSize: execution.requestedTeamSize,
      teamId: team.id,
      operationId: operation.id,
      resourceReservationId: reservation.id,
      memberIds: [...team.memberIds],
      retained: true,
      status,
      teamPhase: team.phase,
      operationPhase: operation.phase,
      resourcePhase: reservation.phase,
      assignedAt: team.assignedAt,
      ...(team.dispatchedAt !== undefined ? { dispatchedAt: team.dispatchedAt } : {}),
      ...(terminalAt !== undefined ? { terminalAt } : {}),
      reservedResources: structuredClone(reservation.reserved),
      consumedResources: structuredClone(reservation.consumed),
      returnedResources: structuredClone(reservation.returned),
      ...(debrief ? { debriefId: debrief.id } : {}),
      positiveEvidenceCount: debrief?.positiveEvidence.length ?? 0,
      evidenceResourceUseCount,
    });
  }

  const active = new Set<IncidentResponseCoordinationReadbackStatus>(['assigned', 'mobilizing', 'working', 'returning']);
  const terminal = new Set<IncidentResponseCoordinationReadbackStatus>(['completed', 'aborted', 'stood-down']);
  return {
    contextKey,
    receiptStartedAt: receipt.startedAt,
    readAt: stateAbsoluteMinute(state),
    selectedRequestIndices: [...receipt.selectedRequestIndices],
    items,
    retainedCount: items.filter((item) => item.retained).length,
    activeCount: items.filter((item) => active.has(item.status)).length,
    terminalCount: items.filter((item) => terminal.has(item.status)).length,
    missingCount: items.filter((item) => item.status === 'missing').length,
  };
}

/** I2-S pure explicit retry/replan helper for one operator-selected original request. */
export function deriveIncidentResponseCoordinationRetryPlan(
  state: SandboxGameState,
  requests: readonly IncidentResponseCoordinationRequest[],
  originalRequestIndex: number,
  expedition?: ExpeditionState | null,
): IncidentResponseCoordinationRetryPlan {
  if (!Number.isInteger(originalRequestIndex) || originalRequestIndex < 0 || originalRequestIndex >= requests.length) {
    throw new Error('Incident response coordination retry requires a valid original request index.');
  }
  const request = requests[originalRequestIndex]!;
  const plan = deriveIncidentResponseCoordinationPlan(state, [request], expedition);
  const item = plan.items[0]!;
  return {
    contextKey: plan.contextKey,
    generatedAt: plan.generatedAt,
    originalRequestIndex,
    incidentId: item.incidentId,
    requestedTeamSize: item.requestedTeamSize,
    disposition: item.disposition,
    plannedMemberIds: [...item.plannedMemberIds],
    blockers: [...item.blockers],
    requiredResources: structuredClone(item.requiredResources),
    availableResourcesBefore: structuredClone(item.availableResourcesBefore),
    shortfallResources: structuredClone(item.shortfallResources),
    ...(item.nextReviewAt !== undefined ? { nextReviewAt: item.nextReviewAt } : {}),
    canExecuteNow: item.disposition === 'staged-now',
  };
}

/**
 * I2-S explicit retry execution is still operator-driven. It re-plans one request first and then
 * delegates to I2-R's one-item atomic batch, which performs its own immediate canonical revalidation.
 */
export function executeIncidentResponseCoordinationRetry(
  state: SandboxGameState,
  requests: readonly IncidentResponseCoordinationRequest[],
  originalRequestIndex: number,
  expedition?: ExpeditionState | null,
): IncidentResponseCoordinationRetryExecution {
  const retryPlan = deriveIncidentResponseCoordinationRetryPlan(state, requests, originalRequestIndex, expedition);
  if (!retryPlan.canExecuteNow) {
    throw new Error(`Incident response coordination retry still requires review at original index ${originalRequestIndex}: ${retryPlan.blockers.join(', ') || 'not-staged'}.`);
  }
  return {
    retryPlan,
    batch: executeIncidentResponseCoordinationBatch(state, requests, [originalRequestIndex], expedition),
  };
}


function cloneCoordinationRequest(request: IncidentResponseCoordinationRequest): IncidentResponseCoordinationRequest {
  if (typeof request?.incidentId !== 'string' || request.incidentId.length < 1 || request.incidentId.length > 256) {
    throw new Error('External receipt registry request requires a bounded incidentId.');
  }
  if (!Number.isInteger(request.teamSize) || request.teamSize < 1 || request.teamSize > INCIDENT_DISPATCH_MAX_TEAM_SIZE) {
    throw new Error(`External receipt registry request teamSize must be 1-${INCIDENT_DISPATCH_MAX_TEAM_SIZE}.`);
  }
  return { incidentId: request.incidentId, teamSize: request.teamSize };
}

function validateExternalReceiptShape(receipt: IncidentResponseCoordinationBatchExecution, requests: readonly IncidentResponseCoordinationRequest[]): IncidentResponseCoordinationBatchExecution {
  if (!receipt || typeof receipt !== 'object') throw new Error('External receipt registry requires a coordination batch receipt.');
  if (receipt.contextKey !== 'settlement' && !/^expedition:[^\s]{1,256}$/.test(receipt.contextKey)) {
    throw new Error('External receipt registry receipt has an invalid contextKey.');
  }
  if (!Number.isFinite(receipt.startedAt) || receipt.startedAt < 0) throw new Error('External receipt registry receipt has an invalid startedAt.');
  if (!Array.isArray(receipt.selectedRequestIndices) || receipt.selectedRequestIndices.length < 1 || receipt.selectedRequestIndices.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) {
    throw new Error('External receipt registry receipt has invalid selected request indices.');
  }
  if (!Array.isArray(receipt.executions) || receipt.executions.length !== receipt.selectedRequestIndices.length) {
    throw new Error('External receipt registry receipt execution count is inconsistent.');
  }
  const selected = new Set<number>();
  receipt.selectedRequestIndices.forEach((value) => {
    if (!Number.isInteger(value) || value < 0 || value >= requests.length || selected.has(value)) {
      throw new Error('External receipt registry receipt contains invalid selected request indices.');
    }
    selected.add(value);
  });
  if (!Array.isArray(receipt.remainingRequestIndices) || receipt.remainingRequestIndices.some((value) => !Number.isInteger(value) || value < 0 || value >= requests.length || selected.has(value))) {
    throw new Error('External receipt registry receipt contains invalid remaining request indices.');
  }
  const expectedRemaining = requests.map((_, index) => index).filter((index) => !selected.has(index));
  if (expectedRemaining.length !== receipt.remainingRequestIndices.length || expectedRemaining.some((value, index) => value !== receipt.remainingRequestIndices[index])) {
    throw new Error('External receipt registry receipt remaining request indices are inconsistent.');
  }
  const executions = receipt.executions.map((execution, position) => {
    const originalIndex = receipt.selectedRequestIndices[position]!;
    const request = requests[originalIndex]!;
    if (execution.batchPosition !== position || execution.originalRequestIndex !== originalIndex || execution.requestIndex !== 0
      || execution.contextKey !== receipt.contextKey || execution.incidentId !== request.incidentId || execution.requestedTeamSize !== request.teamSize) {
      throw new Error('External receipt registry receipt execution linkage is inconsistent.');
    }
    if (!execution.team || execution.team.id.length < 1 || execution.operationId.length < 1 || execution.resourceReservationId.length < 1) {
      throw new Error('External receipt registry receipt execution identifiers are invalid.');
    }
    return structuredClone(execution);
  });
  const postExecutionReplan = Array.isArray(receipt.postExecutionReplan) ? receipt.postExecutionReplan.map((item) => {
    if (!Number.isInteger(item.originalRequestIndex) || !expectedRemaining.includes(item.originalRequestIndex)) {
      throw new Error('External receipt registry receipt replan index is inconsistent.');
    }
    return structuredClone(item);
  }) : (() => { throw new Error('External receipt registry receipt requires postExecutionReplan.'); })();
  return {
    contextKey: receipt.contextKey,
    startedAt: receipt.startedAt,
    selectedRequestIndices: [...receipt.selectedRequestIndices],
    executions,
    remainingRequestIndices: [...receipt.remainingRequestIndices],
    postExecutionReplan,
  };
}

export function createIncidentResponseExternalReceiptRegistry(): IncidentResponseExternalReceiptRegistryV1 {
  return {
    schemaVersion: 1,
    nextOrdinal: 1,
    maxEntries: INCIDENT_RESPONSE_EXTERNAL_RECEIPT_REGISTRY_MAX_ENTRIES,
    entries: [],
  };
}

export function registerIncidentResponseCoordinationReceipt(
  registry: IncidentResponseExternalReceiptRegistryV1,
  requests: readonly IncidentResponseCoordinationRequest[],
  receipt: IncidentResponseCoordinationBatchExecution,
): IncidentResponseExternalReceiptRegistryEntry {
  if (registry.schemaVersion !== 1 || registry.maxEntries !== INCIDENT_RESPONSE_EXTERNAL_RECEIPT_REGISTRY_MAX_ENTRIES || !Number.isInteger(registry.nextOrdinal) || registry.nextOrdinal < 1 || !Array.isArray(registry.entries)) {
    throw new Error('External receipt registry structure is invalid.');
  }
  if (requests.length < 1 || requests.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) {
    throw new Error(`External receipt registry requires 1-${INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS} requests.`);
  }
  const normalizedRequests = requests.map(cloneCoordinationRequest);
  const normalizedReceipt = validateExternalReceiptShape(receipt, normalizedRequests);
  const ordinal = registry.nextOrdinal;
  const entry: IncidentResponseExternalReceiptRegistryEntry = {
    id: `incident-response-external-receipt:${ordinal}`,
    ordinal,
    registeredAt: normalizedReceipt.startedAt,
    contextKey: normalizedReceipt.contextKey,
    requests: normalizedRequests,
    receipt: normalizedReceipt,
    pendingRequestIndices: [...normalizedReceipt.remainingRequestIndices],
    retryReceipts: [],
  };
  registry.nextOrdinal += 1;
  registry.entries.push(entry);
  if (registry.entries.length > registry.maxEntries) registry.entries.splice(0, registry.entries.length - registry.maxEntries);
  return structuredClone(entry);
}

const I2T_FORBIDDEN_EXTERNAL_REGISTRY_KEYS = new Set(['success', 'failure', 'outcome', 'resolved', 'causeConfirmed', 'hiddenCause', 'title', 'summary', 'detail', 'presentation', 'visibleStakeText']);

function assertNoForbiddenExternalRegistryKeys(value: unknown, path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenExternalRegistryKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (I2T_FORBIDDEN_EXTERNAL_REGISTRY_KEYS.has(key)) throw new Error(`External receipt registry contains forbidden field ${path}.${key}.`);
    assertNoForbiddenExternalRegistryKeys(entry, `${path}.${key}`);
  }
}


export function recordIncidentResponseExternalRetryExecution(
  registry: IncidentResponseExternalReceiptRegistryV1,
  registryEntryId: string,
  originalRequestIndex: number,
  retryReceipt: IncidentResponseCoordinationBatchExecution,
): IncidentResponseExternalReceiptRegistryEntry {
  const normalized = importIncidentResponseExternalReceiptRegistry(JSON.stringify(registry));
  const sourceEntry = normalized.entries.find((entry) => entry.id === registryEntryId);
  if (!sourceEntry) throw new Error('External receipt registry retry recording requires a retained registry entry.');
  if (!sourceEntry.pendingRequestIndices.includes(originalRequestIndex)) throw new Error('External receipt registry retry request is not pending.');
  const receipt = validateExternalReceiptShape(retryReceipt, sourceEntry.requests);
  if (receipt.contextKey !== sourceEntry.contextKey || receipt.selectedRequestIndices.length !== 1 || receipt.selectedRequestIndices[0] !== originalRequestIndex) {
    throw new Error('External receipt registry retry execution receipt does not match the pending request.');
  }
  const target = registry.entries.find((entry) => entry.id === registryEntryId);
  if (!target) throw new Error('External receipt registry retry recording target disappeared.');
  target.pendingRequestIndices = target.pendingRequestIndices.filter((value) => value !== originalRequestIndex);
  target.retryReceipts.push({ originalRequestIndex, receipt });
  target.retryReceipts.sort((a, b) => a.originalRequestIndex - b.originalRequestIndex);
  return structuredClone(target);
}

export function exportIncidentResponseExternalReceiptRegistry(registry: IncidentResponseExternalReceiptRegistryV1): string {
  const normalized = importIncidentResponseExternalReceiptRegistry(JSON.stringify(registry));
  return JSON.stringify(normalized, null, 2);
}

export function importIncidentResponseExternalReceiptRegistry(serialized: string): IncidentResponseExternalReceiptRegistryV1 {
  let raw: unknown;
  try { raw = JSON.parse(serialized); } catch { throw new Error('External receipt registry JSON is invalid.'); }
  assertNoForbiddenExternalRegistryKeys(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('External receipt registry root is invalid.');
  const source = raw as Record<string, unknown>;
  if (source.schemaVersion !== 1 || source.maxEntries !== INCIDENT_RESPONSE_EXTERNAL_RECEIPT_REGISTRY_MAX_ENTRIES
    || !Number.isInteger(source.nextOrdinal) || (source.nextOrdinal as number) < 1 || !Array.isArray(source.entries)
    || source.entries.length > INCIDENT_RESPONSE_EXTERNAL_RECEIPT_REGISTRY_MAX_ENTRIES) {
    throw new Error('External receipt registry structure is invalid.');
  }
  const seenIds = new Set<string>();
  const seenOrdinals = new Set<number>();
  const entries = source.entries.map((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) throw new Error('External receipt registry entry is invalid.');
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !/^incident-response-external-receipt:\d+$/.test(entry.id)
      || !Number.isInteger(entry.ordinal) || (entry.ordinal as number) < 1 || seenIds.has(entry.id) || seenOrdinals.has(entry.ordinal as number)
      || !Number.isFinite(entry.registeredAt) || (entry.registeredAt as number) < 0 || !Array.isArray(entry.requests)
      || !Array.isArray(entry.pendingRequestIndices) || !Array.isArray(entry.retryReceipts)) {
      throw new Error('External receipt registry entry metadata is invalid.');
    }
    const ordinal = entry.ordinal as number;
    if (entry.id !== `incident-response-external-receipt:${ordinal}`) throw new Error('External receipt registry entry id/ordinal mismatch.');
    seenIds.add(entry.id);
    seenOrdinals.add(ordinal);
    const requests = (entry.requests as IncidentResponseCoordinationRequest[]).map(cloneCoordinationRequest);
    const receipt = validateExternalReceiptShape(entry.receipt as IncidentResponseCoordinationBatchExecution, requests);
    if (entry.contextKey !== receipt.contextKey || entry.registeredAt !== receipt.startedAt) throw new Error('External receipt registry entry/receipt metadata mismatch.');
    const initialPending = new Set(receipt.remainingRequestIndices);
    const pendingRequestIndices = (entry.pendingRequestIndices as number[]).map((value) => {
      if (!Number.isInteger(value) || !initialPending.has(value)) throw new Error('External receipt registry pending request index is invalid.');
      return value;
    });
    if (new Set(pendingRequestIndices).size !== pendingRequestIndices.length) throw new Error('External receipt registry pending request indices contain duplicates.');
    const retryReceipts = (entry.retryReceipts as Array<Record<string, unknown>>).map((retry) => {
      if (!retry || typeof retry !== 'object' || !Number.isInteger(retry.originalRequestIndex) || !initialPending.has(retry.originalRequestIndex as number)) {
        throw new Error('External receipt registry retry receipt index is invalid.');
      }
      const originalRequestIndex = retry.originalRequestIndex as number;
      const retryReceipt = validateExternalReceiptShape(retry.receipt as IncidentResponseCoordinationBatchExecution, requests);
      if (retryReceipt.contextKey !== receipt.contextKey || retryReceipt.selectedRequestIndices.length !== 1 || retryReceipt.selectedRequestIndices[0] !== originalRequestIndex) {
        throw new Error('External receipt registry retry receipt linkage is invalid.');
      }
      return { originalRequestIndex, receipt: retryReceipt } satisfies IncidentResponseExternalRetryReceipt;
    });
    const retried = retryReceipts.map((retry) => retry.originalRequestIndex);
    if (new Set(retried).size !== retried.length || retried.some((value) => pendingRequestIndices.includes(value))) {
      throw new Error('External receipt registry retry/pending state is inconsistent.');
    }
    const accounted = new Set([...pendingRequestIndices, ...retried]);
    if (receipt.remainingRequestIndices.some((value) => !accounted.has(value)) || accounted.size !== receipt.remainingRequestIndices.length) {
      throw new Error('External receipt registry retry/pending coverage is inconsistent.');
    }
    return {
      id: entry.id,
      ordinal,
      registeredAt: entry.registeredAt as number,
      contextKey: receipt.contextKey,
      requests,
      receipt,
      pendingRequestIndices: [...pendingRequestIndices].sort((a, b) => a - b),
      retryReceipts: retryReceipts.sort((a, b) => a.originalRequestIndex - b.originalRequestIndex),
    } satisfies IncidentResponseExternalReceiptRegistryEntry;
  }).sort((a, b) => a.ordinal - b.ordinal);
  if (entries.some((entry, index) => index > 0 && entry.ordinal <= entries[index - 1]!.ordinal)) throw new Error('External receipt registry entry ordering is invalid.');
  const maxOrdinal = entries.at(-1)?.ordinal ?? 0;
  if ((source.nextOrdinal as number) <= maxOrdinal) throw new Error('External receipt registry nextOrdinal is invalid.');
  return {
    schemaVersion: 1,
    nextOrdinal: source.nextOrdinal as number,
    maxEntries: INCIDENT_RESPONSE_EXTERNAL_RECEIPT_REGISTRY_MAX_ENTRIES,
    entries,
  };
}

export function deriveIncidentResponseExternalRetryQueueGuidance(
  state: SandboxGameState,
  registry: IncidentResponseExternalReceiptRegistryV1,
  expedition?: ExpeditionState | null,
): IncidentResponseExternalRetryQueueGuidance {
  const normalized = importIncidentResponseExternalReceiptRegistry(JSON.stringify(registry));
  const contextKey = incidentContextKey(expedition);
  const matching = normalized.entries.filter((entry) => entry.contextKey === contextKey);
  let readbackRetainedCount = 0;
  let readbackActiveCount = 0;
  let readbackTerminalCount = 0;
  let readbackMissingCount = 0;
  const items: IncidentResponseExternalRetryQueueItem[] = [];
  for (const entry of matching) {
    const receipts = [entry.receipt, ...entry.retryReceipts.map((retry) => retry.receipt)];
    for (const receipt of receipts) {
      const readback = deriveIncidentResponseCoordinationReadback(state, receipt, expedition);
      readbackRetainedCount += readback.retainedCount;
      readbackActiveCount += readback.activeCount;
      readbackTerminalCount += readback.terminalCount;
      readbackMissingCount += readback.missingCount;
    }
    for (const originalRequestIndex of entry.pendingRequestIndices) {
      const plan = deriveIncidentResponseCoordinationRetryPlan(state, entry.requests, originalRequestIndex, expedition);
      items.push({
        registryEntryId: entry.id,
        registryOrdinal: entry.ordinal,
        originalRequestIndex,
        incidentId: plan.incidentId,
        requestedTeamSize: plan.requestedTeamSize,
        disposition: plan.canExecuteNow ? 'ready-now' : 'review',
        blockers: [...plan.blockers],
        plannedMemberIds: [...plan.plannedMemberIds],
        ...(plan.nextReviewAt !== undefined ? { nextReviewAt: plan.nextReviewAt } : {}),
      });
    }
  }
  items.sort((a, b) => {
    if (a.disposition !== b.disposition) return a.disposition === 'ready-now' ? -1 : 1;
    const aReview = a.nextReviewAt ?? Number.POSITIVE_INFINITY;
    const bReview = b.nextReviewAt ?? Number.POSITIVE_INFINITY;
    return aReview - bReview || a.registryOrdinal - b.registryOrdinal || a.originalRequestIndex - b.originalRequestIndex;
  });
  const reviewTimes = items.map((item) => item.nextReviewAt).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  return {
    contextKey,
    generatedAt: stateAbsoluteMinute(state),
    registryEntryCount: matching.length,
    readbackRetainedCount,
    readbackActiveCount,
    readbackTerminalCount,
    readbackMissingCount,
    items,
    readyNowCount: items.filter((item) => item.disposition === 'ready-now').length,
    reviewCount: items.filter((item) => item.disposition === 'review').length,
    ...(reviewTimes.length ? { nextReviewAt: reviewTimes[0] } : {}),
  };
}

/**
 * I2-U explicitly executes one current external retry-queue item and atomically records the
 * resulting single-request retry receipt in the external registry. The queue/registry remains
 * operator metadata outside SandboxGameState; all canonical mutation still flows through I2-S/I2-R
 * into the existing I2-C/I2-E seams. Both sandbox state and external registry are restored if the
 * item is not currently ready or if receipt recording fails after canonical execution.
 */
export function executeIncidentResponseExternalRetryQueueItem(
  state: SandboxGameState,
  registry: IncidentResponseExternalReceiptRegistryV1,
  registryEntryId: string,
  originalRequestIndex: number,
  expedition?: ExpeditionState | null,
): IncidentResponseExternalRetryQueueExecution {
  const stateSnapshot = structuredClone(state);
  const registrySnapshot = structuredClone(registry);
  try {
    const normalized = importIncidentResponseExternalReceiptRegistry(JSON.stringify(registry));
    const sourceEntry = normalized.entries.find((entry) => entry.id === registryEntryId);
    if (!sourceEntry) throw new Error('External retry queue execution requires a retained registry entry.');
    if (!Number.isInteger(originalRequestIndex) || !sourceEntry.pendingRequestIndices.includes(originalRequestIndex)) {
      throw new Error('External retry queue execution requires a currently pending request index.');
    }
    const guidanceBefore = deriveIncidentResponseExternalRetryQueueGuidance(state, normalized, expedition);
    const selectedItem = guidanceBefore.items.find((item) => item.registryEntryId === registryEntryId && item.originalRequestIndex === originalRequestIndex);
    if (!selectedItem) throw new Error('External retry queue execution item is unavailable in the current canonical context.');
    if (selectedItem.disposition !== 'ready-now') {
      throw new Error(`External retry queue execution requires review: ${selectedItem.blockers.join(', ') || 'not-ready'}.`);
    }
    const retry = executeIncidentResponseCoordinationRetry(state, sourceEntry.requests, originalRequestIndex, expedition);
    const registryEntry = recordIncidentResponseExternalRetryExecution(registry, registryEntryId, originalRequestIndex, retry.batch);
    const guidanceAfter = deriveIncidentResponseExternalRetryQueueGuidance(state, registry, expedition);
    if (guidanceAfter.items.some((item) => item.registryEntryId === registryEntryId && item.originalRequestIndex === originalRequestIndex)) {
      throw new Error('External retry queue execution did not clear the executed pending request.');
    }
    return {
      guidanceBefore,
      selectedItem: structuredClone(selectedItem),
      retry,
      registryEntry,
      guidanceAfter,
    };
  } catch (error) {
    const mutableState = state as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutableState)) delete mutableState[key];
    Object.assign(mutableState, stateSnapshot as unknown as Record<string, unknown>);
    const mutableRegistry = registry as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutableRegistry)) delete mutableRegistry[key];
    Object.assign(mutableRegistry, registrySnapshot as unknown as Record<string, unknown>);
    throw error;
  }
}


/**
 * I2-V executes an explicit operator-selected batch of current external retry-queue items.
 * Every selected item must be ready at batch start and is revalidated again immediately before
 * its own I2-U execution. The entire sandbox + external registry transaction is all-or-nothing:
 * if any later item requires review or any downstream/external receipt step fails, all earlier
 * batch effects are restored to the exact pre-call snapshots. No scheduler or SandboxGameState
 * queue/batch authority is introduced.
 */
export function executeIncidentResponseExternalRetryQueueBatch(
  state: SandboxGameState,
  registry: IncidentResponseExternalReceiptRegistryV1,
  selections: readonly IncidentResponseExternalRetryQueueSelection[],
  expedition?: ExpeditionState | null,
): IncidentResponseExternalRetryQueueBatchExecution {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) {
    throw new Error(`External retry queue batch execution requires 1-${INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS} selections.`);
  }
  const normalizedSelections = selections.map((selection) => {
    if (!selection || typeof selection !== 'object' || typeof selection.registryEntryId !== 'string'
      || !/^incident-response-external-receipt:\d+$/.test(selection.registryEntryId)
      || !Number.isInteger(selection.originalRequestIndex) || selection.originalRequestIndex < 0) {
      throw new Error('External retry queue batch execution selection is invalid.');
    }
    return { registryEntryId: selection.registryEntryId, originalRequestIndex: selection.originalRequestIndex } satisfies IncidentResponseExternalRetryQueueSelection;
  });
  const identities = normalizedSelections.map((selection) => `${selection.registryEntryId}#${selection.originalRequestIndex}`);
  if (new Set(identities).size !== identities.length) throw new Error('External retry queue batch execution selections contain duplicates.');

  const stateSnapshot = structuredClone(state);
  const registrySnapshot = structuredClone(registry);
  try {
    const normalizedRegistry = importIncidentResponseExternalReceiptRegistry(JSON.stringify(registry));
    const guidanceBefore = deriveIncidentResponseExternalRetryQueueGuidance(state, normalizedRegistry, expedition);
    for (const selection of normalizedSelections) {
      const item = guidanceBefore.items.find((candidate) => candidate.registryEntryId === selection.registryEntryId
        && candidate.originalRequestIndex === selection.originalRequestIndex);
      if (!item) throw new Error('External retry queue batch execution selection is unavailable in the current canonical context.');
      if (item.disposition !== 'ready-now') {
        throw new Error(`External retry queue batch execution requires review before commit: ${item.blockers.join(', ') || 'not-ready'}.`);
      }
    }

    const executions: IncidentResponseExternalRetryQueueExecution[] = [];
    for (const selection of normalizedSelections) {
      const current = deriveIncidentResponseExternalRetryQueueGuidance(state, registry, expedition);
      const item = current.items.find((candidate) => candidate.registryEntryId === selection.registryEntryId
        && candidate.originalRequestIndex === selection.originalRequestIndex);
      if (!item) throw new Error('External retry queue batch execution selection disappeared before commit.');
      if (item.disposition !== 'ready-now') {
        throw new Error(`External retry queue batch execution requires review during commit: ${item.blockers.join(', ') || 'not-ready'}.`);
      }
      executions.push(executeIncidentResponseExternalRetryQueueItem(
        state,
        registry,
        selection.registryEntryId,
        selection.originalRequestIndex,
        expedition,
      ));
    }
    const guidanceAfter = deriveIncidentResponseExternalRetryQueueGuidance(state, registry, expedition);
    return {
      contextKey: guidanceBefore.contextKey,
      startedAt: guidanceBefore.generatedAt,
      selections: normalizedSelections.map((selection) => ({ ...selection })),
      guidanceBefore,
      executions,
      guidanceAfter,
    };
  } catch (error) {
    const mutableState = state as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutableState)) delete mutableState[key];
    Object.assign(mutableState, stateSnapshot as unknown as Record<string, unknown>);
    const mutableRegistry = registry as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutableRegistry)) delete mutableRegistry[key];
    Object.assign(mutableRegistry, registrySnapshot as unknown as Record<string, unknown>);
    throw error;
  }
}

/**
 * I2-W fact-only readback across an explicit external queue selection set. External registry
 * metadata is not treated as canonical truth: every recorded retry receipt is projected through
 * I2-S onto currently retained I2-C/I2-D/I2-E/I2-H/I2-G facts. Pending selections are reported as
 * pending external operator metadata only. No success/failure/causal narrative is inferred.
 */
export function deriveIncidentResponseExternalBatchReadback(
  state: SandboxGameState,
  registry: IncidentResponseExternalReceiptRegistryV1,
  selections: readonly IncidentResponseExternalRetryQueueSelection[],
  expedition?: ExpeditionState | null,
): IncidentResponseExternalBatchReadback {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) {
    throw new Error(`External batch readback requires 1-${INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS} selections.`);
  }
  const normalizedRegistry = importIncidentResponseExternalReceiptRegistry(JSON.stringify(registry));
  const normalizedSelections = selections.map((selection) => {
    if (!selection || typeof selection !== 'object' || typeof selection.registryEntryId !== 'string'
      || !/^incident-response-external-receipt:\d+$/.test(selection.registryEntryId)
      || !Number.isInteger(selection.originalRequestIndex) || selection.originalRequestIndex < 0) {
      throw new Error('External batch readback selection is invalid.');
    }
    return { registryEntryId: selection.registryEntryId, originalRequestIndex: selection.originalRequestIndex } satisfies IncidentResponseExternalRetryQueueSelection;
  });
  const identities = normalizedSelections.map((selection) => `${selection.registryEntryId}#${selection.originalRequestIndex}`);
  if (new Set(identities).size !== identities.length) throw new Error('External batch readback selections contain duplicates.');

  const contextKey = incidentContextKey(expedition);
  const items: IncidentResponseExternalBatchReadbackItem[] = [];
  for (const selection of normalizedSelections) {
    const entry = normalizedRegistry.entries.find((candidate) => candidate.id === selection.registryEntryId);
    if (!entry) throw new Error('External batch readback requires a retained registry entry.');
    if (entry.contextKey !== contextKey) throw new Error('External batch readback registry context does not match the requested canonical context.');
    const request = entry.requests[selection.originalRequestIndex];
    if (!request) throw new Error('External batch readback request index is outside the retained registry request set.');
    const retryReceipt = entry.retryReceipts.find((candidate) => candidate.originalRequestIndex === selection.originalRequestIndex);
    if (!retryReceipt) {
      if (!entry.pendingRequestIndices.includes(selection.originalRequestIndex)) {
        throw new Error('External batch readback selection is neither pending nor backed by a recorded retry receipt.');
      }
      items.push({
        registryEntryId: entry.id,
        registryOrdinal: entry.ordinal,
        originalRequestIndex: selection.originalRequestIndex,
        incidentId: request.incidentId,
        requestedTeamSize: request.teamSize,
        receiptRecorded: false,
        retained: false,
        status: 'pending',
        memberIds: [],
        positiveEvidenceCount: 0,
        evidenceResourceUseCount: 0,
      });
      continue;
    }
    const readback = deriveIncidentResponseCoordinationReadback(state, retryReceipt.receipt, expedition);
    if (readback.items.length !== 1 || readback.selectedRequestIndices.length !== 1
      || readback.selectedRequestIndices[0] !== selection.originalRequestIndex) {
      throw new Error('External batch readback retry receipt projection is inconsistent.');
    }
    const item = readback.items[0]!;
    items.push({
      registryEntryId: entry.id,
      registryOrdinal: entry.ordinal,
      originalRequestIndex: selection.originalRequestIndex,
      incidentId: item.incidentId,
      requestedTeamSize: item.requestedTeamSize,
      receiptRecorded: true,
      retained: item.retained,
      status: item.status,
      ...(item.teamId ? { teamId: item.teamId } : {}),
      ...(item.operationId ? { operationId: item.operationId } : {}),
      ...(item.resourceReservationId ? { resourceReservationId: item.resourceReservationId } : {}),
      memberIds: [...item.memberIds],
      ...(item.reservedResources ? { reservedResources: structuredClone(item.reservedResources) } : {}),
      ...(item.consumedResources ? { consumedResources: structuredClone(item.consumedResources) } : {}),
      ...(item.returnedResources ? { returnedResources: structuredClone(item.returnedResources) } : {}),
      ...(item.debriefId ? { debriefId: item.debriefId } : {}),
      positiveEvidenceCount: item.positiveEvidenceCount,
      evidenceResourceUseCount: item.evidenceResourceUseCount,
    });
  }

  const zero = (): IncidentResponseResourceAmounts => ({ food: 0, water: 0, medicine: 0, tools: 0 });
  let reservedResources = zero();
  let consumedResources = zero();
  let returnedResources = zero();
  for (const item of items) {
    if (item.reservedResources) reservedResources = addResponseResourceAmounts(reservedResources, item.reservedResources);
    if (item.consumedResources) consumedResources = addResponseResourceAmounts(consumedResources, item.consumedResources);
    if (item.returnedResources) returnedResources = addResponseResourceAmounts(returnedResources, item.returnedResources);
  }
  const active = new Set<IncidentResponseExternalBatchReadbackStatus>(['assigned', 'mobilizing', 'working', 'returning']);
  const terminal = new Set<IncidentResponseExternalBatchReadbackStatus>(['completed', 'aborted', 'stood-down']);
  return {
    contextKey,
    readAt: stateAbsoluteMinute(state),
    selections: normalizedSelections.map((selection) => ({ ...selection })),
    items,
    recordedCount: items.filter((item) => item.receiptRecorded).length,
    pendingCount: items.filter((item) => item.status === 'pending').length,
    retainedCount: items.filter((item) => item.retained).length,
    activeCount: items.filter((item) => active.has(item.status)).length,
    terminalCount: items.filter((item) => terminal.has(item.status)).length,
    missingCount: items.filter((item) => item.status === 'missing').length,
    reservedResources,
    consumedResources,
    returnedResources,
  };
}

/** I2-W pure explicit replan for a selected external pending batch. */
export function deriveIncidentResponseExternalBatchRetryPlan(
  state: SandboxGameState,
  registry: IncidentResponseExternalReceiptRegistryV1,
  selections: readonly IncidentResponseExternalRetryQueueSelection[],
  expedition?: ExpeditionState | null,
): IncidentResponseExternalBatchRetryPlan {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) {
    throw new Error(`External batch retry plan requires 1-${INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS} selections.`);
  }
  const normalizedRegistry = importIncidentResponseExternalReceiptRegistry(JSON.stringify(registry));
  const normalizedSelections = selections.map((selection) => {
    if (!selection || typeof selection !== 'object' || typeof selection.registryEntryId !== 'string'
      || !/^incident-response-external-receipt:\d+$/.test(selection.registryEntryId)
      || !Number.isInteger(selection.originalRequestIndex) || selection.originalRequestIndex < 0) {
      throw new Error('External batch retry plan selection is invalid.');
    }
    return { registryEntryId: selection.registryEntryId, originalRequestIndex: selection.originalRequestIndex } satisfies IncidentResponseExternalRetryQueueSelection;
  });
  const identities = normalizedSelections.map((selection) => `${selection.registryEntryId}#${selection.originalRequestIndex}`);
  if (new Set(identities).size !== identities.length) throw new Error('External batch retry plan selections contain duplicates.');
  for (const selection of normalizedSelections) {
    const entry = normalizedRegistry.entries.find((candidate) => candidate.id === selection.registryEntryId);
    if (!entry) throw new Error('External batch retry plan requires a retained registry entry.');
    if (!entry.pendingRequestIndices.includes(selection.originalRequestIndex)) {
      throw new Error('External batch retry plan requires currently pending request selections.');
    }
  }
  const guidance = deriveIncidentResponseExternalRetryQueueGuidance(state, normalizedRegistry, expedition);
  const items = normalizedSelections.map((selection) => {
    const item = guidance.items.find((candidate) => candidate.registryEntryId === selection.registryEntryId
      && candidate.originalRequestIndex === selection.originalRequestIndex);
    if (!item) throw new Error('External batch retry plan selection is unavailable in the current canonical context.');
    return structuredClone(item) as IncidentResponseExternalBatchRetryPlanItem;
  });
  const reviewTimes = items.map((item) => item.nextReviewAt).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const readyNowCount = items.filter((item) => item.disposition === 'ready-now').length;
  const reviewCount = items.length - readyNowCount;
  return {
    contextKey: guidance.contextKey,
    generatedAt: guidance.generatedAt,
    selections: normalizedSelections.map((selection) => ({ ...selection })),
    items,
    readyNowCount,
    reviewCount,
    canExecuteAtomicBatch: reviewCount === 0,
    ...(reviewTimes.length ? { nextReviewAt: reviewTimes[0] } : {}),
  };
}

/**
 * I2-W explicit operator batch retry. The pure plan must currently be all ready-now, then I2-V
 * performs the authoritative per-item immediate revalidation and joint sandbox+registry rollback.
 */
export function executeIncidentResponseExternalBatchRetry(
  state: SandboxGameState,
  registry: IncidentResponseExternalReceiptRegistryV1,
  selections: readonly IncidentResponseExternalRetryQueueSelection[],
  expedition?: ExpeditionState | null,
): IncidentResponseExternalBatchRetryExecution {
  const retryPlan = deriveIncidentResponseExternalBatchRetryPlan(state, registry, selections, expedition);
  if (!retryPlan.canExecuteAtomicBatch) {
    const blockers = retryPlan.items.filter((item) => item.disposition === 'review')
      .flatMap((item) => item.blockers.map((blocker) => `${item.registryEntryId}#${item.originalRequestIndex}:${blocker}`));
    throw new Error(`External batch retry still requires review: ${blockers.join(', ') || 'not-ready'}.`);
  }
  return {
    retryPlan,
    batch: executeIncidentResponseExternalRetryQueueBatch(state, registry, retryPlan.selections, expedition),
  };
}

const I2X_EXTERNAL_BATCH_READBACK_FILTERS = new Set<IncidentResponseExternalBatchReadbackFilter>(['all', 'recorded', 'pending', 'active', 'terminal', 'missing']);
const I2X_EXTERNAL_BATCH_ACTIVE_STATUSES = new Set<IncidentResponseExternalBatchReadbackStatus>(['assigned', 'mobilizing', 'working', 'returning']);
const I2X_EXTERNAL_BATCH_TERMINAL_STATUSES = new Set<IncidentResponseExternalBatchReadbackStatus>(['completed', 'aborted', 'stood-down']);

function incidentResponseExternalBatchReadbackFactTokens(item: IncidentResponseExternalBatchReadbackItem): string[] {
  const resourceTokens = (prefix: string, values?: IncidentResponseResourceAmounts): string[] => values ? [
    `${prefix}:food:${values.food}`,
    `${prefix}:water:${values.water}`,
    `${prefix}:medicine:${values.medicine}`,
    `${prefix}:tools:${values.tools}`,
  ] : [];
  return [
    item.registryEntryId,
    `registry-ordinal:${item.registryOrdinal}`,
    `request-index:${item.originalRequestIndex}`,
    item.incidentId,
    `team-size:${item.requestedTeamSize}`,
    item.receiptRecorded ? 'receipt:recorded' : 'receipt:pending',
    item.retained ? 'retained:true' : 'retained:false',
    `status:${item.status}`,
    item.teamId ?? '',
    item.operationId ?? '',
    item.resourceReservationId ?? '',
    ...item.memberIds,
    ...resourceTokens('reserved', item.reservedResources),
    ...resourceTokens('consumed', item.consumedResources),
    ...resourceTokens('returned', item.returnedResources),
    item.debriefId ?? '',
    `positive-evidence:${item.positiveEvidenceCount}`,
    `evidence-resource-use:${item.evidenceResourceUseCount}`,
  ].filter(Boolean).map((value) => value.toLowerCase());
}

function summarizeIncidentResponseExternalBatchReadbackItems(
  contextKey: IncidentContextKey,
  readAt: number,
  filter: IncidentResponseExternalBatchReadbackFilter,
  query: string,
  items: IncidentResponseExternalBatchReadbackItem[],
): IncidentResponseExternalBatchReadbackView {
  const zero = (): IncidentResponseResourceAmounts => ({ food: 0, water: 0, medicine: 0, tools: 0 });
  let reservedResources = zero();
  let consumedResources = zero();
  let returnedResources = zero();
  for (const item of items) {
    if (item.reservedResources) reservedResources = addResponseResourceAmounts(reservedResources, item.reservedResources);
    if (item.consumedResources) consumedResources = addResponseResourceAmounts(consumedResources, item.consumedResources);
    if (item.returnedResources) returnedResources = addResponseResourceAmounts(returnedResources, item.returnedResources);
  }
  return {
    contextKey,
    readAt,
    filter,
    query,
    selections: items.map((item) => ({ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex })),
    items: items.map((item) => structuredClone(item)),
    recordedCount: items.filter((item) => item.receiptRecorded).length,
    pendingCount: items.filter((item) => item.status === 'pending').length,
    retainedCount: items.filter((item) => item.retained).length,
    activeCount: items.filter((item) => I2X_EXTERNAL_BATCH_ACTIVE_STATUSES.has(item.status)).length,
    terminalCount: items.filter((item) => I2X_EXTERNAL_BATCH_TERMINAL_STATUSES.has(item.status)).length,
    missingCount: items.filter((item) => item.status === 'missing').length,
    reservedResources,
    consumedResources,
    returnedResources,
  };
}

/** I2-X structured fact-only filter/search over one I2-W external batch readback. */
export function filterIncidentResponseExternalBatchReadback(
  readback: IncidentResponseExternalBatchReadback,
  filter: IncidentResponseExternalBatchReadbackFilter = 'all',
  query = '',
): IncidentResponseExternalBatchReadbackView {
  if (!I2X_EXTERNAL_BATCH_READBACK_FILTERS.has(filter)) throw new Error('External batch readback filter is invalid.');
  if (typeof query !== 'string' || query.length > 80) throw new Error('External batch readback query must be at most 80 characters.');
  const normalizedQuery = query.trim().toLowerCase();
  const terms = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];
  if (terms.length > 8) throw new Error('External batch readback query supports at most 8 terms.');
  const matchesFilter = (item: IncidentResponseExternalBatchReadbackItem): boolean => {
    if (filter === 'all') return true;
    if (filter === 'recorded') return item.receiptRecorded;
    if (filter === 'pending') return item.status === 'pending';
    if (filter === 'active') return I2X_EXTERNAL_BATCH_ACTIVE_STATUSES.has(item.status);
    if (filter === 'terminal') return I2X_EXTERNAL_BATCH_TERMINAL_STATUSES.has(item.status);
    return item.status === 'missing';
  };
  const items = readback.items.filter((item) => {
    if (!matchesFilter(item)) return false;
    if (!terms.length) return true;
    const haystack = incidentResponseExternalBatchReadbackFactTokens(item).join('\n');
    return terms.every((term) => haystack.includes(term));
  });
  return summarizeIncidentResponseExternalBatchReadbackItems(readback.contextKey, readback.readAt, filter, normalizedQuery, items);
}

function normalizeIncidentResponseExternalBatchReadbackSnapshot(value: unknown): IncidentResponseExternalBatchReadbackSnapshotV1 {
  assertNoForbiddenExternalRegistryKeys(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('External batch readback snapshot root is invalid.');
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || source.authority !== 'external-observer-snapshot' || !Number.isFinite(source.exportedAt)) {
    throw new Error('External batch readback snapshot metadata is invalid.');
  }
  if (!source.view || typeof source.view !== 'object' || Array.isArray(source.view)) throw new Error('External batch readback snapshot view is invalid.');
  const rawView = source.view as Record<string, unknown>;
  if ((rawView.contextKey !== 'settlement' && !(typeof rawView.contextKey === 'string' && /^expedition:[^\s]{1,256}$/.test(rawView.contextKey)))
    || !Number.isFinite(rawView.readAt) || !I2X_EXTERNAL_BATCH_READBACK_FILTERS.has(rawView.filter as IncidentResponseExternalBatchReadbackFilter)
    || typeof rawView.query !== 'string' || rawView.query.length > 80 || !Array.isArray(rawView.items)) {
    throw new Error('External batch readback snapshot view metadata is invalid.');
  }
  if (rawView.items.length > INCIDENT_RESPONSE_COORDINATION_MAX_REQUESTS) throw new Error('External batch readback snapshot contains too many items.');
  const items = (rawView.items as unknown[]).map((rawItem) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new Error('External batch readback snapshot item is invalid.');
    const item = rawItem as Record<string, unknown>;
    if (typeof item.registryEntryId !== 'string' || !/^incident-response-external-receipt:\d+$/.test(item.registryEntryId)
      || !Number.isInteger(item.registryOrdinal) || (item.registryOrdinal as number) < 1
      || !Number.isInteger(item.originalRequestIndex) || (item.originalRequestIndex as number) < 0
      || typeof item.incidentId !== 'string' || !Number.isInteger(item.requestedTeamSize)
      || (item.requestedTeamSize as number) < 1 || (item.requestedTeamSize as number) > INCIDENT_DISPATCH_MAX_TEAM_SIZE
      || typeof item.receiptRecorded !== 'boolean' || typeof item.retained !== 'boolean'
      || !['assigned', 'mobilizing', 'working', 'returning', 'completed', 'aborted', 'stood-down', 'missing', 'pending'].includes(String(item.status))
      || !Array.isArray(item.memberIds) || !item.memberIds.every((memberId) => typeof memberId === 'string')
      || !Number.isInteger(item.positiveEvidenceCount) || (item.positiveEvidenceCount as number) < 0
      || !Number.isInteger(item.evidenceResourceUseCount) || (item.evidenceResourceUseCount as number) < 0) {
      throw new Error('External batch readback snapshot item metadata is invalid.');
    }
    return structuredClone(item) as unknown as IncidentResponseExternalBatchReadbackItem;
  });
  const normalized = summarizeIncidentResponseExternalBatchReadbackItems(
    rawView.contextKey as IncidentContextKey,
    rawView.readAt as number,
    rawView.filter as IncidentResponseExternalBatchReadbackFilter,
    (rawView.query as string).trim().toLowerCase(),
    items,
  );
  return { schemaVersion: 1, authority: 'external-observer-snapshot', exportedAt: source.exportedAt as number, view: normalized };
}

/** I2-X portable observer snapshot export. This artifact is explicitly non-authoritative. */
export function exportIncidentResponseExternalBatchReadbackSnapshot(view: IncidentResponseExternalBatchReadbackView): string {
  const snapshot: IncidentResponseExternalBatchReadbackSnapshotV1 = {
    schemaVersion: 1,
    authority: 'external-observer-snapshot',
    exportedAt: view.readAt,
    view: structuredClone(view),
  };
  return JSON.stringify(normalizeIncidentResponseExternalBatchReadbackSnapshot(snapshot), null, 2);
}

export function importIncidentResponseExternalBatchReadbackSnapshot(serialized: string): IncidentResponseExternalBatchReadbackSnapshotV1 {
  let raw: unknown;
  try { raw = JSON.parse(serialized); } catch { throw new Error('External batch readback snapshot JSON is invalid.'); }
  return normalizeIncidentResponseExternalBatchReadbackSnapshot(raw);
}

/** I2-X pure review-batch replan. It partitions explicitly selected pending items by current facts. */
export function deriveIncidentResponseExternalReviewBatchReplan(
  state: SandboxGameState,
  registry: IncidentResponseExternalReceiptRegistryV1,
  selections: readonly IncidentResponseExternalRetryQueueSelection[],
  expedition?: ExpeditionState | null,
): IncidentResponseExternalReviewBatchReplan {
  const plan = deriveIncidentResponseExternalBatchRetryPlan(state, registry, selections, expedition);
  const readySelections: IncidentResponseExternalRetryQueueSelection[] = [];
  const reviewSelections: IncidentResponseExternalRetryQueueSelection[] = [];
  plan.items.forEach((item, index) => {
    const selection = plan.selections[index]!;
    (item.disposition === 'ready-now' ? readySelections : reviewSelections).push({ ...selection });
  });
  return {
    contextKey: plan.contextKey,
    generatedAt: plan.generatedAt,
    selections: plan.selections.map((selection) => ({ ...selection })),
    items: plan.items.map((item) => structuredClone(item)),
    readySelections,
    reviewSelections,
    readyNowCount: readySelections.length,
    reviewCount: reviewSelections.length,
    canExecuteReadySubset: readySelections.length > 0,
    ...(plan.nextReviewAt !== undefined ? { nextReviewAt: plan.nextReviewAt } : {}),
  };
}

export function assignIncidentResponseRosterTeam(
  state: SandboxGameState,
  incidentId: string,
  teamSize = 1,
  expedition?: ExpeditionState | null,
): IncidentDispatchTeam {
  const requestedSize = Math.floor(teamSize);
  if (requestedSize < 1 || requestedSize > INCIDENT_DISPATCH_MAX_TEAM_SIZE) throw new Error(`Incident response roster team size must be 1-${INCIDENT_DISPATCH_MAX_TEAM_SIZE}.`);
  const capacity = deriveIncidentDispatchCapacity(state, incidentId, expedition);
  if (!capacity.canAssign) throw new Error('Incident response roster has no currently assignable capacity.');
  const roster = deriveIncidentResponseRosterPlan(state, expedition);
  const candidates = [...roster.primaryMemberIds, ...roster.reserveMemberIds, ...roster.overflowMemberIds].filter((id) => capacity.availableMemberIds.includes(id));
  if (candidates.length < requestedSize) throw new Error(`Incident response roster has fewer than ${requestedSize} available members.`);
  return assignIncidentResponseTeam(state, incidentId, candidates.slice(0, requestedSize), expedition);
}

export function deriveIncidentDispatchCapacity(
  state: SandboxGameState,
  incidentId: string,
  expedition?: ExpeditionState | null,
): IncidentDispatchCapacity {
  const dispatch = ensureIncidentDispatchState(state);
  const contextKey = incidentContextKey(expedition);
  const eligibleMemberIds = eligibleIncidentResponderIds(state, contextKey);
  synchronizeIncidentResponseReadiness(state);
  const recovering = new Set((state.incidentResponseReadiness?.entries ?? []).map((entry) => entry.memberId));
  const activeContextTeams = dispatch.teams.filter((team) => team.contextKey === contextKey && activeDispatchTeam(team));
  const activeIncidentTeams = activeContextTeams.filter((team) => team.incidentId === incidentId);
  const committedMemberIds = unique(activeContextTeams.flatMap((team) => team.memberIds)).sort();
  const committed = new Set(committedMemberIds);
  const recoveringMemberIds = eligibleMemberIds.filter((id) => recovering.has(id)).sort();
  const availableMemberIds = eligibleMemberIds.filter((id) => !committed.has(id) && !recovering.has(id));
  const remainingContextTeamSlots = Math.max(0, INCIDENT_DISPATCH_MAX_ACTIVE_TEAMS_PER_CONTEXT - activeContextTeams.length);
  const remainingIncidentTeamSlots = Math.max(0, INCIDENT_DISPATCH_MAX_ACTIVE_TEAMS_PER_INCIDENT - activeIncidentTeams.length);
  const incidentActive = activeLedgerIncident(state, contextKey, incidentId);
  return {
    contextKey,
    incidentId,
    incidentActive,
    eligibleMemberIds,
    committedMemberIds,
    recoveringMemberIds,
    availableMemberIds,
    activeContextTeamCount: activeContextTeams.length,
    activeIncidentTeamCount: activeIncidentTeams.length,
    maxTeamSize: INCIDENT_DISPATCH_MAX_TEAM_SIZE,
    maxActiveTeamsPerContext: INCIDENT_DISPATCH_MAX_ACTIVE_TEAMS_PER_CONTEXT,
    maxActiveTeamsPerIncident: INCIDENT_DISPATCH_MAX_ACTIVE_TEAMS_PER_INCIDENT,
    remainingContextTeamSlots,
    remainingIncidentTeamSlots,
    canAssign: incidentActive && availableMemberIds.length > 0 && remainingContextTeamSlots > 0 && remainingIncidentTeamSlots > 0,
  };
}

function pruneIncidentDispatchHistory(dispatch: IncidentDispatchStateV1): number {
  if (dispatch.teams.length <= INCIDENT_DISPATCH_MAX_TEAMS) return 0;
  const active = dispatch.teams.filter(activeDispatchTeam);
  const terminal = dispatch.teams
    .filter((team) => !activeDispatchTeam(team))
    .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt || left.dispatchOrdinal - right.dispatchOrdinal);
  const keepTerminal = Math.max(0, INCIDENT_DISPATCH_MAX_TEAMS - active.length);
  const next = [...active, ...terminal.slice(0, keepTerminal)].sort((left, right) => left.dispatchOrdinal - right.dispatchOrdinal);
  const pruned = dispatch.teams.length - next.length;
  dispatch.teams = next;
  return pruned;
}

/**
 * Create a response allocation against an already observer-safe active incident. This is an operator
 * decision only: it does not reserve world truth, consume time, change agent tasks, or resolve anything.
 */
export function assignIncidentResponseTeam(
  state: SandboxGameState,
  incidentId: string,
  memberIds: readonly string[],
  expedition?: ExpeditionState | null,
): IncidentDispatchTeam {
  const requested = unique(memberIds);
  if (requested.length < 1 || requested.length > INCIDENT_DISPATCH_MAX_TEAM_SIZE) throw new Error(`Incident response team size must be 1-${INCIDENT_DISPATCH_MAX_TEAM_SIZE}.`);
  const capacity = deriveIncidentDispatchCapacity(state, incidentId, expedition);
  if (!capacity.incidentActive) throw new Error('Incident response assignment requires a currently observer-visible active incident.');
  if (capacity.remainingContextTeamSlots <= 0) throw new Error('Incident response context has no remaining dispatch team capacity.');
  if (capacity.remainingIncidentTeamSlots <= 0) throw new Error('Incident already has the maximum number of active response teams.');
  const available = new Set(capacity.availableMemberIds);
  for (const id of requested) if (!available.has(id)) throw new Error(`Incident responder ${id} is unavailable or already committed.`);
  const dispatch = ensureIncidentDispatchState(state);
  const nowMinute = stateAbsoluteMinute(state);
  const ordinal = dispatch.nextDispatchOrdinal++;
  const team: IncidentDispatchTeam = {
    id: `incident-dispatch:${ordinal.toString(36)}`,
    contextKey: capacity.contextKey,
    incidentId,
    memberIds: requested.sort(),
    phase: 'assigned',
    assignedAt: nowMinute,
    lastUpdatedAt: nowMinute,
    dispatchOrdinal: ordinal,
  };
  dispatch.teams.push(team);
  pruneIncidentDispatchHistory(dispatch);
  pruneIncidentResponseOperationHistory(state);
  pruneIncidentResponseResourceHistory(state);
  pruneIncidentResponseEvidenceResourceUseHistory(state);
  pruneIncidentResponseDebriefHistory(state);
  return structuredClone(team);
}

/**
 * Dispatch starts the I2-D operational clock and I2-E bounded supply reservation, but still records
 * no success/failure, cause confirmation, or world-resolution claim. Reservation is atomic with
 * dispatch: insufficient canonical stock leaves the assigned team untouched.
 */
export function dispatchIncidentResponseTeam(state: SandboxGameState, teamId: string): IncidentDispatchTeam {
  const dispatch = ensureIncidentDispatchState(state);
  const team = dispatch.teams.find((entry) => entry.id === teamId);
  if (!team) throw new Error('Incident response team does not exist.');
  if (team.phase !== 'assigned') throw new Error('Only an assigned incident response team can be dispatched.');
  if (!activeLedgerIncident(state, team.contextKey as IncidentContextKey, team.incidentId)) throw new Error('Incident is no longer currently observer-visible; dispatch remains uncommitted.');
  const budget = responseResourceBudget(state, team);
  const source = responseResourceSource(state, team.contextKey as IncidentContextKey);
  assertResourceBudgetAvailable(source.available, budget);
  if (source.sourceKind==='settlement') reconcileResourceLedgerToAggregates(state,'legacy response dispatch');
  const nowMinute = stateAbsoluteMinute(state);
  team.phase = 'dispatched';
  team.dispatchedAt = nowMinute;
  team.lastUpdatedAt = nowMinute;
  const operation = createIncidentResponseOperation(state, team);
  reserveIncidentResponseResources(state, team, operation, budget);
  return structuredClone(team);
}

export function standDownIncidentResponseTeam(state: SandboxGameState, teamId: string): IncidentDispatchTeam {
  const dispatch = ensureIncidentDispatchState(state);
  const team = dispatch.teams.find((entry) => entry.id === teamId);
  if (!team) throw new Error('Incident response team does not exist.');
  if (team.phase === 'stood-down') return structuredClone(team);
  const nowMinute = stateAbsoluteMinute(state);
  const operation = state.incidentResponseOperations?.operations.find((entry) => entry.teamId === team.id);
  if (operation && activeResponseOperation(operation)) abortResponseOperation(state, operation, team, 'operator-stand-down', nowMinute);
  else standDownTeamAt(team, nowMinute);
  pruneIncidentDispatchHistory(dispatch);
  pruneIncidentResponseOperationHistory(state);
  pruneIncidentResponseResourceHistory(state);
  pruneIncidentResponseEvidenceResourceUseHistory(state);
  pruneIncidentResponseDebriefHistory(state);
  synchronizeIncidentResponseReadiness(state);
  return structuredClone(team);
}

export function incidentResponseTeams(
  state: SandboxGameState,
  incidentId?: string,
  expedition?: ExpeditionState | null,
): IncidentDispatchTeam[] {
  const contextKey = incidentContextKey(expedition);
  return ensureIncidentDispatchState(state).teams
    .filter((team) => team.contextKey === contextKey && (!incidentId || team.incidentId === incidentId))
    .map((team) => structuredClone(team));
}

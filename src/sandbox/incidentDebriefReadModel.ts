import type { IncidentResponseDebrief } from './types.js';

export type IncidentDebriefFilter = 'all'|'completed'|'aborted'|'evidence'|'resource';

export interface IncidentDebriefTimelineSummary {
  terminalCount: number;
  completedCount: number;
  abortedCount: number;
  firstTerminalAt: number | null;
  lastTerminalAt: number | null;
  spanMinutes: number;
  observationCount: number;
  positiveEvidenceCount: number;
  resourceUseCount: number;
}

const normalized = (value: unknown): string => String(value ?? '').trim().toLocaleLowerCase();

export function incidentDebriefMatchesFilter(debrief: IncidentResponseDebrief, filter: IncidentDebriefFilter): boolean {
  if (filter === 'completed') return debrief.terminalPhase === 'completed';
  if (filter === 'aborted') return debrief.terminalPhase === 'aborted';
  if (filter === 'evidence') return debrief.positiveEvidence.length > 0;
  if (filter === 'resource') return debrief.evidenceResourceUses.length > 0;
  return true;
}

export function incidentDebriefFactTokens(
  debrief: IncidentResponseDebrief,
  memberLabelForId?: (id: string) => string | undefined,
): string[] {
  const tokens: string[] = [
    debrief.id,
    debrief.operationId,
    debrief.teamId,
    debrief.contextKey,
    debrief.incidentId,
    debrief.terminalPhase,
    ...debrief.memberIds,
  ];
  for (const id of debrief.memberIds) {
    const label = memberLabelForId?.(id);
    if (label) tokens.push(label);
  }
  for (const observation of debrief.observations) {
    tokens.push(observation.id, observation.kind, observation.incidentVisibility);
  }
  for (const evidence of debrief.positiveEvidence) {
    tokens.push(evidence.id, evidence.kind, ...(evidence.subjectIds ?? []));
    if (evidence.metric) tokens.push(evidence.metric);
    if (evidence.comparison) tokens.push(evidence.comparison);
    if (evidence.observedValue !== undefined) tokens.push(String(evidence.observedValue));
    if (evidence.thresholdValue !== undefined) tokens.push(String(evidence.thresholdValue));
  }
  for (const use of debrief.evidenceResourceUses) {
    tokens.push(use.id, use.reservationId, use.evidenceId, use.evidenceKind, `medicine:${use.medicine}`, `tools:${use.tools}`);
  }
  if (debrief.resourceReservation) {
    tokens.push(
      debrief.resourceReservation.id,
      debrief.resourceReservation.phase,
      `food:${debrief.resourceReservation.consumed.food}`,
      `water:${debrief.resourceReservation.consumed.water}`,
      `medicine:${debrief.resourceReservation.consumed.medicine}`,
      `tools:${debrief.resourceReservation.consumed.tools}`,
    );
  }
  return tokens.map(normalized).filter(Boolean);
}

export function filterIncidentResponseDebriefs(
  debriefs: IncidentResponseDebrief[],
  filter: IncidentDebriefFilter,
  query = '',
  memberLabelForId?: (id: string) => string | undefined,
): IncidentResponseDebrief[] {
  const terms = normalized(query).split(/\s+/).filter(Boolean).slice(0, 8);
  return debriefs.filter((debrief) => {
    if (!incidentDebriefMatchesFilter(debrief, filter)) return false;
    if (!terms.length) return true;
    const haystack = incidentDebriefFactTokens(debrief, memberLabelForId).join('\n');
    return terms.every((term) => haystack.includes(term));
  });
}

export function summarizeIncidentDebriefTimeline(debriefs: IncidentResponseDebrief[]): IncidentDebriefTimelineSummary {
  if (!debriefs.length) {
    return { terminalCount: 0, completedCount: 0, abortedCount: 0, firstTerminalAt: null, lastTerminalAt: null, spanMinutes: 0, observationCount: 0, positiveEvidenceCount: 0, resourceUseCount: 0 };
  }
  const terminalTimes = debriefs.map((entry) => entry.chronology.terminalAt).filter(Number.isFinite);
  const firstTerminalAt = terminalTimes.length ? Math.min(...terminalTimes) : null;
  const lastTerminalAt = terminalTimes.length ? Math.max(...terminalTimes) : null;
  return {
    terminalCount: debriefs.length,
    completedCount: debriefs.filter((entry) => entry.terminalPhase === 'completed').length,
    abortedCount: debriefs.filter((entry) => entry.terminalPhase === 'aborted').length,
    firstTerminalAt,
    lastTerminalAt,
    spanMinutes: firstTerminalAt === null || lastTerminalAt === null ? 0 : Math.max(0, lastTerminalAt - firstTerminalAt),
    observationCount: debriefs.reduce((sum, entry) => sum + entry.observations.length, 0),
    positiveEvidenceCount: debriefs.reduce((sum, entry) => sum + entry.positiveEvidence.length, 0),
    resourceUseCount: debriefs.reduce((sum, entry) => sum + entry.evidenceResourceUses.length, 0),
  };
}

import type { AreaProjection, JsonValue, SpatialRef } from '../worldbridge/contract.js';
import { addChronicle, addExpeditionChronicle, clamp, findAgent, nextStateId } from './stateUtils.js';
import { beginOffNetworkReturn } from './fieldReturnSimulation.js';
import { resolveRendezvousRequest } from './rendezvousSimulation.js';
import type { ExpeditionRendezvousPlan, ExpeditionState, SandboxGameState, SandboxStepSummary } from './types.js';

const CONTACT_RADIUS_KM = 0.3;
const DEFAULT_WAIT_HOURS = 4;
const MAX_SEARCH_HOURS = 12;

function distance(a: SpatialRef, b: SpatialRef): number {
  if (a.frameId !== b.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function absoluteMinute(day: number, minute: number): number { return (day - 1) * 1440 + minute; }
function splitMinute(value: number): { day: number; minute: number } {
  const bounded = Math.max(0, Math.round(value));
  return { day: Math.floor(bounded / 1440) + 1, minute: bounded % 1440 };
}

function stringComponent(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export interface RendezvousEvidence {
  id: string;
  day: number;
  minute: number;
  position: SpatialRef;
  sourceIds: string[];
}

export function createResponderRendezvousPlan(
  state: SandboxGameState,
  responder: ExpeditionState,
  targetExpeditionId: string,
  evidence: RendezvousEvidence,
  etaHours: number,
): ExpeditionRendezvousPlan {
  const now = absoluteMinute(state.clock.day, state.clock.minuteOfDay);
  const evidenceAgeHours = Math.max(0, (now - absoluteMinute(evidence.day, evidence.minute)) / 60);
  const eta = Math.max(0, Number.isFinite(etaHours) ? etaHours : 0);
  const early = splitMinute(now + Math.max(0, eta - 1) * 60);
  const late = splitMinute(now + (eta + Math.max(2, 2 + evidenceAgeHours * 0.25)) * 60);
  const plan: ExpeditionRendezvousPlan = {
    id: nextStateId(state, 'rendezvous-plan'), targetExpeditionId,
    targetEvidenceId: evidence.id, targetEvidenceDay: evidence.day, targetEvidenceMinute: evidence.minute,
    evidencePosition: structuredClone(evidence.position), evidenceSourceIds: [...new Set(evidence.sourceIds)].sort(),
    launchedDay: state.clock.day, launchedMinute: state.clock.minuteOfDay, launchedTick: state.clock.worldTick,
    etaHoursAtLaunch: eta,
    arrivalWindowStartDay: early.day, arrivalWindowStartMinute: early.minute,
    arrivalWindowEndDay: late.day, arrivalWindowEndMinute: late.minute,
    status: 'outbound', waitHoursTotal: DEFAULT_WAIT_HOURS, waitHoursRemaining: DEFAULT_WAIT_HOURS,
    searchHours: 0, searchRadiusKm: clamp(0.75 + evidenceAgeHours * 0.15, 0.75, 8), searchStep: 0,
    lastSearchEvidenceIds: [],
  };
  responder.rendezvousPlan = plan;
  addExpeditionChronicle(state, responder.id, {
    kind: 'expedition', title: 'Responder rendezvous plan established',
    text: `${responder.id} will travel to time-stamped evidence ${evidence.id}; arrival, waiting and search do not use hidden current target coordinates.`,
    entityIds: [responder.id, targetExpeditionId, evidence.id, ...plan.evidenceSourceIds],
  });
  return plan;
}

export function ensureLegacyResponderRendezvousPlan(state: SandboxGameState, responder: ExpeditionState, etaHours = 0): ExpeditionRendezvousPlan | undefined {
  if (!responder.rescueOfExpeditionId) return undefined;
  if (responder.rendezvousPlan) return responder.rendezvousPlan;
  const target = state.expeditions.find((entry) => entry.id === responder.rescueOfExpeditionId);
  if (!target) return undefined;
  const request = target.rendezvousRequest;
  const report = [...(target.communicationReports ?? [])].reverse().find((entry) => entry.verified && entry.verifiedPosition);
  if (request?.status === 'transmitted' && request.verifiedPosition) {
    return createResponderRendezvousPlan(state, responder, target.id, {
      id: request.id, day: request.transmittedDay ?? request.requestedDay, minute: request.transmittedMinute ?? request.requestedMinute,
      position: request.verifiedPosition, sourceIds: [request.id, target.id],
    }, etaHours);
  }
  if (report?.verifiedPosition) {
    return createResponderRendezvousPlan(state, responder, target.id, {
      id: report.id, day: report.day, minute: report.minuteOfDay, position: report.verifiedPosition, sourceIds: [report.id, ...report.sourceIds],
    }, etaHours);
  }
  if (responder.destination) {
    return createResponderRendezvousPlan(state, responder, target.id, {
      id: `legacy-rescue-destination:${responder.id}`, day: responder.departureDay, minute: responder.departureMinute,
      position: responder.destination, sourceIds: [target.id],
    }, etaHours);
  }
  return undefined;
}

function expandingSquareOffset(step: number): { x: number; y: number } {
  if (step <= 0) return { x: 0, y: 0 };
  let x = 0; let y = 0; let dx = 1; let dy = 0;
  let legLength = 1; let legProgress = 0; let legsAtLength = 0;
  for (let index = 0; index < step; index += 1) {
    x += dx; y += dy; legProgress += 1;
    if (legProgress >= legLength) {
      legProgress = 0;
      const priorDx = dx; dx = -dy; dy = priorDx;
      legsAtLength += 1;
      if (legsAtLength >= 2) { legsAtLength = 0; legLength += 1; }
    }
  }
  return { x, y };
}

export function rendezvousSearchWaypoint(expedition: ExpeditionState): SpatialRef | undefined {
  const plan = expedition.rendezvousPlan;
  if (!plan || plan.status !== 'searching') return undefined;
  if (plan.searchStep === 0 && plan.intendedTargetPosition) return structuredClone(plan.intendedTargetPosition);
  // Evidence-centered expanding-square coverage: deterministic, bounded by the current search radius,
  // and independent of the target expedition's hidden canonical position.
  const lattice = expandingSquareOffset(Math.max(1, plan.searchStep));
  const spacingKm = 0.45;
  let offsetX = lattice.x * spacingKm;
  let offsetY = lattice.y * spacingKm;
  const extent = Math.max(Math.abs(offsetX), Math.abs(offsetY));
  if (extent > plan.searchRadiusKm && extent > 0) {
    const scale = plan.searchRadiusKm / extent; offsetX *= scale; offsetY *= scale;
  }
  return { ...plan.evidencePosition, x: plan.evidencePosition.x + offsetX, y: plan.evidencePosition.y + offsetY };
}

export function rendezvousFreezesMovement(expedition: ExpeditionState): boolean {
  return expedition.rendezvousPlan?.status === 'waiting' || expedition.rendezvousPlan?.status === 'contact';
}

function explicitSearchEvidence(projection: AreaProjection, targetExpeditionId: string): { id: string; spatial: SpatialRef } | undefined {
  return projection.entities.find((entity) => {
    if (!entity.spatial) return false;
    const target = stringComponent(entity.components.rescueEvidenceForExpeditionId)
      ?? stringComponent(entity.components.rendezvousTargetExpeditionId)
      ?? (entity.components.rescueEvidence === true ? stringComponent(entity.components.targetExpeditionId) : undefined);
    return target === targetExpeditionId;
  }) as { id: string; spatial: SpatialRef } | undefined;
}

function currentArrivalAssessment(state: SandboxGameState, plan: ExpeditionRendezvousPlan): 'early' | 'within' | 'late' {
  const now = absoluteMinute(state.clock.day, state.clock.minuteOfDay);
  const early = absoluteMinute(plan.arrivalWindowStartDay, plan.arrivalWindowStartMinute);
  const late = absoluteMinute(plan.arrivalWindowEndDay, plan.arrivalWindowEndMinute);
  return now < early ? 'early' : now > late ? 'late' : 'within';
}

function establishPhysicalContact(state: SandboxGameState, responder: ExpeditionState, target: ExpeditionState, summary: SandboxStepSummary): boolean {
  const plan = responder.rendezvousPlan;
  if (!plan || ['aborted','completed','contact'].includes(plan.status)) return plan?.status === 'contact';
  if (['returned','destroyed','joined-elsewhere'].includes(target.status)) return false;
  if (distance(responder.position, target.position) > CONTACT_RADIUS_KM) return false;
  plan.status = 'contact'; plan.lastOutcome = 'met'; plan.coLocatedAt = structuredClone(responder.position);
  resolveRendezvousRequest(target, `Physical rendezvous contact established with responder ${responder.id}.`);
  addExpeditionChronicle(state, responder.id, {
    kind: 'expedition', title: 'Physical rendezvous contact',
    text: `${responder.id} and ${target.id} became physically co-located. Aid or casualty transfer is now possible; no remote transfer occurred before contact.`,
    entityIds: [responder.id, target.id, plan.id],
  });
  summary.expeditionUpdates.push(`${responder.id} established physical rendezvous contact with ${target.id}.`);
  return true;
}

export function advanceRendezvousLifecycle(
  state: SandboxGameState,
  responder: ExpeditionState,
  projection: AreaProjection,
  hours: number,
  summary: SandboxStepSummary,
): void {
  const plan = responder.rendezvousPlan;
  if (!plan || ['aborted','completed'].includes(plan.status)) return;
  const target = state.expeditions.find((entry) => entry.id === plan.targetExpeditionId);
  if (!target || ['returned','destroyed','joined-elsewhere'].includes(target.status)) {
    abortRendezvousMission(state, responder, 'Target is no longer field-recoverable from current evidence.', 'aborted');
    return;
  }
  if (plan.status === 'contact') {
    // Physical contact is a durable decision point. Aid/casualty transfer is never automatic: the
    // player or a future doctrine layer must explicitly choose transfer or abort while co-located.
    return;
  }
  if (plan.status === 'outbound' && responder.status === 'exploring') {
    plan.status = 'waiting'; plan.arrivedDay = state.clock.day; plan.arrivedMinute = state.clock.minuteOfDay;
    plan.arrivalAssessment = currentArrivalAssessment(state, plan);
    addExpeditionChronicle(state, responder.id, {
      kind: 'expedition', title: 'Responder arrived at rendezvous evidence point',
      text: `${responder.id} reached the last verified rendezvous evidence point (${plan.arrivalAssessment}). It will wait before beginning a bounded search.`,
      entityIds: [responder.id, target.id, plan.id, plan.targetEvidenceId],
    });
  }
  if (establishPhysicalContact(state, responder, target, summary)) return;
  if (plan.status === 'waiting') {
    plan.waitHoursRemaining = Math.max(0, plan.waitHoursRemaining - Math.max(0, hours));
    if (plan.waitHoursRemaining <= 1e-9) {
      plan.status = 'searching'; plan.lastOutcome = 'waited-no-contact';
      addExpeditionChronicle(state, responder.id, {
        kind: 'expedition', title: 'Rendezvous wait ended without contact',
        text: `${responder.id} completed its bounded rendezvous wait and began a search pattern around the time-stamped evidence point.`,
        entityIds: [responder.id, target.id, plan.id],
      });
    }
    return;
  }
  if (plan.status !== 'searching') return;
  const clue = explicitSearchEvidence(projection, target.id);
  if (clue) {
    plan.evidencePosition = structuredClone(clue.spatial);
    plan.targetEvidenceId = clue.id;
    plan.targetEvidenceDay = state.clock.day; plan.targetEvidenceMinute = state.clock.minuteOfDay;
    plan.evidenceSourceIds = [...new Set([...plan.evidenceSourceIds, clue.id])].sort();
    plan.lastSearchEvidenceIds = [clue.id]; plan.lastOutcome = 'evidence-updated'; plan.searchStep = 0;
    delete plan.intendedTargetPosition; delete plan.intendedTargetSourceIds;
    addExpeditionChronicle(state, responder.id, {
      kind: 'expedition', title: 'Rendezvous search evidence updated',
      text: `${responder.id} は観測記録 ${clue.id} を確認。捜索範囲をこの記録地点へ更新しました。`,
      entityIds: [responder.id, target.id, plan.id, clue.id],
    });
  } else {
    plan.lastSearchEvidenceIds = [];
  }
  plan.searchHours += Math.max(0, hours);
  plan.searchStep += 1;
  const evidenceAgeHours = Math.max(0, (absoluteMinute(state.clock.day, state.clock.minuteOfDay) - absoluteMinute(plan.targetEvidenceDay, plan.targetEvidenceMinute)) / 60);
  plan.searchRadiusKm = clamp(0.75 + (evidenceAgeHours + plan.searchHours) * 0.15, 0.75, 12);
  if (establishPhysicalContact(state, responder, target, summary)) return;
  if (plan.searchHours >= MAX_SEARCH_HOURS) {
    abortRendezvousMission(state, responder, `${MAX_SEARCH_HOURS}時間の記録地点周辺捜索を完了しましたが、接触も新たな手掛かりもありませんでした。`, 'aborted');
  }
}

export function abortRendezvousMission(
  state: SandboxGameState,
  responder: ExpeditionState,
  reason: string,
  outcome: 'aborted' | 'responder-turnback' = 'aborted',
): void {
  const plan = responder.rendezvousPlan;
  if (!plan || ['aborted','completed'].includes(plan.status)) return;
  plan.status = 'aborted'; plan.lastOutcome = outcome; plan.abortedReason = reason;
  plan.completedDay = state.clock.day; plan.completedMinute = state.clock.minuteOfDay;
  beginOffNetworkReturn(state, responder);
  addExpeditionChronicle(state, responder.id, {
    kind: 'expedition', title: outcome === 'responder-turnback' ? 'Responder rendezvous turnback' : 'Rendezvous mission aborted',
    text: `${responder.id} ended the rendezvous mission: ${reason}`,
    entityIds: [responder.id, plan.targetExpeditionId, plan.id],
  });
}

export function syncResponderTurnback(state: SandboxGameState, responder: ExpeditionState, reason: string): void {
  const plan = responder.rendezvousPlan;
  if (!plan || ['aborted','completed'].includes(plan.status) || responder.status !== 'returning') return;
  abortRendezvousMission(state, responder, reason, 'responder-turnback');
}

export interface RendezvousTransferOptions {
  food?: number;
  water?: number;
  medicine?: number;
  tools?: number;
  injuredMemberIds?: string[];
}

export function transferRendezvousAidAndWounded(
  state: SandboxGameState,
  responderId: string,
  options: RendezvousTransferOptions = {},
): ExpeditionRendezvousPlan {
  const responder = state.expeditions.find((entry) => entry.id === responderId);
  const plan = responder?.rendezvousPlan;
  if (!responder || !plan || plan.status !== 'contact') throw new Error('Physical rendezvous contact is required before aid or casualty transfer.');
  const target = state.expeditions.find((entry) => entry.id === plan.targetExpeditionId);
  if (!target || distance(responder.position, target.position) > CONTACT_RADIUS_KM) throw new Error('Aid or casualty transfer requires actual physical co-location.');
  const wounded = [...new Set(options.injuredMemberIds ?? [])];
  for (const id of wounded) {
    const agent = findAgent(state, id);
    if (!target.memberIds.includes(id) || !agent?.alive || agent.health >= 55) throw new Error(`Injured-person transfer is not justified for ${id}.`);
  }
  const livingTargetIds = target.memberIds.filter((id) => findAgent(state, id)?.alive);
  if (wounded.length >= livingTargetIds.length && wounded.length > 0) throw new Error('At least one living member must remain with the source expedition in this QA16 transfer slice.');
  if (responder.memberIds.length + wounded.length > 8) throw new Error('Responder party capacity would be exceeded by casualty transfer.');
  const amounts = {
    food: Math.max(0, Number(options.food) || 0), water: Math.max(0, Number(options.water) || 0),
    medicine: Math.max(0, Number(options.medicine) || 0), tools: Math.max(0, Number(options.tools) || 0),
  };
  for (const key of ['food','water','medicine','tools'] as const) {
    if (amounts[key] > responder.supplies[key] + 1e-9) throw new Error(`Responder lacks ${key} for rendezvous transfer.`);
    responder.supplies[key] -= amounts[key]; target.supplies[key] += amounts[key];
  }
  for (const id of wounded) {
    target.memberIds = target.memberIds.filter((entry) => entry !== id);
    if (!responder.memberIds.includes(id)) responder.memberIds.push(id);
    const agent = findAgent(state, id); if (agent) { agent.expeditionId = responder.id; agent.residence = 'expedition'; }
  }
  plan.transfer = { completedDay: state.clock.day, completedMinute: state.clock.minuteOfDay, ...amounts, injuredMemberIds: wounded };
  plan.status = 'completed'; plan.lastOutcome = 'met'; plan.completedDay = state.clock.day; plan.completedMinute = state.clock.minuteOfDay;
  const priorStatus = target.status;
  target.communication = priorStatus === 'time-displaced' ? 'altered' : 'connected'; target.silentHours = 0; target.missingReason = ''; delete target.lossState;
  beginOffNetworkReturn(state, target); beginOffNetworkReturn(state, responder);
  resolveRendezvousRequest(target, `Resolved after physical contact and transfer with responder ${responder.id}.`);
  for (const id of target.memberIds) { const agent = findAgent(state, id); if (agent?.alive) agent.residence = 'expedition'; }
  addExpeditionChronicle(state, responder.id, {
    kind: 'expedition', title: 'Rendezvous transfer completed',
    text: `${responder.id} transferred aid only after co-location and accepted ${wounded.length} wounded member(s); both parties began physical return.`,
    entityIds: [responder.id, target.id, plan.id, ...wounded],
  });
  const recoveryTitle = priorStatus === 'missing' ? 'Missing expedition located'
    : priorStatus === 'captured' ? 'Captured expedition recovered'
      : priorStatus === 'time-displaced' ? 'Time-displaced expedition recovered'
        : 'Communication-lost expedition located';
  addChronicle(state, {
    kind: 'expedition', title: recoveryTitle,
    text: `${responder.id} physically located ${target.id}; transfer occurred only after co-location and both parties began returning.`,
    entityIds: [responder.id, target.id, ...wounded],
  });
  return plan;
}

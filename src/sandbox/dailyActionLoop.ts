import type { WorldProvider } from '../worldbridge/contract.js';
import { advanceSandbox } from './engine.js';
import { findAgent, settlementAgents } from './stateUtils.js';
import type {
  DailyExecutionAccumulation,
  DailyExecutionPolicy,
  DailyInterruptionKind,
  DailyLoopStateV1,
  DailyPlan,
  ExecutionInterruption,
  LaborTask,
  MorningReport,
  MorningResidentDelta,
  MorningResidentSeverity,
  MorningSnapshot,
  SandboxGameState,
  SandboxStepSummary,
  SettlementResourceKey,
} from './types.js';

const RESOURCE_KEYS: SettlementResourceKey[] = ['food','water','medicine','timber','scrap','fuel','cloth','records'];
const ACTIVE_EXPEDITION_STATUSES = new Set(['forming','outbound','exploring','returning','missing','captured','time-displaced']);

function defaultPlan(state: SandboxGameState, carryAssignments: DailyPlan['assignments'] = []): DailyPlan {
  return {
    day: state.clock.day,
    status: 'draft',
    assignments: carryAssignments.map((entry) => ({ ...entry })),
    policies: { expedition: 'auto', medical: 'auto' },
  };
}

export function captureMorningSnapshot(state: SandboxGameState): MorningSnapshot {
  return {
    day: state.clock.day,
    minuteOfDay: state.clock.minuteOfDay,
    residents: settlementAgents(state).map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      alive: agent.alive,
      health: agent.health,
      fatigue: agent.fatigue,
      morale: agent.morale,
      hunger: agent.needs.hunger,
      thirst: agent.needs.thirst,
      task: agent.currentTask,
      residence: agent.residence ?? (agent.expeditionId ? 'expedition' : 'settlement'),
      expeditionId: agent.expeditionId,
      activePathologies: agent.pathology
        .filter((entry) => entry.status === 'active' || entry.status === 'chronic')
        .map((entry) => ({ id: entry.id, pathologyId: entry.pathologyId, severity: entry.severity, status: entry.status })),
    })),
    resources: structuredClone(state.settlement.resources),
    expeditions: state.expeditions.map((entry) => ({ id: entry.id, status: entry.status, memberIds: [...entry.memberIds], leaderId: entry.leaderId })),
  };
}

export function ensureDailyLoopState(state: SandboxGameState): DailyLoopStateV1 {
  if (state.dailyLoop?.schemaVersion === 1) return state.dailyLoop;
  const snapshot = captureMorningSnapshot(state);
  state.dailyLoop = {
    schemaVersion: 1,
    phase: 'planning',
    currentPlan: defaultPlan(state),
    lastMorningSnapshot: snapshot,
    lastMorningReport: buildMorningReport(snapshot, snapshot, { births: [], deaths: [], expeditionUpdates: [], settlementUpdates: [] }),
  };
  return state.dailyLoop;
}

function pathologyMap(snapshot: MorningSnapshot['residents'][number]): Map<string, number> {
  return new Map(snapshot.activePathologies.map((entry) => [entry.id, entry.severity]));
}

function classifyResident(before: MorningSnapshot['residents'][number] | undefined, after: MorningSnapshot['residents'][number] | undefined, died: boolean): Pick<MorningResidentDelta,'severity'|'severityScore'|'recommendedResponse'> {
  if (died || (before && !after)) return { severity: 'death', severityScore: 1000, recommendedResponse: '死亡記録と家族・役割・資源配分への影響を確認してください。' };
  if (!after) return { severity: 'stable', severityScore: 0, recommendedResponse: '状態を確認してください。' };
  const healthDelta = after.health - (before?.health ?? after.health);
  const beforePath = before ? pathologyMap(before) : new Map<string, number>();
  const newConditions = after.activePathologies.filter((entry) => !beforePath.has(entry.id));
  const maxSeverity = Math.max(0, ...after.activePathologies.map((entry) => entry.severity));
  const pathologyWorsening = Math.max(0, ...after.activePathologies.map((entry) => entry.severity - (beforePath.get(entry.id) ?? entry.severity)));
  if (after.health <= 25 || maxSeverity >= 80 || after.thirst >= 90 || after.hunger >= 95) return { severity: 'critical', severityScore: 900 + (100-after.health) + maxSeverity, recommendedResponse: '最優先で医療・水・食料・休養を割り当ててください。' };
  if (after.health <= 45 || maxSeverity >= 60 || healthDelta <= -18 || pathologyWorsening >= 20) return { severity: 'severe', severityScore: 750 + Math.max(0,-healthDelta) + maxSeverity, recommendedResponse: '本日の作業を外し、診療または休養を検討してください。' };
  if (newConditions.length) return { severity: 'new-condition', severityScore: 650 + Math.max(...newConditions.map((entry)=>entry.severity)), recommendedResponse: '新規病理・負傷を確認し、治療方針を設定してください。' };
  if (after.thirst >= 75 || after.hunger >= 75) return { severity: 'needs', severityScore: 560 + Math.max(after.thirst,after.hunger), recommendedResponse: '配給ルールと本人の摂取状況を確認してください。' };
  if (healthDelta <= -8 || pathologyWorsening >= 8 || after.fatigue - (before?.fatigue ?? after.fatigue) >= 20) return { severity: 'worsened', severityScore: 470 + Math.max(0,-healthDelta) + pathologyWorsening, recommendedResponse: '悪化要因と昨日の作業負荷を確認してください。' };
  if (after.health < 65 || after.fatigue >= 70 || maxSeverity >= 35) return { severity: 'watch', severityScore: 350 + maxSeverity + after.fatigue * .2, recommendedResponse: '要注意として作業負荷と配給を調整してください。' };
  if (healthDelta >= 6 || pathologyWorsening < -8 || (before && after.fatigue <= before.fatigue - 15)) return { severity: 'improved', severityScore: 150, recommendedResponse: '改善傾向です。無理をさせず経過を確認してください。' };
  return { severity: 'stable', severityScore: 10, recommendedResponse: '大きな変化はありません。' };
}

function summaryText(before: MorningSnapshot['residents'][number] | undefined, after: MorningSnapshot['residents'][number] | undefined, severity: MorningResidentSeverity, newPathologyIds: string[]): string {
  if (severity === 'death') return '前日から今日までに死亡。';
  if (!after) return '現在の集落状態から確認できません。';
  const changes: string[] = [];
  const healthDelta = after.health - (before?.health ?? after.health);
  const fatigueDelta = after.fatigue - (before?.fatigue ?? after.fatigue);
  if (Math.abs(healthDelta) >= 1) changes.push(`体力 ${healthDelta>0?'+':''}${healthDelta.toFixed(0)}`);
  if (Math.abs(fatigueDelta) >= 5) changes.push(`疲労 ${fatigueDelta>0?'+':''}${fatigueDelta.toFixed(0)}`);
  if (newPathologyIds.length) changes.push(`新規 ${newPathologyIds.join(', ')}`);
  if (after.hunger >= 70) changes.push(`空腹 ${after.hunger.toFixed(0)}`);
  if (after.thirst >= 70) changes.push(`渇き ${after.thirst.toFixed(0)}`);
  return changes.join(' · ') || '大きな状態変化なし。';
}

export function buildMorningReport(before: MorningSnapshot, after: MorningSnapshot, summary: Pick<SandboxStepSummary,'births'|'deaths'|'expeditionUpdates'|'settlementUpdates'>): MorningReport {
  const beforeById = new Map(before.residents.map((entry) => [entry.agentId, entry]));
  const afterById = new Map(after.residents.map((entry) => [entry.agentId, entry]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys(), ...summary.deaths]);
  const residentDeltas: MorningResidentDelta[] = [];
  for (const agentId of ids) {
    const prior = beforeById.get(agentId);
    const current = afterById.get(agentId);
    const died = summary.deaths.includes(agentId);
    const classification = classifyResident(prior,current,died);
    const priorPathIds = new Set(prior?.activePathologies.map((entry)=>entry.id) ?? []);
    const newPathologyIds = current?.activePathologies.filter((entry)=>!priorPathIds.has(entry.id)).map((entry)=>entry.pathologyId) ?? [];
    residentDeltas.push({
      agentId,
      name: current?.name ?? prior?.name ?? agentId,
      ...classification,
      summary: summaryText(prior,current,classification.severity,newPathologyIds),
      healthBefore: prior?.health ?? current?.health ?? 0,
      healthAfter: current?.health ?? 0,
      healthDelta: (current?.health ?? 0) - (prior?.health ?? current?.health ?? 0),
      fatigueDelta: (current?.fatigue ?? 0) - (prior?.fatigue ?? current?.fatigue ?? 0),
      moraleDelta: (current?.morale ?? 0) - (prior?.morale ?? current?.morale ?? 0),
      hungerAfter: current?.hunger ?? 0,
      thirstAfter: current?.thirst ?? 0,
      newPathologyIds,
      activePathologyIds: current?.activePathologies.map((entry)=>entry.pathologyId) ?? [],
      task: current?.task ?? prior?.task ?? 'rest',
      residence: current?.residence ?? prior?.residence ?? 'unknown',
      expeditionId: current?.expeditionId ?? prior?.expeditionId ?? null,
    });
  }
  residentDeltas.sort((a,b) => b.severityScore-a.severityScore || a.name.localeCompare(b.name));
  const resourceDeltas: Partial<Record<SettlementResourceKey,number>> = {};
  for (const key of RESOURCE_KEYS) {
    const delta = after.resources[key] - before.resources[key];
    if (Math.abs(delta) > 1e-9) resourceDeltas[key] = delta;
  }
  return { day: after.day, minuteOfDay: after.minuteOfDay, residentDeltas, resourceDeltas, expeditionUpdates: [...summary.expeditionUpdates], settlementUpdates: [...summary.settlementUpdates], births: [...summary.births], deaths: [...summary.deaths] };
}

export function setDailyAssignment(state: SandboxGameState, agentId: string, task: LaborTask, note?: string): void {
  const loop = ensureDailyLoopState(state);
  if (loop.phase !== 'planning' || loop.currentPlan.status !== 'draft') throw new Error('Daily assignments can only be edited during planning.');
  const agent = findAgent(state,agentId);
  if (!agent?.alive || (agent.residence ?? (agent.expeditionId ? 'expedition' : 'settlement')) !== 'settlement') throw new Error('Daily assignment requires a living settlement resident.');
  loop.currentPlan.assignments = loop.currentPlan.assignments.filter((entry)=>entry.agentId!==agentId);
  loop.currentPlan.assignments.push({ agentId, task, ...(note?.trim()?{note:note.trim()}: {}) });
}

export function setExecutionPolicy(state: SandboxGameState, domain: 'expedition'|'medical', policy: DailyExecutionPolicy): void {
  const loop = ensureDailyLoopState(state);
  if (loop.phase !== 'planning' || loop.currentPlan.status !== 'draft') throw new Error('Execution policy can only be edited during planning.');
  loop.currentPlan.policies[domain] = policy;
}

export function commitDailyPlan(state: SandboxGameState): DailyPlan {
  const loop = ensureDailyLoopState(state);
  if (loop.phase !== 'planning') throw new Error('Daily plan cannot be committed outside planning.');
  loop.currentPlan.status = 'committed';
  loop.currentPlan.committedDay = state.clock.day;
  loop.currentPlan.committedMinuteOfDay = state.clock.minuteOfDay;
  return loop.currentPlan;
}

export function previewDailyInterruption(state: SandboxGameState, plan: DailyPlan): ExecutionInterruption | undefined {
  if (plan.policies.medical === 'manual') {
    const severe = settlementAgents(state).filter((agent) => agent.health <= 45 || agent.pathology.some((entry)=>(entry.status==='active'||entry.status==='chronic')&&entry.severity>=60));
    if (severe.length) return { kind: 'medical', title: '医療判断が必要です', detail: `${severe.length}名が重症域です。手動診療を行うか、この日の医療をAUTOへ切り替えてください。`, subjectIds: severe.map((agent)=>agent.id) };
  }
  if (plan.policies.expedition === 'manual') {
    const active = state.expeditions.filter((entry)=>ACTIVE_EXPEDITION_STATUSES.has(entry.status));
    if (active.length) return { kind: 'expedition', title: '探索判断が必要です', detail: `${active.length}隊が活動中です。LOCAL/WORLDで手動指示を行うか、この日の探索をAUTOへ切り替えてください。`, subjectIds: active.map((entry)=>entry.id) };
  }
  return undefined;
}

export function resolveDailyInterruptionAsAuto(state: SandboxGameState, kind: DailyInterruptionKind): void {
  const loop = ensureDailyLoopState(state);
  if (kind === 'medical') loop.currentPlan.policies.medical = 'auto';
  else loop.currentPlan.policies.expedition = 'auto';
  loop.phase = 'planning';
  loop.currentPlan.status = 'committed';
  if (loop.executionSession) { loop.executionSession.status = 'executing'; delete loop.executionSession.interruption; }
}

function absoluteGameMinute(state: Pick<SandboxGameState,'clock'>): number {
  return (state.clock.day - 1) * 1440 + state.clock.minuteOfDay;
}

function emptyAccumulation(): DailyExecutionAccumulation {
  return { births: [], deaths: [], expeditionUpdates: [], settlementUpdates: [] };
}

function mergeAccumulation(target: DailyExecutionAccumulation, summary: Pick<SandboxStepSummary,'births'|'deaths'|'expeditionUpdates'|'settlementUpdates'>): void {
  target.births.push(...summary.births);
  target.deaths.push(...summary.deaths);
  target.expeditionUpdates.push(...summary.expeditionUpdates);
  target.settlementUpdates.push(...summary.settlementUpdates);
}

export async function executeCommittedPlan(provider: WorldProvider, state: SandboxGameState): Promise<{ status:'completed'; report: MorningReport } | { status:'interrupted'; interruption: ExecutionInterruption }> {
  const loop = ensureDailyLoopState(state);
  if (loop.currentPlan.status !== 'committed') throw new Error('Commit the daily plan before execution.');

  const now = absoluteGameMinute(state);
  let session = loop.executionSession;
  const resumable = session && session.status !== 'completed' && session.targetAbsoluteMinute > now;
  if (!resumable) {
    session = {
      startedDay: state.clock.day,
      startedMinuteOfDay: state.clock.minuteOfDay,
      targetAbsoluteMinute: now + 1440,
      status: 'executing',
      accumulated: emptyAccumulation(),
    };
    loop.executionSession = session;
  }
  if (!session) throw new Error('Daily execution session could not be initialized.');

  const interruption = previewDailyInterruption(state,loop.currentPlan);
  if (interruption) {
    loop.phase = 'interrupted';
    loop.currentPlan.status = 'committed';
    session.status = 'interrupted';
    session.interruption = interruption;
    return { status:'interrupted', interruption };
  }

  const before = loop.lastMorningSnapshot;
  const carriedAssignments = loop.currentPlan.assignments.map((entry)=>({...entry}));
  loop.phase = 'executing';
  loop.currentPlan.status = 'executing';
  session.status = 'executing';
  delete session.interruption;

  while (absoluteGameMinute(state) < session.targetAbsoluteMinute) {
    const remaining = session.targetAbsoluteMinute - absoluteGameMinute(state);
    const stepMinutes = Math.min(360, remaining);
    const step = await advanceSandbox(provider,state,stepMinutes);
    mergeAccumulation(session.accumulated,step);

    if (absoluteGameMinute(state) < session.targetAbsoluteMinute) {
      const midExecutionInterruption = previewDailyInterruption(state,loop.currentPlan);
      if (midExecutionInterruption) {
        loop.phase = 'interrupted';
        loop.currentPlan.status = 'committed';
        session.status = 'interrupted';
        session.interruption = midExecutionInterruption;
        return { status:'interrupted', interruption: midExecutionInterruption };
      }
    }
  }

  const after = captureMorningSnapshot(state);
  const report = buildMorningReport(before,after,session.accumulated);
  loop.phase = 'planning';
  loop.lastMorningSnapshot = after;
  loop.lastMorningReport = report;
  session.status = 'completed';
  loop.currentPlan = defaultPlan(state,carriedAssignments);
  return { status:'completed', report };
}

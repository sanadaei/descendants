import { previewDailyInterruption } from './dailyActionLoop.js';
import { agentAgeYears, settlementAgents } from './stateUtils.js';
import { SURVIVAL_RESERVE_CRITICAL_DAYS, SURVIVAL_RESERVE_WARNING_DAYS } from './survivalCampaign.js';
import type {
  DailyPlan,
  LaborTask,
  MorningReport,
  MorningResidentDelta,
  MorningResidentSeverity,
  SandboxGameState,
  SkillKey,
  SurvivalCampaignDirectiveTarget,
  SurvivalCampaignMilestoneId,
  SurvivalCampaignView,
} from './types.js';

export type DailyCommandTone = 'critical' | 'warning' | 'normal';
export type DailyCommandTarget = SurvivalCampaignDirectiveTarget;
export type DailyPlanReadiness = 'ready' | 'risk' | 'blocked';

export interface DailyCommandIssue {
  id: string;
  tone: DailyCommandTone;
  title: string;
  detail: string;
  target?: DailyCommandTarget;
  agentId?: string;
}

export type DailyInstrumentTrend = 'up' | 'down' | 'flat' | 'none' | 'activity';

export interface DailyResourceSummaryItem {
  id: 'population' | 'food' | 'water' | 'medicine' | 'expedition';
  label: string;
  value: string;
  detail: string;
  tone: DailyCommandTone;
  statusLabel: 'STABLE' | 'WATCH' | 'CRITICAL';
  trend: DailyInstrumentTrend;
  trendLabel: string;
  target: DailyCommandTarget;
}

export interface DailyResidentPlanRow {
  agentId: string;
  name: string;
  role: string;
  condition: string;
  previousTask: LaborTask;
  assignedTask: LaborTask;
  locked: boolean;
  riskNote?: string;
  severityScore: number;
}


export interface DailyAssignmentMoveSnapshot {
  agentId: string;
  name: string;
  fromTask: LaborTask;
  toTask: LaborTask;
}

export interface DailyAssignmentConsequenceReadback extends DailyAssignmentMoveSnapshot {
  severity: MorningResidentSeverity;
  severityScore: number;
  summary: string;
  healthAfter: number;
  healthDelta: number;
  fatigueDelta: number;
  moraleDelta: number;
}

export interface DailyMorningReplanEntry extends DailyAssignmentConsequenceReadback {
  currentTask: LaborTask;
  replanned: boolean;
  restEligible: boolean;
}

export interface DailyCrisisCandidate {
  agentId: string;
  name: string;
  detail: string;
  reasons: string[];
  currentTask: LaborTask;
  workedSameTaskYesterday: boolean;
}

export interface DailyCrisisRotationSwap {
  outgoingAgentId: string;
  outgoingName: string;
  incomingAgentId: string;
  incomingName: string;
  incomingPreviousTask: LaborTask;
}

export interface DailyCrisisConflict {
  agentId: string;
  name: string;
  tasks: LaborTask[];
}

export interface DailyCrisisBalanceAssignment {
  agentId: string;
  name: string;
  task: LaborTask;
  title: string;
  priorityOrder: number;
}

export interface DailyCrisisCoverage {
  coveredCount: number;
  totalCount: number;
  detail: string;
  nextCrisisId?: string;
  nextPriorityOrder?: number;
  nextTask?: LaborTask;
  nextTitle?: string;
  nextAssignedCount?: number;
  nextRequiredCoverage?: number;
}

export interface DailyCrisisFocusAssignment {
  agentId: string;
  name: string;
  task: LaborTask;
  title: string;
  priorityOrder: number;
  assignedCount: number;
  requiredCoverage: number;
  reason: 'uncovered' | 'continuity-gap';
}

export interface DailyCrisisRecoveryAssignment {
  agentId: string;
  name: string;
  fromTask: LaborTask;
  returnTask: LaborTask;
  title: string;
  priorityOrder: number;
}

export interface DailyCrisisRecovery {
  excessCount: number;
  recoverableCount: number;
  detail: string;
  assignment?: DailyCrisisRecoveryAssignment;
}

export interface DailyNormalOpsGap {
  task: LaborTask;
  label: string;
  previousCount: number;
  assignedCount: number;
  shortfall: number;
}

export interface DailyNormalOpsBalance {
  gapCount: number;
  shortfallCount: number;
  detail: string;
  gaps: DailyNormalOpsGap[];
  recoveryTask?: LaborTask;
}

export interface DailyPlanBalanceSegment {
  previousCount: number;
  assignedCount: number;
  delta: number;
}

export interface DailyPlanBalance {
  crisis: DailyPlanBalanceSegment;
  normalOps: DailyPlanBalanceSegment;
  rest: DailyPlanBalanceSegment;
  detail: string;
}

export interface DailyPlanBalanceRecovery {
  agentId: string;
  name: string;
  fromTask: LaborTask;
  returnTask: LaborTask;
  detail: string;
}

export interface DailyRestPressureCandidate {
  agentId: string;
  name: string;
  assignedTask: LaborTask;
  fatigue: number;
  health: number;
  detail: string;
}

export interface DailyRestPressure {
  candidateCount: number;
  detail: string;
  candidates: DailyRestPressureCandidate[];
}

export interface DailyRestFollowUpCandidate {
  agentId: string;
  name: string;
  assignedTask: LaborTask;
  fatigue: number;
  health: number;
  alreadyResting: boolean;
  detail: string;
}

export interface DailyRestFollowUp {
  candidateCount: number;
  detail: string;
  candidates: DailyRestFollowUpCandidate[];
}

export interface DailyRestReleaseTaskContext {
  task: LaborTask;
  label: string;
  previousCount: number;
  assignedCount: number;
  afterAssignedCount: number;
  shortfall: number;
  restAssignedCount: number;
  restAfterCount: number;
  skillLabel: string;
  skillValue: number;
  roleMatch: boolean;
  detail: string;
  effectDetail: string;
  fitDetail: string;
  balanceDirection: 'closer' | 'same' | 'farther';
  balanceEffectDetail: string;
  balanceEffectCompact: string;
}

export interface DailyRestReleaseCandidate {
  agentId: string;
  name: string;
  assignedTask: LaborTask;
  fatigue: number;
  health: number;
  detail: string;
  taskContexts: DailyRestReleaseTaskContext[];
}

export interface DailyRestReleaseReview {
  candidateCount: number;
  detail: string;
  candidates: DailyRestReleaseCandidate[];
}

export interface DailyCrisisRecommendation {
  id: string;
  title: string;
  detail: string;
  task: LaborTask;
  priorityOrder: number;
  urgencyTone: Exclude<DailyCommandTone, 'normal'>;
  urgencyDetail: string;
  previousCount: number;
  assignedCount: number;
  continuityShortfall: number;
  fillCandidateIds: string[];
  rotationSwap?: DailyCrisisRotationSwap;
  candidates: DailyCrisisCandidate[];
}

export interface DailyLongHorizon {
  milestoneId: SurvivalCampaignMilestoneId;
  label: string;
  title: string;
  detail: string;
  progress: string;
  target: DailyCommandTarget;
}

export interface DailyCommandView {
  priorities: DailyCommandIssue[];
  longHorizon?: DailyLongHorizon;
  outcomes: DailyCommandIssue[];
  resourceSummary: DailyResourceSummaryItem[];
  residentRows: DailyResidentPlanRow[];
  planImpact: DailyCommandIssue[];
  crisisRecommendations: DailyCrisisRecommendation[];
  crisisConflicts: DailyCrisisConflict[];
  crisisBalanceAssignments: DailyCrisisBalanceAssignment[];
  crisisCoverage?: DailyCrisisCoverage;
  crisisFocusAssignment?: DailyCrisisFocusAssignment;
  crisisRecovery?: DailyCrisisRecovery;
  normalOpsBalance?: DailyNormalOpsBalance;
  planBalance?: DailyPlanBalance;
  planBalanceRecovery?: DailyPlanBalanceRecovery;
  restPressure?: DailyRestPressure;
  restFollowUp?: DailyRestFollowUp;
  restReleaseReview?: DailyRestReleaseReview;
  readiness: DailyPlanReadiness;
  readinessIssues: DailyCommandIssue[];
}

export interface DailyCommandInput {
  state: SandboxGameState;
  plan: DailyPlan;
  report?: MorningReport;
  campaign: SurvivalCampaignView;
  canonicalBlockReason?: string;
}

const LABOR_TASK_LABELS: Record<LaborTask, string> = {
  forage: '採集', water: '給水', medicine: '医療', repair: '修繕', sanitation: '衛生',
  care: '介護', records: '記録', guard: '警備', rest: '休養', 'explore-prep': '遠征準備',
};

export function laborTaskDisplayName(task: string): string {
  return LABOR_TASK_LABELS[task as LaborTask] ?? task;
}

const STRENUOUS_TASKS = new Set<LaborTask>(['forage', 'water', 'repair', 'sanitation', 'guard', 'explore-prep']);
const ACTIVE_EXPEDITION_STATUSES = new Set(['forming', 'outbound', 'exploring', 'returning', 'missing', 'captured', 'time-displaced']);

function reserveTone(days: number): DailyCommandTone {
  if (days < SURVIVAL_RESERVE_CRITICAL_DAYS) return 'critical';
  if (days < SURVIVAL_RESERVE_WARNING_DAYS) return 'warning';
  return 'normal';
}

function instrumentStatusLabel(tone: DailyCommandTone): DailyResourceSummaryItem['statusLabel'] {
  return tone === 'critical' ? 'CRITICAL' : tone === 'warning' ? 'WATCH' : 'STABLE';
}

function deltaTrend(delta: number | undefined): { trend: DailyInstrumentTrend; trendLabel: string } {
  if (delta === undefined) return { trend: 'none', trendLabel: 'NO 24H SAMPLE' };
  if (Math.abs(delta) < 0.05) return { trend: 'flat', trendLabel: '24H Δ =0.0' };
  return { trend: delta > 0 ? 'up' : 'down', trendLabel: `24H Δ ${delta > 0 ? '+' : ''}${delta.toFixed(1)}` };
}

function reserveReadback(days: number): { tone: DailyCommandTone; label: string } {
  const tone = reserveTone(days);
  return {
    tone,
    label: tone === 'critical' ? '危機継続' : tone === 'warning' ? '警戒継続' : '警戒圏外',
  };
}

function compactResidentName(name: string): string {
  const generated = /^Resident INDIVIDUAL:ORIGIN:(.+)$/i.exec(name);
  if (generated?.[1]) return `Resident ${generated[1]}`;
  return name.length > 24 ? `${name.slice(0, 21)}…` : name;
}

function strongerTone(a: DailyCommandTone, b: DailyCommandTone): DailyCommandTone {
  const rank: Record<DailyCommandTone, number> = { normal: 0, warning: 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function reportByAgent(report: MorningReport | undefined): Map<string, MorningResidentDelta> {
  return new Map((report?.residentDeltas ?? []).map((entry) => [entry.agentId, entry]));
}

function residentRiskNote(agent: SandboxGameState['agents'][number], task: LaborTask): string | undefined {
  const activeSeverity = Math.max(0, ...agent.pathology
    .filter((entry) => entry.status === 'active' || entry.status === 'chronic')
    .map((entry) => entry.severity));
  if (STRENUOUS_TASKS.has(task) && (agent.health <= 45 || activeSeverity >= 60)) return '重症域で負荷の高い作業';
  if (STRENUOUS_TASKS.has(task) && agent.needs.thirst >= 70) return `渇き ${agent.needs.thirst.toFixed(0)} で負荷作業`;
  if (STRENUOUS_TASKS.has(task) && agent.needs.hunger >= 70) return `空腹 ${agent.needs.hunger.toFixed(0)} で負荷作業`;
  return undefined;
}

function assignedTask(plan: DailyPlan, agent: SandboxGameState['agents'][number]): LaborTask {
  return plan.assignments.find((entry) => entry.agentId === agent.id)?.task ?? agent.currentTask;
}

function buildResidentRows(input: DailyCommandInput): DailyResidentPlanRow[] {
  const byAgent = reportByAgent(input.report);
  return settlementAgents(input.state)
    .filter((agent) => agent.alive)
    .map((agent) => {
      const report = byAgent.get(agent.id);
      const task = assignedTask(input.plan, agent);
      const riskNote = residentRiskNote(agent, task);
      return {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        condition: `HP ${agent.health.toFixed(0)} · FAT ${agent.fatigue.toFixed(0)} · 空腹 ${agent.needs.hunger.toFixed(0)} · 渇き ${agent.needs.thirst.toFixed(0)}`,
        previousTask: report?.task ?? agent.currentTask,
        assignedTask: task,
        locked: agentAgeYears(input.state, agent) < 13,
        ...(riskNote ? { riskNote } : {}),
        severityScore: report?.severityScore ?? 0,
      };
    })
    .sort((a, b) => Number(Boolean(b.riskNote)) - Number(Boolean(a.riskNote)) || b.severityScore - a.severityScore || a.name.localeCompare(b.name));
}


export function assignmentConsequenceReadback(
  moves: readonly DailyAssignmentMoveSnapshot[],
  report: MorningReport,
): DailyAssignmentConsequenceReadback[] {
  const deltas = new Map(report.residentDeltas.map((entry) => [entry.agentId, entry]));
  return moves.flatMap((move) => {
    const delta = deltas.get(move.agentId);
    if (!delta) return [];
    return [{
      ...move,
      severity: delta.severity,
      severityScore: delta.severityScore,
      summary: delta.summary,
      healthAfter: delta.healthAfter,
      healthDelta: delta.healthDelta,
      fatigueDelta: delta.fatigueDelta,
      moraleDelta: delta.moraleDelta,
    }];
  }).sort((a, b) => b.severityScore - a.severityScore || a.name.localeCompare(b.name));
}

export function morningReplanQueue(
  readback: readonly DailyAssignmentConsequenceReadback[],
  rows: readonly DailyResidentPlanRow[],
  restPressure?: DailyRestPressure,
): DailyMorningReplanEntry[] {
  const rowsByAgent = new Map(rows.map((row) => [row.agentId, row]));
  const restEligible = new Set((restPressure?.candidates ?? []).map((candidate) => candidate.agentId));
  return readback.flatMap((entry) => {
    if (entry.severity === 'stable' || entry.severity === 'improved') return [];
    const row = rowsByAgent.get(entry.agentId);
    if (!row) return [];
    return [{
      ...entry,
      currentTask: row.assignedTask,
      replanned: row.assignedTask !== entry.toTask,
      restEligible: restEligible.has(entry.agentId),
    }];
  }).sort((a, b) => b.severityScore - a.severityScore || a.name.localeCompare(b.name));
}

function buildPlanImpact(input: DailyCommandInput, rows: DailyResidentPlanRow[]): DailyCommandIssue[] {
  const changed = rows.filter((row) => row.assignedTask !== row.previousTask);
  if (!changed.length) return [];

  const impact: DailyCommandIssue[] = [{
    id: 'assignment-changes', tone: 'normal', title: '割当変更',
    detail: `${changed.length}名を前日配置から変更 · 未実行。結果は翌朝のMorning Reportで確定します。`,
  }];
  const ranked: Array<{ rank: number; issue: DailyCommandIssue }> = [];
  const agentById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  const previousHazards = rows.filter((row) => {
    const agent = agentById.get(row.agentId);
    return agent ? Boolean(residentRiskNote(agent, row.previousTask)) : false;
  }).length;
  const plannedHazards = rows.filter((row) => Boolean(row.riskNote)).length;
  if (previousHazards !== plannedHazards) ranked.push({
    rank: 100,
    issue: {
      id: 'hazardous-placement',
      tone: plannedHazards > previousHazards ? 'warning' : 'normal',
      title: '危険配置',
      detail: `${previousHazards}→${plannedHazards}名 · ${plannedHazards > previousHazards ? '負荷の高い配置が増えています' : '負荷の高い配置を減らしました'}`,
      target: 'body',
    },
  });

  const coverage = (tasks: ReadonlySet<LaborTask>, key: 'previousTask' | 'assignedTask'): number =>
    rows.filter((row) => tasks.has(row[key])).length;
  const waterTasks = new Set<LaborTask>(['water', 'sanitation']);
  const foodTasks = new Set<LaborTask>(['forage']);
  const previousWater = coverage(waterTasks, 'previousTask');
  const plannedWater = coverage(waterTasks, 'assignedTask');
  if ((input.campaign.waterDays < SURVIVAL_RESERVE_WARNING_DAYS || input.campaign.waterSafety < 55) && previousWater !== plannedWater) ranked.push({
    rank: 90,
    issue: {
      id: 'water-coverage',
      tone: plannedWater > previousWater ? 'normal' : 'warning',
      title: '水対応',
      detail: `給水・衛生 ${previousWater}→${plannedWater}名 · ${plannedWater > previousWater ? '危機対応人数を増やしました' : '危機対応人数が減っています'}`,
      target: 'inventory',
    },
  });
  const previousFood = coverage(foodTasks, 'previousTask');
  const plannedFood = coverage(foodTasks, 'assignedTask');
  if (input.campaign.foodDays < SURVIVAL_RESERVE_WARNING_DAYS && previousFood !== plannedFood) ranked.push({
    rank: 80,
    issue: {
      id: 'food-coverage',
      tone: plannedFood > previousFood ? 'normal' : 'warning',
      title: '食料対応',
      detail: `採集 ${previousFood}→${plannedFood}名 · ${plannedFood > previousFood ? '危機対応人数を増やしました' : '危機対応人数が減っています'}`,
      target: 'inventory',
    },
  });

  impact.push(...ranked.sort((a, b) => b.rank - a.rank || a.issue.id.localeCompare(b.issue.id)).slice(0, 2).map(({ issue }) => issue));
  return impact;
}



const CRISIS_TASK_SKILL: Partial<Record<LaborTask, SkillKey>> = {
  forage: 'foraging',
  water: 'survival',
  sanitation: 'care',
};

const CRISIS_SKILL_LABEL: Partial<Record<SkillKey, string>> = {
  foraging: '採集',
  survival: '生存',
  care: '介護',
};

const RETURN_CONTEXT_TASK_SKILL: Partial<Record<LaborTask, SkillKey>> = {
  forage: 'foraging',
  water: 'survival',
  medicine: 'medicine',
  repair: 'construction',
  sanitation: 'care',
  care: 'care',
  records: 'records',
  guard: 'combat',
  'explore-prep': 'scouting',
};

const RETURN_CONTEXT_TASK_ROLE: Partial<Record<LaborTask, SandboxGameState['agents'][number]['role']>> = {
  forage: 'forager',
  water: 'water',
  medicine: 'medic',
  repair: 'builder',
  sanitation: 'generalist',
  care: 'caregiver',
  records: 'recorder',
  guard: 'guard',
  'explore-prep': 'scout',
};

const VISIBLE_SKILL_LABEL: Record<SkillKey, string> = {
  survival: '生存', medicine: '医療', construction: '建築', foraging: '採集', scouting: '偵察',
  combat: '戦闘', care: '介護', records: '記録', leadership: '指揮', trade: '交易',
};

function buildCrisisRecommendations(input: DailyCommandInput, rows: DailyResidentPlanRow[]): DailyCrisisRecommendation[] {
  type CrisisDefinition = {
    id: string;
    title: string;
    detail: string;
    task: LaborTask;
    urgencyTone: Exclude<DailyCommandTone, 'normal'>;
    urgencyDetail: string;
    domainOrder: number;
  };
  const definitions: CrisisDefinition[] = [];
  if (input.campaign.foodDays < SURVIVAL_RESERVE_WARNING_DAYS) {
    const urgencyTone = reserveTone(input.campaign.foodDays) === 'critical' ? 'critical' : 'warning';
    const threshold = urgencyTone === 'critical' ? SURVIVAL_RESERVE_CRITICAL_DAYS : SURVIVAL_RESERVE_WARNING_DAYS;
    definitions.push({
      id: 'food-forage', title: '食料危機 / 採集', detail: `備蓄 ${input.campaign.foodDays.toFixed(1)}日`, task: 'forage',
      urgencyTone, urgencyDetail: `備蓄 ${input.campaign.foodDays.toFixed(1)}日 < ${threshold.toFixed(1)}日`, domainOrder: 100,
    });
  }
  if (input.campaign.waterDays < SURVIVAL_RESERVE_WARNING_DAYS) {
    const urgencyTone = reserveTone(input.campaign.waterDays) === 'critical' ? 'critical' : 'warning';
    const threshold = urgencyTone === 'critical' ? SURVIVAL_RESERVE_CRITICAL_DAYS : SURVIVAL_RESERVE_WARNING_DAYS;
    definitions.push({
      id: 'water-carry', title: '水備蓄 / 給水', detail: `備蓄 ${input.campaign.waterDays.toFixed(1)}日`, task: 'water',
      urgencyTone, urgencyDetail: `備蓄 ${input.campaign.waterDays.toFixed(1)}日 < ${threshold.toFixed(1)}日`, domainOrder: 200,
    });
  }
  if (input.campaign.waterSafety < 55) definitions.push({
    id: 'water-sanitation', title: '水安全 / 衛生', detail: `安全度 ${input.campaign.waterSafety.toFixed(0)}%`, task: 'sanitation',
    urgencyTone: 'critical', urgencyDetail: `安全度 ${input.campaign.waterSafety.toFixed(0)}% < 55%`, domainOrder: 300,
  });
  if (!definitions.length) return [];

  const toneOrder: Record<Exclude<DailyCommandTone, 'normal'>, number> = { critical: 2, warning: 1 };
  const orderedDefinitions = definitions
    .sort((a, b) => toneOrder[b.urgencyTone] - toneOrder[a.urgencyTone] || b.domainOrder - a.domainOrder || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((definition, index) => ({ ...definition, priorityOrder: index + 1 }));
  const agentById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  const previousByAgent = reportByAgent(input.report);
  return orderedDefinitions.map((definition) => {
    const skill = CRISIS_TASK_SKILL[definition.task];
    const candidates = rows
      .filter((row) => !row.locked && row.assignedTask !== definition.task)
      .flatMap((row) => {
        const agent = agentById.get(row.agentId);
        if (!agent || residentRiskNote(agent, definition.task)) return [];
        const skillValue = skill ? agent.skills[skill] : 0;
        const roleMatch = (definition.task === 'forage' && agent.role === 'forager') || (definition.task === 'water' && agent.role === 'water') || (definition.task === 'sanitation' && agent.role === 'generalist');
        const workedSameTaskYesterday = previousByAgent.get(agent.id)?.task === definition.task;
        const skillLabel = skill ? (CRISIS_SKILL_LABEL[skill] ?? skill) : '適性';
        const reasons = [
          workedSameTaskYesterday ? `昨日も${laborTaskDisplayName(definition.task)}` : '昨日は別任務',
          ...(roleMatch ? ['役割一致'] : []),
          `${skillLabel} ${skillValue.toFixed(0)}`,
          `疲労 ${agent.fatigue.toFixed(0)}`,
          `HP ${agent.health.toFixed(0)}`,
        ];
        return [{
          agentId: agent.id,
          name: agent.name,
          detail: `現在 ${laborTaskDisplayName(row.assignedTask)} → ${laborTaskDisplayName(definition.task)}`,
          reasons,
          currentTask: row.assignedTask,
          workedSameTaskYesterday,
          skillValue,
          roleMatch,
          fatigue: agent.fatigue,
          health: agent.health,
        }];
      })
      .sort((a, b) => Number(a.workedSameTaskYesterday) - Number(b.workedSameTaskYesterday) || b.skillValue - a.skillValue || Number(b.roleMatch) - Number(a.roleMatch) || a.fatigue - b.fatigue || b.health - a.health || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map(({ agentId, name, detail, reasons, currentTask, workedSameTaskYesterday }) => ({ agentId, name, detail, reasons, currentTask, workedSameTaskYesterday }));
    const previousCount = input.report?.residentDeltas.filter((entry) => entry.task === definition.task).length ?? 0;
    const assignedCount = rows.filter((row) => row.assignedTask === definition.task).length;
    const continuityShortfall = Math.max(0, previousCount - assignedCount);
    const fillCandidateIds = candidates.slice(0, continuityShortfall).map((candidate) => candidate.agentId);
    const repeatedAssignees = rows
      .filter((row) => row.assignedTask === definition.task && previousByAgent.get(row.agentId)?.task === definition.task)
      .flatMap((row) => {
        const agent = agentById.get(row.agentId);
        return agent && (agent.fatigue >= 45 || agent.health <= 70) ? [{ row, agent }] : [];
      })
      .sort((a, b) => b.agent.fatigue - a.agent.fatigue || a.agent.health - b.agent.health || a.row.name.localeCompare(b.row.name));
    let rotationSwap: DailyCrisisRotationSwap | undefined;
    for (const repeated of repeatedAssignees) {
      const incoming = candidates.find((candidate) =>
        !candidate.workedSameTaskYesterday
        && (candidate.currentTask === 'rest' || candidate.currentTask === 'records')
        && !residentRiskNote(repeated.agent, candidate.currentTask));
      if (!incoming) continue;
      rotationSwap = {
        outgoingAgentId: repeated.row.agentId,
        outgoingName: repeated.row.name,
        incomingAgentId: incoming.agentId,
        incomingName: incoming.name,
        incomingPreviousTask: incoming.currentTask,
      };
      break;
    }
    return {
      ...definition,
      previousCount,
      assignedCount,
      continuityShortfall,
      fillCandidateIds,
      ...(rotationSwap ? { rotationSwap } : {}),
      candidates,
    };
  });
}


function coordinateCrisisStaffing(recommendations: DailyCrisisRecommendation[]): {
  recommendations: DailyCrisisRecommendation[];
  conflicts: DailyCrisisConflict[];
  balanceAssignments: DailyCrisisBalanceAssignment[];
  focusAssignment?: DailyCrisisFocusAssignment;
} {
  const appearances = new Map<string, { name: string; tasks: Set<LaborTask> }>();
  for (const recommendation of recommendations) {
    for (const candidate of recommendation.candidates) {
      const current = appearances.get(candidate.agentId) ?? { name: candidate.name, tasks: new Set<LaborTask>() };
      current.tasks.add(recommendation.task);
      appearances.set(candidate.agentId, current);
    }
  }
  const conflicts = [...appearances.entries()]
    .flatMap(([agentId, entry]) => entry.tasks.size >= 2 ? [{ agentId, name: entry.name, tasks: [...entry.tasks] }] : [])
    .sort((a, b) => b.tasks.length - a.tasks.length || a.name.localeCompare(b.name));
  const conflictCount = new Map(conflicts.map((entry) => [entry.agentId, entry.tasks.length]));
  const annotated = recommendations.map((recommendation) => ({
    ...recommendation,
    candidates: recommendation.candidates.map((candidate) => {
      const count = conflictCount.get(candidate.agentId) ?? 0;
      return count >= 2 ? { ...candidate, reasons: [...candidate.reasons, `他危機候補 ×${count}`] } : candidate;
    }),
  }));

  const activeTasks = new Set(annotated.map((entry) => entry.task));
  const top = annotated[0];
  let focusAssignment: DailyCrisisFocusAssignment | undefined;
  if (top) {
    const requiredCoverage = top.previousCount > 0 ? top.previousCount : 1;
    if (top.assignedCount < requiredCoverage) {
      const candidate = top.candidates.find((entry) => !activeTasks.has(entry.currentTask));
      if (candidate) {
        focusAssignment = {
          agentId: candidate.agentId,
          name: candidate.name,
          task: top.task,
          title: top.title,
          priorityOrder: top.priorityOrder,
          assignedCount: top.assignedCount,
          requiredCoverage,
          reason: top.previousCount > top.assignedCount ? 'continuity-gap' : 'uncovered',
        };
      }
    }
  }
  const usedAgents = new Set<string>();
  const balanceAssignments: DailyCrisisBalanceAssignment[] = [];
  for (const recommendation of annotated.filter((entry) => entry.assignedCount === 0)) {
    const candidate = recommendation.candidates.find((entry) =>
      !usedAgents.has(entry.agentId) && !activeTasks.has(entry.currentTask));
    if (!candidate) continue;
    usedAgents.add(candidate.agentId);
    balanceAssignments.push({
      agentId: candidate.agentId,
      name: candidate.name,
      task: recommendation.task,
      title: recommendation.title,
      priorityOrder: recommendation.priorityOrder,
    });
  }
  return {
    recommendations: annotated,
    conflicts,
    balanceAssignments: balanceAssignments.length >= 2 ? balanceAssignments : [],
    ...(focusAssignment ? { focusAssignment } : {}),
  };
}

function buildCrisisCoverage(recommendations: DailyCrisisRecommendation[]): DailyCrisisCoverage | undefined {
  if (!recommendations.length) return undefined;
  const withFloor = recommendations.map((entry) => ({
    entry,
    requiredCoverage: entry.previousCount > 0 ? entry.previousCount : 1,
  }));
  const coveredCount = withFloor.filter(({ entry, requiredCoverage }) => entry.assignedCount >= requiredCoverage).length;
  const next = withFloor.find(({ entry, requiredCoverage }) => entry.assignedCount < requiredCoverage);
  if (!next) {
    return {
      coveredCount,
      totalCount: recommendations.length,
      detail: `${coveredCount}/${recommendations.length} · 最低配置完了`,
    };
  }
  return {
    coveredCount,
    totalCount: recommendations.length,
    detail: `${coveredCount}/${recommendations.length} · 次 #${next.entry.priorityOrder} ${next.entry.title} ${next.entry.assignedCount}/${next.requiredCoverage}名`,
    nextCrisisId: next.entry.id,
    nextPriorityOrder: next.entry.priorityOrder,
    nextTask: next.entry.task,
    nextTitle: next.entry.title,
    nextAssignedCount: next.entry.assignedCount,
    nextRequiredCoverage: next.requiredCoverage,
  };
}

function buildCrisisRecovery(input: DailyCommandInput, rows: DailyResidentPlanRow[], recommendations: DailyCrisisRecommendation[]): DailyCrisisRecovery | undefined {
  if (!recommendations.length) return undefined;
  const activeTasks = new Set(recommendations.map((entry) => entry.task));
  const agentById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  let excessCount = 0;
  const assignments: DailyCrisisRecoveryAssignment[] = [];

  for (const recommendation of [...recommendations].sort((a, b) => b.priorityOrder - a.priorityOrder)) {
    const requiredCoverage = recommendation.previousCount > 0 ? recommendation.previousCount : 1;
    const excess = Math.max(0, recommendation.assignedCount - requiredCoverage);
    excessCount += excess;
    if (!excess) continue;
    const recoverable = rows
      .filter((row) => row.assignedTask === recommendation.task)
      .filter((row) => row.previousTask !== recommendation.task && !activeTasks.has(row.previousTask))
      .filter((row) => {
        const agent = agentById.get(row.agentId);
        return agent ? !residentRiskNote(agent, row.previousTask) : false;
      })
      .sort((a, b) => Number(b.previousTask === 'rest' || b.previousTask === 'records') - Number(a.previousTask === 'rest' || a.previousTask === 'records') || a.name.localeCompare(b.name))
      .slice(0, excess)
      .map((row) => ({
        agentId: row.agentId,
        name: row.name,
        fromTask: recommendation.task,
        returnTask: row.previousTask,
        title: recommendation.title,
        priorityOrder: recommendation.priorityOrder,
      }));
    assignments.push(...recoverable);
  }
  if (!excessCount) return undefined;
  const recoverableCount = assignments.length;
  return {
    excessCount,
    recoverableCount,
    detail: recoverableCount
      ? `最低配置を${excessCount}名上回る · 前日任務へ安全に戻せる ${recoverableCount}名`
      : `最低配置を${excessCount}名上回る · 安全な戻し先は住民表で確認`,
    ...(assignments[0] ? { assignment: assignments[0] } : {}),
  };
}

function buildNormalOpsBalance(
  rows: DailyResidentPlanRow[],
  recommendations: DailyCrisisRecommendation[],
  crisisCoverage: DailyCrisisCoverage | undefined,
  crisisRecovery: DailyCrisisRecovery | undefined,
): DailyNormalOpsBalance | undefined {
  if (!crisisCoverage || crisisCoverage.coveredCount < crisisCoverage.totalCount) return undefined;
  const activeTasks = new Set(recommendations.map((entry) => entry.task));
  const tasks = Object.keys(LABOR_TASK_LABELS) as LaborTask[];
  const gaps = tasks
    .filter((task) => !activeTasks.has(task))
    .map((task) => {
      const previousCount = rows.filter((row) => row.previousTask === task).length;
      const assignedCount = rows.filter((row) => row.assignedTask === task).length;
      return { task, label: laborTaskDisplayName(task), previousCount, assignedCount, shortfall: Math.max(0, previousCount - assignedCount) };
    })
    .filter((entry) => entry.shortfall > 0)
    .sort((a, b) => b.shortfall - a.shortfall || b.previousCount - a.previousCount || a.label.localeCompare(b.label));
  if (!gaps.length) return undefined;
  const shortfallCount = gaps.reduce((sum, entry) => sum + entry.shortfall, 0);
  const recoveryTask = crisisRecovery?.assignment?.returnTask;
  return {
    gapCount: gaps.length,
    shortfallCount,
    detail: `前日比 ${gaps.slice(0, 3).map((entry) => `${entry.label} ${entry.previousCount}→${entry.assignedCount}`).join(' · ')}${gaps.length > 3 ? ` · 他${gaps.length - 3}件` : ''}`,
    gaps,
    ...(recoveryTask && gaps.some((entry) => entry.task === recoveryTask) ? { recoveryTask } : {}),
  };
}

function buildPlanBalance(
  input: DailyCommandInput,
  rows: DailyResidentPlanRow[],
  recommendations: DailyCrisisRecommendation[],
): DailyPlanBalance | undefined {
  if (!input.report || !recommendations.length) return undefined;
  const crisisTasks = new Set(recommendations.map((entry) => entry.task));
  const staffingRows = rows.filter((row) => !row.locked);
  const counts = (key: 'previousTask' | 'assignedTask') => {
    let crisis = 0;
    let normalOps = 0;
    let rest = 0;
    for (const row of staffingRows) {
      const task = row[key];
      if (crisisTasks.has(task)) crisis += 1;
      else if (task === 'rest') rest += 1;
      else normalOps += 1;
    }
    return { crisis, normalOps, rest };
  };
  const previous = counts('previousTask');
  const assigned = counts('assignedTask');
  const segment = (before: number, after: number): DailyPlanBalanceSegment => ({
    previousCount: before,
    assignedCount: after,
    delta: after - before,
  });
  const crisis = segment(previous.crisis, assigned.crisis);
  const normalOps = segment(previous.normalOps, assigned.normalOps);
  const rest = segment(previous.rest, assigned.rest);
  if (crisis.delta === 0 && normalOps.delta === 0 && rest.delta === 0) return undefined;
  const signed = (value: number): string => value > 0 ? `+${value}` : value < 0 ? String(value) : '±0';
  return {
    crisis,
    normalOps,
    rest,
    detail: `危機対応 ${signed(crisis.delta)} · 平常業務 ${signed(normalOps.delta)} · 休養 ${signed(rest.delta)} · 前日配置比。必要人数の推奨ではありません`,
  };
}

function buildPlanBalanceRecovery(
  input: DailyCommandInput,
  rows: DailyResidentPlanRow[],
  recommendations: DailyCrisisRecommendation[],
  crisisCoverage: DailyCrisisCoverage | undefined,
  crisisRecovery: DailyCrisisRecovery | undefined,
  planBalance: DailyPlanBalance | undefined,
): DailyPlanBalanceRecovery | undefined {
  if (!planBalance || !crisisCoverage || crisisCoverage.coveredCount < crisisCoverage.totalCount || crisisRecovery?.assignment) return undefined;
  const crisisTasks = new Set(recommendations.map((entry) => entry.task));
  const agentById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  const category = (task: LaborTask): 'crisis' | 'normalOps' | 'rest' => crisisTasks.has(task) ? 'crisis' : task === 'rest' ? 'rest' : 'normalOps';
  const candidates = rows
    .filter((row) => !row.locked && row.previousTask !== row.assignedTask)
    .filter((row) => !crisisTasks.has(row.previousTask) && !crisisTasks.has(row.assignedTask))
    .filter((row) => category(row.previousTask) !== category(row.assignedTask))
    .filter((row) => {
      const agent = agentById.get(row.agentId);
      if (!agent) return false;
      if (row.assignedTask === 'rest' && (agent.fatigue >= 45 || agent.health <= 70)) return false;
      return !residentRiskNote(agent, row.previousTask);
    })
    .filter((row) => {
      const previousCategory = category(row.previousTask);
      const assignedCategory = category(row.assignedTask);
      if (previousCategory === 'rest' && assignedCategory === 'normalOps') return planBalance.rest.delta < 0 && planBalance.normalOps.delta > 0;
      if (previousCategory === 'normalOps' && assignedCategory === 'rest') return planBalance.normalOps.delta < 0 && planBalance.rest.delta > 0;
      return false;
    })
    .sort((a, b) => Number(b.previousTask === 'rest') - Number(a.previousTask === 'rest') || a.name.localeCompare(b.name));
  const row = candidates[0];
  if (!row) return undefined;
  return {
    agentId: row.agentId,
    name: row.name,
    fromTask: row.assignedTask,
    returnTask: row.previousTask,
    detail: `前日構成へ: ${row.name} ${laborTaskDisplayName(row.assignedTask)}→${laborTaskDisplayName(row.previousTask)} · 危機最低配置は変更しません`,
  };
}

function buildRestPressure(
  input: DailyCommandInput,
  rows: DailyResidentPlanRow[],
  recommendations: DailyCrisisRecommendation[],
  crisisCoverage: DailyCrisisCoverage | undefined,
  planBalanceRecovery: DailyPlanBalanceRecovery | undefined,
  crisisRecovery: DailyCrisisRecovery | undefined,
): DailyRestPressure | undefined {
  if (crisisCoverage && crisisCoverage.coveredCount < crisisCoverage.totalCount) return undefined;
  const crisisTasks = new Set(recommendations.map((entry) => entry.task));
  const excluded = new Set([planBalanceRecovery?.agentId, crisisRecovery?.assignment?.agentId].filter((value): value is string => Boolean(value)));
  const agentById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  const eligible = rows
    .filter((row) => !row.locked && row.assignedTask !== 'rest' && !crisisTasks.has(row.assignedTask) && !excluded.has(row.agentId))
    .flatMap((row) => {
      const agent = agentById.get(row.agentId);
      if (!agent || !(agent.fatigue >= 45 || agent.health <= 70)) return [];
      return [{
        agentId: row.agentId,
        name: row.name,
        assignedTask: row.assignedTask,
        fatigue: agent.fatigue,
        health: agent.health,
        detail: `${laborTaskDisplayName(row.assignedTask)} → 休養 · 疲労 ${agent.fatigue.toFixed(0)} · HP ${agent.health.toFixed(0)}`,
      } satisfies DailyRestPressureCandidate];
    })
    .sort((a, b) => b.fatigue - a.fatigue || a.health - b.health || a.name.localeCompare(b.name));
  if (!eligible.length) return undefined;
  return {
    candidateCount: eligible.length,
    detail: `${eligible.length}名 · 既存基準: 疲労45以上またはHP70以下。危機担当は候補外`,
    candidates: eligible.slice(0, 2),
  };
}

function buildRestFollowUp(
  input: DailyCommandInput,
  rows: DailyResidentPlanRow[],
  recommendations: DailyCrisisRecommendation[],
): DailyRestFollowUp | undefined {
  if (!input.report) return undefined;
  const crisisTasks = new Set(recommendations.map((entry) => entry.task));
  const rowById = new Map(rows.map((row) => [row.agentId, row]));
  const agentById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  const candidates = input.report.residentDeltas
    .filter((entry) => entry.task === 'rest' && (Math.abs(entry.fatigueDelta) >= 1 || Math.abs(entry.healthDelta) >= 1))
    .flatMap((entry) => {
      const row = rowById.get(entry.agentId);
      const agent = agentById.get(entry.agentId);
      if (!row || !agent || row.locked || crisisTasks.has(row.assignedTask)) return [];
      if (!(agent.fatigue >= 45 || agent.health <= 70)) return [];
      const alreadyResting = row.assignedTask === 'rest';
      return [{
        agentId: row.agentId,
        name: compactResidentName(row.name),
        assignedTask: row.assignedTask,
        fatigue: agent.fatigue,
        health: agent.health,
        alreadyResting,
        detail: `${alreadyResting ? '休養継続中' : `現在 ${laborTaskDisplayName(row.assignedTask)}`} · 疲労 ${agent.fatigue.toFixed(0)} · HP ${agent.health.toFixed(0)}`,
      } satisfies DailyRestFollowUpCandidate];
    })
    .sort((a, b) => b.fatigue - a.fatigue || a.health - b.health || a.name.localeCompare(b.name))
    .slice(0, 2);
  if (!candidates.length) return undefined;
  return {
    candidateCount: candidates.length,
    detail: `${candidates.length}名 · 今朝も既存の休養圧基準内。危機担当はこの導線から動かしません`,
    candidates,
  };
}

function buildRestReleaseReview(
  input: DailyCommandInput,
  rows: DailyResidentPlanRow[],
  recommendations: DailyCrisisRecommendation[],
): DailyRestReleaseReview | undefined {
  if (!input.report) return undefined;
  const rowById = new Map(rows.map((row) => [row.agentId, row]));
  const agentById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  const crisisTasks = new Set(recommendations.map((entry) => entry.task));
  const assignableRows = rows.filter((row) => !row.locked);
  const restAssignedCount = assignableRows.filter((row) => row.assignedTask === 'rest').length;
  const staffingCategory = (task: LaborTask): 'crisis' | 'normalOps' | 'rest' => crisisTasks.has(task) ? 'crisis' : task === 'rest' ? 'rest' : 'normalOps';
  const categoryCounts = (key: 'previousTask' | 'assignedTask') => {
    const counts = { crisis: 0, normalOps: 0, rest: 0 };
    for (const row of assignableRows) counts[staffingCategory(row[key])] += 1;
    return counts;
  };
  const previousCategoryCounts = categoryCounts('previousTask');
  const assignedCategoryCounts = categoryCounts('assignedTask');
  const balanceDelta = (assigned: number, previous: number): number => assigned - previous;
  const signedBalance = (value: number): string => value > 0 ? `+${value}` : value < 0 ? String(value) : '±0';
  const beforeBalance = {
    crisis: balanceDelta(assignedCategoryCounts.crisis, previousCategoryCounts.crisis),
    normalOps: balanceDelta(assignedCategoryCounts.normalOps, previousCategoryCounts.normalOps),
    rest: balanceDelta(assignedCategoryCounts.rest, previousCategoryCounts.rest),
  };
  const imbalance = (value: typeof beforeBalance): number => Math.abs(value.crisis) + Math.abs(value.normalOps) + Math.abs(value.rest);
  const taskContextsFor = (agent: ReturnType<typeof settlementAgents>[number]): DailyRestReleaseTaskContext[] =>
    (Object.keys(LABOR_TASK_LABELS) as LaborTask[])
      .filter((task) => task !== 'rest' && !crisisTasks.has(task))
      .map((task) => {
        const previousCount = rows.filter((row) => row.previousTask === task).length;
        const assignedCount = rows.filter((row) => row.assignedTask === task).length;
        const afterAssignedCount = assignedCount + 1;
        const restAfterCount = Math.max(0, restAssignedCount - 1);
        const skill = RETURN_CONTEXT_TASK_SKILL[task];
        const skillLabel = skill ? VISIBLE_SKILL_LABEL[skill] : '適性';
        const skillValue = skill ? agent.skills[skill] : 0;
        const roleMatch = RETURN_CONTEXT_TASK_ROLE[task] === agent.role;
        const afterBalance = {
          crisis: beforeBalance.crisis,
          normalOps: beforeBalance.normalOps + 1,
          rest: beforeBalance.rest - 1,
        };
        const beforeImbalance = imbalance(beforeBalance);
        const afterImbalance = imbalance(afterBalance);
        const balanceDirection: DailyRestReleaseTaskContext['balanceDirection'] = afterImbalance < beforeImbalance ? 'closer' : afterImbalance > beforeImbalance ? 'farther' : 'same';
        const balanceDirectionLabel = balanceDirection === 'closer' ? '前日構成へ近づく' : balanceDirection === 'farther' ? '前日構成から離れる' : '前日構成との差は同じ';
        return {
          task,
          label: laborTaskDisplayName(task),
          previousCount,
          assignedCount,
          afterAssignedCount,
          shortfall: Math.max(0, previousCount - assignedCount),
          restAssignedCount,
          restAfterCount,
          skillLabel,
          skillValue,
          roleMatch,
          detail: `${laborTaskDisplayName(task)} ${previousCount}→${assignedCount}`,
          effectDetail: `選択後 ${laborTaskDisplayName(task)} ${afterAssignedCount}/${previousCount} · 休養 ${restAssignedCount}→${restAfterCount}`,
          fitDetail: `${roleMatch ? '役割一致 · ' : ''}${skillLabel} ${skillValue.toFixed(0)}`,
          balanceDirection,
          balanceEffectDetail: `PLAN BALANCE · 平常業務 ${signedBalance(beforeBalance.normalOps)}→${signedBalance(afterBalance.normalOps)} · 休養 ${signedBalance(beforeBalance.rest)}→${signedBalance(afterBalance.rest)} · ${balanceDirectionLabel}`,
          balanceEffectCompact: `BALANCE · 平常 ${signedBalance(beforeBalance.normalOps)}→${signedBalance(afterBalance.normalOps)} · 休養 ${signedBalance(beforeBalance.rest)}→${signedBalance(afterBalance.rest)} · ${balanceDirection === 'closer' ? '前日比改善' : balanceDirection === 'farther' ? '偏り増加' : '偏り同じ'}`,
        } satisfies DailyRestReleaseTaskContext;
      })
      .filter((entry) => entry.shortfall > 0 && !residentRiskNote(agent, entry.task))
      .sort((a, b) => b.shortfall - a.shortfall || b.previousCount - a.previousCount || a.label.localeCompare(b.label))
      .slice(0, 2);
  const candidates = input.report.residentDeltas
    .filter((entry) => entry.task === 'rest' && (Math.abs(entry.fatigueDelta) >= 1 || Math.abs(entry.healthDelta) >= 1))
    .flatMap((entry) => {
      const row = rowById.get(entry.agentId);
      const agent = agentById.get(entry.agentId);
      if (!row || !agent || row.locked || row.assignedTask !== 'rest') return [];
      if (agent.fatigue >= 45 || agent.health <= 70) return [];
      return [{
        agentId: row.agentId,
        name: compactResidentName(row.name),
        assignedTask: row.assignedTask,
        fatigue: agent.fatigue,
        health: agent.health,
        detail: `今朝 疲労 ${agent.fatigue.toFixed(0)} · HP ${agent.health.toFixed(0)} · 可視休養圧を離脱`,
        taskContexts: taskContextsFor(agent),
      } satisfies DailyRestReleaseCandidate];
    })
    .sort((a, b) => a.fatigue - b.fatigue || b.health - a.health || a.name.localeCompare(b.name))
    .slice(0, 2);
  if (!candidates.length) return undefined;
  return {
    candidateCount: candidates.length,
    detail: `${candidates.length}名 · 復帰先はToday's Planで選択。前々日の任務は推定しません`,
    candidates,
  };
}

function buildReadinessIssues(input: DailyCommandInput, rows: DailyResidentPlanRow[], crisisCoverage?: DailyCrisisCoverage): DailyCommandIssue[] {
  if (input.canonicalBlockReason) {
    return [{
      id: 'canonical-block', tone: 'critical', title: '実行を続けられません',
      detail: input.canonicalBlockReason, target: 'task',
    }];
  }
  const issues: DailyCommandIssue[] = [];
  const manual = previewDailyInterruption(input.state, input.plan);
  if (manual) {
    issues.push({
      id: `manual-${manual.kind}`, tone: 'warning', title: manual.title, detail: manual.detail,
      target: manual.kind === 'medical' ? 'body' : 'expedition',
      ...(manual.kind === 'medical' && manual.subjectIds[0] ? { agentId: manual.subjectIds[0] } : {}),
    });
  }
  if (crisisCoverage && crisisCoverage.coveredCount < crisisCoverage.totalCount) {
    const missing = crisisCoverage.totalCount - crisisCoverage.coveredCount;
    issues.push({
      id: 'crisis-coverage-gap',
      tone: 'warning',
      title: `${missing}件の危機が最低配置未達`,
      detail: `COVERAGE ${crisisCoverage.coveredCount}/${crisisCoverage.totalCount}${crisisCoverage.nextPriorityOrder ? ` · 次 #${crisisCoverage.nextPriorityOrder} ${crisisCoverage.nextTitle ?? ''} ${crisisCoverage.nextAssignedCount ?? 0}/${crisisCoverage.nextRequiredCoverage ?? 1}名` : ''}`,
      target: 'task',
    });
  }
  const risky = rows.find((row) => row.riskNote);
  if (risky) issues.push({
    id: `resident-risk:${risky.agentId}`, tone: 'warning', title: `${risky.name} の配置を確認`,
    detail: `${laborTaskDisplayName(risky.assignedTask)} / ${risky.assignedTask}: ${risky.riskNote}`, target: 'body', agentId: risky.agentId,
  });
  const assigned = new Set(rows.map((row) => row.assignedTask));
  if (!crisisCoverage && input.campaign.waterDays < SURVIVAL_RESERVE_CRITICAL_DAYS && !assigned.has('water') && !assigned.has('sanitation')) {
    issues.push({ id: 'water-uncovered', tone: 'warning', title: '水危機への担当がありません', detail: `水備蓄 ${input.campaign.waterDays.toFixed(1)}日。給水 / water または 衛生 / sanitation の配置を確認してください。`, target: 'inventory' });
  }
  if (!crisisCoverage && input.campaign.foodDays < SURVIVAL_RESERVE_CRITICAL_DAYS && !assigned.has('forage')) {
    issues.push({ id: 'food-uncovered', tone: 'warning', title: '食料危機への担当がありません', detail: `食料備蓄 ${input.campaign.foodDays.toFixed(1)}日。採集 / forage の配置を確認してください。`, target: 'inventory' });
  }
  return issues;
}

function buildResourceSummary(input: DailyCommandInput): DailyResourceSummaryItem[] {
  const severeResidents = settlementAgents(input.state).filter((agent) =>
    agent.health <= 45 || agent.pathology.some((entry) => (entry.status === 'active' || entry.status === 'chronic') && entry.severity >= 60));
  const medicine = input.state.settlement.resources.medicine;
  const medicineTone: DailyCommandTone = severeResidents.length > 0 && medicine <= 0 ? 'critical' : severeResidents.length > 0 ? 'warning' : 'normal';
  const activeExpeditions = input.state.expeditions.filter((entry) => ACTIVE_EXPEDITION_STATUSES.has(entry.status));
  const troubledExpedition = activeExpeditions.some((entry) => ['missing', 'captured', 'time-displaced'].includes(entry.status));
  const expeditionStatusCounts = new Map<string, number>();
  for (const entry of activeExpeditions) expeditionStatusCounts.set(entry.status, (expeditionStatusCounts.get(entry.status) ?? 0) + 1);
  const expeditionDetail = activeExpeditions.length
    ? [...expeditionStatusCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status} ${count}`).join(' · ')
    : '待機';
  const populationTone: DailyCommandTone = (input.report?.deaths.length ?? 0) > 0 ? 'critical' : 'normal';
  const populationTrend = input.report
    ? (input.report.births.length || input.report.deaths.length
      ? { trend: 'activity' as const, trendLabel: `BIRTH +${input.report.births.length} · DEATH -${input.report.deaths.length}` }
      : { trend: 'none' as const, trendLabel: 'NO 24H CHANGE' })
    : { trend: 'none' as const, trendLabel: 'NO 24H SAMPLE' };
  const foodTone = reserveTone(input.campaign.foodDays);
  const waterTone: DailyCommandTone = input.campaign.waterSafety < 55 ? 'critical' : reserveTone(input.campaign.waterDays);
  const expeditionTone: DailyCommandTone = troubledExpedition ? 'warning' : 'normal';
  const foodTrend = deltaTrend(input.report?.resourceDeltas.food);
  const waterTrend = deltaTrend(input.report?.resourceDeltas.water);
  const medicineTrend = deltaTrend(input.report?.resourceDeltas.medicine);
  const expeditionTrend = input.report
    ? (input.report.expeditionUpdates.length
      ? { trend: 'activity' as const, trendLabel: `24H UPDATE ${input.report.expeditionUpdates.length}` }
      : { trend: 'none' as const, trendLabel: 'NO 24H UPDATE' })
    : { trend: 'none' as const, trendLabel: 'NO 24H SAMPLE' };
  const awayPopulation = Math.max(0, input.campaign.livingPopulation - input.campaign.localPopulation);
  return [
    {
      id: 'population', label: '人口', value: String(input.campaign.localPopulation),
      detail: `全生存 ${input.campaign.livingPopulation}${awayPopulation ? ` · 離在 ${awayPopulation}` : ''}`,
      tone: populationTone, statusLabel: instrumentStatusLabel(populationTone), ...populationTrend, target: 'chronicle',
    },
    {
      id: 'food', label: '食料', value: Number.isFinite(input.campaign.foodDays) ? `${input.campaign.foodDays.toFixed(1)}日` : '∞',
      detail: `stock ${input.state.settlement.resources.food.toFixed(1)}`,
      tone: foodTone, statusLabel: instrumentStatusLabel(foodTone), ...foodTrend, target: 'inventory',
    },
    {
      id: 'water', label: '水', value: Number.isFinite(input.campaign.waterDays) ? `${input.campaign.waterDays.toFixed(1)}日` : '∞',
      detail: `安全度 ${Math.round(input.campaign.waterSafety)}% · stock ${input.state.settlement.resources.water.toFixed(1)}`,
      tone: waterTone, statusLabel: instrumentStatusLabel(waterTone), ...waterTrend, target: 'inventory',
    },
    {
      id: 'medicine', label: '医療', value: `${medicine.toFixed(1)}`, detail: `重症域 ${severeResidents.length}名`,
      tone: medicineTone, statusLabel: instrumentStatusLabel(medicineTone), ...medicineTrend, target: 'inventory',
    },
    {
      id: 'expedition', label: '遠征', value: String(activeExpeditions.length), detail: expeditionDetail,
      tone: expeditionTone, statusLabel: instrumentStatusLabel(expeditionTone), ...expeditionTrend, target: 'expedition',
    },
  ];
}


export function morningReportTransitionSummary(report: MorningReport): string {
  const parts: string[] = [];
  if (report.deaths.length) parts.push(`死亡 ${report.deaths.length}`);
  const needsAttention = report.residentDeltas.filter((entry) =>
    ['critical', 'severe', 'new-condition', 'needs', 'worsened'].includes(entry.severity)).length;
  if (needsAttention) parts.push(`要対応 ${needsAttention}名`);
  for (const [key, label] of [['food', '食料'], ['water', '水'], ['medicine', '薬']] as const) {
    const delta = report.resourceDeltas[key];
    if (delta !== undefined && Math.abs(delta) >= 0.05) parts.push(`${label} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
  }
  if (report.births.length) parts.push(`出生 ${report.births.length}`);
  return parts.slice(0, 3).join(' · ') || '大きな変化なし';
}

function buildMorningOutcomes(input: DailyCommandInput): DailyCommandIssue[] {
  const report = input.report;
  if (!report) return [];
  const candidates: Array<{ rank: number; issue: DailyCommandIssue }> = [];

  if (report.births.length || report.deaths.length) {
    candidates.push({
      rank: 100,
      issue: {
        id: 'outcome-population',
        tone: report.deaths.length ? 'critical' : 'normal',
        title: '人口変動',
        detail: `出生 ${report.births.length} · 死亡 ${report.deaths.length}`,
        target: 'chronicle',
      },
    });
  }

  const worsened = report.residentDeltas.filter((entry) => ['critical', 'severe', 'new-condition', 'worsened'].includes(entry.severity));
  const improved = report.residentDeltas.filter((entry) => entry.severity === 'improved');
  if (worsened.length || improved.length) {
    const single = worsened.length === 1 ? worsened[0] : undefined;
    candidates.push({
      rank: 90,
      issue: {
        id: 'outcome-health',
        tone: worsened.some((entry) => entry.severity === 'critical') ? 'critical' : worsened.length ? 'warning' : 'normal',
        title: '住民状態の変化',
        detail: `悪化 ${worsened.length} · 改善 ${improved.length}`,
        ...(single ? { target: 'body' as const, agentId: single.agentId } : {}),
      },
    });
  }

  const agentsById = new Map(settlementAgents(input.state).map((agent) => [agent.id, agent]));
  const restRecovery = report.residentDeltas
    .filter((entry) => entry.task === 'rest' && (Math.abs(entry.fatigueDelta) >= 1 || Math.abs(entry.healthDelta) >= 1))
    .map((entry) => ({ entry, agent: agentsById.get(entry.agentId) }))
    .filter((value): value is { entry: MorningResidentDelta; agent: NonNullable<typeof value.agent> } => Boolean(value.agent))
    .sort((a, b) => b.agent.fatigue - a.agent.fatigue || a.agent.health - b.agent.health || a.entry.name.localeCompare(b.entry.name))
    .slice(0, 2);
  if (restRecovery.length) {
    const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(0)}`;
    const critical = restRecovery.some(({ agent }) => agent.health <= 45 || agent.fatigue >= 70);
    const warning = restRecovery.some(({ agent }) => agent.health <= 70 || agent.fatigue >= 45);
    candidates.push({
      rank: 78,
      issue: {
        id: 'outcome-rest-recovery',
        tone: critical ? 'critical' : warning ? 'warning' : 'normal',
        title: '休養の実測変化',
        detail: `${restRecovery.map(({ entry, agent }) => `${compactResidentName(entry.name)} 休養 · 疲労 ${signed(entry.fatigueDelta)} → 今朝 ${agent.fatigue.toFixed(0)} · HP ${signed(entry.healthDelta)} → 今朝 ${agent.health.toFixed(0)}`).join(' / ')} · 実測差分のみ`,
        target: 'body',
      },
    });
  }

  const responderTaskLabels = { forage: '採集', water: '給水', sanitation: '衛生' } as const;
  const responderLoad = report.residentDeltas
    .filter((entry) => entry.task in responderTaskLabels)
    .sort((a, b) => b.fatigueDelta - a.fatigueDelta || a.healthDelta - b.healthDelta || a.name.localeCompare(b.name))
    .slice(0, 2);
  if (responderLoad.length) {
    const critical = responderLoad.some((entry) => entry.healthAfter <= 45 || entry.healthDelta <= -15 || entry.fatigueDelta >= 25);
    const warning = responderLoad.some((entry) => entry.healthDelta < 0 || entry.fatigueDelta >= 12);
    const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(0)}`;
    candidates.push({
      rank: 84,
      issue: {
        id: 'outcome-responder-load',
        tone: critical ? 'critical' : warning ? 'warning' : 'normal',
        title: '危機担当の実測負荷',
        detail: `${responderLoad.map((entry) => `${compactResidentName(entry.name)} ${responderTaskLabels[entry.task as keyof typeof responderTaskLabels]} · 疲労 ${signed(entry.fatigueDelta)} · HP ${signed(entry.healthDelta)}`).join(' / ')} · 実測差分のみ`,
        target: 'body',
      },
    });
  }

  const responseTasks = { forage: '採集', water: '給水', sanitation: '衛生' } as const;
  const responseCounts = (Object.entries(responseTasks) as Array<[keyof typeof responseTasks, string]>)
    .map(([task, label]) => ({ task, label, count: report.residentDeltas.filter((entry) => entry.task === task).length }))
    .filter((entry) => entry.count > 0);
  const forageCount = responseCounts.find((entry) => entry.task === 'forage')?.count ?? 0;
  const waterCount = responseCounts.find((entry) => entry.task === 'water')?.count ?? 0;
  const sanitationCount = responseCounts.find((entry) => entry.task === 'sanitation')?.count ?? 0;
  const foodDelta = report.resourceDeltas.food;
  const waterDelta = report.resourceDeltas.water;
  const responseResourceParts: string[] = [];
  let responseTone: DailyCommandTone = 'normal';
  if (forageCount > 0 && foodDelta !== undefined && Math.abs(foodDelta) >= 0.05) {
    const readback = reserveReadback(input.campaign.foodDays);
    responseTone = strongerTone(responseTone, readback.tone);
    responseResourceParts.push(`食料 ${foodDelta >= 0 ? '+' : ''}${foodDelta.toFixed(1)} / 今朝 ${Number.isFinite(input.campaign.foodDays) ? input.campaign.foodDays.toFixed(1) : '∞'}日 / ${readback.label}`);
  }
  if ((waterCount > 0 || sanitationCount > 0) && waterDelta !== undefined && Math.abs(waterDelta) >= 0.05) {
    const reserve = reserveReadback(input.campaign.waterDays);
    const unsafeWater = input.campaign.waterSafety < 55;
    const readbackTone: DailyCommandTone = unsafeWater ? 'critical' : reserve.tone;
    responseTone = strongerTone(responseTone, readbackTone);
    responseResourceParts.push(`水 ${waterDelta >= 0 ? '+' : ''}${waterDelta.toFixed(1)} / 今朝 ${Number.isFinite(input.campaign.waterDays) ? input.campaign.waterDays.toFixed(1) : '∞'}日 / 安全度 ${input.campaign.waterSafety.toFixed(0)}% / ${unsafeWater ? '水質危機継続' : reserve.label}`);
  }
  const hasResponseLog = responseCounts.length > 0 && responseResourceParts.length > 0;
  if (hasResponseLog) {
    candidates.push({
      rank: 85,
      issue: {
        id: 'outcome-response-log',
        tone: responseTone,
        title: '昨日の対応配置 / 危機読み返し',
        detail: `${responseCounts.map((entry) => `${entry.label} ${entry.count}名`).join(' · ')} · ${responseResourceParts.join(' · ')} · 朝の観測記録と照合`,
        target: 'task',
      },
    });
  }

  const resourceLabels = { food: '食料', water: '水', medicine: '薬' } as const;
  const resourceParts = (Object.entries(resourceLabels) as Array<[keyof typeof resourceLabels, string]>)
    .flatMap(([key, label]) => {
      const delta = report.resourceDeltas[key];
      return delta !== undefined && Math.abs(delta) >= 0.05 ? [`${label} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`] : [];
    });
  if (resourceParts.length && !hasResponseLog) {
    const foodDelta = report.resourceDeltas.food ?? 0;
    const waterDelta = report.resourceDeltas.water ?? 0;
    candidates.push({
      rank: 80,
      issue: {
        id: 'outcome-resources',
        tone: foodDelta < 0 || waterDelta < 0 ? 'warning' : 'normal',
        title: '備蓄の増減',
        detail: resourceParts.join(' · '),
        target: 'inventory',
      },
    });
  }

  if (report.expeditionUpdates[0]) {
    candidates.push({
      rank: 70,
      issue: { id: 'outcome-expedition', tone: 'normal', title: '遠征更新', detail: report.expeditionUpdates[0], target: 'expedition' },
    });
  }
  if (report.settlementUpdates[0]) {
    candidates.push({
      rank: 60,
      issue: { id: 'outcome-settlement', tone: 'normal', title: '集落更新', detail: report.settlementUpdates[0], target: 'task' },
    });
  }

  return candidates.sort((a, b) => b.rank - a.rank || a.issue.id.localeCompare(b.issue.id)).slice(0, 3).map(({ issue }) => issue);
}

function buildLongHorizon(input: DailyCommandInput, readiness: DailyPlanReadiness, crises: DailyCrisisRecommendation[]): DailyLongHorizon | undefined {
  if (readiness !== 'ready' || crises.length > 0) return undefined;
  if (input.campaign.directive.severity === 'urgent' || input.campaign.directive.severity === 'critical') return undefined;
  const next = input.campaign.milestones.find((entry) => !entry.complete);
  if (!next) return undefined;

  if (next.id === 'stabilize') {
    const target: DailyCommandTarget = input.campaign.foodDays < 5 || input.campaign.waterDays < 5
      ? 'inventory'
      : input.campaign.waterSafety < 60 || input.campaign.sanitation < 50
        ? 'task'
        : 'body';
    return {
      milestoneId: 'stabilize',
      label: next.label,
      title: '基盤を安定させる',
      progress: `食料 ${input.campaign.foodDays.toFixed(1)}/5.0日 · 水 ${input.campaign.waterDays.toFixed(1)}/5.0日 · 安全度 ${input.campaign.waterSafety.toFixed(0)}/60 · 衛生 ${input.campaign.sanitation.toFixed(0)}/50 · 平均HP ${input.campaign.averageHealth.toFixed(0)}/60`,
      detail: '既存STABILIZE条件の現在値です。達成値そのものを示し、成果や成功率は予測しません。',
      target,
    };
  }
  if (next.id === 'explore') return {
    milestoneId: 'explore',
    label: next.label,
    title: '最初の遠征を帰還まで完遂する',
    progress: `帰還遠征 ${input.campaign.returnedExpeditions}/1 · 活動中 ${input.campaign.activeExpeditions}`,
    detail: 'WORLDで既知地点を選び、既存の遠征準備・出発・帰還ループを進めます。',
    target: 'expedition',
  };
  if (next.id === 'preserve') return {
    milestoneId: 'preserve',
    label: next.label,
    title: '知識をArchiveへ残す',
    progress: `保存記録 ${input.campaign.archivedRecords}/1 · 集落知識 ${input.campaign.institutionalKnowledge}`,
    detail: '既存のF3/Archiveを使って、死亡後も残る記録を1件以上保存します。',
    target: 'knowledge',
  };
  return {
    milestoneId: 'generation',
    label: next.label,
    title: '次世代が育つ余地を守る',
    progress: `存命の次世代 ${input.campaign.livingDescendants}/1 · 出生累計 ${input.campaign.birthsSinceStart}`,
    detail: '既存の人口simulationを進めるため、生存基盤と住民状態を維持します。出生結果は予測しません。',
    target: 'body',
  };
}

function campaignTone(severity: SurvivalCampaignView['directive']['severity']): DailyCommandTone {
  return severity === 'critical' ? 'critical' : severity === 'urgent' || severity === 'watch' ? 'warning' : 'normal';
}

function buildPriorities(input: DailyCommandInput, readinessIssues: DailyCommandIssue[], rows: DailyResidentPlanRow[]): DailyCommandIssue[] {
  const candidates: Array<{ rank: number; issue: DailyCommandIssue }> = [];
  const report = input.report;
  const manualMedical = readinessIssues.find((entry) => entry.id === 'manual-medical');
  const manualExpedition = readinessIssues.find((entry) => entry.id === 'manual-expedition');
  const plannedWaterCoverage = rows.filter((row) => row.assignedTask === 'water' || row.assignedTask === 'sanitation').length;
  const plannedFoodCoverage = rows.filter((row) => row.assignedTask === 'forage').length;
  if (report?.deaths.length) candidates.push({ rank: 1000, issue: { id: 'morning-death', tone: 'critical', title: `${report.deaths.length}名の死亡記録`, detail: '昨夜の不可逆な変化を年代記で確認してください。', target: 'chronicle' } });
  const endangered = report?.residentDeltas.find((entry) => entry.severity === 'critical' || entry.severity === 'severe' || entry.severity === 'new-condition');
  if (endangered && manualMedical?.agentId !== endangered.agentId) candidates.push({ rank: endangered.severity === 'critical' ? 950 : 900, issue: { id: `resident:${endangered.agentId}`, tone: endangered.severity === 'critical' ? 'critical' : 'warning', title: `${endangered.name} が${endangered.severity === 'critical' ? '重篤' : '要対応'}`, detail: endangered.summary, target: 'body', agentId: endangered.agentId } });
  if (input.campaign.waterDays < SURVIVAL_RESERVE_WARNING_DAYS || input.campaign.waterSafety < 55) candidates.push({ rank: 850, issue: { id: 'water-pressure', tone: input.campaign.waterDays < SURVIVAL_RESERVE_CRITICAL_DAYS || input.campaign.waterSafety < 55 ? 'critical' : 'warning', title: '水の継続性を確認', detail: `備蓄 ${input.campaign.waterDays.toFixed(1)}日 · 安全度 ${input.campaign.waterSafety.toFixed(0)}% · 担当 ${plannedWaterCoverage}名`, target: 'inventory' } });
  if (input.campaign.foodDays < SURVIVAL_RESERVE_WARNING_DAYS) candidates.push({ rank: 820, issue: { id: 'food-pressure', tone: input.campaign.foodDays < SURVIVAL_RESERVE_CRITICAL_DAYS ? 'critical' : 'warning', title: '食料備蓄を確認', detail: `備蓄 ${input.campaign.foodDays.toFixed(1)}日 · 担当 ${plannedFoodCoverage}名`, target: 'inventory' } });
  if (manualMedical) candidates.push({ rank: 780, issue: manualMedical });
  if (manualExpedition) candidates.push({ rank: 760, issue: manualExpedition });
  if (report?.expeditionUpdates[0]) candidates.push({ rank: 700, issue: { id: 'expedition-update', tone: 'warning', title: '遠征状況が更新されました', detail: report.expeditionUpdates[0], target: 'expedition' } });
  const planRisk = readinessIssues.find((entry) => entry.id !== 'manual-medical' && entry.id !== 'manual-expedition' && entry.id !== 'canonical-block');
  if (planRisk) candidates.push({ rank: 650, issue: planRisk });
  const directiveIssue: DailyCommandIssue = { id: `directive:${input.campaign.directive.id}`, tone: campaignTone(input.campaign.directive.severity), title: input.campaign.directive.title, detail: input.campaign.directive.detail, target: input.campaign.directive.target };
  if (!candidates.some(({ issue }) => issue.target === directiveIssue.target)) candidates.push({ rank: 100, issue: directiveIssue });
  const unique = new Map<string, DailyCommandIssue>();
  for (const { issue } of candidates.sort((a, b) => b.rank - a.rank || a.issue.id.localeCompare(b.issue.id))) if (!unique.has(issue.id)) unique.set(issue.id, issue);
  return [...unique.values()].slice(0, 3);
}

export function deriveDailyCommandView(input: DailyCommandInput): DailyCommandView {
  const residentRows = buildResidentRows(input);
  const crisisCoordination = coordinateCrisisStaffing(buildCrisisRecommendations(input, residentRows));
  const crisisCoverage = buildCrisisCoverage(crisisCoordination.recommendations);
  const crisisRecovery = crisisCoverage?.coveredCount === crisisCoverage?.totalCount
    ? buildCrisisRecovery(input, residentRows, crisisCoordination.recommendations)
    : undefined;
  const normalOpsBalance = buildNormalOpsBalance(residentRows, crisisCoordination.recommendations, crisisCoverage, crisisRecovery);
  const planBalance = buildPlanBalance(input, residentRows, crisisCoordination.recommendations);
  const planBalanceRecovery = buildPlanBalanceRecovery(input, residentRows, crisisCoordination.recommendations, crisisCoverage, crisisRecovery, planBalance);
  const restPressure = buildRestPressure(input, residentRows, crisisCoordination.recommendations, crisisCoverage, planBalanceRecovery, crisisRecovery);
  const restFollowUp = buildRestFollowUp(input, residentRows, crisisCoordination.recommendations);
  const restReleaseReview = buildRestReleaseReview(input, residentRows, crisisCoordination.recommendations);
  const readinessIssues = buildReadinessIssues(input, residentRows, crisisCoverage);
  const readiness: DailyPlanReadiness = input.canonicalBlockReason ? 'blocked' : readinessIssues.length ? 'risk' : 'ready';
  const longHorizon = buildLongHorizon(input, readiness, crisisCoordination.recommendations);
  return {
    priorities: buildPriorities(input, readinessIssues, residentRows),
    ...(longHorizon ? { longHorizon } : {}),
    outcomes: buildMorningOutcomes(input),
    resourceSummary: buildResourceSummary(input),
    residentRows,
    planImpact: buildPlanImpact(input, residentRows),
    crisisRecommendations: crisisCoordination.recommendations,
    crisisConflicts: crisisCoordination.conflicts,
    crisisBalanceAssignments: crisisCoordination.balanceAssignments,
    ...(crisisCoverage ? { crisisCoverage } : {}),
    ...(crisisCoordination.focusAssignment ? { crisisFocusAssignment: crisisCoordination.focusAssignment } : {}),
    ...(crisisRecovery ? { crisisRecovery } : {}),
    ...(normalOpsBalance ? { normalOpsBalance } : {}),
    ...(planBalance ? { planBalance } : {}),
    ...(planBalanceRecovery ? { planBalanceRecovery } : {}),
    ...(restPressure ? { restPressure } : {}),
    ...(restFollowUp ? { restFollowUp } : {}),
    ...(restReleaseReview ? { restReleaseReview } : {}),
    readiness,
    readinessIssues,
  };
}

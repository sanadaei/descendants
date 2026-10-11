import { addChronicle, agentAgeYears, findAgent, livingAgents, settlementAgents } from './stateUtils.js';
import { synthesizeVisibleSituations } from './situationSynthesis.js';
import type {
  SandboxGameState,
  SurvivalCampaignDirective,
  SurvivalCampaignMilestoneId,
  SurvivalCampaignMilestoneView,
  SurvivalCampaignPhase,
  SurvivalCampaignStateV2,
  SurvivalCampaignView,
} from './types.js';

export const SURVIVAL_RESERVE_CRITICAL_DAYS = 1.5;
export const SURVIVAL_RESERVE_WARNING_DAYS = 3;

const DAYS_PER_YEAR = 365;
const CURRENT_SCHEMA_VERSION = 2 as const;
const INTERNAL_DEFAULT_STRATEGIC_ADVANCE_DAYS = 7 as const;

type LegacyCampaignStateV1 = {
  schemaVersion: 1;
  startDay: number;
  targetDay?: number;
  foundingAgentIds: string[];
  completedMilestoneIds: Array<SurvivalCampaignMilestoneId | 'endure'>;
  phase: SurvivalCampaignPhase | 'endure' | 'won' | 'lost';
  lastEvaluatedDay: number;
  strategicAdvanceDays: 1 | 7 | 30;
  outcome?: unknown;
};

function migratedPhase(legacy: LegacyCampaignStateV1): SurvivalCampaignPhase {
  if (legacy.phase === 'won' || legacy.phase === 'lost' || legacy.phase === 'endure') return 'continuity';
  return legacy.phase;
}

export function ensureSurvivalCampaignState(state: SandboxGameState): SurvivalCampaignStateV2 {
  const existing = state.campaign as SurvivalCampaignStateV2 | LegacyCampaignStateV1 | undefined;
  if (existing?.schemaVersion === CURRENT_SCHEMA_VERSION) return existing;
  if (existing?.schemaVersion === 1) {
    const migrated: SurvivalCampaignStateV2 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      startDay: existing.startDay,
      foundingAgentIds: [...existing.foundingAgentIds],
      completedMilestoneIds: existing.completedMilestoneIds.filter((id): id is SurvivalCampaignMilestoneId => id !== 'endure'),
      phase: migratedPhase(existing),
      lastEvaluatedDay: existing.lastEvaluatedDay,
      strategicAdvanceDays: existing.strategicAdvanceDays,
    };
    state.campaign = migrated;
    return migrated;
  }
  const foundingAgentIds = livingAgents(state).map((agent) => agent.id);
  state.campaign = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    startDay: state.clock.day,
    foundingAgentIds,
    completedMilestoneIds: [],
    phase: 'stabilize',
    lastEvaluatedDay: state.clock.day,
    strategicAdvanceDays: INTERNAL_DEFAULT_STRATEGIC_ADVANCE_DAYS,
  };
  return state.campaign;
}

export function generationDepth(state: SandboxGameState, agentId: string): number {
  const cache = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = cache.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    const agent = findAgent(state, id);
    if (!agent || agent.parentIds.length === 0) return 0;
    visiting.add(id);
    const parents = agent.parentIds.map((parentId) => findAgent(state, parentId)).filter((parent): parent is NonNullable<typeof parent> => Boolean(parent));
    const depth = parents.length ? 1 + Math.max(...parents.map((parent) => visit(parent.id))) : 0;
    visiting.delete(id);
    cache.set(id, depth);
    return depth;
  };
  return visit(agentId);
}

function dailyNeeds(state: SandboxGameState): { food: number; water: number } {
  const locals = settlementAgents(state);
  let adults = 0;
  let children = 0;
  for (const agent of locals) {
    if (agentAgeYears(state, agent) < 13) children += 1;
    else adults += 1;
  }
  return {
    food: adults * 1.8 + children * 1.05,
    water: adults * 2.5 + children * 1.65,
  };
}

function reserveDays(stock: number, need: number): number {
  if (need <= 0) return stock > 0 ? Number.POSITIVE_INFINITY : 0;
  return Math.max(0, stock) / need;
}

function activeExpeditionCount(state: SandboxGameState): number {
  return state.expeditions.filter((entry) => !['returned', 'destroyed', 'joined-elsewhere'].includes(entry.status)).length;
}

function campaignBornAgents(state: SandboxGameState, campaign: SurvivalCampaignStateV2) {
  const founders = new Set(campaign.foundingAgentIds);
  return state.agents.filter((agent) => !founders.has(agent.id) && agent.bornDay >= campaign.startDay && agent.identityOrigin === 'lived-game-state');
}

function stableSettlement(view: Pick<SurvivalCampaignView, 'foodDays' | 'waterDays' | 'waterSafety' | 'sanitation' | 'averageHealth'>, severeCases: number): boolean {
  return view.foodDays >= 5 && view.waterDays >= 5 && view.waterSafety >= 60 && view.sanitation >= 50 && view.averageHealth >= 60 && severeCases === 0;
}

function milestoneRows(stable: boolean, returned: number, archivedRecords: number, descendants: number): SurvivalCampaignMilestoneView[] {
  return [
    { id: 'stabilize', label: 'STABILIZE', detail: 'Maintain five days of food/water reserve, safe water, sanitation and basic health.', complete: stable },
    { id: 'explore', label: 'EXPLORE', detail: 'Complete at least one expedition and bring the party home.', complete: returned > 0 },
    { id: 'preserve', label: 'PRESERVE', detail: 'Create at least one durable social/archive record.', complete: archivedRecords > 0 },
    { id: 'generation', label: 'NEXT GENERATION', detail: 'Keep at least one person born during play alive.', complete: descendants > 0 },
  ];
}

function phaseFromMilestones(milestones: SurvivalCampaignMilestoneView[]): SurvivalCampaignPhase {
  if (!milestones.find((entry) => entry.id === 'stabilize')?.complete) return 'stabilize';
  if (!milestones.find((entry) => entry.id === 'explore')?.complete) return 'explore';
  if (!milestones.find((entry) => entry.id === 'preserve')?.complete) return 'preserve';
  if (!milestones.find((entry) => entry.id === 'generation')?.complete) return 'generation';
  return 'continuity';
}

function healthPressure(state: SandboxGameState): { severeCases: number; activeCases: number } {
  let severeCases = 0;
  let activeCases = 0;
  for (const agent of settlementAgents(state)) {
    for (const pathology of agent.pathology) {
      if (pathology.status !== 'active' && pathology.status !== 'chronic') continue;
      activeCases += 1;
      if (pathology.severity >= 55) severeCases += 1;
    }
  }
  return { severeCases, activeCases };
}

function chooseDirective(
  state: SandboxGameState,
  metrics: {
    foodDays: number; waterDays: number; waterSafety: number; averageHealth: number; severeCases: number;
    returnedExpeditions: number; archivedRecords: number; livingDescendants: number;
  },
): SurvivalCampaignDirective {
  if (metrics.waterDays < SURVIVAL_RESERVE_WARNING_DAYS || state.settlement.waterSafety < 55) {
    return {
      id: 'secure-water', severity: metrics.waterDays < SURVIVAL_RESERVE_CRITICAL_DAYS ? 'critical' : 'urgent', title: '水を確保する',
      detail: `現在の水備蓄は約${metrics.waterDays.toFixed(1)}日分、水安全度は${state.settlement.waterSafety.toFixed(0)}。水担当と衛生を優先し、必要なら探索先を探してください。`,
      target: 'task', basisIds: [state.settlement.id],
    };
  }
  if (metrics.foodDays < SURVIVAL_RESERVE_WARNING_DAYS) {
    return {
      id: 'secure-food', severity: metrics.foodDays < SURVIVAL_RESERVE_CRITICAL_DAYS ? 'critical' : 'urgent', title: '食料備蓄を回復する',
      detail: `現在の食料備蓄は約${metrics.foodDays.toFixed(1)}日分です。採集・労働配分・遠征の負担を見直してください。`,
      target: 'inventory', basisIds: [state.settlement.id],
    };
  }
  if (metrics.severeCases > 0 || metrics.averageHealth < 65) {
    return {
      id: 'treat-health-pressure', severity: metrics.severeCases > 0 ? 'urgent' : 'watch', title: '住民の健康を立て直す',
      detail: `平均体力 ${metrics.averageHealth.toFixed(0)}。重症記録 ${metrics.severeCases}件。F2で患者を確認し、診療と休養を優先してください。`,
      target: 'body', basisIds: settlementAgents(state).flatMap((agent) => agent.pathology.filter((entry) => entry.status === 'active' || entry.status === 'chronic').map(() => agent.id)),
    };
  }
  const situation = synthesizeVisibleSituations(state).find((entry) => entry.severity === 'urgent' && !['settlement:water-low', 'settlement:food-low', 'settlement:pathology', 'settlement:injury'].includes(entry.id));
  if (situation) {
    return { id: `respond:${situation.id}`, severity: 'urgent', title: situation.title, detail: situation.detail, target: 'task', basisIds: [...situation.basisIds] };
  }
  if (metrics.returnedExpeditions === 0) {
    return {
      id: 'complete-first-expedition', severity: 'watch', title: '最初の遠征を完遂する',
      detail: 'WORLDで既知地点を選び、隊員と物資を準備して出発し、観察結果を持って集落へ帰還してください。',
      target: 'expedition', basisIds: [state.world.originEntityId],
    };
  }
  if (metrics.archivedRecords === 0) {
    return {
      id: 'preserve-record', severity: 'watch', title: '知識を記録として残す',
      detail: 'F3で個人・口承知識を確認し、集落のArchiveへ保存してください。人が死んでも情報が残る仕組みを作ります。',
      target: 'knowledge', basisIds: state.settlement.localKnowledgeIds.slice(0, 4),
    };
  }
  if (metrics.livingDescendants === 0) {
    return {
      id: 'establish-next-generation', severity: 'info', title: '次世代が育つ余地を守る',
      detail: '食料・水・住居・医療を安定させ、1日ずつ時間を進めて出生と成長を支えてください。次世代は既存の人口simulationから生まれます。',
      target: 'body', basisIds: [state.settlement.id],
    };
  }
  return {
    id: 'sustain-community', severity: 'info', title: '今日の共同体を維持する',
    detail: 'ゴール年や勝敗判定はありません。資源、健康、探索、知識、外部関係を確認し、次の1日をどう過ごすか決めてください。',
    target: 'task', basisIds: [state.settlement.id],
  };
}

export function deriveSurvivalCampaignView(state: SandboxGameState): SurvivalCampaignView {
  const campaign = ensureSurvivalCampaignState(state);
  const locals = settlementAgents(state);
  const living = livingAgents(state);
  const needs = dailyNeeds(state);
  const foodDays = reserveDays(state.settlement.resources.food, needs.food);
  const waterDays = reserveDays(state.settlement.resources.water, needs.water);
  const campaignBorn = campaignBornAgents(state, campaign);
  const livingDescendants = campaignBorn.filter((agent) => agent.alive).length;
  const birthsSinceStart = campaignBorn.length;
  const deepestGeneration = living.length ? Math.max(...living.map((agent) => generationDepth(state, agent.id))) : 0;
  const returnedExpeditions = state.expeditions.filter((entry) => entry.status === 'returned').length;
  const activeExpeditions = activeExpeditionCount(state);
  const archivedRecords = state.records.filter((record) => record.copies > 0 && record.integrity > 0.05).length;
  const institutionalKnowledge = state.settlement.localKnowledgeIds.filter((id) => state.knowledge.some((entry) => entry.id === id && !entry.lost)).length;
  const averageHealth = locals.length ? locals.reduce((sum, agent) => sum + agent.health, 0) / locals.length : 0;
  const { severeCases } = healthPressure(state);
  const elapsedDays = Math.max(0, state.clock.day - campaign.startDay);
  const baseForStability = { foodDays, waterDays, waterSafety: state.settlement.waterSafety, sanitation: state.settlement.sanitation, averageHealth };
  const stable = stableSettlement(baseForStability, severeCases);
  const earnedMilestones = new Set(campaign.completedMilestoneIds);
  const milestones = milestoneRows(stable, returnedExpeditions, archivedRecords, livingDescendants)
    .map((entry) => ({ ...entry, complete: entry.complete || earnedMilestones.has(entry.id) }));
  const phase = phaseFromMilestones(milestones);
  const directive = chooseDirective(state, { foodDays, waterDays, waterSafety: state.settlement.waterSafety, averageHealth, severeCases, returnedExpeditions, archivedRecords, livingDescendants });
  return {
    phase,
    briefing: {
      title: 'DAILY CONTINUITY',
      premise: `${state.settlement.name} は終点のない共同体です。世界は1日ずつ進み、資源・健康・関係・遠征の結果が翌日へ残ります。`,
      objective: '日々の生存と探索を両立し、記録と次世代を積み重ねてください。勝敗や期限はありません。',
    },
    startDay: campaign.startDay,
    currentYear: Math.max(1, Math.floor(elapsedDays / DAYS_PER_YEAR) + 1),
    elapsedDays,
    localPopulation: locals.length,
    livingPopulation: living.length,
    birthsSinceStart,
    livingDescendants,
    deepestGeneration,
    generationLabel: deepestGeneration === 0 ? 'FOUNDERS' : `GENERATION ${deepestGeneration + 1} PRESENT`,
    foodDays,
    waterDays,
    waterSafety: state.settlement.waterSafety,
    sanitation: state.settlement.sanitation,
    averageHealth,
    returnedExpeditions,
    activeExpeditions,
    archivedRecords,
    institutionalKnowledge,
    directive,
    milestones,
  };
}

export function evaluateSurvivalCampaign(state: SandboxGameState): SurvivalCampaignView {
  const campaign = ensureSurvivalCampaignState(state);
  let view = deriveSurvivalCampaignView(state);
  campaign.lastEvaluatedDay = state.clock.day;

  const previouslyCompleted = new Set(campaign.completedMilestoneIds);
  const completed = view.milestones.filter((entry) => entry.complete).map((entry) => entry.id);
  campaign.completedMilestoneIds = [...new Set([...campaign.completedMilestoneIds, ...completed])] as SurvivalCampaignMilestoneId[];
  for (const milestone of view.milestones) {
    if (!milestone.complete || previouslyCompleted.has(milestone.id)) continue;
    addChronicle(state, {
      kind: 'settlement',
      title: `Continuity milestone: ${milestone.label}`,
      text: milestone.detail,
      entityIds: [state.settlement.id],
    });
  }

  view = deriveSurvivalCampaignView(state);
  campaign.phase = view.phase;
  return view;
}

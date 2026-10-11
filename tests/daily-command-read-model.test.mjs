import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { ensureDailyLoopState, setDailyAssignment, setExecutionPolicy } from '../.test-dist/sandbox/dailyActionLoop.js';
import { deriveSurvivalCampaignView } from '../.test-dist/sandbox/survivalCampaign.js';
import { deriveDailyCommandView } from '../.test-dist/sandbox/dailyCommandReadModel.js';
import * as dailyCommandReadModel from '../.test-dist/sandbox/dailyCommandReadModel.js';

async function fixture(seed = 95001) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed });
  const loop = ensureDailyLoopState(state);
  const campaign = deriveSurvivalCampaignView(state);
  return { state, loop, campaign };
}

function viewOf(state, loop, campaign, canonicalBlockReason) {
  return deriveDailyCommandView({
    state,
    plan: loop.currentPlan,
    report: loop.lastMorningReport,
    campaign,
    ...(canonicalBlockReason ? { canonicalBlockReason } : {}),
  });
}

test('daily command model is deterministic, pure, and bounds priorities to three', async () => {
  const { state, loop } = await fixture(95001);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(resident);
  resident.health = 20;
  resident.needs.thirst = 90;
  state.settlement.resources.water = 0.1;
  state.settlement.resources.food = 0.1;
  const currentCampaign = deriveSurvivalCampaignView(state);
  const before = structuredClone(state);
  const first = viewOf(state, loop, currentCampaign);
  const second = viewOf(state, loop, currentCampaign);
  assert.deepEqual(first, second);
  assert.deepEqual(state, before);
  assert.ok(first.priorities.length <= 3);
});

test('critical resident appears ahead of routine campaign continuity', async () => {
  const { state, loop } = await fixture(95002);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(resident);
  resident.health = 18;
  resident.pathology.push({
    id: 'case:command-critical', pathologyId: 'test-fever', onsetDay: state.clock.day,
    severity: 82, contagious: true, observedSymptoms: ['high fever'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [{
      agentId: resident.id, name: resident.name, severity: 'critical', severityScore: 900,
      summary: '体力が危険域', healthBefore: 60, healthAfter: 18, healthDelta: -42,
      fatigueDelta: 5, moraleDelta: -3, hungerAfter: 20, thirstAfter: 90,
      newPathologyIds: ['test-fever'], activePathologyIds: ['test-fever'],
      task: resident.currentTask, residence: 'settlement', expeditionId: null,
      recommendedResponse: '至急診療',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(view.priorities[0]?.target, 'body');
  assert.equal(view.priorities[0]?.agentId, resident.id);
  assert.match(view.priorities[0]?.title ?? '', /重篤|危険/);
});

test('food and water reserve facts create visible summary pressure using shared thresholds', async () => {
  const { state, loop } = await fixture(95003);
  state.settlement.resources.food = 0;
  state.settlement.resources.water = 0;
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.resourceSummary.find((entry) => entry.id === 'food');
  const water = view.resourceSummary.find((entry) => entry.id === 'water');
  assert.equal(food?.tone, 'critical');
  assert.equal(water?.tone, 'critical');
  assert.ok(view.priorities.some((entry) => /食料|水/.test(entry.title)));
  const waterPriority = view.priorities.find((entry) => entry.id === 'water-pressure');
  const foodPriority = view.priorities.find((entry) => entry.id === 'food-pressure');
  assert.match(waterPriority?.detail ?? '', /担当 \d+名/);
  assert.match(foodPriority?.detail ?? '', /担当 \d+名/);
});

test('manual interruption and unsafe strenuous labor are RISK but never BLOCKED', async () => {
  const { state, loop } = await fixture(95004);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(resident);
  resident.health = 30;
  resident.pathology.push({
    id: 'case:readiness', pathologyId: 'infection', onsetDay: state.clock.day,
    severity: 70, contagious: false, observedSymptoms: ['fever'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  setDailyAssignment(state, resident.id, 'forage');
  setExecutionPolicy(state, 'medical', 'manual');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(view.readiness, 'risk');
  assert.ok(view.readinessIssues.length >= 1);
  assert.notEqual(view.readiness, 'blocked');
});

test('canonical block reason is the only source of BLOCKED', async () => {
  const { state, loop, campaign } = await fixture(95005);
  const normal = viewOf(state, loop, campaign);
  assert.notEqual(normal.readiness, 'blocked');
  const blocked = viewOf(state, loop, campaign, 'WEDO is active. Resolve the direct encounter before executing the settlement plan.');
  assert.equal(blocked.readiness, 'blocked');
  assert.equal(blocked.readinessIssues[0]?.id, 'canonical-block');
});

test('resident rows expose prior task, current assignment, eligibility and concise risk text', async () => {
  const { state, loop } = await fixture(95006);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 35;
  setDailyAssignment(state, adult.id, 'guard');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const row = view.residentRows.find((entry) => entry.agentId === adult.id);
  assert.equal(row?.assignedTask, 'guard');
  assert.equal(typeof row?.previousTask, 'string');
  assert.match(row?.condition ?? '', /HP/);
  assert.ok(row?.riskNote);
});

test('manual medical decision collapses duplicate resident and generic body priorities', async () => {
  const { state, loop } = await fixture(95007);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(resident);
  resident.health = 20;
  resident.pathology.push({
    id: 'case:manual-priority', pathologyId: 'infection', onsetDay: state.clock.day,
    severity: 80, contagious: false, observedSymptoms: ['fever'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [{
      agentId: resident.id, name: resident.name, severity: 'critical', severityScore: 950,
      summary: '体力が危険域', healthBefore: 60, healthAfter: 20, healthDelta: -40,
      fatigueDelta: 2, moraleDelta: -2, hungerAfter: 20, thirstAfter: 20,
      newPathologyIds: ['infection'], activePathologyIds: ['infection'],
      task: resident.currentTask, residence: 'settlement', expeditionId: null,
      recommendedResponse: '至急診療',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setExecutionPolicy(state, 'medical', 'manual');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const bodyPriorities = view.priorities.filter((entry) => entry.target === 'body');
  assert.equal(bodyPriorities.length, 1);
  assert.equal(bodyPriorities[0]?.id, 'manual-medical');
  assert.equal(bodyPriorities[0]?.agentId, resident.id);
});

test('labor task presentation labels localize every canonical task without changing task ids', async () => {
  const module = await import('../.test-dist/sandbox/dailyCommandReadModel.js');
  assert.equal(typeof module.laborTaskDisplayName, 'function');
  const expected = {
    forage: '採集', water: '給水', medicine: '医療', repair: '修繕', sanitation: '衛生',
    care: '介護', records: '記録', guard: '警備', rest: '休養', 'explore-prep': '遠征準備',
  };
  for (const [task, label] of Object.entries(expected)) assert.equal(module.laborTaskDisplayName(task), label);
  assert.equal(module.laborTaskDisplayName('unknown-task'), 'unknown-task');
});

test('morning outcomes compress irreversible, health, and resource consequences to three items', async () => {
  const { state, loop } = await fixture(95008);
  const residents = state.agents.filter((agent) => agent.alive && !agent.expeditionId).slice(0, 2);
  assert.equal(residents.length, 2);
  loop.lastMorningReport = {
    day: Math.max(2, state.clock.day), minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [
      {
        agentId: residents[0].id, name: residents[0].name, severity: 'worsened', severityScore: 400,
        summary: '体力が低下', healthBefore: 80, healthAfter: 62, healthDelta: -18,
        fatigueDelta: 12, moraleDelta: -2, hungerAfter: 35, thirstAfter: 31,
        newPathologyIds: [], activePathologyIds: [], task: residents[0].currentTask,
        residence: 'settlement', expeditionId: null, recommendedResponse: '休養を検討',
      },
      {
        agentId: residents[1].id, name: residents[1].name, severity: 'improved', severityScore: 120,
        summary: '体力が回復', healthBefore: 50, healthAfter: 66, healthDelta: 16,
        fatigueDelta: -10, moraleDelta: 1, hungerAfter: 25, thirstAfter: 22,
        newPathologyIds: [], activePathologyIds: [], task: residents[1].currentTask,
        residence: 'settlement', expeditionId: null, recommendedResponse: '経過観察',
      },
    ],
    resourceDeltas: { food: -4.5, water: 2.25 },
    expeditionUpdates: ['Scout team returned with route notes.'],
    settlementUpdates: ['Rain catchers repaired.'],
    births: ['Newborn A'], deaths: ['Resident Z'],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.ok(Array.isArray(view.outcomes));
  assert.equal(view.outcomes.length, 3);
  assert.equal(view.outcomes[0]?.id, 'outcome-population');
  assert.equal(view.outcomes[0]?.tone, 'critical');
  assert.match(view.outcomes[0]?.detail ?? '', /死亡 1/);
  assert.equal(view.outcomes.find((entry) => entry.id === 'outcome-health')?.title, '住民状態の変化');
  assert.ok(view.outcomes.some((entry) => entry.id === 'outcome-resources'));
  assert.ok(view.outcomes.every((entry) => entry.title && entry.detail));
});

test('day without meaningful prior changes exposes no synthetic outcome cards', async () => {
  const { state, loop, campaign } = await fixture(95009);
  loop.lastMorningReport = {
    day: 1, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [], resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, campaign);
  assert.deepEqual(view.outcomes, []);
});


test('plan impact appears only after an assignment change and reports the changed resident count', async () => {
  const { state, loop, campaign } = await fixture(95010);
  const before = viewOf(state, loop, campaign);
  assert.deepEqual(before.planImpact, []);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(resident);
  const replacement = resident.currentTask === 'records' ? 'rest' : 'records';
  setDailyAssignment(state, resident.id, replacement);
  const after = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(after.planImpact[0]?.id, 'assignment-changes');
  assert.match(after.planImpact[0]?.detail ?? '', /1名/);
  assert.match(after.planImpact[0]?.detail ?? '', /未実行/);
});

test('water crisis impact shows whether planned water coverage improves or worsens', async () => {
  const { state, loop } = await fixture(95011);
  const residents = state.agents.filter((agent) => agent.alive && !agent.expeditionId);
  for (const resident of residents) resident.currentTask = 'records';
  loop.currentPlan.assignments = [];
  state.settlement.resources.water = 0;
  const adult = residents.find((agent) => agent.role !== 'child');
  assert.ok(adult);
  setDailyAssignment(state, adult.id, 'water');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const water = view.planImpact.find((entry) => entry.id === 'water-coverage');
  assert.equal(water?.tone, 'normal');
  assert.match(water?.detail ?? '', /0→1名/);
});

test('plan impact flags newly introduced hazardous placements without simulating resource yields', async () => {
  const { state, loop } = await fixture(95012);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(resident);
  resident.health = 30;
  resident.currentTask = 'rest';
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, resident.id, 'guard');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const risk = view.planImpact.find((entry) => entry.id === 'hazardous-placement');
  assert.equal(risk?.tone, 'warning');
  assert.match(risk?.detail ?? '', /0→1名/);
  assert.ok(view.planImpact.every((entry) => !/予測収量|expected yield|kg/.test(entry.detail)));
});


test('next-morning transition summary compresses concrete report consequences only', async () => {
  const module = await import('../.test-dist/sandbox/dailyCommandReadModel.js');
  assert.equal(typeof module.morningReportTransitionSummary, 'function');
  const report = {
    day: 2, minuteOfDay: 360,
    residentDeltas: [{
      agentId: 'a', name: 'A', severity: 'severe', severityScore: 800,
      summary: '悪化', healthBefore: 70, healthAfter: 40, healthDelta: -30,
      fatigueDelta: 10, moraleDelta: -2, hungerAfter: 30, thirstAfter: 30,
      newPathologyIds: [], activePathologyIds: [], task: 'rest', residence: 'settlement', expeditionId: null,
      recommendedResponse: '休養',
    }],
    resourceDeltas: { food: -4.5, water: 2.25 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: ['z'],
  };
  const summary = module.morningReportTransitionSummary(report);
  assert.match(summary, /死亡 1/);
  assert.match(summary, /要対応 1名/);
  assert.match(summary, /食料 -4\.5/);
  assert.doesNotMatch(summary, /undefined|NaN/);
});


test('morning outcomes read back observed rest recovery and keep pressure visible when fatigue remains high', async () => {
  const { state, loop } = await fixture(95056);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 76;
  adult.fatigue = 49;
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'rested',
      healthBefore: 73, healthAfter: 76, healthDelta: 3, fatigueDelta: -18, moraleDelta: 2,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const recovery = view.outcomes.find((entry) => entry.id === 'outcome-rest-recovery');
  assert.ok(recovery);
  assert.equal(recovery.tone, 'warning');
  assert.equal(recovery.title, '休養の実測変化');
  assert.match(recovery.detail, /休養/);
  assert.match(recovery.detail, /疲労 -18/);
  assert.match(recovery.detail, /今朝 49/);
  assert.match(recovery.detail, /HP \+3/);
  assert.match(recovery.detail, /今朝 76/);
});

test('rest recovery readback becomes normal once current fatigue and health leave the existing pressure threshold', async () => {
  const { state, loop } = await fixture(95057);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 82;
  adult.fatigue = 30;
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'recovered',
      healthBefore: 79, healthAfter: 82, healthDelta: 3, fatigueDelta: -22, moraleDelta: 2,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const recovery = view.outcomes.find((entry) => entry.id === 'outcome-rest-recovery');
  assert.ok(recovery);
  assert.equal(recovery.tone, 'normal');
});


test('rest release review appears only for recovered residents who are still resting', async () => {
  const { state, loop } = await fixture(95058);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 84;
  adult.fatigue = 28;
  adult.currentTask = 'rest';
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adult.id, 'rest');
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'improved', severityScore: 0, summary: 'recovered',
      healthBefore: 78, healthAfter: 84, healthDelta: 6, fatigueDelta: -24, moraleDelta: 2,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'resume when ready',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(view.restFollowUp, undefined);
  assert.equal(view.restReleaseReview?.candidateCount, 1);
  assert.equal(view.restReleaseReview?.candidates[0]?.agentId, adult.id);
  assert.equal(view.restReleaseReview?.candidates[0]?.assignedTask, 'rest');
  assert.match(view.restReleaseReview?.candidates[0]?.detail ?? '', /疲労 28/);
  assert.match(view.restReleaseReview?.candidates[0]?.detail ?? '', /HP 84/);
  assert.match(view.restReleaseReview?.detail ?? '', /復帰先はToday/);
});


test('rest release review lists safe normal-op gaps as comparison context without choosing a task', async () => {
  const { state, loop } = await fixture(95060);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.equal(adults.length, 3);
  const [recovered, worker, clerk] = adults;
  recovered.health = 88;
  recovered.fatigue = 24;
  recovered.pathology = [];
  recovered.currentTask = 'rest';
  worker.health = 90;
  worker.fatigue = 20;
  worker.pathology = [];
  worker.currentTask = 'repair';
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, recovered.id, 'rest');
  setDailyAssignment(state, worker.id, 'records');
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [
      {
        agentId: recovered.id, name: recovered.name, severity: 'improved', severityScore: 0, summary: 'recovered',
        healthBefore: 82, healthAfter: 88, healthDelta: 6, fatigueDelta: -22, moraleDelta: 2,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'resume when ready',
      },
      {
        agentId: worker.id, name: worker.name, severity: 'stable', severityScore: 0, summary: 'stable',
        healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 2, moraleDelta: 0,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'repair', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
      },
    ],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 8, waterSafety: 90 });
  const candidate = view.restReleaseReview?.candidates.find((entry) => entry.agentId === recovered.id);
  assert.ok(candidate);
  assert.equal(candidate.taskContexts?.[0]?.task, 'repair');
  assert.equal(candidate.taskContexts?.[0]?.previousCount, 1);
  assert.equal(candidate.taskContexts?.[0]?.assignedCount, 0);
  assert.match(candidate.taskContexts?.[0]?.detail ?? '', /修繕 1→0/);
  assert.equal(candidate.assignedTask, 'rest');
});

test('return context previews deterministic staffing effect and visible suitability without predicting output', async () => {
  const { state, loop } = await fixture(95061);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 2);
  assert.equal(adults.length, 2);
  const [recovered, worker] = adults;
  recovered.health = 90;
  recovered.fatigue = 22;
  recovered.pathology = [];
  recovered.role = 'builder';
  recovered.skills.construction = 73;
  worker.health = 90;
  worker.fatigue = 20;
  worker.pathology = [];
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, recovered.id, 'rest');
  setDailyAssignment(state, worker.id, 'records');
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [
      {
        agentId: recovered.id, name: recovered.name, severity: 'improved', severityScore: 0, summary: 'recovered',
        healthBefore: 84, healthAfter: 90, healthDelta: 6, fatigueDelta: -24, moraleDelta: 2,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'resume when ready',
      },
      {
        agentId: worker.id, name: worker.name, severity: 'stable', severityScore: 0, summary: 'stable',
        healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 2, moraleDelta: 0,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'repair', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
      },
    ],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 8, waterSafety: 90 });
  const context = view.restReleaseReview?.candidates.find((entry) => entry.agentId === recovered.id)?.taskContexts[0];
  assert.ok(context);
  assert.equal(context.task, 'repair');
  assert.equal(context.afterAssignedCount, 1);
  const plannedRestCount = view.residentRows.filter((row) => !row.locked && row.assignedTask === 'rest').length;
  assert.equal(context.restAssignedCount, plannedRestCount);
  assert.equal(context.restAfterCount, Math.max(0, plannedRestCount - 1));
  assert.equal(context.skillLabel, '建築');
  assert.equal(context.skillValue, 73);
  assert.equal(context.roleMatch, true);
  assert.match(context.effectDetail, /選択後 修繕 1\/1/);
  assert.match(context.effectDetail, new RegExp(`休養 ${plannedRestCount}→${Math.max(0, plannedRestCount - 1)}`));
  assert.match(context.fitDetail, /役割一致/);
  assert.match(context.fitDetail, /建築 73/);
  assert.doesNotMatch(context.effectDetail + context.fitDetail, /収量|成功率|予測/);
});

test('return context previews the post-selection PLAN BALANCE without predicting outcomes', async () => {
  const { state, loop } = await fixture(95062);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.equal(adults.length, 3);
  const [recovered, worker, clerk] = adults;
  recovered.health = 92;
  recovered.fatigue = 18;
  recovered.pathology = [];
  recovered.role = 'builder';
  recovered.skills.construction = 75;
  worker.health = 90;
  worker.fatigue = 20;
  worker.pathology = [];
  clerk.health = 90;
  clerk.fatigue = 18;
  clerk.pathology = [];
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, recovered.id, 'rest');
  setDailyAssignment(state, worker.id, 'rest');
  setDailyAssignment(state, clerk.id, 'records');
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [
      {
        agentId: recovered.id, name: recovered.name, severity: 'improved', severityScore: 0, summary: 'recovered',
        healthBefore: 84, healthAfter: 92, healthDelta: 8, fatigueDelta: -26, moraleDelta: 2,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'resume when ready',
      },
      {
        agentId: worker.id, name: worker.name, severity: 'stable', severityScore: 0, summary: 'stable',
        healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 2, moraleDelta: 0,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'repair', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
      },
      {
        agentId: clerk.id, name: clerk.name, severity: 'stable', severityScore: 0, summary: 'stable',
        healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 1, moraleDelta: 0,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
      },
    ],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 8, waterSafety: 90 });
  const context = view.restReleaseReview?.candidates.find((entry) => entry.agentId === recovered.id)?.taskContexts[0];
  assert.ok(context);
  assert.equal(context.task, 'repair');
  assert.match(context.balanceEffectDetail ?? '', /PLAN BALANCE/);
  assert.match(context.balanceEffectDetail ?? '', /平常業務 -1→±0/);
  assert.match(context.balanceEffectDetail ?? '', /休養 \+1→±0/);
  assert.equal(context.balanceDirection, 'closer');
  assert.doesNotMatch(context.balanceEffectDetail ?? '', /収量|成功率|予測/);
});

test('rest release review disappears after a recovered resident has already returned to non-rest work', async () => {
  const { state, loop } = await fixture(95059);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 86;
  adult.fatigue = 26;
  adult.currentTask = 'rest';
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adult.id, 'records');
  loop.lastMorningReport = {
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'improved', severityScore: 0, summary: 'recovered',
      healthBefore: 80, healthAfter: 86, healthDelta: 6, fatigueDelta: -20, moraleDelta: 2,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'resume when ready',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(view.restReleaseReview, undefined);
});

test('food crisis exposes safe visible-skill responders without predicting outcomes', async () => {
  const { state, loop } = await fixture(95013);
  state.settlement.resources.food = 0;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.equal(adults.length, 3);
  for (const [index, agent] of adults.entries()) {
    agent.currentTask = 'records';
    agent.health = 90;
    agent.fatigue = 20 + index;
    agent.skills.foraging = 35 + index * 20;
  }
  loop.currentPlan.assignments = [];
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.id === 'food-forage');
  assert.ok(food);
  assert.equal(food.task, 'forage');
  assert.ok(food.candidates.length > 0 && food.candidates.length <= 3);
  assert.equal(food.candidates[0]?.agentId, adults[2].id);
  assert.match(food.candidates[0]?.detail ?? '', /採集|foraging|HP|FAT/);
  assert.doesNotMatch(food.candidates[0]?.detail ?? '', /予測|yield|kg/);
});

test('crisis responder candidates expose comparable visible reasons without hidden outcome scoring', async () => {
  const { state, loop } = await fixture(95016);
  state.settlement.resources.food = 0;
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.role = 'forager';
  adult.health = 88;
  adult.fatigue = 17;
  adult.skills.foraging = 73;
  adult.currentTask = 'records';
  loop.currentPlan.assignments = [];
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.id === 'food-forage');
  assert.ok(food);
  const candidate = food.candidates.find((entry) => entry.agentId === adult.id);
  assert.ok(candidate);
  assert.ok(candidate.reasons.some((reason) => /役割一致/.test(reason)));
  assert.ok(candidate.reasons.some((reason) => /採集 73/.test(reason)));
  assert.ok(candidate.reasons.some((reason) => /疲労 17/.test(reason)));
  assert.ok(candidate.reasons.some((reason) => /HP 88/.test(reason)));
  assert.doesNotMatch(candidate.reasons.join(' '), /予測|yield|生存率|score/i);
});

test('morning outcomes connect prior response assignments to observed resource deltas without claiming causality', async () => {
  const { state, loop } = await fixture(95017);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.ok(adults.length >= 3);
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: [
      { agentId: adults[0].id, name: adults[0].name, severity: 'stable', severityScore: 0, summary: 'stable', healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0, hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [], task: 'forage', residence: 'settlement', expeditionId: null, recommendedResponse: 'none' },
      { agentId: adults[1].id, name: adults[1].name, severity: 'stable', severityScore: 0, summary: 'stable', healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0, hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [], task: 'water', residence: 'settlement', expeditionId: null, recommendedResponse: 'none' },
      { agentId: adults[2].id, name: adults[2].name, severity: 'stable', severityScore: 0, summary: 'stable', healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0, hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [], task: 'sanitation', residence: 'settlement', expeditionId: null, recommendedResponse: 'none' },
    ],
    resourceDeltas: { food: 12.5, water: 8.25 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const response = view.outcomes.find((entry) => entry.id === 'outcome-response-log');
  assert.ok(response);
  assert.match(response.title, /対応|配置/);
  assert.match(response.detail, /採集 1名/);
  assert.match(response.detail, /給水 1名/);
  assert.match(response.detail, /衛生 1名/);
  assert.match(response.detail, /食料 \+12\.5/);
  assert.match(response.detail, /水 \+8\.3/);
  assert.match(response.detail, /朝の観測記録と照合/);
  assert.doesNotMatch(response.detail, /因果確定|原因確定/);
  assert.ok(!view.outcomes.some((entry) => entry.id === 'outcome-resources'), 'response log already carries the same resource deltas');
});

test('response readback keeps a food crisis visible even when the observed food delta was positive', async () => {
  const { state, loop } = await fixture(95018);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  state.settlement.resources.food = 0;
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [], task: 'forage',
      residence: 'settlement', expeditionId: null, recommendedResponse: 'none',
    }],
    resourceDeltas: { food: 12.5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const response = view.outcomes.find((entry) => entry.id === 'outcome-response-log');
  assert.ok(response);
  assert.equal(response.tone, 'critical');
  assert.match(response.detail, /食料 \+12\.5/);
  assert.match(response.detail, /今朝 [\d.]+日/);
  assert.match(response.detail, /危機継続/);
});

test('response readback marks recovered food reserves outside the warning band', async () => {
  const { state, loop } = await fixture(95019);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  state.settlement.resources.food = 10000;
  state.settlement.resources.water = 10000;
  state.settlement.waterSafety = 95;
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [], task: 'forage',
      residence: 'settlement', expeditionId: null, recommendedResponse: 'none',
    }],
    resourceDeltas: { food: 25 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const response = view.outcomes.find((entry) => entry.id === 'outcome-response-log');
  assert.ok(response);
  assert.equal(response.tone, 'normal');
  assert.match(response.detail, /食料 \+25\.0/);
  assert.match(response.detail, /警戒圏外/);
});

test('response readback keeps unsafe water quality critical regardless of reserve amount', async () => {
  const { state, loop } = await fixture(95020);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  state.settlement.resources.water = 10000;
  state.settlement.waterSafety = 40;
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [], task: 'sanitation',
      residence: 'settlement', expeditionId: null, recommendedResponse: 'none',
    }],
    resourceDeltas: { water: 18 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const response = view.outcomes.find((entry) => entry.id === 'outcome-response-log');
  assert.ok(response);
  assert.equal(response.tone, 'critical');
  assert.match(response.detail, /水 \+18\.0/);
  assert.match(response.detail, /安全度 40%/);
  assert.match(response.detail, /水質危機継続/);
});

test('crisis responder shortlist excludes locked and unsafe candidates', async () => {
  const { state, loop } = await fixture(95014);
  state.settlement.resources.water = 0;
  state.settlement.waterSafety = 40;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  const child = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role === 'child');
  assert.ok(adults.length >= 2);
  const unsafe = adults[0];
  unsafe.health = 25;
  unsafe.skills.survival = 100;
  const safe = adults[1];
  safe.health = 90;
  safe.fatigue = 10;
  safe.skills.survival = 99;
  if (child) child.skills.survival = 100;
  loop.currentPlan.assignments = [];
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const water = view.crisisRecommendations.find((entry) => entry.task === 'water');
  assert.ok(water);
  assert.ok(water.candidates.some((entry) => entry.agentId === safe.id));
  assert.ok(!water.candidates.some((entry) => entry.agentId === unsafe.id));
  if (child) assert.ok(!water.candidates.some((entry) => entry.agentId === child.id));
});

test('safe reserves do not manufacture crisis responder recommendations', async () => {
  const { state, loop } = await fixture(95015);
  state.settlement.resources.food = 10000;
  state.settlement.resources.water = 10000;
  state.settlement.waterSafety = 95;
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.deepEqual(view.crisisRecommendations, []);
});

test('crisis crew exposes yesterday response staffing beside today planned coverage', async () => {
  const { state, loop } = await fixture(95028);
  state.settlement.resources.food = 0;
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 90, healthAfter: 90, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [], task: 'forage',
      residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    }],
    resourceDeltas: { food: 12.5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(food);
  assert.equal(food.previousCount, 1);
  assert.equal(food.assignedCount, 0);
});

test('crisis crew prefers fresh safe responders over repeating yesterday same crisis task', async () => {
  const { state, loop } = await fixture(95029);
  state.settlement.resources.food = 0;
  const allAdults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  const adults = allAdults.slice(0, 3);
  assert.ok(adults.length >= 3);
  for (const adult of allAdults) {
    adult.currentTask = 'records';
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 20;
  }
  adults[0].skills.foraging = 100;
  adults[1].skills.foraging = 30;
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'forage' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: { food: 5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(food);
  const repeated = food.candidates.find((entry) => entry.agentId === adults[0].id);
  const fresh = food.candidates.find((entry) => entry.agentId === adults[1].id);
  assert.ok(repeated);
  assert.ok(fresh);
  assert.equal(repeated.workedSameTaskYesterday, true);
  assert.equal(fresh.workedSameTaskYesterday, false);
  assert.ok(food.candidates.indexOf(fresh) < food.candidates.indexOf(repeated), 'fresh responder should rank ahead of yesterday repeat even with lower visible skill');
  assert.ok(repeated.reasons.some((reason) => /昨日も採集/.test(reason)));
  assert.ok(fresh.reasons.some((reason) => /昨日は別任務/.test(reason)));
});

test('unresolved crisis exposes one-click fill ids only for the staffing gap versus yesterday', async () => {
  const { state, loop } = await fixture(95030);
  state.settlement.resources.food = 0;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 4);
  assert.ok(adults.length >= 4);
  for (const adult of adults) {
    adult.currentTask = 'records';
    adult.health = 95;
    adult.fatigue = 20;
    adult.skills.foraging = 50;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index < 2 ? 'forage' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: { food: 5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(food);
  assert.equal(food.previousCount, 2);
  assert.equal(food.assignedCount, 0);
  assert.equal(food.continuityShortfall, 2);
  assert.equal(food.fillCandidateIds.length, 2);
  assert.ok(food.fillCandidateIds.every((id) => food.candidates.some((candidate) => candidate.agentId === id)));

  setDailyAssignment(state, food.fillCandidateIds[0], 'forage');
  const updated = viewOf(state, loop, deriveSurvivalCampaignView(state)).crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(updated);
  assert.equal(updated.assignedCount, 1);
  assert.equal(updated.continuityShortfall, 1);
  assert.equal(updated.fillCandidateIds.length, 1);
});

test('crisis crew exposes a conservative one-click rotation swap for a repeated responder', async () => {
  const { state, loop } = await fixture(95031);
  state.settlement.resources.food = 0;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 4);
  assert.ok(adults.length >= 4);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.currentTask = 'records';
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 20;
    adult.skills.foraging = 40;
  }
  const repeated = adults[0];
  repeated.fatigue = 78;
  repeated.skills.foraging = 90;
  const fresh = adults[1];
  fresh.currentTask = 'rest';
  fresh.fatigue = 12;
  fresh.skills.foraging = 65;
  loop.currentPlan.assignments = [
    { agentId: repeated.id, task: 'forage' },
    { agentId: fresh.id, task: 'rest' },
  ];
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'forage' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: { food: 5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(food);
  assert.deepEqual(food.rotationSwap, {
    outgoingAgentId: repeated.id,
    outgoingName: repeated.name,
    incomingAgentId: fresh.id,
    incomingName: fresh.name,
    incomingPreviousTask: 'rest',
  });
});

test('crisis rotation swap is omitted when no fresh low-load replacement exists', async () => {
  const { state, loop } = await fixture(95032);
  state.settlement.resources.food = 0;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adults.length >= 2);
  for (const adult of adults) {
    adult.currentTask = 'repair';
    adult.health = 95;
    adult.fatigue = 20;
    adult.skills.foraging = 50;
  }
  const repeated = adults[0];
  loop.currentPlan.assignments = [{ agentId: repeated.id, task: 'forage' }];
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'forage' : 'repair', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: { food: 5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(food);
  assert.equal(food.rotationSwap, undefined);
});

test('crisis rotation swap is not suggested for a healthy low-fatigue repeated responder', async () => {
  const { state, loop } = await fixture(95033);
  state.settlement.resources.food = 0;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.ok(adults.length >= 3);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.currentTask = 'records';
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 20;
    adult.skills.foraging = 50;
  }
  const repeated = adults[0];
  const fresh = adults[1];
  fresh.currentTask = 'rest';
  fresh.skills.foraging = 70;
  loop.currentPlan.assignments = [
    { agentId: repeated.id, task: 'forage' },
    { agentId: fresh.id, task: 'rest' },
  ];
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'forage' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: { food: 5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(food);
  assert.equal(food.rotationSwap, undefined);
});

test('applying the advertised crisis rotation swap preserves crisis staffing while exchanging assignments', async () => {
  const { state, loop } = await fixture(95034);
  state.settlement.resources.food = 0;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.ok(adults.length >= 3);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.currentTask = 'records';
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 20;
    adult.skills.foraging = 50;
  }
  const repeated = adults[0];
  repeated.fatigue = 70;
  const fresh = adults[1];
  fresh.currentTask = 'rest';
  fresh.skills.foraging = 70;
  loop.currentPlan.assignments = [
    { agentId: repeated.id, task: 'forage' },
    { agentId: fresh.id, task: 'rest' },
  ];
  loop.lastMorningReport = {
    day: 2, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'forage' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: { food: 5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const before = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = before.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(food?.rotationSwap);
  setDailyAssignment(state, food.rotationSwap.outgoingAgentId, food.rotationSwap.incomingPreviousTask);
  setDailyAssignment(state, food.rotationSwap.incomingAgentId, food.task);
  const after = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const updatedFood = after.crisisRecommendations.find((entry) => entry.task === 'forage');
  assert.ok(updatedFood);
  assert.equal(updatedFood.assignedCount, food.assignedCount);
  assert.equal(loop.currentPlan.assignments.find((entry) => entry.agentId === repeated.id)?.task, 'rest');
  assert.equal(loop.currentPlan.assignments.find((entry) => entry.agentId === fresh.id)?.task, 'forage');
});

test('morning outcomes expose observed fatigue and health deltas for prior crisis responders without claiming rotation causality', async () => {
  const { state, loop } = await fixture(95035);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 2);
  assert.equal(adults.length, 2);
  loop.lastMorningReport = {
    day: 3, minuteOfDay: 420,
    residentDeltas: [
      {
        agentId: adults[0].id, name: adults[0].name, severity: 'stable', severityScore: 0, summary: 'stable',
        healthBefore: 94, healthAfter: 91, healthDelta: -3, fatigueDelta: 18, moraleDelta: 0,
        hungerAfter: 25, thirstAfter: 22, newPathologyIds: [], activePathologyIds: [],
        task: 'forage', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
      },
      {
        agentId: adults[1].id, name: adults[1].name, severity: 'improved', severityScore: -1, summary: 'recovered',
        healthBefore: 88, healthAfter: 90, healthDelta: 2, fatigueDelta: -7, moraleDelta: 1,
        hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
        task: 'water', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
      },
    ],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const load = view.outcomes.find((entry) => entry.id === 'outcome-responder-load');
  assert.ok(load);
  assert.match(load.title, /危機担当.*実測/);
  assert.match(load.detail, new RegExp(`${adults[0].name}.*採集.*疲労 \\+18.*HP -3`));
  assert.match(load.detail, new RegExp(`${adults[1].name}.*給水.*疲労 -7.*HP \\+2`));
  assert.doesNotMatch(load.detail, /交代効果|ローテーション効果|因果確定/);
  assert.ok(load.detail.length < 170, `responder load should stay compact, got ${load.detail.length} chars`);
  assert.ok(load.detail.includes(adults[0].name));
});

test('multi-crisis staffing marks overlapping candidates and proposes unique uncovered assignments without stealing active crisis staff', async () => {
  const { state, loop } = await fixture(95036);
  state.settlement.resources.food = 0;
  state.settlement.resources.water = 0;
  state.settlement.waterSafety = 40;
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 5);
  assert.ok(adults.length >= 5);
  const safe = new Set(adults.map((agent) => agent.id));
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = safe.has(adult.id) ? 95 : 20;
    adult.fatigue = 15;
    adult.currentTask = 'records';
    adult.skills.foraging = 70;
    adult.skills.survival = 70;
    adult.skills.care = 70;
  }
  const activeSanitation = adults[0];
  activeSanitation.currentTask = 'sanitation';
  loop.currentPlan.assignments = [{ agentId: activeSanitation.id, task: 'sanitation' }];
  loop.lastMorningReport = {
    day: 3, minuteOfDay: 420,
    residentDeltas: adults.map((adult) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: adult.currentTask, residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: { food: 1, water: 1 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.ok(view.crisisConflicts.length > 0);
  assert.ok(view.crisisConflicts.some((entry) => entry.tasks.length >= 2));
  assert.equal(view.crisisBalanceAssignments.length, 2);
  assert.deepEqual(new Set(view.crisisBalanceAssignments.map((entry) => entry.task)), new Set(['forage', 'water']));
  assert.equal(new Set(view.crisisBalanceAssignments.map((entry) => entry.agentId)).size, 2);
  assert.ok(!view.crisisBalanceAssignments.some((entry) => entry.agentId === activeSanitation.id), 'must not steal an existing sanitation responder');
  assert.ok(view.crisisRecommendations.flatMap((entry) => entry.candidates).some((candidate) => candidate.reasons.some((reason) => /他危機候補/.test(reason))));
});

test('crisis crew exposes a transparent response order from shared severity bands and existing water-before-food priority', async () => {
  const { state, loop } = await fixture(95037);
  const campaign = {
    ...deriveSurvivalCampaignView(state),
    foodDays: 0.8,
    waterDays: 2.2,
    waterSafety: 40,
  };

  const view = viewOf(state, loop, campaign);
  assert.deepEqual(view.crisisRecommendations.map((entry) => entry.task), ['sanitation', 'forage', 'water']);
  assert.deepEqual(view.crisisRecommendations.map((entry) => entry.priorityOrder), [1, 2, 3]);
  assert.deepEqual(view.crisisRecommendations.map((entry) => entry.urgencyTone), ['critical', 'critical', 'warning']);
  assert.match(view.crisisRecommendations[0]?.urgencyDetail ?? '', /安全度 40%.*55%/);
  assert.match(view.crisisRecommendations[1]?.urgencyDetail ?? '', /備蓄 0\.8日.*1\.5日/);
  assert.match(view.crisisRecommendations[2]?.urgencyDetail ?? '', /備蓄 2\.2日.*3\.0日/);
});

test('multi-crisis balance assignment spends scarce unique staff on higher response-order crises first', async () => {
  const { state, loop } = await fixture(95038);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.equal(adults.length, 3);
  const safe = new Set(adults.map((agent) => agent.id));
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = safe.has(adult.id) ? 95 : 20;
    adult.fatigue = 15;
    adult.currentTask = 'records';
    adult.skills.foraging = 70;
    adult.skills.survival = 70;
    adult.skills.care = 70;
  }
  const campaign = {
    ...deriveSurvivalCampaignView(state),
    foodDays: 0.8,
    waterDays: 2.2,
    waterSafety: 40,
  };
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 4, minuteOfDay: 420,
    residentDeltas: adults.map((adult) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisBalanceAssignments.length, 3);
  assert.deepEqual(view.crisisBalanceAssignments.map((entry) => entry.task), ['sanitation', 'forage', 'water']);
  assert.deepEqual(view.crisisBalanceAssignments.map((entry) => entry.priorityOrder), [1, 2, 3]);
});

test('top-priority crisis exposes one safe one-person focus assignment without stealing active lower-priority crisis staff', async () => {
  const { state, loop } = await fixture(95039);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 5);
  assert.ok(adults.length >= 4);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 15;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.foraging = 70;
    adult.skills.survival = 70;
    adult.skills.care = 70;
  }
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adults[0].id, 'forage');
  setDailyAssignment(state, adults[1].id, 'water');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 0.8, waterDays: 2.2, waterSafety: 40 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisRecommendations[0]?.task, 'sanitation');
  assert.equal(view.crisisFocusAssignment?.priorityOrder, 1);
  assert.equal(view.crisisFocusAssignment?.task, 'sanitation');
  assert.ok(view.crisisFocusAssignment?.agentId);
  assert.notEqual(view.crisisFocusAssignment?.agentId, adults[0].id, 'must not steal active forage responder');
  assert.notEqual(view.crisisFocusAssignment?.agentId, adults[1].id, 'must not steal active water responder');
  assert.equal(view.crisisFocusAssignment?.reason, 'uncovered');
});

test('top-priority focus assignment restores continuity one person at a time and disappears once the floor is met', async () => {
  const { state, loop } = await fixture(95040);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 4);
  assert.ok(adults.length >= 3);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.care = 75;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 4, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index < 2 ? 'sanitation' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 6, waterDays: 6, waterSafety: 40 };

  const before = viewOf(state, loop, campaign);
  assert.equal(before.crisisFocusAssignment?.reason, 'continuity-gap');
  assert.equal(before.crisisFocusAssignment?.requiredCoverage, 2);
  assert.equal(before.crisisFocusAssignment?.assignedCount, 0);
  const first = before.crisisFocusAssignment;
  assert.ok(first);
  setDailyAssignment(state, first.agentId, first.task);
  const middle = viewOf(state, loop, campaign);
  assert.equal(middle.crisisFocusAssignment?.assignedCount, 1);
  assert.equal(middle.crisisFocusAssignment?.requiredCoverage, 2);
  const second = middle.crisisFocusAssignment;
  assert.ok(second);
  assert.notEqual(second.agentId, first.agentId);
  setDailyAssignment(state, second.agentId, second.task);
  const after = viewOf(state, loop, campaign);
  assert.equal(after.crisisFocusAssignment, undefined);
});

test('crisis coverage progress counts minimum staffed crises and points to the next unmet response-order item', async () => {
  const { state, loop } = await fixture(95041);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 5);
  assert.ok(adults.length >= 4);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 12;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.foraging = 70;
    adult.skills.survival = 70;
    adult.skills.care = 70;
  }
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adults[0].id, 'sanitation');
  setDailyAssignment(state, adults[1].id, 'water');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 0.8, waterDays: 2.2, waterSafety: 40 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 2);
  assert.equal(view.crisisCoverage?.totalCount, 3);
  assert.equal(view.crisisCoverage?.nextPriorityOrder, 2);
  assert.equal(view.crisisCoverage?.nextTask, 'forage');
  assert.match(view.crisisCoverage?.detail ?? '', /2\/3|#2|食料/);
});

test('crisis coverage becomes complete when each active crisis has its minimum observed or initial staffing floor', async () => {
  const { state, loop } = await fixture(95042);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 4);
  assert.ok(adults.length >= 3);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.foraging = 70;
    adult.skills.survival = 70;
    adult.skills.care = 70;
  }
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adults[0].id, 'sanitation');
  setDailyAssignment(state, adults[1].id, 'forage');
  setDailyAssignment(state, adults[2].id, 'water');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 0.8, waterDays: 2.2, waterSafety: 40 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 3);
  assert.equal(view.crisisCoverage?.totalCount, 3);
  assert.equal(view.crisisCoverage?.nextPriorityOrder, undefined);
  assert.match(view.crisisCoverage?.detail ?? '', /3\/3|最低配置完了/);
});

test('incomplete active crisis coverage is surfaced as RISK without blocking execution', async () => {
  const { state, loop } = await fixture(95043);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = 95;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 0);
  assert.equal(view.crisisCoverage?.totalCount, 1);
  assert.equal(view.readiness, 'risk');
  const gap = view.readinessIssues.find((entry) => entry.id === 'crisis-coverage-gap');
  assert.ok(gap);
  assert.match(gap.title, /最低配置未達/);
  assert.match(gap.detail, /COVERAGE 0\/1|#1|水/);
  assert.notEqual(view.readiness, 'blocked');
});

test('completed crisis minimum coverage clears the aggregate coverage readiness warning', async () => {
  const { state, loop } = await fixture(95044);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  for (const candidate of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    candidate.health = 95;
    candidate.fatigue = 10;
    candidate.pathology = [];
    candidate.currentTask = 'records';
    candidate.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adult.id, 'water');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.crisisCoverage?.totalCount, 1);
  assert.equal(view.readinessIssues.some((entry) => entry.id === 'crisis-coverage-gap'), false);
  assert.match(view.crisisCoverage?.detail ?? '', /最低配置完了/);
});


test('completed crisis coverage exposes one recoverable excess responder without changing READY', async () => {
  const { state, loop } = await fixture(95045);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.ok(adults.length >= 2);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = 95;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'water');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.crisisCoverage?.totalCount, 1);
  assert.equal(view.crisisRecovery?.excessCount, 1);
  assert.equal(view.crisisRecovery?.recoverableCount, 1);
  assert.equal(view.crisisRecovery?.assignment?.fromTask, 'water');
  const recoveredRow = view.residentRows.find((row) => row.agentId === view.crisisRecovery?.assignment?.agentId);
  assert.ok(recoveredRow);
  assert.equal(view.crisisRecovery?.assignment?.returnTask, recoveredRow.previousTask);
  assert.notEqual(view.crisisRecovery?.assignment?.returnTask, 'water');
  assert.match(view.crisisRecovery?.detail ?? '', /最低配置を1名上回る|余剰/);
  assert.equal(view.readiness, 'ready');
});

test('crisis recovery stays absent when active crisis staffing only meets its conservative floor', async () => {
  const { state, loop } = await fixture(95046);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  for (const candidate of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    candidate.health = 95;
    candidate.fatigue = 10;
    candidate.pathology = [];
    candidate.currentTask = 'records';
    candidate.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adult.id, 'water');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.crisisRecovery, undefined);
});

test('completed crisis coverage reports normal-operation gaps against the actual prior-day task mix', async () => {
  const { state, loop } = await fixture(95046);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.ok(adults.length >= 3);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 7, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'water' : index === 1 ? 'repair' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'water');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.crisisCoverage?.totalCount, 1);
  assert.equal(view.normalOpsBalance?.gapCount, 1);
  assert.equal(view.normalOpsBalance?.shortfallCount, 1);
  assert.deepEqual(view.normalOpsBalance?.gaps.map((gap) => [gap.task, gap.previousCount, gap.assignedCount]), [['repair', 1, 0]]);
  assert.equal(view.normalOpsBalance?.recoveryTask, 'repair');
  assert.match(view.normalOpsBalance?.detail ?? '', /修繕 1→0|前日/);
  assert.equal(view.readiness, 'ready');
});

test('normal-operation balance disappears when prior non-crisis staffing is preserved at crisis coverage floor', async () => {
  const { state, loop } = await fixture(95047);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.ok(adults.length >= 3);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 8, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'water' : index === 1 ? 'repair' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'repair');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.normalOpsBalance, undefined);
});

test('normal-operation recovery stays hidden while active crisis minimum coverage is still incomplete', async () => {
  const { state, loop } = await fixture(95048);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 2);
  assert.ok(adults.length >= 2);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 9, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'water' : 'repair', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adults[1].id, 'records');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 0);
  assert.equal(view.crisisCoverage?.totalCount, 1);
  assert.equal(view.normalOpsBalance, undefined);
});

test('plan balance compares crisis, normal-operation, and rest staffing against the actual prior day', async () => {
  const { state, loop } = await fixture(95049);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 4);
  assert.ok(adults.length >= 4);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 10, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: ['water', 'repair', 'rest', 'records'][index], residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'water');
  setDailyAssignment(state, adults[2].id, 'records');
  setDailyAssignment(state, adults[3].id, 'records');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.planBalance?.crisis.previousCount, 1);
  assert.equal(view.planBalance?.crisis.assignedCount, 2);
  assert.equal(view.planBalance?.crisis.delta, 1);
  assert.equal(view.planBalance?.normalOps.delta, 0);
  assert.equal(view.planBalance?.rest.delta, -1);
  assert.match(view.planBalance?.detail ?? '', /危機対応 \+1/);
  assert.match(view.planBalance?.detail ?? '', /平常業務 ±0/);
  assert.match(view.planBalance?.detail ?? '', /休養 -1/);
  assert.equal(view.readiness, 'ready');
});

test('plan balance stays hidden without a real prior-day comparison or when category staffing is unchanged', async () => {
  const first = await fixture(95050);
  const campaign = { ...deriveSurvivalCampaignView(first.state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };
  const withoutReport = viewOf(first.state, first.loop, campaign);
  assert.equal(withoutReport.planBalance, undefined);

  const adults = first.state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 2);
  assert.ok(adults.length >= 2);
  for (const adult of first.state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
  }
  first.loop.currentPlan.assignments = [];
  first.loop.lastMorningReport = {
    day: 11, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'water' : 'records', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(first.state, adults[0].id, 'water');
  setDailyAssignment(first.state, adults[1].id, 'records');
  const unchanged = viewOf(first.state, first.loop, campaign);
  assert.equal(unchanged.planBalance, undefined);
});


test('plan balance recovery restores one safe non-crisis assignment toward the prior-day mix without touching crisis floor', async () => {
  const { state, loop } = await fixture(95051);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 3);
  assert.ok(adults.length >= 3);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 12, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: ['water', 'rest', 'records'][index], residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'records');
  setDailyAssignment(state, adults[2].id, 'records');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.crisisRecovery, undefined);
  assert.equal(view.planBalance?.normalOps.delta, 1);
  assert.equal(view.planBalance?.rest.delta, -1);
  assert.equal(view.planBalanceRecovery?.agentId, adults[1].id);
  assert.equal(view.planBalanceRecovery?.fromTask, 'records');
  assert.equal(view.planBalanceRecovery?.returnTask, 'rest');
  assert.match(view.planBalanceRecovery?.detail ?? '', /前日構成|休養/);

  setDailyAssignment(state, adults[1].id, 'rest');
  const restored = viewOf(state, loop, campaign);
  assert.equal(restored.planBalance, undefined);
  assert.equal(restored.planBalanceRecovery, undefined);
  assert.equal(restored.crisisCoverage?.coveredCount, 1);
});

test('plan balance recovery does not suggest an unsafe prior-day task', async () => {
  const { state, loop } = await fixture(95052);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 2);
  assert.ok(adults.length >= 2);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  adults[1].health = 40;
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 13, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: adult.health, healthAfter: adult.health, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'water' : 'repair', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'rest');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.planBalance?.normalOps.delta, -1);
  assert.equal(view.planBalance?.rest.delta, 1);
  assert.equal(view.planBalanceRecovery, undefined);
});

test('rest pressure surfaces fatigued non-crisis workers without touching active crisis coverage', async () => {
  const { state, loop } = await fixture(95053);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 4);
  assert.ok(adults.length >= 4);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
    adult.skills.survival = 70;
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 14, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: ['water', 'repair', 'records', 'rest'][index], residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  adults[0].fatigue = 82;
  adults[1].fatigue = 67;
  adults[2].health = 68;
  adults[2].fatigue = 20;
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'repair');
  setDailyAssignment(state, adults[2].id, 'records');
  setDailyAssignment(state, adults[3].id, 'rest');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.crisisCoverage?.totalCount, 1);
  assert.deepEqual(view.restPressure?.candidates.map((candidate) => candidate.agentId), [adults[1].id, adults[2].id]);
  assert.match(view.restPressure?.candidates[0]?.detail ?? '', /疲労 67/);
  assert.match(view.restPressure?.candidates[1]?.detail ?? '', /HP 68/);
  assert.ok(!view.restPressure?.candidates.some((candidate) => candidate.agentId === adults[0].id), 'active crisis worker must not be offered for rest');
});

test('rest pressure stays hidden when no safe non-crisis resident crosses the existing fatigue or health threshold', async () => {
  const { state, loop } = await fixture(95054);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 2);
  assert.ok(adults.length >= 2);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = 95;
    adult.fatigue = 20;
    adult.pathology = [];
    adult.currentTask = 'records';
  }
  loop.currentPlan.assignments = [];
  setDailyAssignment(state, adults[0].id, 'records');
  setDailyAssignment(state, adults[1].id, 'rest');
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  assert.equal(view.restPressure, undefined);
});

test('balance recovery does not immediately undo rest chosen for an already fatigued resident', async () => {
  const { state, loop } = await fixture(95055);
  const adults = state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child').slice(0, 2);
  assert.ok(adults.length >= 2);
  for (const adult of state.agents.filter((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child')) {
    adult.health = adults.includes(adult) ? 95 : 20;
    adult.fatigue = 10;
    adult.pathology = [];
    adult.currentTask = 'records';
  }
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 15, minuteOfDay: 420,
    residentDeltas: adults.map((adult, index) => ({
      agentId: adult.id, name: adult.name, severity: 'stable', severityScore: 0, summary: 'stable',
      healthBefore: 95, healthAfter: 95, healthDelta: 0, fatigueDelta: 0, moraleDelta: 0,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: index === 0 ? 'water' : 'repair', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    })),
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  adults[1].fatigue = 67;
  setDailyAssignment(state, adults[0].id, 'water');
  setDailyAssignment(state, adults[1].id, 'rest');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 2.2, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.crisisCoverage?.coveredCount, 1);
  assert.equal(view.planBalance?.normalOps.delta, -1);
  assert.equal(view.planBalance?.rest.delta, 1);
  assert.equal(view.planBalanceRecovery, undefined);
});

test('rest readback follow-up offers one-click re-rest only when a still-pressured resident left rest for a non-crisis task', async () => {
  const { state, loop } = await fixture(95056);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 76;
  adult.fatigue = 49;
  adult.pathology = [];
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 16, minuteOfDay: 420,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'improved', severityScore: 0, summary: 'rested',
      healthBefore: 73, healthAfter: 76, healthDelta: 3, fatigueDelta: -18, moraleDelta: 1,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adult.id, 'records');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 8, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.restFollowUp?.candidateCount, 1);
  assert.equal(view.restFollowUp?.candidates[0]?.agentId, adult.id);
  assert.equal(view.restFollowUp?.candidates[0]?.assignedTask, 'records');
  assert.equal(view.restFollowUp?.candidates[0]?.alreadyResting, false);
  assert.match(view.restFollowUp?.candidates[0]?.detail ?? '', /疲労 49/);
  assert.doesNotMatch(view.restFollowUp?.candidates[0]?.name ?? '', /INDIVIDUAL:ORIGIN/);
});

test('rest readback follow-up marks an already resting pressured resident as continuing instead of proposing another mutation', async () => {
  const { state, loop } = await fixture(95057);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 68;
  adult.fatigue = 38;
  adult.pathology = [];
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 17, minuteOfDay: 420,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'improved', severityScore: 0, summary: 'rested',
      healthBefore: 63, healthAfter: 68, healthDelta: 5, fatigueDelta: -12, moraleDelta: 1,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adult.id, 'rest');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 8, waterDays: 8, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.restFollowUp?.candidates[0]?.alreadyResting, true);
  assert.equal(view.restFollowUp?.candidates[0]?.assignedTask, 'rest');
});

test('rest readback follow-up never offers to pull a still-pressured resident out of an active crisis assignment', async () => {
  const { state, loop } = await fixture(95058);
  const adult = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(adult);
  adult.health = 76;
  adult.fatigue = 49;
  adult.pathology = [];
  loop.currentPlan.assignments = [];
  loop.lastMorningReport = {
    day: 18, minuteOfDay: 420,
    residentDeltas: [{
      agentId: adult.id, name: adult.name, severity: 'improved', severityScore: 0, summary: 'rested',
      healthBefore: 73, healthAfter: 76, healthDelta: 3, fatigueDelta: -18, moraleDelta: 1,
      hungerAfter: 20, thirstAfter: 20, newPathologyIds: [], activePathologyIds: [],
      task: 'rest', residence: 'settlement', expeditionId: null, recommendedResponse: 'continue',
    }],
    resourceDeltas: {}, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };
  setDailyAssignment(state, adult.id, 'forage');
  const campaign = { ...deriveSurvivalCampaignView(state), foodDays: 0.8, waterDays: 8, waterSafety: 90 };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.restFollowUp, undefined);
});

test('quiet ready days expose the next incomplete continuity milestone without inventing a task result', async () => {
  const { state, loop } = await fixture(95070);
  const base = deriveSurvivalCampaignView(state);
  const campaign = {
    ...base,
    phase: 'explore',
    foodDays: 8,
    waterDays: 8,
    waterSafety: 90,
    sanitation: 80,
    averageHealth: 88,
    returnedExpeditions: 0,
    activeExpeditions: 0,
    archivedRecords: 0,
    institutionalKnowledge: 3,
    livingDescendants: 0,
    birthsSinceStart: 0,
    directive: {
      id: 'complete-first-expedition', severity: 'watch', title: '最初の遠征を完遂する',
      detail: '既知地点を選び、隊員と物資を準備して帰還してください。', target: 'expedition', basisIds: [],
    },
    milestones: [
      { id: 'stabilize', label: 'STABILIZE', detail: 'stable', complete: true },
      { id: 'explore', label: 'EXPLORE', detail: 'return one expedition', complete: false },
      { id: 'preserve', label: 'PRESERVE', detail: 'archive one record', complete: false },
      { id: 'generation', label: 'NEXT GENERATION', detail: 'keep one descendant alive', complete: false },
    ],
  };

  const view = viewOf(state, loop, campaign);
  assert.equal(view.readiness, 'ready');
  assert.equal(view.crisisRecommendations.length, 0);
  assert.equal(view.longHorizon?.milestoneId, 'explore');
  assert.match(view.longHorizon?.title ?? '', /遠征/);
  assert.match(view.longHorizon?.progress ?? '', /帰還遠征 0\/1/);
  assert.equal(view.longHorizon?.target, 'expedition');
  assert.doesNotMatch(view.longHorizon?.detail ?? '', /成功率|収量|予測/);
});

test('long-horizon guidance yields to active survival crises', async () => {
  const { state, loop } = await fixture(95071);
  const base = deriveSurvivalCampaignView(state);
  const campaign = {
    ...base,
    phase: 'stabilize',
    foodDays: 0.8,
    waterDays: 0.9,
    waterSafety: 40,
    directive: {
      id: 'secure-water', severity: 'critical', title: '水を確保する', detail: '危機', target: 'task', basisIds: [],
    },
    milestones: base.milestones.map((entry) => ({ ...entry, complete: false })),
  };

  const view = viewOf(state, loop, campaign);
  assert.ok(view.crisisRecommendations.length > 0);
  assert.equal(view.longHorizon, undefined);
});


test('P29 assignment consequence readback projects only moved residents from canonical Morning Report facts', () => {
  assert.equal(typeof dailyCommandReadModel.assignmentConsequenceReadback, 'function');
  const moves = [
    { agentId: 'resident-critical', name: 'Aki', fromTask: 'records', toTask: 'water' },
    { agentId: 'resident-stable', name: 'Mio', fromTask: 'guard', toTask: 'rest' },
    { agentId: 'resident-unmatched', name: 'No Report', fromTask: 'care', toTask: 'records' },
  ];
  const report = {
    day: 22, minuteOfDay: 420,
    residentDeltas: [
      {
        agentId: 'resident-stable', name: 'Mio', severity: 'stable', severityScore: 0,
        summary: '大きな変化なし', healthBefore: 81, healthAfter: 82, healthDelta: 1,
        fatigueDelta: -9, moraleDelta: 2, hungerAfter: 24, thirstAfter: 21,
        newPathologyIds: [], activePathologyIds: [], task: 'rest', residence: 'settlement', expeditionId: null,
        recommendedResponse: '通常観察',
      },
      {
        agentId: 'resident-critical', name: 'Aki', severity: 'critical', severityScore: 900,
        summary: '体力が危険域', healthBefore: 57, healthAfter: 53, healthDelta: -4,
        fatigueDelta: 15, moraleDelta: -2, hungerAfter: 38, thirstAfter: 44,
        newPathologyIds: [], activePathologyIds: ['strain'], task: 'water', residence: 'settlement', expeditionId: null,
        recommendedResponse: '身体状態を確認',
      },
    ],
    resourceDeltas: { water: 11.5 }, expeditionUpdates: [], settlementUpdates: [], births: [], deaths: [],
  };

  const readback = dailyCommandReadModel.assignmentConsequenceReadback(moves, report);
  assert.equal(readback.length, 2);
  assert.equal(readback[0].agentId, 'resident-critical');
  assert.equal(readback[0].fromTask, 'records');
  assert.equal(readback[0].toTask, 'water');
  assert.equal(readback[0].healthDelta, -4);
  assert.equal(readback[0].fatigueDelta, 15);
  assert.equal(readback[0].moraleDelta, -2);
  assert.equal(readback[0].severity, 'critical');
  assert.equal(readback[1].agentId, 'resident-stable');
  assert.equal(Object.hasOwn(readback[0], 'resourceDeltas'), false);
});

test('P30 morning replan queue keeps only moved residents needing review and reuses canonical rest pressure', () => {
  assert.equal(typeof dailyCommandReadModel.morningReplanQueue, 'function');
  const readback = [
    {
      agentId: 'critical-agent', name: 'Aki', fromTask: 'records', toTask: 'guard',
      severity: 'critical', severityScore: 900, summary: '体力が危険域', healthAfter: 48,
      healthDelta: -7, fatigueDelta: 18, moraleDelta: -3,
    },
    {
      agentId: 'watch-agent', name: 'Mio', fromTask: 'water', toTask: 'care',
      severity: 'watch', severityScore: 310, summary: '疲労を継続観察', healthAfter: 76,
      healthDelta: -1, fatigueDelta: 9, moraleDelta: 0,
    },
    {
      agentId: 'stable-agent', name: 'Ren', fromTask: 'repair', toTask: 'records',
      severity: 'stable', severityScore: 0, summary: '大きな変化なし', healthAfter: 86,
      healthDelta: 0, fatigueDelta: -2, moraleDelta: 1,
    },
    {
      agentId: 'unmatched-agent', name: 'No Current Row', fromTask: 'care', toTask: 'water',
      severity: 'severe', severityScore: 700, summary: 'current row missing', healthAfter: 51,
      healthDelta: -4, fatigueDelta: 10, moraleDelta: -1,
    },
  ];
  const rows = [
    { agentId: 'critical-agent', name: 'Aki', role: 'guard', condition: 'HP 48', previousTask: 'guard', assignedTask: 'water', locked: false, severityScore: 900 },
    { agentId: 'watch-agent', name: 'Mio', role: 'caregiver', condition: 'HP 76', previousTask: 'care', assignedTask: 'care', locked: false, severityScore: 310 },
    { agentId: 'stable-agent', name: 'Ren', role: 'archivist', condition: 'HP 86', previousTask: 'records', assignedTask: 'records', locked: false, severityScore: 0 },
  ];
  const restPressure = {
    candidateCount: 1,
    detail: '1名を休養候補として確認',
    candidates: [{ agentId: 'critical-agent', name: 'Aki', assignedTask: 'water', fatigue: 78, health: 48, detail: '高疲労' }],
  };

  const queue = dailyCommandReadModel.morningReplanQueue(readback, rows, restPressure);
  assert.deepEqual(queue.map((entry)=>({ agentId: entry.agentId, replanned: entry.replanned, restEligible: entry.restEligible })), [
    { agentId: 'critical-agent', replanned: true, restEligible: true },
    { agentId: 'watch-agent', replanned: false, restEligible: false },
  ]);
  assert.equal(queue[0].currentTask, 'water');
  assert.equal(queue[0].toTask, 'guard');
  assert.equal(queue.some((entry)=>entry.agentId==='stable-agent'), false);
  assert.equal(queue.some((entry)=>entry.agentId==='unmatched-agent'), false);
});

test('P31 survival instruments expose exact current and observed-24h facts without forecasts', async () => {
  const { state, loop } = await fixture(95310);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(resident);
  resident.health = 35;
  resident.pathology.push({
    id: 'case:p31', pathologyId: 'p31-observed', onsetDay: state.clock.day,
    severity: 72, contagious: false, observedSymptoms: ['weakness'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  state.settlement.resources.food = 1;
  state.settlement.resources.water = 2;
  state.settlement.resources.medicine = 4;
  state.settlement.waterSafety = 42;
  state.expeditions.push({ id: 'p31-expedition', status: 'missing' });
  loop.lastMorningReport = {
    day: state.clock.day,
    minuteOfDay: state.clock.minuteOfDay,
    residentDeltas: [],
    resourceDeltas: { food: -2.5, water: 1.25, medicine: 0 },
    expeditionUpdates: ['p31 expedition update'],
    settlementUpdates: [],
    births: ['p31-birth'],
    deaths: ['p31-death'],
  };
  const view = viewOf(state, loop, deriveSurvivalCampaignView(state));
  const food = view.resourceSummary.find((entry) => entry.id === 'food');
  const water = view.resourceSummary.find((entry) => entry.id === 'water');
  const medicine = view.resourceSummary.find((entry) => entry.id === 'medicine');
  const population = view.resourceSummary.find((entry) => entry.id === 'population');
  const expedition = view.resourceSummary.find((entry) => entry.id === 'expedition');
  assert.equal(food?.target, 'inventory');
  assert.equal(food?.trend, 'down');
  assert.match(food?.trendLabel ?? '', /24H Δ -2\.5/);
  assert.equal(water?.target, 'inventory');
  assert.equal(water?.trend, 'up');
  assert.match(water?.detail ?? '', /安全度 42%/);
  assert.equal(medicine?.trend, 'flat');
  assert.equal(medicine?.statusLabel, 'WATCH');
  assert.equal(population?.target, 'chronicle');
  assert.equal(population?.tone, 'critical');
  assert.equal(population?.trend, 'activity');
  assert.match(population?.trendLabel ?? '', /BIRTH \+1/);
  assert.match(population?.trendLabel ?? '', /DEATH -1/);
  assert.equal(expedition?.target, 'expedition');
  assert.equal(expedition?.tone, 'warning');
  assert.equal(expedition?.trend, 'activity');
  assert.match(expedition?.trendLabel ?? '', /24H UPDATE 1/);
  for (const item of view.resourceSummary) {
    assert.equal(item.statusLabel, item.tone === 'critical' ? 'CRITICAL' : item.tone === 'warning' ? 'WATCH' : 'STABLE');
    const serialized = JSON.stringify(item);
    assert.doesNotMatch(serialized, /forecast|projection|sparkline|efficiency|productivity|success rate/i);
  }
});

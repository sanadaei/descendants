import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import {
  ensureSurvivalCampaignState,
  deriveSurvivalCampaignView,
  generationDepth,
} from '../.test-dist/sandbox/survivalCampaign.js';

async function initial(seed = 7001) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed });
  delete state.campaign;
  return state;
}

test('original I2X state lazily gains an open-ended survival continuity sidecar', async () => {
  const state = await initial();
  assert.equal(state.campaign, undefined);
  const campaign = ensureSurvivalCampaignState(state);
  assert.equal(campaign.schemaVersion, 2);
  assert.equal(campaign.startDay, state.clock.day);
  assert.deepEqual(campaign.foundingAgentIds, state.agents.filter((agent) => agent.alive).map((agent) => agent.id));
  assert.equal('targetDay' in campaign, false);
  assert.equal('outcome' in campaign, false);

  const view = deriveSurvivalCampaignView(state);
  assert.equal(view.currentYear, 1);
  assert.equal('campaignYears' in view, false);
  assert.equal('targetDay' in view, false);
  assert.equal('yearsRemaining' in view, false);
  assert.equal('outcome' in view, false);
  assert.ok(Number.isFinite(view.foodDays) && view.foodDays >= 0);
  assert.ok(Number.isFinite(view.waterDays) && view.waterDays >= 0);
  assert.ok(view.directive.id.length > 0);
  assert.equal(view.milestones.length, 4);
});

test('survival reserve days use the same adult and child daily consumption as settlement simulation', async () => {
  const state = await initial(7002);
  const locals = state.agents.filter((agent) => agent.alive && !agent.expeditionId && (!agent.residence || agent.residence === 'settlement'));
  const children = locals.filter((agent) => Math.floor((state.clock.day - agent.bornDay) / 365) < 13).length;
  const adults = locals.length - children;
  state.settlement.resources.food = 100;
  state.settlement.resources.water = 100;
  const view = deriveSurvivalCampaignView(state);
  assert.equal(view.foodDays, 100 / (adults * 1.8 + children * 1.05));
  assert.equal(view.waterDays, 100 / (adults * 2.5 + children * 1.65));
});

test('generation depth is derived from lived parent links without changing provider founder identity', async () => {
  const state = await initial(7003);
  const founder = state.agents.find((agent) => agent.alive);
  assert.ok(founder);
  const child = structuredClone(founder);
  child.id = 'person:test-child';
  child.identityOrigin = 'lived-game-state';
  child.parentIds = [founder.id];
  child.bornDay = state.clock.day + 20;
  const grandchild = structuredClone(child);
  grandchild.id = 'person:test-grandchild';
  grandchild.parentIds = [child.id];
  grandchild.bornDay = state.clock.day + 9000;
  state.agents.push(child, grandchild);
  assert.equal(generationDepth(state, founder.id), 0);
  assert.equal(generationDepth(state, child.id), 1);
  assert.equal(generationDepth(state, grandchild.id), 2);
  assert.equal(founder.identityOrigin, 'world-provider');
});

test('continuity phase progresses through observed achievements and stays open-ended after a living next generation exists', async () => {
  const state = await initial(7004);
  ensureSurvivalCampaignState(state);
  state.settlement.resources.food = 10000;
  state.settlement.resources.water = 10000;
  state.settlement.waterSafety = 90;
  state.settlement.sanitation = 90;
  for (const agent of state.agents) agent.pathology = [];

  let view = deriveSurvivalCampaignView(state);
  assert.equal(view.phase, 'explore');

  state.expeditions.push({
    id: 'expedition:test-returned', leaderId: state.settlement.leaderId, memberIds: [], controlMode: 'settlement', doctrineId: state.doctrines[0].id,
    status: 'returned', pace: 'normal', position: structuredClone(state.settlement.position), destination: null, orders: [], observations: [], discoveredEntityIds: [],
    communication: 'connected', silentHours: 0, communicationReports: [], supplies: { food: 0, water: 0, medicine: 0, tools: 0 }, routePlan: null,
  });
  state.records.push({ id: 'record:test', title: 'First archive', body: 'preserved', authorIds: [state.settlement.leaderId], subjectIds: [], sourceKnowledgeIds: [], createdDay: state.clock.day, copies: 1, integrity: 1 });
  view = deriveSurvivalCampaignView(state);
  assert.equal(view.phase, 'generation');

  const founder = state.agents.find((agent) => agent.alive);
  assert.ok(founder);
  const child = structuredClone(founder);
  child.id = 'person:campaign-born'; child.identityOrigin = 'lived-game-state'; child.parentIds = [founder.id]; child.bornDay = state.campaign.startDay + 100; child.alive = true;
  state.agents.push(child);
  view = deriveSurvivalCampaignView(state);
  assert.equal(view.phase, 'continuity');
  assert.ok(view.milestones.find((entry) => entry.id === 'generation')?.complete);
  assert.equal(view.directive.id, 'sustain-community');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { deriveSurvivalCampaignView, ensureSurvivalCampaignState, evaluateSurvivalCampaign } from '../.test-dist/sandbox/survivalCampaign.js';

async function initial(seed = 7301) {
  const state = await createInitialSandboxState(new MockWorldProvider(), { seed });
  delete state.campaign;
  ensureSurvivalCampaignState(state);
  return state;
}

function makeSettlementSafe(state) {
  state.settlement.resources.food = 100000;
  state.settlement.resources.water = 100000;
  state.settlement.waterSafety = 95;
  state.settlement.sanitation = 90;
  for (const agent of state.agents) {
    agent.health = 95;
    agent.pathology = [];
  }
}

test('campaign onboarding explains open-ended daily settlement continuity and generations', async () => {
  const state = await initial();
  const view = deriveSurvivalCampaignView(state);
  assert.doesNotMatch(view.briefing.title, /30|THIRTY|三十/i);
  assert.match(view.briefing.premise, /集落|settlement/i);
  assert.match(view.briefing.objective, /世代|generation|次世代/i);
  assert.match(`${view.briefing.premise} ${view.briefing.objective}`, /1日|日々|daily/i);
});

test('survival director prioritizes water then food then health then observed crisis before expansion', async () => {
  const state = await initial(7302);
  state.settlement.resources.water = 0;
  state.settlement.resources.food = 0;
  assert.equal(deriveSurvivalCampaignView(state).directive.id, 'secure-water');

  state.settlement.resources.water = 100000;
  state.settlement.waterSafety = 95;
  assert.equal(deriveSurvivalCampaignView(state).directive.id, 'secure-food');

  state.settlement.resources.food = 100000;
  for (const agent of state.agents) { agent.health = 50; agent.pathology = []; }
  assert.equal(deriveSurvivalCampaignView(state).directive.id, 'treat-health-pressure');

  for (const agent of state.agents) agent.health = 95;
  state.externalActors = [{
    entityId: 'external:test-pressure', kind: 'settlement', name: 'Observed rival', population: 50,
    position: null, lastObservedTick: state.world.tick, confidence: .9, disposition: -20,
    localTrust: 10, tradeExperience: 0, migrationBalance: 0, conflictPressure: 80,
  }];
  assert.equal(deriveSurvivalCampaignView(state).directive.id, 'respond:external-pressure:external:test-pressure');

  state.externalActors = [];
  assert.equal(deriveSurvivalCampaignView(state).directive.id, 'complete-first-expedition');
});

test('earned continuity milestones remain part of settlement legacy even if conditions later deteriorate', async () => {
  const state = await initial(7303);
  makeSettlementSafe(state);
  evaluateSurvivalCampaign(state);
  assert.ok(state.campaign.completedMilestoneIds.includes('stabilize'));

  state.settlement.resources.water = 0;
  const deteriorated = deriveSurvivalCampaignView(state);
  assert.equal(deteriorated.milestones.find((entry) => entry.id === 'stabilize')?.complete, true);
  assert.equal(deteriorated.directive.id, 'secure-water');
});

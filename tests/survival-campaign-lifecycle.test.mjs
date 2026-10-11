import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { advanceSandboxDays, advanceSandboxHours } from '../.test-dist/sandbox/engine.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { deriveSurvivalCampaignView, ensureSurvivalCampaignState, evaluateSurvivalCampaign } from '../.test-dist/sandbox/survivalCampaign.js';

async function initial(seed = 8101) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed });
  return { provider, state };
}

test('campaign evaluation never creates victory defeat or generated endings', async () => {
  const { state } = await initial();
  ensureSurvivalCampaignState(state);
  for (const agent of state.agents) { agent.alive = false; agent.health = 0; }
  const endingsBefore = [...state.generatedEndings];
  const view = evaluateSurvivalCampaign(state);
  assert.equal('outcome' in view, false);
  assert.equal('outcome' in state.campaign, false);
  assert.deepEqual(state.generatedEndings, endingsBefore);
  assert.notEqual(state.campaign.phase, 'won');
  assert.notEqual(state.campaign.phase, 'lost');
});

test('original schemaVersion 1 save without campaign sidecar is lazily migrated to open-ended campaign state', async () => {
  const { state } = await initial(8104);
  delete state.campaign;
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.campaign?.schemaVersion, 2);
  assert.equal('targetDay' in restored.campaign, false);
  assert.equal('outcome' in restored.campaign, false);
});

test('intermediate thirty-year campaign save is accepted but terminal metadata is discarded during migration', async () => {
  const { state } = await initial(8105);
  const founders = state.agents.filter((agent) => agent.alive).map((agent) => agent.id);
  state.campaign = {
    schemaVersion: 1,
    startDay: state.clock.day,
    targetDay: state.clock.day + 30 * 365,
    foundingAgentIds: founders,
    completedMilestoneIds: ['stabilize', 'explore', 'preserve', 'generation', 'endure'],
    phase: 'won',
    lastEvaluatedDay: state.clock.day,
    strategicAdvanceDays: 30,
    outcome: { kind: 'victory', endingId: 'survival-generation:victory', day: state.clock.day, title: 'legacy', summary: 'legacy', score: 999 },
  };
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.campaign.schemaVersion, 2);
  assert.equal(restored.campaign.phase, 'continuity');
  assert.deepEqual(restored.campaign.completedMilestoneIds, ['stabilize', 'explore', 'preserve', 'generation']);
  assert.equal(restored.campaign.strategicAdvanceDays, 30);
  assert.equal('targetDay' in restored.campaign, false);
  assert.equal('outcome' in restored.campaign, false);
});

test('ordinary simulation advancement evaluates continuity and includes it in replay state', async () => {
  const { provider, state } = await initial(8106);
  const campaign = ensureSurvivalCampaignState(state);
  campaign.lastEvaluatedDay = 0;
  campaign.phase = 'stabilize';
  state.settlement.resources.food = 10000;
  state.settlement.resources.water = 10000;
  state.settlement.waterSafety = 90;
  state.settlement.sanitation = 90;
  for (const agent of state.agents) agent.pathology = [];
  await advanceSandboxHours(provider, state, 6);
  assert.equal(state.campaign?.lastEvaluatedDay, state.clock.day);
  assert.equal(state.campaign?.phase, deriveSurvivalCampaignView(state).phase);
  assert.match(state.diagnostics.replayHash, /^[0-9a-f]{8}$/);
});

test('internal strategic fast-forward code remains available even though it is not player-facing', async () => {
  const { provider, state } = await initial(8107);
  const startDay = state.clock.day;
  await advanceSandboxDays(provider, state, 7);
  assert.equal(state.clock.day, startDay + 7);
});

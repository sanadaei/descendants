import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { ContentPackRegistry, WorldgenEngine, parseWorldRecipe } from '../vendor/i2x-worldgen-runtime/dist/index.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { addObservedKnowledge } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { ensureDirectPlayState } from '../.test-dist/sandbox/directPlay.js';
import { observeGeneratedEntity, takeGeneratedSample } from '../.test-dist/sandbox/localExploration.js';
import { researchApplicationDomain, researchWorkMultiplier } from '../.test-dist/sandbox/researchApplications.js';
import { startResearchProject, simulateResearchInterval } from '../.test-dist/sandbox/researchSimulation.js';
import { requestDirectClinicCare } from '../.test-dist/sandbox/settlementSimulation.js';
import { knownMapLocation } from '../.test-dist/sandbox/knowledgeSpatial.js';
import { renderPdaMiniMap } from '../.test-dist/sandbox/ui/mapView.js';
import { attemptAnomalyUtilization } from '../.test-dist/sandbox/anomalyUtilization.js';
import { adjustResourceStock } from '../.test-dist/sandbox/resourceLedger.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { SandboxApp } from '../.test-dist/sandbox/app.js';
import { pdaAudio } from '../.test-dist/sandbox/pdaAudio.js';

const summary = (state) => ({ from: { ...state.clock }, to: { ...state.clock }, births: [], deaths: [], leadershipChanges: [], expeditionUpdates: [], encounterUpdates: [], knowledgeUpdates: [], settlementUpdates: [] });
async function fixture(seed = 20261011) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed, population: 14 });
  ensureDirectPlayState(state);
  return { provider, state };
}
function complete(state, source, researcherIds) {
  const project = startResearchProject(state, source.id, researcherIds);
  project.progress = 99.9;
  simulateResearchInterval(state, 24, summary(state));
  return project;
}
let realFixture;
async function generated() {
  return realFixture ??= (async () => {
    const root = new URL('../vendor/i2x-worldgen-runtime/setting-packs/descendants/', import.meta.url);
    const raw = JSON.parse(fs.readFileSync(new URL('default.recipe.json', root), 'utf8'));
    const content = new ContentPackRegistry();
    for (const ref of raw.contentPacks) content.register(JSON.parse(fs.readFileSync(new URL(`content-packs/${ref.id}.json`, root), 'utf8')));
    const provider = await new WorldgenEngine(undefined, content).generate(parseWorldRecipe(JSON.stringify(raw)));
    const state = await createInitialSandboxState(provider);
    return { provider, state };
  })();
}

test('real Worldgen freshwater samples establish water practice through opaque IDs and save/reload', async () => {
  const { provider, state: base } = await generated();
  const state = structuredClone(base);
  const snapshot = await provider.exportSnapshot(2);
  const water = snapshot.entities.find((entity) => entity.kind === 'ecological-resource' && entity.subtype === 'freshwater');
  assert.ok(water);
  assert.doesNotMatch(water.id, /water/);
  const owner = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  const { knowledge, item } = takeGeneratedSample(state, owner.id, water);
  assert.equal(knowledge.entityObservation.kind, 'ecological-resource');
  assert.equal(knowledge.entityObservation.subtype, 'freshwater');
  assert.equal(item.sourceEntityId, water.id);
  assert.equal(researchApplicationDomain(knowledge), 'water');
  const project = complete(state, knowledge, [owner.id]);
  assert.equal(project.status, 'completed');
  assert.equal(state.researchApplications[0].domain, 'water');
  assert.ok(researchWorkMultiplier(state, 'water') > 1);
  assert.equal(researchWorkMultiplier(state, 'explore-prep'), 1);
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(researchWorkMultiplier(restored, 'water'), researchWorkMultiplier(state, 'water'));
  assert.deepEqual(restored.knowledge.find((entry) => entry.id === project.resultKnowledgeId).entityObservation, knowledge.entityObservation);
});

test('entity ID substrings cannot fabricate a research domain', async () => {
  const { state } = await fixture();
  const source = addObservedKnowledge(state, [state.settlement.leaderId], ['ent_water_archive_material'], 'An unclassified observation.', .9);
  assert.equal(researchApplicationDomain(source), null);
  complete(state, source);
  assert.equal(state.researchApplications?.length ?? 0, 0);
});

test('local clinic outcomes retain measured before/after evidence', async () => {
  const { state } = await fixture();
  const patient = state.agents.find((agent) => agent.alive);
  patient.pathology = [{ id: 'case:measured', pathologyId: 'traumatic-wound', onsetDay: 1, severity: 40, contagious: false, observedSymptoms: ['pain'], suspectedCauses: [], treatmentsTried: [], status: 'active' }];
  const result = requestDirectClinicCare(state, patient.id, 240);
  const knowledge = state.knowledge.find((entry) => entry.treatmentObservation?.caseId === 'case:measured');
  assert.ok(knowledge);
  assert.equal(knowledge.treatmentObservation.severityBefore, result.pathology.severityBefore);
  assert.equal(knowledge.treatmentObservation.severityAfter, result.pathology.severityAfter);
  assert.equal(knowledge.treatmentObservation.practice, result.pathology.practice);
  assert.equal(knowledge.treatmentObservation.patientId, patient.id);
  assert.deepEqual(importSandboxSave(JSON.stringify(state)).knowledge.find((entry) => entry.id === knowledge.id).treatmentObservation, knowledge.treatmentObservation);
});

test('medicine research distinguishes improvement, worsening, inconclusive and unmeasured claims', async () => {
  for (const [outcome, after] of [['improvement', 35], ['worsening', 45], ['inconclusive', 40], ['unmeasured', null]]) {
    const { state } = await fixture();
    const patient = state.agents.find((agent) => agent.alive);
    const source = addObservedKnowledge(state, [patient.id], ['pathology:test', 'treatment:test'], `A ${outcome} was reported.`, .9);
    if (after !== null) source.treatmentObservation = { patientId: patient.id, caseId: 'case:test', pathologyId: 'test', practice: 'test', severityBefore: 40, severityAfter: after };
    const project = complete(state, source);
    assert.equal(project.status, 'completed');
    assert.equal(researchWorkMultiplier(state, 'medicine') > 1, outcome === 'improvement', outcome);
    if (outcome !== 'improvement') assert.match(project.practicalOutcome, /未確立/);
    const restored = importSandboxSave(JSON.stringify(state));
    assert.equal(researchWorkMultiplier(restored, 'medicine'), researchWorkMultiplier(state, 'medicine'));
    if (outcome === 'improvement') {
      delete restored.knowledge.find((entry) => entry.id === project.resultKnowledgeId).treatmentObservation;
      assert.equal(researchWorkMultiplier(restored, 'medicine'), 1, 'legacy unmeasured bonuses are inactive');
    }
  }
});

test('clinic practice selection respects outcome direction and physically accessible evidence', async () => {
  for (const mode of ['local-improvement', 'local-worsening', 'remote-improvement', 'unmeasured']) {
    const { state } = await fixture();
    const patient = state.agents[0], remote = state.agents.at(-1);
    patient.pathology = [{ id: 'case:choice', pathologyId: 'traumatic-wound', onsetDay: 1, severity: 40, contagious: false, observedSymptoms: ['pain'], suspectedCauses: [], treatmentsTried: [], status: 'active' }];
    const distant = mode === 'remote-improvement';
    if (distant) { remote.expeditionId = 'expedition:remote'; remote.residence = 'expedition'; }
    const source = addObservedKnowledge(state, [distant ? remote.id : patient.id], ['pathology:traumatic-wound', 'treatment:warm-compress'], 'A confident report about warm-compress.', .95, undefined, [], { promoteToSettlement: !distant });
    if (mode !== 'unmeasured') source.treatmentObservation = { patientId: patient.id, caseId: 'case:prior', pathologyId: 'traumatic-wound', practice: 'warm-compress', severityBefore: 40, severityAfter: mode === 'local-worsening' ? 45 : 35 };
    const result = requestDirectClinicCare(state, patient.id, 60);
    assert.equal(result.pathology.practice === 'warm-compress', mode === 'local-improvement', mode);
  }
});

test('study time and competence cannot raise confidence without supporting observations', async () => {
  const { state } = await fixture();
  const source = state.knowledge.find((entry) => !entry.lost);
  source.confidence = .03;
  const project = startResearchProject(state, source.id);
  const confidence = project.confidence;
  for (const id of project.researcherIds) {
    const agent = state.agents.find((entry) => entry.id === id);
    for (const key of Object.keys(agent.skills)) agent.skills[key] = 100;
  }
  for (let day = 0; day < 8; day++) simulateResearchInterval(state, 24, summary(state));
  assert.equal(project.confidence, confidence);
  assert.ok(project.progress > 0);
  project.progress = 99.9;
  simulateResearchInterval(state, 24, summary(state));
  const result = state.knowledge.find((entry) => entry.id === project.resultKnowledgeId);
  assert.ok(result.confidence <= source.confidence);
  assert.doesNotMatch(result.claim, /supports|qualifies/);
});

test('research stops on lost/changed evidence and pauses when its participating holder leaves', async () => {
  for (const change of ['lost', 'changed', 'away']) {
    const { state } = await fixture();
    const holder = state.agents.find((agent) => agent.alive);
    const source = addObservedKnowledge(state, [holder.id], ['resource:freshwater'], 'An available observation.', .9, undefined, [], { promoteToSettlement: false });
    const project = startResearchProject(state, source.id, [holder.id]);
    if (change === 'lost') source.lost = true;
    if (change === 'changed') source.claim = 'The previous interpretation was revised.';
    if (change === 'away') { holder.expeditionId = 'expedition:away'; holder.residence = 'expedition'; }
    simulateResearchInterval(state, 24, summary(state));
    assert.equal(project.progress, 0);
    assert.equal(project.status, change === 'away' ? 'active' : 'abandoned');
    assert.equal(project.resultKnowledgeId, undefined);
  }
});

function estimatedRegion(state) {
  const entity = { id: 'region:estimated', kind: 'region', components: {}, provenanceIds: [], spatial: { ...state.settlement.position, x: 9876, y: 8765 } };
  const claim = { interpretation: 'cartographic-estimate', regionId: entity.id, estimatedCenter: { x: 12, y: 23 }, uncertaintyRadiusKm: 3.2 };
  const knowledge = addObservedKnowledge(state, [state.settlement.leaderId], [entity.id], JSON.stringify(claim), .7);
  return { entity, knowledge, claim };
}

test('map estimates survive legacy saves and render their center and uncertainty without true coordinates', async () => {
  const { state } = await fixture();
  const { entity, claim } = estimatedRegion(state);
  const before = JSON.stringify(entity);
  const location = knownMapLocation(state, state.settlement.leaderId, entity);
  assert.equal(location.position.x, claim.estimatedCenter.x);
  assert.equal(location.position.y, claim.estimatedCenter.y);
  assert.equal(location.uncertaintyRadiusKm, 3.2);
  assert.equal(location.estimated, true);
  const positions = [];
  const ctx = {
    state, controlledExpedition: () => null, visibleWorldEntities: () => [entity], selectedWorldEntity: () => entity,
    worldMapLocation: (entry) => knownMapLocation(state, state.settlement.leaderId, entry),
    mapMarkerStyle: (position) => { positions.push(position); return `left:${position.x}px;top:${position.y}px`; },
  };
  const html = renderPdaMiniMap(ctx);
  assert.match(html, /desc-pda-map-uncertainty/);
  assert.match(html, /半径 3.2 km/);
  assert.match(html, /（推定）/);
  assert.ok(positions.every((position) => position.x === 12 && position.y === 23));
  assert.doesNotMatch(html, /9876|8765/);
  assert.equal(JSON.stringify(entity), before, 'provider objects remain unchanged');
  assert.deepEqual(knownMapLocation(importSandboxSave(JSON.stringify(state)), state.settlement.leaderId, entity), location);
});

test('actual Worldgen cartographic knowledge yields estimated positions', async () => {
  const { provider, state } = await generated();
  const source = state.knowledge.find((entry) => entry.claim.includes('cartographic-estimate'));
  assert.ok(source);
  const claim = JSON.parse(source.claim);
  const entity = await provider.getEntity(claim.regionId, state.world.originEntityId);
  const location = knownMapLocation(state, state.settlement.leaderId, entity);
  assert.equal(location.estimated, true);
  assert.equal(location.position.x, claim.estimatedCenter.x);
  assert.equal(location.position.y, claim.estimatedCenter.y);
  assert.equal(location.uncertaintyRadiusKm, claim.uncertaintyRadiusKm);
  assert.notEqual(location.position.x, entity.spatial.x);
});

test('map actions launch and order expeditions to the estimated center without canonical waypoints', async (t) => {
  const { provider, state } = await fixture();
  const { entity, knowledge, claim } = estimatedRegion(state);
  claim.estimatedCenter = { x: state.settlement.position.x + 1, y: state.settlement.position.y + 1 };
  knowledge.claim = JSON.stringify(claim);
  const route = { id: 'route:known', kind: 'route', components: {}, provenanceIds: [], spatial: { ...entity.spatial } };
  addObservedKnowledge(state, [state.settlement.leaderId], [route.id], 'A route was reported.', .7);
  for (const agent of state.agents) { agent.health = 100; agent.fatigue = 0; agent.pathology = []; }
  for (const key of ['food', 'water', 'medicine', 'scrap']) adjustResourceStock(state, key, 1000, 'Verification supplies');
  const projection = await provider.queryArea({ center: state.settlement.position, radiusKm: 25, requestedDetailRank: 2, observerId: state.settlement.leaderId, includeKnowledgeProjection: true });
  t.mock.method(provider, 'queryArea', async () => ({ ...projection, entities: [...projection.entities, entity, route] }));
  // Exercise real event handlers and game mutations; suppress unrelated DOM rendering and audio.
  t.mock.method(SandboxApp.prototype, 'render', () => {});
  for (const method of ['unlock', 'playConfirm', 'playClick']) t.mock.method(pdaAudio, method, () => {});
  const savedGlobals = Object.fromEntries(['window', 'document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const handlers = {};
  globalThis.window = { addEventListener() {}, localStorage: { getItem: () => null } };
  globalThis.document = { addEventListener() {} };
  try {
    const root = { addEventListener: (kind, handler) => { handlers[kind] = handler; }, querySelector: () => null };
    const app = new SandboxApp(root, provider, { mode: 'volatile', save: async () => {} }, state);
    await new Promise((resolve) => setImmediate(resolve));
    const click = (action, entityId) => handlers.click({ target: { closest: () => ({ dataset: { action, entityId } }) } });
    click('set-prep-target', entity.id);
    assert.deepEqual(app.viewContext().prepTarget, { ...state.settlement.position, ...claim.estimatedCenter });
    handlers.change({ target: { closest: (selector) => selector === '[data-action="prep-route"]' ? { value: route.id } : null } });
    assert.equal(app.viewContext().prepRouteEntityId, route.id);
    click('launch');
    await new Promise((resolve) => setImmediate(resolve));
    const expedition = state.expeditions.at(-1);
    assert.ok(expedition, 'the real launch action succeeds');
    assert.deepEqual(expedition.destination, { ...state.settlement.position, ...claim.estimatedCenter });
    assert.equal(expedition.routeWaypoint, undefined);
    assert.equal(expedition.routePlan, undefined);
    click('move-world-target', entity.id);
    await new Promise((resolve) => setImmediate(resolve));
    const order = expedition.orders.at(-1);
    assert.deepEqual(order.target, expedition.destination);
    assert.match(order.detail, /estimated area/);
  } finally {
    for (const [key, descriptor] of Object.entries(savedGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('direct observations confirm a map position while inaccessible or malformed estimates reveal none', async () => {
  const { state } = await fixture();
  const { entity, knowledge, claim } = estimatedRegion(state);
  state.settlement.localKnowledgeIds = state.settlement.localKnowledgeIds.filter((id) => id !== knowledge.id);
  const foreignObserver = state.agents.find((agent) => agent.id !== state.settlement.leaderId);
  assert.equal(knownMapLocation(state, foreignObserver.id, entity).position, undefined);
  knowledge.claim = JSON.stringify({ ...claim, uncertaintyRadiusKm: -1 });
  assert.equal(knownMapLocation(state, state.settlement.leaderId, entity).position, undefined);
  knowledge.claim = '{"interpretation":"cartographic-estimate",';
  assert.equal(knownMapLocation(state, state.settlement.leaderId, entity).position, undefined);
  const observation = observeGeneratedEntity(state, state.settlement.leaderId, entity);
  const confirmed = knownMapLocation(state, state.settlement.leaderId, entity);
  assert.equal(confirmed.estimated, false);
  assert.deepEqual(confirmed.position, entity.spatial);
  assert.deepEqual(observation.entityObservation.position, entity.spatial);
});

test('anomaly medicine affects only living co-located cases, even when remote/dead cases are more severe', async () => {
  const { provider, state } = await fixture();
  const [dead, away, outside, local] = state.agents;
  for (const [agent, severity] of [[dead, 100], [away, 90], [outside, 95], [local, 30]]) {
    agent.pathology = [{ id: `case:${agent.id}`, pathologyId: 'test', onsetDay: 1, severity, contagious: false, observedSymptoms: ['observed symptom'], suspectedCauses: [], treatmentsTried: [], status: 'active' }];
  }
  dead.alive = false;
  away.expeditionId = 'expedition:silent'; away.residence = 'expedition';
  outside.residence = 'external';
  local.health = 100; local.fatigue = 0;
  for (const key of ['fuel', 'scrap']) adjustResourceStock(state, key, 1000, 'Verification materials');
  const source = addObservedKnowledge(state, [local.id], [state.world.originEntityId], 'Anomaly effects were observed locally.', .95);
  let result;
  for (let count = 0; count < 20; count++) {
    result = await attemptAnomalyUtilization(provider, state, { sourceKnowledgeId: source.id, domain: 'medicine', operatorIds: [local.id] });
    if (result.success) break;
  }
  assert.ok(result.success);
  assert.equal(dead.pathology[0].severity, 100);
  assert.equal(away.pathology[0].severity, 90);
  assert.equal(outside.pathology[0].severity, 95);
  assert.ok(local.pathology[0].severity < 30);
  local.pathology[0].status = 'resolved';
  for (let count = 0; count < 20; count++) {
    result = await attemptAnomalyUtilization(provider, state, { sourceKnowledgeId: source.id, domain: 'medicine', operatorIds: [local.id] });
    if (result.success) break;
  }
  assert.ok(result.success);
  assert.match(result.outcome, /no measurable patient effect/);
  assert.equal(away.pathology[0].severity, 90);
});

test('save validation rejects contradictory observation metadata', async () => {
  const { state } = await fixture();
  const { entity } = estimatedRegion(state);
  const observation = observeGeneratedEntity(state, state.settlement.leaderId, entity);
  observation.entityObservation.entityId = 'entity:unobserved';
  assert.throws(() => importSandboxSave(JSON.stringify(state)), /recorded subject/);
});

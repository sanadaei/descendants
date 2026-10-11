import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import {
  ensureResourceLedgerState,
  resourceLots,
  resourceLotTotal,
  syncSettlementResourceAggregates,
} from '../.test-dist/sandbox/resourceLedger.js';

async function initial(seed = 91001) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed });
  return { provider, state };
}

test('legacy scalar-only settlement lazily gains provenance-bearing lots without changing totals', async () => {
  const { state } = await initial();
  delete state.resourceLedger;
  const before = structuredClone(state.settlement.resources);

  const ledger = ensureResourceLedgerState(state);
  assert.equal(ledger.schemaVersion, 1);
  assert.ok(ledger.sources.some((source) => source.worldEntityIds.includes(state.world.originEntityId)));
  for (const [key, amount] of Object.entries(before)) {
    const lots = resourceLots(state, key);
    if (amount > 0) {
      assert.ok(lots.length >= 1, `${key} should migrate into at least one physical lot`);
      assert.equal(resourceLotTotal(state, key), amount);
      assert.ok(lots.every((lot) => lot.sourceId && lot.worldEntityIds.includes(state.world.originEntityId)));
      assert.ok(lots.every((lot) => lot.label.includes('legacy settlement stock')));
    }
  }

  state.settlement.resources.food = 0;
  syncSettlementResourceAggregates(state);
  assert.equal(state.settlement.resources.food, before.food);
  assert.deepEqual(state.settlement.resources, before);
});

test('aggregate projection equals sum of non-depleted lots for every resource key', async () => {
  const { state } = await initial(91002);
  delete state.resourceLedger;
  ensureResourceLedgerState(state);
  const firstFood = resourceLots(state, 'food')[0];
  assert.ok(firstFood);
  firstFood.quantity = Math.max(0, firstFood.quantity - 3.25);
  syncSettlementResourceAggregates(state);
  assert.equal(state.settlement.resources.food, resourceLotTotal(state, 'food'));
});

test('world ecology entities become harvestable sources with explicit provider provenance', async () => {
  const { state } = await initial(91003);
  const p = structuredClone(state.settlement.position);
  state.world.providerSnapshot.entities.push(
    { id:'ecological-resource:test-biomass', kind:'ecological-resource', subtype:'biomass', spatial:p, components:{regionId:'region:test',resourceKind:'biomass',renewable:true,currentStock:120,carryingStock:200,regenerationPerDay:2}, provenanceIds:['prov:biomass'] },
    { id:'ecological-resource:test-water', kind:'ecological-resource', subtype:'freshwater', spatial:p, components:{regionId:'region:test',resourceKind:'freshwater',renewable:true,currentStock:900,carryingStock:1000,regenerationPerDay:5}, provenanceIds:['prov:water'] },
    { id:'ecological-guild:test-consumer', kind:'ecological-guild', subtype:'consumer', spatial:p, components:{regionId:'region:test',guildKind:'consumer',abundance:80,abundanceCapacity:120,reproductionRatePerDay:0.002}, provenanceIds:['prov:consumer'] },
  );
  delete state.resourceLedger;
  const { initializeResourceLedgerFromWorld, resourceSources } = await import('../.test-dist/sandbox/resourceLedger.js');
  initializeResourceLedgerFromWorld(state);
  const meatSource = resourceSources(state,'food').find((source)=>source.worldEntityIds.includes('ecological-guild:test-consumer'));
  const waterSource = resourceSources(state,'water').find((source)=>source.worldEntityIds.includes('ecological-resource:test-water'));
  assert.ok(meatSource);
  assert.equal(meatSource.kind,'ecological-guild');
  assert.match(meatSource.label,/meat|game/i);
  assert.ok(meatSource.worldProvenanceIds.includes('prov:consumer'));
  assert.ok(waterSource);
  assert.equal(waterSource.renewable,true);
  assert.equal(waterSource.accessibleStock,900);
});

test('harvesting consumes source stock and renewable sources regenerate without exceeding capacity', async () => {
  const { state } = await initial(91004);
  const p = structuredClone(state.settlement.position);
  state.world.providerSnapshot.entities.push({ id:'ecological-resource:harvest-water', kind:'ecological-resource', subtype:'freshwater', spatial:p, components:{regionId:'region:test',resourceKind:'freshwater',renewable:true,currentStock:12,carryingStock:15,regenerationPerDay:2}, provenanceIds:['prov:harvest-water'] });
  delete state.resourceLedger;
  const { initializeResourceLedgerFromWorld, resourceSources, recordResourceProduction, regenerateResourceSources } = await import('../.test-dist/sandbox/resourceLedger.js');
  initializeResourceLedgerFromWorld(state);
  const source = resourceSources(state,'water').find((entry)=>entry.worldEntityIds.includes('ecological-resource:harvest-water'));
  assert.ok(source);
  const beforeAggregate = state.settlement.resources.water;
  const lot = recordResourceProduction(state,{ resourceKey:'water', amount:5, sourceId:source.id, harvesterIds:[state.settlement.leaderId] });
  assert.equal(lot.quantity,5);
  assert.equal(source.accessibleStock,7);
  assert.equal(state.settlement.resources.water,beforeAggregate+5);
  regenerateResourceSources(state,2);
  assert.equal(source.accessibleStock,11);
  regenerateResourceSources(state,10);
  assert.equal(source.accessibleStock,15);
});

test('legacy scalar mutations reconcile into ledger adjustments instead of desynchronizing stock', async () => {
  const { state } = await initial(91005);
  delete state.resourceLedger;
  ensureResourceLedgerState(state);
  const { reconcileResourceLedgerToAggregates } = await import('../.test-dist/sandbox/resourceLedger.js');
  const before = resourceLotTotal(state,'food');
  state.settlement.resources.food += 4;
  reconcileResourceLedgerToAggregates(state,'test legacy production');
  assert.equal(resourceLotTotal(state,'food'),before+4);
  assert.ok(resourceLots(state,'food').some((lot)=>lot.label.includes('system adjustment')));
  state.settlement.resources.food -= 2.5;
  reconcileResourceLedgerToAggregates(state,'test legacy consumption');
  assert.equal(resourceLotTotal(state,'food'),before+1.5);
  assert.equal(state.settlement.resources.food,before+1.5);
});

test('direct settlement eating consumes an actual food lot, not only the scalar compatibility total', async () => {
  const { state } = await initial(91006);
  const { consumeAccessibleSupply } = await import('../.test-dist/sandbox/directPlay.js');
  const eater = state.agents.find((agent)=>agent.alive && !agent.expeditionId);
  assert.ok(eater);
  const before = resourceLotTotal(state,'food');
  consumeAccessibleSupply(state,eater.id,'food');
  assert.equal(resourceLotTotal(state,'food'),before-1);
  assert.equal(state.settlement.resources.food,before-1);
});

test('creating an archive record creates physical record-copy stock in the resource ledger', async () => {
  const { state } = await initial(91007);
  const { institutionalizeKnowledgeRecord } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const author = state.agents.find((agent)=>agent.alive && !agent.expeditionId && agent.knowledgeIds.length>0);
  assert.ok(author);
  const knowledgeId = author.knowledgeIds.find((id)=>!state.records.some((record)=>record.knowledgeIds.includes(id)));
  assert.ok(knowledgeId);
  const before = resourceLotTotal(state,'records');
  const record = institutionalizeKnowledgeRecord(state,author.id,knowledgeId);
  assert.ok(record.copies>0);
  assert.equal(resourceLotTotal(state,'records'),before+record.copies);
  assert.ok(resourceLots(state,'records').some((lot)=>lot.label.includes(record.title)));
});

test('settlement forage labor produces a provenance-bearing physical food lot', async () => {
  const { state } = await initial(91008);
  const { simulateSettlementInterval } = await import('../.test-dist/sandbox/settlementSimulation.js');
  const summary = { from:structuredClone(state.clock),to:structuredClone(state.clock),births:[],deaths:[],leadershipChanges:[],expeditionUpdates:[],encounterUpdates:[],knowledgeUpdates:[],settlementUpdates:[] };
  for (const key of Object.keys(state.settlement.laborPriorities)) state.settlement.laborPriorities[key] = key === 'forage' ? 100 : -100;
  for (const agent of state.agents.filter((entry)=>entry.alive && !entry.expeditionId)) { agent.role='forager'; agent.skills.foraging=100; agent.health=100; agent.fatigue=0; }
  const beforeIds = new Set(resourceLots(state,'food').map((lot)=>lot.id));
  simulateSettlementInterval(state,6,summary);
  const produced = resourceLots(state,'food').filter((lot)=>!beforeIds.has(lot.id));
  assert.ok(produced.length>0);
  assert.ok(produced.some((lot)=>lot.harvesterIds.length>0));
  assert.ok(produced.every((lot)=>lot.worldEntityIds.length>0));
});

test('processing a lot preserves source provenance and parent lineage while improving treated water quality', async () => {
  const { state } = await initial(91009);
  const { processResourceLot } = await import('../.test-dist/sandbox/resourceLedger.js');
  const water = resourceLots(state,'water')[0];
  assert.ok(water);
  water.waterQuality = { microbialRisk:0.7, chemicalRisk:0.2, turbidity:0.6 };
  water.contaminationRisk = 0.7;
  const beforeQuantity = water.quantity;
  const derived = processResourceLot(state, water.id, 'boiled', [state.settlement.leaderId]);
  assert.equal(water.quantity,0);
  assert.equal(derived.quantity,beforeQuantity);
  assert.deepEqual(derived.parentLotIds,[water.id]);
  assert.equal(derived.sourceId,water.sourceId);
  assert.deepEqual(derived.worldEntityIds,water.worldEntityIds);
  assert.deepEqual(derived.worldProvenanceIds,water.worldProvenanceIds);
  assert.ok(derived.waterQuality.microbialRisk < 0.7);
  assert.ok(derived.contaminationRisk < 0.7);
  assert.equal(derived.processingHistory.at(-1).kind,'boiled');
});

test('resource lots age each day and preserved food degrades more slowly than raw food', async () => {
  const { state } = await initial(91010);
  const { processResourceLot, ageResourceLots } = await import('../.test-dist/sandbox/resourceLedger.js');
  const raw = resourceLots(state,'food')[0];
  assert.ok(raw);
  raw.freshness = 1;
  const preserved = processResourceLot(state,raw.id,'smoked',[state.settlement.leaderId]);
  const separate = structuredClone(preserved);
  separate.id = `${preserved.id}:raw-comparison`;
  separate.processingHistory = [{kind:'raw',day:state.clock.day,minuteOfDay:state.clock.minuteOfDay,agentIds:[],note:'comparison'}];
  separate.parentLotIds = [];
  separate.freshness = 1;
  state.resourceLedger.lots.push(separate);
  ageResourceLots(state,1);
  assert.ok(preserved.freshness > separate.freshness);
  assert.ok(preserved.freshness < 1);
});

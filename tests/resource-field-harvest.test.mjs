import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { resourceLotTotal, resourceSources } from '../.test-dist/sandbox/resourceLedger.js';
import { harvestGeneratedResource, depositCarriedResourcesAtSettlement, harvestableResourceKeys } from '../.test-dist/sandbox/localExploration.js';

async function initial(seed=93001){ const provider=new MockWorldProvider(); const state=await createInitialSandboxState(provider,{seed}); return {provider,state}; }

test('LOCAL consumer-guild harvest becomes personal meat cargo and depletes the observed world-linked source', async()=>{
  const {state}=await initial();
  const agent=state.agents.find((entry)=>entry.alive&&!entry.expeditionId);
  assert.ok(agent);
  const entity={id:'ecological-guild:field-consumer',kind:'ecological-guild',subtype:'consumer',spatial:structuredClone(state.settlement.position),components:{regionId:'region:test',guildKind:'consumer',abundance:12,abundanceCapacity:20,reproductionRatePerDay:0.01},provenanceIds:['prov:field-consumer'],tags:['visible-fauna']};
  assert.deepEqual(harvestableResourceKeys(entity),['food']);
  const before=resourceLotTotal(state,'food');
  const item=harvestGeneratedResource(state,agent.id,entity,'food',2);
  assert.equal(item.resourceKey,'food');
  assert.match(item.name,/wild-game meat/i);
  assert.equal(item.sourceEntityId,entity.id);
  assert.ok(item.provenanceIds.includes('prov:field-consumer'));
  assert.equal(resourceLotTotal(state,'food'),before,'field cargo must not teleport into settlement stock');
  const source=resourceSources(state,'food').find((entry)=>entry.worldEntityIds.includes(entity.id));
  assert.ok(source);
  assert.equal(source.accessibleStock,10);
});

test('return/deposit converts carried field resources into settlement lots without losing provenance', async()=>{
  const {state}=await initial(93002);
  const agent=state.agents.find((entry)=>entry.alive&&!entry.expeditionId);
  assert.ok(agent);
  const entity={id:'ecological-resource:field-water',kind:'ecological-resource',subtype:'freshwater',spatial:structuredClone(state.settlement.position),components:{regionId:'region:test',resourceKind:'freshwater',renewable:true,currentStock:30,carryingStock:50,regenerationPerDay:3},provenanceIds:['prov:field-water'],tags:['freshwater']};
  const before=resourceLotTotal(state,'water');
  const item=harvestGeneratedResource(state,agent.id,entity,'water',5);
  assert.equal(resourceLotTotal(state,'water'),before);
  const deposited=depositCarriedResourcesAtSettlement(state,[agent.id]);
  assert.equal(deposited.length,1);
  assert.equal(item.quantity,0);
  assert.equal(resourceLotTotal(state,'water'),before+5);
  assert.ok(deposited[0].worldEntityIds.includes(entity.id));
  assert.ok(deposited[0].worldProvenanceIds.includes('prov:field-water'));
  assert.equal(deposited[0].harvesterIds[0],agent.id);
});

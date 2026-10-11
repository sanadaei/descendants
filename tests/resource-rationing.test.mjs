import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { advanceSandboxHours } from '../.test-dist/sandbox/engine.js';
import {
  allocationGroups,
  allocationRules,
  resourceLots,
  saveResourceAllocationGroup,
  saveResourceAllocationRule,
} from '../.test-dist/sandbox/resourceLedger.js';

async function initial(seed=92001){ const provider=new MockWorldProvider(); const state=await createInitialSandboxState(provider,{seed}); return {provider,state}; }

test('player can save a reusable named allocation group from settlement roster ids', async()=>{
  const {state}=await initial();
  const residents=state.agents.filter((agent)=>agent.alive&&!agent.expeditionId).slice(0,3);
  assert.equal(residents.length,3);
  const group=saveResourceAllocationGroup(state,'Night watch',[residents[0].id,residents[2].id]);
  assert.equal(group.name,'Night watch');
  assert.deepEqual(group.memberIds,[residents[0].id,residents[2].id]);
  assert.equal(allocationGroups(state).length,1);
  residents[2].alive=false;
  assert.ok(allocationGroups(state)[0].memberIds.includes(residents[2].id),'inactive historical member remains in saved roster group');
  assert.throws(()=>saveResourceAllocationGroup(state,'Broken group',['person:does-not-exist']),/unknown roster member/i);
});

test('ration rule can target a saved group and a specific food lot or subtype', async()=>{
  const {state}=await initial(92002);
  const residents=state.agents.filter((agent)=>agent.alive&&!agent.expeditionId).slice(0,2);
  const group=saveResourceAllocationGroup(state,'Hunters',residents.map((agent)=>agent.id));
  const foodLot=resourceLots(state,'food')[0];
  assert.ok(foodLot);
  const rule=saveResourceAllocationRule(state,{
    name:'Hunters first meat ration', groupId:group.id, resourceKey:'food', lotIds:[foodLot.id], subtypes:[foodLot.subtype], amountPerPersonPerDay:1.25, priority:90, exclusive:true, enabled:true,
  });
  assert.equal(rule.groupId,group.id);
  assert.deepEqual(rule.lotIds,[foodLot.id]);
  assert.deepEqual(rule.subtypes,[foodLot.subtype]);
  assert.equal(rule.amountPerPersonPerDay,1.25);
  assert.equal(rule.exclusive,true);
  assert.throws(()=>saveResourceAllocationRule(state,{name:'Missing',groupId:'ration-group:missing',resourceKey:'food',amountPerPersonPerDay:1}),/unknown allocation group/i);
});

test('saved roster groups and ration rules survive schemaVersion 1 JSON save/load', async()=>{
  const {state}=await initial(92003);
  const residents=state.agents.filter((agent)=>agent.alive&&!agent.expeditionId).slice(0,2);
  const group=saveResourceAllocationGroup(state,'Clinic priority',residents.map((agent)=>agent.id));
  saveResourceAllocationRule(state,{name:'Clean water priority',groupId:group.id,resourceKey:'water',subtypes:[],lotIds:[],amountPerPersonPerDay:2.5,priority:100,exclusive:false,enabled:true});
  const restored=importSandboxSave(JSON.stringify(state));
  assert.equal(allocationGroups(restored).find((entry)=>entry.id===group.id)?.name,'Clinic priority');
  assert.equal(allocationRules(restored).find((entry)=>entry.groupId===group.id)?.resourceKey,'water');
});

test('exclusive meat rule feeds only the saved group from the selected meat subtype', async()=>{
  const {state}=await initial(92004);
  const ledger=state.resourceLedger;
  assert.ok(ledger);
  const people=state.agents.filter((agent)=>agent.alive&&!agent.expeditionId).slice(0,3);
  assert.equal(people.length,3);
  const plant=resourceLots(state,'food')[0];
  plant.subtype='food:plant:test'; plant.label='test plant staple'; plant.quantity=30;
  state.settlement.resources.food=30;
  const {recordResourceProduction,distributeDailyConsumable,syncSettlementResourceAggregates}=await import('../.test-dist/sandbox/resourceLedger.js');
  const meat=recordResourceProduction(state,{resourceKey:'food',amount:4,sourceId:plant.sourceId,subtype:'meat:test-wild-game',label:'test wild-game meat'});
  syncSettlementResourceAggregates(state);
  const group=saveResourceAllocationGroup(state,'Hunters',[people[0].id,people[1].id]);
  saveResourceAllocationRule(state,{name:'Hunters meat',groupId:group.id,resourceKey:'food',subtypes:['meat:test-wild-game'],amountPerPersonPerDay:1,priority:100,exclusive:true,enabled:true});
  const result=distributeDailyConsumable(state,'food',Object.fromEntries(people.map((agent)=>[agent.id,1])),24);
  assert.equal(result[people[0].id].allocated,1);
  assert.equal(result[people[1].id].allocated,1);
  assert.equal(result[people[2].id].allocated,1);
  const event=state.resourceLedger.recentDistributions.at(-1);
  assert.ok(event);
  const meatRecipients=new Set(event.lines.filter((line)=>line.lotId===meat.id).map((line)=>line.agentId));
  assert.deepEqual([...meatRecipients].sort(),[people[0].id,people[1].id].sort());
  assert.equal(resourceLots(state,'food').find((lot)=>lot.id===meat.id)?.quantity,2);
});

test('without ration rules scarce stock is shared proportionally like the previous settlement-wide access fraction', async()=>{
  const {state}=await initial(92005);
  const people=state.agents.filter((agent)=>agent.alive&&!agent.expeditionId).slice(0,3);
  const foodLots=resourceLots(state,'food');
  foodLots[0].quantity=1.5;
  for(const lot of foodLots.slice(1)) lot.quantity=0;
  const {distributeDailyConsumable,syncSettlementResourceAggregates}=await import('../.test-dist/sandbox/resourceLedger.js');
  syncSettlementResourceAggregates(state);
  const result=distributeDailyConsumable(state,'food',Object.fromEntries(people.map((agent)=>[agent.id,1])),24);
  for(const person of people){
    assert.ok(Math.abs(result[person.id].fraction-0.5)<1e-9);
    assert.ok(Math.abs(result[person.id].allocated-0.5)<1e-9);
  }
  assert.ok(state.settlement.resources.food<1e-9);
});

test('water allocation rules can prioritize a saved roster group and distribution history records exact recipients', async()=>{
  const {state}=await initial(92006);
  const people=state.agents.filter((agent)=>agent.alive&&!agent.expeditionId).slice(0,3);
  const group=saveResourceAllocationGroup(state,'Clinic',[people[0].id]);
  saveResourceAllocationRule(state,{name:'Clinic water',groupId:group.id,resourceKey:'water',amountPerPersonPerDay:2.5,priority:100,exclusive:false,enabled:true});
  const {distributeDailyConsumable}=await import('../.test-dist/sandbox/resourceLedger.js');
  const result=distributeDailyConsumable(state,'water',Object.fromEntries(people.map((agent)=>[agent.id,2.5])),24);
  assert.equal(result[people[0].id].allocated,2.5);
  assert.ok(result[people[0].id].fraction>0.8 && result[people[0].id].fraction<=1);
  const event=state.resourceLedger.recentDistributions.at(-1);
  assert.ok(event.lines.some((line)=>line.agentId===people[0].id));
});


test('save validation rejects malformed resource lots and broken resource references', async()=>{
  const {state}=await initial(92007);
  const negative=structuredClone(state);
  negative.resourceLedger.lots[0].quantity=-1;
  assert.throws(()=>importSandboxSave(JSON.stringify(negative)),/resourceLedger.*lot.*quantity/i);

  const missingSource=structuredClone(state);
  missingSource.resourceLedger.lots[0].sourceId='resource-source:missing';
  assert.throws(()=>importSandboxSave(JSON.stringify(missingSource)),/resourceLedger.*source/i);
});

test('save validation rejects ration groups with unknown roster members and rules with unknown groups', async()=>{
  const {state}=await initial(92008);
  const badMember=structuredClone(state);
  badMember.resourceLedger.allocationGroups.push({id:'ration-group:bad',name:'Bad',memberIds:['person:missing'],createdDay:1,createdMinuteOfDay:0,updatedDay:1,updatedMinuteOfDay:0});
  assert.throws(()=>importSandboxSave(JSON.stringify(badMember)),/resourceLedger.*group.*member/i);

  const badRule=structuredClone(state);
  badRule.resourceLedger.allocationRules.push({id:'ration-rule:bad',name:'Bad rule',groupId:'ration-group:missing',resourceKey:'food',lotIds:[],subtypes:[],amountPerPersonPerDay:1,priority:1,exclusive:false,enabled:true,createdDay:1,createdMinuteOfDay:0,updatedDay:1,updatedMinuteOfDay:0});
  assert.throws(()=>importSandboxSave(JSON.stringify(badRule)),/resourceLedger.*rule.*group/i);
});

test('legacy scalar save without resourceLedger migrates on import with exact aggregate totals', async()=>{
  const {state}=await initial(92009);
  const expected=structuredClone(state.settlement.resources);
  delete state.resourceLedger;
  const restored=importSandboxSave(JSON.stringify(state));
  assert.ok(restored.resourceLedger);
  assert.deepEqual(restored.settlement.resources,expected);
  for(const [key,amount] of Object.entries(expected)){
    const total=restored.resourceLedger.lots.filter((lot)=>lot.resourceKey===key).reduce((sum,lot)=>sum+lot.quantity,0);
    assert.equal(total,amount,`migrated ${key} total remains exact`);
  }
});

test('replay hash includes resource ledger allocation state', async()=>{
  const a=await initial(92010);
  const b=await initial(92010);
  const residentA=a.state.agents.find((agent)=>agent.alive&&!agent.expeditionId);
  const residentB=b.state.agents.find((agent)=>agent.id===residentA.id);
  const common={id:'ration-group:replay',memberIds:[residentA.id],createdDay:1,createdMinuteOfDay:0,updatedDay:1,updatedMinuteOfDay:0};
  a.state.resourceLedger.allocationGroups=[{...common,name:'Alpha'}];
  b.state.resourceLedger.allocationGroups=[{...common,memberIds:[residentB.id],name:'Beta'}];
  await advanceSandboxHours(a.provider,a.state,1);
  await advanceSandboxHours(b.provider,b.state,1);
  assert.notEqual(a.state.diagnostics.replayHash,b.state.diagnostics.replayHash);
});

test('a ration rule bound to a specific lot follows its processed descendant', async()=>{
  const {state}=await initial(92011);
  const residents=state.agents.filter((agent)=>agent.alive&&!agent.expeditionId).slice(0,1);
  const group=saveResourceAllocationGroup(state,'Processed meal target',[residents[0].id]);
  const lot=resourceLots(state,'food')[0];
  const rule=saveResourceAllocationRule(state,{name:'Specific lot',groupId:group.id,resourceKey:'food',lotIds:[lot.id],amountPerPersonPerDay:1,exclusive:true});
  const {processResourceLot}=await import('../.test-dist/sandbox/resourceLedger.js');
  const derived=processResourceLot(state,lot.id,'cooked',[state.settlement.leaderId]);
  assert.deepEqual(rule.lotIds,[derived.id]);
});

test('stale or contaminated lots provide less effective daily fulfillment than fresh clean lots', async()=>{
  const {state}=await initial(92012);
  const resident=state.agents.find((agent)=>agent.alive&&!agent.expeditionId);
  assert.ok(resident);
  const lots=resourceLots(state,'food');
  assert.ok(lots[0]);
  for(const lot of lots){ lot.quantity=0; }
  const base=lots[0];
  base.quantity=2;
  base.freshness=0.3;
  base.condition=0.5;
  base.contaminationRisk=0.6;
  state.settlement.resources.food=2;
  const {distributeDailyConsumable}=await import('../.test-dist/sandbox/resourceLedger.js');
  const result=distributeDailyConsumable(state,'food',{[resident.id]:1},24)[resident.id];
  assert.equal(result.allocated,1);
  assert.ok(result.fraction<0.7,`quality-adjusted fulfillment should be reduced, got ${result.fraction}`);
  assert.ok(result.contaminationExposure>0.4);
});

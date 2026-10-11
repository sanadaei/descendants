import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { ContentPackRegistry, WorldgenEngine, parseWorldRecipe } from '../vendor/i2x-worldgen-runtime/dist/index.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { ensureDailyLoopState } from '../.test-dist/sandbox/dailyActionLoop.js';
import { advanceSandbox } from '../.test-dist/sandbox/engine.js';
import { addExpeditionOrder, launchExpedition } from '../.test-dist/sandbox/expeditionSimulation.js';
import { ensureDirectPlayState, reserveDirectActivity } from '../.test-dist/sandbox/directPlay.js';
import { archiveInquiryEvaluation, createExplorationInquiry, readableEvaluations, surveyInquiry, trialInquiryProcedure, visibleInquiries } from '../.test-dist/sandbox/explorationInquiry.js';
import { accessibleArtifactRecords, collectArtifactRecord, decodeArtifactRecord, readableEvidenceText } from '../.test-dist/sandbox/loreArtifacts.js';
import { adoptLegacyProject, projectPrerequisites, setLegacyProjectWorkers, simulateLegacyProjects, startLegacyProject } from '../.test-dist/sandbox/legacyProject.js';
import { legacyFacilityActive } from '../.test-dist/sandbox/legacyProjectBenefits.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord, simulateKnowledgeInterval } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { depositCarriedResourcesAtSettlement, harvestGeneratedResource, observeGeneratedEntity, spatialDistanceKm } from '../.test-dist/sandbox/localExploration.js';
import { recordAgentDeath } from '../.test-dist/sandbox/lifeCourseSimulation.js';
import { knownMapLocation } from '../.test-dist/sandbox/knowledgeSpatial.js';
import { naturalDeathDay } from '../.test-dist/sandbox/aging.js';
import { startResearchProject, simulateResearchInterval } from '../.test-dist/sandbox/researchSimulation.js';
import { adjustResourceStock, processResourceLot, resourceLotTotal } from '../.test-dist/sandbox/resourceLedger.js';
import { simulateSettlementInterval } from '../.test-dist/sandbox/settlementSimulation.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { SandboxApp } from '../.test-dist/sandbox/app.js';
import { pdaAudio } from '../.test-dist/sandbox/pdaAudio.js';
import { renderInquiryPanel } from '../.test-dist/sandbox/ui/inquiryView.js';
import { renderLegacyProjectPanel } from '../.test-dist/sandbox/ui/legacyProjectView.js';

const summary = (state) => ({ from: {...state.clock}, to: {...state.clock}, births: [], deaths: [], leadershipChanges: [], expeditionUpdates: [], encounterUpdates: [], knowledgeUpdates: [], settlementUpdates: [] });
async function fixture(seed=20261012) {
  const provider = new MockWorldProvider(), state = await createInitialSandboxState(provider,{seed,population:14});
  ensureDirectPlayState(state);
  for(const agent of state.agents){agent.health=100;agent.fatigue=0;agent.pathology=[];}
  return {provider,state,actor:state.agents.find((agent)=>agent.id===state.settlement.leaderId)};
}
function entity(state,kind='ecological-resource',id='field:water') {
  return {id,kind,subtype:kind==='ecological-resource'?'freshwater':'ruin',spatial:{...state.settlement.position},components:kind==='ecological-resource'?{resourceKind:'freshwater',renewable:true,currentStock:100,carryingStock:100,regenerationPerDay:1}:{traceType:'ruin',conditionIndex:.8,originEventId:'HIDDEN-TRUTH',originTick:999},provenanceIds:[]};
}
function projection(state,entities,relations=[]) {return {tick:state.clock.worldTick,effectiveDetailRank:0,entities,relations,aggregates:[],observationIds:[]};}
function prediction(state,actor,target,expected='water-source',radius=.35) {
  const basis = addObservedKnowledge(state,[actor.id],[target.id],JSON.stringify({interpretation:'cartographic-estimate',regionId:target.id,estimatedCenter:{x:target.spatial.x,y:target.spatial.y},uncertaintyRadiusKm:radius}),.4,undefined,[],{promoteToSettlement:false});
  return createExplorationInquiry(state,actor.id,[basis.id],target,expected,'証言を現地で確かめる。');
}
function completeResearch(state,sourceId,actorId) {const project=startResearchProject(state,sourceId,[actorId]);project.progress=99.9;simulateResearchInterval(state,24,summary(state));assert.equal(project.status,'completed');return project;}
async function waterLoop() {
  const f=await fixture();const water=entity(f.state),inquiry=prediction(f.state,f.actor,water);
  f.provider.queryArea=async()=>projection(f.state,[water]);await surveyInquiry(f.provider,f.state,f.actor.id,inquiry.id);
  harvestGeneratedResource(f.state,f.actor.id,water,'water',5);depositCarriedResourcesAtSettlement(f.state,[f.actor.id]);
  const trial=trialInquiryProcedure(f.state,f.actor.id,inquiry.id,'boiled');completeResearch(f.state,trial.knowledgeId,f.actor.id);
  return {...f,water,inquiry,trial};
}
function readingLoop(state,actor) {
  const trace=entity(state,'historical-trace','trace:readable');
  const basis=addObservedKnowledge(state,[actor.id],[trace.id],JSON.stringify({interpretation:'testimony',assertedEventClass:'settlement-abandoned'}),.4);
  const item=collectArtifactRecord(state,actor.id,trace.id,projection(state,[trace]));let decoded;
  for(let i=0;i<20&&!decoded;i++)decoded=decodeArtifactRecord(state,actor.id,item.id);
  assert.ok(decoded);return {trace,basis,item,decoded};
}
function fundAndFinish(state,project) {
  for(const phase of project.phases){for(const [key,amount]of Object.entries(phase.materials))adjustResourceStock(state,key,amount,'test phase budget');phase.requiredHours=1;}
  state.clock.minuteOfDay=1000;state.clock.day+=2;
  for(let i=0;i<9&&project.status!=='completed';i++)simulateLegacyProjects(state,24,summary(state));
  assert.equal(project.status,'completed');
}
let realFixture;
async function generated() {return realFixture??=(async()=>{
  const root=new URL('../vendor/i2x-worldgen-runtime/setting-packs/descendants/',import.meta.url),raw=JSON.parse(fs.readFileSync(new URL('default.recipe.json',root),'utf8')),content=new ContentPackRegistry();
  for(const ref of raw.contentPacks)content.register(JSON.parse(fs.readFileSync(new URL(`content-packs/${ref.id}.json`,root),'utf8')));
  const provider=await new WorldgenEngine(undefined,content).generate(parseWorldRecipe(JSON.stringify(raw))),state=await createInitialSandboxState(provider);
  return {provider,state,recipe:parseWorldRecipe(JSON.stringify(raw)),content};
})();}

test('real generated world: a water lead, physical round trip, measured trial, research and persistent charter',async()=>{
  const {provider,state:base}=await generated(),state=structuredClone(base);ensureDirectPlayState(state);
  const snapshot=await provider.exportSnapshot(2),water=snapshot.entities.filter((e)=>e.kind==='ecological-resource'&&e.subtype==='freshwater').sort((a,b)=>spatialDistanceKm(a.spatial,state.settlement.position)-spatialDistanceKm(b.spatial,state.settlement.position))[0];
  const actor=state.agents.find((a)=>a.id===state.settlement.leaderId);actor.health=100;actor.fatigue=0;actor.pathology=[];
  actor.authority.obedience=100;actor.authority.refusalThreshold=0;actor.morale=100;
  const inquiry=prediction(state,actor,water);
  const expedition=launchExpedition(state,{leaderId:actor.id,memberIds:[actor.id],destination:inquiry.center,doctrineId:state.doctrines[0].id,supplies:{food:12,water:18,medicine:2,tools:2},controlMode:'settlement'});
  for(let i=0;i<16&&expedition.status==='outbound';i++)await advanceSandbox(provider,state,60);
  assert.equal(expedition.status,'exploring');assert.ok(spatialDistanceKm(expedition.position,water.spatial)<=.35);
  const evaluation=await surveyInquiry(provider,state,actor.id,inquiry.id);assert.equal(evaluation.outcome,'supports');assert.ok(evaluation.observedEntityIds.includes(water.id));
  const stock=resourceLotTotal(state,'water');harvestGeneratedResource(state,actor.id,water,'water',5);assert.equal(resourceLotTotal(state,'water'),stock);
  assert.throws(()=>trialInquiryProcedure(state,actor.id,inquiry.id,'boiled'),/拠点/);
  addExpeditionOrder(state,expedition.id,'return','Bring the physical water home.');
  for(let i=0;i<24&&expedition.status!=='returned';i++)await advanceSandbox(provider,state,60);
  assert.equal(expedition.status,'returned',JSON.stringify(expedition.orders));assert.equal(actor.expeditionId,null);
  const returned=state.resourceLedger.lots.find((lot)=>lot.worldEntityIds.includes(water.id)&&lot.quantity>=1);assert.ok(returned);
  const total=resourceLotTotal(state,'water'),fuel=state.settlement.resources.fuel;
  const trial=trialInquiryProcedure(state,actor.id,inquiry.id,'boiled');assert.equal(resourceLotTotal(state,'water'),total);assert.ok(Math.abs(state.settlement.resources.fuel-(fuel-.1))<1e-6);
  assert.ok(trial.after.microbialRisk<trial.before.microbialRisk);assert.equal(trial.after.chemicalRisk,trial.before.chemicalRisk);
  completeResearch(state,trial.knowledgeId,actor.id);assert.equal(projectPrerequisites(state,actor.id,'waterworks').length,2);
  const project=startLegacyProject(state,actor.id,'waterworks'),restored=importSandboxSave(JSON.stringify(state));
  assert.deepEqual(restored.inquiries,state.inquiries);assert.deepEqual(restored.legacyProjects,state.legacyProjects);assert.equal(restored.records.find((r)=>r.id===project.recordId).knowledgeIds.length,3);
});

test('partial searches, unavailable context and out-of-range provider entities cannot refute or support a lead',async()=>{
  const {state,provider,actor}=await fixture(),water=entity(state),inquiry=prediction(state,actor,water,'water-source',5);
  provider.queryArea=async()=>projection(state,[{...water,spatial:{...water.spatial,x:water.spatial.x+2}}]);
  const report=await surveyInquiry(provider,state,actor.id,inquiry.id);assert.equal(report.outcome,'inconclusive');assert.deepEqual(report.observedEntityIds,[]);
  inquiry.radiusKm=.35;assert.equal((await surveyInquiry(provider,state,actor.id,inquiry.id)).outcome,'contradicts');
  actor.expeditionId='missing:field';await assert.rejects(surveyInquiry(provider,state,actor.id,inquiry.id),/居場所/);
  actor.expeditionId=null;inquiry.center.x+=20;await assert.rejects(surveyInquiry(provider,state,actor.id,inquiry.id),/移動/);
});

test('predictions retain contrary observations; revisions do not overwrite them',async()=>{
  const {state,provider,actor}=await fixture(),water=entity(state),prior=prediction(state,actor,water,'ruin');provider.queryArea=async()=>projection(state,[water]);
  assert.equal((await surveyInquiry(provider,state,actor.id,prior.id)).outcome,'contradicts');
  const revised=createExplorationInquiry(state,actor.id,[prior.knowledgeId],water,'water-source','水源という別の読みを試す。',prior.id);
  assert.equal((await surveyInquiry(provider,state,actor.id,revised.id)).outcome,'supports');assert.equal(prior.prediction,'ruin');assert.equal(prior.evaluations[0].outcome,'contradicts');
  const roundtrip=importSandboxSave(JSON.stringify(state));assert.equal(roundtrip.inquiries[1].revisesId,prior.id);
});

test('a shared journal preserves an estimated area and can be revised after its original memory is lost',async()=>{
  const {state,actor}=await fixture(),water=entity(state),inquiry=prediction(state,actor,water,'water-source',5);
  state.knowledge.find(k=>k.id===inquiry.basisKnowledgeIds[0]).lost=true;
  const hidden={...water,spatial:{...water.spatial,x:9999}};
  assert.deepEqual(knownMapLocation(state,actor.id,hidden).position,inquiry.center);assert.equal(knownMapLocation(state,actor.id,hidden).uncertaintyRadiusKm,5);
  const revised=createExplorationInquiry(state,actor.id,[inquiry.knowledgeId],hidden,'ruin','ノートから別の読みを試す。',inquiry.id);
  assert.deepEqual(revised.center,inquiry.center);assert.equal(revised.radiusKm,5);
});

test('archiving a prediction does not reveal remote results; returning observers can archive the source observations too',async()=>{
  const {state,provider,actor}=await fixture(),water=entity(state),inquiry=prediction(state,actor,water),other=state.agents.find((a)=>a.id!==actor.id);
  institutionalizeKnowledgeRecord(state,actor.id,inquiry.knowledgeId);provider.queryArea=async()=>projection(state,[water]);
  const expedition=launchExpedition(state,{leaderId:actor.id,memberIds:[actor.id],doctrineId:state.doctrines[0].id,controlMode:'settlement'});
  const report=await surveyInquiry(provider,state,actor.id,inquiry.id);assert.equal(visibleInquiries(state,other.id).length,1);assert.deepEqual(readableEvaluations(state,other.id,inquiry),[]);
  assert.throws(()=>archiveInquiryEvaluation(state,actor.id,inquiry.id,report.knowledgeId));
  expedition.status='returned';actor.expeditionId=null;actor.residence='settlement';archiveInquiryEvaluation(state,actor.id,inquiry.id,report.knowledgeId);
  assert.equal(readableEvaluations(state,other.id,inquiry).length,1);assert.ok(report.observationKnowledgeIds.every((id)=>state.settlement.localKnowledgeIds.includes(id)));
  harvestGeneratedResource(state,actor.id,water,'water',5);depositCarriedResourcesAtSettlement(state,[actor.id]);
  assert.ok(trialInquiryProcedure(state,other.id,inquiry.id,'filtered'));
});

test('a practical trial requires the right returned source and consumes only its one-litre aliquot',async()=>{
  const {state,provider,actor}=await fixture(),water=entity(state),inquiry=prediction(state,actor,water);provider.queryArea=async()=>projection(state,[water]);await surveyInquiry(provider,state,actor.id,inquiry.id);
  assert.throws(()=>trialInquiryProcedure(state,actor.id,inquiry.id,'boiled'),/持ち帰り/);
  const other=entity(state,'ecological-resource','other:water');harvestGeneratedResource(state,actor.id,other,'water',5);depositCarriedResourcesAtSettlement(state,[actor.id]);assert.throws(()=>trialInquiryProcedure(state,actor.id,inquiry.id,'boiled'),/持ち帰り/);
  harvestGeneratedResource(state,actor.id,water,'water',5);const [lot]=depositCarriedResourcesAtSettlement(state,[actor.id]);const before=structuredClone(lot),total=resourceLotTotal(state,'water');
  const trial=trialInquiryProcedure(state,actor.id,inquiry.id,'filtered');assert.equal(lot.quantity,4);assert.deepEqual(lot.waterQuality,before.waterQuality);assert.equal(resourceLotTotal(state,'water'),total);assert.equal(state.resourceLedger.lots.find((l)=>l.id===trial.outputLotId).quantity,1);
  adjustResourceStock(state,'fuel',-state.settlement.resources.fuel,'empty fuel');const saved=JSON.stringify(state);assert.throws(()=>trialInquiryProcedure(state,actor.id,inquiry.id,'boiled'),/不足/);assert.equal(JSON.stringify(state),saved);
});

test('readable lore uses held interpretations and physical descriptions without canonical origin truth',async()=>{
  const {state,actor}=await fixture(),{item,decoded}=readingLoop(state,actor);
  assert.match(decoded.claim,/集落の放棄/);assert.match(decoded.claim,/次の照合/);assert.doesNotMatch(decoded.claim,/HIDDEN-TRUTH|999|原作者は/);
  assert.ok(item.reading.leads.some((lead)=>lead.prediction==='ruin'));assert.ok(item.reading.fragments.some((fragment)=>fragment.includes('照合できる伝承')));
  const target=entity(state,'historical-trace','trace:readable');const next=createExplorationInquiry(state,actor.id,[decoded.id],target,item.reading.leads[0].prediction);assert.equal(next.prediction,'ruin');
  assert.deepEqual(importSandboxSave(JSON.stringify(state)).directPlay.inventory.find((e)=>e.id===item.id).reading,item.reading);
  assert.match(readableEvidenceText({claim:JSON.stringify({interpretation:'transmitted-lore',semanticTags:['exile','ancestor','hidden:catalog']})}),/流刑・祖先/);
});

test('real generated traces yield physical readings without opening hidden history catalogs',async()=>{
  const generatedFixture=await generated(),state=structuredClone(generatedFixture.state),provider=new WorldgenEngine(undefined,generatedFixture.content).fromSnapshot(generatedFixture.recipe,structuredClone(state.world.providerSnapshot));ensureDirectPlayState(state);const snapshot=await provider.exportSnapshot(2),trace=snapshot.entities.find((e)=>e.kind==='historical-trace'&&e.spatial),actor=state.agents.find((a)=>a.id===state.settlement.leaderId);
  actor.health=100;actor.fatigue=0;actor.pathology=[];const expedition=launchExpedition(state,{leaderId:actor.id,memberIds:[actor.id],doctrineId:state.doctrines[0].id,controlMode:'settlement'});expedition.position=structuredClone(trace.spatial);
  const area=await provider.queryArea({center:trace.spatial,radiusKm:.35,requestedDetailRank:0,observerId:actor.id,includeKnowledgeProjection:true});
  const item=collectArtifactRecord(state,actor.id,trace.id,area);assert.ok(item.reading.fragments.length);assert.ok(item.reading.leads.length);
  assert.doesNotMatch(JSON.stringify(item.reading),/originEventId|originTick|biography/);
  if(trace.components.originEventId)assert.ok(!JSON.stringify(item.reading).includes(trace.components.originEventId));
});

test('an inherited physical rubbing can be reread without inheriting its former reader’s memory',async()=>{
  const {state,actor}=await fixture(),{item,decoded}=readingLoop(state,actor);recordAgentDeath(state,actor,'old age / natural lifespan');
  simulateKnowledgeInterval(state,1,summary(state));assert.equal(decoded.lost,true);const heir=state.agents.find((a)=>a.id===item.ownerId);assert.notEqual(heir.id,actor.id);assert.ok(accessibleArtifactRecords(state,heir.id).some((i)=>i.id===item.id));
  const reread=decodeArtifactRecord(state,heir.id,item.id);assert.ok(reread);assert.notEqual(reread.id,decoded.id);assert.equal(reread.lost,false);assert.equal(reread.holderIds[0],heir.id);
});

test('unread, distant and foreign-owned artifact copies are unavailable',async()=>{
  const {state,actor}=await fixture(),trace=entity(state,'historical-trace'),other=state.agents.find((a)=>a.id!==actor.id);trace.spatial.x+=2;
  assert.throws(()=>collectArtifactRecord(state,actor.id,trace.id,projection(state,[trace])),/近づいて/);trace.spatial.x-=2;
  const item=collectArtifactRecord(state,actor.id,trace.id,projection(state,[trace]));assert.equal(decodeArtifactRecord(state,actor.id,item.id),null);assert.throws(()=>decodeArtifactRecord(state,other.id,item.id),/携行/);assert.deepEqual(projectPrerequisites(state,actor.id,'archive'),[]);
});

test('projects require actual trial research or a decoded physical record',async()=>{
  const {state,actor}=await fixture();assert.throws(()=>startLegacyProject(state,actor.id,'waterworks'));assert.throws(()=>startLegacyProject(state,actor.id,'archive'));
  readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'archive');assert.equal(project.phases.length,3);assert.throws(()=>startLegacyProject(state,actor.id,'archive'),/既に/);
  const remote=state.agents.find((a)=>a.id!==actor.id);remote.residence='external';assert.throws(()=>adoptLegacyProject(state,remote.id,project.id),/現地/);
});

test('phases commit material lots once and reserve working time after direct activity and education',async()=>{
  const {state,actor}=await fixture();readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'archive');state.clock.day+=2;state.clock.minuteOfDay=0;
  const wood=state.settlement.resources.timber,first=simulateLegacyProjects(state,24,summary(state));assert.equal(first.get(actor.id),1);assert.ok(Math.abs(state.settlement.resources.timber-(wood-20))<1e-6);assert.ok(project.phases[0].committed.length);
  const recorded=structuredClone(project.phases[0].committed);simulateLegacyProjects(state,24,summary(state));assert.ok(Math.abs(state.settlement.resources.timber-(wood-20))<1e-6);assert.deepEqual(project.phases[0].committed,recorded);
  reserveDirectActivity(state,[actor.id],'records',24*60,'fully occupied');state.clock.day++;
  assert.equal(simulateLegacyProjects(state,24,summary(state)).size,0);assert.equal(simulateLegacyProjects(state,24,summary(state),new Map([[actor.id,24]])).size,0);
});

test('project work reduces ordinary daily labor rather than producing free progress',async()=>{
  const {state,actor}=await fixture();readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'archive');state.clock.day+=2;project.phases[0].funded=false;
  const loop=ensureDailyLoopState(state);loop.phase='executing';loop.currentPlan.assignments=state.agents.filter(a=>a.alive).map(a=>({agentId:a.id,task:'water'}));
  const paused=structuredClone(state);paused.legacyProjects[0].status='paused';simulateSettlementInterval(state,24,summary(state));simulateSettlementInterval(paused,24,summary(paused));
  assert.ok(project.phases[0].workHours>0);assert.ok(state.settlement.resources.water<paused.settlement.resources.water,'assigned project time must reduce subsistence output');
});

test('absent, sick or resource-starved workers do not invest materials or advance projects',async()=>{
  for(const mode of ['absent','sick','materials']){
    const {state,actor}=await fixture();readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'archive');state.clock.day+=2;
    if(mode==='absent')actor.residence='external';if(mode==='sick')actor.pathology=[{id:'case:severe',pathologyId:'test',status:'active',severity:90}];if(mode==='materials')adjustResourceStock(state,'timber',-state.settlement.resources.timber,'no material');
    const before=state.settlement.resources.scrap;assert.equal(simulateLegacyProjects(state,24,summary(state)).size,0);assert.equal(project.phases[0].funded,false);assert.equal(state.settlement.resources.scrap,before);assert.ok(project.pauseReason);
  }
});

test('natural death, save/reload and a descendant’s stewardship preserve roots, equipment and credits',async()=>{
  const {state,provider,actor}=await fixture();readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'archive');state.clock.day+=2;simulateLegacyProjects(state,24,summary(state));
  const child=state.agents.find((a)=>a.id!==actor.id);child.parentIds=[actor.id];
  state.clock.day=naturalDeathDay(state,actor)-1;child.bornDay=state.clock.day-22*365;state.clock.minuteOfDay=1430;
  const prior=structuredClone(project);await advanceSandbox(provider,state,60);assert.equal(actor.alive,false);assert.match(actor.causeOfDeath,/natural/);
  const loaded=importSandboxSave(JSON.stringify(state)),inherited=loaded.legacyProjects[0];assert.ok(inherited.knowledgeIds.every((id)=>loaded.knowledge.some((k)=>k.id===id&&!k.lost)));
  assert.deepEqual(inherited.phases[0].committed,prior.phases[0].committed);assert.ok(inherited.phases[0].workHours>=prior.phases[0].workHours);
  adoptLegacyProject(loaded,child.id,inherited.id);setLegacyProjectWorkers(loaded,child.id,inherited.id,[child.id]);const before=inherited.phases[0].workHours;simulateLegacyProjects(loaded,24,summary(loaded));assert.ok(inherited.phases[0].workHours>before);
  assert.equal(inherited.stewardHistory.length,2);assert.ok(inherited.contributors.some((c)=>c.agentId===actor.id));assert.ok(inherited.contributors.some((c)=>c.agentId===child.id));
  assert.deepEqual(importSandboxSave(JSON.stringify(loaded)).legacyProjects,loaded.legacyProjects);
});

test('completed waterworks changes real filtration, preserving chemical risk and requiring retained records',async()=>{
  const {state,actor,water}=await waterLoop(),project=startLegacyProject(state,actor.id,'waterworks');fundAndFinish(state,project);assert.equal(legacyFacilityActive(state,'waterworks'),true);
  harvestGeneratedResource(state,actor.id,water,'water',5);const [lot]=depositCarriedResourcesAtSettlement(state,[actor.id]),base=structuredClone(state);base.legacyProjects[0].status='paused';
  const boosted=processResourceLot(state,lot.id,'filtered',[actor.id]),normal=processResourceLot(base,lot.id,'filtered',[actor.id]);assert.ok(boosted.waterQuality.microbialRisk<normal.waterQuality.microbialRisk);assert.ok(boosted.waterQuality.turbidity<normal.waterQuality.turbidity);assert.equal(boosted.waterQuality.chemicalRisk,normal.waterQuality.chemicalRisk);
  assert.deepEqual(importSandboxSave(JSON.stringify(state)).legacyProjects,state.legacyProjects);state.records.find((r)=>r.id===project.recordId).integrity=0;assert.equal(legacyFacilityActive(state,'waterworks'),false);
});

test('completed archive halves existing record decay; dead charter records are retained as project history',async()=>{
  const {state,actor}=await fixture();readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'archive');fundAndFinish(state,project);const base=structuredClone(state),record=state.records.find((r)=>r.id===project.recordId);base.legacyProjects[0].status='paused';
  const original=record.integrity;simulateKnowledgeInterval(state,24,summary(state));simulateKnowledgeInterval(base,24,summary(base));const normal=base.records.find((r)=>r.id===project.recordId);
  assert.ok(Math.abs((original-record.integrity)*2-(original-normal.integrity))<1e-10);
  record.integrity=0;for(let i=0;i<310;i++)state.records.push({...record,id:`record:trash:${i}`});simulateKnowledgeInterval(state,1,summary(state));assert.ok(state.records.some((r)=>r.id===project.recordId));assert.ok(importSandboxSave(JSON.stringify(state)));
});

test('new optional save state rejects corrupt radii, reading progress, trial lots and project commitments',async()=>{
  const {state,actor,inquiry}=await waterLoop();readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'waterworks');state.clock.day+=2;simulateLegacyProjects(state,24,summary(state));assert.ok(importSandboxSave(JSON.stringify(state)));
  const mutations=[s=>s.inquiries[0].radiusKm=-1,s=>s.inquiries[0].trials[0].outputLotId='missing',s=>s.inquiries[0].revisesId=inquiry.id,s=>s.directPlay.inventory.find(i=>i.reading).reading.spentMinutes=-1,s=>s.legacyProjects[0].phases[0].committed[0].quantity+=1,s=>s.legacyProjects[0].stewardId='missing'];
  for(const mutate of mutations){const corrupt=structuredClone(state);mutate(corrupt);assert.throws(()=>importSandboxSave(JSON.stringify(corrupt)));}
  assert.ok(project.phases[0].funded);
});

test('replay hashes cover inquiry goals, physical reading contents and project state',async()=>{
  const {state,actor}=await fixture(),water=entity(state);prediction(state,actor,water);readingLoop(state,actor);startLegacyProject(state,actor.id,'archive');
  for(const mutate of [s=>s.inquiries[0].radiusKm+=1,s=>s.directPlay.inventory.find(i=>i.reading).reading.fragments.push('別の読み'),s=>s.legacyProjects[0].status='paused']){
    const a=structuredClone(state),b=structuredClone(state);mutate(b);await advanceSandbox(new MockWorldProvider(),a,60);await advanceSandbox(new MockWorldProvider(),b,60);assert.notEqual(a.diagnostics.replayHash,b.diagnostics.replayHash);
  }
});

test('UI shows readable roots and practical controls without exposing unshared observations or remote deaths',async()=>{
  const {state,provider,actor}=await fixture(),water=entity(state),inquiry=prediction(state,actor,water);provider.queryArea=async()=>projection(state,[water]);await surveyInquiry(provider,state,actor.id,inquiry.id);institutionalizeKnowledgeRecord(state,actor.id,inquiry.knowledgeId);
  const other=state.agents.find(a=>a.id!==actor.id),ctx={state,knowledgeAgent:()=>other,visibleWorldEntities:()=>[water],selectedWorldEntity:()=>water};const html=renderInquiryPanel(ctx);assert.match(html,/data-action="inquiry-create"/);assert.match(html,/未照合/);assert.doesNotMatch(html,/観測と一致|inquiry-archive-report/);
  readingLoop(state,actor);const project=startLegacyProject(state,actor.id,'archive');actor.expeditionId='remote';actor.alive=false;const projectHtml=renderLegacyProjectPanel(ctx);assert.match(projectHtml,/現地に担い手がいない/);assert.doesNotMatch(projectHtml,/死亡|後任の引継ぎが必要/);assert.ok(projectHtml.includes(project.name));
});

test('real event routes create and survey an inquiry asynchronously, select its area, and roll back failed trials',async(t)=>{
  const {state,provider,actor}=await fixture(),water=entity(state);observeGeneratedEntity(state,actor.id,water);const basis=state.knowledge.at(-1),trace=entity(state,'historical-trace','trace:ui'),area=projection(state,[water,trace]);t.mock.method(provider,'queryArea',async()=>area);
  t.mock.method(SandboxApp.prototype,'render',()=>{});for(const method of ['unlock','playClick','playConfirm'])t.mock.method(pdaAudio,method,()=>{});
  const saved=Object.fromEntries(['window','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),handlers={},controls={'[data-inquiry-target]':water.id,'[data-inquiry-basis]':basis.id,'[data-inquiry-second]':'','[data-inquiry-prediction]':'water-source','[data-inquiry-note]':'確かめる'};const root={addEventListener:(kind,handler)=>handlers[kind]=handler,querySelector:selector=>selector in controls?{value:controls[selector]}:null};
  globalThis.window={addEventListener(){},setTimeout(){return 0;},clearTimeout(){},localStorage:{getItem:()=>null}};globalThis.document={addEventListener(){}};
  try{
    const app=new SandboxApp(root,provider,{mode:'volatile',save:async()=>{}},state);await new Promise(resolve=>setImmediate(resolve));
    const click=async(action,data={},card)=>{handlers.click({target:{closest:()=>({dataset:{action,...data},closest:()=>card})}});for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
    await click('inquiry-create');assert.equal(state.inquiries.length,1);assert.equal(state.clock.minuteOfDay,370);const inquiry=state.inquiries[0];
    await click('inquiry-survey',{inquiryId:inquiry.id});assert.equal(inquiry.evaluations[0].outcome,'supports');assert.equal(state.clock.minuteOfDay,430);
    await click('inquiry-target',{inquiryId:inquiry.id});assert.deepEqual(app.viewContext().prepTarget,inquiry.center);assert.equal(app.viewContext().prepTargetEntityId,'');
    const before=JSON.stringify(state);await click('inquiry-trial',{inquiryId:inquiry.id,method:'boiled'});assert.equal(JSON.stringify(state),before);
    const revisionCard={querySelector:selector=>({value:selector==='[data-inquiry-revision]'?'ruin':'別の読み'})};await click('inquiry-revise',{inquiryId:inquiry.id},revisionCard);assert.equal(state.inquiries.at(-1).revisesId,inquiry.id);assert.equal(state.inquiries.at(-1).prediction,'ruin');
    const field=launchExpedition(state,{leaderId:actor.id,memberIds:[actor.id],controlMode:'expedition',doctrineId:state.doctrines[0].id});await app.refreshLocalProjection(true);
    await click('artifact-record',{entityId:trace.id});const item=state.directPlay.inventory.find(i=>i.reading);assert.ok(item);
    for(let i=0;i<15&&!item.reading.decodedKnowledgeId;i++)await click('artifact-decode',{itemId:item.id});assert.ok(item.reading.decodedKnowledgeId);
    await click('artifact-lead',{itemId:item.id,entityId:trace.id});assert.ok(state.inquiries.some(i=>i.basisKnowledgeIds.includes(item.reading.decodedKnowledgeId)));
    field.status='returned';const returnedActor=state.agents.find(a=>a.id===actor.id);returnedActor.expeditionId=null;returnedActor.residence='settlement';handlers.change({target:{closest:selector=>selector==='[data-action="knowledge-agent"]'?{value:actor.id}:null}});
    await click('legacy-start',{kind:'archive'});const project=state.legacyProjects[0];assert.ok(project);
    const workersCard={querySelectorAll:()=>[{dataset:{legacyWorker:actor.id}}]};await click('legacy-workers',{projectId:project.id},workersCard);assert.deepEqual(project.workerIds,[actor.id]);
    await click('legacy-pause',{projectId:project.id,paused:'1'});assert.equal(project.status,'paused');
  }finally{for(const [key,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

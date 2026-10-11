import assert from 'node:assert/strict';
import test from 'node:test';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { collectPhysicalSample, ensureDirectPlayState, reserveDirectActivity } from '../.test-dist/sandbox/directPlay.js';
import { startResearchProject, updateResearchParticipants, simulateResearchInterval } from '../.test-dist/sandbox/researchSimulation.js';
import { simulateSettlementInterval, simulateConceptionInterval } from '../.test-dist/sandbox/settlementSimulation.js';
import { ensureDailyLoopState } from '../.test-dist/sandbox/dailyActionLoop.js';
import { addGameMinutes } from '../.test-dist/worldbridge/worldClock.js';
import { recordAgentDeath } from '../.test-dist/sandbox/lifeCourseSimulation.js';
import { advanceSandbox } from '../.test-dist/sandbox/engine.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { scopedRandom } from '../.test-dist/sandbox/rng.js';
import { renderResearchProjects } from '../.test-dist/sandbox/ui/researchView.js';
import { SandboxApp } from '../.test-dist/sandbox/app.js';
import { pdaAudio } from '../.test-dist/sandbox/pdaAudio.js';

const summary = s => ({from:{...s.clock},to:{...s.clock},births:[],deaths:[],leadershipChanges:[],expeditionUpdates:[],encounterUpdates:[],knowledgeUpdates:[],settlementUpdates:[]});
async function fixture() {
  const provider = new MockWorldProvider(), state = await createInitialSandboxState(provider,{seed:20261013,population:14});
  ensureDirectPlayState(state);
  for (const a of state.agents) { a.health=100; a.fatigue=0; a.pathology=[]; a.bornDay=state.clock.day-25*365; a.currentPlan=null; }
  const actor=state.agents.find(a=>a.id===state.settlement.leaderId);
  const source=addObservedKnowledge(state,[actor.id],['resource:water'],'現地で測った水の管理手順',.72);
  institutionalizeKnowledgeRecord(state,actor.id,source.id); state.clock.day++;
  return {provider,state,actor,source,others:state.agents.filter(a=>a!==actor)};
}
function step(state,hours=24) { state.clock=addGameMinutes(state.clock,hours*60); return simulateResearchInterval(state,hours,summary(state)); }

test('recorded research survives its original investigator’s death and resumes without losing work',async()=>{
  const {state,actor,source,others}=await fixture(),project=startResearchProject(state,source.id,[actor.id]);step(state);
  const progress=project.progress,firstHours=project.contributors[0].hours;
  recordAgentDeath(state,actor,'test injury',summary(state));step(state);assert.equal(project.progress,progress);assert.match(project.pauseReason,/担当者/);
  const restored=importSandboxSave(JSON.stringify(state)),heir=others[0].id;
  updateResearchParticipants(restored,heir,project.id,[heir]);const resumed=restored.researchProjects[0];assert.equal(resumed.progress,progress);assert.equal(resumed.hypothesis,source.claim);
  step(restored);assert.ok(resumed.progress>progress);assert.equal(resumed.contributors.find(c=>c.agentId===actor.id).hours,firstHours);assert.ok(resumed.contributors.find(c=>c.agentId===heir).hours>0);
});

test('participant changes cannot grant an unrecorded memory to a successor',async()=>{
  const {state,actor,others}=await fixture();const privateSource=addObservedKnowledge(state,[actor.id],[],'まだ口頭でしか知らない観測',.6,undefined,[],{promoteToSettlement:false});
  const project=startResearchProject(state,privateSource.id,[actor.id]);step(state);const progress=project.progress;
  assert.throws(()=>updateResearchParticipants(state,others[0].id,project.id,[others[0].id]),/元の根拠を読める/);
  assert.throws(()=>updateResearchParticipants(state,actor.id,project.id,[others[0].id]),/保持者/);
  assert.equal(project.progress,progress);assert.deepEqual(project.researcherIds,[actor.id]);
  actor.expeditionId='remote';assert.throws(()=>updateResearchParticipants(state,actor.id,project.id,[others[0].id]),/同席者/);
});

test('missing samples can be replaced only by a returned physical sample with matching provenance',async()=>{
  const {state,actor,source,others}=await fixture();const water={id:'opaque:water',kind:'ecological-resource',spatial:{...state.settlement.position},components:{},provenanceIds:[]};
  source.requiresPhysicalSample=true;source.physicalEvidenceSourceEntityId=water.id;
  const original=collectPhysicalSample(state,actor.id,water),project=startResearchProject(state,source.id,[actor.id]);step(state);const progress=project.progress;original.quantity=0;
  collectPhysicalSample(state,actor.id,{...water,id:'other:water'});step(state);assert.equal(project.progress,progress);assert.match(project.pauseReason,/現物/);
  assert.throws(()=>updateResearchParticipants(state,actor.id,project.id,[others[0].id]),/対応する現物/);assert.equal(project.sampleItemId,original.id);
  const replacement=collectPhysicalSample(state,others[0].id,water);others[0].expeditionId='remote';assert.throws(()=>updateResearchParticipants(state,actor.id,project.id,[actor.id]),/現物/);
  others[0].expeditionId=null;updateResearchParticipants(state,actor.id,project.id,[actor.id]);assert.equal(project.sampleItemId,replacement.id);assert.equal(project.progress,progress);
  step(state);assert.ok(project.progress>progress);assert.equal(importSandboxSave(JSON.stringify(state)).researchProjects[0].sampleItemId,replacement.id);
});

test('changed or lost evidence requires a new hypothesis rather than rewriting ongoing progress',async()=>{
  for(const mode of ['changed','lost']) {
    const {state,actor,source,others}=await fixture(),project=startResearchProject(state,source.id,[actor.id]);step(state);const before=project.progress;
    if(mode==='lost')source.lost=true;else source.claim+='（別の観測で改訂）';
    assert.throws(()=>updateResearchParticipants(state,others[0].id,project.id,[others[0].id]),/元の根拠/);step(state);assert.equal(project.status,'abandoned');assert.equal(project.progress,before);
  }
});

test('research reserves actual hours after direct activity and other work, and shares its budget across projects',async()=>{
  const {state,actor,source}=await fixture();const first=startResearchProject(state,source.id,[actor.id]);
  const other=addObservedKnowledge(state,[actor.id],[],'別の根拠',.6),second=startResearchProject(state,other.id,[actor.id]);
  const used=step(state);assert.equal(used.get(actor.id),2);assert.equal(first.contributors[0].hours,2);assert.equal(second.progress,0);assert.match(second.pauseReason,/別の研究/);
  const before=first.progress;reserveDirectActivity(state,[actor.id],'records',24*60,'direct work');assert.equal(step(state).size,0);assert.equal(first.progress,before);
  reserveDirectActivity(state,[actor.id],'records',23*60,'partial direct work');state.clock=addGameMinutes(state.clock,1440);
  const partial=simulateResearchInterval(state,24,summary(state),new Map([[actor.id,.5]]));assert.equal(partial.get(actor.id),.5);assert.equal(first.contributors[0].hours,2.5);
});

test('an occupied oral-evidence holder cannot ground other investigators’ work for free',async()=>{
  for(const mode of ['direct-work','other-research']) {
    const {state,actor,source:recorded,others}=await fixture();
    if(mode==='other-research')startResearchProject(state,recorded.id,[actor.id]);
    const source=addObservedKnowledge(state,[actor.id],[],'口頭のみ',.6,undefined,[],{promoteToSettlement:false});
    const project=startResearchProject(state,source.id,[actor.id,others[0].id]);
    if(mode==='direct-work')reserveDirectActivity(state,[actor.id],'records',1440,'busy holder');step(state);
    assert.equal(project.progress,0,mode);assert.match(project.pauseReason,/保持者/);
  }
});

test('actual research reduces normal daily production rather than adding free progress',async()=>{
  const {state,source}=await fixture();const project=startResearchProject(state,source.id,state.agents.slice(0,3).map(a=>a.id));
  const loop=ensureDailyLoopState(state);loop.phase='executing';loop.currentPlan.assignments=state.agents.map(a=>({agentId:a.id,task:'water'}));
  const noResearch=structuredClone(state);noResearch.researchProjects[0].status='abandoned';
  simulateSettlementInterval(state,24,summary(state));simulateSettlementInterval(noResearch,24,summary(noResearch));
  assert.ok(project.progress>0);assert.ok(state.settlement.resources.water<noResearch.settlement.resources.water);assert.equal(project.contributors.reduce((n,c)=>n+c.hours,0),6);
});

test('children, severe illness, fatigue and remote residents cannot be reassigned or do research',async()=>{
  for(const mode of ['child','ill','fatigued','remote']) {
    const {state,actor,source,others}=await fixture(),worker=others[0],project=startResearchProject(state,source.id,[worker.id]);
    if(mode==='child')worker.bornDay=state.clock.day-10*365;
    if(mode==='ill')worker.health=20;
    if(mode==='fatigued')worker.fatigue=90;
    if(mode==='remote')worker.expeditionId='remote';
    assert.throws(()=>updateResearchParticipants(state,actor.id,project.id,[worker.id]),/作業できる/);step(state);assert.equal(project.progress,0);
  }
});

test('completion cannot give newly produced knowledge to dead or distant investigators',async()=>{
  const {state,actor,source,others}=await fixture(),project=startResearchProject(state,source.id,[actor.id,others[0].id,others[1].id]);
  recordAgentDeath(state,others[0],'test injury',summary(state));others[1].expeditionId='remote';project.progress=99.9;step(state);
  const result=state.knowledge.find(k=>k.id===project.resultKnowledgeId);assert.ok(result);assert.deepEqual(result.holderIds,[actor.id]);
  assert.ok(!others[0].knowledgeIds.includes(result.id));assert.ok(!others[1].knowledgeIds.includes(result.id));
});

test('research staff, contribution hours and conception slots persist, reject corrupt saves and affect replay hashes',async()=>{
  const {provider,state,actor,source,others}=await fixture();const project=startResearchProject(state,source.id,[actor.id]);step(state);simulateConceptionInterval(state,24);
  const restored=importSandboxSave(JSON.stringify(state));assert.deepEqual(restored.researchProjects,state.researchProjects);assert.equal(restored.lastConceptionCheckAbsoluteMinute,state.lastConceptionCheckAbsoluteMinute);
  const old=structuredClone(state);delete old.lastConceptionCheckAbsoluteMinute;delete old.researchProjects[0].contributors;delete old.researchProjects[0].pauseReason;assert.ok(importSandboxSave(JSON.stringify(old)));
  for(const mutate of [s=>s.researchProjects[0].contributors[0].hours=-1,s=>s.researchProjects[0].contributors[0].agentId='missing',s=>s.researchProjects[0].contributors.push(s.researchProjects[0].contributors[0]),s=>s.lastConceptionCheckAbsoluteMinute+=1,s=>s.lastConceptionCheckAbsoluteMinute=9999999]) {
    const broken=structuredClone(state);mutate(broken);assert.throws(()=>importSandboxSave(JSON.stringify(broken)));
  }
  for(const mutate of [s=>s.researchProjects[0].researcherIds.push(others[0].id),s=>s.researchProjects[0].contributors[0].hours+=1]) {
    const a=structuredClone(state),b=structuredClone(state);mutate(b);await advanceSandbox(new MockWorldProvider(),a,1);await advanceSandbox(new MockWorldProvider(),b,1);assert.notEqual(a.diagnostics.replayHash,b.diagnostics.replayHash);
  }
  assert.ok(provider);
});

function fertilePair(state) {
  state.pregnancies=[];for(const agent of state.agents)agent.partnerIds=[];
  const female=state.agents[0],male=state.agents[1];female.sex='female';male.sex='male';female.partnerIds=[male.id];male.partnerIds=[female.id];
  female.genetics.loci.fertility=100;male.genetics.loci.fertility=100;state.settlement.resources.food=10000;
  // Find a fixed scheduled successful roll, keeping ages/health/resources equal across subdivisions.
  let day=state.clock.day+1;while(scopedRandom(state.seed,`${female.id}:${male.id}:${day}:360:conception`)>=.0009)day++;
  female.bornDay=day-25*365;male.bornDay=day-25*365;
  return {female,male,day};
}

test('conception runs when direct play crosses a scheduled slot, at 1/6/24 hours and with a ten-minute offset',async()=>{
  const {state}=await fixture(),{day}=fertilePair(state),pregnancies=[];
  for(const minutes of [60,360,1440])for(const offset of [0,10]) {
    const s=structuredClone(state);s.clock={...s.clock,day:day-1,minuteOfDay:360+offset};delete s.lastConceptionCheckAbsoluteMinute;
    for(let n=0;n<1440/minutes;n++){s.clock=addGameMinutes(s.clock,minutes);simulateConceptionInterval(s,minutes/60);}
    assert.equal(s.pregnancies.length,1,`${minutes} minutes / offset ${offset}`);pregnancies.push(s.pregnancies[0]);
    const rng=s.rngState;simulateConceptionInterval(s,24);assert.equal(s.pregnancies.length,1);assert.equal(s.rngState,rng);
    assert.ok(importSandboxSave(JSON.stringify(s)));
  }
  for(const pregnancy of pregnancies)assert.deepEqual(pregnancy,pregnancies[0]);
});

test('conception slots survive save/reload and cannot impregnate through absent, dead or immature partners',async()=>{
  const {state}=await fixture(),{day,male}=fertilePair(state);state.clock={...state.clock,day,minuteOfDay:350};
  simulateConceptionInterval(state,.1);const resumed=importSandboxSave(JSON.stringify(state));resumed.clock=addGameMinutes(resumed.clock,20);simulateConceptionInterval(resumed,1/3);assert.equal(resumed.pregnancies.length,1);
  for(const mode of ['absent','dead','child']) {
    const s=structuredClone(state),partner=s.agents.find(a=>a.id===male.id);if(mode==='absent')partner.expeditionId='remote';if(mode==='dead')partner.alive=false;if(mode==='child')partner.bornDay=day-10*365;
    s.clock=addGameMinutes(s.clock,20);simulateConceptionInterval(s,1/3);assert.equal(s.pregnancies.length,0);
  }
});

test('F3 shows pause reasons and the real event route updates staff without resetting progress',async(t)=>{
  const {provider,state,actor,source,others}=await fixture(),project=startResearchProject(state,source.id,[actor.id]);step(state);actor.health=20;
  const html=renderResearchProjects(state);assert.match(html,/停止理由/);assert.match(html,/data-action="research-workers"/);assert.match(html,/実作業/);
  t.mock.method(SandboxApp.prototype,'render',()=>{});for(const method of ['unlock','playClick','playConfirm'])t.mock.method(pdaAudio,method,()=>{});
  const saved=Object.fromEntries(['window','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),handlers={};
  const root={addEventListener:(kind,handler)=>handlers[kind]=handler,querySelector:()=>null};
  globalThis.window={addEventListener(){},setTimeout(){return 0;},clearTimeout(){},localStorage:{getItem:()=>null}};globalThis.document={addEventListener(){}};
  try {
    const app=new SandboxApp(root,provider,{mode:'volatile',save:async()=>{}},state);await new Promise(r=>setImmediate(r));
    const before=project.progress,card={querySelectorAll:()=>[{dataset:{researchWorker:others[0].id}}]};
    handlers.click({target:{closest:()=>({dataset:{action:'research-workers',projectId:project.id},closest:()=>card})}});await new Promise(r=>setImmediate(r));
    assert.deepEqual(project.researcherIds,[others[0].id]);assert.equal(project.progress,before);assert.equal(project.pauseReason,undefined);assert.equal(app.viewContext().state,state);
  } finally {for(const [key,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

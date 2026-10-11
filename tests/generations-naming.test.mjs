import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { advanceSandboxHours } from '../.test-dist/sandbox/engine.js';
import { ageAbilityFactors, naturalDeathDay } from '../.test-dist/sandbox/aging.js';
import { effectiveSkill } from '../.test-dist/sandbox/stateUtils.js';
import { NAMING_LANGUAGE, generatePersonName, generatePlaceName } from '../.test-dist/sandbox/naming.js';
import { simulateEducationInterval, setEducationMentor } from '../.test-dist/sandbox/educationSimulation.js';
import { reserveDirectActivity, ensureDirectPlayState } from '../.test-dist/sandbox/directPlay.js';
import { simulateNaturalMortality, recordAgentDeath } from '../.test-dist/sandbox/lifeCourseSimulation.js';
import { startResearchProject, simulateResearchInterval } from '../.test-dist/sandbox/researchSimulation.js';
import { researchWorkMultiplier, applyCompletedResearch } from '../.test-dist/sandbox/researchApplications.js';
import { executeContinuityDays } from '../.test-dist/sandbox/continuityProgression.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { deriveVisibleIncidentProjection, deriveIncidentDispatchCapacity, assignIncidentResponseTeam, dispatchIncidentResponseTeam, standDownIncidentResponseTeam, incidentResponseResourceReservations } from '../.test-dist/sandbox/incidentService.js';
import { adjustResourceStock, resourceLotTotal } from '../.test-dist/sandbox/resourceLedger.js';
import { renderPdaBodyPanel, renderPdaResidentsView, renderPdaSecondaryIndex } from '../.test-dist/sandbox/ui/bodyView.js';
import { renderPdaKnowledgePanel } from '../.test-dist/sandbox/ui/knowledgeView.js';

const summary=(state)=>({from:{...state.clock},to:{...state.clock},births:[],deaths:[],leadershipChanges:[],expeditionUpdates:[],encounterUpdates:[],knowledgeUpdates:[],settlementUpdates:[]});
async function fixture(seed=110001) {
  const provider=new MockWorldProvider();
  const state=await createInitialSandboxState(provider,{seed,population:14});
  ensureDirectPlayState(state);
  return {provider,state};
}
function makeLearner(state) {
  const [mentor,child]=state.agents.filter((a)=>a.alive&&!a.expeditionId);
  mentor.bornDay=state.clock.day-35*365; mentor.health=100; mentor.fatigue=0; mentor.skills.records=90;
  child.bornDay=state.clock.day-10*365; child.role='child'; child.parentIds=[mentor.id]; child.skills.records=1; child.knowledgeIds=[];
  setEducationMentor(state,child.id,mentor.id,'records');
  return {mentor,child};
}

test('ability curves preserve learned skill and separate physical aging from judgment',async()=>{
  const {state}=await fixture();const a=state.agents[0];const learned={...a.skills};
  a.bornDay=state.clock.day-30*365;const young=effectiveSkill(state,a,'construction');
  a.bornDay=state.clock.day-80*365;assert.ok(effectiveSkill(state,a,'construction')<young);
  assert.deepEqual(a.skills,learned);assert.ok(ageAbilityFactors(80).judgment>ageAbilityFactors(80).physical);
  assert.ok(ageAbilityFactors(80).recovery<ageAbilityFactors(30).recovery);
  const before=ageAbilityFactors(55-1e-6).physical, after=ageAbilityFactors(55+1e-6).physical;
  assert.ok(Math.abs(before-after)<1e-6,'no birthday ability cliff');
});

test('lifespan survives reload and unrelated RNG, and natural death is recorded once with a physical estate',async()=>{
  const {state}=await fixture(110002);const {mentor,child}=makeLearner(state);
  const day=naturalDeathDay(state,mentor);state.rngState+=123;
  assert.equal(naturalDeathDay(state,mentor),day);assert.equal(naturalDeathDay(importSandboxSave(JSON.stringify(state)),mentor),day);
  const item=state.directPlay.inventory.find((i)=>i.ownerId===mentor.id);
  state.clock.day=day;mentor.health=100;const report=summary(state);
  simulateNaturalMortality(state,report);simulateNaturalMortality(state,report);
  assert.equal(mentor.alive,false);assert.equal(mentor.causeOfDeath,'old age / natural lifespan');
  assert.equal(report.deaths.filter((id)=>id===mentor.id).length,1);
  if(item) assert.equal(item.ownerId,child.id);
  assert.equal(state.chronicle.filter((e)=>e.kind==='death'&&e.entityIds.includes(mentor.id)).length,1);
});

test('normal engine ticks apply natural mortality even to healthy elders',async()=>{
  const {provider,state}=await fixture(110003);const elder=state.agents[0];elder.bornDay=-120*365;elder.health=100;
  const result=await advanceSandboxHours(provider,state,1);
  assert.equal(elder.alive,false);assert.ok(result.deaths.includes(elder.id));
});

test('Neral names follow a shared family rule, remain deterministic and do not advance the simulation RNG',async()=>{
  const {state}=await fixture(110004);const rng=state.rngState;
  const parent=generatePersonName(state.seed,'p','h'),child=generatePersonName(state.seed,'c','other',parent.familyName);
  assert.equal(child.familyName,parent.familyName);assert.notEqual(child.givenName,parent.givenName);
  assert.deepEqual(parent,generatePersonName(state.seed,'p','h'));assert.match(parent.fullName,/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.equal(NAMING_LANGUAGE.version,1);assert.equal(state.rngState,rng);
  const place={id:'settlement:shared',kind:'settlement',components:{},provenanceIds:[]};
  assert.match(generatePlaceName(place),/nar$/);assert.equal(generatePlaceName(place),generatePlaceName({...place,components:{name:'different provider label'}}));
  assert.ok(state.agents.every((a)=>a.naming?.fullName===a.name));
  const saved=importSandboxSave(JSON.stringify(state));assert.deepEqual(saved.agents.map((a)=>a.name),state.agents.map((a)=>a.name));
});

test('education reserves teacher time, grows learned skill and passes actual knowledge',async()=>{
  const {state}=await fixture(110005);const {mentor,child}=makeLearner(state);
  const knowledge=state.knowledge.find((k)=>!k.lost);assert.ok(knowledge);mentor.knowledgeIds.push(knowledge.id);
  child.education.hours=23.5;const report=summary(state);const hours=simulateEducationInterval(state,24,report);
  assert.ok(hours.get(mentor.id)>=1);assert.ok(child.skills.records>1);assert.equal(child.education.hours,24.5);
  assert.ok(child.knowledgeIds.length);assert.ok(report.knowledgeUpdates.length);
  assert.equal(importSandboxSave(JSON.stringify(state)).agents.find((a)=>a.id===child.id).education.hours,24.5);
});

test('education cannot use a teacher who already spent the whole interval on a direct action',async()=>{
  const {state}=await fixture(110006);const {mentor,child}=makeLearner(state);
  reserveDirectActivity(state,[mentor.id],'archive',1440,'Test occupied teacher');state.clock.day+=1;
  for (const a of state.agents) if(a.id!==mentor.id&&a.id!==child.id) a.bornDay=state.clock.day-5*365;
  const learned=child.skills.records;simulateEducationInterval(state,24,summary(state));assert.equal(child.skills.records,learned);
  assert.throws(()=>setEducationMentor(state,child.id,child.id,'records'),/adult/);
});

test('death abroad does not transfer belongings or death memories to remote heirs',async()=>{
  const {state}=await fixture(110007);const {mentor,child}=makeLearner(state);
  mentor.expeditionId='expedition:remote';mentor.residence='expedition';
  mentor.relations=[{targetId:child.id,kind:'kin',affinity:80,trust:80,obligation:80}];
  const item=state.directPlay.inventory.find((i)=>i.ownerId===mentor.id);
  const memories=child.memories.length;recordAgentDeath(state,mentor,'old age',summary(state));
  assert.equal(child.memories.length,memories);if(item)assert.equal(item.ownerId,mentor.id);
});

test('research completion grants scoped, bounded, non-stacking practice and persists it',async()=>{
  const {state}=await fixture(110008);const source=state.knowledge.find((k)=>!k.lost);source.subjectIds=['resource:freshwater'];source.confidence=.9;
  const project=startResearchProject(state,source.id);project.progress=99.9;simulateResearchInterval(state,24,summary(state));
  assert.equal(project.status,'completed');const boost=researchWorkMultiplier(state,'water',true);assert.ok(boost>1&&boost<=1.15);
  assert.equal(researchWorkMultiplier(state,'forage'),1);assert.equal(state.researchApplications[0].uses,1);
  const result=state.knowledge.find((k)=>k.id===project.resultKnowledgeId);applyCompletedResearch(state,project,result,source);
  assert.equal(state.researchApplications.length,1);assert.equal(researchWorkMultiplier(state,'water'),boost);
  const restored=importSandboxSave(JSON.stringify(state));assert.equal(researchWorkMultiplier(restored,'water'),boost);
  result.lost=true;assert.equal(researchWorkMultiplier(state,'water'),1);
});

test('incident reservations remain excluded during other lot mutations and refund original provenance',async()=>{
  const {state}=await fixture(110009);const incident=deriveVisibleIncidentProjection(state,null,null).incidents[0];
  const member=deriveIncidentDispatchCapacity(state,incident.id).availableMemberIds[0];const team=assignIncidentResponseTeam(state,incident.id,[member]);
  const lotsBefore=structuredClone(state.resourceLedger.lots);const food=state.settlement.resources.food;
  dispatchIncidentResponseTeam(state,team.id);const held=incidentResponseResourceReservations(state,incident.id)[0];assert.ok(held.heldLots.food.length);
  assert.equal(resourceLotTotal(state,'food'),state.settlement.resources.food);
  adjustResourceStock(state,'fuel',2,'test anomaly output');assert.equal(state.settlement.resources.food,Number((food-held.reserved.food).toFixed(6)));
  const saved=importSandboxSave(JSON.stringify(state));standDownIncidentResponseTeam(saved,team.id);
  assert.equal(saved.settlement.resources.food,food);
  for (const line of held.heldLots.food) {
    const before=lotsBefore.find((l)=>l.id===line.lotId),after=saved.resourceLedger.lots.find((l)=>l.id===line.lotId);
    assert.equal(after.quantity,before.quantity);assert.equal(after.freshness,before.freshness);assert.equal(after.sourceId,before.sourceId);
  }
});

function viewContext(state,holder,live=false) {
  return {state,inspectedAgentId:holder.id,controlledAgent:()=>holder,canInspectLiveState:()=>live,lastReportForAgent:()=>undefined,
    selectedPreparationDoctrine:()=>undefined,knowledgeAgent:()=>holder,knowledgeEligibleAgents:()=>[holder],conversationPartners:()=>[],conversationTargetId:'',controlledExpedition:()=>null};
}

test('active F2, resident view and index redact remote measurements and death status',async()=>{
  const {state}=await fixture(110010);const person=state.agents[0];person.health=12.345;person.fatigue=67.891;person.alive=false;
  const ctx=viewContext(state,person);for (const html of [renderPdaBodyPanel(ctx),renderPdaResidentsView(ctx),renderPdaSecondaryIndex(ctx,'body')]) {
    assert.doesNotMatch(html,/12\.345|67\.891|DECEASED/);assert.match(html,/未確認|UNKNOWN/);
  }
});

test('active F3 hides settlement archives and research while viewing a field holder',async()=>{
  const {state}=await fixture(110011);const holder=state.agents[0];holder.expeditionId='expedition:field';holder.residence='expedition';holder.knowledgeIds=[];
  state.records.push({id:'secret:record',title:'SECRET_SETTLEMENT_ARCHIVE',integrity:1,copies:1});state.researchProjects=[{hypothesis:'SECRET_RESEARCH',progress:40,status:'active',confidence:.8}];
  const ctx=viewContext(state,holder);const html=renderPdaKnowledgePanel(ctx);
  assert.doesNotMatch(html,/SECRET_SETTLEMENT_ARCHIVE|SECRET_RESEARCH|data-action="anomaly-use"/);
  assert.match(html,/個人・隊内知識のみ/);
});

test('continuity advancement uses daily reports, stops at cancellation and can resume',async()=>{
  const {provider,state}=await fixture(110012);state.pregnancies=[];const before=state.clock.day;
  let cancel=false;const callbacks=[];
  const first=await executeContinuityDays(provider,state,7,{cancelled:()=>cancel,onDay:async(n)=>{callbacks.push(n);cancel=true;}});
  assert.equal(first.completedDays,1);assert.equal(state.clock.day,before+1);assert.deepEqual(callbacks,[1]);
  const next=await executeContinuityDays(provider,state,1);assert.equal(next.completedDays,1);assert.equal(state.clock.day,before+2);
  assert.equal(state.dailyLoop.lastMorningReport.day,state.clock.day);
});

test('continuity pauses on natural death and retains the completed morning report',async()=>{
  const {provider,state}=await fixture(110013);state.pregnancies=[];state.agents[0].bornDay=-120*365;
  const result=await executeContinuityDays(provider,state,30);assert.equal(result.completedDays,1);assert.match(result.reason,/死亡/);
  assert.ok(state.dailyLoop.lastMorningReport.deaths.includes(state.agents[0].id));
});

// Opt-in campaign probe: real default world, one controlled local lead, no health/resource/progress resets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ContentPackRegistry, WorldgenEngine, parseWorldRecipe } from '../vendor/i2x-worldgen-runtime/dist/index.js';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord } from '../.test-dist/sandbox/knowledgeSimulation.js';
import { createExplorationInquiry, surveyInquiry, archiveInquiryEvaluation, trialInquiryProcedure } from '../.test-dist/sandbox/explorationInquiry.js';
import { queryGeneratedLocalArea, harvestGeneratedResource, spatialDistanceKm } from '../.test-dist/sandbox/localExploration.js';
import { ensureDirectPlayState } from '../.test-dist/sandbox/directPlay.js';
import { launchExpedition, addExpeditionOrder } from '../.test-dist/sandbox/expeditionSimulation.js';
import { startResearchProject } from '../.test-dist/sandbox/researchSimulation.js';
import { startLegacyProject, setLegacyProjectWorkers } from '../.test-dist/sandbox/legacyProject.js';
import { agentAgeYears } from '../.test-dist/sandbox/stateUtils.js';
import { advanceSandbox } from '../.test-dist/sandbox/engine.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';

const days = Number(process.argv.find(arg=>arg.startsWith('--days='))?.slice(7) ?? 365);
assert.ok(Number.isInteger(days) && days>=90 && days<=3650,'--days must be an integer from 90 to 3650');
const root = new URL('../vendor/i2x-worldgen-runtime/setting-packs/descendants/',import.meta.url);
const raw = JSON.parse(fs.readFileSync(new URL('default.recipe.json',root),'utf8')),content = new ContentPackRegistry();
for(const ref of raw.contentPacks)content.register(JSON.parse(fs.readFileSync(new URL(`content-packs/${ref.id}.json`,root),'utf8')));
const recipe=parseWorldRecipe(JSON.stringify(raw)),engine=new WorldgenEngine(undefined,content);
let provider=await engine.generate(recipe),state=await createInitialSandboxState(provider);
ensureDirectPlayState(state);
const started=performance.now(),initialPopulation=state.agents.length;
const localAdult = a => a.alive&&!a.expeditionId&&(!a.residence||a.residence==='settlement')&&agentAgeYears(state,a)>=16;
const actor=state.agents.filter(a=>localAdult(a)&&a.health>=65&&a.fatigue<65&&agentAgeYears(state,a)<60)
  .sort((a,b)=>(b.skills.survival+b.skills.scouting+b.health)-(a.skills.survival+a.skills.scouting+a.health))[0];
assert.ok(actor,'actual initial population must provide a fit investigator');
const area=await queryGeneratedLocalArea(provider,state,actor.id,state.settlement.position,5);
const water=area.entities.filter(e=>e.kind==='ecological-resource'&&e.subtype==='freshwater'&&e.spatial)
  .sort((a,b)=>spatialDistanceKm(a.spatial,state.settlement.position)-spatialDistanceKm(b.spatial,state.settlement.position))[0];
assert.ok(water,'default local projection must contain a freshwater fixture');
// This single lead is scenario input, not an assertion that worldgen automatically produced a water rumor.
const lead=addObservedKnowledge(state,[actor.id],[water.id],JSON.stringify({interpretation:'cartographic-estimate',regionId:water.id,
  estimatedCenter:{x:water.spatial.x,y:water.spatial.y},uncertaintyRadiusKm:.35}),.4,undefined,[],{promoteToSettlement:false});
const inquiry=createExplorationInquiry(state,actor.id,[lead.id],water,'water-source','近傍の水源候補を現地で確かめる。');
await advanceSandbox(provider,state,10);
const expedition=launchExpedition(state,{leaderId:actor.id,memberIds:[actor.id],destination:inquiry.center,doctrineId:state.doctrines[0].id,
  supplies:{food:12,water:18,medicine:2,tools:2},controlMode:'expedition'});
for(let n=0;n<24&&expedition.status==='outbound';n++)await advanceSandbox(provider,state,60);
assert.equal(expedition.status,'exploring');
const evaluation=await surveyInquiry(provider,state,actor.id,inquiry.id);assert.equal(evaluation.outcome,'supports');await advanceSandbox(provider,state,60);
harvestGeneratedResource(state,actor.id,water,'water',5);await advanceSandbox(provider,state,60);
addExpeditionOrder(state,expedition.id,'return','持ち帰った現物を拠点で検証する。');
for(let n=0;n<48&&expedition.status!=='returned';n++)await advanceSandbox(provider,state,60);
assert.equal(expedition.status,'returned');
archiveInquiryEvaluation(state,actor.id,inquiry.id,evaluation.knowledgeId);await advanceSandbox(provider,state,60);
const trial=trialInquiryProcedure(state,actor.id,inquiry.id,'boiled');assert.ok(trial.after.microbialRisk<trial.before.microbialRisk);await advanceSandbox(provider,state,30);
institutionalizeKnowledgeRecord(state,actor.id,trial.knowledgeId);await advanceSandbox(provider,state,60);
const research=startResearchProject(state,trial.knowledgeId),researchId=research.id,actorId=actor.id;
const absolute = () => (state.clock.day-1)*1440+state.clock.minuteOfDay;
const firstMinute=absolute(),target=firstMinute+days*1440;
let legacyId,completedResearchDay,roundtrips=0;
const report = label => {
  const project=state.legacyProjects?.find(p=>p.id===legacyId),research=state.researchProjects.find(p=>p.id===researchId);
  const result={label,elapsedDays:(absolute()-firstMinute)/1440,population:state.agents.filter(a=>a.alive).length,initialPopulation,
    births:state.pregnancies.filter(p=>p.outcome==='birth').length,ongoingPregnancies:state.pregnancies.filter(p=>p.outcome==='ongoing').length,
    deaths:state.agents.filter(a=>!a.alive).map(a=>({id:a.id,cause:a.causeOfDeath,day:a.deathDay})),
    minHealth:Math.min(...state.agents.filter(a=>a.alive).map(a=>a.health)),resources:state.settlement.resources,
    research:{status:research.status,progress:research.progress,actualHours:(research.contributors??[]).reduce((n,c)=>n+c.hours,0),completedDay:completedResearchDay??null,pauseReason:research.pauseReason??null},
    project:project?{status:project.status,effectiveHours:project.phases.reduce((n,p)=>n+p.workHours,0),actualHours:project.contributors.reduce((n,c)=>n+c.hours,0),pauseReason:project.pauseReason??null}:null,
    lots:state.resourceLedger.lots.length,roundtrips,seconds:(performance.now()-started)/1000};
  console.log(JSON.stringify(result));return result;
};
report('field-return-and-trial');let completedDays=0;
while(absolute()<target&&state.agents.some(a=>a.alive)) {
  // The engine still runs every six-hour chunk; batch transaction copies after the plan is set.
  const batchDays = legacyId ? Math.min(30,90-completedDays%90) : 1;
  const minutes = Math.min(batchDays*1440,target-absolute());
  await advanceSandbox(provider,state,minutes);completedDays+=Math.ceil(minutes/1440);
  const currentResearch=state.researchProjects.find(p=>p.id===researchId);
  if(currentResearch.status==='completed'&&!legacyId) {
    completedResearchDay=state.clock.day;
    const investigator=state.agents.find(a=>a.id===actorId);assert.ok(investigator.alive,'investigator must retain the measured trial');
    const project=startLegacyProject(state,actorId,'waterworks');legacyId=project.id;
    const workers=state.agents.filter(localAdult).sort((a,b)=>b.skills.construction-a.skills.construction).slice(0,4);
    setLegacyProjectWorkers(state,actorId,project.id,workers.map(a=>a.id));await advanceSandbox(provider,state,60);report('research-completed-and-plan-recorded');
  }
  if(completedDays%90===0) {
    state=importSandboxSave(JSON.stringify(state));provider=engine.fromSnapshot(recipe,structuredClone(state.world.providerSnapshot));roundtrips++;report('save-reload-checkpoint');
  }
}
state=importSandboxSave(JSON.stringify(state));roundtrips++;const final=report('final');
assert.equal(final.research.status,'completed','research must finish through actual time');
assert.ok(final.project?.effectiveHours>0,'full-sized plan must consume materials and accrue real work');
assert.ok((state.researchApplications??[]).some(a=>a.domain==='water'),'measured water research must establish the existing application');
console.log(JSON.stringify({verification:'passed',scope:'one default generated world and one controlled lead; ordinary health/resources/births/deaths; research and project hours unshortened',days}));

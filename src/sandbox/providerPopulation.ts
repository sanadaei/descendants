import type { AreaProjection, JsonValue, WorldEntity, WorldProvider, WorldRelation } from '../worldbridge/contract.js';
import type { AgentRelation, AgentRole, AgentSkills, Household, Institution, SandboxAgent, SettlementResources } from './types.js';

const SKILL_KEYS: Array<keyof AgentSkills> = ['survival','medicine','construction','foraging','scouting','combat','care','records','leadership','trade'];
const ADULT_ROLES: AgentRole[] = ['medic','scout','builder','forager','water','caregiver','recorder','guard','generalist'];

function finite(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}
function hashStep(value: number): number {
  let x = value >>> 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0;
}
function unit(seed: number, salt: number): number { return hashStep((seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0) / 0x100000000; }
function int(seed: number, salt: number, min: number, max: number): number { return Math.floor(min + unit(seed, salt) * (max - min + 1)); }
function continuitySeed(individual: WorldEntity, anchor?: WorldEntity): number {
  const traits = objectValue(anchor?.components.identityTraits);
  const explicit = finite(traits?.continuitySeed, Number.NaN);
  if (Number.isFinite(explicit)) return Math.floor(explicit) >>> 0;
  let hash = 2166136261 >>> 0; for (const ch of individual.id) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619) >>> 0; } return hash;
}
function cohortAgeStructure(cohort?: WorldEntity): { juvenile:number; adult:number; elder:number } {
  const age = objectValue(cohort?.components.ageStructure); const juvenile=Math.max(0,finite(age?.juvenile,.24)),adult=Math.max(0,finite(age?.adult,.58)),elder=Math.max(0,finite(age?.elder,.18)); const total=juvenile+adult+elder||1;
  return { juvenile:juvenile/total, adult:adult/total, elder:elder/total };
}
function deriveAge(seed:number, cohort?:WorldEntity):number {
  const structure=cohortAgeStructure(cohort), u=unit(seed,3);
  if(u<structure.juvenile)return int(seed,4,3,17);
  if(u<structure.juvenile+structure.adult)return int(seed,5,18,59);
  return int(seed,6,60,82);
}
function roleFor(seed:number, age:number, sourceRoles:JsonValue|undefined):AgentRole {
  if(age<13)return 'child';
  if(Array.isArray(sourceRoles)) for(const raw of sourceRoles){ if(typeof raw!=='string')continue; const role=raw.toLowerCase(); if((ADULT_ROLES as string[]).includes(role))return role as AgentRole; }
  return ADULT_ROLES[int(seed,7,0,ADULT_ROLES.length-1)]!;
}
function skillsFor(seed:number,role:AgentRole):AgentSkills {
  const skills=Object.fromEntries(SKILL_KEYS.map((key,index)=>[key,int(seed,20+index,24,66)])) as AgentSkills;
  const boosts:Partial<Record<AgentRole,keyof AgentSkills>>={leader:'leadership',medic:'medicine',scout:'scouting',builder:'construction',forager:'foraging',caregiver:'care',recorder:'records',guard:'combat',water:'survival',generalist:'survival',child:'care'};
  const boosted=boosts[role]; if(boosted)skills[boosted]=Math.min(96,skills[boosted]+int(seed,40,16,30)); return skills;
}
function displayName(entity:WorldEntity):string {
  if(typeof entity.components.name==='string'&&entity.components.name.trim())return entity.components.name;
  if(typeof entity.components.label==='string'&&entity.components.label.trim())return entity.components.label;
  return `Resident ${entity.id.replace(/^ent_/,'').toUpperCase()}`;
}
function settlementCohorts(projection:AreaProjection, originId:string):WorldEntity[]{
  return projection.entities.filter((entity)=>entity.kind==='population-cohort'&&entity.components.settlementId===originId);
}
function relationStrength(relation:WorldRelation):number {
  const raw=relation.data?.closenessIndex; return typeof raw==='number'&&Number.isFinite(raw)?Math.max(0,Math.min(1,raw)):0.56;
}
function addRelation(
  agent:SandboxAgent,targetId:string,kind:AgentRelation['kind'],strength:number,
  source?:{id:string;kind:string;provenanceIds:string[]},
):void{
  if(agent.id===targetId||agent.relations.some((entry)=>entry.targetId===targetId&&entry.kind===kind))return;
  const score=Math.round(30+strength*65);
  agent.relations.push({
    targetId,kind,affinity:score,trust:Math.max(20,score-5),obligation:Math.round(25+strength*70),
    authority: source ? 'provider-projected' : 'lived-game-state',
    ...(source?{worldRelationId:source.id,worldProvenanceIds:[...source.provenanceIds],sourceWorldRelationKind:source.kind}:{}),
  });
}

export interface ProviderPopulationMaterialization {
  projection: AreaProjection;
  agents: SandboxAgent[];
  households: Household[];
  providerInstitutions: WorldEntity[];
}

export async function materializeOriginPopulation(provider:WorldProvider,origin:WorldEntity,day=1,limit?:number):Promise<ProviderPopulationMaterialization>{
  if(!origin.spatial)throw new Error(`WorldProvider origin settlement is not spatial: ${origin.id}`);
  const projection=await provider.queryArea({center:structuredClone(origin.spatial),radiusKm:2.5,requestedDetailRank:0,observerId:origin.id,includeKnowledgeProjection:true});
  const cohorts=settlementCohorts(projection,origin.id); const cohortIds=new Set(cohorts.map((entry)=>entry.id)); const cohortById=new Map(cohorts.map((entry)=>[entry.id,entry]));
  const anchors=new Map(projection.entities.filter((entry)=>entry.kind==='identity-anchor').map((entry)=>[entry.id,entry]));
  const householdEntities=new Map(projection.entities.filter((entry)=>entry.kind==='household').map((entry)=>[entry.id,entry]));
  let individuals=projection.entities.filter((entry)=>entry.kind==='individual'&&typeof entry.components.cohortId==='string'&&cohortIds.has(entry.components.cohortId)).sort((a,b)=>a.id.localeCompare(b.id));
  if(limit&&Number.isFinite(limit)&&limit>0)individuals=individuals.slice(0,Math.floor(limit));
  if(!individuals.length)throw new Error(`WorldProvider did not materialize any fine-LOD individuals for origin settlement ${origin.id}.`);
  const agents=individuals.map((entity):SandboxAgent=>{
    const anchorId=typeof entity.components.identityAnchorId==='string'?entity.components.identityAnchorId:undefined; const anchor=anchorId?anchors.get(anchorId):undefined; const seed=continuitySeed(entity,anchor); const cohortId=String(entity.components.cohortId); const cohort=cohortById.get(cohortId); const age=deriveAge(seed,cohort); const sex=unit(seed,2)<.5?'female':'male'; const sourceRole=Array.isArray(entity.components.roles)?entity.components.roles.find((raw):raw is string=>typeof raw==='string'&&(ADULT_ROLES as string[]).includes(raw.toLowerCase())):undefined; const role=roleFor(seed,age,entity.components.roles); const skills=skillsFor(seed,role); const vitality=Math.max(0,Math.min(1,finite(entity.components.vitalityIndex,.65))); const disposition=Array.isArray(entity.components.dispositionVector)?entity.components.dispositionVector.filter((entry):entry is number=>typeof entry==='number'&&Number.isFinite(entry)):[]; const temperament=objectValue(anchor?.components.identityTraits); const t=Array.isArray(temperament?.temperament)?temperament!.temperament.filter((entry):entry is number=>typeof entry==='number'&&Number.isFinite(entry)):disposition;
    const providerName=typeof entity.components.name==='string'&&entity.components.name.trim()||typeof entity.components.label==='string'&&entity.components.label.trim(); const providerHousehold=typeof entity.components.householdId==='string'; const householdId=providerHousehold?String(entity.components.householdId):`provider-household:${entity.id}`; const plans=Array.isArray(entity.components.plans)?entity.components.plans:[]; const goals=plans.map((plan)=>objectValue(plan)?.kind).filter((entry):entry is string=>typeof entry==='string').slice(0,2); const commitments=Array.isArray(entity.components.commitments)?entity.components.commitments.filter((entry):entry is string=>typeof entry==='string'):[];
    return { id:entity.id, identityOrigin:'world-provider', profileAuthority:{identity:'provider-projected',name:providerName?'provider-projected':'game-derived',household:providerHousehold?'provider-projected':'game-derived',age:'game-derived',sex:'game-derived',role:sourceRole?'provider-projected':'game-derived',skills:'game-derived',genetics:'game-derived',healthBaseline:'game-derived',personality:'game-derived',faith:'game-derived'}, worldEntityId:entity.id, ...(anchorId ? { identityAnchorId:anchorId } : {}), worldProvenanceIds:[...(anchor?.provenanceIds??entity.provenanceIds)], materializationProvenanceIds:[...entity.provenanceIds], sampleWeight:Math.max(1,finite(entity.components.sampleWeight,1)), name:displayName(entity), sex, bornDay:day-(age*365+int(seed,8,0,364)), alive:true,deathDay:null,causeOfDeath:'',role,householdId,parentIds:[],partnerIds:[], genetics:{lineageMarker:`WG-${(seed%4096).toString(16).padStart(3,'0')}`,loci:{resilience:int(seed,50,20,80),metabolism:int(seed,51,20,80),fertility:int(seed,52,20,80)},anomalyTraits:[]}, health:Math.round(55+vitality*45),fatigue:int(seed,53,6,34),morale:int(seed,54,46,78), needs:{hunger:int(seed,55,8,32),thirst:int(seed,56,6,24),rest:int(seed,57,8,30),safety:int(seed,58,8,24),belonging:int(seed,59,6,30)}, skills,goals:goals.length?goals:(age<13?['grow','stay-with-household']:['support-household']),fears:[['hunger','unknown-weather','illness','isolation','violence','forgetting-the-past'][int(seed,60,0,5)]!],beliefs:[],memories:[],relations:[],knowledgeIds:[],pathology:[], authority:{offices:[],legitimacy:int(seed,61,30,65),obedience:int(seed,62,45,85),refusalThreshold:int(seed,63,42,78)},currentPlan:null,currentTask:'rest',expeditionId:null,residence:'settlement',experience:{}, personality:{curiosity:Math.round(50+(t[0]??0)*40),caution:Math.round(50-(t[1]??0)*35),sociability:Math.round(50+(t[1]??0)*35),autonomy:Math.round(50+(t[2]??0)*40),empathy:Math.round(50-(t[2]??0)*25)}, faith:{commitment:int(seed,64,0,80),interpretationTags:commitments.length?commitments:['provider-anchored-local-tradition']},affiliationIds:[householdId],socialStatus:{standing:int(seed,65,18,62),dependency:age<16?int(seed,66,55,90):int(seed,67,10,55),outsider:int(seed,68,5,35)} };
  });
  const byId=new Map(agents.map((entry)=>[entry.id,entry]));
  // Do not infer spouses, parents, siblings, or complete-household friendship graphs.
  // Worldgen currently exposes only sufficient-statistic social edges at this LOD, so the
  // game preserves exactly those semantics and lets later lived simulation create new ties.
  for(const relation of projection.relations){
    if(relation.kind!=='kin-support'&&relation.kind!=='household-tie')continue;
    const a=byId.get(relation.sourceId),b=byId.get(relation.targetId); if(!a||!b)continue;
    const strength=relationStrength(relation); const kind:AgentRelation['kind']=relation.kind==='kin-support'?'kin':'trust';
    const source={id:relation.id,kind:relation.kind,provenanceIds:[...relation.provenanceIds]};
    addRelation(a,b.id,kind,strength,source); addRelation(b,a.id,kind,strength,source);
  }
  const usedHouseholds=[...new Set(agents.map((entry)=>entry.householdId))].sort(); const households=usedHouseholds.map((id):Household=>{ const entity=householdEntities.get(id); return {id,...(entity ? { worldEntityId:entity.id } : {}),worldProvenanceIds:[...(entity?.provenanceIds??[])],memberIds:agents.filter((entry)=>entry.householdId===id).map((entry)=>entry.id),housingUnitId:id,stores:{}}; });
  const basedInstitutionIds=new Set(projection.relations.filter((entry)=>entry.kind==='based-in'&&entry.targetId===origin.id).map((entry)=>entry.sourceId)); const providerInstitutions=projection.entities.filter((entry)=>entry.kind==='institution'&&basedInstitutionIds.has(entry.id)).sort((a,b)=>a.id.localeCompare(b.id));
  return {projection,agents,households,providerInstitutions};
}

function institutionKind(entity:WorldEntity):Institution['kind']|null{
  const type=typeof entity.components.institutionType==='string'?entity.components.institutionType:entity.subtype??'';
  if(type==='local-governance')return 'assembly'; if(type==='medical-practice')return 'clinic'; if(type==='communications')return 'records'; if(type==='exchange-network')return 'distribution'; return null;
}
function institutionName(kind:Institution['kind'],entity:WorldEntity):string{
  if(typeof entity.components.name==='string')return entity.components.name; return ({assembly:'Local Governance',clinic:'Medical Practice',records:'Communications & Records',distribution:'Exchange Network',leadership:'Leadership',childcare:'Childcare',watch:'Watch'} as Record<Institution['kind'],string>)[kind];
}
export function institutionsFromProvider(providerInstitutions:WorldEntity[],agents:SandboxAgent[]):Institution[]{
  const result:Institution[]=[];
  for(const entity of providerInstitutions){ const kind=institutionKind(entity); if(!kind)continue; const capacity=Math.max(0,Math.min(1,finite(entity.components.capacityIndex,.4))); let members:SandboxAgent[]=[]; if(kind==='assembly')members=agents.filter((entry)=>((1+(entry.bornDay*-1))/365)>=16); else if(kind==='clinic')members=agents.filter((entry)=>entry.skills.medicine>=52-capacity*8); else if(kind==='records')members=agents.filter((entry)=>entry.skills.records>=52-capacity*8); else if(kind==='distribution')members=agents.filter((entry)=>entry.skills.trade>=52-capacity*8);
    const sourceType=typeof entity.components.institutionType==='string'?entity.components.institutionType:entity.subtype; result.push({id:entity.id,worldEntityId:entity.id,worldProvenanceIds:[...entity.provenanceIds],...(sourceType?{sourceWorldInstitutionType:sourceType}:{}),kind,name:institutionName(kind,entity),memberIds:members.map((entry)=>entry.id),authorityRules:[`Provider ${String(entity.components.institutionType??entity.subtype??'institution')} capacity ${(capacity*100).toFixed(0)}%`],recordIds:[]}); }
  return result;
}

export function resourcesFromProvider(origin:WorldEntity,providerInstitutions:WorldEntity[]):SettlementResources{
  const economy=objectValue(origin.components.economy),resources=objectValue(economy?.resources); const staple=objectValue(resources?.staple),materials=objectValue(resources?.materials),energy=objectValue(resources?.energy); const materialStock=Math.max(0,finite(materials?.stock,120)),energyStock=Math.max(0,finite(energy?.stock,90)),stapleStock=Math.max(0,finite(staple?.stock,520)); const waterAccess=Math.max(0,Math.min(1,finite(origin.components.waterAccessIndex,.7))); const medicineInstitution=providerInstitutions.find((entry)=>(entry.components.institutionType??entry.subtype)==='medical-practice'); const commInstitution=providerInstitutions.find((entry)=>(entry.components.institutionType??entry.subtype)==='communications');
  return {food:stapleStock,water:Math.max(80,waterAccess*900),medicine:Math.max(4,finite(medicineInstitution?.components.capacityIndex,.35)*70),timber:materialStock*.34,scrap:materialStock*.22,fuel:energyStock*.12,cloth:materialStock*.08,records:Math.max(3,finite(commInstitution?.components.capacityIndex,.3)*30)};
}

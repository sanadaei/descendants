import { scopedRandom } from './rng.js';
import { nextStateId, settlementAgents } from './stateUtils.js';
import type { AgentRole, AgentSkills, Household, SandboxAgent, SandboxGameState } from './types.js';
import type { JsonValue, WorldEntity, WorldProvider } from '../worldbridge/contract.js';

const MIGRANT_ROLES: AgentRole[] = ['medic','scout','builder','forager','water','caregiver','recorder','guard','generalist'];
const FIRST_NAMES = ['Ari','Mara','Niko','Sena','Tavi','Lina','Rin','Oren','Mika','Eli','Noa','Kira','Toma','Vera','Sami','Ira'];
const LAST_NAMES = ['Vale','Rook','Sen','Mori','Aster','Kade','Lorn','Venn','Hale','Dara','Iven','Orra'];
const SKILL_KEYS: Array<keyof AgentSkills> = ['survival','medicine','construction','foraging','scouting','combat','care','records','leadership','trade'];

function boundedInt(seed:number, scope:string, min:number, max:number):number {
  return min + Math.floor(scopedRandom(seed, scope) * (max - min + 1));
}
function migrantName(state:SandboxGameState,id:string):string {
  const first=FIRST_NAMES[boundedInt(state.seed,`${id}:first`,0,FIRST_NAMES.length-1)]!;
  const last=LAST_NAMES[boundedInt(state.seed,`${id}:last`,0,LAST_NAMES.length-1)]!;
  return `${first} ${last}`;
}
function skills(state:SandboxGameState,id:string,role:AgentRole):AgentSkills {
  const result=Object.fromEntries(SKILL_KEYS.map((key,index)=>[key,boundedInt(state.seed,`${id}:skill:${index}`,25,64)])) as AgentSkills;
  const boost:Partial<Record<AgentRole,keyof AgentSkills>>={medic:'medicine',scout:'scouting',builder:'construction',forager:'foraging',water:'survival',caregiver:'care',recorder:'records',guard:'combat',generalist:'survival'};
  const key=boost[role]; if(key) result[key]=Math.min(88,result[key]+boundedInt(state.seed,`${id}:boost`,14,25));
  return result;
}

export interface NegotiatedMigrationResult { agentIds:string[]; householdIds:string[]; requested:number; admitted:number; reason:string; }

/**
 * Materialize only the local lived consequence of an accepted aggregate migration agreement.
 * No WorldProvider individual identity is claimed unless the provider itself later exposes a moved
 * stable individual. These residents therefore begin as persisted lived-game-state identities.
 */
export function materializeNegotiatedMigrants(
  state:SandboxGameState,
  sourceEntityId:string,
  requestedCount:number,
  sourceIds:string[],
):NegotiatedMigrationResult {
  const requested=Math.max(0,Math.floor(requestedCount));
  if(!requested) return {agentIds:[],householdIds:[],requested,admitted:0,reason:'Negotiations produced no committed movement.'};
  const localPopulation=settlementAgents(state).length;
  const spareHousing=Math.max(0,state.settlement.housingCapacity-localPopulation);
  const admitted=Math.min(requested,spareHousing);
  if(!admitted) return {agentIds:[],householdIds:[],requested,admitted:0,reason:'Movement was negotiated, but no resident was admitted because no local housing capacity remained.'};

  const householdId=nextStateId(state,'migrant-household');
  const household:Household={id:householdId,memberIds:[],housingUnitId:`local-housing:${householdId}`,stores:{}};
  const agentIds:string[]=[];
  for(let index=0;index<admitted;index+=1){
    const id=nextStateId(state,'migrant');
    const age=boundedInt(state.seed,`${id}:age`,18,58);
    const sex=scopedRandom(state.seed,`${id}:sex`)<.5?'female':'male';
    const role=MIGRANT_ROLES[boundedInt(state.seed,`${id}:role`,0,MIGRANT_ROLES.length-1)]!;
    const skillSet=skills(state,id,role);
    const agent:SandboxAgent={
      id,identityOrigin:'lived-game-state',profileAuthority:{identity:'lived-game-state',name:'lived-game-state',household:'lived-game-state',age:'lived-game-state',sex:'lived-game-state',role:'lived-game-state',skills:'lived-game-state',genetics:'lived-game-state',healthBaseline:'lived-game-state',personality:'lived-game-state',faith:'lived-game-state'},
      name:migrantName(state,id),sex,bornDay:state.clock.day-age*365-boundedInt(state.seed,`${id}:born-offset`,0,364),alive:true,deathDay:null,causeOfDeath:'',role,householdId,parentIds:[],partnerIds:[],
      genetics:{lineageMarker:`LIVED-${id.split(':').at(-1)}`,loci:{resilience:boundedInt(state.seed,`${id}:resilience`,28,72),metabolism:boundedInt(state.seed,`${id}:metabolism`,28,72),fertility:boundedInt(state.seed,`${id}:fertility`,28,72)},anomalyTraits:[]},
      health:boundedInt(state.seed,`${id}:health`,72,94),fatigue:boundedInt(state.seed,`${id}:fatigue`,12,34),morale:boundedInt(state.seed,`${id}:morale`,42,68),
      needs:{hunger:boundedInt(state.seed,`${id}:hunger`,12,28),thirst:boundedInt(state.seed,`${id}:thirst`,10,24),rest:boundedInt(state.seed,`${id}:rest`,12,28),safety:boundedInt(state.seed,`${id}:safety`,18,38),belonging:boundedInt(state.seed,`${id}:belonging`,28,52)},
      skills:skillSet,goals:['establish-home','support-household'],fears:['displacement'],beliefs:[],
      memories:[{id:nextStateId(state,'memory'),day:state.clock.day,kind:'social',text:`Arrived through negotiated migration from ${sourceEntityId}.`,salience:72,sourceIds:[sourceEntityId,...sourceIds]}],
      relations:[],knowledgeIds:[],pathology:[],authority:{offices:[],legitimacy:boundedInt(state.seed,`${id}:legitimacy`,20,42),obedience:boundedInt(state.seed,`${id}:obedience`,40,72),refusalThreshold:boundedInt(state.seed,`${id}:refusal`,45,72)},
      currentPlan:null,currentTask:'rest',expeditionId:null,residence:'settlement',experience:{'migration:arrival-day':state.clock.day},
      personality:{curiosity:boundedInt(state.seed,`${id}:curiosity`,35,72),caution:boundedInt(state.seed,`${id}:caution`,38,74),sociability:boundedInt(state.seed,`${id}:social`,32,72),autonomy:boundedInt(state.seed,`${id}:autonomy`,36,74),empathy:boundedInt(state.seed,`${id}:empathy`,38,76)},
      faith:{commitment:boundedInt(state.seed,`${id}:faith`,0,70),interpretationTags:['lived-migrant-tradition']},affiliationIds:[householdId,sourceEntityId],socialStatus:{standing:boundedInt(state.seed,`${id}:standing`,14,32),dependency:boundedInt(state.seed,`${id}:dependency`,12,48),outsider:boundedInt(state.seed,`${id}:outsider`,62,88)},
    };
    state.agents.push(agent); household.memberIds.push(id); agentIds.push(id);
  }
  state.settlement.households.push(household);
  return {agentIds,householdIds:[householdId],requested,admitted,reason:`${admitted} negotiated migrant${admitted===1?'':'s'} arrived and entered local lived history.`};
}


function localDistance(state:SandboxGameState,entity:WorldEntity):number {
  if(!entity.spatial || entity.spatial.frameId!==state.settlement.position.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(entity.spatial.x-state.settlement.position.x,entity.spatial.y-state.settlement.position.y,(entity.spatial.z??0)-(state.settlement.position.z??0));
}
function componentString(entity:WorldEntity,key:string):string|undefined {
  const value=entity.components[key]; return typeof value==='string'&&value.trim()?value:undefined;
}
function providerRole(entity:WorldEntity,state:SandboxGameState,id:string):AgentRole {
  const roles=Array.isArray(entity.components.roles)?entity.components.roles:[];
  for(const raw of roles) if(typeof raw==='string'&&(MIGRANT_ROLES as string[]).includes(raw.toLowerCase())) return raw.toLowerCase() as AgentRole;
  return MIGRANT_ROLES[boundedInt(state.seed,`${id}:provider-role`,0,MIGRANT_ROLES.length-1)]!;
}

const CONFIRMED_MIGRATION_ID_FIELDS = ['migrantIndividualIds','movedIndividualIds','arrivalIndividualIds','individualIds'] as const;
const CONFIRMED_MIGRATION_SINGLE_ID_FIELDS = ['migrantIndividualId','movedIndividualId','arrivalIndividualId','individualId'] as const;

function explicitIndividualIds(payload:Record<string, JsonValue>):string[] {
  const ids:string[]=[];
  for(const key of CONFIRMED_MIGRATION_ID_FIELDS){
    const value=payload[key];
    if(Array.isArray(value)) for(const item of value) if(typeof item==='string'&&item.trim()) ids.push(item);
  }
  for(const key of CONFIRMED_MIGRATION_SINGLE_ID_FIELDS){
    const value=payload[key]; if(typeof value==='string'&&value.trim()) ids.push(value);
  }
  return ids;
}

/**
 * A fine-detail actor list proves that a stable provider individual exists, not that the person moved.
 * Provider identity may therefore cross into the settlement only when an accepted provider event/causal
 * record for this migration explicitly names that individual. This prevents identity drift and hidden-truth
 * leakage from merely observing nearby fine actors.
 */
async function providerConfirmedMigrationCandidateIds(provider:WorldProvider,sourceIds:string[]):Promise<string[]> {
  if(!sourceIds.length) return [];
  const source=new Set(sourceIds);
  let snapshot;
  try { snapshot=await provider.exportSnapshot(0); } catch { return []; }
  const ids:string[]=[];
  for(const event of snapshot.events){
    if(!source.has(event.id)) continue;
    // actorIds/targetIds describe participants in the provider event, not necessarily movers.
    // Only migration-specific payload fields are strong enough to transfer provider identity authority.
    ids.push(...explicitIndividualIds(event.data));
  }
  for(const record of snapshot.causalRecords){
    if(!source.has(record.id)) continue;
    ids.push(...explicitIndividualIds(record.payload));
  }
  return [...new Set(ids)];
}

async function materializeProviderConfirmedArrival(
  provider:WorldProvider,state:SandboxGameState,entity:WorldEntity,sourceEntityId:string,sourceIds:string[],
):Promise<SandboxAgent|null> {
  if(entity.kind!=='individual'||localDistance(state,entity)>2.5||state.agents.some((entry)=>entry.id===entity.id)) return null;
  const anchorId=componentString(entity,'identityAnchorId');
  const anchor=anchorId?await provider.getEntity(anchorId,state.world.originEntityId):null;
  const role=providerRole(entity,state,entity.id); const age=boundedInt(state.seed,`${anchorId??entity.id}:provider-age`,18,62);
  const sex=scopedRandom(state.seed,`${anchorId??entity.id}:provider-sex`)<.5?'female':'male';
  // The provider has confirmed this individual moved, not that their entire source household moved.
  // Create a local lived household unless a future provider event explicitly confirms household migration.
  const householdId=nextStateId(state,'migrant-household');
  const household:Household={id:householdId,memberIds:[],housingUnitId:`local-housing:${householdId}`,stores:{}};
  state.settlement.households.push(household);
  const providerName=componentString(entity,'name')??componentString(entity,'label');
  const agent:SandboxAgent={
    id:entity.id,identityOrigin:'world-provider',profileAuthority:{identity:'provider-projected',name:providerName?'provider-projected':'game-derived',household:'lived-game-state',age:'game-derived',sex:'game-derived',role:Array.isArray(entity.components.roles)?'provider-projected':'game-derived',skills:'game-derived',genetics:'game-derived',healthBaseline:'game-derived',personality:'game-derived',faith:'game-derived'},
    worldEntityId:entity.id,...(anchorId?{identityAnchorId:anchorId}:{}),worldProvenanceIds:[...new Set([...(anchor?.provenanceIds??[]),...entity.provenanceIds])],materializationProvenanceIds:[...new Set([...entity.provenanceIds,...sourceIds])],sampleWeight:typeof entity.components.sampleWeight==='number'?Math.max(1,entity.components.sampleWeight):1,
    name:providerName??`Resident ${entity.id}`,sex,bornDay:state.clock.day-age*365-boundedInt(state.seed,`${entity.id}:provider-born-offset`,0,364),alive:true,deathDay:null,causeOfDeath:'',role,householdId,parentIds:[],partnerIds:[],
    genetics:{lineageMarker:`WG-MIG-${Math.abs(entity.id.split('').reduce((a,c)=>((a*33)^c.charCodeAt(0))|0,5381)).toString(16)}`,loci:{resilience:boundedInt(state.seed,`${entity.id}:resilience`,28,76),metabolism:boundedInt(state.seed,`${entity.id}:metabolism`,28,76),fertility:boundedInt(state.seed,`${entity.id}:fertility`,28,76)},anomalyTraits:[]},
    health:boundedInt(state.seed,`${entity.id}:health`,72,95),fatigue:boundedInt(state.seed,`${entity.id}:fatigue`,10,34),morale:boundedInt(state.seed,`${entity.id}:morale`,42,70),needs:{hunger:boundedInt(state.seed,`${entity.id}:hunger`,10,28),thirst:boundedInt(state.seed,`${entity.id}:thirst`,8,24),rest:boundedInt(state.seed,`${entity.id}:rest`,10,28),safety:boundedInt(state.seed,`${entity.id}:safety`,16,38),belonging:boundedInt(state.seed,`${entity.id}:belonging`,25,48)},skills:skills(state,entity.id,role),goals:['establish-home','support-household'],fears:['displacement'],beliefs:[],
    memories:[{id:nextStateId(state,'memory'),day:state.clock.day,kind:'social',text:`Provider-confirmed arrival from ${sourceEntityId}.`,salience:78,sourceIds:[sourceEntityId,entity.id,...sourceIds]}],relations:[],knowledgeIds:[],pathology:[],authority:{offices:[],legitimacy:boundedInt(state.seed,`${entity.id}:legitimacy`,22,48),obedience:boundedInt(state.seed,`${entity.id}:obedience`,40,72),refusalThreshold:boundedInt(state.seed,`${entity.id}:refusal`,45,72)},currentPlan:null,currentTask:'rest',expeditionId:null,residence:'settlement',experience:{'migration:arrival-day':state.clock.day},personality:{curiosity:boundedInt(state.seed,`${entity.id}:curiosity`,35,72),caution:boundedInt(state.seed,`${entity.id}:caution`,38,74),sociability:boundedInt(state.seed,`${entity.id}:social`,32,72),autonomy:boundedInt(state.seed,`${entity.id}:autonomy`,36,74),empathy:boundedInt(state.seed,`${entity.id}:empathy`,38,76)},faith:{commitment:boundedInt(state.seed,`${entity.id}:faith`,0,70),interpretationTags:['provider-anchored-migrant']},affiliationIds:[householdId,sourceEntityId],socialStatus:{standing:boundedInt(state.seed,`${entity.id}:standing`,16,36),dependency:boundedInt(state.seed,`${entity.id}:dependency`,12,48),outsider:boundedInt(state.seed,`${entity.id}:outsider`,52,78)},
  };
  state.agents.push(agent); household.memberIds.push(agent.id); return agent;
}

export async function materializeNegotiatedMigration(
  provider:WorldProvider,state:SandboxGameState,sourceEntityId:string,requestedCount:number,sourceIds:string[],
):Promise<NegotiatedMigrationResult> {
  const requested=Math.max(0,Math.floor(requestedCount));
  if(!requested) return materializeNegotiatedMigrants(state,sourceEntityId,0,sourceIds);
  const localPopulation=settlementAgents(state).length; const spareHousing=Math.max(0,state.settlement.housingCapacity-localPopulation);
  const maximum=Math.min(requested,spareHousing); if(!maximum) return materializeNegotiatedMigrants(state,sourceEntityId,requested,sourceIds);
  const confirmedIds=await providerConfirmedMigrationCandidateIds(provider,sourceIds);
  const providerIds:string[]=[]; const householdIds=new Set<string>();
  for(const id of confirmedIds){
    if(providerIds.length>=maximum) break;
    const entity=await provider.getEntity(id,state.world.originEntityId); if(!entity) continue;
    const agent=await materializeProviderConfirmedArrival(provider,state,entity,sourceEntityId,sourceIds); if(!agent) continue;
    providerIds.push(agent.id); householdIds.add(agent.householdId);
  }
  const remaining=maximum-providerIds.length;
  const lived=remaining>0?materializeNegotiatedMigrants(state,sourceEntityId,remaining,sourceIds):{agentIds:[],householdIds:[],requested:0,admitted:0,reason:''};
  const agentIds=[...providerIds,...lived.agentIds]; for(const id of lived.householdIds) householdIds.add(id);
  const providerText=providerIds.length?`${providerIds.length} provider-confirmed stable individual${providerIds.length===1?'':'s'} arrived. `:'';
  const livedText=lived.agentIds.length?`${lived.agentIds.length} additional arrival${lived.agentIds.length===1?'':'s'} arrived into local lived history without a claimed provider individual identity.`:'';
  return {agentIds,householdIds:[...householdIds],requested,admitted:agentIds.length,reason:`${providerText}${livedText}`.trim()||'Negotiations produced no admitted movement.'};
}

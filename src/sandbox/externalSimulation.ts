import type { AreaProjection, SpatialRef, WorldEntity, WorldProvider } from '../worldbridge/contract.js';
import { addObservedKnowledge } from './knowledgeSimulation.js';
import { addChronicle } from './stateUtils.js';
import type { ExternalActorProjection, SandboxGameState, SandboxStepSummary } from './types.js';

function nameOf(entity: WorldEntity): string {
  return typeof entity.components.name === 'string' ? entity.components.name : typeof entity.components.label === 'string' ? entity.components.label : entity.id;
}
function numericComponent(entity: WorldEntity, key: string): number | null {
  const value = entity.components[key]; return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function distance(a:SpatialRef,b:SpatialRef):number { return a.frameId===b.frameId?Math.hypot(a.x-b.x,a.y-b.y,(a.z??0)-(b.z??0)):Number.POSITIVE_INFINITY; }
function accessibleKnownSubjects(state:SandboxGameState):Set<string>{
  const ids=new Set<string>([state.world.originEntityId]);
  const local=new Set(state.settlement.localKnowledgeIds); const leader=state.agents.find((entry)=>entry.id===state.settlement.leaderId); const personal=new Set(leader?.knowledgeIds??[]);
  for(const entry of state.knowledge) if(!entry.lost&&(local.has(entry.id)||personal.has(entry.id))) for(const subject of entry.subjectIds) ids.add(subject);
  return ids;
}
function originCohortIds(area:AreaProjection,settlementId:string):Set<string>{ return new Set(area.entities.filter((entry)=>entry.kind==='population-cohort'&&entry.components.settlementId===settlementId).map((entry)=>entry.id)); }
async function directFineProjection(provider:WorldProvider,state:SandboxGameState,entity:WorldEntity):Promise<{actorIds:string[];relationshipIds:string[];rank:number}|null>{
  if(!entity.spatial||distance(state.settlement.position,entity.spatial)>5)return null;
  const area=await provider.queryArea({center:structuredClone(entity.spatial),radiusKm:2.5,requestedDetailRank:0,observerId:state.world.originEntityId,includeKnowledgeProjection:true});
  const cohorts=originCohortIds(area,entity.id); if(!cohorts.size)return {actorIds:[],relationshipIds:[],rank:area.effectiveDetailRank};
  const actorIds=area.entities.filter((entry)=>entry.kind==='individual'&&typeof entry.components.cohortId==='string'&&cohorts.has(entry.components.cohortId)).map((entry)=>entry.id).sort(); const actorSet=new Set(actorIds);
  const relationshipIds=area.relations.filter((entry)=>actorSet.has(entry.sourceId)||actorSet.has(entry.targetId)).map((entry)=>entry.id).sort();
  return {actorIds,relationshipIds,rank:area.effectiveDetailRank};
}
function projectionFrom(entity: WorldEntity, tick: number, previous?: ExternalActorProjection, fine?:{actorIds:string[];relationshipIds:string[];rank:number}|null): ExternalActorProjection {
  return {
    entityId: entity.id, provenanceIds:[...entity.provenanceIds], ...(fine?{fineActorIds:fine.actorIds,relationshipIds:fine.relationshipIds,effectiveDetailRank:fine.rank}:{}),
    kind: entity.kind, name: nameOf(entity), population: numericComponent(entity, 'population'), position: entity.spatial ? structuredClone(entity.spatial) : null,
    lastObservedTick: tick, confidence: fine ? .9 : .7, disposition: numericComponent(entity, 'disposition'),
    localTrust: previous?.localTrust ?? 0, tradeExperience: previous?.tradeExperience ?? 0, migrationBalance: previous?.migrationBalance ?? 0, conflictPressure: previous?.conflictPressure ?? 0,
  };
}

export async function refreshExternalActors(provider: WorldProvider, state: SandboxGameState, summary: SandboxStepSummary): Promise<void> {
  const area = await provider.queryArea({ center: structuredClone(state.settlement.position), radiusKm: 80, requestedDetailRank: 2, observerId: state.world.originEntityId, includeKnowledgeProjection: true });
  const known=accessibleKnownSubjects(state);
  const candidates = area.entities.filter((entity) => {
    if(entity.id===state.world.originEntityId||!(entity.kind==='settlement'||entity.kind==='organization'||entity.kind==='polity'))return false;
    return known.has(entity.id)||Boolean(entity.spatial&&distance(state.settlement.position,entity.spatial)<=5);
  });
  const previousById = new Map(state.externalActors.map((entry) => [entry.entityId, entry])); const previousIds = new Set(previousById.keys()); const next:ExternalActorProjection[]=[];
  for(const entity of candidates){ const fine=await directFineProjection(provider,state,entity); next.push(projectionFrom(entity,area.tick,previousById.get(entity.id),fine));
    if (previousIds.has(entity.id)) continue;
    addObservedKnowledge(state, [state.settlement.leaderId], [entity.id], `外部共同体を観測: ${nameOf(entity)}。`, entity.spatial&&distance(state.settlement.position,entity.spatial)<=5 ? .85 : .55);
    summary.knowledgeUpdates.push(`新たな外部勢力を確認: ${nameOf(entity)}。`);
    addChronicle(state, { kind: 'external', title: `外部勢力を確認: ${nameOf(entity)}`, text: fine&&fine.actorIds.length ? `近距離観測で個人 ${fine.actorIds.length}名と関係記録 ${fine.relationshipIds.length}件を確認。` : '遠距離観測のため、確認できた情報は限定的です。', entityIds: [entity.id,...(fine?.actorIds.slice(0,4)??[])] });
  }
  state.externalActors=next;
}

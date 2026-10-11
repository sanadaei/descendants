import type { AreaProjection, SpatialRef, WorldEntity, WorldProvider } from '../worldbridge/contract.js';
import { addObservedKnowledge } from './knowledgeSimulation.js';
import { collectPhysicalSample, ensureDirectPlayState, entityName, reserveDirectActivity } from './directPlay.js';
import { findAgent, nextStateId } from './stateUtils.js';
import type { KnowledgeEntry, PhysicalInventoryItem, SandboxGameState, SettlementResourceKey } from './types.js';
import { ensureResourceSourcesForWorldEntity, recordCarriedResourceDeposit, resourceSourceKeysForWorldEntity, resourceUnit, withdrawResourceSource } from './resourceLedger.js';

export function spatialDistanceKm(a: SpatialRef, b: SpatialRef): number {
  if (a.frameId !== b.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

export async function queryGeneratedLocalArea(
  provider: WorldProvider,
  state: SandboxGameState,
  observerId: string,
  center: SpatialRef,
  radiusKm = 5,
): Promise<AreaProjection> {
  return provider.queryArea({
    center: structuredClone(center),
    radiusKm,
    requestedDetailRank: 0,
    observerId,
    includeKnowledgeProjection: true,
  });
}

export function generatedWorldMapRadiusKm(state: SandboxGameState): number {
  const extent = state.world.manifest.geometry.extent;
  return Math.max(25, Math.hypot(extent.widthKm, extent.heightKm) * 0.55);
}

export async function queryGeneratedWorldArea(
  provider: WorldProvider,
  state: SandboxGameState,
  observerId: string,
  center: SpatialRef = state.settlement.position,
): Promise<AreaProjection> {
  return provider.queryArea({
    center: structuredClone(center),
    radiusKm: generatedWorldMapRadiusKm(state),
    requestedDetailRank: 2,
    observerId,
    includeKnowledgeProjection: true,
  });
}

export function isSampleableEntity(entity: WorldEntity): boolean {
  return Boolean(entity.spatial) && (entity.kind === 'anomaly' || /resource|ecolog|archaeolog|histor|ruin|trace|material/i.test(`${entity.kind} ${entity.subtype ?? ''} ${(entity.tags ?? []).join(' ')}`));
}

export function observedEntityMetadata(entity: WorldEntity): NonNullable<KnowledgeEntry['entityObservation']> {
  return {
    entityId: entity.id, kind: entity.kind, ...(entity.subtype ? { subtype: entity.subtype } : {}),
    ...(entity.kind === 'historical-trace' && typeof entity.components.traceType === 'string' ? { traceType: entity.components.traceType } : {}),
    resourceKeys: resourceSourceKeysForWorldEntity(entity),
    ...(entity.spatial ? { position: structuredClone(entity.spatial) } : {}),
  };
}

export function observeGeneratedEntity(state: SandboxGameState, agentId: string, entity: WorldEntity): KnowledgeEntry {
  const agent = findAgent(state, agentId);
  if (!agent?.alive) throw new Error('Controlled person is unavailable.');
  const label = entityName(entity);
  const detailBits: string[] = [entity.kind];
  if (entity.subtype) detailBits.push(entity.subtype);
  const tags = (entity.tags ?? []).slice(0, 4);
  if (tags.length) detailBits.push(tags.join(', '));
  reserveDirectActivity(state, [agentId], 'observe', 30, `Observed ${label}.`, entity.id);
  agent.memories.push({ id: `memory:observe:${state.sequence}:${entity.id}`, day: state.clock.day, kind: 'knowledge', text: `Observed ${label} at close range.`, salience: 0.58, sourceIds: [entity.id] });
  if (agent.memories.length > 80) agent.memories.splice(0, agent.memories.length - 80);
  const knowledge = addObservedKnowledge(
    state, [agentId], [entity.id], `${label}: direct observation (${detailBits.join(' / ')}).`, 0.82, undefined,
    entity.provenanceIds, { promoteToSettlement: false },
  );
  knowledge.physicalEvidenceSourceEntityId = entity.id;
  knowledge.requiresPhysicalSample = isSampleableEntity(entity);
  knowledge.entityObservation = observedEntityMetadata(entity);
  return knowledge;
}

export function surveyEmptySurroundings(state: SandboxGameState, agentId: string, center: SpatialRef, radiusKm = 5): KnowledgeEntry {
  const agent = findAgent(state, agentId);
  if (!agent?.alive) throw new Error('Controlled person is unavailable.');
  reserveDirectActivity(state, [agentId], 'survey', 45, `Surveyed an apparently empty ${radiusKm.toFixed(1)} km local radius.`);
  const spatialSubject = `survey:${center.frameId}:${center.x.toFixed(2)}:${center.y.toFixed(2)}:${radiusKm.toFixed(1)}`;
  return addObservedKnowledge(
    state, [agentId], [spatialSubject], `No notable generated entity was observed within the surveyed ${radiusKm.toFixed(1)} km local radius.`,
    0.72, undefined, [], { promoteToSettlement: false },
  );
}

export function takeGeneratedSample(state: SandboxGameState, agentId: string, entity: WorldEntity): { item: PhysicalInventoryItem; knowledge: KnowledgeEntry } {
  const item = collectPhysicalSample(state, agentId, entity);
  reserveDirectActivity(state, [agentId], 'sample', 45, `Collected a physical sample from ${entityName(entity)}.`, entity.id);
  const knowledge = addObservedKnowledge(
    state, [agentId], [entity.id, item.id], `Collected a physical sample from ${entityName(entity)}; source provenance is attached to the carried item.`,
    0.9, undefined, item.provenanceIds, { promoteToSettlement: false },
  );
  knowledge.physicalEvidenceSourceEntityId = entity.id;
  knowledge.requiresPhysicalSample = true;
  knowledge.entityObservation = observedEntityMetadata(entity);
  return { item, knowledge };
}


export function harvestableResourceKeys(entity: WorldEntity): SettlementResourceKey[] {
  return resourceSourceKeysForWorldEntity(entity);
}

function harvestWeightKg(resourceKey: SettlementResourceKey): number {
  if (resourceKey === 'water') return 1;
  if (resourceKey === 'food') return 0.5;
  if (resourceKey === 'medicine') return 0.12;
  if (resourceKey === 'timber') return 1.5;
  if (resourceKey === 'scrap') return 1.2;
  if (resourceKey === 'fuel') return 0.8;
  if (resourceKey === 'cloth') return 0.25;
  return 0.1;
}

export function harvestGeneratedResource(
  state: SandboxGameState,
  agentId: string,
  entity: WorldEntity,
  resourceKey: SettlementResourceKey,
  requestedAmount = 1,
): PhysicalInventoryItem {
  const agent = findAgent(state, agentId);
  if (!agent?.alive) throw new Error('Controlled person is unavailable.');
  if (!entity.spatial) throw new Error('Resource harvest requires a spatial provider entity.');
  const field = agent.expeditionId ? state.expeditions.find((entry) => entry.id === agent.expeditionId) : undefined;
  const position = field?.position ?? state.settlement.position;
  if (spatialDistanceKm(position, entity.spatial) > 0.35) throw new Error('Approach the resource before harvesting.');
  const sources = ensureResourceSourcesForWorldEntity(state, entity);
  const source = sources.find((entry) => entry.resourceKey === resourceKey);
  if (!source) throw new Error(`${entityName(entity)} is not provider-visible as ${resourceKey}.`);
  const { amount } = withdrawResourceSource(state, source.id, requestedAmount);
  const direct = ensureDirectPlayState(state);
  const existing = direct.inventory.find((item) => item.ownerId === agentId && item.kind === 'resource' && item.resourceSourceId === source.id && item.resourceKey === resourceKey && item.resourceSubtype === source.subtype);
  const contamination = resourceKey === 'water' ? Math.max(0, Math.min(1, (100-state.settlement.waterSafety)/100)) : 0.04;
  if (existing) {
    existing.quantity += amount;
    existing.resourceCondition = Math.min(existing.resourceCondition ?? 1, 1);
    existing.resourceFreshness = Math.min(existing.resourceFreshness ?? 1, 1);
    reserveDirectActivity(state,[agentId],'harvest',60,`Harvested ${amount.toFixed(2)} ${resourceUnit(resourceKey)} of ${source.label}.`,entity.id);
    return existing;
  }
  const item: PhysicalInventoryItem = {
    id: nextStateId(state,'item'),
    ownerId: agentId,
    kind: 'resource',
    name: source.label,
    quantity: amount,
    weightKg: harvestWeightKg(resourceKey),
    sourceEntityId: entity.id,
    provenanceIds: [...new Set([...entity.provenanceIds, ...source.worldProvenanceIds, `resource-source:${source.id}`])],
    acquiredDay: state.clock.day,
    acquiredMinuteOfDay: state.clock.minuteOfDay,
    resourceKey,
    resourceSubtype: source.subtype,
    resourceUnit: resourceUnit(resourceKey),
    resourceSourceId: source.id,
    resourceCondition: 1,
    resourceFreshness: 1,
    resourceContaminationRisk: contamination,
    ...(resourceKey === 'water' ? { resourceWaterQuality:{ microbialRisk:contamination, chemicalRisk:0.05, turbidity:0.1 } } : {}),
  };
  direct.inventory.push(item);
  reserveDirectActivity(state,[agentId],'harvest',60,`Harvested ${amount.toFixed(2)} ${resourceUnit(resourceKey)} of ${source.label}.`,entity.id);
  return item;
}

export function depositCarriedResourcesAtSettlement(state: SandboxGameState, agentIds: string[]): import('./types.js').ResourceLotState[] {
  if (!state.directPlay) return [];
  const owners = new Set(agentIds);
  const lots: import('./types.js').ResourceLotState[] = [];
  for (const item of state.directPlay.inventory) {
    if (!owners.has(item.ownerId) || item.kind !== 'resource' || !item.resourceKey || !item.resourceSubtype || !item.resourceSourceId || item.quantity <= 0) continue;
    const amount = item.quantity;
    const lot = recordCarriedResourceDeposit(state,{
      resourceKey:item.resourceKey,
      amount,
      sourceId:item.resourceSourceId,
      subtype:item.resourceSubtype,
      label:item.name,
      harvesterId:item.ownerId,
      worldEntityIds:item.sourceEntityId?[item.sourceEntityId]:[],
      worldProvenanceIds:[...item.provenanceIds],
      ...(item.resourceCondition !== undefined ? { condition:item.resourceCondition } : {}),
      ...(item.resourceFreshness !== undefined ? { freshness:item.resourceFreshness } : {}),
      ...(item.resourceContaminationRisk !== undefined ? { contaminationRisk:item.resourceContaminationRisk } : {}),
      ...(item.resourceWaterQuality !== undefined ? { waterQuality:item.resourceWaterQuality } : {}),
      harvestedDay:item.acquiredDay,
      harvestedMinuteOfDay:item.acquiredMinuteOfDay??0,
    });
    item.quantity = 0;
    lots.push(lot);
  }
  return lots;
}

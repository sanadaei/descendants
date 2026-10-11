import type { WorldEntity } from '../worldbridge/contract.js';
import { legacyFacilityActive } from './legacyProjectBenefits.js';
import type {
  ResourceCanonicalUnit,
  ResourceLedgerStateV1,
  ResourceLotState,
  ResourceSourceState,
  SandboxGameState,
  SettlementResourceKey,
} from './types.js';

export const SETTLEMENT_RESOURCE_KEYS: SettlementResourceKey[] = ['food','water','medicine','timber','scrap','fuel','cloth','records'];

function round(value: number): number { return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000; }

export function resourceUnit(key: SettlementResourceKey): ResourceCanonicalUnit {
  if (key === 'food') return 'ration-unit';
  if (key === 'water') return 'liter';
  if (key === 'medicine') return 'dose-unit';
  if (key === 'fuel') return 'fuel-unit';
  if (key === 'cloth') return 'cloth-unit';
  if (key === 'records') return 'record-copy';
  return 'material-unit';
}

function originProvenance(state: SandboxGameState): { worldEntityIds: string[]; worldProvenanceIds: string[] } {
  const origin = state.world.providerSnapshot.entities.find((entry) => entry.id === state.world.originEntityId);
  return {
    worldEntityIds: [state.world.originEntityId],
    worldProvenanceIds: [...(origin?.provenanceIds ?? [])],
  };
}

function legacySource(state: SandboxGameState, key: SettlementResourceKey, amount: number): ResourceSourceState {
  const provenance = originProvenance(state);
  return {
    id: `resource-source:legacy:${key}:${state.world.originEntityId}`,
    resourceKey: key,
    kind: 'legacy',
    subtype: `${key}:legacy-settlement-stock`,
    label: `${key} legacy settlement source`,
    ...provenance,
    position: structuredClone(state.settlement.position),
    renewable: false,
    accessibleStock: amount,
    carryingCapacity: amount,
    regenerationPerDay: 0,
    depletionFraction: amount > 0 ? 0 : 1,
  };
}

function legacyLot(state: SandboxGameState, key: SettlementResourceKey, amount: number, source: ResourceSourceState): ResourceLotState {
  return {
    id: `resource-lot:legacy:${key}:${state.world.originEntityId}`,
    resourceKey: key,
    subtype: `${key}:legacy-settlement-stock`,
    label: `${key} · legacy settlement stock`,
    quantity: amount,
    unit: resourceUnit(key),
    sourceId: source.id,
    worldEntityIds: [...source.worldEntityIds],
    worldProvenanceIds: [...source.worldProvenanceIds],
    createdDay: state.clock.day,
    createdMinuteOfDay: state.clock.minuteOfDay,
    harvesterIds: [],
    sourcePosition: structuredClone(state.settlement.position),
    condition: 1,
    freshness: 1,
    contaminationRisk: 0,
    processingHistory: [{ kind: 'reconciled', day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, agentIds: [], note: 'Migrated from schemaVersion 1 aggregate settlement stock without inventing more specific provenance.' }],
    parentLotIds: [],
    storageLocationId: state.settlement.id,
    custodyHistory: [{ storageLocationId:state.settlement.id, day:state.clock.day, minuteOfDay:state.clock.minuteOfDay, note:'Settlement custody at legacy migration.' }],
  };
}

export function ensureResourceLedgerState(state: SandboxGameState): ResourceLedgerStateV1 {
  if (state.resourceLedger) return state.resourceLedger;
  const ledger: ResourceLedgerStateV1 = { schemaVersion: 1, sources: [], lots: [], allocationGroups: [], allocationRules: [], recentDistributions: [] };
  for (const key of SETTLEMENT_RESOURCE_KEYS) {
    const amount = Number(state.settlement.resources[key] ?? 0);
    if (amount <= 0) continue;
    const source = legacySource(state, key, amount);
    ledger.sources.push(source);
    ledger.lots.push(legacyLot(state, key, amount, source));
  }
  state.resourceLedger = ledger;
  return ledger;
}

export function resourceLots(state: SandboxGameState, key?: SettlementResourceKey): ResourceLotState[] {
  const lots = ensureResourceLedgerState(state).lots;
  return key ? lots.filter((entry) => entry.resourceKey === key && entry.quantity > 0) : lots.filter((entry) => entry.quantity > 0);
}

export function resourceSources(state: SandboxGameState, key?: SettlementResourceKey): ResourceSourceState[] {
  const sources = ensureResourceLedgerState(state).sources;
  return key ? sources.filter((entry) => entry.resourceKey === key) : sources;
}

export function resourceLotTotal(state: SandboxGameState, key: SettlementResourceKey): number {
  return resourceLots(state, key).reduce((sum, entry) => sum + Math.max(0, entry.quantity), 0);
}

export function syncSettlementResourceAggregates(state: SandboxGameState): void {
  const totals = Object.fromEntries(SETTLEMENT_RESOURCE_KEYS.map((key) => [key,0])) as Record<SettlementResourceKey,number>;
  for (const lot of ensureResourceLedgerState(state).lots) if (lot.quantity > 0) totals[lot.resourceKey] += lot.quantity;
  for (const key of SETTLEMENT_RESOURCE_KEYS) state.settlement.resources[key] = totals[key];
}

/** All new stock changes go through lots. Aggregate reconciliation is for legacy callers only. */
export function adjustResourceStock(state: SandboxGameState, key: SettlementResourceKey, delta: number, note: string): void {
  if (!Number.isFinite(delta)) throw new Error('Resource adjustment must be finite.');
  if (delta < 0) consumeResourceLots(state, { resourceKey: key, amount: -delta });
  else if (delta > 0) appendLot(state, key, delta, createAdjustmentSource(state, key), { note, label: `${key} · ${note}` });
  syncSettlementResourceAggregates(state);
}

export function restoreReservedResourceLots(state: SandboxGameState, lines: Array<{lotId: string; quantity: number}>, fraction: number): void {
  const ledger = ensureResourceLedgerState(state);
  for (const line of lines) {
    const lot = ledger.lots.find((entry) => entry.id === line.lotId);
    if (!lot) throw new Error('Reserved resource lot is missing.');
    lot.quantity = round(lot.quantity + line.quantity * Math.max(0, Math.min(1, fraction)));
  }
  syncSettlementResourceAggregates(state);
}

interface RecordResourceProductionInput {
  resourceKey: SettlementResourceKey;
  amount: number;
  sourceId?: string;
  subtype?: string;
  label?: string;
  harvesterIds?: string[];
  note?: string;
  sourcePreference?: string[];
}

interface ConsumeResourceLotsInput {
  resourceKey: SettlementResourceKey;
  amount: number;
  lotIds?: string[];
  subtypes?: string[];
  excludedLotIds?: string[];
}

function finite(value: unknown, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function recordValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function nextLedgerId(state: SandboxGameState, prefix: string): string { state.sequence += 1; return `${prefix}:${state.sequence.toString(36).padStart(4,'0')}`; }

function sourceSubtypeFor(state: SandboxGameState, key: SettlementResourceKey, entity: WorldEntity): { subtype: string; label: string } {
  const components = recordValue(entity.components);
  const resourceKind = stringValue(components.resourceKind) ?? entity.subtype ?? '';
  const guildKind = stringValue(components.guildKind) ?? entity.subtype ?? '';
  if (key === 'food' && entity.kind === 'ecological-guild' && guildKind === 'consumer') return { subtype: 'meat:wild-game:unclassified-consumer-guild', label: 'wild-game meat · unclassified consumer guild' };
  if (key === 'food' && entity.kind === 'ecological-guild' && guildKind === 'primary-producer') return { subtype: 'plant:foraged-staple:unclassified-producer-guild', label: 'foraged plant staple · unclassified producer guild' };
  if (key === 'food' && resourceKind === 'biomass') return { subtype: 'food:edible-biomass', label: 'edible biomass · provider ecological resource' };
  if (key === 'water' && resourceKind === 'freshwater') {
    const regionId = stringValue(components.regionId);
    const region = regionId ? state.world.providerSnapshot.entities.find((entry) => entry.id === regionId) : undefined;
    const terrain = recordValue(recordValue(region?.components).terrain);
    const river = finite(terrain.riverFraction, 0); const lake = finite(terrain.lakeFraction, 0);
    if (river >= 0.12) return { subtype: 'water:river:freshwater', label: 'river water · provider freshwater source' };
    if (lake >= 0.1) return { subtype: 'water:lake:freshwater', label: 'lake water · provider freshwater source' };
    return { subtype: 'water:freshwater:unclassified-source', label: 'freshwater · source type unclassified' };
  }
  if (key === 'medicine' && (guildKind === 'primary-producer' || resourceKind === 'biomass')) return { subtype: 'medicine:botanical:unclassified', label: 'medicinal biomass · unclassified botanical source' };
  if (key === 'timber' && (guildKind === 'primary-producer' || resourceKind === 'biomass')) return { subtype: 'timber:woody-biomass:unclassified', label: 'woody biomass · unclassified producer source' };
  if (key === 'scrap' && resourceKind === 'mineral-access') return { subtype: 'material:mineral-access', label: 'mineral-access material' };
  if (key === 'fuel' && resourceKind === 'biomass') return { subtype: 'fuel:biomass', label: 'biomass fuel stock' };
  if (key === 'cloth' && (guildKind === 'primary-producer' || resourceKind === 'biomass')) return { subtype: 'cloth:fiber-biomass:unclassified', label: 'fiber biomass · unclassified source' };
  if (key === 'records') return { subtype: 'records:institutional-copy', label: 'institutional record copies' };
  return { subtype: `${key}:provider-source`, label: `${key} · provider-linked source` };
}

export function resourceSourceKeysForWorldEntity(entity: WorldEntity): SettlementResourceKey[] {
  const components = recordValue(entity.components);
  const resourceKind = stringValue(components.resourceKind) ?? entity.subtype ?? '';
  const guildKind = stringValue(components.guildKind) ?? entity.subtype ?? '';
  if (entity.kind === 'ecological-resource' && resourceKind === 'freshwater') return ['water'];
  if (entity.kind === 'ecological-resource' && resourceKind === 'mineral-access') return ['scrap'];
  if (entity.kind === 'ecological-resource' && resourceKind === 'biomass') return ['food','medicine','timber','fuel','cloth'];
  if (entity.kind === 'ecological-guild' && guildKind === 'consumer') return ['food'];
  if (entity.kind === 'ecological-guild' && guildKind === 'primary-producer') return ['food','medicine','timber','cloth'];
  const institutionType = stringValue(components.institutionType) ?? entity.subtype ?? '';
  if (entity.kind === 'institution' && institutionType === 'medical-practice') return ['medicine'];
  if (entity.kind === 'institution' && institutionType === 'communications') return ['records'];
  return [];
}

function providerSource(state: SandboxGameState, key: SettlementResourceKey, entity: WorldEntity): ResourceSourceState {
  const components = recordValue(entity.components);
  const isGuild = entity.kind === 'ecological-guild';
  const current = isGuild ? finite(components.abundance, 0) : finite(components.currentStock, 0);
  const capacity = isGuild ? finite(components.abundanceCapacity, current) : finite(components.carryingStock, current);
  const regen = isGuild ? current * finite(components.reproductionRatePerDay, 0) : finite(components.regenerationPerDay, 0);
  const renewable = isGuild || components.renewable === true;
  const naming = sourceSubtypeFor(state, key, entity);
  const regionId = stringValue(components.regionId);
  return {
    id: `resource-source:${key}:${entity.id}`,
    resourceKey: key,
    kind: isGuild ? 'ecological-guild' : entity.kind === 'ecological-resource' ? 'ecological-resource' : 'institution',
    subtype: naming.subtype,
    label: naming.label,
    worldEntityIds: [entity.id],
    worldProvenanceIds: [...entity.provenanceIds],
    ...(entity.spatial ? { position: structuredClone(entity.spatial) } : {}),
    ...(regionId ? { regionId } : {}),
    renewable,
    accessibleStock: Math.max(0, current),
    carryingCapacity: Math.max(0, Math.max(current, capacity)),
    regenerationPerDay: Math.max(0, regen),
    depletionFraction: capacity > 0 ? clamp01(1 - current / capacity) : 0,
  };
}

function settlementFallbackSource(state: SandboxGameState, key: SettlementResourceKey): ResourceSourceState {
  const origin = state.world.providerSnapshot.entities.find((entry) => entry.id === state.world.originEntityId);
  return {
    id: `resource-source:settlement:${key}:${state.world.originEntityId}`,
    resourceKey: key,
    kind: 'settlement-stock',
    subtype: `${key}:settlement-stock`,
    label: `${key} · settlement-origin stock`,
    worldEntityIds: [state.world.originEntityId],
    worldProvenanceIds: [...(origin?.provenanceIds ?? [])],
    position: structuredClone(state.settlement.position),
    renewable: false,
    accessibleStock: 0,
    carryingCapacity: 0,
    regenerationPerDay: 0,
    depletionFraction: 0,
  };
}

function initialLotFromSource(state: SandboxGameState, key: SettlementResourceKey, amount: number, source: ResourceSourceState): ResourceLotState {
  return {
    id: `resource-lot:initial:${key}:${source.id}`,
    resourceKey: key,
    subtype: source.subtype,
    label: `${source.label} · initial settlement stock`,
    quantity: amount,
    unit: resourceUnit(key),
    sourceId: source.id,
    worldEntityIds: [...source.worldEntityIds],
    worldProvenanceIds: [...source.worldProvenanceIds],
    createdDay: state.clock.day,
    createdMinuteOfDay: state.clock.minuteOfDay,
    harvesterIds: [],
    ...(source.position ? { sourcePosition: structuredClone(source.position) } : {}),
    condition: 1,
    freshness: 1,
    contaminationRisk: key === 'water' ? clamp01((100 - state.settlement.waterSafety) / 100) : 0,
    ...(key === 'water' ? { waterQuality: { microbialRisk: clamp01((100-state.settlement.waterSafety)/100), chemicalRisk: 0.05, turbidity: 0.1 } } : {}),
    processingHistory: [{ kind: 'reconciled', day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, agentIds: [], note: 'Initial scalar settlement stock attached to the most specific provider-visible compatible source without asserting hidden species truth.' }],
    parentLotIds: [],
    storageLocationId: state.settlement.id,
    custodyHistory: [{ storageLocationId:state.settlement.id, day:state.clock.day, minuteOfDay:state.clock.minuteOfDay, note:'Settlement custody for initial stock.' }],
  };
}

export function ensureResourceSourcesForWorldEntity(state: SandboxGameState, entity: WorldEntity): ResourceSourceState[] {
  const ledger = ensureResourceLedgerState(state);
  const keys = resourceSourceKeysForWorldEntity(entity);
  const sources: ResourceSourceState[] = [];
  for (const key of keys) {
    let source = ledger.sources.find((entry) => entry.resourceKey === key && entry.worldEntityIds.includes(entity.id));
    if (!source) {
      source = providerSource(state, key, entity);
      ledger.sources.push(source);
    }
    sources.push(source);
  }
  return sources;
}

export function withdrawResourceSource(state: SandboxGameState, sourceId: string, requestedAmount: number): { source: ResourceSourceState; amount: number } {
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) throw new Error('Harvest amount must be positive.');
  const source = ensureResourceLedgerState(state).sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Unknown resource source: ${sourceId}`);
  const bounded = source.kind === 'ecological-resource' || source.kind === 'ecological-guild';
  const amount = bounded ? Math.min(requestedAmount, Math.max(0, source.accessibleStock)) : requestedAmount;
  if (amount <= 0) throw new Error(`Resource source ${source.id} is depleted.`);
  if (bounded) {
    source.accessibleStock = round(source.accessibleStock - amount);
    source.depletionFraction = source.carryingCapacity > 0 ? clamp01(1 - source.accessibleStock / source.carryingCapacity) : 1;
    source.lastHarvestDay = state.clock.day;
    source.lastHarvestMinuteOfDay = state.clock.minuteOfDay;
  }
  return { source, amount };
}

export function initializeResourceLedgerFromWorld(state: SandboxGameState): ResourceLedgerStateV1 {
  const totals = structuredClone(state.settlement.resources);
  const ledger: ResourceLedgerStateV1 = { schemaVersion: 1, sources: [], lots: [], allocationGroups: [], allocationRules: [], recentDistributions: [] };
  for (const entity of state.world.providerSnapshot.entities) {
    for (const key of resourceSourceKeysForWorldEntity(entity)) ledger.sources.push(providerSource(state, key, entity));
  }
  for (const key of SETTLEMENT_RESOURCE_KEYS) {
    if (!ledger.sources.some((entry) => entry.resourceKey === key)) ledger.sources.push(settlementFallbackSource(state, key));
    const amount = Number(totals[key] ?? 0);
    if (amount <= 0) continue;
    const sources = ledger.sources.filter((entry) => entry.resourceKey === key);
    const preferred = [...sources].sort((a,b) => {
      const rank = (source: ResourceSourceState) => source.kind === 'ecological-guild' ? 0 : source.kind === 'ecological-resource' ? 1 : source.kind === 'institution' ? 2 : 3;
      return rank(a)-rank(b) || a.id.localeCompare(b.id);
    })[0] ?? settlementFallbackSource(state,key);
    ledger.lots.push(initialLotFromSource(state,key,amount,preferred));
  }
  state.resourceLedger = ledger;
  syncSettlementResourceAggregates(state);
  return ledger;
}

function createAdjustmentSource(state: SandboxGameState, key: SettlementResourceKey): ResourceSourceState {
  const ledger = ensureResourceLedgerState(state);
  const existing = ledger.sources.find((entry) => entry.resourceKey === key && entry.kind === 'system-adjustment');
  if (existing) return existing;
  const origin = state.world.providerSnapshot.entities.find((entry) => entry.id === state.world.originEntityId);
  const source: ResourceSourceState = {
    id: `resource-source:system-adjustment:${key}:${state.world.originEntityId}`,
    resourceKey: key, kind: 'system-adjustment', subtype: `${key}:system-adjustment`, label: `${key} · system adjustment source`,
    worldEntityIds: [state.world.originEntityId], worldProvenanceIds: [...(origin?.provenanceIds ?? [])], position: structuredClone(state.settlement.position),
    renewable: false, accessibleStock: 0, carryingCapacity: 0, regenerationPerDay: 0, depletionFraction: 0,
  };
  ledger.sources.push(source); return source;
}

function appendLot(state: SandboxGameState, key: SettlementResourceKey, amount: number, source: ResourceSourceState, input: Omit<RecordResourceProductionInput,'resourceKey'|'amount'|'sourceId'> = {}): ResourceLotState {
  const subtype = input.subtype ?? source.subtype;
  const label = input.label ?? `${source.label} · gathered stock`;
  const lot: ResourceLotState = {
    id: nextLedgerId(state,'resource-lot'), resourceKey:key, subtype, label, quantity:amount, unit:resourceUnit(key), sourceId:source.id,
    worldEntityIds:[...source.worldEntityIds], worldProvenanceIds:[...source.worldProvenanceIds], createdDay:state.clock.day, createdMinuteOfDay:state.clock.minuteOfDay,
    harvesterIds:[...(input.harvesterIds ?? [])], ...(source.position?{sourcePosition:structuredClone(source.position)}:{}), condition:1, freshness:1,
    contaminationRisk:key==='water'?clamp01((100-state.settlement.waterSafety)/100):0,
    ...(key==='water'?{waterQuality:{microbialRisk:clamp01((100-state.settlement.waterSafety)/100),chemicalRisk:0.05,turbidity:0.1}}:{}),
    processingHistory:[{kind:'raw',day:state.clock.day,minuteOfDay:state.clock.minuteOfDay,agentIds:[...(input.harvesterIds??[])],note:input.note??'Produced from a tracked resource source.'}],
    parentLotIds:[], storageLocationId:state.settlement.id, custodyHistory:[{storageLocationId:state.settlement.id,day:state.clock.day,minuteOfDay:state.clock.minuteOfDay,note:'Produced into settlement custody.'}],
  };
  ensureResourceLedgerState(state).lots.push(lot); return lot;
}

export function recordResourceProduction(state: SandboxGameState, input: RecordResourceProductionInput): ResourceLotState {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Resource production amount must be positive.');
  const ledger = ensureResourceLedgerState(state);
  const candidates = ledger.sources.filter((entry) => entry.resourceKey === input.resourceKey);
  const rank = (source: ResourceSourceState): number => {
    const haystack = `${source.subtype} ${source.label}`.toLowerCase();
    const preferences = input.sourcePreference ?? [];
    const match = preferences.findIndex((entry) => haystack.includes(entry.toLowerCase()));
    const availabilityPenalty = (source.kind === 'ecological-resource' || source.kind === 'ecological-guild') && source.accessibleStock <= 0 ? 1000 : 0;
    return availabilityPenalty + (match >= 0 ? match : preferences.length + 10);
  };
  const source = input.sourceId ? candidates.find((entry) => entry.id === input.sourceId) : [...candidates].sort((a,b)=>rank(a)-rank(b)||a.id.localeCompare(b.id))[0];
  if (!source) throw new Error(`No resource source exists for ${input.resourceKey}.`);
  const bounded = source.kind === 'ecological-resource' || source.kind === 'ecological-guild';
  const produced = bounded ? Math.min(input.amount, source.accessibleStock) : input.amount;
  if (produced <= 0) throw new Error(`Resource source ${source.id} is depleted.`);
  if (bounded) {
    source.accessibleStock = round(source.accessibleStock - produced);
    source.depletionFraction = source.carryingCapacity > 0 ? clamp01(1 - source.accessibleStock/source.carryingCapacity) : 1;
    source.lastHarvestDay = state.clock.day; source.lastHarvestMinuteOfDay = state.clock.minuteOfDay;
  }
  const lot = appendLot(state,input.resourceKey,produced,source,input);
  syncSettlementResourceAggregates(state);
  return lot;
}

export function regenerateResourceSources(state: SandboxGameState, days: number): void {
  if (!Number.isFinite(days) || days <= 0) return;
  for (const source of ensureResourceLedgerState(state).sources) {
    if (!source.renewable || source.regenerationPerDay <= 0 || source.carryingCapacity <= 0) continue;
    source.accessibleStock = round(Math.min(source.carryingCapacity, source.accessibleStock + source.regenerationPerDay * days));
    source.depletionFraction = clamp01(1 - source.accessibleStock/source.carryingCapacity);
  }
}

export function consumeResourceLots(state: SandboxGameState, input: ConsumeResourceLotsInput): Array<{lotId:string;quantity:number}> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return [];
  const lines = consumeFromCandidateLots(resourceLots(state,input.resourceKey),input);
  syncSettlementResourceAggregates(state); return lines;
}

/** Candidate objects remain live; quantities are checked again for each recipient. */
function consumeFromCandidateLots(lots: ResourceLotState[], input: ConsumeResourceLotsInput): Array<{lotId:string;quantity:number}> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return [];
  const lotIdSet = input.lotIds?.length ? new Set(input.lotIds) : null;
  const subtypeSet = input.subtypes?.length ? new Set(input.subtypes) : null;
  const excluded = new Set(input.excludedLotIds ?? []);
  const candidates = lots
    .filter((lot)=>lot.quantity>0 && !excluded.has(lot.id) && (!lotIdSet || lotIdSet.has(lot.id)) && (!subtypeSet || subtypeSet.has(lot.subtype)))
    .sort((a,b)=>a.createdDay-b.createdDay || a.createdMinuteOfDay-b.createdMinuteOfDay || a.id.localeCompare(b.id));
  let remaining = input.amount; const lines:Array<{lotId:string;quantity:number}>=[];
  for (const lot of candidates) {
    if (remaining <= 1e-9) break;
    const used = Math.min(lot.quantity,remaining);
    if (used <= 0) continue;
    // Round the persisted remainder once per lot, but keep the requested total exact across lots.
    // Rounding this accumulator for every source made many small harvests underfund a phase.
    lot.quantity = round(lot.quantity-used); remaining = Math.max(0,remaining-used); lines.push({lotId:lot.id,quantity:used});
  }
  return lines;
}

export function reconcileResourceLedgerToAggregates(state: SandboxGameState, context: string): void {
  const ledger = ensureResourceLedgerState(state);
  const target = structuredClone(state.settlement.resources);
  for (const key of SETTLEMENT_RESOURCE_KEYS) {
    const current = resourceLotTotal(state,key); const desired = Number(target[key] ?? 0); const delta = desired-current;
    if (Math.abs(delta) <= 1e-9) continue;
    if (delta > 0) {
      const source = createAdjustmentSource(state,key);
      appendLot(state,key,delta,source,{label:`${key} · system adjustment (${context})`,note:`Captured legacy aggregate increase: ${context}.`});
    } else {
      consumeResourceLots(state,{resourceKey:key,amount:-delta});
    }
  }
  syncSettlementResourceAggregates(state);
  void ledger;
}


export function recordTradeResourceGain(state: SandboxGameState, resourceKey: SettlementResourceKey, amount: number, targetEntityId: string): ResourceLotState {
  const ledger = ensureResourceLedgerState(state);
  let source = ledger.sources.find((entry) => entry.kind === 'trade' && entry.resourceKey === resourceKey && entry.worldEntityIds.includes(targetEntityId));
  if (!source) {
    const entity = state.world.providerSnapshot.entities.find((entry) => entry.id === targetEntityId);
    source = {
      id: `resource-source:trade:${resourceKey}:${targetEntityId}`,
      resourceKey,
      kind: 'trade',
      subtype: `${resourceKey}:trade`,
      label: `${resourceKey} · trade from ${targetEntityId}`,
      worldEntityIds: [targetEntityId],
      worldProvenanceIds: [...(entity?.provenanceIds ?? [])],
      ...(entity?.spatial ? { position: structuredClone(entity.spatial) } : {}),
      renewable: false,
      accessibleStock: 0,
      carryingCapacity: 0,
      regenerationPerDay: 0,
      depletionFraction: 0,
    };
    ledger.sources.push(source);
  }
  return recordResourceProduction(state, {
    resourceKey,
    amount,
    sourceId: source.id,
    label: `${resourceKey} · traded stock from ${targetEntityId}`,
    note: 'Received through an observed external trade relationship.',
  });
}

export function deterministicProductionPreference(agentId: string, resourceKey: SettlementResourceKey, day: number): string[] {
  let hash = day >>> 0;
  for (let index = 0; index < agentId.length; index += 1) hash = Math.imul(hash ^ agentId.charCodeAt(index), 16777619) >>> 0;
  if (resourceKey === 'food') return (hash & 1) === 0 ? ['meat','plant','biomass'] : ['plant','meat','biomass'];
  if (resourceKey === 'water') return ['river water','lake water','freshwater'];
  if (resourceKey === 'medicine') return ['botanical','medical','biomass'];
  if (resourceKey === 'timber') return ['woody','producer','biomass'];
  if (resourceKey === 'scrap') return ['mineral'];
  if (resourceKey === 'fuel') return ['biomass'];
  if (resourceKey === 'cloth') return ['fiber','producer','biomass'];
  return ['institutional','records'];
}

/** Split a measured aliquot without creating new stock or losing provenance. */
export function splitResourceLot(state: SandboxGameState, lotId: string, amount: number): ResourceLotState {
  const ledger = ensureResourceLedgerState(state), source = ledger.lots.find((lot) => lot.id === lotId);
  if (!source || !Number.isFinite(amount) || amount <= 0 || source.quantity < amount) throw new Error('Invalid resource aliquot.');
  source.quantity = round(source.quantity - amount);
  const aliquot = {...structuredClone(source),id:nextLedgerId(state,'resource-lot'),quantity:amount,parentLotIds:[source.id]};
  ledger.lots.push(aliquot); syncSettlementResourceAggregates(state); return aliquot;
}

export function processResourceLot(
  state: SandboxGameState,
  lotId: string,
  kind: import('./types.js').ResourceProcessingKind,
  agentIds: string[] = [],
): ResourceLotState {
  const ledger = ensureResourceLedgerState(state);
  const sourceLot = ledger.lots.find((entry) => entry.id === lotId);
  if (!sourceLot || sourceLot.quantity <= 0) throw new Error(`Resource lot ${lotId} is unavailable.`);
  const amount = sourceLot.quantity;
  sourceLot.quantity = 0;
  const waterQuality = sourceLot.waterQuality ? structuredClone(sourceLot.waterQuality) : undefined;
  let contaminationRisk = sourceLot.contaminationRisk;
  let condition = sourceLot.condition;
  let freshness = sourceLot.freshness;
  if (kind === 'boiled') {
    if (waterQuality) waterQuality.microbialRisk = clamp01(waterQuality.microbialRisk * 0.08);
    contaminationRisk = clamp01(contaminationRisk * 0.2);
  } else if (kind === 'filtered') {
    const equipped = legacyFacilityActive(state,'waterworks');
    if (waterQuality) { waterQuality.microbialRisk = clamp01(waterQuality.microbialRisk * (equipped ? .3 : .55)); waterQuality.turbidity = clamp01(waterQuality.turbidity * (equipped ? .1 : .2)); }
    contaminationRisk = clamp01(contaminationRisk * 0.65);
  } else if (kind === 'cooked') {
    contaminationRisk = clamp01(contaminationRisk * 0.25);
    condition = clamp01(condition + 0.03);
  } else if (kind === 'dried' || kind === 'smoked') {
    contaminationRisk = clamp01(contaminationRisk * (kind === 'smoked' ? 0.35 : 0.5));
    condition = clamp01(condition + 0.02);
  } else if (kind === 'cleaned' || kind === 'prepared' || kind === 'repaired') {
    contaminationRisk = clamp01(contaminationRisk * 0.75);
    condition = clamp01(condition + 0.08);
  }
  const derived: ResourceLotState = {
    ...structuredClone(sourceLot),
    id: nextLedgerId(state,'resource-lot'),
    label: `${sourceLot.label} · ${kind}`,
    quantity: amount,
    condition,
    freshness,
    contaminationRisk,
    ...(waterQuality ? { waterQuality } : {}),
    processingHistory: [...sourceLot.processingHistory, { kind, day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, agentIds:[...new Set(agentIds)], note:`Processed from ${sourceLot.id}; provenance retained.` }],
    parentLotIds: [sourceLot.id],
    custodyHistory: [...(sourceLot.custodyHistory??[]), { storageLocationId:sourceLot.storageLocationId??state.settlement.id, day:state.clock.day, minuteOfDay:state.clock.minuteOfDay, note:`Processed as ${kind}; custody retained.` }],
  };
  ledger.lots.push(derived);
  for (const rule of ledger.allocationRules) if (rule.lotIds.includes(sourceLot.id)) rule.lotIds = rule.lotIds.map((id)=>id===sourceLot.id?derived.id:id);
  syncSettlementResourceAggregates(state);
  return derived;
}

export function ageResourceLots(state: SandboxGameState, days: number): void {
  if (!Number.isFinite(days) || days <= 0) return;
  for (const lot of ensureResourceLedgerState(state).lots) {
    if (lot.quantity <= 0) continue;
    const lastKind = lot.processingHistory.at(-1)?.kind ?? 'raw';
    let rate = 0.002;
    if (lot.resourceKey === 'food') rate = lastKind === 'smoked' ? 0.006 : lastKind === 'dried' ? 0.008 : lastKind === 'cooked' ? 0.04 : 0.07;
    else if (lot.resourceKey === 'medicine') rate = 0.008;
    else if (lot.resourceKey === 'water') rate = lot.containerId ? 0.002 : 0.006;
    else if (lot.resourceKey === 'cloth' || lot.resourceKey === 'records') rate = 0.001;
    lot.freshness = clamp01(lot.freshness - rate * days);
    if (lot.resourceKey === 'food' && lot.freshness < 0.45) lot.contaminationRisk = clamp01(lot.contaminationRisk + (0.45 - lot.freshness) * 0.1 * days);
  }
}

export interface DepositCarriedResourceInput {
  resourceKey: SettlementResourceKey;
  amount: number;
  sourceId: string;
  subtype: string;
  label: string;
  harvesterId: string;
  worldEntityIds: string[];
  worldProvenanceIds: string[];
  condition?: number;
  freshness?: number;
  contaminationRisk?: number;
  waterQuality?: import('./types.js').ResourceWaterQuality;
  harvestedDay?: number;
  harvestedMinuteOfDay?: number;
}

export function recordCarriedResourceDeposit(state: SandboxGameState, input: DepositCarriedResourceInput): ResourceLotState {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Deposited resource amount must be positive.');
  const ledger = ensureResourceLedgerState(state);
  const source = ledger.sources.find((entry) => entry.id === input.sourceId);
  if (!source) throw new Error(`Unknown deposit source ${input.sourceId}.`);
  const lot: ResourceLotState = {
    id: nextLedgerId(state,'resource-lot'),
    resourceKey: input.resourceKey,
    subtype: input.subtype,
    label: `${input.label} · returned field harvest`,
    quantity: input.amount,
    unit: resourceUnit(input.resourceKey),
    sourceId: source.id,
    worldEntityIds: [...new Set(input.worldEntityIds)],
    worldProvenanceIds: [...new Set(input.worldProvenanceIds)],
    createdDay: input.harvestedDay ?? state.clock.day,
    createdMinuteOfDay: input.harvestedMinuteOfDay ?? state.clock.minuteOfDay,
    harvesterIds: [input.harvesterId],
    ...(source.position ? { sourcePosition: structuredClone(source.position) } : {}),
    condition: clamp01(input.condition ?? 1),
    freshness: clamp01(input.freshness ?? 1),
    contaminationRisk: clamp01(input.contaminationRisk ?? 0),
    ...(input.waterQuality ? { waterQuality: structuredClone(input.waterQuality) } : {}),
    processingHistory: [{ kind:'raw', day:state.clock.day, minuteOfDay:state.clock.minuteOfDay, agentIds:[input.harvesterId], note:'Physically returned from field cargo; source provenance retained.' }],
    parentLotIds: [],
    storageLocationId: state.settlement.id,
    custodyHistory: [
      { holderId:input.harvesterId, day:input.harvestedDay??state.clock.day, minuteOfDay:input.harvestedMinuteOfDay??state.clock.minuteOfDay, note:'Harvested into personal field custody.' },
      { storageLocationId:state.settlement.id, day:state.clock.day, minuteOfDay:state.clock.minuteOfDay, note:'Returned and deposited into settlement custody.' },
    ],
  };
  ledger.lots.push(lot);
  syncSettlementResourceAggregates(state);
  return lot;
}

export interface SaveResourceAllocationRuleInput {
  name: string;
  groupId: string;
  resourceKey: SettlementResourceKey;
  lotIds?: string[];
  subtypes?: string[];
  amountPerPersonPerDay: number;
  priority?: number;
  exclusive?: boolean;
  enabled?: boolean;
  ruleId?: string;
}

export function allocationGroups(state: SandboxGameState) {
  return ensureResourceLedgerState(state).allocationGroups;
}

export function allocationRules(state: SandboxGameState) {
  return ensureResourceLedgerState(state).allocationRules;
}

export function saveResourceAllocationGroup(state: SandboxGameState, name: string, memberIds: string[], groupId?: string) {
  const ledger = ensureResourceLedgerState(state);
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Allocation group name is required.');
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) throw new Error('Allocation group requires at least one roster member.');
  const rosterIds = new Set(state.agents.map((agent) => agent.id));
  const unknown = unique.find((id) => !rosterIds.has(id));
  if (unknown) throw new Error(`Unknown roster member: ${unknown}`);
  if (groupId) {
    const existing = ledger.allocationGroups.find((entry) => entry.id === groupId);
    if (!existing) throw new Error(`Unknown allocation group: ${groupId}`);
    existing.name = cleanName;
    existing.memberIds = unique;
    existing.updatedDay = state.clock.day;
    existing.updatedMinuteOfDay = state.clock.minuteOfDay;
    return existing;
  }
  const group = {
    id: nextLedgerId(state,'ration-group'),
    name: cleanName,
    memberIds: unique,
    createdDay: state.clock.day,
    createdMinuteOfDay: state.clock.minuteOfDay,
    updatedDay: state.clock.day,
    updatedMinuteOfDay: state.clock.minuteOfDay,
  };
  ledger.allocationGroups.push(group);
  return group;
}

export function removeResourceAllocationGroup(state: SandboxGameState, groupId: string): void {
  const ledger = ensureResourceLedgerState(state);
  if (!ledger.allocationGroups.some((entry) => entry.id === groupId)) return;
  ledger.allocationGroups = ledger.allocationGroups.filter((entry) => entry.id !== groupId);
  ledger.allocationRules = ledger.allocationRules.filter((entry) => entry.groupId !== groupId);
}

export function saveResourceAllocationRule(state: SandboxGameState, input: SaveResourceAllocationRuleInput) {
  const ledger = ensureResourceLedgerState(state);
  if (!ledger.allocationGroups.some((entry) => entry.id === input.groupId)) throw new Error(`Unknown allocation group: ${input.groupId}`);
  if (!Number.isFinite(input.amountPerPersonPerDay) || input.amountPerPersonPerDay < 0) throw new Error('Allocation amount must be finite and non-negative.');
  const lotIds = [...new Set(input.lotIds ?? [])];
  for (const lotId of lotIds) {
    const lot = ledger.lots.find((entry) => entry.id === lotId);
    if (!lot || lot.resourceKey !== input.resourceKey) throw new Error(`Allocation rule references unknown or incompatible lot: ${lotId}`);
  }
  const subtypes = [...new Set((input.subtypes ?? []).filter((entry) => entry.trim().length > 0))];
  const cleanName = input.name.trim() || `${input.resourceKey} ration`;
  const priority = Math.max(-1000, Math.min(1000, Math.round(input.priority ?? 0)));
  if (input.ruleId) {
    const existing = ledger.allocationRules.find((entry) => entry.id === input.ruleId);
    if (!existing) throw new Error(`Unknown allocation rule: ${input.ruleId}`);
    existing.name = cleanName;
    existing.groupId = input.groupId;
    existing.resourceKey = input.resourceKey;
    existing.lotIds = lotIds;
    existing.subtypes = subtypes;
    existing.amountPerPersonPerDay = input.amountPerPersonPerDay;
    existing.priority = priority;
    existing.exclusive = input.exclusive ?? false;
    existing.enabled = input.enabled ?? true;
    existing.updatedDay = state.clock.day;
    existing.updatedMinuteOfDay = state.clock.minuteOfDay;
    return existing;
  }
  const rule = {
    id: nextLedgerId(state,'ration-rule'),
    name: cleanName,
    groupId: input.groupId,
    resourceKey: input.resourceKey,
    lotIds,
    subtypes,
    amountPerPersonPerDay: input.amountPerPersonPerDay,
    priority,
    exclusive: input.exclusive ?? false,
    enabled: input.enabled ?? true,
    createdDay: state.clock.day,
    createdMinuteOfDay: state.clock.minuteOfDay,
    updatedDay: state.clock.day,
    updatedMinuteOfDay: state.clock.minuteOfDay,
  };
  ledger.allocationRules.push(rule);
  return rule;
}

export function removeResourceAllocationRule(state: SandboxGameState, ruleId: string): void {
  const ledger = ensureResourceLedgerState(state);
  ledger.allocationRules = ledger.allocationRules.filter((entry) => entry.id !== ruleId);
}

export interface ResourceDistributionResult {
  needed: number;
  allocated: number;
  /** Quality-adjusted fulfillment fraction; physical allocated quantity is kept separately. */
  fraction: number;
  contaminationExposure: number;
  lines: Array<{ lotId: string; quantity: number }>;
}

function matchingLotsForRule(lots: ResourceLotState[], rule: { lotIds: string[]; subtypes: string[]; resourceKey: SettlementResourceKey }): ResourceLotState[] {
  const lotIds = rule.lotIds.length ? new Set(rule.lotIds) : null;
  const subtypes = rule.subtypes.length ? new Set(rule.subtypes) : null;
  return lots.filter((lot)=>lot.quantity>0&&(!lotIds||lotIds.has(lot.id))&&(!subtypes||subtypes.has(lot.subtype)));
}

function totalLotQuantity(lots: ResourceLotState[], excluded = new Set<string>()): number {
  return lots.reduce((sum,lot)=>sum+(excluded.has(lot.id)?0:Math.max(0,lot.quantity)),0);
}

export function distributeDailyConsumable(
  state: SandboxGameState,
  resourceKey: SettlementResourceKey,
  needsByAgent: Record<string, number>,
  hours: number,
): Record<string, ResourceDistributionResult> {
  const ledger = ensureResourceLedgerState(state);
  const factor = Math.max(0, hours) / 24;
  const results: Record<string, ResourceDistributionResult> = {};
  const activeIds = Object.keys(needsByAgent).filter((id)=>Number.isFinite(needsByAgent[id]) && needsByAgent[id]! > 0).sort();
  for (const agentId of activeIds) {
    const needed = Math.max(0,needsByAgent[agentId]!);
    results[agentId] = { needed, allocated:0, fraction:needed>0?0:1, contaminationExposure:0, lines:[] };
  }
  if (activeIds.length===0) return results;
  // A distribution creates no lots. Keep references even after consumption for quality/provenance.
  const candidates = resourceLots(state,resourceKey);
  const lotById = new Map(candidates.map((lot) => [lot.id,lot]));
  const groups = new Map(ledger.allocationGroups.map((entry)=>[entry.id,entry]));
  const rules = ledger.allocationRules.filter((entry)=>entry.enabled&&entry.resourceKey===resourceKey&&groups.has(entry.groupId)).sort((a,b)=>{
    const specificity=(rule:typeof a)=>(rule.lotIds.length?2:0)+(rule.subtypes.length?1:0);
    return b.priority-a.priority || specificity(b)-specificity(a) || a.id.localeCompare(b.id);
  });
  const exclusiveLotIds = new Set<string>();
  for (const rule of rules.filter((entry)=>entry.exclusive)) {
    const group=groups.get(rule.groupId)!;
    if (!group.memberIds.some((id)=>results[id] && results[id]!.needed>0)) continue;
    for (const lot of matchingLotsForRule(candidates,rule)) exclusiveLotIds.add(lot.id);
  }
  const appendLines=(agentId:string,lines:Array<{lotId:string;quantity:number}>)=>{
    const result=results[agentId]!;
    for(const line of lines){ result.lines.push(line); result.allocated=round(result.allocated+line.quantity); }
  };
  for (const rule of rules) {
    const group=groups.get(rule.groupId)!;
    const memberIds=group.memberIds.filter((id)=>results[id] && results[id]!.allocated+1e-9<results[id]!.needed).sort();
    if (!memberIds.length) continue;
    const perPersonCap=Math.max(0,rule.amountPerPersonPerDay*factor);
    if (perPersonCap<=0) continue;
    const targets=memberIds.map((agentId)=>({agentId,amount:Math.min(perPersonCap,Math.max(0,results[agentId]!.needed-results[agentId]!.allocated))})).filter((entry)=>entry.amount>0);
    const totalTarget=targets.reduce((sum,entry)=>sum+entry.amount,0);
    if(totalTarget<=0) continue;
    const ownExclusive=new Set(rule.exclusive?matchingLotsForRule(candidates,rule).map((lot)=>lot.id):[]);
    const blocked=new Set([...exclusiveLotIds].filter((id)=>!ownExclusive.has(id)));
    const matching=matchingLotsForRule(candidates,rule).filter((lot)=>!blocked.has(lot.id));
    const available=totalLotQuantity(matching);
    const share=Math.min(1,available/totalTarget);
    for(const target of targets){
      const amount=target.amount*share;
      if(amount<=1e-9) continue;
      const lines=consumeFromCandidateLots(candidates,{resourceKey,amount,lotIds:rule.lotIds,subtypes:rule.subtypes,excludedLotIds:[...blocked]});
      appendLines(target.agentId,lines);
    }
  }
  const remaining=activeIds.map((agentId)=>({agentId,amount:Math.max(0,results[agentId]!.needed-results[agentId]!.allocated)})).filter((entry)=>entry.amount>1e-9);
  const totalRemaining=remaining.reduce((sum,entry)=>sum+entry.amount,0);
  if(totalRemaining>0){
    const fallbackLots=candidates.filter((lot)=>!exclusiveLotIds.has(lot.id));
    const available=totalLotQuantity(fallbackLots);
    const share=Math.min(1,available/totalRemaining);
    for(const target of remaining){
      const amount=target.amount*share;
      if(amount<=1e-9) continue;
      const lines=consumeFromCandidateLots(candidates,{resourceKey,amount,excludedLotIds:[...exclusiveLotIds]});
      appendLines(target.agentId,lines);
    }
  }
  const eventLines=[] as Array<{agentId:string;lotId:string;quantity:number}>;
  for(const agentId of activeIds){
    const result=results[agentId]!;
    let effectiveAllocated=0; let riskWeighted=0;
    for(const line of result.lines) {
      const lot=lotById.get(line.lotId);
      const waterRisk=lot?.waterQuality ? Math.max(lot.waterQuality.microbialRisk,lot.waterQuality.chemicalRisk,lot.waterQuality.turbidity*0.35) : 0;
      const risk=Math.max(lot?.contaminationRisk??0,waterRisk);
      const quality=lot ? clamp01((lot.condition*0.25)+(lot.freshness*0.35)+((1-risk)*0.4)) : 1;
      effectiveAllocated += line.quantity*quality; riskWeighted += line.quantity*risk;
      eventLines.push({agentId,lotId:line.lotId,quantity:line.quantity});
    }
    result.fraction=result.needed>0?clamp01(effectiveAllocated/result.needed):1;
    result.contaminationExposure=result.allocated>0?clamp01(riskWeighted/result.allocated):0;
  }
  if(eventLines.length){
    ledger.recentDistributions.push({id:nextLedgerId(state,'resource-distribution'),resourceKey,day:state.clock.day,minuteOfDay:state.clock.minuteOfDay,lines:eventLines});
    if(ledger.recentDistributions.length>128) ledger.recentDistributions.splice(0,ledger.recentDistributions.length-128);
  }
  syncSettlementResourceAggregates(state);
  return results;
}

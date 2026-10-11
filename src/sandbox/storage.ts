import type { SandboxGameState } from './types.js';
import { KnowledgeStore, type KnowledgeStoreSnapshotV1 } from './knowledgeStore.js';
import { restoreLegacyKnowledgeShadow, syncLegacyKnowledgeShadow } from './knowledgeLegacyAdapter.js';
import { incidentResponseRecoveryMinutes, synchronizeIncidentLedger } from './incidentService.js';
import { ensureSurvivalCampaignState } from './survivalCampaign.js';
import { ensureResourceLedgerState } from './resourceLedger.js';

const STORAGE_KEY = 'tdoc-descendants-sandbox-v1';

export type SandboxPersistenceMode = 'durable' | 'volatile' | 'unavailable';

export interface SandboxLoadResult {
  state: SandboxGameState | null;
  mode: SandboxPersistenceMode;
  warning?: string;
  recoveryKind?: 'corrupt-save-quarantined' | 'previous-generation-restored' | 'legacy-migrated' | 'knowledge-store-migrated' | 'knowledge-store-reconciled' | 'legacy-corrupt' | 'storage-unavailable';
  quarantineKey?: string;
}

export interface SandboxRepository {
  load(): Promise<SandboxGameState | null>;
  loadRecoverable(): Promise<SandboxLoadResult>;
  save(state: SandboxGameState): Promise<void>;
  clear(): Promise<void>;
  exportJson(state: SandboxGameState): string;
  importJson(text: string): SandboxGameState;
  checkFreshness(): Promise<'fresh' | 'stale' | 'unknown'>;
  forensicReport(): Promise<SaveLineageForensicReport>;
  exportLatestQuarantine(): Promise<{ key: string; json: string } | null>;
  readonly mode: SandboxPersistenceMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertFinite(label: string, value: unknown, min?: number, max?: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Sandbox save has invalid ${label}.`);
  if (min !== undefined && value < min) throw new Error(`Sandbox save has out-of-range ${label}.`);
  if (max !== undefined && value > max) throw new Error(`Sandbox save has out-of-range ${label}.`);
}

function assertInteger(label: string, value: unknown, min?: number, max?: number): asserts value is number {
  assertFinite(label, value, min, max);
  if (!Number.isInteger(value)) throw new Error(`Sandbox save requires integer ${label}.`);
}

function assertId(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 240) throw new Error(`Sandbox save has invalid ${label}.`);
}

function assertUniqueIdRecords(label: string, values: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)) throw new Error(`Sandbox save has invalid ${label} entry.`);
    assertId(`${label} id`, value.id);
    if (ids.has(value.id)) throw new Error(`Sandbox save contains duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
  }
  return ids;
}

function assertSpatial(label: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`Sandbox save has invalid ${label}.`);
  assertId(`${label}.frameId`, value.frameId);
  assertFinite(`${label}.x`, value.x);
  assertFinite(`${label}.y`, value.y);
  if (value.z !== undefined) assertFinite(`${label}.z`, value.z);
  if (value.regionId !== undefined && typeof value.regionId !== 'string') throw new Error(`Sandbox save has invalid ${label}.regionId.`);
}

/** Optional 1.2 state must remain referentially valid across deaths and degraded records. */
function assertContinuityState(value: Record<string,unknown>, agentIds: Set<string>, knowledgeIds: Set<string>, recordIds: Set<string>): void {
  const predictions = new Set(['water-source','ruin','route-memory','built-landscape','disturbance-stratum','archive-record']);
  const ids = (label:string, raw:unknown, known?:Set<string>): string[] => {
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !id.trim() || (known && !known.has(id))) || new Set(raw).size !== raw.length) throw new Error(`Invalid ${label} references.`);
    return raw as string[];
  };
  const quality = (raw:unknown):void => { if (!isRecord(raw)) throw new Error('Invalid measured water quality.');for(const key of ['microbialRisk','chemicalRisk','turbidity'])assertFinite(`trial ${key}`,raw[key],0,1); };
  const lots = isRecord(value.resourceLedger) && Array.isArray(value.resourceLedger.lots) ? value.resourceLedger.lots.filter(isRecord) : [];
  const lotById = new Map(lots.map((lot)=>[String(lot.id),lot]));
  if (value.inquiries !== undefined) {
    if (!Array.isArray(value.inquiries)) throw new Error('Invalid inquiries.');
    const inquiryIds = assertUniqueIdRecords('inquiry',value.inquiries);
    for (const raw of value.inquiries) {
      const entry=raw as Record<string,unknown>;
      if (!agentIds.has(String(entry.authorId)) || !knowledgeIds.has(String(entry.knowledgeId))) throw new Error('Invalid inquiry author or record.');
      const basis=ids('inquiry basis',entry.basisKnowledgeIds,knowledgeIds);
      if (!basis.length || !Array.isArray(entry.basisClaims) || entry.basisClaims.length!==basis.length || entry.basisClaims.some((claim)=>typeof claim!=='string')) throw new Error('Invalid inquiry basis snapshots.');
      assertId('inquiry target',entry.targetEntityId);if(typeof entry.targetLabel!=='string'||typeof entry.note!=='string'||entry.note.length>400)throw new Error('Invalid inquiry text.');
      assertSpatial('inquiry center',entry.center);assertFinite('inquiry radius',entry.radiusKm,.35);assertInteger('inquiry day',entry.createdDay,1);
      if (!predictions.has(String(entry.prediction))) throw new Error('Invalid inquiry prediction.');
      if (entry.revisesId!==undefined && (!inquiryIds.has(String(entry.revisesId)) || entry.revisesId===entry.id))throw new Error('Invalid inquiry revision.');
      if (!Array.isArray(entry.evaluations)||!Array.isArray(entry.trials))throw new Error('Invalid inquiry reports.');
      for(const rawReport of entry.evaluations){
        if(!isRecord(rawReport)||!knowledgeIds.has(String(rawReport.knowledgeId))||rawReport.prediction!==entry.prediction||!['supports','contradicts','inconclusive'].includes(String(rawReport.outcome)))throw new Error('Invalid inquiry evaluation.');
        assertSpatial('evaluation center',rawReport.center);assertFinite('evaluation radius',rawReport.radiusKm,.35,.35);assertInteger('evaluation day',rawReport.day,1);
        ids('evaluation entities',rawReport.observedEntityIds);ids('evaluation observations',rawReport.observationKnowledgeIds,knowledgeIds);
      }
      for(const rawTrial of entry.trials){
        if(!isRecord(rawTrial)||!knowledgeIds.has(String(rawTrial.knowledgeId))||!['boiled','filtered'].includes(String(rawTrial.method))||lotById.get(String(rawTrial.inputLotId))?.resourceKey!=='water'||lotById.get(String(rawTrial.outputLotId))?.resourceKey!=='water')throw new Error('Invalid inquiry trial references.');
        assertInteger('trial day',rawTrial.day,1);quality(rawTrial.before);quality(rawTrial.after);
      }
    }
    for(const raw of value.inquiries){
      let current=raw as Record<string,unknown>;const seen=new Set<string>();
      while(current.revisesId!==undefined){if(seen.has(String(current.id)))throw new Error('Cyclic inquiry revisions.');seen.add(String(current.id));current=value.inquiries.find((entry)=>isRecord(entry)&&entry.id===current.revisesId) as Record<string,unknown>;}
    }
  }
  const inventory = isRecord(value.directPlay)&&Array.isArray(value.directPlay.inventory)?value.directPlay.inventory:[];
  for(const raw of inventory){
    if(!isRecord(raw)||raw.reading===undefined)continue;
    const reading=raw.reading;if(raw.kind!=='record'||!isRecord(reading)||!Array.isArray(reading.fragments)||reading.fragments.some((fragment)=>typeof fragment!=='string'))throw new Error('Invalid artifact reading.');
    ids('artifact basis',reading.basisKnowledgeIds,knowledgeIds);const leads=ids('artifact lead',reading.leadEntityIds);
    assertFinite('artifact reading required time',reading.requiredMinutes,1);assertFinite('artifact reading time',reading.spentMinutes,0,reading.requiredMinutes);
    if(reading.decodedKnowledgeId!==undefined&&!knowledgeIds.has(String(reading.decodedKnowledgeId)))throw new Error('Invalid decoded artifact record.');
    if(!Array.isArray(reading.leads)||reading.leads.length!==leads.length)throw new Error('Invalid artifact lead descriptions.');
    const described=new Set<string>();
    for(const lead of reading.leads){if(!isRecord(lead)||typeof lead.label!=='string'||!leads.includes(String(lead.entityId))||described.has(String(lead.entityId))||!predictions.has(String(lead.prediction)))throw new Error('Invalid artifact lead description.');described.add(String(lead.entityId));if(lead.position!==undefined)assertSpatial('artifact lead position',lead.position);}
    const observation=reading.sourceObservation;
    if(!isRecord(observation)||observation.entityId!==raw.sourceEntityId)throw new Error('Invalid artifact observation.');
    assertId('artifact observation kind',observation.kind);if(observation.subtype!==undefined)assertId('artifact observation subtype',observation.subtype);if(observation.traceType!==undefined)assertId('artifact observation trace',observation.traceType);
    ids('artifact resource semantics',observation.resourceKeys,RESOURCE_KEYS);if(observation.position!==undefined)assertSpatial('artifact observation position',observation.position);
  }
  if(value.legacyProjects!==undefined){
    if(!Array.isArray(value.legacyProjects)||value.legacyProjects.length>2)throw new Error('Invalid legacy projects.');assertUniqueIdRecords('legacy project',value.legacyProjects);
    const kinds=new Set<string>();
    for(const raw of value.legacyProjects){
      const project=raw as Record<string,unknown>;
      if(!['waterworks','archive'].includes(String(project.kind))||kinds.has(String(project.kind))||!['active','paused','completed'].includes(String(project.status))||typeof project.name!=='string')throw new Error('Invalid legacy project kind/status.');kinds.add(String(project.kind));
      if(!agentIds.has(String(project.founderId))||!agentIds.has(String(project.stewardId))||!recordIds.has(String(project.recordId))||!knowledgeIds.has(String(project.knowledgeId)))throw new Error('Invalid legacy project charter references.');
      const roots=ids('legacy project knowledge',project.knowledgeIds,knowledgeIds),workers=ids('legacy project workers',project.workerIds,agentIds);
      const charter=(value.records as Record<string,unknown>[]).find((record)=>record.id===project.recordId);
      if(!roots.includes(String(project.knowledgeId))||workers.length>4||roots.some((id)=>!(charter?.knowledgeIds as string[]).includes(id)))throw new Error('Invalid legacy project charter basis.');
      assertInteger('legacy project day',project.createdDay,1);if(project.pauseReason!==undefined&&typeof project.pauseReason!=='string')throw new Error('Invalid legacy project pause reason.');
      if (project.recordHistory !== undefined) {
        if (!Array.isArray(project.recordHistory) || !project.recordHistory.length) throw new Error('Invalid project record history.');
        const seen = new Set<string>(); let previousDay = 0;
        for (const entry of project.recordHistory) {
          if (!isRecord(entry) || !recordIds.has(String(entry.recordId)) || !agentIds.has(String(entry.authorId)) || seen.has(String(entry.recordId))) throw new Error('Invalid project record history references.');
          assertInteger('project record history day',entry.day,1);
          const record = (value.records as Record<string,unknown>[]).find((candidate) => candidate.id === entry.recordId);
          if (entry.day < previousDay || record?.authorId !== entry.authorId || record?.createdDay !== entry.day || roots.some((id) => !(record?.knowledgeIds as string[]).includes(id))) throw new Error('Invalid project record history source.');
          previousDay = entry.day as number; seen.add(String(entry.recordId));
        }
        if ((project.recordHistory.at(-1) as Record<string,unknown>).recordId !== project.recordId) throw new Error('Project current record history mismatch.');
      }
      if(!Array.isArray(project.phases)||project.phases.length!==3||!Array.isArray(project.contributors)||!Array.isArray(project.stewardHistory)||!project.stewardHistory.length)throw new Error('Invalid legacy project history.');
      for(const phase of project.phases){
        if(!isRecord(phase)||typeof phase.name!=='string'||typeof phase.funded!=='boolean'||!isRecord(phase.materials)||!Array.isArray(phase.committed))throw new Error('Invalid legacy project phase.');
        assertFinite('legacy phase required work',phase.requiredHours,1);assertFinite('legacy phase work',phase.workHours,0,phase.requiredHours);
        for(const [key,quantity]of Object.entries(phase.materials)){if(!RESOURCE_KEYS.has(key))throw new Error('Invalid project material.');assertFinite('project material quantity',quantity,Number.EPSILON);}
        const sums=new Map<string,number>();
        for(const line of phase.committed){if(!isRecord(line)||lotById.get(String(line.lotId))?.resourceKey!==line.resourceKey||!RESOURCE_KEYS.has(String(line.resourceKey)))throw new Error('Invalid project material lot.');assertFinite('project committed quantity',line.quantity,Number.EPSILON);sums.set(String(line.resourceKey),(sums.get(String(line.resourceKey))??0)+line.quantity);}
        const materials=phase.materials;
        if(phase.funded){if([...sums.keys()].some((key)=>!(key in materials))||Object.entries(materials).some(([key,quantity])=>Math.abs((sums.get(key)??0)-(quantity as number))>1e-6))throw new Error('Invalid funded project material totals.');}
        else if(phase.workHours!==0||phase.committed.length)throw new Error('Unfunded project cannot retain work or committed lots.');
        if(project.status==='completed'&&(!phase.funded||phase.workHours!==phase.requiredHours))throw new Error('Incomplete legacy facility.');
      }
      const contributors=new Set<string>();
      for(const credit of project.contributors){if(!isRecord(credit)||!agentIds.has(String(credit.agentId))||contributors.has(String(credit.agentId)))throw new Error('Invalid project contributor.');contributors.add(String(credit.agentId));assertFinite('project contribution hours',credit.hours,0);}
      for(const steward of project.stewardHistory){if(!isRecord(steward)||!agentIds.has(String(steward.agentId)))throw new Error('Invalid project stewardship.');assertInteger('project stewardship day',steward.day,1);}
      if((project.stewardHistory.at(-1) as Record<string,unknown>).agentId!==project.stewardId)throw new Error('Project stewardship history mismatch.');
    }
  }
}

function assertResourceRecord(value: unknown): void {
  if (!isRecord(value)) throw new Error('Sandbox save is missing settlement resources.');
  for (const key of ['food','water','medicine','timber','scrap','fuel','cloth','records']) assertFinite(`settlement.resources.${key}`, value[key], 0);
}

const RESOURCE_KEYS = new Set(['food','water','medicine','timber','scrap','fuel','cloth','records']);
const RESOURCE_SOURCE_KINDS = new Set(['ecological-resource','ecological-guild','settlement-stock','institution','trade','legacy','system-adjustment']);
const RESOURCE_UNITS = new Set(['ration-unit','liter','dose-unit','material-unit','fuel-unit','cloth-unit','record-copy']);
const RESOURCE_PROCESSING_KINDS = new Set(['raw','cleaned','cooked','dried','smoked','filtered','boiled','prepared','repaired','copied','reconciled']);

function assertResourceStringArray(label: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) throw new Error(`Sandbox save has invalid resourceLedger ${label}.`);
}

function assertResourceLedger(value: unknown, agentIds: Set<string>): void {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('Sandbox save has invalid resourceLedger schema.');
  for (const field of ['sources','lots','allocationGroups','allocationRules','recentDistributions']) if (!Array.isArray(value[field])) throw new Error(`Sandbox save has invalid resourceLedger ${field}.`);

  const sources = value.sources as unknown[];
  const sourceIds = assertUniqueIdRecords('resourceLedger source', sources);
  const sourceResourceById = new Map<string,string>();
  for (const raw of sources) {
    const source = raw as Record<string,unknown>;
    if (!RESOURCE_KEYS.has(String(source.resourceKey))) throw new Error(`Sandbox save has invalid resourceLedger source resourceKey for ${String(source.id)}.`);
    if (!RESOURCE_SOURCE_KINDS.has(String(source.kind))) throw new Error(`Sandbox save has invalid resourceLedger source kind for ${String(source.id)}.`);
    assertId(`resourceLedger source ${String(source.id)} subtype`, source.subtype);
    if (typeof source.label !== 'string' || !source.label.trim()) throw new Error(`Sandbox save has invalid resourceLedger source label for ${String(source.id)}.`);
    assertResourceStringArray(`source ${String(source.id)} worldEntityIds`, source.worldEntityIds);
    if (source.worldProvenanceIds !== undefined) assertResourceStringArray(`source ${String(source.id)} worldProvenanceIds`, source.worldProvenanceIds);
    if (source.position !== undefined) assertSpatial(`resourceLedger source ${String(source.id)} position`, source.position);
    if (source.regionId !== undefined) assertId(`resourceLedger source ${String(source.id)} regionId`, source.regionId);
    if (typeof source.renewable !== 'boolean') throw new Error(`Sandbox save has invalid resourceLedger source renewable flag for ${String(source.id)}.`);
    assertFinite(`resourceLedger source ${String(source.id)} accessibleStock`, source.accessibleStock, 0);
    assertFinite(`resourceLedger source ${String(source.id)} carryingCapacity`, source.carryingCapacity, 0);
    assertFinite(`resourceLedger source ${String(source.id)} regenerationPerDay`, source.regenerationPerDay, 0);
    assertFinite(`resourceLedger source ${String(source.id)} depletionFraction`, source.depletionFraction, 0, 1);
    if (source.lastHarvestDay !== undefined) assertInteger(`resourceLedger source ${String(source.id)} lastHarvestDay`, source.lastHarvestDay, 1);
    if (source.lastHarvestMinuteOfDay !== undefined) assertInteger(`resourceLedger source ${String(source.id)} lastHarvestMinuteOfDay`, source.lastHarvestMinuteOfDay, 0, 1439);
    sourceResourceById.set(String(source.id),String(source.resourceKey));
  }

  const lots = value.lots as unknown[];
  const lotIds = assertUniqueIdRecords('resourceLedger lot', lots);
  const lotResourceById = new Map<string,string>();
  for (const raw of lots) {
    const lot = raw as Record<string,unknown>;
    if (!RESOURCE_KEYS.has(String(lot.resourceKey))) throw new Error(`Sandbox save has invalid resourceLedger lot resourceKey for ${String(lot.id)}.`);
    assertId(`resourceLedger lot ${String(lot.id)} subtype`, lot.subtype);
    if (typeof lot.label !== 'string' || !lot.label.trim()) throw new Error(`Sandbox save has invalid resourceLedger lot label for ${String(lot.id)}.`);
    assertFinite(`resourceLedger lot ${String(lot.id)} quantity`, lot.quantity, 0);
    if (!RESOURCE_UNITS.has(String(lot.unit))) throw new Error(`Sandbox save has invalid resourceLedger lot unit for ${String(lot.id)}.`);
    assertId(`resourceLedger lot ${String(lot.id)} sourceId`, lot.sourceId);
    if (!sourceIds.has(String(lot.sourceId))) throw new Error(`Sandbox save resourceLedger lot ${String(lot.id)} references unknown source ${String(lot.sourceId)}.`);
    if (sourceResourceById.get(String(lot.sourceId)) !== String(lot.resourceKey)) throw new Error(`Sandbox save resourceLedger lot ${String(lot.id)} source resource mismatch.`);
    assertResourceStringArray(`lot ${String(lot.id)} worldEntityIds`, lot.worldEntityIds);
    if (lot.worldProvenanceIds !== undefined) assertResourceStringArray(`lot ${String(lot.id)} worldProvenanceIds`, lot.worldProvenanceIds);
    assertInteger(`resourceLedger lot ${String(lot.id)} createdDay`, lot.createdDay, 1);
    assertInteger(`resourceLedger lot ${String(lot.id)} createdMinuteOfDay`, lot.createdMinuteOfDay, 0, 1439);
    if (!Array.isArray(lot.harvesterIds) || lot.harvesterIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save has invalid resourceLedger lot harvesterIds for ${String(lot.id)}.`);
    if (lot.sourcePosition !== undefined) assertSpatial(`resourceLedger lot ${String(lot.id)} sourcePosition`, lot.sourcePosition);
    assertFinite(`resourceLedger lot ${String(lot.id)} condition`, lot.condition, 0, 1);
    assertFinite(`resourceLedger lot ${String(lot.id)} freshness`, lot.freshness, 0, 1);
    assertFinite(`resourceLedger lot ${String(lot.id)} contaminationRisk`, lot.contaminationRisk, 0, 1);
    if (lot.waterQuality !== undefined) {
      if (!isRecord(lot.waterQuality)) throw new Error(`Sandbox save has invalid resourceLedger lot waterQuality for ${String(lot.id)}.`);
      for (const key of ['microbialRisk','chemicalRisk','turbidity']) assertFinite(`resourceLedger lot ${String(lot.id)} waterQuality.${key}`, lot.waterQuality[key], 0, 1);
    }
    if (!Array.isArray(lot.processingHistory)) throw new Error(`Sandbox save has invalid resourceLedger lot processingHistory for ${String(lot.id)}.`);
    for (const rawStep of lot.processingHistory as unknown[]) {
      if (!isRecord(rawStep) || !RESOURCE_PROCESSING_KINDS.has(String(rawStep.kind))) throw new Error(`Sandbox save has invalid resourceLedger lot processing step for ${String(lot.id)}.`);
      assertInteger(`resourceLedger lot ${String(lot.id)} processing day`, rawStep.day, 1);
      assertInteger(`resourceLedger lot ${String(lot.id)} processing minute`, rawStep.minuteOfDay, 0, 1439);
      if (!Array.isArray(rawStep.agentIds) || rawStep.agentIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save has invalid resourceLedger lot processing agents for ${String(lot.id)}.`);
      if (typeof rawStep.note !== 'string') throw new Error(`Sandbox save has invalid resourceLedger lot processing note for ${String(lot.id)}.`);
    }
    if (!Array.isArray(lot.parentLotIds) || lot.parentLotIds.some((id) => typeof id !== 'string')) throw new Error(`Sandbox save has invalid resourceLedger lot parentLotIds for ${String(lot.id)}.`);
    if (lot.custodyHistory !== undefined) {
      if (!Array.isArray(lot.custodyHistory)) throw new Error(`Sandbox save has invalid resourceLedger lot custodyHistory for ${String(lot.id)}.`);
      for (const rawCustody of lot.custodyHistory as unknown[]) { const custody=rawCustody as Record<string,unknown>; assertInteger(`resourceLedger lot ${String(lot.id)} custody day`,custody.day,1); assertInteger(`resourceLedger lot ${String(lot.id)} custody minute`,custody.minuteOfDay,0,1439); if(typeof custody.note!=='string') throw new Error(`Sandbox save has invalid resourceLedger lot custody note for ${String(lot.id)}.`); }
    }
    if (lot.storageLocationId !== undefined) assertId(`resourceLedger lot ${String(lot.id)} storageLocationId`, lot.storageLocationId);
    if (lot.containerId !== undefined) assertId(`resourceLedger lot ${String(lot.id)} containerId`, lot.containerId);
    lotResourceById.set(String(lot.id),String(lot.resourceKey));
  }
  for (const raw of lots) {
    const lot = raw as Record<string,unknown>;
    for (const parentId of lot.parentLotIds as string[]) if (!lotIds.has(parentId)) throw new Error(`Sandbox save resourceLedger lot ${String(lot.id)} references unknown parent lot ${parentId}.`);
  }

  const groups = value.allocationGroups as unknown[];
  const groupIds = assertUniqueIdRecords('resourceLedger group', groups);
  for (const raw of groups) {
    const group = raw as Record<string,unknown>;
    if (typeof group.name !== 'string' || !group.name.trim()) throw new Error(`Sandbox save has invalid resourceLedger group name for ${String(group.id)}.`);
    if (!Array.isArray(group.memberIds) || group.memberIds.length === 0 || group.memberIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save has invalid resourceLedger group memberIds for ${String(group.id)}.`);
    if (new Set(group.memberIds as string[]).size !== group.memberIds.length) throw new Error(`Sandbox save has duplicate resourceLedger group members for ${String(group.id)}.`);
    assertInteger(`resourceLedger group ${String(group.id)} createdDay`, group.createdDay, 1);
    assertInteger(`resourceLedger group ${String(group.id)} createdMinuteOfDay`, group.createdMinuteOfDay, 0, 1439);
    assertInteger(`resourceLedger group ${String(group.id)} updatedDay`, group.updatedDay, 1);
    assertInteger(`resourceLedger group ${String(group.id)} updatedMinuteOfDay`, group.updatedMinuteOfDay, 0, 1439);
  }

  const rules = value.allocationRules as unknown[];
  assertUniqueIdRecords('resourceLedger rule', rules);
  for (const raw of rules) {
    const rule = raw as Record<string,unknown>;
    if (typeof rule.name !== 'string' || !rule.name.trim()) throw new Error(`Sandbox save has invalid resourceLedger rule name for ${String(rule.id)}.`);
    assertId(`resourceLedger rule ${String(rule.id)} groupId`, rule.groupId);
    if (!groupIds.has(String(rule.groupId))) throw new Error(`Sandbox save resourceLedger rule ${String(rule.id)} references unknown group ${String(rule.groupId)}.`);
    if (!RESOURCE_KEYS.has(String(rule.resourceKey))) throw new Error(`Sandbox save has invalid resourceLedger rule resourceKey for ${String(rule.id)}.`);
    if (!Array.isArray(rule.lotIds) || rule.lotIds.some((id) => typeof id !== 'string' || !lotIds.has(id) || lotResourceById.get(id) !== String(rule.resourceKey))) throw new Error(`Sandbox save has invalid resourceLedger rule lot references for ${String(rule.id)}.`);
    assertResourceStringArray(`rule ${String(rule.id)} subtypes`, rule.subtypes);
    assertFinite(`resourceLedger rule ${String(rule.id)} amountPerPersonPerDay`, rule.amountPerPersonPerDay, 0);
    assertInteger(`resourceLedger rule ${String(rule.id)} priority`, rule.priority, -1000, 1000);
    if (typeof rule.exclusive !== 'boolean' || typeof rule.enabled !== 'boolean') throw new Error(`Sandbox save has invalid resourceLedger rule flags for ${String(rule.id)}.`);
    assertInteger(`resourceLedger rule ${String(rule.id)} createdDay`, rule.createdDay, 1);
    assertInteger(`resourceLedger rule ${String(rule.id)} createdMinuteOfDay`, rule.createdMinuteOfDay, 0, 1439);
    assertInteger(`resourceLedger rule ${String(rule.id)} updatedDay`, rule.updatedDay, 1);
    assertInteger(`resourceLedger rule ${String(rule.id)} updatedMinuteOfDay`, rule.updatedMinuteOfDay, 0, 1439);
  }

  const distributions = value.recentDistributions as unknown[];
  assertUniqueIdRecords('resourceLedger distribution', distributions);
  for (const raw of distributions) {
    const event = raw as Record<string,unknown>;
    if (!RESOURCE_KEYS.has(String(event.resourceKey))) throw new Error(`Sandbox save has invalid resourceLedger distribution resourceKey for ${String(event.id)}.`);
    assertInteger(`resourceLedger distribution ${String(event.id)} day`, event.day, 1);
    assertInteger(`resourceLedger distribution ${String(event.id)} minuteOfDay`, event.minuteOfDay, 0, 1439);
    if (!Array.isArray(event.lines)) throw new Error(`Sandbox save has invalid resourceLedger distribution lines for ${String(event.id)}.`);
    for (const rawLine of event.lines as unknown[]) {
      if (!isRecord(rawLine) || typeof rawLine.agentId !== 'string' || !agentIds.has(rawLine.agentId) || typeof rawLine.lotId !== 'string' || !lotIds.has(rawLine.lotId)) throw new Error(`Sandbox save has invalid resourceLedger distribution line for ${String(event.id)}.`);
      assertFinite(`resourceLedger distribution ${String(event.id)} quantity`, rawLine.quantity, 0);
    }
  }
}

function assertState(value: unknown): asserts value is SandboxGameState {
  if (!isRecord(value)) throw new Error('Sandbox save is not an object.');
  if (value.schemaVersion !== 1) throw new Error(`Unsupported sandbox save schema: ${String(value.schemaVersion)}`);
  if (!isRecord(value.clock) || !isRecord(value.clockPolicy) || !isRecord(value.world) || !isRecord(value.settlement)) throw new Error('Sandbox save is missing required state sections.');
  for (const key of ['agents','pregnancies','knowledge','records','doctrines','expeditions','encounters','externalActors','chronicle','generatedEndings']) {
    if (!Array.isArray(value[key])) throw new Error(`Sandbox save is missing ${key}.`);
  }

  if (value.knowledgeStore !== undefined) {
    if (!isRecord(value.knowledgeStore)) throw new Error('Sandbox save has invalid knowledgeStore sidecar.');
    try { KnowledgeStore.fromSnapshot(value.knowledgeStore as unknown as KnowledgeStoreSnapshotV1); }
    catch (error) { throw new Error(`Sandbox save has invalid knowledgeStore sidecar: ${persistenceErrorMessage(error)}`); }
  }

  assertId('saveId', value.saveId);
  assertInteger('seed', value.seed);
  assertInteger('rngState', value.rngState);
  assertInteger('sequence', value.sequence, 0);
  if (!['running','local-collapse','post-ending'].includes(String(value.status))) throw new Error('Sandbox save has invalid status.');

  assertInteger('clock.day', value.clock.day, 1);
  assertInteger('clock.minuteOfDay', value.clock.minuteOfDay, 0, 1439);
  assertInteger('clock.worldTick', value.clock.worldTick, 0);
  if (value.lastConceptionCheckAbsoluteMinute !== undefined) {
    assertInteger('last conception check',value.lastConceptionCheckAbsoluteMinute,0,((value.clock.day as number)-1)*1440+(value.clock.minuteOfDay as number));
    if (![0,360].includes((value.lastConceptionCheckAbsoluteMinute as number)%1440)) throw new Error('Invalid conception check slot.');
  }
  assertInteger('clockPolicy.worldTicksPerDay', value.clockPolicy.worldTicksPerDay, 1);
  assertFinite('clockPolicy.activeRadiusKm', value.clockPolicy.activeRadiusKm, 0);
  assertInteger('clockPolicy.activeDetailRank', value.clockPolicy.activeDetailRank, 0);
  if (value.clockPolicy.epochWorldTick !== undefined) assertInteger('clockPolicy.epochWorldTick', value.clockPolicy.epochWorldTick, 0);
  if (value.clockPolicy.epochGameMinute !== undefined) assertInteger('clockPolicy.epochGameMinute', value.clockPolicy.epochGameMinute, 0);

  if (!isRecord(value.world.manifest)) throw new Error('Sandbox save is missing WorldProvider manifest.');
  if (value.world.manifest.contractVersion !== '1.0.0') throw new Error(`Sandbox save WorldProvider contract mismatch: ${String(value.world.manifest.contractVersion)}`);
  assertId('world.providerRecipeId', value.world.providerRecipeId);
  assertId('world.providerEngineVersion', value.world.providerEngineVersion);
  assertId('world.originEntityId', value.world.originEntityId);
  if (value.world.providerRecipeId !== value.world.manifest.recipeId || value.world.providerEngineVersion !== value.world.manifest.engineVersion) throw new Error('Sandbox save provider identity disagrees with its manifest.');
  if (!Array.isArray(value.world.discoveredVariableIds) || !Array.isArray(value.world.discoveredCapabilities)) throw new Error('Sandbox save is missing provider discovery data.');
  if (!isRecord(value.world.providerSnapshot) || !isRecord(value.world.providerSnapshot.manifest)) throw new Error('Sandbox save is missing provider snapshot.');
  if (value.world.providerSnapshot.manifest.contractVersion !== '1.0.0') throw new Error('Sandbox save provider snapshot contract mismatch.');
  if (value.world.providerSnapshot.manifest.recipeId !== value.world.providerRecipeId || value.world.providerSnapshot.manifest.engineVersion !== value.world.providerEngineVersion) throw new Error('Sandbox save provider snapshot identity mismatch.');
  assertInteger('world.providerSnapshot.manifest.currentTick', value.world.providerSnapshot.manifest.currentTick, 0);
  if (value.world.providerSnapshot.manifest.currentTick !== value.clock.worldTick) throw new Error('Sandbox save provider snapshot tick disagrees with game clock.');
  for (const key of ['entities','relations','events','causalRecords','knowledge']) if (!Array.isArray(value.world.providerSnapshot[key])) throw new Error(`Sandbox save provider snapshot is missing ${key}.`);
  if (!isRecord(value.world.providerSnapshot.aggregates)) throw new Error('Sandbox save provider snapshot is missing aggregates.');

  const agents = value.agents as unknown[];
  const agentIds = assertUniqueIdRecords('agent', agents);
  if (agentIds.size === 0) throw new Error('Sandbox save cannot omit the agent population history.');
  if (value.campaign !== undefined) {
    if (!isRecord(value.campaign) || ![1,2].includes(Number(value.campaign.schemaVersion))) throw new Error('Sandbox save has invalid campaign sidecar.');
    assertInteger('campaign.startDay', value.campaign.startDay, 1);
    if (!Array.isArray(value.campaign.foundingAgentIds) || value.campaign.foundingAgentIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error('Sandbox save campaign foundingAgentIds are invalid.');
    if (new Set(value.campaign.foundingAgentIds as string[]).size !== value.campaign.foundingAgentIds.length) throw new Error('Sandbox save campaign foundingAgentIds contain duplicates.');
    const currentMilestoneIds = new Set(['stabilize','explore','preserve','generation']);
    const legacyMilestoneIds = new Set([...currentMilestoneIds, 'endure']);
    const allowedMilestones = value.campaign.schemaVersion === 1 ? legacyMilestoneIds : currentMilestoneIds;
    if (!Array.isArray(value.campaign.completedMilestoneIds) || value.campaign.completedMilestoneIds.some((id) => typeof id !== 'string' || !allowedMilestones.has(id))) throw new Error('Sandbox save campaign completed milestones are invalid.');
    if (new Set(value.campaign.completedMilestoneIds as string[]).size !== value.campaign.completedMilestoneIds.length) throw new Error('Sandbox save campaign completed milestones contain duplicates.');
    const phases = value.campaign.schemaVersion === 1
      ? ['stabilize','explore','preserve','generation','endure','won','lost']
      : ['stabilize','explore','preserve','generation','continuity'];
    if (!phases.includes(String(value.campaign.phase))) throw new Error('Sandbox save campaign phase is invalid.');
    assertInteger('campaign.lastEvaluatedDay', value.campaign.lastEvaluatedDay, 0);
    if (![1,7,30].includes(Number(value.campaign.strategicAdvanceDays))) throw new Error('Sandbox save campaign strategic advance is invalid.');
    if (value.campaign.schemaVersion === 1) {
      if (value.campaign.targetDay !== undefined) assertInteger('campaign.targetDay', value.campaign.targetDay, 1);
      if (value.campaign.outcome !== undefined && !isRecord(value.campaign.outcome)) throw new Error('Sandbox save legacy campaign outcome is invalid.');
    } else {
      if (value.campaign.targetDay !== undefined || value.campaign.outcome !== undefined) throw new Error('Sandbox save open-ended campaign cannot contain target or outcome metadata.');
    }
  }
  for (const raw of agents) {
    const agent = raw as Record<string, unknown>;
    assertFinite(`agent ${String(agent.id)} health`, agent.health, 0, 100);
    assertFinite(`agent ${String(agent.id)} fatigue`, agent.fatigue, 0, 100);
    assertFinite(`agent ${String(agent.id)} morale`, agent.morale, 0, 100);
    if (typeof agent.alive !== 'boolean') throw new Error(`Sandbox save has invalid alive flag for ${String(agent.id)}.`);
    if (!Array.isArray(agent.parentIds) || !Array.isArray(agent.partnerIds) || !Array.isArray(agent.knowledgeIds) || !Array.isArray(agent.pathology) || !Array.isArray(agent.memories) || !Array.isArray(agent.beliefs) || !Array.isArray(agent.relations)) throw new Error(`Sandbox save has incomplete agent state for ${String(agent.id)}.`);
    if (agent.residence !== undefined && !['settlement','expedition','external','unknown'].includes(String(agent.residence))) throw new Error(`Sandbox save has invalid residence for ${String(agent.id)}.`);
    if (agent.naming !== undefined) {
      if (!isRecord(agent.naming) || agent.naming.languageVersion!==1) throw new Error('Invalid naming language version.');
      if (agent.naming.sourceName!==undefined) assertId('agent source name',agent.naming.sourceName);
      for (const key of ['givenName','familyName','fullName']) assertId(`agent naming ${key}`,agent.naming[key]);
      if (agent.naming.fullName!==`${agent.naming.givenName} ${agent.naming.familyName}` || agent.name!==agent.naming.fullName) throw new Error('Agent name disagrees with naming record.');
    }
    if (agent.aptitude !== undefined) {
      if (!isRecord(agent.aptitude)) throw new Error('Invalid aptitude.');
      for (const key of ['survival','medicine','construction','foraging','scouting','combat','care','records','leadership','trade']) assertFinite(`aptitude ${key}`,agent.aptitude[key],0,100);
    }
    if (agent.education !== undefined) {
      const education=agent.education;
      if (!isRecord(education) || !(String(education.focus) in (agent.skills as Record<string,unknown>))) throw new Error('Invalid education focus.');
      if (education.mentorId!==null && (typeof education.mentorId!=='string' || !agentIds.has(education.mentorId) || education.mentorId===agent.id)) throw new Error('Invalid education mentor.');
      assertFinite('education hours',education.hours,0);
      assertFinite('education lastKnowledgeHour',education.lastKnowledgeHour,0,education.hours as number);
    }
    if (agent.personality !== undefined) {
      if (!isRecord(agent.personality)) throw new Error(`Sandbox save has invalid personality for ${String(agent.id)}.`);
      for (const axis of ['curiosity','caution','sociability','autonomy','empathy']) assertFinite(`agent ${String(agent.id)} personality.${axis}`, agent.personality[axis], 0, 100);
    }
    if (agent.faith !== undefined) {
      if (!isRecord(agent.faith) || !Array.isArray(agent.faith.interpretationTags)) throw new Error(`Sandbox save has invalid faith profile for ${String(agent.id)}.`);
      assertFinite(`agent ${String(agent.id)} faith.commitment`, agent.faith.commitment, 0, 100);
    }
    if (agent.identityOrigin !== undefined && !['world-provider','lived-game-state'].includes(String(agent.identityOrigin))) throw new Error(`Sandbox save has invalid identityOrigin for ${String(agent.id)}.`);
    if (agent.worldEntityId !== undefined) assertId(`agent ${String(agent.id)} worldEntityId`, agent.worldEntityId);
    if (agent.identityAnchorId !== undefined) assertId(`agent ${String(agent.id)} identityAnchorId`, agent.identityAnchorId);
    if (agent.identityOrigin === 'world-provider' && (typeof agent.worldEntityId !== 'string' || !Array.isArray(agent.worldProvenanceIds) || agent.worldProvenanceIds.length === 0)) throw new Error(`Sandbox save provider-anchored agent ${String(agent.id)} is missing provider identity provenance.`);
    if (agent.identityOrigin === 'lived-game-state' && (agent.worldEntityId !== undefined || agent.identityAnchorId !== undefined)) throw new Error(`Sandbox save lived game-state agent ${String(agent.id)} must not masquerade as a WorldProvider identity.`);
    if (agent.profileAuthority !== undefined) {
      if (!isRecord(agent.profileAuthority)) throw new Error(`Sandbox save has invalid profileAuthority for ${String(agent.id)}.`);
      for (const field of ['identity','name','household','age','sex','role','skills','genetics','healthBaseline','personality','faith']) if (!['provider-projected','game-derived','lived-game-state'].includes(String(agent.profileAuthority[field]))) throw new Error(`Sandbox save agent ${String(agent.id)} has invalid profile authority ${field}.`);
    }
    for (const field of ['worldProvenanceIds','materializationProvenanceIds'] as const) {
      if (agent[field] !== undefined) {
        if (!Array.isArray(agent[field]) || (agent[field] as unknown[]).some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) throw new Error(`Sandbox save has invalid ${field} for ${String(agent.id)}.`);
      }
    }
    if (agent.sampleWeight !== undefined) assertFinite(`agent ${String(agent.id)} sampleWeight`, agent.sampleWeight, 0.000001);
    if (agent.affiliationIds !== undefined && !Array.isArray(agent.affiliationIds)) throw new Error(`Sandbox save has invalid affiliations for ${String(agent.id)}.`);
    if (agent.socialStatus !== undefined) {
      if (!isRecord(agent.socialStatus)) throw new Error(`Sandbox save has invalid social status for ${String(agent.id)}.`);
      for (const axis of ['standing','dependency','outsider']) assertFinite(`agent ${String(agent.id)} socialStatus.${axis}`, agent.socialStatus[axis], 0, 100);
    }
    for (const ref of [...agent.parentIds, ...agent.partnerIds]) if (typeof ref !== 'string' || !agentIds.has(ref)) throw new Error(`Sandbox save agent ${String(agent.id)} references unknown person ${String(ref)}.`);
    for (const rawRelation of agent.relations as unknown[]) {
      if (!isRecord(rawRelation) || typeof rawRelation.targetId !== 'string' || !agentIds.has(rawRelation.targetId)) throw new Error(`Sandbox save agent ${String(agent.id)} has an invalid social relation target.`);
      if (rawRelation.authority !== undefined && !['provider-projected','lived-game-state'].includes(String(rawRelation.authority))) throw new Error(`Sandbox save agent ${String(agent.id)} relation has invalid authority.`);
      if (rawRelation.authority === 'provider-projected' && rawRelation.worldRelationId === undefined) throw new Error(`Sandbox save agent ${String(agent.id)} provider relation lacks a WorldProvider relation id.`);
      if (rawRelation.worldRelationId !== undefined) assertId(`agent ${String(agent.id)} relation worldRelationId`, rawRelation.worldRelationId);
      if (rawRelation.sourceWorldRelationKind !== undefined) assertId(`agent ${String(agent.id)} relation sourceWorldRelationKind`, rawRelation.sourceWorldRelationKind);
      if (rawRelation.worldProvenanceIds !== undefined && (!Array.isArray(rawRelation.worldProvenanceIds) || rawRelation.worldProvenanceIds.some((id) => typeof id !== 'string' || id.trim().length === 0))) throw new Error(`Sandbox save agent ${String(agent.id)} relation has invalid world provenance.`);
    }
  }

  const settlement = value.settlement;
  assertId('settlement.id', settlement.id);
  assertId('settlement.worldEntityId', settlement.worldEntityId);
  assertId('settlement.leaderId', settlement.leaderId);
  if (!agentIds.has(settlement.leaderId as string)) throw new Error('Sandbox save leaderId does not reference an agent.');
  assertSpatial('settlement.position', settlement.position);
  assertResourceRecord(settlement.resources);
  if (value.resourceLedger !== undefined) assertResourceLedger(value.resourceLedger, agentIds);
  for (const key of ['housingCapacity','sanitation','waterSafety','clinicCapacity','childcareCapacity','defense']) assertFinite(`settlement.${key}`, settlement[key], 0);
  if (!Array.isArray(settlement.households) || !Array.isArray(settlement.institutions) || !Array.isArray(settlement.localKnowledgeIds) || !Array.isArray(settlement.activeRecordIds)) throw new Error('Sandbox save has incomplete settlement social state.');
  const householdIds = assertUniqueIdRecords('household', settlement.households as unknown[]);
  void householdIds;
  for (const raw of settlement.households as unknown[]) {
    const household = raw as Record<string, unknown>;
    if (!Array.isArray(household.memberIds) || household.memberIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save household ${String(household.id)} has invalid members.`);
    assertId(`household ${String(household.id)} housingUnitId`, household.housingUnitId);
    if (household.worldEntityId !== undefined) assertId(`household ${String(household.id)} worldEntityId`, household.worldEntityId);
    if (household.worldProvenanceIds !== undefined && (!Array.isArray(household.worldProvenanceIds) || household.worldProvenanceIds.some((id) => typeof id !== 'string' || id.trim().length === 0))) throw new Error(`Sandbox save household ${String(household.id)} has invalid world provenance.`);
    if (household.displacement !== undefined) {
      if (!isRecord(household.displacement)) throw new Error(`Sandbox save household ${String(household.id)} has invalid displacement state.`);
      const displacement = household.displacement;
      if (!['displaced','returned'].includes(String(displacement.status))) throw new Error(`Sandbox save household ${String(household.id)} has invalid displacement status.`);
      assertInteger(`household ${String(household.id)} displacedDay`, displacement.displacedDay, 1);
      assertInteger(`household ${String(household.id)} displacedMinuteOfDay`, displacement.displacedMinuteOfDay, 0);
      assertId(`household ${String(household.id)} displacementProviderSourceId`, displacement.displacementProviderSourceId);
      if (!Array.isArray(displacement.displacedMemberIds) || displacement.displacedMemberIds.some((id) => typeof id !== 'string' || !agentIds.has(id) || !(household.memberIds as unknown[]).includes(id))) throw new Error(`Sandbox save household ${String(household.id)} has invalid displacedMemberIds.`);
      if (!Array.isArray(displacement.displacementProvenanceIds) || displacement.displacementProvenanceIds.some((id) => typeof id !== 'string' || !id.trim())) throw new Error(`Sandbox save household ${String(household.id)} has invalid displacement provenance.`);
      if (displacement.status === 'returned') {
        assertInteger(`household ${String(household.id)} returnedDay`, displacement.returnedDay, 1);
        assertInteger(`household ${String(household.id)} returnedMinuteOfDay`, displacement.returnedMinuteOfDay, 0);
        assertId(`household ${String(household.id)} returnProviderSourceId`, displacement.returnProviderSourceId);
        if (!Array.isArray(displacement.returnProvenanceIds) || displacement.returnProvenanceIds.some((id) => typeof id !== 'string' || !id.trim())) throw new Error(`Sandbox save household ${String(household.id)} has invalid return provenance.`);
      }
    }
  }
  assertUniqueIdRecords('institution', settlement.institutions as unknown[]);
  for (const raw of settlement.institutions as unknown[]) {
    const institution = raw as Record<string, unknown>;
    if (!Array.isArray(institution.memberIds) || institution.memberIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save institution ${String(institution.id)} has invalid members.`);
    if (!Array.isArray(institution.authorityRules) || !Array.isArray(institution.recordIds)) throw new Error(`Sandbox save institution ${String(institution.id)} is incomplete.`);
    if (institution.worldEntityId !== undefined) assertId(`institution ${String(institution.id)} worldEntityId`, institution.worldEntityId);
    if (institution.sourceWorldInstitutionType !== undefined) assertId(`institution ${String(institution.id)} sourceWorldInstitutionType`, institution.sourceWorldInstitutionType);
    if (institution.worldProvenanceIds !== undefined && (!Array.isArray(institution.worldProvenanceIds) || institution.worldProvenanceIds.some((id) => typeof id !== 'string' || id.trim().length === 0))) throw new Error(`Sandbox save institution ${String(institution.id)} has invalid world provenance.`);
  }

  const knowledgeIds = assertUniqueIdRecords('knowledge', value.knowledge as unknown[]);
  for (const raw of value.knowledge as unknown[]) {
    const entry = raw as Record<string, unknown>;
    if (!Array.isArray(entry.holderIds) || !Array.isArray(entry.subjectIds) || !Array.isArray(entry.truthLinkIds)) throw new Error(`Sandbox save has malformed knowledge ${String(entry.id)}.`);
    assertFinite(`knowledge ${String(entry.id)} confidence`, entry.confidence, 0, 1);
    if (entry.physicalEvidenceSourceEntityId !== undefined && typeof entry.physicalEvidenceSourceEntityId !== 'string') throw new Error(`Sandbox save knowledge ${String(entry.id)} has invalid physical evidence source.`);
    if (entry.requiresPhysicalSample !== undefined && typeof entry.requiresPhysicalSample !== 'boolean') throw new Error(`Sandbox save knowledge ${String(entry.id)} has invalid physical sample requirement.`);
    if (entry.entityObservation !== undefined) {
      const observation = entry.entityObservation;
      if (!isRecord(observation) || typeof observation.entityId !== 'string' || !(entry.subjectIds as unknown[]).includes(observation.entityId)) throw new Error('Knowledge observation requires its recorded subject.');
      assertId('knowledge observation kind', observation.kind);
      if (observation.subtype !== undefined) assertId('knowledge observation subtype', observation.subtype);
      if (observation.traceType !== undefined) assertId('knowledge observation trace', observation.traceType);
      if (!Array.isArray(observation.resourceKeys) || observation.resourceKeys.some((key) => !['food','water','medicine','timber','scrap','fuel','cloth','records'].includes(String(key)))) throw new Error('Knowledge observation has invalid resource semantics.');
      if (entry.physicalEvidenceSourceEntityId !== undefined && observation.entityId !== entry.physicalEvidenceSourceEntityId) throw new Error('Knowledge observation and physical source disagree.');
      if (observation.position !== undefined) {
        if (!isRecord(observation.position)) throw new Error('Invalid observed position.');
        assertId('observed position frame', observation.position.frameId);
        assertFinite('observed position x', observation.position.x);
        assertFinite('observed position y', observation.position.y);
        if (observation.position.z !== undefined) assertFinite('observed position z', observation.position.z);
      }
    }
    if (entry.treatmentObservation !== undefined) {
      const observation = entry.treatmentObservation;
      if (!isRecord(observation) || typeof observation.patientId !== 'string' || !agentIds.has(observation.patientId)) throw new Error('Invalid treatment observation patient.');
      for (const key of ['caseId','pathologyId','practice']) assertId(`treatment observation ${key}`, observation[key]);
      if (!(entry.subjectIds as unknown[]).includes(`pathology:${observation.pathologyId}`) || !(entry.subjectIds as unknown[]).includes(`treatment:${observation.practice}`)) throw new Error('Treatment observation does not match its knowledge subjects.');
      assertFinite('treatment severity before', observation.severityBefore, 0, 100);
      assertFinite('treatment severity after', observation.severityAfter, 0, 100);
    }
    for (const holder of entry.holderIds) if (typeof holder !== 'string' || !agentIds.has(holder)) throw new Error(`Sandbox save knowledge ${String(entry.id)} has unknown holder ${String(holder)}.`);
  }
  for (const raw of agents) {
    const agent = raw as Record<string, unknown>;
    for (const knowledgeId of agent.knowledgeIds as unknown[]) if (typeof knowledgeId !== 'string' || !knowledgeIds.has(knowledgeId)) throw new Error(`Sandbox save agent ${String(agent.id)} references unknown knowledge ${String(knowledgeId)}.`);
  }
  for (const id of settlement.localKnowledgeIds as unknown[]) if (typeof id !== 'string' || !knowledgeIds.has(id)) throw new Error(`Sandbox save settlement references unknown knowledge ${String(id)}.`);

  const recordIds = assertUniqueIdRecords('record', value.records as unknown[]);
  for (const raw of value.records as unknown[]) {
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record.knowledgeIds)) throw new Error(`Sandbox save has malformed record ${String(record.id)}.`);
    assertFinite(`record ${String(record.id)} integrity`, record.integrity, 0, 1);
    assertInteger(`record ${String(record.id)} copies`, record.copies, 0);
    for (const id of record.knowledgeIds) if (typeof id !== 'string' || !knowledgeIds.has(id)) throw new Error(`Sandbox save record ${String(record.id)} references unknown knowledge ${String(id)}.`);
  }
  for (const id of settlement.activeRecordIds as unknown[]) if (typeof id !== 'string' || !recordIds.has(id)) throw new Error(`Sandbox save settlement references unknown record ${String(id)}.`);

  if (value.researchApplications !== undefined) {
    if (!Array.isArray(value.researchApplications)) throw new Error('Invalid research applications.');
    const seen=new Set<string>();
    for (const application of value.researchApplications as unknown[]) {
      if (!isRecord(application) || typeof application.projectId!=='string' || seen.has(application.projectId)) throw new Error('Invalid or duplicate research application.');
      seen.add(application.projectId);
      if (!['medicine','water','forage','repair','records','explore-prep'].includes(String(application.domain))) throw new Error('Invalid research application domain.');
      assertFinite('research application strength',application.strength,0,.15);
      assertInteger('research application uses',application.uses,0);
      if (typeof application.knowledgeId!=='string' || !knowledgeIds.has(application.knowledgeId)) throw new Error('Research application requires result knowledge.');
      const project=Array.isArray(value.researchProjects)?value.researchProjects.find((p)=>isRecord(p)&&p.id===application.projectId):undefined;
      if (!isRecord(project) || project.status!=='completed' || project.resultKnowledgeId!==application.knowledgeId) throw new Error('Research application is not backed by completed research.');
    }
  }
  if (value.researchProjects !== undefined) {
    if (!Array.isArray(value.researchProjects)) throw new Error('Sandbox save has invalid researchProjects.');
    assertUniqueIdRecords('research', value.researchProjects as unknown[]);
    for (const raw of value.researchProjects as unknown[]) {
      const project = raw as Record<string, unknown>;
      if (project.practicalOutcome!==undefined) assertId('research practical outcome',project.practicalOutcome);
      const projectId = String(project.id);
      assertFinite(`research ${projectId} progress`, project.progress, 0, 100);
      assertFinite(`research ${projectId} confidence`, project.confidence, 0, 1);
      if (!Array.isArray(project.researcherIds) || !Array.isArray(project.basisKnowledgeIds) || !Array.isArray(project.subjectIds)) throw new Error(`Sandbox save has malformed research ${projectId}.`);
      if (typeof project.sourceKnowledgeId !== 'string' || !knowledgeIds.has(project.sourceKnowledgeId)) throw new Error(`Sandbox save research ${projectId} references unknown source knowledge.`);
      for (const id of project.basisKnowledgeIds) if (typeof id !== 'string' || !knowledgeIds.has(id)) throw new Error(`Sandbox save research ${projectId} references unknown basis knowledge ${String(id)}.`);
      for (const id of project.researcherIds) if (typeof id !== 'string' || !agentIds.has(id)) throw new Error(`Sandbox save research ${projectId} references unknown researcher ${String(id)}.`);
      if (project.pauseReason !== undefined) assertId('research pause reason',project.pauseReason);
      if (project.contributors !== undefined) {
        if (!Array.isArray(project.contributors)) throw new Error('Invalid research contributors.');
        const contributors = new Set<string>();
        for (const entry of project.contributors) {
          if (!isRecord(entry) || typeof entry.agentId !== 'string' || !agentIds.has(entry.agentId) || contributors.has(entry.agentId)) throw new Error('Invalid or duplicate research contributor.');
          contributors.add(entry.agentId); assertFinite('research contribution hours',entry.hours,0);
        }
      }
      if (project.resultKnowledgeId !== undefined && (typeof project.resultKnowledgeId !== 'string' || !knowledgeIds.has(project.resultKnowledgeId))) throw new Error(`Sandbox save research ${projectId} references unknown result knowledge.`);
      if (!['active','completed','abandoned'].includes(String(project.status))) throw new Error(`Sandbox save research ${projectId} has invalid status.`);
      if (project.status === 'completed' && (project.progress !== 100 || typeof project.resultKnowledgeId !== 'string')) throw new Error(`Sandbox save completed research ${projectId} is incomplete.`);
    }
  }
  if (value.anomalyPractices !== undefined) {
    if (!Array.isArray(value.anomalyPractices)) throw new Error('Sandbox save has invalid anomalyPractices.');
    assertUniqueIdRecords('anomaly practice', value.anomalyPractices as unknown[]);
    for (const raw of value.anomalyPractices as unknown[]) {
      const practice = raw as Record<string, unknown>;
      const practiceId = String(practice.id);
      if (typeof practice.sourceKnowledgeId !== 'string' || !knowledgeIds.has(practice.sourceKnowledgeId)) throw new Error(`Sandbox save anomaly practice ${practiceId} references unknown source knowledge.`);
      if (typeof practice.targetEntityId !== 'string' || !practice.targetEntityId) throw new Error(`Sandbox save anomaly practice ${practiceId} has invalid target.`);
      if (!['medicine','production','communication','defense'].includes(String(practice.domain))) throw new Error(`Sandbox save anomaly practice ${practiceId} has invalid domain.`);
      if (!Array.isArray(practice.operatorIds) || !Array.isArray(practice.providerEventIds)) throw new Error(`Sandbox save anomaly practice ${practiceId} is malformed.`);
      for (const id of practice.operatorIds) if (typeof id !== 'string' || !agentIds.has(id)) throw new Error(`Sandbox save anomaly practice ${practiceId} references unknown operator ${String(id)}.`);
      assertInteger(`anomaly practice ${practiceId} attempts`, practice.attempts, 0);
      assertFinite(`anomaly practice ${practiceId} mastery`, practice.mastery, 0, 100);
      assertFinite(`anomaly practice ${practiceId} stability`, practice.stability, 0, 100);
    }
  }

  if (value.policyProposals !== undefined) {
    if (!Array.isArray(value.policyProposals)) throw new Error('Sandbox save has invalid policyProposals.');
    assertUniqueIdRecords('policy proposal', value.policyProposals as unknown[]);
    for (const raw of value.policyProposals as unknown[]) {
      const proposal = raw as Record<string, unknown>;
      const proposalId = String(proposal.id);
      if (typeof proposal.proposerId !== 'string' || !agentIds.has(proposal.proposerId)) throw new Error(`Sandbox save policy ${proposalId} references unknown proposer.`);
      if (!['forage','water','medicine','repair','sanitation','care','records','guard','rest','explore-prep'].includes(String(proposal.task))) throw new Error(`Sandbox save policy ${proposalId} has invalid task.`);
      assertInteger(`policy ${proposalId} day`, proposal.day, 1);
      assertFinite(`policy ${proposalId} delta`, proposal.delta, -3, 3);
      if (!Array.isArray(proposal.supporterIds) || !Array.isArray(proposal.opponentIds)) throw new Error(`Sandbox save policy ${proposalId} has malformed voters.`);
      for (const id of [...proposal.supporterIds, ...proposal.opponentIds]) if (typeof id !== 'string' || !agentIds.has(id)) throw new Error(`Sandbox save policy ${proposalId} references unknown voter ${String(id)}.`);
      if (!['accepted','rejected'].includes(String(proposal.status))) throw new Error(`Sandbox save policy ${proposalId} has invalid status.`);
    }
  }

  const doctrineIds = assertUniqueIdRecords('doctrine', value.doctrines as unknown[]);
  if (doctrineIds.size === 0) throw new Error('Sandbox save requires at least one expedition doctrine.');
  const expeditionIds = assertUniqueIdRecords('expedition', value.expeditions as unknown[]);
  const activeMembership = new Map<string, string>();
  for (const raw of value.expeditions as unknown[]) {
    const expedition = raw as Record<string, unknown>;
    assertId(`expedition ${String(expedition.id)} leaderId`, expedition.leaderId);
    if (!agentIds.has(expedition.leaderId as string)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has unknown leader.`);
    if (!Array.isArray(expedition.memberIds) || !expedition.memberIds.includes(expedition.leaderId)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid membership.`);
    assertId(`expedition ${String(expedition.id)} doctrineId`, expedition.doctrineId);
    if (expedition.pace !== undefined && !['cautious','normal','fast'].includes(String(expedition.pace))) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid pace.`);
    if (!doctrineIds.has(expedition.doctrineId as string)) throw new Error(`Sandbox save expedition ${String(expedition.id)} references unknown doctrine.`);
    assertSpatial(`expedition ${String(expedition.id)} position`, expedition.position);
    if (expedition.destination !== null) assertSpatial(`expedition ${String(expedition.id)} destination`, expedition.destination);
    if (expedition.destinationEntityId !== undefined) assertId(`expedition ${String(expedition.id)} destinationEntityId`, expedition.destinationEntityId);
    if (expedition.routeEntityId !== undefined) assertId(`expedition ${String(expedition.id)} routeEntityId`, expedition.routeEntityId);
    if (expedition.routeWaypoint !== undefined) assertSpatial(`expedition ${String(expedition.id)} routeWaypoint`, expedition.routeWaypoint);
    if (expedition.routeWaypointReached !== undefined && typeof expedition.routeWaypointReached !== 'boolean') throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid routeWaypointReached.`);
    if (expedition.routePlan !== undefined) {
      if (!isRecord(expedition.routePlan) || expedition.routePlan.kind !== 'provider-topology') throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid routePlan.`);
      const plan = expedition.routePlan;
      for (const key of ['nodeEntityIds','relationIds','evidenceIds','waypointEntityIds','waypoints']) if (!Array.isArray(plan[key])) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan.${key} is invalid.`);
      for (const id of [...(plan.nodeEntityIds as unknown[]), ...(plan.relationIds as unknown[]), ...(plan.evidenceIds as unknown[]), ...(plan.waypointEntityIds as unknown[])]) assertId(`expedition ${String(expedition.id)} routePlan id`, id);
      if ((plan.nodeEntityIds as unknown[]).length < 2) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan has insufficient nodes.`);
      if ((plan.relationIds as unknown[]).length !== (plan.nodeEntityIds as unknown[]).length - 1) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan edge/node cardinality is invalid.`);
      if ((plan.waypointEntityIds as unknown[]).length !== (plan.waypoints as unknown[]).length) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan waypoint cardinality is invalid.`);
      if (plan.waypointRelationIds !== undefined) {
        if (!Array.isArray(plan.waypointRelationIds) || plan.waypointRelationIds.length !== (plan.waypoints as unknown[]).length) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan waypointRelationIds cardinality is invalid.`);
        for (const id of plan.waypointRelationIds) assertId(`expedition ${String(expedition.id)} routePlan waypointRelationId`, id);
      }
      if (plan.relationSignatures !== undefined) {
        if (!Array.isArray(plan.relationSignatures) || plan.relationSignatures.length !== (plan.relationIds as unknown[]).length || plan.relationSignatures.some((entry) => typeof entry !== 'string')) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan relationSignatures are invalid.`);
      }
      if (plan.basisTick !== undefined) assertInteger(`expedition ${String(expedition.id)} routePlan basisTick`, plan.basisTick, 0);
      if (plan.lastValidatedTick !== undefined) assertInteger(`expedition ${String(expedition.id)} routePlan lastValidatedTick`, plan.lastValidatedTick, 0);
      if (plan.blockedAtTick !== undefined) assertInteger(`expedition ${String(expedition.id)} routePlan blockedAtTick`, plan.blockedAtTick, 0);
      if (plan.replanCount !== undefined) assertInteger(`expedition ${String(expedition.id)} routePlan replanCount`, plan.replanCount, 0);
      if (plan.topologyStatus !== undefined && !['active','blocked'].includes(String(plan.topologyStatus))) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan topologyStatus is invalid.`);
      if (plan.blockedReason !== undefined && typeof plan.blockedReason !== 'string') throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan blockedReason is invalid.`);
      if (plan.blockedEvidenceIds !== undefined && (!Array.isArray(plan.blockedEvidenceIds) || plan.blockedEvidenceIds.some((entry) => typeof entry !== 'string' || !entry.trim()))) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan blockedEvidenceIds are invalid.`);
      for (const waypoint of plan.waypoints as unknown[]) assertSpatial(`expedition ${String(expedition.id)} routePlan waypoint`, waypoint);
      assertInteger(`expedition ${String(expedition.id)} routePlan currentWaypointIndex`, plan.currentWaypointIndex, 0);
      if (Number(plan.currentWaypointIndex) > (plan.waypoints as unknown[]).length) throw new Error(`Sandbox save expedition ${String(expedition.id)} routePlan currentWaypointIndex is out of range.`);
      assertFinite(`expedition ${String(expedition.id)} routePlan plannedDistanceKm`, plan.plannedDistanceKm, 0);
    }
    if (expedition.fieldDecision !== undefined) {
      if (!isRecord(expedition.fieldDecision)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid fieldDecision.`);
      const decision = expedition.fieldDecision;
      assertId(`expedition ${String(expedition.id)} fieldDecision id`, decision.id);
      if (!['wait-camp','return','retry-replan'].includes(String(decision.kind))) throw new Error(`Sandbox save expedition ${String(expedition.id)} fieldDecision kind is invalid.`);
      if (!['active','completed','failed'].includes(String(decision.status))) throw new Error(`Sandbox save expedition ${String(expedition.id)} fieldDecision status is invalid.`);
      assertInteger(`expedition ${String(expedition.id)} fieldDecision issuedDay`, decision.issuedDay, 1);
      assertInteger(`expedition ${String(expedition.id)} fieldDecision issuedMinute`, decision.issuedMinute, 0, 1439);
      assertInteger(`expedition ${String(expedition.id)} fieldDecision issuedTick`, decision.issuedTick, 0);
      if (!['connected','delayed','silent','falsified','altered','unknown'].includes(String(decision.communicationAtDecision))) throw new Error(`Sandbox save expedition ${String(expedition.id)} fieldDecision communicationAtDecision is invalid.`);
      if (decision.remainingHours !== undefined) assertFinite(`expedition ${String(expedition.id)} fieldDecision remainingHours`, decision.remainingHours, 0, 24);
      if (decision.initialHours !== undefined) assertFinite(`expedition ${String(expedition.id)} fieldDecision initialHours`, decision.initialHours, 1, 24);
      if (decision.completedDay !== undefined) assertInteger(`expedition ${String(expedition.id)} fieldDecision completedDay`, decision.completedDay, 1);
      if (decision.completedMinute !== undefined) assertInteger(`expedition ${String(expedition.id)} fieldDecision completedMinute`, decision.completedMinute, 0, 1439);
      if (decision.result !== undefined && typeof decision.result !== 'string') throw new Error(`Sandbox save expedition ${String(expedition.id)} fieldDecision result is invalid.`);
      if (decision.kind === 'wait-camp' && decision.status === 'active' && !(typeof decision.remainingHours === 'number' && decision.remainingHours > 0)) throw new Error(`Sandbox save expedition ${String(expedition.id)} active wait-camp decision lacks remaining time.`);
      if (decision.kind === 'return' && decision.status === 'active') throw new Error(`Sandbox save expedition ${String(expedition.id)} cannot persist an active return field decision.`);
      if (decision.status === 'active' && (expedition.status !== 'outbound' || !isRecord(expedition.routePlan) || expedition.routePlan.topologyStatus !== 'blocked')) throw new Error(`Sandbox save expedition ${String(expedition.id)} active fieldDecision requires a blocked outbound provider route.`);
    }
    if (expedition.fieldExposure !== undefined) {
      if (!isRecord(expedition.fieldExposure)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid fieldExposure.`);
      const exposure = expedition.fieldExposure;
      assertFinite(`expedition ${String(expedition.id)} fieldExposure cumulativeDose`, exposure.cumulativeDose, 0);
      assertFinite(`expedition ${String(expedition.id)} fieldExposure lastIntervalDose`, exposure.lastIntervalDose, 0);
      assertFinite(`expedition ${String(expedition.id)} fieldExposure lastRisk`, exposure.lastRisk, 0, 1);
      if (exposure.lastProviderTick !== undefined) assertInteger(`expedition ${String(expedition.id)} fieldExposure lastProviderTick`, exposure.lastProviderTick, 0);
      if (!Array.isArray(exposure.sourceEntityIds)) throw new Error(`Sandbox save expedition ${String(expedition.id)} fieldExposure sourceEntityIds is invalid.`);
      for (const id of exposure.sourceEntityIds) assertId(`expedition ${String(expedition.id)} fieldExposure sourceEntityId`, id);
      if (typeof exposure.sheltered !== 'boolean') throw new Error(`Sandbox save expedition ${String(expedition.id)} fieldExposure sheltered is invalid.`);
    }
    if (expedition.returnTravelMode !== undefined && expedition.returnTravelMode !== 'off-network-bearing') throw new Error(`Sandbox save expedition ${String(expedition.id)} returnTravelMode is invalid.`);
    if (expedition.returnTravel !== undefined) {
      if (!isRecord(expedition.returnTravel)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid returnTravel.`);
      const travel = expedition.returnTravel;
      if (travel.mode !== 'off-network-bearing') throw new Error(`Sandbox save expedition ${String(expedition.id)} returnTravel mode is invalid.`);
      if (!['active','completed','interrupted'].includes(String(travel.status))) throw new Error(`Sandbox save expedition ${String(expedition.id)} returnTravel status is invalid.`);
      assertInteger(`expedition ${String(expedition.id)} returnTravel startedDay`, travel.startedDay, 1);
      assertInteger(`expedition ${String(expedition.id)} returnTravel startedMinute`, travel.startedMinute, 0, 1439);
      assertInteger(`expedition ${String(expedition.id)} returnTravel startedTick`, travel.startedTick, 0);
      assertSpatial(`expedition ${String(expedition.id)} returnTravel origin`, travel.origin);
      assertSpatial(`expedition ${String(expedition.id)} returnTravel target`, travel.target);
      for (const key of ['initialDistanceKm','travelledDistanceKm','remainingDistanceKm','lastIntervalDistanceKm','uncertaintyKm']) assertFinite(`expedition ${String(expedition.id)} returnTravel ${key}`, travel[key], 0);
      assertFinite(`expedition ${String(expedition.id)} returnTravel lastSpeedFactor`, travel.lastSpeedFactor, 0.1, 1);
      assertFinite(`expedition ${String(expedition.id)} returnTravel lastTerrainRisk`, travel.lastTerrainRisk, 0, 1);
      if (travel.lastProviderTick !== undefined) assertInteger(`expedition ${String(expedition.id)} returnTravel lastProviderTick`, travel.lastProviderTick, 0);
      for (const field of ['terrainEvidenceIds','navigationAnchorIds']) {
        if (!Array.isArray(travel[field])) throw new Error(`Sandbox save expedition ${String(expedition.id)} returnTravel ${field} is invalid.`);
        for (const id of travel[field] as unknown[]) assertId(`expedition ${String(expedition.id)} returnTravel ${field} id`, id);
      }
      if (travel.completedDay !== undefined) assertInteger(`expedition ${String(expedition.id)} returnTravel completedDay`, travel.completedDay, 1);
      if (travel.completedMinute !== undefined) assertInteger(`expedition ${String(expedition.id)} returnTravel completedMinute`, travel.completedMinute, 0, 1439);
      if (travel.status === 'active' && expedition.status !== 'returning') throw new Error(`Sandbox save expedition ${String(expedition.id)} active returnTravel requires returning expedition status.`);
      if (travel.status === 'completed' && expedition.status !== 'returned') throw new Error(`Sandbox save expedition ${String(expedition.id)} completed returnTravel requires returned expedition status.`);
      if (travel.status === 'interrupted' && ['returning','returned'].includes(String(expedition.status))) throw new Error(`Sandbox save expedition ${String(expedition.id)} interrupted returnTravel cannot remain on an active/completed return.`);
    }
    if (expedition.rendezvousRequest !== undefined) {
      if (!isRecord(expedition.rendezvousRequest)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid rendezvousRequest.`);
      const request = expedition.rendezvousRequest;
      assertId(`expedition ${String(expedition.id)} rendezvousRequest id`, request.id);
      if (!['pending-link','transmitted','resolved','cancelled'].includes(String(request.status))) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousRequest status is invalid.`);
      assertInteger(`expedition ${String(expedition.id)} rendezvousRequest requestedDay`, request.requestedDay, 1);
      assertInteger(`expedition ${String(expedition.id)} rendezvousRequest requestedMinute`, request.requestedMinute, 0, 1439);
      assertInteger(`expedition ${String(expedition.id)} rendezvousRequest requestedTick`, request.requestedTick, 0);
      if (!['connected','delayed','silent','falsified','altered','unknown'].includes(String(request.communicationAtRequest))) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousRequest communicationAtRequest is invalid.`);
      assertSpatial(`expedition ${String(expedition.id)} rendezvousRequest requestedPosition`, request.requestedPosition);
      if (request.transmittedDay !== undefined) assertInteger(`expedition ${String(expedition.id)} rendezvousRequest transmittedDay`, request.transmittedDay, 1);
      if (request.transmittedMinute !== undefined) assertInteger(`expedition ${String(expedition.id)} rendezvousRequest transmittedMinute`, request.transmittedMinute, 0, 1439);
      if (request.verifiedPosition !== undefined) assertSpatial(`expedition ${String(expedition.id)} rendezvousRequest verifiedPosition`, request.verifiedPosition);
      if (request.resolution !== undefined && typeof request.resolution !== 'string') throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousRequest resolution is invalid.`);
      if (request.status === 'pending-link' && request.verifiedPosition !== undefined) throw new Error(`Sandbox save expedition ${String(expedition.id)} pending-link rendezvousRequest cannot expose a verifiedPosition.`);
      if (request.status === 'transmitted' && !isRecord(request.verifiedPosition)) throw new Error(`Sandbox save expedition ${String(expedition.id)} transmitted rendezvousRequest requires a verifiedPosition.`);
    }
    if (expedition.rendezvousPlan !== undefined) {
      if (!isRecord(expedition.rendezvousPlan)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid rendezvousPlan.`);
      const plan = expedition.rendezvousPlan;
      assertId(`expedition ${String(expedition.id)} rendezvousPlan id`, plan.id);
      assertId(`expedition ${String(expedition.id)} rendezvousPlan targetExpeditionId`, plan.targetExpeditionId);
      assertId(`expedition ${String(expedition.id)} rendezvousPlan targetEvidenceId`, plan.targetEvidenceId);
      if (!expeditionIds.has(String(plan.targetExpeditionId)) || plan.targetExpeditionId === expedition.id) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan target is invalid.`);
      if (expedition.rescueOfExpeditionId !== plan.targetExpeditionId) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan must match rescueOfExpeditionId.`);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan targetEvidenceDay`, plan.targetEvidenceDay, 1);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan targetEvidenceMinute`, plan.targetEvidenceMinute, 0, 1439);
      assertSpatial(`expedition ${String(expedition.id)} rendezvousPlan evidencePosition`, plan.evidencePosition);
      if (!Array.isArray(plan.evidenceSourceIds)) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan evidenceSourceIds is invalid.`);
      for (const id of plan.evidenceSourceIds) assertId(`expedition ${String(expedition.id)} rendezvousPlan evidenceSourceId`, id);
      if (plan.intendedTargetPosition !== undefined) assertSpatial(`expedition ${String(expedition.id)} rendezvousPlan intendedTargetPosition`, plan.intendedTargetPosition);
      if (plan.intendedTargetSourceIds !== undefined) {
        if (!Array.isArray(plan.intendedTargetSourceIds)) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan intendedTargetSourceIds is invalid.`);
        for (const id of plan.intendedTargetSourceIds) assertId(`expedition ${String(expedition.id)} rendezvousPlan intendedTargetSourceId`, id);
      }
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan launchedDay`, plan.launchedDay, 1);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan launchedMinute`, plan.launchedMinute, 0, 1439);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan launchedTick`, plan.launchedTick, 0);
      assertFinite(`expedition ${String(expedition.id)} rendezvousPlan etaHoursAtLaunch`, plan.etaHoursAtLaunch, 0);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan arrivalWindowStartDay`, plan.arrivalWindowStartDay, 1);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan arrivalWindowStartMinute`, plan.arrivalWindowStartMinute, 0, 1439);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan arrivalWindowEndDay`, plan.arrivalWindowEndDay, 1);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan arrivalWindowEndMinute`, plan.arrivalWindowEndMinute, 0, 1439);
      if (!['outbound','waiting','searching','contact','aborted','completed'].includes(String(plan.status))) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan status is invalid.`);
      if (plan.arrivedDay !== undefined) assertInteger(`expedition ${String(expedition.id)} rendezvousPlan arrivedDay`, plan.arrivedDay, 1);
      if (plan.arrivedMinute !== undefined) assertInteger(`expedition ${String(expedition.id)} rendezvousPlan arrivedMinute`, plan.arrivedMinute, 0, 1439);
      if (plan.arrivalAssessment !== undefined && !['early','within','late'].includes(String(plan.arrivalAssessment))) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan arrivalAssessment is invalid.`);
      assertFinite(`expedition ${String(expedition.id)} rendezvousPlan waitHoursTotal`, plan.waitHoursTotal, 0, 48);
      assertFinite(`expedition ${String(expedition.id)} rendezvousPlan waitHoursRemaining`, plan.waitHoursRemaining, 0, 48);
      assertFinite(`expedition ${String(expedition.id)} rendezvousPlan searchHours`, plan.searchHours, 0);
      assertFinite(`expedition ${String(expedition.id)} rendezvousPlan searchRadiusKm`, plan.searchRadiusKm, 0, 50);
      assertInteger(`expedition ${String(expedition.id)} rendezvousPlan searchStep`, plan.searchStep, 0);
      if (!Array.isArray(plan.lastSearchEvidenceIds)) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan lastSearchEvidenceIds is invalid.`);
      for (const id of plan.lastSearchEvidenceIds) assertId(`expedition ${String(expedition.id)} rendezvousPlan lastSearchEvidenceId`, id);
      if (plan.lastOutcome !== undefined && !['met','waited-no-contact','aborted','evidence-updated','responder-turnback'].includes(String(plan.lastOutcome))) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan lastOutcome is invalid.`);
      if (plan.abortedReason !== undefined && typeof plan.abortedReason !== 'string') throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan abortedReason is invalid.`);
      if (plan.coLocatedAt !== undefined) assertSpatial(`expedition ${String(expedition.id)} rendezvousPlan coLocatedAt`, plan.coLocatedAt);
      if (plan.completedDay !== undefined) assertInteger(`expedition ${String(expedition.id)} rendezvousPlan completedDay`, plan.completedDay, 1);
      if (plan.completedMinute !== undefined) assertInteger(`expedition ${String(expedition.id)} rendezvousPlan completedMinute`, plan.completedMinute, 0, 1439);
      if (plan.transfer !== undefined) {
        if (!isRecord(plan.transfer)) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan transfer is invalid.`);
        assertInteger(`expedition ${String(expedition.id)} rendezvousPlan transfer completedDay`, plan.transfer.completedDay, 1);
        assertInteger(`expedition ${String(expedition.id)} rendezvousPlan transfer completedMinute`, plan.transfer.completedMinute, 0, 1439);
        for (const key of ['food','water','medicine','tools']) assertFinite(`expedition ${String(expedition.id)} rendezvousPlan transfer ${key}`, plan.transfer[key], 0);
        if (!Array.isArray(plan.transfer.injuredMemberIds)) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan transfer injuredMemberIds is invalid.`);
        for (const id of plan.transfer.injuredMemberIds) if (typeof id !== 'string' || !agentIds.has(id)) throw new Error(`Sandbox save expedition ${String(expedition.id)} rendezvousPlan transfer references unknown member ${String(id)}.`);
      }
      if (['outbound','waiting','searching','contact'].includes(String(plan.status)) && ['returning','returned','destroyed','joined-elsewhere'].includes(String(expedition.status))) throw new Error(`Sandbox save expedition ${String(expedition.id)} active rendezvousPlan is incompatible with expedition status.`);
      if (plan.status === 'contact' && !isRecord(plan.coLocatedAt)) throw new Error(`Sandbox save expedition ${String(expedition.id)} contact rendezvousPlan requires coLocatedAt.`);
      if (plan.status === 'completed' && !isRecord(plan.transfer)) throw new Error(`Sandbox save expedition ${String(expedition.id)} completed rendezvousPlan requires transfer evidence.`);
      if (['aborted','completed'].includes(String(plan.status)) && !['returning','returned'].includes(String(expedition.status))) throw new Error(`Sandbox save expedition ${String(expedition.id)} terminal rendezvousPlan requires responder return state.`);
    }
    if (!isRecord(expedition.supplies)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid supplies.`);
    for (const key of ['food','water','medicine','tools']) assertFinite(`expedition ${String(expedition.id)} supplies.${key}`, expedition.supplies[key], 0);
    if (!Array.isArray(expedition.orders) || !Array.isArray(expedition.observations) || !Array.isArray(expedition.discoveredEntityIds)) throw new Error(`Sandbox save expedition ${String(expedition.id)} is incomplete.`);
    for (const rawOrder of expedition.orders as unknown[]) {
      if (!isRecord(rawOrder)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has malformed order.`);
      if (rawOrder.providerCommandId !== undefined) {
        assertId(`expedition ${String(expedition.id)} order providerCommandId`, rawOrder.providerCommandId);
        if (!String(rawOrder.providerCommandId).startsWith(`game:${String(value.saveId)}:`)) throw new Error(`Sandbox save expedition ${String(expedition.id)} order has foreign provider command id.`);
      }
    }
    if (expedition.communicationReports !== undefined && !Array.isArray(expedition.communicationReports)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid communication reports.`);
    if (Array.isArray(expedition.communicationReports)) {
      for (const rawReport of expedition.communicationReports) {
        if (!isRecord(rawReport)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has malformed communication report.`);
        if (rawReport.verifiedPosition !== undefined) assertSpatial(`expedition ${String(expedition.id)} communication verifiedPosition`, rawReport.verifiedPosition);
        if (rawReport.perceivedPosition !== undefined) assertSpatial(`expedition ${String(expedition.id)} communication perceivedPosition`, rawReport.perceivedPosition);
      }
    }
    if (expedition.alterations !== undefined && !Array.isArray(expedition.alterations)) throw new Error(`Sandbox save expedition ${String(expedition.id)} has invalid alteration history.`);
    if (expedition.arrivedDay !== undefined) assertInteger(`expedition ${String(expedition.id)} arrivedDay`, expedition.arrivedDay, 1);
    if (expedition.arrivedMinute !== undefined) assertInteger(`expedition ${String(expedition.id)} arrivedMinute`, expedition.arrivedMinute, 0, 1439);
    if (expedition.lastDoctrineCampDay !== undefined) assertInteger(`expedition ${String(expedition.id)} lastDoctrineCampDay`, expedition.lastDoctrineCampDay, 1);
    const terminal = ['returned','destroyed','joined-elsewhere'].includes(String(expedition.status));
    for (const memberId of expedition.memberIds) {
      if (typeof memberId !== 'string' || !agentIds.has(memberId)) throw new Error(`Sandbox save expedition ${String(expedition.id)} references unknown member ${String(memberId)}.`);
      if (!terminal) {
        const previous = activeMembership.get(memberId);
        if (previous && previous !== expedition.id) throw new Error(`Sandbox save agent ${memberId} belongs to multiple active expeditions.`);
        activeMembership.set(memberId, expedition.id as string);
      }
    }
  }
  for (const raw of agents) {
    const agent = raw as Record<string, unknown>;
    const expected = activeMembership.get(agent.id as string) ?? null;
    if (agent.expeditionId !== expected) throw new Error(`Sandbox save expedition membership mismatch for ${String(agent.id)}.`);
  }

  if (value.incidentLedger !== undefined) {
    if (!isRecord(value.incidentLedger) || value.incidentLedger.schemaVersion !== 1 || !Array.isArray(value.incidentLedger.entries)) throw new Error('Sandbox save has invalid incidentLedger sidecar.');
    assertInteger('incidentLedger.lastSyncAt', value.incidentLedger.lastSyncAt, 0);
    if (value.incidentLedger.resolutionPolicyVersion !== undefined && value.incidentLedger.resolutionPolicyVersion !== 1) throw new Error('Sandbox save incidentLedger resolutionPolicyVersion is invalid.');
    if (value.incidentLedger.entries.length > 256) throw new Error('Sandbox save incidentLedger exceeds the bounded retention limit.');
    const incidentKeys = new Set<string>();
    for (const raw of value.incidentLedger.entries as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed incidentLedger entry.');
      assertId('incidentLedger entry key', raw.key);
      if (incidentKeys.has(String(raw.key))) throw new Error(`Sandbox save contains duplicate incidentLedger key: ${String(raw.key)}`);
      incidentKeys.add(String(raw.key));
      assertId(`incidentLedger ${String(raw.key)} contextKey`, raw.contextKey);
      assertId(`incidentLedger ${String(raw.key)} incidentId`, raw.incidentId);
      assertId(`incidentLedger ${String(raw.key)} templateId`, raw.templateId);
      if (raw.causalDedupeKey !== undefined) assertId(`incidentLedger ${String(raw.key)} causalDedupeKey`, raw.causalDedupeKey);
      if (raw.expiresAt !== undefined) assertInteger(`incidentLedger ${String(raw.key)} expiresAt`, raw.expiresAt, 0);
      if (!['active','resolved','expired','withdrawn'].includes(String(raw.phase))) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} phase is invalid.`);
      for (const field of ['firstSeenAt','lastSeenAt','lastUpdatedAt','occurrenceCount','visibleSyncCount'] as const) assertInteger(`incidentLedger ${String(raw.key)} ${field}`, raw[field], field.endsWith('Count') ? 1 : 0);
      if ((raw.lastSeenAt as number) < (raw.firstSeenAt as number) || (raw.lastUpdatedAt as number) < (raw.lastSeenAt as number)) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} time ordering is invalid.`);
      if (raw.terminalAt !== undefined) assertInteger(`incidentLedger ${String(raw.key)} terminalAt`, raw.terminalAt, 0);
      if (raw.phase === 'active' && raw.terminalAt !== undefined) throw new Error(`Sandbox save active incidentLedger ${String(raw.key)} cannot have terminalAt.`);
      if (raw.phase !== 'active' && typeof raw.terminalAt !== 'number') throw new Error(`Sandbox save terminal incidentLedger ${String(raw.key)} requires terminalAt.`);
      if (!['low','medium','high','critical'].includes(String(raw.lastUrgency))) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} urgency is invalid.`);
      if (!Array.isArray(raw.lastCauseRefs) || raw.lastCauseRefs.some((id) => typeof id !== 'string' || !id.trim())) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} cause refs are invalid.`);
      if (raw.contextKey !== 'settlement') {
        if (!String(raw.contextKey).startsWith('expedition:')) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} context is invalid.`);
        const expeditionId = String(raw.contextKey).slice('expedition:'.length);
        if (!expeditionIds.has(expeditionId)) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} references unknown expedition context.`);
      }
      if (String(raw.key) !== `${String(raw.contextKey)}|${String(raw.incidentId)}`) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} key identity is inconsistent.`);
      if (raw.lastResolutionEvidence !== undefined) {
        if (!isRecord(raw.lastResolutionEvidence)) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} has malformed positive resolution evidence.`);
        const evidence = raw.lastResolutionEvidence;
        assertId(`incidentLedger ${String(raw.key)} resolution evidence id`, evidence.id);
        const allowedKinds = ['settlement-resource-threshold','recorded-case-cleared','field-health-threshold','field-fatigue-threshold','field-supply-threshold','communication-restored','encounter-resolved','research-sample-present','provider-return-observed'];
        if (!allowedKinds.includes(String(evidence.kind))) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence kind is invalid.`);
        assertInteger(`incidentLedger ${String(raw.key)} resolution evidence observedAt`, evidence.observedAt, raw.firstSeenAt as number, (value.clock.day as number) * 1440 + (value.clock.minuteOfDay as number));
        assertInteger(`incidentLedger ${String(raw.key)} resolution evidence occurrenceNumber`, evidence.occurrenceNumber, 1, raw.occurrenceCount as number);
        if (String(evidence.id) !== `incident-resolution-evidence:${(evidence.occurrenceNumber as number).toString(36)}:${String(raw.key)}`) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence identity is inconsistent.`);
        if (!Array.isArray(evidence.subjectIds) || evidence.subjectIds.length < 1 || evidence.subjectIds.length > 32 || evidence.subjectIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(evidence.subjectIds as string[]).size !== evidence.subjectIds.length) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence subjects are invalid.`);
        if (!Array.isArray(evidence.supportingOperationIds) || evidence.supportingOperationIds.length > 32 || evidence.supportingOperationIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(evidence.supportingOperationIds as string[]).size !== evidence.supportingOperationIds.length) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence operation refs are invalid.`);
        const numericKinds = new Set(['settlement-resource-threshold','field-health-threshold','field-fatigue-threshold','field-supply-threshold']);
        if (numericKinds.has(String(evidence.kind))) {
          if (!['food','water','health','fatigue','supply-days'].includes(String(evidence.metric))) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence metric is invalid.`);
          assertFinite(`incidentLedger ${String(raw.key)} resolution evidence observedValue`, evidence.observedValue, 0);
          assertFinite(`incidentLedger ${String(raw.key)} resolution evidence thresholdValue`, evidence.thresholdValue, 0);
          if (!['gte','lt'].includes(String(evidence.comparison))) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence comparison is invalid.`);
          if (evidence.comparison === 'gte' && (evidence.observedValue as number) < (evidence.thresholdValue as number)) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence does not satisfy its positive threshold.`);
          if (evidence.comparison === 'lt' && (evidence.observedValue as number) >= (evidence.thresholdValue as number)) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence does not satisfy its positive threshold.`);
          if (evidence.kind === 'settlement-resource-threshold' && !['food','water'].includes(String(evidence.metric))) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} settlement resolution evidence metric is invalid.`);
          if (evidence.kind === 'field-health-threshold' && evidence.metric !== 'health') throw new Error(`Sandbox save incidentLedger ${String(raw.key)} health resolution evidence metric is invalid.`);
          if (evidence.kind === 'field-fatigue-threshold' && evidence.metric !== 'fatigue') throw new Error(`Sandbox save incidentLedger ${String(raw.key)} fatigue resolution evidence metric is invalid.`);
          if (evidence.kind === 'field-supply-threshold' && evidence.metric !== 'supply-days') throw new Error(`Sandbox save incidentLedger ${String(raw.key)} supply resolution evidence metric is invalid.`);
        } else if (evidence.metric !== undefined || evidence.observedValue !== undefined || evidence.thresholdValue !== undefined || evidence.comparison !== undefined) {
          throw new Error(`Sandbox save incidentLedger ${String(raw.key)} nonnumeric resolution evidence illegally persists metric fields.`);
        }
        if (raw.phase === 'resolved' && raw.terminalAt !== evidence.observedAt) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence time disagrees with terminal state.`);
        for (const forbidden of ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','causeConfirmed','responseSucceeded']) if (evidence[forbidden] !== undefined) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} resolution evidence illegally persists outcome/presentation truth.`);
      }
      if (value.incidentLedger.resolutionPolicyVersion === 1 && raw.phase === 'resolved' && raw.lastResolutionEvidence === undefined) throw new Error(`Sandbox save resolved incidentLedger ${String(raw.key)} requires explicit positive resolution evidence.`);
      for (const forbidden of ['title','summary','detail','presentation','visibleStakeText']) if (raw[forbidden] !== undefined) throw new Error(`Sandbox save incidentLedger ${String(raw.key)} illegally persists presentation text.`);
    }
  }


  if (value.incidentDispatch !== undefined) {
    if (!isRecord(value.incidentDispatch) || value.incidentDispatch.schemaVersion !== 1 || !Array.isArray(value.incidentDispatch.teams)) throw new Error('Sandbox save has invalid incidentDispatch sidecar.');
    assertInteger('incidentDispatch.nextDispatchOrdinal', value.incidentDispatch.nextDispatchOrdinal, 1);
    if (value.incidentDispatch.teams.length > 192) throw new Error('Sandbox save incidentDispatch exceeds the bounded retention limit.');
    const teamIds = new Set<string>();
    const ordinals = new Set<number>();
    const activeContextCounts = new Map<string, number>();
    const activeIncidentCounts = new Map<string, number>();
    const activeMembersByContext = new Map<string, Set<string>>();
    for (const raw of value.incidentDispatch.teams as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed incidentDispatch team.');
      assertId('incidentDispatch team id', raw.id);
      if (teamIds.has(String(raw.id))) throw new Error(`Sandbox save contains duplicate incidentDispatch team id: ${String(raw.id)}`);
      teamIds.add(String(raw.id));
      assertId(`incidentDispatch ${String(raw.id)} contextKey`, raw.contextKey);
      assertId(`incidentDispatch ${String(raw.id)} incidentId`, raw.incidentId);
      assertInteger(`incidentDispatch ${String(raw.id)} dispatchOrdinal`, raw.dispatchOrdinal, 1);
      if ((raw.dispatchOrdinal as number) >= (value.incidentDispatch.nextDispatchOrdinal as number)) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} references an unallocated dispatch ordinal.`);
      if (ordinals.has(raw.dispatchOrdinal as number)) throw new Error(`Sandbox save contains duplicate incidentDispatch ordinal: ${String(raw.dispatchOrdinal)}`);
      ordinals.add(raw.dispatchOrdinal as number);
      if (!['assigned','dispatched','stood-down'].includes(String(raw.phase))) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} phase is invalid.`);
      assertInteger(`incidentDispatch ${String(raw.id)} assignedAt`, raw.assignedAt, 0);
      assertInteger(`incidentDispatch ${String(raw.id)} lastUpdatedAt`, raw.lastUpdatedAt, 0);
      if ((raw.lastUpdatedAt as number) < (raw.assignedAt as number)) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} time ordering is invalid.`);
      if (raw.dispatchedAt !== undefined) {
        assertInteger(`incidentDispatch ${String(raw.id)} dispatchedAt`, raw.dispatchedAt, 0);
        if ((raw.dispatchedAt as number) < (raw.assignedAt as number)) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} dispatch time is invalid.`);
      }
      if (raw.stoodDownAt !== undefined) {
        assertInteger(`incidentDispatch ${String(raw.id)} stoodDownAt`, raw.stoodDownAt, 0);
        if ((raw.stoodDownAt as number) < (raw.assignedAt as number)) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} stand-down time is invalid.`);
      }
      if (raw.phase === 'assigned' && (raw.dispatchedAt !== undefined || raw.stoodDownAt !== undefined)) throw new Error(`Sandbox save assigned incidentDispatch ${String(raw.id)} has terminal/dispatch timestamps.`);
      if (raw.phase === 'dispatched' && (typeof raw.dispatchedAt !== 'number' || raw.stoodDownAt !== undefined)) throw new Error(`Sandbox save dispatched incidentDispatch ${String(raw.id)} has invalid timestamps.`);
      if (raw.phase === 'stood-down' && typeof raw.stoodDownAt !== 'number') throw new Error(`Sandbox save stood-down incidentDispatch ${String(raw.id)} requires stoodDownAt.`);
      if (!Array.isArray(raw.memberIds) || raw.memberIds.length < 1 || raw.memberIds.length > 4) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} has invalid team size.`);
      const memberIds = raw.memberIds as unknown[];
      const uniqueMembers = new Set<string>();
      for (const memberId of memberIds) {
        if (typeof memberId !== 'string' || !agentIds.has(memberId)) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} references unknown member ${String(memberId)}.`);
        if (uniqueMembers.has(memberId)) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} duplicates member ${memberId}.`);
        uniqueMembers.add(memberId);
      }
      if (raw.contextKey !== 'settlement') {
        if (!String(raw.contextKey).startsWith('expedition:')) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} context is invalid.`);
        const expeditionId = String(raw.contextKey).slice('expedition:'.length);
        if (!expeditionIds.has(expeditionId)) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} references unknown expedition context.`);
      }
      for (const forbidden of ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure']) if (raw[forbidden] !== undefined) throw new Error(`Sandbox save incidentDispatch ${String(raw.id)} illegally persists incident presentation/outcome truth.`);
      if (raw.phase === 'assigned' || raw.phase === 'dispatched') {
        const context = String(raw.contextKey);
        const incidentKey = `${context}|${String(raw.incidentId)}`;
        const contextCount = (activeContextCounts.get(context) ?? 0) + 1;
        const incidentCount = (activeIncidentCounts.get(incidentKey) ?? 0) + 1;
        if (contextCount > 4) throw new Error(`Sandbox save incidentDispatch context ${context} exceeds active team capacity.`);
        if (incidentCount > 3) throw new Error(`Sandbox save incidentDispatch ${incidentKey} exceeds multi-team capacity.`);
        activeContextCounts.set(context, contextCount);
        activeIncidentCounts.set(incidentKey, incidentCount);
        const activeMembers = activeMembersByContext.get(context) ?? new Set<string>();
        for (const memberId of uniqueMembers) {
          if (activeMembers.has(memberId)) throw new Error(`Sandbox save incidentDispatch member ${memberId} is committed to multiple active teams in ${context}.`);
          activeMembers.add(memberId);
        }
        activeMembersByContext.set(context, activeMembers);
      }
    }
  }

  if (value.incidentResponseOperations !== undefined) {
    if (!isRecord(value.incidentResponseOperations) || value.incidentResponseOperations.schemaVersion !== 1 || !Array.isArray(value.incidentResponseOperations.operations)) throw new Error('Sandbox save has invalid incidentResponseOperations sidecar.');
    assertInteger('incidentResponseOperations.nextObservationOrdinal', value.incidentResponseOperations.nextObservationOrdinal, 1);
    if (value.incidentResponseOperations.operations.length > 192) throw new Error('Sandbox save incidentResponseOperations exceeds the bounded retention limit.');
    const dispatchTeamValues = isRecord(value.incidentDispatch) && Array.isArray(value.incidentDispatch.teams) ? value.incidentDispatch.teams as unknown[] : [];
    if (dispatchTeamValues.length === 0 && value.incidentResponseOperations.operations.length > 0) throw new Error('Sandbox save incidentResponseOperations requires incidentDispatch state for retained operations.');
    const dispatchTeams = new Map<string, Record<string, unknown>>();
    for (const rawTeam of dispatchTeamValues) {
      if (isRecord(rawTeam) && typeof rawTeam.id === 'string') dispatchTeams.set(rawTeam.id, rawTeam);
    }
    const operationIds = new Set<string>();
    const operationTeamIds = new Set<string>();
    const observationIds = new Set<string>();
    const observationOrdinals = new Set<number>();
    const nowAbsoluteMinute = (value.clock.day as number) * 1440 + (value.clock.minuteOfDay as number);
    for (const raw of value.incidentResponseOperations.operations as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed incidentResponseOperations entry.');
      assertId('incidentResponseOperations id', raw.id);
      assertId(`incidentResponseOperations ${String(raw.id)} teamId`, raw.teamId);
      assertId(`incidentResponseOperations ${String(raw.id)} contextKey`, raw.contextKey);
      assertId(`incidentResponseOperations ${String(raw.id)} incidentId`, raw.incidentId);
      if (operationIds.has(String(raw.id))) throw new Error(`Sandbox save contains duplicate incidentResponseOperations id: ${String(raw.id)}`);
      if (operationTeamIds.has(String(raw.teamId))) throw new Error(`Sandbox save contains multiple incidentResponseOperations for team ${String(raw.teamId)}.`);
      operationIds.add(String(raw.id));
      operationTeamIds.add(String(raw.teamId));
      const team = dispatchTeams.get(String(raw.teamId));
      if (!team) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} references unknown dispatch team.`);
      if (raw.contextKey !== team.contextKey || raw.incidentId !== team.incidentId) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} identity disagrees with its dispatch team.`);
      if (typeof team.dispatchOrdinal !== 'number' || String(raw.id) !== `incident-response:${team.dispatchOrdinal.toString(36)}`) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} operation identity is inconsistent.`);
      if (!['mobilizing','working','returning','completed','aborted'].includes(String(raw.phase))) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} phase is invalid.`);
      for (const field of ['startedAt','lastAdvancedAt','plannedMobilizationMinutes','plannedWorkMinutes','plannedReturnMinutes','mobilizationMinutesRemaining','workMinutesRemaining','returnMinutesRemaining'] as const) {
        const min = field.startsWith('planned') ? 1 : 0;
        assertInteger(`incidentResponseOperations ${String(raw.id)} ${field}`, raw[field], min, field.startsWith('planned') ? 1440 : undefined);
      }
      if ((raw.startedAt as number) < Number(team.dispatchedAt ?? 0)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} predates dispatch.`);
      if ((raw.lastAdvancedAt as number) < (raw.startedAt as number) || (raw.lastAdvancedAt as number) > nowAbsoluteMinute) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} advance time is invalid.`);
      if ((raw.mobilizationMinutesRemaining as number) > (raw.plannedMobilizationMinutes as number) || (raw.workMinutesRemaining as number) > (raw.plannedWorkMinutes as number) || (raw.returnMinutesRemaining as number) > (raw.plannedReturnMinutes as number)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} remaining work exceeds its plan.`);
      for (const field of ['arrivedAt','workCompletedAt','completedAt','abortedAt'] as const) if (raw[field] !== undefined) assertInteger(`incidentResponseOperations ${String(raw.id)} ${field}`, raw[field], 0, nowAbsoluteMinute);
      if (raw.arrivedAt !== undefined && (raw.arrivedAt as number) < (raw.startedAt as number)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} arrival time is invalid.`);
      if (raw.workCompletedAt !== undefined && (raw.arrivedAt === undefined || (raw.workCompletedAt as number) < (raw.arrivedAt as number))) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} work completion time is invalid.`);
      if (raw.completedAt !== undefined && (raw.workCompletedAt === undefined || (raw.completedAt as number) < (raw.workCompletedAt as number))) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} completion time is invalid.`);
      if (raw.abortedAt !== undefined && (raw.abortedAt as number) < (raw.startedAt as number)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} abort time is invalid.`);
      const phase = String(raw.phase);
      if (phase === 'mobilizing' && ((raw.mobilizationMinutesRemaining as number) <= 0 || (raw.workMinutesRemaining as number) !== (raw.plannedWorkMinutes as number) || (raw.returnMinutesRemaining as number) !== (raw.plannedReturnMinutes as number) || raw.arrivedAt !== undefined || raw.workCompletedAt !== undefined || raw.completedAt !== undefined || raw.abortedAt !== undefined)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} mobilizing state is inconsistent.`);
      if (phase === 'working' && ((raw.mobilizationMinutesRemaining as number) !== 0 || (raw.workMinutesRemaining as number) <= 0 || (raw.returnMinutesRemaining as number) !== (raw.plannedReturnMinutes as number) || raw.arrivedAt === undefined || raw.workCompletedAt !== undefined || raw.completedAt !== undefined || raw.abortedAt !== undefined)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} working state is inconsistent.`);
      if (phase === 'returning' && ((raw.mobilizationMinutesRemaining as number) !== 0 || (raw.workMinutesRemaining as number) !== 0 || (raw.returnMinutesRemaining as number) <= 0 || raw.arrivedAt === undefined || raw.workCompletedAt === undefined || raw.completedAt !== undefined || raw.abortedAt !== undefined)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} returning state is inconsistent.`);
      if (phase === 'completed' && ((raw.mobilizationMinutesRemaining as number) !== 0 || (raw.workMinutesRemaining as number) !== 0 || (raw.returnMinutesRemaining as number) !== 0 || raw.arrivedAt === undefined || raw.workCompletedAt === undefined || raw.completedAt === undefined || raw.abortedAt !== undefined)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} completed state is inconsistent.`);
      if (phase === 'aborted' && (raw.abortedAt === undefined || raw.completedAt !== undefined || (raw.lastAdvancedAt as number) !== (raw.abortedAt as number))) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} aborted state is inconsistent.`);
      if (['mobilizing','working','returning'].includes(phase) && team.phase !== 'dispatched') throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} is active without a dispatched team.`);
      if (['completed','aborted'].includes(phase) && team.phase !== 'stood-down') throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} is terminal without a stood-down team.`);
      if (phase === 'completed' && team.stoodDownAt !== raw.completedAt) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} completion disagrees with team stand-down.`);
      if (phase === 'aborted' && team.stoodDownAt !== raw.abortedAt) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} abort disagrees with team stand-down.`);
      if (!Array.isArray(raw.observations) || raw.observations.length > 8) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} has invalid observation history.`);
      const kinds = new Set<string>();
      let previousOrdinal = 0;
      for (const rawObservation of raw.observations as unknown[]) {
        if (!isRecord(rawObservation)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} has malformed observation.`);
        assertId(`incidentResponseOperations ${String(raw.id)} observation id`, rawObservation.id);
        assertInteger(`incidentResponseOperations ${String(raw.id)} observation ordinal`, rawObservation.ordinal, 1);
        assertInteger(`incidentResponseOperations ${String(raw.id)} observation observedAt`, rawObservation.observedAt, raw.startedAt as number, nowAbsoluteMinute);
        if (observationIds.has(String(rawObservation.id)) || observationOrdinals.has(rawObservation.ordinal as number)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} reuses an observation identity.`);
        if ((rawObservation.ordinal as number) <= previousOrdinal) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} observation order is invalid.`);
        if ((rawObservation.ordinal as number) >= (value.incidentResponseOperations.nextObservationOrdinal as number)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} references an unallocated observation ordinal.`);
        if (String(rawObservation.id) !== `incident-response-observation:${(rawObservation.ordinal as number).toString(36)}`) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} observation identity is inconsistent.`);
        const kind = String(rawObservation.kind);
        if (!['post-response-visibility','return-complete','team-unavailable','operator-stand-down'].includes(kind)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} observation kind is invalid.`);
        if (kinds.has(kind)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} duplicates observation kind ${kind}.`);
        kinds.add(kind);
        const visibility = String(rawObservation.incidentVisibility);
        if (!['visible','not-visible','not-checked'].includes(visibility)) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} observation visibility is invalid.`);
        if (kind === 'post-response-visibility' ? visibility === 'not-checked' : visibility !== 'not-checked') throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} observation visibility semantics are invalid.`);
        for (const forbidden of ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed']) if (rawObservation[forbidden] !== undefined) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} observation illegally persists outcome/presentation truth.`);
        observationIds.add(String(rawObservation.id));
        observationOrdinals.add(rawObservation.ordinal as number);
        previousOrdinal = rawObservation.ordinal as number;
      }
      for (const forbidden of ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed']) if (raw[forbidden] !== undefined) throw new Error(`Sandbox save incidentResponseOperations ${String(raw.id)} illegally persists outcome/presentation truth.`);
    }
    for (const rawTeam of dispatchTeamValues) {
      if (!isRecord(rawTeam) || rawTeam.phase !== 'dispatched') continue;
      if (!operationTeamIds.has(String(rawTeam.id))) throw new Error(`Sandbox save dispatched incident team ${String(rawTeam.id)} has no incidentResponseOperations entry.`);
    }
  }

  if (value.incidentResponseResources !== undefined) {
    if (!isRecord(value.incidentResponseResources) || value.incidentResponseResources.schemaVersion !== 1 || !Array.isArray(value.incidentResponseResources.reservations)) throw new Error('Sandbox save has invalid incidentResponseResources sidecar.');
    if (value.incidentResponseResources.reservations.length > 192) throw new Error('Sandbox save incidentResponseResources exceeds the bounded retention limit.');
    const operationValues = isRecord(value.incidentResponseOperations) && Array.isArray(value.incidentResponseOperations.operations) ? value.incidentResponseOperations.operations as unknown[] : [];
    if (operationValues.length === 0 && value.incidentResponseResources.reservations.length > 0) throw new Error('Sandbox save incidentResponseResources requires incidentResponseOperations state.');
    const operations = new Map<string, Record<string, unknown>>();
    for (const rawOperation of operationValues) if (isRecord(rawOperation) && typeof rawOperation.id === 'string') operations.set(rawOperation.id, rawOperation);
    const reservationIds = new Set<string>();
    const reservationOperationIds = new Set<string>();
    const amountKeys = ['food','water','medicine','tools'] as const;
    const near = (left: number, right: number) => Math.abs(left - right) <= 1e-6;
    for (const raw of value.incidentResponseResources.reservations as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed incidentResponseResources reservation.');
      assertId('incidentResponseResources reservation id', raw.id);
      assertId(`incidentResponseResources ${String(raw.id)} operationId`, raw.operationId);
      assertId(`incidentResponseResources ${String(raw.id)} teamId`, raw.teamId);
      assertId(`incidentResponseResources ${String(raw.id)} contextKey`, raw.contextKey);
      if (reservationIds.has(String(raw.id))) throw new Error(`Sandbox save contains duplicate incidentResponseResources id: ${String(raw.id)}`);
      if (reservationOperationIds.has(String(raw.operationId))) throw new Error(`Sandbox save contains multiple incidentResponseResources reservations for operation ${String(raw.operationId)}.`);
      reservationIds.add(String(raw.id)); reservationOperationIds.add(String(raw.operationId));
      const operation = operations.get(String(raw.operationId));
      if (!operation) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} references unknown response operation.`);
      if (raw.teamId !== operation.teamId || raw.contextKey !== operation.contextKey) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} identity disagrees with its operation.`);
      if (!['settlement','expedition'].includes(String(raw.sourceKind))) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} source kind is invalid.`);
      if (!['reserved','settled','legacy-unfunded'].includes(String(raw.phase))) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} phase is invalid.`);
      assertInteger(`incidentResponseResources ${String(raw.id)} reservedAt`, raw.reservedAt, 0);
      assertInteger(`incidentResponseResources ${String(raw.id)} lastUpdatedAt`, raw.lastUpdatedAt, raw.reservedAt as number);
      if (raw.settledAt !== undefined) assertInteger(`incidentResponseResources ${String(raw.id)} settledAt`, raw.settledAt, raw.reservedAt as number);
      if (raw.sourceKind === 'settlement') {
        if (raw.contextKey !== 'settlement' || raw.sourceExpeditionId !== undefined) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} settlement source identity is invalid.`);
      } else {
        assertId(`incidentResponseResources ${String(raw.id)} sourceExpeditionId`, raw.sourceExpeditionId);
        if (!expeditionIds.has(String(raw.sourceExpeditionId)) || raw.contextKey !== `expedition:${String(raw.sourceExpeditionId)}`) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} expedition source identity is invalid.`);
      }
      const amounts: Record<'reserved' | 'consumed' | 'returned', Record<'food' | 'water' | 'medicine' | 'tools', number>> = {
        reserved: { food: 0, water: 0, medicine: 0, tools: 0 },
        consumed: { food: 0, water: 0, medicine: 0, tools: 0 },
        returned: { food: 0, water: 0, medicine: 0, tools: 0 },
      };
      for (const field of ['reserved','consumed','returned'] as const) {
        if (!isRecord(raw[field])) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} ${field} is invalid.`);
        for (const key of amountKeys) { assertFinite(`incidentResponseResources ${String(raw.id)} ${field}.${key}`, raw[field][key], 0); amounts[field][key] = raw[field][key] as number; }
      }
      for (const key of amountKeys) {
        const reserved = amounts.reserved[key]; const consumed = amounts.consumed[key]; const returned = amounts.returned[key];
        if (consumed > reserved + 1e-6 || returned > reserved - consumed + 1e-6) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} over-accounts ${key}.`);
      }
      if (raw.heldLots !== undefined) {
        if (!isRecord(raw.heldLots) || raw.sourceKind!=='settlement') throw new Error('Invalid held resource lots.');
        const ledger=isRecord(value.resourceLedger)&&Array.isArray(value.resourceLedger.lots)?value.resourceLedger.lots:[];
        for (const key of amountKeys) {
          const lines=raw.heldLots[key];
          if (!Array.isArray(lines)) throw new Error('Missing held resource lot lines.');
          let sum=0; const ids=new Set<string>();
          for (const line of lines) {
            if (!isRecord(line) || typeof line.lotId!=='string' || ids.has(line.lotId)) throw new Error('Invalid held lot reference.');
            ids.add(line.lotId); assertFinite('held lot quantity',line.quantity,0); sum+=line.quantity as number;
            if (!ledger.some((lot)=>isRecord(lot)&&lot.id===line.lotId&&lot.resourceKey===(key==='tools'?'scrap':key))) throw new Error('Unknown or mismatched held lot.');
          }
          if (!isRecord(raw.reserved) || !near(sum,raw.reserved[key] as number)) throw new Error('Held lots disagree with reservation budget.');
        }
      }
      const phase = String(raw.phase); const operationPhase = String(operation.phase);
      if (phase === 'reserved') {
        if (!['mobilizing','working','returning'].includes(operationPhase) || raw.settledAt !== undefined) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} active reservation is inconsistent.`);
        for (const key of amountKeys) if (!near(amounts.returned[key], 0)) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} active reservation returns ${key} prematurely.`);
      }
      if (phase === 'settled') {
        if (!['completed','aborted'].includes(operationPhase) || typeof raw.settledAt !== 'number') throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} settled reservation is inconsistent.`);
        for (const key of amountKeys) if (!near(amounts.returned[key], amounts.reserved[key] - amounts.consumed[key])) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} settlement accounting is inconsistent for ${key}.`);
      }
      if (phase === 'legacy-unfunded') {
        if (raw.settledAt !== undefined) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} legacy reservation cannot have settledAt.`);
        for (const field of ['reserved','consumed','returned'] as const) for (const key of amountKeys) if (!near(amounts[field][key], 0)) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} legacy reservation must remain zero-budget.`);
      }
      if (phase !== 'legacy-unfunded' && String(raw.id) !== `incident-response-resource:${String(raw.teamId).split(':').at(-1)}`) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} reservation identity is inconsistent.`);
      for (const forbidden of ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed']) if (raw[forbidden] !== undefined) throw new Error(`Sandbox save incidentResponseResources ${String(raw.id)} illegally persists outcome/presentation truth.`);
    }
    for (const rawOperation of operationValues) {
      if (!isRecord(rawOperation) || typeof rawOperation.id !== 'string') continue;
      if (!reservationOperationIds.has(rawOperation.id)) throw new Error(`Sandbox save response operation ${rawOperation.id} has no incidentResponseResources reservation.`);
    }
  }

  const incidentEvidenceUseNowAbsoluteMinute = (value.clock.day as number) * 1440 + (value.clock.minuteOfDay as number);
  if (value.incidentResponseEvidenceUses !== undefined) {
    if (!isRecord(value.incidentResponseEvidenceUses) || value.incidentResponseEvidenceUses.schemaVersion !== 1 || !Array.isArray(value.incidentResponseEvidenceUses.uses)) throw new Error('Sandbox save has invalid incidentResponseEvidenceUses sidecar.');
    assertInteger('incidentResponseEvidenceUses.nextUseOrdinal', value.incidentResponseEvidenceUses.nextUseOrdinal, 1);
    if (value.incidentResponseEvidenceUses.uses.length > 192) throw new Error('Sandbox save incidentResponseEvidenceUses exceeds the bounded retention limit.');
    const evidenceUseRows = value.incidentResponseEvidenceUses.uses as unknown[];
    if (evidenceUseRows.length > 0 && (!isRecord(value.incidentResponseOperations) || !Array.isArray(value.incidentResponseOperations.operations))) throw new Error('Sandbox save incidentResponseEvidenceUses requires incidentResponseOperations state.');
    if (evidenceUseRows.length > 0 && (!isRecord(value.incidentResponseResources) || !Array.isArray(value.incidentResponseResources.reservations))) throw new Error('Sandbox save incidentResponseEvidenceUses requires incidentResponseResources state.');
    if (evidenceUseRows.length > 0 && (!isRecord(value.incidentLedger) || !Array.isArray(value.incidentLedger.entries))) throw new Error('Sandbox save incidentResponseEvidenceUses requires incidentLedger state.');

    const operationRows = isRecord(value.incidentResponseOperations) && Array.isArray(value.incidentResponseOperations.operations) ? value.incidentResponseOperations.operations as unknown[] : [];
    const resourceRows = isRecord(value.incidentResponseResources) && Array.isArray(value.incidentResponseResources.reservations) ? value.incidentResponseResources.reservations as unknown[] : [];
    const ledgerRows = isRecord(value.incidentLedger) && Array.isArray(value.incidentLedger.entries) ? value.incidentLedger.entries as unknown[] : [];
    const operations = new Map<string, Record<string, unknown>>();
    for (const raw of operationRows) if (isRecord(raw) && typeof raw.id === 'string') operations.set(raw.id, raw);
    const reservations = new Map<string, Record<string, unknown>>();
    for (const raw of resourceRows) if (isRecord(raw) && typeof raw.id === 'string') reservations.set(raw.id, raw);
    const ledgers = new Map<string, Record<string, unknown>>();
    for (const raw of ledgerRows) if (isRecord(raw) && typeof raw.contextKey === 'string' && typeof raw.incidentId === 'string') ledgers.set(`${raw.contextKey}|${raw.incidentId}`, raw);

    const allowedKinds = new Set(['settlement-resource-threshold','recorded-case-cleared','field-health-threshold','field-fatigue-threshold','field-supply-threshold','communication-restored','encounter-resolved','research-sample-present','provider-return-observed']);
    const medicineKinds = new Set(['recorded-case-cleared','field-health-threshold']);
    const toolKinds = new Set(['communication-restored','encounter-resolved','research-sample-present']);
    const useIds = new Set<string>();
    const useOrdinals = new Set<number>();
    const pairKeys = new Set<string>();
    const usedByReservation = new Map<string, { medicine: number; tools: number }>();
    let maxUseOrdinal = 0;
    for (const raw of evidenceUseRows) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed incidentResponseEvidenceUses entry.');
      assertId('incidentResponseEvidenceUses id', raw.id);
      assertInteger(`incidentResponseEvidenceUses ${String(raw.id)} ordinal`, raw.ordinal, 1);
      assertId(`incidentResponseEvidenceUses ${String(raw.id)} operationId`, raw.operationId);
      assertId(`incidentResponseEvidenceUses ${String(raw.id)} reservationId`, raw.reservationId);
      assertId(`incidentResponseEvidenceUses ${String(raw.id)} contextKey`, raw.contextKey);
      assertId(`incidentResponseEvidenceUses ${String(raw.id)} incidentId`, raw.incidentId);
      assertId(`incidentResponseEvidenceUses ${String(raw.id)} evidenceId`, raw.evidenceId);
      if (!allowedKinds.has(String(raw.evidenceKind))) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} evidence kind is invalid.`);
      assertInteger(`incidentResponseEvidenceUses ${String(raw.id)} evidenceOccurrenceNumber`, raw.evidenceOccurrenceNumber, 1);
      assertInteger(`incidentResponseEvidenceUses ${String(raw.id)} recordedAt`, raw.recordedAt, 0, incidentEvidenceUseNowAbsoluteMinute);
      assertFinite(`incidentResponseEvidenceUses ${String(raw.id)} medicine`, raw.medicine, 0);
      assertFinite(`incidentResponseEvidenceUses ${String(raw.id)} tools`, raw.tools, 0);
      if ((raw.medicine as number) <= 1e-9 && (raw.tools as number) <= 1e-9) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} has no bounded resource use.`);
      if ((raw.medicine as number) > 1e-9 && !medicineKinds.has(String(raw.evidenceKind))) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} evidence kind does not authorize medicine.`);
      if ((raw.tools as number) > 1e-9 && !toolKinds.has(String(raw.evidenceKind))) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} evidence kind does not authorize tools.`);
      if (useIds.has(String(raw.id)) || useOrdinals.has(raw.ordinal as number)) throw new Error(`Sandbox save incidentResponseEvidenceUses reuses an identity.`);
      useIds.add(String(raw.id)); useOrdinals.add(raw.ordinal as number); maxUseOrdinal = Math.max(maxUseOrdinal, raw.ordinal as number);
      if (String(raw.id) !== `incident-response-evidence-use:${(raw.ordinal as number).toString(36)}`) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} identity is inconsistent.`);
      if ((raw.ordinal as number) >= (value.incidentResponseEvidenceUses.nextUseOrdinal as number)) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} references an unallocated ordinal.`);

      const operation = operations.get(String(raw.operationId));
      const reservation = reservations.get(String(raw.reservationId));
      if (!operation || operation.phase !== 'completed') throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} requires a completed response operation.`);
      if (!reservation || reservation.phase !== 'settled') throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} requires a settled response reservation.`);
      if (reservation.operationId !== raw.operationId || operation.contextKey !== raw.contextKey || operation.incidentId !== raw.incidentId || reservation.contextKey !== raw.contextKey) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} cross-reference identity is inconsistent.`);

      const ledgerKey = `${String(raw.contextKey)}|${String(raw.incidentId)}`;
      const ledger = ledgers.get(ledgerKey);
      if (!ledger) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} references unknown Incident lifecycle.`);
      if ((raw.evidenceOccurrenceNumber as number) > Number(ledger.occurrenceCount ?? 0)) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} references a future evidence occurrence.`);
      const expectedEvidenceId = `incident-resolution-evidence:${(raw.evidenceOccurrenceNumber as number).toString(36)}:${ledgerKey}`;
      if (raw.evidenceId !== expectedEvidenceId) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} evidence identity is inconsistent.`);
      if (isRecord(ledger.lastResolutionEvidence) && ledger.lastResolutionEvidence.occurrenceNumber === raw.evidenceOccurrenceNumber) {
        if (ledger.lastResolutionEvidence.id !== raw.evidenceId || ledger.lastResolutionEvidence.kind !== raw.evidenceKind) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} disagrees with current positive evidence.`);
      }
      const pairKey = `${String(raw.operationId)}|${String(raw.evidenceId)}`;
      if (pairKeys.has(pairKey)) throw new Error(`Sandbox save incidentResponseEvidenceUses duplicates operation/evidence reconciliation.`);
      pairKeys.add(pairKey);
      const totals = usedByReservation.get(String(raw.reservationId)) ?? { medicine: 0, tools: 0 };
      totals.medicine += raw.medicine as number;
      totals.tools += raw.tools as number;
      usedByReservation.set(String(raw.reservationId), totals);
      for (const forbidden of ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed','responseSucceeded','causedResolution']) if (raw[forbidden] !== undefined) throw new Error(`Sandbox save incidentResponseEvidenceUses ${String(raw.id)} illegally persists outcome/presentation truth.`);
    }
    if ((value.incidentResponseEvidenceUses.nextUseOrdinal as number) <= maxUseOrdinal) throw new Error('Sandbox save incidentResponseEvidenceUses next ordinal does not advance beyond retained uses.');

    for (const [reservationId, reservation] of reservations) {
      if (!isRecord(reservation.consumed)) continue;
      const totals = usedByReservation.get(reservationId) ?? { medicine: 0, tools: 0 };
      const consumedMedicine = Number(reservation.consumed.medicine ?? 0);
      const consumedTools = Number(reservation.consumed.tools ?? 0);
      if (Math.abs(consumedMedicine - totals.medicine) > 1e-6 || Math.abs(consumedTools - totals.tools) > 1e-6) throw new Error(`Sandbox save incidentResponseEvidenceUses does not reconcile medicine/tools consumption for ${reservationId}.`);
    }
  } else if (isRecord(value.incidentResponseResources) && Array.isArray(value.incidentResponseResources.reservations)) {
    for (const raw of value.incidentResponseResources.reservations as unknown[]) {
      if (!isRecord(raw) || !isRecord(raw.consumed)) continue;
      if (Number(raw.consumed.medicine ?? 0) > 1e-9 || Number(raw.consumed.tools ?? 0) > 1e-9) throw new Error('Sandbox save with medicine/tools response consumption requires incidentResponseEvidenceUses provenance.');
    }
  }

  if (value.incidentResponseDebriefs !== undefined) {
    if (!isRecord(value.incidentResponseDebriefs) || value.incidentResponseDebriefs.schemaVersion !== 1 || !Array.isArray(value.incidentResponseDebriefs.debriefs)) throw new Error('Sandbox save has invalid incidentResponseDebriefs sidecar.');
    if (value.incidentResponseDebriefs.debriefs.length > 192) throw new Error('Sandbox save incidentResponseDebriefs exceeds the bounded retention limit.');
    const debriefRows = value.incidentResponseDebriefs.debriefs as unknown[];
    const operationRows = isRecord(value.incidentResponseOperations) && Array.isArray(value.incidentResponseOperations.operations) ? value.incidentResponseOperations.operations as unknown[] : [];
    const teamRows = isRecord(value.incidentDispatch) && Array.isArray(value.incidentDispatch.teams) ? value.incidentDispatch.teams as unknown[] : [];
    const reservationRows = isRecord(value.incidentResponseResources) && Array.isArray(value.incidentResponseResources.reservations) ? value.incidentResponseResources.reservations as unknown[] : [];
    const useRows = isRecord(value.incidentResponseEvidenceUses) && Array.isArray(value.incidentResponseEvidenceUses.uses) ? value.incidentResponseEvidenceUses.uses as unknown[] : [];
    const ledgerRows = isRecord(value.incidentLedger) && Array.isArray(value.incidentLedger.entries) ? value.incidentLedger.entries as unknown[] : [];
    if (debriefRows.length > 0 && (operationRows.length === 0 || teamRows.length === 0)) throw new Error('Sandbox save incidentResponseDebriefs requires response operation and dispatch state.');
    const operations = new Map<string, Record<string, unknown>>();
    for (const raw of operationRows) if (isRecord(raw) && typeof raw.id === 'string') operations.set(raw.id, raw);
    const teams = new Map<string, Record<string, unknown>>();
    for (const raw of teamRows) if (isRecord(raw) && typeof raw.id === 'string') teams.set(raw.id, raw);
    const reservationsByOperation = new Map<string, Record<string, unknown>>();
    for (const raw of reservationRows) if (isRecord(raw) && typeof raw.operationId === 'string') reservationsByOperation.set(raw.operationId, raw);
    const usesByOperation = new Map<string, Record<string, unknown>[]>();
    for (const raw of useRows) {
      if (!isRecord(raw) || typeof raw.operationId !== 'string') continue;
      const rows = usesByOperation.get(raw.operationId) ?? [];
      rows.push(raw);
      usesByOperation.set(raw.operationId, rows);
    }
    for (const rows of usesByOperation.values()) rows.sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0));
    const ledgers = new Map<string, Record<string, unknown>>();
    for (const raw of ledgerRows) if (isRecord(raw) && typeof raw.contextKey === 'string' && typeof raw.incidentId === 'string') ledgers.set(`${raw.contextKey}|${raw.incidentId}`, raw);
    const debriefIds = new Set<string>();
    const debriefOperationIds = new Set<string>();
    const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const forbiddenDebriefFields = ['title','summary','detail','text','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed','responseSucceeded','causedResolution','interpretation','causalAssessment'];

    for (const raw of debriefRows) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed incidentResponseDebriefs entry.');
      assertId('incidentResponseDebriefs id', raw.id);
      assertId(`incidentResponseDebriefs ${String(raw.id)} operationId`, raw.operationId);
      assertId(`incidentResponseDebriefs ${String(raw.id)} teamId`, raw.teamId);
      assertId(`incidentResponseDebriefs ${String(raw.id)} contextKey`, raw.contextKey);
      assertId(`incidentResponseDebriefs ${String(raw.id)} incidentId`, raw.incidentId);
      if (debriefIds.has(String(raw.id)) || debriefOperationIds.has(String(raw.operationId))) throw new Error(`Sandbox save incidentResponseDebriefs reuses a debrief identity.`);
      debriefIds.add(String(raw.id)); debriefOperationIds.add(String(raw.operationId));
      const operation = operations.get(String(raw.operationId));
      const team = teams.get(String(raw.teamId));
      if (!operation || !['completed','aborted'].includes(String(operation.phase))) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} requires a terminal response operation.`);
      if (!team || team.phase !== 'stood-down') throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} requires a stood-down dispatch team.`);
      if (operation.teamId !== raw.teamId || operation.contextKey !== raw.contextKey || operation.incidentId !== raw.incidentId || team.contextKey !== raw.contextKey || team.incidentId !== raw.incidentId) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} cross-reference identity is inconsistent.`);
      const operationSuffix = String(raw.operationId).startsWith('incident-response:') ? String(raw.operationId).slice('incident-response:'.length) : String(raw.operationId);
      if (raw.id !== `incident-response-debrief:${operationSuffix}`) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} identity is inconsistent.`);
      if (!['completed','aborted'].includes(String(raw.terminalPhase)) || raw.terminalPhase !== operation.phase) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} terminal phase is inconsistent.`);
      const terminalAt = operation.phase === 'completed' ? operation.completedAt : operation.abortedAt;
      assertInteger(`incidentResponseDebriefs ${String(raw.id)} generatedAt`, raw.generatedAt, 0, incidentEvidenceUseNowAbsoluteMinute);
      assertInteger(`incidentResponseDebriefs ${String(raw.id)} lastRefreshedAt`, raw.lastRefreshedAt, 0, incidentEvidenceUseNowAbsoluteMinute);
      if (raw.generatedAt !== terminalAt) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} generation time must equal the operation terminal time.`);
      if (!Array.isArray(raw.memberIds) || raw.memberIds.length < 1 || raw.memberIds.length > 4 || raw.memberIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(raw.memberIds as string[]).size !== raw.memberIds.length) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} members are invalid.`);
      const expectedMembers = Array.isArray(team.memberIds) ? [...team.memberIds].map(String).sort() : [];
      if (!sameJson(raw.memberIds, expectedMembers)) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} members disagree with dispatch.`);
      if (!isRecord(raw.chronology)) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} chronology is invalid.`);
      assertInteger(`incidentResponseDebriefs ${String(raw.id)} chronology.startedAt`, raw.chronology.startedAt, 0, incidentEvidenceUseNowAbsoluteMinute);
      assertInteger(`incidentResponseDebriefs ${String(raw.id)} chronology.terminalAt`, raw.chronology.terminalAt, 0, incidentEvidenceUseNowAbsoluteMinute);
      for (const field of ['arrivedAt','workCompletedAt'] as const) if (raw.chronology[field] !== undefined) assertInteger(`incidentResponseDebriefs ${String(raw.id)} chronology.${field}`, raw.chronology[field], 0, incidentEvidenceUseNowAbsoluteMinute);
      const expectedChronology = {
        startedAt: operation.startedAt,
        ...(operation.arrivedAt !== undefined ? { arrivedAt: operation.arrivedAt } : {}),
        ...(operation.workCompletedAt !== undefined ? { workCompletedAt: operation.workCompletedAt } : {}),
        terminalAt,
      };
      if (!sameJson(raw.chronology, expectedChronology)) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} chronology disagrees with its operation.`);
      if (!Array.isArray(raw.observations) || !sameJson(raw.observations, operation.observations ?? [])) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} observations disagree with its operation.`);

      const ledger = ledgers.get(`${String(raw.contextKey)}|${String(raw.incidentId)}`);
      const currentEvidence = ledger && isRecord(ledger.lastResolutionEvidence) && Array.isArray(ledger.lastResolutionEvidence.supportingOperationIds) && ledger.lastResolutionEvidence.supportingOperationIds.includes(raw.operationId)
        ? ledger.lastResolutionEvidence
        : null;
      const expectedEvidence = currentEvidence ? [currentEvidence] : [];
      if (!Array.isArray(raw.positiveEvidence) || raw.positiveEvidence.length > 1 || !sameJson(raw.positiveEvidence, expectedEvidence)) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} positive evidence is not an observer-safe current projection.`);
      const expectedUses = usesByOperation.get(String(raw.operationId)) ?? [];
      if (!Array.isArray(raw.evidenceResourceUses) || !sameJson(raw.evidenceResourceUses, expectedUses)) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} evidence resource-use facts disagree with I2-G provenance.`);
      const expectedReservation = reservationsByOperation.get(String(raw.operationId));
      if (expectedReservation ? !isRecord(raw.resourceReservation) || !sameJson(raw.resourceReservation, expectedReservation) : raw.resourceReservation !== undefined) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} resource accounting disagrees with I2-E reservation state.`);
      const refreshCandidates = [Number(terminalAt ?? 0)];
      if (Array.isArray(operation.observations)) for (const observation of operation.observations) if (isRecord(observation) && typeof observation.observedAt === 'number') refreshCandidates.push(observation.observedAt);
      if (expectedReservation && typeof expectedReservation.lastUpdatedAt === 'number') refreshCandidates.push(expectedReservation.lastUpdatedAt);
      for (const use of expectedUses) if (typeof use.recordedAt === 'number') refreshCandidates.push(use.recordedAt);
      if (currentEvidence && typeof currentEvidence.observedAt === 'number') refreshCandidates.push(currentEvidence.observedAt);
      const expectedRefreshedAt = Math.max(...refreshCandidates);
      if (raw.lastRefreshedAt !== expectedRefreshedAt) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} refresh time is inconsistent with source facts.`);
      for (const forbidden of forbiddenDebriefFields) if (raw[forbidden] !== undefined) throw new Error(`Sandbox save incidentResponseDebriefs ${String(raw.id)} illegally persists narrative/outcome truth.`);
    }
    for (const raw of operationRows) {
      if (!isRecord(raw) || !['completed','aborted'].includes(String(raw.phase))) continue;
      if (!debriefOperationIds.has(String(raw.id))) throw new Error(`Sandbox save terminal response operation ${String(raw.id)} has no I2-H incidentResponseDebriefs projection.`);
    }
  }

  if (value.incidentResponseReadiness !== undefined) {
    if (!isRecord(value.incidentResponseReadiness) || value.incidentResponseReadiness.schemaVersion !== 1 || !Array.isArray(value.incidentResponseReadiness.entries)) throw new Error('Sandbox save has invalid incidentResponseReadiness sidecar.');
    assertInteger('incidentResponseReadiness.policyActivatedAt', value.incidentResponseReadiness.policyActivatedAt, 0, incidentEvidenceUseNowAbsoluteMinute);
    if (value.incidentResponseReadiness.entries.length > 256) throw new Error('Sandbox save incidentResponseReadiness exceeds the bounded retention limit.');
    const operationRows = isRecord(value.incidentResponseOperations) && Array.isArray(value.incidentResponseOperations.operations) ? value.incidentResponseOperations.operations as unknown[] : [];
    const teamRows = isRecord(value.incidentDispatch) && Array.isArray(value.incidentDispatch.teams) ? value.incidentDispatch.teams as unknown[] : [];
    const operations = new Map<string, Record<string, unknown>>();
    const teams = new Map<string, Record<string, unknown>>();
    for (const raw of operationRows) if (isRecord(raw) && typeof raw.id === 'string') operations.set(raw.id, raw);
    for (const raw of teamRows) if (isRecord(raw) && typeof raw.id === 'string') teams.set(raw.id, raw);
    const policyActivatedAt = value.incidentResponseReadiness.policyActivatedAt as number;
    const expectedByMember = new Map<string, Record<string, unknown>>();
    for (const operation of operations.values()) {
      if (!['completed','aborted'].includes(String(operation.phase))) continue;
      const terminalAt = operation.phase === 'completed' ? operation.completedAt : operation.abortedAt;
      if (typeof terminalAt !== 'number' || terminalAt <= policyActivatedAt) continue;
      const team = teams.get(String(operation.teamId));
      if (!team || !Array.isArray(team.memberIds)) continue;
      const dutyMinutes = Math.max(0, terminalAt - Number(operation.startedAt ?? terminalAt));
      const recoveryUntil = terminalAt + incidentResponseRecoveryMinutes(dutyMinutes);
      if (recoveryUntil <= incidentEvidenceUseNowAbsoluteMinute) continue;
      for (const rawMemberId of team.memberIds) {
        const memberId = String(rawMemberId);
        const entry = { memberId, operationId: String(operation.id), contextKey: String(operation.contextKey), dutyMinutes, recoveryStartedAt: terminalAt, recoveryUntil };
        const previous = expectedByMember.get(memberId);
        if (!previous || recoveryUntil > Number(previous.recoveryUntil) || (recoveryUntil === Number(previous.recoveryUntil) && String(operation.id) > String(previous.operationId))) expectedByMember.set(memberId, entry);
      }
    }
    const expected = [...expectedByMember.values()].sort((left, right) => Number(left.recoveryUntil) - Number(right.recoveryUntil) || String(left.memberId).localeCompare(String(right.memberId)));
    const seenMembers = new Set<string>();
    for (const raw of value.incidentResponseReadiness.entries as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed incidentResponseReadiness entry.');
      assertId('incidentResponseReadiness memberId', raw.memberId);
      assertId(`incidentResponseReadiness ${String(raw.memberId)} operationId`, raw.operationId);
      assertId(`incidentResponseReadiness ${String(raw.memberId)} contextKey`, raw.contextKey);
      assertInteger(`incidentResponseReadiness ${String(raw.memberId)} dutyMinutes`, raw.dutyMinutes, 0);
      assertInteger(`incidentResponseReadiness ${String(raw.memberId)} recoveryStartedAt`, raw.recoveryStartedAt, 0, incidentEvidenceUseNowAbsoluteMinute);
      assertInteger(`incidentResponseReadiness ${String(raw.memberId)} recoveryUntil`, raw.recoveryUntil, 0);
      if (!agentIds.has(String(raw.memberId))) throw new Error(`Sandbox save incidentResponseReadiness references unknown member ${String(raw.memberId)}.`);
      if (seenMembers.has(String(raw.memberId))) throw new Error(`Sandbox save incidentResponseReadiness duplicates member ${String(raw.memberId)}.`);
      seenMembers.add(String(raw.memberId));
      if ((raw.recoveryUntil as number) <= incidentEvidenceUseNowAbsoluteMinute) throw new Error(`Sandbox save incidentResponseReadiness retains expired recovery for ${String(raw.memberId)}.`);
      for (const forbidden of ['title','summary','detail','presentation','outcome','success','failure','resolved','causeConfirmed','fatigue','task']) if (raw[forbidden] !== undefined) throw new Error(`Sandbox save incidentResponseReadiness ${String(raw.memberId)} illegally persists outcome/general-agent truth.`);
    }
    if (JSON.stringify(value.incidentResponseReadiness.entries) !== JSON.stringify(expected)) throw new Error('Sandbox save incidentResponseReadiness does not match terminal response chronology.');
  }

  assertUniqueIdRecords('pregnancy', value.pregnancies as unknown[]);
  for (const raw of value.pregnancies as unknown[]) {
    const pregnancy = raw as Record<string, unknown>;
    if (!Array.isArray(pregnancy.parentIds) || pregnancy.parentIds.length !== 2 || pregnancy.parentIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save pregnancy ${String(pregnancy.id)} has invalid parents.`);
    if (typeof pregnancy.pregnantAgentId !== 'string' || !agentIds.has(pregnancy.pregnantAgentId)) throw new Error(`Sandbox save pregnancy ${String(pregnancy.id)} has unknown pregnant agent.`);
    assertInteger(`pregnancy ${String(pregnancy.id)} conceptionDay`, pregnancy.conceptionDay);
    assertInteger(`pregnancy ${String(pregnancy.id)} expectedDay`, pregnancy.expectedDay);
  }

  const encounterIds = assertUniqueIdRecords('encounter', value.encounters as unknown[]);
  void encounterIds;
  for (const raw of value.encounters as unknown[]) {
    const encounter = raw as Record<string, unknown>;
    if (typeof encounter.expeditionId !== 'string' || !expeditionIds.has(encounter.expeditionId)) throw new Error(`Sandbox save encounter ${String(encounter.id)} references unknown expedition.`);
    assertInteger(`encounter ${String(encounter.id)} width`, encounter.width, 1);
    assertInteger(`encounter ${String(encounter.id)} height`, encounter.height, 1);
    if (!Array.isArray(encounter.actors) || !Array.isArray(encounter.queue) || !Array.isArray(encounter.log) || !Array.isArray(encounter.casualties)) throw new Error(`Sandbox save encounter ${String(encounter.id)} is incomplete.`);
  }

  assertUniqueIdRecords('external actor', (value.externalActors as unknown[]).map((entry, index) => isRecord(entry) && typeof entry.entityId === 'string' ? { id: entry.entityId, ...entry } : { id: `invalid-external-${index}` }));
  for (const raw of value.externalActors as unknown[]) {
    const actor = raw as Record<string, unknown>;
    if (typeof actor.entityId !== 'string' || typeof actor.kind !== 'string' || typeof actor.name !== 'string') throw new Error('Sandbox save has malformed external actor projection.');
    assertFinite(`external actor ${actor.entityId} confidence`, actor.confidence, 0, 1);
    assertFinite(`external actor ${actor.entityId} localTrust`, actor.localTrust, -100, 100);
    assertFinite(`external actor ${actor.entityId} tradeExperience`, actor.tradeExperience, 0);
    assertFinite(`external actor ${actor.entityId} migrationBalance`, actor.migrationBalance, -100000, 100000);
    assertFinite(`external actor ${actor.entityId} conflictPressure`, actor.conflictPressure, 0, 100);
    for (const field of ['provenanceIds','fineActorIds','relationshipIds'] as const) {
      if (actor[field] !== undefined && (!Array.isArray(actor[field]) || (actor[field] as unknown[]).some((id) => typeof id !== 'string' || id.trim().length === 0))) throw new Error(`Sandbox save external actor ${actor.entityId} has invalid ${field}.`);
    }
    if (actor.effectiveDetailRank !== undefined) assertInteger(`external actor ${actor.entityId} effectiveDetailRank`, actor.effectiveDetailRank, 0);
  }

  if ((value as Record<string, unknown>).externalConflictObservations !== undefined) {
    if (!Array.isArray(value.externalConflictObservations)) throw new Error('Sandbox save externalConflictObservations must be an array when present.');
    const observationIds = new Set<string>();
    for (const raw of value.externalConflictObservations as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed external conflict observation.');
      assertId('external conflict observation id', raw.id); const id=String(raw.id);
      if (observationIds.has(id)) throw new Error(`Sandbox save has duplicate external conflict observation ${id}.`); observationIds.add(id);
      assertId(`external conflict observation ${id} sourceEntityId`, raw.sourceEntityId);
      assertId(`external conflict observation ${id} providerSourceId`, raw.providerSourceId);
      assertInteger(`external conflict observation ${id} providerTick`, raw.providerTick, 0);
      assertInteger(`external conflict observation ${id} day`, raw.day, 1);
      assertInteger(`external conflict observation ${id} minuteOfDay`, raw.minuteOfDay, 0);
      if (!['violence','route-disruption','displacement','resource-loss','recovery'].includes(String(raw.kind))) throw new Error(`Sandbox save external conflict observation ${id} has invalid kind.`);
      assertFinite(`external conflict observation ${id} severity`, raw.severity, 0, 100);
      for (const field of ['injuredIndividualIds','displacedIndividualIds','affectedRouteEntityIds','provenanceIds']) {
        if (!Array.isArray(raw[field]) || (raw[field] as unknown[]).some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error(`Sandbox save external conflict observation ${id} has invalid ${field}.`);
      }
      if (raw.routePassability !== undefined && !['unknown','degraded','impassable'].includes(String(raw.routePassability))) throw new Error(`Sandbox save external conflict observation ${id} has invalid routePassability.`);
      if (raw.displacedHouseholdIds !== undefined && (!Array.isArray(raw.displacedHouseholdIds) || (raw.displacedHouseholdIds as unknown[]).some((entry) => typeof entry !== 'string' || !entry.trim()))) throw new Error(`Sandbox save external conflict observation ${id} has invalid displacedHouseholdIds.`);
      if (raw.returnedToSettlementIndividualIds !== undefined && (!Array.isArray(raw.returnedToSettlementIndividualIds) || (raw.returnedToSettlementIndividualIds as unknown[]).some((entry) => typeof entry !== 'string' || !entry.trim()))) throw new Error(`Sandbox save external conflict observation ${id} has invalid returnedToSettlementIndividualIds.`);
      if (raw.returnedToSettlementHouseholdIds !== undefined && (!Array.isArray(raw.returnedToSettlementHouseholdIds) || (raw.returnedToSettlementHouseholdIds as unknown[]).some((entry) => typeof entry !== 'string' || !entry.trim()))) throw new Error(`Sandbox save external conflict observation ${id} has invalid returnedToSettlementHouseholdIds.`);
      if (!isRecord(raw.resourceLoss)) throw new Error(`Sandbox save external conflict observation ${id} has invalid resourceLoss.`);
      for (const [key, amount] of Object.entries(raw.resourceLoss)) {
        if (!['food','water','medicine','timber','scrap','fuel','cloth','records'].includes(key) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error(`Sandbox save external conflict observation ${id} has invalid resource loss entry ${key}.`);
      }
      if (raw.location !== undefined) {
        if (!isRecord(raw.location) || typeof raw.location.frameId !== 'string' || typeof raw.location.x !== 'number' || typeof raw.location.y !== 'number') throw new Error(`Sandbox save external conflict observation ${id} has invalid location.`);
      }
    }
  }

  if ((value as Record<string, unknown>).externalContacts !== undefined) {
    if (!Array.isArray(value.externalContacts)) throw new Error('Sandbox save externalContacts must be an array when present.');
    const contactIds = new Set<string>();
    for (const raw of value.externalContacts as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has malformed external person contact.');
      assertId('external contact externalPersonId', raw.externalPersonId); const id=String(raw.externalPersonId);
      if (contactIds.has(id)) throw new Error(`Sandbox save has duplicate external contact ${id}.`); contactIds.add(id);
      if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error(`Sandbox save external contact ${id} has invalid name.`);
      if (raw.societyEntityId !== undefined) assertId(`external contact ${id} societyEntityId`, raw.societyEntityId);
      if (!Array.isArray(raw.provenanceIds) || raw.provenanceIds.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error(`Sandbox save external contact ${id} has invalid provenance.`);
      for (const field of ['firstContactDay','firstContactMinute','lastContactDay','lastContactMinute','interactionCount']) assertInteger(`external contact ${id} ${field}`, raw[field], 0);
      if (!Array.isArray(raw.speakerIds) || raw.speakerIds.some((entry) => typeof entry !== 'string' || !agentIds.has(entry))) throw new Error(`Sandbox save external contact ${id} has invalid speakers.`);
      if (!Array.isArray(raw.knowledgeIds) || raw.knowledgeIds.some((entry) => typeof entry !== 'string')) throw new Error(`Sandbox save external contact ${id} has invalid knowledge ids.`);
    }
  }

  assertUniqueIdRecords('chronicle', value.chronicle as unknown[]);
  for (const raw of value.chronicle as unknown[]) {
    const entry = raw as Record<string, unknown>;
    const epistemic = entry.epistemic;
    if (epistemic === undefined) continue;
    if (!isRecord(epistemic)) throw new Error(`Sandbox save chronicle ${String(entry.id)} has invalid epistemic metadata.`);
    if (!['settlement-visible','expedition-internal'].includes(String(epistemic.scope))) throw new Error(`Sandbox save chronicle ${String(entry.id)} has invalid epistemic scope.`);
    if (!Array.isArray(epistemic.witnessedByAgentIds) || epistemic.witnessedByAgentIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save chronicle ${String(entry.id)} has invalid witnesses.`);
    if (typeof epistemic.reportableToSettlement !== 'boolean' || typeof epistemic.settlementVisible !== 'boolean') throw new Error(`Sandbox save chronicle ${String(entry.id)} has invalid visibility flags.`);
    if (!Array.isArray(epistemic.revealSourceIds) || epistemic.revealSourceIds.some((id) => typeof id !== 'string')) throw new Error(`Sandbox save chronicle ${String(entry.id)} has invalid reveal provenance.`);
    if (epistemic.scope === 'expedition-internal' && (typeof epistemic.expeditionId !== 'string' || !expeditionIds.has(epistemic.expeditionId))) throw new Error(`Sandbox save chronicle ${String(entry.id)} references unknown expedition visibility scope.`);
  }
  let physicalInventoryIds = new Set<string>();
  if (value.directPlay !== undefined) {
    if (!isRecord(value.directPlay)) throw new Error('Sandbox save has invalid direct-play state.');
    for (const key of ['equipmentInitializedAgentIds','equipment','inventory','directActivities']) if (!Array.isArray(value.directPlay[key])) throw new Error(`Sandbox save direct-play state is missing ${key}.`);
    if ((value.directPlay.equipmentInitializedAgentIds as unknown[]).some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error('Sandbox save direct-play equipment initialization references an unknown agent.');
    const equipmentIds = assertUniqueIdRecords('equipment', value.directPlay.equipment as unknown[]);
    for (const raw of value.directPlay.equipment as unknown[]) {
      const item = raw as Record<string, unknown>;
      if (typeof item.ownerId !== 'string' || !agentIds.has(item.ownerId)) throw new Error(`Sandbox save equipment ${String(item.id)} has invalid owner.`);
      if (!['body','outer','hands','feet','tool'].includes(String(item.slot))) throw new Error(`Sandbox save equipment ${String(item.id)} has invalid slot.`);
      if (typeof item.equipped !== 'boolean' || typeof item.name !== 'string') throw new Error(`Sandbox save equipment ${String(item.id)} is malformed.`);
      assertFinite(`equipment ${String(item.id)} weightKg`, item.weightKg, 0);
      if (!isRecord(item.skillBonuses) || !Array.isArray(item.provenanceIds)) throw new Error(`Sandbox save equipment ${String(item.id)} is missing bonuses/provenance.`);
    }
    physicalInventoryIds = assertUniqueIdRecords('physical inventory', value.directPlay.inventory as unknown[]);
    for (const raw of value.directPlay.inventory as unknown[]) {
      const item = raw as Record<string, unknown>;
      if (typeof item.ownerId !== 'string' || !agentIds.has(item.ownerId)) throw new Error(`Sandbox save physical inventory ${String(item.id)} has invalid owner.`);
      if (!['sample','resource','tool','record','personal'].includes(String(item.kind)) || typeof item.name !== 'string') throw new Error(`Sandbox save physical inventory ${String(item.id)} is malformed.`);
      assertFinite(`physical inventory ${String(item.id)} quantity`, item.quantity, 0);
      assertFinite(`physical inventory ${String(item.id)} weightKg`, item.weightKg, 0);
      assertInteger(`physical inventory ${String(item.id)} acquiredDay`, item.acquiredDay, 1);
      if (item.acquiredMinuteOfDay !== undefined) assertInteger(`physical inventory ${String(item.id)} acquiredMinuteOfDay`,item.acquiredMinuteOfDay,0,1439);
      if (!Array.isArray(item.provenanceIds)) throw new Error(`Sandbox save physical inventory ${String(item.id)} is missing provenance.`);
      if (item.kind === 'resource') {
        if (typeof item.resourceKey !== 'string' || !['food','water','medicine','timber','scrap','fuel','cloth','records'].includes(item.resourceKey)) throw new Error(`Sandbox save physical resource ${String(item.id)} has invalid resourceKey.`);
        if (typeof item.resourceSubtype !== 'string' || typeof item.resourceUnit !== 'string' || typeof item.resourceSourceId !== 'string') throw new Error(`Sandbox save physical resource ${String(item.id)} is missing provenance cargo metadata.`);
      }
    }
    assertUniqueIdRecords('direct activity', value.directPlay.directActivities as unknown[]);
    for (const raw of value.directPlay.directActivities as unknown[]) {
      const activity = raw as Record<string, unknown>;
      if (!Array.isArray(activity.agentIds) || activity.agentIds.some((id) => typeof id !== 'string' || !agentIds.has(id))) throw new Error(`Sandbox save direct activity ${String(activity.id)} has invalid participants.`);
      if (!['observe','sample','harvest','conversation','clinic','research','assembly','records','survey','eat','drink','medicine','equipment','camp','combat','external'].includes(String(activity.kind))) throw new Error(`Sandbox save direct activity ${String(activity.id)} has invalid kind.`);
      assertFinite(`direct activity ${String(activity.id)} start`, activity.startAbsoluteMinute, 0);
      assertFinite(`direct activity ${String(activity.id)} end`, activity.endAbsoluteMinute, 0);
      if ((activity.endAbsoluteMinute as number) < (activity.startAbsoluteMinute as number) || typeof activity.completed !== 'boolean' || typeof activity.detail !== 'string') throw new Error(`Sandbox save direct activity ${String(activity.id)} is malformed.`);
    }
    void equipmentIds;
  }
  if (Array.isArray(value.researchProjects)) {
    for (const raw of value.researchProjects as unknown[]) {
      const project = raw as Record<string, unknown>;
      if (project.practicalOutcome!==undefined) assertId('research practical outcome',project.practicalOutcome);
      if (project.sampleItemId !== undefined && (typeof project.sampleItemId !== 'string' || !physicalInventoryIds.has(project.sampleItemId))) throw new Error(`Sandbox save research ${String(project.id)} references unknown physical sample.`);
      if (project.sampleSourceEntityId !== undefined && typeof project.sampleSourceEntityId !== 'string') throw new Error(`Sandbox save research ${String(project.id)} has invalid sample source.`);
    }
  }

  assertContinuityState(value,agentIds,knowledgeIds,recordIds);

  if (value.providerMutations !== undefined) {
    if (!isRecord(value.providerMutations)) throw new Error('Sandbox save has invalid provider mutation journal.');
    assertInteger('providerMutations.nextCommandOrdinal', value.providerMutations.nextCommandOrdinal, 1);
    assertInteger('providerMutations.providerCommitGeneration', value.providerMutations.providerCommitGeneration, 0);
    for (const key of ['retiredThroughOrdinal','retiredReceiptCount','retiredAcceptedCount','retiredRejectedCount','retiredEventCount','retiredCausalRecordCount']) {
      if (value.providerMutations[key] !== undefined) assertInteger(`providerMutations.${key}`, value.providerMutations[key], 0);
    }
    const retiredThroughOrdinal = typeof value.providerMutations.retiredThroughOrdinal === 'number' ? value.providerMutations.retiredThroughOrdinal : 0;
    if (retiredThroughOrdinal >= value.providerMutations.nextCommandOrdinal) throw new Error('Sandbox save provider mutation retirement watermark reaches an unallocated command ordinal.');
    if (typeof value.providerMutations.retiredReceiptCount === 'number' && typeof value.providerMutations.retiredAcceptedCount === 'number' && typeof value.providerMutations.retiredRejectedCount === 'number' && value.providerMutations.retiredAcceptedCount + value.providerMutations.retiredRejectedCount !== value.providerMutations.retiredReceiptCount) throw new Error('Sandbox save provider mutation retired receipt counters are inconsistent.');
    if (!Array.isArray(value.providerMutations.commandReceipts)) throw new Error('Sandbox save provider mutation journal is missing command receipts.');
    const receiptIds = new Set<string>();
    for (const raw of value.providerMutations.commandReceipts as unknown[]) {
      if (!isRecord(raw)) throw new Error('Sandbox save has invalid provider command receipt.');
      assertId('provider command receipt commandId', raw.commandId);
      if (receiptIds.has(raw.commandId)) throw new Error(`Sandbox save contains duplicate provider command receipt: ${raw.commandId}`);
      receiptIds.add(raw.commandId);
      const commandPrefix = `game:${String(value.saveId)}:`;
      if (String(raw.commandId).startsWith(commandPrefix)) {
        const suffix = String(raw.commandId).slice(String(raw.commandId).lastIndexOf(':') + 1);
        if (/^[0-9a-z]+$/i.test(suffix)) {
          const ordinal = Number.parseInt(suffix, 36);
          if (Number.isSafeInteger(ordinal) && ordinal <= retiredThroughOrdinal) throw new Error(`Sandbox save retains detailed provider receipt ${raw.commandId} below its retirement watermark.`);
          if (Number.isSafeInteger(ordinal) && ordinal >= value.providerMutations.nextCommandOrdinal) throw new Error(`Sandbox save provider receipt ${raw.commandId} references an unallocated command ordinal.`);
        }
      }
      assertId(`provider command receipt ${raw.commandId} kind`, raw.kind);
      assertInteger(`provider command receipt ${raw.commandId} issuedTick`, raw.issuedTick, 0);
      assertInteger(`provider command receipt ${raw.commandId} providerTick`, raw.providerTick, 0);
      if (raw.providerTick !== raw.issuedTick) throw new Error(`Sandbox save provider command receipt ${raw.commandId} has tick drift.`);
      if (typeof raw.accepted !== 'boolean') throw new Error(`Sandbox save provider command receipt ${raw.commandId} is missing terminal acceptance status.`);
      if (raw.reason !== undefined && typeof raw.reason !== 'string') throw new Error(`Sandbox save provider command receipt ${raw.commandId} has invalid reason.`);
      for (const key of ['eventIds','causalRecordIds']) if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).some((id) => typeof id !== 'string')) throw new Error(`Sandbox save provider command receipt ${raw.commandId} has invalid ${key}.`);
    }
  }

  if (!isRecord(value.diagnostics)) throw new Error('Sandbox save is missing diagnostics.');
  assertInteger('diagnostics.stepCount', value.diagnostics.stepCount, 0);
  assertInteger('diagnostics.lastWorldAdvanceFrom', value.diagnostics.lastWorldAdvanceFrom, 0);
  assertInteger('diagnostics.lastWorldAdvanceTo', value.diagnostics.lastWorldAdvanceTo, 0);
  if (typeof value.diagnostics.replayHash !== 'string' || (value.diagnostics.replayHash && !/^[0-9a-f]{8}$/.test(value.diagnostics.replayHash))) throw new Error('Sandbox save has invalid replay hash.');
}

export function importSandboxSave(text: string): SandboxGameState {
  const parsed: unknown = JSON.parse(text);
  assertState(parsed);
  const loaded = structuredClone(parsed);
  restoreLegacyKnowledgeShadow(loaded);
  synchronizeIncidentLedger(loaded);
  ensureSurvivalCampaignState(loaded);
  ensureResourceLedgerState(loaded);
  assertState(loaded);
  return loaded;
}

const DB_NAME = 'tdoc-descendants-sandbox';
const DB_VERSION = 1;
const STORE_NAME = 'saves';
const LOCK_NAME = 'tdoc-descendants-sandbox-persistence';
const OPEN_TIMEOUT_MS = 6000;
const QUARANTINE_PREFIX = `${STORAGE_KEY}:quarantine:`;
const PREVIOUS_STORAGE_KEY = `${STORAGE_KEY}:previous`;
const STORAGE_FORMAT = 'descendants-save-envelope-v3';
const LEGACY_STORAGE_FORMAT_V2 = 'descendants-save-envelope-v2';
const LEGACY_STORAGE_FORMAT_V1 = 'descendants-save-envelope-v1';
const QUARANTINE_FORMAT = 'descendants-quarantine-v1';
const MAX_FULL_QUARANTINES = 4;
const MAX_FULL_QUARANTINE_BYTES = 16 * 1024 * 1024;
const MAX_QUARANTINE_HISTORY = 24;

export type QuarantineSource = 'corrupt-active' | 'generation-rollback' | 'legacy-localstorage';
export type QuarantineRecord = {
  storageFormat: typeof QUARANTINE_FORMAT;
  capturedAt: string;
  reason: string;
  source: QuarantineSource;
  revision: number | null;
  commitGeneration: number | null;
  stateHash: string | null;
  rawChecksum: string;
  approxBytes: number;
  retained: 'full' | 'metadata-only';
  raw?: unknown;
};

export type SaveLineageForensicReport = {
  schema: 'descendants-save-lineage-forensic-v1';
  generatedAt: string;
  persistenceMode: SandboxPersistenceMode;
  active: { revision: number; commitGeneration: number; stateHash: string | null; valid: boolean; error?: string } | null;
  previous: { revision: number; commitGeneration: number; stateHash: string | null; valid: boolean; directParentOfActive: boolean; error?: string } | null;
  quarantine: Array<{ key: string; capturedAt: string; reason: string; source: QuarantineSource; revision: number | null; commitGeneration: number | null; stateHash: string | null; rawChecksum: string; approxBytes: number; retained: 'full' | 'metadata-only' }>;
  issues: string[];
};
let durableRevision: number | null = null;
let durableCommitGeneration: number | null = null;

export type SaveEnvelope = {
  storageFormat: typeof STORAGE_FORMAT;
  revision: number;
  commitGeneration: number;
  parentStateHash: string | null;
  stateHash: string;
  state: SandboxGameState;
};

type UnwrappedStoredSave = { state: unknown; revision: number; commitGeneration: number; stateHash: string | null };

export function sandboxStateChecksum(value: unknown): string {
  const payload = JSON.stringify(value);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { hash ^= payload.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}


function approximateSerializedBytes(value: unknown): number {
  const payload = JSON.stringify(value);
  try { return new TextEncoder().encode(payload).byteLength; }
  catch { return payload.length * 2; }
}

function storedGenerationMetadata(raw: unknown): { revision: number | null; commitGeneration: number | null; stateHash: string | null } {
  try {
    const unwrapped = unwrapStoredSave(raw);
    return { revision: unwrapped.revision, commitGeneration: unwrapped.commitGeneration, stateHash: unwrapped.stateHash };
  } catch {
    if (!isRecord(raw)) return { revision: null, commitGeneration: null, stateHash: null };
    return {
      revision: typeof raw.revision === 'number' && Number.isInteger(raw.revision) ? raw.revision : null,
      commitGeneration: typeof raw.commitGeneration === 'number' && Number.isInteger(raw.commitGeneration) ? raw.commitGeneration : null,
      stateHash: typeof raw.stateHash === 'string' ? raw.stateHash : null,
    };
  }
}

export function buildQuarantineRecord(raw: unknown, reason: string, source: QuarantineSource, capturedAt = new Date().toISOString()): QuarantineRecord {
  const generation = storedGenerationMetadata(raw);
  return {
    storageFormat: QUARANTINE_FORMAT,
    capturedAt,
    reason,
    source,
    revision: generation.revision,
    commitGeneration: generation.commitGeneration,
    stateHash: generation.stateHash,
    rawChecksum: sandboxStateChecksum(raw),
    approxBytes: approximateSerializedBytes(raw),
    retained: 'full',
    raw: structuredClone(raw),
  };
}

function normalizeQuarantineRecord(raw: unknown): QuarantineRecord | null {
  if (!isRecord(raw)) return null;
  if (raw.storageFormat === QUARANTINE_FORMAT) {
    if (typeof raw.capturedAt !== 'string' || typeof raw.reason !== 'string' || !['corrupt-active','generation-rollback','legacy-localstorage'].includes(String(raw.source))) return null;
    const retained = raw.retained === 'metadata-only' ? 'metadata-only' : 'full';
    return {
      storageFormat: QUARANTINE_FORMAT,
      capturedAt: raw.capturedAt,
      reason: raw.reason,
      source: raw.source as QuarantineSource,
      revision: typeof raw.revision === 'number' ? raw.revision : null,
      commitGeneration: typeof raw.commitGeneration === 'number' ? raw.commitGeneration : null,
      stateHash: typeof raw.stateHash === 'string' ? raw.stateHash : null,
      rawChecksum: typeof raw.rawChecksum === 'string' ? raw.rawChecksum : sandboxStateChecksum(raw.raw),
      approxBytes: typeof raw.approxBytes === 'number' && Number.isFinite(raw.approxBytes) ? Math.max(0, raw.approxBytes) : approximateSerializedBytes(raw.raw),
      retained,
      ...(retained === 'full' && 'raw' in raw ? { raw: structuredClone(raw.raw) } : {}),
    };
  }
  // Historical quarantine payloads stored only capturedAt/reason/raw. Normalize them lazily.
  if (typeof raw.capturedAt === 'string' && typeof raw.reason === 'string' && 'raw' in raw) return buildQuarantineRecord(raw.raw, raw.reason, 'corrupt-active', raw.capturedAt);
  return null;
}

export function compactQuarantineHistory(entries: Array<{ key: string; value: unknown }>): Array<{ key: string; record: QuarantineRecord; delete: boolean }> {
  const normalized = entries
    .map(({ key, value }) => ({ key, record: normalizeQuarantineRecord(value) }))
    .filter((entry): entry is { key: string; record: QuarantineRecord } => Boolean(entry.record))
    .sort((a, b) => b.record.capturedAt.localeCompare(a.record.capturedAt) || b.key.localeCompare(a.key));
  let fullCount = 0;
  let fullBytes = 0;
  return normalized.map((entry, index) => {
    if (index >= MAX_QUARANTINE_HISTORY) return { ...entry, delete: true };
    const size = entry.record.approxBytes;
    const keepFull = entry.record.retained === 'full' && (fullCount === 0 || (fullCount < MAX_FULL_QUARANTINES && fullBytes + size <= MAX_FULL_QUARANTINE_BYTES));
    if (keepFull) { fullCount += 1; fullBytes += size; return { ...entry, delete: false }; }
    const { raw: _raw, ...metadata } = entry.record; void _raw;
    return { key: entry.key, record: { ...metadata, retained: 'metadata-only' }, delete: false };
  });
}

function forensicSlot(raw: unknown | null): { revision: number; commitGeneration: number; stateHash: string | null; valid: boolean; error?: string } | null {
  if (raw == null) return null;
  try {
    const unwrapped = unwrapStoredSave(raw);
    assertState(unwrapped.state);
    return { revision: unwrapped.revision, commitGeneration: unwrapped.commitGeneration, stateHash: unwrapped.stateHash, valid: true };
  } catch (error) {
    const meta = storedGenerationMetadata(raw);
    return { revision: meta.revision ?? 0, commitGeneration: meta.commitGeneration ?? 0, stateHash: meta.stateHash, valid: false, error: persistenceErrorMessage(error) };
  }
}

export function buildSaveLineageForensicReport(input: { activeRaw: unknown | null; previousRaw: unknown | null; quarantineEntries: Array<{ key: string; value: unknown }>; persistenceMode?: SandboxPersistenceMode; generatedAt?: string }): SaveLineageForensicReport {
  const active = forensicSlot(input.activeRaw);
  const previousBase = forensicSlot(input.previousRaw);
  let directParentOfActive = false;
  if (input.activeRaw != null && input.previousRaw != null) {
    try { assertPreviousGenerationParent(input.activeRaw, input.previousRaw); directParentOfActive = true; } catch { /* reported below */ }
  }
  const previous = previousBase ? { ...previousBase, directParentOfActive } : null;
  const quarantine = compactQuarantineHistory(input.quarantineEntries)
    .filter((entry) => !entry.delete)
    .map(({ key, record }) => ({ key, capturedAt: record.capturedAt, reason: record.reason, source: record.source, revision: record.revision, commitGeneration: record.commitGeneration, stateHash: record.stateHash, rawChecksum: record.rawChecksum, approxBytes: record.approxBytes, retained: record.retained }));
  const issues: string[] = [];
  if (active && !active.valid) issues.push('Active HEAD is invalid.');
  if (previous && !previous.valid) issues.push('Previous generation is invalid.');
  if (active && previous && !directParentOfActive) issues.push('Previous generation is not the verified direct parent of active HEAD.');
  if (quarantine.some((entry) => entry.retained === 'metadata-only')) issues.push('Some older quarantine payloads were compacted to metadata-only forensic records.');
  return { schema: 'descendants-save-lineage-forensic-v1', generatedAt: input.generatedAt ?? new Date().toISOString(), persistenceMode: input.persistenceMode ?? 'durable', active, previous, quarantine, issues };
}

export function unwrapStoredSave(raw: unknown): UnwrappedStoredSave {
  if (isRecord(raw) && raw.storageFormat === STORAGE_FORMAT) {
    assertInteger('storage revision', raw.revision, 1);
    assertInteger('storage commit generation', raw.commitGeneration, 1);
    if (raw.commitGeneration < raw.revision) throw new Error('Sandbox save commit generation cannot precede its storage revision.');
    if (raw.parentStateHash !== null && typeof raw.parentStateHash !== 'string') throw new Error('Sandbox save envelope has invalid parent hash.');
    if (!('state' in raw)) throw new Error('Sandbox save envelope is missing state.');
    if (typeof raw.stateHash !== 'string' || raw.stateHash !== sandboxStateChecksum(raw.state)) throw new Error('Sandbox save envelope checksum mismatch; interrupted or corrupted write detected.');
    return { state: raw.state, revision: raw.revision, commitGeneration: raw.commitGeneration, stateHash: raw.stateHash };
  }
  if (isRecord(raw) && raw.storageFormat === LEGACY_STORAGE_FORMAT_V2) {
    assertInteger('storage revision', raw.revision, 1);
    if (!('state' in raw)) throw new Error('Legacy v2 sandbox save envelope is missing state.');
    if (typeof raw.stateHash !== 'string' || raw.stateHash !== sandboxStateChecksum(raw.state)) throw new Error('Legacy v2 sandbox save envelope checksum mismatch.');
    return { state: raw.state, revision: raw.revision, commitGeneration: raw.revision, stateHash: raw.stateHash };
  }
  if (isRecord(raw) && raw.storageFormat === LEGACY_STORAGE_FORMAT_V1) {
    assertInteger('storage revision', raw.revision, 1);
    if (!('state' in raw)) throw new Error('Legacy v1 sandbox save envelope is missing state.');
    return { state: raw.state, revision: raw.revision, commitGeneration: raw.revision, stateHash: sandboxStateChecksum(raw.state) };
  }
  // Pre-envelope IndexedDB saves are revision/generation zero and migrate on their next successful write.
  return { state: raw, revision: 0, commitGeneration: 0, stateHash: raw == null ? null : sandboxStateChecksum(raw) };
}

export function assertPreviousGenerationParent(activeRaw: unknown, previousRaw: unknown): UnwrappedStoredSave {
  if (!isRecord(activeRaw) || activeRaw.storageFormat !== STORAGE_FORMAT) throw new Error('Active save is not a generation-linked v3 envelope; previous generation cannot be promoted automatically.');
  assertInteger('active storage revision', activeRaw.revision, 2);
  assertInteger('active storage commit generation', activeRaw.commitGeneration, 2);
  if (typeof activeRaw.parentStateHash !== 'string' || !activeRaw.parentStateHash) throw new Error('Active save does not identify a previous generation hash.');
  const previous = unwrapStoredSave(previousRaw);
  if (!previous.stateHash) throw new Error('Previous save generation has no verifiable state hash.');
  if (previous.revision + 1 !== activeRaw.revision) throw new Error('Previous save generation is not the direct revision parent of active HEAD.');
  if (previous.commitGeneration + 1 !== activeRaw.commitGeneration) throw new Error('Previous save generation is not the direct commit-generation parent of active HEAD.');
  if (previous.stateHash !== activeRaw.parentStateHash) throw new Error('Previous save generation hash does not match active HEAD parentStateHash.');
  return previous;
}

function currentStoredRevision(raw: unknown | null): number {
  if (raw === null || raw === undefined) return 0;
  return unwrapStoredSave(raw).revision;
}

export function buildSaveEnvelope(state: SandboxGameState, currentRaw: unknown | null): SaveEnvelope {
  const current = currentRaw == null ? { revision: 0, commitGeneration: 0, stateHash: null } : unwrapStoredSave(currentRaw);
  const cloned = structuredClone(state);
  if (isRecord(cloned) && cloned.schemaVersion === 1 && Array.isArray(cloned.knowledge) && isRecord(cloned.world) && isRecord(cloned.settlement)) {
    syncLegacyKnowledgeShadow(cloned as unknown as SandboxGameState);
    synchronizeIncidentLedger(cloned as unknown as SandboxGameState);
    ensureSurvivalCampaignState(cloned as unknown as SandboxGameState);
    assertState(cloned);
  }
  return {
    storageFormat: STORAGE_FORMAT,
    revision: current.revision + 1,
    commitGeneration: current.commitGeneration + 1,
    parentStateHash: current.stateHash,
    stateHash: sandboxStateChecksum(cloned),
    state: cloned,
  };
}

export function assertStorageRevision(expectedRevision: number | null, actualRevision: number, operation: 'write' | 'reset'): void {
  if (expectedRevision === null || expectedRevision === actualRevision) return;
  const verb = operation === 'reset' ? 'Reset was cancelled to protect the newer save.' : 'Export this session or reload before writing.';
  throw new Error(`Sandbox save changed in another game window (expected revision ${expectedRevision}, found ${actualRevision}). ${verb}`);
}

type LockMode = 'shared' | 'exclusive';

function persistenceErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name ? `${error.name}: ` : ''}${error.message}`;
  return String(error);
}

function isTransientPersistenceError(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
  return ['AbortError','InvalidStateError','UnknownError','TransactionInactiveError'].includes(name);
}

async function withPersistenceLock<T>(mode: LockMode, task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(LOCK_NAME, { mode }, async () => task());
  }
  return task();
}

async function retryPersistence<T>(task: () => Promise<T>): Promise<T> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await task(); }
    catch (error) {
      if (attempt === 0 && isTransientPersistenceError(error)) { firstError = error; continue; }
      throw error;
    }
  }
  throw firstError ?? new Error('Sandbox persistence retry failed.');
}

function openSandboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is unavailable in this runtime.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const finishReject = (error: unknown) => { if (settled) return; settled = true; window.clearTimeout(timer); reject(error); };
    const timer = window.setTimeout(() => finishReject(new Error('Sandbox save database open timed out. Another game window may be blocking storage.')), OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; window.clearTimeout(timer);
      const db = request.result;
      // A different tab upgrading/deleting the DB must never keep this connection blocking it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => finishReject(request.error ?? new Error('Failed to open sandbox save database.'));
    request.onblocked = () => finishReject(new Error('Sandbox save database is blocked by another game window. Close or reload the other window, then retry.'));
  });
}

type DurableSlots = { active: unknown | null; previous: unknown | null };

async function idbReadSlots(): Promise<DurableSlots> {
  return withPersistenceLock('shared', () => retryPersistence(async () => {
    const db = await openSandboxDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const active = store.get(STORAGE_KEY);
        const previous = store.get(PREVIOUS_STORAGE_KEY);
        let activeDone = false, previousDone = false;
        const maybeResolve = () => { if (activeDone && previousDone) resolve({ active: active.result ?? null, previous: previous.result ?? null }); };
        active.onsuccess = () => { activeDone = true; maybeResolve(); };
        previous.onsuccess = () => { previousDone = true; maybeResolve(); };
        active.onerror = () => reject(active.error ?? new Error('Failed to read active sandbox save.'));
        previous.onerror = () => reject(previous.error ?? new Error('Failed to read previous sandbox save generation.'));
        tx.onerror = () => reject(tx.error ?? new Error('Sandbox save read transaction failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Sandbox save read transaction aborted.'));
      });
    } finally { db.close(); }
  }));
}

async function idbRead(): Promise<unknown | null> { return (await idbReadSlots()).active; }


async function idbReadQuarantineEntries(): Promise<Array<{ key: string; value: unknown }>> {
  return withPersistenceLock('shared', () => retryPersistence(async () => {
    const db = await openSandboxDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const keys = store.getAllKeys();
        const values = store.getAll();
        let keysReady = false, valuesReady = false;
        const finish = () => {
          if (!keysReady || !valuesReady) return;
          const out: Array<{ key: string; value: unknown }> = [];
          for (let index = 0; index < keys.result.length; index += 1) {
            const key = keys.result[index];
            if (typeof key === 'string' && key.startsWith(QUARANTINE_PREFIX)) out.push({ key, value: values.result[index] });
          }
          resolve(out);
        };
        keys.onsuccess = () => { keysReady = true; finish(); };
        values.onsuccess = () => { valuesReady = true; finish(); };
        keys.onerror = () => reject(keys.error ?? new Error('Failed to list quarantine keys.'));
        values.onerror = () => reject(values.error ?? new Error('Failed to list quarantine values.'));
        tx.onerror = () => reject(tx.error ?? new Error('Failed to read quarantine history.'));
        tx.onabort = () => reject(tx.error ?? new Error('Quarantine history read transaction aborted.'));
      });
    } finally { db.close(); }
  }));
}

async function idbCompactQuarantineHistory(): Promise<void> {
  await withPersistenceLock('exclusive', () => retryPersistence(async () => {
    const db = await openSandboxDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const keys = store.getAllKeys();
        const values = store.getAll();
        let keysReady = false, valuesReady = false;
        const apply = () => {
          if (!keysReady || !valuesReady) return;
          const entries: Array<{ key: string; value: unknown }> = [];
          for (let index = 0; index < keys.result.length; index += 1) {
            const key = keys.result[index];
            if (typeof key === 'string' && key.startsWith(QUARANTINE_PREFIX)) entries.push({ key, value: values.result[index] });
          }
          for (const entry of compactQuarantineHistory(entries)) {
            if (entry.delete) store.delete(entry.key);
            else store.put(entry.record, entry.key);
          }
        };
        keys.onsuccess = () => { keysReady = true; apply(); };
        values.onsuccess = () => { valuesReady = true; apply(); };
        keys.onerror = () => reject(keys.error ?? new Error('Failed to list quarantine keys for compaction.'));
        values.onerror = () => reject(values.error ?? new Error('Failed to list quarantine values for compaction.'));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Failed to compact quarantine history.'));
        tx.onabort = () => reject(tx.error ?? new Error('Quarantine compaction transaction aborted.'));
      });
    } finally { db.close(); }
  }));
}

function makeQuarantineKey(source: QuarantineSource): string {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${QUARANTINE_PREFIX}${source}:${Date.now()}:${suffix}`;
}

type DurableCommit = { revision: number; commitGeneration: number };

async function idbWrite(state: SandboxGameState, expectedRevision: number | null): Promise<DurableCommit> {
  return withPersistenceLock('exclusive', () => retryPersistence(async () => {
    const db = await openSandboxDb();
    try {
      return await new Promise<DurableCommit>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const current = store.get(STORAGE_KEY);
        let committed: DurableCommit = { revision: 0, commitGeneration: 0 };
        current.onerror = () => reject(current.error ?? new Error('Failed to read current sandbox save revision.'));
        current.onsuccess = () => {
          try {
            const currentRaw = current.result ?? null;
            const actualRevision = currentStoredRevision(currentRaw);
            try { assertStorageRevision(expectedRevision, actualRevision, 'write'); }
            catch (error) { tx.abort(); reject(error); return; }
            const envelope = buildSaveEnvelope(state, currentRaw);
            committed = { revision: envelope.revision, commitGeneration: envelope.commitGeneration };
            // Keep exactly one known-good predecessor. Both rotation and HEAD replacement happen in
            // the same IndexedDB transaction, so a crash cannot publish a new HEAD without its backup.
            if (currentRaw !== null) {
              const backup = store.put(structuredClone(currentRaw), PREVIOUS_STORAGE_KEY);
              backup.onerror = () => reject(backup.error ?? new Error('Failed to stage previous save generation.'));
            }
            const put = store.put(envelope, STORAGE_KEY);
            put.onerror = () => reject(put.error ?? new Error('Failed to stage sandbox save write.'));
          } catch (error) { try { tx.abort(); } catch { /* transaction may already be inactive */ } reject(error); }
        };
        tx.oncomplete = () => resolve(committed);
        tx.onerror = () => reject(tx.error ?? new Error('Failed to write sandbox save.'));
        tx.onabort = () => { /* explicit concurrency abort is already rejected above */ };
      });
    } finally { db.close(); }
  }));
}

async function idbDelete(expectedRevision: number | null): Promise<void> {
  await withPersistenceLock('exclusive', () => retryPersistence(async () => {
    const db = await openSandboxDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const current = store.get(STORAGE_KEY);
        current.onerror = () => reject(current.error ?? new Error('Failed to read current sandbox save revision before reset.'));
        current.onsuccess = () => {
          try {
            const actualRevision = currentStoredRevision(current.result ?? null);
            try { assertStorageRevision(expectedRevision, actualRevision, 'reset'); }
            catch (error) { tx.abort(); reject(error); return; }
            const request = store.delete(STORAGE_KEY);
            request.onerror = () => reject(request.error ?? new Error('Failed to stage sandbox save deletion.'));
            const previous = store.delete(PREVIOUS_STORAGE_KEY);
            previous.onerror = () => reject(previous.error ?? new Error('Failed to stage previous save generation deletion.'));
          } catch (error) { try { tx.abort(); } catch { /* transaction may already be inactive */ } reject(error); }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Failed to delete sandbox save.'));
        tx.onabort = () => { /* explicit concurrency abort is already rejected above */ };
      });
    } finally { db.close(); }
  }));
}

async function idbQuarantine(raw: unknown, reason: string): Promise<string> {
  try { await idbCompactQuarantineHistory(); } catch { /* best-effort pre-compaction; quarantine transaction remains authoritative */ }
  const quarantineRecord = buildQuarantineRecord(raw, reason, 'corrupt-active');
  const quarantineKey = makeQuarantineKey('corrupt-active');
  await withPersistenceLock('exclusive', async () => {
    const db = await openSandboxDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const current = store.get(STORAGE_KEY);
        current.onerror = () => reject(current.error ?? new Error('Failed to re-read active save before quarantine.'));
        current.onsuccess = () => {
          if (JSON.stringify(current.result ?? null) !== JSON.stringify(raw)) {
            tx.abort(); reject(new Error('Active save changed in another game window before quarantine; recovery was cancelled.')); return;
          }
          // Put-before-delete in one transaction: if quarantine cannot be committed, the active save remains untouched.
          const put = store.put(quarantineRecord, quarantineKey);
          put.onerror = () => reject(put.error ?? new Error('Failed to quarantine corrupt sandbox save.'));
          store.delete(STORAGE_KEY);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Corrupt sandbox save quarantine transaction failed.'));
        tx.onabort = () => { /* explicit stale recovery abort is already rejected above */ };
      });
    } finally { db.close(); }
  });
  try { await idbCompactQuarantineHistory(); } catch { /* retention maintenance must not invalidate a successful quarantine */ }
  return quarantineKey;
}
async function idbRestorePreviousGeneration(activeRaw: unknown, previousRaw: unknown, reason: string): Promise<{ quarantineKey: string; restored: UnwrappedStoredSave }> {
  const restored = assertPreviousGenerationParent(activeRaw, previousRaw);
  assertState(restored.state);
  try { await idbCompactQuarantineHistory(); } catch { /* best-effort pre-compaction */ }
  const quarantineRecord = buildQuarantineRecord(activeRaw, reason, 'generation-rollback');
  const quarantineKey = makeQuarantineKey('generation-rollback');
  await withPersistenceLock('exclusive', async () => {
    const db = await openSandboxDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const current = store.get(STORAGE_KEY);
        const previous = store.get(PREVIOUS_STORAGE_KEY);
        let currentReady = false, previousReady = false;
        const apply = () => {
          if (!currentReady || !previousReady) return;
          if (JSON.stringify(current.result ?? null) !== JSON.stringify(activeRaw) || JSON.stringify(previous.result ?? null) !== JSON.stringify(previousRaw)) {
            tx.abort(); reject(new Error('Save generations changed in another game window before rollback; recovery was cancelled.')); return;
          }
          const putQuarantine = store.put(quarantineRecord, quarantineKey);
          putQuarantine.onerror = () => reject(putQuarantine.error ?? new Error('Failed to quarantine corrupt active save before generation restore.'));
          const restore = store.put(structuredClone(previousRaw), STORAGE_KEY);
          restore.onerror = () => reject(restore.error ?? new Error('Failed to restore previous committed save generation.'));
          const clearPrevious = store.delete(PREVIOUS_STORAGE_KEY);
          clearPrevious.onerror = () => reject(clearPrevious.error ?? new Error('Failed to clear promoted previous generation.'));
        };
        current.onsuccess = () => { currentReady = true; apply(); };
        previous.onsuccess = () => { previousReady = true; apply(); };
        current.onerror = () => reject(current.error ?? new Error('Failed to re-read active save before generation rollback.'));
        previous.onerror = () => reject(previous.error ?? new Error('Failed to re-read previous generation before rollback.'));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Previous-generation recovery transaction failed.'));
        tx.onabort = () => { /* explicit stale recovery abort is already rejected above */ };
      });
    } finally { db.close(); }
  });
  try { await idbCompactQuarantineHistory(); } catch { /* metadata retention is best-effort after successful restore */ }
  return { quarantineKey, restored };
}

function quarantineLegacyText(text: string): string | null {
  const key = `${QUARANTINE_PREFIX}legacy:${Date.now()}`;
  try {
    window.localStorage.setItem(key, text);
    window.localStorage.removeItem(STORAGE_KEY);
    // localStorage legacy quarantine is intentionally tiny; IndexedDB quarantine retains richer metadata.
    const keys = Object.keys(window.localStorage).filter((entry) => entry.startsWith(`${QUARANTINE_PREFIX}legacy:`)).sort().reverse();
    for (const oldKey of keys.slice(4)) window.localStorage.removeItem(oldKey);
    return key;
  } catch { return null; }
}

async function durableLoadRecoverable(): Promise<SandboxLoadResult> {
  let slots: DurableSlots;
  try { slots = await idbReadSlots(); }
  catch (error) {
    return { state: null, mode: 'unavailable', recoveryKind: 'storage-unavailable', warning: `Persistent storage is unavailable. The active save slot was not modified. ${persistenceErrorMessage(error)}` };
  }
  const stored = slots.active;
  if (stored !== null) {
    try {
      const unwrapped = unwrapStoredSave(stored);
      assertState(unwrapped.state);
      const loaded = structuredClone(unwrapped.state as SandboxGameState);
      const knowledgeRestore = restoreLegacyKnowledgeShadow(loaded);
      synchronizeIncidentLedger(loaded);
      ensureSurvivalCampaignState(loaded);
      assertState(loaded);
      durableRevision = unwrapped.revision;
      durableCommitGeneration = unwrapped.commitGeneration;
      return {
        state: loaded,
        mode: 'durable',
        ...(knowledgeRestore.migrated ? {
          recoveryKind: 'knowledge-store-migrated' as const,
          warning: 'This schemaVersion=1 save predates persisted KnowledgeStore state. The sidecar was deterministically rebuilt from legacy knowledge/Archive state and will be written on the next save.'
        } : knowledgeRestore.reconciled ? {
          recoveryKind: 'knowledge-store-reconciled' as const,
          warning: 'The persisted KnowledgeStore sidecar was structurally valid but stale relative to legacy knowledge/Archive authority. It was deterministically reconciled and will be rewritten on the next save.'
        } : {}),
      };
    } catch (validationError) {
      const reason = validationError instanceof Error ? validationError.message : String(validationError);
      if (slots.previous !== null) {
        try {
          const recovered = await idbRestorePreviousGeneration(stored, slots.previous, reason);
          durableRevision = recovered.restored.revision;
          durableCommitGeneration = recovered.restored.commitGeneration;
          const recoveredState = structuredClone(recovered.restored.state as SandboxGameState);
          const knowledgeRestore = restoreLegacyKnowledgeShadow(recoveredState);
          synchronizeIncidentLedger(recoveredState);
          ensureSurvivalCampaignState(recoveredState);
          assertState(recoveredState);
          return {
            state: recoveredState, mode: 'durable', recoveryKind: 'previous-generation-restored',
            quarantineKey: recovered.quarantineKey,
            warning: `The active save generation failed validation and was quarantined as ${recovered.quarantineKey}. The previous fully committed generation ${recovered.restored.commitGeneration} was restored automatically.${knowledgeRestore.migrated ? ' Its missing KnowledgeStore sidecar was deterministically rebuilt from legacy knowledge/Archive state.' : knowledgeRestore.reconciled ? ' Its stale KnowledgeStore sidecar was reconciled to legacy knowledge/Archive authority.' : ''} ${reason}`,
          };
        } catch { /* Fall through to quarantine-only path when the predecessor is not independently valid. */ }
      }
      try {
        const quarantineKey = await idbQuarantine(stored, reason);
        durableRevision = 0; durableCommitGeneration = 0;
        return { state: null, mode: 'durable', recoveryKind: 'corrupt-save-quarantined', quarantineKey, warning: `The persisted save failed validation and was quarantined as ${quarantineKey}. No independently valid previous generation was available, so a fresh generated world can now be created without destroying the captured data. ${reason}` };
      } catch (quarantineError) {
        return { state: null, mode: 'unavailable', recoveryKind: 'storage-unavailable', warning: `The persisted save is corrupt and could not be quarantined or rolled back, so the active slot was left untouched. ${reason} Quarantine failure: ${persistenceErrorMessage(quarantineError)}` };
      }
    }
  }

  // One-time migration from the earlier localStorage prototype. Remove only after durable IDB commit.
  let legacyText: string | null = null;
  try { legacyText = window.localStorage.getItem(STORAGE_KEY); } catch { /* IDB remains authoritative. */ }
  if (!legacyText) { durableRevision = 0; durableCommitGeneration = 0; return { state: null, mode: 'durable' }; }
  try {
    const migrated = importSandboxSave(legacyText);
    const commit = await idbWrite(migrated, 0);
    durableRevision = commit.revision; durableCommitGeneration = commit.commitGeneration;
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* migration already durable */ }
    return { state: migrated, mode: 'durable', recoveryKind: 'legacy-migrated', warning: 'A legacy localStorage sandbox save was validated and migrated to IndexedDB.' };
  } catch (error) {
    const key = quarantineLegacyText(legacyText);
    return { state: null, mode: 'durable', recoveryKind: 'legacy-corrupt', ...(key ? { quarantineKey: key } : {}), warning: `A legacy localStorage save failed validation${key ? ` and was quarantined as ${key}` : '; it could not be quarantined and remains untouched'}. ${persistenceErrorMessage(error)}` };
  }
}

function exportValidated(state: SandboxGameState): string {
  const exported = structuredClone(state);
  syncLegacyKnowledgeShadow(exported);
  synchronizeIncidentLedger(exported);
  ensureSurvivalCampaignState(exported);
  assertState(exported);
  return `${JSON.stringify(exported, null, 2)}\n`;
}

export function createVolatileSandboxRepository(initialState: SandboxGameState | null = null): SandboxRepository {
  let memory = initialState ? structuredClone(initialState) : null;
  if (memory) { restoreLegacyKnowledgeShadow(memory); synchronizeIncidentLedger(memory); ensureSurvivalCampaignState(memory); }
  const loadMemory = () => {
    if (!memory) return null;
    const loaded = structuredClone(memory);
    restoreLegacyKnowledgeShadow(loaded);
    synchronizeIncidentLedger(loaded);
    ensureSurvivalCampaignState(loaded);
    return loaded;
  };
  return {
    mode: 'volatile',
    async load() { return loadMemory(); },
    async loadRecoverable() { return { state: loadMemory(), mode: 'volatile', warning: 'Temporary session: persistent storage is not being modified.' }; },
    async save(state) { syncLegacyKnowledgeShadow(state); synchronizeIncidentLedger(state); ensureSurvivalCampaignState(state); assertState(state); memory = structuredClone(state); },
    async clear() { memory = null; },
    exportJson: exportValidated,
    importJson(text) { return importSandboxSave(text); },
    async checkFreshness() { return 'fresh'; },
    async forensicReport() { return buildSaveLineageForensicReport({ activeRaw: memory ? structuredClone(memory) : null, previousRaw: null, quarantineEntries: [], persistenceMode: 'volatile' }); },
    async exportLatestQuarantine() { return null; },
  };
}

export const sandboxRepository: SandboxRepository = {
  mode: 'durable',
  async load(): Promise<SandboxGameState | null> {
    const result = await durableLoadRecoverable();
    if (result.mode === 'unavailable') throw new Error(result.warning ?? 'Sandbox persistence is unavailable.');
    return result.state;
  },
  async loadRecoverable(): Promise<SandboxLoadResult> { return durableLoadRecoverable(); },
  async save(state: SandboxGameState): Promise<void> {
    syncLegacyKnowledgeShadow(state);
    synchronizeIncidentLedger(state);
    ensureSurvivalCampaignState(state);
    assertState(state);
    const commit = await idbWrite(state, durableRevision);
    durableRevision = commit.revision; durableCommitGeneration = commit.commitGeneration;
  },
  async clear(): Promise<void> {
    await idbDelete(durableRevision);
    durableRevision = 0; durableCommitGeneration = 0;
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* IndexedDB clear remains authoritative */ }
  },
  async checkFreshness(): Promise<'fresh' | 'stale' | 'unknown'> {
    try {
      const raw = await idbRead();
      const actual = raw == null ? { revision: 0, commitGeneration: 0 } : unwrapStoredSave(raw);
      if (durableRevision === null || durableCommitGeneration === null) return 'fresh';
      return actual.revision === durableRevision && actual.commitGeneration === durableCommitGeneration ? 'fresh' : 'stale';
    } catch { return 'unknown'; }
  },
  async forensicReport(): Promise<SaveLineageForensicReport> {
    const [slots, quarantineEntries] = await Promise.all([idbReadSlots(), idbReadQuarantineEntries()]);
    return buildSaveLineageForensicReport({ activeRaw: slots.active, previousRaw: slots.previous, quarantineEntries, persistenceMode: 'durable' });
  },
  async exportLatestQuarantine(): Promise<{ key: string; json: string } | null> {
    const entries = compactQuarantineHistory(await idbReadQuarantineEntries()).filter((entry) => !entry.delete && entry.record.retained === 'full' && 'raw' in entry.record);
    const latest = entries[0];
    if (!latest) return null;
    const payload = { schema: 'descendants-quarantine-export-v1', key: latest.key, ...latest.record };
    return { key: latest.key, json: `${JSON.stringify(payload, null, 2)}\n` };
  },
  exportJson: exportValidated,
  importJson(text: string): SandboxGameState { return importSandboxSave(text); },
};


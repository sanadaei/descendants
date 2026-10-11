import type {
  AdvanceRequest, AdvanceResult, AreaProjection, AreaQuery, CausalRecord, CommandResult, EntityId,
  KnowledgeRecord, SpatialRef, WorldCommand, WorldEntity, WorldEventRecord, WorldManifest, WorldProvider,
  WorldRelation, WorldSnapshot,
} from './contract.js';

const fixtureManifest: WorldManifest = {
  contractVersion: '1.0.0',
  engineVersion: 'mock-2',
  recipeId: 'descendants-dev',
  seed: 12345,
  currentTick: 0,
  geometry: {
    spaceModel: 'planar', projectionId: 'local-km',
    extent: { widthKm: 600, heightKm: 400, linearScaleHintRelativeToEarth: 0.05 },
    continentCount: { mode: 'fixed', value: 1 },
  },
  lodTierIds: ['active', 'settlement', 'regional', 'macro'],
  variableDefinitions: [
    { id: 'descendants.anomaly.pressure', namespace: 'descendants', scope: 'region', kind: 'number', semantic: 'Observed anomalous environmental pressure; interpretation belongs to agents.', min: 0, max: 1, hiddenTruth: false, observableByDefault: true },
    { id: 'descendants.infrastructure.integrity', namespace: 'descendants', scope: 'entity', kind: 'number', semantic: 'Physical infrastructure integrity fraction.', min: 0, max: 1, hiddenTruth: false, observableByDefault: true },
    { id: 'descendants.signal.reliability', namespace: 'descendants', scope: 'region', kind: 'number', semantic: 'Communication signal reliability.', min: 0, max: 1, hiddenTruth: false, observableByDefault: true },
  ],
  enabledModules: [
    { id: 'geography', version: 'mock-1' },
    { id: 'societies', version: 'mock-1' },
    { id: 'anomaly-fields', version: 'mock-1' },
  ],
  contentPacks: [{ id: 'descendants', version: '0.2.0' }],
  capabilities: ['area-query', 'advance', 'knowledge', 'commands', 'stable-provenance', 'lod-projection'],
};


const ORIGIN_SPATIAL: SpatialRef = { frameId: 'world', x: 300, y: 210, regionId: 'region:greenfold' };
function buildMockOriginPopulation(): { entities: WorldEntity[]; relations: WorldRelation[] } {
  const entities: WorldEntity[] = [{
    id: 'cohort:origin', kind: 'population-cohort', spatial: clone(ORIGIN_SPATIAL), components: {
      settlementId: 'settlement:origin', populationKind: 'descendants-human-population', count: 40,
      ageStructure: { juvenile: .2, adult: .65, elder: .15 }, healthIndex: .72,
      householdDemography: { householdCount: 10, meanHouseholdSize: 4, fertilityIndex: .62, dependencySupportIndex: .7 },
    }, provenanceIds: ['prov:origin'],
  }];
  const relations: WorldRelation[] = [];
  for (let h = 1; h <= 10; h += 1) entities.push({ id: `household:origin:${h}`, kind: 'household', spatial: clone(ORIGIN_SPATIAL), components: { cohortId: 'cohort:origin', householdOrdinal: h - 1, nominalSize: 4, sampleWeight: 4, templateId: 'mock-household', norms: ['mutual-support'], reservePreference: .5, __lodMaterialized: true }, provenanceIds: ['prov:origin'] });
  for (let i = 0; i < 40; i += 1) {
    const n = i + 1, id = `individual:origin:${String(n).padStart(2,'0')}`, anchor = `identity:origin:${String(n).padStart(2,'0')}`, household = `household:origin:${Math.floor(i / 4) + 1}`;
    const continuitySeed = (0x51f15e + n * 2654435761) >>> 0;
    entities.push({ id: anchor, kind: 'identity-anchor', spatial: clone(ORIGIN_SPATIAL), components: { cohortId: 'cohort:origin', ordinal: i, commitments: [], identityTraits: { continuitySeed, temperament: [((n*37)%101)/50-1,((n*53)%101)/50-1,((n*71)%101)/50-1] } }, provenanceIds: ['prov:origin'] });
    entities.push({ id, kind: 'individual', spatial: clone(ORIGIN_SPATIAL), components: { cohortId: 'cohort:origin', ordinal: i, identityAnchorId: anchor, householdId: household, templateId: 'mock-agent', roles: ['member'], sampleWeight: 1, vitalityIndex: .55 + ((n*17)%40)/100, dispositionVector: [((n*19)%101)/50-1,((n*29)%101)/50-1,((n*43)%101)/50-1], commitments: [], plans: [{kind:'maintain-health',priority:.55,progress:0,planOrdinal:0},{kind:'support-household',priority:.5,progress:0,planOrdinal:1}], __lodMaterialized: true }, provenanceIds: ['prov:origin'] });
    relations.push({ id:`relation:materialized:${n}`,kind:'materialized-from',sourceId:id,targetId:'cohort:origin',data:{},provenanceIds:['prov:origin'] }, { id:`relation:identity:${n}`,kind:'identity-realization',sourceId:id,targetId:anchor,data:{},provenanceIds:['prov:origin'] }, { id:`relation:household:${n}`,kind:'member-of-household',sourceId:id,targetId:household,data:{},provenanceIds:['prov:origin'] });
    if (i % 4 === 1) relations.push({ id:`relation:kin:${n}`,kind:'kin-support',sourceId:`individual:origin:${String(n-1).padStart(2,'0')}`,targetId:id,data:{closenessIndex:.72,sufficientStatistic:true},provenanceIds:['prov:origin'] });
  }
  for (const [suffix,type,capacity] of [['governance','local-governance',.62],['clinic','medical-practice',.57],['records','communications',.51],['exchange','exchange-network',.55]] as const) {
    const id=`institution:origin:${suffix}`; entities.push({id,kind:'institution',subtype:type,spatial:clone(ORIGIN_SPATIAL),components:{institutionType:type,capacityIndex:capacity,legitimacyIndex:.58,resourceBaseIndex:.5,history:[]},provenanceIds:['prov:origin']}); relations.push({id:`relation:based-in:${suffix}`,kind:'based-in',sourceId:id,targetId:'settlement:origin',data:{},provenanceIds:['prov:origin']});
  }
  return { entities, relations };
}
const MOCK_ORIGIN_POPULATION = buildMockOriginPopulation();
const ENTITIES: WorldEntity[] = [
  {
    id: 'settlement:origin', kind: 'settlement', subtype: 'exile-descendant', spatial: clone(ORIGIN_SPATIAL),
    components: { population: 40, name: 'Origin Settlement', housingCapacity: 47, polity: 'council-custom' }, tags: ['player-origin'], provenanceIds: ['prov:origin'],
  },
  {
    id: 'terrain:old-service-road', kind: 'route', subtype: 'abandoned-service-road', spatial: { frameId: 'world', x: 306, y: 207, regionId: 'region:greenfold' },
    components: { name: 'Old Service Road', passability: 0.74, visibleFromOrigin: true }, tags: ['route', 'known-local'], provenanceIds: ['prov:road'],
  },
  {
    id: 'landmark:relay-tower', kind: 'landmark', subtype: 'telecom-ruin', spatial: { frameId: 'world', x: 314, y: 200, regionId: 'region:greenfold' },
    components: { name: 'Relay Tower 17', integrity: 0.31, signalPotential: 0.57 }, tags: ['ruin', 'signal'], provenanceIds: ['prov:relay'],
  },
  {
    id: 'anomaly:glass-rain-basin', kind: 'anomaly', subtype: 'weather-material', spatial: { frameId: 'world', x: 322, y: 198, regionId: 'region:greenfold' },
    components: { name: 'Glass Rain Basin', pressure: 0.66, domainHints: ['weather', 'material', 'pathology'] }, tags: ['unknown-rule'], provenanceIds: ['prov:basin', 'truth:glass-rain'],
  },
  {
    id: 'settlement:river-market', kind: 'settlement', subtype: 'external', spatial: { frameId: 'world', x: 337, y: 224, regionId: 'region:lower-river' },
    components: { population: 126, name: 'River Market', surplus: ['grain', 'ceramics'], demand: ['medicine', 'machine-parts'], disposition: 0.12 }, tags: ['external-society'], provenanceIds: ['prov:river-market'],
  },
  {
    id: 'settlement:quarry-camp', kind: 'settlement', subtype: 'external', spatial: { frameId: 'world', x: 281, y: 238, regionId: 'region:white-ridge' },
    components: { population: 63, name: 'Quarry Camp', surplus: ['stone', 'metal-scrap'], demand: ['food', 'cloth'], disposition: -0.08 }, tags: ['external-society'], provenanceIds: ['prov:quarry-camp'],
  },
  {
    id: 'region:greenfold', kind: 'region', subtype: 'forest-basin', spatial: { frameId: 'world', x: 306, y: 210, regionId: 'region:greenfold' },
    components: { name: 'Greenfold', anomalyPressure: 0.34, signalReliability: 0.46, waterAvailability: 0.81 }, tags: ['region'], provenanceIds: ['prov:greenfold'],
  },  ...MOCK_ORIGIN_POPULATION.entities,
];

const RELATIONS: WorldRelation[] = [
  { id: 'relation:road-origin-relay', kind: 'connects', sourceId: 'settlement:origin', targetId: 'landmark:relay-tower', data: { routeId: 'terrain:old-service-road' }, provenanceIds: ['prov:road'] },
  { id: 'relation:origin-greenfold', kind: 'located-in', sourceId: 'settlement:origin', targetId: 'region:greenfold', provenanceIds: ['prov:origin'] },
  { id: 'relation:basin-greenfold', kind: 'located-in', sourceId: 'anomaly:glass-rain-basin', targetId: 'region:greenfold', provenanceIds: ['prov:basin'] },  ...MOCK_ORIGIN_POPULATION.relations,
];

const CAUSAL: CausalRecord[] = [
  { id: 'prov:origin', kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { fixture: true, semantic: 'player settlement exists before game observation' } },
  { id: 'prov:road', kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { fixture: true, semantic: 'service road predates current settlement' } },
  { id: 'prov:relay', kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { fixture: true, semantic: 'regional infrastructure remnant' } },
  { id: 'prov:basin', kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { fixture: true, semantic: 'anomalous basin exists independent of observation' } },
  { id: 'truth:glass-rain', kind: 'law', parentIds: ['prov:basin'], hiddenTruth: true, payload: { fixture: true, ruleFamily: 'material-weather-coupling', note: 'hidden truth intentionally not exposed through ordinary query components' } },
  { id: 'prov:river-market', kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { fixture: true } },
  { id: 'prov:quarry-camp', kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { fixture: true } },
  { id: 'prov:greenfold', kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { fixture: true } },
];

const KNOWLEDGE: KnowledgeRecord[] = [
  {
    id: 'knowledge:origin-road', holderId: 'settlement:origin', subjectIds: ['terrain:old-service-road', 'landmark:relay-tower'], acquiredTick: 0, confidence: 0.84,
    claim: { text: 'An old paved service road runs southeast toward a broken relay tower.', kind: 'route-report' }, truthLinkIds: ['prov:road', 'prov:relay'],
  },
  {
    id: 'knowledge:origin-market-rumor', holderId: 'settlement:origin', subjectIds: ['settlement:river-market'], acquiredTick: 0, confidence: 0.42,
    claim: { text: 'Travelers once spoke of a market settlement downriver.', kind: 'oral-rumor' }, truthLinkIds: ['prov:river-market'],
  },
];

function clone<T>(value: T): T { return structuredClone(value); }
function distanceKm(a: SpatialRef, b: SpatialRef): number {
  if (a.frameId !== b.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

export class MockWorldProvider implements WorldProvider {
  #tick = 0;
  #events: WorldEventRecord[] = [];
  #causalRecords: CausalRecord[] = clone(CAUSAL);
  #commandSequence = 0;

  async getManifest(): Promise<WorldManifest> { return { ...clone(fixtureManifest), currentTick: this.#tick }; }

  async getEntity(id: EntityId): Promise<WorldEntity | null> {
    const entity = ENTITIES.find((candidate) => candidate.id === id);
    return entity ? clone(entity) : null;
  }

  async queryArea(query: AreaQuery): Promise<AreaProjection> {
    const entities = ENTITIES.filter((entity) => {
      if (!entity.spatial || distanceKm(entity.spatial, query.center) > query.radiusKm) return false;
      return !query.entityKinds?.length || query.entityKinds.includes(entity.kind);
    });
    const ids = new Set(entities.map((entity) => entity.id));
    const relations = RELATIONS.filter((relation) => ids.has(relation.sourceId) || ids.has(relation.targetId));
    const aggregates = {
      nearbyPopulation: entities.reduce((sum, entity) => sum + (typeof entity.components.population === 'number' ? entity.components.population : 0), 0),
      anomalyCount: entities.filter((entity) => entity.kind === 'anomaly').length,
    };
    const observationIds = query.includeKnowledgeProjection
      ? KNOWLEDGE.filter((knowledge) => !query.observerId || knowledge.holderId === query.observerId).map((knowledge) => knowledge.id)
      : [];
    return { tick: this.#tick, effectiveDetailRank: query.requestedDetailRank, entities: clone(entities), relations: clone(relations), aggregates, observationIds };
  }

  async getKnowledge(holderId: EntityId, subjectId?: string): Promise<KnowledgeRecord[]> {
    return clone(KNOWLEDGE.filter((entry) => entry.holderId === holderId && (!subjectId || entry.subjectIds.includes(subjectId))));
  }

  async issueCommand(command: WorldCommand): Promise<CommandResult> {
    if (command.issuedTick > this.#tick) return { commandId: command.id, accepted: false, reason: 'Command is issued from a future world tick.', eventIds: [], causalRecordIds: [] };
    const sequence = ++this.#commandSequence;
    const causalId = `mock:intervention:${sequence}`;
    const eventId = `mock:event:${sequence}`;
    this.#causalRecords.push({
      id: causalId, kind: 'intervention', parentIds: [...(command.epistemicBasisIds ?? [])], tick: this.#tick, hiddenTruth: false,
      payload: { commandId: command.id, kind: command.kind, payload: clone(command.payload) },
    });
    this.#events.push({
      id: eventId, kind: `command.${command.kind}`, tick: this.#tick, actorIds: command.issuerId ? [command.issuerId] : [], targetIds: [...(command.targets ?? [])],
      ...(command.location ? { location: clone(command.location) } : {}), data: clone(command.payload), causeIds: [causalId], provenanceIds: [causalId],
    });
    return { commandId: command.id, accepted: true, eventIds: [eventId], causalRecordIds: [causalId] };
  }

  async advance(request: AdvanceRequest): Promise<AdvanceResult> {
    const fromTick = this.#tick;
    this.#tick = Math.max(this.#tick, Math.floor(request.toTick));
    const changedAggregateKeys = this.#tick === fromTick ? [] : ['mock.elapsedTicks'];
    return { fromTick, toTick: this.#tick, eventIds: [], changedEntityIds: [], changedAggregateKeys };
  }

  async exportSnapshot(): Promise<WorldSnapshot> {
    return {
      manifest: await this.getManifest(), entities: clone(ENTITIES), relations: clone(RELATIONS), events: clone(this.#events),
      causalRecords: clone(this.#causalRecords), knowledge: clone(KNOWLEDGE), aggregates: { fixture: true, elapsedTicks: this.#tick },
    };
  }
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type EntityId = string;
export type RelationId = string;
export type EventId = string;
export type WorldTick = number;
export interface VersionedRef {
    id: string;
    version: string;
}
export interface WorldExtent {
    widthKm: number;
    heightKm: number;
    depthKm?: number;
    linearScaleHintRelativeToEarth?: number;
}
export interface CountPolicy {
    mode: 'fixed' | 'range' | 'generator';
    value?: number;
    min?: number;
    max?: number;
    generatorId?: string;
}
export interface GeometryRecipe {
    spaceModel: 'planar' | 'spherical' | 'custom';
    projectionId: string;
    extent: WorldExtent;
    continentCount: CountPolicy;
    wrapX?: boolean;
    wrapY?: boolean;
    config?: Record<string, JsonValue>;
}
export type VariableKind = 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'vector' | 'distribution' | 'json';
export type VariableScope = 'world' | 'region' | 'cell' | 'entity' | 'population' | 'culture' | 'institution' | 'custom';
export interface VariableDefinition {
    id: string;
    namespace: string;
    scope: VariableScope;
    kind: VariableKind;
    semantic: string;
    default?: JsonValue;
    min?: number;
    max?: number;
    enumValues?: string[];
    unit?: string;
    hiddenTruth?: boolean;
    observableByDefault?: boolean;
    metadata?: Record<string, JsonValue>;
}
export interface ComponentSchemaDefinition {
    id: string;
    namespace: string;
    appliesToKinds?: string[];
    schema: Record<string, JsonValue>;
    semantic?: string;
}
export interface ModuleRecipe {
    id: string;
    version?: string;
    enabled: boolean;
    config: Record<string, JsonValue>;
}
export interface GenerationPassRecipe {
    id: string;
    moduleId: string;
    dependsOn?: string[];
    enabled?: boolean;
    config?: Record<string, JsonValue>;
}
export interface LODTierRecipe {
    id: string;
    detailRank: number;
    updateIntervalTicks: number;
    populationMode: 'individual' | 'cohort' | 'aggregate' | 'field';
    spatialResolutionKm?: number;
    materializeOnDemand?: boolean;
    historyRetention: 'full' | 'significant' | 'aggregate';
}
export interface WorldRecipe {
    recipeVersion: 1;
    id: string;
    title: string;
    seed: number;
    engineRequirement: string;
    geometry: GeometryRecipe;
    clock: {
        ticksPerDay: number;
        calendarId: string;
        burnInTicks: number;
        startTick?: number;
    };
    variables: VariableDefinition[];
    componentSchemas: ComponentSchemaDefinition[];
    modules: ModuleRecipe[];
    generationPipeline: GenerationPassRecipe[];
    lodTiers: LODTierRecipe[];
    contentPacks: VersionedRef[];
    metadata?: Record<string, JsonValue>;
}
export interface SpatialRef {
    frameId: string;
    x: number;
    y: number;
    z?: number;
    regionId?: string;
}
export interface WorldEntity {
    id: EntityId;
    kind: string;
    subtype?: string;
    bornTick?: WorldTick;
    endedTick?: WorldTick;
    spatial?: SpatialRef;
    components: Record<string, JsonValue>;
    tags?: string[];
    provenanceIds: string[];
}
export interface WorldRelation {
    id: RelationId;
    kind: string;
    sourceId: EntityId;
    targetId: EntityId;
    startTick?: WorldTick;
    endTick?: WorldTick;
    data?: Record<string, JsonValue>;
    provenanceIds: string[];
}
export interface WorldEventRecord {
    id: EventId;
    kind: string;
    tick: WorldTick;
    actorIds: EntityId[];
    targetIds: EntityId[];
    location?: SpatialRef;
    data: Record<string, JsonValue>;
    causeIds: string[];
    provenanceIds: string[];
}
export interface CausalRecord {
    id: string;
    kind: 'generated-premise' | 'law' | 'state-transition' | 'observation' | 'inference' | 'transmission' | 'intervention';
    parentIds: string[];
    tick?: WorldTick;
    hiddenTruth: boolean;
    payload: Record<string, JsonValue>;
}
export interface KnowledgeRecord {
    id: string;
    holderId: EntityId;
    subjectIds: string[];
    acquiredTick: WorldTick;
    confidence: number;
    sourceKnowledgeId?: string;
    sourceEntityId?: EntityId;
    claim: Record<string, JsonValue>;
    truthLinkIds?: string[];
}
export interface WorldManifest {
    contractVersion: '1.0.0';
    engineVersion: string;
    recipeId: string;
    seed: number;
    currentTick: WorldTick;
    geometry: GeometryRecipe;
    lodTierIds: string[];
    variableDefinitions: VariableDefinition[];
    enabledModules: VersionedRef[];
    contentPacks: VersionedRef[];
    capabilities: string[];
}
export interface WorldSnapshot {
    manifest: WorldManifest;
    entities: WorldEntity[];
    relations: WorldRelation[];
    events: WorldEventRecord[];
    causalRecords: CausalRecord[];
    knowledge: KnowledgeRecord[];
    aggregates: Record<string, JsonValue>;
}
export interface AreaQuery {
    center: SpatialRef;
    radiusKm: number;
    requestedDetailRank: number;
    entityKinds?: string[];
    observerId?: EntityId;
    includeKnowledgeProjection?: boolean;
}
export interface AreaProjection {
    tick: WorldTick;
    effectiveDetailRank: number;
    entities: WorldEntity[];
    relations: WorldRelation[];
    aggregates: Record<string, JsonValue>;
    observationIds: string[];
}
export interface WorldCommand {
    id: string;
    issuedTick: WorldTick;
    issuerId?: EntityId;
    kind: string;
    targets?: EntityId[];
    location?: SpatialRef;
    payload: Record<string, JsonValue>;
    epistemicBasisIds?: string[];
}
export interface CommandResult {
    commandId: string;
    accepted: boolean;
    reason?: string;
    eventIds: EventId[];
    causalRecordIds: string[];
}
export interface AdvanceRequest {
    toTick: WorldTick;
    activeRegions?: Array<{
        center: SpatialRef;
        radiusKm: number;
        requestedDetailRank: number;
    }>;
    observationOwnerIds?: EntityId[];
}
export interface AdvanceResult {
    fromTick: WorldTick;
    toTick: WorldTick;
    eventIds: EventId[];
    changedEntityIds: EntityId[];
    changedAggregateKeys: string[];
}
export interface WorldProvider {
    getManifest(): Promise<WorldManifest>;
    getEntity(id: EntityId, observerId?: EntityId): Promise<WorldEntity | null>;
    queryArea(query: AreaQuery): Promise<AreaProjection>;
    getKnowledge(holderId: EntityId, subjectId?: string): Promise<KnowledgeRecord[]>;
    issueCommand(command: WorldCommand): Promise<CommandResult>;
    advance(request: AdvanceRequest): Promise<AdvanceResult>;
    exportSnapshot(detailRank?: number): Promise<WorldSnapshot>;
}

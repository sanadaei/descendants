import { ContentPackRegistry } from './content.js';
import { assertLoreCorpus } from './lore.js';
import { sortGenerationPasses } from './dag.js';
import { builtinModules } from './modules.js';
import { assertWorldRecipe } from './recipe.js';
import { ModuleRegistry } from './registry.js';
import { RngStreams } from './rng.js';
import { SnapshotBuilder } from './state.js';
import { clamp, deepClone, stableHash32, stableId } from './util.js';
import { WORLDGEN_ENGINE_VERSION, satisfiesEngineRequirement } from './version.js';
import { validateComponentSchemas } from './diagnostics.js';
import { worldLawEffectOperatorRegistry } from './effects.js';
import { lodCoarseningPolicyRegistry } from './lod.js';
import { geometryTopologyRegistry } from './topology.js';
import { demographyPolicyRegistry } from './demography.js';
export const ENGINE_VERSION = WORLDGEN_ENGINE_VERSION;
function configuredLodPolicyIds(recipe) {
    const config = recipe.modules.find((module) => module.id === 'lod' && module.enabled)?.config ?? {};
    return Array.isArray(config.coarseningPolicyIds)
        ? config.coarseningPolicyIds.filter((value) => typeof value === 'string' && value.length > 0)
        : [];
}
export function createBuiltinRegistry() {
    const registry = new ModuleRegistry();
    for (const module of builtinModules)
        registry.register(module);
    return registry;
}
function initialSnapshot(recipe, registry) {
    const enabledModules = recipe.modules.filter((module) => module.enabled).map((module) => {
        const implementation = registry.require(module.id);
        return { id: module.id, version: module.version ?? implementation.version };
    });
    const capabilities = [...new Set(enabledModules.flatMap((ref) => registry.require(ref.id).capabilities ?? []))].sort();
    const manifest = {
        contractVersion: '1.0.0',
        engineVersion: ENGINE_VERSION,
        recipeId: recipe.id,
        seed: recipe.seed,
        currentTick: recipe.clock.startTick ?? 0,
        geometry: deepClone(recipe.geometry),
        lodTierIds: recipe.lodTiers.slice().sort((a, b) => a.detailRank - b.detailRank).map((tier) => tier.id),
        variableDefinitions: deepClone(recipe.variables),
        enabledModules,
        contentPacks: deepClone(recipe.contentPacks),
        capabilities,
    };
    return { manifest, entities: [], relations: [], events: [], causalRecords: [], knowledge: [], aggregates: {} };
}
export class WorldgenEngine {
    registry;
    content;
    constructor(registry = createBuiltinRegistry(), content = new ContentPackRegistry()) { this.registry = registry; this.content = content; }
    async generate(recipe) {
        assertWorldRecipe(recipe);
        if (!satisfiesEngineRequirement(ENGINE_VERSION, recipe.engineRequirement))
            throw new Error(`Engine ${ENGINE_VERSION} does not satisfy recipe requirement ${recipe.engineRequirement}`);
        if (this.content.list().length > 0) {
            this.content.validateReferences(recipe.contentPacks);
            assertLoreCorpus(this.content);
        }
        const snapshot = initialSnapshot(recipe, this.registry);
        const rng = new RngStreams(recipe.seed);
        const state = new Map();
        for (const pass of sortGenerationPasses(recipe.generationPipeline)) {
            const moduleRecipe = recipe.modules.find((module) => module.id === pass.moduleId);
            const implementation = this.registry.require(pass.moduleId);
            const provenance = (passId, payload = {}) => {
                const id = stableId('prov', recipe.id, passId, payload);
                if (!snapshot.causalRecords.some((record) => record.id === id)) {
                    snapshot.causalRecords.push({ id, kind: 'generated-premise', parentIds: [], hiddenTruth: false, payload: { passId, moduleId: pass.moduleId, ...payload } });
                }
                return id;
            };
            const context = { recipe, state, snapshot, rng, content: this.content, pass, provenance };
            const mergedConfig = { ...moduleRecipe.config, ...(pass.config ?? {}) };
            await implementation.runPass(pass.id, mergedConfig, context);
            provenance(pass.id, { status: 'completed' });
        }
        const schemaErrors = validateComponentSchemas(snapshot, recipe);
        if (schemaErrors.length)
            throw new Error(`Generated snapshot violates component schemas:\n${schemaErrors.join('\n')}`);
        snapshot.aggregates.diagnostics = {
            generationDigest: snapshotDigest(snapshot),
            generationPasses: sortGenerationPasses(recipe.generationPipeline).map((pass) => pass.id),
        };
        return new GeneratedWorld(recipe, snapshot);
    }
    fromSnapshot(recipe, snapshot) {
        assertWorldRecipe(recipe);
        if (snapshot.manifest.contractVersion !== '1.0.0')
            throw new Error(`Unsupported snapshot contract ${snapshot.manifest.contractVersion}`);
        if (snapshot.manifest.recipeId !== recipe.id)
            throw new Error(`Snapshot recipe ${snapshot.manifest.recipeId} does not match ${recipe.id}`);
        return new GeneratedWorld(recipe, deepClone(snapshot));
    }
}
function distanceKm(a, b, recipe) {
    if (recipe.geometry.spaceModel === 'spherical') {
        const width = recipe.geometry.extent.widthKm;
        const height = recipe.geometry.extent.heightKm;
        const radius = width / (2 * Math.PI);
        const lon = (x) => ((x / width) * 2 - 1) * Math.PI;
        const lat = (y) => (0.5 - y / height) * Math.PI;
        const lat1 = lat(a.y);
        const lat2 = lat(b.y);
        let dLon = lon(a.x) - lon(b.x);
        if (dLon > Math.PI)
            dLon -= 2 * Math.PI;
        if (dLon < -Math.PI)
            dLon += 2 * Math.PI;
        const dLat = lat1 - lat2;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        const surface = 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
        return Math.hypot(surface, (a.z ?? 0) - (b.z ?? 0));
    }
    let dx = Math.abs(a.x - b.x);
    let dy = Math.abs(a.y - b.y);
    if (recipe.geometry.wrapX)
        dx = Math.min(dx, recipe.geometry.extent.widthKm - dx);
    if (recipe.geometry.wrapY)
        dy = Math.min(dy, recipe.geometry.extent.heightKm - dy);
    const dz = (a.z ?? 0) - (b.z ?? 0);
    if (recipe.geometry.spaceModel === 'custom') {
        const config = recipe.geometry.config ?? {};
        const topologyId = typeof config.topologyId === 'string' ? config.topologyId : (typeof config.distanceMetric === 'string' ? config.distanceMetric : 'euclidean');
        return geometryTopologyRegistry.require(topologyId).distanceKm({ a, b: { ...b, frameId: a.frameId }, geometry: recipe.geometry });
    }
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function cloneEntity(entity) { return deepClone(entity); }
export class GeneratedWorld {
    recipe;
    snapshot;
    #rng;
    #chunkSizeKm;
    #spatialIndex = new Map();
    #entityById = new Map();
    #indexedEntityCount = 0;
    constructor(recipe, snapshot) {
        this.recipe = recipe;
        this.snapshot = snapshot;
        this.#rng = new RngStreams(recipe.seed);
        const configuredChunk = recipe.geometry.config?.streamChunkKm;
        const fallback = Math.max(16, Math.min(recipe.geometry.extent.widthKm, recipe.geometry.extent.heightKm) / 32);
        this.#chunkSizeKm = typeof configuredChunk === 'number' && Number.isFinite(configuredChunk) && configuredChunk > 0 ? configuredChunk : fallback;
        this.#rebuildSpatialIndex();
    }
    async getManifest() { return deepClone(this.snapshot.manifest); }
    async getEntity(id, observerId) {
        const entity = this.snapshot.entities.find((item) => item.id === id);
        if (!entity)
            return null;
        return observerId ? this.#projectEntity(entity, observerId) : cloneEntity(entity);
    }
    async queryArea(query) {
        if (!(query.radiusKm >= 0))
            throw new Error('radiusKm must be non-negative');
        const tier = this.#effectiveTier(query.requestedDetailRank);
        if (tier.populationMode === 'individual' && tier.materializeOnDemand)
            this.#materializeArea(query);
        if (this.#indexedEntityCount !== this.snapshot.entities.length)
            this.#rebuildSpatialIndex();
        const kinds = query.entityKinds ? new Set(query.entityKinds) : null;
        const candidates = this.#spatialCandidates(query.center, query.radiusKm);
        const entities = candidates.filter((entity) => {
            if (kinds && !kinds.has(entity.kind))
                return false;
            return entity.spatial ? distanceKm(entity.spatial, query.center, this.recipe) <= query.radiusKm : false;
        }).map((entity) => query.observerId ? this.#projectEntity(entity, query.observerId) : cloneEntity(entity));
        const ids = new Set(entities.map((entity) => entity.id));
        const relations = this.snapshot.relations.filter((relation) => ids.has(relation.sourceId) && ids.has(relation.targetId)).map(deepClone);
        const observationIds = query.observerId
            ? this.snapshot.knowledge.filter((record) => record.holderId === query.observerId && record.subjectIds.some((subject) => ids.has(subject))).map((record) => record.id)
            : [];
        const aggregates = {
            entityCount: entities.length,
            requestedDetailRank: query.requestedDetailRank,
            effectiveTierId: tier.id,
            streaming: {
                chunkSizeKm: this.#chunkSizeKm,
                indexedChunkCount: this.#spatialIndex.size,
                candidateEntityCount: candidates.length,
                totalEntityCount: this.snapshot.entities.length,
            },
        };
        if (query.includeKnowledgeProjection && query.observerId)
            aggregates.knowledge = this.snapshot.knowledge.filter((record) => record.holderId === query.observerId).map((record) => deepClone(record));
        return { tick: this.snapshot.manifest.currentTick, effectiveDetailRank: tier.detailRank, entities, relations, aggregates, observationIds };
    }
    async getKnowledge(holderId, subjectId) {
        return this.snapshot.knowledge.filter((record) => record.holderId === holderId && (!subjectId || record.subjectIds.includes(subjectId))).map(deepClone);
    }
    async issueCommand(command) {
        if (command.issuedTick !== this.snapshot.manifest.currentTick)
            return { commandId: command.id, accepted: false, reason: 'issuedTick must equal current world tick', eventIds: [], causalRecordIds: [] };
        if (command.issuerId && command.epistemicBasisIds?.length) {
            const owned = new Set(this.snapshot.knowledge.filter((record) => record.holderId === command.issuerId).map((record) => record.id));
            if (command.epistemicBasisIds.some((id) => !owned.has(id)))
                return { commandId: command.id, accepted: false, reason: 'epistemic basis is not held by issuer', eventIds: [], causalRecordIds: [] };
        }
        const targets = command.targets ?? [];
        if (targets.some((id) => !this.snapshot.entities.some((entity) => entity.id === id)))
            return { commandId: command.id, accepted: false, reason: 'unknown target', eventIds: [], causalRecordIds: [] };
        let eventTargets = [...targets];
        const builder = new SnapshotBuilder(this.snapshot);
        const cause = builder.causal('intervention', false, command.epistemicBasisIds ?? [], { commandId: command.id, kind: command.kind, payload: command.payload }, command.issuedTick);
        if (command.kind === 'set-variable') {
            const variableId = command.payload.variableId;
            const value = command.payload.value;
            if (typeof variableId !== 'string')
                return { commandId: command.id, accepted: false, reason: 'set-variable requires payload.variableId', eventIds: [], causalRecordIds: [] };
            const definition = this.recipe.variables.find((variable) => variable.id === variableId || `${variable.namespace}:${variable.id}` === variableId);
            if (!definition)
                return { commandId: command.id, accepted: false, reason: `unknown recipe variable ${variableId}`, eventIds: [], causalRecordIds: [] };
            for (const targetId of targets) {
                const target = this.snapshot.entities.find((entity) => entity.id === targetId);
                const variables = target.components.variables && typeof target.components.variables === 'object' && !Array.isArray(target.components.variables)
                    ? target.components.variables : {};
                variables[`${definition.namespace}:${definition.id}`] = value ?? null;
                target.components.variables = variables;
                target.provenanceIds.push(cause);
            }
        }
        if (command.kind === 'lod-record-commitment' || command.kind === 'lod-population-delta') {
            const resolvedAnchors = [];
            for (const targetId of targets) {
                const target = this.snapshot.entities.find((entity) => entity.id === targetId);
                const anchorId = target.kind === 'identity-anchor' ? target.id : typeof target.components.identityAnchorId === 'string' ? target.components.identityAnchorId : '';
                const anchor = this.snapshot.entities.find((entity) => entity.id === anchorId && entity.kind === 'identity-anchor');
                if (!anchor)
                    return { commandId: command.id, accepted: false, reason: 'LOD command target must resolve to an identity anchor', eventIds: [], causalRecordIds: [] };
                const commitments = Array.isArray(anchor.components.commitments) ? anchor.components.commitments : [];
                const commitment = command.payload.commitment ?? (command.kind === 'lod-population-delta' ? { kind: 'population-delta', delta: command.payload.delta ?? 0, tick: command.issuedTick } : command.payload);
                commitments.push(deepClone(commitment));
                anchor.components.commitments = commitments;
                anchor.provenanceIds.push(cause);
                resolvedAnchors.push(anchor.id);
                if (command.kind === 'lod-population-delta') {
                    const delta = command.payload.delta;
                    if (typeof delta !== 'number' || !Number.isInteger(delta))
                        return { commandId: command.id, accepted: false, reason: 'lod-population-delta requires integer payload.delta', eventIds: [], causalRecordIds: [] };
                    const cohortId = typeof anchor.components.cohortId === 'string' ? anchor.components.cohortId : '';
                    const cohort = this.snapshot.entities.find((entity) => entity.id === cohortId && entity.kind === 'population-cohort');
                    if (!cohort)
                        return { commandId: command.id, accepted: false, reason: 'identity anchor is missing its cohort', eventIds: [], causalRecordIds: [] };
                    const oldCount = Math.max(0, Math.round(Number(cohort.components.count ?? 0)));
                    const newCount = Math.max(0, oldCount + delta);
                    const appliedDelta = newCount - oldCount;
                    cohort.components.count = newCount;
                    cohort.provenanceIds.push(cause);
                    const settlementId = typeof cohort.components.settlementId === 'string' ? cohort.components.settlementId : '';
                    const settlement = this.snapshot.entities.find((entity) => entity.id === settlementId && entity.kind === 'settlement');
                    if (settlement) {
                        settlement.components.population = Math.max(0, Math.round(Number(settlement.components.population ?? 0)) + appliedDelta);
                        settlement.provenanceIds.push(cause);
                    }
                }
            }
            eventTargets = resolvedAnchors;
        }
        const event = builder.event(`command:${command.kind}`, command.issuedTick, command.issuerId ? [command.issuerId] : [], eventTargets, command.payload, [cause], [cause], command.location);
        return { commandId: command.id, accepted: true, eventIds: [event.id], causalRecordIds: [cause] };
    }
    async advance(request) {
        const fromTick = this.snapshot.manifest.currentTick;
        if (!Number.isSafeInteger(request.toTick) || request.toTick < fromTick)
            throw new Error('advance.toTick must be a safe integer >= currentTick');
        const eventIds = [];
        const changed = new Set();
        const interval = this.recipe.clock.ticksPerDay;
        const firstStep = Math.floor(fromTick / interval) + 1;
        const lastStep = Math.floor(request.toTick / interval);
        const builder = new SnapshotBuilder(this.snapshot);
        const recordValue = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const readComponentPath = (entity, path) => {
            const parts = path.split('.').filter(Boolean);
            let cursor = entity.components;
            for (const part of parts) {
                if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))
                    return undefined;
                cursor = cursor[part];
            }
            return cursor;
        };
        const writeComponentPath = (entity, path, value) => {
            const parts = path.split('.').filter(Boolean);
            if (!parts.length)
                return;
            let cursor = entity.components;
            for (const part of parts.slice(0, -1)) {
                const child = cursor[part];
                if (!child || typeof child !== 'object' || Array.isArray(child))
                    cursor[part] = {};
                cursor = cursor[part];
            }
            cursor[parts[parts.length - 1]] = value;
        };
        const ecologyRuntimeConfig = this.recipe.modules.find((module) => module.id === 'ecology' && module.enabled)?.config ?? {};
        const extinctionThresholdFraction = Math.max(0, Math.min(0.25, Number(ecologyRuntimeConfig.extinctionThresholdFraction ?? 0.0005)));
        const invasionChancePerDay = Math.max(0, Math.min(1, Number(ecologyRuntimeConfig.invasionChancePerDay ?? 0.015)));
        const invasionColonizationFraction = Math.max(0.0001, Math.min(0.25, Number(ecologyRuntimeConfig.invasionColonizationFraction ?? 0.015)));
        const invasionSourceFraction = Math.max(0, Math.min(1, Number(ecologyRuntimeConfig.invasionSourceFraction ?? 0.12)));
        const geographyRuntimeConfig = this.recipe.modules.find((module) => module.id === 'geography' && module.enabled)?.config ?? {};
        const runtimeGeomorphologyIntervalDays = Math.max(0, Math.round(Number(geographyRuntimeConfig.runtimeGeomorphologyIntervalDays ?? 0)));
        const runtimeErosionRate = Math.max(0, Math.min(0.05, Number(geographyRuntimeConfig.runtimeErosionRate ?? 0.0008)));
        const runtimeSedimentationRate = Math.max(0, Math.min(2, Number(geographyRuntimeConfig.runtimeSedimentationRate ?? 0.65)));
        const populationRuntimeConfig = this.recipe.modules.find((module) => module.id === 'population' && module.enabled)?.config ?? {};
        const demographyPolicyIds = Array.isArray(populationRuntimeConfig.demographyPolicyIds)
            ? populationRuntimeConfig.demographyPolicyIds.filter((value) => typeof value === 'string' && value.length > 0)
            : [];
        const demographyPolicyConfigs = recordValue(populationRuntimeConfig.demographyPolicyConfigs);
        const settlementRegion = new Map(this.snapshot.entities.filter((entity) => entity.kind === 'settlement').map((entity) => [entity.id, String(entity.components.regionId ?? entity.spatial?.regionId ?? '')]));
        const adjacentRegions = new Map();
        for (const route of this.snapshot.relations.filter((relation) => relation.kind === 'route-link')) {
            const a = settlementRegion.get(route.sourceId);
            const b = settlementRegion.get(route.targetId);
            if (!a || !b || a === b)
                continue;
            if (!adjacentRegions.has(a))
                adjacentRegions.set(a, new Set());
            if (!adjacentRegions.has(b))
                adjacentRegions.set(b, new Set());
            adjacentRegions.get(a).add(b);
            adjacentRegions.get(b).add(a);
        }
        const informationRuntimeConfig = this.recipe.modules.find((module) => module.id === 'information-ecology' && module.enabled)?.config ?? {};
        const runtimeTransmissionBudgetPerDay = Math.max(0, Math.round(Number(informationRuntimeConfig.runtimeTransmissionBudgetPerDay ?? 0)));
        const runtimeMapRevisionBudgetPerDay = Math.max(0, Math.round(Number(informationRuntimeConfig.runtimeMapRevisionBudgetPerDay ?? runtimeTransmissionBudgetPerDay)));
        for (let step = firstStep; step <= lastStep; step += 1) {
            const tick = step * interval;
            // Regenerate/deplete ecological stocks once per canonical day. This is deterministic by resource identity + day.
            for (const resource of this.snapshot.entities.filter((entity) => entity.kind === 'ecological-resource')) {
                const capacity = Math.max(1, Number(resource.components.carryingStock ?? 1));
                const oldStock = Math.max(0, Number(resource.components.currentStock ?? 0));
                const baseRegeneration = Math.max(0, Number(resource.components.regenerationPerDay ?? 0));
                const region = this.snapshot.entities.find((entity) => entity.id === resource.components.regionId && entity.kind === 'region');
                const environment = recordValue(region?.components.environment);
                const disturbance = Math.max(0, Math.min(1, Number(environment.disturbanceIndex ?? 0)));
                const rng = this.#rng.stream('ecology-runtime', resource.id, step);
                const densityBrake = Math.max(0, 1 - oldStock / capacity);
                let nextStock = Math.min(capacity, oldStock + baseRegeneration * (0.25 + densityBrake * 0.75));
                if (disturbance > 0 && rng.bool(Math.min(0.12, disturbance * 0.015))) {
                    const loss = Math.min(nextStock, nextStock * rng.float(0.005, 0.04) * (0.4 + disturbance));
                    nextStock -= loss;
                    if (loss > 0) {
                        const cause = builder.causal('state-transition', false, resource.provenanceIds, { transition: 'ecological-disturbance-loss', resourceId: resource.id, loss, disturbance }, tick);
                        const event = builder.event('ecological-resource-disturbance', tick, [], [resource.id], { loss, disturbance }, [cause], [cause], resource.spatial);
                        eventIds.push(event.id);
                    }
                }
                resource.components.currentStock = nextStock;
                resource.components.depletionFraction = Math.max(0, Math.min(1, 1 - nextStock / capacity));
                changed.add(resource.id);
            }
            for (const guild of this.snapshot.entities.filter((entity) => entity.kind === 'ecological-guild')) {
                const capacity = Math.max(1, Number(guild.components.abundanceCapacity ?? 1));
                const oldAbundance = Math.max(0, Number(guild.components.abundance ?? 0));
                const resourceDependencies = this.snapshot.relations.filter((relation) => relation.sourceId === guild.id && relation.kind === 'guild-depends-on-resource');
                const trophicDependencies = this.snapshot.relations.filter((relation) => relation.sourceId === guild.id && relation.kind === 'trophic-dependency');
                const resourceSupply = resourceDependencies.length ? resourceDependencies.reduce((sum, relation) => {
                    const resource = this.snapshot.entities.find((entity) => entity.id === relation.targetId);
                    const ratio = resource ? Math.max(0, Math.min(1, Number(resource.components.currentStock ?? 0) / Math.max(1, Number(resource.components.carryingStock ?? 1)))) : 0;
                    return sum + ratio * Math.max(0.05, Number(relation.data?.dependencyStrength ?? 1));
                }, 0) / resourceDependencies.reduce((sum, relation) => sum + Math.max(0.05, Number(relation.data?.dependencyStrength ?? 1)), 0) : 1;
                const trophicSupply = trophicDependencies.length ? trophicDependencies.reduce((sum, relation) => {
                    const prey = this.snapshot.entities.find((entity) => entity.id === relation.targetId);
                    const ratio = prey ? Math.max(0, Math.min(1, Number(prey.components.abundance ?? 0) / Math.max(1, Number(prey.components.abundanceCapacity ?? 1)))) : 0;
                    return sum + ratio * Math.max(0.05, Number(relation.data?.dependencyStrength ?? 1));
                }, 0) / trophicDependencies.reduce((sum, relation) => sum + Math.max(0.05, Number(relation.data?.dependencyStrength ?? 1)), 0) : 1;
                const supply = resourceDependencies.length && trophicDependencies.length ? resourceSupply * 0.62 + trophicSupply * 0.38 : resourceDependencies.length ? resourceSupply : trophicSupply;
                const reproduction = Math.max(0, Number(guild.components.reproductionRatePerDay ?? 0.001));
                const mortality = Math.max(0, Number(guild.components.mortalityRatePerDay ?? 0.001));
                const growth = oldAbundance * reproduction * Math.max(0, 1 - oldAbundance / capacity) * (0.25 + supply * 0.75) - oldAbundance * mortality * (1.15 - supply * 0.3);
                let nextAbundance = Math.max(0, Math.min(capacity, oldAbundance + growth));
                const threshold = capacity * extinctionThresholdFraction;
                const status = String(guild.components.status ?? 'present');
                if (nextAbundance <= threshold && oldAbundance > threshold) {
                    nextAbundance = 0;
                    guild.components.status = 'extinct';
                    guild.components.extinctTick = tick;
                    const cause = builder.causal('state-transition', false, guild.provenanceIds, { transition: 'guild-extinction', guildId: guild.id, regionId: guild.components.regionId ?? null, supply }, tick);
                    const event = builder.event('ecological-guild-extinction', tick, [], [guild.id], { supply, previousAbundance: oldAbundance }, [cause], [cause], guild.spatial);
                    eventIds.push(event.id);
                }
                else if ((status === 'extinct' || oldAbundance <= threshold) && nextAbundance <= threshold && invasionChancePerDay > 0) {
                    const regionId = String(guild.components.regionId ?? '');
                    const guildKind = String(guild.components.guildKind ?? '');
                    const neighbors = adjacentRegions.get(regionId) ?? new Set();
                    const source = this.snapshot.entities.find((entity) => entity.kind === 'ecological-guild' && neighbors.has(String(entity.components.regionId ?? '')) && entity.components.guildKind === guildKind && Number(entity.components.abundance ?? 0) >= Math.max(1, Number(entity.components.abundanceCapacity ?? 1) * invasionSourceFraction));
                    const invasionRng = this.#rng.stream('ecology-invasion', guild.id, step);
                    if (source && supply > 0.12 && invasionRng.bool(invasionChancePerDay)) {
                        nextAbundance = Math.max(1, Math.min(capacity, capacity * invasionColonizationFraction * (0.5 + supply * 0.5)));
                        guild.components.status = 'present';
                        guild.components.lastInvasionTick = tick;
                        const cause = builder.causal('state-transition', false, [...guild.provenanceIds, ...source.provenanceIds], { transition: 'guild-invasion', guildId: guild.id, sourceGuildId: source.id, regionId, supply }, tick);
                        const event = builder.event('ecological-guild-invasion', tick, [source.id], [guild.id], { colonizedAbundance: nextAbundance, supply }, [cause], [cause], guild.spatial);
                        eventIds.push(event.id);
                    }
                }
                guild.components.abundance = nextAbundance;
                guild.components.resourceSupplyIndex = resourceSupply;
                guild.components.trophicSupplyIndex = trophicSupply;
                guild.components.combinedSupplyIndex = supply;
                changed.add(guild.id);
            }
            // Optional long-horizon geomorphic feedback. Region-scale physical state evolves from rainfall,
            // substrate hardness, roughness and floodplain deposition instead of remaining a burn-in-only summary.
            if (runtimeGeomorphologyIntervalDays > 0 && step % runtimeGeomorphologyIntervalDays === 0) {
                for (const region of this.snapshot.entities.filter((entity) => entity.kind === 'region')) {
                    const geology = recordValue(region.components.geology);
                    const terrain = recordValue(region.components.terrain);
                    const atmosphere = recordValue(region.components.atmosphere);
                    const oldErosion = clamp(Number(geology.erosionIndex ?? 0));
                    const oldSediment = clamp(Number(geology.sedimentIndex ?? 0));
                    const oldElevation = clamp(Number(terrain.elevationIndex ?? 0));
                    const oldFloodplain = clamp(Number(terrain.floodplainFraction ?? 0));
                    const rainfall = clamp(Number(terrain.rainfallIndex ?? atmosphere.rainfallIndex ?? 0.5));
                    const hardness = clamp(Number(geology.meanRockHardness ?? 0.5));
                    const roughness = clamp(Number(terrain.roughnessIndex ?? 0.5));
                    const erosiveForce = rainfall * (0.45 + roughness * 0.55) * (1 - hardness * 0.72);
                    const erosionDelta = runtimeErosionRate * runtimeGeomorphologyIntervalDays * Math.max(0, erosiveForce);
                    const depositionalOpportunity = clamp(oldFloodplain * 0.65 + Number(terrain.riverFraction ?? 0) * 0.35);
                    const sedimentDelta = erosionDelta * runtimeSedimentationRate * (0.25 + depositionalOpportunity * 0.75);
                    const nextErosion = clamp(oldErosion + erosionDelta * (1 - oldErosion));
                    const nextSediment = clamp(oldSediment + sedimentDelta * (1 - oldSediment));
                    const nextElevation = clamp(oldElevation - erosionDelta * 0.08 + sedimentDelta * 0.025);
                    const nextFloodplain = clamp(oldFloodplain + sedimentDelta * 0.12 - erosionDelta * 0.01);
                    geology.erosionIndex = nextErosion;
                    geology.sedimentIndex = nextSediment;
                    terrain.elevationIndex = nextElevation;
                    terrain.floodplainFraction = nextFloodplain;
                    const strata = Array.isArray(geology.strata) ? geology.strata : [];
                    if (strata.length) {
                        const surface = strata[strata.length - 1];
                        if (surface && typeof surface === 'object' && !Array.isArray(surface)) {
                            const surfaceRecord = surface;
                            surfaceRecord.depositionalIndex = clamp(Number(surfaceRecord.depositionalIndex ?? oldSediment) + sedimentDelta);
                            surfaceRecord.relativeThickness = clamp(Number(surfaceRecord.relativeThickness ?? 0.2) + sedimentDelta * 0.05);
                        }
                    }
                    region.components.geology = geology;
                    region.components.terrain = terrain;
                    changed.add(region.id);
                    if (erosionDelta > 0 || sedimentDelta > 0) {
                        const cause = builder.causal('state-transition', false, region.provenanceIds, { transition: 'geomorphic-feedback', regionId: region.id, erosionDelta, sedimentDelta }, tick);
                        const event = builder.event('geomorphic-feedback', tick, [], [region.id], { from: { erosionIndex: oldErosion, sedimentIndex: oldSediment, elevationIndex: oldElevation, floodplainFraction: oldFloodplain }, to: { erosionIndex: nextErosion, sedimentIndex: nextSediment, elevationIndex: nextElevation, floodplainFraction: nextFloodplain }, rainfall, hardness, roughness }, [cause], [cause], region.spatial);
                        eventIds.push(event.id);
                    }
                }
            }
            for (const settlement of this.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined)) {
                const rng = this.#rng.stream('advance', settlement.id, step);
                const oldPop = typeof settlement.components.population === 'number' ? settlement.components.population : 0;
                const economy = settlement.components.economy && typeof settlement.components.economy === 'object' && !Array.isArray(settlement.components.economy)
                    ? settlement.components.economy : {};
                const economicResources = recordValue(economy.resources);
                const labor = recordValue(economy.labor);
                const laborConstraint = Math.max(0, Math.min(1, Number(labor.constraint ?? 1)));
                const regionId = String(settlement.components.regionId ?? '');
                let shortageTotal = 0;
                let shortageCount = 0;
                for (const [resourceId, raw] of Object.entries(economicResources)) {
                    const item = recordValue(raw);
                    const desiredProduction = Math.max(0, Number(item.productionPerDay ?? 0));
                    const consumption = Math.max(0, Number(item.consumptionPerDay ?? 0));
                    const inputs = Array.isArray(item.ecologicalInputs) ? item.ecologicalInputs.filter((value) => !!value && typeof value === 'object' && !Array.isArray(value)) : [];
                    let ecologicalConstraint = 1;
                    for (const input of inputs) {
                        const kind = String(input.resourceKind ?? '');
                        const extractionPerOutput = Math.max(0, Number(input.extractionPerOutput ?? 0));
                        if (extractionPerOutput <= 0)
                            continue;
                        const ecological = this.snapshot.entities.find((entity) => entity.kind === 'ecological-resource' && entity.components.regionId === regionId && entity.components.resourceKind === kind);
                        if (!ecological) {
                            ecologicalConstraint = Math.min(ecologicalConstraint, 0);
                            continue;
                        }
                        const available = Math.max(0, Number(ecological.components.currentStock ?? 0));
                        const required = desiredProduction * extractionPerOutput;
                        if (required > 0)
                            ecologicalConstraint = Math.min(ecologicalConstraint, available / required);
                    }
                    ecologicalConstraint = Math.max(0, Math.min(1, ecologicalConstraint));
                    const economicInputs = Array.isArray(item.economicInputs) ? item.economicInputs.filter((value) => !!value && typeof value === 'object' && !Array.isArray(value)) : [];
                    let chainConstraint = 1;
                    for (const input of economicInputs) {
                        const inputResourceId = String(input.resourceId ?? '');
                        const unitsPerOutput = Math.max(0, Number(input.unitsPerOutput ?? 0));
                        if (!inputResourceId || unitsPerOutput <= 0)
                            continue;
                        const sourceItem = recordValue(economicResources[inputResourceId]);
                        const availableInput = Math.max(0, Number(sourceItem.stock ?? 0));
                        const requiredInput = desiredProduction * unitsPerOutput;
                        if (requiredInput > 0)
                            chainConstraint = Math.min(chainConstraint, availableInput / requiredInput);
                    }
                    chainConstraint = Math.max(0, Math.min(1, chainConstraint));
                    const actualProduction = desiredProduction * laborConstraint * ecologicalConstraint * chainConstraint;
                    for (const input of economicInputs) {
                        const inputResourceId = String(input.resourceId ?? '');
                        const unitsPerOutput = Math.max(0, Number(input.unitsPerOutput ?? 0));
                        if (!inputResourceId || unitsPerOutput <= 0)
                            continue;
                        const sourceItem = recordValue(economicResources[inputResourceId]);
                        const used = Math.min(Math.max(0, Number(sourceItem.stock ?? 0)), actualProduction * unitsPerOutput);
                        sourceItem.stock = Math.max(0, Number(sourceItem.stock ?? 0) - used);
                        sourceItem.usedAsInputPerDay = Number(sourceItem.usedAsInputPerDay ?? 0) + used;
                        economicResources[inputResourceId] = sourceItem;
                    }
                    for (const input of inputs) {
                        const kind = String(input.resourceKind ?? '');
                        const extractionPerOutput = Math.max(0, Number(input.extractionPerOutput ?? 0));
                        const ecological = this.snapshot.entities.find((entity) => entity.kind === 'ecological-resource' && entity.components.regionId === regionId && entity.components.resourceKind === kind);
                        if (!ecological || extractionPerOutput <= 0)
                            continue;
                        const extraction = Math.min(Number(ecological.components.currentStock ?? 0), actualProduction * extractionPerOutput);
                        ecological.components.currentStock = Math.max(0, Number(ecological.components.currentStock ?? 0) - extraction);
                        ecological.components.depletionFraction = Math.max(0, Math.min(1, 1 - Number(ecological.components.currentStock ?? 0) / Math.max(1, Number(ecological.components.carryingStock ?? 1))));
                        changed.add(ecological.id);
                    }
                    const oldStock = Math.max(0, Number(item.stock ?? 0));
                    const available = oldStock + actualProduction;
                    const consumed = Math.min(available, consumption);
                    const unmet = Math.max(0, consumption - consumed);
                    const nextStock = Math.max(0, available - consumed);
                    const shortageIndex = consumption > 0 ? Math.max(0, Math.min(1, unmet / consumption)) : 0;
                    item.actualProductionPerDay = actualProduction;
                    item.actualConsumptionPerDay = consumed;
                    item.unmetDemandPerDay = unmet;
                    item.balancePerDay = actualProduction - consumption;
                    item.stock = nextStock;
                    item.ecologicalConstraint = ecologicalConstraint;
                    item.productionChainConstraint = chainConstraint;
                    item.shortageIndex = shortageIndex;
                    shortageTotal += shortageIndex;
                    shortageCount += 1;
                    economicResources[resourceId] = item;
                }
                economy.resources = economicResources;
                const shortageIndex = shortageCount ? shortageTotal / shortageCount : 0;
                economy.shortageIndex = shortageIndex;
                settlement.components.economy = economy;
                if (shortageIndex >= 0.2) {
                    const cause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'economic-shortage', settlementId: settlement.id, shortageIndex }, tick);
                    const event = builder.event('economic-shortage', tick, [settlement.id], [], { shortageIndex }, [cause], [cause], settlement.spatial);
                    eventIds.push(event.id);
                }
                const production = typeof economy.productionIndex === 'number' ? economy.productionIndex : 0.5;
                const survivalFactor = Math.max(0.2, 1 - shortageIndex * 0.85);
                const cohort = this.snapshot.entities.find((entity) => entity.kind === 'population-cohort' && entity.components.settlementId === settlement.id);
                let policyPopulationDelta = 0;
                let policyHealthDelta = 0;
                let policyDependencyDelta = 0;
                let formationMultiplier = 1;
                let dissolutionMultiplier = 1;
                for (const policyId of demographyPolicyIds) {
                    const policy = demographyPolicyRegistry.require(policyId);
                    const rawPolicyConfig = demographyPolicyConfigs[policyId];
                    const policyConfig = rawPolicyConfig && typeof rawPolicyConfig === 'object' && !Array.isArray(rawPolicyConfig) ? rawPolicyConfig : {};
                    const result = policy.evaluate({ settlement, ...(cohort ? { cohort } : {}), tick, ticksPerDay: interval, shortageIndex, productionIndex: Number(production), currentPopulation: oldPop, policyConfig });
                    const births = Math.max(0, Number(result.birthRatePerDay ?? 0));
                    const deaths = Math.max(0, Number(result.deathRatePerDay ?? 0));
                    policyPopulationDelta += Math.round(oldPop * (births - deaths));
                    policyHealthDelta += Number(result.healthDelta ?? 0);
                    policyDependencyDelta += Number(result.dependencySupportDelta ?? 0);
                    formationMultiplier *= Math.max(0, Number(result.householdFormationMultiplier ?? 1));
                    dissolutionMultiplier *= Math.max(0, Number(result.householdDissolutionMultiplier ?? 1));
                }
                if (cohort && demographyPolicyIds.length) {
                    cohort.components.healthIndex = clamp(Number(cohort.components.healthIndex ?? 0.5) + policyHealthDelta);
                    const household = recordValue(cohort.components.householdDemography);
                    household.dependencySupportIndex = clamp(Number(household.dependencySupportIndex ?? 0.5) + policyDependencyDelta);
                    household.effectiveFormationRateAnnual = Math.max(0, Number(household.formationRateAnnual ?? 0.04) * formationMultiplier);
                    household.effectiveDissolutionRateAnnual = Math.max(0, Number(household.dissolutionRateAnnual ?? 0.03) * dissolutionMultiplier);
                    cohort.components.householdDemography = household;
                    changed.add(cohort.id);
                }
                const stochasticDelta = oldPop > 0 ? Math.round(oldPop * rng.float(-0.00035, 0.00045) * (0.5 + production) * survivalFactor - oldPop * shortageIndex * 0.00008) : 0;
                const delta = stochasticDelta + policyPopulationDelta;
                if (delta !== 0) {
                    settlement.components.population = Math.max(1, oldPop + delta);
                    if (cohort) {
                        cohort.components.count = settlement.components.population;
                        changed.add(cohort.id);
                    }
                    changed.add(settlement.id);
                }
                if (demographyPolicyIds.length) {
                    const cause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'demography-policy-application', settlementId: settlement.id, policyIds: demographyPolicyIds, policyPopulationDelta, policyHealthDelta, policyDependencyDelta }, tick);
                    const event = builder.event('demography-policy-transition', tick, [settlement.id], cohort ? [cohort.id] : [], { policyIds: demographyPolicyIds, policyPopulationDelta, stochasticDelta, totalDelta: delta }, [cause], [cause], settlement.spatial);
                    eventIds.push(event.id);
                }
                if (rng.bool(0.015)) {
                    const cause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'periodic-local-change', step }, tick);
                    const event = builder.event('local-state-transition', tick, [settlement.id], [], { magnitude: rng.float(-1, 1) }, [cause], [cause], settlement.spatial);
                    eventIds.push(event.id);
                }
            }
            // Runtime trade redistribution and endogenous valuation. Transfers use route capacity and conserve stock; late-arriving trade can satisfy same-day unmet demand.
            const activeSettlements = this.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined);
            const routeRelations = this.snapshot.relations.filter((relation) => relation.kind === 'route-link');
            const stockBeforeRuntimeTrade = activeSettlements.reduce((sum, settlement) => {
                const resources = recordValue(recordValue(settlement.components.economy).resources);
                return sum + Object.values(resources).reduce((subtotal, value) => subtotal + Math.max(0, Number(recordValue(value).stock ?? 0)), 0);
            }, 0);
            let runtimeTradeVolume = 0;
            for (const route of routeRelations) {
                const a = activeSettlements.find((entity) => entity.id === route.sourceId);
                const b = activeSettlements.find((entity) => entity.id === route.targetId);
                if (!a || !b)
                    continue;
                const accessibility = Math.max(0, Number(route.data?.accessibility ?? 0));
                const condition = Math.max(0, Number(route.data?.conditionIndex ?? 1));
                let capacity = Math.max(0, Number(route.data?.capacityIndex ?? 0)) * accessibility * condition * 160;
                const ae = recordValue(a.components.economy);
                const be = recordValue(b.components.economy);
                const ar = recordValue(ae.resources);
                const br = recordValue(be.resources);
                const resourceIds = [...new Set([...Object.keys(ar), ...Object.keys(br)])].sort();
                for (const resourceId of resourceIds) {
                    if (capacity <= 1e-9)
                        break;
                    const ai = recordValue(ar[resourceId]);
                    const bi = recordValue(br[resourceId]);
                    if (!Object.keys(ai).length || !Object.keys(bi).length)
                        continue;
                    const targetA = Math.max(0, Number(ai.targetStock ?? Number(ai.consumptionPerDay ?? 0) * 30));
                    const targetB = Math.max(0, Number(bi.targetStock ?? Number(bi.consumptionPerDay ?? 0) * 30));
                    const stockA = Math.max(0, Number(ai.stock ?? 0));
                    const stockB = Math.max(0, Number(bi.stock ?? 0));
                    const unmetA = Math.max(0, Number(ai.unmetDemandPerDay ?? 0));
                    const unmetB = Math.max(0, Number(bi.unmetDemandPerDay ?? 0));
                    const surplusA = Math.max(0, stockA - targetA * 0.55);
                    const surplusB = Math.max(0, stockB - targetB * 0.55);
                    const needA = unmetA + Math.max(0, targetA * 0.75 - stockA);
                    const needB = unmetB + Math.max(0, targetB * 0.75 - stockB);
                    let sender = a, receiver = b, si = ai, ri = bi, flow = Math.min(surplusA, needB, capacity);
                    if (flow <= 1e-9 && surplusB > 0 && needA > 0) {
                        sender = b;
                        receiver = a;
                        si = bi;
                        ri = ai;
                        flow = Math.min(surplusB, needA, capacity);
                    }
                    if (flow <= 1e-9)
                        continue;
                    si.stock = Math.max(0, Number(si.stock ?? 0) - flow);
                    ri.stock = Number(ri.stock ?? 0) + flow;
                    const unmet = Math.max(0, Number(ri.unmetDemandPerDay ?? 0));
                    const lateConsumed = Math.min(unmet, Number(ri.stock ?? 0));
                    if (lateConsumed > 0) {
                        ri.stock = Number(ri.stock ?? 0) - lateConsumed;
                        ri.unmetDemandPerDay = unmet - lateConsumed;
                        ri.actualConsumptionPerDay = Number(ri.actualConsumptionPerDay ?? 0) + lateConsumed;
                    }
                    ri.shortageIndex = Math.max(0, Math.min(1, Number(ri.unmetDemandPerDay ?? 0) / Math.max(1e-9, Number(ri.consumptionPerDay ?? 1))));
                    const cause = builder.causal('state-transition', false, route.provenanceIds, { transition: 'runtime-logistics-flow', routeId: route.id, resourceId, senderId: sender.id, receiverId: receiver.id, quantity: flow, lateConsumed }, tick);
                    const event = builder.event('runtime-logistics-flow', tick, [sender.id], [receiver.id], { routeId: route.id, resourceId, quantity: flow, lateConsumed }, [cause], [cause], sender.spatial);
                    eventIds.push(event.id);
                    changed.add(sender.id);
                    changed.add(receiver.id);
                    runtimeTradeVolume += flow;
                    capacity -= flow;
                }
            }
            let priceObservationCount = 0;
            for (const settlement of activeSettlements) {
                const economy = recordValue(settlement.components.economy);
                const resources = recordValue(economy.resources);
                let shortageTotal = 0;
                let count = 0;
                for (const [resourceId, raw] of Object.entries(resources)) {
                    const item = recordValue(raw);
                    const stock = Math.max(0, Number(item.stock ?? 0));
                    const target = Math.max(1e-9, Number(item.targetStock ?? 1));
                    const shortage = Math.max(0, Math.min(1, Number(item.shortageIndex ?? 0)));
                    const coverage = Math.max(0, Math.min(2, stock / target));
                    const routeAccess = Math.max(0, Math.min(1, Number(economy.routeAccessIndex ?? 0)));
                    const priceIndex = Math.max(0.05, 0.55 + shortage * 2.6 + Math.max(0, 1 - coverage) * 0.9 + (1 - routeAccess) * 0.18);
                    item.priceIndex = priceIndex;
                    item.stockCoverage = coverage;
                    shortageTotal += shortage;
                    count += 1;
                    priceObservationCount += 1;
                    resources[resourceId] = item;
                }
                economy.resources = resources;
                economy.shortageIndex = count ? shortageTotal / count : 0;
                settlement.components.economy = economy;
            }
            const stockAfterRuntimeTrade = activeSettlements.reduce((sum, settlement) => {
                const resources = recordValue(recordValue(settlement.components.economy).resources);
                return sum + Object.values(resources).reduce((subtotal, value) => subtotal + Math.max(0, Number(recordValue(value).stock ?? 0)), 0);
            }, 0);
            this.snapshot.aggregates.runtimeEconomy = { tradeVolume: runtimeTradeVolume, priceObservationCount, stockBeforeRuntimeTrade, stockAfterRuntimeTrade, stockChangeFromTradeAndLateConsumption: stockAfterRuntimeTrade - stockBeforeRuntimeTrade };
            // Optional runtime rumor propagation and iterative map revision. These operate only on observer knowledge and never rewrite canonical geometry/history.
            if (runtimeTransmissionBudgetPerDay > 0) {
                let propagated = 0;
                let revisedMaps = 0;
                const channels = this.snapshot.relations.filter((relation) => relation.kind === 'information-channel').sort((a, b) => a.id.localeCompare(b.id));
                for (const channel of channels) {
                    if (propagated >= runtimeTransmissionBudgetPerDay)
                        break;
                    const sourceRecords = this.snapshot.knowledge.filter((record) => record.holderId === channel.sourceId && record.acquiredTick <= tick).sort((a, b) => b.acquiredTick - a.acquiredTick || a.id.localeCompare(b.id));
                    const sourceRecord = sourceRecords.find((record) => !this.snapshot.knowledge.some((target) => target.holderId === channel.targetId && target.sourceKnowledgeId === record.id));
                    if (!sourceRecord)
                        continue;
                    const rng = this.#rng.stream('runtime-information-channel', channel.id, sourceRecord.id, step);
                    const regime = recordValue(channel.data?.runtimeRegime);
                    const regimeStart = Number(regime.startTick ?? -Infinity);
                    const regimeEnd = Number(regime.endTick ?? Infinity);
                    const regimeActive = tick >= regimeStart && tick <= regimeEnd;
                    const loss = clamp(Number(channel.data?.lossRate ?? 0) + (regimeActive ? Number(regime.lossRateDelta ?? 0) : 0));
                    const censorship = clamp(Number(channel.data?.censorshipRate ?? 0) + (regimeActive ? Number(regime.censorshipRateDelta ?? 0) : 0));
                    if (rng.bool(clamp(loss + censorship - loss * censorship)))
                        continue;
                    const distortion = clamp(Number(channel.data?.distortionRate ?? 0) + (regimeActive ? Number(regime.distortionRateDelta ?? 0) : 0));
                    const corrupted = rng.bool(distortion);
                    const reliability = clamp(Number(channel.data?.reliabilityIndex ?? 0.5) * (regimeActive ? Number(regime.reliabilityMultiplier ?? 1) : 1));
                    const authorityMultiplier = Math.max(0, Number(regimeActive ? regime.authorityMultiplier ?? 1 : 1));
                    const delay = Math.max(1, Math.round(Number(channel.data?.delayTicks ?? interval) * Math.max(0.05, Number(regimeActive ? regime.delayMultiplier ?? 1 : 1))));
                    const acquiredTick = Math.min(request.toTick, tick + delay);
                    const transmissionCause = builder.causal('transmission', false, [], { transition: 'runtime-rumor-propagation', channelId: channel.id, sourceKnowledgeId: sourceRecord.id, corrupted }, tick);
                    const targetRecord = {
                        id: stableId('know-runtime', channel.targetId, sourceRecord.id, step), holderId: channel.targetId, subjectIds: [...sourceRecord.subjectIds], acquiredTick,
                        confidence: clamp(sourceRecord.confidence * reliability * authorityMultiplier * (corrupted ? 0.72 : 0.94)), sourceKnowledgeId: sourceRecord.id, sourceEntityId: sourceRecord.holderId,
                        claim: { ...sourceRecord.claim, interpretation: corrupted ? 'runtime-rumor-distorted' : 'runtime-rumor', transmissionChannelId: channel.id, corrupted, regimeActive }, truthLinkIds: [transmissionCause],
                    };
                    this.snapshot.knowledge.push(targetRecord);
                    propagated += 1;
                    const event = builder.event('runtime-information-transmission', tick, [channel.sourceId], [channel.targetId], { sourceKnowledgeId: sourceRecord.id, targetKnowledgeId: targetRecord.id, channelId: channel.id, corrupted }, [transmissionCause], [transmissionCause], this.snapshot.entities.find((entity) => entity.id === channel.targetId)?.spatial);
                    eventIds.push(event.id);
                    if (revisedMaps < runtimeMapRevisionBudgetPerDay && sourceRecord.claim.interpretation === 'cartographic-estimate' && typeof sourceRecord.claim.regionId === 'string') {
                        const existing = this.snapshot.knowledge.filter((record) => record.holderId === channel.targetId && record.claim.interpretation === 'cartographic-estimate' && record.claim.regionId === sourceRecord.claim.regionId).sort((a, b) => b.acquiredTick - a.acquiredTick)[0];
                        const sourceCenter = recordValue(sourceRecord.claim.estimatedCenter);
                        const existingCenter = recordValue(existing?.claim.estimatedCenter);
                        if (existing && typeof sourceCenter.x === 'number' && typeof sourceCenter.y === 'number' && typeof existingCenter.x === 'number' && typeof existingCenter.y === 'number') {
                            const wa = Math.max(0.01, existing.confidence);
                            const wb = Math.max(0.01, targetRecord.confidence);
                            const total = wa + wb;
                            const mergedCenter = { x: (Number(existingCenter.x) * wa + Number(sourceCenter.x) * wb) / total, y: (Number(existingCenter.y) * wa + Number(sourceCenter.y) * wb) / total };
                            const oldUncertainty = Math.max(0, Number(existing.claim.uncertaintyRadiusKm ?? 0));
                            const incomingUncertainty = Math.max(0, Number(sourceRecord.claim.uncertaintyRadiusKm ?? oldUncertainty));
                            const disagreement = Math.hypot(Number(existingCenter.x) - Number(sourceCenter.x), Number(existingCenter.y) - Number(sourceCenter.y));
                            const mergedUncertainty = Math.max(0.01, (oldUncertainty * wa + incomingUncertainty * wb) / total * (disagreement > oldUncertainty + incomingUncertainty ? 1.15 : 0.82));
                            const revisionCause = builder.causal('inference', false, [transmissionCause], { transition: 'cartographic-revision', existingKnowledgeId: existing.id, incomingKnowledgeId: targetRecord.id, disagreement }, tick);
                            this.snapshot.knowledge.push({ id: stableId('know-map-revision', channel.targetId, existing.id, targetRecord.id, step), holderId: channel.targetId, subjectIds: [...new Set([...existing.subjectIds, ...targetRecord.subjectIds])], acquiredTick: tick, confidence: clamp((wa + wb) / 2), sourceKnowledgeId: targetRecord.id, claim: { interpretation: 'cartographic-estimate', regionId: sourceRecord.claim.regionId, estimatedCenter: mergedCenter, uncertaintyRadiusKm: mergedUncertainty, revisionOf: [existing.id, targetRecord.id], disagreementKm: disagreement }, truthLinkIds: [revisionCause] });
                            revisedMaps += 1;
                        }
                    }
                }
                this.snapshot.aggregates.runtimeInformation = { propagatedKnowledgeCount: propagated, cartographicRevisionCount: revisedMaps, tick };
            }
            const worldLawConfig = this.recipe.modules.find((module) => module.id === 'world-laws' && module.enabled)?.config ?? {};
            const rules = Array.isArray(worldLawConfig.rules) ? worldLawConfig.rules.filter((rule) => !!rule && typeof rule === 'object' && !Array.isArray(rule)) : [];
            for (const rule of rules) {
                const ruleId = typeof rule.id === 'string' ? rule.id : stableId('runtime-rule', rule);
                const rawEffects = Array.isArray(rule.effects) ? rule.effects.filter((effect) => !!effect && typeof effect === 'object' && !Array.isArray(effect)) : [];
                const effects = rawEffects.length ? rawEffects : typeof rule.targetVariable === 'string'
                    ? [{ targetVariable: rule.targetVariable, operation: 'add', perDay: rule.perDay ?? 0, stochastic: rule.stochastic ?? 0 }]
                    : [];
                const failure = recordValue(rule.failure);
                const failureChance = Math.max(0, Math.min(1, Number(failure.chancePerDay ?? rule.failureChancePerDay ?? 0)));
                const interactions = Array.isArray(rule.interactions) ? rule.interactions.filter((item) => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
                const lawEntity = this.snapshot.entities.find((entity) => entity.kind === 'world-law' && entity.components.ruleId === ruleId);
                for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
                    const effect = effects[effectIndex];
                    const targetVariable = typeof effect.targetVariable === 'string' ? effect.targetVariable : '';
                    const definition = targetVariable ? this.recipe.variables.find((variable) => `${variable.namespace}:${variable.id}` === targetVariable || variable.id === targetVariable) : undefined;
                    const key = definition ? `${definition.namespace}:${definition.id}` : targetVariable;
                    const entityKind = typeof effect.entityKind === 'string' ? effect.entityKind : '';
                    const componentPath = typeof effect.componentPath === 'string' ? effect.componentPath : '';
                    let targets = [];
                    if (definition) {
                        if (definition.scope === 'region')
                            targets = this.snapshot.entities.filter((entity) => entity.kind === 'region');
                        else if (definition.scope === 'world')
                            targets = this.snapshot.entities.filter((entity) => entity.kind === 'world');
                        else if (definition.scope === 'population')
                            targets = this.snapshot.entities.filter((entity) => entity.kind === 'population-cohort');
                        else if (definition.scope === 'institution')
                            targets = this.snapshot.entities.filter((entity) => entity.kind === 'institution');
                        else if (definition.scope === 'culture')
                            targets = this.snapshot.entities.filter((entity) => entity.kind === 'culture');
                        else
                            targets = this.snapshot.entities.filter((entity) => {
                                const variables = recordValue(entity.components.variables);
                                return key in variables;
                            });
                    }
                    else if (entityKind && componentPath)
                        targets = this.snapshot.entities.filter((entity) => entity.kind === entityKind);
                    if (request.activeRegions?.length) {
                        targets = targets.filter((entity) => !entity.spatial || request.activeRegions.some((area) => distanceKm(entity.spatial, area.center, this.recipe) <= area.radiusKm));
                    }
                    const carrier = recordValue(rule.carrier);
                    const range = recordValue(rule.range);
                    const sourceEntityIds = Array.isArray(range.sourceEntityIds) ? range.sourceEntityIds.filter((value) => typeof value === 'string') : [];
                    if (String(carrier.kind ?? '') === 'relation' && sourceEntityIds.length) {
                        const relationKind = String(carrier.relationKind ?? 'route-link');
                        const maxHops = Math.max(0, Math.round(Number(range.maxHops ?? 1)));
                        const reached = new Set(sourceEntityIds);
                        let frontier = new Set(sourceEntityIds);
                        for (let hop = 0; hop < maxHops && frontier.size; hop += 1) {
                            const next = new Set();
                            for (const relation of this.snapshot.relations.filter((item) => item.kind === relationKind)) {
                                if (frontier.has(relation.sourceId) && !reached.has(relation.targetId))
                                    next.add(relation.targetId);
                                if (frontier.has(relation.targetId) && !reached.has(relation.sourceId))
                                    next.add(relation.sourceId);
                            }
                            for (const id of next)
                                reached.add(id);
                            frontier = next;
                        }
                        targets = targets.filter((target) => reached.has(target.id));
                    }
                    else if (String(carrier.kind ?? '') === 'spatial' && sourceEntityIds.length) {
                        const radiusKm = Math.max(0, Number(range.radiusKm ?? 0));
                        const sources = sourceEntityIds.map((id) => this.snapshot.entities.find((entity) => entity.id === id)).filter((value) => !!value && !!value.spatial);
                        targets = targets.filter((target) => !target.spatial || sources.some((source) => distanceKm(target.spatial, source.spatial, this.recipe) <= radiusKm));
                    }
                    for (const target of targets) {
                        const rng = this.#rng.stream('world-law-runtime', ruleId, effectIndex, target.id, step);
                        if (failureChance > 0 && rng.bool(failureChance)) {
                            const failureCause = builder.causal('state-transition', Boolean(rule.hiddenTruth) || Boolean(definition?.hiddenTruth), lawEntity?.provenanceIds ?? [], { transition: 'world-law-failure', ruleId, effectIndex, targetId: target.id, failure }, tick);
                            const failureEvent = builder.event(`world-law-failure:${ruleId}`, tick, lawEntity ? [lawEntity.id] : [], [target.id], { effectIndex, failure }, [failureCause], [failureCause], target.spatial);
                            eventIds.push(failureEvent.id);
                            continue;
                        }
                        const variables = recordValue(target.components.variables);
                        const currentValue = definition ? variables[key] : componentPath ? readComponentPath(target, componentPath) : undefined;
                        if (currentValue === undefined)
                            continue;
                        const numericCurrent = typeof currentValue === 'number';
                        const vectorCurrent = Array.isArray(currentValue) && currentValue.every((value) => typeof value === 'number');
                        const condition = recordValue(effect.condition);
                        if (Object.keys(condition).length) {
                            const conditionVariable = typeof condition.variable === 'string' ? condition.variable : '';
                            const conditionPath = typeof condition.componentPath === 'string' ? condition.componentPath : '';
                            const conditionValue = conditionVariable ? variables[conditionVariable] ?? variables[this.recipe.variables.find((variable) => variable.id === conditionVariable)?.namespace + ':' + conditionVariable] : conditionPath ? readComponentPath(target, conditionPath) : undefined;
                            const threshold = Number(condition.value ?? 0);
                            const comparator = String(condition.comparator ?? '>=');
                            const numeric = typeof conditionValue === 'number' ? conditionValue : Number.NaN;
                            const passes = comparator === '>=' ? numeric >= threshold : comparator === '>' ? numeric > threshold : comparator === '<=' ? numeric <= threshold : comparator === '<' ? numeric < threshold : comparator === '==' ? numeric === threshold : comparator === '!=' ? numeric !== threshold : true;
                            if (!passes)
                                continue;
                        }
                        let interactionScale = 1;
                        for (const interaction of interactions) {
                            const whenVariable = typeof interaction.whenVariable === 'string' ? interaction.whenVariable : '';
                            const whenPath = typeof interaction.whenComponentPath === 'string' ? interaction.whenComponentPath : '';
                            const whenValue = whenVariable ? variables[whenVariable] ?? variables[this.recipe.variables.find((variable) => `${variable.namespace}:${variable.id}` === whenVariable || variable.id === whenVariable)?.namespace + ':' + (this.recipe.variables.find((variable) => `${variable.namespace}:${variable.id}` === whenVariable || variable.id === whenVariable)?.id ?? '')] : whenPath ? readComponentPath(target, whenPath) : undefined;
                            const threshold = Number(interaction.threshold ?? 0);
                            const comparator = String(interaction.comparator ?? '>=');
                            const numeric = typeof whenValue === 'number' ? whenValue : Number.NaN;
                            const passes = comparator === '>=' ? numeric >= threshold : comparator === '>' ? numeric > threshold : comparator === '<=' ? numeric <= threshold : comparator === '<' ? numeric < threshold : comparator === '==' ? numeric === threshold : comparator === '!=' ? numeric !== threshold : true;
                            if (passes)
                                interactionScale *= Number(interaction.multiplier ?? 1);
                        }
                        const operation = String(effect.operation ?? 'add');
                        const customOperator = worldLawEffectOperatorRegistry.get(operation);
                        if (!numericCurrent && !vectorCurrent && !customOperator)
                            continue;
                        const perDay = Number(effect.perDay ?? (typeof effect.value === 'number' ? effect.value : 0)) * interactionScale;
                        const stochastic = Math.abs(Number(effect.stochastic ?? 0));
                        let next = currentValue;
                        if (customOperator) {
                            const applied = customOperator.apply({ currentValue, effect, interactionScale, randomUnit: rng.next() });
                            if (applied === undefined)
                                continue;
                            next = applied;
                        }
                        else if (numericCurrent) {
                            let rawNext = currentValue;
                            if (operation === 'add')
                                rawNext = currentValue + perDay + rng.float(-stochastic, stochastic);
                            else if (operation === 'multiply')
                                rawNext = currentValue * (Number(effect.factor ?? (1 + perDay)) + rng.float(-stochastic, stochastic));
                            else if (operation === 'set')
                                rawNext = Number(effect.value ?? currentValue) + rng.float(-stochastic, stochastic);
                            else if (operation === 'approach') {
                                const toward = Number(effect.toward ?? effect.value ?? currentValue);
                                const rate = Math.max(0, Math.min(1, Number(effect.rate ?? Math.abs(perDay))));
                                rawNext = currentValue + (toward - currentValue) * rate + rng.float(-stochastic, stochastic);
                            }
                            const min = definition?.min ?? (typeof effect.min === 'number' ? effect.min : -Infinity);
                            const max = definition?.max ?? (typeof effect.max === 'number' ? effect.max : Infinity);
                            next = Math.max(min, Math.min(max, rawNext));
                        }
                        else if (vectorCurrent) {
                            const vector = currentValue;
                            const valueVector = Array.isArray(effect.value) ? effect.value.map(Number) : [];
                            if (operation === 'vector-add')
                                next = vector.map((value, index) => value + Number(valueVector[index] ?? perDay) * interactionScale + rng.float(-stochastic, stochastic));
                            else if (operation === 'vector-scale')
                                next = vector.map((value) => value * Number(effect.factor ?? (1 + perDay)));
                            else if (operation === 'set-vector' && valueVector.length)
                                next = valueVector;
                            else
                                continue;
                        }
                        if (JSON.stringify(next) === JSON.stringify(currentValue))
                            continue;
                        if (definition) {
                            variables[key] = next;
                            target.components.variables = variables;
                        }
                        else
                            writeComponentPath(target, componentPath, next);
                        changed.add(target.id);
                        const hiddenTruth = Boolean(rule.hiddenTruth) || Boolean(definition?.hiddenTruth);
                        const cause = builder.causal('state-transition', hiddenTruth, lawEntity?.provenanceIds ?? [], {
                            transition: 'world-law-effect', ruleId, effectIndex, targetId: target.id,
                            target: definition ? { variable: key } : { entityKind, componentPath }, operation, from: currentValue, to: next, interactionScale,
                        }, tick);
                        const event = builder.event(`world-law-effect:${ruleId}`, tick, lawEntity ? [lawEntity.id] : [], [target.id], {
                            effectIndex, targetVariable: definition ? key : null, componentPath: componentPath || null, operation, from: currentValue, to: next, interactionScale,
                        }, [cause], [cause], target.spatial);
                        eventIds.push(event.id);
                        const cost = recordValue(rule.cost);
                        const costVariable = typeof cost.targetVariable === 'string' ? cost.targetVariable : '';
                        const costDefinition = costVariable ? this.recipe.variables.find((variable) => `${variable.namespace}:${variable.id}` === costVariable || variable.id === costVariable) : undefined;
                        if (costDefinition) {
                            const costKey = `${costDefinition.namespace}:${costDefinition.id}`;
                            const costCurrent = variables[costKey];
                            const amount = Math.max(0, Number(cost.perDay ?? cost.amount ?? 0));
                            if (typeof costCurrent === 'number' && amount > 0) {
                                variables[costKey] = Math.max(costDefinition.min ?? -Infinity, costCurrent - amount);
                                target.components.variables = variables;
                            }
                        }
                        else if (typeof cost.componentPath === 'string') {
                            const costCurrent = readComponentPath(target, cost.componentPath);
                            const amount = Math.max(0, Number(cost.perDay ?? cost.amount ?? 0));
                            if (typeof costCurrent === 'number' && amount > 0)
                                writeComponentPath(target, cost.componentPath, Math.max(Number(cost.min ?? -Infinity), costCurrent - amount));
                        }
                    }
                }
            }
        }
        this.snapshot.manifest.currentTick = request.toTick;
        this.snapshot.aggregates.runtime = { currentTick: request.toTick, activeRegionCount: request.activeRegions?.length ?? 0 };
        return { fromTick, toTick: request.toTick, eventIds, changedEntityIds: [...changed].sort(), changedAggregateKeys: ['runtime'] };
    }
    async exportAreaSnapshot(query) {
        if (!(query.radiusKm >= 0))
            throw new Error('radiusKm must be non-negative');
        const tier = this.#effectiveTier(query.requestedDetailRank);
        if (tier.populationMode === 'individual' && tier.materializeOnDemand)
            this.#materializeArea(query);
        if (this.#indexedEntityCount !== this.snapshot.entities.length)
            this.#rebuildSpatialIndex();
        const kinds = query.entityKinds ? new Set(query.entityKinds) : null;
        const selected = this.#spatialCandidates(query.center, query.radiusKm).filter((entity) => {
            if (kinds && !kinds.has(entity.kind))
                return false;
            return entity.spatial ? distanceKm(entity.spatial, query.center, this.recipe) <= query.radiusKm : false;
        });
        const entityIds = new Set(selected.map((entity) => entity.id));
        const relations = this.snapshot.relations.filter((relation) => entityIds.has(relation.sourceId) && entityIds.has(relation.targetId));
        const events = this.snapshot.events.filter((event) => {
            const refs = [...event.actorIds, ...event.targetIds];
            return refs.length > 0 && refs.every((id) => entityIds.has(id)) && refs.some((id) => entityIds.has(id));
        });
        const knowledge = this.snapshot.knowledge.filter((record) => entityIds.has(record.holderId) || record.subjectIds.some((id) => entityIds.has(id)));
        const causalIds = new Set();
        const seedCausal = (id) => { if (id)
            causalIds.add(id); };
        for (const entity of selected)
            for (const id of entity.provenanceIds)
                seedCausal(id);
        for (const relation of relations)
            for (const id of relation.provenanceIds)
                seedCausal(id);
        for (const event of events) {
            for (const id of event.causeIds)
                seedCausal(id);
            for (const id of event.provenanceIds)
                seedCausal(id);
        }
        for (const record of knowledge)
            for (const id of record.truthLinkIds ?? [])
                seedCausal(id);
        let changed = true;
        while (changed) {
            changed = false;
            for (const causal of this.snapshot.causalRecords) {
                if (!causalIds.has(causal.id))
                    continue;
                for (const parent of causal.parentIds)
                    if (!causalIds.has(parent)) {
                        causalIds.add(parent);
                        changed = true;
                    }
            }
        }
        const subset = {
            manifest: deepClone(this.snapshot.manifest),
            entities: selected.map(cloneEntity),
            relations: relations.map(deepClone),
            events: events.map(deepClone),
            causalRecords: this.snapshot.causalRecords.filter((record) => causalIds.has(record.id)).map(deepClone),
            knowledge: knowledge.map(deepClone),
            aggregates: {
                spatialExport: {
                    center: deepClone(query.center),
                    radiusKm: query.radiusKm,
                    requestedDetailRank: query.requestedDetailRank,
                    effectiveTierId: tier.id,
                    entityCount: selected.length,
                    relationCount: relations.length,
                    eventCount: events.length,
                    causalRecordCount: causalIds.size,
                    sourceEntityCount: this.snapshot.entities.length,
                },
            },
        };
        const schemaErrors = validateComponentSchemas(subset, this.recipe);
        if (schemaErrors.length)
            throw new Error(`Spatial snapshot violates component schemas:
${schemaErrors.join('\n')}`);
        return subset;
    }
    async exportSnapshot(detailRank) {
        const snapshot = deepClone(this.snapshot);
        if (detailRank !== undefined) {
            const tier = this.#effectiveTier(detailRank);
            if (tier.populationMode !== 'individual') {
                snapshot.entities = snapshot.entities.filter((entity) => entity.components.__lodMaterialized !== true);
                const ids = new Set(snapshot.entities.map((entity) => entity.id));
                snapshot.relations = snapshot.relations.filter((relation) => ids.has(relation.sourceId) && ids.has(relation.targetId));
            }
            snapshot.aggregates.export = { detailRank, tierId: tier.id };
        }
        const schemaErrors = validateComponentSchemas(snapshot, this.recipe);
        if (schemaErrors.length)
            throw new Error(`Generated snapshot violates component schemas:\n${schemaErrors.join('\n')}`);
        snapshot.aggregates.diagnostics = { ...snapshot.aggregates.diagnostics, exportDigest: snapshotDigest(snapshot) };
        return snapshot;
    }
    collapseMaterializedDetail() {
        const materializedEntities = this.snapshot.entities.filter((entity) => entity.components.__lodMaterialized === true);
        const materialized = new Set(materializedEntities.map((entity) => entity.id));
        if (materialized.size === 0)
            return 0;
        const individuals = materializedEntities.filter((entity) => entity.kind === 'individual');
        const relationKindsByPerson = new Map();
        for (const relation of this.snapshot.relations) {
            if (!materialized.has(relation.sourceId) && !materialized.has(relation.targetId))
                continue;
            for (const id of [relation.sourceId, relation.targetId])
                if (individuals.some((person) => person.id === id)) {
                    const list = relationKindsByPerson.get(id) ?? [];
                    list.push(relation.kind);
                    relationKindsByPerson.set(id, list);
                }
        }
        const cohortStats = new Map();
        const lodPolicyIds = configuredLodPolicyIds(this.recipe);
        for (const person of individuals) {
            const cohortId = String(person.components.cohortId ?? '');
            const weight = Math.max(0, Number(person.components.sampleWeight ?? 0));
            const vitality = Math.max(0, Math.min(1, Number(person.components.vitalityIndex ?? 0.5)));
            const anchorId = String(person.components.identityAnchorId ?? '');
            const anchor = this.snapshot.entities.find((entity) => entity.id === anchorId && entity.kind === 'identity-anchor');
            if (anchor && lodPolicyIds.length) {
                const policyState = anchor.components.lodPolicyState && typeof anchor.components.lodPolicyState === 'object' && !Array.isArray(anchor.components.lodPolicyState)
                    ? deepClone(anchor.components.lodPolicyState) : {};
                const cohort = this.snapshot.entities.find((entity) => entity.id === String(person.components.cohortId ?? '') && entity.kind === 'population-cohort');
                if (cohort)
                    for (const policyId of lodPolicyIds) {
                        const summary = lodCoarseningPolicyRegistry.require(policyId).summarize({ tick: this.snapshot.manifest.currentTick, cohort, person, anchor });
                        if (summary !== undefined)
                            policyState[policyId] = deepClone(summary);
                    }
                anchor.components.lodPolicyState = policyState;
            }
            const plans = Array.isArray(person.components.plans) ? person.components.plans : [];
            const planKinds = {};
            for (const plan of plans)
                if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
                    const kind = String(plan.kind ?? 'unspecified');
                    planKinds[kind] = (planKinds[kind] ?? 0) + 1;
                }
            const relationshipKinds = {};
            for (const kind of relationKindsByPerson.get(person.id) ?? [])
                relationshipKinds[kind] = (relationshipKinds[kind] ?? 0) + 1;
            if (anchor)
                anchor.components.lastCoarsenedState = { tick: this.snapshot.manifest.currentTick, vitalityIndex: vitality, plans: deepClone(plans), relationshipKinds, dispositionVector: deepClone(person.components.dispositionVector ?? []) };
            const stats = cohortStats.get(cohortId) ?? { sampleCount: 0, weightedPopulation: 0, vitalityWeighted: 0, planKinds: {}, relationshipKinds: {} };
            stats.sampleCount += 1;
            stats.weightedPopulation += weight;
            stats.vitalityWeighted += vitality * weight;
            for (const [kind, count] of Object.entries(planKinds))
                stats.planKinds[kind] = (stats.planKinds[kind] ?? 0) + count * weight;
            for (const [kind, count] of Object.entries(relationshipKinds))
                stats.relationshipKinds[kind] = (stats.relationshipKinds[kind] ?? 0) + count * weight;
            cohortStats.set(cohortId, stats);
        }
        for (const [cohortId, stats] of cohortStats) {
            const cohort = this.snapshot.entities.find((entity) => entity.id === cohortId && entity.kind === 'population-cohort');
            if (!cohort)
                continue;
            cohort.components.lodSufficientStatistics = { tick: this.snapshot.manifest.currentTick, sampleCount: stats.sampleCount, weightedPopulation: stats.weightedPopulation, meanVitality: stats.weightedPopulation > 0 ? stats.vitalityWeighted / stats.weightedPopulation : 0.5, planKinds: stats.planKinds, relationshipKinds: stats.relationshipKinds };
        }
        this.snapshot.entities = this.snapshot.entities.filter((entity) => !materialized.has(entity.id));
        this.snapshot.relations = this.snapshot.relations.filter((relation) => !materialized.has(relation.sourceId) && !materialized.has(relation.targetId));
        this.#rebuildSpatialIndex();
        return materialized.size;
    }
    #effectiveTier(requestedRank) {
        if (!Number.isInteger(requestedRank) || requestedRank < 0)
            throw new Error('requestedDetailRank must be a non-negative integer');
        const sorted = this.recipe.lodTiers.slice().sort((a, b) => a.detailRank - b.detailRank);
        if (sorted.length === 0)
            throw new Error('Recipe has no LOD tiers');
        return sorted.find((tier) => tier.detailRank >= requestedRank) ?? sorted[sorted.length - 1];
    }
    #materializeArea(query) {
        const cohorts = this.snapshot.entities.filter((entity) => entity.kind === 'population-cohort' && entity.spatial && distanceKm(entity.spatial, query.center, this.recipe) <= query.radiusKm);
        const builder = new SnapshotBuilder(this.snapshot);
        const lodConfig = this.recipe.modules.find((module) => module.id === 'lod' && module.enabled)?.config ?? {};
        const lodPolicyIds = configuredLodPolicyIds(this.recipe);
        const configuredCap = typeof lodConfig.materializationSampleCap === 'number' ? Math.max(1, Math.round(lodConfig.materializationSampleCap)) : 32;
        const householdSize = typeof lodConfig.householdSize === 'number' ? Math.max(1, Math.round(lodConfig.householdSize)) : 4;
        const agentTemplates = Array.isArray(lodConfig.agentTemplates) ? lodConfig.agentTemplates.filter((value) => !!value && typeof value === 'object' && !Array.isArray(value)) : [];
        const householdTemplates = Array.isArray(lodConfig.householdTemplates) ? lodConfig.householdTemplates.filter((value) => !!value && typeof value === 'object' && !Array.isArray(value)) : [];
        for (const cohort of cohorts) {
            const count = typeof cohort.components.count === 'number' ? Math.max(0, Math.round(cohort.components.count)) : 0;
            const sampleCount = Math.min(count, configuredCap);
            const households = new Map();
            for (let ordinal = 0; ordinal < sampleCount; ordinal += 1) {
                const rng = this.#rng.stream('lod-materialize', cohort.id, ordinal);
                const anchorCause = builder.causal('state-transition', false, cohort.provenanceIds, { transition: 'identity-anchor', cohortId: cohort.id, ordinal }, this.snapshot.manifest.currentTick);
                const anchor = builder.entity('identity-anchor', [cohort.id, ordinal], {
                    cohortId: cohort.id,
                    ordinal,
                    commitments: [],
                    identityTraits: { continuitySeed: rng.int(0, 2147483647), temperament: [rng.float(-1, 1), rng.float(-1, 1), rng.float(-1, 1)] },
                }, [anchorCause], cohort.spatial);
                builder.relation('anchors-cohort', anchor.id, cohort.id, [anchorCause]);
                const householdOrdinal = Math.floor(ordinal / householdSize);
                let household = households.get(householdOrdinal);
                if (!household) {
                    const householdCause = builder.causal('state-transition', false, cohort.provenanceIds, { transition: 'lod-household-materialization', cohortId: cohort.id, householdOrdinal, householdSize }, this.snapshot.manifest.currentTick);
                    const householdTemplate = householdTemplates.length ? householdTemplates[householdOrdinal % householdTemplates.length] : { id: 'generic-household', norms: ['mutual-support'], reservePreference: 0.5 };
                    household = builder.entity('household', [cohort.id, householdOrdinal], {
                        cohortId: cohort.id, householdOrdinal, nominalSize: householdSize,
                        sampleWeight: count / Math.max(1, Math.ceil(sampleCount / householdSize)),
                        templateId: String(householdTemplate.id ?? 'generic-household'), norms: deepClone(householdTemplate.norms ?? ['mutual-support']), reservePreference: Number(householdTemplate.reservePreference ?? 0.5),
                        __lodMaterialized: true,
                    }, [householdCause], cohort.spatial);
                    builder.relation('household-materialized-from', household.id, cohort.id, [householdCause]);
                    households.set(householdOrdinal, household);
                }
                const cause = builder.causal('state-transition', false, [anchorCause], { transition: 'lod-materialization', cohortId: cohort.id, ordinal, identityAnchorId: anchor.id }, this.snapshot.manifest.currentTick);
                const prior = anchor.components.lastCoarsenedState && typeof anchor.components.lastCoarsenedState === 'object' && !Array.isArray(anchor.components.lastCoarsenedState) ? anchor.components.lastCoarsenedState : {};
                const agentTemplate = agentTemplates.length ? agentTemplates[ordinal % agentTemplates.length] : { id: 'generic-agent', roles: ['member'], planKinds: ['maintain-health', 'support-household', 'acquire-resources'] };
                const templatePlanKinds = Array.isArray(agentTemplate.planKinds) ? agentTemplate.planKinds.filter((value) => typeof value === 'string') : ['maintain-health'];
                const plans = Array.isArray(prior.plans) ? deepClone(prior.plans) : templatePlanKinds.slice(0, 2).map((kind, planOrdinal) => ({ kind, priority: Math.max(0, Math.min(1, 0.45 + rng.float(-0.15, 0.35))), progress: 0, planOrdinal }));
                const restoredComponents = {};
                const policyState = anchor.components.lodPolicyState && typeof anchor.components.lodPolicyState === 'object' && !Array.isArray(anchor.components.lodPolicyState)
                    ? anchor.components.lodPolicyState : {};
                for (const policyId of lodPolicyIds) {
                    const summary = policyState[policyId];
                    if (summary === undefined)
                        continue;
                    const restored = lodCoarseningPolicyRegistry.require(policyId).restore?.({ tick: this.snapshot.manifest.currentTick, cohort, anchor, ordinal, summary: deepClone(summary) });
                    if (restored)
                        Object.assign(restoredComponents, deepClone(restored));
                }
                const person = builder.entity('individual', [cohort.id, ordinal], {
                    ...restoredComponents,
                    cohortId: cohort.id, ordinal, identityAnchorId: anchor.id, householdId: household.id,
                    templateId: String(agentTemplate.id ?? 'generic-agent'), roles: deepClone(agentTemplate.roles ?? ['member']),
                    sampleWeight: count / Math.max(1, sampleCount),
                    vitalityIndex: typeof prior.vitalityIndex === 'number' ? prior.vitalityIndex : rng.float(),
                    dispositionVector: Array.isArray(prior.dispositionVector) ? deepClone(prior.dispositionVector) : [rng.float(-1, 1), rng.float(-1, 1), rng.float(-1, 1)],
                    commitments: deepClone(anchor.components.commitments ?? []), plans,
                    __lodMaterialized: true,
                }, [cause], cohort.spatial);
                builder.relation('materialized-from', person.id, cohort.id, [cause]);
                builder.relation('identity-realization', person.id, anchor.id, [cause]);
                builder.relation('member-of-household', person.id, household.id, [cause]);
            }
            const householdMembers = [...households.values()].map((household) => ({ household, members: this.snapshot.entities.filter((entity) => entity.kind === 'individual' && entity.components.householdId === household.id) }));
            for (const group of householdMembers) {
                const members = group.members.slice().sort((a, b) => Number(a.components.ordinal ?? 0) - Number(b.components.ordinal ?? 0));
                for (let i = 1; i < members.length; i += 1) {
                    const a = members[i - 1], b = members[i];
                    const relationCause = builder.causal('state-transition', false, [...a.provenanceIds, ...b.provenanceIds], { transition: 'lod-relationship-materialization', householdId: group.household.id, ordinal: i }, this.snapshot.manifest.currentTick);
                    builder.relation(i % 3 === 0 ? 'kin-support' : 'household-tie', a.id, b.id, [relationCause], { closenessIndex: 0.45 + ((i * 17) % 40) / 100, sufficientStatistic: true });
                }
            }
        }
        const materialized = this.snapshot.entities.filter((entity) => entity.kind === 'individual' && entity.components.__lodMaterialized === true);
        const byCohort = {};
        for (const cohort of cohorts) {
            const persons = materialized.filter((person) => person.components.cohortId === cohort.id);
            const weightedPopulation = persons.reduce((sum, person) => sum + Math.max(0, Number(person.components.sampleWeight ?? 0)), 0);
            const cohortCount = Math.max(0, Number(cohort.components.count ?? 0));
            byCohort[cohort.id] = { sampleCount: persons.length, weightedPopulation, cohortCount, conservationError: persons.length ? weightedPopulation - cohortCount : 0 };
        }
        this.snapshot.aggregates.lodRuntimeAudit = { byCohort, materializedIndividualCount: materialized.length };
        this.#rebuildSpatialIndex();
    }
    #rebuildSpatialIndex() {
        this.#spatialIndex = new Map();
        this.#entityById = new Map();
        for (const entity of this.snapshot.entities) {
            this.#entityById.set(entity.id, entity);
            if (!entity.spatial)
                continue;
            const key = this.#chunkKey(entity.spatial.x, entity.spatial.y);
            const bucket = this.#spatialIndex.get(key) ?? [];
            bucket.push(entity.id);
            this.#spatialIndex.set(key, bucket);
        }
        for (const bucket of this.#spatialIndex.values())
            bucket.sort();
        this.#indexedEntityCount = this.snapshot.entities.length;
    }
    #chunkKey(x, y) {
        const width = this.recipe.geometry.extent.widthKm;
        const height = this.recipe.geometry.extent.heightKm;
        const normalize = (value, size, wrap) => wrap ? ((value % size) + size) % size : Math.max(0, Math.min(size - Number.EPSILON, value));
        const nx = normalize(x, width, Boolean(this.recipe.geometry.wrapX) || this.recipe.geometry.spaceModel === 'spherical');
        const ny = normalize(y, height, Boolean(this.recipe.geometry.wrapY));
        return `${Math.floor(nx / this.#chunkSizeKm)},${Math.floor(ny / this.#chunkSizeKm)}`;
    }
    #spatialCandidates(center, radiusKm) {
        // Spherical/custom projections may require non-Euclidean footprints. Fall back to the full spatial set for correctness.
        if (this.recipe.geometry.spaceModel !== 'planar')
            return [...this.#entityById.values()].filter((entity) => entity.spatial);
        const width = this.recipe.geometry.extent.widthKm;
        const height = this.recipe.geometry.extent.heightKm;
        const chunksX = Math.max(1, Math.ceil(width / this.#chunkSizeKm));
        const chunksY = Math.max(1, Math.ceil(height / this.#chunkSizeKm));
        const minX = Math.floor((center.x - radiusKm) / this.#chunkSizeKm);
        const maxX = Math.floor((center.x + radiusKm) / this.#chunkSizeKm);
        const minY = Math.floor((center.y - radiusKm) / this.#chunkSizeKm);
        const maxY = Math.floor((center.y + radiusKm) / this.#chunkSizeKm);
        const ids = new Set();
        const wrapIndex = (value, count) => ((value % count) + count) % count;
        for (let cy = minY; cy <= maxY; cy += 1) {
            if (!this.recipe.geometry.wrapY && (cy < 0 || cy >= chunksY))
                continue;
            const iy = this.recipe.geometry.wrapY ? wrapIndex(cy, chunksY) : cy;
            for (let cx = minX; cx <= maxX; cx += 1) {
                if (!this.recipe.geometry.wrapX && (cx < 0 || cx >= chunksX))
                    continue;
                const ix = this.recipe.geometry.wrapX ? wrapIndex(cx, chunksX) : cx;
                for (const id of this.#spatialIndex.get(`${ix},${iy}`) ?? [])
                    ids.add(id);
            }
        }
        return [...ids].map((id) => this.#entityById.get(id)).filter((entity) => !!entity);
    }
    #projectEntity(entity, observerId) {
        const projected = cloneEntity(entity);
        const variables = projected.components.variables;
        if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
            const filtered = {};
            for (const [key, value] of Object.entries(variables)) {
                const definition = this.recipe.variables.find((variable) => `${variable.namespace}:${variable.id}` === key);
                const known = this.snapshot.knowledge.some((record) => record.holderId === observerId && record.subjectIds.includes(entity.id) && record.subjectIds.includes(key));
                if (!definition?.hiddenTruth || definition.observableByDefault || known)
                    filtered[key] = value;
            }
            projected.components.variables = filtered;
        }
        projected.components.__knowledgeProjectionFor = observerId;
        return projected;
    }
}
export function snapshotDigest(snapshot) {
    const diagnostics = snapshot.aggregates.diagnostics && typeof snapshot.aggregates.diagnostics === 'object' && !Array.isArray(snapshot.aggregates.diagnostics)
        ? snapshot.aggregates.diagnostics : undefined;
    const filteredDiagnostics = diagnostics ? Object.fromEntries(Object.entries(diagnostics).filter(([key]) => key !== 'generationDigest' && key !== 'exportDigest')) : undefined;
    const aggregates = { ...snapshot.aggregates };
    if (filteredDiagnostics)
        aggregates.diagnostics = filteredDiagnostics;
    const view = { ...snapshot, aggregates };
    return stableHash32(view).toString(16).padStart(8, '0');
}

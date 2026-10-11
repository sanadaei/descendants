import { WorldgenEngine, snapshotDigest } from './engine.js';
export async function diagnoseDeterministicReplay(recipe, engine = new WorldgenEngine()) {
    const first = await engine.generate(recipe);
    const second = await engine.generate(recipe);
    const a = await first.exportSnapshot();
    const b = await second.exportSnapshot();
    const firstDigest = snapshotDigest(a);
    const secondDigest = snapshotDigest(b);
    return { deterministic: firstDigest === secondDigest, firstDigest, secondDigest, entityCount: a.entities.length, eventCount: a.events.length };
}
export function validateSnapshotConformance(snapshot) {
    const errors = [];
    if (snapshot.manifest.contractVersion !== '1.0.0')
        errors.push('manifest.contractVersion must be 1.0.0');
    const entityIds = new Set();
    for (const entity of snapshot.entities) {
        if (entityIds.has(entity.id))
            errors.push(`duplicate entity id ${entity.id}`);
        entityIds.add(entity.id);
        if (!Array.isArray(entity.provenanceIds))
            errors.push(`entity ${entity.id} missing provenanceIds`);
    }
    const relationIds = new Set();
    for (const relation of snapshot.relations) {
        if (relationIds.has(relation.id))
            errors.push(`duplicate relation id ${relation.id}`);
        relationIds.add(relation.id);
        if (!entityIds.has(relation.sourceId) || !entityIds.has(relation.targetId))
            errors.push(`relation ${relation.id} references missing entity`);
    }
    const causalIds = new Set(snapshot.causalRecords.map((record) => record.id));
    for (const event of snapshot.events)
        for (const cause of event.causeIds)
            if (!causalIds.has(cause))
                errors.push(`event ${event.id} references missing cause ${cause}`);
    return errors;
}
function jsonTypeMatches(value, type) {
    if (type === 'null')
        return value === null;
    if (type === 'array')
        return Array.isArray(value);
    if (type === 'object')
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer')
        return typeof value === 'number' && Number.isInteger(value);
    return typeof value === type;
}
export function validateComponentSchemas(snapshot, recipe) {
    const errors = [];
    for (const definition of recipe.componentSchemas) {
        const applies = definition.appliesToKinds ? new Set(definition.appliesToKinds) : null;
        const schema = definition.schema;
        const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === 'string') : [];
        const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
            ? schema.properties : {};
        for (const entity of snapshot.entities) {
            if (applies && !applies.has(entity.kind))
                continue;
            for (const key of required)
                if (!(key in entity.components))
                    errors.push(`${definition.namespace}:${definition.id}: entity ${entity.id} missing required component ${key}`);
            for (const [key, rule] of Object.entries(properties)) {
                if (!(key in entity.components) || !rule || typeof rule !== 'object' || Array.isArray(rule))
                    continue;
                const type = rule.type;
                if (typeof type === 'string' && !jsonTypeMatches(entity.components[key], type))
                    errors.push(`${definition.namespace}:${definition.id}: entity ${entity.id} component ${key} expected ${type}`);
            }
        }
    }
    return errors;
}
/**
 * Reconstructs settlement population from generation premises plus retained burn-in events.
 * This intentionally ignores the present population component until the final comparison.
 */
export function reconstructPopulationFromHistory(snapshot) {
    const reconstructed = {};
    const seeded = new Set();
    for (const settlement of snapshot.entities.filter((entity) => entity.kind === 'settlement')) {
        const seedCause = settlement.provenanceIds.map((id) => snapshot.causalRecords.find((record) => record.id === id)).find((record) => record?.payload.transition === 'population-seed');
        if (seedCause && typeof seedCause.payload.population === 'number') {
            reconstructed[settlement.id] = Math.max(0, Number(seedCause.payload.population));
            seeded.add(settlement.id);
        }
    }
    const appliedKinds = new Set();
    // Snapshot event insertion order is the canonical burn-in order for events sharing a tick.
    for (const event of snapshot.events) {
        if (event.kind === 'macro-demographic-transition') {
            const settlementId = event.actorIds[0];
            const to = event.data.toPopulation;
            if (settlementId && typeof to === 'number') {
                reconstructed[settlementId] = Math.max(0, to);
                appliedKinds.add(event.kind);
            }
        }
        else if (event.kind === 'macro-migration') {
            const sourceId = event.actorIds[0];
            const targetId = event.targetIds[0];
            const count = Number(event.data.count ?? 0);
            if (sourceId && targetId && count >= 0) {
                reconstructed[sourceId] = Math.max(0, Number(reconstructed[sourceId] ?? 0) - count);
                reconstructed[targetId] = Number(reconstructed[targetId] ?? 0) + count;
                appliedKinds.add(event.kind);
            }
        }
        else if (event.kind === 'settlement-founded') {
            const sourceId = event.actorIds[0];
            const childId = event.targetIds[0];
            const transfer = Number(event.data.populationTransfer ?? 0);
            if (sourceId && childId && transfer >= 0) {
                reconstructed[sourceId] = Math.max(0, Number(reconstructed[sourceId] ?? 0) - transfer);
                reconstructed[childId] = transfer;
                appliedKinds.add(event.kind);
            }
        }
        else if (event.kind === 'settlement-abandoned' || event.kind === 'settlement-merged') {
            const sourceId = event.actorIds[0];
            const targetId = event.targetIds[0];
            const transfer = Number(event.data.populationTransfer ?? 0);
            if (sourceId && targetId && transfer >= 0) {
                reconstructed[sourceId] = 0;
                reconstructed[targetId] = Number(reconstructed[targetId] ?? 0) + transfer;
                appliedKinds.add(event.kind);
            }
        }
    }
    const canonical = {};
    let maxAbsoluteError = 0;
    let totalAbsoluteError = 0;
    const missingSeedSettlementIds = [];
    for (const settlement of snapshot.entities.filter((entity) => entity.kind === 'settlement')) {
        const value = Math.max(0, Number(settlement.components.population ?? 0));
        canonical[settlement.id] = value;
        if (!seeded.has(settlement.id) && !snapshot.events.some((event) => event.kind === 'settlement-founded' && event.targetIds.includes(settlement.id)))
            missingSeedSettlementIds.push(settlement.id);
        const error = Math.abs(Number(reconstructed[settlement.id] ?? 0) - value);
        totalAbsoluteError += error;
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
    }
    return { reconstructed, canonical, maxAbsoluteError, totalAbsoluteError, exact: maxAbsoluteError <= 1e-9 && missingSeedSettlementIds.length === 0, appliedEventKinds: [...appliedKinds].sort(), missingSeedSettlementIds: missingSeedSettlementIds.sort() };
}
/** Reconstructs non-population material state from explicit premises and retained state-transition events. */
export function reconstructMaterialSystemsFromHistory(snapshot) {
    const resources = {};
    const infrastructure = {};
    const polities = {};
    const applied = new Set();
    for (const resource of snapshot.entities.filter((entity) => entity.kind === 'ecological-resource')) {
        const premise = resource.provenanceIds.map((id) => snapshot.causalRecords.find((record) => record.id === id)).find((record) => record?.payload.generator === 'ecological-resource-stock');
        if (premise && typeof premise.payload.currentStock === 'number')
            resources[resource.id] = premise.payload.currentStock;
    }
    for (const event of snapshot.events) {
        if ((event.kind === 'ecological-resource-collapse' || event.kind === 'ecological-resource-recovery') && event.targetIds[0] && typeof event.data.toStock === 'number') {
            resources[event.targetIds[0]] = event.data.toStock;
            applied.add(event.kind);
        }
        else if (event.kind === 'infrastructure-built' && event.targetIds[0] && typeof event.data.conditionIndex === 'number') {
            infrastructure[event.targetIds[0]] = event.data.conditionIndex;
            applied.add(event.kind);
        }
        else if ((event.kind === 'infrastructure-maintenance' || event.kind === 'infrastructure-degradation') && event.actorIds[0] && typeof event.data.conditionIndex === 'number') {
            infrastructure[event.actorIds[0]] = event.data.conditionIndex;
            applied.add(event.kind);
        }
        else if (event.kind === 'polity-formed' && event.targetIds[0]) {
            polities[event.targetIds[0]] = { institutionalCapacityIndex: Number(event.data.institutionalCapacityIndex ?? 0), logisticsAccessIndex: Number(event.data.logisticsAccessIndex ?? 0), population: Number(event.data.population ?? 0) };
            applied.add(event.kind);
        }
        else if (event.kind === 'polity-reorganized' && event.actorIds[0] && polities[event.actorIds[0]]) {
            const state = polities[event.actorIds[0]];
            if (typeof event.data.toCapacity === 'number')
                state.institutionalCapacityIndex = event.data.toCapacity;
            if (typeof event.data.toLogistics === 'number')
                state.logisticsAccessIndex = event.data.toLogistics;
            applied.add(event.kind);
        }
    }
    let resourceStockError = 0;
    for (const resource of snapshot.entities.filter((entity) => entity.kind === 'ecological-resource'))
        resourceStockError += Math.abs(Number(resource.components.currentStock ?? 0) - Number(resources[resource.id] ?? 0));
    let infrastructureConditionError = 0;
    for (const work of snapshot.entities.filter((entity) => entity.kind === 'infrastructure-work'))
        infrastructureConditionError += Math.abs(Number(work.components.conditionIndex ?? 0) - Number(infrastructure[work.id] ?? 0));
    let polityStateError = 0;
    for (const polity of snapshot.entities.filter((entity) => entity.kind === 'polity')) {
        const state = polities[polity.id];
        if (!state) {
            polityStateError += 1;
            continue;
        }
        polityStateError += Math.abs(Number(polity.components.institutionalCapacityIndex ?? 0) - state.institutionalCapacityIndex) + Math.abs(Number(polity.components.logisticsAccessIndex ?? 0) - state.logisticsAccessIndex) + Math.abs(Number(polity.components.population ?? 0) - state.population);
    }
    return { exact: resourceStockError <= 1e-9 && infrastructureConditionError <= 1e-9 && polityStateError <= 1e-9, resourceStockError, infrastructureConditionError, polityStateError, reconstructedResourceStocks: resources, reconstructedInfrastructureCondition: infrastructure, reconstructedPolityState: polities, appliedEventKinds: [...applied].sort() };
}

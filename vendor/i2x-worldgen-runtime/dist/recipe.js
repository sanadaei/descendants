import { sortGenerationPasses } from './dag.js';
function assertCountPolicy(policy) {
    if (policy.mode === 'fixed') {
        if (!Number.isInteger(policy.value) || (policy.value ?? 0) < 0)
            throw new Error('Fixed continentCount requires a non-negative integer value');
    }
    else if (policy.mode === 'range') {
        if (!Number.isInteger(policy.min) || !Number.isInteger(policy.max) || (policy.min ?? -1) < 0 || (policy.max ?? -1) < (policy.min ?? 0))
            throw new Error('Range continentCount requires 0 <= min <= max');
    }
    else if (!policy.generatorId) {
        throw new Error('Generator continentCount requires generatorId');
    }
}
function uniqueIds(items, label) {
    const ids = new Set();
    for (const item of items) {
        if (!item.id)
            throw new Error(`${label} id is required`);
        if (ids.has(item.id))
            throw new Error(`Duplicate ${label} id: ${item.id}`);
        ids.add(item.id);
    }
}
export function assertWorldRecipe(recipe) {
    if (recipe.recipeVersion !== 1)
        throw new Error(`Unsupported recipeVersion: ${String(recipe.recipeVersion)}`);
    if (!recipe.id || !recipe.title)
        throw new Error('WorldRecipe id and title are required');
    if (!Number.isSafeInteger(recipe.seed))
        throw new Error('WorldRecipe.seed must be a safe integer');
    if (!(recipe.geometry.extent.widthKm > 0) || !(recipe.geometry.extent.heightKm > 0))
        throw new Error('World extent must be positive');
    if (recipe.geometry.extent.depthKm !== undefined && !(recipe.geometry.extent.depthKm > 0))
        throw new Error('World depth must be positive when provided');
    assertCountPolicy(recipe.geometry.continentCount);
    if (!(recipe.clock.ticksPerDay > 0) || !Number.isInteger(recipe.clock.ticksPerDay))
        throw new Error('ticksPerDay must be a positive integer');
    if (!(recipe.clock.burnInTicks >= 0) || !Number.isSafeInteger(recipe.clock.burnInTicks))
        throw new Error('burnInTicks must be a non-negative safe integer');
    uniqueIds(recipe.variables, 'variable');
    uniqueIds(recipe.componentSchemas, 'component schema');
    uniqueIds(recipe.modules, 'module');
    uniqueIds(recipe.generationPipeline, 'generation pass');
    uniqueIds(recipe.lodTiers, 'LOD tier');
    uniqueIds(recipe.contentPacks, 'content pack');
    const moduleIds = new Set(recipe.modules.filter((module) => module.enabled).map((module) => module.id));
    for (const pass of recipe.generationPipeline) {
        if ((pass.enabled ?? true) && !moduleIds.has(pass.moduleId))
            throw new Error(`Enabled pass ${pass.id} references disabled/missing module ${pass.moduleId}`);
    }
    const ranks = new Set();
    for (const tier of recipe.lodTiers) {
        if (!Number.isInteger(tier.detailRank) || tier.detailRank < 0)
            throw new Error(`LOD tier ${tier.id} has invalid detailRank`);
        if (ranks.has(tier.detailRank))
            throw new Error(`Duplicate LOD detailRank: ${tier.detailRank}`);
        ranks.add(tier.detailRank);
        if (!(tier.updateIntervalTicks > 0))
            throw new Error(`LOD tier ${tier.id} requires positive updateIntervalTicks`);
    }
    for (const variable of recipe.variables) {
        if (variable.kind === 'enum' && (!variable.enumValues || variable.enumValues.length === 0))
            throw new Error(`Enum variable ${variable.id} requires enumValues`);
        if (variable.min !== undefined && variable.max !== undefined && variable.max < variable.min)
            throw new Error(`Variable ${variable.id} has max < min`);
    }
    sortGenerationPasses(recipe.generationPipeline);
}
export function parseWorldRecipe(input) {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    assertWorldRecipe(parsed);
    return parsed;
}

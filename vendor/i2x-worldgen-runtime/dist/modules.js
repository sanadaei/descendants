import { buildLoreCorpus, knowledgeSemanticTags, motifCompatibility } from './lore.js';
import { SnapshotBuilder } from './state.js';
import { clamp, stableId } from './util.js';
import { buildTerrainGrid } from './terrain.js';
import { geometryTopologyRegistry } from './topology.js';
function numberConfig(config, key, fallback) {
    const value = config[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function stringConfig(config, key, fallback) {
    const value = config[key];
    return typeof value === 'string' ? value : fallback;
}
function stringArrayConfig(config, key, fallback) {
    const value = config[key];
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : fallback;
}
function moduleConfig(context, moduleId) {
    return context.recipe.modules.find((module) => module.id === moduleId)?.config ?? {};
}
function regionEntities(context) {
    return context.snapshot.entities.filter((entity) => entity.kind === 'region');
}
function wrappedDistanceKm(a, b, context) {
    if (!a || !b)
        return Number.POSITIVE_INFINITY;
    const width = context.recipe.geometry.extent.widthKm;
    const height = context.recipe.geometry.extent.heightKm;
    const rawDx = Math.abs(a.x - b.x);
    const rawDy = Math.abs(a.y - b.y);
    const dx = context.recipe.geometry.wrapX ? Math.min(rawDx, Math.max(0, width - rawDx)) : rawDx;
    const dy = context.recipe.geometry.wrapY ? Math.min(rawDy, Math.max(0, height - rawDy)) : rawDy;
    if (context.recipe.geometry.spaceModel === 'custom') {
        const cfg = context.recipe.geometry.config ?? {};
        const topologyId = typeof cfg.topologyId === 'string' ? cfg.topologyId : (typeof cfg.distanceMetric === 'string' ? cfg.distanceMetric : 'euclidean');
        return geometryTopologyRegistry.require(topologyId).distanceKm({ a, b, geometry: context.recipe.geometry });
    }
    return Math.sqrt(dx * dx + dy * dy);
}
function recordComponent(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function weightedPick(items, random01) {
    const viable = items.filter((item) => item.weight > 0 && Number.isFinite(item.weight));
    if (!viable.length)
        return undefined;
    const total = viable.reduce((sum, item) => sum + item.weight, 0);
    let cursor = random01 * total;
    for (const item of viable) {
        cursor -= item.weight;
        if (cursor <= 0)
            return item.value;
    }
    return viable[viable.length - 1].value;
}
function chooseContinentCount(context) {
    const policy = context.recipe.geometry.continentCount;
    const rng = context.rng.stream('geography', 'continent-count');
    if (policy.mode === 'fixed')
        return policy.value ?? 0;
    if (policy.mode === 'range')
        return rng.int(policy.min ?? 0, policy.max ?? 0);
    const config = context.recipe.geometry.config ?? {};
    const generators = config.continentCountGenerators;
    if (generators && typeof generators === 'object' && !Array.isArray(generators)) {
        const rule = generators[policy.generatorId ?? ''];
        if (typeof rule === 'number' && Number.isInteger(rule) && rule >= 0)
            return rule;
        if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
            const min = typeof rule.min === 'number' ? rule.min : undefined;
            const max = typeof rule.max === 'number' ? rule.max : undefined;
            if (Number.isInteger(min) && Number.isInteger(max) && min !== undefined && max !== undefined && min >= 0 && max >= min)
                return rng.int(min, max);
        }
    }
    throw new Error(`No geometry.config.continentCountGenerators rule for generatorId ${String(policy.generatorId)}`);
}
function variableValue(definition, rngValue) {
    if (definition.default !== undefined) {
        if (definition.kind === 'number' || definition.kind === 'integer') {
            const base = typeof definition.default === 'number' ? definition.default : 0;
            const min = definition.min ?? base - Math.max(1, Math.abs(base) * 0.25);
            const max = definition.max ?? base + Math.max(1, Math.abs(base) * 0.25);
            const jittered = clamp(base + (rngValue - 0.5) * (max - min) * 0.35, min, max);
            return definition.kind === 'integer' ? Math.round(jittered) : jittered;
        }
        return definition.default;
    }
    if (definition.kind === 'number')
        return definition.min !== undefined && definition.max !== undefined ? definition.min + rngValue * (definition.max - definition.min) : rngValue;
    if (definition.kind === 'integer')
        return Math.round(definition.min !== undefined && definition.max !== undefined ? definition.min + rngValue * (definition.max - definition.min) : rngValue * 100);
    if (definition.kind === 'boolean')
        return rngValue >= 0.5;
    if (definition.kind === 'enum' && definition.enumValues?.length)
        return definition.enumValues[Math.min(definition.enumValues.length - 1, Math.floor(rngValue * definition.enumValues.length))];
    if (definition.kind === 'string')
        return '';
    if (definition.kind === 'vector')
        return [rngValue, 1 - rngValue];
    if (definition.kind === 'distribution')
        return { mean: rngValue, variance: rngValue * (1 - rngValue) };
    return {};
}
export const kernelModule = {
    id: 'kernel', version: '1.0.0', capabilities: ['stable-ids', 'causal-provenance', 'seeded-rng'],
    runPass(passId, _config, context) {
        if (passId !== 'kernel:init')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const cause = builder.causal('generated-premise', false, [], { recipeId: context.recipe.id, seed: context.recipe.seed });
        builder.entity('world', context.recipe.id, { recipe: context.recipe.id, geometry: context.recipe.geometry }, [cause]);
        context.state.set('kernel.initialized', true);
    },
};
export const geographyModule = {
    id: 'geography', version: '1.2.0', capabilities: ['configurable-geometry', 'multiple-continents', 'region-substrate', 'terrain-grid', 'climate-fields', 'hydrology', 'terrain-strategies', 'plate-fields', 'watersheds', 'rain-shadows', 'ocean-currents', 'geomorphology', 'geological-strata'],
    runPass(passId, config, context) {
        if (passId !== 'geography:substrate')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const count = chooseContinentCount(context);
        const regionsPerContinent = Math.max(1, Math.round(numberConfig(config, 'regionsPerContinent', 6)));
        const widthKm = context.recipe.geometry.extent.widthKm;
        const heightKm = context.recipe.geometry.extent.heightKm;
        const gridWidth = Math.max(12, Math.round(numberConfig(config, 'gridWidth', Math.min(96, Math.max(32, widthKm / 12)))));
        const gridHeight = Math.max(8, Math.round(numberConfig(config, 'gridHeight', Math.min(64, Math.max(20, heightKm / 12)))));
        const seaLevel = numberConfig(config, 'seaLevel', 0.06);
        const reliefStrength = numberConfig(config, 'reliefStrength', 0.34);
        const riverThreshold = clamp(numberConfig(config, 'riverThreshold', 0.012), 0.001, 0.2);
        const terrainStrategy = stringConfig(config, 'terrainStrategy', 'radial-noise');
        const plateCount = Math.max(1, Math.round(numberConfig(config, 'plateCount', Math.max(4, count * 3))));
        const erosionStrength = clamp(numberConfig(config, 'erosionStrength', 0.7), 0, 2);
        const climateModel = stringConfig(config, 'climateModel', 'wind-rain-shadow');
        const oceanModel = stringConfig(config, 'oceanModel', 'gyre');
        const wrapX = context.recipe.geometry.spaceModel === 'spherical' ? true : (context.recipe.geometry.wrapX ?? false);
        const wrapY = context.recipe.geometry.wrapY ?? false;
        const continentSeeds = [];
        for (let c = 0; c < count; c += 1) {
            const rng = context.rng.stream('geography', 'continent-seed', c);
            const baseX = gridWidth * ((c + 0.5) / Math.max(1, count));
            continentSeeds.push({
                x: clamp(baseX + rng.float(-gridWidth / Math.max(8, count * 5), gridWidth / Math.max(8, count * 5)), 0, Math.max(0, gridWidth - 1)),
                y: rng.float(gridHeight * 0.25, gridHeight * 0.75),
                radiusX: Math.max(3, gridWidth / Math.max(2.6, count * 1.45) * rng.float(0.75, 1.2)),
                radiusY: Math.max(3, gridHeight * rng.float(0.28, 0.48)),
            });
        }
        const grid = buildTerrainGrid({ seed: context.recipe.seed, width: gridWidth, height: gridHeight, widthKm, heightKm, continentSeeds, wrapX, wrapY, seaLevel, reliefStrength, riverThreshold, terrainStrategy, plateCount, erosionStrength, climateModel, oceanModel });
        context.state.set('geography.terrainGrid', grid);
        const cellPoint = (i) => ({
            frameId: context.recipe.geometry.projectionId,
            x: ((i % gridWidth) + 0.5) * grid.cellWidthKm,
            y: (Math.floor(i / gridWidth) + 0.5) * grid.cellHeightKm,
        });
        const wrappedMean = (values, size, wrap) => {
            if (!values.length)
                return 0;
            if (!wrap)
                return values.reduce((sum, value) => sum + value, 0) / values.length;
            const sin = values.reduce((sum, value) => sum + Math.sin((value / size) * Math.PI * 2), 0) / values.length;
            const cos = values.reduce((sum, value) => sum + Math.cos((value / size) * Math.PI * 2), 0) / values.length;
            let angle = Math.atan2(sin, cos);
            if (angle < 0)
                angle += Math.PI * 2;
            return angle / (Math.PI * 2) * size;
        };
        const nearestSeedDistance = (i, seed) => {
            const x = i % gridWidth;
            const y = Math.floor(i / gridWidth);
            const dx0 = Math.abs(x - (seed % gridWidth));
            const dy0 = Math.abs(y - Math.floor(seed / gridWidth));
            const dx = wrapX ? Math.min(dx0, gridWidth - dx0) : dx0;
            const dy = wrapY ? Math.min(dy0, gridHeight - dy0) : dy0;
            return dx * dx + dy * dy;
        };
        let regionCount = 0;
        const regionsByCell = new Array(gridWidth * gridHeight).fill('');
        for (let c = 0; c < count; c += 1) {
            let cells = grid.continent.map((value, i) => value === c && grid.land[i] === 1 ? i : -1).filter((i) => i >= 0);
            // A small or noisy landmass is still represented canonically by its nearest cells.
            if (!cells.length) {
                const sx = Math.round(continentSeeds[c].x);
                const sy = Math.round(continentSeeds[c].y);
                const forced = clamp(sy, 0, gridHeight - 1) * gridWidth + clamp(sx, 0, gridWidth - 1);
                grid.land[forced] = 1;
                grid.continent[forced] = c;
                cells = [forced];
            }
            const seedRng = context.rng.stream('geography', 'region-seeds', c);
            const seeds = [];
            const desired = Math.min(regionsPerContinent, cells.length);
            const first = cells[seedRng.int(0, cells.length - 1)];
            seeds.push(first);
            while (seeds.length < desired) {
                let best = cells[0];
                let bestScore = -1;
                for (const cell of cells) {
                    const minDistance = Math.min(...seeds.map((seed) => nearestSeedDistance(cell, seed)));
                    const jitter = context.rng.stream('geography', 'region-seed-jitter', c, seeds.length, cell).float(0.96, 1.04);
                    const score = minDistance * jitter;
                    if (score > bestScore) {
                        best = cell;
                        bestScore = score;
                    }
                }
                if (seeds.includes(best))
                    break;
                seeds.push(best);
            }
            const premise = builder.causal('generated-premise', false, [], { generator: 'terrain-field', continentIndex: c, cellCount: cells.length });
            const centroidX = wrappedMean(cells.map((i) => cellPoint(i).x), widthKm, wrapX);
            const centroidY = wrappedMean(cells.map((i) => cellPoint(i).y), heightKm, wrapY);
            const continent = builder.entity('continent', c, { index: c, cellCount: cells.length, areaKm2: cells.length * grid.cellWidthKm * grid.cellHeightKm }, [premise], { frameId: context.recipe.geometry.projectionId, x: centroidX, y: centroidY });
            const partitions = seeds.map(() => []);
            for (const cell of cells) {
                let bestIndex = 0;
                let bestDistance = Infinity;
                for (let r = 0; r < seeds.length; r += 1) {
                    const distance = nearestSeedDistance(cell, seeds[r]);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        bestIndex = r;
                    }
                }
                partitions[bestIndex].push(cell);
            }
            for (let r = 0; r < partitions.length; r += 1) {
                const regionCells = partitions[r];
                if (!regionCells.length)
                    continue;
                const mean = (field) => regionCells.reduce((sum, i) => sum + field[i], 0) / regionCells.length;
                const cx = wrappedMean(regionCells.map((i) => cellPoint(i).x), widthKm, wrapX);
                const cy = wrappedMean(regionCells.map((i) => cellPoint(i).y), heightKm, wrapY);
                const regionCause = builder.causal('generated-premise', false, [premise], { generator: 'terrain-aware-region-partition', continentId: continent.id, regionIndex: r, cellCount: regionCells.length });
                const region = builder.entity('region', [continent.id, r], {
                    continentId: continent.id, regionIndex: r, cellCount: regionCells.length,
                    terrain: {
                        elevationIndex: mean(grid.elevation), roughnessIndex: mean(grid.roughness), moistureIndex: mean(grid.moisture), temperatureIndex: mean(grid.temperature),
                        rainfallIndex: mean(grid.rainfall), coastFraction: mean(grid.coast), riverFraction: mean(grid.river), lakeFraction: mean(grid.lake), floodplainFraction: mean(grid.floodplain),
                        landAreaKm2: regionCells.length * grid.cellWidthKm * grid.cellHeightKm,
                    },
                    geology: (() => {
                        const meanCrustAge = mean(grid.crustAge);
                        const meanRockHardness = mean(grid.rockHardness);
                        const mineralPotential = mean(grid.mineralPotential);
                        const erosionIndex = mean(grid.erosion);
                        const sedimentIndex = mean(grid.sediment);
                        const strata = [
                            { position: 'basal', relativeThickness: clamp(0.35 + meanCrustAge * 0.35), ageIndex: meanCrustAge, hardnessIndex: meanRockHardness, mineralPotential: clamp(mineralPotential * 1.12), depositionalIndex: clamp(sedimentIndex * 0.2) },
                            { position: 'intermediate', relativeThickness: clamp(0.25 + (1 - erosionIndex) * 0.25), ageIndex: clamp(meanCrustAge * 0.62), hardnessIndex: clamp(meanRockHardness * 0.82), mineralPotential, depositionalIndex: clamp(sedimentIndex * 0.55) },
                            { position: 'surface', relativeThickness: clamp(0.12 + sedimentIndex * 0.45), ageIndex: clamp(meanCrustAge * 0.18), hardnessIndex: clamp(meanRockHardness * (1 - erosionIndex * 0.5)), mineralPotential: clamp(mineralPotential * 0.72 + sedimentIndex * 0.18), depositionalIndex: sedimentIndex },
                        ];
                        return { meanCrustAge, meanRockHardness, mineralPotential, erosionIndex, sedimentIndex, plateDiversity: new Set(regionCells.map((i) => grid.plate[i])).size, strata };
                    })(),
                    atmosphere: { meanWindX: mean(grid.windX), meanWindY: mean(grid.windY), rainfallIndex: mean(grid.rainfall) },
                    hydrology: { basinDiversity: new Set(regionCells.map((i) => grid.basin[i])).size, floodplainFraction: mean(grid.floodplain) },
                }, [regionCause], { frameId: context.recipe.geometry.projectionId, x: cx, y: cy });
                region.spatial.regionId = region.id;
                for (const cell of regionCells)
                    regionsByCell[cell] = region.id;
                builder.relation('contains', continent.id, region.id, [regionCause]);
                regionCount += 1;
            }
        }
        // Canonical drainage systems are explicit entities so later settlement, ecology and history can refer to watersheds without re-reading grid internals.
        const basinCells = new Map();
        for (let i = 0; i < grid.basin.length; i += 1)
            if (grid.land[i] && grid.basin[i] !== -1) {
                const cells = basinCells.get(grid.basin[i]) ?? [];
                cells.push(i);
                basinCells.set(grid.basin[i], cells);
            }
        let drainageSystemCount = 0;
        for (const [basinId, cells] of [...basinCells.entries()].sort((a, b) => a[0] - b[0])) {
            const riverCells = cells.filter((i) => grid.river[i] === 1);
            if (!riverCells.length)
                continue;
            const outlet = cells.slice().sort((a, b) => grid.flowAccumulation[b] - grid.flowAccumulation[a] || a - b)[0];
            const cause = builder.causal('generated-premise', false, [], { generator: 'watershed-topology', basinId, cellCount: cells.length, riverCellCount: riverCells.length });
            const drainage = builder.entity('drainage-system', basinId, {
                basinId, cellCount: cells.length, riverCellCount: riverCells.length, drainageAreaKm2: cells.length * grid.cellWidthKm * grid.cellHeightKm,
                meanRainfall: cells.reduce((sum, i) => sum + grid.rainfall[i], 0) / cells.length, floodplainCellCount: cells.filter((i) => grid.floodplain[i] === 1).length,
                outletCellIndex: outlet,
            }, [cause], cellPoint(outlet));
            const regionIds = [...new Set(cells.map((i) => regionsByCell[i]).filter((id) => typeof id === 'string' && id.length > 0))];
            for (const regionId of regionIds)
                builder.relation('drains-region', drainage.id, regionId, [cause]);
            drainageSystemCount += 1;
        }
        const landCells = grid.land.reduce((sum, value) => sum + value, 0);
        context.snapshot.aggregates.geography = {
            continentCount: count, regionCount, drainageSystemCount, terrainStrategy, plateCount, climateModel, oceanModel, grid: {
                width: grid.width, height: grid.height, cellWidthKm: grid.cellWidthKm, cellHeightKm: grid.cellHeightKm,
                landFraction: landCells / Math.max(1, grid.land.length), riverCellCount: grid.river.reduce((a, b) => a + b, 0), lakeCellCount: grid.lake.reduce((a, b) => a + b, 0), floodplainCellCount: grid.floodplain.reduce((a, b) => a + b, 0),
                land: grid.land, continent: grid.continent, elevation: grid.elevation, roughness: grid.roughness, temperature: grid.temperature, moisture: grid.moisture, rainfall: grid.rainfall,
                coast: grid.coast, river: grid.river, lake: grid.lake, floodplain: grid.floodplain, flowTo: grid.flowTo, basin: grid.basin,
                plate: grid.plate, crustAge: grid.crustAge, rockHardness: grid.rockHardness, mineralPotential: grid.mineralPotential, erosion: grid.erosion, sediment: grid.sediment,
                windX: grid.windX, windY: grid.windY, oceanCurrentX: grid.oceanCurrentX, oceanCurrentY: grid.oceanCurrentY, regionIds: regionsByCell,
            },
        };
    },
};
export const ecologyModule = {
    id: 'ecology', version: '1.3.0', capabilities: [
        'ecological-fields', 'resource-fields', 'region-differentiation', 'terrain-coupled-ecology',
        'renewable-resource-stocks', 'ecological-guilds', 'trophic-dependencies', 'disturbance-succession', 'content-defined-ecoregions',
    ],
    runPass(passId, config, context) {
        if (passId !== 'ecology:fields')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const explicitFields = stringArrayConfig(config, 'fields', []);
        const regionVariables = context.recipe.variables.filter((variable) => variable.scope === 'region');
        const resourceKinds = stringArrayConfig(config, 'resourceKinds', ['biomass', 'freshwater', 'mineral-access']);
        const guildKinds = stringArrayConfig(config, 'guildKinds', ['primary-producer', 'consumer', 'decomposer']);
        const baseRegeneration = Math.max(0, numberConfig(config, 'baseResourceRegenerationPerDay', 0.0025));
        const disturbanceRate = clamp(numberConfig(config, 'disturbanceRate', 0.04));
        const ecoregionRules = Array.isArray(config.ecoregionRules) ? config.ecoregionRules.filter((item) => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
        let ecologicalResourceCount = 0;
        let guildCount = 0;
        let classifiedRegionCount = 0;
        for (const region of regionEntities(context)) {
            const rng = context.rng.stream('ecology', region.id);
            const terrain = recordComponent(region.components.terrain);
            const elevation = typeof terrain.elevationIndex === 'number' ? terrain.elevationIndex : 0.5;
            const roughness = typeof terrain.roughnessIndex === 'number' ? terrain.roughnessIndex : 0.5;
            const moisture = typeof terrain.moistureIndex === 'number' ? terrain.moistureIndex : 0.5;
            const temperature = typeof terrain.temperatureIndex === 'number' ? terrain.temperatureIndex : 0.5;
            const coastFraction = typeof terrain.coastFraction === 'number' ? terrain.coastFraction : 0;
            const riverFraction = typeof terrain.riverFraction === 'number' ? terrain.riverFraction : 0;
            const lakeFraction = typeof terrain.lakeFraction === 'number' ? terrain.lakeFraction : 0;
            const landArea = Math.max(1, Number(terrain.landAreaKm2 ?? 100));
            const climateFitness = clamp(1 - Math.abs(temperature - 0.58) * 1.35);
            let productivity = clamp(0.06 + moisture * 0.48 + climateFitness * 0.34 + riverFraction * 0.25 - elevation * 0.12 + rng.float(-0.04, 0.04));
            let resourceDiversity = clamp(0.12 + roughness * 0.22 + moisture * 0.18 + coastFraction * 0.2 + riverFraction * 0.18 + rng.float(-0.05, 0.05));
            let hazard = clamp(0.06 + roughness * 0.28 + Math.abs(moisture - 0.55) * 0.18 + coastFraction * 0.08 + rng.float(0, 0.16));
            const ecoregionMetrics = { elevation, roughness, moisture, temperature, coastFraction, riverFraction, lakeFraction, productivity, resourceDiversity, hazard };
            let ecoregionId = null;
            let ecoregionTags = [];
            for (const rule of ecoregionRules) {
                const id = typeof rule.id === 'string' ? rule.id : '';
                if (!id)
                    continue;
                const conditions = recordComponent(rule.conditions);
                let matches = true;
                for (const [metric, boundValue] of Object.entries(conditions)) {
                    const value = ecoregionMetrics[metric.replace(/(?:Min|Max)$/, '')];
                    if (value === undefined || typeof boundValue !== 'number')
                        continue;
                    if (metric.endsWith('Min') && value < boundValue)
                        matches = false;
                    else if (metric.endsWith('Max') && value > boundValue)
                        matches = false;
                    else if (!metric.endsWith('Min') && !metric.endsWith('Max') && Math.abs(value - boundValue) > 1e-9)
                        matches = false;
                }
                if (!matches)
                    continue;
                ecoregionId = id;
                ecoregionTags = Array.isArray(rule.tags) ? rule.tags.filter((tag) => typeof tag === 'string') : [];
                const modifiers = recordComponent(rule.modifiers);
                productivity = clamp(productivity * (typeof modifiers.productivityMultiplier === 'number' ? modifiers.productivityMultiplier : 1));
                resourceDiversity = clamp(resourceDiversity * (typeof modifiers.resourceDiversityMultiplier === 'number' ? modifiers.resourceDiversityMultiplier : 1));
                hazard = clamp(hazard * (typeof modifiers.hazardMultiplier === 'number' ? modifiers.hazardMultiplier : 1));
                classifiedRegionCount += 1;
                break;
            }
            const disturbance = clamp(hazard * (0.35 + rng.float(0, 0.65)) * disturbanceRate * 8);
            const successionStage = clamp(1 - disturbance * 0.65 + productivity * 0.25);
            const variables = {};
            for (const variable of regionVariables)
                variables[`${variable.namespace}:${variable.id}`] = variableValue(variable, rng.next());
            const fields = {
                productivityIndex: productivity,
                resourceDiversityIndex: resourceDiversity,
                hazardIndex: hazard,
                disturbanceIndex: disturbance,
                successionStage,
                ecoregionId,
                ecoregionTags,
            };
            for (const field of explicitFields)
                fields[field] = rng.float();
            region.components.environment = fields;
            region.components.variables = variables;
            const regionProv = context.provenance(passId, { regionId: region.id, derivation: 'terrain-coupled' });
            region.provenanceIds.push(regionProv);
            const resourceIds = [];
            for (let index = 0; index < resourceKinds.length; index += 1) {
                const resourceKind = resourceKinds[index];
                const rrng = context.rng.stream('ecology-resource', region.id, resourceKind);
                const waterAffinity = resourceKind.includes('water') ? clamp(riverFraction * 2 + lakeFraction * 2 + coastFraction * 0.4) : 0.35;
                const mineralAffinity = resourceKind.includes('mineral') ? clamp(roughness * 0.6 + elevation * 0.4) : 0.35;
                const biomassAffinity = resourceKind.includes('biomass') ? productivity : 0.35;
                const affinity = clamp(Math.max(waterAffinity, mineralAffinity, biomassAffinity) * 0.75 + resourceDiversity * 0.25 + rrng.float(-0.08, 0.08));
                const carryingStock = Math.max(1, landArea * (12 + affinity * 88));
                const currentStock = carryingStock * clamp(0.45 + successionStage * 0.45 + rrng.float(-0.08, 0.08));
                const renewable = !resourceKind.includes('mineral');
                const regenerationPerDay = renewable ? carryingStock * baseRegeneration * (0.3 + productivity * 0.7) : 0;
                const cause = builder.causal('generated-premise', false, [regionProv], { generator: 'ecological-resource-stock', regionId: region.id, resourceKind, affinity, carryingStock, currentStock, renewable });
                const resource = builder.entity('ecological-resource', [region.id, resourceKind], {
                    regionId: region.id,
                    resourceKind,
                    renewable,
                    affinityIndex: affinity,
                    carryingStock,
                    currentStock,
                    regenerationPerDay,
                    depletionFraction: clamp(1 - currentStock / carryingStock),
                    disturbanceSensitivity: clamp(0.25 + hazard * 0.5 + rrng.float(0, 0.25)),
                }, [cause], region.spatial, resourceKind);
                builder.relation('resource-located-in', resource.id, region.id, [cause]);
                resourceIds.push(resource.id);
                ecologicalResourceCount += 1;
            }
            const guildIds = [];
            for (let index = 0; index < guildKinds.length; index += 1) {
                const guildKind = guildKinds[index];
                const grng = context.rng.stream('ecology-guild', region.id, guildKind);
                const trophicLevel = index;
                const abundanceCapacity = Math.max(1, landArea * productivity * (1.2 / (1 + trophicLevel * 0.75)));
                const abundance = abundanceCapacity * clamp(0.35 + successionStage * 0.45 + grng.float(-0.06, 0.12));
                const cause = builder.causal('generated-premise', false, [regionProv], { generator: 'ecological-guild', regionId: region.id, guildKind, trophicLevel });
                const guild = builder.entity('ecological-guild', [region.id, guildKind], {
                    regionId: region.id,
                    guildKind,
                    trophicLevel,
                    abundance,
                    abundanceCapacity,
                    reproductionRatePerDay: Math.max(0.00001, 0.004 / (1 + trophicLevel)),
                    mortalityRatePerDay: Math.max(0.00001, 0.002 + hazard * 0.0025 + trophicLevel * 0.0006),
                    mobilityIndex: clamp(0.15 + trophicLevel * 0.25 + grng.float(0, 0.25)),
                }, [cause], region.spatial, guildKind);
                builder.relation('guild-located-in', guild.id, region.id, [cause]);
                guildIds.push(guild.id);
                guildCount += 1;
                if (resourceIds.length)
                    builder.relation('guild-depends-on-resource', guild.id, resourceIds[index % resourceIds.length], [cause], { dependencyStrength: clamp(0.45 + grng.float(0, 0.5)) });
                if (index > 0)
                    builder.relation('trophic-dependency', guild.id, guildIds[index - 1], [cause], { dependencyStrength: clamp(0.35 + grng.float(0, 0.55)) });
            }
            region.components.ecology = { resourceIds, guildIds, disturbanceIndex: disturbance, successionStage, ecoregionId, ecoregionTags };
        }
        context.snapshot.aggregates.ecology = { regionCount: regionEntities(context).length, ecologicalResourceCount, guildCount, resourceKinds, guildKinds, ecoregionRuleCount: ecoregionRules.length, classifiedRegionCount };
    },
};
export const populationModule = {
    id: 'population', version: '1.3.0', capabilities: ['population-seeding', 'settlements', 'demographic-cohorts', 'environmental-carrying-capacity', 'route-network', 'terrain-following-settlement-morphology', 'household-demography'],
    runPass(passId, config, context) {
        if (passId !== 'population:seed')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const settlementsPerRegion = Math.max(0, Math.round(numberConfig(config, 'settlementsPerRegion', 2)));
        const basePopulation = Math.max(1, Math.round(numberConfig(config, 'basePopulation', 1200)));
        const speciesRef = stringConfig(config, 'populationKind', 'unspecified-population');
        const routeNeighbors = Math.max(0, Math.round(numberConfig(config, 'routeNeighbors', 3)));
        const routeDistanceScaleKm = Math.max(1, numberConfig(config, 'routeDistanceScaleKm', Math.max(25, Math.min(context.recipe.geometry.extent.widthKm, context.recipe.geometry.extent.heightKm) / 4)));
        const geography = recordComponent(context.snapshot.aggregates.geography);
        const grid = recordComponent(geography.grid);
        const gridWidth = Math.max(1, Math.round(Number(grid.width ?? 1)));
        const gridHeight = Math.max(1, Math.round(Number(grid.height ?? 1)));
        const elevations = Array.isArray(grid.elevation) ? grid.elevation.map(Number) : [];
        const flowTo = Array.isArray(grid.flowTo) ? grid.flowTo.map(Number) : [];
        const terrainOrientation = (spatial) => {
            if (!spatial || !elevations.length)
                return 0;
            const cx = Math.max(0, Math.min(gridWidth - 1, Math.floor((spatial.x / context.recipe.geometry.extent.widthKm) * gridWidth)));
            const cy = Math.max(0, Math.min(gridHeight - 1, Math.floor((spatial.y / context.recipe.geometry.extent.heightKm) * gridHeight)));
            const index = cy * gridWidth + cx;
            const downstream = Number(flowTo[index] ?? -1);
            if (downstream >= 0 && downstream !== index) {
                const tx = downstream % gridWidth;
                const ty = Math.floor(downstream / gridWidth);
                return Math.atan2(ty - cy, tx - cx);
            }
            const left = elevations[cy * gridWidth + Math.max(0, cx - 1)] ?? elevations[index] ?? 0;
            const right = elevations[cy * gridWidth + Math.min(gridWidth - 1, cx + 1)] ?? elevations[index] ?? 0;
            const up = elevations[Math.max(0, cy - 1) * gridWidth + cx] ?? elevations[index] ?? 0;
            const down = elevations[Math.min(gridHeight - 1, cy + 1) * gridWidth + cx] ?? elevations[index] ?? 0;
            return Math.atan2(down - up, right - left) + Math.PI / 2;
        };
        for (const region of regionEntities(context)) {
            const env = recordComponent(region.components.environment);
            const terrain = recordComponent(region.components.terrain);
            const productivity = typeof env.productivityIndex === 'number' ? env.productivityIndex : 0.5;
            const hazard = typeof env.hazardIndex === 'number' ? env.hazardIndex : 0.5;
            const waterAccess = clamp((typeof terrain.riverFraction === 'number' ? terrain.riverFraction : 0) * 3 + (typeof terrain.coastFraction === 'number' ? terrain.coastFraction : 0) * 1.4 + (typeof terrain.lakeFraction === 'number' ? terrain.lakeFraction : 0) * 2);
            const landArea = typeof terrain.landAreaKm2 === 'number' ? terrain.landAreaKm2 : 100;
            for (let s = 0; s < settlementsPerRegion; s += 1) {
                const rng = context.rng.stream('population', region.id, s);
                const siteSuitability = clamp(0.15 + productivity * 0.55 + waterAccess * 0.25 - hazard * 0.14 + rng.float(-0.08, 0.08));
                const scale = Math.max(0.35, Math.sqrt(Math.max(1, landArea) / 100));
                const carryingCapacity = Math.max(1, Math.round(basePopulation * scale * (0.45 + siteSuitability * 1.9)));
                const population = Math.max(1, Math.min(carryingCapacity, Math.round(carryingCapacity * rng.float(0.35, 0.82))));
                const cause = builder.causal('state-transition', false, region.provenanceIds, { transition: 'population-seed', regionId: region.id, settlementIndex: s, population, siteSuitability });
                const maxOffsetX = Math.max(0.25, Math.min(8, context.recipe.geometry.extent.widthKm / 100));
                const maxOffsetY = Math.max(0.25, Math.min(8, context.recipe.geometry.extent.heightKm / 100));
                const spatial = region.spatial ? { ...region.spatial, x: clamp(region.spatial.x + rng.float(-maxOffsetX, maxOffsetX), 0, context.recipe.geometry.extent.widthKm), y: clamp(region.spatial.y + rng.float(-maxOffsetY, maxOffsetY), 0, context.recipe.geometry.extent.heightKm), regionId: region.id } : undefined;
                const builtAreaKm2 = Math.max(0.01, population / Math.max(350, 1800 + siteSuitability * 2200));
                const morphology = {
                    builtAreaKm2, orientationRadians: terrainOrientation(spatial), elongation: 1 + Number(terrain.roughnessIndex ?? 0.5) * 1.5 + waterAccess * 0.75,
                    terrainFollowingIndex: clamp(0.45 + Number(terrain.roughnessIndex ?? 0.5) * 0.25 + waterAccess * 0.25), waterFollowingIndex: waterAccess,
                    expansionHistory: [{ tick: context.recipe.clock.startTick ?? 0, builtAreaKm2, population }],
                };
                const settlement = builder.entity('settlement', [region.id, s], { regionId: region.id, population, carryingCapacity, siteSuitability, developmentIndex: rng.float(), waterAccessIndex: waterAccess, morphology }, [cause], spatial);
                const juvenile = rng.float(0.1, 0.35);
                const elder = rng.float(0.05, 0.25);
                const meanHouseholdSize = rng.float(2.2, 6.2);
                const householdCount = Math.max(1, Math.round(population / meanHouseholdSize));
                const cohort = builder.entity('population-cohort', [settlement.id, speciesRef], { settlementId: settlement.id, populationKind: speciesRef, count: population, ageStructure: { juvenile, adult: Math.max(0, 1 - juvenile - elder), elder }, healthIndex: clamp(0.38 + productivity * 0.4 - hazard * 0.16 + rng.float(-0.08, 0.08)), householdDemography: { householdCount, meanHouseholdSize, formationRateAnnual: rng.float(0.025, 0.08), dissolutionRateAnnual: rng.float(0.015, 0.065), fertilityIndex: rng.float(0.55, 1.25), dependencySupportIndex: clamp(0.4 + productivity * 0.35 - hazard * 0.12 + rng.float(-0.08, 0.08)) } }, [cause], spatial);
                builder.relation('located-in', settlement.id, region.id, [cause]);
                builder.relation('resides-in', cohort.id, settlement.id, [cause]);
            }
        }
        // Build a deterministic accessibility graph after all settlements exist. The graph is generic: it has costs/capacity but no setting-specific transport technology.
        const settlements = context.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.spatial);
        const regionMap = new Map(regionEntities(context).map((region) => [region.id, region]));
        const routedPairs = new Set();
        for (const source of settlements) {
            const nearest = settlements.filter((target) => target.id !== source.id)
                .map((target) => ({ target, distanceKm: wrappedDistanceKm(source.spatial, target.spatial, context) }))
                .sort((a, b) => a.distanceKm - b.distanceKm || a.target.id.localeCompare(b.target.id)).slice(0, routeNeighbors);
            for (const { target, distanceKm } of nearest) {
                const pair = [source.id, target.id].sort();
                const pairKey = `${pair[0]}|${pair[1]}`;
                if (routedPairs.has(pairKey))
                    continue;
                routedPairs.add(pairKey);
                const sourceRegion = regionMap.get(String(source.components.regionId ?? ''));
                const targetRegion = regionMap.get(String(target.components.regionId ?? ''));
                const sourceTerrain = recordComponent(sourceRegion?.components.terrain);
                const targetTerrain = recordComponent(targetRegion?.components.terrain);
                const roughness = ((typeof sourceTerrain.roughnessIndex === 'number' ? sourceTerrain.roughnessIndex : 0.5) + (typeof targetTerrain.roughnessIndex === 'number' ? targetTerrain.roughnessIndex : 0.5)) / 2;
                const water = ((typeof source.components.waterAccessIndex === 'number' ? source.components.waterAccessIndex : 0) + (typeof target.components.waterAccessIndex === 'number' ? target.components.waterAccessIndex : 0)) / 2;
                const accessibility = clamp(Math.exp(-distanceKm / routeDistanceScaleKm) * (1 - roughness * 0.45) * (0.68 + water * 0.32), 0.01, 1);
                const cause = builder.causal('generated-premise', false, [...source.provenanceIds, ...target.provenanceIds], { generator: 'accessibility-route', sourceId: pair[0], targetId: pair[1], distanceKm, accessibility });
                builder.relation('route-link', pair[0], pair[1], [cause], { distanceKm, accessibility, roughnessCost: roughness, capacityIndex: clamp(accessibility * (0.6 + Math.sqrt(Math.max(1, Number(source.components.population ?? 1) + Number(target.components.population ?? 1))) / 500)) });
            }
        }
        context.snapshot.aggregates.routes = { routeCount: routedPairs.size, neighborTarget: routeNeighbors, distanceScaleKm: routeDistanceScaleKm };
    },
};
export const historyModule = {
    id: 'history', version: '1.2.0', capabilities: ['burn-in-history', 'causal-events', 'macro-history', 'demographic-dynamics', 'route-mediated-migration'],
    runPass(passId, config, context) {
        if (passId !== 'history:burn-in')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const startTick = context.recipe.clock.startTick ?? 0;
        const burnIn = context.recipe.clock.burnInTicks;
        const epochs = Math.max(1, Math.round(numberConfig(config, 'epochs', 24)));
        const migrationChance = clamp(numberConfig(config, 'migrationChancePerEpoch', 0.08));
        const annualGrowth = numberConfig(config, 'annualNetGrowth', 0.004);
        const hazardMortality = Math.max(0, numberConfig(config, 'hazardMortality', 0.003));
        const crisisBaseChance = clamp(numberConfig(config, 'crisisBaseChancePerEpoch', 0.025));
        const lifecycleChance = clamp(numberConfig(config, 'settlementLifecycleChancePerEpoch', 0.045));
        const splitPressure = Math.max(0.5, numberConfig(config, 'settlementSplitPressure', 0.86));
        const abandonmentPopulation = Math.max(0, Math.round(numberConfig(config, 'settlementAbandonmentPopulation', 45)));
        const resourceShockChance = clamp(numberConfig(config, 'resourceShockChancePerEcologyEpoch', 0.06));
        const settlements = context.snapshot.entities.filter((entity) => entity.kind === 'settlement');
        const cohorts = context.snapshot.entities.filter((entity) => entity.kind === 'population-cohort');
        const initialPopulationTotal = settlements.reduce((sum, settlement) => sum + Math.max(0, Number(settlement.components.population ?? 0)), 0);
        const regions = new Map(regionEntities(context).map((region) => [region.id, region]));
        const routeRelations = context.snapshot.relations.filter((relation) => relation.kind === 'route-link');
        const routesFrom = (settlementId) => routeRelations.filter((relation) => relation.sourceId === settlementId || relation.targetId === settlementId).map((relation) => ({ relation, targetId: relation.sourceId === settlementId ? relation.targetId : relation.sourceId }));
        const yearsPerEpoch = Math.max(1 / 365, burnIn / Math.max(1, context.recipe.clock.ticksPerDay) / 365 / epochs);
        let birthsTotal = 0;
        let deathsTotal = 0;
        let migrationTotal = 0;
        let crisisCount = 0;
        let foundedSettlementCount = 0;
        let abandonedSettlementCount = 0;
        let mergedSettlementCount = 0;
        let ecologicalRangeShiftCount = 0;
        let ecologicalExtirpationCount = 0;
        let landscapeSuccessionEventCount = 0;
        let ecologicalResourceShockCount = 0;
        for (let e = 1; e <= epochs; e += 1) {
            const tick = startTick + Math.round((burnIn * e) / epochs);
            for (const settlement of settlements) {
                if (settlement.endedTick !== undefined && settlement.endedTick <= tick)
                    continue;
                const rng = context.rng.stream('history-demography', settlement.id, e);
                const oldPop = typeof settlement.components.population === 'number' ? settlement.components.population : 1;
                const capacity = Math.max(1, typeof settlement.components.carryingCapacity === 'number' ? settlement.components.carryingCapacity : oldPop * 2);
                const region = regions.get(String(settlement.components.regionId ?? ''));
                const env = recordComponent(region?.components.environment);
                const productivity = typeof env.productivityIndex === 'number' ? env.productivityIndex : 0.5;
                const hazard = typeof env.hazardIndex === 'number' ? env.hazardIndex : 0.5;
                const density = oldPop / capacity;
                const densityResponse = clamp(1.15 - density, -0.8, 1);
                const stochasticAnnual = rng.float(-0.0035, 0.0035);
                const annualRate = annualGrowth * (0.55 + productivity * 0.9) * densityResponse - hazardMortality * hazard + stochasticAnnual;
                const births = Math.max(0, Math.round(oldPop * Math.max(0, 0.018 + annualRate * 0.7) * yearsPerEpoch));
                const deaths = Math.max(0, Math.min(oldPop + births - 1, Math.round(oldPop * Math.max(0, 0.014 - annualRate * 0.3 + hazardMortality * hazard) * yearsPerEpoch)));
                let nextPop = Math.max(1, oldPop + births - deaths);
                birthsTotal += births;
                deathsTotal += deaths;
                const crisisChance = clamp(crisisBaseChance * (0.45 + hazard * 1.5) * Math.min(2, yearsPerEpoch / 2));
                if (rng.bool(crisisChance) && nextPop > 10) {
                    const lossFraction = clamp(rng.float(0.01, 0.08) * (0.5 + hazard), 0.005, 0.15);
                    const crisisDeaths = Math.min(nextPop - 1, Math.max(1, Math.round(nextPop * lossFraction)));
                    nextPop -= crisisDeaths;
                    deathsTotal += crisisDeaths;
                    crisisCount += 1;
                    const crisisCause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'demographic-crisis', settlementId: settlement.id, deaths: crisisDeaths, hazardIndex: hazard }, tick);
                    builder.event('demographic-crisis', tick, [settlement.id], [], { deaths: crisisDeaths, hazardIndex: hazard, lossFraction }, [crisisCause], [context.provenance(passId)], settlement.spatial);
                }
                if (births > 0 || deaths > 0) {
                    const cause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'demographic-balance', settlementId: settlement.id, fromPopulation: oldPop, births, deaths, toPopulation: nextPop, carryingCapacity: capacity }, tick);
                    builder.event('macro-demographic-transition', tick, [settlement.id], [], { fromPopulation: oldPop, births, deaths, toPopulation: nextPop, carryingCapacity: capacity }, [cause], [context.provenance(passId)], settlement.spatial);
                }
                settlement.components.population = nextPop;
                const cohort = cohorts.find((item) => item.components.settlementId === settlement.id);
                if (cohort) {
                    cohort.components.count = nextPop;
                    const age = recordComponent(cohort.components.ageStructure);
                    const juvenile = clamp((typeof age.juvenile === 'number' ? age.juvenile : 0.25) * 0.92 + clamp(births / Math.max(1, nextPop), 0, 0.2) * 0.4);
                    const elder = clamp((typeof age.elder === 'number' ? age.elder : 0.12) * 0.98 + yearsPerEpoch * 0.0015, 0.02, 0.4);
                    cohort.components.ageStructure = { juvenile, adult: Math.max(0, 1 - juvenile - elder), elder };
                    const health = typeof cohort.components.healthIndex === 'number' ? cohort.components.healthIndex : 0.6;
                    cohort.components.healthIndex = clamp(health * 0.9 + (0.45 + productivity * 0.4 - hazard * 0.2) * 0.1);
                    const households = recordComponent(cohort.components.householdDemography);
                    if (Object.keys(households).length) {
                        const oldCount = Math.max(1, Number(households.householdCount ?? 1));
                        const formationRate = Math.max(0, Number(households.formationRateAnnual ?? 0.04));
                        const dissolutionRate = Math.max(0, Number(households.dissolutionRateAnnual ?? 0.03));
                        const formed = Math.max(0, Math.round(oldCount * formationRate * yearsPerEpoch));
                        const dissolved = Math.max(0, Math.min(oldCount + formed - 1, Math.round(oldCount * dissolutionRate * yearsPerEpoch * (1 + hazard * 0.4))));
                        const desiredCount = Math.max(1, Math.round(nextPop / Math.max(1.5, Number(households.meanHouseholdSize ?? 4))));
                        const nextCount = Math.max(1, Math.round((oldCount + formed - dissolved) * 0.65 + desiredCount * 0.35));
                        households.householdCount = nextCount;
                        households.meanHouseholdSize = nextPop / nextCount;
                        households.lastFormed = formed;
                        households.lastDissolved = dissolved;
                        households.dependencySupportIndex = clamp(Number(households.dependencySupportIndex ?? 0.5) * 0.92 + Number(cohort.components.healthIndex ?? 0.5) * 0.08);
                        cohort.components.householdDemography = households;
                        if (formed || dissolved) {
                            const householdCause = builder.causal('state-transition', false, cohort.provenanceIds, { transition: 'household-demography', cohortId: cohort.id, formed, dissolved, fromHouseholds: oldCount, toHouseholds: nextCount }, tick);
                            builder.event('household-demographic-transition', tick, [settlement.id], [cohort.id], { formed, dissolved, fromHouseholds: oldCount, toHouseholds: nextCount, meanHouseholdSize: households.meanHouseholdSize }, [householdCause], [context.provenance(passId)], settlement.spatial);
                        }
                    }
                }
                const morphology = recordComponent(settlement.components.morphology);
                if (Object.keys(morphology).length) {
                    const oldArea = Math.max(0.001, Number(morphology.builtAreaKm2 ?? 0.001));
                    const densityTarget = Math.max(350, 1800 + Number(settlement.components.siteSuitability ?? 0.5) * 2200);
                    const targetArea = Math.max(0.01, nextPop / densityTarget);
                    const nextArea = oldArea + (targetArea - oldArea) * Math.min(1, 0.22 + yearsPerEpoch * 0.08);
                    morphology.builtAreaKm2 = nextArea;
                    const history = Array.isArray(morphology.expansionHistory) ? morphology.expansionHistory : [];
                    if (Math.abs(nextArea - oldArea) / oldArea >= 0.015)
                        history.push({ tick, builtAreaKm2: nextArea, population: nextPop });
                    morphology.expansionHistory = history;
                    settlement.components.morphology = morphology;
                }
            }
            if (settlements.length > 1)
                for (const source of settlements) {
                    if (source.endedTick !== undefined && source.endedTick <= tick)
                        continue;
                    const rng = context.rng.stream('history-migration', source.id, e);
                    if (!rng.bool(migrationChance))
                        continue;
                    const sourcePop = typeof source.components.population === 'number' ? source.components.population : 0;
                    const sourceCapacity = Math.max(1, typeof source.components.carryingCapacity === 'number' ? source.components.carryingCapacity : sourcePop);
                    if (sourcePop <= 1)
                        continue;
                    const sourceRegion = regions.get(String(source.components.regionId ?? ''));
                    const sourceEnv = recordComponent(sourceRegion?.components.environment);
                    const sourceHazard = typeof sourceEnv.hazardIndex === 'number' ? sourceEnv.hazardIndex : 0.5;
                    const pressure = clamp(sourcePop / sourceCapacity * 0.65 + sourceHazard * 0.35);
                    const routes = routesFrom(source.id);
                    const weighted = routes.map(({ relation, targetId }) => {
                        const target = settlements.find((item) => item.id === targetId);
                        if (!target || (target.endedTick !== undefined && target.endedTick <= tick))
                            return { value: undefined, weight: 0 };
                        const targetPop = typeof target.components.population === 'number' ? target.components.population : 0;
                        const targetCapacity = Math.max(1, typeof target.components.carryingCapacity === 'number' ? target.components.carryingCapacity : targetPop + 1);
                        const opportunity = clamp(1 - targetPop / targetCapacity + 0.15, 0.02, 1.2);
                        const accessibility = typeof relation.data?.accessibility === 'number' ? relation.data.accessibility : 0.1;
                        return { value: target, weight: opportunity * accessibility };
                    }).filter((item) => !!item.value);
                    const target = weightedPick(weighted, rng.next());
                    if (!target)
                        continue;
                    const transferRate = rng.float(0.001, 0.012) * (0.35 + pressure);
                    const transfer = Math.min(sourcePop - 1, Math.max(1, Math.round(sourcePop * transferRate)));
                    if (transfer <= 0)
                        continue;
                    source.components.population = sourcePop - transfer;
                    const targetPop = typeof target.components.population === 'number' ? target.components.population : 0;
                    target.components.population = targetPop + transfer;
                    const sourceCohort = cohorts.find((item) => item.components.settlementId === source.id);
                    const targetCohort = cohorts.find((item) => item.components.settlementId === target.id);
                    if (sourceCohort)
                        sourceCohort.components.count = source.components.population;
                    if (targetCohort)
                        targetCohort.components.count = target.components.population;
                    const route = routes.find((item) => item.targetId === target.id)?.relation;
                    const cause = builder.causal('state-transition', false, [source.provenanceIds[0] ?? '', target.provenanceIds[0] ?? ''].filter(Boolean), { transition: 'migration', sourceId: source.id, targetId: target.id, count: transfer, routeId: route?.id ?? null, pressure }, tick);
                    builder.event('macro-migration', tick, [source.id], [target.id], { count: transfer, routeId: route?.id ?? null, accessibility: route?.data?.accessibility ?? null }, [cause], [context.provenance(passId)], source.spatial);
                    migrationTotal += transfer;
                }
            // Settlement lifecycle is conservative: splits/mergers move existing population rather than creating or deleting it.
            const lifecycleCandidates = settlements.filter((settlement) => settlement.endedTick === undefined || settlement.endedTick > tick);
            for (const settlement of lifecycleCandidates) {
                const rng = context.rng.stream('history-settlement-lifecycle', settlement.id, e);
                if (!rng.bool(lifecycleChance))
                    continue;
                const population = Math.max(0, Math.round(typeof settlement.components.population === 'number' ? settlement.components.population : 0));
                const capacity = Math.max(1, Math.round(typeof settlement.components.carryingCapacity === 'number' ? settlement.components.carryingCapacity : Math.max(1, population)));
                const pressure = population / capacity;
                const cohort = cohorts.find((item) => item.components.settlementId === settlement.id);
                const routeOptions = routesFrom(settlement.id).map(({ relation, targetId }) => ({ relation, target: settlements.find((item) => item.id === targetId) })).filter((item) => !!item.target && (item.target.endedTick === undefined || item.target.endedTick > tick));
                if (pressure >= splitPressure && population >= 120) {
                    const transfer = Math.max(20, Math.min(population - 1, Math.round(population * rng.float(0.08, 0.18))));
                    if (transfer <= 0)
                        continue;
                    const regionId = String(settlement.components.regionId ?? '');
                    const region = regions.get(regionId);
                    const spatial = settlement.spatial ? {
                        ...settlement.spatial,
                        x: clamp(settlement.spatial.x + rng.float(-3, 3), 0, context.recipe.geometry.extent.widthKm),
                        y: clamp(settlement.spatial.y + rng.float(-3, 3), 0, context.recipe.geometry.extent.heightKm),
                        regionId,
                    } : region?.spatial;
                    const cause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'settlement-split', parentSettlementId: settlement.id, populationTransfer: transfer }, tick);
                    const child = builder.entity('settlement', [settlement.id, 'split', e], {
                        regionId,
                        population: transfer,
                        carryingCapacity: Math.max(transfer + 1, Math.round(capacity * rng.float(0.32, 0.65))),
                        siteSuitability: clamp((typeof settlement.components.siteSuitability === 'number' ? settlement.components.siteSuitability : 0.5) + rng.float(-0.08, 0.08)),
                        developmentIndex: clamp((typeof settlement.components.developmentIndex === 'number' ? settlement.components.developmentIndex : 0.5) * rng.float(0.55, 0.82)),
                        waterAccessIndex: typeof settlement.components.waterAccessIndex === 'number' ? settlement.components.waterAccessIndex : 0,
                        foundedTick: tick,
                        parentSettlementId: settlement.id,
                        morphology: (() => { const parent = recordComponent(settlement.components.morphology); const parentArea = Math.max(0.01, Number(parent.builtAreaKm2 ?? transfer / 2500)); const builtAreaKm2 = Math.max(0.01, Math.min(parentArea * 0.45, transfer / Math.max(450, 1600 + Number(settlement.components.siteSuitability ?? 0.5) * 1800))); return { builtAreaKm2, orientationRadians: Number(parent.orientationRadians ?? 0), elongation: Number(parent.elongation ?? 1), terrainFollowingIndex: Number(parent.terrainFollowingIndex ?? 0.5), waterFollowingIndex: Number(parent.waterFollowingIndex ?? settlement.components.waterAccessIndex ?? 0), expansionHistory: [{ tick, builtAreaKm2, population: transfer }] }; })(),
                    }, [cause], spatial);
                    child.bornTick = tick;
                    settlement.components.population = population - transfer;
                    if (cohort)
                        cohort.components.count = population - transfer;
                    const sourceAge = recordComponent(cohort?.components.ageStructure);
                    const childCohort = builder.entity('population-cohort', [child.id, String(cohort?.components.populationKind ?? 'unspecified-population')], {
                        settlementId: child.id,
                        populationKind: String(cohort?.components.populationKind ?? 'unspecified-population'),
                        count: transfer,
                        ageStructure: Object.keys(sourceAge).length ? sourceAge : { juvenile: 0.25, adult: 0.63, elder: 0.12 },
                        healthIndex: typeof cohort?.components.healthIndex === 'number' ? cohort.components.healthIndex : 0.6,
                        householdDemography: (() => { const source = recordComponent(cohort?.components.householdDemography); const meanHouseholdSize = Math.max(1.5, Number(source.meanHouseholdSize ?? 4)); return { householdCount: Math.max(1, Math.round(transfer / meanHouseholdSize)), meanHouseholdSize, formationRateAnnual: Number(source.formationRateAnnual ?? 0.04), dissolutionRateAnnual: Number(source.dissolutionRateAnnual ?? 0.03), fertilityIndex: Number(source.fertilityIndex ?? 0.8), dependencySupportIndex: Number(source.dependencySupportIndex ?? 0.5) }; })(),
                    }, [cause], spatial);
                    childCohort.bornTick = tick;
                    cohorts.push(childCohort);
                    settlements.push(child);
                    builder.relation('resides-in', childCohort.id, child.id, [cause]);
                    if (region)
                        builder.relation('located-in', child.id, region.id, [cause]);
                    const route = builder.relation('route-link', settlement.id, child.id, [cause], { distanceKm: wrappedDistanceKm(settlement.spatial, child.spatial, context), accessibility: 0.72, roughnessCost: 0.25, capacityIndex: 0.62, lifecycleOrigin: 'settlement-split' });
                    routeRelations.push(route);
                    builder.event('settlement-founded', tick, [settlement.id], [child.id], { populationTransfer: transfer, mechanism: 'split', routeId: route.id }, [cause], [context.provenance(passId)], child.spatial);
                    foundedSettlementCount += 1;
                    continue;
                }
                if (population <= abandonmentPopulation && routeOptions.length > 0) {
                    const targetOption = routeOptions.slice().sort((a, b) => (Number(b.relation.data?.accessibility ?? 0) - Number(a.relation.data?.accessibility ?? 0)) || a.target.id.localeCompare(b.target.id))[0];
                    const target = targetOption.target;
                    const targetPop = Math.max(0, Math.round(typeof target.components.population === 'number' ? target.components.population : 0));
                    target.components.population = targetPop + population;
                    const targetCohort = cohorts.find((item) => item.components.settlementId === target.id);
                    if (targetCohort)
                        targetCohort.components.count = Math.max(0, Math.round(Number(targetCohort.components.count ?? targetPop))) + population;
                    settlement.components.population = 0;
                    if (cohort)
                        cohort.components.count = 0;
                    settlement.endedTick = tick;
                    const mechanism = population <= Math.max(4, Math.round(abandonmentPopulation * 0.2)) ? 'abandonment' : 'merger';
                    const cause = builder.causal('state-transition', false, [settlement.provenanceIds[0] ?? '', target.provenanceIds[0] ?? ''].filter(Boolean), { transition: `settlement-${mechanism}`, sourceSettlementId: settlement.id, targetSettlementId: target.id, populationTransfer: population }, tick);
                    builder.event(mechanism === 'abandonment' ? 'settlement-abandoned' : 'settlement-merged', tick, [settlement.id], [target.id], { populationTransfer: population, routeId: targetOption.relation.id }, [cause], [context.provenance(passId)], settlement.spatial);
                    if (mechanism === 'abandonment')
                        abandonedSettlementCount += 1;
                    else
                        mergedSettlementCount += 1;
                }
            }
            // Long-horizon ecological succession and range shifts use the same burn-in clock as societies.
            const ecologyStride = Math.max(1, Math.floor(epochs / 8));
            if (e % ecologyStride === 0 || e === epochs) {
                const guilds = context.snapshot.entities.filter((entity) => entity.kind === 'ecological-guild');
                for (const region of regions.values()) {
                    const environment = recordComponent(region.components.environment);
                    const oldSuccession = clamp(Number(environment.successionStage ?? 0.5));
                    const productivity = clamp(Number(environment.productivityIndex ?? 0.5));
                    const hazard = clamp(Number(environment.hazardIndex ?? 0.5));
                    const erng = context.rng.stream('history-landscape-succession', region.id, e);
                    const targetSuccession = clamp(productivity * 0.7 + (1 - hazard) * 0.3);
                    const nextSuccession = clamp(oldSuccession + (targetSuccession - oldSuccession) * Math.min(0.4, yearsPerEpoch * 0.035) + erng.float(-0.025, 0.025));
                    environment.successionStage = nextSuccession;
                    region.components.environment = environment;
                    if (Math.abs(nextSuccession - oldSuccession) >= 0.015) {
                        const cause = builder.causal('state-transition', false, region.provenanceIds, { transition: 'landscape-succession', regionId: region.id, fromStage: oldSuccession, toStage: nextSuccession }, tick);
                        builder.event('landscape-succession', tick, [], [region.id], { fromStage: oldSuccession, toStage: nextSuccession, productivityIndex: productivity, hazardIndex: hazard }, [cause], [context.provenance(passId)], region.spatial);
                        landscapeSuccessionEventCount += 1;
                    }
                }
                for (const resource of context.snapshot.entities.filter((entity) => entity.kind === 'ecological-resource')) {
                    const rrng = context.rng.stream('history-ecological-resource', resource.id, e);
                    if (!rrng.bool(resourceShockChance))
                        continue;
                    const fromStock = Math.max(0, Number(resource.components.currentStock ?? 0));
                    const capacity = Math.max(1, Number(resource.components.carryingStock ?? 1));
                    const renewable = Boolean(resource.components.renewable);
                    const collapse = rrng.bool(0.58);
                    let toStock = fromStock;
                    let kind = 'recovery';
                    if (collapse && fromStock > capacity * 0.025) {
                        toStock = Math.max(0, fromStock * rrng.float(0.38, 0.82));
                        kind = 'collapse';
                    }
                    else if (renewable && fromStock < capacity * 0.98) {
                        toStock = Math.min(capacity, fromStock + (capacity - fromStock) * rrng.float(0.08, 0.32));
                        kind = 'recovery';
                    }
                    if (Math.abs(toStock - fromStock) <= 1e-9)
                        continue;
                    resource.components.currentStock = toStock;
                    resource.components.depletionFraction = clamp(1 - toStock / capacity);
                    const cause = builder.causal('state-transition', false, resource.provenanceIds, { transition: `ecological-resource-${kind}`, resourceId: resource.id, fromStock, toStock }, tick);
                    builder.event(`ecological-resource-${kind}`, tick, [], [resource.id], { fromStock, toStock, carryingStock: capacity }, [cause], [context.provenance(passId)], resource.spatial);
                    ecologicalResourceShockCount += 1;
                }
                for (const guild of guilds) {
                    const regionId = String(guild.components.regionId ?? '');
                    const region = regions.get(regionId);
                    if (!region)
                        continue;
                    const environment = recordComponent(region.components.environment);
                    const productivity = clamp(Number(environment.productivityIndex ?? 0.5));
                    const hazard = clamp(Number(environment.hazardIndex ?? 0.5));
                    const capacity = Math.max(1, Number(guild.components.abundanceCapacity ?? 1));
                    const oldAbundance = Math.max(0, Number(guild.components.abundance ?? 0));
                    const grng = context.rng.stream('history-ecological-guild', guild.id, e);
                    const reproduction = Math.max(0, Number(guild.components.reproductionRatePerDay ?? 0.001)) * 365 * yearsPerEpoch;
                    const mortality = Math.max(0, Number(guild.components.mortalityRatePerDay ?? 0.001)) * 365 * yearsPerEpoch;
                    const growthRate = Math.min(0.35, reproduction * 0.01) * productivity * Math.max(0, 1 - oldAbundance / capacity);
                    const lossRate = Math.min(0.28, mortality * 0.008) * (0.55 + hazard * 0.7);
                    const nextAbundance = Math.max(0, Math.min(capacity, oldAbundance * (1 + growthRate - lossRate + grng.float(-0.025, 0.025))));
                    guild.components.abundance = nextAbundance;
                    if (oldAbundance >= 1 && nextAbundance < 1) {
                        guild.components.localStatus = 'extirpated';
                        const cause = builder.causal('state-transition', false, guild.provenanceIds, { transition: 'local-extirpation', guildId: guild.id, regionId }, tick);
                        builder.event('ecological-local-extirpation', tick, [], [guild.id, region.id], { fromAbundance: oldAbundance, toAbundance: nextAbundance }, [cause], [context.provenance(passId)], guild.spatial);
                        ecologicalExtirpationCount += 1;
                    }
                    const pressure = nextAbundance / capacity;
                    if (pressure < 0.72 || !grng.bool(0.18))
                        continue;
                    const candidates = guilds.filter((candidate) => candidate.id !== guild.id && candidate.components.guildKind === guild.components.guildKind && candidate.components.regionId !== regionId && candidate.spatial);
                    const target = candidates.slice().sort((a, b) => wrappedDistanceKm(guild.spatial, a.spatial, context) - wrappedDistanceKm(guild.spatial, b.spatial, context) || a.id.localeCompare(b.id))[0];
                    if (!target)
                        continue;
                    const targetCapacity = Math.max(1, Number(target.components.abundanceCapacity ?? 1));
                    const targetAbundance = Math.max(0, Number(target.components.abundance ?? 0));
                    if (targetAbundance / targetCapacity >= pressure * 0.9)
                        continue;
                    const transfer = Math.min(nextAbundance * 0.06, Math.max(0, targetCapacity - targetAbundance) * 0.12);
                    if (transfer <= 0.01)
                        continue;
                    guild.components.abundance = Math.max(0, Number(guild.components.abundance ?? 0) - transfer);
                    target.components.abundance = Math.min(targetCapacity, targetAbundance + transfer);
                    const cause = builder.causal('state-transition', false, [...guild.provenanceIds, ...target.provenanceIds], { transition: 'ecological-range-shift', guildKind: String(guild.components.guildKind ?? ''), sourceGuildId: guild.id, targetGuildId: target.id, abundanceTransfer: transfer }, tick);
                    builder.event('ecological-range-shift', tick, [guild.id], [target.id], { abundanceTransfer: transfer, sourceRegionId: regionId, targetRegionId: String(target.components.regionId ?? '') }, [cause], [context.provenance(passId)], guild.spatial);
                    ecologicalRangeShiftCount += 1;
                }
            }
        }
        context.snapshot.manifest.currentTick = startTick + burnIn;
        const finalPopulationTotal = settlements.reduce((sum, settlement) => sum + Math.max(0, Number(settlement.components.population ?? 0)), 0);
        const expectedPopulationTotal = initialPopulationTotal + birthsTotal - deathsTotal;
        context.snapshot.aggregates.history = {
            burnInTicks: burnIn, epochs, yearsPerEpoch, birthsTotal, deathsTotal, migrationTotal, crisisCount,
            foundedSettlementCount, abandonedSettlementCount, mergedSettlementCount,
            initialPopulationTotal, finalPopulationTotal, expectedPopulationTotal,
            populationAccountingError: finalPopulationTotal - expectedPopulationTotal,
            ecologicalRangeShiftCount, ecologicalExtirpationCount, landscapeSuccessionEventCount, ecologicalResourceShockCount,
        };
    },
};
export const societyModule = {
    id: 'society', version: '1.3.0', capabilities: [
        'institutions', 'economy', 'social-organization', 'route-coupled-exchange', 'trade-network',
        'resource-stocks', 'logistics-throughput', 'derived-political-geography', 'polity-interfaces',
    ],
    runPass(passId, config, context) {
        if (passId !== 'society:present')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const institutionTypes = stringArrayConfig(config, 'institutionTypes', ['coordination']);
        const resourceTypes = stringArrayConfig(config, 'resourceTypes', ['staple', 'materials', 'energy']);
        const rawProductionRecipes = Array.isArray(config.productionRecipes)
            ? config.productionRecipes.filter((value) => !!value && typeof value === 'object' && !Array.isArray(value))
            : [];
        const productionRecipes = rawProductionRecipes.length ? rawProductionRecipes : resourceTypes.map((resourceId, index) => ({
            id: `default:${resourceId}`,
            outputResource: resourceId,
            laborPerUnit: 0.45 + index * 0.1,
            ecologicalInputs: [{ resourceKind: index === 0 ? 'biomass' : index === 1 ? 'mineral-access' : 'freshwater', extractionPerOutput: index === 1 ? 0.12 : 0.04 }],
        }));
        const settlements = context.snapshot.entities.filter((entity) => entity.kind === 'settlement' && (entity.endedTick === undefined || entity.endedTick > context.snapshot.manifest.currentTick));
        const regions = new Map(regionEntities(context).map((region) => [region.id, region]));
        const routes = context.snapshot.relations.filter((relation) => relation.kind === 'route-link' && settlements.some((item) => item.id === relation.sourceId) && settlements.some((item) => item.id === relation.targetId));
        const tradeThreshold = clamp(numberConfig(config, 'tradeThreshold', 0.08), 0, 1);
        const resourceNeedScale = Math.max(0.000001, numberConfig(config, 'resourceNeedScale', 0.0008));
        const reserveDays = Math.max(1, numberConfig(config, 'reserveDays', 45));
        const transportScale = Math.max(0.01, numberConfig(config, 'transportScale', 160));
        const economicInstitutions = recordComponent(config.economicInstitutions);
        const economicInstitutionEnabled = economicInstitutions.enabled === true;
        const debtEnabled = economicInstitutions.debtEnabled !== false;
        const annualInterestRate = Math.max(0, Number(economicInstitutions.annualInterestRate ?? 0.04));
        const contractKinds = Array.isArray(economicInstitutions.contractKinds) ? economicInstitutions.contractKinds.filter((value) => typeof value === 'string' && value.length > 0) : ['spot-exchange', 'forward-supply'];
        const marketBySettlement = new Map();
        const accountBySettlement = new Map();
        let tradeLinkCount = 0;
        let logisticsFlowCount = 0;
        let totalLogisticsFlow = 0;
        let marketInstitutionCount = 0;
        let tradeContractCount = 0;
        let debtObligationCount = 0;
        for (const settlement of settlements) {
            const rng = context.rng.stream('society', settlement.id);
            const region = regions.get(String(settlement.components.regionId ?? ''));
            const env = recordComponent(region?.components.environment);
            const productivity = typeof env.productivityIndex === 'number' ? env.productivityIndex : 0.5;
            const resources = typeof env.resourceDiversityIndex === 'number' ? env.resourceDiversityIndex : 0.5;
            const hazard = typeof env.hazardIndex === 'number' ? env.hazardIndex : 0.5;
            const population = Math.max(1, typeof settlement.components.population === 'number' ? settlement.components.population : 1);
            const capacity = Math.max(population, typeof settlement.components.carryingCapacity === 'number' ? settlement.components.carryingCapacity : population);
            const routeSet = routes.filter((relation) => relation.sourceId === settlement.id || relation.targetId === settlement.id);
            const routeAccess = routeSet.length ? routeSet.reduce((sum, relation) => sum + (typeof relation.data?.accessibility === 'number' ? relation.data.accessibility : 0), 0) / routeSet.length : 0;
            const development = typeof settlement.components.developmentIndex === 'number' ? settlement.components.developmentIndex : 0.5;
            const productionIndex = clamp(productivity * 0.48 + resources * 0.28 + development * 0.18 + rng.float(-0.04, 0.04));
            const exchangeIndex = clamp(routeAccess * 0.65 + resources * 0.15 + development * 0.2);
            const infrastructureIndex = clamp(development * 0.5 + routeAccess * 0.35 + (1 - hazard) * 0.15);
            const density = population / capacity;
            const reservesIndex = clamp(productionIndex * (1 - Math.min(1, density) * 0.48) + infrastructureIndex * 0.18);
            const cohort = context.snapshot.entities.find((entity) => entity.kind === 'population-cohort' && entity.components.settlementId === settlement.id);
            const age = recordComponent(cohort?.components.ageStructure);
            const adultShare = clamp(typeof age.adult === 'number' ? age.adult : 0.62, 0.05, 0.95);
            const laborAvailable = population * adultShare;
            const ecologicalResources = context.snapshot.entities.filter((entity) => entity.kind === 'ecological-resource' && entity.components.regionId === settlement.components.regionId);
            const resourceEconomy = {};
            let laborDemanded = 0;
            for (let r = 0; r < resourceTypes.length; r += 1) {
                const resourceId = resourceTypes[r];
                const rrng = context.rng.stream('society-resource', settlement.id, resourceId);
                const recipe = productionRecipes.find((candidate) => candidate.outputResource === resourceId) ?? productionRecipes[r % productionRecipes.length];
                const ecologicalInputs = Array.isArray(recipe.ecologicalInputs)
                    ? recipe.ecologicalInputs.filter((value) => !!value && typeof value === 'object' && !Array.isArray(value))
                    : [];
                const economicInputs = Array.isArray(recipe.economicInputs)
                    ? recipe.economicInputs.filter((value) => !!value && typeof value === 'object' && !Array.isArray(value))
                    : [];
                const supplyFactors = ecologicalInputs.map((input) => {
                    const resourceKind = String(input.resourceKind ?? '');
                    const stock = ecologicalResources.find((entity) => entity.components.resourceKind === resourceKind);
                    return stock ? clamp(Number(stock.components.currentStock ?? 0) / Math.max(1, Number(stock.components.carryingStock ?? 1))) : 0.5;
                });
                const ecologicalSupplyIndex = supplyFactors.length ? Math.min(...supplyFactors) : 1;
                const localAffinity = clamp(resources * 0.4 + productivity * 0.22 + ecologicalSupplyIndex * 0.28 + rrng.float(0.05, 0.95) * 0.1);
                const needBias = 0.78 + ((r % 3) * 0.11) + rrng.float(-0.08, 0.08);
                const consumptionPerDay = Math.max(0.000001, population * resourceNeedScale * needBias);
                const potentialProduction = Math.max(0, population * resourceNeedScale * (0.55 + productionIndex * 0.78 + localAffinity * 0.42 + rrng.float(-0.22, 0.22)));
                const laborPerUnit = Math.max(0.000001, Number(recipe.laborPerUnit ?? 0.5));
                const laborDemand = potentialProduction * laborPerUnit;
                laborDemanded += laborDemand;
                const productionPerDay = potentialProduction * (0.45 + ecologicalSupplyIndex * 0.55);
                const balancePerDay = productionPerDay - consumptionPerDay;
                const stock = Math.max(0, consumptionPerDay * reserveDays * (0.35 + reservesIndex * 0.9) + Math.max(0, balancePerDay) * reserveDays * rrng.float(0.35, 0.9));
                const targetStock = consumptionPerDay * reserveDays;
                const shortageIndex = clamp(1 - stock / Math.max(consumptionPerDay, targetStock));
                resourceEconomy[resourceId] = {
                    productionRecipeId: String(recipe.id ?? `recipe:${resourceId}`), productionPerDay, consumptionPerDay, balancePerDay, stock, targetStock,
                    localAffinity, ecologicalSupplyIndex, ecologicalInputs, economicInputs, laborPerUnit, laborDemandPerDay: laborDemand, shortageIndex,
                };
            }
            const laborUtilization = clamp(laborDemanded / Math.max(1, laborAvailable));
            const laborConstraint = clamp(laborAvailable / Math.max(1, laborDemanded), 0, 1);
            settlement.components.economy = {
                productionIndex, exchangeIndex, infrastructureIndex, reservesIndex, routeDegree: routeSet.length, routeAccessIndex: routeAccess,
                resources: resourceEconomy, imports: {}, exports: {}, logisticsThroughputIndex: clamp(routeSet.reduce((sum, route) => sum + Number(route.data?.capacityIndex ?? 0), 0) / Math.max(1, routeSet.length)),
                labor: { available: laborAvailable, demanded: laborDemanded, utilization: laborUtilization, constraint: laborConstraint },
            };
            if (economicInstitutionEnabled) {
                const marketCause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'market-institution-formation', settlementId: settlement.id }, context.snapshot.manifest.currentTick);
                const market = builder.entity('market-institution', [settlement.id, 'market'], {
                    settlementId: settlement.id, priceFormation: 'stock-shortage-route-access', contractKinds, annualInterestRate,
                    governanceIndex: clamp(infrastructureIndex * 0.45 + exchangeIndex * 0.35 + reservesIndex * 0.2),
                }, [marketCause], settlement.spatial, 'market');
                const account = builder.entity('economic-account', [settlement.id, 'aggregate-account'], {
                    settlementId: settlement.id, ownerClass: 'settlement-aggregate',
                    ownershipLedger: Object.fromEntries(Object.entries(resourceEconomy).map(([resourceId, value]) => [resourceId, Math.max(0, Number(recordComponent(value).stock ?? 0))])),
                    debtBalance: 0, creditBalance: 0,
                }, [marketCause], settlement.spatial, 'aggregate-ledger');
                builder.relation('market-based-in', market.id, settlement.id, [marketCause]);
                builder.relation('account-administered-by', account.id, market.id, [marketCause]);
                builder.relation('account-represents', account.id, settlement.id, [marketCause]);
                marketBySettlement.set(settlement.id, market);
                accountBySettlement.set(settlement.id, account);
                marketInstitutionCount += 1;
            }
            const cohesionIndex = clamp(0.35 + reservesIndex * 0.3 + infrastructureIndex * 0.22 - hazard * 0.12 + rng.float(-0.08, 0.08));
            const inequalityIndex = clamp(0.18 + exchangeIndex * 0.28 + development * 0.15 + rng.float(-0.08, 0.12));
            const institutionalCapacityIndex = clamp(infrastructureIndex * 0.42 + cohesionIndex * 0.28 + reservesIndex * 0.3);
            settlement.components.social = { cohesionIndex, inequalityIndex, institutionalCapacityIndex };
            for (const type of institutionTypes) {
                const historyStart = context.recipe.clock.startTick ?? 0;
                const historyEnd = context.snapshot.manifest.currentTick;
                const irng = context.rng.stream('institution-history', settlement.id, type);
                const foundingTick = Math.max(historyStart, Math.round(historyStart + (historyEnd - historyStart) * irng.float(0.08, 0.68)));
                const initialCapacity = clamp(institutionalCapacityIndex * irng.float(0.62, 1.02));
                const initialLegitimacy = clamp(cohesionIndex * irng.float(0.62, 1.02));
                const cause = builder.causal('state-transition', false, settlement.provenanceIds, { transition: 'institution-formation', settlementId: settlement.id, institutionType: type, institutionalCapacityIndex: initialCapacity }, foundingTick);
                const institution = builder.entity('institution', [settlement.id, type], {
                    institutionType: type, capacityIndex: initialCapacity, legitimacyIndex: initialLegitimacy, resourceBaseIndex: reservesIndex,
                    history: [{ tick: foundingTick, kind: 'formation', capacityIndex: initialCapacity, legitimacyIndex: initialLegitimacy }],
                }, [cause], settlement.spatial, type);
                institution.bornTick = foundingTick;
                builder.relation('based-in', institution.id, settlement.id, [cause]);
                builder.event('institution-founded', foundingTick, [settlement.id], [institution.id], { institutionType: type, capacityIndex: initialCapacity, legitimacyIndex: initialLegitimacy }, [cause], [context.provenance(passId)], settlement.spatial);
                let capacityNow = initialCapacity;
                let legitimacyNow = initialLegitimacy;
                const institutionHistory = institution.components.history;
                for (let era = 1; era <= 4; era += 1) {
                    const tick = Math.min(historyEnd, Math.round(foundingTick + (historyEnd - foundingTick) * era / 4));
                    if (tick <= foundingTick)
                        continue;
                    const materialSupport = clamp(reservesIndex * 0.42 + infrastructureIndex * 0.32 + cohesionIndex * 0.26);
                    capacityNow = clamp(capacityNow * 0.82 + materialSupport * 0.18 + irng.float(-0.07, 0.07));
                    legitimacyNow = clamp(legitimacyNow * 0.84 + cohesionIndex * 0.16 - inequalityIndex * 0.035 + irng.float(-0.08, 0.08));
                    const evolutionCause = builder.causal('state-transition', false, [cause], { transition: 'institution-evolution', institutionId: institution.id, era, capacityIndex: capacityNow, legitimacyIndex: legitimacyNow }, tick);
                    builder.event('institution-evolved', tick, [institution.id], [settlement.id], { era, capacityIndex: capacityNow, legitimacyIndex: legitimacyNow }, [evolutionCause], [context.provenance(passId)], settlement.spatial);
                    institutionHistory.push({ tick, kind: 'evolution', capacityIndex: capacityNow, legitimacyIndex: legitimacyNow });
                }
                institution.components.capacityIndex = capacityNow;
                institution.components.legitimacyIndex = legitimacyNow;
                if (irng.bool(0.24) && historyEnd - foundingTick > Math.max(4, context.recipe.clock.ticksPerDay * 30)) {
                    const splitTick = Math.round(foundingTick + (historyEnd - foundingTick) * irng.float(0.35, 0.78));
                    const splitCause = builder.causal('state-transition', false, [cause], { transition: 'institution-split', parentInstitutionId: institution.id, splitTick }, splitTick);
                    const faction = builder.entity('institution', [institution.id, 'split-faction'], {
                        institutionType: type, capacityIndex: clamp(capacityNow * irng.float(0.28, 0.52)), legitimacyIndex: clamp(legitimacyNow * irng.float(0.35, 0.72)),
                        resourceBaseIndex: reservesIndex * irng.float(0.2, 0.5), parentInstitutionId: institution.id,
                        history: [{ tick: splitTick, kind: 'split', parentInstitutionId: institution.id }],
                    }, [splitCause], settlement.spatial, `${type}-faction`);
                    faction.bornTick = splitTick;
                    builder.relation('split-from', faction.id, institution.id, [splitCause]);
                    builder.relation('based-in', faction.id, settlement.id, [splitCause]);
                    builder.event('institution-split', splitTick, [institution.id], [faction.id], { institutionType: type }, [splitCause], [context.provenance(passId)], settlement.spatial);
                    if (irng.bool(0.48) && splitTick < historyEnd) {
                        const mergeTick = Math.round(splitTick + (historyEnd - splitTick) * irng.float(0.35, 0.9));
                        const mergeCause = builder.causal('state-transition', false, [splitCause], { transition: 'institution-merge', sourceInstitutionId: faction.id, targetInstitutionId: institution.id }, mergeTick);
                        faction.endedTick = mergeTick;
                        builder.relation('merged-into', faction.id, institution.id, [mergeCause]);
                        builder.event('institution-merged', mergeTick, [faction.id], [institution.id], {}, [mergeCause], [context.provenance(passId)], settlement.spatial);
                    }
                }
            }
        }
        const stockTotal = () => settlements.reduce((sum, settlement) => {
            const economy = recordComponent(settlement.components.economy);
            const resources = recordComponent(economy.resources);
            return sum + Object.values(resources).reduce((rSum, value) => rSum + Number(recordComponent(value).stock ?? 0), 0);
        }, 0);
        const stockBeforeTrade = stockTotal();
        // Route-bounded logistics: every transfer subtracts and adds the same quantity, so transport itself conserves stock.
        for (const route of routes) {
            const source = settlements.find((item) => item.id === route.sourceId);
            const target = settlements.find((item) => item.id === route.targetId);
            if (!source || !target)
                continue;
            const sourceEconomy = recordComponent(source.components.economy);
            const targetEconomy = recordComponent(target.components.economy);
            const accessibility = typeof route.data?.accessibility === 'number' ? route.data.accessibility : 0;
            const sourceProduction = typeof sourceEconomy.productionIndex === 'number' ? sourceEconomy.productionIndex : 0;
            const targetProduction = typeof targetEconomy.productionIndex === 'number' ? targetEconomy.productionIndex : 0;
            const potential = clamp(accessibility * (0.35 + Math.abs(sourceProduction - targetProduction) * 0.4 + (sourceProduction + targetProduction) * 0.25));
            if (potential >= tradeThreshold) {
                const cause = builder.causal('state-transition', false, route.provenanceIds, { transition: 'exchange-link', routeId: route.id, potential }, context.snapshot.manifest.currentTick);
                builder.relation('exchange-link', route.sourceId, route.targetId, [cause], { routeId: route.id, exchangePotential: potential, accessibility });
                if (economicInstitutionEnabled) {
                    const contractKind = contractKinds[Math.abs(route.id.length + tradeLinkCount) % Math.max(1, contractKinds.length)] ?? 'spot-exchange';
                    const contract = builder.entity('trade-contract', [route.id, contractKind], {
                        routeId: route.id, contractKind, sourceSettlementId: source.id, targetSettlementId: target.id,
                        exchangePotential: potential, status: 'active', createdTick: context.snapshot.manifest.currentTick,
                    }, [cause], source.spatial, contractKind);
                    builder.relation('contract-party', contract.id, source.id, [cause], { role: 'supplier' });
                    builder.relation('contract-party', contract.id, target.id, [cause], { role: 'counterparty' });
                    const sourceMarket = marketBySettlement.get(source.id);
                    const targetMarket = marketBySettlement.get(target.id);
                    if (sourceMarket)
                        builder.relation('contract-governed-by', contract.id, sourceMarket.id, [cause]);
                    if (targetMarket && targetMarket.id !== sourceMarket?.id)
                        builder.relation('contract-governed-by', contract.id, targetMarket.id, [cause]);
                    tradeContractCount += 1;
                }
                tradeLinkCount += 1;
            }
            const capacity = Math.max(0, Number(route.data?.capacityIndex ?? 0)) * accessibility * transportScale;
            let remainingCapacity = capacity;
            for (const resourceId of resourceTypes) {
                if (remainingCapacity <= 0)
                    break;
                const sourceResources = recordComponent(sourceEconomy.resources);
                const targetResources = recordComponent(targetEconomy.resources);
                const a = recordComponent(sourceResources[resourceId]);
                const b = recordComponent(targetResources[resourceId]);
                const aStock = Math.max(0, Number(a.stock ?? 0));
                const bStock = Math.max(0, Number(b.stock ?? 0));
                const aConsumption = Math.max(0.000001, Number(a.consumptionPerDay ?? 0.000001));
                const bConsumption = Math.max(0.000001, Number(b.consumptionPerDay ?? 0.000001));
                const aTarget = aConsumption * reserveDays * 0.85;
                const bTarget = bConsumption * reserveDays * 0.85;
                const aSurplus = Math.max(0, aStock - aTarget) + Math.max(0, Number(a.balancePerDay ?? 0)) * reserveDays * 0.5;
                const bSurplus = Math.max(0, bStock - bTarget) + Math.max(0, Number(b.balancePerDay ?? 0)) * reserveDays * 0.5;
                const aDeficit = Math.max(0, aTarget - aStock);
                const bDeficit = Math.max(0, bTarget - bStock);
                let sender;
                let receiver;
                let senderResource;
                let receiverResource;
                let flow = 0;
                if (aSurplus > 0 && bDeficit > 0) {
                    sender = source;
                    receiver = target;
                    senderResource = a;
                    receiverResource = b;
                    flow = Math.min(aSurplus, bDeficit, remainingCapacity);
                }
                else if (bSurplus > 0 && aDeficit > 0) {
                    sender = target;
                    receiver = source;
                    senderResource = b;
                    receiverResource = a;
                    flow = Math.min(bSurplus, aDeficit, remainingCapacity);
                }
                if (!sender || !receiver || !senderResource || !receiverResource || flow <= 1e-9)
                    continue;
                senderResource.stock = Math.max(0, Number(senderResource.stock ?? 0) - flow);
                receiverResource.stock = Number(receiverResource.stock ?? 0) + flow;
                const senderEconomy = recordComponent(sender.components.economy);
                const receiverEconomy = recordComponent(receiver.components.economy);
                const exports = recordComponent(senderEconomy.exports);
                const imports = recordComponent(receiverEconomy.imports);
                exports[resourceId] = Number(exports[resourceId] ?? 0) + flow;
                imports[resourceId] = Number(imports[resourceId] ?? 0) + flow;
                senderEconomy.exports = exports;
                receiverEconomy.imports = imports;
                const cause = builder.causal('state-transition', false, route.provenanceIds, { transition: 'logistics-flow', routeId: route.id, resourceId, senderId: sender.id, receiverId: receiver.id, quantity: flow }, context.snapshot.manifest.currentTick);
                builder.relation('logistics-flow', sender.id, receiver.id, [cause], { routeId: route.id, resourceId, quantity: flow, capacityUsed: flow / Math.max(1e-9, capacity), accessibility });
                if (economicInstitutionEnabled && debtEnabled) {
                    const principal = Math.max(0, flow * Math.max(0.05, Number(senderResource.priceIndex ?? 1)));
                    const obligation = builder.entity('economic-obligation', [route.id, resourceId, sender.id, receiver.id], {
                        resourceId, principal, annualInterestRate, creditorSettlementId: sender.id, debtorSettlementId: receiver.id,
                        createdTick: context.snapshot.manifest.currentTick, dueTick: context.snapshot.manifest.currentTick + context.recipe.clock.ticksPerDay * 30, status: 'open',
                    }, [cause], receiver.spatial, 'trade-credit');
                    builder.relation('obligation-creditor', obligation.id, sender.id, [cause]);
                    builder.relation('obligation-debtor', obligation.id, receiver.id, [cause]);
                    const creditor = accountBySettlement.get(sender.id);
                    const debtor = accountBySettlement.get(receiver.id);
                    if (creditor) {
                        creditor.components.creditBalance = Number(creditor.components.creditBalance ?? 0) + principal;
                        builder.relation('obligation-posted-to', obligation.id, creditor.id, [cause], { side: 'credit' });
                    }
                    if (debtor) {
                        debtor.components.debtBalance = Number(debtor.components.debtBalance ?? 0) + principal;
                        builder.relation('obligation-posted-to', obligation.id, debtor.id, [cause], { side: 'debt' });
                    }
                    debtObligationCount += 1;
                }
                remainingCapacity -= flow;
                logisticsFlowCount += 1;
                totalLogisticsFlow += flow;
            }
        }
        const stockAfterTrade = stockTotal();
        // Derive political geography from settlement mass, route accessibility and institutional capacity. No authored borders are consumed.
        const requestedHubCount = Math.max(1, Math.min(settlements.length, Math.round(numberConfig(config, 'polityHubCount', Math.max(1, Math.sqrt(Math.max(1, settlements.length)) / 2)))));
        const hubScore = (settlement) => {
            const social = recordComponent(settlement.components.social);
            const economy = recordComponent(settlement.components.economy);
            return Math.max(1, Number(settlement.components.population ?? 1)) * (0.35 + Number(social.institutionalCapacityIndex ?? 0.5)) * (1 + Number(economy.routeDegree ?? 0) * 0.08);
        };
        const hubs = settlements.slice().sort((a, b) => hubScore(b) - hubScore(a) || a.id.localeCompare(b.id)).slice(0, requestedHubCount);
        const adjacency = new Map();
        for (const route of routes) {
            const cost = Math.max(0.001, Number(route.data?.distanceKm ?? 1) / Math.max(0.02, Number(route.data?.accessibility ?? 0.02)));
            if (!adjacency.has(route.sourceId))
                adjacency.set(route.sourceId, []);
            if (!adjacency.has(route.targetId))
                adjacency.set(route.targetId, []);
            adjacency.get(route.sourceId).push({ id: route.targetId, cost });
            adjacency.get(route.targetId).push({ id: route.sourceId, cost });
        }
        // Compute shortest-path fields once per polity hub. The previous pairwise Dijkstra made large settlement graphs superlinear in practice.
        const computeHubDistances = (hubId) => {
            const dist = new Map([[hubId, 0]]);
            const pending = new Set([hubId]);
            const visited = new Set();
            while (pending.size) {
                let current = '';
                let currentCost = Number.POSITIVE_INFINITY;
                for (const id of pending) {
                    const value = dist.get(id) ?? Number.POSITIVE_INFINITY;
                    if (value < currentCost) {
                        current = id;
                        currentCost = value;
                    }
                }
                pending.delete(current);
                if (!current || visited.has(current))
                    continue;
                visited.add(current);
                for (const edge of adjacency.get(current) ?? []) {
                    if (visited.has(edge.id))
                        continue;
                    const next = currentCost + edge.cost;
                    if (next < (dist.get(edge.id) ?? Number.POSITIVE_INFINITY)) {
                        dist.set(edge.id, next);
                        pending.add(edge.id);
                    }
                }
            }
            return dist;
        };
        const hubDistances = new Map(hubs.map((hub) => [hub.id, computeHubDistances(hub.id)]));
        const graphCost = (fromId, toId) => {
            if (fromId === toId)
                return 0;
            const known = hubDistances.get(toId)?.get(fromId) ?? hubDistances.get(fromId)?.get(toId);
            if (known !== undefined)
                return known;
            const from = settlements.find((item) => item.id === fromId);
            const to = settlements.find((item) => item.id === toId);
            return wrappedDistanceKm(from?.spatial, to?.spatial, context) * 10 + 1e6;
        };
        const assignment = new Map();
        for (const settlement of settlements) {
            const hub = hubs.slice().sort((a, b) => graphCost(settlement.id, a.id) - graphCost(settlement.id, b.id) || a.id.localeCompare(b.id))[0];
            if (hub)
                assignment.set(settlement.id, hub.id);
        }
        const polities = new Map();
        for (const hub of hubs) {
            const members = settlements.filter((settlement) => assignment.get(settlement.id) === hub.id);
            const population = members.reduce((sum, member) => sum + Number(member.components.population ?? 0), 0);
            const capacity = members.reduce((sum, member) => sum + Number(recordComponent(member.components.social).institutionalCapacityIndex ?? 0), 0) / Math.max(1, members.length);
            const logisticsAccess = members.reduce((sum, member) => sum + Number(recordComponent(member.components.economy).routeAccessIndex ?? 0), 0) / Math.max(1, members.length);
            const historyStart = context.recipe.clock.startTick ?? 0;
            const historyEnd = context.snapshot.manifest.currentTick;
            const prng = context.rng.stream('polity-history', hub.id);
            const formationTick = Math.max(historyStart, Math.round(historyStart + (historyEnd - historyStart) * prng.float(0.32, 0.78)));
            const cause = builder.causal('state-transition', false, members.flatMap((member) => member.provenanceIds).slice(0, 32), { transition: 'polity-formation', hubSettlementId: hub.id, memberSettlementIds: members.map((member) => member.id), population }, formationTick);
            const polity = builder.entity('polity', [hub.id, 'route-polity'], {
                centerSettlementId: hub.id, settlementIds: members.map((member) => member.id), population, institutionalCapacityIndex: capacity, logisticsAccessIndex: logisticsAccess,
                derivation: 'route-institution-cluster',
                history: [{ tick: formationTick, kind: 'formation', population, institutionalCapacityIndex: capacity, logisticsAccessIndex: logisticsAccess }],
            }, [cause], hub.spatial);
            polity.bornTick = formationTick;
            polities.set(hub.id, polity);
            builder.event('polity-formed', formationTick, [hub.id], [polity.id], { population, institutionalCapacityIndex: capacity, logisticsAccessIndex: logisticsAccess }, [cause], [context.provenance(passId)], hub.spatial);
            const reorganizationTick = Math.min(historyEnd, Math.max(formationTick + 1, Math.round(formationTick + (historyEnd - formationTick) * prng.float(0.55, 0.9))));
            if (reorganizationTick > formationTick) {
                const materialPressure = clamp(1 - logisticsAccess * 0.45 - capacity * 0.35 + prng.float(-0.08, 0.16));
                const fromCapacity = Number(polity.components.institutionalCapacityIndex ?? capacity);
                const fromLogistics = Number(polity.components.logisticsAccessIndex ?? logisticsAccess);
                const toCapacity = clamp(fromCapacity * (1 - materialPressure * prng.float(0.025, 0.14)) + prng.float(-0.015, 0.025));
                const toLogistics = clamp(fromLogistics * (1 - materialPressure * prng.float(0.02, 0.11)) + prng.float(-0.012, 0.018));
                polity.components.institutionalCapacityIndex = toCapacity;
                polity.components.logisticsAccessIndex = toLogistics;
                const reorganizationCause = builder.causal('state-transition', false, [cause], { transition: 'polity-reorganization', polityId: polity.id, materialPressure, fromCapacity, toCapacity, fromLogistics, toLogistics }, reorganizationTick);
                polity.components.history.push({ tick: reorganizationTick, kind: 'reorganization', materialPressure, fromCapacity, toCapacity, fromLogistics, toLogistics });
                builder.event('polity-reorganized', reorganizationTick, [polity.id], members.map((member) => member.id), { materialPressure, fromCapacity, toCapacity, fromLogistics, toLogistics }, [reorganizationCause], [context.provenance(passId)], polity.spatial);
            }
            for (const member of members)
                builder.relation('member-of-polity', member.id, polity.id, [cause], { routeCostToCenter: graphCost(member.id, hub.id) });
        }
        // Route infrastructure acquires its own historical identity and condition trajectory rather than existing timelessly.
        for (const route of routes) {
            const irng = context.rng.stream('route-infrastructure-history', route.id);
            const historyStart = context.recipe.clock.startTick ?? 0;
            const historyEnd = context.snapshot.manifest.currentTick;
            const builtTick = Math.max(historyStart, Math.round(historyStart + (historyEnd - historyStart) * irng.float(0.18, 0.72)));
            let condition = clamp(0.48 + Number(route.data?.accessibility ?? 0.3) * 0.38 + irng.float(-0.08, 0.12));
            const builtCause = builder.causal('state-transition', false, route.provenanceIds, { transition: 'infrastructure-built', routeId: route.id, conditionIndex: condition }, builtTick);
            const infrastructure = builder.entity('infrastructure-work', [route.id, 'transport-corridor'], {
                routeId: route.id, infrastructureKind: 'transport-corridor', conditionIndex: condition,
                history: [{ tick: builtTick, kind: 'construction', conditionIndex: condition }],
            }, [builtCause], settlements.find((entity) => entity.id === route.sourceId)?.spatial, 'transport-corridor');
            infrastructure.bornTick = builtTick;
            builder.relation('infrastructure-serves', infrastructure.id, route.sourceId, [builtCause], { routeId: route.id, endpointRole: 'source' });
            builder.relation('infrastructure-serves', infrastructure.id, route.targetId, [builtCause], { routeId: route.id, endpointRole: 'target' });
            builder.event('infrastructure-built', builtTick, [route.sourceId, route.targetId], [infrastructure.id], { routeId: route.id, conditionIndex: condition }, [builtCause], [context.provenance(passId)], infrastructure.spatial);
            const history = infrastructure.components.history;
            for (let phase = 1; phase <= 3; phase += 1) {
                const tick = Math.min(historyEnd, Math.round(builtTick + (historyEnd - builtTick) * phase / 3));
                if (tick <= builtTick)
                    continue;
                const maintenance = irng.bool(clamp(Number(route.data?.accessibility ?? 0.3) * 0.55 + 0.2));
                const previous = condition;
                condition = maintenance ? clamp(condition + irng.float(0.025, 0.12)) : clamp(condition - irng.float(0.035, 0.16));
                const kind = maintenance ? 'maintenance' : 'degradation';
                const phaseCause = builder.causal('state-transition', false, [builtCause], { transition: `infrastructure-${kind}`, infrastructureId: infrastructure.id, routeId: route.id, fromCondition: previous, toCondition: condition }, tick);
                history.push({ tick, kind, fromCondition: previous, conditionIndex: condition });
                builder.event(`infrastructure-${kind}`, tick, [infrastructure.id], [route.sourceId, route.targetId], { routeId: route.id, fromCondition: previous, conditionIndex: condition }, [phaseCause], [context.provenance(passId)], infrastructure.spatial);
            }
            infrastructure.components.conditionIndex = condition;
            route.data = route.data ?? {};
            route.data.conditionIndex = condition;
            route.data.capacityIndex = clamp(Number(route.data.capacityIndex ?? 0) * (0.45 + condition * 0.55));
        }
        const interfaces = new Map();
        for (const route of routes) {
            const aHub = assignment.get(route.sourceId);
            const bHub = assignment.get(route.targetId);
            if (!aHub || !bHub || aHub === bHub)
                continue;
            const a = polities.get(aHub);
            const b = polities.get(bHub);
            if (!a || !b)
                continue;
            const key = [a.id, b.id].sort().join('|');
            const existing = interfaces.get(key);
            if (existing) {
                existing.accessibility += Number(route.data?.accessibility ?? 0);
                existing.count += 1;
            }
            else
                interfaces.set(key, { a, b, accessibility: Number(route.data?.accessibility ?? 0), count: 1 });
        }
        for (const item of interfaces.values()) {
            const accessibility = item.accessibility / Math.max(1, item.count);
            const capacityGap = Math.abs(Number(item.a.components.institutionalCapacityIndex ?? 0) - Number(item.b.components.institutionalCapacityIndex ?? 0));
            const cooperationIndex = clamp(accessibility * 0.72 + (1 - capacityGap) * 0.28);
            const conflictPressure = clamp((1 - cooperationIndex) * 0.58 + capacityGap * 0.42);
            const cause = builder.causal('state-transition', false, [...item.a.provenanceIds, ...item.b.provenanceIds], { transition: 'polity-interface', polityA: item.a.id, polityB: item.b.id, accessibility, cooperationIndex, conflictPressure }, context.snapshot.manifest.currentTick);
            builder.relation('polity-interface', item.a.id, item.b.id, [cause], { crossingRouteCount: item.count, accessibility, cooperationIndex, conflictPressure });
        }
        for (const region of regions.values()) {
            const members = settlements.filter((settlement) => settlement.components.regionId === region.id);
            const counts = new Map();
            for (const member of members) {
                const hubId = assignment.get(member.id);
                const polity = hubId ? polities.get(hubId) : undefined;
                if (polity)
                    counts.set(polity.id, (counts.get(polity.id) ?? 0) + Number(member.components.population ?? 0));
            }
            const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
            const shares = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([polityId, population]) => ({ polityId, population, share: total > 0 ? population / total : 0 }));
            region.components.politicalGeography = { derivation: 'population-route-institution', pluralityPolityId: shares[0]?.polityId ?? null, shares };
        }
        context.snapshot.aggregates.society = {
            settlementCount: settlements.length,
            institutionCount: context.snapshot.entities.filter((entity) => entity.kind === 'institution').length,
            exchangeLinkCount: tradeLinkCount,
            logisticsFlowCount,
            totalLogisticsFlow,
            marketInstitutionCount,
            tradeContractCount,
            debtObligationCount,
            stockBeforeTrade,
            stockAfterTrade,
            transportConservationError: stockAfterTrade - stockBeforeTrade,
            polityCount: polities.size,
            polityInterfaceCount: interfaces.size,
            resourceTypes,
            productionRecipeCount: productionRecipes.length,
            institutionHistoryEventCount: context.snapshot.events.filter((event) => event.kind === 'institution-founded' || event.kind === 'institution-evolved' || event.kind === 'institution-split' || event.kind === 'institution-merged').length,
            institutionSplitCount: context.snapshot.events.filter((event) => event.kind === 'institution-split').length,
            institutionMergeCount: context.snapshot.events.filter((event) => event.kind === 'institution-merged').length,
            polityHistoryEventCount: context.snapshot.events.filter((event) => event.kind === 'polity-formed' || event.kind === 'polity-reorganized').length,
            infrastructureWorkCount: context.snapshot.entities.filter((entity) => entity.kind === 'infrastructure-work').length,
            infrastructureHistoryEventCount: context.snapshot.events.filter((event) => event.kind.startsWith('infrastructure-')).length,
        };
    },
};
export const historicalDepthModule = {
    id: 'historical-depth', version: '1.0.0', capabilities: ['historical-significance', 'archaeology', 'artifact-biographies', 'landscape-memory', 'coarse-history-retention'],
    runPass(passId, config, context) {
        if (passId !== 'history:traces')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const traceChance = clamp(numberConfig(config, 'traceChance', 0.72));
        const artifactChance = clamp(numberConfig(config, 'artifactChance', 0.28));
        const retentionThreshold = clamp(numberConfig(config, 'retentionThreshold', 0.55));
        const maxTraces = Math.max(1, Math.round(numberConfig(config, 'maxTraces', 512)));
        const currentTick = context.snapshot.manifest.currentTick;
        const eventWeight = (kind) => {
            if (kind.includes('crisis'))
                return 0.9;
            if (kind.includes('settlement-abandoned') || kind.includes('settlement-merged'))
                return 0.9;
            if (kind.includes('settlement-founded'))
                return 0.78;
            if (kind.includes('migration'))
                return 0.62;
            if (kind.includes('demographic'))
                return 0.42;
            return 0.35;
        };
        const candidates = context.snapshot.events.slice().sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
        const sites = new Map();
        let traceCount = 0;
        let artifactCount = 0;
        let retainedCount = 0;
        let archiveCount = 0;
        const regionMemory = new Map();
        for (const event of candidates) {
            if (traceCount >= maxTraces)
                break;
            const rng = context.rng.stream('historical-depth', event.id);
            const magnitude = Math.min(1, (Number(event.data.deaths ?? 0) + Number(event.data.populationTransfer ?? 0) + Number(event.data.count ?? 0)) / 2500);
            const ageFraction = currentTick > 0 ? clamp((currentTick - event.tick) / Math.max(1, currentTick)) : 0;
            const significance = clamp(eventWeight(event.kind) * 0.72 + magnitude * 0.28);
            if (!rng.bool(clamp(traceChance * (0.45 + significance * 0.75))))
                continue;
            const actor = [...event.actorIds, ...event.targetIds].map((id) => context.snapshot.entities.find((entity) => entity.id === id)).find(Boolean);
            const regionId = event.location?.regionId ?? (typeof actor?.components.regionId === 'string' ? actor.components.regionId : actor?.spatial?.regionId);
            if (!regionId)
                continue;
            const region = context.snapshot.entities.find((entity) => entity.id === regionId && entity.kind === 'region');
            if (!region)
                continue;
            const survivalIndex = clamp(0.92 - ageFraction * rng.float(0.18, 0.72) + significance * 0.18);
            const retainedAtCoarseLOD = significance * survivalIndex >= retentionThreshold;
            const traceType = event.kind.includes('abandoned') ? 'ruin' : event.kind.includes('crisis') ? 'disturbance-stratum' : event.kind.includes('migration') ? 'route-memory' : event.kind.includes('founded') ? 'built-landscape' : 'archival-trace';
            const cause = builder.causal('state-transition', false, event.causeIds, { transition: 'historical-trace-survival', originEventId: event.id, traceType, significance, survivalIndex, retainedAtCoarseLOD }, currentTick);
            let site = sites.get(regionId);
            if (!site) {
                site = builder.entity('archaeological-site', [regionId, 'historical-depth'], { regionId, traceIds: [], significanceIndex: 0, derivation: 'event-history' }, [cause], region.spatial);
                sites.set(regionId, site);
                builder.relation('located-in', site.id, region.id, [cause]);
            }
            const evidenceReliability = clamp(0.28 + survivalIndex * 0.48 + rng.float(-0.08, 0.08));
            const interpretationAmbiguity = clamp(0.12 + ageFraction * 0.28 + (1 - survivalIndex) * 0.42 + rng.float(-0.04, 0.04));
            const trace = builder.entity('historical-trace', [event.id, traceType], {
                originEventId: event.id, originTick: event.tick, regionId, traceType, significance, survivalIndex, retainedAtCoarseLOD,
                evidenceReliability, interpretationAmbiguity,
            }, [cause], event.location ?? actor?.spatial ?? region.spatial, traceType);
            trace.bornTick = event.tick;
            builder.relation('contained-at-site', trace.id, site.id, [cause]);
            if (actor)
                builder.relation('trace-associated-with', trace.id, actor.id, [cause], { originEventId: event.id });
            const siteTraceIds = Array.isArray(site.components.traceIds) ? site.components.traceIds : [];
            siteTraceIds.push(trace.id);
            site.components.traceIds = siteTraceIds;
            site.components.significanceIndex = Math.max(Number(site.components.significanceIndex ?? 0), significance);
            traceCount += 1;
            if (retainedAtCoarseLOD)
                retainedCount += 1;
            const memory = regionMemory.get(regionId) ?? { traceCount: 0, retainedCount: 0, significanceSum: 0 };
            memory.traceCount += 1;
            memory.retainedCount += retainedAtCoarseLOD ? 1 : 0;
            memory.significanceSum += significance;
            regionMemory.set(regionId, memory);
            if (significance >= 0.58 && rng.bool(artifactChance)) {
                const artifactCause = builder.causal('state-transition', false, [cause], { transition: 'artifact-survival', originEventId: event.id, siteId: site.id, significance }, currentTick);
                const artifact = builder.entity('artifact', [event.id, 'surviving-artifact'], {
                    originEventId: event.id,
                    originTick: event.tick,
                    regionId,
                    conditionIndex: survivalIndex,
                    significance,
                    biography: [
                        { tick: event.tick, phase: 'origin', eventId: event.id },
                        { tick: currentTick, phase: 'survives-to-present', siteId: site.id, conditionIndex: survivalIndex },
                    ],
                    retainedAtCoarseLOD,
                }, [artifactCause], trace.spatial, 'historical-object');
                artifact.bornTick = event.tick;
                builder.relation('deposited-at', artifact.id, site.id, [artifactCause]);
                builder.relation('artifact-evidence-for', artifact.id, trace.id, [artifactCause]);
                builder.event('artifact-deposition', event.tick, actor ? [actor.id] : [], [artifact.id, site.id], { originEventId: event.id, significance }, [artifactCause], [context.provenance(passId)], trace.spatial);
                artifactCount += 1;
            }
            if (significance >= 0.72) {
                const archiveCause = builder.causal('state-transition', false, [cause], { transition: 'archival-retention', originEventId: event.id, reliability: survivalIndex }, currentTick);
                const archive = builder.entity('archive-record', [event.id, 'record'], { originEventId: event.id, originTick: event.tick, regionId, reliabilityIndex: clamp(survivalIndex * rng.float(0.65, 1)), retainedAtCoarseLOD: true }, [archiveCause], site.spatial);
                builder.relation('archived-at', archive.id, site.id, [archiveCause]);
                builder.relation('record-supports-trace', archive.id, trace.id, [archiveCause]);
                archiveCount += 1;
            }
        }
        for (const [regionId, memory] of regionMemory) {
            const region = context.snapshot.entities.find((entity) => entity.id === regionId);
            if (!region)
                continue;
            region.components.landscapeMemory = {
                traceCount: memory.traceCount,
                retainedTraceCount: memory.retainedCount,
                meanSignificance: memory.significanceSum / Math.max(1, memory.traceCount),
                archaeologicalSiteId: sites.get(regionId)?.id ?? null,
            };
        }
        context.snapshot.aggregates.historicalDepth = { traceCount, archaeologicalSiteCount: sites.size, artifactCount, archiveCount, retainedAtCoarseLODCount: retainedCount, retentionThreshold };
    },
};
export const worldLawsModule = {
    id: 'world-laws', version: '1.2.0', capabilities: ['hidden-truth', 'recipe-domain-laws', 'causal-rules', 'data-defined-law-dimensions', 'component-target-effects', 'law-interactions'],
    runPass(passId, config, context) {
        if (passId !== 'world-laws:truth')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const targetVariables = context.recipe.variables.filter((variable) => variable.hiddenTruth);
        const ruleKinds = stringArrayConfig(config, 'ruleKinds', ['constraint', 'transition']);
        const explicitRules = Array.isArray(config.rules) ? config.rules.filter((rule) => !!rule && typeof rule === 'object' && !Array.isArray(rule)) : [];
        const covered = new Set();
        for (const rule of explicitRules) {
            const legacyTarget = typeof rule.targetVariable === 'string' ? rule.targetVariable : '';
            const effects = Array.isArray(rule.effects) ? rule.effects.filter((effect) => !!effect && typeof effect === 'object' && !Array.isArray(effect)) : [];
            const targetKeys = new Set();
            if (legacyTarget)
                targetKeys.add(legacyTarget);
            for (const effect of effects)
                if (typeof effect.targetVariable === 'string')
                    targetKeys.add(effect.targetVariable);
            const definitions = [...targetKeys].map((target) => context.recipe.variables.find((variable) => `${variable.namespace}:${variable.id}` === target || variable.id === target)).filter((value) => !!value);
            const ruleId = typeof rule.id === 'string' ? rule.id : stableId('rule', [...targetKeys], rule);
            const ruleKind = typeof rule.kind === 'string' ? rule.kind : 'transition';
            const hiddenTruth = typeof rule.hiddenTruth === 'boolean' ? rule.hiddenTruth : definitions.some((definition) => definition.hiddenTruth);
            const dimensions = {
                source: rule.source ?? { kind: 'intrinsic-law' },
                cost: rule.cost ?? null,
                carrier: rule.carrier ?? { kind: 'state' },
                range: rule.range ?? { scope: definitions[0]?.scope ?? (typeof effects[0]?.entityKind === 'string' ? effects[0].entityKind : 'custom') },
                persistence: rule.persistence ?? { mode: 'continuous' },
                failure: rule.failure ?? { chancePerDay: 0 },
                interactions: rule.interactions ?? [],
                research: rule.research ?? { discoverable: true },
                ritual: rule.ritual ?? { applicable: false },
                technology: rule.technology ?? { applicable: false },
            };
            const normalizedEffects = effects.length ? effects : legacyTarget ? [{ targetVariable: legacyTarget, operation: 'add', perDay: rule.perDay ?? 0, stochastic: rule.stochastic ?? 0 }] : [];
            const cause = builder.causal('law', hiddenTruth, [], { ruleId, ruleKind, dimensions, effects: normalizedEffects }, context.snapshot.manifest.currentTick);
            builder.entity('world-law', ruleId, {
                ruleId,
                ruleKind,
                targetVariables: [...targetKeys],
                targetScopes: definitions.map((definition) => definition.scope),
                dimensions,
                effects: normalizedEffects,
                rawRule: rule,
            }, [cause], undefined, ruleKind);
            for (const definition of definitions)
                covered.add(`${definition.namespace}:${definition.id}`);
        }
        for (const variable of targetVariables) {
            const key = `${variable.namespace}:${variable.id}`;
            if (covered.has(key))
                continue;
            const rng = context.rng.stream('world-laws', variable.namespace, variable.id);
            const ruleKind = rng.pick(ruleKinds);
            const dimensions = {
                source: { kind: 'generated-intrinsic-law' }, cost: null, carrier: { kind: 'state' }, range: { scope: variable.scope },
                persistence: { mode: 'continuous', strength: rng.float() }, failure: { chancePerDay: 0 }, interactions: [],
                research: { discoverable: true }, ritual: { applicable: false }, technology: { applicable: false },
            };
            const cause = builder.causal('law', true, [], { variable: key, ruleKind, dimensions }, context.snapshot.manifest.currentTick);
            builder.entity('world-law', [variable.namespace, variable.id], {
                ruleId: stableId('generated-law', key), targetVariables: [key], targetScopes: [variable.scope], ruleKind, dimensions,
                effects: [], parameters: { strength: rng.float(), persistence: rng.float() },
            }, [cause], undefined, ruleKind);
        }
    },
};
export const knowledgeModule = {
    id: 'knowledge', version: '1.1.0', capabilities: ['truth-knowledge-separation', 'observations', 'fallible-claims', 'competing-causal-hypotheses'],
    runPass(passId, config, context) {
        if (passId !== 'knowledge:interpretations')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const discoveryRate = clamp(numberConfig(config, 'hiddenDiscoveryRate', 0.08));
        const hypothesisFrames = Array.isArray(config.hypothesisFrames) ? config.hypothesisFrames.filter((item) => !!item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string') : [];
        const settlements = context.snapshot.entities.filter((entity) => entity.kind === 'settlement');
        for (const settlement of settlements) {
            const regionId = settlement.components.regionId;
            if (typeof regionId !== 'string')
                continue;
            const region = context.snapshot.entities.find((entity) => entity.id === regionId);
            if (!region)
                continue;
            const variables = region.components.variables;
            if (!variables || typeof variables !== 'object' || Array.isArray(variables))
                continue;
            for (const definition of context.recipe.variables.filter((variable) => variable.scope === 'region')) {
                const key = `${definition.namespace}:${definition.id}`;
                const truth = variables[key];
                if (truth === undefined)
                    continue;
                const rng = context.rng.stream('knowledge', settlement.id, key);
                const observable = definition.observableByDefault ?? !definition.hiddenTruth;
                if (!observable && !rng.bool(discoveryRate))
                    continue;
                const confidence = observable ? rng.float(0.55, 0.95) : rng.float(0.15, 0.55);
                let observed = truth;
                if (typeof truth === 'number')
                    observed = truth + rng.float(-0.08, 0.08) * Math.max(1, Math.abs(truth));
                const observationCause = builder.causal('observation', false, region.provenanceIds, { observerId: settlement.id, subjectId: region.id, variable: key, observed }, context.snapshot.manifest.currentTick);
                const observationRecord = {
                    id: stableId('know', settlement.id, region.id, key, context.snapshot.manifest.currentTick),
                    holderId: settlement.id,
                    subjectIds: [region.id, key],
                    acquiredTick: context.snapshot.manifest.currentTick,
                    confidence,
                    claim: { variable: key, value: observed, interpretation: observable ? 'direct-or-ordinary-observation' : 'uncertain-anomalous-inference' },
                    truthLinkIds: definition.hiddenTruth ? [observationCause] : [],
                };
                context.snapshot.knowledge.push(observationRecord);
                if (definition.hiddenTruth && hypothesisFrames.length) {
                    const applicable = hypothesisFrames.filter((frame) => !Array.isArray(frame.applicableVariables) || frame.applicableVariables.some((value) => typeof value === 'string' && (value === key || value === definition.id)));
                    const pool = applicable.length ? applicable : hypothesisFrames;
                    const weighted = pool.map((frame, index) => ({ frame, weight: Math.max(0.0001, Number(frame.weight ?? 1)), index }));
                    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
                    for (const { frame, weight, index } of weighted) {
                        const frameId = String(frame.id);
                        const hypothesisCause = builder.causal('inference', false, [observationCause], { observerId: settlement.id, observationKnowledgeId: observationRecord.id, causalFrameId: frameId, variable: key }, context.snapshot.manifest.currentTick);
                        const frameConfidence = clamp(confidence * (0.32 + 0.48 * (weight / total)) * (0.92 + rng.float(-0.08, 0.08)));
                        context.snapshot.knowledge.push({
                            id: stableId('know-hypothesis', observationRecord.id, frameId, index), holderId: settlement.id, subjectIds: [region.id, key], acquiredTick: context.snapshot.manifest.currentTick, confidence: frameConfidence, sourceKnowledgeId: observationRecord.id,
                            claim: { variable: key, interpretation: 'competing-causal-hypothesis', causalFrameId: frameId, semantic: typeof frame.semantic === 'string' ? frame.semantic : frameId, evidenceValue: observed },
                            truthLinkIds: [hypothesisCause],
                        });
                    }
                }
            }
        }
    },
};
export const informationEcologyModule = {
    id: 'information-ecology', version: '1.0.0', capabilities: ['information-channels', 'trace-observation', 'delayed-transmission', 'corruption-loss-censorship', 'authority-weighted-claims', 'conflicting-claims'],
    runPass(passId, config, context) {
        if (passId !== 'knowledge:information-ecology')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const settlements = context.snapshot.entities.filter((entity) => entity.kind === 'settlement' && (entity.endedTick === undefined || entity.endedTick > context.snapshot.manifest.currentTick));
        const traces = context.snapshot.entities.filter((entity) => entity.kind === 'historical-trace');
        const routes = context.snapshot.relations.filter((relation) => relation.kind === 'route-link');
        const institutions = context.snapshot.entities.filter((entity) => entity.kind === 'institution');
        const localObservationChance = clamp(numberConfig(config, 'traceObservationChance', 0.65));
        const baseLoss = clamp(numberConfig(config, 'baseLoss', 0.12));
        const baseDistortion = clamp(numberConfig(config, 'baseDistortion', 0.16));
        const baseCensorship = clamp(numberConfig(config, 'baseCensorship', 0.06));
        const maxTransmissions = Math.max(0, Math.round(numberConfig(config, 'maxTransmissions', 256)));
        const contestedArchaeologyChance = clamp(numberConfig(config, 'contestedArchaeologyChance', 0.35));
        const ticksPerDay = context.recipe.clock.ticksPerDay;
        const currentTick = context.snapshot.manifest.currentTick;
        const channels = [];
        let observationCount = 0;
        let transmissionCount = 0;
        let corruptedCount = 0;
        let disputeCount = 0;
        let contestedArchaeologyHypothesisCount = 0;
        const institutionalAuthority = (settlementId) => {
            const based = context.snapshot.relations.filter((relation) => relation.kind === 'based-in' && relation.targetId === settlementId).map((relation) => institutions.find((institution) => institution.id === relation.sourceId)).filter((value) => !!value);
            if (!based.length)
                return 0.2;
            return clamp(based.reduce((sum, institution) => sum + Number(institution.components.legitimacyIndex ?? 0.4) * Number(institution.components.capacityIndex ?? 0.4), 0) / based.length);
        };
        for (const route of routes) {
            const source = settlements.find((item) => item.id === route.sourceId);
            const target = settlements.find((item) => item.id === route.targetId);
            if (!source || !target)
                continue;
            const accessibility = clamp(Number(route.data?.accessibility ?? 0));
            const rng = context.rng.stream('information-channel', route.id);
            const lossRate = clamp(baseLoss + (1 - accessibility) * 0.42 + rng.float(-0.03, 0.03));
            const distortionRate = clamp(baseDistortion + (1 - accessibility) * 0.3 + rng.float(-0.03, 0.03));
            const censorshipRate = clamp(baseCensorship + Math.abs(institutionalAuthority(source.id) - institutionalAuthority(target.id)) * 0.12 + rng.float(-0.02, 0.02));
            const delayTicks = Math.max(1, Math.round((Number(route.data?.distanceKm ?? 1) / Math.max(0.05, accessibility) / 80) * ticksPerDay));
            const cause = builder.causal('transmission', false, route.provenanceIds, { transition: 'information-channel', routeId: route.id, lossRate, distortionRate, censorshipRate, delayTicks }, currentTick);
            const channel = builder.relation('information-channel', source.id, target.id, [cause], {
                routeId: route.id, delayTicks, lossRate, distortionRate, censorshipRate,
                reliabilityIndex: clamp(accessibility * (1 - lossRate) * (1 - distortionRate * 0.5)),
                sourceAuthorityIndex: institutionalAuthority(source.id), targetAuthorityIndex: institutionalAuthority(target.id),
            });
            channels.push(channel);
        }
        const traceKnowledge = [];
        for (const trace of traces) {
            const regionId = typeof trace.components.regionId === 'string' ? trace.components.regionId : trace.spatial?.regionId;
            const local = settlements.filter((settlement) => settlement.components.regionId === regionId).sort((a, b) => Number(b.components.population ?? 0) - Number(a.components.population ?? 0) || a.id.localeCompare(b.id));
            if (!local.length)
                continue;
            const rng = context.rng.stream('trace-observation', trace.id);
            if (!rng.bool(localObservationChance))
                continue;
            const holder = local[0];
            const originEventId = String(trace.components.originEventId ?? '');
            const originEvent = context.snapshot.events.find((event) => event.id === originEventId);
            const evidenceReliability = clamp(Number(trace.components.evidenceReliability ?? 0.45));
            const originTick = Math.max(0, Math.round(Number(trace.components.originTick ?? currentTick)));
            const observationTick = Math.min(currentTick, Math.max(originTick, Math.round(originTick + (currentTick - originTick) * rng.float(0.15, 0.75))));
            const observationCause = builder.causal('observation', false, trace.provenanceIds, { observerId: holder.id, historicalTraceId: trace.id, traceType: String(trace.components.traceType ?? ''), evidenceReliability }, observationTick);
            const record = {
                id: stableId('know-trace', holder.id, trace.id, currentTick),
                holderId: holder.id,
                subjectIds: [trace.id, ...(originEventId ? [originEventId] : [])],
                acquiredTick: observationTick,
                confidence: clamp(evidenceReliability * rng.float(0.65, 1)),
                sourceEntityId: trace.id,
                claim: {
                    interpretation: 'material-trace-observation',
                    historicalTraceId: trace.id,
                    traceType: String(trace.components.traceType ?? 'unspecified-trace'),
                    assertedOriginClass: originEvent?.kind ?? 'unknown-origin',
                    observedAgeTicks: Math.max(0, observationTick - originTick),
                    evidenceReliability,
                },
                truthLinkIds: [observationCause],
            };
            if (!context.snapshot.knowledge.some((item) => item.id === record.id))
                context.snapshot.knowledge.push(record);
            traceKnowledge.push(record);
            observationCount += 1;
            // Material evidence can rationally support more than one historical reconstruction. Competing hypotheses
            // remain observer knowledge and never replace the canonical origin event retained in world history.
            const ambiguity = clamp(Number(trace.components.interpretationAmbiguity ?? 0));
            if (ambiguity > 0 && (contestedArchaeologyChance >= 1 || rng.bool(contestedArchaeologyChance * ambiguity))) {
                const hypothesisClasses = ['mobility-event', 'construction-event', 'conflict-event', 'demographic-event', 'environmental-event', 'unknown-origin'];
                const actualClass = originEvent?.kind ?? 'unknown-origin';
                const alternatives = hypothesisClasses.filter((candidate) => candidate !== actualClass);
                const assertedOriginClass = rng.pick(alternatives);
                const inferenceCause = builder.causal('inference', false, [observationCause], {
                    transition: 'contested-archaeological-hypothesis', observerId: holder.id, historicalTraceId: trace.id,
                    sourceKnowledgeId: record.id, assertedOriginClass, ambiguity,
                }, observationTick);
                const hypothesis = {
                    id: stableId('know-trace-hypothesis', holder.id, trace.id, assertedOriginClass, currentTick),
                    holderId: holder.id,
                    subjectIds: [...record.subjectIds],
                    acquiredTick: observationTick,
                    confidence: clamp(record.confidence * (0.35 + ambiguity * 0.38)),
                    sourceKnowledgeId: record.id,
                    sourceEntityId: trace.id,
                    claim: {
                        interpretation: 'contested-archaeological-hypothesis', historicalTraceId: trace.id, traceType: String(trace.components.traceType ?? 'unspecified-trace'),
                        assertedOriginClass, evidenceReliability, interpretationAmbiguity: ambiguity,
                    },
                    truthLinkIds: [inferenceCause],
                };
                if (!context.snapshot.knowledge.some((item) => item.id === hypothesis.id))
                    context.snapshot.knowledge.push(hypothesis);
                traceKnowledge.push(hypothesis);
                contestedArchaeologyHypothesisCount += 1;
                disputeCount += 1;
            }
        }
        // Additional evidence classes remain claims held by observers; event records themselves stay canonical history.
        const sourceClasses = new Set(stringArrayConfig(config, 'sourceClasses', ['testimony', 'institutional-record', 'signal']));
        const maxAuxiliarySources = Math.max(0, Math.round(numberConfig(config, 'maxAuxiliarySources', 96)));
        let testimonyCount = 0;
        let institutionalRecordCount = 0;
        let signalCount = 0;
        const candidateEvents = context.snapshot.events.slice().sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
        for (const event of candidateEvents) {
            if (testimonyCount + institutionalRecordCount + signalCount >= maxAuxiliarySources)
                break;
            const localSettlement = settlements.find((settlement) => event.location?.regionId && settlement.components.regionId === event.location.regionId) ?? settlements.find((settlement) => event.actorIds.includes(settlement.id) || event.targetIds.includes(settlement.id));
            if (!localSettlement)
                continue;
            const rng = context.rng.stream('auxiliary-evidence', event.id, localSettlement.id);
            if (sourceClasses.has('testimony') && event.actorIds.length && rng.bool(0.34) && testimonyCount + institutionalRecordCount + signalCount < maxAuxiliarySources) {
                const sourceEntityId = event.actorIds.find((id) => context.snapshot.entities.some((entity) => entity.id === id));
                const cause = builder.causal('observation', false, event.causeIds, { observerId: localSettlement.id, eventId: event.id, evidenceClass: 'testimony', sourceEntityId: sourceEntityId ?? null }, Math.min(currentTick, event.tick + Math.max(1, Math.round(rng.float(1, ticksPerDay * 3)))));
                const record = { id: stableId('know-testimony', localSettlement.id, event.id), holderId: localSettlement.id, subjectIds: [event.id, ...event.targetIds], acquiredTick: Math.min(currentTick, event.tick + 1), confidence: rng.float(0.35, 0.82), claim: { interpretation: 'testimony', assertedEventClass: event.kind, eventId: event.id, memoryCompression: rng.float(0, 0.35) }, truthLinkIds: [cause] };
                if (sourceEntityId)
                    record.sourceEntityId = sourceEntityId;
                context.snapshot.knowledge.push(record);
                traceKnowledge.push(record);
                testimonyCount += 1;
            }
            if (sourceClasses.has('institutional-record') && testimonyCount + institutionalRecordCount + signalCount < maxAuxiliarySources) {
                const based = context.snapshot.relations.filter((relation) => relation.kind === 'based-in' && relation.targetId === localSettlement.id).map((relation) => institutions.find((institution) => institution.id === relation.sourceId)).find(Boolean);
                if (based && rng.bool(0.28)) {
                    const cause = builder.causal('observation', false, event.causeIds, { observerId: localSettlement.id, eventId: event.id, evidenceClass: 'institutional-record', institutionId: based.id }, Math.min(currentTick, event.tick + ticksPerDay));
                    const record = { id: stableId('know-institution-record', based.id, event.id), holderId: localSettlement.id, subjectIds: [event.id, ...event.targetIds], acquiredTick: Math.min(currentTick, event.tick + ticksPerDay), confidence: clamp(Number(based.components.capacityIndex ?? 0.5) * 0.4 + Number(based.components.legitimacyIndex ?? 0.5) * 0.25 + rng.float(0.15, 0.3)), sourceEntityId: based.id, claim: { interpretation: 'institutional-record', assertedEventClass: event.kind, eventId: event.id, institutionId: based.id, recordCompleteness: rng.float(0.5, 0.98) }, truthLinkIds: [cause] };
                    context.snapshot.knowledge.push(record);
                    traceKnowledge.push(record);
                    institutionalRecordCount += 1;
                }
            }
            if (sourceClasses.has('signal') && event.location && testimonyCount + institutionalRecordCount + signalCount < maxAuxiliarySources && rng.bool(0.3)) {
                const cause = builder.causal('observation', false, event.causeIds, { observerId: localSettlement.id, eventId: event.id, evidenceClass: 'signal', location: event.location }, Math.min(currentTick, event.tick + 1));
                const record = { id: stableId('know-signal', localSettlement.id, event.id), holderId: localSettlement.id, subjectIds: [event.id], acquiredTick: Math.min(currentTick, event.tick + 1), confidence: rng.float(0.3, 0.75), claim: { interpretation: 'signal-observation', eventId: event.id, assertedEventClass: rng.bool(0.82) ? event.kind : 'ambiguous-signal', signalStrength: rng.float(0.2, 1), spatialUncertaintyKm: rng.float(0.5, 30) }, truthLinkIds: [cause] };
                context.snapshot.knowledge.push(record);
                traceKnowledge.push(record);
                signalCount += 1;
            }
        }
        const adjacency = new Map();
        for (const channel of channels) {
            if (!adjacency.has(channel.sourceId))
                adjacency.set(channel.sourceId, []);
            if (!adjacency.has(channel.targetId))
                adjacency.set(channel.targetId, []);
            adjacency.get(channel.sourceId).push({ channel, targetId: channel.targetId });
            adjacency.get(channel.targetId).push({ channel, targetId: channel.sourceId });
        }
        const originClasses = ['demographic-crisis', 'macro-migration', 'settlement-founded', 'settlement-abandoned', 'unknown-disturbance', 'ritualized-memory'];
        for (const sourceRecord of traceKnowledge) {
            if (transmissionCount >= maxTransmissions)
                break;
            const edges = (adjacency.get(sourceRecord.holderId) ?? []).slice().sort((a, b) => a.targetId.localeCompare(b.targetId));
            for (const { channel, targetId } of edges) {
                if (transmissionCount >= maxTransmissions)
                    break;
                const rng = context.rng.stream('information-transmission', sourceRecord.id, channel.id, targetId);
                const lossRate = clamp(Number(channel.data?.lossRate ?? baseLoss));
                const censorshipRate = clamp(Number(channel.data?.censorshipRate ?? baseCensorship));
                if (rng.bool(clamp(lossRate + censorshipRate * 0.45)))
                    continue;
                const distortionRate = clamp(Number(channel.data?.distortionRate ?? baseDistortion));
                const corrupted = rng.bool(distortionRate);
                const assertedOriginClass = corrupted ? rng.pick(originClasses.filter((kind) => kind !== sourceRecord.claim.assertedOriginClass)) : (sourceRecord.claim.assertedOriginClass ?? 'unknown-origin');
                const reliability = clamp(Number(channel.data?.reliabilityIndex ?? 0.4));
                const targetAuthority = clamp(Number(channel.data?.targetAuthorityIndex ?? 0.2));
                const transmissionTick = Math.min(currentTick, sourceRecord.acquiredTick + Math.max(1, Math.round(Number(channel.data?.delayTicks ?? 1))));
                const transmissionCause = builder.causal('transmission', false, sourceRecord.truthLinkIds ?? [], {
                    sourceKnowledgeId: sourceRecord.id, sourceHolderId: sourceRecord.holderId, targetHolderId: targetId,
                    channelId: channel.id, corrupted, assertedOriginClass,
                }, transmissionTick);
                const targetRecord = {
                    id: stableId('know-transmitted', sourceRecord.id, targetId, channel.id, transmissionTick),
                    holderId: targetId,
                    subjectIds: [...sourceRecord.subjectIds],
                    acquiredTick: transmissionTick,
                    confidence: clamp(sourceRecord.confidence * reliability * (0.78 + targetAuthority * 0.22)),
                    sourceKnowledgeId: sourceRecord.id,
                    sourceEntityId: sourceRecord.holderId,
                    claim: {
                        ...sourceRecord.claim,
                        interpretation: corrupted ? 'contested-transmitted-trace' : 'transmitted-trace-report',
                        assertedOriginClass: assertedOriginClass,
                        transmissionChannelId: channel.id,
                        corrupted,
                    },
                };
                if (!context.snapshot.knowledge.some((item) => item.id === targetRecord.id))
                    context.snapshot.knowledge.push(targetRecord);
                builder.event('information-transmission', transmissionTick, [sourceRecord.holderId], [targetId], {
                    sourceKnowledgeId: sourceRecord.id, targetKnowledgeId: targetRecord.id, channelId: channel.id,
                    delayTicks: Number(channel.data?.delayTicks ?? 0), corrupted,
                }, [transmissionCause], [transmissionCause], settlements.find((item) => item.id === targetId)?.spatial);
                transmissionCount += 1;
                if (corrupted)
                    corruptedCount += 1;
                const competing = context.snapshot.knowledge.find((record) => record.holderId === targetId && record.id !== targetRecord.id && record.subjectIds.some((subject) => targetRecord.subjectIds.includes(subject)) && typeof record.claim.assertedOriginClass === 'string' && record.claim.assertedOriginClass !== targetRecord.claim.assertedOriginClass);
                if (competing) {
                    builder.relation('knowledge-dispute', sourceRecord.holderId, targetId, [transmissionCause], {
                        subjectIds: targetRecord.subjectIds,
                        firstKnowledgeId: competing.id,
                        secondKnowledgeId: targetRecord.id,
                        confidenceGap: Math.abs(competing.confidence - targetRecord.confidence),
                    });
                    disputeCount += 1;
                }
            }
        }
        // Cartographic knowledge is observer-relative: the map stores an uncertain estimate, never canonical geometry.
        const mapUncertaintyBase = clamp(numberConfig(config, 'mapUncertaintyBase', 0.12));
        let cartographicRecordCount = 0;
        let cartographicKnowledgeCount = 0;
        let mapUncertaintySum = 0;
        const routeBySettlement = new Map();
        for (const route of routes) {
            if (!routeBySettlement.has(route.sourceId))
                routeBySettlement.set(route.sourceId, []);
            if (!routeBySettlement.has(route.targetId))
                routeBySettlement.set(route.targetId, []);
            routeBySettlement.get(route.sourceId).push(route);
            routeBySettlement.get(route.targetId).push(route);
        }
        for (const settlement of settlements) {
            const regionId = typeof settlement.components.regionId === 'string' ? settlement.components.regionId : settlement.spatial?.regionId;
            const region = regionId ? context.snapshot.entities.find((entity) => entity.id === regionId && entity.kind === 'region') : undefined;
            if (!region?.spatial)
                continue;
            const rng = context.rng.stream('cartographic-knowledge', settlement.id);
            const localRoutes = routeBySettlement.get(settlement.id) ?? [];
            const informationQuality = localRoutes.length ? clamp(localRoutes.reduce((sum, route) => sum + Number(route.data?.accessibility ?? 0), 0) / localRoutes.length) : 0.25;
            const uncertainty = clamp(mapUncertaintyBase + (1 - informationQuality) * 0.32 + rng.float(-0.025, 0.025), 0.02, 0.72);
            const scale = Math.max(1, Math.min(context.recipe.geometry.extent.widthKm, context.recipe.geometry.extent.heightKm));
            const jitterKm = uncertainty * scale * 0.035;
            const estimatedX = region.spatial.x + rng.float(-jitterKm, jitterKm);
            const estimatedY = region.spatial.y + rng.float(-jitterKm, jitterKm);
            const cause = builder.causal('observation', false, region.provenanceIds, { observerId: settlement.id, subjectId: region.id, observationClass: 'cartographic-estimate', uncertainty }, currentTick);
            const map = builder.entity('cartographic-record', [settlement.id, region.id, currentTick], {
                holderId: settlement.id, subjectRegionId: region.id, estimatedCenter: { x: estimatedX, y: estimatedY },
                uncertaintyRadiusKm: jitterKm, boundaryConfidence: clamp(1 - uncertainty), routeIds: localRoutes.map((route) => route.id).sort(),
                productionTick: currentTick,
            }, [cause], settlement.spatial, 'observer-map');
            const knowledgeRecord = {
                id: stableId('know-map', settlement.id, region.id, currentTick), holderId: settlement.id, subjectIds: [region.id, map.id], acquiredTick: currentTick,
                confidence: clamp(1 - uncertainty), sourceEntityId: map.id,
                claim: { interpretation: 'cartographic-estimate', regionId: region.id, estimatedCenter: { x: estimatedX, y: estimatedY }, uncertaintyRadiusKm: jitterKm, boundaryConfidence: clamp(1 - uncertainty) },
                truthLinkIds: [cause],
            };
            if (!context.snapshot.knowledge.some((record) => record.id === knowledgeRecord.id)) {
                context.snapshot.knowledge.push(knowledgeRecord);
                cartographicKnowledgeCount += 1;
            }
            cartographicRecordCount += 1;
            mapUncertaintySum += uncertainty;
        }
        // Once knowledge exists, polity interfaces can incorporate epistemic alignment without replacing material pressures.
        const polityMembership = new Map();
        for (const relation of context.snapshot.relations.filter((relation) => relation.kind === 'member-of-polity'))
            polityMembership.set(relation.sourceId, relation.targetId);
        const knowledgeByPolity = new Map();
        for (const record of context.snapshot.knowledge) {
            const polityId = polityMembership.get(record.holderId);
            if (!polityId)
                continue;
            if (!knowledgeByPolity.has(polityId))
                knowledgeByPolity.set(polityId, []);
            knowledgeByPolity.get(polityId).push(record);
        }
        const signature = (record) => {
            const subject = record.subjectIds[0] ?? 'unknown';
            const asserted = typeof record.claim.assertedOriginClass === 'string' ? record.claim.assertedOriginClass : typeof record.claim.variable === 'string' ? record.claim.variable : typeof record.claim.interpretation === 'string' ? record.claim.interpretation : 'claim';
            return `${subject}|${asserted}`;
        };
        let beliefAwareInterfaceCount = 0;
        for (const relation of context.snapshot.relations.filter((item) => item.kind === 'polity-interface')) {
            const aRecords = knowledgeByPolity.get(relation.sourceId) ?? [];
            const bRecords = knowledgeByPolity.get(relation.targetId) ?? [];
            const a = new Set(aRecords.map(signature));
            const b = new Set(bRecords.map(signature));
            const union = new Set([...a, ...b]);
            let intersection = 0;
            for (const token of a)
                if (b.has(token))
                    intersection += 1;
            const alignment = union.size ? intersection / union.size : 0.5;
            const sharedSubjects = new Set(aRecords.flatMap((record) => record.subjectIds).filter((id) => bRecords.some((record) => record.subjectIds.includes(id))));
            let disagreements = 0;
            for (const subjectId of sharedSubjects) {
                const left = new Set(aRecords.filter((record) => record.subjectIds.includes(subjectId)).map(signature));
                const right = new Set(bRecords.filter((record) => record.subjectIds.includes(subjectId)).map(signature));
                if (![...left].some((token) => right.has(token)))
                    disagreements += 1;
            }
            const disputePressure = sharedSubjects.size ? disagreements / sharedSubjects.size : 0;
            const materialCooperation = clamp(Number(relation.data?.cooperationIndex ?? 0.5));
            const materialConflict = clamp(Number(relation.data?.conflictPressure ?? 0.5));
            const cooperationIndex = clamp(materialCooperation * 0.72 + alignment * 0.28);
            const conflictPressure = clamp(materialConflict * 0.72 + disputePressure * 0.28);
            relation.data = { ...(relation.data ?? {}), epistemicAlignmentIndex: alignment, knowledgeDisputePressure: disputePressure, materialCooperationIndex: materialCooperation, materialConflictPressure: materialConflict, cooperationIndex, conflictPressure };
            const cause = builder.causal('inference', false, relation.provenanceIds, { transition: 'belief-aware-polity-interface', polityA: relation.sourceId, polityB: relation.targetId, alignment, disputePressure }, currentTick);
            relation.provenanceIds.push(cause);
            beliefAwareInterfaceCount += 1;
        }
        context.snapshot.aggregates.informationEcology = {
            channelCount: channels.length,
            traceObservationCount: observationCount,
            transmissionCount,
            corruptedTransmissionCount: corruptedCount,
            disputeCount,
            testimonyCount, institutionalRecordCount, signalCount,
            cartographicRecordCount,
            cartographicKnowledgeCount,
            meanMapUncertainty: cartographicRecordCount ? mapUncertaintySum / cartographicRecordCount : 0,
            beliefAwareInterfaceCount,
            contestedArchaeologyHypothesisCount,
            maxTransmissions,
        };
    },
};
export const motifModule = {
    id: 'motif-ontology', version: '1.1.0', capabilities: ['motif-ontology', 'source-grounded-lore', 'folklore-transmission', 'interpretation-layer', 'lore-lineage'],
    runPass(passId, config, context) {
        if (passId !== 'motif:transmission')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const corpus = buildLoreCorpus(context.content);
        if (corpus.errors.length)
            throw new Error(`Lore corpus validation failed:\n${corpus.errors.join('\n')}`);
        const authoredSeeds = stringArrayConfig(config, 'ontologySeeds', []);
        const legacyContentSeeds = context.content.list().flatMap((pack) => {
            const value = pack.data.motifOntologySeeds;
            return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
        });
        const maxDerived = Math.max(0, Math.round(numberConfig(config, 'maxDerivedMotifs', 24)));
        const maxVariants = Math.max(0, Math.round(numberConfig(config, 'maxLoreVariants', 96)));
        const maxTransforms = Math.max(0, Math.round(numberConfig(config, 'maxTransformationsPerVariant', 3)));
        const transmissionChance = clamp(numberConfig(config, 'transmissionChance', 0.25));
        const derivedKeys = [...new Set(context.snapshot.knowledge.map((record) => {
                const variable = record.claim.variable;
                return typeof variable === 'string' ? variable : null;
            }).filter((value) => value !== null))].slice(0, maxDerived);
        const definitions = new Map();
        for (const motif of corpus.motifs)
            definitions.set(motif.id, motif);
        for (const key of [...new Set([...authoredSeeds, ...legacyContentSeeds, ...derivedKeys])]) {
            if (definitions.has(key))
                continue;
            definitions.set(key, {
                id: key,
                label: key,
                description: 'Setting/content supplied ontology seed without a specialist corpus definition.',
                family: 'setting-extension',
                triggerTags: key.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean),
                sourceIds: [],
                dimensions: {},
            });
        }
        for (const motif of [...definitions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
            const rng = context.rng.stream('motif-definition', motif.id);
            const dimensions = { ...motif.dimensions };
            if (!Object.keys(dimensions).length) {
                dimensions.agency = rng.float();
                dimensions.liminality = rng.float();
                dimensions.embodiment = rng.float();
                dimensions.recurrence = rng.float();
            }
            const cause = builder.causal('inference', false, [], {
                sourceSemanticKey: motif.id,
                transformation: 'motif-abstraction',
                sourceIds: motif.sourceIds,
            }, context.snapshot.manifest.currentTick);
            builder.entity('motif', motif.id, {
                semanticKey: motif.id,
                label: motif.label,
                description: motif.description,
                family: motif.family,
                triggerTags: motif.triggerTags,
                sourceIds: motif.sourceIds,
                dimensions,
                cautions: motif.cautions ?? [],
                curationStatus: motif.curationStatus ?? 'active',
                structuralReviewStatus: motif.structuralReviewStatus ?? 'unreviewed',
                ...(motif.motifeme ? { motifeme: motif.motifeme } : {}),
                allomotifs: motif.allomotifs ?? [],
                structuralRoles: motif.structuralRoles ?? [],
                ontologyFacets: motif.ontologyFacets ?? [],
            }, [cause]);
        }
        const motifEntities = new Map(context.snapshot.entities.filter((entity) => entity.kind === 'motif').map((entity) => [String(entity.components.semanticKey ?? entity.id), entity]));
        const maxMotifRelations = Math.max(0, Math.round(numberConfig(config, 'maxMotifRelations', 320)));
        const relationKeys = new Set();
        let motifRelationCount = 0;
        let authoredMotifRelationCount = 0;
        const addMotifRelation = (sourceId, targetId, relationType, weight, sourceIds, basis) => {
            if (motifRelationCount >= maxMotifRelations || sourceId === targetId)
                return;
            const source = motifEntities.get(sourceId);
            const target = motifEntities.get(targetId);
            if (!source || !target)
                return;
            const directional = relationType === 'prerequisite';
            const pair = directional ? `${sourceId}|${targetId}` : [sourceId, targetId].sort().join('|');
            const key = `${relationType}|${pair}`;
            if (relationKeys.has(key))
                return;
            relationKeys.add(key);
            const cause = builder.causal('inference', false, [], { transformation: 'motif-relation-abstraction', sourceMotifId: sourceId, targetMotifId: targetId, relationType, weight, sourceIds, basis }, context.snapshot.manifest.currentTick);
            builder.relation(`motif-${relationType}`, source.id, target.id, [cause], { relationType, weight, sourceIds, basis });
            motifRelationCount += 1;
        };
        for (const relation of corpus.motifRelations) {
            addMotifRelation(relation.sourceMotifId, relation.targetMotifId, relation.relationType, relation.weight, relation.sourceIds, 'curated-corpus-relation');
            authoredMotifRelationCount += 1;
        }
        const corpusMotifs = corpus.motifs.slice().sort((a, b) => a.id.localeCompare(b.id));
        for (let i = 0; i < corpusMotifs.length && motifRelationCount < maxMotifRelations; i += 1) {
            for (let j = i + 1; j < corpusMotifs.length && motifRelationCount < maxMotifRelations; j += 1) {
                const a = corpusMotifs[i];
                const b = corpusMotifs[j];
                const sharedSources = a.sourceIds.filter((sourceId) => b.sourceIds.includes(sourceId));
                const sharedTags = a.triggerTags.filter((tag) => b.triggerTags.includes(tag));
                const sourceScore = sharedSources.length / Math.max(1, Math.min(a.sourceIds.length, b.sourceIds.length));
                const tagScore = sharedTags.length / Math.max(1, Math.min(a.triggerTags.length, b.triggerTags.length));
                if (sourceScore >= 0.5 && tagScore >= 0.2)
                    addMotifRelation(a.id, b.id, 'co-occurrence', clamp(sourceScore * 0.65 + tagScore * 0.35), sharedSources, 'shared-source-and-semantic-tags');
                const sharedTransformations = corpus.transformations.filter((rule) => rule.appliesTo.some((tag) => a.triggerTags.includes(tag)) && rule.appliesTo.some((tag) => b.triggerTags.includes(tag)));
                if (sharedTransformations.length >= 2) {
                    const sourceIds = [...new Set(sharedTransformations.flatMap((rule) => rule.sourceIds))];
                    addMotifRelation(a.id, b.id, 'transformation-affinity', clamp(sharedTransformations.length / Math.max(2, corpus.transformations.length / 4)), sourceIds, 'shared-transformation-operators');
                }
            }
        }
        const settlements = context.snapshot.entities.filter((entity) => entity.kind === 'settlement');
        const sourceKnowledge = context.snapshot.knowledge.slice(0, maxVariants);
        let transmittedCount = 0;
        let variantCount = 0;
        const chooseTransformations = (tags, motif, rng) => {
            if (!corpus.transformations.length || maxTransforms === 0)
                return [];
            const tagSet = new Set([...tags, ...motif.triggerTags, ...(motif.structuralRoles ?? []), ...(motif.ontologyFacets ?? [])]);
            const preconditionsMet = (rule) => (rule.preconditions ?? []).every((condition) => {
                if (condition.startsWith('tag:'))
                    return tagSet.has(condition.slice(4));
                if (condition.startsWith('not-tag:'))
                    return !tagSet.has(condition.slice(8));
                return true; // free-text theoretical preconditions are curator metadata, not executable predicates.
            });
            const compatible = corpus.transformations.filter((rule) => preconditionsMet(rule) && rule.appliesTo.some((tag) => tagSet.has(tag)));
            const pool = (compatible.length ? compatible : corpus.transformations.filter(preconditionsMet)).slice().sort((a, b) => a.id.localeCompare(b.id));
            const count = Math.min(pool.length, Math.max(1, rng.int(1, Math.max(1, maxTransforms))));
            const picked = [];
            const remaining = [...pool];
            while (picked.length < count && remaining.length) {
                const total = remaining.reduce((sum, item) => {
                    const contextFactor = Object.entries(item.contextWeights ?? {}).reduce((factor, [tag, weight]) => factor * (tagSet.has(tag) ? Math.max(0.05, weight) : 1), 1);
                    return sum + Math.max(0.0001, item.weight * contextFactor * (item.confidence ?? 1));
                }, 0);
                let cursor = rng.float(0, total);
                let index = remaining.length - 1;
                for (let i = 0; i < remaining.length; i += 1) {
                    const item = remaining[i];
                    const contextFactor = Object.entries(item.contextWeights ?? {}).reduce((factor, [tag, weight]) => factor * (tagSet.has(tag) ? Math.max(0.05, weight) : 1), 1);
                    cursor -= Math.max(0.0001, item.weight * contextFactor * (item.confidence ?? 1));
                    if (cursor <= 0) {
                        index = i;
                        break;
                    }
                }
                picked.push(remaining.splice(index, 1)[0]);
            }
            return picked;
        };
        const applyTransformationOperators = (baseTags, motif, rules, rng) => {
            const out = new Set(baseTags);
            const operations = [];
            for (const rule of rules)
                for (const operation of rule.operations ?? []) {
                    operations.push(operation);
                    const [verb, payload = ''] = operation.split(':', 2);
                    if (verb === 'drop' && out.size > 2) {
                        const removable = [...out].filter((tag) => !motif.triggerTags.includes(tag) && tag !== motif.family).sort();
                        if (removable.length)
                            out.delete(rng.pick(removable));
                    }
                    else if (verb === 'add') {
                        if (payload)
                            out.add(payload.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
                    }
                    else if (verb === 'map')
                        out.add('schema-assimilated');
                    else if (verb === 'emphasize')
                        out.add('salience-sharpened');
                    else if (verb === 'substitute') {
                        out.add('allomotif-substitution');
                        if (motif.allomotifs?.length)
                            out.add(`allomotif-${rng.pick(motif.allomotifs).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
                    }
                    else if (verb === 'bind')
                        out.add('localized');
                    else if (verb === 'shift')
                        out.add('media-remediated');
                    else if (verb === 'recompose')
                        out.add('formulaic-recomposition');
                    else if (verb === 'prefer')
                        out.add('biased-selection');
                    else if (verb === 'mutate')
                        out.add('innovation');
                    else if (verb === 'sample')
                        out.add('cultural-drift');
                    else if (verb === 'split')
                        out.add('lineage-branching');
                    else if (verb === 'merge')
                        out.add('lineage-blending');
                    else if (verb === 'require')
                        out.add('reinforcement-required');
                    else if (verb === 'separate')
                        out.add('source-critical');
                    // invariants are recorded and audited; operators are not allowed to rewrite truth/provenance links.
                }
            return { tags: [...out].sort(), operations };
        };
        const defaultMode = { id: 'unspecified-oral', label: 'Unspecified oral transmission', distortion: 0.3, retention: 0.65, authority: 0.35, direction: 'mixed', memoryHalfLifeDays: 365, innovationRate: 0.05, complexContagionThreshold: 1 };
        const chooseTransmissionMode = (record, tags, rng) => {
            const modes = corpus.transmissionModes.length ? corpus.transmissionModes : [defaultMode];
            const weighted = modes.map((mode) => {
                const bias = mode.copyingBiases ?? {};
                const salience = Math.min(1, tags.length / 8);
                const score = 1
                    + Number(bias.authority ?? 0) * record.confidence
                    + Number(bias.prestige ?? 0) * mode.authority
                    + Number(bias.content ?? 0) * salience
                    + Number(bias.novelty ?? 0) * (1 - record.confidence)
                    + Number(bias.conformity ?? 0) * 0.35;
                return { mode, weight: Math.max(0.01, score) };
            });
            let cursor = rng.float(0, weighted.reduce((sum, item) => sum + item.weight, 0));
            for (const item of weighted) {
                cursor -= item.weight;
                if (cursor <= 0)
                    return item.mode;
            }
            return weighted[weighted.length - 1].mode;
        };
        const applyTransmissionNoise = (tags, motif, mode, rng) => {
            const out = new Set(tags);
            const noiseOperators = [];
            for (const [operator, rate] of Object.entries(mode.noiseProfile ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) {
                if (!rng.bool(clamp(rate)))
                    continue;
                noiseOperators.push(operator);
                if ((operator === 'omission' || operator === 'leveling') && out.size > 2) {
                    const removable = [...out].filter((tag) => !motif.triggerTags.includes(tag)).sort();
                    if (removable.length)
                        out.delete(rng.pick(removable));
                }
                else if (operator === 'sharpening')
                    out.add('salience-sharpened');
                else if (operator === 'assimilation')
                    out.add('schema-assimilated');
                else if (operator === 'substitution') {
                    out.add('allomotif-substitution');
                    if (motif.allomotifs?.length)
                        out.add(`allomotif-${rng.pick(motif.allomotifs).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
                }
                else if (operator === 'localization')
                    out.add('localized');
                else if (operator === 'rationalization')
                    out.add('causal-rationalization');
                else if (operator === 'blending')
                    out.add('lineage-blending');
            }
            if (rng.bool(clamp(mode.innovationRate ?? 0))) {
                noiseOperators.push('innovation');
                out.add('innovation');
            }
            return { tags: [...out].sort(), noiseOperators };
        };
        for (const record of sourceKnowledge) {
            const rng = context.rng.stream('lore-interpretation', record.id);
            const tags = new Set(knowledgeSemanticTags(record));
            const variableKey = typeof record.claim.variable === 'string' ? record.claim.variable : '';
            const definition = context.recipe.variables.find((variable) => `${variable.namespace}:${variable.id}` === variableKey || variable.id === variableKey);
            const motifTags = definition?.metadata?.motifTags;
            if (Array.isArray(motifTags))
                for (const tag of motifTags)
                    if (typeof tag === 'string')
                        tags.add(tag);
            const semanticTags = [...tags].sort();
            const activeCorpusMotifs = corpus.motifs.filter((motif) => (motif.curationStatus ?? 'active') === 'active');
            const candidateDefinitions = activeCorpusMotifs.length ? activeCorpusMotifs : [...definitions.values()];
            const candidates = candidateDefinitions.map((motif) => ({ motif, score: motifCompatibility(semanticTags, motif) }))
                .sort((a, b) => b.score - a.score || a.motif.id.localeCompare(b.motif.id));
            if (!candidates.length)
                continue;
            const positive = candidates.filter((candidate) => candidate.score > 0);
            const shortlist = (positive.length ? positive : candidates).slice(0, Math.min(6, candidates.length));
            const motif = rng.pick(shortlist).motif;
            const motifEntity = motifEntities.get(motif.id);
            if (!motifEntity)
                continue;
            const transformations = chooseTransformations(semanticTags, motif, rng);
            const transformed = applyTransformationOperators(semanticTags, motif, transformations, rng);
            const mode = chooseTransmissionMode(record, transformed.tags, rng);
            const parentIds = record.truthLinkIds?.length ? record.truthLinkIds : [];
            const formationTick = Math.min(context.snapshot.manifest.currentTick, Math.max(0, record.acquiredTick));
            const inferenceCause = builder.causal('inference', false, parentIds, {
                holderId: record.holderId,
                knowledgeId: record.id,
                motifId: motif.id,
                semanticTags,
                transformedSemanticTags: transformed.tags,
                transformationIds: transformations.map((item) => item.id),
                transformationOperations: transformed.operations,
                sourceIds: motif.sourceIds,
            }, formationTick);
            const epistemicDistance = clamp((1 - record.confidence) * 0.55 + mode.distortion * 0.3 + transformations.length * 0.05);
            const variant = builder.entity('lore-variant', [record.id, record.holderId, motif.id], {
                holderId: record.holderId,
                knowledgeId: record.id,
                motifId: motif.id,
                motifFamily: motif.family,
                ...(motif.motifeme ? { motifeme: motif.motifeme } : {}),
                allomotifs: motif.allomotifs ?? [],
                structuralRoles: motif.structuralRoles ?? [],
                ontologyFacets: motif.ontologyFacets ?? [],
                semanticTags: transformed.tags,
                originalSemanticTags: semanticTags,
                transformationIds: transformations.map((item) => item.id),
                transformationSemantics: transformations.map((item) => item.semanticEffect),
                transformationOperations: transformed.operations,
                interpretationModeId: mode.id,
                epistemicDistance,
                sourceIds: motif.sourceIds,
                sourceConfidence: record.confidence,
            }, [inferenceCause]);
            variant.bornTick = formationTick;
            builder.relation('interprets-through', record.holderId, motifEntity.id, [inferenceCause], { knowledgeId: record.id, loreVariantId: variant.id });
            builder.relation('holds-lore-variant', record.holderId, variant.id, [inferenceCause]);
            builder.relation('instantiates-motif', variant.id, motifEntity.id, [inferenceCause]);
            builder.event('lore-formation', formationTick, [record.holderId], [variant.id, motifEntity.id], {
                knowledgeId: record.id,
                motifId: motif.id,
                transformationIds: transformations.map((item) => item.id),
            }, [inferenceCause], [inferenceCause]);
            variantCount += 1;
            if (settlements.length <= 1 || !rng.bool(transmissionChance))
                continue;
            const targetPool = settlements.filter((settlement) => settlement.id !== record.holderId);
            if (!targetPool.length)
                continue;
            const target = rng.pick(targetPool);
            const transmissionMode = chooseTransmissionMode(record, transformed.tags, rng);
            const loreTransmissionTick = Math.min(context.snapshot.manifest.currentTick, formationTick + Math.max(1, Math.round(context.recipe.clock.ticksPerDay * (1 + transmissionMode.distortion * 20))));
            const delayDays = Math.max(0, (loreTransmissionTick - formationTick) / Math.max(1, context.recipe.clock.ticksPerDay));
            const halfLife = Math.max(0.01, transmissionMode.memoryHalfLifeDays ?? 365);
            const memoryRetention = Math.pow(0.5, delayDays / halfLife);
            const noisy = applyTransmissionNoise(transformed.tags, motif, transmissionMode, rng);
            const priorExposureCount = context.snapshot.knowledge.filter((item) => item.holderId === target.id && item.claim.motifId === motif.id).length;
            const adoptionThreshold = Math.max(1, transmissionMode.complexContagionThreshold ?? 1);
            const adopted = priorExposureCount + 1 >= adoptionThreshold;
            const transmissionCause = builder.causal('transmission', false, [inferenceCause], {
                sourceHolderId: record.holderId,
                targetHolderId: target.id,
                sourceLoreVariantId: variant.id,
                modeId: transmissionMode.id,
                direction: transmissionMode.direction ?? 'mixed',
                distortion: transmissionMode.distortion,
                copyingBiases: transmissionMode.copyingBiases ?? {},
                noiseOperators: noisy.noiseOperators,
                memoryRetention,
                adoptionThreshold,
                priorExposureCount,
                adopted,
            }, loreTransmissionTick);
            const transmittedKnowledgeId = stableId('know-lore', record.id, target.id, motif.id, loreTransmissionTick);
            if (!context.snapshot.knowledge.some((item) => item.id === transmittedKnowledgeId)) {
                context.snapshot.knowledge.push({
                    id: transmittedKnowledgeId,
                    holderId: target.id,
                    subjectIds: [...record.subjectIds, variant.id, motifEntity.id],
                    acquiredTick: loreTransmissionTick,
                    confidence: clamp(record.confidence * transmissionMode.retention * memoryRetention * (1 - transmissionMode.distortion * 0.35)),
                    sourceKnowledgeId: record.id,
                    sourceEntityId: record.holderId,
                    claim: {
                        loreVariantId: variant.id,
                        motifId: motif.id,
                        transmissionModeId: transmissionMode.id,
                        transmissionDirection: transmissionMode.direction ?? 'mixed',
                        transformationIds: transformations.map((item) => item.id),
                        semanticTags: noisy.tags,
                        noiseOperators: noisy.noiseOperators,
                        adoptionThreshold,
                        exposureOrdinal: priorExposureCount + 1,
                        interpretation: adopted ? 'transmitted-lore' : 'lore-exposure',
                    },
                });
            }
            if (!adopted) {
                builder.event('lore-exposure', loreTransmissionTick, [record.holderId], [target.id], {
                    sourceLoreVariantId: variant.id, motifId: motif.id, modeId: transmissionMode.id, exposureOrdinal: priorExposureCount + 1, adoptionThreshold,
                }, [transmissionCause], [transmissionCause], target.spatial);
                continue;
            }
            const transmittedVariant = builder.entity('lore-variant', [variant.id, target.id, transmissionMode.id], {
                holderId: target.id,
                sourceLoreVariantId: variant.id,
                sourceHolderId: record.holderId,
                motifId: motif.id,
                motifFamily: motif.family,
                ...(motif.motifeme ? { motifeme: motif.motifeme } : {}),
                allomotifs: motif.allomotifs ?? [],
                structuralRoles: motif.structuralRoles ?? [],
                ontologyFacets: motif.ontologyFacets ?? [],
                semanticTags: noisy.tags,
                transformationIds: transformations.map((item) => item.id),
                transformationOperations: transformed.operations,
                transmissionModeId: transmissionMode.id,
                transmissionDirection: transmissionMode.direction ?? 'mixed',
                copyingBiases: transmissionMode.copyingBiases ?? {},
                noiseOperators: noisy.noiseOperators,
                memoryRetention,
                exposureCount: priorExposureCount + 1,
                adoptionThreshold,
                epistemicDistance: clamp(epistemicDistance + transmissionMode.distortion * 0.5 + (1 - memoryRetention) * 0.25),
                sourceIds: motif.sourceIds,
            }, [transmissionCause]);
            transmittedVariant.bornTick = loreTransmissionTick;
            builder.relation('holds-lore-variant', target.id, transmittedVariant.id, [transmissionCause]);
            builder.relation('variant-descends-from', transmittedVariant.id, variant.id, [transmissionCause]);
            builder.relation('instantiates-motif', transmittedVariant.id, motifEntity.id, [transmissionCause]);
            builder.event('lore-transmission', loreTransmissionTick, [record.holderId], [target.id, transmittedVariant.id], {
                sourceLoreVariantId: variant.id,
                motifId: motif.id,
                modeId: transmissionMode.id,
                direction: transmissionMode.direction ?? 'mixed',
                noiseOperators: noisy.noiseOperators,
                memoryRetention,
                adoptionThreshold,
                exposureCount: priorExposureCount + 1,
            }, [transmissionCause], [transmissionCause], target.spatial);
            transmittedCount += 1;
            variantCount += 1;
        }
        context.snapshot.aggregates.loreCorpus = {
            sourceCount: corpus.sources.length,
            motifDefinitionCount: corpus.motifs.length,
            transformationRuleCount: corpus.transformations.length,
            transmissionModeCount: corpus.transmissionModes.length,
            sourceIds: corpus.sources.map((source) => source.id),
            warnings: corpus.warnings,
            generatedVariantCount: variantCount,
            transmittedVariantCount: transmittedCount,
            motifRelationCount,
            authoredMotifRelationCount,
        };
    },
};
export const loreEvolutionModule = {
    id: 'lore-evolution', version: '1.0.0', capabilities: ['diachronic-lore', 'forgetting', 'revival', 'schism', 'syncretism', 'canonization', 'taboo-suppression', 'media-channel-effects'],
    runPass(passId, config, context) {
        if (passId !== 'lore:diachronic')
            return;
        const builder = new SnapshotBuilder(context.snapshot);
        const currentTick = context.snapshot.manifest.currentTick;
        const evolutionChance = clamp(numberConfig(config, 'evolutionChance', 0.5));
        const maxEvolutionEvents = Math.max(0, Math.round(numberConfig(config, 'maxEvolutionEvents', 192)));
        const configuredProcesses = stringArrayConfig(config, 'processes', ['forgetting', 'revival', 'schism', 'syncretism', 'canonization', 'taboo-suppression', 'media-channel-shift']);
        const processes = configuredProcesses.length ? configuredProcesses : ['forgetting'];
        const sourceVariants = context.snapshot.entities.filter((entity) => entity.kind === 'lore-variant' && (entity.bornTick ?? currentTick) < currentTick).slice().sort((a, b) => (a.bornTick ?? 0) - (b.bornTick ?? 0) || a.id.localeCompare(b.id));
        const institutions = context.snapshot.entities.filter((entity) => entity.kind === 'institution');
        const basedIn = context.snapshot.relations.filter((relation) => relation.kind === 'based-in');
        const channels = context.snapshot.relations.filter((relation) => relation.kind === 'information-channel');
        const processCounts = {};
        let eventCount = 0;
        const institutionsAt = (holderId) => basedIn.filter((relation) => relation.targetId === holderId).map((relation) => institutions.find((institution) => institution.id === relation.sourceId)).filter((value) => !!value);
        const channelIdsAt = (holderId) => channels.filter((channel) => channel.sourceId === holderId || channel.targetId === holderId).map((channel) => channel.id);
        for (let i = 0; i < sourceVariants.length && eventCount < maxEvolutionEvents; i += 1) {
            const variant = sourceVariants[i];
            const bornTick = variant.bornTick ?? currentTick;
            const age = currentTick - bornTick;
            if (age <= 0)
                continue;
            const rng = context.rng.stream('lore-evolution', variant.id);
            if (!rng.bool(evolutionChance))
                continue;
            let process = processes[i % processes.length];
            const holderId = typeof variant.components.holderId === 'string' ? variant.components.holderId : '';
            const holder = context.snapshot.entities.find((entity) => entity.id === holderId);
            const institutionsHere = institutionsAt(holderId);
            const channelsHere = channelIdsAt(holderId);
            const otherVariants = sourceVariants.filter((candidate) => candidate.id !== variant.id && candidate.components.motifId !== variant.components.motifId);
            if (process === 'canonization' && !institutionsHere.length)
                process = 'revival';
            if (process === 'media-channel-shift' && !channelsHere.length)
                process = 'forgetting';
            if (process === 'syncretism' && !otherVariants.length)
                process = 'schism';
            const evolutionTick = Math.min(currentTick, Math.max(bornTick + 1, Math.round(bornTick + age * rng.float(0.25, 0.92))));
            const parentIds = variant.provenanceIds;
            const cause = builder.causal('transmission', false, parentIds, { transition: 'lore-evolution', process, sourceLoreVariantId: variant.id, holderId }, evolutionTick);
            const nextComponents = { ...variant.components, sourceLoreVariantId: variant.id, evolutionProcess: process, evolvedTick: evolutionTick };
            let secondVariant;
            let institution;
            if (process === 'forgetting') {
                nextComponents.retentionIndex = clamp(Number(variant.components.retentionIndex ?? 1) * rng.float(0.35, 0.78));
                nextComponents.epistemicDistance = clamp(Number(variant.components.epistemicDistance ?? 0.4) + rng.float(0.05, 0.22));
                nextComponents.status = 'attenuated';
            }
            else if (process === 'revival') {
                nextComponents.retentionIndex = clamp(Number(variant.components.retentionIndex ?? 0.45) + rng.float(0.15, 0.42));
                nextComponents.epistemicDistance = clamp(Number(variant.components.epistemicDistance ?? 0.4) - rng.float(0.02, 0.12));
                nextComponents.status = 'revived';
            }
            else if (process === 'schism') {
                const transforms = Array.isArray(variant.components.transformationIds) ? [...variant.components.transformationIds] : [];
                transforms.push('schismatic-reinterpretation');
                nextComponents.transformationIds = transforms;
                nextComponents.epistemicDistance = clamp(Number(variant.components.epistemicDistance ?? 0.4) + rng.float(0.08, 0.24));
                nextComponents.status = 'schismatic';
            }
            else if (process === 'syncretism') {
                secondVariant = rng.pick(otherVariants);
                nextComponents.syncretizedWithVariantId = secondVariant.id;
                nextComponents.motifIds = [...new Set([String(variant.components.motifId ?? ''), String(secondVariant.components.motifId ?? '')].filter(Boolean))];
                nextComponents.epistemicDistance = clamp((Number(variant.components.epistemicDistance ?? 0.4) + Number(secondVariant.components.epistemicDistance ?? 0.4)) / 2 + 0.05);
                nextComponents.status = 'syncretic';
            }
            else if (process === 'canonization') {
                institution = rng.pick(institutionsHere);
                nextComponents.canonizedByInstitutionId = institution.id;
                nextComponents.authorityIndex = clamp(Number(institution.components.legitimacyIndex ?? 0.5) * 0.6 + Number(institution.components.capacityIndex ?? 0.5) * 0.4);
                nextComponents.status = 'canonized';
            }
            else if (process === 'taboo-suppression') {
                nextComponents.visibilityIndex = rng.float(0.04, 0.28);
                nextComponents.retentionIndex = clamp(Number(variant.components.retentionIndex ?? 0.7) * rng.float(0.55, 0.88));
                nextComponents.status = 'suppressed';
            }
            else if (process === 'media-channel-shift') {
                nextComponents.informationChannelId = rng.pick(channelsHere);
                nextComponents.transmissionModeId = 'network-mediated';
                nextComponents.epistemicDistance = clamp(Number(variant.components.epistemicDistance ?? 0.4) + rng.float(-0.08, 0.12));
                nextComponents.status = 'media-shifted';
            }
            const evolved = builder.entity('lore-variant', [variant.id, process, evolutionTick], nextComponents, [cause], holder?.spatial, typeof variant.subtype === 'string' ? variant.subtype : undefined);
            evolved.bornTick = evolutionTick;
            builder.relation('variant-descends-from', evolved.id, variant.id, [cause], { process, evolutionTick });
            if (secondVariant)
                builder.relation('variant-syncretizes-with', evolved.id, secondVariant.id, [cause], { process: 'syncretism' });
            if (institution)
                builder.relation('lore-canonized-by', evolved.id, institution.id, [cause], { authorityIndex: nextComponents.authorityIndex ?? null });
            builder.relation('holds-lore-variant', holderId, evolved.id, [cause], { process, evolutionTick });
            builder.event(`lore-evolution:${process}`, evolutionTick, holderId ? [holderId] : [], [evolved.id, variant.id], { process, sourceLoreVariantId: variant.id, evolvedVariantId: evolved.id }, [cause], [cause], holder?.spatial);
            processCounts[process] = (processCounts[process] ?? 0) + 1;
            eventCount += 1;
        }
        context.snapshot.aggregates.loreEvolution = { eventCount, processCounts, eligibleVariantCount: sourceVariants.length, evolutionChance, maxEvolutionEvents };
    },
};
export const lodModule = {
    id: 'lod', version: '1.2.0', capabilities: ['lod-index', 'cohort-materialization', 'reversible-detail', 'lod-conservation-audit', 'identity-anchor-continuity'],
    runPass(passId, _config, context) {
        if (passId !== 'lod:index')
            return;
        const byKind = {};
        for (const entity of context.snapshot.entities)
            byKind[entity.kind] = (byKind[entity.kind] ?? 0) + 1;
        const byRegion = {};
        let settlementPopulationTotal = 0;
        let cohortPopulationTotal = 0;
        for (const region of regionEntities(context)) {
            const settlements = context.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.components.regionId === region.id && entity.endedTick === undefined);
            const settlementPopulation = settlements.reduce((sum, settlement) => sum + (typeof settlement.components.population === 'number' ? settlement.components.population : 0), 0);
            const settlementIds = new Set(settlements.map((settlement) => settlement.id));
            const cohortPopulation = context.snapshot.entities.filter((entity) => entity.kind === 'population-cohort' && settlementIds.has(String(entity.components.settlementId ?? '')))
                .reduce((sum, cohort) => sum + Math.max(0, Number(cohort.components.count ?? 0)), 0);
            settlementPopulationTotal += settlementPopulation;
            cohortPopulationTotal += cohortPopulation;
            byRegion[region.id] = {
                settlementCount: settlements.length,
                population: settlementPopulation,
                cohortPopulation,
                conservationError: cohortPopulation - settlementPopulation,
            };
        }
        context.snapshot.aggregates.lodIndex = {
            byKind,
            byRegion,
            tiers: context.recipe.lodTiers.map((tier) => ({ id: tier.id, detailRank: tier.detailRank, populationMode: tier.populationMode })),
            conservation: {
                settlementPopulationTotal,
                cohortPopulationTotal,
                populationError: cohortPopulationTotal - settlementPopulationTotal,
                exact: cohortPopulationTotal === settlementPopulationTotal,
            },
        };
    },
};
export const builtinModules = [
    kernelModule, geographyModule, ecologyModule, populationModule, historyModule, societyModule, historicalDepthModule,
    knowledgeModule, informationEcologyModule, motifModule, loreEvolutionModule, worldLawsModule, lodModule,
];

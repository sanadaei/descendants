import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WorldgenEngine, parseWorldRecipe, snapshotDigest, validateSnapshotConformance,
  serializeSnapshot, deserializeSnapshot, createSnapshotDelta, applySnapshotDelta,
  diagnoseDeterministicReplay, createBuiltinRegistry, ContentPackRegistry, migrateSnapshot, auditLoreCorpus, reconstructPopulationFromHistory, reconstructMaterialSystemsFromHistory, terrainStrategyRegistry, worldLawEffectOperatorRegistry, lodCoarseningPolicyRegistry, geometryTopologyRegistry, demographyPolicyRegistry,
} from '../dist/index.js';

const recipeText = await readFile(new URL('../setting-packs/descendants/default.recipe.json', import.meta.url), 'utf8');
const baseRecipe = parseWorldRecipe(recipeText);
const clone = (value) => JSON.parse(JSON.stringify(value));

test('Descendants recipe generates a deterministic contract-conformant snapshot', async () => {
  const diagnostic = await diagnoseDeterministicReplay(baseRecipe);
  assert.equal(diagnostic.deterministic, true);
  const world = await new WorldgenEngine().generate(baseRecipe);
  const snapshot = await world.exportSnapshot();
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
  assert.ok(snapshot.entities.some((entity) => entity.kind === 'continent'));
  assert.ok(snapshot.entities.some((entity) => entity.kind === 'settlement'));
  assert.ok(snapshot.causalRecords.some((record) => record.hiddenTruth));
});

test('geography supports variable continent counts and dimensions without kernel assumptions', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'multi-continent-fixture';
  recipe.seed = 42;
  recipe.geometry.extent.widthKm = 3200;
  recipe.geometry.extent.heightKm = 1900;
  recipe.geometry.continentCount = { mode: 'fixed', value: 3 };
  recipe.modules.find((module) => module.id === 'geography').config = { regionsPerContinent: 4 };
  const world = await new WorldgenEngine().generate(recipe);
  const snapshot = await world.exportSnapshot();
  assert.equal(snapshot.entities.filter((entity) => entity.kind === 'continent').length, 3);
  assert.equal(snapshot.entities.filter((entity) => entity.kind === 'region').length, 12);
  assert.equal(snapshot.manifest.geometry.extent.widthKm, 3200);
});

test('hidden truth is present canonically but filtered from an observer without knowledge', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'knowledge-fixture';
  recipe.modules.find((module) => module.id === 'knowledge').config = { hiddenDiscoveryRate: 0 };
  const world = await new WorldgenEngine().generate(recipe);
  const snapshot = await world.exportSnapshot();
  const settlement = snapshot.entities.find((entity) => entity.kind === 'settlement');
  const region = snapshot.entities.find((entity) => entity.id === settlement.components.regionId);
  assert.ok(region.components.variables['descendants:anomaly_pressure'] !== undefined);
  const projected = await world.getEntity(region.id, settlement.id);
  assert.equal(projected.components.variables['descendants:anomaly_pressure'], undefined);
});

test('LOD materialization is stable, reversible, and coarse export omits materialized individuals', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const snapshot = await world.exportSnapshot();
  const settlement = snapshot.entities.find((entity) => entity.kind === 'settlement' && entity.spatial);
  const query = { center: settlement.spatial, radiusKm: 15, requestedDetailRank: 0 };
  const first = await world.queryArea(query);
  const firstIds = first.entities.filter((entity) => entity.kind === 'individual').map((entity) => entity.id).sort();
  assert.ok(firstIds.length > 0);
  assert.ok(world.collapseMaterializedDetail() > 0);
  const second = await world.queryArea(query);
  const secondIds = second.entities.filter((entity) => entity.kind === 'individual').map((entity) => entity.id).sort();
  assert.deepEqual(secondIds, firstIds);
  const coarse = await world.exportSnapshot(3);
  assert.equal(coarse.entities.some((entity) => entity.kind === 'individual'), false);
});

test('snapshot persistence and delta application preserve deterministic identity', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const before = await world.exportSnapshot();
  const loaded = deserializeSnapshot(serializeSnapshot(before));
  assert.equal(snapshotDigest(loaded), snapshotDigest(before));
  await world.advance({ toTick: before.manifest.currentTick + baseRecipe.clock.ticksPerDay * 2 });
  const after = await world.exportSnapshot();
  const delta = createSnapshotDelta(before, after);
  const applied = applySnapshotDelta(before, delta);
  assert.equal(snapshotDigest(applied), snapshotDigest(after));
});

test('time advancement is invariant to segmentation at canonical day boundaries', async () => {
  const engine = new WorldgenEngine();
  const a = await engine.generate(baseRecipe);
  const b = await engine.generate(baseRecipe);
  const start = (await a.getManifest()).currentTick;
  const day = baseRecipe.clock.ticksPerDay;
  await a.advance({ toTick: start + day * 2 });
  await b.advance({ toTick: start + day });
  await b.advance({ toTick: start + day * 2 });
  assert.equal(snapshotDigest(await a.exportSnapshot()), snapshotDigest(await b.exportSnapshot()));
});

test('stress fixture generates hundreds of spatial entities with stable IDs', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'stress-fixture';
  recipe.seed = 987654;
  recipe.geometry.continentCount = { mode: 'fixed', value: 5 };
  recipe.modules.find((module) => module.id === 'geography').config = { regionsPerContinent: 12 };
  recipe.modules.find((module) => module.id === 'population').config = { settlementsPerRegion: 3, basePopulation: 5000 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  assert.ok(snapshot.entities.filter((entity) => entity.spatial).length > 900);
  assert.equal(new Set(snapshot.entities.map((entity) => entity.id)).size, snapshot.entities.length);
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});

test('custom modules participate in the pass DAG and component schemas are enforced', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'plugin-fixture';
  recipe.modules.push({ id: 'fixture-plugin', enabled: true, config: {} });
  recipe.generationPipeline.push({ id: 'fixture:augment', moduleId: 'fixture-plugin', dependsOn: ['geography:substrate'] });
  recipe.componentSchemas.push({
    id: 'fixture-region-schema', namespace: 'fixture', appliesToKinds: ['region'],
    schema: { required: ['fixtureMarker'], properties: { fixtureMarker: { type: 'string' } } },
  });
  const registry = createBuiltinRegistry();
  registry.register({
    id: 'fixture-plugin', version: '1.2.3', capabilities: ['fixture-capability'],
    runPass(passId, _config, context) {
      if (passId !== 'fixture:augment') return;
      for (const entity of context.snapshot.entities.filter((item) => item.kind === 'region')) entity.components.fixtureMarker = 'ok';
    },
  });
  const snapshot = await (await new WorldgenEngine(registry).generate(recipe)).exportSnapshot();
  assert.ok(snapshot.entities.filter((entity) => entity.kind === 'region').every((entity) => entity.components.fixtureMarker === 'ok'));
  assert.ok(snapshot.manifest.capabilities.includes('fixture-capability'));
});

test('registered content packs are version checked against recipe references', async () => {
  const content = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) content.register({ id: ref.id, version: ref.version, data: { fixture: true } });
  await new WorldgenEngine(createBuiltinRegistry(), content).generate(baseRecipe);
  const bad = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) bad.register({ id: ref.id, version: ref.id === baseRecipe.contentPacks[0].id ? '999.0.0' : ref.version, data: {} });
  await assert.rejects(() => new WorldgenEngine(createBuiltinRegistry(), bad).generate(baseRecipe), /version mismatch/);
});

test('legacy persistence envelope migrates to schema v1 world data', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const migrated = migrateSnapshot({ schemaVersion: 0, world: snapshot });
  assert.equal(migrated.manifest.contractVersion, '1.0.0');
  assert.deepEqual(migrated.aggregates.persistenceMigration, { fromSchemaVersion: 0, toSchemaVersion: 1 });
});

test('setting-pack world-law drift changes recipe-defined variables without kernel-specific names', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const before = await world.exportSnapshot();
  const region = before.entities.find((entity) => entity.kind === 'region');
  const key = 'descendants:anomaly_pressure';
  const oldValue = region.components.variables[key];
  await world.advance({ toTick: before.manifest.currentTick + baseRecipe.clock.ticksPerDay });
  const afterRegion = await world.getEntity(region.id);
  assert.notEqual(afterRegion.components.variables[key], oldValue);
  assert.ok((await world.exportSnapshot()).events.some((event) => event.kind === 'world-law-effect:anomaly-spread'));
});

test('burn-in includes migration as causal history rather than present-state fabrication', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const migrations = snapshot.events.filter((event) => event.kind === 'macro-migration');
  assert.ok(migrations.length > 0);
  assert.ok(migrations.every((event) => event.causeIds.length > 0 && event.tick <= snapshot.manifest.currentTick));
});

test('LOD materialized IDs survive coarse save-load and re-refinement', async () => {
  const engine = new WorldgenEngine();
  const world = await engine.generate(baseRecipe);
  const initial = await world.exportSnapshot();
  const settlement = initial.entities.find((entity) => entity.kind === 'settlement' && entity.spatial);
  const query = { center: settlement.spatial, radiusKm: 15, requestedDetailRank: 0 };
  const idsBefore = (await world.queryArea(query)).entities.filter((entity) => entity.kind === 'individual').map((entity) => entity.id).sort();
  const coarse = await world.exportSnapshot(3);
  const restored = engine.fromSnapshot(baseRecipe, deserializeSnapshot(serializeSnapshot(coarse)));
  const idsAfter = (await restored.queryArea(query)).entities.filter((entity) => entity.kind === 'individual').map((entity) => entity.id).sort();
  assert.deepEqual(idsAfter, idsBefore);
});

test('specialist lore corpus has source provenance and validates all source references', async () => {
  const content = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const { buildLoreCorpus } = await import('../dist/index.js');
  const corpus = buildLoreCorpus(content);
  assert.deepEqual(corpus.errors, []);
  assert.ok(corpus.sources.length >= 20);
  assert.ok(corpus.motifs.length >= 40);
  assert.ok(corpus.transformations.length >= 12);
  assert.ok(corpus.transmissionModes.length >= 4);
  assert.ok(corpus.sources.some((source) => source.ingestionPolicy === 'reference-only'));
  assert.ok(corpus.sources.some((source) => source.biasNotes?.length));
  assert.ok(corpus.motifs.every((motif) => motif.sourceIds.length > 0));
});

test('content-backed lore derives from knowledge, carries bibliography provenance, and can transmit', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'lore-corpus-fixture';
  recipe.seed = 2026090801;
  recipe.modules.find((module) => module.id === 'knowledge').config = { hiddenDiscoveryRate: 1 };
  recipe.modules.find((module) => module.id === 'motif-ontology').config.transmissionChance = 1;
  const content = new ContentPackRegistry();
  for (const ref of recipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const world = await new WorldgenEngine(createBuiltinRegistry(), content).generate(recipe);
  const snapshot = await world.exportSnapshot();
  const variants = snapshot.entities.filter((entity) => entity.kind === 'lore-variant');
  const motifs = snapshot.entities.filter((entity) => entity.kind === 'motif' && Array.isArray(entity.components.sourceIds) && entity.components.sourceIds.length > 0);
  assert.ok(variants.length > 0);
  assert.ok(motifs.length >= 40);
  assert.ok(variants.every((variant) => Array.isArray(variant.components.sourceIds) && variant.components.sourceIds.length > 0));
  assert.ok(snapshot.events.some((event) => event.kind === 'lore-formation'));
  assert.ok(snapshot.events.some((event) => event.kind === 'lore-transmission'));
  assert.ok(snapshot.knowledge.some((record) => record.claim.interpretation === 'transmitted-lore' && record.sourceKnowledgeId));
  assert.ok(snapshot.causalRecords.some((record) => record.kind === 'inference' && record.payload.motifId));
  assert.ok(snapshot.causalRecords.some((record) => record.kind === 'transmission' && record.payload.sourceLoreVariantId));
  assert.ok(snapshot.aggregates.loreCorpus.sourceCount >= 20);
});

test('lore corpus does not promote motifs into canonical world laws', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'lore-truth-separation-fixture';
  recipe.modules.find((module) => module.id === 'knowledge').config = { hiddenDiscoveryRate: 1 };
  const content = new ContentPackRegistry();
  for (const ref of recipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const snapshot = await (await new WorldgenEngine(createBuiltinRegistry(), content).generate(recipe)).exportSnapshot();
  const loreIds = new Set(snapshot.entities.filter((entity) => entity.kind === 'motif' || entity.kind === 'lore-variant').map((entity) => entity.id));
  const worldLaws = snapshot.entities.filter((entity) => entity.kind === 'world-law');
  assert.ok(worldLaws.length > 0);
  assert.ok(worldLaws.every((law) => !loreIds.has(law.id)));
  const loreCauses = snapshot.causalRecords.filter((record) => record.payload.motifId || record.payload.sourceLoreVariantId);
  assert.ok(loreCauses.length > 0);
  assert.ok(loreCauses.every((record) => record.kind === 'inference' || record.kind === 'transmission'));
  assert.ok(loreCauses.every((record) => record.hiddenTruth === false));
});

test('lore generation remains deterministic with the same corpus and seed', async () => {
  const content = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const engine = new WorldgenEngine(createBuiltinRegistry(), content);
  const diagnostic = await diagnoseDeterministicReplay(baseRecipe, engine);
  assert.equal(diagnostic.deterministic, true);
  assert.equal(diagnostic.firstDigest, diagnostic.secondDigest);
});

test('terrain grid conserves land coverage into continent and region partitions', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const geography = snapshot.aggregates.geography;
  assert.ok(geography && typeof geography === 'object' && !Array.isArray(geography));
  const grid = geography.grid;
  assert.ok(grid && typeof grid === 'object' && !Array.isArray(grid));
  const land = grid.land;
  const regionIds = grid.regionIds;
  assert.ok(Array.isArray(land) && Array.isArray(regionIds));
  assert.equal(land.length, grid.width * grid.height);
  assert.equal(regionIds.length, land.length);
  const landCells = land.reduce((sum, value) => sum + value, 0);
  assert.equal(snapshot.entities.filter((entity) => entity.kind === 'continent').reduce((sum, entity) => sum + entity.components.cellCount, 0), landCells);
  assert.equal(snapshot.entities.filter((entity) => entity.kind === 'region').reduce((sum, entity) => sum + entity.components.cellCount, 0), landCells);
  assert.ok(land.every((value, i) => value === 0 || typeof regionIds[i] === 'string' && regionIds[i].length > 0));
});

test('terrain fields drive ecology and settlement carrying capacity instead of independent random fields', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const regions = snapshot.entities.filter((entity) => entity.kind === 'region');
  assert.ok(regions.length > 1);
  assert.ok(regions.every((region) => {
    const terrain = region.components.terrain;
    const env = region.components.environment;
    return terrain && typeof terrain === 'object' && env && typeof env === 'object' &&
      typeof terrain.riverFraction === 'number' && typeof terrain.landAreaKm2 === 'number' &&
      typeof env.productivityIndex === 'number' && typeof env.resourceDiversityIndex === 'number';
  }));
  const settlements = snapshot.entities.filter((entity) => entity.kind === 'settlement');
  assert.ok(settlements.every((settlement) => typeof settlement.components.siteSuitability === 'number' && typeof settlement.components.waterAccessIndex === 'number'));
  assert.ok(new Set(settlements.map((settlement) => settlement.components.carryingCapacity)).size > 1);
});

test('physical substrate remains deterministic and changes when terrain generator configuration changes', async () => {
  const engine = new WorldgenEngine();
  const a = await (await engine.generate(baseRecipe)).exportSnapshot();
  const b = await (await engine.generate(baseRecipe)).exportSnapshot();
  assert.deepEqual(a.aggregates.geography, b.aggregates.geography);
  const changed = clone(baseRecipe);
  changed.id = 'terrain-config-fixture';
  changed.modules.find((module) => module.id === 'geography').config = { regionsPerContinent: 12, gridWidth: 37, gridHeight: 29, seaLevel: 0.12, riverThreshold: 0.02 };
  const c = await (await engine.generate(changed)).exportSnapshot();
  assert.notDeepEqual(a.aggregates.geography, c.aggregates.geography);
});

test('settlement route graph mediates migration targets and carries physical accessibility costs', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const routes = snapshot.relations.filter((relation) => relation.kind === 'route-link');
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => typeof route.data.distanceKm === 'number' && route.data.distanceKm >= 0 && typeof route.data.accessibility === 'number' && route.data.accessibility > 0));
  const routePairs = new Set(routes.flatMap((route) => [`${route.sourceId}|${route.targetId}`, `${route.targetId}|${route.sourceId}`]));
  const migrations = snapshot.events.filter((event) => event.kind === 'macro-migration');
  assert.ok(migrations.length > 0);
  assert.ok(migrations.every((event) => event.targetIds[0] && routePairs.has(`${event.actorIds[0]}|${event.targetIds[0]}`) && typeof event.data.routeId === 'string'));
});

test('burn-in demographic accounting and present exchange network are causal projections', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const history = snapshot.aggregates.history;
  assert.ok(history.birthsTotal > 0);
  assert.ok(history.deathsTotal > 0);
  assert.ok(history.migrationTotal > 0);
  const transitions = snapshot.events.filter((event) => event.kind === 'macro-demographic-transition');
  assert.ok(transitions.length > 0);
  assert.ok(transitions.every((event) => typeof event.data.births === 'number' && typeof event.data.deaths === 'number' && event.causeIds.length > 0));
  const exchanges = snapshot.relations.filter((relation) => relation.kind === 'exchange-link');
  assert.ok(exchanges.length > 0);
  assert.ok(exchanges.every((relation) => typeof relation.data.routeId === 'string' && typeof relation.data.exchangePotential === 'number'));
  const settlements = snapshot.entities.filter((entity) => entity.kind === 'settlement');
  assert.ok(settlements.every((settlement) => {
    const economy = settlement.components.economy;
    return economy && typeof economy === 'object' && typeof economy.routeDegree === 'number' && typeof economy.productionIndex === 'number';
  }));
});

test('settlement lifecycle conserves population apart from births and deaths', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'settlement-lifecycle-fixture';
  const history = recipe.modules.find((module) => module.id === 'history');
  history.config = {
    epochs: 3,
    migrationChancePerEpoch: 0.2,
    settlementLifecycleChancePerEpoch: 1,
    settlementSplitPressure: 0.3,
    settlementAbandonmentPopulation: 0,
    crisisBaseChancePerEpoch: 0,
  };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const aggregate = snapshot.aggregates.history;
  assert.equal(aggregate.populationAccountingError, 0);
  assert.ok(aggregate.foundedSettlementCount > 0);
  assert.ok(snapshot.events.some((event) => event.kind === 'settlement-founded'));
  const settlementTotal = snapshot.entities.filter((entity) => entity.kind === 'settlement').reduce((sum, entity) => sum + Number(entity.components.population ?? 0), 0);
  const cohortTotal = snapshot.entities.filter((entity) => entity.kind === 'population-cohort').reduce((sum, entity) => sum + Number(entity.components.count ?? 0), 0);
  assert.equal(settlementTotal, cohortTotal);
});

test('resource logistics obey route capacity and conserve transferred stock', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const society = snapshot.aggregates.society;
  assert.ok(Array.isArray(society.resourceTypes) && society.resourceTypes.length >= 3);
  assert.ok(Math.abs(society.transportConservationError) < 1e-7);
  const flows = snapshot.relations.filter((relation) => relation.kind === 'logistics-flow');
  assert.ok(flows.length > 0);
  const routes = new Map(snapshot.relations.filter((relation) => relation.kind === 'route-link').map((relation) => [relation.id, relation]));
  assert.ok(flows.every((flow) => typeof flow.data.resourceId === 'string' && typeof flow.data.quantity === 'number' && flow.data.quantity > 0 && routes.has(flow.data.routeId)));
  assert.ok(snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined).every((settlement) => {
    const resources = settlement.components.economy?.resources;
    return resources && typeof resources === 'object' && society.resourceTypes.every((resourceId) => typeof resources[resourceId]?.stock === 'number');
  }));
});

test('political geography is derived from route and institution clusters', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const polities = snapshot.entities.filter((entity) => entity.kind === 'polity');
  assert.ok(polities.length > 0);
  assert.ok(polities.every((polity) => polity.components.derivation === 'route-institution-cluster' && Array.isArray(polity.components.settlementIds) && polity.components.settlementIds.length > 0));
  const membership = snapshot.relations.filter((relation) => relation.kind === 'member-of-polity');
  const activeSettlements = snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined);
  assert.equal(new Set(membership.map((relation) => relation.sourceId)).size, activeSettlements.length);
  assert.ok(snapshot.entities.filter((entity) => entity.kind === 'region').every((region) => region.components.politicalGeography?.derivation === 'population-route-institution'));
});

test('deep history leaves archaeological traces and artifact biographies linked to causal events', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const depth = snapshot.aggregates.historicalDepth;
  assert.ok(depth.traceCount > 0);
  const traces = snapshot.entities.filter((entity) => entity.kind === 'historical-trace');
  const eventIds = new Set(snapshot.events.map((event) => event.id));
  assert.ok(traces.length > 0 && traces.every((trace) => eventIds.has(trace.components.originEventId)));
  const artifacts = snapshot.entities.filter((entity) => entity.kind === 'artifact');
  assert.ok(artifacts.length > 0);
  assert.ok(artifacts.every((artifact) => Array.isArray(artifact.components.biography) && artifact.components.biography.length >= 2 && eventIds.has(artifact.components.originEventId)));
  assert.ok(snapshot.entities.some((entity) => entity.kind === 'archaeological-site'));
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});

test('information ecology separates direct trace observation from lossy transmitted claims', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'information-ecology-fixture';
  const info = recipe.modules.find((module) => module.id === 'information-ecology');
  info.config = { traceObservationChance: 1, baseLoss: 0, baseDistortion: 1, baseCensorship: 0, maxTransmissions: 128 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const direct = snapshot.knowledge.filter((record) => record.claim.interpretation === 'material-trace-observation');
  const transmitted = snapshot.knowledge.filter((record) => record.claim.interpretation === 'contested-transmitted-trace' || record.claim.interpretation === 'transmitted-trace-report');
  assert.ok(direct.length > 0);
  assert.ok(transmitted.length > 0);
  assert.ok(transmitted.every((record) => record.sourceKnowledgeId));
  assert.ok(snapshot.relations.some((relation) => relation.kind === 'information-channel'));
  assert.ok(snapshot.events.some((event) => event.kind === 'information-transmission'));
  assert.ok(snapshot.aggregates.informationEcology.corruptedTransmissionCount > 0);
});

test('LOD materialization creates stable identity anchors and households whose commitments survive collapse', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const initial = await world.exportSnapshot();
  const settlement = initial.entities.find((entity) => entity.kind === 'settlement' && entity.spatial && entity.endedTick === undefined);
  const query = { center: settlement.spatial, radiusKm: 8, requestedDetailRank: 0 };
  const projection = await world.queryArea(query);
  const person = projection.entities.find((entity) => entity.kind === 'individual');
  const household = projection.entities.find((entity) => entity.kind === 'household');
  assert.ok(person && household && typeof person.components.identityAnchorId === 'string');
  const anchorId = person.components.identityAnchorId;
  const result = await world.issueCommand({
    id: 'commitment-fixture', kind: 'lod-record-commitment', issuedTick: initial.manifest.currentTick,
    targets: [person.id], payload: { commitment: { kind: 'promise', subject: 'fixture' } },
  });
  assert.equal(result.accepted, true);
  const anchorBefore = await world.getEntity(anchorId);
  assert.equal(anchorBefore.components.commitments.length, 1);
  assert.ok(world.collapseMaterializedDetail() > 0);
  const coarse = await world.exportSnapshot(3);
  assert.ok(coarse.entities.some((entity) => entity.id === anchorId && entity.kind === 'identity-anchor'));
  const reprojection = await world.queryArea(query);
  const rematerialized = reprojection.entities.find((entity) => entity.kind === 'individual' && entity.components.identityAnchorId === anchorId);
  assert.ok(rematerialized);
  assert.equal(rematerialized.components.commitments.length, 1);
});

test('LOD population delta commits detail action back into cohort and settlement aggregates', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const initial = await world.exportSnapshot();
  const settlement = initial.entities.find((entity) => entity.kind === 'settlement' && entity.spatial && entity.endedTick === undefined);
  const query = { center: settlement.spatial, radiusKm: 8, requestedDetailRank: 0 };
  const projection = await world.queryArea(query);
  const person = projection.entities.find((entity) => entity.kind === 'individual' && entity.components.cohortId);
  const cohortBefore = await world.getEntity(person.components.cohortId);
  const settlementBefore = await world.getEntity(cohortBefore.components.settlementId);
  const result = await world.issueCommand({ id: 'lod-delta-fixture', kind: 'lod-population-delta', issuedTick: initial.manifest.currentTick, targets: [person.id], payload: { delta: -1 } });
  assert.equal(result.accepted, true);
  const cohortAfter = await world.getEntity(cohortBefore.id);
  const settlementAfter = await world.getEntity(settlementBefore.id);
  assert.equal(cohortAfter.components.count, cohortBefore.components.count - 1);
  assert.equal(settlementAfter.components.population, settlementBefore.components.population - 1);
  world.collapseMaterializedDetail();
  assert.deepEqual(validateSnapshotConformance(await world.exportSnapshot(3)), []);
});

test('generalized world laws expose full dimensions and can target arbitrary component paths', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'generic-world-law-fixture';
  const laws = recipe.modules.find((module) => module.id === 'world-laws');
  laws.config.rules.push({
    id: 'generic-infrastructure-decay',
    kind: 'transition',
    hiddenTruth: true,
    source: { kind: 'environmental-process' },
    cost: null,
    carrier: { kind: 'material-network' },
    range: { scope: 'settlement' },
    persistence: { mode: 'continuous' },
    failure: { chancePerDay: 0 },
    interactions: [],
    research: { discoverable: true },
    ritual: { applicable: false },
    technology: { applicable: true },
    effects: [{ entityKind: 'settlement', componentPath: 'economy.infrastructureIndex', operation: 'multiply', factor: 0.99, stochastic: 0 }],
  });
  const world = await new WorldgenEngine().generate(recipe);
  const before = await world.exportSnapshot();
  const settlement = before.entities.find((entity) => entity.kind === 'settlement' && entity.endedTick === undefined);
  const oldValue = settlement.components.economy.infrastructureIndex;
  const lawEntity = before.entities.find((entity) => entity.kind === 'world-law' && entity.components.ruleId === 'generic-infrastructure-decay');
  assert.ok(lawEntity);
  for (const key of ['source','cost','carrier','range','persistence','failure','interactions','research','ritual','technology']) assert.ok(key in lawEntity.components.dimensions);
  await world.advance({ toTick: before.manifest.currentTick + recipe.clock.ticksPerDay });
  const after = await world.getEntity(settlement.id);
  assert.ok(after.components.economy.infrastructureIndex < oldValue);
  assert.ok((await world.exportSnapshot()).events.some((event) => event.kind === 'world-law-effect:generic-infrastructure-decay' && event.data.componentPath === 'economy.infrastructureIndex'));
});


test('motif ontology exposes typed relation graph without changing canonical truth', async () => {
  const content = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const world = await new WorldgenEngine(createBuiltinRegistry(), content).generate(baseRecipe);
  const snapshot = await world.exportSnapshot();
  const motifIds = new Set(snapshot.entities.filter((entity) => entity.kind === 'motif').map((entity) => entity.id));
  const motifRelations = snapshot.relations.filter((relation) => relation.kind.startsWith('motif-'));
  assert.ok(motifRelations.length > 0);
  assert.ok(motifRelations.every((relation) => motifIds.has(relation.sourceId) && motifIds.has(relation.targetId)));
  const relationTypes = new Set(motifRelations.map((relation) => relation.data?.relationType));
  assert.ok(relationTypes.has('co-occurrence') || relationTypes.has('transformation-affinity'));
  assert.equal(snapshot.entities.filter((entity) => entity.kind === 'world-law').some((entity) => motifIds.has(entity.id)), false);
  assert.ok(snapshot.aggregates.loreCorpus.motifRelationCount >= motifRelations.length);
});

test('diachronic lore preserves ancestry while modeling forgetting, schism, syncretism, canonization and media effects', async () => {
  const recipe = clone(baseRecipe);
  const evolution = recipe.modules.find((module) => module.id === 'lore-evolution');
  evolution.config.evolutionChance = 1;
  evolution.config.maxEvolutionEvents = 256;
  const content = new ContentPackRegistry();
  for (const ref of recipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const world = await new WorldgenEngine(createBuiltinRegistry(), content).generate(recipe);
  const snapshot = await world.exportSnapshot();
  const evolved = snapshot.entities.filter((entity) => entity.kind === 'lore-variant' && entity.components.evolutionProcess);
  assert.ok(evolved.length > 0);
  const ancestry = snapshot.relations.filter((relation) => relation.kind === 'variant-descends-from');
  assert.ok(evolved.every((variant) => ancestry.some((relation) => relation.sourceId === variant.id && relation.targetId === variant.components.sourceLoreVariantId)));
  const eventProcesses = new Set(snapshot.events.filter((event) => event.kind.startsWith('lore-evolution:')).map((event) => event.data.process));
  assert.ok(eventProcesses.size >= 3);
  assert.ok(snapshot.aggregates.loreEvolution.eventCount === evolved.length);
  assert.equal(snapshot.entities.filter((entity) => entity.kind === 'world-law').some((law) => law.components.evolutionProcess), false);
});


test('spatial query uses chunk candidates and preserves exact radius filtering', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const snapshot = await world.exportSnapshot();
  const settlement = snapshot.entities.find((entity) => entity.kind === 'settlement' && entity.spatial);
  const radiusKm = 12;
  const projection = await world.queryArea({ center: settlement.spatial, radiusKm, requestedDetailRank: 2 });
  assert.ok(projection.aggregates.streaming.candidateEntityCount < projection.aggregates.streaming.totalEntityCount);
  const expected = snapshot.entities.filter((entity) => {
    if (!entity.spatial) return false;
    let dx = Math.abs(entity.spatial.x - settlement.spatial.x);
    let dy = Math.abs(entity.spatial.y - settlement.spatial.y);
    if (baseRecipe.geometry.wrapX) dx = Math.min(dx, baseRecipe.geometry.extent.widthKm - dx);
    if (baseRecipe.geometry.wrapY) dy = Math.min(dy, baseRecipe.geometry.extent.heightKm - dy);
    return Math.hypot(dx, dy, (entity.spatial.z ?? 0) - (settlement.spatial.z ?? 0)) <= radiusKm;
  }).map((entity) => entity.id).sort();
  assert.deepEqual(projection.entities.map((entity) => entity.id).sort(), expected);
});

test('selective spatial snapshot exports only local entities with closed local relations and causal ancestry', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const full = await world.exportSnapshot();
  const settlement = full.entities.find((entity) => entity.kind === 'settlement' && entity.spatial);
  const local = await world.exportAreaSnapshot({ center: settlement.spatial, radiusKm: 18, requestedDetailRank: 2 });
  assert.ok(local.entities.length > 0 && local.entities.length < full.entities.length);
  const ids = new Set(local.entities.map((entity) => entity.id));
  assert.ok(local.relations.every((relation) => ids.has(relation.sourceId) && ids.has(relation.targetId)));
  const causalIds = new Set(local.causalRecords.map((record) => record.id));
  assert.ok(local.causalRecords.every((record) => record.parentIds.every((id) => causalIds.has(id))));
  assert.ok(local.aggregates.spatialExport.sourceEntityCount === full.entities.length);
});


test('lore corpus QA reports provenance completeness, cultural concentration and semantic duplicate risk', async () => {
  const content = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const { buildLoreCorpus } = await import('../dist/index.js');
  const audit = auditLoreCorpus(buildLoreCorpus(content));
  assert.equal(audit.provenanceCompleteness, 1);
  assert.ok(audit.effectiveTraditionCount >= 8);
  assert.ok(audit.dominantTraditionShare < 0.35);
  assert.deepEqual(audit.unsupportedGeneralizationMotifIds, []);
  assert.ok(audit.sourceCount >= 20 && audit.motifCount >= 40);
  assert.deepEqual(audit.duplicateSemanticCandidates, []);
  assert.ok(audit.verifiedSourceCount >= 12);
  assert.ok(audit.verifiedPublicDomainSourceCount >= 12);
  assert.ok(audit.provisionalSourceIds.length > 0);
});


test('spherical geometry treats the longitudinal seam as adjacent and generates with seam-aware wrapping', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'spherical-seam-fixture';
  recipe.geometry.spaceModel = 'spherical';
  recipe.geometry.projectionId = 'fixture-equirectangular';
  recipe.geometry.extent.widthKm = 40075;
  recipe.geometry.extent.heightKm = 20037.5;
  recipe.geometry.wrapX = false;
  recipe.geometry.wrapY = false;
  recipe.modules.push({ id: 'seam-fixture', enabled: true, config: {} });
  recipe.generationPipeline.push({ id: 'fixture:seam', moduleId: 'seam-fixture', dependsOn: ['lod:index'] });
  const registry = createBuiltinRegistry();
  registry.register({
    id: 'seam-fixture', version: '1.0.0', capabilities: ['spherical-seam-fixture'],
    runPass(passId, _config, context) {
      if (passId !== 'fixture:seam') return;
      const regions = context.snapshot.entities.filter((entity) => entity.kind === 'region' && entity.spatial).slice(0, 2);
      regions[0].spatial.x = 1;
      regions[0].spatial.y = recipe.geometry.extent.heightKm / 2;
      regions[1].spatial.x = recipe.geometry.extent.widthKm - 1;
      regions[1].spatial.y = recipe.geometry.extent.heightKm / 2;
      regions[0].components.seamFixture = 'west';
      regions[1].components.seamFixture = 'east';
    },
  });
  const world = await new WorldgenEngine(registry).generate(recipe);
  const snapshot = await world.exportSnapshot();
  const west = snapshot.entities.find((entity) => entity.components.seamFixture === 'west');
  const east = snapshot.entities.find((entity) => entity.components.seamFixture === 'east');
  const projection = await world.queryArea({ center: west.spatial, radiusKm: 3, requestedDetailRank: 3, entityKinds: ['region'] });
  assert.ok(projection.entities.some((entity) => entity.id === east.id));
});

test('ecology exposes bounded renewable stocks and trophic/resource dependency graph', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const resources = snapshot.entities.filter((entity) => entity.kind === 'ecological-resource');
  const guilds = snapshot.entities.filter((entity) => entity.kind === 'ecological-guild');
  assert.ok(resources.length >= snapshot.entities.filter((entity) => entity.kind === 'region').length * 3);
  assert.ok(guilds.length >= snapshot.entities.filter((entity) => entity.kind === 'region').length * 3);
  assert.ok(resources.every((resource) => Number(resource.components.currentStock) >= 0 && Number(resource.components.currentStock) <= Number(resource.components.carryingStock)));
  assert.ok(resources.some((resource) => resource.components.renewable === true && Number(resource.components.regenerationPerDay) > 0));
  assert.ok(resources.some((resource) => resource.components.renewable === false && Number(resource.components.regenerationPerDay) === 0));
  const resourceDependencies = snapshot.relations.filter((relation) => relation.kind === 'guild-depends-on-resource');
  const trophicDependencies = snapshot.relations.filter((relation) => relation.kind === 'trophic-dependency');
  assert.ok(resourceDependencies.length > 0 && trophicDependencies.length > 0);
  assert.ok(snapshot.aggregates.ecology.ecologicalResourceCount === resources.length);
});

test('runtime production is constrained by labor and ecological stock while resource bounds remain valid', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'runtime-economy-ecology-fixture';
  const society = recipe.modules.find((module) => module.id === 'society');
  society.config.reserveDays = 2;
  society.config.productionRecipes = society.config.productionRecipes.map((productionRecipe) => ({
    ...productionRecipe,
    ecologicalInputs: productionRecipe.ecologicalInputs.map((input) => ({ ...input, extractionPerOutput: input.extractionPerOutput * 1500 })),
  }));
  const world = await new WorldgenEngine().generate(recipe);
  const before = await world.exportSnapshot();
  const settlement = before.entities.find((entity) => entity.kind === 'settlement' && entity.endedTick === undefined);
  const beforeStock = Object.values(settlement.components.economy.resources).reduce((sum, item) => sum + Number(item.stock ?? 0), 0);
  await world.advance({ toTick: before.manifest.currentTick + recipe.clock.ticksPerDay * 3 });
  const after = await world.exportSnapshot();
  const afterSettlement = after.entities.find((entity) => entity.id === settlement.id);
  const afterStock = Object.values(afterSettlement.components.economy.resources).reduce((sum, item) => sum + Number(item.stock ?? 0), 0);
  assert.notEqual(afterStock, beforeStock);
  assert.ok(typeof afterSettlement.components.economy.shortageIndex === 'number');
  assert.ok(Object.values(afterSettlement.components.economy.resources).every((item) => Number(item.actualProductionPerDay) <= Number(item.productionPerDay) + 1e-9));
  assert.ok(after.entities.filter((entity) => entity.kind === 'ecological-resource').every((resource) => Number(resource.components.currentStock) >= -1e-9 && Number(resource.components.currentStock) <= Number(resource.components.carryingStock) + 1e-9));
});

test('institutions have multi-era causal histories with split/merge topology represented as events and relations', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const institutions = snapshot.entities.filter((entity) => entity.kind === 'institution');
  assert.ok(institutions.length > 0);
  assert.ok(institutions.every((institution) => Array.isArray(institution.components.history) && institution.components.history.length >= 1));
  assert.ok(snapshot.events.some((event) => event.kind === 'institution-founded'));
  assert.ok(snapshot.events.some((event) => event.kind === 'institution-evolved'));
  const splits = snapshot.events.filter((event) => event.kind === 'institution-split');
  assert.ok(splits.length > 0);
  assert.equal(snapshot.relations.filter((relation) => relation.kind === 'split-from').length, splits.length);
  assert.ok(snapshot.aggregates.society.institutionHistoryEventCount > institutions.length);
});

test('LOD aggregate and sampled-detail audits preserve population exactly', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe);
  const snapshot = await world.exportSnapshot();
  assert.equal(snapshot.aggregates.lodIndex.conservation.populationError, 0);
  assert.equal(snapshot.aggregates.lodIndex.conservation.exact, true);
  const settlement = snapshot.entities.find((entity) => entity.kind === 'settlement' && entity.spatial && entity.endedTick === undefined);
  await world.queryArea({ center: settlement.spatial, radiusKm: 12, requestedDetailRank: 0 });
  const detailed = await world.exportSnapshot();
  const audit = detailed.aggregates.lodRuntimeAudit;
  assert.ok(audit.materializedIndividualCount > 0);
  for (const item of Object.values(audit.byCohort)) if (item.sampleCount > 0) assert.ok(Math.abs(item.conservationError) < 1e-7);
});

test('small-seed property sweep preserves determinism, population conservation and resource bounds', async () => {
  for (const seed of [11, 29, 47, 101]) {
    const recipe = clone(baseRecipe);
    recipe.id = `property-seed-${seed}`;
    recipe.seed = seed;
    recipe.geometry.continentCount = { mode: 'fixed', value: 2 };
    recipe.modules.find((module) => module.id === 'geography').config = { regionsPerContinent: 3, gridWidth: 18, gridHeight: 12 };
    recipe.modules.find((module) => module.id === 'population').config = { settlementsPerRegion: 1, basePopulation: 900, routeNeighbors: 1 };
    recipe.modules.find((module) => module.id === 'history').config = { epochs: 3, migrationChancePerEpoch: 0.15, settlementLifecycleChancePerEpoch: 0.1 };
    const engine = new WorldgenEngine();
    const a = await (await engine.generate(recipe)).exportSnapshot();
    const b = await (await engine.generate(recipe)).exportSnapshot();
    assert.equal(snapshotDigest(a), snapshotDigest(b));
    assert.equal(a.aggregates.history.populationAccountingError, 0);
    assert.equal(a.aggregates.lodIndex.conservation.populationError, 0);
    assert.ok(a.entities.filter((entity) => entity.kind === 'ecological-resource').every((resource) => Number(resource.components.currentStock) >= 0 && Number(resource.components.currentStock) <= Number(resource.components.carryingStock)));
    assert.deepEqual(validateSnapshotConformance(a), []);
  }
});

test('million-scale aggregate population does not require individual materialization', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'million-aggregate-fixture';
  recipe.seed = 909090;
  recipe.modules.find((module) => module.id === 'geography').config = { regionsPerContinent: 8, gridWidth: 28, gridHeight: 20 };
  recipe.modules.find((module) => module.id === 'population').config = { settlementsPerRegion: 2, basePopulation: 180000, routeNeighbors: 2 };
  recipe.modules.find((module) => module.id === 'history').config = { epochs: 2, migrationChancePerEpoch: 0.05, settlementLifecycleChancePerEpoch: 0.02 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot(3);
  const population = snapshot.entities.filter((entity) => entity.kind === 'population-cohort').reduce((sum, cohort) => sum + Number(cohort.components.count ?? 0), 0);
  assert.ok(population >= 1_000_000);
  assert.equal(snapshot.entities.some((entity) => entity.kind === 'individual'), false);
  assert.equal(snapshot.aggregates.lodIndex.conservation.populationError, 0);
});

test('route infrastructure and polities retain multi-phase historical trajectories', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const infrastructure = snapshot.entities.filter((entity) => entity.kind === 'infrastructure-work');
  const routes = snapshot.relations.filter((relation) => relation.kind === 'route-link');
  const polities = snapshot.entities.filter((entity) => entity.kind === 'polity');
  assert.ok(infrastructure.length === routes.length && infrastructure.length > 0);
  assert.ok(infrastructure.every((entity) => Array.isArray(entity.components.history) && entity.components.history.length >= 2));
  assert.ok(routes.every((route) => typeof route.data.conditionIndex === 'number'));
  assert.ok(snapshot.events.some((event) => event.kind === 'infrastructure-built'));
  assert.ok(snapshot.events.some((event) => event.kind === 'infrastructure-maintenance' || event.kind === 'infrastructure-degradation'));
  assert.ok(polities.every((polity) => Array.isArray(polity.components.history) && polity.components.history.length >= 2));
  assert.ok(snapshot.events.some((event) => event.kind === 'polity-formed'));
  assert.ok(snapshot.events.some((event) => event.kind === 'polity-reorganized'));
});

test('burn-in ecology records landscape succession and causal range shifts without setting-specific species assumptions', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  assert.ok(snapshot.aggregates.history.landscapeSuccessionEventCount > 0);
  assert.ok(snapshot.events.some((event) => event.kind === 'landscape-succession'));
  const shifts = snapshot.events.filter((event) => event.kind === 'ecological-range-shift');
  assert.equal(shifts.length, snapshot.aggregates.history.ecologicalRangeShiftCount);
  assert.ok(shifts.every((event) => event.causeIds.length > 0 && typeof event.data.sourceRegionId === 'string' && typeof event.data.targetRegionId === 'string'));
  assert.ok(snapshot.entities.filter((entity) => entity.kind === 'ecological-guild').every((guild) => typeof guild.components.guildKind === 'string' && !('speciesName' in guild.components)));
});

test('expanded research corpus clears production size gates with cross-source provenance', async () => {
  const content = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const { buildLoreCorpus } = await import('../dist/index.js');
  const corpus = buildLoreCorpus(content); const audit = auditLoreCorpus(corpus);
  assert.deepEqual(corpus.errors, []);
  assert.ok(corpus.sources.length >= 100);
  assert.ok(corpus.motifs.length >= 250);
  assert.ok(corpus.transformations.length >= 40);
  assert.ok(corpus.transmissionModes.length >= 8);
  assert.ok(corpus.motifs.every((motif) => motif.sourceIds.length >= 2));
  assert.equal(audit.provenanceCompleteness, 1);
  assert.ok(audit.effectiveTraditionCount >= 12);
});

test('physical substrate exposes plate geology, basin-resolved drainage, rain shadows and geomorphology', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'physical-substrate-v2-fixture';
  const geography = recipe.modules.find((module) => module.id === 'geography');
  geography.config = { ...geography.config, gridWidth: 36, gridHeight: 24, regionsPerContinent: 6, terrainStrategy: 'ridge-noise', plateCount: 7, climateModel: 'wind-rain-shadow', oceanModel: 'gyre', erosionStrength: 0.85 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const grid = snapshot.aggregates.geography.grid;
  assert.equal(grid.plate.length, grid.land.length);
  assert.equal(grid.basin.length, grid.land.length);
  assert.equal(grid.rainfall.length, grid.land.length);
  assert.ok(grid.plate.some((value) => value > 0));
  assert.ok(grid.erosion.some((value) => value > 0));
  assert.ok(grid.mineralPotential.some((value) => value > 0.2));
  assert.ok(grid.land.every((value, i) => value === 0 || grid.basin[i] !== -1));
  assert.ok(snapshot.entities.some((entity) => entity.kind === 'drainage-system'));
  assert.ok(snapshot.entities.filter((entity) => entity.kind === 'region').every((region) => typeof region.components.geology.mineralPotential === 'number' && Array.isArray(region.components.geology.strata) && region.components.geology.strata.length >= 3 && typeof region.components.hydrology.basinDiversity === 'number'));
});

test('runtime route trade conserves transferred stock, resolves unmet demand and produces endogenous prices', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe); const snapshot = world.snapshot;
  const route = snapshot.relations.find((relation) => relation.kind === 'route-link'); assert.ok(route);
  route.data.accessibility = 1; route.data.capacityIndex = 1; route.data.conditionIndex = 1;
  const a = snapshot.entities.find((entity) => entity.id === route.sourceId); const b = snapshot.entities.find((entity) => entity.id === route.targetId); assert.ok(a && b);
  const aResources = a.components.economy.resources; const bResources = b.components.economy.resources; const resourceId = Object.keys(aResources).find((id) => id in bResources); assert.ok(resourceId);
  const ai = aResources[resourceId]; const bi = bResources[resourceId];
  ai.productionPerDay = 0; ai.consumptionPerDay = 0; ai.stock = Math.max(100, Number(ai.targetStock ?? 1) * 3);
  bi.productionPerDay = 0; bi.consumptionPerDay = 10; bi.stock = 0; bi.targetStock = 100;
  const before = Number(ai.stock) + Number(bi.stock); const start = snapshot.manifest.currentTick;
  await world.advance({ toTick: start + baseRecipe.clock.ticksPerDay });
  const afterA = a.components.economy.resources[resourceId]; const afterB = b.components.economy.resources[resourceId];
  assert.ok(snapshot.events.some((event) => event.kind === 'runtime-logistics-flow' && event.data.resourceId === resourceId));
  assert.ok(Number(afterB.actualConsumptionPerDay ?? 0) > 0);
  assert.ok(Number(afterB.priceIndex) > 0);
  assert.ok(Number(afterA.priceIndex) > 0);
  assert.ok(Number(world.snapshot.aggregates.runtimeEconomy.tradeVolume) > 0);
  assert.ok(Number(world.snapshot.aggregates.runtimeEconomy.stockAfterRuntimeTrade) <= Number(world.snapshot.aggregates.runtimeEconomy.stockBeforeRuntimeTrade) + 1e-8); // transfers conserve stock; only late consumption can reduce it.
});

test('refine-act-coarsen-refine preserves agent plans, identity and relationship sufficient statistics', async () => {
  const world = await new WorldgenEngine().generate(baseRecipe); const coarse = await world.exportSnapshot();
  const settlement = coarse.entities.find((entity) => entity.kind === 'settlement' && entity.spatial && entity.endedTick === undefined);
  await world.queryArea({ center: settlement.spatial, radiusKm: 12, requestedDetailRank: 0 });
  const detailed = world.snapshot; const person = detailed.entities.find((entity) => entity.kind === 'individual' && entity.components.__lodMaterialized === true); assert.ok(person);
  const anchorId = person.components.identityAnchorId; person.components.vitalityIndex = 0.12345; person.components.plans = [{ kind: 'investigate-trace', priority: 0.91, progress: 0.42 }];
  const personId = person.id; const cohortId = person.components.cohortId;
  assert.ok(detailed.relations.some((relation) => (relation.sourceId === personId || relation.targetId === personId) && (relation.kind === 'household-tie' || relation.kind === 'kin-support')));
  assert.ok(world.collapseMaterializedDetail() > 0);
  const anchor = world.snapshot.entities.find((entity) => entity.id === anchorId); const cohort = world.snapshot.entities.find((entity) => entity.id === cohortId);
  assert.equal(anchor.components.lastCoarsenedState.vitalityIndex, 0.12345);
  assert.equal(anchor.components.lastCoarsenedState.plans[0].kind, 'investigate-trace');
  assert.ok(cohort.components.lodSufficientStatistics.relationshipKinds);
  await world.queryArea({ center: settlement.spatial, radiusKm: 12, requestedDetailRank: 0 });
  const restored = world.snapshot.entities.find((entity) => entity.id === personId); assert.ok(restored);
  assert.equal(restored.components.vitalityIndex, 0.12345);
  assert.equal(restored.components.plans[0].kind, 'investigate-trace');
});

test('world laws support vector effects and relation-carried range restriction', async () => {
  const { stableId } = await import('../dist/index.js');
  const recipe = clone(baseRecipe); recipe.id = 'vector-law-carrier-fixture';
  recipe.modules.push({ id: 'law-fixture-module', enabled: true, config: {} });
  recipe.generationPipeline.push({ id: 'fixture:law-state', moduleId: 'law-fixture-module', dependsOn: ['society:present'] });
  const registry = createBuiltinRegistry();
  registry.register({ id: 'law-fixture-module', version: '1.0.0', capabilities: ['fixture'], runPass(passId, _config, context) {
    if (passId !== 'fixture:law-state') return;
    for (const settlement of context.snapshot.entities.filter((entity) => entity.kind === 'settlement')) { settlement.components.testVector = [0, 0]; settlement.components.testScalar = 1; }
  }});
  const predictedFirstSettlement = stableId('ent','settlement',[stableId('ent','region',[stableId('ent','continent',0),0]),0]);
  const laws = recipe.modules.find((module) => module.id === 'world-laws');
  laws.config.rules = [{ id:'carrier-vector-law', hiddenTruth:true, carrier:{kind:'relation',relationKind:'route-link'}, range:{sourceEntityIds:[predictedFirstSettlement],maxHops:1}, effects:[{entityKind:'settlement',componentPath:'testVector',operation:'vector-add',value:[0.1,0.2]}] }];
  const world = await new WorldgenEngine(registry).generate(recipe); const before = await world.exportSnapshot();
  const reachable = new Set([predictedFirstSettlement]); for (const relation of before.relations.filter((relation) => relation.kind === 'route-link')) { if (relation.sourceId === predictedFirstSettlement) reachable.add(relation.targetId); if (relation.targetId === predictedFirstSettlement) reachable.add(relation.sourceId); }
  await world.advance({ toTick: before.manifest.currentTick + recipe.clock.ticksPerDay });
  const settlements = world.snapshot.entities.filter((entity) => entity.kind === 'settlement');
  assert.ok(settlements.some((entity) => Array.isArray(entity.components.testVector) && entity.components.testVector[0] > 0));
  for (const settlement of settlements) {
    const changed = Array.isArray(settlement.components.testVector) && settlement.components.testVector[0] > 0;
    assert.equal(changed, reachable.has(settlement.id));
  }
});

test('content-defined ecoregions and alternative resource chemistry require no kernel changes', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'non-earth-ecology-fixture'; recipe.seed = 515151;
  const ecology = recipe.modules.find((module) => module.id === 'ecology');
  ecology.config = {
    ...ecology.config,
    resourceKinds: ['chemosynthetic-feedstock', 'silicate-fluid', 'crystal-nutrient'],
    guildKinds: ['chemo-producer', 'radiotroph', 'mineral-decomposer'],
    ecoregionRules: [
      { id: 'high-radiance-shelf', conditions: { temperatureMin: 0.6 }, tags: ['radiant', 'mineral-rich'], modifiers: { productivityMultiplier: 0.9, resourceDiversityMultiplier: 1.1, hazardMultiplier: 1.15 } },
      { id: 'cold-chemosynthetic-basin', conditions: {}, tags: ['chemosynthetic', 'low-radiance'], modifiers: { productivityMultiplier: 1.05, resourceDiversityMultiplier: 1.05 } },
    ],
  };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const regions = snapshot.entities.filter((entity) => entity.kind === 'region');
  const resources = snapshot.entities.filter((entity) => entity.kind === 'ecological-resource');
  const guilds = snapshot.entities.filter((entity) => entity.kind === 'ecological-guild');
  assert.ok(regions.length > 0 && regions.every((region) => typeof region.components.ecology.ecoregionId === 'string'));
  assert.deepEqual(new Set(resources.map((resource) => resource.components.resourceKind)), new Set(['chemosynthetic-feedstock', 'silicate-fluid', 'crystal-nutrient']));
  assert.deepEqual(new Set(guilds.map((guild) => guild.components.guildKind)), new Set(['chemo-producer', 'radiotroph', 'mineral-decomposer']));
  assert.equal(snapshot.aggregates.ecology.classifiedRegionCount, regions.length);
  assert.equal(snapshot.aggregates.ecology.ecoregionRuleCount, 2);
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});

test('cartographic knowledge remains uncertain observer state and polity interfaces become belief-aware', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const maps = snapshot.entities.filter((entity) => entity.kind === 'cartographic-record');
  assert.ok(maps.length > 0);
  assert.equal(snapshot.aggregates.informationEcology.cartographicRecordCount, maps.length);
  assert.ok(snapshot.knowledge.some((record) => record.claim.interpretation === 'cartographic-estimate'));
  assert.ok(maps.every((map) => Number(map.components.uncertaintyRadiusKm) > 0 && Number(map.components.boundaryConfidence) > 0 && Number(map.components.boundaryConfidence) < 1));
  assert.ok(maps.some((map) => {
    const region = snapshot.entities.find((entity) => entity.id === map.components.subjectRegionId);
    const estimate = map.components.estimatedCenter;
    return region?.spatial && estimate && (estimate.x !== region.spatial.x || estimate.y !== region.spatial.y);
  }));
  const interfaces = snapshot.relations.filter((relation) => relation.kind === 'polity-interface');
  assert.ok(interfaces.length > 0);
  assert.ok(interfaces.every((relation) => typeof relation.data.epistemicAlignmentIndex === 'number' && typeof relation.data.knowledgeDisputePressure === 'number'));
  assert.equal(snapshot.aggregates.informationEcology.beliefAwareInterfaceCount, interfaces.length);
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});

test('content-pack migration chains are explicit, deterministic and reject missing compatibility paths', () => {
  const registry = new ContentPackRegistry();
  registry.register({ id: 'migration-fixture', version: '1.0.0', data: { motifs: ['a'], rightsPolicy: 'reference-only' } });
  registry.registerMigration({ packId: 'migration-fixture', fromVersion: '1.0.0', toVersion: '1.1.0', migrate(data) { return { ...data, motifs: [...data.motifs, 'b'], schemaStage: 1 }; } });
  registry.registerMigration({ packId: 'migration-fixture', fromVersion: '1.1.0', toVersion: '2.0.0', migrate(data) { return { ...data, schemaStage: 2, migrated: true }; } });
  registry.validateReferences([{ id: 'migration-fixture', version: '2.0.0' }]);
  const migrated = registry.require('migration-fixture', '2.0.0');
  assert.equal(migrated.version, '2.0.0');
  assert.deepEqual(migrated.data.motifs, ['a', 'b']);
  assert.equal(migrated.data.rightsPolicy, 'reference-only');
  assert.equal(migrated.data.schemaStage, 2);
  assert.throws(() => registry.require('migration-fixture', '3.0.0'), /no registered migration path/);
});

test('hidden observations can support multiple competing causal hypotheses without promoting any hypothesis to truth', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'hidden-hypothesis-fixture';
  const knowledge = recipe.modules.find((module) => module.id === 'knowledge'); knowledge.config.hiddenDiscoveryRate = 1;
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const hypotheses = snapshot.knowledge.filter((record) => record.claim.interpretation === 'competing-causal-hypothesis');
  assert.ok(hypotheses.length > 0);
  const grouped = new Map();
  for (const record of hypotheses) { const key = `${record.holderId}|${record.subjectIds[0]}|${record.claim.variable}`; if (!grouped.has(key)) grouped.set(key, new Set()); grouped.get(key).add(record.claim.causalFrameId); }
  assert.ok([...grouped.values()].some((frames) => frames.size >= 2));
  assert.ok(hypotheses.every((record) => typeof record.sourceKnowledgeId === 'string' && record.truthLinkIds.length > 0));
  assert.equal(snapshot.entities.some((entity) => entity.kind === 'world-law' && entity.components.causalFrameId), false);
});

test('multiple world laws interact through prior state while preserving explicit cost semantics', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'multi-law-interaction-fixture';
  recipe.modules.push({ id: 'multi-law-state-fixture', enabled: true, config: {} });
  recipe.generationPipeline.push({ id: 'fixture:multi-law-state', moduleId: 'multi-law-state-fixture', dependsOn: ['society:present'] });
  const registry = createBuiltinRegistry();
  registry.register({ id: 'multi-law-state-fixture', version: '1.0.0', capabilities: ['fixture'], runPass(passId, _config, context) {
    if (passId !== 'fixture:multi-law-state') return;
    for (const settlement of context.snapshot.entities.filter((entity) => entity.kind === 'settlement')) { settlement.components.lawA = 0.2; settlement.components.lawB = 0; }
  }});
  const laws = recipe.modules.find((module) => module.id === 'world-laws');
  laws.config.rules = [
    { id: 'law-a', hiddenTruth: true, effects: [{ entityKind: 'settlement', componentPath: 'lawA', operation: 'add', value: 0.6 }], cost: { componentPath: 'lawA', amount: 0.05 } },
    { id: 'law-b', hiddenTruth: true, interactions: [{ whenComponentPath: 'lawA', comparator: '>=', threshold: 0.5, multiplier: 3 }], effects: [{ entityKind: 'settlement', componentPath: 'lawB', operation: 'add', value: 0.1 }] },
  ];
  const world = await new WorldgenEngine(registry).generate(recipe); const start = world.snapshot.manifest.currentTick;
  await world.advance({ toTick: start + recipe.clock.ticksPerDay });
  const settlement = world.snapshot.entities.find((entity) => entity.kind === 'settlement');
  assert.ok(Math.abs(Number(settlement.components.lawA) - 0.75) < 1e-9);
  assert.ok(Math.abs(Number(settlement.components.lawB) - 0.3) < 1e-9);
  assert.ok(world.snapshot.events.some((event) => event.kind === 'world-law-effect:law-b' && Number(event.data.interactionScale) === 3));
  assert.ok(world.snapshot.causalRecords.some((record) => record.hiddenTruth && record.payload.ruleId === 'law-a'));
});

test('settlement morphology follows terrain-derived orientation and records expansion history', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot();
  const settlements = snapshot.entities.filter((entity) => entity.kind === 'settlement');
  assert.ok(settlements.length > 0);
  assert.ok(settlements.every((settlement) => typeof settlement.components.morphology.builtAreaKm2 === 'number' && typeof settlement.components.morphology.orientationRadians === 'number' && typeof settlement.components.morphology.terrainFollowingIndex === 'number'));
  assert.ok(settlements.some((settlement) => Array.isArray(settlement.components.morphology.expansionHistory) && settlement.components.morphology.expansionHistory.length > 1));
  assert.ok(settlements.every((settlement) => Number(settlement.components.morphology.builtAreaKm2) > 0));
});

test('aggregate household demography forms and dissolves households during burn-in without individual simulation', async () => {
  const snapshot = await (await new WorldgenEngine().generate(baseRecipe)).exportSnapshot(3);
  const cohorts = snapshot.entities.filter((entity) => entity.kind === 'population-cohort');
  assert.ok(cohorts.length > 0);
  assert.ok(cohorts.every((cohort) => Number(cohort.components.householdDemography.householdCount) >= 1 && Number(cohort.components.householdDemography.meanHouseholdSize) > 0));
  assert.ok(snapshot.events.some((event) => event.kind === 'household-demographic-transition'));
  assert.equal(snapshot.entities.some((entity) => entity.kind === 'individual'), false);
  assert.equal(snapshot.aggregates.history.populationAccountingError, 0);
});

test('information ecology supports testimony, institutional records and signals as fallible observer evidence', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'multi-source-information-fixture';
  const info = recipe.modules.find((module) => module.id === 'information-ecology');
  info.config = { ...info.config, sourceClasses: ['testimony','institutional-record','signal'], maxAuxiliarySources: 160 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const interpretations = new Set(snapshot.knowledge.map((record) => record.claim.interpretation));
  assert.ok(interpretations.has('testimony'));
  assert.ok(interpretations.has('institutional-record'));
  assert.ok(interpretations.has('signal-observation'));
  assert.ok(snapshot.aggregates.informationEcology.testimonyCount > 0);
  assert.ok(snapshot.aggregates.informationEcology.institutionalRecordCount > 0);
  assert.ok(snapshot.aggregates.informationEcology.signalCount > 0);
  assert.ok(snapshot.knowledge.filter((record) => ['testimony','institutional-record','signal-observation'].includes(record.claim.interpretation)).every((record) => record.truthLinkIds?.length > 0));
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});

test('retained burn-in history exactly reconstructs present settlement population across demography, migration and lifecycle shocks', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'history-reconstruction-fixture';
  const history = recipe.modules.find((module) => module.id === 'history');
  history.config = { ...history.config, migrationChancePerEpoch: 0.22, settlementLifecycleChancePerEpoch: 0.11 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const audit = reconstructPopulationFromHistory(snapshot);
  assert.equal(audit.exact, true);
  assert.equal(audit.totalAbsoluteError, 0);
  assert.deepEqual(audit.missingSeedSettlementIds, []);
  assert.ok(audit.appliedEventKinds.includes('macro-demographic-transition'));
  assert.ok(audit.appliedEventKinds.includes('macro-migration'));
  assert.ok(audit.appliedEventKinds.some((kind) => kind === 'settlement-founded' || kind === 'settlement-merged' || kind === 'settlement-abandoned'));
});

test('custom anisotropic Manhattan geometry drives exact area-query membership without planar assumptions', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'custom-anisotropic-space-fixture';
  recipe.geometry.spaceModel = 'custom'; recipe.geometry.wrapX = false; recipe.geometry.wrapY = false;
  recipe.geometry.config = { ...recipe.geometry.config, distanceMetric: 'manhattan', xDistanceScale: 4, yDistanceScale: 0.5, zDistanceScale: 2 };
  const world = await new WorldgenEngine().generate(recipe);
  const snapshot = await world.exportSnapshot();
  const centerEntity = snapshot.entities.find((entity) => entity.kind === 'settlement' && entity.spatial);
  assert.ok(centerEntity?.spatial);
  const center = centerEntity.spatial; const radiusKm = 180;
  const kinds = new Set(['region', 'settlement']);
  const expected = snapshot.entities.filter((entity) => entity.spatial && kinds.has(entity.kind)).filter((entity) => {
    const dx = Math.abs(entity.spatial.x - center.x) * 4;
    const dy = Math.abs(entity.spatial.y - center.y) * 0.5;
    const dz = Math.abs((entity.spatial.z ?? 0) - (center.z ?? 0)) * 2;
    return dx + dy + dz <= radiusKm;
  }).map((entity) => entity.id).sort();
  const projection = await world.queryArea({ center, radiusKm, requestedDetailRank: 3, entityKinds: [...kinds] });
  assert.deepEqual(projection.entities.map((entity) => entity.id).sort(), expected);
  assert.equal(projection.aggregates.streaming.candidateEntityCount, snapshot.entities.filter((entity) => entity.spatial).length);
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});


test('public terrain strategy registry accepts setting-provided algorithms without geography kernel edits', async () => {
  const id = 'fixture-uplift-strategy-v1';
  if (!terrainStrategyRegistry.list().some((strategy) => strategy.id === id)) terrainStrategyRegistry.register({ id, evaluate: ({ baseField, noise }) => baseField + 0.22 + (noise('fixture-uplift', 2) - 0.5) * 0.05 });
  const recipe = clone(baseRecipe); recipe.id = 'terrain-plugin-registry-fixture'; recipe.seed = 77123;
  recipe.modules.find((module) => module.id === 'geography').config = { ...recipe.modules.find((module) => module.id === 'geography').config, terrainStrategy: id, gridWidth: 42, gridHeight: 28 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  assert.equal(snapshot.aggregates.geography.terrainStrategy, id);
  assert.ok(snapshot.aggregates.geography.grid.landFraction > 0);
  assert.ok(terrainStrategyRegistry.list().some((strategy) => strategy.id === id));
});

test('ecological guilds can become extinct and reinvade through connected regions', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'ecology-invasion-extinction-fixture';
  const ecology = recipe.modules.find((module) => module.id === 'ecology');
  ecology.config = { ...ecology.config, invasionChancePerDay: 1, invasionSourceFraction: 0.01, invasionColonizationFraction: 0.04, extinctionThresholdFraction: 0.001 };
  const world = await new WorldgenEngine().generate(recipe); const snapshot = world.snapshot;
  const settlements = new Map(snapshot.entities.filter((entity) => entity.kind === 'settlement').map((entity) => [entity.id, entity]));
  let pair = null;
  for (const route of snapshot.relations.filter((relation) => relation.kind === 'route-link')) {
    const a = settlements.get(route.sourceId); const b = settlements.get(route.targetId); if (!a || !b || a.components.regionId === b.components.regionId) continue;
    const source = snapshot.entities.find((entity) => entity.kind === 'ecological-guild' && entity.components.regionId === a.components.regionId);
    const target = source && snapshot.entities.find((entity) => entity.kind === 'ecological-guild' && entity.components.regionId === b.components.regionId && entity.components.guildKind === source.components.guildKind);
    if (source && target) { pair = { source, target }; break; }
  }
  assert.ok(pair);
  pair.source.components.abundance = Number(pair.source.components.abundanceCapacity) * 0.8;
  pair.target.components.abundance = 0; pair.target.components.status = 'extinct'; pair.target.components.extinctTick = snapshot.manifest.currentTick;
  for (const relation of snapshot.relations.filter((relation) => relation.sourceId === pair.target.id && relation.kind === 'guild-depends-on-resource')) {
    const resource = snapshot.entities.find((entity) => entity.id === relation.targetId); if (resource) resource.components.currentStock = resource.components.carryingStock;
  }
  const before = snapshot.manifest.currentTick; await world.advance({ toTick: before + recipe.clock.ticksPerDay });
  assert.ok(Number(pair.target.components.abundance) > 0);
  assert.equal(pair.target.components.status, 'present');
  assert.ok(snapshot.events.some((event) => event.kind === 'ecological-guild-invasion' && event.targetIds.includes(pair.target.id)));
});

test('plugin-defined world-law effect operators can transform structured component state deterministically', async () => {
  const operatorId = 'fixture-structured-counter-v1';
  if (!worldLawEffectOperatorRegistry.list().some((operator) => operator.id === operatorId)) worldLawEffectOperatorRegistry.register({
    id: operatorId,
    apply: ({ currentValue, effect, interactionScale }) => ({ ...currentValue, count: Number(currentValue.count ?? 0) + Number(effect.increment ?? 1) * interactionScale }),
  });
  const recipe = clone(baseRecipe); recipe.id = 'structured-law-effect-fixture';
  const laws = recipe.modules.find((module) => module.id === 'world-laws');
  laws.config = { ...laws.config, rules: [...(Array.isArray(laws.config.rules) ? laws.config.rules : []), { id:'structured-plugin-law', kind:'transition', effects:[{ entityKind:'settlement', componentPath:'pluginStructuredState', operation:operatorId, increment:2 }] }] };
  const world = await new WorldgenEngine().generate(recipe); const snapshot = world.snapshot;
  const settlements = snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined);
  for (const settlement of settlements) settlement.components.pluginStructuredState = { count: 1, label: 'preserved' };
  await world.advance({ toTick: snapshot.manifest.currentTick + recipe.clock.ticksPerDay });
  assert.ok(settlements.every((settlement) => settlement.components.pluginStructuredState.count === 3));
  assert.ok(settlements.every((settlement) => settlement.components.pluginStructuredState.label === 'preserved'));
});

test('runtime information channels propagate rumor and revise contradictory cartographic observations without changing canonical geometry', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'runtime-information-revision-fixture';
  const info = recipe.modules.find((module) => module.id === 'information-ecology');
  info.config = { ...info.config, runtimeTransmissionBudgetPerDay: 4, runtimeMapRevisionBudgetPerDay: 4 };
  const world = await new WorldgenEngine().generate(recipe); const snapshot = world.snapshot;
  const channels = snapshot.relations.filter((relation) => relation.kind === 'information-channel').sort((a,b)=>a.id.localeCompare(b.id)); assert.ok(channels.length);
  const channel = channels[0]; for (const c of channels) c.data = { ...(c.data ?? {}), lossRate: c.id === channel.id ? 0 : 1, censorshipRate: c.id === channel.id ? 0 : 1, distortionRate: 0, reliabilityIndex: 1, delayTicks: 1 };
  const sourceSettlement = snapshot.entities.find((entity) => entity.id === channel.sourceId); const targetSettlement = snapshot.entities.find((entity) => entity.id === channel.targetId); assert.ok(sourceSettlement && targetSettlement);
  const regionId = String(sourceSettlement.components.regionId); const region = snapshot.entities.find((entity) => entity.id === regionId); assert.ok(region?.spatial);
  snapshot.knowledge = snapshot.knowledge.filter((record) => record.holderId !== channel.sourceId && record.holderId !== channel.targetId);
  snapshot.knowledge.push({ id:'fixture-source-map', holderId:channel.sourceId, subjectIds:[regionId], acquiredTick:snapshot.manifest.currentTick, confidence:0.9, claim:{ interpretation:'cartographic-estimate', regionId, estimatedCenter:{ x:region.spatial.x+10, y:region.spatial.y }, uncertaintyRadiusKm:18 } });
  snapshot.knowledge.push({ id:'fixture-target-map', holderId:channel.targetId, subjectIds:[regionId], acquiredTick:snapshot.manifest.currentTick, confidence:0.5, claim:{ interpretation:'cartographic-estimate', regionId, estimatedCenter:{ x:region.spatial.x-20, y:region.spatial.y }, uncertaintyRadiusKm:30 } });
  const canonical = { x:region.spatial.x, y:region.spatial.y };
  await world.advance({ toTick:snapshot.manifest.currentTick + recipe.clock.ticksPerDay });
  assert.ok(snapshot.knowledge.some((record) => record.holderId === channel.targetId && record.sourceKnowledgeId === 'fixture-source-map'));
  const revision = snapshot.knowledge.find((record) => record.holderId === channel.targetId && Array.isArray(record.claim.revisionOf)); assert.ok(revision);
  assert.deepEqual({ x:region.spatial.x, y:region.spatial.y }, canonical);
  assert.ok(snapshot.events.some((event) => event.kind === 'runtime-information-transmission'));
});


test('retained history reconstructs ecological resource, infrastructure and polity material state exactly', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'multi-class-history-reconstruction-fixture';
  const history = recipe.modules.find((module) => module.id === 'history'); history.config = { ...history.config, resourceShockChancePerEcologyEpoch: 0.75, epochs: 18 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const diagnostic = reconstructMaterialSystemsFromHistory(snapshot);
  assert.equal(diagnostic.exact, true);
  assert.equal(diagnostic.resourceStockError, 0);
  assert.equal(diagnostic.infrastructureConditionError, 0);
  assert.equal(diagnostic.polityStateError, 0);
  assert.ok(diagnostic.appliedEventKinds.some((kind) => kind.startsWith('ecological-resource-')));
  assert.ok(diagnostic.appliedEventKinds.includes('infrastructure-built'));
  assert.ok(diagnostic.appliedEventKinds.includes('polity-formed'));
});

test('long-run refine-coarsen economy and demography property matrix preserves bounds across seeds', async () => {
  for (const seed of [1201, 1202, 1203]) {
    const recipe = clone(baseRecipe); recipe.id = `long-run-lod-economy-${seed}`; recipe.seed = seed;
    recipe.modules.find((module) => module.id === 'geography').config = { ...recipe.modules.find((module) => module.id === 'geography').config, regionsPerContinent: 4, gridWidth: 38, gridHeight: 24 };
    recipe.modules.find((module) => module.id === 'population').config = { ...recipe.modules.find((module) => module.id === 'population').config, settlementsPerRegion: 2, basePopulation: 1800 };
    const world = await new WorldgenEngine().generate(recipe); const day = recipe.clock.ticksPerDay;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const settlement = world.snapshot.entities.find((entity) => entity.kind === 'settlement' && entity.spatial && entity.endedTick === undefined); assert.ok(settlement);
      await world.queryArea({ center:settlement.spatial, radiusKm:12, requestedDetailRank:0 });
      world.collapseMaterializedDetail();
      await world.advance({ toTick:world.snapshot.manifest.currentTick + day * 5 });
      const settlementTotal = world.snapshot.entities.filter((entity) => entity.kind === 'settlement').reduce((sum, entity) => sum + Math.max(0, Number(entity.components.population ?? 0)), 0);
      const cohortTotal = world.snapshot.entities.filter((entity) => entity.kind === 'population-cohort').reduce((sum, entity) => sum + Math.max(0, Number(entity.components.count ?? 0)), 0);
      assert.equal(cohortTotal, settlementTotal);
      for (const resource of world.snapshot.entities.filter((entity) => entity.kind === 'ecological-resource')) {
        assert.ok(Number(resource.components.currentStock) >= -1e-9); assert.ok(Number(resource.components.currentStock) <= Number(resource.components.carryingStock) + 1e-9);
      }
      for (const active of world.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined)) {
        assert.ok(Number(active.components.population) >= 0);
        const resources = active.components.economy?.resources ?? {};
        for (const item of Object.values(resources)) assert.ok(Number(item.stock ?? 0) >= -1e-9);
      }
    }
  }
});


test('plugin-defined LOD coarsening policy preserves custom detail state across re-refinement', async () => {
  const policyId = 'fixture-custom-lod-memory';
  lodCoarseningPolicyRegistry.unregister(policyId);
  lodCoarseningPolicyRegistry.register({
    id: policyId,
    summarize: ({ person }) => ({ craftSkill: Number(person.components.craftSkill ?? 0), privateMark: String(person.components.privateMark ?? '') }),
    restore: ({ summary }) => {
      const record = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
      return { craftSkill: Number(record.craftSkill ?? 0), privateMark: String(record.privateMark ?? '') };
    },
  });
  try {
    const recipe = clone(baseRecipe);
    recipe.id = 'custom-lod-policy-fixture';
    const lod = recipe.modules.find((module) => module.id === 'lod');
    lod.config = { ...(lod.config ?? {}), materializationSampleCap: 4, coarseningPolicyIds: [policyId] };
    const world = await new WorldgenEngine().generate(recipe);
    const coarse = await world.exportSnapshot();
    const settlement = coarse.entities.find((entity) => entity.kind === 'settlement' && entity.spatial);
    const query = { center: settlement.spatial, radiusKm: 12, requestedDetailRank: 0 };
    const detail = await world.queryArea(query);
    const person = detail.entities.find((entity) => entity.kind === 'individual');
    assert.ok(person);
    const live = world.snapshot.entities.find((entity) => entity.id === person.id);
    live.components.craftSkill = 0.873;
    live.components.privateMark = 'retained-through-custom-policy';
    assert.ok(world.collapseMaterializedDetail() > 0);
    const refined = await world.queryArea(query);
    const restored = refined.entities.find((entity) => entity.id === person.id);
    assert.ok(restored);
    assert.equal(restored.components.craftSkill, 0.873);
    assert.equal(restored.components.privateMark, 'retained-through-custom-policy');
  } finally {
    lodCoarseningPolicyRegistry.unregister(policyId);
  }
});


test('custom geometry topology plugins can define non-metric adjacency used by spatial queries', async () => {
  const topologyId = 'fixture-portal-seam';
  geometryTopologyRegistry.unregister(topologyId);
  geometryTopologyRegistry.register({
    id: topologyId,
    distanceKm: ({ a, b, geometry }) => {
      const rawX = Math.abs(a.x - b.x);
      const portalX = Math.min(rawX, Math.max(0, geometry.extent.widthKm - rawX));
      return Math.hypot(portalX, Math.abs(a.y - b.y), (a.z ?? 0) - (b.z ?? 0));
    },
  });
  try {
    const recipe = clone(baseRecipe); recipe.id = 'custom-topology-plugin-fixture';
    recipe.geometry.spaceModel = 'custom'; recipe.geometry.wrapX = false;
    recipe.geometry.config = { ...(recipe.geometry.config ?? {}), topologyId, gridWidth: 30, gridHeight: 20 };
    const world = await new WorldgenEngine().generate(recipe);
    const settlements = world.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.spatial).slice(0, 2);
    assert.equal(settlements.length, 2);
    settlements[0].spatial.x = 1; settlements[0].spatial.y = 100;
    settlements[1].spatial.x = recipe.geometry.extent.widthKm - 1; settlements[1].spatial.y = 100;
    const projection = await world.queryArea({ center: { frameId: recipe.geometry.projectionId, x: 1, y: 100 }, radiusKm: 4, requestedDetailRank: 2, entityKinds: ['settlement'] });
    assert.ok(projection.entities.some((entity) => entity.id === settlements[1].id));
  } finally { geometryTopologyRegistry.unregister(topologyId); }
});

test('runtime geomorphic feedback evolves erosion, sediment and surface state from physical forcing', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'runtime-geomorphology-fixture';
  const geography = recipe.modules.find((module) => module.id === 'geography');
  geography.config = { ...geography.config, runtimeGeomorphologyIntervalDays: 1, runtimeErosionRate: 0.002, runtimeSedimentationRate: 0.8 };
  const world = await new WorldgenEngine().generate(recipe);
  const region = world.snapshot.entities.find((entity) => entity.kind === 'region'); assert.ok(region);
  const before = { erosion: Number(region.components.geology.erosionIndex), sediment: Number(region.components.geology.sedimentIndex), elevation: Number(region.components.terrain.elevationIndex) };
  await world.advance({ toTick: world.snapshot.manifest.currentTick + recipe.clock.ticksPerDay * 5 });
  assert.ok(Number(region.components.geology.erosionIndex) >= before.erosion);
  assert.ok(Number(region.components.geology.sedimentIndex) >= before.sediment);
  assert.ok(Number(region.components.terrain.elevationIndex) !== before.elevation);
  assert.ok(world.snapshot.events.some((event) => event.kind === 'geomorphic-feedback' && event.targetIds.includes(region.id)));
  assert.ok(Number(region.components.geology.erosionIndex) >= 0 && Number(region.components.geology.erosionIndex) <= 1);
  assert.ok(Number(region.components.geology.sedimentIndex) >= 0 && Number(region.components.geology.sedimentIndex) <= 1);
});

test('content-selected demography policy plugins alter fertility, health and household dependency without kernel-specific population kinds', async () => {
  const policyId = 'fixture-resource-sensitive-demography';
  demographyPolicyRegistry.unregister(policyId);
  demographyPolicyRegistry.register({
    id: policyId,
    evaluate: ({ shortageIndex, policyConfig }) => ({
      birthRatePerDay: Number(policyConfig.baseBirthRate ?? 0.0012) * Math.max(0, 1 - shortageIndex),
      deathRatePerDay: Number(policyConfig.baseDeathRate ?? 0.0002) + shortageIndex * 0.0008,
      healthDelta: -shortageIndex * 0.002,
      dependencySupportDelta: 0.001 - shortageIndex * 0.002,
      householdFormationMultiplier: 1 - shortageIndex * 0.25,
      householdDissolutionMultiplier: 1 + shortageIndex * 0.25,
    }),
  });
  try {
    const recipe = clone(baseRecipe); recipe.id = 'demography-policy-plugin-fixture';
    const population = recipe.modules.find((module) => module.id === 'population');
    population.config = { ...population.config, demographyPolicyIds: [policyId], demographyPolicyConfigs: { [policyId]: { baseBirthRate: 0.0014, baseDeathRate: 0.00025 } } };
    const world = await new WorldgenEngine().generate(recipe);
    const cohort = world.snapshot.entities.find((entity) => entity.kind === 'population-cohort'); assert.ok(cohort);
    const settlement = world.snapshot.entities.find((entity) => entity.id === cohort.components.settlementId); assert.ok(settlement);
    const beforeHealth = Number(cohort.components.healthIndex); const beforeSupport = Number(cohort.components.householdDemography.dependencySupportIndex);
    await world.advance({ toTick: world.snapshot.manifest.currentTick + recipe.clock.ticksPerDay });
    const policyEvent = world.snapshot.events.find((event) => event.kind === 'demography-policy-transition' && event.actorIds.includes(settlement.id));
    assert.ok(policyEvent); assert.equal(policyEvent.data.policyIds[0], policyId);
    assert.equal(Number(cohort.components.count), Number(settlement.components.population));
    assert.ok(Number(cohort.components.healthIndex) <= beforeHealth + 1e-12);
    assert.ok(Number(cohort.components.householdDemography.dependencySupportIndex) !== beforeSupport);
    assert.ok(Number(cohort.components.householdDemography.effectiveFormationRateAnnual) >= 0);
  } finally { demographyPolicyRegistry.unregister(policyId); }
});

test('multi-seed trophic collapse and recovery sweep keeps guild/resource state bounded and causally coupled', async () => {
  for (const seed of [6201, 6202, 6203]) {
    const recipe = clone(baseRecipe); recipe.id = `trophic-recovery-${seed}`; recipe.seed = seed;
    const geography = recipe.modules.find((module) => module.id === 'geography'); geography.config = { ...geography.config, regionsPerContinent: 4, gridWidth: 32, gridHeight: 20 };
    const population = recipe.modules.find((module) => module.id === 'population'); population.config = { ...population.config, settlementsPerRegion: 2, basePopulation: 1800 };
    const ecology = recipe.modules.find((module) => module.id === 'ecology'); ecology.config = { ...ecology.config, invasionChancePerDay: 1, invasionSourceFraction: 0.01, invasionColonizationFraction: 0.03, extinctionThresholdFraction: 0.001 };
    const world = await new WorldgenEngine().generate(recipe); const snapshot = world.snapshot;
    const resources = snapshot.entities.filter((entity) => entity.kind === 'ecological-resource'); const guilds = snapshot.entities.filter((entity) => entity.kind === 'ecological-guild');
    assert.ok(resources.length > 0 && guilds.length > 0);
    const initialMean = resources.reduce((sum, resource) => sum + Number(resource.components.currentStock) / Math.max(1, Number(resource.components.carryingStock)), 0) / resources.length;
    for (const resource of resources) resource.components.currentStock = Number(resource.components.carryingStock) * 0.01;
    for (const region of snapshot.entities.filter((entity) => entity.kind === 'region')) entitySet(region.components.environment ??= {}, 'disturbanceIndex', 1);
    await world.advance({ toTick: snapshot.manifest.currentTick + recipe.clock.ticksPerDay * 8 });
    const shockedMean = resources.reduce((sum, resource) => sum + Number(resource.components.currentStock) / Math.max(1, Number(resource.components.carryingStock)), 0) / resources.length;
    for (const region of snapshot.entities.filter((entity) => entity.kind === 'region')) entitySet(region.components.environment ??= {}, 'disturbanceIndex', 0);
    await world.advance({ toTick: snapshot.manifest.currentTick + recipe.clock.ticksPerDay * 72 });
    const recoveredMean = resources.reduce((sum, resource) => sum + Number(resource.components.currentStock) / Math.max(1, Number(resource.components.carryingStock)), 0) / resources.length;
    assert.ok(recoveredMean > shockedMean);
    assert.ok(initialMean >= 0 && initialMean <= 1);
    assert.ok(resources.every((resource) => Number(resource.components.currentStock) >= -1e-9 && Number(resource.components.currentStock) <= Number(resource.components.carryingStock) + 1e-9));
    assert.ok(guilds.every((guild) => Number(guild.components.abundance) >= -1e-9 && Number(guild.components.abundance) <= Number(guild.components.abundanceCapacity) + 1e-9));
    assert.ok(guilds.every((guild) => Number(guild.components.resourceSupplyIndex) >= 0 && Number(guild.components.resourceSupplyIndex) <= 1 && Number(guild.components.trophicSupplyIndex) >= 0 && Number(guild.components.trophicSupplyIndex) <= 1 && Number(guild.components.combinedSupplyIndex) >= 0 && Number(guild.components.combinedSupplyIndex) <= 1));
    assert.deepEqual(validateSnapshotConformance(await world.exportSnapshot()), []);
  }
});

function entitySet(target, key, value) { target[key] = value; }

test('archaeological evidence supports competing observer hypotheses while canonical origin history remains unchanged', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'contested-archaeology-fixture';
  const info = recipe.modules.find((module) => module.id === 'information-ecology'); info.config = { ...info.config, traceObservationChance: 1, contestedArchaeologyChance: 1, maxTransmissions: 0 };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const hypotheses = snapshot.knowledge.filter((record) => record.claim.interpretation === 'contested-archaeological-hypothesis');
  assert.ok(hypotheses.length > 0);
  for (const hypothesis of hypotheses.slice(0, 20)) {
    const source = snapshot.knowledge.find((record) => record.id === hypothesis.sourceKnowledgeId); assert.ok(source);
    const traceId = String(hypothesis.claim.historicalTraceId); const trace = snapshot.entities.find((entity) => entity.id === traceId); assert.ok(trace);
    const originEvent = snapshot.events.find((event) => event.id === trace.components.originEventId); assert.ok(originEvent);
    assert.notEqual(hypothesis.claim.assertedOriginClass, originEvent.kind);
    assert.equal(source.claim.assertedOriginClass, originEvent.kind);
  }
  assert.ok(Number(snapshot.aggregates.informationEcology.contestedArchaeologyHypothesisCount) === hypotheses.length);
});

test('runtime rumor graph responds to changing censorship and authority regimes without mutating source knowledge', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'runtime-regime-rumor-graph';
  const info = recipe.modules.find((module) => module.id === 'information-ecology'); info.config = { ...info.config, runtimeTransmissionBudgetPerDay: 64, runtimeMapRevisionBudgetPerDay: 0 };
  const world = await new WorldgenEngine().generate(recipe); const snapshot = world.snapshot;
  for (const relation of snapshot.relations.filter((relation) => relation.kind === 'information-channel')) relation.data = { ...(relation.data ?? {}), lossRate: 1, censorshipRate: 1 };
  const settlements = snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined).slice(0, 5); assert.equal(settlements.length, 5);
  const custom = [];
  for (let i = 0; i < settlements.length - 1; i += 1) {
    custom.push({ id:`fixture-regime-channel-${i}`, kind:'information-channel', sourceId:settlements[i].id, targetId:settlements[i+1].id, provenanceIds:[], data:{ delayTicks:1, lossRate:0, censorshipRate:0, distortionRate:0, reliabilityIndex:1, targetAuthorityIndex:1 } });
  }
  snapshot.relations.push(...custom);
  const k1 = { id:'fixture-regime-source-open', holderId:settlements[0].id, subjectIds:[settlements[0].id], acquiredTick:snapshot.manifest.currentTick, confidence:1, claim:{ interpretation:'fixture-open-regime', payload:'unchanged' } };
  snapshot.knowledge.push(k1);
  await world.advance({ toTick:snapshot.manifest.currentTick + recipe.clock.ticksPerDay });
  assert.ok(settlements.slice(1).every((settlement) => snapshot.knowledge.some((record) => record.holderId === settlement.id && (record.sourceKnowledgeId === k1.id || record.claim.payload === 'unchanged'))));
  const sourceAfter = snapshot.knowledge.find((record) => record.id === k1.id); assert.equal(sourceAfter.claim.payload, 'unchanged'); assert.equal(sourceAfter.confidence, 1);
  const regimeStart = snapshot.manifest.currentTick + 1;
  for (const channel of custom) channel.data.runtimeRegime = { startTick:regimeStart, endTick:regimeStart + recipe.clock.ticksPerDay * 3, censorshipRateDelta:1, reliabilityMultiplier:0.1, authorityMultiplier:0.1 };
  const k2 = { id:'fixture-regime-source-closed', holderId:settlements[0].id, subjectIds:[settlements[0].id], acquiredTick:snapshot.manifest.currentTick, confidence:1, claim:{ interpretation:'fixture-closed-regime' } };
  snapshot.knowledge.push(k2);
  await world.advance({ toTick:snapshot.manifest.currentTick + recipe.clock.ticksPerDay });
  assert.equal(snapshot.knowledge.some((record) => settlements.slice(1).some((settlement) => settlement.id === record.holderId) && record.sourceKnowledgeId === k2.id), false);
});

test('world-law carrier/effect/failure fuzz matrix remains deterministic and bounded across seeds', async () => {
  for (const seed of [7301, 7302, 7303]) {
    const recipe = clone(baseRecipe); recipe.id = `world-law-fuzz-${seed}`; recipe.seed = seed;
    const laws = recipe.modules.find((module) => module.id === 'world-laws');
    laws.config = { ...laws.config, rules: [
      { id:'fuzz-add', kind:'transition', failure:{chancePerDay:0.25}, effects:[{entityKind:'settlement',componentPath:'fuzz.scalar',operation:'add',perDay:0.07,min:-1,max:1}] },
      { id:'fuzz-approach', kind:'transition', interactions:[{whenComponentPath:'fuzz.scalar',comparator:'>=',threshold:0,multiplier:0.5}], effects:[{entityKind:'settlement',componentPath:'fuzz.approach',operation:'approach',toward:1,rate:0.2,min:0,max:1}] },
      { id:'fuzz-vector', kind:'transition', effects:[{entityKind:'settlement',componentPath:'fuzz.vector',operation:'vector-add',value:[0.01,-0.02]}] },
    ] };
    const world = await new WorldgenEngine().generate(recipe); const settlements = world.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined);
    for (const settlement of settlements) settlement.components.fuzz = { scalar:0, approach:0.25, vector:[0,0] };
    const before = snapshotDigest(await world.exportSnapshot());
    await world.advance({ toTick:world.snapshot.manifest.currentTick + recipe.clock.ticksPerDay * 15 });
    for (const settlement of settlements) {
      assert.ok(Number(settlement.components.fuzz.scalar) >= -1 && Number(settlement.components.fuzz.scalar) <= 1);
      assert.ok(Number(settlement.components.fuzz.approach) >= 0 && Number(settlement.components.fuzz.approach) <= 1);
      assert.equal(settlement.components.fuzz.vector.length, 2);
    }
    assert.ok(world.snapshot.events.some((event) => event.kind.startsWith('world-law-effect:')));
    assert.ok(world.snapshot.events.some((event) => event.kind.startsWith('world-law-failure:')));
    const replay = await new WorldgenEngine().generate(recipe); const replaySettlements = replay.snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined); for (const settlement of replaySettlements) settlement.components.fuzz = { scalar:0, approach:0.25, vector:[0,0] }; await replay.advance({ toTick:replay.snapshot.manifest.currentTick + recipe.clock.ticksPerDay * 15 });
    assert.equal(snapshotDigest(await replay.exportSnapshot()), snapshotDigest(await world.exportSnapshot()));
    assert.notEqual(before, snapshotDigest(await world.exportSnapshot()));
  }
});

test('optional economic institutions represent markets, contracts, ownership ledgers and trade credit as explicit entities', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'economic-institution-semantics-fixture';
  const society = recipe.modules.find((module) => module.id === 'society');
  society.config = { ...society.config, tradeThreshold:0, economicInstitutions:{ enabled:true, debtEnabled:true, annualInterestRate:0.035, contractKinds:['spot-exchange','forward-supply'] } };
  const snapshot = await (await new WorldgenEngine().generate(recipe)).exportSnapshot();
  const markets = snapshot.entities.filter((entity) => entity.kind === 'market-institution');
  const accounts = snapshot.entities.filter((entity) => entity.kind === 'economic-account');
  const contracts = snapshot.entities.filter((entity) => entity.kind === 'trade-contract');
  const obligations = snapshot.entities.filter((entity) => entity.kind === 'economic-obligation');
  assert.ok(markets.length > 0 && accounts.length === markets.length && contracts.length > 0);
  assert.equal(snapshot.aggregates.society.marketInstitutionCount, markets.length);
  assert.equal(snapshot.aggregates.society.tradeContractCount, contracts.length);
  assert.equal(snapshot.aggregates.society.debtObligationCount, obligations.length);
  assert.ok(accounts.every((account) => account.components.ownershipLedger && typeof account.components.ownershipLedger === 'object'));
  assert.ok(contracts.every((contract) => snapshot.relations.filter((relation) => relation.kind === 'contract-party' && relation.sourceId === contract.id).length === 2));
  assert.ok(obligations.every((obligation) => Number(obligation.components.principal) >= 0 && snapshot.relations.some((relation) => relation.kind === 'obligation-creditor' && relation.sourceId === obligation.id) && snapshot.relations.some((relation) => relation.kind === 'obligation-debtor' && relation.sourceId === obligation.id)));
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});

test('cartographic knowledge revises iteratively across repeated contradictory observations with explicit lineage', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'iterative-cartography-revision-fixture';
  const info = recipe.modules.find((module) => module.id === 'information-ecology'); info.config = { ...info.config, runtimeTransmissionBudgetPerDay:8, runtimeMapRevisionBudgetPerDay:8 };
  const world = await new WorldgenEngine().generate(recipe); const snapshot = world.snapshot;
  for (const relation of snapshot.relations.filter((relation) => relation.kind === 'information-channel')) relation.data = { ...(relation.data ?? {}), lossRate:1, censorshipRate:1 };
  const settlements = snapshot.entities.filter((entity) => entity.kind === 'settlement' && entity.endedTick === undefined).slice(0,2); assert.equal(settlements.length,2);
  const source = settlements[0]; const target = settlements[1]; const regionId = String(source.components.regionId); const region = snapshot.entities.find((entity) => entity.id === regionId); assert.ok(region?.spatial);
  snapshot.relations.push({ id:'fixture-iterative-map-channel', kind:'information-channel', sourceId:source.id, targetId:target.id, provenanceIds:[], data:{delayTicks:1,lossRate:0,censorshipRate:0,distortionRate:0,reliabilityIndex:1} });
  snapshot.knowledge = snapshot.knowledge.filter((record) => record.holderId !== source.id && record.holderId !== target.id);
  snapshot.knowledge.push({ id:'fixture-target-prior-map', holderId:target.id, subjectIds:[regionId], acquiredTick:snapshot.manifest.currentTick, confidence:0.45, claim:{interpretation:'cartographic-estimate',regionId,estimatedCenter:{x:region.spatial.x-45,y:region.spatial.y+5},uncertaintyRadiusKm:45} });
  snapshot.knowledge.push({ id:'fixture-source-map-a', holderId:source.id, subjectIds:[regionId], acquiredTick:snapshot.manifest.currentTick, confidence:0.85, claim:{interpretation:'cartographic-estimate',regionId,estimatedCenter:{x:region.spatial.x+18,y:region.spatial.y},uncertaintyRadiusKm:20} });
  await world.advance({toTick:snapshot.manifest.currentTick+recipe.clock.ticksPerDay});
  const firstRevisions = snapshot.knowledge.filter((record) => record.holderId === target.id && Array.isArray(record.claim.revisionOf)); assert.equal(firstRevisions.length,1);
  snapshot.knowledge.push({ id:'fixture-source-map-b', holderId:source.id, subjectIds:[regionId], acquiredTick:snapshot.manifest.currentTick, confidence:0.95, claim:{interpretation:'cartographic-estimate',regionId,estimatedCenter:{x:region.spatial.x+2,y:region.spatial.y-1},uncertaintyRadiusKm:8} });
  await world.advance({toTick:snapshot.manifest.currentTick+recipe.clock.ticksPerDay});
  const revisions = snapshot.knowledge.filter((record) => record.holderId === target.id && Array.isArray(record.claim.revisionOf)).sort((a,b)=>a.acquiredTick-b.acquiredTick); assert.equal(revisions.length,2);
  assert.ok(revisions[1].claim.revisionOf.includes(revisions[0].id));
  assert.ok(Number(revisions[1].claim.uncertaintyRadiusKm) < Number(revisions[0].claim.uncertaintyRadiusKm));
  assert.equal(region.spatial.x, snapshot.entities.find((entity)=>entity.id===regionId).spatial.x);
});

test('v6 transmission semantics execute transformation operators, noise, memory decay, copying bias and complex-contagion exposure', async () => {
  const recipe = clone(baseRecipe);
  recipe.id = 'v6-transmission-semantics-fixture';
  recipe.seed = 606060;
  recipe.contentPacks = [
    { id: 'descendants-core', version: '0.1.0' },
    { id: 'v6-transmission-fixture-pack', version: '1.0.0' },
  ];
  recipe.modules.find((module) => module.id === 'knowledge').config = { hiddenDiscoveryRate: 1 };
  recipe.modules.push({ id: 'v6-old-knowledge-fixture', enabled: true, config: {} });
  const motifPass = recipe.generationPipeline.find((pass) => pass.id === 'motif:transmission');
  recipe.generationPipeline.push({ id: 'fixture:old-knowledge', moduleId: 'v6-old-knowledge-fixture', dependsOn: ['knowledge:information-ecology'] });
  motifPass.dependsOn = [...new Set([...(motifPass.dependsOn ?? []), 'fixture:old-knowledge'])];
  const motifModuleConfig = recipe.modules.find((module) => module.id === 'motif-ontology').config;
  motifModuleConfig.transmissionChance = 1;
  motifModuleConfig.maxLoreVariants = 128;
  motifModuleConfig.maxTransformationsPerVariant = 1;

  const sourceId = 'fixture-reviewed-source';
  const unitId = 'fixture-reviewed-source:unit:1';
  const claimId = 'fixture-reviewed-source:claim:1';
  const pack = {
    id: 'v6-transmission-fixture-pack', version: '1.0.0', data: { loreCorpus: {
      sourceCatalog: [{
        id: sourceId, title: 'Fixture reviewed source', creators: ['Fixture Curator'], year: 2026,
        traditions: ['fixture-tradition'], domains: ['folklore-theory'], sourceKind: 'modern-scholarship',
        ingestionPolicy: 'reference-only', curationReviewStatus: 'evidence-reviewed', verificationStatus: 'verified-catalog',
        catalogVerificationStatus: 'external-catalog-verified', bibliographicFamilyId: 'fixture-family', bibliographicParseStatus: 'metadata-reviewed',
        evidenceRole: 'mixed-evidence', collectionContext: 'Controlled test fixture.', translationContext: 'No translation.', editionContext: 'Fixture edition.',
        sensitivityNotes: ['Fixture only.'], biasNotes: ['Fixture only.'],
        sourceUnits: [{ id: unitId, label: 'Fixture unit', unitType: 'article', evidenceClaimIds: [claimId] }],
        evidenceClaims: [{ id: claimId, sourceUnitId: unitId, claimType: 'theoretical-mechanism', summary: 'Controlled transmission mechanism fixture.', confidence: 1 }],
      }],
      motifs: [{
        id: 'fixture-threshold-crossing', label: 'Fixture threshold crossing', description: 'Controlled motif.', family: 'liminality',
        triggerTags: ['boundary', 'crossing'], sourceIds: [sourceId], sourceUnitIds: [unitId], evidenceClaimIds: [claimId], dimensions: { liminality: 1 },
        motifeme: 'crossing changes permitted state', allomotifs: ['gate-crossing', 'river-crossing'], structuralRoles: ['transition'], ontologyFacets: ['boundary'],
        minimumIndependentFamilies: 1, curationStatus: 'active', structuralReviewStatus: 'curated',
      }],
      transformationRules: [{
        id: 'fixture-allomotif-substitution', label: 'Fixture substitution', appliesTo: ['boundary'], sourceIds: [sourceId], evidenceClaimIds: [claimId],
        weight: 1, effects: { distortion: 0.1 }, semanticEffect: 'Substitute an allomotif while preserving structural function.',
        operations: ['substitute:allomotif'], invariants: ['truth-provenance-preserved'], confidence: 1,
      }],
      transmissionModes: [{
        id: 'fixture-complex-horizontal', label: 'Fixture complex horizontal', distortion: 0.2, retention: 0.9, authority: 0.7,
        sourceIds: [sourceId], evidenceClaimIds: [claimId], direction: 'horizontal', copyingBiases: { prestige: 1, content: 1 },
        noiseProfile: { substitution: 1, sharpening: 1 }, memoryHalfLifeDays: 0.5, innovationRate: 1, complexContagionThreshold: 2,
      }],
    } },
  };

  const content = new ContentPackRegistry();
  const coreText = await readFile(new URL('../setting-packs/descendants/content-packs/descendants-core.json', import.meta.url), 'utf8');
  content.register(JSON.parse(coreText));
  content.register(pack);
  const registry = createBuiltinRegistry();
  registry.register({ id: 'v6-old-knowledge-fixture', version: '1.0.0', capabilities: ['fixture'], runPass(passId, _config, context) {
    if (passId !== 'fixture:old-knowledge') return;
    const holder = context.snapshot.entities.find((entity) => entity.kind === 'settlement');
    const subject = context.snapshot.entities.find((entity) => entity.kind === 'region');
    if (!holder || !subject) return;
    context.snapshot.knowledge.unshift({
      id: 'fixture-old-knowledge-record', holderId: holder.id, subjectIds: [subject.id],
      acquiredTick: Math.max(0, context.snapshot.manifest.currentTick - context.recipe.clock.ticksPerDay * 5), confidence: 0.8,
      claim: { variable: 'descendants:anomaly_pressure', interpretation: 'fixture-old-observation', boundary: true, crossing: true }, truthLinkIds: [],
    });
  }});
  const snapshot = await (await new WorldgenEngine(registry, content).generate(recipe)).exportSnapshot();
  const variants = snapshot.entities.filter((entity) => entity.kind === 'lore-variant');
  assert.ok(variants.length > 0);
  assert.ok(variants.some((variant) => variant.components.motifId === 'fixture-threshold-crossing' && variant.components.transformationOperations?.includes('substitute:allomotif')));
  const transmissions = snapshot.causalRecords.filter((record) => record.kind === 'transmission' && record.payload.modeId === 'fixture-complex-horizontal');
  assert.ok(transmissions.length > 0);
  assert.ok(transmissions.every((record) => record.payload.direction === 'horizontal' && record.payload.adoptionThreshold === 2));
  assert.ok(transmissions.some((record) => Number(record.payload.memoryRetention) < 1));
  assert.ok(transmissions.some((record) => Array.isArray(record.payload.noiseOperators) && record.payload.noiseOperators.includes('substitution') && record.payload.noiseOperators.includes('sharpening') && record.payload.noiseOperators.includes('innovation')));
  assert.ok(snapshot.events.some((event) => event.kind === 'lore-exposure' && event.data.modeId === 'fixture-complex-horizontal' && event.data.adoptionThreshold === 2));
  assert.ok(snapshot.knowledge.some((record) => record.claim.interpretation === 'lore-exposure' && record.claim.transmissionDirection === 'horizontal'));
  assert.deepEqual(validateSnapshotConformance(snapshot), []);
});

test('candidate motifs are represented for research but quarantined from runtime lore selection', async () => {
  const recipe = clone(baseRecipe); recipe.id = 'candidate-motif-quarantine-fixture'; recipe.seed = 202609081;
  recipe.modules.find((module) => module.id === 'knowledge').config = { hiddenDiscoveryRate: 1 };
  recipe.modules.find((module) => module.id === 'motif-ontology').config.transmissionChance = 1;
  const content = new ContentPackRegistry();
  for (const ref of recipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const snapshot = await (await new WorldgenEngine(createBuiltinRegistry(), content).generate(recipe)).exportSnapshot();
  const candidateIds = new Set(snapshot.entities.filter((entity) => entity.kind === 'motif' && entity.components.curationStatus === 'candidate').map((entity) => entity.components.semanticKey));
  assert.ok(candidateIds.size >= 20);
  const runtimeMotifIds = snapshot.entities.filter((entity) => entity.kind === 'lore-variant').map((entity) => entity.components.motifId);
  assert.ok(runtimeMotifIds.length > 0);
  assert.ok(runtimeMotifIds.every((id) => !candidateIds.has(id)));
});

test('research QA enforces catalog breadth plus curator-reviewed structural and evidence-claim coverage', async () => {
  const content = new ContentPackRegistry();
  for (const ref of baseRecipe.contentPacks) {
    const text = await readFile(new URL(`../setting-packs/descendants/content-packs/${ref.id}.json`, import.meta.url), 'utf8');
    content.register(JSON.parse(text));
  }
  const { buildLoreCorpus } = await import('../dist/index.js');
  const corpus = buildLoreCorpus(content);
  const audit = auditLoreCorpus(corpus);
  assert.ok(audit.sourceCount >= 1000);
  assert.ok(audit.catalogOnlySourceCount >= 1000);
  assert.equal(audit.invalidCatalogEvidenceRefs.length, 0);
  assert.equal(audit.underSupportedActiveMotifIds.length, 0);
  assert.ok(audit.structurallyCuratedMotifCount > 0);
  assert.equal(audit.structurallyCuratedActiveMotifCount, audit.structurallyCuratedMotifCount);
  assert.ok(audit.structurallyCuratedActiveMotifCoverage >= 0.8);
  assert.ok(audit.activeMotifSourceUnitCoverage >= 0.8);
  assert.ok(audit.activeMotifEvidenceClaimCoverage >= 0.8);
  assert.ok(!audit.warnings.some((warning) => warning.includes('Structural motif curation incomplete')));
  assert.ok(!audit.warnings.some((warning) => warning.includes('Motif source-unit linkage incomplete')));
  assert.ok(!audit.warnings.some((warning) => warning.includes('Motif evidence-claim linkage incomplete')));
  assert.equal(audit.transformationEvidenceClaimCoverage, 1);
  assert.equal(audit.transmissionEvidenceClaimCoverage, 1);
  assert.equal(audit.transmissionSourceProvenanceCoverage, 1);
  assert.ok(!audit.warnings.some((warning) => warning.includes('Transformation evidence-claim linkage incomplete')));
  assert.ok(!audit.warnings.some((warning) => warning.includes('Transmission evidence-claim linkage incomplete')));
  assert.ok(!audit.warnings.some((warning) => warning.includes('Transmission source provenance incomplete')));
  assert.ok(audit.dominantCatalogProviderShare <= 0.6);
  assert.ok(!audit.warnings.some((warning) => warning.includes('Catalog provider concentration warning')));
});

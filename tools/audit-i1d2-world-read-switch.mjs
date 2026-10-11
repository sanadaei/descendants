import { compileTestDist } from './compile-test-dist.mjs';

const compileCode = await compileTestDist();
if (compileCode !== 0) process.exit(compileCode);

const [
  { createInitialSandboxState },
  { advanceSandboxHours },
  { queryGeneratedWorldArea },
  { MockWorldProvider },
  { buildLegacyWorldGraphProjection, materializeWorldEntities, selectWorldGraphReadModel },
  { providerVisibleRouteAlternatives },
] = await Promise.all([
  import('../.test-dist/sandbox/bootstrap.js'),
  import('../.test-dist/sandbox/engine.js'),
  import('../.test-dist/sandbox/localExploration.js'),
  import('../.test-dist/worldbridge/mockWorldProvider.js'),
  import('../.test-dist/sandbox/knowledgeGraphProjection.js'),
  import('../.test-dist/sandbox/routePlanning.js'),
]);

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x1d2a11, population: 18 });
let reads = 0;
let fallbacks = 0;
let routeChecks = 0;
let maxEntities = 0;
let maxTargets = 0;

const routeIdentity = (routes) => JSON.stringify(routes.map((route) => ({
  id: route.id,
  nodeEntityIds: route.nodeEntityIds,
  relationIds: route.relationIds,
  evidenceIds: route.evidenceIds,
  waypointEntityIds: route.waypointEntityIds,
  waypointRelationIds: route.waypointRelationIds,
  relationSignatures: route.relationSignatures,
  distanceKm: route.distanceKm,
  stretchFromShortest: route.stretchFromShortest,
  overlapWithShortest: route.overlapWithShortest,
})));

for (let step = 0; step <= 120; step += 1) {
  for (const holder of state.agents.filter((agent) => agent.alive)) {
    const area = await queryGeneratedWorldArea(provider, state, holder.id, state.settlement.position);
    const legacyGraph = buildLegacyWorldGraphProjection(state, holder.id, area);
    const legacyEntities = materializeWorldEntities(area, legacyGraph);
    const read = selectWorldGraphReadModel(state, holder.id, area, true);
    reads += 1;
    maxEntities = Math.max(maxEntities, read.entities.length);
    maxTargets = Math.max(maxTargets, read.graph.targetableEntityIds.length);
    if (read.source !== 'shadow') {
      fallbacks += 1;
      console.error(`I1-D2 WORLD read fallback step=${step} day=${state.clock.day} minute=${state.clock.minuteOfDay} holder=${holder.id} reason=${read.fallbackReason ?? 'unknown'}`);
      console.error(JSON.stringify(read.comparison, null, 2));
      process.exit(1);
    }
    if (!read.entityIdentityEqual || read.entities.length !== legacyEntities.length || read.entities.some((entry, index) => entry !== legacyEntities[index])) {
      console.error(`I1-D2 provider entity identity mismatch step=${step} holder=${holder.id}`);
      process.exit(1);
    }
    for (const targetId of legacyGraph.targetableEntityIds) {
      const legacyRoutes = providerVisibleRouteAlternatives(area, legacyEntities, state.world.originEntityId, targetId, 3);
      const shadowRoutes = providerVisibleRouteAlternatives(area, read.entities, state.world.originEntityId, targetId, 3);
      routeChecks += 1;
      if (routeIdentity(legacyRoutes) !== routeIdentity(shadowRoutes)) {
        console.error(`I1-D2 route/topology mismatch step=${step} holder=${holder.id} target=${targetId}`);
        process.exit(1);
      }
    }
  }
  if (step < 120) await advanceSandboxHours(provider, state, 6);
}

console.log(`I1-D2 WORLD read switch: PASS reads=${reads} fallbacks=${fallbacks} routeChecks=${routeChecks} finalDay=${state.clock.day} knowledge=${state.knowledge.length} maxEntities=${maxEntities} maxTargets=${maxTargets}`);

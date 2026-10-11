import { compileTestDist } from './compile-test-dist.mjs';

const compileCode = await compileTestDist();
if (compileCode !== 0) process.exit(compileCode);

const [
  { createInitialSandboxState },
  { advanceSandboxHours },
  { queryGeneratedWorldArea },
  { MockWorldProvider },
  { addObservedKnowledge },
  { sandboxRepository },
  { selectF3KnowledgeReadModel },
  { selectWorldGraphReadModel },
  { providerVisibleRouteAlternatives },
  { assertImportedSaveProviderCompatible },
] = await Promise.all([
  import('../.test-dist/sandbox/bootstrap.js'),
  import('../.test-dist/sandbox/engine.js'),
  import('../.test-dist/sandbox/localExploration.js'),
  import('../.test-dist/worldbridge/mockWorldProvider.js'),
  import('../.test-dist/sandbox/knowledgeSimulation.js'),
  import('../.test-dist/sandbox/storage.js'),
  import('../.test-dist/sandbox/knowledgeF3Projection.js'),
  import('../.test-dist/sandbox/knowledgeGraphProjection.js'),
  import('../.test-dist/sandbox/routePlanning.js'),
  import('../.test-dist/sandbox/worldMutationSafety.js'),
]);

const provider = new MockWorldProvider();
let state = await createInitialSandboxState(provider, { seed: 0x1c0a501, population: 18 });
const originalHolderId = state.agents.find((agent) => agent.alive && !agent.expeditionId)?.id;
if (!originalHolderId) throw new Error('No consolidation holder.');

let roundTrips = 0;
let f3Reads = 0;
let worldReads = 0;
let targetSelections = 0;
let routeChecks = 0;
let fallbacks = 0;
let migrations = 0;
let reconciliations = 0;
let invalidRejects = 0;
let maxTargets = 0;

async function verifyCurrent(label) {
  const manifest = await provider.getManifest();
  assertImportedSaveProviderCompatible(state, manifest);
  const holder = state.agents.find((agent) => agent.id === originalHolderId && agent.alive) ?? state.agents.find((agent) => agent.alive);
  if (!holder) throw new Error(`${label}: no alive holder`);
  const f3 = selectF3KnowledgeReadModel(state, holder.id, true);
  f3Reads += 1;
  if (f3.source !== 'shadow' || !f3.comparison.equal || !f3.renderIdentityEqual) {
    fallbacks += 1;
    throw new Error(`${label}: F3 shadow read fallback ${f3.fallbackReason ?? 'unknown'}`);
  }
  const area = await queryGeneratedWorldArea(provider, state, holder.id, state.settlement.position);
  const world = selectWorldGraphReadModel(state, holder.id, area, true);
  worldReads += 1;
  if (world.source !== 'shadow' || !world.comparison.equal || !world.entityIdentityEqual) {
    fallbacks += 1;
    throw new Error(`${label}: WORLD shadow read fallback ${world.fallbackReason ?? 'unknown'}`);
  }
  maxTargets = Math.max(maxTargets, world.graph.targetableEntityIds.length);
  const targetId = world.graph.targetableEntityIds[0];
  if (!targetId) throw new Error(`${label}: no knowledge-bounded expedition target`);
  const target = world.entities.find((entry) => entry.id === targetId);
  if (!target?.spatial) throw new Error(`${label}: target ${targetId} does not resolve to a spatial provider entity`);
  targetSelections += 1;
  const routes = providerVisibleRouteAlternatives(area, world.entities, state.world.originEntityId, targetId, 3);
  routeChecks += 1;
  if (!Array.isArray(routes)) throw new Error(`${label}: route alternatives invalid`);
}

// Ordinary F10-equivalent export/import route at bootstrap.
await verifyCurrent('bootstrap');
state = sandboxRepository.importJson(sandboxRepository.exportJson(state));
roundTrips += 1;
await verifyCurrent('bootstrap-roundtrip');

// Explicit legacy schemaVersion=1 migration route.
{
  const legacy = structuredClone(state);
  delete legacy.knowledgeStore;
  state = sandboxRepository.importJson(JSON.stringify(legacy));
  if (!state.knowledgeStore) throw new Error('Legacy migration did not rebuild KnowledgeStore.');
  migrations += 1;
  await verifyCurrent('legacy-migration');
}

// Explicit stale-sidecar reconciliation route.
{
  const holder = state.agents.find((agent) => agent.id === originalHolderId && agent.alive) ?? state.agents.find((agent) => agent.alive);
  if (!holder) throw new Error('No holder for stale reconciliation.');
  const stale = structuredClone(state.knowledgeStore);
  addObservedKnowledge(state, [holder.id], ['site:i1-consolidation-audit'], 'Consolidation audit stale-sidecar observation.', 0.76, undefined, [], { promoteToSettlement: false });
  state.knowledgeStore = stale;
  state = sandboxRepository.importJson(JSON.stringify(state));
  reconciliations += 1;
  await verifyCurrent('stale-reconcile');
}

// Invalid sidecar must reject rather than fail open.
{
  const invalid = structuredClone(state);
  invalid.knowledgeStore = { schema: 'invalid', evidence: [], claims: [] };
  try {
    sandboxRepository.importJson(JSON.stringify(invalid));
    throw new Error('Invalid sidecar was accepted.');
  } catch (error) {
    if (!/invalid knowledgeStore sidecar|Unsupported knowledge-store schema/i.test(error instanceof Error ? error.message : String(error))) throw error;
    invalidRejects += 1;
  }
}

// 30 canonical days: each day is an actual export/import API roundtrip, then F3/WORLD/target read.
for (let day = 0; day < 30; day += 1) {
  await advanceSandboxHours(provider, state, 24);
  const exported = sandboxRepository.exportJson(state);
  state = sandboxRepository.importJson(exported);
  roundTrips += 1;
  await verifyCurrent(`day-${state.clock.day}`);
}

if (fallbacks !== 0) throw new Error(`Consolidation gate observed ${fallbacks} fallback(s).`);
console.log(`I1 consolidation gate: PASS roundTrips=${roundTrips} migrations=${migrations} reconciliations=${reconciliations} invalidRejects=${invalidRejects} f3Reads=${f3Reads} worldReads=${worldReads} targetSelections=${targetSelections} routeChecks=${routeChecks} fallbacks=${fallbacks} maxTargets=${maxTargets} finalDay=${state.clock.day} replay=${state.diagnostics.replayHash || 'none'}`);

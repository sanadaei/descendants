import { compileTestDist } from './compile-test-dist.mjs';

const compileCode = await compileTestDist();
if (compileCode !== 0) process.exit(compileCode);

const [{ createInitialSandboxState }, { advanceSandboxHours }, { queryGeneratedWorldArea }, { MockWorldProvider }, { compareWorldGraphProjections }] = await Promise.all([
  import('../.test-dist/sandbox/bootstrap.js'),
  import('../.test-dist/sandbox/engine.js'),
  import('../.test-dist/sandbox/localExploration.js'),
  import('../.test-dist/worldbridge/mockWorldProvider.js'),
  import('../.test-dist/sandbox/knowledgeGraphProjection.js'),
]);

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x1d30da7, population: 18 });
let comparisons = 0;
let maxEntities = 0;
let maxMarkers = 0;
let maxTargets = 0;

for (let step = 0; step <= 120; step += 1) {
  for (const holder of state.agents.filter((agent) => agent.alive)) {
    const area = await queryGeneratedWorldArea(provider, state, holder.id, state.settlement.position);
    const result = compareWorldGraphProjections(state, holder.id, area);
    comparisons += 1;
    maxEntities = Math.max(maxEntities, result.legacyCounts.entities);
    maxMarkers = Math.max(maxMarkers, result.legacyCounts.markers);
    maxTargets = Math.max(maxTargets, result.legacyCounts.targetable);
    if (!result.equal) {
      console.error(`I1-D WORLD parity mismatch step=${step} day=${state.clock.day} minute=${state.clock.minuteOfDay} holder=${holder.id}`);
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  }
  if (step < 120) await advanceSandboxHours(provider, state, 6);
}

console.log(`I1-D WORLD graph parity: PASS comparisons=${comparisons} finalDay=${state.clock.day} knowledge=${state.knowledge.length} maxEntities=${maxEntities} maxMarkers=${maxMarkers} maxTargets=${maxTargets}`);

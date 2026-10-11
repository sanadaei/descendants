import { compileTestDist } from './compile-test-dist.mjs';

const compileCode = await compileTestDist();
if (compileCode !== 0) process.exit(compileCode);

const [{ createInitialSandboxState }, { advanceSandboxHours }, { MockWorldProvider }, { compareF3KnowledgeProjections }] = await Promise.all([
  import('../.test-dist/sandbox/bootstrap.js'),
  import('../.test-dist/sandbox/engine.js'),
  import('../.test-dist/worldbridge/mockWorldProvider.js'),
  import('../.test-dist/sandbox/knowledgeF3Projection.js'),
]);

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x1c30da7, population: 18 });
let comparisons = 0;
let maxPersonal = 0;
let maxInstitutional = 0;

for (let step = 0; step <= 120; step += 1) {
  for (const holder of state.agents.filter((agent) => agent.alive)) {
    const result = compareF3KnowledgeProjections(state, holder.id);
    comparisons += 1;
    maxPersonal = Math.max(maxPersonal, result.legacyCounts.personal);
    maxInstitutional = Math.max(maxInstitutional, result.legacyCounts.institutional);
    if (!result.equal) {
      console.error(`I1-C F3 parity mismatch at step=${step} day=${state.clock.day} minute=${state.clock.minuteOfDay} holder=${holder.id}`);
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  }
  const noHolder = compareF3KnowledgeProjections(state, null);
  comparisons += 1;
  if (!noHolder.equal) {
    console.error(`I1-C F3 parity mismatch for null holder at step=${step}`);
    console.error(JSON.stringify(noHolder, null, 2));
    process.exit(1);
  }
  if (step < 120) await advanceSandboxHours(provider, state, 6);
}

console.log(`I1-C F3 parity: PASS comparisons=${comparisons} finalDay=${state.clock.day} knowledge=${state.knowledge.length} maxPersonal=${maxPersonal} maxInstitutional=${maxInstitutional}`);

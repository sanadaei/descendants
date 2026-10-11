import { compileTestDist } from './compile-test-dist.mjs';

const compileCode = await compileTestDist();
if (compileCode !== 0) process.exit(compileCode);

const [{ createInitialSandboxState }, { advanceSandboxHours }, { MockWorldProvider }, { selectF3KnowledgeReadModel, buildLegacyF3Projection }] = await Promise.all([
  import('../.test-dist/sandbox/bootstrap.js'),
  import('../.test-dist/sandbox/engine.js'),
  import('../.test-dist/worldbridge/mockWorldProvider.js'),
  import('../.test-dist/sandbox/knowledgeF3Projection.js'),
]);

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x1c30da7, population: 18 });
let comparisons = 0;
let shadowReads = 0;
let fallbacks = 0;
let maxPersonal = 0;
let maxInstitutional = 0;

function ids(rows) { return rows.map((entry) => entry.id); }

for (let step = 0; step <= 120; step += 1) {
  for (const holder of state.agents.filter((agent) => agent.alive)) {
    const legacy = buildLegacyF3Projection(state, holder.id);
    const read = selectF3KnowledgeReadModel(state, holder.id, true);
    comparisons += 1;
    if (read.source === 'shadow') shadowReads += 1; else fallbacks += 1;
    maxPersonal = Math.max(maxPersonal, read.personal.length);
    maxInstitutional = Math.max(maxInstitutional, read.institutional.length);
    if (read.source !== 'shadow' || !read.renderIdentityEqual || !read.comparison.equal
      || JSON.stringify(ids(read.personal)) !== JSON.stringify(legacy.personal.map((row) => row.legacyKnowledgeId))
      || JSON.stringify(ids(read.institutional)) !== JSON.stringify(legacy.institutional.map((row) => row.legacyKnowledgeId))) {
      console.error(`I1-C read-switch mismatch step=${step} day=${state.clock.day} minute=${state.clock.minuteOfDay} holder=${holder.id}`);
      console.error(JSON.stringify({ read, legacyPersonal: legacy.personal.map((r) => r.legacyKnowledgeId), legacyInstitutional: legacy.institutional.map((r) => r.legacyKnowledgeId) }, null, 2));
      process.exit(1);
    }
  }
  const legacyNone = buildLegacyF3Projection(state, null);
  const readNone = selectF3KnowledgeReadModel(state, null, true);
  comparisons += 1;
  if (readNone.source === 'shadow') shadowReads += 1; else fallbacks += 1;
  if (readNone.source !== 'shadow' || !readNone.renderIdentityEqual || !readNone.comparison.equal
    || JSON.stringify(ids(readNone.institutional)) !== JSON.stringify(legacyNone.institutional.map((row) => row.legacyKnowledgeId))) {
    console.error(`I1-C read-switch mismatch for null holder step=${step}`);
    console.error(JSON.stringify(readNone, null, 2));
    process.exit(1);
  }
  if (step < 120) await advanceSandboxHours(provider, state, 6);
}

console.log(`I1-C F3 read-switch audit: PASS comparisons=${comparisons} shadowReads=${shadowReads} fallbacks=${fallbacks} finalDay=${state.clock.day} knowledge=${state.knowledge.length} maxPersonal=${maxPersonal} maxInstitutional=${maxInstitutional}`);

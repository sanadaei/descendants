import { compileTestDist } from './compile-test-dist.mjs';

const compileCode = await compileTestDist();
if (compileCode !== 0) process.exit(compileCode);

const [
  { createInitialSandboxState },
  { advanceSandboxHours },
  { queryGeneratedWorldArea },
  { MockWorldProvider },
  { buildLegacyKnowledgeShadow },
  { importSandboxSave, sandboxRepository },
  { selectF3KnowledgeReadModel },
  { selectWorldGraphReadModel },
] = await Promise.all([
  import('../.test-dist/sandbox/bootstrap.js'),
  import('../.test-dist/sandbox/engine.js'),
  import('../.test-dist/sandbox/localExploration.js'),
  import('../.test-dist/worldbridge/mockWorldProvider.js'),
  import('../.test-dist/sandbox/knowledgeLegacyAdapter.js'),
  import('../.test-dist/sandbox/storage.js'),
  import('../.test-dist/sandbox/knowledgeF3Projection.js'),
  import('../.test-dist/sandbox/knowledgeGraphProjection.js'),
]);

const provider = new MockWorldProvider();
let state = await createInitialSandboxState(provider, { seed: 0x1e30da7, population: 18 });
let roundTrips = 0;
let f3Reads = 0;
let worldReads = 0;
let evidenceChecks = 0;
let claimChecks = 0;
let fallbacks = 0;

const identity = (snapshot) => JSON.stringify({
  evidence: snapshot.evidence.map((entry) => [entry.id, entry.sourceKind, entry.sourceEntityId ?? null, entry.observerIds]),
  claims: snapshot.claims.map((entry) => [entry.id, entry.subjectId, entry.knownBy, entry.institutional, entry.evidenceIds, entry.stale ?? false]),
});

for (let step = 0; step <= 120; step += 1) {
  const expected = buildLegacyKnowledgeShadow(state).snapshot();
  const exported = sandboxRepository.exportJson(state);
  const restored = importSandboxSave(exported);
  roundTrips += 1;
  if (!restored.knowledgeStore) {
    console.error(`I1-E missing persisted sidecar after roundtrip step=${step}`);
    process.exit(1);
  }
  if (identity(restored.knowledgeStore) !== identity(expected)) {
    console.error(`I1-E persisted knowledge identity mismatch step=${step} day=${state.clock.day}`);
    process.exit(1);
  }
  evidenceChecks += expected.evidence.length;
  claimChecks += expected.claims.length;

  for (const holder of restored.agents.filter((agent) => agent.alive)) {
    const f3 = selectF3KnowledgeReadModel(restored, holder.id, true);
    f3Reads += 1;
    if (f3.source !== 'shadow' || !f3.comparison.equal || !f3.renderIdentityEqual) {
      fallbacks += 1;
      console.error(`I1-E F3 fallback after roundtrip step=${step} holder=${holder.id}`);
      process.exit(1);
    }
    const area = await queryGeneratedWorldArea(provider, restored, holder.id, restored.settlement.position);
    const world = selectWorldGraphReadModel(restored, holder.id, area, true);
    worldReads += 1;
    if (world.source !== 'shadow' || !world.comparison.equal || !world.entityIdentityEqual) {
      fallbacks += 1;
      console.error(`I1-E WORLD fallback after roundtrip step=${step} holder=${holder.id}`);
      process.exit(1);
    }
  }

  state = restored;
  if (step < 120) await advanceSandboxHours(provider, state, 6);
}

console.log(`I1-E knowledge persistence: PASS roundTrips=${roundTrips} f3Reads=${f3Reads} worldReads=${worldReads} evidenceChecks=${evidenceChecks} claimChecks=${claimChecks} fallbacks=${fallbacks} finalDay=${state.clock.day} knowledge=${state.knowledge.length}`);

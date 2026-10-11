import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
const { selectF1IncidentReadModel } = await import('../.test-dist/sandbox/incidentService.js');

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x120ad17, population: 18 });
let comparisons = 0;
let hiddenLeakFailures = 0;
let emptyFallbacks = 0;
let rankViolations = 0;
const priority = { urgent: 3, watch: 2, info: 1 };

for (let step = 0; step <= 120; step += 1) {
  const legacy = synthesizeVisibleSituations(state, null, null);
  const read = selectF1IncidentReadModel(state, null, null, true);
  comparisons += 1;
  if (read.fallbackReason) emptyFallbacks += 1;
  assert.equal(read.source, 'incident');
  assert.ok(read.rows.length > 0);
  for (const incident of read.incidents) {
    const source = legacy.find((entry) => entry.title === incident.presentation.title && entry.detail === incident.presentation.summary);
    if (!source) hiddenLeakFailures += 1;
    assert.ok(source, `incident ${incident.id} must resolve to a current visible situation`);
    assert.deepEqual(incident.causeRefs, source.basisIds);
  }
  for (let i = 1; i < read.rows.length; i += 1) {
    if (priority[read.rows[i - 1].severity] < priority[read.rows[i].severity]) rankViolations += 1;
  }
  if (step < 120) await advanceSandboxHours(provider, state, 6);
}

assert.equal(hiddenLeakFailures, 0);
assert.equal(emptyFallbacks, 0);
assert.equal(rankViolations, 0);
console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  hiddenLeakFailures,
  emptyFallbacks,
  rankViolations,
  finalDay: state.clock.day,
  finalReplayHash: state.diagnostics.replayHash,
}, null, 2));

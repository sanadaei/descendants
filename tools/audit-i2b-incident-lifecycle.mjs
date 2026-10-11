import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const { deriveVisibleIncidentProjection, incidentContextKey } = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

function activeExpectedKeys(state) {
  const keys = new Set();
  for (const incident of deriveVisibleIncidentProjection(state, null, null).incidents) keys.add(`settlement|${incident.id}`);
  for (const expedition of state.expeditions) {
    if (['returned','destroyed','joined-elsewhere'].includes(expedition.status)) continue;
    const context = incidentContextKey(expedition);
    for (const incident of deriveVisibleIncidentProjection(state, expedition, null).incidents) keys.add(`${context}|${incident.id}`);
  }
  return [...keys].sort();
}

function activeLedgerKeys(state) {
  return (state.incidentLedger?.entries ?? []).filter((entry) => entry.phase === 'active').map((entry) => entry.key).sort();
}

function hasForbiddenPresentationPayload(state) {
  return (state.incidentLedger?.entries ?? []).some((entry) => ['title','summary','detail','presentation','visibleStakeText'].some((field) => Object.hasOwn(entry, field)));
}

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { result ^= payload.charCodeAt(index); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x120b17, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
const uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));

let comparisons = 0;
let reloads = 0;
let activeMismatchCount = 0;
let determinismMismatchCount = 0;
let forbiddenPayloadCount = 0;
let retentionViolations = 0;
let maxEntries = 0;

for (let step = 0; step <= 120; step += 1) {
  for (const state of [uninterrupted, reloadPath]) {
    comparisons += 1;
    const entries = state.incidentLedger?.entries ?? [];
    maxEntries = Math.max(maxEntries, entries.length);
    if (entries.length > 256) retentionViolations += 1;
    if (hasForbiddenPresentationPayload(state)) forbiddenPayloadCount += 1;
    const expected = activeExpectedKeys(state);
    const actual = activeLedgerKeys(state);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) activeMismatchCount += 1;
  }
  if (JSON.stringify(uninterrupted.incidentLedger) !== JSON.stringify(reloadPath.incidentLedger)) determinismMismatchCount += 1;

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);

  if ((step + 1) % 4 === 0) {
    const before = structuredClone(reloadPath.incidentLedger);
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    assert.deepEqual(reloadPath.incidentLedger, before, 'incident ledger must survive save/reload byte-semantically');
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

assert.equal(activeMismatchCount, 0);
assert.equal(determinismMismatchCount, 0);
assert.equal(forbiddenPayloadCount, 0);
assert.equal(retentionViolations, 0);
assert.deepEqual(reloadPath.incidentLedger, uninterrupted.incidentLedger);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  activeMismatchCount,
  determinismMismatchCount,
  forbiddenPayloadCount,
  retentionViolations,
  maxEntries,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalLedgerHash: hash(uninterrupted.incidentLedger),
  finalLedgerEntries: uninterrupted.incidentLedger?.entries.length ?? 0,
  finalActiveEntries: activeLedgerKeys(uninterrupted).length,
}, null, 2));

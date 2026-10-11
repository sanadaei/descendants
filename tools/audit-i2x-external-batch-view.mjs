import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const {
  createIncidentResponseExternalReceiptRegistry,
  registerIncidentResponseCoordinationReceipt,
  exportIncidentResponseExternalReceiptRegistry,
  importIncidentResponseExternalReceiptRegistry,
  deriveIncidentResponseExternalRetryQueueGuidance,
  deriveIncidentResponseExternalBatchReadback,
  executeIncidentResponseExternalBatchRetry,
  filterIncidentResponseExternalBatchReadback,
  exportIncidentResponseExternalBatchReadbackSnapshot,
  importIncidentResponseExternalBatchReadbackSnapshot,
  deriveIncidentResponseExternalReviewBatchReplan,
  deriveVisibleIncidentProjection,
  executeIncidentResponseCoordinationBatch,
  synchronizeIncidentLedger,
  synchronizeIncidentResponseOperations,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

function hash(value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let i = 0; i < payload.length; i += 1) { result ^= payload.charCodeAt(i); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function selectionSet(registry, limit = 8) {
  const result = [];
  for (const entry of registry.entries) {
    for (const retry of entry.retryReceipts) result.push({ registryEntryId: entry.id, originalRequestIndex: retry.originalRequestIndex });
    for (const originalRequestIndex of entry.pendingRequestIndices) result.push({ registryEntryId: entry.id, originalRequestIndex });
  }
  return result.slice(-limit);
}

function invariantFailures(view, snapshot, replan) {
  let failures = 0;
  if (view.items.length !== view.selections.length) failures += 1;
  if (view.recordedCount + view.pendingCount !== view.items.length) failures += 1;
  if (view.retainedCount + view.missingCount + view.pendingCount !== view.items.length) failures += 1;
  if (snapshot.authority !== 'external-observer-snapshot' || snapshot.schemaVersion !== 1) failures += 1;
  if (JSON.stringify(snapshot.view) !== JSON.stringify(view)) failures += 1;
  if (replan) {
    if (replan.readyNowCount + replan.reviewCount !== replan.items.length) failures += 1;
    if (replan.readySelections.length !== replan.readyNowCount || replan.reviewSelections.length !== replan.reviewCount) failures += 1;
    if (replan.canExecuteReadySubset !== (replan.readyNowCount > 0)) failures += 1;
  }
  const serialized = JSON.stringify({ view, replan });
  if (/"success"|"failure"|"outcome"|"causeConfirmed"|"hiddenCause"/i.test(serialized)) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12181a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 80;
  state.settlement.resources.food = 200;
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 50);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 50);
  synchronizeIncidentLedger(state);
}
let registryA = createIncidentResponseExternalReceiptRegistry();
let registryB = createIncidentResponseExternalReceiptRegistry();

const incidentId = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents[0]?.id;
assert.ok(incidentId);
const requests = Array.from({ length: 4 }, () => ({ incidentId, teamSize: 1 }));
const initialBatchA = executeIncidentResponseCoordinationBatch(uninterrupted, requests, [0, 1, 2]);
const initialBatchB = executeIncidentResponseCoordinationBatch(reloadPath, requests, [0, 1, 2]);
assert.deepEqual(initialBatchB, initialBatchA);
const initialEntryA = registerIncidentResponseCoordinationReceipt(registryA, requests, initialBatchA);
const initialEntryB = registerIncidentResponseCoordinationReceipt(registryB, requests, initialBatchB);
assert.equal(initialEntryB.id, initialEntryA.id);

let comparisons = 0;
let snapshotComparisons = 0;
let replanComparisons = 0;
let reloads = 0;
let registeredReceipts = 2;
let retryCommits = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let maxReadbackItems = 0;
let maxFilteredItems = 0;
let maxReviewItems = 0;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  synchronizeIncidentResponseOperations(uninterrupted);
  synchronizeIncidentResponseOperations(reloadPath);

  const selectionsA = selectionSet(registryA);
  const selectionsB = selectionSet(registryB);
  assert.deepEqual(selectionsB, selectionsA);
  if (selectionsA.length) {
    const readbackA = deriveIncidentResponseExternalBatchReadback(uninterrupted, registryA, selectionsA);
    const readbackB = deriveIncidentResponseExternalBatchReadback(reloadPath, registryB, selectionsB);
    comparisons += 2;
    if (JSON.stringify(readbackA) !== JSON.stringify(readbackB)) determinismMismatchCount += 1;
    maxReadbackItems = Math.max(maxReadbackItems, readbackA.items.length);

    const filter = step % 4 === 0 ? 'all' : step % 4 === 1 ? 'recorded' : step % 4 === 2 ? 'pending' : 'active';
    const query = step % 5 === 0 ? initialEntryA.id : '';
    const viewA = filterIncidentResponseExternalBatchReadback(readbackA, filter, query);
    const viewB = filterIncidentResponseExternalBatchReadback(readbackB, filter, query);
    comparisons += 2;
    if (JSON.stringify(viewA) !== JSON.stringify(viewB)) determinismMismatchCount += 1;
    maxFilteredItems = Math.max(maxFilteredItems, viewA.items.length);
    const snapshotA = importIncidentResponseExternalBatchReadbackSnapshot(exportIncidentResponseExternalBatchReadbackSnapshot(viewA));
    const snapshotB = importIncidentResponseExternalBatchReadbackSnapshot(exportIncidentResponseExternalBatchReadbackSnapshot(viewB));
    snapshotComparisons += 2;
    if (JSON.stringify(snapshotA) !== JSON.stringify(snapshotB)) determinismMismatchCount += 1;

    const guidanceA = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA);
    const guidanceB = deriveIncidentResponseExternalRetryQueueGuidance(reloadPath, registryB);
    assert.deepEqual(guidanceB, guidanceA);
    const pendingA = guidanceA.items.slice(0, 2).map((item) => ({ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex }));
    const pendingB = guidanceB.items.slice(0, 2).map((item) => ({ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex }));
    let replanA = null;
    if (pendingA.length) {
      replanA = deriveIncidentResponseExternalReviewBatchReplan(uninterrupted, registryA, pendingA);
      const replanB = deriveIncidentResponseExternalReviewBatchReplan(reloadPath, registryB, pendingB);
      replanComparisons += 2;
      if (JSON.stringify(replanA) !== JSON.stringify(replanB)) determinismMismatchCount += 1;
      maxReviewItems = Math.max(maxReviewItems, replanA.reviewCount);
      if (step > 0 && step % 12 === 0 && replanA.reviewCount === 0) {
        const execA = executeIncidentResponseExternalBatchRetry(uninterrupted, registryA, pendingA);
        const execB = executeIncidentResponseExternalBatchRetry(reloadPath, registryB, pendingB);
        assert.deepEqual(execB, execA);
        assert.deepEqual(registryB, registryA);
        retryCommits += 2;
      }
    }
    invariantFailureCount += invariantFailures(viewA, snapshotA, replanA);
  }

  const visibleA = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents;
  const visibleB = deriveVisibleIncidentProjection(reloadPath, null, null).incidents;
  assert.deepEqual(visibleB.map((value) => value.id), visibleA.map((value) => value.id));
  if (visibleA.length && step > 0 && step % 18 === 0) {
    const more = Array.from({ length: 3 }, () => ({ incidentId: visibleA[0].id, teamSize: 1 }));
    try {
      const batchA = executeIncidentResponseCoordinationBatch(uninterrupted, more, [0]);
      const batchB = executeIncidentResponseCoordinationBatch(reloadPath, more, [0]);
      assert.deepEqual(batchB, batchA);
      registerIncidentResponseCoordinationReceipt(registryA, more, batchA);
      registerIncidentResponseCoordinationReceipt(registryB, more, batchB);
      registeredReceipts += 2;
    } catch (error) {
      assert.match(String(error), /requires review|capacity|resource/i);
    }
  }

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);
  if ((step + 1) % 4 === 0) {
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    registryB = importIncidentResponseExternalReceiptRegistry(exportIncidentResponseExternalReceiptRegistry(registryB));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.deepEqual(registryB, registryA);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);
const exportedState = sandboxRepository.exportJson(uninterrupted);
assert.doesNotMatch(exportedState, /incidentResponseExternalBatchReadbackSnapshot|incidentResponseExternalReviewBatchReplan|external-observer-snapshot/i);

console.log(JSON.stringify({
  status: 'PASS', comparisons, snapshotComparisons, replanComparisons, reloads, registeredReceipts, retryCommits,
  maxReadbackItems, maxFilteredItems, maxReviewItems, determinismMismatchCount, invariantFailureCount,
  persistedReadbackSnapshotAuthority: false, persistedReviewReplanAuthority: false,
  finalDay: uninterrupted.clock.day, finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalRegistryHash: hash(registryA),
  finalViewHash: hash(filterIncidentResponseExternalBatchReadback(
    deriveIncidentResponseExternalBatchReadback(uninterrupted, registryA, selectionSet(registryA)), 'all', ''
  )),
}, null, 2));

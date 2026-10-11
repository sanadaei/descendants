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
  executeIncidentResponseExternalRetryQueueBatch,
  deriveVisibleIncidentProjection,
  executeIncidentResponseCoordinationBatch,
  synchronizeIncidentLedger,
  synchronizeIncidentResponseOperations,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let i = 0; i < payload.length; i += 1) { result ^= payload.charCodeAt(i); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function invariantFailures(guidance) {
  let failures = 0;
  if (guidance.readyNowCount + guidance.reviewCount !== guidance.items.length) failures += 1;
  if (guidance.items.some((item) => !['ready-now', 'review'].includes(item.disposition))) failures += 1;
  if (guidance.items.some((item) => Object.hasOwn(item, 'success') || Object.hasOwn(item, 'failure') || Object.hasOwn(item, 'outcome') || Object.hasOwn(item, 'causeConfirmed'))) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12161a, population: 18 });
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
assert.equal(deriveVisibleIncidentProjection(reloadPath, null, null).incidents[0]?.id, incidentId);

// Controlled all-or-nothing rollback: each of three pending requests is individually ready at start,
// but the third becomes review after two earlier selections fill per-Incident capacity.
const rollbackRequests = Array.from({ length: 4 }, () => ({ incidentId, teamSize: 1 }));
const rollbackInitialA = executeIncidentResponseCoordinationBatch(uninterrupted, rollbackRequests, [0]);
const rollbackInitialB = executeIncidentResponseCoordinationBatch(reloadPath, rollbackRequests, [0]);
assert.deepEqual(rollbackInitialB, rollbackInitialA);
const rollbackEntryA = registerIncidentResponseCoordinationReceipt(registryA, rollbackRequests, rollbackInitialA);
const rollbackEntryB = registerIncidentResponseCoordinationReceipt(registryB, rollbackRequests, rollbackInitialB);
assert.deepEqual(rollbackEntryB, rollbackEntryA);
const beforeRollbackStateA = sandboxRepository.exportJson(uninterrupted);
const beforeRollbackStateB = sandboxRepository.exportJson(reloadPath);
const beforeRollbackRegistryA = exportIncidentResponseExternalReceiptRegistry(registryA);
const beforeRollbackRegistryB = exportIncidentResponseExternalReceiptRegistry(registryB);
const rollbackSelections = [1, 2, 3].map((originalRequestIndex) => ({ registryEntryId: rollbackEntryA.id, originalRequestIndex }));
const rollbackMirrorSelections = [1, 2, 3].map((originalRequestIndex) => ({ registryEntryId: rollbackEntryB.id, originalRequestIndex }));
assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(uninterrupted, registryA, rollbackSelections), /requires review during commit/i);
assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(reloadPath, registryB, rollbackMirrorSelections), /requires review during commit/i);
assert.equal(sandboxRepository.exportJson(uninterrupted), beforeRollbackStateA);
assert.equal(sandboxRepository.exportJson(reloadPath), beforeRollbackStateB);
assert.equal(exportIncidentResponseExternalReceiptRegistry(registryA), beforeRollbackRegistryA);
assert.equal(exportIncidentResponseExternalReceiptRegistry(registryB), beforeRollbackRegistryB);
let atomicRollbackAttempts = 2;

// Commit two ready items to prove successful batch behavior before the long audit.
const successSelections = [1, 2].map((originalRequestIndex) => ({ registryEntryId: rollbackEntryA.id, originalRequestIndex }));
const successMirrorSelections = [1, 2].map((originalRequestIndex) => ({ registryEntryId: rollbackEntryB.id, originalRequestIndex }));
const firstA = executeIncidentResponseExternalRetryQueueBatch(uninterrupted, registryA, successSelections);
const firstB = executeIncidentResponseExternalRetryQueueBatch(reloadPath, registryB, successMirrorSelections);
assert.deepEqual(firstB, firstA);
assert.deepEqual(registryB, registryA);
assert.deepEqual(registryA.entries[0].pendingRequestIndices, [3]);

let comparisons = 2;
let reloads = 0;
let registeredReceipts = 2;
let batchCommits = 2;
let queueItemExecutions = 4;
let reviewRejects = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let maxRegistryEntries = registryA.entries.length;
let maxQueueItems = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA).items.length;
let maxBatchSize = 2;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  synchronizeIncidentResponseOperations(uninterrupted);
  synchronizeIncidentResponseOperations(reloadPath);
  const a = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA);
  const b = deriveIncidentResponseExternalRetryQueueGuidance(reloadPath, registryB);
  comparisons += 2;
  if (JSON.stringify(a) !== JSON.stringify(b)) determinismMismatchCount += 1;
  invariantFailureCount += invariantFailures(a) + invariantFailures(b);
  maxRegistryEntries = Math.max(maxRegistryEntries, registryA.entries.length);
  maxQueueItems = Math.max(maxQueueItems, a.items.length);

  if (step > 0 && step % 10 === 0 && a.items.length) {
    const ready = a.items.filter((item) => item.disposition === 'ready-now').slice(0, 2);
    const mirrorReady = b.items.filter((item) => item.disposition === 'ready-now').slice(0, 2);
    assert.deepEqual(mirrorReady, ready);
    if (ready.length) {
      const selectionsA = ready.map((item) => ({ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex }));
      const selectionsB = mirrorReady.map((item) => ({ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex }));
      try {
        const resultA = executeIncidentResponseExternalRetryQueueBatch(uninterrupted, registryA, selectionsA);
        const resultB = executeIncidentResponseExternalRetryQueueBatch(reloadPath, registryB, selectionsB);
        assert.deepEqual(resultB, resultA);
        assert.deepEqual(registryB, registryA);
        batchCommits += 2;
        queueItemExecutions += resultA.executions.length + resultB.executions.length;
        maxBatchSize = Math.max(maxBatchSize, resultA.executions.length);
      } catch (error) {
        assert.match(String(error), /requires review during commit|unavailable|capacity|resource/i);
        atomicRollbackAttempts += 2;
      }
    } else {
      const item = a.items[0];
      const mirrorItem = b.items[0];
      assert.deepEqual(mirrorItem, item);
      const beforeA = sandboxRepository.exportJson(uninterrupted);
      const beforeB = sandboxRepository.exportJson(reloadPath);
      const regA = exportIncidentResponseExternalReceiptRegistry(registryA);
      const regB = exportIncidentResponseExternalReceiptRegistry(registryB);
      assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(uninterrupted, registryA, [{ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex }]), /requires review before commit/i);
      assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(reloadPath, registryB, [{ registryEntryId: mirrorItem.registryEntryId, originalRequestIndex: mirrorItem.originalRequestIndex }]), /requires review before commit/i);
      assert.equal(sandboxRepository.exportJson(uninterrupted), beforeA);
      assert.equal(sandboxRepository.exportJson(reloadPath), beforeB);
      assert.equal(exportIncidentResponseExternalReceiptRegistry(registryA), regA);
      assert.equal(exportIncidentResponseExternalReceiptRegistry(registryB), regB);
      reviewRejects += 2;
    }
  }

  const incidents = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents;
  const mirrorIncidents = deriveVisibleIncidentProjection(reloadPath, null, null).incidents;
  assert.deepEqual(mirrorIncidents.map((incident) => incident.id), incidents.map((incident) => incident.id));
  if (incidents.length && step > 0 && step % 16 === 0) {
    const requests = Array.from({ length: 3 }, () => ({ incidentId: incidents[0].id, teamSize: 1 }));
    try {
      const batchA = executeIncidentResponseCoordinationBatch(uninterrupted, requests, [0]);
      const batchB = executeIncidentResponseCoordinationBatch(reloadPath, requests, [0]);
      assert.deepEqual(batchB, batchA);
      registerIncidentResponseCoordinationReceipt(registryA, requests, batchA);
      registerIncidentResponseCoordinationReceipt(registryB, requests, batchB);
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
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalReceiptRegistry'), false);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalRetryQueue'), false);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalRetryQueueBatch'), false);
const exportedState = sandboxRepository.exportJson(uninterrupted);
assert.doesNotMatch(exportedState, /external-receipt|incidentResponseExternalReceiptRegistry|incidentResponseExternalRetryQueue/i);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  registeredReceipts,
  batchCommits,
  queueItemExecutions,
  reviewRejects,
  atomicRollbackAttempts,
  maxBatchSize,
  maxRegistryEntries,
  maxQueueItems,
  determinismMismatchCount,
  invariantFailureCount,
  persistedExternalRegistryAuthority: false,
  persistedRetryQueueAuthority: false,
  persistedQueueBatchAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalRegistryHash: hash(registryA),
  finalGuidanceHash: hash(deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA)),
}, null, 2));

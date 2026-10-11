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
  deriveIncidentResponseExternalBatchRetryPlan,
  executeIncidentResponseExternalBatchRetry,
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

function recordedSelections(registry, limit = 8) {
  const values = [];
  for (const entry of registry.entries) {
    for (const retry of entry.retryReceipts) values.push({ registryEntryId: entry.id, originalRequestIndex: retry.originalRequestIndex });
  }
  return values.slice(-limit);
}

function readbackInvariantFailures(readback) {
  let failures = 0;
  if (readback.items.length !== readback.selections.length) failures += 1;
  if (readback.recordedCount + readback.pendingCount !== readback.items.length) failures += 1;
  if (readback.retainedCount + readback.missingCount + readback.pendingCount !== readback.items.length) failures += 1;
  if (readback.activeCount + readback.terminalCount + readback.missingCount + readback.pendingCount !== readback.items.length) failures += 1;
  for (const item of readback.items) {
    if (item.status === 'pending' && item.receiptRecorded) failures += 1;
    if (item.receiptRecorded && item.status !== 'missing' && !item.retained) failures += 1;
    if (Object.hasOwn(item, 'success') || Object.hasOwn(item, 'failure') || Object.hasOwn(item, 'outcome') || Object.hasOwn(item, 'causeConfirmed') || Object.hasOwn(item, 'hiddenCause')) failures += 1;
  }
  return failures;
}

function retryPlanInvariantFailures(plan) {
  let failures = 0;
  if (plan.items.length !== plan.selections.length) failures += 1;
  if (plan.readyNowCount + plan.reviewCount !== plan.items.length) failures += 1;
  if (plan.canExecuteAtomicBatch !== (plan.reviewCount === 0)) failures += 1;
  if (plan.items.some((item) => !['ready-now', 'review'].includes(item.disposition))) failures += 1;
  if (plan.items.some((item) => Object.hasOwn(item, 'success') || Object.hasOwn(item, 'failure') || Object.hasOwn(item, 'outcome') || Object.hasOwn(item, 'causeConfirmed'))) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12171a, population: 18 });
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
const controlledRequests = Array.from({ length: 4 }, () => ({ incidentId, teamSize: 1 }));
const controlledInitialA = executeIncidentResponseCoordinationBatch(uninterrupted, controlledRequests, [0]);
const controlledInitialB = executeIncidentResponseCoordinationBatch(reloadPath, controlledRequests, [0]);
assert.deepEqual(controlledInitialB, controlledInitialA);
const controlledEntryA = registerIncidentResponseCoordinationReceipt(registryA, controlledRequests, controlledInitialA);
const controlledEntryB = registerIncidentResponseCoordinationReceipt(registryB, controlledRequests, controlledInitialB);
const controlledSelectionsA = [1, 2].map((originalRequestIndex) => ({ registryEntryId: controlledEntryA.id, originalRequestIndex }));
const controlledSelectionsB = [1, 2].map((originalRequestIndex) => ({ registryEntryId: controlledEntryB.id, originalRequestIndex }));
const controlledRetryA = executeIncidentResponseExternalBatchRetry(uninterrupted, registryA, controlledSelectionsA);
const controlledRetryB = executeIncidentResponseExternalBatchRetry(reloadPath, registryB, controlledSelectionsB);
assert.deepEqual(controlledRetryB, controlledRetryA);
assert.deepEqual(registryB, registryA);
const controlledReadbackA = deriveIncidentResponseExternalBatchReadback(uninterrupted, registryA, controlledSelectionsA);
const controlledReadbackB = deriveIncidentResponseExternalBatchReadback(reloadPath, registryB, controlledSelectionsB);
assert.deepEqual(controlledReadbackB, controlledReadbackA);
assert.equal(controlledReadbackA.recordedCount, 2);
assert.equal(controlledReadbackA.activeCount, 2);
const controlledReviewSelectionA = [{ registryEntryId: controlledEntryA.id, originalRequestIndex: 3 }];
const controlledReviewSelectionB = [{ registryEntryId: controlledEntryB.id, originalRequestIndex: 3 }];
const controlledReviewA = deriveIncidentResponseExternalBatchRetryPlan(uninterrupted, registryA, controlledReviewSelectionA);
const controlledReviewB = deriveIncidentResponseExternalBatchRetryPlan(reloadPath, registryB, controlledReviewSelectionB);
assert.deepEqual(controlledReviewB, controlledReviewA);
assert.equal(controlledReviewA.canExecuteAtomicBatch, false);
const beforeReviewA = sandboxRepository.exportJson(uninterrupted);
const beforeReviewB = sandboxRepository.exportJson(reloadPath);
const beforeRegistryA = exportIncidentResponseExternalReceiptRegistry(registryA);
const beforeRegistryB = exportIncidentResponseExternalReceiptRegistry(registryB);
assert.throws(() => executeIncidentResponseExternalBatchRetry(uninterrupted, registryA, controlledReviewSelectionA), /still requires review/i);
assert.throws(() => executeIncidentResponseExternalBatchRetry(reloadPath, registryB, controlledReviewSelectionB), /still requires review/i);
assert.equal(sandboxRepository.exportJson(uninterrupted), beforeReviewA);
assert.equal(sandboxRepository.exportJson(reloadPath), beforeReviewB);
assert.equal(exportIncidentResponseExternalReceiptRegistry(registryA), beforeRegistryA);
assert.equal(exportIncidentResponseExternalReceiptRegistry(registryB), beforeRegistryB);

let readbackComparisons = 2;
let retryPlanComparisons = 2;
let reloads = 0;
let registeredReceipts = 2;
let batchRetryCommits = 2;
let queueItemExecutions = 4;
let reviewOnlyRejects = 2;
let atomicRollbackAttempts = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = readbackInvariantFailures(controlledReadbackA) + readbackInvariantFailures(controlledReadbackB)
  + retryPlanInvariantFailures(controlledReviewA) + retryPlanInvariantFailures(controlledReviewB);
let maxRegistryEntries = registryA.entries.length;
let maxReadbackItems = controlledReadbackA.items.length;
let maxRetryBatchSize = controlledSelectionsA.length;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  synchronizeIncidentResponseOperations(uninterrupted);
  synchronizeIncidentResponseOperations(reloadPath);

  const recordedA = recordedSelections(registryA);
  const recordedB = recordedSelections(registryB);
  assert.deepEqual(recordedB, recordedA);
  if (recordedA.length) {
    const a = deriveIncidentResponseExternalBatchReadback(uninterrupted, registryA, recordedA);
    const b = deriveIncidentResponseExternalBatchReadback(reloadPath, registryB, recordedB);
    readbackComparisons += 2;
    if (JSON.stringify(a) !== JSON.stringify(b)) determinismMismatchCount += 1;
    invariantFailureCount += readbackInvariantFailures(a) + readbackInvariantFailures(b);
    maxReadbackItems = Math.max(maxReadbackItems, a.items.length);
  }

  const guidanceA = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA);
  const guidanceB = deriveIncidentResponseExternalRetryQueueGuidance(reloadPath, registryB);
  assert.deepEqual(guidanceB, guidanceA);
  const pendingSelectionsA = guidanceA.items.slice(0, 2).map((item) => ({ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex }));
  const pendingSelectionsB = guidanceB.items.slice(0, 2).map((item) => ({ registryEntryId: item.registryEntryId, originalRequestIndex: item.originalRequestIndex }));
  if (pendingSelectionsA.length) {
    const planA = deriveIncidentResponseExternalBatchRetryPlan(uninterrupted, registryA, pendingSelectionsA);
    const planB = deriveIncidentResponseExternalBatchRetryPlan(reloadPath, registryB, pendingSelectionsB);
    retryPlanComparisons += 2;
    if (JSON.stringify(planA) !== JSON.stringify(planB)) determinismMismatchCount += 1;
    invariantFailureCount += retryPlanInvariantFailures(planA) + retryPlanInvariantFailures(planB);
    if (step > 0 && step % 10 === 0) {
      if (planA.canExecuteAtomicBatch) {
        const stateBeforeA = sandboxRepository.exportJson(uninterrupted);
        const stateBeforeB = sandboxRepository.exportJson(reloadPath);
        const regBeforeA = exportIncidentResponseExternalReceiptRegistry(registryA);
        const regBeforeB = exportIncidentResponseExternalReceiptRegistry(registryB);
        try {
          const execA = executeIncidentResponseExternalBatchRetry(uninterrupted, registryA, pendingSelectionsA);
          const execB = executeIncidentResponseExternalBatchRetry(reloadPath, registryB, pendingSelectionsB);
          assert.deepEqual(execB, execA);
          assert.deepEqual(registryB, registryA);
          batchRetryCommits += 2;
          queueItemExecutions += execA.batch.executions.length + execB.batch.executions.length;
          maxRetryBatchSize = Math.max(maxRetryBatchSize, execA.batch.executions.length);
        } catch (error) {
          assert.match(String(error), /requires review during commit|unavailable|capacity|resource/i);
          assert.equal(sandboxRepository.exportJson(uninterrupted), stateBeforeA);
          assert.equal(sandboxRepository.exportJson(reloadPath), stateBeforeB);
          assert.equal(exportIncidentResponseExternalReceiptRegistry(registryA), regBeforeA);
          assert.equal(exportIncidentResponseExternalReceiptRegistry(registryB), regBeforeB);
          atomicRollbackAttempts += 2;
        }
      } else {
        const stateBeforeA = sandboxRepository.exportJson(uninterrupted);
        const stateBeforeB = sandboxRepository.exportJson(reloadPath);
        const regBeforeA = exportIncidentResponseExternalReceiptRegistry(registryA);
        const regBeforeB = exportIncidentResponseExternalReceiptRegistry(registryB);
        assert.throws(() => executeIncidentResponseExternalBatchRetry(uninterrupted, registryA, pendingSelectionsA), /still requires review/i);
        assert.throws(() => executeIncidentResponseExternalBatchRetry(reloadPath, registryB, pendingSelectionsB), /still requires review/i);
        assert.equal(sandboxRepository.exportJson(uninterrupted), stateBeforeA);
        assert.equal(sandboxRepository.exportJson(reloadPath), stateBeforeB);
        assert.equal(exportIncidentResponseExternalReceiptRegistry(registryA), regBeforeA);
        assert.equal(exportIncidentResponseExternalReceiptRegistry(registryB), regBeforeB);
        reviewOnlyRejects += 2;
      }
    }
  }

  const incidentsA = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents;
  const incidentsB = deriveVisibleIncidentProjection(reloadPath, null, null).incidents;
  assert.deepEqual(incidentsB.map((incident) => incident.id), incidentsA.map((incident) => incident.id));
  if (incidentsA.length && step > 0 && step % 16 === 0) {
    const requests = Array.from({ length: 3 }, () => ({ incidentId: incidentsA[0].id, teamSize: 1 }));
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

  maxRegistryEntries = Math.max(maxRegistryEntries, registryA.entries.length);
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
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalBatchReadback'), false);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalBatchRetry'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseExternalBatchReadback'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseExternalBatchRetry'), false);
const exportedState = sandboxRepository.exportJson(uninterrupted);
assert.doesNotMatch(exportedState, /incidentResponseExternalBatchReadback|incidentResponseExternalBatchRetry/i);

const finalRecorded = recordedSelections(registryA);
console.log(JSON.stringify({
  status: 'PASS',
  readbackComparisons,
  retryPlanComparisons,
  reloads,
  registeredReceipts,
  batchRetryCommits,
  queueItemExecutions,
  reviewOnlyRejects,
  atomicRollbackAttempts,
  maxRegistryEntries,
  maxReadbackItems,
  maxRetryBatchSize,
  determinismMismatchCount,
  invariantFailureCount,
  persistedBatchReadbackAuthority: false,
  persistedBatchRetryAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalRegistryHash: hash(registryA),
  finalReadbackHash: finalRecorded.length ? hash(deriveIncidentResponseExternalBatchReadback(uninterrupted, registryA, finalRecorded)) : hash([]),
  finalGuidanceHash: hash(deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA)),
}, null, 2));

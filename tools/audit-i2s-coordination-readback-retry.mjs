import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const {
  deriveIncidentResponseCoordinationReadback,
  deriveIncidentResponseCoordinationRetryPlan,
  deriveVisibleIncidentProjection,
  executeIncidentResponseCoordinationBatch,
  executeIncidentResponseCoordinationRetry,
  incidentResponseTeams,
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

function readbackInvariantFailures(readback) {
  let failures = 0;
  if (readback.items.length !== readback.selectedRequestIndices.length) failures += 1;
  if (readback.retainedCount + readback.missingCount !== readback.items.length) failures += 1;
  if (readback.activeCount + readback.terminalCount + readback.missingCount !== readback.items.length) failures += 1;
  for (const item of readback.items) {
    if (item.retained && item.status === 'missing') failures += 1;
    if (!item.retained && item.status !== 'missing') failures += 1;
    if (item.retained && (!item.teamId || !item.operationId || !item.resourceReservationId)) failures += 1;
    if (Object.hasOwn(item, 'success') || Object.hasOwn(item, 'failure') || Object.hasOwn(item, 'outcome') || Object.hasOwn(item, 'causeConfirmed')) failures += 1;
  }
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12131a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 40;
  state.settlement.resources.food = 120;
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 30);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 30);
  synchronizeIncidentLedger(state);
}

const controlledIncidentId = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents[0]?.id;
assert.ok(controlledIncidentId);
assert.equal(deriveVisibleIncidentProjection(reloadPath, null, null).incidents[0]?.id, controlledIncidentId);
const controlledRequests = Array.from({ length: 3 }, () => ({ incidentId: controlledIncidentId, teamSize: 1 }));
const controlledReceipt = executeIncidentResponseCoordinationBatch(uninterrupted, controlledRequests, [0, 1]);
const mirroredReceipt = executeIncidentResponseCoordinationBatch(reloadPath, controlledRequests, [0, 1]);
assert.deepEqual(mirroredReceipt, controlledReceipt);
const controlledReadback = deriveIncidentResponseCoordinationReadback(uninterrupted, controlledReceipt);
const mirroredReadback = deriveIncidentResponseCoordinationReadback(reloadPath, mirroredReceipt);
assert.deepEqual(mirroredReadback, controlledReadback);
assert.equal(controlledReadback.activeCount, 2);
assert.equal(controlledReadback.missingCount, 0);

// With two active teams, the third is still currently retryable; execute it explicitly. A fourth
// retry is review-only at the per-Incident team cap and must not mutate state.
const retryReady = deriveIncidentResponseCoordinationRetryPlan(uninterrupted, controlledRequests, 2);
const retryReadyMirror = deriveIncidentResponseCoordinationRetryPlan(reloadPath, controlledRequests, 2);
assert.deepEqual(retryReadyMirror, retryReady);
assert.equal(retryReady.canExecuteNow, true);
const retryExecution = executeIncidentResponseCoordinationRetry(uninterrupted, controlledRequests, 2);
const retryExecutionMirror = executeIncidentResponseCoordinationRetry(reloadPath, controlledRequests, 2);
assert.deepEqual(retryExecutionMirror, retryExecution);
const reviewOnlyRequests = [{ incidentId: controlledIncidentId, teamSize: 1 }];
const blockedRetry = deriveIncidentResponseCoordinationRetryPlan(uninterrupted, reviewOnlyRequests, 0);
assert.equal(blockedRetry.canExecuteNow, false);
const beforeBlocked = sandboxRepository.exportJson(uninterrupted);
assert.throws(() => executeIncidentResponseCoordinationRetry(uninterrupted, reviewOnlyRequests, 0), /requires review/i);
assert.equal(sandboxRepository.exportJson(uninterrupted), beforeBlocked);

let comparisons = 0;
let reloads = 0;
let retryExecutions = 2;
let reviewOnlyRejects = 1;
let determinismMismatchCount = 0;
let invariantFailureCount = readbackInvariantFailures(controlledReadback) + readbackInvariantFailures(mirroredReadback);
let maxTrackedReceipts = 2;
const receipts = [controlledReceipt, retryExecution.batch];

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  synchronizeIncidentResponseOperations(uninterrupted);
  synchronizeIncidentResponseOperations(reloadPath);

  for (const receipt of receipts.slice(-8)) {
    const a = deriveIncidentResponseCoordinationReadback(uninterrupted, receipt);
    const b = deriveIncidentResponseCoordinationReadback(reloadPath, receipt);
    comparisons += 2;
    if (JSON.stringify(a) !== JSON.stringify(b)) determinismMismatchCount += 1;
    invariantFailureCount += readbackInvariantFailures(a) + readbackInvariantFailures(b);
  }

  const aIncidents = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents;
  const bIncidents = deriveVisibleIncidentProjection(reloadPath, null, null).incidents;
  assert.deepEqual(bIncidents.map((incident) => incident.id), aIncidents.map((incident) => incident.id));
  if (aIncidents.length && step % 12 === 0) {
    const requests = [{ incidentId: aIncidents[0].id, teamSize: 1 }];
    const aRetry = deriveIncidentResponseCoordinationRetryPlan(uninterrupted, requests, 0);
    const bRetry = deriveIncidentResponseCoordinationRetryPlan(reloadPath, requests, 0);
    assert.deepEqual(bRetry, aRetry);
    if (aRetry.canExecuteNow) {
      const aExecution = executeIncidentResponseCoordinationRetry(uninterrupted, requests, 0);
      const bExecution = executeIncidentResponseCoordinationRetry(reloadPath, requests, 0);
      assert.deepEqual(bExecution, aExecution);
      receipts.push(aExecution.batch);
      retryExecutions += 2;
      maxTrackedReceipts = Math.max(maxTrackedReceipts, receipts.length);
    } else {
      const beforeA = sandboxRepository.exportJson(uninterrupted);
      const beforeB = sandboxRepository.exportJson(reloadPath);
      assert.throws(() => executeIncidentResponseCoordinationRetry(uninterrupted, requests, 0), /requires review/i);
      assert.throws(() => executeIncidentResponseCoordinationRetry(reloadPath, requests, 0), /requires review/i);
      assert.equal(sandboxRepository.exportJson(uninterrupted), beforeA);
      assert.equal(sandboxRepository.exportJson(reloadPath), beforeB);
      reviewOnlyRejects += 2;
    }
  }

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);
  if ((step + 1) % 4 === 0) {
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseCoordinationReadback'), false);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseCoordinationRetry'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseCoordinationReadback'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseCoordinationRetry'), false);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  retryExecutions,
  reviewOnlyRejects,
  maxTrackedReceipts,
  controlledActiveReadbackCount: controlledReadback.activeCount,
  controlledRetryOriginalRequestIndex: retryExecution.retryPlan.originalRequestIndex,
  determinismMismatchCount,
  invariantFailureCount,
  persistedReadbackAuthority: false,
  persistedRetryAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalReadbackHash: hash(receipts.slice(-8).map((receipt) => deriveIncidentResponseCoordinationReadback(uninterrupted, receipt))),
  finalTeamHash: hash(incidentResponseTeams(uninterrupted)),
}, null, 2));

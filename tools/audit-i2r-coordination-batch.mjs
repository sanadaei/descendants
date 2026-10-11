import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const {
  deriveIncidentResponseCoordinationPlan,
  deriveVisibleIncidentProjection,
  executeIncidentResponseCoordinationBatch,
  incidentResponseTeams,
  incidentResponseOperations,
  incidentResponseResourceReservations,
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

function batchInvariantFailures(state, batch) {
  let failures = 0;
  if (batch.executions.length !== batch.selectedRequestIndices.length) failures += 1;
  for (const execution of batch.executions) {
    const team = incidentResponseTeams(state).find((entry) => entry.id === execution.team.id);
    const operation = incidentResponseOperations(state).find((entry) => entry.id === execution.operationId);
    const reservation = incidentResponseResourceReservations(state).find((entry) => entry.id === execution.resourceReservationId);
    if (!team || team.phase !== 'dispatched') failures += 1;
    if (!operation || operation.teamId !== execution.team.id) failures += 1;
    if (!reservation || reservation.teamId !== execution.team.id) failures += 1;
    if (execution.originalRequestIndex !== batch.selectedRequestIndices[execution.batchPosition]) failures += 1;
    if (reservation && JSON.stringify(execution.reservedResources) !== JSON.stringify(reservation.reserved)) failures += 1;
  }
  const selected = new Set(batch.selectedRequestIndices);
  if (batch.remainingRequestIndices.some((index) => selected.has(index))) failures += 1;
  if (batch.postExecutionReplan.some((item) => !batch.remainingRequestIndices.includes(item.originalRequestIndex))) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12121a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 25);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 25);
  synchronizeIncidentLedger(state);
}

// Controlled proof: two selected requests commit atomically; a later four-request batch that would
// hit the per-Incident team limit rolls back all tentative work from that call.
const controlledIncidentId = 'incident:settlement:water-low';
const controlledRequests = Array.from({ length: 4 }, () => ({ incidentId: controlledIncidentId, teamSize: 1 }));
const controlledBatch = executeIncidentResponseCoordinationBatch(uninterrupted, controlledRequests, [0, 1]);
const mirroredBatch = executeIncidentResponseCoordinationBatch(reloadPath, controlledRequests, [0, 1]);
assert.deepEqual(mirroredBatch, controlledBatch);
assert.deepEqual(controlledBatch.executions.map((entry) => entry.originalRequestIndex), [0, 1]);
assert.deepEqual(controlledBatch.remainingRequestIndices, [2, 3]);
assert.equal(incidentResponseTeams(uninterrupted).length, 2);
assert.equal(controlledBatch.postExecutionReplan[0]?.originalRequestIndex, 2);

const beforeAtomicRejectA = sandboxRepository.exportJson(uninterrupted);
const beforeAtomicRejectB = sandboxRepository.exportJson(reloadPath);
assert.throws(() => executeIncidentResponseCoordinationBatch(uninterrupted, controlledRequests, [2, 3]), /requires review/i);
assert.throws(() => executeIncidentResponseCoordinationBatch(reloadPath, controlledRequests, [2, 3]), /requires review/i);
assert.equal(sandboxRepository.exportJson(uninterrupted), beforeAtomicRejectA);
assert.equal(sandboxRepository.exportJson(reloadPath), beforeAtomicRejectB);

let comparisons = 0;
let reloads = 0;
let batchCommits = 2;
let executedRequests = 4;
let atomicRollbackAttempts = 2;
let determinismMismatchCount = 0;
let invariantFailureCount = batchInvariantFailures(uninterrupted, controlledBatch) + batchInvariantFailures(reloadPath, mirroredBatch);
let maxBatchSize = controlledBatch.executions.length;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  const aIncidents = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents;
  const bIncidents = deriveVisibleIncidentProjection(reloadPath, null, null).incidents;
  assert.deepEqual(bIncidents.map((incident) => incident.id), aIncidents.map((incident) => incident.id));
  if (aIncidents.length) {
    const requests = aIncidents.slice(0, Math.min(2, aIncidents.length)).map((incident, index) => ({ incidentId: incident.id, teamSize: 1 + ((step + index) % 2) }));
    if (requests.length === 1) requests.push({ incidentId: requests[0].incidentId, teamSize: 1 });
    const aPlan = deriveIncidentResponseCoordinationPlan(uninterrupted, requests);
    const bPlan = deriveIncidentResponseCoordinationPlan(reloadPath, requests);
    comparisons += 2;
    if (JSON.stringify(aPlan) !== JSON.stringify(bPlan)) determinismMismatchCount += 1;
    if (step % 12 === 0) {
      const selected = aPlan.items.filter((item) => item.disposition === 'staged-now').slice(0, 2).map((item) => item.requestIndex);
      const bSelected = bPlan.items.filter((item) => item.disposition === 'staged-now').slice(0, 2).map((item) => item.requestIndex);
      assert.deepEqual(bSelected, selected);
      if (selected.length) {
        const aBatch = executeIncidentResponseCoordinationBatch(uninterrupted, requests, selected);
        const bBatch = executeIncidentResponseCoordinationBatch(reloadPath, requests, bSelected);
        assert.deepEqual(bBatch, aBatch);
        batchCommits += 2;
        executedRequests += aBatch.executions.length + bBatch.executions.length;
        maxBatchSize = Math.max(maxBatchSize, aBatch.executions.length);
        invariantFailureCount += batchInvariantFailures(uninterrupted, aBatch) + batchInvariantFailures(reloadPath, bBatch);
      }
    }
  }
  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);
  synchronizeIncidentResponseOperations(uninterrupted);
  synchronizeIncidentResponseOperations(reloadPath);
  if ((step + 1) % 4 === 0) {
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseCoordinationBatch'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseCoordinationBatch'), false);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  batchCommits,
  executedRequests,
  atomicRollbackAttempts,
  controlledSelectedRequestIndices: controlledBatch.selectedRequestIndices,
  controlledRemainingRequestIndices: controlledBatch.remainingRequestIndices,
  controlledPostReplanCount: controlledBatch.postExecutionReplan.length,
  maxBatchSize,
  determinismMismatchCount,
  invariantFailureCount,
  persistedBatchAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalBatchHash: hash({
    teams: incidentResponseTeams(uninterrupted),
    operations: incidentResponseOperations(uninterrupted),
    reservations: incidentResponseResourceReservations(uninterrupted),
  }),
}, null, 2));

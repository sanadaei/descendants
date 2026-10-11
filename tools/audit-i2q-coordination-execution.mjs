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
  executeIncidentResponseCoordinationRequest,
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

function executionInvariantFailures(state, result) {
  let failures = 0;
  const team = incidentResponseTeams(state).find((entry) => entry.id === result.team.id);
  const operation = incidentResponseOperations(state).find((entry) => entry.id === result.operationId);
  const reservation = incidentResponseResourceReservations(state).find((entry) => entry.id === result.resourceReservationId);
  if (!team || team.phase !== 'dispatched') failures += 1;
  if (!operation || operation.teamId !== result.team.id) failures += 1;
  if (!reservation || reservation.teamId !== result.team.id) failures += 1;
  if (JSON.stringify(result.memberIds) !== JSON.stringify(result.team.memberIds)) failures += 1;
  if (reservation && JSON.stringify(result.reservedResources) !== JSON.stringify(reservation.reserved)) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12111a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 10;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 25);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 25);
  synchronizeIncidentLedger(state);
}

// Controlled proof: a review-only fourth request is a byte-for-byte save no-op, while selecting
// request 1 executes only that one virtual stage through the canonical team/operation/resource seams.
const controlledIncidentId = 'incident:settlement:water-low';
const controlledRequests = Array.from({ length: 4 }, () => ({ incidentId: controlledIncidentId, teamSize: 1 }));
const controlledPlan = deriveIncidentResponseCoordinationPlan(uninterrupted, controlledRequests);
assert.equal(controlledPlan.stagedRequestCount, 3);
assert.equal(controlledPlan.items[3].disposition, 'review');
const beforeRejected = sandboxRepository.exportJson(uninterrupted);
assert.throws(() => executeIncidentResponseCoordinationRequest(uninterrupted, controlledRequests, 3), /requires review/i);
assert.equal(sandboxRepository.exportJson(uninterrupted), beforeRejected);
const controlledExecution = executeIncidentResponseCoordinationRequest(uninterrupted, controlledRequests, 1);
assert.equal(incidentResponseTeams(uninterrupted).length, 1);
assert.deepEqual(controlledExecution.memberIds, controlledPlan.items[1].plannedMemberIds);
assert.notDeepEqual(controlledExecution.memberIds, controlledPlan.items[0].plannedMemberIds);

// Mirror the controlled successful execution on reloadPath so the 30-day twin paths start aligned.
const mirroredPlan = deriveIncidentResponseCoordinationPlan(reloadPath, controlledRequests);
const mirroredExecution = executeIncidentResponseCoordinationRequest(reloadPath, controlledRequests, 1);
assert.deepEqual(mirroredExecution.memberIds, controlledExecution.memberIds);
assert.deepEqual(mirroredExecution.reservedResources, controlledExecution.reservedResources);
assert.equal(mirroredPlan.items[1].incidentId, controlledPlan.items[1].incidentId);

let comparisons = 0;
let reloads = 0;
let executions = 2;
let rejectedReviewAttempts = 1;
let determinismMismatchCount = 0;
let invariantFailureCount = executionInvariantFailures(uninterrupted, controlledExecution) + executionInvariantFailures(reloadPath, mirroredExecution);

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
      const aItem = aPlan.items.find((item) => item.disposition === 'staged-now');
      const bItem = bPlan.items.find((item) => item.requestIndex === aItem?.requestIndex && item.disposition === 'staged-now');
      if (aItem && bItem) {
        const beforeATeams = incidentResponseTeams(uninterrupted).length;
        const beforeBTeams = incidentResponseTeams(reloadPath).length;
        const aResult = executeIncidentResponseCoordinationRequest(uninterrupted, requests, aItem.requestIndex);
        const bResult = executeIncidentResponseCoordinationRequest(reloadPath, requests, bItem.requestIndex);
        executions += 2;
        assert.deepEqual(bResult, aResult);
        assert.equal(incidentResponseTeams(uninterrupted).length, beforeATeams + 1);
        assert.equal(incidentResponseTeams(reloadPath).length, beforeBTeams + 1);
        invariantFailureCount += executionInvariantFailures(uninterrupted, aResult) + executionInvariantFailures(reloadPath, bResult);
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
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseCoordinationExecution'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseCoordinationExecution'), false);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  executions,
  rejectedReviewAttempts,
  controlledSelectedRequestIndex: controlledExecution.requestIndex,
  controlledTeamId: controlledExecution.team.id,
  controlledOperationId: controlledExecution.operationId,
  controlledReservationId: controlledExecution.resourceReservationId,
  controlledOnlyOneTeamExecuted: true,
  determinismMismatchCount,
  invariantFailureCount,
  persistedExecutionAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalExecutionHash: hash({
    teams: incidentResponseTeams(uninterrupted),
    operations: incidentResponseOperations(uninterrupted),
    reservations: incidentResponseResourceReservations(uninterrupted),
  }),
}, null, 2));

import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const {
  assignIncidentResponseTeam,
  deriveIncidentDispatchCapacity,
  deriveVisibleIncidentProjection,
  dispatchIncidentResponseTeam,
  standDownIncidentResponseTeam,
  synchronizeIncidentLedger,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

const FORBIDDEN = ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed'];

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { result ^= payload.charCodeAt(index); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function forbiddenTruthPayloadCount(state) {
  let count = 0;
  for (const operation of state.incidentResponseOperations?.operations ?? []) {
    if (FORBIDDEN.some((field) => Object.hasOwn(operation, field))) count += 1;
    for (const observation of operation.observations ?? []) if (FORBIDDEN.some((field) => Object.hasOwn(observation, field))) count += 1;
  }
  return count;
}

function invariantFailures(state) {
  const operations = state.incidentResponseOperations?.operations ?? [];
  const teams = new Map((state.incidentDispatch?.teams ?? []).map((team) => [team.id, team]));
  let failures = operations.length > 192 ? 1 : 0;
  const teamIds = new Set();
  const observationOrdinals = new Set();
  for (const operation of operations) {
    if (teamIds.has(operation.teamId)) failures += 1;
    teamIds.add(operation.teamId);
    const team = teams.get(operation.teamId);
    if (!team || team.contextKey !== operation.contextKey || team.incidentId !== operation.incidentId) failures += 1;
    const active = ['mobilizing','working','returning'].includes(operation.phase);
    if (active && team?.phase !== 'dispatched') failures += 1;
    if (!active && team?.phase !== 'stood-down') failures += 1;
    if (operation.observations.length > 8) failures += 1;
    for (const observation of operation.observations) {
      if (observationOrdinals.has(observation.ordinal)) failures += 1;
      observationOrdinals.add(observation.ordinal);
      if (observation.kind === 'post-response-visibility') {
        if (!['visible','not-visible'].includes(observation.incidentVisibility)) failures += 1;
      } else if (observation.incidentVisibility !== 'not-checked') failures += 1;
    }
    if (operation.phase === 'completed') {
      if (operation.mobilizationMinutesRemaining !== 0 || operation.workMinutesRemaining !== 0 || operation.returnMinutesRemaining !== 0) failures += 1;
      if (!operation.observations.some((entry) => entry.kind === 'post-response-visibility')) failures += 1;
      if (!operation.observations.some((entry) => entry.kind === 'return-complete')) failures += 1;
    }
    if (operation.phase === 'aborted' && !operation.observations.some((entry) => entry.kind === 'operator-stand-down' || entry.kind === 'team-unavailable')) failures += 1;
  }
  for (const team of state.incidentDispatch?.teams ?? []) if (team.phase === 'dispatched' && !teamIds.has(team.id)) failures += 1;
  return failures;
}

function assignDispatch(state, incidentId = null, teamSize = 1) {
  const incident = incidentId
    ? { id: incidentId }
    : deriveVisibleIncidentProjection(state, null, null).incidents[0];
  if (!incident) return null;
  const capacity = deriveIncidentDispatchCapacity(state, incident.id);
  if (!capacity.canAssign || capacity.availableMemberIds.length < teamSize) return null;
  const team = assignIncidentResponseTeam(state, incident.id, capacity.availableMemberIds.slice(0, teamSize));
  return dispatchIncidentResponseTeam(state, team.id);
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x120d17, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
const uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));

let comparisons = 0;
let reloads = 0;
let operatorActions = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let forbiddenTruthPayloads = 0;
let implicitResolutionCount = 0;
let maxOperations = 0;
let maxActiveOperations = 0;
let maxObservations = 0;

for (let step = 0; step <= 120; step += 1) {
  if ([0,20,40,60,80,100].includes(step)) {
    const a = assignDispatch(uninterrupted, null, step % 40 === 0 ? 2 : 1);
    const b = assignDispatch(reloadPath, null, step % 40 === 0 ? 2 : 1);
    assert.equal(a?.id ?? null, b?.id ?? null);
    assert.deepEqual(a?.memberIds ?? [], b?.memberIds ?? []);
    if (a) operatorActions += 2;
  }
  if ([10,50,90].includes(step)) {
    const a = assignDispatch(uninterrupted, null, 1);
    const b = assignDispatch(reloadPath, null, 1);
    assert.equal(a?.id ?? null, b?.id ?? null);
    if (a && b) {
      standDownIncidentResponseTeam(uninterrupted, a.id);
      standDownIncidentResponseTeam(reloadPath, b.id);
      operatorActions += 4;
    }
  }
  if (step === 30) {
    for (const state of [uninterrupted, reloadPath]) {
      state.settlement.resources.water = 1;
      synchronizeIncidentLedger(state);
    }
    const incidentId = 'incident:settlement:water-low';
    const a = assignDispatch(uninterrupted, incidentId, 1);
    const b = assignDispatch(reloadPath, incidentId, 1);
    assert.equal(a?.id ?? null, b?.id ?? null);
    assert.ok(a && b);
    for (const state of [uninterrupted, reloadPath]) {
      state.settlement.resources.water = 99999;
      synchronizeIncidentLedger(state);
    }
    operatorActions += 2;
  }

  for (const state of [uninterrupted, reloadPath]) {
    comparisons += 1;
    const operations = state.incidentResponseOperations?.operations ?? [];
    maxOperations = Math.max(maxOperations, operations.length);
    maxActiveOperations = Math.max(maxActiveOperations, operations.filter((operation) => ['mobilizing','working','returning'].includes(operation.phase)).length);
    maxObservations = Math.max(maxObservations, ...operations.map((operation) => operation.observations.length), 0);
    invariantFailureCount += invariantFailures(state);
    forbiddenTruthPayloads += forbiddenTruthPayloadCount(state);
    implicitResolutionCount += (state.incidentLedger?.entries ?? []).filter((entry) => entry.phase === 'resolved').length;
  }
  if (JSON.stringify(uninterrupted.incidentDispatch) !== JSON.stringify(reloadPath.incidentDispatch) || JSON.stringify(uninterrupted.incidentResponseOperations) !== JSON.stringify(reloadPath.incidentResponseOperations)) determinismMismatchCount += 1;
  if (step === 120) break;

  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);

  if ((step + 1) % 4 === 0) {
    const beforeDispatch = structuredClone(reloadPath.incidentDispatch);
    const beforeOperations = structuredClone(reloadPath.incidentResponseOperations);
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    assert.deepEqual(reloadPath.incidentDispatch, beforeDispatch, 'I2-D dispatch state must survive save/reload exactly');
    assert.deepEqual(reloadPath.incidentResponseOperations, beforeOperations, 'I2-D operation state must survive save/reload exactly');
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

const allOperations = uninterrupted.incidentResponseOperations?.operations ?? [];
const completedCount = allOperations.filter((operation) => operation.phase === 'completed').length;
const abortedCount = allOperations.filter((operation) => operation.phase === 'aborted').length;
const notVisibleObservationCount = allOperations.flatMap((operation) => operation.observations).filter((observation) => observation.kind === 'post-response-visibility' && observation.incidentVisibility === 'not-visible').length;
assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(forbiddenTruthPayloads, 0);
assert.equal(implicitResolutionCount, 0);
assert.ok(completedCount > 0);
assert.ok(abortedCount > 0);
assert.ok(notVisibleObservationCount > 0);
assert.deepEqual(reloadPath.incidentDispatch, uninterrupted.incidentDispatch);
assert.deepEqual(reloadPath.incidentResponseOperations, uninterrupted.incidentResponseOperations);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  operatorActions,
  determinismMismatchCount,
  invariantFailureCount,
  forbiddenTruthPayloads,
  implicitResolutionCount,
  completedCount,
  abortedCount,
  notVisibleObservationCount,
  maxOperations,
  maxActiveOperations,
  maxObservations,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalDispatchHash: hash(uninterrupted.incidentDispatch),
  finalOperationHash: hash(uninterrupted.incidentResponseOperations),
}, null, 2));

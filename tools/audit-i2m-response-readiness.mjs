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
  incidentResponseOperations,
  incidentResponseReadinessEntries,
  synchronizeIncidentLedger,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

const FORBIDDEN = ['title','summary','detail','presentation','outcome','success','failure','resolved','causeConfirmed','fatigue','task'];

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { result ^= payload.charCodeAt(index); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function readinessInvariantFailures(state) {
  const now = state.clock.day * 1440 + state.clock.minuteOfDay;
  const entries = state.incidentResponseReadiness?.entries ?? [];
  let failures = entries.length > 256 ? 1 : 0;
  const members = new Set();
  for (const entry of entries) {
    if (members.has(entry.memberId)) failures += 1;
    members.add(entry.memberId);
    if (entry.recoveryUntil <= now || entry.recoveryStartedAt > now || entry.recoveryUntil - entry.recoveryStartedAt > 240) failures += 1;
    if (entry.dutyMinutes < 0) failures += 1;
    if (FORBIDDEN.some((field) => Object.hasOwn(entry, field))) failures += 1;
  }
  return failures;
}

function assignDispatch(state, incidentId = null) {
  const incident = incidentId ? { id: incidentId } : deriveVisibleIncidentProjection(state, null, null).incidents[0];
  if (!incident) return null;
  const capacity = deriveIncidentDispatchCapacity(state, incident.id);
  if (!capacity.canAssign) return null;
  const team = assignIncidentResponseTeam(state, incident.id, [capacity.availableMemberIds[0]]);
  return dispatchIncidentResponseTeam(state, team.id);
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x120d1a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));

// Controlled proof: completion creates active recovery, blocks only response reassignment, then expires.
for (const state of [uninterrupted, reloadPath]) { state.settlement.resources.water = 1; synchronizeIncidentLedger(state); }
const incidentId = 'incident:settlement:water-low';
const aTeam = assignDispatch(uninterrupted, incidentId);
const bTeam = assignDispatch(reloadPath, incidentId);
assert.ok(aTeam && bTeam);
assert.equal(aTeam.memberIds[0], bTeam.memberIds[0]);
const controlledMember = aTeam.memberIds[0];
const operation = incidentResponseOperations(uninterrupted, incidentId)[0];
const totalHours = (operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes) / 60;
await advanceSandboxHours(uninterruptedProvider, uninterrupted, totalHours);
await advanceSandboxHours(reloadProvider, reloadPath, totalHours);
const recovery = incidentResponseReadinessEntries(uninterrupted).find((entry) => entry.memberId === controlledMember);
assert.ok(recovery);
assert.deepEqual(reloadPath.incidentResponseReadiness, uninterrupted.incidentResponseReadiness);
assert.ok(deriveIncidentDispatchCapacity(uninterrupted, incidentId).recoveringMemberIds.includes(controlledMember));
reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
assert.deepEqual(reloadPath.incidentResponseReadiness, uninterrupted.incidentResponseReadiness);
await advanceSandboxHours(uninterruptedProvider, uninterrupted, 4);
reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
await advanceSandboxHours(reloadProvider, reloadPath, 4);
assert.equal(incidentResponseReadinessEntries(uninterrupted).some((entry) => entry.memberId === controlledMember), false);

let comparisons = 0;
let reloads = 1;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let forbiddenTruthPayloads = 0;
let maxRecoveringMembers = 0;
let responseAssignments = 2;

for (let step = 0; step <= 120; step += 1) {
  if (step % 12 === 0) {
    const a = assignDispatch(uninterrupted);
    const b = assignDispatch(reloadPath);
    assert.equal(a?.id ?? null, b?.id ?? null);
    assert.deepEqual(a?.memberIds ?? [], b?.memberIds ?? []);
    if (a) responseAssignments += 2;
  }
  for (const state of [uninterrupted, reloadPath]) {
    comparisons += 1;
    const entries = incidentResponseReadinessEntries(state);
    maxRecoveringMembers = Math.max(maxRecoveringMembers, entries.length);
    invariantFailureCount += readinessInvariantFailures(state);
    forbiddenTruthPayloads += entries.filter((entry) => FORBIDDEN.some((field) => Object.hasOwn(entry, field))).length;
  }
  if (JSON.stringify(uninterrupted.incidentResponseReadiness) !== JSON.stringify(reloadPath.incidentResponseReadiness)) determinismMismatchCount += 1;
  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);
  if ((step + 1) % 4 === 0) {
    const before = structuredClone(reloadPath.incidentResponseReadiness);
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    assert.deepEqual(reloadPath.incidentResponseReadiness, before);
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(forbiddenTruthPayloads, 0);
assert.deepEqual(reloadPath.incidentResponseReadiness, uninterrupted.incidentResponseReadiness);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  responseAssignments,
  controlledRecoveryMinutes: recovery.recoveryUntil - recovery.recoveryStartedAt,
  determinismMismatchCount,
  invariantFailureCount,
  forbiddenTruthPayloads,
  maxRecoveringMembers,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalReadinessHash: hash(uninterrupted.incidentResponseReadiness),
}, null, 2));

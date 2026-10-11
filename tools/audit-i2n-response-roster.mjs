import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const {
  assignIncidentResponseRosterTeam,
  deriveIncidentResponseRosterPlan,
  deriveVisibleIncidentProjection,
  dispatchIncidentResponseTeam,
  incidentResponseOperations,
  incidentResponseReadinessEntries,
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

function planInvariantFailures(plan) {
  let failures = 0;
  if (plan.primaryMemberIds.length > 4 || plan.reserveMemberIds.length > 4) failures += 1;
  const available = [...plan.primaryMemberIds, ...plan.reserveMemberIds, ...plan.overflowMemberIds];
  if (new Set(available).size !== available.length) failures += 1;
  const blocked = new Set([...plan.committedMemberIds, ...plan.recoveringMemberIds]);
  if (available.some((id) => blocked.has(id))) failures += 1;
  const statIds = new Set(plan.serviceStats.map((entry) => entry.memberId));
  if (plan.eligibleMemberIds.some((id) => !statIds.has(id))) failures += 1;
  if (plan.serviceStats.some((entry) => entry.dutyMinutes < 0 || entry.terminalResponseCount < 0)) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x120e1a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) { state.settlement.resources.water = 1; synchronizeIncidentLedger(state); }

// Controlled proof: roster selection rotates away from a member after terminal duty and recovery expiry.
const incidentId = 'incident:settlement:water-low';
const initialPlan = deriveIncidentResponseRosterPlan(uninterrupted);
const firstMember = initialPlan.primaryMemberIds[0];
assert.ok(firstMember);
const aTeam = assignIncidentResponseRosterTeam(uninterrupted, incidentId, 1);
const bTeam = assignIncidentResponseRosterTeam(reloadPath, incidentId, 1);
assert.equal(aTeam.memberIds[0], firstMember);
assert.deepEqual(bTeam.memberIds, aTeam.memberIds);
dispatchIncidentResponseTeam(uninterrupted, aTeam.id);
dispatchIncidentResponseTeam(reloadPath, bTeam.id);
const operation = incidentResponseOperations(uninterrupted, incidentId)[0];
const dutyHours = (operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes) / 60;
await advanceSandboxHours(uninterruptedProvider, uninterrupted, dutyHours);
await advanceSandboxHours(reloadProvider, reloadPath, dutyHours);
const recovery = incidentResponseReadinessEntries(uninterrupted).find((entry) => entry.memberId === firstMember);
assert.ok(recovery);
await advanceSandboxHours(uninterruptedProvider, uninterrupted, 4);
await advanceSandboxHours(reloadProvider, reloadPath, 4);
const rotated = deriveIncidentResponseRosterPlan(uninterrupted);
const rotatedOrder = [...rotated.primaryMemberIds, ...rotated.reserveMemberIds, ...rotated.overflowMemberIds];
assert.ok(rotatedOrder.indexOf(firstMember) > 0);

let comparisons = 0;
let reloads = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let responseAssignments = 2;
const assignedMembers = new Set([firstMember]);

for (let step = 0; step <= 120; step += 1) {
  if (step % 12 === 0) {
    for (const state of [uninterrupted, reloadPath]) synchronizeIncidentLedger(state);
    const aIncident = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents[0];
    const bIncident = deriveVisibleIncidentProjection(reloadPath, null, null).incidents[0];
    assert.equal(aIncident?.id ?? null, bIncident?.id ?? null);
    if (aIncident && bIncident) {
      let aa = null; let bb = null;
      try { aa = assignIncidentResponseRosterTeam(uninterrupted, aIncident.id, 1); } catch {}
      try { bb = assignIncidentResponseRosterTeam(reloadPath, bIncident.id, 1); } catch {}
      assert.equal(aa?.id ?? null, bb?.id ?? null);
      assert.deepEqual(aa?.memberIds ?? [], bb?.memberIds ?? []);
      if (aa && bb) {
        assignedMembers.add(aa.memberIds[0]);
        responseAssignments += 2;
        try { dispatchIncidentResponseTeam(uninterrupted, aa.id); dispatchIncidentResponseTeam(reloadPath, bb.id); } catch {}
      }
    }
  }
  const aPlan = deriveIncidentResponseRosterPlan(uninterrupted);
  const bPlan = deriveIncidentResponseRosterPlan(reloadPath);
  comparisons += 2;
  invariantFailureCount += planInvariantFailures(aPlan) + planInvariantFailures(bPlan);
  if (JSON.stringify(aPlan) !== JSON.stringify(bPlan)) determinismMismatchCount += 1;
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
assert.ok(assignedMembers.size >= 2, 'roster rotation should distribute assignments across at least two responders');
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseRoster'), false);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  responseAssignments,
  distinctAssignedMembers: assignedMembers.size,
  controlledFirstMember: firstMember,
  rotatedFirstMember: rotated.primaryMemberIds[0] ?? null,
  determinismMismatchCount,
  invariantFailureCount,
  persistedRosterAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalRosterHash: hash(deriveIncidentResponseRosterPlan(uninterrupted)),
}, null, 2));

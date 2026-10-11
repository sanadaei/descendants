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
  deriveIncidentResponseLogisticsPlan,
  deriveVisibleIncidentProjection,
  dispatchIncidentResponseTeam,
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

function logisticsInvariantFailures(plan) {
  let failures = 0;
  if (plan.requestedTeamSize < 1 || plan.requestedTeamSize > 4) failures += 1;
  if (plan.plannedMemberIds.length > plan.requestedTeamSize) failures += 1;
  if (plan.plannedMemberIds.some((id) => !plan.rosterMemberIds.includes(id))) failures += 1;
  if (plan.totalEstimateMinutes !== plan.mobilizationEstimateMinutes + plan.workEstimateMinutes + plan.returnEstimateMinutes) failures += 1;
  for (const key of ['food', 'water', 'medicine', 'tools']) {
    const required = plan.requiredResources[key];
    const available = plan.availableResources[key];
    const shortfall = plan.shortfallResources[key];
    if (![required, available, shortfall].every(Number.isFinite)) failures += 1;
    if (required < 0 || available < 0 || shortfall < 0) failures += 1;
    const expected = Math.max(0, required - available);
    if (Math.abs(shortfall - expected) > 1e-6) failures += 1;
  }
  if (plan.readyToDispatch && plan.blockers.length) failures += 1;
  if (plan.readyToDispatch && plan.projectedTerminalAt !== plan.generatedAt + plan.totalEstimateMinutes) failures += 1;
  if (!plan.readyToAssign && !plan.blockers.some((value) => value !== 'resource-shortfall')) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x120f1a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 1;
  state.settlement.resources.food = Math.max(state.settlement.resources.food, 100);
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 10);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 10);
  synchronizeIncidentLedger(state);
}

// Controlled proof: the plan is exactly the I2-E reservation actually used by dispatch.
const controlledIncidentId = 'incident:settlement:water-low';
const controlledPlanA = deriveIncidentResponseLogisticsPlan(uninterrupted, controlledIncidentId, 2);
const controlledPlanB = deriveIncidentResponseLogisticsPlan(reloadPath, controlledIncidentId, 2);
assert.deepEqual(controlledPlanB, controlledPlanA);
assert.equal(controlledPlanA.readyToDispatch, true);
const controlledTeamA = assignIncidentResponseRosterTeam(uninterrupted, controlledIncidentId, 2);
const controlledTeamB = assignIncidentResponseRosterTeam(reloadPath, controlledIncidentId, 2);
dispatchIncidentResponseTeam(uninterrupted, controlledTeamA.id);
dispatchIncidentResponseTeam(reloadPath, controlledTeamB.id);
assert.deepEqual(
  incidentResponseResourceReservations(uninterrupted, controlledIncidentId)[0].reserved,
  controlledPlanA.requiredResources,
);

let comparisons = 0;
let reloads = 0;
let assignments = 2;
let dispatches = 2;
let resourceBlockedObservations = 0;
let readinessBlockedObservations = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  const aIncident = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents[0];
  const bIncident = deriveVisibleIncidentProjection(reloadPath, null, null).incidents[0];
  assert.equal(aIncident?.id ?? null, bIncident?.id ?? null);
  if (aIncident && bIncident) {
    const teamSize = 1 + (step % 3);
    const aPlan = deriveIncidentResponseLogisticsPlan(uninterrupted, aIncident.id, teamSize);
    const bPlan = deriveIncidentResponseLogisticsPlan(reloadPath, bIncident.id, teamSize);
    comparisons += 2;
    invariantFailureCount += logisticsInvariantFailures(aPlan) + logisticsInvariantFailures(bPlan);
    if (JSON.stringify(aPlan) !== JSON.stringify(bPlan)) determinismMismatchCount += 1;
    if (!aPlan.resourceReady) resourceBlockedObservations += 1;
    if (!aPlan.rosterReady || !aPlan.teamSlotReady) readinessBlockedObservations += 1;
    if (step % 12 === 0 && aPlan.readyToDispatch && bPlan.readyToDispatch) {
      const aTeam = assignIncidentResponseRosterTeam(uninterrupted, aIncident.id, teamSize);
      const bTeam = assignIncidentResponseRosterTeam(reloadPath, bIncident.id, teamSize);
      assert.deepEqual(aTeam.memberIds, bTeam.memberIds);
      dispatchIncidentResponseTeam(uninterrupted, aTeam.id);
      dispatchIncidentResponseTeam(reloadPath, bTeam.id);
      assignments += 2;
      dispatches += 2;
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
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseLogistics'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseLogistics'), false);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  assignments,
  dispatches,
  resourceBlockedObservations,
  readinessBlockedObservations,
  controlledRequestedTeamSize: controlledPlanA.requestedTeamSize,
  controlledTotalEstimateMinutes: controlledPlanA.totalEstimateMinutes,
  controlledRequiredResources: controlledPlanA.requiredResources,
  determinismMismatchCount,
  invariantFailureCount,
  persistedLogisticsAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalLogisticsHash: hash(deriveIncidentResponseLogisticsPlan(uninterrupted, controlledIncidentId, 1)),
}, null, 2));

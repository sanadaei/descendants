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
  deriveIncidentResponseCoordinationPlan,
  deriveVisibleIncidentProjection,
  dispatchIncidentResponseTeam,
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

function addResources(left, right) {
  return {
    food: +(left.food + right.food).toFixed(6),
    water: +(left.water + right.water).toFixed(6),
    medicine: +(left.medicine + right.medicine).toFixed(6),
    tools: +(left.tools + right.tools).toFixed(6),
  };
}

function coordinationInvariantFailures(plan) {
  let failures = 0;
  if (plan.requestCount !== plan.items.length) failures += 1;
  if (plan.requestCount < 1 || plan.requestCount > plan.maxRequests || plan.maxRequests !== 8) failures += 1;
  const staged = plan.items.filter((item) => item.disposition === 'staged-now');
  const review = plan.items.filter((item) => item.disposition === 'review');
  if (staged.length !== plan.stagedRequestCount || review.length !== plan.reviewRequestCount) failures += 1;
  const memberIds = staged.flatMap((item) => item.plannedMemberIds);
  if (new Set(memberIds).size !== memberIds.length) failures += 1;
  let stagedResources = { food: 0, water: 0, medicine: 0, tools: 0 };
  for (const item of plan.items) {
    if (item.requestedTeamSize < 1 || item.requestedTeamSize > 4) failures += 1;
    if (item.plannedMemberIds.length > item.requestedTeamSize) failures += 1;
    if (item.disposition === 'staged-now' && item.blockers.length) failures += 1;
    if (item.disposition === 'review' && item.blockers.length === 0) failures += 1;
    if (item.disposition === 'staged-now') {
      stagedResources = addResources(stagedResources, item.requiredResources);
      if (item.projectedTerminalAt !== plan.generatedAt + item.totalEstimateMinutes) failures += 1;
    }
    if (item.nextReviewAt !== undefined && item.nextReviewAt <= plan.generatedAt) failures += 1;
    for (const key of ['food', 'water', 'medicine', 'tools']) {
      if (![item.requiredResources[key], item.availableResourcesBefore[key], item.shortfallResources[key]].every(Number.isFinite)) failures += 1;
      if (item.requiredResources[key] < 0 || item.availableResourcesBefore[key] < 0 || item.shortfallResources[key] < 0) failures += 1;
    }
  }
  if (JSON.stringify(stagedResources) !== JSON.stringify(plan.stagedResources)) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12101a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 1;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 25);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 25);
  synchronizeIncidentLedger(state);
}

// Controlled proof: operator-ordered four-team request against one incident stages three and defers the fourth at the known virtual capacity boundary.
const controlledIncidentId = 'incident:settlement:water-low';
const controlledRequests = Array.from({ length: 4 }, () => ({ incidentId: controlledIncidentId, teamSize: 1 }));
const controlledPlanA = deriveIncidentResponseCoordinationPlan(uninterrupted, controlledRequests);
const controlledPlanB = deriveIncidentResponseCoordinationPlan(reloadPath, controlledRequests);
assert.deepEqual(controlledPlanB, controlledPlanA);
assert.equal(controlledPlanA.stagedRequestCount, 3);
assert.equal(controlledPlanA.reviewRequestCount, 1);
assert.ok(controlledPlanA.items[3].blockers.includes('coordination-team-capacity'));
assert.equal(controlledPlanA.items[3].nextReviewAt, controlledPlanA.items[0].projectedTerminalAt);
assert.equal(new Set(controlledPlanA.stagedMemberIds).size, controlledPlanA.stagedMemberIds.length);

let comparisons = 0;
let reloads = 0;
let assignments = 0;
let dispatches = 0;
let reviewObservations = 0;
let stagedObservations = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  const aIncidents = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents;
  const bIncidents = deriveVisibleIncidentProjection(reloadPath, null, null).incidents;
  assert.deepEqual(bIncidents.map((incident) => incident.id), aIncidents.map((incident) => incident.id));
  if (aIncidents.length) {
    const source = aIncidents.slice(0, Math.min(2, aIncidents.length));
    const requests = source.map((incident, index) => ({ incidentId: incident.id, teamSize: 1 + ((step + index) % 2) }));
    if (requests.length === 1) requests.push({ incidentId: requests[0].incidentId, teamSize: 1 });
    const aPlan = deriveIncidentResponseCoordinationPlan(uninterrupted, requests);
    const bPlan = deriveIncidentResponseCoordinationPlan(reloadPath, requests);
    comparisons += 2;
    invariantFailureCount += coordinationInvariantFailures(aPlan) + coordinationInvariantFailures(bPlan);
    if (JSON.stringify(aPlan) !== JSON.stringify(bPlan)) determinismMismatchCount += 1;
    stagedObservations += aPlan.stagedRequestCount + bPlan.stagedRequestCount;
    reviewObservations += aPlan.reviewRequestCount + bPlan.reviewRequestCount;
    if (step % 12 === 0) {
      const firstA = aPlan.items.find((item) => item.disposition === 'staged-now');
      const firstB = bPlan.items.find((item) => item.disposition === 'staged-now');
      if (firstA && firstB && firstA.incidentId === firstB.incidentId && firstA.requestedTeamSize === firstB.requestedTeamSize) {
        const aTeam = assignIncidentResponseRosterTeam(uninterrupted, firstA.incidentId, firstA.requestedTeamSize);
        const bTeam = assignIncidentResponseRosterTeam(reloadPath, firstB.incidentId, firstB.requestedTeamSize);
        assert.deepEqual(aTeam.memberIds, bTeam.memberIds);
        dispatchIncidentResponseTeam(uninterrupted, aTeam.id);
        dispatchIncidentResponseTeam(reloadPath, bTeam.id);
        assignments += 2;
        dispatches += 2;
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
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseCoordination'), false);
assert.equal(Object.hasOwn(reloadPath, 'incidentResponseCoordination'), false);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  assignments,
  dispatches,
  stagedObservations,
  reviewObservations,
  controlledRequestCount: controlledPlanA.requestCount,
  controlledStagedRequestCount: controlledPlanA.stagedRequestCount,
  controlledReviewRequestCount: controlledPlanA.reviewRequestCount,
  controlledNextReviewAt: controlledPlanA.nextReviewAt,
  determinismMismatchCount,
  invariantFailureCount,
  persistedCoordinationAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalCoordinationHash: hash(deriveIncidentResponseCoordinationPlan(uninterrupted, [{ incidentId: controlledIncidentId, teamSize: 1 }])),
}, null, 2));

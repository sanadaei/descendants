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
  derivePositiveIncidentResolutionEvidence,
  dispatchIncidentResponseTeam,
  resolvePersistedIncident,
  synchronizeIncidentLedger,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

const FORBIDDEN_EVIDENCE = ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','causeConfirmed','responseSucceeded'];
const NUMERIC_KINDS = new Set(['settlement-resource-threshold','field-health-threshold','field-fatigue-threshold','field-supply-threshold']);

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { result ^= payload.charCodeAt(index); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function resolutionInvariantFailures(state) {
  let failures = state.incidentLedger?.resolutionPolicyVersion === 1 ? 0 : 1;
  for (const entry of state.incidentLedger?.entries ?? []) {
    const evidence = entry.lastResolutionEvidence;
    if (entry.phase === 'resolved' && !evidence) failures += 1;
    if (!evidence) continue;
    if (evidence.occurrenceNumber < 1 || evidence.occurrenceNumber > entry.occurrenceCount) failures += 1;
    if (evidence.id !== `incident-resolution-evidence:${evidence.occurrenceNumber.toString(36)}:${entry.key}`) failures += 1;
    if (!Array.isArray(evidence.subjectIds) || evidence.subjectIds.length < 1 || new Set(evidence.subjectIds).size !== evidence.subjectIds.length) failures += 1;
    if (!Array.isArray(evidence.supportingOperationIds) || new Set(evidence.supportingOperationIds).size !== evidence.supportingOperationIds.length) failures += 1;
    if (FORBIDDEN_EVIDENCE.some((field) => Object.hasOwn(evidence, field))) failures += 1;
    if (NUMERIC_KINDS.has(evidence.kind)) {
      if (![evidence.observedValue,evidence.thresholdValue].every((value) => Number.isFinite(value) && value >= 0)) failures += 1;
      if (evidence.comparison === 'gte' && evidence.observedValue < evidence.thresholdValue) failures += 1;
      else if (evidence.comparison === 'lt' && evidence.observedValue >= evidence.thresholdValue) failures += 1;
      else if (!['gte','lt'].includes(evidence.comparison)) failures += 1;
    } else if (evidence.metric !== undefined || evidence.observedValue !== undefined || evidence.thresholdValue !== undefined || evidence.comparison !== undefined) failures += 1;
  }
  return failures;
}

function forbiddenResolutionTruthPayloadCount(state) {
  let count = 0;
  for (const entry of state.incidentLedger?.entries ?? []) {
    const evidence = entry.lastResolutionEvidence;
    if (evidence && FORBIDDEN_EVIDENCE.some((field) => Object.hasOwn(evidence, field))) count += 1;
  }
  return count;
}

function setBoth(states, mutate) {
  for (const state of states) mutate(state);
}

function resolveBoth(states, incidentId) {
  const results = states.map((state) => resolvePersistedIncident(state, incidentId));
  assert.equal(results[0], results[1]);
  return results[0];
}

function dispatchFirstAvailable(state, incidentId) {
  const capacity = deriveIncidentDispatchCapacity(state, incidentId);
  if (!capacity.canAssign || capacity.availableMemberIds.length === 0) return null;
  const team = assignIncidentResponseTeam(state, incidentId, capacity.availableMemberIds.slice(0, 1));
  return dispatchIncidentResponseTeam(state, team.id);
}

const providerA = new MockWorldProvider();
const initial = await createInitialSandboxState(providerA, { seed: 0x120f17, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));

let comparisons = 0;
let reloads = 0;
let explicitResolutionCount = 0;
let rejectedResolutionCount = 0;
let disappearanceOnlyWithdrawals = 0;
let determinismMismatchCount = 0;
let resolutionInvariantFailureCount = 0;
let forbiddenTruthPayloads = 0;
let maxResolvedEntries = 0;
let maxEvidenceRecords = 0;
let supportingCompletedOperationRefs = 0;

for (let step = 0; step <= 120; step += 1) {
  const states = [uninterrupted, reloadPath];

  if (step === 0) {
    setBoth(states, (state) => {
      state.settlement.resources.water = 1;
      synchronizeIncidentLedger(state);
    });
    const incidentId = 'incident:settlement:water-low';
    const a = dispatchFirstAvailable(uninterrupted, incidentId);
    const b = dispatchFirstAvailable(reloadPath, incidentId);
    assert.equal(a?.id ?? null, b?.id ?? null);
    assert.equal(resolveBoth(states, incidentId), false);
    rejectedResolutionCount += 2;
  }

  if (step === 4) {
    setBoth(states, (state) => {
      state.settlement.resources.water = 99999;
      synchronizeIncidentLedger(state);
      const entry = state.incidentLedger.entries.find((candidate) => candidate.incidentId === 'incident:settlement:water-low');
      assert.equal(entry?.phase, 'withdrawn');
      assert.equal(entry?.lastResolutionEvidence, undefined);
    });
    disappearanceOnlyWithdrawals += 2;
  }

  if (step === 5) {
    assert.equal(resolveBoth(states, 'incident:settlement:water-low'), true);
    explicitResolutionCount += 2;
    for (const state of states) {
      const entry = state.incidentLedger.entries.find((candidate) => candidate.incidentId === 'incident:settlement:water-low');
      assert.equal(entry?.phase, 'resolved');
      assert.equal(entry?.lastResolutionEvidence?.kind, 'settlement-resource-threshold');
    }
  }

  if (step === 20) {
    setBoth(states, (state) => {
      state.settlement.resources.water = 1;
      synchronizeIncidentLedger(state);
    });
    assert.equal(resolveBoth(states, 'incident:settlement:water-low'), false);
    rejectedResolutionCount += 2;
  }

  if (step === 21) {
    setBoth(states, (state) => { state.settlement.resources.water = 99999; });
    assert.equal(resolveBoth(states, 'incident:settlement:water-low'), true);
    explicitResolutionCount += 2;
    for (const state of states) {
      const entry = state.incidentLedger.entries.find((candidate) => candidate.incidentId === 'incident:settlement:water-low');
      assert.equal(entry?.lastResolutionEvidence?.occurrenceNumber, 2);
    }
  }

  if (step === 40) {
    setBoth(states, (state) => {
      const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
      assert.ok(patient);
      patient.pathology.push({
        id: 'case:i2f:audit-wound', pathologyId: 'traumatic-wound', onsetDay: state.clock.day,
        severity: 72, contagious: false, observedSymptoms: ['audit-recorded-wound'],
        suspectedCauses: [], treatmentsTried: [], status: 'active',
      });
      synchronizeIncidentLedger(state);
    });
    assert.equal(resolveBoth(states, 'incident:settlement:injury'), false);
    rejectedResolutionCount += 2;
  }

  if (step === 41) {
    setBoth(states, (state) => {
      const patient = state.agents.find((agent) => agent.pathology.some((entry) => entry.id === 'case:i2f:audit-wound'));
      patient.pathology.find((entry) => entry.id === 'case:i2f:audit-wound').status = 'resolved';
    });
    assert.equal(resolveBoth(states, 'incident:settlement:injury'), true);
    explicitResolutionCount += 2;
  }

  if (step === 60) {
    assert.equal(resolveBoth(states, 'incident:unsupported:caller-authored'), false);
    rejectedResolutionCount += 2;
  }

  for (const state of states) {
    comparisons += 1;
    resolutionInvariantFailureCount += resolutionInvariantFailures(state);
    forbiddenTruthPayloads += forbiddenResolutionTruthPayloadCount(state);
    const resolved = (state.incidentLedger?.entries ?? []).filter((entry) => entry.phase === 'resolved');
    const evidence = (state.incidentLedger?.entries ?? []).filter((entry) => entry.lastResolutionEvidence);
    maxResolvedEntries = Math.max(maxResolvedEntries, resolved.length);
    maxEvidenceRecords = Math.max(maxEvidenceRecords, evidence.length);
    supportingCompletedOperationRefs += evidence.reduce((sum, entry) => sum + entry.lastResolutionEvidence.supportingOperationIds.length, 0);
  }

  if (JSON.stringify(uninterrupted.incidentLedger) !== JSON.stringify(reloadPath.incidentLedger)
    || JSON.stringify(uninterrupted.incidentDispatch) !== JSON.stringify(reloadPath.incidentDispatch)
    || JSON.stringify(uninterrupted.incidentResponseOperations) !== JSON.stringify(reloadPath.incidentResponseOperations)
    || JSON.stringify(uninterrupted.incidentResponseResources) !== JSON.stringify(reloadPath.incidentResponseResources)
    || JSON.stringify(uninterrupted.settlement.resources) !== JSON.stringify(reloadPath.settlement.resources)) {
    determinismMismatchCount += 1;
  }

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);

  if ((step + 1) % 4 === 0) {
    const beforeLedger = structuredClone(reloadPath.incidentLedger);
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    assert.deepEqual(reloadPath.incidentLedger, beforeLedger, 'I2-F lifecycle/evidence must survive save/reload exactly');
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(resolutionInvariantFailureCount, 0);
assert.equal(forbiddenTruthPayloads, 0);
assert.ok(explicitResolutionCount > 0);
assert.ok(rejectedResolutionCount > 0);
assert.ok(disappearanceOnlyWithdrawals > 0);
assert.deepEqual(reloadPath.incidentLedger, uninterrupted.incidentLedger);
assert.deepEqual(reloadPath.incidentDispatch, uninterrupted.incidentDispatch);
assert.deepEqual(reloadPath.incidentResponseOperations, uninterrupted.incidentResponseOperations);
assert.deepEqual(reloadPath.incidentResponseResources, uninterrupted.incidentResponseResources);
assert.deepEqual(reloadPath.settlement.resources, uninterrupted.settlement.resources);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

const finalResolved = uninterrupted.incidentLedger.entries.filter((entry) => entry.phase === 'resolved').length;
const finalEvidence = uninterrupted.incidentLedger.entries.filter((entry) => entry.lastResolutionEvidence).length;

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  explicitResolutionCount,
  rejectedResolutionCount,
  disappearanceOnlyWithdrawals,
  determinismMismatchCount,
  resolutionInvariantFailureCount,
  forbiddenTruthPayloads,
  maxResolvedEntries,
  maxEvidenceRecords,
  supportingCompletedOperationRefs,
  finalResolved,
  finalEvidence,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalLedgerHash: hash(uninterrupted.incidentLedger),
}, null, 2));

import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const {
  applyIncidentResponseEvidenceResourceUse,
  assignIncidentResponseTeam,
  deriveIncidentDispatchCapacity,
  dispatchIncidentResponseTeam,
  incidentResponseDebriefs,
  incidentResponseOperations,
  incidentResponseResourceReservations,
  resolvePersistedIncident,
  standDownIncidentResponseTeam,
  synchronizeIncidentLedger,
  synchronizeIncidentResponseDebriefs,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

const FORBIDDEN = ['title','summary','detail','text','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed','responseSucceeded','causedResolution','interpretation','causalAssessment'];

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { result ^= payload.charCodeAt(index); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function debriefInvariantFailures(state) {
  synchronizeIncidentResponseDebriefs(state);
  const debriefs = state.incidentResponseDebriefs?.debriefs ?? [];
  let failures = state.incidentResponseDebriefs?.schemaVersion === 1 ? 0 : 1;
  const operations = new Map((state.incidentResponseOperations?.operations ?? []).map((entry) => [entry.id, entry]));
  const teams = new Map((state.incidentDispatch?.teams ?? []).map((entry) => [entry.id, entry]));
  const reservations = new Map((state.incidentResponseResources?.reservations ?? []).map((entry) => [entry.operationId, entry]));
  const usesByOperation = new Map();
  for (const use of state.incidentResponseEvidenceUses?.uses ?? []) {
    const rows = usesByOperation.get(use.operationId) ?? [];
    rows.push(use);
    usesByOperation.set(use.operationId, rows);
  }
  for (const rows of usesByOperation.values()) rows.sort((a, b) => a.ordinal - b.ordinal);
  const ledger = new Map((state.incidentLedger?.entries ?? []).map((entry) => [`${entry.contextKey}|${entry.incidentId}`, entry]));
  const seen = new Set();
  for (const debrief of debriefs) {
    if (seen.has(debrief.operationId)) failures += 1;
    seen.add(debrief.operationId);
    if (FORBIDDEN.some((field) => Object.hasOwn(debrief, field))) failures += 1;
    const operation = operations.get(debrief.operationId);
    const team = teams.get(debrief.teamId);
    if (!operation || !['completed','aborted'].includes(operation.phase)) { failures += 1; continue; }
    if (!team || team.phase !== 'stood-down') failures += 1;
    if (debrief.terminalPhase !== operation.phase) failures += 1;
    const terminalAt = operation.completedAt ?? operation.abortedAt;
    if (debrief.generatedAt !== terminalAt || debrief.chronology.terminalAt !== terminalAt || debrief.chronology.startedAt !== operation.startedAt) failures += 1;
    if (JSON.stringify(debrief.memberIds) !== JSON.stringify([...team.memberIds].sort())) failures += 1;
    if (JSON.stringify(debrief.observations) !== JSON.stringify(operation.observations)) failures += 1;
    const entry = ledger.get(`${debrief.contextKey}|${debrief.incidentId}`);
    const expectedEvidence = entry?.lastResolutionEvidence?.supportingOperationIds.includes(debrief.operationId) ? [entry.lastResolutionEvidence] : [];
    if (JSON.stringify(debrief.positiveEvidence) !== JSON.stringify(expectedEvidence)) failures += 1;
    const expectedUses = usesByOperation.get(debrief.operationId) ?? [];
    if (JSON.stringify(debrief.evidenceResourceUses) !== JSON.stringify(expectedUses)) failures += 1;
    const reservation = reservations.get(debrief.operationId);
    if (JSON.stringify(debrief.resourceReservation ?? null) !== JSON.stringify(reservation ?? null)) failures += 1;
    const refresh = Math.max(
      terminalAt ?? 0,
      ...operation.observations.map((entry) => entry.observedAt),
      reservation?.lastUpdatedAt ?? 0,
      ...expectedUses.map((entry) => entry.recordedAt),
      ...expectedEvidence.map((entry) => entry.observedAt),
    );
    if (debrief.lastRefreshedAt !== refresh) failures += 1;
  }
  for (const operation of operations.values()) if (['completed','aborted'].includes(operation.phase) && !seen.has(operation.id)) failures += 1;
  return failures;
}

function forbiddenTruthCount(state) {
  return (state.incidentResponseDebriefs?.debriefs ?? []).filter((debrief) => FORBIDDEN.some((field) => Object.hasOwn(debrief, field))).length;
}

function dispatchOne(state, incidentId) {
  const capacity = deriveIncidentDispatchCapacity(state, incidentId);
  assert.ok(capacity.canAssign && capacity.availableMemberIds.length > 0);
  const team = assignIncidentResponseTeam(state, incidentId, capacity.availableMemberIds.slice(0, 1));
  return dispatchIncidentResponseTeam(state, team.id);
}

const provider = new MockWorldProvider();
const initial = await createInitialSandboxState(provider, { seed: 0x12080017, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));

let comparisons = 0;
let reloads = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let forbiddenTruthPayloads = 0;
let maxDebriefs = 0;
let completedDebriefs = 0;
let abortedDebriefs = 0;
let positiveEvidenceFacts = 0;
let evidenceResourceUseFacts = 0;

for (let step = 0; step <= 120; step += 1) {
  const states = [uninterrupted, reloadPath];

  if (step === 0) {
    for (const state of states) {
      const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
      assert.ok(patient);
      patient.pathology.push({ id: 'case:i2h:audit-wound', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 75, contagious: false, observedSymptoms: ['audit wound'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
      synchronizeIncidentLedger(state);
      const incidentId = 'incident:settlement:injury';
      const first = dispatchOne(state, incidentId);
      const second = dispatchOne(state, incidentId);
      standDownIncidentResponseTeam(state, second.id);
      assert.equal(incidentResponseOperations(state, incidentId).find((entry) => entry.teamId === first.id)?.phase, 'mobilizing');
      assert.equal(incidentResponseDebriefs(state, incidentId).filter((entry) => entry.terminalPhase === 'aborted').length, 1);
    }
  }

  if (step === 1) {
    for (const state of states) {
      const incidentId = 'incident:settlement:injury';
      const completed = incidentResponseOperations(state, incidentId).find((entry) => entry.phase === 'completed');
      assert.ok(completed);
      const patient = state.agents.find((agent) => agent.pathology.some((entry) => entry.id === 'case:i2h:audit-wound'));
      assert.ok(patient);
      patient.pathology.find((entry) => entry.id === 'case:i2h:audit-wound').status = 'resolved';
      assert.equal(resolvePersistedIncident(state, incidentId), true);
      const reservation = incidentResponseResourceReservations(state, incidentId).find((entry) => entry.operationId === completed.id);
      assert.ok(reservation && reservation.returned.medicine > 0);
      const amount = Number((reservation.returned.medicine / 2).toFixed(6));
      applyIncidentResponseEvidenceResourceUse(state, incidentId, { medicine: amount });
      const debrief = incidentResponseDebriefs(state, incidentId).find((entry) => entry.operationId === completed.id);
      assert.equal(debrief.positiveEvidence[0]?.kind, 'recorded-case-cleared');
      assert.equal(debrief.evidenceResourceUses.length, 1);
    }
  }

  for (const state of states) {
    comparisons += 1;
    invariantFailureCount += debriefInvariantFailures(state);
    forbiddenTruthPayloads += forbiddenTruthCount(state);
    const debriefs = state.incidentResponseDebriefs?.debriefs ?? [];
    maxDebriefs = Math.max(maxDebriefs, debriefs.length);
  }

  if (JSON.stringify(uninterrupted.incidentLedger) !== JSON.stringify(reloadPath.incidentLedger)
    || JSON.stringify(uninterrupted.incidentDispatch) !== JSON.stringify(reloadPath.incidentDispatch)
    || JSON.stringify(uninterrupted.incidentResponseOperations) !== JSON.stringify(reloadPath.incidentResponseOperations)
    || JSON.stringify(uninterrupted.incidentResponseResources) !== JSON.stringify(reloadPath.incidentResponseResources)
    || JSON.stringify(uninterrupted.incidentResponseEvidenceUses) !== JSON.stringify(reloadPath.incidentResponseEvidenceUses)
    || JSON.stringify(uninterrupted.incidentResponseDebriefs) !== JSON.stringify(reloadPath.incidentResponseDebriefs)
    || JSON.stringify(uninterrupted.settlement.resources) !== JSON.stringify(reloadPath.settlement.resources)) determinismMismatchCount += 1;

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);

  if ((step + 1) % 4 === 0) {
    const beforeDebriefs = structuredClone(reloadPath.incidentResponseDebriefs);
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    assert.deepEqual(reloadPath.incidentResponseDebriefs, beforeDebriefs, 'I2-H debrief projections must survive save/reload exactly');
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

const finalDebriefs = uninterrupted.incidentResponseDebriefs?.debriefs ?? [];
completedDebriefs = finalDebriefs.filter((entry) => entry.terminalPhase === 'completed').length;
abortedDebriefs = finalDebriefs.filter((entry) => entry.terminalPhase === 'aborted').length;
positiveEvidenceFacts = finalDebriefs.reduce((sum, entry) => sum + entry.positiveEvidence.length, 0);
evidenceResourceUseFacts = finalDebriefs.reduce((sum, entry) => sum + entry.evidenceResourceUses.length, 0);

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(forbiddenTruthPayloads, 0);
assert.ok(completedDebriefs > 0);
assert.ok(abortedDebriefs > 0);
assert.ok(positiveEvidenceFacts > 0);
assert.ok(evidenceResourceUseFacts > 0);
assert.deepEqual(reloadPath.incidentResponseDebriefs, uninterrupted.incidentResponseDebriefs);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  determinismMismatchCount,
  invariantFailureCount,
  forbiddenTruthPayloads,
  maxDebriefs,
  completedDebriefs,
  abortedDebriefs,
  positiveEvidenceFacts,
  evidenceResourceUseFacts,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalDebriefHash: hash(uninterrupted.incidentResponseDebriefs),
}, null, 2));

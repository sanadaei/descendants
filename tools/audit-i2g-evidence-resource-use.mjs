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
  incidentResponseOperations,
  incidentResponseResourceReservations,
  resolvePersistedIncident,
  synchronizeIncidentLedger,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

const FORBIDDEN = ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure','resolved','causeConfirmed','responseSucceeded','causedResolution'];
const MEDICINE_KINDS = new Set(['recorded-case-cleared','field-health-threshold']);
const TOOL_KINDS = new Set(['communication-restored','encounter-resolved','research-sample-present']);

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { result ^= payload.charCodeAt(index); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function invariantFailures(state) {
  const uses = state.incidentResponseEvidenceUses?.uses ?? [];
  let failures = state.incidentResponseEvidenceUses?.schemaVersion === 1 ? 0 : 1;
  const operations = new Map((state.incidentResponseOperations?.operations ?? []).map((entry) => [entry.id, entry]));
  const reservations = new Map((state.incidentResponseResources?.reservations ?? []).map((entry) => [entry.id, entry]));
  const ledgers = new Map((state.incidentLedger?.entries ?? []).map((entry) => [`${entry.contextKey}|${entry.incidentId}`, entry]));
  const pairKeys = new Set();
  const totals = new Map();
  for (const use of uses) {
    if (use.id !== `incident-response-evidence-use:${use.ordinal.toString(36)}`) failures += 1;
    if (!(use.medicine > 0 || use.tools > 0)) failures += 1;
    if (use.medicine > 0 && !MEDICINE_KINDS.has(use.evidenceKind)) failures += 1;
    if (use.tools > 0 && !TOOL_KINDS.has(use.evidenceKind)) failures += 1;
    if (FORBIDDEN.some((field) => Object.hasOwn(use, field))) failures += 1;
    const operation = operations.get(use.operationId);
    const reservation = reservations.get(use.reservationId);
    const ledgerKey = `${use.contextKey}|${use.incidentId}`;
    const ledger = ledgers.get(ledgerKey);
    if (!operation || operation.phase !== 'completed' || operation.contextKey !== use.contextKey || operation.incidentId !== use.incidentId) failures += 1;
    if (!reservation || reservation.phase !== 'settled' || reservation.operationId !== use.operationId) failures += 1;
    if (!ledger || use.evidenceOccurrenceNumber > ledger.occurrenceCount) failures += 1;
    if (use.evidenceId !== `incident-resolution-evidence:${use.evidenceOccurrenceNumber.toString(36)}:${ledgerKey}`) failures += 1;
    const pair = `${use.operationId}|${use.evidenceId}`;
    if (pairKeys.has(pair)) failures += 1;
    pairKeys.add(pair);
    const sum = totals.get(use.reservationId) ?? { medicine: 0, tools: 0 };
    sum.medicine += use.medicine;
    sum.tools += use.tools;
    totals.set(use.reservationId, sum);
  }
  for (const reservation of reservations.values()) {
    const sum = totals.get(reservation.id) ?? { medicine: 0, tools: 0 };
    if (Math.abs(reservation.consumed.medicine - sum.medicine) > 1e-6) failures += 1;
    if (Math.abs(reservation.consumed.tools - sum.tools) > 1e-6) failures += 1;
  }
  return failures;
}

function forbiddenTruthCount(state) {
  return (state.incidentResponseEvidenceUses?.uses ?? []).filter((use) => FORBIDDEN.some((field) => Object.hasOwn(use, field))).length;
}

function dispatchFirst(state, incidentId) {
  const capacity = deriveIncidentDispatchCapacity(state, incidentId);
  assert.ok(capacity.canAssign && capacity.availableMemberIds.length > 0);
  const team = assignIncidentResponseTeam(state, incidentId, capacity.availableMemberIds.slice(0, 1));
  return dispatchIncidentResponseTeam(state, team.id);
}

const provider = new MockWorldProvider();
const initial = await createInitialSandboxState(provider, { seed: 0x12070017, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));

let comparisons = 0;
let reloads = 0;
let appliedUses = 0;
let rejectedUses = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let forbiddenTruthPayloads = 0;
let maxUseRecords = 0;
let reconciledMedicine = 0;

for (let step = 0; step <= 120; step += 1) {
  const states = [uninterrupted, reloadPath];

  if (step === 0) {
    for (const state of states) {
      const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
      assert.ok(patient);
      patient.pathology.push({
        id: 'case:i2g:audit-wound', pathologyId: 'traumatic-wound', onsetDay: state.clock.day,
        severity: 75, contagious: false, observedSymptoms: ['audit wound'], suspectedCauses: [], treatmentsTried: [], status: 'active',
      });
      synchronizeIncidentLedger(state);
      dispatchFirst(state, 'incident:settlement:injury');
      assert.equal(resolvePersistedIncident(state, 'incident:settlement:injury'), false);
      assert.throws(() => applyIncidentResponseEvidenceResourceUse(state, 'incident:settlement:injury', { medicine: 0.001 }), /requires current explicit positive resolution evidence/i);
      rejectedUses += 1;
    }
  }

  if (step === 1) {
    for (const state of states) {
      const operation = incidentResponseOperations(state, 'incident:settlement:injury')[0];
      assert.equal(operation.phase, 'completed');
      const patient = state.agents.find((agent) => agent.pathology.some((entry) => entry.id === 'case:i2g:audit-wound'));
      assert.ok(patient);
      patient.pathology.find((entry) => entry.id === 'case:i2g:audit-wound').status = 'resolved';
      assert.equal(resolvePersistedIncident(state, 'incident:settlement:injury'), true);
      const reservation = incidentResponseResourceReservations(state, 'incident:settlement:injury')[0];
      const amount = Number((reservation.returned.medicine / 2).toFixed(6));
      assert.ok(amount > 0);
      const use = applyIncidentResponseEvidenceResourceUse(state, 'incident:settlement:injury', { medicine: amount });
      assert.equal(use.evidenceKind, 'recorded-case-cleared');
      appliedUses += 1;
      reconciledMedicine += amount;
      assert.throws(() => applyIncidentResponseEvidenceResourceUse(state, 'incident:settlement:injury', { tools: 0.001 }), /does not authorize tools reconciliation/i);
      rejectedUses += 1;
    }
  }

  for (const state of states) {
    comparisons += 1;
    invariantFailureCount += invariantFailures(state);
    forbiddenTruthPayloads += forbiddenTruthCount(state);
    maxUseRecords = Math.max(maxUseRecords, state.incidentResponseEvidenceUses?.uses.length ?? 0);
  }

  if (JSON.stringify(uninterrupted.incidentLedger) !== JSON.stringify(reloadPath.incidentLedger)
    || JSON.stringify(uninterrupted.incidentDispatch) !== JSON.stringify(reloadPath.incidentDispatch)
    || JSON.stringify(uninterrupted.incidentResponseOperations) !== JSON.stringify(reloadPath.incidentResponseOperations)
    || JSON.stringify(uninterrupted.incidentResponseResources) !== JSON.stringify(reloadPath.incidentResponseResources)
    || JSON.stringify(uninterrupted.incidentResponseEvidenceUses) !== JSON.stringify(reloadPath.incidentResponseEvidenceUses)
    || JSON.stringify(uninterrupted.settlement.resources) !== JSON.stringify(reloadPath.settlement.resources)) determinismMismatchCount += 1;

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);

  if ((step + 1) % 4 === 0) {
    const beforeUses = structuredClone(reloadPath.incidentResponseEvidenceUses);
    const beforeResources = structuredClone(reloadPath.incidentResponseResources);
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    assert.deepEqual(reloadPath.incidentResponseEvidenceUses, beforeUses, 'I2-G evidence resource-use state must survive save/reload exactly');
    assert.deepEqual(reloadPath.incidentResponseResources, beforeResources, 'I2-G reconciled resource accounting must survive save/reload exactly');
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(forbiddenTruthPayloads, 0);
assert.ok(appliedUses > 0);
assert.ok(rejectedUses > 0);
assert.deepEqual(reloadPath.incidentResponseEvidenceUses, uninterrupted.incidentResponseEvidenceUses);
assert.deepEqual(reloadPath.incidentResponseResources, uninterrupted.incidentResponseResources);
assert.deepEqual(reloadPath.settlement.resources, uninterrupted.settlement.resources);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  appliedUses,
  rejectedUses,
  determinismMismatchCount,
  invariantFailureCount,
  forbiddenTruthPayloads,
  maxUseRecords,
  reconciledMedicine: Number((reconciledMedicine / 2).toFixed(6)),
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalUseHash: hash(uninterrupted.incidentResponseEvidenceUses),
  finalResourceHash: hash(uninterrupted.incidentResponseResources),
}, null, 2));

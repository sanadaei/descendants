import { readSandboxUiSource } from '../tools/read-sandbox-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import {
  applyIncidentResponseEvidenceResourceUse,
  assignIncidentResponseTeam,
  assignIncidentResponseRosterTeam,
  deriveIncidentDispatchCapacity,
  deriveIncidentResponseRosterPlan,
  deriveIncidentResponseLogisticsPlan,
  deriveIncidentResponseCoordinationPlan,
  executeIncidentResponseCoordinationRequest,
  executeIncidentResponseCoordinationBatch,
  deriveIncidentResponseCoordinationReadback,
  deriveIncidentResponseCoordinationRetryPlan,
  executeIncidentResponseCoordinationRetry,
  createIncidentResponseExternalReceiptRegistry,
  registerIncidentResponseCoordinationReceipt,
  recordIncidentResponseExternalRetryExecution,
  exportIncidentResponseExternalReceiptRegistry,
  importIncidentResponseExternalReceiptRegistry,
  deriveIncidentResponseExternalRetryQueueGuidance,
  executeIncidentResponseExternalRetryQueueItem,
  executeIncidentResponseExternalRetryQueueBatch,
  deriveIncidentResponseExternalBatchReadback,
  deriveIncidentResponseExternalBatchRetryPlan,
  executeIncidentResponseExternalBatchRetry,
  filterIncidentResponseExternalBatchReadback,
  exportIncidentResponseExternalBatchReadbackSnapshot,
  importIncidentResponseExternalBatchReadbackSnapshot,
  deriveIncidentResponseExternalReviewBatchReplan,
  derivePositiveIncidentResolutionEvidence,
  deriveVisibleIncidentProjection,
  dispatchIncidentResponseTeam,
  incidentResponseTeams,
  incidentResponseOperations,
  incidentResponseResourceReservations,
  incidentResponseEvidenceResourceUses,
  incidentResponseDebriefs,
  incidentResponseReadinessEntries,
  synchronizeIncidentResponseDebriefs,
  synchronizeIncidentResponseReadiness,
  incidentCandidateFromVisibleSituation,
  isI2F1IncidentAdapterEnabled,
  projectIncidents,
  resolvePersistedIncident,
  selectF1IncidentReadModel,
  standDownIncidentResponseTeam,
  synchronizeIncidentLedger,
  synchronizeIncidentResponseOperations,
} from '../.test-dist/sandbox/incidentService.js';
import { advanceSandbox } from '../.test-dist/sandbox/engine.js';
import { synthesizeVisibleSituations } from '../.test-dist/sandbox/situationSynthesis.js';
import { launchExpedition } from '../.test-dist/sandbox/expeditionSimulation.js';
import { importSandboxSave, sandboxRepository } from '../.test-dist/sandbox/storage.js';

async function fixture(seed = 0x120a001) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed, population: 14 });
  return { provider, state };
}

function candidate(overrides = {}) {
  return {
    id: 'incident:test',
    templateId: 'test',
    causeRefs: ['cause:1'],
    subjectIds: ['cause:1'],
    siteNodeIds: [],
    requiredKnowledgeClaimIds: [],
    urgency: 'medium',
    cooldownKey: 'test',
    cooldownMinutes: 60,
    causalDedupeKey: 'test',
    eligible: true,
    knowledgeSafe: true,
    legacySeverity: 'watch',
    presentation: { title: 'Test', summary: 'Visible test summary', sourceLabel: 'TEST', visibleStakeText: 'Visible test summary' },
    ...overrides,
  };
}

test('I2 incident adapter is default OFF', () => {
  assert.equal(isI2F1IncidentAdapterEnabled(), false);
});

test('I2 eligibility and knowledge gate execute before ranking', () => {
  const result = projectIncidents([
    candidate({ id: 'incident:hidden', urgency: 'critical', knowledgeSafe: false, causalDedupeKey: 'hidden' }),
    candidate({ id: 'incident:ineligible', urgency: 'critical', eligible: false, causalDedupeKey: 'ineligible' }),
    candidate({ id: 'incident:visible', urgency: 'low', causalDedupeKey: 'visible' }),
  ], { nowMinute: 1000 });
  assert.deepEqual(result.incidents.map((entry) => entry.id), ['incident:visible']);
  assert.equal(result.audit.knowledgeRejectedCount, 1);
  assert.equal(result.audit.ineligibleCount, 1);
});

test('I2 causal dedupe retains the higher-ranked visible candidate', () => {
  const result = projectIncidents([
    candidate({ id: 'incident:low', urgency: 'low', causalDedupeKey: 'same' }),
    candidate({ id: 'incident:high', urgency: 'high', causalDedupeKey: 'same' }),
  ], { nowMinute: 1000 });
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].id, 'incident:high');
  assert.equal(result.audit.dedupedCount, 1);
});

test('I2 ranking is urgency-first and deterministic with presented/queued phases', () => {
  const result = projectIncidents([
    candidate({ id: 'incident:medium-b', urgency: 'medium', causalDedupeKey: 'b' }),
    candidate({ id: 'incident:high', urgency: 'high', causalDedupeKey: 'h' }),
    candidate({ id: 'incident:medium-a', urgency: 'medium', causalDedupeKey: 'a' }),
  ], { nowMinute: 1000 });
  assert.deepEqual(result.incidents.map((entry) => entry.id), ['incident:high','incident:medium-a','incident:medium-b']);
  assert.equal(result.incidents[0].phase, 'presented');
  assert.ok(result.incidents.slice(1).every((entry) => entry.phase === 'queued'));
});

test('I2 repetition control suppresses cooldown candidates and applies exposure debt', () => {
  const suppressed = projectIncidents([candidate()], { nowMinute: 1000, lastPresentedAt: { test: 970 } });
  assert.equal(suppressed.incidents.length, 0);
  assert.equal(suppressed.audit.cooldownRejectedCount, 1);
  const fresh = projectIncidents([candidate()], { nowMinute: 1100, exposureCounts: { test: 3 } });
  assert.equal(fresh.incidents[0].repetitionDebt, 12);
});

test('I2 visible situation ingestion preserves only player-facing text and explicit basis refs', () => {
  const signal = { id: 'external-pressure:known', severity: 'watch', title: 'Known pressure', detail: 'Only observed pressure is shown.', basisIds: ['known:actor','known:report'] };
  const incident = incidentCandidateFromVisibleSituation(signal);
  assert.equal(incident.knowledgeSafe, true);
  assert.equal(incident.presentation.title, signal.title);
  assert.equal(incident.presentation.summary, signal.detail);
  assert.deepEqual(incident.causeRefs, signal.basisIds);
  assert.deepEqual(incident.siteNodeIds, []);
  assert.deepEqual(incident.requiredKnowledgeClaimIds, []);
});

test('I2 derived projection consumes the exact legacy visible situation seam', async () => {
  const { state } = await fixture();
  const legacy = synthesizeVisibleSituations(state, null, null);
  const projection = deriveVisibleIncidentProjection(state, null, null);
  assert.ok(legacy.length > 0);
  assert.ok(projection.incidents.length > 0);
  const legacyByTitle = new Map(legacy.map((entry) => [entry.title, entry]));
  for (const incident of projection.incidents) {
    const source = legacyByTitle.get(incident.presentation.title);
    assert.ok(source, `incident ${incident.id} must originate from visible SituationSignal`);
    assert.equal(incident.presentation.summary, source.detail);
    assert.deepEqual(incident.causeRefs, source.basisIds);
  }
});

test('I2 F1 read switch is opt-in and uses incident ranking only when enabled', async () => {
  const { state } = await fixture(0x120a002);
  const legacy = selectF1IncidentReadModel(state, null, null, false);
  const incident = selectF1IncidentReadModel(state, null, null, true);
  assert.equal(legacy.source, 'legacy');
  assert.equal(incident.source, 'incident');
  assert.ok(incident.rows.length > 0);
  assert.equal(incident.rows[0].title, incident.incidents[0].presentation.title);
  assert.equal(incident.rows[0].detail, incident.incidents[0].presentation.summary);
});

test('I2 F1 source wiring centralizes task list/detail on the same adapter read model', async () => {
  const app = await readSandboxUiSource();
  assert.match(app, /import \{ selectF1IncidentReadModel \} from '\.\/incidentService\.js'/);
  assert.match(app, /private f1SituationReadModel\(\)/);
  assert.match(app, /return selectF1IncidentReadModel\((?:this|ctx)\.state, field, field \? (?:this|ctx)\.#?localProjection : null\)/);
  assert.match(app, /private pdaTaskList\(read = (?:this|ctx)\.f1SituationReadModel\(\)\)/);
  assert.match(app, /const incidentRead = (?:this|ctx)\.f1SituationReadModel\(\)/);
  assert.match(app, /(?:this|ctx)\.pdaTaskList\(incidentRead\)/);
  assert.match(app, /const selectedIncident = (?:this|ctx)\.selectedF1Incident\(incidentRead\)/);
});

test('I2-B bootstrap creates a bounded observer-safe incident lifecycle sidecar without presentation text', async () => {
  const { state } = await fixture(0x120b001);
  assert.equal(state.incidentLedger?.schemaVersion, 1);
  assert.ok((state.incidentLedger?.entries.length ?? 0) > 0);
  assert.ok((state.incidentLedger?.entries.length ?? 0) <= 256);
  for (const entry of state.incidentLedger?.entries ?? []) {
    assert.equal(entry.phase, 'active');
    assert.equal(Object.hasOwn(entry, 'title'), false);
    assert.equal(Object.hasOwn(entry, 'summary'), false);
    assert.equal(Object.hasOwn(entry, 'detail'), false);
    assert.equal(Object.hasOwn(entry, 'presentation'), false);
  }
});

test('I2-B synchronization is idempotent for the same canonical state and minute', async () => {
  const { state } = await fixture(0x120b002);
  const before = structuredClone(state.incidentLedger);
  synchronizeIncidentLedger(state);
  synchronizeIncidentLedger(state);
  assert.deepEqual(state.incidentLedger, before);
});

test('I2-B disappearing visibility withdraws an incident instead of claiming world resolution, then reactivates it', async () => {
  const { state } = await fixture(0x120b003);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const key = 'settlement|incident:settlement:water-low';
  const active = state.incidentLedger.entries.find((entry) => entry.key === key);
  assert.equal(active?.phase, 'active');
  assert.equal(active?.occurrenceCount, 1);

  state.settlement.resources.water = 99999;
  synchronizeIncidentLedger(state);
  const withdrawn = state.incidentLedger.entries.find((entry) => entry.key === key);
  assert.equal(withdrawn?.phase, 'withdrawn');
  assert.equal(typeof withdrawn?.terminalAt, 'number');

  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const reactivated = state.incidentLedger.entries.find((entry) => entry.key === key);
  assert.equal(reactivated?.phase, 'active');
  assert.equal(reactivated?.occurrenceCount, 2);
  assert.equal(reactivated?.terminalAt, undefined);
  assert.equal(state.incidentLedger.entries.filter((entry) => entry.key === key).length, 1);
});

test('I2-F direct resolution fails closed until an explicit positive threshold is currently satisfied', async () => {
  const { state } = await fixture(0x120b004);
  state.settlement.resources.food = 0;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:food-low';
  assert.equal(derivePositiveIncidentResolutionEvidence(state, incidentId), null);
  assert.equal(resolvePersistedIncident(state, incidentId), false);
  assert.equal(state.incidentLedger.entries.find((entry) => entry.incidentId === incidentId)?.phase, 'active');

  const localPopulation = state.agents.filter((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement').length;
  state.settlement.resources.food = localPopulation * 2;
  const evidence = derivePositiveIncidentResolutionEvidence(state, incidentId);
  assert.equal(evidence?.kind, 'settlement-resource-threshold');
  assert.equal(evidence?.metric, 'food');
  assert.equal(evidence?.comparison, 'gte');
  assert.ok(evidence.observedValue >= evidence.thresholdValue);
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const resolved = state.incidentLedger.entries.find((entry) => entry.incidentId === incidentId);
  assert.equal(resolved?.phase, 'resolved');
  assert.deepEqual(resolved?.lastResolutionEvidence, evidence);

  state.settlement.resources.food = 0;
  synchronizeIncidentLedger(state);
  const reactivated = state.incidentLedger.entries.find((entry) => entry.incidentId === incidentId);
  assert.equal(reactivated?.phase, 'active');
  assert.equal(reactivated?.occurrenceCount, 2);
  assert.equal(reactivated?.lastResolutionEvidence?.occurrenceNumber, 1);
});

test('I2-B legacy schemaVersion=1 save without incidentLedger migrates deterministically and reexports the sidecar', async () => {
  const { state } = await fixture(0x120b005);
  const legacy = structuredClone(state);
  delete legacy.incidentLedger;
  const restored = importSandboxSave(JSON.stringify(legacy));
  assert.equal(restored.incidentLedger?.schemaVersion, 1);
  assert.ok((restored.incidentLedger?.entries.length ?? 0) > 0);
  const exported = sandboxRepository.exportJson(restored);
  assert.match(exported, /"incidentLedger"\s*:/);
  const roundTrip = importSandboxSave(exported);
  assert.deepEqual(roundTrip.incidentLedger, restored.incidentLedger);
});

test('I2-B persistence rejects incident ledger payloads that attempt to persist presentation text', async () => {
  const { state } = await fixture(0x120b006);
  const broken = structuredClone(state);
  broken.incidentLedger.entries[0].title = 'hidden or stale presentation';
  assert.throws(() => importSandboxSave(JSON.stringify(broken)), /illegally persists presentation text/i);
});


test('I2-C bootstrap creates an empty bounded dispatch sidecar without creating work or quests', async () => {
  const { state } = await fixture(0x120c001);
  assert.equal(state.incidentDispatch?.schemaVersion, 1);
  assert.equal(state.incidentDispatch?.nextDispatchOrdinal, 1);
  assert.deepEqual(state.incidentDispatch?.teams, []);
});

test('I2-C assignment consumes response capacity without mutating agent tasks, time, or incident truth', async () => {
  const { state } = await fixture(0x120c002);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const capacity = deriveIncidentDispatchCapacity(state, incident.id);
  assert.equal(capacity.incidentActive, true);
  assert.ok(capacity.availableMemberIds.length >= 2);
  const beforeClock = structuredClone(state.clock);
  const beforeTasks = state.agents.map((agent) => [agent.id, agent.currentTask]);
  const beforeLedger = structuredClone(state.incidentLedger);
  const team = assignIncidentResponseTeam(state, incident.id, capacity.availableMemberIds.slice(0, 2));
  assert.equal(team.phase, 'assigned');
  assert.deepEqual(state.clock, beforeClock);
  assert.deepEqual(state.agents.map((agent) => [agent.id, agent.currentTask]), beforeTasks);
  assert.deepEqual(state.incidentLedger, beforeLedger);
  assert.equal(Object.hasOwn(team, 'outcome'), false);
  assert.equal(Object.hasOwn(team, 'presentation'), false);
});

test('I2-C multi-team dispatch prevents double booking and enforces three teams per incident', async () => {
  const { state } = await fixture(0x120c003);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const initial = deriveIncidentDispatchCapacity(state, incident.id);
  assert.ok(initial.availableMemberIds.length >= 4);
  const [a,b,c,d] = initial.availableMemberIds;
  const first = assignIncidentResponseTeam(state, incident.id, [a]);
  assert.throws(() => assignIncidentResponseTeam(state, incident.id, [a]), /unavailable or already committed/i);
  const second = assignIncidentResponseTeam(state, incident.id, [b]);
  const third = assignIncidentResponseTeam(state, incident.id, [c]);
  assert.throws(() => assignIncidentResponseTeam(state, incident.id, [d]), /maximum number of active response teams/i);
  assert.equal(deriveIncidentDispatchCapacity(state, incident.id).activeIncidentTeamCount, 3);
  assert.deepEqual(incidentResponseTeams(state, incident.id).map((team) => team.id), [first.id, second.id, third.id]);
});

test('I2-C dispatch records commitment only and never resolves the incident', async () => {
  const { state } = await fixture(0x120c004);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const beforeClock = structuredClone(state.clock);
  const beforeLedger = structuredClone(state.incidentLedger);
  const assigned = assignIncidentResponseTeam(state, incident.id, [member]);
  const dispatched = dispatchIncidentResponseTeam(state, assigned.id);
  assert.equal(dispatched.phase, 'dispatched');
  assert.equal(typeof dispatched.dispatchedAt, 'number');
  assert.deepEqual(state.clock, beforeClock);
  assert.deepEqual(state.incidentLedger, beforeLedger);
  assert.equal(state.incidentLedger.entries.find((entry) => entry.incidentId === incident.id)?.phase, 'active');
});

test('I2-C dispatch refuses a withdrawn no-longer-visible incident without inventing an outcome', async () => {
  const { state } = await fixture(0x120c005);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const assigned = assignIncidentResponseTeam(state, incidentId, [member]);
  state.settlement.resources.water = 99999;
  synchronizeIncidentLedger(state);
  assert.equal(state.incidentLedger.entries.find((entry) => entry.incidentId === incidentId)?.phase, 'withdrawn');
  assert.throws(() => dispatchIncidentResponseTeam(state, assigned.id), /no longer currently observer-visible/i);
  const persisted = state.incidentDispatch.teams.find((team) => team.id === assigned.id);
  assert.equal(persisted.phase, 'assigned');
  assert.equal(persisted.dispatchedAt, undefined);
});

test('I2-C stand-down releases member and team-slot capacity but does not resolve the incident', async () => {
  const { state } = await fixture(0x120c006);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const before = deriveIncidentDispatchCapacity(state, incident.id);
  const member = before.availableMemberIds[0];
  const assigned = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, assigned.id);
  const committed = deriveIncidentDispatchCapacity(state, incident.id);
  assert.equal(committed.availableMemberIds.includes(member), false);
  const stood = standDownIncidentResponseTeam(state, assigned.id);
  assert.equal(stood.phase, 'stood-down');
  const released = deriveIncidentDispatchCapacity(state, incident.id);
  assert.equal(released.availableMemberIds.includes(member), true);
  assert.equal(state.incidentLedger.entries.find((entry) => entry.incidentId === incident.id)?.phase, 'active');
});

test('I2-C legacy save without incidentDispatch migrates deterministically and round-trips allocations', async () => {
  const { state } = await fixture(0x120c007);
  const legacy = structuredClone(state);
  delete legacy.incidentDispatch;
  const restored = importSandboxSave(JSON.stringify(legacy));
  assert.deepEqual(restored.incidentDispatch, { schemaVersion: 1, nextDispatchOrdinal: 1, teams: [] });
  const incident = deriveVisibleIncidentProjection(restored, null, null).incidents[0];
  const members = deriveIncidentDispatchCapacity(restored, incident.id).availableMemberIds.slice(0, 2);
  const team = assignIncidentResponseTeam(restored, incident.id, members);
  dispatchIncidentResponseTeam(restored, team.id);
  const roundTrip = importSandboxSave(sandboxRepository.exportJson(restored));
  assert.deepEqual(roundTrip.incidentDispatch, restored.incidentDispatch);
});

test('I2-C persistence rejects overlapping active members and outcome/presentation truth injection', async () => {
  const { state } = await fixture(0x120c008);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const [a,b] = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds;
  assignIncidentResponseTeam(state, incident.id, [a]);
  const second = assignIncidentResponseTeam(state, incident.id, [b]);
  const overlap = structuredClone(state);
  overlap.incidentDispatch.teams.find((team) => team.id === second.id).memberIds = [a];
  assert.throws(() => importSandboxSave(JSON.stringify(overlap)), /committed to multiple active teams/i);
  const injected = structuredClone(state);
  injected.incidentDispatch.teams[0].outcome = 'success';
  assert.throws(() => importSandboxSave(JSON.stringify(injected)), /illegally persists incident presentation\/outcome truth/i);
});

test('I2-D bootstrap creates an empty asynchronous response-operation sidecar', async () => {
  const { state } = await fixture(0x120d001);
  assert.deepEqual(state.incidentResponseOperations, { schemaVersion: 1, nextObservationOrdinal: 1, operations: [] });
});

test('I2-D/I2-E dispatch starts an operation clock and bounded reservation without consuming time or changing incident truth', async () => {
  const { state } = await fixture(0x120d002);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const beforeClock = structuredClone(state.clock);
  const beforeResources = structuredClone(state.settlement.resources);
  const beforeTasks = state.agents.map((agent) => [agent.id, agent.currentTask]);
  const beforeLedger = structuredClone(state.incidentLedger);
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const [operation] = incidentResponseOperations(state, incident.id);
  const [reservation] = incidentResponseResourceReservations(state, incident.id);
  assert.equal(operation.phase, 'mobilizing');
  assert.equal(operation.startedAt, operation.lastAdvancedAt);
  assert.equal(operation.mobilizationMinutesRemaining, operation.plannedMobilizationMinutes);
  assert.equal(operation.workMinutesRemaining, operation.plannedWorkMinutes);
  assert.equal(operation.returnMinutesRemaining, operation.plannedReturnMinutes);
  assert.deepEqual(operation.observations, []);
  assert.equal(reservation.phase, 'reserved');
  assert.deepEqual(reservation.consumed, { food: 0, water: 0, medicine: 0, tools: 0 });
  assert.equal(Number((state.settlement.resources.food + reservation.reserved.food).toFixed(6)), Number(beforeResources.food.toFixed(6)));
  assert.equal(Number((state.settlement.resources.water + reservation.reserved.water).toFixed(6)), Number(beforeResources.water.toFixed(6)));
  assert.equal(Number((state.settlement.resources.medicine + reservation.reserved.medicine).toFixed(6)), Number(beforeResources.medicine.toFixed(6)));
  assert.equal(Number((state.settlement.resources.scrap + reservation.reserved.tools).toFixed(6)), Number(beforeResources.scrap.toFixed(6)));
  assert.deepEqual(state.clock, beforeClock);
  assert.deepEqual(state.agents.map((agent) => [agent.id, agent.currentTask]), beforeTasks);
  assert.deepEqual(state.incidentLedger, beforeLedger);
});

test('I2-D canonical elapsed time advances mobilizing, work and return, then releases the team without resolving the incident', async () => {
  const { provider, state } = await fixture(0x120d003);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  let operation = incidentResponseOperations(state, incident.id)[0];
  await advanceSandbox(provider, state, operation.plannedMobilizationMinutes - 1);
  operation = incidentResponseOperations(state, incident.id)[0];
  assert.equal(operation.phase, 'mobilizing');
  assert.equal(operation.mobilizationMinutesRemaining, 1);
  await advanceSandbox(provider, state, 1);
  operation = incidentResponseOperations(state, incident.id)[0];
  assert.equal(operation.phase, 'working');
  assert.equal(typeof operation.arrivedAt, 'number');
  await advanceSandbox(provider, state, operation.workMinutesRemaining);
  operation = incidentResponseOperations(state, incident.id)[0];
  assert.equal(operation.phase, 'returning');
  assert.equal(typeof operation.workCompletedAt, 'number');
  assert.equal(operation.observations.filter((entry) => entry.kind === 'post-response-visibility').length, 1);
  await advanceSandbox(provider, state, operation.returnMinutesRemaining);
  operation = incidentResponseOperations(state, incident.id)[0];
  assert.equal(operation.phase, 'completed');
  assert.equal(typeof operation.completedAt, 'number');
  assert.equal(operation.observations.filter((entry) => entry.kind === 'return-complete').length, 1);
  assert.equal(incidentResponseTeams(state, incident.id)[0].phase, 'stood-down');
  const ledger = state.incidentLedger.entries.find((entry) => entry.incidentId === incident.id);
  assert.notEqual(ledger?.phase, 'resolved');
});

test('I2-D visibility loss is recorded as not-visible evidence and never promoted to success/resolution', async () => {
  const { provider, state } = await fixture(0x120d004);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  state.settlement.resources.water = 99999;
  synchronizeIncidentLedger(state);
  const initial = incidentResponseOperations(state, incidentId)[0];
  await advanceSandbox(provider, state, initial.plannedMobilizationMinutes + initial.plannedWorkMinutes);
  const operation = incidentResponseOperations(state, incidentId)[0];
  const check = operation.observations.find((entry) => entry.kind === 'post-response-visibility');
  assert.equal(check?.incidentVisibility, 'not-visible');
  assert.equal(state.incidentLedger.entries.find((entry) => entry.incidentId === incidentId)?.phase, 'withdrawn');
  assert.equal(Object.hasOwn(operation, 'success'), false);
  assert.equal(Object.hasOwn(operation, 'outcome'), false);
});

test('I2-D operator stand-down aborts active work, releases capacity, and records no incident outcome', async () => {
  const { state } = await fixture(0x120d005);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const stood = standDownIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incident.id)[0];
  assert.equal(stood.phase, 'stood-down');
  assert.equal(operation.phase, 'aborted');
  assert.equal(operation.observations.at(-1)?.kind, 'operator-stand-down');
  assert.equal(operation.observations.at(-1)?.incidentVisibility, 'not-checked');
  assert.equal(deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds.includes(member), true);
  assert.notEqual(state.incidentLedger.entries.find((entry) => entry.incidentId === incident.id)?.phase, 'resolved');
});

test('I2-D an unavailable responder fails closed to aborted work instead of fabricating completion', async () => {
  const { state } = await fixture(0x120d006);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const candidates = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds;
  const member = candidates.find((id) => id !== state.settlement.leaderId) ?? candidates[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  state.agents.find((agent) => agent.id === member).alive = false;
  state.clock.minuteOfDay += 1;
  synchronizeIncidentResponseOperations(state);
  const operation = incidentResponseOperations(state, incident.id)[0];
  assert.equal(operation.phase, 'aborted');
  assert.equal(operation.observations.at(-1)?.kind, 'team-unavailable');
  assert.equal(incidentResponseTeams(state, incident.id)[0].phase, 'stood-down');
});

test('I2-D migration backfills a previously dispatched I2-C team at load time without retroactive work', async () => {
  const { state } = await fixture(0x120d007);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const legacy = structuredClone(state);
  delete legacy.incidentResponseOperations;
  delete legacy.incidentResponseResources;
  legacy.clock.minuteOfDay += 90;
  const restored = importSandboxSave(JSON.stringify(legacy));
  const operation = incidentResponseOperations(restored, incident.id)[0];
  assert.equal(operation.phase, 'mobilizing');
  assert.equal(operation.startedAt, restored.clock.day * 1440 + restored.clock.minuteOfDay);
  assert.equal(operation.lastAdvancedAt, operation.startedAt);
  assert.equal(operation.mobilizationMinutesRemaining, operation.plannedMobilizationMinutes);
});

test('I2-D operation persistence round-trips deterministically and rejects forged outcome truth', async () => {
  const { provider, state } = await fixture(0x120d008);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  await advanceSandbox(provider, state, 45);
  const roundTrip = importSandboxSave(sandboxRepository.exportJson(state));
  assert.deepEqual(roundTrip.incidentResponseOperations, state.incidentResponseOperations);
  const injected = structuredClone(state);
  injected.incidentResponseOperations.operations[0].outcome = 'success';
  assert.throws(() => importSandboxSave(JSON.stringify(injected)), /illegally persists outcome\/presentation truth/i);
  const forged = structuredClone(state);
  forged.incidentResponseOperations.operations[0].observations.push({
    id: `incident-response-observation:${forged.incidentResponseOperations.nextObservationOrdinal.toString(36)}`,
    ordinal: forged.incidentResponseOperations.nextObservationOrdinal,
    kind: 'post-response-visibility',
    observedAt: forged.clock.day * 1440 + forged.clock.minuteOfDay,
    incidentVisibility: 'resolved',
  });
  forged.incidentResponseOperations.nextObservationOrdinal += 1;
  assert.throws(() => importSandboxSave(JSON.stringify(forged)), /observation visibility is invalid/i);
});


test('I2-E bootstrap creates an empty canonical response-resource sidecar', async () => {
  const { state } = await fixture(0x120e001);
  assert.deepEqual(state.incidentResponseResources, { schemaVersion: 1, reservations: [] });
});

test('I2-E insufficient canonical stock rejects dispatch atomically before operation/reservation creation', async () => {
  const { state } = await fixture(0x120e002);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  state.settlement.resources.food = 0;
  state.settlement.resources.water = 0;
  state.settlement.resources.medicine = 0;
  state.settlement.resources.scrap = 0;
  const before = structuredClone(state.settlement.resources);
  assert.throws(() => dispatchIncidentResponseTeam(state, team.id), /lacks reserved .* capacity/i);
  assert.equal(incidentResponseTeams(state, incident.id)[0].phase, 'assigned');
  assert.deepEqual(incidentResponseOperations(state, incident.id), []);
  assert.deepEqual(incidentResponseResourceReservations(state, incident.id), []);
  assert.deepEqual(state.settlement.resources, before);
});

test('I2-E canonical operation progress consumes bounded food/water and returns availability-only medicine/tools', async () => {
  const { state } = await fixture(0x120e003);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  const before = structuredClone(state.settlement.resources);
  dispatchIncidentResponseTeam(state, team.id);
  let operation = incidentResponseOperations(state, incident.id)[0];
  let reservation = incidentResponseResourceReservations(state, incident.id)[0];
  assert.ok(reservation.reserved.food > 0 && reservation.reserved.water > 0);
  assert.ok(reservation.reserved.medicine >= 0 && reservation.reserved.tools > 0);
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  operation = incidentResponseOperations(state, incident.id)[0];
  reservation = incidentResponseResourceReservations(state, incident.id)[0];
  assert.equal(operation.phase, 'completed');
  assert.equal(reservation.phase, 'settled');
  assert.equal(reservation.consumed.food, reservation.reserved.food);
  assert.equal(reservation.consumed.water, reservation.reserved.water);
  assert.equal(reservation.consumed.medicine, 0);
  assert.equal(reservation.consumed.tools, 0);
  assert.equal(reservation.returned.medicine, reservation.reserved.medicine);
  assert.equal(reservation.returned.tools, reservation.reserved.tools);
  assert.equal(Number(state.settlement.resources.food.toFixed(6)), Number((before.food - reservation.consumed.food).toFixed(6)));
  assert.equal(Number(state.settlement.resources.water.toFixed(6)), Number((before.water - reservation.consumed.water).toFixed(6)));
  assert.equal(Number(state.settlement.resources.medicine.toFixed(6)), Number(before.medicine.toFixed(6)));
  assert.equal(Number(state.settlement.resources.scrap.toFixed(6)), Number(before.scrap.toFixed(6)));
  assert.notEqual(state.incidentLedger.entries.find((entry) => entry.incidentId === incident.id)?.phase, 'resolved');
});

test('I2-E immediate operator abort refunds the entire reservation without fabricating an outcome', async () => {
  const { state } = await fixture(0x120e004);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  const before = structuredClone(state.settlement.resources);
  dispatchIncidentResponseTeam(state, team.id);
  standDownIncidentResponseTeam(state, team.id);
  const reservation = incidentResponseResourceReservations(state, incident.id)[0];
  assert.equal(reservation.phase, 'settled');
  assert.deepEqual(reservation.consumed, { food: 0, water: 0, medicine: 0, tools: 0 });
  assert.deepEqual(reservation.returned, reservation.reserved);
  assert.deepEqual(state.settlement.resources, before);
  assert.notEqual(state.incidentLedger.entries.find((entry) => entry.incidentId === incident.id)?.phase, 'resolved');
});

test('I2-E legacy I2-D save migrates to zero-budget unfunded reservation without rewriting canonical stock', async () => {
  const { state } = await fixture(0x120e005);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const legacy = structuredClone(state);
  const held = legacy.incidentResponseResources.reservations[0].reserved;
  legacy.settlement.resources.food += held.food;
  legacy.settlement.resources.water += held.water;
  legacy.settlement.resources.medicine += held.medicine;
  legacy.settlement.resources.scrap += held.tools;
  delete legacy.incidentResponseResources;
  const before = structuredClone(legacy.settlement.resources);
  const restored = importSandboxSave(JSON.stringify(legacy));
  const reservation = incidentResponseResourceReservations(restored, incident.id)[0];
  assert.equal(reservation.phase, 'legacy-unfunded');
  assert.deepEqual(reservation.reserved, { food: 0, water: 0, medicine: 0, tools: 0 });
  assert.deepEqual(restored.settlement.resources, before);
});

test('I2-E persistence round-trips resource accounting and rejects over-accounting or outcome truth', async () => {
  const { state } = await fixture(0x120e006);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  const member = deriveIncidentDispatchCapacity(state, incident.id).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incident.id, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  state.clock.minuteOfDay += 15;
  synchronizeIncidentResponseOperations(state);
  const roundTrip = importSandboxSave(sandboxRepository.exportJson(state));
  assert.deepEqual(roundTrip.incidentResponseResources, state.incidentResponseResources);
  const over = structuredClone(state);
  over.incidentResponseResources.reservations[0].consumed.food = over.incidentResponseResources.reservations[0].reserved.food + 1;
  assert.throws(() => importSandboxSave(JSON.stringify(over)), /over-accounts food/i);
  const forged = structuredClone(state);
  forged.incidentResponseResources.reservations[0].success = true;
  assert.throws(() => importSandboxSave(JSON.stringify(forged)), /illegally persists outcome\/presentation truth/i);
});


test('I2-E expedition response reserves and settles against expedition supplies instead of settlement stock', async () => {
  const { state } = await fixture(0x120e007);
  const leader = state.agents
    .filter((agent) => agent.alive && agent.role !== 'child' && agent.expeditionId === null)
    .sort((left, right) => right.skills.scouting - left.skills.scouting)[0];
  assert.ok(leader);
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: [leader.id],
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
  });
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, expedition, null).incidents[0];
  assert.ok(incident);
  const capacity = deriveIncidentDispatchCapacity(state, incident.id, expedition);
  assert.deepEqual(capacity.availableMemberIds, [leader.id]);
  const team = assignIncidentResponseTeam(state, incident.id, [leader.id], expedition);
  const settlementBeforeDispatch = structuredClone(state.settlement.resources);
  const expeditionBeforeDispatch = structuredClone(expedition.supplies);
  dispatchIncidentResponseTeam(state, team.id);
  let operation = incidentResponseOperations(state, incident.id, expedition)[0];
  let reservation = incidentResponseResourceReservations(state, incident.id, expedition)[0];
  assert.equal(reservation.sourceKind, 'expedition');
  assert.equal(reservation.sourceExpeditionId, expedition.id);
  assert.deepEqual(state.settlement.resources, settlementBeforeDispatch);
  assert.equal(Number(expedition.supplies.food.toFixed(6)), Number((expeditionBeforeDispatch.food - reservation.reserved.food).toFixed(6)));
  assert.equal(Number(expedition.supplies.water.toFixed(6)), Number((expeditionBeforeDispatch.water - reservation.reserved.water).toFixed(6)));
  const duration = operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  state.clock.minuteOfDay += duration;
  synchronizeIncidentResponseOperations(state);
  operation = incidentResponseOperations(state, incident.id, expedition)[0];
  reservation = incidentResponseResourceReservations(state, incident.id, expedition)[0];
  assert.equal(operation.phase, 'completed');
  assert.equal(reservation.phase, 'settled');
  assert.equal(Number(expedition.supplies.food.toFixed(6)), Number((expeditionBeforeDispatch.food - reservation.consumed.food).toFixed(6)));
  assert.equal(Number(expedition.supplies.water.toFixed(6)), Number((expeditionBeforeDispatch.water - reservation.consumed.water).toFixed(6)));
  assert.equal(Number(expedition.supplies.medicine.toFixed(6)), Number(expeditionBeforeDispatch.medicine.toFixed(6)));
  assert.equal(Number(expedition.supplies.tools.toFixed(6)), Number(expeditionBeforeDispatch.tools.toFixed(6)));
  assert.deepEqual(state.settlement.resources, settlementBeforeDispatch);
});


test('I2-F signal disappearance alone remains withdrawn until the positive-evidence resolver is invoked', async () => {
  const { state } = await fixture(0x120f001);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  state.settlement.resources.water = 99999;
  synchronizeIncidentLedger(state);
  let entry = state.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId);
  assert.equal(entry?.phase, 'withdrawn');
  assert.equal(entry?.lastResolutionEvidence, undefined);
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  entry = state.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId);
  assert.equal(entry?.phase, 'resolved');
  assert.equal(entry?.lastResolutionEvidence?.kind, 'settlement-resource-threshold');
  assert.equal(entry?.lastResolutionEvidence?.metric, 'water');
});

test('I2-F persistence rejects a forged resolved lifecycle without positive evidence', async () => {
  const { state } = await fixture(0x120f002);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const forged = structuredClone(state);
  const entry = forged.incidentLedger.entries.find((candidate) => candidate.incidentId === 'incident:settlement:water-low');
  entry.phase = 'resolved';
  entry.terminalAt = forged.clock.day * 1440 + forged.clock.minuteOfDay;
  assert.throws(() => importSandboxSave(JSON.stringify(forged)), /requires explicit positive resolution evidence/i);
});

test('I2-F persistence rejects positive threshold evidence whose observed value does not meet its criterion', async () => {
  const { state } = await fixture(0x120f003);
  state.settlement.resources.food = 0;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:food-low';
  const population = state.agents.filter((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement').length;
  state.settlement.resources.food = population * 2;
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const forged = structuredClone(state);
  const entry = forged.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId);
  entry.lastResolutionEvidence.observedValue = 0;
  assert.throws(() => importSandboxSave(JSON.stringify(forged)), /does not satisfy its positive threshold/i);
});

test('I2-F positive resolution evidence round-trips without presentation or response-success truth', async () => {
  const { state } = await fixture(0x120f004);
  state.settlement.resources.food = 0;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:food-low';
  state.settlement.resources.food = 99999;
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const before = structuredClone(state.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId).lastResolutionEvidence);
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  const after = restored.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId).lastResolutionEvidence;
  assert.deepEqual(after, before);
  for (const forbidden of ['title','summary','detail','presentation','outcome','success','failure','causeConfirmed','responseSucceeded']) {
    assert.equal(Object.hasOwn(after, forbidden), false);
  }
});

test('I2-F recurrence retains historical evidence but requires a new occurrence-specific positive observation to resolve again', async () => {
  const { state } = await fixture(0x120f005);
  const incidentId = 'incident:settlement:water-low';
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  state.settlement.resources.water = 99999;
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const first = structuredClone(state.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId).lastResolutionEvidence);
  assert.equal(first.occurrenceNumber, 1);

  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  let entry = state.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId);
  assert.equal(entry.phase, 'active');
  assert.equal(entry.occurrenceCount, 2);
  assert.deepEqual(entry.lastResolutionEvidence, first);
  assert.equal(resolvePersistedIncident(state, incidentId), false);

  state.settlement.resources.water = 99999;
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  entry = state.incidentLedger.entries.find((candidate) => candidate.incidentId === incidentId);
  assert.equal(entry.lastResolutionEvidence.occurrenceNumber, 2);
  assert.notEqual(entry.lastResolutionEvidence.id, first.id);
});

test('I2-F locally recorded injury clears only after every originally observed wound case is explicitly non-active', async () => {
  const { state } = await fixture(0x120f006);
  const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
  assert.ok(patient);
  patient.pathology.push({
    id: 'case:i2f:wound',
    pathologyId: 'traumatic-wound',
    onsetDay: state.clock.day,
    severity: 70,
    contagious: false,
    observedSymptoms: ['recorded wound'],
    suspectedCauses: [],
    treatmentsTried: [],
    status: 'active',
  });
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:injury';
  assert.equal(resolvePersistedIncident(state, incidentId), false);
  patient.pathology.find((entry) => entry.id === 'case:i2f:wound').status = 'resolved';
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const evidence = state.incidentLedger.entries.find((entry) => entry.incidentId === incidentId).lastResolutionEvidence;
  assert.equal(evidence.kind, 'recorded-case-cleared');
  assert.deepEqual(evidence.subjectIds, [patient.id]);
});

test('I2-F field communication incident requires an affirmative connected state rather than silence disappearing', async () => {
  const { state } = await fixture(0x120f007);
  const leader = state.agents
    .filter((agent) => agent.alive && agent.role !== 'child' && agent.expeditionId === null)
    .sort((left, right) => right.skills.scouting - left.skills.scouting)[0];
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: [leader.id],
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
  });
  expedition.communication = 'silent';
  expedition.silentHours = 24;
  synchronizeIncidentLedger(state);
  const incidentId = `incident:field-comm:${expedition.id}`;
  assert.equal(resolvePersistedIncident(state, incidentId, expedition), false);
  expedition.communication = 'connected';
  expedition.silentHours = 0;
  assert.equal(resolvePersistedIncident(state, incidentId, expedition), true);
  const entry = state.incidentLedger.entries.find((candidate) => candidate.contextKey === `expedition:${expedition.id}` && candidate.incidentId === incidentId);
  assert.equal(entry.lastResolutionEvidence.kind, 'communication-restored');
});

test('I2-F unknown or unsupported incident families fail closed instead of accepting caller-authored resolution truth', async () => {
  const { state } = await fixture(0x120f008);
  assert.equal(derivePositiveIncidentResolutionEvidence(state, 'incident:caller-authored-hidden-truth'), null);
  assert.equal(resolvePersistedIncident(state, 'incident:caller-authored-hidden-truth'), false);
});


test('I2-F legacy pre-policy resolved metadata is downgraded to withdrawn on import instead of being trusted as truth', async () => {
  const { state } = await fixture(0x120f009);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const legacy = structuredClone(state);
  delete legacy.incidentLedger.resolutionPolicyVersion;
  const entry = legacy.incidentLedger.entries.find((candidate) => candidate.incidentId === 'incident:settlement:water-low');
  entry.phase = 'resolved';
  entry.terminalAt = legacy.clock.day * 1440 + legacy.clock.minuteOfDay;
  delete entry.lastResolutionEvidence;
  legacy.settlement.resources.water = 99999;
  const restored = importSandboxSave(JSON.stringify(legacy));
  const migrated = restored.incidentLedger.entries.find((candidate) => candidate.incidentId === 'incident:settlement:water-low');
  assert.equal(restored.incidentLedger.resolutionPolicyVersion, 1);
  assert.equal(migrated.phase, 'withdrawn');
  assert.equal(migrated.lastResolutionEvidence, undefined);
});


test('I2-G bootstrap creates an empty evidence-grounded response resource-use sidecar', async () => {
  const { state } = await fixture(0x1207001);
  synchronizeIncidentLedger(state);
  assert.equal(state.incidentResponseEvidenceUses?.schemaVersion, 1);
  assert.equal(state.incidentResponseEvidenceUses?.nextUseOrdinal, 1);
  assert.deepEqual(state.incidentResponseEvidenceUses?.uses, []);
});

test('I2-G resource reconciliation fails closed without current positive resolution evidence', async () => {
  const { state } = await fixture(0x1207002);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  assert.throws(() => applyIncidentResponseEvidenceResourceUse(state, 'incident:settlement:water-low', { medicine: 0.01 }), /requires current explicit positive resolution evidence/i);
  assert.deepEqual(state.incidentResponseEvidenceUses?.uses ?? [], []);
});

test('I2-G completed injury response can reconcile bounded medicine use after explicit positive evidence', async () => {
  const { state } = await fixture(0x1207003);
  const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
  assert.ok(patient);
  patient.pathology.push({
    id: 'case:i2g:wound', pathologyId: 'traumatic-wound', onsetDay: state.clock.day,
    severity: 75, contagious: false, observedSymptoms: ['recorded wound'], suspectedCauses: [], treatmentsTried: [], status: 'active',
  });
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:injury';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  let operation = incidentResponseOperations(state, incidentId)[0];
  const duration = operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  state.clock.minuteOfDay += duration;
  synchronizeIncidentResponseOperations(state);
  operation = incidentResponseOperations(state, incidentId)[0];
  assert.equal(operation.phase, 'completed');
  let reservation = incidentResponseResourceReservations(state, incidentId)[0];
  assert.equal(reservation.phase, 'settled');
  assert.ok(reservation.returned.medicine > 0);
  patient.pathology.find((entry) => entry.id === 'case:i2g:wound').status = 'resolved';
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const medicineBefore = state.settlement.resources.medicine;
  const amount = Number((reservation.returned.medicine / 2).toFixed(6));
  const use = applyIncidentResponseEvidenceResourceUse(state, incidentId, { medicine: amount });
  reservation = incidentResponseResourceReservations(state, incidentId)[0];
  assert.equal(use.evidenceKind, 'recorded-case-cleared');
  assert.equal(use.operationId, operation.id);
  assert.equal(use.medicine, amount);
  assert.equal(use.tools, 0);
  assert.equal(Number(state.settlement.resources.medicine.toFixed(6)), Number((medicineBefore - amount).toFixed(6)));
  assert.equal(Number(reservation.consumed.medicine.toFixed(6)), amount);
  assert.equal(Number((reservation.consumed.medicine + reservation.returned.medicine).toFixed(6)), Number(reservation.reserved.medicine.toFixed(6)));
  assert.deepEqual(incidentResponseEvidenceResourceUses(state, incidentId), [use]);
});

test('I2-G evidence kind policy prevents medicine/tool use from being inferred from unrelated positive facts', async () => {
  const { state } = await fixture(0x1207004);
  const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
  assert.ok(patient);
  patient.pathology.push({
    id: 'case:i2g:policy', pathologyId: 'traumatic-wound', onsetDay: state.clock.day,
    severity: 60, contagious: false, observedSymptoms: ['wound'], suspectedCauses: [], treatmentsTried: [], status: 'active',
  });
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:injury';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  patient.pathology.find((entry) => entry.id === 'case:i2g:policy').status = 'resolved';
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  assert.throws(() => applyIncidentResponseEvidenceResourceUse(state, incidentId, { tools: 0.01 }), /does not authorize tools reconciliation/i);
});

test('I2-G reconciliation is atomic when requested use exceeds returned reserve or current canonical stock', async () => {
  const { state } = await fixture(0x1207005);
  const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
  assert.ok(patient);
  patient.pathology.push({ id: 'case:i2g:atomic', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 70, contagious: false, observedSymptoms: ['wound'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:injury';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  patient.pathology.find((entry) => entry.id === 'case:i2g:atomic').status = 'resolved';
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const beforeResources = structuredClone(state.settlement.resources);
  const beforeReservation = structuredClone(incidentResponseResourceReservations(state, incidentId)[0]);
  assert.throws(() => applyIncidentResponseEvidenceResourceUse(state, incidentId, { medicine: beforeReservation.returned.medicine + 1 }), /enough returned reserve/i);
  assert.deepEqual(state.settlement.resources, beforeResources);
  assert.deepEqual(incidentResponseResourceReservations(state, incidentId)[0], beforeReservation);
  assert.deepEqual(incidentResponseEvidenceResourceUses(state, incidentId), []);

  state.settlement.resources.medicine = 0;
  const beforeCanonicalShortage = structuredClone(state.incidentResponseResources);
  assert.throws(() => applyIncidentResponseEvidenceResourceUse(state, incidentId, { medicine: Number((beforeReservation.returned.medicine / 2).toFixed(6)) }), /lacks reserved medicine capacity/i);
  assert.deepEqual(state.incidentResponseResources, beforeCanonicalShortage);
  assert.deepEqual(incidentResponseEvidenceResourceUses(state, incidentId), []);
});

test('I2-G expedition communication evidence reconciles tools against expedition supplies only', async () => {
  const { state } = await fixture(0x1207006);
  const leader = state.agents.filter((agent) => agent.alive && agent.role !== 'child' && agent.expeditionId === null).sort((a,b) => b.skills.scouting - a.skills.scouting)[0];
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  expedition.communication = 'silent';
  expedition.silentHours = 24;
  synchronizeIncidentLedger(state);
  const incidentId = `incident:field-comm:${expedition.id}`;
  const member = deriveIncidentDispatchCapacity(state, incidentId, expedition).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member], expedition);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId, expedition)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const reservationBefore = incidentResponseResourceReservations(state, incidentId, expedition)[0];
  assert.ok(reservationBefore.returned.tools > 0);
  expedition.communication = 'connected';
  expedition.silentHours = 0;
  assert.equal(resolvePersistedIncident(state, incidentId, expedition), true);
  const settlementBefore = structuredClone(state.settlement.resources);
  const toolsBefore = expedition.supplies.tools;
  const amount = Number((reservationBefore.returned.tools / 2).toFixed(6));
  const use = applyIncidentResponseEvidenceResourceUse(state, incidentId, { tools: amount }, expedition);
  assert.equal(use.evidenceKind, 'communication-restored');
  assert.equal(Number(expedition.supplies.tools.toFixed(6)), Number((toolsBefore - amount).toFixed(6)));
  assert.deepEqual(state.settlement.resources, settlementBefore);
});

test('I2-G evidence-use persistence round-trips and rejects forged accounting/provenance', async () => {
  const { state } = await fixture(0x1207007);
  const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
  patient.pathology.push({ id: 'case:i2g:persist', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 66, contagious: false, observedSymptoms: ['wound'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:injury';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  patient.pathology.find((entry) => entry.id === 'case:i2g:persist').status = 'resolved';
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const reservation = incidentResponseResourceReservations(state, incidentId)[0];
  applyIncidentResponseEvidenceResourceUse(state, incidentId, { medicine: Number((reservation.returned.medicine / 2).toFixed(6)) });
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  assert.deepEqual(restored.incidentResponseEvidenceUses, state.incidentResponseEvidenceUses);
  assert.deepEqual(restored.incidentResponseResources, state.incidentResponseResources);

  const forged = structuredClone(state);
  forged.incidentResponseEvidenceUses.uses[0].success = true;
  assert.throws(() => importSandboxSave(JSON.stringify(forged)), /illegally persists outcome\/presentation truth/i);

  const mismatch = structuredClone(state);
  mismatch.incidentResponseEvidenceUses.uses[0].medicine = Number((mismatch.incidentResponseEvidenceUses.uses[0].medicine / 2).toFixed(6));
  assert.throws(() => importSandboxSave(JSON.stringify(mismatch)), /does not reconcile medicine\/tools consumption/i);
});

test('I2-G legacy I2-F save without evidence-use sidecar migrates empty without changing canonical stock', async () => {
  const { state } = await fixture(0x1207008);
  synchronizeIncidentLedger(state);
  const legacy = structuredClone(state);
  delete legacy.incidentResponseEvidenceUses;
  const settlementBefore = structuredClone(legacy.settlement.resources);
  const expeditionBefore = structuredClone(legacy.expeditions.map((entry) => entry.supplies));
  const restored = importSandboxSave(JSON.stringify(legacy));
  assert.deepEqual(restored.incidentResponseEvidenceUses?.uses, []);
  assert.equal(restored.incidentResponseEvidenceUses?.nextUseOrdinal, 1);
  assert.deepEqual(restored.settlement.resources, settlementBefore);
  assert.deepEqual(restored.expeditions.map((entry) => entry.supplies), expeditionBefore);
});


test('I2-H bootstrap creates an empty observer-safe debrief sidecar', async () => {
  const { state } = await fixture(0x1208001);
  synchronizeIncidentLedger(state);
  assert.equal(state.incidentResponseDebriefs?.schemaVersion, 1);
  assert.deepEqual(state.incidentResponseDebriefs?.debriefs, []);
});

test('I2-H completed response produces a chronology-and-observation debrief without causal outcome fields', async () => {
  const { state } = await fixture(0x1208002);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const [debrief] = incidentResponseDebriefs(state, incidentId);
  assert.equal(debrief.operationId, operation.id);
  assert.equal(debrief.terminalPhase, 'completed');
  assert.equal(debrief.chronology.startedAt, operation.startedAt);
  assert.equal(debrief.chronology.terminalAt, incidentResponseOperations(state, incidentId)[0].completedAt);
  assert.ok(debrief.observations.some((entry) => entry.kind === 'post-response-visibility'));
  assert.ok(debrief.observations.some((entry) => entry.kind === 'return-complete'));
  assert.deepEqual(debrief.memberIds, [member].sort());
  for (const forbidden of ['title','summary','detail','text','outcome','success','failure','resolved','causeConfirmed','interpretation','causalAssessment']) assert.equal(Object.hasOwn(debrief, forbidden), false);
});

test('I2-H aborted response records only terminal chronology and explicit stand-down observation', async () => {
  const { state } = await fixture(0x1208003);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  standDownIncidentResponseTeam(state, team.id);
  synchronizeIncidentResponseDebriefs(state);
  const [debrief] = incidentResponseDebriefs(state, incidentId);
  assert.equal(debrief.terminalPhase, 'aborted');
  assert.ok(debrief.observations.some((entry) => entry.kind === 'operator-stand-down'));
  assert.deepEqual(debrief.positiveEvidence, []);
  assert.deepEqual(debrief.evidenceResourceUses, []);
});

test('I2-H debrief refreshes with current I2-F positive evidence only when that operation supports it', async () => {
  const { state } = await fixture(0x1208004);
  const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
  assert.ok(patient);
  patient.pathology.push({ id: 'case:i2h:evidence', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 70, contagious: false, observedSymptoms: ['wound'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:injury';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  assert.deepEqual(incidentResponseDebriefs(state, incidentId)[0].positiveEvidence, []);
  patient.pathology.find((entry) => entry.id === 'case:i2h:evidence').status = 'resolved';
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const debrief = incidentResponseDebriefs(state, incidentId)[0];
  assert.equal(debrief.positiveEvidence.length, 1);
  assert.equal(debrief.positiveEvidence[0].kind, 'recorded-case-cleared');
  assert.ok(debrief.positiveEvidence[0].supportingOperationIds.includes(operation.id));
});

test('I2-H debrief refreshes evidence-grounded I2-G resource-use facts and exact I2-E accounting', async () => {
  const { state } = await fixture(0x1208005);
  const patient = state.agents.find((agent) => agent.alive && agent.expeditionId === null && (agent.residence ?? 'settlement') === 'settlement');
  patient.pathology.push({ id: 'case:i2h:resource', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 65, contagious: false, observedSymptoms: ['wound'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:injury';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  patient.pathology.find((entry) => entry.id === 'case:i2h:resource').status = 'resolved';
  assert.equal(resolvePersistedIncident(state, incidentId), true);
  const reservation = incidentResponseResourceReservations(state, incidentId)[0];
  const amount = Number((reservation.returned.medicine / 2).toFixed(6));
  const use = applyIncidentResponseEvidenceResourceUse(state, incidentId, { medicine: amount });
  const debrief = incidentResponseDebriefs(state, incidentId)[0];
  assert.deepEqual(debrief.evidenceResourceUses, [use]);
  assert.deepEqual(debrief.resourceReservation, incidentResponseResourceReservations(state, incidentId)[0]);
  assert.equal(debrief.resourceReservation.consumed.medicine, amount);
});

test('I2-H persistence round-trips and rejects forged narrative or mismatched source snapshots', async () => {
  const { state } = await fixture(0x1208006);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  assert.deepEqual(restored.incidentResponseDebriefs, state.incidentResponseDebriefs);

  const prose = structuredClone(state);
  prose.incidentResponseDebriefs.debriefs[0].summary = 'The team solved the hidden cause.';
  assert.throws(() => importSandboxSave(JSON.stringify(prose)), /illegally persists narrative\/outcome truth/i);

  const mismatch = structuredClone(state);
  mismatch.incidentResponseDebriefs.debriefs[0].memberIds = ['forged-agent'];
  assert.throws(() => importSandboxSave(JSON.stringify(mismatch)), /members disagree with dispatch/i);
});

test('I2-H legacy I2-G save without debrief sidecar backfills terminal projections without changing canonical resources', async () => {
  const { state } = await fixture(0x1208007);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const legacy = structuredClone(state);
  delete legacy.incidentResponseDebriefs;
  const resourcesBefore = structuredClone(legacy.settlement.resources);
  const responseResourcesBefore = structuredClone(legacy.incidentResponseResources);
  const restored = importSandboxSave(JSON.stringify(legacy));
  assert.equal(restored.incidentResponseDebriefs?.schemaVersion, 1);
  assert.equal(restored.incidentResponseDebriefs?.debriefs.length, 1);
  assert.deepEqual(restored.settlement.resources, resourcesBefore);
  assert.deepEqual(restored.incidentResponseResources, responseResourcesBefore);
});

test('I2-H disappearance-only response remains observer-safe and does not acquire positive evidence or causal interpretation', async () => {
  const { state } = await fixture(0x1208008);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.settlement.resources.water = 10_000;
  synchronizeIncidentLedger(state);
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const debrief = incidentResponseDebriefs(state, incidentId)[0];
  const visibility = debrief.observations.find((entry) => entry.kind === 'post-response-visibility');
  assert.equal(visibility?.incidentVisibility, 'not-visible');
  assert.deepEqual(debrief.positiveEvidence, []);
  assert.equal(state.incidentLedger.entries.find((entry) => entry.incidentId === incidentId)?.phase, 'withdrawn');
});


test('I2-M initializes response readiness without retroactive or general-agent mutations', async () => {
  const { state } = await fixture(0x120d001);
  assert.equal(state.incidentResponseReadiness?.schemaVersion, 1);
  assert.equal(state.incidentResponseReadiness?.policyActivatedAt, state.clock.day * 1440 + state.clock.minuteOfDay);
  assert.deepEqual(state.incidentResponseReadiness?.entries, []);
  assert.ok(state.agents.every((agent) => !Object.hasOwn(agent, 'incidentResponseRecovery')));
});

test('I2-M terminal response duty creates bounded recovery that gates only Incident response reassignment', async () => {
  const { state } = await fixture(0x120d002);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  assert.ok(member);
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const [readiness] = incidentResponseReadinessEntries(state).filter((entry) => entry.memberId === member);
  assert.ok(readiness);
  assert.equal(readiness.operationId, operation.id);
  assert.ok(readiness.recoveryUntil > readiness.recoveryStartedAt);
  assert.ok(readiness.recoveryUntil - readiness.recoveryStartedAt <= 240);
  const capacity = deriveIncidentDispatchCapacity(state, incidentId);
  assert.ok(capacity.recoveringMemberIds.includes(member));
  assert.ok(!capacity.availableMemberIds.includes(member));
  assert.throws(() => assignIncidentResponseTeam(state, incidentId, [member]), /unavailable or already committed/i);
  const agentBefore = structuredClone(state.agents.find((agent) => agent.id === member));
  state.clock.minuteOfDay += readiness.recoveryUntil - (state.clock.day * 1440 + state.clock.minuteOfDay);
  synchronizeIncidentResponseReadiness(state);
  const recoveredCapacity = deriveIncidentDispatchCapacity(state, incidentId);
  assert.ok(!recoveredCapacity.recoveringMemberIds.includes(member));
  assert.ok(recoveredCapacity.availableMemberIds.includes(member));
  assert.deepEqual(state.agents.find((agent) => agent.id === member), agentBefore);
});

test('I2-M aborted response uses elapsed duty only and instant abort does not invent recovery', async () => {
  const { state } = await fixture(0x120d003);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const [firstMember, secondMember] = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds;
  const instant = assignIncidentResponseTeam(state, incidentId, [firstMember]);
  dispatchIncidentResponseTeam(state, instant.id);
  standDownIncidentResponseTeam(state, instant.id);
  assert.equal(incidentResponseReadinessEntries(state).some((entry) => entry.memberId === firstMember), false);

  const delayed = assignIncidentResponseTeam(state, incidentId, [secondMember]);
  dispatchIncidentResponseTeam(state, delayed.id);
  state.clock.minuteOfDay += 45;
  synchronizeIncidentResponseOperations(state);
  standDownIncidentResponseTeam(state, delayed.id);
  const entry = incidentResponseReadinessEntries(state).find((candidate) => candidate.memberId === secondMember);
  assert.ok(entry);
  assert.equal(entry.dutyMinutes, 45);
  assert.equal(entry.recoveryUntil - entry.recoveryStartedAt, 15);
});

test('I2-M persistence round-trips and rejects forged recovery windows', async () => {
  const { state } = await fixture(0x120d004);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  assert.deepEqual(restored.incidentResponseReadiness, state.incidentResponseReadiness);

  const forged = structuredClone(state);
  forged.incidentResponseReadiness.entries[0].recoveryUntil += 60;
  assert.throws(() => importSandboxSave(JSON.stringify(forged)), /does not match terminal response chronology/i);
  const causal = structuredClone(state);
  causal.incidentResponseReadiness.entries[0].success = true;
  assert.throws(() => importSandboxSave(JSON.stringify(causal)), /illegally persists outcome\/general-agent truth/i);
});

test('I2-M legacy I2-L save activates policy at load time without retroactive response cooldown', async () => {
  const { state } = await fixture(0x120d005);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentDispatchCapacity(state, incidentId).availableMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  assert.ok(incidentResponseReadinessEntries(state).some((entry) => entry.memberId === member));
  const legacy = structuredClone(state);
  delete legacy.incidentResponseReadiness;
  const loadedAt = legacy.clock.day * 1440 + legacy.clock.minuteOfDay;
  const restored = importSandboxSave(JSON.stringify(legacy));
  assert.equal(restored.incidentResponseReadiness?.policyActivatedAt, loadedAt);
  assert.deepEqual(restored.incidentResponseReadiness?.entries, []);
  const capacity = deriveIncidentDispatchCapacity(restored, incidentId);
  assert.ok(capacity.availableMemberIds.includes(member));
});


test('I2-N roster plan is bounded, disjoint, and excludes committed responders from rotation candidates', async () => {
  const { state } = await fixture(0x120e001);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const before = deriveIncidentResponseRosterPlan(state);
  assert.ok(before.primaryMemberIds.length > 0 && before.primaryMemberIds.length <= 4);
  assert.ok(before.reserveMemberIds.length <= 4);
  assert.equal(new Set([...before.primaryMemberIds, ...before.reserveMemberIds, ...before.overflowMemberIds]).size, before.primaryMemberIds.length + before.reserveMemberIds.length + before.overflowMemberIds.length);
  const assigned = assignIncidentResponseTeam(state, incidentId, [before.primaryMemberIds[0]]);
  const after = deriveIncidentResponseRosterPlan(state);
  assert.ok(after.committedMemberIds.includes(assigned.memberIds[0]));
  assert.ok(!after.primaryMemberIds.includes(assigned.memberIds[0]));
  assert.ok(!after.reserveMemberIds.includes(assigned.memberIds[0]));
  assert.ok(!after.overflowMemberIds.includes(assigned.memberIds[0]));
});

test('I2-N roster rotation deprioritizes recent response duty after recovery expires', async () => {
  const { state } = await fixture(0x120e002);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const initialPlan = deriveIncidentResponseRosterPlan(state);
  const servedMember = initialPlan.primaryMemberIds[0];
  const freshMember = initialPlan.primaryMemberIds[1] ?? initialPlan.reserveMemberIds[0];
  assert.ok(servedMember && freshMember);
  const team = assignIncidentResponseTeam(state, incidentId, [servedMember]);
  dispatchIncidentResponseTeam(state, team.id);
  const operation = incidentResponseOperations(state, incidentId)[0];
  state.clock.minuteOfDay += operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
  synchronizeIncidentResponseOperations(state);
  const readiness = incidentResponseReadinessEntries(state).find((entry) => entry.memberId === servedMember);
  assert.ok(readiness);
  state.clock.minuteOfDay += readiness.recoveryUntil - (state.clock.day * 1440 + state.clock.minuteOfDay);
  synchronizeIncidentResponseReadiness(state);
  const rotated = deriveIncidentResponseRosterPlan(state);
  const servedStat = rotated.serviceStats.find((entry) => entry.memberId === servedMember);
  const freshStat = rotated.serviceStats.find((entry) => entry.memberId === freshMember);
  assert.ok(servedStat && freshStat);
  assert.ok(servedStat.dutyMinutes > freshStat.dutyMinutes);
  const order = [...rotated.primaryMemberIds, ...rotated.reserveMemberIds, ...rotated.overflowMemberIds];
  assert.ok(order.indexOf(freshMember) < order.indexOf(servedMember));
});

test('I2-N roster assignment selects the least-served candidates without advancing time or mutating general Agent state', async () => {
  const { state } = await fixture(0x120e003);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const plan = deriveIncidentResponseRosterPlan(state);
  const expected = [...plan.primaryMemberIds, ...plan.reserveMemberIds, ...plan.overflowMemberIds].slice(0, 2).sort();
  const beforeClock = structuredClone(state.clock);
  const beforeAgents = structuredClone(state.agents);
  const team = assignIncidentResponseRosterTeam(state, incidentId, 2);
  assert.deepEqual(team.memberIds, expected);
  assert.deepEqual(state.clock, beforeClock);
  assert.deepEqual(state.agents, beforeAgents);
  assert.equal(team.phase, 'assigned');
});

test('I2-N recovery remains a hard exclusion even when the recovering responder has the lightest historical duty', async () => {
  const { state } = await fixture(0x120e004);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const member = deriveIncidentResponseRosterPlan(state).primaryMemberIds[0];
  const team = assignIncidentResponseTeam(state, incidentId, [member]);
  dispatchIncidentResponseTeam(state, team.id);
  state.clock.minuteOfDay += 45;
  synchronizeIncidentResponseOperations(state);
  standDownIncidentResponseTeam(state, team.id);
  const plan = deriveIncidentResponseRosterPlan(state);
  assert.ok(plan.recoveringMemberIds.includes(member));
  assert.ok(!plan.primaryMemberIds.includes(member));
  assert.ok(!plan.reserveMemberIds.includes(member));
  assert.ok(!plan.overflowMemberIds.includes(member));
});

test('I2-N roster plan is deterministic across save/reload and persists no separate roster authority', async () => {
  const { state } = await fixture(0x120e005);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  assignIncidentResponseRosterTeam(state, incidentId, 2);
  const before = deriveIncidentResponseRosterPlan(state);
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  const after = deriveIncidentResponseRosterPlan(restored);
  assert.deepEqual(after, before);
  assert.equal(Object.hasOwn(restored, 'incidentResponseRoster'), false);
});


test('I2-O logistics plan matches the exact bounded resource reservation used by dispatch', async () => {
  const { state } = await fixture(0x120f101);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const plan = deriveIncidentResponseLogisticsPlan(state, incidentId, 2);
  assert.equal(plan.contextKey, 'settlement');
  assert.equal(plan.requestedTeamSize, 2);
  assert.equal(plan.plannedMemberIds.length, 2);
  assert.equal(plan.readyToAssign, true);
  assert.equal(plan.readyToDispatch, true);
  assert.equal(plan.resourceSourceKind, 'settlement');
  assert.equal(plan.totalEstimateMinutes, plan.mobilizationEstimateMinutes + plan.workEstimateMinutes + plan.returnEstimateMinutes);
  assert.equal(plan.projectedTerminalAt, plan.generatedAt + plan.totalEstimateMinutes);
  const team = assignIncidentResponseRosterTeam(state, incidentId, 2);
  dispatchIncidentResponseTeam(state, team.id);
  const reservation = incidentResponseResourceReservations(state, incidentId)[0];
  assert.deepEqual(reservation.reserved, plan.requiredResources);
  assert.deepEqual(team.memberIds, [...plan.plannedMemberIds].sort());
});

test('I2-O logistics plan reports canonical resource shortfall without mutating stock or preventing assignment metadata', async () => {
  const { state } = await fixture(0x120f102);
  state.settlement.resources.food = 0;
  state.settlement.resources.water = 1;
  state.settlement.resources.medicine = 0;
  state.settlement.resources.scrap = 0;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const beforeResources = structuredClone(state.settlement.resources);
  const beforeClock = structuredClone(state.clock);
  const plan = deriveIncidentResponseLogisticsPlan(state, incidentId, 1);
  assert.equal(plan.readyToAssign, true);
  assert.equal(plan.readyToDispatch, false);
  assert.equal(plan.resourceReady, false);
  assert.ok(plan.blockers.includes('resource-shortfall'));
  assert.ok(plan.shortfallResources.food > 0 || plan.shortfallResources.medicine > 0 || plan.shortfallResources.tools > 0);
  assert.deepEqual(state.settlement.resources, beforeResources);
  assert.deepEqual(state.clock, beforeClock);
  const team = assignIncidentResponseRosterTeam(state, incidentId, 1);
  assert.equal(team.phase, 'assigned');
  assert.throws(() => dispatchIncidentResponseTeam(state, team.id), /lacks reserved .* capacity/i);
});

test('I2-O logistics plan exposes bounded team-capacity and known operation/recovery review times', async () => {
  const { state } = await fixture(0x120f103);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const first = assignIncidentResponseRosterTeam(state, incidentId, 1);
  dispatchIncidentResponseTeam(state, first.id);
  let plan = deriveIncidentResponseLogisticsPlan(state, incidentId, 1);
  assert.ok(plan.nextKnownOperationTerminalAt > plan.generatedAt);
  state.clock.minuteOfDay += 45;
  synchronizeIncidentResponseOperations(state);
  standDownIncidentResponseTeam(state, first.id);
  plan = deriveIncidentResponseLogisticsPlan(state, incidentId, 1);
  assert.ok(plan.nextKnownRecoveryAt > plan.generatedAt);

  const active = [];
  for (let i = 0; i < 3; i += 1) active.push(assignIncidentResponseRosterTeam(state, incidentId, 1));
  plan = deriveIncidentResponseLogisticsPlan(state, incidentId, 1);
  assert.equal(plan.teamSlotReady, false);
  assert.equal(plan.readyToAssign, false);
  assert.ok(plan.blockers.includes('team-capacity'));
});

test('I2-O field logistics reads expedition supplies and never stages against settlement stock', async () => {
  const { state } = await fixture(0x120f104);
  const leader = state.agents
    .filter((agent) => agent.alive && agent.role !== 'child' && agent.expeditionId === null)
    .sort((left, right) => right.skills.scouting - left.skills.scouting)[0];
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: [leader.id],
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
  });
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, expedition, null).incidents[0];
  assert.ok(incident);
  const settlementBefore = structuredClone(state.settlement.resources);
  const expeditionBefore = structuredClone(expedition.supplies);
  const plan = deriveIncidentResponseLogisticsPlan(state, incident.id, 1, expedition);
  assert.equal(plan.contextKey, `expedition:${expedition.id}`);
  assert.equal(plan.resourceSourceKind, 'expedition');
  assert.equal(plan.resourceSourceExpeditionId, expedition.id);
  assert.deepEqual(plan.availableResources, expeditionBefore);
  assert.deepEqual(state.settlement.resources, settlementBefore);
  assert.deepEqual(expedition.supplies, expeditionBefore);
});

test('I2-O logistics is deterministic across save/reload and persists no planning authority', async () => {
  const { state } = await fixture(0x120f105);
  state.settlement.resources.water = 1;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const before = deriveIncidentResponseLogisticsPlan(state, incidentId, 3);
  const exported = sandboxRepository.exportJson(state);
  assert.doesNotMatch(exported, /incidentResponseLogistics/);
  const restored = importSandboxSave(exported);
  const after = deriveIncidentResponseLogisticsPlan(restored, incidentId, 3);
  assert.deepEqual(after, before);
  assert.equal(Object.hasOwn(restored, 'incidentResponseLogistics'), false);
});

test('I2-P coordination stages multiple visible Incidents with disjoint responders and aggregate supply without mutation', async () => {
  const { state } = await fixture(0x1210101);
  state.settlement.resources.water = 1;
  state.settlement.resources.food = 1;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const visible = deriveVisibleIncidentProjection(state, null, null).incidents;
  assert.ok(visible.length >= 2);
  const before = structuredClone(state);
  const requests = visible.slice(0, 2).map((incident) => ({ incidentId: incident.id, teamSize: 1 }));
  const plan = deriveIncidentResponseCoordinationPlan(state, requests);
  assert.equal(plan.stagedRequestCount, 2);
  assert.equal(plan.reviewRequestCount, 0);
  assert.equal(plan.stagedMemberIds.length, 2);
  assert.notEqual(plan.items[0].plannedMemberIds[0], plan.items[1].plannedMemberIds[0]);
  assert.deepEqual(state, before);
  const expected = {
    food: +(plan.items[0].requiredResources.food + plan.items[1].requiredResources.food).toFixed(6),
    water: +(plan.items[0].requiredResources.water + plan.items[1].requiredResources.water).toFixed(6),
    medicine: +(plan.items[0].requiredResources.medicine + plan.items[1].requiredResources.medicine).toFixed(6),
    tools: +(plan.items[0].requiredResources.tools + plan.items[1].requiredResources.tools).toFixed(6),
  };
  assert.deepEqual(plan.stagedResources, expected);
});

test('I2-P coordination detects virtual aggregate resource contention even when each standalone logistics plan is ready', async () => {
  const { state } = await fixture(0x1210102);
  state.settlement.resources.water = 1;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 10;
  state.settlement.resources.scrap = 10;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const single = deriveIncidentResponseLogisticsPlan(state, incidentId, 1);
  assert.equal(single.readyToDispatch, true);
  state.settlement.resources.food = single.requiredResources.food;
  state.settlement.resources.water = Math.max(1, single.requiredResources.water);
  state.settlement.resources.medicine = single.requiredResources.medicine;
  state.settlement.resources.scrap = single.requiredResources.tools;
  synchronizeIncidentLedger(state);
  const plan = deriveIncidentResponseCoordinationPlan(state, [
    { incidentId, teamSize: 1 },
    { incidentId, teamSize: 1 },
  ]);
  assert.equal(plan.items[0].disposition, 'staged-now');
  assert.equal(plan.items[1].disposition, 'review');
  assert.ok(plan.items[1].blockers.includes('coordination-resource-shortfall'));
  assert.equal(plan.stagedRequestCount, 1);
});

test('I2-P coordination models virtual per-Incident team capacity and bounded review time without creating teams', async () => {
  const { state } = await fixture(0x1210103);
  state.settlement.resources.water = 1;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const beforeTeamCount = incidentResponseTeams(state).length;
  const plan = deriveIncidentResponseCoordinationPlan(state, [
    { incidentId, teamSize: 1 },
    { incidentId, teamSize: 1 },
    { incidentId, teamSize: 1 },
    { incidentId, teamSize: 1 },
  ]);
  assert.equal(plan.stagedRequestCount, 3);
  assert.equal(plan.items[3].disposition, 'review');
  assert.ok(plan.items[3].blockers.includes('coordination-team-capacity'));
  assert.equal(plan.items[3].nextReviewAt, plan.items[0].projectedTerminalAt);
  assert.equal(incidentResponseTeams(state).length, beforeTeamCount);
});

test('I2-P coordination refuses virtual double-booking and exposes responder review window after staged release', async () => {
  const { state } = await fixture(0x1210104);
  state.settlement.resources.water = 1;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const eligible = deriveIncidentResponseRosterPlan(state).primaryMemberIds.length
    + deriveIncidentResponseRosterPlan(state).reserveMemberIds.length
    + deriveIncidentResponseRosterPlan(state).overflowMemberIds.length;
  const requestCount = Math.min(8, Math.max(2, eligible));
  const requests = Array.from({ length: requestCount }, () => ({ incidentId, teamSize: 4 }));
  const plan = deriveIncidentResponseCoordinationPlan(state, requests);
  const staged = plan.items.filter((item) => item.disposition === 'staged-now');
  const stagedMembers = staged.flatMap((item) => item.plannedMemberIds);
  assert.equal(new Set(stagedMembers).size, stagedMembers.length);
  const responderBlocked = plan.items.find((item) => item.blockers.includes('coordination-responder-capacity'));
  if (responderBlocked) assert.ok(responderBlocked.nextReviewAt > plan.generatedAt);
});

test('I2-P coordination is deterministic across save/reload, uses expedition stock in field context, and persists no coordination authority', async () => {
  const { state } = await fixture(0x1210105);
  const leader = state.agents
    .filter((agent) => agent.alive && agent.role !== 'child' && agent.expeditionId === null)
    .sort((left, right) => right.skills.scouting - left.skills.scouting)[0];
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: [leader.id],
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
  });
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, expedition, null).incidents[0];
  assert.ok(incident);
  const beforeSettlement = structuredClone(state.settlement.resources);
  const plan = deriveIncidentResponseCoordinationPlan(state, [{ incidentId: incident.id, teamSize: 1 }], expedition);
  assert.equal(plan.contextKey, `expedition:${expedition.id}`);
  assert.deepEqual(state.settlement.resources, beforeSettlement);
  const exported = sandboxRepository.exportJson(state);
  assert.doesNotMatch(exported, /incidentResponseCoordination/);
  const restored = importSandboxSave(exported);
  const restoredExpedition = restored.expeditions.find((entry) => entry.id === expedition.id);
  const after = deriveIncidentResponseCoordinationPlan(restored, [{ incidentId: incident.id, teamSize: 1 }], restoredExpedition);
  assert.deepEqual(after, plan);
  assert.equal(Object.hasOwn(restored, 'incidentResponseCoordination'), false);
});



test('I2-Q executes exactly one freshly staged coordination request through canonical assignment and dispatch seams', async () => {
  const { state } = await fixture(0x1211101);
  state.settlement.resources.water = 10;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [
    { incidentId: incident.id, teamSize: 1 },
    { incidentId: incident.id, teamSize: 1 },
  ];
  const plan = deriveIncidentResponseCoordinationPlan(state, requests);
  assert.equal(plan.items[1].disposition, 'staged-now');
  const beforeMinute = state.clock.day * 1440 + state.clock.hour * 60 + state.clock.minute;
  const result = executeIncidentResponseCoordinationRequest(state, requests, 1);
  const afterMinute = state.clock.day * 1440 + state.clock.hour * 60 + state.clock.minute;
  assert.equal(afterMinute, beforeMinute);
  assert.equal(result.requestIndex, 1);
  assert.equal(result.incidentId, plan.items[1].incidentId);
  assert.deepEqual(result.memberIds, plan.items[1].plannedMemberIds);
  assert.deepEqual(result.reservedResources, plan.items[1].requiredResources);
  const teams = incidentResponseTeams(state);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].phase, 'dispatched');
  assert.equal(teams[0].id, result.team.id);
  assert.ok(incidentResponseOperations(state).some((operation) => operation.id === result.operationId));
  assert.ok(incidentResponseResourceReservations(state).some((reservation) => reservation.id === result.resourceReservationId));
});

test('I2-Q rejects a review-only coordination selection with exact no-op rollback', async () => {
  const { state } = await fixture(0x1211102);
  state.settlement.resources.water = 10;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const requests = Array.from({ length: 4 }, () => ({ incidentId, teamSize: 1 }));
  const plan = deriveIncidentResponseCoordinationPlan(state, requests);
  assert.equal(plan.items[3].disposition, 'review');
  const before = sandboxRepository.exportJson(state);
  assert.throws(() => executeIncidentResponseCoordinationRequest(state, requests, 3), /requires review/i);
  assert.equal(sandboxRepository.exportJson(state), before);
  assert.equal(incidentResponseTeams(state).length, 0);
});

test('I2-Q executes only the operator-selected staged item and never cascades earlier virtual requests', async () => {
  const { state } = await fixture(0x1211103);
  state.settlement.resources.water = 10;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [
    { incidentId: incident.id, teamSize: 1 },
    { incidentId: incident.id, teamSize: 1 },
  ];
  const plan = deriveIncidentResponseCoordinationPlan(state, requests);
  assert.equal(plan.stagedRequestCount, 2);
  const result = executeIncidentResponseCoordinationRequest(state, requests, 1);
  const teams = incidentResponseTeams(state);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].incidentId, requests[1].incidentId);
  assert.deepEqual(teams[0].memberIds, plan.items[1].plannedMemberIds);
  assert.notDeepEqual(teams[0].memberIds, plan.items[0].plannedMemberIds);
  assert.equal(result.incidentId, requests[1].incidentId);
});

test('I2-Q re-derives coordination at execution time rather than trusting a stale planned member list', async () => {
  const { state } = await fixture(0x1211104);
  state.settlement.resources.water = 10;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const requests = [{ incidentId, teamSize: 1 }];
  const stale = deriveIncidentResponseCoordinationPlan(state, requests);
  assert.equal(stale.items[0].disposition, 'staged-now');
  const staleMember = stale.items[0].plannedMemberIds[0];
  const prior = assignIncidentResponseRosterTeam(state, incidentId, 1);
  assert.equal(prior.memberIds[0], staleMember);
  dispatchIncidentResponseTeam(state, prior.id);
  const fresh = deriveIncidentResponseCoordinationPlan(state, requests);
  assert.equal(fresh.items[0].disposition, 'staged-now');
  assert.notEqual(fresh.items[0].plannedMemberIds[0], staleMember);
  const result = executeIncidentResponseCoordinationRequest(state, requests, 0);
  assert.deepEqual(result.memberIds, fresh.items[0].plannedMemberIds);
  assert.notEqual(result.memberIds[0], staleMember);
});

test('I2-Q executes in expedition context using field canonical resources and persists no execution authority', async () => {
  const { state } = await fixture(0x1211105);
  const leader = state.agents
    .filter((agent) => agent.alive && agent.role !== 'child' && agent.expeditionId === null)
    .sort((left, right) => right.skills.scouting - left.skills.scouting)[0];
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: [leader.id],
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
  });
  expedition.supplies.food = Math.max(expedition.supplies.food, 10);
  expedition.supplies.water = Math.max(expedition.supplies.water, 10);
  expedition.supplies.medicine = Math.max(expedition.supplies.medicine, 10);
  expedition.supplies.tools = Math.max(expedition.supplies.tools, 10);
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, expedition, null).incidents[0];
  assert.ok(incident);
  const beforeSettlement = structuredClone(state.settlement.resources);
  const beforeSupplies = structuredClone(expedition.supplies);
  const requests = [{ incidentId: incident.id, teamSize: 1 }];
  const plan = deriveIncidentResponseCoordinationPlan(state, requests, expedition);
  assert.equal(plan.items[0].disposition, 'staged-now');
  const result = executeIncidentResponseCoordinationRequest(state, requests, 0, expedition);
  assert.equal(result.contextKey, `expedition:${expedition.id}`);
  assert.deepEqual(state.settlement.resources, beforeSettlement);
  assert.ok(expedition.supplies.food <= beforeSupplies.food);
  assert.ok(expedition.supplies.water <= beforeSupplies.water);
  const exported = sandboxRepository.exportJson(state);
  assert.doesNotMatch(exported, /incidentResponseCoordinationExecution/);
  const restored = importSandboxSave(exported);
  assert.equal(Object.hasOwn(restored, 'incidentResponseCoordinationExecution'), false);
  assert.ok(incidentResponseTeams(restored, incident.id, restored.expeditions.find((entry) => entry.id === expedition.id)).some((team) => team.id === result.team.id));
});


test('I2-R atomically commits an explicit selected batch and returns replan guidance for unselected requests', async () => {
  const { state } = await fixture(0x1212101);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const beforeTeams = incidentResponseTeams(state).length;
  const result = executeIncidentResponseCoordinationBatch(state, requests, [0, 2]);
  assert.deepEqual(result.selectedRequestIndices, [0, 2]);
  assert.deepEqual(result.executions.map((entry) => entry.originalRequestIndex), [0, 2]);
  assert.deepEqual(result.remainingRequestIndices, [1]);
  assert.equal(result.postExecutionReplan.length, 1);
  assert.equal(result.postExecutionReplan[0].originalRequestIndex, 1);
  assert.equal(incidentResponseTeams(state).length, beforeTeams + 2);
  assert.equal(incidentResponseOperations(state).filter((entry) => result.executions.some((execution) => execution.operationId === entry.id)).length, 2);
  assert.equal(incidentResponseResourceReservations(state).filter((entry) => result.executions.some((execution) => execution.resourceReservationId === entry.id)).length, 2);
});

test('I2-R revalidates every selected request and rolls the whole batch back when a later request becomes review-only', async () => {
  const { state } = await fixture(0x1212102);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const requests = Array.from({ length: 4 }, () => ({ incidentId, teamSize: 1 }));
  const before = sandboxRepository.exportJson(state);
  assert.throws(
    () => executeIncidentResponseCoordinationBatch(state, requests, [0, 1, 2, 3]),
    /requires review/i,
  );
  assert.equal(sandboxRepository.exportJson(state), before);
  assert.equal(incidentResponseTeams(state).length, 0);
  assert.equal(incidentResponseOperations(state).length, 0);
  assert.equal(incidentResponseResourceReservations(state).length, 0);
});

test('I2-R validates duplicate or invalid selections before mutation', async () => {
  const { state } = await fixture(0x1212103);
  state.settlement.resources.water = 10;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const before = sandboxRepository.exportJson(state);
  assert.throws(() => executeIncidentResponseCoordinationBatch(state, requests, [0, 0]), /same request more than once/i);
  assert.throws(() => executeIncidentResponseCoordinationBatch(state, requests, [2]), /valid operator-selected request indices/i);
  assert.equal(sandboxRepository.exportJson(state), before);
});

test('I2-R executes selected expedition requests only against field resources and persists no batch authority', async () => {
  const { state } = await fixture(0x1212104);
  const leader = state.agents
    .filter((agent) => agent.alive && agent.role !== 'child' && agent.expeditionId === null)
    .sort((left, right) => right.skills.scouting - left.skills.scouting)[0];
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: [leader.id],
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
  });
  expedition.supplies.food = Math.max(expedition.supplies.food, 20);
  expedition.supplies.water = Math.max(expedition.supplies.water, 20);
  expedition.supplies.medicine = Math.max(expedition.supplies.medicine, 10);
  expedition.supplies.tools = Math.max(expedition.supplies.tools, 10);
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, expedition, null).incidents[0];
  assert.ok(incident);
  const beforeSettlement = structuredClone(state.settlement.resources);
  const beforeSupplies = structuredClone(expedition.supplies);
  const result = executeIncidentResponseCoordinationBatch(
    state,
    [{ incidentId: incident.id, teamSize: 1 }],
    [0],
    expedition,
  );
  assert.equal(result.contextKey, `expedition:${expedition.id}`);
  assert.equal(result.executions.length, 1);
  assert.deepEqual(state.settlement.resources, beforeSettlement);
  assert.ok(expedition.supplies.food <= beforeSupplies.food);
  assert.ok(expedition.supplies.water <= beforeSupplies.water);
  const exported = sandboxRepository.exportJson(state);
  assert.doesNotMatch(exported, /incidentResponseCoordinationBatch/);
  const restored = importSandboxSave(exported);
  assert.equal(Object.hasOwn(restored, 'incidentResponseCoordinationBatch'), false);
});

test('I2-R batch execution is deterministic across save reload and returns stable post-execution replan guidance', async () => {
  const first = await fixture(0x1212105);
  first.state.settlement.resources.water = 20;
  first.state.settlement.resources.food = 100;
  first.state.settlement.resources.medicine = 20;
  first.state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(first.state);
  const restored = importSandboxSave(sandboxRepository.exportJson(first.state));
  const incident = deriveVisibleIncidentProjection(first.state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const a = executeIncidentResponseCoordinationBatch(first.state, requests, [0, 2]);
  const b = executeIncidentResponseCoordinationBatch(restored, requests, [0, 2]);
  assert.deepEqual(b, a);
  assert.equal(restored.diagnostics.replayHash, first.state.diagnostics.replayHash);
  assert.deepEqual(incidentResponseTeams(restored), incidentResponseTeams(first.state));
  assert.deepEqual(incidentResponseResourceReservations(restored), incidentResponseResourceReservations(first.state));
});


test('I2-S readback resolves an external I2-R receipt against active canonical response records only', async () => {
  const { state } = await fixture(0x1213101);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 2 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0, 1]);
  const readback = deriveIncidentResponseCoordinationReadback(state, receipt);
  assert.equal(readback.items.length, 2);
  assert.equal(readback.retainedCount, 2);
  assert.equal(readback.activeCount, 2);
  assert.equal(readback.terminalCount, 0);
  assert.equal(readback.missingCount, 0);
  assert.ok(readback.items.every((item) => item.status === 'mobilizing'));
  assert.deepEqual(readback.items.map((item) => item.originalRequestIndex), [0, 1]);
  assert.ok(readback.items.every((item) => item.resourcePhase === 'reserved'));
});

test('I2-S readback follows canonical terminal/debrief/resource facts after time advances', async () => {
  const { provider, state } = await fixture(0x1213102);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }];
  const plan = deriveIncidentResponseLogisticsPlan(state, incident.id, 1);
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  await advanceSandbox(provider, state, plan.totalEstimateMinutes);
  synchronizeIncidentResponseOperations(state);
  synchronizeIncidentResponseDebriefs(state);
  const readback = deriveIncidentResponseCoordinationReadback(state, receipt);
  assert.equal(readback.activeCount, 0);
  assert.equal(readback.terminalCount, 1);
  assert.equal(readback.items[0].status, 'completed');
  assert.equal(readback.items[0].resourcePhase, 'settled');
  assert.ok(readback.items[0].terminalAt >= receipt.startedAt);
  assert.ok(readback.items[0].debriefId);
  assert.deepEqual(readback.items[0].reservedResources, receipt.executions[0].reservedResources);
});

test('I2-S external receipt readback survives save reload without persisting a new coordination history authority', async () => {
  const { state } = await fixture(0x1213103);
  state.settlement.resources.water = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }];
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const before = deriveIncidentResponseCoordinationReadback(state, receipt);
  const exported = sandboxRepository.exportJson(state);
  assert.doesNotMatch(exported, /incidentResponseCoordination(Readback|History|Retry)/);
  const restored = importSandboxSave(exported);
  const after = deriveIncidentResponseCoordinationReadback(restored, receipt);
  assert.deepEqual(after, before);
});

test('I2-S retry/replan is review-only under current capacity and executes only after explicit capacity becomes available', async () => {
  const { state } = await fixture(0x1213104);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incidentId = 'incident:settlement:water-low';
  const fillers = Array.from({ length: 3 }, () => assignIncidentResponseRosterTeam(state, incidentId, 1));
  for (const team of fillers) dispatchIncidentResponseTeam(state, team.id);
  const requests = [{ incidentId, teamSize: 1 }];
  const blocked = deriveIncidentResponseCoordinationRetryPlan(state, requests, 0);
  assert.equal(blocked.canExecuteNow, false);
  assert.ok(blocked.blockers.includes('team-capacity'));
  const before = sandboxRepository.exportJson(state);
  assert.throws(() => executeIncidentResponseCoordinationRetry(state, requests, 0), /still requires review/i);
  assert.equal(sandboxRepository.exportJson(state), before);
  standDownIncidentResponseTeam(state, fillers[0].id);
  const ready = deriveIncidentResponseCoordinationRetryPlan(state, requests, 0);
  assert.equal(ready.canExecuteNow, true);
  const executed = executeIncidentResponseCoordinationRetry(state, requests, 0);
  assert.equal(executed.retryPlan.originalRequestIndex, 0);
  assert.equal(executed.batch.executions.length, 1);
  assert.deepEqual(executed.batch.executions[0].memberIds, ready.plannedMemberIds);
});

test('I2-S readback rejects forged retained canonical linkage without mutating sandbox state', async () => {
  const { state } = await fixture(0x1213105);
  state.settlement.resources.water = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const receipt = executeIncidentResponseCoordinationBatch(state, [{ incidentId: incident.id, teamSize: 1 }], [0]);
  const forged = structuredClone(receipt);
  forged.executions[0].incidentId = 'incident:forged';
  const before = sandboxRepository.exportJson(state);
  assert.throws(() => deriveIncidentResponseCoordinationReadback(state, forged), /canonical linkage mismatch/i);
  assert.equal(sandboxRepository.exportJson(state), before);
});


test('I2-T external receipt registry stores bounded operator receipts outside sandbox authority', async () => {
  const { state } = await fixture(0x1214101);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 2 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, receipt);
  assert.equal(entry.id, 'incident-response-external-receipt:1');
  assert.equal(registry.entries.length, 1);
  assert.deepEqual(registry.entries[0].receipt, receipt);
  const save = sandboxRepository.exportJson(state);
  assert.doesNotMatch(save, /external-receipt|incidentResponseExternalReceiptRegistry|retryQueue/i);
});

test('I2-T external receipt registry export/import round-trips and rejects forbidden outcome fields', async () => {
  const { state } = await fixture(0x1214102);
  state.settlement.resources.water = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  registerIncidentResponseCoordinationReceipt(registry, requests, receipt);
  const serialized = exportIncidentResponseExternalReceiptRegistry(registry);
  assert.deepEqual(importIncidentResponseExternalReceiptRegistry(serialized), registry);
  const forged = JSON.parse(serialized);
  forged.entries[0].outcome = 'success';
  assert.throws(() => importIncidentResponseExternalReceiptRegistry(JSON.stringify(forged)), /forbidden field/i);
});

test('I2-T retry queue guidance revalidates unselected external requests against current canonical state', async () => {
  const { state } = await fixture(0x1214103);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, receipt);
  const guidance = deriveIncidentResponseExternalRetryQueueGuidance(state, registry);
  assert.equal(guidance.registryEntryCount, 1);
  assert.equal(guidance.readbackActiveCount, 1);
  assert.deepEqual(guidance.items.map((item) => item.originalRequestIndex), [1, 2]);
  assert.ok(guidance.items.every((item) => item.disposition === 'ready-now'));
  const retry = executeIncidentResponseCoordinationRetry(state, requests, 1);
  recordIncidentResponseExternalRetryExecution(registry, entry.id, 1, retry.batch);
  const after = deriveIncidentResponseExternalRetryQueueGuidance(state, registry);
  assert.deepEqual(after.items.map((item) => item.originalRequestIndex), [2]);
  assert.equal(after.readbackActiveCount, 2);
  assert.deepEqual(registry.entries[0].pendingRequestIndices, [2]);
  assert.equal(registry.entries[0].retryReceipts.length, 1);
});

test('I2-T retry queue guidance survives sandbox reload plus external registry export/import deterministically', async () => {
  const { state } = await fixture(0x1214104);
  state.settlement.resources.water = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  registerIncidentResponseCoordinationReceipt(registry, requests, receipt);
  const before = deriveIncidentResponseExternalRetryQueueGuidance(state, registry);
  const restoredState = importSandboxSave(sandboxRepository.exportJson(state));
  const restoredRegistry = importIncidentResponseExternalReceiptRegistry(exportIncidentResponseExternalReceiptRegistry(registry));
  const after = deriveIncidentResponseExternalRetryQueueGuidance(restoredState, restoredRegistry);
  assert.deepEqual(after, before);
});

test('I2-T external receipt registry deterministically bounds retained external receipts to 32 entries', async () => {
  const { state } = await fixture(0x1214105);
  state.settlement.resources.water = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }];
  const receipt = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  for (let index = 0; index < 35; index += 1) registerIncidentResponseCoordinationReceipt(registry, requests, receipt);
  assert.equal(registry.entries.length, 32);
  assert.equal(registry.entries[0].ordinal, 4);
  assert.equal(registry.entries.at(-1).ordinal, 35);
  assert.equal(registry.nextOrdinal, 36);
  assert.deepEqual(importIncidentResponseExternalReceiptRegistry(exportIncidentResponseExternalReceiptRegistry(registry)), registry);
});


test('I2-U explicit queue-item execution commits canonical retry and external receipt atomically', async () => {
  const { state } = await fixture(0x1215101);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const beforeTeams = incidentResponseTeams(state).length;
  const result = executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 1);
  assert.equal(result.selectedItem.disposition, 'ready-now');
  assert.equal(result.retry.batch.executions.length, 1);
  assert.equal(incidentResponseTeams(state).length, beforeTeams + 1);
  assert.deepEqual(registry.entries[0].pendingRequestIndices, [2]);
  assert.equal(registry.entries[0].retryReceipts.length, 1);
  assert.equal(result.guidanceAfter.items.some((item) => item.registryEntryId === entry.id && item.originalRequestIndex === 1), false);
  assert.doesNotMatch(sandboxRepository.exportJson(state), /incidentResponseExternalReceiptRegistry|incidentResponseExternalRetryQueue/i);
});

test('I2-U review-only queue item rejects without mutating sandbox or external registry', async () => {
  const { state } = await fixture(0x1215102);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 4 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0, 1, 2]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const guidance = deriveIncidentResponseExternalRetryQueueGuidance(state, registry);
  assert.equal(guidance.items.find((item) => item.originalRequestIndex === 3)?.disposition, 'review');
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  assert.throws(() => executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 3), /requires review/i);
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});

test('I2-U rolls back sandbox and external registry if external receipt recording fails after retry execution', async () => {
  const { state } = await fixture(0x1215103);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  Object.freeze(registry.entries[0]);
  assert.throws(() => executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 1));
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});

test('I2-U rejects missing/non-pending queue identity without mutation', async () => {
  const { state } = await fixture(0x1215104);
  state.settlement.resources.water = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  assert.throws(() => executeIncidentResponseExternalRetryQueueItem(state, registry, 'incident-response-external-receipt:999', 1), /retained registry entry/i);
  assert.throws(() => executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 0), /currently pending/i);
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});

test('I2-U queue execution stays deterministic across sandbox reload and registry export/import', async () => {
  const { state } = await fixture(0x1215105);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const mirrorState = importSandboxSave(sandboxRepository.exportJson(state));
  const mirrorRegistry = importIncidentResponseExternalReceiptRegistry(exportIncidentResponseExternalReceiptRegistry(registry));
  const a = executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 1);
  const b = executeIncidentResponseExternalRetryQueueItem(mirrorState, mirrorRegistry, entry.id, 1);
  assert.deepEqual(b, a);
  assert.equal(sandboxRepository.exportJson(mirrorState), sandboxRepository.exportJson(state));
  assert.deepEqual(mirrorRegistry, registry);
});


test('I2-V explicit external queue batch commits multiple ready items atomically in operator order', async () => {
  const { state } = await fixture(0x1216101);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const result = executeIncidentResponseExternalRetryQueueBatch(state, registry, [
    { registryEntryId: entry.id, originalRequestIndex: 1 },
    { registryEntryId: entry.id, originalRequestIndex: 2 },
  ]);
  assert.deepEqual(result.selections.map((item) => item.originalRequestIndex), [1, 2]);
  assert.equal(result.executions.length, 2);
  assert.deepEqual(registry.entries[0].pendingRequestIndices, []);
  assert.deepEqual(registry.entries[0].retryReceipts.map((item) => item.originalRequestIndex), [1, 2]);
  assert.equal(result.guidanceAfter.items.some((item) => item.registryEntryId === entry.id), false);
  assert.equal(incidentResponseTeams(state).length, 3);
});

test('I2-V external queue batch rolls back earlier items when a later selection becomes review during commit', async () => {
  const { state } = await fixture(0x1216102);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 4 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  const beforeGuidance = deriveIncidentResponseExternalRetryQueueGuidance(state, registry);
  assert.deepEqual(beforeGuidance.items.map((item) => item.disposition), ['ready-now', 'ready-now', 'ready-now']);
  assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(state, registry, [
    { registryEntryId: entry.id, originalRequestIndex: 1 },
    { registryEntryId: entry.id, originalRequestIndex: 2 },
    { registryEntryId: entry.id, originalRequestIndex: 3 },
  ]), /requires review during commit/i);
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});

test('I2-V external queue batch rejects duplicate or initially review selections without mutation', async () => {
  const { state } = await fixture(0x1216103);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 4 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0, 1, 2]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(state, registry, [
    { registryEntryId: entry.id, originalRequestIndex: 3 },
    { registryEntryId: entry.id, originalRequestIndex: 3 },
  ]), /duplicates/i);
  assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(state, registry, [
    { registryEntryId: entry.id, originalRequestIndex: 3 },
  ]), /requires review before commit/i);
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});

test('I2-V external queue batch jointly rolls back sandbox and registry when later external recording fails', async () => {
  const { state } = await fixture(0x1216104);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const requestsA = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const initialA = executeIncidentResponseCoordinationBatch(state, requestsA, [0]);
  const entryA = registerIncidentResponseCoordinationReceipt(registry, requestsA, initialA);
  standDownIncidentResponseTeam(state, initialA.executions[0].team.id);
  const requestsB = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const initialB = executeIncidentResponseCoordinationBatch(state, requestsB, [0]);
  const entryB = registerIncidentResponseCoordinationReceipt(registry, requestsB, initialB);
  standDownIncidentResponseTeam(state, initialB.executions[0].team.id);
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  Object.freeze(registry.entries[1]);
  assert.throws(() => executeIncidentResponseExternalRetryQueueBatch(state, registry, [
    { registryEntryId: entryA.id, originalRequestIndex: 1 },
    { registryEntryId: entryB.id, originalRequestIndex: 1 },
  ]));
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});

test('I2-V external queue batch stays deterministic across sandbox reload and registry export/import', async () => {
  const { state } = await fixture(0x1216105);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const mirrorState = importSandboxSave(sandboxRepository.exportJson(state));
  const mirrorRegistry = importIncidentResponseExternalReceiptRegistry(exportIncidentResponseExternalReceiptRegistry(registry));
  const selections = [
    { registryEntryId: entry.id, originalRequestIndex: 1 },
    { registryEntryId: entry.id, originalRequestIndex: 2 },
  ];
  const a = executeIncidentResponseExternalRetryQueueBatch(state, registry, selections);
  const b = executeIncidentResponseExternalRetryQueueBatch(mirrorState, mirrorRegistry, selections);
  assert.deepEqual(b, a);
  assert.equal(sandboxRepository.exportJson(mirrorState), sandboxRepository.exportJson(state));
  assert.deepEqual(mirrorRegistry, registry);
  assert.doesNotMatch(sandboxRepository.exportJson(state), /incidentResponseExternalRetryQueueBatch|incidentResponseExternalReceiptRegistry/i);
});


test('I2-W external batch readback summarizes recorded retry receipts using fact-only canonical data', async () => {
  const { state } = await fixture(0x1217101);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const selections = [1, 2].map((originalRequestIndex) => ({ registryEntryId: entry.id, originalRequestIndex }));
  executeIncidentResponseExternalRetryQueueBatch(state, registry, selections);
  const readback = deriveIncidentResponseExternalBatchReadback(state, registry, selections);
  assert.equal(readback.recordedCount, 2);
  assert.equal(readback.pendingCount, 0);
  assert.equal(readback.retainedCount, 2);
  assert.equal(readback.activeCount, 2);
  assert.equal(readback.items.length, 2);
  assert.ok(readback.reservedResources.food > 0);
  assert.ok(readback.reservedResources.water > 0);
  assert.doesNotMatch(JSON.stringify(readback), /"success"|"failure"|"outcome"|"causeConfirmed"|"hiddenCause"/i);
});

test('I2-W external batch readback reports pending selections and fails closed on canonical linkage mismatch', async () => {
  const { state } = await fixture(0x1217102);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const selection = [{ registryEntryId: entry.id, originalRequestIndex: 1 }];
  const pending = deriveIncidentResponseExternalBatchReadback(state, registry, selection);
  assert.equal(pending.pendingCount, 1);
  assert.equal(pending.items[0].status, 'pending');
  executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 1);
  registry.entries[0].retryReceipts[0].receipt.executions[0].memberIds = ['individual:tampered'];
  assert.throws(() => deriveIncidentResponseExternalBatchReadback(state, registry, selection), /canonical linkage mismatch/i);
});

test('I2-W external batch retry plan is pure and reports review without canonical mutation', async () => {
  const { state } = await fixture(0x1217103);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 4 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0, 1, 2]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  const plan = deriveIncidentResponseExternalBatchRetryPlan(state, registry, [{ registryEntryId: entry.id, originalRequestIndex: 3 }]);
  assert.equal(plan.readyNowCount, 0);
  assert.equal(plan.reviewCount, 1);
  assert.equal(plan.canExecuteAtomicBatch, false);
  assert.equal(plan.items[0].disposition, 'review');
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});

test('I2-W explicit batch retry commits selected pending requests through I2-V atomically', async () => {
  const { state } = await fixture(0x1217104);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const selections = [1, 2].map((originalRequestIndex) => ({ registryEntryId: entry.id, originalRequestIndex }));
  const result = executeIncidentResponseExternalBatchRetry(state, registry, selections);
  assert.equal(result.retryPlan.canExecuteAtomicBatch, true);
  assert.equal(result.batch.executions.length, 2);
  assert.deepEqual(registry.entries[0].pendingRequestIndices, []);
  const readback = deriveIncidentResponseExternalBatchReadback(state, registry, selections);
  assert.equal(readback.recordedCount, 2);
});

test('I2-W explicit batch retry rolls back when a later selection becomes review during commit', async () => {
  const { state } = await fixture(0x1217105);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 4 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const selections = [1, 2, 3].map((originalRequestIndex) => ({ registryEntryId: entry.id, originalRequestIndex }));
  const plan = deriveIncidentResponseExternalBatchRetryPlan(state, registry, selections);
  assert.equal(plan.canExecuteAtomicBatch, true);
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  assert.throws(() => executeIncidentResponseExternalBatchRetry(state, registry, selections), /requires review during commit/i);
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
});


test('I2-X external batch readback filter/search stays fact-only and preserves source order', async () => {
  const { state } = await fixture(0x1218101);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 1);
  const selections = [1, 2].map((originalRequestIndex) => ({ registryEntryId: entry.id, originalRequestIndex }));
  const readback = deriveIncidentResponseExternalBatchReadback(state, registry, selections);
  const recorded = filterIncidentResponseExternalBatchReadback(readback, 'recorded');
  const pending = filterIncidentResponseExternalBatchReadback(readback, 'pending');
  const active = filterIncidentResponseExternalBatchReadback(readback, 'active');
  assert.deepEqual(recorded.items.map((item) => item.originalRequestIndex), [1]);
  assert.deepEqual(pending.items.map((item) => item.originalRequestIndex), [2]);
  assert.deepEqual(active.items.map((item) => item.originalRequestIndex), [1]);
  const factSearch = filterIncidentResponseExternalBatchReadback(readback, 'all', `${entry.id} request-index:1`);
  assert.deepEqual(factSearch.items.map((item) => item.originalRequestIndex), [1]);
  assert.equal(filterIncidentResponseExternalBatchReadback(readback, 'all', 'successful causal resolution').items.length, 0);
  assert.doesNotMatch(JSON.stringify(recorded), /"success"|"failure"|"outcome"|"causeConfirmed"|"hiddenCause"/i);
});

test('I2-X external batch readback snapshot export/import is portable non-authoritative data', async () => {
  const { state } = await fixture(0x1218102);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = [{ incidentId: incident.id, teamSize: 1 }, { incidentId: incident.id, teamSize: 1 }];
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const readback = deriveIncidentResponseExternalBatchReadback(state, registry, [{ registryEntryId: entry.id, originalRequestIndex: 1 }]);
  const view = filterIncidentResponseExternalBatchReadback(readback, 'pending');
  const exported = exportIncidentResponseExternalBatchReadbackSnapshot(view);
  const imported = importIncidentResponseExternalBatchReadbackSnapshot(exported);
  assert.equal(imported.authority, 'external-observer-snapshot');
  assert.deepEqual(imported.view, view);
  const tampered = JSON.parse(exported);
  tampered.view.items[0].outcome = 'success';
  assert.throws(() => importIncidentResponseExternalBatchReadbackSnapshot(JSON.stringify(tampered)), /forbidden field/i);
  assert.doesNotMatch(sandboxRepository.exportJson(state), /externalBatchReadbackSnapshot|external-observer-snapshot/i);
});

test('I2-X review batch replan partitions review and newly-ready selections without mutation', async () => {
  const { state } = await fixture(0x1218103);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 4 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0, 1, 2]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const selection = [{ registryEntryId: entry.id, originalRequestIndex: 3 }];
  const beforeState = sandboxRepository.exportJson(state);
  const beforeRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  const blocked = deriveIncidentResponseExternalReviewBatchReplan(state, registry, selection);
  assert.equal(blocked.readyNowCount, 0);
  assert.equal(blocked.reviewCount, 1);
  assert.deepEqual(blocked.reviewSelections, selection);
  assert.equal(sandboxRepository.exportJson(state), beforeState);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeRegistry);
  standDownIncidentResponseTeam(state, initial.executions[0].team.id);
  const beforeReadyRegistry = exportIncidentResponseExternalReceiptRegistry(registry);
  const ready = deriveIncidentResponseExternalReviewBatchReplan(state, registry, selection);
  assert.equal(ready.readyNowCount, 1);
  assert.equal(ready.reviewCount, 0);
  assert.deepEqual(ready.readySelections, selection);
  assert.equal(ready.canExecuteReadySubset, true);
  assert.equal(exportIncidentResponseExternalReceiptRegistry(registry), beforeReadyRegistry);
});

test('I2-X terminal filter recomputes fact totals from only matching recorded items', async () => {
  const { state } = await fixture(0x1218104);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 3 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  executeIncidentResponseExternalRetryQueueItem(state, registry, entry.id, 1);
  standDownIncidentResponseTeam(state, registry.entries[0].retryReceipts[0].receipt.executions[0].team.id);
  const readback = deriveIncidentResponseExternalBatchReadback(state, registry, [
    { registryEntryId: entry.id, originalRequestIndex: 1 },
    { registryEntryId: entry.id, originalRequestIndex: 2 },
  ]);
  const terminal = filterIncidentResponseExternalBatchReadback(readback, 'terminal');
  assert.equal(terminal.items.length, 1);
  assert.equal(terminal.terminalCount, 1);
  assert.equal(terminal.pendingCount, 0);
  assert.equal(terminal.recordedCount, 1);
  assert.ok(terminal.reservedResources.food >= terminal.consumedResources.food);
});

test('I2-X filter/export/replan remains deterministic across sandbox reload and registry roundtrip', async () => {
  const { state } = await fixture(0x1218105);
  state.settlement.resources.water = 20;
  state.settlement.resources.food = 100;
  state.settlement.resources.medicine = 20;
  state.settlement.resources.scrap = 20;
  synchronizeIncidentLedger(state);
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  assert.ok(incident);
  const requests = Array.from({ length: 4 }, () => ({ incidentId: incident.id, teamSize: 1 }));
  const initial = executeIncidentResponseCoordinationBatch(state, requests, [0, 1, 2]);
  const registry = createIncidentResponseExternalReceiptRegistry();
  const entry = registerIncidentResponseCoordinationReceipt(registry, requests, initial);
  const selection = [{ registryEntryId: entry.id, originalRequestIndex: 3 }];
  const mirrorState = importSandboxSave(sandboxRepository.exportJson(state));
  const mirrorRegistry = importIncidentResponseExternalReceiptRegistry(exportIncidentResponseExternalReceiptRegistry(registry));
  const aPlan = deriveIncidentResponseExternalReviewBatchReplan(state, registry, selection);
  const bPlan = deriveIncidentResponseExternalReviewBatchReplan(mirrorState, mirrorRegistry, selection);
  assert.deepEqual(bPlan, aPlan);
  const aReadback = deriveIncidentResponseExternalBatchReadback(state, registry, selection);
  const bReadback = deriveIncidentResponseExternalBatchReadback(mirrorState, mirrorRegistry, selection);
  const aSnapshot = exportIncidentResponseExternalBatchReadbackSnapshot(filterIncidentResponseExternalBatchReadback(aReadback, 'all', entry.id));
  const bSnapshot = exportIncidentResponseExternalBatchReadbackSnapshot(filterIncidentResponseExternalBatchReadback(bReadback, 'all', entry.id));
  assert.equal(bSnapshot, aSnapshot);
  assert.deepEqual(importIncidentResponseExternalBatchReadbackSnapshot(bSnapshot), importIncidentResponseExternalBatchReadbackSnapshot(aSnapshot));
});

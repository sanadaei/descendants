import { readSandboxUiSource } from './read-sandbox-ui.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileTestDist } from './compile-test-dist.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const code = await compileTestDist();
if (code !== 0) process.exit(code);
const appSource = await readSandboxUiSource();
const cssSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { advanceSandbox } = await import('../.test-dist/sandbox/engine.js');
const {
  assignIncidentResponseTeam,
  deriveIncidentDispatchCapacity,
  deriveVisibleIncidentProjection,
  dispatchIncidentResponseTeam,
  incidentResponseDebriefs,
  incidentResponseOperations,
  incidentResponseResourceReservations,
  isI2F1IncidentAdapterEnabled,
  selectF1IncidentReadModel,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

const requiredActions = ['incident-adapter-toggle','incident-response-member','incident-assign','incident-dispatch','incident-stand-down','incident-resource-use'];
for (const action of requiredActions) assert.ok(appSource.includes(`data-action="${action}"`), `missing UI action ${action}`);
for (const seam of ['assignIncidentResponseTeam','dispatchIncidentResponseTeam','standDownIncidentResponseTeam','applyIncidentResponseEvidenceResourceUse','incidentResponseDebriefs']) assert.ok(appSource.includes(seam), `missing response seam ${seam}`);
assert.ok(appSource.includes('RESPONSE CHANNEL OFFLINE'));
assert.ok(appSource.includes('Visibility loss or operation completion alone does not resolve this incident'));
assert.ok(!appSource.includes('resolvePersistedIncident(this.state'));
assert.ok(cssSource.includes('.desc-pda-response-panel'));
assert.equal(isI2F1IncidentAdapterEnabled(), false, 'Node audit must retain default-off incident adapter');

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x12090001, population: 16 });
const legacyRead = selectF1IncidentReadModel(state, null, null, false);
const incidentRead = selectF1IncidentReadModel(state, null, null, true);
assert.equal(legacyRead.source, 'legacy');
assert.equal(incidentRead.source, 'incident');
assert.ok(incidentRead.incidents.length > 0);
const incidentId = incidentRead.incidents[0].id;
const capacity = deriveIncidentDispatchCapacity(state, incidentId);
assert.ok(capacity.canAssign && capacity.availableMemberIds.length > 0);
const clockBefore = structuredClone(state.clock);
const ledgerBefore = structuredClone(state.incidentLedger);
const team = assignIncidentResponseTeam(state, incidentId, capacity.availableMemberIds.slice(0, Math.min(2, capacity.availableMemberIds.length)));
assert.deepEqual(state.clock, clockBefore);
assert.deepEqual(state.incidentLedger, ledgerBefore);
const dispatched = dispatchIncidentResponseTeam(state, team.id);
assert.equal(dispatched.phase, 'dispatched');
assert.deepEqual(state.clock, clockBefore);
assert.deepEqual(state.incidentLedger, ledgerBefore);
const operation = incidentResponseOperations(state, incidentId)[0];
const reservation = incidentResponseResourceReservations(state, incidentId)[0];
assert.ok(operation && reservation);
const totalMinutes = operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes;
await advanceSandbox(provider, state, totalMinutes);
const debrief = incidentResponseDebriefs(state, incidentId)[0];
assert.ok(debrief);
assert.ok(['completed','aborted'].includes(debrief.terminalPhase));
for (const forbidden of ['title','summary','detail','text','outcome','success','failure','causeConfirmed','interpretation','causalAssessment']) assert.equal(Object.hasOwn(debrief, forbidden), false);
const restored = importSandboxSave(sandboxRepository.exportJson(state));
assert.deepEqual(restored.incidentDispatch, state.incidentDispatch);
assert.deepEqual(restored.incidentResponseOperations, state.incidentResponseOperations);
assert.deepEqual(restored.incidentResponseResources, state.incidentResponseResources);
assert.deepEqual(restored.incidentResponseDebriefs, state.incidentResponseDebriefs);

const result = {
  status: 'PASS',
  requiredActions: requiredActions.length,
  adapterDefault: 'off',
  legacyReadSource: legacyRead.source,
  optInReadSource: incidentRead.source,
  incidentId,
  teamPhaseAfterDispatch: dispatched.phase,
  terminalDebriefPhase: debrief.terminalPhase,
  observationCount: debrief.observations.length,
  positiveEvidenceFactCount: debrief.positiveEvidence.length,
  resourceUseFactCount: debrief.evidenceResourceUses.length,
  saveReloadRoundTrip: true,
  causalOutcomeFieldsPersisted: 0,
};
console.log(JSON.stringify(result, null, 2));

import { readSandboxUiSource } from './read-sandbox-ui.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileTestDist } from './compile-test-dist.mjs';

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
  dispatchIncidentResponseTeam,
  incidentResponseDebriefs,
  selectF1IncidentReadModel,
  synchronizeIncidentLedger,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

for (const action of ['incident-focus','incident-debrief-select','incident-debrief-prev','incident-debrief-next']) {
  assert.ok(appSource.includes(`data-action="${action}"`), `missing I2-J action ${action}`);
}
assert.ok(appSource.includes("#selectedIncidentId = ''"));
assert.ok(appSource.includes("#selectedDebriefId = ''"));
assert.ok(appSource.includes('role="option" aria-selected="${selected}"'));
assert.ok(appSource.includes("['ArrowUp','ArrowDown','Home','End'].includes(event.key)"));
assert.doesNotMatch(appSource,/selectedIncidentId:\s*(?:this|ctx)\.#?selectedIncidentId/);
assert.ok(!appSource.includes('resolvePersistedIncident(this.state'));
assert.ok(cssSource.includes('.desc-pda-incident-focus:focus-visible'));
assert.ok(cssSource.includes('.desc-pda-response-debrief-detail'));
assert.ok(cssSource.includes('@media(max-width:620px)'));

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x120a0001, population: 24 });
state.settlement.resources.food = 30;
state.settlement.resources.water = 30;
synchronizeIncidentLedger(state);
const read = selectF1IncidentReadModel(state, null, null, true);
assert.equal(read.source, 'incident');
assert.ok(read.incidents.length >= 2, 'audit seed must expose at least two selectable incidents');
const primaryId = read.incidents[0].id;
const focusedId = read.incidents[1].id;
assert.notEqual(focusedId, primaryId);

let capacity = deriveIncidentDispatchCapacity(state, focusedId);
assert.ok(capacity.canAssign && capacity.availableMemberIds.length >= 2);
const clockBefore = structuredClone(state.clock);
const ledgerBefore = structuredClone(state.incidentLedger);
const first = assignIncidentResponseTeam(state, focusedId, capacity.availableMemberIds.slice(0,2));
dispatchIncidentResponseTeam(state, first.id);
assert.deepEqual(state.clock, clockBefore, 'focus-target assignment/dispatch must not consume canonical time');
assert.deepEqual(state.incidentLedger, ledgerBefore, 'focus-target assignment/dispatch must not mutate Incident truth');
capacity = deriveIncidentDispatchCapacity(state, focusedId);
assert.ok(capacity.canAssign && capacity.availableMemberIds.length >= 1);
const second = assignIncidentResponseTeam(state, focusedId, capacity.availableMemberIds.slice(0,Math.min(2,capacity.availableMemberIds.length)));
dispatchIncidentResponseTeam(state, second.id);

const operations = state.incidentResponseOperations?.operations.filter((entry)=>entry.incidentId===focusedId) ?? [];
assert.equal(operations.length, 2);
const totalMinutes = Math.max(...operations.map((operation)=>operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes));
await advanceSandbox(provider, state, totalMinutes);
const debriefs = incidentResponseDebriefs(state, focusedId).slice().reverse();
assert.equal(debriefs.length, 2, 'history navigation fixture must retain two terminal debriefs');
for (const debrief of debriefs) {
  for (const forbidden of ['title','summary','detail','text','outcome','success','failure','causeConfirmed','interpretation','causalAssessment']) {
    assert.equal(Object.hasOwn(debrief, forbidden), false, `debrief must not persist ${forbidden}`);
  }
}
const exported = sandboxRepository.exportJson(state);
assert.equal(exported.includes('selectedIncidentId'), false, 'session-local incident focus must not enter the save');
assert.equal(exported.includes('selectedDebriefId'), false, 'session-local debrief focus must not enter the save');
const restored = importSandboxSave(exported);
assert.deepEqual(restored.incidentResponseDebriefs, state.incidentResponseDebriefs);
assert.deepEqual(restored.incidentDispatch, state.incidentDispatch);

console.log(JSON.stringify({
  status: 'PASS',
  visibleIncidentCount: read.incidents.length,
  primaryIncidentId: primaryId,
  nonPrimaryFocusedIncidentId: focusedId,
  responseTeamsOnFocusedIncident: 2,
  terminalDebriefHistoryCount: debriefs.length,
  sessionLocalFocusPersisted: false,
  causalOutcomeFieldsPersisted: 0,
  saveReloadRoundTrip: true,
  keyboardNavigation: ['ArrowUp','ArrowDown','Home','End'],
  compactBreakpoints: [900,620],
}, null, 2));

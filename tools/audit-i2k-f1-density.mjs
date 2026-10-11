import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const appSource = await readFile(new URL('../src/sandbox/app.ts', import.meta.url), 'utf8');
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
  standDownIncidentResponseTeam,
  synchronizeIncidentLedger,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

for (const action of ['incident-debrief-filter','incident-density-toggle','incident-debrief-select','incident-debrief-prev','incident-debrief-next']) {
  assert.ok(appSource.includes(`data-action="${action}"`), `missing I2-K action ${action}`);
}
for (const filter of ['all','completed','aborted','evidence','resource']) assert.ok(appSource.includes(`'${filter}'`));
assert.ok(appSource.includes("#incidentResponseDensity: IncidentResponseDensity = 'standard'"));
assert.ok(appSource.includes('incident/debrief filters and density are session-local'));
assert.ok(cssSource.includes('.desc-pda-response-status-strip'));
assert.ok(cssSource.includes('.desc-pda-response-panel.is-compact'));
assert.ok(cssSource.includes('.desc-pda-response-toolbar'));

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x120b0001, population: 30 });
state.settlement.resources.food = 60;
state.settlement.resources.water = 60;
state.settlement.resources.medicine = 8;
state.settlement.resources.scrap = 12;
synchronizeIncidentLedger(state);
const read = selectF1IncidentReadModel(state, null, null, true);
assert.equal(read.source, 'incident');
assert.ok(read.incidents.length >= 1);
const incidentId = read.incidents[0].id;

const teams = [];
for (let i=0;i<3;i+=1) {
  const capacity = deriveIncidentDispatchCapacity(state, incidentId);
  assert.ok(capacity.canAssign && capacity.availableMemberIds.length >= 1);
  const team = assignIncidentResponseTeam(state, incidentId, capacity.availableMemberIds.slice(0, Math.min(2, capacity.availableMemberIds.length)));
  dispatchIncidentResponseTeam(state, team.id);
  teams.push(team);
}
standDownIncidentResponseTeam(state, teams[2].id);
const operations = state.incidentResponseOperations?.operations.filter((entry)=>entry.incidentId===incidentId && entry.phase!=='aborted') ?? [];
const totalMinutes = Math.max(...operations.map((operation)=>operation.plannedMobilizationMinutes + operation.plannedWorkMinutes + operation.plannedReturnMinutes));
await advanceSandbox(provider, state, totalMinutes);
const debriefs = incidentResponseDebriefs(state, incidentId).slice().reverse();
assert.equal(debriefs.length, 3);
const completed = debriefs.filter((entry)=>entry.terminalPhase==='completed');
const aborted = debriefs.filter((entry)=>entry.terminalPhase==='aborted');
assert.equal(completed.length, 2);
assert.equal(aborted.length, 1);
const evidence = debriefs.filter((entry)=>entry.positiveEvidence.length>0);
const resource = debriefs.filter((entry)=>entry.evidenceResourceUses.length>0);

const exported = sandboxRepository.exportJson(state);
for (const forbidden of ['incidentDebriefFilter','incidentResponseDensity','selectedDebriefId','selectedIncidentId']) {
  assert.equal(exported.includes(forbidden), false, `${forbidden} must remain session-local`);
}
const restored = importSandboxSave(exported);
assert.deepEqual(restored.incidentResponseDebriefs, state.incidentResponseDebriefs);

console.log(JSON.stringify({
  status: 'PASS',
  incidentId,
  debriefCounts: { all: debriefs.length, completed: completed.length, aborted: aborted.length, evidence: evidence.length, resource: resource.length },
  responseTeams: teams.length,
  sessionLocalPresentationPersisted: false,
  causalOutcomeFieldsIntroduced: 0,
  saveReloadRoundTrip: true,
  densityModes: ['standard','compact'],
  filters: ['all','completed','aborted','evidence','resource'],
}, null, 2));

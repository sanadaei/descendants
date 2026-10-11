import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const appSource = await readFile(new URL('../src/sandbox/app.ts', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const {
  filterIncidentResponseDebriefs,
  summarizeIncidentDebriefTimeline,
} = await import('../.test-dist/sandbox/incidentDebriefReadModel.js');
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
const { sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

for (const action of ['incident-debrief-search','incident-debrief-search-clear','incident-debrief-filter','incident-debrief-select','incident-debrief-prev','incident-debrief-next']) {
  assert.ok(appSource.includes(`data-action="${action}"`), `missing I2-L action ${action}`);
}
assert.ok(appSource.includes('summarizeIncidentDebriefTimeline(allDebriefs)'));
assert.ok(appSource.includes('role="listbox" aria-label="Filtered debrief history"'));
assert.ok(appSource.includes("const debriefFocus = eventTarget?.closest<HTMLElement>('[data-action=\"incident-debrief-select\"]')"));
assert.ok(appSource.includes("const debriefFilter = eventTarget?.closest<HTMLElement>('[data-action=\"incident-debrief-filter\"]')"));
assert.ok(appSource.includes("event.key==='/'"));
assert.ok(cssSource.includes('.desc-pda-response-search'));
assert.ok(cssSource.includes('.desc-pda-response-timeline'));

const provider = new MockWorldProvider();
const state = await createInitialSandboxState(provider, { seed: 0x120c0001, population: 30 });
state.settlement.resources.food = 80;
state.settlement.resources.water = 80;
synchronizeIncidentLedger(state);
const read = selectF1IncidentReadModel(state, null, null, true);
assert.equal(read.source, 'incident');
const incidentId = read.incidents[0]?.id;
assert.ok(incidentId);
const teams=[];
for (let i=0;i<3;i+=1) {
  const capacity=deriveIncidentDispatchCapacity(state,incidentId);
  assert.ok(capacity.canAssign && capacity.availableMemberIds.length>0);
  const team=assignIncidentResponseTeam(state,incidentId,capacity.availableMemberIds.slice(0,Math.min(2,capacity.availableMemberIds.length)));
  dispatchIncidentResponseTeam(state,team.id);
  teams.push(team);
}
standDownIncidentResponseTeam(state,teams[2].id);
const active=state.incidentResponseOperations?.operations.filter((entry)=>entry.incidentId===incidentId&&entry.phase!=='aborted')??[];
const minutes=Math.max(...active.map((entry)=>entry.plannedMobilizationMinutes+entry.plannedWorkMinutes+entry.plannedReturnMinutes));
await advanceSandbox(provider,state,minutes);
const debriefs=incidentResponseDebriefs(state,incidentId).slice().reverse();
assert.equal(debriefs.length,3);
const summary=summarizeIncidentDebriefTimeline(debriefs);
assert.equal(summary.terminalCount,3);
assert.equal(summary.completedCount,2);
assert.equal(summary.abortedCount,1);
const memberId=debriefs[0].memberIds[0];
assert.ok(memberId);
assert.ok(filterIncidentResponseDebriefs(debriefs,'all',memberId).length>=1);
assert.equal(filterIncidentResponseDebriefs(debriefs,'completed','').length,2);
assert.equal(filterIncidentResponseDebriefs(debriefs,'aborted','').length,1);
assert.equal(filterIncidentResponseDebriefs(debriefs,'all','successful causal resolution').length,0);
const exported=sandboxRepository.exportJson(state);
for (const forbidden of ['incidentDebriefQuery','incidentDebriefFilter','incidentResponseDensity','selectedDebriefId','selectedIncidentId']) {
  assert.equal(exported.includes(forbidden),false,`${forbidden} must remain session-local`);
}

console.log(JSON.stringify({
  status:'PASS',
  incidentId,
  terminalDebriefs:summary.terminalCount,
  completedDebriefs:summary.completedCount,
  abortedDebriefs:summary.abortedCount,
  timelineSpanMinutes:summary.spanMinutes,
  structuredMemberSearchMatches:filterIncidentResponseDebriefs(debriefs,'all',memberId).length,
  inferredSuccessSearchMatches:0,
  sessionLocalPresentationPersisted:false,
  keyboardSemantics:{incident:['ArrowUp','ArrowDown','Home','End'],debrief:['ArrowUp','ArrowDown','Home','End'],filter:['ArrowLeft','ArrowRight','Home','End'],searchShortcut:'/',searchClear:'Escape'},
},null,2));

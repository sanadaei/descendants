import test from 'node:test';
import assert from 'node:assert/strict';

const {
  filterIncidentResponseDebriefs,
  incidentDebriefFactTokens,
  incidentDebriefMatchesFilter,
  summarizeIncidentDebriefTimeline,
} = await import('../.test-dist/sandbox/incidentDebriefReadModel.js');

function debrief(id, terminalPhase, terminalAt, overrides={}) {
  return {
    id: `incident-response-debrief:${id}`,
    operationId: `incident-response-operation:${id}`,
    teamId: `incident-response-team:${id}`,
    contextKey: 'settlement',
    incidentId: 'incident:test',
    terminalPhase,
    generatedAt: terminalAt,
    lastRefreshedAt: terminalAt,
    memberIds: [`agent-${id}`],
    chronology: { startedAt: terminalAt-30, arrivedAt: terminalAt-20, workCompletedAt: terminalAt-10, terminalAt },
    observations: [],
    positiveEvidence: [],
    evidenceResourceUses: [],
    ...overrides,
  };
}

const rows = [
  debrief('a','completed',120,{
    observations:[{id:'obs-a',ordinal:1,kind:'return-complete',observedAt:120,incidentVisibility:'visible'}],
    positiveEvidence:[{id:'evidence-a',kind:'communication-restored',observedAt:110,occurrenceNumber:1,subjectIds:['relay-a'],supportingOperationIds:['incident-response-operation:a']}],
    evidenceResourceUses:[{id:'use-a',ordinal:1,operationId:'incident-response-operation:a',reservationId:'reservation-a',contextKey:'settlement',incidentId:'incident:test',evidenceId:'evidence-a',evidenceKind:'communication-restored',evidenceOccurrenceNumber:1,recordedAt:120,medicine:0,tools:.5}],
  }),
  debrief('b','aborted',180,{
    observations:[{id:'obs-b',ordinal:2,kind:'operator-stand-down',observedAt:180,incidentVisibility:'not-checked'}],
  }),
  debrief('c','completed',240,{
    observations:[{id:'obs-c',ordinal:3,kind:'post-response-visibility',observedAt:230,incidentVisibility:'not-visible'}],
    positiveEvidence:[{id:'evidence-c',kind:'recorded-case-cleared',observedAt:225,occurrenceNumber:2,subjectIds:['patient-c'],supportingOperationIds:['incident-response-operation:c']}],
    evidenceResourceUses:[{id:'use-c',ordinal:2,operationId:'incident-response-operation:c',reservationId:'reservation-c',contextKey:'settlement',incidentId:'incident:test',evidenceId:'evidence-c',evidenceKind:'recorded-case-cleared',evidenceOccurrenceNumber:2,recordedAt:240,medicine:.25,tools:0}],
  }),
];

test('I2-L fact tokens contain only structured identifiers, observations, evidence and resource-use values', () => {
  const tokens = incidentDebriefFactTokens(rows[0], (id)=>id==='agent-a'?'Ada Responder':undefined);
  for (const expected of ['completed','agent-a','ada responder','return-complete','visible','communication-restored','relay-a','tools:0.5']) assert.ok(tokens.includes(expected), expected);
  for (const forbidden of ['success','failure','cause confirmed','effective because']) assert.equal(tokens.includes(forbidden), false);
});

test('I2-L search composes AND terms over structured debrief facts without changing source order', () => {
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'all','communication restored').map((row)=>row.id), [rows[0].id]);
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'all','not-visible recorded-case-cleared').map((row)=>row.id), [rows[2].id]);
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'all','Ada', (id)=>id==='agent-a'?'Ada Responder':id).map((row)=>row.id), [rows[0].id]);
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'all','').map((row)=>row.id), rows.map((row)=>row.id));
});

test('I2-L terminal/evidence/resource filters remain fact-only and compose with search', () => {
  assert.equal(incidentDebriefMatchesFilter(rows[1],'aborted'), true);
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'completed','').map((row)=>row.id), [rows[0].id,rows[2].id]);
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'evidence','').map((row)=>row.id), [rows[0].id,rows[2].id]);
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'resource','recorded-case').map((row)=>row.id), [rows[2].id]);
});

test('I2-L timeline summary is bounded to terminal chronology and structured fact counts', () => {
  assert.deepEqual(summarizeIncidentDebriefTimeline(rows), {
    terminalCount:3,
    completedCount:2,
    abortedCount:1,
    firstTerminalAt:120,
    lastTerminalAt:240,
    spanMinutes:120,
    observationCount:3,
    positiveEvidenceCount:2,
    resourceUseCount:2,
  });
});

test('I2-L empty timeline and impossible fact search fail closed without inferred results', () => {
  assert.deepEqual(summarizeIncidentDebriefTimeline([]), {
    terminalCount:0,completedCount:0,abortedCount:0,firstTerminalAt:null,lastTerminalAt:null,spanMinutes:0,observationCount:0,positiveEvidenceCount:0,resourceUseCount:0,
  });
  assert.deepEqual(filterIncidentResponseDebriefs(rows,'all','successful causal resolution'), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { advanceSandboxHours } from '../.test-dist/sandbox/engine.js';
import {
  ensureDailyLoopState,
  captureMorningSnapshot,
  buildMorningReport,
  setDailyAssignment,
  setExecutionPolicy,
  commitDailyPlan,
  executeCommittedPlan,
  resolveDailyInterruptionAsAuto,
  previewDailyInterruption,
} from '../.test-dist/sandbox/dailyActionLoop.js';

async function initial(seed = 94001) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed });
  delete state.dailyLoop;
  return { provider, state };
}

test('daily loop lazily initializes without changing save schema and captures a morning snapshot', async () => {
  const { state } = await initial();
  const loop = ensureDailyLoopState(state);
  assert.equal(state.schemaVersion, 1);
  assert.equal(loop.schemaVersion, 1);
  assert.equal(loop.phase, 'planning');
  assert.equal(loop.currentPlan.day, state.clock.day);
  assert.equal(loop.currentPlan.status, 'draft');
  assert.equal(loop.lastMorningSnapshot.day, state.clock.day);
  assert.equal(loop.lastMorningSnapshot.residents.length, state.agents.filter((agent) => agent.alive && !agent.expeditionId).length);
});

test('morning report is a real before-after diff and sorts critical deterioration before stable residents', async () => {
  const { state } = await initial(94002);
  const before = captureMorningSnapshot(state);
  const locals = state.agents.filter((agent) => agent.alive && !agent.expeditionId);
  assert.ok(locals.length >= 2);
  locals[0].health = 18;
  locals[0].needs.thirst = 92;
  locals[0].pathology.push({ id: 'case:test-critical', pathologyId: 'test-fever', onsetDay: state.clock.day, severity: 82, contagious: true, observedSymptoms: ['high fever'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  state.clock.day += 1;
  const after = captureMorningSnapshot(state);
  const report = buildMorningReport(before, after, { births: [], deaths: [], expeditionUpdates: [], settlementUpdates: [] });
  assert.equal(report.day, after.day);
  assert.equal(report.residentDeltas[0].agentId, locals[0].id);
  assert.equal(report.residentDeltas[0].severity, 'critical');
  assert.ok(report.residentDeltas[0].healthDelta < 0);
  const stable = report.residentDeltas.find((entry) => entry.agentId === locals[1].id);
  assert.ok(stable);
  assert.equal(stable.severity, 'stable');
});

test('player can draft explicit resident work and AUTO/MANUAL execution policies then commit the plan', async () => {
  const { state } = await initial(94003);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(resident);
  setDailyAssignment(state, resident.id, 'water');
  setExecutionPolicy(state, 'expedition', 'manual');
  setExecutionPolicy(state, 'medical', 'auto');
  const plan = commitDailyPlan(state);
  assert.equal(plan.status, 'committed');
  assert.equal(plan.assignments.find((entry) => entry.agentId === resident.id)?.task, 'water');
  assert.equal(plan.policies.expedition, 'manual');
  assert.equal(plan.policies.medical, 'auto');
});

test('AUTO execution applies explicit assignment and reaches the next morning with a report', async () => {
  const { provider, state } = await initial(94004);
  const resident = state.agents.find((agent) => agent.alive && !agent.expeditionId && agent.role !== 'child');
  assert.ok(resident);
  const startDay = state.clock.day;
  const startMinute = state.clock.minuteOfDay;
  setDailyAssignment(state, resident.id, 'water');
  setExecutionPolicy(state, 'expedition', 'auto');
  setExecutionPolicy(state, 'medical', 'auto');
  commitDailyPlan(state);
  const result = await executeCommittedPlan(provider, state);
  assert.equal(result.status, 'completed');
  assert.equal(state.clock.day, startDay + 1);
  assert.equal(state.clock.minuteOfDay, startMinute);
  assert.equal(state.dailyLoop.phase, 'planning');
  assert.equal(state.dailyLoop.lastMorningReport.day, state.clock.day);
  assert.ok(state.dailyLoop.lastMorningReport.residentDeltas.some((entry) => entry.agentId === resident.id));
  assert.equal(state.dailyLoop.lastMorningReport.residentDeltas.find((entry) => entry.agentId === resident.id)?.task, 'water', 'explicit daily assignment must drive the simulated work day');
});

test('MANUAL medical policy interrupts before daily execution when a severe resident needs a decision', async () => {
  const { provider, state } = await initial(94005);
  const patient = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(patient);
  patient.health = 32;
  patient.pathology.push({ id: 'case:manual-medical', pathologyId: 'wound-infection', onsetDay: state.clock.day, severity: 72, contagious: false, observedSymptoms: ['fever'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  setExecutionPolicy(state, 'medical', 'manual');
  commitDailyPlan(state);
  const day = state.clock.day;
  const result = await executeCommittedPlan(provider, state);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.interruption.kind, 'medical');
  assert.ok(result.interruption.subjectIds.includes(patient.id));
  assert.equal(state.clock.day, day, 'preflight manual interruption must not advance canonical time');
  assert.equal(state.dailyLoop.phase, 'interrupted');
});


test('MANUAL expedition policy interrupts when an active field operation needs player control', async () => {
  const { provider, state } = await initial(94006);
  const leader = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(leader);
  state.expeditions.push({ id:'exp:manual-test', status:'outbound', memberIds:[leader.id], leaderId:leader.id });
  setExecutionPolicy(state, 'expedition', 'manual');
  commitDailyPlan(state);
  const result = await executeCommittedPlan(provider, state);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.interruption.kind, 'expedition');
  assert.deepEqual(result.interruption.subjectIds, ['exp:manual-test']);
});

test('resuming after a manual interruption still stops at the originally scheduled next morning', async () => {
  const { provider, state } = await initial(94007);
  const patient = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(patient);
  patient.health = 30;
  patient.pathology.push({ id:'case:resume', pathologyId:'wound-infection', onsetDay:state.clock.day, severity:70, contagious:false, observedSymptoms:['fever'], suspectedCauses:[], treatmentsTried:[], status:'active' });
  setExecutionPolicy(state,'medical','manual');
  commitDailyPlan(state);
  const startAbsolute=(state.clock.day-1)*1440+state.clock.minuteOfDay;
  const interrupted=await executeCommittedPlan(provider,state);
  assert.equal(interrupted.status,'interrupted');
  await advanceSandboxHours(provider,state,1); // manual intervention consumed canonical time
  resolveDailyInterruptionAsAuto(state,'medical');
  const completed=await executeCommittedPlan(provider,state);
  assert.equal(completed.status,'completed');
  const endAbsolute=(state.clock.day-1)*1440+state.clock.minuteOfDay;
  assert.equal(endAbsolute,startAbsolute+1440,'manual intervention time counts inside the same daily execution window');
});


test('manual interruption preview uses the same predicate as execution', async () => {
  const { provider, state } = await initial(94008);
  const patient = state.agents.find((agent) => agent.alive && !agent.expeditionId);
  assert.ok(patient);
  patient.health = 32;
  patient.pathology.push({
    id: 'case:preview-medical', pathologyId: 'wound-infection', onsetDay: state.clock.day,
    severity: 72, contagious: false, observedSymptoms: ['fever'], suspectedCauses: [],
    treatmentsTried: [], status: 'active',
  });
  setExecutionPolicy(state, 'medical', 'manual');
  const loop = ensureDailyLoopState(state);
  const preview = previewDailyInterruption(state, loop.currentPlan);
  assert.equal(preview?.kind, 'medical');
  assert.ok(preview?.subjectIds.includes(patient.id));
  commitDailyPlan(state);
  const result = await executeCommittedPlan(provider, state);
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(result.interruption, preview);
});

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
  deriveVisibleIncidentProjection,
  dispatchIncidentResponseTeam,
  standDownIncidentResponseTeam,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

function forbiddenTruthPayloadCount(state) {
  return (state.incidentDispatch?.teams ?? []).filter((team) =>
    ['title','summary','detail','presentation','visibleStakeText','outcome','success','failure'].some((field) => Object.hasOwn(team, field))).length;
}

function invariantFailures(state) {
  const teams = state.incidentDispatch?.teams ?? [];
  let failures = 0;
  if (teams.length > 192) failures += 1;
  const byContext = new Map();
  const byIncident = new Map();
  const membersByContext = new Map();
  for (const team of teams.filter((entry) => entry.phase === 'assigned' || entry.phase === 'dispatched')) {
    const contextCount = (byContext.get(team.contextKey) ?? 0) + 1;
    byContext.set(team.contextKey, contextCount);
    if (contextCount > 4) failures += 1;
    const incidentKey = `${team.contextKey}|${team.incidentId}`;
    const incidentCount = (byIncident.get(incidentKey) ?? 0) + 1;
    byIncident.set(incidentKey, incidentCount);
    if (incidentCount > 3) failures += 1;
    if (team.memberIds.length < 1 || team.memberIds.length > 4 || new Set(team.memberIds).size !== team.memberIds.length) failures += 1;
    const used = membersByContext.get(team.contextKey) ?? new Set();
    for (const memberId of team.memberIds) {
      if (used.has(memberId)) failures += 1;
      used.add(memberId);
    }
    membersByContext.set(team.contextKey, used);
  }
  return failures;
}

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let index = 0; index < payload.length; index += 1) { result ^= payload.charCodeAt(index); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function assignAndDispatchFirst(state, teamSize = 1) {
  const incident = deriveVisibleIncidentProjection(state, null, null).incidents[0];
  if (!incident) return null;
  const capacity = deriveIncidentDispatchCapacity(state, incident.id);
  if (!capacity.canAssign || capacity.availableMemberIds.length < teamSize) return null;
  const team = assignIncidentResponseTeam(state, incident.id, capacity.availableMemberIds.slice(0, teamSize));
  return dispatchIncidentResponseTeam(state, team.id);
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x120c17, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
const uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));

// Establish two simultaneous response teams against the same observer-visible incident.
const initialIncidentA = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents[0];
const initialIncidentB = deriveVisibleIncidentProjection(reloadPath, null, null).incidents[0];
assert.equal(initialIncidentA?.id, initialIncidentB?.id);
assert.ok(initialIncidentA);
for (const state of [uninterrupted, reloadPath]) {
  const cap = deriveIncidentDispatchCapacity(state, initialIncidentA.id);
  assert.ok(cap.availableMemberIds.length >= 2);
  const first = assignIncidentResponseTeam(state, initialIncidentA.id, [cap.availableMemberIds[0]]);
  dispatchIncidentResponseTeam(state, first.id);
  const next = deriveIncidentDispatchCapacity(state, initialIncidentA.id);
  const second = assignIncidentResponseTeam(state, initialIncidentA.id, [next.availableMemberIds[0]]);
  dispatchIncidentResponseTeam(state, second.id);
}

let comparisons = 0;
let reloads = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let forbiddenTruthPayloads = 0;
let operatorActions = 4;
let maxTeams = 0;
let maxActiveTeams = 0;

for (let step = 0; step <= 120; step += 1) {
  for (const state of [uninterrupted, reloadPath]) {
    comparisons += 1;
    const teams = state.incidentDispatch?.teams ?? [];
    maxTeams = Math.max(maxTeams, teams.length);
    maxActiveTeams = Math.max(maxActiveTeams, teams.filter((team) => team.phase !== 'stood-down').length);
    invariantFailureCount += invariantFailures(state);
    forbiddenTruthPayloads += forbiddenTruthPayloadCount(state);
  }
  if (JSON.stringify(uninterrupted.incidentDispatch) !== JSON.stringify(reloadPath.incidentDispatch)) determinismMismatchCount += 1;

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);

  if (step + 1 === 40) {
    for (const state of [uninterrupted, reloadPath]) {
      const team = state.incidentDispatch.teams.find((entry) => entry.phase === 'dispatched');
      if (team) standDownIncidentResponseTeam(state, team.id);
    }
    if (uninterrupted.incidentDispatch.teams.some((entry) => entry.phase === 'dispatched')) operatorActions += 2;
  }
  if (step + 1 === 60) {
    const a = assignAndDispatchFirst(uninterrupted, 2);
    const b = assignAndDispatchFirst(reloadPath, 2);
    assert.equal(a?.id ?? null, b?.id ?? null);
    assert.deepEqual(a?.memberIds ?? [], b?.memberIds ?? []);
    if (a) operatorActions += 2;
  }
  if (step + 1 === 80) {
    for (const state of [uninterrupted, reloadPath]) {
      const team = state.incidentDispatch.teams.find((entry) => entry.phase === 'dispatched');
      if (team) standDownIncidentResponseTeam(state, team.id);
    }
    operatorActions += 2;
  }

  if ((step + 1) % 4 === 0) {
    const before = structuredClone(reloadPath.incidentDispatch);
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    assert.deepEqual(reloadPath.incidentDispatch, before, 'incident dispatch must survive save/reload byte-semantically');
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(forbiddenTruthPayloads, 0);
assert.deepEqual(reloadPath.incidentDispatch, uninterrupted.incidentDispatch);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  operatorActions,
  determinismMismatchCount,
  invariantFailureCount,
  forbiddenTruthPayloads,
  maxTeams,
  maxActiveTeams,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalDispatchHash: hash(uninterrupted.incidentDispatch),
  finalTeams: uninterrupted.incidentDispatch?.teams.length ?? 0,
  finalActiveTeams: uninterrupted.incidentDispatch?.teams.filter((team) => team.phase !== 'stood-down').length ?? 0,
}, null, 2));

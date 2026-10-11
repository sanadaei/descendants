import assert from 'node:assert/strict';
import { compileTestDist } from './compile-test-dist.mjs';

const code = await compileTestDist();
if (code !== 0) process.exit(code);
const { createInitialSandboxState } = await import('../.test-dist/sandbox/bootstrap.js');
const { MockWorldProvider } = await import('../.test-dist/worldbridge/mockWorldProvider.js');
const { SnapshotWorldProvider } = await import('../.test-dist/worldbridge/snapshotWorldProvider.js');
const { advanceSandboxHours } = await import('../.test-dist/sandbox/engine.js');
const {
  createIncidentResponseExternalReceiptRegistry,
  registerIncidentResponseCoordinationReceipt,
  recordIncidentResponseExternalRetryExecution,
  exportIncidentResponseExternalReceiptRegistry,
  importIncidentResponseExternalReceiptRegistry,
  deriveIncidentResponseExternalRetryQueueGuidance,
  deriveVisibleIncidentProjection,
  executeIncidentResponseCoordinationBatch,
  executeIncidentResponseCoordinationRetry,
  synchronizeIncidentLedger,
  synchronizeIncidentResponseOperations,
} = await import('../.test-dist/sandbox/incidentService.js');
const { importSandboxSave, sandboxRepository } = await import('../.test-dist/sandbox/storage.js');

function hash(value) {
  const payload = JSON.stringify(value);
  let result = 2166136261 >>> 0;
  for (let i = 0; i < payload.length; i += 1) { result ^= payload.charCodeAt(i); result = Math.imul(result, 16777619) >>> 0; }
  return result.toString(16).padStart(8, '0');
}

function guidanceFailures(guidance) {
  let failures = 0;
  if (guidance.readyNowCount + guidance.reviewCount !== guidance.items.length) failures += 1;
  if (guidance.items.some((item) => !['ready-now', 'review'].includes(item.disposition))) failures += 1;
  if (guidance.items.some((item) => Object.hasOwn(item, 'success') || Object.hasOwn(item, 'failure') || Object.hasOwn(item, 'outcome') || Object.hasOwn(item, 'causeConfirmed'))) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12141a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 50;
  state.settlement.resources.food = 150;
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 40);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 40);
  synchronizeIncidentLedger(state);
}
let registryA = createIncidentResponseExternalReceiptRegistry();
let registryB = createIncidentResponseExternalReceiptRegistry();

const incidentId = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents[0]?.id;
assert.ok(incidentId);
assert.equal(deriveVisibleIncidentProjection(reloadPath, null, null).incidents[0]?.id, incidentId);
const controlledRequests = Array.from({ length: 3 }, () => ({ incidentId, teamSize: 1 }));
const receiptA = executeIncidentResponseCoordinationBatch(uninterrupted, controlledRequests, [0]);
const receiptB = executeIncidentResponseCoordinationBatch(reloadPath, controlledRequests, [0]);
assert.deepEqual(receiptB, receiptA);
const entryA = registerIncidentResponseCoordinationReceipt(registryA, controlledRequests, receiptA);
const entryB = registerIncidentResponseCoordinationReceipt(registryB, controlledRequests, receiptB);
assert.deepEqual(entryB, entryA);
let guidanceA = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA);
let guidanceB = deriveIncidentResponseExternalRetryQueueGuidance(reloadPath, registryB);
assert.deepEqual(guidanceB, guidanceA);
assert.deepEqual(guidanceA.items.map((item) => item.originalRequestIndex), [1, 2]);
const retryA = executeIncidentResponseCoordinationRetry(uninterrupted, controlledRequests, 1);
const retryB = executeIncidentResponseCoordinationRetry(reloadPath, controlledRequests, 1);
assert.deepEqual(retryB, retryA);
recordIncidentResponseExternalRetryExecution(registryA, entryA.id, 1, retryA.batch);
recordIncidentResponseExternalRetryExecution(registryB, entryB.id, 1, retryB.batch);
guidanceA = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA);
guidanceB = deriveIncidentResponseExternalRetryQueueGuidance(reloadPath, registryB);
assert.deepEqual(guidanceB, guidanceA);
assert.deepEqual(guidanceA.items.map((item) => item.originalRequestIndex), [2]);

let comparisons = 2;
let reloads = 0;
let registeredReceipts = 2;
let retryReceiptsRecorded = 2;
let determinismMismatchCount = 0;
let invariantFailureCount = guidanceFailures(guidanceA) + guidanceFailures(guidanceB);
let maxRegistryEntries = 1;
let maxQueueItems = guidanceA.items.length;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  synchronizeIncidentResponseOperations(uninterrupted);
  synchronizeIncidentResponseOperations(reloadPath);
  const a = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA);
  const b = deriveIncidentResponseExternalRetryQueueGuidance(reloadPath, registryB);
  comparisons += 2;
  if (JSON.stringify(a) !== JSON.stringify(b)) determinismMismatchCount += 1;
  invariantFailureCount += guidanceFailures(a) + guidanceFailures(b);
  maxRegistryEntries = Math.max(maxRegistryEntries, registryA.entries.length);
  maxQueueItems = Math.max(maxQueueItems, a.items.length);

  const incidents = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents;
  const mirrorIncidents = deriveVisibleIncidentProjection(reloadPath, null, null).incidents;
  assert.deepEqual(mirrorIncidents.map((incident) => incident.id), incidents.map((incident) => incident.id));
  if (incidents.length && step > 0 && step % 16 === 0) {
    const requests = Array.from({ length: 2 }, () => ({ incidentId: incidents[0].id, teamSize: 1 }));
    try {
      const batchA = executeIncidentResponseCoordinationBatch(uninterrupted, requests, [0]);
      const batchB = executeIncidentResponseCoordinationBatch(reloadPath, requests, [0]);
      assert.deepEqual(batchB, batchA);
      registerIncidentResponseCoordinationReceipt(registryA, requests, batchA);
      registerIncidentResponseCoordinationReceipt(registryB, requests, batchB);
      registeredReceipts += 2;
    } catch (error) {
      assert.match(String(error), /requires review|capacity|resource/i);
    }
  }

  if (step === 120) break;
  await advanceSandboxHours(uninterruptedProvider, uninterrupted, 6);
  await advanceSandboxHours(reloadProvider, reloadPath, 6);
  if ((step + 1) % 4 === 0) {
    reloadPath = importSandboxSave(sandboxRepository.exportJson(reloadPath));
    reloadProvider = new SnapshotWorldProvider(structuredClone(reloadPath.world.providerSnapshot));
    registryB = importIncidentResponseExternalReceiptRegistry(exportIncidentResponseExternalReceiptRegistry(registryB));
    reloads += 1;
  }
}

assert.equal(determinismMismatchCount, 0);
assert.equal(invariantFailureCount, 0);
assert.equal(registryA.entries.length, registryB.entries.length);
assert.deepEqual(registryB, registryA);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalReceiptRegistry'), false);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalRetryQueue'), false);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);
const exportedState = sandboxRepository.exportJson(uninterrupted);
assert.doesNotMatch(exportedState, /external-receipt|incidentResponseExternalReceiptRegistry|incidentResponseExternalRetryQueue/i);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  registeredReceipts,
  retryReceiptsRecorded,
  maxRegistryEntries,
  maxQueueItems,
  retainedRegistryLimit: registryA.maxEntries,
  determinismMismatchCount,
  invariantFailureCount,
  persistedExternalRegistryAuthority: false,
  persistedRetryQueueAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalRegistryHash: hash(registryA),
  finalGuidanceHash: hash(deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA)),
}, null, 2));

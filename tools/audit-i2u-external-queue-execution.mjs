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
  exportIncidentResponseExternalReceiptRegistry,
  importIncidentResponseExternalReceiptRegistry,
  deriveIncidentResponseExternalRetryQueueGuidance,
  executeIncidentResponseExternalRetryQueueItem,
  deriveVisibleIncidentProjection,
  executeIncidentResponseCoordinationBatch,
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

function invariantFailures(guidance) {
  let failures = 0;
  if (guidance.readyNowCount + guidance.reviewCount !== guidance.items.length) failures += 1;
  if (guidance.items.some((item) => !['ready-now', 'review'].includes(item.disposition))) failures += 1;
  if (guidance.items.some((item) => Object.hasOwn(item, 'success') || Object.hasOwn(item, 'failure') || Object.hasOwn(item, 'outcome') || Object.hasOwn(item, 'causeConfirmed'))) failures += 1;
  return failures;
}

const seedProvider = new MockWorldProvider();
const initial = await createInitialSandboxState(seedProvider, { seed: 0x12151a, population: 18 });
let uninterrupted = structuredClone(initial);
let reloadPath = structuredClone(initial);
let uninterruptedProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
let reloadProvider = new SnapshotWorldProvider(structuredClone(initial.world.providerSnapshot));
for (const state of [uninterrupted, reloadPath]) {
  state.settlement.resources.water = 80;
  state.settlement.resources.food = 200;
  state.settlement.resources.medicine = Math.max(state.settlement.resources.medicine, 50);
  state.settlement.resources.scrap = Math.max(state.settlement.resources.scrap, 50);
  synchronizeIncidentLedger(state);
}
let registryA = createIncidentResponseExternalReceiptRegistry();
let registryB = createIncidentResponseExternalReceiptRegistry();

const incidentId = deriveVisibleIncidentProjection(uninterrupted, null, null).incidents[0]?.id;
assert.ok(incidentId);
assert.equal(deriveVisibleIncidentProjection(reloadPath, null, null).incidents[0]?.id, incidentId);
const controlledRequests = Array.from({ length: 3 }, () => ({ incidentId, teamSize: 1 }));
const initialA = executeIncidentResponseCoordinationBatch(uninterrupted, controlledRequests, [0]);
const initialB = executeIncidentResponseCoordinationBatch(reloadPath, controlledRequests, [0]);
assert.deepEqual(initialB, initialA);
const entryA = registerIncidentResponseCoordinationReceipt(registryA, controlledRequests, initialA);
const entryB = registerIncidentResponseCoordinationReceipt(registryB, controlledRequests, initialB);
assert.deepEqual(entryB, entryA);
const firstA = executeIncidentResponseExternalRetryQueueItem(uninterrupted, registryA, entryA.id, 1);
const firstB = executeIncidentResponseExternalRetryQueueItem(reloadPath, registryB, entryB.id, 1);
assert.deepEqual(firstB, firstA);
assert.deepEqual(registryB, registryA);
assert.deepEqual(registryA.entries[0].pendingRequestIndices, [2]);

let comparisons = 2;
let reloads = 0;
let registeredReceipts = 2;
let queueExecutions = 2;
let reviewRejects = 0;
let determinismMismatchCount = 0;
let invariantFailureCount = 0;
let maxRegistryEntries = registryA.entries.length;
let maxQueueItems = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA).items.length;

for (let step = 0; step <= 120; step += 1) {
  synchronizeIncidentLedger(uninterrupted);
  synchronizeIncidentLedger(reloadPath);
  synchronizeIncidentResponseOperations(uninterrupted);
  synchronizeIncidentResponseOperations(reloadPath);
  const a = deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA);
  const b = deriveIncidentResponseExternalRetryQueueGuidance(reloadPath, registryB);
  comparisons += 2;
  if (JSON.stringify(a) !== JSON.stringify(b)) determinismMismatchCount += 1;
  invariantFailureCount += invariantFailures(a) + invariantFailures(b);
  maxRegistryEntries = Math.max(maxRegistryEntries, registryA.entries.length);
  maxQueueItems = Math.max(maxQueueItems, a.items.length);

  if (step > 0 && step % 10 === 0 && a.items.length) {
    const item = a.items[0];
    const mirrorItem = b.items[0];
    assert.deepEqual(mirrorItem, item);
    if (item.disposition === 'ready-now') {
      const resultA = executeIncidentResponseExternalRetryQueueItem(uninterrupted, registryA, item.registryEntryId, item.originalRequestIndex);
      const resultB = executeIncidentResponseExternalRetryQueueItem(reloadPath, registryB, item.registryEntryId, item.originalRequestIndex);
      assert.deepEqual(resultB, resultA);
      assert.deepEqual(registryB, registryA);
      queueExecutions += 2;
    } else {
      const beforeA = sandboxRepository.exportJson(uninterrupted);
      const beforeB = sandboxRepository.exportJson(reloadPath);
      const regA = exportIncidentResponseExternalReceiptRegistry(registryA);
      const regB = exportIncidentResponseExternalReceiptRegistry(registryB);
      assert.throws(() => executeIncidentResponseExternalRetryQueueItem(uninterrupted, registryA, item.registryEntryId, item.originalRequestIndex), /requires review/i);
      assert.throws(() => executeIncidentResponseExternalRetryQueueItem(reloadPath, registryB, mirrorItem.registryEntryId, mirrorItem.originalRequestIndex), /requires review/i);
      assert.equal(sandboxRepository.exportJson(uninterrupted), beforeA);
      assert.equal(sandboxRepository.exportJson(reloadPath), beforeB);
      assert.equal(exportIncidentResponseExternalReceiptRegistry(registryA), regA);
      assert.equal(exportIncidentResponseExternalReceiptRegistry(registryB), regB);
      reviewRejects += 2;
    }
  }

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
assert.deepEqual(registryB, registryA);
assert.equal(reloadPath.diagnostics.replayHash, uninterrupted.diagnostics.replayHash);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalReceiptRegistry'), false);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalRetryQueue'), false);
assert.equal(Object.hasOwn(uninterrupted, 'incidentResponseExternalRetryQueueExecution'), false);
const exportedState = sandboxRepository.exportJson(uninterrupted);
assert.doesNotMatch(exportedState, /external-receipt|incidentResponseExternalReceiptRegistry|incidentResponseExternalRetryQueue/i);

console.log(JSON.stringify({
  status: 'PASS',
  comparisons,
  reloads,
  registeredReceipts,
  queueExecutions,
  reviewRejects,
  maxRegistryEntries,
  maxQueueItems,
  determinismMismatchCount,
  invariantFailureCount,
  persistedExternalRegistryAuthority: false,
  persistedRetryQueueAuthority: false,
  persistedQueueExecutionAuthority: false,
  finalDay: uninterrupted.clock.day,
  finalReplayHash: uninterrupted.diagnostics.replayHash,
  finalRegistryHash: hash(registryA),
  finalGuidanceHash: hash(deriveIncidentResponseExternalRetryQueueGuidance(uninterrupted, registryA)),
}, null, 2));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ContentPackRegistry, WorldgenEngine, parseWorldRecipe, snapshotDigest } from '../vendor/worldgen-engine/dist/index.js';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { advanceSandboxDays, advanceSandboxHours } from '../.test-dist/sandbox/engine.js';
import { launchExpedition } from '../.test-dist/sandbox/expeditionSimulation.js';
import { issueExternalAction } from '../.test-dist/sandbox/externalActions.js';
import { importSandboxSave } from '../.test-dist/sandbox/storage.js';
import { assertSnapshotIdentity } from '../.test-dist/worldbridge/providerGuard.js';
import { createRealWorldRuntime } from '../.test-dist/worldbridge/realWorldProvider.js';

const recipePath = new URL('../vendor/worldgen-engine/setting-packs/descendants/default.recipe.json', import.meta.url);
const packRoot = new URL('../vendor/worldgen-engine/setting-packs/descendants/content-packs/', import.meta.url);
const worldgenPackage = JSON.parse(fs.readFileSync(new URL('../vendor/worldgen-engine/package.json', import.meta.url), 'utf8'));
const expectedWorldgenVersion = worldgenPackage.version;

function loadRecipeAndContent() {
  const raw = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
  const content = new ContentPackRegistry();
  for (const ref of raw.contentPacks ?? []) {
    content.register(JSON.parse(fs.readFileSync(new URL(`${ref.id}.json`, packRoot), 'utf8')));
  }
  return { raw, recipe: parseWorldRecipe(JSON.stringify(raw)), content };
}

async function createReal(seed = 0xdecaf) {
  const { raw, recipe, content } = loadRecipeAndContent();
  const provider = await new WorldgenEngine(undefined, content).generate(recipe);
  const manifest = await provider.getManifest();
  const state = await createInitialSandboxState(provider, {
    seed,
    clockPolicy: { worldTicksPerDay: raw.clock.ticksPerDay, activeRadiusKm: 25, activeDetailRank: 0, epochWorldTick: manifest.currentTick, epochGameMinute: 0 },
  });
  return { raw, recipe, content, provider, state };
}

test('real Worldgen boots sandbox population from provider-materialized origin individuals after burn-in', async () => {
  const { raw, provider, state } = await createReal(10101);
  const fine = await provider.queryArea({ center: structuredClone(state.settlement.position), radiusKm: 2.5, requestedDetailRank: 0, observerId: state.world.originEntityId, includeKnowledgeProjection: true });
  const cohorts = new Set(fine.entities.filter((entry) => entry.kind === 'population-cohort' && entry.components.settlementId === state.world.originEntityId).map((entry) => entry.id));
  const ids = fine.entities.filter((entry) => entry.kind === 'individual' && cohorts.has(entry.components.cohortId)).map((entry) => entry.id).sort();
  assert.ok(ids.length > 0);
  assert.deepEqual(state.agents.map((entry) => entry.id).sort(), ids);
  assert.ok(state.agents.every((entry) => entry.worldEntityId === entry.id && entry.identityAnchorId && (entry.worldProvenanceIds?.length ?? 0) > 0));
  assert.equal(state.world.providerEngineVersion, expectedWorldgenVersion);
  assert.equal(state.world.providerRecipeId, raw.id);
  assert.notEqual(state.world.originEntityId, 'settlement:origin');
  assert.equal(state.settlement.worldEntityId, state.world.originEntityId);
  assert.equal(state.clockPolicy.worldTicksPerDay, raw.clock.ticksPerDay);
  assert.equal(state.clock.worldTick, raw.clock.burnInTicks + Math.floor(raw.clock.ticksPerDay * 6 / 24));
  assert.equal(state.world.providerSnapshot.manifest.currentTick, state.clock.worldTick);
  assert.ok(state.world.discoveredCapabilities.includes('cohort-materialization'));
});

test('real Worldgen + game loop is deterministic across segmented time advancement', async () => {
  const a = await createReal(20202);
  const b = await createReal(20202);
  const beforeA = await a.provider.exportSnapshot(2);
  await advanceSandboxDays(a.provider, a.state, 30);
  for (let day = 0; day < 30; day += 1) await advanceSandboxDays(b.provider, b.state, 1);
  assert.equal(a.state.diagnostics.replayHash, b.state.diagnostics.replayHash);
  assert.deepEqual(a.state.settlement.resources, b.state.settlement.resources);
  assert.equal(a.state.clock.worldTick, b.state.clock.worldTick);
  assert.equal(snapshotDigest(a.state.world.providerSnapshot), snapshotDigest(b.state.world.providerSnapshot));
  assertSnapshotIdentity(beforeA, a.state.world.providerSnapshot);
});


test('real Worldgen accepts anomaly-utilization interventions only from an in-world epistemic basis and preserves them in causal history', async () => {
  const { provider, state } = await createReal(25252);
  const { anomalyBasisForKnowledge, attemptAnomalyUtilization } = await import('../.test-dist/sandbox/anomalyUtilization.js');
  const source = state.knowledge.find((entry) => anomalyBasisForKnowledge(state, entry));
  assert.ok(source, 'generated origin must expose at least one anomaly-facing interpretation before anomaly use');
  assert.ok(source.sourceWorldKnowledgeId);
  const operators = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  for (const agent of operators) {
    agent.skills.records = 100;
    agent.skills.scouting = 100;
    if (agent.personality) agent.personality.curiosity = 100;
  }
  const result = await attemptAnomalyUtilization(provider, state, { sourceKnowledgeId: source.id, domain: 'communication', operatorIds: operators.map((entry) => entry.id) });
  assert.equal(result.accepted, true);
  assert.equal(result.practice.sourceKnowledgeId, source.id);
  assert.ok(result.practice.providerEventIds.length >= 1);
  const snapshot = await provider.exportSnapshot(2);
  const event = snapshot.events.find((entry) => result.practice.providerEventIds.includes(entry.id));
  assert.ok(event);
  assert.equal(event.kind, 'command:anomaly.utilize');
  const cause = snapshot.causalRecords.find((entry) => event.causeIds.includes(entry.id));
  assert.ok(cause);
  assert.ok(cause.parentIds.includes(source.sourceWorldKnowledgeId));
});

test('provider snapshot in a sandbox save resumes the same world without history regeneration', async () => {
  const base = await createReal(30303);
  await advanceSandboxDays(base.provider, base.state, 7);
  const loaded = importSandboxSave(JSON.stringify(base.state));
  const { recipe, content } = loadRecipeAndContent();
  const p1 = new WorldgenEngine(undefined, content).fromSnapshot(recipe, structuredClone(loaded.world.providerSnapshot));
  const p2 = new WorldgenEngine(undefined, content).fromSnapshot(recipe, structuredClone(loaded.world.providerSnapshot));
  const s1 = structuredClone(loaded);
  const s2 = structuredClone(loaded);
  await advanceSandboxDays(p1, s1, 10);
  await advanceSandboxDays(p2, s2, 10);
  assert.equal(s1.diagnostics.replayHash, s2.diagnostics.replayHash);
  assert.equal(snapshotDigest(s1.world.providerSnapshot), snapshotDigest(s2.world.providerSnapshot));
  assert.equal(s1.world.providerSnapshot.manifest.currentTick, s1.clock.worldTick);
});

test('expedition observation and external command work against real generated entities', async () => {
  const { provider, state } = await createReal(40404);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').sort((a, b) => b.skills.scouting - a.skills.scouting);
  const leader = adults[0];
  assert.ok(leader);
  const otherSettlement = state.world.providerSnapshot.entities
    .filter((entry) => entry.kind === 'settlement' && entry.spatial && entry.id !== state.world.originEntityId)
    .sort((a, b) => Math.hypot((a.spatial?.x ?? 0) - state.settlement.position.x, (a.spatial?.y ?? 0) - state.settlement.position.y) - Math.hypot((b.spatial?.x ?? 0) - state.settlement.position.x, (b.spatial?.y ?? 0) - state.settlement.position.y))[0];
  assert.ok(otherSettlement?.spatial);
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: adults.slice(0, 3).map((entry) => entry.id),
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
    destination: structuredClone(otherSettlement.spatial),
  });
  await advanceSandboxHours(provider, state, 24);
  assert.ok(expedition.observations.length > 0);
  const outcome = await issueExternalAction(provider, state, { kind: 'diplomacy', targetEntityId: otherSettlement.id, detail: 'Request peaceful contact through the generated-world boundary.' });
  assert.equal(outcome.result.accepted, true);
  assert.ok(state.world.providerSnapshot.events.some((entry) => entry.id === outcome.result.eventIds[0]));
});


async function withSettingPackServer(run) {
  const root = path.resolve(new URL('../vendor/worldgen-engine/setting-packs/descendants/', import.meta.url).pathname);
  const server = http.createServer((request, response) => {
    try {
      const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
      const file = path.resolve(root, relative);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const body = fs.readFileSync(file);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind setting-pack fixture server');
    return await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('production RealWorldProvider adapter loads the completed runtime and setting pack without gameplay branching', async () => {
  const runtimeUrl = pathToFileURL(path.resolve(new URL('../vendor/worldgen-engine/dist/index.js', import.meta.url).pathname)).href;
  await withSettingPackServer(async (baseUrl) => {
    const runtime = await createRealWorldRuntime({ runtimeUrl, recipeUrl: `${baseUrl}default.recipe.json` });
    const accepted = await runtime.provider.getManifest();
    assert.equal(accepted.contractVersion, '1.0.0');
    assert.equal(accepted.engineVersion, expectedWorldgenVersion);
    assert.equal(accepted.recipeId, runtime.recipeId);
    assert.equal(runtime.clockPolicy.worldTicksPerDay, 1440);
    const state = await createInitialSandboxState(runtime.provider, { seed: 50505, clockPolicy: runtime.clockPolicy });
    assert.ok(state.agents.length > 0);
    assert.ok(state.agents.every((entry) => entry.worldEntityId === entry.id && entry.identityAnchorId));
    assert.equal(state.world.providerEngineVersion, expectedWorldgenVersion);
  });
});

test('coarse provider save reload re-materializes identical LOD people with provenance intact', async () => {
  const { recipe, content, provider, state } = await createReal(60606);
  const query = { center: structuredClone(state.settlement.position), radiusKm: 2, requestedDetailRank: 0 };
  const fineBefore = await provider.queryArea(query);
  const anchorsBefore = new Map(fineBefore.entities.filter((entity) => entity.kind === 'identity-anchor').map((entity) => [entity.id, entity]));
  const before = fineBefore.entities
    .filter((entity) => entity.kind === 'individual' && entity.components.__lodMaterialized === true)
    .map((entity) => { const anchorId = entity.components.identityAnchorId; return [entity.id, anchorId, [...(typeof anchorId === 'string' ? anchorsBefore.get(anchorId)?.provenanceIds ?? [] : [])].sort()]; })
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.ok(before.length > 0);

  const coarse = await provider.exportSnapshot(2);
  assert.equal(coarse.entities.some((entity) => entity.components.__lodMaterialized === true), false);
  state.world.providerSnapshot = coarse;
  const loaded = importSandboxSave(JSON.stringify(state));
  const resumed = new WorldgenEngine(undefined, content).fromSnapshot(recipe, structuredClone(loaded.world.providerSnapshot));
  const fineAfter = await resumed.queryArea(query);
  const anchorsAfter = new Map(fineAfter.entities.filter((entity) => entity.kind === 'identity-anchor').map((entity) => [entity.id, entity]));
  const after = fineAfter.entities
    .filter((entity) => entity.kind === 'individual' && entity.components.__lodMaterialized === true)
    .map((entity) => { const anchorId = entity.components.identityAnchorId; return [entity.id, anchorId, [...(typeof anchorId === 'string' ? anchorsAfter.get(anchorId)?.provenanceIds ?? [] : [])].sort()]; })
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(after, before);
});

test('real Worldgen + game loop remains finite, persistent, and deterministic across one simulated year', { timeout: 120000 }, async () => {
  const a = await createReal(70707);
  const b = await createReal(70707);
  await advanceSandboxDays(a.provider, a.state, 365);
  for (let quarter = 0; quarter < 4; quarter += 1) await advanceSandboxDays(b.provider, b.state, quarter === 3 ? 92 : 91);
  assert.equal(a.state.clock.day, 366);
  assert.equal(a.state.diagnostics.replayHash, b.state.diagnostics.replayHash);
  assert.equal(snapshotDigest(a.state.world.providerSnapshot), snapshotDigest(b.state.world.providerSnapshot));
  assert.ok(a.state.agents.every((agent) => Number.isFinite(agent.health) && Number.isFinite(agent.fatigue)));
  assert.ok(Object.values(a.state.settlement.resources).every((value) => Number.isFinite(value)));
  assert.ok(a.state.agents.some((agent) => agent.alive));

  const loaded = importSandboxSave(JSON.stringify(a.state));
  const { recipe, content } = loadRecipeAndContent();
  const resumed = new WorldgenEngine(undefined, content).fromSnapshot(recipe, structuredClone(loaded.world.providerSnapshot));
  const continuation = structuredClone(loaded);
  await advanceSandboxDays(resumed, continuation, 7);
  assert.equal(continuation.clock.day, 373);
  assert.ok(continuation.agents.some((agent) => agent.alive));
});

test('real Worldgen direct-play soak preserves provider identity, physical evidence, epistemic boundaries and continuation', { timeout: 120000 }, async () => {
  const { recipe, content, provider, state } = await createReal(81818);
  const { queryGeneratedLocalArea, observeGeneratedEntity, takeGeneratedSample } = await import('../.test-dist/sandbox/localExploration.js');
  const { conductDirectConversation, institutionalizeKnowledgeRecord } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const { startResearchProject } = await import('../.test-dist/sandbox/researchSimulation.js');
  const { campExpedition, resolveControlledEncounterRound, saveDoctrine } = await import('../.test-dist/sandbox/expeditionSimulation.js');
  const { createEncounter } = await import('../.test-dist/sandbox/encounterSimulation.js');
  const { projectChronicle } = await import('../.test-dist/sandbox/chronicleVisibility.js');
  const { conductExternalPersonContact } = await import('../.test-dist/sandbox/externalContact.js');

  const initialIdentity = new Map(state.agents.map((agent) => [agent.id, {
    anchor: agent.identityAnchorId,
    provenance: [...(agent.worldProvenanceIds ?? [])].sort(),
  }]));
  assert.ok(initialIdentity.size > 0);
  assert.ok(state.settlement.institutions.some((entry) => entry.kind === 'records' && entry.worldEntityId));

  // The first real simulation interval refreshes nearby societies. Those inside direct
  // observation distance must expose their provider-materialized fine actors/relations,
  // not fabricated game-side people.
  await advanceSandboxHours(provider, state, 1);
  const fineExternal = state.externalActors.find((entry) => (entry.fineActorIds?.length ?? 0) > 0);
  assert.ok(fineExternal, 'at least one directly observable neighboring settlement should materialize provider fine actors');
  assert.equal(fineExternal.effectiveDetailRank, 0);
  assert.ok((fineExternal.relationshipIds?.length ?? 0) > 0);
  assert.ok(fineExternal.fineActorIds.every((id) => id.startsWith('ent_')));

  const observer = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  const listener = state.agents.find((entry) => entry.alive && entry.role !== 'child' && entry.id !== observer?.id);
  assert.ok(observer && listener);
  const local = await queryGeneratedLocalArea(provider, state, observer.id, state.settlement.position, 5);
  const sampleable = local.entities.find((entry) => entry.spatial && entry.id !== state.world.originEntityId && /anomaly|resource|ecolog|archaeolog|histor|ruin|trace|material/i.test(`${entry.kind} ${entry.subtype ?? ''} ${(entry.tags ?? []).join(' ')}`));
  assert.ok(sampleable, 'real generated origin should expose sampleable physical/historical evidence');

  const evidence = observeGeneratedEntity(state, observer.id, sampleable);
  assert.equal(state.settlement.localKnowledgeIds.includes(evidence.id), false);
  await advanceSandboxHours(provider, state, 1);
  const { item } = takeGeneratedSample(state, observer.id, sampleable);
  assert.equal(item.sourceEntityId, sampleable.id);
  assert.ok(item.provenanceIds.includes(`sample-source:${sampleable.id}`));
  await advanceSandboxHours(provider, state, 1);

  conductDirectConversation(state, observer.id, listener.id, evidence.id);
  assert.ok(listener.knowledgeIds.includes(evidence.id));
  assert.equal(state.settlement.localKnowledgeIds.includes(evidence.id), false);
  await advanceSandboxHours(provider, state, 1);

  const record = institutionalizeKnowledgeRecord(state, observer.id, evidence.id);
  assert.ok(state.settlement.activeRecordIds.includes(record.id));
  assert.ok(state.settlement.localKnowledgeIds.includes(evidence.id));
  await advanceSandboxHours(provider, state, 1);

  const researchers = state.agents.filter((entry) => entry.alive && entry.role !== 'child' && entry.id !== observer.id).slice(0, 3);
  assert.ok(researchers.length > 0);
  const project = startResearchProject(state, evidence.id, researchers.map((entry) => entry.id));
  assert.equal(project.sampleItemId, item.id);
  await advanceSandboxHours(provider, state, 24);
  assert.ok(project.progress > 0 || project.status === 'completed');

  const destination = state.world.providerSnapshot.entities.find((entry) => entry.id === fineExternal.entityId && entry.spatial)
    ?? state.world.providerSnapshot.entities
      .filter((entry) => entry.kind === 'settlement' && entry.spatial && entry.id !== state.world.originEntityId)
      .sort((a, b) => Math.hypot(a.spatial.x - state.settlement.position.x, a.spatial.y - state.settlement.position.y) - Math.hypot(b.spatial.x - state.settlement.position.x, b.spatial.y - state.settlement.position.y))[0];
  assert.ok(destination?.spatial);
  const crew = state.agents.filter((entry) => entry.alive && entry.role !== 'child' && entry.id !== observer.id).slice(0, 3);
  assert.equal(crew.length, 3);
  const doctrine = saveDoctrine(state, { name: 'Soak direct-control survey', riskTolerance: 0.28, retreatHealth: 35, maxSilentHours: 12, campBeforeDark: true, prioritizeRescue: true, contactPolicy: 'observe', encounterInstruction: 'withdraw' });
  const expedition = launchExpedition(state, {
    leaderId: crew[0].id,
    memberIds: crew.map((entry) => entry.id),
    controlMode: 'expedition',
    doctrineId: doctrine.id,
    destination: structuredClone(destination.spatial),
    supplies: { food: 5, water: 8, medicine: 1, tools: 1 },
    pace: 'cautious',
  });
  for (let approach = 0; approach < 8 && Math.hypot(expedition.position.x-destination.spatial.x, expedition.position.y-destination.spatial.y) > .3; approach += 1) await advanceSandboxHours(provider, state, 1);
  assert.ok(Math.hypot(expedition.position.x-destination.spatial.x, expedition.position.y-destination.spatial.y) <= .35, 'direct-control expedition should physically reach the nearby fine external settlement');
  const contactArea = await queryGeneratedLocalArea(provider, state, crew[0].id, expedition.position, 2.5);
  const outsidePerson = contactArea.entities.find((entry) => entry.kind === 'individual' && fineExternal.fineActorIds.includes(entry.id));
  assert.ok(outsidePerson, 'provider fine actor should be present in the controlled local projection');
  const directContact = conductExternalPersonContact(state, crew[0].id, outsidePerson);
  assert.equal(directContact.contact.externalPersonId, outsidePerson.id);
  assert.equal(directContact.contact.societyEntityId, fineExternal.entityId);
  assert.ok(directContact.contact.provenanceIds.length > 0);
  assert.equal(state.settlement.localKnowledgeIds.includes(directContact.knowledgeId), false);
  await advanceSandboxHours(provider, state, 1);
  // Explicitly exercise the no-communication branch: canonical field truth may exist
  // while settlement-facing Chronicle remains unaware until an in-world route returns.
  expedition.communication = 'silent';
  expedition.silentHours = Math.max(1, expedition.silentHours);
  campExpedition(state, expedition.id, 6);
  const campTruth = state.chronicle.findLast((entry) => entry.title === 'Expedition camp established' && entry.epistemic?.expeditionId === expedition.id);
  assert.ok(campTruth);
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.id === campTruth.id), false);
  await advanceSandboxHours(provider, state, 6);

  const encounter = createEncounter(state, expedition, 'advance', 1);
  const firstRound = resolveControlledEncounterRound(state, encounter.id);
  assert.ok(state.directPlay?.directActivities.some((entry) => entry.kind === 'combat' && entry.targetEntityId === encounter.id));
  assert.equal(typeof firstRound.resolved, 'boolean');

  // Save while direct field control has active history, reconstruct provider from the
  // exact provider snapshot, then continue. Stable Worldgen identities/provenance must
  // survive even though materialization-event provenance may be regenerated.
  const loaded = importSandboxSave(JSON.stringify(state));
  const resumed = new WorldgenEngine(undefined, content).fromSnapshot(recipe, structuredClone(loaded.world.providerSnapshot));
  const continuation = structuredClone(loaded);
  const restoredExpedition = continuation.expeditions.find((entry) => entry.id === expedition.id);
  assert.ok(restoredExpedition);
  assert.deepEqual(continuation.agents.map((entry) => entry.id).sort(), state.agents.map((entry) => entry.id).sort());
  for (const agent of continuation.agents) {
    const before = initialIdentity.get(agent.id);
    if (!before) continue;
    assert.equal(agent.identityAnchorId, before.anchor);
    assert.deepEqual([...(agent.worldProvenanceIds ?? [])].sort(), before.provenance);
  }

  for (let round = 0; round < 12 && continuation.encounters.find((entry) => entry.id === encounter.id)?.status !== 'resolved'; round += 1) {
    resolveControlledEncounterRound(continuation, encounter.id);
    await advanceSandboxHours(resumed, continuation, 1);
  }
  assert.equal(continuation.encounters.find((entry) => entry.id === encounter.id)?.status, 'resolved');
  const postReloadDay = continuation.clock.day;
  await advanceSandboxDays(resumed, continuation, 30);
  assert.equal(continuation.clock.day, postReloadDay + 30);
  assert.ok(continuation.agents.some((entry) => entry.alive));
  assert.equal(continuation.world.providerSnapshot.manifest.currentTick, continuation.clock.worldTick);
  assert.ok(continuation.directPlay?.inventory.some((entry) => entry.id === item.id && entry.sourceEntityId === sampleable.id));
  assert.ok(continuation.records.some((entry) => entry.id === record.id));
  assert.ok(continuation.researchProjects.some((entry) => entry.id === project.id));
  assert.ok(continuation.externalContacts?.some((entry) => entry.externalPersonId === outsidePerson.id && entry.societyEntityId === fineExternal.entityId));

  const fineAfter = await resumed.queryArea({ center: structuredClone(continuation.settlement.position), radiusKm: 2.5, requestedDetailRank: 0, observerId: continuation.world.originEntityId, includeKnowledgeProjection: true });
  const anchors = new Map(fineAfter.entities.filter((entry) => entry.kind === 'identity-anchor').map((entry) => [entry.id, entry]));
  for (const agent of continuation.agents.filter((entry) => initialIdentity.has(entry.id))) {
    const anchor = agent.identityAnchorId ? anchors.get(agent.identityAnchorId) : undefined;
    assert.ok(anchor, `stable identity anchor must re-materialize for ${agent.id}`);
    assert.deepEqual([...(anchor.provenanceIds ?? [])].sort(), initialIdentity.get(agent.id).provenance);
  }
});

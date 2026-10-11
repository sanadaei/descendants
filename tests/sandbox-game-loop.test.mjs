import { readSandboxUiSource } from '../tools/read-sandbox-ui.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createInitialSandboxState } from '../.test-dist/sandbox/bootstrap.js';
import { advanceSandboxHours, advanceSandboxDays } from '../.test-dist/sandbox/engine.js';
import { launchExpedition, launchRescueExpedition, addExpeditionOrder, saveDoctrine, expeditionMemberReadiness, expeditionSupplyReadiness, settlementSupplyReserveReadiness, markExpeditionLossState } from '../.test-dist/sandbox/expeditionSimulation.js';
import { issueBlockedFieldDecision } from '../.test-dist/sandbox/fieldDecisionSimulation.js';
import { requestFieldRendezvous, promoteRendezvousRequestAfterVerifiedLink } from '../.test-dist/sandbox/rendezvousSimulation.js';
import { rendezvousSearchWaypoint, transferRendezvousAidAndWounded } from '../.test-dist/sandbox/rendezvousEncounterSimulation.js';
import { importSandboxSave, sandboxRepository } from '../.test-dist/sandbox/storage.js';
import { MockWorldProvider } from '../.test-dist/worldbridge/mockWorldProvider.js';
import { SnapshotWorldProvider } from '../.test-dist/worldbridge/snapshotWorldProvider.js';
import { acceptWorldProvider, assertSnapshotIdentity } from '../.test-dist/worldbridge/providerGuard.js';
import { projectChronicle, revealExpeditionChronicleToSettlement } from '../.test-dist/sandbox/chronicleVisibility.js';
import { agentTaskScore, requestDirectClinicCare } from '../.test-dist/sandbox/settlementSimulation.js';
import { assemblyPreferenceSignal, laborPriorityProposalAvailability, proposeLaborPriority } from '../.test-dist/sandbox/politicalSimulation.js';

async function initial(seed = 24680) {
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { seed });
  return { provider, state };
}

function migrationEvidenceProvider(base, candidate, mode = 'explicit') {
  const anchor = {
    id: candidate.components.identityAnchorId,
    kind: 'identity-anchor',
    spatial: structuredClone(candidate.spatial),
    components: { continuity: 'provider-confirmed-migrant-test' },
    provenanceIds: ['prov:migrant-anchor:test'],
  };
  const migrationEventIds = new Set();
  return {
    getManifest: (...args) => base.getManifest(...args),
    getEntity: async (id, ...args) => {
      if (id === candidate.id) return structuredClone(candidate);
      if (id === anchor.id) return structuredClone(anchor);
      return base.getEntity(id, ...args);
    },
    queryArea: (...args) => base.queryArea(...args),
    getKnowledge: (...args) => base.getKnowledge(...args),
    issueCommand: async (command) => {
      const result = await base.issueCommand(command);
      if (command.kind === 'external.migration' && result.accepted) {
        for (const id of result.eventIds) migrationEventIds.add(id);
      }
      return result;
    },
    advance: (...args) => base.advance(...args),
    exportSnapshot: async (...args) => {
      const snapshot = await base.exportSnapshot(...args);
      for (const event of snapshot.events) {
        if (!migrationEventIds.has(event.id)) continue;
        if (mode === 'explicit') event.data = { ...event.data, migrantIndividualIds: [candidate.id] };
        if (mode === 'participant-only') event.actorIds = [...new Set([...event.actorIds, candidate.id])];
      }
      return snapshot;
    },
  };
}


function recoveryEvidenceProvider(base, returnedIndividualIds = [], returnedHouseholdIds = []) {
  const observations = new Map();
  return {
    getManifest: (...args) => base.getManifest(...args),
    getEntity: (...args) => base.getEntity(...args),
    queryArea: (...args) => base.queryArea(...args),
    getKnowledge: (...args) => base.getKnowledge(...args),
    issueCommand: async (command) => {
      const result = await base.issueCommand(command);
      if (command.kind !== 'external.diplomacy' || !result.accepted) return result;
      const id = `provider:observed-recovery:${observations.size + 1}`;
      observations.set(id, {
        id, kind: 'observed.external-conflict-recovery', tick: command.issuedTick,
        actorIds: [], targetIds: [...(command.targets ?? [])], location: structuredClone(command.location),
        data: { observedConflictKind: 'recovery', returnedToSettlementIndividualIds: [...returnedIndividualIds], returnedToSettlementHouseholdIds: [...returnedHouseholdIds] },
        causeIds: [...result.causalRecordIds], provenanceIds: [...result.causalRecordIds],
      });
      return { ...result, eventIds: [...result.eventIds, id] };
    },
    advance: (...args) => base.advance(...args),
    exportSnapshot: async (...args) => {
      const snapshot = await base.exportSnapshot(...args);
      snapshot.events.push(...[...observations.values()].map((entry) => structuredClone(entry)));
      return snapshot;
    },
  };
}

function conflictEvidenceProvider(base, observed) {
  const observations = new Map();
  return {
    getManifest: (...args) => base.getManifest(...args),
    getEntity: (...args) => base.getEntity(...args),
    queryArea: (...args) => base.queryArea(...args),
    getKnowledge: (...args) => base.getKnowledge(...args),
    issueCommand: async (command) => {
      const result = await base.issueCommand(command);
      if (command.kind !== 'external.conflict' || !result.accepted) return result;
      const id = `provider:observed-conflict:${observations.size + 1}`;
      observations.set(id, {
        id, kind: 'observed.external-conflict', tick: command.issuedTick,
        actorIds: [], targetIds: [...(command.targets ?? [])], location: structuredClone(command.location),
        data: structuredClone(observed), causeIds: [...result.causalRecordIds], provenanceIds: [...result.causalRecordIds],
      });
      return { ...result, eventIds: [...result.eventIds, id] };
    },
    advance: (...args) => base.advance(...args),
    exportSnapshot: async (...args) => {
      const snapshot = await base.exportSnapshot(...args);
      snapshot.events.push(...[...observations.values()].map((entry) => structuredClone(entry)));
      return snapshot;
    },
  };
}


test('provider-backed sandbox starts with individual population and manifest discovery', async () => {
  const { provider, state } = await initial();
  assert.equal(state.agents.length, 40);
  assert.equal(state.agents.filter((entry) => entry.alive).length, 40);
  assert.ok(state.agents.every((entry) => entry.id.startsWith('individual:origin:') && entry.worldEntityId === entry.id && entry.identityAnchorId && (entry.worldProvenanceIds?.length ?? 0) > 0));
  assert.ok(state.settlement.households.every((entry) => entry.id.startsWith('household:origin:') && entry.worldEntityId === entry.id));
  assert.ok(state.settlement.institutions.some((entry) => entry.worldEntityId === entry.id && entry.sourceWorldInstitutionType === 'local-governance'));
  assert.ok(state.settlement.leaderId);
  assert.equal(state.world.manifest.contractVersion, '1.0.0');
  assert.ok(state.world.discoveredVariableIds.includes('descendants.anomaly.pressure'));
  assert.ok((await acceptWorldProvider(provider)).capabilities.has('area-query'));
});

test('provider-backed people distinguish raw identity authority from deterministic gameplay interpretation', async () => {
  const { state } = await initial(24681);
  assert.ok(state.agents.every((agent) => agent.identityOrigin === 'world-provider'));
  assert.ok(state.agents.every((agent) => agent.profileAuthority?.identity === 'provider-projected'));
  assert.ok(state.agents.every((agent) => agent.profileAuthority?.age === 'game-derived' && agent.profileAuthority?.sex === 'game-derived' && agent.profileAuthority?.skills === 'game-derived'));
  const providerRelation = state.agents.flatMap((agent) => agent.relations).find((relation) => relation.worldRelationId);
  assert.ok(providerRelation);
  assert.equal(providerRelation.authority, 'provider-projected');
});

test('same seed and provider fixture replay deterministically across settlement simulation', async () => {
  const a = await initial(1001);
  const b = await initial(1001);
  await advanceSandboxDays(a.provider, a.state, 5);
  await advanceSandboxDays(b.provider, b.state, 5);
  assert.equal(a.state.diagnostics.replayHash, b.state.diagnostics.replayHash);
  assert.deepEqual(a.state.settlement.resources, b.state.settlement.resources);
  assert.deepEqual(a.state.agents.map((entry) => [entry.id, entry.alive, entry.currentTask, entry.health]), b.state.agents.map((entry) => [entry.id, entry.alive, entry.currentTask, entry.health]));
});

test('leadership succession follows simulated social ranking when current leader is unavailable', async () => {
  const { provider, state } = await initial(992);
  const previousLeader = state.settlement.leaderId;
  const agent = state.agents.find((entry) => entry.id === previousLeader);
  assert.ok(agent);
  agent.alive = false;
  agent.health = 0;
  agent.deathDay = state.clock.day;
  agent.causeOfDeath = 'test unavailability';
  await advanceSandboxHours(provider, state, 6);
  assert.notEqual(state.settlement.leaderId, previousLeader);
  assert.ok(state.chronicle.some((entry) => entry.kind === 'leadership'));
});

test('expedition uses coordinates, provider projection, communication and shared autonomous loop', async () => {
  const { provider, state } = await initial(4242);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').sort((a, b) => b.skills.scouting - a.skills.scouting);
  const leader = adults[0];
  assert.ok(leader);
  const expedition = launchExpedition(state, {
    leaderId: leader.id,
    memberIds: adults.slice(0, 3).map((entry) => entry.id),
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
    destination: { frameId: 'world', x: 314, y: 200, regionId: 'region:greenfold' },
  });
  await advanceSandboxHours(provider, state, 12);
  assert.ok(expedition.observations.length > 0);
  assert.ok(expedition.discoveredEntityIds.includes('landmark:relay-tower'));
  assert.notEqual(expedition.position.x, state.settlement.position.x);
  addExpeditionOrder(state, expedition.id, 'return', 'Return with observations.');
  await advanceSandboxHours(provider, state, 30);
  assert.equal(expedition.status, 'returned');
  assert.ok(expedition.memberIds.every((id) => state.agents.find((entry) => entry.id === id)?.expeditionId === null));
});

test('remote expedition camp Chronicle truth is hidden from settlement until a verified report route exists', async () => {
  const { provider, state } = await initial(1);
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  expedition.position = { ...state.settlement.position, x: state.settlement.position.x + 100 };
  expedition.destination = null;
  expedition.communication = 'silent';
  expedition.silentHours = 12;
  addExpeditionOrder(state, expedition.id, 'camp', 'Camp without a live relay.');
  await advanceSandboxHours(provider, state, 6);
  const camp = state.chronicle.find((entry) => entry.title === 'Expedition camp established');
  assert.ok(camp);
  assert.equal(camp.epistemic?.scope, 'expedition-internal');
  assert.equal(camp.epistemic?.settlementVisible, false);
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.id === camp.id), false);
  assert.equal(projectChronicle(state, { kind: 'expedition', expeditionId: expedition.id, observerAgentId: leader.id }).some((entry) => entry.id === camp.id), true);
  expedition.position = structuredClone(state.settlement.position);
  expedition.communication = 'silent';
  expedition.silentHours = 12;
  await advanceSandboxHours(provider, state, 6);
  assert.equal(expedition.communication, 'connected');
  assert.ok(expedition.communicationReports.some((entry) => entry.verified));
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.id === camp.id), true);
  assert.ok(camp.epistemic?.revealSourceIds.some((id) => expedition.communicationReports.some((report) => report.verified && report.id === id)));
});

test('remote expedition arrival Chronicle visibility follows the verified communication route at arrival', async () => {
  const { provider, state } = await initial(1);
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const destination = { ...state.settlement.position, x: state.settlement.position.x + 100 };
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id, destination });
  expedition.position = structuredClone(destination);
  expedition.communication = 'silent';
  expedition.silentHours = 12;
  await advanceSandboxHours(provider, state, 6);
  const arrival = state.chronicle.find((entry) => entry.title === 'Expedition arrived at destination');
  assert.ok(arrival);
  assert.equal(arrival.epistemic?.scope, 'expedition-internal');
  const hasVerifiedRouteAtArrival = expedition.communication === 'connected';
  assert.equal(arrival.epistemic?.settlementVisible, hasVerifiedRouteAtArrival);
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.id === arrival.id), hasVerifiedRouteAtArrival);
  assert.equal(projectChronicle(state, { kind: 'expedition', expeditionId: expedition.id, observerAgentId: leader.id }).some((entry) => entry.id === arrival.id), true);
});

test('rescue launched on communication-loss evidence targets last verified position rather than hidden current coordinates', async () => {
  const { state } = await initial(4141);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child');
  const remoteLeader = adults[0];
  const rescuer = adults[1];
  assert.ok(remoteLeader && rescuer);
  const remote = launchExpedition(state, { leaderId: remoteLeader.id, memberIds: [remoteLeader.id], controlMode: 'settlement', doctrineId: state.doctrines[0].id });
  const verifiedDeparture = structuredClone(remote.communicationReports.at(-1)?.verifiedPosition);
  assert.ok(verifiedDeparture);
  remote.position = { ...remote.position, x: remote.position.x + 90, y: remote.position.y - 45 };
  remote.communication = 'silent';
  remote.silentHours = 18;
  const rescue = launchRescueExpedition(state, remote.id, rescuer.id, [rescuer.id], 'settlement');
  assert.deepEqual(rescue.destination, verifiedDeparture);
  assert.notDeepEqual(rescue.destination, remote.position);
  assert.equal(remote.status, 'exploring');
});

test('loss-state Chronicle detail remains hidden from routine communication but rescue confirmation can reveal it', async () => {
  const { state } = await initial(42422);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child');
  const leader = adults[0];
  assert.ok(leader);
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  const { markExpeditionLossState } = await import('../.test-dist/sandbox/expeditionSimulation.js');
  markExpeditionLossState(state, expedition.id, 'capture', 'captured at an unverified site', ['site:hidden']);
  assert.ok(state.chronicle.some((entry) => entry.title === 'Expedition loss state: capture'));
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.title === 'Expedition loss state: capture'), false);
  revealExpeditionChronicleToSettlement(state, expedition.id, 'comm:routine');
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.title === 'Expedition loss state: capture'), false);
  revealExpeditionChronicleToSettlement(state, expedition.id, 'rescue:confirmed', { includeNonRoutine: true });
  const visible = projectChronicle(state, { kind: 'settlement' }).find((entry) => entry.title === 'Expedition loss state: capture');
  assert.ok(visible);
  assert.ok(visible.epistemic?.revealSourceIds.includes('rescue:confirmed'));
});

test('remote order refusal remains hidden while communication is silent', async () => {
  const { provider, state } = await initial(1);
  const leader = state.agents.find((entry) => entry.id === state.settlement.leaderId);
  assert.ok(leader);
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'settlement', doctrineId: state.doctrines[0].id });
  expedition.position = { ...state.settlement.position, x: state.settlement.position.x + 100 };
  expedition.destination = null;
  expedition.communication = 'silent';
  expedition.silentHours = 12;
  leader.authority.obedience = 0;
  leader.authority.refusalThreshold = 100;
  leader.morale = 0;
  addExpeditionOrder(state, expedition.id, 'return', 'Return because of an unverified player-only claim.', { epistemicBasisIds: ['knowledge:not-held'] });
  await advanceSandboxHours(provider, state, 6);
  const refusal = state.chronicle.find((entry) => entry.title === 'Expedition order refused');
  assert.ok(refusal);
  assert.equal(refusal.epistemic?.scope, 'expedition-internal');
  assert.equal(refusal.epistemic?.settlementVisible, false);
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.id === refusal.id), false);
});

test('remote WEDO casualty is canonical truth but hidden from settlement before communication', async () => {
  const { state } = await initial(343435);
  const { createEncounter, buildEncounterQueue, resolveEncounterRound } = await import('../.test-dist/sandbox/encounterSimulation.js');
  const party = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 2);
  assert.equal(party.length, 2);
  const expedition = launchExpedition(state, { leaderId: party[0].id, memberIds: party.map((entry) => entry.id), controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  expedition.communication = 'silent';
  const encounter = createEncounter(state, expedition, 'defend', 1);
  const victim = encounter.actors.find((entry) => entry.agentId === party[0].id);
  assert.ok(victim);
  victim.health = 0;
  encounter.log = Array.from({ length: 60 }, (_, index) => `prior round ${index}`);
  encounter.queue = buildEncounterQueue(state, encounter);
  resolveEncounterRound(state, encounter.id);
  const death = state.chronicle.find((entry) => entry.title === `${party[0].name} died during an encounter`);
  assert.ok(death);
  assert.equal(death.epistemic?.scope, 'expedition-internal');
  assert.equal(death.epistemic?.settlementVisible, false);
  assert.equal(projectChronicle(state, { kind: 'settlement' }).some((entry) => entry.id === death.id), false);
  assert.equal(projectChronicle(state, { kind: 'expedition', expeditionId: expedition.id, observerAgentId: party[1].id }).some((entry) => entry.id === death.id), true);
});

test('unfounded orders are marked epistemically without blocking player meta-knowledge', async () => {
  const { state } = await initial(77);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child');
  const leader = adults[0];
  assert.ok(leader);
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'settlement', doctrineId: state.doctrines[0].id });
  const order = addExpeditionOrder(state, expedition.id, 'contact', 'Contact a place known only to the player.', { targetEntityId: 'settlement:quarry-camp', epistemicBasisIds: ['knowledge:not-held'] });
  assert.equal(order.unfounded, true);
});

test('doctrines can be saved and reused instead of hard-coded expedition behavior', async () => {
  const { state } = await initial(78);
  const doctrine = saveDoctrine(state, { name: 'Rescue first', riskTolerance: 0.2, retreatHealth: 60, maxSilentHours: 8, campBeforeDark: true, prioritizeRescue: true, contactPolicy: 'peaceful', encounterInstruction: 'protect-wounded' });
  assert.equal(doctrine.encounterInstruction, 'protect-wounded');
  assert.ok(state.doctrines.some((entry) => entry.id === doctrine.id));
});

test('sandbox save round-trips deterministic state', async () => {
  const { provider, state } = await initial(31337);
  await advanceSandboxHours(provider, state, 18);
  const loaded = importSandboxSave(JSON.stringify(state));
  assert.equal(loaded.diagnostics.replayHash, state.diagnostics.replayHash);
  assert.deepEqual(loaded.settlement.resources, state.settlement.resources);
  assert.equal(loaded.agents.length, state.agents.length);
});



test('save import destructive validation rejects identity, tick, schema and duplicate-id corruption', async () => {
  const { provider, state } = await initial(818181);
  await advanceSandboxHours(provider, state, 12);
  const exported = sandboxRepository.exportJson(state);
  const restored = sandboxRepository.importJson(exported);
  assert.equal(restored.diagnostics.replayHash, state.diagnostics.replayHash);
  assert.equal(restored.world.providerSnapshot.manifest.currentTick, restored.clock.worldTick);

  const wrongSchema = structuredClone(state); wrongSchema.schemaVersion = 999;
  assert.throws(() => importSandboxSave(JSON.stringify(wrongSchema)), /Unsupported sandbox save schema/);

  const wrongRecipe = structuredClone(state); wrongRecipe.world.providerRecipeId = 'forged-recipe';
  assert.throws(() => importSandboxSave(JSON.stringify(wrongRecipe)), /provider identity disagrees/i);

  const wrongTick = structuredClone(state); wrongTick.world.providerSnapshot.manifest.currentTick += 1;
  assert.throws(() => importSandboxSave(JSON.stringify(wrongTick)), /snapshot tick disagrees with game clock/i);

  const masquerade = structuredClone(state); const lived = masquerade.agents[0];
  lived.identityOrigin = 'lived-game-state'; lived.worldEntityId = lived.id;
  assert.throws(() => importSandboxSave(JSON.stringify(masquerade)), /must not masquerade as a WorldProvider identity/i);

  const duplicate = structuredClone(state); duplicate.agents[1].id = duplicate.agents[0].id;
  assert.throws(() => importSandboxSave(JSON.stringify(duplicate)), /duplicate agent id/i);
});
test('sandbox save validator preserves Chronicle epistemic provenance and rejects malformed visibility metadata', async () => {
  const { state } = await initial(42423);
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  expedition.communication = 'silent';
  const { addExpeditionChronicle } = await import('../.test-dist/sandbox/stateUtils.js');
  const entry = addExpeditionChronicle(state, expedition.id, { kind: 'expedition', title: 'private field note', text: 'not yet reported', entityIds: [expedition.id] });
  const restored = importSandboxSave(JSON.stringify(state));
  assert.deepEqual(restored.chronicle.find((candidate) => candidate.id === entry.id)?.epistemic, entry.epistemic);
  const broken = structuredClone(state);
  broken.chronicle.find((candidate) => candidate.id === entry.id).epistemic.expeditionId = 'expedition:missing';
  assert.throws(() => importSandboxSave(JSON.stringify(broken)), /unknown expedition visibility scope/);
});

test('game loop can run against a snapshot provider without mock-specific branches', async () => {
  const mock = new MockWorldProvider();
  const snapshot = await mock.exportSnapshot();
  const provider = new SnapshotWorldProvider(snapshot);
  const state = await createInitialSandboxState(provider, { seed: 9090 });
  await advanceSandboxHours(provider, state, 12);
  assert.equal(state.clock.worldTick, 18);
  const after = await provider.exportSnapshot();
  assertSnapshotIdentity(snapshot, after);
  assert.equal(after.manifest.contractVersion, '1.0.0');
});

test('provider transformation hook records anomaly effects without moral classification', async () => {
  const { state } = await initial(6006);
  const { applyProviderTransformation } = await import('../.test-dist/sandbox/anomalyIntegration.js');
  const agent = state.agents[0];
  applyProviderTransformation(state, {
    agentId: agent.id, sourceWorldEventId: 'world:event:test-transform', sourceEntityIds: ['anomaly:glass-rain-basin'],
    geneticTraitTags: ['glass-affinity'], locusDeltas: { resilience: -3 }, pathology: { pathologyId: 'crystal-dermatosis', severity: 22, observedSymptoms: ['reflective skin plaques'] },
    memoryText: 'A rain event altered the body.', directlyObserved: true,
  });
  assert.ok(agent.genetics.anomalyTraits.includes('glass-affinity'));
  assert.ok(agent.pathology.some((entry) => entry.pathologyId === 'crystal-dermatosis'));
  assert.ok(state.chronicle.some((entry) => entry.text.includes('without positive/negative classification')));
});

test('external diplomacy/trade hooks route through WorldProvider commands', async () => {
  const { provider, state } = await initial(7007);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  const result = await issueExternalAction(provider, state, { kind: 'trade', targetEntityId: 'settlement:river-market', detail: 'Offer medicine knowledge for grain.' });
  assert.equal(result.result.accepted, true);
  assert.equal(result.unfounded, false);
  const snapshot = await provider.exportSnapshot();
  assert.ok(snapshot.events.some((entry) => entry.kind === 'command.external.trade'));
});


test('trade and diplomacy accumulate persistent outside relationships and can exchange actual settlement resources', async () => {
  const { provider, state } = await initial(707070);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  const beforeResources = structuredClone(state.settlement.resources);
  const beforeTrust = target.localTrust;
  const trade = await issueExternalAction(provider, state, { kind: 'trade', targetEntityId: target.entityId, detail: 'Negotiate a practical exchange from locally known needs and surplus.' });
  assert.equal(trade.result.accepted, true);
  assert.equal(target.tradeExperience, 1);
  assert.ok(target.localTrust > beforeTrust);
  assert.notDeepEqual(state.settlement.resources, beforeResources);
  const afterTradeTrust = target.localTrust;
  const diplomacy = await issueExternalAction(provider, state, { kind: 'diplomacy', targetEntityId: target.entityId, detail: 'Continue talks without assuming shared interests.' });
  assert.equal(diplomacy.result.accepted, true);
  assert.ok(target.localTrust > afterTradeTrust);
  const relationBeforeRefresh = { trust: target.localTrust, trade: target.tradeExperience };
  await advanceSandboxDays(provider, state, 1);
  const refreshed = state.externalActors.find((entry) => entry.entityId === target.entityId);
  assert.ok(refreshed);
  assert.equal(refreshed.tradeExperience, relationBeforeRefresh.trade);
  assert.equal(refreshed.localTrust, relationBeforeRefresh.trust);
  assert.ok(state.chronicle.some((entry) => entry.kind === 'external' && entry.text.includes('Exchanged')));
});

test('generated endings do not stop sandbox continuation', async () => {
  const { provider, state } = await initial(8080);
  const { registerGeneratedEnding } = await import('../.test-dist/sandbox/endings.js');
  registerGeneratedEnding(state, 'regional-signal-restored', 'A region-wide communications network was restored.');
  const before = state.clock.day;
  await advanceSandboxDays(provider, state, 2);
  assert.equal(state.status, 'post-ending');
  assert.ok(state.clock.day > before);
});

test('long-run game-side simulation remains finite and id-stable', async () => {
  const { provider, state } = await initial(123456);
  await advanceSandboxDays(provider, state, 180);
  const ids = state.agents.map((entry) => entry.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(Number.isFinite(state.settlement.resources.food));
  assert.ok(Number.isFinite(state.settlement.resources.water));
  assert.ok(state.agents.every((entry) => Number.isFinite(entry.health) && Number.isFinite(entry.fatigue)));
  assert.match(state.diagnostics.replayHash, /^[0-9a-f]{8}$/);
  assert.ok(state.externalActors.length >= 1);
});

test('sandbox save validator rejects corrupt resources and broken expedition membership', async () => {
  const { state } = await initial(9191);
  const badResource = structuredClone(state);
  badResource.settlement.resources.food = null;
  assert.throws(() => importSandboxSave(JSON.stringify(badResource)), /resources\.food/);

  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child');
  const expedition = launchExpedition(state, { leaderId: adults[0].id, memberIds: adults.slice(0, 2).map((entry) => entry.id), controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  const brokenMembership = structuredClone(state);
  brokenMembership.agents.find((entry) => entry.id === expedition.leaderId).expeditionId = null;
  assert.throws(() => importSandboxSave(JSON.stringify(brokenMembership)), /membership mismatch/);
});

test('observed knowledge creates agent beliefs with an explicit in-world basis', async () => {
  const { state } = await initial(30303);
  const { addObservedKnowledge } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const agent = state.agents[0];
  const entry = addObservedKnowledge(state, [agent.id], ['landmark:test'], 'A test landmark was directly observed.', 0.81);
  const belief = agent.beliefs.find((candidate) => candidate.basisKnowledgeIds.includes(entry.id));
  assert.ok(belief);
  assert.equal(belief.claim, entry.claim);
  assert.equal(belief.confidence, 0.81);
});

test('pregnancy-linked provider transformations reach the newborn lineage without value coding', async () => {
  const { provider, state } = await initial(515151);
  const { applyProviderTransformation } = await import('../.test-dist/sandbox/anomalyIntegration.js');
  const female = state.agents.find((entry) => entry.alive && entry.sex === 'female' && entry.role !== 'child');
  const male = state.agents.find((entry) => entry.alive && entry.sex === 'male' && entry.role !== 'child');
  assert.ok(female && male);
  const pregnancyId = 'pregnancy:test-provider-tag';
  state.pregnancies.push({ id: pregnancyId, parentIds: [female.id, male.id], pregnantAgentId: female.id, conceptionDay: state.clock.day - 280, expectedDay: state.clock.day, outcome: 'ongoing', anomalyTags: [] });
  applyProviderTransformation(state, { agentId: female.id, sourceWorldEventId: 'world:event:gestational-shift', pregnancyTags: ['echo-lineage'], directlyObserved: true });
  state.settlement.childcareCapacity = 30;
  state.settlement.clinicCapacity = 30;
  await advanceSandboxHours(provider, state, 6);
  const pregnancy = state.pregnancies.find((entry) => entry.id === pregnancyId);
  assert.equal(pregnancy?.outcome, 'birth');
  const child = state.agents.find((entry) => entry.parentIds.includes(female.id) && entry.bornDay === state.clock.day);
  assert.ok(child);
  assert.ok(child.genetics.anomalyTraits.includes('echo-lineage'));
  assert.equal(child.identityOrigin, 'lived-game-state');
  assert.equal(child.worldEntityId, undefined);
  assert.equal(child.identityAnchorId, undefined);
  assert.ok(Object.values(child.profileAuthority ?? {}).every((value) => value === 'lived-game-state'));
  const parentRelation = female.relations.find((entry) => entry.targetId === child.id && entry.kind === 'kin');
  assert.ok(parentRelation);
  assert.equal(parentRelation.authority, 'lived-game-state');
});

test('rescue expeditions use the ordinary expedition simulation and can recover a missing party', async () => {
  const { provider, state } = await initial(121212);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').sort((a, b) => b.skills.scouting - a.skills.scouting);
  const missing = launchExpedition(state, { leaderId: adults[0].id, memberIds: adults.slice(0, 2).map((entry) => entry.id), controlMode: 'settlement', doctrineId: state.doctrines[0].id, destination: { ...state.settlement.position, x: state.settlement.position.x + 3 } });
  missing.position = { ...state.settlement.position, x: state.settlement.position.x + 3 };
  const verified = missing.communicationReports.at(-1);
  assert.ok(verified);
  verified.verifiedPosition = structuredClone(missing.position);
  missing.status = 'missing'; missing.communication = 'unknown'; missing.silentHours = 80; missing.missingReason = 'test search target';
  const rescuers = adults.filter((entry) => !missing.memberIds.includes(entry.id)).slice(0, 3);
  for (const rescuer of rescuers) rescuer.skills.scouting = 100;
  const rescue = launchRescueExpedition(state, missing.id, rescuers[0].id, rescuers.map((entry) => entry.id), 'expedition');
  for (let attempt = 0; attempt < 10 && rescue.rendezvousPlan?.status !== 'contact'; attempt += 1) await advanceSandboxHours(provider, state, 6);
  assert.equal(rescue.rendezvousPlan?.status, 'contact');
  transferRendezvousAidAndWounded(state, rescue.id);
  for (let attempt = 0; attempt < 10 && missing.status === 'returning'; attempt += 1) await advanceSandboxHours(provider, state, 6);
  assert.notEqual(missing.status, 'missing');
  assert.ok(['returning','returned','destroyed'].includes(missing.status));
  assert.ok(['returning','returned'].includes(rescue.status));
  assert.ok(state.chronicle.some((entry) => entry.title.includes('Missing expedition located') || entry.title.includes('Rescue confirmed')));
});

test('WEDO encounter casualties immediately update the underlying individual', async () => {
  const { state } = await initial(343434);
  const { createEncounter, buildEncounterQueue, resolveEncounterRound } = await import('../.test-dist/sandbox/encounterSimulation.js');
  const adult = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(adult);
  const expedition = launchExpedition(state, { leaderId: adult.id, memberIds: [adult.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  const encounter = createEncounter(state, expedition, 'defend', 1);
  const actor = encounter.actors.find((entry) => entry.agentId === adult.id);
  assert.ok(actor);
  actor.health = 0;
  encounter.queue = buildEncounterQueue(state, encounter);
  resolveEncounterRound(state, encounter.id);
  assert.equal(encounter.status, 'resolved');
  assert.equal(adult.alive, false);
  assert.equal(adult.health, 0);
  assert.ok(encounter.casualties.includes(adult.id));
});

test('epistemically unfounded expedition orders can be refused by autonomous command holders', async () => {
  const { provider, state } = await initial(606060);
  const leader = state.agents.find((entry) => entry.id === state.settlement.leaderId);
  assert.ok(leader);
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'settlement', doctrineId: state.doctrines[0].id });
  leader.authority.obedience = 0;
  leader.authority.refusalThreshold = 100;
  leader.morale = 0;
  const order = addExpeditionOrder(state, expedition.id, 'return', 'Return because of an unverified player-only claim.', { epistemicBasisIds: ['knowledge:not-held'] });
  assert.equal(order.unfounded, true);
  await advanceSandboxHours(provider, state, 6);
  assert.equal(order.completed, true);
  assert.equal(order.refused, true);
  assert.match(order.resolution ?? '', /^refused:/);
  assert.ok(state.chronicle.some((entry) => entry.title === 'Expedition order refused'));
});

test('captured and time-displaced expedition states remain recoverable through ordinary rescue simulation', async () => {
  const { provider, state } = await initial(616161);
  const { markExpeditionLossState } = await import('../.test-dist/sandbox/expeditionSimulation.js');
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').sort((a, b) => b.skills.scouting - a.skills.scouting);
  const lostMembers = adults.slice(0, 2);
  const target = launchExpedition(state, { leaderId: lostMembers[0].id, memberIds: lostMembers.map((entry) => entry.id), controlMode: 'settlement', doctrineId: state.doctrines[0].id, destination: { ...state.settlement.position, x: state.settlement.position.x + 2 } });
  target.position = { ...state.settlement.position, x: state.settlement.position.x + 2 };
  markExpeditionLossState(state, target.id, 'capture', 'test capture state', ['settlement:test-captor']);
  assert.equal(target.status, 'captured');
  assert.ok(lostMembers.every((entry) => entry.residence === 'unknown' && entry.expeditionId === target.id));
  const rescuers = adults.filter((entry) => !target.memberIds.includes(entry.id)).slice(0, 3);
  for (const rescuer of rescuers) { rescuer.skills.scouting = 100; rescuer.skills.leadership = 100; }
  const rescue = launchRescueExpedition(state, target.id, rescuers[0].id, rescuers.map((entry) => entry.id), 'expedition');
  for (let attempt = 0; attempt < 24 && rescue.rendezvousPlan?.status !== 'contact'; attempt += 1) await advanceSandboxHours(provider, state, 6);
  assert.equal(rescue.rendezvousPlan?.status, 'contact');
  transferRendezvousAidAndWounded(state, rescue.id);
  for (let attempt = 0; attempt < 24 && target.status === 'returning'; attempt += 1) await advanceSandboxHours(provider, state, 6);
  assert.notEqual(target.status, 'captured');
  assert.ok(['returning','returned','destroyed'].includes(target.status));
  assert.ok(['returning','returned'].includes(rescue.status));
  if (target.status !== 'destroyed') assert.ok(lostMembers.some((entry) => entry.residence === 'expedition' || entry.residence === 'settlement'));
});

test('adult partnerships can emerge from accumulated affinity and trust instead of fixed reproduction flags', async () => {
  const { provider, state } = await initial(626262);
  const adults = state.agents.filter((entry) => entry.alive && state.clock.day - entry.bornDay >= 18 * 365 && entry.partnerIds.length === 0);
  const a = adults[0];
  const b = adults.find((entry) => entry.id !== a?.id && entry.householdId !== a?.householdId);
  assert.ok(a && b);
  a.relations = a.relations.filter((entry) => entry.targetId !== b.id);
  b.relations = b.relations.filter((entry) => entry.targetId !== a.id);
  a.relations.push({ targetId: b.id, kind: 'trust', affinity: 90, trust: 88, obligation: 25 });
  b.relations.push({ targetId: a.id, kind: 'trust', affinity: 89, trust: 87, obligation: 24 });
  a.experience[`bond:${b.id}`] = 20;
  b.experience[`bond:${a.id}`] = 20;
  await advanceSandboxHours(provider, state, 6);
  assert.ok(a.partnerIds.includes(b.id));
  assert.ok(b.partnerIds.includes(a.id));
  const partnership = a.relations.find((entry) => entry.targetId === b.id);
  assert.equal(partnership?.kind, 'partner');
  assert.equal(partnership?.authority, 'lived-game-state');
  assert.ok(state.chronicle.some((entry) => entry.title.includes('formed a partnership')));
});

test('clinic care turns folk-practice trials into fallible transmissible knowledge', async () => {
  const { provider, state } = await initial(636363);
  const patient = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  const medic = state.agents.find((entry) => entry.alive && entry.role === 'medic') ?? state.agents.find((entry) => entry.alive && entry.role !== 'child' && entry.id !== patient?.id);
  assert.ok(patient && medic);
  medic.role = 'medic'; medic.skills.medicine = 95; medic.residence = 'settlement'; medic.expeditionId = null;
  patient.pathology.push({ id: 'case:folk-learning', pathologyId: 'gastroenteric-fever', onsetDay: state.clock.day, severity: 24, contagious: true, observedSymptoms: [], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  state.settlement.clinicCapacity = 12; state.settlement.resources.medicine = 20;
  await advanceSandboxHours(provider, state, 6);
  const path = patient.pathology.find((entry) => entry.id === 'case:folk-learning');
  assert.ok(path && path.treatmentsTried.length > 0);
  const practice = path.treatmentsTried[0];
  const learned = state.knowledge.find((entry) => entry.subjectIds.includes('pathology:gastroenteric-fever') && entry.subjectIds.includes(`treatment:${practice}`));
  assert.ok(learned);
  assert.match(learned.claim, /causal knowledge/);
  assert.ok(learned.confidence > 0 && learned.confidence < 1);
  assert.ok((medic.experience[`treatment:gastroenteric-fever:${practice}`] ?? 0) > 0);
});


test('agent decision state includes personality, interpretive faith, affiliations and social standing', async () => {
  const { state } = await initial(646464);
  const agent = state.agents.find((entry) => entry.alive && state.clock.day - entry.bornDay >= 18 * 365);
  assert.ok(agent?.personality);
  assert.ok(agent.faith);
  assert.ok((agent.affiliationIds?.length ?? 0) >= 1);
  assert.ok(agent.socialStatus);
  assert.ok(Object.values(agent.personality).every((value) => Number.isFinite(value) && value >= 0 && value <= 100));
  assert.ok(state.settlement.institutions.some((institution) => institution.memberIds.includes(agent.id)) || agent.affiliationIds.includes(agent.householdId));
});

test('field anomaly alterations persist memory, personality, body, parasitism and anomalous-pregnancy consequences', async () => {
  const { state } = await initial(656565);
  const { recordExpeditionAlteration } = await import('../.test-dist/sandbox/expeditionSimulation.js');
  const female = state.agents.find((entry) => entry.alive && entry.sex === 'female' && state.clock.day - entry.bornDay >= 18 * 365 && state.clock.day - entry.bornDay <= 40 * 365);
  const male = state.agents.find((entry) => entry.alive && entry.sex === 'male' && state.clock.day - entry.bornDay >= 18 * 365);
  assert.ok(female && male);
  female.memories.push({ id: 'memory:test-before-alteration', day: state.clock.day, kind: 'event', text: 'A remembered route.', salience: 45, sourceIds: [] });
  const expedition = launchExpedition(state, { leaderId: female.id, memberIds: [female.id, male.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  const beforeAutonomy = male.personality?.autonomy ?? 50;
  recordExpeditionAlteration(state, expedition.id, female.id, 'memory-change', 'test memory alteration', ['anomaly:test']);
  recordExpeditionAlteration(state, expedition.id, male.id, 'personality-change', 'test personality alteration', ['anomaly:test']);
  recordExpeditionAlteration(state, expedition.id, female.id, 'body-change', 'test body alteration', ['anomaly:test']);
  recordExpeditionAlteration(state, expedition.id, male.id, 'parasitism', 'test parasitism', ['anomaly:test']);
  recordExpeditionAlteration(state, expedition.id, female.id, 'anomalous-pregnancy', 'test anomalous pregnancy', ['anomaly:test']);
  assert.deepEqual(new Set(expedition.alterations?.map((entry) => entry.kind)), new Set(['memory-change','personality-change','body-change','parasitism','anomalous-pregnancy']));
  assert.ok(female.memories.some((entry) => entry.text.includes('memory discontinuity') || entry.text.includes('missing memory')));
  assert.ok(male.personality && Object.values(male.personality).some((value, index) => index !== 3 || value !== beforeAutonomy) || (expedition.alterations?.some((entry) => entry.kind === 'personality-change') ?? false));
  assert.ok(female.genetics.anomalyTraits.some((entry) => entry.startsWith('field-body-change:')));
  assert.ok(male.pathology.some((entry) => entry.pathologyId.startsWith('anomalous-parasitism:')));
  assert.ok(state.pregnancies.some((entry) => entry.pregnantAgentId === female.id && entry.anomalyTags.some((tag) => tag.startsWith('field-conception:'))));
});


test('research requires extant in-world evidence and does not duplicate an active hypothesis', async () => {
  const { state } = await initial(666666);
  const { startResearchProject } = await import('../.test-dist/sandbox/researchSimulation.js');
  assert.throws(() => startResearchProject(state, 'knowledge:not-real'), /extant in-world knowledge/);
  const source = state.knowledge.find((entry) => !entry.lost);
  assert.ok(source);
  const first = startResearchProject(state, source.id);
  const second = startResearchProject(state, source.id);
  assert.equal(second.id, first.id);
  assert.equal(first.sourceKnowledgeId, source.id);
  assert.deepEqual(first.basisKnowledgeIds, [source.id]);
  assert.ok(first.researcherIds.length >= 1);
  assert.ok(first.researcherIds.every((id) => state.agents.some((agent) => agent.id === id && agent.alive)));
});

test('research advances through ordinary world time and produces provisional provenance-bearing knowledge', async () => {
  const { provider, state } = await initial(676767);
  const { startResearchProject } = await import('../.test-dist/sandbox/researchSimulation.js');
  const source = state.knowledge.find((entry) => !entry.lost);
  assert.ok(source);
  source.truthLinkIds = ['world-truth:test-hidden-cause'];
  source.confidence = 0.64;
  const researchers = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  for (const agent of researchers) {
    agent.skills.records = 100;
    agent.skills.medicine = 100;
    agent.skills.scouting = 100;
    if (agent.personality) agent.personality.curiosity = 100;
  }
  state.settlement.resources.records = 30;
  const project = startResearchProject(state, source.id, researchers.map((entry) => entry.id));
  await advanceSandboxDays(provider, state, 30);
  assert.equal(project.status, 'completed');
  assert.equal(project.progress, 100);
  assert.ok(project.resultKnowledgeId);
  const result = state.knowledge.find((entry) => entry.id === project.resultKnowledgeId);
  assert.ok(result);
  assert.equal(result.sourceKnowledgeId, source.id);
  assert.deepEqual(result.truthLinkIds, source.truthLinkIds);
  assert.match(result.claim, /^Local research provisionally/);
  assert.ok(result.confidence > 0 && result.confidence < 1);
  assert.ok(state.settlement.localKnowledgeIds.includes(result.id));
  assert.ok(researchers.every((agent) => (agent.experience[`research:${project.id}`] ?? 0) > 0));
  assert.ok(state.chronicle.some((entry) => entry.title === 'Research result recorded' && entry.entityIds.includes(result.id)));
});


test('anomaly utilization requires in-world anomaly knowledge and accumulates practical mastery through provider interventions', async () => {
  const { provider, state } = await initial(686868);
  const { addObservedKnowledge } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const { attemptAnomalyUtilization, anomalyBasisForKnowledge } = await import('../.test-dist/sandbox/anomalyUtilization.js');
  const ordinary = state.knowledge.find((entry) => !entry.lost);
  if (ordinary) assert.equal(anomalyBasisForKnowledge(state, ordinary), null);
  const basis = addObservedKnowledge(state, [state.settlement.leaderId], ['anomaly:glass-rain-basin','descendants.anomaly.pressure'], 'Repeated field observations suggest an anomalous material-weather process can sometimes be redirected.', 0.99);
  assert.ok(anomalyBasisForKnowledge(state, basis));
  const operators = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  for (const agent of operators) {
    agent.skills.construction = 100;
    agent.skills.records = 100;
    agent.skills.scouting = 100;
    if (agent.personality) agent.personality.curiosity = 100;
  }
  const beforeFuel = state.settlement.resources.fuel;
  let observedSuccess = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await attemptAnomalyUtilization(provider, state, { sourceKnowledgeId: basis.id, domain: 'production', operatorIds: operators.map((entry) => entry.id) });
    assert.equal(result.accepted, true);
    observedSuccess ||= result.success;
  }
  const practice = state.anomalyPractices?.find((entry) => entry.sourceKnowledgeId === basis.id && entry.domain === 'production');
  assert.ok(practice);
  assert.equal(practice.attempts, 6);
  assert.ok(practice.mastery > 0);
  assert.ok(practice.providerEventIds.length >= 6);
  assert.ok(operators.every((agent) => (agent.experience['anomaly-use:production'] ?? 0) >= 6));
  assert.equal(observedSuccess, true);
  assert.ok(state.settlement.resources.fuel > beforeFuel - 6 * 0.4);
  const snapshot = await provider.exportSnapshot(2);
  assert.ok(snapshot.events.some((entry) => entry.kind === 'command.anomaly.utilize' && entry.targetIds.includes('anomaly:glass-rain-basin')));
  assert.ok(state.knowledge.some((entry) => entry.sourceKnowledgeId === basis.id && entry.claim.startsWith('Practice result (production):')));
});

test('normal F1-F5 UI never enumerates provider recipe variables or hidden diagnostics', async () => {
  const appSource = await readSandboxUiSource();
  assert.doesNotMatch(appSource, /discoveredVariableIds/);
  assert.doesNotMatch(appSource, /Developer provider diagnostics|devDiagnostics/);
  assert.match(appSource, /WORLD KNOWLEDGE PROJECTION/);
});


test('settlement policy changes require assembly support rather than direct player authority', async () => {
  const { state } = await initial(696969);
  const { proposeLaborPriority } = await import('../.test-dist/sandbox/politicalSimulation.js');
  const leader = state.agents.find((entry) => entry.id === state.settlement.leaderId);
  assert.ok(leader);
  const assembly = state.settlement.institutions.find((entry) => entry.kind === 'assembly');
  assert.ok(assembly);
  for (const id of assembly.memberIds) {
    const voter = state.agents.find((entry) => entry.id === id);
    if (!voter) continue;
    voter.personality ??= { curiosity: 50, caution: 50, sociability: 50, autonomy: 50, empathy: 50 };
    voter.personality.autonomy = 0;
    voter.socialStatus ??= { standing: 50, dependency: 50, outsider: 0 };
    voter.relations = voter.relations.filter((entry) => entry.targetId !== leader.id);
    voter.relations.push({ targetId: leader.id, kind: 'trust', affinity: 95, trust: 95, obligation: 10 });
    voter.skills.medicine = 95;
  }
  leader.authority.legitimacy = 100;
  const before = state.settlement.laborPriorities.medicine;
  const accepted = proposeLaborPriority(state, 'medicine', 1);
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.supporterIds.length > accepted.opponentIds.length);
  assert.equal(state.settlement.laborPriorities.medicine, before + 1);

  for (const id of assembly.memberIds) {
    const voter = state.agents.find((entry) => entry.id === id);
    if (!voter || voter.id === leader.id) continue;
    voter.personality.autonomy = 100;
    voter.relations = voter.relations.filter((entry) => entry.targetId !== leader.id);
    voter.relations.push({ targetId: leader.id, kind: 'rival', affinity: 0, trust: 0, obligation: 0 });
    voter.skills.records = 0;
  }
  leader.authority.legitimacy = 0;
  const recordsBefore = state.settlement.laborPriorities.records;
  const rejected = proposeLaborPriority(state, 'records', 1);
  assert.equal(rejected.status, 'rejected');
  assert.equal(state.settlement.laborPriorities.records, recordsBefore);
  assert.ok(state.chronicle.some((entry) => entry.title.includes('Policy proposal rejected')));
});

test('agent planner materially uses pathology, family, beliefs, knowledge, memory, affiliations, genetics and experience', async () => {
  const { state } = await initial(707070);
  const { agentTaskScore } = await import('../.test-dist/sandbox/settlementSimulation.js');
  const agent = state.agents.find((entry) => entry.alive && entry.role !== 'child' && entry.relations.some((relation) => relation.kind === 'kin'));
  assert.ok(agent);

  const medicineBefore = agentTaskScore(state, agent, 'medicine');
  agent.pathology.push({ id: 'case:planner-test', pathologyId: 'respiratory-fever', onsetDay: state.clock.day, severity: 72, contagious: true, observedSymptoms: ['fever'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  agent.affiliationIds ??= [];
  if (!agent.affiliationIds.includes('institution:clinic')) agent.affiliationIds.push('institution:clinic');
  agent.experience.medicine = 180;
  agent.beliefs.push({ id: 'belief:planner-medicine', subjectIds: ['pathology:respiratory-fever'], claim: 'Clinic observation suggests treatment and medicine may matter for this illness.', confidence: 0.8, basisKnowledgeIds: [] });
  assert.ok(agentTaskScore(state, agent, 'medicine') > medicineBefore + 3, 'pathology, clinic affiliation, belief and experience should raise medicine motivation');

  const careBefore = agentTaskScore(state, agent, 'care');
  const close = state.agents.find((entry) => agent.relations.some((relation) => relation.targetId === entry.id && (relation.kind === 'kin' || relation.kind === 'partner')));
  assert.ok(close);
  close.health = 25;
  assert.ok(agentTaskScore(state, agent, 'care') > careBefore, 'vulnerable close family should raise care motivation');

  const recordsBefore = agentTaskScore(state, agent, 'records');
  state.knowledge.push({ id: 'knowledge:planner-route', subjectIds: ['route:unknown','anomaly:signal'], claim: 'An anomalous outside signal was observed on the route.', confidence: 0.7, acquiredDay: state.clock.day, carrier: 'memory', holderIds: [agent.id], truthLinkIds: [], lost: false });
  agent.knowledgeIds.push('knowledge:planner-route');
  agent.memories.push({ id: 'memory:planner-evidence', day: state.clock.day, kind: 'knowledge', text: 'A difficult field observation should be preserved.', salience: 90, sourceIds: ['knowledge:planner-route'] });
  agent.experience.records = 180;
  assert.ok(agentTaskScore(state, agent, 'records') > recordsBefore + 2, 'held knowledge, salient memory and embodied records experience should raise recording motivation');

  agent.genetics.loci.resilience = 20;
  agent.memories = agent.memories.filter((memory) => memory.kind !== 'trauma');
  const guardLow = agentTaskScore(state, agent, 'guard');
  agent.genetics.loci.resilience = 90;
  agent.memories.push({ id: 'memory:planner-trauma', day: state.clock.day, kind: 'trauma', text: 'A violent loss changed perceived danger.', salience: 95, sourceIds: [] });
  assert.ok(agentTaskScore(state, agent, 'guard') > guardLow + 1, 'constitution and traumatic memory should affect guard motivation');

  const exploreBeforeTrait = agentTaskScore(state, agent, 'explore-prep');
  agent.genetics.anomalyTraits.push('field-body-change:test');
  assert.ok(agentTaskScore(state, agent, 'explore-prep') > exploreBeforeTrait, 'persistent mutation state should affect anomaly-facing exploration choices without moral classification');
});

test('provider-backed sandbox exposes persistent accessibility controls and non-visual encounter semantics', async () => {
  const [appSource, styles] = await Promise.all([
    readSandboxUiSource(),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ]);
  for (const token of ['sandbox-skip-link','a11y-scale','a11y-contrast','a11y-motion','aria-live="polite"','aria-label="Encounter grid: E expedition, X other"']) assert.ok(appSource.includes(token), `missing accessibility token ${token}`);
  for (const token of ['prefers-reduced-motion','a11y-scale-150','a11y-contrast','a11y-reduce-motion',':focus-visible']) assert.ok(styles.includes(token), `missing accessibility style ${token}`);
});

test('generated equipment lazy-migrates deterministically and contributes only while equipped', async () => {
  const a = await initial(8080);
  const b = await initial(8080);
  const { ensureDirectPlayState, equipmentForAgent, setEquipmentEquipped } = await import('../.test-dist/sandbox/directPlay.js');
  const { skillContribution } = await import('../.test-dist/sandbox/stateUtils.js');
  const agentA = a.state.agents.find((entry) => entry.alive && entry.role !== 'child');
  const agentB = b.state.agents.find((entry) => entry.id === agentA?.id);
  assert.ok(agentA && agentB);
  ensureDirectPlayState(a.state); ensureDirectPlayState(b.state);
  const gearA = equipmentForAgent(a.state, agentA.id);
  const gearB = equipmentForAgent(b.state, agentB.id);
  assert.deepEqual(gearA.map(({name,slot,skillBonuses})=>({name,slot,skillBonuses})), gearB.map(({name,slot,skillBonuses})=>({name,slot,skillBonuses})));
  const effectItem = gearA.find((entry) => entry.equipped && Object.values(entry.skillBonuses).some((value)=>Number(value)>0));
  assert.ok(effectItem);
  const skill = Object.keys(effectItem.skillBonuses)[0];
  const before = skillContribution(agentA, skill);
  setEquipmentEquipped(a.state, agentA.id, effectItem.id, false);
  const after = skillContribution(agentA, skill);
  assert.ok(after < before, `${effectItem.name} should materially affect ${skill}`);
  setEquipmentEquipped(a.state, agentA.id, effectItem.id, true);
  assert.ok(skillContribution(agentA, skill) > after);
});

test('LOCAL materialization always uses observer-bounded WorldProvider query projection', async () => {
  const { provider, state } = await initial(8181);
  const { queryGeneratedLocalArea } = await import('../.test-dist/sandbox/localExploration.js');
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const original = provider.queryArea.bind(provider);
  let captured = null;
  provider.queryArea = async (query) => { captured = structuredClone(query); return original(query); };
  const projection = await queryGeneratedLocalArea(provider, state, leader.id, state.settlement.position, 5);
  assert.ok(projection.entities.length > 0);
  assert.equal(captured.observerId, leader.id);
  assert.equal(captured.includeKnowledgeProjection, true);
  assert.equal(captured.requestedDetailRank, 0);
  assert.equal(captured.radiusKm, 5);
});

test('direct local observation creates personal evidence without silently promoting institutional knowledge', async () => {
  const { provider, state } = await initial(8282);
  const { queryGeneratedLocalArea, observeGeneratedEntity } = await import('../.test-dist/sandbox/localExploration.js');
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const projection = await queryGeneratedLocalArea(provider, state, leader.id, state.settlement.position, 5);
  const target = projection.entities.find((entry) => entry.id !== state.settlement.worldEntityId) ?? projection.entities[0];
  assert.ok(target);
  const evidence = observeGeneratedEntity(state, leader.id, target);
  assert.ok(leader.knowledgeIds.includes(evidence.id));
  assert.equal(state.settlement.localKnowledgeIds.includes(evidence.id), false);
  assert.ok(evidence.truthLinkIds.every((id) => target.provenanceIds.includes(id)));
});

test('physical sample collection preserves generated source and provenance in personal inventory', async () => {
  const { provider, state } = await initial(8383);
  const { queryGeneratedLocalArea, takeGeneratedSample } = await import('../.test-dist/sandbox/localExploration.js');
  const { inventoryForAgent } = await import('../.test-dist/sandbox/directPlay.js');
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const center = { frameId: 'world', x: 322, y: 198, regionId: 'region:greenfold' };
  const projection = await queryGeneratedLocalArea(provider, state, leader.id, center, 5);
  const anomaly = projection.entities.find((entry) => entry.kind === 'anomaly');
  assert.ok(anomaly);
  const { item, knowledge } = takeGeneratedSample(state, leader.id, anomaly);
  assert.equal(item.kind, 'sample');
  assert.equal(item.sourceEntityId, anomaly.id);
  assert.ok(item.provenanceIds.includes(`sample-source:${anomaly.id}`));
  assert.ok(inventoryForAgent(state, leader.id).some((entry) => entry.id === item.id));
  assert.equal(state.settlement.localKnowledgeIds.includes(knowledge.id), false);
});

test('direct activity reserves canonical person-time and suppresses ordinary settlement labor for that interval', async () => {
  const { provider, state } = await initial(8484);
  const { reserveDirectActivity } = await import('../.test-dist/sandbox/directPlay.js');
  const leader = state.agents.find((entry) => entry.id === state.settlement.leaderId);
  assert.ok(leader);
  reserveDirectActivity(state, [leader.id], 'survey', 60, 'Dedicated local survey.');
  await advanceSandboxHours(provider, state, 1);
  assert.equal(leader.currentTask, 'rest');
  assert.equal(leader.currentPlan?.reason, 'time reserved by direct player activity');
  assert.equal(state.directPlay.directActivities.at(-1)?.completed, true);
});

test('field direct activity consumes time and supplies while pausing expedition movement', async () => {
  const { provider, state } = await initial(8585);
  const { reserveDirectActivity } = await import('../.test-dist/sandbox/directPlay.js');
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id, destination: { frameId: 'world', x: 314, y: 200, regionId: 'region:greenfold' } });
  const beforePosition = structuredClone(expedition.position);
  const beforeFood = expedition.supplies.food;
  reserveDirectActivity(state, [leader.id], 'observe', 60, 'Close local observation.');
  await advanceSandboxHours(provider, state, 1);
  assert.deepEqual(expedition.position, beforePosition);
  assert.ok(expedition.supplies.food < beforeFood, 'field time still consumes supplies');
});

test('direct-play physical state survives validated save round-trip without schema bump', async () => {
  const { state } = await initial(8686);
  const { ensureDirectPlayState, reserveDirectActivity } = await import('../.test-dist/sandbox/directPlay.js');
  const leader = state.agents.find((entry) => entry.id === state.settlement.leaderId);
  assert.ok(leader);
  ensureDirectPlayState(state);
  reserveDirectActivity(state, [leader.id], 'equipment', 5, 'Adjusted field equipment.');
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.directPlay.equipment.length, state.directPlay.equipment.length);
  assert.equal(restored.directPlay.directActivities.at(-1)?.kind, 'equipment');
});

test('remote expedition discoveries stay party-held until an in-world recording path promotes them', async () => {
  const { provider, state } = await initial(8787);
  const leader = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(leader);
  const destination = { frameId: 'world', x: 314, y: 200, regionId: 'region:greenfold' };
  const expedition = launchExpedition(state, { leaderId: leader.id, memberIds: [leader.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id, destination });
  expedition.position = structuredClone(destination);
  expedition.discoveredEntityIds = [];
  await advanceSandboxHours(provider, state, 1);
  const partyDiscovery = state.knowledge.find((entry) => entry.claim.startsWith('Expedition observed:') && entry.holderIds.includes(leader.id));
  assert.ok(partyDiscovery);
  assert.equal(state.settlement.localKnowledgeIds.includes(partyDiscovery.id), false);
  assert.ok(expedition.discoveredEntityIds.length > 0);
});

test('direct conversation transfers only a specific co-located known claim and does not create institutional omniscience', async () => {
  const { state } = await initial(8881);
  const { addObservedKnowledge, conductDirectConversation } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 2);
  assert.equal(adults.length, 2);
  const [speaker, listener] = adults;
  const claim = addObservedKnowledge(state, [speaker.id], ['entity:conversation-test'], 'A particular ridge gives a clear echo at dusk.', 0.78, undefined, ['witness:test'], { promoteToSettlement: false });
  assert.equal(state.settlement.localKnowledgeIds.includes(claim.id), false);
  conductDirectConversation(state, speaker.id, listener.id, claim.id);
  assert.ok(listener.knowledgeIds.includes(claim.id));
  assert.ok(claim.holderIds.includes(listener.id));
  assert.equal(state.settlement.localKnowledgeIds.includes(claim.id), false);
  assert.equal(state.directPlay.directActivities.at(-1)?.kind, 'conversation');
  assert.equal(state.directPlay.directActivities.at(-1)?.endAbsoluteMinute - state.directPlay.directActivities.at(-1)?.startAbsoluteMinute, 20);
});

test('direct contact with an outside person remains anchored to a provider fine individual id without inventing biography', async () => {
  const { state } = await initial(88815);
  const { conductExternalPersonContact } = await import('../.test-dist/sandbox/externalContact.js');
  const speaker = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(speaker);
  const expedition = launchExpedition(state, { leaderId: speaker.id, memberIds: [speaker.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id, destination: { ...state.settlement.position, x: state.settlement.position.x + 1 } });
  const outside = { id: 'individual:outside:test-01', kind: 'individual', spatial: structuredClone(expedition.position), components: { name: 'Observed Outsider', cohortId: 'cohort:outside:test' }, provenanceIds: ['prov:outside-person:test'] };
  state.externalActors.push({ entityId: 'settlement:outside:test', provenanceIds: ['prov:outside-settlement:test'], fineActorIds: [outside.id], relationshipIds: [], effectiveDetailRank: 0, kind: 'settlement', name: 'Outside Test Settlement', population: 12, position: { ...state.settlement.position, x: state.settlement.position.x + 1 }, lastObservedTick: state.clock.worldTick, confidence: .9, disposition: null, localTrust: 0, tradeExperience: 0, migrationBalance: 0, conflictPressure: 0 });
  const { contact, knowledgeId } = conductExternalPersonContact(state, speaker.id, outside);
  assert.equal(contact.externalPersonId, outside.id);
  assert.equal(contact.societyEntityId, 'settlement:outside:test');
  assert.deepEqual(contact.provenanceIds, outside.provenanceIds);
  assert.ok(speaker.knowledgeIds.includes(knowledgeId));
  assert.equal(state.settlement.localKnowledgeIds.includes(knowledgeId), false);
  assert.equal(state.externalContacts?.length, 1);
  assert.ok(state.chronicle.some((entry) => entry.entityIds.includes(outside.id)));
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.externalContacts?.[0]?.externalPersonId, outside.id);
});

test('F2 and F3 visibly distinguish provider facts, gameplay interpretations and lived epistemic products', async () => {
  const appSource = await readSandboxUiSource();
  for (const token of ['出自に基づく個人情報','集落の記録に基づく個人情報','集落の記録','確度は裏づけの強さを示します']) assert.ok(appSource.includes(token), `missing authority cue ${token}`);
});

test('explicit Records Archive action is the deliberate personal-to-institutional promotion path', async () => {
  const { state } = await initial(8882);
  const { addObservedKnowledge, institutionalizeKnowledgeRecord } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const author = state.agents.find((entry) => entry.id === state.settlement.leaderId);
  assert.ok(author);
  const claim = addObservedKnowledge(state, [author.id], ['entity:archive-test'], 'A field mark may indicate seasonal flooding.', 0.71, undefined, ['field-note:test'], { promoteToSettlement: false });
  const beforeRecords = state.records.length;
  const record = institutionalizeKnowledgeRecord(state, author.id, claim.id);
  assert.equal(state.records.length, beforeRecords + 1);
  assert.ok(state.settlement.localKnowledgeIds.includes(claim.id));
  assert.ok(state.settlement.activeRecordIds.includes(record.id));
  assert.ok(state.settlement.institutions.find((entry) => entry.kind === 'records')?.recordIds.includes(record.id));
  assert.equal(claim.carrier, 'record');
  assert.equal(state.directPlay.directActivities.at(-1)?.kind, 'records');
});

test('direct field evidence research requires its matching physical sample at the settlement context', async () => {
  const { provider, state } = await initial(8883);
  const { queryGeneratedLocalArea, observeGeneratedEntity, takeGeneratedSample } = await import('../.test-dist/sandbox/localExploration.js');
  const { startResearchProject, researchSampleGate } = await import('../.test-dist/sandbox/researchSimulation.js');
  const { institutionalizeKnowledgeRecord } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const observer = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(observer);
  const projection = await queryGeneratedLocalArea(provider, state, observer.id, { frameId: 'world', x: 322, y: 198, regionId: 'region:greenfold' }, 5);
  const target = projection.entities.find((entry) => entry.kind === 'anomaly');
  assert.ok(target);
  const evidence = observeGeneratedEntity(state, observer.id, target);
  assert.deepEqual(researchSampleGate(state, evidence.id).required, true);
  assert.throws(() => startResearchProject(state, evidence.id, [observer.id]), /physical sample/i);
  const { item } = takeGeneratedSample(state, observer.id, target);
  const gate = researchSampleGate(state, evidence.id);
  assert.equal(gate.available, true);
  assert.equal(gate.sample?.id, item.id);
  institutionalizeKnowledgeRecord(state, observer.id, evidence.id);
  const otherResearchers = state.agents.filter((entry) => entry.alive && entry.id !== observer.id && entry.role !== 'child').slice(0, 2);
  const project = startResearchProject(state, evidence.id, otherResearchers.map((entry) => entry.id));
  assert.equal(project.sampleItemId, item.id);
  assert.equal(project.sampleSourceEntityId, target.id);
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.researchProjects.find((entry) => entry.id === project.id)?.sampleItemId, item.id);
});

test('sample-gated research pauses when the committed physical sample leaves settlement', async () => {
  const { provider, state } = await initial(8884);
  const { queryGeneratedLocalArea, observeGeneratedEntity, takeGeneratedSample } = await import('../.test-dist/sandbox/localExploration.js');
  const { institutionalizeKnowledgeRecord } = await import('../.test-dist/sandbox/knowledgeSimulation.js');
  const { startResearchProject, simulateResearchInterval } = await import('../.test-dist/sandbox/researchSimulation.js');
  const observer = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(observer);
  const projection = await queryGeneratedLocalArea(provider, state, observer.id, { frameId: 'world', x: 322, y: 198, regionId: 'region:greenfold' }, 5);
  const target = projection.entities.find((entry) => entry.kind === 'anomaly');
  assert.ok(target);
  const evidence = observeGeneratedEntity(state, observer.id, target);
  const { item } = takeGeneratedSample(state, observer.id, target);
  institutionalizeKnowledgeRecord(state, observer.id, evidence.id);
  const researchers = state.agents.filter((entry) => entry.alive && entry.id !== observer.id && entry.role !== 'child').slice(0, 2);
  const project = startResearchProject(state, evidence.id, researchers.map((entry) => entry.id));
  const summary = { from: structuredClone(state.clock), to: structuredClone(state.clock), births: [], deaths: [], leadershipChanges: [], expeditionUpdates: [], encounterUpdates: [], knowledgeUpdates: [], settlementUpdates: [] };
  observer.expeditionId = 'expedition:test-carry-away'; observer.residence = 'expedition';
  simulateResearchInterval(state, 24, summary);
  assert.equal(project.progress, 0);
  observer.expeditionId = null; observer.residence = 'settlement';
  simulateResearchInterval(state, 24, summary);
  assert.ok(project.progress > 0);
  assert.equal(state.directPlay.inventory.find((entry) => entry.id === item.id)?.quantity, 1);
});

test('expedition launch preserves selected crew loadout doctrine and pace, and cautious pace travels more slowly', async () => {
  const normal = await initial(8885);
  const cautious = await initial(8885);
  const adultsA = normal.state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  const adultsB = cautious.state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  assert.equal(adultsA.length, 3); assert.equal(adultsB.length, 3);
  const target = { frameId: 'world', x: normal.state.settlement.position.x + 60, y: normal.state.settlement.position.y, regionId: normal.state.settlement.position.regionId };
  const doctrineA = saveDoctrine(normal.state, { name: 'Measured survey', riskTolerance: 0.18, retreatHealth: 62, maxSilentHours: 10, campBeforeDark: true, prioritizeRescue: true, contactPolicy: 'observe', encounterInstruction: 'withdraw' });
  const doctrineB = saveDoctrine(cautious.state, { name: 'Measured survey', riskTolerance: 0.18, retreatHealth: 62, maxSilentHours: 10, campBeforeDark: true, prioritizeRescue: true, contactPolicy: 'observe', encounterInstruction: 'withdraw' });
  const supplies = { food: 9, water: 15, medicine: 1.5, tools: 2 };
  const expNormal = launchExpedition(normal.state, { leaderId: adultsA[0].id, memberIds: adultsA.map((entry) => entry.id), controlMode: 'expedition', doctrineId: doctrineA.id, destination: target, supplies, pace: 'normal' });
  const expCautious = launchExpedition(cautious.state, { leaderId: adultsB[0].id, memberIds: adultsB.map((entry) => entry.id), controlMode: 'expedition', doctrineId: doctrineB.id, destination: target, supplies, pace: 'cautious' });
  assert.deepEqual(expNormal.supplies, supplies);
  assert.deepEqual(expNormal.memberIds, adultsA.map((entry) => entry.id));
  assert.equal(expNormal.doctrineId, doctrineA.id);
  assert.equal(expCautious.pace, 'cautious');
  const startX = normal.state.settlement.position.x;
  await advanceSandboxHours(normal.provider, normal.state, 1);
  await advanceSandboxHours(cautious.provider, cautious.state, 1);
  assert.ok(Math.abs(expCautious.position.x - startX) < Math.abs(expNormal.position.x - startX));
});

test('direct field camp reserves canonical time, halts travel and restores party fatigue', async () => {
  const { provider, state } = await initial(8890);
  const { campExpedition } = await import('../.test-dist/sandbox/expeditionSimulation.js');
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  const expedition = launchExpedition(state, { leaderId: adults[0].id, memberIds: adults.map((entry) => entry.id), controlMode: 'expedition', doctrineId: state.doctrines[0].id, destination: { ...state.settlement.position, x: state.settlement.position.x + 80 } });
  for (const agent of adults) agent.fatigue = 80;
  const start = structuredClone(expedition.position);
  campExpedition(state, expedition.id, 6);
  await advanceSandboxHours(provider, state, 6);
  assert.equal(expedition.position.x, start.x);
  assert.equal(expedition.position.y, start.y);
  assert.ok(adults.every((agent) => agent.fatigue < 80));
  assert.equal(state.directPlay.directActivities.at(-1)?.kind, 'camp');
  assert.ok(state.chronicle.some((entry) => entry.title === 'Expedition camp established'));
});

test('expedition-control WEDO waits for direct round stepping instead of silently auto-resolving', async () => {
  const { provider, state } = await initial(8891);
  const { createEncounter } = await import('../.test-dist/sandbox/encounterSimulation.js');
  const { resolveControlledEncounterRound } = await import('../.test-dist/sandbox/expeditionSimulation.js');
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  const expedition = launchExpedition(state, { leaderId: adults[0].id, memberIds: adults.map((entry) => entry.id), controlMode: 'expedition', doctrineId: state.doctrines[0].id, destination: { ...state.settlement.position, x: state.settlement.position.x + 30 } });
  const encounter = createEncounter(state, expedition, 'defend', 3);
  await advanceSandboxHours(provider, state, 1);
  assert.equal(encounter.status, 'queued');
  assert.equal(encounter.log.length, 0);
  const result = resolveControlledEncounterRound(state, encounter.id);
  assert.ok(encounter.log.length > 0);
  assert.equal(state.directPlay.directActivities.at(-1)?.kind, 'combat');
  assert.equal(typeof result.resolved, 'boolean');
});

test('camp-before-dark doctrine suppresses night travel and records the scheduling decision', async () => {
  const a = await initial(8892); const b = await initial(8892);
  a.state.clock.minuteOfDay = 17 * 60; b.state.clock.minuteOfDay = 17 * 60;
  const adultsA = a.state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 2);
  const adultsB = b.state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 2);
  const campDoctrine = saveDoctrine(a.state, { name: 'Night camp', riskTolerance: .4, retreatHealth: 30, maxSilentHours: 50, campBeforeDark: true, prioritizeRescue: false, contactPolicy: 'observe', encounterInstruction: 'withdraw' });
  const travelDoctrine = saveDoctrine(b.state, { name: 'Night travel', riskTolerance: .4, retreatHealth: 30, maxSilentHours: 50, campBeforeDark: false, prioritizeRescue: false, contactPolicy: 'observe', encounterInstruction: 'withdraw' });
  const targetA = { ...a.state.settlement.position, x: a.state.settlement.position.x + 100 };
  const targetB = { ...b.state.settlement.position, x: b.state.settlement.position.x + 100 };
  const expA = launchExpedition(a.state, { leaderId: adultsA[0].id, memberIds: adultsA.map((entry)=>entry.id), controlMode: 'settlement', doctrineId: campDoctrine.id, destination: targetA });
  const expB = launchExpedition(b.state, { leaderId: adultsB[0].id, memberIds: adultsB.map((entry)=>entry.id), controlMode: 'settlement', doctrineId: travelDoctrine.id, destination: targetB });
  await advanceSandboxHours(a.provider, a.state, 4); await advanceSandboxHours(b.provider, b.state, 4);
  const movedA = Math.abs(expA.position.x - a.state.settlement.position.x); const movedB = Math.abs(expB.position.x - b.state.settlement.position.x);
  assert.ok(movedA < movedB);
  assert.ok(a.state.chronicle.some((entry) => entry.title === 'Doctrine camp before dark'));
});

test('WORLD materialization requests coarse observer-bounded provider projection', async () => {
  const { provider, state } = await initial(8893);
  const { queryGeneratedWorldArea, generatedWorldMapRadiusKm } = await import('../.test-dist/sandbox/localExploration.js');
  const observer = state.settlement.leaderId;
  let captured;
  const wrapped = { ...provider, queryArea: async (query) => { captured = structuredClone(query); return provider.queryArea(query); } };
  const projection = await queryGeneratedWorldArea(wrapped, state, observer);
  assert.equal(captured.observerId, observer);
  assert.equal(captured.includeKnowledgeProjection, true);
  assert.equal(captured.requestedDetailRank, 2);
  assert.equal(captured.radiusKm, generatedWorldMapRadiusKm(state));
  assert.ok(projection.entities.length > 0);
});

test('dynamic settlement situations use received reports and do not expose hidden remote loss detail', async () => {
  const { state } = await initial(8894);
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  const adult = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  const expedition = launchExpedition(state, { leaderId: adult.id, memberIds: [adult.id], controlMode: 'settlement', doctrineId: state.doctrines[0].id, destination: { ...state.settlement.position, x: state.settlement.position.x + 20 } });
  expedition.communication = 'silent'; expedition.silentHours = 24;
  expedition.lossState = { kind: 'capture', sinceDay: state.clock.day, detail: 'SECRET CAPTURE LOCATION', recoverable: true, sourceEntityIds: ['secret:site'] };
  expedition.communicationReports.push({ id: 'report:test-visible', day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, status: 'silent', text: 'No verified reply after the scheduled check-in.', confidence: .2, verified: false, sourceIds: [expedition.id] });
  const signals = synthesizeVisibleSituations(state);
  const text = JSON.stringify(signals);
  assert.match(text, /No verified reply/);
  assert.doesNotMatch(text, /SECRET CAPTURE LOCATION|secret:site/);
});

test('volatile recovery repository preserves a validated session in memory without persistence side effects', async () => {
  const { createVolatileSandboxRepository } = await import('../.test-dist/sandbox/storage.js');
  const provider = new MockWorldProvider();
  const state = await createInitialSandboxState(provider, { population: 20 });
  const repo = createVolatileSandboxRepository(state);
  assert.equal(repo.mode, 'volatile');
  const loaded = await repo.loadRecoverable();
  assert.equal(loaded.mode, 'volatile');
  assert.equal(loaded.state?.saveId, state.saveId);
  assert.notEqual(loaded.state, state);
  state.settlement.resources.food += 7;
  await repo.save(state);
  const saved = await repo.load();
  assert.equal(saved?.settlement.resources.food, state.settlement.resources.food);
  saved.settlement.resources.food += 100;
  assert.notEqual((await repo.load())?.settlement.resources.food, saved.settlement.resources.food, 'volatile repository must clone state on read');
  await repo.clear();
  assert.equal(await repo.load(), null);
});

test('optimistic storage revision rejects stale multi-window save and reset while allowing the loaded revision', async () => {
  const { assertStorageRevision } = await import('../.test-dist/sandbox/storage.js');
  assert.doesNotThrow(() => assertStorageRevision(4, 4, 'write'));
  assert.doesNotThrow(() => assertStorageRevision(null, 9, 'write'));
  assert.throws(() => assertStorageRevision(4, 5, 'write'), /changed in another game window.*Export this session or reload/i);
  assert.throws(() => assertStorageRevision(4, 5, 'reset'), /changed in another game window.*Reset was cancelled/i);
});

test('provider advance partial failure rolls game state back and requires provider resynchronization', async () => {
  const { provider, state } = await initial(9901);
  const beforeState = JSON.stringify(state);
  const beforeTick = (await provider.getManifest()).currentTick;
  const fault = {
    getManifest: (...args) => provider.getManifest(...args),
    getEntity: (...args) => provider.getEntity(...args),
    queryArea: (...args) => provider.queryArea(...args),
    getKnowledge: (...args) => provider.getKnowledge(...args),
    issueCommand: (...args) => provider.issueCommand(...args),
    exportSnapshot: (...args) => provider.exportSnapshot(...args),
    advance: async (request) => { await provider.advance(request); throw new Error('fault-after-provider-advance'); },
  };
  await assert.rejects(() => advanceSandboxHours(fault, state, 6), (error) => {
    assert.equal(error?.providerMayHaveMutated, true);
    assert.match(String(error?.message), /rolled back.*resynchronization/i);
    return true;
  });
  assert.equal(JSON.stringify(state), beforeState, 'game state must be restored byte-for-byte after an uncertain provider advance');
  assert.ok((await provider.getManifest()).currentTick > beforeTick, 'fault fixture proves provider may already have advanced');
});

test('provider command post-commit failure rolls local consequences back instead of saving a split-brain state', async () => {
  const { provider, state } = await initial(9902);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  const beforeState = JSON.stringify(state);
  const beforeSnapshot = await provider.exportSnapshot(2);
  const fault = {
    getManifest: (...args) => provider.getManifest(...args),
    getEntity: (...args) => provider.getEntity(...args),
    queryArea: (...args) => provider.queryArea(...args),
    getKnowledge: (...args) => provider.getKnowledge(...args),
    advance: (...args) => provider.advance(...args),
    issueCommand: (...args) => provider.issueCommand(...args),
    exportSnapshot: async () => { throw new Error('fault-after-command-commit'); },
  };
  await assert.rejects(() => issueExternalAction(fault, state, {
    kind: 'diplomacy', targetEntityId: 'terrain:old-service-road', actorId: state.settlement.leaderId,
    detail: 'Fault-injected provider command.', epistemicBasisIds: state.settlement.localKnowledgeIds.slice(0, 1),
  }), (error) => {
    assert.equal(error?.providerMayHaveMutated, true);
    assert.match(String(error?.message), /local consequences were rolled back|拠点側の変更は取り消/i);
    return true;
  });
  assert.equal(JSON.stringify(state), beforeState);
  const afterSnapshot = await provider.exportSnapshot(2);
  assert.ok(afterSnapshot.events.length > beforeSnapshot.events.length, 'inner provider really committed the command before export failed');
});

test('save envelope checksum changes under silent state corruption and volatile freshness is always coherent', async () => {
  const { createVolatileSandboxRepository, sandboxStateChecksum } = await import('../.test-dist/sandbox/storage.js');
  const { state } = await initial(9903);
  const checksum = sandboxStateChecksum(state);
  const corrupted = structuredClone(state); corrupted.settlement.resources.food += 0.125;
  assert.notEqual(sandboxStateChecksum(corrupted), checksum);
  const repo = createVolatileSandboxRepository(state);
  assert.equal(await repo.checkFreshness(), 'fresh');
});

test('provider command receipt journal suppresses duplicate delivery of the same command id', async () => {
  const { provider, state } = await initial(9910);
  const { issueProviderCommandOnce } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const command = {
    id: 'game:test:idempotent-command', issuedTick: state.clock.worldTick, issuerId: state.settlement.leaderId,
    kind: 'external.diplomacy', targets: ['terrain:old-service-road'], payload: { detail: 'idempotency probe' },
  };
  const before = (await provider.exportSnapshot(2)).events.length;
  const first = await issueProviderCommandOnce(provider, state, command);
  const afterFirst = (await provider.exportSnapshot(2)).events.length;
  const second = await issueProviderCommandOnce(provider, state, command);
  const afterSecond = (await provider.exportSnapshot(2)).events.length;
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(afterFirst, before + 1);
  assert.equal(afterSecond, afterFirst, 'cached receipt must prevent a second provider intervention');
  assert.equal(state.providerMutations.commandReceipts.filter((entry) => entry.commandId === command.id).length, 1);
});

test('provider command rejection is terminal and is also cached instead of retried', async () => {
  const { provider, state } = await initial(9911);
  const { issueProviderCommandOnce } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  let calls = 0;
  const rejecting = {
    getManifest: (...args) => provider.getManifest(...args), getEntity: (...args) => provider.getEntity(...args), queryArea: (...args) => provider.queryArea(...args),
    getKnowledge: (...args) => provider.getKnowledge(...args), advance: (...args) => provider.advance(...args), exportSnapshot: (...args) => provider.exportSnapshot(...args),
    issueCommand: async (command) => { calls += 1; return { commandId: command.id, accepted: false, reason: 'terminal test rejection', eventIds: [], causalRecordIds: [] }; },
  };
  const command = { id: 'game:test:terminal-rejection', issuedTick: state.clock.worldTick, kind: 'social.contact', payload: {} };
  const first = await issueProviderCommandOnce(rejecting, state, command);
  const second = await issueProviderCommandOnce(rejecting, state, command);
  assert.equal(first.result.accepted, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1, 'terminal rejection must not be delivered repeatedly');
});

test('provider command ordinal is retry-stable across transactional rollback', async () => {
  const { state } = await initial(9912);
  const { nextProviderCommandId } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const { restoreSandboxState } = await import('../.test-dist/sandbox/worldMutationSafety.js');
  const committed = structuredClone(state);
  const first = nextProviderCommandId(state, 'retry-stability');
  restoreSandboxState(state, committed);
  const retried = nextProviderCommandId(state, 'retry-stability');
  assert.equal(retried, first, 'rollback must restore the command ordinal so resync/retry keeps the same provider command ID');
});

test('save envelope v3 forms a monotonic generation chain and detects corrupted HEAD content', async () => {
  const { state } = await initial(9913);
  const { buildSaveEnvelope, unwrapStoredSave } = await import('../.test-dist/sandbox/storage.js');
  const first = buildSaveEnvelope(state, null);
  assert.equal(first.revision, 1);
  assert.equal(first.commitGeneration, 1);
  assert.equal(first.parentStateHash, null);
  state.settlement.resources.food += 1;
  const second = buildSaveEnvelope(state, first);
  assert.equal(second.revision, 2);
  assert.equal(second.commitGeneration, 2);
  assert.equal(second.parentStateHash, first.stateHash);
  assert.equal(unwrapStoredSave(second).commitGeneration, 2);
  const corrupted = structuredClone(second); corrupted.state.settlement.resources.food += 0.5;
  assert.throws(() => unwrapStoredSave(corrupted), /checksum mismatch/i);
});

test('provider mutation journal survives save round-trip and rejects duplicated or tick-drifted receipts', async () => {
  const { provider, state } = await initial(9914);
  const { issueProviderCommandOnce } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const command = { id: 'game:test:receipt-save', issuedTick: state.clock.worldTick, kind: 'social.observe', payload: {} };
  await issueProviderCommandOnce(provider, state, command);
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  assert.equal(restored.providerMutations?.commandReceipts.length, 1);
  const duplicate = structuredClone(restored); duplicate.providerMutations.commandReceipts.push(structuredClone(duplicate.providerMutations.commandReceipts[0]));
  assert.throws(() => importSandboxSave(JSON.stringify(duplicate)), /duplicate provider command receipt/i);
  const drifted = structuredClone(restored); drifted.providerMutations.commandReceipts[0].providerTick += 1;
  assert.throws(() => importSandboxSave(JSON.stringify(drifted)), /tick drift/i);
});

test('provider command ordinal crash-retry state machine remains collision-free across 250k transitions', async () => {
  const { nextProviderCommandId } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const state = { saveId: 'stress-save', providerMutations: { nextCommandOrdinal: 1, providerCommitGeneration: 0, commandReceipts: [] } };
  const committed = new Set();
  for (let index = 0; index < 250_000; index += 1) {
    const before = structuredClone(state.providerMutations);
    const first = nextProviderCommandId(state, 'crash-stress');
    let finalId = first;
    if (index % 7 === 0) {
      state.providerMutations = before;
      finalId = nextProviderCommandId(state, 'crash-stress');
      assert.equal(finalId, first, 'retry after rollback must preserve the provider command id');
    }
    assert.equal(committed.has(finalId), false, `committed command id collision at transition ${index}`);
    committed.add(finalId);
  }
  assert.equal(committed.size, 250_000);
  assert.equal(state.providerMutations.nextCommandOrdinal, 250_001);
});

test('saved provider receipt prevents command replay after reload and provider reconstruction', async () => {
  const { provider, state } = await initial(9915);
  const { issueProviderCommandOnce } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const command = { id: 'game:test:reload-replay-guard', issuedTick: state.clock.worldTick, kind: 'external.trade', payload: { detail: 'reload replay guard' } };
  const first = await issueProviderCommandOnce(provider, state, command);
  assert.equal(first.replayed, false);
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  const reconstructed = new SnapshotWorldProvider(structuredClone(restored.world.providerSnapshot));
  const before = await reconstructed.exportSnapshot(2);
  const replay = await issueProviderCommandOnce(reconstructed, restored, command);
  const after = await reconstructed.exportSnapshot(2);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.causalRecords.length, before.causalRecords.length);
});

test('provider resynchronization from last committed snapshot supports clean continuation after uncertain advance', async () => {
  const { provider, state } = await initial(9916);
  const committed = structuredClone(state);
  const fault = {
    getManifest: (...args) => provider.getManifest(...args), getEntity: (...args) => provider.getEntity(...args), queryArea: (...args) => provider.queryArea(...args),
    getKnowledge: (...args) => provider.getKnowledge(...args), issueCommand: (...args) => provider.issueCommand(...args), exportSnapshot: (...args) => provider.exportSnapshot(...args),
    advance: async (request) => { await provider.advance(request); throw new Error('uncertain-after-advance'); },
  };
  await assert.rejects(() => advanceSandboxHours(fault, state, 6), /resynchronization/i);
  assert.deepEqual(state, committed);
  const reconstructed = new SnapshotWorldProvider(structuredClone(committed.world.providerSnapshot));
  await advanceSandboxHours(reconstructed, state, 6);
  assert.ok(state.clock.worldTick > committed.clock.worldTick);
  assert.equal((await reconstructed.getManifest()).currentTick, state.clock.worldTick);
  assert.equal(state.world.providerSnapshot.manifest.currentTick, state.clock.worldTick);
});

test('provider receipt retention compacts old ordinal details without permitting replay', async () => {
  const { provider, state } = await initial(9920);
  const { compactProviderCommandReceipts, issueProviderCommandOnce, isRetiredProviderCommand } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const tick = state.clock.worldTick;
  state.providerMutations = {
    nextCommandOrdinal: 301, providerCommitGeneration: 300,
    retiredThroughOrdinal: 0, retiredReceiptCount: 0, retiredAcceptedCount: 0, retiredRejectedCount: 0, retiredEventCount: 0, retiredCausalRecordCount: 0,
    commandReceipts: Array.from({ length: 300 }, (_, index) => {
      const ordinal = index + 1;
      return {
        commandId: `game:${state.saveId}:retention:${ordinal.toString(36).padStart(5, '0')}`,
        kind: 'external.diplomacy', issuedTick: tick, providerTick: tick, accepted: ordinal % 2 === 0,
        eventIds: [`event:${ordinal}`], causalRecordIds: [`cause:${ordinal}`],
      };
    }),
  };
  compactProviderCommandReceipts(state);
  assert.equal(state.providerMutations.commandReceipts.length, 256);
  assert.equal(state.providerMutations.retiredThroughOrdinal, 44);
  assert.equal(state.providerMutations.retiredReceiptCount, 44);
  assert.equal(state.providerMutations.retiredAcceptedCount, 22);
  assert.equal(state.providerMutations.retiredRejectedCount, 22);
  assert.equal(state.providerMutations.retiredEventCount, 44);
  assert.equal(state.providerMutations.retiredCausalRecordCount, 44);
  const oldId = `game:${state.saveId}:retention:${(1).toString(36).padStart(5, '0')}`;
  assert.equal(isRetiredProviderCommand(state, oldId), true);
  let calls = 0;
  const noReplayProvider = {
    getManifest: (...args) => provider.getManifest(...args), getEntity: (...args) => provider.getEntity(...args), queryArea: (...args) => provider.queryArea(...args),
    getKnowledge: (...args) => provider.getKnowledge(...args), advance: (...args) => provider.advance(...args), exportSnapshot: (...args) => provider.exportSnapshot(...args),
    issueCommand: async (...args) => { calls += 1; return provider.issueCommand(...args); },
  };
  const replay = await issueProviderCommandOnce(noReplayProvider, state, { id: oldId, issuedTick: tick, kind: 'external.diplomacy', payload: {} });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.accepted, false);
  assert.match(replay.result.reason ?? '', /replay was suppressed/i);
  assert.equal(calls, 0, 'compacted terminal command must never be delivered to provider again');
  const restored = importSandboxSave(sandboxRepository.exportJson(state));
  assert.equal(restored.providerMutations.retiredThroughOrdinal, 44);
  assert.equal(restored.providerMutations.commandReceipts.length, 256);
});

test('save generation rollback accepts only the direct cryptographic parent and supports repeated recovery branches', async () => {
  const { state } = await initial(9921);
  const { assertPreviousGenerationParent, buildSaveEnvelope, unwrapStoredSave } = await import('../.test-dist/sandbox/storage.js');
  const first = buildSaveEnvelope(state, null);
  state.settlement.resources.food += 1;
  const second = buildSaveEnvelope(state, first);
  assert.equal(assertPreviousGenerationParent(second, first).stateHash, first.stateHash);
  const corruptSecond = structuredClone(second); corruptSecond.state.settlement.resources.food += 0.5;
  assert.throws(() => unwrapStoredSave(corruptSecond), /checksum mismatch/i);
  assert.equal(assertPreviousGenerationParent(corruptSecond, first).stateHash, first.stateHash, 'corrupt HEAD may still identify its intact direct parent');

  const unrelatedState = structuredClone(first.state); unrelatedState.settlement.resources.food += 9;
  const unrelatedPrevious = buildSaveEnvelope(unrelatedState, null);
  assert.throws(() => assertPreviousGenerationParent(corruptSecond, unrelatedPrevious), /parentStateHash/i);

  // Simulate promote(previous)->HEAD, then save again. The next HEAD must form a fresh direct chain.
  const restoredHead = first;
  const resumedState = structuredClone(first.state); resumedState.settlement.resources.water += 2;
  const replacementSecond = buildSaveEnvelope(resumedState, restoredHead);
  assert.equal(assertPreviousGenerationParent(replacementSecond, restoredHead).stateHash, restoredHead.stateHash);
  resumedState.settlement.resources.medicine += 1;
  const third = buildSaveEnvelope(resumedState, replacementSecond);
  assert.equal(assertPreviousGenerationParent(third, replacementSecond).stateHash, replacementSecond.stateHash);
  assert.equal(third.revision, 3);
  assert.equal(third.commitGeneration, 3);
});

test('provider receipt retention remains bounded across 50k terminal commands', async () => {
  const { compactProviderCommandReceipts } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const state = {
    saveId: 'retention-stress',
    providerMutations: {
      nextCommandOrdinal: 1, providerCommitGeneration: 0,
      retiredThroughOrdinal: 0, retiredReceiptCount: 0, retiredAcceptedCount: 0, retiredRejectedCount: 0, retiredEventCount: 0, retiredCausalRecordCount: 0,
      commandReceipts: [],
    },
  };
  for (let ordinal = 1; ordinal <= 50_000; ordinal += 1) {
    state.providerMutations.nextCommandOrdinal = ordinal + 1;
    state.providerMutations.providerCommitGeneration += 1;
    state.providerMutations.commandReceipts.push({
      commandId: `game:${state.saveId}:stress:${ordinal.toString(36).padStart(5, '0')}`,
      kind: 'stress.command', issuedTick: 0, providerTick: 0, accepted: ordinal % 5 !== 0,
      eventIds: [`event:${ordinal}`], causalRecordIds: [`cause:${ordinal}`],
    });
    compactProviderCommandReceipts(state);
  }
  assert.equal(state.providerMutations.commandReceipts.length, 256);
  assert.equal(state.providerMutations.retiredThroughOrdinal, 49_744);
  assert.equal(state.providerMutations.retiredReceiptCount, 49_744);
  assert.equal(state.providerMutations.retiredAcceptedCount + state.providerMutations.retiredRejectedCount, 49_744);
  assert.equal(state.providerMutations.retiredEventCount, 49_744);
  assert.equal(state.providerMutations.retiredCausalRecordCount, 49_744);
  assert.ok(JSON.stringify(state.providerMutations).length < 100_000, 'journal serialization must remain bounded after 50k commands');
});

test('save generation chain survives 50k recovery-resave-restart transitions', async () => {
  const { assertPreviousGenerationParent, buildSaveEnvelope, unwrapStoredSave } = await import('../.test-dist/sandbox/storage.js');
  let head = null;
  let previous = null;
  const tinyState = { sequence: 0, marker: 'generation-stress' };
  let recoveries = 0;
  for (let index = 1; index <= 50_000; index += 1) {
    tinyState.sequence = index;
    const next = buildSaveEnvelope(tinyState, head);
    previous = head;
    head = next;
    if (index % 37 === 0 && previous) {
      const corrupt = structuredClone(head);
      corrupt.state.sequence += 0.5;
      assert.throws(() => unwrapStoredSave(corrupt), /checksum mismatch/i);
      assertPreviousGenerationParent(corrupt, previous);
      head = previous;
      previous = null;
      const resumed = { sequence: index, marker: 'generation-stress' };
      const replacement = buildSaveEnvelope(resumed, head);
      previous = head;
      head = replacement;
      assertPreviousGenerationParent(head, previous);
      recoveries += 1;
    }
    if (index % 101 === 0) {
      head = JSON.parse(JSON.stringify(head));
      if (previous) previous = JSON.parse(JSON.stringify(previous));
      unwrapStoredSave(head);
      if (previous) assertPreviousGenerationParent(head, previous);
    }
  }
  assert.ok(recoveries > 1_000);
  unwrapStoredSave(head);
  if (previous) assertPreviousGenerationParent(head, previous);
});

test('legacy detailed receipt journal migrates into bounded retention without replaying retired commands', async () => {
  const { provider, state } = await initial(9922);
  const { ensureProviderMutationJournal, issueProviderCommandOnce } = await import('../.test-dist/sandbox/providerMutationJournal.js');
  const tick = state.clock.worldTick;
  state.providerMutations = {
    nextCommandOrdinal: 401,
    providerCommitGeneration: 400,
    commandReceipts: Array.from({ length: 400 }, (_, index) => {
      const ordinal = index + 1;
      return {
        commandId: `game:${state.saveId}:legacy:${ordinal.toString(36).padStart(5, '0')}`,
        kind: 'legacy.command', issuedTick: tick, providerTick: tick, accepted: true,
        eventIds: [`event:${ordinal}`], causalRecordIds: [`cause:${ordinal}`],
      };
    }),
  };
  const journal = ensureProviderMutationJournal(state);
  assert.equal(journal.commandReceipts.length, 256);
  assert.equal(journal.retiredThroughOrdinal, 144);
  assert.equal(journal.retiredReceiptCount, 144);
  let deliveries = 0;
  const wrapped = {
    getManifest: (...args) => provider.getManifest(...args), getEntity: (...args) => provider.getEntity(...args), queryArea: (...args) => provider.queryArea(...args),
    getKnowledge: (...args) => provider.getKnowledge(...args), advance: (...args) => provider.advance(...args), exportSnapshot: (...args) => provider.exportSnapshot(...args),
    issueCommand: async (...args) => { deliveries += 1; return provider.issueCommand(...args); },
  };
  const oldId = `game:${state.saveId}:legacy:${(7).toString(36).padStart(5, '0')}`;
  const replay = await issueProviderCommandOnce(wrapped, state, { id: oldId, issuedTick: tick, kind: 'legacy.command', payload: {} });
  assert.equal(replay.replayed, true);
  assert.equal(deliveries, 0);
});

test('quarantine retention keeps recent raw evidence while compacting older forensic history', async () => {
  const { buildQuarantineRecord, compactQuarantineHistory } = await import('../.test-dist/sandbox/storage.js');
  const entries = [];
  for (let index = 0; index < 30; index += 1) {
    const capturedAt = new Date(Date.UTC(2026, 8, 9, 0, 0, index)).toISOString();
    const raw = { marker: index, payload: 'x'.repeat(1024) };
    entries.push({ key: `tdoc-descendants-sandbox-v1:quarantine:test:${index}`, value: buildQuarantineRecord(raw, `reason-${index}`, 'corrupt-active', capturedAt) });
  }
  const compacted = compactQuarantineHistory(entries);
  assert.equal(compacted.filter((entry) => !entry.delete).length, 24);
  assert.equal(compacted.filter((entry) => entry.delete).length, 6);
  const retained = compacted.filter((entry) => !entry.delete);
  assert.ok(retained.filter((entry) => entry.record.retained === 'full').length <= 4);
  assert.ok(retained.some((entry) => entry.record.retained === 'metadata-only'));
  assert.equal(retained[0].record.retained, 'full', 'newest quarantine must retain raw evidence even if large');
  assert.ok(!('raw' in retained.find((entry) => entry.record.retained === 'metadata-only').record));
});

test('legacy quarantine payloads normalize into forensic metadata and raw checksums', async () => {
  const { compactQuarantineHistory } = await import('../.test-dist/sandbox/storage.js');
  const legacy = { capturedAt: '2026-09-09T00:00:00.000Z', reason: 'legacy-corruption', raw: { bad: true, revision: 3 } };
  const result = compactQuarantineHistory([{ key: 'tdoc-descendants-sandbox-v1:quarantine:legacy:1', value: legacy }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].record.storageFormat, 'descendants-quarantine-v1');
  assert.equal(result[0].record.reason, 'legacy-corruption');
  assert.match(result[0].record.rawChecksum, /^[0-9a-f]{8}$/);
  assert.equal(result[0].record.retained, 'full');
});

test('save lineage forensic report exposes generation ancestry and quarantine compaction without hidden mutation', async () => {
  const { state } = await initial(9923);
  const { buildQuarantineRecord, buildSaveEnvelope, buildSaveLineageForensicReport } = await import('../.test-dist/sandbox/storage.js');
  const first = buildSaveEnvelope(state, null);
  state.settlement.resources.food += 2;
  const second = buildSaveEnvelope(state, first);
  const quarantines = Array.from({ length: 6 }, (_, index) => ({
    key: `tdoc-descendants-sandbox-v1:quarantine:forensic:${index}`,
    value: buildQuarantineRecord({ broken: index }, `failure-${index}`, index % 2 ? 'generation-rollback' : 'corrupt-active', new Date(Date.UTC(2026, 8, 9, 1, 0, index)).toISOString()),
  }));
  const report = buildSaveLineageForensicReport({ activeRaw: second, previousRaw: first, quarantineEntries: quarantines, generatedAt: '2026-09-09T02:00:00.000Z' });
  assert.equal(report.schema, 'descendants-save-lineage-forensic-v1');
  assert.equal(report.active.valid, true);
  assert.equal(report.previous.valid, true);
  assert.equal(report.previous.directParentOfActive, true);
  assert.equal(report.quarantine.length, 6);
  assert.ok(report.quarantine.some((entry) => entry.retained === 'metadata-only'));
  assert.ok(report.issues.some((entry) => /metadata-only/i.test(entry)));
  assert.equal(second.state.settlement.resources.food, state.settlement.resources.food);
});


test('expedition readiness blocks wounded or exhausted members before supplies are consumed', async () => {
  const { state } = await initial(2609091);
  const doctrine = state.doctrines[0];
  const adult = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(adult);
  const foodBefore = state.settlement.resources.food;
  adult.health = 45;
  let readiness = expeditionMemberReadiness(adult, doctrine);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.minimumHealth >= 60);
  assert.match(readiness.reasons.join(' '), /HP 45 < launch minimum/);
  assert.throws(() => launchExpedition(state, {
    leaderId: adult.id,
    memberIds: [adult.id],
    controlMode: 'expedition',
    doctrineId: doctrine.id,
  }), /not fit to depart.*HP 45 < launch minimum/);
  assert.equal(state.settlement.resources.food, foodBefore);
  assert.equal(adult.expeditionId, null);

  adult.health = 90;
  adult.fatigue = 80;
  readiness = expeditionMemberReadiness(adult, doctrine);
  assert.equal(readiness.ready, false);
  assert.match(readiness.reasons.join(' '), /fatigue 80 > launch maximum 70/);
});

test('seriously injured local residents seek care and rest instead of returning to ordinary labor', async () => {
  const { provider, state } = await initial(2609092);
  const adult = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(adult);
  adult.health = 48;
  adult.fatigue = 10;
  state.settlement.clinicCapacity = 0;
  await advanceSandboxHours(provider, state, 1);
  assert.equal(adult.currentPlan?.kind, 'seek-care');
  assert.match(adult.currentPlan?.reason ?? '', /health below safe working threshold/);
  assert.equal(adult.currentTask, 'rest');
});

test('direct clinic care improves an injured local resident and reserves canonical clinic time', async () => {
  const { state } = await initial(2609093);
  const patient = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(patient);
  patient.health = 40;
  const medicineBefore = state.settlement.resources.medicine;
  const startMinute = (state.clock.day - 1) * 1440 + state.clock.minuteOfDay;
  const result = requestDirectClinicCare(state, patient.id, 60);
  assert.equal(result.healthBefore, 40);
  assert.ok(result.healthAfter > result.healthBefore);
  assert.ok(state.settlement.resources.medicine <= medicineBefore);
  assert.ok(medicineBefore - state.settlement.resources.medicine <= 0.25 + 1e-9);
  const reservation = state.directPlay.directActivities.find((entry) => entry.kind === 'clinic' && entry.agentIds.includes(patient.id));
  assert.ok(reservation);
  assert.equal(reservation.startAbsoluteMinute, startMinute);
  assert.equal(reservation.endAbsoluteMinute - reservation.startAbsoluteMinute, 60);
  assert.ok(reservation.agentIds.includes(result.medicId));
});


test('assembly considers each labor priority at most once per canonical day', async () => {
  const { state } = await initial(2609094);
  const task = 'repair';
  assert.equal(laborPriorityProposalAvailability(state, task).allowed, true);
  const first = proposeLaborPriority(state, task, 1);
  assert.ok(first.status === 'accepted' || first.status === 'rejected');
  assert.equal(laborPriorityProposalAvailability(state, task).allowed, false);
  const proposalCount = state.policyProposals.length;
  assert.throws(() => proposeLaborPriority(state, task, 1), /already considered by the assembly/);
  assert.equal(state.policyProposals.length, proposalCount);
  state.clock.day += 1;
  assert.equal(laborPriorityProposalAvailability(state, task).allowed, true);
  const nextDay = proposeLaborPriority(state, task, -1);
  assert.equal(nextDay.day, state.clock.day);
});


test('assembly votes persist resident political preference and social memory for later deliberation', async () => {
  const { state } = await initial(2609101);
  const task = 'guard';
  const proposal = proposeLaborPriority(state, task, 1);
  const voterId = proposal.supporterIds[0] ?? proposal.opponentIds[0];
  const voter = state.agents.find((entry) => entry.id === voterId);
  assert.ok(voter);
  const supported = proposal.supporterIds.includes(voter.id);
  const expectedPreference = supported ? 1 : -1;
  assert.equal(voter.experience[`assembly:preference:${task}`], expectedPreference);
  assert.equal(assemblyPreferenceSignal(voter, task, 1), expectedPreference);
  assert.equal(assemblyPreferenceSignal(voter, task, -1), -expectedPreference);
  const memory = voter.memories.find((entry) => entry.kind === 'social' && entry.sourceIds.includes(proposal.id));
  assert.ok(memory);
  assert.match(memory.text, supported ? /supported increasing guard/ : /opposed increasing guard/);
  state.clock.day += 1;
  const second = proposeLaborPriority(state, task, 1);
  const secondSupported = second.supporterIds.includes(voter.id);
  assert.equal(voter.experience[`assembly:preference:${task}`], expectedPreference + (secondSupported ? 1 : -1));
});

test('assembly political memory remains inertia rather than an immutable voting lock after canonical state change', async () => {
  let switchedTotal = 0;
  let voterTotal = 0;
  for (const seed of [2609200, 2609201, 2609202, 2609203, 2609204, 2609205, 2609206, 2609207]) {
    const { provider, state } = await initial(seed);
    const first = proposeLaborPriority(state, 'guard', 1);
    const firstSupport = new Set(first.supporterIds);
    await advanceSandboxDays(provider, state, 1);
    const second = proposeLaborPriority(state, 'guard', 1);
    const secondSupport = new Set(second.supporterIds);
    const voters = [...new Set([...first.supporterIds, ...first.opponentIds])];
    switchedTotal += voters.filter((id) => firstSupport.has(id) !== secondSupport.has(id)).length;
    voterTotal += voters.length;
  }
  assert.ok(switchedTotal > 0, 'canonical day changes should be able to overcome remembered prior stance for marginal voters across a deterministic seed sample');
  assert.ok(switchedTotal < voterTotal / 4, 'political memory should still preserve broad coalition continuity rather than creating high-volatility voting');
});

test('accepted aggregate migration materializes persisted lived residents and a local household without inventing provider identities', async () => {
  const { provider, state } = await initial(2609100);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  const beforeAgents = state.agents.length;
  const beforeHouseholds = state.settlement.households.length;
  const outcome = await issueExternalAction(provider, state, { kind: 'migration', targetEntityId: target.entityId, detail: 'Negotiate actual settlement movement rather than an abstract balance.' });
  assert.equal(outcome.result.accepted, true);
  assert.ok(state.agents.length > beforeAgents);
  assert.equal(state.settlement.households.length, beforeHouseholds + 1);
  const migrants = state.agents.slice(beforeAgents);
  assert.ok(migrants.length >= 1);
  assert.ok(migrants.every((entry) => entry.identityOrigin === 'lived-game-state'));
  assert.ok(migrants.every((entry) => !entry.worldEntityId && !entry.identityAnchorId));
  assert.ok(migrants.every((entry) => entry.profileAuthority?.identity === 'lived-game-state'));
  assert.ok(migrants.every((entry) => entry.affiliationIds?.includes(target.entityId)));
  assert.ok(migrants.every((entry) => entry.memories.some((memory) => memory.kind === 'social' && memory.sourceIds.includes(target.entityId))));
  const migrantHousehold = state.settlement.households.at(-1);
  assert.ok(migrantHousehold);
  assert.deepEqual(new Set(migrantHousehold.memberIds), new Set(migrants.map((entry) => entry.id)));
  assert.equal(target.migrationBalance, migrants.length);
  const restored = importSandboxSave(JSON.stringify(state));
  for (const migrant of migrants) assert.ok(restored.agents.some((entry) => entry.id === migrant.id && entry.householdId === migrant.householdId));
  assert.ok(restored.settlement.households.some((entry) => entry.id === migrantHousehold.id));
  await advanceSandboxDays(provider, state, 1);
  assert.ok(migrants.some((migrant) => Object.entries(migrant.experience).some(([task,hours]) => ['forage','water','medicine','repair','sanitation','care','records','guard','explore-prep'].includes(task) && hours > 0)), 'migrants performed ordinary work over the simulated days');
  assert.ok(state.chronicle.some((entry) => entry.kind === 'external' && entry.title === 'migration instruction accepted' && entry.text.includes('arrived')));
});

test('provider-confirmed migration anchors only an explicitly named stable individual and persists mixed authority across reload', async () => {
  const { provider: base, state } = await initial(2609105);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  target.localTrust = 50;
  const candidate = {
    id: 'individual:river-market:migrant:01',
    kind: 'individual',
    spatial: structuredClone(state.settlement.position),
    components: {
      name: 'Ilya River', identityAnchorId: 'identity:river-market:migrant:01', roles: ['scout'], sampleWeight: 1,
    },
    provenanceIds: ['prov:river-market:migrant:01'],
  };
  const provider = migrationEvidenceProvider(base, candidate, 'explicit');
  const before = state.agents.length;
  const outcome = await issueExternalAction(provider, state, { kind: 'migration', targetEntityId: target.entityId, detail: 'Provider explicitly confirms one stable individual moved into the settlement.' });
  assert.equal(outcome.result.accepted, true);
  const anchored = state.agents.find((entry) => entry.id === candidate.id);
  assert.ok(anchored, 'explicit provider migration evidence should materialize the named stable individual');
  assert.equal(anchored.identityOrigin, 'world-provider');
  assert.equal(anchored.worldEntityId, candidate.id);
  assert.equal(anchored.identityAnchorId, candidate.components.identityAnchorId);
  assert.equal(anchored.profileAuthority?.identity, 'provider-projected');
  assert.equal(anchored.profileAuthority?.household, 'lived-game-state');
  assert.equal(anchored.name, 'Ilya River');
  assert.ok(outcome.result.eventIds.every((id) => anchored.materializationProvenanceIds?.includes(id)));
  const household = state.settlement.households.find((entry) => entry.id === anchored.householdId);
  assert.ok(household);
  assert.equal(household.worldEntityId, undefined, 'individual migration evidence must not imply provider-confirmed household migration');
  assert.ok(state.agents.slice(before).some((entry) => entry.identityOrigin === 'world-provider'));
  const restored = importSandboxSave(JSON.stringify(state));
  const restoredAnchored = restored.agents.find((entry) => entry.id === candidate.id);
  assert.ok(restoredAnchored);
  assert.equal(restoredAnchored.identityOrigin, 'world-provider');
  assert.equal(restoredAnchored.worldEntityId, candidate.id);
  assert.equal(restoredAnchored.identityAnchorId, candidate.components.identityAnchorId);
  assert.equal(restoredAnchored.profileAuthority?.household, 'lived-game-state');
});

test('fine-detail visibility or migration-event participation alone never upgrades a migrant to provider identity authority', async () => {
  const { provider: base, state } = await initial(2609106);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  target.localTrust = 50;
  const candidate = {
    id: 'individual:river-market:visible-only:01',
    kind: 'individual',
    spatial: structuredClone(state.settlement.position),
    components: {
      name: 'Visible Only', identityAnchorId: 'identity:river-market:visible-only:01', roles: ['member'], sampleWeight: 1,
    },
    provenanceIds: ['prov:river-market:visible-only:01'],
  };
  target.fineActorIds = [candidate.id];
  const provider = migrationEvidenceProvider(base, candidate, 'participant-only');
  const before = state.agents.length;
  const outcome = await issueExternalAction(provider, state, { kind: 'migration', targetEntityId: target.entityId, detail: 'A visible external individual participates in negotiation but is not explicitly recorded as moving.' });
  assert.equal(outcome.result.accepted, true);
  assert.equal(state.agents.some((entry) => entry.id === candidate.id), false, 'visibility/participation is not migration evidence');
  const arrivals = state.agents.slice(before);
  assert.ok(arrivals.length > 0);
  assert.ok(arrivals.every((entry) => entry.identityOrigin === 'lived-game-state'));
  assert.ok(arrivals.every((entry) => !entry.worldEntityId && !entry.identityAnchorId));
});

test('negotiated migration respects local housing capacity instead of materializing invisible overcrowding', async () => {
  const { provider, state } = await initial(2609101);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  state.settlement.housingCapacity = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement').length;
  const beforeAgents = state.agents.length;
  const beforeHouseholds = state.settlement.households.length;
  const outcome = await issueExternalAction(provider, state, { kind: 'migration', targetEntityId: target.entityId, detail: 'Negotiate movement while local housing is full.' });
  assert.equal(outcome.result.accepted, true);
  assert.equal(state.agents.length, beforeAgents);
  assert.equal(state.settlement.households.length, beforeHouseholds);
  assert.equal(target.migrationBalance, 0);
  assert.match(state.chronicle.at(-1)?.text ?? '', /no local housing capacity remained/);
});

test('migrant residents remain ordinary persisted settlement participants across canonical days', async () => {
  const { provider, state } = await initial(2609103);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  const before = state.agents.length;
  await issueExternalAction(provider, state, { kind: 'migration', targetEntityId: target.entityId, detail: 'Admit negotiated arrivals into ordinary settlement life.' });
  const migrants = state.agents.slice(before);
  assert.ok(migrants.length > 0);
  const ids = new Set(migrants.map((entry) => entry.id));
  await advanceSandboxDays(provider, state, 5);
  assert.ok(migrants.every((migrant) => state.agents.some((entry) => entry.id === migrant.id && entry.alive && entry.residence === 'settlement')));
  assert.ok(migrants.some((migrant) => Object.entries(migrant.experience).some(([task,hours]) => ['forage','water','medicine','repair','sanitation','care','records','guard','explore-prep'].includes(task) && hours > 0)), 'migrants performed ordinary work over the simulated days');
  assert.ok(state.settlement.households.some((household) => household.memberIds.some((id) => ids.has(id))));
  const restored = importSandboxSave(JSON.stringify(state));
  assert.ok(migrants.every((migrant) => restored.agents.some((entry) => entry.id === migrant.id && entry.identityOrigin === 'lived-game-state')));
});

test('daily negotiated migration remains bounded by known source population and local housing over 30 canonical days', async () => {
  const { provider, state } = await initial(27001);
  const { externalActionAvailability, issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  for (let day = 0; day < 30; day += 1) {
    const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
    assert.ok(target);
    if (externalActionAvailability(state, 'migration', target.entityId).allowed) {
      const result = await issueExternalAction(provider, state, { kind: 'migration', targetEntityId: target.entityId, detail: 'Thirty-day migration stability regression.' });
      assert.equal(result.result.accepted, true);
    }
    await advanceSandboxHours(provider, state, 24);
  }
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market');
  assert.ok(target);
  assert.ok(target.population === null || target.migrationBalance <= target.population);
  const local = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement');
  assert.ok(local.length <= state.settlement.housingCapacity + 1);
  assert.ok(local.length < 90, 'daily migration must not become a 30-day population explosion');
  assert.ok(state.settlement.resources.food > 100 && state.settlement.resources.water > 100);
  assert.ok(state.agents.filter((entry) => !entry.alive).length < 3);
});

test('external relationship actions have kind-specific canonical cooldowns instead of zero-friction repetition', async () => {
  const { provider, state } = await initial(2609095);
  const { externalActionAvailability, issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  const action = await issueExternalAction(provider, state, { kind: 'diplomacy', targetEntityId: target.entityId, detail: 'First diplomatic contact.' });
  assert.equal(action.result.accepted, true);
  let availability = externalActionAvailability(state, 'diplomacy', target.entityId);
  assert.equal(availability.allowed, false);
  assert.equal(availability.remainingMinutes, 720);
  await assert.rejects(() => issueExternalAction(provider, state, { kind: 'diplomacy', targetEntityId: target.entityId, detail: 'Immediate repeat.' }), /needs 720 more canonical minute/);
  await advanceSandboxHours(provider, state, 11);
  availability = externalActionAvailability(state, 'diplomacy', target.entityId);
  assert.equal(availability.allowed, false);
  assert.equal(availability.remainingMinutes, 60);
  await advanceSandboxHours(provider, state, 1);
  availability = externalActionAvailability(state, 'diplomacy', target.entityId);
  assert.equal(availability.allowed, true);
});



test('accepted conflict command does not invent physical harm from its own command payload', async () => {
  const { provider, state } = await initial(2609110);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const victim = state.agents.find((entry) => entry.alive && entry.residence === 'settlement');
  assert.ok(target && victim);
  const beforeHealth = victim.health;
  const outcome = await issueExternalAction(provider, state, {
    kind: 'conflict', targetEntityId: target.entityId, detail: 'Issue a conflict intervention without provider-observed physical aftermath.',
    payload: { observedConflictKind: 'violence', conflictSeverity: 95, injuredIndividualIds: victim.id },
  });
  assert.equal(outcome.result.accepted, true);
  assert.equal((state.externalConflictObservations ?? []).length, 0, 'command/intervention echoes are not physical observation evidence');
  assert.equal(victim.health, beforeHealth);
  assert.equal(victim.pathology.some((entry) => entry.pathologyId === 'traumatic-wound'), false);
  assert.match(state.chronicle.at(-1)?.text ?? '', /No provider-observed physical consequence was asserted/);
});

test('provider-observed conflict evidence persists and injures only explicitly named local residents', async () => {
  const { provider: base, state } = await initial(2609111);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const victim = state.agents.find((entry) => entry.alive && entry.residence === 'settlement');
  const bystander = state.agents.find((entry) => entry.alive && entry.residence === 'settlement' && entry.id !== victim?.id);
  assert.ok(target && victim && bystander);
  const beforeVictim = victim.health; const beforeBystander = bystander.health;
  const provider = conflictEvidenceProvider(base, {
    observedConflictKind: 'violence', conflictSeverity: 78,
    injuredIndividualIds: [victim.id, 'individual:not-local:01'],
    displacedIndividualIds: [], affectedRouteEntityIds: ['landmark:relay-tower-17'],
  });
  const outcome = await issueExternalAction(provider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Provider later exposes a concrete observed violent aftermath.' });
  assert.equal(outcome.result.accepted, true);
  assert.equal(state.externalConflictObservations?.length, 1);
  const observation = state.externalConflictObservations?.[0]; assert.ok(observation);
  assert.equal(observation.kind, 'violence'); assert.equal(observation.severity, 78);
  assert.ok(observation.providerSourceId.startsWith('provider:observed-conflict:'));
  assert.ok(observation.affectedRouteEntityIds.includes('landmark:relay-tower-17'));
  assert.ok(victim.health < beforeVictim);
  assert.equal(bystander.health, beforeBystander, 'unreported local residents must not be selected as synthetic victims');
  const wound = victim.pathology.find((entry) => entry.pathologyId === 'traumatic-wound' && entry.status === 'active');
  assert.ok(wound); assert.ok(wound.suspectedCauses.includes(observation.providerSourceId));
  const visible = synthesizeVisibleSituations(state);
  const signal = visible.find((entry) => entry.id === `external-observed-conflict:${observation.id}`);
  assert.ok(signal); assert.match(signal.title, /Provider-observed external violence/); assert.equal(signal.severity, 'urgent');
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.externalConflictObservations?.[0]?.providerSourceId, observation.providerSourceId);
  assert.ok(restored.agents.find((entry) => entry.id === victim.id)?.pathology.some((entry) => entry.suspectedCauses.includes(observation.providerSourceId)));
});



test('QA13 provider conflict ingestion preserves explicit route passability without deriving it from severity', async () => {
  const { provider: base, state } = await initial(2609136);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  const provider = conflictEvidenceProvider(base, {
    observedConflictKind: 'route-disruption', conflictSeverity: 1,
    injuredIndividualIds: [], displacedIndividualIds: [],
    affectedRouteEntityIds: ['relation:road-origin-relay'], routePassability: 'impassable',
  });
  const outcome = await issueExternalAction(provider, state, {
    kind: 'conflict', targetEntityId: target.entityId,
    detail: 'Provider explicitly reports one route as impassable despite low conflict severity.',
  });
  assert.equal(outcome.result.accepted, true);
  const observation = state.externalConflictObservations?.at(-1);
  assert.ok(observation);
  assert.equal(observation.kind, 'route-disruption');
  assert.equal(observation.severity, 1);
  assert.equal(observation.routePassability, 'impassable');
  assert.deepEqual(observation.affectedRouteEntityIds, ['relation:road-origin-relay']);
  const evidenceChronicle = state.chronicle.findLast((entry) => entry.title === 'Provider-observed external route-disruption');
  assert.match(evidenceChronicle?.text ?? '', /Explicit route passability: impassable/);
});

test('provider-observed displacement and resource loss affect only explicitly reported local state', async () => {
  const { provider: base, state } = await initial(2609113);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const displaced = state.agents.find((entry) => entry.alive && entry.residence === 'settlement');
  const untouched = state.agents.find((entry) => entry.alive && entry.residence === 'settlement' && entry.id !== displaced?.id);
  assert.ok(target && displaced && untouched);
  const beforeFood = state.settlement.resources.food; const beforeWater = state.settlement.resources.water;
  const provider = conflictEvidenceProvider(base, {
    observedConflictKind: 'displacement', conflictSeverity: 64,
    injuredIndividualIds: [], displacedIndividualIds: [displaced.id, 'individual:not-local:02'], affectedRouteEntityIds: [],
    settlementResourceLoss: { food: 17, water: 11 },
  });
  await issueExternalAction(provider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Provider exposes explicit displacement and stock loss aftermath.' });
  assert.equal(displaced.residence, 'unknown');
  assert.equal(untouched.residence, 'settlement');
  assert.equal(state.settlement.resources.food, beforeFood - 17);
  assert.equal(state.settlement.resources.water, beforeWater - 11);
  assert.deepEqual(state.externalConflictObservations?.[0]?.resourceLoss, { food: 17, water: 11 });
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.agents.find((entry) => entry.id === displaced.id)?.residence, 'unknown');
  assert.deepEqual(restored.externalConflictObservations?.[0]?.resourceLoss, { food: 17, water: 11 });
});



test('provider-observed displacement does not silently resolve through time passage alone', async () => {
  const { provider: base, state } = await initial(2609114);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const displaced = state.agents.find((entry) => entry.alive && entry.residence === 'settlement');
  assert.ok(target && displaced);
  const provider = conflictEvidenceProvider(base, {
    observedConflictKind: 'displacement', conflictSeverity: 62,
    injuredIndividualIds: [], displacedIndividualIds: [displaced.id], affectedRouteEntityIds: [],
  });
  await issueExternalAction(provider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Observe explicit displacement.' });
  assert.equal(displaced.residence, 'unknown');
  await advanceSandboxDays(provider, state, 5);
  assert.equal(displaced.residence, 'unknown', 'canonical time passage must not invent a return observation');
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  const signal = synthesizeVisibleSituations(state).find((entry) => entry.id === 'settlement:displaced-residents');
  assert.ok(signal); assert.match(signal.title, /remain displaced/i);
});

test('accepted diplomacy payload cannot self-assert that a displaced resident returned', async () => {
  const { provider: base, state } = await initial(2609115);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const displaced = state.agents.find((entry) => entry.alive && entry.residence === 'settlement');
  assert.ok(target && displaced);
  const provider = conflictEvidenceProvider(base, {
    observedConflictKind: 'displacement', conflictSeverity: 60,
    injuredIndividualIds: [], displacedIndividualIds: [displaced.id], affectedRouteEntityIds: [],
  });
  await issueExternalAction(provider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Displace a named resident through provider observation.' });
  assert.equal(displaced.residence, 'unknown');
  await issueExternalAction(provider, state, {
    kind: 'diplomacy', targetEntityId: target.entityId, detail: 'Claim a return without provider observation.',
    payload: { observedConflictKind: 'recovery', returnedToSettlementIndividualIds: [displaced.id] },
  });
  assert.equal(displaced.residence, 'unknown', 'command/intervention payload is not provider-observed recovery evidence');
  assert.equal((state.externalConflictObservations ?? []).filter((entry) => entry.kind === 'recovery').length, 0);
});

test('provider-observed recovery restores only explicitly named displaced local residents and persists across reload', async () => {
  const { provider: base, state } = await initial(2609116);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const locals = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement').slice(0, 2);
  assert.ok(target && locals.length === 2);
  const displacementProvider = conflictEvidenceProvider(base, {
    observedConflictKind: 'displacement', conflictSeverity: 68,
    injuredIndividualIds: [], displacedIndividualIds: locals.map((entry) => entry.id), affectedRouteEntityIds: [],
  });
  await issueExternalAction(displacementProvider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Two named residents are explicitly displaced.' });
  assert.ok(locals.every((entry) => entry.residence === 'unknown'));
  const provider = recoveryEvidenceProvider(displacementProvider, [locals[0].id, 'individual:not-local:return']);
  await issueExternalAction(provider, state, { kind: 'diplomacy', targetEntityId: target.entityId, detail: 'Provider reports one explicit return.' });
  assert.equal(locals[0].residence, 'settlement');
  assert.equal(locals[1].residence, 'unknown', 'unreported displaced residents must remain unresolved');
  assert.equal(Number(locals[0].experience['displacement:return-day']), state.clock.day);
  const recovery = (state.externalConflictObservations ?? []).find((entry) => entry.kind === 'recovery');
  assert.ok(recovery); assert.deepEqual(recovery.returnedToSettlementIndividualIds, [locals[0].id, 'individual:not-local:return']);
  assert.ok(state.chronicle.some((entry) => entry.title.includes('returned after observed displacement') && entry.entityIds.includes(locals[0].id)));
  const visible = synthesizeVisibleSituations(state);
  assert.ok(visible.some((entry) => entry.id === 'settlement:displacement-returns'));
  assert.ok(visible.some((entry) => entry.id === 'settlement:displaced-residents'), 'the second unresolved person remains visible');
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.agents.find((entry) => entry.id === locals[0].id)?.residence, 'settlement');
  assert.equal(restored.agents.find((entry) => entry.id === locals[1].id)?.residence, 'unknown');
  assert.deepEqual(restored.externalConflictObservations?.find((entry) => entry.kind === 'recovery')?.returnedToSettlementIndividualIds, [locals[0].id, 'individual:not-local:return']);
});


test('QA11 individual displacement evidence never upgrades the containing household to household displacement', async () => {
  const { provider: base, state } = await initial(2609117);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const displaced = state.agents.find((entry) => entry.alive && entry.residence === 'settlement');
  const household = displaced && state.settlement.households.find((entry) => entry.id === displaced.householdId);
  assert.ok(target && displaced && household);
  const provider = conflictEvidenceProvider(base, {
    observedConflictKind: 'displacement', conflictSeverity: 61,
    injuredIndividualIds: [], displacedIndividualIds: [displaced.id], affectedRouteEntityIds: [],
  });
  await issueExternalAction(provider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Provider names one displaced person, not a household.' });
  assert.equal(displaced.residence, 'unknown');
  assert.equal(household.displacement, undefined, 'one individual ID must never imply household movement');
  const otherMembers = household.memberIds.map((id) => state.agents.find((entry) => entry.id === id)).filter((entry) => entry && entry.id !== displaced.id && entry.alive);
  assert.ok(otherMembers.every((entry) => entry.residence === 'settlement'), 'unnamed household members remain physically where they were');
});

test('QA11 provider-explicit household displacement moves only currently local members and persists the episode', async () => {
  const { provider: base, state } = await initial(2609118);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const household = state.settlement.households.find((entry) => entry.memberIds.length >= 2);
  assert.ok(target && household);
  const members = household.memberIds.map((id) => state.agents.find((entry) => entry.id === id)).filter(Boolean);
  assert.ok(members.length >= 2);
  const away = members[0];
  away.residence = 'external';
  const expectedMoved = members.filter((entry) => entry.residence === 'settlement').map((entry) => entry.id);
  const provider = conflictEvidenceProvider(base, {
    observedConflictKind: 'displacement', conflictSeverity: 73,
    injuredIndividualIds: [], displacedIndividualIds: [], displacedHouseholdIds: [household.id], affectedRouteEntityIds: [],
  });
  await issueExternalAction(provider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Provider explicitly names a local household displacement.' });
  assert.equal(away.residence, 'external', 'a member already away in a known state must not be teleported');
  assert.ok(expectedMoved.every((id) => state.agents.find((entry) => entry.id === id)?.residence === 'unknown'));
  assert.equal(household.displacement?.status, 'displaced');
  assert.deepEqual(household.displacement?.displacedMemberIds, expectedMoved);
  assert.ok(synthesizeVisibleSituations(state).some((entry) => entry.id === 'settlement:displaced-households'));
  const observation = (state.externalConflictObservations ?? []).find((entry) => entry.kind === 'displacement');
  assert.deepEqual(observation?.displacedHouseholdIds, [household.id]);
  const restored = importSandboxSave(JSON.stringify(state));
  const restoredHousehold = restored.settlement.households.find((entry) => entry.id === household.id);
  assert.equal(restoredHousehold?.displacement?.status, 'displaced');
  assert.deepEqual(restoredHousehold?.displacement?.displacedMemberIds, expectedMoved);
});

test('QA11 provider-explicit household recovery closes only a prior household episode and returns only episode members still unknown', async () => {
  const { provider: base, state } = await initial(2609119);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const household = state.settlement.households.find((entry) => entry.memberIds.length >= 2);
  assert.ok(target && household);
  const displacementProvider = conflictEvidenceProvider(base, {
    observedConflictKind: 'displacement', conflictSeverity: 70,
    injuredIndividualIds: [], displacedIndividualIds: [], displacedHouseholdIds: [household.id], affectedRouteEntityIds: [],
  });
  await issueExternalAction(displacementProvider, state, { kind: 'conflict', targetEntityId: target.entityId, detail: 'Explicit household displacement.' });
  const episodeMembers = [...(household.displacement?.displacedMemberIds ?? [])];
  assert.ok(episodeMembers.length >= 2);
  const independentlyKnownAway = state.agents.find((entry) => entry.id === episodeMembers[0]);
  assert.ok(independentlyKnownAway);
  independentlyKnownAway.residence = 'external';
  const provider = recoveryEvidenceProvider(displacementProvider, [], [household.id]);
  await issueExternalAction(provider, state, { kind: 'diplomacy', targetEntityId: target.entityId, detail: 'Provider explicitly reports household return.' });
  assert.equal(household.displacement?.status, 'returned');
  assert.equal(independentlyKnownAway.residence, 'external', 'household recovery must not teleport a member from another known physical state');
  for (const id of episodeMembers.slice(1)) assert.equal(state.agents.find((entry) => entry.id === id)?.residence, 'settlement');
  assert.ok(synthesizeVisibleSituations(state).some((entry) => entry.id === 'settlement:household-displacement-returns'));
  const recovery = (state.externalConflictObservations ?? []).find((entry) => entry.kind === 'recovery');
  assert.deepEqual(recovery?.returnedToSettlementHouseholdIds, [household.id]);
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.settlement.households.find((entry) => entry.id === household.id)?.displacement?.status, 'returned');
});

test('QA11 household recovery evidence without a prior provider-explicit household displacement does not move a household', async () => {
  const { provider: base, state } = await initial(2609120);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(base, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  const household = state.settlement.households.find((entry) => entry.memberIds.length >= 1);
  assert.ok(target && household);
  const before = household.memberIds.map((id) => [id, state.agents.find((entry) => entry.id === id)?.residence]);
  const provider = recoveryEvidenceProvider(base, [], [household.id]);
  await issueExternalAction(provider, state, { kind: 'diplomacy', targetEntityId: target.entityId, detail: 'A household return is observed without a tracked household displacement episode.' });
  assert.equal(household.displacement, undefined);
  assert.deepEqual(household.memberIds.map((id) => [id, state.agents.find((entry) => entry.id === id)?.residence]), before);
});

test('provider-observed route disruption adds risk only to an expedition explicitly targeting the affected route entity', async () => {
  const { state } = await initial(2609112);
  const { expeditionObservedRouteConflictRisk } = await import('../.test-dist/sandbox/externalConflictSimulation.js');
  const members = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement').slice(0, 3);
  assert.equal(members.length, 3);
  const expedition = {
    id: 'expedition:route-risk:test', leaderId: members[0].id, memberIds: members.map((entry) => entry.id), controlMode: 'settlement', doctrineId: state.doctrines[0].id,
    status: 'outbound', position: structuredClone(state.settlement.position), destination: null, departureDay: state.clock.day, departureMinute: state.clock.minuteOfDay,
    returnDay: null, communication: 'connected', silentHours: 0, supplies: { food: 20, water: 30, medicine: 2, tools: 2 },
    orders: [{ id: 'order:route-risk:test', kind: 'move', issuedDay: state.clock.day, issuedMinute: state.clock.minuteOfDay, issuerId: state.settlement.leaderId, detail: 'Use observed route.', epistemicBasisIds: [], unfounded: false, completed: false, targetEntityId: 'landmark:relay-tower-17' }],
    observations: [], discoveredEntityIds: [], rescueOfExpeditionId: null, missingReason: '',
  };
  state.externalConflictObservations = [{
    id: 'external-conflict:test', sourceEntityId: 'settlement:river-market', providerSourceId: 'provider:event:route-disruption', providerTick: state.clock.worldTick,
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'route-disruption', severity: 80,
    injuredIndividualIds: [], displacedIndividualIds: [], affectedRouteEntityIds: ['landmark:relay-tower-17'], resourceLoss: {}, provenanceIds: ['provider:event:route-disruption'],
  }];
  assert.ok(expeditionObservedRouteConflictRisk(state, expedition) > 0);
  expedition.orders[0].targetEntityId = 'landmark:unaffected-route';
  assert.equal(expeditionObservedRouteConflictRisk(state, expedition), 0);
  state.clock.day += 8;
  expedition.orders[0].targetEntityId = 'landmark:relay-tower-17';
  assert.equal(expeditionObservedRouteConflictRisk(state, expedition), 0, 'stale observations stop affecting current route hazard');
});

test('direct and known-route plans to the same destination have different distance and route-specific conflict risk', async () => {
  const { state } = await initial(2609121);
  const { expeditionObservedRouteConflictRisk } = await import('../.test-dist/sandbox/externalConflictSimulation.js');
  const adults = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement' && entry.role !== 'child').slice(0, 3);
  assert.equal(adults.length, 3);
  const destination = { ...state.settlement.position, x: state.settlement.position.x + 8, y: state.settlement.position.y };
  const routeWaypoint = { ...state.settlement.position, x: state.settlement.position.x + 3, y: state.settlement.position.y + 4 };
  const ample = { food: 50, water: 70, medicine: 2, tools: 2 };
  const direct = expeditionSupplyReadiness(state, adults.map((entry) => entry.id), destination, 'normal', ample);
  const via = expeditionSupplyReadiness(state, adults.map((entry) => entry.id), destination, 'normal', ample, routeWaypoint);
  assert.ok(via.estimatedOutboundHours > direct.estimatedOutboundHours);
  assert.ok(via.minimumFood > direct.minimumFood);
  assert.ok(via.minimumWater > direct.minimumWater);

  state.externalConflictObservations = [{
    id: 'external-conflict:route-choice:test', sourceEntityId: 'settlement:river-market', providerSourceId: 'provider:event:route-choice', providerTick: state.clock.worldTick,
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'route-disruption', severity: 82,
    injuredIndividualIds: [], displacedIndividualIds: [], returnedToSettlementIndividualIds: [], affectedRouteEntityIds: ['terrain:old-service-road'], resourceLoss: {}, provenanceIds: ['provider:event:route-choice'],
  }];
  const base = {
    id: 'expedition:route-choice:test', leaderId: adults[0].id, memberIds: adults.map((entry) => entry.id), controlMode: 'settlement', doctrineId: state.doctrines[0].id,
    status: 'outbound', position: structuredClone(state.settlement.position), destination: structuredClone(destination), destinationEntityId: 'landmark:relay-tower',
    departureDay: state.clock.day, departureMinute: state.clock.minuteOfDay, returnDay: null, communication: 'connected', silentHours: 0, supplies: structuredClone(ample),
    orders: [], observations: [], discoveredEntityIds: [], rescueOfExpeditionId: null, missingReason: '',
  };
  assert.equal(expeditionObservedRouteConflictRisk(state, base), 0, 'direct travel should not inherit disruption attached only to an optional route waypoint');
  const routed = { ...base, id: 'expedition:route-choice:routed', routeEntityId: 'terrain:old-service-road', routeWaypoint: structuredClone(routeWaypoint), routeWaypointReached: false };
  assert.ok(expeditionObservedRouteConflictRisk(state, routed) > 0, 'choosing the explicitly disrupted route must add provider-evidenced hazard');
});

test('launched known-route plan persists its waypoint and physically reaches it before the final destination', async () => {
  const { provider, state } = await initial(2609122);
  const adults = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement' && entry.role !== 'child').sort((a,b)=>b.skills.scouting-a.skills.scouting).slice(0, 3);
  assert.equal(adults.length, 3);
  const routeWaypoint = { ...state.settlement.position, x: state.settlement.position.x + 3, y: state.settlement.position.y + 4 };
  const destination = { ...state.settlement.position, x: state.settlement.position.x + 8, y: state.settlement.position.y };
  const expedition = launchExpedition(state, {
    leaderId: adults[0].id, memberIds: adults.map((entry) => entry.id), controlMode: 'settlement', doctrineId: state.doctrines[0].id,
    destination, targetEntityId: 'landmark:relay-tower', routeEntityId: 'terrain:old-service-road', routeWaypoint, pace: 'normal',
    supplies: { food: 50, water: 70, medicine: 2, tools: 2 },
  });
  assert.equal(expedition.routeEntityId, 'terrain:old-service-road');
  assert.deepEqual(expedition.routeWaypoint, routeWaypoint);
  assert.equal(expedition.routeWaypointReached, false);
  const restoredBeforeTravel = importSandboxSave(JSON.stringify(state));
  const restoredExpedition = restoredBeforeTravel.expeditions.find((entry) => entry.id === expedition.id);
  assert.equal(restoredExpedition?.routeEntityId, 'terrain:old-service-road');
  assert.deepEqual(restoredExpedition?.routeWaypoint, routeWaypoint);

  const plan = expeditionSupplyReadiness(state, adults.map((entry) => entry.id), destination, 'normal', { food: 50, water: 70, medicine: 2, tools: 2 }, routeWaypoint);
  assert.ok(plan.estimatedOutboundHours < 6, 'fixture expects the full via route to fit inside one six-hour canonical interval');
  await advanceSandboxHours(provider, state, 6);
  assert.ok(state.chronicle.some((entry) => entry.title === 'Route waypoint reached' && entry.entityIds.includes('terrain:old-service-road')), 'the chosen route waypoint must be physically reached before destination arrival');
  assert.equal(expedition.status, 'exploring', 'unused movement time after reaching the waypoint must continue toward the final destination');
  assert.ok(Math.hypot(expedition.position.x - destination.x, expedition.position.y - destination.y) < 0.3);
  assert.equal(expedition.routeEntityId, undefined, 'completed outbound route metadata is cleared once the destination is reached');
  assert.equal(expedition.routeWaypoint, undefined);
  assert.equal(expedition.routeWaypointReached, undefined);
});


test('QA12 provider-visible topology returns deterministic k-shortest loopless alternatives and ignores relations with unknown endpoints', async () => {
  const { providerVisibleRouteAlternatives } = await import('../.test-dist/sandbox/routePlanning.js');
  const spatial = (x, y) => ({ frameId: 'world', x, y });
  const visible = [
    { id: 'settlement:origin', kind: 'settlement', spatial: spatial(0,0), components: {}, provenanceIds: ['p:o'] },
    { id: 'settlement:a', kind: 'settlement', spatial: spatial(3,0), components: {}, provenanceIds: ['p:a'] },
    { id: 'settlement:b', kind: 'settlement', spatial: spatial(0,4), components: {}, provenanceIds: ['p:b'] },
    { id: 'settlement:target', kind: 'settlement', spatial: spatial(6,4), components: {}, provenanceIds: ['p:t'] },
  ];
  const projection = {
    tick: 0, effectiveDetailRank: 2, entities: [...visible, { id: 'settlement:hidden', kind: 'settlement', spatial: spatial(1,1), components: {}, provenanceIds: ['p:h'] }],
    relations: [
      { id: 'route:o-a', kind: 'route-link', sourceId: 'settlement:origin', targetId: 'settlement:a', data: { distanceKm: 3 }, provenanceIds: ['p:r1'] },
      { id: 'route:a-t', kind: 'route-link', sourceId: 'settlement:a', targetId: 'settlement:target', data: { distanceKm: 5 }, provenanceIds: ['p:r2'] },
      { id: 'route:o-b', kind: 'route-link', sourceId: 'settlement:origin', targetId: 'settlement:b', data: { distanceKm: 4 }, provenanceIds: ['p:r3'] },
      { id: 'route:b-t', kind: 'route-link', sourceId: 'settlement:b', targetId: 'settlement:target', data: { distanceKm: 6 }, provenanceIds: ['p:r4'] },
      { id: 'route:a-b', kind: 'route-link', sourceId: 'settlement:a', targetId: 'settlement:b', data: { distanceKm: 2 }, provenanceIds: ['p:r5'] },
      { id: 'route:hidden-shortcut-1', kind: 'route-link', sourceId: 'settlement:origin', targetId: 'settlement:hidden', data: { distanceKm: .5 }, provenanceIds: ['p:h1'] },
      { id: 'route:hidden-shortcut-2', kind: 'route-link', sourceId: 'settlement:hidden', targetId: 'settlement:target', data: { distanceKm: .5 }, provenanceIds: ['p:h2'] },
    ], aggregates: {}, observationIds: [],
  };
  const first = providerVisibleRouteAlternatives(projection, visible, 'settlement:origin', 'settlement:target', 3);
  const second = providerVisibleRouteAlternatives(structuredClone(projection), structuredClone(visible), 'settlement:origin', 'settlement:target', 3);
  assert.deepEqual(second, first, 'route alternative ordering must be deterministic');
  assert.equal(first.length, 3);
  assert.deepEqual(first[0].nodeEntityIds, ['settlement:origin','settlement:a','settlement:target']);
  assert.equal(first[0].distanceKm, 8);
  assert.equal(first[0].stretchFromShortest, 1);
  assert.equal(first[0].overlapWithShortest, 1);
  assert.ok(first.every((route) => new Set(route.nodeEntityIds).size === route.nodeEntityIds.length), 'all alternatives are loopless');
  assert.ok(first.every((route) => !route.nodeEntityIds.includes('settlement:hidden')), 'unknown endpoint relations must never enter the known route graph');
  assert.ok(first.slice(1).every((route) => route.distanceKm >= first[0].distanceKm));
  assert.ok(first.some((route) => route.overlapWithShortest < 1), 'at least one alternative exposes meaningful divergence from the shortest path');
});

test('QA12 connects relation is usable only when its explicit visible route entity is also known', async () => {
  const { providerVisibleRouteAlternatives } = await import('../.test-dist/sandbox/routePlanning.js');
  const origin = { id: 'settlement:origin', kind: 'settlement', spatial: { frameId:'world', x:0, y:0 }, components:{}, provenanceIds:['p:o'] };
  const target = { id: 'landmark:target', kind: 'landmark', spatial: { frameId:'world', x:8, y:0 }, components:{}, provenanceIds:['p:t'] };
  const route = { id: 'terrain:known-road', kind: 'route', spatial: { frameId:'world', x:4, y:2 }, components:{ name:'Known Road' }, provenanceIds:['p:r'] };
  const relation = { id: 'relation:known-road', kind: 'connects', sourceId: origin.id, targetId: target.id, data: { routeId: route.id }, provenanceIds:['p:r'] };
  const projection = { tick:0, effectiveDetailRank:2, entities:[origin,target,route], relations:[relation], aggregates:{}, observationIds:[] };
  assert.deepEqual(providerVisibleRouteAlternatives(projection, [origin,target], origin.id, target.id, 3), [], 'relation data cannot reveal an otherwise unknown route entity');
  const alternatives = providerVisibleRouteAlternatives(projection, [origin,target,route], origin.id, target.id, 3);
  assert.equal(alternatives.length, 1);
  assert.deepEqual(alternatives[0].evidenceIds, [relation.id, route.id]);
  assert.deepEqual(alternatives[0].waypointEntityIds, [route.id]);
  assert.deepEqual(alternatives[0].waypoints, [route.spatial]);
});

test('QA12 selected topology evidence affects route-disruption risk without contaminating another alternative', async () => {
  const { state } = await initial(2609123);
  const { expeditionObservedRouteConflictRisk } = await import('../.test-dist/sandbox/externalConflictSimulation.js');
  const adults = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement' && entry.role !== 'child').slice(0, 2);
  const base = {
    id:'expedition:qa12:risk', leaderId:adults[0].id, memberIds:adults.map((entry)=>entry.id), controlMode:'settlement', doctrineId:state.doctrines[0].id,
    status:'outbound', position:structuredClone(state.settlement.position), destination:{...state.settlement.position,x:state.settlement.position.x+6}, destinationEntityId:'landmark:qa12-target',
    departureDay:state.clock.day, departureMinute:state.clock.minuteOfDay, returnDay:null, communication:'connected', silentHours:0,
    supplies:{food:20,water:30,medicine:2,tools:2}, orders:[], observations:[], discoveredEntityIds:[], rescueOfExpeditionId:null, missingReason:'',
  };
  state.externalConflictObservations = [{
    id:'external-conflict:qa12:route', sourceEntityId:'settlement:river-market', providerSourceId:'provider:event:qa12-route', providerTick:state.clock.worldTick,
    day:state.clock.day, minuteOfDay:state.clock.minuteOfDay, kind:'route-disruption', severity:90, injuredIndividualIds:[], displacedIndividualIds:[],
    affectedRouteEntityIds:['route-link:danger'], resourceLoss:{}, provenanceIds:['provider:event:qa12-route'],
  }];
  const safe = { ...base, id:'expedition:qa12:safe', routePlan:{ kind:'provider-topology', nodeEntityIds:['settlement:origin','settlement:safe','landmark:qa12-target'], relationIds:['route-link:safe-a','route-link:safe-b'], evidenceIds:['route-link:safe-a','route-link:safe-b'], waypointEntityIds:[], waypoints:[], currentWaypointIndex:0, plannedDistanceKm:7 } };
  const danger = { ...base, id:'expedition:qa12:danger', routePlan:{ kind:'provider-topology', nodeEntityIds:['settlement:origin','settlement:danger','landmark:qa12-target'], relationIds:['route-link:danger','route-link:danger-b'], evidenceIds:['route-link:danger','route-link:danger-b'], waypointEntityIds:[], waypoints:[], currentWaypointIndex:0, plannedDistanceKm:7 } };
  assert.equal(expeditionObservedRouteConflictRisk(state, safe), 0);
  assert.ok(expeditionObservedRouteConflictRisk(state, danger) > 0);
});

test('QA12 multi-waypoint provider topology persists and is physically traversed in order before destination arrival', async () => {
  const { provider, state } = await initial(2609124);
  const adults = state.agents.filter((entry) => entry.alive && entry.residence === 'settlement' && entry.role !== 'child').sort((a,b)=>b.skills.scouting-a.skills.scouting).slice(0, 3);
  const a = { ...state.settlement.position, x: state.settlement.position.x + 2 };
  const b = { ...state.settlement.position, x: state.settlement.position.x + 4 };
  const destination = { ...state.settlement.position, x: state.settlement.position.x + 6 };
  const expedition = launchExpedition(state, {
    leaderId: adults[0].id, memberIds: adults.map((entry)=>entry.id), controlMode:'settlement', doctrineId:state.doctrines[0].id,
    destination, targetEntityId:'landmark:qa12-target', pace:'normal', supplies:{food:50,water:70,medicine:2,tools:2},
    routePlan:{ kind:'provider-topology', nodeEntityIds:['settlement:origin','settlement:a','settlement:b','landmark:qa12-target'], relationIds:['route:o-a','route:a-b','route:b-t'], evidenceIds:['route:o-a','route:a-b','route:b-t'], waypointEntityIds:['settlement:a','settlement:b'], waypoints:[a,b], plannedDistanceKm:6 },
  });
  assert.equal(expedition.routePlan?.currentWaypointIndex, 0);
  const restored = importSandboxSave(JSON.stringify(state));
  assert.equal(restored.expeditions.find((entry)=>entry.id===expedition.id)?.routePlan?.currentWaypointIndex, 0);
  await advanceSandboxHours(provider, state, 6);
  const reached = state.chronicle.filter((entry)=>entry.title==='Provider topology waypoint reached' && entry.entityIds.includes(expedition.id));
  assert.equal(reached.length, 2);
  assert.ok(reached[0].entityIds.includes('settlement:a'));
  assert.ok(reached[1].entityIds.includes('settlement:b'));
  assert.equal(expedition.status, 'exploring');
  assert.equal(expedition.routePlan, undefined, 'route plan clears only after physical destination arrival');
  assert.ok(Math.hypot(expedition.position.x-destination.x, expedition.position.y-destination.y) < .3);
});

test('QA12 multi-day integration preserves supply, provider-bounded route choice, conflict, migration, household displacement/recovery and trauma recovery together', async () => {
  const { provider: base, state } = await initial(2609126);
  const { providerVisibleRouteAlternatives } = await import('../.test-dist/sandbox/routePlanning.js');
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  const { expeditionObservedRouteConflictRisk } = await import('../.test-dist/sandbox/externalConflictSimulation.js');

  await advanceSandboxHours(base, state, 6);
  const targetActor = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(targetActor);
  targetActor.localTrust = 50;

  const projection = await base.queryArea({
    center: structuredClone(state.settlement.position), radiusKm: 24, requestedDetailRank: 2,
    observerId: state.world.originEntityId, includeKnowledgeProjection: true,
  });
  const knownIds = new Set([state.world.originEntityId, 'terrain:old-service-road', 'landmark:relay-tower']);
  const visible = projection.entities.filter((entry) => knownIds.has(entry.id));
  const routes = providerVisibleRouteAlternatives(projection, visible, state.world.originEntityId, 'landmark:relay-tower', 3);
  assert.equal(routes.length, 1, 'mock fixture exposes exactly one provider-visible topology route to the relay');
  const selected = routes[0];
  assert.ok(selected.evidenceIds.includes('relation:road-origin-relay'));

  const displacementHousehold = state.settlement.households.find((entry) => entry.memberIds.length >= 2);
  assert.ok(displacementHousehold);
  const displacedIds = new Set(displacementHousehold.memberIds);
  const victim = state.agents.find((entry) => entry.alive && entry.residence === 'settlement' && entry.role !== 'child' && !displacedIds.has(entry.id));
  assert.ok(victim);
  const crew = state.agents
    .filter((entry) => entry.alive && entry.residence === 'settlement' && entry.role !== 'child' && !displacedIds.has(entry.id) && entry.id !== victim.id)
    .sort((a,b) => b.skills.scouting - a.skills.scouting)
    .slice(0, 3);
  assert.ok(crew.length >= 1);
  const destinationEntity = await base.getEntity('landmark:relay-tower');
  assert.ok(destinationEntity?.spatial);
  const expedition = launchExpedition(state, {
    leaderId: crew[0].id, memberIds: crew.map((entry) => entry.id), controlMode: 'settlement', doctrineId: state.doctrines[0].id,
    destination: structuredClone(destinationEntity.spatial), targetEntityId: destinationEntity.id, pace: 'normal',
    supplies: { food: 50, water: 70, medicine: 2, tools: 2 },
    routePlan: {
      kind: selected.kind, nodeEntityIds: [...selected.nodeEntityIds], relationIds: [...selected.relationIds], evidenceIds: [...selected.evidenceIds],
      waypointEntityIds: [...selected.waypointEntityIds], waypoints: structuredClone(selected.waypoints), plannedDistanceKm: selected.distanceKm,
    },
  });
  const initialFieldFood = expedition.supplies.food;
  const initialFieldWater = expedition.supplies.water;

  const conflictProvider = conflictEvidenceProvider(base, {
    observedConflictKind: 'route-disruption', conflictSeverity: 72,
    injuredIndividualIds: [victim.id], displacedIndividualIds: [], displacedHouseholdIds: [displacementHousehold.id],
    affectedRouteEntityIds: ['relation:road-origin-relay'], settlementResourceLoss: { food: 3, water: 2 },
  });
  const migrantCandidate = {
    id: 'individual:river-market:qa12-integrated-migrant', kind: 'individual', spatial: structuredClone(state.settlement.position),
    components: { name: 'QA12 River Migrant', identityAnchorId: 'identity:river-market:qa12-integrated-migrant', roles: ['scout'], sampleWeight: 1 },
    provenanceIds: ['prov:river-market:qa12-integrated-migrant'],
  };
  const activeProvider = migrationEvidenceProvider(conflictProvider, migrantCandidate, 'explicit');

  const conflict = await issueExternalAction(activeProvider, state, {
    kind: 'conflict', targetEntityId: targetActor.entityId, detail: 'QA12 integrated provider-observed conflict aftermath.',
  });
  assert.equal(conflict.result.accepted, true);
  assert.equal(displacementHousehold.displacement?.status, 'displaced');
  assert.ok((displacementHousehold.displacement?.displacedMemberIds.length ?? 0) >= 2);
  assert.ok(displacementHousehold.displacement.displacedMemberIds.every((id) => state.agents.find((entry) => entry.id === id)?.residence === 'unknown'));
  const wound = victim.pathology.find((entry) => entry.pathologyId === 'traumatic-wound' && entry.status === 'active');
  assert.ok(wound, 'provider-observed injury must be represented as explicit trauma');
  const routeRisk = expeditionObservedRouteConflictRisk(state, expedition);
  assert.ok(routeRisk > 0, 'selected topology relation must receive only provider-observed route disruption risk');

  const traumaBeforeCare = wound.severity;
  requestDirectClinicCare(state, victim.id, 60);
  const traumaAfterCare = victim.pathology.find((entry) => entry.id === wound.id)?.severity ?? traumaBeforeCare;
  assert.ok(traumaAfterCare < traumaBeforeCare, 'direct care must materially reduce the explicit traumatic wound');

  const migration = await issueExternalAction(activeProvider, state, {
    kind: 'migration', targetEntityId: targetActor.entityId, detail: 'QA12 explicit individual migration while other systems remain active.',
  });
  assert.equal(migration.result.accepted, true);
  const migrant = state.agents.find((entry) => entry.id === migrantCandidate.id);
  assert.ok(migrant);
  assert.equal(migrant.identityOrigin, 'world-provider');
  assert.equal(migrant.profileAuthority?.household, 'lived-game-state');

  await advanceSandboxDays(activeProvider, state, 2);
  assert.ok(state.chronicle.some((entry) => entry.title === 'Provider topology waypoint reached' && entry.entityIds.some((id) => selected.evidenceIds.includes(id))), 'the selected provider-visible topology must be physically traversed');
  assert.ok(expedition.supplies.food < initialFieldFood || expedition.supplies.water < initialFieldWater, 'multi-day field movement must consume finite expedition supply');
  assert.ok(expedition.supplies.food >= 0 && expedition.supplies.water >= 0, 'field supply cannot become negative');
  const traumaAfterTime = victim.pathology.find((entry) => entry.id === wound.id)?.severity ?? 0;
  assert.ok(traumaAfterTime <= traumaAfterCare, 'canonical time must not reverse trauma recovery without new evidence');
  assert.equal(displacementHousehold.displacement?.status, 'displaced', 'time passage alone must not fabricate household recovery');

  const recoveryProvider = recoveryEvidenceProvider(activeProvider, [], [displacementHousehold.id]);
  const recovery = await issueExternalAction(recoveryProvider, state, {
    kind: 'diplomacy', targetEntityId: targetActor.entityId, detail: 'QA12 provider explicitly reports the displaced household return.',
  });
  assert.equal(recovery.result.accepted, true);
  assert.equal(displacementHousehold.displacement?.status, 'returned');
  assert.ok(displacementHousehold.displacement.displacedMemberIds.every((id) => state.agents.find((entry) => entry.id === id)?.residence === 'settlement'));

  const restored = importSandboxSave(JSON.stringify(state));
  assert.ok(restored.agents.some((entry) => entry.id === migrantCandidate.id && entry.identityOrigin === 'world-provider'));
  assert.equal(restored.settlement.households.find((entry) => entry.id === displacementHousehold.id)?.displacement?.status, 'returned');
  assert.ok((restored.externalConflictObservations ?? []).some((entry) => entry.affectedRouteEntityIds.includes('relation:road-origin-relay')));
  assert.ok(restored.agents.find((entry) => entry.id === victim.id)?.pathology.some((entry) => entry.id === wound.id));
});

test('known external conflict pressure increases autonomous guard demand and becomes a visible settlement situation', async () => {
  const { state } = await initial(2609102);
  const adult = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(adult);
  const baseline = agentTaskScore(state, adult, 'guard');
  state.externalActors.push({ entityId: 'settlement:pressure:test', provenanceIds: ['prov:pressure:test'], kind: 'settlement', name: 'Pressure Test Enclave', population: 20, position: { ...state.settlement.position, x: state.settlement.position.x + 4 }, lastObservedTick: state.clock.worldTick, confidence: .9, disposition: null, localTrust: -30, tradeExperience: 0, migrationBalance: 0, conflictPressure: 72 });
  const pressured = agentTaskScore(state, adult, 'guard');
  assert.ok(pressured >= baseline + 2.9);
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  const signal = synthesizeVisibleSituations(state).find((entry) => entry.id === 'external-pressure:settlement:pressure:test');
  assert.ok(signal);
  assert.equal(signal.severity, 'urgent');
  assert.match(signal.title, /external conflict pressure is high/);
  assert.match(signal.detail, /increases autonomous guard demand/);
});

test('WEDO damage becomes an explicit traumatic wound with encounter provenance and trauma memory', async () => {
  const { state } = await initial(2609098);
  const { createEncounter, buildEncounterQueue, resolveEncounterRound } = await import('../.test-dist/sandbox/encounterSimulation.js');
  const adult = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(adult);
  const preHealth = adult.health;
  const expedition = launchExpedition(state, { leaderId: adult.id, memberIds: [adult.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id });
  const encounter = createEncounter(state, expedition, 'defend', 1);
  const actor = encounter.actors.find((entry) => entry.agentId === adult.id);
  assert.ok(actor);
  actor.health = Math.max(12, preHealth - 42);
  encounter.log = Array.from({ length: 60 }, (_, index) => `forced resolution ${index}`);
  encounter.queue = buildEncounterQueue(state, encounter);
  resolveEncounterRound(state, encounter.id);
  const wound = adult.pathology.find((entry) => entry.pathologyId === 'traumatic-wound' && entry.status === 'active');
  assert.ok(wound);
  assert.ok(wound.severity >= 40);
  assert.ok(wound.suspectedCauses.includes(encounter.id));
  assert.ok(wound.suspectedCauses.includes(expedition.id));
  assert.ok(wound.observedSymptoms.length > 0);
  assert.ok(adult.memories.some((memory) => memory.kind === 'trauma' && memory.sourceIds.includes(encounter.id)));
  assert.equal(expeditionMemberReadiness(adult, state.doctrines[0]).ready, false);
});

test('clinic care treats traumatic wound severity as well as observed HP', async () => {
  const { state } = await initial(2609099);
  const patient = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(patient);
  patient.health = 45;
  patient.pathology.push({ id: 'case:test-trauma', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 58, contagious: false, observedSymptoms: ['deep wound / mobility impairment'], suspectedCauses: ['encounter:test'], treatmentsTried: [], status: 'active' });
  const medicineBefore = state.settlement.resources.medicine;
  const result = requestDirectClinicCare(state, patient.id, 60);
  const wound = patient.pathology.find((entry) => entry.id === 'case:test-trauma');
  assert.ok(result.pathology);
  assert.equal(result.pathology.severityBefore, 58);
  assert.ok((wound?.severity ?? 58) < 58);
  assert.ok(patient.health >= 47, `expected direct trauma stabilization to have a visible HP effect, got ${patient.health}`);
  assert.ok(state.settlement.resources.medicine <= medicineBefore);
});

test('traumatic wounds heal over canonical settlement time while still blocking premature expedition launch', async () => {
  const { provider, state } = await initial(2609100);
  const patient = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(patient);
  patient.health = 75;
  patient.fatigue = 10;
  patient.pathology.push({ id: 'case:test-healing-trauma', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 48, contagious: false, observedSymptoms: ['open wound / heavy bruising'], suspectedCauses: ['encounter:test-healing'], treatmentsTried: [], status: 'active' });
  state.settlement.clinicCapacity = 0;
  const doctrine = state.doctrines[0];
  assert.equal(expeditionMemberReadiness(patient, doctrine).ready, false);
  const before = patient.pathology.find((entry) => entry.id === 'case:test-healing-trauma')?.severity ?? 0;
  await advanceSandboxHours(provider, state, 24);
  const after = patient.pathology.find((entry) => entry.id === 'case:test-healing-trauma')?.severity ?? 0;
  assert.ok(after < before, `expected wound severity to heal over canonical time: ${before} -> ${after}`);
});

test('wound infection is linked to an existing traumatic wound rather than appearing as a generic contamination disease', async () => {
  const { provider, state } = await initial(2609101);
  state.settlement.clinicCapacity = 0;
  state.settlement.sanitation = 0;
  state.settlement.waterSafety = 0;
  await advanceSandboxDays(provider, state, 14);
  assert.equal(state.agents.some((agent) => agent.pathology.some((entry) => entry.pathologyId === 'wound-infection')), false);
});

test('settlement situation synthesis distinguishes traumatic injury from illness', async () => {
  const { state } = await initial(2609102);
  const { synthesizeVisibleSituations } = await import('../.test-dist/sandbox/situationSynthesis.js');
  const patient = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(patient);
  patient.pathology.push({ id: 'case:situation-trauma', pathologyId: 'traumatic-wound', onsetDay: state.clock.day, severity: 64, contagious: false, observedSymptoms: ['deep wound'], suspectedCauses: ['encounter:situation'], treatmentsTried: [], status: 'active' });
  const signals = synthesizeVisibleSituations(state);
  const injury = signals.find((entry) => entry.id === 'settlement:injury');
  assert.ok(injury);
  assert.equal(injury.severity, 'urgent');
  assert.match(injury.title, /injury/i);
  assert.equal(signals.some((entry) => entry.id === 'settlement:pathology' && /illness/i.test(entry.title)), false);
  patient.pathology.push({ id: 'case:situation-fever', pathologyId: 'respiratory-illness', onsetDay: state.clock.day, severity: 22, contagious: true, observedSymptoms: ['cough'], suspectedCauses: [], treatmentsTried: [], status: 'active' });
  const mixed = synthesizeVisibleSituations(state);
  assert.ok(mixed.some((entry) => entry.id === 'settlement:injury'));
  assert.ok(mixed.some((entry) => entry.id === 'settlement:pathology' && /illness/i.test(entry.title)));
});

test('specialist stock production saturates around practical medicine records and scrap reserves over 30 canonical days', async () => {
  const { provider, state } = await initial(24680);
  await advanceSandboxDays(provider, state, 30);
  assert.ok(state.settlement.resources.medicine >= 35 && state.settlement.resources.medicine <= 52, `medicine reserve drifted to ${state.settlement.resources.medicine}`);
  assert.ok(state.settlement.resources.records >= 24 && state.settlement.resources.records <= 45, `records reserve drifted to ${state.settlement.resources.records}`);
  assert.ok(state.settlement.resources.scrap >= 36 && state.settlement.resources.scrap <= 65, `scrap reserve drifted to ${state.settlement.resources.scrap}`);
});

test('repeated trade cannot mint large local-value gains when external inventory is not explicitly simulated', async () => {
  const { provider, state } = await initial(707070);
  const { issueExternalAction } = await import('../.test-dist/sandbox/externalActions.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  const unit = { food: 8, water: 12, medicine: 0.8, timber: 5, scrap: 4, fuel: 4, cloth: 3 };
  const lotValue = () => Object.entries(unit).reduce((sum, [key, amount]) => sum + state.settlement.resources[key] / amount, 0);
  const before = lotValue();
  for (let index = 0; index < 10; index += 1) {
    const outcome = await issueExternalAction(provider, state, { kind: 'trade', targetEntityId: target.entityId, detail: `valuation probe ${index}` });
    assert.equal(outcome.result.accepted, true);
    const absolute = (state.clock.day - 1) * 1440 + state.clock.minuteOfDay + 360;
    state.clock.day = Math.floor(absolute / 1440) + 1;
    state.clock.minuteOfDay = absolute % 1440;
  }
  const after = lotValue();
  assert.ok(after - before <= 1.5, `ten trades created ${(after - before).toFixed(2)} local-value lots without external stock accounting`);
});

test('daily trade over 30 canonical days reallocates surplus without runaway settlement stockpiles', async () => {
  const { provider, state } = await initial(707070);
  const { issueExternalAction, externalActionAvailability } = await import('../.test-dist/sandbox/externalActions.js');
  const { reserveDirectActivity } = await import('../.test-dist/sandbox/directPlay.js');
  await advanceSandboxHours(provider, state, 6);
  const target = state.externalActors.find((entry) => entry.entityId === 'settlement:river-market') ?? state.externalActors[0];
  assert.ok(target);
  for (let day = 0; day < 30; day += 1) {
    const actor = state.agents.find((entry) => entry.id === state.settlement.leaderId);
    assert.ok(actor);
    assert.equal(externalActionAvailability(state, 'trade', target.entityId).allowed, true);
    reserveDirectActivity(state, [actor.id], 'external', 120, 'daily resource-economy regression trade', target.entityId);
    await advanceSandboxHours(provider, state, 2);
    const result = await issueExternalAction(provider, state, { kind: 'trade', targetEntityId: target.entityId, actorId: actor.id, detail: 'Daily resource-economy regression exchange.' });
    assert.equal(result.result.accepted, true);
    await advanceSandboxHours(provider, state, 22);
  }
  const r = state.settlement.resources;
  assert.equal(state.agents.filter((entry) => entry.alive).length, 40);
  assert.ok(r.food < 800 && r.water < 900 && r.medicine < 60 && r.records < 55 && r.scrap < 70);
  assert.ok(r.timber < 125 && r.fuel < 85 && r.cloth < 60, `trade target convergence failed: ${JSON.stringify({ timber: r.timber, fuel: r.fuel, cloth: r.cloth })}`);
});


test('expedition launch rejects food/water loadouts that cannot cover the selected WORLD target plus emergency reserve', async () => {
  const { state } = await initial(2609094);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  assert.equal(adults.length, 3);
  const target = { ...state.settlement.position, x: state.settlement.position.x + 18 };
  const supplies = { food: 0.5, water: 0.5, medicine: 1, tools: 1 };
  const readiness = expeditionSupplyReadiness(state, adults.map((entry) => entry.id), target, 'normal', supplies);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.minimumFood > supplies.food);
  assert.ok(readiness.minimumWater > supplies.water);
  const before = structuredClone(state.settlement.resources);
  assert.throws(() => launchExpedition(state, {
    leaderId: adults[0].id,
    memberIds: adults.map((entry) => entry.id),
    controlMode: 'expedition',
    doctrineId: state.doctrines[0].id,
    destination: target,
    supplies,
  }), /loadout is not field-sufficient.*outbound reserve/);
  assert.deepEqual(state.settlement.resources, before, 'failed launch must not consume settlement stock');
});

test('field supply reserve turns an under-provisioned expedition home before food or water reaches zero', async () => {
  const { provider, state } = await initial(2609095);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').sort((a,b)=>b.skills.scouting-a.skills.scouting).slice(0, 3);
  assert.equal(adults.length, 3);
  const target = { ...state.settlement.position, x: state.settlement.position.x + 50 };
  const pace = 'normal';
  const probe = expeditionSupplyReadiness(state, adults.map((entry) => entry.id), target, pace, { food: 999, water: 999, medicine: 1, tools: 1 });
  const supplies = { food: probe.minimumFood * 1.04, water: probe.minimumWater * 1.04, medicine: 1, tools: 1 };
  const expedition = launchExpedition(state, {
    leaderId: adults[0].id, memberIds: adults.map((entry) => entry.id), controlMode: 'expedition',
    doctrineId: state.doctrines[0].id, destination: target, supplies, pace,
  });
  for (let step = 0; step < 20 && expedition.status === 'outbound'; step += 1) await advanceSandboxHours(provider, state, 1);
  assert.equal(expedition.status, 'returning');
  assert.ok(expedition.supplies.food > 0 && expedition.supplies.water > 0, 'turnback must occur before depletion');
  assert.ok(state.chronicle.some((entry) => entry.title === 'Supply reserve turnback' && entry.entityIds.includes(expedition.id)));
});


test('expedition launch protects a doctrine-scaled settlement food/water reserve from oversized loadouts', async () => {
  const { state } = await initial(2609096);
  const adults = state.agents.filter((entry) => entry.alive && entry.role !== 'child').slice(0, 3);
  assert.equal(adults.length, 3);
  const doctrine = state.doctrines[0];
  const target = { ...state.settlement.position, x: state.settlement.position.x + 6 };
  const supplies = {
    food: Math.max(1, state.settlement.resources.food - 30),
    water: Math.max(1, state.settlement.resources.water - 30),
    medicine: 1, tools: 1,
  };
  const field = expeditionSupplyReadiness(state, adults.map((entry)=>entry.id), target, 'normal', supplies);
  assert.equal(field.ready, true, 'oversized loadout should be ample for the party itself');
  const reserve = settlementSupplyReserveReadiness(state, supplies, doctrine);
  assert.equal(reserve.ready, false);
  assert.ok(reserve.remainingFoodDays < reserve.minimumReserveDays || reserve.remainingWaterDays < reserve.minimumReserveDays);
  const before = structuredClone(state.settlement.resources);
  assert.throws(() => launchExpedition(state, {
    leaderId: adults[0].id, memberIds: adults.map((entry)=>entry.id), controlMode: 'expedition',
    doctrineId: doctrine.id, destination: target, supplies,
  }), /breach settlement reserve/);
  assert.deepEqual(state.settlement.resources, before);
});

test('initial WORLD launch preserves target entity identity so provider-observed route disruption affects outbound risk across save/reload', async () => {
  const { state } = await initial(2609115);
  const { expeditionObservedRouteConflictRisk } = await import('../.test-dist/sandbox/externalConflictSimulation.js');
  const adult = state.agents.find((entry) => entry.alive && entry.role !== 'child');
  assert.ok(adult);
  const targetEntityId = 'landmark:relay-tower';
  const destination = { ...state.settlement.position, x: state.settlement.position.x + 2 };
  state.externalConflictObservations = [{
    id: 'external-conflict:initial-route:test', sourceEntityId: 'settlement:river-market', providerSourceId: 'provider:event:initial-route', providerTick: state.clock.worldTick,
    day: state.clock.day, minuteOfDay: state.clock.minuteOfDay, kind: 'route-disruption', severity: 80,
    injuredIndividualIds: [], displacedIndividualIds: [], returnedToSettlementIndividualIds: [], affectedRouteEntityIds: [targetEntityId], resourceLoss: {}, provenanceIds: ['provider:event:initial-route'],
  }];
  const expedition = launchExpedition(state, {
    leaderId: adult.id, memberIds: [adult.id], controlMode: 'expedition', doctrineId: state.doctrines[0].id,
    destination, targetEntityId,
  });
  assert.equal(expedition.destinationEntityId, targetEntityId);
  assert.ok(expeditionObservedRouteConflictRisk(state, expedition) > 0, 'initial outbound travel should see explicit provider-observed disruption on its chosen target');
  const restored = importSandboxSave(JSON.stringify(state));
  const restoredExpedition = restored.expeditions.find((entry) => entry.id === expedition.id);
  assert.ok(restoredExpedition);
  assert.equal(restoredExpedition.destinationEntityId, targetEntityId);
  assert.ok(expeditionObservedRouteConflictRisk(restored, restoredExpedition) > 0);
  restoredExpedition.status = 'returning';
  assert.equal(expeditionObservedRouteConflictRisk(restored, restoredExpedition), 0, 'outbound target disruption must not become stale return-route risk');
});

function qa13DynamicRouteProvider(base) {
  let mode = 'open';
  const alt = { id:'route-node:qa13-detour', kind:'route-node', spatial:{frameId:'world',x:304,y:200,regionId:'region:greenfold'}, components:{name:'QA13 Detour Junction'}, provenanceIds:['prov:qa13-detour'] };
  const altRelations = [
    { id:'relation:qa13-origin-detour', kind:'route-link', sourceId:'settlement:origin', targetId:alt.id, data:{distanceKm:13}, provenanceIds:['prov:qa13-detour'] },
    { id:'relation:qa13-detour-relay', kind:'route-link', sourceId:alt.id, targetId:'landmark:relay-tower', data:{distanceKm:13}, provenanceIds:['prov:qa13-detour'] },
  ];
  const distance = (a,b) => a.frameId===b.frameId ? Math.hypot(a.x-b.x,a.y-b.y,(a.z??0)-(b.z??0)) : Infinity;
  return {
    setMode(next){ mode=next; },
    getManifest: (...args) => base.getManifest(...args),
    getEntity: async (id) => id===alt.id ? structuredClone(alt) : base.getEntity(id),
    getKnowledge: (...args) => base.getKnowledge(...args),
    issueCommand: (...args) => base.issueCommand(...args),
    advance: (...args) => base.advance(...args),
    exportSnapshot: (...args) => base.exportSnapshot(...args),
    queryArea: async (query) => {
      const projection = await base.queryArea(query);
      if (distance(alt.spatial, query.center) <= query.radiusKm) projection.entities.push(structuredClone(alt));
      const ids = new Set(projection.entities.map((entry)=>entry.id));
      for (const relation of altRelations) if (ids.has(relation.sourceId) || ids.has(relation.targetId)) projection.relations.push(structuredClone(relation));
      if (mode === 'hidden') projection.relations = projection.relations.filter((entry)=>entry.id!=='relation:road-origin-relay');
      if (mode === 'closed') projection.relations = projection.relations.map((entry)=>entry.id==='relation:road-origin-relay' ? {...entry,data:{...(entry.data??{}),status:'closed'}} : entry);
      return projection;
    },
  };
}

async function qa13LaunchOnOriginalRoute(provider, state, controlMode = 'settlement') {
  const { providerVisibleRouteAlternatives } = await import('../.test-dist/sandbox/routePlanning.js');
  const projection = await provider.queryArea({center:structuredClone(state.settlement.position),radiusKm:20,requestedDetailRank:0,observerId:state.world.originEntityId,includeKnowledgeProjection:true});
  const target = projection.entities.find((entry)=>entry.id==='landmark:relay-tower');
  assert.ok(target?.spatial);
  const routes = providerVisibleRouteAlternatives(projection, projection.entities, state.world.originEntityId, target.id, 4);
  const selected = routes.find((entry)=>entry.relationIds.includes('relation:road-origin-relay'));
  assert.ok(selected, 'QA13 fixture must expose the original provider route');
  const crew = state.agents.filter((entry)=>entry.alive&&entry.residence==='settlement'&&entry.role!=='child').sort((a,b)=>b.skills.scouting-a.skills.scouting).slice(0,2);
  assert.ok(crew.length>=1);
  const expedition = launchExpedition(state, {
    leaderId:crew[0].id, memberIds:crew.map((entry)=>entry.id), controlMode, doctrineId:state.doctrines[0].id,
    destination:structuredClone(target.spatial), targetEntityId:target.id, pace:'normal', supplies:{food:20,water:30,medicine:2,tools:2},
    routePlan:{kind:selected.kind,nodeEntityIds:[...selected.nodeEntityIds],relationIds:[...selected.relationIds],evidenceIds:[...selected.evidenceIds],waypointEntityIds:[...selected.waypointEntityIds],waypoints:structuredClone(selected.waypoints),waypointRelationIds:[...selected.waypointRelationIds],basisTick:selected.basisTick,relationSignatures:[...selected.relationSignatures],topologyStatus:'active',replanCount:0,plannedDistanceKm:selected.distanceKm},
  });
  return {expedition,selected,target,routes};
}

test('QA13 observer-bounded absence is not treated as route removal, while an explicit closed relation invalidates', async () => {
  const { providerVisibleRouteInvalidations, providerRouteRelationSignature } = await import('../.test-dist/sandbox/routePlanning.js');
  const relation = {id:'relation:qa13:test',kind:'route-link',sourceId:'a',targetId:'b',data:{distanceKm:2},provenanceIds:['prov:test']};
  const signature = providerRouteRelationSignature(relation);
  assert.deepEqual(providerVisibleRouteInvalidations({tick:2,effectiveDetailRank:0,entities:[],relations:[],aggregates:{},observationIds:[]},[relation.id],[signature]),[], 'missing relation is epistemically unknown, not removed');
  const closed = {...relation,data:{distanceKm:2,status:'closed'}};
  const invalid = providerVisibleRouteInvalidations({tick:3,effectiveDetailRank:0,entities:[],relations:[closed],aggregates:{},observationIds:[]},[relation.id],[signature]);
  assert.equal(invalid.length,1);
  assert.match(invalid[0].reason,/status=closed/);
});

test('QA13 explicit provider closure at a physically occupied graph node replans before movement onto a visible detour', async () => {
  const { provider:base, state } = await initial(2609131);
  const provider = qa13DynamicRouteProvider(base);
  const {expedition,selected} = await qa13LaunchOnOriginalRoute(provider,state);
  const start = structuredClone(expedition.position);
  provider.setMode('closed');
  await advanceSandboxHours(provider,state,2);
  assert.equal(expedition.routePlan?.topologyStatus,'active');
  assert.equal(expedition.routePlan?.replanCount,1);
  assert.ok(expedition.routePlan?.relationIds.includes('relation:qa13-origin-detour'));
  assert.ok(!expedition.routePlan?.relationIds.includes('relation:road-origin-relay'));
  assert.notDeepEqual([expedition.position.x,expedition.position.y],[start.x,start.y], 'movement happens only after the replacement route is installed');
  assert.ok(state.chronicle.some((entry)=>entry.title==='Provider topology route replanned'&&entry.entityIds.includes('relation:road-origin-relay')));
  assert.ok(selected.relationIds.includes('relation:road-origin-relay'));
});

test('QA13 mid-edge invalidation stops at the actual field position instead of teleporting to a graph node', async () => {
  const { provider:base, state } = await initial(2609132);
  const provider = qa13DynamicRouteProvider(base);
  const {expedition} = await qa13LaunchOnOriginalRoute(provider,state);
  await advanceSandboxHours(provider,state,1);
  const mid = structuredClone(expedition.position);
  assert.ok(Math.hypot(mid.x-state.settlement.position.x,mid.y-state.settlement.position.y)>.3, 'party must be physically off the origin node before closure');
  provider.setMode('closed');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  assert.equal(expedition.routePlan?.replanCount??0,0);
  assert.ok(Math.hypot(expedition.position.x-mid.x,expedition.position.y-mid.y)<1e-9, 'blocked route must not move or snap the party');
  assert.ok(state.chronicle.some((entry)=>entry.title==='Provider topology route blocked'));
});

test('QA13 disruption severity alone does not imply impassability', async () => {
  const { provider:base, state } = await initial(2609133);
  const provider = qa13DynamicRouteProvider(base);
  const {expedition} = await qa13LaunchOnOriginalRoute(provider,state);
  state.externalConflictObservations ??= [];
  state.externalConflictObservations.push({id:'external-conflict:qa13:degraded',sourceEntityId:'settlement:river-market',providerSourceId:'provider:event:qa13:degraded',providerTick:state.clock.worldTick,day:state.clock.day,minuteOfDay:state.clock.minuteOfDay,kind:'route-disruption',severity:100,injuredIndividualIds:[],displacedIndividualIds:[],affectedRouteEntityIds:['relation:road-origin-relay'],resourceLoss:{},provenanceIds:['provider:event:qa13:degraded']});
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.replanCount??0,0);
  assert.equal(expedition.routePlan?.topologyStatus,'active');
  assert.ok(expedition.routePlan?.relationIds.includes('relation:road-origin-relay'));
});

test('QA13 provider-explicit impassable observation replans, and the new route basis survives save/reload', async () => {
  const { provider:base, state } = await initial(2609134);
  const provider = qa13DynamicRouteProvider(base);
  const {expedition} = await qa13LaunchOnOriginalRoute(provider,state);
  state.externalConflictObservations ??= [];
  state.externalConflictObservations.push({id:'external-conflict:qa13:impassable',sourceEntityId:'settlement:river-market',providerSourceId:'provider:event:qa13:impassable',providerTick:state.clock.worldTick,day:state.clock.day,minuteOfDay:state.clock.minuteOfDay,kind:'route-disruption',severity:70,routePassability:'impassable',injuredIndividualIds:[],displacedIndividualIds:[],affectedRouteEntityIds:['relation:road-origin-relay'],resourceLoss:{},provenanceIds:['provider:event:qa13:impassable']});
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.replanCount,1);
  assert.ok(expedition.routePlan?.relationIds.includes('relation:qa13-origin-detour'));
  assert.ok((expedition.routePlan?.basisTick??-1)>=0);
  assert.equal(expedition.routePlan?.relationSignatures?.length,expedition.routePlan?.relationIds.length);
  const restored = importSandboxSave(JSON.stringify(state));
  const restoredExpedition = restored.expeditions.find((entry)=>entry.id===expedition.id);
  assert.equal(restoredExpedition?.routePlan?.replanCount,1);
  assert.equal(restoredExpedition?.routePlan?.topologyStatus,'active');
  assert.deepEqual(restoredExpedition?.routePlan?.relationIds,expedition.routePlan?.relationIds);
});


function qa14FieldDecisionProvider(base, detourEdgeDistanceKm = 13) {
  let routeMode = 'open';
  let detourVisible = false;
  let weatherVisible = false;
  const detour = { id:'route-node:qa14-detour', kind:'route-node', spatial:{frameId:'world',x:304,y:200,regionId:'region:greenfold'}, components:{name:'QA14 Detour Junction'}, provenanceIds:['prov:qa14-detour'] };
  const weather = { id:'weather:qa14-field-front', kind:'weather', spatial:{frameId:'world',x:300,y:200,regionId:'region:greenfold'}, components:{name:'QA14 Wet Wind Front',weatherSeverity:0.82,domainHints:['weather']},tags:['wet','high-wind'],provenanceIds:['prov:qa14-weather'] };
  const detourRelations = [
    { id:'relation:qa14-origin-detour', kind:'route-link', sourceId:'settlement:origin', targetId:detour.id, data:{distanceKm:detourEdgeDistanceKm}, provenanceIds:['prov:qa14-detour'] },
    { id:'relation:qa14-detour-relay', kind:'route-link', sourceId:detour.id, targetId:'landmark:relay-tower', data:{distanceKm:detourEdgeDistanceKm}, provenanceIds:['prov:qa14-detour'] },
  ];
  const distance = (a,b) => a.frameId===b.frameId ? Math.hypot(a.x-b.x,a.y-b.y,(a.z??0)-(b.z??0)) : Infinity;
  return {
    setRouteMode(next){ routeMode=next; },
    setDetourVisible(value){ detourVisible=Boolean(value); },
    setWeatherVisible(value){ weatherVisible=Boolean(value); },
    getManifest: (...args) => base.getManifest(...args),
    getEntity: async (id) => id===detour.id ? structuredClone(detour) : id===weather.id ? structuredClone(weather) : base.getEntity(id),
    getKnowledge: (...args) => base.getKnowledge(...args),
    issueCommand: (...args) => base.issueCommand(...args),
    advance: (...args) => base.advance(...args),
    exportSnapshot: (...args) => base.exportSnapshot(...args),
    queryArea: async (query) => {
      const projection = await base.queryArea(query);
      if (routeMode === 'hidden') projection.relations = projection.relations.filter((entry)=>entry.id!=='relation:road-origin-relay');
      if (routeMode === 'closed') projection.relations = projection.relations.map((entry)=>entry.id==='relation:road-origin-relay' ? {...entry,data:{...(entry.data??{}),status:'closed'}} : entry);
      if (detourVisible && distance(detour.spatial,query.center)<=query.radiusKm) projection.entities.push(structuredClone(detour));
      if (weatherVisible) {
        const originSpatial = projection.entities.find((entry)=>entry.id==='settlement:origin')?.spatial ?? query.center;
        const observedWeather = {...structuredClone(weather),spatial:structuredClone(originSpatial)};
        if (distance(observedWeather.spatial,query.center)<=query.radiusKm) projection.entities.push(observedWeather);
      }
      if (detourVisible) {
        const ids = new Set(projection.entities.map((entry)=>entry.id));
        for (const relation of detourRelations) if (ids.has(relation.sourceId) || ids.has(relation.targetId)) projection.relations.push(structuredClone(relation));
      }
      return projection;
    },
  };
}

test('QA14 blocked routes do not auto-replan when a detour later appears; explicit retry/replan is required', async () => {
  const {provider:base,state}=await initial(2609141);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  const blockedPosition=structuredClone(expedition.position);
  provider.setDetourVisible(true);
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  assert.equal(expedition.routePlan?.replanCount??0,0,'new visible topology must not trigger an implicit retry after the party is already blocked');
  assert.ok(Math.hypot(expedition.position.x-blockedPosition.x,expedition.position.y-blockedPosition.y)<1e-9);
  issueBlockedFieldDecision(state,expedition.id,'retry-replan');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.fieldDecision?.status,'completed');
  assert.equal(expedition.routePlan?.topologyStatus,'active');
  assert.equal(expedition.routePlan?.replanCount,1);
  assert.ok(expedition.routePlan?.relationIds.includes('relation:qa14-origin-detour'));
  assert.notDeepEqual([expedition.position.x,expedition.position.y],[blockedPosition.x,blockedPosition.y]);
});

test('QA14 bounded wait/camp consumes finite supplies, rests the party, persists exposure evidence and never infers route recovery', async () => {
  const {provider:base,state}=await initial(2609142);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  provider.setWeatherVisible(true);
  for (const id of expedition.memberIds) { const agent=state.agents.find((entry)=>entry.id===id); if(agent) agent.fatigue=80; }
  const fatigueBefore=state.agents.find((entry)=>entry.id===expedition.leaderId)?.fatigue??0;
  const foodBefore=expedition.supplies.food, waterBefore=expedition.supplies.water;
  const positionBefore=structuredClone(expedition.position);
  issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:6});
  await advanceSandboxHours(provider,state,6);
  assert.equal(expedition.fieldDecision?.status,'completed');
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  assert.equal(expedition.routePlan?.replanCount??0,0);
  assert.ok(expedition.supplies.food<foodBefore&&expedition.supplies.water<waterBefore,'waiting must consume canonical field supplies');
  assert.ok((state.agents.find((entry)=>entry.id===expedition.leaderId)?.fatigue??100)<fatigueBefore,'camp should provide real rest despite environmental exposure');
  assert.ok((expedition.fieldExposure?.lastRisk??0)>0);
  assert.ok((expedition.fieldExposure?.cumulativeDose??0)>0);
  assert.equal(expedition.fieldExposure?.sheltered,true);
  assert.ok(expedition.fieldExposure?.sourceEntityIds.includes('weather:qa14-field-front'));
  assert.ok(Math.hypot(expedition.position.x-positionBefore.x,expedition.position.y-positionBefore.y)<1e-9);
  const restored=importSandboxSave(JSON.stringify(state));
  const restoredExpedition=restored.expeditions.find((entry)=>entry.id===expedition.id);
  assert.equal(restoredExpedition?.fieldDecision?.kind,'wait-camp');
  assert.equal(restoredExpedition?.fieldDecision?.status,'completed');
  assert.ok((restoredExpedition?.fieldExposure?.cumulativeDose??0)>0);
});

test('QA14 missing relation and time passage do not restore a blocked route; explicit visible restoration still requires retry', async () => {
  const {provider:base,state}=await initial(2609143);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  provider.setRouteMode('hidden');
  issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:3});
  await advanceSandboxHours(provider,state,3);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked','observer-bounded absence cannot prove reopening');
  provider.setRouteMode('open');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked','even explicit current topology is not silently recommitted after a blocked decision point');
  issueBlockedFieldDecision(state,expedition.id,'retry-replan');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.fieldDecision?.status,'completed');
  assert.equal(expedition.routePlan?.topologyStatus,'active');
  assert.ok(expedition.routePlan?.relationIds.includes('relation:road-origin-relay'));
});

test('QA14 blocked mid-edge retry fails at the exact physical position instead of snapping to a route node', async () => {
  const {provider:base,state}=await initial(2609144);
  const provider=qa13DynamicRouteProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  await advanceSandboxHours(provider,state,1);
  provider.setMode('closed');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  const mid=structuredClone(expedition.position);
  issueBlockedFieldDecision(state,expedition.id,'retry-replan');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.fieldDecision?.status,'failed');
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  assert.equal(expedition.routePlan?.replanCount??0,0);
  assert.ok(Math.hypot(expedition.position.x-mid.x,expedition.position.y-mid.y)<1e-9);
});

test('QA14 field return abandons the blocked outbound route as an explicit off-network bearing rather than a claimed road', async () => {
  const {provider:base,state}=await initial(2609145);
  const provider=qa13DynamicRouteProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  await advanceSandboxHours(provider,state,1);
  provider.setMode('closed');
  await advanceSandboxHours(provider,state,1);
  const distanceBefore=Math.hypot(expedition.position.x-state.settlement.position.x,expedition.position.y-state.settlement.position.y);
  assert.ok(distanceBefore>.3);
  issueBlockedFieldDecision(state,expedition.id,'return');
  assert.equal(expedition.status,'returning');
  assert.equal(expedition.returnTravelMode,'off-network-bearing');
  assert.equal(expedition.fieldDecision?.status,'completed');
  assert.match(expedition.fieldDecision?.result??'',/direct physical bearing outside the recorded road network/i);
  await advanceSandboxHours(provider,state,.25);
  const distanceAfter=Math.hypot(expedition.position.x-state.settlement.position.x,expedition.position.y-state.settlement.position.y);
  assert.ok(distanceAfter<distanceBefore || expedition.status==='returned');
});

test('QA14 camp shelter mitigates explicit provider-visible environmental exposure relative to passive blocked waiting', async () => {
  const {provider:base,state}=await initial(2609146);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  provider.setWeatherVisible(true);
  await advanceSandboxHours(provider,state,2);
  const unshelteredDose=expedition.fieldExposure?.lastIntervalDose??0;
  assert.ok(unshelteredDose>0);
  issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:2});
  await advanceSandboxHours(provider,state,2);
  const shelteredDose=expedition.fieldExposure?.lastIntervalDose??0;
  assert.ok(shelteredDose>0&&shelteredDose<unshelteredDose,`expected shelter mitigation: ${shelteredDose} < ${unshelteredDose}`);
  assert.equal(expedition.fieldExposure?.sheltered,true);
});

test('QA14 retry that discovers only an unaffordable visible detour returns instead of committing to impossible outbound travel', async () => {
  const {provider:base,state}=await initial(2609147);
  const provider=qa14FieldDecisionProvider(base,1000);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  provider.setDetourVisible(true);
  issueBlockedFieldDecision(state,expedition.id,'retry-replan');
  await advanceSandboxHours(provider,state,0.05);
  assert.ok(['returning','returned'].includes(expedition.status),`expected return commitment, got ${expedition.status}`);
  assert.equal(expedition.returnTravelMode,'off-network-bearing');
  assert.equal(expedition.fieldDecision?.status,'failed');
  assert.match(expedition.fieldDecision?.result??'',/supplies forced a return/i);
  assert.notEqual(expedition.status,'outbound','an unaffordable detour must never recommit the party to outbound travel');
  if (expedition.status==='returning') assert.equal(expedition.routePlan?.topologyStatus,'active','the detour can be real and visible while still being unaffordable');
});

test('QA14 automatic field-supply turnback terminates an active wait/camp decision instead of leaving stale active state', async () => {
  const {provider:base,state}=await initial(2609148);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:6});
  expedition.supplies.food=0;
  expedition.supplies.water=0;
  await advanceSandboxHours(provider,state,0.25);
  assert.notEqual(expedition.fieldDecision?.status,'active');
  assert.equal(expedition.fieldDecision?.status,'failed');
  assert.match(expedition.fieldDecision?.result??'',/supply|returned/i);
  assert.ok(['returning','returned'].includes(expedition.status));
});

test('QA14 save validation fails closed on stale active field decisions outside a blocked outbound route', async () => {
  const {provider:base,state}=await initial(2609149);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:6});
  expedition.status='returning';
  assert.throws(()=>importSandboxSave(JSON.stringify(state)),/active fieldDecision requires a blocked outbound provider route/i);
});

function qa15ReturnEvidenceProvider(base) {
  let anchorVisible = false;
  const terrainId = 'terrain:qa15-rough-return';
  const anchorId = 'navigation:qa15-visible-anchor';
  return {
    setAnchorVisible(value){ anchorVisible = Boolean(value); },
    getManifest: (...args) => base.getManifest(...args),
    getEntity: (...args) => base.getEntity(...args),
    getKnowledge: (...args) => base.getKnowledge(...args),
    issueCommand: (...args) => base.issueCommand(...args),
    advance: (...args) => base.advance(...args),
    exportSnapshot: (...args) => base.exportSnapshot(...args),
    queryArea: async (query) => {
      const projection = await base.queryArea(query);
      projection.entities.push({id:terrainId,kind:'terrain-condition',spatial:structuredClone(query.center),components:{name:'QA15 explicit rough terrain',terrainDifficulty:.72},tags:['rough-terrain'],provenanceIds:['prov:qa15-terrain']});
      if (anchorVisible) projection.entities.push({id:anchorId,kind:'navigation-anchor',spatial:structuredClone(query.center),components:{name:'QA15 provider-visible navigation anchor',navigationAnchor:true},tags:['navigation-anchor'],provenanceIds:['prov:qa15-anchor']});
      return projection;
    },
  };
}

test('QA15 off-network return persists physical progress, explicit terrain drag and dead-reckoning uncertainty', async () => {
  const {provider:raw,state}=await initial(2609151);
  const routeProvider=qa13DynamicRouteProvider(raw);
  const provider=qa15ReturnEvidenceProvider(routeProvider);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  await advanceSandboxHours(provider,state,1);
  routeProvider.setMode('closed');
  await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  const foodBefore=expedition.supplies.food, waterBefore=expedition.supplies.water;
  issueBlockedFieldDecision(state,expedition.id,'return');
  assert.equal(expedition.returnTravel?.status,'active');
  assert.ok((expedition.returnTravel?.initialDistanceKm??0)>.3);
  await advanceSandboxHours(provider,state,.25);
  assert.ok(['returning','returned'].includes(expedition.status));
  const travel=expedition.returnTravel;
  assert.ok(travel);
  assert.ok(travel.travelledDistanceKm>0 || travel.status==='completed');
  assert.ok(travel.remainingDistanceKm<travel.initialDistanceKm || travel.status==='completed');
  assert.ok(travel.lastSpeedFactor<1,'provider-visible terrain should reduce off-network travel speed');
  assert.ok(travel.terrainEvidenceIds.includes('terrain:qa15-rough-return'));
  assert.ok(travel.uncertaintyKm>0 || travel.status==='completed');
  assert.ok(expedition.supplies.food<foodBefore&&expedition.supplies.water<waterBefore,'physical return must keep consuming finite supplies');
  const restored=importSandboxSave(JSON.stringify(state));
  const restoredTravel=restored.expeditions.find((entry)=>entry.id===expedition.id)?.returnTravel;
  assert.ok(restoredTravel);
  assert.equal(restoredTravel.status,travel.status);
  assert.equal(restoredTravel.terrainEvidenceIds[0],'terrain:qa15-rough-return');
  assert.equal(restoredTravel.uncertaintyKm,travel.uncertaintyKm);
});

test('QA15 only a provider-visible navigation anchor corrects accumulated off-network position uncertainty', async () => {
  const {provider:raw,state}=await initial(2609152);
  const routeProvider=qa13DynamicRouteProvider(raw);
  const provider=qa15ReturnEvidenceProvider(routeProvider);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  await advanceSandboxHours(provider,state,1);
  routeProvider.setMode('closed');
  await advanceSandboxHours(provider,state,1);
  issueBlockedFieldDecision(state,expedition.id,'return');
  await advanceSandboxHours(provider,state,.1);
  const beforeAnchor=expedition.returnTravel?.uncertaintyKm??0;
  assert.ok(beforeAnchor>0);
  provider.setAnchorVisible(true);
  await advanceSandboxHours(provider,state,.05);
  const afterAnchor=expedition.returnTravel?.uncertaintyKm??Infinity;
  assert.ok(expedition.returnTravel?.navigationAnchorIds.includes('navigation:qa15-visible-anchor'));
  assert.ok(afterAnchor<beforeAnchor,`explicit anchor should reduce uncertainty: ${afterAnchor} < ${beforeAnchor}`);
});

test('QA15 prolonged provider-visible field exposure creates a non-clinical burden case that existing clinic care can treat after return', async () => {
  const {provider:base,state}=await initial(2609153);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  provider.setWeatherVisible(true);
  for(let i=0;i<3;i++) {
    issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:6});
    await advanceSandboxHours(provider,state,6);
    assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  }
  const patient=state.agents.find((entry)=>entry.id===expedition.leaderId);
  assert.ok(patient);
  const burden=patient.pathology.find((entry)=>entry.pathologyId==='field-exposure-burden'&&entry.status==='active');
  assert.ok(burden,'cumulative explicit exposure should create a gameplay burden record');
  assert.equal(burden.contagious,false);
  assert.ok(burden.suspectedCauses.includes('weather:qa14-field-front'));
  const severityBefore=burden.severity;
  assert.ok(severityBefore>0);
  issueBlockedFieldDecision(state,expedition.id,'return');
  for(let i=0;i<8&&expedition.status!=='returned';i++) await advanceSandboxHours(provider,state,1);
  assert.equal(expedition.status,'returned');
  const care=requestDirectClinicCare(state,patient.id,60);
  assert.ok(care.pathology);
  assert.ok(care.pathology.severityAfter<care.pathology.severityBefore,'existing clinic path should reduce the non-clinical field burden after physical return');
});

test('QA15 pending rendezvous never exposes an earlier silent field position and transmits only the position observed when link returns', async () => {
  const {provider,state}=await initial(2609154);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  await advanceSandboxHours(provider,state,1);
  expedition.communication='silent';
  const request=requestFieldRendezvous(state,expedition.id);
  assert.equal(request.status,'pending-link');
  assert.equal(request.verifiedPosition,undefined);
  const originallyRequested=structuredClone(request.requestedPosition);
  expedition.position={...expedition.position,x:expedition.position.x+1.25,y:expedition.position.y+.5};
  expedition.communication='connected';
  promoteRendezvousRequestAfterVerifiedLink(state,expedition);
  assert.equal(request.status,'transmitted');
  assert.ok(request.verifiedPosition);
  assert.notDeepEqual(request.verifiedPosition,originallyRequested,'earlier hidden movement must not be reconstructed into the transmitted request');
  assert.deepEqual(request.verifiedPosition,expedition.position,'transmission uses the currently verified position only');
  const restored=importSandboxSave(JSON.stringify(state));
  assert.deepEqual(restored.expeditions.find((entry)=>entry.id===expedition.id)?.rendezvousRequest?.verifiedPosition,expedition.position);
});

test('QA15 a transmitted rendezvous can justify rescue while a forged pending-link location fails closed on import', async () => {
  const {provider,state}=await initial(2609155);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  expedition.communication='connected';
  const request=requestFieldRendezvous(state,expedition.id);
  assert.equal(request.status,'transmitted');
  const available=state.agents.filter((entry)=>entry.alive&&entry.residence==='settlement'&&!entry.expeditionId&&entry.role!=='child').sort((a,b)=>b.skills.scouting-a.skills.scouting).slice(0,2);
  assert.ok(available.length>=1);
  const rescue=launchRescueExpedition(state,expedition.id,available[0].id,available.map((entry)=>entry.id),'settlement');
  assert.deepEqual(rescue.destination,request.verifiedPosition,'rescue planning should use the verified rendezvous observation');
  const forged=structuredClone(state);
  const target=forged.expeditions.find((entry)=>entry.id===expedition.id);
  target.rendezvousRequest.status='pending-link';
  target.rendezvousRequest.verifiedPosition=structuredClone(target.position);
  delete target.rendezvousRequest.transmittedDay;
  delete target.rendezvousRequest.transmittedMinute;
  assert.throws(()=>importSandboxSave(JSON.stringify(forged)),/pending-link rendezvousRequest cannot expose (?:a )?verifiedPosition/i);
});

test('QA15 loss classification interrupts an active physical return instead of leaving an impossible active return state', async () => {
  const {provider:base,state}=await initial(2609157);
  const provider=qa13DynamicRouteProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  await advanceSandboxHours(provider,state,1);
  provider.setMode('closed');
  await advanceSandboxHours(provider,state,1);
  issueBlockedFieldDecision(state,expedition.id,'return');
  assert.equal(expedition.returnTravel?.status,'active');
  markExpeditionLossState(state,expedition.id,'unknown','QA15 regression: verified contact is lost during the off-network return.');
  assert.equal(expedition.status,'missing');
  assert.equal(expedition.returnTravel?.status,'interrupted');
  const restored=importSandboxSave(JSON.stringify(state));
  const restoredExpedition=restored.expeditions.find((entry)=>entry.id===expedition.id);
  assert.equal(restoredExpedition?.status,'missing');
  assert.equal(restoredExpedition?.returnTravel?.status,'interrupted');
});

test('QA15 repeated camp/retry and explicit restoration/reclosure remains physical across a save boundary', async () => {
  const {provider:base,state}=await initial(2609156);
  const provider=qa14FieldDecisionProvider(base);
  const {expedition}=await qa13LaunchOnOriginalRoute(provider,state,'expedition');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,1);
  issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:12});
  await advanceSandboxHours(provider,state,12);
  provider.setRouteMode('open');
  issueBlockedFieldDecision(state,expedition.id,'retry-replan');
  await advanceSandboxHours(provider,state,.25);
  assert.equal(expedition.routePlan?.topologyStatus,'active');
  provider.setRouteMode('closed');
  await advanceSandboxHours(provider,state,.25);
  assert.equal(expedition.routePlan?.topologyStatus,'blocked');
  const blockedAgain=structuredClone(expedition.position);
  issueBlockedFieldDecision(state,expedition.id,'wait-camp',{durationHours:12});
  await advanceSandboxHours(provider,state,12);
  assert.ok(Math.hypot(expedition.position.x-blockedAgain.x,expedition.position.y-blockedAgain.y)<1e-9);
  const restored=importSandboxSave(JSON.stringify(state));
  const restoredExpedition=restored.expeditions.find((entry)=>entry.id===expedition.id);
  assert.equal(restoredExpedition?.routePlan?.topologyStatus,'blocked');
  assert.equal(restoredExpedition?.fieldDecision?.status,'completed');
  assert.ok(state.clock.day>=1,'the scenario must cross at least one canonical day');
});


function qa16RendezvousEvidenceProvider(base) {
  let clue = null;
  let severeWeather = false;
  return {
    setClue(value){ clue = value ? structuredClone(value) : null; },
    setSevereWeather(value){ severeWeather = Boolean(value); },
    getManifest: (...args) => base.getManifest(...args),
    getEntity: (...args) => base.getEntity(...args),
    getKnowledge: (...args) => base.getKnowledge(...args),
    issueCommand: (...args) => base.issueCommand(...args),
    advance: (...args) => base.advance(...args),
    exportSnapshot: (...args) => base.exportSnapshot(...args),
    queryArea: async (query) => {
      const projection = await base.queryArea(query);
      if (clue) projection.entities.push({
        id: clue.id, kind:'rescue-clue', spatial: structuredClone(clue.spatial),
        components:{name:'QA16 explicit rescue clue',rescueEvidence:true,targetExpeditionId:clue.targetExpeditionId},
        tags:['rescue-evidence'], provenanceIds:['prov:qa16-clue'],
      });
      if (severeWeather) projection.entities.push({
        id:'weather:qa16-responder-exposure',kind:'weather-condition',spatial:structuredClone(query.center),
        components:{name:'QA16 explicit severe weather',weatherSeverity:.95},tags:['severe-weather'],provenanceIds:['prov:qa16-weather'],
      });
      return projection;
    },
  };
}

function qa16RescueCrew(state, excludedIds = [], count = 3) {
  const excluded = new Set(excludedIds);
  return state.agents.filter((entry)=>entry.alive&&entry.role!=='child'&&entry.residence==='settlement'&&!entry.expeditionId&&!excluded.has(entry.id))
    .sort((a,b)=>b.skills.scouting-a.skills.scouting).slice(0,count);
}

test('QA16 responder arrives at time-stamped evidence and waits instead of homing onto a target that moved after transmission', async () => {
  const {provider,state}=await initial(2609161);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const target=launchExpedition(state,{leaderId:adults[0].id,memberIds:[adults[0].id],controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+5}});
  target.position={...state.settlement.position,x:state.settlement.position.x+1};
  target.communication='connected';
  const request=requestFieldRendezvous(state,target.id);
  assert.equal(request.status,'transmitted');
  const transmitted=structuredClone(request.verifiedPosition);
  target.position={...target.position,x:target.position.x+6,y:target.position.y+2};
  target.communication='silent';
  const crew=qa16RescueCrew(state,target.memberIds,2); assert.ok(crew.length>=1);
  const rescue=launchRescueExpedition(state,target.id,crew[0].id,crew.map((entry)=>entry.id),'expedition');
  assert.deepEqual(rescue.destination,transmitted);
  assert.deepEqual(rescue.rendezvousPlan?.evidencePosition,transmitted);
  assert.notDeepEqual(rescue.rendezvousPlan?.evidencePosition,target.position);
  const outboundRestored=importSandboxSave(JSON.stringify(state));
  assert.equal(outboundRestored.expeditions.find((entry)=>entry.id===rescue.id)?.rendezvousPlan?.status,'outbound');
  await advanceSandboxHours(provider,state,2);
  assert.ok(['waiting','searching'].includes(rescue.rendezvousPlan?.status));
  assert.notEqual(rescue.rendezvousPlan?.status,'contact');
  assert.notEqual(target.status,'returning','moving after transmission must not be remotely converted into rescue contact');
  const waitingRestored=importSandboxSave(JSON.stringify(state));
  assert.ok(['waiting','searching'].includes(waitingRestored.expeditions.find((entry)=>entry.id===rescue.id)?.rendezvousPlan?.status));
});

test('QA16 bounded wait becomes a deterministic evidence-centered search whose waypoint is independent of hidden target coordinates', async () => {
  const {provider,state}=await initial(2609162);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const target=launchExpedition(state,{leaderId:adults[0].id,memberIds:[adults[0].id],controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+4}});
  target.position={...state.settlement.position,x:state.settlement.position.x+1}; target.communication='connected'; requestFieldRendezvous(state,target.id);
  target.position={...target.position,x:target.position.x+7,y:target.position.y+3}; target.communication='silent';
  const crew=qa16RescueCrew(state,target.memberIds,2); const rescue=launchRescueExpedition(state,target.id,crew[0].id,crew.map((entry)=>entry.id),'expedition');
  for(let i=0;i<4&&rescue.rendezvousPlan?.status!=='searching';i++) await advanceSandboxHours(provider,state,2);
  assert.equal(rescue.rendezvousPlan?.status,'searching');
  const waypointBefore=rendezvousSearchWaypoint(rescue); assert.ok(waypointBefore);
  target.position={...target.position,x:target.position.x+20,y:target.position.y-11};
  const waypointAfter=rendezvousSearchWaypoint(rescue);
  assert.deepEqual(waypointAfter,waypointBefore,'search waypoint must not change merely because hidden canonical target coordinates changed');
  assert.deepEqual(waypointBefore,rescue.rendezvousPlan?.intendedTargetPosition,'first search cue may use the already-known intended destination');
  const restored=importSandboxSave(JSON.stringify(state));
  assert.equal(restored.expeditions.find((entry)=>entry.id===rescue.id)?.rendezvousPlan?.status,'searching');
});

test('QA16 explicit provider rescue evidence recenters search without exposing hidden target position', async () => {
  const {provider:base,state}=await initial(2609163); const provider=qa16RendezvousEvidenceProvider(base);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const target=launchExpedition(state,{leaderId:adults[0].id,memberIds:[adults[0].id],controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+3}});
  target.position={...state.settlement.position,x:state.settlement.position.x+1}; target.communication='connected'; requestFieldRendezvous(state,target.id);
  target.position={...state.settlement.position,x:state.settlement.position.x+12,y:state.settlement.position.y+8}; target.communication='silent';
  const crew=qa16RescueCrew(state,target.memberIds,2); const rescue=launchRescueExpedition(state,target.id,crew[0].id,crew.map((entry)=>entry.id),'expedition');
  rescue.status='exploring'; rescue.destination=null; rescue.position=structuredClone(rescue.rendezvousPlan.evidencePosition); rescue.rendezvousPlan.status='searching'; rescue.rendezvousPlan.waitHoursRemaining=0;
  const clueSpatial={...state.settlement.position,x:state.settlement.position.x+2.5,y:state.settlement.position.y+1.5};
  provider.setClue({id:'clue:qa16-tracks',targetExpeditionId:target.id,spatial:clueSpatial});
  await advanceSandboxHours(provider,state,.25);
  assert.equal(rescue.rendezvousPlan?.lastOutcome,'evidence-updated');
  assert.equal(rescue.rendezvousPlan?.targetEvidenceId,'clue:qa16-tracks');
  assert.deepEqual(rescue.rendezvousPlan?.evidencePosition,clueSpatial);
  assert.notDeepEqual(rescue.rendezvousPlan?.evidencePosition,target.position);
  assert.equal(rescue.rendezvousPlan?.intendedTargetPosition,undefined,'new explicit provider evidence supersedes the older intended-destination search cue');
  assert.notDeepEqual(rendezvousSearchWaypoint(rescue),target.position,'recentered search must still not home onto hidden target coordinates');
});

test('QA16 aid and wounded-person transfer is impossible remotely and becomes durable only after actual co-location', async () => {
  const {provider,state}=await initial(2609164);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const targetMembers=adults.slice(0,2);
  const target=launchExpedition(state,{leaderId:targetMembers[0].id,memberIds:targetMembers.map((entry)=>entry.id),controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+1}});
  target.position={...state.settlement.position,x:state.settlement.position.x+1}; target.communication='connected'; requestFieldRendezvous(state,target.id); target.communication='silent';
  const crew=qa16RescueCrew(state,target.memberIds,2); const rescue=launchRescueExpedition(state,target.id,crew[0].id,crew.map((entry)=>entry.id),'expedition');
  assert.throws(()=>transferRendezvousAidAndWounded(state,rescue.id,{food:1}),/Physical rendezvous contact is required/i);
  await advanceSandboxHours(provider,state,1);
  assert.equal(rescue.rendezvousPlan?.status,'contact');
  await advanceSandboxHours(provider,state,.25);
  assert.equal(rescue.rendezvousPlan?.status,'contact','physical contact must remain a decision point until explicit transfer or abort');
  targetMembers[1].health=40;
  const responderFood=rescue.supplies.food, targetFood=target.supplies.food;
  transferRendezvousAidAndWounded(state,rescue.id,{food:1,water:1,medicine:.5,tools:.25,injuredMemberIds:[targetMembers[1].id]});
  assert.equal(rescue.rendezvousPlan?.status,'completed');
  assert.equal(rescue.rendezvousPlan?.transfer?.injuredMemberIds[0],targetMembers[1].id);
  assert.equal(targetMembers[1].expeditionId,rescue.id);
  assert.ok(rescue.memberIds.includes(targetMembers[1].id)); assert.ok(!target.memberIds.includes(targetMembers[1].id));
  assert.equal(rescue.supplies.food,responderFood-1); assert.equal(target.supplies.food,targetFood+1);
  assert.equal(target.status,'returning'); assert.equal(rescue.status,'returning');
  const restored=importSandboxSave(JSON.stringify(state));
  const restoredRescue=restored.expeditions.find((entry)=>entry.id===rescue.id);
  assert.equal(restoredRescue?.rendezvousPlan?.status,'completed');
  assert.ok(restoredRescue?.memberIds.includes(targetMembers[1].id));
});

test('QA16 responder supply reserve forces a fail-closed rendezvous turnback before depletion', async () => {
  const {provider,state}=await initial(2609165);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const target=launchExpedition(state,{leaderId:adults[0].id,memberIds:[adults[0].id],controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+4}});
  target.position={...state.settlement.position,x:state.settlement.position.x+2}; target.communication='connected'; requestFieldRendezvous(state,target.id); target.communication='silent';
  const crew=qa16RescueCrew(state,target.memberIds,2); const rescue=launchRescueExpedition(state,target.id,crew[0].id,crew.map((entry)=>entry.id),'expedition');
  rescue.supplies.food=.01; rescue.supplies.water=.01;
  await advanceSandboxHours(provider,state,.25);
  assert.ok(['returning','returned'].includes(rescue.status)); assert.equal(rescue.rendezvousPlan?.status,'aborted'); assert.equal(rescue.rendezvousPlan?.lastOutcome,'responder-turnback');
  assert.match(rescue.rendezvousPlan?.abortedReason??'',/supplies/i);
  const restored=importSandboxSave(JSON.stringify(state));
  assert.equal(restored.expeditions.find((entry)=>entry.id===rescue.id)?.rendezvousPlan?.status,'aborted');
});

test('QA16 explicit responder exposure can abort waiting/searching without converting it into medical omniscience', async () => {
  const {provider:base,state}=await initial(2609166); const provider=qa16RendezvousEvidenceProvider(base); provider.setSevereWeather(true);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const target=launchExpedition(state,{leaderId:adults[0].id,memberIds:[adults[0].id],controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+5}});
  target.position={...state.settlement.position,x:state.settlement.position.x+.5}; target.communication='connected'; requestFieldRendezvous(state,target.id);
  target.position={...state.settlement.position,x:state.settlement.position.x+15,y:state.settlement.position.y+8}; target.communication='silent';
  markExpeditionLossState(state,target.id,'unknown','QA16 regression: target remains physically unverified while the responder is exposed.');
  const crew=qa16RescueCrew(state,target.memberIds,1); const rescue=launchRescueExpedition(state,target.id,crew[0].id,[crew[0].id],'expedition');
  for(let i=0;i<6&&!['aborted','completed'].includes(rescue.rendezvousPlan?.status??'');i++) await advanceSandboxHours(provider,state,3);
  assert.equal(rescue.rendezvousPlan?.status,'aborted'); assert.equal(rescue.rendezvousPlan?.lastOutcome,'responder-turnback'); assert.equal(rescue.status,'returning');
  assert.ok((rescue.fieldExposure?.cumulativeDose??0)>0);
  assert.ok(rescue.memberIds.every((id)=>state.agents.find((entry)=>entry.id===id)?.pathology.every((entry)=>entry.pathologyId!=='hypothermia'&&entry.pathologyId!=='heatstroke')));
});

test('QA16 evidence-centered search is bounded and aborts to physical return when no newer evidence or contact appears', async () => {
  const {provider,state}=await initial(2609168);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const target=launchExpedition(state,{leaderId:adults[0].id,memberIds:[adults[0].id],controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+5}});
  target.position={...state.settlement.position,x:state.settlement.position.x+1}; target.communication='connected'; requestFieldRendezvous(state,target.id);
  target.position={...state.settlement.position,x:state.settlement.position.x+18,y:state.settlement.position.y+12};
  markExpeditionLossState(state,target.id,'unknown','QA16 regression: no newer search evidence arrives.');
  const crew=qa16RescueCrew(state,target.memberIds,2); const rescue=launchRescueExpedition(state,target.id,crew[0].id,crew.map((entry)=>entry.id),'expedition');
  for(let i=0;i<12&&!['aborted','completed'].includes(rescue.rendezvousPlan?.status??'');i++) await advanceSandboxHours(provider,state,2);
  assert.equal(rescue.rendezvousPlan?.status,'aborted');
  assert.equal(rescue.rendezvousPlan?.lastOutcome,'aborted');
  assert.match(rescue.rendezvousPlan?.abortedReason??'',/bounded 12h evidence-centered search|12時間の記録地点周辺捜索/i);
  assert.ok(['returning','returned'].includes(rescue.status));
});

test('QA16 save validation rejects forged contact/completed rendezvous phases without physical lifecycle evidence', async () => {
  const {state}=await initial(2609167);
  const adults=state.agents.filter((entry)=>entry.alive&&entry.role!=='child');
  const target=launchExpedition(state,{leaderId:adults[0].id,memberIds:[adults[0].id],controlMode:'expedition',doctrineId:state.doctrines[0].id,destination:{...state.settlement.position,x:state.settlement.position.x+2}});
  target.position={...state.settlement.position,x:state.settlement.position.x+1}; target.communication='connected'; requestFieldRendezvous(state,target.id);
  const crew=qa16RescueCrew(state,target.memberIds,1); const rescue=launchRescueExpedition(state,target.id,crew[0].id,[crew[0].id],'expedition');
  const forgedContact=structuredClone(state); const fc=forgedContact.expeditions.find((entry)=>entry.id===rescue.id); fc.status='exploring'; fc.rendezvousPlan.status='contact'; delete fc.rendezvousPlan.coLocatedAt;
  assert.throws(()=>importSandboxSave(JSON.stringify(forgedContact)),/contact rendezvousPlan requires coLocatedAt/i);
  const forgedComplete=structuredClone(state); const fd=forgedComplete.expeditions.find((entry)=>entry.id===rescue.id); fd.status='returning'; fd.rendezvousPlan.status='completed'; delete fd.rendezvousPlan.transfer;
  assert.throws(()=>importSandboxSave(JSON.stringify(forgedComplete)),/completed rendezvousPlan requires transfer evidence/i);
});

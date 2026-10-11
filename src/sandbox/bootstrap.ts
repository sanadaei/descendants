import { initializeNames } from './naming.js';
import type { KnowledgeRecord, WorldEntity, WorldProvider } from '../worldbridge/contract.js';
import { acceptWorldProvider } from '../worldbridge/providerGuard.js';
import { DEFAULT_MOCK_CLOCK_POLICY, type WorldClockPolicy } from '../worldbridge/worldClock.js';
import { normalizeSeed } from './rng.js';
import { syncLegacyKnowledgeShadow } from './knowledgeLegacyAdapter.js';
import { synchronizeIncidentLedger } from './incidentService.js';
import { ensureSurvivalCampaignState } from './survivalCampaign.js';
import { initializeResourceLedgerFromWorld } from './resourceLedger.js';
import { institutionsFromProvider, materializeOriginPopulation, resourcesFromProvider } from './providerPopulation.js';
import type {
  ExpeditionDoctrine, KnowledgeEntry, SandboxAgent, SandboxGameState,
} from './types.js';

function nextId(state: { sequence: number }, prefix: string): string {
  state.sequence += 1;
  return `${prefix}:${state.sequence.toString(36).padStart(3, '0')}`;
}

function ageYears(agent: SandboxAgent, day: number): number { return Math.floor((day - agent.bornDay) / 365); }

function convertWorldKnowledge(records: KnowledgeRecord[], agents: SandboxAgent[], day: number): KnowledgeEntry[] {
  const adults = agents.filter((agent) => ageYears(agent, day) >= 13);
  return records.map((record, index) => ({
    id: `knowledge:world:${index + 1}`,
    subjectIds: [...record.subjectIds],
    claim: typeof record.claim.text === 'string' ? record.claim.text : JSON.stringify(record.claim),
    confidence: Math.max(0, Math.min(1, record.confidence)), acquiredDay: day,
    carrier: 'oral', holderIds: adults.slice(0, Math.max(2, Math.min(7, adults.length))).map((agent) => agent.id),
    sourceWorldKnowledgeId: record.id, truthLinkIds: [...(record.truthLinkIds ?? [])], lost: false,
  }));
}

function applyKnowledgeToAgents(entries: KnowledgeEntry[], agents: SandboxAgent[]): void {
  let beliefSequence = 0;
  for (const entry of entries) {
    for (const holderId of entry.holderIds) {
      const agent = agents.find((candidate) => candidate.id === holderId);
      if (!agent) continue;
      if (!agent.knowledgeIds.includes(entry.id)) agent.knowledgeIds.push(entry.id);
      agent.beliefs.push({ id: `belief:seed:${++beliefSequence}`, subjectIds: [...entry.subjectIds], claim: entry.claim, confidence: entry.confidence, basisKnowledgeIds: [entry.id] });
    }
  }
}

function selectLeader(agents: SandboxAgent[]): SandboxAgent {
  const adults = agents.filter((agent) => ageYears(agent, 1) >= 18);
  const ranked = [...adults].sort((a, b) => (b.skills.leadership * 0.55 + b.authority.legitimacy * 0.45) - (a.skills.leadership * 0.55 + a.authority.legitimacy * 0.45));
  const leader = ranked[0] ?? agents[0];
  if (!leader) throw new Error('Cannot initialize an empty settlement.');
  leader.role = 'leader';
  if (leader.profileAuthority) leader.profileAuthority.role = 'game-derived';
  leader.authority.offices.push('settlement-leader');
  leader.authority.legitimacy = Math.max(65, leader.authority.legitimacy);
  return leader;
}

function originName(entity: WorldEntity): string {
  if (typeof entity.components.name === 'string') return entity.components.name;
  if (typeof entity.components.label === 'string') return entity.components.label;
  return entity.subtype ? `${entity.subtype} settlement` : `Settlement ${entity.id.slice(-7)}`;
}

function selectOriginSettlement(snapshot: Awaited<ReturnType<WorldProvider['exportSnapshot']>>, requestedId?: string): WorldEntity {
  if (requestedId) {
    const requested = snapshot.entities.find((entity) => entity.id === requestedId && entity.kind === 'settlement' && entity.spatial);
    if (!requested) throw new Error(`WorldProvider does not expose a spatial origin settlement: ${requestedId}`);
    return requested;
  }
  const candidates = snapshot.entities
    .filter((entity) => entity.kind === 'settlement' && entity.spatial)
    .sort((a, b) => a.id.localeCompare(b.id));
  const origin = candidates[0];
  if (!origin) throw new Error('WorldProvider snapshot contains no spatial settlement suitable for sandbox origin.');
  return origin;
}

export interface SandboxBootstrapOptions {
  seed?: number;
  population?: number;
  clockPolicy?: WorldClockPolicy;
  originEntityId?: string;
}

export async function createInitialSandboxState(provider: WorldProvider, options: SandboxBootstrapOptions = {}): Promise<SandboxGameState> {
  const accepted = await acceptWorldProvider(provider);
  let providerSnapshot = await provider.exportSnapshot(2);
  const origin = selectOriginSettlement(providerSnapshot, options.originEntityId);
  const originEntityId = origin.id;
  if (!origin.spatial) throw new Error(`WorldProvider origin settlement is not spatial: ${originEntityId}`);
  const seed = normalizeSeed(options.seed ?? accepted.manifest.seed);
  const scratch = { rngState: seed, sequence: 0 };
  const baseClockPolicy = options.clockPolicy ?? DEFAULT_MOCK_CLOCK_POLICY;
  const clockPolicy: WorldClockPolicy = {
    ...baseClockPolicy,
    epochWorldTick: baseClockPolicy.epochWorldTick ?? accepted.manifest.currentTick,
    epochGameMinute: baseClockPolicy.epochGameMinute ?? 0,
  };
  const startWorldTick = Math.floor((clockPolicy.epochWorldTick ?? accepted.manifest.currentTick) + 360 * clockPolicy.worldTicksPerDay / 1440);
  if (startWorldTick > accepted.manifest.currentTick) {
    await provider.advance({
      toTick: startWorldTick,
      activeRegions: [{ center: structuredClone(origin.spatial), radiusKm: clockPolicy.activeRadiusKm, requestedDetailRank: 0 }],
      observationOwnerIds: [originEntityId],
    });
    providerSnapshot = await provider.exportSnapshot(2);
  }
  const activeOrigin = providerSnapshot.entities.find((entity) => entity.id === originEntityId) ?? origin;
  const materialized = await materializeOriginPopulation(provider, activeOrigin, 1, options.population);
  const agents = materialized.agents;
  const leader = selectLeader(agents);
  const worldKnowledge = await provider.getKnowledge(originEntityId);
  const knowledge = convertWorldKnowledge(worldKnowledge, agents, 1);
  applyKnowledgeToAgents(knowledge, agents);
  const institutions = institutionsFromProvider(materialized.providerInstitutions, agents);
  for (const agent of agents) {
    for (const institution of institutions) if (institution.memberIds.includes(agent.id) && !agent.affiliationIds?.includes(institution.id)) (agent.affiliationIds ??= []).push(institution.id);
  }
  const resources = resourcesFromProvider(activeOrigin, materialized.providerInstitutions);
  const doctrine: ExpeditionDoctrine = { id: 'doctrine:careful-return', name: 'Careful Return', riskTolerance: 0.35, retreatHealth: 45, maxSilentHours: 18, campBeforeDark: true, prioritizeRescue: true, contactPolicy: 'observe', encounterInstruction: 'withdraw' };
  const activeManifest = (await provider.getManifest());
  const social = typeof activeOrigin.components.social === 'object' && activeOrigin.components.social && !Array.isArray(activeOrigin.components.social) ? activeOrigin.components.social as Record<string, unknown> : {};
  const institutionalCapacity = typeof social.institutionalCapacityIndex === 'number' ? social.institutionalCapacityIndex : 0.5;
  const waterAccess = typeof activeOrigin.components.waterAccessIndex === 'number' ? activeOrigin.components.waterAccessIndex : 0.7;
  const medical = materialized.providerInstitutions.find((entry) => entry.components.institutionType === 'medical-practice');
  const medicalCapacity = typeof medical?.components.capacityIndex === 'number' ? medical.components.capacityIndex : 0.35;
  const initialChronicleId = nextId(scratch, 'chronicle');
  const state: SandboxGameState = {
    schemaVersion: 1, saveId: `sandbox-${seed.toString(16)}`, seed, rngState: scratch.rngState, sequence: scratch.sequence, status: 'running',
    clock: { day: 1, minuteOfDay: 360, worldTick: activeManifest.currentTick },
    clockPolicy,
    world: {
      manifest: activeManifest, providerRecipeId: activeManifest.recipeId, providerEngineVersion: activeManifest.engineVersion,
      originEntityId, discoveredVariableIds: [...accepted.variableIds].sort(), discoveredCapabilities: [...accepted.capabilities].sort(), providerSnapshot,
    },
    settlement: {
      id: originEntityId, worldEntityId: originEntityId, name: originName(activeOrigin), position: structuredClone(activeOrigin.spatial ?? origin.spatial), leaderId: leader.id,
      successionRule: 'assembly-trust', resources, housingCapacity: Math.max(agents.length + 4, Math.round(agents.length * (1.08 + institutionalCapacity * 0.2))),
      sanitation: Math.round(45 + institutionalCapacity * 40), waterSafety: Math.round(45 + waterAccess * 45), clinicCapacity: Math.max(2, Math.round(agents.length * (0.05 + medicalCapacity * 0.12))), childcareCapacity: Math.max(2, Math.round(agents.length * 0.25)), defense: Math.round(35 + institutionalCapacity * 30),
      laborPriorities: { forage: 7, water: 8, medicine: 6, repair: 5, sanitation: 6, care: 6, records: 3, guard: 4, rest: 5, 'explore-prep': 3 },
      households: materialized.households, institutions, localKnowledgeIds: knowledge.map((entry) => entry.id), activeRecordIds: [],
    },
    agents, pregnancies: [], knowledge, records: [], researchProjects: [], anomalyPractices: [], policyProposals: [], doctrines: [doctrine], expeditions: [], encounters: [], externalActors: [], externalContacts: [], chronicle: [
      { id: initialChronicleId, day: 1, minuteOfDay: 360, kind: 'settlement', title: 'Simulation begins', text: `${agents.length} provider-materialized individuals form the active player community; their stable Worldgen identities remain authoritative across LOD/save-load.`, entityIds: [originEntityId, leader.id, ...agents.slice(0, 4).map((entry) => entry.id)] },
    ],
    generatedEndings: [],
    providerMutations: { nextCommandOrdinal: 1, providerCommitGeneration: 0, retiredThroughOrdinal: 0, retiredReceiptCount: 0, retiredAcceptedCount: 0, retiredRejectedCount: 0, retiredEventCount: 0, retiredCausalRecordCount: 0, commandReceipts: [] },
    diagnostics: { stepCount: 0, lastWorldAdvanceFrom: accepted.manifest.currentTick, lastWorldAdvanceTo: activeManifest.currentTick, replayHash: '' },
  };
  initializeNames(state);
  initializeResourceLedgerFromWorld(state);
  syncLegacyKnowledgeShadow(state);
  synchronizeIncidentLedger(state);
  ensureSurvivalCampaignState(state);
  return state;
}

import { addChronicle, clamp, findAgent, nextStateId, settlementAgents } from './stateUtils.js';
import { syncLegacyKnowledgeShadow } from './knowledgeLegacyAdapter.js';
import type { KnowledgeEntry, PhysicalInventoryItem, ResearchProject, SandboxGameState, SandboxStepSummary } from './types.js';

function projects(state: SandboxGameState): ResearchProject[] { return state.researchProjects ?? (state.researchProjects = []); }

function qualifiedResearchers(state: SandboxGameState): string[] {
  return settlementAgents(state)
    .filter((agent) => agent.health >= 35 && agent.fatigue < 85)
    .sort((a, b) => (b.skills.records + b.skills.medicine + b.skills.scouting + (b.personality?.curiosity ?? 50) / 2) - (a.skills.records + a.skills.medicine + a.skills.scouting + (a.personality?.curiosity ?? 50) / 2))
    .slice(0, 3).map((agent) => agent.id);
}

function sampleSourceIds(source: KnowledgeEntry): string[] {
  const ids = new Set<string>();
  if (source.requiresPhysicalSample && source.physicalEvidenceSourceEntityId) ids.add(source.physicalEvidenceSourceEntityId);
  for (const link of source.truthLinkIds) if (link.startsWith('sample-source:')) ids.add(link.slice('sample-source:'.length));
  return [...ids].filter(Boolean);
}

function sampleAtSettlement(state: SandboxGameState, sourceIds: string[]): PhysicalInventoryItem | undefined {
  if (!sourceIds.length) return undefined;
  return state.directPlay?.inventory.find((item) => {
    if (item.kind !== 'sample' || item.quantity <= 0 || !item.sourceEntityId || !sourceIds.includes(item.sourceEntityId)) return false;
    const owner = findAgent(state, item.ownerId);
    return Boolean(owner?.alive && !owner.expeditionId && (!owner.residence || owner.residence === 'settlement'));
  });
}

export function researchSampleGate(state: SandboxGameState, sourceKnowledgeId: string): {
  required: boolean; available: boolean; sourceEntityIds: string[]; sample?: PhysicalInventoryItem;
} {
  const source = state.knowledge.find((entry) => entry.id === sourceKnowledgeId && !entry.lost);
  if (!source) return { required: false, available: false, sourceEntityIds: [] };
  const sourceEntityIds = sampleSourceIds(source);
  if (!sourceEntityIds.length) return { required: false, available: true, sourceEntityIds };
  const sample = sampleAtSettlement(state, sourceEntityIds);
  return { required: true, available: Boolean(sample), sourceEntityIds, ...(sample ? { sample } : {}) };
}

export function startResearchProject(state: SandboxGameState, sourceKnowledgeId: string, researcherIds?: string[]): ResearchProject {
  const source = state.knowledge.find((entry) => entry.id === sourceKnowledgeId && !entry.lost);
  if (!source) throw new Error('Research requires an extant in-world knowledge claim.');
  const selected = [...new Set((researcherIds?.length ? researcherIds : qualifiedResearchers(state)).filter((id) => {
    const agent = findAgent(state, id); return Boolean(agent?.alive && (agent.residence ? agent.residence === 'settlement' : agent.expeditionId === null));
  }))];
  if (!selected.length) throw new Error('No available researcher can ground this project.');
  const institutionHasSource = state.settlement.localKnowledgeIds.includes(source.id);
  if (!institutionHasSource && !selected.some((id)=>source.holderIds.includes(id))) {
    const localHolder = source.holderIds.map((id)=>findAgent(state,id)).find((agent)=>Boolean(agent?.alive && !agent?.expeditionId && (!agent?.residence || agent.residence==='settlement')));
    if (!researcherIds?.length && localHolder) selected.unshift(localHolder.id);
    else throw new Error('Research requires the claim to be physically accessible through a participating holder or institutional record.');
  }
  const duplicate = projects(state).find((entry) => entry.status === 'active' && entry.sourceKnowledgeId === source.id);
  if (duplicate) return duplicate;
  const sampleGate = researchSampleGate(state, source.id);
  if (sampleGate.required && !sampleGate.sample) throw new Error('Research on direct field evidence requires its physical sample to be present at the settlement research context.');
  const project: ResearchProject = {
    id: nextStateId(state, 'research'), sourceKnowledgeId: source.id, subjectIds: [...source.subjectIds], hypothesis: source.claim,
    researcherIds: selected, basisKnowledgeIds: [source.id], startedDay: state.clock.day, completedDay: null, progress: 0,
    confidence: Math.min(0.8, Math.max(0.12, source.confidence * 0.65)), status: 'active',
    ...(sampleGate.sample ? { sampleItemId: sampleGate.sample.id, sampleSourceEntityId: sampleGate.sample.sourceEntityId } : {}),
  };
  projects(state).push(project);
  addChronicle(state, {
    kind: 'knowledge', title: 'Research project started',
    text: `Local investigators began testing: ${source.claim}${project.sampleItemId ? ' A provenance-bearing field sample is physically committed to the work.' : ''}`,
    entityIds: [project.id, ...selected, ...source.subjectIds, ...(project.sampleItemId ? [project.sampleItemId] : [])],
  });
  return project;
}

function researchSampleStillPresent(state: SandboxGameState, project: ResearchProject): boolean {
  if (!project.sampleItemId) return true;
  const item = state.directPlay?.inventory.find((entry) => entry.id === project.sampleItemId && entry.kind === 'sample' && entry.quantity > 0);
  if (!item || (project.sampleSourceEntityId && item.sourceEntityId !== project.sampleSourceEntityId)) return false;
  const owner = findAgent(state, item.ownerId);
  return Boolean(owner?.alive && !owner.expeditionId && (!owner.residence || owner.residence === 'settlement'));
}

function completeResearch(state: SandboxGameState, project: ResearchProject, summary: SandboxStepSummary): void {
  const source = state.knowledge.find((entry) => entry.id === project.sourceKnowledgeId);
  if (!source) { project.status = 'abandoned'; return; }
  const confidence = clamp(project.confidence, 0.05, 0.93);
  const result: KnowledgeEntry = {
    id: nextStateId(state, 'knowledge'), subjectIds: [...project.subjectIds],
    claim: `Local research provisionally ${confidence >= source.confidence ? 'supports' : 'qualifies'} the hypothesis: ${project.hypothesis}`,
    confidence, acquiredDay: state.clock.day, carrier: 'institution', holderIds: [...project.researcherIds], sourceKnowledgeId: source.id,
    truthLinkIds: [...source.truthLinkIds], lost: false,
    ...(project.sampleSourceEntityId ? { physicalEvidenceSourceEntityId: project.sampleSourceEntityId } : {}),
  };
  state.knowledge.push(result); state.settlement.localKnowledgeIds.push(result.id);
  syncLegacyKnowledgeShadow(state);
  for (const researcherId of project.researcherIds) {
    const researcher=findAgent(state,researcherId);
    if(researcher && !researcher.knowledgeIds.includes(result.id)) researcher.knowledgeIds.push(result.id);
  }
  project.resultKnowledgeId = result.id; project.completedDay = state.clock.day; project.status = 'completed'; project.progress = 100;
  summary.knowledgeUpdates.push(`${project.id} completed with confidence ${Math.round(confidence * 100)}%.`);
  addChronicle(state, { kind: 'knowledge', title: 'Research result recorded', text: `${result.claim}. This remains an epistemic product; research did not reveal hidden World Truth directly.`, entityIds: [project.id, result.id, ...project.researcherIds, ...(project.sampleItemId ? [project.sampleItemId] : [])] });
}

export function simulateResearchInterval(state: SandboxGameState, hours: number, summary: SandboxStepSummary): void {
  for (const project of projects(state).filter((entry) => entry.status === 'active')) {
    const researchers = project.researcherIds.map((id) => findAgent(state, id)).filter((agent) => Boolean(agent?.alive && (agent.residence ? agent.residence === 'settlement' : agent.expeditionId === null)));
    if (!researchers.length || !researchSampleStillPresent(state, project)) continue;
    const competence = researchers.reduce((sum, agent) => sum + ((agent?.skills.records ?? 35) * 0.38 + (agent?.skills.medicine ?? 35) * 0.22 + (agent?.skills.scouting ?? 35) * 0.2 + (agent?.personality?.curiosity ?? 50) * 0.2), 0) / researchers.length;
    const recordSupport = Math.min(1, state.settlement.resources.records / 12);
    const sampleSupport = project.sampleItemId ? 1.08 : 1;
    const delta = hours / 24 * (2.2 + competence / 24) * (0.65 + recordSupport * 0.35) * sampleSupport;
    project.progress = clamp(project.progress + delta, 0, 100);
    const source = state.knowledge.find((entry) => entry.id === project.sourceKnowledgeId);
    const skepticism = researchers.reduce((sum, agent) => sum + (agent?.faith?.interpretationTags.includes('skepticism') ? agent.faith.commitment : 0), 0) / researchers.length;
    project.confidence = clamp((project.confidence * 0.985) + ((source?.confidence ?? 0.4) * 0.012) + (competence - 50) / 5000 - skepticism / 20000, 0.05, 0.93);
    for (const agent of researchers) if (agent) agent.experience[`research:${project.id}`] = (agent.experience[`research:${project.id}`] ?? 0) + hours;
    if (project.progress >= 100) completeResearch(state, project, summary);
  }
}

import { applyCompletedResearch } from './researchApplications.js';
import { atSettlement, canReadEvidence } from './evidenceAccess.js';
import { reservedHoursDuringCurrentInterval } from './directPlay.js';
import { agentAbilityFactors } from './aging.js';
import { addChronicle, agentAgeYears, clamp, effectiveSkill, findAgent, nextStateId, settlementAgents } from './stateUtils.js';
import { syncLegacyKnowledgeShadow } from './knowledgeLegacyAdapter.js';
import type { KnowledgeEntry, PhysicalInventoryItem, ResearchProject, SandboxAgent, SandboxGameState, SandboxStepSummary } from './types.js';

function projects(state: SandboxGameState): ResearchProject[] { return state.researchProjects ?? (state.researchProjects = []); }

export function researchWorkerAvailable(state: SandboxGameState, agent: SandboxAgent): boolean {
  return atSettlement(state, agent.id) && agentAgeYears(state, agent) >= 16 && agent.health >= 35 && agent.fatigue < 85
    && agent.currentPlan?.kind !== 'refuse-order'
    && !agent.pathology.some((entry) => ['active', 'chronic'].includes(entry.status) && entry.severity >= 80);
}

function qualifiedResearchers(state: SandboxGameState): string[] {
  return settlementAgents(state)
    .filter((agent) => researchWorkerAvailable(state, agent))
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
    const agent = findAgent(state, id); return Boolean(agent && researchWorkerAvailable(state, agent));
  }))];
  if (!selected.length) throw new Error('No available researcher can ground this project.');
  if (selected.length > 3) throw new Error('研究の担当者は3人までです。');
  const institutionHasSource = state.settlement.localKnowledgeIds.includes(source.id);
  if (!institutionHasSource && !selected.some((id)=>source.holderIds.includes(id))) {
    const localHolder = source.holderIds.map((id)=>findAgent(state,id)).find((agent)=>agent && researchWorkerAvailable(state, agent));
    if (!researcherIds?.length && localHolder) { selected.unshift(localHolder.id); selected.splice(3); }
    else throw new Error('Research requires the claim to be physically accessible through a participating holder or institutional record.');
  }
  const duplicate = projects(state).find((entry) => entry.status === 'active' && entry.sourceKnowledgeId === source.id);
  if (duplicate && duplicate.hypothesis !== source.claim) duplicate.status = 'abandoned';
  else if (duplicate) return duplicate;
  const sampleGate = researchSampleGate(state, source.id);
  if (sampleGate.required && !sampleGate.sample) throw new Error('Research on direct field evidence requires its physical sample to be present at the settlement research context.');
  const project: ResearchProject = {
    id: nextStateId(state, 'research'), sourceKnowledgeId: source.id, subjectIds: [...source.subjectIds], hypothesis: source.claim,
    researcherIds: selected, basisKnowledgeIds: [source.id], startedDay: state.clock.day, completedDay: null, progress: 0,
    confidence: Math.min(0.8, source.confidence * 0.65), status: 'active', contributors: [],
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

/** Reassign people and the matching physical sample without replacing the original hypothesis. */
export function updateResearchParticipants(state: SandboxGameState, actorId: string, projectId: string, researcherIds: string[]): ResearchProject {
  const project = projects(state).find((entry) => entry.id === projectId);
  const source = project && state.knowledge.find((entry) => entry.id === project.sourceKnowledgeId);
  if (!project || project.status !== 'active' || !source || source.lost || source.claim !== project.hypothesis)
    throw new Error('研究の元の根拠が失われた・変わったため、同じ研究を再開できません。');
  if (!atSettlement(state, actorId) || !canReadEvidence(state, actorId, source))
    throw new Error('研究の更新には、拠点で元の根拠を読める同席者が必要です。');
  const selected = [...new Set(researcherIds)];
  if (!selected.length || selected.length > 3 || selected.some((id) => { const agent = findAgent(state, id); return !agent || !researchWorkerAvailable(state, agent); }))
    throw new Error('研究には、作業できる拠点の16歳以上の住民を1〜3人選んでください。');
  if (!state.settlement.localKnowledgeIds.includes(source.id) && !selected.some((id) => source.holderIds.includes(id)))
    throw new Error('研究の担当者に根拠の保持者を含めるか、先にArchiveへ記録してください。');
  const gate = researchSampleGate(state, source.id);
  if (gate.required && !gate.sample) throw new Error('採取元に対応する現物サンプルを拠点へ持ち帰ってください。');
  const previous = [...project.researcherIds];
  project.researcherIds = selected;
  if (gate.sample) { project.sampleItemId = gate.sample.id; project.sampleSourceEntityId = gate.sample.sourceEntityId!; }
  delete project.pauseReason;
  addChronicle(state, {kind:'knowledge',title:'研究の担当者・サンプルを更新',text:'元の仮説・根拠と進捗を保持し、現地で参照できる担当者と現物を研究へ接続した。',entityIds:[project.id,...previous,...selected,...(gate.sample?[gate.sample.id]:[])]});
  return project;
}

function researchSampleStillPresent(state: SandboxGameState, project: ResearchProject): boolean {
  if (!project.sampleItemId) return true;
  const item = state.directPlay?.inventory.find((entry) => entry.id === project.sampleItemId && entry.kind === 'sample' && entry.quantity > 0);
  if (!item || (project.sampleSourceEntityId && item.sourceEntityId !== project.sampleSourceEntityId)) return false;
  const owner = findAgent(state, item.ownerId);
  return Boolean(owner?.alive && !owner.expeditionId && (!owner.residence || owner.residence === 'settlement'));
}

export function researchPauseReason(state: SandboxGameState, project: ResearchProject): string | undefined {
  const source = state.knowledge.find((entry) => entry.id === project.sourceKnowledgeId);
  if (!source || source.lost || source.claim !== project.hypothesis) return '元の根拠が失われた・変わった';
  const researchers = project.researcherIds.map((id) => findAgent(state, id)).filter((agent): agent is SandboxAgent => Boolean(agent && researchWorkerAvailable(state, agent)));
  if (!researchers.length) return '作業できる担当者が拠点にいない / 担当者を更新';
  if (!state.settlement.localKnowledgeIds.includes(source.id) && !researchers.some((agent) => source.holderIds.includes(agent.id))) return '参加する根拠の保持者またはArchiveが不在';
  if (!researchSampleStillPresent(state, project)) return '研究に接続した現物サンプルが不在 / 現物を持ち帰って更新';
  return undefined;
}

function completeResearch(state: SandboxGameState, project: ResearchProject, researchers: SandboxAgent[], summary: SandboxStepSummary): void {
  const source = state.knowledge.find((entry) => entry.id === project.sourceKnowledgeId);
  if (!source || source.lost || source.claim !== project.hypothesis) { project.status = 'abandoned'; return; }
  const confidence = Math.min(source.confidence, clamp(project.confidence, 0, 0.93));
  const result: KnowledgeEntry = {
    id: nextStateId(state, 'knowledge'), subjectIds: [...project.subjectIds],
    claim: `Local research provisionally reviews the available evidence: ${project.hypothesis}`,
    confidence, acquiredDay: state.clock.day, carrier: 'institution', holderIds: researchers.map((agent) => agent.id), sourceKnowledgeId: source.id,
    truthLinkIds: [...source.truthLinkIds], lost: false,
    ...((project.sampleSourceEntityId ?? source.physicalEvidenceSourceEntityId) ? { physicalEvidenceSourceEntityId: project.sampleSourceEntityId ?? source.physicalEvidenceSourceEntityId } : {}),
    ...(source.entityObservation ? { entityObservation: structuredClone(source.entityObservation) } : {}),
    ...(source.treatmentObservation ? { treatmentObservation: structuredClone(source.treatmentObservation) } : {}),
    ...(source.requiresPhysicalSample ? { requiresPhysicalSample: true } : {}),
  };
  state.knowledge.push(result); state.settlement.localKnowledgeIds.push(result.id);
  syncLegacyKnowledgeShadow(state);
  for (const researcher of researchers) {
    if(!researcher.knowledgeIds.includes(result.id)) researcher.knowledgeIds.push(result.id);
  }
  applyCompletedResearch(state,project,result,source);
  project.resultKnowledgeId = result.id; project.completedDay = state.clock.day; project.status = 'completed'; project.progress = 100;
  summary.knowledgeUpdates.push(`${project.id} completed with confidence ${Math.round(confidence * 100)}%.`);
  addChronicle(state, { kind: 'knowledge', title: 'Research result recorded', text: `${result.claim}. This remains an epistemic product; research did not reveal hidden World Truth directly.`, entityIds: [project.id, result.id, ...project.researcherIds, ...(project.sampleItemId ? [project.sampleItemId] : [])] });
}

/** Two hours per day and person, shared by all active research, drawn from local labor. */
export function simulateResearchInterval(state: SandboxGameState, hours: number, summary: SandboxStepSummary, otherWork: Map<string,number> = new Map()): Map<string,number> {
  const allocated = new Map<string,number>();
  if (!Number.isFinite(hours) || hours <= 0) return allocated;
  for (const project of projects(state).filter((entry) => entry.status === 'active')) {
    const source = state.knowledge.find((entry) => entry.id === project.sourceKnowledgeId);
    if (!source || source.lost || source.claim !== project.hypothesis) {
      project.status = 'abandoned';
      summary.knowledgeUpdates.push(`${project.id} abandoned because its original evidence was lost or changed.`);
      continue;
    }
    const reason = researchPauseReason(state, project);
    if (reason) { project.pauseReason = reason; continue; }
    delete project.pauseReason;
    const researchers = project.researcherIds.map((id) => findAgent(state, id)).filter((agent): agent is SandboxAgent => Boolean(agent && researchWorkerAvailable(state, agent)));
    if (!state.settlement.localKnowledgeIds.includes(source.id) && !researchers.some((agent) => source.holderIds.includes(agent.id)
      && Math.min(hours-reservedHoursDuringCurrentInterval(state,agent.id,hours)-(otherWork.get(agent.id)??0)-(allocated.get(agent.id)??0),hours/12-(allocated.get(agent.id)??0))>0)) {
      project.pauseReason = '根拠の保持者が別の行動で作業できない'; continue;
    }
    const recordSupport = Math.min(1, state.settlement.resources.records / 12);
    const sampleSupport = project.sampleItemId ? 1.08 : 1;
    const worked: SandboxAgent[] = [];
    for (const agent of researchers) {
      const used = allocated.get(agent.id) ?? 0;
      const remaining = hours - reservedHoursDuringCurrentInterval(state,agent.id,hours) - (otherWork.get(agent.id) ?? 0) - used;
      const competence = effectiveSkill(state,agent,'records') * .38 + effectiveSkill(state,agent,'medicine') * .22 + effectiveSkill(state,agent,'scouting') * .2 + (agent.personality?.curiosity ?? 50) * .2;
      const rate = (2.2 + competence / 24) * (.65 + recordSupport * .35) * sampleSupport / 6;
      const spent = Math.max(0,Math.min(hours / 12 - used,remaining,(100-project.progress)/rate));
      if (spent <= 0) continue;
      worked.push(agent); allocated.set(agent.id,used+spent); project.progress = clamp(project.progress+spent*rate,0,100);
      const contribution = project.contributors ?? (project.contributors = []);
      let entry = contribution.find((entry) => entry.agentId === agent.id);
      if (!entry) { entry = {agentId:agent.id,hours:0}; contribution.push(entry); }
      entry.hours += spent;
      agent.experience[`research:${project.id}`] = (agent.experience[`research:${project.id}`] ?? 0) + spent;
      const abilities = agentAbilityFactors(state,agent);
      agent.skills.records = Math.min(100,agent.skills.records + spent * .002 * abilities.learning);
      agent.fatigue = clamp(agent.fatigue + 8 * spent / 6 / Math.max(.3,abilities.physical));
    }
    if (!worked.length) { project.pauseReason = '直接行動・教育・計画・別の研究で作業時間を使っている'; continue; }
    delete project.pauseReason;
    // Time and competence process evidence; they do not supply new supporting observations.
    project.confidence = Math.min(source.confidence, clamp(project.confidence, 0, 0.93));
    if (project.progress >= 100) completeResearch(state, project, researchers.filter((agent) => project.contributors?.some((entry) => entry.agentId===agent.id && entry.hours>0)), summary);
  }
  return allocated;
}

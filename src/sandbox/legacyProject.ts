import { accessibleEvidence, atSettlement } from './evidenceAccess.js';
import { readableTrials, visibleInquiries } from './explorationInquiry.js';
import { accessibleArtifactRecords } from './loreArtifacts.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord } from './knowledgeSimulation.js';
import { researchApplicationIsActive } from './researchApplications.js';
import { syncLegacyKnowledgeShadow } from './knowledgeLegacyAdapter.js';
import { reservedHoursDuringCurrentInterval } from './directPlay.js';
import { consumeResourceLots, ensureResourceLedgerState } from './resourceLedger.js';
import { addChronicle, agentAgeYears, effectiveSkill, findAgent, nextStateId } from './stateUtils.js';
import type { SandboxGameState, SandboxStepSummary, SettlementResourceKey } from './types.js';

export type LegacyProjectKind = 'waterworks'|'archive';
export interface LegacyProject {
  id: string; kind: LegacyProjectKind; name: string; founderId: string; stewardId: string; workerIds: string[];
  knowledgeId: string; knowledgeIds: string[]; recordId: string; createdDay: number; status: 'active'|'paused'|'completed';
  phases: Array<{name:string;requiredHours:number;workHours:number;materials:Partial<Record<SettlementResourceKey,number>>;committed:Array<{lotId:string;resourceKey:SettlementResourceKey;quantity:number}>;funded:boolean}>;
  contributors: Array<{agentId:string;hours:number}>; stewardHistory: Array<{agentId:string;day:number}>; pauseReason?: string;
}
export function legacyProjectLabel(kind: LegacyProjectKind): string { return kind === 'waterworks' ? '世代をつなぐ水管理設備' : '共同体の記録庫'; }
export function projectPrerequisites(state: SandboxGameState, actorId: string, kind: LegacyProjectKind): string[] {
  if (!atSettlement(state,actorId)) return [];
  const available = new Set(accessibleEvidence(state,actorId).map((entry) => entry.id));
  if (kind === 'waterworks') {
    for (const trial of visibleInquiries(state,actorId).flatMap((inquiry) => readableTrials(state,actorId,inquiry))) {
      if (!(trial.after.microbialRisk < trial.before.microbialRisk || trial.after.turbidity < trial.before.turbidity)) continue;
      const practice = state.researchApplications?.find((application) => application.domain === 'water' && researchApplicationIsActive(state,application)
        && state.knowledge.some((entry) => entry.id === application.knowledgeId && entry.sourceKnowledgeId === trial.knowledgeId));
      if (practice && available.has(trial.knowledgeId) && available.has(practice.knowledgeId)) return [trial.knowledgeId,practice.knowledgeId];
    }
    return [];
  }
  const reading = accessibleArtifactRecords(state,actorId).find((item) => item.reading?.decodedKnowledgeId && available.has(item.reading.decodedKnowledgeId));
  return reading?.reading?.decodedKnowledgeId ? [reading.reading.decodedKnowledgeId] : [];
}

export function startLegacyProject(state: SandboxGameState, actorId: string, kind: LegacyProjectKind): LegacyProject {
  if (!['waterworks','archive'].includes(kind)) throw new Error('共同体の計画を選んでください。');
  if ((state.legacyProjects ?? []).some((entry) => entry.kind === kind)) throw new Error('同じ設備計画は既にあります。');
  const basis = projectPrerequisites(state,actorId,kind);
  if (!basis.length) throw new Error(kind === 'waterworks' ? '現地照合、水の実測試行、その試行に基づく研究手順が必要です。' : '現物の写しを読み解いた記録が必要です。');
  const name = legacyProjectLabel(kind);
  const knowledge = addObservedKnowledge(state,[actorId],[state.settlement.id],`${name}の設計記録。既存の観測・試行を根拠に、基礎・設備・維持手順を順に整える。`,.65,undefined,[],{promoteToSettlement:false});
  const record = institutionalizeKnowledgeRecord(state,actorId,knowledge.id);
  record.title = `${name} / 設計と継承記録`;
  record.body = [knowledge.claim,...basis.map((id) => state.knowledge.find((entry) => entry.id === id)!.claim)].join('\n');
  record.knowledgeIds = [knowledge.id,...basis];
  for (const id of basis) if (!state.settlement.localKnowledgeIds.includes(id)) state.settlement.localKnowledgeIds.push(id);
  const phases: LegacyProject['phases'] = (kind === 'waterworks' ? [
    {name:'基礎と導水路',requiredHours:8000,materials:{timber:40,scrap:12}},
    {name:'処理設備',requiredHours:16000,materials:{scrap:30,cloth:12}},
    {name:'維持手順と引継ぎ',requiredHours:24000,materials:{records:12,fuel:10}},
  ] : [
    {name:'耐候性の収納',requiredHours:4000,materials:{timber:20,scrap:8}},
    {name:'複製と分類',requiredHours:6000,materials:{records:20,cloth:8}},
    {name:'継承の運用',requiredHours:8000,materials:{records:12,timber:10}},
  ]).map((phase) => ({...phase,workHours:0,committed:[],funded:false}));
  const project: LegacyProject = {id:nextStateId(state,'legacy-project'),kind,name,founderId:actorId,stewardId:actorId,workerIds:[actorId],knowledgeId:knowledge.id,knowledgeIds:[knowledge.id,...basis],recordId:record.id,createdDay:state.clock.day,status:'active',phases,contributors:[],stewardHistory:[{agentId:actorId,day:state.clock.day}]};
  (state.legacyProjects ??= []).push(project);
  syncLegacyKnowledgeShadow(state);
  addChronicle(state,{kind:'knowledge',title:`${name}を始めた`,text:'設計は物理的な記録へ保存した。担当者が代わっても設備・投入資材・作業履歴を保持する。',entityIds:[project.id,record.id,actorId]});
  return project;
}

function availableProject(state: SandboxGameState, actorId: string, projectId: string): LegacyProject {
  const project = state.legacyProjects?.find((entry) => entry.id === projectId);
  if (!atSettlement(state,actorId) || !project || !accessibleEvidence(state,actorId).some((entry) => entry.id === project.knowledgeId)) throw new Error('現地で設計記録を参照する必要があります。');
  return project;
}
export function adoptLegacyProject(state: SandboxGameState, actorId: string, projectId: string): void {
  const project = availableProject(state,actorId,projectId);
  if (project.stewardId === actorId) return;
  project.stewardId = actorId; project.stewardHistory.push({agentId:actorId,day:state.clock.day});
  addChronicle(state,{kind:'knowledge',title:`${project.name}を引き継いだ`,text:'既存の設備・資材投入・作業履歴を読み、担い手として引き継いだ。',entityIds:[project.id,actorId]});
}
export function setLegacyProjectWorkers(state: SandboxGameState, actorId: string, projectId: string, workerIds: string[]): void {
  const project = availableProject(state,actorId,projectId);
  const workers = [...new Set(workerIds)];
  if (workers.length > 4 || workers.some((id) => !atSettlement(state,id) || agentAgeYears(state,findAgent(state,id)!) < 16)) throw new Error('同席する16歳以上の担い手を4人まで選んでください。');
  project.workerIds = workers;
}
export function setLegacyProjectPaused(state: SandboxGameState, actorId: string, projectId: string, paused: boolean): void {
  const project = availableProject(state,actorId,projectId);
  if (project.status === 'completed') return;
  project.status = paused ? 'paused' : 'active';
}

/** Reserve one hour per game day and worker; subtract it from ordinary labor and education. */
export function simulateLegacyProjects(state: SandboxGameState, hours: number, summary: SandboxStepSummary, education: Map<string,number> = new Map()): Map<string,number> {
  const allocated = new Map<string,number>();
  if (!Number.isFinite(hours) || hours <= 0) return allocated;
  for (const project of (state.legacyProjects ?? []).filter((entry) => entry.status === 'active')) {
    const record = state.records.find((entry) => entry.id === project.recordId && entry.integrity > .05 && entry.copies > 0);
    if (!record || project.knowledgeIds.some((id) => !state.settlement.localKnowledgeIds.includes(id) || !state.knowledge.some((entry) => entry.id === id && !entry.lost))) { project.pauseReason = '設計や根拠の記録を参照できない'; continue; }
    const phase = project.phases.find((entry) => entry.workHours < entry.requiredHours);
    if (!phase) continue;
    const workers = project.workerIds.map((id) => findAgent(state,id)).filter((agent) => agent && atSettlement(state,agent.id) && agentAgeYears(state,agent) >= 16 && agent.health > 35 && agent.fatigue < 85 && agent.currentPlan?.kind !== 'refuse-order' && !agent.pathology.some((entry) => ['active','chronic'].includes(entry.status) && entry.severity >= 80));
    if (!workers.some((agent) => agent && hours-reservedHoursDuringCurrentInterval(state,agent.id,hours)-(education.get(agent.id)??0)-(allocated.get(agent.id)??0) > 0)) { project.pauseReason = '現地の担い手または作業時間が不在'; continue; }
    if (!phase.funded) {
      ensureResourceLedgerState(state);
      const costs = Object.entries(phase.materials) as Array<[SettlementResourceKey,number]>;
      if (costs.some(([key,quantity]) => state.settlement.resources[key] < quantity)) { project.pauseReason = '工程の資材が不足'; continue; }
      phase.committed = costs.flatMap(([key,amount]) => consumeResourceLots(state,{resourceKey:key,amount}).map((line) => ({...line,resourceKey:key})));
      phase.funded = true;
    }
    delete project.pauseReason;
    for (const agent of workers) {
      if (!agent || phase.workHours >= phase.requiredHours) continue;
      const remaining = hours-reservedHoursDuringCurrentInterval(state,agent.id,hours)-(education.get(agent.id)??0)-(allocated.get(agent.id)??0);
      const rate = Math.max(.25,Math.min(1.5,effectiveSkill(state,agent,project.kind === 'waterworks' ? 'construction' : 'records')/60));
      const spent = Math.max(0,Math.min(hours/24,remaining,(phase.requiredHours-phase.workHours)/rate));
      allocated.set(agent.id,(allocated.get(agent.id)??0)+spent); phase.workHours = Math.min(phase.requiredHours,phase.workHours+spent*rate);
      let contribution = project.contributors.find((entry) => entry.agentId === agent.id);
      if (!contribution) { contribution = {agentId:agent.id,hours:0}; project.contributors.push(contribution); }
      contribution.hours += spent;
      // Maintaining the working drawings is part of the allocated work, not free global preservation.
      record.integrity = Math.min(1,record.integrity + spent * .001);
    }
    if (phase.workHours >= phase.requiredHours) summary.settlementUpdates.push(`${project.name}: ${phase.name}を完了。`);
    if (project.phases.every((entry) => entry.workHours >= entry.requiredHours)) {
      project.status = 'completed'; addChronicle(state,{kind:'knowledge',title:`${project.name}が完成`,text:project.kind === 'waterworks' ? 'ろ過設備を利用できる。化学汚染への万能な効果は主張しない。' : '保管設備で記録の劣化を抑える。',entityIds:[project.id,project.recordId]});
    }
  }
  return allocated;
}

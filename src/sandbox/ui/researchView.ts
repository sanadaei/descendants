import { atSettlement } from '../evidenceAccess.js';
import { researchPauseReason, researchWorkerAvailable } from '../researchSimulation.js';
import { agentAgeYears, settlementAgents } from '../stateUtils.js';
import { compactText, esc } from './viewHelpers.js';
import type { SandboxGameState } from '../types.js';

export function renderResearchProjects(state: SandboxGameState): string {
  const projects = state.researchProjects ?? [];
  const locals = settlementAgents(state).filter((agent) => atSettlement(state,agent.id) && agentAgeYears(state,agent)>=16);
  return `<div class="desc-pda-subhead">RESEARCH ${projects.length}</div><p>一人につき1日2時間までを全研究で共有し、通常労働から割り当てます。担当者・現物の更新は元の仮説と進捗を保持します。</p>${projects.slice(-8).reverse().map((project) => {
    const reason = project.status==='active' ? researchPauseReason(state,project) ?? project.pauseReason : undefined;
    const workers = project.researcherIds.map((id) => state.agents.find((agent)=>agent.id===id)?.name ?? id).join('、');
    return `<article class="desc-pda-mini-record desc-research-project" data-research-card="${esc(project.id)}"><strong>${esc(compactText(project.hypothesis,96))}</strong><small>${project.progress.toFixed(1)}% · ${esc(project.status)} · ${esc(project.practicalOutcome??'対象に沿った手順を検証中')} · confidence ${Math.round(project.confidence*100)}%</small><p>担当者: ${esc(workers)}</p>${reason?`<p>停止理由: ${esc(reason)}</p>`:''}<small>記録した実作業 ${(project.contributors??[]).reduce((sum,entry)=>sum+entry.hours,0).toFixed(1)}時間</small>${project.status==='active'?`<details><summary>担当者・現物を更新 / 3人まで</summary><div class="desc-research-workers">${locals.map((agent)=>`<label><input type="checkbox" data-research-worker="${esc(agent.id)}" ${project.researcherIds.includes(agent.id)?'checked':''} ${researchWorkerAvailable(state,agent)?'':'disabled'}>${esc(agent.name)}${researchWorkerAvailable(state,agent)?'':' / 休養・治療が必要'}</label>`).join('')}</div><button data-action="research-workers" data-project-id="${esc(project.id)}">進捗を保持して担当者・現物を更新</button></details>`:''}</article>`;
  }).join('')}`;
}

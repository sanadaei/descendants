import { atSettlement } from '../evidenceAccess.js';
import { legacyProjectLabel, projectPrerequisites } from '../legacyProject.js';
import { legacyFacilityActive } from '../legacyProjectBenefits.js';
import { agentAgeYears, settlementAgents } from '../stateUtils.js';
import { esc } from './viewHelpers.js';
import type { SandboxApp } from '../app.js';
type Context = ReturnType<SandboxApp['viewContext']>;

export function renderLegacyProjectPanel(ctx: Context): string {
  const actor = ctx.knowledgeAgent(); if (!actor || !atSettlement(ctx.state,actor.id)) return '';
  const projects = ctx.state.legacyProjects ?? [];
  const choices = (['waterworks','archive'] as const).filter((kind)=>!projects.some((entry)=>entry.kind===kind)).map((kind)=>`<div><strong>${legacyProjectLabel(kind)}</strong><p>${kind==='waterworks'?'水の現地照合 → 実測試行 → その実測を研究した手順が必要。完成するとろ過設備を使える。':'現物の写しを読解した記録が必要。完成すると記録の劣化を抑える。'}</p><button data-action="legacy-start" data-kind="${kind}" ${projectPrerequisites(ctx.state,actor.id,kind).length?'':'disabled'}>計画を記録 / 60分</button></div>`).join('');
  const locals = settlementAgents(ctx.state).filter((agent)=>!agent.expeditionId&&agentAgeYears(ctx.state,agent)>=16);
  return `<section class="desc-inquiry-panel"><h2>世代をつなぐ共同体の計画</h2><p>担い手一人につき1日1時間を通常労働から割り当てます。工程の資材、設備、設計記録、作業履歴を残し、担い手が亡くなっても進捗は保持します。</p>${choices}${projects.map((project)=>{
    const steward=ctx.state.agents.find((agent)=>agent.id===project.stewardId),total=project.phases.reduce((sum,phase)=>sum+phase.requiredHours,0),progress=project.phases.reduce((sum,phase)=>sum+phase.workHours,0),phase=project.phases.find((entry)=>entry.workHours<entry.requiredHours);
    return `<article class="desc-inquiry-card" data-legacy-card="${esc(project.id)}"><header><strong>${esc(project.name)}</strong><em>${project.status==='completed'?(legacyFacilityActive(ctx.state,project.kind)?'設備を利用中':'設備完成 / 記録を確認'):project.status==='paused'?'保留':'継続中'}</em></header><p>総進捗 ${(progress/total*100).toFixed(2)}% / ${phase?esc(phase.name):'全工程完了'}${project.pauseReason?` · ${esc(project.pauseReason)}`:''}</p><p>担い手: ${esc(steward?.name??'記録された担当者')}${steward&&!atSettlement(ctx.state,steward.id)?' / 現地に担い手がいない':''}</p><small>累積作業 ${project.contributors.reduce((sum,entry)=>sum+entry.hours,0).toFixed(1)}時間 / 引継ぎ ${Math.max(0,project.stewardHistory.length-1)}回</small>${phase?`<p>工程の資材: ${Object.entries(phase.materials).map(([key,quantity])=>`${esc(key)} ${quantity}`).join(' / ')}${phase.funded?' / 投入済み':' / 着手時に投入'}</p>`:''}<div><button data-action="legacy-adopt" data-project-id="${esc(project.id)}">計画を引き継ぐ</button>${project.status!=='completed'?`<button data-action="legacy-pause" data-project-id="${esc(project.id)}" data-paused="${project.status==='paused'?'0':'1'}">${project.status==='paused'?'再開':'保留'}</button>`:''}</div>${project.status!=='completed'?`<details><summary>作業する担い手 / 4人まで</summary>${locals.map((agent)=>`<label><input type="checkbox" data-legacy-worker="${esc(agent.id)}" ${project.workerIds.includes(agent.id)?'checked':''}>${esc(agent.name)}</label>`).join('')}<button data-action="legacy-workers" data-project-id="${esc(project.id)}">担い手を更新</button></details>`:''}<details><summary>設備と継承の記録</summary>${project.phases.map((entry)=>`<p>${esc(entry.name)}: ${entry.workHours.toFixed(1)} / ${entry.requiredHours}、投入ロット ${entry.committed.length}件</p>`).join('')}${project.stewardHistory.map((entry)=>`<p>D${entry.day}: ${esc(ctx.state.agents.find((agent)=>agent.id===entry.agentId)?.name??entry.agentId)}</p>`).join('')}</details></article>`;
  }).join('')}</section>`;
}

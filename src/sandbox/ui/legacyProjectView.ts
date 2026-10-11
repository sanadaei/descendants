import { atSettlement } from '../evidenceAccess.js';
import { legacyProjectLabel, legacyRecordRenewalProblem, projectPrerequisites } from '../legacyProject.js';
import { legacyFacilityActive } from '../legacyProjectBenefits.js';
import { agentAgeYears, effectiveSkill, settlementAgents } from '../stateUtils.js';
import { esc } from './viewHelpers.js';
import type { SandboxApp } from '../app.js';
import type { SettlementResourceKey } from '../types.js';
type Context = ReturnType<SandboxApp['viewContext']>;
const materialNames: Record<SettlementResourceKey,string> = {food:'食料',water:'水',medicine:'医薬品',timber:'木材',scrap:'廃材',fuel:'燃料',cloth:'布',records:'記録用資材'};

export function renderLegacyProjectPanel(ctx: Context): string {
  const actor = ctx.knowledgeAgent();
  if (!actor || !atSettlement(ctx.state,actor.id)) return '';
  const projects = ctx.state.legacyProjects ?? [];
  const choices = (['waterworks','archive'] as const).filter((kind)=>!projects.some((entry)=>entry.kind===kind)).map((kind)=>`<div><strong>${legacyProjectLabel(kind)}</strong><p>${kind==='waterworks'?'水の現地照合 → 実測試行 → その実測を研究した手順が必要。完成するとろ過設備を使える。':'現物の写しを読解した記録が必要。完成すると記録の劣化を抑える。'}</p><button data-action="legacy-start" data-kind="${kind}" ${projectPrerequisites(ctx.state,actor.id,kind).length?'':'disabled'}>計画を記録 / 60分</button></div>`).join('');
  const locals = settlementAgents(ctx.state).filter((agent)=>!agent.expeditionId&&agentAgeYears(ctx.state,agent)>=16);
  return `<section class="desc-inquiry-panel"><h2>世代をつなぐ共同体の計画</h2><p>各計画で担い手一人につき1日1時間を通常労働から割り当てます。作業で技能が育ち、疲労も生じます。工程の資材、設備、設計記録、作業履歴を残し、担い手が亡くなっても進捗は保持します。</p>${choices}${projects.map((project)=>{
    const steward = ctx.state.agents.find((agent)=>agent.id===project.stewardId);
    const total = project.phases.reduce((sum,phase)=>sum+phase.requiredHours,0);
    const progress = project.phases.reduce((sum,phase)=>sum+phase.workHours,0);
    const phase = project.phases.find((entry)=>entry.workHours<entry.requiredHours);
    const record = ctx.state.records.find((entry)=>entry.id===project.recordId);
    const renewalProblem = legacyRecordRenewalProblem(ctx.state,actor.id,project);
    const rate = locals.filter((agent)=>project.workerIds.includes(agent.id)&&agent.health>35&&agent.fatigue<85&&agent.currentPlan?.kind!=='refuse-order'&&!agent.pathology.some((entry)=>['active','chronic'].includes(entry.status)&&entry.severity>=80))
      .reduce((sum,agent)=>sum+Math.max(.25,Math.min(1.5,effectiveSkill(ctx.state,agent,project.kind==='waterworks'?'construction':'records')/60)),0);
    const materials = phase ? (Object.entries(phase.materials) as Array<[SettlementResourceKey,number]>).map(([key,quantity])=> {
      const missing = Math.max(0,quantity-ctx.state.settlement.resources[key]);
      return `${materialNames[key]} ${quantity}${!phase.funded&&missing>0?`（不足 ${missing.toFixed(1)}）`:''}`;
    }).join(' / ') : '';
    const fieldMaterialsMissing = phase&&!phase.funded&&(['cloth','fuel'] as const).some((key)=>(phase.materials[key]??0)>ctx.state.settlement.resources[key]);
    return `<article class="desc-inquiry-card" data-legacy-card="${esc(project.id)}">
      <header><strong>${esc(project.name)}</strong><em>${project.status==='completed'?(legacyFacilityActive(ctx.state,project.kind)?'設備を利用中':'設備完成 / 記録を確認'):project.status==='paused'?'保留':'継続中'}</em></header>
      <p>総進捗 ${(progress/total*100).toFixed(2)}% / ${phase?esc(phase.name):'全工程完了'}${project.pauseReason?` · ${esc(project.pauseReason)}`:''}</p>
      ${phase?`<p>残り有効作業 ${(total-progress).toFixed(1)}時間${rate>0?` / 現在の能力で休止なく作業すると約 ${((total-progress)/rate/365).toFixed(1)}年（疲労・疾病・交代で変動）`:''}</p>`:''}
      <p>担い手: ${esc(steward?.name??'記録された担当者')}${steward&&!atSettlement(ctx.state,steward.id)?' / 現地に担い手がいない':''}</p>
      <small>累積作業 ${project.contributors.reduce((sum,entry)=>sum+entry.hours,0).toFixed(1)}時間 / 引継ぎ ${Math.max(0,project.stewardHistory.length-1)}回</small>
      ${phase?`<p>工程の資材: ${materials}${phase.funded?' / 投入済み':' / 着手時に投入'}</p>`:''}
      ${fieldMaterialsMissing?'<p>不足する布・燃料は、現地の資源収集や交易で補ってください。</p>':''}
      <p>設計図の状態 ${((record?.integrity??0)*100).toFixed(1)}% / 写し ${record?.copies??0}部。読めるうちに書き直して継承できます。</p>
      <div><button data-action="legacy-renew-record" data-project-id="${esc(project.id)}" ${renewalProblem?'disabled':''}>設計と根拠を書き直す / 60分・布0.1</button>${renewalProblem?`<small>${esc(renewalProblem)}</small>`:''}</div>
      <div><button data-action="legacy-adopt" data-project-id="${esc(project.id)}">計画を引き継ぐ</button>${project.status!=='completed'?`<button data-action="legacy-pause" data-project-id="${esc(project.id)}" data-paused="${project.status==='paused'?'0':'1'}">${project.status==='paused'?'再開':'保留'}</button>`:''}</div>
      ${project.status!=='completed'?`<details><summary>作業する担い手 / 4人まで</summary>${locals.map((agent)=>`<label><input type="checkbox" data-legacy-worker="${esc(agent.id)}" ${project.workerIds.includes(agent.id)?'checked':''}>${esc(agent.name)}</label>`).join('')}<button data-action="legacy-workers" data-project-id="${esc(project.id)}">担い手を更新</button></details>`:''}
      <details><summary>設備と継承の記録</summary>${project.phases.map((entry)=>`<p>${esc(entry.name)}: ${entry.workHours.toFixed(1)} / ${entry.requiredHours}、投入ロット ${entry.committed.length}件</p>`).join('')}${project.stewardHistory.map((entry)=>`<p>D${entry.day}: ${esc(ctx.state.agents.find((agent)=>agent.id===entry.agentId)?.name??entry.agentId)}</p>`).join('')}${(project.recordHistory??[]).map((entry)=>`<p>D${entry.day}: 設計記録 / ${esc(ctx.state.agents.find((agent)=>agent.id===entry.authorId)?.name??entry.authorId)}</p>`).join('')}</details>
    </article>`;
  }).join('')}</section>`;
}

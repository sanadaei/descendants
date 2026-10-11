import { renderInquiryPanel } from './inquiryView.js';
import { renderLegacyProjectPanel } from './legacyProjectView.js';
import { renderResearchProjects } from './researchView.js';
import { readableEvidenceText } from '../loreArtifacts.js';
import { researchApplicationIsActive, researchApplicationLabel } from '../researchApplications.js';
import { researchSampleGate } from '../researchSimulation.js';
import { anomalyBasisForKnowledge } from '../anomalyUtilization.js';
import type { AnomalyUtilizationDomain, SandboxGameState } from '../types.js';
import { selectF3KnowledgeReadModel } from '../knowledgeF3Projection.js';
import { esc, knowledgeSourceLabel, compactText, compactSubjectIds, pdaKnowledgeClaimLabel, knowledgeEvidenceDisclosure } from './viewHelpers.js';
import type { SandboxApp } from '../app.js';
type AppViewContext = ReturnType<SandboxApp['viewContext']>;

export function renderPdaKnowledgePanel(ctx: AppViewContext): string {
    const holder = ctx.knowledgeAgent();
    const eligible = ctx.knowledgeEligibleAgents();
    const partners = ctx.conversationPartners(holder);
    const conversationTarget = partners.find((agent)=>agent.id===ctx.conversationTargetId);
    const f3Read = selectF3KnowledgeReadModel(ctx.state, holder?.id ?? null);
    const personal = f3Read.personal.slice().reverse();
    const institutionalIds = new Set(ctx.state.settlement.localKnowledgeIds);
    const institutional = f3Read.institutional.slice().reverse();
    const atSettlement = Boolean(holder?.alive && !holder.expeditionId && (!holder.residence || holder.residence==='settlement'));
    if (!atSettlement) institutional.length=0;
    const records = (atSettlement ? ctx.state.records : []).filter((record)=>record.integrity>0.05&&record.copies>0).slice().reverse();
    const row=(entry:SandboxGameState['knowledge'][number], access:'personal'|'institutional')=>{
      const gate=atSettlement?researchSampleGate(ctx.state,entry.id):{required:false,available:false};
      const alreadyInstitutional=institutionalIds.has(entry.id);
      const targetKnows=Boolean(conversationTarget?.knowledgeIds.includes(entry.id));
      const anomalyBasis=anomalyBasisForKnowledge(ctx.state,entry);
      const canResearch=!entry.lost&&atSettlement&&(!gate.required||gate.available);
      return `<article class="desc-pda-knowledge-row ${entry.lost?'dead':''}"><header><strong title="${esc(entry.claim)}">${esc(pdaKnowledgeClaimLabel(entry.claim))}</strong><em>${Math.round(entry.confidence*100)}%</em></header><p>${esc(compactText(readableEvidenceText(entry),240))}</p><p>${esc(compactSubjectIds(entry.subjectIds,4))}</p><small>${esc(knowledgeSourceLabel(entry))} · ${esc(access)}</small>${knowledgeEvidenceDisclosure(entry)}${!entry.lost?`<div>${access==='personal'&&conversationTarget?`<button data-action="conversation" data-knowledge-id="${esc(entry.id)}" ${targetKnows?'disabled':''}>${targetKnows?'共有済み':`話す · ${esc(conversationTarget.name)}`}</button>`:''}${access==='personal'?`<button data-action="archive-knowledge" data-knowledge-id="${esc(entry.id)}" ${!atSettlement||alreadyInstitutional?'disabled':''}>${alreadyInstitutional?'記録済み':'Archive'}</button>`:''}<button data-action="research" data-knowledge-id="${esc(entry.id)}" ${canResearch?'':'disabled'}>${!atSettlement?'拠点で研究':gate.required&&!gate.available?'Physical sample required at settlement':'研究'}</button>${anomalyBasis&&atSettlement?`<span>局所的な試行</span>${(['medicine','production','communication','defense'] as AnomalyUtilizationDomain[]).map((domain)=>`<button data-action="anomaly-use" data-knowledge-id="${esc(entry.id)}" data-domain="${domain}">${esc(domain)}</button>`).join('')}`:''}</div>`:''}</article>`;
    };
    return `<section class="desc-pda-data-panel desc-pda-knowledge-panel"><header><div><span>EPISTEMIC TERMINAL</span><h2>知識・会話・Archive</h2><small>確度は裏づけの強さを示します。追加の観測で内容を確かめます。</small></div><em>${atSettlement?'SETTLEMENT':'FIELD'}</em></header><div class="desc-pda-control-strip"><label>記録閲覧者 / 同席者<select data-action="knowledge-agent">${eligible.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===holder?.id?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><label>会話相手<select data-action="conversation-target" ${partners.length?'':'disabled'}>${partners.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===conversationTarget?.id?'selected':''}>${esc(agent.name)}</option>`).join('')}</select></label><span>${atSettlement?'Archive / research利用可':'個人・隊内知識のみ'}</span></div><p>同席者の携行記録を閲覧しても、指揮権やArchive登録は変更されません。</p><div class="desc-pda-data-columns knowledge"><section><header><strong>${esc(holder?.name ?? 'NO HOLDER')} / 個人知識</strong><span>${personal.length}</span></header><div class="desc-pda-scroll-list">${personal.slice(0,24).map((entry)=>row(entry,'personal')).join('')||'<p class="desc-pda-empty">個人知識なし。</p>'}</div></section><section><header><strong>制度知識 / Archive</strong><span>${institutional.length}</span></header><div class="desc-pda-scroll-list">${institutional.slice(0,16).map((entry)=>row(entry,'institutional')).join('')||'<p class="desc-pda-empty">追加の制度知識なし。</p>'}<div class="desc-pda-subhead">RECORDS ${records.length}</div>${records.slice(0,8).map((record)=>`<article class="desc-pda-mini-record"><strong>${esc(compactText(record.title,96))}</strong><small>${record.copies} copies · ${Math.round(record.integrity*100)}%</small></article>`).join('')}${atSettlement?renderResearchProjects(ctx.state):''}</div></section></div><section class="desc-pda-research-results"><strong>確立した研究手順</strong>${(atSettlement?ctx.state.researchApplications??[]:[]).map((a)=>`<p>${esc(researchApplicationLabel(a.domain))} · 効率 +${Math.round(a.strength*100)}% · ${researchApplicationIsActive(ctx.state,a)?`適用 ${a.uses}回`:'根拠不足 / 適用停止'}</p>`).join('')||'<p>確立した手順はありません。</p>'}</section>${atSettlement?`<section><strong>Anomaly-utilization practices</strong>${(ctx.state.anomalyPractices??[]).slice(-8).reverse().map((a)=>`<p>${esc(a.domain)} · ${esc(a.lastOutcome)}</p>`).join('')}</section>`:''}${renderInquiryPanel(ctx)}${renderLegacyProjectPanel(ctx)}</section>`;
  }

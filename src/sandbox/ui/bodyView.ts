import { renderLifeCourse } from '../lifeCourseView.js';
import { expeditionMemberReadiness } from '../expeditionSimulation.js';
import { agentAgeYears, findAgent } from '../stateUtils.js';
import { projectChronicle } from '../chronicleVisibility.js';
import { equipmentForAgent, inventoryForAgent } from '../directPlay.js';
import { selectF3KnowledgeReadModel } from '../knowledgeF3Projection.js';
import { esc, authorityLabel } from './viewHelpers.js';
import type { SandboxApp } from '../app.js';
type AppViewContext = ReturnType<SandboxApp['viewContext']>;

export function renderPdaBodyPanel(ctx: AppViewContext): string {
    const inspected = findAgent(ctx.state, ctx.inspectedAgentId) ?? ctx.controlledAgent();
    const controlled = ctx.controlledAgent();
    if (!inspected) return '<section class="desc-pda-data-panel"><p>人物を選択してください。</p></section>';
    const live = ctx.canInspectLiveState(inspected.id);
    const report = ctx.lastReportForAgent(inspected.id);
    const activePathology = inspected.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic');
    const gear = live ? equipmentForAgent(ctx.state, inspected.id) : [];
    const doctrine = ctx.selectedPreparationDoctrine();
    const readiness = live && doctrine ? expeditionMemberReadiness(inspected, doctrine) : undefined;
    const atSettlement = inspected.alive && !inspected.expeditionId && (!inspected.residence || inspected.residence==='settlement');
    const careNeeded = atSettlement && (inspected.health < 99.5 || inspected.pathology.some((entry)=>entry.status==='active'));
    const meter=(label:string,value:number,invert=false)=>`<div class="desc-pda-detail-meter"><span>${label}</span><div><i style="width:${Math.max(0,Math.min(100,invert?100-value:value))}%"></i></div><b>${Math.round(value)}</b></div>`;
    const migrated=inspected.experience['migration:arrival-day']!==undefined;
    const migrationCue=migrated?(inspected.identityOrigin==='world-provider'?'移住が確認された個人':'交渉後に迎えた移住者'):'';
    const identitySource=inspected.identityOrigin==='world-provider'?'出自に基づく個人情報':'集落の記録に基づく個人情報';
    return `<section class="desc-pda-data-panel desc-pda-body-panel"><header><div><span>PERSON / BODY RECORD</span><h2>${esc(inspected.name)}</h2></div><em>${live?'LIVE':'REMOTE'}</em></header><div class="desc-pda-body-summary"><section><strong>身体状態</strong>${live?`${meter('体力',inspected.health)}${meter('疲労',inspected.fatigue,true)}${meter('士気',inspected.morale)}${meter('空腹',inspected.needs.hunger ?? 0,true)}${meter('渇き',inspected.needs.thirst ?? 0,true)}`:'<p>現在値は通信で確認されていません。</p>'}</section><section class="desc-pda-identity-card"><strong>人物情報</strong><dl><dt>役割</dt><dd>${esc(inspected.role)}</dd><dt>年齢 / 性</dt><dd>${agentAgeYears(ctx.state,inspected)} / ${esc(inspected.sex)}</dd><dt>現在地</dt><dd>${esc(inspected.residence ?? (inspected.expeditionId?'expedition':'settlement'))}</dd><dt>Identity</dt><dd>${identitySource}${migrationCue?` · ${migrationCue}`:''}</dd><dt>Household</dt><dd>${esc(authorityLabel(inspected.profileAuthority?.household))}</dd><dt>現在行動</dt><dd>${live?esc(inspected.currentPlan?.kind ?? inspected.currentTask):'未確認'}</dd></dl></section><section class="desc-pda-fitness-card"><strong>EXPEDITION FITNESS / 遠征適性</strong>${readiness?`<b class="${readiness.ready?'ready':'blocked'}">${readiness.ready?'READY':'RECOVERING'}</b><p>HP ≥ ${readiness.minimumHealth} / fatigue ≤ ${readiness.maximumFatigue}</p>${readiness.reasons.length?`<ul>${readiness.reasons.map((reason)=>`<li>${esc(reason)}</li>`).join('')}</ul>`:'<small>現在のDoctrineで出発阻害なし。</small>'}`:'<p>遠征Doctrine未設定。</p>'}${careNeeded?`<button data-action="clinic-care" data-agent-id="${esc(inspected.id)}">診療を受ける · 60分</button>`:''}</section></div>${!live?`<section class="desc-pda-remote-card"><strong>REMOTE / CURRENT STATUS UNKNOWN</strong><p>遠隔人物の現在HP・病理・装備は直接参照しません。</p>${report?`<small>${esc(report.text)} · confidence ${Math.round(report.confidence*100)}%</small>`:'<small>通信報告なし。</small>'}</section>`:`<div class="desc-pda-data-columns"><section><header><strong>病理・症状</strong><span>${activePathology.length}</span></header>${activePathology.length?activePathology.map((entry)=>`<article class="desc-pda-record-row"><div><strong>${esc(entry.pathologyId)}</strong><small>${esc(entry.observedSymptoms.join(', ') || '記録症状なし')}</small></div><em>${entry.severity.toFixed(1)} / ${esc(entry.status)}</em></article>`).join(''):'<p class="desc-pda-empty">重大な記録済み異常なし。</p>'}</section><section><header><strong>装備・携行</strong><span>${gear.length}</span></header>${gear.length?gear.map((item)=>`<article class="desc-pda-record-row"><div><strong>${esc(item.name)}</strong><small>${esc(item.slot)} · ${item.weightKg.toFixed(1)} kg</small></div><em>${item.equipped?'EQUIPPED':'CARRIED'}</em>${inspected.id===controlled?.id?`<button data-action="toggle-equipment" data-item-id="${esc(item.id)}" data-equipped="${item.equipped?'0':'1'}">${item.equipped?'外す':'装備'}</button>`:''}</article>`).join(''):'<p class="desc-pda-empty">装備記録なし。</p>'}</section></div>`}${renderLifeCourse(ctx.state,inspected,live)}<p class="authority-boundary">集落の記録 · ${migrated?'この個人の移住確認だけでは元世帯全体の移動は確定しません。 ':''} 年齢・技能・命名はゲーム側の解釈です。${inspected.naming?.sourceName?`出自の名称: ${esc(inspected.naming.sourceName)}`:''}</p></section>`;
  }

export function renderPdaResidentsView(ctx: AppViewContext): string {
    const people=ctx.state.agents.slice().sort((a,b)=>a.name.localeCompare(b.name));
    const selected=findAgent(ctx.state,ctx.inspectedAgentId) ?? ctx.controlledAgent() ?? people[0];
    const external=(ctx.state.externalContacts ?? []).slice().reverse();
    return `<section class="desc-pda-directory"><aside class="desc-pda-pane"><header><strong>住民 / 人物一覧</strong><span>${people.length} LOCAL</span></header><div class="desc-pda-directory-list">${people.map((person)=>`<button data-action="inspect-agent" data-agent-id="${esc(person.id)}" class="${selected?.id===person.id?'active':''}"><strong>${esc(person.name)}</strong><span>${esc(person.role)} · ${agentAgeYears(ctx.state,person)}歳</span><small>${person.expeditionId?'遠征中':esc(person.residence ?? 'settlement')}</small></button>`).join('')}</div></aside><section class="desc-pda-pane desc-pda-person-card">${selected?`<header><div><span>PERSON RECORD</span><h2>${esc(selected.name)}</h2></div><em>${ctx.canInspectLiveState(selected.id)?(selected.alive?'ACTIVE':'DECEASED'):'UNKNOWN'}</em></header><div class="desc-pda-person-overview"><div class="desc-pda-avatar-placeholder"><strong>${esc(selected.name.slice(0,2))}</strong><small>PORTRAIT<br>DETACHED</small></div><dl><dt>役割</dt><dd>${esc(selected.role)}</dd><dt>年齢</dt><dd>${agentAgeYears(ctx.state,selected)}歳</dd><dt>体力</dt><dd>${ctx.canInspectLiveState(selected.id)?selected.health.toFixed(0):'未確認'}</dd><dt>疲労</dt><dd>${ctx.canInspectLiveState(selected.id)?selected.fatigue.toFixed(0):'未確認'}</dd><dt>士気</dt><dd>${ctx.canInspectLiveState(selected.id)?selected.morale.toFixed(0):'未確認'}</dd><dt>現在</dt><dd>${ctx.canInspectLiveState(selected.id)?esc(selected.currentPlan?.kind ?? selected.currentTask):'未確認'}</dd></dl></div><div class="desc-pda-person-notes"><strong>記録された身体状態</strong>${(ctx.canInspectLiveState(selected.id)?selected.pathology:[]).filter((entry)=>entry.status==='active'||entry.status==='chronic').map((entry)=>`<p>${esc(entry.pathologyId)} · severity ${entry.severity.toFixed(1)}</p>`).join('')||'<p>重大な記録済み異常なし。</p>'}</div><button data-action="pda-tab" data-pda-tab="body">身体・装備の詳細を開く</button>`:'<p>人物を選択してください。</p>'}</section><aside class="desc-pda-pane desc-pda-external-contacts"><header><strong>外部接触</strong><span>${external.length}</span></header>${external.slice(0,12).map((contact)=>`<article><strong>${esc(contact.name)}</strong><span>${contact.interactionCount} contacts</span><small>${esc(contact.societyEntityId ?? 'association unknown')}</small></article>`).join('')||'<p>直接接触した外部人物はいません。</p>'}</aside></section>`;
  }

export function renderPdaSecondaryIndex(ctx: AppViewContext, view: 'body'|'knowledge'|'inventory'|'chronicle'): string {
    const controlled=ctx.controlledAgent();
    if (view==='body') {
      const person=findAgent(ctx.state,ctx.inspectedAgentId) ?? controlled;
      const live=Boolean(person&&ctx.canInspectLiveState(person.id));
      const gear=person&&live?equipmentForAgent(ctx.state,person.id):[];
      const activePathology=(live?person?.pathology:[])?.filter((entry)=>entry.status==='active'||entry.status==='chronic').length ?? 0;
      return `<aside class="desc-pda-secondary-index"><header><strong>身体 / INDEX</strong><span>${person?(live?'LIVE':'REMOTE'):'NO DATA'}</span></header>${person?`<div class="desc-pda-index-person"><div class="desc-pda-avatar-placeholder"><strong>${esc(person.name.slice(0,2))}</strong><small>PORTRAIT<br>DETACHED</small></div><h3>${esc(person.name)}</h3><p>${esc(person.role)} · ${agentAgeYears(ctx.state,person)}歳</p></div><div class="desc-pda-index-list"><span><b>HP</b><em>${ctx.canInspectLiveState(person.id)?person.health.toFixed(0):'未確認'}</em></span><span><b>疲労</b><em>${ctx.canInspectLiveState(person.id)?person.fatigue.toFixed(0):'未確認'}</em></span><span><b>病理記録</b><em>${live?activePathology:'未確認'}</em></span><span><b>装備/携行</b><em>${live?gear.length:'未確認'}</em></span></div><button data-action="pda-tab" data-pda-tab="residents">人物を変更</button>`:'<p>人物データなし</p>'}</aside>`;
    }
    if (view==='knowledge') {
      const holder=ctx.knowledgeAgent();
      const local=Boolean(holder?.alive&&!holder.expeditionId&&(!holder.residence||holder.residence==='settlement'));
      const read=selectF3KnowledgeReadModel(ctx.state,holder?.id??null);
      const records=local?ctx.state.records.length:0, projects=local?(ctx.state.researchProjects??[]).length:0;
      const personal=read.personal.length;
      const institutional=local?read.institutional.length:0;
      return `<aside class="desc-pda-secondary-index"><header><strong>知識 / INDEX</strong><span>EPISTEMIC</span></header><div class="desc-pda-index-list"><span><b>個人/口承</b><em>${personal}</em></span><span><b>制度/記録</b><em>${institutional}</em></span><span><b>Archive</b><em>${records}</em></span><span><b>研究</b><em>${projects}</em></span></div><p class="desc-pda-index-note">外部観測も確定事実とは限りません。出所と確度を併記し、未確認部分は未確認のまま保管します。</p></aside>`;
    }
    if (view==='inventory') {
      const holder=ctx.inventoryAgent();
      const items=holder?inventoryForAgent(ctx.state,holder.id):[];
      const field=ctx.controlledExpedition(); const stock=field?field.supplies:ctx.state.settlement.resources;
      return `<aside class="desc-pda-secondary-index"><header><strong>所持品 / INDEX</strong><span>PHYSICAL</span></header><h3>${esc(holder?.name ?? 'No holder')}</h3><div class="desc-pda-index-list"><span><b>携行品</b><em>${items.length}</em></span><span><b>食料</b><em>${Number(stock.food??0).toFixed(1)}</em></span><span><b>水</b><em>${Number(stock.water??0).toFixed(1)}</em></span><span><b>薬</b><em>${Number(stock.medicine??0).toFixed(1)}</em></span></div><p class="desc-pda-index-note">物理的にアクセス可能な所持品・共有在庫だけを表示します。</p></aside>`;
    }
    const entries=projectChronicle(ctx.state,ctx.chronicleViewpoint()); const last=entries.at(-1);
    return `<aside class="desc-pda-secondary-index"><header><strong>年代記 / INDEX</strong><span>VISIBLE</span></header><div class="desc-pda-index-list"><span><b>可視記録</b><em>${entries.length}</em></span><span><b>最新日</b><em>D${last?.day ?? ctx.state.clock.day}</em></span><span><b>視点</b><em>${ctx.controlledExpedition()?'FIELD':'SETTLEMENT'}</em></span></div><p class="desc-pda-index-note">観測・通信・記録された出来事だけを時間順に表示します。</p></aside>`;
  }

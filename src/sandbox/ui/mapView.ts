import { expeditionMemberReadiness, expeditionSupplyReadiness, settlementSupplyReserveReadiness } from '../expeditionSimulation.js';
import { externalActionAvailability, externalActionDurationMinutes, type ExternalActionKind } from '../externalActions.js';
import { externalSocietyForPerson } from '../externalContact.js';
import { laborPriorityProposalAvailability } from '../politicalSimulation.js';
import { agentAgeYears, findAgent, settlementAgents } from '../stateUtils.js';
import { projectChronicle } from '../chronicleVisibility.js';
import { entityName, equipmentForAgent } from '../directPlay.js';
import { generatedWorldMapRadiusKm, harvestableResourceKeys, isSampleableEntity, spatialDistanceKm } from '../localExploration.js';
import { synthesizeVisibleSituations } from '../situationSynthesis.js';
import { latestObservedRouteDisruptionForEntities, latestObservedRouteDisruptionForEntity } from '../externalConflictSimulation.js';
import { providerVisibleRouteAlternatives } from '../routePlanning.js';
import type { EncounterInstruction, EncounterState, ExpeditionDoctrine, ExpeditionPace, LaborTask } from '../types.js';
import { esc, compactText } from './viewHelpers.js';
import type { SandboxApp } from '../app.js';
import type { SpatialRef, WorldEntity } from '../../worldbridge/contract.js';
type AppViewContext = ReturnType<SandboxApp['viewContext']>;

function worldMarker(ctx: AppViewContext, entry: WorldEntity, center: SpatialRef, radius: number, selected: boolean): string {
  const location = ctx.worldMapLocation(entry);
  if (!location.position) return '';
  const position = ctx.mapMarkerStyle(location.position, center, radius);
  const uncertainty = location.estimated ? `推定範囲: 半径 ${location.uncertaintyRadiusKm.toFixed(1)} km` : '';
  const diameter = Math.min(100, location.uncertaintyRadiusKm / radius * 92);
  const region = location.estimated && diameter > 0 ? `<span class="desc-pda-map-uncertainty" style="${position};width:${diameter.toFixed(2)}%;height:${diameter.toFixed(2)}%" aria-label="${esc(uncertainty)}"></span>` : '';
  return `${region}<button class="desc-pda-map-marker ${selected?'selected':''} ${location.estimated?'estimated':''}" style="${position}" data-action="select-world-entity" data-entity-id="${esc(entry.id)}" title="${esc(entityName(entry))}${uncertainty?` · ${esc(uncertainty)}`:''}"><i></i><span>${esc(compactText(entityName(entry),24))}${location.estimated?'（推定）':''}</span></button>`;
}

export function renderPdaMiniMap(ctx: AppViewContext, scope: 'world'|'local' = 'world'): string {
    const field = ctx.controlledExpedition();
    const local = scope==='local' && Boolean(field);
    const center = local && field ? field.position : ctx.state.settlement.position;
    const radius = local ? 5 : generatedWorldMapRadiusKm(ctx.state);
    const entities = local ? (ctx.localProjection?.entities ?? []) : ctx.visibleWorldEntities().filter((entry)=>entry.id!==ctx.state.world.originEntityId);
    const selected = local ? ctx.selectedLocalEntity() : ctx.selectedWorldEntity();
    const markers = entities.slice(0,24).map((entry)=> local
      ? `<button class="desc-pda-map-marker ${selected?.id===entry.id?'selected':''}" style="${ctx.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-local-entity" data-entity-id="${esc(entry.id)}" title="${esc(entityName(entry))}"><i></i><span>${esc(compactText(entityName(entry),24))}</span></button>`
      : worldMarker(ctx, entry, center, radius, selected?.id===entry.id)
    ).join('');
    return `<div class="desc-pda-map-surface ${local?'local':'world'}"><div class="desc-pda-map-grid" aria-hidden="true"></div><span class="desc-pda-map-origin" title="${local?'Field party':'Settlement'}">◎</span>${markers}<small class="desc-pda-map-scale">±${local?'5':radius.toFixed(0)} km</small></div>`;
  }

export function renderPdaMapView(ctx: AppViewContext): string {
    const field=ctx.controlledExpedition();
    if (!field && ctx.mapScope==='local') ctx.mapScope='world';
    const scope=field?ctx.mapScope:'world';
    const selected=scope==='local'?ctx.selectedLocalEntity():ctx.selectedWorldEntity();
    const location = selected && scope==='world' ? ctx.worldMapLocation(selected) : undefined;
    const position = scope==='world' ? location?.position : selected?.spatial;
    const selectedDistance=position ? spatialDistanceKm(scope==='local'&&field?field.position:ctx.state.settlement.position,position) : Number.POSITIVE_INFINITY;
    const externalPerson=selected?.kind==='person';
    let actions='';
    if (selected) {
      if (scope==='world' && position && !field) actions += `<button data-action="set-prep-target" data-entity-id="${esc(selected.id)}">${location?.estimated?'推定範囲を探索':'遠征目標に設定'}</button>`;
      if (scope==='world' && position && field) actions += `<button data-action="move-world-target" data-entity-id="${esc(selected.id)}">${location?.estimated?'推定中心へ移動':'次の移動先'}</button>`;
      if (scope==='local' && field && selected.spatial) {
        const near=selectedDistance<=0.25;
        actions += near ? `<button data-action="observe-local-target" data-entity-id="${esc(selected.id)}">観察 30分</button>${externalPerson?`<button data-action="contact-external-person" data-entity-id="${esc(selected.id)}">話す 20分</button>`:''}${isSampleableEntity(selected)?`<button data-action="sample-local-target" data-entity-id="${esc(selected.id)}">採取 45分</button>`:''}` : `<button data-action="walk-local-target" data-entity-id="${esc(selected.id)}">接近する</button>`;
      }
    }
    return `<section class="desc-pda-full-map"><header class="desc-pda-map-toolbar"><strong>${scope==='local'?'LOCAL FIELD PROJECTION':'WORLD KNOWLEDGE PROJECTION'}</strong><div><button data-action="map-scope" data-scope="world" class="${scope==='world'?'active':''}">WORLD</button>${field?`<button data-action="map-scope" data-scope="local" class="${scope==='local'?'active':''}">LOCAL</button>`:''}<button data-action="pda-tab" data-pda-tab="task">行動へ戻る</button></div></header><div class="desc-pda-full-map-grid"><div class="desc-pda-map-large">${ctx.pdaMiniMap(scope)}</div><aside class="desc-pda-map-inspector"><span>SELECTED OBJECT</span><h2>${esc(selected?entityName(selected):(scope==='local'?'局地周辺':'既知WORLD'))}</h2>${selected?`<p>${esc(selected.kind)}${selected.subtype?` / ${esc(selected.subtype)}`:''}</p><dl><dt>距離</dt><dd>${Number.isFinite(selectedDistance)?selectedDistance.toFixed(scope==='local'?2:1):'?'} km${location?.estimated?`（推定中心 / 誤差半径 ${location.uncertaintyRadiusKm.toFixed(1)} km）`:''}</dd><dt>識別子</dt><dd>${esc(compactText(selected.id,34))}</dd><dt>投影</dt><dd>${scope==='local'?'observer-bounded':'knowledge-bounded'}</dd></dl><div class="desc-pda-map-actions">${actions||'<span>現在実行できる直接行動はありません。</span>'}</div>`:'<p>地図上の既知マーカーを選択してください。</p>'}<small>推定地点は誤差範囲とともに表示します。未踏査領域は空白のまま残ります。</small></aside></div>${renderExplorationInspector(ctx)}</section>`;
  }

export function renderPdaExpeditionPreparation(ctx: AppViewContext): string {
    ctx.initializeExpeditionPreparation();
    const field = ctx.controlledExpedition();
    const active = ctx.state.expeditions.filter((entry)=>!['returned','destroyed'].includes(entry.status));
    if (field) {
      const latest = projectChronicle(ctx.state,ctx.chronicleViewpoint()).at(-1);
      return `<div class="desc-pda-expedition-active"><header><div><span>ACTIVE FIELD OPERATION</span><h2>${esc(field.id)}</h2></div><em>${esc(field.status)}</em></header><div class="desc-pda-expedition-metrics"><div><span>位置</span><b>${field.position.x.toFixed(1)}, ${field.position.y.toFixed(1)}</b></div><div><span>隊員</span><b>${field.memberIds.length}名</b></div><div><span>食料</span><b>${field.supplies.food.toFixed(1)}</b></div><div><span>水</span><b>${field.supplies.water.toFixed(1)}</b></div></div><section><strong>現在のフィールド状態</strong><p>${esc(latest?.text ?? '直近の可視報告はありません。')}</p></section><div class="desc-pda-expedition-actions"><button data-action="pda-tab" data-pda-tab="map">地図 / LOCAL</button>${['outbound','exploring'].includes(field.status)?`<button data-action="return" data-expedition-id="${esc(field.id)}">帰還命令</button>`:''}<button data-action="pda-task-panel" data-panel="overview">行動概要へ戻る</button></div></div>`;
    }
    const available = settlementAgents(ctx.state).filter((agent)=>agentAgeYears(ctx.state,agent)>=16).sort((a,b)=>b.skills.scouting-a.skills.scouting);
    const selectedCrew = available.filter((agent)=>ctx.prepCrewIds.has(agent.id));
    const leader = findAgent(ctx.state,ctx.prepLeaderId);
    const doctrine = ctx.selectedPreparationDoctrine();
    const target = ctx.prepTarget;
    const visibleWorldEntities = ctx.visibleWorldEntities();
    const targetEntity = ctx.prepTargetEntityId ? visibleWorldEntities.find((entry)=>entry.id===ctx.prepTargetEntityId) : undefined;
    const targetLocation = targetEntity ? ctx.worldMapLocation(targetEntity) : undefined;
    const topologyRoutes = targetEntity && !targetLocation?.estimated ? providerVisibleRouteAlternatives(ctx.worldProjection, visibleWorldEntities, ctx.state.world.originEntityId, targetEntity.id, 3) : [];
    const selectedTopologyRoute = ctx.prepRouteEntityId ? topologyRoutes.find((entry)=>entry.id===ctx.prepRouteEntityId) : undefined;
    const topologyEvidenceRouteIds = new Set(topologyRoutes.flatMap((entry)=>entry.evidenceIds));
    const knownRoutes = targetLocation?.estimated ? [] : visibleWorldEntities.filter((entry)=>entry.kind==='route' && entry.spatial && !topologyEvidenceRouteIds.has(entry.id));
    const selectedRoute = ctx.prepRouteEntityId ? knownRoutes.find((entry)=>entry.id===ctx.prepRouteEntityId) : undefined;
    const plannedWaypoints = selectedTopologyRoute?.waypoints ?? selectedRoute?.spatial;
    const selectedWeight = selectedCrew.reduce((sum,agent)=>sum+equipmentForAgent(ctx.state,agent.id).filter((item)=>item.equipped).reduce((inner,item)=>inner+item.weightKg,0),0);
    const supplyWeight = ctx.prepSupplies.food*0.55 + ctx.prepSupplies.water + ctx.prepSupplies.medicine*0.18 + ctx.prepSupplies.tools*1.5;
    const resourceOk = ctx.state.settlement.resources.food>=ctx.prepSupplies.food && ctx.state.settlement.resources.water>=ctx.prepSupplies.water && ctx.state.settlement.resources.medicine>=ctx.prepSupplies.medicine && ctx.state.settlement.resources.scrap>=ctx.prepSupplies.tools;
    const supplyReadiness = expeditionSupplyReadiness(ctx.state, selectedCrew.map((agent)=>agent.id), target, ctx.prepPace, ctx.prepSupplies, plannedWaypoints, selectedTopologyRoute?.distanceKm);
    const settlementReserve = doctrine ? settlementSupplyReserveReadiness(ctx.state, ctx.prepSupplies, doctrine) : null;
    const launchReady = selectedCrew.length>0 && Boolean(leader && ctx.prepCrewIds.has(leader.id) && doctrine && target && resourceOk && supplyReadiness.ready && settlementReserve?.ready);
    const targetLabel = target ? `${targetEntity?entityName(targetEntity):'既知座標'} · ${target.x.toFixed(1)}, ${target.y.toFixed(1)}${targetLocation?.estimated?` · 推定中心 / 半径 ${targetLocation.uncertaintyRadiusKm.toFixed(1)} km`:''}` : '未選択 — 地図から既知地点を指定';
    return `<div class="desc-pda-expedition-prep"><header><div><span>EXPEDITION PREPARATION</span><h2>遠征準備</h2></div><em>${launchReady?'READY':'CHECK'}</em></header><p class="desc-pda-expedition-intro">既知WORLD情報だけを使って、隊員・物資・行軍方針・目的地を確定します。未発見地点は候補に追加しません。</p><div class="desc-pda-expedition-grid"><section><strong>1 / CREW</strong><div class="desc-pda-crew-list">${available.slice(0,12).map((agent)=>{const readiness=doctrine?expeditionMemberReadiness(agent,doctrine):{ready:false,reasons:['doctrine required']};return `<label class="${readiness.ready?'':'blocked'}"><input type="checkbox" data-action="prep-crew" data-agent-id="${esc(agent.id)}" ${ctx.prepCrewIds.has(agent.id)?'checked':''} ${readiness.ready?'':'disabled'}><span>${esc(agent.name)}</span><small>HP ${agent.health.toFixed(0)} · FAT ${agent.fatigue.toFixed(0)} · ${readiness.ready?'READY':esc(readiness.reasons[0]??'BLOCKED')}</small></label>`;}).join('')}</div><label class="desc-pda-field-label">隊長<select data-action="prep-leader">${selectedCrew.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===ctx.prepLeaderId?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><label class="desc-pda-field-label">出発後の操作<select data-action="control-mode"><option value="expedition" ${ctx.controlMode==='expedition'?'selected':''}>遠征隊を操作</option><option value="settlement" ${ctx.controlMode==='settlement'?'selected':''}>集落に残る</option></select></label></section><section><strong>2 / LOADOUT</strong><div class="desc-pda-loadout-grid">${(['food','water','medicine','tools'] as const).map((kind)=>`<label><span>${kind==='food'?'食料':kind==='water'?'水':kind==='medicine'?'薬':'工具'}</span><input type="number" min="0" step="${kind==='medicine'?'0.25':'1'}" data-action="prep-supply" data-supply="${kind}" value="${ctx.prepSupplies[kind]}"></label>`).join('')}</div><div class="desc-pda-readiness ${resourceOk?'ready':'blocked'}"><b>物資</b><span>${resourceOk?'集落在庫から搬出可能':'在庫不足'}</span><small>装備 ${selectedWeight.toFixed(1)} kg · 共用物資 ${supplyWeight.toFixed(1)} kg</small></div><div class="desc-pda-readiness ${supplyReadiness.ready?'ready':'blocked'}"><b>FIELD ENDURANCE</b><span>${supplyReadiness.ready?'READY':'BLOCKED'}</span><small>食料 ${supplyReadiness.foodDays.toFixed(1)}日 · 水 ${supplyReadiness.waterDays.toFixed(1)}日${target&&Number.isFinite(supplyReadiness.estimatedOutboundHours)?` · 往路推定 ${supplyReadiness.estimatedOutboundHours.toFixed(1)}h`:''}</small></div><div class="desc-pda-readiness ${settlementReserve?.ready?'ready':'blocked'}"><b>集落予備</b><span>${settlementReserve?.ready?'PROTECTED':'CHECK'}</span><small>${settlementReserve?`残存 食料 ${settlementReserve.remainingFoodDays.toFixed(1)}日 / 水 ${settlementReserve.remainingWaterDays.toFixed(1)}日`:'Doctrineを選択してください'}</small></div></section><section><strong>3 / ROUTE & DOCTRINE</strong><label class="desc-pda-field-label">行軍速度<select data-action="prep-pace">${(['cautious','normal','fast'] as ExpeditionPace[]).map((pace)=>`<option value="${pace}" ${pace===ctx.prepPace?'selected':''}>${pace}</option>`).join('')}</select></label><label class="desc-pda-field-label">Doctrine<select data-action="prep-doctrine">${ctx.state.doctrines.map((entry)=>`<option value="${esc(entry.id)}" ${entry.id===doctrine?.id?'selected':''}>${esc(entry.name)}</option>`).join('')}</select></label><div class="desc-pda-target-readout"><span>目的地</span><strong>${esc(targetLabel)}</strong><button data-action="pda-tab" data-pda-tab="map">地図から選択</button></div>${target?`<label class="desc-pda-field-label">既知ルート<select data-action="prep-route"><option value="" ${ctx.prepRouteEntityId?'':'selected'}>direct / known waypointなし</option>${topologyRoutes.map((route,index)=>`<option value="${esc(route.id)}" ${route.id===ctx.prepRouteEntityId?'selected':''}>topology ${index+1} · ${route.distanceKm.toFixed(1)} km</option>`).join('')}${knownRoutes.map((route)=>`<option value="${esc(route.id)}" ${route.id===ctx.prepRouteEntityId?'selected':''}>via ${esc(entityName(route))}</option>`).join('')}</select></label>`:''}<div class="desc-pda-active-count"><span>他の活動中遠征</span><b>${active.length}</b></div></section></div><div class="desc-pda-launch-row"><button data-action="pda-task-panel" data-panel="overview">戻る</button><button data-action="launch" class="launch" ${launchReady?'':'disabled'}>遠征を出発させる</button></div></div>`;
  }

export function renderFieldOperationsPanel(ctx: AppViewContext): string {
    ctx.initializeExpeditionPreparation();
    const available = settlementAgents(ctx.state).filter((agent)=>agentAgeYears(ctx.state,agent)>=16).sort((a,b)=>b.skills.scouting-a.skills.scouting);
    const selectedCrew = available.filter((agent)=>ctx.prepCrewIds.has(agent.id));
    const leader = findAgent(ctx.state, ctx.prepLeaderId);
    const doctrine = ctx.selectedPreparationDoctrine();
    const target = ctx.prepTarget;
    const visibleWorldEntities = ctx.visibleWorldEntities();
    const targetEntity = ctx.prepTargetEntityId ? visibleWorldEntities.find((entry)=>entry.id===ctx.prepTargetEntityId) : visibleWorldEntities.find((entry)=>entry.spatial && target && spatialDistanceKm(entry.spatial,target)<0.01);
    const targetLocation = targetEntity ? ctx.worldMapLocation(targetEntity) : undefined;
    const topologyRoutes = targetEntity && !targetLocation?.estimated ? providerVisibleRouteAlternatives(ctx.worldProjection, visibleWorldEntities, ctx.state.world.originEntityId, targetEntity.id, 3) : [];
    const selectedTopologyRoute = ctx.prepRouteEntityId ? topologyRoutes.find((entry)=>entry.id===ctx.prepRouteEntityId) : undefined;
    const topologyEvidenceRouteIds = new Set(topologyRoutes.flatMap((entry)=>entry.evidenceIds));
    const knownRoutes = targetLocation?.estimated ? [] : visibleWorldEntities.filter((entry)=>entry.kind==='route' && entry.spatial && !topologyEvidenceRouteIds.has(entry.id));
    const selectedRoute = ctx.prepRouteEntityId ? knownRoutes.find((entry)=>entry.id===ctx.prepRouteEntityId) : undefined;
    const routeWaypoint = selectedRoute?.spatial;
    const plannedWaypoints = selectedTopologyRoute?.waypoints ?? routeWaypoint;
    const routeEvidenceIds = selectedTopologyRoute?.evidenceIds ?? (selectedRoute ? [selectedRoute.id] : []);
    const routeDisruption = latestObservedRouteDisruptionForEntities(ctx.state, routeEvidenceIds);
    const destinationDisruption = ctx.prepTargetEntityId ? latestObservedRouteDisruptionForEntity(ctx.state, ctx.prepTargetEntityId) : undefined;
    const controlled = ctx.controlledExpedition();
    const active = ctx.state.expeditions.filter((entry)=>!['returned','destroyed'].includes(entry.status));
    const selectedWeight = selectedCrew.reduce((sum,agent)=>sum+equipmentForAgent(ctx.state,agent.id).filter((item)=>item.equipped).reduce((inner,item)=>inner+item.weightKg,0),0);
    const supplyWeight = ctx.prepSupplies.food*0.55 + ctx.prepSupplies.water + ctx.prepSupplies.medicine*0.18 + ctx.prepSupplies.tools*1.5;
    const resourceOk = ctx.state.settlement.resources.food>=ctx.prepSupplies.food
      && ctx.state.settlement.resources.water>=ctx.prepSupplies.water
      && ctx.state.settlement.resources.medicine>=ctx.prepSupplies.medicine
      && ctx.state.settlement.resources.scrap>=ctx.prepSupplies.tools;
    const supplyReadiness = expeditionSupplyReadiness(ctx.state, selectedCrew.map((agent)=>agent.id), target, ctx.prepPace, ctx.prepSupplies, plannedWaypoints, selectedTopologyRoute?.distanceKm);
    const settlementReserve = doctrine ? settlementSupplyReserveReadiness(ctx.state, ctx.prepSupplies, doctrine) : null;
    const cards = active.map((expedition) => {
      const isControlled = controlled?.id === expedition.id;
      const latest = expedition.communicationReports?.at(-1);
      if (!isControlled) {
        const publicState = latest ? `${latest.status}${latest.verified ? ' / verified' : ' / unverified'}` : 'no report';
        const transmittedRendezvous = expedition.rendezvousRequest?.status === 'transmitted' && expedition.rendezvousRequest.verifiedPosition ? expedition.rendezvousRequest : undefined;
        const rescueEvidence = Boolean((latest && (!latest.verified || latest.status !== 'connected')) || transmittedRendezvous) && selectedCrew.length >= 1;
        const settlementEvidence = transmittedRendezvous
          ? `Verified rendezvous transmission received at ${transmittedRendezvous.verifiedPosition!.x.toFixed(1)}, ${transmittedRendezvous.verifiedPosition!.y.toFixed(1)}. This position was verified at transmission time; no newer position has been received.`
          : latest ? latest.text : 'Current position, body state, internal events and loss classification are not available from the settlement viewpoint.';
        const responderPlan = expedition.rendezvousPlan ? `<p>Responder rendezvous: ${esc(expedition.rendezvousPlan.status)} · evidence ${esc(expedition.rendezvousPlan.targetEvidenceId)} @ D${expedition.rendezvousPlan.targetEvidenceDay} ${String(Math.floor(expedition.rendezvousPlan.targetEvidenceMinute/60)).padStart(2,'0')}:${String(expedition.rendezvousPlan.targetEvidenceMinute%60).padStart(2,'0')} · ${expedition.rendezvousPlan.searchRadiusKm.toFixed(1)}km bounded search radius. This is evidence state, not live target tracking.</p>` : '';
        return `<article class="exp-card remote-expedition-card"><strong>${esc(expedition.id)} · REMOTE EXPEDITION</strong><span>communication ${esc(publicState)}</span><p>${esc(settlementEvidence)}</p>${responderPlan}${rescueEvidence ? `<button data-action="rescue" data-expedition-id="${expedition.id}">${transmittedRendezvous?'Launch rescue to verified rendezvous position':'Launch search from last verified route evidence'}</button>` : ''}</article>`;
      }
      const latestEncounter = [...ctx.state.encounters].reverse().find((entry) => entry.expeditionId === expedition.id);
      const activeEncounter = latestEncounter && latestEncounter.status !== 'resolved' ? latestEncounter : undefined;
      const runtimeDoctrine=ctx.state.doctrines.find((entry)=>entry.id===expedition.doctrineId);
      const arrival = expedition.arrivedDay ? ` · arrived D${expedition.arrivedDay}${expedition.arrivedMinute!==undefined?` ${String(Math.floor(expedition.arrivedMinute/60)).padStart(2,'0')}:${String(expedition.arrivedMinute%60).padStart(2,'0')}`:''}` : '';
      const wedo = activeEncounter ? (() => {
        const partyActors = activeEncounter.actors.filter((actor)=>actor.side==='expedition');
        const hostileActors = activeEncounter.actors.filter((actor)=>actor.side==='other');
        const actorLine = (actor: EncounterState['actors'][number], index: number) => {
          const agent = actor.side === 'expedition' ? findAgent(ctx.state, actor.agentId) : undefined;
          const label = agent?.name ?? `Other ${index + 1}`;
          return `<span class="wedo-actor ${actor.health<=0?'down':actor.health<45?'critical':''}"><b>${esc(label)}</b><em>${actor.health.toFixed(0)} hp</em></span>`;
        };
        return `<div class="field-wedo"><div class="wedo-head"><strong>WEDO / ${esc(activeEncounter.status)}</strong><span>ROUND INTERVAL · 10 min</span></div><div class="wedo-control-row"><label>Directive <select data-action="encounter-instruction" data-encounter-id="${activeEncounter.id}">${(['avoid','withdraw','defend','advance','protect-wounded','capture','break-contact'] as EncounterInstruction[]).map((instruction)=>`<option value="${instruction}" ${activeEncounter.instruction===instruction?'selected':''}>${instruction}</option>`).join('')}</select></label><button class="wedo-step" data-action="wedo-round" data-encounter-id="${activeEncounter.id}">Resolve next WEDO round · 10 min</button></div><div class="wedo-actors"><section><small>PARTY</small>${partyActors.map(actorLine).join('')}</section><section><small>OTHER</small>${hostileActors.map(actorLine).join('')}</section></div>${ctx.encounterGrid(activeEncounter)}<div class="wedo-queue">${activeEncounter.queue.slice(0,6).map((action)=>`<span>#${action.order} ${esc(action.actorId)} → ${esc(action.action)}</span>`).join('')}</div>${activeEncounter.log.length?`<small class="wedo-log">${activeEncounter.log.slice(-4).map(esc).join(' · ')}</small>`:''}</div>`;
      })() : '';
      const routeBlocked = expedition.status==='outbound' && expedition.routePlan?.topologyStatus==='blocked';
      const fieldDecision = expedition.fieldDecision;
      const decisionRuntime = routeBlocked || fieldDecision ? `<div class="route-runtime ${routeBlocked?'unfit':'ready'}"><strong>FIELD DECISION · ${esc(fieldDecision?.kind??'required')}</strong><span>${esc(fieldDecision?.status??'awaiting choice')}${fieldDecision?.remainingHours!==undefined?` · ${fieldDecision.remainingHours.toFixed(1)}h remaining`:''}${fieldDecision?.result?` · ${esc(fieldDecision.result)}`:''}</span>${expedition.fieldExposure?`<small>observed exposure risk ${expedition.fieldExposure.lastRisk.toFixed(2)} · interval dose ${expedition.fieldExposure.lastIntervalDose.toFixed(2)} · cumulative ${expedition.fieldExposure.cumulativeDose.toFixed(2)} · ${expedition.fieldExposure.sheltered?'sheltered':'unsheltered'}${expedition.fieldExposure.sourceEntityIds.length?` · evidence ${esc(expedition.fieldExposure.sourceEntityIds.join(', '))}`:''}</small>`:''}</div>` : '';
      const routeRuntime = expedition.routePlan ? `<div class="route-runtime ${expedition.routePlan.topologyStatus==='blocked'?'unfit':'ready'}"><strong>CHARTED ROUTE · ${esc(expedition.routePlan.topologyStatus??'active')}</strong><span>leg ${Math.min(expedition.routePlan.currentWaypointIndex+1,expedition.routePlan.waypoints.length+1)}/${expedition.routePlan.waypoints.length+1} · replans ${expedition.routePlan.replanCount??0} · basis tick ${expedition.routePlan.basisTick??'legacy'}</span>${expedition.routePlan.blockedReason?`<small>${esc(expedition.routePlan.blockedReason)} No alternate route is recorded. Time alone does not reopen the route; choose wait/camp, retry/replan, or return.</small>`:''}</div>` : '';
      const returnRuntime = expedition.returnTravel ? `<div class="route-runtime ${expedition.returnTravel.status==='active'?'unfit':'ready'}"><strong>OFF-NETWORK RETURN · ${esc(expedition.returnTravel.status)}</strong><span>${expedition.returnTravel.travelledDistanceKm.toFixed(1)} / ${expedition.returnTravel.initialDistanceKm.toFixed(1)} km travelled · ${expedition.returnTravel.remainingDistanceKm.toFixed(1)} km remaining</span><small>terrain speed ×${expedition.returnTravel.lastSpeedFactor.toFixed(2)} · dead-reckoning uncertainty ${expedition.returnTravel.uncertaintyKm.toFixed(2)} km${expedition.returnTravel.terrainEvidenceIds.length?` · terrain evidence ${esc(expedition.returnTravel.terrainEvidenceIds.join(', '))}`:''}${expedition.returnTravel.navigationAnchorIds.length?` · navigation anchors ${esc(expedition.returnTravel.navigationAnchorIds.join(', '))}`:''}. This bearing is physical return progress, not a claimed known road.</small></div>` : '';
      const rendezvousRuntime = expedition.rendezvousRequest ? `<div class="route-runtime ${expedition.rendezvousRequest.status==='pending-link'?'unfit':'ready'}"><strong>RENDEZVOUS / RESCUE · ${esc(expedition.rendezvousRequest.status)}</strong><span>${expedition.rendezvousRequest.status==='pending-link'?'held locally until a verified communication link exists':expedition.rendezvousRequest.verifiedPosition?`verified transmission position ${expedition.rendezvousRequest.verifiedPosition.x.toFixed(1)}, ${expedition.rendezvousRequest.verifiedPosition.y.toFixed(1)}`:esc(expedition.rendezvousRequest.resolution??'resolved')}</span><small>${expedition.rendezvousRequest.status==='pending-link'?'Exact field position remains unknown until a transmission is received.':'A transmitted rendezvous position is a time-stamped field report, not a live position signal.'}</small></div>` : '';
      const responderRuntime = expedition.rendezvousPlan ? `<div class="route-runtime ${['aborted'].includes(expedition.rendezvousPlan.status)?'unfit':'ready'}"><strong>RESPONDER RENDEZVOUS · ${esc(expedition.rendezvousPlan.status)}</strong><span>target ${esc(expedition.rendezvousPlan.targetExpeditionId)} · evidence ${esc(expedition.rendezvousPlan.targetEvidenceId)} @ ${expedition.rendezvousPlan.evidencePosition.x.toFixed(1)}, ${expedition.rendezvousPlan.evidencePosition.y.toFixed(1)} · ETA at launch ${expedition.rendezvousPlan.etaHoursAtLaunch.toFixed(1)}h</span><small>arrival window D${expedition.rendezvousPlan.arrivalWindowStartDay} ${String(Math.floor(expedition.rendezvousPlan.arrivalWindowStartMinute/60)).padStart(2,'0')}:${String(expedition.rendezvousPlan.arrivalWindowStartMinute%60).padStart(2,'0')}–D${expedition.rendezvousPlan.arrivalWindowEndDay} ${String(Math.floor(expedition.rendezvousPlan.arrivalWindowEndMinute/60)).padStart(2,'0')}:${String(expedition.rendezvousPlan.arrivalWindowEndMinute%60).padStart(2,'0')}${expedition.rendezvousPlan.arrivalAssessment?` · arrived ${esc(expedition.rendezvousPlan.arrivalAssessment)}`:''} · wait ${expedition.rendezvousPlan.waitHoursRemaining.toFixed(1)}h · search ${expedition.rendezvousPlan.searchHours.toFixed(1)}h / radius ${expedition.rendezvousPlan.searchRadiusKm.toFixed(1)}km${expedition.rendezvousPlan.lastOutcome?` · ${esc(expedition.rendezvousPlan.lastOutcome)}`:''}. Search expands around the last received clue for up to 12h.</small></div>` : '';
      const expeditionDetail = `<p>${expedition.memberIds.map((id)=>{const agent=findAgent(ctx.state,id);const encounterActor=activeEncounter?.actors.find((actor)=>actor.agentId===id);const liveHealth=encounterActor?.health??agent?.health??0;return `${esc(agent?.name??id)} ${agent?.alive?`${liveHealth.toFixed(0)}hp / ${agent.fatigue.toFixed(0)}fat`:'down'}`;}).join(' · ')}</p><p>Doctrine: ${esc(runtimeDoctrine?.name ?? expedition.doctrineId)} · supplies F${expedition.supplies.food.toFixed(1)} W${expedition.supplies.water.toFixed(1)} M${expedition.supplies.medicine.toFixed(1)} T${expedition.supplies.tools.toFixed(1)}</p>${routeRuntime}${returnRuntime}${decisionRuntime}${rendezvousRuntime}${responderRuntime}${runtimeDoctrine?`<small>Runtime doctrine: camp ${runtimeDoctrine.campBeforeDark?'before dark':'manual'} · comm return threshold ${runtimeDoctrine.maxSilentHours}h · retreat below ${runtimeDoctrine.retreatHealth}hp · contact ${esc(runtimeDoctrine.contactPolicy)} · rescue ${runtimeDoctrine.prioritizeRescue?'priority':'ordinary'}.</small>`:''}`;
      const wedoDebrief = !activeEncounter && latestEncounter?.status === 'resolved' ? `<div class="field-wedo-summary"><div><strong>LAST WEDO / RESOLVED</strong><span>${esc(latestEncounter.instruction)} · ${latestEncounter.casualties.length} expedition ${latestEncounter.casualties.length===1?'casualty':'casualties'}</span></div><p>${latestEncounter.actors.filter((actor)=>actor.side==='expedition').map((actor)=>{const agent=findAgent(ctx.state,actor.agentId);return `${esc(agent?.name??actor.agentId)} ${actor.health.toFixed(0)}hp`;}).join(' · ')}</p><small>Direct field debrief only; settlement visibility still follows return / communication / archive routes.</small></div>` : '';
      const fieldControlMeta = `<strong>${esc(expedition.id)} · FIELD CONTROL</strong><span>${expedition.position.x.toFixed(1)}, ${expedition.position.y.toFixed(1)} · ${esc(expedition.pace ?? 'normal')} pace · comm ${esc(expedition.communication)}${arrival}</span>`;
      const rendezvousOpen = expedition.rendezvousRequest && ['pending-link','transmitted'].includes(expedition.rendezvousRequest.status);
      const rendezvousEligible = routeBlocked || (expedition.fieldExposure?.cumulativeDose ?? 0) >= 3.5 || expedition.status === 'returning';
      const rendezvousAction = rendezvousEligible && !rendezvousOpen ? `<button data-action="field-rendezvous" data-expedition-id="${expedition.id}">Request rescue / rendezvous · 10m</button>` : '';
      const responderActions = expedition.rendezvousPlan?.status === 'contact'
        ? `<button data-action="rendezvous-transfer" data-expedition-id="${expedition.id}">Transfer field aid / wounded · 10m</button>`
        : expedition.rendezvousPlan && ['outbound','waiting','searching'].includes(expedition.rendezvousPlan.status)
          ? `<button data-action="rendezvous-abort" data-expedition-id="${expedition.id}">Abort rendezvous / return · 10m</button>` : '';
      const fieldActions = routeBlocked
        ? `<button data-action="field-wait" data-expedition-id="${expedition.id}">Wait / camp · 6h</button><button data-action="field-retry" data-expedition-id="${expedition.id}">Retry visible route · 10m</button><button data-action="field-return" data-expedition-id="${expedition.id}">Return off-network · 10m</button>${rendezvousAction}${responderActions}`
        : `${!activeEncounter?`<button data-action="direct-camp" data-expedition-id="${expedition.id}">Camp / rest · 6h</button>${ctx.visualQaEncounterControlsEnabled()?`<button class="qa-sim-action" data-action="qa-trigger-encounter" data-expedition-id="${expedition.id}">WEDO接触を開始</button>`:''}`:''}${['outbound','exploring'].includes(expedition.status)?`<button data-action="return" data-expedition-id="${expedition.id}">Order return</button>`:''}${rendezvousAction}${responderActions}`;
      return `<article class="exp-card field-expedition-card ${activeEncounter?'has-active-wedo':''}">${activeEncounter?`${wedo}${fieldControlMeta}${expeditionDetail}`:`${fieldControlMeta}${wedoDebrief}${expeditionDetail}`}<div class="field-direct-actions">${fieldActions}</div></article>`;
    }).join('') || '<p>No active expeditions.</p>';
    const targetLabel = target ? `${targetEntity?entityName(targetEntity):'known map position'} · ${target.x.toFixed(1)}, ${target.y.toFixed(1)}` : 'No WORLD target selected';
    const preparation = controlled ? '' : `<div class="expedition-preparation"><h4>EXPEDITION PREPARATION</h4><p>Crew, physical loadout, travel pace, doctrine and a recorded WORLD target are explicit launch choices.</p><div class="prep-grid"><section><strong>Crew</strong><div class="crew-picker">${available.slice(0,16).map((agent)=>{const readiness=doctrine?expeditionMemberReadiness(agent,doctrine):{ready:false,reasons:['no doctrine'],minimumHealth:60,maximumFatigue:70};return `<label class="${readiness.ready?'':'unfit'}"><input type="checkbox" data-action="prep-crew" data-agent-id="${esc(agent.id)}" ${ctx.prepCrewIds.has(agent.id)?'checked':''} ${readiness.ready?'':'disabled'}><span class="crew-name">${esc(agent.name)}</span><small>HP ${agent.health.toFixed(0)} · fat ${agent.fatigue.toFixed(0)} · ${readiness.ready?'READY':esc(readiness.reasons[0]??'RECOVERING')}</small></label>`;}).join('') || '<p>No available adults.</p>'}</div><label>Leader <select data-action="prep-leader">${selectedCrew.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===ctx.prepLeaderId?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><label>Control at departure <select data-action="control-mode"><option value="expedition" ${ctx.controlMode==='expedition'?'selected':''}>Control expedition</option><option value="settlement" ${ctx.controlMode==='settlement'?'selected':''}>Remain with settlement</option></select></label></section><section><strong>Loadout</strong>${(['food','water','medicine','tools'] as const).map((kind)=>`<label>${kind}<input type="number" min="0" step="${kind==='medicine'?'0.25':'1'}" data-action="prep-supply" data-supply="${kind}" value="${ctx.prepSupplies[kind]}"></label>`).join('')}<p>Equipped crew gear ${selectedWeight.toFixed(1)} kg · shared supply estimate ${supplyWeight.toFixed(1)} kg.</p><p>${resourceOk?'Settlement stock can furnish this loadout.':'Insufficient accessible settlement stock for this loadout.'}</p><div class="supply-readiness ${supplyReadiness.ready?'ready':'unfit'}"><strong>FIELD ENDURANCE · ${supplyReadiness.ready?'READY':'BLOCKED'}</strong><span>food ${supplyReadiness.foodDays.toFixed(1)}d · water ${supplyReadiness.waterDays.toFixed(1)}d${target&&Number.isFinite(supplyReadiness.estimatedOutboundHours)?` · est. outbound ${supplyReadiness.estimatedOutboundHours.toFixed(1)}h`:''}</span><small>${supplyReadiness.ready?'Outbound + 8h emergency reserve covered.':esc(supplyReadiness.reasons.join(' · '))}</small></div>${settlementReserve?`<div class="supply-readiness settlement-reserve ${settlementReserve.ready?'ready':'unfit'}"><strong>SETTLEMENT RESERVE · ${settlementReserve.ready?'PROTECTED':'BLOCKED'}</strong><span>after loadout: food ${settlementReserve.remainingFoodDays.toFixed(1)}d · water ${settlementReserve.remainingWaterDays.toFixed(1)}d</span><small>doctrine minimum ${settlementReserve.minimumReserveDays.toFixed(1)}d${settlementReserve.ready?' preserved':` · ${esc(settlementReserve.reasons.join(' · '))}`}</small></div>`:''}</section><section><strong>Travel / doctrine</strong><label>Pace <select data-action="prep-pace">${(['cautious','normal','fast'] as ExpeditionPace[]).map((pace)=>`<option value="${pace}" ${pace===ctx.prepPace?'selected':''}>${pace}</option>`).join('')}</select></label><label>Doctrine <select data-action="prep-doctrine">${ctx.state.doctrines.map((entry)=>`<option value="${esc(entry.id)}" ${entry.id===doctrine?.id?'selected':''}>${esc(entry.name)}</option>`).join('')}</select></label>${doctrine?`<div class="doctrine-editor"><label>Risk tolerance <input type="number" min="0" max="1" step="0.05" data-action="doctrine-field" data-field="riskTolerance" value="${doctrine.riskTolerance}"></label><label>Retreat HP <input type="number" min="0" max="100" step="1" data-action="doctrine-field" data-field="retreatHealth" value="${doctrine.retreatHealth}"></label><label>Max silent hours <input type="number" min="1" step="1" data-action="doctrine-field" data-field="maxSilentHours" value="${doctrine.maxSilentHours}"></label><label><input type="checkbox" data-action="doctrine-field" data-field="campBeforeDark" ${doctrine.campBeforeDark?'checked':''}>Camp before dark</label><label><input type="checkbox" data-action="doctrine-field" data-field="prioritizeRescue" ${doctrine.prioritizeRescue?'checked':''}>Prioritize rescue</label><label>Contact <select data-action="doctrine-field" data-field="contactPolicy">${(['avoid','observe','peaceful','trade','assertive'] as ExpeditionDoctrine['contactPolicy'][]).map((policy)=>`<option value="${policy}" ${policy===doctrine.contactPolicy?'selected':''}>${policy}</option>`).join('')}</select></label><label>Encounter <select data-action="doctrine-field" data-field="encounterInstruction">${(['avoid','withdraw','defend','advance','protect-wounded','capture','break-contact'] as EncounterInstruction[]).map((instruction)=>`<option value="${instruction}" ${instruction===doctrine.encounterInstruction?'selected':''}>${instruction}</option>`).join('')}</select></label><button data-action="duplicate-doctrine">Duplicate doctrine as variant</button></div>`:''}</section></div><p class="prep-target">WORLD target: <strong>${esc(targetLabel)}</strong>. Select a visible WORLD marker and choose “Use as expedition target”.</p>${target?`<div class="supply-readiness route-readiness ${routeDisruption||destinationDisruption?'unfit':'ready'}"><strong>ROUTE CHOICE · ${selectedTopologyRoute?'RECORDED ROUTE':selectedRoute?`VIA ${esc(entityName(selectedRoute))}`:'DIRECT'}</strong><label class="route-choice-control">Known route <select data-action="prep-route"><option value="" ${ctx.prepRouteEntityId?'':'selected'}>direct / no waypoint / no known topology</option>${topologyRoutes.map((route,index)=>`<option value="${esc(route.id)}" ${route.id===ctx.prepRouteEntityId?'selected':''}>topology ${index+1} · ${route.distanceKm.toFixed(1)} km · stretch ${route.stretchFromShortest.toFixed(2)}× · overlap ${Math.round(route.overlapWithShortest*100)}% · ${route.relationIds.length} link${route.relationIds.length===1?'':'s'}</option>`).join('')}${knownRoutes.map((route)=>`<option value="${esc(route.id)}" ${route.id===ctx.prepRouteEntityId?'selected':''}>via known waypoint ${esc(entityName(route))}</option>`).join('')}</select></label><span>${selectedTopologyRoute?`${esc(selectedTopologyRoute.relationIds.join(' → '))} · `:selectedRoute?`${esc(selectedRoute.id)} · `:''}planned outbound ${Number.isFinite(supplyReadiness.estimatedOutboundHours)?supplyReadiness.estimatedOutboundHours.toFixed(1):'?'}h</span><small>${routeDisruption?`Selected route has recorded disruption severity ${routeDisruption.severity.toFixed(0)} attached to explicit route evidence. Direct travel or another known route avoids only that route-specific evidence if the destination itself is unaffected.`:selectedTopologyRoute?'This alternative is composed only from recorded route network whose endpoints are already known. No recent disruption is attached to its evidence IDs; absence of observed disruption is not proof of safety.':selectedRoute?'No recent recorded disruption is attached to this selected route waypoint. Absence of observed disruption is not proof of safety.':'Direct travel claims no known topology and therefore does not infer an unseen safe path.'}${destinationDisruption?` Destination itself also has recorded disruption severity ${destinationDisruption.severity.toFixed(0)}; changing route does not erase destination evidence.`:''}</small></div>`:''}<button data-action="launch" ${selectedCrew.length<1||!leader||!ctx.prepCrewIds.has(leader.id)||!doctrine||!resourceOk||!supplyReadiness.ready||!settlementReserve?.ready||!target?'disabled':''}>Launch selected expedition</button></div>`;
    const settlementPolicy = controlled ? '' : ctx.settlementPolicyPanel();
    return `<section class="sandbox-panel field-operations"><h3>FIELD / EXPEDITION</h3>${renderFieldCycleGuide(ctx)}${preparation}${settlementPolicy}<div class="field-card-list">${cards}</div></section>`;
  }

export function renderSettlementPolicyPanel(ctx: AppViewContext): string {
    const tasks: LaborTask[] = ['forage','water','medicine','repair','sanitation','care','records','guard','explore-prep'];
    const proposals = (ctx.state.policyProposals ?? []).slice(-8).reverse();
    const latest = proposals[0];
    const localAssigned = new Map<LaborTask, number>();
    for (const agent of ctx.state.agents) {
      if (!agent.alive || (agent.residence ?? 'settlement') !== 'settlement') continue;
      localAssigned.set(agent.currentTask, (localAssigned.get(agent.currentTask) ?? 0) + 1);
    }
    const previousSameTask = latest ? proposals.slice(1).find((entry)=>entry.task===latest.task) : undefined;
    const coalitionContinuity = latest && previousSameTask ? (()=>{
      const previousSupport = new Set(previousSameTask.supporterIds);
      const previousOppose = new Set(previousSameTask.opponentIds);
      const repeatedSupport = latest.supporterIds.filter((id)=>previousSupport.has(id)).length;
      const repeatedOppose = latest.opponentIds.filter((id)=>previousOppose.has(id)).length;
      const switched = latest.supporterIds.filter((id)=>previousOppose.has(id)).length + latest.opponentIds.filter((id)=>previousSupport.has(id)).length;
      return `<small class="policy-continuity">political memory · ${repeatedSupport} repeated support · ${repeatedOppose} repeated opposition · ${switched} switched side</small>`;
    })() : '';
    const latestResult = latest ? `<article class="policy-latest ${latest.status}"><span>LATEST ASSEMBLY VOTE</span><strong>${esc(latest.task)} ${latest.delta>0?'+':''}${latest.delta} · ${esc(latest.status)}</strong><small>${latest.supporterIds.length} support / ${latest.opponentIds.length} oppose · ${esc(latest.rationale)}</small>${coalitionContinuity}</article>` : '<div class="policy-empty">No proposal has been voted on yet.</div>';
    const history = proposals.length>1 ? `<details class="policy-history"><summary>Earlier proposals · ${proposals.length-1}</summary>${proposals.slice(1).map((proposal)=>`<article class="chronicle-line ${proposal.status==='rejected'?'dead':''}"><strong>${esc(proposal.task)} ${proposal.delta>0?'+':''}${proposal.delta} · ${esc(proposal.status)}</strong><span>${proposal.supporterIds.length} support / ${proposal.opponentIds.length} oppose</span><p>${esc(proposal.rationale)}</p></article>`).join('')}</details>` : '';
    return `<section class="settlement-policy-panel"><h4>ASSEMBLY / LABOR PRIORITIES</h4><p>優先度の変更案を集会へ提出します。参加者は信頼・利害・正統性・自律性・過去の立場を踏まえて投票し、集会中は60分が経過します。可決後は各自の勤務選択に反映されます。</p>${latestResult}<div class="policy-priority-list">${tasks.map((task)=>{const availability=laborPriorityProposalAvailability(ctx.state,task);return `<div class="policy-priority-row ${availability.allowed?'':'considered-today'}"><strong>${esc(task)}</strong><span>priority <b>${ctx.state.settlement.laborPriorities[task]}</b></span><small>${localAssigned.get(task) ?? 0} assigned now${availability.allowed?'':' · voted today'}</small><div><button aria-label="Increase ${esc(task)} priority" data-action="policy" data-task="${task}" data-delta="1" ${availability.allowed?'':'disabled'}>+</button><button aria-label="Decrease ${esc(task)} priority" data-action="policy" data-task="${task}" data-delta="-1" ${availability.allowed?'':'disabled'}>−</button></div></div>`;}).join('')}</div>${history}</section>`;
  }

export function renderEncounterGrid(ctx: AppViewContext, encounter: EncounterState): string {
    const width = Math.max(1, encounter.width); const height = Math.max(1, Math.min(encounter.height, 12));
    const cells: string[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const actors = encounter.actors.filter((actor) => actor.health > 0 && Math.round(actor.x) === x && Math.round(actor.y) === y);
        const label = actors.map((actor) => actor.side === 'expedition' ? 'E' : 'X').join('');
        const title = actors.map((actor) => `${actor.agentId} ${actor.health.toFixed(0)}hp`).join(' / ');
        cells.push(`<span class="wedo-cell ${actors.some((actor) => actor.side === 'expedition') ? 'ally' : ''} ${actors.some((actor) => actor.side === 'other') ? 'hostile' : ''}" title="${esc(title)}">${esc(label)}</span>`);
      }
    }
    return `<div class="wedo-grid" role="img" aria-label="Encounter grid: E expedition, X other" style="--wedo-w:${width}">${cells.join('')}</div>`;
  }

export function explorationInspectorScrollKey(ctx: AppViewContext): string {
    if (ctx.view !== 'exploration') return '';
    const field = ctx.controlledExpedition();
    const latestEncounter = field ? [...ctx.state.encounters].reverse().find((entry) => entry.expeditionId === field.id) : undefined;
    const activeEncounterId = latestEncounter && latestEncounter.status !== 'resolved' ? latestEncounter.id : 'none';
    return [
      field ? `field:${field.id}` : 'settlement',
      `scope:${ctx.mapScope}`,
      `world:${ctx.selectedWorldEntityId || 'none'}`,
      `local:${ctx.selectedLocalEntityId || 'none'}`,
      `wedo:${activeEncounterId}`,
    ].join('|');
  }

export function renderExplorationInspector(ctx: AppViewContext): string {
    const controlled = ctx.controlledAgent();
    const field = ctx.controlledExpedition();
    if (!field && ctx.mapScope === 'local') ctx.mapScope = 'world';
    const situations = synthesizeVisibleSituations(ctx.state, field, field ? ctx.localProjection : null);
    const visibleChronicle = projectChronicle(ctx.state, ctx.chronicleViewpoint()).slice(-3).reverse();
    const worldRadius = generatedWorldMapRadiusKm(ctx.state);
    const worldEntities = ctx.visibleWorldEntities();
    const selectedWorld = ctx.selectedWorldEntity();
    const localEntities = field ? (ctx.localProjection?.entities ?? []) : [];
    const selectedLocal = ctx.selectedLocalEntity();
    const selectedDistance = field && selectedLocal?.spatial ? spatialDistanceKm(field.position, selectedLocal.spatial) : Number.POSITIVE_INFINITY;
    const scope = field ? ctx.mapScope : 'world';
    const center = scope === 'local' && field ? field.position : ctx.state.settlement.position;
    const radius = scope === 'local' ? 5 : worldRadius;
    const localMarkers = localEntities.slice(0,24).map((entry)=>`<button class="known-map-marker local-entity-marker ${selectedLocal?.id===entry.id?'selected':''}" style="${ctx.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-local-entity" data-entity-id="${esc(entry.id)}"><small>${esc(entry.kind)}</small>${esc(entityName(entry))}</button>`).join('');
    const worldMarkers = worldEntities.filter((entry)=>entry.id!==ctx.state.world.originEntityId).slice(0,36).map((entry)=>`<button class="known-map-marker world-entity-marker ${selectedWorld?.id===entry.id?'selected':''}" style="${ctx.mapMarkerStyle(ctx.worldMapLocation(entry).position,center,radius)}" data-action="select-world-entity" data-entity-id="${esc(entry.id)}"><small>${esc(entry.kind)}</small>${esc(entityName(entry))}</button>`).join('');
    const partyMarker = field && scope==='world' ? `<span class="party-world-marker" style="${ctx.mapMarkerStyle(field.position,center,radius)}">FIELD PARTY</span>` : '';
    const location = field ? `${field.position.x.toFixed(1)}, ${field.position.y.toFixed(1)}` : `${ctx.state.settlement.position.x.toFixed(1)}, ${ctx.state.settlement.position.y.toFixed(1)}`;
    let inspector = ctx.fieldOperationsPanel();
    if (scope==='local' && field) {
      if (selectedLocal) {
        const near = selectedDistance <= 0.35;
        const externalPerson = selectedLocal.kind==='individual' && !ctx.state.agents.some((agent)=>agent.id===selectedLocal.id);
        const outsideSociety = externalPerson ? externalSocietyForPerson(ctx.state, selectedLocal.id) : undefined;
        inspector = `<section class="sandbox-panel local-action-inspector"><span class="sandbox-eyebrow">FIELD ACTIONS / CURRENT RANGE</span><h3>${esc(entityName(selectedLocal))}</h3><p>${esc(selectedLocal.kind)}${selectedLocal.subtype?` / ${esc(selectedLocal.subtype)}`:''} · ${Number.isFinite(selectedDistance)?selectedDistance.toFixed(2):'?'} km</p><p>観測済み情報のみを表示しています。未確認要素は記録外です。</p>${externalPerson?`<small>外部人物記録 ${esc(selectedLocal.id)}${outsideSociety?` · observed society ${esc(outsideSociety)}`:''}. 接触記録には実際に観測した内容だけを残し、未確認の信条や経歴は補完しません。</small>`:''}${!near && selectedLocal.spatial?`<button data-action="walk-local-target" data-entity-id="${esc(selectedLocal.id)}">Walk there</button>`:''}${near?`<button data-action="observe-local-target" data-entity-id="${esc(selectedLocal.id)}">Observe · 30 min</button>${externalPerson?`<button data-action="contact-external-person" data-entity-id="${esc(selectedLocal.id)}">Speak directly · 20 min</button>`:''}${isSampleableEntity(selectedLocal)?`<button data-action="sample-local-target" data-entity-id="${esc(selectedLocal.id)}">Collect sample · 45 min</button>`:''}${harvestableResourceKeys(selectedLocal).map((key)=>`<button data-action="harvest-local-resource" data-entity-id="${esc(selectedLocal.id)}" data-resource-key="${esc(key)}">Harvest ${esc(key)} · 60 min</button>`).join('')}`:'<small class="local-approach-note">Approach is required before close interaction.</small>'}</section>${ctx.fieldOperationsPanel()}`;
      } else {
        inspector = `<section class="sandbox-panel local-action-inspector"><span class="sandbox-eyebrow">FIELD ACTIONS / CURRENT RANGE</span><h3>Local surroundings</h3>${ctx.localLoading?'<p>LOCAL SENSOR SWEEP…</p>':localEntities.length?'<p>観測済みの対象を地図上から選択してください。</p>':'<p>この範囲に顕著な観測対象はありません。</p><button data-action="survey-local-empty">Survey surroundings · 45 min</button>'}</section>${ctx.fieldOperationsPanel()}`;
      }
    } else if (selectedWorld) {
      const knownLocation = ctx.worldMapLocation(selectedWorld);
      const knownDistance = knownLocation.position ? spatialDistanceKm(ctx.state.settlement.position, knownLocation.position) : Number.POSITIVE_INFINITY;
      const externalActor = ctx.state.externalActors.find((actor)=>actor.entityId===selectedWorld.id);
      const recentExternal = externalActor ? visibleChronicle.find((entry)=>entry.kind==='external' && entry.entityIds.includes(externalActor.entityId)) : undefined;
      const recentObservedConflict = externalActor ? [...(ctx.state.externalConflictObservations ?? [])].reverse().find((entry)=>entry.sourceEntityId===externalActor.entityId) : undefined;
      const observedConflictSummary = recentObservedConflict ? (()=>{
        const parts = recentObservedConflict.kind === 'recovery' ? [] : [`severity ${recentObservedConflict.severity.toFixed(0)}`];
        if (recentObservedConflict.injuredIndividualIds.length) parts.push(`${recentObservedConflict.injuredIndividualIds.length} injured local ID${recentObservedConflict.injuredIndividualIds.length===1?'':'s'}`);
        if (recentObservedConflict.displacedIndividualIds.length) parts.push(`${recentObservedConflict.displacedIndividualIds.length} displaced local ID${recentObservedConflict.displacedIndividualIds.length===1?'':'s'}`);
        if ((recentObservedConflict.displacedHouseholdIds ?? []).length) parts.push(`${recentObservedConflict.displacedHouseholdIds!.length} displaced household ID${recentObservedConflict.displacedHouseholdIds!.length===1?'':'s'}`);
        if ((recentObservedConflict.returnedToSettlementIndividualIds ?? []).length) parts.push(`${recentObservedConflict.returnedToSettlementIndividualIds!.length} returned-to-settlement local ID${recentObservedConflict.returnedToSettlementIndividualIds!.length===1?'':'s'}`);
        if ((recentObservedConflict.returnedToSettlementHouseholdIds ?? []).length) parts.push(`${recentObservedConflict.returnedToSettlementHouseholdIds!.length} returned household ID${recentObservedConflict.returnedToSettlementHouseholdIds!.length===1?'':'s'}`);
        if (recentObservedConflict.affectedRouteEntityIds.length) parts.push(`${recentObservedConflict.affectedRouteEntityIds.length} affected route/entity reference${recentObservedConflict.affectedRouteEntityIds.length===1?'':'s'}`);
        const losses=Object.entries(recentObservedConflict.resourceLoss).map(([key,value])=>`${key} ${Number(value).toFixed(1)}`);
        if (losses.length) parts.push(`stock loss ${losses.join(', ')}`);
        return parts.join(' · ');
      })() : '';
      const externalActions = externalActor && !field ? `<div class="external-actions world-selected-actions"><strong>Known relationship / settlement action</strong><div class="external-action-buttons">${(['trade','diplomacy','migration','conflict'] as ExternalActionKind[]).map((kind)=>{const availability=externalActionAvailability(ctx.state,kind,externalActor.entityId);const waitHours=Math.ceil(availability.remainingMinutes/60);return `<button data-action="external" data-kind="${kind}" data-target="${esc(externalActor.entityId)}" ${availability.allowed?'':'disabled'} title="${esc(availability.reason)}"><span>${kind}</span><small>${availability.allowed?`${Math.round(externalActionDurationMinutes(kind)/60)}h`:`wait ${waitHours}h`}</small></button>`;}).join('')}</div><div class="external-relation-readout"><span>confidence <b>${Math.round(externalActor.confidence*100)}%</b></span><span>trust <b>${externalActor.localTrust.toFixed(1)}</b></span><span>trade <b>${externalActor.tradeExperience}</b></span><span>migration <b>${externalActor.migrationBalance}</b></span><span>conflict <b>${externalActor.conflictPressure.toFixed(1)}</b></span></div>${recentObservedConflict?`<article class="external-last-result external-observed-result"><span>LATEST OBSERVED CONSEQUENCE</span><strong>${esc(recentObservedConflict.kind)}</strong><p>${esc(observedConflictSummary)}</p></article>`:''}${recentExternal?`<article class="external-last-result"><span>LATEST VISIBLE OUTCOME</span><strong>${esc(recentExternal.title)}</strong><p>${esc(recentExternal.text)}</p></article>`:''}<small>Commands apply only to this recorded society. Unknown parties are not listed.</small></div>` : '';
      inspector = `<section class="sandbox-panel local-action-inspector"><span class="sandbox-eyebrow">WORLD / KNOWN MAP OBJECT</span><h3>${esc(entityName(selectedWorld))}</h3><p>${esc(selectedWorld.kind)}${selectedWorld.subtype?` / ${esc(selectedWorld.subtype)}`:''} · ${Number.isFinite(knownDistance)?knownDistance.toFixed(1):'?'} km from settlement${knownLocation.estimated?` · 推定 / 誤差半径 ${knownLocation.uncertaintyRadiusKm.toFixed(1)} km`:''}</p><p>This marker exists only because the controlled viewpoint has a knowledge path to its subject ID.</p>${knownLocation.position&&!field?`<button data-action="set-prep-target" data-entity-id="${esc(selectedWorld.id)}">Use as expedition target</button>`:''}${knownLocation.position&&field?`<button data-action="move-world-target" data-entity-id="${esc(selectedWorld.id)}">Set next field destination</button>`:''}${externalActions}</section>${ctx.fieldOperationsPanel()}`;
    }
    return `<div class="generated-inspector" data-scroll-key="${esc(explorationInspectorScrollKey(ctx))}">${inspector}</div>`;
  }

export function renderFieldCycleGuide(ctx: AppViewContext): string {
    const field = ctx.controlledExpedition();
    const activeEncounter = field ? [...ctx.state.encounters].reverse().find((entry) => entry.expeditionId === field.id && entry.status !== 'resolved') : undefined;
    const recentlyReturned = [...ctx.state.expeditions].reverse().find((entry) => entry.status === 'returned' && entry.returnDay !== null && ctx.state.clock.day - entry.returnDay <= 2);
    let phase: 'target' | 'prepare' | 'field' | 'return' | 'record' = 'target';
    let title = 'Choose a known WORLD destination';
    let detail = 'Select a plotted WORLD marker, inspect it, then choose “Use as expedition target”. Nothing undiscovered is revealed by this guide.';
    if (field) {
      phase = field.status === 'returning' ? 'return' : 'field';
      if (activeEncounter) {
        title = 'Resolve the active WEDO encounter';
        detail = 'Choose a directive and resolve the next 10-minute round. Normal time advance remains blocked until the direct encounter is resolved.';
      } else if (field.status === 'outbound') {
        title = 'Travel toward the selected destination';
        detail = 'LOCAL is available while travelling. Advance one day from the command surface to continue travel, or inspect nearby projected objects encountered en route.';
      } else if (field.status === 'returning') {
        title = 'Return to the settlement';
        detail = '帰還まで時間を進めます。現地観測は、隊が帰還するかArchiveへ正式記録されるまで隊員の携行記録として扱われます。';
      } else {
        title = 'Work the LOCAL area';
        detail = 'Select a nearby projected object. Walk close, observe, speak or collect a physical sample, then camp or order return when ready.';
      }
    } else if (ctx.prepTarget) {
      phase = 'prepare'; title = 'Prepare and launch the expedition';
      detail = '隊員、隊長、携行物資、行軍速度、Doctrineを確認し、出発命令を出してください。';
    } else if (recentlyReturned) {
      phase = 'record'; title = 'Turn returned evidence into durable knowledge';
      detail = 'Open F3 Knowledge. Archive a witnessed claim and start sample-gated research where physical evidence is present, then begin another field cycle.';
    }
    const steps: Array<[typeof phase,string]> = [['target','1 TARGET'],['prepare','2 PREP'],['field','3 FIELD'],['return','4 RETURN'],['record','5 RECORD']];
    return `<section class="field-cycle-guide" aria-label="Field cycle playtest route"><span class="sandbox-eyebrow">FIELD CYCLE / OPERATION GUIDE</span><div class="field-cycle-steps">${steps.map(([id,label])=>`<span class="${phase===id?'active':''}">${label}</span>`).join('')}</div><strong>${esc(title)}</strong><p>${esc(detail)}</p></section>`;
  }

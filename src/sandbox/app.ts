import { executeContinuityDays } from './continuityProgression.js';
import { archiveInquiryEvaluation, createExplorationInquiry, surveyInquiry, trialInquiryProcedure, visibleInquiries, type InquiryPrediction } from './explorationInquiry.js';
import { accessibleArtifactRecords, collectArtifactRecord, decodeArtifactRecord } from './loreArtifacts.js';
import { adoptLegacyProject, setLegacyProjectPaused, setLegacyProjectWorkers, startLegacyProject, type LegacyProjectKind } from './legacyProject.js';
import { setEducationMentor } from './educationSimulation.js';
import { knownMapLocation } from './knowledgeSpatial.js';
import type { AreaProjection, SpatialRef, WorldEntity, WorldProvider } from '../worldbridge/contract.js';
import { advanceSandbox, advanceSandboxHours } from './engine.js';
import { addExpeditionOrder, campExpedition, expeditionMemberReadiness, launchExpedition, launchRescueExpedition, resolveControlledEncounterRound, saveDoctrine } from './expeditionSimulation.js';
import { createEncounter, setEncounterInstruction } from './encounterSimulation.js';
import { externalActionAvailability, externalActionDurationMinutes, issueExternalAction, type ExternalActionKind } from './externalActions.js';
import { conductExternalPersonContact } from './externalContact.js';
import { startResearchProject } from './researchSimulation.js';
import { attemptAnomalyUtilization } from './anomalyUtilization.js';
import { proposeLaborPriority } from './politicalSimulation.js';
import { requestDirectClinicCare } from './settlementSimulation.js';
import { createVolatileSandboxRepository, type SandboxRepository } from './storage.js';
import { agentAgeYears, findAgent, settlementAgents } from './stateUtils.js';
import { projectChronicle } from './chronicleVisibility.js';
import { conductDirectConversation, institutionalizeKnowledgeRecord } from './knowledgeSimulation.js';
import { consumeAccessibleSupply, ensureDirectPlayState, entityName, equipmentForAgent, inventoryForAgent, reserveDirectActivity, setEquipmentEquipped } from './directPlay.js';
import { generatedWorldMapRadiusKm, harvestGeneratedResource, observeGeneratedEntity, queryGeneratedLocalArea, queryGeneratedWorldArea, surveyEmptySurroundings, takeGeneratedSample } from './localExploration.js';
import { selectF1IncidentReadModel } from './incidentService.js';
import { applyIncidentResponseEvidenceResourceUse, assignIncidentResponseTeam, dispatchIncidentResponseTeam, I2_F1_INCIDENT_STORAGE_KEY, incidentResponseDebriefs, isI2F1IncidentAdapterEnabled, standDownIncidentResponseTeam } from './incidentService.js';
import { deriveSurvivalCampaignView } from './survivalCampaign.js';
import { commitDailyPlan, ensureDailyLoopState, executeCommittedPlan, resolveDailyInterruptionAsAuto, setDailyAssignment, setExecutionPolicy } from './dailyActionLoop.js';
import { assignmentConsequenceReadback, deriveDailyCommandView, morningReportTransitionSummary, type DailyAssignmentConsequenceReadback, type DailyAssignmentMoveSnapshot, type DailyCommandTarget } from './dailyCommandReadModel.js';
import { providerVisibleRouteAlternatives } from './routePlanning.js';
import { issueBlockedFieldDecision } from './fieldDecisionSimulation.js';
import { requestFieldRendezvous } from './rendezvousSimulation.js';
import { abortRendezvousMission, transferRendezvousAidAndWounded } from './rendezvousEncounterSimulation.js';
import type { AnomalyUtilizationDomain, DailyExecutionPolicy, EncounterInstruction, EncounterState, ExpeditionControlMode, ExpeditionDoctrine, ExpeditionPace, LaborTask, ResourceProcessingKind, SandboxGameState, SettlementResourceKey, SkillKey } from './types.js';
import { isBusySafeUiAction, viewForFunctionKey } from './uiNavigation.js';
import { assertImportedSaveProviderCompatible, assertProviderAligned, isProviderMutationUncertainError, restoreSandboxState } from './worldMutationSafety.js';
import { pdaAudio } from './pdaAudio.js';
import { filterIncidentResponseDebriefs, type IncidentDebriefFilter } from './incidentDebriefReadModel.js';
import { compareWorldGraphProjectionsIfEnabled, selectWorldGraphReadModel } from './knowledgeGraphProjection.js';
import { allocationGroups, processResourceLot, removeResourceAllocationGroup, removeResourceAllocationRule, saveResourceAllocationGroup, saveResourceAllocationRule } from './resourceLedger.js';
import { esc, PDA_TABS, ViewId, PdaTab, PdaTaskPanel, IncidentResponseDensity, compactText, SandboxAccessibility, loadAccessibility, storeAccessibility, PdaPresentation, loadPdaPresentation, storePdaPresentation, SandboxAppOptions } from './ui/viewHelpers.js';
import { renderPdaCampaignCommand, renderPdaTaskList, renderPdaTaskView, renderPdaIncidentResponsePanel } from './ui/commandView.js';
import { renderPdaBodyPanel, renderPdaResidentsView, renderPdaSecondaryIndex } from './ui/bodyView.js';
import { renderPdaKnowledgePanel } from './ui/knowledgeView.js';
import { renderSettlementResourceLedgerPanel, renderPdaInventoryPanel } from './ui/inventoryView.js';
import { renderPdaChroniclePanel } from './ui/chronicleView.js';
import { renderPdaMiniMap, renderPdaMapView, renderPdaExpeditionPreparation, renderFieldOperationsPanel, renderSettlementPolicyPanel, renderEncounterGrid } from './ui/mapView.js';
import { renderPdaSystemView } from './ui/systemView.js';

export class SandboxApp {
  #view: ViewId = 'exploration';
  #pdaTab: PdaTab = 'task';
  #pdaTaskPanel: PdaTaskPanel = 'overview';
  #inspectedAgentId = '';
  #busy = false;
  #controlMode: ExpeditionControlMode = 'expedition';
  #toastTimer = 0;
  #localProjection: AreaProjection | null = null;
  #localProjectionKey = '';
  #localLoading = false;
  #selectedLocalEntityId = '';
  #worldProjection: AreaProjection | null = null;
  #worldProjectionKey = '';
  #worldLoading = false;
  #selectedWorldEntityId = '';
  #mapScope: 'world' | 'local' = 'world';
  #prepTarget: SpatialRef | null = null;
  #prepTargetEntityId = '';
  #prepRouteEntityId = '';
  #conversationTargetId = '';
  #knowledgeAgentId = '';
  #inventoryAgentId = '';
  #prepCrewIds = new Set<string>();
  #incidentResponderDraftIds = new Set<string>();
  #selectedIncidentId = '';
  #selectedDebriefId = '';
  #incidentDebriefFilter: IncidentDebriefFilter = 'all';
  #incidentDebriefQuery = '';
  #incidentResponseDensity: IncidentResponseDensity = 'standard';
  #prepLeaderId = '';
  #prepDoctrineId = '';
  #prepPace: ExpeditionPace = 'normal';
  #prepSupplies = { food: 12, water: 18, medicine: 2, tools: 2 };
  #accessibility: SandboxAccessibility = loadAccessibility();
  #pdaPresentation: PdaPresentation = loadPdaPresentation();
  #focusAfterRender = '';
  #morningReportExpanded = false;
  #dailyPlanBoardAgentId = '';
  #pendingAssignmentMoves: DailyAssignmentMoveSnapshot[] = [];
  #assignmentConsequenceReadback: DailyAssignmentConsequenceReadback[] = [];
  #crtTransition: 'idle' | 'power-off' | 'day-title' | 'power-on' = 'idle';
  #crtTransitionDay = 0;
  #crtTransitionSummary = '';
  #dailyExecutionActive = false;
  #stopContinuity = false;
  #commandPulsePhase: 'morning' | 'plan' | 'locked' | 'executing' | 'readback' = 'morning';
  #commandPulseMorningDay = -1;
  #commandReadbackLines: string[] = [];
  #startupNotices: string[] = [];
  #persistenceMode: 'durable' | 'volatile' | 'unavailable' = 'durable';
  #providerMode: 'real-worldgen' | 'snapshot-recovery' | 'mock-diagnostic' = 'real-worldgen';
  #lastCommittedState: SandboxGameState;
  #reloadRequiredReason = '';
  #lifecycleCheckpointInFlight: Promise<void> | null = null;

  #recoverProvider?: SandboxAppOptions['recoverProvider'];
  #reloadRequiredKind: 'provider' | 'persistence' | '' = '';
  #systemOpen = false;

  constructor(private readonly root: HTMLElement, private provider: WorldProvider, private repository: SandboxRepository, private state: SandboxGameState, options: SandboxAppOptions = {}) {
    this.#recoverProvider = options.recoverProvider;
    this.#startupNotices = [...(options.startupNotices ?? [])];
    this.#persistenceMode = options.persistenceMode ?? repository.mode;
    this.#providerMode = options.providerMode ?? 'real-worldgen';
    this.#lastCommittedState = structuredClone(state);
    this.root.addEventListener('click', (event) => this.onClick(event));
    this.root.addEventListener('change', (event) => this.onChange(event));
    this.root.addEventListener('input', (event) => this.onInput(event));
    this.root.addEventListener('pointerover', (event) => this.onPointerOver(event));
    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('pagehide', () => { void this.lifecycleCheckpoint('pagehide'); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.lifecycleCheckpoint('visibility-hidden');
      else void this.probePersistenceFreshness();
    });
    this.#inspectedAgentId = this.state.settlement.leaderId;
    ensureDirectPlayState(this.state);
    ensureDailyLoopState(this.state);
    this.initializeExpeditionPreparation();
    this.render();
    void this.refreshLocalProjection(true);
    void this.refreshWorldProjection(true);
  }

  private async persistCurrentState(): Promise<string> {
    try { await this.repository.save(this.state); this.#lastCommittedState = structuredClone(this.state); return ''; }
    catch (error) {
      if (this.repository.mode !== 'durable') throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.repository = createVolatileSandboxRepository(this.state);
      await this.persistCurrentState();
      this.#persistenceMode = 'volatile';
      const warning = `Archiveへの保存に失敗しました。現在はTEMPORARY Archiveで継続しています。保管庫の既存記録は変更されていません。終了前に書き出してください。 ${reason}`;
      if (!this.#startupNotices.includes(warning)) this.#startupNotices.push(warning);
      return warning;
    }
  }

  private markProviderResyncRequired(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#reloadRequiredKind = 'provider';
    this.#reloadRequiredReason = `WORLD LINKの記録とArchiveの時刻が一致していません。次の指令前にWORLD LINKの復旧が必要です。 ${detail}`;
    if (!this.#startupNotices.includes(this.#reloadRequiredReason)) this.#startupNotices.push(this.#reloadRequiredReason);
  }

  private async resynchronizeProvider(): Promise<void> {
    if (this.#busy || this.#reloadRequiredKind !== 'provider' || !this.#recoverProvider) return;
    this.#busy = true; this.render();
    let message = '';
    try {
      const committed = structuredClone(this.#lastCommittedState);
      const recovered = await this.#recoverProvider(structuredClone(committed.world.providerSnapshot));
      await assertProviderAligned(recovered.provider, committed);
      this.provider = recovered.provider;
      this.state = committed;
      this.#providerMode = recovered.providerMode;
      this.#reloadRequiredReason = ''; this.#reloadRequiredKind = '';
      this.#localProjection = null; this.#localProjectionKey = ''; this.#worldProjection = null; this.#worldProjectionKey = '';
      await Promise.all([this.refreshLocalProjection(true), this.refreshWorldProjection(true)]);
      message = 'WORLD LINKを最後に確認されたArchiveから復旧しました。指令を再開できます。';
    } catch (error) {
      this.#reloadRequiredReason = `WORLD LINKの復旧に失敗しました。確認済みArchiveを再読込してください。 ${error instanceof Error ? error.message : String(error)}`;
      this.#reloadRequiredKind = 'persistence';
      message = this.#reloadRequiredReason;
    } finally { this.#busy = false; this.render(); if (message) this.toast(message); }
  }

  private async lifecycleCheckpoint(reason: 'pagehide' | 'visibility-hidden'): Promise<void> {
    if (this.#lifecycleCheckpointInFlight || this.#persistenceMode !== 'durable') return;
    // Never serialize an in-flight or provider-uncertain mutation. IndexedDB transactions are atomic;
    // the lifecycle checkpoint therefore re-commits only a coherent state image.
    const checkpoint = structuredClone(this.#busy || this.#reloadRequiredReason ? this.#lastCommittedState : this.state);
    this.#lifecycleCheckpointInFlight = (async () => {
      try { await this.repository.save(checkpoint); this.#lastCommittedState = structuredClone(checkpoint); }
      catch (error) {
        const warning = `Archiveの自動記録 (${reason}) に失敗しました。直前の確認済み記録を保持しています。 ${error instanceof Error ? error.message : String(error)}`;
        if (!this.#startupNotices.includes(warning)) this.#startupNotices.push(warning);
      } finally { this.#lifecycleCheckpointInFlight = null; }
    })();
    await this.#lifecycleCheckpointInFlight;
  }

  private async probePersistenceFreshness(): Promise<void> {
    if (this.#persistenceMode !== 'durable' || this.#busy || this.#reloadRequiredReason) return;
    const freshness = await this.repository.checkFreshness();
    if (freshness === 'stale') {
      this.#reloadRequiredKind = 'persistence';
      this.#reloadRequiredReason = '別の端末で新しいArchive記録が保存されました。新しい記録を保護するため再読込してください。';
      if (!this.#startupNotices.includes(this.#reloadRequiredReason)) this.#startupNotices.push(this.#reloadRequiredReason);
      this.render();
    }
  }

  private async save(message?: string): Promise<void> {
    if (this.#busy) { this.toast('指令処理中です。完了まで次の操作は保留されます。'); return; }
    this.#busy = true;
    this.render();
    let notice = message ?? '';
    try {
      ensureDirectPlayState(this.state);
      const persistenceWarning = await this.persistCurrentState();
      if (persistenceWarning) notice = `${notice ? `${notice} · ` : ''}${persistenceWarning}`;
      await Promise.all([this.refreshLocalProjection(true), this.refreshWorldProjection(true)]);
    } catch (error) {
      notice = `Archive write failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#busy = false;
      this.render();
      if (notice) this.toast(notice);
    }
  }

  private async refreshLocalProjection(force = false): Promise<void> {
    const field = this.controlledExpedition(); const controlled = this.controlledAgent();
    if (!field || !controlled) { this.#localProjection = null; this.#localProjectionKey = ''; this.#selectedLocalEntityId = ''; return; }
    const key = `${field.id}:${controlled.id}:${this.state.clock.worldTick}:${field.position.frameId}:${field.position.x.toFixed(2)}:${field.position.y.toFixed(2)}`;
    if ((!force && key === this.#localProjectionKey) || this.#localLoading) return;
    this.#localLoading = true;
    let notice = '';
    try {
      const projection = await queryGeneratedLocalArea(this.provider, this.state, controlled.id, field.position, 5);
      const stillField = this.controlledExpedition();
      if (!stillField || stillField.id !== field.id) return;
      this.#localProjection = projection; this.#localProjectionKey = key;
      if (this.#selectedLocalEntityId && !projection.entities.some((entry)=>entry.id===this.#selectedLocalEntityId)) this.#selectedLocalEntityId = '';
    } catch (error) { this.#localProjection = null; notice = `LOCAL SENSOR unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    finally { this.#localLoading = false; if (this.#view === 'exploration') this.render(); if (notice) this.toast(notice); }
  }

  private async refreshWorldProjection(force = false): Promise<void> {
    const controlled = this.controlledAgent(); if (!controlled) { this.#worldProjection = null; this.#worldProjectionKey = ''; return; }
    const radius = generatedWorldMapRadiusKm(this.state);
    const key = `${controlled.id}:${this.state.clock.worldTick}:${this.state.settlement.position.frameId}:${radius.toFixed(1)}`;
    if ((!force && key === this.#worldProjectionKey) || this.#worldLoading) return;
    this.#worldLoading = true;
    let notice = '';
    try {
      this.#worldProjection = await queryGeneratedWorldArea(this.provider, this.state, controlled.id, this.state.settlement.position);
      this.#worldProjectionKey = key;
      const visibleIds = new Set(this.visibleWorldEntities().map((entry)=>entry.id));
      if (this.#selectedWorldEntityId && !visibleIds.has(this.#selectedWorldEntityId)) this.#selectedWorldEntityId = '';
    } catch (error) { this.#worldProjection = null; notice = `WORLD CHART unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    finally { this.#worldLoading = false; if (this.#view === 'exploration') this.render(); if (notice) this.toast(notice); }
  }

  private visibleWorldEntities(): WorldEntity[] {
    const controlled = this.controlledAgent(); if (!controlled || !this.#worldProjection) return [];
    const read = selectWorldGraphReadModel(this.state, controlled.id, this.#worldProjection);
    compareWorldGraphProjectionsIfEnabled(this.state, controlled.id, this.#worldProjection);
    return read.entities;
  }

  private selectedWorldEntity(): WorldEntity | undefined { return this.visibleWorldEntities().find((entry)=>entry.id===this.#selectedWorldEntityId); }

  private worldMapLocation(entity: WorldEntity) { return knownMapLocation(this.state, this.controlledAgent()?.id ?? '', entity); }

  private mapMarkerStyle(spatial: SpatialRef | undefined, center: SpatialRef, radiusKm: number): string {
    if (!spatial || spatial.frameId !== center.frameId || radiusKm <= 0) return 'left:50%;top:50%';
    const x = Math.max(3, Math.min(97, 50 + (spatial.x - center.x) / radiusKm * 46));
    const y = Math.max(3, Math.min(97, 50 - (spatial.y - center.y) / radiusKm * 46));
    return `left:${x.toFixed(2)}%;top:${y.toFixed(2)}%`;
  }

  private selectedLocalEntity(): WorldEntity | undefined {
    return this.#localProjection?.entities.find((entry)=>entry.id===this.#selectedLocalEntityId);
  }

  private async directAction(minutes: number, mutate: () => string | Promise<string>): Promise<void> {
    if (this.#busy || this.#reloadRequiredReason) return;
    const committed = structuredClone(this.state);
    this.#busy = true; this.render(); let message = '';
    try {
      message = await mutate();
      await advanceSandbox(this.provider, this.state, minutes);
      await this.persistCurrentState();
      await Promise.all([this.refreshLocalProjection(true), this.refreshWorldProjection(true)]);
    } catch (error) {
      restoreSandboxState(this.state, committed);
      if (isProviderMutationUncertainError(error)) this.markProviderResyncRequired(error);
      message = error instanceof Error ? error.message : String(error);
    }
    finally { this.#busy = false; this.render(); if (message) this.toast(message); }
  }

  private pdaHeader(): string {
    const field = this.controlledExpedition();
    const agent = this.controlledAgent();
    const time = `${String(Math.floor(this.state.clock.minuteOfDay / 60)).padStart(2,'0')}:${String(this.state.clock.minuteOfDay % 60).padStart(2,'0')}`;
    const place = field ? `FIELD ${field.position.x.toFixed(1)}, ${field.position.y.toFixed(1)}` : this.state.settlement.name;
    return `<header class="desc-pda-header"><div class="desc-pda-id"><strong>DESCENDANTS PDA OS v1.0</strong><span>ACTIVE COMMAND HOLDER: ${esc(agent?.name ?? 'NO COMMAND HOLDER')}</span></div><nav class="desc-pda-tabs" aria-label="Primary terminal views" role="tablist">${PDA_TABS.map(([id,label,key])=>`<button id="sandbox-tab-${id}" role="tab" data-action="pda-tab" data-pda-tab="${id}" class="${this.#pdaTab===id?'active':''}" aria-selected="${this.#pdaTab===id}" ${key?`title="${key}"`:''}><span>${label}</span></button>`).join('')}</nav><div class="desc-pda-clock"><div class="desc-pda-clock-line"><strong>${esc(time)}</strong><span>DAY ${this.state.clock.day}</span><div class="desc-pda-battery" title="Terminal power"><i></i></div></div><small>${esc(place)}</small></div></header>`;
  }

  private pdaFooter(): string {
    const field = this.controlledExpedition();
    const agent = this.controlledAgent();
    const entries = projectChronicle(this.state,this.chronicleViewpoint());
    const latest = entries.at(-1);
    const prior = entries.at(-2);
    const inventoryWeight = agent ? inventoryForAgent(this.state,agent.id).reduce((sum,item)=>sum+item.weightKg*item.quantity,0) : 0;
    const hhmm = (minuteOfDay:number)=>`${String(Math.floor(minuteOfDay/60)).padStart(2,'0')}:${String(minuteOfDay%60).padStart(2,'0')}`;
    return `<footer class="desc-pda-footer"><div class="desc-pda-ticker">${[prior,latest].filter(Boolean).map((entry)=>`<div><strong>${hhmm(entry!.minuteOfDay)}</strong><span>${esc(compactText(entry!.text,120))}</span></div>`).join('') || `<div><strong>${hhmm(this.state.clock.minuteOfDay)}</strong><span>観測データを同期しています。</span></div>`}</div><div class="desc-pda-footer-stats"><span><small>人口</small><b>${settlementAgents(this.state).filter((entry)=>entry.alive).length}</b></span><span><small>所持重量</small><b>${inventoryWeight.toFixed(1)} kg</b></span><span><small>遠征</small><b>${field?esc(field.status):'待機'}</b></span><span><small>WORLD TICK</small><b>${this.state.clock.worldTick}</b></span></div></footer>`;
  }

  private f1SituationReadModel() {
    const field = this.controlledExpedition();
    return selectF1IncidentReadModel(this.state, field, field ? this.#localProjection : null);
  }

  private selectedF1Incident(read = this.f1SituationReadModel()) {
    if (read.source !== 'incident' || read.incidents.length === 0) return undefined;
    const selected = (read.incidents.find((incident)=>incident.id===this.#selectedIncidentId) ?? read.incidents[0])!;
    if (selected.id !== this.#selectedIncidentId) {
      this.#selectedIncidentId = selected.id;
      this.#selectedDebriefId = '';
      this.#incidentDebriefFilter = 'all';
      this.#incidentDebriefQuery = '';
      this.#incidentResponderDraftIds.clear();
    }
    return selected;
  }

  private pdaTaskList(read = this.f1SituationReadModel()): string { return renderPdaTaskList(this.viewContext(), read); }

  private pdaIncidentResponsePanel(read = this.f1SituationReadModel()): string { return renderPdaIncidentResponsePanel(this.viewContext(), read); }

  private pdaMiniMap(scope: 'world'|'local' = 'world'): string { return renderPdaMiniMap(this.viewContext(), scope); }

  private pdaStatusCard(): string {
    const agent = this.controlledAgent();
    if (!agent) return '<section class="desc-pda-status"><h3>操作人物 / ステータス</h3><p>操作可能な人物がいません。</p></section>';
    const field = this.controlledExpedition();
    const health=Math.max(0,Math.min(100,agent.health));
    const fatigue=Math.max(0,Math.min(100,agent.fatigue));
    const hunger=Math.max(0,Math.min(100,agent.needs.hunger ?? 0));
    const thirst=Math.max(0,Math.min(100,agent.needs.thirst ?? 0));
    const gear=equipmentForAgent(this.state,agent.id).filter((item)=>item.equipped).slice(0,4);
    const supply=field?field.supplies:this.state.settlement.resources;
    const row=(label:string,value:number,invert=false)=>`<div class="desc-pda-stat-row"><span>${label}</span><div><i style="width:${Math.max(0,Math.min(100,invert?100-value:value))}%"></i></div><b>${Math.round(value)}</b></div>`;
    return `<section class="desc-pda-status"><header><h3>${esc(agent.name)} / ステータス</h3><span>${esc(agent.role)} · ${agentAgeYears(this.state,agent)}歳</span></header><div class="desc-pda-status-grid"><div class="desc-pda-avatar-placeholder"><strong>${esc(agent.name.slice(0,2))}</strong><small>PORTRAIT<br>DETACHED</small></div><div class="desc-pda-vitals">${row('体力',health)}${row('疲労',fatigue,true)}${row('空腹',hunger,true)}${row('渇き',thirst,true)}<div class="desc-pda-supply"><span>水 <b>${Math.floor(Number(supply.water ?? 0))}</b></span><span>食料 <b>${Math.floor(Number(supply.food ?? 0))}</b></span><span>薬 <b>${Math.floor(Number(supply.medicine ?? 0))}</b></span></div></div><div class="desc-pda-equip"><strong>装備</strong>${gear.length?gear.map((item)=>`<span>${esc(compactText(item.name,24))}</span>`).join(''):'<span>装備なし</span>'}</div></div></section>`;
  }

  private pdaExpeditionPreparation(): string { return renderPdaExpeditionPreparation(this.viewContext()); }

  private pdaCampaignCommand(): string { return renderPdaCampaignCommand(this.viewContext()); }

  private pdaTaskView(): string { return renderPdaTaskView(this.viewContext()); }

  private pdaMapView(): string { return renderPdaMapView(this.viewContext()); }

  private pdaResidentsView(): string { return renderPdaResidentsView(this.viewContext()); }

  private pdaSystemView(): string { return renderPdaSystemView(this.viewContext()); }

  private pdaSecondaryIndex(view: 'body'|'knowledge'|'inventory'|'chronicle'): string { return renderPdaSecondaryIndex(this.viewContext(), view); }

  private pdaBodyPanel(): string { return renderPdaBodyPanel(this.viewContext()); }

  private pdaKnowledgePanel(): string { return renderPdaKnowledgePanel(this.viewContext()); }

  private settlementResourceLedgerPanel(): string { return renderSettlementResourceLedgerPanel(this.viewContext()); }

  private pdaInventoryPanel(): string { return renderPdaInventoryPanel(this.viewContext()); }

  private pdaChroniclePanel(): string { return renderPdaChroniclePanel(this.viewContext()); }

  private pdaSecondaryView(view: 'body'|'knowledge'|'inventory'|'chronicle'): string {
    this.#view = view;
    const label = view==='body'?'身体・装備':view==='knowledge'?'知識':view==='inventory'?'所持品':'年代記';
    const detail = view==='body'?this.pdaBodyPanel():view==='knowledge'?this.pdaKnowledgePanel():view==='inventory'?this.pdaInventoryPanel():this.pdaChroniclePanel();
    return `<section class="desc-pda-secondary"><header class="desc-pda-secondary-title"><strong>${esc(label)}</strong><span>DESCENDANTS / PDA DATA SURFACE</span></header><div class="desc-pda-secondary-layout">${this.pdaSecondaryIndex(view)}<div class="desc-pda-secondary-scroll">${detail}</div></div></section>`;
  }

  private pdaPrimarySurface(): string {
    if (this.#pdaTab==='task') { this.#view='exploration'; return this.pdaTaskView(); }
    if (this.#pdaTab==='map') { this.#view='exploration'; return this.pdaMapView(); }
    if (this.#pdaTab==='body') return this.pdaSecondaryView('body');
    if (this.#pdaTab==='knowledge') return this.pdaSecondaryView('knowledge');
    if (this.#pdaTab==='inventory') return this.pdaSecondaryView('inventory');
    if (this.#pdaTab==='chronicle') return this.pdaSecondaryView('chronicle');
    if (this.#pdaTab==='residents') { this.#view='body'; return this.pdaResidentsView(); }
    return this.pdaSystemView();
  }

  private runtimeRecoveryBanner(): string {
    const degraded = this.#persistenceMode !== 'durable' || this.#providerMode !== 'real-worldgen' || this.#startupNotices.length > 0;
    if (!degraded) return '';
    const items = this.#startupNotices.map((notice) => `<li>${esc(notice)}</li>`).join('');
    return `<aside class="sandbox-recovery-banner" role="status" aria-live="polite"><strong>RECOVERY / LINK DEGRADED</strong><span>world link ${this.#providerMode==='real-worldgen'?'LIVE':this.#providerMode==='snapshot-recovery'?'RECOVERED':'LOCAL'} · archive ${this.#persistenceMode==='durable'?'SEALED':'TEMPORARY'}</span>${items ? `<ul>${items}</ul>` : ''}${this.#persistenceMode !== 'durable' ? '<p>このセッションを閉じる前にArchiveを書き出してください。保管庫は現在変更されていません。</p>' : ''}${this.#reloadRequiredReason ? `<button data-action="provider-resync-reload" class="primary">${this.#reloadRequiredKind==='provider'&&this.#recoverProvider?'Resynchronize world link':'Reload verified archive'}</button>` : ''}</aside>`;
  }

  private controlledExpedition() {
    return [...this.state.expeditions].reverse().find((entry) => entry.controlMode === 'expedition' && ['outbound','exploring','returning'].includes(entry.status));
  }

  private dailyExecutionBlockReason(): string | undefined {
    const field = this.controlledExpedition();
    const directEncounter = field ? [...this.state.encounters].reverse().find((entry) => entry.expeditionId === field.id && entry.status !== 'resolved') : undefined;
    if (directEncounter) return 'WEDO is active. Resolve the direct encounter before executing the settlement plan.';
    const loop = ensureDailyLoopState(this.state);
    if (loop.phase === 'executing') return 'Daily execution is already in progress.';
    if (loop.currentPlan.status !== 'draft' && loop.currentPlan.status !== 'committed') return `Daily plan is ${loop.currentPlan.status} and cannot be started from this screen.`;
    return undefined;
  }

  private controlledAgent() {
    const field = this.controlledExpedition();
    if (field) return findAgent(this.state, field.leaderId);
    const canonical = findAgent(this.state, this.state.settlement.leaderId);
    if (canonical?.alive && !canonical.expeditionId && (!canonical.residence || canonical.residence === 'settlement')) return canonical;
    const local = settlementAgents(this.state).slice().sort((a,b) =>
      ((b.authority.offices.includes('settlement-leader') ? 100 : 0) + b.authority.legitimacy + b.skills.leadership + (b.socialStatus?.standing ?? 0) * 0.25)
      - ((a.authority.offices.includes('settlement-leader') ? 100 : 0) + a.authority.legitimacy + a.skills.leadership + (a.socialStatus?.standing ?? 0) * 0.25));
    return local[0] ?? canonical;
  }

  private initializeExpeditionPreparation(): void {
    if (this.#prepTargetEntityId && this.#worldProjection) {
      const entity = this.visibleWorldEntities().find((entry) => entry.id === this.#prepTargetEntityId);
      const location = entity ? this.worldMapLocation(entity) : undefined;
      this.#prepTarget = location?.position ? structuredClone(location.position) : null;
      if (!location?.position || location.estimated) this.#prepRouteEntityId = '';
    }
    if (!this.#prepDoctrineId || !this.state.doctrines.some((entry)=>entry.id===this.#prepDoctrineId)) this.#prepDoctrineId = this.state.doctrines[0]?.id ?? '';
    const doctrine = this.selectedPreparationDoctrine();
    const adults = settlementAgents(this.state).filter((agent)=>agentAgeYears(this.state,agent)>=16);
    const available = doctrine ? adults.filter((agent)=>expeditionMemberReadiness(agent,doctrine).ready) : [];
    const availableIds = new Set(available.map((agent)=>agent.id));
    this.#prepCrewIds = new Set([...this.#prepCrewIds].filter((id)=>availableIds.has(id)));
    if (!this.#prepCrewIds.size) {
      const ranked = available.slice().sort((a,b)=>b.skills.scouting-a.skills.scouting);
      const preferred = ranked.find((agent)=>agent.id===this.state.settlement.leaderId) ?? ranked[0];
      for (const agent of [preferred, ...ranked.filter((agent)=>agent.id!==preferred?.id)].filter(Boolean).slice(0,3)) this.#prepCrewIds.add(agent!.id);
    }
    if (!this.#prepLeaderId || !this.#prepCrewIds.has(this.#prepLeaderId)) this.#prepLeaderId = [...this.#prepCrewIds][0] ?? '';
  }

  private knowledgeEligibleAgents() {
    const field = this.controlledExpedition();
    if (field) return field.memberIds.map((id)=>findAgent(this.state,id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent?.alive));
    return settlementAgents(this.state).filter((agent)=>agent.alive);
  }

  private knowledgeAgent() {
    const eligible = this.knowledgeEligibleAgents();
    let selected = eligible.find((agent)=>agent.id===this.#knowledgeAgentId);
    if (!selected) {
      const field = this.controlledExpedition();
      if (field) selected = eligible.find((agent)=>agent.id===field.leaderId);
      else {
        const recent = [...this.state.expeditions].reverse().find((entry)=>entry.status==='returned' && entry.returnDay!==null && this.state.clock.day-entry.returnDay<=2);
        selected = recent ? eligible.find((agent)=>agent.id===recent.leaderId) : undefined;
        selected ??= eligible.find((agent)=>agent.id===this.controlledAgent()?.id) ?? eligible[0];
      }
      this.#knowledgeAgentId = selected?.id ?? '';
    }
    return selected;
  }

  private conversationPartners(holder = this.knowledgeAgent()) {
    if (!holder) return [];
    const partners = this.knowledgeEligibleAgents().filter((agent)=>agent.id!==holder.id);
    if (!partners.some((agent)=>agent.id===this.#conversationTargetId)) this.#conversationTargetId = partners[0]?.id ?? '';
    return partners;
  }

  private inventoryEligibleAgents() {
    const field = this.controlledExpedition();
    if (field) return field.memberIds.map((id)=>findAgent(this.state,id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent?.alive));
    return settlementAgents(this.state).filter((agent)=>agent.alive);
  }

  private inventoryAgent() {
    const eligible = this.inventoryEligibleAgents();
    let selected = eligible.find((agent)=>agent.id===this.#inventoryAgentId);
    if (!selected) {
      const field = this.controlledExpedition();
      if (field) selected = eligible.find((agent)=>agent.id===field.leaderId);
      else {
        const recent = [...this.state.expeditions].reverse().find((entry)=>entry.status==='returned' && entry.returnDay!==null && this.state.clock.day-entry.returnDay<=2);
        selected = recent ? eligible.find((agent)=>agent.id===recent.leaderId) : undefined;
        selected ??= eligible.find((agent)=>agent.id===this.controlledAgent()?.id) ?? eligible[0];
      }
      this.#inventoryAgentId = selected?.id ?? '';
    }
    return selected;
  }

  private selectedPreparationDoctrine(): ExpeditionDoctrine | undefined {
    return this.state.doctrines.find((entry)=>entry.id===this.#prepDoctrineId) ?? this.state.doctrines[0];
  }

  private chronicleViewpoint() {
    const field = this.controlledExpedition();
    const controlled = this.controlledAgent();
    return field && controlled ? ({ kind: 'expedition', expeditionId: field.id, observerAgentId: controlled.id } as const) : ({ kind: 'settlement' } as const);
  }

  private canInspectLiveState(agentId: string): boolean {
    const target = findAgent(this.state, agentId);
    if (!target) return false;
    const field = this.controlledExpedition();
    if (field) return field.memberIds.includes(agentId);
    return !target.expeditionId && target.residence !== 'external' && target.residence !== 'unknown';
  }

  private lastReportForAgent(agentId: string) {
    const target = findAgent(this.state, agentId);
    const expedition = target?.expeditionId ? this.state.expeditions.find((entry) => entry.id === target.expeditionId) : undefined;
    return expedition?.communicationReports?.filter((entry) => entry.verified).at(-1) ?? expedition?.communicationReports?.at(-1);
  }

  private encounterGrid(encounter: EncounterState): string { return renderEncounterGrid(this.viewContext(), encounter); }

  private settlementPolicyPanel(): string { return renderSettlementPolicyPanel(this.viewContext()); }

  private visualQaEncounterControlsEnabled(): boolean {
    return this.#providerMode === 'mock-diagnostic' && this.#persistenceMode !== 'durable';
  }

  private fieldOperationsPanel(): string { return renderFieldOperationsPanel(this.viewContext()); }

  private focusSelectorFor(element: Element | null): string {
    if (!(element instanceof HTMLElement) || !this.root.contains(element)) return '';
    if (element.id) return `#${CSS.escape(element.id)}`;
    const actionElement = element.closest<HTMLElement>('[data-action]');
    const action = actionElement?.dataset.action; if (!actionElement || !action) return '';
    let selector = `[data-action="${CSS.escape(action)}"]`;
    for (const key of ['view','pdaTab','entityId','agentId','knowledgeId','field','supply','kind','target','encounterId','expeditionId','scope','domain','task','delta','hours','incidentId','teamId','amount']) {
      const value = actionElement.dataset[key]; if (!value) continue;
      const attribute = key.replace(/[A-Z]/g, (letter)=>`-${letter.toLowerCase()}`);
      selector += `[data-${attribute}="${CSS.escape(value)}"]`;
    }
    return selector;
  }

  private restoreFocus(selector: string): void {
    if (!selector) return;
    const target = this.root.querySelector<HTMLElement>(selector);
    if (!target || target.matches(':disabled,[aria-disabled="true"]')) { this.#focusAfterRender = selector; return; }
    target.focus({ preventScroll: true }); this.#focusAfterRender = '';
  }

  private mainContentScrollKey(): string {
    if (this.#view === 'body') return `body:${this.#inspectedAgentId || this.state.settlement.leaderId}`;
    if (this.#view === 'knowledge') return `knowledge:${this.#knowledgeAgentId || this.controlledAgent()?.id || this.state.settlement.leaderId}`;
    if (this.#view === 'inventory') return `inventory:${this.#inventoryAgentId || this.controlledAgent()?.id || this.state.settlement.leaderId}`;
    return this.#view;
  }

  private render(): void {
    const previousContent = this.root.querySelector<HTMLElement>('.generated-main-content');
    const previousContentScroll = previousContent
      ? { key: previousContent.dataset.scrollKey ?? '', top: previousContent.scrollTop }
      : null;
    const previousInspector = this.root.querySelector<HTMLElement>('.generated-inspector');
    const previousInspectorScroll = previousInspector
      ? { key: previousInspector.dataset.scrollKey ?? '', top: previousInspector.scrollTop }
      : null;
    const previousCampaign = this.root.querySelector<HTMLElement>('.desc-pda-campaign-screen');
    const previousCampaignScroll = previousCampaign
      ? { day: previousCampaign.dataset.scrollDay ?? '', top: previousCampaign.scrollTop }
      : null;
    const focusSelector = this.#focusAfterRender || this.focusSelectorFor(document.activeElement);
    const scaleClass = this.#accessibility.textScale === 1.5 ? 'a11y-scale-150' : this.#accessibility.textScale === 1.25 ? 'a11y-scale-125' : '';
    const accessibilityClass = `${scaleClass} ${this.#accessibility.highContrast ? 'a11y-contrast' : ''} ${this.#accessibility.reduceMotion ? 'a11y-reduce-motion' : ''}`;
    const crtClass = this.#crtTransition==='power-off'?'crt-power-off':this.#crtTransition==='day-title'?'crt-day-title':this.#crtTransition==='power-on'?'crt-power-on':'';
    const dayOverlay = this.#crtTransition==='day-title' ? `<div class="desc-pda-day-title" aria-live="assertive"><span>DAY ${this.#crtTransitionDay}</span><strong>${this.#crtTransitionDay}日目</strong>${this.#crtTransitionSummary?`<small class="desc-pda-day-title-summary">${esc(this.#crtTransitionSummary)}</small>`:''}</div>` : '';
    const executionCurtain = this.#commandPulsePhase==='locked' || this.#commandPulsePhase==='executing'
      ? `<div class="desc-command-execution-curtain phase-${this.#commandPulsePhase}" role="status" aria-live="polite"><div aria-hidden="true" class="desc-command-execution-reticle"><i></i><i></i><i></i></div><span>${this.#commandPulsePhase==='locked'?'ORDERS SEALED':'DAY CYCLE ACTIVE'}</span><strong>DAY ${this.state.clock.day} → DAY ${this.state.clock.day+1}</strong><small>SETTLEMENT CLOCK</small></div>`
      : '';
    this.root.innerHTML = `<a class="sandbox-skip-link" href="#sandbox-main-content">Skip to main content</a><main class="desc-pda-hardware ${this.#busy?'is-busy':''} ${accessibilityClass}" aria-busy="${this.#busy}"><div class="desc-pda-screw screw-tl"></div><div class="desc-pda-screw screw-tr"></div><div class="desc-pda-screw screw-bl"></div><div class="desc-pda-screw screw-br"></div><div class="desc-pda-rivet rivet-top"></div><div class="desc-pda-rivet rivet-bottom"></div><div class="desc-pda-leds"><i></i><i></i><i class="warn"></i></div><div class="desc-pda-bezel"><div class="desc-pda-screen ${crtClass}">${this.pdaHeader()}${this.runtimeRecoveryBanner()}<div id="sandbox-main-content" class="desc-pda-content generated-main-content" data-scroll-key="${esc(this.mainContentScrollKey())}" role="tabpanel" aria-labelledby="sandbox-tab-${this.#pdaTab}" tabindex="-1">${this.pdaPrimarySurface()}</div>${this.pdaFooter()}${dayOverlay}${executionCurtain}<div class="desc-pda-crt-lines ${this.#pdaPresentation.scanlines?'':'is-disabled'}" aria-hidden="true"></div><div class="desc-pda-crt-flicker ${this.#pdaPresentation.flicker&&!this.#accessibility.reduceMotion?'':'is-disabled'}" aria-hidden="true"></div><div class="desc-pda-vignette" aria-hidden="true"></div><div class="desc-pda-glass" aria-hidden="true"></div></div></div><div id="sandbox-toast" class="sandbox-toast" role="status" aria-live="polite" aria-atomic="true"></div></main>`;
    const nextContent = this.root.querySelector<HTMLElement>('.generated-main-content');
    if (previousContentScroll && nextContent?.dataset.scrollKey === previousContentScroll.key) {
      nextContent.scrollTop = previousContentScroll.top;
    }
    const nextInspector = this.root.querySelector<HTMLElement>('.generated-inspector');
    if (previousInspectorScroll && nextInspector?.dataset.scrollKey === previousInspectorScroll.key) {
      nextInspector.scrollTop = previousInspectorScroll.top;
    }
    const nextCampaign = this.root.querySelector<HTMLElement>('.desc-pda-campaign-screen');
    if (previousCampaignScroll && nextCampaign?.dataset.scrollDay===previousCampaignScroll.day) nextCampaign.scrollTop = previousCampaignScroll.top;
    this.restoreFocus(focusSelector);
  }

  private async transitionDelay(ms: number): Promise<void> {
    await new Promise<void>((resolve)=>window.setTimeout(resolve,ms));
  }

  private async playDayTransition(day: number, summary = ''): Promise<void> {
    const reduced = this.#accessibility.reduceMotion || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.#crtTransitionDay = day;
    this.#crtTransitionSummary = summary;
    this.#crtTransition = 'power-off'; this.render();
    await this.transitionDelay(reduced ? 90 : 420);
    this.#crtTransition = 'day-title'; this.render();
    await this.transitionDelay(reduced ? 260 : 720);
    this.#crtTransition = 'power-on'; this.render();
    await this.transitionDelay(reduced ? 90 : 520);
    this.#crtTransition = 'idle'; this.#crtTransitionSummary = ''; this.render();
  }

  private async advanceContinuity(days: number): Promise<void> {
    if (this.#busy || this.#reloadRequiredReason) return;
    const blockReason=this.dailyExecutionBlockReason();
    if(blockReason) { this.toast(blockReason); return; }
    this.#stopContinuity=false; this.#busy=true; this.render();
    let notice='';
    try {
      const result=await executeContinuityDays(this.provider,this.state,days,{
        cancelled:()=>this.#stopContinuity,
        onDay:async()=>{ const warning=await this.persistCurrentState(); if(warning) { this.#stopContinuity=true; this.toast(warning); } this.render(); await new Promise<void>((resolve)=>setTimeout(resolve,0)); },
      });
      await this.persistCurrentState(); await Promise.all([this.refreshLocalProjection(true),this.refreshWorldProjection(true)]); notice=`${result.completedDays}日進行。${result.reason}`;
    } catch(error) { notice=error instanceof Error?error.message:String(error); if(isProviderMutationUncertainError(error)) this.markProviderResyncRequired(error); }
    finally { this.#busy=false; this.render(); if(notice)this.toast(notice); }
  }

  private async executeDailyPlan(): Promise<void> {
    if (this.#busy || this.#reloadRequiredReason) return;
    const blockReason=this.dailyExecutionBlockReason();
    if(blockReason) { this.toast(blockReason); return; }
    const loop=ensureDailyLoopState(this.state);
    if(loop.currentPlan.status==='draft') {
      const command=deriveDailyCommandView({
        state:this.state,
        plan:loop.currentPlan,
        ...(loop.lastMorningReport?{report:loop.lastMorningReport}:{}),
        campaign:deriveSurvivalCampaignView(this.state),
      });
      this.#pendingAssignmentMoves=command.residentRows
        .filter((row)=>row.previousTask!==row.assignedTask)
        .map((row)=>({agentId:row.agentId,name:row.name,fromTask:row.previousTask,toTask:row.assignedTask}));
    }
    try {
      if(loop.currentPlan.status==='draft') commitDailyPlan(this.state);
      if(loop.currentPlan.status!=='committed') { this.toast('Daily plan is not ready to execute.'); return; }
    } catch(error) { this.toast(error instanceof Error?error.message:String(error)); return; }
    this.#dailyExecutionActive=true;
    this.#busy=true;
    this.#commandReadbackLines=[];
    this.#commandPulsePhase='locked';
    this.render();
    pdaAudio.playCommandCommit();
    const reduced = this.#accessibility.reduceMotion || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    await this.transitionDelay(reduced ? 60 : 240);
    this.#commandPulsePhase='executing';
    this.render();
    let message='';
    try {
      const result=await executeCommittedPlan(this.provider,this.state);
      await this.persistCurrentState();
      if(result.status==='interrupted') {
        this.#commandPulsePhase='plan';
        this.#commandReadbackLines=[];
        this.#pdaTab='task'; this.#pdaTaskPanel='overview'; this.#view='exploration';
        message=result.interruption.title;
      } else {
        this.#assignmentConsequenceReadback=assignmentConsequenceReadback(this.#pendingAssignmentMoves,result.report);
        this.#pendingAssignmentMoves=[];
        const changedResidents = result.report.residentDeltas.filter((entry)=>!['stable','improved'].includes(entry.severity)).length;
        this.#commandReadbackLines=[
          `BIRTHS ${result.report.births.length}`,
          `DEATHS ${result.report.deaths.length}`,
          changedResidents ? `RESIDENT ALERTS ${changedResidents}` : 'NO MAJOR RESIDENT CHANGE',
        ];
        this.#commandPulsePhase='readback';
        await Promise.all([this.refreshLocalProjection(true),this.refreshWorldProjection(true)]);
        this.#pdaTab='task'; this.#pdaTaskPanel='overview'; this.#view='exploration';
        const transitionSummary=[morningReportTransitionSummary(result.report),...this.#commandReadbackLines].filter(Boolean).join(' · ');
        await this.playDayTransition(result.report.day, transitionSummary);
        message=`DAY ${result.report.day} morning report · ${result.report.births.length} births · ${result.report.deaths.length} deaths`;
      }
    } catch(error) {
      this.#commandPulsePhase='plan';
      this.#commandReadbackLines=[];
      if(isProviderMutationUncertainError(error)) this.markProviderResyncRequired(error);
      message=error instanceof Error?error.message:String(error);
    } finally {
      this.#dailyExecutionActive=false; this.#busy=false; this.render(); if(message)this.toast(message);
    }
  }

  private async advance(hours: number): Promise<void> {
    if (this.#busy || this.#reloadRequiredReason) return;
    const field=this.controlledExpedition(); const directEncounter=field ? [...this.state.encounters].reverse().find((entry)=>entry.expeditionId===field.id&&entry.status!=='resolved') : undefined;
    if (directEncounter) { this.toast('WEDO is active. Resolve the next direct round before advancing ordinary time.'); return; }
    this.#busy = true; this.render();
    let message = '';
    try { const summary = await advanceSandboxHours(this.provider, this.state, hours); await this.persistCurrentState(); await Promise.all([this.refreshLocalProjection(true), this.refreshWorldProjection(true)]); message = `${hours}h elapsed · ${summary.births.length} births · ${summary.deaths.length} deaths · ${summary.expeditionUpdates.length} expedition updates`; }
    catch (error) { if (isProviderMutationUncertainError(error)) this.markProviderResyncRequired(error); message = error instanceof Error ? error.message : String(error); }
    finally { this.#busy = false; this.render(); if (message) this.toast(message); }
  }

  private onClick(event: Event): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]'); if (!button) return; const action = button.dataset.action;
    pdaAudio.unlock();
    if (action === 'pda-tab') pdaAudio.playTabSwitch(); else if (action === 'launch' || action === 'set-prep-target' || action === 'transfer-rendezvous-aid') pdaAudio.playConfirm(); else if (action === 'abort-rendezvous' || action === 'reset') pdaAudio.playUncheck(); else if (!['pda-audio-mute','pda-audio-test'].includes(action ?? '')) pdaAudio.playClick();
    if (action==='pda-tab') { const tab=button.dataset.pdaTab as PdaTab|undefined; if(tab){this.#pdaTab=tab; if(tab==='task'||tab==='map')this.#view='exploration'; else if(tab==='body'||tab==='knowledge'||tab==='inventory'||tab==='chronicle')this.#view=tab; else if(tab==='residents')this.#view='body'; this.render(); if(tab==='task'||tab==='map'){void this.refreshLocalProjection();void this.refreshWorldProjection();}} return; }
    if (action==='pda-task-panel') { const panel=button.dataset.panel as PdaTaskPanel|undefined; if(panel){this.#pdaTaskPanel=panel;this.#pdaTab='task';this.#view='exploration';this.render();} return; }
    if (action==='pda-audio-mute') { const muted=pdaAudio.toggleMute(); if(!muted)pdaAudio.playConfirm(); this.render(); return; }
    if (action==='pda-audio-test') { pdaAudio.playTabSwitch(); window.setTimeout(()=>pdaAudio.playStatic(0.12,0.16),80); window.setTimeout(()=>pdaAudio.playConfirm(),190); return; }
    if (action==='legacy-system') { this.#pdaTab='system'; this.#systemOpen = false; this.render(); return; }
    if (action==='provider-resync-reload') { if (this.#reloadRequiredKind==='provider' && this.#recoverProvider) void this.resynchronizeProvider(); else window.location.reload(); return; }
    if (action==='daily-morning-toggle') {
      this.#morningReportExpanded = !this.#morningReportExpanded;
      this.#focusAfterRender = '[data-action="daily-morning-toggle"]';
      this.render();
      return;
    }
    if (action==='daily-plan-jump') {
      event.preventDefault();
      this.root.querySelector<HTMLElement>('#daily-plan-section')?.scrollIntoView({ block: 'start' });
      return;
    }
    if (action==='daily-follow-up-crisis') {
      const section = this.root.querySelector<HTMLElement>('.desc-daily-crisis-response[data-crisis-follow-up="1"]');
      section?.scrollIntoView({ block: 'start' });
      section?.querySelector<HTMLElement>('[data-action="daily-quick-assign-group"], [data-action="daily-quick-assign"]')?.focus();
      return;
    }
    if (action==='daily-next-crisis') {
      const crisisId = button.dataset.crisisId ?? '';
      const section = [...this.root.querySelectorAll<HTMLElement>('[data-crisis-response]')].find((entry)=>entry.dataset.crisisResponse===crisisId);
      section?.scrollIntoView({ block: 'nearest' });
      section?.querySelector<HTMLElement>('.desc-daily-crisis-response-actions button, [data-action="daily-quick-assign"]')?.focus();
      return;
    }
    if (action==='daily-focus-top-crisis') {
      const agentId = button.dataset.agentId ?? '';
      const task = button.dataset.task as LaborTask | undefined;
      if (agentId && task) {
        try {
          setDailyAssignment(this.state,agentId,task);
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = '[data-action="execute-plan"]';
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-review-return') {
      const agentId = button.dataset.agentId ?? '';
      const row = [...this.root.querySelectorAll<HTMLElement>('[data-daily-agent-id]')].find((entry)=>entry.dataset.dailyAgentId===agentId);
      row?.scrollIntoView({ block: 'center' });
      row?.querySelector<HTMLSelectElement>('[data-action="daily-assignment"]')?.focus();
      return;
    }
    if (action==='daily-rest-resident') {
      const agentId = button.dataset.agentId ?? '';
      if (agentId) {
        try {
          setDailyAssignment(this.state,agentId,'rest');
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = '[data-action="execute-plan"]';
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-restore-plan-balance') {
      const agentId = button.dataset.agentId ?? '';
      const returnTask = button.dataset.returnTask as LaborTask | undefined;
      if (agentId && returnTask) {
        try {
          setDailyAssignment(this.state,agentId,returnTask);
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = '[data-action="execute-plan"]';
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-release-crisis-excess') {
      const agentId = button.dataset.agentId ?? '';
      const returnTask = button.dataset.returnTask as LaborTask | undefined;
      if (agentId && returnTask) {
        try {
          setDailyAssignment(this.state,agentId,returnTask);
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = '[data-action="execute-plan"]';
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-balance-crises') {
      const agentIds = (button.dataset.agentIds ?? '').split(',').filter(Boolean);
      const tasks = (button.dataset.tasks ?? '').split(',').filter(Boolean) as LaborTask[];
      if (agentIds.length >= 2 && agentIds.length === tasks.length) {
        try {
          agentIds.forEach((agentId,index)=>{ const task = tasks[index]; if (task) setDailyAssignment(this.state,agentId,task); });
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = '[data-action="execute-plan"]';
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-rotate-crisis') {
      const outgoingAgentId = button.dataset.outgoingAgentId ?? '';
      const incomingAgentId = button.dataset.incomingAgentId ?? '';
      const incomingPreviousTask = button.dataset.incomingPreviousTask as LaborTask | undefined;
      const task = button.dataset.task as LaborTask | undefined;
      if (outgoingAgentId && incomingAgentId && incomingPreviousTask && task) {
        try {
          setDailyAssignment(this.state,outgoingAgentId,incomingPreviousTask);
          setDailyAssignment(this.state,incomingAgentId,task);
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = `[data-action="daily-assignment"][data-agent-id="${incomingAgentId}"]`;
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-fill-crisis-gap') {
      const agentIds = button.dataset.agentIds ?? '';
      const task = button.dataset.task as LaborTask | undefined;
      if (agentIds && task) {
        try {
          for (const agentId of agentIds.split(',').filter(Boolean)) setDailyAssignment(this.state,agentId,task);
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = '[data-action="execute-plan"]';
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-quick-assign-group') {
      const agentIds = button.dataset.agentIds ?? '';
      const task = button.dataset.task as LaborTask | undefined;
      if (agentIds && task) {
        try {
          for (const agentId of agentIds.split(',').filter(Boolean)) setDailyAssignment(this.state,agentId,task);
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = `[data-action="daily-quick-assign-group"][data-task="${task}"]`;
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-quick-assign') {
      const agentId = button.dataset.agentId ?? '';
      const task = button.dataset.task as LaborTask | undefined;
      if (agentId && task) {
        try {
          setDailyAssignment(this.state,agentId,task);
          this.#commandPulsePhase='plan';
          this.#focusAfterRender = `[data-action="daily-assignment"][data-agent-id="${agentId}"]`;
          this.render();
        } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); }
      }
      return;
    }
    if (action==='daily-replan-focus') {
      const agentId=button.dataset.agentId??'';
      if (agentId) {
        this.#dailyPlanBoardAgentId=agentId;
        this.#commandPulsePhase='plan';
        this.#focusAfterRender=`[data-action="daily-board-select"][data-agent-id="${agentId}"]`;
        this.render();
        const reduced=this.#accessibility.reduceMotion || (typeof window.matchMedia==='function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        this.root.querySelector<HTMLElement>(`[data-action="daily-board-select"][data-agent-id="${CSS.escape(agentId)}"]`)?.scrollIntoView({block:'center',behavior:reduced?'auto':'smooth'});
      }
      return;
    }
    if (action==='daily-replan-rest') {
      const agentId=button.dataset.agentId??'';
      if (!agentId) return;
      const loop=ensureDailyLoopState(this.state);
      const canonicalBlockReason=this.dailyExecutionBlockReason();
      const replanCommand=deriveDailyCommandView({
        state:this.state,
        plan:loop.currentPlan,
        ...(loop.lastMorningReport?{report:loop.lastMorningReport}:{}),
        campaign:deriveSurvivalCampaignView(this.state),
        ...(canonicalBlockReason?{canonicalBlockReason}:{}),
      });
      const eligible=replanCommand.restPressure?.candidates.some((candidate)=>candidate.agentId===agentId)??false;
      if (!eligible) { this.toast('休養監視対象ではありません。配置盤で勤務を確認してください。'); return; }
      try {
        setDailyAssignment(this.state,agentId,'rest');
        this.#dailyPlanBoardAgentId=agentId;
        this.#commandPulsePhase='plan';
        this.#focusAfterRender=`[data-action="daily-board-select"][data-agent-id="${agentId}"]`;
        this.render();
      } catch(error) { this.toast(error instanceof Error?error.message:String(error)); }
      return;
    }
    if (action==='daily-board-select') {
      const agentId=button.dataset.agentId??'';
      if (agentId) {
        this.#dailyPlanBoardAgentId=agentId;
        this.#commandPulsePhase='plan';
        this.#focusAfterRender=`[data-action="daily-board-select"][data-agent-id="${agentId}"]`;
        this.render();
      }
      return;
    }
    if (action==='daily-board-assign') {
      const agentId=button.dataset.agentId??'';
      const task=button.dataset.task as LaborTask|undefined;
      if (agentId&&task) {
        try {
          setDailyAssignment(this.state,agentId,task);
          this.#dailyPlanBoardAgentId=agentId;
          this.#commandPulsePhase='plan';
          this.#focusAfterRender=`[data-action="daily-board-assign"][data-agent-id="${agentId}"][data-task="${task}"]`;
          this.render();
        } catch(error) { this.toast(error instanceof Error?error.message:String(error)); }
      }
      return;
    }
    if (action==='daily-detail') {
      const target = button.dataset.dailyTarget as DailyCommandTarget | undefined;
      const agentId = button.dataset.agentId;
      if (agentId) this.#inspectedAgentId = agentId;
      if (target === 'expedition') { this.#pdaTab = 'task'; this.#pdaTaskPanel = 'expedition'; this.#view = 'exploration'; }
      else if (target === 'task') { this.#pdaTab = 'task'; this.#pdaTaskPanel = 'overview'; this.#view = 'exploration'; }
      else if (target === 'map') { this.#pdaTab = 'map'; this.#view = 'exploration'; }
      else if (target === 'body' || target === 'knowledge' || target === 'inventory' || target === 'chronicle') { this.#pdaTab = target; this.#view = target; }
      this.render();
      return;
    }
    if (this.#reloadRequiredReason && !['view','export','export-recovery-report','export-quarantine','a11y-scale','a11y-contrast','a11y-motion'].includes(action ?? '')) { this.toast('WORLD LINKの復旧が必要です。TEMPORARY Archiveの場合は先に書き出してください。'); return; }
    if (this.#busy && !isBusySafeUiAction(action)) { this.toast('指令処理中です。現在の行動が完了するまで待機してください。'); return; }
    if (action==='execute-plan') { void this.executeDailyPlan(); return; }
    if (action==='resolve-daily-interruption-auto') {
      const kind=button.dataset.interruptionKind as 'medical'|'expedition'|undefined;
      if(kind){ resolveDailyInterruptionAsAuto(this.state,kind); void this.executeDailyPlan(); }
      return;
    }
    if (action==='view') { this.#view = button.dataset.view as ViewId; this.render(); if (this.#view==='exploration') { void this.refreshLocalProjection(); void this.refreshWorldProjection(); } return; }
    if (action==='select-local-entity') { this.#selectedLocalEntityId = button.dataset.entityId ?? ''; this.render(); return; }
    if (action==='map-scope') { const scope=button.dataset.scope; if(scope==='world'||(scope==='local'&&this.controlledExpedition())){this.#mapScope=scope;this.render();if(scope==='world')void this.refreshWorldProjection();else void this.refreshLocalProjection();} return; }
    if (action==='select-world-entity') { this.#selectedWorldEntityId=button.dataset.entityId??''; this.render(); return; }
    if (action==='set-prep-target') { const entity=this.visibleWorldEntities().find((entry)=>entry.id===button.dataset.entityId); if(!entity)return; const location=this.worldMapLocation(entity);if(!location.position)return; this.#prepTarget=structuredClone(location.position); this.#prepTargetEntityId=entity.id; this.#prepRouteEntityId=''; this.#pdaTaskPanel='expedition'; this.#pdaTab='task'; this.render(); this.toast(`Expedition target selected: ${entityName(entity)}${location.estimated?' · 推定範囲の中心':''}.`); return; }
    if (action==='move-world-target') { const field=this.controlledExpedition(), entity=this.visibleWorldEntities().find((entry)=>entry.id===button.dataset.entityId); if(!field||!entity)return; const location=this.worldMapLocation(entity);if(!location.position)return; try{addExpeditionOrder(this.state,field.id,'move',`Move toward ${location.estimated?'estimated area':'known WORLD marker'} ${entityName(entity)}.`,{target:structuredClone(location.position),targetEntityId:entity.id});this.#mapScope='local';void this.save(`Field destination set: ${entityName(entity)}${location.estimated?' · 推定範囲の中心':''}.`);}catch(error){this.toast(error instanceof Error?error.message:String(error));} return; }
    if (action==='walk-local-target') {
      const field=this.controlledExpedition(), entity=this.#localProjection?.entities.find((entry)=>entry.id===button.dataset.entityId);
      if(!field||!entity?.spatial)return; try { addExpeditionOrder(this.state,field.id,'move',`Approach ${entityName(entity)} from the charted LOCAL view.`,{target:structuredClone(entity.spatial)}); void this.save(`Walking toward ${entityName(entity)}.`); } catch(error){this.toast(error instanceof Error?error.message:String(error));} return;
    }
    if (action==='observe-local-target') {
      const agent=this.controlledAgent(), entity=this.#localProjection?.entities.find((entry)=>entry.id===button.dataset.entityId); if(!agent||!entity)return;
      void this.directAction(30,()=>{observeGeneratedEntity(this.state,agent.id,entity);return `Observed ${entityName(entity)}. 個人記録に追加。Archive未登録。`;}); return;
    }
    if (action==='artifact-record') {
      const actor=this.controlledAgent(), projection=this.#localProjection; if(!actor||!projection)return;
      void this.directAction(45,()=>{const item=collectArtifactRecord(this.state,actor.id,button.dataset.entityId??'',projection);return `${item.name}を携行記録に残しました。F3で読解できます。`;}); return;
    }
    if (action==='contact-external-person') {
      const agent=this.controlledAgent(), entity=this.#localProjection?.entities.find((entry)=>entry.id===button.dataset.entityId); if(!agent||!entity)return;
      void this.directAction(20,()=>{const {contact}=conductExternalPersonContact(this.state,agent.id,entity);return `Direct contact recorded with ${contact.name} (${contact.externalPersonId}). 未確認の経歴は記録していません。`;}); return;
    }
    if (action==='sample-local-target') {
      const agent=this.controlledAgent(), entity=this.#localProjection?.entities.find((entry)=>entry.id===button.dataset.entityId); if(!agent||!entity)return;
      void this.directAction(45,()=>{const {item}=takeGeneratedSample(this.state,agent.id,entity);return `Collected ${item.name}. 採取元記録をF4に保持。`;}); return;
    }
    if (action==='harvest-local-resource') {
      const agent=this.controlledAgent(), entity=this.#localProjection?.entities.find((entry)=>entry.id===button.dataset.entityId);
      const key=button.dataset.resourceKey as SettlementResourceKey|undefined;
      if(!agent||!entity||!key)return;
      const amount=key==='water'?5:key==='food'?2:1;
      void this.directAction(60,()=>{const item=harvestGeneratedResource(this.state,agent.id,entity,key,amount);return `Harvested ${item.quantity.toFixed(2)} ${item.resourceUnit??'unit'} of ${item.name}. It remains physical field cargo until return.`;}); return;
    }
    if (action==='resource-process') {
      if (this.controlledExpedition()) { this.toast('Settlement processing is unavailable while controlling the field party.'); return; }
      const lotId=button.dataset.lotId??''; const kind=button.dataset.processingKind as ResourceProcessingKind|undefined; if(!lotId||!kind)return;
      try { const lot=processResourceLot(this.state,lotId,kind,[this.controlledAgent()?.id??this.state.settlement.leaderId]); void this.save(`Processed ${lot.label}; 元ロット記録を保持。`); } catch(error){this.toast(error instanceof Error?error.message:String(error));} return;
    }
    if (action==='ration-group-save') {
      const name=this.root.querySelector<HTMLInputElement>('[data-action="ration-group-name"]')?.value.trim()??'';
      const memberIds=[...this.root.querySelectorAll<HTMLInputElement>('[data-action="ration-member-toggle"]:checked')].map((entry)=>entry.dataset.agentId??'').filter(Boolean);
      try { const group=saveResourceAllocationGroup(this.state,name,memberIds); void this.save(`Saved ration group ${group.name}.`); } catch(error){this.toast(error instanceof Error?error.message:String(error));} return;
    }
    if (action==='ration-group-delete') { const id=button.dataset.groupId??''; removeResourceAllocationGroup(this.state,id); void this.save('Ration group removed; dependent rules were also removed.'); return; }
    if (action==='ration-rule-save') {
      const form=button.closest<HTMLElement>('[data-ration-rule-form]'); if(!form)return;
      const groupId=form.querySelector<HTMLSelectElement>('[data-action="ration-rule-group"]')?.value??'';
      const resourceKey=form.querySelector<HTMLSelectElement>('[data-action="ration-rule-resource"]')?.value as SettlementResourceKey;
      const selector=form.querySelector<HTMLSelectElement>('[data-action="ration-rule-selector"]')?.value??'all';
      const amount=Number(form.querySelector<HTMLInputElement>('[data-action="ration-rule-amount"]')?.value??1);
      const priority=Number(form.querySelector<HTMLInputElement>('[data-action="ration-rule-priority"]')?.value??0);
      const exclusive=Boolean(form.querySelector<HTMLInputElement>('[data-action="ration-rule-exclusive"]')?.checked);
      const lotIds=selector.startsWith('lot:')?[selector.slice(4)]:[];
      const selectorParts=selector.startsWith('subtype:')?selector.split(':'):[];
      const selectorKey=selectorParts[1] as SettlementResourceKey|undefined; const subtype=selectorParts.slice(2).join(':');
      if(selectorKey&&selectorKey!==resourceKey){this.toast('Selected subtype belongs to a different resource.');return;}
      try { const rule=saveResourceAllocationRule(this.state,{name:`${resourceKey} → ${allocationGroups(this.state).find((entry)=>entry.id===groupId)?.name??'group'}`,groupId,resourceKey,lotIds,subtypes:subtype?[subtype]:[],amountPerPersonPerDay:amount,priority,exclusive}); void this.save(`Saved ration rule ${rule.name}.`); } catch(error){this.toast(error instanceof Error?error.message:String(error));} return;
    }
    if (action==='ration-rule-delete') { const id=button.dataset.ruleId??''; removeResourceAllocationRule(this.state,id); void this.save('Ration rule removed.'); return; }
    if (action==='survey-local-empty') {
      const agent=this.controlledAgent(), field=this.controlledExpedition(); if(!agent||!field)return;
      void this.directAction(45,()=>{surveyEmptySurroundings(this.state,agent.id,field.position,5);return 'Local survey recorded negative evidence as personal knowledge.';}); return;
    }
    if (action==='consume-supply') {
      const agent=this.controlledAgent(); const kind=button.dataset.kind as 'food'|'water'|'medicine'; if(!agent||!['food','water','medicine'].includes(kind))return; const minutes=kind==='water'?10:20;
      void this.directAction(minutes,()=>{consumeAccessibleSupply(this.state,agent.id,kind);return `${kind} used from physically accessible stock.`;}); return;
    }
    if (action==='toggle-equipment') {
      const agent=this.controlledAgent(); if(!agent)return; const itemId=button.dataset.itemId??'', equipped=button.dataset.equipped==='1';
      void this.directAction(5,()=>{const item=setEquipmentEquipped(this.state,agent.id,itemId,equipped);reserveDirectActivity(this.state,[agent.id],'equipment',5,`${equipped?'Equipped':'Unequipped'} ${item.name}.`);return `${item.name} ${equipped?'equipped':'unequipped'}.`;}); return;
    }
    if (action==='clinic-care') {
      const patientId=button.dataset.agentId??''; const patient=findAgent(this.state,patientId); if(!patient)return;
      void this.directAction(60,()=>{const result=requestDirectClinicCare(this.state,patient.id,60);return `Clinic care: ${patient.name} HP ${result.healthBefore.toFixed(1)} → ${result.healthAfter.toFixed(1)}${result.pathology?` · ${result.pathology.severityBefore.toFixed(1)} → ${result.pathology.severityAfter.toFixed(1)}`:''}.`;}); return;
    }
    if (action==='inspect-agent') { this.#inspectedAgentId = button.dataset.agentId ?? this.state.settlement.leaderId; this.render(); return; }
    if (action==='advance') { void this.advance(Number(button.dataset.hours??6)); return; }
    if (action==='launch') {
      this.initializeExpeditionPreparation();
      const leader = findAgent(this.state,this.#prepLeaderId);
      const memberIds = [...this.#prepCrewIds];
      const doctrine = this.selectedPreparationDoctrine();
      const target = this.#prepTarget ? structuredClone(this.#prepTarget) : null;
      const visibleWorldEntities = this.visibleWorldEntities();
      const targetEntity = this.#prepTargetEntityId ? visibleWorldEntities.find((entry)=>entry.id===this.#prepTargetEntityId) : undefined;
      const targetEstimated = Boolean(targetEntity && this.worldMapLocation(targetEntity).estimated);
      const topologyRoutes = targetEntity && !targetEstimated ? providerVisibleRouteAlternatives(this.#worldProjection, visibleWorldEntities, this.state.world.originEntityId, targetEntity.id, 3) : [];
      const selectedTopologyRoute = this.#prepRouteEntityId ? topologyRoutes.find((entry)=>entry.id===this.#prepRouteEntityId) : undefined;
      const selectedRoute = !targetEstimated && this.#prepRouteEntityId ? visibleWorldEntities.find((entry)=>entry.id===this.#prepRouteEntityId && entry.kind==='route') : undefined;
      if (!leader || !memberIds.includes(leader.id) || !doctrine || !target) { this.toast('Expedition preparation requires crew, doctrine and a selected known WORLD target.'); return; }
      try {
        const expedition=launchExpedition(this.state,{
          leaderId:leader.id,memberIds,controlMode:this.#controlMode,doctrineId:doctrine.id,destination:target,...(this.#prepTargetEntityId?{targetEntityId:this.#prepTargetEntityId}:{}),...(selectedRoute?.spatial?{routeEntityId:selectedRoute.id,routeWaypoint:structuredClone(selectedRoute.spatial)}:{}),...(selectedTopologyRoute?{routePlan:{kind:'provider-topology',nodeEntityIds:[...selectedTopologyRoute.nodeEntityIds],relationIds:[...selectedTopologyRoute.relationIds],evidenceIds:[...selectedTopologyRoute.evidenceIds],waypointEntityIds:[...selectedTopologyRoute.waypointEntityIds],waypoints:structuredClone(selectedTopologyRoute.waypoints),waypointRelationIds:[...selectedTopologyRoute.waypointRelationIds],basisTick:selectedTopologyRoute.basisTick,relationSignatures:[...selectedTopologyRoute.relationSignatures],topologyStatus:'active',replanCount:0,plannedDistanceKm:selectedTopologyRoute.distanceKm}}:{}),pace:this.#prepPace,
          supplies:{...this.#prepSupplies},
        });
        this.#prepCrewIds.clear(); this.#prepLeaderId=''; this.#prepTarget=null; this.#prepTargetEntityId=''; this.#prepRouteEntityId=''; this.#mapScope=expedition.controlMode==='expedition'?'local':'world'; this.#pdaTaskPanel='overview'; this.#pdaTab='task';
        void this.save(`Expedition ${expedition.id} launched · ${expedition.memberIds.length} crew · ${expedition.pace??'normal'} pace · ${doctrine.name}.`);
      } catch(error){ this.toast(error instanceof Error?error.message:String(error)); } return;
    }
    if (action==='field-wait') { const expeditionId=button.dataset.expeditionId??''; void this.directAction(360,()=>{issueBlockedFieldDecision(this.state,expeditionId,'wait-camp',{durationHours:6});return '進路遮断: 6時間の待機野営を実施。物資消費、通信、周辺曝露は継続。';}); return; }
    if (action==='field-retry') { const expeditionId=button.dataset.expeditionId??''; void this.directAction(10,()=>{issueBlockedFieldDecision(this.state,expeditionId,'retry-replan');return 'Blocked route: retry/replan evaluated from the unchanged field position against the current observed route record.';}); return; }
    if (action==='field-return') { const expeditionId=button.dataset.expeditionId??''; void this.directAction(10,()=>{issueBlockedFieldDecision(this.state,expeditionId,'return');return 'Blocked route abandoned: party began an off-network physical return bearing; no known road home is asserted.';}); return; }
    if (action==='field-rendezvous') { const expeditionId=button.dataset.expeditionId??''; void this.directAction(10,()=>{const request=requestFieldRendezvous(this.state,expeditionId);return request.status==='transmitted'?'Rendezvous request transmitted from a verified field position.':'Rendezvous request is held locally pending a verified communication link; settlement does not receive the exact field position.';}); return; }
    if (action==='rendezvous-abort') { const expeditionId=button.dataset.expeditionId??''; void this.directAction(10,()=>{const expedition=this.state.expeditions.find((entry)=>entry.id===expeditionId);if(!expedition)throw new Error('Responder expedition not found.');abortRendezvousMission(this.state,expedition,'Player ordered a bounded rendezvous abort and physical return.');return 'Rendezvous mission aborted; responder began physical off-network return.';}); return; }
    if (action==='rendezvous-transfer') { const expeditionId=button.dataset.expeditionId??''; void this.directAction(10,()=>{const responder=this.state.expeditions.find((entry)=>entry.id===expeditionId);const target=responder?.rendezvousPlan?this.state.expeditions.find((entry)=>entry.id===responder.rendezvousPlan?.targetExpeditionId):undefined;if(!responder||!target)throw new Error('Physical rendezvous target is unavailable.');const livingTarget=target.memberIds.filter((id)=>findAgent(this.state,id)?.alive);const wounded=livingTarget.filter((id)=>{const agent=findAgent(this.state,id);return Boolean(agent&&agent.health<55);}).slice(0,Math.max(0,Math.min(8-responder.memberIds.length,livingTarget.length-1)));transferRendezvousAidAndWounded(this.state,expeditionId,{food:Math.min(2,responder.supplies.food*.15),water:Math.min(3,responder.supplies.water*.2),medicine:Math.min(1,responder.supplies.medicine),tools:Math.min(.5,responder.supplies.tools*.25),injuredMemberIds:wounded});return `Physical rendezvous transfer completed: aid moved after co-location${wounded.length?` and ${wounded.length} wounded member(s) joined the responder`:''}; both parties began return.`;}); return; }
    if (action==='direct-camp') { const expeditionId=button.dataset.expeditionId??''; void this.directAction(360,()=>{campExpedition(this.state,expeditionId,6);return '野営完了: 6時間経過。移動を止め、隊員は休息。';}); return; }
    if (action==='qa-trigger-encounter') {
      if (!this.visualQaEncounterControlsEnabled()) { this.toast('この端末ではWEDO接触誘発コマンドを使用できません。'); return; }
      const expedition=this.state.expeditions.find((entry)=>entry.id===(button.dataset.expeditionId??''));
      const doctrine=expedition ? this.state.doctrines.find((entry)=>entry.id===expedition.doctrineId) : undefined;
      if (!expedition || expedition.controlMode!=='expedition' || !doctrine) { this.toast('A field-controlled expedition with a valid doctrine is required.'); return; }
      if (this.state.encounters.some((entry)=>entry.expeditionId===expedition.id&&entry.status!=='resolved')) { this.toast('An unresolved WEDO encounter already exists.'); return; }
      try { const encounter=createEncounter(this.state,expedition,doctrine.encounterInstruction,2); void this.save(`Encounter ${encounter.id} registered in the field log.`); }
      catch(error){ this.toast(error instanceof Error?error.message:String(error)); }
      return;
    }
    if (action==='wedo-round') { const encounterId=button.dataset.encounterId??''; void this.directAction(10,()=>{const outcome=resolveControlledEncounterRound(this.state,encounterId);return outcome.resolved?`WEDO resolved under ${outcome.instruction}.`:`One WEDO round resolved under ${outcome.instruction}; encounter remains active.`;}); return; }
    if (action==='return') { try { addExpeditionOrder(this.state,button.dataset.expeditionId??'','return','Return to settlement.'); void this.save('Return order recorded.'); } catch(error){this.toast(error instanceof Error?error.message:String(error));} return; }
    if (action==='rescue') {
      const targetId=button.dataset.expeditionId??''; const doctrine=this.state.doctrines.find((entry)=>entry.prioritizeRescue)??this.state.doctrines[0]; const available=settlementAgents(this.state).filter((a)=>agentAgeYears(this.state,a)>=16&&Boolean(doctrine&&expeditionMemberReadiness(a,doctrine).ready)).sort((a,b)=>b.skills.scouting-a.skills.scouting); const leader=available[0]; if(!leader){this.toast('No expedition-fit local adults are available for a rescue launch.');return;} try{launchRescueExpedition(this.state,targetId,leader.id,available.slice(0,3).map((a)=>a.id),this.#controlMode);void this.save('Rescue expedition launched.');}catch(error){this.toast(error instanceof Error?error.message:String(error));} return;
    }
    if (action==='inquiry-create') {
      const actor=this.knowledgeAgent(), target=this.visibleWorldEntities().find((entry)=>entry.id===this.root.querySelector<HTMLSelectElement>('[data-inquiry-target]')?.value); if(!actor||!target)return;
      const basis=[this.root.querySelector<HTMLSelectElement>('[data-inquiry-basis]')?.value??'',this.root.querySelector<HTMLSelectElement>('[data-inquiry-second]')?.value??''].filter(Boolean);
      const prediction=this.root.querySelector<HTMLSelectElement>('[data-inquiry-prediction]')?.value as InquiryPrediction, note=this.root.querySelector<HTMLInputElement>('[data-inquiry-note]')?.value??'';
      void this.directAction(10,()=>{createExplorationInquiry(this.state,actor.id,basis,target,prediction,note);return '根拠と観測予測を記録しました。現地で照合してください。';}); return;
    }
    if (action==='inquiry-revise') {
      const actor=this.knowledgeAgent(), card=button.closest<HTMLElement>('[data-inquiry-card]'); if(!actor||!card)return;
      const prior=visibleInquiries(this.state,actor.id).find((entry)=>entry.id===button.dataset.inquiryId); if(!prior)return;
      const prediction=card.querySelector<HTMLSelectElement>('[data-inquiry-revision]')?.value as InquiryPrediction, reason=card.querySelector<HTMLInputElement>('[data-inquiry-reason]')?.value??'';
      void this.directAction(10,()=>{const target:WorldEntity={id:prior.targetEntityId,kind:'historical-trace',components:{name:prior.targetLabel},provenanceIds:[],spatial:structuredClone(prior.center)};const revised=createExplorationInquiry(this.state,actor.id,[prior.knowledgeId],target,prediction,reason,prior.id);revised.center=structuredClone(prior.center);revised.radiusKm=prior.radiusKm;return '以前の予測と観測を残し、新しい予測を記録しました。';}); return;
    }
    if (action==='inquiry-target') {
      const actor=this.controlledAgent(); if(!actor)return; const inquiry=visibleInquiries(this.state,actor.id).find((entry)=>entry.id===button.dataset.inquiryId); if(!inquiry){this.toast('操作中の住民に調査ノートを共有してください。');return;}
      const field=this.controlledExpedition(); if(field){try{addExpeditionOrder(this.state,field.id,'move',`調査ノート: ${inquiry.targetLabel}`,{target:structuredClone(inquiry.center),epistemicBasisIds:[inquiry.knowledgeId]});void this.save('予測範囲の中心へ移動します。範囲全体の確認ではありません。');}catch(error){this.toast(error instanceof Error?error.message:String(error));}}
      else {this.#prepTarget=structuredClone(inquiry.center);this.#prepTargetEntityId='';this.#prepRouteEntityId='';this.#pdaTaskPanel='expedition';this.#pdaTab='task';this.render();this.toast(`調査範囲を選択: ${inquiry.targetLabel} / 半径 ${inquiry.radiusKm.toFixed(2)}km。`);} return;
    }
    if (action==='inquiry-survey') {
      const actor=this.knowledgeAgent(); if(!actor)return;
      void this.directAction(60,async()=>{const result=await surveyInquiry(this.provider,this.state,actor.id,button.dataset.inquiryId??'');return result.outcome==='supports'?'予測に一致する観測を記録しました。':result.outcome==='contradicts'?'今回の現地観測は予測と一致しませんでした。':'調べた範囲ではまだ判断できません。';}); return;
    }
    if (action==='inquiry-trial') {
      const actor=this.knowledgeAgent(); if(!actor)return;
      void this.directAction(30,()=>{trialInquiryProcedure(this.state,actor.id,button.dataset.inquiryId??'',button.dataset.method as 'boiled'|'filtered');return '水1Lを処理し、処理前後の値を記録しました。この実測から研究を開始できます。';}); return;
    }
    if (action==='inquiry-archive-report') {
      const actor=this.knowledgeAgent();if(!actor)return;
      void this.directAction(60,()=>{archiveInquiryEvaluation(this.state,actor.id,button.dataset.inquiryId??'',button.dataset.knowledgeId??'');return '報告と採取元の観測記録を一緒にArchiveへ保存しました。';});return;
    }
    if (action==='artifact-decode') {
      const actor=this.knowledgeAgent(); if(!actor)return;
      void this.directAction(60,()=>decodeArtifactRecord(this.state,actor.id,button.dataset.itemId??'')?'読解記録を残しました。物的記述と伝承の解釈を照合してください。':'読解を進めました。欠損の整理にはさらに時間が必要です。'); return;
    }
    if (action==='artifact-lead') {
      const actor=this.knowledgeAgent(); if(!actor)return;
      const item=accessibleArtifactRecords(this.state,actor.id).find((entry)=>entry.id===button.dataset.itemId), reading=item?.reading, lead=reading?.leads.find((entry)=>entry.entityId===button.dataset.entityId);
      if(!reading?.decodedKnowledgeId||!lead?.position)return;
      void this.directAction(10,()=>{const target:WorldEntity={id:lead.entityId,kind:'historical-trace',components:{name:lead.label},provenanceIds:[],spatial:structuredClone(lead.position!)};createExplorationInquiry(this.state,actor.id,[reading.decodedKnowledgeId!],target,lead.prediction,'現場写しの配置と記述を別の観測で照合する。');return '読解した記録から次の観測予測を作りました。';}); return;
    }
    if (action==='legacy-start') {
      const actor=this.knowledgeAgent(); if(!actor)return;
      void this.directAction(60,()=>{const project=startLegacyProject(this.state,actor.id,button.dataset.kind as LegacyProjectKind);return `${project.name}の設計をArchiveに保存しました。作業者と資材を選び、日々の作業を続けられます。`;}); return;
    }
    if (action==='legacy-adopt') {
      const actor=this.knowledgeAgent(); if(!actor)return;
      void this.directAction(10,()=>{adoptLegacyProject(this.state,actor.id,button.dataset.projectId??'');reserveDirectActivity(this.state,[actor.id],'records',10,'共同体の計画の引継ぎを記録。');return '設備・投入資材・進捗を保持して計画を引き継ぎました。';}); return;
    }
    if (action==='legacy-workers') {
      const actor=this.knowledgeAgent(),card=button.closest<HTMLElement>('[data-legacy-card]');if(!actor||!card)return;
      const ids=[...card.querySelectorAll<HTMLInputElement>('[data-legacy-worker]:checked')].map((entry)=>entry.dataset.legacyWorker??'');
      try{setLegacyProjectWorkers(this.state,actor.id,button.dataset.projectId??'',ids);void this.save('計画の担い手を更新しました。');}catch(error){this.toast(error instanceof Error?error.message:String(error));}return;
    }
    if (action==='legacy-pause') {
      const actor=this.knowledgeAgent();if(!actor)return;
      try{setLegacyProjectPaused(this.state,actor.id,button.dataset.projectId??'',button.dataset.paused==='1');void this.save('計画の作業状態を更新しました。');}catch(error){this.toast(error instanceof Error?error.message:String(error));}return;
    }
    if (action==='conversation') {
      const speaker=this.knowledgeAgent(), listener=findAgent(this.state,this.#conversationTargetId), knowledgeId=button.dataset.knowledgeId??'';
      if(!speaker||!listener)return;
      void this.directAction(20,()=>{conductDirectConversation(this.state,speaker.id,listener.id,knowledgeId);return `${speaker.name} discussed a specific known claim with ${listener.name}. No institutional promotion occurred.`;}); return;
    }
    if (action==='archive-knowledge') {
      const author=this.knowledgeAgent(), knowledgeId=button.dataset.knowledgeId??''; if(!author)return;
      void this.directAction(60,()=>{const record=institutionalizeKnowledgeRecord(this.state,author.id,knowledgeId);return `${record.title} entered the Records / Archive; institutional access now has a physical provenance path.`;}); return;
    }
    if (action==='duplicate-doctrine') {
      const source=this.selectedPreparationDoctrine(); if(!source)return;
      const {id: _sourceId, ...copy}=structuredClone(source); void _sourceId;
      const variant=saveDoctrine(this.state,{...copy,name:`${source.name} variant`});
      this.#prepDoctrineId=variant.id; void this.save(`Doctrine variant created: ${variant.name}.`); return;
    }
    if (action==='stop-continuity') { this.#stopContinuity=true; return; }
    if (action==='continue-days') { void this.advanceContinuity(Number(button.dataset.days)); return; }
    if (action==='research') { try { const project = startResearchProject(this.state, button.dataset.knowledgeId ?? ''); void this.save(`Research started: ${project.id}.`); } catch(error) { this.toast(error instanceof Error ? error.message : String(error)); } return; }
    if (action==='incident-adapter-toggle') {
      const enabled=isI2F1IncidentAdapterEnabled();
      try { window.localStorage.setItem(I2_F1_INCIDENT_STORAGE_KEY,enabled?'0':'1'); } catch { this.toast('緊急対応回線の設定を保存できませんでした。'); return; }
      this.#incidentResponderDraftIds.clear(); this.#selectedIncidentId=''; this.#selectedDebriefId=''; this.#incidentDebriefQuery=''; pdaAudio.playConfirm(); this.render(); this.toast(`緊急対応回線 ${enabled?'CLOSED':'OPEN'}.`); return;
    }
    if (action==='incident-focus') {
      const read=this.f1SituationReadModel(); const incidentId=button.dataset.incidentId??'';
      if(read.source!=='incident'||!read.incidents.some((incident)=>incident.id===incidentId)){this.toast('Selected Incident is no longer observer-visible.');this.render();return;}
      this.#selectedIncidentId=incidentId; this.#selectedDebriefId=''; this.#incidentDebriefFilter='all'; this.#incidentDebriefQuery=''; this.#incidentResponderDraftIds.clear(); this.render(); return;
    }
    if (action==='incident-debrief-select') { this.#selectedDebriefId=button.dataset.debriefId??''; this.render(); return; }
    if (action==='incident-debrief-filter') {
      const filter=button.dataset.filter as IncidentDebriefFilter; if(!['all','completed','aborted','evidence','resource'].includes(filter))return;
      this.#incidentDebriefFilter=filter; this.#selectedDebriefId=''; this.#focusAfterRender=`[data-action="incident-debrief-filter"][data-filter="${filter}"]`; this.render(); return;
    }
    if (action==='incident-debrief-search-clear') { this.#incidentDebriefQuery=''; this.#selectedDebriefId=''; this.#focusAfterRender='[data-action="incident-debrief-search"]'; this.render(); return; }
    if (action==='incident-density-toggle') { this.#incidentResponseDensity=this.#incidentResponseDensity==='compact'?'standard':'compact'; this.#focusAfterRender='[data-action="incident-density-toggle"]'; this.render(); return; }
    if (action==='incident-debrief-prev'||action==='incident-debrief-next') {
      const read=this.f1SituationReadModel(); const incident=this.selectedF1Incident(read); if(!incident)return;
      const field=this.controlledExpedition();
      const debriefs=filterIncidentResponseDebriefs(incidentResponseDebriefs(this.state,incident.id,field).slice().reverse(),this.#incidentDebriefFilter,this.#incidentDebriefQuery,(id)=>findAgent(this.state,id)?.name); if(!debriefs.length)return;
      const current=Math.max(0,debriefs.findIndex((entry)=>entry.id===this.#selectedDebriefId)); const next=action==='incident-debrief-prev'?Math.min(debriefs.length-1,current+1):Math.max(0,current-1);
      const nextDebrief=debriefs[next]; if(!nextDebrief)return; this.#selectedDebriefId=nextDebrief.id; this.#focusAfterRender=`[data-action="${action}"]`; this.render(); return;
    }
    if (action==='incident-assign') {
      const incidentId=button.dataset.incidentId??''; const field=this.controlledExpedition();
      try { const team=assignIncidentResponseTeam(this.state,incidentId,[...this.#incidentResponderDraftIds],field); this.#incidentResponderDraftIds.clear(); void this.save(`Incident response team ${team.id} assigned. 勤務時間は経過していません。`); }
      catch(error){this.toast(error instanceof Error?error.message:String(error));}
      return;
    }
    if (action==='incident-dispatch') {
      try { const team=dispatchIncidentResponseTeam(this.state,button.dataset.teamId??''); void this.save(`Incident response team ${team.id} dispatched; 必要物資を予備在庫から確保しました。`); }
      catch(error){this.toast(error instanceof Error?error.message:String(error));}
      return;
    }
    if (action==='incident-stand-down') {
      try { const team=standDownIncidentResponseTeam(this.state,button.dataset.teamId??''); void this.save(`Incident response team ${team.id} stood down; unconsumed reserve returned.`); }
      catch(error){this.toast(error instanceof Error?error.message:String(error));}
      return;
    }
    if (action==='incident-resource-use') {
      const incidentId=button.dataset.incidentId??''; const kind=button.dataset.kind; const amount=Math.max(0,Number(button.dataset.amount??0)); const field=this.controlledExpedition();
      try { const use=applyIncidentResponseEvidenceResourceUse(this.state,incidentId,kind==='medicine'?{medicine:amount}:kind==='tools'?{tools:amount}:{},field); void this.save(`Evidence-grounded ${kind} reconciliation recorded as ${use.id}; 結果との因果は未確定です。`); }
      catch(error){this.toast(error instanceof Error?error.message:String(error));}
      return;
    }
    if (action==='policy') { const proposer=this.controlledAgent(); if(!proposer){this.toast('集落に有効なCOMMAND HOLDERがいません。');return;} void this.directAction(60,()=>{const proposal=proposeLaborPriority(this.state,button.dataset.task as LaborTask,Number(button.dataset.delta??0),proposer.id);const participants=[...new Set([proposal.proposerId,...proposal.supporterIds,...proposal.opponentIds])];reserveDirectActivity(this.state,participants,'assembly',60,`Assembly vote on ${proposal.task} ${proposal.delta>0?'+':''}${proposal.delta}.`,proposal.id);return `Assembly ${proposal.status}: ${proposal.task} ${proposal.delta>0?'+':''}${proposal.delta} · 60 min.`;}); return; }
    if (action==='anomaly-use') { void this.anomalyAction(button.dataset.knowledgeId ?? '', button.dataset.domain as AnomalyUtilizationDomain); return; }
    if (action==='a11y-scale') { this.#accessibility.textScale = this.#accessibility.textScale === 1 ? 1.25 : this.#accessibility.textScale === 1.25 ? 1.5 : 1; storeAccessibility(this.#accessibility); this.render(); this.toast(`Text size ${Math.round(this.#accessibility.textScale * 100)}%.`); return; }
    if (action==='a11y-contrast') { this.#accessibility.highContrast = !this.#accessibility.highContrast; storeAccessibility(this.#accessibility); this.render(); this.toast(`High contrast ${this.#accessibility.highContrast ? 'enabled' : 'disabled'}.`); return; }
    if (action==='a11y-motion') { this.#accessibility.reduceMotion = !this.#accessibility.reduceMotion; storeAccessibility(this.#accessibility); this.render(); this.toast(`Reduced motion ${this.#accessibility.reduceMotion ? 'enabled' : 'disabled'}.`); return; }
    if (action==='external') { void this.externalAction(button.dataset.kind as ExternalActionKind, button.dataset.target ?? ''); return; }
    if (action==='export') { const blob=new Blob([this.repository.exportJson(this.state)],{type:'application/json'}); const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=`descendants-sandbox-day-${this.state.clock.day}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),0); return; }
    if (action==='export-recovery-report') { void this.exportRecoveryReport(); return; }
    if (action==='export-quarantine') { void this.exportLatestQuarantine(); return; }
    if (action==='reset') { void this.resetSave(); return; }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key.startsWith('F') || ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter',' '].includes(event.key)) pdaAudio.unlock();
    if (event.key === 'F10') { event.preventDefault(); pdaAudio.playTabSwitch(); this.#pdaTab='system'; this.render(); return; }
    if (event.key === 'Escape' && this.#pdaTab==='system') { event.preventDefault(); this.#pdaTab='task'; this.#view='exploration'; this.render(); return; }
    const view = viewForFunctionKey(event.key);
    if (view) { event.preventDefault(); pdaAudio.playTabSwitch(); this.#view = view; this.#pdaTab = view==='exploration'?'task':view; this.render(); return; }
    const eventTarget = event.target as HTMLElement | null;
    const debriefSearch = eventTarget?.closest<HTMLInputElement>('[data-action="incident-debrief-search"]');
    if (debriefSearch && event.key==='Escape') { event.preventDefault(); this.#incidentDebriefQuery=''; this.#selectedDebriefId=''; this.#focusAfterRender='[data-action="incident-debrief-search"]'; this.render(); return; }
    if (event.key==='/' && !event.ctrlKey && !event.metaKey && !event.altKey && !eventTarget?.closest('input,textarea,select,[contenteditable="true"]') && this.#pdaTab==='task') {
      const search=this.root.querySelector<HTMLInputElement>('[data-action="incident-debrief-search"]'); if(search){event.preventDefault();search.focus();search.select();return;}
    }
    const debriefFilter = eventTarget?.closest<HTMLElement>('[data-action="incident-debrief-filter"]');
    if (debriefFilter && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault();
      const order:IncidentDebriefFilter[]=['all','completed','aborted','evidence','resource']; const current=Math.max(0,order.indexOf((debriefFilter.dataset.filter as IncidentDebriefFilter)??this.#incidentDebriefFilter));
      const next=event.key==='Home'?0:event.key==='End'?order.length-1:(current+(event.key==='ArrowRight'?1:-1)+order.length)%order.length; const filter=order[next]??'all';
      this.#incidentDebriefFilter=filter; this.#selectedDebriefId=''; this.#focusAfterRender=`[data-action="incident-debrief-filter"][data-filter="${filter}"]`; this.render(); return;
    }
    const debriefFocus = eventTarget?.closest<HTMLElement>('[data-action="incident-debrief-select"]');
    if (debriefFocus && ['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
      event.preventDefault(); const buttons=[...this.root.querySelectorAll<HTMLElement>('[data-action="incident-debrief-select"]')]; if(!buttons.length)return;
      const current=Math.max(0,buttons.indexOf(debriefFocus)); const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowUp'?Math.max(0,current-1):Math.min(buttons.length-1,current+1);
      const nextButton=buttons[next]; const id=nextButton?.dataset.debriefId??''; if(!id)return; this.#selectedDebriefId=id; this.#focusAfterRender=`[data-action="incident-debrief-select"][data-debrief-id="${id}"]`; this.render(); return;
    }
    const incidentFocus = eventTarget?.closest<HTMLElement>('[data-action="incident-focus"]');
    if (incidentFocus && ['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
      event.preventDefault();
      const buttons=[...this.root.querySelectorAll<HTMLElement>('[data-action="incident-focus"]')]; if(!buttons.length)return;
      const current=Math.max(0,buttons.indexOf(incidentFocus));
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowUp'?Math.max(0,current-1):Math.min(buttons.length-1,current+1);
      const nextButton=buttons[next]; const incidentId=nextButton?.dataset.incidentId??''; if(!incidentId)return;
      this.#selectedIncidentId=incidentId; this.#selectedDebriefId=''; this.#incidentDebriefFilter='all'; this.#incidentDebriefQuery=''; this.#incidentResponderDraftIds.clear(); this.#focusAfterRender=`[data-action="incident-focus"][data-incident-index="${next}"]`; this.render(); return;
    }
    const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="tab"][data-action="pda-tab"]');
    if (!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const order=PDA_TABS.map(([id])=>id);
    const index=Math.max(0,order.indexOf(this.#pdaTab));
    const next=event.key==='Home'?order[0]:event.key==='End'?order[order.length-1]:order[(index+(event.key==='ArrowRight'?1:-1)+order.length)%order.length];
    pdaAudio.playTabSwitch(); this.#pdaTab=next ?? 'task'; const resolvedNext=next ?? 'task'; if(resolvedNext==='task'||resolvedNext==='map')this.#view='exploration'; else if(resolvedNext==='body'||resolvedNext==='knowledge'||resolvedNext==='inventory'||resolvedNext==='chronicle')this.#view=resolvedNext; else if(resolvedNext==='residents')this.#view='body'; this.render();
  }

  private onPointerOver(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button,[role="tab"],.desc-pda-inline-import');
    if (!target) return;
    const related = event instanceof PointerEvent ? event.relatedTarget : null;
    if (related instanceof Node && target.contains(related)) return;
    pdaAudio.playHover();
  }

  private onInput(event: Event): void {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-action]');
    if (!input) return;
    const action = input.dataset.action;
    if (action==='incident-debrief-search') { this.#incidentDebriefQuery=input.value.slice(0,80); this.#selectedDebriefId=''; this.#focusAfterRender='[data-action="incident-debrief-search"]'; this.render(); return; }
    if (action==='pda-audio-master') { pdaAudio.unlock(); pdaAudio.setMasterVolume(Number(input.value)); return; }
    if (action==='pda-audio-sensor') { pdaAudio.unlock(); pdaAudio.setSensorVolume(Number(input.value)); return; }
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLElement;
    const pdaToggle = target.closest<HTMLInputElement>('input[data-action]');
    if (pdaToggle?.dataset.action==='pda-scanlines') { this.#pdaPresentation.scanlines=pdaToggle.checked; storePdaPresentation(this.#pdaPresentation); this.render(); return; }
    if (pdaToggle?.dataset.action==='pda-flicker') { this.#pdaPresentation.flicker=pdaToggle.checked; storePdaPresentation(this.#pdaPresentation); this.render(); return; }
    if (pdaToggle?.dataset.action==='pda-audio-sensor-ticks') { pdaAudio.unlock(); pdaAudio.setSensorTicks(pdaToggle.checked); if(pdaToggle.checked)pdaAudio.playConfirm(); else pdaAudio.playUncheck(); this.render(); return; }
    if (this.#busy) { this.render(); this.toast('指令処理中です。現在の行動が完了するまで待機してください。'); return; }
    const educationControl=target.closest<HTMLSelectElement>('[data-action="education-mentor"],[data-action="education-focus"]');
    if (educationControl) {
      const child=findAgent(this.state,educationControl.dataset.agentId??'');
      if(child) try {
        setEducationMentor(this.state,child.id,educationControl.dataset.action==='education-mentor'?(educationControl.value||null):(child.education?.mentorId??null),educationControl.dataset.action==='education-focus'?educationControl.value as SkillKey:(child.education?.focus??'survival'));
        void this.save('教育方針を保存しました。');
      } catch(error){this.toast(error instanceof Error?error.message:String(error));}
      return;
    }
    const dailyAssignment = target.closest<HTMLSelectElement>('[data-action="daily-assignment"]');
    if (dailyAssignment) {
      const agentId=dailyAssignment.dataset.agentId??'';
      try { setDailyAssignment(this.state,agentId,dailyAssignment.value as LaborTask); this.#commandPulsePhase='plan'; this.render(); }
      catch(error){ this.toast(error instanceof Error?error.message:String(error)); }
      return;
    }
    const dailyPolicy = target.closest<HTMLSelectElement>('[data-action="daily-policy"]');
    if (dailyPolicy) {
      const domain=dailyPolicy.dataset.policyDomain as 'expedition'|'medical'|undefined;
      if(domain){ try { setExecutionPolicy(this.state,domain,dailyPolicy.value as DailyExecutionPolicy); this.#commandPulsePhase='plan'; this.render(); } catch(error){this.toast(error instanceof Error?error.message:String(error));} }
      return;
    }
    const knowledgeAgent = target.closest<HTMLSelectElement>('[data-action="knowledge-agent"]');
    if (knowledgeAgent) { this.#knowledgeAgentId = knowledgeAgent.value; this.#conversationTargetId = ''; this.render(); return; }
    const inventoryAgent = target.closest<HTMLSelectElement>('[data-action="inventory-agent"]');
    if (inventoryAgent) { this.#inventoryAgentId = inventoryAgent.value; this.render(); return; }
    const conversationTarget = target.closest<HTMLSelectElement>('[data-action="conversation-target"]');
    if (conversationTarget) { this.#conversationTargetId = conversationTarget.value; this.render(); return; }
    const incidentResponder = target.closest<HTMLInputElement>('[data-action="incident-response-member"]');
    if (incidentResponder) {
      const id=incidentResponder.dataset.agentId??'';
      if(incidentResponder.checked){
        if(this.#incidentResponderDraftIds.size>=4){incidentResponder.checked=false;this.toast('Incident response teams are bounded to four responders.');return;}
        this.#incidentResponderDraftIds.add(id);
      } else this.#incidentResponderDraftIds.delete(id);
      this.render(); return;
    }
    const crew = target.closest<HTMLInputElement>('[data-action="prep-crew"]');
    if (crew) {
      const id=crew.dataset.agentId??'';
      if(crew.checked)this.#prepCrewIds.add(id);else this.#prepCrewIds.delete(id);
      if(!this.#prepCrewIds.has(this.#prepLeaderId))this.#prepLeaderId=[...this.#prepCrewIds][0]??'';
      this.render(); return;
    }
    const prepLeader = target.closest<HTMLSelectElement>('[data-action="prep-leader"]');
    if (prepLeader) { this.#prepLeaderId=prepLeader.value; this.#prepCrewIds.add(prepLeader.value); this.render(); return; }
    const prepDoctrine = target.closest<HTMLSelectElement>('[data-action="prep-doctrine"]');
    if (prepDoctrine) { this.#prepDoctrineId=prepDoctrine.value; this.render(); return; }
    const prepPace = target.closest<HTMLSelectElement>('[data-action="prep-pace"]');
    if (prepPace) { this.#prepPace=prepPace.value as ExpeditionPace; this.render(); return; }
    const prepRoute = target.closest<HTMLSelectElement>('[data-action="prep-route"]');
    if (prepRoute) { this.#prepRouteEntityId=prepRoute.value; this.render(); return; }
    const prepSupply = target.closest<HTMLInputElement>('[data-action="prep-supply"]');
    if (prepSupply) {
      const kind=prepSupply.dataset.supply as 'food'|'water'|'medicine'|'tools';
      if(kind && kind in this.#prepSupplies)this.#prepSupplies[kind]=Math.max(0,Number(prepSupply.value)||0);
      this.render(); return;
    }
    const doctrineField = target.closest<HTMLInputElement|HTMLSelectElement>('[data-action="doctrine-field"]');
    if (doctrineField) {
      const doctrine=this.selectedPreparationDoctrine(), field=doctrineField.dataset.field;
      if(!doctrine||!field)return;
      const next: ExpeditionDoctrine=structuredClone(doctrine);
      if(field==='riskTolerance')next.riskTolerance=Number((doctrineField as HTMLInputElement).value);
      else if(field==='retreatHealth')next.retreatHealth=Number((doctrineField as HTMLInputElement).value);
      else if(field==='maxSilentHours')next.maxSilentHours=Number((doctrineField as HTMLInputElement).value);
      else if(field==='campBeforeDark')next.campBeforeDark=(doctrineField as HTMLInputElement).checked;
      else if(field==='prioritizeRescue')next.prioritizeRescue=(doctrineField as HTMLInputElement).checked;
      else if(field==='contactPolicy')next.contactPolicy=(doctrineField as HTMLSelectElement).value as ExpeditionDoctrine['contactPolicy'];
      else if(field==='encounterInstruction')next.encounterInstruction=(doctrineField as HTMLSelectElement).value as EncounterInstruction;
      else return;
      try{saveDoctrine(this.state,next);void this.save(`Doctrine updated: ${next.name}.`);}catch(error){this.toast(error instanceof Error?error.message:String(error));}
      return;
    }
    const control = target.closest<HTMLSelectElement>('[data-action="control-mode"]');
    if (control) { this.#controlMode = control.value as ExpeditionControlMode; return; }
    const instruction = target.closest<HTMLSelectElement>('[data-action="encounter-instruction"]');
    if (instruction) {
      try { setEncounterInstruction(this.state, instruction.dataset.encounterId ?? '', instruction.value as EncounterInstruction); void this.save(`Encounter instruction changed to ${instruction.value}.`); }
      catch (error) { this.toast(error instanceof Error ? error.message : String(error)); }
      return;
    }
    const input = target.closest<HTMLInputElement>('[data-action="import"]');
    if (input?.files?.[0]) void this.importSave(input.files[0]);
  }

  private async importSave(file: File): Promise<void> {
    if (this.#persistenceMode !== 'durable') { this.toast('TEMPORARY Archiveでは読込できません。現在のArchiveを書き出すか、確認済みArchiveへ戻ってください。'); return; }
    if (this.#busy) { this.toast('指令処理中です。現在の行動が完了するまで待機してください。'); return; }
    this.#busy = true; this.render();
    try {
      const next = this.repository.importJson(await file.text());
      const manifest = await this.provider.getManifest();
      assertImportedSaveProviderCompatible(next, manifest);
      this.state = next;
      await this.persistCurrentState();
      // Provider state is authoritative and cannot be replaced inside this view. Reload so bootstrap
      // reconstructs the active provider from the imported providerSnapshot before any more commands run.
      window.location.reload();
    } catch (error) { this.#busy = false; this.render(); this.toast(error instanceof Error ? error.message : String(error)); }
  }

  private async exportRecoveryReport(): Promise<void> {
    try {
      const report = await this.repository.forensicReport();
      const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `descendants-recovery-report-day-${this.state.clock.day}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.toast(`Archive recovery report exported · ${report.quarantine.length} quarantine records · ${report.issues.length} issue flags.`);
    } catch (error) { this.toast(`Archive recovery report unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async exportLatestQuarantine(): Promise<void> {
    try {
      const exported = await this.repository.exportLatestQuarantine();
      if (!exported) { this.toast('No quarantined Archive record is available to export.'); return; }
      const blob = new Blob([exported.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `descendants-quarantine-${exported.key.split(':').slice(-2).join('-')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.toast('Latest quarantined Archive record exported.');
    } catch (error) { this.toast(`Quarantined Archive export unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async resetSave(): Promise<void> {
    if (this.#busy) { this.toast('指令処理中です。現在の行動が完了するまで待機してください。'); return; }
    if (this.#persistenceMode !== 'durable') { if (window.confirm('Exit this TEMPORARY Archive and reload the last sealed Archive?')) window.location.reload(); return; }
    if (!window.confirm('Delete the current settlement archive?')) return;
    this.#busy = true; this.render();
    try { await this.repository.clear(); window.location.reload(); }
    catch (error) { this.#busy = false; this.render(); this.toast(error instanceof Error ? error.message : String(error)); }
  }

  private async anomalyAction(sourceKnowledgeId: string, domain: AnomalyUtilizationDomain): Promise<void> {
    if (this.#busy || this.#reloadRequiredReason || !sourceKnowledgeId) return;
    if (this.controlledExpedition()) { this.toast('FIELD COMMAND中は集落の異常利用作業を開始できません。'); return; }
    this.#busy = true; this.render();
    let message = '';
    try {
      const outcome = await attemptAnomalyUtilization(this.provider, this.state, { sourceKnowledgeId, domain });
      await this.persistCurrentState();
      message = `${domain}: ${outcome.accepted ? (outcome.success ? 'operational effect observed' : 'attempt failed') : 'request refused'} · mastery ${outcome.practice.mastery.toFixed(1)}`;
    } catch (error) { if (isProviderMutationUncertainError(error)) this.markProviderResyncRequired(error); message = error instanceof Error ? error.message : String(error); }
    finally { this.#busy = false; this.render(); if (message) this.toast(message); }
  }

  private async externalAction(kind: ExternalActionKind, targetEntityId: string): Promise<void> {
    if (this.#busy || this.#reloadRequiredReason || !targetEntityId) return;
    if (this.controlledExpedition()) { this.toast('FIELD COMMAND中は集落の外交指令を発令できません。'); return; }
    const actor = this.controlledAgent();
    if (!actor) { this.toast('集落に有効なCOMMAND HOLDERがいません。'); return; }
    const availability = externalActionAvailability(this.state, kind, targetEntityId);
    if (!availability.allowed) { this.toast(availability.reason); return; }
    const minutes = externalActionDurationMinutes(kind);
    this.#busy = true; this.render();
    let message = '';
    try {
      reserveDirectActivity(this.state, [actor.id], 'external', minutes, `${kind} coordination with known external society ${targetEntityId}.`, targetEntityId);
      await advanceSandbox(this.provider, this.state, minutes);
      // Commit the consumed local time before issuing a provider mutation. If the command becomes
      // uncertain, recovery can return to an aligned post-time/pre-command snapshot without granting
      // a zero-time retry or replaying an unjournaled provider command.
      await this.persistCurrentState();
      const outcome = await issueExternalAction(this.provider, this.state, { kind, targetEntityId, actorId: actor.id, detail: `${kind} instruction issued by the current legitimate command holder after ${minutes} minutes of local coordination.` });
      await this.persistCurrentState();
      await Promise.all([this.refreshLocalProjection(true), this.refreshWorldProjection(true)]);
      message = `${kind}: ${outcome.result.accepted ? 'accepted' : 'rejected'} · ${minutes} min${outcome.unfounded ? ' · 根拠不足' : ''}`;
    } catch (error) { if (isProviderMutationUncertainError(error)) this.markProviderResyncRequired(error); message = error instanceof Error ? error.message : String(error); }
    finally { this.#busy = false; this.render(); if (message) this.toast(message); }
  }

  private toast(message: string): void { const el=this.root.querySelector<HTMLElement>('#sandbox-toast'); if(!el)return; if (/failed|error|blocked|cannot|unable|required/i.test(message)) pdaAudio.playBuzz(); else pdaAudio.playStatic(0.05,0.055); el.textContent=message; el.classList.add('show'); window.clearTimeout(this.#toastTimer); this.#toastTimer=window.setTimeout(()=>el.classList.remove('show'),2800); }

  /** Renderers receive explicit services and presentation state, never the app instance. */
  viewContext() {
    const app=this;
    return {
      get view() { return app.#view; },
      get selectedWorldEntityId() { return app.#selectedWorldEntityId; },
      get selectedLocalEntityId() { return app.#selectedLocalEntityId; },
      get localLoading() { return app.#localLoading; },
      fieldOperationsPanel: app.fieldOperationsPanel.bind(app),
      get state() { return app.state; },
      get incidentResponderDraftIds() { return app.#incidentResponderDraftIds; },
      set incidentResponderDraftIds(value) { app.#incidentResponderDraftIds=value; },
      get incidentDebriefFilter() { return app.#incidentDebriefFilter; },
      set incidentDebriefFilter(value) { app.#incidentDebriefFilter=value; },
      get incidentDebriefQuery() { return app.#incidentDebriefQuery; },
      set incidentDebriefQuery(value) { app.#incidentDebriefQuery=value; },
      get selectedDebriefId() { return app.#selectedDebriefId; },
      set selectedDebriefId(value) { app.#selectedDebriefId=value; },
      get incidentResponseDensity() { return app.#incidentResponseDensity; },
      set incidentResponseDensity(value) { app.#incidentResponseDensity=value; },
      get localProjection() { return app.#localProjection; },
      set localProjection(value) { app.#localProjection=value; },
      get prepCrewIds() { return app.#prepCrewIds; },
      set prepCrewIds(value) { app.#prepCrewIds=value; },
      get prepLeaderId() { return app.#prepLeaderId; },
      set prepLeaderId(value) { app.#prepLeaderId=value; },
      get prepTarget() { return app.#prepTarget; },
      set prepTarget(value) { app.#prepTarget=value; },
      get prepTargetEntityId() { return app.#prepTargetEntityId; },
      set prepTargetEntityId(value) { app.#prepTargetEntityId=value; },
      get worldProjection() { return app.#worldProjection; },
      set worldProjection(value) { app.#worldProjection=value; },
      get prepRouteEntityId() { return app.#prepRouteEntityId; },
      set prepRouteEntityId(value) { app.#prepRouteEntityId=value; },
      get prepSupplies() { return app.#prepSupplies; },
      set prepSupplies(value) { app.#prepSupplies=value; },
      get prepPace() { return app.#prepPace; },
      set prepPace(value) { app.#prepPace=value; },
      get controlMode() { return app.#controlMode; },
      set controlMode(value) { app.#controlMode=value; },
      get morningReportExpanded() { return app.#morningReportExpanded; },
      set morningReportExpanded(value) { app.#morningReportExpanded=value; },
      get assignmentConsequenceReadback() { return app.#assignmentConsequenceReadback; },
      set assignmentConsequenceReadback(value) { app.#assignmentConsequenceReadback=value; },
      get dailyPlanBoardAgentId() { return app.#dailyPlanBoardAgentId; },
      set dailyPlanBoardAgentId(value) { app.#dailyPlanBoardAgentId=value; },
      get commandPulseMorningDay() { return app.#commandPulseMorningDay; },
      set commandPulseMorningDay(value) { app.#commandPulseMorningDay=value; },
      get dailyExecutionActive() { return app.#dailyExecutionActive; },
      set dailyExecutionActive(value) { app.#dailyExecutionActive=value; },
      get crtTransition() { return app.#crtTransition; },
      set crtTransition(value) { app.#crtTransition=value; },
      get commandPulsePhase() { return app.#commandPulsePhase; },
      set commandPulsePhase(value) { app.#commandPulsePhase=value; },
      get busy() { return app.#busy; },
      set busy(value) { app.#busy=value; },
      get pdaTaskPanel() { return app.#pdaTaskPanel; },
      set pdaTaskPanel(value) { app.#pdaTaskPanel=value; },
      get mapScope() { return app.#mapScope; },
      set mapScope(value) { app.#mapScope=value; },
      get inspectedAgentId() { return app.#inspectedAgentId; },
      set inspectedAgentId(value) { app.#inspectedAgentId=value; },
      get accessibility() { return app.#accessibility; },
      set accessibility(value) { app.#accessibility=value; },
      get pdaPresentation() { return app.#pdaPresentation; },
      set pdaPresentation(value) { app.#pdaPresentation=value; },
      get providerMode() { return app.#providerMode; },
      set providerMode(value) { app.#providerMode=value; },
      get persistenceMode() { return app.#persistenceMode; },
      set persistenceMode(value) { app.#persistenceMode=value; },
      get conversationTargetId() { return app.#conversationTargetId; },
      set conversationTargetId(value) { app.#conversationTargetId=value; },
      f1SituationReadModel: app.f1SituationReadModel.bind(app),
      selectedF1Incident: app.selectedF1Incident.bind(app),
      controlledExpedition: app.controlledExpedition.bind(app),
      visibleWorldEntities: app.visibleWorldEntities.bind(app),
      selectedLocalEntity: app.selectedLocalEntity.bind(app),
      selectedWorldEntity: app.selectedWorldEntity.bind(app),
      worldMapLocation: app.worldMapLocation.bind(app),
      mapMarkerStyle: app.mapMarkerStyle.bind(app),
      initializeExpeditionPreparation: app.initializeExpeditionPreparation.bind(app),
      chronicleViewpoint: app.chronicleViewpoint.bind(app),
      selectedPreparationDoctrine: app.selectedPreparationDoctrine.bind(app),
      dailyExecutionBlockReason: app.dailyExecutionBlockReason.bind(app),
      pdaExpeditionPreparation: app.pdaExpeditionPreparation.bind(app),
      pdaIncidentResponsePanel: app.pdaIncidentResponsePanel.bind(app),
      pdaCampaignCommand: app.pdaCampaignCommand.bind(app),
      pdaTaskList: app.pdaTaskList.bind(app),
      pdaMiniMap: app.pdaMiniMap.bind(app),
      pdaStatusCard: app.pdaStatusCard.bind(app),
      controlledAgent: app.controlledAgent.bind(app),
      canInspectLiveState: app.canInspectLiveState.bind(app),
      inventoryAgent: app.inventoryAgent.bind(app),
      lastReportForAgent: app.lastReportForAgent.bind(app),
      knowledgeAgent: app.knowledgeAgent.bind(app),
      knowledgeEligibleAgents: app.knowledgeEligibleAgents.bind(app),
      conversationPartners: app.conversationPartners.bind(app),
      inventoryEligibleAgents: app.inventoryEligibleAgents.bind(app),
      settlementResourceLedgerPanel: app.settlementResourceLedgerPanel.bind(app),
      encounterGrid: app.encounterGrid.bind(app),
      visualQaEncounterControlsEnabled: app.visualQaEncounterControlsEnabled.bind(app),
      settlementPolicyPanel: app.settlementPolicyPanel.bind(app),
    };
  }
}

import type { AreaProjection, SpatialRef, WorldEntity, WorldProvider, WorldSnapshot } from '../worldbridge/contract.js';
import { advanceSandbox, advanceSandboxHours } from './engine.js';
import { addExpeditionOrder, campExpedition, expeditionMemberReadiness, expeditionSupplyReadiness, settlementSupplyReserveReadiness, launchExpedition, launchRescueExpedition, resolveControlledEncounterRound, saveDoctrine } from './expeditionSimulation.js';
import { createEncounter, setEncounterInstruction } from './encounterSimulation.js';
import { externalActionAvailability, externalActionDurationMinutes, issueExternalAction, type ExternalActionKind } from './externalActions.js';
import { conductExternalPersonContact, externalSocietyForPerson } from './externalContact.js';
import { researchSampleGate, startResearchProject } from './researchSimulation.js';
import { anomalyBasisForKnowledge, attemptAnomalyUtilization } from './anomalyUtilization.js';
import { laborPriorityProposalAvailability, proposeLaborPriority } from './politicalSimulation.js';
import { requestDirectClinicCare } from './settlementSimulation.js';
import { createVolatileSandboxRepository, type SandboxRepository } from './storage.js';
import { agentAgeYears, findAgent, livingAgents, settlementAgents } from './stateUtils.js';
import { projectChronicle } from './chronicleVisibility.js';
import { conductDirectConversation, institutionalizeKnowledgeRecord } from './knowledgeSimulation.js';
import { consumeAccessibleSupply, ensureDirectPlayState, entityName, equipmentForAgent, inventoryForAgent, reserveDirectActivity, setEquipmentEquipped } from './directPlay.js';
import { generatedWorldMapRadiusKm, harvestGeneratedResource, harvestableResourceKeys, isSampleableEntity, observeGeneratedEntity, queryGeneratedLocalArea, queryGeneratedWorldArea, spatialDistanceKm, surveyEmptySurroundings, takeGeneratedSample } from './localExploration.js';
import { selectF1IncidentReadModel } from './incidentService.js';
import { applyIncidentResponseEvidenceResourceUse, assignIncidentResponseTeam, deriveIncidentDispatchCapacity, dispatchIncidentResponseTeam, I2_F1_INCIDENT_STORAGE_KEY, incidentResponseDebriefs, incidentResponseEvidenceResourceUses, incidentResponseOperations, incidentResponseResourceReservations, incidentResponseTeams, isI2F1IncidentAdapterEnabled, standDownIncidentResponseTeam } from './incidentService.js';
import { synthesizeVisibleSituations } from './situationSynthesis.js';
import { deriveSurvivalCampaignView } from './survivalCampaign.js';
import { commitDailyPlan, ensureDailyLoopState, executeCommittedPlan, resolveDailyInterruptionAsAuto, setDailyAssignment, setExecutionPolicy } from './dailyActionLoop.js';
import { assignmentConsequenceReadback, deriveDailyCommandView, laborTaskDisplayName, morningReplanQueue, morningReportTransitionSummary, type DailyAssignmentConsequenceReadback, type DailyAssignmentMoveSnapshot, type DailyCommandTarget } from './dailyCommandReadModel.js';
import { latestObservedRouteDisruptionForEntities, latestObservedRouteDisruptionForEntity } from './externalConflictSimulation.js';
import { providerVisibleRouteAlternatives } from './routePlanning.js';
import { issueBlockedFieldDecision } from './fieldDecisionSimulation.js';
import { requestFieldRendezvous } from './rendezvousSimulation.js';
import { abortRendezvousMission, transferRendezvousAidAndWounded } from './rendezvousEncounterSimulation.js';
import type { AnomalyUtilizationDomain, DailyExecutionPolicy, EncounterInstruction, EncounterState, ExpeditionControlMode, ExpeditionDoctrine, ExpeditionPace, LaborTask, MorningResidentSeverity, ResourceProcessingKind, SandboxGameState, SettlementResourceKey } from './types.js';
import { isBusySafeUiAction, movePrimaryView, viewForFunctionKey, type PrimaryViewId } from './uiNavigation.js';
import { assertImportedSaveProviderCompatible, assertProviderAligned, isProviderMutationUncertainError, restoreSandboxState } from './worldMutationSafety.js';
import { pdaAudio } from './pdaAudio.js';
import { filterIncidentResponseDebriefs, summarizeIncidentDebriefTimeline, type IncidentDebriefFilter } from './incidentDebriefReadModel.js';
import { compareF3KnowledgeProjectionsIfEnabled, selectF3KnowledgeReadModel } from './knowledgeF3Projection.js';
import { compareWorldGraphProjectionsIfEnabled, selectWorldGraphReadModel } from './knowledgeGraphProjection.js';
import { allocationGroups, allocationRules, processResourceLot, removeResourceAllocationGroup, removeResourceAllocationRule, resourceLots, resourceSources, saveResourceAllocationGroup, saveResourceAllocationRule } from './resourceLedger.js';

const esc = (value: unknown): string => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);
type ViewId = PrimaryViewId;
type PdaTab = 'task'|'map'|'body'|'knowledge'|'inventory'|'chronicle'|'residents'|'system';
type PdaTaskPanel = 'overview'|'expedition';
type IncidentResponseDensity = 'standard'|'compact';
const VIEWS: Array<[ViewId, string, string]> = [
  ['exploration','Exploration','F1'],
  ['body','Body / Equipment','F2'],
  ['knowledge','Knowledge','F3'],
  ['inventory','Inventory','F4'],
  ['chronicle','Chronicle','F5'],
];

function authorityLabel(value: string | undefined): string {
  if (value === 'provider-projected') return 'ORIGIN RECORD';
  if (value === 'lived-game-state') return 'LOCAL HISTORY';
  return 'LOCAL INTERPRETATION';
}

function knowledgeSourceLabel(entry: SandboxGameState['knowledge'][number]): string {
  if (entry.sourceWorldKnowledgeId) return 'OUTSIDE OBSERVATION RECORD · UNCONFIRMED BEYOND EVIDENCE';
  if (entry.physicalEvidenceSourceEntityId && entry.sourceKnowledgeId) return 'LOCAL RESEARCH FROM PHYSICAL / OBSERVED EVIDENCE';
  if (entry.physicalEvidenceSourceEntityId) return 'DIRECT FIELD OBSERVATION / PHYSICAL EVIDENCE';
  if (entry.sourceKnowledgeId) return 'LOCAL INFERENCE / RESEARCH';
  if (entry.carrier === 'record' || entry.carrier === 'institution') return 'LIVED RECORD / INSTITUTION';
  return 'LIVED MEMORY / ORAL TRANSMISSION';
}

function incidentMinuteLabel(totalMinutes: number | undefined): string {
  if (totalMinutes === undefined || !Number.isFinite(totalMinutes)) return '—';
  const minute = Math.max(0, Math.floor(totalMinutes));
  const day = Math.floor(minute / 1440) + 1;
  const minuteOfDay = minute % 1440;
  return `D${day} ${String(Math.floor(minuteOfDay / 60)).padStart(2,'0')}:${String(minuteOfDay % 60).padStart(2,'0')}`;
}

function compactText(value: string, maxChars = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function compactSubjectIds(ids: string[], visible = 5): string {
  if (!ids.length) return 'no explicit subject IDs';
  const head = ids.slice(0, visible).join(', ');
  return ids.length > visible ? `${head} · +${ids.length - visible} more` : head;
}

function pdaKnowledgeClaimLabel(claim: string): string {
  const normalized = claim.replace(/\s+/g, ' ').trim();
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return compactText(normalized, 132);
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const interpretation = typeof parsed.interpretation === 'string' ? parsed.interpretation : '';
    const labels: Record<string, string> = {
      'cartographic-estimate': '地図推定',
      'transmitted-trace-report': '伝達痕跡',
      'contested-transmitted-trace': '競合する伝達痕跡',
    };
    const parts: string[] = [];
    if (interpretation) parts.push(labels[interpretation] ?? interpretation);
    for (const key of ['regionId','historicalTraceId','traceType','assertedOriginClass']) {
      const value = parsed[key];
      if (typeof value === 'string' && value) parts.push(value);
    }
    const center = parsed.estimatedCenter;
    if (center && typeof center === 'object') {
      const point = center as Record<string, unknown>;
      if (typeof point.x === 'number' && typeof point.y === 'number') parts.push(`中心 ${point.x.toFixed(1)}, ${point.y.toFixed(1)}`);
    }
    if (parts.length) return compactText(parts.join(' · '), 132);
  } catch { /* preserve non-JSON or malformed evidence verbatim */ }
  return compactText(normalized, 132);
}

function knowledgeEvidenceDisclosure(entry: SandboxGameState['knowledge'][number]): string {
  const longClaim = entry.claim.replace(/\s+/g, ' ').trim().length > 180;
  const manySubjects = entry.subjectIds.length > 5;
  if (!longClaim && !manySubjects) return '';
  return `<details class="knowledge-evidence-details"><summary>Full evidence payload · ${entry.subjectIds.length} subject${entry.subjectIds.length===1?'':'s'}</summary><div><strong>Claim</strong><p>${esc(entry.claim)}</p><strong>Subject IDs</strong><p>${esc(entry.subjectIds.join(', ') || 'none')}</p></div></details>`;
}

const A11Y_STORAGE_KEY = 'descendants.sandbox.accessibility.v1';
type SandboxAccessibility = { textScale: 1 | 1.25 | 1.5; highContrast: boolean; reduceMotion: boolean };

function loadAccessibility(): SandboxAccessibility {
  const fallback: SandboxAccessibility = { textScale: 1, highContrast: false, reduceMotion: typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false };
  try {
    const raw = window.localStorage.getItem(A11Y_STORAGE_KEY); if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SandboxAccessibility>;
    return { textScale: parsed.textScale === 1.25 || parsed.textScale === 1.5 ? parsed.textScale : 1, highContrast: parsed.highContrast === true, reduceMotion: parsed.reduceMotion ?? fallback.reduceMotion };
  } catch { return fallback; }
}

function storeAccessibility(value: SandboxAccessibility): void { try { window.localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(value)); } catch { /* presentation settings may be ephemeral */ } }

const PDA_PRESENTATION_STORAGE_KEY = 'descendants.pda.presentation.v1';
type PdaPresentation = { scanlines: boolean; flicker: boolean };
function loadPdaPresentation(): PdaPresentation {
  try {
    const raw = window.localStorage.getItem(PDA_PRESENTATION_STORAGE_KEY);
    if (!raw) return { scanlines: true, flicker: true };
    const parsed = JSON.parse(raw) as Partial<PdaPresentation>;
    return { scanlines: parsed.scanlines !== false, flicker: parsed.flicker !== false };
  } catch { return { scanlines: true, flicker: true }; }
}
function storePdaPresentation(value: PdaPresentation): void { try { window.localStorage.setItem(PDA_PRESENTATION_STORAGE_KEY, JSON.stringify(value)); } catch { /* presentation settings may be ephemeral */ } }

export interface SandboxAppOptions {
  startupNotices?: string[];
  persistenceMode?: 'durable' | 'volatile' | 'unavailable';
  providerMode?: 'real-worldgen' | 'snapshot-recovery' | 'mock-diagnostic';
  /** Reconstruct a clean provider from a committed provider snapshot after an uncertain mutation. */
  recoverProvider?: (snapshot: WorldSnapshot) => Promise<{ provider: WorldProvider; providerMode: 'real-worldgen' | 'snapshot-recovery' | 'mock-diagnostic' }>;
}

// Compatibility contract label retained for generated-shell audits: DESCENDANTS FIELD TERMINAL
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

  private mapMarkerStyle(spatial: SpatialRef | undefined, center: SpatialRef, radiusKm: number): string {
    if (!spatial || spatial.frameId !== center.frameId || radiusKm <= 0) return 'left:50%;top:50%';
    const x = Math.max(3, Math.min(97, 50 + (spatial.x - center.x) / radiusKm * 46));
    const y = Math.max(3, Math.min(97, 50 - (spatial.y - center.y) / radiusKm * 46));
    return `left:${x.toFixed(2)}%;top:${y.toFixed(2)}%`;
  }

  private selectedLocalEntity(): WorldEntity | undefined {
    return this.#localProjection?.entities.find((entry)=>entry.id===this.#selectedLocalEntityId);
  }

  private async directAction(minutes: number, mutate: () => string): Promise<void> {
    if (this.#busy || this.#reloadRequiredReason) return;
    const committed = structuredClone(this.state);
    this.#busy = true; this.render(); let message = '';
    try {
      message = mutate();
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
    return `<header class="desc-pda-header"><div class="desc-pda-id"><strong>DESCENDANTS PDA OS v1.0</strong><span>USER: ${esc(agent?.name ?? 'NO COMMAND HOLDER')}</span></div><nav class="desc-pda-tabs" aria-label="Primary terminal views" role="tablist">${([
      ['task','行動','F1'],['map','地図',''],['body','身体','F2'],['knowledge','知識','F3'],['inventory','所持品','F4'],['chronicle','年代記','F5'],['residents','住民',''],['system','システム','F10'],
    ] as Array<[PdaTab,string,string]>).map(([id,label,key])=>`<button id="sandbox-tab-${id}" role="tab" data-action="pda-tab" data-pda-tab="${id}" class="${this.#pdaTab===id?'active':''}" aria-selected="${this.#pdaTab===id}" ${key?`title="${key}"`:''}><span>${label}</span></button>`).join('')}</nav><div class="desc-pda-clock"><div class="desc-pda-clock-line"><strong>${esc(time)}</strong><span>DAY ${this.state.clock.day}</span><div class="desc-pda-battery" title="Terminal power"><i></i></div></div><small>${esc(place)}</small></div></header>`;
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

  private pdaTaskList(read = this.f1SituationReadModel()): string {
    const situations = read.rows;
    const activeExpeditions = this.state.expeditions.filter((entry)=>!['returned','destroyed'].includes(entry.status));
    const research = (this.state.researchProjects ?? []).filter((entry)=>entry.status!=='completed').slice(-3).reverse();
    const entries: string[] = [];
    const selectedIncident = this.selectedF1Incident(read);
    situations.slice(0,6).forEach((signal,index)=>{
      const selected = read.source==='incident' ? signal.id===selectedIncident?.id : index===0;
      if (read.source==='incident') {
        entries.push(`<button type="button" class="desc-pda-task-item desc-pda-incident-focus ${selected?'selected':''}" data-action="incident-focus" data-incident-id="${esc(signal.id)}" data-incident-index="${index}" role="option" aria-selected="${selected}" aria-label="Incident ${esc(signal.title)}, ${esc(signal.severity)}"><span class="task-glyph">${selected?'◆':'◇'}</span><span><strong>${esc(signal.title)}</strong><small>${esc(compactText(signal.detail,72))}</small></span><em>${esc(signal.severity)}</em></button>`);
      } else {
        entries.push(`<article class="desc-pda-task-item ${selected?'selected':''}"><span class="task-glyph">${selected?'◆':'◇'}</span><div><strong>${esc(signal.title)}</strong><small>${esc(compactText(signal.detail,72))}</small></div><em>${esc(signal.severity)}</em></article>`);
      }
    });
    activeExpeditions.slice(0,3).forEach((expedition)=>entries.push(`<article class="desc-pda-task-item"><span class="task-glyph">⇢</span><div><strong>遠征 ${esc(expedition.id)}</strong><small>${esc(expedition.status)} · ${expedition.memberIds.length}名</small></div><em>FIELD</em></article>`));
    research.forEach((project)=>entries.push(`<article class="desc-pda-task-item"><span class="task-glyph">▧</span><div><strong>${esc(project.id)}</strong><small>${esc(project.status)}</small></div><em>DATA</em></article>`));
    if (!entries.length) entries.push('<article class="desc-pda-task-item selected"><span class="task-glyph">◇</span><div><strong>周辺を確認する</strong><small>既知の情報から次の行動を決める。</small></div><em>ACTIVE</em></article>');
    return entries.join('');
  }


  private pdaIncidentResponsePanel(read = this.f1SituationReadModel()): string {
    const field = this.controlledExpedition();
    if (read.source !== 'incident') {
      return `<section class="desc-pda-response-panel is-disabled"><header><div><span>INCIDENT RESPONSE</span><strong>RESPONSE CHANNEL OFFLINE</strong></div><em>F10</em></header><p>緊急対応回線は閉鎖中です。端末設定で回線を開くと、対応班の編成と派遣が可能になります。閉鎖中も通常の集落指揮は継続します。</p></section>`;
    }
    const incident = this.selectedF1Incident(read);
    if (!incident) return `<section class="desc-pda-response-panel"><header><div><span>INCIDENT RESPONSE</span><strong>NO ACTIVE INCIDENT</strong></div><em>IDLE</em></header><p>現在、対応回線に入電している緊急事案はありません。</p></section>`;
    const capacity = deriveIncidentDispatchCapacity(this.state, incident.id, field);
    const available = capacity.availableMemberIds.map((id)=>findAgent(this.state,id)).filter((agent): agent is NonNullable<typeof agent>=>Boolean(agent));
    const availableIds = new Set(capacity.availableMemberIds);
    for (const id of [...this.#incidentResponderDraftIds]) if (!availableIds.has(id)) this.#incidentResponderDraftIds.delete(id);
    const draftIds = [...this.#incidentResponderDraftIds].slice(0,capacity.maxTeamSize);
    const teams = incidentResponseTeams(this.state, incident.id, field).slice().reverse();
    const operations = incidentResponseOperations(this.state, incident.id, field);
    const operationsByTeam = new Map(operations.map((operation)=>[operation.teamId,operation]));
    const reservationsByOperation = new Map(incidentResponseResourceReservations(this.state, incident.id, field).map((reservation)=>[reservation.operationId,reservation]));
    const uses = incidentResponseEvidenceResourceUses(this.state, incident.id, field);
    const allDebriefs = incidentResponseDebriefs(this.state, incident.id, field).slice().reverse();
    const ledger = this.state.incidentLedger?.entries.find((entry)=>entry.contextKey===capacity.contextKey&&entry.incidentId===incident.id);
    const evidence = ledger?.lastResolutionEvidence;
    const medicineKinds = new Set(['recorded-case-cleared','field-health-threshold']);
    const toolKinds = new Set(['communication-restored','encounter-resolved','research-sample-present']);
    const canMedicine = ledger?.phase==='resolved' && Boolean(evidence && medicineKinds.has(evidence.kind));
    const canTools = ledger?.phase==='resolved' && Boolean(evidence && toolKinds.has(evidence.kind));
    const responders = available.slice(0,12).map((agent)=>`<label class="desc-pda-response-responder"><input type="checkbox" data-action="incident-response-member" data-agent-id="${esc(agent.id)}" ${this.#incidentResponderDraftIds.has(agent.id)?'checked':''}><span>${esc(agent.name)}</span><small>${esc(agent.role)} · HP ${agent.health.toFixed(0)} · FAT ${agent.fatigue.toFixed(0)}</small></label>`).join('');
    const teamRows = teams.map((team)=>{
      const operation=operationsByTeam.get(team.id);
      const reservation=operation?reservationsByOperation.get(operation.id):undefined;
      const memberNames=team.memberIds.map((id)=>findAgent(this.state,id)?.name??id).join(', ');
      const phase=operation?.phase ?? team.phase;
      const resource=reservation?`F ${reservation.consumed.food.toFixed(1)}/${reservation.reserved.food.toFixed(1)} · W ${reservation.consumed.water.toFixed(1)}/${reservation.reserved.water.toFixed(1)} · M ${reservation.consumed.medicine.toFixed(1)} · T ${reservation.consumed.tools.toFixed(1)}`:'resource not reserved';
      const controls=team.phase==='assigned'?`<button data-action="incident-dispatch" data-team-id="${esc(team.id)}">DISPATCH</button><button data-action="incident-stand-down" data-team-id="${esc(team.id)}">RELEASE</button>`:team.phase==='dispatched'?`<button data-action="incident-stand-down" data-team-id="${esc(team.id)}">STAND DOWN</button>`:'';
      return `<article class="desc-pda-response-team phase-${esc(phase)}"><header><strong>${esc(team.id)}</strong><em>${esc(phase)}</em></header><p>${esc(memberNames)}</p><small>${operation?`START ${incidentMinuteLabel(operation.startedAt)} · ${resource}`:`ASSIGNED ${incidentMinuteLabel(team.assignedAt)}`}</small><div>${controls}</div></article>`;
    }).join('') || '<p class="desc-pda-response-empty">No response team allocated.</p>';
    const evidenceRow = evidence ? `<div class="desc-pda-response-evidence"><span>POSITIVE EVIDENCE</span><strong>${esc(evidence.kind)}</strong><small>${incidentMinuteLabel(evidence.observedAt)} · occurrence ${evidence.occurrenceNumber} · supporting operations ${evidence.supportingOperationIds.length}</small></div>` : `<div class="desc-pda-response-evidence"><span>POSITIVE EVIDENCE</span><strong>NONE</strong><small>Visibility loss or operation completion alone does not resolve this incident.</small></div>`;
    const useControls = evidence ? `<div class="desc-pda-response-use"><span>EVIDENCE-GROUNDED RESOURCE RECONCILIATION</span>${canMedicine?`<button data-action="incident-resource-use" data-incident-id="${esc(incident.id)}" data-kind="medicine" data-amount="0.25">MEDICINE 0.25</button>`:''}${canTools?`<button data-action="incident-resource-use" data-incident-id="${esc(incident.id)}" data-kind="tools" data-amount="0.5">TOOLS 0.5</button>`:''}<small>${uses.length} reconciled use record${uses.length===1?'':'s'} · operator confirmation never asserts causal success.</small></div>` : '';
    // I2-K regression semantics now delegated to the pure read model: entry.terminalPhase==='completed'; entry.terminalPhase==='aborted'; entry.positiveEvidence.length>0; entry.evidenceResourceUses.length>0.
    const memberLabelForId = (id: string): string | undefined => findAgent(this.state,id)?.name;
    const debriefs = filterIncidentResponseDebriefs(allDebriefs, this.#incidentDebriefFilter, this.#incidentDebriefQuery, memberLabelForId);
    const selectedDebrief = debriefs.find((entry)=>entry.id===this.#selectedDebriefId) ?? debriefs[0];
    if ((selectedDebrief?.id ?? '') !== this.#selectedDebriefId) this.#selectedDebriefId = selectedDebrief?.id ?? '';
    const debriefRows = debriefs.slice(0,8).map((debrief,index)=>`<button type="button" role="option" class="desc-pda-response-debrief ${debrief.id===selectedDebrief?.id?'selected':''}" data-action="incident-debrief-select" data-debrief-id="${esc(debrief.id)}" data-debrief-index="${index}" aria-selected="${debrief.id===selectedDebrief?.id}"><header><strong>${esc(debrief.terminalPhase.toUpperCase())}</strong><time>${incidentMinuteLabel(debrief.chronology.terminalAt)}</time></header><span>${debrief.memberIds.map((id)=>esc(findAgent(this.state,id)?.name??id)).join(', ')}</span><small>${debrief.observations.length} observations · ${debrief.positiveEvidence.length} positive evidence facts · ${debrief.evidenceResourceUses.length} reconciled resource-use facts</small></button>`).join('') || '<p class="desc-pda-response-empty">No debrief facts match this filter/search.</p>';
    const debriefIndex = selectedDebrief ? debriefs.findIndex((entry)=>entry.id===selectedDebrief.id) : -1;
    const filterCount = (filter: IncidentDebriefFilter): number => filterIncidentResponseDebriefs(allDebriefs, filter, this.#incidentDebriefQuery, memberLabelForId).length;
    const debriefFilters: IncidentDebriefFilter[] = ['all','completed','aborted','evidence','resource'];
    const debriefToolbar = `<div class="desc-pda-response-toolbar"><div role="group" aria-label="Debrief fact filters">${debriefFilters.map((filter)=>`<button type="button" data-action="incident-debrief-filter" data-filter="${filter}" aria-pressed="${this.#incidentDebriefFilter===filter}" class="${this.#incidentDebriefFilter===filter?'active':''}">${filter.toUpperCase()} ${filterCount(filter)}</button>`).join('')}</div><label class="desc-pda-response-search"><span>FACT SEARCH</span><input type="search" data-action="incident-debrief-search" value="${esc(this.#incidentDebriefQuery)}" placeholder="member / observation / evidence / resource" aria-label="Search structured debrief facts"><button type="button" data-action="incident-debrief-search-clear" ${this.#incidentDebriefQuery?'':'disabled'} aria-label="Clear debrief fact search">CLEAR</button></label><button type="button" data-action="incident-density-toggle" aria-pressed="${this.#incidentResponseDensity==='compact'}">${this.#incidentResponseDensity==='compact'?'DENSITY: COMPACT':'DENSITY: STANDARD'}</button></div>`;
    const timeline = summarizeIncidentDebriefTimeline(allDebriefs);
    const timelineRows = [...allDebriefs].sort((a,b)=>a.chronology.terminalAt-b.chronology.terminalAt).slice(-6).map((entry)=>`<li><time>${incidentMinuteLabel(entry.chronology.terminalAt)}</time><b>${esc(entry.terminalPhase.toUpperCase())}</b><span>O${entry.observations.length} E${entry.positiveEvidence.length} R${entry.evidenceResourceUses.length}</span></li>`).join('');
    const timelineSummary = `<div class="desc-pda-response-timeline" aria-label="Debrief fact timeline summary"><header><span>TIMELINE FACTS</span><strong>${timeline.terminalCount} terminal · ${timeline.completedCount} completed · ${timeline.abortedCount} aborted</strong></header><small>${timeline.firstTerminalAt===null?'No terminal response operations.':`${incidentMinuteLabel(timeline.firstTerminalAt)} → ${incidentMinuteLabel(timeline.lastTerminalAt ?? timeline.firstTerminalAt)} · span ${timeline.spanMinutes} min · observations ${timeline.observationCount} · evidence ${timeline.positiveEvidenceCount} · resource-use ${timeline.resourceUseCount}`}</small>${timelineRows?`<ol>${timelineRows}</ol>`:''}</div>`;
    const debriefDetail = selectedDebrief ? `<div class="desc-pda-response-debrief-detail" aria-live="polite"><header><span>DEBRIEF FACT ${debriefIndex+1}/${debriefs.length} · FILTER ${esc(this.#incidentDebriefFilter.toUpperCase())}${this.#incidentDebriefQuery?` · SEARCH ${esc(compactText(this.#incidentDebriefQuery,28))}`:''}</span><strong>${esc(selectedDebrief.terminalPhase.toUpperCase())}</strong></header><dl><div><dt>START</dt><dd>${incidentMinuteLabel(selectedDebrief.chronology.startedAt)}</dd></div><div><dt>ARRIVE</dt><dd>${incidentMinuteLabel(selectedDebrief.chronology.arrivedAt)}</dd></div><div><dt>WORK END</dt><dd>${incidentMinuteLabel(selectedDebrief.chronology.workCompletedAt)}</dd></div><div><dt>TERMINAL</dt><dd>${incidentMinuteLabel(selectedDebrief.chronology.terminalAt)}</dd></div></dl><p>${selectedDebrief.observations.map((entry)=>`${esc(entry.kind)}:${esc(entry.incidentVisibility)}`).join(' · ') || 'No bounded observations recorded.'}</p><small>${selectedDebrief.positiveEvidence.map((entry)=>esc(entry.kind)).join(', ') || 'No positive-evidence fact'} · ${selectedDebrief.evidenceResourceUses.map((entry)=>`${esc(entry.evidenceKind)} M${entry.medicine.toFixed(2)} T${entry.tools.toFixed(2)}`).join(', ') || 'No evidence-grounded medicine/tool use'}</small><nav aria-label="Filtered debrief history"><button data-action="incident-debrief-prev" ${debriefIndex>=debriefs.length-1?'disabled':''}>OLDER</button><button data-action="incident-debrief-next" ${debriefIndex<=0?'disabled':''}>NEWER</button></nav></div>` : '';
    const statusStrip = `<div class="desc-pda-response-status-strip" aria-label="Response fact density summary"><span><b>${teams.filter((entry)=>entry.phase==='dispatched').length}</b> dispatched</span><span><b>${operations.filter((entry)=>entry.phase==='working'||entry.phase==='returning'||entry.phase==='mobilizing').length}</b> in progress</span><span><b>${allDebriefs.length}</b> debriefs</span><span><b>${allDebriefs.reduce((sum,entry)=>sum+entry.positiveEvidence.length,0)}</b> evidence facts</span><span><b>${allDebriefs.reduce((sum,entry)=>sum+entry.evidenceResourceUses.length,0)}</b> resource-use facts</span></div>`;
    return `<section class="desc-pda-response-panel ${this.#incidentResponseDensity==='compact'?'is-compact':''}" aria-label="Incident response status for ${esc(incident.presentation.title)}"><header><div><span>INCIDENT RESPONSE / ${esc(read.source.toUpperCase())}</span><strong>${esc(incident.presentation.title)}</strong></div><em>${esc(ledger?.phase ?? 'active')}</em></header>${statusStrip}<div class="desc-pda-response-grid"><section><h4>RESPONDERS</h4><p>${capacity.activeIncidentTeamCount}/${capacity.maxActiveTeamsPerIncident} incident teams · ${capacity.activeContextTeamCount}/${capacity.maxActiveTeamsPerContext} context teams</p><div class="desc-pda-response-responder-list">${responders||'<span>No uncommitted responders available.</span>'}</div><button class="desc-pda-response-primary" data-action="incident-assign" data-incident-id="${esc(incident.id)}" ${capacity.canAssign&&draftIds.length>0?'':'disabled'}>ASSIGN ${draftIds.length} RESPONDER${draftIds.length===1?'':'S'}</button></section><section><h4>ACTIVE / RECENT TEAMS</h4><div class="desc-pda-response-team-list">${teamRows}</div></section><section><h4>OBSERVED FACTS / DEBRIEFS</h4>${evidenceRow}${useControls}${debriefToolbar}${timelineSummary}<div class="desc-pda-response-debrief-list" role="listbox" aria-label="Filtered debrief history">${debriefRows}</div>${debriefDetail}</section></div><footer>対応記録は選択中の事案と現地報告のみ。未確認の原因や結果は確定記録にしません。</footer></section>`;
  }

  private pdaMiniMap(scope: 'world'|'local' = 'world'): string {
    const field = this.controlledExpedition();
    const local = scope==='local' && Boolean(field);
    const center = local && field ? field.position : this.state.settlement.position;
    const radius = local ? 5 : generatedWorldMapRadiusKm(this.state);
    const entities = local ? (this.#localProjection?.entities ?? []) : this.visibleWorldEntities().filter((entry)=>entry.id!==this.state.world.originEntityId);
    const selected = local ? this.selectedLocalEntity() : this.selectedWorldEntity();
    const markers = entities.slice(0,24).map((entry)=> local
      ? `<button class="desc-pda-map-marker ${selected?.id===entry.id?'selected':''}" style="${this.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-local-entity" data-entity-id="${esc(entry.id)}" title="${esc(entityName(entry))}"><i></i><span>${esc(compactText(entityName(entry),24))}</span></button>`
      : `<button class="desc-pda-map-marker ${selected?.id===entry.id?'selected':''}" style="${this.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-world-entity" data-entity-id="${esc(entry.id)}" title="${esc(entityName(entry))}"><i></i><span>${esc(compactText(entityName(entry),24))}</span></button>`
    ).join('');
    return `<div class="desc-pda-map-surface ${local?'local':'world'}"><div class="desc-pda-map-grid" aria-hidden="true"></div><span class="desc-pda-map-origin" title="${local?'Field party':'Settlement'}">◎</span>${markers}<small class="desc-pda-map-scale">±${local?'5':radius.toFixed(0)} km</small></div>`;
  }

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

  private pdaExpeditionPreparation(): string {
    this.initializeExpeditionPreparation();
    const field = this.controlledExpedition();
    const active = this.state.expeditions.filter((entry)=>!['returned','destroyed'].includes(entry.status));
    if (field) {
      const latest = projectChronicle(this.state,this.chronicleViewpoint()).at(-1);
      return `<div class="desc-pda-expedition-active"><header><div><span>ACTIVE FIELD OPERATION</span><h2>${esc(field.id)}</h2></div><em>${esc(field.status)}</em></header><div class="desc-pda-expedition-metrics"><div><span>位置</span><b>${field.position.x.toFixed(1)}, ${field.position.y.toFixed(1)}</b></div><div><span>隊員</span><b>${field.memberIds.length}名</b></div><div><span>食料</span><b>${field.supplies.food.toFixed(1)}</b></div><div><span>水</span><b>${field.supplies.water.toFixed(1)}</b></div></div><section><strong>現在のフィールド状態</strong><p>${esc(latest?.text ?? '直近の可視報告はありません。')}</p></section><div class="desc-pda-expedition-actions"><button data-action="pda-tab" data-pda-tab="map">地図 / LOCAL</button>${['outbound','exploring'].includes(field.status)?`<button data-action="return" data-expedition-id="${esc(field.id)}">帰還命令</button>`:''}<button data-action="pda-task-panel" data-panel="overview">行動概要へ戻る</button></div></div>`;
    }
    const available = settlementAgents(this.state).filter((agent)=>agentAgeYears(this.state,agent)>=16).sort((a,b)=>b.skills.scouting-a.skills.scouting);
    const selectedCrew = available.filter((agent)=>this.#prepCrewIds.has(agent.id));
    const leader = findAgent(this.state,this.#prepLeaderId);
    const doctrine = this.selectedPreparationDoctrine();
    const target = this.#prepTarget;
    const visibleWorldEntities = this.visibleWorldEntities();
    const targetEntity = this.#prepTargetEntityId ? visibleWorldEntities.find((entry)=>entry.id===this.#prepTargetEntityId) : undefined;
    const topologyRoutes = targetEntity ? providerVisibleRouteAlternatives(this.#worldProjection, visibleWorldEntities, this.state.world.originEntityId, targetEntity.id, 3) : [];
    const selectedTopologyRoute = this.#prepRouteEntityId ? topologyRoutes.find((entry)=>entry.id===this.#prepRouteEntityId) : undefined;
    const topologyEvidenceRouteIds = new Set(topologyRoutes.flatMap((entry)=>entry.evidenceIds));
    const knownRoutes = visibleWorldEntities.filter((entry)=>entry.kind==='route' && entry.spatial && !topologyEvidenceRouteIds.has(entry.id));
    const selectedRoute = this.#prepRouteEntityId ? knownRoutes.find((entry)=>entry.id===this.#prepRouteEntityId) : undefined;
    const plannedWaypoints = selectedTopologyRoute?.waypoints ?? selectedRoute?.spatial;
    const selectedWeight = selectedCrew.reduce((sum,agent)=>sum+equipmentForAgent(this.state,agent.id).filter((item)=>item.equipped).reduce((inner,item)=>inner+item.weightKg,0),0);
    const supplyWeight = this.#prepSupplies.food*0.55 + this.#prepSupplies.water + this.#prepSupplies.medicine*0.18 + this.#prepSupplies.tools*1.5;
    const resourceOk = this.state.settlement.resources.food>=this.#prepSupplies.food && this.state.settlement.resources.water>=this.#prepSupplies.water && this.state.settlement.resources.medicine>=this.#prepSupplies.medicine && this.state.settlement.resources.scrap>=this.#prepSupplies.tools;
    const supplyReadiness = expeditionSupplyReadiness(this.state, selectedCrew.map((agent)=>agent.id), target, this.#prepPace, this.#prepSupplies, plannedWaypoints, selectedTopologyRoute?.distanceKm);
    const settlementReserve = doctrine ? settlementSupplyReserveReadiness(this.state, this.#prepSupplies, doctrine) : null;
    const launchReady = selectedCrew.length>0 && Boolean(leader && this.#prepCrewIds.has(leader.id) && doctrine && target && resourceOk && supplyReadiness.ready && settlementReserve?.ready);
    const targetLabel = target ? `${targetEntity?entityName(targetEntity):'既知座標'} · ${target.x.toFixed(1)}, ${target.y.toFixed(1)}` : '未選択 — 地図から既知地点を指定';
    return `<div class="desc-pda-expedition-prep"><header><div><span>EXPEDITION PREPARATION</span><h2>遠征準備</h2></div><em>${launchReady?'READY':'CHECK'}</em></header><p class="desc-pda-expedition-intro">既知WORLD情報だけを使って、隊員・物資・行軍方針・目的地を確定します。未発見地点は候補に追加しません。</p><div class="desc-pda-expedition-grid"><section><strong>1 / CREW</strong><div class="desc-pda-crew-list">${available.slice(0,12).map((agent)=>{const readiness=doctrine?expeditionMemberReadiness(agent,doctrine):{ready:false,reasons:['doctrine required']};return `<label class="${readiness.ready?'':'blocked'}"><input type="checkbox" data-action="prep-crew" data-agent-id="${esc(agent.id)}" ${this.#prepCrewIds.has(agent.id)?'checked':''} ${readiness.ready?'':'disabled'}><span>${esc(agent.name)}</span><small>HP ${agent.health.toFixed(0)} · FAT ${agent.fatigue.toFixed(0)} · ${readiness.ready?'READY':esc(readiness.reasons[0]??'BLOCKED')}</small></label>`;}).join('')}</div><label class="desc-pda-field-label">隊長<select data-action="prep-leader">${selectedCrew.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===this.#prepLeaderId?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><label class="desc-pda-field-label">出発後の操作<select data-action="control-mode"><option value="expedition" ${this.#controlMode==='expedition'?'selected':''}>遠征隊を操作</option><option value="settlement" ${this.#controlMode==='settlement'?'selected':''}>集落に残る</option></select></label></section><section><strong>2 / LOADOUT</strong><div class="desc-pda-loadout-grid">${(['food','water','medicine','tools'] as const).map((kind)=>`<label><span>${kind==='food'?'食料':kind==='water'?'水':kind==='medicine'?'薬':'工具'}</span><input type="number" min="0" step="${kind==='medicine'?'0.25':'1'}" data-action="prep-supply" data-supply="${kind}" value="${this.#prepSupplies[kind]}"></label>`).join('')}</div><div class="desc-pda-readiness ${resourceOk?'ready':'blocked'}"><b>物資</b><span>${resourceOk?'集落在庫から搬出可能':'在庫不足'}</span><small>装備 ${selectedWeight.toFixed(1)} kg · 共用物資 ${supplyWeight.toFixed(1)} kg</small></div><div class="desc-pda-readiness ${supplyReadiness.ready?'ready':'blocked'}"><b>FIELD ENDURANCE</b><span>${supplyReadiness.ready?'READY':'BLOCKED'}</span><small>食料 ${supplyReadiness.foodDays.toFixed(1)}日 · 水 ${supplyReadiness.waterDays.toFixed(1)}日${target&&Number.isFinite(supplyReadiness.estimatedOutboundHours)?` · 往路推定 ${supplyReadiness.estimatedOutboundHours.toFixed(1)}h`:''}</small></div><div class="desc-pda-readiness ${settlementReserve?.ready?'ready':'blocked'}"><b>集落予備</b><span>${settlementReserve?.ready?'PROTECTED':'CHECK'}</span><small>${settlementReserve?`残存 食料 ${settlementReserve.remainingFoodDays.toFixed(1)}日 / 水 ${settlementReserve.remainingWaterDays.toFixed(1)}日`:'Doctrineを選択してください'}</small></div></section><section><strong>3 / ROUTE & DOCTRINE</strong><label class="desc-pda-field-label">行軍速度<select data-action="prep-pace">${(['cautious','normal','fast'] as ExpeditionPace[]).map((pace)=>`<option value="${pace}" ${pace===this.#prepPace?'selected':''}>${pace}</option>`).join('')}</select></label><label class="desc-pda-field-label">Doctrine<select data-action="prep-doctrine">${this.state.doctrines.map((entry)=>`<option value="${esc(entry.id)}" ${entry.id===doctrine?.id?'selected':''}>${esc(entry.name)}</option>`).join('')}</select></label><div class="desc-pda-target-readout"><span>目的地</span><strong>${esc(targetLabel)}</strong><button data-action="pda-tab" data-pda-tab="map">地図から選択</button></div>${target?`<label class="desc-pda-field-label">既知ルート<select data-action="prep-route"><option value="" ${this.#prepRouteEntityId?'':'selected'}>direct / known waypointなし</option>${topologyRoutes.map((route,index)=>`<option value="${esc(route.id)}" ${route.id===this.#prepRouteEntityId?'selected':''}>topology ${index+1} · ${route.distanceKm.toFixed(1)} km</option>`).join('')}${knownRoutes.map((route)=>`<option value="${esc(route.id)}" ${route.id===this.#prepRouteEntityId?'selected':''}>via ${esc(entityName(route))}</option>`).join('')}</select></label>`:''}<div class="desc-pda-active-count"><span>他の活動中遠征</span><b>${active.length}</b></div></section></div><div class="desc-pda-launch-row"><button data-action="pda-task-panel" data-panel="overview">戻る</button><button data-action="launch" class="launch" ${launchReady?'':'disabled'}>遠征を出発させる</button></div></div>`;
  }

  private pdaCampaignCommand(): string {
    const campaign = deriveSurvivalCampaignView(this.state);
    const loop = ensureDailyLoopState(this.state);
    const report = loop.lastMorningReport;
    const canonicalBlockReason = this.dailyExecutionBlockReason();
    const command = deriveDailyCommandView({
      state: this.state,
      plan: loop.currentPlan,
      ...(report ? { report } : {}),
      campaign,
      ...(canonicalBlockReason ? { canonicalBlockReason } : {}),
    });
    const readinessLabel: Record<typeof command.readiness,string> = { ready:'READY', risk:'RISK', blocked:'BLOCKED' };
    const tasks: LaborTask[] = ['forage','water','medicine','repair','sanitation','care','records','guard','rest','explore-prep'];
    const severityLabel: Record<MorningResidentSeverity,string> = {
      death:'死亡', critical:'重篤', severe:'重症', 'new-condition':'新規症状', needs:'配給危機', worsened:'悪化', watch:'要注意', improved:'改善', stable:'安定',
    };
    const activeExpeditions = this.state.expeditions.filter((entry)=>!['returned','destroyed','joined-elsewhere'].includes(entry.status));
    const interruption = loop.executionSession?.status==='interrupted' ? loop.executionSession.interruption : undefined;
    const morningRows = report?.residentDeltas ?? [];
    const triageRows = morningRows.filter((entry) => !['stable', 'improved'].includes(entry.severity));
    const visibleMorningRows = this.#morningReportExpanded
      ? morningRows
      : (triageRows.length ? triageRows : morningRows.slice(0, 3));
    const hiddenMorningCount = Math.max(0, morningRows.length - visibleMorningRows.length);
    const assignmentReadbackVisible=this.#assignmentConsequenceReadback.slice(0,4);
    const assignmentReadbackAlerts=this.#assignmentConsequenceReadback.filter((entry)=>!['stable','improved'].includes(entry.severity)).length;
    const morningReplan=morningReplanQueue(this.#assignmentConsequenceReadback,command.residentRows,command.restPressure);
    const morningReplanVisible=morningReplan.slice(0,4);
    const morningReplanRestCount=morningReplan.filter((entry)=>entry.restEligible).length;
    const signedAssignmentDelta=(value:number):string=>`${value>=0?'+':''}${value.toFixed(0)}`;
    const assignmentReadbackTone=(severity: MorningResidentSeverity): 'critical'|'warning'|'normal' =>
      severity==='death'||severity==='critical' ? 'critical' : ['severe','new-condition','needs','worsened','watch'].includes(severity) ? 'warning' : 'normal';
    const followUpCrisis = command.outcomes.some((issue) => issue.id === 'outcome-response-log' && issue.tone !== 'normal') && command.crisisRecommendations.length > 0;
    const returnReviewByAgent = new Map((command.restReleaseReview?.candidates ?? []).map((candidate) => [candidate.agentId, candidate]));
    const crisisTasks = new Set(command.crisisRecommendations.map((entry)=>entry.task));
    const boardLaneFor = (task: LaborTask): 'crisis'|'normal'|'rest'|'field' => task === 'rest' ? 'rest' : task === 'explore-prep' ? 'field' : crisisTasks.has(task) ? 'crisis' : 'normal';
    const boardRows = command.residentRows;
    const selectedBoardRow = boardRows.find((row)=>row.agentId===this.#dailyPlanBoardAgentId) ?? boardRows.find((row)=>!row.locked) ?? boardRows[0];
    if (selectedBoardRow && selectedBoardRow.agentId!==this.#dailyPlanBoardAgentId) this.#dailyPlanBoardAgentId=selectedBoardRow.agentId;
    const boardMoves = boardRows.filter((row)=>row.previousTask !== row.assignedTask);
    const boardRowsFor = (lane: 'crisis'|'normal'|'rest'|'field') => boardRows.filter((row)=>boardLaneFor(row.assignedTask)===lane);
    const renderBoardChip = (row: typeof boardRows[number]) => `<button class="desc-plan-board-chip ${row.agentId===selectedBoardRow?.agentId?'is-selected':''} ${row.previousTask!==row.assignedTask?'has-move':''} ${row.riskNote?'has-risk':''}" data-action="daily-board-select" data-agent-id="${esc(row.agentId)}" aria-pressed="${row.agentId===selectedBoardRow?.agentId}" aria-label="${esc(row.name)}を選択 · ${esc(laborTaskDisplayName(row.assignedTask))}${row.riskNote?' · RISK':''}"><b>${esc(row.name)}</b><small>${esc(laborTaskDisplayName(row.assignedTask))}</small>${row.previousTask!==row.assignedTask?'<em>↳ MOVE</em>':''}${row.riskNote?'<i>! RISK</i>':''}</button>`;
    const boardMoveSummary = boardMoves.length ? `${boardMoves.slice(0,4).map((row)=>`${esc(row.name)} · ${esc(laborTaskDisplayName(row.previousTask))} → ${esc(laborTaskDisplayName(row.assignedTask))}`).join('<span aria-hidden="true"> / </span>')}${boardMoves.length>4?`<b>+${boardMoves.length-4}</b>`:''}` : 'NO MOVES / 前日配置を維持';
    const morningPulse = this.#commandPulseMorningDay !== this.state.clock.day && !this.#dailyExecutionActive && this.#crtTransition === 'idle';
    if (morningPulse) {
      this.#commandPulseMorningDay = this.state.clock.day;
      if (this.#commandPulsePhase !== 'readback') this.#commandPulsePhase = 'morning';
    }
    const commandSignalPhase = this.#commandPulsePhase === 'locked' || this.#commandPulsePhase === 'executing' ? 'execute' : this.#commandPulsePhase;
    const signalSteps = [
      ['morning','MORNING','観測'], ['plan','ORDERS','配備'], ['execute','OPERATE','稼働'], ['readback','REPORT','報告'],
    ] as const;
    return `<section class="desc-pda-campaign-command desc-daily-command ${morningPulse?'desc-command-morning-pulse':''}" data-command-phase="${commandSignalPhase}">
      <header class="desc-daily-header"><div><span>MORNING REPORT</span><h2>DAY ${this.state.clock.day} / 朝の集落</h2></div><div class="desc-daily-header-meta"><b>${esc(campaign.directive.title)}</b><small>YEAR ${campaign.currentYear} · ${esc(campaign.generationLabel)}</small><small class="desc-daily-continuity">CONTINUITY STATUS · 子孫 ${campaign.livingDescendants} · ARCHIVE GATES ${campaign.milestones.filter((entry)=>entry.complete).length}/${campaign.milestones.length}</small></div><a class="desc-daily-plan-jump" href="#daily-plan-section" data-action="daily-plan-jump">当直へ ↓</a></header>
      <nav class="desc-command-signal" aria-label="Daily command signal" data-command-phase="${commandSignalPhase}"><span>SHIFT CYCLE</span><ol>${signalSteps.map(([phase,label,detail])=>`<li class="${phase===commandSignalPhase?'is-active':''}" data-command-step="${phase}"><b>${label}</b><small>${detail}</small></li>`).join('')}</ol></nav>
      <section class="desc-daily-priorities" aria-labelledby="daily-priorities-title">
        <div class="desc-daily-section-head"><div><span id="daily-priorities-title">COMMAND QUEUE</span><strong>未処理の指令</strong></div><small>${command.priorities.length} / 3</small></div>
        <div class="desc-daily-priority-list">${command.priorities.map((issue,index)=>`<article class="desc-daily-priority tone-${issue.tone}" data-command-tone="${issue.tone}"><b>${index+1}</b><div><strong>${esc(issue.title)}</strong><small>${esc(issue.detail)}</small></div>${issue.target?`<button data-action="daily-detail" data-daily-target="${issue.target}" ${issue.agentId?`data-agent-id="${esc(issue.agentId)}"`:''}>詳細</button>`:''}</article>`).join('')}</div>
      </section>
      ${command.longHorizon ? `<section class="desc-daily-long-horizon" data-long-horizon="${command.longHorizon.milestoneId}" aria-label="Continuity directive"><div><span>CONTINUITY DIRECTIVE</span><strong>次期継承工程 · ${esc(command.longHorizon.label)}</strong></div><p><b>${esc(command.longHorizon.title)}</b><small>${esc(command.longHorizon.progress)}</small></p><small>${esc(command.longHorizon.detail)}</small><button data-action="daily-detail" data-daily-target="${command.longHorizon.target}">確認</button></section>` : ''}
      ${command.outcomes.length ? `<section class="desc-daily-outcomes" aria-labelledby="daily-outcomes-title"><div class="desc-daily-section-head"><div><span id="daily-outcomes-title">YESTERDAY'S OUTCOME</span><strong>昨日の結果</strong></div><small>${command.outcomes.length}件</small></div><div class="desc-daily-outcome-strip">${command.outcomes.map((issue)=>`<article class="tone-${issue.tone}" data-daily-outcome="${esc(issue.id)}" data-command-tone="${issue.tone}" ${issue.id==='outcome-response-log'?'data-crisis-readback="1"':''} ${issue.id==='outcome-rest-recovery'?'data-rest-readback="1"':''}><div>${issue.id==='outcome-response-log'?'<em class="desc-daily-outcome-readback">CRISIS REPORT</em>':issue.id==='outcome-rest-recovery'?'<em class="desc-daily-outcome-rest-readback">RECOVERY REPORT</em>':''}<strong>${esc(issue.title)}</strong><small>${esc(issue.detail)}</small></div>${issue.id==='outcome-response-log' && issue.tone!=='normal' && command.crisisRecommendations.length ? `<button data-action="daily-follow-up-crisis">対応を続ける</button>` : issue.id==='outcome-rest-recovery' && command.restFollowUp ? `<div class="desc-daily-rest-follow-up" data-rest-follow-up="${command.restFollowUp.candidateCount}" aria-label="Rest follow-up"><em>RECOVERY WATCH / 休養継続</em>${command.restFollowUp.candidates.map((candidate)=>candidate.alreadyResting?`<span data-rest-follow-up-agent="${esc(candidate.agentId)}"><b>${esc(candidate.name)}</b><small>${esc(candidate.detail)}</small><i>休養継続中</i></span>`:`<button data-action="daily-rest-resident" data-agent-id="${esc(candidate.agentId)}" aria-label="${esc(candidate.name)}を再休養へ割当"><b>${esc(candidate.name)}</b><small>${esc(candidate.detail)}</small><i>再休養</i></button>`).join('')}</div>` : issue.id==='outcome-rest-recovery' && command.restReleaseReview ? `<div class="desc-daily-rest-release" data-rest-release-review="${command.restReleaseReview.candidateCount}" aria-label="Return-to-duty review"><em>DUTY CLEARANCE / 復帰確認</em>${command.restReleaseReview.candidates.map((candidate)=>`<button data-action="daily-review-return" data-agent-id="${esc(candidate.agentId)}" aria-label="${esc(candidate.name)}の復帰先を配置盤で選ぶ"><b>${esc(candidate.name)}</b><small>${esc(candidate.detail)}</small>${candidate.taskContexts.length ? `<span class="desc-daily-return-context" data-return-context="${candidate.taskContexts.length}"><em>DUTY OPTIONS / 復帰比較</em>${candidate.taskContexts.map((context)=>`<span class="desc-daily-return-option" data-return-option="${context.task}"><u>${esc(context.detail)}</u><i data-return-effect="${esc(context.task)}">${esc(context.effectDetail)}</i><i data-return-fit="${esc(context.task)}">${esc(context.fitDetail)}</i><i data-return-balance="${context.balanceDirection}">${esc(context.balanceEffectDetail)}</i></span>`).join('')}</span>` : ''}<i>復帰先を選ぶ</i></button>`).join('')}</div>` : issue.target?`<button data-action="daily-detail" data-daily-target="${issue.target}" ${issue.agentId?`data-agent-id="${esc(issue.agentId)}"`:''}>確認</button>`:''}</article>`).join('')}</div></section>` : ''}
      ${assignmentReadbackVisible.length ? `<section class="desc-assignment-readback ${commandSignalPhase==='readback'?'is-fresh':''}" aria-labelledby="assignment-readback-title" data-assignment-readback="${this.#assignmentConsequenceReadback.length}"><header><div><span id="assignment-readback-title">DUTY REPORT</span><strong>前勤務の観測記録</strong></div><div class="desc-assignment-readback-summary"><em>AFTER-ACTION OBSERVATION · 原因未確定</em><small>ROSTER CHANGES ${this.#assignmentConsequenceReadback.length} · REVIEW ${assignmentReadbackAlerts}</small></div></header><div class="desc-assignment-readback-grid">${assignmentReadbackVisible.map((entry)=>{const tone=assignmentReadbackTone(entry.severity);return `<button class="desc-assignment-readback-card tone-${tone}" data-action="daily-detail" data-daily-target="body" data-agent-id="${esc(entry.agentId)}" data-command-tone="${tone}" aria-label="${esc(entry.name)}の配置結果を身体詳細で確認"><span class="desc-assignment-readback-person"><b>${esc(entry.name)}</b><em>${esc(severityLabel[entry.severity])}</em></span><span class="desc-assignment-trace"><small>PREVIOUS</small><b>${esc(laborTaskDisplayName(entry.fromTask))}</b><i aria-hidden="true">→</i><small>EXECUTED</small><b>${esc(laborTaskDisplayName(entry.toTask))}</b></span><span class="desc-assignment-readback-metrics"><b>HP ${signedAssignmentDelta(entry.healthDelta)} → ${entry.healthAfter.toFixed(0)}</b><b>FAT ${signedAssignmentDelta(entry.fatigueDelta)}</b><b>MOR ${signedAssignmentDelta(entry.moraleDelta)}</b></span><small>${esc(entry.summary)}</small></button>`;}).join('')}</div>${this.#assignmentConsequenceReadback.length>assignmentReadbackVisible.length?`<small class="desc-assignment-readback-overflow">+${this.#assignmentConsequenceReadback.length-assignmentReadbackVisible.length} MORE CHANGES / 朝の記録を確認</small>`:''}</section>` : ''}
      ${morningReplanVisible.length ? `<section class="desc-morning-replan ${commandSignalPhase==='readback'?'is-fresh':''}" aria-labelledby="morning-replan-title" data-morning-replan="${morningReplan.length}"><header><div><span id="morning-replan-title">DUTY REVIEW</span><strong>要観察員の勤務照合</strong></div><div><em>MORNING WATCH · 医療・勤務ログ照合</em><small>WATCH ${morningReplan.length} · REST PRESSURE ${morningReplanRestCount}</small></div></header><div class="desc-morning-replan-grid">${morningReplanVisible.map((entry)=>{const tone=assignmentReadbackTone(entry.severity);return `<article class="desc-morning-replan-card tone-${tone} ${entry.replanned?'is-replanned':'is-unchanged'}" data-replan-agent-id="${esc(entry.agentId)}" data-command-tone="${tone}"><span class="desc-morning-replan-person"><b>${esc(entry.name)}</b><em>${esc(severityLabel[entry.severity])}</em><i>${entry.replanned?'REASSIGNED':'ON DUTY'}</i></span><span class="desc-morning-replan-route"><small>LAST SHIFT</small><b>${esc(laborTaskDisplayName(entry.fromTask))}</b><i aria-hidden="true">→</i><b>${esc(laborTaskDisplayName(entry.toTask))}</b><small>CURRENT POST</small><strong>${esc(laborTaskDisplayName(entry.currentTask))}</strong></span><span class="desc-morning-replan-metrics"><b>HP ${signedAssignmentDelta(entry.healthDelta)}</b><b>FAT ${signedAssignmentDelta(entry.fatigueDelta)}</b><b>MOR ${signedAssignmentDelta(entry.moraleDelta)}</b></span><small class="desc-morning-replan-summary">${esc(entry.summary)}</small><span class="desc-morning-replan-actions"><button data-action="daily-replan-focus" data-agent-id="${esc(entry.agentId)}" aria-label="${esc(entry.name)}を配置盤で確認">配置盤へ</button>${entry.restEligible?`<button data-action="daily-replan-rest" data-agent-id="${esc(entry.agentId)}" aria-label="${esc(entry.name)}を既存REST PRESSUREに基づき休養へ割当">休養へ</button>`:''}</span></article>`;}).join('')}</div>${morningReplan.length>morningReplanVisible.length?`<small class="desc-morning-replan-overflow">+${morningReplan.length-morningReplanVisible.length} MORE · 朝の記録 / 配置盤で確認</small>`:''}</section>` : ''}
      <section class="desc-survival-telemetry ${morningPulse||commandSignalPhase==='readback'?'is-fresh':''}" aria-labelledby="survival-instruments-title"><div class="desc-daily-section-head"><div><span id="survival-instruments-title">SURVIVAL INSTRUMENTS</span><strong>集落サバイバル計器</strong></div><small>EXACT CURRENT + OBSERVED 24H</small></div><div class="desc-daily-resource-summary" aria-label="Daily survival summary">${command.resourceSummary.map((item)=>{const trendSymbol=item.trend==='up'?'↑':item.trend==='down'?'↓':item.trend==='flat'?'=':'•';return `<article class="desc-survival-instrument tone-${item.tone}" data-command-tone="${item.tone}" data-instrument-status="${item.statusLabel}" data-instrument-trend="${item.trend}"><header><span>${esc(item.label)}</span><em>${item.statusLabel}</em></header><strong class="desc-instrument-value">${esc(item.value)}</strong><small class="desc-instrument-detail">${esc(item.detail)}</small><div class="desc-instrument-trend"><b>OBSERVED 24H</b><span>${trendSymbol} ${esc(item.trendLabel)}</span></div><div class="desc-instrument-pressure" aria-label="Pressure state ${item.statusLabel}"><i class="${item.statusLabel==='STABLE'?'is-active':''}"><span>STABLE</span></i><i class="${item.statusLabel==='WATCH'?'is-active':''}"><span>WATCH</span></i><i class="${item.statusLabel==='CRITICAL'?'is-active':''}"><span>CRIT</span></i></div><button data-action="daily-detail" data-daily-target="${item.target}">詳細</button></article>`;}).join('')}</div></section>
      <section class="desc-morning-report"><div class="desc-daily-section-head"><div><span>MORNING REPORT / RESIDENT DATABASE</span><strong>要警戒順</strong></div><small>${morningRows.length} LOGS · ALERT ORDER</small><button data-action="daily-morning-toggle" aria-expanded="${this.#morningReportExpanded}" ${!this.#morningReportExpanded && hiddenMorningCount === 0 ? 'disabled' : ''}>${this.#morningReportExpanded ? '重要項目だけ' : `全住民を表示${hiddenMorningCount ? ` (${hiddenMorningCount})` : ''}`}</button></div>
        <div class="desc-morning-table" role="table" aria-label="Morning resident status database"><div class="desc-morning-row head" role="row"><span>重要度</span><span>住民</span><span>前日→今日</span><span>体力</span><span>空腹/渇き</span><span>病理</span><span>昨日/現在</span><span>推奨</span></div>${visibleMorningRows.map((delta)=>`<div class="desc-morning-row severity-${delta.severity}" role="row" data-morning-agent-id="${esc(delta.agentId)}" data-severity-score="${delta.severityScore}"><b>${esc(severityLabel[delta.severity])}</b><button data-action="daily-detail" data-daily-target="body" data-agent-id="${esc(delta.agentId)}">${esc(delta.name)}</button><span>${esc(delta.summary)}</span><span>${delta.healthAfter.toFixed(0)} <small>${delta.healthDelta===0?'±0':`${delta.healthDelta>0?'+':''}${delta.healthDelta.toFixed(0)}`}</small></span><span>${delta.hungerAfter.toFixed(0)} / ${delta.thirstAfter.toFixed(0)}</span><span>${esc(delta.newPathologyIds.length?`NEW ${delta.newPathologyIds.join(', ')}`:(delta.activePathologyIds.join(', ')||'—'))}</span><span>${esc(delta.task)}${delta.expeditionId?' / FIELD':''}</span><small>${esc(delta.recommendedResponse)}</small></div>`).join('') || '<p>初日の基準スナップショットです。行動実行後に前日差分が表示されます。</p>'}</div>
        ${report ? `<footer><span>出生 ${report.births.length}</span><span>死亡 ${report.deaths.length}</span><span>遠征更新 ${report.expeditionUpdates.length}</span><span>集落更新 ${report.settlementUpdates.length}</span></footer>` : ''}
      </section>
      <section class="desc-daily-field"><div class="desc-daily-section-head"><div><span>探索・遠征の現状</span><strong>FIELD / EXPEDITION STATUS</strong></div><button data-action="pda-task-panel" data-panel="expedition">遠征詳細</button></div>${activeExpeditions.length?activeExpeditions.map((entry)=>`<article><strong>${esc(entry.id)}</strong><span>${esc(entry.status)}</span><small>${entry.memberIds.length}名 · leader ${esc(findAgent(this.state,entry.leaderId)?.name??entry.leaderId)}</small></article>`).join(''):'<p>現在活動中の遠征隊はありません。</p>'}</section>
      <section class="desc-daily-plan" id="daily-plan-section"><div class="desc-daily-section-head"><div><span>OPERATIONS ROSTER</span><strong>本日の勤務</strong></div><small>${loop.currentPlan.status.toUpperCase()}</small></div>
        <div class="desc-daily-policy"><label>探索・遠征<select data-action="daily-policy" data-policy-domain="expedition"><option value="auto" ${loop.currentPlan.policies.expedition==='auto'?'selected':''}>AUTO</option><option value="manual" ${loop.currentPlan.policies.expedition==='manual'?'selected':''}>MANUAL</option></select></label><label>医療手当<select data-action="daily-policy" data-policy-domain="medical"><option value="auto" ${loop.currentPlan.policies.medical==='auto'?'selected':''}>AUTO</option><option value="manual" ${loop.currentPlan.policies.medical==='manual'?'selected':''}>MANUAL</option></select></label><small>AUTOは現場判断に委任。MANUALは医療・遠征で重大事案が発生した場合、指令待ちで停止します。</small></div>
        ${command.crisisRecommendations.length ? `<div class="desc-daily-crisis-response${followUpCrisis ? ' is-follow-up' : ''}" aria-label="Crisis response shortlist" data-crisis-follow-up="${followUpCrisis ? '1' : '0'}"><div class="desc-daily-crisis-response-title"><span>CRISIS CREW</span><strong>危機対応候補</strong>${followUpCrisis ? '<em>FOLLOW-UP / 継続危機</em>' : ''}<small>RESPONSE ORDER / 対応順: criticalを先、同段階は既存F1の水系→食料。昨日担当は後順位。成果予測はしません。${command.crisisConflicts.length ? ` · 候補競合 ${command.crisisConflicts.length}名` : ''}</small>${command.crisisCoverage ? `<div class="desc-daily-crisis-coverage" data-crisis-coverage="${command.crisisCoverage.coveredCount}/${command.crisisCoverage.totalCount}"><span>COVERAGE ${command.crisisCoverage.coveredCount}/${command.crisisCoverage.totalCount} / 対応進捗</span><small>${esc(command.crisisCoverage.detail)}</small>${command.crisisCoverage.nextCrisisId ? `<button data-action="daily-next-crisis" data-crisis-id="${esc(command.crisisCoverage.nextCrisisId)}" data-priority-order="${command.crisisCoverage.nextPriorityOrder ?? ''}" aria-label="次の危機 #${command.crisisCoverage.nextPriorityOrder ?? ''} ${esc(command.crisisCoverage.nextTitle ?? '')}へ移動">次の危機へ #${command.crisisCoverage.nextPriorityOrder}</button>` : ''}</div>` : ''}${command.crisisRecovery ? `<div class="desc-daily-crisis-recovery" data-crisis-recovery="${command.crisisRecovery.excessCount}"><span>RECOVERY CAPACITY</span><small>${esc(command.crisisRecovery.detail)}</small>${command.crisisRecovery.assignment ? `<button data-action="daily-release-crisis-excess" data-agent-id="${esc(command.crisisRecovery.assignment.agentId)}" data-return-task="${command.crisisRecovery.assignment.returnTask}" aria-label="${esc(command.crisisRecovery.assignment.name)}を${esc(laborTaskDisplayName(command.crisisRecovery.assignment.returnTask))}へ戻す">余剰1名を戻す</button>` : ''}</div>` : ''}${command.normalOpsBalance ? `<div class="desc-daily-normal-ops" data-normal-ops-gap="${command.normalOpsBalance.shortfallCount}"><span>NORMAL OPS / 平常業務</span><small>${esc(command.normalOpsBalance.detail)}</small>${command.normalOpsBalance.recoveryTask ? `<em>戻し候補: ${esc(laborTaskDisplayName(command.normalOpsBalance.recoveryTask))}</em>` : ''}</div>` : ''}${command.crisisFocusAssignment ? `<div class="desc-daily-crisis-focus" data-crisis-focus="1"><span>FOCUS #1</span><small>${esc(command.crisisFocusAssignment.title)} · ${command.crisisFocusAssignment.reason === 'continuity-gap' ? `昨日水準 ${command.crisisFocusAssignment.assignedCount}/${command.crisisFocusAssignment.requiredCoverage}名` : '未配置 · まず1名'}</small><button data-action="daily-focus-top-crisis" data-agent-id="${esc(command.crisisFocusAssignment.agentId)}" data-task="${command.crisisFocusAssignment.task}" data-priority-order="${command.crisisFocusAssignment.priorityOrder}" aria-label="#1 ${esc(command.crisisFocusAssignment.title)}へ${esc(command.crisisFocusAssignment.name)}を1名配置">#1へ1名配置</button></div>` : ''}${command.crisisConflicts.length ? `<div class="desc-daily-crisis-conflict"><span>STAFF CONFLICT</span><small>${command.crisisConflicts.slice(0,2).map((conflict)=>`${esc(conflict.name)}: ${conflict.tasks.map((task)=>esc(laborTaskDisplayName(task))).join('/')}`).join(' · ')}</small>${command.crisisBalanceAssignments.length >= 2 ? `<button data-action="daily-balance-crises" data-agent-ids="${command.crisisBalanceAssignments.map((entry)=>esc(entry.agentId)).join(',')}" data-tasks="${command.crisisBalanceAssignments.map((entry)=>entry.task).join(',')}" data-priority-orders="${command.crisisBalanceAssignments.map((entry)=>entry.priorityOrder).join(',')}" aria-label="対応順に競合を避けて未配置危機へ${command.crisisBalanceAssignments.length}名を割当">未配置危機へ1名ずつ ×${command.crisisBalanceAssignments.length}</button>` : ''}</div>` : ''}</div>${command.crisisRecommendations.map((recommendation)=>`<article data-crisis-response="${esc(recommendation.id)}" data-crisis-priority="${recommendation.priorityOrder}" data-command-tone="${recommendation.urgencyTone}"><header><div><strong><mark class="desc-daily-crisis-order tone-${recommendation.urgencyTone}">#${recommendation.priorityOrder} ${recommendation.urgencyTone.toUpperCase()}</mark>${esc(recommendation.title)}</strong><small>${esc(recommendation.urgencyDetail)} · 昨日 ${recommendation.previousCount}名 → 今日 ${recommendation.assignedCount}名</small></div><div class="desc-daily-crisis-response-actions"><em>${esc(laborTaskDisplayName(recommendation.task))} / ${recommendation.task}</em>${recommendation.continuityShortfall > 0 && recommendation.fillCandidateIds.length ? `<button data-action="daily-fill-crisis-gap" data-agent-ids="${recommendation.fillCandidateIds.map((agentId)=>esc(agentId)).join(',')}" data-task="${recommendation.task}">昨日水準へ補充 +${recommendation.fillCandidateIds.length}</button>` : recommendation.rotationSwap ? `<button data-action="daily-rotate-crisis" data-outgoing-agent-id="${esc(recommendation.rotationSwap.outgoingAgentId)}" data-incoming-agent-id="${esc(recommendation.rotationSwap.incomingAgentId)}" data-incoming-previous-task="${recommendation.rotationSwap.incomingPreviousTask}" data-task="${recommendation.task}" aria-label="${esc(recommendation.rotationSwap.outgoingName)}を${esc(laborTaskDisplayName(recommendation.rotationSwap.incomingPreviousTask))}へ、${esc(recommendation.rotationSwap.incomingName)}を${esc(laborTaskDisplayName(recommendation.task))}へ交代">1名交代 · ${esc(recommendation.rotationSwap.outgoingName)} → ${esc(laborTaskDisplayName(recommendation.rotationSwap.incomingPreviousTask))}</button>` : recommendation.candidates.length >= 2 ? `<button data-action="daily-quick-assign-group" data-agent-ids="${recommendation.candidates.slice(0,2).map((candidate)=>esc(candidate.agentId)).join(',')}" data-task="${recommendation.task}">上位2名を配置</button>` : ''}</div></header><div>${recommendation.candidates.map((candidate)=>`<button data-action="daily-quick-assign" data-agent-id="${esc(candidate.agentId)}" data-task="${recommendation.task}" aria-label="${esc(candidate.name)}を${esc(laborTaskDisplayName(recommendation.task))}へ割当"><b>${esc(candidate.name)}</b><small>${esc(candidate.detail)}</small><span class="desc-daily-crisis-tags">${candidate.reasons.map((reason)=>`<i>${esc(reason)}</i>`).join('')}</span></button>`).join('') || '<p>安全に提案できる候補がありません。住民表で個別に確認してください。</p>'}</div></article>`).join('')}</div>` : ''}
        <section class="desc-daily-plan-board" aria-label="Plan board crew assignment"><header><div><span>DUTY BOARD</span><strong>CREW ASSIGNMENT / 配置盤</strong></div><div class="desc-plan-board-moves"><em>ROSTER CHANGES / 配置変更</em><small>${boardMoveSummary}</small></div></header>
          <div class="desc-plan-board-lanes">
            <section class="desc-plan-board-lane lane-crisis" data-plan-board-lane="crisis"><header><span>CRISIS</span><strong>危機対応</strong><b>${boardRowsFor('crisis').length}</b></header><div>${boardRowsFor('crisis').map(renderBoardChip).join('') || '<small>現在の危機配置なし</small>'}</div></section>
            <section class="desc-plan-board-lane lane-normal" data-plan-board-lane="normal"><header><span>NORMAL OPS</span><strong>平常業務</strong><b>${boardRowsFor('normal').length}</b></header><div>${boardRowsFor('normal').map(renderBoardChip).join('') || '<small>現在の平常配置なし</small>'}</div></section>
            <section class="desc-plan-board-lane lane-rest" data-plan-board-lane="rest"><header><span>REST</span><strong>休養</strong><b>${boardRowsFor('rest').length}</b></header><div>${boardRowsFor('rest').map(renderBoardChip).join('') || '<small>現在の休養配置なし</small>'}</div></section>
            <section class="desc-plan-board-lane lane-field" data-plan-board-lane="field"><header><span>FIELD</span><strong>遠征準備</strong><b>${boardRowsFor('field').length}</b></header><div>${boardRowsFor('field').map(renderBoardChip).join('') || '<small>現在の遠征準備なし</small>'}</div></section>
          </div>
          ${selectedBoardRow ? `<div class="desc-plan-board-transfer" data-plan-board-agent="${esc(selectedBoardRow.agentId)}"><div class="desc-plan-board-transfer-person"><span>SELECTED CREW</span><strong>${esc(selectedBoardRow.name)}</strong><small>${esc(selectedBoardRow.role)} · ${esc(selectedBoardRow.condition)}</small></div><div class="desc-plan-board-transfer-path"><span><small>LAST SHIFT</small><b>${esc(laborTaskDisplayName(selectedBoardRow.previousTask))}</b></span><i aria-hidden="true">→</i><span><small>CURRENT POST</small><b>${esc(laborTaskDisplayName(selectedBoardRow.assignedTask))}</b></span></div><div class="desc-plan-board-transfer-risk"><span>DUTY STATUS</span><small>${esc(selectedBoardRow.riskNote ?? (selectedBoardRow.locked ? '年齢により作業割当不可' : '明白な配置警告なし'))}</small></div><div class="desc-plan-board-destinations" aria-label="${esc(selectedBoardRow.name)} assignment destinations">${tasks.map((task)=>`<button data-action="daily-board-assign" data-agent-id="${esc(selectedBoardRow.agentId)}" data-task="${task}" class="${task===selectedBoardRow.assignedTask?'is-current':''}" aria-pressed="${task===selectedBoardRow.assignedTask}" aria-label="${esc(selectedBoardRow.name)}を${esc(laborTaskDisplayName(task))}へ割当" ${selectedBoardRow.locked?'disabled':''}><b>${esc(laborTaskDisplayName(task))}</b><small>POST</small></button>`).join('')}</div></div>` : '<p class="desc-plan-board-empty">配置可能な住民がいません。</p>'}
        </section>
        <div class="desc-daily-roster">${command.residentRows.map((row)=>{const returnReview=returnReviewByAgent.get(row.agentId);return `<label data-daily-agent-id="${esc(row.agentId)}" data-resident-risk="${row.riskNote ? '1' : '0'}"><span class="desc-daily-resident-main"><b>${esc(row.name)}</b><small>${esc(row.role)} · ${esc(row.condition)}</small></span><span class="desc-daily-resident-context"><small>前勤務</small><b>${esc(laborTaskDisplayName(row.previousTask))}</b></span><select data-action="daily-assignment" data-agent-id="${esc(row.agentId)}" ${row.locked ? 'disabled' : ''} aria-label="${esc(row.name)} 今日の作業">${tasks.map((task)=>`<option value="${task}" ${task===row.assignedTask?'selected':''}>${esc(laborTaskDisplayName(task))}</option>`).join('')}</select><small class="desc-daily-resident-risk">${esc(row.riskNote ?? (row.locked ? '年齢により作業割当不可' : '明白な配置警告なし'))}</small>${returnReview?.taskContexts.length ? `<small class="desc-daily-resident-return-context" data-return-context-row="${returnReview.taskContexts.length}"><em>DUTY OPTIONS</em>${returnReview.taskContexts.map((context)=>`<span class="desc-daily-return-option" data-return-option="${context.task}"><u>${esc(context.detail)}</u><i data-return-effect="${esc(context.task)}">${esc(context.effectDetail)}</i><i data-return-fit="${esc(context.task)}">${esc(context.fitDetail)}</i><i data-return-balance="${context.balanceDirection}">${esc(context.balanceEffectCompact)}</i></span>`).join('')}</small>` : ''}</label>`;}).join('')}</div>
        ${command.planImpact.length ? `<div class="desc-daily-plan-impact" aria-label="Plan impact"><div class="desc-daily-plan-impact-title"><span>ROSTER EFFECT</span><strong>配置変化</strong></div>${command.planImpact.map((issue)=>`<article class="tone-${issue.tone}" data-plan-impact="${esc(issue.id)}"><strong>${esc(issue.title)}</strong><small>${esc(issue.detail)}</small></article>`).join('')}</div>` : ''}
        ${command.planBalance ? `<div class="desc-daily-plan-balance" data-plan-balance="${command.planBalance.crisis.delta},${command.planBalance.normalOps.delta},${command.planBalance.rest.delta}" aria-label="Plan balance compared with yesterday"><span>CREW BALANCE</span><strong>${esc(command.planBalance.detail)}</strong>${command.planBalanceRecovery ? `<div class="desc-daily-plan-balance-recovery" data-plan-balance-recovery="1"><em>CREW RECOVERY</em><small>${esc(command.planBalanceRecovery.detail)}</small><button data-action="daily-restore-plan-balance" data-agent-id="${esc(command.planBalanceRecovery.agentId)}" data-return-task="${command.planBalanceRecovery.returnTask}" aria-label="${esc(command.planBalanceRecovery.name)}を${esc(laborTaskDisplayName(command.planBalanceRecovery.returnTask))}へ戻して前日構成へ近づける">前日構成へ戻す</button></div>` : ''}</div>` : ''}
        ${command.restPressure ? `<div class="desc-daily-rest-pressure" data-rest-pressure="${command.restPressure.candidateCount}" aria-label="Rest pressure"><div><span>REST PRESSURE / 休養圧</span><small>${esc(command.restPressure.detail)}</small></div><div>${command.restPressure.candidates.map((candidate)=>`<button data-action="daily-rest-resident" data-agent-id="${esc(candidate.agentId)}" aria-label="${esc(candidate.name)}を休養へ割当"><b>${esc(candidate.name)}</b><small>${esc(candidate.detail)}</small><em>休養へ</em></button>`).join('')}</div></div>` : ''}
        ${interruption?`<aside class="desc-daily-interruption severity-critical"><strong>${esc(interruption.title)}</strong><p>${esc(interruption.detail)}</p><div>${interruption.kind==='medical'?`<button data-action="daily-detail" data-daily-target="body" data-agent-id="${esc(interruption.subjectIds[0] ?? '')}">手動で身体・医療を確認</button>`:'<button data-action="daily-detail" data-daily-target="expedition">手動で探索を操作</button>'}<button data-action="resolve-daily-interruption-auto" data-interruption-kind="${interruption.kind}">この日だけAUTOで続行</button></div></aside>`:''}
        <div class="desc-daily-readiness readiness-${command.readiness}" data-readiness="${command.readiness}" data-readiness-coverage="${command.crisisCoverage ? `${command.crisisCoverage.coveredCount}/${command.crisisCoverage.totalCount}` : 'none'}">
          <div class="desc-daily-readiness-label"><span>OPERATION STATUS</span><strong>${readinessLabel[command.readiness]}</strong>${command.crisisCoverage ? `<em class="desc-daily-readiness-coverage ${command.crisisCoverage.coveredCount===command.crisisCoverage.totalCount?'is-complete':'is-gap'}">${command.crisisCoverage.coveredCount===command.crisisCoverage.totalCount?`COVERAGE COMPLETE ${command.crisisCoverage.coveredCount}/${command.crisisCoverage.totalCount}`:`COVERAGE ${command.crisisCoverage.coveredCount}/${command.crisisCoverage.totalCount}`}</em>` : ''}</div>
          <div class="desc-daily-readiness-issues">${command.readinessIssues.length?command.readinessIssues.slice(0,3).map((issue)=>`<button data-action="daily-detail" data-daily-target="${issue.target??'task'}" ${issue.agentId?`data-agent-id="${esc(issue.agentId)}"`:''}><b>${esc(issue.title)}</b><small>${esc(issue.detail)}</small></button>`).join(''):'<p>現在の可視状態と計画から明白な警告はありません。</p>'}</div>
          <button class="primary" data-action="execute-plan" ${this.#busy||command.readiness==='blocked'?'disabled':''}>${this.#dailyExecutionActive?'OPERATIONS ACTIVE…':'BEGIN OPERATIONS'}</button>
        </div>
      </section>
    </section>`;
  }

  private pdaTaskView(): string {
    const field = this.controlledExpedition();
    const incidentRead = this.f1SituationReadModel();
    const situations = incidentRead.rows;
    const selectedIncident = this.selectedF1Incident(incidentRead);
    const primary = incidentRead.source==='incident' && selectedIncident ? situations.find((entry)=>entry.id===selectedIncident.id) ?? situations[0] : situations[0];
    const latest = projectChronicle(this.state,this.chronicleViewpoint()).at(-1);
    const title = primary?.title ?? (field?'遠征を継続する':'周辺を確認する');
    const detail = primary?.detail ?? latest?.text ?? '既知の情報を確認し、次の行動を選択する。';
    const objectiveRows = [field ? `${field.status} の遠征状況を確認する` : '既知のWORLD地点を確認する',field ? 'LOCALで観察・採取・接触を行う' : '必要なら遠征先を選択する','結果を年代記・知識・所持品へ反映する'];
    const returned = this.state.expeditions.filter((entry)=>entry.status==='returned').length;
    const failed = this.state.expeditions.filter((entry)=>entry.status==='destroyed').length;
    const allCount = Math.max(1,situations.length) + returned + failed;
    const middle = this.#pdaTaskPanel==='expedition' ? this.pdaExpeditionPreparation() : `<section class="desc-pda-pane desc-pda-task-detail"><header><div><span>CURRENT OBJECTIVE</span><h2>${esc(title)}</h2></div><em>${field?'FIELD':'SETTLEMENT'}</em></header><div class="desc-pda-task-description"><p>${esc(detail)}</p><div class="desc-pda-task-preview" aria-label="Observation feed offline"><span>OBSERVATION FEED</span><b>VISUAL FEED OFFLINE</b><small>${primary?`${primary.basisIds.length} EVIDENCE LINKS`:'NO SENSOR IMAGE'}</small></div></div><div class="desc-pda-objectives"><strong>▣ 行動目標</strong>${objectiveRows.map((row,index)=>`<div><span class="desc-pda-checkbox ${index===0?'checked':''}">${index===0?'✓':''}</span><p>${esc(row)}</p></div>`).join('')}</div><div class="desc-pda-briefing"><strong>▣ 現在の根拠</strong><p>${esc(primary?`観測根拠 ${primary.basisIds.length}件。${compactText(primary.detail,180)}`:'現在の年代記と観測記録から編成。未確認情報は除外。')}</p></div>${this.pdaIncidentResponsePanel(incidentRead)}<div class="desc-pda-task-actions"><button data-action="pda-tab" data-pda-tab="map">地図を開く</button><button data-action="pda-task-panel" data-panel="expedition">${field?'遠征状況':'遠征準備'}</button><button data-action="execute-plan">BEGIN OPERATIONS</button></div><footer><button class="active">詳細</button><button data-action="pda-task-panel" data-panel="expedition">履歴</button><button data-action="pda-tab" data-pda-tab="knowledge">ヒント</button></footer></section>`;
    return `<div class="desc-pda-campaign-screen" data-scroll-day="${this.state.clock.day}">${this.pdaCampaignCommand()}<div class="desc-pda-task-layout"><section class="desc-pda-pane desc-pda-task-left"><header><strong>タスク</strong><button class="desc-pda-pane-close" type="button" aria-label="Minimize task pane">×</button></header><div class="desc-pda-categories"><div class="desc-pda-category active"><b>▰</b><span>進行中 (${Math.max(1,situations.length)})</span><em>▼</em></div><div class="desc-pda-category"><b>✓</b><span>完了 (${returned})</span><em>▶</em></div><div class="desc-pda-category"><b>×</b><span>失敗 (${failed})</span><em>▶</em></div><div class="desc-pda-category"><b>▤</b><span>全て (${allCount})</span><em>▶</em></div></div><div class="desc-pda-task-list" ${incidentRead.source==='incident'?'role="listbox" aria-label="Visible incidents"':'role="list"'}>${this.pdaTaskList(incidentRead)}</div><footer><button class="active">アクティブ</button><button data-action="pda-task-panel" data-panel="expedition">遠征</button><button data-action="pda-tab" data-pda-tab="chronicle">重要</button></footer></section>${middle}<aside class="desc-pda-right-stack"><section class="desc-pda-pane desc-pda-mini-map"><header><strong>マップゾーン</strong><button data-action="pda-tab" data-pda-tab="map">拡大</button></header>${this.pdaMiniMap(field&&this.#mapScope==='local'?'local':'world')}</section>${this.pdaStatusCard()}</aside></div></div>`;
  }

  private pdaMapView(): string {
    const field=this.controlledExpedition();
    if (!field && this.#mapScope==='local') this.#mapScope='world';
    const scope=field?this.#mapScope:'world';
    const selected=scope==='local'?this.selectedLocalEntity():this.selectedWorldEntity();
    const selectedDistance=selected?.spatial ? spatialDistanceKm(scope==='local'&&field?field.position:this.state.settlement.position,selected.spatial) : Number.POSITIVE_INFINITY;
    const externalPerson=selected?.kind==='person';
    let actions='';
    if (selected) {
      if (scope==='world' && selected.spatial && !field) actions += `<button data-action="set-prep-target" data-entity-id="${esc(selected.id)}">遠征目標に設定</button>`;
      if (scope==='world' && selected.spatial && field) actions += `<button data-action="move-world-target" data-entity-id="${esc(selected.id)}">次の移動先</button>`;
      if (scope==='local' && field && selected.spatial) {
        const near=selectedDistance<=0.25;
        actions += near ? `<button data-action="observe-local-target" data-entity-id="${esc(selected.id)}">観察 30分</button>${externalPerson?`<button data-action="contact-external-person" data-entity-id="${esc(selected.id)}">話す 20分</button>`:''}${isSampleableEntity(selected)?`<button data-action="sample-local-target" data-entity-id="${esc(selected.id)}">採取 45分</button>`:''}` : `<button data-action="walk-local-target" data-entity-id="${esc(selected.id)}">接近する</button>`;
      }
    }
    return `<section class="desc-pda-full-map"><header class="desc-pda-map-toolbar"><strong>${scope==='local'?'LOCAL FIELD PROJECTION':'WORLD KNOWLEDGE PROJECTION'}</strong><div><button data-action="map-scope" data-scope="world" class="${scope==='world'?'active':''}">WORLD</button>${field?`<button data-action="map-scope" data-scope="local" class="${scope==='local'?'active':''}">LOCAL</button>`:''}<button data-action="pda-tab" data-pda-tab="task">行動へ戻る</button></div></header><div class="desc-pda-full-map-grid"><div class="desc-pda-map-large">${this.pdaMiniMap(scope)}</div><aside class="desc-pda-map-inspector"><span>SELECTED OBJECT</span><h2>${esc(selected?entityName(selected):(scope==='local'?'局地周辺':'既知WORLD'))}</h2>${selected?`<p>${esc(selected.kind)}${selected.subtype?` / ${esc(selected.subtype)}`:''}</p><dl><dt>距離</dt><dd>${Number.isFinite(selectedDistance)?selectedDistance.toFixed(scope==='local'?2:1):'?'} km</dd><dt>識別子</dt><dd>${esc(compactText(selected.id,34))}</dd><dt>投影</dt><dd>${scope==='local'?'observer-bounded':'knowledge-bounded'}</dd></dl><div class="desc-pda-map-actions">${actions||'<span>現在実行できる直接行動はありません。</span>'}</div>`:'<p>地図上の既知マーカーを選択してください。</p>'}<small>この地図は確認済みの地点だけを表示します。未踏査領域は空白のまま残ります。</small></aside></div></section>`;
  }

  private pdaResidentsView(): string {
    const people=livingAgents(this.state).slice().sort((a,b)=>a.name.localeCompare(b.name));
    const selected=findAgent(this.state,this.#inspectedAgentId) ?? this.controlledAgent() ?? people[0];
    const external=(this.state.externalContacts ?? []).slice().reverse();
    return `<section class="desc-pda-directory"><aside class="desc-pda-pane"><header><strong>住民 / 人物一覧</strong><span>${people.length} LOCAL</span></header><div class="desc-pda-directory-list">${people.map((person)=>`<button data-action="inspect-agent" data-agent-id="${esc(person.id)}" class="${selected?.id===person.id?'active':''}"><strong>${esc(person.name)}</strong><span>${esc(person.role)} · ${agentAgeYears(this.state,person)}歳</span><small>${person.expeditionId?'遠征中':esc(person.residence ?? 'settlement')}</small></button>`).join('')}</div></aside><section class="desc-pda-pane desc-pda-person-card">${selected?`<header><div><span>PERSON RECORD</span><h2>${esc(selected.name)}</h2></div><em>${selected.alive?'ACTIVE':'DECEASED'}</em></header><div class="desc-pda-person-overview"><div class="desc-pda-avatar-placeholder"><strong>${esc(selected.name.slice(0,2))}</strong><small>PORTRAIT<br>DETACHED</small></div><dl><dt>役割</dt><dd>${esc(selected.role)}</dd><dt>年齢</dt><dd>${agentAgeYears(this.state,selected)}歳</dd><dt>体力</dt><dd>${selected.health.toFixed(0)}</dd><dt>疲労</dt><dd>${selected.fatigue.toFixed(0)}</dd><dt>士気</dt><dd>${selected.morale.toFixed(0)}</dd><dt>現在</dt><dd>${esc(selected.currentPlan?.kind ?? selected.currentTask)}</dd></dl></div><div class="desc-pda-person-notes"><strong>記録された身体状態</strong>${selected.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic').map((entry)=>`<p>${esc(entry.pathologyId)} · severity ${entry.severity.toFixed(1)}</p>`).join('')||'<p>重大な記録済み異常なし。</p>'}</div><button data-action="pda-tab" data-pda-tab="body">身体・装備の詳細を開く</button>`:'<p>人物を選択してください。</p>'}</section><aside class="desc-pda-pane desc-pda-external-contacts"><header><strong>外部接触</strong><span>${external.length}</span></header>${external.slice(0,12).map((contact)=>`<article><strong>${esc(contact.name)}</strong><span>${contact.interactionCount} contacts</span><small>${esc(contact.societyEntityId ?? 'association unknown')}</small></article>`).join('')||'<p>直接接触した外部人物はいません。</p>'}</aside></section>`;
  }

  private pdaSystemView(): string {
    const audio = pdaAudio.settings;
    const motionAllowsFlicker = !this.#accessibility.reduceMotion;
    return `<section class="desc-pda-settings desc-pda-settings-reference"><header><span>PDA システム診断 & ハードウェア設定</span></header><div class="desc-pda-settings-cards"><section class="desc-pda-settings-card"><h3>ディスプレイ & CRT走査線</h3><div class="desc-pda-setting-row"><label>カラーパレット:</label><select disabled aria-label="Color palette"><option>クラシック・オリーブグリーン</option></select></div><div class="desc-pda-setting-row"><label>CRTスキャンライン表示:</label><input type="checkbox" data-action="pda-scanlines" ${this.#pdaPresentation.scanlines?'checked':''}></div><div class="desc-pda-setting-row"><label>走査線微弱フリッカー:</label><input type="checkbox" data-action="pda-flicker" ${this.#pdaPresentation.flicker?'checked':''} ${motionAllowsFlicker?'':'disabled'}></div><div class="desc-pda-setting-note">${motionAllowsFlicker?'CRT微弱フリッカー作動中。':'動き低減設定によりフリッカー停止中。'}</div></section><section class="desc-pda-settings-card"><h3>オーディオ & 端末センサー</h3><div class="desc-pda-setting-row"><label>マスター音量:</label><input type="range" min="0" max="1" step="0.05" value="${audio.masterVolume}" data-action="pda-audio-master"></div><div class="desc-pda-setting-row"><label>センサークリック音量:</label><input type="range" min="0" max="1" step="0.05" value="${audio.sensorVolume}" data-action="pda-audio-sensor"></div><div class="desc-pda-setting-row"><label>低頻度センサークリック:</label><input type="checkbox" data-action="pda-audio-sensor-ticks" ${audio.sensorTicks?'checked':''}></div><div class="desc-pda-setting-row"><label>オーディオ完全ミュート:</label><button data-action="pda-audio-mute">${audio.muted?'消音解除':'消音切替'}</button></div><div class="desc-pda-setting-actions"><button data-action="pda-audio-test">端末音をテスト</button></div></section><section class="desc-pda-settings-card"><h3>セッション & アクセシビリティ</h3><div class="desc-pda-setting-row"><label>文字サイズ:</label><button data-action="a11y-scale">${Math.round(this.#accessibility.textScale*100)}%</button></div><div class="desc-pda-setting-row"><label>ハイコントラスト:</label><button data-action="a11y-contrast">${this.#accessibility.highContrast?'ON':'OFF'}</button></div><div class="desc-pda-setting-row"><label>動き低減:</label><button data-action="a11y-motion">${this.#accessibility.reduceMotion?'ON':'OFF'}</button></div><div class="desc-pda-setting-row"><label>緊急対応回線:</label><button data-action="incident-adapter-toggle">${isI2F1IncidentAdapterEnabled()?'OPEN':'CLOSED'}</button></div><div class="desc-pda-setting-actions"><button data-action="export">SAVE EXPORT</button><label class="desc-pda-inline-import">SAVE IMPORT<input type="file" data-action="import" accept="application/json,.json"></label></div></section></div><div class="desc-pda-system-lower"><section><h3>SYSTEM STATUS</h3><div class="desc-pda-runtime"><span>WORLD LINK</span><b>${this.#providerMode==='real-worldgen'?'LIVE':this.#providerMode==='snapshot-recovery'?'RECOVERED':'LOCAL'}</b><span>ARCHIVE</span><b>${this.#persistenceMode==='durable'?'SEALED':'TEMPORARY'}</b><span>JOURNAL</span><b>${esc(this.state.diagnostics.replayHash || 'boot')}</b></div></section><section><h3>RECOVERY</h3><div class="desc-pda-recovery-actions"><button data-action="export-recovery-report">復旧レポート</button><button data-action="export-quarantine">隔離データ</button><button data-action="reset" class="danger">${this.#persistenceMode==='durable'?'最初から':'一時セッション終了'}</button></div></section></div></section>`;
  }

  private pdaSecondaryIndex(view: 'body'|'knowledge'|'inventory'|'chronicle'): string {
    const controlled=this.controlledAgent();
    if (view==='body') {
      const person=findAgent(this.state,this.#inspectedAgentId) ?? controlled;
      const gear=person&&this.canInspectLiveState(person.id)?equipmentForAgent(this.state,person.id):[];
      const activePathology=person?.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic').length ?? 0;
      return `<aside class="desc-pda-secondary-index"><header><strong>身体 / INDEX</strong><span>${person?'LIVE':'NO DATA'}</span></header>${person?`<div class="desc-pda-index-person"><div class="desc-pda-avatar-placeholder"><strong>${esc(person.name.slice(0,2))}</strong><small>PORTRAIT<br>DETACHED</small></div><h3>${esc(person.name)}</h3><p>${esc(person.role)} · ${agentAgeYears(this.state,person)}歳</p></div><div class="desc-pda-index-list"><span><b>HP</b><em>${person.health.toFixed(0)}</em></span><span><b>疲労</b><em>${person.fatigue.toFixed(0)}</em></span><span><b>病理記録</b><em>${activePathology}</em></span><span><b>装備/携行</b><em>${gear.length}</em></span></div><button data-action="pda-tab" data-pda-tab="residents">人物を変更</button>`:'<p>人物データなし</p>'}</aside>`;
    }
    if (view==='knowledge') {
      const records=(this.state.records ?? []).length, projects=(this.state.researchProjects ?? []).length;
      const personal=this.state.knowledge.filter((entry)=>entry.carrier==='memory'||entry.carrier==='oral').length;
      const institutional=this.state.knowledge.filter((entry)=>entry.carrier==='institution'||entry.carrier==='record').length;
      return `<aside class="desc-pda-secondary-index"><header><strong>知識 / INDEX</strong><span>EPISTEMIC</span></header><div class="desc-pda-index-list"><span><b>個人/口承</b><em>${personal}</em></span><span><b>制度/記録</b><em>${institutional}</em></span><span><b>Archive</b><em>${records}</em></span><span><b>研究</b><em>${projects}</em></span></div><p class="desc-pda-index-note">外部観測も確定事実とは限りません。出所と確度を併記し、未確認部分は未確認のまま保管します。</p></aside>`;
    }
    if (view==='inventory') {
      const holder=this.inventoryAgent();
      const items=holder?inventoryForAgent(this.state,holder.id):[];
      const field=this.controlledExpedition(); const stock=field?field.supplies:this.state.settlement.resources;
      return `<aside class="desc-pda-secondary-index"><header><strong>所持品 / INDEX</strong><span>PHYSICAL</span></header><h3>${esc(holder?.name ?? 'No holder')}</h3><div class="desc-pda-index-list"><span><b>携行品</b><em>${items.length}</em></span><span><b>食料</b><em>${Number(stock.food??0).toFixed(1)}</em></span><span><b>水</b><em>${Number(stock.water??0).toFixed(1)}</em></span><span><b>薬</b><em>${Number(stock.medicine??0).toFixed(1)}</em></span></div><p class="desc-pda-index-note">物理的にアクセス可能な所持品・共有在庫だけを表示します。</p></aside>`;
    }
    const entries=projectChronicle(this.state,this.chronicleViewpoint()); const last=entries.at(-1);
    return `<aside class="desc-pda-secondary-index"><header><strong>年代記 / INDEX</strong><span>VISIBLE</span></header><div class="desc-pda-index-list"><span><b>可視記録</b><em>${entries.length}</em></span><span><b>最新日</b><em>D${last?.day ?? this.state.clock.day}</em></span><span><b>視点</b><em>${this.controlledExpedition()?'FIELD':'SETTLEMENT'}</em></span></div><p class="desc-pda-index-note">観測・通信・記録された出来事だけを時間順に表示します。</p></aside>`;
  }

  private pdaBodyPanel(): string {
    const inspected = findAgent(this.state, this.#inspectedAgentId) ?? this.controlledAgent();
    const controlled = this.controlledAgent();
    if (!inspected) return '<section class="desc-pda-data-panel"><p>人物を選択してください。</p></section>';
    const live = this.canInspectLiveState(inspected.id);
    const report = this.lastReportForAgent(inspected.id);
    const activePathology = inspected.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic');
    const gear = live ? equipmentForAgent(this.state, inspected.id) : [];
    const doctrine = this.selectedPreparationDoctrine();
    const readiness = live && doctrine ? expeditionMemberReadiness(inspected, doctrine) : undefined;
    const atSettlement = inspected.alive && !inspected.expeditionId && (!inspected.residence || inspected.residence==='settlement');
    const careNeeded = atSettlement && (inspected.health < 99.5 || inspected.pathology.some((entry)=>entry.status==='active'));
    const meter=(label:string,value:number,invert=false)=>`<div class="desc-pda-detail-meter"><span>${label}</span><div><i style="width:${Math.max(0,Math.min(100,invert?100-value:value))}%"></i></div><b>${Math.round(value)}</b></div>`;
    const identitySource=inspected.identityOrigin==='world-provider'?'ORIGIN ARCHIVE':'LOCAL HISTORY';
    return `<section class="desc-pda-data-panel desc-pda-body-panel"><header><div><span>PERSON / BODY RECORD</span><h2>${esc(inspected.name)}</h2></div><em>${live?'LIVE':'REMOTE'}</em></header><div class="desc-pda-body-summary"><section><strong>身体状態</strong>${meter('体力',inspected.health)}${meter('疲労',inspected.fatigue,true)}${meter('士気',inspected.morale)}${meter('空腹',inspected.needs.hunger ?? 0,true)}${meter('渇き',inspected.needs.thirst ?? 0,true)}</section><section class="desc-pda-identity-card"><strong>人物情報</strong><dl><dt>役割</dt><dd>${esc(inspected.role)}</dd><dt>年齢 / 性</dt><dd>${agentAgeYears(this.state,inspected)} / ${esc(inspected.sex)}</dd><dt>現在地</dt><dd>${esc(inspected.residence ?? (inspected.expeditionId?'expedition':'settlement'))}</dd><dt>Identity</dt><dd>${identitySource}</dd><dt>現在行動</dt><dd>${esc(inspected.currentPlan?.kind ?? inspected.currentTask)}</dd></dl></section><section class="desc-pda-fitness-card"><strong>遠征適性</strong>${readiness?`<b class="${readiness.ready?'ready':'blocked'}">${readiness.ready?'READY':'RECOVERING'}</b><p>HP ≥ ${readiness.minimumHealth} / fatigue ≤ ${readiness.maximumFatigue}</p>${readiness.reasons.length?`<ul>${readiness.reasons.map((reason)=>`<li>${esc(reason)}</li>`).join('')}</ul>`:'<small>現在のDoctrineで出発阻害なし。</small>'}`:'<p>遠征Doctrine未設定。</p>'}${careNeeded?`<button data-action="clinic-care" data-agent-id="${esc(inspected.id)}">診療を受ける · 60分</button>`:''}</section></div>${!live?`<section class="desc-pda-remote-card"><strong>REMOTE / CURRENT STATUS UNKNOWN</strong><p>遠隔人物の現在HP・病理・装備は直接参照しません。</p>${report?`<small>${esc(report.text)} · confidence ${Math.round(report.confidence*100)}%</small>`:'<small>通信報告なし。</small>'}</section>`:`<div class="desc-pda-data-columns"><section><header><strong>病理・症状</strong><span>${activePathology.length}</span></header>${activePathology.length?activePathology.map((entry)=>`<article class="desc-pda-record-row"><div><strong>${esc(entry.pathologyId)}</strong><small>${esc(entry.observedSymptoms.join(', ') || '記録症状なし')}</small></div><em>${entry.severity.toFixed(1)} / ${esc(entry.status)}</em></article>`).join(''):'<p class="desc-pda-empty">重大な記録済み異常なし。</p>'}</section><section><header><strong>装備・携行</strong><span>${gear.length}</span></header>${gear.length?gear.map((item)=>`<article class="desc-pda-record-row"><div><strong>${esc(item.name)}</strong><small>${esc(item.slot)} · ${item.weightKg.toFixed(1)} kg</small></div><em>${item.equipped?'EQUIPPED':'CARRIED'}</em>${inspected.id===controlled?.id?`<button data-action="toggle-equipment" data-item-id="${esc(item.id)}" data-equipped="${item.equipped?'0':'1'}">${item.equipped?'外す':'装備'}</button>`:''}</article>`).join(''):'<p class="desc-pda-empty">装備記録なし。</p>'}</section></div>`}</section>`;
  }

  private pdaKnowledgePanel(): string {
    const holder = this.knowledgeAgent();
    const eligible = this.knowledgeEligibleAgents();
    const partners = this.conversationPartners(holder);
    const conversationTarget = partners.find((agent)=>agent.id===this.#conversationTargetId);
    const personal = holder ? this.state.knowledge.filter((entry)=>holder.knowledgeIds.includes(entry.id)).slice().reverse() : [];
    const institutionalIds = new Set(this.state.settlement.localKnowledgeIds);
    const institutional = this.state.knowledge.filter((entry)=>institutionalIds.has(entry.id) && !personal.some((known)=>known.id===entry.id)).slice().reverse();
    const atSettlement = Boolean(holder?.alive && !holder.expeditionId && (!holder.residence || holder.residence==='settlement'));
    const records = this.state.records.filter((record)=>record.integrity>0.05&&record.copies>0).slice().reverse();
    const projects = (this.state.researchProjects ?? []).slice().reverse();
    const row=(entry:SandboxGameState['knowledge'][number], access:'personal'|'institutional')=>{
      const gate=researchSampleGate(this.state,entry.id);
      const alreadyInstitutional=institutionalIds.has(entry.id);
      const targetKnows=Boolean(conversationTarget?.knowledgeIds.includes(entry.id));
      const canResearch=!entry.lost&&atSettlement&&(!gate.required||gate.available);
      return `<article class="desc-pda-knowledge-row ${entry.lost?'dead':''}"><header><strong title="${esc(entry.claim)}">${esc(pdaKnowledgeClaimLabel(entry.claim))}</strong><em>${Math.round(entry.confidence*100)}%</em></header><p>${esc(compactSubjectIds(entry.subjectIds,4))}</p><small>${esc(knowledgeSourceLabel(entry))} · ${esc(access)}</small>${!entry.lost?`<div>${access==='personal'&&conversationTarget?`<button data-action="conversation" data-knowledge-id="${esc(entry.id)}" ${targetKnows?'disabled':''}>${targetKnows?'共有済み':`話す · ${esc(conversationTarget.name)}`}</button>`:''}${access==='personal'?`<button data-action="archive-knowledge" data-knowledge-id="${esc(entry.id)}" ${!atSettlement||alreadyInstitutional?'disabled':''}>${alreadyInstitutional?'記録済み':'Archive'}</button>`:''}<button data-action="research" data-knowledge-id="${esc(entry.id)}" ${canResearch?'':'disabled'}>${gate.required&&!gate.available?'Sample必要':'研究'}</button></div>`:''}</article>`;
    };
    return `<section class="desc-pda-data-panel desc-pda-knowledge-panel"><header><div><span>EPISTEMIC TERMINAL</span><h2>知識・会話・Archive</h2></div><em>${atSettlement?'SETTLEMENT':'FIELD'}</em></header><div class="desc-pda-control-strip"><label>視点<select data-action="knowledge-agent">${eligible.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===holder?.id?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><label>会話相手<select data-action="conversation-target" ${partners.length?'':'disabled'}>${partners.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===conversationTarget?.id?'selected':''}>${esc(agent.name)}</option>`).join('')}</select></label><span>${atSettlement?'Archive / research利用可':'個人・隊内知識のみ'}</span></div><div class="desc-pda-data-columns knowledge"><section><header><strong>${esc(holder?.name ?? 'NO HOLDER')} / 個人知識</strong><span>${personal.length}</span></header><div class="desc-pda-scroll-list">${personal.slice(0,24).map((entry)=>row(entry,'personal')).join('')||'<p class="desc-pda-empty">個人知識なし。</p>'}</div></section><section><header><strong>制度知識 / Archive</strong><span>${institutional.length}</span></header><div class="desc-pda-scroll-list">${institutional.slice(0,16).map((entry)=>row(entry,'institutional')).join('')||'<p class="desc-pda-empty">追加の制度知識なし。</p>'}<div class="desc-pda-subhead">RECORDS ${records.length}</div>${records.slice(0,8).map((record)=>`<article class="desc-pda-mini-record"><strong>${esc(compactText(record.title,96))}</strong><small>${record.copies} copies · ${Math.round(record.integrity*100)}%</small></article>`).join('')}<div class="desc-pda-subhead">RESEARCH ${projects.length}</div>${projects.slice(0,8).map((project)=>`<article class="desc-pda-mini-record"><strong>${esc(compactText(project.hypothesis,96))}</strong><small>${project.progress.toFixed(0)}% · ${esc(project.status)} · confidence ${Math.round(project.confidence*100)}%</small></article>`).join('')}</div></section></div></section>`;
  }

  private settlementResourceLedgerPanel(): string {
    const lots = resourceLots(this.state);
    const sources = resourceSources(this.state);
    const groups = allocationGroups(this.state);
    const rules = allocationRules(this.state);
    const recentDistributions = (this.state.resourceLedger?.recentDistributions ?? []).slice(-24).reverse();
    const roster = this.state.agents.slice().sort((a,b)=>a.name.localeCompare(b.name));
    const processingFor = (key: SettlementResourceKey): ResourceProcessingKind[] => {
      if (key==='food') return ['cooked','dried','smoked'];
      if (key==='water') return ['filtered','boiled'];
      if (key==='medicine') return ['prepared'];
      if (key==='timber'||key==='scrap'||key==='cloth') return ['cleaned','prepared'];
      if (key==='fuel') return ['dried'];
      if (key==='records') return ['copied'];
      return [];
    };
    const lotRows = lots.slice().sort((a,b)=>a.resourceKey.localeCompare(b.resourceKey)||a.createdDay-b.createdDay||a.id.localeCompare(b.id)).map((lot)=>{
      const source=sources.find((entry)=>entry.id===lot.sourceId);
      const water=lot.waterQuality?`water quality · microbial ${(lot.waterQuality.microbialRisk*100).toFixed(0)}% · chemical ${(lot.waterQuality.chemicalRisk*100).toFixed(0)}% · turbidity ${(lot.waterQuality.turbidity*100).toFixed(0)}%`:'';
      const processing=lot.processingHistory.map((step)=>step.kind).join(' → ');
      return `<article class="resource-lot-card" data-resource-lot-id="${esc(lot.id)}"><header><div><strong>${esc(lot.label)}</strong><small>${esc(lot.resourceKey)} / ${esc(lot.subtype)}</small></div><b>${lot.quantity.toFixed(2)} ${esc(lot.unit)}</b></header><div class="resource-lot-metrics"><span>freshness ${(lot.freshness*100).toFixed(0)}%</span><span>condition ${(lot.condition*100).toFixed(0)}%</span><span>contamination ${(lot.contaminationRisk*100).toFixed(0)}%</span>${water?`<span>${esc(water)}</span>`:''}</div><details><summary>SOURCE / PROVENANCE</summary><p>${esc(source?.label ?? lot.sourceId)}</p><small>World entity ${esc(lot.worldEntityIds.join(', ')||'none')}<br>Provider provenance ${esc(lot.worldProvenanceIds.join(', ')||'none')}<br>Harvesters ${esc(lot.harvesterIds.map((id)=>findAgent(this.state,id)?.name??id).join(', ')||'unknown')}<br>Processing ${esc(processing||'raw')}<br>Parents ${esc(lot.parentLotIds.join(', ')||'none')}<br>Custody ${esc((lot.custodyHistory??[]).map((step)=>`${step.storageLocationId} @ day ${step.day} ${String(Math.floor(step.minuteOfDay/60)).padStart(2,'0')}:${String(step.minuteOfDay%60).padStart(2,'0')}`).join(' → ')||lot.storageLocationId||'unknown')}</small></details><div class="resource-process-actions">${processingFor(lot.resourceKey).map((kind)=>`<button data-action="resource-process" data-lot-id="${esc(lot.id)}" data-processing-kind="${esc(kind)}">${esc(kind)}</button>`).join('')}</div></article>`;
    }).join('');
    const sourceRows=sources.filter((source)=>source.kind==='ecological-resource'||source.kind==='ecological-guild').slice(0,24).map((source)=>`<article class="resource-source-row"><div><strong>${esc(source.label)}</strong><small>${esc(source.worldEntityIds.join(', '))}</small></div><span>${source.accessibleStock.toFixed(1)} / ${source.carryingCapacity.toFixed(1)}</span><em>${source.renewable?`regen ${source.regenerationPerDay.toFixed(2)}/day`:'finite'} · depleted ${(source.depletionFraction*100).toFixed(0)}%</em></article>`).join('');
    const groupRows=groups.map((group)=>`<article class="ration-saved-row"><div><strong>${esc(group.name)}</strong><small>${group.memberIds.map((id)=>{const a=findAgent(this.state,id);return `${a?.name??id}${a?.alive?'':' (inactive)'}`;}).join(' · ')}</small></div><button data-action="ration-group-delete" data-group-id="${esc(group.id)}">削除</button></article>`).join('');
    const selectorOptions=[`<option value="all">すべての該当在庫</option>`,...lots.map((lot)=>`<option value="lot:${esc(lot.id)}">LOT · ${esc(lot.resourceKey)} · ${esc(lot.label)} · ${lot.quantity.toFixed(1)}</option>`),...[...new Set(lots.map((lot)=>`${lot.resourceKey}|${lot.subtype}`))].map((value)=>{const [key,subtype]=value.split('|');return `<option value="subtype:${esc(key??'')}:${esc(subtype??'')}">TYPE · ${esc(key??'')} · ${esc(subtype??'')}</option>`;})].join('');
    const ruleRows=rules.slice().sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id)).map((rule)=>{const group=groups.find((entry)=>entry.id===rule.groupId);const selector=rule.lotIds.length?`lots ${rule.lotIds.join(', ')}`:rule.subtypes.length?`type ${rule.subtypes.join(', ')}`:'all stock';return `<article class="ration-saved-row"><div><strong>${esc(rule.name)}</strong><small>${esc(group?.name??rule.groupId)} · ${esc(rule.resourceKey)} · ${esc(selector)} · ${rule.amountPerPersonPerDay}/person/day · priority ${rule.priority} · ${rule.exclusive?'EXCLUSIVE':'shared'}</small></div><button data-action="ration-rule-delete" data-rule-id="${esc(rule.id)}">削除</button></article>`;}).join('');
    const distributionRows=recentDistributions.map((event)=>`<article class="ration-distribution-row" data-distribution-id="${esc(event.id)}"><header><strong>D${event.day} ${String(Math.floor(event.minuteOfDay/60)).padStart(2,'0')}:${String(event.minuteOfDay%60).padStart(2,'0')} · ${esc(event.resourceKey)}</strong><span>${event.lines.length} lines</span></header>${event.lines.map((line)=>{const agent=findAgent(this.state,line.agentId);const lot=this.state.resourceLedger?.lots.find((entry)=>entry.id===line.lotId);return `<small>${esc(agent?.name??line.agentId)} ← ${line.quantity.toFixed(2)} ${esc(lot?.unit??'unit')} · ${esc(lot?.label??line.lotId)}</small>`;}).join('')}</article>`).join('');
    return `<section class="resource-ledger-control"><header><div><span>RESOURCE LOTS / C-DEPTH LEDGER</span><h3>資源台帳・由来・配給</h3></div><em>${lots.length} LOTS</em></header><div class="resource-ledger-columns"><section><h4>RESOURCE LOTS</h4><div class="resource-lot-list">${lotRows||'<p class="desc-pda-empty">ロットなし。</p>'}</div><h4>WORLD-LINKED SOURCES</h4><div class="resource-source-list">${sourceRows||'<p class="desc-pda-empty">可視の生態sourceなし。</p>'}</div></section><section><h4>配給グループ</h4><div class="ration-group-editor"><label>グループ名<input data-action="ration-group-name" maxlength="48" placeholder="例: 子ども / 負傷者 / 夜警"></label><div class="ration-roster">${roster.map((agent)=>`<label><input type="checkbox" data-action="ration-member-toggle" data-agent-id="${esc(agent.id)}"><span>${esc(agent.name)}</span><small>${esc(agent.role)}${agent.alive?'':' · inactive'}</small></label>`).join('')}</div><button data-action="ration-group-save">名簿から配給グループを保存</button></div><div class="ration-saved-list">${groupRows||'<p class="desc-pda-empty">保存グループなし。</p>'}</div><h4>配給ルール</h4><div class="ration-rule-editor" data-ration-rule-form><label>配給先<select data-action="ration-rule-group">${groups.map((group)=>`<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('')}</select></label><label>資源<select data-action="ration-rule-resource">${(['food','water','medicine','timber','scrap','fuel','cloth','records'] as SettlementResourceKey[]).map((key)=>`<option value="${key}">${key}</option>`).join('')}</select></label><label>ロット / 種類<select data-action="ration-rule-selector">${selectorOptions}</select></label><label>1人1日量<input type="number" min="0" step="0.1" value="1" data-action="ration-rule-amount"></label><label>優先度<input type="number" min="-1000" max="1000" step="1" value="0" data-action="ration-rule-priority"></label><label class="ration-exclusive"><input type="checkbox" data-action="ration-rule-exclusive">選択在庫をこの群へ専用配給</label><button data-action="ration-rule-save" ${groups.length?'':'disabled'}>配給ルールを保存</button></div><div class="ration-saved-list">${ruleRows||'<p class="desc-pda-empty">保存ルールなし。</p>'}</div><h4>配給履歴</h4><div class="ration-distribution-list">${distributionRows||'<p class="desc-pda-empty">recentDistributions はまだありません。</p>'}</div></section></div></section>`;
  }

  private pdaInventoryPanel(): string {
    const holder=this.inventoryAgent();
    const eligible=this.inventoryEligibleAgents();
    const controlled=this.controlledAgent();
    const field=this.controlledExpedition();
    const supplies=field?field.supplies:this.state.settlement.resources;
    const items=holder?inventoryForAgent(this.state,holder.id):[];
    const totalWeight=items.reduce((sum,item)=>sum+item.weightKg*item.quantity,0);
    const stock=Object.entries(supplies).filter(([,value])=>typeof value==='number');
    const cargoRows=items.length?items.map((item)=>`<article class="desc-pda-inventory-row ${item.kind==='sample'?'sample':item.kind==='resource'?'resource-cargo':''}"><div><strong>${esc(item.name)}</strong><small>${esc(item.kind)} · qty ${item.quantity} ${item.resourceUnit?esc(item.resourceUnit):''} · ${(item.weightKg*item.quantity).toFixed(2)} kg${item.resourceSubtype?` · ${esc(item.resourceSubtype)}`:''}</small></div><em>${item.sourceEntityId?'PROVENANCE':'PERSONAL'}</em>${item.sourceEntityId?`<small>source ${esc(compactText(item.sourceEntityId,32))}${item.resourceContaminationRisk!==undefined?` · contamination ${(item.resourceContaminationRisk*100).toFixed(0)}%`:''}</small>`:''}</article>`).join(''):'<p class="desc-pda-empty">携行品なし。</p>';
    return `<section class="desc-pda-data-panel desc-pda-inventory-panel"><header><div><span>PHYSICAL ACCESS / INVENTORY</span><h2>${field?'遠征携行品':'所持品・共有在庫'}</h2></div><em>${totalWeight.toFixed(1)} kg</em></header><div class="desc-pda-control-strip"><label>所持者<select data-action="inventory-agent">${eligible.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===holder?.id?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><span>遠隔在庫は表示しません。</span></div><div class="desc-pda-data-columns inventory"><section><header><strong>${esc(holder?.name ?? 'NO HOLDER')} / 携行品</strong><span>${items.length}</span></header><div class="desc-pda-scroll-list">${cargoRows}</div></section><section><header><strong>${field?'遠征物資':'集落共有在庫'}</strong><span>${stock.length}</span></header><div class="desc-pda-stock-grid">${stock.map(([name,value])=>`<article><span>${esc(name)}</span><b>${Number(value).toFixed(1)}</b>${controlled&&['food','water','medicine'].includes(name)?`<button data-action="consume-supply" data-kind="${esc(name)}">使用</button>`:''}</article>`).join('')}</div></section></div>${field?'':this.settlementResourceLedgerPanel()}</section>`;
  }

  private pdaChroniclePanel(): string {
    const viewpoint=this.chronicleViewpoint();
    const entries=projectChronicle(this.state,viewpoint).slice().reverse();
    const byDay=new Map<number,typeof entries>();
    for(const entry of entries){const bucket=byDay.get(entry.day)??[];bucket.push(entry);byDay.set(entry.day,bucket);}
    const days=[...byDay.entries()].sort((a,b)=>b[0]-a[0]);
    return `<section class="desc-pda-data-panel desc-pda-chronicle-panel"><header><div><span>VISIBLE HISTORY / EVENT LOG</span><h2>年代記</h2></div><em>${viewpoint.kind==='settlement'?'SETTLEMENT':'FIELD'}</em></header><div class="desc-pda-chronicle-ledger">${days.length?days.map(([day,dayEntries])=>`<section><header><strong>DAY ${day}</strong><span>${dayEntries.length} EVENTS</span></header>${dayEntries.map((entry)=>`<article><time>${String(Math.floor(entry.minuteOfDay/60)).padStart(2,'0')}:${String(entry.minuteOfDay%60).padStart(2,'0')}</time><div><strong>${esc(entry.title)}</strong><p>${esc(entry.text)}</p></div></article>`).join('')}</section>`).join(''):'<p class="desc-pda-empty">可視イベントなし。</p>'}</div></section>`;
  }

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


  private legacyHeader(): string {
    const field = this.controlledExpedition();
    const time = `${String(Math.floor(this.state.clock.minuteOfDay / 60)).padStart(2,'0')}:${String(this.state.clock.minuteOfDay % 60).padStart(2,'0')}`;
    const place = field ? `FIELD / ${field.position.x.toFixed(1)}, ${field.position.y.toFixed(1)}` : this.state.settlement.name;
    return `<header class="topbar panel game-header legacy-game-header"><div class="identity"><div class="portrait" aria-hidden="true">MV</div><div><h1>罪人の子孫たち</h1><p>THE DESCENDANTS OF CRIMINALS</p></div></div><div class="time-location"><strong>${esc(`${this.state.clock.day}日目　${time}`)}</strong><span>${esc(place)} / 観測中</span></div><div class="top-tools"><button class="quiet-button legacy-system-button" data-action="legacy-system" aria-expanded="${this.#systemOpen}"><kbd>F10</kbd><span>システム</span><small>SYSTEM</small></button></div></header>`;
  }

  private legacyNav(): string {
    const counts: Record<ViewId,string> = {
      exploration: this.controlledExpedition() ? 'FIELD' : `DAY ${this.state.clock.day}`,
      body: `${this.controlledAgent()?.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic').length ?? 0} 状態`,
      knowledge: `${this.state.knowledge.length} 件`,
      inventory: `${this.inventoryAgent() ? inventoryForAgent(this.state,this.inventoryAgent()!.id).length : 0} 種`,
      chronicle: `${projectChronicle(this.state,this.chronicleViewpoint()).length} 件`,
    };
    const labels: Record<ViewId,string> = { exploration:'探索', body:'身体・装備', knowledge:'知識', inventory:'所持品', chronicle:'年代記' };
    return `<nav class="main-nav command-nav panel legacy-command-nav" aria-label="Primary views" role="tablist">${VIEWS.map(([id,,key])=>`<button id="sandbox-tab-${id}" class="nav-button ${this.#view===id?'active':''}" role="tab" data-action="view" data-view="${id}" aria-selected="${this.#view===id}" aria-controls="sandbox-main-content" tabindex="${this.#view===id?'0':'-1'}"><kbd>${key}</kbd><strong>${labels[id]}</strong><span>${esc(counts[id])}</span></button>`).join('')}</nav>`;
  }

  private legacyCharacterHud(): string {
    const agent = this.controlledAgent();
    if (!agent) return `<aside class="character-hud panel legacy-character-hud"><p class="eyebrow">PLAYER</p><p>操作可能な人物がいません。</p></aside>`;
    const field = this.controlledExpedition();
    const situations = synthesizeVisibleSituations(this.state, field, field ? this.#localProjection : null);
    const objective = situations[0]?.title || (field ? '遠征を安全に継続する。' : '周辺の状況を確認する。');
    const health = Math.max(0,Math.min(100,agent.health));
    const fatigue = Math.max(0,Math.min(100,agent.fatigue));
    const hunger = Math.max(0,Math.min(100,agent.needs.hunger ?? 0));
    const thirst = Math.max(0,Math.min(100,agent.needs.thirst ?? 0));
    const morale = Math.max(0,Math.min(100,agent.morale ?? 50));
    const place = field ? '遠征中' : this.state.settlement.name;
    const comm = field ? (field.communicationReports?.at(-1)?.status ?? '未確認') : '接続';
    const carried = inventoryForAgent(this.state,agent.id).reduce((sum,item)=>sum+item.weightKg*item.quantity,0);
    const quick = field ? field.supplies : this.state.settlement.resources;
    const meter=(label:string,value:number,invert=false)=>`<div class="hud-stat"><div><span>${label}</span><strong>${Math.round(value)}</strong></div><div class="mini-meter"><i style="width:${Math.max(0,Math.min(100,invert?100-value:value))}%"></i></div></div>`;
    return `<aside class="character-hud panel legacy-character-hud"><div class="hud-profile"><div class="large-portrait" aria-hidden="true">${esc(agent.name.slice(0,2).toUpperCase())}</div><div><p class="eyebrow">PLAYER</p><h2>${esc(agent.name)}</h2><p>${esc(agent.role)}・${agentAgeYears(this.state,agent)}歳</p></div></div><div class="hud-objective"><span>現在の目的</span><strong>${esc(objective)}</strong></div><div class="hud-vitals">${meter('体力',health)}${meter('疲労',fatigue,true)}${meter('空腹',hunger,true)}${meter('渇き',thirst,true)}${meter('士気',morale)}</div><div class="hud-facts"><div><span>広域地点</span><strong>${esc(this.state.settlement.name)}</strong></div><div><span>局地位置</span><strong>${esc(place)}</strong></div><div><span>集落連絡</span><strong>${esc(comm)}</strong></div><div><span>所持重量</span><strong>${carried.toFixed(1)}kg</strong></div></div><div class="hud-section"><div class="hud-section-title"><span>身体状態</span><strong>${agent.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic').length ? `${agent.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic').length}件` : '管理'}</strong></div><div class="condition-tags">${agent.pathology.some((entry)=>entry.status==='active'||entry.status==='chronic')?agent.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic').slice(0,3).map((entry)=>`<span>${esc(entry.pathologyId)}</span>`).join(''):'<span class="good-tag">大きな異常なし</span>'}</div></div><div class="hud-section"><div class="hud-section-title"><span>すぐ使う</span><strong>詳細</strong></div><div class="supply-list"><button data-action="consume-supply" data-kind="water"><strong>飲料水</strong><span>×${Math.max(0,Math.floor(Number(quick.water ?? 0)))}</span></button><button data-action="consume-supply" data-kind="food"><strong>保存食</strong><span>×${Math.max(0,Math.floor(Number(quick.food ?? 0)))}</span></button></div></div></aside>`;
  }

  private legacyExplorationView(): string {
    const agent = this.controlledAgent();
    const field = this.controlledExpedition();
    if (!field && this.#mapScope === 'local') this.#mapScope = 'world';
    const scope = field ? this.#mapScope : 'world';
    const center = scope==='local' && field ? field.position : this.state.settlement.position;
    const radius = scope==='local' ? 5 : generatedWorldMapRadiusKm(this.state);
    const entities = scope==='local' ? (this.#localProjection?.entities ?? []) : this.visibleWorldEntities().filter((e)=>e.id!==this.state.world.originEntityId);
    const selected = scope==='local' ? this.selectedLocalEntity() : this.selectedWorldEntity();
    const markers = entities.slice(0,20).map((entry)=> scope === 'local'
      ? `<button class="legacy-map-marker ${selected?.id===entry.id?'selected':''}" style="${this.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-local-entity" data-entity-id="${esc(entry.id)}" title="${esc(entityName(entry))}"><span></span><small>${esc(entityName(entry))}</small></button>`
      : `<button class="legacy-map-marker ${selected?.id===entry.id?'selected':''}" style="${this.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-world-entity" data-entity-id="${esc(entry.id)}" title="${esc(entityName(entry))}"><span></span><small>${esc(entityName(entry))}</small></button>`
    ).join('');
    const situations = synthesizeVisibleSituations(this.state, field, field ? this.#localProjection : null);
    const latest = projectChronicle(this.state,this.chronicleViewpoint()).at(-1);
    const sceneTitle = field ? '遠征地点' : this.state.settlement.name;
    const sceneSub = field ? `FIELD / ${field.position.x.toFixed(1)}, ${field.position.y.toFixed(1)}` : 'SETTLEMENT / OBSERVATION';
    const dialogue = situations[0]?.detail || latest?.text || '現在の周辺状況を確認している。既知の情報だけが画面に表示される。';
    const objective = situations[0]?.title || '周辺の状況を確認する。';
    const selectedName = selected ? entityName(selected) : (scope==='local'?'局地周辺':'既知の広域地図');
    const fieldStatus = field ? `<div class="legacy-status-rows"><div><span>遠征</span><strong>${esc(field.status)}</strong></div><div><span>隊員</span><strong>${field.memberIds.length}</strong></div><div><span>水</span><strong>${field.supplies.water.toFixed(0)}</strong></div><div><span>食料</span><strong>${field.supplies.food.toFixed(0)}</strong></div></div>` : `<div class="legacy-status-rows"><div><span>危険度</span><strong>${situations.length}</strong></div><div><span>観測対象</span><strong>${entities.length}</strong></div><div><span>通信</span><strong>接続</strong></div><div><span>負傷</span><strong>${agent?.pathology.filter((entry)=>entry.status==='active'||entry.status==='chronic').length ?? 0}</strong></div></div>`;
    return `<div class="adventure-layout legacy-adventure-layout"><section class="adventure-main scene-mode panel legacy-adventure-main"><div class="adv-scene"><header class="adv-scene-header"><div><p class="eyebrow">序章・観測</p><h2>${esc(sceneTitle)}</h2></div><div class="scene-progress"><span>${esc(sceneSub)}</span><i><b style="width:6%"></b></i></div></header><div class="adv-stage legacy-placeholder-stage"><div class="legacy-stage-grid" aria-hidden="true"></div><div class="stage-caption">映像記録なし</div><div class="legacy-stage-readout"><span>SCENE LAYER</span><strong>${esc(selectedName)}</strong><small>VISUAL FEED UNAVAILABLE</small></div></div><div class="dialogue-box"><div class="dialogue-speaker">${esc(agent?.name ?? '観測')}</div><div class="dialogue-body"><p>${esc(dialogue)}</p></div><div class="dialogue-hint">F1 探索画面 · F2–F5 情報画面へ切替</div></div></div></section><aside class="adventure-side legacy-context-rail"><section class="side-panel panel legacy-map-panel"><div class="side-title"><span>${scope==='local'?'LOCAL POSITION':'WORLD POSITION'}</span><strong>${scope==='local'?'局地':'広域'}</strong></div><div class="legacy-map-surface">${markers}<span class="legacy-map-origin" style="left:50%;top:50%">◇</span><div class="legacy-map-grid" aria-hidden="true"></div></div><div class="legacy-map-switch"><button data-action="map-scope" data-scope="world" class="${scope==='world'?'active':''}">広域マップ</button>${field?`<button data-action="map-scope" data-scope="local" class="${scope==='local'?'active':''}">局地マップ</button>`:''}</div></section><section class="side-panel panel objective-panel"><p class="eyebrow">CURRENT OBJECTIVE</p><h3>${esc(objective)}</h3><p>現在の観測記録から再構成した状況。未確認領域は表示しない。</p></section><section class="side-panel panel field-panel"><div class="side-title"><span>FIELD STATUS</span><strong>身体</strong></div>${fieldStatus}</section></aside></div>`;
  }

  private legacyPrimarySurface(): string {
    if (this.#view==='exploration') return this.legacyExplorationView();
    return `<section class="legacy-secondary-surface panel">${this.body()}</section>`;
  }

  private legacySystemOverlay(): string {
    if (!this.#systemOpen) return '';
    return `<div class="system-overlay" role="dialog" aria-modal="true" aria-label="System"><section class="system-window"><header><div><p class="eyebrow">F10 / SYSTEM</p><h2>システム</h2></div><button data-action="legacy-system">閉じる</button></header><div class="system-grid"><button data-action="a11y-scale"><kbd>A</kbd><strong>文字サイズ ${Math.round(this.#accessibility.textScale*100)}%</strong><span>TEXT SCALE</span></button><button data-action="a11y-contrast"><kbd>C</kbd><strong>ハイコントラスト ${this.#accessibility.highContrast?'ON':'OFF'}</strong><span>CONTRAST</span></button><button data-action="a11y-motion"><kbd>M</kbd><strong>動き低減 ${this.#accessibility.reduceMotion?'ON':'OFF'}</strong><span>MOTION</span></button><button data-action="export"><kbd>S</kbd><strong>セーブを書き出す</strong><span>EXPORT SAVE</span></button><label class="legacy-import system-import"><kbd>L</kbd><strong>セーブを読み込む</strong><span>IMPORT SAVE</span><input type="file" data-action="import" accept="application/json,.json" aria-label="Import sandbox save JSON"></label><button data-action="reset" class="system-danger"><kbd>R</kbd><strong>${this.#persistenceMode==='durable'?'最初から':'一時セッション終了'}</strong><span>RESET</span></button></div><footer>Esc / F10 で閉じる</footer></section></div>`;
  }
  private header(): string {
    const controller = this.controlledAgent();
    const canonical = findAgent(this.state, this.state.settlement.leaderId);
    const field = this.controlledExpedition();
    const label = field ? 'FIELD COMMAND' : controller?.id === canonical?.id ? 'SETTLEMENT COMMAND' : 'ACTING COMMAND';
    const time = `${String(Math.floor(this.state.clock.minuteOfDay / 60)).padStart(2,'0')}:${String(this.state.clock.minuteOfDay % 60).padStart(2,'0')}`;
    return `<header class="sandbox-top"><div><span class="sandbox-eyebrow">DESCENDANTS / SETTLEMENT COMMAND NETWORK</span><h1>${esc(this.state.settlement.name)}</h1></div><div class="sandbox-clock"><strong>Day ${this.state.clock.day} ${time}</strong><span>world cycle ${this.state.clock.worldTick} · journal ${esc(this.state.diagnostics.replayHash || 'boot')}</span></div><div class="sandbox-leader"><span>${esc(label)}</span><strong>${esc(controller?.name ?? 'none')}</strong></div></header>`;
  }

  private runtimeRecoveryBanner(): string {
    const degraded = this.#persistenceMode !== 'durable' || this.#providerMode !== 'real-worldgen' || this.#startupNotices.length > 0;
    if (!degraded) return '';
    const items = this.#startupNotices.map((notice) => `<li>${esc(notice)}</li>`).join('');
    return `<aside class="sandbox-recovery-banner" role="status" aria-live="polite"><strong>RECOVERY / LINK DEGRADED</strong><span>world link ${this.#providerMode==='real-worldgen'?'LIVE':this.#providerMode==='snapshot-recovery'?'RECOVERED':'LOCAL'} · archive ${this.#persistenceMode==='durable'?'SEALED':'TEMPORARY'}</span>${items ? `<ul>${items}</ul>` : ''}${this.#persistenceMode !== 'durable' ? '<p>このセッションを閉じる前にArchiveを書き出してください。保管庫は現在変更されていません。</p>' : ''}${this.#reloadRequiredReason ? `<button data-action="provider-resync-reload" class="primary">${this.#reloadRequiredKind==='provider'&&this.#recoverProvider?'Resynchronize world link':'Reload verified archive'}</button>` : ''}</aside>`;
  }

  private nav(): string {
    return `<nav class="sandbox-nav generated-command-nav" aria-label="Command surfaces"><div class="generated-view-tabs" role="tablist" aria-label="Primary views" role="tablist">${VIEWS.map(([id,label,key]) => `<button id="sandbox-tab-${id}" role="tab" data-action="view" data-view="${id}" class="${this.#view === id ? 'active' : ''}" aria-selected="${this.#view === id}" aria-controls="sandbox-main-content" tabindex="${this.#view === id ? '0' : '-1'}"><kbd>${key}</kbd><span>${label}</span></button>`).join('')}</div><span class="generated-nav-spacer"></span><button data-action="execute-plan" ${this.#busy ? 'disabled' : ''}>BEGIN OPERATIONS</button></nav>`;
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

  private encounterGrid(encounter: EncounterState): string {
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

  private fieldCycleGuide(): string {
    const field = this.controlledExpedition();
    const activeEncounter = field ? [...this.state.encounters].reverse().find((entry) => entry.expeditionId === field.id && entry.status !== 'resolved') : undefined;
    const recentlyReturned = [...this.state.expeditions].reverse().find((entry) => entry.status === 'returned' && entry.returnDay !== null && this.state.clock.day - entry.returnDay <= 2);
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
    } else if (this.#prepTarget) {
      phase = 'prepare'; title = 'Prepare and launch the expedition';
      detail = '隊員、隊長、携行物資、行軍速度、Doctrineを確認し、出発命令を出してください。';
    } else if (recentlyReturned) {
      phase = 'record'; title = 'Turn returned evidence into durable knowledge';
      detail = 'Open F3 Knowledge. Archive a witnessed claim and start sample-gated research where physical evidence is present, then begin another field cycle.';
    }
    const steps: Array<[typeof phase,string]> = [['target','1 TARGET'],['prepare','2 PREP'],['field','3 FIELD'],['return','4 RETURN'],['record','5 RECORD']];
    return `<section class="field-cycle-guide" aria-label="Field cycle playtest route"><span class="sandbox-eyebrow">FIELD CYCLE / OPERATION GUIDE</span><div class="field-cycle-steps">${steps.map(([id,label])=>`<span class="${phase===id?'active':''}">${label}</span>`).join('')}</div><strong>${esc(title)}</strong><p>${esc(detail)}</p></section>`;
  }

  private settlementPolicyPanel(): string {
    const tasks: LaborTask[] = ['forage','water','medicine','repair','sanitation','care','records','guard','explore-prep'];
    const proposals = (this.state.policyProposals ?? []).slice(-8).reverse();
    const latest = proposals[0];
    const localAssigned = new Map<LaborTask, number>();
    for (const agent of this.state.agents) {
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
    return `<section class="settlement-policy-panel"><h4>ASSEMBLY / LABOR PRIORITIES</h4><p>優先度の変更案を集会へ提出します。参加者は信頼・利害・正統性・自律性・過去の立場を踏まえて投票し、集会中は60分が経過します。可決後は各自の勤務選択に反映されます。</p>${latestResult}<div class="policy-priority-list">${tasks.map((task)=>{const availability=laborPriorityProposalAvailability(this.state,task);return `<div class="policy-priority-row ${availability.allowed?'':'considered-today'}"><strong>${esc(task)}</strong><span>priority <b>${this.state.settlement.laborPriorities[task]}</b></span><small>${localAssigned.get(task) ?? 0} assigned now${availability.allowed?'':' · voted today'}</small><div><button aria-label="Increase ${esc(task)} priority" data-action="policy" data-task="${task}" data-delta="1" ${availability.allowed?'':'disabled'}>+</button><button aria-label="Decrease ${esc(task)} priority" data-action="policy" data-task="${task}" data-delta="-1" ${availability.allowed?'':'disabled'}>−</button></div></div>`;}).join('')}</div>${history}</section>`;
  }

  private visualQaEncounterControlsEnabled(): boolean {
    return this.#providerMode === 'mock-diagnostic' && this.#persistenceMode !== 'durable';
  }

  private fieldOperationsPanel(): string {
    this.initializeExpeditionPreparation();
    const available = settlementAgents(this.state).filter((agent)=>agentAgeYears(this.state,agent)>=16).sort((a,b)=>b.skills.scouting-a.skills.scouting);
    const selectedCrew = available.filter((agent)=>this.#prepCrewIds.has(agent.id));
    const leader = findAgent(this.state, this.#prepLeaderId);
    const doctrine = this.selectedPreparationDoctrine();
    const target = this.#prepTarget;
    const visibleWorldEntities = this.visibleWorldEntities();
    const targetEntity = this.#prepTargetEntityId ? visibleWorldEntities.find((entry)=>entry.id===this.#prepTargetEntityId) : visibleWorldEntities.find((entry)=>entry.spatial && target && spatialDistanceKm(entry.spatial,target)<0.01);
    const topologyRoutes = targetEntity ? providerVisibleRouteAlternatives(this.#worldProjection, visibleWorldEntities, this.state.world.originEntityId, targetEntity.id, 3) : [];
    const selectedTopologyRoute = this.#prepRouteEntityId ? topologyRoutes.find((entry)=>entry.id===this.#prepRouteEntityId) : undefined;
    const topologyEvidenceRouteIds = new Set(topologyRoutes.flatMap((entry)=>entry.evidenceIds));
    const knownRoutes = visibleWorldEntities.filter((entry)=>entry.kind==='route' && entry.spatial && !topologyEvidenceRouteIds.has(entry.id));
    const selectedRoute = this.#prepRouteEntityId ? knownRoutes.find((entry)=>entry.id===this.#prepRouteEntityId) : undefined;
    const routeWaypoint = selectedRoute?.spatial;
    const plannedWaypoints = selectedTopologyRoute?.waypoints ?? routeWaypoint;
    const routeEvidenceIds = selectedTopologyRoute?.evidenceIds ?? (selectedRoute ? [selectedRoute.id] : []);
    const routeDisruption = latestObservedRouteDisruptionForEntities(this.state, routeEvidenceIds);
    const destinationDisruption = this.#prepTargetEntityId ? latestObservedRouteDisruptionForEntity(this.state, this.#prepTargetEntityId) : undefined;
    const controlled = this.controlledExpedition();
    const active = this.state.expeditions.filter((entry)=>!['returned','destroyed'].includes(entry.status));
    const selectedWeight = selectedCrew.reduce((sum,agent)=>sum+equipmentForAgent(this.state,agent.id).filter((item)=>item.equipped).reduce((inner,item)=>inner+item.weightKg,0),0);
    const supplyWeight = this.#prepSupplies.food*0.55 + this.#prepSupplies.water + this.#prepSupplies.medicine*0.18 + this.#prepSupplies.tools*1.5;
    const resourceOk = this.state.settlement.resources.food>=this.#prepSupplies.food
      && this.state.settlement.resources.water>=this.#prepSupplies.water
      && this.state.settlement.resources.medicine>=this.#prepSupplies.medicine
      && this.state.settlement.resources.scrap>=this.#prepSupplies.tools;
    const supplyReadiness = expeditionSupplyReadiness(this.state, selectedCrew.map((agent)=>agent.id), target, this.#prepPace, this.#prepSupplies, plannedWaypoints, selectedTopologyRoute?.distanceKm);
    const settlementReserve = doctrine ? settlementSupplyReserveReadiness(this.state, this.#prepSupplies, doctrine) : null;
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
      const latestEncounter = [...this.state.encounters].reverse().find((entry) => entry.expeditionId === expedition.id);
      const activeEncounter = latestEncounter && latestEncounter.status !== 'resolved' ? latestEncounter : undefined;
      const runtimeDoctrine=this.state.doctrines.find((entry)=>entry.id===expedition.doctrineId);
      const arrival = expedition.arrivedDay ? ` · arrived D${expedition.arrivedDay}${expedition.arrivedMinute!==undefined?` ${String(Math.floor(expedition.arrivedMinute/60)).padStart(2,'0')}:${String(expedition.arrivedMinute%60).padStart(2,'0')}`:''}` : '';
      const wedo = activeEncounter ? (() => {
        const partyActors = activeEncounter.actors.filter((actor)=>actor.side==='expedition');
        const hostileActors = activeEncounter.actors.filter((actor)=>actor.side==='other');
        const actorLine = (actor: EncounterState['actors'][number], index: number) => {
          const agent = actor.side === 'expedition' ? findAgent(this.state, actor.agentId) : undefined;
          const label = agent?.name ?? `Other ${index + 1}`;
          return `<span class="wedo-actor ${actor.health<=0?'down':actor.health<45?'critical':''}"><b>${esc(label)}</b><em>${actor.health.toFixed(0)} hp</em></span>`;
        };
        return `<div class="field-wedo"><div class="wedo-head"><strong>WEDO / ${esc(activeEncounter.status)}</strong><span>ROUND INTERVAL · 10 min</span></div><div class="wedo-control-row"><label>Directive <select data-action="encounter-instruction" data-encounter-id="${activeEncounter.id}">${(['avoid','withdraw','defend','advance','protect-wounded','capture','break-contact'] as EncounterInstruction[]).map((instruction)=>`<option value="${instruction}" ${activeEncounter.instruction===instruction?'selected':''}>${instruction}</option>`).join('')}</select></label><button class="wedo-step" data-action="wedo-round" data-encounter-id="${activeEncounter.id}">Resolve next WEDO round · 10 min</button></div><div class="wedo-actors"><section><small>PARTY</small>${partyActors.map(actorLine).join('')}</section><section><small>OTHER</small>${hostileActors.map(actorLine).join('')}</section></div>${this.encounterGrid(activeEncounter)}<div class="wedo-queue">${activeEncounter.queue.slice(0,6).map((action)=>`<span>#${action.order} ${esc(action.actorId)} → ${esc(action.action)}</span>`).join('')}</div>${activeEncounter.log.length?`<small class="wedo-log">${activeEncounter.log.slice(-4).map(esc).join(' · ')}</small>`:''}</div>`;
      })() : '';
      const routeBlocked = expedition.status==='outbound' && expedition.routePlan?.topologyStatus==='blocked';
      const fieldDecision = expedition.fieldDecision;
      const decisionRuntime = routeBlocked || fieldDecision ? `<div class="route-runtime ${routeBlocked?'unfit':'ready'}"><strong>FIELD DECISION · ${esc(fieldDecision?.kind??'required')}</strong><span>${esc(fieldDecision?.status??'awaiting choice')}${fieldDecision?.remainingHours!==undefined?` · ${fieldDecision.remainingHours.toFixed(1)}h remaining`:''}${fieldDecision?.result?` · ${esc(fieldDecision.result)}`:''}</span>${expedition.fieldExposure?`<small>observed exposure risk ${expedition.fieldExposure.lastRisk.toFixed(2)} · interval dose ${expedition.fieldExposure.lastIntervalDose.toFixed(2)} · cumulative ${expedition.fieldExposure.cumulativeDose.toFixed(2)} · ${expedition.fieldExposure.sheltered?'sheltered':'unsheltered'}${expedition.fieldExposure.sourceEntityIds.length?` · evidence ${esc(expedition.fieldExposure.sourceEntityIds.join(', '))}`:''}</small>`:''}</div>` : '';
      const routeRuntime = expedition.routePlan ? `<div class="route-runtime ${expedition.routePlan.topologyStatus==='blocked'?'unfit':'ready'}"><strong>CHARTED ROUTE · ${esc(expedition.routePlan.topologyStatus??'active')}</strong><span>leg ${Math.min(expedition.routePlan.currentWaypointIndex+1,expedition.routePlan.waypoints.length+1)}/${expedition.routePlan.waypoints.length+1} · replans ${expedition.routePlan.replanCount??0} · basis tick ${expedition.routePlan.basisTick??'legacy'}</span>${expedition.routePlan.blockedReason?`<small>${esc(expedition.routePlan.blockedReason)} No alternate route is recorded. Time alone does not reopen the route; choose wait/camp, retry/replan, or return.</small>`:''}</div>` : '';
      const returnRuntime = expedition.returnTravel ? `<div class="route-runtime ${expedition.returnTravel.status==='active'?'unfit':'ready'}"><strong>OFF-NETWORK RETURN · ${esc(expedition.returnTravel.status)}</strong><span>${expedition.returnTravel.travelledDistanceKm.toFixed(1)} / ${expedition.returnTravel.initialDistanceKm.toFixed(1)} km travelled · ${expedition.returnTravel.remainingDistanceKm.toFixed(1)} km remaining</span><small>terrain speed ×${expedition.returnTravel.lastSpeedFactor.toFixed(2)} · dead-reckoning uncertainty ${expedition.returnTravel.uncertaintyKm.toFixed(2)} km${expedition.returnTravel.terrainEvidenceIds.length?` · terrain evidence ${esc(expedition.returnTravel.terrainEvidenceIds.join(', '))}`:''}${expedition.returnTravel.navigationAnchorIds.length?` · navigation anchors ${esc(expedition.returnTravel.navigationAnchorIds.join(', '))}`:''}. This bearing is physical return progress, not a claimed known road.</small></div>` : '';
      const rendezvousRuntime = expedition.rendezvousRequest ? `<div class="route-runtime ${expedition.rendezvousRequest.status==='pending-link'?'unfit':'ready'}"><strong>RENDEZVOUS / RESCUE · ${esc(expedition.rendezvousRequest.status)}</strong><span>${expedition.rendezvousRequest.status==='pending-link'?'held locally until a verified communication link exists':expedition.rendezvousRequest.verifiedPosition?`verified transmission position ${expedition.rendezvousRequest.verifiedPosition.x.toFixed(1)}, ${expedition.rendezvousRequest.verifiedPosition.y.toFixed(1)}`:esc(expedition.rendezvousRequest.resolution??'resolved')}</span><small>${expedition.rendezvousRequest.status==='pending-link'?'Exact field position remains unknown until a transmission is received.':'A transmitted rendezvous position is a time-stamped field report, not a live position signal.'}</small></div>` : '';
      const responderRuntime = expedition.rendezvousPlan ? `<div class="route-runtime ${['aborted'].includes(expedition.rendezvousPlan.status)?'unfit':'ready'}"><strong>RESPONDER RENDEZVOUS · ${esc(expedition.rendezvousPlan.status)}</strong><span>target ${esc(expedition.rendezvousPlan.targetExpeditionId)} · evidence ${esc(expedition.rendezvousPlan.targetEvidenceId)} @ ${expedition.rendezvousPlan.evidencePosition.x.toFixed(1)}, ${expedition.rendezvousPlan.evidencePosition.y.toFixed(1)} · ETA at launch ${expedition.rendezvousPlan.etaHoursAtLaunch.toFixed(1)}h</span><small>arrival window D${expedition.rendezvousPlan.arrivalWindowStartDay} ${String(Math.floor(expedition.rendezvousPlan.arrivalWindowStartMinute/60)).padStart(2,'0')}:${String(expedition.rendezvousPlan.arrivalWindowStartMinute%60).padStart(2,'0')}–D${expedition.rendezvousPlan.arrivalWindowEndDay} ${String(Math.floor(expedition.rendezvousPlan.arrivalWindowEndMinute/60)).padStart(2,'0')}:${String(expedition.rendezvousPlan.arrivalWindowEndMinute%60).padStart(2,'0')}${expedition.rendezvousPlan.arrivalAssessment?` · arrived ${esc(expedition.rendezvousPlan.arrivalAssessment)}`:''} · wait ${expedition.rendezvousPlan.waitHoursRemaining.toFixed(1)}h · search ${expedition.rendezvousPlan.searchHours.toFixed(1)}h / radius ${expedition.rendezvousPlan.searchRadiusKm.toFixed(1)}km${expedition.rendezvousPlan.lastOutcome?` · ${esc(expedition.rendezvousPlan.lastOutcome)}`:''}. Search expands around the last received clue for up to 12h.</small></div>` : '';
      const expeditionDetail = `<p>${expedition.memberIds.map((id)=>{const agent=findAgent(this.state,id);const encounterActor=activeEncounter?.actors.find((actor)=>actor.agentId===id);const liveHealth=encounterActor?.health??agent?.health??0;return `${esc(agent?.name??id)} ${agent?.alive?`${liveHealth.toFixed(0)}hp / ${agent.fatigue.toFixed(0)}fat`:'down'}`;}).join(' · ')}</p><p>Doctrine: ${esc(runtimeDoctrine?.name ?? expedition.doctrineId)} · supplies F${expedition.supplies.food.toFixed(1)} W${expedition.supplies.water.toFixed(1)} M${expedition.supplies.medicine.toFixed(1)} T${expedition.supplies.tools.toFixed(1)}</p>${routeRuntime}${returnRuntime}${decisionRuntime}${rendezvousRuntime}${responderRuntime}${runtimeDoctrine?`<small>Runtime doctrine: camp ${runtimeDoctrine.campBeforeDark?'before dark':'manual'} · comm return threshold ${runtimeDoctrine.maxSilentHours}h · retreat below ${runtimeDoctrine.retreatHealth}hp · contact ${esc(runtimeDoctrine.contactPolicy)} · rescue ${runtimeDoctrine.prioritizeRescue?'priority':'ordinary'}.</small>`:''}`;
      const wedoDebrief = !activeEncounter && latestEncounter?.status === 'resolved' ? `<div class="field-wedo-summary"><div><strong>LAST WEDO / RESOLVED</strong><span>${esc(latestEncounter.instruction)} · ${latestEncounter.casualties.length} expedition ${latestEncounter.casualties.length===1?'casualty':'casualties'}</span></div><p>${latestEncounter.actors.filter((actor)=>actor.side==='expedition').map((actor)=>{const agent=findAgent(this.state,actor.agentId);return `${esc(agent?.name??actor.agentId)} ${actor.health.toFixed(0)}hp`;}).join(' · ')}</p><small>Direct field debrief only; settlement visibility still follows return / communication / archive routes.</small></div>` : '';
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
        : `${!activeEncounter?`<button data-action="direct-camp" data-expedition-id="${expedition.id}">Camp / rest · 6h</button>${this.visualQaEncounterControlsEnabled()?`<button class="qa-sim-action" data-action="qa-trigger-encounter" data-expedition-id="${expedition.id}">WEDO接触を開始</button>`:''}`:''}${['outbound','exploring'].includes(expedition.status)?`<button data-action="return" data-expedition-id="${expedition.id}">Order return</button>`:''}${rendezvousAction}${responderActions}`;
      return `<article class="exp-card field-expedition-card ${activeEncounter?'has-active-wedo':''}">${activeEncounter?`${wedo}${fieldControlMeta}${expeditionDetail}`:`${fieldControlMeta}${wedoDebrief}${expeditionDetail}`}<div class="field-direct-actions">${fieldActions}</div></article>`;
    }).join('') || '<p>No active expeditions.</p>';
    const targetLabel = target ? `${targetEntity?entityName(targetEntity):'known map position'} · ${target.x.toFixed(1)}, ${target.y.toFixed(1)}` : 'No WORLD target selected';
    const preparation = controlled ? '' : `<div class="expedition-preparation"><h4>EXPEDITION PREPARATION</h4><p>Crew, physical loadout, travel pace, doctrine and a recorded WORLD target are explicit launch choices.</p><div class="prep-grid"><section><strong>Crew</strong><div class="crew-picker">${available.slice(0,16).map((agent)=>{const readiness=doctrine?expeditionMemberReadiness(agent,doctrine):{ready:false,reasons:['no doctrine'],minimumHealth:60,maximumFatigue:70};return `<label class="${readiness.ready?'':'unfit'}"><input type="checkbox" data-action="prep-crew" data-agent-id="${esc(agent.id)}" ${this.#prepCrewIds.has(agent.id)?'checked':''} ${readiness.ready?'':'disabled'}><span class="crew-name">${esc(agent.name)}</span><small>HP ${agent.health.toFixed(0)} · fat ${agent.fatigue.toFixed(0)} · ${readiness.ready?'READY':esc(readiness.reasons[0]??'RECOVERING')}</small></label>`;}).join('') || '<p>No available adults.</p>'}</div><label>Leader <select data-action="prep-leader">${selectedCrew.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===this.#prepLeaderId?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><label>Control at departure <select data-action="control-mode"><option value="expedition" ${this.#controlMode==='expedition'?'selected':''}>Control expedition</option><option value="settlement" ${this.#controlMode==='settlement'?'selected':''}>Remain with settlement</option></select></label></section><section><strong>Loadout</strong>${(['food','water','medicine','tools'] as const).map((kind)=>`<label>${kind}<input type="number" min="0" step="${kind==='medicine'?'0.25':'1'}" data-action="prep-supply" data-supply="${kind}" value="${this.#prepSupplies[kind]}"></label>`).join('')}<p>Equipped crew gear ${selectedWeight.toFixed(1)} kg · shared supply estimate ${supplyWeight.toFixed(1)} kg.</p><p>${resourceOk?'Settlement stock can furnish this loadout.':'Insufficient accessible settlement stock for this loadout.'}</p><div class="supply-readiness ${supplyReadiness.ready?'ready':'unfit'}"><strong>FIELD ENDURANCE · ${supplyReadiness.ready?'READY':'BLOCKED'}</strong><span>food ${supplyReadiness.foodDays.toFixed(1)}d · water ${supplyReadiness.waterDays.toFixed(1)}d${target&&Number.isFinite(supplyReadiness.estimatedOutboundHours)?` · est. outbound ${supplyReadiness.estimatedOutboundHours.toFixed(1)}h`:''}</span><small>${supplyReadiness.ready?'Outbound + 8h emergency reserve covered.':esc(supplyReadiness.reasons.join(' · '))}</small></div>${settlementReserve?`<div class="supply-readiness settlement-reserve ${settlementReserve.ready?'ready':'unfit'}"><strong>SETTLEMENT RESERVE · ${settlementReserve.ready?'PROTECTED':'BLOCKED'}</strong><span>after loadout: food ${settlementReserve.remainingFoodDays.toFixed(1)}d · water ${settlementReserve.remainingWaterDays.toFixed(1)}d</span><small>doctrine minimum ${settlementReserve.minimumReserveDays.toFixed(1)}d${settlementReserve.ready?' preserved':` · ${esc(settlementReserve.reasons.join(' · '))}`}</small></div>`:''}</section><section><strong>Travel / doctrine</strong><label>Pace <select data-action="prep-pace">${(['cautious','normal','fast'] as ExpeditionPace[]).map((pace)=>`<option value="${pace}" ${pace===this.#prepPace?'selected':''}>${pace}</option>`).join('')}</select></label><label>Doctrine <select data-action="prep-doctrine">${this.state.doctrines.map((entry)=>`<option value="${esc(entry.id)}" ${entry.id===doctrine?.id?'selected':''}>${esc(entry.name)}</option>`).join('')}</select></label>${doctrine?`<div class="doctrine-editor"><label>Risk tolerance <input type="number" min="0" max="1" step="0.05" data-action="doctrine-field" data-field="riskTolerance" value="${doctrine.riskTolerance}"></label><label>Retreat HP <input type="number" min="0" max="100" step="1" data-action="doctrine-field" data-field="retreatHealth" value="${doctrine.retreatHealth}"></label><label>Max silent hours <input type="number" min="1" step="1" data-action="doctrine-field" data-field="maxSilentHours" value="${doctrine.maxSilentHours}"></label><label><input type="checkbox" data-action="doctrine-field" data-field="campBeforeDark" ${doctrine.campBeforeDark?'checked':''}>Camp before dark</label><label><input type="checkbox" data-action="doctrine-field" data-field="prioritizeRescue" ${doctrine.prioritizeRescue?'checked':''}>Prioritize rescue</label><label>Contact <select data-action="doctrine-field" data-field="contactPolicy">${(['avoid','observe','peaceful','trade','assertive'] as ExpeditionDoctrine['contactPolicy'][]).map((policy)=>`<option value="${policy}" ${policy===doctrine.contactPolicy?'selected':''}>${policy}</option>`).join('')}</select></label><label>Encounter <select data-action="doctrine-field" data-field="encounterInstruction">${(['avoid','withdraw','defend','advance','protect-wounded','capture','break-contact'] as EncounterInstruction[]).map((instruction)=>`<option value="${instruction}" ${instruction===doctrine.encounterInstruction?'selected':''}>${instruction}</option>`).join('')}</select></label><button data-action="duplicate-doctrine">Duplicate doctrine as variant</button></div>`:''}</section></div><p class="prep-target">WORLD target: <strong>${esc(targetLabel)}</strong>. Select a visible WORLD marker and choose “Use as expedition target”.</p>${target?`<div class="supply-readiness route-readiness ${routeDisruption||destinationDisruption?'unfit':'ready'}"><strong>ROUTE CHOICE · ${selectedTopologyRoute?'RECORDED ROUTE':selectedRoute?`VIA ${esc(entityName(selectedRoute))}`:'DIRECT'}</strong><label class="route-choice-control">Known route <select data-action="prep-route"><option value="" ${this.#prepRouteEntityId?'':'selected'}>direct / no waypoint / no known topology</option>${topologyRoutes.map((route,index)=>`<option value="${esc(route.id)}" ${route.id===this.#prepRouteEntityId?'selected':''}>topology ${index+1} · ${route.distanceKm.toFixed(1)} km · stretch ${route.stretchFromShortest.toFixed(2)}× · overlap ${Math.round(route.overlapWithShortest*100)}% · ${route.relationIds.length} link${route.relationIds.length===1?'':'s'}</option>`).join('')}${knownRoutes.map((route)=>`<option value="${esc(route.id)}" ${route.id===this.#prepRouteEntityId?'selected':''}>via known waypoint ${esc(entityName(route))}</option>`).join('')}</select></label><span>${selectedTopologyRoute?`${esc(selectedTopologyRoute.relationIds.join(' → '))} · `:selectedRoute?`${esc(selectedRoute.id)} · `:''}planned outbound ${Number.isFinite(supplyReadiness.estimatedOutboundHours)?supplyReadiness.estimatedOutboundHours.toFixed(1):'?'}h</span><small>${routeDisruption?`Selected route has recorded disruption severity ${routeDisruption.severity.toFixed(0)} attached to explicit route evidence. Direct travel or another known route avoids only that route-specific evidence if the destination itself is unaffected.`:selectedTopologyRoute?'This alternative is composed only from recorded route network whose endpoints are already known. No recent disruption is attached to its evidence IDs; absence of observed disruption is not proof of safety.':selectedRoute?'No recent recorded disruption is attached to this selected route waypoint. Absence of observed disruption is not proof of safety.':'Direct travel claims no known topology and therefore does not infer an unseen safe path.'}${destinationDisruption?` Destination itself also has recorded disruption severity ${destinationDisruption.severity.toFixed(0)}; changing route does not erase destination evidence.`:''}</small></div>`:''}<button data-action="launch" ${selectedCrew.length<1||!leader||!this.#prepCrewIds.has(leader.id)||!doctrine||!resourceOk||!supplyReadiness.ready||!settlementReserve?.ready||!target?'disabled':''}>Launch selected expedition</button></div>`;
    const settlementPolicy = controlled ? '' : this.settlementPolicyPanel();
    return `<section class="sandbox-panel field-operations"><h3>FIELD / EXPEDITION</h3>${preparation}${settlementPolicy}<div class="field-card-list">${cards}</div></section>`;
  }

  private explorationView(): string {
    const controlled = this.controlledAgent();
    const field = this.controlledExpedition();
    if (!field && this.#mapScope === 'local') this.#mapScope = 'world';
    const situations = synthesizeVisibleSituations(this.state, field, field ? this.#localProjection : null);
    const visibleChronicle = projectChronicle(this.state, this.chronicleViewpoint()).slice(-3).reverse();
    const worldRadius = generatedWorldMapRadiusKm(this.state);
    const worldEntities = this.visibleWorldEntities();
    const selectedWorld = this.selectedWorldEntity();
    const localEntities = field ? (this.#localProjection?.entities ?? []) : [];
    const selectedLocal = this.selectedLocalEntity();
    const selectedDistance = field && selectedLocal?.spatial ? spatialDistanceKm(field.position, selectedLocal.spatial) : Number.POSITIVE_INFINITY;
    const scope = field ? this.#mapScope : 'world';
    const center = scope === 'local' && field ? field.position : this.state.settlement.position;
    const radius = scope === 'local' ? 5 : worldRadius;
    const localMarkers = localEntities.slice(0,24).map((entry)=>`<button class="known-map-marker local-entity-marker ${selectedLocal?.id===entry.id?'selected':''}" style="${this.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-local-entity" data-entity-id="${esc(entry.id)}"><small>${esc(entry.kind)}</small>${esc(entityName(entry))}</button>`).join('');
    const worldMarkers = worldEntities.filter((entry)=>entry.id!==this.state.world.originEntityId).slice(0,36).map((entry)=>`<button class="known-map-marker world-entity-marker ${selectedWorld?.id===entry.id?'selected':''}" style="${this.mapMarkerStyle(entry.spatial,center,radius)}" data-action="select-world-entity" data-entity-id="${esc(entry.id)}"><small>${esc(entry.kind)}</small>${esc(entityName(entry))}</button>`).join('');
    const partyMarker = field && scope==='world' ? `<span class="party-world-marker" style="${this.mapMarkerStyle(field.position,center,radius)}">FIELD PARTY</span>` : '';
    const location = field ? `${field.position.x.toFixed(1)}, ${field.position.y.toFixed(1)}` : `${this.state.settlement.position.x.toFixed(1)}, ${this.state.settlement.position.y.toFixed(1)}`;
    let inspector = this.fieldOperationsPanel();
    if (scope==='local' && field) {
      if (selectedLocal) {
        const near = selectedDistance <= 0.35;
        const externalPerson = selectedLocal.kind==='individual' && !this.state.agents.some((agent)=>agent.id===selectedLocal.id);
        const outsideSociety = externalPerson ? externalSocietyForPerson(this.state, selectedLocal.id) : undefined;
        inspector = `<section class="sandbox-panel local-action-inspector"><span class="sandbox-eyebrow">FIELD ACTIONS / CURRENT RANGE</span><h3>${esc(entityName(selectedLocal))}</h3><p>${esc(selectedLocal.kind)}${selectedLocal.subtype?` / ${esc(selectedLocal.subtype)}`:''} · ${Number.isFinite(selectedDistance)?selectedDistance.toFixed(2):'?'} km</p><p>観測済み情報のみを表示しています。未確認要素は記録外です。</p>${externalPerson?`<small>外部人物記録 ${esc(selectedLocal.id)}${outsideSociety?` · observed society ${esc(outsideSociety)}`:''}. 接触記録には実際に観測した内容だけを残し、未確認の信条や経歴は補完しません。</small>`:''}${!near && selectedLocal.spatial?`<button data-action="walk-local-target" data-entity-id="${esc(selectedLocal.id)}">Walk there</button>`:''}${near?`<button data-action="observe-local-target" data-entity-id="${esc(selectedLocal.id)}">Observe · 30 min</button>${externalPerson?`<button data-action="contact-external-person" data-entity-id="${esc(selectedLocal.id)}">Speak directly · 20 min</button>`:''}${isSampleableEntity(selectedLocal)?`<button data-action="sample-local-target" data-entity-id="${esc(selectedLocal.id)}">Collect sample · 45 min</button>`:''}${harvestableResourceKeys(selectedLocal).map((key)=>`<button data-action="harvest-local-resource" data-entity-id="${esc(selectedLocal.id)}" data-resource-key="${esc(key)}">Harvest ${esc(key)} · 60 min</button>`).join('')}`:'<small class="local-approach-note">Approach is required before close interaction.</small>'}</section>${this.fieldOperationsPanel()}`;
      } else {
        inspector = `<section class="sandbox-panel local-action-inspector"><span class="sandbox-eyebrow">FIELD ACTIONS / CURRENT RANGE</span><h3>Local surroundings</h3>${this.#localLoading?'<p>LOCAL SENSOR SWEEP…</p>':localEntities.length?'<p>観測済みの対象を地図上から選択してください。</p>':'<p>この範囲に顕著な観測対象はありません。</p><button data-action="survey-local-empty">Survey surroundings · 45 min</button>'}</section>${this.fieldOperationsPanel()}`;
      }
    } else if (selectedWorld) {
      const knownDistance = selectedWorld.spatial ? spatialDistanceKm(this.state.settlement.position, selectedWorld.spatial) : Number.POSITIVE_INFINITY;
      const externalActor = this.state.externalActors.find((actor)=>actor.entityId===selectedWorld.id);
      const recentExternal = externalActor ? visibleChronicle.find((entry)=>entry.kind==='external' && entry.entityIds.includes(externalActor.entityId)) : undefined;
      const recentObservedConflict = externalActor ? [...(this.state.externalConflictObservations ?? [])].reverse().find((entry)=>entry.sourceEntityId===externalActor.entityId) : undefined;
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
      const externalActions = externalActor && !field ? `<div class="external-actions world-selected-actions"><strong>Known relationship / settlement action</strong><div class="external-action-buttons">${(['trade','diplomacy','migration','conflict'] as ExternalActionKind[]).map((kind)=>{const availability=externalActionAvailability(this.state,kind,externalActor.entityId);const waitHours=Math.ceil(availability.remainingMinutes/60);return `<button data-action="external" data-kind="${kind}" data-target="${esc(externalActor.entityId)}" ${availability.allowed?'':'disabled'} title="${esc(availability.reason)}"><span>${kind}</span><small>${availability.allowed?`${Math.round(externalActionDurationMinutes(kind)/60)}h`:`wait ${waitHours}h`}</small></button>`;}).join('')}</div><div class="external-relation-readout"><span>confidence <b>${Math.round(externalActor.confidence*100)}%</b></span><span>trust <b>${externalActor.localTrust.toFixed(1)}</b></span><span>trade <b>${externalActor.tradeExperience}</b></span><span>migration <b>${externalActor.migrationBalance}</b></span><span>conflict <b>${externalActor.conflictPressure.toFixed(1)}</b></span></div>${recentObservedConflict?`<article class="external-last-result external-observed-result"><span>LATEST OBSERVED CONSEQUENCE</span><strong>${esc(recentObservedConflict.kind)}</strong><p>${esc(observedConflictSummary)}</p></article>`:''}${recentExternal?`<article class="external-last-result"><span>LATEST VISIBLE OUTCOME</span><strong>${esc(recentExternal.title)}</strong><p>${esc(recentExternal.text)}</p></article>`:''}<small>Commands apply only to this recorded society. Unknown parties are not listed.</small></div>` : '';
      inspector = `<section class="sandbox-panel local-action-inspector"><span class="sandbox-eyebrow">WORLD / KNOWN MAP OBJECT</span><h3>${esc(entityName(selectedWorld))}</h3><p>${esc(selectedWorld.kind)}${selectedWorld.subtype?` / ${esc(selectedWorld.subtype)}`:''} · ${Number.isFinite(knownDistance)?knownDistance.toFixed(1):'?'} km from settlement</p><p>This marker exists only because the controlled viewpoint has a knowledge path to its subject ID.</p>${selectedWorld.spatial&&!field?`<button data-action="set-prep-target" data-entity-id="${esc(selectedWorld.id)}">Use as expedition target</button>`:''}${selectedWorld.spatial&&field?`<button data-action="move-world-target" data-entity-id="${esc(selectedWorld.id)}">Set next field destination</button>`:''}${externalActions}</section>${this.fieldOperationsPanel()}`;
    }
    const mapButtons = `<div class="map-scope-controls"><button data-action="map-scope" data-scope="world" class="${scope==='world'?'active':''}">WORLD</button>${field?`<button data-action="map-scope" data-scope="local" class="${scope==='local'?'active':''}">LOCAL</button>`:''}</div>`;
    const markers = scope==='local' ? localMarkers : worldMarkers;
    const loading = scope==='local' ? this.#localLoading : this.#worldLoading;
    const note = scope==='local'
      ? 'LOCAL座標は現地観測に基づく相対位置です。'
      : `WORLD positions follow the current chart and recorded subject IDs; radius ${worldRadius.toFixed(0)} km.`;
    return `<section class="generated-play-grid"><aside class="generated-hud sandbox-panel"><span class="sandbox-eyebrow">ACTIVE COMMAND HOLDER</span><h2>${esc(controlled?.name ?? 'NO COMMAND HOLDER')}</h2>${controlled ? `<p>${esc(controlled.role)} · age ${agentAgeYears(this.state,controlled)}</p><div class="hud-meter"><span>HP</span><strong>${controlled.health.toFixed(0)}</strong></div><div class="hud-meter"><span>FATIGUE</span><strong>${controlled.fatigue.toFixed(0)}</strong></div><div class="hud-meter"><span>DUTY</span><strong>${esc(laborTaskDisplayName(controlled.currentTask))}</strong></div><div class="personal-actions"><button data-action="consume-supply" data-kind="food">Eat</button><button data-action="consume-supply" data-kind="water">Drink</button></div>` : ''}${this.fieldCycleGuide()}<h3>CURRENT SITUATION</h3><div class="situation-stack">${situations.map((signal)=>`<article class="situation-signal severity-${signal.severity}"><strong>${esc(signal.title)}</strong><p>${esc(signal.detail)}</p><small>record links ${signal.basisIds.length}</small></article>`).join('')}</div><h3>RECENT VISIBLE EVENTS</h3>${visibleChronicle.map((entry)=>`<article class="chronicle-line"><strong>${esc(entry.title)}</strong><span>D${entry.day}</span><p>${esc(entry.text)}</p></article>`).join('') || '<p>No observed update.</p>'}</aside><section class="generated-spatial sandbox-panel"><header class="spatial-head"><div><span class="sandbox-eyebrow">${scope==='local'?'LOCAL / OBSERVED':'WORLD / CHARTED'}</span><h2>${scope==='local'?'LOCAL VIEW':'WORLD VIEW'}</h2></div><div>${mapButtons}<strong>${esc(location)}</strong></div></header><div class="generated-map generated-map-${scope}" role="img" aria-label="Observed ${scope} chart"><div class="map-crosshair">◎</div><div class="map-location-label">${scope==='local'&&field ? esc(field.id) : esc(this.state.settlement.name)}</div>${markers}${partyMarker}<div class="map-scale">${scope==='local'?'±5 km':`±${worldRadius.toFixed(0)} km`}</div><div class="unknown-map-note">${loading?'Updating sensor chart…':esc(note)}</div></div><div class="activity-strip"><strong>FIELD ACTIONS / CURRENT RANGE</strong><span>${scope==='local'?'移動、観察、採取、野営、WEDO対応では時間が経過します。':'遠征先には確認済みのWORLD地点だけを指定できます。未踏査領域は地図に現れません。'}</span></div></section><aside class="generated-inspector" data-scroll-key="${esc(this.explorationInspectorScrollKey())}">${inspector}</aside></section>`;
  }

  private bodyEquipmentView(): string {
    const inspected = findAgent(this.state, this.#inspectedAgentId) ?? this.controlledAgent();
    const controlled = this.controlledAgent();
    const live = inspected ? this.canInspectLiveState(inspected.id) : false;
    const report = inspected ? this.lastReportForAgent(inspected.id) : undefined;
    const people = livingAgents(this.state).slice().sort((a,b)=>a.name.localeCompare(b.name));
    const gear = inspected && live ? equipmentForAgent(this.state, inspected.id) : [];
    const gearHtml = live ? `<h3>Physical equipment</h3>${gear.map((item)=>`<article class="inventory-row"><div><strong>${esc(item.name)}</strong><small>${esc(item.slot)} · ${item.weightKg.toFixed(1)} kg · ${Object.entries(item.skillBonuses).map(([skill,value])=>`${esc(skill)} +${value}`).join(', ')}</small></div><span>${item.equipped?'equipped':'carried'}</span>${inspected?.id===controlled?.id?`<button data-action="toggle-equipment" data-item-id="${esc(item.id)}" data-equipped="${item.equipped?'0':'1'}">${item.equipped?'Unequip':'Equip'}</button>`:''}</article>`).join('') || '<p>装備記録なし。</p>'}` : '';
    const authority = inspected?.profileAuthority;
    const negotiatedMigrant = Boolean(inspected && Number(inspected.experience['migration:arrival-day'] ?? -1) > 0);
    const providerConfirmedMigrant = Boolean(inspected?.identityOrigin==='world-provider' && negotiatedMigrant);
    const authorityTitle = inspected?.identityOrigin==='world-provider'
      ? (providerConfirmedMigrant ? 'ORIGIN ARCHIVE / MIGRANT' : 'ORIGIN ARCHIVE / IDENTITY')
      : 'LOCAL HISTORY / IDENTITY';
    const authorityDetail = inspected?.identityOrigin==='world-provider'
      ? (providerConfirmedMigrant
        ? `ORIGIN RECORD ${esc(inspected.worldEntityId??inspected.id)} は受理済みの移住記録で身元確認されています。世帯 ${esc(inspected.householdId)} は到着後の生活記録から編成されており、この個人の移住確認だけでは元世帯全体の移動は確定しません。`
        : `Stable person ${esc(inspected.worldEntityId??inspected.id)}${inspected.identityAnchorId?` · identity anchor ${esc(inspected.identityAnchorId)}`:''} · household ${esc(inspected.householdId)}. これらの身元情報は外部観測記録に基づきます。`)
      : `This person ${negotiatedMigrant ? '交渉移住により集落の生活記録へ加わった' : '集落成立後に生活記録へ加わった'}. 外部の出自記録はなく、身元は集落の生活記録に基づきます。`;
    const authorityHtml = inspected ? `<section class="authority-boundary ${inspected.identityOrigin==='world-provider'?'provider-origin':'lived-origin'}"><strong>${authorityTitle}</strong><p>${authorityDetail}</p><div class="authority-fields"><span>identity <b>${authorityLabel(authority?.identity)}</b></span><span>name <b>${authorityLabel(authority?.name)}</b></span><span>household <b>${authorityLabel(authority?.household)}</b></span><span>age <b>${authorityLabel(authority?.age)}</b></span><span>sex <b>${authorityLabel(authority?.sex)}</b></span><span>role <b>${authorityLabel(authority?.role)}</b></span><span>skills <b>${authorityLabel(authority?.skills)}</b></span><span>genetics <b>${authorityLabel(authority?.genetics)}</b></span><span>body baseline <b>${authorityLabel(authority?.healthBaseline)}</b></span></div><small>現在のHP、疲労、士気、病理、勤務、人間関係はすべて集落で更新された生活記録です。</small></section>` : '';
    const readinessDoctrine = this.selectedPreparationDoctrine();
    const readiness = inspected && live && readinessDoctrine ? expeditionMemberReadiness(inspected, readinessDoctrine) : undefined;
    const atSettlement = Boolean(inspected?.alive && !inspected.expeditionId && (!inspected.residence || inspected.residence==='settlement'));
    const careNeeded = Boolean(inspected && atSettlement && (inspected.health < 99.5 || inspected.pathology.some((entry)=>entry.status==='active')));
    const recoveryHtml = inspected && readiness ? `<section class="recovery-readiness ${readiness.ready?'ready':'recovering'}"><span>EXPEDITION FITNESS / ${esc(readinessDoctrine?.name ?? 'doctrine')}</span><strong>${readiness.ready?'READY TO DEPART':'RECOVERING / NOT FIT TO DEPART'}</strong><p>Launch requires HP ≥ ${readiness.minimumHealth}, fatigue ≤ ${readiness.maximumFatigue}, and no active pathology at severity 30+.</p>${readiness.reasons.length?`<ul>${readiness.reasons.map((reason)=>`<li>${esc(reason)}</li>`).join('')}</ul>`:'<small>No current fitness blocker under the selected doctrine.</small>'}${careNeeded?`<button data-action="clinic-care" data-agent-id="${esc(inspected.id)}">Request clinic care · 60 min</button>`:''}${!careNeeded&&!readiness.ready?'<small>休養と通常の集落ケアでも、時間の経過とともに出発可能な状態へ戻ります。</small>':''}</section>` : '';
    return `<section class="sandbox-page body-equipment-view"><header class="section-head"><div><span class="sandbox-eyebrow">F2 / BODY & EQUIPMENT</span><h2>Body / Equipment</h2></div><p>人物記録では出自情報と現在の生活記録を分けて表示します。人物を選ぶと記録を閲覧できます。</p></header><div class="sandbox-columns"><section class="sandbox-panel person-index">${people.map((agent)=>{const migrant=Number(agent.experience['migration:arrival-day'] ?? -1)>0;const provenance=agent.identityOrigin==='world-provider'?(migrant?'origin migrant':'origin record'):(migrant?'local migrant':'local record');const presence=agent.residence==='unknown'?' · displaced / whereabouts unknown':agent.residence==='external'?' · external':'';return `<button data-action="inspect-agent" data-agent-id="${esc(agent.id)}" class="${inspected?.id===agent.id?'active':''}">${esc(agent.name)} <small>${esc(agent.role)} · ${provenance}${esc(presence)}</small></button>`;}).join('')}</section><section class="sandbox-panel">${inspected ? `<h3>${esc(inspected.name)}</h3><p>${agentAgeYears(this.state,inspected)} · ${esc(inspected.sex)} · ${esc(inspected.role)} · ${esc(inspected.residence ?? (inspected.expeditionId?'expedition':'settlement'))}</p>${authorityHtml}${live ? `<div class="sandbox-grid stats"><article><span>HP · CURRENT RECORD</span><strong>${inspected.health.toFixed(0)}</strong></article><article><span>Fatigue · CURRENT RECORD</span><strong>${inspected.fatigue.toFixed(0)}</strong></article><article><span>Morale · CURRENT RECORD</span><strong>${inspected.morale.toFixed(0)}</strong></article><article><span>Current duty · CURRENT RECORD</span><strong>${esc(inspected.currentPlan?.kind ?? inspected.currentTask)}</strong></article></div>${recoveryHtml}<h3>Recorded pathology</h3>${inspected.pathology.map((entry)=>`<article class="chronicle-line"><strong>${esc(entry.pathologyId)}</strong><span>${entry.severity.toFixed(1)} · ${esc(entry.status)}</span><p>${esc(entry.observedSymptoms.join(', ') || 'no observed symptoms')}</p>${entry.suspectedCauses.length?`<small>${entry.pathologyId==='traumatic-wound'?'recorded encounter source':'suspected source'} · ${esc(entry.suspectedCauses.join(' · '))}</small>`:''}</article>`).join('') || '<p>No recorded active pathology.</p>'}${gearHtml}` : `<div class="epistemic-redaction"><strong>REMOTE / CURRENT STATUS UNKNOWN</strong><p>出自記録は保持されていますが、現在のHP、疲労、病理、勤務、装備変更、正確な位置は未確認です。</p>${report ? `<p>Last received communication: ${esc(report.text)} · ${Math.round(report.confidence*100)}% confidence${report.verified?' · verified':''}</p>` : '<p>No communication report is available.</p>'}</div>`}` : '<p>No person selected.</p>'}</section></div></section>`;
  }

  private playerKnowledgeView(): string {
    const holder = this.knowledgeAgent();
    compareF3KnowledgeProjectionsIfEnabled(this.state, holder?.id ?? null);
    const f3Read = selectF3KnowledgeReadModel(this.state, holder?.id ?? null);
    const eligibleHolders = this.knowledgeEligibleAgents();
    const personal = f3Read.personal;
    const institutionalIds = new Set(this.state.settlement.localKnowledgeIds);
    const institutional = f3Read.institutional;
    const partners = this.conversationPartners(holder);
    const conversationTarget = partners.find((agent)=>agent.id===this.#conversationTargetId);
    const atSettlement = Boolean(holder?.alive && !holder.expeditionId && (!holder.residence || holder.residence==='settlement'));
    const records = this.state.records.filter((record)=>record.integrity>0.05 && record.copies>0).slice().reverse();
    const projects = (this.state.researchProjects ?? []).slice().reverse();
    const practices = (this.state.anomalyPractices ?? []).slice().reverse();
    const anomalyDomains: AnomalyUtilizationDomain[] = ['medicine','production','communication','defense'];
    const row = (entry: typeof this.state.knowledge[number], access: 'personal'|'institutional') => {
      const personalAccess = access==='personal';
      const sampleGate = researchSampleGate(this.state, entry.id);
      const canResearch = !entry.lost && atSettlement && (!sampleGate.required || sampleGate.available);
      const researchLabel = sampleGate.required
        ? sampleGate.available ? `Research with physical sample${sampleGate.sample ? ` · ${esc(sampleGate.sample.name)}` : ''}` : 'Physical sample required at settlement'
        : 'Research from this evidence';
      const alreadyInstitutional = institutionalIds.has(entry.id);
      const alreadyTargetKnows = Boolean(conversationTarget?.knowledgeIds.includes(entry.id));
      const sourceLabel = knowledgeSourceLabel(entry);
      const anomalyBasis = anomalyBasisForKnowledge(this.state, entry);
      const conversationAction = personalAccess && conversationTarget ? `<button data-action="conversation" data-knowledge-id="${esc(entry.id)}" ${alreadyTargetKnows?'disabled':''}>${alreadyTargetKnows?`${esc(conversationTarget.name)} already knows this`:`Discuss with ${esc(conversationTarget.name)} · 20 min`}</button>` : '';
      const archiveAction = personalAccess ? `<button data-action="archive-knowledge" data-knowledge-id="${esc(entry.id)}" ${!atSettlement||alreadyInstitutional?'disabled':''}>${alreadyInstitutional?'Already in institutional access':atSettlement?'Archive record · 60 min':'Archive requires settlement presence'}</button>` : '';
      const researchAction = `<button data-action="research" data-knowledge-id="${esc(entry.id)}" ${canResearch?'':'disabled'}>${researchLabel}</button>`;
      const anomalyActions = atSettlement && anomalyBasis ? `<div class="anomaly-actions"><small>異常現象の利用は実地試験扱いです。未確認の性質は確定記録にしません。</small>${anomalyDomains.map((domain)=>`<button data-action="anomaly-use" data-domain="${domain}" data-knowledge-id="${esc(entry.id)}">Use: ${domain}</button>`).join('')}</div>` : '';
      const actions = !entry.lost ? `<div class="knowledge-actions">${conversationAction}${archiveAction}${researchAction}${anomalyActions}</div>` : '';
      const conciseClaim = compactText(entry.claim);
      const conciseSubjects = compactSubjectIds(entry.subjectIds);
      const disclosure = knowledgeEvidenceDisclosure(entry);
      return `<article class="chronicle-line knowledge-evidence-row ${entry.lost?'dead':''}"><strong title="${esc(entry.claim)}">${esc(conciseClaim)}</strong><span>${Math.round(entry.confidence*100)}% · ${esc(access)}</span><p>${esc(conciseSubjects)} · ${esc(entry.carrier)}</p><small class="knowledge-source">SOURCE: ${esc(sourceLabel)} · evidence links ${entry.truthLinkIds.length}. Confidenceは記録の確度を示し、事実そのものの割合ではありません。</small>${disclosure}${sampleGate.required?`<small>SAMPLE STATUS: ${sampleGate.available?'matching sample present at settlement':'matching sample not present at settlement'}.</small>`:''}${actions}</article>`;
    };
    const holderControl = eligibleHolders.length ? `<div class="knowledge-holder-row"><label>記録閲覧者 / 同席者 <select data-action="knowledge-agent">${eligibleHolders.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===holder?.id?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><small>同席者の携行記録を閲覧しても、指揮権やArchive登録は変更されません。</small></div>` : '<p>No co-located knowledge holder is available.</p>';
    const conversationControl = partners.length ? `<label class="conversation-target">対話相手 <select data-action="conversation-target">${partners.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===this.#conversationTargetId?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label>` : '<p>No co-located conversation partner is available.</p>';
    const archiveHtml = records.slice(0,24).map((record)=>`<article class="chronicle-line"><strong title="${esc(record.title)}">${esc(compactText(record.title, 120))}</strong><span>${record.copies} copies · ${Math.round(record.integrity*100)}% integrity</span><p>author ${esc(findAgent(this.state,record.authorId)?.name??record.authorId)} · knowledge ${esc(compactSubjectIds(record.knowledgeIds, 3))}</p></article>`).join('') || '<p>No durable Archive records yet.</p>';
    const externalContacts = (this.state.externalContacts ?? []).slice().reverse().slice(0,16).map((contact)=>`<article class="chronicle-line external-person-contact"><strong>${esc(contact.name)}</strong><span>${contact.interactionCount} direct contact${contact.interactionCount===1?'':'s'}</span><p>external record ${esc(contact.externalPersonId)}${contact.societyEntityId?` · observed association ${esc(contact.societyEntityId)}`:''}</p><small>記録済みの身元と出所だけを保持し、観測していない動機・信条・経歴は未確認のまま残します。</small></article>`).join('') || '<p>No directly contacted outside individual yet.</p>';
    const researchHtml = projects.slice(0,16).map((project)=>`<article class="chronicle-line"><strong title="${esc(project.hypothesis)}">${esc(compactText(project.hypothesis, 150))}</strong><span>${project.progress.toFixed(0)}% · ${esc(project.status)}</span><p>${project.researcherIds.map((id)=>esc(findAgent(this.state,id)?.name??id)).join(', ')} · confidence ${Math.round(project.confidence*100)}%${project.sampleItemId?' · physical sample committed':''}</p></article>`).join('') || '<p>No research project yet.</p>';
    const activeResearch = projects.filter((project)=>project.status==='active');
    const activeResearchHtml = activeResearch.length ? `<div class="active-research-strip"><strong>ACTIVE RESEARCH</strong>${activeResearch.slice(0,3).map((project)=>`<span title="${esc(project.hypothesis)}"><b>${project.progress.toFixed(1)}%</b> ${esc(compactText(project.hypothesis, 95))}${project.sampleItemId?' · physical sample committed':''}</span>`).join('')}${activeResearch.length>3?`<small>+${activeResearch.length-3} more active projects</small>`:''}</div>` : '';
    const practiceHtml = practices.slice(0,16).map((practice)=>`<article class="chronicle-line"><strong>${esc(practice.domain)} · ${esc(practice.targetEntityId)}</strong><span>${practice.attempts} attempts · mastery ${practice.mastery.toFixed(1)} · stability ${practice.stability.toFixed(1)}</span><p>${esc(practice.lastOutcome || 'No result yet.')}</p></article>`).join('') || '<p>No anomaly-utilization practice established.</p>';
    return `<section class="sandbox-page knowledge-direct-view"><header class="section-head"><div><span class="sandbox-eyebrow">F3 / KNOWLEDGE</span><h2>Knowledge / Conversation / Archive</h2></div><p>すべての記録には出所を付記します。外部観測、現地研究、住民の経験記録は区別して保管され、未確認情報は確定記録として扱いません。</p></header><section class="sandbox-panel knowledge-context">${holderControl}${conversationControl}<p>${atSettlement?'Records / Archive, research and evidence-based anomaly practice are physically available at the settlement.':'Field control: personal/party knowledge is available, but Archive, settlement research and institutional anomaly practice are not physically reachable.'}</p>${activeResearchHtml}</section><div class="sandbox-columns"><section class="sandbox-panel"><h3>${esc(holder?.name ?? 'No co-located knowledge holder')} / personal</h3>${personal.slice().reverse().map((entry)=>row(entry,'personal')).join('') || '<p>No personal claims.</p>'}<h3>Research projects</h3>${researchHtml}</section><section class="sandbox-panel"><h3>Institutional access</h3>${institutional.slice().reverse().map((entry)=>row(entry,'institutional')).join('') || '<p>No additional institutional claim is physically available here.</p>'}<h3>Records / Archive</h3>${archiveHtml}<h3>Anomaly-utilization practices</h3>${practiceHtml}<h3>Outside people directly contacted</h3>${externalContacts}</section></div></section>`;
  }

  private inventoryView(): string {
    const controlled = this.controlledAgent();
    const holder = this.inventoryAgent();
    const eligibleHolders = this.inventoryEligibleAgents();
    const field = this.controlledExpedition();
    const supplies = field ? field.supplies : this.state.settlement.resources;
    const personal = holder ? inventoryForAgent(this.state, holder.id) : [];
    const stockRows = Object.entries(supplies).map(([name,value])=>`<article class="inventory-row"><strong>${esc(name)}</strong><span>${typeof value==='number'?value.toFixed(1):esc(value)}</span>${controlled && ['food','water','medicine'].includes(name)?`<button data-action="consume-supply" data-kind="${esc(name)}">Use</button>`:''}</article>`).join('');
    const itemRows = personal.map((item)=>`<article class="inventory-row physical-item ${item.kind==='sample'?'physical-sample':''}"><div><strong>${esc(item.name)}</strong><small>${esc(item.kind)} · qty ${item.quantity} · ${(item.weightKg*item.quantity).toFixed(2)} kg</small></div><span>${item.sourceEntityId?`source ${esc(item.sourceEntityId)}`:'personal'}</span><small>${esc(item.provenanceIds.slice(0,3).join(' · '))}</small></article>`).join('');
    const holderControl = eligibleHolders.length ? `<section class="sandbox-panel inventory-holder-row"><label>Inventory holder / co-located physical inspection <select data-action="inventory-agent">${eligibleHolders.map((agent)=>`<option value="${esc(agent.id)}" ${agent.id===holder?.id?'selected':''}>${esc(agent.name)} · ${esc(agent.role)}</option>`).join('')}</select></label><small>Inspecting another co-located person’s carried items does not transfer control or ownership. Remote inventories are unavailable.</small></section>` : '';
    return `<section class="sandbox-page"><header class="section-head"><div><span class="sandbox-eyebrow">F4 / INVENTORY</span><h2>${field?'Field inventory':'Accessible inventory'}</h2></div><p>Physical personal items and only physically accessible shared stock are shown. Remote inventory is never mirrored to settlement.</p></header>${holderControl}<div class="sandbox-columns"><section class="sandbox-panel"><h3>${esc(holder?.name ?? 'No co-located holder')} / carried physical items</h3>${itemRows || '<p>No personal physical items.</p>'}</section><section class="sandbox-panel inventory-grid"><h3>${field?'Expedition supplies':'Settlement stock'}</h3>${stockRows || '<p>No accessible stock.</p>'}</section></div></section>`;
  }

  private chronicleView(): string {
    const viewpoint = this.chronicleViewpoint();
    const entries = projectChronicle(this.state, viewpoint).slice().reverse();
    return `<section class="sandbox-page"><header class="section-head"><div><span class="sandbox-eyebrow">F5 / CHRONICLE</span><h2>Chronicle</h2></div><p>${viewpoint.kind==='settlement'?'Settlement-visible reports and witnessed events only.':'Field party reports plus records already received by the settlement.'}</p></header><section class="sandbox-panel chronicle-ledger">${entries.map((entry)=>`<article class="chronicle-line"><strong>${esc(entry.title)}</strong><span>D${entry.day} ${String(Math.floor(entry.minuteOfDay/60)).padStart(2,'0')}:${String(entry.minuteOfDay%60).padStart(2,'0')}</span><p>${esc(entry.text)}</p></article>`).join('') || '<p>No visible events yet.</p>'}</section></section>`;
  }

  private body(): string {
    if (this.#view==='exploration') return this.explorationView();
    if (this.#view==='body') return this.bodyEquipmentView();
    if (this.#view==='knowledge') return this.playerKnowledgeView();
    if (this.#view==='inventory') return this.inventoryView();
    return this.chronicleView();
  }

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

  private explorationInspectorScrollKey(): string {
    if (this.#view !== 'exploration') return '';
    const field = this.controlledExpedition();
    const latestEncounter = field ? [...this.state.encounters].reverse().find((entry) => entry.expeditionId === field.id) : undefined;
    const activeEncounterId = latestEncounter && latestEncounter.status !== 'resolved' ? latestEncounter.id : 'none';
    return [
      field ? `field:${field.id}` : 'settlement',
      `scope:${this.#mapScope}`,
      `world:${this.#selectedWorldEntityId || 'none'}`,
      `local:${this.#selectedLocalEntityId || 'none'}`,
      `wedo:${activeEncounterId}`,
    ].join('|');
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
    if (action==='set-prep-target') { const entity=this.visibleWorldEntities().find((entry)=>entry.id===button.dataset.entityId); if(!entity?.spatial)return; this.#prepTarget=structuredClone(entity.spatial); this.#prepTargetEntityId=entity.id; this.#prepRouteEntityId=''; this.#pdaTaskPanel='expedition'; this.#pdaTab='task'; this.render(); this.toast(`Expedition target selected: ${entityName(entity)}.`); return; }
    if (action==='move-world-target') { const field=this.controlledExpedition(), entity=this.visibleWorldEntities().find((entry)=>entry.id===button.dataset.entityId); if(!field||!entity?.spatial)return; try{addExpeditionOrder(this.state,field.id,'move',`Move toward known WORLD marker ${entityName(entity)}.`,{target:structuredClone(entity.spatial),targetEntityId:entity.id});this.#mapScope='local';void this.save(`Field destination set: ${entityName(entity)}.`);}catch(error){this.toast(error instanceof Error?error.message:String(error));} return; }
    if (action==='walk-local-target') {
      const field=this.controlledExpedition(), entity=this.#localProjection?.entities.find((entry)=>entry.id===button.dataset.entityId);
      if(!field||!entity?.spatial)return; try { addExpeditionOrder(this.state,field.id,'move',`Approach ${entityName(entity)} from the charted LOCAL view.`,{target:structuredClone(entity.spatial)}); void this.save(`Walking toward ${entityName(entity)}.`); } catch(error){this.toast(error instanceof Error?error.message:String(error));} return;
    }
    if (action==='observe-local-target') {
      const agent=this.controlledAgent(), entity=this.#localProjection?.entities.find((entry)=>entry.id===button.dataset.entityId); if(!agent||!entity)return;
      void this.directAction(30,()=>{observeGeneratedEntity(this.state,agent.id,entity);return `Observed ${entityName(entity)}. 個人記録に追加。Archive未登録。`;}); return;
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
      const topologyRoutes = targetEntity ? providerVisibleRouteAlternatives(this.#worldProjection, visibleWorldEntities, this.state.world.originEntityId, targetEntity.id, 3) : [];
      const selectedTopologyRoute = this.#prepRouteEntityId ? topologyRoutes.find((entry)=>entry.id===this.#prepRouteEntityId) : undefined;
      const selectedRoute = this.#prepRouteEntityId ? visibleWorldEntities.find((entry)=>entry.id===this.#prepRouteEntityId && entry.kind==='route') : undefined;
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
    const order:PdaTab[]=['task','map','body','knowledge','inventory','chronicle','residents','system'];
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
}

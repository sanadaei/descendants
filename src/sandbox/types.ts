import type { SpatialRef, WorldManifest, WorldSnapshot, WorldTick } from '../worldbridge/contract.js';
import type { GameClockState, WorldClockPolicy } from '../worldbridge/worldClock.js';
import type { KnowledgeStoreSnapshotV1 } from './knowledgeStore.js';

export type SandboxStatus = 'running' | 'local-collapse' | 'post-ending';
export type Sex = 'female' | 'male';
export type AgentResidence = 'settlement' | 'expedition' | 'external' | 'unknown';
export type AgentRole = 'leader' | 'medic' | 'scout' | 'builder' | 'forager' | 'water' | 'caregiver' | 'recorder' | 'guard' | 'generalist' | 'child';
export type NeedKey = 'hunger' | 'thirst' | 'rest' | 'safety' | 'belonging';
export type SkillKey = 'survival' | 'medicine' | 'construction' | 'foraging' | 'scouting' | 'combat' | 'care' | 'records' | 'leadership' | 'trade';
export type SettlementResourceKey = 'food' | 'water' | 'medicine' | 'timber' | 'scrap' | 'fuel' | 'cloth' | 'records';
export type LaborTask = 'forage' | 'water' | 'medicine' | 'repair' | 'sanitation' | 'care' | 'records' | 'guard' | 'rest' | 'explore-prep';
export type RelationKind = 'kin' | 'friend' | 'partner' | 'rival' | 'mentor' | 'trust' | 'fear';
export type ExpeditionControlMode = 'settlement' | 'expedition';
export type ExpeditionPace = 'cautious' | 'normal' | 'fast';
export type ExpeditionStatus = 'forming' | 'outbound' | 'exploring' | 'returning' | 'returned' | 'missing' | 'destroyed' | 'joined-elsewhere' | 'captured' | 'time-displaced';
export type ExpeditionOrderKind = 'move' | 'observe' | 'camp' | 'return' | 'avoid' | 'contact' | 'rescue' | 'hold';
export type ExpeditionFieldDecisionKind = 'wait-camp' | 'return' | 'retry-replan';
export type ExpeditionFieldDecisionStatus = 'active' | 'completed' | 'failed';
export type CommunicationStatus = 'connected' | 'delayed' | 'silent' | 'falsified' | 'altered' | 'unknown';
export type EncounterInstruction = 'avoid' | 'withdraw' | 'defend' | 'advance' | 'protect-wounded' | 'capture' | 'break-contact';
export type EncounterStatus = 'queued' | 'active' | 'resolved';
export type AnomalyUtilizationDomain = 'medicine' | 'production' | 'communication' | 'defense';
export type KnowledgeCarrier = 'memory' | 'oral' | 'record' | 'institution';
export type PregnancyOutcome = 'ongoing' | 'birth' | 'loss';
export type EquipmentSlot = 'body' | 'outer' | 'hands' | 'feet' | 'tool';
export type PhysicalInventoryKind = 'sample' | 'resource' | 'tool' | 'record' | 'personal';
export type DirectActivityKind = 'observe' | 'sample' | 'harvest' | 'conversation' | 'clinic' | 'research' | 'assembly' | 'records' | 'survey' | 'eat' | 'drink' | 'medicine' | 'equipment' | 'camp' | 'combat' | 'external';
export type GameplayDataAuthority = 'provider-projected' | 'game-derived' | 'lived-game-state';

export interface AgentNeeds extends Record<NeedKey, number> {}
export interface AgentSkills extends Record<SkillKey, number> {}

export interface AgentPersonality {
  curiosity: number;
  caution: number;
  sociability: number;
  autonomy: number;
  empathy: number;
}

export interface AgentFaithProfile {
  commitment: number;
  interpretationTags: string[];
}

export interface AgentSocialStatus {
  standing: number;
  dependency: number;
  outsider: number;
}

export interface GeneticProfile {
  lineageMarker: string;
  loci: Record<string, number>;
  anomalyTraits: string[];
}

export interface PathologyCase {
  id: string;
  pathologyId: string;
  onsetDay: number;
  severity: number;
  contagious: boolean;
  observedSymptoms: string[];
  suspectedCauses: string[];
  treatmentsTried: string[];
  status: 'active' | 'resolved' | 'chronic' | 'unknown';
}

export interface AgentMemory {
  id: string;
  day: number;
  kind: 'event' | 'social' | 'knowledge' | 'trauma' | 'success' | 'order';
  text: string;
  salience: number;
  sourceIds: string[];
}

export interface AgentBelief {
  id: string;
  subjectIds: string[];
  claim: string;
  confidence: number;
  basisKnowledgeIds: string[];
}

export interface AgentPlan {
  id: string;
  kind: LaborTask | 'seek-care' | 'socialize' | 'refuse-order';
  priority: number;
  targetId?: string;
  reason: string;
}

export interface AgentRelation {
  targetId: string;
  /** Whether this edge came from a projected WorldProvider relation or emerged after play began. */
  authority?: 'provider-projected' | 'lived-game-state';
  kind: RelationKind;
  affinity: number;
  trust: number;
  obligation: number;
  /** Stable WorldProvider relation backing this social edge, when one exists. */
  worldRelationId?: string;
  worldProvenanceIds?: string[];
  sourceWorldRelationKind?: string;
}


export interface AgentProfileAuthority {
  identity: GameplayDataAuthority;
  name: GameplayDataAuthority;
  household: GameplayDataAuthority;
  age: GameplayDataAuthority;
  sex: GameplayDataAuthority;
  role: GameplayDataAuthority;
  skills: GameplayDataAuthority;
  genetics: GameplayDataAuthority;
  healthBaseline: GameplayDataAuthority;
  personality: GameplayDataAuthority;
  faith: GameplayDataAuthority;
}

export interface AuthorityProfile {
  offices: string[];
  legitimacy: number;
  obedience: number;
  refusalThreshold: number;
}

export interface SandboxAgent {
  id: string;
  /** Initial identities are provider-projected; people born after simulation start are lived game-state identities. */
  identityOrigin?: 'world-provider' | 'lived-game-state';
  /** Field-level provenance label so UI never presents deterministic interpretations as raw Worldgen facts. */
  profileAuthority?: AgentProfileAuthority;
  /** Provider-owned individual identity when the agent was materialized from Worldgen. */
  worldEntityId?: string;
  identityAnchorId?: string;
  worldProvenanceIds?: string[];
  /** Fine-LOD realization causes may change when the same stable identity is re-materialized. */
  materializationProvenanceIds?: string[];
  sampleWeight?: number;
  name: string;
  sex: Sex;
  naming?: { languageVersion: 1; givenName: string; familyName: string; fullName: string; sourceName?: string };
  aptitude?: AgentSkills;
  education?: { mentorId: string | null; focus: SkillKey; hours: number; lastKnowledgeHour: number };
  bornDay: number;
  alive: boolean;
  deathDay: number | null;
  causeOfDeath: string;
  role: AgentRole;
  householdId: string;
  parentIds: string[];
  partnerIds: string[];
  genetics: GeneticProfile;
  health: number;
  fatigue: number;
  morale: number;
  needs: AgentNeeds;
  skills: AgentSkills;
  goals: string[];
  fears: string[];
  beliefs: AgentBelief[];
  memories: AgentMemory[];
  relations: AgentRelation[];
  knowledgeIds: string[];
  pathology: PathologyCase[];
  authority: AuthorityProfile;
  currentPlan: AgentPlan | null;
  currentTask: LaborTask;
  expeditionId: string | null;
  residence?: AgentResidence;
  experience: Record<string, number>;
  personality?: AgentPersonality;
  faith?: AgentFaithProfile;
  affiliationIds?: string[];
  socialStatus?: AgentSocialStatus;
}

export interface HouseholdDisplacementState {
  status: 'displaced' | 'returned';
  displacedDay: number;
  displacedMinuteOfDay: number;
  displacementProviderSourceId: string;
  displacedMemberIds: string[];
  displacementProvenanceIds: string[];
  returnedDay?: number;
  returnedMinuteOfDay?: number;
  returnProviderSourceId?: string;
  returnProvenanceIds?: string[];
}

export interface Household {
  id: string;
  worldEntityId?: string;
  worldProvenanceIds?: string[];
  memberIds: string[];
  housingUnitId: string;
  stores: Partial<Record<SettlementResourceKey, number>>;
  /** Only provider-explicit household movement may create or advance this state. Individual movement never implies it. */
  displacement?: HouseholdDisplacementState;
}

export interface Institution {
  id: string;
  worldEntityId?: string;
  worldProvenanceIds?: string[];
  sourceWorldInstitutionType?: string;
  kind: 'leadership' | 'clinic' | 'records' | 'childcare' | 'distribution' | 'watch' | 'assembly';
  name: string;
  memberIds: string[];
  authorityRules: string[];
  recordIds: string[];
}

export interface SettlementResources extends Record<SettlementResourceKey, number> {}

export type ResourceSourceKind = 'ecological-resource' | 'ecological-guild' | 'settlement-stock' | 'institution' | 'trade' | 'legacy' | 'system-adjustment';
export type ResourceCanonicalUnit = 'ration-unit' | 'liter' | 'dose-unit' | 'material-unit' | 'fuel-unit' | 'cloth-unit' | 'record-copy';
export type ResourceProcessingKind = 'raw' | 'cleaned' | 'cooked' | 'dried' | 'smoked' | 'filtered' | 'boiled' | 'prepared' | 'repaired' | 'copied' | 'reconciled';

export interface ResourceProcessingStep {
  kind: ResourceProcessingKind;
  day: number;
  minuteOfDay: number;
  agentIds: string[];
  note: string;
}

export interface ResourceWaterQuality {
  microbialRisk: number;
  chemicalRisk: number;
  turbidity: number;
}

export interface ResourceSourceState {
  id: string;
  resourceKey: SettlementResourceKey;
  kind: ResourceSourceKind;
  subtype: string;
  label: string;
  worldEntityIds: string[];
  worldProvenanceIds: string[];
  position?: SpatialRef;
  regionId?: string;
  renewable: boolean;
  accessibleStock: number;
  carryingCapacity: number;
  regenerationPerDay: number;
  depletionFraction: number;
  lastHarvestDay?: number;
  lastHarvestMinuteOfDay?: number;
}

export interface ResourceCustodyStep {
  holderId?: string;
  storageLocationId?: string;
  day: number;
  minuteOfDay: number;
  note: string;
}

export interface ResourceLotState {
  id: string;
  resourceKey: SettlementResourceKey;
  subtype: string;
  label: string;
  quantity: number;
  unit: ResourceCanonicalUnit;
  sourceId: string;
  worldEntityIds: string[];
  worldProvenanceIds: string[];
  createdDay: number;
  createdMinuteOfDay: number;
  harvesterIds: string[];
  sourcePosition?: SpatialRef;
  condition: number;
  freshness: number;
  contaminationRisk: number;
  waterQuality?: ResourceWaterQuality;
  processingHistory: ResourceProcessingStep[];
  parentLotIds: string[];
  storageLocationId?: string;
  containerId?: string;
  custodyHistory?: ResourceCustodyStep[];
}

export interface ResourceAllocationGroup {
  id: string;
  name: string;
  memberIds: string[];
  createdDay: number;
  createdMinuteOfDay: number;
  updatedDay: number;
  updatedMinuteOfDay: number;
}

export interface ResourceAllocationRule {
  id: string;
  name: string;
  groupId: string;
  resourceKey: SettlementResourceKey;
  lotIds: string[];
  subtypes: string[];
  amountPerPersonPerDay: number;
  priority: number;
  exclusive: boolean;
  enabled: boolean;
  createdDay: number;
  createdMinuteOfDay: number;
  updatedDay: number;
  updatedMinuteOfDay: number;
}

export interface ResourceDistributionLine {
  agentId: string;
  lotId: string;
  quantity: number;
}

export interface ResourceDistributionEvent {
  id: string;
  resourceKey: SettlementResourceKey;
  day: number;
  minuteOfDay: number;
  lines: ResourceDistributionLine[];
}

export interface ResourceLedgerStateV1 {
  schemaVersion: 1;
  sources: ResourceSourceState[];
  lots: ResourceLotState[];
  allocationGroups: ResourceAllocationGroup[];
  allocationRules: ResourceAllocationRule[];
  recentDistributions: ResourceDistributionEvent[];
}

export interface SettlementState {
  id: string;
  worldEntityId: string;
  name: string;
  position: SpatialRef;
  leaderId: string;
  successionRule: 'assembly-trust' | 'seniority' | 'appointed' | 'skill';
  resources: SettlementResources;
  housingCapacity: number;
  sanitation: number;
  waterSafety: number;
  clinicCapacity: number;
  childcareCapacity: number;
  defense: number;
  laborPriorities: Record<LaborTask, number>;
  households: Household[];
  institutions: Institution[];
  localKnowledgeIds: string[];
  activeRecordIds: string[];
}

export interface KnowledgeEntry {
  id: string;
  subjectIds: string[];
  claim: string;
  confidence: number;
  acquiredDay: number;
  carrier: KnowledgeCarrier;
  holderIds: string[];
  sourceKnowledgeId?: string;
  sourceWorldKnowledgeId?: string;
  truthLinkIds: string[];
  lost: boolean;
  /** Optional direct-play evidence metadata; kept separate from provider truthLink provenance. */
  physicalEvidenceSourceEntityId?: string;
  requiresPhysicalSample?: boolean;
  /** Only fields actually projected during close observation; never read from hidden snapshots. */
  entityObservation?: {
    entityId: string;
    kind: string;
    subtype?: string;
    traceType?: string;
    resourceKeys: SettlementResourceKey[];
    position?: SpatialRef;
  };
  /** A recorded local treatment outcome, not a universal causal claim. */
  treatmentObservation?: {
    patientId: string;
    caseId: string;
    pathologyId: string;
    practice: string;
    severityBefore: number;
    severityAfter: number;
  };
}

export interface ResearchProject {
  id: string;
  sourceKnowledgeId: string;
  subjectIds: string[];
  hypothesis: string;
  researcherIds: string[];
  basisKnowledgeIds: string[];
  startedDay: number;
  completedDay: number | null;
  progress: number;
  confidence: number;
  status: 'active' | 'completed' | 'abandoned';
  resultKnowledgeId?: string;
  sampleItemId?: string;
  sampleSourceEntityId?: string;
  practicalOutcome?: string;
  /** Actual research hours; absent on saves from before labor allocation was connected. */
  contributors?: Array<{ agentId: string; hours: number }>;
  pauseReason?: string;
}

export interface AnomalyUtilizationPractice {
  id: string;
  sourceKnowledgeId: string;
  targetEntityId: string;
  inferredVariableId: string | null;
  domain: AnomalyUtilizationDomain;
  operatorIds: string[];
  attempts: number;
  mastery: number;
  stability: number;
  startedDay: number;
  lastAttemptDay: number;
  lastOutcome: string;
  providerEventIds: string[];
}

export interface SettlementPolicyProposal {
  id: string;
  proposerId: string;
  task: LaborTask;
  delta: number;
  day: number;
  supporterIds: string[];
  opponentIds: string[];
  status: 'accepted' | 'rejected';
  rationale: string;
}

export interface SocialRecord {
  id: string;
  title: string;
  body: string;
  createdDay: number;
  authorId: string;
  knowledgeIds: string[];
  copies: number;
  integrity: number;
}

export interface PregnancyState {
  id: string;
  parentIds: [string, string];
  pregnantAgentId: string;
  conceptionDay: number;
  expectedDay: number;
  outcome: PregnancyOutcome;
  anomalyTags: string[];
}

export interface ExpeditionDoctrine {
  id: string;
  name: string;
  riskTolerance: number;
  retreatHealth: number;
  maxSilentHours: number;
  campBeforeDark: boolean;
  prioritizeRescue: boolean;
  contactPolicy: 'avoid' | 'observe' | 'peaceful' | 'trade' | 'assertive';
  encounterInstruction: EncounterInstruction;
}

export interface ExpeditionOrder {
  id: string;
  kind: ExpeditionOrderKind;
  issuedDay: number;
  issuedMinute: number;
  issuerId: string;
  target?: SpatialRef;
  targetEntityId?: string;
  detail: string;
  epistemicBasisIds: string[];
  unfounded: boolean;
  completed: boolean;
  refused?: boolean;
  resolution?: string;
  /** Retry-stable provider command id allocated on first provider-backed contact attempt. */
  providerCommandId?: string;
}


export interface ExpeditionCommunicationReport {
  id: string;
  day: number;
  minuteOfDay: number;
  status: CommunicationStatus;
  text: string;
  confidence: number;
  perceivedPosition?: SpatialRef;
  verifiedPosition?: SpatialRef;
  verified: boolean;
  sourceIds: string[];
}

export type ExpeditionAlterationKind = 'memory-change' | 'personality-change' | 'body-change' | 'anomalous-pregnancy' | 'parasitism';

export interface ExpeditionAlterationRecord {
  id: string;
  day: number;
  kind: ExpeditionAlterationKind;
  agentId: string;
  detail: string;
  sourceEntityIds: string[];
  persistent: boolean;
}

export interface ExpeditionLossState {
  kind: 'capture' | 'time-displacement' | 'refusal-to-return' | 'joined-community' | 'unknown';
  sinceDay: number;
  detail: string;
  recoverable: boolean;
  sourceEntityIds: string[];
}

export interface ExpeditionObservation {
  id: string;
  day: number;
  minuteOfDay: number;
  location: SpatialRef;
  entityIds: string[];
  worldObservationIds: string[];
  text: string;
  confidence: number;
}

export interface ExpeditionRoutePlan {
  kind: 'provider-topology';
  /** Ordered provider-visible graph nodes from origin through the final target. */
  nodeEntityIds: string[];
  /** Provider relation IDs whose explicit topology defines this path. */
  relationIds: string[];
  /** All route/relation evidence IDs used for observed disruption matching. */
  evidenceIds: string[];
  /** Ordered intermediate physical waypoints; the final destination remains ExpeditionState.destination. */
  waypointEntityIds: string[];
  waypoints: SpatialRef[];
  /** Relation responsible for each waypoint; optional for QA12/backward-compatible saves. */
  waypointRelationIds?: string[];
  currentWaypointIndex: number;
  plannedDistanceKm: number;
  /** Provider tick/signatures that formed this route basis; optional for pre-QA13 saves. */
  basisTick?: WorldTick;
  relationSignatures?: string[];
  /** Dynamic topology state. A blocked plan never advances until replanned or explicitly abandoned. */
  topologyStatus?: 'active' | 'blocked';
  replanCount?: number;
  lastValidatedTick?: WorldTick;
  blockedAtTick?: WorldTick;
  blockedReason?: string;
  blockedEvidenceIds?: string[];
}

export interface ExpeditionFieldDecision {
  id: string;
  kind: ExpeditionFieldDecisionKind;
  status: ExpeditionFieldDecisionStatus;
  issuedDay: number;
  issuedMinute: number;
  issuedTick: WorldTick;
  /** Only wait-camp decisions carry a bounded remaining duration. */
  remainingHours?: number;
  initialHours?: number;
  communicationAtDecision: CommunicationStatus;
  completedDay?: number;
  completedMinute?: number;
  result?: string;
}

export interface ExpeditionExposureState {
  /** Dimensionless game-simulation dose accumulated only from explicit provider-visible environmental evidence. */
  cumulativeDose: number;
  lastIntervalDose: number;
  lastRisk: number;
  lastProviderTick?: WorldTick;
  sourceEntityIds: string[];
  sheltered: boolean;
}

export interface ExpeditionReturnTravelState {
  mode: 'off-network-bearing';
  status: 'active' | 'completed' | 'interrupted';
  startedDay: number;
  startedMinute: number;
  startedTick: WorldTick;
  origin: SpatialRef;
  target: SpatialRef;
  initialDistanceKm: number;
  travelledDistanceKm: number;
  remainingDistanceKm: number;
  lastIntervalDistanceKm: number;
  /** Dead-reckoning uncertainty is a gameplay navigation estimate, not authoritative position error. */
  uncertaintyKm: number;
  /** Provider-visible terrain evidence may slow physical progress without creating a hidden road. */
  lastSpeedFactor: number;
  lastTerrainRisk: number;
  lastProviderTick?: WorldTick;
  terrainEvidenceIds: string[];
  navigationAnchorIds: string[];
  completedDay?: number;
  completedMinute?: number;
}

export interface ExpeditionRendezvousRequest {
  id: string;
  status: 'pending-link' | 'transmitted' | 'resolved' | 'cancelled';
  requestedDay: number;
  requestedMinute: number;
  requestedTick: WorldTick;
  communicationAtRequest: CommunicationStatus;
  /** Exact field position held by the party itself; settlement planning must not consume it until verified transmission. */
  requestedPosition: SpatialRef;
  transmittedDay?: number;
  transmittedMinute?: number;
  verifiedPosition?: SpatialRef;
  resolution?: string;
}

export type ExpeditionRendezvousPlanStatus = 'outbound' | 'waiting' | 'searching' | 'contact' | 'aborted' | 'completed';
export type ExpeditionRendezvousOutcome = 'met' | 'waited-no-contact' | 'aborted' | 'evidence-updated' | 'responder-turnback';

export interface ExpeditionRendezvousTransferRecord {
  completedDay: number;
  completedMinute: number;
  food: number;
  water: number;
  medicine: number;
  tools: number;
  injuredMemberIds: string[];
}

/**
 * Responder-side rendezvous/search state. The evidencePosition is an observation with a timestamp,
 * never a live pointer to the target expedition's canonical position.
 */
export interface ExpeditionRendezvousPlan {
  id: string;
  targetExpeditionId: string;
  targetEvidenceId: string;
  targetEvidenceDay: number;
  targetEvidenceMinute: number;
  evidencePosition: SpatialRef;
  evidenceSourceIds: string[];
  /** Optional pre-departure/intended destination known to the responder; never populated from hidden current target position. */
  intendedTargetPosition?: SpatialRef;
  intendedTargetSourceIds?: string[];
  launchedDay: number;
  launchedMinute: number;
  launchedTick: WorldTick;
  etaHoursAtLaunch: number;
  arrivalWindowStartDay: number;
  arrivalWindowStartMinute: number;
  arrivalWindowEndDay: number;
  arrivalWindowEndMinute: number;
  status: ExpeditionRendezvousPlanStatus;
  arrivedDay?: number;
  arrivedMinute?: number;
  arrivalAssessment?: 'early' | 'within' | 'late';
  waitHoursTotal: number;
  waitHoursRemaining: number;
  /** Hours spent in the bounded evidence-centered search phase; QA16 caps one search at 12h before explicit abort/return. */
  searchHours: number;
  /** Current evidence-centered search extent; geometry follows a deterministic expanding-square pattern. */
  searchRadiusKm: number;
  searchStep: number;
  lastSearchEvidenceIds: string[];
  lastOutcome?: ExpeditionRendezvousOutcome;
  abortedReason?: string;
  coLocatedAt?: SpatialRef;
  transfer?: ExpeditionRendezvousTransferRecord;
  completedDay?: number;
  completedMinute?: number;
}

export interface ExpeditionState {
  id: string;
  leaderId: string;
  memberIds: string[];
  controlMode: ExpeditionControlMode;
  doctrineId: string;
  /** Optional for backward-compatible v1 saves; missing means normal pace. */
  pace?: ExpeditionPace;
  status: ExpeditionStatus;
  position: SpatialRef;
  destination: SpatialRef | null;
  /** Stable provider entity ID for the currently intended WORLD destination; optional for backward-compatible v1 saves. */
  destinationEntityId?: string;
  /** Optional known WORLD route entity deliberately chosen as a waypoint for the outbound leg. */
  routeEntityId?: string;
  /** Spatial waypoint for routeEntityId; optional for backward-compatible saves and omitted for direct travel. */
  routeWaypoint?: SpatialRef;
  /** True once the outbound party has physically reached the selected route waypoint. */
  routeWaypointReached?: boolean;
  /** Optional multi-leg route derived only from provider-visible topology. */
  routePlan?: ExpeditionRoutePlan;
  departureDay: number;
  departureMinute: number;
  returnDay: number | null;
  communication: CommunicationStatus;
  silentHours: number;
  supplies: { food: number; water: number; medicine: number; tools: number };
  orders: ExpeditionOrder[];
  observations: ExpeditionObservation[];
  discoveredEntityIds: string[];
  rescueOfExpeditionId: string | null;
  missingReason: string;
  communicationReports?: ExpeditionCommunicationReport[];
  lossState?: ExpeditionLossState;
  alterations?: ExpeditionAlterationRecord[];
  /** First confirmed arrival at the current destination; optional for backward-compatible saves. */
  arrivedDay?: number;
  arrivedMinute?: number;
  /** Last day on which camp-before-dark doctrine actually suppressed travel. */
  lastDoctrineCampDay?: number;
  /** Explicit field choice while an outbound provider route is blocked. */
  fieldDecision?: ExpeditionFieldDecision;
  /** Provider-evidence-bounded environmental exposure record for halted/camped field time. */
  fieldExposure?: ExpeditionExposureState;
  /** Returning currently means a physical direct bearing, not a claim that a provider-visible road exists. */
  returnTravelMode?: 'off-network-bearing';
  /** Explicit physical state for off-network return progress and field-navigation uncertainty. */
  returnTravel?: ExpeditionReturnTravelState;
  /** Observer-bounded field rendezvous/rescue request; pending-link state is not settlement knowledge. */
  rendezvousRequest?: ExpeditionRendezvousRequest;
  /** Responder-side physical rendezvous/search lifecycle; optional for pre-QA16 saves. */
  rendezvousPlan?: ExpeditionRendezvousPlan;
}

export interface EncounterActorState {
  agentId: string;
  side: 'expedition' | 'other';
  x: number;
  y: number;
  health: number;
  actionState: number;
  agility: number;
  judgment: number;
  morale: number;
}

export interface EncounterQueueAction {
  id: string;
  actorId: string;
  order: number;
  action: 'move' | 'attack' | 'cover' | 'aid' | 'withdraw' | 'observe';
  targetId?: string;
  targetX?: number;
  targetY?: number;
  reason: string;
}

export interface EncounterState {
  id: string;
  expeditionId: string;
  day: number;
  instruction: EncounterInstruction;
  status: EncounterStatus;
  width: number;
  height: number;
  actors: EncounterActorState[];
  queue: EncounterQueueAction[];
  log: string[];
  casualties: string[];
}


export interface ExternalPersonContact {
  externalPersonId: string;
  name: string;
  societyEntityId?: string;
  provenanceIds: string[];
  firstContactDay: number;
  firstContactMinute: number;
  lastContactDay: number;
  lastContactMinute: number;
  interactionCount: number;
  speakerIds: string[];
  knowledgeIds: string[];
}

export type ExternalConflictObservationKind = 'violence' | 'route-disruption' | 'displacement' | 'resource-loss' | 'recovery';

export interface ExternalConflictObservation {
  id: string;
  sourceEntityId: string;
  providerSourceId: string;
  providerTick: WorldTick;
  day: number;
  minuteOfDay: number;
  kind: ExternalConflictObservationKind;
  severity: number;
  location?: SpatialRef;
  injuredIndividualIds: string[];
  displacedIndividualIds: string[];
  /** Provider-explicit household identities observed moving as households. Never inferred from individual members. */
  displacedHouseholdIds?: string[];
  /** Provider-explicit local identities observed returning to the settlement after displacement. */
  returnedToSettlementIndividualIds?: string[];
  /** Provider-explicit household identities observed returning after a prior household displacement episode. */
  returnedToSettlementHouseholdIds?: string[];
  affectedRouteEntityIds: string[];
  /** Provider-explicit passability statement; disruption severity alone never implies impassability. */
  routePassability?: 'unknown' | 'degraded' | 'impassable';
  resourceLoss: Partial<Record<SettlementResourceKey, number>>;
  provenanceIds: string[];
}

export interface ExternalActorProjection {
  entityId: string;
  provenanceIds?: string[];
  fineActorIds?: string[];
  relationshipIds?: string[];
  effectiveDetailRank?: number;
  kind: string;
  name: string;
  population: number | null;
  position: SpatialRef | null;
  lastObservedTick: WorldTick;
  confidence: number;
  disposition: number | null;
  localTrust: number;
  tradeExperience: number;
  migrationBalance: number;
  conflictPressure: number;
}

export type ChronicleEpistemicScope = 'settlement-visible' | 'expedition-internal';

export interface ChronicleEpistemicState {
  /** Where the event was directly experienced. Historical saves without this block are treated as settlement-visible. */
  scope: ChronicleEpistemicScope;
  /** Expedition whose members directly witnessed the event, when scope is expedition-internal. */
  expeditionId?: string;
  /** Agents with direct access to the event at creation time. */
  witnessedByAgentIds: string[];
  /** Whether a verified routine report may disclose the event to the settlement viewpoint. */
  reportableToSettlement: boolean;
  /** Whether settlement-facing Chronicle projection may currently expose the event. */
  settlementVisible: boolean;
  /** Communication/return/rescue evidence that made a formerly internal event visible. */
  revealSourceIds: string[];
}

export interface PersonalEquipmentItem {
  id: string;
  ownerId: string;
  name: string;
  slot: EquipmentSlot;
  equipped: boolean;
  weightKg: number;
  skillBonuses: Partial<Record<SkillKey, number>>;
  provenanceIds: string[];
}

export interface PhysicalInventoryItem {
  id: string;
  ownerId: string;
  kind: PhysicalInventoryKind;
  name: string;
  quantity: number;
  weightKg: number;
  sourceEntityId?: string;
  provenanceIds: string[];
  acquiredDay: number;
  acquiredMinuteOfDay?: number;
  reading?: import('./loreArtifacts.js').ArtifactReading;
  /** Optional C-depth resource cargo metadata. Resource cargo remains physically carried until deposited. */
  resourceKey?: SettlementResourceKey;
  resourceSubtype?: string;
  resourceUnit?: ResourceCanonicalUnit;
  resourceSourceId?: string;
  resourceCondition?: number;
  resourceFreshness?: number;
  resourceContaminationRisk?: number;
  resourceWaterQuality?: ResourceWaterQuality;
}

export interface DirectActivityReservation {
  id: string;
  agentIds: string[];
  kind: DirectActivityKind;
  startAbsoluteMinute: number;
  endAbsoluteMinute: number;
  targetEntityId?: string;
  detail: string;
  completed: boolean;
}

export interface DirectPlayState {
  equipmentInitializedAgentIds: string[];
  equipment: PersonalEquipmentItem[];
  inventory: PhysicalInventoryItem[];
  directActivities: DirectActivityReservation[];
}

export interface SandboxChronicleEntry {
  id: string;
  day: number;
  minuteOfDay: number;
  kind: 'birth' | 'death' | 'leadership' | 'expedition' | 'medicine' | 'knowledge' | 'external' | 'ending' | 'settlement';
  title: string;
  text: string;
  entityIds: string[];
  epistemic?: ChronicleEpistemicState;
}


export interface ProviderCommandReceipt {
  commandId: string;
  kind: string;
  issuedTick: number;
  providerTick: number;
  accepted: boolean;
  reason?: string;
  eventIds: string[];
  causalRecordIds: string[];
}

export interface ProviderMutationJournal {
  /** Monotonic ordinal used to allocate retry-stable provider command IDs. */
  nextCommandOrdinal: number;
  /** Increments only after a provider snapshot is proven aligned with game time. */
  providerCommitGeneration: number;
  /** Highest compacted ordinal known to have reached a terminal provider result. */
  retiredThroughOrdinal: number;
  /** O(1) retention counters for compacted terminal receipts. */
  retiredReceiptCount: number;
  retiredAcceptedCount: number;
  retiredRejectedCount: number;
  retiredEventCount: number;
  retiredCausalRecordCount: number;
  /** Recent detailed receipts. Older ordinal receipts compact into the retirement watermark/counters. */
  commandReceipts: ProviderCommandReceipt[];
}

export type IncidentLedgerPhase = 'active' | 'resolved' | 'expired' | 'withdrawn';

/**
 * I2-B persistent, observer-safe lifecycle metadata for a currently/previously visible incident.
 *
 * Deliberately stores no title/summary/detail payload. Historical presentation text is not a new
 * authority source; F1 must still derive text from the current observer-bounded situation seam.
 */
export type IncidentPositiveResolutionEvidenceKind =
  | 'settlement-resource-threshold'
  | 'recorded-case-cleared'
  | 'field-health-threshold'
  | 'field-fatigue-threshold'
  | 'field-supply-threshold'
  | 'communication-restored'
  | 'encounter-resolved'
  | 'research-sample-present'
  | 'provider-return-observed';

export interface IncidentPositiveResolutionEvidence {
  id: string;
  kind: IncidentPositiveResolutionEvidenceKind;
  observedAt: number;
  occurrenceNumber: number;
  subjectIds: string[];
  supportingOperationIds: string[];
  metric?: 'food' | 'water' | 'health' | 'fatigue' | 'supply-days';
  observedValue?: number;
  thresholdValue?: number;
  comparison?: 'gte' | 'lt';
}

/**
 * I2-B persistent, observer-safe lifecycle entry. I2-F may attach one most-recent
 * structured positive-evidence record when the entry is explicitly resolved.
 * The record contains no prose, hidden cause truth, or response-success claim.
 */
export interface IncidentLedgerEntry {
  key: string;
  contextKey: string;
  incidentId: string;
  templateId: string;
  causalDedupeKey?: string;
  expiresAt?: number;
  phase: IncidentLedgerPhase;
  firstSeenAt: number;
  lastSeenAt: number;
  lastUpdatedAt: number;
  terminalAt?: number;
  occurrenceCount: number;
  visibleSyncCount: number;
  lastUrgency: 'low' | 'medium' | 'high' | 'critical';
  lastCauseRefs: string[];
  lastResolutionEvidence?: IncidentPositiveResolutionEvidence;
}

export interface IncidentLedgerStateV1 {
  schemaVersion: 1;
  /** I2-F semantic marker. Older I2-B..I2-E saves may omit it and are fail-closed migrated. */
  resolutionPolicyVersion?: 1;
  lastSyncAt: number;
  entries: IncidentLedgerEntry[];
}

export type IncidentDispatchTeamPhase = 'assigned' | 'dispatched' | 'stood-down';

/**
 * I2-C operator-authored response allocation metadata. This records only who was committed to a
 * currently visible incident and whether that allocation was dispatched. It is not evidence that
 * the incident cause is true, solved, reached, or successfully handled.
 */
export interface IncidentDispatchTeam {
  id: string;
  contextKey: string;
  incidentId: string;
  memberIds: string[];
  phase: IncidentDispatchTeamPhase;
  assignedAt: number;
  lastUpdatedAt: number;
  dispatchedAt?: number;
  stoodDownAt?: number;
  dispatchOrdinal: number;
}

export interface IncidentDispatchStateV1 {
  schemaVersion: 1;
  nextDispatchOrdinal: number;
  teams: IncidentDispatchTeam[];
}

export type IncidentResponseOperationPhase = 'mobilizing' | 'working' | 'returning' | 'completed' | 'aborted';
export type IncidentResponseObservationKind = 'post-response-visibility' | 'return-complete' | 'team-unavailable' | 'operator-stand-down';
export type IncidentResponseObservedVisibility = 'visible' | 'not-visible' | 'not-checked';

/**
 * I2-D observer-safe operational observation. It records only what the response layer can establish
 * at a canonical time. It never stores success/failure, hidden cause truth, or presentation prose.
 */
export interface IncidentResponseObservation {
  id: string;
  ordinal: number;
  kind: IncidentResponseObservationKind;
  observedAt: number;
  incidentVisibility: IncidentResponseObservedVisibility;
}

/**
 * I2-D asynchronous response work clock attached to one dispatched I2-C team.
 * The planned durations are bounded budgets derived only from observer-safe incident urgency.
 */
export interface IncidentResponseOperation {
  id: string;
  teamId: string;
  contextKey: string;
  incidentId: string;
  phase: IncidentResponseOperationPhase;
  startedAt: number;
  lastAdvancedAt: number;
  plannedMobilizationMinutes: number;
  plannedWorkMinutes: number;
  plannedReturnMinutes: number;
  mobilizationMinutesRemaining: number;
  workMinutesRemaining: number;
  returnMinutesRemaining: number;
  observations: IncidentResponseObservation[];
  arrivedAt?: number;
  workCompletedAt?: number;
  completedAt?: number;
  abortedAt?: number;
}

export interface IncidentResponseOperationStateV1 {
  schemaVersion: 1;
  nextObservationOrdinal: number;
  operations: IncidentResponseOperation[];
}

export type IncidentResponseResourceKey = 'food' | 'water' | 'medicine' | 'tools';
export type IncidentResponseResourceSourceKind = 'settlement' | 'expedition';
export type IncidentResponseResourceReservationPhase = 'reserved' | 'settled' | 'legacy-unfunded';

export interface IncidentResponseResourceAmounts extends Record<IncidentResponseResourceKey, number> {}

/**
 * I2-E canonical-stock reservation attached one-to-one to an I2-D operation. New operations reserve
 * bounded supplies from the settlement or the responding expedition. Legacy I2-D operations are
 * backfilled as zero-budget `legacy-unfunded` records so loading an old save never rewrites history.
 */
export interface IncidentResponseResourceReservation {
  id: string;
  operationId: string;
  teamId: string;
  contextKey: string;
  sourceKind: IncidentResponseResourceSourceKind;
  sourceExpeditionId?: string;
  phase: IncidentResponseResourceReservationPhase;
  reservedAt: number;
  lastUpdatedAt: number;
  settledAt?: number;
  reserved: IncidentResponseResourceAmounts;
  consumed: IncidentResponseResourceAmounts;
  returned: IncidentResponseResourceAmounts;
  /** Physical quantities held out of settlement lots; absent in legacy saves. */
  heldLots?: Partial<Record<'food' | 'water' | 'medicine' | 'tools', Array<{lotId: string; quantity: number}>>>;
}

export interface IncidentResponseResourceStateV1 {
  schemaVersion: 1;
  reservations: IncidentResponseResourceReservation[];
}

/**
 * I2-G explicit operator-confirmed resource-use reconciliation grounded in an I2-F positive
 * evidence record and one completed response operation. It records only bounded canonical
 * medicine/tool usage; it is not a causal-success, hidden-truth, or world-outcome claim.
 */
export interface IncidentResponseEvidenceResourceUse {
  id: string;
  ordinal: number;
  operationId: string;
  reservationId: string;
  contextKey: string;
  incidentId: string;
  evidenceId: string;
  evidenceKind: IncidentPositiveResolutionEvidenceKind;
  evidenceOccurrenceNumber: number;
  recordedAt: number;
  medicine: number;
  tools: number;
}

export interface IncidentResponseEvidenceResourceUseStateV1 {
  schemaVersion: 1;
  nextUseOrdinal: number;
  uses: IncidentResponseEvidenceResourceUse[];
}

export type IncidentResponseDebriefTerminalPhase = 'completed' | 'aborted';

/**
 * I2-H observer-safe return/debrief projection. This is a structured fact bundle only: it snapshots
 * response chronology, bounded observations, explicit positive evidence, and reconciled resource-use
 * facts. It never stores narrative prose, causal interpretation, or success/failure claims.
 */
export interface IncidentResponseDebrief {
  id: string;
  operationId: string;
  teamId: string;
  contextKey: string;
  incidentId: string;
  terminalPhase: IncidentResponseDebriefTerminalPhase;
  generatedAt: number;
  lastRefreshedAt: number;
  memberIds: string[];
  chronology: {
    startedAt: number;
    arrivedAt?: number;
    workCompletedAt?: number;
    terminalAt: number;
  };
  observations: IncidentResponseObservation[];
  positiveEvidence: IncidentPositiveResolutionEvidence[];
  evidenceResourceUses: IncidentResponseEvidenceResourceUse[];
  resourceReservation?: IncidentResponseResourceReservation;
}

export interface IncidentResponseDebriefStateV1 {
  schemaVersion: 1;
  debriefs: IncidentResponseDebrief[];
}

/**
 * I2-M response-duty recovery metadata. This is a bounded gameplay allocation constraint derived
 * only from terminal response chronology. It never mutates general Agent fatigue/tasks, WorldProvider
 * truth, Incident resolution, or success/failure semantics.
 */
export interface IncidentResponseReadinessEntry {
  memberId: string;
  operationId: string;
  contextKey: string;
  dutyMinutes: number;
  recoveryStartedAt: number;
  recoveryUntil: number;
}

export interface IncidentResponseReadinessStateV1 {
  schemaVersion: 1;
  /** Old I2-L saves set this to load time so prior terminal work does not create retroactive cooldown. */
  policyActivatedAt: number;
  entries: IncidentResponseReadinessEntry[];
}

export type SurvivalCampaignPhase = 'stabilize' | 'explore' | 'preserve' | 'generation' | 'continuity';
export type SurvivalCampaignMilestoneId = 'stabilize' | 'explore' | 'preserve' | 'generation';
export type SurvivalCampaignDirectiveTarget = 'task' | 'map' | 'body' | 'knowledge' | 'inventory' | 'chronicle' | 'expedition';

/** Open-ended settlement continuity sidecar. Strategic multi-day advancement is retained as an internal capability only. */
export interface SurvivalCampaignStateV2 {
  schemaVersion: 2;
  startDay: number;
  foundingAgentIds: string[];
  completedMilestoneIds: SurvivalCampaignMilestoneId[];
  phase: SurvivalCampaignPhase;
  lastEvaluatedDay: number;
  strategicAdvanceDays: 1 | 7 | 30;
}

export interface SurvivalCampaignDirective {
  id: string;
  severity: 'info' | 'watch' | 'urgent' | 'critical';
  title: string;
  detail: string;
  target: SurvivalCampaignDirectiveTarget;
  basisIds: string[];
}

export interface SurvivalCampaignMilestoneView {
  id: SurvivalCampaignMilestoneId;
  label: string;
  detail: string;
  complete: boolean;
}

export interface SurvivalCampaignBriefing {
  title: string;
  premise: string;
  objective: string;
}

export interface SurvivalCampaignView {
  phase: SurvivalCampaignPhase;
  briefing: SurvivalCampaignBriefing;
  startDay: number;
  currentYear: number;
  elapsedDays: number;
  localPopulation: number;
  livingPopulation: number;
  birthsSinceStart: number;
  livingDescendants: number;
  deepestGeneration: number;
  generationLabel: string;
  foodDays: number;
  waterDays: number;
  waterSafety: number;
  sanitation: number;
  averageHealth: number;
  returnedExpeditions: number;
  activeExpeditions: number;
  archivedRecords: number;
  institutionalKnowledge: number;
  directive: SurvivalCampaignDirective;
  milestones: SurvivalCampaignMilestoneView[];
}


export type DailyLoopPhase = 'planning' | 'executing' | 'interrupted';
export type DailyPlanStatus = 'draft' | 'committed' | 'executing' | 'completed';
export type DailyExecutionPolicy = 'auto' | 'manual';
export type DailyInterruptionKind = 'medical' | 'expedition';
export type MorningResidentSeverity = 'death' | 'critical' | 'severe' | 'new-condition' | 'needs' | 'worsened' | 'watch' | 'improved' | 'stable';

export interface DailyAssignment {
  agentId: string;
  task: LaborTask;
  note?: string;
}

export interface DailyExecutionPolicies {
  expedition: DailyExecutionPolicy;
  medical: DailyExecutionPolicy;
}

export interface DailyPlan {
  day: number;
  status: DailyPlanStatus;
  assignments: DailyAssignment[];
  policies: DailyExecutionPolicies;
  committedDay?: number;
  committedMinuteOfDay?: number;
}

export interface MorningResidentSnapshot {
  agentId: string;
  name: string;
  alive: boolean;
  health: number;
  fatigue: number;
  morale: number;
  hunger: number;
  thirst: number;
  task: LaborTask;
  residence: AgentResidence;
  expeditionId: string | null;
  activePathologies: Array<{ id: string; pathologyId: string; severity: number; status: PathologyCase['status'] }>;
}

export interface MorningExpeditionSnapshot {
  id: string;
  status: ExpeditionStatus;
  memberIds: string[];
  leaderId: string;
}

export interface MorningSnapshot {
  day: number;
  minuteOfDay: number;
  residents: MorningResidentSnapshot[];
  resources: SettlementResources;
  expeditions: MorningExpeditionSnapshot[];
}

export interface MorningResidentDelta {
  agentId: string;
  name: string;
  severity: MorningResidentSeverity;
  severityScore: number;
  summary: string;
  healthBefore: number;
  healthAfter: number;
  healthDelta: number;
  fatigueDelta: number;
  moraleDelta: number;
  hungerAfter: number;
  thirstAfter: number;
  newPathologyIds: string[];
  activePathologyIds: string[];
  task: LaborTask;
  residence: AgentResidence;
  expeditionId: string | null;
  recommendedResponse: string;
}

export interface MorningReport {
  day: number;
  minuteOfDay: number;
  residentDeltas: MorningResidentDelta[];
  resourceDeltas: Partial<Record<SettlementResourceKey, number>>;
  expeditionUpdates: string[];
  settlementUpdates: string[];
  births: string[];
  deaths: string[];
}

export interface ExecutionInterruption {
  kind: DailyInterruptionKind;
  title: string;
  detail: string;
  subjectIds: string[];
}

export interface DailyExecutionAccumulation {
  births: string[];
  deaths: string[];
  expeditionUpdates: string[];
  settlementUpdates: string[];
}

export interface DailyExecutionSession {
  startedDay: number;
  startedMinuteOfDay: number;
  /** Absolute game-minute at which this execution window must stop (the originally scheduled next morning). */
  targetAbsoluteMinute: number;
  status: 'executing' | 'interrupted' | 'completed';
  accumulated: DailyExecutionAccumulation;
  interruption?: ExecutionInterruption;
}

export interface DailyLoopStateV1 {
  schemaVersion: 1;
  phase: DailyLoopPhase;
  currentPlan: DailyPlan;
  lastMorningSnapshot: MorningSnapshot;
  lastMorningReport?: MorningReport;
  executionSession?: DailyExecutionSession;
}

export interface SandboxGameState {
  inquiries?: import('./explorationInquiry.js').ExplorationInquiry[];
  legacyProjects?: import('./legacyProject.js').LegacyProject[];
  researchApplications?: import('./researchApplications.js').ResearchApplication[];
  schemaVersion: 1;
  saveId: string;
  seed: number;
  rngState: number;
  sequence: number;
  status: SandboxStatus;
  clock: GameClockState;
  clockPolicy: WorldClockPolicy;
  world: {
    manifest: WorldManifest;
    providerRecipeId: string;
    providerEngineVersion: string;
    originEntityId: string;
    discoveredVariableIds: string[];
    discoveredCapabilities: string[];
    /** Provider-owned canonical world state needed to resume real Worldgen without regenerating history. */
    providerSnapshot: WorldSnapshot;
  };
  settlement: SettlementState;
  agents: SandboxAgent[];
  pregnancies: PregnancyState[];
  /** Latest scheduled conception slot processed, in elapsed game minutes. */
  lastConceptionCheckAbsoluteMinute?: number;
  knowledge: KnowledgeEntry[];
  /** I1-E persisted epistemic sidecar. Optional only for legacy schemaVersion=1 save migration. */
  knowledgeStore?: KnowledgeStoreSnapshotV1;
  records: SocialRecord[];
  researchProjects?: ResearchProject[];
  anomalyPractices?: AnomalyUtilizationPractice[];
  policyProposals?: SettlementPolicyProposal[];
  doctrines: ExpeditionDoctrine[];
  expeditions: ExpeditionState[];
  encounters: EncounterState[];
  externalActors: ExternalActorProjection[];
  /** Provider-observed conflict consequences only. Optional for schemaVersion=1 save compatibility. */
  externalConflictObservations?: ExternalConflictObservation[];
  /** Direct, observer-bounded contacts with provider-materialized outside individuals. Optional for v1 save compatibility. */
  externalContacts?: ExternalPersonContact[];
  chronicle: SandboxChronicleEntry[];
  generatedEndings: string[];
  /** Lazy-migrated provider mutation journal. Older schemaVersion=1 saves may omit it. */
  providerMutations?: ProviderMutationJournal;
  /** Lazy-migrated direct-play physical state. Older schemaVersion=1 saves may omit it. */
  directPlay?: DirectPlayState;
  /** Detailed physical resource ledger. Optional for original I2X save compatibility and lazily initialized. */
  resourceLedger?: ResourceLedgerStateV1;
  /** Survival/generation campaign sidecar. Optional for original I2X save compatibility and lazily initialized. */
  campaign?: SurvivalCampaignStateV2;
  /** Daily Morning Report → Plan → Execute sidecar. Optional for legacy save compatibility and lazily initialized. */
  dailyLoop?: DailyLoopStateV1;
  /** I2-B observer-safe incident lifecycle sidecar. Optional only for older schemaVersion=1 saves. */
  incidentLedger?: IncidentLedgerStateV1;
  /** I2-C operator-authored assignment/dispatch sidecar. Optional only for older schemaVersion=1 saves. */
  incidentDispatch?: IncidentDispatchStateV1;
  /** I2-D asynchronous observer-safe response-operation sidecar. Optional only for older schemaVersion=1 saves. */
  incidentResponseOperations?: IncidentResponseOperationStateV1;
  /** I2-E bounded canonical resource reservation/consumption sidecar. Optional only for older schemaVersion=1 saves. */
  incidentResponseResources?: IncidentResponseResourceStateV1;
  /** I2-G evidence-grounded medicine/tool reconciliation sidecar. Optional only for older schemaVersion=1 saves. */
  incidentResponseEvidenceUses?: IncidentResponseEvidenceResourceUseStateV1;
  /** I2-H observer-safe return/debrief fact projection. Optional only for older schemaVersion=1 saves. */
  incidentResponseDebriefs?: IncidentResponseDebriefStateV1;
  incidentResponseReadiness?: IncidentResponseReadinessStateV1;
  diagnostics: {
    stepCount: number;
    lastWorldAdvanceFrom: number;
    lastWorldAdvanceTo: number;
    replayHash: string;
  };
}

export interface SandboxStepSummary {
  from: GameClockState;
  to: GameClockState;
  births: string[];
  deaths: string[];
  leadershipChanges: string[];
  expeditionUpdates: string[];
  encounterUpdates: string[];
  knowledgeUpdates: string[];
  settlementUpdates: string[];
}

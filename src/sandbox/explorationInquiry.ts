import type { SpatialRef, WorldEntity, WorldProvider } from '../worldbridge/contract.js';
import { accessibleEvidence, atSettlement, canReadEvidence } from './evidenceAccess.js';
import { entityName, reserveDirectActivity } from './directPlay.js';
import { addObservedKnowledge, institutionalizeKnowledgeRecord, syncLegacyKnowledgeShadow } from './knowledgeSimulation.js';
import { knownMapLocation } from './knowledgeSpatial.js';
import { isSampleableEntity, observedEntityMetadata, queryGeneratedLocalArea, spatialDistanceKm } from './localExploration.js';
import { consumeResourceLots, ensureResourceLedgerState, processResourceLot, splitResourceLot } from './resourceLedger.js';
import { findAgent, nextStateId } from './stateUtils.js';
import type { KnowledgeEntry, ResourceWaterQuality, SandboxGameState } from './types.js';

export const INQUIRY_PREDICTIONS = ['water-source','ruin','route-memory','built-landscape','disturbance-stratum','archive-record'] as const;
export type InquiryPrediction = typeof INQUIRY_PREDICTIONS[number];
const labels: Record<InquiryPrediction,string> = { 'water-source':'水源がある', ruin:'廃墟の痕がある', 'route-memory':'移動の痕がある', 'built-landscape':'建造の痕がある', 'disturbance-stratum':'乱れた地層がある', 'archive-record':'記録物がある' };
export function inquiryPredictionLabel(value: InquiryPrediction): string { return labels[value]; }
export interface InquiryEvaluation {
  knowledgeId: string; day: number; prediction: InquiryPrediction; center: SpatialRef; radiusKm: number;
  outcome: 'supports' | 'contradicts' | 'inconclusive'; observedEntityIds: string[]; observationKnowledgeIds: string[];
}
export interface ProcedureTrial {
  knowledgeId: string; day: number; method: 'boiled' | 'filtered'; inputLotId: string; outputLotId: string;
  before: ResourceWaterQuality; after: ResourceWaterQuality;
}
export interface ExplorationInquiry {
  id: string; knowledgeId: string; authorId: string; basisKnowledgeIds: string[]; basisClaims: string[];
  targetEntityId: string; targetLabel: string; center: SpatialRef; radiusKm: number; prediction: InquiryPrediction;
  note: string; createdDay: number; revisesId?: string; evaluations: InquiryEvaluation[]; trials: ProcedureTrial[];
}

export function visibleInquiries(state: SandboxGameState, observerId: string): ExplorationInquiry[] {
  return (state.inquiries ?? []).filter((inquiry) => state.knowledge.some((entry) => entry.id === inquiry.knowledgeId && canReadEvidence(state, observerId, entry)));
}
export function readableEvaluations(state: SandboxGameState, observerId: string, inquiry: ExplorationInquiry): InquiryEvaluation[] {
  return inquiry.evaluations.filter((evaluation) => state.knowledge.some((entry) => entry.id === evaluation.knowledgeId && canReadEvidence(state, observerId, entry)));
}
export function readableTrials(state: SandboxGameState, observerId: string, inquiry: ExplorationInquiry): ProcedureTrial[] {
  return inquiry.trials.filter((trial) => state.knowledge.some((entry) => entry.id === trial.knowledgeId && canReadEvidence(state, observerId, entry)));
}

export function createExplorationInquiry(state: SandboxGameState, authorId: string, basisIds: string[], target: WorldEntity, prediction: InquiryPrediction, note = '', revisesId?: string): ExplorationInquiry {
  if (!INQUIRY_PREDICTIONS.includes(prediction)) throw new Error('観測予測を選んでください。');
  const basis = [...new Set(basisIds)].map((id) => accessibleEvidence(state, authorId).find((entry) => entry.id === id));
  if (!basis.length || basis.some((entry) => !entry)) throw new Error('その場で参照できる根拠を選んでください。');
  const prior = revisesId ? visibleInquiries(state,authorId).find((entry) => entry.id === revisesId) : undefined;
  if (revisesId && (!prior || prior.targetEntityId !== target.id)) throw new Error('元の調査ノートと調査地点を参照できません。');
  const location = prior ? {position:structuredClone(prior.center),uncertaintyRadiusKm:prior.radiusKm} : knownMapLocation(state, authorId, target);
  if (!location.position) throw new Error('位置の手がかりがある地点を選んでください。');
  const text = `${entityName(target)}の周辺に「${labels[prediction]}」と予測する。${note.trim().slice(0,400)}`;
  const knowledge = addObservedKnowledge(state, [authorId], [target.id], `${text}\n根拠: ${basis.map((entry) => entry!.claim).join('\n')}`, .2, undefined, [], { promoteToSettlement:false });
  const inquiry: ExplorationInquiry = {
    id:nextStateId(state,'inquiry'),knowledgeId:knowledge.id,authorId,basisKnowledgeIds:basisIds.filter((id,index) => basisIds.indexOf(id) === index),
    basisClaims:basis.map((entry) => entry!.claim),targetEntityId:target.id,targetLabel:entityName(target),center:structuredClone(location.position),
    radiusKm:Math.max(.35,location.uncertaintyRadiusKm),prediction,note:note.trim().slice(0,400),createdDay:state.clock.day,
    ...(revisesId ? { revisesId } : {}),evaluations:[],trials:[],
  };
  (state.inquiries ??= []).push(inquiry);
  reserveDirectActivity(state,[authorId],'research',10,'観測予測と根拠を調査ノートに記録。',target.id);
  return inquiry;
}

function matchesPrediction(entity: WorldEntity, prediction: InquiryPrediction): boolean {
  const observed = observedEntityMetadata(entity);
  if (prediction === 'water-source') return observed.resourceKeys.includes('water');
  if (prediction === 'archive-record') return ['archive-record','artifact','cartographic-record'].includes(entity.kind) || observed.traceType === 'archival-trace';
  return observed.traceType === prediction || (entity.kind === 'historical-trace' && entity.subtype === prediction);
}

export async function surveyInquiry(provider: WorldProvider, state: SandboxGameState, observerId: string, inquiryId: string): Promise<InquiryEvaluation> {
  const inquiry = visibleInquiries(state,observerId).find((entry) => entry.id === inquiryId);
  const agent = findAgent(state,observerId);
  if (!inquiry || !agent?.alive) throw new Error('参照できる調査ノートがありません。');
  const field = agent.expeditionId ? state.expeditions.find((entry) => entry.id === agent.expeditionId) : undefined;
  if (agent.expeditionId ? !field : !atSettlement(state,observerId)) throw new Error('現地の居場所を確認できません。');
  const center = structuredClone(field?.position ?? state.settlement.position), radiusKm = .35;
  const distance = spatialDistanceKm(center,inquiry.center);
  if (distance > inquiry.radiusKm + radiusKm) throw new Error('まず予測した範囲へ移動してください。');
  const projection = await queryGeneratedLocalArea(provider,state,observerId,center,radiusKm);
  const observed = projection.entities.filter((entity) => entity.spatial && spatialDistanceKm(center,entity.spatial) <= radiusKm + 1e-8
    && spatialDistanceKm(inquiry.center,entity.spatial) <= inquiry.radiusKm + 1e-8);
  const matching = observed.filter((entity) => matchesPrediction(entity,inquiry.prediction));
  const coversArea = distance + inquiry.radiusKm <= radiusKm + 1e-8;
  const outcome = matching.length ? 'supports' : coversArea ? 'contradicts' : 'inconclusive';
  const details = outcome === 'supports' ? '予測に一致するものを観測した。原因の解釈まで証明したわけではない。'
    : outcome === 'contradicts' ? '予測した小範囲を調べたが一致するものを観測できなかった。現在の観測に限った不一致。' : '調べたのは予測範囲の一部。一致するものは見つからず、まだ判断できない。';
  const observations = matching.map((entity) => {
    const entry = addObservedKnowledge(state,[observerId],[entity.id],`${entityName(entity)}を現地で観測。`,.82,undefined,entity.provenanceIds,{promoteToSettlement:false});
    entry.entityObservation = observedEntityMetadata(entity); entry.physicalEvidenceSourceEntityId = entity.id;
    entry.requiresPhysicalSample = isSampleableEntity(entity);
    return entry;
  });
  const report = addObservedKnowledge(state,[observerId],[inquiry.targetEntityId],`「${labels[inquiry.prediction]}」の現地照合: ${details}`,.72,undefined,[],{promoteToSettlement:false});
  const evaluation: InquiryEvaluation = { knowledgeId:report.id,day:state.clock.day,prediction:inquiry.prediction,center,radiusKm,outcome,
    observedEntityIds:observed.map((entry) => entry.id),observationKnowledgeIds:observations.map((entry) => entry.id) };
  inquiry.evaluations.push(evaluation);
  reserveDirectActivity(state,[observerId],'survey',60,details,inquiry.targetEntityId);
  return evaluation;
}

export function archiveInquiryEvaluation(state: SandboxGameState, actorId: string, inquiryId: string, reportId: string): void {
  const inquiry = visibleInquiries(state,actorId).find((entry) => entry.id === inquiryId);
  const evaluation = inquiry && readableEvaluations(state,actorId,inquiry).find((entry) => entry.knowledgeId === reportId);
  if (!evaluation) throw new Error('その場で参照できる観測報告がありません。');
  const ids = [evaluation.knowledgeId,...evaluation.observationKnowledgeIds];
  if (ids.some((id) => !accessibleEvidence(state,actorId).some((entry) => entry.id === id))) throw new Error('報告の観測記録も共有してください。');
  const record = institutionalizeKnowledgeRecord(state,actorId,evaluation.knowledgeId);
  record.knowledgeIds = [...new Set([...record.knowledgeIds,...ids])];
  record.body = record.knowledgeIds.map((id) => state.knowledge.find((entry) => entry.id === id)!.claim).join('\n');
  for (const id of ids) if (!state.settlement.localKnowledgeIds.includes(id)) state.settlement.localKnowledgeIds.push(id);
  syncLegacyKnowledgeShadow(state);
}

/** A measured one-litre trial uses physically returned water; it never acts on a remote source. */
export function trialInquiryProcedure(state: SandboxGameState, actorId: string, inquiryId: string, method: 'boiled'|'filtered'): ProcedureTrial {
  if (!atSettlement(state,actorId) || !['boiled','filtered'].includes(method)) throw new Error('水処理の試行は拠点で実施します。');
  const inquiry = visibleInquiries(state,actorId).find((entry) => entry.id === inquiryId);
  if (!inquiry || inquiry.prediction !== 'water-source') throw new Error('水源の調査ノートを選んでください。');
  const sourceIds = readableEvaluations(state,actorId,inquiry).filter((entry) => entry.outcome === 'supports').flatMap((entry) => entry.observationKnowledgeIds)
    .map((id) => accessibleEvidence(state,actorId).find((entry) => entry.id === id)).filter((entry):entry is KnowledgeEntry => Boolean(entry?.entityObservation?.resourceKeys.includes('water')))
    .map((entry) => entry.entityObservation!.entityId);
  const ledger = ensureResourceLedgerState(state);
  const water = ledger.lots.find((lot) => lot.resourceKey === 'water' && lot.quantity >= 1 && lot.waterQuality && lot.worldEntityIds.some((id) => sourceIds.includes(id)));
  if (!water) throw new Error('観測した水源の水を1L以上持ち帰り、観測報告も共有してください。');
  const material = method === 'boiled' ? 'fuel' : 'cloth';
  if (state.settlement.resources[material] < .1) throw new Error(`${method === 'boiled' ? '燃料' : '布'}が不足しています。`);
  const before = structuredClone(water.waterQuality!);
  consumeResourceLots(state,{resourceKey:material,amount:.1});
  const aliquot = splitResourceLot(state,water.id,1);
  const treated = processResourceLot(state,aliquot.id,method,[actorId]);
  const after = structuredClone(treated.waterQuality!);
  const sourceEntityId = water.worldEntityIds.find((id) => sourceIds.includes(id))!;
  const knowledge = addObservedKnowledge(state,[actorId],[sourceEntityId],`1Lの${method === 'boiled' ? '煮沸' : 'ろ過'}試行。微生物リスク ${before.microbialRisk.toFixed(3)} → ${after.microbialRisk.toFixed(3)}、濁度 ${before.turbidity.toFixed(3)} → ${after.turbidity.toFixed(3)}。化学汚染 ${before.chemicalRisk.toFixed(3)} → ${after.chemicalRisk.toFixed(3)}。この水と条件での測定であり、万能な浄水法ではない。`,.72);
  knowledge.entityObservation = {entityId:sourceEntityId,kind:'ecological-resource',subtype:'freshwater',resourceKeys:['water']};
  const trial: ProcedureTrial = {knowledgeId:knowledge.id,day:state.clock.day,method,inputLotId:water.id,outputLotId:treated.id,before,after};
  inquiry.trials.push(trial);
  reserveDirectActivity(state,[actorId],'research',30,'持ち帰った水で処理手順を試し、処理前後を記録。');
  return trial;
}

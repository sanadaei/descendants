import type { AreaProjection, SpatialRef, WorldEntity } from '../worldbridge/contract.js';
import { accessibleEvidence, canReadEvidence, parseEvidenceClaim } from './evidenceAccess.js';
import { ensureDirectPlayState, entityName, reserveDirectActivity } from './directPlay.js';
import { addObservedKnowledge } from './knowledgeSimulation.js';
import { observedEntityMetadata, spatialDistanceKm } from './localExploration.js';
import { effectiveSkill, findAgent, nextStateId } from './stateUtils.js';
import type { InquiryPrediction } from './explorationInquiry.js';
import type { KnowledgeEntry, PhysicalInventoryItem, SandboxGameState } from './types.js';

const traceLabels: Record<string,string> = { ruin:'崩れた建造物', 'route-memory':'移動の痕跡', 'built-landscape':'積み重ねられた建造の痕', 'disturbance-stratum':'乱れた地層', 'archival-trace':'記録に残った痕跡' };
const eventLabels: Record<string,string> = { 'settlement-founded':'集落の成立', 'settlement-abandoned':'集落の放棄', 'macro-migration':'大きな移動', 'demographic-crisis':'人口に関わる危機', 'demographic-event':'人口の変動', 'macro-demographic-transition':'広い地域の人口構成の変化', 'household-demographic-transition':'家族構成の変化', 'construction-event':'建造', 'mobility-event':'移動', 'conflict-event':'争い', 'environmental-event':'環境の変動', 'ritualized-memory':'儀礼としての記憶', 'unknown-origin':'起源不明', 'unknown-disturbance':'原因の分からない異変' };
const tagLabels: Record<string,string> = { water:'水', flood:'洪水', death:'死', migration:'移動', exile:'流刑', punishment:'罰', transformation:'変身', boundary:'境界', journey:'旅', memory:'記憶', ancestor:'祖先', taboo:'禁忌', healing:'治癒', conflict:'争い', sacred:'聖なる場所', landscape:'風景', fire:'火', underworld:'地下世界', loss:'喪失', survival:'生存' };

/** Render only an already held claim; catalogs and canonical origin events are never consulted. */
export function readableEvidenceText(entry: KnowledgeEntry): string {
  const claim = parseEvidenceClaim(entry.claim);
  if (!claim) return entry.claim;
  const kind = String(claim.interpretation ?? '');
  const trace = typeof claim.traceType === 'string' ? traceLabels[claim.traceType] ?? '形の判別が難しい痕跡' : '';
  const origin = typeof (claim.assertedOriginClass ?? claim.assertedEventClass) === 'string'
    ? eventLabels[String(claim.assertedOriginClass ?? claim.assertedEventClass)] ?? '分類しきれない過去の出来事' : '';
  if (kind === 'cartographic-estimate') {
    const point = claim.estimatedCenter as Record<string,unknown> | undefined;
    return `伝えられた地図は、${typeof point?.x === 'number' && typeof point.y === 'number' ? `${point.x.toFixed(1)}, ${point.y.toFixed(1)}` : '判読できない座標'}を中心に示す。誤差半径は${typeof claim.uncertaintyRadiusKm === 'number' ? claim.uncertaintyRadiusKm.toFixed(1) : '?'}km。現場で位置を確かめる必要がある。`;
  }
  if (/lore/.test(kind)) {
    const tags = Array.isArray(claim.semanticTags) ? [...new Set(claim.semanticTags.filter((value):value is string => typeof value === 'string').flatMap((tag) => tagLabels[tag] ? [tagLabels[tag]] : []))].slice(0,6) : [];
    return `口伝は${tags.length ? `「${tags.join('・')}」` : '名付けきれない古い出来事'}を結びつけて語る。${kind === 'lore-exposure' ? '聞いた断片であり、集団に定着した伝承とは限らない。' : '伝わる途中で解釈や象徴が重なった話であり、出来事そのものと同一とは限らない。'}`;
  }
  if (kind === 'testimony') return `証言者は「${origin || '過去の出来事'}」について語る。記憶には欠落があり、現場の痕跡と照合する必要がある。`;
  if (kind === 'institutional-record') return `組織の記録は「${origin || '過去の出来事'}」に言及する。記載の完全さと出来事の確かさは分けて考える必要がある。`;
  if (kind.includes('trace') || kind.includes('archaeolog')) return `${trace ? `${trace}が` : '物的な痕跡が'}伝えられ、${origin ? `「${origin}」の跡と解釈されている。` : '由来をめぐる解釈が残る。'}${kind.includes('contested') ? '別の読み方も伝わっており、意見は一致していない。' : 'この説明だけでは原因を確定できない。'}`;
  if (kind === 'signal-observation') return `遠くから${origin ? `「${origin}」に関わると解釈された` : '正体のはっきりしない'}信号が記録された。発信元の位置と意味はまだ確かではない。`;
  return '複数の対象に言及する断片的な記録。残された主張を別の観測と照合する必要がある。';
}

export interface ArtifactReading {
  fragments: string[]; basisKnowledgeIds: string[]; leadEntityIds: string[];
  leads: Array<{entityId:string;label:string;prediction:InquiryPrediction;position?:SpatialRef}>;
  requiredMinutes: number; spentMinutes: number; decodedKnowledgeId?: string;
  sourceObservation: NonNullable<KnowledgeEntry['entityObservation']>;
}
export function isReadableArtifact(entity: WorldEntity): boolean { return ['artifact','archive-record','historical-trace','cartographic-record'].includes(entity.kind); }

export function collectArtifactRecord(state: SandboxGameState, actorId: string, entityId: string, projection: AreaProjection): PhysicalInventoryItem {
  const actor = findAgent(state,actorId), entity = projection.entities.find((entry) => entry.id === entityId);
  const field = actor?.expeditionId ? state.expeditions.find((entry) => entry.id === actor.expeditionId) : undefined;
  const position = field?.position ?? state.settlement.position;
  if (!actor?.alive || !entity?.spatial || !isReadableArtifact(entity) || spatialDistanceKm(position,entity.spatial) > .35) throw new Error('記録物に近づいてください。');
  const inventory = ensureDirectPlayState(state).inventory;
  const existing = inventory.find((item) => item.ownerId === actorId && item.quantity > 0 && item.sourceEntityId === entityId && item.reading);
  if (existing) return existing;
  const linkedIds = new Set(projection.relations.filter((relation) => ['artifact-evidence-for','record-supports-trace','contained-at-site'].includes(relation.kind)
    && (relation.sourceId === entityId || relation.targetId === entityId)).flatMap((relation) => [relation.sourceId,relation.targetId]));
  linkedIds.add(entityId);
  const neighbors = projection.entities.filter((entry) => linkedIds.has(entry.id) && entry.spatial && spatialDistanceKm(position,entry.spatial) <= .35);
  const basis = accessibleEvidence(state,actorId).filter((entry) => entry.subjectIds.some((id) => linkedIds.has(id))).slice(0,4);
  const condition = typeof (entity.components.conditionIndex ?? entity.components.survivalIndex) === 'number' ? Math.max(.1,Math.min(1,Number(entity.components.conditionIndex ?? entity.components.survivalIndex))) : .6;
  const fragment = entity.kind === 'historical-trace' ? `${traceLabels[String(entity.components.traceType)] ?? '判別しにくい痕跡'}の表面を写し取った。重なりと欠損があり、成立の順序はまだ読めない。`
    : `${entityName(entity)}の現場記録。${condition < .5 ? '表面は摩耗し、読める部分は限られる。' : '残された形と配置を転記できる。'}原作者や由来を裏づける文字は確認できていない。`;
  const leads = neighbors.map((entry) => ({entityId:entry.id,label:entityName(entry),prediction:(['ruin','route-memory','built-landscape','disturbance-stratum'].includes(String(entry.components.traceType)) ? entry.components.traceType : 'archive-record') as InquiryPrediction,...(entry.spatial ? {position:structuredClone(entry.spatial)} : {})}));
  const item: PhysicalInventoryItem = {id:nextStateId(state,'item'),ownerId:actorId,kind:'record',name:`現場写し: ${entityName(entity)}`,quantity:1,weightKg:.2,sourceEntityId:entity.id,provenanceIds:[...entity.provenanceIds],acquiredDay:state.clock.day,acquiredMinuteOfDay:state.clock.minuteOfDay,
    reading:{fragments:[fragment,...basis.map((entry) => `照合できる伝承: ${readableEvidenceText(entry)}`)],basisKnowledgeIds:basis.map((entry) => entry.id),leadEntityIds:leads.map((entry) => entry.entityId),leads,requiredMinutes:Math.ceil(240/condition),spentMinutes:0,sourceObservation:observedEntityMetadata(entity)}};
  inventory.push(item);
  reserveDirectActivity(state,[actorId],'records',45,'物的痕跡の写しと、参照できる伝承を携行記録に残す。',entity.id);
  return item;
}

export function accessibleArtifactRecords(state: SandboxGameState, actorId: string): PhysicalInventoryItem[] {
  const actor = findAgent(state,actorId); if (!actor?.alive) return [];
  return (state.directPlay?.inventory ?? []).filter((item) => item.quantity > 0 && item.reading && item.ownerId === actorId);
}

export function decodeArtifactRecord(state: SandboxGameState, actorId: string, itemId: string, minutes = 60): KnowledgeEntry | null {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('読解時間は正の分数で指定してください。');
  const item = accessibleArtifactRecords(state,actorId).find((entry) => entry.id === itemId), actor = findAgent(state,actorId);
  if (!item?.reading || !actor || !item.sourceEntityId) throw new Error('携行している記録物だけを読解できます。');
  const reading = item.reading;
  if (reading.decodedKnowledgeId) {
    const known = state.knowledge.find((entry) => entry.id === reading.decodedKnowledgeId && canReadEvidence(state,actorId,entry));
    if (known) return known;
    // An inherited physical copy can be read again even if its previous reader's memory was lost.
  }
  const duration = Math.max(1,Math.min(60,minutes));
  reading.spentMinutes = Math.min(reading.requiredMinutes,reading.spentMinutes + duration * (.5 + effectiveSkill(state,actor,'records') / 100));
  reserveDirectActivity(state,[actorId],'records',duration,'欠損を整理し、物的な記述と伝承の解釈を分けて読む。',item.sourceEntityId);
  if (reading.spentMinutes < reading.requiredMinutes) return null;
  const next = reading.leads.map((lead) => `${lead.label}の周辺で「${lead.prediction === 'archive-record' ? '記録物がある' : traceLabels[lead.prediction] ?? '痕跡がある'}」という観測予測を試せる。`).join(' ');
  const knowledge = addObservedKnowledge(state,[actorId],[...new Set([item.sourceEntityId!,...reading.leadEntityIds])],`${reading.fragments.join('\n')}\n次の照合: ${next || '別の証言や現場の写しと比較する。'}`,Math.min(.75,.35+effectiveSkill(state,actor,'records')/250),undefined,item.provenanceIds,{promoteToSettlement:false});
  knowledge.entityObservation = structuredClone(reading.sourceObservation);
  knowledge.physicalEvidenceSourceEntityId = item.sourceEntityId;
  reading.decodedKnowledgeId = knowledge.id;
  return knowledge;
}

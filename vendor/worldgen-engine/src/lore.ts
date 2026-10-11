import type { JsonValue, KnowledgeRecord } from './contract.js';
import type { ContentPack, ContentPackRegistry } from './content.js';
import { clamp, stableStringify } from './util.js';

export type LoreSourceKind = 'primary-text' | 'ethnographic-collection' | 'comparative-study' | 'classification-reference' | 'archive' | 'modern-scholarship';
export type IngestionPolicy = 'public-domain-text' | 'metadata-only' | 'reference-only';
export type CurationReviewStatus = 'catalog-only' | 'metadata-reviewed' | 'evidence-reviewed' | 'provisional-structural-review';
export type BibliographicParseStatus = 'catalog-label-only' | 'heuristic-family' | 'metadata-reviewed';
export type EvidenceRole = 'catalog-context' | 'motif-evidence' | 'transformation-evidence' | 'transmission-theory' | 'mixed-evidence';
export type CatalogVerificationStatus = 'provider-page-verified' | 'external-catalog-verified' | 'unverified';
export type EvidenceReviewStatus = 'bibliographic-linkage' | 'source-unit-reviewed' | 'locator-reviewed';

export interface LoreSourceUnit {
  id: string;
  label: string;
  locator?: string;
  unitType: 'work' | 'volume' | 'chapter' | 'tale' | 'ritual-description' | 'field-recording' | 'archive-item' | 'article' | 'other';
  evidenceClaimIds?: string[];
}

export interface LoreEvidenceClaim {
  id: string;
  sourceUnitId: string;
  claimType: 'motif-observation' | 'transformation-observation' | 'transmission-observation' | 'theoretical-mechanism' | 'context-note';
  summary: string;
  confidence: number;
  traditionId?: string;
  note?: string;
  reviewStatus?: EvidenceReviewStatus;
  extractionMethod?: 'manual-curation' | 'metadata-inference' | 'machine-assisted-review';
}

export interface LoreSourceRecord {
  id: string;
  title: string;
  creators: string[];
  year?: number;
  traditions: string[];
  domains: string[];
  sourceKind: LoreSourceKind;
  ingestionPolicy: IngestionPolicy;
  accessUrl?: string;
  rightsNote?: string;
  collectionContext?: string;
  translationContext?: string;
  editionContext?: string;
  sensitivityNotes?: string[];
  biasNotes?: string[];
  curationReviewStatus?: CurationReviewStatus;
  verificationStatus?: 'verified-catalog' | 'provisional';
  verificationUrl?: string;
  verificationCheckedAt?: string;
  rightsJurisdiction?: string;
  providerId?: string;
  providerRecordId?: string;
  rawCatalogLabel?: string;
  catalogPosition?: number;
  catalogDuplicatePositions?: number[];
  catalogUrl?: string;
  catalogCategory?: string;
  catalogVerificationStatus?: CatalogVerificationStatus;
  bibliographicFamilyId?: string;
  bibliographicParseStatus?: BibliographicParseStatus;
  evidenceRole?: EvidenceRole;
  sourceUnits?: LoreSourceUnit[];
  evidenceClaims?: LoreEvidenceClaim[];
}

export interface MotifDefinition {
  id: string;
  label: string;
  description: string;
  family: string;
  triggerTags: string[];
  sourceIds: string[];
  dimensions: Record<string, number>;
  cautions?: string[];
  motifeme?: string;
  allomotifs?: string[];
  structuralRoles?: string[];
  ontologyFacets?: string[];
  sourceUnitIds?: string[];
  evidenceClaimIds?: string[];
  evidenceStrength?: number;
  minimumIndependentFamilies?: number;
  curationStatus?: 'active' | 'candidate' | 'deprecated';
  structuralReviewStatus?: 'unreviewed' | 'heuristic-proposal' | 'curated';
}

export interface TransformationRuleDefinition {
  id: string;
  label: string;
  appliesTo: string[];
  sourceIds: string[];
  weight: number;
  effects: Record<string, number>;
  semanticEffect: string;
  preconditions?: string[];
  operations?: string[];
  invariants?: string[];
  directionalBiases?: Record<string, number>;
  contextWeights?: Record<string, number>;
  evidenceClaimIds?: string[];
  confidence?: number;
}

export type TransmissionDirection = 'vertical' | 'horizontal' | 'oblique' | 'one-to-many' | 'many-to-one' | 'mixed';

export interface TransmissionModeDefinition {
  id: string;
  label: string;
  distortion: number;
  retention: number;
  authority: number;
  sourceIds?: string[];
  direction?: TransmissionDirection;
  copyingBiases?: Record<string, number>;
  noiseProfile?: Record<string, number>;
  memoryHalfLifeDays?: number;
  innovationRate?: number;
  complexContagionThreshold?: number;
  channelAffinity?: Record<string, number>;
  evidenceClaimIds?: string[];
}

export type MotifRelationType = 'opposition' | 'prerequisite' | 'co-occurrence' | 'transformation-affinity' | 'substitution' | 'functional-equivalence' | 'sequence' | 'neighborhood' | 'containment' | 'contrast';

export interface MotifRelationDefinition {
  id: string;
  sourceMotifId: string;
  targetMotifId: string;
  relationType: MotifRelationType;
  weight: number;
  sourceIds: string[];
  note?: string;
}

export interface LoreCorpus {
  sources: LoreSourceRecord[];
  motifs: MotifDefinition[];
  transformations: TransformationRuleDefinition[];
  transmissionModes: TransmissionModeDefinition[];
  motifRelations: MotifRelationDefinition[];
  errors: string[];
  warnings: string[];
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}

function records(value: JsonValue | undefined): Record<string, JsonValue>[] {
  return Array.isArray(value) ? value.map((item) => record(item)).filter((item): item is Record<string, JsonValue> => item !== null) : [];
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberMap(value: JsonValue | undefined): Record<string, number> {
  const input = record(value);
  if (!input) return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(input)) if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
  return out;
}

function asSourceUnit(row: Record<string, JsonValue>): LoreSourceUnit | null {
  if (typeof row.id !== 'string' || typeof row.label !== 'string') return null;
  const allowed: LoreSourceUnit['unitType'][] = ['work', 'volume', 'chapter', 'tale', 'ritual-description', 'field-recording', 'archive-item', 'article', 'other'];
  const unitType = typeof row.unitType === 'string' && allowed.includes(row.unitType as LoreSourceUnit['unitType']) ? row.unitType as LoreSourceUnit['unitType'] : 'other';
  const unit: LoreSourceUnit = { id: row.id, label: row.label, unitType };
  if (typeof row.locator === 'string') unit.locator = row.locator;
  const claims = strings(row.evidenceClaimIds); if (claims.length) unit.evidenceClaimIds = claims;
  return unit;
}

function asEvidenceClaim(row: Record<string, JsonValue>): LoreEvidenceClaim | null {
  if (typeof row.id !== 'string' || typeof row.sourceUnitId !== 'string' || typeof row.summary !== 'string') return null;
  const allowed: LoreEvidenceClaim['claimType'][] = ['motif-observation', 'transformation-observation', 'transmission-observation', 'theoretical-mechanism', 'context-note'];
  if (typeof row.claimType !== 'string' || !allowed.includes(row.claimType as LoreEvidenceClaim['claimType'])) return null;
  const claim: LoreEvidenceClaim = {
    id: row.id,
    sourceUnitId: row.sourceUnitId,
    claimType: row.claimType as LoreEvidenceClaim['claimType'],
    summary: row.summary,
    confidence: typeof row.confidence === 'number' ? clamp(row.confidence) : 0.5,
  };
  if (typeof row.traditionId === 'string') claim.traditionId = row.traditionId;
  if (typeof row.note === 'string') claim.note = row.note;
  if (row.reviewStatus === 'bibliographic-linkage' || row.reviewStatus === 'source-unit-reviewed' || row.reviewStatus === 'locator-reviewed') claim.reviewStatus = row.reviewStatus;
  if (row.extractionMethod === 'manual-curation' || row.extractionMethod === 'metadata-inference' || row.extractionMethod === 'machine-assisted-review') claim.extractionMethod = row.extractionMethod;
  return claim;
}

function asSource(row: Record<string, JsonValue>, pack: ContentPack): LoreSourceRecord | null {
  if (typeof row.id !== 'string' || typeof row.title !== 'string') return null;
  const sourceKind = typeof row.sourceKind === 'string' ? row.sourceKind as LoreSourceKind : 'modern-scholarship';
  const ingestionPolicy = typeof row.ingestionPolicy === 'string' ? row.ingestionPolicy as IngestionPolicy : 'metadata-only';
  const source: LoreSourceRecord = {
    id: row.id,
    title: row.title,
    creators: strings(row.creators),
    traditions: strings(row.traditions),
    domains: strings(row.domains),
    sourceKind,
    ingestionPolicy,
  };
  if (typeof row.year === 'number' && Number.isFinite(row.year)) source.year = Math.round(row.year);
  if (typeof row.accessUrl === 'string') source.accessUrl = row.accessUrl;
  if (typeof row.rightsNote === 'string') source.rightsNote = row.rightsNote;
  if (typeof row.collectionContext === 'string') source.collectionContext = row.collectionContext;
  if (typeof row.translationContext === 'string') source.translationContext = row.translationContext;
  if (typeof row.editionContext === 'string') source.editionContext = row.editionContext;
  if (Array.isArray(row.sensitivityNotes)) source.sensitivityNotes = strings(row.sensitivityNotes);
  if (Array.isArray(row.biasNotes)) source.biasNotes = strings(row.biasNotes);
  const reviewStatuses: CurationReviewStatus[] = ['catalog-only', 'metadata-reviewed', 'evidence-reviewed', 'provisional-structural-review'];
  if (typeof row.curationReviewStatus === 'string' && reviewStatuses.includes(row.curationReviewStatus as CurationReviewStatus)) source.curationReviewStatus = row.curationReviewStatus as CurationReviewStatus;
  if (row.verificationStatus === 'verified-catalog' || row.verificationStatus === 'provisional') source.verificationStatus = row.verificationStatus;
  if (typeof row.verificationUrl === 'string') source.verificationUrl = row.verificationUrl;
  if (typeof row.verificationCheckedAt === 'string') source.verificationCheckedAt = row.verificationCheckedAt;
  if (typeof row.rightsJurisdiction === 'string') source.rightsJurisdiction = row.rightsJurisdiction;
  if (typeof row.providerId === 'string') source.providerId = row.providerId;
  if (typeof row.providerRecordId === 'string') source.providerRecordId = row.providerRecordId;
  if (typeof row.rawCatalogLabel === 'string') source.rawCatalogLabel = row.rawCatalogLabel;
  if (typeof row.catalogPosition === 'number' && Number.isFinite(row.catalogPosition)) source.catalogPosition = Math.round(row.catalogPosition);
  if (Array.isArray(row.catalogDuplicatePositions)) source.catalogDuplicatePositions = row.catalogDuplicatePositions.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)).map(Math.round);
  if (typeof row.catalogUrl === 'string') source.catalogUrl = row.catalogUrl;
  if (typeof row.catalogCategory === 'string') source.catalogCategory = row.catalogCategory;
  const catalogVerificationStatuses: CatalogVerificationStatus[] = ['provider-page-verified', 'external-catalog-verified', 'unverified'];
  if (typeof row.catalogVerificationStatus === 'string' && catalogVerificationStatuses.includes(row.catalogVerificationStatus as CatalogVerificationStatus)) source.catalogVerificationStatus = row.catalogVerificationStatus as CatalogVerificationStatus;
  if (typeof row.bibliographicFamilyId === 'string') source.bibliographicFamilyId = row.bibliographicFamilyId;
  const parseStatuses: BibliographicParseStatus[] = ['catalog-label-only', 'heuristic-family', 'metadata-reviewed'];
  if (typeof row.bibliographicParseStatus === 'string' && parseStatuses.includes(row.bibliographicParseStatus as BibliographicParseStatus)) source.bibliographicParseStatus = row.bibliographicParseStatus as BibliographicParseStatus;
  const evidenceRoles: EvidenceRole[] = ['catalog-context', 'motif-evidence', 'transformation-evidence', 'transmission-theory', 'mixed-evidence'];
  if (typeof row.evidenceRole === 'string' && evidenceRoles.includes(row.evidenceRole as EvidenceRole)) source.evidenceRole = row.evidenceRole as EvidenceRole;
  const units = records(row.sourceUnits).map(asSourceUnit).filter((item): item is LoreSourceUnit => item !== null); if (units.length) source.sourceUnits = units;
  const claims = records(row.evidenceClaims).map(asEvidenceClaim).filter((item): item is LoreEvidenceClaim => item !== null); if (claims.length) source.evidenceClaims = claims;
  // Catalog-only rows deliberately keep creators empty. Filling an inferred creator would fabricate bibliography.
  if (!source.creators.length && source.curationReviewStatus !== 'catalog-only') source.creators = [`content-pack:${pack.id}`];
  return source;
}

function asMotif(row: Record<string, JsonValue>): MotifDefinition | null {
  if (typeof row.id !== 'string') return null;
  const sourceIds = strings(row.sourceIds);
  const motif: MotifDefinition = {
    id: row.id,
    label: typeof row.label === 'string' ? row.label : row.id,
    description: typeof row.description === 'string' ? row.description : '',
    family: typeof row.family === 'string' ? row.family : 'uncategorized',
    triggerTags: strings(row.triggerTags),
    sourceIds,
    dimensions: numberMap(row.dimensions),
    cautions: strings(row.cautions),
  };
  if (typeof row.motifeme === 'string') motif.motifeme = row.motifeme;
  const allomotifs = strings(row.allomotifs); if (allomotifs.length) motif.allomotifs = allomotifs;
  const structuralRoles = strings(row.structuralRoles); if (structuralRoles.length) motif.structuralRoles = structuralRoles;
  const ontologyFacets = strings(row.ontologyFacets); if (ontologyFacets.length) motif.ontologyFacets = ontologyFacets;
  const sourceUnitIds = strings(row.sourceUnitIds); if (sourceUnitIds.length) motif.sourceUnitIds = sourceUnitIds;
  const evidenceClaimIds = strings(row.evidenceClaimIds); if (evidenceClaimIds.length) motif.evidenceClaimIds = evidenceClaimIds;
  if (typeof row.evidenceStrength === 'number') motif.evidenceStrength = clamp(row.evidenceStrength);
  if (typeof row.minimumIndependentFamilies === 'number') motif.minimumIndependentFamilies = Math.max(1, Math.round(row.minimumIndependentFamilies));
  if (row.curationStatus === 'active' || row.curationStatus === 'candidate' || row.curationStatus === 'deprecated') motif.curationStatus = row.curationStatus;
  if (row.structuralReviewStatus === 'unreviewed' || row.structuralReviewStatus === 'heuristic-proposal' || row.structuralReviewStatus === 'curated') motif.structuralReviewStatus = row.structuralReviewStatus;
  return motif;
}

function asTransformation(row: Record<string, JsonValue>): TransformationRuleDefinition | null {
  if (typeof row.id !== 'string') return null;
  const rule: TransformationRuleDefinition = {
    id: row.id,
    label: typeof row.label === 'string' ? row.label : row.id,
    appliesTo: strings(row.appliesTo),
    sourceIds: strings(row.sourceIds),
    weight: typeof row.weight === 'number' ? clamp(row.weight, 0, 100) : 1,
    effects: numberMap(row.effects),
    semanticEffect: typeof row.semanticEffect === 'string' ? row.semanticEffect : row.id,
  };
  const preconditions = strings(row.preconditions); if (preconditions.length) rule.preconditions = preconditions;
  const operations = strings(row.operations); if (operations.length) rule.operations = operations;
  const invariants = strings(row.invariants); if (invariants.length) rule.invariants = invariants;
  const directionalBiases = numberMap(row.directionalBiases); if (Object.keys(directionalBiases).length) rule.directionalBiases = directionalBiases;
  const contextWeights = numberMap(row.contextWeights); if (Object.keys(contextWeights).length) rule.contextWeights = contextWeights;
  const evidenceClaimIds = strings(row.evidenceClaimIds); if (evidenceClaimIds.length) rule.evidenceClaimIds = evidenceClaimIds;
  if (typeof row.confidence === 'number') rule.confidence = clamp(row.confidence);
  return rule;
}

function asTransmission(row: Record<string, JsonValue>): TransmissionModeDefinition | null {
  if (typeof row.id !== 'string') return null;
  const mode: TransmissionModeDefinition = {
    id: row.id,
    label: typeof row.label === 'string' ? row.label : row.id,
    distortion: typeof row.distortion === 'number' ? clamp(row.distortion) : 0.2,
    retention: typeof row.retention === 'number' ? clamp(row.retention) : 0.7,
    authority: typeof row.authority === 'number' ? clamp(row.authority) : 0.4,
  };
  const sourceIds = strings(row.sourceIds); if (sourceIds.length) mode.sourceIds = sourceIds;
  const directions: TransmissionDirection[] = ['vertical', 'horizontal', 'oblique', 'one-to-many', 'many-to-one', 'mixed'];
  if (typeof row.direction === 'string' && directions.includes(row.direction as TransmissionDirection)) mode.direction = row.direction as TransmissionDirection;
  const copyingBiases = numberMap(row.copyingBiases); if (Object.keys(copyingBiases).length) mode.copyingBiases = copyingBiases;
  const noiseProfile = numberMap(row.noiseProfile); if (Object.keys(noiseProfile).length) mode.noiseProfile = noiseProfile;
  if (typeof row.memoryHalfLifeDays === 'number' && Number.isFinite(row.memoryHalfLifeDays)) mode.memoryHalfLifeDays = Math.max(0.01, row.memoryHalfLifeDays);
  if (typeof row.innovationRate === 'number') mode.innovationRate = clamp(row.innovationRate);
  if (typeof row.complexContagionThreshold === 'number' && Number.isFinite(row.complexContagionThreshold)) mode.complexContagionThreshold = Math.max(1, Math.round(row.complexContagionThreshold));
  const channelAffinity = numberMap(row.channelAffinity); if (Object.keys(channelAffinity).length) mode.channelAffinity = channelAffinity;
  const evidenceClaimIds = strings(row.evidenceClaimIds); if (evidenceClaimIds.length) mode.evidenceClaimIds = evidenceClaimIds;
  return mode;
}

function asMotifRelation(row: Record<string, JsonValue>): MotifRelationDefinition | null {
  if (typeof row.id !== 'string' || typeof row.sourceMotifId !== 'string' || typeof row.targetMotifId !== 'string') return null;
  const allowed: MotifRelationType[] = ['opposition', 'prerequisite', 'co-occurrence', 'transformation-affinity', 'substitution', 'functional-equivalence', 'sequence', 'neighborhood', 'containment', 'contrast'];
  if (typeof row.relationType !== 'string' || !allowed.includes(row.relationType as MotifRelationType)) return null;
  const result: MotifRelationDefinition = {
    id: row.id,
    sourceMotifId: row.sourceMotifId,
    targetMotifId: row.targetMotifId,
    relationType: row.relationType as MotifRelationType,
    weight: typeof row.weight === 'number' ? clamp(row.weight, 0, 100) : 1,
    sourceIds: strings(row.sourceIds),
  };
  if (typeof row.note === 'string') result.note = row.note;
  return result;
}

export function buildLoreCorpus(content: ContentPackRegistry): LoreCorpus {
  const sources = new Map<string, LoreSourceRecord>();
  const motifs = new Map<string, MotifDefinition>();
  const transformations = new Map<string, TransformationRuleDefinition>();
  const transmissionModes = new Map<string, TransmissionModeDefinition>();
  const motifRelations = new Map<string, MotifRelationDefinition>();
  const errors: string[] = [];
  const warnings: string[] = [];

  const putUnique = <T extends { id: string }>(map: Map<string, T>, item: T, label: string, packId: string): void => {
    const prior = map.get(item.id);
    if (prior && stableStringify(prior) !== stableStringify(item)) errors.push(`Conflicting ${label} ${item.id} in content pack ${packId}`);
    else map.set(item.id, item);
  };

  for (const pack of content.list()) {
    const corpus = record(pack.data.loreCorpus) ?? pack.data;
    for (const row of records(corpus.sourceCatalog)) {
      const source = asSource(row, pack);
      if (!source) errors.push(`Invalid lore source in content pack ${pack.id}`);
      else putUnique(sources, source, 'lore source', pack.id);
    }
    for (const row of records(corpus.motifs)) {
      const motif = asMotif(row);
      if (!motif) errors.push(`Invalid motif in content pack ${pack.id}`);
      else putUnique(motifs, motif, 'motif', pack.id);
    }
    for (const row of records(corpus.transformationRules)) {
      const rule = asTransformation(row);
      if (!rule) errors.push(`Invalid transformation rule in content pack ${pack.id}`);
      else putUnique(transformations, rule, 'transformation rule', pack.id);
    }
    for (const row of records(corpus.transmissionModes)) {
      const mode = asTransmission(row);
      if (!mode) errors.push(`Invalid transmission mode in content pack ${pack.id}`);
      else putUnique(transmissionModes, mode, 'transmission mode', pack.id);
    }
    for (const row of records(corpus.motifRelations)) {
      const relation = asMotifRelation(row);
      if (!relation) errors.push(`Invalid motif relation in content pack ${pack.id}`);
      else putUnique(motifRelations, relation, 'motif relation', pack.id);
    }
  }

  const validateRefs = (owner: string, refs: string[]): void => {
    for (const sourceId of refs) if (!sources.has(sourceId)) errors.push(`${owner} references missing lore source ${sourceId}`);
  };
  const sourceUnitIds = new Set<string>();
  const evidenceClaimIds = new Set<string>();
  for (const source of sources.values()) {
    const localUnits = new Set((source.sourceUnits ?? []).map((unit) => unit.id));
    const localClaims = new Set((source.evidenceClaims ?? []).map((claim) => claim.id));
    for (const unit of source.sourceUnits ?? []) {
      if (sourceUnitIds.has(unit.id)) errors.push(`Duplicate lore source unit ${unit.id}`);
      sourceUnitIds.add(unit.id);
      for (const claimId of unit.evidenceClaimIds ?? []) if (!localClaims.has(claimId)) errors.push(`source unit ${unit.id} references missing evidence claim ${claimId}`);
    }
    for (const claim of source.evidenceClaims ?? []) {
      if (evidenceClaimIds.has(claim.id)) errors.push(`Duplicate lore evidence claim ${claim.id}`);
      evidenceClaimIds.add(claim.id);
      if (!localUnits.has(claim.sourceUnitId)) errors.push(`evidence claim ${claim.id} references missing source unit ${claim.sourceUnitId}`);
    }
  }
  for (const motif of motifs.values()) {
    validateRefs(`motif ${motif.id}`, motif.sourceIds);
    if (!motif.triggerTags.length) warnings.push(`motif ${motif.id} has no triggerTags`);
  }
  for (const motif of motifs.values()) {
    for (const unitId of motif.sourceUnitIds ?? []) if (!sourceUnitIds.has(unitId)) errors.push(`motif ${motif.id} references missing source unit ${unitId}`);
    for (const claimId of motif.evidenceClaimIds ?? []) if (!evidenceClaimIds.has(claimId)) errors.push(`motif ${motif.id} references missing evidence claim ${claimId}`);
  }
  for (const rule of transformations.values()) {
    validateRefs(`transformation ${rule.id}`, rule.sourceIds);
    for (const claimId of rule.evidenceClaimIds ?? []) if (!evidenceClaimIds.has(claimId)) errors.push(`transformation ${rule.id} references missing evidence claim ${claimId}`);
  }
  for (const mode of transmissionModes.values()) {
    validateRefs(`transmission mode ${mode.id}`, mode.sourceIds ?? []);
    for (const claimId of mode.evidenceClaimIds ?? []) if (!evidenceClaimIds.has(claimId)) errors.push(`transmission mode ${mode.id} references missing evidence claim ${claimId}`);
  }
  for (const relation of motifRelations.values()) {
    if (!motifs.has(relation.sourceMotifId)) errors.push(`motif relation ${relation.id} references missing source motif ${relation.sourceMotifId}`);
    if (!motifs.has(relation.targetMotifId)) errors.push(`motif relation ${relation.id} references missing target motif ${relation.targetMotifId}`);
    validateRefs(`motif relation ${relation.id}`, relation.sourceIds);
  }
  if (motifs.size && !sources.size) warnings.push('motifs are present without a sourceCatalog');

  return {
    sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)),
    motifs: [...motifs.values()].sort((a, b) => a.id.localeCompare(b.id)),
    transformations: [...transformations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    transmissionModes: [...transmissionModes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    motifRelations: [...motifRelations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    errors,
    warnings,
  };
}

export function assertLoreCorpus(content: ContentPackRegistry): LoreCorpus {
  const corpus = buildLoreCorpus(content);
  if (corpus.errors.length) throw new Error(`Lore corpus validation failed:\n${corpus.errors.join('\n')}`);
  return corpus;
}

export function knowledgeSemanticTags(record: KnowledgeRecord): string[] {
  const tags = new Set<string>();
  const variable = record.claim.variable;
  const interpretation = record.claim.interpretation;
  if (typeof variable === 'string') {
    for (const part of variable.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean)) tags.add(part);
  }
  if (typeof interpretation === 'string') {
    for (const part of interpretation.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean)) tags.add(part);
  }
  for (const key of ['traceType', 'assertedOriginClass', 'claimType']) {
    const claimValue = record.claim[key];
    if (typeof claimValue === 'string') for (const part of claimValue.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean)) tags.add(part);
  }
  const value = record.claim.value;
  if (typeof value === 'number') {
    tags.add('change');
    tags.add(value >= 0.5 ? 'intensification' : 'weakening');
  }
  if (record.confidence < 0.4) tags.add('uncertainty');
  if (record.truthLinkIds?.length) tags.add('hidden-cause');
  return [...tags].sort();
}

export function motifCompatibility(tags: string[], motif: MotifDefinition): number {
  if (!motif.triggerTags.length) return 0.05;
  const set = new Set(tags);
  const overlap = motif.triggerTags.reduce((sum, tag) => sum + (set.has(tag) ? 1 : 0), 0);
  return overlap / motif.triggerTags.length;
}


export interface LoreCorpusAudit {
  sourceCount: number;
  catalogOnlySourceCount: number;
  evidenceEligibleSourceCount: number;
  uniqueCatalogRawLabelCount: number;
  uniqueBibliographicFamilyCount: number;
  verifiedSourceCount: number;
  verifiedPublicDomainSourceCount: number;
  provisionalSourceIds: string[];
  motifCount: number;
  transformationCount: number;
  transmissionModeCount: number;
  motifRelationCount: number;
  provenanceCompleteness: number;
  dominantTradition?: string;
  dominantTraditionShare: number;
  effectiveTraditionCount: number;
  traditionCounts: Record<string, number>;
  ingestionPolicyCounts: Record<string, number>;
  catalogProviderCounts: Record<string, number>;
  dominantCatalogProvider?: string;
  dominantCatalogProviderShare: number;
  invalidCatalogEvidenceRefs: Array<{ ownerId: string; sourceId: string }>;
  motifIndependentFamilySupport: Record<string, number>;
  underSupportedMotifIds: string[];
  activeMotifCount: number;
  candidateMotifCount: number;
  deprecatedMotifCount: number;
  structurallyCuratedMotifCount: number;
  structurallyCuratedActiveMotifCount: number;
  structurallyCuratedActiveMotifCoverage: number;
  motifSourceUnitCoverage: number;
  motifEvidenceClaimCoverage: number;
  activeMotifSourceUnitCoverage: number;
  activeMotifEvidenceClaimCoverage: number;
  transformationEvidenceClaimCoverage: number;
  transmissionEvidenceClaimCoverage: number;
  transmissionSourceProvenanceCoverage: number;
  underSupportedActiveMotifIds: string[];
  transformationIndependentFamilySupport: Record<string, number>;
  underSupportedTransformationIds: string[];
  transmissionTheorySupport: Record<string, number>;
  unsupportedTransmissionModeIds: string[];
  unsupportedGeneralizationMotifIds: string[];
  duplicateSemanticCandidates: Array<{ firstId: string; secondId: string; similarity: number }>;
  contextualReviewCoverage: number;
  verifiedMetadataReviewCoverage: number;
  sensitivityNoteCoverage: number;
  warnings: string[];
}

function lexicalTokens(value: string): Set<string> {
  const stop = new Set([
    'the','a','an','of','to','and','or','in','from','with','by','as','is','are','through','into','that','where','when',
    'motif','normalized','ontology','records','reusable','interpretive','pattern','rather','than','asserting','source','specific','narrative','world','truth',
  ]);
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length >= 3 && !stop.has(token)));
}

function semanticSignature(motif: MotifDefinition): { label: Set<string>; triggers: Set<string>; normalizedLabel: string } {
  const label = lexicalTokens(motif.label);
  const triggers = lexicalTokens(motif.triggerTags.join(' '));
  for (const familyToken of lexicalTokens(motif.family)) triggers.delete(familyToken);
  return { label, triggers, normalizedLabel: [...label].sort().join(' ') };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function semanticDuplicateScore(
  first: ReturnType<typeof semanticSignature>,
  second: ReturnType<typeof semanticSignature>,
): number | null {
  if (first.normalizedLabel && first.normalizedLabel === second.normalizedLabel) return 1;
  const sharedLabel = [...first.label].filter((token) => second.label.has(token)).length;
  const labelSimilarity = jaccard(first.label, second.label);
  const triggerSimilarity = jaccard(first.triggers, second.triggers);
  const weighted = labelSimilarity * 0.7 + triggerSimilarity * 0.3;
  // Require a strongly shared semantic head. Family/category boilerplate alone must not create duplicate alerts.
  return sharedLabel >= 2 && labelSimilarity >= 0.8 && weighted >= 0.78 ? weighted : null;
}

export function isLoreSourceEvidenceEligible(source: LoreSourceRecord): boolean {
  if (source.curationReviewStatus === 'catalog-only' || source.evidenceRole === 'catalog-context') return false;
  if (source.curationReviewStatus === 'evidence-reviewed') return true;
  // Backward-compatible treatment for the pre-v6 curated corpus. New catalog imports must opt in via evidence-reviewed.
  return source.curationReviewStatus === 'metadata-reviewed' && source.catalogVerificationStatus === undefined;
}

function sourceFamilyId(source: LoreSourceRecord): string {
  return source.bibliographicFamilyId ?? source.id;
}

/** Quality-control report for bibliography coverage and ontology support. It does not alter the corpus. */
export function auditLoreCorpus(corpus: LoreCorpus): LoreCorpusAudit {
  const catalogOnlySources = corpus.sources.filter((source) => source.curationReviewStatus === 'catalog-only' || source.evidenceRole === 'catalog-context');
  const evidenceSources = corpus.sources.filter(isLoreSourceEvidenceEligible);
  const evidenceSourceIds = new Set(evidenceSources.map((source) => source.id));
  const sourceById = new Map(corpus.sources.map((source) => [source.id, source]));
  const traditionCounts: Record<string, number> = {};
  const catalogProviderCounts: Record<string, number> = {};
  const verifiedSources = corpus.sources.filter((source) => source.verificationStatus === 'verified-catalog');
  const verifiedPublicDomainSources = verifiedSources.filter((source) => source.ingestionPolicy === 'public-domain-text' && typeof source.verificationUrl === 'string');
  const provisionalSourceIds = corpus.sources.filter((source) => source.curationReviewStatus !== 'catalog-only' && source.verificationStatus !== 'verified-catalog').map((source) => source.id).sort();
  const reviewScope = corpus.sources.filter((source) => source.curationReviewStatus !== 'catalog-only');
  const verifiedReviewScope = verifiedSources.filter((source) => source.curationReviewStatus !== 'catalog-only');
  const contextualReviewCoverage = reviewScope.length ? reviewScope.filter((source) => typeof source.collectionContext === 'string' && source.collectionContext.length > 0 && Array.isArray(source.biasNotes) && source.biasNotes.length > 0).length / reviewScope.length : 1;
  const sensitivityNoteCoverage = reviewScope.length ? reviewScope.filter((source) => Array.isArray(source.sensitivityNotes) && source.sensitivityNotes.length > 0).length / reviewScope.length : 1;
  const verifiedMetadataReviewCoverage = verifiedReviewScope.length ? verifiedReviewScope.filter((source) => (source.curationReviewStatus === 'metadata-reviewed' || source.curationReviewStatus === 'evidence-reviewed') && typeof source.editionContext === 'string' && typeof source.translationContext === 'string').length / verifiedReviewScope.length : 1;
  const ingestionPolicyCounts: Record<string, number> = {};
  for (const source of corpus.sources) {
    ingestionPolicyCounts[source.ingestionPolicy] = (ingestionPolicyCounts[source.ingestionPolicy] ?? 0) + 1;
    if (source.curationReviewStatus === 'catalog-only' || source.evidenceRole === 'catalog-context') {
      const provider = source.providerId ?? 'unknown-provider';
      catalogProviderCounts[provider] = (catalogProviderCounts[provider] ?? 0) + 1;
    }
  }
  for (const source of evidenceSources) {
    for (const tradition of source.traditions) {
      if (tradition === 'comparative' || tradition === 'global' || tradition === 'unclassified') continue;
      traditionCounts[tradition] = (traditionCounts[tradition] ?? 0) + 1;
    }
  }
  const traditionTotal = Object.values(traditionCounts).reduce((sum, value) => sum + value, 0);
  const rankedTraditions = Object.entries(traditionCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const dominantTradition = rankedTraditions[0]?.[0];
  const dominantTraditionShare = rankedTraditions[0] ? rankedTraditions[0][1] / Math.max(1, traditionTotal) : 0;
  const sumSquares = Object.values(traditionCounts).reduce((sum, value) => {
    const share = value / Math.max(1, traditionTotal);
    return sum + share * share;
  }, 0);
  const effectiveTraditionCount = sumSquares > 0 ? 1 / sumSquares : 0;
  const catalogTotal = Object.values(catalogProviderCounts).reduce((sum, value) => sum + value, 0);
  const rankedProviders = Object.entries(catalogProviderCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const dominantCatalogProvider = rankedProviders[0]?.[0];
  const dominantCatalogProviderShare = rankedProviders[0] ? rankedProviders[0][1] / Math.max(1, catalogTotal) : 0;

  const supportChecks = [
    ...corpus.motifs.map((item) => item.sourceIds.length > 0),
    ...corpus.transformations.map((item) => item.sourceIds.length > 0),
    ...corpus.motifRelations.map((item) => item.sourceIds.length > 0),
  ];
  const provenanceCompleteness = supportChecks.length ? supportChecks.filter(Boolean).length / supportChecks.length : 1;

  const invalidCatalogEvidenceRefs: Array<{ ownerId: string; sourceId: string }> = [];
  const evidenceFamilies = (refs: string[], ownerId: string): Set<string> => {
    const families = new Set<string>();
    for (const sourceId of refs) {
      const source = sourceById.get(sourceId);
      if (!source) continue;
      if (!evidenceSourceIds.has(sourceId)) {
        if (source.curationReviewStatus === 'catalog-only' || source.evidenceRole === 'catalog-context') invalidCatalogEvidenceRefs.push({ ownerId, sourceId });
        continue;
      }
      families.add(sourceFamilyId(source));
    }
    return families;
  };
  const motifIndependentFamilySupport: Record<string, number> = {};
  const underSupportedMotifIds: string[] = [];
  const underSupportedActiveMotifIds: string[] = [];
  for (const motif of corpus.motifs) {
    const count = evidenceFamilies(motif.sourceIds, `motif:${motif.id}`).size;
    motifIndependentFamilySupport[motif.id] = count;
    const minimum = motif.minimumIndependentFamilies ?? (motif.family === 'setting-extension' ? 1 : 2);
    if (count < minimum) {
      underSupportedMotifIds.push(motif.id);
      if ((motif.curationStatus ?? 'active') === 'active') underSupportedActiveMotifIds.push(motif.id);
    }
  }
  const transformationIndependentFamilySupport: Record<string, number> = {};
  const underSupportedTransformationIds: string[] = [];
  for (const rule of corpus.transformations) {
    const count = evidenceFamilies(rule.sourceIds, `transformation:${rule.id}`).size;
    transformationIndependentFamilySupport[rule.id] = count;
    if (count < 1) underSupportedTransformationIds.push(rule.id);
  }
  const transmissionTheorySupport: Record<string, number> = {};
  const unsupportedTransmissionModeIds: string[] = [];
  for (const mode of corpus.transmissionModes) {
    if (!mode.sourceIds?.length) continue; // legacy modes predate explicit theory provenance
    const count = evidenceFamilies(mode.sourceIds, `transmission:${mode.id}`).size;
    transmissionTheorySupport[mode.id] = count;
    if (count < 1) unsupportedTransmissionModeIds.push(mode.id);
  }

  const unsupportedGeneralizationMotifIds = corpus.motifs
    .filter((motif) => (motif.curationStatus ?? 'active') === 'active' && motif.family !== 'setting-extension' && (motifIndependentFamilySupport[motif.id] ?? 0) < 2 && (motif.triggerTags.length >= 2 || Object.keys(motif.dimensions).length >= 2))
    .map((motif) => motif.id)
    .sort();

  const duplicateSemanticCandidates: Array<{ firstId: string; secondId: string; similarity: number }> = [];
  const tokenized = corpus.motifs.map((motif) => ({ motif, signature: semanticSignature(motif) }));
  for (let i = 0; i < tokenized.length; i += 1) {
    for (let j = i + 1; j < tokenized.length; j += 1) {
      const first = tokenized[i]!; const second = tokenized[j]!;
      const similarity = semanticDuplicateScore(first.signature, second.signature);
      if (similarity !== null) duplicateSemanticCandidates.push({ firstId: first.motif.id, secondId: second.motif.id, similarity });
    }
  }
  duplicateSemanticCandidates.sort((a, b) => b.similarity - a.similarity || a.firstId.localeCompare(b.firstId) || a.secondId.localeCompare(b.secondId));

  const uniqueRawLabels = new Set(catalogOnlySources.map((source) => source.rawCatalogLabel).filter((label): label is string => typeof label === 'string' && label.length > 0));
  const uniqueFamilies = new Set(corpus.sources.map(sourceFamilyId));
  const activeMotifs = corpus.motifs.filter((motif) => (motif.curationStatus ?? 'active') === 'active');
  const structurallyCuratedMotifs = corpus.motifs.filter((motif) => motif.structuralReviewStatus === 'curated' && typeof motif.motifeme === 'string' && motif.motifeme.length > 0 && (motif.structuralRoles?.length ?? 0) > 0);
  const structurallyCuratedActiveMotifs = activeMotifs.filter((motif) => motif.structuralReviewStatus === 'curated' && typeof motif.motifeme === 'string' && motif.motifeme.length > 0 && (motif.structuralRoles?.length ?? 0) > 0);
  const structurallyCuratedActiveMotifCoverage = structurallyCuratedActiveMotifs.length / Math.max(1, activeMotifs.length);
  const claimById = new Map(corpus.sources.flatMap((source) => source.evidenceClaims ?? []).map((claim) => [claim.id, claim]));
  const reviewedUnitIds = new Set<string>();
  for (const source of corpus.sources) for (const claim of source.evidenceClaims ?? []) if (claim.reviewStatus === 'source-unit-reviewed' || claim.reviewStatus === 'locator-reviewed') reviewedUnitIds.add(claim.sourceUnitId);
  const hasReviewedUnit = (motif: MotifDefinition): boolean => (motif.sourceUnitIds ?? []).some((id) => reviewedUnitIds.has(id));
  const hasReviewedClaim = (motif: MotifDefinition): boolean => (motif.evidenceClaimIds ?? []).some((id) => { const claim = claimById.get(id); return claim?.reviewStatus === 'source-unit-reviewed' || claim?.reviewStatus === 'locator-reviewed'; });
  const motifSourceUnitCoverage = corpus.motifs.filter(hasReviewedUnit).length / Math.max(1, corpus.motifs.length);
  const motifEvidenceClaimCoverage = corpus.motifs.filter(hasReviewedClaim).length / Math.max(1, corpus.motifs.length);
  const activeMotifSourceUnitCoverage = activeMotifs.filter(hasReviewedUnit).length / Math.max(1, activeMotifs.length);
  const activeMotifEvidenceClaimCoverage = activeMotifs.filter(hasReviewedClaim).length / Math.max(1, activeMotifs.length);
  const hasReviewedClaimIds = (ids?: string[]): boolean => (ids ?? []).some((id) => { const claim = claimById.get(id); return claim?.reviewStatus === 'source-unit-reviewed' || claim?.reviewStatus === 'locator-reviewed'; });
  const transformationEvidenceClaimCoverage = corpus.transformations.filter((rule) => hasReviewedClaimIds(rule.evidenceClaimIds)).length / Math.max(1, corpus.transformations.length);
  const transmissionEvidenceClaimCoverage = corpus.transmissionModes.filter((mode) => hasReviewedClaimIds(mode.evidenceClaimIds)).length / Math.max(1, corpus.transmissionModes.length);
  const transmissionSourceProvenanceCoverage = corpus.transmissionModes.filter((mode) => (mode.sourceIds?.length ?? 0) > 0).length / Math.max(1, corpus.transmissionModes.length);
  const warnings: string[] = [];
  if (provenanceCompleteness < 1) warnings.push(`Lore provenance completeness is ${(provenanceCompleteness * 100).toFixed(1)}%; every normalized claim should be source-backed.`);
  if (dominantTraditionShare > 0.35 && dominantTradition) warnings.push(`Cultural concentration warning: ${dominantTradition} accounts for ${(dominantTraditionShare * 100).toFixed(1)}% of evidence-eligible tradition-tagged source coverage.`);
  if (effectiveTraditionCount < 8) warnings.push(`Cultural breadth warning: effective tradition count is ${effectiveTraditionCount.toFixed(2)}; target is >= 8 before release.`);
  if (unsupportedGeneralizationMotifIds.length) warnings.push(`${unsupportedGeneralizationMotifIds.length} active motifs make broad normalized claims with fewer than two independent evidence families.`);
  if (duplicateSemanticCandidates.length) warnings.push(`${duplicateSemanticCandidates.length} motif pairs may be semantic duplicates and require curator review.`);
  const verificationScope = corpus.sources.filter((source) => source.curationReviewStatus !== 'catalog-only');
  const verifiedInScope = verificationScope.filter((source) => source.verificationStatus === 'verified-catalog');
  if (verifiedInScope.length / Math.max(1, verificationScope.length) < 0.8) warnings.push(`Catalog verification incomplete: ${verifiedInScope.length}/${verificationScope.length} curated source records have been checked against an external catalog; target is >=80% before release.`);
  if (contextualReviewCoverage < 1) warnings.push(`Source mediation/context review incomplete: ${(contextualReviewCoverage * 100).toFixed(1)}% of curated records carry collection-context and bias notes.`);
  if (sensitivityNoteCoverage < 1) warnings.push(`Sensitivity/context notes incomplete: ${(sensitivityNoteCoverage * 100).toFixed(1)}% of curated records carry abstraction cautions.`);
  if (verifiedMetadataReviewCoverage < 1) warnings.push(`Verified-source metadata review incomplete: ${(verifiedMetadataReviewCoverage * 100).toFixed(1)}% of verified curated records carry edition/translation review status.`);
  if (invalidCatalogEvidenceRefs.length) warnings.push(`${invalidCatalogEvidenceRefs.length} ontology references improperly cite catalog-only records as evidence.`);
  if (underSupportedTransformationIds.length) warnings.push(`${underSupportedTransformationIds.length} transformation rules have no evidence-eligible bibliographic family.`);
  if (unsupportedTransmissionModeIds.length) warnings.push(`${unsupportedTransmissionModeIds.length} transmission modes declare theory provenance but have no evidence-eligible bibliographic family.`);
  if (catalogOnlySources.length >= 1000 && dominantCatalogProviderShare > 0.6) warnings.push(`Catalog provider concentration warning: ${dominantCatalogProvider ?? 'one provider'} supplies ${(dominantCatalogProviderShare * 100).toFixed(1)}% of catalog-only records; release target is <=60% unless the project owner accepts an alternate stratified criterion.`);
  if (structurallyCuratedActiveMotifCoverage < 0.8) warnings.push(`Structural motif curation incomplete: ${(structurallyCuratedActiveMotifCoverage * 100).toFixed(1)}% of active motifs have curator-reviewed motifeme/role structure; target is >=80%.`);
  if (activeMotifSourceUnitCoverage < 0.8) warnings.push(`Motif source-unit linkage incomplete: ${(activeMotifSourceUnitCoverage * 100).toFixed(1)}% of active motifs cite reviewed source units; target is >=80%.`);
  if (activeMotifEvidenceClaimCoverage < 0.8) warnings.push(`Motif evidence-claim linkage incomplete: ${(activeMotifEvidenceClaimCoverage * 100).toFixed(1)}% of active motifs cite explicit evidence claims; target is >=80%.`);
  if (transformationEvidenceClaimCoverage < 1) warnings.push(`Transformation evidence-claim linkage incomplete: ${(transformationEvidenceClaimCoverage * 100).toFixed(1)}% of transformation rules cite reviewed claims; target is 100% for declared mechanism provenance.`);
  if (transmissionEvidenceClaimCoverage < 1) warnings.push(`Transmission evidence-claim linkage incomplete: ${(transmissionEvidenceClaimCoverage * 100).toFixed(1)}% of transmission modes cite reviewed claims; target is 100%.`);
  if (transmissionSourceProvenanceCoverage < 1) warnings.push(`Transmission source provenance incomplete: ${(transmissionSourceProvenanceCoverage * 100).toFixed(1)}% of transmission modes declare source IDs; target is 100%.`);

  return {
    sourceCount: corpus.sources.length,
    catalogOnlySourceCount: catalogOnlySources.length,
    evidenceEligibleSourceCount: evidenceSources.length,
    uniqueCatalogRawLabelCount: uniqueRawLabels.size,
    uniqueBibliographicFamilyCount: uniqueFamilies.size,
    verifiedSourceCount: verifiedSources.length,
    verifiedPublicDomainSourceCount: verifiedPublicDomainSources.length,
    provisionalSourceIds,
    motifCount: corpus.motifs.length,
    transformationCount: corpus.transformations.length,
    transmissionModeCount: corpus.transmissionModes.length,
    motifRelationCount: corpus.motifRelations.length,
    provenanceCompleteness,
    ...(dominantTradition ? { dominantTradition } : {}),
    dominantTraditionShare,
    effectiveTraditionCount,
    traditionCounts,
    ingestionPolicyCounts,
    catalogProviderCounts,
    ...(dominantCatalogProvider ? { dominantCatalogProvider } : {}),
    dominantCatalogProviderShare,
    invalidCatalogEvidenceRefs,
    motifIndependentFamilySupport,
    underSupportedMotifIds: underSupportedMotifIds.sort(),
    activeMotifCount: activeMotifs.length,
    candidateMotifCount: corpus.motifs.filter((motif) => motif.curationStatus === 'candidate').length,
    deprecatedMotifCount: corpus.motifs.filter((motif) => motif.curationStatus === 'deprecated').length,
    structurallyCuratedMotifCount: structurallyCuratedMotifs.length,
    structurallyCuratedActiveMotifCount: structurallyCuratedActiveMotifs.length,
    structurallyCuratedActiveMotifCoverage,
    motifSourceUnitCoverage,
    motifEvidenceClaimCoverage,
    activeMotifSourceUnitCoverage,
    activeMotifEvidenceClaimCoverage,
    transformationEvidenceClaimCoverage,
    transmissionEvidenceClaimCoverage,
    transmissionSourceProvenanceCoverage,
    underSupportedActiveMotifIds: underSupportedActiveMotifIds.sort(),
    transformationIndependentFamilySupport,
    underSupportedTransformationIds: underSupportedTransformationIds.sort(),
    transmissionTheorySupport,
    unsupportedTransmissionModeIds: unsupportedTransmissionModeIds.sort(),
    unsupportedGeneralizationMotifIds,
    duplicateSemanticCandidates,
    contextualReviewCoverage,
    verifiedMetadataReviewCoverage,
    sensitivityNoteCoverage,
    warnings,
  };
}


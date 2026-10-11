import type { KnowledgeRecord } from './contract.js';
import type { ContentPackRegistry } from './content.js';
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
export declare function buildLoreCorpus(content: ContentPackRegistry): LoreCorpus;
export declare function assertLoreCorpus(content: ContentPackRegistry): LoreCorpus;
export declare function knowledgeSemanticTags(record: KnowledgeRecord): string[];
export declare function motifCompatibility(tags: string[], motif: MotifDefinition): number;
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
    invalidCatalogEvidenceRefs: Array<{
        ownerId: string;
        sourceId: string;
    }>;
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
    duplicateSemanticCandidates: Array<{
        firstId: string;
        secondId: string;
        similarity: number;
    }>;
    contextualReviewCoverage: number;
    verifiedMetadataReviewCoverage: number;
    sensitivityNoteCoverage: number;
    warnings: string[];
}
export declare function isLoreSourceEvidenceEligible(source: LoreSourceRecord): boolean;
/** Quality-control report for bibliography coverage and ontology support. It does not alter the corpus. */
export declare function auditLoreCorpus(corpus: LoreCorpus): LoreCorpusAudit;

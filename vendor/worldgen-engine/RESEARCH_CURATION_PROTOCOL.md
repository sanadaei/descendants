# Research Curation Protocol — Source Catalog -> Evidence -> Ontology

This protocol is mandatory for R1. It exists to prevent a 1000+ row catalog from being mistaken for 1000 independent pieces of cultural evidence.

## 1. Four evidence layers

### Layer A — catalog record
Discovery/bibliographic metadata only. May be `catalog-only` and `metadata-only`. It can establish that a record exists in a provider catalog, but it cannot establish that a motif/practice occurs in the underlying material.

### Layer B — bibliographic family
Groups editions, translations, volumes, duplicate digitizations, and other non-independent manifestations. Family-level counts are used to prevent evidence inflation.

### Layer C — source unit
The reviewed unit in which evidence occurs: work, chapter, tale, field item, performance, interview, ritual description, archival record, etc. Store the smallest stable unit practical for later checking.

### Layer D — evidence claim
An explicit reviewed assertion tied to a source unit. A claim must state what the source supports; it should include a locator when the provider allows one, review status, confidence, and extraction method. Theory/mechanism claims and observed-tradition claims are different claim types.

## 2. Source review states

Use the existing fields consistently:
- `curationReviewStatus: catalog-only` — discovery only.
- `metadata-reviewed` — bibliographic/mediation identity checked, but not motif evidence by itself.
- `evidence-reviewed` — contains reviewed source units/evidence claims suitable for the declared evidence role.
- `evidenceRole: catalog-context` — must never support motifs/rules/modes.
- theory roles may support mechanisms, but do not count as independent observed-tradition evidence.

## 3. Motif curation

An active motif should contain/review:
- stable `id` and semantic label;
- `motifeme` describing structural function;
- `structuralRoles`;
- `allomotifs` where function is shared but realization differs;
- `ontologyFacets` / relation graph;
- source IDs for bibliographic provenance;
- `sourceUnitIds` for reviewed occurrence units;
- `evidenceClaimIds` for explicit support;
- curation status: active/candidate/deprecated.

Runtime must exclude `candidate` motifs.

## 4. Transformation rules

Keep three kinds of evidence distinct:
1. theoretical/mechanism support;
2. observed historical/ethnographic examples;
3. setting-specific calibration.

Each rule should preserve preconditions, operations, invariants, directional/context biases, and provenance. Do not infer universal probabilities from one corpus.

## 5. Transmission modes

Keep channel direction, copying biases, memory/noise, exposure thresholds, authority/prestige/conformity/content effects, and media/performance context explicit. Theory sources justify the model family; empirical source claims calibrate or challenge it.

## 6. Release QA targets

Current authoritative targets:
- >=1000 unique source catalog records: already met.
- No catalog-only record used as ontology evidence.
- >=80% active motifs structurally curated.
- >=80% active motifs linked to reviewed source units.
- >=80% active motifs linked to reviewed evidence claims.
- Active motifs normally require >=2 independent bibliographic evidence families.
- Dominant catalog provider <=60% unless owner explicitly accepts another stratified criterion.
- No unresolved high-confidence semantic duplicates.
- All transformation/transmission models retain provenance and deterministic runtime tests.
- Raw copyrighted/restricted/community-sensitive source material is not redistributed in the release artifact without explicit rights/permission basis.

## 7. Anti-patterns

Do not:
- count alternate editions/translations as independent traditions;
- convert catalog titles into motif claims without reading/reviewing the relevant unit;
- assign a tradition from a title alone when uncertain;
- promote candidate motifs to active by lowering support thresholds;
- treat a theoretical model as a universal anthropological law;
- use copyrighted raw text as shipped runtime data merely because metadata is public;
- rewrite canonical world truth from lore/observer claims.

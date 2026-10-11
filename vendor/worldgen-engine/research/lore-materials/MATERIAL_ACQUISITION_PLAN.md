# Lore / Cultural Material Acquisition Plan

## Purpose

External material is research input for a **motif ontology and transformation model**. It is never a table of literal world truths. Runtime lore must remain downstream of generated truth, causal history, observation and interpretation.

## Acquisition layers

### Tier A — Bibliographic/classification references
Use modern or still-copyrighted indexes, handbooks and scholarship as `reference-only` metadata. Store citation metadata, high-level taxonomy links and curator notes; do not copy substantial protected text or proprietary index contents.

Examples: Thompson's *Motif-Index of Folk-Literature*, ATU tale-type scholarship, modern folklore/religious-studies handbooks.

### Tier B — Public-domain primary/early scholarly corpora
Catalog complete public-domain texts where jurisdiction and source permit. Preserve source metadata, translator/editor, collection context, date, source culture/region and mediation/bias notes. Raw texts are curation inputs and are **not loaded by the runtime engine**.

### Tier C — Archives and field collections
Catalog archive/collection metadata. Rights are evaluated per item; default to metadata-only until an item's reuse status is known. Preserve collector, informant/community context when available.

### Tier D — Modern media and cross-domain structural material
Literature, SF/horror, visual art, architecture and music are represented through legal bibliographic metadata and abstract structural observations, not copied protected passages/images/audio.

## Coverage targets for R1 exit

- >=100 catalog source records and >=80% externally catalog-verified before release.
- >=12 cultural/linguistic areas; no single area >20% of source records unless explicitly justified.
- >=250 normalized motifs.
- >=40 transformation rules.
- >=8 transmission/channel modes.
- Each production motif has >=2 independent source supports where possible; exceptions carry `singleSource` caution.
- Every source has rights/ingestion policy; release-quality records also require an externally verified catalog/bibliographic locator.
- Sacred or living-tradition material gets a `culturalSensitivity` note where decontextualization would be misleading.

## Normalization model

A source observation is reduced to portable semantics:

`source witness -> source observation -> candidate motif -> normalized motif -> relations -> transformation affordances`

A motif stores:
- stable ID, family and description;
- semantic tags and applicable domains;
- source IDs and confidence;
- cautions and cultural-context constraints;
- relations to other motifs;
- compatible transformation rule IDs.

Transformations describe **how interpretation changes**, e.g. compression, personification, localization, ritualization, moralization, syncretism, authority transfer, inversion, symbolic substitution, genealogization, sanctification/demonization and spatial anchoring.

## Quality controls

1. Provenance completeness: no production motif without sources.
2. Rights safety: `reference-only` and `metadata-only` sources are never raw-ingested; provisional `public-domain-text` records are skipped by acquisition tooling unless an explicit override is supplied.
3. Cultural concentration report by region/language/tradition.
4. Duplicate/near-duplicate semantic review.
5. Source mediation review: translator, collector, colonial/missionary framing, retrospective synthesis.
6. Truth-separation test: no motif ID may become a world-law entity solely because it exists in the corpus.
7. Determinism test: same world + corpus + seed gives identical lore lineage.
8. Counterfactual test: change observed evidence while holding corpus constant and lore output must respond to evidence rather than merely sampling catalog motifs.

## Runtime boundary

`research/lore-materials/raw/**` is developer research material. Shipping runtime data consists only of curated, compact, rights-safe ontology records in content packs. The engine never treats the research corpus as canonical reality.

## Acquisition tooling policy

`npm run fetch:lore-sources -- --dry-run` produces a no-network acquisition plan. By default the fetcher only attempts records marked `verified-catalog`; `--allow-unverified` exists for curator diagnostics and must not be used for release corpus assembly. Repository/public-domain status is recorded with its stated jurisdiction and does not imply worldwide copyright status.

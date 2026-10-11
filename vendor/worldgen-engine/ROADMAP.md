# World Genesis / World Simulation Engine — Authoritative Roadmap (v6 research expansion)

This roadmap supersedes the former v5 completion statement. The v6 requirement raised the research corpus to at least 1,000 real source-catalog records and required materially deeper source-unit/evidence-claim curation plus advanced motif, transformation and transmission models.

Status legend: `DONE`, `IN PROGRESS`, `PLANNED`.

## R0 — Deterministic kernel and integration contract — DONE

Recipe validation, module registry/pass DAG, seeded named RNG streams, stable IDs, causal provenance, headless library/CLI, persistence/migration/delta/replay diagnostics, generic setting-pack boundary, indexed snapshot builder and streaming stable hash are implemented.

## R1 — Research corpus, motif ontology and epistemic lore — DONE

### R1-A — Source catalog breadth — DONE

Final machine-readable corpus:
- **1,971 unique source records** total.
- **1,843 catalog-only records**.
- **1,280 unique catalog raw labels**.
- **1,451 bibliographic families**.
- **857 verified records**.
- **105 evidence-eligible records** under the strict evidence policy.
- Catalog-only provider counts: Project Gutenberg 1,091; Dúchas 623; PARADISEC 92; World Oral Literature Project 33; Library of Congress AFC 4.
- Dominant catalog provider: Project Gutenberg, **59.2%** of catalog-only records.

The >=1000 real source-catalog requirement is satisfied. Catalog metadata remains discovery context rather than motif evidence.

### R1-B — Source-unit and evidence-claim curation — DONE

Implemented model:
`catalog record -> bibliographic family -> source unit -> evidence claim -> motif/transformation/transmission linkage`

Final audit:
- Source-unit linkage coverage for active motifs: **100% (282/282)**.
- Explicit reviewed evidence-claim linkage coverage for active motifs: **100% (282/282)**.
- Catalog-only records remain excluded from evidence support.
- Evidence claims preserve source/edition/translation/collection context where applicable; finer locator refinement remains optional future research.

### R1-C — Motif ontology — DONE

- **302 motifs** total: **282 active**, **20 candidate**.
- **282/282 active motifs structurally curated** with reviewed motifeme/structural roles/ontology facets and allomotif treatment where relevant.
- Active motifs retain required independent support; `underSupportedActiveMotifIds` is empty.
- The 20 under-supported candidates remain quarantined from runtime selection and may be promoted only after further evidence.
- Semantic duplicate risk is audited.

### R1-D — Transformation model — DONE

- **60 transformation rules**.
- Mechanisms include leveling, sharpening, assimilation, rationalization, omission, allomotif substitution, localization, performance keying, formulaic recomposition, canonical fixation, media remediation, prestige-biased substitution, conformist regularization, content attraction, guided innovation, drift, branching, blending, complex-contagion gating and source-critical differentiation.
- Reviewed evidence-claim linkage: **100% (60/60)**.
- Theory provenance remains separable from observed/empirical provenance.
- Deterministic transformation lineage/precondition/invariant behavior is covered by the automated property/regression suite.

### R1-E — Transmission model — DONE

- **25 transmission modes**.
- Models cover vertical/horizontal/oblique transmission, one-to-many/many-to-one patterns, prestige/conformity/content bias, reconstructive memory, performance/formulaic transmission, rumor chains, institutional canon, written copying, broadcast, syncretic contact, archival revival and complex contagion.
- Reviewed evidence-claim linkage: **100% (25/25)**.
- Declared source provenance: **100% (25/25)**.
- Runtime uses copying bias, memory half-life, noise profile, exposure counts, complex-contagion threshold and transformation operators.
- Theory provenance remains distinct from empirical calibration. Further empirical breadth is a non-blocking research refinement.

### R1-F — Provider/tradition/medium diversification — DONE

Final dominant catalog provider share is **59.2%**, satisfying the <=60% release gate. Multiple source classes remain represented, including digitized books, folklore archives, field/oral collections, ethnography, ritual/religious studies, motif scholarship and transmission theory. Access restrictions and cultural-sensitivity metadata remain explicit.

## R2 — Physical geography substrate — DONE

Arbitrary dimensions/continents, public terrain-strategy registry, plate/geology field, climate/hydrology, runtime geomorphology, spherical seam handling, anisotropic metrics and custom topology registry are implemented.

## R3 — Ecology and resources — DONE

Ecological stocks, guilds, trophic dependencies, succession/range shifts, extinction/reinvasion, alternative chemistry and multi-seed recovery properties are implemented.

## R4 — Population, settlement morphogenesis and demography — DONE

Environment-derived demography, cohorts, migration, settlement lifecycle, household aggregates, terrain-following morphology, historical reconstruction and demography policy plugins are implemented.

## R5 — Economy, institutions, politics and logistics — DONE

Route logistics, production, stock-conservative trade, prices, institutions/polities, belief-aware interfaces and optional market/ownership/debt/contract semantics are implemented.

## R6 — Deep history, archaeology, artifacts and landscape memory — DONE

Deep history, archaeological traces and competing interpretations, artifact biography, infrastructure/polity history and multi-class historical reconstruction are implemented.

## R7 — Agents, households and reversible LOD — DONE

Stable identity, household/agent detail, reversible refine/coarsen, sufficient-statistic commit-back and plugin-defined coarsening are implemented.

## R8 — Information ecology and knowledge networks — DONE

Testimony/records/signals, uncertain cartography, iterative revisions, lossy channels, rumor graphs, censorship/authority regimes and observer knowledge separation are implemented.

## R9 — Generalized world-law/anomaly framework — DONE

Data-defined source/cost/carrier/range/persistence/failure/interactions, custom effect operators, multiple laws, competing hypotheses and fuzz/property tests are implemented.

## R10 — Streaming, persistence, performance and release verification — DONE

Spatial indexing, local snapshots/causal closure, migrations/deltas, content-pack migrations, aggregate-scale simulation and release matrix are implemented and reverified against the final v6 corpus.

Final verification:
- TypeScript check: PASS.
- Build: PASS.
- Current automated regression: **78/78 PASS** using host-safe split execution.
- Current release matrix: **7/7 PASS**.
- Deterministic replay: **`c4e7d183 == c4e7d183`**.

## Final completion gate — SATISFIED

All required conditions are true:
1. R1 source-unit/evidence-claim and structural-curation gates are met at 100%.
2. Provider diversification gate is met at 59.2% <=60%.
3. Current `audit:lore` has valid=true, errors=0, warnings=0.
4. All 78 current automated tests pass on the final corpus/code.
5. Release matrix passes 7/7 on the final corpus/code.
6. Deterministic Descendants integration snapshot/diagnostic were regenerated.
7. Generic `src/**` remains setting-independent and frozen shared-contract integrity remains preserved.

**v6 is complete under this roadmap.**

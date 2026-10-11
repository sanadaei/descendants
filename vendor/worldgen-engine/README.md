# Worldgen Engine 1.5.0 — v6 research expansion complete

Standalone, headless World Genesis / World Simulation engine implementing the frozen `WorldProvider` boundary used by Descendants. Generic engine code remains setting-independent.

> **Current completion status: COMPLETE.** Read `../CONTINUE_HERE.md`, `ROADMAP.md`, and `V6_COMPLETION_REPORT.md` for the current release evidence.

## Core architecture

`WorldRecipe -> deterministic kernel -> geography/geology/climate/hydrology -> ecology/resources -> population/settlements -> history -> economy/institutions/polities -> world laws -> observer knowledge -> lore evolution -> reversible LOD/streaming`

Public extension registries exist for terrain strategies, custom geometry topologies, demography policies, LOD coarsening policies and structured world-law effect operators.

## Current research layer

Final audit: 1,971 sources, 302 motifs, 60 transformations and 25 transmission modes. Active motif structural/source-unit/evidence-claim coverage is 100%. Project Gutenberg catalog concentration is 59.2%, below the <=60% gate. Catalog-only records remain discovery metadata rather than evidence.

## Verification commands

```bash
npm run check
npm run build
npm run audit:lore
npm run test:shard -- 1 3
npm run test:shard -- 2 3
npm run test:shard -- 3 3
npm run verify:matrix:a
npm run verify:matrix:b
npm run verify:matrix:merge
npm run generate:descendants
npm run diagnose:descendants
```

The final recorded verification is 78/78 automated tests, 7/7 release-matrix cases and deterministic replay digest `c4e7d183`.

## Research corpus boundary

Raw research texts are not runtime dependencies and are not shipped by default. Catalog metadata, bibliographic families, reviewed source units and explicit evidence claims are separate layers. `catalog-only` material must not support motifs directly.

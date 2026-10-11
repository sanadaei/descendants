# Content-pack compatibility and migration policy

Content packs are versioned independently from the frozen world contract and engine implementation.

Rules:
- A recipe names the exact content-pack version it expects.
- A registry may satisfy that reference with an older registered pack only when every migration step to the requested version is explicitly registered.
- Migration functions operate on JSON data only. They must be deterministic, side-effect free, and must not inspect runtime world state or unseeded external input.
- There is no implicit semver coercion and no silent best-effort fallback. Missing migration paths are hard errors.
- Migration chains are directed. Downgrades require explicit reverse migrations.
- The registry clones input/output JSON at migration boundaries so a migration cannot mutate the caller's source object.
- After successful validation, the migrated version becomes the canonical registered representation used by generation and lore-corpus assembly.
- Source-rights / ingestion-policy fields must never be relaxed automatically by migration; such changes require an explicit reviewed migration.

Release fixtures must include at least one chained migration test and one missing-path rejection test.

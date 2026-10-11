# Lore material cache

This directory is intentionally source-controlled without bulk source texts.

Run:

```bash
npm run fetch:lore-sources
```

The fetcher reads the active recipe's content-pack bibliography, downloads only entries explicitly marked `public-domain-text`, and writes a SHA-256 manifest next to the cached texts. `reference-only` and `metadata-only` materials are never bulk-downloaded.

The Worldgen runtime does **not** read raw source texts. Raw texts are research inputs used to curate the ontology/content packs. This separation prevents source documents from becoming canonical world truth or runtime dependencies.

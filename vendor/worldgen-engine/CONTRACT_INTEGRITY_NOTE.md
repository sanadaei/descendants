# Contract Integrity Clarification

`shared-contract/CONTRACT_SHA256` is the frozen **WorldProvider TypeScript interface contract hash**, not the hash of `GAME_DESIGN_CONTRACT.md`.

Current values:

- `shared-contract/CONTRACT_SHA256`: `edcadd649b8f3b154af2edb9c50c4489a089c215f58697156c1d0890c961afca`
- SHA-256 of `shared-contract/src/world-contract.ts`: `edcadd649b8f3b154af2edb9c50c4489a089c215f58697156c1d0890c961afca`
- SHA-256 of `worldgen-engine/src/contract.ts`: `edcadd649b8f3b154af2edb9c50c4489a089c215f58697156c1d0890c961afca`
- SHA-256 of `Descendants/src/worldbridge/contract.ts` in the integration package: `edcadd649b8f3b154af2edb9c50c4489a089c215f58697156c1d0890c961afca`
- SHA-256 of `shared-contract/GAME_DESIGN_CONTRACT.md`: `452820ea906cd641876476b285d59414452c73bb7fb12b239a35b9d052807e63`

The different design-document hash is therefore expected and is **not** contract drift. The merge-gate statement “contract hashes match” refers to the frozen executable/provider interface. Shared contract files remain unmodified.

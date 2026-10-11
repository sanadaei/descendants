# Descendants 1.0.0 — Generated-world Implementation Report

## Product authority

Productionはreal Worldgen 1.5.0 + frozen WorldProvider 1.0.0 + `src/sandbox` game loopです。固定authored ADV、Legacy lineage prototype、Content Studioはactive runtime/sourceから削除しました。Legacy ADVから継承したのはF1–F5の画面文法と情報配置原則であり、固定シナリオではありません。

## Playable loop

- Worldgen origin communityからprovider fine individualsをmaterialize
- F1 WORLD / LOCAL navigation
- direct walking / observation / sampling / survey
- F2 body / generated equipment
- F3 personal knowledge / conversation / Archive / sample-gated research
- F4 physical inventory / accessible stock
- F5 viewpoint-bounded Chronicle
- expedition crew / leader / loadout / pace / doctrine preparation
- field camp / communication / rescue / direct WEDO
- settlement labor / medicine / politics / relationships / reproduction
- external societies / trade / diplomacy / direct external fine-person contact
- anomaly utilization / generated endings / post-ending continuation
- save/export/import/provider snapshot resume

## Authority model

Starting identity, stable IDs, identity-anchor provenance, household/institution IDs and explicit initial provider relations are provider authority. Derived profile fields are labeled game interpretation. Births/new social history/records/research/physical inventory are lived game-state. External people are never invented as fake provider identities.

## Epistemic model

Canonical truth is distinct from player-visible knowledge. WORLD/LOCAL queries are observer-bounded, remote Chronicle facts require an in-world report path, direct observation stays personal until Archive, and physical-sample research requires the actual evidence object in the settlement context.

## Automated release gates

The current release gate checks:

- frozen contract hash
- TypeScript
- generated-world unit/integration suite
- real Worldgen merge gates and deterministic integration
- real direct-play soak
- stable IDs/provenance through LOD and save/reload
- version contract
- Electron source syntax
- portable build
- zero Studio/authored-runtime contamination
- static HTTP payload

OS-level visual/native Electron checks remain in `HUMAN_QA_CHECKLIST_1.0.0.md` and must not be reported as automated PASS.

## Final automated verification update — 2026-09-09

After provider-authority cleanup and removal of Studio/fixed authored runtime:

- Main generated-world regression: **146/146 PASS**
- Worldgen regression: **78/78 PASS**
- Worldgen merge gates: **5/5 PASS**
- deterministic 30-day integration: **PASS**
- one-year deterministic stress + save/reload + 7-day continuation: **PASS** (~96.1 s)
- real direct-play soak + save/reload + 30-day continuation: **PASS**
- release matrix: **7/7 PASS**
- lore audit: **0 errors / 0 warnings**
- portable package contamination: **121 files / 0 Studio or fixed-authored-runtime files**
- release-surface audit: **PASS** (`35/37` production-reachable TypeScript; `2` intentional test-only; `51/51` rendered UI actions routed)
- mutation busy-lock and acting-local-command epistemic fallback: **PASS**

Native Electron/Windows visual and endurance QA remain explicitly outside the automated PASS set.


## Keyboard / focus / persistence hardening

- F1-F5 primary navigation now uses explicit tab/tabpanel semantics with F1-F5 plus ArrowLeft/ArrowRight/Home/End keyboard movement.
- Re-rendering preserves the focused generated-world control where that control still exists; controls temporarily disabled by a busy transaction regain focus after the transaction completes.
- Skip-to-main, visible focus outlines, reduced motion, high contrast and persistent text scaling remain part of the release surface.
- Import and Reset are serialized under the same busy transaction gate as world mutations. Reset requires explicit confirmation before persistent deletion.
- Save/import destructive regression rejects invalid schema, provider identity drift, provider snapshot/game-clock tick disagreement, lived-state identities masquerading as provider entities and duplicate agent IDs.
- Primary-view state-machine stress completed 250,000 keyboard transitions without leaving the five legal views; busy-safe actions remain presentation/selection only.

- PASS: startup/persistence recovery hardening — corrupt-save atomic quarantine, IndexedDB/Web Locks multi-tab safety, provider snapshot fallback in volatile mode, provider mismatch protection, and mid-session persistence failure degradation without durable-slot overwrite.

- PASS: revisioned IndexedDB save envelopes reject stale multi-tab Save/Reset, preventing last-writer-wins rollback.

## Transaction/lifecycle safety
Provider-mutating operations are guarded by pre-operation game snapshots. If the provider may have changed before a failure, game state is rolled back and mutations are frozen until provider reconstruction. Save envelopes are checksum-bearing v2 records in atomic IndexedDB transactions, with v1 backward compatibility. Page lifecycle saves never capture an in-flight provider mutation.

### Receipt retention and save-chain stress

Provider command receipt detail is bounded while old terminal command IDs remain non-replayable through a persisted retirement watermark. The release test suite exercises 50,000 terminal commands and 50,000 recovery/resave/restart transitions. Previous-generation promotion is permitted only when revision, commit generation, and parent state hash prove a direct chain.

## Quarantine / forensic recovery hardening

- Corrupt-save quarantine now records source, revision, commit generation, state hash, raw checksum and approximate payload size.
- Quarantine history is bounded to 24 forensic records. The newest evidence retains at most four full raw payloads (subject to a 16 MiB aggregate target); older retained records compact to metadata-only instead of silently disappearing.
- Historical `{capturedAt, reason, raw}` quarantine payloads migrate lazily into the current forensic format.
- F5 footer exposes `Recovery report` for active/previous/quarantine lineage inspection and `Export quarantine` for the newest full captured payload.
- Legacy detailed provider-receipt saves migrate into the 256-detail bounded journal while preserving retired-command replay suppression.

## QA4 multi-day consequence deepening

Assembly vote outcomes write resident social memory and task-specific political preference. Later votes consume that memory at a `0.5` weight, preserving coalition continuity without permanently freezing voters. External `conflictPressure` is connected back into settlement autonomy as additional guard demand (`pressure / 24`) and into F1 situation synthesis, so repeated conflict has a persistent settlement cost while diplomacy can relieve it.


## QA5 resource economy
Medicine/records/scrap physical stock output now soft-saturates; trade terms are bounded to 1.15 approximate lots with diminishing experience benefit. A 30-day daily-trade regression and the complete Relay Tower field/sample/research slice pass after this change.


### QA8 provider-observed conflict evidence
Physical external conflict consequences now require explicit WorldProvider-observed evidence. Explicit local injuries feed traumatic-wound/clinic recovery, explicit displacement removes residents from settlement residence, explicit stock loss deducts only named resources, and explicit route disruption modifies only matching route hazard. Command/intervention records alone remain non-physical. QA8 regression: **146/146 PASS**.


## QA10 route choice
F1 expedition preparation supports direct travel or a known-route waypoint to the same destination. Route-specific provider evidence, detour supply estimates, persisted physical waypoint traversal and same-interval continuation are covered by regression and Visual QA. The strict Relay Tower sample-gated full vertical slice passes through an explicitly selected route.


## QA12 provider-visible route alternatives — 2026-09-10
The current hardening boundary is 165/165 generated-world regressions. `routePlanning.ts` builds only from observer-visible provider topology and independently implements deterministic k-shortest loopless alternatives. Selected routes persist as physical multi-waypoint itineraries, affect field supply estimates, and carry route-specific provider evidence. F1 exposes distance/stretch/overlap without calling an unobserved route safe. A combined multi-day regression simultaneously covers supply, route disruption, explicit individual migration, household displacement/recovery, trauma/recovery and save/reload. Research ledger: 21 validated references. QA12 real-render visual acceptance remains pending because the managed Chromium policy blocks the current harness and no local Electron executable is available.


## QA13 dynamic provider-route invalidation/replanning — 2026-09-10
The current hardening boundary is **172/172** generated-world regressions. Provider-topology route plans persist relation IDs, relation signatures and basis tick; outbound movement validates remaining relations against explicit provider evidence before movement. Missing relations in an observer-bounded projection remain unknown, not deleted. Explicit closure/impassability can replan only from the expedition's actual known graph node over current provider-visible topology; mid-edge invalidation blocks in place. `ExternalConflictObservation.routePassability` is explicit-only and severity never synthesizes it. Research ledger: **25 validated references**. QA13 real-render visual acceptance remains pending because two direct-file Chromium capture attempts did not complete and no local Electron executable is available.

QA13 release-pipeline hardening also removes wall-clock `builtAt` from hashed portable build metadata and makes Worldgen integration compile its own `.test-dist`; two consecutive portable builds produced identical dist content digest `277a23e4f4f385e354475cb745f48ab0601d9099a120cca9d16263110117525f`.


## QA14 blocked-route field decisions — 2026-09-10

QA14 converts the passive provider-route blocked state into explicit `wait/camp`, `retry/replan`, and `return` decisions. Blocked routes do not auto-replan merely because a later projection contains a detour; retry is an explicit action from the unchanged physical position. Wait/camp consumes canonical supplies/time, continues communication accounting, rests the party and records only provider-visible environmental exposure; camp shelter/tools mitigate that game-calibrated burden. Return abandons the blocked provider route as an explicit off-network physical bearing rather than asserting an unseen road. Save validation rejects stale active field decisions. Main regression: **182/182 PASS**; research ledger: **28 references**; portable payload: **123 files / contamination 0**; release audit: **36/38 reachable TS, 54 routed actions, 123 dist files**. Actual-render QA14 remains pending because the current Chromium environment failed even a minimal unrelated `data:` screenshot smoke and local Electron is unavailable.

Two consecutive QA14 portable builds produced identical dist digest `72fc4722215cbeddad487b8f0baf624192034d7e7dca55006614b0d7aaabe82c`. The all-in-one verify command is not claimed PASS in this container: component gates finish independently, while repeated same-exec integration+unit runs stop near ~30 seconds total without OOM or leftover Node processes, consistent with a tool execution resource boundary rather than a demonstrated code-ordering defect.

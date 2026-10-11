# Architecture 1.1.0

## Active product runtime

アプリケーションは `1.1.0` です。Production startup は `src/main.ts` から provider-backed sandbox を起動します。

```text
src/main.ts
  -> src/worldbridge/realWorldProvider.ts
  -> frozen WorldProvider 1.0.0
  -> src/sandbox/*
  -> src/sandbox/app.ts
```

- `src/worldbridge` — frozen contract adapter、real/mock/snapshot provider、provider guard、world-clock bridge
- `src/sandbox` — people、settlement、medicine、knowledge、research、politics、expedition、WEDO、external societies、direct play、persistence
- `src/sandbox/incidentService.ts` — observer-safe Situation projection → feature-gated F1 Incident adapter + I2-B lifecycle + I2-C bounded response allocation + I2-D asynchronous response-operation sidecars
- `src/sandbox/app.ts` — Legacy ADV由来のF1–F5 direct-play grammarをgenerated-world stateへ投影
- `public/worldgen` — production用に同期されたWorldgen runtime / setting pack
- `electron` — `dist/index.html`だけを開く薄いdesktop shell

Production gameplay codeは `worldgen-engine/src/**` をimportしません。Worldgen実装への接続は `WorldProvider` boundaryで閉じています。

## Authority layers

### 1. WorldProvider authority

Worldgenが直接投影するもの:

- entity / relation stable IDs
- identity anchorsとprovenance
- household / institution IDs
- geography / coordinates
- observer-bounded world / local projections
- explicit provider knowledge projection

### 2. Deterministic game interpretation

WorldProviderが直接意味を与えていないage / sex / gameplay role / skills / genetics baseline等は、provider identityから決定論的に解釈します。これらはF2で **GAME INTERPRETATION** と明示し、raw Worldgen factとして扱いません。

### 3. Lived game-state

ゲーム開始後の出生、partner/friendship形成、memories、records、research、equipment状態、physical inventory、expedition history等は **LIVED GAME-STATE** です。新生児に架空のWorldProvider IDを割り当てません。

## Epistemic boundary

Canonical simulation truthとplayer-visible knowledgeを分離します。

- LOCAL/WORLDはobserver付き `queryArea()` projectionを使用
- remote expeditionのlive body/loss stateは通信前にsettlement UIへ出さない
- Chronicleはviewpoint projectionを通す
- personal observationは自動でinstitutional knowledgeにしない
- explicit Archive actionだけがpersonal knowledgeをrecord/institutionへ昇格させる
- field researchは対応physical sampleがsettlement contextに存在する場合のみ進行
- outside individual contactは実際にmaterializeされたprovider fine person IDを使用し、hidden biography/motiveを生成しない

I2-Bの`incidentLedger`も同じ境界に従います。入力はobserver-safe Situation synthesisだけで、hidden provider entityを直接参照しません。ledgerは表示文言を保存せず、visibility喪失をworld-level resolutionへ昇格させません。I2-Cの`incidentDispatch`はそのvisible Incidentに対するoperator-authored allocationだけを保持し、dispatchを成功・解決・hidden causeの証拠として扱いません。I2-Dの`incidentResponseOperations`はdispatch後の経過時間とoperational phaseだけをcanonical timeで進め、work後には同じobserver-safe Incident signalが現在見えるかどうかだけをcategorical observationとして残します。`not-visible`はsuccess/resolutionではありません。response memberの二重投入、bounded capacity、operation/observation identityはsave validatorでもfail closedします。F1 Incident read switchは引き続きdefault OFFです。

## Direct-play time model

歩行、観察、採取、会話、Archive、研究、camp、WEDOはcanonical world timeを消費します。Direct activity中は通常労働や通常遠征移動との二重計上を避けます。

## Content Studio removal

Content StudioはLegacyとしてactive treeから削除されています。

- `public/studio*`: absent
- Studio validator/editor modules: absent
- Authoring Studio release payload: absent
- Studio packaging/backend tools: absent
- production `dist`: Studio/authored runtime 0 filesをgateで検証

固定authored contentはproduction startup authorityではありません。ゲームはWorldgen + lived game-stateで駆動します。

## Persistence

`SandboxGameState` save schemaは `1`。provider snapshotを同梱し、reload時に同じWorldgen historyを再生成せず復元します。stable provider identity provenanceとlived game-stateを別々に検証します。

## I2-E response-resource authority boundary

`incidentResponseResources` is a lived-game-state accounting sidecar attached one-to-one to `incidentResponseOperations`. It does not create a second inventory authority. Reservation moves bounded quantities out of the existing canonical context stock: settlement `food/water/medicine/scrap` or expedition `food/water/medicine/tools`. The reservation record only explains where those held quantities went and how much was consumed/returned.

A new dispatch performs an availability preflight before mutating dispatch state. If any required resource is unavailable, dispatch fails atomically and the team remains `assigned`. During operation progress, only food/water are automatically consumed as operating rations. Medicine/tools are held for availability but automatically returned unless a later explicit gameplay action records an evidence-bearing use. Completion or abort settles the reservation back into the same source. Resource accounting never sets Incident `resolved`, success/failure, hidden cause truth, WorldProvider truth, or Agent labor truth.

Older I2-D saves cannot contain this sidecar. Load migration creates zero-budget `legacy-unfunded` records for their retained operations and does not mutate canonical stock, preventing retroactive resource history from being invented.

## I2-F resolution-authority boundary

Incident lifecycle resolution is an observer-side derived assertion, not WorldProvider truth and not a response-outcome simulator.

The resolver may transition a persisted Incident to `resolved` only after deriving one supported positive predicate from canonical state. It must not infer resolution from:

- the Incident no longer appearing in current Situation synthesis;
- elapsed time;
- team assignment or dispatch;
- operation work/return completion;
- food/water expenditure;
- a `not-visible` post-response observation;
- caller-authored success/failure/cause text.

The persisted positive-evidence record is auditable lifecycle metadata. `supportingOperationIds` merely identify completed operations in the same Incident/context and do not claim causation. Any future outcome/consequence layer must preserve that distinction.



## I2-G evidence-grounded resource-use boundary

`incidentResponseEvidenceUses` is a lived-game-state audit/reconciliation sidecar, not a second inventory system and not an outcome simulator. A use may be created only by an explicit operator call after the current Incident occurrence has been resolved by I2-F positive evidence and only against an already completed supporting response operation with a settled I2-E reservation.

The reconciliation is atomic. It first verifies evidence-kind policy, returned reserve capacity, and current canonical stock; only then does it debit the same source (`settlement.resources.medicine/scrap` or expedition `supplies.medicine/tools`) and reclassify the matching reservation amount from `returned` to `consumed`. Persistence requires the sum of I2-G use records to equal medicine/tool consumption in each reservation.

Evidence kinds are deliberately narrow: medicine is permitted for `recorded-case-cleared` and `field-health-threshold`; tools are permitted for `communication-restored`, `encounter-resolved`, and `research-sample-present`. This permission means only that the observed positive fact is compatible with recording explicit use. It does not establish causal effectiveness. I2-G never mutates health/pathology, hidden causes, WorldProvider truth, Agent tasks, or Incident lifecycle.

## Generations and presentation (1.1.0)

`aging.ts` は習得技能とは独立した年齢能力を供給し、`lifeCourseSimulation.ts` が死亡・物理的な遺品継承を共通処理します。`naming.ts` は命名専用言語 Neral v1、`educationSimulation.ts` は師の作業時間を使う教育、`researchApplications.ts` は対象別の非加算型手順改善を担当します。

`app.ts` の画面描画を `src/sandbox/ui` の画面別モジュールへ分離し、イベント・Provider操作・保存はアプリケーションに残します。資源スカラーはロット台帳の集計射影、Incident資源は元ロットを参照する引当です。移行用Knowledge射影とIncidentのdefault OFFは維持します。

仕様・既存セーブへの影響・改善順序は [GENERATIONS_AND_NAMING.md](GENERATIONS_AND_NAMING.md) を参照してください。

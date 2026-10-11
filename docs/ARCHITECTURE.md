# Architecture 1.2.1

## Active product runtime

アプリケーションは `1.2.1` です。Production startup は `src/main.ts` から provider-backed sandbox を起動します。

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

## Evidence connections (1.1.1)

現地の観察・採取は `KnowledgeEntry.entityObservation` に観測済みの種別・資源キー・座標を保持する。研究分野はこの記録または明示的な旧形式の意味IDから選び、opaqueなWorldProvider IDの部分文字列から推測しない。診療は `treatmentObservation` に症例と処置前後の重症度を記録する。医学研究の実用改善は測定された改善がある場合に限る。診療手順の選択は患者・担当医の知識または集落の制度知だけを参照し、改善を支持、悪化を反証として扱う。同じ記録の複製を加算しない。これは局所的な観測に基づく手順改善であり、因果関係や世界の真実の証明ではない。

研究の作業時間・技能は進捗に作用し、それだけでは確度を増やさない。元の主張の変更・喪失は計画を中止し、参加する知識保持者または物理サンプルが離れれば進行を停止する。成果には根拠の観測情報を引き継ぐ。

`knowledgeSpatial.ts` は操作人物が保持する、または現地で制度知として参照できる地図推定の中心・誤差半径を返す。WORLD表示、遠征準備、移動命令は同じ読取を使う。推定地点にはProviderの正準座標やそこまでの正準topology routeを代入しない。不正な推定値は座標なしで扱い、直接観測した位置で確認できる。WorldGraph selectorとProviderの元オブジェクトは変更しない。

異常医療は集落に同席し、遠征に出ていない生存者の活動中症例だけに作用する。死亡者・遠隔地・外部居住者は患者候補に含めない。


## Exploration and continuity (1.2.0)

`evidenceAccess.ts` は生きた保持者・同席する制度知からの参照を共通化する。`explorationInquiry.ts` は根拠の写し、固定された観測予測・範囲、現地照合、改訂履歴、1Lの実測試行を保持する。予測・各観測報告・試行はそれぞれ既存のKnowledgeEntryに結びつき、ノートだけを共有しても未共有の報告は見えない。0.35kmの現地照合はObserver付きProvider射影と実際の座標から判断し、広域の一部に何も見えないことを全域の反証へ昇格しない。水試行は持ち帰った採取元ロットを分割し、燃料・布を消費して既存の加工を実行する。

`loreArtifacts.ts` は既に保持された伝承・証言の主張を読める文章へ変換する。現物の写しは既存の携行Inventoryで所有・相続し、読解には時間が必要。文章に原典がない物体について日誌や碑文の引用を捏造せず、物的記述と保持済みの解釈を分ける。見えていた近隣関係と座標を次の観測予測へ渡し、Canonical originEvent/biography/catalogを開かない。

`legacyProject.ts` は水管理設備と記録庫の三工程・投入元ロット・実作業・担い手交代を保持する。水管理設備の根拠には水の実測試行から完成した研究が必要。設計記録へ根拠を書き込み、保持者の死亡後も物理記録によって継承する。各計画で担い手一人につき1日1時間の作業を直接行動・教育の残時間から確保し、通常労働から差し引く。資材は着手時に台帳から一度消費し、進捗・設備・履歴は死亡時に消さない。作業中はその時間を使って設計図も維持する。

`legacyProjectBenefits.ts` は設計・根拠の制度知と物理記録が残る場合だけ設備を有効化する。水設備は既存ろ過の微生物・濁度改善に作用し、化学汚染を除去しない。記録庫は既存の物理記録の劣化を半減する。保存検証とReplay digestに新しい任意フィールドを含め、旧Schema 1のセーブは空の状態から導入する。

1.2.1では計画の実作業に通常労働と同じ技能訓練・疲労率を適用し、次の未投入工程の必要量を通常の資材収集へ渡す。直接行動・教育・計画・通常労働の時間を重複させない。記録の最低劣化率は更新ごとの定額ではなく年率として扱う。

`renewLegacyProjectRecord` は同席する著者が読める全根拠を、60分と布0.1を使って新しい現物へ移す。個人の生きた記憶、または有効な現地の物理記録が必要で、制度への所属・遠隔地の記憶・失われた知識だけでは再建できない。工程と投入資材を保持して参照先を更新し、完成後の設備にも同じ条件を適用する。任意の `recordHistory` を保存・検証し、旧1.2.0セーブでは最初の書き直し時に旧現物から履歴を始める。過去の設計図は劣化しても履歴として保持する。

`consumeResourceLots` は投入要求の残量をロットごとに丸めず、永続化する各ロットの残量だけを丸める。小さな採取ロットを多数投入しても、返す投入履歴の合計を要求量に合わせる。

操作・所要作業量・検証範囲は [EXPLORATION_AND_CONTINUITY.md](EXPLORATION_AND_CONTINUITY.md) を参照。

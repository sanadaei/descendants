# DESCENDANTS — SURVIVAL / GENERATIONS

この版は、最初に提供された3資産だけを基礎に、既存システムを**一本の無期限サバイバル／世代ゲーム**として再構成したものです。

## 目的

開始集落で、1日ずつ生活を続けてください。固定された勝利条件・敗北条件・期限・エンディングはありません。Worldgenと既存simulationが作る人口、資源、病気、遠征、外部社会、記録、出生、死亡、世代変化そのものがプレイ内容です。

集落の状態が悪化しても「敗北判定」で停止しません。生存者、遠征隊、記録、外部社会など、残っている状態をそのままsimulationし続けます。

## 最初に見る場所

**F1** が日々の指揮画面です。上部に現在年、経過日、人口、食料・水の残日数、次世代、これまでのマイルストーン、そして **CURRENT DIRECTIVE** が表示されます。

CURRENT DIRECTIVEは現在の世界状態から次の優先事項を自動選択します。原則として、水 → 食料 → 健康 → 可視危機 → 探索 → 記録保存 → 次世代 → 日々の継続、の順で差し迫った問題を優先します。

F1下部には従来の遠征・Incident・WORLD/LOCAL操作がそのまま残っています。F2は身体・装備・医療、F3は知識・Archive・研究、F4は所持品・集落備蓄、F5は年代記です。

## 時間

通常プレイヤーUIから進められる時間は **+1日** だけです。直接遭遇（WEDO）など、既存runtimeが時間送りを禁止している状態ではその制約を迂回しません。

内部engineには複数日をまとめて進める `advanceSandboxDays(n)` 等の戦略的高速進行能力を残しています。これは長期simulation検証・開発・将来機能用であり、通常プレイUIからは呼び出しません。

## 詳細資源・配給

F4では食料・水などをResource Lot単位で確認できます。種類、品質、鮮度、汚染、水質、World Entity由来、加工履歴、custodyを追跡し、住民名簿から保存した配給グループまたは個人へ特定ロット/subtypeを割り当てられます。LOCAL採取物は採取者が携行し、帰還時に集落在庫へ移ります。詳しくは `RESOURCE_PROVENANCE_RATIONING_READ_FIRST.md` を参照してください。

## 推理について

この版では**推理 / Inquiry は使いません**。Pass22は将来研究用の原本provenanceとして `provenance/pass22-original/` に保存していますが、production gameplayからimportされません。

## 原資産とauthority

1. `DESCENDANTS_HUMAN_TEST_ZONE_PDA_PASS5_I2X...` — game runtime baseline / execution runtime origin
2. `DESCENDANTS_V1.0.0_WORLDGEN_1.5_FULL_COMPLETE...` — Worldgen 1.5 source provenance / contract authority
3. `DESCENDANTS_4_INSTANCE_PARALLEL_PROGRESS_PASS22...` — archived research provenance（runtime未接続）

Worldgen関連資産は配布物内に同梱し、外部checkoutなしで起動・検証できるようにします。

## 起動

```bash
npm install
npm run build:portable
npm run preview:portable
```

またはElectron環境がある場合:

```bash
npm run desktop
```


1.2.0では、F3の調査ノートから根拠・観測予測・現地照合・水の実測研究へ進めます。現地の記録物を写して読み、次の調査先を選び、水管理設備・記録庫の作業を次の担い手へ継承できます。操作と長期作業量は `docs/EXPLORATION_AND_CONTINUITY.md` を参照してください。

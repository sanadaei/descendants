# The Descendants of Criminals 1.2.0

**The Descendants of Criminals 1.2.0** は、生成世界の中で集落を維持し、住民を配置し、探索・医療・記録・研究・世代交代を続けるサバイバルゲームです。固定された勝敗・期限・エンディングはありません。

Legacy Content Studio is removed. 製品起動経路は generated-world direct-play game に一本化されています。

## Windowsで起動

1. ZIPを任意のフォルダへ展開します。
2. **`Run_desktop.bat`** をダブルクリックします。
3. 初回だけ必要なデスクトップ実行環境を自動準備します。
4. 毎回、現在のソースから `dist/` を再生成してからゲームを起動します。

`dist/index.html` が削除・欠損していても `Run_desktop.bat` から再生成されます。

必要条件: **Node.js 22.12以降**。Node.js / npm が見つからない場合はランチャーがメッセージを表示して停止します。

## メインループ

F1の指令端末を中心に、次の1日ループを同じゲーム状態上で進めます。

- 朝の状況・生存計器を確認
- 住民の勤務・休養・危機対応・遠征を配置
- `BEGIN OPERATIONS` で24時間を実行
- 翌朝の観測記録と勤務結果を確認
- 要観察員を勤務盤へ戻して再配置
- 食料・水・医療・人口・遠征状態を確認して次の日へ

1.2.0ではF3の調査ノートから予測・現地照合・持ち帰った水の実測・研究を通せます。現場写しの読解から次の調査を選び、水管理設備・記録庫の資材と作業を次の担い手へ継承できます。操作と所要時間は [EXPLORATION_AND_CONTINUITY.md](docs/EXPLORATION_AND_CONTINUITY.md) を参照してください。

1.1.1では観測情報と研究の分類、診療結果と実用手順、地図推定と遠征先の接続を修復しています。異常医療の対象も同席する生存者に限定しています。

1.1.0では年齢別能力・寿命死、Neralによる命名、教育・遺品継承、対象別研究手順を扱います。F1の7日・30日・1年継続は既存の日次計画を反復し、出生・死亡・重大な悪化・手動介入で停止します。

F2 Body / Equipment、F3 Knowledge、F4 Inventory、F5 Chronicle、住民・地図・Systemは同じ `SandboxGameState` とworld clockを共有します。

## 開発用コマンド

```bash
npm ci
npm run verify
npm run build:portable
npm run test:compile
npm run test:unit
npm run desktop
```

`npm run desktop` も `build:portable` を先に実行してからElectronを起動します。

## 配布物の整理

通常プレイと継続開発に必要な本体だけを外側に残しています。過去の監査ログ、旧スクリーンショット、差分、検証レポートなどは **`_development_records_2026-09-17.zip`** にまとめています。必要になった場合だけ展開してください。

主要文書:

- `docs/GENERATIONS_AND_NAMING.md` — 能力カーブ・寿命・Neral命名規則・教育・研究成果
- `docs/IMPLEMENTATION_REPORT_1.1.0.md` — 変更内容と検証結果
- `CHANGELOG.md`
- `docs/ARCHITECTURE.md`
- `docs/VERSIONING.md`
- `docs/IMPLEMENTATION_REPORT_1.0.0.md`
- `docs/HUMAN_QA_CHECKLIST_1.0.0.md`
- `docs/superpowers/specs/2026-09-16-daily-command-center-design.md`
- `docs/superpowers/plans/2026-09-16-daily-command-center-implementation.md`

## Version contract

- application: `1.2.0`
- sandbox save schema: `1`
- WorldProvider contract: `1.0.0`
- Worldgen engine: `1.5.0`
- recipe: `descendants-sandbox-default`

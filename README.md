# The Descendants of Criminals 1.0.0

**The Descendants of Criminals 1.0.0** は、生成世界の中で集落を維持し、住民を配置し、探索・医療・記録・研究・世代交代を続けるサバイバルゲームです。固定された勝敗・期限・エンディングはありません。

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

F2 Body / Equipment、F3 Knowledge、F4 Inventory、F5 Chronicle、住民・地図・Systemは同じ `SandboxGameState` とworld clockを共有します。

## 開発用コマンド

```bash
npm ci
npm run check
npm run build:portable
npm run test:compile
npm run test:unit
npm run desktop
```

`npm run desktop` も `build:portable` を先に実行してからElectronを起動します。

## 配布物の整理

通常プレイと継続開発に必要な本体だけを外側に残しています。過去の監査ログ、旧スクリーンショット、差分、検証レポートなどは **`_development_records_2026-09-17.zip`** にまとめています。必要になった場合だけ展開してください。

主要文書は次の6点だけ外側に残しています。

- `docs/ARCHITECTURE.md`
- `docs/VERSIONING.md`
- `docs/IMPLEMENTATION_REPORT_1.0.0.md`
- `docs/HUMAN_QA_CHECKLIST_1.0.0.md`
- `docs/superpowers/specs/2026-09-16-daily-command-center-design.md`
- `docs/superpowers/plans/2026-09-16-daily-command-center-implementation.md`

## Version contract

- application: `1.0.0`
- sandbox save schema: `1`
- WorldProvider contract: `1.0.0`
- Worldgen engine: `1.5.0`
- recipe: `descendants-sandbox-default`

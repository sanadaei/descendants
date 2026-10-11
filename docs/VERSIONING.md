# バージョニング方針

現在の製品版は **1.2.1** です。

## 1.0.0 以降

- `MAJOR`: save / WorldProvider / player-visible product contractに後方互換性を壊す変更
- `MINOR`: 後方互換性を維持したgenerated-world gameplay機能追加
- `PATCH`: 不具合修正、表示改善、validation強化

## Active version contract

`VERSION_CONTRACT.json` は以下を固定します。

- app version
- sandbox save schema
- frozen WorldProvider contract
- packaged Worldgen engine version
- production recipe ID

Content Studioは削除済みのため、旧 authored-content format、project manifest、Studio generator versionはactive release contractに含めません。

`npm run version:check` は VERSION / package / UI title / WorldProvider declaration / synchronized Worldgen runtime manifestを照合します。

## 更新時の必須作業

1. `VERSION` と `package.json` を同期
2. `CHANGELOG.md` を更新
3. sandbox save形式を変える場合はmigration / validator / testsを同時更新
4. WorldProvider boundary変更はfrozen contract手順を通す
5. Worldgen version変更時はruntime sync、stable ID/provenance、LOD/save-reload integrationを再検証
6. `npm run version:check`、`npm run test:unit`、`npm run test:worldgen-integration`、portable contamination gateを実行

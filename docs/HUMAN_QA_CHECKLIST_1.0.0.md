# 人間QAチェックリスト 1.0.0

対象: The Descendants of Criminals 1.0.0 — generated-world direct play

この文書は、現在のコンテナでは閉じられない**実画面・OS実機QA**だけを残します。simulation / provider / save / epistemic / portable-build gateは自動テスト側で扱います。

## A. 起動 / 基本画面

- 通常起動がreal Worldgen sandboxになり、`?mockWorld=1`なしで開始できる。
- F1 Exploration / F2 Body-Equipment / F3 Knowledge / F4 Inventory / F5 Chronicle をキーボード・マウスで切り替えられる。
- WINDOW 1280×720 / 1440×900 / 1920×1080、Windows DPI 100 / 125 / 150%で主要情報が欠落しない。
- Text 100/125/150%、High Contrast、Reduce Motion、keyboard focus、Skip to main contentを実操作確認する。

## B. Direct-play click-through

- WORLD→LOCAL→対象選択→接近→観察→sample採取を操作できる。
- 同じ場所の人物とのconversation、Record RoomでArchive、physical sampleを使ったresearchを操作できる。
- crew / leader / loadout / pace / doctrineを指定して遠征を開始できる。
- field camp、direct WEDO round、帰還・通信断・rescueをUIから通せる。
- F2/F3の `WORLD PROVIDER / GAME INTERPRETATION / LIVED STATE` 表示が視覚的に区別できる。
- 外部fine individualに接触した際、観測していないbiography/motiveが表示されない。

## C. Save / reload

- Export→Import→reloadで同じworld/provider identityを復元する。
- direct sample / Archive / research / expedition / external-person contactがreload後にも表示される。
- 破損saveが既存正常saveを上書きしないことをUIで確認する。

## D. Production contamination

- `?legacy=1` / `?lineage=1` の旧runtime入口が存在しない。
- Content Studio / fixed authored ADV / Authoring Studioへのリンクや画面が存在しない。
- generated-world game以外の制作UIへ遷移しない。

## E. OS endurance

- Windows 11で2時間以上のgenerated-world playを行い、memory/handleが単調増加し続けない。
- sleep/resume後にsave、UI、sandbox clockが正常である。
- window resize / maximize / minimize / DPI変更後も操作不能にならない。

各不具合には操作手順、save JSON、provider recipe/engine version、replay hash、Windows/Electron版、スクリーンショットを添付します。

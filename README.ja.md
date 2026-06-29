# ai-dev-maintenance

AI開発ツールのローカル状態で増えたディスク使用量を、安全に診断・回収するためのCLIです。

v0.1.xはmacOS専用です。CodexのSQLiteログDBに対するWAL回収を中心に、セッション履歴を触らないことを最優先にしています。

`doctor` は、ローカルに伏せ字済みの診断レポートを書くだけです。`fix --safe --yes` は、Codexログデータを含む可能性がある非公開のローカルバックアップを作成してから、SQLiteのWAL領域を整理します。ログ本文の表示、アップロード、ログ削除、セッション履歴の書き換え、trigger追加、設定変更は行いません。

## 使い方

まずガイド付きで診断:

```bash
npx --yes ai-dev-maintenance@0.1.5
```

通常のターミナルでは対話式に起動します。最初に診断し、cleanupできる状態かを説明し、実行前に必ず確認します。
v0.1.5では、v0.1.4で見つかった過剰なblock条件を修正し、Codex風のprocess名はadvisory扱いに変更しました。さらにreport/backup retentionを追加しています。

安全重視の固定版:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.5 -- doctor --show-paths
```

短いコマンドで起動したい場合:

```bash
npm install -g ai-dev-maintenance@0.1.5
aidm
```

CodexなどのAIコーディングツールを開いたままでも診断はできます。ただし対象DBを開いているprocessがある場合、cleanupは安全のためpausedになります。利用者が自分で対象ツールを閉じてから、waitを選ぶと再確認できます。このツールがCodexを強制終了、kill、restart、変更することはありません。

手動コマンドも使えます。

1. 診断だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.5 -- doctor --show-paths
```

2. 最新レポートを確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.5 -- report --latest
```

3. 出力で安全と表示された場合だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.5 -- fix --safe --yes
```

`npm exec` はCLI起動前にnpm registryからpackageを取得する場合があります。CLI起動後、このツールはネットワーク通信を行いません。

最初はガイド付きコマンドか `doctor` を実行してください。`doctor` は `<home>/.ai-dev-maintenance/reports` に伏せ字済みレポートを書き込みます。レポート確認後に `fix --safe --yes` を実行します。

対象DBを開いているprocessがある状態では、`doctor` は完了しても `fix --safe --yes` はblockedになります。対象ツールを閉じてから、もう一度 `doctor` を実行してください。

## コマンド

```bash
ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive]
ai-dev-maintenance logo [--plain]
ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths]
ai-dev-maintenance reports prune --yes
ai-dev-maintenance backups prune --yes
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive]
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--no-banner]
aidm reports prune --yes
aidm backups prune --yes
```

`aidm logo` はbannerだけを表示する確認用コマンドです。診断、レポート作成、filesystem変更は行いません。TTYでも従来の静的表示にしたい場合は `--no-interactive` を使います。guided modeのままbannerだけ隠す場合は `--no-banner`、ANSI色を消す場合は `--plain` または `NO_COLOR=1` を使います。script用途では `doctor --json` を使ってください。`--show-paths` はhuman outputにだけローカル実パスを表示するため、公開issueやチャットには貼らないでください。

## 安全方針

- `doctor` は原本DBをSQLite接続として開きません。
- `doctor` はツール用データディレクトリに伏せ字済みローカルレポートを書き込みます。
- v0.1.xの `doctor` はprivate log DB bytesを複製しないため、SQLite本文検査をスキップします。
- `fix --safe --yes` はデフォルトのCodex `logs_2.sqlite` とSQLite補助ファイルだけを対象にします。
- Codex風のprocess名だけではblockしません。対象DBを開いているprocessがある場合、またはopen-handle確認ができない場合はblockします。
- SQLite起動には `file:` URI modeを使い、plain database pathを使いません。
- session、Claude data、Codex config、DB rows、schema、triggerは変更しません。
- レポートはデフォルトで伏せ字済みです。

## `fix --safe` が行うこと

できること:

- 検証済みbackupを作る
- Codex log DBのWAL checkpoint/truncateを行う
- WAL bytesのbefore/afterを表示する

やらないこと:

- log削除
- full `VACUUM`
- DBファイル置換
- trigger追加
- session履歴編集
- backup自動復元

retention:

- reportはnewest 50件、30日以内に自動剪定します
- backupはcleanup成功後にnewest 3世代、14日以内に自動剪定します
- 手動剪定は `aidm reports prune --yes` / `aidm backups prune --yes` で実行できます

伏せ字済みレポートには、対象カテゴリ、存在有無、ファイルサイズ、コマンド状態、回収量などの高レベル情報だけを残します。ローカルマシン固有の識別子、コマンドの生出力、絶対パスは保存しません。`--show-paths` はhuman outputだけに影響し、保存済みreportは常に伏せ字済みです。

出力例は `examples/logo.txt`、`examples/doctor-blocked.txt`、`examples/guided-paused.txt`、`examples/guided-ready.txt`、`examples/fix-success.txt` にあります。

## 緊急時 / 上級者向け

バックアップ検証だけを行うコマンドがあります。

```bash
ai-dev-maintenance restore validate --backup <path>
```

これは検証だけです。復旧手順を理解し、AI開発ツールをすべて閉じている場合を除き、DBファイルを移動・コピー・置換しないでください。

## 開発

```bash
corepack pnpm install
corepack pnpm run verify
corepack pnpm run build
```

runtime dependencyとinstall-time package lifecycle scriptはありません。

## ローカルデータ

伏せ字済み診断レポートは `<home>/.ai-dev-maintenance/reports` に保存されます。
このレポートは小さく、Codexのセッション、他AIツールのセッション、バックアップは含みません。

private backupは `<home>/.ai-dev-maintenance/backups` に保存され、Codex log dataを含む可能性があります。古い世代を削除する場合は、復旧上の必要性を確認してから `aidm backups prune --yes` を使ってください。

# ai-dev-maintenance

AI開発ツールのローカル状態で増えたディスク使用量を、安全に診断・回収するためのCLIです。

v1はmacOS専用です。CodexのSQLiteログDBに対するWAL回収を中心に、セッション履歴を触らないことを最優先にしています。

`doctor` は、ローカルに伏せ字済みの診断レポートを書くだけです。`fix --safe --yes` は、Codexログデータを含む可能性がある非公開のローカルバックアップを作成してから、SQLiteのWAL領域を整理します。ログ本文の表示、アップロード、ログ削除、セッション履歴の書き換え、trigger追加、設定変更は行いません。

## 使い方

まず診断だけ実行:

```bash
npx --yes ai-dev-maintenance@0.1.2
```

安全重視の固定版:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.2 -- doctor --show-paths
```

短いコマンドで起動したい場合:

```bash
npm install -g ai-dev-maintenance@0.1.2
aidm
```

1. 診断だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.2 -- doctor --show-paths
```

2. 最新レポートを確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.2 -- report --latest
```

3. 出力で安全と表示された場合だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.1.2 -- fix --safe --yes
```

`npm exec` はCLI起動前にnpm registryからpackageを取得する場合があります。CLI起動後、このツールはネットワーク通信を行いません。

最初は `doctor` だけを実行してください。`doctor` は `<home>/.ai-dev-maintenance/reports` に伏せ字済みレポートを書き込みます。レポート確認後に `fix --safe --yes` を実行します。

CodexなどのAIコーディングツールが開いたままの状態では、`doctor` は完了しても `fix --safe --yes` はblockedになります。対象ツールを閉じてから、もう一度 `doctor` を実行してください。

## コマンド

```bash
ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths]
aidm doctor [--json] [--show-paths] [--no-banner]
```

## 安全方針

- `doctor` は原本DBをSQLite接続として開きません。
- `doctor` はツール用データディレクトリに伏せ字済みローカルレポートを書き込みます。
- v1の `doctor` はprivate log DB bytesを複製しないため、SQLite本文検査をスキップします。
- `fix --safe --yes` はデフォルトのCodex `logs_2.sqlite` とSQLite補助ファイルだけを対象にします。
- Codex processが動いている場合、対象DBを開いているprocessがある場合、open-handle確認ができない場合はblockします。
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

伏せ字済みレポートには、対象カテゴリ、存在有無、ファイルサイズ、コマンド状態、回収量などの高レベル情報だけを残します。ローカルマシン固有の識別子、コマンドの生出力、絶対パスは保存・表示しません。`--show-paths` でも伏せ字済みパスだけを表示します。

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

v1では手動ワイルドカード削除の手順を公開しません。将来cleanupコマンドを追加する場合は、削除前にapp data directoryの安全性を検証し、ツール所有のレポートファイルだけを対象にします。

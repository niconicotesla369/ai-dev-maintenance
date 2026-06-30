# ai-dev-maintenance

AI開発ツールのローカル状態で増えたディスク使用量を、安全に診断するためのCLIです。

v0.2.3では、Codex / Claude Code / Cursor のローカル状態診断、Cursorの安全なcache/log cleanup、さらに現在のCPU/RAM負荷を見るread-only live pressure checkを改善しました。読みやすいprocess名、総合pressure level、合計使用量、比較的安全そうなcache/log、確認が必要な領域、絶対に自動で触らないprivate/danger領域を分けて表示します。

`doctor` は `lstat` / `readdir` によるサイズ計測と、ローカルに伏せ字済み診断レポートを書くだけです。チャット本文の読み取り、アプリDBのオープン、アップロード、ファイル削除、セッション履歴の書き換え、trigger追加、設定変更は行いません。

Cursor cleanup は明示実行だけです。`cursor clean --safe` はdry-run、`cursor clean --safe --yes` はCursorの `Cache`、`CachedData`、`CachedExtensionVSIXs`、`logs` の中身だけを削除します。`state.vscdb`、`state.vscdb.backup`、`workspaceStorage`、設定、認証情報、会話履歴には触りません。

既存のCodex専用 `fix --safe --yes` は残っています。これはCodexログデータを含む可能性がある非公開のローカルバックアップを作成してから、CodexログDBのSQLite WAL領域だけを整理します。

`pressure` はディスクcleanupとは別です。ローカルprocess metadataだけを読み、AI開発関連processのCPU/RAM負荷を表示します。`Codex Renderer`、`node/vitest`、`Chrome Helper`、`syspolicyd` のような読みやすい名前を出し、分かりにくい `other` 行を減らします。processのkill、終了、再起動、suspend、renice、変更は行いません。

## 使い方

まずガイド付きで診断:

```bash
npx --yes ai-dev-maintenance@0.2.3
```

通常のターミナルでは対話式のCodex cleanupフローとして起動します。最初に診断し、cleanupできる状態かを説明し、実行前に必ず確認します。
`doctor` はCodex / Claude Code / Cursorの横断read-onlyレポートです。

安全重視の固定版:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- doctor --show-paths
```

今まさにPCが重い時のCPU/RAM確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- pressure
```

動作が重い原因を今すぐ見たい時は `pressure`、AIツールのローカル状態やディスク肥大を調べたい時は `doctor` を使います。

短いコマンドで起動したい場合:

```bash
npm install -g ai-dev-maintenance@0.2.3
aidm
```

CodexなどのAIコーディングツールを開いたままでも診断はできます。ただし対象DBを開いているprocessがある場合、cleanupは安全のためpausedになります。利用者が自分で対象ツールを閉じてから、waitを選ぶと再確認できます。このツールがCodexを強制終了、kill、restart、変更することはありません。

手動コマンドも使えます。

1. 診断だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- doctor --show-paths
```

2. 最新レポートを確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- report --latest
```

3. 出力で安全と表示された場合だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- fix --safe --yes
```

`npm exec` はCLI起動前にnpm registryからpackageを取得する場合があります。CLI起動後、このツールはネットワーク通信を行いません。

Cursorのcache/log cleanupはCodex WAL cleanupとは別コマンドです。

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- cursor clean --safe
npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.3 -- cursor clean --safe --yes
```

1つ目はdry-runです。2つ目だけが実際に削除します。

最初はガイド付きコマンドか `doctor` を実行してください。`doctor` は `<home>/.ai-dev-maintenance/reports` に伏せ字済みレポートを書き込みます。レポート確認後に `fix --safe --yes` を実行します。

対象DBを開いているprocessがある状態では、`doctor` は完了しても `fix --safe --yes` はblockedになります。対象ツールを閉じてから、もう一度 `doctor` を実行してください。

## コマンド

```bash
ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive]
ai-dev-maintenance logo [--plain]
ai-dev-maintenance doctor [--json] [--show-paths] [--no-banner]
ai-dev-maintenance pressure [--json] [--no-banner]
ai-dev-maintenance cursor clean --safe [--yes]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths]
ai-dev-maintenance reports prune --yes
ai-dev-maintenance backups prune --yes
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive]
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--no-banner]
aidm pressure [--json] [--no-banner]
aidm cursor clean --safe [--yes]
aidm reports prune --yes
aidm backups prune --yes
```

`aidm logo` はbannerだけを表示する確認用コマンドです。診断、レポート作成、filesystem変更は行いません。TTYでも従来の静的表示にしたい場合は `--no-interactive` を使います。guided modeのままbannerだけ隠す場合は `--no-banner`、ANSI色を消す場合は `--plain` または `NO_COLOR=1` を使います。script用途では `doctor --json` を使ってください。`--show-paths` はhuman outputにだけローカル実パスを表示するため、公開issueやチャットには貼らないでください。

## 安全方針

- `doctor` は原本DBをSQLite接続として開きません。
- `doctor` はClaude CodeやCursorのセッション本文を読みません。
- `pressure` はprocess metadataだけを読みます。session本文、log本文、SQLite rows、shell history、environment variables、browser profileは読みません。
- `pressure` はprocessのkill、終了、再起動、suspend、renice、変更を行いません。
- `doctor` はツール用データディレクトリに伏せ字済みローカルレポートを書き込みます。
- `doctor` はClaude Codeの `projects` とCursorの `state.vscdb` をprivate/dangerとして分類し、自動では絶対に触りません。
- `cursor clean --safe` はデフォルトではdry-runです。
- `cursor clean --safe --yes` はCursorの安全なcache/logの中身だけを削除し、対象ディレクトリ自体は残します。
- Cursorの `state.vscdb`、`state.vscdb.backup`、`workspaceStorage` はcleanup対象になりません。
- `doctor` はprivate log DB bytesを複製しないため、SQLite本文検査をスキップします。
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

伏せ字済みレポートには、対象カテゴリ、存在有無、ファイルサイズ、provider分類、コマンド状態、回収量などの高レベル情報だけを残します。ローカルマシン固有の識別子、コマンドの生出力、絶対パスは保存しません。`--show-paths` はhuman outputだけに影響し、保存済みreportは常に伏せ字済みです。

出力例は `examples/logo.txt`、`examples/doctor-aggregate.txt`、`examples/cursor-clean-dry-run.txt`、`examples/guided-paused.txt`、`examples/guided-ready.txt`、`examples/fix-success.txt`、`examples/pressure.txt`、`examples/pressure.json` にあります。

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

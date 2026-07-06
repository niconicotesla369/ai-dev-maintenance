# ai-dev-maintenance

AI開発ツールのローカル状態で増えたディスク使用量を、安全に診断するためのCLIです。

v0.4.1では、Codex / Claude Code / Cursor のローカル状態診断、Cursorの安全なcache/log cleanup、ガイド付き診断とlive pressure checkのターミナル向けpretty output、さらに公開投稿向けのpath-freeな `doctor --share` / `pressure --share` カードを追加しました。machine-readableなJSON契約、ローカル `plan` / `apply`、read-only history、実験的なstdio-only MCP server、`aidm trust` も追加しています。読みやすいprocess名、防御可能なCPU/RAM pressure、合計使用量、比較的安全そうなcache/log、確認が必要な領域、絶対に自動で触らないprivate/danger領域を分けて表示します。

`doctor` は `lstat` / `readdir` によるサイズ計測と、ローカルに伏せ字済み診断レポートを書くだけです。チャット本文の読み取り、アプリDBのオープン、アップロード、ファイル削除、セッション履歴の書き換え、trigger追加、設定変更は行いません。

Cursor cleanup は明示実行だけです。`cursor clean --safe` はdry-run、`cursor clean --safe --yes` はCursorの `Cache`、`CachedData`、`CachedExtensionVSIXs`、`logs` の中身だけを削除します。`state.vscdb`、`state.vscdb.backup`、`workspaceStorage`、設定、認証情報、会話履歴には触りません。

既存のCodex専用 `fix --safe --yes` は残っています。これはCodexログデータを含む可能性がある非公開のローカルバックアップを作成してから、CodexログDBのSQLite WAL領域だけを整理します。

`pressure` はディスクcleanupとは別です。ローカルprocess metadataだけを読み、AI開発関連processのCPU/RAM負荷を表示します。`Codex Renderer`、`node/vitest`、`Chrome Helper`、`syspolicyd` のような読みやすい名前を出し、分かりにくい `other` 行を減らします。JSONとMCPに渡すcommand summaryは実行ファイル名だけに制限し、起動引数、workspace名、UUID風のwindow識別子は転送しません。processのkill、終了、再起動、suspend、renice、変更は行いません。

memory pressure はmacOSの `memory_pressure -Q` を一次ソースにします。`vm_stat` のpage情報は補助情報であり、`memory_pressure -Q` が使えない時に高memory pressureを推測するためには使いません。CPU%はmacOS `ps` と同じ per-core 合算です。`100% = 1つの論理CPUコア` なので、multi-core Macでは合計が100%を超えることがあります。論理CPU数を取得できる場合、pressure severityはcapacity正規化済みCPU%で判定し、raw `ps` 合計値も維持します。

`pressure --json` は `schemaVersion 2` です。このschemaでは、`aiCpuPercent は非AIプロセスを含みません`。非AIのCPU/RAMは `otherCpuPercent` と `otherRssBytes` に分けて出します。

`doctor --share` と `pressure --share` は、公開しやすいcompact cardだけを出します。local path、process名、PID、hostname、username、warning、blocked reason、日付より細かいtimestampは含めません。

人間向けTTY出力では、ターミナル上で安全に使えるANSIカラー、Unicode罫線、meter、compact cardを使います。`--plain`、`--json`、`NO_COLOR=1`、CI、non-TTY、狭い幅ではscript-safeなシンプル行形式に戻ります。`npx` や `npm exec` 経由でスクショを撮ると、起動中のnpm/nodeが一時的にTop CPUへ出ることがあります。きれいに撮るならglobal install後の短いコマンドが向いています。

## 使い方

まずガイド付きで診断:

```bash
npx --yes ai-dev-maintenance@0.4.1
```

通常のターミナルでは対話式のCodex cleanupフローとして起動します。最初に診断し、cleanupできる状態かを説明し、実行前に必ず確認します。
`doctor` はCodex / Claude Code / Cursorの横断read-onlyレポートです。

安全重視の固定版:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.4.1 -- doctor --show-paths
```

今まさにPCが重い時のCPU/RAM確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.4.1 -- pressure
```

動作が重い原因を今すぐ見たい時は `pressure`、AIツールのローカル状態やディスク肥大を調べたい時は `doctor` を使います。

短いコマンドで起動したい場合:

```bash
npm install -g ai-dev-maintenance@0.4.1
aidm
```

CodexなどのAIコーディングツールを開いたままでも診断はできます。ただし対象DBを開いているprocessがある場合、cleanupは安全のためpausedになります。利用者が自分で対象ツールを閉じてから、waitを選ぶと再確認できます。このツールがCodexを強制終了、kill、restart、変更することはありません。

手動コマンドも使えます。

1. 診断だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.4.1 -- doctor --show-paths
```

2. 最新レポートを確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.4.1 -- report --latest
```

3. 出力で安全と表示された場合だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.4.1 -- fix --safe --yes
```

`npm exec` はCLI起動前にnpm registryからpackageを取得する場合があります。CLI起動後、このツールはネットワーク通信を行いません。

Cursorのcache/log cleanupはCodex WAL cleanupとは別コマンドです。

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.4.1 -- cursor clean --safe
npm exec --yes --ignore-scripts ai-dev-maintenance@0.4.1 -- cursor clean --safe --yes
```

1つ目はdry-runです。2つ目だけが実際に削除します。

最初はガイド付きコマンドか `doctor` を実行してください。`doctor` は `<home>/.ai-dev-maintenance/reports` に伏せ字済みレポートを書き込みます。レポート確認後に `fix --safe --yes` を実行します。

対象DBを開いているprocessがある状態では、`doctor` は完了しても `fix --safe --yes` はblockedになります。対象ツールを閉じてから、もう一度 `doctor` を実行してください。

## コマンド

```bash
ai-dev-maintenance [--wait] [--wait-timeout <minutes>] [--no-interactive] [--plain]
ai-dev-maintenance --help | -h
ai-dev-maintenance --version | -v | version
ai-dev-maintenance logo [--plain]
ai-dev-maintenance doctor [--json] [--show-paths] [--share] [--no-banner]
ai-dev-maintenance pressure [--json] [--share] [--no-banner] [--plain]
ai-dev-maintenance history [--json] [--plain]
ai-dev-maintenance trust [--json]
ai-dev-maintenance cursor clean --safe [--yes]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths]
ai-dev-maintenance reports prune --yes
ai-dev-maintenance backups prune --yes
ai-dev-maintenance restore validate --backup <path>
ai-dev-maintenance plan codex-fix|cursor-clean [--json]
ai-dev-maintenance apply --plan <planId> --yes [--json]
ai-dev-maintenance mcp serve
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive] [--plain]
aidm --help | -h
aidm --version | -v | version
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--share] [--no-banner]
aidm pressure [--json] [--share] [--no-banner] [--plain]
aidm history [--json] [--plain]
aidm trust [--json]
aidm cursor clean --safe [--yes]
aidm fix --safe --yes
aidm report --latest [--show-paths]
aidm reports prune --yes
aidm backups prune --yes
aidm restore validate --backup <path>
aidm plan codex-fix|cursor-clean [--json]
aidm apply --plan <planId> --yes [--json]
aidm mcp serve
```

`aidm logo` はbannerだけを表示する確認用コマンドです。診断、レポート作成、filesystem変更は行いません。TTYでも従来の静的表示にしたい場合は `--no-interactive` を使います。guided modeのままbannerだけ隠す場合は `--no-banner`、ANSI色なしのシンプル行形式にする場合は `--plain` または `NO_COLOR=1` を使います。script用途では `doctor --json` または `pressure --json` を使ってください。公開向けのpath-free summary cardが必要な場合は `doctor --share` または `pressure --share` を使います。`--show-paths` はhuman outputにだけローカル実パスを表示するため、公開issueやチャットには貼らないでください。

`plan` と `apply` は、外部harnessが実行前に明示レビューを挟むためのローカル二相プロトコルです。`plan codex-fix` と `plan cursor-clean` は、ツール用データディレクトリにprivateなローカルplanファイルを作るだけです。`apply --plan <planId> --yes` はidentityを再確認してから既存のsafe engineを呼び出します。`fix --safe` やCursor cleanupの安全gateを迂回しません。

実験的なMCP server:

```bash
ai-dev-maintenance mcp serve
```

MCP serverは、ローカルagent harness向けのstdio-only JSON-RPC endpointです。ネットワーク、socket、HTTP serverは開きません。公開するtoolは `aidm_doctor`、`aidm_pressure`、`aidm_report_latest`、`aidm_history`、`aidm_plan` です。`aidm_apply` は公開しません。planの適用は、`aidm apply --plan <planId> --yes` を使う明示的なCLI操作のままです。`aidm_plan` はprivateなローカル `0600` planファイルを作るだけで、cleanupは実行しません。

`aidm trust` はread-onlyのallowlist binary信頼状態チェックです。AIDMが利用するmacOS system commandが、期待されるroot所有、非symlink、group/other writableではないpathに存在するかを表示します。これらのcommand自体は実行しません。
allowlist commandが欠落している、または信頼できない場合、`aidm trust` はexit code `3` を返します。

## Agent / MCP Usage

Claude CodeへAIDMを登録する場合は、stdio commandとして次のように追加できます。

```bash
claude mcp add aidm -- aidm mcp serve
```

MCP surfaceは実験的かつread-onlyです。診断、pressure、最新レポート、history、plan作成だけを提供します。applyやcleanup実行は提供しません。MCP doctor requestはreportを書き込まず、historyにも残りません。保存済みローカルreportが必要な場合はCLIの `doctor` を実行してください。この文脈での承認とは、人間が `aidm apply --plan <planId> --yes` を実行すること、またはharness上で同等のshell commandを明示許可することです。planを実行するには、引き続き人間が見えるCLI手順が必要です。

```bash
aidm apply --plan <planId> --yes
```

MCP requestは直列処理です。重いローカル診断中は、同じsession内の後続応答が遅れる場合があります。これはbeta serverの既知特性であり、background workerやnetwork listenerを増やさないための設計です。

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | コマンド成功。read-only check、`--help`、`--version` を含みます。 |
| `1` | `report --latest` のように要求されたローカルデータがまだ存在しない場合、または unexpected runtime error が発生した場合。 |
| `2` | usage error、unsupported platform、不正なflag、不正なargument。 |
| `3` | safe action が blocked、実行が安全ではない、`trust` が信頼できないallowlist commandを検出した、または確認すべきwarning付きで完了した場合。 |

## 安全方針

- `doctor` は原本DBをSQLite接続として開きません。
- `doctor` はClaude CodeやCursorのセッション本文を読みません。
- `pressure` はprocess metadataだけを読みます。session本文、log本文、SQLite rows、shell history、environment variables、browser profileは読みません。
- `pressure` はprocessのkill、終了、再起動、suspend、renice、変更を行いません。
- `doctor` はツール用データディレクトリに伏せ字済みローカルレポートを書き込みます。
- `doctor --share` と `pressure --share` は、保存レポートやhuman dashboardよりさらに小さいallowlistだけを使い、path、process名、PID、warning、blocked reason、細かいtimestampを含めません。
- `mcp serve` はstdio-onlyで、network listenerを持たず、`aidm_apply` を公開しません。
- `trust` はallowlist command pathをlstat確認するだけで、system commandを実行しません。
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

出力例は `examples/logo.txt`、`examples/doctor-aggregate.txt`、`examples/share-card.txt`、`examples/pressure-share-card.txt`、`examples/cursor-clean-dry-run.txt`、`examples/guided-paused.txt`、`examples/guided-ready.txt`、`examples/fix-success.txt`、`examples/pressure.txt`、`examples/pressure.json` にあります。

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

release workflow:

- `v*` tag pushでGitHub release workflowが実行されます
- pre-release versionはnpm dist-tag `next` でpublishします
- stable versionはnpm dist-tag `latest` でpublishします
- npm provenance publishingを使うには、このrepositoryをnpm Trusted Publishersに設定する必要があります

## ローカルデータ

伏せ字済み診断レポートは `<home>/.ai-dev-maintenance/reports` に保存されます。
このレポートは小さく、Codexのセッション、他AIツールのセッション、バックアップは含みません。

private backupは `<home>/.ai-dev-maintenance/backups` に保存され、Codex log dataを含む可能性があります。古い世代を削除する場合は、復旧上の必要性を確認してから `aidm backups prune --yes` を使ってください。

# ai-dev-maintenance

Codexの追跡対象状態を重複なく網羅し、volume contextも確認しながら、追跡対象bytesとreclaimableなディスク容量を混同せず安全に診断するCLIです。

v0.6.0は、v0.5の追跡対象状態の互換契約を維持したまま、明示的な画像見積もり、条件付きの正確なSparkle cleanup、native-compression status、任意のローカルsession monitorを追加します。machine-readableなJSON契約、ローカル `plan` / `apply`、read-only history、実験的なstdio-only MCP server、`aidm trust` も利用できます。

`doctor` は `lstat` / `readdir` / `statfs` によるファイルサイズ・volume metadataの取得と、ローカルに伏せ字済み診断レポートを書くだけです。チャット本文の読み取り、アプリDBのオープン、アップロード、ファイル削除、セッション履歴の書き換え、trigger追加、設定変更は行いません。

## ローカルVisual Report（一時表示）

CLI限定・read-onlyのVisual Reportは、次のいずれかのコマンドでローカルに開けます。

```bash
aidm doctor --html
aidm report --latest --html
```

AIDMは、Visual Reportをループバックアドレス `127.0.0.1` のみに配信します。外部へのアップロードやリクエストは一切行いません。「Ephemeral HTML」とはメモリ上だけの文書を意味し、後から削除される一時ファイルではありません。HTMLファイルは最初から書き込みません。表示は日本語 / 英語に切り替えられ、選択した言語は `sessionStorage` に保存されて現在のブラウザセッション中だけ有効です。ページを閉じるかセッションの有効期限が切れると、AIDMはメモリ上の表示を破棄し、トークン付きURLも利用できなくなります。

zero-fileという約束はHTMLだけが対象です。元データやツールの状態、通常保存される伏せ字済みJSONレポート、一時的なHTML表示、ブラウザ管理の履歴やキャッシュを分けて考えてください。`doctor --html` は通常どおり診断を行い、既存のretention方針に従って伏せ字済みJSONレポートを作成・保持します。`report --latest --html` は既存の最新の伏せ字済みJSONレポートを読み取り、新たな診断もレポート書き込みも行いません。表示機能自体は元データのcopyを作らず、ツールの状態も変更しません。

表示終了後も、ブラウザの履歴には利用できないトークン付きのループバックURLが残る場合があります。AIDMは `Cache-Control: no-store` を送信しますが、ブラウザ管理の履歴やキャッシュまでは制御できません。ブラウザデータの完全な消去や、APFSでのbyte-for-byte reclaimは保証しません。

Visual Reportでできるのは、固定allowlistに含まれるplanコマンドの表示とcopyだけです。`plan` / `apply` / cleanupを実行できず、MCPにも公開されません。HTML modeは `--json`, `--share`, `--show-paths`, `--plain`, `--no-banner` と互換性がありません。

## v0.6 Guided Codex Reclaim

`doctor はmetadata-onlyのまま`であり、session本文を読みません。`reclaim scan codex-session-images` は別の明示的CLI commandで、見積もりのためだけに `session fileを読みます`。defaultは `--older-than-days 30` と `--min-file-size-mb 50`（binary MiB）で、plan作成・書き換えは行いません。

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- reclaim scan codex-session-images
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- reclaim status codex-native-compression
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- monitor codex-sessions
aidm plan codex-session-image-prune --older-than-days 30 --min-file-size-mb 50
aidm apply --plan <planId> --yes --accept-image-loss
aidm plan codex-sparkle-clean
aidm apply --plan <planId> --yes
aidm plan codex-session-monitor-install --threshold-gib 8 --growth-gib 5
aidm apply --plan <planId> --yes
aidm plan codex-session-monitor-remove
aidm apply --plan <planId> --yes
```

画像pruneは `不可逆かつCLI限定` です。scheduleやMCPからは実行できず、matching private planと両方のconfirmationが必要です。unattended deletionはありません。default `$HOME/.codex` 配下のinactiveなplain `*.jsonl`で、再検証に合格したfileだけを対象にします。custom `CODEX_HOME`（`$HOME/.codex` 以外）と `.jsonl.zst` はunsupportedでblockします。manifest mode `0600` のrecovery manifestは `<home>/.ai-dev-maintenance/manifests/session-image-<planId>.jsonl` に書き込みます。legacy anonymous placeholderは `ファイルだけから監査できません`。そのためAIDMのものとは扱いません。

成功時はlogical `Reclaimed` bytesと、測定できる場合はhuman labelの `Free-space delta` を表示し、JSONは `volumeFreeDeltaBytes` を使います。APFS accountingや同時writeのためfree-space equalityは保証しません。global preflight failureなら変更しません。post-mutation failureは `partial` となりplanを消費します。manifestにはstableなevidenceを残します。universalなcompression ratio（`104x`を含む）は約束しません。

native statusはadvisoryであり、`Codex native-compressionの設定を変更しません`。`config.toml`を読まず、sessionをrecompressせず、`.zst`を展開しません。Sparkle cleanupは `<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle` の `Installation/*` だけを対象にする `正確なCodex Sparkle` cleanupです。`すべての安全確認に合格した場合だけ` 実行し、`Launcher/`、`PersistentDownloads/`、generic updater、native configは変更しません。

monitorは `opt-in` です。手動 `aidm monitor codex-sessions` はmetadata-onlyでpersistしません。明示的plan/apply installはLaunchAgent plistを書き込みbootstrapします。plistは `<home>/Library/LaunchAgents/com.niconicotesla369.ai-dev-maintenance.codex-session-monitor.plist` です。scheduled runがmonitor stateとlatest reportをpersistします。保存先は `<home>/.ai-dev-maintenance/monitor/` の `codex-sessions-state.v1.json` と `codex-sessions-latest.v1.json` で、ローカルstateを書き込みます。default scheduleは毎月1日04:30 local time（`LowPriorityIO=true`、`Nice=10`）、alert defaultは総session state 8 GiBまたは5 GiB growthです。notification deliveryはbest-effortで、failureはwarningでありcleanupを起動しません。validated Node/AIDM pathを移動したらmonitorをreinstallしてください。`MCPはこれらの新しいactionを呼び出せません`。

### 最初の15分：安全な確認順

まずは変更を伴わない範囲から確認します。

```bash
aidm --version
aidm doctor --html
aidm reclaim status codex-native-compression
aidm monitor codex-sessions
```

`doctor --html` はmetadata-onlyの診断を行い、通常の伏せ字済みJSONレポートを保存してから一時表示を開きます。すでに保存済みの診断だけを再表示する場合は `aidm report --latest --html` を使います。どちらのVisual Reportもcleanupを実行しません。

| 目的 | コマンド | session本文 | ローカル書き込み・変更 |
| --- | --- | --- | --- |
| AIツール全体の診断とVisual Report | `aidm doctor --html` | 読まない | 伏せ字済みJSON reportのみ保存。HTML fileは保存しない |
| 最新診断の再表示 | `aidm report --latest --html` | 読まない | 新規reportなし。HTML fileも保存しない |
| Codex画像容量の見積もり | `aidm reclaim scan codex-session-images` | 明示的に読む | plan作成・書き換え・削除なし |
| native compression状態確認 | `aidm reclaim status codex-native-compression` | 読まない | 設定変更・再圧縮なし |
| session総量・増加量の手動確認 | `aidm monitor codex-sessions` | 読まない | stateをpersistしない |
| 正確なCodex Sparkle cacheの回収 | `aidm plan codex-sparkle-clean` → `aidm apply --plan <planId> --yes` | 読まない | 安全確認済みの`Installation/*`だけを削除 |
| 埋め込み画像の不可逆prune | `aidm plan codex-session-image-prune ...` → `aidm apply --plan <planId> --yes --accept-image-loss` | 読む | 対象sessionを再検証後に書き換え、private manifestを保存 |
| 月次monitorの導入・解除 | `aidm plan codex-session-monitor-install` / `remove` → `aidm apply --plan <planId> --yes` | 読まない | LaunchAgentとprivate monitor stateを追加・削除 |

迷った場合は、Visual Reportの`SAFE RECLAIM PLAN`に表示された固定コマンドをコピーし、まず`plan`の内容だけを確認してください。`plan`はcleanupを実行しません。`apply`は対象identityを再検証するため、古いplanや対象が変化したplanはblockedになります。画像pruneだけは不可逆なので、表示される見積もり・対象件数・manifest保存先を確認してから両方のconfirmationを付けてください。

## 追跡対象の状態と互換性

`Tracked state`（追跡対象の状態）は、AIDMが明示的に診断した項目の合計であり、macOSの「System Data」全体ではありません。Codexでは、既知の重複しないバケットとprivateな `other-state` により、`CODEX_HOME` 配下のすべての通常ファイルを重複計上せずに対象にします。sessions、archives、generated images、backups、log database sidecars、unknown root stateは診断しますが、cleanup対象ではありません。

custom `CODEX_HOME` が正確なSparkle rootと重なる場合は、境界安全なpath所有権によってunionを一度だけ表示します。より広いrootが所有し、同じrootならcustomを優先します。custom ownerはprivateなバケットとremainderを維持し、より広いSparkle ownerはreview-firstではなく保守的に `never` として扱います。

重ならない場合、`<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle` にある正確な `org.sparkle-project.Sparkle` のcacheは、確認が必要（review-first）として表示し、自動削除しません。汎用のupdater globはscanもcleanupもしません。`doctor` とautomatic cleanupはCodexのsessionやSparkleを対象にせず、上記v0.6の明示的かつ再検証済みCLI `plan` / `apply` だけが限定的な例外です。

metadata-onlyなファイルサイズscanに加え、`doctor` は `statfs` でmetadata-onlyなvolume contextを取得します。ファイル本文は読みません。scanがtruncatedの場合は下限値として表示するため、bytesは完全な計測値ではなく最小値です。providerのlogical bytesとvolumeのallocated usageは別の計測値なので、tracked-shareの割合は診断用であり、因果関係を示すものではありません。

aggregate JSONは互換性のためschema v2のままで、`totals.totalBytes` も維持します。この表現変更でcleanup scope、cleanup engine、action gateは変わりません。人間向けaggregate出力では、合計使用量ではなく `Tracked state` を表示します。

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
npx --yes ai-dev-maintenance@0.6.0
```

通常のターミナルでは対話式のCodex cleanupフローとして起動します。最初に診断し、cleanupできる状態かを説明し、実行前に必ず確認します。
`doctor` はCodex / Claude Code / Cursorの横断read-onlyレポートです。

安全重視の固定版:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- doctor --show-paths
```

今まさにPCが重い時のCPU/RAM確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- pressure
```

動作が重い原因を今すぐ見たい時は `pressure`、AIツールのローカル状態やディスク肥大を調べたい時は `doctor` を使います。

短いコマンドで起動したい場合:

```bash
npm install -g ai-dev-maintenance@0.6.0
aidm
```

CodexなどのAIコーディングツールを開いたままでも診断はできます。ただし対象DBを開いているprocessがある場合、cleanupは安全のためpausedになります。利用者が自分で対象ツールを閉じてから、waitを選ぶと再確認できます。このツールがCodexを強制終了、kill、restart、変更することはありません。

手動コマンドも使えます。

1. 診断だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- doctor --show-paths
```

2. 最新レポートを確認:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- report --latest
```

3. 出力で安全と表示された場合だけ実行:

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- fix --safe --yes
```

`npm exec` はCLI起動前にnpm registryからpackageを取得する場合があります。CLI起動後、このツールはネットワーク通信を行いません。

Cursorのcache/log cleanupはCodex WAL cleanupとは別コマンドです。

```bash
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- cursor clean --safe
npm exec --yes --ignore-scripts ai-dev-maintenance@0.6.0 -- cursor clean --safe --yes
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
ai-dev-maintenance doctor [--json] [--show-paths] [--share] [--html] [--no-banner]
ai-dev-maintenance pressure [--json] [--share] [--no-banner] [--plain]
ai-dev-maintenance history [--json] [--plain]
ai-dev-maintenance trust [--json]
ai-dev-maintenance reclaim scan codex-session-images [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
ai-dev-maintenance reclaim status codex-native-compression [--json]
ai-dev-maintenance monitor codex-sessions [--json]
ai-dev-maintenance cursor clean --safe [--yes]
ai-dev-maintenance fix --safe --yes
ai-dev-maintenance report --latest [--show-paths] [--json] [--html]
ai-dev-maintenance reports prune --yes
ai-dev-maintenance backups prune --yes
ai-dev-maintenance restore validate --backup <path>
ai-dev-maintenance plan codex-fix|cursor-clean|codex-sparkle-clean [--json]
ai-dev-maintenance plan codex-session-image-prune [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
ai-dev-maintenance plan codex-session-monitor-install [--threshold-gib <GiB>] [--growth-gib <GiB>] [--json]
ai-dev-maintenance plan codex-session-monitor-remove [--json]
ai-dev-maintenance apply --plan <planId> --yes [--accept-image-loss] [--json]
ai-dev-maintenance mcp serve
aidm [--wait] [--wait-timeout <minutes>] [--no-interactive] [--plain]
aidm --help | -h
aidm --version | -v | version
aidm logo [--plain]
aidm doctor [--json] [--show-paths] [--share] [--html] [--no-banner]
aidm pressure [--json] [--share] [--no-banner] [--plain]
aidm history [--json] [--plain]
aidm trust [--json]
aidm reclaim scan codex-session-images [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
aidm reclaim status codex-native-compression [--json]
aidm monitor codex-sessions [--json]
aidm cursor clean --safe [--yes]
aidm fix --safe --yes
aidm report --latest [--show-paths] [--json] [--html]
aidm reports prune --yes
aidm backups prune --yes
aidm restore validate --backup <path>
aidm plan codex-fix|cursor-clean|codex-sparkle-clean [--json]
aidm plan codex-session-image-prune [--older-than-days <days>] [--min-file-size-mb <MiB>] [--json]
aidm plan codex-session-monitor-install [--threshold-gib <GiB>] [--growth-gib <GiB>] [--json]
aidm plan codex-session-monitor-remove [--json]
aidm apply --plan <planId> --yes [--accept-image-loss] [--json]
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

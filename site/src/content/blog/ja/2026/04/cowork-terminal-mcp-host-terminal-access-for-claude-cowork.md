---
title: "cowork-terminal-mcp: 1 つの MCP サーバーで Claude Cowork にホストターミナルアクセスを与える"
description: "cowork-terminal-mcp v0.4.1 は Claude Cowork の隔離された VM とホストの shell を橋渡しします。ツールは 1 つだけ、stdio トランスポート、Windows では Git Bash を絶対パスで固定。"
pubDate: 2026-04-29
tags:
  - "mcp"
  - "claude-cowork"
  - "claude-code"
  - "ai-coding-agents"
lang: "ja"
translationOf: "2026/04/cowork-terminal-mcp-host-terminal-access-for-claude-cowork"
translatedBy: "claude"
translationDate: 2026-04-29
---

[Claude Cowork](https://www.anthropic.com/claude-cowork) は、お使いのマシン上でサンドボックス化された Linux VM の中で動作します。このサンドボックスのおかげで Cowork を放置して動かしておくのも安心ですが、その代わりにエージェントは自力でプロジェクトの依存をインストールしたり、ビルドを実行したり、ホストのリポジトリにコミットを push したりすることができません。橋渡しがなければ、エージェントは VM のファイルシステムの境界で立ち止まってしまいます。[`cowork-terminal-mcp`](https://github.com/marius-bughiu/cowork-terminal-mcp) v0.4.1 はその橋です。ホスト側で動く単機能の [MCP](https://modelcontextprotocol.io/) サーバーで、`execute_command` というツールを 1 つだけ公開し、それ以上のことはしません。全体でおよそ 200 行の TypeScript で、npm では [`cowork-terminal-mcp`](https://www.npmjs.com/package/cowork-terminal-mcp) として配布されています。

## サーバーが公開する唯一のツール

`execute_command` がインターフェース全体です。Zod のスキーマは [`src/tools/execute-command.ts`](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/src/tools/execute-command.ts) にあり、4 つのパラメーターを受け取ります。

| パラメーター | 型                         | デフォルト          | 説明                                                          |
|--------------|----------------------------|---------------------|---------------------------------------------------------------|
| `command`    | `string`                   | 必須                | 実行する bash コマンド                                        |
| `cwd`        | `string`                   | ホームディレクトリ  | 作業ディレクトリ（`cd <path> &&` よりこちらを推奨）           |
| `timeout`    | `number`                   | `30000` ms          | 実行を中止するまでの待ち時間                                  |
| `env`        | `Record<string, string>`   | 継承                | `process.env` に重ねる追加の環境変数                          |

戻り値は `stdout`、`stderr`、`exitCode`、`timedOut` を含む JSON オブジェクトです。出力はストリームごとに 1MB に制限され、上限に達した場合は `[stdout truncated at 1MB]`（または `stderr`）というサフィックスが付きます。

なぜツールが 1 つだけなのでしょうか。それは「ファイル一覧を見せて」「テストを実行して」「git status はどう？」といったあらゆる依頼が、結局はシェルコマンド 1 つに帰着するからです。2 つ目のツールを追加しても、同じ `spawn` の薄いラッパーが増えるだけです。MCP のカタログは小さく保たれ、モデルが間違ったツールを選ぶこともなく、ホスト側の攻撃面も自明に監査可能なまま維持されます。

## Claude Cowork への組み込み

Claude Cowork は **Claude Desktop** の設定から MCP サーバーを読み込み、サンドボックス化された VM へ転送します。設定ファイルは次の 3 つのいずれかにあります。

- **Windows（Microsoft Store 版）：** `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows（標準インストール版）：** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS：** `~/Library/Application Support/Claude/claude_desktop_config.json`

最小構成は次のとおりです。

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "npx",
      "args": ["-y", "cowork-terminal-mcp"]
    }
  }
}
```

Windows では `npx` が正しく解決されるよう、コマンドを `cmd /c` で包んでください（Claude Desktop は PowerShell 互換の仕組みでコマンドを起動するため、npm の shim を常に見つけられるとは限りません）。

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "cowork-terminal-mcp"]
    }
  }
}
```

Claude Code CLI のユーザーにとっては、同じサーバーがホストターミナルへの抜け道としても機能し、1 行で登録できます。

```bash
claude mcp add cowork-terminal -- npx -y cowork-terminal-mcp
```

唯一の前提は bash です。macOS と Linux ではシステムの shell で十分です。Windows では [Git for Windows](https://git-scm.com/download/win) のインストールが必要で、しかもサーバーは「どの `bash.exe` を受け入れるか」について明確な意見を持っています。それが次のおもしろい話につながります。

## Windows における Git Bash の罠

Windows での `spawn("bash")` は無害そうに見えて、ほとんど常に間違っています。Windows の PATH の並び順は `C:\Windows\System32` をかなり前に置きますし、最近の Windows のほとんどには `System32\bash.exe` が存在します。これは WSL のランチャーです。MCP サーバーがこのバイナリにコマンドを渡すと、コマンドは Linux VM の中で実行されます。その Linux VM はホストと同じようには Windows のファイルシステムを見られず、Windows の `PATH` を読み取ることもできず、Windows の `.exe` ファイルを実行することもできません。見える症状はおかしなものになります。.NET SDK が明らかにインストールされていて `PATH` にも入っているのに、`dotnet --version` が「command not found」を返すのです。`node`、`npm`、`git` をはじめ、エージェントが手を伸ばす Windows ネイティブのツールすべてで同じことが起きます。

`cowork-terminal-mcp` はこれを起動時に解決します。`resolveBashPath()` は Windows では PATH の探索を完全にスキップし、Git Bash のインストール場所として固定されたリストをたどります。

```typescript
const candidates = [
  path.join(programFiles, "Git", "bin", "bash.exe"),
  path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
];
```

`existsSync` で確認できた最初の候補が採用され、その絶対パスが `spawn` に渡されます。どれも見つからなければ、サーバーはモジュール読み込み時に例外を投げ、確認したパス一覧と `https://git-scm.com/download/win` への案内を含むエラーメッセージを出します。System32 の bash へのフォールバックも、暗黙の劣化動作もありません。

より一般化した教訓：Windows において、特定のバイナリの挙動が重要な場面で「PATH を信用する」ことは自分の足を撃つようなものです。絶対パスで解決するか、あるいは大きな声で失敗してください。この修正がはっきりと v0.4.1 で入った理由は、`dotnet` が明らかにインストールされているマシンで、エージェントが「`dotnet` がない」と言い張る様子をユーザーが目撃していたからです。

## タイムアウト、出力上限、そして「shell は 1 つ」のルール

実行部分には、もう 3 つ意図的な選択があります。

**shell のタイムアウトではなく AbortController を使う。** コマンドが `timeout` を超過したとき、サーバーは bash の呼び出しを `timeout 30s ...` で包んだりはしません。代わりに `abortController.abort()` を呼び、Node.js がそれをプロセスの終了に翻訳します。子プロセスは `name` が `AbortError` の `error` イベントを発火し、ハンドラーがタイマーをクリアして、ツールは `exitCode: null` と `timedOut: true` で resolve します。

```typescript
const timer = setTimeout(() => {
  abortController.abort();
}, options.timeout);

child.on("error", (error) => {
  clearTimeout(timer);
  if (error.name === "AbortError") {
    resolve({ stdout, stderr, exitCode: null, timedOut: true });
  } else {
    reject(error);
  }
});
```

これにより、タイムアウトの仕組みがユーザーのコマンド文字列の外に出て、Windows と Unix で同じように振る舞います。

**ストリームごとに 1MB の上限が組み込まれている。** `stdout` と `stderr` は JavaScript の文字列として蓄積されますが、`data` イベントごとに `length < MAX_OUTPUT_SIZE`（1,048,576 バイト）の条件が掛かっています。上限に達すると追加のデータは捨てられ、フラグが立ちます。最終的な結果文字列には `[stdout truncated at 1MB]` というサフィックスが付きます。これがストリーミングではなくバッファリングの代償です。モデルは構造化された綺麗な結果を受け取れる一方で、`tail -f some.log` のようなワークロードはこのサーバーが想定するものではありません。一般的な `npm test` や `dotnet build` は余裕で収まります。

**shell は bash 一択。** v0.3.0 には `shell` パラメーターがあり、Windows ではモデルが `cmd` を選べてしまいました。v0.4.0 でこれを削除しました。理由は [CHANGELOG](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/CHANGELOG.md) に書かれています。`cmd.exe` の二重引用符のルールは複数行の文字列を最初の改行で黙って切り捨てるため、モデルが `cmd` 経由で送った heredoc の本体は最初の 1 行に潰れていました。モデルは自分が組み立てた本体でコマンドが動いたと信じ、向こう側の bash はそうではないと言う、というすれ違いです。選択肢を取り除く方が、モデルに「常に bash を選べ」と教え込むより安上がりでした。同じ理由で、ツールの説明（`src/tools/execute-command.ts` 内）はモデルに heredoc の使用を強く促しています。

```
gh pr create --title "My PR" --body "$(cat <<'EOF'
## Summary

- First item
- Second item
EOF
)"
```

JSON の `command` 文字列の中の `\n` は、bash がそれを目にする前に本物の改行へとデコードされ、あとは bash の heredoc のセマンティクスが面倒を見てくれます。

## PTY なし、設計上そう決めた

子プロセスは `stdio: ["ignore", "pipe", "pipe"]` で起動され、擬似ターミナルは持ちません。動いている prompt にアタッチする手段はなく、ターミナル幅の通知もなく、デフォルトでは色のネゴシエーションもありません。ビルドコマンド、パッケージのインストール、git、テストの実行といった用途であれば十分です。モデルは ANSI エスケープに汚されない綺麗な出力を受け取れます。`vim`、`top`、`lldb`、あるいは対話的な TTY を期待するあらゆる REPL に対しては、これは選ぶべきツールではありません。サーバーも TTY のふりをしようとはしません。

このトレードオフは意図されたものです。PTY を備えた MCP サーバーには、ストリーミング、部分出力のためのプロトコル、そして対話的な I/O のセマンティクスが必要になりますが、MCP 自体が現時点ではそれをうまく表現できていません。`cowork-terminal-mcp` は、一発実行のコマンドが本当にプロトコルにフィットする領域にとどまっています。

## どんなときにこの橋が正解か

`cowork-terminal-mcp` は意図的に小さく作られています。ツールは 1 つ、stdio のみ、bash 解決は声を上げて失敗、出力の上限は明示的、shell の選択肢はなし、PTY もなし。Windows で Claude Cowork を動かしていて、本当にホスト上で何かを実行させたいのであれば、これがサンドボックスの境界を痛点でなくするための橋です。すでに Claude Code CLI を使っているなら、いざワークフローがモデル組み込みの `Bash` ツールの外に出る必要が生じた日のために登録しておく、安価な追加機能になります。ソースと issue は [github.com/marius-bughiu/cowork-terminal-mcp](https://github.com/marius-bughiu/cowork-terminal-mcp)、パッケージは npm の [cowork-terminal-mcp](https://www.npmjs.com/package/cowork-terminal-mcp) にあります。

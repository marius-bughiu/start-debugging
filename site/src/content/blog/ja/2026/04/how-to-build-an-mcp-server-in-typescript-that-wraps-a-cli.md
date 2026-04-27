---
title: "TypeScript で CLI をラップするカスタム MCP サーバーを構築する方法"
description: "TypeScript SDK 1.29 を使用して任意のコマンドラインツールを Model Context Protocol サーバーとしてラップするためのステップバイステップガイド。stdout の罠、child_process パターン、エラー伝播、完全に動作する git サーバーをカバーします。"
pubDate: 2026-04-24
tags:
  - "mcp"
  - "ai-agents"
  - "typescript"
  - "claude-code"
lang: "ja"
translationOf: "2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli"
translatedBy: "claude"
translationDate: 2026-04-25
---

AI エージェントにコマンドラインツールへのアクセスを最も速く与える方法は、それを Model Context Protocol (MCP) サーバーとしてラップすることです。エージェントが型付きツールを呼び出し、サーバーが CLI にシェルアウトし、出力をキャプチャして構造化されたレスポンスとして返します -- REST API、SDK バインディング、Webhook は不要です。

このガイドでは、`@modelcontextprotocol/sdk` 1.29.0 と Node 18+ を使用してそのラッパーをゼロから構築します。最後には、`git log` と `git diff` を呼び出し可能なツールとして公開し、stdio トランスポート経由で Claude Desktop に接続された動作する `git-mcp` サーバーが完成します。本番環境で CLI ラッパーを壊すあらゆる落とし穴をカバーします。

## なぜ "CLI をラップする" が正しい最初の一手なのか

ほとんどの社内ツールは CLI としてのみ存在します。デプロイメントスクリプト、データベースマイグレーションランナー、監査ログエクスポーター、画像処理パイプラインなどです。それらには API も gRPC サーフェスもなく、エージェントが直接呼び出せるものはありません。それらを MCP ツールとしてラップするのは 50-100 行の TypeScript で済み、Claude Code、Claude Desktop、Cursor、そして [MCP 仕様 (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26) を話す任意のクライアントを含む、MCP 互換クライアントが使える、検出可能でスキーマ検証されたインターフェースを生み出します。

代替手段 -- システムプロンプトやツール記述の中に CLI 呼び出しを埋め込む -- は脆いです。引数が破壊され、エラーハンドリングが消失し、エージェントはタイムアウトと不正なフラグを区別できません。適切な MCP サーバーはそれらすべてを修正します。

## プロジェクトのセットアップ

Node.js 18 以降が必要です。プロジェクトディレクトリを作成し、依存関係をインストールします。

```bash
mkdir git-mcp
cd git-mcp
npm init -y
npm install @modelcontextprotocol/sdk@1.29.0 zod@3
npm install -D @types/node typescript
```

`package.json` に 2 つのフィールドとビルドスクリプトを追加します。`"type": "module"` フィールドは Node に `.js` ファイルを ES モジュールとして扱うよう指示します。これは SDK が要求するものです。

```json
{
  "type": "module",
  "bin": {
    "git-mcp": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod +x build/index.js"
  },
  "files": ["build"]
}
```

プロジェクトルートに `tsconfig.json` を作成します。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

ソースファイルを作成します。

```bash
mkdir src
touch src/index.ts
```

## すべての MCP stdio サーバーを殺す stdout の罠

ビジネスロジックを 1 行も書く前に、このルールを刻み込んでください。**stdio MCP サーバー内で `console.log()` を呼び出してはいけません**。

サーバーを stdio トランスポートで実行する際、MCP クライアントは JSON-RPC メッセージを使って `stdin`/`stdout` 経由でそれと通信します。JSON-RPC プロトコル外で `stdout` に書き込むバイトはメッセージストリームを破壊します。クライアントは不正な JSON を見て、レスポンスのパースに失敗し、切断します -- 通常は無害そうなデバッグ文の近くを指していない、暗号的な "MCP server disconnected" エラーで。

```typescript
// @modelcontextprotocol/sdk 1.29.0, MCP spec 2025-03-26

// Bad -- corrupts the JSON-RPC stream
console.log("Running git log...");

// Good -- stderr is not part of the stdio transport
console.error("Running git log...");
```

すべての診断行に `console.error()` を使用してください。`stderr` に書き込み、MCP クライアントはそれを無視するか別途表示します。これはエッジケースではありません -- ほぼすべての初めての MCP サーバー作成者がつまずきます。

## CLI ランナー

サブプロセスを起動し、stdout と stderr を収集し、構造化された結果で解決する型付きヘルパーを追加します。`exec` の代わりに `spawn` を使うことで、`exec` が課す 1 MB のデフォルトバッファ上限を回避します。

```typescript
// src/index.ts
// @modelcontextprotocol/sdk 1.29.0, Node 18+

import { spawn } from "child_process";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30_000
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd,
      shell: false, // never pass shell: true with untrusted input
      timeout: timeoutMs,
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}
```

注意すべき点が 2 つあります。

- 引数のいずれかの部分が LLM から来る場合、`shell: false` はオプションではありません。`shell: true` の場合、`--format=%H; rm -rf /` のような引数はシェルインジェクションになります。常に引数を配列として渡し、`spawn` にエスケープを処理させてください。
- タイムアウトは Node の `child_process` の `timeout` オプション経由で伝播し、期限後に `SIGTERM` を送信します。CLI が `SIGTERM` を無視する場合は `SIGKILL` フォールバックを追加してください。

## ツールを登録する

次に、2 つの `git` ツールを配線します。最初の `git_log` はリポジトリの最後の N 個のコミットを返します。2 番目の `git_diff` は未ステージング diff を返します。

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "git-mcp",
  version: "1.0.0",
});

server.registerTool(
  "git_log",
  {
    description:
      "Return the last N commits for a git repository. " +
      "Includes hash, author, date, and subject line.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      count: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Number of commits to return"),
    },
  },
  async ({ repo, count }) => {
    const result = await runCli(
      "git",
      ["log", `--max-count=${count}`, "--pretty=format:%H|%an|%ad|%s", "--date=iso"],
      repo
    );

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git log failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.stdout || "(no commits)" }],
    };
  }
);

server.registerTool(
  "git_diff",
  {
    description:
      "Return the unstaged diff for a git repository, or the diff for a specific file.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      file: z
        .string()
        .optional()
        .describe("Optional relative path to a specific file"),
      staged: z
        .boolean()
        .default(false)
        .describe("If true, show staged (cached) diff instead of unstaged"),
    },
  },
  async ({ repo, file, staged }) => {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);

    const result = await runCli("git", args, repo);

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git diff failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: result.stdout || "(no changes)" },
      ],
    };
  }
);
```

ツールハンドラーで注意すべきいくつかの点。

- `inputSchema` は Zod スキーマを直接使用します。SDK はそれらをクライアントの tool-call 検証のために JSON Schema に変換します。代わりに素の JSON Schema オブジェクトを渡すと、`.default()` と `.optional()` のセマンティクスを失います。
- CLI が非ゼロのコードで終了したときは、コンテンツとともに `isError: true` を返してください。これによりクライアントに、サーバーをクラッシュさせる例外をスローすることなく呼び出しが失敗したことを伝えられます。
- `repo` パラメータは、クライアントが提供しなければならない絶対パスのままにしておいてください。`process.cwd()` から推測しようとしないでください -- サーバーの作業ディレクトリは MCP クライアントが起動した場所であり、それはほぼユーザーのリポジトリではありません。

## トランスポートを接続してサーバーを起動する

`src/index.ts` の末尾にメインエントリポイントを追加します。

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0, stdio transport

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("git-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

ビルドしてコンパイルを確認します。

```bash
npm run build
```

## Claude Desktop に接続する

Claude Desktop の設定を開きます。macOS では `~/Library/Application Support/Claude/claude_desktop_config.json`。Windows では `%AppData%\Claude\claude_desktop_config.json` です。

サーバーを `mcpServers` の下に追加します。

```json
{
  "mcpServers": {
    "git-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/git-mcp/build/index.js"]
    }
  }
}
```

Claude Desktop を再起動します。ツールバーのハンマーアイコンが表示され、`git_log` と `git_diff` が利用可能なツールとして表示されるはずです。Claude に「/Users/me/projects/myrepo の最後の 10 個のコミットを表示して」と尋ねると、`git_log` を直接呼び出します。

Claude Code に接続するには、同じブロックを Claude Code MCP 設定 (`.claude/settings.json` の `mcpServers` の下) に追加するか、ターミナルから `claude mcp add git-mcp -- node /path/to/build/index.js` を実行します。

## 本番環境の CLI ラッパーで気をつけるべき点

**大きな出力の切り詰め。** 一部の CLI は数メガバイトの出力を生成します (大規模なリファクタリングの `git diff`、`ps aux`、SQL 全ダンプ)。MCP 仕様はハードなコンテンツサイズ制限を強制しませんが、クライアントには実用的な制限があります。`runCli` に `maxBytes` ガードを追加し、切り詰め通知を返してください。

```typescript
const MAX_BYTES = 512_000; // 500 KB

// after collecting chunks:
const raw = Buffer.concat(chunks);
const text =
  raw.byteLength > MAX_BYTES
    ? raw.slice(0, MAX_BYTES).toString("utf8") + "\n\n[output truncated]"
    : raw.toString("utf8");
```

**Windows での PATH 検索。** Windows では、`shell: false` を指定した `spawn("git", ...)` は、MCP クライアントが継承する PATH に `git` がない場合に失敗する可能性があります。実行ファイルへのフルパスを使用するか、`cmd.exe /c git ...` ラッパーを起動してください (適切な引数サニタイズと共に)。または、起動時に npm の `which` パッケージを使用して実行ファイルパスを解決し、結果をキャッシュします。

**遅い操作のタイムアウト。** 50 万コミットのリポジトリで `git log` を実行すると数秒かかることがあります。グローバルなデフォルトを使うのではなく、ツールごとに `timeoutMs` を調整してください。ユーザーのリポジトリサイズが予測不可能な場合は、オプションのパラメータとして公開してください。

**stderr からのエラーメッセージ。** 多くの CLI は使用法エラーを終了コード 0 で stderr に書き込みます (既知の悪い習慣)。`exitCode === 0` でも `result.stderr` をチェックし、stdout コンテンツと一緒にツールレスポンスで表面化してください。

**シェルグロブなし。** `shell: false` の場合、引数内の `*.ts` のようなグロブはシェルで展開されません。CLI がグロブ展開を期待する場合、自分でファイルを列挙するか (npm の `glob` を使用)、ツールスキーマで明示的なパスのみを受け入れてください。

## クライアントなしでテストする

`@modelcontextprotocol/inspector` をグローバルにインストールして、完全な MCP クライアントを設定することなくサーバーを対話的にテストします。

```bash
npm install -g @modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector node build/index.js
```

inspector はブラウザ UI を開き、そこでツールをリストし、引数を入力し、それらを直接呼び出せます。生の JSON-RPC メッセージも表示されるので、stdout 破損問題の診断が簡単になります -- ゴミバイトがストリームに着地するのを即座に見ることができます。

## 次に公開すべきもの

2 つのツールは薄いスライスです。同じパターンは、チームが頼っているあらゆる CLI にスケールします。

- コードアーキオロジーエージェントを構築するために `git blame`、`git show`、`git grep` を公開します。
- インフラ対応エージェントのために `aws s3 ls` と `aws cloudformation describe-stacks` をラップします。
- エージェントがクエリを書く前にデータベーススキーマを検査できるよう、`sqlite3 :memory: .schema` または `psql \d tablename` を公開します。
- デプロイ、チケット作成、ログエクスポートのカスタム社内 CLI をラップします -- 「誰も API を必要としなかった」ためにシェルスクリプトの中だけで生きてきたものを。

MCP サーバーは CLI が何をするかを気にしません。必要なのは、よく定義された入力スキーマ (Zod が 3 行で与えてくれる) と、バイナリを実行して出力を返すハンドラーだけです。

チームが TypeScript の代わりに C# を使う場合、同じパターンが [.NET 10 で MCP サーバーを配線する際にカバーした ModelContextProtocol NuGet パッケージ](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) 経由で利用可能です。IDE が MCP を直接バンドルする際の MCP の見え方を広く見るには、[Visual Studio 2022 17.14.30 の中で出荷される Azure MCP Server](/ja/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) は、このプロトコルが目指すスケールの有用な実例です。そして、複数のツールを協調させる自律エージェントを構築していて、生の MCP を超えるフレームワークが必要な場合、[Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) が C# 側をカバーします。IDE レベルのエージェント統合については、[Visual Studio 2026 18.5 の agent skills](/ja/2026/04/visual-studio-2026-copilot-agent-skills/) が、Copilot がリポジトリの `SKILL.md` から skill 定義を自動検出する方法を示しています。

## ソースリンク

- [MCP TypeScript SDK -- modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [Official build-server guide -- modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Inspector -- @modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)

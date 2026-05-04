---
title: "Cursor がコーディングエージェントをライブラリ化する TypeScript SDK をリリース"
description: "新しい @cursor/sdk のパブリックベータが、デスクトップアプリ、CLI、Web を支えるのと同じランタイム、ハーネス、モデルを TypeScript パッケージとして公開します。サンドボックス化されたクラウド VM、サブエージェント、フック、MCP、トークン課金が数行のコードで使えます。"
pubDate: 2026-05-04
tags:
  - "cursor"
  - "ai-agents"
  - "typescript"
  - "mcp"
lang: "ja"
translationOf: "2026/05/cursor-typescript-sdk-programmatic-coding-agents"
translatedBy: "claude"
translationDate: 2026-05-04
---

2026 年 4 月 29 日、Cursor は `@cursor/sdk` のパブリックベータを公開しました。これはデスクトップエディタ、CLI、Web アプリを動かしているのと同じランタイム、ハーネス、モデルをラップした TypeScript ライブラリです。狙いはシンプルで、これまで Cursor の UI の中に隠れていたエージェントが、自分のサービスから呼び出せるプログラマブルなコンポーネントになりました。同じ Composer モデル、同じコンテキストエンジン、同じツール群が、Node プロセスから扱えます。

これは Anthropic や OpenAI の SDK が数年前に通った変化と同じ流れですが、対象が素のチャットモデルではなくコードに特化したエージェントだという点が違います。

## `@cursor/sdk` で何が来るのか

他のパッケージと同じように入れるだけです。

```bash
npm install @cursor/sdk
```

最小の "エージェントを作ってプロンプトを実行する" コードは、[公式ドキュメント](https://cursor.com/docs/sdk/typescript) ではこうなります。

```typescript
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  console.log(event);
}
```

注目すべきフィールドは `local` です。これを渡すと、エージェントは現在の作業ディレクトリのファイルシステムに対して動きます。これを外して `cloud: { ... }` に置き換えると、同じ呼び出しが今度は Cursor が用意してくれるサンドボックス VM の中で実行され、コードベースのインデックス、セマンティック検索、grep がリモート側で行われます。`Agent.create`、`agent.send`、run のストリームの契約は、両者で同一です。

この対称性こそが本命の機能です。結果をローカルに留めたい CI スクリプトはそのままローカルでよく、信頼できないプロンプトを使い捨てクローンに対して走らせたいホスティング型のエージェントは、ハーネスを書き直さずにクラウドランタイムへ移れます。

## サブエージェント、フック、MCP、skills

SDK はワンショットのプロンプトで終わりません。デスクトップアプリが使っているのと同じプリミティブをそのまま公開しています。

- `Run` はストリーミング、待機、キャンセルを提供します。ストリームは `SDKMessage` イベントを emit し、アシスタントのトークン、ツール呼び出し、thinking、ステータス更新が discriminated union として流れてきます。
- サブエージェントを使うと、親 run が自分のコンテキストウィンドウを汚さずに、自己完結したサブタスクを委譲できます。
- フックはツール呼び出しの前後で発火するので、危険なファイル書き込みを拒否したり、すべての shell コマンドをログに残したり、ポリシーに沿ってプロンプトを書き換えたりできます。
- MCP サーバーは `stdio` か `http` で接続するので、既存の MCP 連携（GitHub、Linear、社内データ）はコード変更なしでそのまま挿し込めます。
- `Cursor` 名前空間はアカウントレベルの配管を担当し、モデルの一覧取得、リポジトリの一覧取得、API キーの管理を行います。

エラーは型付きです。`AuthenticationError`、`RateLimitError`、`ConfigurationError` などが揃っており、メッセージ文字列をパースする必要はもうありません。

## .NET の現場にも関係がある理由

SDK は今のところ TypeScript のみですが、クラウドランタイム自体は言語非依存なので、.NET サービスから shell-out する小さな Node サイドカーから起動できます。C# 側の [Microsoft Agent Framework](/ja/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) と組み合わせると、2026 年の現実的なパターンが見えてきます。.NET からオーケストレーションし、コード編集タスクを SDK 経由でホスティング型 Cursor エージェントに流し、結果を MCP で受け取る、という構成です。

課金は標準のトークン消費型で、SDK 利用のための別シートはないので、実験コストはそのままモデルが燃やした分です。注意すべき点はクラウド VM のライフサイクルです。長時間の run は実際の金額として積み上がりますし、SDK はアイドル状態のエージェントを自動で止めてはくれません。

ベータの完全なドキュメントは [cursor.com/docs/sdk/typescript](https://cursor.com/docs/sdk/typescript) にあり、ローンチの記事は [cursor.com/blog/typescript-sdk](https://cursor.com/blog/typescript-sdk) です。

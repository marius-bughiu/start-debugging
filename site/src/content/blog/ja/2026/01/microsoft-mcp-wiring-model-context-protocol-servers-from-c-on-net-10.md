---
title: "Microsoft `mcp`: .NET 10 上の C# から Model Context Protocol サーバーを配線する"
description: "microsoft/mcp を使って、.NET 10 上の C# で Model Context Protocol (MCP) サーバーを配線する方法。ツールの契約、入力バリデーション、認証、可観測性、そして本番運用を支えるパターンを扱います。"
pubDate: 2026-01-10
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "mcp"
  - "ai-agents"
lang: "ja"
translationOf: "2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
今日の GitHub Trending (C#、デイリー) には、Microsoft の Model Context Protocol (MCP) リポジトリである **`microsoft/mcp`** が含まれています。**.NET 10** で社内ツールを構築していて、LLM クライアントと実システム (ファイル、チケット、データベース、CI) のあいだにきれいな境界を持ちたいなら、MCP は注目すべき形です。

ソース: [microsoft/mcp](https://github.com/microsoft/mcp)

## 役立つシフト: ツールがその場しのぎの糊ではなく、契約になる

ほとんどの "AI 統合" は、その場しのぎの糊コードとして始まります。プロンプトのテンプレート、いくつかの HTTP 呼び出し、そして "もう 1 つだけツールを" の積み上がり。信頼性、監査、ローカルでの開発体験が必要になった瞬間、欲しくなるのは契約です。

-   発見可能なツール群、
-   型付きの入力と出力、
-   予測可能なトランスポート、
-   推論できるログ。

それが MCP の狙いです。クライアントとサーバーが独立して進化できるよう、プロトコルの境界を引くことです。

## C# で書く小さな MCP サーバーの形 (実際に実装するもの)

正確な API 表面は、選ぶ C# 用 MCP ライブラリ次第です (そしてまだ初期段階です)。とはいえ、サーバーの形は安定しています。ツールを定義し、入力を検証し、実行し、構造化された出力を返す、というものです。

ここでは "契約ファースト" のアプローチを示す、.NET 10 向け C# 14 スタイルの最小例を載せておきます。ハンドラーの形のテンプレートとして扱ってください。

```cs
using System.Text.Json;

public static class CiTools
{
    public static string GetBuildStatus(JsonElement args)
    {
        if (!args.TryGetProperty("pipeline", out var pipelineProp) || pipelineProp.ValueKind != JsonValueKind.String)
            throw new ArgumentException("Missing required string argument: pipeline");

        var pipeline = pipelineProp.GetString()!;

        // Replace with your real implementation (Azure DevOps, GitHub, Jenkins).
        var status = new
        {
            pipeline,
            state = "green",
            lastRunUtc = DateTimeOffset.UtcNow.AddMinutes(-7),
        };

        return JsonSerializer.Serialize(status);
    }
}
```

重要なのは JSON パースの細部ではありません。重要なのは次の点です。

-   **明示的な入力バリデーション**: MCP では、自分が API を作っていることを忘れがちです。API として扱ってください。
-   **暗黙のアンビエントな状態を持たない**: 依存は引数として渡し、すべてをログに残します。
-   **構造化された結果**: 安定した形を返します。差分が取れない文字列ではなく。

## 実際の .NET 10 コードベースのどこに収まるか

MCP を本番に導入するなら、他のサービスと同じ点を気にすることになります。

-   **認証**: アイデンティティを強制すべきはサーバー側で、クライアント側ではありません。
-   **最小権限**: ツールは可能な限り狭い表面だけを公開すべきです。
-   **可観測性**: リクエスト ID、ツール呼び出しのログ、失敗のメトリクス。
-   **決定性**: ツールは何度呼び出しても安全であり、可能なら冪等であるべきです。

今週ひとつだけやるなら、リポジトリをクローンし、プロトコルのドキュメントにざっと目を通し、いま "プロンプトの糊" として実装しているツールを 5 つ書き出してみてください。たいていの場合、そのリストは MCP の正しい境界を引く理由として十分です。

リソース: [microsoft/mcp](https://github.com/microsoft/mcp)

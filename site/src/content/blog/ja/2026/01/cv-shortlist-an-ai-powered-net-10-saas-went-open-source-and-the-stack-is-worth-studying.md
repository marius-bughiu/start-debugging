---
title: "CV Shortlist: AI を組み込んだ .NET 10 の SaaS がオープンソース化、スタックは学ぶ価値あり"
description: "CV Shortlist は Azure Document Intelligence と OpenAI モデルを組み合わせたオープンソースの .NET 10 SaaS です。スタック、設定の規律、AI 連携の境界は学ぶ価値があります。"
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---
今日ブックマークした C# の投稿は「またのデモアプリ」ではありません。商用プロダクトとして構築され、その後教育的なリファレンスとしてオープンソース化された、しっかりと意見の入った完全な SaaS です: **CV Shortlist**。

ソース: [CV Shortlist repo](https://github.com/mihnea-radulescu/cvshortlist) と元の [r/csharp 投稿](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/)。

## 役に立つのは UI ではなく連携の境界

ほとんどの AI サンプルアプリは「LLM を呼び出す」で止まります。このアプリは、本番機能の成否を分ける本物の境界を文書化しています:

-   **Azure Document Intelligence** が PDF の履歴書から構造化データ (表や複数カラムレイアウトを含む) を抽出します。
-   **OpenAI GPT-5** が抽出データを解析し、求人とマッチングしてショートリストを生成します。

このペアリングは、チームが「文書向けの RAG はどうすればいい？」と聞いてきたとき、脆い OCR パイプラインを一から作らずに済む方法として、私が勧め続けているものです: 専用の抽出サービスを使い、きれいなテキストとフィールド上で推論する。

## 明示的にリストアップされた最新の .NET 10 スタック

README はバージョンとインフラについて気持ちよく具体的です:

-   .NET 10、ASP.NET Core 10、Blazor 10、EF Core 10
-   Azure Web App、SQL Database、Blob Storage、Application Insights
-   Azure Document Intelligence と Azure AI Foundry のモデル (README は `gpt-5-mini` の Foundry モデルを名指しで挙げています)
-   2 つの AI リソースには依然依存する self-hosted 版

採用ドメインに興味がなくても、これは「AI がオモチャ機能でなくなった瞬間に、どれだけ可動部品が出てくるか」の現実的なリファレンスです。

## 設定の規律: ローカルでは user secrets、本番では環境変数

リポジトリは、すべての .NET 10 チームに標準化してほしい 2 つのプラクティスを名指しで挙げています:

-   ローカルデバッグ: シークレットは **user secrets** に保存
-   本番デプロイ: **環境変数** を使う

このようなプロジェクトの `Program.cs` で私が見たいパターンは次のとおりです:

```cs
var builder = WebApplication.CreateBuilder(args);

// Local debugging: dotnet user-secrets
if (builder.Environment.IsDevelopment())
{
    builder.Configuration.AddUserSecrets<Program>(optional: true);
}

builder.Services
    .AddOptions<AiSettings>()
    .Bind(builder.Configuration.GetSection("Ai"))
    .ValidateDataAnnotations()
    .ValidateOnStart();

var app = builder.Build();
app.Run();

public sealed class AiSettings
{
    public required string DocumentIntelligenceEndpoint { get; init; }
    public required string DocumentIntelligenceKey { get; init; }
    public required string FoundryModel { get; init; } // example: gpt-5-mini
}
```

要点はこれらの正確なプロパティ名ではありません。要点はこうです: AI の境界を ASP.NET Core 10 の他の外部依存と同じように扱い、設定と検証を退屈なものにしてください。

## なぜこれが重要か (HR ソフトウェアを作らない人にとっても)

.NET 10 で AI 機能を出荷しようとしているなら、以下を含む動く例が必要です:

-   現実的なレイアウトで壊れない PDF 取り込み
-   複数ステップの処理 (抽出、正規化、推論、永続化)
-   キー、ローテーション、テレメトリ、コスト制御を伴うクラウドリソース

CV Shortlist は「実際に構築するとこんな感じになる」という、コンパクトなリファレンスです。README を読み、`Program.cs` をざっと眺め、自分のドメイン向けに境界設計を盗んでください。

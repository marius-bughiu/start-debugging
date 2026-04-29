---
title: "ModularPipelines V3: CI パイプラインを C# で書き、ローカルでデバッグし、YAML のお守りをやめる"
description: "ModularPipelines V3 を使えば、CI パイプラインを YAML ではなく C# で書けます。dotnet run でローカル実行、コンパイル時の安全性、ブレークポイントでのデバッグが手に入ります。"
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2026/01/modularpipelines-v3-write-ci-pipelines-in-c-debug-locally-stop-babysitting-yaml"
translatedBy: "claude"
translationDate: 2026-04-29
---
今週、CI が盲目的な push-and-pray ループである必要はないという別の知らせを目にしました。**ModularPipelines V3** は活発にリリースされており (最新タグ `v3.0.86` は 2026-01-18 公開)、シンプルな考え方を強く打ち出しています: あなたのパイプラインはただの .NET アプリです。

ソース: [ModularPipelines repo](https://github.com/thomhurst/ModularPipelines) と [v3.0.86 リリース](https://github.com/thomhurst/ModularPipelines/releases/tag/v3.0.86)。

## フィードバックループを変える部分

.NET 10 のサービスを出荷しているなら、パイプラインのステップはすでに「コードらしい形」をしています: ビルド、テスト、公開、パッケージ、スキャン、デプロイ。問題はたいてい外側のラッパーです: YAML、文字列型の変数、そしてタイポを発見するための 5-10 分のフィードバックサイクル。

ModularPipelines はこれをひっくり返します:

-   `dotnet run` でパイプラインをローカル実行できます。
-   依存関係は C# で宣言されるので、エンジンが並列化できます。
-   パイプラインは強く型付けされているので、リファクタリングや間違いは通常のコンパイルエラーのように現れます。

プロジェクトの README からそのまま、貼り付けられる最小例として整えた中核の形は次のとおりです:

```cs
// Program.cs
await PipelineHostBuilder.Create()
    .AddModule<BuildModule>()
    .AddModule<TestModule>()
    .AddModule<PublishModule>()
    .ExecutePipelineAsync();

public class BuildModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Build(new DotNetBuildOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}

[DependsOn<BuildModule>]
public class TestModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Test(new DotNetTestOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}
```

これは最高の意味で退屈です: 普通の C# です。ブレークポイントが効きます。IDE が助けてくれます。「モジュールをリネーム」は怖いグローバル検索ではなくなります。

## エコシステムと一緒に動くツールラッパー

`v3.0.86` リリースは意図的に「小さい」ものです: `pnpm`、`grype`、`vault` のようなツールの CLI オプションを更新します。これは、パイプラインフレームワークに肩代わりしてほしい類のメンテナンスです。CLI がフラグを追加または変更したら、動くべきは型付きラッパーであって、何十もの YAML スニペットが腐っていくことではありません。

## 実プロジェクトでモジュールモデルが好きな理由

大規模なコードベースでは、YAML の隠れたコストは構文ではありません。変更管理です:

-   1 つのメガファイルではなく、関心ごと (build、test、publish、scan) でパイプラインのロジックを分割します。
-   データフローを明示的に保ちます。モジュールは強く型付けされた結果を返し、後続のモジュールがそれを消費できます。
-   アナライザーに依存関係の間違いを早期に捕まえさせます。別のモジュールを呼び出すときに `[DependsOn]` の宣言を忘れることが、ランタイムで初めて分かるサプライズになるべきではありません。

すでに .NET 9 または .NET 10 で生きているなら、パイプラインを小さな C# アプリとして扱うのは「過剰設計」ではありません。それは短いフィードバックループと、本番でのサプライズの少なさです。

もっと深く掘りたい場合は、プロジェクトの「Quick Start」とドキュメントから始めてください: [Full Documentation](https://thomhurst.github.io/ModularPipelines)。

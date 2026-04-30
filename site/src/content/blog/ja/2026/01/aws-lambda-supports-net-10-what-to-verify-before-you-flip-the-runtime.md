---
title: "AWS Lambda が .NET 10 をサポート: ランタイムを切り替える前に検証すべきこと"
description: "AWS Lambda は今や .NET 10 をサポートしますが、ランタイムのアップグレードは難しい部分ではありません。ここにコールドスタート、トリミング、Native AOT、デプロイ形態をカバーする実践的なチェックリストがあります。"
pubDate: 2026-01-08
tags:
  - "aws"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime"
translatedBy: "claude"
translationDate: 2026-04-30
---
**.NET 10** に対する AWS Lambda のサポートは今日コミュニティチャネルに現れ始めており、コールドスタート、トリミング、本番でのネイティブ依存に当たるまでは「完了」に見えるタイプの変更です。

ソースのディスカッション: [r/dotnet thread](https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws_lambda_supports_net_10/)

## ランタイムサポートは簡単な部分; 難しいのはデプロイ形態

Lambda を .NET 8/9 から **.NET 10** に移すのは、ターゲットフレームワークのバンプだけではありません。選ぶランタイムが次を駆動します:

-   **コールドスタートの挙動**: JIT、ReadyToRun、Native AOT、出荷するコード量がすべて起動プロファイルを変えます。
-   **パッケージング**: コンテナイメージ vs ZIP、加えてネイティブライブラリの扱い方。
-   **リフレクション重い系のフレームワーク**: トリミングと AOT は「ローカルで動く」を「実行時に失敗する」に変えることができます。

主にパフォーマンスのために .NET 10 が欲しいなら、Lambda のランタイムアップグレードが勝利だと仮定しないでください。実際のハンドラ、実際の依存関係、実際の環境変数、実際のメモリ設定でコールドスタートを測定してください。

## ベンチマークできる最小の .NET 10 Lambda ハンドラ

ここにベンチマークしやすく、トリミングで壊しやすい小さなハンドラがあります。私の好きなパターンも示しています: ハンドラを小さく保ち、それ以外をすべて DI または明示的なコードパスの背後に押し込めるパターンです。

```cs
using Amazon.Lambda.Core;

[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

public sealed class Function
{
    // Use a static instance to avoid per-invocation allocations.
    private static readonly HttpClient Http = new();

    public async Task<Response> FunctionHandler(Request request, ILambdaContext context)
    {
        // Touch something typical: logging + a small outbound call.
        context.Logger.LogLine($"RequestId={context.AwsRequestId} Name={request.Name}");

        var status = await Http.GetStringAsync("https://example.com/health");
        return new Response($"Hello {request.Name}. Upstream says: {status.Length} chars");
    }
}

public sealed record Request(string Name);
public sealed record Response(string Message);
```

今度は意図された本番パスに合った方法で publish します。トリミングをテストしているなら、明示的にしてください:

```bash
dotnet publish -c Release -f net10.0 -p:PublishTrimmed=true
```

.NET 10 で Native AOT にさらに踏み込む予定なら、その方法でも publish して、依存関係が実際に AOT 互換であることを検証してください (シリアライゼーション、リフレクション、ネイティブライブラリ)。

## 最初の .NET 10 ロールアウトのための実践的チェックリスト

-   **コールドスタートと定常状態を別々に測定する**: 両方の p50 と p99。
-   **テストできるときだけトリミングをオンにする**: トリミングの失敗はたいてい実行時の失敗です。
-   **Lambda のメモリ設定を確認する**: CPU 割り当てが変わり、結果がひっくり返ることがあります。
-   **TFM に敏感な依存関係を固定する**: `Amazon.Lambda.*`、シリアライザー、リフレクションを使うあらゆるもの。

安全な最初の一歩が欲しいなら、ランタイムを **.NET 10** にアップグレードし、デプロイ戦略はそのままに保ってください。安定したら、ブランチでトリミングや AOT を実験し、モニタリングが退屈だと言うときだけ出荷してください。

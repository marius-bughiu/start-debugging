---
title: ".NET 11 AWS Lambda のコールドスタート時間を縮める方法"
description: ".NET 11 Lambda のコールドスタートを縮める実用的でバージョン特化のプレイブック。provided.al2023 上の Native AOT、ReadyToRun、マネージド dotnet10 ランタイムでの SnapStart、メモリ調整、静的フィールドの再利用、トリム安全性、そして INIT_DURATION の正しい読み方を扱います。"
pubDate: 2026-04-27
template: how-to
tags:
  - "aws"
  - "aws-lambda"
  - "dotnet-11"
  - "native-aot"
  - "performance"
lang: "ja"
translationOf: "2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda"
translatedBy: "claude"
translationDate: 2026-04-29
---

典型的な .NET Lambda は、デフォルトの `dotnet new lambda.EmptyFunction` の 1500-2500 ms のコールドスタートから、4 つのレバーを積み重ねることで 300 ms 未満まで下がります: 適切なランタイムを選ぶ(`provided.al2023` 上の Native AOT またはマネージドランタイムの SnapStart)、init を完全な vCPU で動かせるだけのメモリをファンクションに与える、再利用可能なものはすべて静的初期化に持ち上げる、必要のないコードのロードをやめる。本ガイドは .NET 11 Lambda(`Amazon.Lambda.RuntimeSupport` 1.13.x、`Amazon.Lambda.AspNetCoreServer.Hosting` 1.7.x、.NET 11 SDK、C# 14)で各レバーを順に歩み、適用順を説明し、CloudWatch の `INIT_DURATION` 行から各ステップを検証する方法を示します。

## 既定の .NET Lambda がコールドスタートで遅い理由

Lambda 上のマネージドランタイムでのコールドスタートは 4 つを連続して実行し、既定の .NET ファンクションはそのすべてに対して支払います。第一に、**Firecracker microVM** が起動し、Lambda がデプロイパッケージを取得します。第二に、**ランタイムが初期化**されます: マネージドランタイムでは、CoreCLR がロードし、host JIT が温まり、ファンクションのアセンブリがメモリにマップされる、ということです。第三に、**handler クラスが構築**され、コンストラクタインジェクション、設定の読み込み、AWS SDK クライアントの構築が含まれます。これらすべての後にようやく、Lambda は最初の呼び出しで `FunctionHandler` を呼びます。

.NET 固有のコストはステップ 2 と 3 に現れます。CoreCLR は最初の呼び出しで各メソッドを JIT コンパイルします。ASP.NET Core(API Gateway hosting bridge を使う場合)は logging、configuration、option-binding パイプラインを含むフルホストを構築します。既定の AWS SDK クライアントは認証情報を遅延解決し、credential provider chain を歩きます。Lambda では速いものの、それでもアロケーションは発生します。`System.Text.Json` の既定パスのようなリフレクション重めのシリアライザは、初めて見る各型のすべてのプロパティを検査します。

4 つのレバーを、以下の順で、収益逓減のトレードオフ付きで引けます:

1. **Native AOT** はプリコンパイル済みバイナリを出荷するので JIT コストはゼロになり、ランタイムは小さな自己完結実行ファイルを起動します。
2. **SnapStart** は既に温まった init フェーズのスナップショットを取り、コールドスタートでディスクから復元します。
3. **メモリサイズ** は CPU を比例して買い、init 内のすべてを高速化します。
4. **静的再利用とトリミング** は init 中に動くものとコールドスタートごとにやり直されるものを縮めます。

## レバー 1: provided.al2023 の Native AOT(単一の最大の勝利)

Native AOT はファンクションと .NET ランタイムを単一の静的バイナリにコンパイルし、JIT を排除し、コールドスタートを Lambda がプロセスを立ち上げる時間程度にまで縮めます。AWS は `provided.al2023` カスタムランタイムでこのための[第一級ガイダンス](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html)を公開しています。.NET 11 ではツールチェーンは .NET 8 で出荷されたものに一致しますが、トリムアナライザはより厳しく、.NET 8 で緑色だった `ILLink` の警告が点灯することがあります。

最小の AOT 対応ファンクションはこんな感じです:

```csharp
// .NET 11, C# 14
// PackageReference: Amazon.Lambda.RuntimeSupport 1.13.0
// PackageReference: Amazon.Lambda.Serialization.SystemTextJson 2.4.4
using System.Text.Json.Serialization;
using Amazon.Lambda.Core;
using Amazon.Lambda.RuntimeSupport;
using Amazon.Lambda.Serialization.SystemTextJson;

var serializer = new SourceGeneratorLambdaJsonSerializer<LambdaFunctionJsonContext>();

var handler = static (Request req, ILambdaContext ctx) =>
    new Response($"hello {req.Name}", DateTimeOffset.UtcNow);

await LambdaBootstrapBuilder.Create(handler, serializer)
    .Build()
    .RunAsync();

public record Request(string Name);
public record Response(string Message, DateTimeOffset At);

[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Response))]
public partial class LambdaFunctionJsonContext : JsonSerializerContext;
```

重要な `csproj` のスイッチ:

```xml
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <PublishAot>true</PublishAot>
  <StripSymbols>true</StripSymbols>
  <InvariantGlobalization>true</InvariantGlobalization>
  <RootNamespace>MyFunction</RootNamespace>
  <AssemblyName>bootstrap</AssemblyName>
  <TieredCompilation>false</TieredCompilation>
</PropertyGroup>
```

`AssemblyName` を `bootstrap` にするのはカスタムランタイムが要求します。`InvariantGlobalization=true` は ICU を取り除き、パッケージサイズを節約し、コールドスタート時の悪名高い ICU 初期化を避けます。実際のカルチャデータが必要なら、`<PredefinedCulturesOnly>false</PredefinedCulturesOnly>` に切り替えてサイズ増を受け入れてください。

リンカが Lambda 環境と一致するよう Amazon Linux(または Linux コンテナ)でビルドします:

```bash
# .NET 11 SDK
dotnet lambda package --configuration Release \
  --framework net11.0 \
  --msbuild-parameters "--self-contained true -r linux-x64 -p:PublishAot=true"
```

`Amazon.Lambda.Tools` グローバルツールが `bootstrap` バイナリを ZIP にまとめ、それをカスタムランタイムとしてアップロードします。256 MB のファンクションと上記のボイラープレートで、コールドスタートはおおよそ **150 ms から 300 ms** の範囲、マネージドランタイムの 1500-2000 ms から下がるでしょう。

トレードオフ: 引っ張ってくるリフレクション重めのライブラリはトリム警告になります。`System.Text.Json` のソースジェネレーターがシリアライゼーションを扱いますが、ランタイムでジェネリクス型に対してリフレクションするもの(古い AutoMapper、Newtonsoft、リフレクションベースの MediatR ハンドラ)を使うと、ILLink 警告かランタイム例外が出ます。すべての警告を本物のバグとして扱ってください。トリム互換のメディエータの代替は、[SwitchMediator v3、AOT に優しいゼロアロケーションメディエータ](/2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot/) で扱っています。

## レバー 2: マネージド dotnet10 ランタイムの SnapStart

コードが AOT に向かない場合(リフレクション重め、動的プラグイン、ランタイムでのモデル構築を行う EF Core 11)、Native AOT は実用的ではありません。次善の策は **Lambda SnapStart** で、現時点で**マネージド `dotnet10` ランタイム**で対応しています。2026 年 4 月時点でマネージド `dotnet11` ランタイムはまだ GA ではないので、.NET 11 コードの実用的な「マネージド」ターゲットは、`net10.0` をマルチターゲットして SnapStart 対応の `dotnet10` ランタイムで動かすか、上で説明したカスタムランタイムを使うことです。AWS は 2025 年後半に .NET 10 ランタイムを発表し([AWS ブログ: AWS Lambda で .NET 10 ランタイム提供開始](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/))、マネージド .NET ランタイムでの SnapStart サポートは [Lambda SnapStart で起動性能を改善する](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) に文書化されています。

SnapStart は init 後にファンクションをフリーズし、Firecracker microVM のスナップショットを取り、コールドスタートで init を再実行する代わりにスナップショットを復元します。.NET では init が高価な部分なので、典型的にコールドスタートを 60-90% 削減します。

SnapStart の正しさには 2 つが重要です:

1. **復元後の決定論性。** init 中に取り込まれたもの(ランダムシード、マシン固有のトークン、ネットワークソケット、時刻由来のキャッシュ)は復元される各インスタンス間で共有されます。AWS が提供するランタイムフックを使ってください:

```csharp
// .NET 10 target multi-targeted with .NET 11
using Amazon.Lambda.RuntimeSupport;

Core.SnapshotRestore.RegisterBeforeSnapshot(() =>
{
    // flush anything that should not be captured
    return ValueTask.CompletedTask;
});

Core.SnapshotRestore.RegisterAfterRestore(() =>
{
    // re-seed RNG, refresh credentials, reopen sockets
    return ValueTask.CompletedTask;
});
```

2. **熱くしておきたいものを Pre-JIT する。** SnapStart は JIT 済み状態を捕えます。Tiered Compilation は init 中に hot メソッドを tier-1 に昇格させ終えていないので、押し込まないと多くは tier-0 のスナップショットになります。init 中にホットパスを一度歩いて(synthetic warm-up payload で handler を呼び、または key methods を明示的に invoke する)、JIT 済みの形をスナップショットに含めましょう。`<TieredPGO>true</TieredPGO>`(.NET 11 の既定)があると影響は少し小さくなりますが、それでも測定可能に役立ちます。

SnapStart は今日マネージド .NET ランタイムで無料ですが、スナップショット作成がデプロイに少し遅延を加えます。

## レバー 3: メモリサイズが CPU を買う

Lambda はメモリに比例して CPU を割り当てます。128 MB では vCPU の一部、1769 MB ではフル vCPU 1 つ、それ以上ではそれ以上が得られます。**init は同じ比例 CPU で動く**ので、256 MB に設定されたファンクションは、同じコードでも 1769 MB のときよりずっと遅い JIT と DI のコストを払います。

小さな ASP.NET Core minimal API Lambda の具体的な数値:

| メモリ  | INIT_DURATION (managed dotnet10) | INIT_DURATION (Native AOT) |
| ------- | -------------------------------- | -------------------------- |
| 256 MB  | ~1800 ms                         | ~280 ms                    |
| 512 MB  | ~1100 ms                         | ~200 ms                    |
| 1024 MB | ~700 ms                          | ~180 ms                    |
| 1769 MB | ~480 ms                          | ~160 ms                    |

教訓は「常に 1769 MB を使え」ではありません。256 MB ではコールドスタートについて何も結論できない、ということです。実際にデプロイするメモリサイズでベンチマークしてください。そして、**[AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) ステートマシン**が数分でワークロードに最適なコスト最適メモリサイズを見つけてくれることを覚えておいてください。

## レバー 4: 静的再利用と init グラフのトリミング

ランタイムとメモリを選んだあと、残る勝ちは init 中に少なく働き、呼び出し間でより多く再利用することから来ます。3 つのパターンが価値ある作業の大半をカバーします。

### クライアントとシリアライザを静的フィールドに持ち上げる

Lambda は冷却されるまで同じ実行環境を呼び出し間で再利用します。静的フィールドに置いたものは生き残ります。古典的なミスは handler の中で `HttpClient` や AWS SDK クライアントをアロケートすることです:

```csharp
// .NET 11 - bad: per-invocation construction
public async Task<Response> Handler(Request req, ILambdaContext ctx)
{
    using var http = new HttpClient(); // pays DNS, TCP, TLS every time
    var s3 = new AmazonS3Client();      // re-resolves credentials chain
    // ...
}
```

上に持ち上げます:

```csharp
// .NET 11 - good: shared across warm invocations
public sealed class Function
{
    private static readonly HttpClient Http = new();
    private static readonly AmazonS3Client S3 = new();

    public async Task<Response> Handler(Request req, ILambdaContext ctx)
    {
        // reuses Http and S3 across warm invocations on the same instance
    }
}
```

このパターンは [HttpClient を使うコードのユニットテスト方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) でテスタビリティの観点から扱っています。Lambda では単純です: 構築が高価で安全に再利用できるものは静的にする、それだけです。

### 必ず System.Text.Json のソースジェネレーターを使う

既定の `System.Text.Json` は最初の使用時に DTO 型に対してリフレクションし、init 時間を膨らませ、Native AOT と非互換です。ソースジェネレーターはビルド時に作業を行います:

```csharp
// .NET 11
[JsonSerializable(typeof(APIGatewayProxyRequest))]
[JsonSerializable(typeof(APIGatewayProxyResponse))]
[JsonSerializable(typeof(MyDomainObject))]
public partial class LambdaJsonContext : JsonSerializerContext;
```

生成された context を `SourceGeneratorLambdaJsonSerializer<T>` に渡します。これでマネージドランタイムのコールドスタートから数百ミリ秒を削れ、AOT では必須です。

### 必要ないなら ASP.NET Core 全体を避ける

`Amazon.Lambda.AspNetCoreServer.Hosting` アダプタは API Gateway の背後で本物の ASP.NET Core minimal API を動かせます。DX としては大きな勝ちですが、構成プロバイダ、ロギングプロバイダ、オプションのバリデーション、ルーティンググラフなど、ASP.NET Core ホスト全体を起動します。5 エンドポイントの Lambda にとっては数百ミリ秒の init です。手書きの `LambdaBootstrapBuilder` の handler と比べてください。それは数十ミリ秒で起動します。

意識的に選んでください:

-   **多くのエンドポイント、複雑なパイプライン、ミドルウェアが欲しい**: ASP.NET Core hosting で問題ありません、SnapStart の道を行ってください。
-   **1 つの handler、1 つのルート、性能が重要**: `Amazon.Lambda.RuntimeSupport` に対して生の handler を書きます。HTTP リクエスト形状も欲しければ `APIGatewayHttpApiV2ProxyRequest` を直接受け取ってください。

### AOT が制約しすぎなら ReadyToRun

リフレクション重めの依存のせいで Native AOT を出荷できないが、SnapStart も使えない(おそらくまだサポートされていないマネージドランタイムをターゲットにしているため)場合、**ReadyToRun** を有効化します。R2R は IL を、JIT が最初の呼び出しで再コンパイルせずに使えるネイティブコードに事前コンパイルします。コールドスタート時の JIT コストをおよそ 50-70% 削り、引き換えにパッケージが大きくなります:

```xml
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
  <PublishReadyToRunComposite>true</PublishReadyToRunComposite>
</PropertyGroup>
```

R2R はマネージドランタイムでのコールドスタートで通常 100-300 ms の勝ちをくれます。他のすべてに重ねられ、本質的に無料なので、AOT や SnapStart に動けないなら最初に試すべきものです。

## INIT_DURATION を正しく読む

CloudWatch の `REPORT` 行はコールドスタートしたインボケーションでこの形をしています:

```
REPORT RequestId: ... Duration: 12.34 ms Billed Duration: 13 ms
Memory Size: 512 MB Max Memory Used: 78 MB Init Duration: 412.56 ms
```

`Init Duration` がコールドスタートのコストです: VM ブート + ランタイム init + 静的コンストラクタと handler クラスの構築。読み方の規則:

-   `Init Duration` はマネージドランタイムでは**請求されません**。`provided.al2023` モデルの AOT カスタムランタイムでは請求されます。
-   並行インスタンスごとに最初のインボケーションに表示されます。ウォームインボケーションでは省略されます。
-   SnapStart ファンクションは `Init Duration` ではなく `Restore Duration` を報告します。SnapStart ではそれがコールドスタート指標です。
-   `Max Memory Used` は最大水位です。`Memory Size` の ~30% 未満で安定するなら、過剰プロビジョニングの可能性があり、より小さいサイズを試せますが、メモリと共に CPU が下がるので、必ずより小さいサイズで測定してからにしてください。

これを読みやすくする道具: 次のような CloudWatch Log Insights クエリ

```
fields @timestamp, @initDuration, @duration
| filter @type = "REPORT"
| sort @timestamp desc
| limit 200
```

より深いトレースには、[dotnet-trace で .NET アプリをプロファイリングして出力を読む方法](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) が、ローカルの Lambda エミュレータセッションから init のフレームグラフを取得して読む方法を扱っています。

## Provisioned concurrency は最後の手段、答えではない

Provisioned concurrency は `N` インスタンスを永続的に温かく保ちます。それらのインスタンスのコールドスタートはゼロです。冷えていないからです。上のレバーでは満たせない厳しい遅延 SLO がある、または SnapStart の復元セマンティクスがコードと衝突している場合に正しい答えです。init を実際に最適化する代替として使うのは間違いです。修正可能な問題を覆い隠すために 24/7 で温かいキャパシティに支払い、温かく保つインスタンス数とともに請求が増えます。トラフィックが予測可能なら、Application Auto Scaling を使ってスケジュールで provisioned concurrency をスケールしてください。

## 私が本番でこれらを適用する順序

私がチューニングしたおおよそ 1 ダースの .NET Lambda を通じて:

1. **常に**: ソース生成 JSON、クライアント用の静的フィールド、R2R 有効、ロケール非依存なら `InvariantGlobalization=true`。
2. **リフレクションフリーなら**: `provided.al2023` 上の Native AOT。これ単体で他のレバーすべての合計より大きいことが普通です。
3. **リフレクションが避けられないなら**: マネージド `dotnet10` ランタイム + SnapStart に加え、init 中にホットパスを Pre-JIT するための合成 warm-up 呼び出し。
4. **検証** -- 実際のデプロイメモリサイズで INIT_DURATION を確認。コスト対遅延カーブが重要なら Power Tuning を使う。
5. **Provisioned concurrency** は上記の後、自動スケーリングと一緒のときだけ。

.NET 11 Lambda の物語の残り(ランタイムバージョン、デプロイ形、`dotnet10` から将来のマネージド `dotnet11` ランタイムに切り替えると何が変わるか)は、本記事の伴侶である [AWS Lambda が .NET 10 をサポート: ランタイム切り替え前に確認すべきこと](/2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime/) で扱っています。

## 出典

-   [.NET Lambda 関数コードをネイティブランタイム形式にコンパイルする](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) -- AWS docs。
-   [Lambda SnapStart で起動性能を改善する](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) -- AWS docs。
-   [.NET 10 ランタイムが AWS Lambda で利用可能に](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/) -- AWS blog。
-   [Lambda ランタイムの概要](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) -- `provided.al2023` を含む。
-   [aws/aws-lambda-dotnet](https://github.com/aws/aws-lambda-dotnet) -- `Amazon.Lambda.RuntimeSupport` のソース。
-   [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) -- コスト対遅延チューナー。

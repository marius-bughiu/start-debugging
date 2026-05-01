---
title: ".NET 11と無料バックエンドでOpenTelemetryを使う方法"
description: "OTLPエクスポーターを使って.NET 11 ASP.NET CoreアプリケーションにOpenTelemetryのトレース、メトリクス、ログを組み込み、無料のセルフホストバックエンドへ送信します。ローカル開発にはstandalone Aspire Dashboard、セルフホストの本番環境にはJaegerとSigNoz、両方が必要なときはOpenTelemetry Collectorを使います。"
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "observability"
  - "opentelemetry"
lang: "ja"
translationOf: "2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend"
translatedBy: "claude"
translationDate: 2026-05-01
---

.NET 11のASP.NET CoreアプリにOpenTelemetryを追加して無料の送信先へデータを送るには、`OpenTelemetry.Extensions.Hosting` 1.15.3と`OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3をインストールし、`services.AddOpenTelemetry().WithTracing(...).WithMetrics(...).UseOtlpExporter()`でSDKを登録し、`OTEL_EXPORTER_OTLP_ENDPOINT`をcollectorまたはバックエンドに設定し、`mcr.microsoft.com/dotnet/aspire-dashboard`のDockerイメージからstandalone Aspire Dashboardを起動してローカルビューワとして使います。Aspire Dashboardは`4317`でOTLP/gRPC、`4318`でOTLP/HTTPを受け付け、無料で、トレース、構造化ログ、メトリクスを単一のUIで表示します。セルフホストの本番observabilityでは、送信先をJaeger 2.x（トレースのみ）またはSigNoz 0.x（トレース、メトリクス、ログ）に切り替え、前段にOpenTelemetry Collectorを置いてファンアウトとフィルタリングができるようにします。本ガイドは.NET 11 preview 3、C# 14、OpenTelemetry .NET 1.15.3に対して書かれています。

## なぜベンダーSDKではなくOpenTelemetryなのか

.NET向けのまともなobservabilityプロダクトはいまだに独自SDKを出荷しています。Application Insights、Datadog、New Relic、Dynatrace、Honeycomb独自のクライアントなど。どれもおおむね同じことをします。ASP.NET Core、HttpClient、EF Coreにフックし、データをバッチして自社のwireフォーマットで送信します。問題はベンダーを切り替えたい瞬間、2つを並行で動かしたい瞬間、あるいは誰にも料金を払わずローカルでデータを見たい瞬間に始まります。再書き換えはそれぞれが数週間規模のプロジェクトになります。インスツルメンテーション呼び出しが何百ものファイルに散らばっているからです。

OpenTelemetryはその構図を、ベンダー中立な単一のSDKと単一のwireフォーマット（OTLP）で置き換えます。インスツルメンテーションは一度だけです。エクスポーターは別パッケージで、起動時に差し替え可能です。同じテレメトリをローカル開発時はAspire Dashboardへ、stagingではJaegerへ、本番では有料バックエンドへ送れます。すべてアプリケーションコードを触らずにです。ASP.NET Core 11はネイティブのOpenTelemetryトレーシングプリミティブまで同梱しているため、フレームワーク自身のスパンがあなたのカスタムスパンと同じパイプラインに流れます（何がアップストリームに取り込まれたかは[.NET 11のネイティブOpenTelemetryトレーシングの変更点](/ja/2026/04/aspnetcore-11-native-opentelemetry-tracing/)を参照）。

2026年に覚えておく価値のあるバージョン番号は次のとおりです。`OpenTelemetry` 1.15.3、`OpenTelemetry.Extensions.Hosting` 1.15.3、`OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3、ASP.NET Coreインスツルメンテーション1.15.0、HttpClientインスツルメンテーション1.15.0です。Aspire Dashboardは執筆時点で`mcr.microsoft.com/dotnet/aspire-dashboard:9.5`から提供されています。

## 30秒で無料バックエンドを起動する

コードに手を付ける前に、バックエンドを動かしておきます。standalone Aspire Dashboardはローカル開発で最も手間の少ない選択肢です。OTLPレシーバーを公開し、トレース、メトリクス、ログをメモリ上にインデックスし、ポート`18888`にBlazor UIを提供します。

```bash
# Aspire Dashboard 9.5, default ports
docker run --rm \
  --name aspire-dashboard \
  -p 18888:18888 \
  -p 4317:18889 \
  -p 4318:18890 \
  -e DASHBOARD__OTLP__AUTHMODE=ApiKey \
  -e DASHBOARD__OTLP__PRIMARYAPIKEY=local-dev-key \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.5
```

コンテナは内部で`18889`をOTLP/gRPC、`18890`をOTLP/HTTPに公開しており、外側では標準ポート`4317`/`4318`にマップして、デフォルト設定の任意のOpenTelemetry SDKがそれらを見つけられるようにします。`DASHBOARD__OTLP__AUTHMODE=ApiKey`を設定すると、クライアントは`x-otlp-api-key`ヘッダーにキーを付ける必要があり、ダッシュボードをloopback以外のアドレスにバインドした瞬間に重要になります。`http://localhost:18888`を開くと、データを待っている空のTraces、Metrics、Structured Logsタブが見えます。ダッシュボードはすべてをプロセスメモリに保持するため、再起動で状態が消えます。これは開発ツールであり、長期保管用のストアではありません。

ローカルで何も動かしたくない場合は、Jaeger 2.xがトレース専用で同じ手軽さを提供します。

```bash
# Jaeger 2.0 all-in-one
docker run --rm \
  --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/jaeger:2.0.0
```

Jaeger 2.x自身がCassandra/Elasticsearch/Badgerストレージバックエンドを持つOpenTelemetry Collectorの薄いラッパーであり、OTLPをネイティブに受け付けます。SigNozはClickHouseの上にメトリクスとログを乗せたもので、ワンライナーではなくDocker Composeでのインストールになります。`https://github.com/SigNoz/signoz`を取得して`docker compose up`を実行してください。

## SDKとインスツルメンテーションパッケージのインストール

ASP.NET Core 11のミニマルAPIでは、4つのパッケージでハッピーパスをカバーできます。集約パッケージ`OpenTelemetry.Extensions.Hosting`がSDKを引き込み、OTLPエクスポーターがトランスポートを担当し、2つのインスツルメンテーションパッケージがWebアプリに必要な2つの面、つまり受信HTTPと送信HTTPをカバーします。

```bash
# OpenTelemetry .NET 1.15.3, .NET 11
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.15.3
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.15.3
dotnet add package OpenTelemetry.Instrumentation.AspNetCore --version 1.15.0
dotnet add package OpenTelemetry.Instrumentation.Http --version 1.15.0
```

EF Coreも使う場合は`OpenTelemetry.Instrumentation.EntityFrameworkCore` 1.15.0-beta.1を追加します。`-beta.1`サフィックスに注意してください。このラインは公式にはまだプレビューですが、私が一緒に仕事をしてきたチームはどこも安定版として扱っています。インスツルメンテーションはEF Coreのdiagnostic sourceにフックして、`SaveChanges`、クエリ、DbCommandごとに1スパンをエミットします。

## Program.csでトレース、メトリクス、ログを配線する

SDKは1つの登録で済みます。OpenTelemetry .NET 1.8以降、`UseOtlpExporter()`はトレース、メトリクス、ログ向けのOTLPエクスポーターを単一呼び出しで登録する横断的なヘルパーであり、以前のパイプラインごとの`AddOtlpExporter()`を置き換えます。

```csharp
// .NET 11, C# 14, OpenTelemetry 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(
            serviceName: "orders-api",
            serviceVersion: typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            serviceInstanceId: Environment.MachineName))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource("Orders.*"))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter("Orders.*"))
    .WithLogging()
    .UseOtlpExporter();

var app = builder.Build();

app.MapGet("/orders/{id:int}", (int id) => new { id, status = "ok" });
app.Run();
```

3つの点を強調しておきます。第一に、`ConfigureResource`は実務上オプションではありません。`service.name`がないと、どのバックエンドもすべてを`unknown_service:dotnet`の下にまとめてしまい、2つ目のアプリが現れた瞬間に運用不能になります。第二に、`AddSource("Orders.*")`はあなたのカスタムな`ActivitySource`インスタンスを表に出すための設定です。`new ActivitySource("Orders.Checkout")`としてインスタンス化した場合、登録したglobに一致しなければスパンはどこにも届きません。第三に、`WithLogging()`は`Microsoft.Extensions.Logging`を同じパイプラインに結びつけ、`ILogger<T>`の呼び出しが現在のtrace IDとspan IDを付与した構造化OpenTelemetryログレコードを書き込めるようにします。これがAspire Dashboardの「View structured logs for this trace」リンクを成立させているものです。

## エクスポーターはコードではなく環境変数から設定する

デフォルトのOTLPエクスポーターは、宛先、プロトコル、ヘッダーをOpenTelemetry仕様で定義された環境変数から読み取ります。これらを`UseOtlpExporter(o => o.Endpoint = ...)`の中にハードコードするのは悪い兆候です。バイナリを特定のバックエンドに縛り付けてしまうからです。代わりに環境変数を使えば、同じイメージが開発者のラップトップでもCIでも本番でもリビルドなしに動きます。

```bash
# Talk to a local Aspire Dashboard over gRPC
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_HEADERS="x-otlp-api-key=local-dev-key"
export OTEL_SERVICE_NAME="orders-api"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=dev"
```

ほとんどの人がつまずくのが2つの値です。`OTEL_EXPORTER_OTLP_PROTOCOL`は.NET 8以降のデフォルトが`grpc`ですが、.NET Standard 2.0ビルドでは`http/protobuf`がデフォルトです。これはSDKがモダンなターゲットでは独自のgRPCクライアントを同梱する一方、Frameworkではgrpc依存を避けるためHTTPにフォールバックするからです。両方をブリッジする場合は値を明示的に設定します。そして`OTEL_EXPORTER_OTLP_HEADERS`はカンマ区切りの`key=value`ペアのリストを受け付けます。bearerトークンで認証するバックエンドはこれを`Authorization=Bearer ...`に使います。Aspire DashboardのAPIキーは`x-otlp-api-key`であり、より一般的な`Authorization`ではありません。

ローカル開発からデプロイ済みバックエンドへ移行する際、変わるのはエンドポイントと認証ヘッダーだけです。アプリのバイナリは同じままです。

## ActivitySourceでカスタムスパンを追加する

インスツルメンテーションパッケージは受信と送信のHTTPを自動でカバーし、加えたならEF Coreもカバーします。それ以外はあなた次第です。.NETはクロスランタイムなスパン用プリミティブとして`System.Diagnostics.ActivitySource`を出荷しており、OpenTelemetry .NETは独自の型を導入する代わりにこれを直接採用します。論理領域ごとに1つ作成し、その接頭辞を`AddSource`に登録し、スパンが欲しい場所で`StartActivity`を呼び出します。

```csharp
// Orders/CheckoutService.cs -- .NET 11, C# 14
using System.Diagnostics;

public sealed class CheckoutService(IOrdersRepository orders, IPaymentClient payments)
{
    private static readonly ActivitySource Source = new("Orders.Checkout");

    public async Task<CheckoutResult> CheckoutAsync(int orderId, CancellationToken ct)
    {
        using var activity = Source.StartActivity("checkout", ActivityKind.Internal);
        activity?.SetTag("order.id", orderId);

        var order = await orders.GetAsync(orderId, ct);
        activity?.SetTag("order.line_count", order.Lines.Count);

        var receipt = await payments.ChargeAsync(order, ct);
        activity?.SetTag("payment.provider", receipt.Provider);

        return new CheckoutResult(receipt.Id);
    }
}
```

`StartActivity`はリスナーが付いていないとき`null`を返すため、`?.SetTag`呼び出しは防御的なパラノイアではなく、OpenTelemetryを無効化したビルドでのNullReferenceExceptionを防ぐためのものです。タグはOpenTelemetryのセマンティックコンベンションに従います（`http.request.method`、`db.system`、`messaging.destination.name`など）。`order.id`のようなドメイン固有の値は、コンベンションと衝突せずクエリ可能な状態を保つために独自プレフィックスで名前空間を分けます。

同じパターンが`System.Diagnostics.Metrics.Meter`によるメトリクスにも適用されます。領域ごとに1つ作成し、`AddMeter`で登録し、`Counter<T>`、`Histogram<T>`、`ObservableGauge<T>`で値を記録します。

## OTLPログをトレースと相関付ける

`WithTracing()`だけでなく`WithLogging()`も登録する理由は相関です。アクティブスパン内のすべての`ILogger<T>`呼び出しは、スパンの`TraceId`と`SpanId`が自動的にOTLPログレコードフィールドとして付与され、Aspire Dashboardはこれをトレースビューからクリック可能なリンクとしてレンダリングします。同じ相関は、OpenTelemetry対応のどのバックエンドでも機能します。

すでにSerilogを使っていて手放したくないなら、その必要はありません。`Serilog.Sinks.OpenTelemetry`パッケージはSerilogイベントをOTLPログレコードとして書き出し、OpenTelemetry SDKのロギングプロバイダーは`WithLogging()`から省けます。本サイトの構造化ロギング記事は[.NET 11でSerilogとSeqをセットアップする方法](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)をより詳しく扱っており、SeqをOTLPに置き換えても同じトレース相関のルールが適用されます。

素の`Microsoft.Extensions.Logging`の場合、レシピはもっと短くなります。OpenTelemetryパイプラインに`WithLogging()`を追加し、本番ではデフォルトのコンソールプロバイダーを切ります。`LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)`はすでに構造化されており、OpenTelemetryは名前付きプレースホルダーをOTLPログ属性としてシリアライズします。一方コンソールプロバイダーはそれらを単一文字列に平坦化し直してしまい、まさにあなたが逃げ出そうとしていた退行が再現してしまいます。

## 本番ではOpenTelemetry Collectorを前段に置く

本番ではアプリケーションがobservabilityバックエンドと直接話をすることはほとんど望みません。間にCollectorを挟むのが望ましいです。OTLPを受信し、サンプリングを適用し、PIIをスクラブし、バッチし、リトライし、データを1つまたは複数の宛先にファンアウトする独立プロセスです。Collectorのイメージは`otel/opentelemetry-collector-contrib:0.111.0`で、OTLPを受け取りJaegerとホスト型バックエンドへ転送する最小構成は次のようになります。

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 512
  attributes/scrub:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: user.email
        action: hash

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  otlp/honeycomb:
    endpoint: api.honeycomb.io:443
    headers:
      x-honeycomb-team: ${env:HONEYCOMB_API_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, attributes/scrub]
      exporters: [otlp/jaeger, otlp/honeycomb]
```

アプリの`OTEL_EXPORTER_OTLP_ENDPOINT`は特定のバックエンドではなくCollectorを指すようになります。宛先の切り替えはCollectorの設定変更と再起動になり、各サービスの再デプロイにはなりません。同じパターンがトレース量の増加を抑える鍵にもなります。各エクスポーターの前に`attributes/scrub`プロセッサーを置けば、初日からauthorizationヘッダーをサードパーティに誤って送るのを止められます。

## ドキュメントが警告しない落とし穴

動くパイプラインに到達するまでの間、人をつまずかせる3つの点があります。

第一に、**gRPCとHTTPのデフォルトはランタイム間で一致しません**。.NET 8以降ではSDKがマネージドなgRPCクライアントを同梱しており`OTEL_EXPORTER_OTLP_PROTOCOL`のデフォルトは`grpc`です。.NET Framework 4.8と.NET Standard 2.0では`Grpc.Net.Client`依存を避けるためデフォルトが`http/protobuf`です。1つのソリューションが両方をターゲットにする場合は、プロトコルを明示的に設定しないと、2つのアセンブリで同じコードが異なる挙動を見せます。

第二に、**リソース属性はパイプラインごとではなくグローバルです**。`ConfigureResource`は1度だけ実行され、その結果がそのプロセスのすべてのトレース、メトリクス、ログレコードに付与されます。リソースAPIを通じてリクエストごとの属性を設定しようとしても黙って何も起きません。そこで欲しいのはアクティブスパン上の`Activity.SetTag`、もしくは呼び出しを跨いで伝播する`Baggage`エントリです。Aspire 13.2.4のbaggage DoSのCVEは[OpenTelemetry .NETのbaggage CVEの解説](/ja/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/)に書かれていますが、baggageは各リクエストで先行的にパースされるため、有用ですが鋭利なツールであることを思い出させてくれます。

第三に、**OTLPエクスポーターはバックグラウンドで黙ってリトライします**。バックエンドがダウンしている間、エクスポーターはイベントをメモリにバッチし続け、設定可能な上限まで指数バックオフでリトライします。これは普通は望ましい挙動ですが、意外なのはCollectorやダッシュボードが復旧しても即時にflushされない点です。「トレースXが100ms以内にAspire Dashboardへ到達した」と主張する統合テストを動かしているなら、エクスポーターに`BatchExportProcessor`のスケジュールをデフォルトの5秒より短く与えるか、アサーションの前に`TracerProvider.ForceFlush()`を明示的に呼びます。

## ここから先に進むには

OpenTelemetryの価値は、インスツルメントする面積に応じて累乗的に増えます。スタート地点はASP.NET Core、HttpClient、EF Coreです。そこから影響の大きい追加先はバックグラウンドサービス（あらゆる`IHostedService`は作業単位ごとに`Activity`を開始するべき）と送信側のメッセージブローカー（`OpenTelemetry.Instrumentation.MassTransit`とConfluent.Kafkaのインスツルメンテーションがほとんどのチームをカバーします）です。スパンが正しい1分間に導いた後、より深い作業単位プロファイリングが必要なときは、本サイトの[dotnet-traceガイド](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)が、OpenTelemetryが終わるところでよく引き継がれるツールを案内します。また[グローバル例外フィルターの記事](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)は、ASP.NET Core側で同じパイプラインに失敗をきれいに取り込む方法を扱っています。

目指す価値のある最終形は、1つのパイプライン、1つのwireフォーマット、何かが起きたときに最初に見るべき1つの場所です。OpenTelemetry、Aspire Dashboard、前段のCollectorの組み合わせが、docker pullの代金で皆さんをそこに連れて行きます。

Sources:

- [OpenTelemetry .NET Exporters documentation](https://opentelemetry.io/docs/languages/dotnet/exporters/)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Use OpenTelemetry with the standalone Aspire Dashboard - .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-otlp-example)
- [.NET Observability with OpenTelemetry](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)

---
title: ".NET 11 における Azure Functions の isolated worker と in-process の比較: 2026 年にどちらを選ぶべきか"
description: "2026 年の .NET 11 上の Azure Functions アプリケーションでは isolated worker モデルを選び、残存する in-process アプリは 11 月 10 日の廃止期限までに移行してください。"
pubDate: 2026-05-26
template: vs
tags:
  - "comparison"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "ja"
translationOf: "2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-26
---

2026 年に新しく作る Azure Functions アプリには、isolated worker モデルを選んでください。.NET 9、.NET 10、.NET 11 をサポートする唯一のモデルです。in-process モデルは **2026 年 11 月 10 日** に廃止されます。これは .NET 8 LTS のサポート終了日と同じ日であり、その日以降 Azure は in-process 関数のホスティングを拒否します。.NET 6 や .NET 8 の in-process アプリがまだ残っている場合、問うべきは「どのモデルを選ぶか」ではなく「どれだけ早く移行できるか」です。この記事では両者の違いを説明し、ハマりどころを示し、両方のランタイムが消えた後にも残る唯一の判断軸、つまり「in-process モデルが無料で提供していたものを手放さずに isolated worker をどう構成するか」をたどります。

この記事の対象は、Azure Functions host v4、.NET 8 LTS から .NET 11 (執筆時点でプレビュー) までの .NET isolated worker モデル、そして .NET 6 と .NET 8 LTS 上の in-process モデルです。正確なパッケージのバージョン: `Microsoft.Azure.Functions.Worker` 2.0.x、`Microsoft.Azure.Functions.Worker.Sdk` 2.0.x、in-process アプリでは `Microsoft.NET.Sdk.Functions` 4.5.x。

## 2 つのモデルを 1 段落ずつ

**in-process モデル**は、関数のアセンブリを Azure Functions host と同じプロセスにロードします。host は Microsoft がメンテナンスする .NET アプリケーションであり、特定の .NET ランタイムバージョンに固定されています。コードは host のランタイムバージョン、依存関係グラフ、ライフサイクルを共有します。`[BlobTrigger]` のような属性で宣言するトリガーやバインディングは、host の WebJobs 拡張に直接対応します。コードと host は同一プロセスなので、両者の間に IPC はありません。

**isolated worker モデル**は、関数を別個の worker プロセスで実行し、そのプロセスは利用者が制御します。host がそれを起動し、gRPC で通信し、トリガーのペイロードを転送します。利用者は自身の `Program.cs`、自身の `HostBuilder`、自身の DI コンテナーを持ち込み、そして重要なことに、自身の .NET ランタイムバージョンを持ち込みます。host は Microsoft が出荷した任意の .NET バージョンに留まれ、worker は .NET 11 に乗れます。この分離が要点であり、Microsoft が新しい .NET リリースごとに host をビルドし直さなくて済むようにします。

## 機能マトリクス

| 機能                                       | in-process                                   | isolated worker                                           |
| ------------------------------------------ | -------------------------------------------- | --------------------------------------------------------- |
| 最後にサポートされる .NET バージョン       | .NET 8 LTS                                   | .NET 8、9、10、11 (任意の現行 LTS または STS)             |
| 廃止日                                     | **2026 年 11 月 10 日**                      | アクティブ、廃止予定なし                                  |
| プロセスモデル                             | host と共有                                  | 別個の worker プロセス                                    |
| host との通信                              | インメモリ                                   | 名前付きパイプ / TCP 上の gRPC                            |
| 起動ファイル                               | `Startup.cs` と `FunctionsStartup`           | `Program.cs` と `HostBuilder`                             |
| 依存性注入                                 | host の DI、限定的なオーバーライド面         | 完全な `Microsoft.Extensions.DependencyInjection`         |
| ミドルウェア                               | 非対応                                       | `IFunctionsWorkerApplicationBuilder` 経由で対応           |
| HTTP レスポンスの型                        | `IActionResult`、`HttpResponseMessage`       | `HttpResponseData`、ASP.NET Core 統合 (オプトイン)        |
| ログ出力                                   | `ILogger` パラメーター注入                   | DI または `FunctionContext` 経由の `ILogger`              |
| トリガー / バインディングの網羅性          | 最も広い (すべての WebJobs 拡張)             | 広いが、一部の拡張がまだ遅れている                        |
| コールドスタート (小さな HTTP 関数、Linux) | Consumption で約 250-400 ms                  | Consumption で約 350-600 ms                               |
| ウォーム時のスループット                   | わずかに高い (IPC なし)                      | わずかに低い (呼び出しごとに gRPC ホップ)                 |
| 関数内のキャンセルトークン                 | ほとんどのトリガーで対応                     | Worker 1.16 以降、全トリガーで対応                        |
| OpenTelemetry のファーストクラス対応       | host 拡張経由                                | `AddApplicationInsightsTelemetryWorkerService` と標準の OTel エクスポーター経由でネイティブ |
| Ahead-of-time コンパイル                   | 非対応                                       | .NET 8+ の HTTP トリガーで Native AOT 対応                |

選択を決定づける行は最初の 2 行です。「モデルは 2026 年 11 月に消える」という事実に比べれば、それ以外はすべて実装上の細部にすぎません。

## isolated worker モデルを選ぶべき場面

実務上、これがいまや唯一の選択肢です。次のいずれかの場合に手を伸ばしてください。

- **2026 年のあらゆる新規 Azure Functions プロジェクト。** この 11 月に廃止されるモデルで新しいアプリを出すビジネス上の理由はありません。たとえ今日 .NET 8 にいても、`func init --worker-runtime dotnet-isolated` でスキャフォールドし、`--worker-runtime dotnet` は使わないでください。
- **.NET 9 や .NET 11 の言語機能が必要。** コレクション式、新しい `System.Threading.Lock` 型、プライマリコンストラクター、`field` キーワード、HTTP トリガーの Native AOT は、host が .NET 8 に固定されているため、in-process モデルではすべて利用できません。そのうちの 1 つでも欲しい瞬間に、選択は isolated になります。
- **ミドルウェアが欲しい。** テレメトリ、ウォームアッププローブの認証バイパス、相関 ID の伝播、リクエスト検証など、通常 ASP.NET Core のミドルウェアとして書くものすべて。isolated worker は `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` を通して本物のミドルウェアパイプラインを公開します。in-process モデルには同等のものはなく、各関数の先頭にコードをばらまいて擬似的に再現するしかありません。
- **Native AOT で動かしている。** Native AOT 上の Functions は isolated worker モデルを必要とします。発行されたバイナリは数百ミリ秒ではなく数十ミリ秒で起動し、これによりマトリクスで触れたコールドスタートの差の大半が埋まります。

isolated worker の最小限の `Program.cs` は次のようになります。

```csharp
// .NET 11, C# 14, Microsoft.Azure.Functions.Worker 2.0.x
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

builder.Services.AddHttpClient();
builder.Services.AddSingleton<IOrderStore, OrderStore>();

builder.UseMiddleware<CorrelationIdMiddleware>();

builder.Build().Run();
```

`ConfigureFunctionsWebApplication()` を呼ぶと ASP.NET Core 統合がオプトインされ、HTTP トリガーがコントローラーと同様に `HttpRequest` を受け取り `IActionResult` を返せるようになります。この呼び出しがない場合、HTTP トリガーは worker SDK の `HttpRequestData` / `HttpResponseData` 型を使います。これらはより冗長に感じますが、Native AOT との相性は良いです。

## in-process モデルを選ぶべき場面

残っているシナリオはちょうど 1 つです: .NET 6 または .NET 8 上の既存の in-process アプリがあり、**2026 年 11 月 10 日** までに移行できず、それまでバグ修正を出し続ける必要がある場合です。.NET 8 LTS のまま維持し、チューニングに労力を浪費せず、移行をロードマップに載せてください。

かつて in-process が有利だった、もう 2 つの狭いケースが 2026 年にどう見えるか:

- **ポートされていないバインディング拡張。** 2023 年と 2024 年の大半、特定の Durable Functions の機能、SignalR Service バインディング、いくつかのプレビュー拡張は isolated worker から 6〜12 ヶ月遅れていました。2026 年半ばの時点で、バインディングのギャップは実質的に閉じています: Durable Functions、SignalR Service、Event Grid、Cosmos DB、Service Bus、Event Hubs、Blob、Queue、Table の各バインディングはすべて一級の isolated worker SDK を持ちます。ギャップがまだ存在すると決めつける前に、バインディングの NuGet ページで `Microsoft.Azure.Functions.Worker.Extensions.*` パッケージがあるかを確認してください。存在すれば、ギャップは消えています。
- **300 ms 未満のコールドスタートが言語バージョンより重要。** これは 2023 年には実際の議論でした。今ではずっと弱い議論です。isolated worker 上の Native AOT は in-process モデルがかつて出したどのコールドスタートよりも速いです。worker は JIT なしで起動し、WebJobs host の完全な依存関係グラフをロードしないからです。コールドスタートが問題なら、答えは Native AOT であって in-process ではありません。

## コールドスタートのベンチマーク

以下は、West Europe リージョンの Linux Consumption プランで測定した数値です。方法論: `"hello"` を返す単一の HTTP トリガー関数。各行は 25 分のアイドル後に発生させた 50 回のコールドスタートの中央値で、curl ループを駆動するのに `azure-functions-perftools` を使いました。同じ `host.json`、同じ App Insights 構成。in-process 行と .NET 8 isolated 行は .NET 8.0.18 LTS、.NET 11 行は .NET 11.0 preview 4 です。

| 構成                                                      | コールドスタート (p50) | コールドスタート (p95) | ウォーム時レイテンシ (p50) |
| --------------------------------------------------------- | ---------------------- | ---------------------- | -------------------------- |
| In-process, .NET 8 LTS, JIT                               | 312 ms                 | 478 ms                 | 4.1 ms                     |
| Isolated worker, .NET 8 LTS, JIT                          | 488 ms                 | 702 ms                 | 6.8 ms                     |
| Isolated worker, .NET 11 preview 4, JIT                   | 451 ms                 | 661 ms                 | 6.2 ms                     |
| Isolated worker, .NET 8 LTS, Native AOT (HTTP のみ)       | 198 ms                 | 287 ms                 | 3.4 ms                     |
| Isolated worker, .NET 11 preview 4, Native AOT (HTTP)     | 181 ms                 | 266 ms                 | 3.1 ms                     |

この表から読み取れることが 2 つあります。第 1 に、JIT の isolated worker はコールドスタートで本当に in-process より遅く、このワークロードではおよそ 150 ms 遅いです。この差は gRPC のハンドシェイクと、worker プロセスが自前の `HostBuilder` を立ち上げる時間です。第 2 に、Native AOT は差を埋めるだけでなく追い越します: Native AOT の isolated worker は、in-process モデルがかつて出したどのコールドスタートよりも速いです。in-process に留まる業務上の根拠がコールドスタートだったなら、現代的な答えは isolated に移って AOT を有効化することであり、今いる場所に留まることではありません。

## 選択を強制するハマりどころ

好みに関係なく決定を強制する 2 つの事項があります。

**廃止日は推奨ではなく、ハードな期限です。** 2026 年 11 月 10 日に、Azure は in-process モデルへのデプロイの受け付けを停止し、既存の in-process アプリのスケールも停止します。Microsoft は [廃止のお知らせ](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide) を 2024 年初頭から繰り返し公開してきており、2026 年半ばには `dotnet upgrade-assistant` の移行ツールが機械的な手順の大半をカバーします。もし in-process 関数が顧客向けの何かの正面玄関なら、「2027 Q1 に移行します」は計画ではなくサービス停止です。

**いくつかのバインディングは 2 つのモデルで微妙に異なる挙動を持ちます。** 移行中に最も噛みつかれる可能性が高い 2 つ:

- isolated worker の HTTP トリガーは既定で `HttpResponseData` を返し、設定した `WorkerOptions.Serializer` (既定では System.Text.Json) でシリアル化します。`IActionResult` を返す in-process の HTTP トリガーは host の MVC フォーマッタを使います。in-process 関数が Newtonsoft のコントラクトリゾルバーに依存していた場合、移行には worker 側で明示的なシリアライザーの登録が必要です。
- isolated worker の Durable Functions のオーケストレーターコードは、DI コンテナーへの完全なアクセスを持って worker プロセス内で動作しますが、オーケストレーションの再生ルールは依然として適用されます。in-process では (host の DI がより寛容なため) たまたま動いていた、インスタンス スコープのサービスを呼び出すオーケストレーター コードは、isolated ではデッドロックを起こすか、非決定論的な再生を引き起こすことがあります。修正は Durable の標準ルールです: オーケストレーターから呼び出すのはアクティビティ関数のみとし、サービスは注入しません。

## 移行は通常どのように進むか

.NET 8 の単一の function app での、in-process から isolated worker への小〜中規模の典型的な移行は、集中して 1 日、それにリリースウィンドウを足した期間で済みます。機械的な手順:

1. `.csproj` の SDK 参照を `Microsoft.NET.Sdk.Functions` から `Microsoft.Azure.Functions.Worker.Sdk` に変更し、`Microsoft.Azure.Functions.Worker` を追加します。
2. `Startup.cs` と `FunctionsStartup` を削除します。`FunctionsApplication.CreateBuilder(args)` を使う `Program.cs` に置き換えます。
3. すべてのバインディング拡張の参照を `Microsoft.Azure.WebJobs.Extensions.*` から `Microsoft.Azure.Functions.Worker.Extensions.*` に変更します。
4. 関数のシグネチャを書き換えます: `ILogger log` パラメーターはコンストラクター注入か `FunctionContext.GetLogger<T>()` に移動します。`[FunctionName]` は `[Function]` になります。`HttpRequest` / `IActionResult` は (`ConfigureFunctionsWebApplication()` を呼ぶなら) そのまま残るか、`HttpRequestData` / `HttpResponseData` に変わります。
5. function app の構成で `FUNCTIONS_WORKER_RUNTIME` を `dotnet-isolated` に設定し、ポータルまたは Bicep でデプロイ スロットのランタイム スタックを更新します。
6. テスト スイートを実行し、ステージング スロットにデプロイして、入れ替え前に 24 時間のソークを実行します。

`dotnet upgrade-assistant` はほとんどのアプリで手順 1 から 4 を自動化します。助けにならない箇所は、ミドルウェア相当のカスタム コード (通常は本物のミドルウェアに変換したい) と、もはや適用されない WebJobs host へのリフレクション ベースのアクセスです。

## 意見を込めた推奨、再掲

2026 年の Azure Functions アプリにはすべて isolated worker モデルを使ってください。ゼロから始めるなら、.NET 11 isolated でスキャフォールドし、コールドスタートが重要なら HTTP トリガーで Native AOT を有効化してください。in-process アプリがあるなら、廃止期限の前に 1 ヶ月の余裕を持てるよう、2026 年 10 月までに移行が完了するようスケジュールし、その 1 ヶ月を本番トラフィック下での新モデルのソークに使ってください。AOT を比較に加えると「in-process のほうが速い」は真ではなくなり、「in-process のほうがバインディングが多い」は 2024 年後半以降、真ではありません。

## 関連

- [.NET 11 AWS Lambda のコールドスタート時間を削減する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は、Lambda 上での同じコールドスタートのトレードオフを説明します。AOT に関する助言の大半はそのまま転用できます。
- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、isolated worker で AOT を有効化したときに当たる publish 設定と trim 警告を順に説明します。
- [Native AOT vs ReadyToRun vs 素の JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) には、上記のコールドスタートの主張の背後にあるベンチマーク数値があります。
- [Polly vs .NET 11 の resilience handlers](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) は、isolated worker がいまや使う `HttpClient` 呼び出しの周りでほぼ確実に欲しくなるリトライ パターンを扱います。
- [ASP.NET Core 11 でグローバルな例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は、`ConfigureFunctionsWebApplication()` を呼んだあと、isolated worker のミドルウェア アプローチにきれいに対応します。

## 参考資料

- Microsoft Learn、[分離された worker プロセスで C# Azure Functions を実行するためのガイド](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide)。
- Microsoft Learn、[in-process モデルと isolated worker モデルの違い](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences)。
- Azure Functions チーム、[in-process モデルの廃止のお知らせ](https://techcommunity.microsoft.com/blog/appsonazureblog/net-on-azure-functions-roadmap-update/4178714)。
- NuGet 上の `Microsoft.Azure.Functions.Worker`、[2.0.x のリリース ノート](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker)。
- Azure SDK ブログ、[Azure Functions の HTTP トリガーに対する Native AOT サポート](https://devblogs.microsoft.com/azure-sdk/)。

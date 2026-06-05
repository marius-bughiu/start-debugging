---
title: "in-process の Azure Functions から分離ワーカーモデルへ移行する (.NET 8 / .NET 11)"
description: "2026 年 11 月 10 日のサポート終了までに .NET の in-process Azure Functions アプリを分離ワーカーモデルへ移すための手順別チェックリスト。csproj の diff、シグネチャの書き換え、スロットスワップによるロールアウトを含みます。"
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
lang: "ja"
translationOf: "2026/06/migrate-from-in-process-azure-functions-to-isolated-worker"
translatedBy: "claude"
translationDate: 2026-06-05
---

.NET 8 上の典型的な in-process Azure Functions アプリは、集中したコード変更のおよそ 1 日と段階的なリリースウィンドウで分離ワーカーモデルへ移行します。壊れるものは機械的で予測可能です。`.csproj` の SDK 参照、`Startup.cs`、すべての `[FunctionName]` 属性、すべての `Microsoft.Azure.WebJobs.Extensions.*` パッケージ、そして `ILogger` パラメーターを受け取っていたすべての関数です。これらのどれも難しくはありませんが、すべて必須です。なぜなら in-process モデルのサポートは **2026 年 11 月 10 日** に終了し、その日付以降、Azure は in-process アプリにセキュリティ更新と機能更新を提供しなくなるからです。このガイドは完全なチェックリストです。何を変えるか、各変更の正確な diff、各ステップをどう検証するか、そしてプロダクションが壊れた中間状態を決して見ないよう、ランタイムの切り替えを staging スロット経由でどうロールアウトするかを示します。

これは Azure Functions ホスト v4 を対象とし、.NET 6 または .NET 8 LTS 上の `dotnet`（in-process）アプリを、.NET 8 LTS（推奨される速い経路）または .NET 11 上の `dotnet-isolated` 分離ワーカーモデルへ移行します。参照しているパッケージバージョンは 2026 年 6 月時点で最新の安定版です。`Microsoft.Azure.Functions.Worker` 2.0.x、`Microsoft.Azure.Functions.Worker.Sdk` 2.0.x、および `Microsoft.Azure.Functions.Worker.Extensions.*` ファミリーです。アプリがまだホスト v1、v2、v3 にある場合は、先に [ホストのバージョン 3.x から 4.x へのアップグレード](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-version-3-version-4) を行ってください。そのガイドは分離ワーカーへの移動を同じパスに組み込みます。

移行するかどうかをまだ検討している場合は、先に [.NET 11 における分離ワーカー vs in-process](/ja/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) を読んでください。この記事は、すでに決断していて機械的なレシピが欲しいことを前提にしています。

## なぜこの移行は任意ではないのか

- **in-process モデルのサポートは 2026 年 11 月 10 日に終了します。** これは .NET 8 LTS がサポート外になるのと同じ日です。その日付以降、in-process アプリは動き続けますが、Microsoft からのセキュリティパッチと機能更新を受け取れなくなり、新しい in-process アプリをデプロイできなくなります。Microsoft は 2024 年初頭から [サポート終了の通知](https://aka.ms/azure-functions-retirements/in-process-model) を公開しています。
- **分離ワーカーは .NET 9、10、11 を解放します。** in-process ホストは .NET 8 に固定されており、それより先へ進むことはありません。プライマリコンストラクター、`field` キーワード、`System.Threading.Lock` 型、コレクション式、または Native AOT が欲しくなった瞬間に、自分のランタイムを持ち込む分離ワーカーが必要になります。
- **本物のミドルウェアパイプラインと完全な依存性注入が得られます。** 分離ワーカーは `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` と、オーバーライド面に制限のない標準の `Microsoft.Extensions.DependencyInjection` コンテナーを公開します。相関 ID、ウォームアッププローブ向けの認証バイパス、リクエスト検証は、各関数の先頭にコピー＆ペーストされたコードではなく、ミドルウェアになります。
- **コールドスタートは高くなるのではなく、低くなる可能性があります。** 素の JIT の分離ワーカーはコールドスタートで in-process よりおよそ 150 ms 遅いですが、分離ワーカー上の Native AOT は in-process がかつて起動したよりも速く起動します。コールドスタートが in-process に留まった理由なら、現代の答えは分離プラス AOT です。

## 何が壊れるか

| 領域                       | 変更                                                                                                    | 深刻度 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| SDK 参照                   | `Microsoft.NET.Sdk.Functions` を削除し、`Microsoft.Azure.Functions.Worker` + `.Worker.Sdk` に置き換え    | 高       |
| 出力タイプ                 | `.csproj` に `<OutputType>Exe</OutputType>` が必要。ワーカーは本物のコンソールプロセスになる             | 高       |
| Startup                    | `FunctionsStartup` / `Startup.cs` が `HostBuilder` を持つ `Program.cs` に置き換わる                       | 高       |
| 関数属性                   | `[FunctionName("X")]` が `[Function("X")]` になる                                                        | 高       |
| バインディングパッケージ   | 各 `Microsoft.Azure.WebJobs.Extensions.*` が `Microsoft.Azure.Functions.Worker.Extensions.*` に変わる    | 高       |
| `ILogger` パラメーター     | メソッドで注入される `ILogger log` がコンストラクターで注入される `ILogger<T>` になる                     | 中       |
| HTTP の戻り値型            | `IActionResult` は ASP.NET Core 統合を有効にした場合のみ動き続ける。そうでなければ `HttpResponseData`     | 中       |
| 入力 / 出力バインディング  | 入力バインディングは `Input` サフィックスを得て、出力バインディングは `Output` サフィックスを得て、出力はパラメーターリストを離れる | 中       |
| `IBinder` / `IAsyncCollector<T>` | `IBinder` は削除。`IAsyncCollector<T>` は `T[]` の戻り値または注入されたクライアントになる            | 中       |
| `FUNCTIONS_WORKER_RUNTIME` | 値がローカルおよび Azure のアプリ設定で `dotnet` から `dotnet-isolated` に変わる                          | 高       |
| ログのフィルタリング       | host.json はもうあなたのコードのログをフィルタリングしない。フィルタリングは `Program.cs` へ移動する      | 低       |

## 事前準備チェックリスト

コードを 1 行触る前に:

- アプリが **ホスト v4** 上にあることを確認します。`func --version`（Core Tools 4.x）を実行し、ポータルで Functions ランタイムバージョン設定を確認してください。v3 以前にいる場合は、先にホストをアップグレードします。
- 移行したプロジェクトに対して `func start` を実行できるよう、**.NET 8 SDK**（または対象とするなら .NET 11 SDK）と **Azure Functions Core Tools v4** をローカルにインストールします。
- **トリガーとバインディングのパッケージ** を棚卸しします。`.csproj` を `Microsoft.Azure.WebJobs.Extensions` で grep し、それぞれを書き留めてください。対応する `Microsoft.Azure.Functions.Worker.Extensions.*` の置き換えが必要になります。
- **`ILogger` メソッドパラメーター** を受け取る関数と、**`IBinder` または `IAsyncCollector<T>`** を使う関数を棚卸しします。これらはアップグレードツールが完全には自動化できない手作業の編集を必要とします。
- **staging デプロイスロット** が利用可能であること、または作成できることを確認します。ランタイムの切り替えはプロダクション上でその場で行ってはいけません。
- いつものセーフティネットを用意します。クリーンなブランチ、グリーンのビルド、そして diff の基準にできる既知の良好なベースラインとして、in-process バージョンで通過するテストスイートです。
- 任意ですが推奨: **.NET Upgrade Assistant**（`dotnet tool install -g upgrade-assistant`）をインストールします。これは `.csproj`、`Program.cs`、属性、そして多くのシグネチャの変更を自動化します。その後、推論できなかったバインディングを手で修正します。

## 移行ステップ

以下の各ステップは検証行を伴う個別の変更です。順番に行ってください。最後が完了するまでプロジェクトはきれいにコンパイルされませんが、これは想定どおりです。

1. **`.csproj` の SDK とパッケージを変換します。** `Microsoft.NET.Sdk.Functions` への参照を削除し、ワーカーパッケージを追加し、`<OutputType>Exe</OutputType>` を追加します。前と後:

   ```xml
   <!-- BEFORE: in-process, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.NET.Sdk.Functions" Version="4.5.0" />
     </ItemGroup>
   </Project>
   ```

   ```xml
   <!-- AFTER: isolated worker, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
       <OutputType>Exe</OutputType>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
     </PropertyGroup>
     <ItemGroup>
       <FrameworkReference Include="Microsoft.AspNetCore.App" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Sdk" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore" Version="2.0.0" />
       <PackageReference Include="Microsoft.ApplicationInsights.WorkerService" Version="2.23.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.ApplicationInsights" Version="2.0.0" />
     </ItemGroup>
   </Project>
   ```

   代わりに .NET 11 を対象とするには、`<TargetFramework>net11.0</TargetFramework>` を設定します。`Microsoft.AspNetCore.App` への `FrameworkReference` は、HTTP トリガーが `IActionResult` を返し続けられるようにするものです。HTTP トリガーがなくても、ワーカーの起動を改善するので残してください。**検証:** `dotnet restore` が成功し、ワーカーパッケージを取得します。ビルドはまだコードで失敗しますが、それで問題ありません。

2. **各バインディング拡張パッケージを置き換えます。** 棚卸しした各 `Microsoft.Azure.WebJobs.Extensions.*` について、ワーカーの相当物に切り替えます。一般的なもの:

   ```text
   Microsoft.Azure.WebJobs.Extensions.Storage.Blobs
     -> Microsoft.Azure.Functions.Worker.Extensions.Storage.Blobs
   Microsoft.Azure.WebJobs.Extensions.ServiceBus
     -> Microsoft.Azure.Functions.Worker.Extensions.ServiceBus
   Microsoft.Azure.WebJobs.Extensions.CosmosDB
     -> Microsoft.Azure.Functions.Worker.Extensions.CosmosDB
   Microsoft.Azure.WebJobs.Extensions.EventHubs
     -> Microsoft.Azure.Functions.Worker.Extensions.EventHubs
   Microsoft.Azure.WebJobs.Extensions.DurableTask
     -> Microsoft.Azure.Functions.Worker.Extensions.DurableTask
   ```

   タイマートリガーは `Microsoft.Azure.Functions.Worker.Extensions.Timer` を明示的に追加する必要があります。`Microsoft.Azure.Functions.Extensions` は完全に削除してください。分離ワーカーは DI のスタートアップをネイティブに提供します。**検証:** `Microsoft.Azure.WebJobs.*` パッケージへの参照が 1 つも残っていないこと。`dotnet list package | Select-String WebJobs`（PowerShell）は何も出力しないはずです。

3. **`Program.cs` を追加し、`Startup.cs` を削除します。** 分離ワーカーはコンソールアプリであり、エントリポイントが必要です。`FunctionsStartup.Configure` のすべてを `ConfigureServices` へ移します:

   ```csharp
   // Program.cs -- .NET 8 / .NET 11, Microsoft.Azure.Functions.Worker 2.0.x
   using Microsoft.Azure.Functions.Worker;
   using Microsoft.Extensions.DependencyInjection;
   using Microsoft.Extensions.Hosting;

   var builder = FunctionsApplication.CreateBuilder(args);

   // ConfigureFunctionsWebApplication() opts into ASP.NET Core integration so HTTP
   // triggers can keep using HttpRequest / IActionResult. Use
   // ConfigureFunctionsWorkerDefaults() instead if you have no HTTP triggers.
   builder.ConfigureFunctionsWebApplication();

   builder.Services
       .AddApplicationInsightsTelemetryWorkerService()
       .ConfigureFunctionsApplicationInsights();

   // Everything that used to be in Startup.Configure goes here:
   builder.Services.AddHttpClient();
   builder.Services.AddSingleton<IOrderStore, OrderStore>();

   builder.Build().Run();
   ```

   その後、`[assembly: FunctionsStartup(typeof(Startup))]` 属性を持っていたクラスを削除します。**検証:** ファイルが単独でコンパイルされ、どこにも `FunctionsStartup` 属性が残っていないこと（`Select-String FunctionsStartup -Path **/*.cs`）。

4. **関数属性をリネームします。** `[FunctionName("X")]` が `[Function("X")]` になります。シグネチャは同一なので、これはプロジェクト全体で安全な文字列置換です。**検証:** `Select-String "FunctionName" -Path **/*.cs` が何も返さないこと。

5. **`ILogger` をパラメーターからコンストラクターへ移します。** in-process では関数メソッドに `ILogger log` パラメーターを受け取れました。分離ワーカーはコンストラクター注入を使います。影響を受ける各関数クラスをプライマリコンストラクターに変換します:

   ```csharp
   // BEFORE (in-process)
   public static class HttpTriggerCSharp
   {
       [FunctionName("HttpTriggerCSharp")]
       public static IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req,
           ILogger log)
       {
           log.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   ```csharp
   // AFTER (isolated worker, .NET 8 / .NET 11, C# 12+ primary constructor)
   public class HttpTriggerCSharp(ILogger<HttpTriggerCSharp> logger)
   {
       [Function("HttpTriggerCSharp")]
       public IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req)
       {
           logger.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   関数がもう `static` でなくなり、クラスももう `static` でなくなり、`ILogger` がメソッドシグネチャから離れたことに注意してください。**検証:** 関数クラスがコンパイルされ、どの関数メソッドにも `ILogger` パラメーターがもう残っていないこと。

6. **トリガーとバインディングの using と属性名を修正します。** `using Microsoft.Azure.WebJobs;` を削除し、`using Microsoft.Azure.Functions.Worker;` を追加します。トリガーは通常その名前を保ちます（`QueueTrigger` は `QueueTrigger` のまま）。入力バインディングは `Input` サフィックスを得て（`CosmosDB` は `CosmosDBInput` になる）、出力バインディングは `Output` サフィックスを得ます（`Queue` は `QueueOutput`、`Blob` は `BlobOutput` になる）。出力バインディングはパラメーターリストも離れます。単一の出力は戻り値型に乗り、複数の出力は小さな結果クラスのプロパティに乗ります。`IAsyncCollector<T>` を `T[]` の戻り値に置き換え、`IBinder` パラメーターは注入されたクライアントを優先して削除します。**検証:** `dotnet build` がゼロエラーで成功するようになること。

7. **`local.settings.json` を更新します。** ワーカーランタイムの値を変更します:

   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated"
     }
   }
   ```

   `host.json` への変更は必要ありません。**検証:** `func start` がアプリをローカルで起動し、関数が起動バナーにそのルートとともに表示されること。

## 検証

ビルドがグリーンになったら、Azure に近づく前にこのスモークテストを実行してください:

- `dotnet build` がゼロエラーとゼロの `Microsoft.Azure.WebJobs.*` 参照を返す。
- `func start` が起動し、各関数を正しいトリガーとルートとともに一覧表示する。
- 各 HTTP トリガーをローカルで叩き（`curl` またはテストクライアント）、in-process バージョンが返していたのと同じステータスコードとボディを確認する。
- 各非 HTTP トリガーを発火させる。blob を投下し、メッセージをキューに入れ、タイマーを刻ませる。関数が実行され、出力を書き込むことを確認する。
- `dotnet test` が通過する。ログ出力やシリアライザーの挙動についてアサートしていたテストは、両方ともずれる可能性があるので特に注意してください（gotcha を参照）。
- 前後で取得した Application Insights のトレースを比較する。ログのカテゴリが期待するレベルでまだ表示されることを確認する。消えていたら、`Program.cs` のログフィルタリングが欠けています。

## Azure でのロールアウトとロールバック

Azure 側は一緒に行わなければならない 2 つの変更です。`FUNCTIONS_WORKER_RUNTIME` を `dotnet-isolated` に設定することと、分離されたペイロードをデプロイすることです。片方だけが着地すると、デプロイされたコードが構成されたランタイムと一致しないため、アプリはエラー状態に陥ります。これをプロダクション上でその場で行わないでください。代わりに:

1. **staging デプロイスロット** を作成するか再利用します。
2. staging スロットで、アプリ設定 `FUNCTIONS_WORKER_RUNTIME` を `dotnet-isolated` に設定します。それをスロット設定として **マークしないでください**。.NET バージョンも変更した場合は、スロットのスタック構成も更新します。
3. 移行したプロジェクトを staging スロットに発行します。中間状態の間、スロットのログに一時的なエラーが見えます。止まるまで待ってください。
4. staging スロットを実際の Azure 依存関係に対してスモークテストします。エラーが収まり、挙動がプロダクションと一致することを確認します。
5. staging スロットをプロダクションへ **スワップ** します。スワップは単一のアトミックな更新として起こるので、プロダクションは壊れた中間状態を決して見ません。
6. プロダクションが健全であることを確認します。

**ロールバック:** in-process ビルドを保持している限り、これは完全に可逆です。元に戻すには、スロットを逆にスワップします。以前のプロダクションペイロード（まだ in-process）が 1 回の操作でプロダクションスロットへ戻ります。スワップはアトミックなので、ロールバックはロールアウトと同じワンクリックの動きです。新しいモデルが実トラフィックの下で少なくとも数日間こなれるまで、in-process ブランチとその最後の良好なアーティファクトを保持してください。移行が一方向になるのは、その in-process アーティファクトを削除した瞬間だけなので、初日には削除しないでください。

## 私たちが遭遇した gotcha

**ログが Application Insights から静かに消えます。** in-process モデルでは、`host.json` があなたのコードを含むすべてのログフィルタリングを制御していました。分離ワーカーでは、`host.json` は Functions ホストランタイムのみをフィルタリングします。アプリケーションのログは `Program.cs` のログ構成によってフィルタリングされます。移行して `Information` ログが消えたら、`host.json` がカバーすることを期待するのではなく、`Program.cs` に明示的なフィルタリングを追加してください。

**Newtonsoft に依存していた場合、HTTP レスポンスの形が変わります。** `IActionResult` を返していた in-process の HTTP トリガーは、多くのアプリが Newtonsoft のコントラクトリゾルバーで構成していたホストの MVC フォーマッター経由でシリアライズしていました。分離ワーカーはデフォルトで `System.Text.Json` を使います。JSON が突然別のケーシングを使ったり、カスタムコンバーターを失ったりしたら、ワーカーにシリアライザーを登録してください。そもそも Newtonsoft を残すべきか検討しているなら、[2026 年の System.Text.Json vs Newtonsoft.Json](/ja/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) を読んでください。

**サービスを注入していた Durable Functions のオーケストレーターが非決定的にリプレイし始めます。** in-process ホストの DI は十分に寛容で、オーケストレーター内でインスタンススコープのサービスを呼び出すことが偶然うまくいくことがありました。分離ワーカーでは同じコードがデッドロックしたり、非決定的にリプレイしたりすることがあります。修正は、in-process モデルが曲げることを許していた標準的な Durable のルールです。オーケストレーターはアクティビティ関数のみを呼び出し、副作用は注入されたサービスではなくアクティビティに住まわせます。

**デプロイ中にアプリが Azure で赤になりますが、これは正常です。** `FUNCTIONS_WORKER_RUNTIME` がまだ `dotnet`（またはその逆）のスロットに分離されたペイロードを初めてプッシュすると、スロットはエラー状態を報告します。これはドキュメントが警告する中間の不一致です。まさにそのためにロールアウトは staging スロット経由で行われ、設定とペイロードの両方が一致すると解消します。

**パラメーターリスト上の出力バインディングはコンパイルされません。** パッケージ切り替え後の最も一般的なビルドエラーは、まだ `out` または `IAsyncCollector<T>` パラメーターとして座っている出力バインディングです。それを戻り値型（単一出力）または結果クラス（複数出力）へ移してください。コンパイラーエラーはパラメーターを指しますが、修正は構造的なものであり、型キャストではありません。

## 関連

- [.NET 11 における Azure Functions 分離ワーカー vs in-process](/ja/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) は、完全な機能マトリックスとコールドスタートのベンチマークを備えた、このチェックリストの意思決定重視の相棒です。
- [.NET 8 から .NET 11 への移行: 完全チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) は、分離ワーカーに来てランタイムを前へ進めたくなったときの自然な次のステップです。
- [ASP.NET Core Minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、移行したワーカーで AOT を有効にしたときに出会う publish 設定と trim 警告を扱います。
- [Native AOT vs ReadyToRun vs 素の JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) には、「分離プラス AOT はコールドスタートで in-process を上回る」という主張の裏付けとなる数値があります。
- [.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は、Azure の外でも関数を実行する場合に、AOT のコールドスタートに関する助言の大部分を共有します。

## ソース

- Microsoft Learn, [C# アプリを in-process モデルから分離ワーカーモデルへ移行する](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-dotnet-to-isolated-model)。
- Microsoft Learn, [in-process モデルと分離ワーカーモデルの違い](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences)。
- Microsoft Learn, [C# Azure Functions を分離ワーカープロセスで実行するためのガイド](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide)。
- Azure updates, [in-process モデルのサポートは 2026 年 11 月 10 日に終了します](https://aka.ms/azure-functions-retirements/in-process-model)。
- Microsoft Learn, [Durable Functions を in-process から分離ワーカーモデルへ移行する](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-migrate)。
- NuGet 上の [`Microsoft.Azure.Functions.Worker`](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker)。

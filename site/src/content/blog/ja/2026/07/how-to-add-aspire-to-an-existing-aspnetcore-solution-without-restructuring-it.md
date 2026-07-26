---
title: "既存の ASP.NET Core ソリューションを作り直さずに Aspire を追加する方法"
description: "既存の ASP.NET Core ソリューションに Aspire 13.4 を追加します。新しいプロジェクト 2 つとサービスあたり 3 行だけで済ませる手順として、aspire init、AddProject と WithReference による AppHost の配線、既存の launchSettings.json と接続文字列の維持、そして初日にぶつかる resilience、ヘルスエンドポイント、プロキシの落とし穴を解説します。"
pubDate: 2026-07-26
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "opentelemetry"
  - "devops"
lang: "ja"
translationOf: "2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it"
translatedBy: "claude"
translationDate: 2026-07-26
---

既存の ASP.NET Core ソリューションに Aspire を追加するときは、何かを移動するのではなく、すでにあるプロジェクトの隣に新しいプロジェクトを 2 つ置くだけです。`AppHost` プロジェクトが開発時にサービスをオーケストレーションし、`ServiceDefaults` クラスライブラリが共有のテレメトリと resilience の設定を担い、既存の各サービスにはプロジェクト参照 1 つと `Program.cs` の 2 行が加わるだけです。フォルダー構成、名前空間、`launchSettings.json`、接続文字列、Dockerfile、CI パイプラインはすべてそのままで構いません。この記事では Aspire 13.4.6 (2026-06-20 に公開された現行の安定リリース) を .NET 10 および .NET 11 Preview 6 に対して使い、全体を通して解説します。

最初に見つかる記事と比べて、変わった点が 2 つあります。Aspire は 2025 年 11 月の Aspire 13 で名前から ".NET" を外しました。また `dotnet workload install aspire` という手順は Aspire 9.0 の時点ですでに消えています。現在はすべてが NuGet と MSBuild の SDK 経由で届くので、古い workload がまだマシンに残っているなら、まず `dotnet workload uninstall aspire` を実行してください。仕組みの前に概念を押さえたい場合は、以前の [Aspire とは何かという解説](/ja/2023/11/what-is-net-aspire/) が今も通用します。

## リポジトリに実際に増えるもの

API とワーカーを持つソリューションでの、正直な内訳です。

```
MyApp.sln
  src/MyApp.Api/            <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.Worker/         <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.AppHost/        <- new
  src/MyApp.ServiceDefaults/<- new
  aspire.config.json        <- new, points the CLI at the AppHost
```

プロジェクトの移動はありません。名前空間の変更もありません。`dotnet publish` がコンテナーイメージを生成する方法も変わりません。AppHost は開発時のオーケストレーターであり、デプロイ対象には含まれないからです。この最後の点は誤解されがちです。AppHost は production では動きません。ローカルでプロセスを起動し、設定を注入し、ダッシュボードにデータを供給するだけです。

## 既存ソリューションに Aspire を追加する手順

1. Aspire CLI をグローバルツールとしてインストールし、SDK を認識できていることを確認します。
2. ソリューションのルートで `aspire init` を実行し、`.sln` を検出させてプロジェクト形式の AppHost を生成します。
3. 起動させたい各サービスへのプロジェクト参照を AppHost に追加し、AppHost の `Program.cs` で `AddProject` を使ってそれらを宣言します。
4. 各サービスから `ServiceDefaults` を参照し、`AddServiceDefaults()` と `MapDefaultEndpoints()` を呼び出します。
5. 既存のインフラをモデル化します。ローカルで動かして構わないものはコンテナーに、外部のままにしなければならないものは `AddConnectionString` にします。
6. `aspire run` を実行し、各サービスが以前と同じエンドポイントで起動することを確認します。

この記事の残りは、この 6 手順のコードと、そのあとに壊れる箇所の話です。

## CLI のインストール

Aspire 13.3 以降、CLI は NativeAOT でコンパイルされた .NET グローバルツールとして配布されます。つまり workload も Visual Studio への依存も不要です。

```bash
dotnet tool install -g Aspire.Cli
aspire doctor
```

`aspire doctor` は 13.4 で追加されたもので、何よりも先に実行する価値があります。CLI のバージョン、認識できている SDK、そして何より、CLI のバージョンと `Aspire.AppHost.Sdk` のバージョンがずれていないかを表示します。この 2 つのバージョン不一致は、Aspire を使うリポジトリで「自分のマシンでは動いた」が発生する最大の原因です。

## AppHost の生成

`.sln` が置かれているディレクトリで実行します。

```bash
aspire init
```

`aspire init` はソリューションファイルを見つけると、プロジェクト形式の AppHost を作成してソリューションに追加します。見つからない場合 (たとえば多言語混在のリポジトリ) は、代わりに `#:sdk` と `#:package` ディレクティブを使う単一ファイルの `apphost.cs` を作成します。既存の ASP.NET Core ソリューションではプロジェクト形式が望ましいでしょう。生成される `Projects` 名前空間と、全サービスをまとめて扱える IDE 統合デバッグが手に入るのはこちらだからです。

CLI を使いたくない場合は、テンプレートが同じ仕事をします。

```bash
dotnet new aspire-apphost -o src/MyApp.AppHost
dotnet new aspire-servicedefaults -o src/MyApp.ServiceDefaults
dotnet sln add src/MyApp.AppHost src/MyApp.ServiceDefaults
```

AppHost のプロジェクトファイルは小さく、Aspire の SDK が現れる唯一の場所です。

```xml
<!-- src/MyApp.AppHost/MyApp.AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.4.6" />

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <IsAspireHost>true</IsAspireHost>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="13.4.6" />
  </ItemGroup>
</Project>
```

`TargetFramework` に注目してください。AppHost は起動対象のサービスより新しい TFM を指定できます。別プロセスとして起動するからです。サービスが `net8.0` に縛られているソリューションでも、AppHost だけ `net10.0` にできます。

## 既存プロジェクトの配線

AppHost からサービスへの参照を追加し、それらを宣言します。

```bash
dotnet add src/MyApp.AppHost reference src/MyApp.Api src/MyApp.Worker
```

```csharp
// src/MyApp.AppHost/Program.cs -- Aspire 13.4.6
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.MyApp_Worker>("worker")
    .WithReference(api)
    .WaitFor(api);

builder.Build().Run();
```

`Projects.MyApp_Api` 型は Aspire の SDK が `ProjectReference` 項目から生成するもので、ドットはアンダースコアに置き換えられます。自分で書く必要はなく、最初のビルドまでは存在しません。

ここからが、この手順を非侵襲的にしている部分であり、あまり文書化されていないところです。Aspire は既存の `Properties/launchSettings.json` を読み取ります。プロジェクトリソースを起動するときは、優先順位に従ってプロファイルを選びます。まず `launchProfileName` 引数を渡していればそれ、次に AppHost 自身の `DOTNET_LAUNCH_PROFILE` と名前が一致するプロファイル、次にファイル内の最初のプロファイル、最後にプロファイルなしです。選ばれたプロファイルの `applicationUrl` を解析して `ASPNETCORE_URLS` に変換し、そのプロファイルの `environmentVariables` はそのまま適用します。既存のプロファイルはそのまま機能します。あるサービスでファイルの先頭に "IIS Express" プロファイルがあり、Kestrel のほうを使いたい場合は、名前を明示してください。

```csharp
builder.AddProject<Projects.MyApp_Api>("api", launchProfileName: "https");
```

`launchProfileName: null` を渡すとプロファイルなしで起動します。意味のある `launchSettings.json` を持たないワーカーには、これがいちばんすっきりした選択肢です。

## サービスあたり 2 行

`ServiceDefaults` は `IsAspireSharedProject` が付いただけの、ごく普通のクラスライブラリです。各サービスから参照して呼び出します。

```csharp
// src/MyApp.Api/Program.cs -- ASP.NET Core on .NET 10 / .NET 11 Preview 6
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();   // <- added

builder.Services.AddControllers();
// ... everything you already had, untouched

var app = builder.Build();

app.MapDefaultEndpoints();      // <- added

app.MapControllers();
app.Run();
```

`AddServiceDefaults()` は 4 つの仕事をします。OpenTelemetry のログ、メトリクス、トレースを設定し (ヘルスチェックへのリクエストはトレースから除外されます)、liveness のヘルスチェックを登録し、サービスディスカバリーを登録し、`ConfigureHttpClientDefaults` を適用してすべての `HttpClient` に標準の resilience ハンドラーとサービスディスカバリーによる解決を与えます。`MapDefaultEndpoints()` は `/health` (すべてのチェックが通る必要があります) と `/alive` (`live` タグの付いたチェックのみ) をマップし、テンプレートはどちらも開発環境かどうかの判定で保護しています。

これらはいずれもランタイムで Aspire に依存しません。`AddServiceDefaults()` を呼ぶサービスは、AppHost の外でも、`dotnet run` でも、コンテナーの中でも、既存の Kubernetes デプロイでも問題なく動きます。単に `OTEL_EXPORTER_OTLP_ENDPOINT` が指す先へ OTLP テレメトリを送るだけで、その送り先は AppHost が起動した場合はダッシュボード、そうでない場合は本物のコレクターになります。まだコレクターがないなら、[無料の OpenTelemetry バックエンドの手順](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) がこのパイプの反対側をカバーしています。

## すでにあるインフラをモデル化する

既存プロジェクトがゼロから始めるチュートリアルともっとも食い違うのがここです。ああいったチュートリアルはたいてい、すべてをコンテナー化するところから始まります。しかし普通はそれができません。共有の開発用 SQL Server は理由があって共有されていますし、キューの中にはデータが入っています。

ローカルで動かして構わない依存関係については、統合を追加してコンテナーの管理を Aspire に任せます。

```bash
aspire add redis
```

```csharp
var cache = builder.AddRedis("cache");

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(cache)
    .WaitFor(cache);
```

`WithReference(cache)` は API のプロセスに `ConnectionStrings__cache` を注入します。既存の `builder.Configuration.GetConnectionString("cache")` の呼び出しは、そのまま変更なしにこの値を読み取ります。既定の構成では環境変数が `appsettings.json` より優先されるからです。仕掛けはこれだけです。Aspire は設定の読み方をコード側に変えさせるのではなく、より高い優先度で値を供給しているだけです。[HybridCache を Redis の L2 として使う](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) 場合も同じで、キャッシュリソースが接続文字列を供給し、残りの設定は変わりません。

外部のままにしなければならない依存関係には、`AddConnectionString` を使います。コンテナーではなく、AppHost 自身の構成に裏付けられたリソースが作られます。

```csharp
// Reads ConnectionStrings:orders from the AppHost's appsettings.json or user secrets
var orders = builder.AddConnectionString("orders");

builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(orders);
```

実際の値は `appsettings.json` ではなく、AppHost の user secrets に入れてください。

```bash
dotnet user-secrets --project src/MyApp.AppHost set "ConnectionStrings:orders" "Server=dev-sql;Database=Orders;..."
```

サービス側からは `ConnectionStrings__orders` が見えるようになり、それ以外は何も変わりません。AppHost が宣言していない名前をサービスが探しにいくと、[DefaultConnection という名前の接続文字列が見つからない](/ja/2026/05/fix-no-connection-string-named-defaultconnection/) で扱っているおなじみの起動失敗になります。`AddConnectionString` のリソース名は、コードが要求するキーと完全に一致していなければなりません。

サービス間の呼び出しも同じ扱いです。`WithReference(api)` は `services__api__https__0` と `services__api__http__0` を注入し、サービスディスカバリーが論理名を解決します。

```csharp
builder.Services.AddHttpClient<OrdersClient>(
    c => c.BaseAddress = new("https+http://api"));
```

`https+http://` は「HTTPS を優先し、なければ HTTP にフォールバックする」という意味です。これはサービスディスカバリーを登録したプロジェクトでしか解決されず、その登録は `AddServiceDefaults()` が行います。`AddServiceDefaults()` を飛ばしたプロジェクトでこのスキームを使うと、起動時ではなく最初のリクエストで `UriFormatException` が発生します。

## 実行する

```bash
aspire run
```

CLI は `aspire.config.json` から AppHost を見つけ、すべてのリソースを起動し、ダッシュボードの URL を表示します。Visual Studio や Rider では AppHost をスタートアッププロジェクトに設定して F5 を押すだけで、複数プロジェクトのスタートアップ構成はもう必要ありません。

2023 年ごろのガイドから来た人が驚く点があります。実際にコンテナーリソースを宣言していないかぎり、Docker を動かしておく必要はありません。`AddProject` の呼び出しだけで構成された AppHost は、コンテナーランタイムが一切インストールされていなくても起動します。おかげで最初のコミットは安全です。コンテナーリソースをゼロにして AppHost だけを入れ、ダッシュボードと分散トレースを手に入れたうえで、依存関係のコンテナー化はあとにする (あるいはしない) という選択ができます。

## 初日に壊れるもの

**標準の resilience ハンドラーが HTTP の挙動を変えます。** `AddServiceDefaults()` はプロセス内のすべての `HttpClient` にこれを適用します。つまりリトライ、サーキットブレーカー、リクエスト全体のタイムアウトが入ります。正当に 2 分かかるクライアントがある場合や、すでに手書きの Polly パイプラインがある場合、層が二重になります。自前のものを外すか、既定の適用範囲を絞るかしてください。両方を残してはいけません。

**ヘルスエンドポイントの重複。** すでに自分で `/health` をマップしているなら、`MapDefaultEndpoints()` によって同じルートに 2 つ目の登録が入ります。どちらか一方を選んでください。既定より詳しい出力が欲しい場合に何を残すかは、[minimal API にヘルスチェックエンドポイントを追加する解説](/ja/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) が扱っています。

**OpenTelemetry の二重登録。** `ServiceDefaults` の `ConfigureOpenTelemetry` は、すでに登録済みのものに追加される形で働きます。`Program.cs` に独自の `AddOpenTelemetry().WithTracing(...)` があると、計装が重複し、Serilog が絡んでいればログレコードも重複します。自分のほうを削除し、代わりに `ServiceDefaults` 側をカスタマイズしてください。共有プロジェクトはそのためにあります。

**エンドポイントは既定でプロキシされます。** Aspire は各エンドポイントの前にリバースプロキシを置くため、ブラウザーが叩くポートは Kestrel がバインドしたポートとは別です。外部の何かがポートを固定するまで、これは見えません。ID プロバイダーに登録した OIDC のリダイレクト URI、決済サンドボックスからの Webhook、モバイルクライアントにハードコードされた URL などがそれにあたります。エンドポイントごとに無効化できます。

```csharp
builder.AddProject<Projects.MyApp_Api>("api")
    .WithEndpoint("https", e => e.IsProxied = false);
```

**CI が AppHost をビルドするようになります。** `dotnet build MyApp.sln` は新しいプロジェクトを拾い、そのために NuGet から `Aspire.AppHost.Sdk` を復元する必要があります。パッケージの許可リストを明示している閉じたフィードではこれが失敗し、しかもエラーはパッケージ不足ではなく SDK の解決エラーとして出るため、診断に余計な時間がかかります。SDK とホスティング用パッケージを許可リストに入れるか、ソリューションフィルターで AppHost を CI のビルドから除外してください。それ以外にデプロイパイプラインを変える必要はありません。同じサービスプロジェクトを同じ方法で発行し続けるだけだからです。

**13.4 で Postgres を使っている場合:** 既定のイメージが 17.6 から 18.3 に上がり、既存の 17.x のデータボリュームにはアタッチできません。ローカルのデータが大事なら `WithImageTag` でタグを固定してください。

## 関連記事

- [.NET Aspire とは](/ja/2023/11/what-is-net-aspire/)：AppHost と統合の背後にある概念モデル。
- [ASP.NET Core 11 の minimal API にヘルスチェックエンドポイントを追加する方法](/ja/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/)：`MapDefaultEndpoints` が既存の実装と衝突する場合。
- [.NET 11 と無料バックエンドで OpenTelemetry を使う方法](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)：ダッシュボードの先でトレースがどこへ行くか。
- [Fix: 'DefaultConnection' という名前の接続文字列が見つからない](/ja/2026/05/fix-no-connection-string-named-defaultconnection/)：リソース名の不一致による失敗パターン。
- [Aspire 13.2 の isolated モードと AppHost の並列インスタンス](/ja/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/)：2 人の開発者、あるいは 2 つのブランチが同じ AppHost を同時に動かす必要がある場合。

## 参考資料

- [Add Aspire to an existing app](https://aspire.dev/get-started/add-aspire-existing-app/)、Aspire ドキュメント。
- [C# service defaults](https://aspire.dev/get-started/csharp-service-defaults/)、Aspire ドキュメント。
- [C# launch profiles in the Aspire AppHost](https://aspire.dev/integrations/dotnet/launch-profiles/)、Aspire ドキュメント。
- [External parameters and secrets in the AppHost](https://aspire.dev/fundamentals/external-parameters/)、Aspire ドキュメント。
- [Service discovery](https://aspire.dev/fundamentals/service-discovery/)、Aspire ドキュメント。
- [What's new in Aspire 13.3](https://aspire.dev/whats-new/aspire-13-3/) と [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/)、Aspire ドキュメント。
- [Aspire releases](https://github.com/microsoft/aspire/releases) (GitHub)：13.4.6 のバージョンと日付の出典。

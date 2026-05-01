---
title: ".NET Aspire 入門"
description: "プロジェクト構成、サービスディスカバリー、Aspire ダッシュボードを取り上げながら、初めての .NET Aspire アプリケーションを構築するための手順を解説します。"
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
この記事では、初めての .NET Aspire アプリケーションの構築手順を案内します。.NET Aspire の概要とその特徴を知りたい場合は、[What is .NET Aspire](/ja/2023/11/what-is-net-aspire/) の記事をご覧ください。

## Prerequisites

.NET Aspire を始める前に準備しておくべきものがいくつかあります。

-   Visual Studio 2022 Preview (バージョン 17.9 以上)
    -   .NET Aspire ワークロードがインストールされていること
    -   そして .NET 8.0
-   Docker Desktop

Visual Studio を使用したくない場合は、`dotnet workload install aspire` コマンドで dotnet CLI を使って .NET Aspire をインストールすることもできます。その後はお好みの IDE を自由に使用できます。

.NET Aspire の前提条件のインストール方法に関する包括的なガイドについては、[How to install .NET Aspire](/ja/2023/11/how-to-install-net-aspire/) をご覧ください。

## Create new project

Visual Studio で **File** > **New** > **Project** に移動し、プロジェクトの種類のドロップダウンで **.NET Aspire** を選択するか、"Aspire" という単語を検索します。次の 2 つのテンプレートが表示されるはずです。

-   **.NET Aspire Application** -- 空の .NET Aspire プロジェクトテンプレート。
-   **.NET Aspire Starter Application** -- Blazor フロントエンド、API バックエンドサービス、そしてオプションで Redis を使ったキャッシュを含む、より包括的なプロジェクトテンプレート。

最初の .NET Aspire アプリには **.NET Aspire Starter Application** テンプレートを選択します。

[![フィルタリングされた .NET Aspire プロジェクトテンプレートのリストを表示する Visual Studio の新規プロジェクト作成ダイアログ。](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

プロジェクトに名前を付け、**Additional information** ダイアログで **Use Redis for caching** オプションを有効にしてください。これは完全にオプションですが、.NET Aspire ができることの良い例として役立ちます。

[![オプションの Use Redis for caching (Docker 必須) を備えた .NET Aspire Starter Application プロジェクトテンプレートの追加情報ダイアログ。](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

### Using dotnet CLI

dotnet CLI を使って .NET Aspire アプリを作成することもできます。.NET Aspire Starter Application テンプレートを使ってアプリを作成するには、次のコマンドを使用し、`Foo` を希望のソリューション名に置き換えてください。

```bash
dotnet new aspire-starter --use-redis-cache --output Foo
```

## Project structure

.NET Aspire ソリューションが作成されたので、その構成を見てみましょう。ソリューションには 4 つのプロジェクトがあるはずです。

-   **ApiService**: フロントエンドがデータを取得するために使用する ASP.NET Core API プロジェクト。
-   **AppHost**: .NET Aspire アプリケーションのさまざまなプロジェクトとサービスを接続・構成することでオーケストレーターとして機能します。
-   **ServiceDefaults**: 回復力、サービスディスカバリー、テレメトリーに関連する構成を管理するために使用される共有プロジェクト。
-   **Web**: フロントエンドとして機能する Blazor アプリケーション。

プロジェクト間の依存関係は次のようになります。

[![.NET Aspire Starter Application のプロジェクト依存関係グラフ。AppHost が最上位にあり、ApiService と Web に依存し、両者は ServiceDefaults に依存しています。](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

上から始めましょう。

## AppHost project

これは私たちの .NET Aspire ソリューションのオーケストレータープロジェクトです。その役割は、.NET Aspire アプリケーションのさまざまなプロジェクトとサービスを接続・構成することです。

その `.csproj` ファイルを見てみましょう。

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsAspireHost>true</IsAspireHost>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="..\Foo.ApiService\Foo.ApiService.csproj" />
    <ProjectReference Include="..\Foo.Web\Foo.Web.csproj" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting" Version="8.0.0-preview.1.23557.2" />
  </ItemGroup>

</Project>
```

2 つの点が目立ちます。

-   `IsAspireHost` 要素は、このプロジェクトをソリューションのオーケストレーターとして明示的にマークします
-   `Aspire.Hosting` パッケージ参照。このパッケージには、.NET Aspire アプリケーションモデルのコア API と抽象化が含まれています。フレームワークはまだプレビュー段階にあるため、.NET Aspire NuGet パッケージもプレビューリリースとしてマークされています。

次に `Program.cs` を見てみましょう。さまざまなプロジェクトを接続し、キャッシュを有効にするために使用される、非常になじみのあるビルダーパターンに気付くでしょう。

```cs
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedisContainer("cache");

var apiservice = builder.AddProject<Projects.Foo_ApiService>("apiservice");

builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(apiservice);

builder.Build().Run();
```

上のコードが本質的に行うことは次のとおりです。

-   `DistributedApplication` を構築するために使用される `IDistributedApplicationBuilder` のインスタンスを作成します
-   後でプロジェクトとサービスから参照できる `RedisContainerResource` を作成します
-   `ApiService` プロジェクトをアプリケーションに追加し、`ProjectResource` のインスタンスを保持します
-   `Web` プロジェクトをアプリケーションに追加し、Redis キャッシュと `ApiService` を参照します
-   最後に `Build()` を呼び出して `DistributedApplication` インスタンスを構築し、`Run()` を呼び出して実行します。

## ApiService project

`ApiService` プロジェクトは `/weatherforecast` エンドポイントを公開しており、私たちの `Web` プロジェクトから利用できます。API を利用可能にするため、`AppHost` プロジェクトに登録し、`apiservice` という名前を付けました。

```cs
builder.AddProject<Projects.Foo_ApiService>("apiservice")
```

## Web project

`Web` プロジェクトは Blazor フロントエンドを表し、`ApiService` が公開する `/weatherforecast` エンドポイントを利用します。その方法こそが、.NET Aspire の魔法が本格的に発揮される場所です。

型付きの `HttpClient` を使用していることに気付くでしょう。

```cs
public class WeatherApiClient(HttpClient httpClient)
{
    public async Task<WeatherForecast[]> GetWeatherAsync()
    {
        return await httpClient.GetFromJsonAsync<WeatherForecast[]>("/weatherforecast") ?? [];
    }
}
```

ここで `Program.cs` を見ると、14 行目に興味深い記述があります。

```cs
builder.Services.AddHttpClient<WeatherApiClient>(client =>
    client.BaseAddress = new("http://apiservice"));
```

`ApiService` プロジェクトを `DistributedApplication` の `ProjectResource` として追加するときに `apiservice` という名前を付けたことを覚えていますか? この行で、型付きの `WeatherApiClient` がサービスディスカバリーを使用し、`apiservice` という名前のサービスに接続するように構成されます。`http://apiservice` は、追加の構成なしで、`ApiService` リソースの正しいアドレスに自動的に解決されます。

## ServiceDefaults project

`AppHost` プロジェクトと同様に、共有プロジェクトも特別なプロジェクトプロパティで区別されます。

```xml
<IsAspireSharedProject>true</IsAspireSharedProject>
```

このプロジェクトは、回復力、サービスディスカバリー、テレメトリーに関して、すべての異なるプロジェクトとサービスが同じ方法でセットアップされることを保証します。これは、ソリューションのプロジェクトやサービスがそれぞれの `IHostApplicationBuilder` インスタンス上で呼び出せる一連の拡張メソッドを公開することで実現されています。

## Run the project

プロジェクトを実行するには、`AppHost` をスタートアッププロジェクトとして設定し、Visual Studio で run (F5) を押してください。あるいは、コマンドラインから `dotnet run --project Foo/Foo.AppHost` でプロジェクトを実行することもできます (`Foo` は実際のプロジェクト名に置き換えてください)。

アプリケーションが起動すると、.NET Aspire ダッシュボードが表示されます。

[![.NET Aspire Starter Application プロジェクトテンプレートを実行している .NET Aspire ダッシュボード。](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

ダッシュボードでは、.NET Aspire アプリケーションのさまざまな部分 (プロジェクト、コンテナー、実行可能ファイル) を監視できます。また、サービスの集約された構造化ログ、リクエストトレース、その他のさまざまな有用なメトリクスも提供します。

[![.NET Aspire ダッシュボード内のリクエストトレース。リクエストがさまざまなアプリケーションコンポーネントを通過するときの段階を示しています。](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)

これで完了です! 初めての .NET Aspire アプリケーションの構築と実行、おめでとうございます!

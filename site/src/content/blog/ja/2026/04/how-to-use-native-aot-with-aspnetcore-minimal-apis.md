---
title: "ASP.NET Core minimal API で Native AOT を使う方法"
description: "ASP.NET Core minimal API を Native AOT で出荷するための完全な .NET 11 ウォークスルー。PublishAot、CreateSlimBuilder、ソースジェネレーター製の JSON、AddControllers の制約、IL2026 / IL3050 警告、ライブラリプロジェクト向けの EnableRequestDelegateGenerator までを扱います。"
pubDate: 2026-04-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "native-aot"
lang: "ja"
translationOf: "2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis"
translatedBy: "claude"
translationDate: 2026-04-29
---

.NET 11 で ASP.NET Core minimal API を Native AOT で出荷するには、`.csproj` に `<PublishAot>true</PublishAot>` を入れ、host を `CreateBuilder` ではなく `WebApplication.CreateSlimBuilder` で構築し、`ConfigureHttpJsonOptions` を通じて `JsonSerializerContext` ソースジェネレーターを登録して、すべてのリクエストおよびレスポンスの型に reflection なしで到達できるようにします。minimal API か gRPC でないもの、つまり `AddControllers`、Razor、SignalR hubs、POCO グラフに対する EF Core のクエリツリーなどはすべて、publish 時に IL2026 や IL3050 の警告を出し、runtime では予測不能な振る舞いをします。本ガイドは `Microsoft.NET.Sdk.Web` 上で .NET 11 SDK と C# 14 を用いたフルパスを歩み、新規プロジェクトテンプレートが隠しているところまで含めて扱い、最後に公開された binary が実際に JIT を必要としないことを確認するためのチェックリストで締めます。

## すべてを変える 2 つのプロジェクトフラグ

Native AOT の minimal API は、MSBuild プロパティを 2 つ追加した普通の ASP.NET Core プロジェクトです。1 つ目は publish パスを CoreCLR から AOT コンパイラ ILC へ切り替えます。2 つ目は、runtime のコード生成を必要とする API に手を伸ばした瞬間にビルドを失敗させるよう analyzer に伝えます。

```xml
<!-- .NET 11, C# 14 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>

    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
</Project>
```

`PublishAot` は重い仕事をします。`dotnet publish` 中に Native AOT コンパイルを有効化し、加えて重要なのは、ビルド中と編集中に動的コード分析もオンにする点で、IL2026(`RequiresUnreferencedCode`)と IL3050(`RequiresDynamicCode`)の警告が publish に至る前に IDE で点灯するようにします。Microsoft の[Native AOT デプロイの概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)で文書化されています。

`InvariantGlobalization` は厳密には必須ではありませんが、新規プロジェクトでは有効にしておきます。Native AOT は Linux で既定では ICU のデータファイルを同梱せず、リクエストペイロードに対して culture-aware な文字列比較を行うと、忘れていれば本番で `CultureNotFoundException` を投げます。globalization は本当に必要なときに明示的に出荷してください。

新規プロジェクトテンプレート(`dotnet new webapiaot`)はあなたのために `<StripSymbols>true</StripSymbols>` と `<TrimMode>full</TrimMode>` も追加します。`TrimMode=full` は `PublishAot=true` に含意されるので冗長ですが、置いておいても害はありません。

## CreateSlimBuilder は名前を短くした CreateBuilder ではない

通常の minimal API と AOT の minimal API の最大の挙動差は host builder です。`WebApplication.CreateBuilder` は ASP.NET Core の一般的な機能を全部配線します: HTTPS、HTTP/3、hosting filters、ETW、環境変数ベースの設定プロバイダ、reflection ベースのフォールバックを行う既定の JSON シリアライザ。それらの多くは Native AOT 互換ではないため、AOT テンプレートは [ASP.NET Core の Native AOT サポート](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)で文書化され、.NET 11 で変更のない `CreateSlimBuilder` を使います。

```csharp
// .NET 11, C# 14
// PackageReference: Microsoft.AspNetCore.OpenApi 11.0.0
using System.Text.Json.Serialization;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

var app = builder.Build();

var todos = app.MapGroup("/todos");
todos.MapGet("/", () => Todo.Sample);
todos.MapGet("/{id:int}", (int id) =>
    Todo.Sample.FirstOrDefault(t => t.Id == id) is { } t
        ? Results.Ok(t)
        : Results.NotFound());

app.Run();

public record Todo(int Id, string Title, bool Done)
{
    public static readonly Todo[] Sample =
    [
        new(1, "Try Native AOT", true),
        new(2, "Profile cold start", false),
    ];
}

[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
internal partial class AppJsonContext : JsonSerializerContext;
```

このサンプルで重要で見落としやすい三点:

1. `CreateSlimBuilder` は HTTPS や HTTP/3 を既定では登録しません。slim builder は `appsettings`、user secrets、コンソール logging、logging 設定のための JSON ファイル設定は含みますが、TLS 終端プロキシが扱うのが普通のプロトコルは意図的に外しています。Nginx、Caddy、YARP のようなものを前段に置かずにこれを動かすなら、`Kestrel.Endpoints` 設定を明示的に追加してください。
2. `MapGroup("/todos")` は `Program.cs` と同じファイルにあるなら大丈夫です。同じプロジェクトの別ファイルへ移動すると、リクエストデリゲートジェネレーターも有効化しない限り IL3050 が出始めます。これはすぐ後で扱います。
3. JSON context はリゾルバーチェーンのインデックス `0` に挿入されるため、reflection ベースの既定リゾルバーよりも優先されます。`Insert(0, ...)` がないと、ASP.NET Core のレスポンスライターは未登録の型に対して reflection にフォールバックすることがあり、AOT モードの runtime で `NotSupportedException` を生みます。

## JSON: 唯一のシリアライザは生成したもの

`System.Text.Json` には 2 つのモードがあります。reflection モードはランタイムですべてのプロパティを巡回するので、trimming にも AOT にも非互換です。ソース生成モードは登録した各型に対してビルド時にメタデータを emit するので、完全に AOT 安全です。Native AOT は HTTP リクエストボディに入れる、または取り出すすべての型に対してソース生成を要求します。これが「ビルドはきれい、runtime で投げる」バグの最大の供給源です。

最小限の `JsonSerializerContext`:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Todo))]
[JsonSerializable(typeof(Todo[]))]
[JsonSerializable(typeof(List<Todo>))]
[JsonSerializable(typeof(ProblemDetails))]
internal partial class AppJsonContext : JsonSerializerContext;
```

線上を流れる型はすべてこのクラスに置く必要があります。minimal API のエンドポイントから実際に返す `T[]` や `List<T>` の形も含みます。ASP.NET Core のレスポンスライターは AOT モードでは `IEnumerable<T>` をあなたのために unwrap しません。`Enumerable.Range(...).Select(...)` を返すなら、`IEnumerable<Todo>` も登録するか、最初に配列にマテリアライズしてください。

注意深い著者でも噛まれる三つの罠:

- **`Results.Json(value)` 対 `return value`**: 値を直接返すのは、framework が静的な戻り型を知っているので機能します。`Results.Json(value)` でラップして `JsonTypeInfo<T>` を渡さないと既定のシリアライザにフォールバックし、AOT の runtime で投げる可能性があります。生成済み context から `JsonTypeInfo<T>` を取る `Results.Json` のオーバーロードを使うか、単に値を返してください。
- **多態性**: `[JsonDerivedType(typeof(Cat))]` は AOT で動きますが、基底型および各派生型は context に置かれている必要があります。素の `object` 戻りには `JsonSerializable(typeof(object))` の登録が必要で、それが見られるすべての形を強制してしまうので、具体型を選んでください。
- **`IFormFile` と `HttpContext.Request.ReadFromJsonAsync`**: プリミティブのフォームパラメータバインドは AOT で動きますが、context なしの `ReadFromJsonAsync<T>()` は投げます。第 2 引数として常に `AppJsonContext.Default.T` を渡してください。

Andrew Lock の[minimal API ソースジェネレーターの紹介](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/)と Martin Costello の[minimal API での JSON ソースジェネレーター](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/)が、.NET 11 が変更なしに継承した .NET 8 の元設計を扱っています。

## ライブラリプロジェクトには EnableRequestDelegateGenerator が必要

minimal API のソースジェネレーターは、各 `MapGet(...)`、`MapPost(...)` などをコンパイル時に強く型付けされた `RequestDelegate` に変えます。`PublishAot=true` のとき、SDK はそのジェネレーターを Web プロジェクトに対しては自動的に有効化します。あなたが参照するライブラリプロジェクトに対しては、それらのライブラリが拡張メソッド経由で `MapGet` を呼んでいたとしても、**有効化しません**。

症状は publish 時の IL3050 警告で、ライブラリを指して `MapGet` がデリゲートに対して reflection をしていると不平を言います。修正はライブラリの 1 つの MSBuild プロパティです:

```xml
<!-- Library project that defines endpoint extension methods -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <IsAotCompatible>true</IsAotCompatible>
    <EnableRequestDelegateGenerator>true</EnableRequestDelegateGenerator>
  </PropertyGroup>
</Project>
```

`IsAotCompatible=true` は trim と AOT のアナライザ 4 つを有効化し、`EnableRequestDelegateGenerator=true` はライブラリの `Map*` 呼び出しを生成パスに切り替えます。後者がないと、ライブラリは AOT 互換とマークされていても、analyzer が `RouteHandlerBuilder` 内の `Delegate.DynamicInvoke` 風のコールサイトをそう見るために IL3050 を emit することがあります。dotnet/aspnetcore チームは [issue #58678](https://github.com/dotnet/aspnetcore/issues/58678) で粗いエッジを追跡しています。

ライブラリが AOT・非 AOT の両プロジェクトで再利用可能であるべきなら、プロパティは残してください。ジェネレーターは通常の CoreCLR ビルドでは runtime パスへ穏やかにフォールバックします。

## 諦めなければならないもの

Native AOT は完成した MVC モノリスでオンにするスイッチではありません。サポートされない subsystem のリストは短いものの、構造を支えています。

- **MVC コントローラー**: `AddControllers()` は典型例です。API は trim-safe ではなく、Native AOT ではサポートされません。dotnet/aspnetcore チームは [issue #53667](https://github.com/dotnet/aspnetcore/issues/53667) で長期サポートを追跡していますが、.NET 11 時点では `[ApiController]` を付けたクラスに AOT パスはありません。endpoint を minimal API に書き換えるか、AOT を出荷しないかのどちらかです。モデルとフィルターは ILC が安全にトリムするには reflection と runtime model binding に頼りすぎています。
- **Razor Pages と MVC View**: 同じ理由。両方とも runtime のビューコンパイルに依存します。使わなければ `PublishAot=true` でビルドできますが、`AddRazorPages()` を登録すると IL2026 が点灯します。
- **SignalR のサーバーサイド hub**: .NET 11 では AOT 下でサポートされません。クライアントパッケージには AOT-friendly モードがありますが、hub host にはありません。
- **EF Core**: runtime は動きますが、POCO のプロパティグラフに対する reflection に依存するクエリ変換は、compiled queries とソース生成の構成にオプトインしない限り IL2026 を生むことがあります。多くの AOT サービスでは、Dapper と手書きの `SqlClient` セットアップ、または `DbSet<T>.Find()` 程度の単純なアクセスに限定した EF Core が正解です。
- **reflection 重めの DI パターン**: スキャンしたアセンブリから `IEnumerable<IPlugin>` を解決するようなものは trimming 下で脆いです。具体型を明示的に登録するか、ソース生成型の DI コンテナを使ってください。
- **`AddOpenApi()`**: .NET 9 の OpenAPI 統合は AOT 互換ですが、AOT 対応リファクタ前の `Swashbuckle.AspNetCore` のバージョンはまだ IL2026 を emit します。AOT minimal API で OpenAPI が必要なら、組み込みの [`Microsoft.AspNetCore.OpenApi`](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi) パッケージを使い、Swashbuckle はスキップしてください。

Thinktecture チームが[サポート済み・未サポートのシナリオの読みやすい概要](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/)を公開しており、チームを Native AOT にオンボーディングするときに参照しています。

## IL2026 と IL3050 をプロのように読む

戦うことになる 2 つの警告は混同しやすいです:

- **IL2026** は呼び出しが参照されないコードを必要とすることを意味します。実装が trimmer によって取り除かれるはずの member を reflection で読んでいます。よくある原因: runtime の `Type` をシリアライザのオーバーロードに渡す、`GetProperties()` を呼ぶ、`Activator.CreateInstance(Type)` を使う。
- **IL3050** は呼び出しが動的コード生成を必要とすることを意味します。すべての member が保持されていても、実装は AOT に存在しない `Reflection.Emit` 相当の JIT 時 codegen ステップを必要とします。よくある原因: `JsonSerializer.Serialize(object)` のオーバーロード、まだインスタンス化されていない generic に対する `MakeGenericType`、式木のコンパイル。

両方とも `IsAotCompatible` analyzer によって表面化しますが、trimming analyzer 単独では IL2026 のみ表示されます。私は開発中、これらを一気に出すために、コマンドラインから `bin\publish` への単発 publish を常に実行します:

```bash
dotnet publish -c Release -r linux-x64 -o ./publish
```

もう一つの落とし穴: dotnet/sdk [discussion #51966](https://github.com/dotnet/sdk/discussions/51966) は、Visual Studio 2026 と `dotnet build` が一部の構成で IL2026 / IL3050 を飲み込むが `dotnet format` は表示する、という再発する問題を追跡しています。チームが Visual Studio を使うなら、AOT runtime に対して `dotnet publish` を走らせる CI ステップを追加して、見落とされた警告がパイプラインを落とすようにしてください。

reflection を使う API を避けられない場合、ラップするメソッドに `[RequiresUnreferencedCode]` と `[RequiresDynamicCode]` 属性を付けてコールサイトの警告を抑え、要件を上方向に伝播させられます。これは消費側のコードパスが AOT publish の表面に乗っていないと分かっているときだけ行ってください。エンドポイントハンドラー内での抑制はほとんど常に間違いです。

## binary が実際に動くことを検証する

クリーンな publish はアプリが AOT 下で起動することを証明しません。勝利を宣言する前に行う 3 つのチェック:

```bash
# 1. The output is a single static binary, not a CoreCLR loader.
ls -lh ./publish
file ./publish/MyApi
# Expected on Linux: "ELF 64-bit LSB pie executable ... statically linked"

# 2. The runtime never loads the JIT.
LD_DEBUG=libs ./publish/MyApi 2>&1 | grep -E "libcoreclr|libclrjit"
# Expected: empty output. If libclrjit.so loads, you accidentally shipped a runtime fallback.

# 3. A real request round-trips with the source generator.
./publish/MyApi &
curl -s http://localhost:5000/todos | head -c 200
```

3 つ目のチェックが重要です。古典的な失敗モードは「ビルドし、publish し、起動し、最初のリクエストで 500 を返す」です。戻り型が JSON context から欠けているからです。出荷前に各エンドポイントを少なくとも一度は代表的なペイロードで叩いてください。

コンテナデプロイでは、`PublishAot=true` 下で `--self-contained true` のビルドが暗黙です。出力 `./publish/MyApi` とその `.dbg` ファイルがデプロイ単位の全体です。典型的な .NET 11 minimal API は stripped で 8-12 MB に収まり、self-contained CoreCLR publish の 80-90 MB と比較されます。

## Start Debugging の関連ガイド

- Native AOT のレバーはより広いコールドスタートの物語の中にあります: [.NET 11 AWS Lambda コールドスタートのプレイブック](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は同じソースジェネレーター設定で AOT-on-`provided.al2023` のパスを歩みます。
- AOT minimal API の上の OpenAPI については、[OpenAPI クライアント生成ガイド](/ja/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) が minimal API メタデータから型付き `HttpClient` への往復をカバーしています。
- AOT プロジェクトは reflection ベースの JSON を禁じるので、[System.Text.Json でカスタム `JsonConverter` を書く](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) は組み込みの変換が足りないときの正しい入門です。
- AOT 下では reflection ベースの診断が利用できないので、きれいな例外の物語はより重要になります: [ASP.NET Core 11 でグローバル例外フィルタを追加する](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) は完全に AOT 互換な `IExceptionHandler` パスを示します。

## 出典

- [ASP.NET Core support for Native AOT (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot?view=aspnetcore-10.0)
- [Native AOT deployment overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/)
- [Source generation in System.Text.Json (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- [aspnetcore#58678 - Map* AOT warnings outside Program.cs](https://github.com/dotnet/aspnetcore/issues/58678)
- [aspnetcore#53667 - Native AOT support for MVC](https://github.com/dotnet/aspnetcore/issues/53667)
- [Andrew Lock - Exploring the new minimal API source generator](https://andrewlock.net/exploring-the-dotnet-8-preview-exploring-the-new-minimal-api-source-generator/)
- [Martin Costello - Using JSON source generators with minimal APIs](https://blog.martincostello.com/using-json-source-generators-with-aspnet-core-minimal-apis/)
- [Thinktecture - Native AOT with ASP.NET Core, an overview](https://www.thinktecture.com/en/net/native-aot-with-asp-net-core-overview/)

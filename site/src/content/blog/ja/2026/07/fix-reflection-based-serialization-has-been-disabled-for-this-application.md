---
title: "解決: Reflection-based serialization has been disabled for this application"
description: "この InvalidOperationException は、PublishTrimmed または PublishAot が JsonSerializerIsReflectionEnabledByDefault を false にしたことを意味します。生成された JsonSerializerContext で解決します。"
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "trimming"
  - "native-aot"
lang: "ja"
translationOf: "2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application"
translatedBy: "claude"
translationDate: 2026-07-29
---

あなたのプロジェクトでは `PublishTrimmed` または `PublishAot` が `true` になっており、.NET SDK はそれに応じて `JsonSerializerIsReflectionEnabledByDefault` を `false` に設定しました。これにより、`JsonSerializer.Serialize(obj)` が暗黙のうちに依存しているリフレクションベースのコントラクトリゾルバーが無効になります。解決策は、シリアライザーにコントラクトの供給元を与えることです。`JsonSerializerContext` を継承する `partial class` を追加し、`[JsonSerializable(typeof(YourType))]` を付け、すべての呼び出し箇所で `MyContext.Default.YourType` を渡す（または `options.TypeInfoResolver = MyContext.Default` を設定する）だけです。

```text
System.InvalidOperationException: Reflection-based serialization has been disabled for this application. Either use the source generator APIs or explicitly configure the 'JsonSerializerOptions.TypeInfoResolver' property.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_JsonSerializerIsReflectionDisabled()
   at System.Text.Json.JsonSerializerOptions.ConfigureForJsonSerializer()
   at System.Text.Json.JsonSerializerOptions.GetTypeInfoForRootType(Type type, Boolean fallBackToNearestAncestorType)
   at System.Text.Json.JsonSerializer.Serialize[TValue](TValue value, JsonSerializerOptions options)
   at MyApp.Program.Main(String[] args)
```

この文字列は `System.Text.Json` の `JsonSerializerIsReflectionDisabled` リソースそのもので、.NET 8 以来同じ表現のままです。以下の内容は .NET 11 SDK（`11.0.100`）と C# 14 を対象としていますが、このスイッチが導入されたのは .NET 8 なので、`net8.0` 以降では挙動は同一です。

## 設定した覚えのないプロジェクトでリフレクションが無効になっている理由

`System.Text.Json` が型の形状を解決する方法は 2 つあります。実行時にリフレクションで解決する方法（`DefaultJsonTypeInfoResolver`）と、コンパイル時にソースジェネレーターで解決する方法（`JsonSerializerContext`）です。オプションなしで `JsonSerializer.Serialize(obj)` を呼ぶと、リフレクション側のリゾルバーにフォールバックします。

リフレクションはトリミングを生き残れません。トリマーは到達可能だと静的に証明できないメンバーを削除しますが、`PropertyInfo` 経由でしか呼ばれないプロパティのゲッターはまさにそれ、静的解析からは到達不能です。.NET 8 より前は、トリミングされたアプリは平然とシリアライズを行い、トリマーが削除したプロパティを黙って落としていました。データの静かな欠落はクラッシュより厄介なので、.NET 8 で既定値が変更されました。`PublishTrimmed` を `true` にすると、明示的に指定しない限り [`JsonSerializerIsReflectionEnabledByDefault` が自動的に `false` になります](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed)。`PublishAot` は `PublishTrimmed` を含意するため、Native AOT アプリも同じ既定値を受け継ぎます。

MSBuild プロパティは仕組みそのものではなく、単なるスイッチです。SDK はこれをランタイムホストの構成オプションに変換します。

```xml
<!-- Microsoft.NET.Sdk.targets, .NET 11 SDK -->
<RuntimeHostConfigurationOption Include="System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault"
                                Condition="'$(JsonSerializerIsReflectionEnabledByDefault)' != ''"
                                Value="$(JsonSerializerIsReflectionEnabledByDefault)"
                                Trim="true" />
```

これが `AppContext` スイッチとして `.runtimeconfig.json` に書き出されます。`Trim="true"` は ILLink にこれをリンク時定数として扱うよう指示するもので、これによりリフレクション側のコードパスを丸ごと削除できます。`JsonSerializer.IsReflectionEnabledByDefault` はこのスイッチを読み、[未設定の場合は既定で `true` になります](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault)。

ここから 2 つの帰結が導かれ、混乱したバグ報告の大半はこれで説明がつきます。1 つ目、このスイッチはアプリ単位であってライブラリ単位ではありません。NuGet パッケージがあなたの代わりに無効化することはできませんし、あなたが特定のアセンブリだけ有効にすることもできません。2 つ目、例外は起動時ではなく最初の使用時に発生します。`JsonSerializerOptions.Default` はリフレクションリゾルバーではなく `JsonTypeInfoResolver.Empty` で構築され、`ConfigureForJsonSerializer` はシリアライズまたはデシリアライズの呼び出しが空のリゾルバーに行き当たったときにだけ例外を投げます。つまり、週に一度しか通らないコードパスで発覚することになります。

## 最小の再現

プロジェクトファイル 3 行と C# 1 行です。

```xml
<!-- MyApp.csproj, .NET 11 SDK 11.0.100 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var json = JsonSerializer.Serialize(new { Value = 42 });
// System.InvalidOperationException: Reflection-based serialization has been disabled...
```

`PublishTrimmed` をどこに置くかに注目してください。このプロパティは**ビルド**時点で `runtimeconfig.json` に流れ込むため、プロジェクトファイルに書けば Debug 構成の `dotnet run` でも例外が出ます。逆に publish のコマンドラインでのみ渡した場合（`dotnet publish -p:PublishTrimmed=true`）、ローカルの `dotnet run` は動き続け、発行された成果物だけが失敗します。本番に到達するのはこちらのパターンです。トリミングのドキュメントがプロジェクトファイルを推奨しているのは、[まさに `dotnet build` の時点でも設定を効かせるため](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options)です。

自分が見ているのが本当にこれで他の問題ではないと確認するには、ビルド出力を見てください。

```bash
cat bin/Debug/net11.0/MyApp.runtimeconfig.json
```

```json
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "configProperties": {
      "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": false
    }
  }
}
```

あるいはコードから確認します。こちらは runtimeconfig ファイルを読めない Native AOT でも使えます。

```csharp
// .NET 11, C# 14
Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault); // False
```

## 解決策 1: JsonSerializerContext を用意してどこでもそれを使う

これはエラーメッセージが求めている解決策であり、本当にトリミング安全なアプリを残せる唯一の方法です。partial なコンテキストを宣言し、シリアライズするルート型をすべて列挙し、呼び出しをそこ経由にします。

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0
using System.Text.Json;
using System.Text.Json.Serialization;

public record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WeatherForecast))]
[JsonSerializable(typeof(List<WeatherForecast>))]
internal partial class AppJsonContext : JsonSerializerContext;
```

そのうえで、サポートされている 3 つの呼び出し形式のいずれかを選びます。

```csharp
// .NET 11, C# 14
// 1. Strongly typed, zero options plumbing. Preferred.
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);
WeatherForecast? back = JsonSerializer.Deserialize(json, AppJsonContext.Default.WeatherForecast);

// 2. Through options, when an API forces you to hand it a JsonSerializerOptions.
var options = new JsonSerializerOptions { TypeInfoResolver = AppJsonContext.Default };
json = JsonSerializer.Serialize(forecast, options);

// 3. Non-generic, when the type is only known at runtime.
json = JsonSerializer.Serialize(forecast, typeof(WeatherForecast), AppJsonContext.Default);
```

オプションは可能な限り `JsonSerializerOptions` のインスタンスではなく `[JsonSourceGenerationOptions]` で指定してください。そうすれば生成される `Default` プロパティはコンパイル時に構成済みになり、6 か所ある呼び出し箇所の 1 つで命名ポリシーの適用を忘れる、という事故が起きません。コレクションには専用の `[JsonSerializable]` エントリが必要で（上の `List<WeatherForecast>`）、`object` として宣言されたメンバーには実行時に現れうる型をすべて登録する必要があります。それ以外にジェネレーターが手がかりにできるものがないからです。

## 解決策 2: ASP.NET Core、HttpClient、Blazor にコンテキストを組み込む

ほとんどのアプリは `JsonSerializer` を直接呼びません。型をフレームワークのメソッドに渡し、そのメソッドが代わりに呼び出します。この場合はリゾルバーを起動時に一度だけ組み込む必要があります。

minimal API 向け、`CreateSlimBuilder` を使う Native AOT テンプレートも含みます。

```csharp
// .NET 11, ASP.NET Core 11
var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});
```

MVC と Web API のコントローラー向けです。

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(static options =>
    options.JsonSerializerOptions.TypeInfoResolverChain.Add(AppJsonContext.Default));
```

`HttpClient` では、型を推論するオーバーロードではなく `JsonTypeInfo<T>` を受け取るオーバーロードを使います。

```csharp
// .NET 11, C# 14
var forecast = await client.GetFromJsonAsync("/weather", AppJsonContext.Default.WeatherForecast);
await client.PostAsJsonAsync("/weather", forecast, AppJsonContext.Default.WeatherForecast);
```

`TypeInfoResolverChain` はそれ自体知っておく価値があります。オプションは各リゾルバーを順に問い合わせ、最初に null でない結果を採用するので、`JsonTypeInfoResolver.Combine(ContextA.Default, ContextB.Default)` で複数プロジェクトのコンテキストを合成したり、フレームワーク自身のリゾルバーより前に自分のものを差し込んだりできます。

## 解決策 3: MSBuild に触れず、呼び出し箇所でリフレクションを復活させる

エラーメッセージはもう 1 つの逃げ道を示しています。"explicitly configure the `JsonSerializerOptions.TypeInfoResolver` property" です。リフレクションリゾルバーは今も公開型であり、その構築時にスイッチはチェックされません。

```csharp
// .NET 11, C# 14. Works in a trimmed app. Does NOT work under Native AOT.
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};
string json = JsonSerializer.Serialize(new { Value = 42 }, options);
```

何を買っているのかを理解してください。名指しでリフレクションを要求したので例外は消えますが、トリマーは使われていないと判断したメンバーをすでに削除済みです。結果として得られるのは、動作はするが不完全なオブジェクトを黙って出力するシリアライズであり、.NET 8 の変更がまさに防ごうとした失敗パターンそのものです。Native AOT ではさらに悪く、`DefaultJsonTypeInfoResolver` には `[RequiresDynamicCode]` が付いているため、`InvalidOperationException` が `PlatformNotSupportedException` や実行時のメタデータ欠落エラーに置き換わるだけです。これは解決策ではなく診断手順（自分のペイロードはトリミングを生き残るか）として扱ってください。

本当に有用なのは条件付きリゾルバーのパターンで、両方の世界で動作する必要があるライブラリ向けにドキュメントが推奨しているものです。

```csharp
// .NET 11, C# 14
static JsonSerializerOptions CreateDefaultOptions() => new()
{
    TypeInfoResolver = JsonSerializer.IsReflectionEnabledByDefault
        ? new DefaultJsonTypeInfoResolver()
        : AppJsonContext.Default
};
```

`IsReflectionEnabledByDefault` はリンク時定数として置換されるため、ILLink は分岐を畳み込み、AOT ビルドでリフレクションリゾルバーがルート化されることはありません。

## 解決策 4: スイッチを戻す、そしてそれが正当化される場面

1 つのプロパティで .NET 7 の挙動に戻せます。

```xml
<!-- MyApp.csproj, .NET 11 SDK -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <JsonSerializerIsReflectionEnabledByDefault>true</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

これを使うのは、サードパーティの依存関係が自分のコードの奥深くで自分の型に対して `JsonSerializer.Serialize` を呼んでおり、`JsonSerializerContext` を同梱していない場合です。その呼び出し箇所を書き換えることはできませんし、あなたのアセンブリにソースジェネレーターを置いても助けになりません。リゾルバーは、そのライブラリが生成するオプションのインスタンスに紐づいている必要があるからです。広く使われているいくつかのパッケージがこれに衝突しており、Azure App Configuration プロバイダーや ASP.NET Core の Swagger UI エンドポイントなどに対するバグ報告が生まれました。

注意点が 2 つあります。1 つ目、これはデータの静かな欠落を呼び戻します。リフレクションリゾルバーは動きますが、対象はトリミングを生き残ったメンバーだけです。成功する `dotnet run` を信用するのではなく、実際に発行された成果物を実データで検証してください。2 つ目、Native AOT を使っている場合、このプロパティを切り替えてもリフレクションが動くようにはなりません。早い段階で真実を告げていたガードレールを外すだけです。

## 誤った解決策に導く落とし穴

**次に出るエラーは `NoMetadataForType` です。** コンテキストを追加したあと、注釈を忘れた型は `JsonTypeInfo metadata for type 'X' was not provided by TypeInfoResolver of type 'Y'` を投げます。これは後退ではなく前進で、欠けている型を名指ししてくれています。その型に `[JsonSerializable(typeof(X))]` を追加してください。コレクション型も、ポリモーフィックにシリアライズするサブタイプもすべて対象です。`[JsonDerivedType]` を使う場合は派生型ごとにエントリが必要で、その点は [`JsonDerivedType` によるポリモーフィックなシリアライズ](/ja/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)のガイドで詳しく扱っています。

**ビルド時の警告はありません。** スイッチが無効なときに `JsonSerializer.Serialize(x)` を指摘するアナライザーという当然の要望は [dotnet/runtime#107440](https://github.com/dotnet/runtime/issues/107440) として提出されましたが、対応予定なしとしてクローズされました。トリミング解析の警告（`IL2026`、`IL3050`）は自分のコード内のリフレクションベースのシリアライズを指摘してくれるので、トリミング解析がクリーンなビルドをコンパイル時チェックの最も近い代替と考えてください。そこに到達する方法は[トリミング安全なコードを書く](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)で扱っています。

**.NET MAUI では Release でのみ、あるいは実機でのみ再現します。** MAUI はトリミング関連のプロパティを自動で設定します。Android と Mac Catalyst は Release ビルドで部分トリミングを使い、iOS は構成にかかわらずすべての実機ビルドで部分トリミングを使いますが、シミュレーター向けビルドはまったくトリミングされません。つまり「シミュレーターでは動くのに実機の iPhone では落ちる」と「Debug では動くのに Release では落ちる」は同じバグです。MAUI プロジェクトで `PublishTrimmed` を自分で設定しないでください。このプロパティは SDK が管理します。

**`PlatformNotSupportedException` は別のエラーです。** スタックトレースに `ConfigureForJsonSerializer` ではなく `Reflection.Emit` や式ツリーのコンパイルが出ているなら、見ているのは JSON のスイッチではなく AOT に JIT がないことです。そちらは [Native AOT の `PlatformNotSupportedException`](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) の記事で扱っています。

**非ジェネリックの `JsonStringEnumConverter` は AOT でサポートされません。** ソース生成に移行したら、列挙型側に `JsonStringEnumConverter<TEnum>` を付けるか、`[JsonSourceGenerationOptions]` で `UseStringEnumConverter = true` を指定してください。同じ制約は手書きのコンバーターにも当てはまるので、[カスタム `JsonConverter` を書く](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)際のルールと照らし合わせておく価値があります。

**意図的に有効化するのも妥当な選択です。** トリミングしていないアプリでこのエラーを出させ、開発中に CoreCLR 上で AOT 非互換を洗い出したいなら、自分で `JsonSerializerIsReflectionEnabledByDefault` を `false` に設定してください。このプロパティの挙動は CoreCLR と Native AOT で一貫しており、だからこそ早期警戒システムとして優秀です。このプロパティ単体の使い方は、[リフレクションベースのシリアライズを無効にする](/ja/2023/10/system-text-json-disable-reflection-based-serialization/)という以前の記事で扱っています。

## 関連記事

- [トリミング安全なコードとは何か、どう書くのか](/ja/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [Native AOT とは何か、その代償は何か](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [解決: Native AOT の PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [JsonDerivedType でポリモーフィックな型階層をシリアライズする方法](/ja/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [ASP.NET Core の minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## 参考資料

- [Breaking change: PublishTrimmed projects fail reflection-based serialization](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed)（MS Learn）
- [How to use source generation in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)、"Disable reflection defaults" セクションを含む（MS Learn）
- [JsonSerializer.IsReflectionEnabledByDefault プロパティ](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault)（MS Learn）
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options)（MS Learn）
- [Trim a .NET MAUI app](https://learn.microsoft.com/en-us/dotnet/maui/deployment/trimming)、プラットフォームごとのトリミング既定値について（MS Learn）
- [System.Text.Json analyzers should warn about using reflection when reflection is disabled](https://github.com/dotnet/runtime/issues/107440)（dotnet/runtime）
- [`JsonSerializerOptions.ConfigureForJsonSerializer`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/JsonSerializerOptions.cs) と `JsonSerializerIsReflectionDisabled` の文字列リソース（dotnet/runtime）

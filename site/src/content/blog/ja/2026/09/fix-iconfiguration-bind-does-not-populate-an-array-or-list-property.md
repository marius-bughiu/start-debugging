---
title: "修正: IConfiguration.Bind が appsettings.json から配列や List<T> プロパティに値を設定しない"
description: "バインダーは、public setter のない配列プロパティ、get のみの IReadOnlyList<T>、フィールド、そしてソースジェネレーター使用時の init 専用メンバーを黙ってスキップします。さらに既定値を置き換えずに追記します。.NET 10.0.12 と 11 RC 1 で計測しました。"
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "dotnet-11"
  - "configuration"
  - "options-pattern"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property"
translatedBy: "claude"
translationDate: 2026-09-23
---

**結論:** `ConfigurationBinder` はコレクションをバインドできなくても例外をスローしません。プロパティをそのまま放置するだけです。よくある原因は次のとおりです。プロパティが public setter のない配列 (または `IReadOnlyList<T>`、`IEnumerable<T>`) である、プロパティではなく public フィールドである、`GetSection` に渡したセクション名が JSON と一致していない、あるいは Native AOT やトリミングを有効にしたことでバインダーがソースジェネレーターに切り替わり、そのジェネレーターが `init` アクセサーを無視している、というものです。プロパティに public な `get; set;` を付け、正しいセクションをバインドし、`ErrorOnUnknownConfiguration` を有効にして次の不一致では明確に失敗するようにしてください。リストはバインドされるのに *余分な* 要素が含まれている場合、それはこのバグのもう半分です。バインダーはプロパティがすでに持っている内容に追記し、決して置き換えません。

以下の内容はすべて、SDK 10.0.302 と `Microsoft.Extensions.Configuration.Binder` 10.0.12 の組み合わせでファイルベースのプローブを使って計測し、その後 .NET 11 RC 1 SDK 上で 11.0.0-rc.1.26425.128 を使って再実行したものです。どの行も 2 つのバージョンで同一でした。重要な違いはリフレクションバインダーとソース生成バインダーの間にあり、.NET 10 と 11 の間にはありません。

## バインダーがコレクションを黙ってスキップする理由

`ConfigurationBinder.cs` のリフレクションバインダーは、プロパティごとに書き込めるかどうかを判定します。判定は単純です。public getter が必要で、*変更* ではなく *置き換え* が必要なものについては public setter (または `BinderOptions.BindNonPublicProperties = true`) も必要です。判定に失敗すると、`BindProperty` は何も言わずに戻ります。

この "置き換え" と "変更" の区別が、紛らわしいケースのほとんどを説明します。

- **配列** は長さが固定なので、その場で変更することはできません。バインダーは新しい配列を作成し、それを格納するために setter を必要とします。`string[] Hosts { get; } = [];` は永遠に空のままです。
- すでにインスタンスを保持している **`List<T>` や `IList<T>`** は変更できます。バインダーはそれに対して `Add` を呼び出すので、get のみの `List<string> Hosts { get; } = new();` は問題なくバインドされます。
- **`IReadOnlyList<T>`** や **`IEnumerable<T>`** には `Add` がありません。setter があれば、バインダーは新しい配列を作成して代入します。setter がなければ何も起きません。

要素の変換エラーも握りつぶされます。`BindArray` と `BindCollection` では、各要素が `try`/`catch` の中でバインドされ、`ErrorOnUnknownConfiguration` が設定されている場合にだけ再スローされます。`int[]` の中の `"abc"` のような値は、結果から単に消えます。

## 計測結果の一覧

プローブは `{ "App": { "Hosts": [ "a.example", "b.example" ] } }` をさまざまな形のオプションクラスにバインドします。既定のリフレクションバインダーで 1 回、`EnableConfigurationBindingGenerator=true` で 1 回です。

```csharp
// .NET 10.0.12 / .NET 11 RC 1, Microsoft.Extensions.Configuration.Binder
class GetOnlyArray { public string[] Hosts { get; } = []; }
class GetOnlyList { public List<string> Hosts { get; } = new(); }
class GetOnlyRoList { public IReadOnlyList<string> Hosts { get; } = []; }
class FieldArray { public string[] Hosts = []; }
class PrivateSet { public string[] Hosts { get; private set; } = []; }
class InitOnly { public string[] Hosts { get; init; } = []; }
class Settable { public string[] Hosts { get; set; } = []; }
```

| プロパティの形 | リフレクションバインダー | ソースジェネレーター |
| --- | --- | --- |
| `string[] { get; }` | `[]` | `[]` |
| `List<string> { get; } = new()` | `[a, b]` | `[a, b]` |
| `IReadOnlyList<string> { get; } = []` | `[]` | `[]` |
| `IList<string> { get; } = new List<string>()` | `[a, b]` | `[a, b]` |
| `string[]` の public フィールド | `[]` | `[]` |
| `string[] { get; private set; }` | `[]` | `[]` |
| 同上、`BindNonPublicProperties = true` | `[a, b]` | `NotSupportedException` |
| `string[] { get; init; }` | `[a, b]` | `[]` |
| `string[] { get; set; }` | `[a, b]` | `[a, b]` |
| `Get<T>()` 経由の `record Opts(string[] Hosts)` | `[a, b]` | `[a, b]` |
| `ImmutableArray<string> { get; set; }` | `[]` | `NullReferenceException` |

3 つの行はもう一度見ておく価値があります。`init` アクセサーはリフレクションでは動作しますが、ジェネレーターでは黙ってスキップされます。`ImmutableArray<T>` は一度も値が設定されません。そして、このプローブをジェネレーターでビルドしたときの警告は **ゼロ** だったので、どちらについてもコンパイル時には何も教えてくれません。

## 手順を追って修正する

1. **セクションのパスを確認します。** `builder.Configuration.GetSection("App")` は、プロパティ名に至るまで JSON と正確に一致している必要があります (照合は大文字と小文字を区別しないので、大文字小文字は問題ではありません)。セクションではなくルートをバインドするという最もよくある打ち間違いは、プローブでは `[]` になりました。バインダーを疑う前に、構成が実際に何を保持しているかを出力してください。

   ```csharp
   // .NET 10 / 11
   foreach (var kv in builder.Configuration.GetSection("App").AsEnumerable())
       Console.WriteLine($"{kv.Key} = {kv.Value}");
   // Among the output you should see:
   // App:Hosts:0 = a.example
   // App:Hosts:1 = b.example
   ```

   配列はインデックス付きのキー (`App:Hosts:0`、`App:Hosts:1`) に平坦化されます。これらの行がない場合、問題はクラスではなくファイル (出力にコピーされていない、環境名が違う、ネストが違う) にあります。

2. **コレクションに public setter を付けます。** ほとんどの報告はこれで解決します。

   ```csharp
   // .NET 10 / 11
   public sealed class AppOptions
   {
       public string[] Hosts { get; set; } = [];
       public List<EndpointOptions> Endpoints { get; set; } = [];
   }

   public sealed class EndpointOptions
   {
       public string Url { get; set; } = "";
   }
   ```

   プロジェクトが `PublishAot` や `PublishTrimmed` で発行される可能性が少しでもあるなら、`init` ではなく `get; set;` を使ってください (後述)。オプションクラスでは `ImmutableArray<T>` を避けてください。利用側に読み取り専用のセマンティクスを見せたい場合は、`IReadOnlyList<T> { get; set; }` を公開します。リフレクションバインダーはそこに `string[]` を、ジェネレーターは `List<T>` を代入し、プローブではどちらも正しく値が設定されました。

3. **不一致で明確に失敗させます。** `ErrorOnUnknownConfiguration` は、構成に対応するプロパティのないキーがあると例外をスローし、さらにバインダーが要素の変換エラーを握りつぶすのも止めます。

   ```csharp
   // .NET 10 / 11
   builder.Services.AddOptions<AppOptions>()
       .Bind(builder.Configuration.GetSection("App"),
             o => o.ErrorOnUnknownConfiguration = true)
       .ValidateOnStart();
   ```

   JSON に (単数形の) `"Host": ["a"]` がある場合、プローブは `InvalidOperationException: 'ErrorOnUnknownConfiguration' was set on the provided BinderOptions, but the following properties were not found on the instance of Settable: 'Host'` をスローしました。`"Ports": [1, "abc", 3]` の場合は `'ErrorOnUnknownConfiguration' was set and binding has failed` をスローし、内部例外は `Failed to convert configuration value 'abc' at 'App:Ports:1' to type 'System.Int32'` でした。このオプションなしでは、同じバインドは `[1, 3]` を返しました。

   検証と組み合わせて、空のリストを本番環境での謎ではなく起動時の失敗にしましょう。[`IValidateOptions<T>` による起動時のオプション検証](/ja/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) で `ValidateOnStart` 側を詳しく扱っています。

4. **コレクションを既定値で初期化するのをやめます。** 次のセクションを参照してください。既定値は置き換えられず、追記されます。

## バインダーは既定値を置き換えずに追記する

これは空のリストを修正した直後に遭遇するバグです。プロパティに既定値を与え、値を持つセクションをバインドしてみます。

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public List<string> Hosts { get; set; } = ["localhost"];
}
// appsettings.json: "App": { "Hosts": [ "a.example", "b.example" ] }
// Result: [ "localhost", "a.example", "b.example" ]
```

プローブは `List<T>`、`string[]`、`IEnumerable<T>`、`IReadOnlyList<T>`、`HashSet<T>` のいずれでもこの結果を返し、`Bind` と `Get<T>()` のどちらでも同じでした。`BindArray` は文字どおり、構成された要素を追加する前に既存の要素を新しいリストにコピーするところから始めます。同じインスタンスに対して `Bind` を 2 回呼び出すと (たとえば変更トークンのコールバックから)、`[a, b, a, b]` になりました。

これは昔からある意図的な動作です。既存のコレクションを上書きするオプションは 2021 年に [dotnet/runtime#62112](https://github.com/dotnet/runtime/issues/62112) で提案されましたが、Future マイルストーンのまま今も open で、[dotnet/runtime#118204](https://github.com/dotnet/runtime/issues/118204) も同様なので、フラグを待たないでください。既定値はバインドの *後* に、構成が何も提供しなかった場合にだけ適用します。

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public string[]? Hosts { get; set; }
}

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection("App"));
builder.Services.PostConfigure<AppOptions>(o => o.Hosts ??= ["localhost"]);
```

プローブでは、セクションが存在するときは `[a, b]`、存在しないときは `[localhost]` になりました。`IOptionsMonitor<T>` のファクトリはリロードのたびに新しいインスタンスを作るので、PostConfigure の処理は毎回クリーンな状態に対して実行されます。[IOptions vs IOptionsSnapshot vs IOptionsMonitor](/ja/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) で、それぞれのインスタンスがいつ作成されるかを説明しています。

## 重ねたファイルは配列をインデックス単位でマージする

`appsettings.Development.json` は `appsettings.json` の配列を置き換えません。構成プロバイダーはキーを提供するだけで、あるキーを最後に設定したプロバイダーが勝ちます。配列は単にキー `0`、`1`、`2` です。プローブでは次の 2 つのファイルを重ねました。

```json
// appsettings.json
{ "App": { "Hosts": [ "a", "b", "c" ] } }
```

```json
// appsettings.Development.json
{ "App": { "Hosts": [ "dev1", "dev2" ] } }
```

バインド結果は `[dev1, dev2, c]` でした。インデックス 2 は依然として基本ファイルから来ています。環境変数 (`App__Hosts__0=env.example` は最初の要素だけを置き換えました) やコマンドライン引数 (`--App:Hosts:2=cli.example` は 3 番目を追加しました) でも同じことが起きます。ASP.NET Core の構成ドキュメントはこの点を明記しており、ソース間でインデックスをそろえておくよう勧めています。

基本の配列をクリアしようとして試しがちな方法のうち、次の 2 つはうまくいきません。

- 上書きファイルに空の配列 `"Hosts": []` を置く: 結果は `[a, b]` のままでした。
- 上書きファイルに `"Hosts": null` を置く: これも `[a, b]` でした。

うまくいくのは、基本ファイルにその配列をまったく定義しない、すべての環境ファイルで完全な配列を定義する、あるいは値を区切り文字付きの 1 つの文字列として保存し `PostConfigure` で分割する、のいずれかです。単純な `"Hosts": "a.example,b.example"` を `string[]` に直接バインドすると `[]` になります。バインダーは文字列を分割してくれません。

## Native AOT とトリミングで知らないうちにバインダーが変わる

.NET SDK は、トリミングされたアプリでは構成バインディングのソースジェネレーターを自動的に有効にします。SDK 10.0.302 の `Microsoft.NET.Sdk.FrameworkReferenceResolution.targets` から抜粋します。

```xml
<PropertyGroup Condition="'$(PublishTrimmed)' == 'true' Or '$(PublishAot)' == 'true'">
  <EnableRequestDelegateGenerator Condition="'$(EnableRequestDelegateGenerator)' == ''">true</EnableRequestDelegateGenerator>
  <EnableConfigurationBindingGenerator Condition="'$(EnableConfigurationBindingGenerator)' == ''">true</EnableConfigurationBindingGenerator>
</PropertyGroup>
```

ジェネレーターは `Bind`、`Get<T>`、`Configure<T>` の呼び出しをコンパイル時にインターセプトします。これによって Native AOT はリフレクションなしでバインドできますが、別の実装であり、プローブでは動作の違いが 4 つ見つかりました。

| ケース | リフレクション | ソースジェネレーター |
| --- | --- | --- |
| `string[] { get; init; }` | バインドされる | 黙ってスキップされる |
| `BindNonPublicProperties = true` | private setter にバインドされる | `NotSupportedException` |
| `int[]` への `"Ports": [1, "abc", 3]` | `[1, 3]` | `InvalidOperationException: Failed to convert configuration value 'abc'` |
| `int[]` への `"Ports": [1, null, 3]` | `InvalidCastException` | `[1, 3]` |
| `ImmutableArray<string>` | `[]` | `NullReferenceException` |

つまり、`dotnet run` では問題なくバインドされるアプリが、誰かがプロジェクトに `<PublishAot>true</PublishAot>` を追加した後には違うバインドになることがあります。AOT に移行するなら、Debug でも `<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>` を明示的に設定し、テストが本番と同じバインダーを使うようにしてください。[ASP.NET Core minimal API で Native AOT を使う](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) では、同時に有効になる他のジェネレーターを扱っています。ファイルベースのアプリ (`dotnet run app.cs`) は既定で `PublishAot=true` なので、その方法で書いた簡単なプローブは、`#:property PublishAot=false` を追加しない限り、すでにジェネレーターで動いています。

## 知っておく価値のあるその他のケース

- **疎なインデックスは詰められます。** キー `App:Hosts:0` と `App:Hosts:5` は `[a, f]` にバインドされました。隙間のある 6 要素ではなく、2 要素の配列です。インデックス 3 が欠けているドキュメントの例も同じことを示しています。
- **オブジェクトのキーはインデックスのように動作します。** `"Hosts": { "x": "a", "y": "b" }` は `[a, b]` にバインドされました。配列のつもりで JSON オブジェクトを書いても失敗しないのはこのためです。
- **null の文字列要素は残ります。** `string[]` への `["a", null, "c"]` は、ASP.NET Core のドキュメントにはバインダーは `null` のエントリを作成できないと書かれているにもかかわらず、両方のバインダーで `[a, null, c]` になりました。どちらの動作にも依存せず、`PostConfigure` か検証で null を除外してください。
- **コレクションでもコンストラクターバインドは動作します。** `record AppOptions(string[] Hosts)` や、パラメーター付きコンストラクターしか持たない要素型 (`class Endpoint(string url)`) は、両方のモードで `Get<T>()` により正しくバインドされました。
- **配列セクション自体に対する `Get<string[]>()`** (`GetSection("App:Hosts").Get<string[]>()`) は、オプションクラスとは無関係にデータを確認する手早い方法です。

## 自分のオプションクラスをテストする方法

本番と同じジェネレーター設定で、実際の `appsettings.json` を実際のオプション型にバインドする単体テストを用意しておきましょう。

```csharp
// .NET 10 / 11, xUnit
[Fact]
public void AppOptions_binds_hosts()
{
    var config = new ConfigurationBuilder()
        .AddJsonFile("appsettings.json")
        .Build();

    var options = config.GetSection("App")
        .Get<AppOptions>(o => o.ErrorOnUnknownConfiguration = true);

    Assert.NotNull(options);
    Assert.Equal(new[] { "a.example", "b.example" }, options.Hosts);
}
```

環境固有のファイルや環境変数を含むエンドツーエンドのカバレッジには、[WebApplicationFactory による統合テスト](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) を使うと、実際のホストから `IOptions<AppOptions>` を解決できます。

## 関連記事

- [.NET 11 で IValidateOptions<T> を使って起動時にオプションを検証する方法](/ja/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) で、空のリストを起動時エラーにできます。
- [.NET 11 における IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T>](/ja/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) で、バインドされたインスタンスがいつ作成・再構築されるかを確認できます。
- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) で、AOT が有効にする他のソースジェネレーターを確認できます。
- [ASP.NET Core 11 で WebApplicationFactory<T> を使って統合テストを書く方法](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) で、実際のホストに対して構成をテストできます。

## 出典

- [ASP.NET Core の構成: 配列をバインドする](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/#bind-an-array)、Microsoft Learn
- [構成バインディングのソースジェネレーター](https://learn.microsoft.com/dotnet/core/extensions/configuration-generator)、Microsoft Learn
- [v10.0.12 時点の `ConfigurationBinder.cs`](https://github.com/dotnet/runtime/blob/v10.0.12/src/libraries/Microsoft.Extensions.Configuration.Binder/src/ConfigurationBinder.cs)、dotnet/runtime
- [dotnet/runtime#62112: 既存の変更可能なコレクションインスタンスを任意で上書きできるようにする](https://github.com/dotnet/runtime/issues/62112)
- [dotnet/runtime#118204: 既定の構成配列マージは分かりにくくミスを招きやすい](https://github.com/dotnet/runtime/issues/118204)
- [NuGet の `Microsoft.Extensions.Configuration.Binder`](https://www.nuget.org/packages/Microsoft.Extensions.Configuration.Binder)、バージョン 10.0.12 と 11.0.0-rc.1.26425.128 をテスト済み

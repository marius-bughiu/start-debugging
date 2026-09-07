---
title: "ASP.NET Core を参照せずに型付き HttpClient から RFC 9457 の ProblemDetails レスポンスを読み取る方法"
description: "BCL に ProblemDetails 型は存在せず、Microsoft.AspNetCore.App への FrameworkReference を追加すると、ランタイムだけのコンテナーでクライアントが起動を拒否します。仕事をこなす 20 行のモデル、problem+json を型付き例外に変える DelegatingHandler、そして今なお多くの回答が繰り返している content-type の神話を扱います。"
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "httpclient"
  - "system-text-json"
  - "aspnetcore-11"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient"
translatedBy: "claude"
translationDate: 2026-09-07
---

短い答えです。ASP.NET Core を参照してはいけません。5 つのプロパティと拡張メンバー用の `[JsonExtensionData]` ディクショナリを持つクラスを宣言し、`System.Net.Http.Json` の `HttpContent.ReadFromJsonAsync<T>` でデシリアライズしてください。`application/problem+json` というメディアタイプは問題なくパースされます。`ReadFromJsonAsync` は .NET 5 以降 content type を検証していないからです。そしてこの方法はコンソールアプリ、クラスライブラリ、Blazor WebAssembly、MAUI、Native AOT クライアントのすべてで動きます。

この記事では、クライアント側で `Microsoft.AspNetCore.Mvc.ProblemDetails` に手を伸ばすのが誤りである理由、それでも手を伸ばした場合に発生する具体的な失敗、`errors` と `traceId` を含む実際の ASP.NET Core のエラーレスポンスを丸ごと受け取れるモデル、4xx を型付き例外に変えるために型付き `HttpClient` へ組み込む方法、そして `status` を信頼できるものとして扱うと痛い目を見る RFC 9457 のいくつかのルールを扱います。

バージョンについての注記です。.NET 11 と ASP.NET Core 11 は 2026 年 9 月時点でプレビューであり、[.NET 11 のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md)によれば 2026-11-10 に一般提供となります。この領域は .NET 11 でも変わらず、本質的な解決となる API 提案は .NET 12 を対象としています (詳しくは最後に)。以下の出力はすべて、.NET SDK 10.0.302 と 10.0.10 のランタイムを使い、`AddProblemDetails()` を有効にした Minimal API に対してこのマシン上で得たものです。

## なぜクライアントはサーバーの型をそのまま使えないのか

`ProblemDetails` は、null 許容のプロパティ 5 つとディクショナリ 1 つを持つ単純なデータクラスです。振る舞いもサーバー依存もありません。それでもこの型は `Microsoft.AspNetCore.Http.Abstractions.dll` に置かれており、この DLL は共有フレームワーク `Microsoft.AspNetCore.App` の一部としてのみ配布されます。したがって、サポートされた唯一の到達手段はフレームワーク参照です。

```xml
<!-- Contracts.csproj, .NET 10 / .NET 11 -->
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

これはコンパイルできます。そして伝播もします。このクラスライブラリを、ごく普通のコンソールアプリに追加して、SDK が `Cli.runtimeconfig.json` に何を書き込むか見てください。

```json
{
  "runtimeOptions": {
    "tfm": "net10.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
    ]
  }
}
```

コンソールアプリは起動時に ASP.NET Core の共有フレームワークを強く要求するようになりました。それが入っているマシンでは何も問題なく見えます。だからこそこの状態のまま出荷されてしまいます。同じバイナリを、ランタイムだけの .NET インストール、つまり `mcr.microsoft.com/dotnet/runtime:10.0` が提供するものに対して実行すると、あなたのコードが 1 行も動かないうちにホストが拒否します。

```
You must install or update .NET to run this application.

App: /app/Cli.dll
Architecture: arm64
Framework: 'Microsoft.AspNetCore.App', version '10.0.0' (arm64)

No frameworks were found.
```

これは `shared/Microsoft.NETCore.App` だけを一時的な `DOTNET_ROOT` にコピーし、そこでアプリを起動して再現したものです。誤ったベースイメージから得られるメッセージとまったく同じで、多くの人が適用する対処は `aspnet` イメージへの切り替えですが、それはリッスン状態のソケットを開くことのないクライアントに約 20 MB のサーバーフレームワークを足すことになります。イメージサイズを検討しているなら、トレードオフは [.NET 11 のコンテナーイメージにおける framework-dependent と self-contained と Native AOT の比較](/ja/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)にまとめてあります。

他のターゲットはもっと早く、もっと厳しく失敗します。`Microsoft.AspNetCore.App` への `FrameworkReference` は `netstandard2.0` ライブラリではそもそも使えませんし、Blazor WebAssembly や MAUI のクライアントが、JSON の文字列 5 つを読むために Kestrel と MVC とルーティングのメタデータをトリミンググラフへ引きずり込む理由はありません。型の移設を求める `dotnet/aspnetcore` の issue、[#58551 "Move ProblemDetails outside of Asp.Net Core"](https://github.com/dotnet/aspnetcore/issues/58551) は、起票以来バックログに担当者なしで放置されています。

## モデルを 4 ステップで

1. **RFC 9457 の 5 つのメンバーを null 許容プロパティとして宣言します。** [RFC 9457 セクション 3.1](https://datatracker.ietf.org/doc/html/rfc9457#section-3.1) のすべてのメンバーは省略可能です。`status` は JSON の数値なので `int?`、残り 4 つは文字列です。
2. **`[JsonExtensionData]` ディクショナリを追加します。** RFC 9457 のセクション 3.2 は、問題の型が標準メンバーと同じフラットな名前空間にメンバーを追加することを認めており、ASP.NET Core はまさにその形で `Extensions` ディクショナリを書き出します。これがないと、`errors`、`traceId`、そして API が追加したドメイン固有のフィールドを黙って取りこぼします。
3. **`HttpContent` 上の `ReadFromJsonAsync<T>` でデシリアライズします。** `GetFromJsonAsync` ではありません。`HttpClient` レベルのヘルパーは `EnsureSuccessStatusCode` を代わりに呼んでくれますが、ここではそれが望むことの正反対です。
4. **メディアタイプは自分でチェックします。** 他の誰もチェックしてくれないからです。

この型は、どのクライアントプロジェクトにも貼り付けられる程度に短いものです。

```csharp
// .NET 10 / .NET 11, C# 14. Only needs System.Net.Http.Json + System.Text.Json.
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class ProblemDetails
{
    public string? Type { get; set; }
    public string? Title { get; set; }
    public int? Status { get; set; }
    public string? Detail { get; set; }
    public string? Instance { get; set; }

    [JsonExtensionData]
    public IDictionary<string, JsonElement>? Extensions { get; set; }
}
```

`[JsonPropertyName]` 属性は不要です。`ReadFromJsonAsync` は既定で `JsonSerializerOptions.Web` を使い、これは `PropertyNamingPolicy` を camelCase に、`PropertyNameCaseInsensitive` を `true` に設定するため、`title` は自動的に `Title` へバインドされます。実際の ASP.NET Core のレスポンスに対して、このモデルはすべてを捕捉します。

```
type=https://example.com/probs/insufficient-funds
title=Insufficient funds
status=402
detail=Account 12345 has a balance of 4.20 EUR.
instance=/accounts/12345/withdraw
extensions: balance=4.20, accounts=["/account/12345","/account/67890"], traceId=00-5bf0...-00
```

この `traceId` はエンドポイントが設定したものではありません。ASP.NET Core の `DefaultProblemDetailsWriter` が `Activity.Current?.Id` から、なければ `HttpContext.TraceIdentifier` から補って、`AddProblemDetails()` 経由で書き出されるすべてのエラーレスポンスに付けています。クライアント側の失敗をサーバーのログと突き合わせるとき、ペイロードの中で最も役に立つフィールドであり、拡張ディクショナリを残しておいた場合にのみ生き残ります。

## バリデーションエラーはプロパティではなく拡張メンバー

ASP.NET Core のバリデーション失敗は、ネットワーク上ではこう見えます。

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The Sku field is required."],
    "Quantity": ["The field Quantity must be between 1 and 100."]
  },
  "traceId": "00-8246...-00"
}
```

`errors` は `title` と同じトップレベルの兄弟なので、`ValueKind` が `Object` の値として `Extensions` に入ります。読み戻すのは小さなヘルパーですが、防御的である必要があります。RFC 9457 のセクション 3.1 は、値の型が想定と一致しないメンバーは無視しなければならないと述べており、RFC 自身のセクション 3 の例は、ASP.NET Core のメンバー名をキーとしたマップではなく `{detail, pointer}` オブジェクトの `errors` **配列**を使っています。.NET 以外の API を呼ぶなら、もう一方の形に出会うことになります。

```csharp
// .NET 10 / .NET 11, C# 14
using System.Collections.ObjectModel;

public IReadOnlyDictionary<string, string[]> GetValidationErrors()
{
    if (Extensions is null ||
        !Extensions.TryGetValue("errors", out var errors) ||
        errors.ValueKind is not JsonValueKind.Object)
    {
        return ReadOnlyDictionary<string, string[]>.Empty;
    }

    var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
    foreach (var member in errors.EnumerateObject())
    {
        if (member.Value.ValueKind is not JsonValueKind.Array) continue;
        result[member.Name] = member.Value.EnumerateArray()
            .Where(e => e.ValueKind is JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToArray();
    }
    return result;
}
```

上のペイロードに対する検証済みの出力です。

```
Sku: The Sku field is required.
Quantity: The field Quantity must be between 1 and 100.
```

途中で諦めるすべての分岐は、例外を投げるのではなく空のディクショナリを返します。これはセクション 3.2 が消費側に求める振る舞い、つまり認識できない拡張は無視するという方針そのものです。サーバー側も自分の管轄なら、何を出力するかは [IProblemDetailsService と Minimal API のバリデーションレスポンス](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)で制御できます。

## もう存在しない content-type チェック

この話題に関する回答の半分は、レスポンスが `application/json` でない限り `ReadFromJsonAsync` は `NotSupportedException: The provided ContentType is not supported` を投げると警告しています。それは .NET Core 3.1 向けの `System.Net.Http.Json` プレビューでは事実でしたが、.NET 5 以降は誤りです。[dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594) が [#38713](https://github.com/dotnet/runtime/issues/38713) を解決するために検証を丸ごと削除しており、現在の `HttpContentJsonExtensions` のソースに `ValidateContent` は存在しません。

同じ problem+json のボディに対して content type を変えたマトリクスを、10.0.10 上で計測しました。

| Content-Type | ボディ | 結果 |
| --- | --- | --- |
| `application/problem+json` | 問題の JSON | パースされる |
| `application/problem+json; charset=utf-8` | 問題の JSON | パースされる |
| `text/html` | 問題の JSON | **パースされる** |
| `text/plain` | 問題の JSON | パースされる |
| (なし) | 問題の JSON | パースされる |
| `text/html` | `<html/>` | `JsonException: '<' is an invalid start of a value` |
| `application/problem+json` | 空 | `JsonException: The input does not contain any JSON tokens` |
| `application/problem+json` | `null` | `null` を返す |

ここから 2 つのことが導かれます。第一に、`application/problem+json` を読むための回避策は不要であり、.NET 5 以降は一度も必要ではありませんでした。第二に、あると思っていたセーフティネットは存在しません。ゲートウェイが 502 の HTML エラーページを返した場合、`ReadFromJsonAsync` は喜んでそれをパースしようとし、「これは問題ドキュメントではない」というきれいなシグナルではなく `JsonException` を渡してきます。だから上のステップ 4 はメディアタイプを自分でチェックせよと言っており、そのチェックは `charset` パラメーターを含む生のヘッダーではなく `Content.Headers.ContentType?.MediaType` に対して行うべきなのです。

ついでに言うと、`JsonSerializerOptions.Web` は `NumberHandling` も `AllowReadingFromString` に設定するため、`"status": "402"` を文字列として書くサーバーでも `int?` にバインドされます。こちらは味方になってくれる挙動です。

## 4xx を型付き例外に変える

これを置く自然な場所は、型付きクライアントに載せた `DelegatingHandler` です。そうすれば、メソッドごとの `if` なしにすべての呼び出し箇所がこの振る舞いを得られます。例外は `HttpRequestException` から派生させるので、既存の `catch` ブロックやリトライポリシーはそのまま動き続けます。

```csharp
// .NET 10 / .NET 11, C# 14
public sealed class ProblemDetailsException(ProblemDetails problem, HttpStatusCode status)
    : HttpRequestException(
        problem.Detail ?? problem.Title ?? "The server returned a problem response.",
        inner: null,
        statusCode: status)
{
    public ProblemDetails ProblemDetails { get; } = problem;
}

public sealed class ProblemDetailsHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = await base.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return response;

        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "application/problem+json", StringComparison.OrdinalIgnoreCase))
            return response;

        var json = await response.Content.ReadAsStringAsync(ct);
        var problem = JsonSerializer.Deserialize<ProblemDetails>(json, JsonSerializerOptions.Web);
        if (problem is null) return response;

        throw new ProblemDetailsException(problem, response.StatusCode);
    }
}
```

登録はいつもどおりの `IHttpClientFactory` です。

```csharp
services.AddTransient<ProblemDetailsHandler>();
services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://api.example.com"))
        .AddHttpMessageHandler<ProblemDetailsHandler>();
```

そして呼び出し箇所は、以前は裸のステータスコードでしかなかった 404 で、ペイロード全体を受け取ります。

```
ProblemDetailsException: No order with id abc.
  StatusCode=NotFound  type=https://api.example.com/probs/order-not-found
  orderId extension = abc
  is HttpRequestException: True
```

ハンドラー内で `ReadFromJsonAsync` ではなく `ReadAsStringAsync` を使っている点に注意してください。これは好みの問題ではありません。10.0.10 では、`HttpContent` に対して `ReadFromJsonAsync` を呼ぶとバッファリング済みのストリームが破棄されるため、同じレスポンスに対する 2 回目の呼び出しは `ObjectDisposedException: Cannot access a closed Stream` を投げます。例外を投げずにレスポンスをそのまま返すことがあるハンドラーでは、これは呼び出し側のためのボディを壊したことを意味します。`ReadAsStringAsync` は繰り返し可能で、`ReadAsStringAsync` のあとに `ReadFromJsonAsync` を呼ぶのも問題ありません。失敗するのは `ReadFromJsonAsync` を 2 回呼ぶ場合だけです。チェーンのどこかで `HttpCompletionOption.ResponseHeadersRead` を使っているなら、覗く前に `LoadIntoBufferAsync()` を呼んでください。

ハンドラーのテストは、[HttpClient を使用するコードのユニットテストを書く方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)で扱っている、偽の `HttpMessageHandler` を使う標準的な手順そのものです。クライアント自体の形をまだ決めかねているなら、[HttpClient vs HttpClientFactory vs Refit](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/) が、この種のハンドラーがそれぞれの選択肢のどこに収まるかを説明しています。

## 痛い目を見る RFC の 4 つのルール

**`status` は参考情報にすぎません。** セクション 3.1.2 は明示的です。"The 'status' member, if present, is only advisory"。しかも省略可能です。ステータスを書き換えるプロキシの背後にいるサーバーは、HTTP 502 のレスポンスに 409 を主張するボディという組み合わせをあなたに残します。分岐は必ず `response.StatusCode` で行い、`ProblemDetails.Status` はログに残す診断用フィールドとして扱い、switch の対象にはしないでください。

**分岐は `title` やステータスではなく `type` で行います。** `type` が安定した識別子です。`title` はローカライズされることが明示的に許されており、セクション 3.1 が "SHOULD NOT change from occurrence to occurrence" と言っているのは、ある型の内部での話です。`type` がない場合、セクション 3.1.1 はその値を `about:blank` とみなすと述べており、セクション 4.2.1 によればそれは「ステータスコード以上の情報はない」という意味で、`title` は単にステータスの文言だということになります。比較の前に、欠落や空の `type` は `about:blank` に正規化してください。

**`type` と `instance` は URI *参照*なので、相対にできます。** RFC はそれを許しつつ、"using relative URIs can cause confusion, and they might not be handled correctly by all implementations" と警告しています。`type` を定数と比較するなら、まず解決してください。`new Uri(response.RequestMessage!.RequestUri!, pd.Type ?? "about:blank")` です。

**`type` を逆参照せず、`detail` をエンドユーザーに見せないでください。** セクション 5 は消費側に対し、開発者向けツール以外では "SHOULD NOT automatically dereference the type URI" と述べています。そして `detail` の本質は、その発生に固有のサーバー側テキストであり、内部情報が漏れることが少なくありません。ログに残し、`traceId` で突き合わせ、表示は自前のメッセージで行ってください。

小さいものが 2 つあります。ヘッダーは依然として重要です。429 の問題ドキュメントは再試行までの待ち時間をボディではなく `Retry-After` に載せるので、ヘッダーを読んでください。そして、すべての失敗で問題レスポンスが返る保証はありません。私のマトリクスでは、429 が content type なし、長さ 0 のボディで返ってきました。これはまさに、上のハンドラーのメディアタイプチェックが手を触れずに通過させるケースです。

## Native AOT とトリミング

このモデルは `System.Text.Json` のソースジェネレーターで動作し、`[JsonExtensionData]` も含まれます。ただしディクショナリが `IDictionary<string, JsonElement>`、`IDictionary<string, object>`、`IDictionary<string, JsonNode>`、`JsonNode` のいずれかである必要があります。それ以外はビルド時に `SYSLIB1036` になります。

```csharp
// .NET 10 / .NET 11, C# 14
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProblemDetails))]
public partial class ProblemJsonContext : JsonSerializerContext;

// ...
var problem = await response.Content.ReadFromJsonAsync(ProblemJsonContext.Default.ProblemDetails, ct);
```

10.0.10 で検証済みです。ソース生成された経路は同じペイロードをパースし、`JsonElement` が生のテキストを保持するため、拡張ディクショナリの中で `4.20` を正確な 10 進数として保ちます。`GetDecimal()` で読むと `4.20` が得られ、浮動小数点の誤差は現れません。金額フィールドではこれが効いてきますし、拡張を `object` ではなく `JsonElement` のまま保持すべきもう 1 つの理由でもあります。ジェネレーターの出力を作り替える必要があるなら、[type info resolver のモディファイアー](/ja/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)がそのフックです。

## .NET 12 で変わるかもしれないこと

これらすべてを BCL に入れるという API 提案 [dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046) が出ています。`System.Net.Http.Json` の `ProblemDetails` モデル、`HttpResponseMessage.IsProblemJson()`、`ReadProblemJsonAsync()`、`ThrowIfProblemJsonAsync()`、そして `HttpRequestException` から派生する `ProblemDetailsException` です。提案の理由づけは、この記事の冒頭と同じものです。サーバーフレームワークを参照することは "pulls ASP.NET Core into console apps, MAUI apps, Blazor WASM clients, and class libraries that have no business depending on a server framework" だ、というものです。この提案は 12.0.0 マイルストーンに対して `api-suggestion` とラベル付けされており、つまり .NET 11 には入っておらず、.NET 12 でも確定ではありません。

それが出荷されるまでは、上の 20 行が答えのすべてであり、前方互換でもあります。提案されている BCL の型は同じ 5 つのプロパティと拡張ディクショナリを持つので、後から乗り換えるのは名前空間の変更と 1 ファイルの削除だけです。

## 関連記事

- [ASP.NET Core 11 で IProblemDetailsService を使って Minimal API のバリデーションエラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [HttpClient vs HttpClientFactory vs Refit: .NET 11 ではどれを使うべきか](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [HttpClient を使用するコードのユニットテストを書く方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [ソース生成された System.Text.Json のシリアル化を type info resolver のモディファイアーでカスタマイズする方法](/ja/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)
- [.NET 11 のコンテナーイメージにおける framework-dependent と self-contained と Native AOT の比較](/ja/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/)

## 参考資料

- [RFC 9457, Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [API 提案: System.Net.Http.Json での Problem Details (RFC 9457) サポート, dotnet/runtime#131046](https://github.com/dotnet/runtime/issues/131046)
- [Move ProblemDetails outside of Asp.Net Core, dotnet/aspnetcore#58551](https://github.com/dotnet/aspnetcore/issues/58551)
- [ReadFromJsonAsync から content type 検証を削除, dotnet/runtime#40594](https://github.com/dotnet/runtime/pull/40594)
- [Microsoft Learn の ProblemDetails クラスリファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.problemdetails)
- [dotnet/aspnetcore の DefaultProblemDetailsWriter のソース](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http.Extensions/src/DefaultProblemDetailsWriter.cs)
- [SYSLIB1036: JsonExtensionData の型要件](https://learn.microsoft.com/en-US/dotnet/fundamentals/syslib-diagnostics/syslib1036)

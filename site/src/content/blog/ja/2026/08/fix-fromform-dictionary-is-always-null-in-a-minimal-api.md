---
title: "修正: minimal API で [FromForm] Dictionary<string, string> が常に null になる"
description: "minimal API の [FromForm] Dictionary は空のプレフィックスでバインドされるため、フォームキーは metadata[key] ではなく [key] にする必要があります。クラスで包めば読みやすい名前を保てます。"
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ja"
translationOf: "2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api"
translatedBy: "claude"
translationDate: 2026-08-20
---

minimal API の `[FromForm] Dictionary<string, string>` パラメーターは、パラメーター名をフォームキーのプレフィックスとして使いません。フォームマッパーはフォームのルートから読み始めるため、`metadata[author]` や `metadata.author` ではなく `[author]` と `[env]` を探します。プレフィックスなしの角かっこ付きキーを送るか、より良い方法として辞書をクラスで包み、`Metadata[author]` を送ってワイヤー上の形式を読みやすく保ってください。キーが一致しなくてもログには何も出力されず、`400` も返りません。パラメーターは単に `null` として届きます。

以下の内容はすべて ASP.NET Core 10.0.5 と SDK 10.0.201 で計測しました。該当するバインド処理のコードは `release/11.0` ブランチでも同一なので、この挙動は .NET 11 にも引き継がれます。

## エラーの実際の様子

検索できる例外がまったく存在せず、それこそがこの問題で午後がまるごと溶ける理由です。ハンドラーは実行され、ファイルはバインドされ、辞書だけが `null` になります。

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/broken", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/broken \
  -F "metadata[author]=marius" -F "metadata[env]=prod" -F "file=@a.txt"
```

```text
metadata=null, file=a.txt
```

同じ `null` が `metadata.author=marius` でも、素の `author=marius` でも、キーをまったく含まないリクエストでも返ります。ステータスコードは毎回 `200` です。

例外を目にするのは、キーがマッパーに読み取られるところまで近づいたときだけです。`Dictionary<string, int>` にパースできない値を渡すと次のようになります。

```text
Microsoft.AspNetCore.Http.BadHttpRequestException: The value 'notanint' is not valid for 'b'.
 ---> Microsoft.AspNetCore.Components.Endpoints.FormMapping.FormDataMappingException
   at Microsoft.AspNetCore.Components.Endpoints.FormMapping.DictionaryConverter`5.TryRead(...)
```

このスタックトレースが手がかりです。実処理を行う型は `Microsoft.AspNetCore.Components.Endpoints.FormMapping` にあり、Blazor が使うのと同じフォームマッピング層です。そのキーの規約は MVC で身につけたものとは違います。

## これが起きる理由

minimal API のフォームバインドには完全に別々のコードパスが 2 つあり、パラメーターがどちらを通るかは `RequestDelegateFactory` の 1 つの述語だけで決まります。

```csharp
// dotnet/aspnetcore, src/Http/Http.Extensions/src/RequestDelegateFactory.cs, release/10.0
var useSimpleBinding = parameter.ParameterType == typeof(string) ||
    parameter.ParameterType == typeof(StringValues) ||
    parameter.ParameterType == typeof(StringValues?) ||
    ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType) ||
    (parameter.ParameterType.IsArray && ParameterBindingMethodCache.Instance.HasTryParseMethod(parameter.ParameterType.GetElementType()!));
hasTryParse = useSimpleBinding;
return useSimpleBinding
    ? BindParameterFromFormItem(parameter, formAttribute.Name ?? parameter.Name, factoryContext)
    : BindComplexParameterFromFormItem(parameter, string.IsNullOrEmpty(formAttribute.Name) ? parameter.Name : formAttribute.Name, factoryContext);
```

シンプルなバインドは `HttpContext.Request.Form[key]` を読み、この `key` がパラメーター名です。誰もが期待するのはこの挙動で、`string`、`int`、`Guid`、`DateOnly` など `TryParse` を持つ型ではこれが得られます。

`Dictionary<string, string>` には `TryParse` がないため `BindComplexParameterFromFormItem` に落ち、そこでフォーム全体が共有マッパーに渡されます。

```csharp
// FormDataMapper.Map<Dictionary<string, string>>(name_reader, FormDataMapperOptions);
var invokeMapMethodExpr = Expression.Call(
    FormDataMapperMapMethod.MakeGenericMethod(parameter.ParameterType),
    formReader,
    Expression.Constant(formDataMapperOptions));
```

引数を見てください。リーダーとオプションだけです。プレフィックスがありません。1 行上で計算された `key` は `factoryContext.TrackedParameters` の辞書キーとして使われるだけで、リーダーのプレフィックススタックに積まれることは一度もありません。そのためマッパーはフォームのルートから辞書を読み、ルートレベルの辞書エントリは `[author]` と書かれます。

これがこの問題のすべてです。パラメーターの名前は `metadata` ですが、その名前はフォームマッパーに伝わっていないのです。

コントローラーからエンドポイントを移した際にこの挙動がリグレッションのように感じられるのも同じ理由です。MVC のモデルバインダーはパラメーター名をプレフィックスとして試し、その後で空のプレフィックスにフォールバックするため、コントローラーのアクションは両方の書き方を受け付けます。

```csharp
// .NET 10.0.201, controller action, both curl shapes below return the same result
[HttpPost("dict")]
public IActionResult Dict([FromForm] Dictionary<string, string> metadata, IFormFile file)
    => Content($"count={metadata?.Count}");
```

```text
curl -F "metadata[author]=marius" -F "file=@a.txt"   ->  count=1
curl -F "[author]=marius"         -F "file=@a.txt"   ->  count=1
```

minimal API が受け付けるのは 2 番目だけです。2 つのホスティングモデルをより広く比較したい場合は、[ASP.NET Core 11 における minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)で、バインドの意味論が分かれるその他の箇所を扱っています。

## 最小再現

完全なアプリケーションと、動くリクエスト形式と動かないリクエスト形式です。

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAntiforgery();
var app = builder.Build();
app.UseAntiforgery();

app.MapPost("/dict", ([FromForm] Dictionary<string, string> metadata, IFormFile file) =>
    Results.Text($"metadata={(metadata is null ? "null" : JsonSerializer.Serialize(metadata))}, file={file?.FileName}"))
   .DisableAntiforgery();

app.MapPost("/list", ([FromForm] List<string> tags, IFormFile file) =>
    Results.Text($"tags={(tags is null ? "null" : JsonSerializer.Serialize(tags))}"))
   .DisableAntiforgery();

app.Run();
```

このアプリケーションに対する実測結果です。

| リクエスト | 結果 |
| --- | --- |
| `-F "metadata[author]=marius"` | `metadata=null` |
| `-F "metadata.author=marius"` | `metadata=null` |
| `-F "author=marius"` | `metadata=null` |
| `-F "[author]=marius" -F "[env]=prod"` | `metadata={"author":"marius","env":"prod"}` |
| `-F "tags=a" -F "tags=b"` | `tags=null` |
| `-F "tags[0]=a" -F "tags[1]=b"` | `tags=null` |
| `-F "[0]=a" -F "[1]=b"` | `tags=["a","b"]` |

パターンは一貫しています。トップレベルの `[FromForm]` コレクションパラメーターは空のプレフィックスでアドレス指定されるため、辞書は `[key]`、リストは `[0]`、`[1]` のように書きます。パラメーター名は死に荷物です。

## 修正方法の詳細

私が手を伸ばす順に、4 つの選択肢を挙げます。

### 1. 辞書をクラスで包む

これが本番に投入する価値のある修正です。クラスのプロパティにはプレフィックスが付きます。マッパーは下降しながらプロパティ名をプレフィックススタックに積むからです。おかげでワイヤー上の形式は、人間が読めてクライアントライブラリが生成できるものに戻ります。

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadRequest request, IFormFile file) =>
    Results.Text($"request={JsonSerializer.Serialize(request)}, file={file?.FileName}"))
   .DisableAntiforgery();

public class UploadRequest
{
    public Dictionary<string, string> Metadata { get; set; } = new();
}
```

```bash
curl -X POST http://localhost:5222/upload \
  -F "Metadata[author]=marius" -F "Metadata[env]=prod" -F "file=@a.txt"
```

```text
request={"Metadata":{"author":"marius","env":"prod"}}, file=a.txt
```

キーの照合は大文字と小文字を区別しないため、`metadata[author]` も `Metadata` プロパティにバインドされます。ネストした辞書はさらに深い位置に置くこともでき、`Meta` 自体がプロパティであれば `Meta.Tags[a]=1` も問題なくバインドされます。

ファイルを同じクラスに取り込めば、エンドポイントのシグネチャーをパラメーター 1 つに保てます。

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] UploadWithFile request) =>
    Results.Text($"metadata={JsonSerializer.Serialize(request.Metadata)}, file={request.File?.FileName}"))
   .DisableAntiforgery();

public class UploadWithFile
{
    public Dictionary<string, string> Metadata { get; set; } = new();
    public IFormFile? File { get; set; }
}
```

`-F "Metadata[author]=marius" -F "File=@a.txt"` を送れば両方がバインドされます。ファイルのプロパティはプロパティ名で照合され、これはトップレベルの `IFormFile` パラメーターに適用されるのと同じ規則です。

### 2. 辞書パラメーターを残してクライアント側を直す

クライアントが自分の管理下にあり、エンドポイントのシグネチャーを変えられない場合は、ルートレベルの角かっこ付きキーを送るだけで済みます。

```bash
curl -X POST http://localhost:5222/dict \
  -F "[author]=marius" -F "[env]=prod" -F "file=@a.txt"
```

これは動作しますし、変更はキーあたり 1 文字です。ただし半年後にハンドラーを読む人が誰も推測できない形式でもあり、辞書パラメーターが 2 つになると成立しません (落とし穴の節を参照してください)。応急処置として扱ってください。

### 3. フォームを自分で読む

もっとも明示的で、Request Delegate Generator を通過できる唯一の選択肢です。`IFormCollection` はマッピング層をまったく介さずフォーム全体のパラメーターとしてバインドされるので、キーの規約は自分で決められます。

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", (IFormCollection form) =>
{
    var metadata = form
        .Where(kv => kv.Key.StartsWith("metadata[", StringComparison.Ordinal) && kv.Key.EndsWith(']'))
        .ToDictionary(kv => kv.Key[9..^1], kv => kv.Value.ToString());

    return Results.Text($"metadata={JsonSerializer.Serialize(metadata)}, files={form.Files.Count}");
}).DisableAntiforgery();
```

```text
metadata={"author":"marius","env":"prod"}, files=1
```

冗長ではありますが、`metadata[author]` をそのまま受け付けますし、キーが不正なときには黙った `null` ではなく本物のエラー経路が得られます。

### 4. メタデータを 1 つの JSON フィールドとして送る

メタデータが本当に自由形式なら、フォームキーとしてモデリングするのをやめましょう。JSON ドキュメントを保持する 1 つのフォームフィールドは、`string` が上記の述語を短絡させるため、シンプルな経路でバインドされます。

```csharp
// .NET 10.0.201, ASP.NET Core 10.0.5
app.MapPost("/upload", ([FromForm] string metadata, IFormFile file) =>
{
    var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(metadata);
    return Results.Text($"metadata={JsonSerializer.Serialize(parsed)}, file={file?.FileName}");
}).DisableAntiforgery();
```

```bash
curl -X POST http://localhost:5222/upload \
  -F 'metadata={"author":"marius","env":"prod"}' -F "file=@a.txt"
```

キーの構文と格闘せずにネストした値、配列、文字列以外の型を扱えるのはこの方法だけで、AOT 下でも同じように動作します。

## 落とし穴と派生ケース

- **`null` は検証エラーではありません。** パラメーターの型は null 許容でない `Dictionary<string, string>` なのに、ハンドラーは `null` を受け取り、レスポンスは `200`、ログには何も残りません。マッパーは一致するキーを 1 つも見つけられないと `default(T)` を返し、フォームからバインドされる複合型パラメーターが必須として扱われることはありません。`null` をチェックするか、パラメーターを null 許容にしてコンパイラーに気づかせてください。`= new()` のようなプロパティ初期化子も助けにはなりません。プレフィックスに一致するキーが 1 つもなければ、ラッパーオブジェクト自体が `null` で返ってきます。

- **`[FromForm(Name = "metadata")]` はプレフィックスを設定しません。** 修正のように読めますが違います。この名前は追跡対象パラメーターの検索に使われ、マッパーが動く前に捨てられます。`[FromForm(Name = "metadata")] Dictionary<string, string> metadata` は依然として `metadata[author]` ではなく `[author]` からバインドされます。

- **複合型のフォームパラメーターが 2 つあると衝突します。** どちらも空のプレフィックスでバインドされるため、同じキーを読みます。`[FromForm] Dictionary<string, string> first, [FromForm] Dictionary<string, string> second` を受け取るエンドポイントに `[a]=1&[b]=2` を送ると `first={"a":"1","b":"2"} second={"a":"1","b":"2"}` が返ります。警告は一切ありません。これだけでもラッパークラスを選ぶ理由になります。

- **配列とリストは互いに挙動が違います。** `List<string> tags` は複合型なので `[0]`、`[1]` が必要です。`int[] ids` は要素型が `TryParse` 可能なのでシンプルな経路を通り、繰り返しの `ids=1&ids=2` からバインドされます。そして `[FromForm] string[] tags` は .NET 10 では起動時に `InvalidOperationException: TryParse method found on string with incorrect format` で落ちます。`string` が span ベースの `TryParse` を公開するようになり、バインドメソッドのキャッシュがそれを無視せず拒否するからです。これが [dotnet/aspnetcore#62326](https://github.com/dotnet/aspnetcore/issues/62326) で、[PR #63072](https://github.com/dotnet/aspnetcore/pull/63072) で修正されました。マージコミットはすべての `v11.0.0-preview` タグの祖先であり、`v10.0.0` と `v10.0.5` のいずれの祖先でもないため、このクラッシュは .NET 10 のライフサイクル全体にわたって残ります。

- **既定値が 1024 の制限が 2 つあります。** 1025 個のキーを送ると `FormPipeReader` から `InvalidDataException: Form value count limit 1024 exceeded` が返ります。これは `FormOptions.ValueCountLimit` です。`services.Configure<FormOptions>(o => o.ValueCountLimit = 5000)` で引き上げると、次の壁に当たります。`The number of elements in the dictionary exceeded the maximum number of '1024' elements allowed` で、これはマッパー自身の上限です。こちらはエンドポイント単位で、`.WithFormMappingOptions(maxCollectionSize: 5000)` を使います。両方が必要で、片方だけ上げると修正が何も効いていないように見えます。アップロードがキー数ではなくバイトサイズで大きい場合は、[ファイルアップロード時の 413 Request Entity Too Large](/ja/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)でサイズベースの制限を扱っています。

- **フォームバインドには antiforgery の配線が必須です。** フォームからバインドされるパラメーターを持つ minimal API エンドポイントは、すべて antiforgery のメタデータを帯びます。アプリケーションが `app.UseAntiforgery()` を一度も呼ばない場合、リクエストは `InvalidOperationException: Endpoint HTTP: POST /upload contains anti-forgery metadata, but a middleware was not found that supports anti-forgery` と `500` で失敗します。ミドルウェアを追加するか、マシン間通信のエンドポイントで `.DisableAntiforgery()` を呼んでください。ブラウザーが送信するエンドポイントで一括して無効化してはいけません。

- **Request Delegate Generator はこれらをすべて拒否します。** `EnableRequestDelegateGenerator` を `true` にするか `PublishAot` を指定してビルドすると、辞書パラメーターもラッパークラスも `warning RDG003: Unable to statically resolve parameter named 'metadata' for endpoint` を出します。エンドポイントは実行時生成にフォールバックしますが、それこそ AOT にはできないことです。`IFormCollection` は警告を出さないので、選択肢 3 が AOT で安全な形になります。RDG の残りの診断については[ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)を参照してください。

- **`Content-Type` の誤りは同じ問題に見えます。** リクエストが `multipart/form-data` や `application/x-www-form-urlencoded` ではなく `application/json` として届くと、黙った `null` ではなく `415` が返ります。これは別の失敗で修正方法も別であり、[minimal API エンドポイントからの 415 Unsupported Media Type](/ja/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)で扱っています。

覚えておくべき規則は短いものです。minimal API では、`[FromForm]` パラメーターが名前でアドレス指定されるのは、その型が 1 つの文字列からパースできる場合だけです。それ以外はすべて Blazor のフォームマッパーを通り、マッパーはフォームのルートから読み始め、あなたのパラメーターの名前を知りません。降りていけるクラスを与えれば、名前は戻ってきます。

## 関連記事

- [修正: ASP.NET Core 11 の minimal API エンドポイントで「415 Unsupported Media Type」が返る](/ja/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) は、フォームがそもそもバインダーに届かない場合について扱っています。
- [修正: ASP.NET Core エンドポイントへのファイルアップロードで「413 Request Entity Too Large」が返る](/ja/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) は、フォーム解析の手前で効くバイトサイズの制限を扱っています。
- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、Request Delegate Generator がバインドできるものとできないものを扱っています。
- [ASP.NET Core 11 における minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) は、両モデルのバインドの違いをより広く扱っています。
- [大きなファイルをストリーミングで Azure Blob Storage にアップロードする方法](/ja/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) は、アップロードが大きくなったときに `IFormFile` のバッファリングから離れる方法を扱っています。

## 参考資料

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-10.0) (コレクションと複合型へのフォームバインド、`IFormFile` コレクションの表、そして複合型やコレクションへのフォームバインドが Request Delegate Generator ではサポートされないという注記)。
- dotnet/aspnetcore, [RequestDelegateFactory.cs](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http.Extensions/src/RequestDelegateFactory.cs) (`useSimpleBinding` の述語と、プレフィックスなしで `FormDataMapper.Map<T>` を呼ぶ `BindComplexParameterFromFormItem`)。
- dotnet/aspnetcore の Issue [#62326](https://github.com/dotnet/aspnetcore/issues/62326) と PR [#63072](https://github.com/dotnet/aspnetcore/pull/63072) (`[FromForm] string[]` の起動時クラッシュと、.NET 11 で出荷されたシンプルバインドの修正)。
- Microsoft Learn, [RDG003: Unable to statically resolve parameter](https://learn.microsoft.com/aspnet/core/fundamentals/aot/request-delegate-generator/diagnostics/RDG003) (AOT 下でフォームマップされるパラメーターに対するコンパイル時診断)。

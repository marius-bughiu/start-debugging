---
title: "修正方法: ASP.NET Core が null 非許容の string プロパティに対して 400 \"The X field is required\" を返す"
description: "<Nullable>enable</Nullable> が有効な場合、MVC は null 非許容の参照型をすべて [Required(AllowEmptyStrings = true)] として扱います。省略可能なプロパティは string? にするか、既定値を与えるか、SuppressImplicitRequiredAttributeForNonNullableReferenceTypes を設定してください。"
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "validation"
  - "nullable-reference-types"
lang: "ja"
translationOf: "2026/09/fix-aspnetcore-400-the-field-is-required-non-nullable-string"
translatedBy: "claude"
translationDate: 2026-09-25
---

`[Required]` を付けた覚えのないプロパティで `"The Name field is required."` を伴う `400 Bad Request` が返る原因は、MVC の暗黙の必須ルールです。プロジェクトで `<Nullable>enable</Nullable>` が有効になっていると、バインドされるモデルやアクションのパラメーターにある null 非許容の参照型はすべて、`[Required(AllowEmptyStrings = true)]` が付いているかのように検証されます。値が本当に省略可能なら `string?` として宣言してください。以前の動作をすべての箇所で維持したい場合は、`AddControllers` で `options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true` を設定します。本当に必須の値であれば、エラーはそのまま残し、明示的な `[Required]` でカスタマイズしてください。

以下の結果はすべて、コントローラーとミニマル API のエンドポイントの両方をホストする 1 つの `dotnet new web` プロジェクトを使い、ASP.NET Core 10.0.10 (SDK 10.0.302) で再現したものです。このルール自体は ASP.NET Core 3.0 から存在しているため、説明は 3.0 から .NET 11 までのすべてのバージョンに当てはまります。

## エラーが発生する状況

クライアントがプロパティを省略した JSON ボディを送信するか、そのプロパティを `null` として送信すると、アクションが実行される前に標準の `ValidationProblemDetails` ボディが返ってきます。

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Name": ["The Name field is required."]
  },
  "traceId": "00-41532a7ee5071512e476fa1aa31447c3-141fcd7662d71a76-00"
}
```

同じメッセージはクエリ文字列のパラメーター (`"q": ["The q field is required."]`) やフォームフィールドでも表示されますし、エンティティを直接バインドしている場合の EF Core のナビゲーションプロパティ (`"Customer": ["The Customer field is required."]`) でも非常によく見られます。`[ApiController]` がなければ自動的な 400 は返りませんが、`ModelState.IsValid` は同じエラーで `false` になります。Razor Pages や MVC のフォーム投稿ではこの形でこのエラーに遭遇します。

## 発生する理由

MVC の `DataAnnotationsMetadataProvider` は、バインドされるすべてのプロパティとパラメーターについて検証用のメタデータを構築します。参照型で明示的な `[Required]` がないものそれぞれについて、コンパイラーが記録した内容を `NullabilityInfoContext` に問い合わせます。読み取り状態が `NotNull` であれば、バリデーターのリストに `RequiredAttribute` を追加します。ASP.NET Core のソースにある該当コメントは率直で、"For non-nullable reference types, treat them as-if they had an implicit [Required]." と書かれています。

このコードの 4 つの細部が、遭遇するほぼすべてのケースを決定します。

1. **暗黙の属性は `AllowEmptyStrings = true` を使います。** 拒否するのは `null` だけで、`""` は拒否しません。`"name": ""` を含む JSON ボディは検証を通過します。
2. **フォームとクエリの値では空文字列も拒否されます。** MVC のモデルバインドが、検証の実行前に空の入力や空白のみの入力を `null` に変換するためです (`ConvertEmptyStringToNull` の既定値は `true`)。`?q=` と `?q=%20` はどちらも "The q field is required." で失敗します。
3. **既定値を持つパラメーターは対象外です。** `string sort = "name"` は暗黙に必須になることはありません。プロバイダーは `HasDefaultValue` が true のパラメーターをスキップするからです。
4. **null 注釈が無効なコード (oblivious) は対象外です。** 型が null 許容注釈を無効にした状態でコンパイルされている場合、読み取り状態は `NotNull` ではなく `Unknown` になるため、何も追加されません。モデルを 1 つも変更していないのに、古いプロジェクトで誰かが `<Nullable>enable</Nullable>` に切り替えた日にこのエラーが現れやすいのはこのためです。

これを行うのは MVC だけです。コントローラー、Razor Pages、MVC ビューはいずれも `DataAnnotationsMetadataProvider` を経由します。ミニマル API は経由しません。.NET 10 の `AddValidation()` による新しいソース生成の検証も同様で、これについては後述の注意点で扱います。

## 最小限の再現コード

```csharp
// ASP.NET Core 10.0.10, <Nullable>enable</Nullable>, Program.cs
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run();

public record CreateProduct(string Name, string? Nickname, string Sku = "");

public class Order
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!; // EF Core navigation
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController, Route("api")]
public class ProductsController : ControllerBase
{
    [HttpPost("create")] public IActionResult Create(CreateProduct p) => Ok(p);
    [HttpPost("order")]  public IActionResult Order(Order o) => Ok(o);
    [HttpGet("search")]  public IActionResult Search(string q) => Ok(q);
}
```

各リクエストの結果は次のとおりです。

| リクエスト | ステータス | エラーのキー |
| --- | --- | --- |
| `POST /api/create` に `{}` | 400 | `Name` |
| `POST /api/create` に `{"name":null}` | 400 | `Name` |
| `POST /api/create` に `{"name":""}` | 200 | なし |
| `POST /api/create` に `{"name":"x"}` | 200 | なし |
| `POST /api/order` に `{"title":"t","customerId":1}` | 400 | `Customer` |
| `GET /api/search` | 400 | `q` |
| `GET /api/search?q=` | 400 | `q` |

`Nickname` (`string?` として宣言) と `Sku` (既定値を持つパラメーター) はエラーを一度も発生させませんでした。`Title` もエラーになりませんでした。初期化子 `= ""` があるため、プロパティが欠けていても JSON のデシリアライズ後は `""` のままであり、`""` は `AllowEmptyStrings = true` を満たすからです。

最も混乱を招くのは `Order` の行です。`Customer` が null 非許容なのは、必須のリレーションシップのために EF Core がそれを求めるからです。`= null!` で [CS8618](/ja/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) を黙らせると、今度は MVC が同じ注釈を読み取り、クライアントにボディで `Customer` オブジェクト全体を送るよう要求します。

## 修正 1: 省略可能な値を null 許容として宣言する (推奨)

値が正当に存在しない可能性があるなら、型でそれを表すべきです。これで検証が修正され、アクション内ではコンパイラーの null チェックも得られます。

```csharp
// ASP.NET Core 10.0.10
public record CreateProduct(string Name, string? Nickname, string? Description);

[HttpGet("search")]
public IActionResult Search(string? q) => Ok(q ?? "(all)");
```

妥当なフォールバックがあるクエリやルートのパラメーターでは、既定値を使う方法も機能し、null チェックより読みやすくなります。

```csharp
// ASP.NET Core 10.0.10
[HttpGet("list")]
public IActionResult List(string sort = "name", int page = 1) => Ok(new { sort, page });
```

EF Core のエンティティについては、エンティティをバインドするのをやめるのが正しい修正です。`CustomerId` だけを持つリクエスト DTO を受け取り、それをマッピングします。

```csharp
// ASP.NET Core 10.0.10, EF Core 10
public record CreateOrder(string Title, int CustomerId);

[HttpPost("order")]
public async Task<IActionResult> Order(CreateOrder dto, AppDbContext db)
{
    var order = new Order { Title = dto.Title, CustomerId = dto.CustomerId };
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    return CreatedAtAction(nameof(Order), new { id = order.Id }, new { order.Id });
}
```

エンティティのバインドをすぐには変更できない場合は、ナビゲーションプロパティに `[ValidateNever]` (`Microsoft.AspNetCore.Mvc.ModelBinding.Validation` 名前空間) を付けると、MVC はその検証をスキップします。

```csharp
// ASP.NET Core 10.0.10
[ValidateNever]
public Customer Customer { get; set; } = null!;
```

これを付けると、`{"title":"t"}` は問題なくバインドされ、`Customer` は `null` のままでした。これは応急処置であり、設計ではありません。クライアントがネストした `customer` オブジェクトを送信することは依然として可能で、EF Core はそれを喜んで挿入しようとします。

## 修正 2: 暗黙のルールをグローバルに無効にする

大規模な既存 API で null 許容参照型を有効にしていて、すべてのモデルを一度に監査できない場合は、`AddControllers` (または `AddMvc`、`AddRazorPages().AddMvcOptions(...)`) で推論を抑制します。

```csharp
// ASP.NET Core 10.0.10, Program.cs
builder.Services.AddControllers(options =>
{
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true;
});
```

このオプションを設定すると、上の表のすべての行が 200 を返しました。例外は空のクエリで、これは `204 No Content` を返しました。アクションが `null` を受け取り、`Ok(null)` が 204 になるためです。これが何を意味するかに注意してください。シグネチャは `string q` なのに、アクションは `q == null` の状態で実行されました。400 と引き換えに、コンパイラーが null にならないと保証している値を受け取ったことになります。これは移行用のスイッチとして扱い、モデルに正直な注釈を付け終えたら削除する計画を立ててください。

## 修正 3: ルールは維持し、メッセージを自分で管理する

プロパティが本当に必須であれば、暗黙の検証は役目を果たしており、不満は文言だけです。明示的な属性は暗黙の属性を置き換えます (プロバイダーは `[Required]` が存在しない場合にのみ独自の属性を追加します)。

```csharp
// ASP.NET Core 10.0.10
using System.ComponentModel.DataAnnotations;

public class CreateCustomer
{
    [Required(AllowEmptyStrings = false, ErrorMessage = "Customer name is required.")]
    public string Name { get; set; } = default!;
}
```

これは、暗黙のルールでは決して起きない、空の JSON 文字列を失敗させる方法でもあります。私の再現環境では、素の `[Required]` (`AllowEmptyStrings` の既定値は `false`) が `{"name":""}` を 400 で拒否しました。逆に、`[Required(AllowEmptyStrings = true)]` は再現環境で `""` を受け入れ、暗黙の動作と一致しました。

メッセージではなくレスポンスの形を変えたい場合、それは検証ではなく problem details の問題です。[IProblemDetailsService による検証エラーレスポンスのカスタマイズ](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) の方法はコントローラーでも機能します。

## 注意点とよく似たエラー

**ミニマル API は動作が異なります。** 同じ `CreateProduct` レコードをミニマル API のエンドポイントでバインドすると、`builder.Services.AddValidation()` を登録し、別のプロパティに `[StringLength(20)]` を付けていても (違反時には 400 になったので、バリデーターは動作していました)、`{}` と `{"name":null}` を 200 で受け入れ、`Name == null` になりました。.NET 10 の検証ソースジェネレーターは属性を尊重しますが、null 許容性から `[Required]` を推論しません。[ミニマル API でリクエストボディを検証する](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) 場合は、`[Required]` を明示的に付けてください。ミニマル API の *パラメーター* は別の話です。null 非許容の `string q` クエリパラメーターが欠けていると、パラメーターバインダー自体が 400 を返し、Development 環境では例外ページに `BadHttpRequestException: Required parameter "string q" was not provided from query string.` と表示されます。

**C# の `required` キーワードは別のエラーです。** `public required string Name { get; set; }` は、MVC の検証より前のデシリアライズ中に System.Text.Json によって強制されます。再現環境でのボディは次のとおりでした。

```json
{
  "$": ["JSON deserialization for type 'ReqKw' was missing required properties including: 'name'."],
  "o": ["The o field is required."]
}
```

アクションのパラメーター名をキーとする 2 番目のエントリは、ここでも暗黙のルールによるものです。デシリアライズが失敗し、パラメーターは `null` のままになり、その結果 null 非許容のパラメーター `ReqKw o` にフラグが立ちました。パラメーターを `[FromBody] ReqKw? o` として宣言すると、このノイズとなるエントリは消えます。`required` キーワードと `[JsonRequired]` にはそれぞれ独自の相互作用があり、[System.Text.Json に required プロパティを無視させる方法](/ja/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/) と [CS9035](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) で扱っています。

**空のボディで "The p field is required" が出る。** `Create(CreateProduct p)` にボディをまったく付けずに投稿すると、`"": ["A non-empty request body is required."]` と `"p": ["The p field is required."]` の 2 つのエラーが返りました。パラメーターを `CreateProduct? p` にすると、空のボディは `p == null` として正常にバインドされます (アクションは `Ok(null)` から 204 を返しました)。そのため、エンドポイントにとって空のボディが妥当な場合にのみそうしてください。1 つ目のメッセージに対するグローバルなスイッチは `MvcOptions.AllowEmptyInputInBodyModelBinding` です。

**別のアセンブリの null 許容コンテキスト。** このルールが読み取るのは、Web プロジェクトではなく、モデルを宣言しているアセンブリの注釈です。`<Nullable>disable</Nullable>` でコンパイルされた共有ライブラリ内のモデルは、API プロジェクトで null 許容を有効にしていても暗黙の属性を受け取りません。逆も成り立ちます。共有ライブラリで null 許容を有効にすると、API プロジェクトに触れなくても API の動作が変わります。

**継承されたプロパティ。** 注釈は、そのプロパティを宣言しているメンバーから読み取られます。DTO が別のプロジェクトにある基底クラスから派生している場合、決め手になるのは派生型ではなく基底クラスの null 許容コンテキストです。`string?` のはずのプロパティがまだ "required" と報告される場合は、実際にどこで宣言されているかを探してください。

**値型には別の修正が必要です。** `int` が欠けていても、このルールはまったく発動しません (値型はスキップされます)。黙って `0` が既定値になります。"必ず指定する" ことが必要なら、`int?` に `[Required]` を組み合わせてください。

## 関連記事

- [ASP.NET Core 11 でコントローラーを使わずにミニマル API のリクエストボディを検証する方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)。ここでは属性だけが必須性の根拠になります。
- [ASP.NET Core 11 におけるミニマル API の検証と FluentValidation の比較](/ja/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/)。このようなルールをどこに置くべきか決めかねている場合に。
- [CS8618 の修正: null 非許容のプロパティには null 以外の値が含まれている必要があります](/ja/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)。同じ注釈のコンパイラー側の話です。
- [型付き HttpClient で RFC 9457 の ProblemDetails レスポンスを利用する方法](/ja/2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient/)。上記の `errors` ディクショナリを読み取るクライアント向けです。

## 参考資料

- Microsoft Learn の "Model validation in ASP.NET Core MVC and Razor Pages" にある [Non-nullable reference types and [Required] attribute](https://learn.microsoft.com/aspnet/core/mvc/models/validation#non-nullable-reference-types-and-required-attribute)。
- [`MvcOptions.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes) の API リファレンス。
- `release/10.0` ブランチの [`DataAnnotationsMetadataProvider.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Mvc/Mvc.DataAnnotations/src/DataAnnotationsMetadataProvider.cs)。`AllowEmptyStrings = true` の推論と `HasDefaultValue` による除外について。
- [dotnet/aspnetcore#16654](https://github.com/dotnet/aspnetcore/issues/16654)。継承されたプロパティでこのルールがユーザーを驚かせた初期の報告です。

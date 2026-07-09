---
title: "ASP.NET Core 11 で minimal API を手動の検証チェックから組み込み検証へ移行する"
description: "ASP.NET Core 11 の minimal API ハンドラーにある手書きの if チェックを、DataAnnotations とソースジェネレーターに基づく組み込みバリデーターへ置き換えるためのステップバイステップの移行ガイドです。何が壊れるか、どの手動ルールが移植できてどれができないか、そして 400 ProblemDetails の契約が同一のままであることをどう検証するかを扱います。"
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "ja"
translationOf: "2026/07/migrate-a-minimal-api-from-manual-validation-to-built-in-validation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-09
---

ASP.NET Core の minimal API が .NET 10 より前に作られたものなら、おそらく各ハンドラーは `if (string.IsNullOrWhiteSpace(...)) return Results.BadRequest(...)` というチェックのブロックで始まっているはずです。この移行では、それらの手書きのチェックを、.NET 10 で登場し .NET 11 でも変わらない組み込み検証へ置き換えます。`builder.Services.AddValidation()` を呼び出し、ルールを `DataAnnotations` 属性としてリクエスト record へ移し、手動のガードを削除します。エンドポイントが 15 から 40 個ある典型的なサービスなら、半日から 1 日ほどの機械的な作業を見込んでください。壊れるのはフレームワークではなく、あなたの前提です。手動ルールの一部は属性では表現できないこと（非同期ルックアップ、サービス間チェック）を行っており、また `ProblemDetails` を返す代わりに `BadRequest` の payload を手で組み立てていた場合は、エラー応答の形が変わることがあります。この移行に価値があるのは、コードを削除でき、検証を宣言的で再利用可能にでき、Native AOT 下でも trim セーフを保てるからです。さらにエンドポイント単位で元に戻せるため、段階的に進められます。以下はすべて `Microsoft.NET.Sdk.Web` と C# 14 を用いた .NET 11 を対象とします。この機能は最初に登場した .NET 10 でも同一です。

## なぜ手動チェックから離れるのか

手動のパターンは機能するので、移行の論拠は「古いやり方が壊れている」ではなく、保守性と正しさに関するものです。

- **コードを削除でき、ルールが宣言的になります。** record 上の `[Required, Length(3, 20)] string Sku` は、`Sku` を受け取るすべてのハンドラーにある命令的なチェック 3 行を置き換えます。制約はデータのすぐそばに一度だけ書きます。
- **一貫性のないエラー形を返さなくなります。** 手書きの `Results.BadRequest("Sku is required")` は、書いた人によって、あるエンドポイントでは素のstring を、別のエンドポイントでは JSON オブジェクトを返します。組み込みバリデーターはどこでも単一の `HttpValidationProblemDetails`（RFC 9457）ボディを、プロパティ名をキーとして返します。
- **検証は trim セーフのままです。** この機能は実行時のリフレクションではなくコンパイル時のソースジェネレーターなので、Native AOT と積極的な trim の下でもクリーンに発行されます。同じ理由で [Native AOT の minimal API スタック](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)にも付属します。
- **query、ルート、ヘッダーのパラメーターも検証されます。** 手動チェックはほぼ必ず JSON ボディをカバーし、ページングのパラメーターを忘れます。組み込みフィルターは、ルートと query 文字列からバインドされたスカラーのパラメーターを同じ属性で検証します。

## 何が壊れるか

フレームワーク自体は壊れませんが、次の 5 つは変わるため、手動ルールのどれが移植を生き延びるかを知る必要があります。

| 領域                                | 変更                                                                                                | 重大度 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| エラー応答ボディ                    | 素のstring や独自の `BadRequest(...)` ボディが、プロパティをキーとする `ProblemDetails`（RFC 9457）になる | 高     |
| 非同期 / DB ルール                  | `if (await repo.SkuExists(...))` は属性にできない。別の置き場所が必要                                 | 高     |
| リクエスト型のアクセシビリティ      | record は `public` でなければならず、そうでないとジェネレーターは何も出力せず検証は静かに動かない     | 高     |
| フィールド間ルール                  | 複数プロパティの `if` ブロックは属性ではなく `IValidatableObject` へ移る                              | 中     |
| エラーテキストを検証するテスト      | 古い独自メッセージ文字列を検証するテストは新しい `ProblemDetails` に対して失敗する                    | 中     |
| ハンドラーの戻り値型                | ハンドラーは `BadRequest` の分岐を落とせる。フィルターがハンドラー実行前に 400 を生成する             | 低     |

移行の形を決める重大度「高」の 2 行は、エラーボディと非同期ルールです。クライアントが現在の 400 ボディをパースしているなら、契約の変更か互換シムを計画してください。手動チェックのいずれかが I/O を待つなら、そのルールは属性にはまったくならず、そうでないふりをすることが、この移行がうまくいかない最も一般的な原因です。

## 事前チェックリスト

ハンドラーに触れる前に。

- **SDK。** .NET 10 または 11 の SDK をインストールします。`dotnet --version` で確認します（`11.0.x` または `10.0.x` を期待）。
- **Web SDK。** プロジェクトは `Microsoft.NET.Sdk.Web` を使う必要があります。検証ソースジェネレーターは、`AddValidation()` を呼び出した時点でその SDK により接続されます。
- **現在の契約のベースラインを取る。** エンドポイントが今日返す正確な 400 応答を捕捉します（ファイルに保存した `curl` 呼び出しをいくつか、またはスナップショットテスト）。あなたはこの形を変えようとしているので、変更前の記録が欲しいのです。
- **grep で対象範囲を洗い出す。** 進捗を追えるよう、各手動チェックを見つけます。`grep -rn "return Results.BadRequest\|return TypedResults.BadRequest" src/`。そのリストが移行のバックログです。
- **非同期チェックを棚卸しする。** 別途、ハンドラー内で `grep -rn "await" src/` を行い、`BadRequest` を左右するものに印を付けます。それらが属性にならないルールです。
- **テストスイートか smoke スクリプトを用意する。** 各エンドポイントのあとに何かを実行して、有効なリクエストが引き続き通り、無効なリクエストが引き続き 400 になることを確認したいはずです。

## 移行の手順

### 1. 組み込み検証を有効にする

アプリをビルドする前にサービスを登録します。これは移行が必要とする唯一のグローバルな配線です。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();   // registers the validation services and endpoint filter
var app = builder.Build();
```

現在の .NET 10 または 11 の web SDK では、`AddValidation()` が存在すればソースジェネレーターは自動的に有効になります。trim 済みの `.csproj` をコピーした場合や、ビルドが GA より前の場合は、インターセプターの名前空間を明示的に追加します。

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

**検証：** アプリは引き続きビルドされ起動します。`dotnet build` はエラー 0 を報告します。どの型もまだ属性を持たないため、動作はまだ何も変わっていません。

### 2. フィールド単位のルールをリクエスト record へ移す

エンドポイントを 1 つ取ります。その手動チェックを読み、属性で表現できる各ルールをリクエスト型上の `DataAnnotations` 属性へ翻訳します。次が変更前で、検証をインラインで抱えるハンドラーです。

```csharp
// .NET 11, C# 14 -- BEFORE: manual checks
app.MapPost("/products", (CreateProduct product) =>
{
    if (string.IsNullOrWhiteSpace(product.Sku) || product.Sku.Length is < 3 or > 20)
        return Results.BadRequest("Sku must be 3 to 20 characters.");
    if (string.IsNullOrWhiteSpace(product.Name) || product.Name.Length < 2)
        return Results.BadRequest("Name is required and must be at least 2 characters.");
    if (product.Quantity is < 1 or > 10_000)
        return Results.BadRequest("Quantity must be between 1 and 10000.");

    return Results.Created($"/products/{product.Sku}", product);
});

public record CreateProduct(string Sku, string Name, int Quantity);
```

そして変更後です。ルールは属性として record へ移り、ハンドラーはガードブロックを失い、ジェネレーターが見えるように型は `public` になります。

```csharp
// .NET 11, C# 14 -- AFTER: declarative validation
using System.ComponentModel.DataAnnotations;

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

型が `public` になった点に注意してください。これは、移行したエンドポイントが静かに検証をやめる最も一般的な理由です。ジェネレーターは名前を付けられる型に対してのみコードを出力できるため、既定のファイル内部アクセシビリティのまま残された `record` は、検証もエラーも得られません。

**検証：** `curl -i -X POST .../products -d '{"sku":"x","name":"","quantity":0}'` は、`Sku`、`Name`、`Quantity` を列挙する `ProblemDetails` ボディ付きで `400` を返します。有効なボディは引き続き `201` を返します。

### 3. フィールド間ルールを IValidatableObject へ移す

属性は 1 度に 1 つのメンバーを検証します。2 つのフィールドを比較していた手動チェック（「終了は開始より後」「割引には理由が必要」）は属性になりません。代わりにリクエスト record 上で `IValidatableObject` を実装します。

```csharp
// .NET 11, C# 14 -- cross-field rule ported from a manual if-block
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

第 2 引数として渡すメンバー名の配列が、エラーがどのキーに入るかを制御するので、UI で強調したいフィールドを渡します。`Validate` は属性チェックの後に実行されるため、`null` の `Start` はフィールド間ロジックが動く前にすでに `[Required]` によって報告されています。

**検証：** `End <= Start` となる範囲を POST し、エラーキーがモデルレベルの空キーではなく `End` であることを確認します。

### 4. 非同期・サービス間チェックを置き直す

これは、事前の `await` の grep から得た移行バックログが流れ込む手順です。「SKU がカタログにすでに存在するなら拒否する」のようなルールはデータベースにアクセスしますが、`DataAnnotations` も `IValidatableObject` も待機できません。誠実な選択肢は 2 つあります。

その特定のチェックを、組み込みバリデーターがすでに形の有効性を保証した後で、ハンドラー内の明示的な呼び出しとして残します。

```csharp
// .NET 11, C# 14 -- async rule stays explicit, but shape is pre-validated
app.MapPost("/products", async (CreateProduct product, IProductRepository repo, CancellationToken ct) =>
{
    // Built-in validation already ran: Sku is non-null, 3-20 chars, Quantity in range.
    if (await repo.SkuExistsAsync(product.Sku, ct))
        return Results.Conflict($"A product with SKU {product.Sku} already exists.");

    await repo.AddAsync(product, ct);
    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

あるいは、非同期ルールが多いなら、まさにそれらのリクエスト型のためだけに FluentValidation を残し、単純なものは組み込み機能に任せます。トレードオフは [minimal API 検証と FluentValidation の比較](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/)で詳しく述べています。短く言えば、非同期ルールと豊かな条件ロジックが、検証ライブラリを残す 2 つの理由です。`DbContext` の呼び出しを `IValidatableObject` へ無理に押し込もうとしないでください。これは同期であり、スレッドをブロックするか、`.Result` によるデッドロックの領域へ押しやります。

**検証：** 一意性チェックは引き続き重複した SKU を拒否し（今度は `409`、または選んだ任意のステータスとして）、初めての SKU は引き続き成功します。

### 5. 独自の ValidationAttribute でルールを再利用する

同じ手動チェックが 3 つのハンドラーに現れていたら（「この日付は過去にできない」）、`IValidatableObject` を 3 つの record にコピーしないでください。`ValidationAttribute` を 1 つ書けば、ジェネレーターは組み込み属性と同じように拾います。

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

これが、重複した `if` ブロックに対する属性ベースの答えです。ルールは一度だけ存在し、その型が使われるあらゆる場所に適用されます。

**検証：** 以前は同じ日付チェックを繰り返していたエンドポイントが、今はその属性で過去の日付を拒否し、その型を共有する他のエンドポイントはルールを継承します。

### 6. 死んだガードコードを削除し、戻り値型を単純化する

エンドポイントのルールが宣言的になったら、手動の `if` ブロックを完全に取り除き、ハンドラーの宣言された戻り値型を単純化します。400 はハンドラー本体が動く前にエンドポイントフィルターが生成するので、ハンドラーはその `Results<...>` ユニオンに `BadRequest` の分岐をもう必要としません。

```csharp
// .NET 11, C# 14 -- return type no longer needs BadRequest
app.MapPost("/products", (CreateProduct product)
    => TypedResults.Created($"/products/{product.Sku}", product))
   .Produces<CreateProduct>(StatusCodes.Status201Created)
   .ProducesValidationProblem();   // documents the 400 the filter produces
```

**検証：** OpenAPI は引き続き（`ProducesValidationProblem` 経由で）`400` を告知し、エンドポイントは取り除いたユニオン分岐なしでコンパイルされます。

## 検証

一群のエンドポイントを移行したら、完了と呼ぶ前にこのチェックリストを一通り確認します。

- **ビルドされる。** `dotnet build` は警告 0、エラー 0 を報告します。特に何も出ないことに注意してください。`public` が欠けた型は、大声ではなく静かに失敗するからです。それを次の項目が捕まえます。
- **移行した各エンドポイントが実際に検証する。** 無効リクエストの `curl` 呼び出し（またはテスト）を、移行した各エンドポイントに対して再実行します。拒否されるはずのボディに対して `201` を返すエンドポイントは、ジェネレーターが型を見なかったことを意味します。まずアクセス修飾子を確認してください。
- **有効なリクエストが引き続き通る。** 正常系が以前と同じ成功ステータスを返すことを確認します。
- **エラー契約がクライアントの期待どおり。** 新しい `ProblemDetails` ボディを、変更前のベースラインと比較します。クライアントが `errors` 辞書をパースするなら、キーがそのクライアントの期待するプロパティ名と一致することを確認します。
- **テストスイートが緑。** `dotnet test` が通ります。古い独自エラー文字列を検証していたテストは失敗して当然です。移行を巻き戻すのではなく、`ProblemDetails` の形を検証するように更新してください。
- **起動時のパフォーマンス低下がない。** この機能はソース生成なので、起動は横ばいかわずかに速くなるはずです（コードを削除したため）。一部の型に FluentValidation を残した場合、その初回使用時の式コンパイルはそれらの型に引き続き適用されます。

## ロールバック計画

この移行は元に戻せて、さらに良いことに段階的なので、完全なロールバックが必要になることはめったにありません。2 つのレベルがあります。

- **エンドポイント単位で、コードを戻さずに。** 移行したエンドポイントが本番で誤動作したら、それに `DisableValidation()` を連結して、グローバル登録と他のすべての検証済みエンドポイントを保ったまま、そのルートについてだけフィルターをオフにします。

  ```csharp
  // .NET 11, C# 14 -- disable validation on a single endpoint
  app.MapPost("/internal/import", (CreateProduct product)
      => TypedResults.Accepted($"/products/{product.Sku}", product))
     .DisableValidation();
  ```

- **完全な巻き戻し。** エンドポイント単位で移行したため、各エンドポイントの diff は自己完結しています。手動の `if` ブロックを復元し、他のエンドポイントが依存していなければ record から属性を取り除きます。グローバルな `AddValidation()` 呼び出しを削除すれば、他のコード変更なしに機能を完全にオフにできます。この移行にフレームワークレベルで一方通行なものは何もありません。

## 私たちがぶつかった落とし穴

時間を要した実際の問題と、その解決策です。

- **非 `public` 型による静かな no-op。** 群を抜いて頻繁です。属性を `record CreateProduct(...)` へ移し、ビルドは成功するのに、型が `public` でないため検証は決して発火しません。警告はありません。移行したエンドポイントが不正な入力を拒否しなくなったら、まずアクセス修飾子を確認してください。
- **位置指定 record の属性ターゲット。** 位置指定 record では、`[Required] string Name` は検証ジェネレーターが直接読み取ります。明示的なターゲット `[property: Required] string Name` が必要なのは、別のツールが実行時に生成されたプロパティをリフレクトする場合だけです。2 つの期待を混同することが、「なぜこの属性は無視されるのか」という混乱のよくある原因です。
- **入れ子オブジェクトは再帰的に検証され、驚くことがあります。** リクエスト record が `BillingAddress` record を参照していると、ジェネレーターは住所も検証し、エラーキーは `Billing.PostalCode` のようなドット区切りのパスを使います。古い手動コードが最上位オブジェクトだけをチェックしていた場合、以前は決して検証しなかった入れ子フィールドで 400 が出るようになることがあります。通常はこれが正しいのですが、想定しておくべき動作の変化です。
- **フィルターの順序。** 検証はエンドポイント単位のフィルターとして実行されます。すでに独自の `AddEndpointFilter` 呼び出しを追加しているなら、検証がチェーンのどこに位置するかを、特にルートグループをまたいで把握してください。合成のルールは [MapGroup による minimal API エンドポイントの整理](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)にあるものと同じです。
- **エラー契約を誤って静かに変えない。** 移行後の `ProblemDetails` を特定の形（独自の `type` URI、追加メンバー）に合わせたいなら、エンドポイント単位ではなく一元的に形を整えてください。仕組みは [IProblemDetailsService による minimal API 検証エラー応答のカスタマイズ](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)にあります。

持ち帰るべきメンタルモデルはこうです。この移行は新しいフレームワークの採用ではなく、命令的なガードコードを削除し、同じルールをリクエスト型上で宣言的に表現し直すことです。属性で表現できるルールは `DataAnnotations` へ、フィールド間のものは `IValidatableObject` へ、再利用可能なものは独自の `ValidationAttribute` へ移り、非同期のものは形がすでに有効と保証された後にハンドラー内で明示的なまま残ります。エンドポイントを 1 つずつ進め、それぞれを無効リクエストの呼び出しで検証すれば、各ハンドラーを開いていた `if` ブロックの定型コードは、ただ消えてなくなります。

## 関連

- [ASP.NET Core 11 でコントローラーなしに minimal API のリクエストボディを検証する方法](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)：移行先の組み込み機能の完全なセットアップについて。
- [ASP.NET Core 11 における minimal API 検証と FluentValidation の比較](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/)：何を検証ライブラリに残し、何を組み込みへ移すかの判断について。
- [ASP.NET Core 11 で IProblemDetailsService により minimal API 検証エラー応答をカスタマイズする方法](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)：移行後の 400 ボディの整形について。
- [ASP.NET Core 11 における minimal API とコントローラーの比較](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)：この下地となるエンドポイントモデルの判断について。
- [ASP.NET Core 11 で MapGroup により minimal API エンドポイントを整理する方法](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)：検証フィルターがグループフィルターに対してどこに位置するかについて。

## 出典

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0)（minimal API の組み込み検証、`AddValidation`、ソースジェネレーター、`DisableValidation`、`ProblemDetails`）。
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations)（`ValidationAttribute`、`IValidatableObject`、`ValidationResult`）。
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis)（入れ子オブジェクトの検証、ジェネレーターによる探索、エラーの形）。

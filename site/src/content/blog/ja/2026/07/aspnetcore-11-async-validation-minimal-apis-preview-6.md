---
title: ".NET 11 Preview 6 で非同期バリデーションが Minimal API に対応"
description: "Preview 6 は AsyncValidationAttribute と IAsyncValidatableObject を追加し、DataAnnotations のルールがスレッドをブロックせずに、エンドポイントの実行前にデータベースへ問い合わせられるようにします。"
pubDate: 2026-07-20
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "validation"
  - "minimal-apis"
  - "csharp"
lang: "ja"
translationOf: "2026/07/aspnetcore-11-async-validation-minimal-apis-preview-6"
translatedBy: "claude"
translationDate: 2026-07-20
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) は、DataAnnotations が登場以来抱えてきたギャップを埋めます。バリデーションは同期的でした。ルールがデータベースを確認する必要がある場合（このメールはすでに使われているか、この枠はまだ空いているか）、`IsValid` の中でスレッドをブロックするか、DataAnnotations をあきらめて FluentValidation に頼るしかありませんでした。Preview 6 は第一級の非同期バリデーターを追加し、.NET 10 で導入された Minimal API の組み込みバリデーションに組み込みます。

## 2 つの新しいフック

`System.ComponentModel.DataAnnotations` に 2 つの型が登場します。1 つ目は単一メンバー向けのルールである `AsyncValidationAttribute` です。

```csharp
public sealed class UniqueEmailAttribute : AsyncValidationAttribute
{
    // Still required, but throws if the attribute is async-only.
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
        => throw new InvalidOperationException("Use IsValidAsync.");

    protected override async Task<ValidationResult?> IsValidAsync(
        object? value, ValidationContext context, CancellationToken cancellationToken)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var exists = await db.Users.AnyAsync(u => u.Email == (string?)value, cancellationToken);
        return exists ? new ValidationResult("Email is already registered.") : ValidationResult.Success;
    }
}
```

2 つ目は、複数のプロパティにまたがる、あるいはオブジェクト全体を必要とするルール向けの `IAsyncValidatableObject` です。これは `IAsyncEnumerable<ValidationResult>` を返し、`IValidatableObject` を拡張しているため、同期の `Validate`（非同期でのみバリデーションする場合は例外をスローします）も実装します。

```csharp
public class ReservationRequest : IAsyncValidatableObject
{
    public DateOnly Date { get; set; }
    public int PartySize { get; set; }

    public IEnumerable<ValidationResult> Validate(ValidationContext context)
        => throw new InvalidOperationException("Use ValidateAsync.");

    public async IAsyncEnumerable<ValidationResult> ValidateAsync(
        ValidationContext context,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var db = context.GetRequiredService<AppDbContext>();
        var taken = await db.Reservations.CountAsync(r => r.Date == Date, cancellationToken);
        if (taken + PartySize > 40)
            yield return new ValidationResult("No capacity left for that date.", [nameof(PartySize)]);
    }
}
```

## 組み込み方

.NET 10 ですでに導入された `AddValidation()` の呼び出しを超える新しいオプトインはありません。これを登録すると、フレームワークはエンドポイントの本体が実行される前に非同期バリデーターを実行します。

```csharp
builder.Services.AddValidation();

app.MapPost("/reservations", (ReservationRequest request) => Results.Ok(request));
```

不正なリクエストは、同期パスとまったく同じように、`ValidationProblemDetails` のペイロードを伴う `400` で短絡します。内部的にはベースライブラリの新しい `Validator.ValidateObjectAsync` API に乗っているため、ASP.NET Core の外でも動作します。

## 知っておく価値のある点

非同期バリデーションは、うっかり直列のラウンドトリップを招きがちです。そのためフレームワークは可能な限り処理を並行して実行します。同じメンバー上の非同期属性は同時に開始し、コレクションの項目は並列にバリデーションされます。それでもメンバー、型、`IValidatableObject` の間の既存の順序は保たれるため、安価な `[Required]` チェックはデータベースへのクエリのコストを払う前に素早く失敗します。これを Preview 6 の[自動 CSRF 保護](/ja/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)と組み合わせれば、組み込みパイプラインは 1 バージョン前よりもはるかに広い範囲をカバーします。

.NET 11 Preview 6 SDK を入手し、`net11.0` をターゲットにして、バリデーターの全体像については [ASP.NET Core のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)を参照してください。

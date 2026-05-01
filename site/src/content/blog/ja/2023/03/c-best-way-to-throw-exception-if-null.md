---
title: "C# null のときに例外をスローする: ArgumentNullException.ThrowIfNull (.NET 6+)"
description: ".NET 6+ では ArgumentNullException.ThrowIfNull で null チェックを簡潔に記述できます。古いフレームワークでは C# 7+ の throw 式を使用してください。"
pubDate: 2023-03-11
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ja"
translationOf: "2023/03/c-best-way-to-throw-exception-if-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 6 では例外をスローするための新しいヘルパーメソッドがいくつか導入されており、そのひとつが **ThrowIfNull** です。使い方は簡単です。

```cs
ArgumentNullException.ThrowIfNull(myParam);
```

このメソッドは **myParam** が **null** の場合に **ArgumentNullException** をスローします。null でない場合は何も行いません。

ThrowIfNull は 2 つのパラメーターを受け取れます。

-   **object? argument** -- null かどうかをチェックする参照型オブジェクト
-   オプション: **string? paramName** -- チェック対象のパラメーター名。

**メモ:** paramName は **CallerArgumentExpressionAttribute** を使ってパラメーター名を自動的に取得するため、ほとんどの場面では指定する必要はありません。フレームワーク側で引数名を正しく判別できます。

## throw 式

まだ .NET 6 以降を使えない場合でも、C# 7+ が使えるなら、throw 式を活用してコードを読みやすくできます。

```cs
var myVar = myParam ?? throw new ArgumentNullException(nameof(myParam), "Parameter is required.");
```

あるいは、独自の ThrowIfNull 実装を定義する方法もあります。

```cs
/// <summary>Throws an <see cref="ArgumentNullException"/> if <paramref name="argument"/> is null.</summary>
/// <param name="argument">The reference type argument to validate as non-null.</param>
/// <param name="paramName">The name of the parameter with which <paramref name="argument"/> corresponds.</param>
public static void ThrowIfNull([NotNull] object? argument, [CallerArgumentExpression("argument")] string? paramName = null)
{
    if (argument is null)
    {
        throw new ArgumentNullException(paramName);
    }
}
```

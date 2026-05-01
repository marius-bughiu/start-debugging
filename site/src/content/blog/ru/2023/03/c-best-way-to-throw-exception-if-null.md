---
title: "C# выбросить исключение при null: ArgumentNullException.ThrowIfNull (.NET 6+)"
description: "Используйте ArgumentNullException.ThrowIfNull в .NET 6+ для лаконичных проверок на null или throw-выражения в C# 7+ для более ранних фреймворков."
pubDate: 2023-03-11
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "ru"
translationOf: "2023/03/c-best-way-to-throw-exception-if-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 6 ввёл несколько новых вспомогательных методов для выброса исключений, и один из них - **ThrowIfNull**. Использование простое:

```cs
ArgumentNullException.ThrowIfNull(myParam);
```

Метод выбросит **ArgumentNullException**, если **myParam** равен **null**. Иначе он ничего не сделает.

ThrowIfNull может принимать два параметра:

-   **object? argument** -- объект ссылочного типа, который нужно проверить на null
-   Необязательный: **string? paramName** -- имя проверяемого параметра.

**Примечание:** paramName использует **CallerArgumentExpressionAttribute**, чтобы автоматически получить имя вашего параметра, поэтому в большинстве сценариев его указывать не придётся - фреймворк сам корректно определит имя аргумента.

## throw-выражения

Если вы ещё не на .NET 6 или новее, но можете использовать C# 7+, то для повышения читаемости кода подойдут throw-выражения:

```cs
var myVar = myParam ?? throw new ArgumentNullException(nameof(myParam), "Parameter is required.");
```

Либо можно определить собственную реализацию ThrowIfNull, например так:

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

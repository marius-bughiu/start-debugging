---
title: "Polars.NET: движок DataFrame на Rust для .NET 10, опирающийся на LibraryImport"
description: "Новый проект Polars.NET в тренде после поста сообщества от 6 февраля 2026 года. Заголовок прост: дружественный к .NET API DataFrame, поддерживаемый Rust Polars, со стабильным C ABI и interop на основе LibraryImport, чтобы поддерживать низкие накладные расходы."
pubDate: 2026-02-08
tags:
  - "dotnet"
  - "csharp"
  - "performance"
  - "interop"
lang: "ru"
translationOf: "2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport"
translatedBy: "claude"
translationDate: 2026-04-25
---

Пост сообщества от 6 февраля 2026 года поставил **Polars.NET** на мой радар: движок DataFrame для .NET, поддерживаемый ядром Rust **Polars**, предоставляющий API как для C#, так и для F#. Предложение не "у нас есть DataFrame". Это "у нас есть DataFrame, который честен в отношении того, откуда берётся производительность".

Если вы строите на **.NET 10** и **C# 14**, детали -- это вся история: стабильный C ABI, заранее собранные нативные бинарники для всех платформ, и современный interop через `LibraryImport`.

## Почему `LibraryImport` важен для interop большого объёма

`DllImport` работает, но легко случайно платить за marshaling и аллокации на горячих путях. `LibraryImport` (interop, генерируемый из исходников) -- это направление, в котором движется .NET: он может генерировать клеящий код, избегающий накладных расходов на marshaling во время выполнения, когда вы придерживаетесь blittable-сигнатур и явных spans.

Именно этот шаблон заявляет использовать Polars.NET. Минимальный пример выглядит так:

```csharp
using System;
using System.Runtime.InteropServices;

internal static partial class NativePolars
{
    // Name depends on platform: polars.dll, libpolars.so, libpolars.dylib.
    [LibraryImport("polars", EntryPoint = "pl_version")]
    internal static partial IntPtr Version();
}

static string GetNativeVersion()
{
    var ptr = NativePolars.Version();
    return Marshal.PtrToStringUTF8(ptr) ?? "<unknown>";
}
```

Важная часть -- не `pl_version`. Это форма: держите границу тонкой, держите её явной, и не притворяйтесь, что interop бесплатен.

## Заранее собранные нативные бинарники -- ускоритель внедрения

Библиотеки на основе interop умирают, когда вы просите каждого пользователя компилировать нативные зависимости. Polars.NET явно объявляет о заранее собранных нативных бинарниках для Windows, Linux и macOS.

При оценке ищите NuGet-раскладку вроде:

- `runtimes/win-x64/native/polars.dll`
- `runtimes/linux-x64/native/libpolars.so`
- `runtimes/osx-arm64/native/libpolars.dylib`

Это разница между "крутой репозиторий" и "пригодная зависимость в CI и на dev-машинах".

## Настоящий вопрос: можете ли вы держать модель памяти предсказуемой?

DataFrames -- это история памяти. Для ядра Rust + поверхности .NET я ищу:

- **Чёткие правила владения**: кто освобождает буферы и когда?
- **Пути zero-copy**: обмен через Arrow -- хороший знак, но проверьте, где он реален.
- **Границы исключений**: становится ли нативная ошибка структурированным .NET-исключением?

Если эти моменты крепкие, Polars.NET становится практичным способом принести векторизованное выполнение уровня Rust в .NET-нагрузки без переписывания всего.

Источники:

- [Репозиторий Polars.NET](https://github.com/ErrorLSC/Polars.NET)
- [Тред Reddit](https://www.reddit.com/r/dotnet/comments/1qxpna7/polarsnet_a_dataframe_engine_for_net/)

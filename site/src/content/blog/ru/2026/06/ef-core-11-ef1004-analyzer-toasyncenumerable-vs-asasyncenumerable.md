---
title: "Новый анализатор EF1004 в EF Core 11 ловит скрытую асинхронную ошибку"
description: "EF Core 11 Preview 5 включает анализатор EF1004. Он помечает вызов ToAsyncEnumerable() на IQueryable, чтобы вы случайно не выполнили запрос к базе данных синхронно внутри await foreach."
pubDate: 2026-06-14
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "ru"
translationOf: "2026/06/ef-core-11-ef1004-analyzer-toasyncenumerable-vs-asasyncenumerable"
translatedBy: "claude"
translationDate: 2026-06-14
---

.NET 11 Preview 5, выпущенный 2026-06-09, добавляет новый анализатор EF Core с идентификатором диагностики `EF1004`. Он ловит ошибку, которую стало гораздо проще допустить с тех пор, как `System.Linq.AsyncEnumerable` вошёл в состав BCL в .NET 10: вызов `ToAsyncEnumerable()` на запросе EF Core с незаметным синхронным выполнением.

## Как сюда попадает неправильный вызов

Теперь, когда `System.Linq.AsyncEnumerable` поставляется в среде выполнения, его методы расширения доступны почти везде. Один из них -- `ToAsyncEnumerable()`, который адаптирует любой `IEnumerable<T>` к `IAsyncEnumerable<T>`. `IQueryable<T>` в EF Core тоже является `IEnumerable<T>`, поэтому вызов компилируется без проблем и выглядит правильно рядом с `await foreach`:

```csharp
// Looks async. Is not.
await foreach (var blog in db.Blogs.ToAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

Проблема в том, что `ToAsyncEnumerable()` оборачивает синхронное перечисление. Он обходит `IQueryable` с помощью блокирующего перечислителя, поэтому обращение к базе данных выполняется в вызывающем потоке. `await foreach` даёт вам синтаксис потоковой передачи без какого-либо асинхронного поведения. Под нагрузкой это именно та форма, которая истощает пул потоков и приводит к взаимным блокировкам, проявляющимся только в продакшене.

## Чего вместо этого ожидает EF1004

EF Core предоставляет собственный метод `AsAsyncEnumerable()`. Он направляет запрос через асинхронный конвейер EF Core, поэтому каждая строка материализуется по мере поступления из `DbDataReader` без блокировки потока:

```csharp
// Runs through EF Core's async query pipeline.
await foreach (var blog in db.Blogs.AsAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

Эти два имени метода различаются на три символа, оба возвращают `IAsyncEnumerable<T>` и оба компилируются. До Preview 5 ничто не подсказывало, какой из них вы выбрали. `EF1004` срабатывает на этапе сборки, как только вы вызываете `ToAsyncEnumerable()` на `IQueryable<T>`, указывая вам на `AsAsyncEnumerable()`.

## Как превратить это в ошибку

Анализатор поставляется в пакете анализаторов EF Core и работает во время обычной сборки, поэтому вы получаете предупреждение без дополнительной настройки в проекте, ссылающемся на `Microsoft.EntityFrameworkCore` 11.0.0. Если вы хотите гарантировать, что никто не выпустит синхронную версию, повысьте его уровень в файле проекта:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);EF1004</WarningsAsErrors>
</PropertyGroup>
```

Это естественно сочетается с паттернами потоковой передачи, описанными в [Как использовать IAsyncEnumerable&lt;T&gt; с EF Core 11](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/): `AsAsyncEnumerable()` -- это вызов, который заставляет `await foreach` действительно работать в потоковом режиме. EF1004 -- просто страховка, которая не даёт похожему методу проскользнуть мимо код-ревью.

Источник: [примечания к выпуску EF Core для .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/efcore.md) и [анонс .NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/).

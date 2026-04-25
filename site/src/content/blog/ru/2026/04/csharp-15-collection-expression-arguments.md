---
title: "Аргументы выражений-коллекций C# 15: передавайте конструкторы инлайн с with(...)"
description: "C# 15 добавляет элемент with(...) в выражения-коллекции, позволяя передавать ёмкость, компараторы и другие аргументы конструктора прямо в инициализаторе."
pubDate: 2026-04-13
tags:
  - "csharp-15"
  - "dotnet-11"
  - "collection-expressions"
lang: "ru"
translationOf: "2026/04/csharp-15-collection-expression-arguments"
translatedBy: "claude"
translationDate: 2026-04-25
---

Выражения-коллекции пришли в C# 12 и с тех пор впитывают новые возможности. C# 15, поставляемый с [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), добавляет недостающую часть: вы теперь можете передавать аргументы конструктору или фабричному методу коллекции с помощью элемента `with(...)`, помещённого в начало выражения.

## Почему это важно

До C# 15 выражения-коллекции выводили целевой тип и вызывали его конструктор по умолчанию. Если вам был нужен `HashSet<string>` без учёта регистра или `List<T>`, заранее размером под известную ёмкость, приходилось возвращаться к традиционному инициализатору или двухшаговой настройке:

```csharp
// C# 14 and earlier: no way to pass a comparer via collection expression
var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Hello", "HELLO" };

// Or the awkward two-step
List<string> names = new(capacity: 100);
names.AddRange(source);
```

Оба шаблона ломают лаконичный поток, для которого выражения-коллекции были спроектированы.

## Инлайн-аргументы конструктора с `with(...)`

C# 15 позволяет вам писать вместо этого следующее:

```csharp
string[] values = ["one", "two", "three"];

// Pre-allocate capacity
List<string> names = [with(capacity: values.Length * 2), .. values];

// Case-insensitive set in a single expression
HashSet<string> set = [with(StringComparer.OrdinalIgnoreCase), "Hello", "HELLO", "hello"];
// set.Count == 1
```

Элемент `with(...)` должен появляться первым. После него остальная часть выражения работает в точности как любое другое выражение-коллекция: литералы, spread-операторы и вложенные выражения нормально комбинируются.

## Словари получают то же обращение

Возможность действительно сияет с `Dictionary<TKey, TValue>`, где компараторы распространены, но раньше вынуждали вас полностью отказываться от выражений-коллекций:

```csharp
Dictionary<string, int> headers = [
    with(StringComparer.OrdinalIgnoreCase),
    KeyValuePair.Create("Content-Length", 512),
    KeyValuePair.Create("content-length", 1024)  // overwrites the first entry
];
// headers.Count == 1
```

Без `with(...)` вы вообще не могли передать компаратор через выражение-коллекцию. Единственным вариантом был вызов конструктора с последующими ручными добавлениями.

## Ограничения, которые нужно знать

Несколько правил, которые стоит держать в уме:

- `with(...)` должен быть **первым** элементом в выражении.
- Не поддерживается на массивах или span-типах (`Span<T>`, `ReadOnlySpan<T>`), поскольку у них нет конструкторов с параметрами конфигурации.
- Аргументы не могут иметь тип `dynamic`.

## Естественная эволюция

C# 12 дал нам синтаксис. C# 13 расширил `params`, чтобы принимать выражения-коллекции. C# 14 расширил неявные преобразования span. Теперь C# 15 устраняет последнюю распространённую причину отказа от выражений-коллекций: настройка конструктора. Если вы уже на [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) или позже, вы можете попробовать это сегодня с `<LangVersion>preview</LangVersion>` в файле проекта.

Полная спецификация: [Collection expression arguments proposal](https://github.com/dotnet/csharplang/blob/main/proposals/collection-expression-arguments.md).

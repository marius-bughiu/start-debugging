---
title: "Члены расширений в C# 14: свойства расширений, операторы и статические расширения"
description: "C# 14 вводит члены расширений, позволяя добавлять свойства расширений, операторы и статические члены к существующим типам с помощью нового ключевого слова extension."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "ru"
translationOf: "2026/02/csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 поставляется с .NET 10 и приносит самое долгожданное развитие методов расширения со времени их появления в C# 3.0. Теперь вы можете определять свойства расширений, операторы расширений и статические члены расширений с помощью нового ключевого слова `extension`.

## От методов расширений к блокам расширений

Раньше добавление функциональности к типу, которым вы не владеете, означало создание статического класса со статическими методами и модификатором `this`. Этот шаблон работал для методов, но оставлял свойства и операторы вне досягаемости.

C# 14 вводит **блоки расширений**, специальный синтаксис, который группирует связанные члены расширений:

```csharp
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsNullOrEmpty => string.IsNullOrEmpty(s);

        public int WordCount => s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

Блок `extension(string s)` объявляет, что все находящиеся внутри члены расширяют `string`. Теперь к ним можно обращаться как к свойствам:

```csharp
string title = "Hello World";
Console.WriteLine(title.IsNullOrEmpty);  // False
Console.WriteLine(title.WordCount);       // 2
```

## Операторы расширений

Операторы раньше было невозможно добавить к типам, которыми вы не управляете. C# 14 меняет это:

```csharp
public static class PointExtensions
{
    extension(Point p)
    {
        public static Point operator +(Point a, Point b)
            => new Point(a.X + b.X, a.Y + b.Y);

        public static Point operator -(Point a, Point b)
            => new Point(a.X - b.X, a.Y - b.Y);
    }
}
```

Теперь экземпляры `Point` могут использовать `+` и `-`, даже если исходный тип их не определял.

## Статические члены расширений

Блоки расширений также поддерживают статические члены, которые появляются как статические члены расширяемого типа:

```csharp
public static class GuidExtensions
{
    extension(Guid)
    {
        public static Guid Empty2 => Guid.Empty;

        public static Guid CreateDeterministic(string input)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
            return new Guid(hash.AsSpan(0, 16));
        }
    }
}
```

Вызывайте его так, как если бы это был статический член `Guid`:

```csharp
var id = Guid.CreateDeterministic("user@example.com");
```

## Что пока не поддерживается

C# 14 фокусируется на методах, свойствах и операторах. Поля, события, индексаторы, вложенные типы и конструкторы в блоках расширений не поддерживаются. Они могут появиться в будущих версиях C#.

## Когда использовать члены расширений

Свойства расширений хороши, когда у вас есть вычисляемые значения, которые ощущаются как естественные свойства типа. Пример `string.WordCount` читается лучше, чем `string.GetWordCount()`. Операторы расширений хорошо подходят для математических или доменных типов, в которых операторы имеют семантический смысл.

Возможность доступна сейчас в .NET 10. Обновите проект до `<LangVersion>14</LangVersion>` или `<LangVersion>latest</LangVersion>`, чтобы начать использовать блоки расширений.

Полная документация - в разделе [Члены расширений на Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members).

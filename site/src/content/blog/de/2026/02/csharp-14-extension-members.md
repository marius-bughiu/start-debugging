---
title: "Erweiterungsmember in C# 14: Erweiterungseigenschaften, -operatoren und statische Erweiterungen"
description: "C# 14 führt Erweiterungsmember ein, mit denen Sie Erweiterungseigenschaften, -operatoren und statische Member zu existierenden Typen mit dem neuen extension-Schlüsselwort hinzufügen können."
pubDate: 2026-02-08
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "de"
translationOf: "2026/02/csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-04-29
---

C# 14 erscheint mit .NET 10 und bringt die meistgewünschte Weiterentwicklung von Erweiterungsmethoden seit ihrer Einführung in C# 3.0. Sie können nun Erweiterungseigenschaften, Erweiterungsoperatoren und statische Erweiterungsmember mit dem neuen `extension`-Schlüsselwort definieren.

## Von Erweiterungsmethoden zu Erweiterungsblöcken

Bisher bedeutete das Hinzufügen von Funktionalität zu einem Typ, der Ihnen nicht gehört, eine statische Klasse mit statischen Methoden und einem `this`-Modifikator zu erstellen. Dieses Muster funktionierte für Methoden, ließ aber Eigenschaften und Operatoren außer Reichweite.

C# 14 führt **Erweiterungsblöcke** ein, eine dedizierte Syntax, die verwandte Erweiterungsmember zusammenfasst:

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

Der `extension(string s)`-Block erklärt, dass alle darin enthaltenen Member `string` erweitern. Sie können nun als Eigenschaften darauf zugreifen:

```csharp
string title = "Hello World";
Console.WriteLine(title.IsNullOrEmpty);  // False
Console.WriteLine(title.WordCount);       // 2
```

## Erweiterungsoperatoren

Operatoren waren zuvor unmöglich für Typen hinzuzufügen, die Sie nicht kontrollieren. C# 14 ändert das:

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

Nun können `Point`-Instanzen `+` und `-` verwenden, obwohl der ursprüngliche Typ sie nicht definiert hat.

## Statische Erweiterungsmember

Erweiterungsblöcke unterstützen auch statische Member, die als statische Member des erweiterten Typs erscheinen:

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

Rufen Sie ihn auf, als wäre er ein statischer Member von `Guid`:

```csharp
var id = Guid.CreateDeterministic("user@example.com");
```

## Was noch nicht unterstützt wird

C# 14 konzentriert sich auf Methoden, Eigenschaften und Operatoren. Felder, Ereignisse, Indexer, verschachtelte Typen und Konstruktoren werden in Erweiterungsblöcken nicht unterstützt. Diese kommen möglicherweise in zukünftigen C#-Versionen.

## Wann sollten Sie Erweiterungsmember einsetzen

Erweiterungseigenschaften glänzen, wenn Sie berechnete Werte haben, die sich wie natürliche Eigenschaften eines Typs anfühlen. Das `string.WordCount`-Beispiel liest sich besser als `string.GetWordCount()`. Erweiterungsoperatoren funktionieren gut für mathematische oder Domänentypen, bei denen Operatoren semantisch Sinn ergeben.

Die Funktion ist jetzt in .NET 10 verfügbar. Aktualisieren Sie Ihr Projekt auf `<LangVersion>14</LangVersion>` oder `<LangVersion>latest</LangVersion>`, um mit der Verwendung von Erweiterungsblöcken zu beginnen.

Die vollständige Dokumentation finden Sie unter [Erweiterungsmember auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members).

---
title: "C# 13: Das Ende der `params`-Allokationen"
description: "C# 13 beseitigt endlich die versteckte Array-Allokation hinter params. Sie können params jetzt mit Span, ReadOnlySpan, List und anderen Auflistungstypen für allokationsfreie variadische Methoden verwenden."
pubDate: 2026-01-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
lang: "de"
translationOf: "2026/01/c-13-the-end-of-params-allocations"
translatedBy: "claude"
translationDate: 2026-05-01
---
Über zwei Jahrzehnte lang brachte das Schlüsselwort `params` in C# eine versteckte Steuer mit sich: implizite Array-Allokationen. Jedes Mal, wenn Sie eine Methode wie `string.Format` oder Ihren eigenen Helper mit einer variablen Anzahl an Argumenten aufriefen, erzeugte der Compiler stillschweigend ein neues Array. In leistungskritischen Szenarien (Hot Paths) summierten sich diese Allokationen und verursachten unnötigen Druck auf die Garbage Collection (GC).

Mit C# 13 und .NET 9 wird diese Steuer endlich abgeschafft. Sie können `params` jetzt mit Auflistungstypen statt Arrays verwenden, einschließlich `Span<T>` und `ReadOnlySpan<T>`.

## Die Array-Steuer

Betrachten Sie eine typische Logging-Methode vor C# 13.

```cs
// Old C# way
public void Log(string message, params object[] args)
{
    // ... logic
}

// Usage
Log("User {0} logged in", userId); // Allocates new object[] { userId }
```

Selbst wenn Sie nur eine einzige Zahl übergaben, musste die Laufzeit ein Array auf dem Heap allokieren. Für Bibliotheken wie Serilog oder das Logging in ASP.NET Core bedeutete das, kreative Workarounds zu erfinden oder Methoden mit 1, 2, 3... Argumenten zu überladen, um das Array zu vermeiden.

## Null Allokationen mit `params ReadOnlySpan<T>`

C# 13 erlaubt den `params`-Modifizierer auf jedem Typ, der Auflistungsausdrücke unterstützt. Die wirkungsvollste Änderung ist die Unterstützung von `ReadOnlySpan<T>`.

```cs
// C# 13 way
public void Log(string message, params ReadOnlySpan<object> args)
{
    // ... logic using span
}

// Usage
// Compiler uses stack allocation or shared buffers!
Log("User {0} logged in", userId);
```

Wenn Sie diese neue Methode aufrufen, ist der Compiler clever genug, die Argumente über einen auf dem Stack allokierten Puffer (via `stackalloc`) oder andere Optimierungen zu übergeben und so den Heap vollständig zu umgehen.

## Mehr als nur Arrays

Es geht nicht nur um Leistung. `params` unterstützt jetzt `List<T>`, `HashSet<T>` und `IEnumerable<T>`. Das verbessert die API-Flexibilität und erlaubt es Ihnen, die _Absicht_ der Datenstruktur zu definieren, statt ein Array zu erzwingen.

```cs
public void ProcessTags(params HashSet<string> tags) 
{
    // O(1) lookups immediately available
}

ProcessTags("admin", "editor", "viewer");
```

## Wann umsteigen

Wenn Sie eine Bibliothek oder eine leistungssensitive Anwendung auf .NET 9 pflegen, prüfen Sie Ihre `params`-Methoden.

1.  Ändern Sie `params T[]` zu `params ReadOnlySpan<T>`, wenn Sie die Daten nur lesen müssen.
2.  Wechseln Sie zu `params IEnumerable<T>`, wenn Sie verzögerte Ausführung oder generische Flexibilität benötigen.

Diese kleine Signaturänderung kann den Speicherverkehr über die Lebenszeit Ihrer Anwendung erheblich reduzieren.

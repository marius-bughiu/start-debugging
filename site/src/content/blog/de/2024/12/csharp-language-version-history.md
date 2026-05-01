---
title: "Versionsgeschichte der Sprache C#"
description: "Die Entwicklung von C# hat es in eine moderne, leistungsstarke Sprache verwandelt. Dieser Leitfaden zeichnet jeden wichtigen Meilenstein nach. Die Anfangsjahre (C# 1.0 - 1.2). C# wurde 2002 als Hauptsprache für das .NET Framework eingeführt. Es fühlte sich wie Java an, jedoch mit Fokus auf Windows-Entwicklung. Version 1.2 kam kurz darauf mit kleinen..."
pubDate: 2024-12-01
updatedDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2024/12/csharp-language-version-history"
translatedBy: "claude"
translationDate: 2026-05-01
---
Die Entwicklung von C# hat es in eine moderne, leistungsstarke Sprache verwandelt. Dieser Leitfaden zeichnet jeden wichtigen Meilenstein nach.

## Die Anfangsjahre (C# 1.0 – 1.2)

C# wurde 2002 als Hauptsprache für das .NET Framework eingeführt. Es fühlte sich wie Java an, jedoch mit Fokus auf Windows-Entwicklung. Version 1.2 kam kurz darauf mit kleinen Verbesserungen wie `IDisposable`-Unterstützung in foreach-Schleifen.

Die Sprache hatte folgende Ziele:

> -   Sie soll eine einfache, moderne, allgemein verwendbare und objektorientierte Programmiersprache sein.
> -   Sie soll starke Typprüfung, Array-Grenzprüfung, Erkennung von Versuchen, nicht initialisierte Variablen zu verwenden, Quellcode-Portabilität und automatische Garbage Collection umfassen.
> -   Sie ist für die Entwicklung von Software-Komponenten gedacht, die verteilte Umgebungen nutzen können.
> -   Da die Programmiererportabilität sehr wichtig ist, insbesondere für Programmierer, die bereits mit C und C++ vertraut sind, ist C# am besten geeignet.
> -   Unterstützung für Internationalisierung bereitstellen, da diese sehr wichtig war.
> -   Sie soll für das Schreiben von Anwendungen sowohl für gehostete als auch für eingebettete Systeme geeignet sein.
> 
> [Quelle: C# Designziele](https://feeldotneteasy.blogspot.com/2011/01/c-design-goals.html)

## Große Produktivitätssprünge (C# 2.0 – 5.0)

Diese Versionen führten die Funktionen ein, die wir heute am häufigsten verwenden.

-   **C# 2.0:** Generics, anonyme Methoden und nullbare Typen veränderten die Art, wie wir mit Daten umgehen.
-   **C# 3.0:** LINQ, Lambda-Ausdrücke und Erweiterungsmethoden machten Datenabfragen viel einfacher.
-   **C# 4.0:** Diese Version fügte das Schlüsselwort `dynamic` und optionale Parameter hinzu.
-   **C# 5.0:** Die Schlüsselwörter `async` und `await` revolutionierten die asynchrone Programmierung.

## Die Ära des modernen Compilers (C# 6.0 – 9.0)

Mit dem Roslyn-Compiler kamen Updates schneller und häufiger.

-   **C# 6.0 und 7.0:** Diese Versionen konzentrierten sich auf "syntaktischen Zucker" wie Ausdrucks-bodied Members und Tupel.
-   **C# 8.0:** Nullbare Referenztypen halfen Entwicklern, häufige Null-Pointer-Exceptions zu vermeiden.
-   **C# 9.0:** Records und Top-Level-Anweisungen vereinfachten die Datenmodellierung und reduzierten Boilerplate-Code.

## Jüngste Fortschritte (C# 10.0 – 13.0)

Die Sprache entwickelt sich nun jährlich zusammen mit .NET weiter.

-   **C# 10 und 11:** Globale using-Direktiven und rohe String-Literale verbesserten die Entwicklerproduktivität.
-   **C# 12 und 13:** Primärkonstruktoren für Klassen und Verbesserungen bei ref struct hielten die Sprache wettbewerbsfähig.

## Was ist neu in C# 14?

C# 14 wurde mit .NET 10 veröffentlicht und führt mehrere Quality-of-Life-Verbesserungen ein.

### Das field-Schlüsselwort

Sie müssen Backing-Fields für Eigenschaften nicht mehr manuell deklarieren. Das Schlüsselwort `field` erlaubt es Ihnen, innerhalb der Accessor direkt auf das vom Compiler generierte Feld zuzugreifen.

```csharp
public string Name { 
    get => field; 
    set => field = value ?? "Unknown"; 
}
```

### Erweiterungsmember

C# 14 erweitert Erweiterungsmethoden. Sie können nun Erweiterungseigenschaften, statische Member und sogar Operatoren innerhalb eines neuen `extension`-Blocks definieren.

### Weitere wichtige Funktionen

-   **Null-bedingte Zuweisung:** Verwenden Sie `?.=`, um Werte nur dann zuzuweisen, wenn das Ziel nicht null ist.
-   **Implizite Span-Konvertierungen:** Arrays und Strings konvertieren nun natürlicher in Spans.
-   **Lambda-Modifier:** Sie können `ref`, `in` und `out` an Lambda-Parametern ohne explizite Typen verwenden.
-   **Partielle Konstruktoren:** Source Generators können nun Signaturen für Konstruktoren in partiellen Klassen definieren.

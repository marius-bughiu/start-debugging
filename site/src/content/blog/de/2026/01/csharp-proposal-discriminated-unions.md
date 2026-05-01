---
title: "C#-Vorschlag: Discriminated Unions"
description: "Ein Blick auf den Discriminated-Unions-Vorschlag für C#: das union-Schlüsselwort, erschöpfender Mustervergleich und wie er OneOf-Bibliotheken sowie Klassenhierarchien ersetzen könnte."
pubDate: 2026-01-02
updatedDate: 2026-01-04
tags:
  - "csharp"
  - "csharp-proposals"
lang: "de"
translationOf: "2026/01/csharp-proposal-discriminated-unions"
translatedBy: "claude"
translationDate: 2026-05-01
---
Der "Heilige Gral" der C#-Funktionen ist seit Jahren in der Diskussion. Und nach Jahren, in denen wir uns auf Drittanbieter-Bibliotheken wie `OneOf` oder umfangreiche Klassenhierarchien verlassen haben, sieht es so aus, als bekämen wir endlich native Unterstützung für **Discriminated Unions (DUs)** in einer zukünftigen C#-Version.

## Das Problem: "Eines von" darstellen

Wenn Sie wollten, dass eine Funktion _entweder_ ein generisches `Success`-Ergebnis _oder_ einen spezifischen `Error` zurückgibt, hatten Sie schlechte Optionen:

1.  **Exceptions werfen** (teuer als Kontrollfluss).
2.  **`object` zurückgeben** (verlorene Typsicherheit).
3.  **Eine Klassenhierarchie verwenden** (umfangreich und erlaubt weitere Erben).

## Die Lösung: `union`-Typen

Der Vorschlag führt das Schlüsselwort `union` ein und erlaubt es, geschlossene Typhierarchien zu definieren, bei denen der Compiler jeden möglichen Fall kennt.

```cs
// Define a union
public union Result<T>
{
    Success(T Value),
    Error(string Message, int Code)
}
```

Das erzeugt unter der Haube ein hochoptimiertes Struct-Layout, ähnlich der Funktionsweise von Rust-Enums.

## Erschöpfender Mustervergleich

Die wahre Stärke von DUs zeigt sich beim Verarbeiten. Der Switch-Ausdruck **muss** erschöpfend sein. Wenn Sie einen Fall vergessen, kompiliert der Code nicht.

```cs
public string HandleResult(Result<int> result) => result switch
{
    Result.Success(var val) => $"Got value: {val}",
    Result.Error(var msg, _) => $"Failed: {msg}",
    // Compiler Error: No default case needed, but all cases must be covered!
};
```

## Warum das wichtig ist

Wenn akzeptiert, würde diese Funktion die Fehlerbehandlung in .NET grundlegend verändern. Sie könnten Domänenzustände präzise modellieren (z. B. `Loading`, `Loaded`, `Error`), ohne die Laufzeitkosten von Klassenallokationen oder den kognitiven Aufwand komplexer Visitor-Muster.

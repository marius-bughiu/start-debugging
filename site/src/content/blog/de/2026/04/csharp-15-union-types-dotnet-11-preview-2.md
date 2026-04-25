---
title: "C# 15 Union-Typen sind da: Type Unions kommen in .NET 11 Preview 2"
description: "C# 15 führt das union-Schlüsselwort für Type Unions mit erschöpfendem Pattern Matching und impliziten Konvertierungen ein. Jetzt verfügbar in .NET 11 Preview 2."
pubDate: 2026-04-08
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "de"
translationOf: "2026/04/csharp-15-union-types-dotnet-11-preview-2"
translatedBy: "claude"
translationDate: 2026-04-25
---

Nach Jahren von Vorschlägen, Workarounds und Drittanbieter-Bibliotheken wie `OneOf` liefert C# 15 das `union`-Schlüsselwort in [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/csharp-15-union-types/). Das sind **Type Unions**: Sie komponieren existierende Typen zu einem einzigen geschlossenen Typ mit compiler-erzwungenem erschöpfendem Pattern Matching. Keine Basisklassen, kein Visitor-Pattern, kein Laufzeit-Raten.

## Wie Type Unions aussehen

Eine Union deklariert, dass ein Wert genau einer aus einer festen Menge von Typen ist:

```csharp
public union Shape(Circle, Rectangle, Triangle);
```

`Shape` kann ein `Circle`, ein `Rectangle` oder ein `Triangle` halten -- und nichts anderes. Der Compiler erzeugt implizite Konvertierungen aus jedem Case-Typ, sodass die Zuweisung unkompliziert ist:

```csharp
Shape shape = new Circle(Radius: 5.0);
```

Kein expliziter Cast, keine Factory-Methode. Die Konvertierung funktioniert einfach.

## Erschöpfendes Pattern Matching

Der wahre Gewinn kommt beim Konsum. Ein `switch`-Ausdruck über einer Union muss jeden Fall behandeln, sonst meldet der Compiler einen Fehler:

```csharp
double Area(Shape shape) => shape switch
{
    Circle c    => Math.PI * c.Radius * c.Radius,
    Rectangle r => r.Width * r.Height,
    Triangle t  => 0.5 * t.Base * t.Height,
};
```

Kein Default-Zweig nötig. Wenn Sie später `Polygon` zur Union hinzufügen, bricht jeder `switch`, der ihn nicht behandelt, zur Compilezeit. Das ist die Sicherheitsgarantie, die Klassenhierarchien und `OneOf<T1, T2>` auf Sprachebene nicht bieten können.

## Unions können Logik tragen

Sie sind nicht auf eine einzeilige Deklaration beschränkt. Unions unterstützen Methoden, Eigenschaften und Generics:

```csharp
public union Result<T>(T, ErrorInfo)
{
    public string Describe() => Value switch
    {
        T val       => $"Success: {val}",
        ErrorInfo e => $"Error {e.Code}: {e.Message}",
    };
}
```

Die `Value`-Eigenschaft gibt Zugriff auf die zugrunde liegende Instanz. Kombiniert mit Generics macht das `Result<T>`-Muster erstklassig ohne externe Abhängigkeiten.

## Wie sich das vom früheren Vorschlag unterscheidet

Im Januar 2026 haben wir den [Vorschlag zu Discriminated Unions](/2026/01/csharp-proposal-discriminated-unions/) behandelt, der Member innerhalb der Union selbst definierte (näher an F#- oder Rust-Enums). Das ausgelieferte C# 15-Design schlägt eine andere Richtung ein: **Type Unions komponieren existierende Typen**, statt neue inline zu deklarieren. Das bedeutet, Ihre `Circle`, `Rectangle` und `Triangle` sind reguläre Klassen oder Records, die Sie bereits haben. Die Union gruppiert sie nur.

## Loslegen

Installieren Sie das [.NET 11 Preview 2 SDK](https://dotnet.microsoft.com/download/dotnet/11.0), zielen Sie auf `net11.0` ab und setzen Sie `<LangVersion>preview</LangVersion>` in Ihrer Projektdatei. Beachten Sie, dass in Preview 2 das `UnionAttribute` und die `IUnion<T>`-Schnittstelle noch nicht in der Laufzeit sind: Sie müssen sie in Ihrem Projekt deklarieren. Spätere Previews werden sie ab Werk enthalten.

Type Unions sind die größte Erweiterung des C#-Typsystems seit nullbaren Referenztypen. Falls Sie "Eines-von"-Beziehungen mit Vererbungsbäumen oder Tupel-Hacks modelliert haben, ist jetzt ein guter Zeitpunkt, mit dem echten Werkzeug zu prototypen.

---
title: "Geschlossene Klassenhierarchien in C# 15: das Schluesselwort closed in .NET 11 Preview 5"
description: "C# 15 fuegt in .NET 11 Preview 5 den Modifizierer closed hinzu und verleiht Klassenhierarchien Vollstaendigkeit zur Kompilierzeit in switch-Ausdruecken. So funktioniert es, samt des einen Fallstricks."
pubDate: 2026-06-21
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
lang: "de"
translationOf: "2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-21
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) erschien am 9. Juni 2026, und in der Spracharbeit von C# 15 versteckt sich eine Funktion, die still eine der aeltesten Luecken im Typsystem schliesst: Es gab keine Moeglichkeit, dem Compiler mitzuteilen "diese Basisklasse hat genau diese Untertypen". Jetzt gibt es sie. Der neue Modifizierer `closed` deklariert eine geschlossene Klassenhierarchie, und switch-Ausdruecke darueber erhalten zur Kompilierzeit eine vollstaendige Pruefung auf Vollstaendigkeit.

Dies ist das Gegenstueck zu den [Typunionen](/de/2026/04/csharp-15-union-types-dotnet-11-preview-2/). Unionen setzen unverwandte Typen zusammen; geschlossene Hierarchien sperren einen Vererbungsbaum ab, den Sie bereits besitzen. Zusammen geben sie C# eine vollstaendige Geschichte der Vollstaendigkeit.

## Was closed tatsaechlich bewirkt

Markieren Sie eine Basisklasse als `closed`, und der Compiler erlaubt nur direkte Untertypen, die im selben Assembly liegen. Da die Menge der Untertypen nun bekannt und endlich ist, kann der Compiler pruefen, ob ein `switch` jeden erreichbaren Fall behandelt.

```csharp
public closed record class GateState;
public record class Closed : GateState;
public record class Open(float Percent) : GateState;

static string Describe(GateState state) => state switch
{
    Closed => "closed",
    Open(var percent) => $"{percent}% open"
};
```

Kein `default`-Zweig, kein Discard-Muster, kein `throw new InvalidOperationException("unreachable")`. Der Compiler weiss bereits, dass `Closed` und `Open` die einzigen Optionen sind. Fuegen Sie spaeter einen dritten Untertyp hinzu, und jeder nicht vollstaendige switch leuchtet mit einer Warnung auf. Genau das ist das Sicherheitsnetz fuer Refactorings, das das Muster aus versiegelter Klasse plus Visitor nie geboten hat.

## Die Regeln, die beissen

Einige Einschraenkungen sollte man sich einpraegen:

- Eine `closed`-Klasse ist **implizit abstrakt**. Sie koennen die Basis nicht direkt instanziieren und `closed` nicht mit `sealed`, `static` oder einem expliziten `abstract`-Modifizierer kombinieren.
- Direkte Untertypen muessen im **selben Assembly** deklariert werden. Vererbung ueber Assembly-Grenzen hinweg ist blockiert, und genau das macht die geschlossene Menge erkennbar.
- Es gilt fuer Klassen und `record class`, aber **nicht fuer Structs**.

## Der eine Fallstrick in Preview 5

Hier ist der Teil, der Sie stolpern laesst. Der Compiler gibt einen Marker `System.Runtime.CompilerServices.ClosedAttribute` aus, doch die Laufzeit in Preview 5 liefert dieses Attribut noch nicht mit. Bis sie es tut, muss jedes Projekt, das `closed` verwendet, das Attribut selbst deklarieren:

```csharp
namespace System.Runtime.CompilerServices;

[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class ClosedAttribute : Attribute { }
```

Legen Sie das in eine beliebige Datei des Projekts, und die Funktion kompiliert. Rechnen Sie damit, dass es in einer spaeteren Preview verschwindet, sobald die BCL den Typ mitbringt. Das ist die uebliche Preview-Steuer, also bauen Sie den Behelf nicht in eine geteilte Bibliothek ein, die Sie veroeffentlichen wollen.

Geschlossene Hierarchien, geschlossene Enums und Typunionen liegen heute in C# 15 alle hinter `<LangVersion>preview</LangVersion>` und steuern mit .NET 11 im November 2026 auf die allgemeine Verfuegbarkeit zu. Wenn Sie je einen switch mit einem unerreichbaren default geschrieben haben, nur um den Compiler zufriedenzustellen, ist dies die Funktion, die ihn endlich loescht. Alle Details stehen in den [C#-Versionshinweisen zu Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/csharp.md).

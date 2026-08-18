---
title: "Fix: The call is ambiguous between the following methods or properties nach der Umstellung auf C# 14 Extension Members"
description: "CS0121 nach dem Verschieben einer Erweiterungsmethode in einen C# 14 extension-Block: der Compiler emittiert weiterhin die alte statische Form. Duplikat löschen oder Aufruf qualifizieren."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
lang: "de"
translationOf: "2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members"
translatedBy: "claude"
translationDate: 2026-08-18
---

Sie haben eine Erweiterungsmethode mit `this`-Parameter in einen C# 14 `extension`-Block verschoben, das Original "sicherheitshalber" behalten, und nun scheitert jede Aufrufstelle mit CS0121. Die Lösung besteht darin, eine der beiden Deklarationen zu löschen, denn es sind nicht zwei verschiedene Dinge: Der Compiler senkt eine Methode aus einem Extension-Block genau auf dieselbe statische Methode mit `this`-Parameter ab, die Sie bereits hatten. Wenn Sie keine von beiden löschen können (die andere steckt in einem NuGet-Paket), qualifizieren Sie den Aufruf mit der enthaltenden statischen Klasse: `MyExtensions.WordCount(s)` statt `s.WordCount()`.

```
error CS0121: The call is ambiguous between the following methods or properties:
'New.StringExtensions2.extension(string).WordCount()' and 'Old.StringExtensions.WordCount(string)'
```

Beachten Sie die Form der Meldung. Ein Kandidat wird als `extension(string).WordCount()` ausgegeben, der andere als `WordCount(string)`. Diese Asymmetrie ist die gesamte Diagnose: Roslyn teilt mit, dass ein Kandidat aus einem Extension-Block stammt und der andere aus einer klassischen Methode mit `this`-Parameter, und es kann sich nicht entscheiden. Alles Folgende wurde mit dem .NET SDK 10.0.201 und `<LangVersion>14.0</LangVersion>` geprüft.

## Warum feuert CS0121, wenn beide Syntaxen im Gültigkeitsbereich sind?

C# 14 hat keinen zweiten, getrennten Suchmechanismus für Extension Members eingeführt. Ein Extension-Block ist eine Deklarationssyntax, und der Compiler senkt ihn auf ein Mitglied einer statischen Klasse ab, das von dem nicht zu unterscheiden ist, was `this string s` erzeugt. Wenn zwei `using`-Direktiven jeweils eine Klasse in den Gültigkeitsbereich bringen und beide Klassen einen `WordCount(string)`-Kandidaten mit identischer Anwendbarkeit beisteuern, bleibt der Überladungsauflösung kein Kriterium mehr, also meldet sie CS0121.

Das ist keine neue Regel. Derselbe Fehler ist immer aufgetreten, wenn zwei Bibliotheken dieselbe Erweiterungsmethode auf demselben Typ definieren. Neu ist, dass die Migration des eigenen Codes nun die Kollision erzeugt, weil eine halb fertige Migration beide Formen gleichzeitig am Leben lässt.

## Was emittiert der Compiler tatsächlich für einen Extension-Block?

Das ist der Teil, den man verinnerlichen sollte, denn er erklärt jedes Symptom auf dieser Seite. Nehmen Sie einen einzelnen Block mit einer Methode und einer Eigenschaft:

```csharp
// .NET 10.0.201, C# 14
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
        public bool IsBlank => string.IsNullOrWhiteSpace(s);
    }
}
```

Reflexion über das kompilierte `Lib.StringExtensions` in derselben Solution gibt aus:

```
METHOD Int32 WordCount(String s) [Extension]
METHOD Boolean get_IsBlank(String s)
NESTED <G>$34505F560D9EACF86A87F3ED1F85E448 ext-attr=True
CLASS ext-attr=True
```

Aus diesem Dump folgen drei Dinge:

1. `WordCount` wird als öffentliche statische Methode emittiert, die den Empfänger als ersten Parameter nimmt und `[ExtensionAttribute]` trägt. Sie *ist* in den Metadaten eine klassische Erweiterungsmethode. Deshalb kollidiert sie mit einer handgeschriebenen `this`-Methode, und deshalb ist das Schreiben beider ein Duplikat statt einer Kompatibilitätsschicht.
2. Die Eigenschaft wird auf `get_IsBlank(String s)` abgesenkt, eine öffentliche statische Methode **ohne** `[ExtensionAttribute]`. Eigenschaften sind keine klassischen Erweiterungsmethoden, werden also über einen anderen Suchpfad gefunden und scheitern mit einer anderen Diagnose (siehe unten).
3. Der verschachtelte Typ `<G>$<hash>` ist der inhaltsbasierte Markertyp, den der Compiler pro Extension-Block erzeugt. Der Hash leitet sich aus dem Inhalt des Blocks ab, weshalb zwei Blöcke mit identischen Empfängern und Mitgliedern in derselben Klasse mit CS9329 kollidieren.

Weil die abgesenkte Methode wirklich eine normale Erweiterungsmethode ist, kann ein auf `<LangVersion>13.0</LangVersion>` festgelegtes Projekt sie weiterhin nutzen. Ich habe das mit einer Projektreferenz von einer C# 13 App auf eine C# 14 Bibliothek geprüft: `"a b c".WordCount()` und `StringExtensions.WordCount("a b c")` kompilieren beide und geben `3` aus. `"a b c".IsBlank` in derselben Datei scheitert mit `error CS9260: Feature 'extensions' is not available in C# 13.0`. Erweiterungs*methoden* aus einem Block sind aus älteren Sprachversionen nutzbar, Erweiterungs*eigenschaften* nicht.

## Minimale Reproduktion: zwei statische Klassen, ein Methodenname

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class StringExtensions
{
    public static int WordCount(this string s) => s.Split(' ').Length;
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class StringExtensions2
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("a b c".WordCount()); // CS0121
```

`dotnet build` scheitert an der Aufrufstelle, nicht an einer der Deklarationen. Das ist wichtig: Die Deklarationen sind einzeln zulässig, der Fehler erscheint also nur in Dateien, die beide Namespaces importieren. Eine teilweise migrierte Solution kompiliert deshalb in manchen Projekten und scheitert in anderen, was wie ein instabiler Build wirkt, bis man die `using`-Listen ansieht.

Dasselbe passiert über Assembly-Grenzen hinweg, und das ist die Variante, die die meisten tatsächlich treffen. Eine Bibliothek liefert Extension-Blöcke aus, Sie behalten einen lokalen Shim mit `this`-Methode, den Sie vor dem Upgrade geschrieben haben, und jede Datei, die beide Namespaces importiert, bricht:

```
error CS0121: The call is ambiguous between the following methods or properties:
'Lib.StringExtensions.extension(string).WordCount()' and 'App.Compat.MyStringExtensions.WordCount(string)'
```

## Wie behebe ich CS0121, wenn mir beide Deklarationen gehören?

Löschen Sie die Version mit `this`-Parameter. Das ist die ganze Lösung, und es ist kein Kompromiss: Wie oben gezeigt, emittiert der Extension-Block weiterhin eine mit `[ExtensionAttribute]` markierte statische Methode mit identischer Signatur, sodass jede bestehende Aufrufstelle weiter funktioniert, einschließlich der vollqualifizierten Form `MyExtensions.WordCount(s)` und der Aufrufer auf älteren Sprachversionen.

```csharp
// .NET 10.0.201, C# 14 -- one declaration, both call shapes still work
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}

// both of these compile:
// "a b c".WordCount()
// StringExtensions.WordCount("a b c")
```

Die Migrationsregel für das Whiteboard: **Ein Extension-Block ersetzt die alte Methode, er steht nicht daneben.** Jeder Reflex, "die alte aus Kompatibilitätsgründen zu behalten", ist hier falsch, denn Binär- und Quellkompatibilität werden durch die Absenkung bereits gewahrt.

## Wie löse ich die Mehrdeutigkeit auf, wenn das Duplikat in einem NuGet-Paket steckt?

Eine Deklaration, die Ihnen nicht gehört, können Sie nicht löschen. Wählen Sie also eine der folgenden Optionen, in dieser Reihenfolge.

**Rufen Sie die statische Methode direkt auf.** Beide Kandidaten stellen eine statische Form bereit, also benennen Sie die gewünschte Klasse:

```csharp
// .NET 10.0.201, C# 14
System.Console.WriteLine(New.StringExtensions2.WordCount("a b c")); // extension block version
System.Console.WriteLine(Old.StringExtensions.WordCount("a b c"));  // this-parameter version
```

Das kompiliert sauber. Es ist an der Aufrufstelle ausführlich, aber eindeutig, per grep auffindbar und überlebt künftige Paket-Upgrades.

**Entfernen Sie das `using` und wechseln Sie zu einem Namespace-Alias.** Extension Members gelangen nur über ein einfaches `using` des Namespace in den Gültigkeitsbereich. Ein Namespace-Alias importiert die *Namen*, ohne Erweiterungskandidaten beizusteuern:

```csharp
// .NET 10.0.201, C# 14
using OldAlias = Old; // types reachable as OldAlias.StringExtensions, but no extension candidates
using New;

System.Console.WriteLine("x".WordCount()); // binds to New, prints 2
```

Ich habe genau diese Datei ausgeführt, sie gibt `2` aus. Das ist die sauberste Option, wenn eine Datei Typen aus einem Namespace braucht, aber nicht dessen Erweiterungen. Achten Sie auf `global using`-Direktiven in `GlobalUsings.cs` oder `<Using Include="..."/>`-Einträge im csproj, denn diese importieren Erweiterungen in jede Datei des Projekts und sind der übliche Grund, warum die Mehrdeutigkeit in einer Datei auftaucht, deren eigene `using`-Liste harmlos aussieht.

**Geben Sie den beiden Mitgliedern unterschiedliche Namen.** Wenn Ihnen das neuere gehört und es noch nicht veröffentlicht ist, ist Umbenennen günstiger, als dem ganzen Team eine Auflösungsregel beizubringen.

## Kann ich die alte Methode mit `[Obsolete]` markieren, um die Mehrdeutigkeit zu lösen?

Nein. Veralterung ist kein Kriterium der Überladungsauflösung. Der Kandidat bleibt anwendbar, und der Fehler ist identisch:

```csharp
// .NET 10.0.201, C# 14 -- still CS0121
[System.Obsolete("Use Lib")]
public static int WordCount(this string s) => 1;
```

`[Obsolete]` ist nützlich, um Konsumenten mitzuteilen, dass sie etwas nicht mehr aufrufen sollen, bewirkt aber nichts für die Kandidatenmenge des Compilers. Dasselbe gilt für `[EditorBrowsable(EditorBrowsableState.Never)]`, das Mitglieder lediglich in IntelliSense ausblendet.

## Wann bekomme ich CS0111 statt CS0121?

Weil beide Deklarationen in *derselben* statischen Klasse stehen. Dann ist es kein mehrdeutiger Aufruf, sondern ein doppeltes Mitglied:

```csharp
// .NET 10.0.201, C# 14
namespace A;

public static class E1
{
    public static int WordCount(this string s) => 1;

    extension(string s)
    {
        public int WordCount() => 2; // CS0111
    }
}
```

```
error CS0111: Type 'E1' already defines a member called 'WordCount' with the same parameter types
```

CS0111 wird an der Deklaration gemeldet, bevor eine Aufrufstelle existiert. Es ist der freundlichere der beiden Fehler, weil er die Äquivalenz direkt beweist: Der Compiler hält `WordCount(this string)` und das `WordCount()` des Blocks für parametergleich. Wer eine Klasse Methode für Methode migriert, sieht diesen Fehler zuerst.

## Was, wenn die Mehrdeutigkeit bei einer Erweiterungseigenschaft liegt (CS9339)?

Erweiterungseigenschaften haben ihre eigene Diagnose, denn sie sind in den Metadaten keine `[ExtensionAttribute]`-Methoden und werden über die Extension-Member-Suche statt über die normale Überladungsauflösung aufgelöst:

```csharp
// N1.cs -- .NET 10.0.201, C# 14
namespace N1;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// N2.cs -- .NET 10.0.201, C# 14
namespace N2;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using N1;
using N2;

var sb = new System.Text.StringBuilder();
sb.Cap = 64; // CS9339
```

```
error CS9339: The extension resolution is ambiguous between the following members:
'N1.E.extension(System.Text.StringBuilder).Cap' and 'N2.E.extension(System.Text.StringBuilder).Cap'
```

Die Lösung hat dieselbe Form, aber Sie müssen den Accessor benennen, da es keine Eigenschaftssyntax gibt, die den Klassennamen trägt:

```csharp
// .NET 10.0.201, C# 14 -- disambiguated, prints 64
N1.E.set_Cap(sb, 64);
System.Console.WriteLine(N1.E.get_Cap(sb));
```

Die Accessor-Methoden `get_` und `set_` sind genau das, worauf der Block abgesenkt wird, ihr Aufruf ist also kein Hack, sondern der Aufruf des echten Mitglieds. Er ist hässlich genug, dass Sie ihn als vorübergehende Entsperrung behandeln sollten, während Sie eines der Duplikate entfernen. Falls Sie noch überlegen, wie Sie diese Deklarationen schneiden, decken die Regeln zum [Deklarieren von Erweiterungseigenschaften in C# 14](/de/2026/06/how-to-declare-extension-properties-in-csharp-14/) ab, warum automatische Eigenschaften abgelehnt werden und was die Accessoren dürfen.

## Löst ein spezifischerer Empfängertyp die Mehrdeutigkeit auf?

Ja, und deshalb brechen nur manche Ihrer Aufrufstellen. Die Überladungsauflösung bevorzugt weiterhin die bessere Konvertierung vom Empfänger, und dieser Vergleich findet über beide Syntaxen hinweg statt. Ein Extension-Block auf `string` schlägt eine Methode mit `this`-Parameter auf `IEnumerable<char>`:

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class E
{
    public static string Describe(this System.Collections.Generic.IEnumerable<char> s) => "IEnumerable<char>";
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class E
{
    extension(string s)
    {
        public string Describe() => "string";
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("x".Describe()); // prints: string
```

Eine generische Methode mit `this`-Parameter verliert gegen einen konkreten Extension-Block auf demselben Empfänger und gewinnt weiterhin für jeden anderen Empfängertyp:

```csharp
// .NET 10.0.201, C# 14
// G1.E: public static string Kind<T>(this T value) => "generic this-method";
// G2.E: extension(string s) { public string Kind() => "extension block on string"; }

System.Console.WriteLine("x".Kind()); // extension block on string
System.Console.WriteLine(42.Kind());  // generic this-method
```

Eine Migration, die einen Empfänger von `IEnumerable<T>` auf einen konkreten Typ ändert, verschiebt also manche Aufrufstellen stillschweigend auf die neue Implementierung, ganz ohne Fehler. Das ist eine Verhaltensänderung, versteckt in etwas, das wie ein Syntax-Refactoring aussieht, und sie verdient einen Test statt einer Kompilierung.

## Löst eine Instanzmethode die Mehrdeutigkeit auf?

Ein Instanzmitglied gewinnt immer gegen jedes Extension Member, in beiden Syntaxen, ohne Diagnose. Wenn ein Typ in einer späteren Version einer Abhängigkeit eine Instanzmethode mit passender Signatur bekommt, werden beide Ihrer Erweiterungsdeklarationen unerreichbar, und nichts warnt Sie:

```csharp
// .NET 10.0.201, C# 14
public class Order { public decimal Total() => 10m; }
public static class E1 { public static decimal Total(this Order o) => 20m; }
public static class E2 { extension(Order o) { public decimal Total() => 30m; } }

// new Order().Total() prints 10
```

Dieses Programm kompiliert ohne Warnung und gibt `10` aus. Es ist das Spiegelbild von CS0121: zwei mehrdeutige Extension Members sind laut, zwei verdeckte sind still. Das ist dieselbe Art von Upgrade-Risiko wie die [Breaking Change bei der Überladungsauflösung in C# 14 mit Spans](/de/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/), wo eine neue implizite Konvertierung bestehende Aufrufe stillschweigend neu bindet.

## Welche Migrationsreihenfolge vermeidet den Fehler vollständig?

1. Verschieben Sie die Deklarationen, kopieren Sie sie nicht. Schneiden Sie die `this`-Methode aus der statischen Klasse aus und fügen Sie den Rumpf in einen `extension`-Block derselben Klasse ein. CS0111 erwischt Sie sofort, wenn Sie diesen Schritt vermasseln, und genau deshalb ist die Migration innerhalb einer Klasse sicherer, als eine neue anzulegen.
2. Migrieren Sie jeweils eine ganze statische Klasse. Halb migrierte Klassen sind in Ordnung, halb migrierte *Namespaces* mit einer parallelen "V2"-Klasse sind die Quelle von CS0121.
3. Legen Sie nie eine `New`- oder `V2`-Erweiterungsklasse neben die alte. Es gibt nichts kompatibel zu halten, die Parallelklasse bringt Ihnen also nur eine Mehrdeutigkeit ein.
4. Kompilieren Sie nach dem Verschieben die Solution mit `dotnet build`, bevor Sie Aufrufstellen anfassen. Jede Aufrufstelle, die weiterhin kompiliert, ist der Beweis, dass die Absenkung gepasst hat.
5. Führen Sie die Tests aus, nicht nur den Compiler. Die oben beschriebenen Spezifitätsregeln des Empfängers bedeuten, dass eine Migration die ausgeführte Implementierung ändern kann, ohne den Build zu brechen.

Wenn Sie das im Rahmen eines größeren Sprungs tun: Die [Checkliste für die Migration von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) ordnet die Anhebung der Sprachversion gegenüber Runtime- und Paket-Upgrades ein, und das ist die Reihenfolge, die verhindert, dass dieser Fehler zusammen mit zwanzig anderen ankommt.

## Verwandt

- [C# 14 Extension Members: Erweiterungseigenschaften, Operatoren und statische Erweiterungen](/de/2026/02/csharp-14-extension-members/) für die vollständige Feature-Oberfläche, einschließlich der Operator- und Static-Member-Formen, die dieser Beitrag nicht behandelt.
- [Erweiterungseigenschaften in C# 14 deklarieren](/de/2026/06/how-to-declare-extension-properties-in-csharp-14/) für die Accessor-Regeln hinter dem Auflösungstrick mit `get_` und `set_`.
- [C# 15 Extension Indexer in .NET 11 Preview 6](/de/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/) dazu, wohin sich die Extension-Block-Syntax entwickelt.
- [Fix: Breaking Change bei der Überladungsauflösung in C# 14 mit Span und ReadOnlySpan](/de/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) für die andere C# 14 Änderung, die bestehende Aufrufstellen neu bindet.
- [Von .NET 8 auf .NET 11 migrieren: vollständige Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) zur Einordnung der Anhebung der Sprachversion.

## Quellen

- [Resolve errors and warnings related to extension declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/extension-declarations) auf MS Learn, mit CS9339 und der CS93xx-Familie der Extension-Block-Diagnosen.
- [Extension methods](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/extension-methods) auf MS Learn, zu den beiden Deklarationssyntaxen und der Auflösungsempfehlung.
- [C# 14: exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) im .NET Blog, das die Absenkung auf statische Methoden mit `get_`-Präfix dokumentiert und das Designziel bestätigt, dass die Umstellung einer Erweiterungsmethode auf die neue Syntax deren Konsumenten nicht bricht.
- [Extensions discussion](https://github.com/dotnet/csharplang/discussions/8696) in dotnet/csharplang, der Design-Thread zum Feature.

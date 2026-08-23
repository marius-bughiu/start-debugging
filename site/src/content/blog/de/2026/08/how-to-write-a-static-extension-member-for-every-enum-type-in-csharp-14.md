---
title: "Wie man ein statisches Erweiterungsmitglied für jeden Enum-Typ in C# 14 schreibt"
description: "Deklarieren Sie einen generischen extension-Block mit der Einschränkung struct, Enum und Sie erhalten Status.Values, Status.Count und Status.Parse für jedes Enum in Ihrer Solution. Die Form des Empfängers, die Fallen CS0704 und CS0428, und warum Sie Enum.GetValues zwischenspeichern müssen."
pubDate: 2026-08-23
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
  - "enums"
lang: "de"
translationOf: "2026/08/how-to-write-a-static-extension-member-for-every-enum-type-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-08-23
---

C# 14 erlaubt einen einzigen `extension`-Block, der *allen* Enum-Typen auf einmal statische Mitglieder hinzufügt. Die Form lautet `extension<TEnum>(TEnum) where TEnum : struct, Enum`, deklariert in einer nicht generischen statischen Klasse, wobei der Name des Empfängerparameters entfällt, weil die Mitglieder statisch sind. Das liefert `Status.Values`, `Status.Count` und `Status.Parse("active")` für jedes Enum in Ihrer Solution, ohne eine Zeile pro Enum zu schreiben. Alles Folgende wurde mit dem .NET SDK 10.0.201 auf Laufzeit 10.0.5 kompiliert und ausgeführt.

Der Haken: drei getrennte Dinge werden Ihnen Probleme bereiten. Der Typparameter ist aus einer generischen Methode heraus nicht erreichbar, jeder Mitgliedsname, den `System.Enum` bereits belegt, wird stillschweigend verdeckt, und die naheliegende Implementierung allokiert bei jedem einzelnen Aufruf ein neues Array.

## Warum der Empfänger `TEnum` sein muss und nicht `Enum`

Der Instinkt sagt, man schreibt `extension(Enum)` und ist fertig, da jedes Enum von `System.Enum` ableitet. Das kompiliert und lässt sich sogar über den Namen eines konkreten Enum-Typs auflösen:

```csharp
// .NET 10, C# 14 -- compiles and runs, but is a dead end
public static class B
{
    extension(Enum)
    {
        public static string Label => "Label:System.Enum";
    }
}

// both of these print "Label:System.Enum"
Console.WriteLine(Status.Label);
Console.WriteLine(Enum.Label);
```

Statische Erweiterungsmitglieder, die auf dem Basistyp deklariert sind, sind tatsächlich über den Typnamen eines abgeleiteten Enums erreichbar. Aber in diesem Block gibt es keinen Typparameter, also können Sie keine der generischen `Enum`-APIs aufrufen. `Enum.GetValues<TEnum>()`, `Enum.Parse<TEnum>` und `Enum.TryParse<TEnum>` sind genau die APIs, die Sie wollen, und alle brauchen ein `TEnum`. Ohne eines sind Sie zurück bei Reflexion über `typeof` und boxen jeden Wert in `object`.

Der Empfänger muss den Typparameter also mitführen. Der nächste Instinkt ist `where TEnum : Enum`, was ebenfalls kompiliert, bis Sie es tatsächlich verwenden:

```csharp
extension<TEnum>(TEnum) where TEnum : Enum
{
    public static TEnum[] Values => Enum.GetValues<TEnum>();
}
```

```
error CS0453: The type 'TEnum' must be a non-nullable value type in order to use it
as parameter 'TEnum' in the generic type or method 'Enum.GetValues<TEnum>()'
```

`Enum` als Einschränkung lässt `System.Enum` selbst zu, einen abstrakten Referenztyp. Die generischen `Enum`-Hilfsmethoden sind alle auf `struct, Enum` eingeschränkt, Ihr Block muss also dazu passen. Damit bleibt genau eine funktionierende Form.

## Den Block in drei Schritten deklarieren

1. **Erstellen Sie eine nicht generische `static class` auf oberster Ebene.** `extension`-Blöcke sind nur dort zulässig. Der Klassenname taucht an der Aufrufstelle nie auf, wählen Sie also etwas Beschreibendes wie `EnumExtensions`.
2. **Schreiben Sie `extension<TEnum>(TEnum) where TEnum : struct, Enum` und lassen Sie den Namen des Empfängerparameters weg.** MS Learn ist eindeutig: "the extension parameter doesn't need to include the parameter name if the only members are static". Das Weglassen des Namens signalisiert, dass dieser Block statische Mitglieder enthält; ein benannter Empfänger ist für Instanzmitglieder da.
3. **Deklarieren Sie `public static` Mitglieder im Block.** Sie binden an das konkrete Enum, das Sie an der Aufrufstelle nennen, `TEnum` wird also als `Status` abgeleitet, wenn Sie `Status.Values` schreiben.

```csharp
// .NET 10, C# 14
public static class EnumExtensions
{
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static TEnum[] Values => Enum.GetValues<TEnum>();
        public static int Count => Enum.GetValues<TEnum>().Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status { Draft = 1, Active = 2, Archived = 4 }
public enum Color { Red, Green, Blue }

Console.WriteLine(Status.Count);              // 3
Console.WriteLine(string.Join(",", Status.Values));  // Draft,Active,Archived
Console.WriteLine(Color.Parse("green"));      // Green
Console.WriteLine(Color.TryParse("BLUE", out var c));  // True
```

Ein Block, und jedes Enum der Kompilierung hat vier statische Mitglieder gewonnen. Das ist der gesamte Gewinn, und es ist der Teil, der sich vor C# 14 wirklich nicht ausdrücken ließ. Zur Auffrischung des umgebenden Features: die [Übersicht über Erweiterungsmitglieder in C# 14](/de/2026/02/csharp-14-extension-members/) behandelt Operatoren und die nicht generischen Fälle, und [Erweiterungseigenschaften deklarieren](/de/2026/06/how-to-declare-extension-properties-in-csharp-14/) geht tiefer auf die eigenschaftsspezifischen Regeln ein.

## Was der Compiler tatsächlich ausgibt

`extension`-Blöcke sind kein Laufzeitfeature. Alles wird auf gewöhnliche statische Methoden der umschließenden statischen Klasse reduziert, plus einen vom Compiler erzeugten Markertyp, der die Erweiterungsmetadaten trägt. Reflexion über die Klasse zur Laufzeit zeigt das:

```
--- emitted members on EnumExtensions ---
  NestedType <G>$1AEBB925A470955AA56007A9C9196757`1
  Method   get_Count
  Method   get_Values
  Method   Parse
  Method   TryParse
```

Der verschachtelte Typ `<G>$<hash>` ist der Gruppierungstyp, mit dem der Compiler den Empfänger und dessen Einschränkungen festhält. Die Mitglieder selbst sind flache statische Methoden, weshalb `extension`-Blöcke binärkompatibel zu den alten Erweiterungsmethoden mit `this`-Parameter sind und weshalb zur Laufzeit keine Dispatch-Kosten anfallen.

Diese flache Ausgabe hat eine direkte Konsequenz, und die überrascht als Erstes.

## Ein `extension`-Block ist kein Gültigkeitsbereich

MS Learn formuliert die Regel klar: "An extension doesn't introduce a scope for member declarations. All members declared in a single class, even if in multiple extensions, must have unique signatures." Ein Instanzmitglied und ein statisches Mitglied gleichen Namens kollidieren also, obwohl sie in verschiedenen Blöcken stehen:

```csharp
public static class E2
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Tag => "instance";
    }
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static string Tag => "static";   // CS0102
    }
}
```

```
error CS0102: The type 'E2' already contains a definition for 'Tag'
```

Verteilen Sie sie auf zwei statische Klassen, wandert die Kollision stattdessen an die Aufrufstelle, wo C# 14 eine eigene Diagnose hat:

```
error CS9339: The extension resolution is ambiguous between the following members:
'C1.extension<Status>(Status).Count' and 'C2.extension<Status>(Status).Count'
```

CS9339 sollte man auf Anhieb erkennen, denn ein generischer Enum-Block gilt für jedes Enum im Gültigkeitsbereich. Zwei Bibliotheken, die beide eine `Values`-Erweiterung ausliefern, kollidieren bei jedem Enum, das Ihnen gehört, und keine der beiden ist schuld. Dieselbe Problemfamilie tritt auf, wenn Sie eine Erweiterungsmethode alten Stils in einen Block verschieben und das Original zu löschen vergessen, was [die CS0121-Mehrdeutigkeit nach dem Umstieg auf Erweiterungsmitglieder](/de/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/) erzeugt.

## `TEnum.Values` kompiliert nicht innerhalb einer generischen Methode

Diese Falle kostet die meiste Zeit. Das Erweiterungsmitglied löst gegen einen konkreten Enum-Namen sauber auf, aber nicht gegen einen Typparameter:

```csharp
public static int CountOf<TEnum>() where TEnum : struct, Enum
{
    return TEnum.Values.Length;   // CS0704
}
```

```
error CS0704: Cannot do non-virtual member lookup in 'TEnum' because it is a type parameter
```

Statische Erweiterungsmitglieder werden per Namenssuche auf einem Typ aufgelöst, und ein Typparameter ist für diesen Zweck kein Typ. Nur `static` *abstract* Schnittstellenmitglieder nehmen an der Mitgliedersuche über einen Typparameter teil, und Erweiterungsmitglieder sind keine Schnittstellenmitglieder. Es gibt keine Syntax, die das behebt.

Die praktische Antwort ist, die eigentliche Implementierung in einer gewöhnlichen generischen Hilfsklasse zu halten und den `extension`-Block als dünne Fassade darüber zu belassen. Generischer Code ruft die Hilfsklasse direkt auf, Anwendungscode ruft das hübsche Erweiterungsmitglied auf. Diese Aufteilung löst zugleich das Allokationsproblem weiter unten, Sie bekommen es also gratis.

## `Enum.GetValues<TEnum>()` allokiert bei jedem Aufruf ein neues Array

`Enum.GetValues<TEnum>()` gibt jedes Mal ein frisches `TEnum[]` zurück, denn ein zwischengespeichertes veränderliches Array herauszugeben würde jedem Aufrufer erlauben, es zu beschädigen. Eine Eigenschaft, die es bei jedem Zugriff aufruft, macht aus einer Abfrage eine Allokation. Gemessen auf Laufzeit 10.0.5, Release-Build, eine Million Zugriffe auf ein Enum mit fünf Mitgliedern, mit Indizierung des Ergebnisses, damit der JIT den Aufruf nicht aus der Schleife ziehen kann:

| Implementierung | Zeit | Allokiert | Pro Operation |
| --- | --- | --- | --- |
| `Enum.GetValues<TEnum>()` pro Zugriff | 27,8 ms | 48.000.832 Bytes | 48 B |
| statischer generischer Cache | 0,7 ms | 0 Bytes | 0 B |

48 Bytes pro Operation sind der Array-Header plus fünf 4-Byte-Werte, auf die Ausrichtung aufgerundet. Die Zahl skaliert mit dem Enum, ein Enum mit 30 Mitgliedern kostet also mehr. Über drei Läufe hinweg maß die Version ohne Cache zwischen 26,8 ms und 29,5 ms, die Version mit Cache stets 0,7 ms.

Die Lösung ist eine statische generische Klasse. Die CLR gibt Ihnen eine Instanz ihrer statischen Felder pro geschlossenem generischem Typ, `EnumInfo<Status>` und `EnumInfo<Color>` erhalten also getrennten Speicher, jeweils genau einmal bei der ersten Verwendung initialisiert:

```csharp
// .NET 10, C# 14
internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();
}
```

`ImmutableArray<TEnum>` ist hier statt `TEnum[]` wichtig: ein zwischengespeichertes Array, das aus einer Eigenschaft herausgegeben wird, ist für jeden Aufrufer veränderlich, und ein einziges `Values[0] = ...` vergiftet den Cache stillschweigend für den gesamten Prozess. `FrozenSet` ist die richtige Form für Enthaltensein-Prüfungen, da es einmalig höhere Aufbaukosten gegen schnellere Lesezugriffe eintauscht, genau der Kompromiss, den ein statischer Cache pro Typ will. Der [Benchmark Dictionary vs FrozenDictionary](/de/2024/04/net-8-performance-dictionary-vs-frozendictionary/) liefert die Zahlen hinter dieser Wahl.

## Namen, die `System.Enum` bereits belegt, werden verdeckt

Erweiterungsmitglieder sind ein Rückfallweg. Die Namenssuche findet zuerst echte Mitglieder und greift erst dann auf Erweiterungen zurück, wenn nichts Anwendbares existiert. `System.Enum` deklariert bereits `IsDefined`, ein Erweiterungsmitglied dieses Namens wird also nie in Betracht gezogen:

```csharp
extension<TEnum>(TEnum value) where TEnum : struct, Enum
{
    public bool IsDefined => Enum.IsDefined(value);
    public bool IsKnown => Enum.IsDefined(value);
}

Status s = Status.Active;
bool a = s.IsKnown;     // fine
bool b = s.IsDefined;   // CS0428
```

```
error CS0428: Cannot convert method group 'IsDefined' to non-delegate type 'bool'.
Did you intend to invoke the method?
```

Der Compiler fand die Methodengruppe `Enum.IsDefined` und hörte auf zu suchen. Die Fehlermeldung führt aktiv in die Irre, denn sie legt nahe, Sie hätten Klammern vergessen, während das eigentliche Problem darin besteht, dass Ihre Erweiterungseigenschaft unter diesem Namen unerreichbar ist. Dasselbe passiert statischen Erweiterungsmitgliedern: `Status.IsDefined` als statische Erweiterungseigenschaft deklariert erzeugt das identische CS0428.

Beachten Sie, dass es hier um Namen geht, nicht um Signaturen. `GetValues` als Erweiterungs*methode* funktioniert einwandfrei:

```csharp
extension<TEnum>(TEnum) where TEnum : struct, Enum
{
    public static TEnum[] GetValues() => Enum.GetValues<TEnum>();  // compiles
}

Status[] all = Status.GetValues();   // resolves to your extension
```

`Enum.GetValues` existiert, aber keine seiner Überladungen ist mit null Argumenten anwendbar, die Suche fällt also bis zur Erweiterung durch. Sich darauf zu verlassen ist fragil. Die sichere Regel lautet, jeden Namen zu meiden, den `System.Enum` schon hat: `IsDefined`, `Parse`, `TryParse`, `GetName`, `GetNames`, `GetValues`, `GetUnderlyingType`, `Format`, `ToObject`, `HasFlag` und `CompareTo`. `Values`, `Count`, `Names` und `IsKnown` zu wählen umgeht die gesamte Kategorie.

`Parse` und `TryParse` sind die unangenehmen Ausnahmen, denn das sind die Namen, die Aufrufer erwarten. Sie lösen derzeit auf, aus demselben Grund null anwendbarer Überladungen wie bei `GetValues`. Wenn Sie konservativ sein wollen, nennen Sie sie `ParseName` und `TryParseName`.

## Die Falle beim Zerlegen von `[Flags]`

Wenn Sie ein Mitglied hinzufügen, das einen Flags-Wert in seine Teile zerlegt, ist die naheliegende Implementierung für jedes Enum mit einem Null-Mitglied falsch:

```csharp
[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Admin = Read | Write }

public ImmutableArray<TEnum> NaiveFlags =>
    [.. EnumInfo<TEnum>.Values.Where(f => value.HasFlag(f))];
```

```
naive : [None, Read, Write, Admin]
```

`HasFlag` ist ein Teilmengentest, `x.HasFlag(None)` ist also für jedes `x` wahr, und zusammengesetzte Mitglieder wie `Admin` passen ebenfalls. Auf Mitglieder mit einem einzelnen Bit zu filtern behebt beide Probleme auf einmal:

```csharp
// .NET 10, C# 14 -- add to EnumInfo<TEnum>; needs using System.Numerics;
public static readonly ImmutableArray<TEnum> SingleBitFlags =
    [.. Enum.GetValues<TEnum>().Where(v =>
        BitOperations.PopCount(Convert.ToUInt64(v)) == 1)];

public ImmutableArray<TEnum> Flags =>
    [.. EnumInfo<TEnum>.SingleBitFlags.Where(f => value.HasFlag(f))];
```

```
fixed : [Read, Write]
none  : []
read  : [Read]
```

`Convert.ToUInt64` boxt, läuft aber einmal pro Enum-Typ im statischen Initialisierer, nicht pro Aufruf.

## Die Version, die man ausliefern sollte

Alle Teile zusammengesetzt: eine generische Hilfsklasse mit den Caches, ein statischer Block für die Mitglieder auf Typebene, ein Instanzblock für die Mitglieder auf Wertebene, und kein Name, den `System.Enum` bereits belegt.

```csharp
// .NET 10, C# 14
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Reflection;

internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();

    public static readonly FrozenDictionary<TEnum, string> Descriptions =
        Enum.GetValues<TEnum>()
            .DistinctBy(v => v)
            .ToFrozenDictionary(
                v => v,
                v => typeof(TEnum).GetField(v.ToString())
                        ?.GetCustomAttribute<DescriptionAttribute>()?.Description
                     ?? v.ToString());
}

public static class EnumExtensions
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Description => EnumInfo<TEnum>.Descriptions[value];
        public bool IsKnown => EnumInfo<TEnum>.Defined.Contains(value);
    }

    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static ImmutableArray<TEnum> Values => EnumInfo<TEnum>.Values;
        public static int Count => EnumInfo<TEnum>.Values.Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status
{
    [Description("Not yet published")] Draft,
    [Description("Live")]              Active,
    Archived,
}
```

```
Status.Count      : 3
Status.Values     : [Draft, Active, Archived]
Description       : Not yet published
Description (none): Archived
IsKnown           : True / False
Parse             : Active
TryParse bad input: False
```

Das `DistinctBy(v => v)` im Wörterbuch-Aufbau ist keine Zierde. `Enum.GetValues` liefert einen Eintrag pro *Mitglied*, und zwei Mitglieder können sich einen Wert teilen (`Alias = Active`), was ohne den Aufruf eine Ausnahme wegen doppelten Schlüssels auslösen würde. Das ist dasselbe Alias-Detail, das die Persistenz von Enums heikel macht, behandelt unter [ein Enum als Zeichenfolge in EF Core 11 speichern](/de/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/).

Die Reflexion in `Descriptions` bedeutet, dass dieses Muster eine Trimming-Annotation braucht, wenn Sie mit aktiviertem Trimming oder Native AOT veröffentlichen. Lassen Sie das `Description`-Mitglied weg, wenn Sie eines von beiden anvisieren, oder speisen Sie die Zeichenfolgen aus einem Source Generator ein.

Eine Grenze sei genannt: Erweiterungsmitglieder werden zur Kompilierzeit gegen einen Namen aufgelöst, den Sie im Quelltext schreiben. Ist Ihr Enum-Typ zur Laufzeit nur als `Type` bekannt, gilt nichts davon und Sie sind zurück bei den nicht generischen Reflexions-APIs. `extension`-Blöcke machen Enums im Code angenehmer, den Sie kompilieren, nicht im Code, den Sie entdecken.

## Quellen

- [Extension member declarations, C# reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension) auf MS Learn, aktualisiert am 2026-08-13
- [C# 14: Exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) im .NET Blog
- API-Referenz [Enum.GetValues&lt;TEnum&gt;()](https://learn.microsoft.com/en-us/dotnet/api/system.enum.getvalues)
- API-Referenz [FrozenSet&lt;T&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.collections.frozen.frozenset-1)

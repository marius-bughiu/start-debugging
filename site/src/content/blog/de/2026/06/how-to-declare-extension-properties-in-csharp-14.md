---
title: "Wie man Erweiterungseigenschaften in C# 14 deklariert"
description: "Erweiterungseigenschaften kommen in C# 14 über den neuen extension-Block. Deklarieren Sie schreibgeschützte, schreibbare, statische und generische Erweiterungseigenschaften, warum automatische Eigenschaften abgelehnt werden und wie der Compiler sie in get_/set_-Accessoren übersetzt."
pubDate: 2026-06-24
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "extension-members"
lang: "de"
translationOf: "2026/06/how-to-declare-extension-properties-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-06-24
---

Kurze Antwort: Deklarieren Sie eine Erweiterungseigenschaft innerhalb eines `extension`-Blocks in einer statischen Klasse. Benennen Sie den Empfänger, um eine Instanzeigenschaft hinzuzufügen (`extension(string s) { public int WordCount => ...; }`), lassen Sie den Namen weg, um eine statische hinzuzufügen (`extension(Point) { public static Point Origin => ...; }`). Der Eigenschaftskörper ist der Getter; fügen Sie einen `set`-Accessor für eine beschreibbare Eigenschaft hinzu. Die eine Regel, die alle stolpern lässt: Es gibt keine Erweiterungsfelder, daher kompiliert eine automatische Eigenschaft wie `public int Count { get; set; }` nicht. Jeder Accessor muss berechnen oder an echten Speicher weiterleiten.

Diese Funktion erscheint in C# 14, das das .NET 10 SDK oder neuer erfordert (sie funktioniert unter dem .NET 11 SDK gleich). Setzen Sie `<LangVersion>14</LangVersion>` oder `<LangVersion>latest</LangVersion>` in Ihrer `.csproj`. Erweiterungseigenschaften sind ein Teil der umfassenderen Funktion der Erweiterungsmitglieder; dieser Artikel ist der fokussierte Leitfaden für die Eigenschaftshälfte. Wenn Sie die breitere Tour möchten, die auch Operatoren und statische Mitglieder abdeckt, lesen Sie die [Übersicht über die Erweiterungsmitglieder von C# 14](/de/2026/02/csharp-14-extension-members/).

## Warum Sie `string.WordCount` vor C# 14 nie schreiben konnten

Erweiterungsmethoden gibt es seit C# 3.0, aber sie erweiterten nur eine Mitgliedsart: Methoden. Wenn Sie einem Typ, den Sie nicht besitzen, einen berechneten Wert hinzufügen wollten, mussten Sie ihn als Methodenaufruf schreiben:

```csharp
// Before C# 14 - the only option was a method
public static class StringExtensions
{
    public static int WordCount(this string s) =>
        s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
}

// Call site reads like a function, not a property
int n = "hello there world".WordCount();
```

Dieses abschließende `()` ist das verräterische Zeichen. `WordCount` ist konzeptionell eine Eigenschaft der Zeichenfolge, aber die Sprache zwang es in die Methodenform. Automatische Eigenschaften, berechnete Eigenschaften und Indexer auf Typen, die Sie nicht kontrollieren, waren schlicht unerreichbar. C# 14 schließt diese Lücke mit dem `extension`-Block, einem Container, der Eigenschaften, Operatoren und statische Mitglieder neben den alten Methoden im `this`-Stil aufnehmen kann.

## Eine Erweiterungseigenschaft in drei Schritten deklarieren

1. Erstellen Sie eine nicht generische statische Klasse der obersten Ebene, um die Erweiterung aufzunehmen. Dies ist dieselbe Containment-Regel wie bei klassischen Erweiterungsmethoden: Die Klasse darf nicht verschachtelt und nicht generisch sein.
2. Öffnen Sie einen `extension`-Block und deklarieren Sie den Empfänger. Schreiben Sie `extension(string s)`, um die Instanz zu benennen, die die Eigenschaft erweitert, oder `extension(string)` ohne Namen für eine statische Eigenschaft auf dem Typ selbst.
3. Deklarieren Sie die Eigenschaft innerhalb des Blocks mit einem ausdrucksbasierten Getter (oder einem vollständigen `get`/`set`-Körper). Verweisen Sie auf den Empfängerparameter mit dem Namen, den Sie ihm in Schritt 2 gegeben haben.

Zusammengesetzt wird das `WordCount`-Beispiel zu einer echten Eigenschaft:

```csharp
// .NET 11, C# 14 - an instance extension property
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(s);

        public int WordCount =>
            s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

Jetzt verliert die Aufrufstelle die Klammern und liest sich genau wie ein eingebautes Mitglied:

```csharp
string title = "hello there world";
Console.WriteLine(title.WordCount);  // 3
Console.WriteLine(title.IsBlank);    // False
```

Der Empfängername (`s` hier) ist für jedes Mitglied innerhalb des Blocks im Gültigkeitsbereich, sodass verwandte Eigenschaften eine einzige Deklaration dessen teilen, was sie erweitern. Genau das ist der Zweck des Blocks: Er gruppiert die Mitglieder nach dem Typ, den sie erweitern, anstatt `this string` bei jeder Signatur zu wiederholen.

## Schreibbare Erweiterungseigenschaften brauchen einen Platz für den Wert

Erweiterungseigenschaften sind standardmäßig nicht schreibgeschützt. Sie können einen `set`-Accessor hinzufügen, aber da die Laufzeit einer Erweiterung keinen Platz zum Speichern von Daten gibt, muss der Setter den Wert an Speicher weiterleiten, der bereits auf dem Empfänger existiert. Ein sauberer Fall ist es, eine alternative Sicht auf ein Feld bereitzustellen, das der Typ bereits besitzt:

```csharp
// .NET 11, C# 14 - a get/set extension property over existing state
public class Sensor
{
    public double Celsius { get; set; }
}

public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        public double Fahrenheit
        {
            get => sensor.Celsius * 9 / 5 + 32;
            set => sensor.Celsius = (value - 32) * 5 / 9;
        }
    }
}
```

Der Setter liest `value` wie jeder Eigenschafts-Setter und schreibt durch das echte `Celsius`-Feld:

```csharp
var s = new Sensor { Celsius = 20 };
Console.WriteLine(s.Fahrenheit);  // 68
s.Fahrenheit = 212;
Console.WriteLine(s.Celsius);     // 100
```

Was Sie nicht tun können, ist den Compiler zu bitten, Speicher für Sie zu erfinden. Dies ist der häufigste Kompilierungsfehler, auf den Leute stoßen:

```csharp
public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        // ERROR: an extension property cannot be an auto-property,
        // because there is no backing field to generate.
        public string Label { get; set; }
    }
}
```

Es gibt in C# 14 keine Erweiterungsfelder, also gibt es kein Sicherungsfeld zu synthetisieren. Jeder Accessor muss einen Körper haben, der einen Wert berechnet oder ihn durch Mitglieder leitet, die der Empfänger bereits besitzt. Wenn Sie wirklich neuen Zustand an Instanzen eines Typs anhängen müssen, den Sie nicht kontrollieren, ist eine Erweiterungseigenschaft das falsche Werkzeug; greifen Sie zu einer `ConditionalWeakTable<TKey, TValue>` mit der Instanz als Schlüssel und stellen Sie sie über den Getter und den Setter bereit.

## Das Mutieren eines Structs erfordert einen `ref`-Empfänger

Das `Sensor`-Beispiel funktioniert, weil `Sensor` eine Klasse ist, sodass der Setter das Objekt mutiert, das alle teilen. Bei einem Werttyp wird der Empfänger standardmäßig kopiert, und ein Setter würde diese wegwerfbare Kopie mutieren. Deklarieren Sie den Empfänger als `ref`, um in das Original zurückzuschreiben, genau wie `this ref` für mutierende Erweiterungsmethoden funktionierte:

```csharp
// .NET 11, C# 14 - ref receiver so the setter mutates the caller's struct
public static class PointExtensions
{
    extension(ref System.Drawing.Point p)
    {
        public int ManhattanLength
        {
            get => Math.Abs(p.X) + Math.Abs(p.Y);
        }
    }
}
```

Ein `ref`-Empfänger bedeutet auch, dass die Eigenschaft nur auf einer adressierbaren Variablen verwendet werden kann, nicht auf einem temporären Wert wie dem Ergebnis eines Methodenaufrufs. Diese Einschränkung ist dieselbe, die `ref`-Erweiterungsmethoden schon immer mit sich trugen, und sie hält die Mutation sicher.

## Statische Erweiterungseigenschaften lassen den Empfängernamen weg

Lassen Sie den Parameternamen weg, und der Block erweitert den Typ selbst statt einer Instanz. So fügen Sie benannte Konstanten oder fabrikartige Werte hinzu, die sich wie statische Mitglieder eines Typs lesen, den Sie nicht besitzen:

```csharp
// .NET 11, C# 14 - a static extension property on a type you don't own
using System.Drawing;

public static class PointExtensions
{
    extension(Point)
    {
        public static Point Origin => Point.Empty;
    }
}
```

Die Aufrufstelle sieht aus wie ein statisches Mitglied, das schon immer da war:

```csharp
Point start = Point.Origin;
```

Statische und Instanzmitglieder können in getrennten Blöcken innerhalb derselben Klasse leben. Verwenden Sie einen Block mit benanntem Empfänger für die Instanzmitglieder und einen Block mit nacktem Typ für die statischen; der Compiler akzeptiert beide Stile nebeneinander in einer einzigen statischen Klasse.

## Generische Erweiterungseigenschaften: Jeder Typparameter muss den Empfänger erreichen

Setzen Sie die Typparameter auf das `extension`-Schlüsselwort, und sie fließen zu jedem Mitglied innerhalb des Blocks. Damit können Sie Eigenschaften zu offenen generischen Typen wie `IReadOnlyList<T>` hinzufügen:

```csharp
// .NET 11, C# 14 - generic extension properties
public static class ListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public bool IsEmpty => list.Count == 0;

        public T? LastOrDefaultValue =>
            list.Count > 0 ? list[^1] : default;
    }
}
```

Es gibt eine harte Einschränkung, die der Compiler durchsetzt: Jeder im Block deklarierte Typparameter muss vom Empfängertyp verwendet werden. `extension<T>(IReadOnlyList<T> list)` ist zulässig, weil `T` in `IReadOnlyList<T>` erscheint. Ein Block wie `extension<T>(string s)`, der `T` deklariert, es aber nie im Empfänger verwendet, ist ein Kompilierungsfehler, weil der Compiler nichts hat, woraus er `T` an der Aufrufstelle ableiten kann. Einschränkungen kommen ebenfalls auf den Block:

```csharp
public static class ComparableExtensions
{
    extension<T>(IReadOnlyList<T> list) where T : IComparable<T>
    {
        public T Max
        {
            get
            {
                var max = list[0];
                for (int i = 1; i < list.Count; i++)
                    if (list[i].CompareTo(max) > 0) max = list[i];
                return max;
            }
        }
    }
}
```

## Wie der Compiler eine Erweiterungseigenschaft übersetzt und wie man Mehrdeutigkeit auflöst

Eine Erweiterungseigenschaft ist reiner Zucker zur Kompilierungszeit. Der Compiler verwandelt den Block in gewöhnliche statische Accessor-Methoden in einem versteckten verschachtelten Typ: einen Getter namens `get_PropertyName` und, falls vorhanden, einen Setter namens `set_PropertyName`, die jeweils den Empfänger als ihr erstes Argument nehmen. Wenn Sie `title.WordCount` schreiben, schreibt der Compiler es in einen Aufruf dieses generierten `get_WordCount`-Accessors um. Die Reihenfolge der Typparameter in der übersetzten Form ist zuerst die Empfängerparameter, dann etwaige Methodenparameter, was nur wichtig ist, wenn Sie die generierten Metadaten inspizieren.

Daraus folgen zwei Konsequenzen. Erstens verwendet die Auflösung dieselben Gültigkeitsbereichsregeln wie Erweiterungsmethoden: Der Kandidat im nächstgelegenen umschließenden Namespace oder `using` gewinnt, und wenn zwei Erweiterungseigenschaften desselben Namens gleichermaßen im Gültigkeitsbereich sind, erhalten Sie einen Mehrdeutigkeitsfehler statt einer stillen Auswahl. Sie lösen ihn, indem Sie die `using`-Direktiven einschränken oder über die statische Klasse qualifizieren, damit der Compiler weiß, welchen Accessor Sie meinen. Zweitens erscheint die Eigenschaft, da sie nur an der Aufrufstelle existiert, nie in der Laufzeitreflexion über den erweiterten Typ: `typeof(string).GetProperty("WordCount")` gibt `null` zurück. Erweiterungseigenschaften sind eine Sprachbequemlichkeit, keine Laufzeitmodifikation des Typs, sodass alles, was über echte Mitglieder reflektiert (Serializer, Data Binding, ORMs), sie nicht sieht.

## Die Nullbarkeit gehört Ihnen zur Deklaration

Da Sie den Empfängerparameter selbst schreiben, entscheiden Sie, ob die Eigenschaft einen Null-Empfänger akzeptiert. Annotieren Sie den Empfänger als nullbar, um eine Eigenschaft zu schreiben, die auf einer Null-Referenz sicher aufgerufen werden kann, etwas, das eine gewöhnliche Instanzeigenschaft nie sein kann:

```csharp
// .NET 11, C# 14 - a null-tolerant extension property
public static class StringExtensions
{
    extension(string? s)
    {
        public bool HasText => !string.IsNullOrWhiteSpace(s);
    }
}

string? maybe = null;
Console.WriteLine(maybe.HasText);  // False, no NullReferenceException
```

Das passt gut zur Null-Behandlung an der Aufrufstelle, die parallel dazu kam; siehe [die bedingte Null-Zuweisung von C# 14](/de/2026/02/csharp-14-null-conditional-assignment/) für die Verbesserungen von `?.` und `?[]` auf der linken Seite einer Zuweisung.

## Die Grenzfälle, die man vor dem Ausliefern kennen sollte

Ein paar Regeln und Grenzen ersparen Ihnen einen verwirrenden Compiler-Fehler:

- **Keine Felder, keine automatischen Eigenschaften, keine Ereignisse, keine Konstruktoren.** Die `extension`-Blöcke von C# 14 unterstützen Methoden, Eigenschaften, Indexer und Operatoren. Felder sind ausdrücklich ausgeschlossen, was genau der Grund ist, warum automatische Eigenschaften abgelehnt werden.
- **Der Container muss eine nicht generische, nicht verschachtelte statische Klasse sein.** Setzen Sie Ihre Typparameter auf den `extension`-Block, nicht auf die Klasse.
- **Eine Namenskollision mit einem echten Mitglied verliert.** Wenn der erweiterte Typ bereits eine `WordCount`-Eigenschaft hat, gewinnt immer die echte, und Ihre Erweiterungseigenschaft wird nie berücksichtigt. Erweiterungen füllen nur Lücken; sie überschreiben nie.
- **Indexer folgen derselben Form.** Sie können `public T this[int i] => ...` innerhalb eines Instanz-`extension`-Blocks deklarieren, was Ihnen Erweiterungsindexer auf Typen gibt, denen sie fehlen.

Erweiterungseigenschaften sind das ergonomischste Stück der Arbeit an Erweiterungsmitgliedern, und sie lassen sich sauber mit dem Rest von C# 14 kombinieren. Wenn Sie berechnete Mitglieder zu einem Typ hinzufügen, den Sie kontrollieren, im Vergleich zu einem, den Sie nicht kontrollieren, wägen Sie sie gegen die anderen Gestaltungswerkzeuge der Version ab: Sowohl [der Erweiterungsmitglieder-Trick zum Zurückgeben mehrerer Werte](/de/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) als auch [die benutzerdefinierten zusammengesetzten Zuweisungsoperatoren](/de/2026/04/csharp-14-user-defined-compound-assignment-operators/) stützen sich auf dieselbe Syntaxfamilie.

## Quellen

- [Explore extension members in C# 14 (Microsoft Learn Tutorial)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members)
- [C# 14: Exploring extension members (.NET Blog)](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/)
- [Andrew Lock: C# 14 extension members, AKA extension everything](https://andrewlock.net/exploring-dotnet-10-preview-features-3-csharp-14-extensions-members/)

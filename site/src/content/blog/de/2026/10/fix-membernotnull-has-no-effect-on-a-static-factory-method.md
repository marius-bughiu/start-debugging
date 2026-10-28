---
title: "Lösung: [MemberNotNull] wirkt nicht auf einer statischen Factory-Methode und CS8618 bleibt bestehen"
description: "CS8618 wird beim Verlassen des Konstruktors geprüft, und [MemberNotNull] auf einer statischen Methode wird für Instanzmember stillschweigend ignoriert. Übergeben Sie die Werte an einen privaten Konstruktor."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "nullable"
lang: "de"
translationOf: "2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method"
translatedBy: "claude"
translationDate: 2026-10-28
---

`[MemberNotNull]` auf einer statischen Factory-Methode kann `CS8618` nicht beseitigen, denn die Warnung wird am Konstruktor gemeldet, in dem Moment, in dem der Konstruktor endet, und der Compiler schaut nie darauf, was die Factory danach tut. Dazu kommt: Eine statische Methode hat kein `this`. Wenn ihr `[MemberNotNull]` einen Instanzmember nennt, ignoriert der Compiler das Attribut stillschweigend: keine Warnung an der Methode, keine Wirkung für Aufrufer. Die Lösung besteht darin, die Zuweisung zurück in einen Konstruktor zu verlegen: Die Factory berechnet die Werte und übergibt sie an einen privaten Konstruktor, oder die Member werden als `required` markiert und in einem Objektinitialisierer innerhalb der Factory gesetzt. Verifiziert mit dem .NET 10 SDK 10.0.302 (C# 14); das Verhalten ist dasselbe, seit `[MemberNotNull]` mit C# 9 kam.

## Der Fehler im Kontext

Die Build-Ausgabe zeigt auf den privaten Konstruktor, nicht auf die Factory, die Sie annotiert haben:

```
Widget.cs(8,13): warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor. Consider adding the 'required' modifier or declaring the property as nullable.
```

Es gibt keine zweite Diagnose, die meldet, dass das Attribut ignoriert wurde. Genau diese Stille macht es verwirrend: Das `[MemberNotNull(nameof(Name))]` sieht aus, als müsste es etwas bewirken, und nichts im Build sagt etwas anderes.

## Warum das passiert

Hier kommen zwei getrennte Regeln zusammen.

**`CS8618` wird pro Konstruktor geprüft, an dessen Ende.** Der Compiler führt die Nullable-Flussanalyse über jeden Konstruktorrumpf aus (plus Feld- und Eigenschaftsinitialisierer) und stellt an der schließenden Klammer genau eine Frage: Ist jeder nicht nullbare Referenzmember definitiv mit einem Nicht-null-Wert belegt? Dem Objekt folgt er nach dem Ende des Konstruktors nicht. Eine Factory, die `var w = new Widget(); w.Name = name; return w;` ausführt, weist `Name` zu, nachdem der Konstruktor bereits mit `Name` gleich `null` geendet hat, und an diesem Ende sitzt die Warnung. Das Roslyn-Team hat früh entschieden, Initialisierung nicht über Methodenaufrufe hinweg zu verfolgen ("We've decided not to track initialization interprocedurally for now" in [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358)). `[MemberNotNull]` ist der optionale Ausweg für genau einen Fall: einen Helper, der *innerhalb* des Konstruktors auf `this` aufgerufen wird.

**`[MemberNotNull]` auf einer statischen Methode hat nur für statische Member eine Bedeutung.** Das Attribut ist eine Nachbedingung: "Wenn diese Methode zurückkehrt, sind diese Member des Empfängers nicht null." Bei einer Instanzmethode ist der Empfänger `this` (oder das Objekt, auf dem Sie sie aufgerufen haben). Eine statische Methode hat keinen Empfänger, also kann sie nur für statische Felder und Eigenschaften bürgen. Wenn Sie einen Instanzmember angeben, akzeptiert Roslyn das `nameof` (es kompiliert, weil `nameof(Name)` überall in der Klasse gültig ist) und verwirft die Annotation dann. Beide Hälften habe ich mit SDK 10.0.302 bestätigt: Eine statische Methode mit `[MemberNotNull(nameof(Nick))]`, die `Nick` nie zuweist, erzeugt kein `CS8774`, und eine Instanzmethode, die sie aufruft, bekommt beim anschließenden Dereferenzieren von `Nick` trotzdem `CS8602`. Dasselbe Attribut mit einem statischen Feld wird dagegen geprüft und berücksichtigt.

Die statische Factory scheitert also doppelt: Sie ist nicht der Konstruktor, und ihre Annotation nennt Member, die sie nicht beschreiben kann.

## Minimale Reproduktion

```csharp
// .NET 10 SDK 10.0.302, C# 14, <Nullable>enable</Nullable>
using System.Diagnostics.CodeAnalysis;

public class Widget
{
    public string Name { get; set; }

    private Widget() { }                     // CS8618 is reported here

    [MemberNotNull(nameof(Name))]            // silently ignored: static method, instance member
    public static Widget Create(string name)
    {
        var w = new Widget();
        w.Name = name;
        return w;
    }
}
```

Die zweite Form desselben Fehlers ist ein statischer Helper, der die Instanz als Parameter erhält und aus dem Konstruktor aufgerufen wird. Er sieht aus wie das dokumentierte Muster, ist es aber nicht:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public class Gadget
{
    public string Name { get; set; }

    public Gadget(string name) => Init(this, name);   // CS8618 still fires here

    [MemberNotNull(nameof(Name))]
    private static void Init(Gadget g, string name) => g.Name = name;
}
```

`[MemberNotNull]` beschreibt den Empfänger des Aufrufs, und `Init(this, name)` hat keinen Empfänger. `this` als Argument zu übergeben zählt nicht. Die einzige statische Variante, die funktioniert, ist die, bei der Helper und Member beide statisch sind, etwa ein statischer Konstruktor, der einen statischen Loader aufruft:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public static class Config
{
    public static string ConnectionString;

    static Config() => Load();                 // no CS8618: static helper, static member

    [MemberNotNull(nameof(ConnectionString))]
    private static void Load() => ConnectionString = "Server=.;Database=app";
}
```

## Die Lösung im Detail

Alle folgenden Lösungen verlegen die Zuweisung dorthin, wo `CS8618` sie sehen kann: in einen Konstruktor oder hinter einen Vertrag, den der Compiler versteht. Sie sind nach Präferenz geordnet.

### 1. Berechnete Werte an einen privaten Konstruktor übergeben

Das ist die richtige Form für fast jede Factory. Die Factory erledigt die Arbeit (Validierung, Parsing, I/O) und übergibt fertige Werte an einen Konstruktor, der nur zuweist:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Widget
{
    public string Name { get; }

    private Widget(string name) => Name = name;

    public static Widget Create(string raw)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(raw);
        return new Widget(raw.Trim());
    }
}
```

Kein Attribut, keine Unterdrückung, und `Name` kann nur lesbar werden, was eine Factory nach dem Muster "erst konstruieren, dann zuweisen" nie bieten könnte. Bei mehreren Membern bekommt der Konstruktor einfach mehr Parameter. Ein [Record](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) mit privatem positionalem Konstruktor ist die kompakte Variante derselben Idee.

### 2. Den statischen Helper in eine Funktion mit Rückgabewert umbauen

Für die Form `Init(this, ...)` ändern Sie den Helper so, dass er das Berechnete zurückgibt, und lassen den Konstruktor zuweisen:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Gadget
{
    public string Name { get; }

    public Gadget(string raw) => Name = Normalize(raw);

    private static string Normalize(string raw) => raw.Trim().ToLowerInvariant();
}
```

Eine statische Methode mit Rückgabewert ist leichter zu testen als eine, die einen Parameter verändert, und der Compiler sieht eine einfache Zuweisung im Konstruktor. Liefert der Helper mehrere Werte, geben Sie ein Tupel zurück und dekonstruieren es: `(Name, Slug) = Parse(raw);` ist eine definitive Zuweisung beider Member.

### 3. Den Helper zur Instanzmethode machen und aus dem Konstruktor aufrufen

Ist die Initialisierung wirklich ein Block gemeinsam genutzten imperativen Codes, bleibt sie in einem Helper, aber als Instanzmethode, damit `[MemberNotNull]` `this` beschreibt:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Report
{
    public string Title { get; private set; }

    private Report(string raw) => Normalize(raw);

    [MemberNotNull(nameof(Title))]
    private void Normalize(string raw) => Title = raw.Trim();

    public static Report Create(string raw) => new(raw);
}
```

Das ist das Muster, das die [Microsoft-Learn-Seite zu den Nullable-Attributen](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis#helper-methods-membernotnull-and-membernotnullwhen) dokumentiert. Anders als im statischen Fall prüft der Compiler den Helper: Kann `Normalize` zurückkehren, ohne `Title` zuzuweisen, erhalten Sie `CS8774: Member 'Title' must have a non-null value when exiting.`

Eine Falle: Ruft die Factory den Instanz-Helper auf dem neuen Objekt auf (`var r = new Report(); r.Normalize(raw);`), ist `r.Title` für den Rest der Factory zwar nicht null, weil `[MemberNotNull]` für jeden Empfänger gilt, auf dem Sie die Methode aufrufen. Für `CS8618` ändert das trotzdem nichts, denn der Konstruktor war bereits beendet, bevor diese Zeile lief.

### 4. Member als `required` markieren und in der Factory einen Objektinitialisierer verwenden

Wer Konstruktion im Eigenschaftsstil bevorzugt, verschiebt mit `required` die Pflicht vom Konstruktor auf den Objekterstellungsausdruck, und die Factory ist der einzige Ort, der eine Instanz erzeugen kann:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class Invoice
{
    public required string Number { get; init; }
    public required string Customer { get; init; }

    private Invoice() { }

    public static Invoice Create(string number, string customer) =>
        new() { Number = number.Trim(), Customer = customer.Trim() };
}
```

`CS8618` verschwindet, weil ein `required`-Member nicht in der Verantwortung des Konstruktors liegt. Dazu gibt es ein Sicherheitsnetz, das die ursprüngliche Factory nie hatte: Fehlt einer der Member, schlägt der Build mit `CS9035: Required member 'Invoice.Customer' must be set in the object initializer or attribute constructor.` fehl. Das ist ein Fehler, keine Warnung. Die [CS9035-Anleitung](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) behandelt die Aufruferseite dieses Vertrags.

### 5. `[SetsRequiredMembers]` auf einem privaten Konstruktor verwenden

Hat der Typ `required`-Member für öffentliche Aufrufer, die Factory möchte die Werte aber positional übergeben, fügen Sie einen Konstruktor hinzu, der verspricht, alle zu setzen:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed class Tag
{
    public required string Value { get; init; }

    public Tag() { }

    [SetsRequiredMembers]
    private Tag(string value) => Value = value;

    public static Tag Create(string raw) => new(raw.Trim().ToLowerInvariant());
}
```

Wie `[MemberNotNull]` wird auch `[SetsRequiredMembers]` vertraut, nicht verifiziert: Vergisst dieser Konstruktor einen Member, warnt nichts. Halten Sie den Konstruktor so kurz, dass er sich mit bloßem Auge prüfen lässt.

### 6. Letzter Ausweg: am Konstruktor unterdrücken, nicht an der Eigenschaft

Wird der Typ von einem Framework erzeugt, das einen parameterlosen Konstruktor verlangt und die Member danach füllt, beschränken Sie die Unterdrückung auf diesen Konstruktor, damit die Analyse an keiner anderen Stelle verloren geht:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public sealed class LegacyRow
{
    public string Name { get; private set; }

#pragma warning disable CS8618 // Name is always assigned by Create before the instance escapes
    private LegacyRow() { }
#pragma warning restore CS8618

    public static LegacyRow Create(string name) => new() { Name = name };
}
```

Das ist ehrlich in Bezug auf das, was passiert, und der Kommentar sagt dem nächsten Leser, welche Methode das Versprechen hält. Ziehen Sie das einem `= null!` an der Eigenschaft vor: `null!` schaltet die Warnung für jeden Konstruktor stumm, den der Typ je haben wird, auch für später hinzugefügte, die tatsächlich vergessen zuzuweisen.

## Fallstricke und Varianten

- **Das tote Attribut löschen.** Nach der Korrektur der Factory entfernen Sie `[MemberNotNull]` von jeder statischen Methode, die Instanzmember nennt. Es bewirkt nichts, der Compiler wird es nie melden, und die nächste Person kopiert es. Eine schnelle Suche nach `MemberNotNull` in der gesamten Solution, bei der jeder Treffer auf `static` geprüft wird, findet alle.

- **Asynchrone Factorys laufen aus einem anderen Grund in `CS8774`.** Ein `static async Task<T> CreateAsync()` ist meist der Grund, überhaupt zu einer Factory zu greifen, da Konstruktoren kein `await` können. Setzen Sie stattdessen `[MemberNotNull]` auf einen Instanz-Helper `async Task InitAsync()`, prüft der Compiler die Nachbedingung an den `await`-Punkten, an denen die Methode die Kontrolle an den Aufrufer zurückgeben kann, und nicht erst, wenn der Task abgeschlossen ist. Den Member nach einem `await` zuzuweisen, erzeugt also weiterhin `CS8774`. Roslyn betrachtet das als gewolltes Verhalten ([dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022)). Die Lösung ist dieselbe wie Lösung 1: das I/O innerhalb der statischen Factory mit `await` abwarten und die Ergebnisse dann an einen privaten Konstruktor übergeben.

- **Bei einer `TryCreate`-Factory den `out`-Parameter annotieren, nicht die Member.** Den Aufrufer interessiert, ob das zurückgegebene Objekt null ist, und das ist eine Nachbedingung des Parameters:

  ```csharp
  // .NET 10 SDK 10.0.302, C# 14
  using System.Diagnostics.CodeAnalysis;

  public sealed class Sku
  {
      public string Code { get; }
      private Sku(string code) => Code = code;

      public static bool TryCreate(string? raw, [NotNullWhen(true)] out Sku? sku)
      {
          sku = string.IsNullOrWhiteSpace(raw) ? null : new Sku(raw.Trim());
          return sku is not null;
      }
  }
  ```

  Die Member selbst sind nicht nullbar und durch den privaten Konstruktor garantiert, weitere Attribute sind also nicht nötig.

- **`[MemberNotNull]` lässt sich nicht auf einen Konstruktor setzen.** Das Attribut gilt nur für Methoden und Eigenschaften. Dass ein abgeleiteter Konstruktor für einen Member der Basisklasse bürgen kann, ist eine offene Anfrage ([dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526)). Reichen Sie den Wert stattdessen über `base(...)` nach oben.

- **Instanz-Helper auf einem anderen Objekt wirken, aber nur lokal.** `other.Init(); other.Name.Length` bleibt ohne Warnung, weil der Empfänger `other` ist. Innerhalb eines Factory-Rumpfs ist das nützlich, erfüllt aber nie nachträglich den Konstruktor, der `other` erzeugt hat.

- **Verzögert initialisierte Member sind ein anderes Problem.** Hat `Name` berechtigterweise bis zur ersten Verwendung keinen Wert, ist er nullbar oder gehört hinter `Lazy<T>`. Vergleichen Sie die Optionen in [Lazy&lt;T&gt; vs LazyInitializer vs double-checked locking](/de/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/), statt gegen `CS8618` anzukämpfen.

## Verwandte Artikel

- [Lösung: CS8618 "Non-nullable property must contain a non-null value when exiting constructor"](/de/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) für die allgemeine Warnung und das Muster mit Instanz-Helper und `[MemberNotNull]`.
- [Lösung: CS9035 "Required member 'X' must be set in the object initializer"](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) für den Fehler, den eine `required`-basierte Factory auslöst, wenn sie einen Member vergisst.
- [record vs class vs struct in C#: eine Entscheidungsmatrix](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) für die Wahl einer Typform, bei der Initialisierung im Konstruktor natürlich ist.
- [Was ein C#-with-Ausdruck tatsächlich kopiert](/de/2026/10/what-does-a-csharp-with-expression-actually-copy/) für einen weiteren Fall, in dem die Konstruktion den erwarteten Code umgeht.
- [Null-bedingte Zuweisung in C# 14](/de/2026/02/csharp-14-null-conditional-assignment/) für mehr dazu, wie der Compiler über null urteilt.

## Quellen

- Microsoft Learn, [Attributes interpreted by the compiler: Nullable static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis) (der Abschnitt "Helper methods: MemberNotNull and MemberNotNullWhen" und sein Beispiel mit Konstruktor-Helper).
- Microsoft Learn, [MemberNotNullAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.membernotnullattribute) (Attributziele: Methoden und Eigenschaften).
- Microsoft Learn, [Nullable reference type warnings](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (`CS8618`, `CS8774`).
- GitHub, [dotnet/roslyn#32358](https://github.com/dotnet/roslyn/issues/32358) (Initialisierung wird nicht über Methodenaufrufe hinweg verfolgt).
- GitHub, [dotnet/roslyn#71526](https://github.com/dotnet/roslyn/issues/71526) (`[MemberNotNull]` ist auf Konstruktoren nicht erlaubt).
- GitHub, [dotnet/roslyn#75022](https://github.com/dotnet/roslyn/issues/75022) (`CS8774` bei asynchronen `[MemberNotNull]`-Methoden ist gewollt).

---
title: "Was kopiert ein C# `with`-Ausdruck tatsächlich, und warum werden berechnete Record-Eigenschaften nicht neu berechnet?"
description: "Ein with-Ausdruck ruft die vom Compiler generierte Methode <Clone>$ des Records auf, die einen Kopierkonstruktor ausführt: Er kopiert jedes Instanzfeld und überspringt alle Initialisierer. Deshalb sind Eigenschaften, die aus anderen Eigenschaften initialisiert werden, zwischengespeicherte Werte und Guid-IDs nach dem Kopieren veraltet. Gemessen unter .NET 10 mit C# 14, samt den Lösungen, die tatsächlich funktionieren."
pubDate: 2026-10-16
tags:
  - "csharp"
  - "csharp-14"
  - "records"
  - "dotnet-10"
  - "immutability"
lang: "de"
translationOf: "2026/10/what-does-a-csharp-with-expression-actually-copy"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Kurze Antwort:** In C# 14 unter .NET 10 (und in jeder Version seit der Einführung von Records in C# 9) tut `a with { X = 1 }` auf einer Record-Klasse zwei Dinge: Es ruft die vom Compiler generierte Methode `<Clone>$` auf, die den Kopierkonstruktor des Records aufruft, und führt anschließend die aufgelisteten `init`-Accessoren der Reihe nach aus. Der Kopierkonstruktor kopiert **jedes Instanzfeld** Byte für Byte (eine flache Kopie) und führt **keine** Feld- oder Eigenschaftsinitialisierer aus. Eine Eigenschaft wie `public string FullName { get; } = $"{First} {Last}";` wird also einmal im Konstruktor des Originals berechnet, als gespeicherter Wert kopiert und nie neu berechnet. Machen Sie abgeleitete Werte zu Ausdruckskörper-Membern (`=> $"{First} {Last}"`) oder setzen Sie Caches in den `init`-Accessoren der Eigenschaften zurück, von denen sie abhängen.

Der Rest dieses Beitrags zeigt genau, was der Compiler generiert, welche Arten von "berechneten" Membern ein `with` überleben und welche nicht, einen fiesen Nebeneffekt auf die Gleichheit, wenn in einem Record zwischengespeichert wird, und die Muster, die sich bewähren. Jede Ausgabe unten stammt von dateibasierten Apps (`dotnet run probe.cs`) mit SDK 10.0.302 und Laufzeit 10.0.10.

## Was der Compiler für einen Record generiert

Nehmen Sie einen einfachen positionalen Record:

```csharp
// .NET 10, C# 14
record Person(string First, string Last);
```

Neben dem primären Konstruktor, den Eigenschaften, der Gleichheit und `ToString` erzeugt der Compiler zwei kopierende Member. Die [Records-Spezifikation](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members) nennt sie den "Kopierkonstruktor" und die "Clone"-Methode. Beide lassen sich per Reflection sichtbar machen:

```csharp
// .NET 10, C# 14
using System.Reflection;

foreach (var m in typeof(Person).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
                                .Where(m => m.Name.Contains("Clone")))
    Console.WriteLine($"method: {m.Name} virtual={m.IsVirtual} returns {m.ReturnType.Name}");

foreach (var c in typeof(Person).GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
    Console.WriteLine($"ctor: ({string.Join(",", c.GetParameters().Select(p => p.ParameterType.Name))}) protected={c.IsFamily}");
```

Ausgabe:

```text
method: <Clone>$ virtual=True returns Person
ctor: (String,String) protected=False
ctor: (Person) protected=True
```

`<Clone>$` ist ein Name, den Sie in C# nicht schreiben können, daher kann ihn nur der Compiler aufrufen. Der Rumpf lautet schlicht `return new Person(this);`. Im geschützten Konstruktor `Person(Person original)` findet das Kopieren statt, und die Spezifikation ist genau darin, was er tut: Nach dem Aufruf des Basis-Kopierkonstruktors (oder von `object()`) "kopiert er die Werte aller Instanzfelder, die im Record-Typ implizit oder explizit deklariert sind", und er "führt keine Instanzfeld- oder Eigenschaftsinitialisierer aus, die in der Record-Deklaration vorhanden sind."

Dieser Ausdruck:

```csharp
var b = a with { First = "Grace" };
```

wird also etwa so umgewandelt:

```csharp
var tmp = a.<Clone>$();   // new Person(a): field-by-field copy, no initializers
tmp.First = "Grace";       // the init accessor, legal here because the compiler emits it
var b = tmp;
```

Aus dieser Umwandlung folgen zwei Konsequenzen. Erstens läuft während des Kopierens nichts von dem, was Sie im Record-Rumpf geschrieben haben, außer den `init`-Accessoren der Member, die Sie nennen. Zweitens laufen diese `init`-Accessoren nach dem Kopieren, auf einer Instanz, die bereits jedes Feld des Originals enthält.

## Vier Arten, eine "berechnete" Eigenschaft zu schreiben, vier verschiedene Ergebnisse

Hier ist ein Record mit vier Membern, die alle so aussehen, als würden sie sich aus `First` und `Last` ableiten:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string Init { get; } = $"{First} {Last}";   // property initializer
    public string Expr => $"{First} {Last}";            // expression-bodied
    private string? _cached;
    public string Cached => _cached ??= $"{First} {Last}"; // lazy cache in a field
}
```

Und ein Durchlauf, der den Cache vor dem Kopieren anfasst:

```csharp
var a = new Name("Ada", "Lovelace");
Console.WriteLine(a.Cached);              // fills the cache on a
var b = a with { First = "Grace" };
Console.WriteLine($"{b.Init} | {b.Expr} | {b.Cached}");
Console.WriteLine(b);
```

Ausgabe:

```text
Ada Lovelace
Ada Lovelace | Grace Lovelace | Ada Lovelace
Name { First = Grace, Last = Lovelace, Init = Ada Lovelace, Expr = Grace Lovelace, Cached = Ada Lovelace }
```

Nur die Ausdruckskörper-Eigenschaft ist korrekt. Die Gründe lassen sich eins zu eins auf die Umwandlung oben abbilden:

- **`Init { get; } = ...`** wird von einem versteckten `<Init>k__BackingField` gestützt. Der Initialisierer lief genau einmal, im primären Konstruktor von `a`. Der Kopierkonstruktor hat das Backing Field als String kopiert und den Initialisierer nicht erneut ausgeführt. `First` änderte sich danach, aber nichts weist `Init` jemals neu zu.
- **`Expr => ...`** hat kein Backing Field. Es ist eine Methode, die bei jedem Aufruf `First` und `Last` liest, und spiegelt daher wider, was die Kopie gerade enthält.
- **`Cached => _cached ??= ...`** ist die subtile Variante. Rufen Sie `with` auf, *bevor* jemand `Cached` am Original liest, ist `_cached` noch `null`, wird als `null` kopiert, und die Kopie berechnet den richtigen Wert. Ist der Cache des Originals bereits gefüllt, erbt die Kopie `"Ada Lovelace"`, und das `??=` greift nie. Der Fehler hängt davon ab, ob zufällig ein unabhängiger Codepfad die Eigenschaft zuerst gelesen hat, was ihn mühsam reproduzierbar macht.

Dasselbe passiert mit allem, was ein Feldinitialisierer erzeugt. Ein Record mit `public Guid Id { get; } = Guid.NewGuid();` behält in jeder `with`-Kopie **dieselbe** `Id`. Dass der Initialisierer schlicht nicht ausgeführt wird, habe ich mit einem Zähler bestätigt:

```csharp
// .NET 10, C# 14
var t = new Tracked("x");
var t2 = t with { Value = "y" };
Console.WriteLine($"initializer runs: {Counter.Count}, stamp same: {t.Stamp == t2.Stamp}");

static class Counter { public static int Count; }
record Tracked(string Value)
{
    public long Stamp { get; } = ++Counter.Count;
}
```

```text
initializer runs: 1, stamp same: True
```

Eine Konstruktion, ein Initialisierer-Lauf, zwei Instanzen. Wenn Sie Records für Ereignisse oder Befehle mit generierter ID oder generiertem Zeitstempel verwenden, liefert `with` ein zweites Objekt, das behauptet, dasselbe Ereignis zu sein.

## Die Gleichheitsfalle: versteckte Felder zählen bei `==` mit

Auch die Record-Gleichheit wird aus Instanzfeldern synthetisiert, privaten eingeschlossen. Die veraltete Kopie von oben ist daher nicht gleich einem frisch erzeugten Record mit denselben sichtbaren Daten:

```csharp
var c = new Name("Grace", "Lovelace");
Console.WriteLine(b == c); // False: b.Init and b._cached still say "Ada Lovelace"
```

Schlimmer noch: Ein Lazy-Cache macht die Gleichheit abhängig von der *Lesehistorie*, selbst ganz ohne `with`:

```csharp
// .NET 10, C# 14
var x = new Name2("Ada", "Lovelace");
var y = new Name2("Ada", "Lovelace");
Console.WriteLine(x == y);   // True
_ = x.FullName;              // only reads a property
Console.WriteLine(x == y);   // False

record Name2(string First, string Last)
{
    private string? _fullName;
    public string FullName => _fullName ??= $"{First} {Last}";
}
```

```text
True
False
```

Das Lesen eines Getters hat das Ergebnis von `==` verändert. Sind solche Records Dictionary-Schlüssel, Set-Mitglieder oder werden sie in einer Test-Assertion verglichen, entstehen Fehlschläge, die verschwinden, sobald Sie zum Debuggen ein `Console.WriteLine` einfügen. Das ist das stärkste Argument dagegen, in einem Record überhaupt zwischenzuspeichern.

## Es ist eine flache Kopie, bis ganz nach unten

Der Kopierkonstruktor kopiert Feldwerte. Bei Feldern mit Referenztyp ist der Wert eine Referenz, sodass beide Records auf dasselbe Objekt zeigen:

```csharp
// .NET 10, C# 14
var o = new Order(1, new List<string> { "apple" });
var o2 = o with { Id = 2 };
o2.Items.Add("pear");
Console.WriteLine($"o.Items: {string.Join(",", o.Items)} same list: {ReferenceEquals(o.Items, o2.Items)}");

record Order(int Id, List<string> Items);
```

```text
o.Items: apple,pear same list: True
```

Dasselbe gilt für ein `Lazy<T>`-Feld (beide Kopien teilen sich das bereits ausgewertete `Lazy`), einen `StringBuilder` oder eine verschachtelte veränderliche Klasse. Ein Record ist nur so unveränderlich wie sein veränderlichstes Feld. Bevorzugen Sie `ImmutableArray<T>` oder `IReadOnlyList<T>`, gestützt auf ein Array, das Sie nie verändern, und betrachten Sie `with` als "die oberste Ebene kopieren".

## Vererbung: `with` behält den Laufzeittyp

`<Clone>$` ist virtuell, und jeder abgeleitete Record überschreibt es mit einem kovarianten Rückgabetyp. Ein `with` über eine Variable vom Basistyp erzeugt den abgeleiteten Typ:

```csharp
// .NET 10, C# 14
Person p = new Student("Alan", "Turing", "King's");
var q = p with { First = "Alonzo" };
Console.WriteLine(q.GetType().Name); // Student

record Person(string First, string Last);
record Student(string First, string Last, string College) : Person(First, Last);
```

Reflection auf `Student` zeigt `<Clone>$ returns Student`. Das ist meist das Gewünschte, bedeutet aber, dass `with` auf einer Basisreferenz Zustand kopiert, der nur im abgeleiteten Typ existiert (hier `College`) und den der aufrufende Code nicht einmal sehen kann, einschließlich veralteter Cache-Felder, die im abgeleiteten Record deklariert sind.

Bei einem `sealed record` macht der Compiler den Kopierkonstruktor `private` und `<Clone>$` nicht virtuell (die Probe gab `sealed copy ctor private: True; clone virtual: False` aus).

## Was ein `with`-Ausdruck zuweisen darf

Weil `with` die Accessoren nach dem Klonen ausführt, kann es nur Member setzen, die einen `set`- oder `init`-Accessor haben und an der Aufrufstelle zugänglich sind. Der Versuch, eine veraltete berechnete Eigenschaft durch Zuweisung zu "reparieren", schlägt fehl:

```csharp
// .NET 10, C# 14
record A(int X) { public int Computed { get; } = X * 2; }

var b = new A(1) with { Computed = 3 };
// error CS0200: Property or indexer 'A.Computed' cannot be assigned to -- it is read only
```

`with` auf einer gewöhnlichen Klasse wird komplett abgelehnt, weil eine Klasse kein `<Clone>$` hat:

```text
error CS8858: The receiver type 'Svc' is not a valid record type and is not a struct type.
```

Seit C# 10 funktioniert `with` auch auf Structs (einschließlich `record struct`), Tupeln und anonymen Typen. Für diese gibt es weder eine Clone-Methode noch einen Kopierkonstruktor: Der Wert wird so kopiert wie jede Struct-Zuweisung, anschließend werden die aufgelisteten Member zugewiesen. Die [Dokumentation zum `with`-Ausdruck](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression) hält klar fest, dass sich die Kopiersemantik für Struktur-Typen nicht anpassen lässt.

`required`-Member zwingen Sie nicht dazu, sich in einem `with` zu wiederholen. Der synthetisierte Kopierkonstruktor ist mit `[SetsRequiredMembers]` markiert, daher lässt sich `r with { }` auf einem Record mit `required string Name` kompilieren und kopiert `Name`. Falls `required`-Member in Initialisierern für Verwirrung sorgen, behandelt die [Anleitung zu CS9035](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) die Seite der Objektinitialisierer.

## Lösungen, die sich tatsächlich bewähren

### 1. Beim Zugriff berechnen (die Standardantwort)

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string FullName => $"{First} {Last}";
}
```

Kein Backing Field, nichts zu kopieren, nichts, das veralten kann, und nichts Zusätzliches in `Equals`/`GetHashCode`. Die eigene Empfehlung von Microsoft auf der `with`-Seite lautet genauso: Berechnete Eigenschaften in Records sollten "beim Zugriff berechnet und nicht bei der Erstellung der Instanz initialisiert werden." Das Interpolieren zweier Strings ist billig; messen Sie, bevor Sie entscheiden, dass es das nicht ist.

### 2. In `init`-Accessoren validieren oder neu berechnen

`init`-Accessoren sind der einzige Teil Ihres Codes, der während eines `with` tatsächlich läuft. Das [`field`-Schlüsselwort](/de/2025/04/c-14-the-field-keyword-and-field-backed-properties/) aus C# 14 macht es einfach, dort Logik unterzubringen, ohne ein Backing Field zu deklarieren. Die Validierung funktioniert so, wie Sie hoffen:

```csharp
// .NET 10, C# 14
record Person(string First, string Last)
{
    public string Last { get; init => field = string.IsNullOrEmpty(value)
        ? throw new ArgumentException("Last required")
        : value; } = Last;
}

var bad = new Person("Ada", "Lovelace") with { Last = "" }; // throws ArgumentException: Last required
```

Ist ein Wert wirklich teuer und Sie müssen ihn zwischenspeichern, invalidieren Sie den Cache aus den `init`-Accessoren der Eingaben und nehmen den Cache aus der Gleichheit heraus:

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    private string? _fullName;
    public string First { get; init { field = value; _fullName = null; } } = First;
    public string Last  { get; init { field = value; _fullName = null; } } = Last;
    public string FullName => _fullName ??= $"{First} {Last}";

    public virtual bool Equals(Name? other) =>
        other is not null && EqualityContract == other.EqualityContract
        && First == other.First && Last == other.Last;
    public override int GetHashCode() => HashCode.Combine(First, Last);
}
```

Mit dieser Version gibt `a with { First = "Grace" }` `Grace Lovelace` aus, selbst wenn `a.FullName` zuvor gelesen wurde, und `b == new Name("Grace", "Lovelace")` ist `True`. Der Preis: Sie pflegen `Equals` und `GetHashCode` nun von Hand, und der Compiler warnt nicht, wenn Sie eine Eigenschaft hinzufügen und vergessen, sie einzubeziehen.

### 3. Einen eigenen Kopierkonstruktor schreiben

Sie können den Kopierkonstruktor selbst deklarieren und nur kopieren, was erhalten bleiben soll:

```csharp
// .NET 10, C# 14
record Fixed(string First, string Last)
{
    private string? _full;
    public string FullName => _full ??= $"{First} {Last}";

    protected Fixed(Fixed original)
    {
        First = original.First;
        Last = original.Last;
        // _full deliberately not copied
    }
}
```

Das funktioniert (`f with { First = "Grace" }` ergibt `Grace Lovelace`, nachdem der Cache des Originals gefüllt war) und ist der dokumentierte Weg, eine Liste tief zu kopieren. Es hat aber auch die schärfsten Kanten:

- Sie sind nun für das Kopieren **jedes** Feldes verantwortlich. Fügen Sie nächsten Monat eine Eigenschaft hinzu und vergessen diesen Konstruktor, setzt `with` sie stillschweigend auf `default` zurück.
- In einem abgeleiteten Record müssen Sie an den Basis-Kopierkonstruktor weiterleiten. Lassen Sie das weg, erhalten Sie zwei Fehler, `CS1729: 'Base' does not contain a constructor that takes 0 arguments` und `CS8868: A copy constructor in a record must call a copy constructor of the base, or a parameterless object constructor if the record inherits from object.` Die Lösung ist `protected Derived(Derived other) : base(other) { ... }`.
- Er muss `public` oder `protected` sein, außer der Record ist versiegelt.
- Für `Equals` bewirkt er nichts: Ein Cache-Feld lässt `==` weiterhin von der Lesehistorie abhängen.

Nutzen Sie ihn für tiefe Kopien von Sammlungen, nicht als Mechanismus zur Cache-Invalidierung.

### 4. Identität nicht in einen Initialisierer legen

Für IDs und Zeitstempel, die pro Instanz eindeutig sein müssen, erzeugen Sie sie nicht in einem Eigenschaftsinitialisierer eines Records, auf dem Sie `with` verwenden wollen. Übergeben Sie sie entweder explizit (`evt with { Id = Guid.NewGuid() }`) oder erzeugen Sie neue Ereignisse über eine Factory statt über `with`. Ein Ereignis zu kopieren und seine ID zu behalten ist genau das, wofür `with` gedacht ist.

## Eine Checkliste für Record-Typen, auf denen Sie `with` verwenden

- Jeder abgeleitete Wert ist ein Ausdruckskörper-Member oder wird aus `init`-Accessoren neu berechnet.
- Keine privaten Cache-Felder, außer Sie überschreiben auch `Equals` und `GetHashCode`.
- Keine veränderlichen Sammlungen, oder ein eigener Kopierkonstruktor, der sie klont.
- Keine Initialisierer wie `= Guid.NewGuid()` oder `= DateTime.UtcNow` auf Typen, die kopiert werden.
- Abgeleitete Records, die einen Kopierkonstruktor deklarieren, leiten an `base(original)` weiter.

Wenn Sie entscheiden, ob ein Typ überhaupt ein Record sein soll, behandelt die [Entscheidungsmatrix Record vs. Klasse vs. Struct](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) die Abwägungen, und der EF-Core-Aspekt (eine `with`-Kopie ist eine Instanz, die der Change Tracker nie gesehen hat) steht in [Records mit EF Core 11 richtig verwenden](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/). Dart-Entwickler stoßen mit `copyWith` auf dieselbe Frage zur flachen Kopie, besprochen in [Dart-Records vs. Freezed-Klassen](/de/2026/05/dart-records-vs-freezed-classes/).

## Verwandte Beiträge

- [Record vs. Klasse vs. Struct in C#: eine Entscheidungsmatrix](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)
- [Records mit EF Core 11 richtig verwenden](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [C# 14: das `field`-Schlüsselwort und feldgestützte Eigenschaften](/de/2025/04/c-14-the-field-keyword-and-field-backed-properties/)
- [CS9035 beheben: Das required-Member muss im Objektinitialisierer gesetzt werden](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)

## Quellen

- [The `with` expression, C# reference (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression)
- [Records, nondestructive mutation (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record#nondestructive-mutation)
- [Records proposal, "Copy and Clone members" (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members)
- [The `field` keyword (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field)

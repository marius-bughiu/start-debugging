---
title: "record vs class vs struct in C#: eine Entscheidungsmatrix"
description: "C# 14 bietet vier Datentyp-Formen -- class, record class, struct und record struct. Dies ist die Entscheidungsmatrix: wann jede korrekt ist, was jede kostet und die Regeln, die für Sie entscheiden."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "csharp"
  - "records"
  - "structs"
  - "dotnet-10"
lang: "de"
translationOf: "2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix"
translatedBy: "claude"
translationDate: 2026-05-20
---

Wenn Sie zwischen `class`, `record` und `struct` für einen neuen Typ in C# 14 / .NET 10 wählen, ist die Standardauswahl `class`. Greifen Sie zu `record class` (dem Standard-`record`), wenn der Typ unveränderliche Daten enthält und Wertgleichheit der Vertrag ist. Greifen Sie zu `readonly record struct`, wenn der Typ klein ist (16 Bytes oder weniger), unveränderlich, und durch heiße Pfade kopiert wird, in denen eine Heap-Allokation pro Instanz schmerzhaft wäre. Verwenden Sie einen einfachen `struct` nur für unmanaged Interop oder wenn Sie wirklich einen Werttyp fester Größe an Ort und Stelle mutieren müssen. Verwenden Sie einen einfachen `record` (das ist `record class`), wenn Sie Unveränderlichkeit und Wertgleichheit ohne Kampf mit dem GC wollen.

Dieser Beitrag ist die lange Fassung. Jedes Beispiel zielt auf `<TargetFramework>net10.0</TargetFramework>` mit `<LangVersion>14.0</LangVersion>`.

## Die vier Formen, die Sie tatsächlich haben

C# hat zwei Speicherarten (Referenztyp, Werttyp) und einen orthogonalen `record`-Modifier, der Wertgleichheit, einen primären Konstruktor, Unterstützung für `with`-Ausdrücke und ein vom Compiler generiertes `ToString` hinzufügt. Das ergibt vier Formen:

- `class`: Referenztyp, Referenzgleichheit standardmäßig.
- `record class` (das bloße Schlüsselwort `record`): Referenztyp, Wertgleichheit.
- `struct`: Werttyp, feldweise Wertgleichheit (über `ValueType.Equals` mit Reflektion) -- langsam, sofern Sie es nicht überschreiben.
- `record struct`: Werttyp, Wertgleichheit (vom Compiler generiert, keine Reflektion).

`readonly record struct` ist die häufigste struct-Form, die Sie tatsächlich schreiben werden. Sie markiert jedes Feld als `readonly` und macht die gesamte Instanz unveränderlich, was 90 Prozent der Fälle ist, in denen Sie zu einem struct greifen.

## Funktionsmatrix

| Funktion                                    | `class`             | `record class`         | `struct`             | `record struct`           |
| ------------------------------------------ | ------------------- | ---------------------- | -------------------- | ------------------------- |
| Speicher                                    | Heap                | Heap                   | inline / Stack       | inline / Stack            |
| Standardgleichheit                          | Referenz            | Wert (compiler-gen.)   | Wert (Reflektion)    | Wert (compiler-gen.)      |
| `with`-Ausdruck                             | nein                | ja                     | nein                 | ja                        |
| Compiler-generiertes `ToString`             | nein                | ja                     | nein                 | ja                        |
| Vererbung                                   | ja                  | ja (nur Records)       | nein                 | nein                      |
| Standard-Veränderbarkeit                    | veränderbar         | init-only (unveränderlich) | veränderbar      | veränderbar; `readonly record struct` ist unveränderlich |
| Boxt beim Cast auf `object` / Interface     | nein                | nein                   | ja                   | ja                        |
| Kopierkosten                                | Zeigerkopie         | Zeigerkopie            | vollständige Bitkopie | vollständige Bitkopie    |
| `null` erlaubt (NRT aus)                    | ja                  | ja                     | nein (`T?` verwenden) | nein (`T?` verwenden)    |
| Allokiert auf dem Heap                      | jede Instanz        | jede Instanz           | nur beim Boxen       | nur beim Boxen            |
| Gut als Dictionary-Schlüssel                | nur wenn Sie `Equals`/`GetHashCode` implementieren | ja, von Haus aus | nein -- Reflektionsgleichheit ist langsam | ja, von Haus aus |
| Gut als EF Core-Entität                     | ja                  | ja (mit Sorgfalt)      | nein                 | nein                      |

Die Tabelle ist der Beitrag. Alles unten ist das Warum.

## Warum `class` die Standardwahl ist

Eine `class` wird auf dem verwalteten Heap allokiert, per Referenz zugegriffen und ist gleich einer anderen Instanz nur, wenn beide Referenzen auf dasselbe Objekt zeigen. Referenzsemantik ist die natürliche Wahl für Dinge mit Identität: ein `User`, ein `Customer`, ein `HttpClient`. Zwei `User`-Objekte mit demselben Namen und E-Mail sind nicht derselbe Benutzer; sie sind zwei Datensätze, die zufällig Daten teilen. Referenzgleichheit passt zu diesem mentalen Modell.

`class` ist auch die einzige Form, die Vererbung mit beliebigen abgeleiteten Typen unterstützt. `record` unterstützt ebenfalls Vererbung, aber nur zwischen anderen Records. `struct` und `record struct` unterstützen keine.

Wählen Sie `class`, wenn:

- Der Typ Identität hat ("dies ist *der* Kunde, kein kundenartiger Wert").
- Der Typ vom Design her veränderlich ist.
- Der Typ in einer Klassenhierarchie mit Nicht-Record-Basisklassen teilnimmt.
- Der Typ eine EF Core-Entität ist, die Änderungsverfolgung benötigt. EF Core 11 unterstützt Records als Entitäten, aber der Weg des geringsten Widerstands ist immer noch eine `class` mit init-only Eigenschaften und einem Bindungskonstruktor. Siehe [wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/) für die sitzweise Entscheidung.

```csharp
// .NET 10, C# 14
public class Customer
{
    public Guid Id { get; init; }
    public string Email { get; set; } = "";
    public DateTimeOffset CreatedAt { get; init; }
}
```

Dies ist die Rolle, die eine Zeile in der Datenbank besitzt und sich im Laufe der Zeit ändern darf.

## Wann Sie zu `record class` greifen sollten

Ein `record` (das ist `record class` -- das Schlüsselwort `class` ist impliziert) ist die richtige Antwort für unveränderliche Datenträger, bei denen zwei Instanzen mit denselben Feldwerten als gleich behandelt werden sollten. Der Compiler generiert ein wertbasiertes `Equals`, `GetHashCode`, `ToString` sowie eine virtuelle `EqualityContract`-Methode, die Vererbung zum Laufen bringt. Die positionale Syntax `public record Address(string City, string Zip);` fügt einen primären Konstruktor und eine init-only Eigenschaft pro Parameter hinzu.

Wählen Sie `record class`, wenn:

- Der Typ ein DTO, eine Request-/Response-Form, ein Domain-Event oder ein Konfigurations-Snapshot ist.
- Sie den Typ als Dictionary-Schlüssel oder in einem `HashSet<T>` verwenden und Wertgleichheit der Vertrag ist.
- Sie häufig eine modifizierte Kopie erzeugen: `var newer = original with { Status = "shipped" };`.
- Sie möchten, dass der Compiler `ToString` für Sie schreibt, damit strukturierte Logs jedes Feld standardmäßig anzeigen.

Eine record class wird immer noch auf dem Heap allokiert und per Referenz zugegriffen, sodass die "es ist günstig herumzureichen"-Intuition über `class` weiterhin gilt. Sie zahlen eine Allokation pro Instanz, aber Sie zahlen keine Bitkopie jedes Mal, wenn Sie sie an eine Methode übergeben.

```csharp
// .NET 10, C# 14
public sealed record OrderPlaced(Guid OrderId, decimal Total, DateTimeOffset At);

var evt = new OrderPlaced(orderId, 42.50m, DateTimeOffset.UtcNow);
var corrected = evt with { Total = 42.95m };

// evt != corrected
// Console.WriteLine(evt) prints OrderPlaced { OrderId = ..., Total = 42.50, At = ... }
```

Zwei Warnungen. Erstens: deklarieren Sie Records als `sealed`, sofern Sie nicht wirklich eine Record-Hierarchie benötigen. Der Compiler emittiert eine `EqualityContract`-Indirektion bei jedem Record, damit abgeleitete Records an der Wertgleichheit teilnehmen können, und `sealed` ermöglicht es dem JIT, die Aufrufe zu devirtualisieren. Zweitens: setzen Sie keine veränderlichen Sammlungseigenschaften auf einen Record. Die Wertgleichheit von `record` vergleicht Referenzen für diese Eigenschaften, nicht Inhalte, was zu "warum sind diese beiden Records nicht gleich"-Überraschungen führt. Verwenden Sie `ImmutableArray<T>` oder `IReadOnlyList<T>`, einmal initialisiert.

## Wann Sie zu `struct` (und besonders `readonly record struct`) greifen sollten

Ein `struct` ist ein Werttyp. Seine Felder leben inline in dem, was ihn enthält: auf dem Stack für lokale Variablen, innerhalb des enthaltenden Objekts auf dem Heap für Felder, Ende-an-Ende gepackt in Arrays. Jede Zuweisung ist eine Bitkopie des gesamten struct. Gleichheit kann, wenn Sie sie liefern, eine einzige CPU-Vergleichsoperation sein statt eines virtuellen Aufrufs.

Das ist fantastisch, wenn die Daten klein sind und Sie viele davon haben. Ein struct aus zwei `int`-Feldern kann in einem Registerpaar gehalten, mit einem Branch verglichen und in einem Array als 8 Bytes pro Element ohne Per-Element-Header gespeichert werden. Dieselbe Payload als `class` wäre ein 24-Byte-Objektheader plus eine 8-Byte-Referenz pro Slot, was die Cache-Lokalität zerstört, sobald das Array größer als die L1-Linie ist.

Die [choose between class and struct](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct) Empfehlung von Microsoft listet vier Bedingungen für einen struct: er repräsentiert logisch einen einzelnen Wert, hat eine Instanzgröße unter 16 Bytes, ist unveränderlich, und wird nicht häufig geboxt. Alle vier zusammen, nicht drei von vier.

Wählen Sie `readonly record struct` (oder `readonly struct`, wenn Sie keine Wertgleichheit benötigen), wenn:

- Der Typ ein kleiner, unveränderlicher Wert ist: eine Koordinate, ein Geldbetrag, eine stark typisierte ID, ein Zeitstempel mit fester Präzision.
- Sie viele davon in einem Array oder `Span<T>` halten und heiß iterieren werden.
- Sie sie nicht boxen werden. Cast auf `object` oder auf ein nicht-readonly Interface boxt; Cast auf ein `ref struct` Interface in C# 13+ tut das nicht (wenn der JIT es beweisen kann).
- Sie keine Vererbung benötigen.

```csharp
// .NET 10, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero(string currency) => new(0m, currency);
    public Money Plus(Money other) =>
        other.Currency == Currency
            ? new(Amount + other.Amount, Currency)
            : throw new InvalidOperationException("currency mismatch");
}
```

Dies kompiliert zu einem Werttyp mit eingebauter Wertgleichheit, einem Deconstructor, einem `ToString`-Override und unveränderlicher Semantik. Es ist der moderne Ersatz für "ich schreibe einen `struct` und erinnere mich daran, ihn nicht veränderlich zu machen".

Die 16-Byte-Regel ist eine Heuristik, keine harte Obergrenze. Der JIT übergibt einen 24-Byte-struct gerne in Registern auf AMD64, wenn er in die Aufrufkonvention passt. Der Grund, structs klein zu halten, sind die Bitkopien. Jede Zuweisung, jede Parameterübergabe ohne `in`, jeder `LINQ`-Schritt kopiert das Ganze. Ein 64-Byte-struct, der per Wert durch fünf Methoden-Frames übergeben wird, sind 320 Bytes Kopieren.

## Wann `record struct` (veränderlich) die richtige Wahl ist

Ein einfacher `record struct` (ohne `readonly`) ist selten, aber legitim. Er bietet Wertgleichheit, einen primären Konstruktor und ein `ToString`, lässt aber die Felder neu zuweisbar. Zwei Szenarien sind sinnvoll:

- Hot-Loop-Akkumulatoren, bei denen Sie compiler-generierte Gleichheit und `ToString` wollen, aber auch Felder an Ort und Stelle mutieren wollen, um Kopier-Churn zu vermeiden: `state.Count++; state.Total += x;` auf einem `record struct State`, das in einer einzigen Lokalen lebt.
- Interop-Formen, bei denen Sie Wertsemantik und die Möglichkeit wollen, den struct nach der Konstruktion Feld für Feld zu füllen.

Für alles andere bevorzugen Sie `readonly record struct`. Ein veränderlicher struct ist ein berüchtigter Fallstrick: ihn einer Eigenschaft zuzuweisen erzeugt eine Kopie, die Kopie wird mutiert, und am Original passiert stillschweigend nichts.

## Die Entscheidungsmatrix, die Sie an die Wand kleben können

Drei Fragen, in dieser Reihenfolge. Stoppen Sie bei der ersten, die irgendwohin zeigt.

1. **Hat dieser Typ Identität oder besitzt er sich ändernden Zustand über die Zeit?** Ja -> `class`. Beispiele: `User`, `Order`, `HttpClient`, EF Core-Entitäten, alles in einem Service-Container mit einer Lebensdauer.

2. **Ist dieser Typ unveränderliche Daten, die wertgleich sein sollten und klein (16 Bytes oder weniger, keine Referenzen auf große Objekte)?** Ja -> `readonly record struct`. Beispiele: `Money`, `Point`, stark typisierte IDs wie `UserId(Guid Value)`, `(int Row, int Column)`-Zellen. Die 16-Byte-Schwelle ist am wichtigsten, wenn Sie sie in Arrays, Spans halten oder durch heiße Schleifen leiten.

3. **Andernfalls: ist der Typ unveränderliche Daten mit Wertgleichheit?** Ja -> `record` (`record class`). Beispiele: DTOs, Request-/Response-Modelle, Domain-Events, Konfigurations-Snapshots, Nachrichtentypen in einer Queue. Dies ist die Standardwahl für "Daten-Klassen" im modernen C#.

Wenn nichts davon irgendwohin zeigte, wollen Sie mit ziemlicher Sicherheit `class`. Der verbleibende Fall ist "ich brauche einen Werttyp, aber er ist über 16 Bytes groß", was meist bedeutet, den Typ umzustrukturieren, nicht stärker auf `struct` zu setzen.

## Der Benchmark: wann struct-Kopien tatsächlich wehtun

Eine häufige Behauptung lautet "structs sind schneller". Manchmal sind sie es, manchmal dominieren die Kopierkosten. Hier ist eine schnelle Messung für eine 24-Byte-Payload, die durch fünf Methoden-Frames übergeben wird.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<CopyCost>();

public readonly record struct PayloadStruct(long A, long B, long C); // 24 bytes
public sealed record PayloadClass(long A, long B, long C);           // pointer + 24 bytes on heap

[MemoryDiagnoser]
public class CopyCost
{
    private readonly PayloadStruct _s = new(1, 2, 3);
    private readonly PayloadClass _c = new(1, 2, 3);

    [Benchmark(Baseline = true)]
    public long Struct_ByVal()  => Sum1(_s);
    [Benchmark]
    public long Struct_ByIn()   => Sum2(in _s);
    [Benchmark]
    public long Class_ByRef()   => Sum3(_c);

    static long Sum1(PayloadStruct p)     => p.A + p.B + p.C;
    static long Sum2(in PayloadStruct p)  => p.A + p.B + p.C;
    static long Sum3(PayloadClass p)      => p.A + p.B + p.C;
}
```

Methodik: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X. Zahlen aus einem einzelnen Lauf; führen Sie auf Ihrer eigenen Hardware erneut aus, bevor Sie darauf setzen.

| Methode       | Mittel     | Allokiert |
| ------------- | ---------- | --------- |
| Struct_ByVal  | 0,31 ns    | 0 B       |
| Struct_ByIn   | 0,28 ns    | 0 B       |
| Class_ByRef   | 0,34 ns    | 0 B       |

Der per Wert übergebene struct ist etwas schneller als die per Referenz zugegriffene Klasse, und `in` spart noch ein Haar mehr. Aber der Abstand ist sub-nanosekündig. Der struct gewinnt entscheidend nur, wenn Sie die Klasse millionenfach allokieren -- die Allokationskosten unterscheiden sich, nicht die Zugriffskosten. Wählen Sie struct wegen Allokationsdrucks, nicht wegen "schnelleren Zugriffs".

Wenn der struct wächst, kippt das Muster. Ein veränderlicher 64-Byte-struct, der per Wert durch drei Frames übergeben wird, ist eine messbare Regression gegenüber einer `class`-Referenz. Die 16-Byte-Regel existiert, weil das ungefähr der Punkt ist, an dem die Bitkopie auf AMD64 aufhört, gratis zu sein.

## Die Fallstricke, die für Sie entscheiden

Einige Dinge erzwingen die Entscheidung unabhängig von der Präferenz.

- **Gleichheit mit Sammlungen in der Payload.** Wenn Ihr Record eine `List<int>` enthält, werden zwei Records mit strukturell gleichen Listen als ungleich verglichen, weil die Wertgleichheit von `record` `EqualityComparer<T>.Default` verwendet, das für `List<T>` auf Referenzgleichheit zurückfällt. Verwenden Sie `ImmutableArray<T>` (das strukturelle Gleichheit hat) oder überschreiben Sie `Equals` manuell.

- **EF Core-Entitäten und `record`.** EF Core 11 kann Records als Entitäten verfolgen, aber der `with`-Ausdruck erzeugt eine neue Instanz, die der Change-Tracker noch nie gesehen hat. Wenn ein Request-Handler `customer = customer with { Email = "..." }` macht, hält der Change-Tracker immer noch die alte Referenz, was dazu führt, dass kein `UPDATE` ausgegeben wird. Bleiben Sie bei `class` für verfolgte Entitäten.

- **Default(struct) ist ein echter Wert.** Ein `struct` kann nicht `null` sein. `default(Money)` ist eine `Money`-Instanz mit Nullbetrag und leerer String-Währung, die das Typsystem als gültig betrachtet. Wenn ein Nullwert für Ihren Typ keinen Sinn ergibt, fügen Sie entweder eine `IsValid`-Eigenschaft hinzu oder verwenden Sie eine `record class`, sodass `null` Ihr "kein Wert"-Signal ist.

- **Interfaces boxen Werttypen.** Cast von `Money` auf `IEquatable<Money>` boxt den struct auf den Heap, allokiert einen neuen Objektheader und kopiert die Payload. Wenn Sie beabsichtigen, auf einen struct durch ein Interface in einer engen Schleife zuzugreifen, haben Sie entweder die falsche Form gewählt oder Sie benötigen eine generische Einschränkung (`where T : struct, IEquatable<T>`), damit der JIT ohne Boxen spezialisieren kann.

- **Hash-Codes für verfolgte structs.** Einen veränderlichen struct in ein `Dictionary` oder `HashSet` zu setzen ist ein Bug. Die Sammlung nimmt den Hash-Code beim Einfügen und speichert ihn; wenn Sie ein Feld mutieren, ändert sich der Hash des Wertes und die Sammlung kann ihn nicht mehr finden. `readonly record struct` macht das konstruktiv unmöglich.

## Die meinungsstarke Empfehlung, neu formuliert

Standardmäßig `class`. Wählen Sie `record` (`record class`) für unveränderliche Daten mit Wertgleichheit. Wählen Sie `readonly record struct` für kleine unveränderliche Werte, die Sie in Masse halten oder durch heiße Schleifen leiten. Wählen Sie einen einfachen `struct` nur, wenn Interop oder In-Place-Mutation in einer einzigen Lokalen den Fallstrick wert sind, und wählen Sie eine Nicht-`record`-`class` für Entitäten und identitätstragende Typen.

Zwei Folgerungen, die ins Muskelgedächtnis gehören:

- Ein `record` mit primärem Konstruktor und `sealed` ist die moderne "Datenklasse". Wenn Sie sich dabei ertappen, eine Klasse mit nur init-only Eigenschaften zu schreiben und `Equals` sowie `GetHashCode` zu überschreiben, hat der Compiler das bereits für Sie geschrieben.
- Ein `readonly record struct` macht "illegale Zustände nicht repräsentierbar machen" praktikabel für kleine Werte. Stark typisierte IDs (`public readonly record struct UserId(Guid Value);`) sind zur Laufzeit im Wesentlichen kostenlos und eliminieren eine Kategorie von "ich habe die Bestell-ID übergeben, wo die User-ID erwartet wurde"-Bugs zur Kompilierzeit.

## Verwandt

- [Wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [Wie man mehrere Werte aus einer Methode in C# 14 zurückgibt](/de/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/)
- [async void vs async Task in C#: wann jedes korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Wie man den neuen System.Threading.Lock-Typ in .NET 11 verwendet](/de/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/)
- [Wie man SearchValues korrekt in .NET 11 verwendet](/de/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)

## Quellen

- [Records (C#-Referenz) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [Strukturtypen (C#-Referenz) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct)
- [Wahl zwischen class und struct -- .NET-Design-Richtlinien](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct)
- [`readonly`-Strukturtypen -- C#-Referenz](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct#readonly-struct)
- [Record structs Vorschlag -- C#-Sprachdesign-Notizen](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/record-structs.md)

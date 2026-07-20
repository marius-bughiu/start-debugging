---
title: "Lösung: CS8618 \"Non-nullable property must contain a non-null value when exiting constructor\" in C#"
description: "CS8618 bedeutet, dass ein nicht-nullbares Feld oder eine Eigenschaft beim Verlassen des Konstruktors nicht initialisiert war. Weisen Sie es im Konstruktor zu, geben Sie einen Standardwert, markieren Sie es als required oder machen Sie es nullbar."
pubDate: 2026-07-20
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "nullable"
lang: "de"
translationOf: "2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor"
translatedBy: "claude"
translationDate: 2026-07-20
---

`CS8618` wird ausgelöst, wenn für ein nicht-nullbares Referenzmitglied (ein Feld oder eine Auto-Eigenschaft) nicht garantiert ist, dass es beim Beenden eines Konstruktors einen Nicht-Null-Wert enthält. Der Compiler kann nicht beweisen, dass das Mitglied zugewiesen wurde, und warnt daher, dass ein `null` entweichen könnte. Beheben Sie es auf eine von vier Arten, in ungefährer Reihenfolge der Präferenz: weisen Sie es im Konstruktor zu, geben Sie ihm einen Feldinitialisierer, markieren Sie es als `required`, sodass der Aufrufer es setzen muss, oder machen Sie das Mitglied nullbar (`string?`), falls `null` tatsächlich gültig ist. Dies wurde mit C# 14 auf .NET 11 verifiziert; die Diagnose verhält sich so, seit nullbare Referenztypen in C# 8 eingeführt wurden, und .NET 6 war die Version, die den nullbaren Kontext in neuen Projekten standardmäßig aktiviert hat.

## Der Fehler im Kontext

Der aktuelle Compiler gibt eine einheitliche Meldung für Felder und Eigenschaften aus:

```
warning CS8618: Non-nullable variable must contain a non-null value when exiting constructor. Consider declaring it as nullable.
```

Ältere SDKs (und viele noch offene StackOverflow-Threads) zeigen die feld- und eigenschaftsspezifischen Formulierungen, die viele tatsächlich in die Suche eingeben:

```
warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor.
warning CS8618: Non-nullable field '_name' must contain a non-null value when exiting constructor.
```

Alle drei sind dieselbe Diagnose mit derselben Ursache. Beachten Sie das Wort *warning*, nicht *error*: `CS8618` stoppt den Build standardmäßig nicht. Es wird nur dann zu einem den Build brechenden Fehler, wenn Sie `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` oder `<WarningsAsErrors>CS8618</WarningsAsErrors>` in Ihrem Projekt haben, was viele Teams genau deshalb tun, damit Lücken in der Null-Sicherheit nicht ignoriert werden können.

## Warum das passiert

Nullbare Referenztypen, in C# 8 eingeführt und seit .NET 6 in den Vorlagen standardmäßig aktiviert (`<Nullable>enable</Nullable>` in der `.csproj`), teilen jeden Referenztyp in zwei Zustände auf: nicht-nullbar (`string`) und nullbar (`string?`). Ein nicht-nullbares Mitglied ist ein Versprechen: "dies wird niemals null sein." Die Aufgabe des Compilers ist es, Sie an dieses Versprechen zu halten, und die Stelle, an der er das am einfachsten prüfen kann, ist die Konstruktion. Wenn ein Konstruktor zurückkehrt, muss jedes nicht-nullbare Feld und jede nicht-nullbare Auto-Eigenschaft nachweislich nicht null sein. Kann der Compiler das nicht beweisen, erhalten Sie `CS8618`.

Der entscheidende Ausdruck ist "nachweislich." Der Compiler führt eine statische Analyse durch; er führt Ihren Code nicht aus. Er vertraut genau drei Dingen: einem Feld- oder Eigenschaftsinitialisierer, einer direkten Zuweisung innerhalb des Konstruktors und einer Hilfsmethode, die annotiert ist, um zu sagen, dass sie das Mitglied zuweist. Ein Konstruktor, der den Wert über einen Pfad zuweist, dem der Compiler nicht folgen kann, oder ein Mitglied, das ein Framework erst später setzt, zählt gar nicht. Das ist dasselbe "Beweisen, nicht Zeigen"-Modell hinter der [Diagnose für erforderliche Mitglieder CS9035](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/): Der Compiler liest die Absicht nicht aus Ihren Methodenkörpern.

Eine subtile Falle: Eine Absicherung mit einer Null-Prüfung innerhalb des Konstruktors hilft nicht. Code wie `if (name is null) throw new ArgumentNullException(nameof(name));` beweist, dass der *Parameter* nicht null ist, aber der Compiler sieht das *Mitglied* weiterhin als nicht zugewiesen an, solange Sie es nicht tatsächlich zuweisen. Das überrascht Entwickler oft genug, um ein eigenes langlebiges Roslyn-Issue zu haben.

## Minimale Reproduktion

Der kleinste Typ, der `CS8618` auslöst, in einem Projekt mit aktiviertem nullbarem Kontext:

```csharp
// .NET 11, C# 14, <Nullable>enable</Nullable>
public class Person
{
    public string Name { get; set; }    // CS8618: never assigned
    public string Email { get; set; }   // CS8618: never assigned
    public int Age { get; set; }        // fine, value type has a default
}
```

Zwei Warnungen, eine pro nicht-nullbarer Referenzeigenschaft. `Age` bleibt still, weil Werttypen immer einen Standard haben (`0`); Nullbarkeitswarnungen betreffen Referenztypen. Fügen Sie einen Konstruktor hinzu, der nur ein Mitglied setzt, und Sie erhalten weiterhin eine Warnung:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name)
    {
        Name = name;      // Name is proven
    }

    public string Name { get; set; }
    public string Email { get; set; }   // CS8618: still not assigned on this path
}
```

Der Compiler prüft jeden Konstruktor unabhängig. Lässt irgendein Konstruktor ein nicht-nullbares Mitglied unzugewiesen, erzeugt dieser Konstruktor die Warnung.

## Die Lösung im Detail

Arbeiten Sie diese Optionen der Reihe nach durch. Die ersten drei sind die, die Sie meistens wollen; die letzten beiden sind Notausgänge für den Fall, dass das Mitglied tatsächlich an einer Stelle initialisiert wird, die der Compiler nicht sehen kann.

### 1. Initialisieren Sie das Mitglied in einem Konstruktor

Wird der Wert benötigt, um ein gültiges Objekt zu bauen, nehmen Sie ihn als Konstruktorparameter und weisen Sie ihn zu. Das ist das Design, zu dem die Warnung Sie drängt:

```csharp
// .NET 11, C# 14
public class Person
{
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }

    public string Name { get; set; }
    public string Email { get; set; }
}
```

Beide Mitglieder sind nun auf jedem Konstruktionspfad nachweislich zugewiesen, sodass beide Warnungen verschwinden. Haben Sie mehrere Konstruktoren, leiten Sie sie durch einen einzigen, damit die Zuweisung an einer einzigen Stelle liegt: `public Person() : this("John", "Doe") { }` stellt den Compiler zufrieden, weil der verkettete Konstruktor die Arbeit erledigt.

### 2. Geben Sie dem Mitglied einen Standardwert mit einem Feldinitialisierer

Gibt es einen sinnvollen Standard und wollen Sie nicht jeden Aufrufer zwingen, den Wert zu übergeben, initialisieren Sie das Mitglied dort, wo es deklariert wird:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
}
```

Ein Feldinitialisierer läuft vor jedem Konstruktorkörper, sodass das Mitglied auf jedem Pfad automatisch nicht null ist. Das ist die sauberste Lösung für eher optionale Werte wie leere Zeichenfolgen oder `new List<string>()`-Sammlungen. Es ist auch besser, als den Typ nullbar zu machen, wenn das Mitglied zur Laufzeit niemals null sein sollte, weil es den Nicht-Null-Vertrag für alle wahrt, die die Eigenschaft lesen.

### 3. Markieren Sie das Mitglied als `required` (C# 11 und später)

Ist das Mitglied verpflichtend, Sie wollen dafür aber keinen Konstruktorparameter, verwenden Sie den Modifikator `required`. Er verschiebt die Verpflichtung in den Objektinitialisierer des Aufrufers und bringt als Bonus `CS8618` zum Schweigen, weil der Compiler nun weiß, dass das Mitglied gesetzt werden muss, bevor das Objekt entweicht:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; set; }
    public required string Email { get; set; }
}

// the caller is now forced to set both
var p = new Person { Name = "Ada", Email = "ada@example.com" };
```

Das ist oft die beste moderne Antwort für DTOs und Konfigurationsobjekte: kein Boilerplate-Konstruktor, kein falscher Standardwert, und die Nicht-Null-Garantie wird an jeder Aufrufstelle erzwungen. Der Kompromiss ist, dass das Auslassen eines Werts an der Aufrufstelle zu einem Kompilierungsfehler (`CS9035`) wird statt zu einer Warnung am Typ. Wenn Sie dazu greifen, lesen Sie den ergänzenden Beitrag über [CS9035 und erforderliche Mitglieder](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/), damit Sie wissen, wie der aufruferseitige Fehler aussieht.

### 4. Machen Sie das Mitglied nullbar, wenn `null` ein gültiger Zustand ist

Kann das Mitglied wirklich fehlen, sollte es `string?` sein, nicht `string`. Das Hinzufügen des `?` teilt dem Compiler und jedem Leser mit, dass dieser Wert null sein könnte, was ehrlich ist und die Null-Prüfung dorthin verschiebt, wo der Wert konsumiert wird:

```csharp
// .NET 11, C# 14
public class Person
{
    public string Name { get; set; } = string.Empty;
    public string? MiddleName { get; set; }   // legitimately optional
}
```

Greifen Sie dazu nicht nur, um die Warnung bei einem Mitglied zum Schweigen zu bringen, das nie wirklich null ist. Ein Mitglied als nullbar zu markieren, obwohl es in der Praxis immer gesetzt ist, schiebt Phantom-Null-Prüfungen (oder `!`-Null-Vergebungsoperatoren) auf jeden Konsumenten. Reservieren Sie `?` für Werte, die tatsächlich optional sind.

### 5. Annotieren Sie eine Hilfsmethode mit `[MemberNotNull]` oder verwenden Sie `null!` für vom Framework initialisierte Mitglieder

Manchmal ist das Mitglied initialisiert, nur nicht an einer Stelle, der der Compiler folgt. Zwei Werkzeuge decken das ab.

Erledigt eine gemeinsame private Methode die Initialisierung, teilen Sie es dem Compiler mit `[MemberNotNull]` mit:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Student
{
    public string Major { get; set; }

    public Student() => SetMajor();

    [MemberNotNull(nameof(Major))]
    private void SetMajor(string? major = null) => Major = major ?? "Undeclared";
}
```

`[MemberNotNull]` behauptet, dass das genannte Mitglied nach der Rückkehr der Methode nicht null ist, sodass ein Konstruktor, der sie aufruft, als das Mitglied zuweisend gilt. Wie `[SetsRequiredMembers]` ist dies ein Versprechen, dem der Compiler ungeprüft glaubt, halten Sie es also ehrlich.

Der andere Fall ist ein Mitglied, das ein Framework per Reflexion setzt, der Klassiker ist ein EF-Core-`DbSet`. Der Basis-`DbContext` füllt diese, aber der Compiler kann das nicht sehen, daher lautet die Redewendung, mit `null!` zu initialisieren:

```csharp
// .NET 11, EF Core 11
public class TodoContext : DbContext
{
    public TodoContext(DbContextOptions<TodoContext> options) : base(options) { }

    public DbSet<TodoItem> TodoItems { get; set; } = null!;
}
```

Das `null!` sagt "nimm an, dies ist nicht null; ich weiß, dass es anderswo gesetzt wird." Es ist eine gezielte Unterdrückung, keine Lösung, verwenden Sie es also nur, wenn etwas außerhalb Ihres Konstruktors die Initialisierung wirklich vornimmt. Dieses Muster taucht im gesamten EF-Core-Code auf; dieselbe Überlegung gilt für Entitäten, die das ORM materialisiert, behandelt in [wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Fallstricke und Varianten

Eine Handvoll Situationen erzeugt `CS8618` oder etwas Ähnliches aus Gründen, die die Meldung nicht ausbuchstabiert:

- **Eine Null-Prüfung des Parameters weist das Mitglied nicht zu.** Eine `ArgumentNullException` zu werfen, wenn ein Parameter null ist, beweist, dass der Parameter nicht null ist, lässt das Mitglied im Modell des Compilers aber unzugewiesen. Sie müssen weiterhin `Name = name;` schreiben. Validieren und zuweisen; Validieren allein genügt nicht.

- **Die Standardkonstruktion eines `struct` umgeht Ihren Konstruktor.** Bei einem `struct` initialisiert der parameterlose Standard (`default(MyStruct)` oder `new MyStruct()`, wenn kein expliziter parameterloser Konstruktor läuft) jedes Feld auf null, sodass nicht-nullbare Referenzfelder als `null` verbleiben, ohne Warnung an der `default`-Stelle. Der Compiler warnt bei den deklarierten Konstruktoren Ihres struct, kann aber nicht verhindern, dass ein Aufrufer eine genullte Instanz erhält. Verlassen Sie sich bei einem struct nicht auf `required` oder einen Konstruktor, um Nicht-Null-Felder zu garantieren; ein `default`-Wert umgeht beides.

- **Reflexion und Serialisierer bauen Objekte ohne Ihren Konstruktor.** `Activator.CreateInstance`, `System.Text.Json` und ORMs können ein Objekt bauen, ohne den Konstruktor auszuführen, der Ihre Mitglieder zugewiesen hätte, sodass ein Mitglied, das der Compiler als nicht null bewiesen hat, zur Laufzeit dennoch `null` sein kann. Wenn Sie `required` verwenden, beachten Sie, dass `System.Text.Json` erforderliche Mitglieder seit .NET 8 respektiert und eine `JsonException` wirft, wenn das JSON eines auslässt, was die Laufzeithälfte desselben Vertrags ist. Wenn Sie volle Kontrolle darüber brauchen, wie ein Typ aus JSON gebaut wird, übernimmt [ein benutzerdefinierter JsonConverter](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) die Konstruktion vollständig.

- **Feldgestützte Eigenschaften und das Schlüsselwort `field`.** Bei einer normalen Auto-Eigenschaft ist das Hintergrundfeld das, was die Analyse verfolgt. Verwenden Sie das `field`-Schlüsselwort von C# 14, um einem Accessor Logik hinzuzufügen, gilt dieselbe Regel für das vom Compiler synthetisierte Hintergrundfeld: Es muss beim Beenden des Konstruktors nicht null sein, initialisieren Sie es also wie jedes andere Mitglied.

- **`= default!` versus `= null!`.** Für Referenzmitglieder bedeuten sie dasselbe (`default` für einen Referenztyp ist `null`), und beide bringen die Warnung zum Schweigen. Bevorzugen Sie `null!` für Referenzmitglieder, weil es sich als "absichtlich vorerst null" liest, und reservieren Sie `default!` für generische Mitglieder, bei denen der Typparameter ein Werttyp sein könnte.

- **Das Ganze abzuschalten ist fast nie die Lösung.** Sie können den nullbaren Kontext mit `#nullable disable` um eine Datei oder Region herum verkleinern, aber das verwirft die Null-Sicherheitsanalyse für alles darin, nicht nur für das eine Mitglied. Wollen Sie ein einzelnes Mitglied zum Schweigen bringen, von dem Sie wissen, dass es in Ordnung ist, ist `null!` an diesem Mitglied weit gezielter als das Deaktivieren des Kontexts. Ein `#nullable disable` für eine ganze Datei ist ein Migrationswerkzeug, keine Lösung.

Das mentale Modell, das Sie behalten sollten: `CS8618` ist der Compiler, der das Versprechen durchsetzt, das ein nicht-nullbares Mitglied gibt. Wenn Sie es sehen, entscheiden Sie, was tatsächlich zutrifft, und handeln Sie entsprechend. Das Mitglied ist verpflichtend (weisen Sie es in einem Konstruktor zu oder markieren Sie es als `required`), es hat einen vernünftigen Standard (geben Sie ihm einen Feldinitialisierer), es ist wirklich optional (machen Sie es `string?`), oder es wird durch Code initialisiert, den der Compiler nicht sehen kann (`[MemberNotNull]` oder `null!`). Zu `null!` bei einem Mitglied zu greifen, das ein Aufrufer setzen soll, verschiebt nur eine Kompilierungswarnung in eine `NullReferenceException` zur Laufzeit, was genau der Fehler ist, den nullbare Referenztypen verhindern sollen.

## Verwandt

- [Lösung: CS9035 "Required member 'X' must be set in the object initializer"](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) für den aufruferseitigen Fehler, den Sie erhalten, sobald Sie ein Mitglied als `required` markieren.
- [record vs class vs struct in C#: eine Entscheidungsmatrix](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/), um die Typform zu wählen, bevor Sie entscheiden, wie Mitglieder initialisiert werden.
- [Wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/) für die DbSet-`null!`-Redewendung und Mitglieder, die das ORM per Reflexion materialisiert.
- [Wie man einen benutzerdefinierten JsonConverter in System.Text.Json schreibt](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), um die Konstruktion zu übernehmen, wenn die Serialisierung Ihren Konstruktor umgeht.
- [Null-bedingte Zuweisung in C# 14](/de/2026/02/csharp-14-null-conditional-assignment/) für mehr dazu, wie C# im Alltagscode über null nachdenkt.

## Quellen

- Microsoft Learn, [Nullable reference type warnings (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) (exakter `CS8618`-Text, der Abschnitt "nonnullable reference not initialized" und die vier Lösungstechniken, einschließlich `[MemberNotNull]` und `null!`).
- Microsoft Learn, [required modifier (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (wie `required` die Verpflichtung an den Aufrufer verschiebt und die Nicht-Null-Prüfung erfüllt).
- Microsoft Learn, [Working with nullable reference types in EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/nullable-reference-types) (das Muster `DbSet` = `null!` und warum der Compiler die Initialisierung der Basisklasse nicht sehen kann).
- GitHub, [dotnet/roslyn Issue #60283](https://github.com/dotnet/roslyn/issues/60283) (warum eine Null-Prüfung im Konstruktor `CS8618` nicht beseitigt).

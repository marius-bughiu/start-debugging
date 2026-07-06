---
title: "Lösung: CS9035 \"Required member 'X' must be set in the object initializer\" in C#"
description: "CS9035 bedeutet, dass ein als required markiertes Member nicht zugewiesen wurde. Weisen Sie es im Objektinitialisierer zu, oder fügen Sie einen mit [SetsRequiredMembers] annotierten Konstruktor hinzu, der jedes required-Member setzt."
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer"
translatedBy: "claude"
translationDate: 2026-07-06
---

`CS9035` tritt zur Kompilierzeit auf, wenn Sie eine Instanz eines Typs erzeugen, der ein `required`-Member hat, dieses Member aber nicht zugewiesen wird. Der Compiler verlangt, dass jedes `required`-Feld und jede `required`-Eigenschaft gesetzt wird, bevor das Objekt die Konstruktion verlässt. Beheben Sie es auf direktem Weg: Fügen Sie das Member dem Objektinitialisierer hinzu, zum Beispiel `new Person { Name = "Ada" }`. Wenn ein Konstruktor das Member bereits zuweist, teilen Sie es dem Compiler mit, indem Sie `[SetsRequiredMembers]` an diesen Konstruktor schreiben, damit er den Initialisierer nicht mehr verlangt. Dies ist gegen C# 14 auf .NET 11 verifiziert; der `required`-Modifizierer und dieses Diagnosemeldung verhalten sich seit C# 11 auf .NET 7 gleich.

## Der Fehler im Kontext

Die vollständige Meldung nennt das genaue Member, das dem Compiler fehlt:

```
error CS9035: Required member 'Person.Name' must be set in the object initializer or attribute constructor.
```

Sie sehen ein `CS9035` pro nicht zugewiesenem required-Member, sodass ein Typ mit drei required-Eigenschaften und einem leeren `new Person()` drei Fehler auf einmal erzeugt. Es ist eine Kompilierzeit-Diagnose, keine Laufzeitausnahme: Der Build schlägt fehl, nichts läuft. Das ist der ganze Sinn von `required`: Die Prüfung wanderte von einer `NullReferenceException`, auf die Sie in der Produktion trafen, zu einer roten Unterschlängelung, die Sie im Editor sehen.

## Warum das passiert

Der `required`-Modifizierer, in C# 11 eingeführt, markiert ein Feld oder eine Eigenschaft als zwingend zum Zeitpunkt der Initialisierung. Wenn ein beliebiger Ausdruck eine neue Instanz des Typs konstruiert, prüft der Compiler, dass jedes `required`-Member zugewiesen ist, entweder über einen Objektinitialisierer oder über einen Konstruktor, der verspricht, sie zu setzen. Kann er das nicht beweisen, gibt er `CS9035` aus.

Das Schlüsselwort ist "beweisen". Der Compiler führt Ihren Code nicht aus. Er vertraut nur zwei Dingen: einem Member, das Sie direkt im Objektinitialisierer zuweisen, und einem Konstruktor, der explizit mit `[SetsRequiredMembers]` annotiert ist. Ein Konstruktor, der das Member zufällig in seinem Rumpf zuweist, aber das Attribut nicht trägt, zählt gar nichts; der Compiler liest den Rumpf nicht, um das herauszufinden. Deshalb überlebt der Fehler, selbst wenn Ihr Konstruktor den Wert eindeutig setzt: Sie müssen es dem Compiler sagen, nicht zeigen.

Drei Situationen erzeugen den Fehler:

- Sie rufen `new T()` oder `new T { ... }` auf, ohne jedes `required`-Member zuzuweisen.
- Sie haben einen Konstruktor geschrieben, der die required-Member setzt, aber `[SetsRequiredMembers]` vergessen, sodass der Compiler weiterhin einen Initialisierer verlangt.
- Sie haben `required` zu einem Member eines Basistyps hinzugefügt, und der Konstruktionspfad eines abgeleiteten Typs erfüllt es nicht mehr.

## Minimale Reproduktion

Der kleinste Typ, der `CS9035` auslöst:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }   // not required, optional
}
```

Jede dieser Konstruktionen schlägt beim Kompilieren fehl:

```csharp
// .NET 11, C# 14
var a = new Person();                        // CS9035 x2 (Name and Email)
var b = new Person { Name = "Ada" };         // CS9035 x1 (Email still missing)
var c = new Person { Age = 36 };             // CS9035 x2 (Name and Email)
```

Nur wenn beide required-Member vorhanden sind, kompiliert sie:

```csharp
// .NET 11, C# 14 -- compiles
var ok = new Person { Name = "Ada", Email = "ada@example.com" };
```

Beachten Sie, dass `Age` weggelassen wird und das in Ordnung ist. `required` gilt pro Member; optionale Member bleiben optional. Dem Compiler ist nur wichtig, dass die Member, die den `required`-Modifizierer tragen, zugewiesen sind.

## Die Lösung im Detail

Arbeiten Sie diese Optionen der Reihe nach durch. Die erste ist in der großen Mehrheit der Fälle die Antwort; der Rest deckt die Situationen ab, in denen ein Initialisierer nicht das ist, was Sie wollen.

### 1. Weisen Sie die required-Member im Objektinitialisierer zu

Die vorgesehene Lösung ist, jedes required-Member an der Aufrufstelle zu setzen:

```csharp
// .NET 11, C# 14
var person = new Person
{
    Name = "Ada Lovelace",
    Email = "ada@example.com",
    // Age is optional, omit it freely
};
```

Dafür ist `required` da: Der Vertrag des Typs sagt, dass diese Felder zwingend sind, und der Initialisierer hält sich daran. Wenn Sie feststellen, dass Sie dieselben Werte wiederholen, ist das ein Signal, dass der Typ einen Konstruktor will, was die nächste Lösung ist.

### 2. Fügen Sie einen mit [SetsRequiredMembers] annotierten Konstruktor hinzu

Wenn ein Konstruktor die Werte bereits entgegennimmt und zuweist, dekorieren Sie ihn mit `System.Diagnostics.CodeAnalysis.SetsRequiredMembers`. Dieses Attribut versichert dem Compiler, dass der Konstruktor jedes required-Member initialisiert, sodass Aufrufer keinen Objektinitialisierer mehr brauchen:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public class Person
{
    public required string Name { get; init; }
    public required string Email { get; init; }
    public int Age { get; init; }

    [SetsRequiredMembers]
    public Person(string name, string email)
    {
        Name = name;
        Email = email;
    }
}

// now this compiles, no initializer needed
var person = new Person("Ada", "ada@example.com");
```

Eine heikle Kante: `[SetsRequiredMembers]` ist eine Zusicherung, keine verifizierte Garantie. Der Compiler nimmt Sie beim Wort und prüft nicht, dass der Konstruktor tatsächlich jedes required-Member zuweist. Fügen Sie das Attribut hinzu, vergessen aber, `Email` im Rumpf zu setzen, erhalten Sie kein `CS9035` und keine Warnung, nur ein `null` dort, wo Sie einen Wert versprochen haben. Halten Sie das Attribut ehrlich.

Wenn Sie einen parameterlosen Konstruktor neben dem annotierten behalten, brauchen Aufrufer der parameterlosen Version weiterhin den Initialisierer. Das Attribut befreit nur den spezifischen Konstruktor, an dem es sitzt.

### 3. Entfernen Sie `required`, wenn das Member nicht wirklich zwingend ist

Wenn das Member einen sinnvollen Standardwert hat oder wirklich optional ist, sollte es gar nicht erst `required` sein. Das Entfernen des Modifizierers entfernt die Verpflichtung:

```csharp
// .NET 11, C# 14
public class Person
{
    public required string Name { get; init; }
    public string Email { get; init; } = "";   // was required, now optional with a default
}
```

Dies ist überraschend oft die richtige Entscheidung. Greifen Sie nur dann zu `required`, wenn es keinen vernünftigen Standardwert gibt und eine Konstruktion ohne den Wert das Objekt in einem ungültigen Zustand ließe. Einer Eigenschaft einen Standardwert zu geben und `required` zu entfernen, ist sauberer, als jede Aufrufstelle zu zwingen, einen leeren String zu übergeben.

### 4. Verwenden Sie für Records einen positionellen oder [SetsRequiredMembers]-Konstruktor

Ein positioneller Record erzeugt eine `init`-Eigenschaft pro Parameter, aber diese sind standardmäßig nicht `required`. Wenn Sie einem Record mit einem primären Konstruktor explizit eine `required`-Eigenschaft hinzufügen, erfüllt der primäre Konstruktor sie nicht automatisch, und Sie erhalten `CS9035`, wenn Sie die positionelle Form verwenden. Das bringt Leute durcheinander, weil es aussieht, als sollte der Konstruktor zählen. Die Designdiskussion in [dotnet/csharplang #6780](https://github.com/dotnet/csharplang/discussions/6780) erläutert die Begründung. Die Lösung ist, die Eigenschaft in einem Initialisierer zusätzlich zum positionellen Aufruf zu setzen, oder `[SetsRequiredMembers]` zu einem Konstruktor hinzuzufügen, der sie zuweist:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public record Product(string Sku)
{
    public required string Name { get; init; }

    [SetsRequiredMembers]
    public Product(string sku, string name) : this(sku) => Name = name;
}

// both work now
var withInit = new Product("A-100") { Name = "Widget" };
var withCtor = new Product("A-100", "Widget");
```

Wenn Sie wollen, dass die gesamte Konstruktion des Records über die positionellen Parameter erzwungen wird, bevorzugen Sie einfache `init`-Eigenschaften gegenüber `required`-Eigenschaften. Positionelle Records und `required`-Member zu mischen ist eine Quelle der Verwirrung; entscheiden Sie, welches Modell der Typ verwendet. Eine breitere Betrachtung, wann sich ein Record lohnt, finden Sie in [record vs class vs struct in C#](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).

## Fallstricke und Varianten

Eine Handvoll Situationen erzeugt `CS9035` oder etwas, das ihm ähnelt, aus Gründen, die aus der Meldung nicht offensichtlich sind:

- **`[SetsRequiredMembers]` ist Vertrauen, kein Beweis.** Wie oben behandelt, verifiziert der Compiler den Konstruktor nicht. Ein Konstruktor mit dem Attribut, der ein required-Member überspringt, kompiliert sauber und gibt Ihnen ein `null`. Behandeln Sie das Attribut als einen Vertrag, für dessen Einhaltung Sie verantwortlich sind.

- **System.Text.Json respektiert `required`.** Seit .NET 8 erzwingt der JSON-Deserialisierer die required-Member: Lässt das eingehende JSON eine required-Eigenschaft aus, wirft die Deserialisierung zur Laufzeit eine `JsonException`, statt ein halb aufgebautes Objekt zu erzeugen. Dies ist ein Laufzeitfehler, kein `CS9035`, aber es ist derselbe Vertrag, der auf dem Deserialisierungspfad auftaucht. Sehen Sie einen Deserialisierungsfehler, der ein required-Member erwähnt, fehlt dem JSON ein Feld, das der Typ verlangt. Für die allgemeine Form dieses Fehlers siehe [der JSON-Wert konnte nicht konvertiert werden](/de/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/), und wenn Sie eigene Konstruktionslogik brauchen, [wie man einen benutzerdefinierten JsonConverter in System.Text.Json schreibt](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Ein Converter, der das Objekt selbst konstruiert, umgeht die required-Member-Prüfung, sodass er auch ein Ausweg ist, wenn ein Typ, den Sie nicht kontrollieren, sich gegen Sie sträubt.

- **Reflection und `Activator.CreateInstance` umgehen die Prüfung vollständig.** `required` wird vom C#-Compiler erzwungen, nicht von der Laufzeit. `Activator.CreateInstance(typeof(Person))` kompiliert und läuft und lässt required-Referenzmember als `null`. Konstruiert ein Framework Ihre Objekte per Reflection, ohne `[SetsRequiredMembers]` zu berücksichtigen, können Sie mit einem "unmöglichen" Objekt enden, das der Compiler Sie von Hand nie hätte schreiben lassen. ORMs und Serialisierer, die Objekte materialisieren, sind die üblichen Verdächtigen; prüfen Sie, ob sie required-Member unterstützen, bevor Sie sich für diese Typen auf den Modifizierer verlassen. Das ist besonders für Entitäten wichtig, siehe [wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/).

- **Vererbung trägt die Verpflichtung nach unten.** Hat eine Basisklasse ein `required`-Member, muss jeder abgeleitete Typ es ebenfalls bei der Konstruktion erfüllen, und ein abgeleiteter Konstruktor, der es nicht setzt, braucht `[SetsRequiredMembers]` oder überlässt die Anforderung dem Initialisierer des Aufrufers. `required` zu einem Basis-Member hinzuzufügen ist eine quellcodebrechende Änderung für alle Konstruktoren in der Hierarchie, die sich darauf verließen, dass das Member optional war.

- **`init` gegenüber `set` ist `required` egal.** `required` ist orthogonal zur Zugänglichkeit des Setters. Sie können ein `required`-Member mit `init` (nur während der Konstruktion setzbar) oder einem normalen `set` markieren. Der Modifizierer steuert, ob das Member zugewiesen werden muss; der Accessor steuert, wann es zugewiesen werden kann. Ein gängiges Muster ist `public required string Name { get; init; }`: zwingend zu setzen, und nur bei der Konstruktion.

- **Das Member muss mindestens so zugänglich sein wie der Typ.** Ein `required`-Member muss von jedem Code setzbar sein, der den Typ konstruieren kann. Ein `public`-Typ mit einem `required`-Member, das einen `internal`-init-Accessor hat, erzeugt eine andere Diagnose (`CS9032`/`CS9033`), weil externe Aufrufer den Typ konstruieren, aber seine Anforderung nicht erfüllen könnten. Verengen Sie den Accessor eines required-Members, verengen Sie auch den Konstruktor oder den Typ.

Das mentale Modell, das Sie behalten sollten: `required` verschiebt eine "Sie müssen dies bereitstellen"-Regel von einer Laufzeithoffnung zu einer Kompilierzeitgarantie, und `CS9035` ist diese Garantie bei der Arbeit. Wenn Sie es sehen, ist die Lösung immer eine von "stellen Sie den Wert an der Aufrufstelle bereit" oder "teilen Sie dem Compiler mit, dass ein Konstruktor ihn bereits bereitstellt". Entscheiden Sie, welche für den Typ zutrifft, füllen Sie dann den Initialisierer aus oder fügen Sie `[SetsRequiredMembers]` hinzu, und greifen Sie nie zu dem Attribut als Weg, den Fehler zum Schweigen zu bringen, ohne das Member tatsächlich zu setzen.

## Verwandt

- [record vs class vs struct in C#: eine Entscheidungsmatrix](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) für die Wahl der richtigen Typform, bevor Sie `required` darüber streuen.
- [Wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/) dafür, wie required-Member mit Entitäten interagieren, die das ORM per Reflection materialisiert.
- [Wie man einen benutzerdefinierten JsonConverter in System.Text.Json schreibt](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), um die Konstruktion zu übernehmen, wenn der Standard-Serialisierer mit Ihren required-Membern kämpft.
- [Lösung: Der JSON-Wert konnte nicht konvertiert werden](/de/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) für die Laufzeitseite desselben Vertrags während der Deserialisierung.
- [Wie man Erweiterungseigenschaften in C# 14 deklariert](/de/2026/06/how-to-declare-extension-properties-in-csharp-14/) für mehr davon, was das Eigenschaftsmodell von C# 14 ausdrücken kann und was nicht.

## Quellen

- Microsoft Learn, [required-Modifizierer (C#-Referenz)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) (Semantik von `required`, das Attribut `SetsRequiredMembers` und die Regel, dass der Compiler den Konstruktorrumpf nicht verifiziert).
- Microsoft Learn, [Objekt- und Auflistungsinitialisierer](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/object-and-collection-initializers) (wie required-Member über einen Initialisierer oder Attributkonstruktor gesetzt werden müssen).
- GitHub, [dotnet/csharplang Discussion #6780](https://github.com/dotnet/csharplang/discussions/6780) (warum `CS9035` für Records ausgelöst wird, die einen primären Konstruktor mit expliziten `required`-Eigenschaften kombinieren).

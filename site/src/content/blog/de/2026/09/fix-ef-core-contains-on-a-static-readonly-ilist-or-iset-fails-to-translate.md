---
title: "Fix: EF Core `Contains` auf einem `static readonly` `IList<T>` oder `ISet<T>` konnte nicht übersetzt werden"
description: "EF Core 8, 9 und 10 übersetzen Contains nicht, wenn die Liste ein static readonly Feld vom Typ IList, ICollection, ISet oder IReadOnlySet ist. Rufen Sie Enumerable.Contains explizit auf oder wechseln Sie auf EF Core 11."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "de"
translationOf: "2026/09/fix-ef-core-contains-on-a-static-readonly-ilist-or-iset-fails-to-translate"
translatedBy: "claude"
translationDate: 2026-09-29
---

Wenn `Where(x => AllowedCodes.Contains(x.Code))` mit `The LINQ expression ... could not be translated` und `Translation of method 'System.Linq.Enumerable.Contains' failed` fehlschlägt, sehen Sie sich an, wie `AllowedCodes` deklariert ist. Sehr wahrscheinlich ist es ein `static readonly` Feld vom Typ `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>`, `IImmutableSet<T>` oder `FrozenSet<T>`. Der schnellste Fix, der das SQL unverändert lässt, ist der explizite Aufruf des LINQ-Operators: `Enumerable.Contains(AllowedCodes, x.Code)`. Die eigentliche Lösung ist EF Core 11, wo dotnet/efcore#36757 die Query-Root-Prüfung korrigiert hat, die diese Formen ablehnt. Ich habe jede unten genannte Variante mit `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21, 9.0.19, 10.0.12 und 11.0.0-rc.1.26425.128 gemessen. Die ersten drei scheitern auf dieselbe Weise. EF Core 11 RC 1 übersetzt alle.

## Der Fehler im Kontext

Hier ist die Ausnahme von EF Core 10.0.12 unter .NET 10 für ein `static readonly IList<string>`:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => (IList<string>)List<string> { "Open", "Pending" }
        .Contains(o.Status))' could not be translated. Additional information: Translation of method 'System.Linq.Enumerable.Contains' failed. If this method can be mapped to your custom function, see https://go.microsoft.com/fwlink/?linkid=2132413 for more information. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
   at Microsoft.EntityFrameworkCore.Query.QueryableMethodTranslatingExpressionVisitor.Translate(Expression expression)
   at Microsoft.EntityFrameworkCore.Query.QueryCompilationContext.CreateQueryExecutorExpression[TResult](Expression query)
```

Diese Meldung enthält zwei Hinweise. Der erste ist der Cast. Die Sammlung erscheint als `(IList<string>)List<string> { "Open", "Pending" }`. Das bedeutet, dass EF Ihr Feld bereits zu seinem Wert, einer Konstante, ausgewertet und in einen Cast zurück auf den deklarierten Typ gepackt hat. Der zweite ist der Methodenname. Sie haben `IList<T>.Contains` geschrieben, eine Instanzmethode, doch die Meldung nennt `Enumerable.Contains`. EF schreibt `ICollection<T>.Contains`-Aufrufe vor der Übersetzung in den LINQ-Operator um. Die Methode ist also nicht das Problem. Das Problem ist das Argument, das EF ihr übergibt.

Ist das Feld als `IReadOnlySet<T>` oder `IImmutableSet<T>` typisiert, ändert sich der Methodenname in der Meldung zu `System.Collections.Generic.IReadOnlySet<string>.Contains` bzw. `System.Collections.Immutable.IImmutableSet<string>.Contains`. Diese Interfaces erben nicht von `ICollection<T>`, daher schreibt EF den Aufruf nie um. Es ist derselbe Fehler mit anderer Meldung.

## Warum ein static readonly Feld scheitert und eine lokale Variable nicht

Das hat zwei Schritte, und der Fehler tritt nur auf, wenn beide zusammenkommen.

**Schritt 1: EF inlinet `static readonly` Felder als Konstanten.** Vor der Übersetzung durchläuft der Funcletizer von EF die Abfrage und wertet alles aus, was nicht von der Datenbank abhängt. Erfasste lokale Variablen, Instanzfelder und statische Eigenschaften werden zu Abfrageparametern. Ein statisches Feld, das `readonly` ist (`FieldInfo.IsInitOnly`), gilt als unveränderlicher Wert, daher wertet EF es einmal aus und inlinet es als Konstante. In EF Core 10 sehen Sie das in [`ExpressionTreeFuncletizer.VisitMember`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs): Das statische Member wird als erfasste Variable markiert, "unless the captured variable is init-only". Beim Erzeugen dieser Konstante typisiert EF sie mit dem Laufzeittyp des Werts (`List<string>`) und fügt dann einen `Convert`-Knoten zurück auf den deklarierten Typ (`IList<string>`) hinzu, sobald sich beide unterscheiden.

**Schritt 2: Die Query-Root-Prüfung entfernt nur eine Art von Cast.** Um `Contains` über eine In-Memory-Sammlung zu übersetzen, macht EF aus der Sammlung eine Inline-Query-Root und daraus `IN (...)`. In EF Core 8, 9 und 10 entpackt [`QueryRootProcessor.VisitQueryRootCandidate`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) ein `Convert` nur dann, wenn der Zieltyp exakt `IEnumerable<T>` ist:

```csharp
// EF Core 10.0.x, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.GetGenericTypeDefinition() == typeof(IEnumerable<>))
{
    candidateExpression = convertExpression.Operand;
}
```

Ein `Convert` auf `IList<string>` passt nicht. Die Sammlung wird also nie als Query-Root erkannt, und `Contains` fällt auf "could not be translated" durch.

Vor diesem Hintergrund ergibt das Muster aus Erfolg und Fehlschlag Sinn:

- Felder vom Typ `List<T>`, `HashSet<T>` und `T[]` funktionieren, weil der deklarierte Typ dem Laufzeittyp entspricht. EF fügt kein `Convert` hinzu.
- Felder vom Typ `IEnumerable<T>`, `IReadOnlyList<T>` und `IReadOnlyCollection<T>` funktionieren, weil keiner dieser Typen ein eigenes `Contains` deklariert. Der Aufruf bindet an `Enumerable.Contains`, der Compiler konvertiert das Argument zu `IEnumerable<T>`, und die von EF erzeugte Konstante wird auf `IEnumerable<T>` gecastet, die eine Form, die die alte Prüfung akzeptiert.
- `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>` und `IImmutableSet<T>` scheitern, weil sie `Contains` deklarieren. C# bevorzugt die Instanzmethode gegenüber der Erweiterungsmethode, daher bleibt der Cast beim Interface-Typ.
- `FrozenSet<T>` scheitert, obwohl es eine konkrete Klasse ist, weil es abstrakt ist. Der Laufzeitwert ist eine interne Unterklasse, was wiederum ein `Convert` erzeugt. Das war der in dotnet/efcore#36496 gemeldete Fall, und der PR, der ihn behoben hat, hat auch die Interfaces behoben.
- Eine erfasste lokale Variable, ein nicht-readonly statisches Feld und eine statische Eigenschaft funktionieren alle, weil sie zu Parametern statt zu Konstanten werden, und der Parameterpfad hatte diesen Fehler nie.

Das ist keine Regression. Die ursprüngliche Meldung der `IReadOnlySet<T>`-Variante reicht bis EF Core 7 zurück, und dotnet/efcore#38839 reproduziert sie auf 7.0.20 bis 10.0.11.

## Minimale Reproduktion

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
db.Database.EnsureDeleted();
db.Database.EnsureCreated();
db.Orders.AddRange(
    new Order { Status = "Open" },
    new Order { Status = "Pending" },
    new Order { Status = "Shipped" });
db.SaveChanges();

// Throws InvalidOperationException on EF Core 8, 9 and 10
var active = db.Orders
    .Where(o => OrderRules.ActiveStatuses.Contains(o.Status))
    .ToList();

Console.WriteLine(active.Count);

public static class OrderRules
{
    public static readonly IList<string> ActiveStatuses = new List<string> { "Open", "Pending" };
}

public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=shop.db");
}
```

Ändern Sie `IList<string>` in `List<string>`, entfernen Sie `readonly` oder machen Sie das Feld zu einer `{ get; }`-Eigenschaft, und dieselbe Abfrage läuft. So entdecken die meisten den Fehler: Ein Code-Review schlägt vor, "das Interface statt des konkreten Typs zu exponieren" oder "das Feld readonly zu machen", und eine Abfrage, die monatelang funktioniert hat, bricht.

## Was jede Deklaration in EF Core 8, 9, 10 und 11 bewirkt

Ich habe pro Form eine Probe gegen SQLite auf jeder EF-Version ausgeführt. Die Pakete von EF Core 8 und 9 liefen auf der .NET-10-Laufzeit. EF Core 11 RC 1 lief auf .NET 11 RC 1. "constant" bedeutet, dass EF die Werte ins SQL inlined hat. "parameter" bedeutet, dass sie als Parameter gesendet wurden.

| Deklaration | EF 8.0.21 | EF 9.0.19 | EF 10.0.12 | EF 11 RC 1 |
|---|---|---|---|---|
| `static readonly IList<T>` | fails | fails | fails | constant |
| `static readonly ICollection<T>` | fails | fails | fails | constant |
| `static readonly ISet<T>` | fails | fails | fails | constant |
| `static readonly IReadOnlySet<T>` | fails | fails | fails | constant |
| `static readonly IImmutableSet<T>` | fails | fails | fails | constant |
| `static readonly FrozenSet<T>` | fails | fails | fails | constant |
| `static readonly IReadOnlyList<T>`, `IReadOnlyCollection<T>`, `IEnumerable<T>` | constant | constant | constant | constant |
| `static readonly List<T>`, `HashSet<T>`, `T[]` | constant | constant | constant | constant |
| `static IList<T>` (nicht readonly) oder statische Eigenschaft | parameter | parameter | parameter | parameter |
| erfasste lokale Variable `IList<T>` | parameter | parameter | parameter | parameter |
| `EF.Constant(localIList).Contains(...)` | fails | constant | constant | constant |

Die letzte Zeile ist ein Sonderfall, den man kennen sollte. In EF Core 8 löst das Erzwingen einer lokalen `IList<T>` zur Konstante per `EF.Constant` denselben Fehler aus. Ab EF Core 9 läuft `EF.Constant` über einen anderen Pfad und funktioniert.

## Die Lösungen, nach Präferenz geordnet

### 1. Auf EF Core 11 wechseln

Die Lösung ist [dotnet/efcore#36757](https://github.com/dotnet/efcore/pull/36757), am 2025-09-24 in `main` gemergt und in EF Core 11 ausgeliefert. Sie ändert die Prüfung so, dass jedes `Convert` entpackt wird, dessen Ziel an `IEnumerable` zuweisbar ist, und zwar rekursiv:

```csharp
// EF Core 11.0, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.IsAssignableTo(typeof(IEnumerable)))
{
    return VisitQueryRootCandidate(convertExpression.Operand, elementClrType);
}
```

Sie wurde nicht zurückportiert. Der Branch `release/10.0` enthält weiterhin den Vergleich mit `typeof(IEnumerable<>)`, und 10.0.12 scheitert weiterhin. dotnet/efcore#35024 (die Meldung zu `IList`/`ICollection`) hat den Meilenstein 11.0.0, und #38839 wurde als Duplikat davon geschlossen. Wenn Sie auf EF Core 10 LTS sind, planen Sie eine der folgenden Umschreibungen ein, bis Sie auf 11 wechseln.

### 2. `Enumerable.Contains` explizit aufrufen

Das ist die Einzeiler-Lösung, die ich für EF Core 8, 9 und 10 empfehle, weil sie exakt das SQL liefert, das Sie auch mit EF Core 11 bekämen:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var active = db.Orders
    .Where(o => Enumerable.Contains(OrderRules.ActiveStatuses, o.Status))
    .ToList();

// WHERE "o"."Status" IN ('Open', 'Pending')
```

Der direkte Aufruf der statischen Methode veranlasst den Compiler, das Feld zu `IEnumerable<string>` zu konvertieren. Die Konstante von EF kommt dadurch als Cast auf `IEnumerable<T>` an und besteht die alte Prüfung. In meinen Läufen funktionierte das bei allen sechs scheiternden Formen, einschließlich `IReadOnlySet<T>` und `IImmutableSet<T>`. `OrderRules.ActiveStatuses.AsEnumerable().Contains(o.Status)` bewirkt dasselbe, falls Sie die Methodensyntax bevorzugen. `OrderRules.ActiveStatuses.Any(s => s == o.Status)` wird ebenfalls zur selben `IN`-Liste übersetzt, liest sich aber schlechter, und ich würde es nicht nur zur Umgehung dieses Problems verwenden.

Ein Kompromiss: Bei einem `ISet<T>` oder `FrozenSet<T>` würde `Enumerable.Contains` in reinem LINQ-to-Objects den Hash-Lookup überspringen. In einer EF-Abfrage spielt das keine Rolle, weil der Aufruf nie in .NET ausgeführt wird. Er beschreibt nur das SQL.

### 3. Den deklarierten Typ ändern

Wenn die Sammlung nur in Abfragen verwendet wird, deklarieren Sie sie als `IReadOnlyCollection<T>`, `IReadOnlyList<T>` oder als Array. Alle drei sind schreibgeschützt, und alle drei werden in jeder Version übersetzt:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore 10.0.12
public static class OrderRules
{
    public static readonly IReadOnlyList<string> ActiveStatuses = ["Open", "Pending"];
}
```

Wechseln Sie nicht zu `FrozenSet<T>`, um "echte" Unveränderlichkeit zu erhalten. In EF Core 8 bis 10 scheitert es aus dem oben beschriebenen Grund.

### 4. EF die Werte parametrisieren lassen

Wenn Sie das Feld in eine lokale Variable kopieren oder zu einer `static` Eigenschaft machen, sendet EF die Werte als Parameter statt als Konstanten:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var statuses = OrderRules.ActiveStatuses;
var active = db.Orders.Where(o => statuses.Contains(o.Status)).ToList();

// EF Core 10: WHERE "o"."Status" IN (@statuses1, @statuses2)
// EF Core 8/9 on SQLite: WHERE "o"."Status" IN (SELECT "s"."value" FROM json_each(@__statuses_0) AS "s")
```

Das funktioniert, ändert aber das SQL. Bedenken Sie, warum der Konstantenpfad existiert: Die Werte ändern sich nie, daher erhält die Datenbank durch das Inlining eine feste Literalliste, was die beste Form für Indexnutzung und Plan-Caching ist. Bei einer kurzen Liste von Statuscodes ist die Konstante das bessere SQL. Verwenden Sie diese Option, wenn sich die Liste zur Laufzeit tatsächlich ändern kann, und nicht nur, um den Übersetzungsfehler zu umgehen. Wenn Sie sehen möchten, was EF in beiden Fällen erzeugt, [protokollieren Sie das von EF Core erzeugte SQL](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) vor und nach der Änderung.

## Varianten, die versehentlich auf dieser Seite landen

- **`Translation of method 'System.MemoryExtensions.Contains' failed`** bei einem Array nach dem Wechsel auf C# 14. Das ist die Änderung der Überladungsauflösung für First-Class-Spans, nicht dieser Fehler. Siehe [den Fix für die C# 14 Überladungsauflösung mit Spans](/de/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).
- **Ein generisches "could not be translated" bei einer selbst geschriebenen Methode**, etwa `ids.HasItem(x.Id)`. EF kann nicht in Ihre Methode hineinsehen, egal welchen Sammlungstyp Sie verwenden. Die allgemeinen Ursachen und Umschreibungen stehen in [The LINQ expression could not be translated in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), und wie Sie Prädikatlogik sicher wiederverwenden, steht in [wiederverwendbare LINQ-Prädikate, die EF Core übersetzen kann](/de/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**. Das passiert, wenn der Funcletizer den Getter Ihres Felds oder Ihrer Eigenschaft ausführt und der Getter eine Ausnahme wirft. Es scheitert in derselben Phase, aber aus anderem Grund. Siehe [den Fix zur Auswertung des Parameterausdrucks](/de/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).
- **Dasselbe `static readonly IList<T>` in einer kompilierten Abfrage** (`EF.CompileQuery`). Kompilierte Abfragen durchlaufen dieselben Funcletizer- und Query-Root-Schritte. Ich habe bestätigt, dass sie in EF Core 10.0.12 auf dieselbe Weise scheitern und dass `Enumerable.Contains` sie ebenfalls repariert. Siehe [wie Sie kompilierte Abfragen für Hot Paths verwenden](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Verwandte Themen

- [Fix: The LINQ expression could not be translated in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Wiederverwendbare LINQ-Prädikate schreiben, die EF Core übersetzen kann](/de/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)
- [Das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Fix für die C# 14 Breaking Change bei der Überladungsauflösung mit Spans](/de/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)
- [Kompilierte Abfragen mit EF Core für Hot Paths verwenden](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Quellen

- [dotnet/efcore#35024: Query could not be translated when using a static ICollection/IList field](https://github.com/dotnet/efcore/issues/35024), Meilenstein 11.0.0.
- [dotnet/efcore#38839: Contains on a constant collection fails when declared as ICollection/IList/ISet/IReadOnlySet/IImmutableSet](https://github.com/dotnet/efcore/issues/38839), als Duplikat geschlossen, mit einer Versionsmatrix von 7.0.20 bis 10.0.11.
- [dotnet/efcore#36757: Fix handling of readonly fields using abstract classes (i.e. FrozenSet) in parameters for primitive collections](https://github.com/dotnet/efcore/pull/36757), die Lösung, gemergt am 2025-09-24.
- [`QueryRootProcessor.cs` auf `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) und [`ExpressionTreeFuncletizer.cs` auf `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs).
- [What's new in EF Core 10: improved translation for parameterized collections](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection).

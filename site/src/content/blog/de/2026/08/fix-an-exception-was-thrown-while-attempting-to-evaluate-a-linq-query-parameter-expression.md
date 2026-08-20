---
title: "Lösung: \"An exception was thrown while attempting to evaluate a LINQ query parameter expression\" in EF Core 11"
description: "EF Core wirft dies, wenn ein clientseitig ausgewerteter Teil Ihrer Abfrage bei der Auswertung fehlschlägt. Lesen Sie InnerException, aktivieren Sie EnableSensitiveDataLogging und ziehen Sie die Null-Prüfung aus dem Lambda heraus."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "linq"
lang: "de"
translationOf: "2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression"
translatedBy: "claude"
translationDate: 2026-08-19
---

Das ist kein Übersetzungsfehler. EF Core 11 wirft `An exception was thrown while attempting to evaluate a LINQ query parameter expression`, wenn es bereits entschieden hat, dass ein Teilbaum Ihrer Abfrage clientseitig auswertbar ist (ein "Abfrageparameter"), und **Ihr eigener Code beim Auswerten durch EF fehlgeschlagen ist**. In neun von zehn Fällen ist der eigentliche Fehler eine `NullReferenceException` auf einem erfassten Objekt, und er steht in `InnerException`. Rufen Sie `EnableSensitiveDataLogging()` auf Ihrem `DbContextOptionsBuilder` auf, damit EF genau den Ausdruck ausgibt, an dem es gescheitert ist, und verschieben Sie dann die Null-Prüfung aus dem Lambda in die Zusammensetzung der Abfrage. Alles Folgende wurde gegen `Microsoft.EntityFrameworkCore` 10.0.11 auf .NET 10 verifiziert; die Wurfstelle ist in den EF Core 11 Previews Zeichen für Zeichen identisch, das Verhalten überträgt sich also unverändert.

## Der Fehler im Kontext

Es gibt zwei Varianten dieser Meldung, und welche Sie bekommen, hängt allein davon ab, ob die Protokollierung sensibler Daten aktiv ist. Ohne sie:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate a LINQ query parameter expression. See the inner exception for more information. To show additional information call 'DbContextOptionsBuilder.EnableSensitiveDataLogging'.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
   at System.Linq.Expressions.Interpreter.Instruction.NullCheck(Object o)
   at System.Linq.Expressions.Interpreter.FuncCallInstruction`2.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.Interpreter.Run(InterpretedFrame frame)
   at System.Linq.Expressions.Interpreter.LightLambda.Run(Object[] arguments)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.<Evaluate>g__EvaluateCore|74_0(...)
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.Evaluate(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.ProcessEvaluatableRoot(...)
   at Microsoft.EntityFrameworkCore.Query.Internal.ExpressionTreeFuncletizer.VisitBinary(BinaryExpression binary)
```

Mit aktiviertem `EnableSensitiveDataLogging()` wechselt die Meldung zur deutlich nützlicheren Variante, die den Ausdruck benennt:

```
System.InvalidOperationException: An exception was thrown while attempting to evaluate the LINQ query parameter expression 'value(Program+<>c__DisplayClass0_0).filter.MinRating'. See the inner exception for more information.
 ---> System.NullReferenceException: Object reference not set to an instance of an object.
```

Achten Sie auf den Artikel: die nicht sensible Meldung sagt "a LINQ query parameter expression", die sensible sagt "the LINQ query parameter expression '...'". Wenn Sie nach der einen gesucht haben und mit der anderen hier gelandet sind, sind Sie trotzdem richtig. Beide stammen aus demselben Paar von Ressourcen-Strings, `ExpressionParameterizationException` und `ExpressionParameterizationExceptionSensitive`.

Das `<>c__DisplayClass0_0` in diesem Ausdruck ist die vom Compiler erzeugte Closure-Klasse, die Ihre erfassten lokalen Variablen hält. `filter` ist die erfasste Variable, `MinRating` der Zugriff, der geknallt hat. Dieser eine String reicht meist aus, um die Zeile zu finden.

## Warum das passiert

Bevor EF SQL erzeugen kann, läuft es Ihren Ausdrucksbaum ab und teilt ihn in zwei Arten von Knoten: solche, die von der Abfragewurzel abhängen (`b.Rating`, das zu einer Spalte wird), und solche, die es nicht tun (`filter.MinRating`, das zu einem SQL-Parameter wird). Die zweite Kategorie nennt EF Funcletization, und zuständig dafür ist der `ExpressionTreeFuncletizer`. Für jeden auswertbaren Teilbaum kompiliert EF einen `Func<object>` und ruft ihn auf:

```csharp
// Microsoft.EntityFrameworkCore 11, ExpressionTreeFuncletizer.EvaluateCore
try
{
    return Lambda<Func<object>>(Convert(expression, typeof(object)))
        .Compile(preferInterpretation: true)
        .Invoke();
}
catch (Exception exception)
{
    throw new InvalidOperationException(
        _logger.ShouldLogSensitiveData()
            ? CoreStrings.ExpressionParameterizationExceptionSensitive(expression)
            : CoreStrings.ExpressionParameterizationException,
        exception);
}
```

Das ist der ganze Mechanismus. Jede Ausnahme, die Ihr Code innerhalb eines erfassten Ausdrucks wirft, wird in diese `InvalidOperationException` verpackt und erneut geworfen. EF beschwert sich nicht über Ihre Abfrage, es meldet, dass die Ausführung eines Teils davon fehlgeschlagen ist.

Für die Fehlersuche ist das entscheidend. Die Meldung ist absichtlich generisch, weil der Ausdruckstext Benutzerdaten enthalten kann, und deshalb liegt die detaillierte Variante hinter der Protokollierung sensibler Daten. Der konkrete Fehler steht immer in `InnerException`, und der Stack Trace der inneren Ausnahme zeigt auf `System.Linq.Expressions.Interpreter` statt auf Ihren Code, weil EF mit `preferInterpretation: true` kompiliert. Suchen Sie dort nicht nach Ihren eigenen Frames. Lesen Sie stattdessen Typ und Meldung der inneren Ausnahme.

Vergleichen Sie das mit dem Geschwisterfehler `The LINQ expression could not be translated`, der ausgelöst wird, wenn EF ein Konstrukt überhaupt nicht in SQL übersetzen kann. Andere Stufe der Pipeline, andere Lösung.

## Minimale Reproduktion

Ein `DbSet<Blog>`, ein nullbares Filter-DTO und ein `Where`, das es dereferenziert:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
}

public class Filter { public int MinRating { get; set; } }

public class AppDb(DbContextOptions<AppDb> o) : DbContext(o)
{
    public DbSet<Blog> Blogs => Set<Blog>();
}
```

```csharp
// .NET 10, C# 14, EF Core 10.0.11
Filter? filter = null;                                      // came back null from the request binder
var q = db.Blogs.Where(b => b.Rating >= filter!.MinRating); // no exception yet
var rows = q.ToList();                                      // throws here
```

Zwei Details, die man verinnerlichen sollte:

- **Das Zusammensetzen der Abfrage wirft nichts.** Den `IQueryable` aufzubauen ist kostenlos. Die Funcletization läuft, wenn die Abfrage kompiliert wird, und das geschieht am terminalen Operator. Ich habe das bestätigt, indem ich die Abfrage aufgebaut und nie enumeriert habe: keine Ausnahme.
- **Jeder terminale Operator wirft, auch `ToQueryString()`.** `ToList()`, `ToListAsync()`, `Any()`, `Count()` und `ToQueryString()` laufen alle über denselben Kompilierungspfad. Letzteres ist praktisch, denn damit lässt sich das ganz ohne Datenbankverbindung reproduzieren.

Dies sind die inneren Ausnahmen, die ich für die häufigsten Auslöser gemessen habe, alle gegen EF Core 10.0.11 mit dem SQLite-Provider:

| Was Sie geschrieben haben | `InnerException` |
| --- | --- |
| `b.Rating >= filter!.MinRating` mit `filter` gleich null | `NullReferenceException` |
| `b.Rating >= config.MinRating`, wobei der Getter wirft | Ihre eigene Ausnahme, wörtlich |
| `b.Rating == maybe!.Value` mit `int? maybe = null` | `InvalidOperationException: Nullable object must have a value.` |
| `b.Rating == empty.First()` auf einer leeren `List<int>` | `InvalidOperationException: Sequence contains no elements` |
| `b.Rating == int.Parse(raw)` mit `raw = "not-a-number"` | `FormatException` |
| `b.Rating == map["nope"]` auf einem `Dictionary<string, int>` | `KeyNotFoundException` |
| `b.Rating >= Bad.Value`, wobei der statische Initialisierer wirft | `TargetInvocationException`, die die echte umschließt |
| `b.Name == s!.Trim()` mit `string? s = null` | `NullReferenceException` |

Die vorletzte Zeile erwischt Leute gleich zweimal: ein fehlschlagender statischer Feldinitialisierer liefert drei Verschachtelungsebenen. Die Hülle, dann `TargetInvocationException`, dann die Ausnahme, die Sie wirklich interessiert. Lesen Sie `ex.InnerException.InnerException`, bevor Sie die Meldung für nutzlos erklären.

## Die Lösung im Detail

Die Lösung hat immer dieselbe Form: sorgen Sie dafür, dass der erfasste Ausdruck nicht werfen kann, wenn EF ihn auswertet. Dafür gibt es vier Wege, nach Empfehlung geordnet.

### 1. Bedingt außerhalb des Lambdas zusammensetzen

Das ist die richtige Lösung für den überwältigend häufigen Fall des "optionalen Filters", und sie erzeugt zusätzlich besseres SQL, weil das Prädikat vollständig verschwindet, wenn der Filter fehlt:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
IQueryable<Blog> q = db.Blogs;

if (filter is not null)
{
    q = q.Where(b => b.Rating >= filter.MinRating);
}

var rows = await q.ToListAsync();
```

Verifiziert mit `filter` gleich null: keine Ausnahme und keine tote `WHERE`-Klausel im erzeugten SQL.

### 2. Den Wert vor der Abfrage in eine lokale Variable ziehen

Ist der Wert wirklich optional, das Prädikat aber nicht, dann projizieren Sie ihn in eine lokale Variable mit definiertem Rückfallwert. EF erfasst dann einen `int`, der nicht werfen kann:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var min = filter?.MinRating ?? int.MinValue;
var rows = await db.Blogs.Where(b => b.Rating >= min).ToListAsync();
```

Das ist auch die Lösung für `int.Parse`, `Guid.Parse` und Dictionary-Zugriffe. Machen Sie das Parsen oder den Zugriff vor der Abfrage, wo Sie den Fehlschlag sauber behandeln können, statt in einem Lambda, wo er drei Schichten tief verpackt ankommt.

### 3. Innerhalb des Lambdas kurzschließen

Wenn alles in einem Ausdruck bleiben muss, funktioniert eine Absicherung mit `&&`, `||` oder einem ternären Operator. Der Funcletizer behandelt kurzschließende binäre Operatoren und `ConditionalExpression` gesondert und wertet den toten Zweig nicht eifrig aus:

```csharp
// .NET 10, C# 14, EF Core 10.0.11
var rows = await db.Blogs
    .Where(b => filter == null || b.Rating >= filter.MinRating)
    .ToListAsync();

// the ternary form behaves identically
var rows2 = await db.Blogs
    .Where(b => filter == null ? true : b.Rating >= filter.MinRating)
    .ToListAsync();
```

Alle drei Varianten (`filter != null && ...`, `filter == null || ...` und der ternäre Operator) liefen in meiner Reproduktion mit `filter` gleich null sauber durch. Trotzdem steht diese Lösung an dritter Stelle, aus zwei Gründen: sie schickt eine immer wahre `WHERE`-Klausel an die Datenbank, wenn der Filter fehlt, und sie stützt sich auf Funcletizer-Verhalten, das sich zwischen Hauptversionen bereits geändert hat. Issue [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883) hat genau diese Form, eine Bedingung, die eine clientseitige mit einer datenbankseitigen Bedingung mischt, und sie fiel im EF Core 9 Zyklus auf einen inneren `unbound variable` Fehler zurück, bis sie gepatcht wurde.

### 4. Reparieren Sie das, was wirft

Ist der Verursacher ein Property-Getter, der wirft, weil ein Dienst noch nicht initialisiert ist (der Klassiker ist ein Tenant-Resolver, der einen leeren Ambient-Scope liest), hilft nichts davon. Die Abfrage ist in Ordnung; Ihr Composition Root ist kaputt. Lassen Sie den Getter einen Wert liefern oder früher mit einer Meldung scheitern, die etwas Brauchbares sagt.

## Fallstricke und Varianten

**Abfragefilter werden nicht verpackt.** Wenn Ihr `HasQueryFilter` Lambda ein Feld auf dem `DbContext` liest und dieser Zugriff wirft, bekommen Sie Ihre rohe Ausnahme, nicht diese hier. Ich habe einen Kontext mit `HasQueryFilter(b => b.TenantId == _tenant.Current)` aufgesetzt, bei dem `_tenant.Current` wirft, und `db.Blogs.ToList()` lieferte `InvalidOperationException: no tenant in scope` direkt. Der Grund liegt im Funcletizer: Ausdrücke, die den Kontext berühren, gehen über den Kontext-Accessor-Pfad, der ein aufgeschobenes `Lambda` zurückgibt, statt es innerhalb dieses `try` Blocks aufzurufen. Wenn Sie also ein Multi-Tenant-Setup debuggen und die Parametrisierungs-Hülle tatsächlich sehen, sitzt die schuldige Erfassung in einem gewöhnlichen `Where`, nicht im Filter. Ein Aufruf von `IgnoreQueryFilters()` lässt die Abfrage durchlaufen und ist ein schneller Weg, um zu bestätigen, welcher der beiden Fälle vorliegt.

**Eine null-Collection in `Contains` wirft nicht. Sie liefert stillschweigend nichts.** Das ist die gefährlichste Variante auf dieser Seite, weil sie wie eine Lösung aussieht:

```csharp
// .NET 10, C# 14, EF Core 10.0.11, SQLite provider
List<string>? names = null;
var rows = db.Blogs.Where(b => names!.Contains(b.Name)).ToList();
// rows.Count == 0, no exception
// SELECT "b"."Id", "b"."Name", "b"."Rating" FROM "Blogs" AS "b" WHERE 0
```

EF übersetzt eine null-parametrisierte Collection in ein immer falsches Prädikat, genau wie eine leere. Sie bekommen keinen Fehler, Sie bekommen null Zeilen, und der Bug geht in Produktion. Wenn eine null-Liste in Ihrer Domäne "kein Filter" bedeutet, sagen Sie das explizit mit einer `names is null ||` Absicherung, oder setzen Sie bedingt zusammen wie in Lösung 1.

**`EF.Constant` rettet Sie nicht.** Die Erfassung als `EF.Constant(filter!.MinRating)` zu verpacken wirft weiterhin. Die Dereferenzierung passiert beim Auswerten des Arguments, bevor EF die Markermethode überhaupt sieht.

**Eine rohe `NullReferenceException` statt der Hülle bedeutet, dass der Wurf in Ihrem Code lag, nicht in dem von EF.** `db.Blogs.Take(filter!.MinRating)` wirft eine schlichte `NullReferenceException`, weil `Take` einen `int` entgegennimmt: der C#-Compiler wertet dieses Argument an der Aufrufstelle aus, und es wird nie Teil eines Ausdrucksbaums. Dasselbe gilt für `Skip` und für alles, was Sie vor der Übergabe in einen String interpolieren. Nur Lambdas bekommen die Hülle.

**Verketten hilft nicht.** Die Aufteilung in `db.Blogs.Where(b => b.Id == 0).Where(b => b.Rating >= filter!.MinRating)` wirft weiterhin. Die Funcletization läuft zur Kompilierzeit über den gesamten zusammengesetzten Baum, nicht pro Operator, ein früherer Filter kann eine spätere Erfassung also nicht kurzschließen.

**Es wirft bei jeder Ausführung, nicht nur beim ersten Mal.** Der Cache kompilierter Abfragen wird über die Abfrageform geschlüsselt, und die Funcletization läuft vor dem Cache-Zugriff, um die Parameterwerte zu extrahieren. Ein "es hat einmal funktioniert und fing dann an zu scheitern" gibt es hier nicht.

## Verwandte Beiträge

- Die andere EF Core Ausnahme zur Abfragezeit, mit der diese verwechselt wird, behandelt [warum EF Core sagt, der LINQ-Ausdruck konnte nicht übersetzt werden](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), wo es um Konstrukte geht, die EF gar nicht in SQL übersetzen kann.
- Wenn die innere Ausnahme `Sequence contains no elements` lautet, lohnt sich das Verhalten des zugrunde liegenden LINQ-Operators in [was bei First und Single tatsächlich wirft](/de/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- Die sensible Variante dieser Meldung zu aktivieren ist eine Zeile der größeren Einrichtung, die in [wie Sie das von EF Core erzeugte SQL sehen](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) beschrieben ist.
- Wenn Sie beim Aufbau von Multi-Tenancy darauf stoßen, zeigt [benannte Abfragefilter für Soft Delete und Multi-Tenancy](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/), wie die Tenant-Id ohne werfenden Getter auf den Kontext kommt.
- Die Parametrisierung steuert auch das Cache-Verhalten, was zählt, wenn Sie mit [kompilierten Abfragen auf heißen Pfaden](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) der Abfrageleistung nachgehen.

## Quellen

- [CoreStrings.ExpressionParameterizationException](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.corestrings.expressionparameterizationexception) auf MS Learn, für den exakten Ressourcen-String.
- [ExpressionTreeFuncletizer.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs) in dotnet/efcore, wo das umschließende try/catch liegt.
- [Client- gegenüber serverseitiger Auswertung](https://learn.microsoft.com/en-us/ef/core/querying/client-eval) in der EF Core Dokumentation, dazu wie EF einen Abfragebaum aufteilt.
- [DbContextOptionsBuilder.EnableSensitiveDataLogging](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.enablesensitivedatalogging), das die Meldungsvariante aktiviert, die den Ausdruck benennt.
- [dotnet/efcore#34883](https://github.com/dotnet/efcore/issues/34883), die EF Core 9 Regression, bei der eine gemischte Client- und Datenbankbedingung diese Ausnahme mit einem inneren `unbound variable` Fehler erzeugte.
- [Finbuckle.MultiTenant Diskussion #792](https://github.com/Finbuckle/Finbuckle.MultiTenant/discussions/792), ein repräsentativer Bericht dieses Fehlers in einem Multi-Tenant-Kontext.

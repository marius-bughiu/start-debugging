---
title: "So escapen Sie die Platzhalter % und _ in EF.Functions.Like- und StartsWith-Abfragen in EF Core 11"
description: "StartsWith, EndsWith und Contains escapen % und _ in EF Core 11 bereits für Sie, EF.Functions.Like dagegen nicht. Hier sehen Sie das SQL, das EF erzeugt, einen wiederverwendbaren Escape-Helper und die escapeCharacter-Überladung, mit der es auf SQL Server, SQLite und PostgreSQL funktioniert."
pubDate: 2026-09-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "linq"
lang: "de"
translationOf: "2026/09/how-to-escape-wildcards-in-ef-functions-like-and-startswith-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

**Kurze Antwort:** In EF Core 11 müssen Sie für `string.StartsWith`, `EndsWith` oder `Contains` nichts escapen. EF schreibt den Suchwert in ein Muster wie `50\%%` um und fügt `ESCAPE N'\'` selbst hinzu. Bei `EF.Functions.Like` ist das anders: Das Muster wird unverändert durchgereicht, sodass ein Benutzer, der `50%` oder `a_b` eingibt, Platzhaltertreffer bekommt. Escapen Sie den vom Benutzer gelieferten Teil selbst (zuerst den Backslash, dann `%`, `_` und auf SQL Server `[`) und rufen Sie die Überladung mit drei Argumenten auf, `EF.Functions.Like(p.Name, pattern, "\\")`. Wenn Sie escapen, aber das dritte Argument weglassen, behandeln SQL Server und SQLite Ihre Backslashes als literale Zeichen, und die Abfrage liefert stillschweigend nichts.

Alles Folgende wurde auf .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`) mit `Microsoft.EntityFrameworkCore.SqlServer` und `Microsoft.EntityFrameworkCore.Sqlite` `11.0.0-rc.1.26425.128` gemessen. Die SQL-Server-Ausgabe stammt aus `ToQueryString()`. Die SQLite-Abfragen liefen tatsächlich gegen eine In-Memory-Datenbank, die Zeilenlisten sind also echte Ergebnisse.

## Warum ein Prozentzeichen im Suchfeld die falschen Zeilen liefert

SQL `LIKE` hat seine eigene kleine Mustersprache. Für SQL Server definiert [die `LIKE`-Referenz](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql) vier Platzhalter: `%` (eine beliebige Zeichenfolge), `_` (ein beliebiges einzelnes Zeichen), `[abc]` (ein Zeichensatz oder -bereich) und `[^abc]` (ein negierter Satz). SQLite und PostgreSQL kennen nur `%` und `_`. Jedes dieser Zeichen in einem Suchbegriff verändert die Bedeutung der Abfrage.

Eine Produktsuche, die ihr Muster per String-Verkettung zusammenbaut, zeigt das Problem sofort:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite in-memory
var term = "50%";   // what the user typed
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, "%" + term + "%"))
    .Select(p => p.Name)
    .ToListAsync();
```

Mit den Zeilen `50% off sale`, `500 widgets`, `done 50%` und `done 500` in der Tabelle liefert diese Abfrage **alle vier**. Das Muster ist `%50%%` und bedeutet "enthält 50", das vom Benutzer eingegebene Prozentzeichen ist verschwunden. Ein Unterstrich wirkt genauso: Die Suche nach `a_b` mit `$"%{term}%"` fand sowohl `a_b adapter` als auch `axb adapter`. Auf SQL Server kommt mit `[` im Suchbegriff ein dritter Platzhalter hinzu: `[x]` ist eine Zeichenklasse, die das einzelne Zeichen `x` trifft, also wird eine Suche nach `[x]` zu `%[x]%` und findet jeden Namen, der ein `x` enthält.

Das ist keine SQL-Injection. Der Wert wird weiterhin als Parameter gesendet (`DECLARE @p nvarchar(4000) = N'%50%%'`), niemand kann also aus dem String ausbrechen. Das Problem ist, dass das Muster etwas anderes bedeutet als das, wonach der Benutzer gefragt hat, und dass dabei kein Fehler auftritt.

## Was EF Core 11 bereits für Sie escapet

Bevor Sie einen Escape-Helper schreiben, prüfen Sie, ob Sie überhaupt einen brauchen. Die normalen LINQ-String-Methoden werden für Sie behandelt. Das erzeugt EF Core 11 RC 1 auf SQL Server, wenn der Suchwert eine erfasste Variable ist:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer
var term = "50%";
var q = db.Products.Where(p => p.Name.StartsWith(term));
Console.WriteLine(q.ToQueryString());
```

```sql
DECLARE @term_startswith nvarchar(4000) = N'50\%%';

SELECT [p].[Id], [p].[Name], [p].[Sku]
FROM [Products] AS [p]
WHERE [p].[Name] LIKE @term_startswith ESCAPE N'\'
```

EF hat die Variable auf dem Client ausgewertet, escapet, das `%` angehängt und das Ergebnis als neuen Parameter namens `@term_startswith` gesendet. `EndsWith` liefert `N'%50\%'` in `@term_endswith`, und `Contains` liefert `N'%a\_b%'` in `@under_contains`. Eine Konstante wie `StartsWith("50%")` wird auf dieselbe Weise escapet und als `LIKE N'50\%%' ESCAPE N'\'` inline eingefügt.

Das Escaping steckt in `SqlServerSqlTranslatingExpressionVisitor`. Am [Tag `v11.0.0-rc.1.26425.128`](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs) ist die Menge der Sonderzeichen eine einzige Zeile:

```csharp
// EF Core 11.0.0-rc.1, SqlServerSqlTranslatingExpressionVisitor.cs
private static bool IsLikeWildChar(char c)
    => c is '%' or '_' or '['; // See https://docs.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql
```

`EscapeLikePattern` setzt einen Backslash vor jedes dieser Zeichen und vor jeden Backslash, der bereits im Wert steht. Der SQLite-Provider hat denselben Code, nur dass sein `IsLikeWildChar` lediglich `%` oder `_` umfasst, weil SQLite keine Klammer-Klassen kennt.

Zwei Provider-Details können Sie überraschen:

- **SQLite verwendet für `Contains` überhaupt kein `LIKE`.** Es übersetzt `p.Name.Contains(term)` in `instr("p"."Name", @term) > 0`, dort ist also kein Escaping nötig. `StartsWith` und `EndsWith` werden weiterhin zu `LIKE ... ESCAPE '\'`.
- **Vergleiche zwischen Spalten umgehen `LIKE`.** `p.Name.StartsWith(p.Sku)` wird auf SQL Server zu `LEFT([p].[Name], LEN([p].[Sku])) = [p].[Sku]` und auf SQLite zu `substr(...)`. Da das Muster erst beim Lesen der Zeile bekannt ist, gibt es nichts zu escapen. Ein Kommentar im EF-Quellcode warnt, dass diese Form "less efficient than LIKE (i.e. StartsWith does an index scan instead of seek)" ist.

Wenn Sie auf Benutzereingaben nur "beginnt mit", "endet mit" oder "enthält" brauchen, verwenden Sie die String-Methoden und belassen Sie es dabei. `EF.Functions.Like` brauchen Sie nur, wenn Sie Platzhalter wollen, die Sie selbst gesetzt haben, etwa `abc%def`, oder wenn der Text des Benutzers mitten in einem größeren Muster steht.

## Warum EF.Functions.Like Ihre Eingabe nicht escapet

`EF.Functions.Like(matchExpression, pattern)` ist eine direkte Abbildung: Die [Seite zu den SQL-Server-Funktionszuordnungen](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions) führt sie als `@matchExpression LIKE @pattern`, ohne Escaping-Schritt. Das ist Absicht. Das Muster soll Platzhalter enthalten, und EF kann nicht wissen, welche `%`-Zeichen Sie gemeint haben und welche vom Benutzer stammen. Eine Anfrage, dass EF `Like`-Eingaben automatisch escapen soll, [dotnet/efcore#19118](https://github.com/dotnet/efcore/issues/19118), wurde als nicht geplant geschlossen, und EF Core 11 liefert weiterhin keinen öffentlichen Escape-Helper mit. Die Überladung, die Sie brauchen, ist die mit einem dritten Argument:

```csharp
public static bool Like(this DbFunctions _, string? matchExpression, string? pattern, string? escapeCharacter);
```

Diese Überladung wird zu `@matchExpression LIKE @pattern ESCAPE @escapeCharacter` übersetzt. Die Aufgabe teilt sich also in zwei Teile: den Text des Benutzers in C# escapen und dann der Datenbank mitteilen, welches Escape-Zeichen Sie verwendet haben.

## Benutzereingaben für EF.Functions.Like Schritt für Schritt escapen

1. **Wählen Sie ein Escape-Zeichen und verwenden Sie es überall.** Ein Backslash entspricht dem, was EF intern verwendet, sodass das SQL in Ihren Logs für `StartsWith` und `Like` gleich aussieht. Jedes einzelne Zeichen funktioniert, solange der Escape-Helper und das Argument `escapeCharacter` übereinstimmen.
2. **Escapen Sie zuerst das Escape-Zeichen selbst.** Wenn Sie zuerst `%` escapen und danach jeden Backslash verdoppeln, verdoppeln Sie auch die Backslashes, die Sie gerade hinzugefügt haben. Die Reihenfolge muss lauten: erst das Escape-Zeichen, dann die Platzhalter.
3. **Escapen Sie `%` und `_` bei jedem Provider und `[` auf SQL Server.** Das Escapen von `[` schadet anderswo nicht: SQLite und PostgreSQL behandeln ein escaptes gewöhnliches Zeichen als genau dieses Zeichen, sodass ein Helper für alle drei funktioniert.
4. **Fügen Sie Ihre eigenen Platzhalter nach dem Escapen hinzu.** Nur der Text des Benutzers läuft durch den Helper. Die `%`-Zeichen, die Sie darum herum setzen, bleiben aktiv.
5. **Übergeben Sie immer `escapeCharacter`.** Ohne dieses Argument haben SQL Server und SQLite überhaupt kein Escape-Zeichen.

Eine kleine statische Klasse deckt alle fünf Punkte ab:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public static class LikePattern
{
    public const string EscapeCharacter = "\\";

    public static string Escape(string value, char escape = '\\')
    {
        ArgumentNullException.ThrowIfNull(value);
        return value
            .Replace(escape.ToString(), $"{escape}{escape}") // must be first
            .Replace("%", $"{escape}%")
            .Replace("_", $"{escape}_")
            .Replace("[", $"{escape}[");                      // SQL Server bracket classes
    }

    public static string Contains(string value) => $"%{Escape(value)}%";
    public static string StartsWith(string value) => $"{Escape(value)}%";
    public static string EndsWith(string value) => $"%{Escape(value)}";
}
```

So verwenden Sie ihn:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var term = "a_b";
var rows = await db.Products
    .Where(p => EF.Functions.Like(p.Name, LikePattern.Contains(term), LikePattern.EscapeCharacter))
    .Select(p => p.Name)
    .ToListAsync();
```

Auf SQLite erzeugt das `.param set @Contains '%a\_b%'` und `WHERE "p"."Name" LIKE @Contains ESCAPE '\'` und liefert nur `a_b adapter`. Derselbe Code gegen SQL Server erzeugt `LIKE @Contains ESCAPE N'\'`. So fielen die übrigen Testfälle aus:

| Suchbegriff | Zeilen mit naivem `Like` (SQLite) | Zeilen mit escaptem `Like` (SQLite) |
| --- | --- | --- |
| `50%` | `50% off sale`, `500 widgets`, `done 50%`, `done 500` | `50% off sale`, `done 50%` |
| `a_b` | `a_b adapter`, `axb adapter` | `a_b adapter` |

Die escapte Version lieferte außerdem für `[x]` nur `[x] marked` (Muster `%\[x]%`) und für `C:\temp` nur `C:\temp\logs` (Muster `%C:\\temp%`, wobei der Backslash im Pfad verdoppelt wurde und `C:tempxlogs` nicht traf).

Sie können den Helper innerhalb des Lambdas aufrufen. Die Parameterextraktion von EF wertet jeden Teilbaum, der keine Spalte berührt, auf dem Client aus, sodass `LikePattern.Contains(term)` einmal in .NET läuft und sein Ergebnis zu einem Parameter wird, benannt nach der Methode (`@Contains`). Der Helper selbst muss nicht übersetzbar sein. Wenn Sie in Ihren [SQL-Logs](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) lesbare Parameternamen bevorzugen, berechnen Sie das Muster vorher in eine lokale Variable. `var pattern = LikePattern.Contains(term);` erscheint dann als `@pattern`.

## Ein vergessenes escapeCharacter liefert stillschweigend null Zeilen

Sobald das Escape-Problem bekannt ist, besteht ein häufiger nächster Fehler darin, den Suchbegriff zu escapen und dann die Überladung mit zwei Argumenten aufzurufen:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite -- WRONG
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape("a_b") + "%"));
```

```sql
WHERE "p"."Name" LIKE '%a\_b%'
```

Ohne `ESCAPE`-Klausel ist der Backslash ein gewöhnliches Zeichen, die Datenbank sucht also nach einem literalen `a\_b` (wobei `_` weiterhin ein Platzhalter ist) und findet nichts. Die [SQLite-Dokumentation zu Ausdrücken](https://www.sqlite.org/lang_expr.html#like) sagt ausdrücklich, dass es kein Standard-Escape-Zeichen gibt, und die SQL-Server-Referenz sagt, das Escape-Zeichen "has no default". Die Abfrage schlägt nicht fehl, sie liefert einfach eine leere Liste, was diesen Bug im Code-Review schwer erkennbar macht.

PostgreSQL ist die Ausnahme. Sein `LIKE` [behandelt den Backslash als Standard-Escape-Zeichen](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE), also funktioniert derselbe Code dort zufällig. Das ist die schlimmste Kombination: Tests gegen ein lokales PostgreSQL laufen durch, und die Produktion auf SQL Server liefert nichts. Wenn Sie `escapeCharacter` explizit übergeben, erhalten Sie auf allen drei dasselbe Verhalten.

## Ein anderes Escape-Zeichen wählen

Der Backslash ist für `LIKE` nichts Besonderes, er ist nur eine Konvention. Wenn Ihre Daten voller Windows-Pfade oder Regex-Fragmente sind, wählen Sie etwas Selteneres. Helper und Argument müssen übereinstimmen:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, SQLite
var term = "!%";
db.Products.Where(p => EF.Functions.Like(p.Name, "%" + LikePattern.Escape(term, '!') + "%", "!"));
// .param set @p '%!!!%%'
// WHERE "p"."Name" LIKE @p ESCAPE '!'
// ROWS: Promo!%
```

Aus `!%` wurde `!!!%`: Das literale `!` wurde zu `!!` verdoppelt, dann wurde das `%` zu `!%`. Das Argument `escapeCharacter` muss genau ein Zeichen lang sein. Die Übergabe von `"ab"` wird problemlos übersetzt, schlägt aber bei der Ausführung der Abfrage fehl, mit SQLites `SqliteException: SQLite Error 1: 'ESCAPE expression must be a single character'`. SQL Server lehnt es ebenfalls ab, da sein Escape-Zeichen "must evaluate to only one character". Machen Sie es zu einer `const`, wie `LikePattern.EscapeCharacter` es tut, damit niemand den falschen Wert übergeben kann.

## Stolperfallen, die nichts mit Escaping zu tun haben

**Die Groß- und Kleinschreibung bestimmt die Datenbank.** Auf SQL Server hängt es von der Collation der Spalte ab, ob `LIKE` zwischen Groß- und Kleinschreibung unterscheidet, und das Escaping hat damit nichts zu tun. SQLite hat eine Falle, die sich im obigen Test zeigt. `StartsWith` wird zu `LIKE`, das SQLite bei ASCII ohne Beachtung der Groß- und Kleinschreibung vergleicht, während `Contains` zu `instr` wird, das sie beachtet. Die Suche nach `50% OFF` mit `StartsWith` fand `50% off sale`, `Contains` mit demselben Begriff fand dagegen nichts. Wenn Sie gegen SQLite testen und auf SQL Server bereitstellen, sollten Sie wissen, dass jede Methode anderen Regeln für die Groß- und Kleinschreibung folgt.

**Ein führendes `%` verhindert Index-Seeks.** Ein parametrisiertes `LIKE @p ESCAPE N'\'`, dessen Wert mit einem literalen Präfix beginnt, kann auf SQL Server einen Index nutzen. `%term%` kann das nicht, ob escapet oder nicht. Für echte Anforderungen der Art "irgendwo im Text suchen" auf großen Tabellen sollten Sie sich die SQL-Server-Volltextsuche (`EF.Functions.Contains` / `FreeText`) ansehen, statt `LIKE` noch mehr Arbeit aufzubürden.

**Eine Variable in zwei String-Methoden wiederverwenden.** EF Core 8.0.0 hatte einen Bug, bei dem `b.Name.StartsWith(s) || b.Body.Contains(s)` das `Contains`-Muster an beide Vergleiche schickte ([dotnet/efcore#32432](https://github.com/dotnet/efcore/issues/32432), behoben in 8.0.2). EF Core 11 erzeugt zwei getrennte Parameter, `@term_startswith = N'50\%%'` und `@term_contains = N'%50\%%'`. Wenn Sie noch auf 8.0.0 oder 8.0.1 sind, aktualisieren Sie das Paket.

**`StringComparison`-Überladungen werden nicht übersetzt.** `p.Name.StartsWith(term, StringComparison.OrdinalIgnoreCase)` wirft in RC 1 bei beiden Providern `InvalidOperationException: The LINQ expression ... could not be translated`. Der [Leitfaden zu Übersetzungsfehlern](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) behandelt die möglichen Umschreibungen. In diesem Fall lautet die Antwort entweder die einfache Überladung plus eine Collation ohne Beachtung der Groß- und Kleinschreibung oder `EF.Functions.Collate`.

**Kompilierte Abfragen sind unproblematisch.** Sowohl das automatische `StartsWith`-Escaping als auch der `LikePattern`-Helper erzeugen gewöhnliche Parameter, sie funktionieren also mit `EF.CompileAsyncQuery`. Das Escaping passiert bei jeder Ausführung, nicht beim Kompilieren der Abfrage. Lesen Sie [kompilierte Abfragen für Hot Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), wenn einer Ihrer Endpunkte eine Suche ist.

**Agenten und Tools, die Filter bauen.** Wenn ein LLM-Tool oder MCP-Server Freitext in `EF.Functions.Like`-Aufrufe umwandelt, wie im [Beispiel zu EF Core über MCP](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/), behandeln Sie die Argumente des Modells wie jede andere Benutzereingabe und schicken Sie sie durch denselben Helper.

## Das richtige Werkzeug für jede Suche

- Exakter Präfix-, Suffix- oder Teilstring-Treffer auf Benutzereingaben: `StartsWith` / `EndsWith` / `Contains`. EF Core 11 escapet das für Sie.
- Ein Muster mit Platzhaltern, die Sie kontrollieren, rund um Benutzertext: `EF.Functions.Like(col, LikePattern.Contains(term), LikePattern.EscapeCharacter)`.
- Ein Muster, das der Benutzer bewusst selbst schreibt: `EF.Functions.Like` mit zwei Argumenten, aber validieren Sie die Eingabe und bedenken Sie, was ein einzelnes `[` auf SQL Server bewirkt.
- Textsuche mit Relevanz-Ranking: Volltextsuche, nicht `LIKE`.

Prüfen Sie vor dem Ausliefern das erzeugte SQL einmal für jeden Provider, den Sie unterstützen. `ToQueryString()` ist eine einzige Zeile und hätte jeden Bug in diesem Beitrag gefunden, bevor die Produktion es tat.

### Weiterlesen

- [So protokollieren Sie das SQL, das EF Core 11 erzeugt](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Behoben: "The LINQ expression could not be translated" in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [So verwenden Sie kompilierte Abfragen mit EF Core für Hot Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [So speichern Sie ein Enum in EF Core 11 mit einem Value Converter als String](/de/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)

### Quellen

- [LIKE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/like-transact-sql), Microsoft Learn
- [Funktionszuordnungen, SQL-Server-Provider](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions), EF-Core-Dokumentation
- [`SqlServerSqlTranslatingExpressionVisitor.cs` bei v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Query/Internal/SqlServerSqlTranslatingExpressionVisitor.cs), dotnet/efcore
- [dotnet/efcore#19118: Escape provider-specific symbols in user input when using EF.Functions.Like](https://github.com/dotnet/efcore/issues/19118)
- [dotnet/efcore#32432: Incorrect parameter rewriting for StartsWith/EndsWith/Contains](https://github.com/dotnet/efcore/issues/32432)
- [SQLite: der LIKE-Operator](https://www.sqlite.org/lang_expr.html#like)
- [PostgreSQL: Mustervergleich mit LIKE](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE)

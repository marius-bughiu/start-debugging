---
title: "Fix: 23505: duplicate key value violates unique constraint bei einem nebenläufigen EF-Core-Insert"
description: "Das Prüfen-dann-Einfügen in Ihrem Handler ist nicht atomar. Fangen Sie PostgresException mit SqlState 23505 ab, oder fassen Sie alles in einer einzigen INSERT ... ON CONFLICT-Anweisung zusammen. EnableRetryOnFailure hilft nicht."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "postgresql"
  - "npgsql"
  - "concurrency"
  - "dotnet-11"
lang: "de"
translationOf: "2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert"
translatedBy: "claude"
translationDate: 2026-08-30
---

Ihr Handler prüft "gibt es diese E-Mail-Adresse schon?", sieht nichts und fügt ein. Unter Last tun zwei Anfragen das gleichzeitig, beide sehen nichts, und Postgres weist den Verlierer am Index mit `23505` ab. Der Unique-Index ist nicht der Fehler, er ist das Einzige, das den Fehler gefunden hat. Beheben Sie es auf eine von zwei Arten: Fassen Sie Lesen und Schreiben in einer einzigen `INSERT ... ON CONFLICT`-Anweisung zusammen, sodass kein Zeitfenster dazwischen bleibt, oder behalten Sie das naive Insert und fangen Sie die `DbUpdateException` ab, deren innere Exception eine `PostgresException` mit `SqlState == PostgresErrorCodes.UniqueViolation` ist, und lesen Sie dann die vom Gewinner geschriebene Zeile erneut. Greifen Sie nicht zu `EnableRetryOnFailure`: Der Transient-Detector von Npgsql liefert für `23505` `false`, die Resilienzschicht reicht die Exception also direkt an Sie durch.

Eine Anmerkung zur Verifikation. Das einzige SDK auf dieser Maschine ist .NET 10.0.302, und es läuft kein Postgres-Server darauf. Alles Folgende wurde daher offline gegen `Npgsql` 10.0.3, `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 und `Microsoft.EntityFrameworkCore` 10.0.4 geprüft (Konstantenwerte, der Transient-Exception-Detector, das generierte SQL, der Zustand des Change Trackers), ergänzt um die PostgreSQL-18-Dokumentation für das serverseitige Verhalten. Der Npgsql-Provider 11.0 befindet sich zum Zeitpunkt dieses Textes noch in der Vorabversion, und seine [11.0-Release-Notes](https://www.npgsql.org/efcore/release-notes/11.0.html) nennen keine Änderungen am Error-Mapping, am `SaveChanges`-Batching oder am Retry-Detector. Alles gilt damit auch für EF Core 11 und Provider 11.0. Wo eine Aussage aus der Serverdokumentation statt aus einem Lauf auf dieser Maschine stammt, sage ich das.

## Der Fehler im Kontext

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Npgsql.PostgresException (0x80004005): 23505: duplicate key value violates unique constraint "IX_Users_Email"

DETAIL: Key ("Email")=(ada@example.com) already exists.
   at Npgsql.Internal.NpgsqlConnector.ReadMessageLong(...)
   at Npgsql.NpgsqlDataReader.NextResult(...)
   at Microsoft.EntityFrameworkCore.Update.Internal.BatchExecutor.ExecuteAsync(...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalDatabase.SaveChangesAsync(...)
```

Zwei Dinge in diesem Block sollten Sie genau lesen.

Der Name der Constraint sagt Ihnen, welchen Fehler Sie haben. `IX_Users_Email` ist ein Unique-Index, den Sie selbst deklariert haben, es handelt sich also um eine Race Condition auf Anwendungsebene. Steht dort stattdessen `PK_Users`, haben Sie mit hoher Wahrscheinlichkeit eine verschobene Identity-Sequenz, was ein völlig anderes Problem ist und weiter unten behandelt wird.

Die Zeile `DETAIL:` kann komplett fehlen. Der Verbindungszeichenfolgen-Parameter `Include Error Detail` von Npgsql steht standardmäßig auf `false` (verifiziert: `new NpgsqlConnectionStringBuilder("Host=h;Database=d").IncludeErrorDetail` liefert unter Npgsql 10.0.3 `False`), denn der Detailtext enthält den kollidierenden Schlüsselwert, und das sind häufig personenbezogene Daten. Ergänzen Sie in der Entwicklung `Include Error Detail=true`, wenn Sie den Wert brauchen, und lassen Sie es in der Produktion aus, solange Sie nicht damit einverstanden sind, dass Schlüssel in Ihren Logs landen.

## Warum das passiert

Die dominierende Ursache, und die, die zu "es passiert nur unter Last" passt: Eine Prüfung gefolgt von einem Insert sind zwei Anweisungen mit einer Lücke dazwischen. Nichts in einer `READ COMMITTED`-Transaktion hindert eine andere Sitzung daran, in diese Lücke einzufügen. Die PostgreSQL-Dokumentation zu [Index Uniqueness Checks](https://www.postgresql.org/docs/current/index-unique-checks.html) beschreibt, was der Server tut, wenn die andere Sitzung noch nicht committet hat: "If a conflicting row has been inserted by an as-yet-uncommitted transaction, the would-be inserter must wait to see if that transaction commits." Bei einem Rollback gibt es keinen Konflikt und Ihr Insert läuft durch; bei einem Commit erhalten Sie `23505`. Deshalb tritt der Fehler schubweise auf und deshalb lässt er sich auf einem Entwickler-Notebook mit einer einzigen Anfrage nie reproduzieren.

Zwei weitere Ursachen erzeugen denselben SQLSTATE und sollten ausgeschlossen werden, bevor Sie Nebenläufigkeitscode schreiben:

- **Eine verschobene Sequenz.** Nach einem `pg_restore`, einem `COPY` oder einem Datenimport mit expliziten Primärschlüsseln zeigt die Identity-Sequenz noch auf 1, während die Tabelle bereits Zeilen bis 40.000 enthält. Jedes Insert kollidiert dann auf `PK_<Table>`. Die Lösung ist `SELECT setval(pg_get_serial_sequence('"Users"', 'Id'), (SELECT MAX("Id") FROM "Users"));`, keine Retry-Schleife.
- **Ein erneutes `SaveChanges` auf demselben `DbContext`.** Ein fehlgeschlagenes `SaveChangesAsync` löst nichts vom Kontext. Ich habe das direkt geprüft: Nach der Exception meldet `ChangeTracker.Entries()` die kollidierende Entität weiterhin im Zustand `Added`, `DbUpdateException.Entries` enthält genau einen Eintrag, und ein erneuter Aufruf von `SaveChangesAsync` auf demselben Kontext wirft dieselbe Exception. Jeder Retry muss von einem frischen Kontext ausgehen.

## Minimale Reproduktion

```csharp
// .NET SDK 10.0.302, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class User
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<User>().HasIndex(u => u.Email).IsUnique();
```

Dieses Modell erzeugt beim Npgsql-Provider genau dieses DDL (`db.Database.GenerateCreateScript()`, offline ausgeführt):

```sql
CREATE TABLE "Users" (
    "Id" integer GENERATED BY DEFAULT AS IDENTITY,
    "Email" text NOT NULL,
    "Name" text NOT NULL,
    CONSTRAINT "PK_Users" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX "IX_Users_Email" ON "Users" ("Email");
```

Und das ist der Handler, der das Rennen verliert:

```csharp
// Racy: the gap between AnyAsync and SaveChangesAsync is unguarded.
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    if (await db.Users.AnyAsync(u => u.Email == email, ct))
        throw new EmailTakenException(email);

    var user = new User { Email = email, Name = name };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);   // 23505 when a second request got here first
    return user;
}
```

Diese drei Anweisungen in eine Transaktion zu packen, hilft nicht. Eine Transaktion liefert Atomarität, keinen gegenseitigen Ausschluss, und `READ COMMITTED` ist der Standard. Ein höheres Isolationsniveau hilft ebenfalls nicht: Es ändert in manchen Szenarien den SQLSTATE, den Sie bekommen, aber es lässt den Konflikt nicht verschwinden. Die PostgreSQL-Seite zum [Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) geht genau auf dieses Muster ein und merkt an, dass ein Unique-Key-Fehler nach dem Prüfen der gespeicherten Schlüssel "is effectively a serialization failure, but the server will not detect it as such because it cannot see the connection between the inserted value and the previous reads."

## Lösung 1: eine Anweisung, mit ON CONFLICT

Das ist die Lösung, zu der Sie zuerst greifen sollten. `INSERT ... ON CONFLICT` ist eine einzige Anweisung, es gibt also kein Zeitfenster, in das jemand einfügen könnte, und die Konfliktauflösung passiert innerhalb des Index-Insert-Pfads des Servers.

Die Feinheit liegt darin, die Zeile zurückzubekommen. `ON CONFLICT DO NOTHING` liefert bei einem Konflikt nichts zurück: Die [INSERT-Dokumentation](https://www.postgresql.org/docs/current/sql-insert.html) hält fest, dass `RETURNING` nur erfolgreich eingefügte oder aktualisierte Zeilen zurückgibt. Ein Get-or-Create, das die Id kennen muss, verwendet daher `DO UPDATE` mit einer Selbstzuweisung, die die Zeile anfasst und sie damit für `RETURNING` qualifiziert:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3. Same code compiles unchanged on EF Core 11.
public async Task<int> GetOrCreateUserIdAsync(string email, string name, CancellationToken ct)
{
    var ids = await db.Database.SqlQuery<int>($"""
        INSERT INTO "Users" ("Email", "Name")
        VALUES ({email}, {name})
        ON CONFLICT ("Email") DO UPDATE SET "Email" = EXCLUDED."Email"
        RETURNING "Id" AS "Value"
        """).ToListAsync(ct);

    return ids.Single();
}
```

Vier Details in diesem Ausschnitt sind tragend:

1. **`AS "Value"`.** `SqlQuery<T>` liest bei einem Skalartyp eine Spalte namens `Value`. Ohne den Alias erhalten Sie einen Laufzeitfehler wegen einer fehlenden Spalte, keinen Compilerfehler.
2. **Die interpolierten Stellen sind Parameter, keine Verkettung.** `ToQueryString()` auf dieser Abfrage gibt `VALUES (@p0, @p1)` aus, die Werte werden separat ausgewiesen. Die übliche Injection-Sorge greift hier also nicht.
3. **`ToListAsync`, niemals `FirstOrDefaultAsync`.** EF Core untersucht das rohe SQL und weigert sich, über einer Anweisung zu komponieren, die kein `SELECT` ist. Jeder zusätzliche LINQ-Operator wirft `InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable SQL and with a query composing over it.` Genau darauf bin ich in `NpgsqlQuerySqlGenerator` gestoßen, während ich das generierte SQL geprüft habe. Materialisieren Sie zuerst die Liste und wählen Sie dann aus.
4. **`EXCLUDED` ist die vorgeschlagene Zeile.** `SET "Email" = EXCLUDED."Email"` ist ein absichtlich wirkungsloser Schreibvorgang, dessen einziger Zweck darin besteht, die kollidierende Zeile für `RETURNING` zu qualifizieren.

Wenn Sie die Id tatsächlich nicht brauchen, nehmen Sie `ON CONFLICT ("Email") DO NOTHING` und sparen sich die Write Amplification. Die Variante mit Selbstzuweisung schreibt eine neue Zeilenversion, erhöht `xmax` und feuert bei jedem Duplikatversuch alle `BEFORE UPDATE`-Trigger.

Noch eine Einschränkung, die die Dokumentation ausdrücklich nennt: `ON CONFLICT DO UPDATE` fasst dieselbe bestehende Zeile innerhalb einer Anweisung kein zweites Mal an und wirft eine Cardinality Violation (`21000`), wenn Ihre `VALUES`-Liste denselben Schlüssel zweimal enthält. Entfernen Sie Duplikate im Batch in C#, bevor Sie ihn abschicken.

## Lösung 2: optimistisch einfügen, 23505 abfangen, erneut lesen

Wenn das Insert tief in einer größeren Arbeitseinheit steckt und ein Umbau auf rohes SQL unpraktisch ist, lassen Sie den Index Ihr Lock sein und behandeln Sie die Niederlage:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    var user = new User { Email = email, Name = name };
    db.Users.Add(user);

    try
    {
        await db.SaveChangesAsync(ct);
        return user;
    }
    catch (DbUpdateException ex)
        when (ex.InnerException is PostgresException
              {
                  SqlState: PostgresErrorCodes.UniqueViolation,
                  ConstraintName: "IX_Users_Email"
              })
    {
        // Someone else won. This context is poisoned: the entity is still Added.
        await using var fresh = await factory.CreateDbContextAsync(ct);
        return await fresh.Users.SingleAsync(u => u.Email == email, ct);
    }
}
```

`PostgresErrorCodes.UniqueViolation` ist die Zeichenfolge `"23505"` (verifiziert gegen Npgsql 10.0.3), und die Konstante ist einem magischen String vorzuziehen. Filtern Sie zusätzlich auf `ConstraintName`. Ein Catch-Block mit bloßem `SqlState: "23505"` verschluckt bereitwillig eine Primärschlüsselkollision aus einer verschobenen Sequenz und macht aus einem Signal für Datenkorruption eine stille, falsche Antwort.

Der frische Kontext ist wesentlich, und deshalb passt dieses Muster zu `IDbContextFactory<T>` statt zu einem Scoped-`DbContext`. Wenn Sie den Scoped-Kontext injizieren und darauf erneut versuchen, senden Sie dieselbe `Added`-Entität erneut und bekommen dieselbe Exception, wie ich oben am Change Tracker bestätigt habe. Das Gleiche gilt, wenn Sie [einen DbContext aus einem Singleton-Dienst auflösen](/de/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/).

## Warum EnableRetryOnFailure hier nichts bewirkt

Das führt Leute in die Irre, die bereits Connection Resiliency ergänzt haben und annehmen, sie decke diesen Fall ab. Tut sie nicht. Ich habe den providereigenen Detector direkt per Reflection auf `Npgsql.EntityFrameworkCore.PostgreSQL.Storage.Internal.NpgsqlTransientExceptionDetector` aus Provider 10.0.3 aufgerufen:

```text
ShouldRetryOn(23505) = False     unique_violation
ShouldRetryOn(23503) = False     foreign_key_violation
ShouldRetryOn(40001) = True      serialization_failure
ShouldRetryOn(40P01) = True      deadlock_detected
ShouldRetryOn(53300) = True      too_many_connections
ShouldRetryOn(57P03) = True      cannot_connect_now
ShouldRetryOn(08006) = True      connection_failure
```

`PostgresException.IsTransient` stimmt damit überein: `False` für `23505`, `True` für `40001` und `40P01`. Diese Einordnung ist richtig. Ein blinder Retry eines echten Duplikats würde einfach wieder scheitern, endlos. Es bedeutet aber, dass der Retry Ihrer sein muss, auf der Ebene, auf der Sie entscheiden können, was ein Duplikat für diese Operation bedeutet. Wenn Sie eine eigene Execution Strategy um eine manuelle Transaktion legen, rechnen Sie mit dem Fehler [die Execution Strategy unterstützt keine benutzerinitiierten Transaktionen](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/), der Ihnen dabei begegnen wird.

## Lösung 3: ein Advisory Lock, wenn das Get-or-Create mehrere Anweisungen umfasst

Manchmal lässt sich die Operation wirklich nicht in eine Anweisung fassen: Sie müssen einen Mandanten anlegen, dann eine Schemazeile, dann eine Zeile mit Standardeinstellungen, und nur ein Aufrufer darf das tun. Serialisieren Sie über einen Schlüssel statt über die Tabelle:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
await using var tx = await db.Database.BeginTransactionAsync(ct);

// Held until the transaction commits or rolls back. No explicit unlock.
await db.Database.ExecuteSqlAsync(
    $"SELECT pg_advisory_xact_lock(hashtext({email}))", ct);

var existing = await db.Users.SingleOrDefaultAsync(u => u.Email == email, ct);
if (existing is not null) { await tx.CommitAsync(ct); return existing; }

db.Users.Add(new User { Email = email, Name = name });
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

`pg_advisory_xact_lock` wird am Ende der Transaktion automatisch freigegeben, und genau diese Eigenschaft wollen Sie: Kein `finally`-Block kann es lecken. Zwei Einschränkungen. `hashtext` liefert einen 32-Bit-Wert, unterschiedliche Schlüssel können also kollidieren und sich unnötig gegenseitig serialisieren. Das ist ein Leistungsproblem und nie ein Korrektheitsproblem. Und es funktioniert nur, wenn jeder Schreiber das Lock nimmt. Behalten Sie den Unique-Index trotzdem: Er ist die Rückfallebene für den Codepfad, der es vergisst.

## Varianten, die gleich aussehen, aber keine sind

**Das Insert gelingt allein und scheitert im Batch.** EF Core bündelt mehrere ausstehende Inserts in einem Roundtrip innerhalb einer Transaktion, ein einzelnes Duplikat an beliebiger Stelle im Batch rollt also alle hinzugefügten Zeilen zurück. `DbUpdateException.Entries` sagt Ihnen, welche Entität der Server abgelehnt hat; der Rest bleibt unangetastet, aber ebenfalls ungespeichert. Wenn Sie Tausende Zeilen einfügen, ist das einer der Gründe, zu einem anderen Schreibpfad zu greifen, den ich in [EF Core 11 vs Dapper für Bulk-Inserts](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) gemessen habe.

**Die Ids springen nach jedem Fehlschlag weiter.** Erwartet, und nicht behebbar. Die [Dokumentation der Sequenzfunktionen](https://www.postgresql.org/docs/current/functions-sequence.html) ist eindeutig: "the value obtained by `nextval` is not reclaimed for re-use if the calling transaction later aborts." Sie nennt außerdem `ON CONFLICT` ausdrücklich, weil das Tupel samt seines `nextval`-Aufrufs berechnet wird, bevor der Konflikt erkannt wird. Jeder Duplikatversuch verbrennt eine Id. Wenn Ihre Schlüssel für Nutzer sichtbar sind und Lücken inakzeptabel wären, ist die Antwort eine andere Schlüsselstrategie, keine lückenlose Sequenz; siehe [einen Primärschlüssel aus einer Datenbanksequenz erzeugen](/de/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/).

**Duplikate in einer nullbaren Spalte, die Sie für unmöglich hielten.** Ein normaler Unique-Index behandelt `NULL`-Werte als verschieden, es können also beliebig viele Zeilen dort `NULL` haben. Wenn Sie tatsächlich höchstens eine wollen, unterstützt PostgreSQL ab Version 15 `CREATE UNIQUE INDEX ... ON "Users" ("ExternalId") NULLS NOT DISTINCT`. Beachten Sie, dass der Npgsql-Provider 11.0 sein Standard-Mindestziel auf PostgreSQL 16 anhebt, das steht also auf jedem Server zur Verfügung, den der aktuelle Provider standardmäßig anvisiert.

**`ON CONFLICT` scheitert mit "there is no unique or exclusion constraint matching the ON CONFLICT specification".** Das Konfliktziel ist eine Index-Inferenz, keine Spaltenliste. Ist Ihr Unique-Index partiell (`WHERE "DeletedAt" IS NULL`), müssen Sie das Prädikat wiederholen: `ON CONFLICT ("Email") WHERE "DeletedAt" IS NULL DO NOTHING`. Alternativ benennen Sie die Constraint direkt mit `ON CONFLICT ON CONSTRAINT "IX_Users_Email"`, was die Inferenz komplett umgeht.

**Das ist ein nebenläufiges Update, kein nebenläufiges Insert.** Wenn zwei Aufrufer eine bestehende Zeile ändern statt eine neue anzulegen, ist `23505` das falsche Werkzeug und Sie brauchen stattdessen ein Concurrency Token. Das ist ein anderer Mechanismus mit einer anderen Exception, behandelt in [optimistische Nebenläufigkeit mit einem Rowversion-Token](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Der Nachweis im Test

Eine Race Condition, die nur unter Produktionslast auftritt, lässt sich mit einem einthreadigen In-Memory-Provider nicht durch einen Regressionstest absichern. Sie brauchen einen echten Server und zwei Verbindungen. Starten Sie einen Postgres-Container, holen Sie zwei Kontexte aus `IDbContextFactory<T>` und lassen Sie beide Inserts an demselben `TaskCompletionSource`-Gatter los, damit sie im selben Moment am Index konkurrieren. Ist der Handler korrekt, liefern beide Tasks dieselbe Id und keiner wirft. Die Abwägungen dieses Aufbaus gegenüber einem gefälschten Backing Store sind in [WebApplicationFactory vs Testcontainers](/de/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) dargestellt.

Die Gewohnheit, die sich lohnt, ist kleiner als all dieser Code. Wenn Sie eine `DbUpdateException` abfangen, sehen Sie sich `SqlState` und `ConstraintName` an, bevor Sie entscheiden, was sie bedeutet. Ein `23505` auf einem Unique-Index, den Sie entworfen haben, ist Ihr Datenmodell bei der Arbeit und der Hinweis, dass ein Aufrufer ein Rennen verloren hat. Ein `23505` auf einem Primärschlüssel ist meist der Hinweis der Datenbank, dass mit der Tabelle selbst etwas nicht stimmt.

## Verwandte Beiträge

- [Optimistische Nebenläufigkeit mit einem Rowversion-Token in EF Core 11 umsetzen](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Einen Primärschlüssel beim Insert aus einer Datenbanksequenz erzeugen in EF Core 11](/de/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/)
- [Fix: The configured execution strategy does not support user-initiated transactions](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [IDbContextFactory aus einem Singleton-Dienst in Blazor verwenden](/de/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/)
- [EF Core 11 vs Dapper für Bulk-Inserts: ein echter Benchmark](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Quellen

- [PostgreSQL 18: Index Uniqueness Checks](https://www.postgresql.org/docs/current/index-unique-checks.html)
- [PostgreSQL 18: Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
- [PostgreSQL 18: INSERT, einschließlich ON CONFLICT und Unique-Index-Inferenz](https://www.postgresql.org/docs/current/sql-insert.html)
- [PostgreSQL 18: Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html)
- [PostgreSQL Error Codes: Class 23 Integrity Constraint Violation](https://www.postgresql.org/docs/current/errcodes-appendix.html)
- [Release-Notes 11.0 des Npgsql-Providers für EF Core](https://www.npgsql.org/efcore/release-notes/11.0.html)
- [EF Core: Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency)

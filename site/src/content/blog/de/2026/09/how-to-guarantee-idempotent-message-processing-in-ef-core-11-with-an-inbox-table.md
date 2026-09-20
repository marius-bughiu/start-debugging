---
title: "Idempotente Nachrichtenverarbeitung mit EF Core 11 garantieren, wenn zwei App-Instanzen dieselbe Nachricht konsumieren"
description: "Die Existenzprüfung in Ihrem Handler ist nicht der Schutz, für den Sie sie halten. Legen Sie einen eindeutigen Index auf die Inbox-Tabelle, schreiben Sie den Marker im selben SaveChanges wie die fachliche Änderung, und lassen Sie die Datenbank den Gewinner bestimmen. Dazu die ExecuteUpdate-Falle, die all das stillschweigend aushebelt."
pubDate: 2026-09-20
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "messaging"
  - "idempotency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table"
translatedBy: "claude"
translationDate: 2026-09-20
---

Kurze Antwort: Vertrauen Sie `if (await db.Inbox.AnyAsync(...)) return;` nicht länger. Zwei Instanzen können diese Prüfung beide ausführen, bevor eine von beiden committet, und beide verarbeiten die Nachricht. Geben Sie der Inbox-Tabelle stattdessen einen eindeutigen Index auf den Deduplizierungsschlüssel, fügen Sie die Markerzeile zusammen mit der fachlichen Änderung in den Change Tracker ein, und lassen Sie ein einziges `SaveChangesAsync` beides oder nichts committen. Die Instanz, die das Rennen verliert, erhält eine `DbUpdateException`, deren innere Exception eine Unique-Verletzung ist, was "das hat schon jemand anders erledigt" bedeutet. Sie bestätigt die Nachricht also und kehrt zurück. Die Datenbank macht den Handler idempotent, nicht Ihr `if`.

Dieser Beitrag behandelt die Race Condition im Detail, die vierstufige Lösung samt dem SQL, das EF Core 11 tatsächlich erzeugt, wie Sie eine doppelte Nachricht von einer echten Constraint-Verletzung unterscheiden, die zweiphasige Variante für Seiteneffekte, die an keiner Datenbanktransaktion teilnehmen können, und die drei Fehler, die das Ganze stillschweigend außer Kraft setzen.

Eine Anmerkung zu Versionen und Verifikation. EF Core 11 setzt die .NET 11 Laufzeit voraus und erscheint im November 2026 zusammen mit .NET 11, laut der [EF Core Releases-Seite](https://learn.microsoft.com/en-us/ef/core/what-is-new/). Alles Folgende lief mit `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 auf dem .NET 11 RC 1 SDK. Auf dieser Maschine gibt es weder SQL Server noch PostgreSQL, die Nebenläufigkeitsläufe laufen daher gegen den SQLite-Provider mit zwei Verbindungen auf dieselbe Datenbankdatei, und die SQL-Server-Ausgabe entstand offline mit `GenerateCreateScript()` und einem Interceptor, der die Verbindung unterdrückt. Wo eine Aussage von serverseitigem Verhalten abhängt, das ich nicht ausführen konnte, sage ich das und zitiere stattdessen die Herstellerdokumentation.

## Warum die Existenzprüfung kein Schutz ist

At-least-once ist die Zustellgarantie, die Sie von Azure Service Bus, RabbitMQ, Kafka und SQS bekommen. Microsofts Seite zum [Idempotent Consumer Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer) nennt drei Wege, auf denen ein Duplikat bei Ihnen ankommt: Der Producer hat ein Senden wiederholt, dessen Bestätigung verloren ging, der Broker hat nach Ablauf Ihres Locks erneut zugestellt, oder Ihr Prozess ist zwischen dem Datenbankschreibvorgang und der Bestätigung abgestürzt.

Nichts davon ist exotisch. Ein Pod-Neustart während eines Rolling Deployments erzeugt alle drei. Und weil Sie mehr als ein Replikat betreiben, geht die erneute Zustellung nicht an dieselbe Instanz zurück, sondern an den Consumer, der gerade frei ist, und der verarbeitet womöglich in genau diesem Moment die ursprüngliche Kopie.

Hier ist der Handler, den fast jeder zuerst schreibt:

```csharp
// EF Core 11.0.0-rc.1, .NET 11. This is the version that does not work.
public async Task Handle(CreditRequested msg, CancellationToken ct)
{
    if (await db.Inbox.AnyAsync(m => m.MessageId == msg.MessageId && m.Consumer == "credit", ct))
        return;

    db.Credits.Add(new Credit { Amount = msg.Amount });
    db.Inbox.Add(new InboxMessage
    {
        MessageId = msg.MessageId,
        Consumer = "credit",
        ReceivedUtc = DateTime.UtcNow
    });

    await db.SaveChangesAsync(ct);
}
```

Zwei Instanzen, eine Message-ID, 50 ms Abstand zwischen Prüfung und Speichern, und die Inbox-Tabelle trägt einen einfachen, nicht eindeutigen Index:

```text
### 1. check-then-insert, no unique index, two concurrent consumers
  B: committed
  A: committed
  credits applied = 2, total = 200.0
  inbox rows = 2
```

Beide Leser sahen eine leere Inbox, beide schrieben einen Marker, beide schrieben dem Konto gut. Die Markertabelle lügt jetzt aktiv: Sie sagt, die Nachricht sei verarbeitet worden, zweimal.

## Die Lösung in vier Schritten

1. Geben Sie der Inbox-Tabelle einen eindeutigen Index auf Message-ID plus Consumer-Identität, damit die Datenbank den zweiten Schreiber ablehnen kann.
2. Fügen Sie Markerzeile und fachliche Änderung demselben `DbContext` hinzu und committen Sie beide mit einem einzigen `SaveChangesAsync`, damit sie gemeinsam oder gar nicht landen.
3. Fangen Sie die `DbUpdateException`, deren innere Exception eine Unique-Verletzung genau dieses Index ist, und behandeln Sie sie als "eine andere Instanz hat diese Nachricht bereits verarbeitet".
4. Bestätigen Sie die Nachricht sowohl auf dem Commit-Pfad als auch auf dem Pfad des abgefangenen Duplikats, und verwerfen Sie sie nur bei einer unbehandelten Exception.

### 1. Der Inbox-Tabelle einen eindeutigen Index auf den Deduplizierungsschlüssel geben

Der Schlüssel ist die Nachrichtenidentität plus die Consumer-Identität. Der Consumer-Teil zählt, wenn mehrere unabhängige Handler denselben Kanal abonnieren: Allein auf die Nachricht geschlüsselt, unterdrückt der erste Handler, der einen Marker schreibt, alle anderen Handler.

```csharp
// EF Core 11.0.0-rc.1
public class InboxMessage
{
    public long Id { get; set; }               // surrogate, keeps the clustered index sequential
    public Guid MessageId { get; set; }
    public string Consumer { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime? ProcessedUtc { get; set; }
}

protected override void OnModelCreating(ModelBuilder b)
{
    var inbox = b.Entity<InboxMessage>();
    inbox.HasKey(m => m.Id);
    inbox.Property(m => m.Consumer).HasMaxLength(200).IsRequired();
    inbox.HasIndex(m => new { m.MessageId, m.Consumer }).IsUnique();
}
```

`GenerateCreateScript()` auf dem SQL-Server-Provider liefert das hier:

```sql
CREATE TABLE [Inbox] (
    [Id] bigint NOT NULL IDENTITY,
    [MessageId] uniqueidentifier NOT NULL,
    [Consumer] nvarchar(200) NOT NULL,
    [ReceivedUtc] datetime2 NOT NULL,
    [ProcessedUtc] datetime2 NULL,
    CONSTRAINT [PK_Inbox] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Inbox_MessageId_Consumer] ON [Inbox] ([MessageId], [Consumer]);
```

Widerstehen Sie dem Drang, `MessageId` zum Primärschlüssel zu machen. Auf SQL Server ist der Primärschlüssel standardmäßig gruppiert, und ein gruppierter Index auf einem zufälligen `uniqueidentifier` fragmentiert die Tabelle bei jedem Insert. Ein `bigint IDENTITY`-Schlüssel, dessen Eindeutigkeit ein separater Index erzwingt, hält die Inserts am Ende des Heaps. Genau diese Form verwendet [MassTransit](https://masstransit.massient.com/documentation/configuration/middleware/outbox) für seine eigene `InboxState`-Entität: ein `long Id`, im Quelltext beschrieben als "Primary key for table, to have ordered clustered index", mit dem Deduplizierungspaar deklariert über `HasAlternateKey(p => new { p.MessageId, p.ConsumerId })`.

### 2. Den Marker im selben SaveChanges wie die fachliche Änderung schreiben

Nicht davor, nicht danach. Die [EF-Core-Dokumentation zu Transaktionen](https://learn.microsoft.com/en-us/ef/core/saving/transactions) ist eindeutig: "Alle Änderungen in einem einzigen Aufruf von `SaveChanges` werden in einer Transaktion angewendet. Schlägt eine der Änderungen fehl, wird die Transaktion zurückgerollt und keine der Änderungen wird auf die Datenbank angewendet."

Ich habe das mit einem `DbTransactionInterceptor` geprüft. Ein `SaveChangesAsync`, das ein Konto aktualisiert und den Marker einfügt, erzeugt auf SQLite `BEGIN, COMMIT` um dieses Anweisungspaar:

```sql
UPDATE "Accounts" SET "Balance" = @p0
WHERE "Id" = @p1
RETURNING 1;

INSERT INTO "Inbox" ("Consumer", "MessageId", "ProcessedUtc", "ReceivedUtc")
VALUES (@p0, @p1, @p2, @p3)
RETURNING "Id";
```

Auf SQL Server sendet dasselbe Speichern:

```sql
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Inbox] ([Consumer], [MessageId], [ProcessedUtc], [ReceivedUtc])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1, @p2, @p3);
```

Um den Alles-oder-nichts-Teil zu beweisen statt ihn anzunehmen, habe ich einen zum Scheitern verurteilten Insert in dasselbe Speichern gelegt. Der Marker landete nie:

```text
### 3. marker + business write in one SaveChanges: all or nothing
  SaveChanges threw SqliteException
  inbox rows after failure = 0 (marker rolled back with the business write)
```

Ein Vorbehalt ist wichtig: Der Standardwert `AutoTransactionBehavior.WhenNeeded` bedeutet, dass EF nur dann eine explizite Transaktion öffnet, wenn ein Speichern mehr als eine Anweisung braucht. Das ist der richtige Standard, aber es heißt, dass die Atomarität, auf die Sie sich verlassen, daraus entsteht, dass EF eine Transaktion für nötig hält. Wenn Sie `AutoTransactionBehavior.Never` setzen, warnt die Dokumentation, dass "frühere Befehle bereits committet sein können und damit Teiländerungen in der Datenbank hinterlassen". Setzen Sie es nicht in einem Message-Handler.

### 3. Die Unique-Verletzung fangen und als "bereits verarbeitet" behandeln

Behalten Sie die günstige Existenzprüfung ganz oben. Sie ist ein schneller Pfad für den häufigen Fall, dass die erneute Zustellung Minuten später eintrifft, und sie erspart eine zurückgerollte Transaktion. Sie ist nur nicht die Korrektheitsgarantie. Die Garantie ist der catch-Block:

```csharp
// EF Core 11.0.0-rc.1, SQL Server + PostgreSQL
try
{
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    // another instance committed this message first; its transaction already
    // applied the business change, so there is nothing left to do
    return;
}

static bool IsInboxDuplicate(DbUpdateException ex) => ex.InnerException switch
{
    SqlException s => (s.Number == 2601 || s.Number == 2627)
                      && s.Message.Contains("IX_Inbox_MessageId_Consumer", StringComparison.Ordinal),
    PostgresException p => p.SqlState == PostgresErrorCodes.UniqueViolation
                           && p.ConstraintName == "IX_Inbox_MessageId_Consumer",
    _ => false
};
```

Der korrigierte Handler gegen dieselbe Race Condition mit zwei Instanzen:

```text
### 2. same handler, unique index on (MessageId, Consumer)
  A: committed
  B: DbUpdateException / SqliteException code=19 ext=2067
         inner message: SQLite Error 19: 'UNIQUE constraint failed: Inbox.MessageId, Inbox.Consumer'.
  credits applied = 1, total = 100.0
  inbox rows = 1
```

Eine Gutschrift, ein Marker, und der Verlierer hat es sauber erfahren.

### 4. Die Nachricht auf beiden Pfaden bestätigen

Sowohl der Commit als auch das abgefangene Duplikat sind Endzustände: Schließen Sie die Nachricht ab. Nur eine unbehandelte Exception sollte sie verwerfen, damit der Broker erneut zustellt. Wer das umdreht und beim Duplikat verwirft, erzeugt eine Nachricht, die hin und her springt, bis sie im Dead-Letter landet.

## Was die Datenbank tut, während beide Instanzen einfügen

Der interessante Fall ist nicht der, den mein SQLite-Lauf zeigt, in dem der Verlierer sofort scheitert. Es ist der, in dem sich die beiden Inserts überlappen: Instanz A hat den Marker eingefügt, aber noch nicht committet, und Instanz B versucht, dasselbe Paar einzufügen.

PostgreSQLs Dokumentation zu [eindeutigen Indexprüfungen](https://www.postgresql.org/docs/18/index-unique-checks.html) beschreibt genau, was passiert: "Wenn eine konfligierende Zeile von einer noch nicht committeten Transaktion eingefügt wurde, muss der Einfügende warten, um zu sehen, ob diese Transaktion committet. Wird sie zurückgerollt, gibt es keinen Konflikt. Committet sie, ohne die konfligierende Zeile wieder zu löschen, liegt eine Eindeutigkeitsverletzung vor."

Diese Blockade ist die Funktion, kein Problem, das man wegoptimieren müsste. B erfährt sein Schicksal erst, wenn die Transaktion von A abgeschlossen ist. Committet A, bekommt B `23505` und kann gefahrlos überspringen, weil die fachliche Änderung dauerhaft ist. Rollt A zurück, weil der Handler eine Exception geworfen hat oder der Pod mitten in der Transaktion gestorben ist, gelingt der Insert von B und B verarbeitet die Nachricht, was genau das ist, was Sie wollen. SQL Server verhält sich unter seiner Standardisolation Read Committed genauso und hält B auf dem Index-Key-Lock fest, bis A abgeschlossen ist. Ich konnte hier keinen der beiden Server ausführen, nehmen Sie diese zwei Sätze also als dokumentiertes Verhalten und nicht als etwas, das ich gemessen habe.

## Eine doppelte Nachricht von einem echten Bug unterscheiden

Die `IsInboxDuplicate`-Prüfung oben passt auf den Indexnamen, und das ist Absicht. Ein Message-Handler, der fachliche Zeilen schreibt, schreibt meist in Tabellen mit eigenen Unique-Constraints: eine Bestellnummer, eine E-Mail-Adresse, ein Idempotenzschlüssel auf einer Zahlung. Wenn Ihr catch-Block jede Unique-Verletzung schluckt, wird ein echter Datenfehler im fachlichen Schreibvorgang dem Broker als "bereits verarbeitet" gemeldet und die Nachricht verschwindet.

Wie viel Hilfe der Provider bietet, ist unterschiedlich. Ich habe die Exception-Typen per Reflection untersucht:

```text
### 10. does the provider exception name the constraint?
  SqliteException: SqliteErrorCode, SqliteExtendedErrorCode, SqlState
  SqlException: Errors, Number, SqlState
```

Npgsql ist der großzügige. `PostgresException` stellt `SqlState`, `TableName`, `ColumnName` und `ConstraintName` bereit (verifiziert mit Npgsql 10.0.3), Sie können den Constraint also ohne String-Parsing über den Namen abgleichen. `SqlException` gibt Ihnen `Number` und sonst nichts Strukturiertes, Sie gleichen also den Indexnamen im Meldungstext ab. `SqliteException` gibt Ihnen `SqliteErrorCode` 19 und `SqliteExtendedErrorCode` 2067, die Spaltenliste steht nur in der Meldung.

Zu den beiden SQL-Server-Fehlernummern: 2601 ist "Cannot insert duplicate key row in object '%.\*ls' with unique index '%.\*ls'" und 2627 ist "Violation of %ls constraint '%.\*ls'. Cannot insert duplicate key in object '%.\*ls'", laut Microsofts [Referenz der Replikationsfehler](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)). Welche Sie bekommen, hängt davon ab, wie Sie die Eindeutigkeit deklariert haben. `HasIndex(...).IsUnique()` erzeugt `CREATE UNIQUE INDEX`, während `HasAlternateKey(...)` einen Tabellen-Constraint erzeugt:

```sql
CONSTRAINT [AK_Inbox_MessageId_Consumer] UNIQUE ([MessageId], [Consumer])
```

Fangen Sie beide Nummern ab und gleichen Sie den Namen ab, dann müssen Sie sich nicht darum kümmern, welche Ihr Modell erzeugt hat.

## Drei Wege, das stillschweigend kaputtzumachen

**`ExecuteUpdate` und `ExecuteDelete` sind nicht Teil des Speicherns.** Sie setzen ihre eigene Anweisung sofort ab, außerhalb jeder Transaktion, die `SaveChanges` später öffnet. Ein Handler, der ein Konto mit `ExecuteUpdateAsync` gutschreibt und danach den Inbox-Marker hinzufügt, hat überhaupt keine Atomarität:

```text
### 9. ExecuteUpdate commits on its own, before SaveChanges runs
  marker rejected as duplicate
  balance = 100 (the credit stuck even though the marker was rejected)
```

Die Duplikaterkennung funktionierte einwandfrei, und das Geld floss trotzdem. Wenn Sie die Leistung des Bulk-Updates wollen, öffnen Sie eine explizite Transaktion mit `BeginTransactionAsync`, führen Sie `ExecuteUpdateAsync` und `SaveChangesAsync` darin aus, und committen Sie einmal.

**Ein Retry auf demselben `DbContext` wiederholt denselben zum Scheitern verurteilten Insert.** Nach einem fehlgeschlagenen Speichern behält der Change Tracker jede Entität in ihrem Zustand vor dem Speichern:

```text
### 4. change-tracker state after a duplicate-key failure
  InboxMessage  state = Added
  Account       state = Modified
  retry on same context: threw again (SqliteException)
```

Jeder Retry muss mit einem frischen Scope und einem frischen Context beginnen. In der Praxis heißt das, der Retry sitzt auf der Ebene der Message-Pump, nicht im Handler.

**Eine wiederholende Execution Strategy plus eine explizite Transaktion wirft eine Exception.** In dem Moment, in dem Sie zu `BeginTransactionAsync` greifen, um das `ExecuteUpdate`-Problem von oben zu lösen, beschwert sich `EnableRetryOnFailure`. Dieser Fehler hat einen eigenen Beitrag: [the configured execution strategy does not support user-initiated transactions](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). Die Lösung ist `ExecuteAsync` auf der Strategy, das die ganze Transaktion umschließt, damit der Retry alles davon wiederholt.

## Seiteneffekte, die nicht an der Transaktion teilnehmen können

Eine E-Mail senden, eine Karte belasten oder in einen Blob Storage schreiben lässt sich nicht mit Ihrer Datenbanktransaktion zurückrollen. Das Muster, das funktioniert, ist ein zweiphasiger Claim: Marker einfügen und committen, dann die externe Arbeit erledigen, dann das Ergebnis festhalten.

```csharp
// EF Core 11.0.0-rc.1
db.Inbox.Add(new InboxMessage { MessageId = msg.MessageId, Consumer = "email", ReceivedUtc = DateTime.UtcNow });
try
{
    await db.SaveChangesAsync(ct);          // phase 1: claim the message
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    return;                                  // someone else owns this one
}

await emailer.SendAsync(msg, ct);            // the side effect, outside any transaction

await db.Inbox
    .Where(m => m.MessageId == msg.MessageId && m.Consumer == "email")
    .ExecuteUpdateAsync(s => s.SetProperty(m => m.ProcessedUtc, DateTime.UtcNow), ct);
```

Zwei nebenläufige Instanzen, ein externer Aufruf:

```text
### 7. two-phase claim: insert marker, commit, then call the API
  A: won the claim, called the API, marked processed (rows=1)
  B: lost the claim, skipping the API call
  external API calls = 1
```

Beachten Sie, was das bringt und was nicht. Es beseitigt den doppelten Aufruf. Es übersteht keinen Absturz zwischen Commit und Versand: Übrig bleibt eine beanspruchte Zeile, deren `ProcessedUtc` null ist, und keine Möglichkeit zu wissen, ob die E-Mail hinausging. Microsofts Empfehlung lautet, dass ein Datensatz in Bearbeitung "signalisiert, dass ein vorheriger Versuch teilweise abgeschlossen sein könnte", und dass Sie veraltete Datensätze abgleichen oder zur Klärung weiterleiten sollten. Die praktische Antwort ist, auch den nachgelagerten Aufruf idempotent zu machen, indem Sie dieselbe `MessageId` als Idempotenzschlüssel des Anbieters senden, und dann einen Sweeper Claims wiederholen zu lassen, die älter als ein Schwellwert sind.

## Den Schlüssel wählen und aufräumen

Der Deduplizierungsschlüssel muss über erneute Zustellungen hinweg stabil sein. Azure Service Bus `MessageId` und ein Paar aus CloudEvents `source` plus `id` erfüllen das beide. `CorrelationId` nicht, weil sie eine Konversation identifiziert und mehrere Nachrichten sie teilen. Zähler für Zustellversuche oder Empfangszeitstempel ebenfalls nicht. Auf Kafka, wo es keine vom Broker vergebene Message-ID gibt, ist das Tripel aus Topic, Partition und Offset für einen gegebenen Record stabil; ein vom Producer gesetzter Header ist besser, falls Sie einen haben.

Die Inbox-Tabelle wächst ewig, wenn Sie sie nicht kürzen, und zu frühes Kürzen öffnet das Fenster wieder. Halten Sie eine Zeile länger vor, als der Broker das Original noch erneut zustellen kann: Das ist das Lock- oder Visibility-Timeout mal der maximalen Zustellanzahl, plus die Time-to-live der Nachricht, plus eine Reserve für Nachrichten, die ein Operator Wochen später aus der Dead-Letter-Queue erneut einreicht. Ein nächtliches `ExecuteDeleteAsync` auf `ReceivedUtc < cutoff` genügt, und es ist eine der seltenen Stellen, an denen `ExecuteDelete` außerhalb einer Transaktion genau das ist, was Sie wollen.

Nichts davon ist kostenlos zu pflegen, weshalb es sich lohnt, das Muster wegzulassen, wenn die Operation von Natur aus idempotent ist. Ein Upsert auf einen fachlichen Identifikator oder ein Schreibvorgang, der einen absoluten Wert setzt statt ein Delta anzuwenden, braucht überhaupt keine Inbox. Wenn Sie ohnehin MassTransit einsetzen, geben Ihnen `AddInboxStateEntity()` und Verwandte dieselbe Maschinerie mit einem konfigurierbaren `DuplicateDetectionWindow` und einem Delivery Service, auf `MassTransit.EntityFrameworkCore` 9.2.2.

Selbst gebaut sind es eine Tabelle, ein Index, ein catch-Block und ein Aufräumjob. Der Teil, den Leute falsch machen, ist nie die Tabelle. Es ist der Glaube, dass das `if` am Anfang des Handlers die Arbeit erledigt hat.

### Weiterlesen

- [Fix: 23505: duplicate key value violates unique constraint bei einem nebenläufigen EF-Core-Insert](/de/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/)
- [Optimistische Nebenläufigkeit mit einem rowversion-Token in EF Core 11 implementieren](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Pessimistisches Sperren mit UPDLOCK und SELECT ... FOR UPDATE in EF Core 11](/de/2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11/)
- [Lösung: The configured execution strategy does not support user-initiated transactions](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [BackgroundService vs IHostedService vs Hangfire für Hintergrundaufgaben in .NET 11](/de/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)

### Quellen

- [Idempotent Consumer Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer), Azure Architecture Center
- [Transaktionen in EF Core](https://learn.microsoft.com/en-us/ef/core/saving/transactions), EF Core Dokumentation
- [Neuerungen in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), EF Core Dokumentation
- [PostgreSQL 18: Eindeutige Indexprüfungen](https://www.postgresql.org/docs/18/index-unique-checks.html)
- [Fehler 2601 und 2627 in der Referenz der Replikationsfehler](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)), Microsoft Learn
- [Konfiguration der Transactional Outbox](https://masstransit.massient.com/documentation/configuration/middleware/outbox), MassTransit Dokumentation
- [`InboxState.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Persistence/MassTransit.EntityFrameworkCoreIntegration/EntityFrameworkCoreIntegration/InboxState.cs), MassTransit

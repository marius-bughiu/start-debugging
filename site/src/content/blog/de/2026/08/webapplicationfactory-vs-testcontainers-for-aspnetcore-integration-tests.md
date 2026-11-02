---
title: "WebApplicationFactory vs Testcontainers für Integrationstests in ASP.NET Core"
description: "Die passende Umgebung für ASP.NET-Core-Integrationstests nach Prüfziel auswählen: HTTP-Routing, Verhalten der Produktionsdatenbank oder veröffentlichtes App-Image."
pubDate: 2026-08-07
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "de"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

`WebApplicationFactory<TEntryPoint>` startet die zu testende Anwendung. Testcontainers startet Abhängigkeiten wie PostgreSQL oder SQL Server. Beide lassen sich kombinieren. Entscheidend ist, welches Verhalten die Assertion beobachten soll.

**Korrektur, 2. November 2026.** Ein fehlgeschlagener `:int`-Routenconstraint führt normalerweise zu 404. Die frühere Fassung nannte 400 und vermittelte, nur eine containerisierte App könne einen echten Socket nutzen. Das HTTP-Beispiel wurde mit ASP.NET Core 10.0.10 und SDK 10.0.302 geprüft. Frühere Fixture-Zeitangaben ohne veröffentlichten Benchmarkaufbau wurden entfernt.

## Nach Prüfziel auswählen

| Prüfziel | Aufbau | Prüfen |
| --- | --- | --- |
| Routing, Autorisierung und Serialisierung | Factory mit standardmäßigem `TestServer` und Testregistrierungen | Status, Header und Antwortinhalt |
| Der Endpunkt hängt von der produktiven Datenbanksemantik ab | Factory mit Testcontainers und derselben Datenbank-Engine | Constraints, Migrationen, Abfrageübersetzung und Konkurrenz |
| Das veröffentlichte Image startet korrekt | App-Image mit seinen Diensten bauen und starten | Dockerfile, Einstiegspunkt, Konfiguration und Netzwerk |

Standardmäßig verwendet die Factory einen HTTP-Server im Prozess. Seit .NET 10 kann `UseKestrel()` einen echten Port mit Kestrel nutzen. Rufen Sie es vor dem Initialisieren der Factory auf. TLS und HTTP/2 erfordern passende Server- und Clientkonfiguration. Soll das Image selbst geprüft werden, testen Sie den App-Container.

## Eine HTTP-Prüfung ohne Datenbank

```csharp
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders/{id:int}", (int id) => TypedResults.Ok(id));
app.MapGet("/bound/{id}", (int id) => TypedResults.Ok(id));
app.Run();
```

`GET /orders/7` ergibt 200. `GET /orders/abc` verfehlt den Constraint und ergibt 404, weil keine Route passt. `GET /bound/abc` passt zur Route, doch die Bindung an den Integerparameter schlägt mit 400 fehl. Diese Prüfungen liefen auf Kestrel über Loopback. Den Aufbau der Factory, Dienstersatz und Authentifizierung erklärt der [WebApplicationFactory-Leitfaden](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

## Eine Datenbankprüfung braucht den passenden Provider

SQLite erzwingt etwa Eindeutigkeit, aber `VARCHAR(16)` allein begrenzt die Länge nicht auf 16 Zeichen. PostgreSQL lehnt einen zu langen Wert mit überschüssigen Nicht-Leerzeichen für `varchar(16)` ab. Ein grüner SQLite-Test bestätigt diese PostgreSQL-Regel nicht. Dasselbe gilt für providerspezifisches SQL, Migrationen und [Rowversion-Konkurrenz](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

Für einen SQL-Server-Endpunkt starten Sie einen SQL-Server-Testcontainer, wenden die Migrationen an, konfigurieren die Factory mit seiner Verbindungszeichenfolge und prüfen das Datenbankergebnis. Der [Testcontainers-Leitfaden für SQL Server](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) zeigt die Einrichtung. Reine HTTP-Tests können ohne Docker auskommen.

## Reproduzierbare Fixtures

Teilen Sie einen Container nur bei isolierten Testdaten. Ein Schema bzw. eine Datenbank pro Gruppe oder ein definierter Reset verhindert Einflüsse früherer Schreibvorgänge. Messen Sie Image-Download, Start, Schemaerstellung und Requests getrennt. Ein lokales Image im Cache und ein frischer CI-Worker verursachen unterschiedliche Kosten.

## Quellen

- [ASP.NET Core integration tests](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests?view=aspnetcore-10.0)
- [Route constraints](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing?view=aspnetcore-10.0#route-constraints)
- [WebApplicationFactory.UseKestrel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel?view=aspnetcore-10.0)
- [Testcontainers for .NET](https://dotnet.testcontainers.org/)
- [SQLite VARCHAR limits](https://sqlite.org/faq.html#q9) · [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html)

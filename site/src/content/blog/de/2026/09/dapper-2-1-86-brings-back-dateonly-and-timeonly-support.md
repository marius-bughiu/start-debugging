---
title: "Dapper 2.1.86 bringt DateOnly und TimeOnly zurück, zwei Jahre nach dem Entfernen"
description: "Dapper 2.1.86 aktiviert das eingebaute DateOnly- und TimeOnly-Mapping für Parameter, Member und Skalare wieder, mit behobenen Fehlern beim Spaltenversatz und beim stillen default(T). Was sich geändert hat, was ich gemessen habe und was das für Ihre eigenen Type Handler bedeutet."
pubDate: 2026-09-14
tags:
  - "dapper"
  - "dotnet"
  - "csharp"
lang: "de"
translationOf: "2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support"
translatedBy: "claude"
translationDate: 2026-09-14
---

Dapper 2.1.86 ist am 2026-09-12 auf NuGet erschienen, und die wichtigste Neuerung ist eine Zeile in den [Release Notes](https://github.com/DapperLib/Dapper/releases/tag/2.1.86): "Re-enable DateOnly/TimeOnly support, fixing the defects that got it disabled". Wenn Sie seit .NET 6 einen `SqlMapper.TypeHandler<DateOnly>` mit sich herumtragen, ist dies das Release, mit dem Sie ihn löschen können.

## Wie die DateOnly-Unterstützung erschien, kaputtging und verschwand

Natives `DateOnly`/`TimeOnly`-Mapping kam erstmals mit 2.1.37 über [#2051](https://github.com/DapperLib/Dapper/pull/2051) im März 2024. Innerhalb weniger Wochen stießen Nutzer von 2.1.44 auf [#2072](https://github.com/DapperLib/Dapper/issues/2072): Eine `datetime`-Spalte, die auf eine `DateOnly`-Eigenschaft gemappt wurde, schlug mit `Error parsing column 1 (FromDate=Ed - String)` fehl. Das sah nach einem Off-by-one-Fehler aus, weil die Meldung den Wert der falschen Spalte anzeigte. Im April 2024 wurde die Funktion herauskompiliert ([#2080](https://github.com/DapperLib/Dapper/pull/2080)), und jedes Release von 2.1.66 bis 2.1.79 wurde ohne sie ausgeliefert.

[PR #2228](https://github.com/DapperLib/Dapper/pull/2228) behebt die eigentlichen Ursachen statt der Symptome:

- Eine Spalte, deren gemeldeter Typ eine Konvertierung braucht (ein `datetime` in `DateOnly`), läuft nicht mehr über `GetFieldValue<T>`. Das war der Absturz aus #2072.
- Die Pfade für Member, Skalare und `Parse<T>` konvertieren `DateOnly`/`TimeOnly` jetzt in beide Richtungen von und nach `DateTime`/`TimeSpan`. Das ist wichtig, weil die Provider sich uneinig sind: Npgsql 10 boxt eine `date`-Spalte als `DateOnly`, während SqlClient und Npgsql 9 `DateTime` boxen ([#2226](https://github.com/DapperLib/Dapper/issues/2226)).
- `QuerySingle<DateOnly>` gibt nicht mehr ohne Fehler `default(T)` zurück ([#2227](https://github.com/DapperLib/Dapper/issues/2227)).

## Vorher und nachher, gemessen

Ich habe dieselbe dateibasierte App gegen 2.1.79 und 2.1.86 auf dem .NET SDK 10.0.302 mit `Microsoft.Data.Sqlite` 10.0.12 ausgeführt:

```csharp
#:package Dapper@2.1.86
#:package Microsoft.Data.Sqlite@10.0.12
#:property PublishAot=false
using Dapper;
using Microsoft.Data.Sqlite;

using var c = new SqliteConnection("Data Source=:memory:");
c.Open();

c.ExecuteScalar<string>("select @d", new { d = new DateOnly(2026, 9, 14) });
c.ExecuteScalar<string>("select @t", new { t = new TimeOnly(9, 30) });
c.QuerySingle<DateOnly>("select '2026-09-14'");
c.QuerySingle<Row>("select 'x' as Name, '2026-09-14' as Due");

public class Row { public string Name { get; set; } = ""; public DateOnly Due { get; set; } }
```

| Aufruf | 2.1.79 | 2.1.86 |
| --- | --- | --- |
| `DateOnly`-Parameter | `NotSupportedException`: kann nicht als Parameterwert verwendet werden | `2026-09-14` |
| `TimeOnly`-Parameter | `NotSupportedException` | `09:30:00` |
| `QuerySingle<DateOnly>` | `0001-01-01`, kein Fehler | `2026-09-14` |
| `DateOnly`-Member | `DataException`: Error parsing column 1 | `2026-09-14` |

Die Skalar-Zeile ist diejenige, die Ihnen Sorgen machen sollte, wenn Sie noch auf einer älteren Version sind: falsche Daten, keine Exception.

## Was mit Ihrem bestehenden Type Handler passiert

Der übliche Workaround war ein `SqlMapper.TypeHandler<DateOnly>`, der beim Start registriert wurde. Mit genau diesem Handler auf 2.1.86 zeigte mein Test, dass das eingebaute Mapping bei Parametern und `DateOnly`-Membern übernimmt: `SetValue` und `Parse` des Handlers wurden nie aufgerufen. Nur der Skalar-Pfad `QuerySingle<DateOnly>` rief noch `Parse` auf. Auf 2.1.79 lief derselbe Handler auf allen drei Pfaden.

Wenn Ihr Handler nur zwischen `DateOnly` und `DateTime` konvertiert hat, verlieren Sie nichts. Wenn er etwas Eigenes gemacht hat, etwa Datumswerte als `yyyyMMdd`-Strings oder Ganzzahlen zu schreiben, wird er auf dem Parameter-Pfad jetzt übersprungen, und die Datenbank erhält das, was der Provider aus einem rohen `DateOnly` macht. Testen Sie vor dem Upgrade.

## Geltungsbereich

Die Unterstützung ist für die Targets `net8.0` und `net10.0` im Paket kompiliert. Die Builds für `netstandard2.0` und `net461` enthalten sie nicht, und die Testsuite erwartet ausdrücklich nicht, dass sie mit dem veralteten `System.Data.SqlClient` funktioniert. Verwenden Sie `Microsoft.Data.SqlClient`.

Dasselbe Release stellt auch die Feeds auf MyGet und AppVeyor ein: Dapper veröffentlicht jetzt nur noch auf nuget.org, über Trusted Publishing (OIDC). Wenn eine `nuget.config` für Vorabversionen noch auf den alten MyGet-Feed zeigt, entfernen Sie den Eintrag.

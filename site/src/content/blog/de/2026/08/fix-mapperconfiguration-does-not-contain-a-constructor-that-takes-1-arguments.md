---
title: "Fehler beheben: 'MapperConfiguration' does not contain a constructor that takes 1 arguments"
description: "AutoMapper 15 hat den MapperConfiguration-Konstruktor mit nur einem Argument entfernt. Übergeben Sie eine ILoggerFactory als zweites Argument und ergänzen Sie jede AddAutoMapper-Aufrufstelle um eine Konfigurationsaktion."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "automapper"
  - "migration"
lang: "de"
translationOf: "2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments"
translatedBy: "claude"
translationDate: 2026-08-18
---

`new MapperConfiguration(cfg => ...)` kompiliert nicht mehr, weil AutoMapper 15.0 den Konstruktor mit einem einzigen Argument gelöscht hat. Übergeben Sie eine `ILoggerFactory` als zweites Argument: `new MapperConfiguration(cfg => ..., loggerFactory)`, in Tests `NullLoggerFactory.Instance`. Dasselbe Release hat außerdem jede `AddAutoMapper`-Überladung ohne Konfigurationsaktion gelöscht, sodass `services.AddAutoMapper(typeof(Program))` im selben Build mit einem anderen Fehlercode bricht.

Alles Folgende ist gegen AutoMapper 15.1.3 und 16.2.0 auf dem .NET SDK 10.0.201 mit Ziel `net10.0` verifiziert. Die Änderung kam mit [15.0.0 am 2025-07-02](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0) und ist in 16.2.0 immer noch die Form der API.

## Der Fehler im Kontext

```text
Repro.cs(11,26): error CS1729: 'MapperConfiguration' does not contain a constructor that takes 1 arguments
```

Wer AutoMapper über Dependency Injection registriert, bekommt im selben Build meist zwei weitere Fehler, die dasselbe Breaking Change in anderem Gewand sind:

```text
Repro.cs(15,32): error CS1503: Argument 2: cannot convert from 'System.Type' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
Repro.cs(16,32): error CS1503: Argument 2: cannot convert from 'System.Reflection.Assembly' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
```

Drei Fehler, eine Ursache. Nur den Konstruktor zu reparieren lässt den Build rot.

## Warum der Konstruktor mit einem Argument verschwunden ist

AutoMapper 15 hat einen Lizenzschlüssel und Protokollierung des Lizenzstatus ergänzt, und diese Protokollierung braucht ein Ziel. Statt zu einem statischen Logger oder einer Ambient-Senke zu greifen, haben die Maintainer die Abhängigkeit explizit gemacht: `MapperConfiguration` bekommt jetzt die `ILoggerFactory`, über die geschrieben wird. Jimmy Bogard [hat in Issue #4542 bestätigt](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542), dass es sich um ein beabsichtigtes Breaking Change handelt und dass es in den ursprünglichen Release Notes fehlte. Genau deshalb laufen so viele Leute hinein, ohne zu wissen, wonach sie suchen sollen.

Reflection über die ausgelieferten Assemblies macht den Unterschied konkret. AutoMapper 14.0.0 stellt bereit:

```text
// AutoMapper 14.0.0
MapperConfiguration.ctor(MapperConfigurationExpression)
MapperConfiguration.ctor(Action`1)
```

AutoMapper 15.1.3 und 16.2.0 stellen beide bereit:

```text
// AutoMapper 15.1.3 and 16.2.0
MapperConfiguration.ctor(MapperConfigurationExpression, ILoggerFactory)
MapperConfiguration.ctor(Action`1, ILoggerFactory)
```

Es gibt keine Überladung mit einem vorbelegten `ILoggerFactory`-Parameter, also lässt sich die alte Aufrufstelle nicht kompilierbar halten. Jede direkte Konstruktion muss angefasst werden.

## Minimales Repro

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;

public record Source(int Id, string Name);
public record Dest(int Id, string Name);

public class Repro
{
    public void OldStyle()
    {
        // error CS1729
        var config = new MapperConfiguration(cfg => cfg.CreateMap<Source, Dest>());
        var mapper = config.CreateMapper();
    }
}
```

Eine `csproj` mit nichts weiter als `<PackageReference Include="AutoMapper" Version="15.1.3" />` reproduziert das. Beachten Sie: das ist ausschließlich ein Bruch zur Kompilierzeit. An der Mapping-Engine hat sich nichts geändert, sobald die Aufrufstellen kompilieren, verhalten sich Ihre Mappings exakt wie unter 14.

## Was übergebe ich als ILoggerFactory außerhalb von Dependency Injection?

Für statische Mapper-Konfigurationen, Test-Fixtures und Konsolenwerkzeuge ohne Host ist `NullLoggerFactory.Instance` aus `Microsoft.Extensions.Logging.Abstractions` die richtige Antwort. AutoMapper hängt bereits von `Microsoft.Extensions.Logging.Abstractions` ab, es kommt also kein neues Paket hinzu.

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;
using Microsoft.Extensions.Logging.Abstractions;

public static class Maps
{
    public static readonly MapperConfiguration Config = new(
        cfg =>
        {
            cfg.LicenseKey = "<your key>";
            cfg.AddProfile<MyProfile>();
        },
        NullLoggerFactory.Instance);

    public static readonly IMapper Mapper = Config.CreateMapper();
}
```

Eine statische `MapperConfiguration` ist weiterhin ein unterstütztes Muster. Das war die zweite Sorge in Issue #4542, und Bogard hat direkt geantwortet: eine statische Instanz ist in Ordnung, und der Lizenzschlüssel kann aus `IConfiguration` oder einem Secret Store kommen, statt als Literal einbetoniert zu werden.

`AssertConfigurationIsValid()` hängt weiterhin genau wie bisher am Konfigurationsobjekt, Validierungstests brauchen also außer dem Konstruktor keine Änderungen:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
[Fact]
public void Mapping_configuration_is_valid()
{
    var config = new MapperConfiguration(
        cfg => cfg.AddProfile<MyProfile>(),
        NullLoggerFactory.Instance);

    config.AssertConfigurationIsValid();
}
```

Wer die Lizenzdiagnose in einem Testlauf sehen möchte, tauscht `NullLoggerFactory.Instance` gegen eine echte Factory. Mehr macht der Parameter nicht.

## Wie repariere ich die AddAutoMapper-Aufrufe, die gleichzeitig gebrochen sind?

Jede `AddAutoMapper`-Überladung ohne Konfigurationsaktion wurde in 15.0 gelöscht. Ein Vergleich der öffentlichen statischen Methoden auf `Microsoft.Extensions.DependencyInjection.ServiceCollectionExtensions` über die Versionen hinweg zeigt, dass diese drei verschwunden sind:

```text
// Present in AutoMapper 14.0.0, gone in 15.0.0 and later
AddAutoMapper(IServiceCollection, Assembly[])
AddAutoMapper(IServiceCollection, Type[])
AddAutoMapper(IServiceCollection, IEnumerable<Assembly>, ServiceLifetime)
```

Die Konfigurationsaktion ist damit verpflichtend und steht immer an zweiter Stelle:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3, ASP.NET Core minimal host
var builder = WebApplication.CreateBuilder(args);

// Before (AutoMapper 14):
// builder.Services.AddAutoMapper(typeof(Program));

// After:
builder.Services.AddAutoMapper(
    cfg => cfg.LicenseKey = builder.Configuration["AutoMapper:LicenseKey"],
    typeof(Program));
```

Hat die Aktion nichts zu sagen, ist ein leeres Lambda zulässig: `services.AddAutoMapper(_ => { }, typeof(Program))`. Sie bleibt positionell verpflichtend.

Der Dependency-Injection-Pfad liefert die `ILoggerFactory` mit, es gibt dort also keine `MapperConfiguration`, die von Hand zu bauen wäre. Es lohnt sich zu wissen, was registriert wird, denn die Lebensdauern sind asymmetrisch:

```text
// Registered by AddAutoMapper, AutoMapper 15.1.3
AutoMapper.IConfigurationProvider -> Singleton
AutoMapper.IMapper               -> Transient
```

Das teure Objekt, die kompilierte Konfiguration, ist das Singleton. `IMapper` ist ein billiger transienter Wrapper darüber, weshalb das Injizieren von `IMapper` in scoped und transiente Services nichts kostet und nicht in das [Captive-Dependency-Problem eines scoped Service aus einem Singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) läuft.

Es gibt außerdem eine Überladung, die Ihnen den `IServiceProvider` reicht. Nützlich, wenn der Schlüssel hinter einem Service statt hinter roher Konfiguration liegt:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
services.AddAutoMapper(
    (sp, cfg) => cfg.LicenseKey = sp.GetRequiredService<ILicenseStore>().AutoMapperKey,
    typeof(MyProfile));
```

## Was tun, wenn direkt danach 'No service for type ILoggerFactory has been registered' auftaucht?

Der Konstruktor ist repariert, der Build wird grün, und ein Test fliegt zur Laufzeit auseinander:

```text
System.InvalidOperationException: No service for type 'Microsoft.Extensions.Logging.ILoggerFactory' has been registered.
```

Das ist die DI-Registrierung, die nach der Logger-Factory greift, die AutoMapper jetzt braucht. In einer ASP.NET Core Anwendung sehen Sie das nie, weil der `WebApplicationBuilder` die Protokollierung verdrahtet, bevor Sie überhaupt `AddAutoMapper` aufrufen können. Sie sehen es in Unit-Tests und kleinen Konsolenanwendungen, die eine nackte `ServiceCollection` bauen:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - throws on resolve
var services = new ServiceCollection();
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

Eine Zeile behebt es:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - resolves
var services = new ServiceCollection();
services.AddLogging();                       // this is the missing piece
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

Die Fehlermeldung ist generisch genug, dass Leute sie als eigenständigen Bug jagen, genauso wie [eine fehlende DbContextOptions-Registrierung](/de/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) die Suche in die falsche Datei lenkt. Wenn sie im selben Commit auftauchte, der Sie auf AutoMapper 15 gehoben hat, ist es das hier.

## Was tatsächlich passiert, wenn Sie nie einen Lizenzschlüssel setzen

Nichts bricht. AutoMapper 15.1.3 mappt Objekte völlig zufrieden ohne Schlüssel, mit ungültigem Schlüssel oder mit leerer Zeichenkette. Was Sie bekommen, ist eine Log-Meldung in der Kategorie `LuckyPennySoftware.AutoMapper.License`:

```text
warn: LuckyPennySoftware.AutoMapper.License[0]
      You do not have a valid license key for the Lucky Penny software AutoMapper. This is allowed for
      development and testing scenarios. If you are running in production you are required to have a
      licensed version. Please visit https://luckypennysoftware.com to obtain a valid license.
```

Das ist der gesamte Durchsetzungsmechanismus, und deshalb musste der `ILoggerFactory`-Parameter existieren. Die Dokumentation sagt ausdrücklich, dass es außer Log-Meldungen keine weitere Lizenzdurchsetzung gibt. Das ist eine rechtliche Verpflichtung, keine technische Sperre, behandeln Sie die Warnung also als Compliance-Punkt und nicht als Laufzeitproblem, das man stummschaltet.

Ein Detail, das Leute einen Nachmittag kostet: ein fehlerhaft geformter Schlüssel wird vor der Warnung auf Stufe kritisch protokolliert, mit einem JWT-Parse-Fehler, denn der Schlüssel ist ein signiertes JWT:

```text
crit: LuckyPennySoftware.AutoMapper.License[0]
      Error validating the Lucky Penny software license key
      Microsoft.IdentityModel.Tokens.SecurityTokenMalformedException: IDX14100: JWT is not well formed,
      there are no dots (.).
```

Wenn Ihre Log-Pipeline bei `Critical` alarmiert, weckt ein abgeschnittener oder durch Leerzeichen verstümmelter Schlüssel in einer Umgebungsvariable jemanden, während die Anwendung weiterhin korrekt arbeitet. Suchen Sie nach dieser Zeichenkette, bevor Sie annehmen, AutoMapper sei kaputt.

Zwei weitere praktische Hinweise zum Schlüssel. Erstens ist `cfg.LicenseKey` nicht der einzige dokumentierte Weg: die Dokumentation nennt die Umgebungsvariablen `AUTOMAPPER_LICENSE_KEY` und `LUCKYPENNY_LICENSE_KEY`, aufgelöst in dieser Reihenfolge nach dem expliziten Wert im Code. In meinen Tests auf 15.1.3 wurde keine der beiden Umgebungsvariablen berücksichtigt, denn ein absichtlich fehlerhafter Wert in jeder von beiden erzeugte nur die generische Unlizenziert-Warnung und nie den JWT-Parse-Fehler, den ein explizites `cfg.LicenseKey` auslöst. Setzen Sie den Schlüssel auf der 15.x-Linie im Code und lesen Sie ihn aus der Konfiguration. Zweitens hat AutoMapper 16.2.0 im selben Test überhaupt keine Lizenzmeldung protokolliert, lesen Sie das Ausbleiben einer Warnung also nicht als Beleg dafür, dass ein Schlüssel akzeptiert wurde.

## Sollten Sie stattdessen auf AutoMapper 14 festpinnen?

Das ist der am häufigsten vorgeschlagene Workaround in den Issue-Threads, und seit 2026-03 ist er schlecht. AutoMapper 14.0.0 und alles unterhalb von 15.1.1 tragen [GHSA-rvv3-g6hj-g44x](https://github.com/advisories/GHSA-rvv3-g6hj-g44x), ein Problem unkontrollierter Rekursion mit hoher Schwere (CVSS 7.5): das Mappen eines tief verschachtelten oder selbstreferenziellen Objektgraphen erschöpft den Stack und reißt den Prozess mit einer nicht abfangbaren `StackOverflowException` herunter. Erreicht nicht vertrauenswürdige Eingabe einen gemappten Typ, ist das ein Denial of Service. Ein Zurücksetzen auf 14.0.0 erzeugt heute bei jedem Build:

```text
warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability,
https://github.com/advisories/GHSA-rvv3-g6hj-g44x
```

Der Fix kam in 15.1.1 und 16.1.1, beide im 2026-03 veröffentlicht. Die echte Wahl steht also zwischen 15.1.3 und 16.2.0, nicht zwischen 15 und 14. Beide nehmen denselben Konstruktor, die oben beschriebene Migrationsarbeit ist also in beiden Fällen identisch.

Wer lieber gar nicht für einen Mapper zahlen möchte, trifft diese Entscheidung unabhängig von diesem Kompilierfehler und besser in Ruhe als unter Build-Druck. Die Abwägungen stehen im Durchgang zu [Von AutoMapper zu Source-Generator-Mapping mit Mapperly migrieren](/de/2026/05/migrate-from-automapper-to-source-generated-mapping/), und dieselbe Frage kommerzieller Lizenzierung wurde für eine andere Bibliothek von Bogard in [MediatR vs einfache Service-Klassen](/de/2026/05/mediatr-vs-plain-service-classes-in-2026/) durchgespielt.

## Was sich in AutoMapper 16 erneut ändert

Nichts, was Sie anfassen müssen. Die Konstruktorform und die `AddAutoMapper`-Signaturen sind zwischen 15.1.3 und 16.2.0 identisch, für 15 reparierter Code kompiliert unverändert auf 16. Die Unterschiede liegen im Packaging:

- 15.x zielt auf `net8.0`, `net9.0` und `netstandard2.0`.
- 16.x ergänzt `net10.0` und `net471` und hebt seine `Microsoft.Extensions.*`-Abhängigkeiten von 8.0.0 auf 10.0.0.

Wer bereits auf .NET 10 ist, vermeidet mit 16.2.0, die 8.0.0-Extension-Pakete in den Graphen zu ziehen. Wer auf .NET 8 mit einem festgezurrten transitiven Abhängigkeitssatz feststeckt, sitzt mit 15.1.3 auf einem unterstützten, gepatchten Stand. Beide liegen hinter dem Sicherheitsfix, und das Upgrade selbst ist in beiden Fällen dieselbe Änderung in drei Zeilen: Logger-Factory ergänzen, Konfigurationsaktion ergänzen, entscheiden wo der Schlüssel liegt.

## Verwandte Beiträge

- [Von AutoMapper zu Source-Generator-Mapping mit Mapperly migrieren](/de/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [MediatR vs einfache Service-Klassen in 2026: Sollte Sie die Lizenzänderung umstimmen?](/de/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Fix: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered](/de/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)
- [Fehler beheben: Cannot consume scoped service 'X' from singleton 'Y'](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Von EF Core 6 auf EF Core 11 migrieren: die Breaking Changes, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Quellen

- [AutoMapper 15.0 Upgrade Guide](https://docs.automapper.io/en/stable/15.0-Upgrade-Guide.html)
- [Release Notes zu AutoMapper v15.0.0](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0)
- [Issue #4542: MapperConfiguration single argument constructor](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542)
- [Dokumentation zur AutoMapper-Lizenzkonfiguration](https://docs.automapper.io/en/stable/License-configuration.html)
- [Dokumentation zu Dependency Injection in AutoMapper](https://docs.automapper.io/en/stable/Dependency-injection.html)
- [GHSA-rvv3-g6hj-g44x: unkontrollierte Rekursion in AutoMapper](https://github.com/advisories/GHSA-rvv3-g6hj-g44x)

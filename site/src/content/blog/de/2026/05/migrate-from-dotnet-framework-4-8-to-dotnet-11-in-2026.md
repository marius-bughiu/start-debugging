---
title: "Migration von .NET Framework 4.8 zu .NET 11 im Jahr 2026"
description: "Migration von .NET Framework 4.8 mit korrektem Supportstatus, inkrementellen ASP.NET-Grenzen, Abhängigkeiten, Konfiguration und Rollback planen."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "de"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Korrektur — 2. November 2026:** Korrigiert wurden Releasestatus und Support von .NET 11, Framework-Lebenszyklus, Konfigurationsbindung, Serialisierung, Werkzeuge und Bereitstellung. Unbelegte Angaben zu Dauer, Speicherersparnis und angeblich selbst erlebten Problemen wurden entfernt.

Der Wechsel von .NET Framework 4.8 zu modernem .NET kann einen neuen Anwendungshost sowie Änderungen an Bibliotheken, Bereitstellung und Datenverträgen erfordern. Es ist kein In-Place-Runtime-Update. Klären Sie zuerst den Anlass und welche Teile unabhängig umziehen können.

Zum Prüfdatum ist [.NET 11 RC3 eine Go-live-Vorabversion](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), .NET 11 eine STS-Linie und .NET 10 die veröffentlichte LTS-Option. [Framework-Support folgt dem jeweiligen Windows-Produkt](https://learn.microsoft.com/en-us/lifecycle/faq/dotnet-framework). Es gibt kein einheitliches Framework-4.8-Enddatum für sämtliche Windows-10-Installationen. Prüfen Sie das tatsächliche Betriebssystem und dessen unterstützte Framework-Version.

## Vor Änderungen inventarisieren

Bauen und testen Sie die bestehende Anwendung in ihrer unterstützten Windows-Umgebung. Halten Sie Entwickler-/Referenzpakete und Buildwerkzeuge während der Migration verfügbar. Erfassen Sie Authentifizierung, Sitzungen, Windows-Integration, native Bibliotheken, Jobs, Datenbankprovider und gespeicherte Formate. Ob ein `net48`-Paket weiterverwendbar ist, hängt von APIs und Assets ab.

Die [Upgrade-Assistant-Übersicht](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) bezeichnet das Werkzeug inzwischen als veraltet und verweist auf den GitHub-Copilot-Modernisierungsagenten. Automatisierte Unterstützung ist optional; prüfen und testen Sie deren Änderungen. Ein alter unfixierter Installationsbefehl garantiert keine .NET-11-Unterstützung.

Trennen Sie nach Möglichkeit Projektformatbereinigung und Runtime-Wechsel. SDK-Stil übersetzt weder `System.Web` noch WCF-Hosting, COM-Abhängigkeiten oder eigene MSBuild-Tasks. Bewahren Sie einen funktionierenden Ausgangszustand und migrieren Sie Blattbibliotheken vor ihren Aufrufern.

## Migrationsgrenze wählen

| Bestehende Abhängigkeit | Einzuplanende Arbeit |
| --- | --- |
| ASP.NET MVC 5 / Web API 2 | Routen, Filter, Binding, Authentifizierung, Sitzungen und Hosting anpassen |
| Web Forms / System.Web | Hinter einer inkrementellen Grenze behalten oder UI ersetzen; ASP.NET Core führt Web Forms nicht aus |
| WCF-Server | CoreWCF für tatsächliche Bindings/Funktionen prüfen oder Vertrag neu entwerfen |
| WCF-Client | Aktuelle System.ServiceModel-Pakete und Sicherheitsanforderungen prüfen |
| EF6 | Moderne Runtime und Provider prüfen; EF Core separat planen |
| WPF / WinForms | Windows-Ziele, Controls, COM/native Komponenten und Deployment prüfen |
| Weitere AppDomains / Remoting / CAS | Laden, Kommunikation und Isolation neu entwerfen |

Microsofts [ASP.NET-Migrationsleitfaden](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/?view=aspnetcore-10.0) unterstützt inkrementelles Vorgehen. Routen hinter einem Proxy erlauben den Weiterbetrieb alter Teile. Eine Teilmigration ist sinnvoll, wenn Authentifizierung, Routing, Datenverantwortung und Rollback bewusst geregelt sind.

[CoreWCF](https://github.com/CoreWCF/CoreWCF) garantiert keine vollständige WCF-Kompatibilität. Testen Sie Ihre Bindings und Authentifizierung. [EF6 unterstützt modernes .NET seit 6.3](https://learn.microsoft.com/en-us/ef/ef6/what-is-new/); wählen und testen Sie eine aktuelle kompatible Version samt Provider, statt 6.5.0 als universelle Mindestversion anzunehmen. EF Core ist kein direkter Ersatz für EF6.

## Mit einem kleinen funktionierenden Teil beginnen

Ein ASP.NET-Core-Evaluierungsprojekt für .NET 11 hat diese Grundstruktur:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Verwenden Sie ein installiertes, bewusst gewähltes SDK und kompatible Pakete. Die [.NET-8-zu-11-Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) zeigt den aktuellen RC3-Pin. Desktopprojekte benötigen dagegen passende Windows-TFMs und Einstellungen; ersetzen Sie nicht jedes Projekt durch `Microsoft.NET.Sdk.Web`.

Dieses vollständige `Program.cs` ist ein Smoke-Test, keine migrierte Anwendung:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

Es wurde bei dieser Korrektur unter .NET 8 und 10 gebaut, veröffentlicht und aufgerufen. Eine MVC-Anwendung muss Controller registrieren, bevor sie diese abbildet. Authentifizierung benötigt ein tatsächliches Schema und Dienste; `UseAuthentication()` allein migriert keine Forms Authentication.

## Konfiguration und Datensemantik erhalten

Ein kleines `appsettings.json`:

```json
{
  "Migration": {
    "MaxRetries": 3
  }
}
```

Der [.NET-JSON-Konfigurationsprovider ignoriert Groß-/Kleinschreibung bei Schlüsseln](https://learn.microsoft.com/en-us/dotnet/core/extensions/configuration-providers). Das ist von allgemeinen JSON-Serialisierungsregeln zu unterscheiden. Prüfen Sie Providerreihenfolge und Geheimnisspeicherung. XML-Unterstützung bildet nicht automatisch alle `app.config`-Abschnitte oder Binding Redirects nach. `System.Configuration.ConfigurationManager` kann für unterstützte APIs eine Kompatibilitätsoption sein; nicht jede Verwendung muss entfernt werden. Bei IIS bleibt `web.config` relevant.

Die eingebaute `BinaryFormatter`-Implementierung wirft ab .NET 9, der Typ bleibt jedoch erhalten. Nutzen Sie einen unterstützten Serializer oder prüfen Sie den [NRBF-Reader](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) zum Lesen alter Daten ohne Instanziierung beliebiger kodierter Typen. Konvertierung erfordert nicht zwingend den alten unsicheren Deserializer unter Framework 4.8.

`AssemblyLoadContext` ermöglicht Laden und kooperatives Entladen, ersetzt aber keine AppDomain-Sicherheitsgrenze. Referenzen, laufender Code und Ereignishandler können das Entladen verhindern. Ein einzelner GC-Lauf beweist keinen Erfolg. Unvertrauenswürdiger Code benötigt eine geeignete Prozess-/Containergrenze mit passenden Berechtigungen.

Lassen Sie Zertifikatsvalidierung aktiv. Prüfen Sie Zertifikat, Hostname, Vertrauenskette, SQL-Client-Einstellungen und Plattform bei TLS-Fehlern. Akzeptieren Sie nicht pauschal jedes Zertifikat. Testen Sie konkrete Datumsformate, Kulturen und Serialisierungsverträge statt einer unbelegten allgemeinen Parsing-Änderung in .NET 11.

## Bereitstellung und Rollback üben

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

Der Publish-Befehl erzeugt ausdrücklich eine frameworkabhängige Anwendung. Self-contained erfordert `--self-contained true` und einen geeigneten RID; es ist keine automatische Folge von `dotnet publish`. Behalten Sie Windows-CI für verbleibende Framework-Projekte und prüfen Sie moderne Artefakte auf der Zielplattform.

Testen Sie auch verweigerte Zugriffe, Sitzungen, Datenbankänderungen, Nachrichten, Hintergrundarbeit und Desktopintegration. Halten Sie das alte Deployment bereit, ändern Sie Schema und Daten abwärtskompatibel und üben Sie die Rückschaltung. Rollback benötigt alte Anwendung und Konfiguration, nicht bloß die Neuinstallation der Framework-Runtime.

**Prüfgrenzen:** Keine Windows-/Framework-Anwendung, kein .NET-11-SDK, kein WCF-Dienst, keine EF-Provider-Migration und kein Produktionsdeployment wurden hier getestet. Portabler Endpunkt und Konfigurationsschlüssel wurden unter .NET 8 und 10 geprüft. Aufwand und Leistung müssen anhand Ihres eigenen repräsentativen Teilprojekts geschätzt werden.

## Weitere Primärquellen

- [AssemblyLoadContext](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext)
- [.NET Framework technologies unavailable on .NET](https://learn.microsoft.com/en-us/dotnet/core/porting/net-framework-tech-unavailable)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)

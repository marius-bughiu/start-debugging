---
title: "Von .NET 8 auf .NET 11 migrieren: die vollständige Checkliste"
description: "Migration von .NET 8 mit aktuellem .NET-11-RC3-Status, exaktem SDK-Pin, Kompatibilitätsprüfung, Deployment und Rollback planen."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "de"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

**Korrektur — 2. November 2026:** .NET 11 wurde fälschlich als veröffentlichte LTS-Version bezeichnet. Korrigiert wurden außerdem SDK-Pinning, Paketauswahl, Hosting, Serialisierung, EF-Abfragen, Sperren und Rollback. Frühere Aussagen über Migrationsergebnisse waren nicht durch dokumentierte Tests belegt.

Der Support für .NET 8 endet am **10. November 2026**. Die [aktuelle Supportrichtlinie](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) nennt .NET 10 als LTS und .NET 11 RC3 als Go-live-Vorabversion. .NET 11 ist eine STS-Linie. Für ein bereits veröffentlichtes LTS-Ziel prüfen Sie .NET 10. Wenn Sie .NET 11 benötigen, berücksichtigen Sie dessen aktuellen Status und planen Sie das nächste Servicing-Update. Ein SDK-Upgrade aktualisiert keine bereits bereitgestellte Anwendung.

## 1. Ausgangszustand erfassen und SDK auswählen

Dokumentieren Sie produktive Runtime, Build-SDK, Betriebssystem, Paketgraph, Tests und repräsentatives Verhalten. Ein grüner Ausgangstest hilft bei der Fehlersuche, beweist aber nicht, dass jeder spätere Fehler durch die Migration entsteht.

```bash
dotnet --info
dotnet --list-sdks
dotnet --version
dotnet list package --include-transitive
dotnet test -c Release
```

Führen Sie die Befehle mit dem vorgesehenen SDK im Lösungsverzeichnis aus. Die [SDK-Auswahl](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) ist unabhängig vom Zielframework. Für eine Evaluierung mit der vollständigen RC3-Version der [Downloadseite](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) lautet `global.json`:

```json
{
  "sdk": {
    "version": "11.0.100-rc.3.26522.148",
    "rollForward": "disable",
    "allowPrerelease": true
  }
}
```

`disable` verlangt genau dieses SDK; `latestFeature` erlaubt spätere Feature-Bänder. Installieren Sie dasselbe SDK auf CI. Dieser RC3-Pin wurde anhand veröffentlichter Metadaten geprüft, aber nicht installiert oder ausgeführt. Aktualisieren Sie ihn bei einem Versionswechsel bewusst.

## 2. Zielframework und Abhängigkeiten einzeln prüfen

Die Grundstruktur eines Webprojekts ist:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Das ist eine Projektdefinition für .NET 11, kein hier unter .NET 11 getestetes Projekt. Lassen Sie die Sprachversion beim SDK/TFM-Standard, sofern kein konkreter Grund zum Pinning besteht. C# 14 gehört zu .NET 10 und ist nicht die neue Sprachversion von .NET 11.

Aktualisieren Sie **nicht sämtliche `Microsoft.*`-Pakete auf Version 11**. Produkte haben eigene Versionslinien. Prüfen Sie Zielframeworks, Abhängigkeiten, Provider und Releasestatus pro Paket. Stimmen Sie EF-Core-Pakete, Provider, Designpaket und Werkzeuge gemäß deren Dokumentation ab. Bei zentraler Paketverwaltung prüfen Sie `Directory.Packages.props`. Ein `net8.0`-Paket kann kompatibel bleiben; NuGet bevorzugt nicht automatisch ältere .NET-Standard-Assets, nur weil das Ziel neuer ist.

## 3. Alle dazwischenliegenden Änderungen prüfen

Lesen Sie die Kompatibilitätslisten für [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/compatibility/9.0), [.NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10.0) und [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11) sowie die Hinweise Ihrer Frameworks und Provider. Die .NET-11-Liste ist ausdrücklich noch unvollständig.

- **BinaryFormatter:** Seit .NET 9 wirft die eingebaute Implementierung eine Ausnahme; die API-Typen existieren weiter. Bevorzugen Sie ein anderes Format. Der [Migrationsleitfaden](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) beschreibt auch das Lesen von NRBF ohne Instanziierung beliebiger serialisierter Typen. Die Konvertierung erfordert nicht grundsätzlich eine alte .NET-8-Anwendung.
- **Hosting:** `WebHostBuilder`, `IWebHost` und `WebHost` wurden [in .NET 10 als veraltet markiert](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/webhostbuilder-deprecated?view=aspnetcore-10.0). Daraus folgt nicht, dass sämtlicher Code mit `IWebHostBuilder` oder `ConfigureWebHostDefaults` entfernt wurde. Nutzen Sie für neuen Code vorzugsweise `WebApplication.CreateBuilder` und bearbeiten Sie konkrete Diagnosen.
- **EF-Abfragen:** Bei SQL Server führte EF8 JSON-Parameter für Collections ein; [EF10 verwendet standardmäßig skalare Parameter](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection). Prüfen Sie SQL und Pläne mit dem echten Provider. Pauschales `ToList()` kann Arbeit in den Speicher verlagern und ist keine allgemeine Reparatur.
- **Serialisierung und Compiler:** Testen Sie reale JSON-Verträge, Datumswerte, Zahlen, Enums und Polymorphie. Untersuchen Sie konkrete Diagnosen einschließlich Span-Konvertierungen, statt anzunehmen, dass jede Span-Überladung eine Array-Überladung verdrängt.
- **Sperren:** `System.Threading.Lock` und Monitor sind beide reentrant. Ein statisch als `Lock` typisierter Ausdruck verwendet einen anderen Mechanismus als eine nach `object` gecastete Referenz. Vermischen Sie beide nicht für denselben geschützten Zustand. Ein Austausch ist keine Voraussetzung für das Retargeting.
- **Hostingdienste:** Azure Functions besitzt eine eigene [Supportmatrix](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide#supported-versions). Bei dieser Prüfung ist .NET 10 das höchste Isolated-Worker-Ziel; In-Process-Support endet am 10. November 2026. Ein verfügbares SDK beweist keine Unterstützung für .NET 11.

## 4. Das bereitgestellte Artefakt prüfen

Dieses vollständige `Program.cs` stellt einen kleinen Smoke-Endpunkt bereit. Es konfiguriert weder produktive Authentifizierung noch Controller oder Datenbank:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

Das Beispiel wurde unter .NET 8.0.33 und 10.0.10 gebaut, veröffentlicht und erfolgreich aufgerufen. `--self-contained false` erfordert eine kompatible Runtime auf dem Host. Für Self-contained wählen Sie einen tatsächlichen Ziel-RID und `--self-contained true`; prüfen Sie das Artefakt auf dem Zielbetriebssystem. `/health` entsteht in beliebigen Projekten nicht automatisch.

Prüfen Sie zusätzlich Authentifizierung, Autorisierung, Lese-/Schreibverträge, Transaktionen, Hintergrundaufgaben und Rollback in Staging. Messen Sie mit einer vereinbarten Last. Bei Trimming/AOT beheben Sie konkrete Publish-Warnungen und starten das veröffentlichte Ergebnis; Annotationen machen beliebige Laufzeit-Codegenerierung nicht Native-AOT-kompatibel.

## 5. Rollback kompatibel halten

Bewahren Sie das alte Artefakt und seine Konfiguration auf. Schema, gespeicherte Daten, Nachrichten und Authentifizierungszustand bestimmen, ob beide Versionen nebeneinander funktionieren. Der erste Schreibvorgang verhindert Rollback nicht automatisch; ein SDK-Wechsel erzeugt keine Datenbankmigration. Verwenden Sie kompatible Schemaänderungen und üben Sie die Rückschaltung vor dem Wechsel.

**Prüfgrenzen:** Keine .NET-11-Migration, EF-/Datenbankaktualisierung, Azure-Bereitstellung oder Leistungsmessung wurde durchgeführt. Das portable Beispiel und ausgewählte Korrekturen wurden unter .NET 8/10 getestet; versionsspezifische Hinweise anhand primärer Dokumentation geprüft.

## Weitere Primärquellen

- [System.Threading.Lock](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# 14 span overload resolution](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)

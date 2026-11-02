---
title: "Der .NET 11 Tracker"
description: "Stand von .NET 11 RC3, Support, Laufzeitänderungen und Migrationsprüfungen mit Leitfäden zu Integrationstests, EF Core und Request-Logging."
tagline: "Ein Bookmark für den gesamten .NET 11 Zyklus."
pubDate: 2026-04-18
updatedDate: 2026-11-02
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
lang: "de"
translationOf: "dotnet-11-tracker"
---

Am 2. November 2026 ist **.NET 11 RC3** der aktuelle Release Candidate. Microsoft veröffentlichte ihn am 25. Oktober als [außerplanmäßiges Sicherheitsupdate](https://devblogs.microsoft.com/dotnet/dotnet-october-2026-oob-security-updates/). Die [Support-Richtlinie](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) nennt den Go-live-Status und das Supportfenster. .NET 11 ist ein STS-Release (Standard Term Support). Beim Wechsel von .NET 8 LTS ist dieser Unterschied für den nächsten Upgrade-Termin relevant.

**Korrektur, 2. November 2026.** Die frühere englische Fassung nannte RC2 als neuesten Stand und bezeichnete den Wechsel von .NET 8 auf 11 als LTS-zu-LTS. Der Index verwendet jetzt .NET-11-Tags, damit Beiträge zu anderen Versionen nicht allein über ein allgemeines .NET-Tag erscheinen.

## Release und Laufzeit

Für RC2 siehe [inkrementelles CBOR-Parsen](/de/2026/10/dotnet-11-rc-2-cborreader-reads-cbor-incrementally/). Zu RC1 gehören [reproduzierbare Container-Images](/de/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/), [Prozesssignale](/de/2026/09/dotnet-11-rc-1-process-signal-exit-status/) und [SignalR-Authentifizierung](/de/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/). Laufzeitthemen sind [Devirtualisierung generischer Methoden](/de/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/), [Aufrufkonventionen für Structs](/de/2026/10/what-is-transparent-struct-layout-and-why-does-a-single-field-wrapper-struct-change-the-calling-convention-in-dotnet/) und [CPU-Kompatibilität](/de/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/).

## Ein Upgrade planen und prüfen

Beginnen Sie mit der [Checkliste für .NET 8](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) oder dem [Leitfaden für .NET Framework 4.8](/de/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/). In größeren Lösungen sind [SDK-Auswahl](/de/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/) und [zentrale Paketverwaltung](/de/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) wichtig. Beim Wechsel des Test-Runners helfen [Microsoft.Testing.Platform](/de/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/), [Exitcode 5](/de/2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform/) und [VSTest-Fallback](/de/2026/10/fix-dotnet-test-falls-back-to-vstest-in-linux-ci-microsoft-testing-platform/).

Mit [WebApplicationFactory und Testcontainers](/de/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) entscheiden Sie, welches HTTP- und Datenbankverhalten ein Integrationstest abdecken soll. Bei Datenmigrationen zeigt die [Enum-zu-String-Konvertierung](/de/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), weshalb numerische Zeichenfolgen und Namen zu anderen Abfrageergebnissen führen können. Für die Nachverfolgung authentifizierter Requests siehe [Benutzer-ID im Logging](/de/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/).

## Themenindex

Der chronologische Index wählt Beiträge mit .NET-11-Versionstags aus. Spezifische Referenzen bieten [EF Core 11](/de/pillars/efcore-11-cheat-sheet/) und [C# 14](/de/pillars/csharp-14-features/).

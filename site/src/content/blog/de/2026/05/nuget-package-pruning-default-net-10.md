---
title: "NuGet Package Pruning ist in .NET 10 standardmäßig aktiviert"
description: "NuGet Package Pruning ist für net10.0-Projekte standardmäßig aktiviert und reduziert transitive Schwachstellenmeldungen um 70% sowie Restore-Zeiten um bis zu 50%."
pubDate: 2026-05-20
tags:
  - "dotnet"
  - "dotnet-10"
  - "nuget"
  - "security"
lang: "de"
translationOf: "2026/05/nuget-package-pruning-default-net-10"
translatedBy: "claude"
translationDate: 2026-05-20
---

Nikolche Kolev hat [angekündigt](https://devblogs.microsoft.com/dotnet/nuget-package-pruning-in-dotnet-10/), dass NuGet Package Pruning für jedes Projekt mit dem Ziel `net10.0` oder höher standardmäßig aktiviert ist. Die Änderung kommt mit dem .NET 10 SDK und setzt einen Default zurück, der seit Jahren still für lauten Output von `dotnet list package --vulnerable` gesorgt hat: Die Laufzeit-Bibliotheken sind bereits im Shared Framework enthalten, sie erneut als NuGet-Abhängigkeiten zu listen erzeugt lediglich Phantom-CVEs.

## Was Pruning tatsächlich entfernt

Das .NET SDK liefert pro Target Framework ein Manifest der Pakete, die die Laufzeit bereits bereitstellt, zusammen mit der höchsten Version, die jedes Framework liefert. Während des Restore verwirft NuGet jedes transitive Paket, dessen Version gleich oder niedriger als die der Laufzeit ist. Direkte Referenzen werden nicht gelöscht, sondern mit `PrivateAssets='all'` und `IncludeAssets='none'` umgeschrieben, damit die Laufzeit-Kopie gewinnt, und NuGet gibt die neue Warnung **NU1510** aus, wenn die Referenz vollständig redundant ist.

Der Blog nennt zwei konkrete Zahlen: 70% weniger transitive Schwachstellenmeldungen für Projekte mit den neuen Defaults und bis zu 50% geringere Restore-Zeit pro Projekt, sobald der Graph aufhört, Paketen nachzujagen, die die Laufzeit bereits besitzt.

## Was standardmäßig aktiv ist

In einem `net10.0`-Projekt verhält sich das SDK nun so, als hätten Sie geschrieben:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>true</RestoreEnablePackagePruning>
  <NuGetAuditMode>all</NuGetAuditMode>
</PropertyGroup>
```

`NuGetAuditMode=all` wechselt ebenfalls von `direct` zu `all`, sodass die verbleibende transitive Menge weiterhin auditiert wird. Pruning und Audit sind so gestaltet, dass sie sich ergänzen: Pruning reduziert den Graphen auf das, was tatsächlich zusätzlich zur Laufzeit ausgeliefert wird, und das Audit läuft gegen diesen kleineren Graphen.

In einem Projekt mit mehreren Zielen wird das Pruning auf jedes TFM angewendet, sobald ein TFM `net10.0` oder höher ist. Das vermeidet die Überraschung, dass ein Head still anders restored als ein anderer.

## Ein konkretes Vorher / Nachher

Ein häufiges Muster ist eine Konsolenanwendung, die `Microsoft.Extensions.AI` und `NuGet.Protocol` einbindet. Unter .NET 9 würde `System.Formats.Asn1 6.0.0` im Audit-Output über einen tiefen transitiven Pfad erscheinen, obwohl `net10.0` ein neueres `System.Formats.Asn1` im Shared Framework liefert. Nach dem Anheben des TFM:

```xml
<TargetFramework>net10.0</TargetFramework>
```

`System.Formats.Asn1`, `System.Diagnostics.DiagnosticSource`, `System.Text.Json` und `System.Threading.Channels` verschwinden aus dem aufgelösten Graphen. Ihre CVE-Einträge erscheinen nicht mehr in `dotnet list package --vulnerable`, weil sie ohnehin nie zur Laufzeit geladen worden wären.

## Deaktivieren

Beide Notausstiege existieren:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>false</RestoreEnablePackagePruning>
  <NuGetAuditMode>direct</NuGetAuditMode>
</PropertyGroup>
```

Das tun Sie in einer Bibliothek, die für Konsumenten älterer Versionen wirklich ihr eigenes `System.Text.Json` ausliefern muss, oder in einem CI-Job, dessen Tooling noch auf ein SDK vor Version 10 fixiert ist und die Lock-Datei liest.

Wenn Sie bisher `<NoWarn>NU1903;NU1904</NoWarn>` mitgeschleppt haben, um transitive Schwachstellenwarnungen für Shared-Framework-Pakete stummzuschalten, ist dies das Release, in dem Sie diesen Eintrag löschen können. Heben Sie das TFM an, führen Sie einmal Restore aus und prüfen Sie, ob der Audit-Bericht geschrumpft ist.

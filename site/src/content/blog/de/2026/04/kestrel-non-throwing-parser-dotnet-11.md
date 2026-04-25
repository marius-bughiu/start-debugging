---
title: "Kestrel verzichtet in .NET 11 auf Exceptions in seinem HTTP/1.1-Parser"
description: "Kestrels HTTP/1.1-Request-Parser in .NET 11 ersetzt BadHttpRequestException durch ein Result-Struct und reduziert den Overhead malformatter Requests um bis zu 40%."
pubDate: 2026-04-08
tags:
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "performance"
lang: "de"
translationOf: "2026/04/kestrel-non-throwing-parser-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Jeder malformatte HTTP/1.1-Request, der Kestrel erreichte, warf bislang eine `BadHttpRequestException`. Diese Exception allokierte einen Stack Trace, rollte den Aufrufstapel ab und wurde irgendwo weiter oben gefangen -- alles für einen Request, der nie eine gültige Antwort produzieren würde. In .NET 11 [wechselt der Parser zu einem nicht-werfenden Codepfad](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), und der Unterschied ist messbar: **20-40 % höherer Durchsatz** in Szenarien mit häufigem malformattem Verkehr.

## Warum Exceptions teuer waren

Eine Exception in .NET zu werfen ist nicht kostenlos. Die Laufzeit erfasst einen Stack Trace, läuft den Aufrufstapel auf der Suche nach einem passenden `catch` ab und allokiert das Exception-Objekt auf dem Heap. Für einen wohlgeformten Request feuert das nie, also bemerken Sie es nicht. Aber Portscanner, fehlkonfigurierte Clients und bösartiger Verkehr können Tausende fehlerhafter Requests pro Sekunde durchdrücken. Jeder zahlte die volle Exception-Steuer.

```csharp
// Before (.NET 10 and earlier): every parse failure threw
try
{
    ParseRequestLine(buffer);
}
catch (BadHttpRequestException ex)
{
    Log.ConnectionBadRequest(logger, ex);
    return;
}
```

In heißen Pfaden wird `try/catch` mit häufigen Throws zu einem Durchsatz-Engpass.

## Der Result-Struct-Ansatz

Der .NET 11-Parser gibt stattdessen ein leichtgewichtiges Result-Struct zurück:

```csharp
// After (.NET 11): no exception on parse failure
var result = ParseRequestLine(buffer);

if (result.Status == ParseStatus.Error)
{
    Log.ConnectionBadRequest(logger, result.ErrorReason);
    return;
}
```

Das Struct trägt ein `Status`-Feld (`Success`, `Incomplete` oder `Error`) und einen Fehlergrund-String, wo relevant. Keine Heap-Allokation, kein Stack-Unwinding, kein `catch`-Block-Overhead. Gültige Requests sehen null Änderung, weil sie bereits den Erfolgspfad nahmen.

## Wann das wichtig ist

Wenn Ihr Server hinter einem Load Balancer sitzt, der mit rohem TCP Health-Checks macht, oder wenn Sie Kestrel direkt im Internet exponieren, werden Sie ständig von malformatten Requests getroffen. Honeypot-Deployments, API-Gateways, die mit gemischten Protokollen umgehen, und jeder Dienst, der Portscans ausgesetzt ist, profitieren alle.

Die Verbesserung ist vollständig intern in Kestrel. Es gibt keine API-Änderung, kein Konfigurations-Flag und kein Opt-in. Aktualisieren Sie auf .NET 11, und der Parser ist standardmäßig schneller.

## Weitere Performance-Gewinne in .NET 11

Das ist nicht die einzige Allokationsreduktion in .NET 11 Preview. Die HTTP-Logging-Middleware pooled nun ihre `ResponseBufferingStream`-Instanzen und reduziert Per-Request-Allokationen, wenn Response-Body-Logging aktiviert ist. Kombiniert mit der Parser-Änderung setzt .NET 11 das Muster des Runtime-Teams fort, exception-lastige heiße Pfade in struct-basierte Result-Flüsse zu verwandeln.

Wenn Sie die Auswirkungen auf Ihre eigene Workload sehen wollen, lassen Sie einen Vorher/Nachher-Benchmark mit [Bombardier](https://github.com/codesenberg/bombardier) oder `wrk` laufen, während Sie einen Prozentsatz malformatter Requests injizieren. Die Parser-Änderung ist transparent, aber die Zahlen sprechen für sich.

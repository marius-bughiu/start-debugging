---
title: "ASP.NET Core 11 Preview 6 aktiviert automatischen CSRF-Schutz"
description: "Preview 6 lehnt unsichere ursprungsübergreifende Browser-Anfragen standardmäßig ab und liest dazu den Sec-Fetch-Site-Header statt eines Antiforgery-Tokens. Das blockiert es, und so schließen Sie Endpunkte aus."
pubDate: 2026-07-17
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "security"
  - "csrf"
  - "csharp"
lang: "de"
translationOf: "2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6"
translatedBy: "claude"
translationDate: 2026-07-17
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) ist am 2026-07-15 erschienen, und die ASP.NET-Core-Änderung, die Ihre App am ehesten betrifft, ist eine, für die Sie keinen Code schreiben müssen: Der Schutz vor Cross-Site Request Forgery (CSRF) ist jetzt standardmäßig aktiviert, ohne Konfiguration, über Minimal APIs, MVC, Razor Pages und Blazor hinweg. Er verlässt sich nicht auf das klassische Antiforgery-Token. Stattdessen liest er den `Sec-Fetch-Site`-Header des Browsers.

## Warum sich der Token-Tanz zu ersetzen lohnte

Das alte Modell legte die Last auf Sie. Sie gaben in jedes Formular ein Antiforgery-Token aus, validierten es beim POST und teilten die Data-Protection-Schlüssel über Instanzen hinweg, damit sich das Token nach einem Load-Balancer-Sprung noch entschlüsseln ließ. Vergaßen Sie einen dieser Schritte, hatten Sie entweder eine Sicherheitslücke oder einen Laufzeitfehler (siehe [wenn das Antiforgery-Token nicht entschlüsselt werden konnte](/de/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)). Für APIs, die kein serverseitig gerendertes Formular hatten, an das sich ein Token hängen ließe, war die Anleitung noch unklarer.

Fetch Metadata umgeht all das. Moderne Browser hängen `Sec-Fetch-Site` an jede Anfrage an, und der Wert lässt sich per Skript nicht fälschen. Preview 6 prüft ihn (mit dem `Origin`-Header als Rückfallebene) und hält ein Vertrauensurteil fest, bevor Ihr Endpunkt läuft.

## Was erlaubt und was abgelehnt wird

Die Regel ist bewusst eng. Anfragen desselben Ursprungs, benutzerinitiierte Navigationen (eine URL eintippen, auf einen Link klicken) und Nicht-Browser-Clients (eine mobile App, `HttpClient`, curl) sind alle erlaubt. Abgelehnt wird die eigentliche CSRF-Form: eine ursprungsübergreifende Browser-Anfrage, die versucht, einen Ihrer Endpunkte zu konsumieren. Weil er automatisch ist, rufen die Blazor-Web-App-Vorlagen `app.UseAntiforgery()` nicht mehr auf.

Die Ausnahmen behalten Sie dort, wo Sie sie brauchen. Ein öffentlicher Webhook, an den ein externer Dienst POSTet, ist ein Nicht-Browser-Client und kommt daher durch, aber wenn Sie es explizit machen möchten:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Protected automatically: a cross-origin page cannot POST here from a browser.
app.MapPost("/transfer", (TransferRequest req) => Results.Ok());

// Opt a single endpoint out.
app.MapPost("/webhook", (Payload p) => Results.Ok())
   .DisableAntiforgery();

app.Run();
```

In MVC bleibt der Ausweg pro Aktion unverändert:

```csharp
[HttpPost]
[IgnoreAntiforgeryToken]
public IActionResult Receive(Payload p) => Ok();
```

Um das Feature für die gesamte App abzuschalten, setzen Sie den Konfigurationsschlüssel `DisableCsrfProtection`:

```json
{
  "DisableCsrfProtection": true
}
```

Wenn die integrierte Urteilslogik nicht zu Ihrer Topologie passt, registrieren Sie eine eigene `ICsrfProtection`-Implementierung, um die Vertrauensentscheidung vollständig zu ersetzen.

## Bevor Sie die Laufzeit umstellen

Diese API tauchte erstmals in Preview 4 auf und wurde in Preview 6 überarbeitet, um den Standard-Options-Konventionen zu folgen; wenn Sie sie also früher ausprobiert haben, prüfen Sie Ihre Verdrahtung erneut. Und behandeln Sie sie als Defense in Depth, nicht als Ersatz für die Authentifizierung: Sie stoppt den ursprungsübergreifenden Browser-Vektor, nicht ein gestohlenes Bearer-Token. Alle Einzelheiten finden Sie in den [Release Notes zu ASP.NET Core Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Installieren Sie das .NET 11 Preview 6 SDK, zielen Sie auf `net11.0` und prüfen Sie vor der Veröffentlichung jeden Endpunkt, der legitim ursprungsübergreifende Browser-POSTs erwartet.

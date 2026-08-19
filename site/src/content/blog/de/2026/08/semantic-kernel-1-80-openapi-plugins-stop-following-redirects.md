---
title: "Semantic Kernel 1.80.0 lässt OpenAPI-Plugins keinen Weiterleitungen mehr folgen"
description: "Semantic Kernel .NET 1.80.0 bringt eine Breaking Change: Der Standard-HttpClient des OpenAPI-Plugins folgt keinen Weiterleitungen mehr und schließt damit eine SSRF-Umgehung. Was sich ändert und warum Ihr eigener HttpClient die Lücke wieder öffnet."
pubDate: 2026-08-19
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "de"
translationOf: "2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects"
translatedBy: "claude"
translationDate: 2026-08-19
---

Semantic Kernel .NET 1.80.0 erschien am 2026-08-18, und die entscheidende Changelog-Zeile ist die knappste: [".NET: [Breaking] Update OpenAPI HTTP client defaults"](https://github.com/microsoft/semantic-kernel/pull/14293). Sie schließt eine Lücke, die Semantic Kernel seit Mai in den eigenen XML-Kommentaren als bekannte Einschränkung dokumentiert hatte.

## Die Validierung war echt, die Weiterleitung war der Notausgang

Seit [PR #14029](https://github.com/microsoft/semantic-kernel/pull/14029) im Mai 2026 eingeflossen ist, gilt `RestApiOperationServerUrlValidationOptions` standardmäßig für jedes OpenAPI-Plugin. Lassen Sie `ServerUrlValidationOptions` auf null, erhalten Sie trotzdem eine standardmäßig konstruierte Instanz: Sie erzwingt https für alles außerhalb der Allowlist und lehnt Hosts ab, die auf Loopback, Link-Local (einschließlich der Cloud-Metadatenadresse `169.254.169.254`), RFC1918, `fc00::/7`, Carrier-Grade NAT, Multicast und reservierte Bereiche auflösen.

Das Problem war die Reihenfolge. Die Validierung läuft gegen die URL, bevor die Anfrage rausgeht. Der Standard-`HttpClient` folgte Weiterleitungen, also konnte ein von Ihnen freigegebener öffentlicher Host mit einer `302` auf `http://169.254.169.254/latest/meta-data/` antworten, und der Handler folgte ihr, nachdem die Prüfung bereits bestanden war. Semantic Kernel wies in den Anmerkungen des Typs selbst darauf hin und riet, `AllowAutoRedirect = false` eigenhändig zu setzen.

## Was 1.80.0 tatsächlich ändert

Die Plugin-Factory löst ihren Standardclient nicht mehr über `HttpClientProvider.GetHttpClient()` auf. Sie ruft jetzt ein neues `GetNonRedirectingHttpClient()` auf, gestützt auf einen separaten, nicht entsorgbaren Handler-Singleton mit abgeschalteten Weiterleitungen:

```csharp
public static HttpClient GetNonRedirectingHttpClient()
    => new(NonDisposableHttpClientHandler.NonRedirectingInstance, disposeHandler: false);
```

Jeder Einstiegspunkt läuft darüber: `ImportPluginFromOpenApiAsync`, `CreatePluginFromOpenApiAsync`, `OpenApiKernelPluginFactory.CreateFromOpenApiAsync` sowie die Erweiterungen für API Manifest und Copilot Agent Plugin. Eine Weiterleitung erscheint jetzt als `HttpOperationException` mit dem `3xx`-Status, statt stillschweigend verfolgt zu werden.

## Ihr HttpClient bleibt Ihre Sache

Das ist der Punkt, den Sie vor dem Update von `Microsoft.SemanticKernel.Plugins.OpenApi` auf 1.80.0 prüfen sollten. Der neue Standard greift nur, wenn Semantic Kernel den Client selbst baut. Übergeben Sie einen, wird er unverändert verwendet:

```csharp
var handler = new HttpClientHandler { AllowAutoRedirect = false };
using var http = new HttpClient(handler);

await kernel.ImportPluginFromOpenApiAsync(
    pluginName: "partner",
    uri: new Uri("https://partner.example.com/openapi.json"),
    executionParameters: new OpenApiFunctionExecutionParameters
    {
        HttpClient = http,
    });
```

Der subtile Fall ist Dependency Injection. Die Kernel-Erweiterungen greifen auf `kernel.Services.GetService<HttpClient>()` zurück, bevor sie beim Standard landen. Eine schlichte `AddHttpClient()`-Registrierung gewinnt also und bringt `AllowAutoRedirect = true` wieder mit. Wenn Sie Plugins innerhalb eines Hosts verdrahten, wie in [ein Semantic-Kernel-Plugin aus einem BackgroundService ausführen](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/), konfigurieren Sie den Primary Handler explizit.

Der Breaking-Anteil ist real: Eine interne API, die bei einem nicht passenden abschließenden Schrägstrich mit `301` antwortet, funktionierte bisher und wirft jetzt eine Exception. Korrigieren Sie die `servers[].url` im Dokument, statt dem Plugin einen weiterleitenden Client zu übergeben.

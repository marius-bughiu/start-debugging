---
title: "Wie man stark typisierten Client-Code aus einer OpenAPI-Spezifikation in .NET 11 generiert"
description: "Verwenden Sie Kiota, Microsofts offiziellen OpenAPI-Code-Generator, um aus jeder OpenAPI-Spezifikation einen fluenten, stark typisierten C#-Client zu erzeugen. Schritt für Schritt: installieren, generieren, in ASP.NET Core Dependency Injection einbinden und Authentifizierung konfigurieren."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "aspnet"
  - "openapi"
lang: "de"
translationOf: "2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

In dem Moment, in dem eine API ein OpenAPI-Dokument veröffentlicht, ist die manuelle Pflege eines `HttpClient`-Wrappers eine Fehlinvestition. Jedes neue Feld, jede umbenannte Route oder jeder zusätzliche Statuscode erfordert eine manuelle Aktualisierung, und Spezifikation und Client weichen still voneinander ab. Die richtige Lösung besteht darin, das Verhältnis umzukehren: die Spezifikation als einzige Quelle der Wahrheit zu behandeln und die C#-Typen daraus zu generieren.

In .NET 11 ist das kanonische Werkzeug dafür [Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview), Microsofts OpenAPI-basierter Client-Generator. Installieren Sie es als .NET-Tool, verweisen Sie es auf eine Spezifikation, und es erstellt einen fluenten, ressourcenorientierten C#-Client mit echten, stark typisierten Anfrage- und Antwortklassen. Ein einziges Meta-Paket verwaltet HTTP, JSON und Authentifizierungs-Middleware. Die gesamte Einrichtung dauert mit einer sauberen Spezifikation weniger als zehn Minuten.

## Warum manuell geschriebene HttpClient-Wrapper nicht mehr funktionieren

Ein typischer manuell geschriebener Wrapper sieht so aus: Sie schreiben ein POCO fur die Antwort, fugen eine Methode in einer Service-Klasse hinzu, schreiben das URL-Segment hart ein. Wiederholen fur jeden Endpunkt. Dann wiederholen Sie erneut, wenn der API-Eigentumer ein neues Antwortfeld hinzufugt, einen Pfadparameternamen andert oder einen Nullable-Vertrag anpasst. Keine dieser Anderungen erzeugt einen Compiler-Fehler. Sie tauchen als Laufzeituberschreitungen auf -- Null-Referenz-Ausnahmen in der Produktion, nicht ubereinstimmende JSON-Eigenschaftsnamen, die einen Wert still auf null setzen.

Ein generierter Client kehrt das um. Die Spezifikation wird direkt in C#-Typen kompiliert. Wenn die Spezifikation sagt, dass ein Feld `nullable: false` ist, ist die Eigenschaft `string`, nicht `string?`. Wenn die Spezifikation eine neue Route hinzufugt, fugt der nachste `kiota generate`-Lauf die Methode hinzu. Ein Diff der generierten Dateien zeigt genau, was sich im API-Vertrag geandert hat.

## Kiota vs NSwag: welchen Generator verwenden

Zwei Generatoren dominieren den .NET-Bereich: NSwag (ausgereift, erzeugt eine einzige monolithische Klassendatei) und Kiota (neuer, ressourcenorientiert, erzeugt viele kleine, fokussierte Dateien).

Kiota erstellt eine Pfadhierarchie, die die URL-Struktur widerspiegelt. Ein Aufruf von `GET /repos/{owner}/{repo}/releases` wird zu `client.Repos["owner"]["repo"].Releases.GetAsync()`. Jedes Pfadsegment ist eine separate C#-Klasse. Dies erzeugt mehr Dateien, macht den generierten Code aber auf jeder Pfadebene navigierbar und mockbar.

NSwag generiert eine Klasse mit einer Methode pro Operation: `GetReposOwnerRepoReleasesAsync(owner, repo)`. Das ist uberschaubar fur kleine APIs, wird aber unhandlich, wenn die Spezifikation hunderte von Pfaden hat. Die vollstandige GitHub OpenAPI-Spezifikation generiert mit NSwag eine Datei mit fast 400.000 Zeilen.

Kiota ist das, was Microsoft fur das Microsoft Graph SDK und das Azure SDK fur .NET verwendet. Es wurde 2024 als allgemein verfugbar deklariert und ist der Generator, auf den die offiziellen Dokumentations-Schnellstarts verweisen. Beide Tools werden unten gezeigt; der NSwag-Abschnitt behandelt die minimale Alternative fur Teams, die bereits in diese Toolchain investiert haben.

## Schritt 1: Kiota installieren

**Globale Installation** (einfachste Moglichkeit fur eine Entwicklermaschine):

```bash
dotnet tool install --global Microsoft.OpenApi.Kiota
```

**Lokale Installation** (empfohlen fur Teamprojekte -- reproduzierbar auf CI-Maschinen):

```bash
dotnet new tool-manifest   # creates .config/dotnet-tools.json
dotnet tool install Microsoft.OpenApi.Kiota
```

Nach einer lokalen Installation installiert `dotnet tool restore` auf jeder Entwicklermaschine oder jedem CI-Job die exakt festgelegte Version. Kein Versions-Drift im Team.

Installation verifizieren:

```bash
kiota --version
# 1.x.x
```

## Schritt 2: Den Client generieren

```bash
# .NET 11 / Kiota 1.x
kiota generate \
  -l CSharp \
  -c WeatherClient \
  -n MyApp.ApiClient \
  -d ./openapi.yaml \
  -o ./src/ApiClient
```

Die wichtigsten Parameter:

| Parameter | Zweck |
|-----------|-------|
| `-l CSharp` | Zielsprache. Kiota unterstutzt auch Go, Java, TypeScript, Python, PHP, Ruby. |
| `-c WeatherClient` | Name der Stamm-Client-Klasse. |
| `-n MyApp.ApiClient` | Stamm-C#-Namespace fur alle generierten Dateien. |
| `-d ./openapi.yaml` | Pfad oder HTTPS-URL zum OpenAPI-Dokument. Kiota akzeptiert YAML und JSON. |
| `-o ./src/ApiClient` | Ausgabeverzeichnis. Kiota uberschreibt es bei jedem Lauf -- bearbeiten Sie generierte Dateien nicht manuell. |

Fur grosse offentliche Spezifikationen (GitHub, Stripe, Azure) fugen Sie `--include-path` hinzu, um den Client auf die Pfade zu beschranken, die Sie tatsachlich verwenden:

```bash
# Only generate the /releases subtree from GitHub's spec
kiota generate \
  -l CSharp \
  -c GitHubClient \
  -n MyApp.GitHub \
  -d https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml \
  -o ./src/GitHub \
  --include-path "/repos/{owner}/{repo}/releases/*"
```

Ohne `--include-path` generiert die vollstandige GitHub-Spezifikation ungefahr 600 Dateien. Damit erhalten Sie die ein Dutzend Dateien fur den Releases-Teilbaum. Sie konnen den Filter spater jederzeit erweitern.

Ubertragen Sie die generierten Dateien in die Versionskontrolle. Die Spezifikations-URL oder der lokale Pfad reicht aus, um sie zu regenerieren, und Reviewer konnen die genauen verwendeten Typen bei der Code-Uberprufung sehen.

## Schritt 3: Das NuGet-Paket hinzufugen

```bash
dotnet add package Microsoft.Kiota.Bundle
```

`Microsoft.Kiota.Bundle` ist ein Meta-Paket, das Folgendes enthalt:

- `Microsoft.Kiota.Abstractions` -- Request-Adapter-Vertrage und Serialisierungs-Schnittstellen
- `Microsoft.Kiota.Http.HttpClientLibrary` -- `HttpClientRequestAdapter`, das Standard-HTTP-Backend
- `Microsoft.Kiota.Serialization.Json` -- System.Text.Json-Serialisierung
- `Microsoft.Kiota.Authentication.Azure` -- optional, fur Azure Identity-Authentifizierungsanbieter

Das Bundle hat `netstandard2.0` als Ziel, ist also kompatibel mit .NET 8, .NET 9, .NET 10 und .NET 11 (derzeit in der Vorschau) ohne zusatzliche `<TargetFramework>`-Anpassungen.

## Schritt 4: Den Client in einer Konsolenanwendung verwenden

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

var adapter = new HttpClientRequestAdapter(new AnonymousAuthenticationProvider());
var client = new WeatherClient(adapter);

// GET /forecasts
var all = await client.Forecasts.GetAsync();
Console.WriteLine($"Received {all?.Count} forecasts.");

// GET /forecasts/{location}
var specific = await client.Forecasts["lon=51.5,lat=-0.1"].GetAsync();
Console.WriteLine($"Temperature: {specific?.Temperature}");

// POST /forecasts
var created = await client.Forecasts.PostAsync(new()
{
    Location = "lon=51.5,lat=-0.1",
    TemperatureC = 21,
});
Console.WriteLine($"Created forecast ID: {created?.Id}");
```

`AnonymousAuthenticationProvider` fugt keine Authentifizierungs-Header hinzu -- korrekt fur offentliche APIs. Siehe den Authentifizierungsabschnitt unten fur Bearer-Tokens.

Jede generierte asynchrone Methode akzeptiert einen optionalen `CancellationToken`. Ubergeben Sie einen aus Ihrem eigenen Kontext:

```csharp
// .NET 11, Kiota 1.x
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var forecasts = await client.Forecasts.GetAsync(cancellationToken: cts.Token);
```

Der Token fliegt durch den HTTP-Adapter und bricht den zugrunde liegenden `HttpClient`-Aufruf ab. Es ist keine zusatzliche Konfiguration erforderlich.

## Schritt 5: Den Client in ASP.NET Core Dependency Injection einbinden

Das Erstellen des Request-Adapters in jedem Handler verschwendet Sockets (umgeht das Connection-Pooling von `IHttpClientFactory`) und macht den Client nicht testbar. Das korrekte Muster ist eine Factory-Klasse, die einen verwalteten `HttpClient` uber Constructor Injection erhalt.

Factory erstellen:

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

public class WeatherClientFactory(HttpClient httpClient)
{
    public WeatherClient GetClient() =>
        new(new HttpClientRequestAdapter(
            new AnonymousAuthenticationProvider(),
            httpClient: httpClient));
}
```

Alles in `Program.cs` registrieren:

```csharp
// .NET 11
using Microsoft.Kiota.Http.HttpClientLibrary;

// Kiota's eingebaute HTTP-Message-Handler im DI-Container registrieren
builder.Services.AddKiotaHandlers();

// Den benannten HttpClient registrieren und diese Handler anhangen
builder.Services.AddHttpClient<WeatherClientFactory>(client =>
{
    client.BaseAddress = new Uri("https://api.weather.example.com");
})
.AttachKiotaHandlers();

// Den generierten Client direkt fur die Injektion verfugbar machen
builder.Services.AddTransient(sp =>
    sp.GetRequiredService<WeatherClientFactory>().GetClient());
```

`AddKiotaHandlers` und `AttachKiotaHandlers` sind Erweiterungsmethoden aus `Microsoft.Kiota.Http.HttpClientLibrary`. Sie registrieren Kiotas Standard-Delegating-Handler -- Retry, Redirect, Header-Inspektion -- und binden sie in den `IHttpClientFactory`-Lebenszyklus ein, damit sie korrekt entsorgt werden.

`WeatherClient` direkt in Ihre Minimal-API-Endpunkte injizieren:

```csharp
// .NET 11
app.MapGet("/weather", async (WeatherClient client, CancellationToken ct) =>
{
    var forecasts = await client.Forecasts.GetAsync(cancellationToken: ct);
    return forecasts;
});
```

Der `CancellationToken`-Parameter in einem Minimal-API-Handler wird automatisch an den HTTP-Request-Abbruch-Token gebunden. Wenn der Client die Verbindung trennt, wird der laufende Kiota-Aufruf ohne zusatzlichen Code sauber abgebrochen.

## Schritt 6: Authentifizierung

Fur APIs, die einen Bearer-Token benotigen, implementieren Sie `IAccessTokenProvider` und ubergeben Sie es an `BaseBearerTokenAuthenticationProvider`:

```csharp
// .NET 11, Kiota 1.x
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Authentication;

public class StaticTokenProvider(string token) : IAccessTokenProvider
{
    public Task<string> GetAuthorizationTokenAsync(
        Uri uri,
        Dictionary<string, object>? additionalContext = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(token);

    public AllowedHostsValidator AllowedHostsValidator { get; } = new();
}
```

In der Factory verdrahten:

```csharp
// .NET 11, Kiota 1.x
var authProvider = new BaseBearerTokenAuthenticationProvider(
    new StaticTokenProvider(apiKey));

return new WeatherClient(new HttpClientRequestAdapter(authProvider, httpClient: httpClient));
```

Ersetzen Sie in der Produktion `StaticTokenProvider` durch eine Implementierung, die den Token aus dem aktuellen HTTP-Kontext, einem `IOptions<>`-Wert oder `DefaultAzureCredential` von Azure Identity liest (das Paket `Microsoft.Kiota.Authentication.Azure` bietet `AzureIdentityAuthenticationProvider` genau fur diesen Fall).

## NSwag verwenden, wenn Sie eine einfachere Dateistruktur bevorzugen

Wenn Ihr Projekt bereits NSwag verwendet oder mit `dotnet-openapi` erstellt wurde, mussen Sie nicht migrieren. Installieren Sie die NSwag-CLI und regenerieren Sie mit:

```bash
dotnet tool install --global NSwag.ConsoleCore

nswag openapi2csclient \
  /input:openapi.yaml \
  /classname:WeatherClient \
  /namespace:MyApp.ApiClient \
  /output:WeatherClient.cs
```

NSwag erzeugt eine einzige C#-Datei mit der Client-Klasse und einer passenden `IWeatherClient`-Schnittstelle. Diese Schnittstelle macht Unit-Tests unkompliziert -- Sie konnen `IWeatherClient` direkt mocken, ohne eine Pfad-Indirektion zu benotigen. Fur kleine, stabile Spezifikationen, bei denen die gesamte generierte Datei auf einen Bildschirm passt, ist NSwag eine praktische Wahl. Fur grosse oder sich haufig andernde Spezifikationen erleichtert die pfadbasierte Dateistruktur von Kiota die Uberprofung von API-Diffs.

## Fallstricke, bevor Sie die generierten Dateien ubertragen

**Die Qualitat der Spezifikation bestimmt die Genauigkeit der Typen.** Kiota validiert das OpenAPI-Dokument bei der Generierung. Eine fehlende `nullable: true`-Annotation wird zu `string`, wo Sie `string?` erwartet haben. Ein falsches `type: integer` wird zu `int`, wo die API tatsachlich Gleitkommazahlen sendet. Wenn Sie der Server-Eigentumer sind, fuhren Sie [Spectral](https://stoplight.io/open-source/spectral) gegen die Spezifikation aus, bevor Sie generieren.

**`--include-path` ist fur grosse offentliche APIs nicht optional.** Ohne es generiert die GitHub-Spezifikation hunderte von Dateien, die Stripe-Spezifikation noch mehr. Begrenzen Sie den Client bei der Generierung auf die Pfade, die Sie verwenden. Sie konnen den Filter spater jederzeit erweitern; ein 600-Dateien-Client, der im Laufe der Zeit wachst, ist schwerer zu reduzieren.

**Model-Namenskollisionen werden automatisch uber Namespaces aufgelost.** Wenn `GET /posts/{id}` und `GET /users/{id}` beide ein Schema namens `Item` referenzieren, generiert Kiota `Posts.Item.Item` und `Users.Item.Item`. Prufen Sie Ihre `using`-Anweisungen, wenn Namen zu kollidieren scheinen.

**`CancellationToken` in Minimal-API-Endpunkten ist kostenlos.** Deklarieren Sie ihn als Parameter, und ASP.NET Core bindet ihn ohne Attribut an den Request-Abbruch-Token. Ubergeben Sie ihn bei jedem Kiota-Aufruf, und Ihr HTTP-Client wird automatisch abgebrochen, wenn der Browser die Verbindung schliesst oder ein Gateway-Timeout ausgelost wird. Die Mechanik kooperativer Task-Abbruchverfahren in C# wird eingehend in [wie man einen lang laufenden Task in C# ohne Deadlock abbricht](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) behandelt.

**In CI regenerieren, nicht nur lokal.** Fugen Sie `dotnet tool restore && kiota generate [...]` als Pipeline-Schritt hinzu. Wenn die Spezifikation sich andert und der generierte Code im Repository veraltet ist, erkennt der Build den Unterschied, bevor er ausgeliefert wird.

## Weiterfuhrende Artikel

- Wenn Sie den API-Server selbst bereitstellen und mochten, dass die Bearer-Authentifizierung in der Scalar-Dokumentationsoberflache korrekt angezeigt wird, ist die Konfiguration nicht offensichtlich: [Scalar in ASP.NET Core: Warum Ihr Bearer-Token ignoriert wird](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- Wenn Ihre Service-to-Service-Aufrufe uber gRPC statt REST laufen, sind die Container-Netzwerkfallen andere als bei HTTP: [gRPC in Containern in .NET 9 und .NET 10](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- Das Hinzufugen verteilter Traces zur HTTP-Client-Schicht passt gut zu [nativem OpenTelemetry-Tracing in ASP.NET Core 11](/2026/04/aspnetcore-11-native-opentelemetry-tracing/)

## Quellenangaben

- [Kiota-Ubersicht](https://learn.microsoft.com/en-us/openapi/kiota/overview) -- Microsoft Learn
- [API-Clients fur .NET erstellen](https://learn.microsoft.com/en-us/openapi/kiota/quickstarts/dotnet) -- Microsoft Learn
- [Einen Kiota-Client mit Dependency Injection in .NET registrieren](https://learn.microsoft.com/en-us/openapi/kiota/tutorials/dotnet-dependency-injection) -- Microsoft Learn
- [NSwag: die Swagger/OpenAPI-Toolchain fur .NET](https://github.com/RicoSuter/NSwag) -- GitHub

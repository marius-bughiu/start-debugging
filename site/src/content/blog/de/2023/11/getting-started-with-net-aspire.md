---
title: "Erste Schritte mit .NET Aspire"
description: "Eine Schritt-für-Schritt-Anleitung zum Erstellen Ihrer ersten .NET Aspire-Anwendung, die Projektstruktur, Service Discovery und das Aspire-Dashboard abdeckt."
pubDate: 2023-11-15
tags:
  - "aspire"
  - "dotnet"
lang: "de"
translationOf: "2023/11/getting-started-with-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
Dieser Artikel führt Sie durch die Erstellung Ihrer ersten .NET Aspire-Anwendung. Wenn Sie einen Überblick über .NET Aspire und seinen Mehrwert wünschen, lesen Sie unseren Artikel [What is .NET Aspire](/de/2023/11/what-is-net-aspire/).

## Prerequisites

Es gibt einige Dinge, die Sie bereithalten müssen, bevor Sie mit .NET Aspire beginnen:

-   Visual Studio 2022 Preview (Version 17.9 oder höher)
    -   mit installiertem .NET Aspire-Workload
    -   und .NET 8.0
-   Docker Desktop

Wenn Sie Visual Studio nicht verwenden möchten, können Sie .NET Aspire auch über die dotnet-CLI mit dem Befehl `dotnet workload install aspire` installieren. Anschließend steht es Ihnen frei, die IDE Ihrer Wahl zu verwenden.

Eine umfassende Anleitung zur Installation aller erforderlichen .NET Aspire-Voraussetzungen finden Sie unter [How to install .NET Aspire](/de/2023/11/how-to-install-net-aspire/).

## Create new project

Gehen Sie in Visual Studio zu **File** > **New** > **Project**, wählen Sie im Dropdown-Menü für den Projekttyp **.NET Aspire** aus oder suchen Sie nach dem Wort "Aspire". Daraufhin sollten zwei Vorlagen erscheinen:

-   **.NET Aspire Application** -- eine leere .NET Aspire-Projektvorlage.
-   **.NET Aspire Starter Application** -- eine umfangreichere Projektvorlage mit einem Blazor-Frontend, einem API-Backend-Service und optional Caching mit Redis.

Wir wählen die Vorlage **.NET Aspire Starter Application** für unsere erste .NET Aspire-App.

[![Visual Studio-Dialog zum Erstellen eines neuen Projekts mit einer gefilterten Liste von .NET Aspire-Projektvorlagen.](/wp-content/uploads/2023/11/image-9.png)](/wp-content/uploads/2023/11/image-9.png)

Geben Sie Ihrem Projekt einen Namen und stellen Sie sicher, dass im Dialog **Additional information** die Option **Use Redis for caching** aktiviert ist. Das ist völlig optional, dient aber als gutes Beispiel dafür, was .NET Aspire für Sie tun kann.

[![Dialog mit zusätzlichen Informationen für die Vorlage .NET Aspire Starter Application mit der optionalen Option Use Redis for caching (Docker erforderlich).](/wp-content/uploads/2023/11/image-5.png)](/wp-content/uploads/2023/11/image-5.png)

### Using dotnet CLI

Sie können .NET Aspire-Apps auch über die dotnet-CLI erstellen. Verwenden Sie zum Erstellen einer App mit der Vorlage .NET Aspire Starter Application den folgenden Befehl und ersetzen Sie `Foo` durch den gewünschten Lösungsnamen.

```bash
dotnet new aspire-starter --use-redis-cache --output Foo
```

## Project structure

Nachdem die .NET Aspire-Lösung erstellt wurde, sehen wir uns ihre Struktur an. Sie sollten 4 Projekte unter Ihrer Lösung haben:

-   **ApiService**: ein ASP.NET Core API-Projekt, das vom Frontend zum Abrufen von Daten verwendet wird.
-   **AppHost**: fungiert als Orchestrator, indem es die verschiedenen Projekte und Services Ihrer .NET Aspire-Anwendung verbindet und konfiguriert.
-   **ServiceDefaults**: ein gemeinsam genutztes Projekt zur Verwaltung von Konfigurationen für Resilienz, Service Discovery und Telemetrie.
-   **Web**: eine Blazor-Anwendung, die als unser Frontend fungiert.

Die Abhängigkeiten zwischen den Projekten sehen so aus:

[![Ein Projektabhängigkeitsdiagramm für eine .NET Aspire Starter Application mit AppHost an der Spitze, abhängig von ApiService und Web, beide abhängig von ServiceDefaults.](/wp-content/uploads/2023/11/image-6.png)](/wp-content/uploads/2023/11/image-6.png)

Beginnen wir oben.

## AppHost project

Dies ist unser Orchestrator-Projekt der .NET Aspire-Lösung. Seine Aufgabe ist es, die verschiedenen Projekte und Services unserer .NET Aspire-Anwendung zu verbinden und zu konfigurieren.

Sehen wir uns die `.csproj`-Datei an:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsAspireHost>true</IsAspireHost>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="..\Foo.ApiService\Foo.ApiService.csproj" />
    <ProjectReference Include="..\Foo.Web\Foo.Web.csproj" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting" Version="8.0.0-preview.1.23557.2" />
  </ItemGroup>

</Project>
```

Zwei Dinge fallen auf:

-   das Element `IsAspireHost`, das dieses Projekt explizit als Orchestrator unserer Lösung kennzeichnet
-   die Paketreferenz `Aspire.Hosting`. Dieses Paket enthält die Kern-API und Abstraktionen für das .NET Aspire-Anwendungsmodell. Da sich das Framework noch in der Preview-Phase befindet, sind auch die .NET Aspire NuGet-Pakete als Vorab-Releases gekennzeichnet.

Sehen wir uns als Nächstes `Program.cs` an. Sie werden ein sehr vertrautes Builder-Muster bemerken, das verwendet wird, um die verschiedenen Projekte zu verknüpfen und Caching zu aktivieren.

```cs
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedisContainer("cache");

var apiservice = builder.AddProject<Projects.Foo_ApiService>("apiservice");

builder.AddProject<Projects.Foo_Web>("webfrontend")
    .WithReference(cache)
    .WithReference(apiservice);

builder.Build().Run();
```

Was der obige Code im Wesentlichen tut:

-   erstellt eine Instanz von `IDistributedApplicationBuilder`, die zum Erstellen unserer `DistributedApplication` verwendet wird
-   erstellt eine `RedisContainerResource`, auf die wir später in unseren Projekten und Services verweisen können
-   fügt unser `ApiService`-Projekt zur Anwendung hinzu und hält eine Instanz der `ProjectResource`
-   fügt unser `Web`-Projekt zur Anwendung hinzu und referenziert den Redis-Cache und den `ApiService`
-   bevor schließlich `Build()` aufgerufen wird, um unsere `DistributedApplication`-Instanz zu erstellen, und `Run()`, um sie auszuführen.

## ApiService project

Das `ApiService`-Projekt stellt einen `/weatherforecast`-Endpunkt bereit, den wir aus unserem `Web`-Projekt konsumieren können. Um die API für den Verbrauch verfügbar zu machen, haben wir sie in unserem `AppHost`-Projekt registriert und ihr den Namen `apiservice` gegeben.

```cs
builder.AddProject<Projects.Foo_ApiService>("apiservice")
```

## Web project

Das `Web`-Projekt repräsentiert unser Blazor-Frontend und konsumiert den vom `ApiService` bereitgestellten `/weatherforecast`-Endpunkt. Die Art und Weise, wie es das tut, ist dort, wo die .NET Aspire-Magie wirklich zum Tragen kommt.

Sie werden bemerken, dass es einen typisierten `HttpClient` verwendet:

```cs
public class WeatherApiClient(HttpClient httpClient)
{
    public async Task<WeatherForecast[]> GetWeatherAsync()
    {
        return await httpClient.GetFromJsonAsync<WeatherForecast[]>("/weatherforecast") ?? [];
    }
}
```

Wenn Sie nun in `Program.cs` schauen, werden Sie in Zeile 14 etwas Interessantes bemerken:

```cs
builder.Services.AddHttpClient<WeatherApiClient>(client =>
    client.BaseAddress = new("http://apiservice"));
```

Erinnern Sie sich, dass wir unserem `ApiService`-Projekt den Namen `apiservice` gegeben haben, als wir es als `ProjectResource` in unsere `DistributedApplication` aufgenommen haben? Diese Zeile konfiguriert nun den typisierten `WeatherApiClient` so, dass er Service Discovery verwendet und sich mit einem Service namens `apiservice` verbindet. `http://apiservice` wird automatisch zur korrekten Adresse unserer `ApiService`-Ressource aufgelöst, ohne dass von Ihrer Seite zusätzliche Konfiguration erforderlich ist.

## ServiceDefaults project

Ähnlich wie das `AppHost`-Projekt wird auch das gemeinsam genutzte Projekt durch eine spezielle Projekt-Eigenschaft unterschieden:

```xml
<IsAspireSharedProject>true</IsAspireSharedProject>
```

Das Projekt stellt sicher, dass alle verschiedenen Projekte und Services in Bezug auf Resilienz, Service Discovery und Telemetrie auf die gleiche Weise eingerichtet sind. Es tut dies, indem es eine Reihe von Erweiterungsmethoden bereitstellt, die von den Projekten und Services der Lösung auf ihren eigenen `IHostApplicationBuilder`-Instanzen aufgerufen werden können.

## Run the project

Um das Projekt auszuführen, stellen Sie sicher, dass `AppHost` als Ihr Startprojekt eingerichtet ist, und drücken Sie run (F5) in Visual Studio. Alternativ können Sie das Projekt über die Kommandozeile mit `dotnet run --project Foo/Foo.AppHost` ausführen, wobei Sie `Foo` durch Ihren Projektnamen ersetzen.

Nach dem Start der Anwendung wird Ihnen das .NET Aspire-Dashboard angezeigt.

[![Das .NET Aspire-Dashboard, das die Vorlage .NET Aspire Starter Application ausführt.](/wp-content/uploads/2023/11/image-7-1024x414.png)](/wp-content/uploads/2023/11/image-7.png)

Das Dashboard ermöglicht es Ihnen, die verschiedenen Teile Ihrer .NET Aspire-Anwendung zu überwachen: Ihre Projekte, Container und ausführbaren Dateien. Es bietet außerdem aggregierte, strukturierte Logs für Ihre Services, Anfrage-Traces und verschiedene andere nützliche Metriken.

[![Ein Anfrage-Trace im .NET Aspire-Dashboard, der die Anfrage in Phasen zeigt, während sie die verschiedenen Anwendungskomponenten durchläuft.](/wp-content/uploads/2023/11/image-8.png)](/wp-content/uploads/2023/11/image-8.png)

Und das war's! Glückwunsch zur Erstellung und Ausführung Ihrer allerersten .NET Aspire-Anwendung!

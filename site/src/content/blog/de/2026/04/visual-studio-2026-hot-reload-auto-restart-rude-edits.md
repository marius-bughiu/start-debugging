---
title: "Hot Reload Auto-Restart in Visual Studio 2026: Rude Edits hören auf, Ihre Debug-Session zu töten"
description: "Visual Studio 2026 fügt HotReloadAutoRestart hinzu, ein projektbezogenes Opt-in, das die App neu startet, wenn ein Rude Edit sonst die Debug-Session beenden würde. Besonders nützlich für Razor- und Aspire-Projekte."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "visual-studio"
  - "hot-reload"
  - "razor"
lang: "de"
translationOf: "2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits"
translatedBy: "claude"
translationDate: 2026-04-24
---

Einer der leisesten Gewinne im März-Update von Visual Studio 2026 ist [Hot Reload Auto-Restart für Rude Edits](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload). Ein "Rude Edit" ist eine Änderung, die die Roslyn-EnC-Engine nicht in-process anwenden kann: eine Methodensignatur ändern, eine Klasse umbenennen, einen Base Type tauschen. Bis jetzt war die einzige ehrliche Antwort, den Debugger zu stoppen, neu zu bauen und wieder zu attachen. In .NET-10-Projekten mit Visual Studio 2026 können Sie sich für einen viel besseren Default entscheiden: Die IDE startet den Prozess für Sie neu und hält die Debug-Session am Laufen.

## Opt-in mit einer einzigen Property

Das Feature ist an einer MSBuild-Property auf Projektebene aufgehängt, was heißt, Sie können es selektiv für Projekte einschalten, in denen ein Prozess-Restart billig ist, etwa ASP.NET-Core-APIs, Blazor-Server-Apps oder Aspire-Orchestrierungen, und für schwergewichtige Desktop-Hosts aus lassen.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

Sie können das auch in eine `Directory.Build.props` hochziehen, damit eine ganze Solution auf einmal opt-in geht:

```xml
<Project>
  <PropertyGroup>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

Wenn die Property gesetzt ist, lösen Rude Edits einen gezielten Rebuild des geänderten Projekts und seiner Abhängigen aus, ein neuer Prozess wird gestartet und der Debugger hängt sich neu an. Die nicht neu gestarteten Projekte laufen weiter, was in Aspire eine Menge zählt: Ihr Postgres-Container und Ihr Worker-Service müssen nicht hüpfen, nur weil Sie eine Controller-Methode umbenannt haben.

## Razor fühlt sich endlich schnell an

Die zweite Hälfte des Updates ist der Razor-Compiler. In früheren Versionen lebte der Razor-Build in einem separaten Prozess, und ein Hot Reload auf einer `.razor`-Datei konnte Dutzende Sekunden dauern, während der Compiler kaltstartete. In Visual Studio 2026 ist der Razor-Compiler innerhalb des Roslyn-Prozesses co-hosted, also ist das Editieren einer `.razor`-Datei während Hot Reload effektiv gratis.

Ein kleines Beispiel, das veranschaulicht, was jetzt Hot Reload ohne vollen Restart überlebt:

```razor
@page "/counter"
@rendermode InteractiveServer

<h1>Counter: @count</h1>
<button @onclick="Increment">+1</button>

@code {
    private int count;

    private void Increment() => count++;
}
```

Den `<h1>`-Text zu ändern, das Lambda zu tweaken oder einen zweiten Button hinzuzufügen, funktioniert weiter mit Hot Reload. Wenn Sie jetzt `Increment` zu einem `async Task IncrementAsync()` refaktorieren (ein Rude Edit, weil sich die Signatur geändert hat), springt Auto-Restart ein, der Prozess hüpft, und Sie sind zurück auf `/counter`, ohne die Debugger-Toolbar anzufassen.

## Worauf zu achten ist

Auto-Restart bewahrt keinen in-process State. Wenn Ihre Debugging-Schleife von einem warmen Cache, einer authentifizierten Session oder einer SignalR-Verbindung abhängt, verlieren Sie das beim Restart. Zwei praktische Abhilfen:

1. Verschieben Sie teures Warmup in `IHostedService`-Implementierungen, die billig erneut laufen, oder stützen Sie sie auf einen geteilten Cache.
2. Nutzen Sie einen [Custom Hot Reload Handler](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) via `MetadataUpdateHandlerAttribute`, um Caches zu leeren und neu zu seeden, wenn ein Update angewendet wird.

```csharp
[assembly: MetadataUpdateHandler(typeof(MyApp.CacheResetHandler))]

namespace MyApp;

internal static class CacheResetHandler
{
    public static void UpdateApplication(Type[]? updatedTypes)
    {
        AppCache.Clear();
        AppCache.Warm();
    }
}
```

Für Blazor- und Aspire-Teams ist der kombinierte Effekt der größte Quality-of-Life-Sprung bei Hot Reload, seit das Feature ausgeliefert wurde. Eine MSBuild-Property, ein co-hosted Compiler, und das "Stopp, Rebuild, Re-Attach"-Ritual, das ein Dutzend Mal am Tag fünf Minuten gefressen hat, ist endlich weg.

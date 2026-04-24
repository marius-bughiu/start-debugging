---
title: "Hot Reload auto-restart en Visual Studio 2026: los rude edits dejan de matar tu sesión de debug"
description: "Visual Studio 2026 agrega HotReloadAutoRestart, un opt-in a nivel de proyecto que reinicia la app cuando un rude edit de otra forma terminaría la sesión de debug. Especialmente útil para proyectos Razor y Aspire."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "visual-studio"
  - "hot-reload"
  - "razor"
lang: "es"
translationOf: "2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits"
translatedBy: "claude"
translationDate: 2026-04-24
---

Una de las victorias más silenciosas en la actualización de marzo de Visual Studio 2026 es [Hot Reload auto-restart para rude edits](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload). Un "rude edit" es un cambio que el engine EnC de Roslyn no puede aplicar in-process: modificar una signature de método, renombrar una clase, cambiar un tipo base. Hasta ahora la única respuesta honesta era parar el debugger, recompilar, y attachar de nuevo. En proyectos .NET 10 con Visual Studio 2026 puedes hacer opt-in a un default mucho mejor: el IDE reinicia el proceso por ti y mantiene la sesión de debug andando.

## Opt-in con una sola property

La feature está gateada en una property de MSBuild a nivel de proyecto, lo que significa que puedes prenderla selectivamente para los proyectos donde un restart de proceso es barato, como APIs ASP.NET Core, apps Blazor Server, u orquestaciones Aspire, y dejarla apagada para hosts desktop pesados.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

También puedes hoistearlo a un `Directory.Build.props` para que una solución entera haga opt-in de una:

```xml
<Project>
  <PropertyGroup>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

Cuando la property está seteada, los rude edits disparan una recompilación focalizada del proyecto cambiado y sus dependientes, se lanza un nuevo proceso, y el debugger se re-attacha. Los proyectos no reiniciados siguen corriendo, lo que importa mucho en Aspire: tu contenedor Postgres y tu worker service no necesitan rebotar solo porque renombraste un método de controller.

## Razor finalmente se siente rápido

La segunda mitad de la actualización es el compilador de Razor. En versiones anteriores, la build de Razor vivía en un proceso separado y un Hot Reload sobre un archivo `.razor` podía tomar decenas de segundos mientras el compilador arrancaba en frío. En Visual Studio 2026 el compilador Razor está co-hospedado dentro del proceso Roslyn, así que editar un archivo `.razor` durante Hot Reload es efectivamente gratis.

Un ejemplo pequeño para ilustrar qué sobrevive ahora a Hot Reload sin un restart completo:

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

Cambiar el texto del `<h1>`, ajustar el lambda, o agregar un segundo botón sigue funcionando con Hot Reload. Si ahora refactorizas `Increment` a un `async Task IncrementAsync()` (un rude edit porque la signature cambió), el auto-restart entra en acción, el proceso rebota, y estás de vuelta en `/counter` sin tocar el toolbar del debugger.

## Qué mirar

El auto-restart no preserva state in-process. Si tu loop de debugging depende de un cache caliente, una sesión autenticada, o una conexión SignalR, la perderás en el restart. Dos mitigaciones prácticas:

1. Mueve warmup caro a implementaciones de `IHostedService` que son baratas de re-ejecutar, o respáldalas con un cache compartido.
2. Usa un [handler de Hot Reload custom](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) vía `MetadataUpdateHandlerAttribute` para limpiar y re-sembrar caches cuando se aplica un update.

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

Para equipos de Blazor y Aspire el efecto combinado es el mayor salto de quality-of-life de Hot Reload desde que la feature salió. Una property MSBuild, un compilador co-hospedado, y el ritual de "parar, recompilar, re-attachar" que se comía cinco minutos una docena de veces al día finalmente se va.

---
title: "System.CommandLine v2, pero con el cableado ya hecho: `Albatross.CommandLine` v8"
description: "Albatross.CommandLine v8 se basa en System.CommandLine v2 con un generador de código fuente, integración de DI y una capa de hosting para eliminar el código repetitivo de CLI en aplicaciones .NET 9 y .NET 10."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "es"
translationOf: "2026/01/system-commandline-v2-but-with-the-wiring-done-for-you-albatross-commandline-v8"
translatedBy: "claude"
translationDate: 2026-04-30
---
System.CommandLine v2 llegó con un enfoque mucho más limpio: primero el parsing, una pipeline de ejecución simplificada, menos comportamientos "mágicos". Eso está muy bien, pero la mayoría de las CLI reales terminan con plomería repetitiva: configuración de DI, vinculación de manejadores, opciones compartidas, cancelación y hosting.

`Albatross.CommandLine` v8 es una nueva mirada a esa brecha exacta. Se basa en System.CommandLine v2 y añade un generador de código fuente y una capa de hosting, para que puedas definir comandos de forma declarativa y mantener el código de pegamento fuera del camino.

## La propuesta de valor: menos piezas móviles, más estructura

La propuesta del autor es específica:

-   Código repetitivo mínimo: define comandos con atributos y genera el cableado
-   Composición orientada a DI: servicios por comando, inyecta lo que necesites
-   Manejo de async y de cierre: CancellationToken y Ctrl+C de fábrica
-   Sigue siendo personalizable: puedes bajar a los objetos de System.CommandLine cuando lo necesites

Esa combinación es el punto ideal para aplicaciones de CLI en .NET 9 y .NET 10 que quieren una infraestructura "aburrida" sin tomar una dependencia de framework completa.

## Un host mínimo que sigue siendo legible

Esta es la forma (simplificada a partir del anuncio):

```cs
// Program.cs (.NET 9 or .NET 10)
using Albatross.CommandLine;
using Microsoft.Extensions.DependencyInjection;
using System.CommandLine.Parsing;

await using var host = new CommandHost("Sample CLI")
    .RegisterServices(RegisterServices)
    .AddCommands() // generated
    .Parse(args)
    .Build();

return await host.InvokeAsync();

static void RegisterServices(ParseResult result, IServiceCollection services)
{
    services.RegisterCommands(); // generated registrations

    // Your app services
    services.AddSingleton<ITimeProvider, SystemTimeProvider>();
}

public interface ITimeProvider { DateTimeOffset Now { get; } }
public sealed class SystemTimeProvider : ITimeProvider { public DateTimeOffset Now => DateTimeOffset.UtcNow; }
```

La parte importante no es "mira, un host". Es que el host se convierte en un punto de entrada predecible donde puedes probar la capa de manejadores y mantener las definiciones de comandos separadas del cableado de servicios.

## Dónde encaja, y dónde no

Es una buena opción si:

-   Tienes más de 3 a 5 comandos y las opciones compartidas empiezan a extenderse
-   Quieres DI en tu CLI, pero no quieres cablear manejadores a mano para cada comando
-   Te importa el cierre elegante porque tu CLI hace trabajo real (red, sistema de archivos, E/S largas)

Probablemente no valga la pena si:

-   Estás distribuyendo una utilidad de un solo comando
-   Necesitas un comportamiento de parsing exótico y esperas vivir en los internos de System.CommandLine

Si quieres evaluarlo rápido, estos son los mejores puntos de partida:

-   Docs: [https://rushuiguan.github.io/commandline/](https://rushuiguan.github.io/commandline/)
-   Fuente: [https://github.com/rushuiguan/commandline](https://github.com/rushuiguan/commandline)
-   Anuncio en Reddit: [https://www.reddit.com/r/dotnet/comments/1q800bs/updated\_albatrosscommandline\_library\_for/](https://www.reddit.com/r/dotnet/comments/1q800bs/updated_albatrosscommandline_library_for/)

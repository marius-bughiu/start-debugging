---
title: "ModularPipelines V3: escribe pipelines de CI en C#, depura localmente y deja de niñear YAML"
description: "ModularPipelines V3 te permite escribir pipelines de CI en C# en lugar de YAML. Ejecútalos localmente con dotnet run, obtén seguridad en tiempo de compilación y depura con puntos de interrupción."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2026/01/modularpipelines-v3-write-ci-pipelines-in-c-debug-locally-stop-babysitting-yaml"
translatedBy: "claude"
translationDate: 2026-04-29
---
Esta semana vi otro recordatorio de que CI no tiene por qué ser un ciclo a ciegas de push-y-rezar: **ModularPipelines V3** está siendo activamente publicado (la última etiqueta `v3.0.86` salió el 2026-01-18) y se apoya con fuerza en una idea simple: tu pipeline es solo una app de .NET.

Fuente: [ModularPipelines repo](https://github.com/thomhurst/ModularPipelines) y la [release v3.0.86](https://github.com/thomhurst/ModularPipelines/releases/tag/v3.0.86).

## La parte que cambia tu ciclo de feedback

Si estás publicando servicios en .NET 10, tus pasos del pipeline ya tienen "forma de código": compilar, testear, publicar, empaquetar, escanear, desplegar. El problema suele ser la envoltura: YAML, variables tipadas como strings y un ciclo de feedback de 5 a 10 minutos para detectar typos.

ModularPipelines invierte esto:

-   Puedes ejecutar el pipeline localmente con `dotnet run`.
-   Las dependencias se declaran en C#, así que el motor puede paralelizar.
-   El pipeline está fuertemente tipado, así que refactors y errores aparecen como errores de compilación normales.

Esta es la forma central tal cual aparece en el README del proyecto, limpia como un ejemplo mínimo pegable:

```cs
// Program.cs
await PipelineHostBuilder.Create()
    .AddModule<BuildModule>()
    .AddModule<TestModule>()
    .AddModule<PublishModule>()
    .ExecutePipelineAsync();

public class BuildModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Build(new DotNetBuildOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}

[DependsOn<BuildModule>]
public class TestModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Test(new DotNetTestOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}
```

Esto es aburrido en el mejor sentido: es C# normal. Los puntos de interrupción funcionan. Tu IDE ayuda. "Renombrar un módulo" no es una búsqueda global aterradora.

## Wrappers de herramientas que avanzan con el ecosistema

La release `v3.0.86` es "pequeña" a propósito: actualiza opciones de CLI para herramientas como `pnpm`, `grype` y `vault`. Ese es el tipo de mantenimiento que quieres que un framework de pipelines absorba por ti. Cuando una CLI agrega o cambia un flag, quieres que un wrapper tipado se mueva, no que se pudran una docena de fragmentos YAML.

## Por qué me gusta el modelo de módulos para repos reales

En bases de código más grandes, el costo oculto de YAML no es la sintaxis. Es la gestión de cambios:

-   Divide la lógica del pipeline por preocupación (build, test, publish, scan) en lugar de un único megaarchivo.
-   Mantén explícito el flujo de datos. Los módulos pueden devolver resultados fuertemente tipados que los módulos posteriores consumen.
-   Deja que los analizadores detecten errores de dependencia temprano. Si llamas a otro módulo, olvidar declarar `[DependsOn]` no debería ser una sorpresa en tiempo de ejecución.

Si ya vives en .NET 9 o .NET 10, tratar tu pipeline como una pequeña app de C# no es "sobreingeniería". Es un ciclo de feedback más corto y menos sorpresas en producción.

Si quieres profundizar, empieza por el "Quick Start" y la documentación del proyecto: [Full Documentation](https://thomhurst.github.io/ModularPipelines).

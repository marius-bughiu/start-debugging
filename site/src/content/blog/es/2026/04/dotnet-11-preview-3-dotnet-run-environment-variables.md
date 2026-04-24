---
title: ".NET 11 Preview 3: dotnet run -e setea variables de entorno sin launch profiles"
description: "dotnet run -e en .NET 11 Preview 3 pasa variables de entorno directo desde la CLI y las expone como items RuntimeEnvironmentVariable de MSBuild."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "dotnet-cli"
  - "msbuild"
lang: "es"
translationOf: "2026/04/dotnet-11-preview-3-dotnet-run-environment-variables"
translatedBy: "claude"
translationDate: 2026-04-24
---

.NET 11 Preview 3 salió el 14 de abril de 2026 con un cambio de SDK pequeño pero ampliamente aplicable: `dotnet run` ahora acepta `-e KEY=VALUE` para pasar variables de entorno directamente desde la línea de comandos. Sin exports de shell, sin editar `launchSettings.json`, sin scripts wrapper de ocasión.

## Por qué importa el flag

Antes de Preview 3, setear una env var para una corrida única significaba una de tres opciones torpes. En Windows tenías `set ASPNETCORE_ENVIRONMENT=Staging && dotnet run` con las sorpresas de quoting de `cmd.exe`. En bash tenías `ASPNETCORE_ENVIRONMENT=Staging dotnet run`, que funciona pero sangra la variable a cualquier proceso hijo que se forkee del shell. O agregabas otro profile más a `Properties/launchSettings.json` que nadie más en el equipo realmente quería.

`dotnet run -e` toma ese trabajo y mantiene el scope apretado a la corrida misma.

## La sintaxis, y qué setea realmente

Pasa un `-e` por variable. Puedes repetir el flag tantas veces como necesites:

```bash
dotnet run -e ASPNETCORE_ENVIRONMENT=Development -e LOG_LEVEL=Debug
```

El SDK inyecta esos valores en el entorno del proceso lanzado. Tu app los ve a través de `Environment.GetEnvironmentVariable` o del pipeline de configuración ASP.NET Core como cualquier otra variable:

```csharp
var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
Console.WriteLine($"Running as: {env}");
```

Hay un segundo efecto menos obvio que vale la pena conocer: las mismas variables se exponen a MSBuild como items `RuntimeEnvironmentVariable`. Eso significa que targets corriendo durante la fase de build de `dotnet run` también pueden leerlas, lo que desbloquea escenarios como puertear generación de código sobre un flag o intercambiar archivos de recursos por entorno.

## Leer items RuntimeEnvironmentVariable desde un target

Si tienes un target custom que debe reaccionar al flag, enumera los items que MSBuild ya pobló:

```xml
<Target Name="LogRuntimeEnvVars" BeforeTargets="Build">
  <Message Importance="high"
           Text="Runtime env: @(RuntimeEnvironmentVariable->'%(Identity)=%(Value)', ', ')" />
</Target>
```

Corre `dotnet run -e FEATURE_X=on -e TENANT=acme` y el target imprime `FEATURE_X=on, TENANT=acme` antes de que la app arranque. Estos son items MSBuild regulares, así que puedes filtrarlos con `Condition`, alimentarlos a otras propiedades, o usarlos para manejar decisiones de `Include`/`Exclude` dentro del mismo build.

## Dónde encaja en el workflow

`dotnet run -e` no es un reemplazo para `launchSettings.json`. Los launch profiles todavía tienen sentido para las configuraciones comunes que usas cada día y para escenarios de debug en Visual Studio o Rider. El flag de CLI es mejor para casos one-shot: reproducir un bug que alguien reportó bajo un `LOG_LEVEL` específico, testear un feature flag sin commitear un profile, o armar un step rápido de CI en `dotnet watch` sin reescribir un archivo YAML.

Un pequeño caveat: los valores con espacios o caracteres shell-especiales todavía necesitan quoting para tu shell. `dotnet run -e "GREETING=hello world"` está bien en bash y PowerShell, `dotnet run -e GREETING="hello world"` funciona en `cmd.exe`. El SDK mismo acepta la asignación as-is, pero el shell parsea la línea de comandos primero.

La feature más pequeña de .NET 11 Preview 3 en papel, y probablemente una de las más usadas en la práctica. Las release notes completas viven en [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk), y el post de anuncio está en el [Blog de .NET](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

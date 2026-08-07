---
title: "Microsoft.Testing.Platform 2.3: --report-gh pone las fallas de pruebas en el diff del PR"
description: "El artículo del blog de .NET del 2026-08-06 sobre reportes en MTP saca a la luz un conjunto de extensiones que se estabilizaron en Microsoft.Testing.Platform 2.3.0: anotaciones de GitHub Actions, escritura de TRX resistente a caídas e historial de flakiness en Azure DevOps."
pubDate: 2026-08-07
tags:
  - "dotnet"
  - "testing"
  - "ci-cd"
  - "github-actions"
  - "msbuild"
lang: "es"
translationOf: "2026/08/microsoft-testing-platform-2-3-github-actions-annotations"
translatedBy: "claude"
translationDate: 2026-08-07
---

El 2026-08-06 el blog de .NET publicó [Test reporting in Microsoft.Testing.Platform: from red build to root cause](https://devblogs.microsoft.com/dotnet/microsoft-testing-platform-reporting/). La noticia no es el artículo en sí, sino cuánto de esa historia de reportes aterrizó silenciosamente en Microsoft.Testing.Platform 2.3.0 (2026-07-07, con el parche más reciente 2.3.3 del 2026-07-28) y sigue desactivado por defecto en la mayoría de los repositorios.

## Un job en rojo no debería significar leer todo el log

Sin configuración adicional, una corrida fallida de MTP en un runner de GitHub te da un código de salida distinto de cero y un muro de texto en consola. El nuevo paquete `Microsoft.Testing.Extensions.GitHubActionsReport` junto con el switch `--report-gh` cambia lo que el runner hace con esos datos: grupos de log por ensamblado, anotaciones `::error` que aparecen en el margen de **Files changed** del pull request cuando la ubicación en el código fuente se resuelve, un resumen del job en Markdown agregado a `GITHUB_STEP_SUMMARY`, y entradas `::notice` para pruebas lentas.

La extensión permanece inerte a menos que la variable de entorno `GITHUB_ACTIONS` sea `true`, así que un `dotnet test` local no se ve afectado. Cada sub-característica está activa por defecto una vez que se establece `--report-gh` y se puede desactivar individualmente:

```yaml
- name: Test
  run: dotnet test -- --report-gh --report-gh-slow-test-threshold 30s --report-trx
```

El umbral acepta un número simple de segundos o un valor con sufijo como `90s`, `2m` o `1.5h`. El valor por defecto es `60s`.

## Configurarlo para todo el repositorio en vez de por invocación

Hay dos formas de evitar pegar flags en cada paso del workflow. Trae todo el conjunto de extensiones de Microsoft a cada proyecto de pruebas desde `Directory.Build.props`:

```xml
<PropertyGroup>
  <TestingExtensionsProfile>AllMicrosoft</TestingExtensionsProfile>
</PropertyGroup>
```

Luego define las opciones de forma declarativa en `testconfig.json` junto al proyecto de pruebas:

```json
{
  "commandLineOptions": {
    "report-trx": true,
    "report-html": true,
    "report-azdo": true,
    "report-azdo-flaky-history": 14
  }
}
```

Con `Microsoft.Testing.Platform.MSBuild` en el grafo de dependencias (viene de forma transitiva con los runners de MSTest, NUnit y xUnit), los proveedores de reportes se registran automáticamente al instalar el paquete. Las llamadas manuales a `builder.AddGitHubActionsProvider()` solo hacen falta si estableces `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>`.

## TRX que sobrevive a un test host muerto

El cambio que yo activaría primero no es un flag. Desde MTP 2.3.0, los resultados TRX se escriben a disco de forma incremental mientras avanza la corrida, así que un test host que se cae a mitad de la suite igual deja un TRX con todo lo recolectado antes de la caída. Antes ese escenario producía un directorio de resultados vacío y una falla de CI sin nada que leer, el mismo callejón sin salida que lleva a la gente a [recurrir a un servidor MCP de binlog para triar builds](/es/2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures/).

El nombre por defecto del TRX también se volvió determinista en 2.3.0: `{asm}_{tfm}_{arch}.trx` en lugar de `<UserName>_<MachineName>_<timestamp>.trx`. Eso por sí solo arregla toda una clase de globs frágiles para subir artefactos.

## Separar regresiones de pruebas inestables en Azure DevOps

Del lado de Azure DevOps, `--report-azdo-flaky-history 14` consulta el historial de resultados de pruebas de los últimos N días (1 a 90) y anota las fallas con contexto de inestabilidad. Combínalo con `--report-azdo-demote-known-flaky` y una falla que supere el umbral de inestabilidad (25% por defecto) baja de error a advertencia, de modo que una regresión genuina sea lo único rojo en la página.

Los reportes HTML, JUnit XML y CTRF JSON también llegaron en 2.3.0 vía `--report-html`, `--report-junit` y `--report-ctrf`. Los tres están marcados como experimentales, así que fija tu versión de MTP antes de conectarlos a un check obligatorio. Las tablas completas de opciones están en la [documentación de reportes de MTP](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-test-reports).

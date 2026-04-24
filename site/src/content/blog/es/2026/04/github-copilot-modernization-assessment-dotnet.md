---
title: "GitHub Copilot Modernization: el reporte de assessment es el producto real"
description: "GitHub Copilot Modernization se presenta como un loop Assess, Plan, Execute para migrar apps .NET legacy. La fase de assessment es donde vive el valor: un reporte de inventario, blockers categorizados, y guía de remediación a nivel de archivo que puedes diff como código."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
  - "dotnet-10"
lang: "es"
translationOf: "2026/04/github-copilot-modernization-assessment-dotnet"
translatedBy: "claude"
translationDate: 2026-04-24
---

El post del 7 de abril de Microsoft ["Your Migration's Source of Truth: The Modernization Assessment"](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) describe [GitHub Copilot Modernization](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) como un loop "Assess, Plan, Execute" para traer cargas de trabajo .NET Framework y Java legacy al presente. Si solo recuerdas una cosa del post, que sea esta: el assessment no es un dashboard brillante, es un reporte escrito a `.github/modernize/assessment/` que commiteas al lado de tu código.

## Por qué poner el reporte en el repo

Las migraciones mueren cuando el plan vive en un doc de Word que nadie actualiza. Al escribir el assessment al repo, cada cambio se vuelve revisable a través de un pull request, y la historia del branch muestra cómo la "lista de blockers" se encogió con el tiempo. También significa que el assessment puede ser regenerado en CI y diffeado, así notas cuando alguien reintroduce una API deprecada.

El reporte mismo rompe los hallazgos en tres baldes:

1. Mandatory: blockers que deben resolverse antes de que la migración compile o corra.
2. Potential: cambios de comportamiento que usualmente requieren una actualización de código, por ejemplo APIs removidas entre .NET Framework y .NET 10.
3. Optional: mejoras de ergonomía como cambiar a `System.Text.Json` o `HttpClientFactory`.

Cada hallazgo está ligado a un archivo y rango de líneas, así que un reviewer puede abrir el reporte, hacer click al código, y entender la remediación sin re-correr la herramienta.

## Corriendo un assessment

Puedes lanzar un assessment desde la extensión de VS Code, pero la superficie interesante es la CLI, porque es la que encaja en CI:

```bash
# Run a recommended assessment against a single repo
modernize assess --path ./src/LegacyApi --target dotnet10

# Multi-repo batch mode for a portfolio
modernize assess --multi-repo ./repos --target dotnet10 --coverage deep
```

La flag `--target` es donde viven los presets de escenario: `dotnet10` dispara el path de upgrade .NET Framework a .NET 10, mientras `java-openjdk21` cubre el equivalente Java. La flag `--coverage` cambia runtime por profundidad, y deep coverage es la que efectivamente inspecciona referencias transitive NuGet.

## Tratando el assessment como código

Como el reporte es un set de archivos Markdown y JSON, puedes lintearlo. Acá hay un script pequeño que falla CI cuando el assessment gana nuevos issues Mandatory:

```csharp
using System.Text.Json;

var report = JsonSerializer.Deserialize<AssessmentReport>(
    File.ReadAllText(".github/modernize/assessment/summary.json"));

var mandatory = report.Issues.Count(i => i.Severity == "Mandatory");
Console.WriteLine($"Mandatory issues: {mandatory}");

if (mandatory > report.Baseline.Mandatory)
{
    Console.Error.WriteLine("New Mandatory blockers introduced since baseline.");
    Environment.Exit(1);
}

record AssessmentReport(Baseline Baseline, Issue[] Issues);
record Baseline(int Mandatory);
record Issue(string Severity, string File, int Line, string Rule);
```

Eso convierte un assessment one-off en un ratchet: una vez que un blocker es resuelto, no puede volver silenciosamente.

## Dónde encaja junto a ASP.NET Core 2.3

El mismo batch de posts del 7 de abril incluyó el [aviso de end of support de ASP.NET Core 2.3](https://devblogs.microsoft.com/dotnet/aspnet-core-2-3-end-of-support/), que pone el 13 de abril de 2027 como la fecha dura. Copilot Modernization es la respuesta de Microsoft para shops que aún tienen paquetes ASP.NET Core 2.3 cabalgando sobre .NET Framework: corre el assessment, commitéalo, y trabaja la lista Mandatory antes de que el reloj se agote.

La herramienta no es magia. No reescribirá una extensión `HttpContext` por ti o decidirá si containerizar vía App Service o AKS. Lo que hace es darte un inventario repo-native, diffeable del trabajo, que es la primera conversación honesta que la mayoría de los codebases .NET longevos han tenido en años.

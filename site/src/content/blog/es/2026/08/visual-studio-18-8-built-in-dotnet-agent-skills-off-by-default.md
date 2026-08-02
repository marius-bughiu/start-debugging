---
title: "Visual Studio 18.8 incluye skills de agente para .NET, y luego las desactiva todas"
description: "Visual Studio 2026 18.8 coloca skills de agente para .NET y Azure escritas por expertos en el selector de herramientas, bajo una categoría Built-in y desactivadas por defecto. Lo interesante es justamente ese valor por defecto."
pubDate: 2026-08-02
tags:
  - "visual-studio"
  - "dotnet"
  - "ai-agents"
  - "agent-skills"
  - "github-copilot"
lang: "es"
translationOf: "2026/08/visual-studio-18-8-built-in-dotnet-agent-skills-off-by-default"
translatedBy: "claude"
translationDate: 2026-08-02
---

Visual Studio 2026 versión 18.8 cambió sin ruido el lugar donde vive la experiencia del agente. Las skills escritas por los equipos de .NET y Azure ahora vienen con el IDE en lugar de ser algo que tienes que buscar, instalar y conectar por tu cuenta. El 2026-07-28 Mark Downie integró el cambio en [Visual Studio July Update, Meet the New Agent](https://devblogs.microsoft.com/visualstudio/visual-studio-july-update-meet-the-new-agent-powered-by-copilot-sdk/), y GitHub lo recogió en el [changelog de Copilot](https://github.blog/changelog/2026-07-30-github-copilot-in-visual-studio-july-update/) el 2026-07-30.

Las skills aparecen en una categoría **Built-in** dentro del selector de herramientas, y solo cuando la carga de trabajo correspondiente está instalada. Si nunca instalaste la carga de trabajo de Azure, nunca verás las skills de Azure. Y todas están apagadas hasta que tú las enciendas.

## Dos skills de .NET que conviene activar primero

`dotnet-webapi` guía la creación y modificación de endpoints HTTP de ASP.NET Core: códigos de estado correctos, metadatos de OpenAPI en el endpoint en lugar de añadidos después, y un manejo de errores que no colapsa todo en un 500.

`analyzing-dotnet-performance` es la que hay que usar sobre una base de código existente. Analiza alrededor de 50 antipatrones de rendimiento en asíncrono, memoria, cadenas, colecciones, LINQ, regex, serialización y E/S, y clasifica los hallazgos por severidad en lugar de volcar una lista plana. Lo que busca es justo aquello que pasa la revisión de código porque se lee bien:

```csharp
// Materializes every matching row just to ask a yes/no question
if (db.Orders.Where(o => o.CustomerId == id).ToList().Count > 0)
{
    // ...
}

// One EXISTS query, no allocation, no blocking
if (await db.Orders.AnyAsync(o => o.CustomerId == id, ct))
{
    // ...
}
```

Del lado de Azure llega una cadena de implementación en tres pasos (`azure-prepare` genera Bicep o Terraform más `azure.yaml` y la configuración de identidad administrada, `azure-validate` ejecuta comprobaciones previas, `azure-deploy` ejecuta la implementación), más `azure-kusto` para KQL contra Azure Data Explorer y `microsoft-foundry` para desplegar y evaluar modelos.

## Desactivadas por defecto es una decisión de contexto, no de timidez

Habría sido fácil habilitarlas todas y dejar que el agente se las arreglara. Enviarlas apagadas es la mejor decisión, y la razón es el presupuesto de contexto. Cada skill habilitada son instrucciones que compiten por la misma ventana que tu código real. Alguien que desarrolla APIs web en .NET y tiene la carga de trabajo de Azure instalada por una única tarea de implementación no quiere seis skills de Azure condicionando cada respuesta durante el resto del año.

Es la misma disciplina que necesita el plugin `dotnet-test`, [el que está detrás del agente de pruebas unitarias de la semana pasada](/es/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/): carga la skill del trabajo, no el catálogo.

## No necesitas Visual Studio para nada de esto

Las skills de .NET son públicas en [dotnet/skills](https://github.com/dotnet/skills) y las de Azure en [microsoft/azure-skills](https://github.com/microsoft/azure-skills). Los mismos plugins se instalan en Copilot CLI, Claude Code, VS Code y Cursor:

```bash
/plugin marketplace add dotnet/skills
```

Lo que 18.8 realmente aporta es descubrimiento. Nadie iba a encontrar `analyzing-dotnet-performance` navegando por un repositorio. Encontrarla en un selector, junto a la carga de trabajo que ya tenías instalada, es otra historia, lo que convierte el interruptor apagado por defecto en la única fricción que queda, y esa sí vale la pena conservarla.

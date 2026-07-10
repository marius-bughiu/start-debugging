---
title: "El agente de modernización de .NET ahora funciona en la CLI de Copilot, no solo en Visual Studio"
description: "El agente modernize-dotnet de GitHub Copilot se lanzó como plugin portátil el 2026-07-09. Ahora funciona en VS Code, la CLI de Copilot y en GitHub, con un flujo de evaluar, planificar y ejecutar cuyos artefactos se registran en tu repositorio para revisión."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
lang: "es"
translationOf: "2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin"
translatedBy: "claude"
translationDate: 2026-07-10
---

Durante la mayor parte del último año, las herramientas de modernización de .NET de GitHub Copilot tuvieron un solo hogar: Visual Studio. Si tu equipo vivía en VS Code, en la línea de comandos o revisaba todo mediante pull requests, la experiencia de "actualiza mi aplicación heredada" quedaba en un lugar donde no trabajabas. El 2026-07-09, Microsoft [lanzó el agente `modernize-dotnet` como un plugin portátil](https://devblogs.microsoft.com/dotnet/modernize-dotnet-anywhere-with-ghcp/) que funciona en cuatro superficies: Visual Studio, VS Code, la CLI de GitHub Copilot y el propio GitHub.

## Por qué "en cualquier lugar" importa de verdad aquí

La modernización no es un comando de un solo paso. Es evaluar, planificar y luego una larga secuencia de transformaciones de código que supervisas. Forzar eso dentro de un solo IDE significaba que la persona que impulsaba la actualización tenía que cambiar de contexto fuera de su entorno normal para lo que suele ser un trabajo de varios días. Mover el mismo agente a la CLI permite que los desarrolladores que prefieren la terminal lo ejecuten junto a su ciclo de compilación y prueba, y ponerlo en GitHub permite que la actualización ocurra como una unidad de trabajo revisable y colaborativa en lugar de la sesión local de una sola persona.

El flujo de trabajo es el mismo en todas partes, y ese es el punto. El agente sigue un modelo de evaluar, planificar y ejecutar, y escribe tres artefactos en tu repositorio:

1. Una **evaluación** que expone el alcance y los bloqueos antes de cualquier cambio de código.
2. Un **plan de actualización** que ordena el trabajo.
3. **Tareas de actualización** que aplican las transformaciones reales.

Como esos artefactos se registran en el repositorio, tu equipo revisa el plan de la misma manera que revisa un PR, antes de que la ejecución toque una sola línea de código.

## Ejecutarlo desde la CLI de Copilot

La ruta de la CLI instala el agente como un plugin y luego lo controla con lenguaje natural. Los comandos son breves:

```bash
# Add the plugin marketplace and install the agent
/plugin marketplace add dotnet/modernize-dotnet
/plugin install modernize-dotnet@modernize-dotnet-plugins

# Select the agent, then describe the job
/agent modernize-dotnet
upgrade my solution to a new version of .NET
```

A partir de ahí, el agente genera la evaluación, propone el plan y aplica las tareas con aprobación humana en el bucle en cada paso. Se encarga de las partes poco glamurosas de una actualización: subir el target framework, actualizar las dependencias y corregir los errores de compilación que deja un cambio de `TargetFramework`.

## Qué cubre hoy

Las cargas de trabajo compatibles incluyen ASP.NET Core, Blazor, Azure Functions, WPF, bibliotecas de clases y aplicaciones de consola, además de migraciones de .NET Framework a .NET moderno. Web Forms todavía no está en el alcance. Si probaste la versión solo para Visual Studio antes y te resultó incómoda de encajar en el flujo de trabajo de un equipo, este es el lanzamiento que arregla el modelo de entrega en lugar de la capacidad.

El agente se desarrolla de forma abierta en [dotnet/modernize-dotnet](https://github.com/microsoft/github-copilot-appmod), y el despliegue en cuatro superficies ya está disponible. El cambio interesante no es que Copilot pueda actualizar código de .NET, es que la actualización ahora es un artefacto del repositorio que revisas, no una caja negra dentro de un solo editor.

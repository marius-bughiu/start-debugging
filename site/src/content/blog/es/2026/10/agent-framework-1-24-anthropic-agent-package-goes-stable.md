---
title: "Agent Framework 1.24: el paquete Anthropic Agent es estable, excepto los servicios beta"
description: "Microsoft.Agents.AI.Anthropic 1.24.0 elimina el sufijo preview y depende de Anthropic 12.53.0. Los agentes creados desde IAnthropicClient ahora son API estable, mientras que las extensiones de client.Beta quedan marcadas como experimentales con MAAIANTHROPIC001, que las llamadas con sintaxis de método de extensión no activan."
pubDate: 2026-10-08
tags:
  - "agent-framework"
  - "dotnet"
  - "anthropic"
  - "ai-agents"
lang: "es"
translationOf: "2026/10/agent-framework-1-24-anthropic-agent-package-goes-stable"
translatedBy: "claude"
translationDate: 2026-10-08
---

Microsoft Agent Framework [dotnet-1.24.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.24.0) se publicó el 7 de octubre de 2026, y una línea del changelog importa más que el resto si ejecutas agentes basados en Claude en .NET: [PR #9111](https://github.com/microsoft/agent-framework/pull/9111), "Stabilize Anthropic agent package". Hasta la semana pasada, `Microsoft.Agents.AI.Anthropic` solo existía como compilaciones preliminares (la última fue `1.23.0-preview.260928.1`). En NuGet ahora es simplemente `1.24.0`, publicado junto con el resto del framework.

## Qué cubre realmente la versión estable

El paquete tiene dos clases de extensión, y no recibieron el mismo trato.

`AnthropicClientExtensions`, que cuelga `AsAIAgent` de `IAnthropicClient`, ahora es API pública publicada. El PR añade líneas base `PublicAPI.Shipped.txt` para cada target framework para el que se compila el paquete (`net10.0`, `net9.0`, `net8.0`, `netstandard2.0`, `net472`), así que la validación de paquetes señalará los cambios incompatibles a partir de ahora. La dependencia también pasó de `Anthropic` 12.45.0 a 12.53.0, el SDK oficial de C# de Anthropic, que ya es GA.

`AnthropicBetaServiceExtensions`, las sobrecargas de `AsAIAgent` sobre `IBetaService` (lo que obtienes de `client.Beta`), es la excepción. Toda la clase está ahora marcada con `[Experimental("MAAIANTHROPIC001")]`, con una nota en la documentación que dice que "may change in non-major releases as the underlying beta services evolve". El razonamiento del [issue #9110](https://github.com/microsoft/agent-framework/issues/9110) es directo: el SDK de Anthropic es GA, pero su superficie beta no lo es, y Agent Framework no quiere prometer un contrato de compatibilidad que su upstream no ofrece.

## Qué cambia en tu código

Si creas agentes desde el cliente normal, no cambia nada salvo la versión del paquete:

```xml
<PackageReference Include="Microsoft.Agents.AI.Anthropic" Version="1.24.0" />
```

```csharp
using Anthropic;
using Microsoft.Agents.AI;

AnthropicClient client = new() { ApiKey = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") };

ChatClientAgent agent = client.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You review C# pull requests and answer in short bullet points.",
    name: "reviewer");

Console.WriteLine(await agent.RunAsync("Is `async void` ever fine in an ASP.NET Core handler?"));
```

La ruta beta es donde se complica. La compilé y verifiqué con el SDK 10.0.302 contra el paquete 1.24.0. Primero, las sobrecargas viven en el namespace `Anthropic.Services`, así que `client.Beta.AsAIAgent(...)` no se resuelve hasta que añades ese `using`. Segundo, el atributo está en la clase, no en los métodos, y C# solo reporta un `[Experimental]` a nivel de clase cuando el nombre del tipo aparece en tu código. La sintaxis de método de extensión nunca nombra el tipo, así que esto compila sin ningún diagnóstico:

```csharp
using Anthropic.Services;

ChatClientAgent agent = client.Beta.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You create PowerPoint presentations.",
    tools: [pptxSkill.AsAITool()]);
```

Si nombras la clase directamente, como en una llamada estática o cuando ajustas el presupuesto de tokens predeterminado compartido, obtienes un error, porque los diagnósticos de `[Experimental]` son errores por defecto:

```csharp
AnthropicBetaServiceExtensions.DefaultMaxTokens = 8000;
```

```text
error MAAIANTHROPIC001: 'Anthropic.Services.AnthropicBetaServiceExtensions' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
```

El sample de skills del propio framework lo suprime al inicio del archivo con `#pragma warning disable MAAIANTHROPIC001`. Si las funciones beta forman parte de tu diseño y no son un experimento, suprímelo una sola vez para todo el proyecto:

```xml
<PropertyGroup>
  <NoWarn>$(NoWarn);MAAIANTHROPIC001</NoWarn>
</PropertyGroup>
```

## Por qué la división es la decisión correcta

Fijar un paquete en versión preliminar en producción es una razón común para mantener los agentes de Claude fuera de Agent Framework y conectar `IChatClient` a mano (los compromisos están en mi [comparación entre el SDK de Anthropic y Microsoft.Extensions.AI](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/)). Esa excusa desaparece para la ruta estable. Eso sí, no trates el diagnóstico como una auditoría. Como la forma de llamada de la extensión se le escapa, una compilación limpia no significa que estés fuera de la superficie beta: busca con grep `client.Beta` e `IBetaService` para encontrar los puntos de llamada que pueden romperse con una actualización menor de Agent Framework o del SDK de Anthropic.

El resto de 1.24.0 es endurecimiento: validación de capacidades de `LocalCodeAct`, rechazo de identificadores sensibles en agentes declarativos y vinculación de los encabezados de aprobación de MCP a la invocación aprobada. Si te saltaste la 1.23, empieza por su [cambio en el middleware de funciones](/es/2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool/) antes de actualizar.

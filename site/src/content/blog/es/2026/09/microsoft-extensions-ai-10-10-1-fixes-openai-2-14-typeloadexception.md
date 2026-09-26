---
title: "Microsoft.Extensions.AI.OpenAI 10.10.1 corrige la TypeLoadException de OpenAI 2.14"
description: "OpenAI 2.14.0 renombró GlobalMcpToolCallApprovalPolicy, lo que rompió cada llamada a la Responses API con herramientas a través de Microsoft.Extensions.AI.OpenAI 10.10.0. La versión 10.10.1 pasa a OpenAI 2.14.0 e incorpora también la corrección del status de razonamiento null para endpoints compatibles con OpenAI."
pubDate: 2026-09-26
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "openai"
  - "csharp"
lang: "es"
translationOf: "2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception"
translatedBy: "claude"
translationDate: 2026-09-26
---

`Microsoft.Extensions.AI.OpenAI` 10.10.1 llegó a NuGet el 25 de septiembre de 2026, y las [notas de la versión](https://github.com/dotnet/extensions/releases/tag/v10.10.1) caben en una línea: "Upgrade OpenAI SDK to 2.14.0". Esa línea esconde un fallo en tiempo de ejecución. Si tu aplicación referencia `Microsoft.Extensions.AI.OpenAI` 10.10.0 y algo en el grafo subió `OpenAI` a 2.14.0 (un bump de Dependabot, una referencia directa, otro paquete), cada llamada a la Responses API que lleva una herramienta ha estado muriendo con una `TypeLoadException` desde el 15 de septiembre.

## Un tipo experimental renombrado, resuelto en tiempo de JIT

`OpenAI` 2.14.0 salió el 15 de septiembre. Entre sus cambios, el struct experimental `OpenAI.Responses.GlobalMcpToolCallApprovalPolicy` pasó a ser `DefaultMcpToolCallApprovalPolicy`, y la propiedad `GlobalPolicy` de `McpToolCallApprovalPolicy` pasó a ser `DefaultPolicy`. Las APIs experimentales (`OPENAI001`) pueden romperse, pero `Microsoft.Extensions.AI.OpenAI` 10.10.0 estaba compilado contra el nombre antiguo dentro de `OpenAIResponsesChatClient.ToResponseTool`, el método que convierte cada `AITool` en una herramienta de Responses.

El nuspec de 10.10.0 declara `OpenAI` con un mínimo de `2.13.0`, así que NuGet resuelve 2.14.0 sin problema cuando otra cosa lo pide. Nada falla al compilar. La primera llamada con un `ChatOptions` que lleva herramientas falla cuando el JIT compila `ToResponseTool`:

```text
System.TypeLoadException: Could not load type 'OpenAI.Responses.GlobalMcpToolCallApprovalPolicy'
from assembly 'OpenAI, Version=2.14.0.0, Culture=neutral, PublicKeyToken=b4187f3e65366280'.
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.ToResponseTool(AITool tool, ChatOptions options, ToolSearchLookup toolSearchLookup)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.AsCreateResponseOptions(...)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.GetStreamingResponseAsync(...)
```

Da igual si usas MCP. El método referencia el tipo, así que una simple `AIFunction` también lo dispara. El [issue #7760](https://github.com/dotnet/extensions/issues/7760) lo reportó con `Microsoft.Agents.AI.OpenAI` 1.21.0 sobre .NET 10.

## Por qué quedarse en OpenAI 2.13.0 no era una solución limpia

Fijar `OpenAI` de vuelta en 2.13.0 evita el fallo, pero 2.13.0 tiene su propio bug: la deserialización de `ReasoningResponseItem` llama a `ToReasoningStatus()` sobre un `null` de JSON. Los backends de terceros compatibles con OpenAI que serializan un elemento de razonamiento como `"status": null` en lugar de omitirlo tumban todo el stream SSE con `ArgumentOutOfRangeException: Unknown ReasoningStatus value`. OpenAI 2.14.0 añadió la comprobación de null. Así que durante una semana tenías que elegir qué bug preferías.

El [PR #7761](https://github.com/dotnet/extensions/pull/7761) resuelve ambos: sube a `OpenAI` 2.14.0, mapea `HostedMcpServerToolAlwaysRequireApprovalMode` y `HostedMcpServerToolNeverRequireApprovalMode` a `DefaultMcpToolCallApprovalPolicy`, y añade un test de regresión de streaming para el caso de `status` null.

## La actualización

Mueve ambos paquetes juntos. `Microsoft.Extensions.AI.OpenAI` 10.10.1 ahora requiere `OpenAI` 2.14.0, así que si fijaste 2.13.0 como workaround, quita ese pin o obtendrás un error de downgrade `NU1605`:

```xml
<ItemGroup>
  <PackageReference Include="Microsoft.Extensions.AI.OpenAI" Version="10.10.1" />
  <PackageReference Include="OpenAI" Version="2.14.0" />
</ItemGroup>
```

Luego comprueba qué se resolvió realmente, ya que los frameworks de agentes y los wrappers de SDK suelen traer estos paquetes de forma transitiva:

```bash
dotnet list package --include-transitive | grep -E "OpenAI|Extensions.AI"
```

Si usas directamente los tipos de aprobación de MCP en tu propio código, el renombrado también te afecta:

```csharp
#pragma warning disable OPENAI001
var policy = new McpToolCallApprovalPolicy(DefaultMcpToolCallApprovalPolicy.NeverRequireApproval);
var mode = policy.DefaultPolicy; // was policy.GlobalPolicy in OpenAI 2.13.0
#pragma warning restore OPENAI001
```

La lección general: la dependencia de versión mínima de una biblioteca sobre un paquete con APIs experimentales es, en la práctica, un rango abierto a cambios incompatibles. Si ejecutas en producción un agente basado en Responses, un smoke test que envíe una petición con una herramienta tras cada bump de dependencias habría detectado esto en CI en lugar de en tiempo de ejecución. Para el resto de lo que cambió en esta línea de versiones, consulta el artículo anterior sobre [Microsoft.Extensions.AI 10.10 fallando métricas de evaluación sin puntuar](/es/2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics/).

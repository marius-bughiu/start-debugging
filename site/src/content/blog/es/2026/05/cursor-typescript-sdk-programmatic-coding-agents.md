---
title: "Cursor lanza un SDK de TypeScript que convierte su agente de programación en una biblioteca"
description: "La nueva versión preliminar pública de @cursor/sdk expone el mismo runtime, harness y modelos que impulsan la app de escritorio, la CLI y la web como un paquete de TypeScript. Tienes VMs en la nube aisladas, subagentes, hooks, MCP y precios por tokens en pocas líneas de código."
pubDate: 2026-05-04
tags:
  - "cursor"
  - "ai-agents"
  - "typescript"
  - "mcp"
lang: "es"
translationOf: "2026/05/cursor-typescript-sdk-programmatic-coding-agents"
translatedBy: "claude"
translationDate: 2026-05-04
---

El 29 de abril de 2026, Cursor abrió la versión preliminar pública de `@cursor/sdk`, una biblioteca de TypeScript que envuelve el mismo runtime, harness y modelos que impulsan el editor de escritorio, la CLI y la app web. La propuesta es simple: el agente que vivía dentro de la interfaz de Cursor ahora es un componente programable que puedes invocar desde tus propios servicios. El mismo modelo Composer, el mismo motor de contexto, la misma superficie de herramientas, accesibles desde un proceso Node.

Es el mismo cambio que pasaron los SDK de Anthropic y OpenAI hace años, pero para un agente especializado en código en vez de un modelo de chat puro.

## Qué incluye `@cursor/sdk`

Lo instalas como cualquier otro paquete:

```bash
npm install @cursor/sdk
```

El "crear un agente y ejecutar un prompt" mínimo se ve así en la [documentación oficial](https://cursor.com/docs/sdk/typescript):

```typescript
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  console.log(event);
}
```

El campo interesante es `local`. Pásalo y el agente opera contra tu sistema de archivos en el directorio de trabajo actual. Quítalo y reemplázalo por `cloud: { ... }` y la misma llamada ahora corre dentro de una VM aislada que Cursor te aprovisiona, con indexado del código, búsqueda semántica y grep en el lado remoto. El contrato de `Agent.create`, `agent.send` y el stream del run es idéntico entre ambos.

Esa simetría es la característica principal. Los scripts de CI que necesitan mantener los resultados locales pueden quedarse locales. Los agentes alojados que necesitan ejecutar prompts no confiables contra clones efímeros pueden migrar al runtime en la nube sin reescribir el harness.

## Subagentes, hooks, MCP y skills

El SDK no se queda en prompts de un solo disparo. Expone las mismas primitivas que usa la app de escritorio:

- `Run` ofrece streaming, espera y cancelación. El stream emite eventos `SDKMessage`: tokens del asistente, llamadas a herramientas, thinking y actualizaciones de estado como una unión discriminada.
- Los subagentes permiten que un run padre delegue una subtarea autocontenida sin contaminar su propia ventana de contexto.
- Los hooks se disparan antes y después de las llamadas a herramientas, así que puedes denegar escrituras de archivos peligrosas, registrar cada comando de shell o reescribir prompts según una política.
- Los servidores MCP se conectan por `stdio` o `http`, lo que significa que cualquier integración MCP existente (GitHub, Linear, tus datos internos) se enchufa sin cambios de código.
- El namespace `Cursor` maneja el plumbing a nivel de cuenta: listar modelos, listar repositorios, gestionar API keys.

Los errores son tipados: `AuthenticationError`, `RateLimitError`, `ConfigurationError` y compañía. Se acabó parsear strings de mensajes.

## Por qué esto también importa para los equipos de .NET

El SDK es solo TypeScript hoy, pero el runtime en la nube es agnóstico al lenguaje, así que puedes lanzarlo desde un pequeño sidecar Node al que un servicio .NET hace shell-out. Combinado con el [Microsoft Agent Framework](/es/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) en el lado C#, el patrón realista de 2026 empieza a verse claro: orquestar desde .NET, empujar tareas de edición de código a un agente Cursor alojado vía SDK y consumir los resultados a través de MCP.

El precio es por consumo de tokens estándar sin un asiento separado para uso del SDK, así que el costo del experimento es lo que queme el modelo. El detalle al que tienes que prestar atención es el ciclo de vida de la VM en la nube. Los runs de larga duración pueden acumular dinero real, y el SDK no cancela automáticamente los agentes inactivos por ti.

La documentación completa de la versión preliminar vive en [cursor.com/docs/sdk/typescript](https://cursor.com/docs/sdk/typescript), y la publicación del lanzamiento es [cursor.com/blog/typescript-sdk](https://cursor.com/blog/typescript-sdk).

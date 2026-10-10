---
title: "Genkit Dart 1.0: GenkitRouter reemplaza a startFlowServer, y los clientes Flutter antiguos necesitan un flag"
description: "Genkit Dart 1.0.0 congela la API, mueve el servicio HTTP al núcleo con GenkitRouter y cambia el frame de error en streaming. Las apps Flutter ya publicadas con un cliente 0.17 necesitan sendLegacyErrorFrame."
pubDate: 2026-10-10
tags:
  - "dart"
  - "flutter"
  - "genkit"
  - "ai-agents"
lang: "es"
translationOf: "2026/10/genkit-dart-1-0-genkitrouter-replaces-startflowserver"
translatedBy: "claude"
translationDate: 2026-10-10
---

Google etiquetó [Genkit Dart 1.0.0](https://github.com/genkit-ai/genkit-dart/releases/tag/genkit-v1.0.0) el 7 de octubre de 2026, y el [anuncio en el blog de Flutter](https://flutter.dev/blog/announcing-genkit-dart-1-0) llegó el 8 de octubre. El paquete principal `genkit`, `schemantic` y los plugins de Google GenAI, Vertex AI, Anthropic, OpenAI, MCP, middleware y shelf ahora están en 1.0.0 y cubiertos por semver. `genkit_otel`, `genkit_chrome`, `genkit_firebase_ai` y `genkit_a2ui` siguen en 0.x.

Las notas de la versión son claras: congelar la API implicó "a lot of breaking changes". La mayoría son renombrados. El que puede romper una app que ya está en manos de tus usuarios está en el servicio HTTP.

## startFlowServer desaparece, GenkitRouter vive en el núcleo

Hasta la 0.17, servir flujos significaba usar `genkit_shelf` y `startFlowServer`. En la 1.0, el servicio HTTP se movió a `package:genkit/io.dart`, funciona sobre `dart:io` puro, y `genkit_shelf` pasó a ser un adaptador delgado. `startFlowServer` y `FlowWithContextProvider` fueron eliminados ([#533](https://github.com/genkit-ai/genkit-dart/pull/533)):

```dart
// before (0.17)
await startFlowServer(
  flows: [helloFlow, FlowWithContextProvider(flow: secureFlow, context: bearerAuth)],
  cors: {'origin': '*'},
);

// after (1.0.0)
final genkit = GenkitRouter()
  ..addAction(helloFlow)
  ..addAction(secureFlow, contextProvider: bearerAuth);
await genkit.serve(cors: const CorsOptions());
```

Los proveedores de contexto ahora reciben un `RequestData` independiente del framework en lugar de un `Request` de shelf, con los nombres de encabezado en minúsculas, así que las búsquedas `request.headers['Authorization']` deben cambiar a `'authorization'`. También puedes montar el router dentro de tu propio servidor con `handleHttpRequest(request, basePath: '/api')`.

## El frame de error en streaming cambió

Las respuestas en streaming ahora usan `Content-Type: text/event-stream`, y un stream fallido termina con un frame `data:` que lleva el error, igual que los servidores de Go y Python. Ejecuté un servidor con dos flujos en Dart 3.12.2 con `genkit` 1.0.0, donde el flujo de streaming envía un fragmento y luego lanza una excepción:

```dart
final boom = ai.defineFlow(
  name: 'boom',
  inputSchema: .string(),
  outputSchema: .string(),
  streamSchema: .string(),
  fn: (String name, ctx) async {
    ctx.sendChunk('partial');
    throw GenkitException('nope', status: StatusCode.internal);
  },
);
```

`POST /boom?stream=true` con los valores por defecto de la 1.0:

```text
content-type: text/event-stream

data: {"message":"partial"}

data: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Según las notas de la versión, los clientes de genkit 0.17 y anteriores solo entienden el frame antiguo `error:`. Si una app Flutter compilada contra la 0.17 llama a tu backend, actualizar solo el servidor hace que ese cliente deje de ver los errores como antes. Es el caso de cualquier versión que siga instalada en celulares que no se han actualizado.

La solución es un argumento del constructor:

```dart
final genkit = GenkitRouter(sendLegacyErrorFrame: true);
```

Con eso activado, la misma solicitud termina con el frame heredado:

```text
data: {"message":"partial"}

error: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Las llamadas sin streaming no se ven afectadas: `POST /hello` devolvió `{"result":"Hello, Marius"}` en ambos modos.

## Otros renombrados que conviene buscar con grep

- `ExecutablePrompt` ahora es `Prompt<Input, Output>`, y los prompts devuelven un `output` tipado igual que `generate`.
- Los agentes, sesiones, snapshots y el streaming bidireccional pasaron a `package:genkit/experimental.dart`, lo que dispara la advertencia del analizador `experimental_member_use` al importar.
- `agents()` ya no se reexporta desde `genkit_middleware`; importa `package:genkit_middleware/agents.dart`.
- Autores de plugins: `defineMiddleware` ahora es `generateMiddleware`, y el código de la app usa `ai.defineGenerateMiddleware`.

Si sirves flujos de Genkit a un cliente móvil, el orden seguro de actualización es: publica el servidor en 1.0.0 con `sendLegacyErrorFrame: true`, lanza la app Flutter con el cliente 1.0 y quita el flag cuando la versión mínima de app que soportas ya sea posterior a la 0.17.

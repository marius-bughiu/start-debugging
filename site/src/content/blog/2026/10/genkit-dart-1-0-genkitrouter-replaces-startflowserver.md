---
title: "Genkit Dart 1.0: GenkitRouter Replaces startFlowServer, and Old Flutter Clients Need a Flag"
description: "Genkit Dart 1.0.0 freezes the API, moves HTTP serving into core with GenkitRouter, and changes the streamed error frame. Shipped Flutter apps on a 0.17 client need sendLegacyErrorFrame."
pubDate: 2026-10-10
tags:
  - "dart"
  - "flutter"
  - "genkit"
  - "ai-agents"
---

Google tagged [Genkit Dart 1.0.0](https://github.com/genkit-ai/genkit-dart/releases/tag/genkit-v1.0.0) on October 7, 2026, and the [Flutter blog announcement](https://flutter.dev/blog/announcing-genkit-dart-1-0) followed on October 8. The core `genkit` package, `schemantic`, and the Google GenAI, Vertex AI, Anthropic, OpenAI, MCP, middleware, and shelf plugins are now 1.0.0 and covered by semver. `genkit_otel`, `genkit_chrome`, `genkit_firebase_ai`, and `genkit_a2ui` stay on 0.x.

The release notes are upfront that freezing the API meant "a lot of breaking changes". Most are renames. The one that can break an app already in your users' hands is in HTTP serving.

## startFlowServer is gone, GenkitRouter lives in core

Up to 0.17, serving flows meant `genkit_shelf` and `startFlowServer`. In 1.0, HTTP serving moved into `package:genkit/io.dart`, runs on plain `dart:io`, and `genkit_shelf` became a thin adapter. `startFlowServer` and `FlowWithContextProvider` were removed ([#533](https://github.com/genkit-ai/genkit-dart/pull/533)):

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

Context providers now receive a framework-neutral `RequestData` instead of a shelf `Request`, with lowercased header names, so `request.headers['Authorization']` lookups need to become `'authorization'`. You can also mount the router inside your own server with `handleHttpRequest(request, basePath: '/api')`.

## The streamed error frame changed

Streamed responses now use `Content-Type: text/event-stream`, and a failed stream ends with a `data:` frame carrying the error, matching the Go and Python servers. I ran a two-flow server on Dart 3.12.2 with `genkit` 1.0.0, where the streaming flow sends one chunk and then throws:

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

`POST /boom?stream=true` with the 1.0 defaults:

```text
content-type: text/event-stream

data: {"message":"partial"}

data: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Per the release notes, clients from genkit 0.17 and earlier only understand the old `error:` frame. If a Flutter app built against 0.17 is calling your backend, upgrading the server alone means that client stops seeing errors the way it used to. That is the case for any version still installed on phones that have not updated.

The fix is one constructor argument:

```dart
final genkit = GenkitRouter(sendLegacyErrorFrame: true);
```

With it set, the same request ends with the legacy frame:

```text
data: {"message":"partial"}

error: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Non-streaming calls are unaffected: `POST /hello` returned `{"result":"Hello, Marius"}` in both modes.

## Other renames worth grepping for

- `ExecutablePrompt` is now `Prompt<Input, Output>`, and prompts return typed `output` like `generate` does.
- Agents, sessions, snapshots, and bidi streaming moved behind `package:genkit/experimental.dart`, which triggers the `experimental_member_use` analyzer warning on import.
- `agents()` is no longer re-exported from `genkit_middleware`; import `package:genkit_middleware/agents.dart`.
- Plugin authors: `defineMiddleware` is now `generateMiddleware`, and app code gets `ai.defineGenerateMiddleware`.

If you serve Genkit flows to a mobile client, the safe upgrade order is: ship the server on 1.0.0 with `sendLegacyErrorFrame: true`, release the Flutter app on the 1.0 client, and drop the flag once your minimum supported app version is past 0.17.

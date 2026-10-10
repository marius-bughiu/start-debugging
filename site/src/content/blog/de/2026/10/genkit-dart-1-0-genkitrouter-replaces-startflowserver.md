---
title: "Genkit Dart 1.0: GenkitRouter ersetzt startFlowServer, und ältere Flutter-Clients benötigen ein Flag"
description: "Genkit Dart 1.0.0 friert die API ein, verlagert das HTTP-Serving in den Core mit GenkitRouter und ändert den gestreamten Fehler-Frame. Ausgelieferte Flutter-Apps mit einem 0.17-Client benötigen sendLegacyErrorFrame."
pubDate: 2026-10-10
tags:
  - "dart"
  - "flutter"
  - "genkit"
  - "ai-agents"
lang: "de"
translationOf: "2026/10/genkit-dart-1-0-genkitrouter-replaces-startflowserver"
translatedBy: "claude"
translationDate: 2026-10-10
---

Google hat [Genkit Dart 1.0.0](https://github.com/genkit-ai/genkit-dart/releases/tag/genkit-v1.0.0) am 7. Oktober 2026 getaggt, die [Ankündigung im Flutter-Blog](https://flutter.dev/blog/announcing-genkit-dart-1-0) folgte am 8. Oktober. Das Core-Paket `genkit`, `schemantic` sowie die Plugins für Google GenAI, Vertex AI, Anthropic, OpenAI, MCP, Middleware und shelf sind jetzt 1.0.0 und unterliegen Semver. `genkit_otel`, `genkit_chrome`, `genkit_firebase_ai` und `genkit_a2ui` bleiben bei 0.x.

Die Release Notes sind offen darüber, dass das Einfrieren der API "a lot of breaking changes" bedeutete. Die meisten davon sind Umbenennungen. Die eine, die eine bereits bei Ihren Nutzern installierte App brechen kann, betrifft das HTTP-Serving.

## startFlowServer entfällt, GenkitRouter lebt im Core

Bis 0.17 bedeutete das Bereitstellen von Flows `genkit_shelf` und `startFlowServer`. In 1.0 ist das HTTP-Serving nach `package:genkit/io.dart` gewandert, läuft auf reinem `dart:io`, und `genkit_shelf` ist zu einem dünnen Adapter geworden. `startFlowServer` und `FlowWithContextProvider` wurden entfernt ([#533](https://github.com/genkit-ai/genkit-dart/pull/533)):

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

Context Provider erhalten jetzt statt eines shelf-`Request` ein frameworkneutrales `RequestData` mit kleingeschriebenen Header-Namen. Zugriffe wie `request.headers['Authorization']` müssen daher zu `'authorization'` werden. Den Router können Sie außerdem mit `handleHttpRequest(request, basePath: '/api')` in Ihren eigenen Server einbinden.

## Der gestreamte Fehler-Frame hat sich geändert

Gestreamte Antworten verwenden jetzt `Content-Type: text/event-stream`, und ein fehlgeschlagener Stream endet mit einem `data:`-Frame, der den Fehler enthält, passend zu den Go- und Python-Servern. Ich habe einen Server mit zwei Flows unter Dart 3.12.2 mit `genkit` 1.0.0 betrieben, wobei der Streaming-Flow einen Chunk sendet und dann eine Exception wirft:

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

`POST /boom?stream=true` mit den Standardwerten von 1.0:

```text
content-type: text/event-stream

data: {"message":"partial"}

data: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Laut den Release Notes verstehen Clients aus genkit 0.17 und früher nur den alten `error:`-Frame. Ruft eine gegen 0.17 gebaute Flutter-App Ihr Backend auf, sieht dieser Client nach einem reinen Server-Upgrade Fehler nicht mehr so wie bisher. Das gilt für jede Version, die noch auf Smartphones installiert ist, die nicht aktualisiert wurden.

Die Lösung ist ein einzelnes Konstruktorargument:

```dart
final genkit = GenkitRouter(sendLegacyErrorFrame: true);
```

Ist es gesetzt, endet dieselbe Anfrage mit dem Legacy-Frame:

```text
data: {"message":"partial"}

error: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Aufrufe ohne Streaming sind nicht betroffen: `POST /hello` lieferte in beiden Modi `{"result":"Hello, Marius"}`.

## Weitere Umbenennungen, nach denen sich ein grep lohnt

- `ExecutablePrompt` heißt jetzt `Prompt<Input, Output>`, und Prompts liefern typisierten `output` zurück, so wie `generate` es tut.
- Agents, Sessions, Snapshots und bidirektionales Streaming liegen jetzt hinter `package:genkit/experimental.dart`, was beim Import die Analyzer-Warnung `experimental_member_use` auslöst.
- `agents()` wird nicht mehr aus `genkit_middleware` re-exportiert; importieren Sie `package:genkit_middleware/agents.dart`.
- Plugin-Autoren: `defineMiddleware` heißt jetzt `generateMiddleware`, und App-Code erhält `ai.defineGenerateMiddleware`.

Wenn Sie Genkit-Flows für einen mobilen Client bereitstellen, lautet die sichere Reihenfolge für das Upgrade: den Server mit 1.0.0 und `sendLegacyErrorFrame: true` ausliefern, die Flutter-App mit dem 1.0-Client veröffentlichen und das Flag entfernen, sobald Ihre minimal unterstützte App-Version über 0.17 liegt.

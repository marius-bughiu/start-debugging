---
title: "Genkit Dart 1.0: GenkitRouter substitui startFlowServer, e clientes Flutter antigos precisam de uma flag"
description: "O Genkit Dart 1.0.0 congela a API, move o serviço HTTP para o core com GenkitRouter e muda o frame de erro do streaming. Apps Flutter já publicados com um cliente 0.17 precisam de sendLegacyErrorFrame."
pubDate: 2026-10-10
tags:
  - "dart"
  - "flutter"
  - "genkit"
  - "ai-agents"
lang: "pt-br"
translationOf: "2026/10/genkit-dart-1-0-genkitrouter-replaces-startflowserver"
translatedBy: "claude"
translationDate: 2026-10-10
---

O Google marcou a tag do [Genkit Dart 1.0.0](https://github.com/genkit-ai/genkit-dart/releases/tag/genkit-v1.0.0) em 7 de outubro de 2026, e o [anúncio no blog do Flutter](https://flutter.dev/blog/announcing-genkit-dart-1-0) veio em 8 de outubro. O pacote principal `genkit`, o `schemantic` e os plugins Google GenAI, Vertex AI, Anthropic, OpenAI, MCP, middleware e shelf agora estão na versão 1.0.0 e seguem semver. `genkit_otel`, `genkit_chrome`, `genkit_firebase_ai` e `genkit_a2ui` continuam na 0.x.

As notas de versão avisam sem rodeios que congelar a API significou "a lot of breaking changes". A maioria são renomeações. A que pode quebrar um app que já está nas mãos dos seus usuários está no serviço HTTP.

## startFlowServer saiu, GenkitRouter vive no core

Até a 0.17, servir flows significava usar `genkit_shelf` e `startFlowServer`. Na 1.0, o serviço HTTP foi para `package:genkit/io.dart`, roda em `dart:io` puro, e o `genkit_shelf` virou um adaptador fino. `startFlowServer` e `FlowWithContextProvider` foram removidos ([#533](https://github.com/genkit-ai/genkit-dart/pull/533)):

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

Os context providers agora recebem um `RequestData` neutro em relação ao framework, em vez de um `Request` do shelf, com nomes de header em minúsculas, então consultas como `request.headers['Authorization']` precisam virar `'authorization'`. Você também pode montar o router dentro do seu próprio servidor com `handleHttpRequest(request, basePath: '/api')`.

## O frame de erro do streaming mudou

As respostas em streaming agora usam `Content-Type: text/event-stream`, e um stream que falha termina com um frame `data:` carregando o erro, igual aos servidores Go e Python. Executei um servidor com dois flows no Dart 3.12.2 com `genkit` 1.0.0, onde o flow de streaming envia um chunk e depois lança uma exceção:

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

`POST /boom?stream=true` com os padrões da 1.0:

```text
content-type: text/event-stream

data: {"message":"partial"}

data: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Segundo as notas de versão, clientes do genkit 0.17 e anteriores só entendem o frame antigo `error:`. Se um app Flutter compilado com a 0.17 está chamando o seu backend, atualizar só o servidor faz esse cliente deixar de ver os erros como via antes. Isso vale para qualquer versão ainda instalada em celulares que não foram atualizados.

A correção é um argumento do construtor:

```dart
final genkit = GenkitRouter(sendLegacyErrorFrame: true);
```

Com isso ativado, a mesma requisição termina com o frame legado:

```text
data: {"message":"partial"}

error: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Chamadas sem streaming não são afetadas: `POST /hello` retornou `{"result":"Hello, Marius"}` nos dois modos.

## Outras renomeações para procurar com grep

- `ExecutablePrompt` agora é `Prompt<Input, Output>`, e os prompts retornam `output` tipado, como o `generate`.
- Agents, sessions, snapshots e streaming bidirecional foram movidos para `package:genkit/experimental.dart`, o que dispara o aviso do analisador `experimental_member_use` na importação.
- `agents()` não é mais reexportado por `genkit_middleware`; importe `package:genkit_middleware/agents.dart`.
- Autores de plugins: `defineMiddleware` agora é `generateMiddleware`, e o código do app usa `ai.defineGenerateMiddleware`.

Se você serve flows do Genkit para um cliente móvel, a ordem segura de atualização é: publicar o servidor na 1.0.0 com `sendLegacyErrorFrame: true`, lançar o app Flutter com o cliente 1.0 e remover a flag quando a versão mínima do app que você suporta for posterior à 0.17.

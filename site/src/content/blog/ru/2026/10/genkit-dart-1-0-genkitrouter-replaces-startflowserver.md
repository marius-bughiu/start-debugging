---
title: "Genkit Dart 1.0: GenkitRouter заменяет startFlowServer, а старым клиентам Flutter нужен флаг"
description: "Genkit Dart 1.0.0 фиксирует API, переносит HTTP-сервер в ядро через GenkitRouter и меняет потоковый фрейм ошибки. Выпущенным Flutter-приложениям с клиентом 0.17 нужен sendLegacyErrorFrame."
pubDate: 2026-10-10
tags:
  - "dart"
  - "flutter"
  - "genkit"
  - "ai-agents"
lang: "ru"
translationOf: "2026/10/genkit-dart-1-0-genkitrouter-replaces-startflowserver"
translatedBy: "claude"
translationDate: 2026-10-10
---

Google выпустила [Genkit Dart 1.0.0](https://github.com/genkit-ai/genkit-dart/releases/tag/genkit-v1.0.0) 7 октября 2026 года, а 8 октября последовал [анонс в блоге Flutter](https://flutter.dev/blog/announcing-genkit-dart-1-0). Основной пакет `genkit`, `schemantic`, а также плагины Google GenAI, Vertex AI, Anthropic, OpenAI, MCP, middleware и shelf теперь имеют версию 1.0.0 и подчиняются semver. Пакеты `genkit_otel`, `genkit_chrome`, `genkit_firebase_ai` и `genkit_a2ui` остаются на 0.x.

В примечаниях к релизу прямо сказано, что фиксация API означала "много критических изменений". Большинство из них - переименования. Одно из них способно сломать приложение, которое уже установлено у ваших пользователей, и касается HTTP-сервера.

## startFlowServer удалён, GenkitRouter теперь в ядре

До версии 0.17 для публикации flow использовались `genkit_shelf` и `startFlowServer`. В 1.0 HTTP-сервер переехал в `package:genkit/io.dart`, работает на чистом `dart:io`, а `genkit_shelf` стал тонким адаптером. `startFlowServer` и `FlowWithContextProvider` удалены ([#533](https://github.com/genkit-ai/genkit-dart/pull/533)):

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

Провайдеры контекста теперь получают не shelf `Request`, а независимый от фреймворка `RequestData` с именами заголовков в нижнем регистре, поэтому обращения `request.headers['Authorization']` нужно заменить на `'authorization'`. Роутер также можно подключить внутри собственного сервера через `handleHttpRequest(request, basePath: '/api')`.

## Фрейм ошибки в потоковом ответе изменился

Потоковые ответы теперь используют `Content-Type: text/event-stream`, а неудачный поток завершается фреймом `data:` с ошибкой, как в серверах на Go и Python. Я запустил сервер с двумя flow на Dart 3.12.2 и `genkit` 1.0.0, где потоковый flow отправляет один фрагмент и затем выбрасывает исключение:

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

`POST /boom?stream=true` с настройками 1.0 по умолчанию:

```text
content-type: text/event-stream

data: {"message":"partial"}

data: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Согласно примечаниям к релизу, клиенты genkit 0.17 и более ранних версий понимают только старый фрейм `error:`. Если к вашему бэкенду обращается Flutter-приложение, собранное на 0.17, то после обновления одного лишь сервера такой клиент перестанет получать ошибки так, как раньше. Это касается любой версии, которая всё ещё стоит на телефонах, не получивших обновление.

Исправление - один аргумент конструктора:

```dart
final genkit = GenkitRouter(sendLegacyErrorFrame: true);
```

С этим флагом тот же запрос завершается устаревшим фреймом:

```text
data: {"message":"partial"}

error: {"error":{"code":500,"status":"INTERNAL","message":"nope"}}
```

Непотоковые вызовы не затронуты: `POST /hello` вернул `{"result":"Hello, Marius"}` в обоих режимах.

## Другие переименования, которые стоит поискать через grep

- `ExecutablePrompt` теперь называется `Prompt<Input, Output>`, а промпты возвращают типизированный `output`, как и `generate`.
- Агенты, сессии, снимки и двунаправленная потоковая передача перенесены в `package:genkit/experimental.dart`, импорт которого вызывает предупреждение анализатора `experimental_member_use`.
- `agents()` больше не реэкспортируется из `genkit_middleware`; импортируйте `package:genkit_middleware/agents.dart`.
- Авторам плагинов: `defineMiddleware` теперь называется `generateMiddleware`, а в коде приложения доступен `ai.defineGenerateMiddleware`.

Если вы обслуживаете flow Genkit для мобильного клиента, безопасный порядок обновления такой: выпустить сервер на 1.0.0 с `sendLegacyErrorFrame: true`, выпустить Flutter-приложение с клиентом 1.0 и убрать флаг, когда минимальная поддерживаемая версия приложения окажется новее 0.17.

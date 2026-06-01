---
title: "Как корректно обрабатывать сетевые ошибки в приложении Flutter"
description: "Запрос может завершиться неудачей из-за отсутствия связи, тайм-аута, сбоя DNS, ответа 500 или некорректного JSON, и каждый случай требует своей реакции. Здесь показано, как перехватывать нужные исключения, классифицировать их, безопасно повторять запрос и показывать интерфейс, на который пользователь может отреагировать."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "networking"
lang: "ru"
translationOf: "2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app"
translatedBy: "claude"
translationDate: 2026-06-01
---

Сетевой вызов во Flutter завершается неудачей как минимум пятью различными способами, и аккуратное приложение обрабатывает каждый из них по-своему: отсутствие связи, тайм-аут соединения, сбой DNS или сокета, статус HTTP, отличный от 2xx, и некорректное или неожиданное тело ответа. Решение состоит в том, чтобы перехватывать конкретный тип исключения вместо голого `catch (e)`, отображать его на небольшой набор видимых пользователю состояний (offline, тайм-аут, ошибка сервера, повторяемая, фатальная), оборачивать вызов в тайм-аут и ограниченный повтор с backoff и отрисовывать состояние, на которое пользователь действительно может отреагировать, вместо спиннера, который никогда не разрешается. В этом руководстве используются Flutter 3.44 (stable, май 2026), Dart 3.x, пакет `http` 1.x, `dio` 5.9.2 и `connectivity_plus` 7.1.1.

Ошибка, которую почти каждое приложение Flutter совершает в начале, состоит в том, чтобы рассматривать "сеть" как единственный режим отказа. Вы оборачиваете вызов в `try`/`catch`, показываете snackbar с надписью "Что-то пошло не так" и идёте дальше. Но "нет Wi-Fi" и "сервер вернул 503" -- это не одна и та же проблема, а пользователь, глядя на общую ошибку, не имеет понятия, повторять ли запрос, ждать или сдаться. Хуже того, самая частая ошибка даже не доходит до catch: `Future`, который никогда не завершается, потому что тайм-аута не было, оставляя спиннер крутиться вечно.

## Исключения, которые HTTP-вызов Flutter действительно выбрасывает

Когда вы используете `dart:io` и пакет `http`, неуспешный запрос проявляется как типизированное исключение, и тип говорит вам, что пошло не так:

- `SocketException` выбрасывается, когда само соединение не может быть установлено или обрывается: нет маршрута к хосту, сбой разрешения DNS, соединение отклонено или устройство offline. Это группа "сеть недоступна".
- `TimeoutException` (из `dart:async`) выбрасывается, когда вы оборачиваете `Future` в `.timeout(...)` и заданная длительность истекает. Пакет `http` сам по себе не завершается по тайм-ауту, поэтому, если вы его не добавите, зависшее соединение блокирует ваш интерфейс на неопределённое время.
- `HttpException` и `ClientException` охватывают проблемы уровня протокола: некорректный ответ, соединение, закрытое посреди ответа, или цикл перенаправлений.
- `FormatException` выбрасывается `jsonDecode`, когда тело не является корректным JSON. Ответ 200 OK с HTML-страницей ошибки (captive portal, прокси, неправильно настроенный шлюз) попадает сюда, а не в одну из сетевых групп. Эту конкретную ловушку я разобрал в [в руководстве про FormatException Unexpected character](/ru/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/).

Статус, отличный от 2xx, вообще не является исключением в пакете `http`. `http.get` возвращает `Response` со `statusCode == 500`, и вы должны проверить это сами. Это самая частая причина, по которой приложение молча показывает пустые данные: разработчик распарсил `response.body` как JSON, ни разу не взглянув на `response.statusCode`, а тело было полезной нагрузкой с ошибкой.

## Воспроизведение, которое всё проглатывает

Вот шаблон, которого следует избегать. Он компилируется, работает на быстром соединении и ломается всеми интересными способами.

```dart
// Flutter 3.44, Dart 3.x, http 1.x -- anti-pattern, do not copy.
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<String>> fetchNames() async {
  try {
    final response =
        await http.get(Uri.parse('https://api.example.com/names'));
    final data = jsonDecode(response.body) as List;
    return data.cast<String>();
  } catch (e) {
    return []; // every failure looks like "no data"
  }
}
```

Здесь сломаны три вещи. Нет тайм-аута, поэтому застрявшее соединение зависает навсегда. Статус никогда не проверяется, поэтому ответ 500 с JSON-телом ошибки либо выбрасывает исключение в `cast`, либо возвращает мусор. А `catch (e)` сворачивает offline, тайм-аут, ошибку сервера и некорректный JSON в один результат: пустой список, неотличимый от "на сервере законно нет имён". Интерфейс не может сказать пользователю ничего полезного, потому что функция выбросила единственную информацию, которая имела значение.

## Классифицируйте сбой в результат, который интерфейс может отрисовать

Первое настоящее исправление -- перестать возвращать голые данные и начать возвращать результат, который кодирует, чем закончился вызов. Иерархия запечатанных классов (sealed classes из Dart 3) заставляет компилятор обязать вас обработать каждый случай.

```dart
// Flutter 3.44, Dart 3.x
sealed class NetworkResult<T> {
  const NetworkResult();
}

class Success<T> extends NetworkResult<T> {
  final T data;
  const Success(this.data);
}

class Offline<T> extends NetworkResult<T> {
  const Offline();
}

class TimedOut<T> extends NetworkResult<T> {
  const TimedOut();
}

class ServerError<T> extends NetworkResult<T> {
  final int statusCode;
  const ServerError(this.statusCode);
}

class BadResponse<T> extends NetworkResult<T> {
  final String detail;
  const BadResponse(this.detail);
}
```

Теперь слой данных отображает каждый тип исключения и каждый статус на одно из этих значений, и ничто не утекает как необработанный throw:

```dart
// Flutter 3.44, Dart 3.x, http 1.x
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await http
        .get(Uri.parse('https://api.example.com/names'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode >= 500) {
      return ServerError(response.statusCode);
    }
    if (response.statusCode >= 400) {
      // 4xx is usually a client bug or auth issue, not retryable.
      return BadResponse('HTTP ${response.statusCode}');
    }

    final decoded = jsonDecode(response.body) as List;
    return Success(decoded.cast<String>());
  } on SocketException {
    return const Offline();
  } on TimeoutException {
    return const TimedOut();
  } on FormatException catch (e) {
    return BadResponse('Malformed JSON: ${e.message}');
  } on http.ClientException catch (e) {
    return BadResponse(e.message);
  }
}
```

Обратите внимание на порядок предложений `on`. Dart вычисляет их сверху вниз и выполняет первое совпадение, поэтому ставьте наиболее конкретные исключения первыми. `TimeoutException` и `SocketException` -- это родственники, а не родитель и потомок, поэтому их взаимный порядок не имеет значения, но `FormatException` и `ClientException` должны идти перед любым широким `catch`. Здесь намеренно нет голого `catch (e)`, потому что, если будет выброшено какое-то исключение, которого я не предвидел, я хочу, чтобы оно упало в режиме отладки и появилось в моём отчёте об ошибках, а не молча отображалось на `BadResponse`.

## Отрисуйте каждую ветку в виджете

Поскольку `NetworkResult` -- запечатанный класс, выражение `switch` в виджете является исчерпывающим: добавьте новый тип результата, и компилятор отметит каждый `switch`, который его не обрабатывает. В этом и состоит выгода запечатанной иерархии.

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

Widget buildBody(NetworkResult<List<String>> result, VoidCallback onRetry) {
  return switch (result) {
    Success(data: final names) => ListView(
        children: [for (final n in names) ListTile(title: Text(n))],
      ),
    Offline() => _ErrorState(
        message: 'You appear to be offline. Check your connection.',
        onRetry: onRetry,
      ),
    TimedOut() => _ErrorState(
        message: 'The request took too long. Try again.',
        onRetry: onRetry,
      ),
    ServerError(statusCode: final code) => _ErrorState(
        message: 'The server had a problem (HTTP $code). Try again shortly.',
        onRetry: onRetry,
      ),
    BadResponse(detail: final detail) => _ErrorState(
        message: 'Something went wrong. ($detail)',
        onRetry: null, // not retryable, retry will not help
      ),
  };
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const _ErrorState({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: FilledButton(onPressed: onRetry, child: const Text('Retry')),
            ),
        ],
      ),
    );
  }
}
```

Различие, которое важно для пользователя: `Offline`, `TimedOut` и `ServerError` предлагают кнопку повтора, потому что повтор может оказаться успешным. `BadResponse` -- нет, потому что некорректная полезная нагрузка или ответ 400 при следующей попытке завершатся неудачей точно так же, а кнопка повтора, которая никогда не работает, хуже, чем отсутствие кнопки. Держите виджет ошибки простым, чтобы он не вносил вторую ошибку; экран ошибки, который сам переполняется, выглядит плохо, и [руководство о переполнении RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) объясняет, почему это происходит.

## Повторяйте временные сбои с экспоненциальным backoff

`Offline`, `TimedOut` и `ServerError` (в частности 502, 503, 504) являются временными: тот же запрос может оказаться успешным через несколько секунд. Аккуратное приложение повторяет их автоматически ограниченное число раз, с возрастающей задержкой, чтобы не долбить страдающий сервер. Не повторяйте 4xx и не повторяйте вечно.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'dart:io';

Future<T> withRetry<T>(
  Future<T> Function() action, {
  int maxAttempts = 3,
  Duration baseDelay = const Duration(milliseconds: 400),
}) async {
  var attempt = 0;
  while (true) {
    attempt++;
    try {
      return await action();
    } on SocketException {
      if (attempt >= maxAttempts) rethrow;
    } on TimeoutException {
      if (attempt >= maxAttempts) rethrow;
    }
    // 2^attempt backoff: 0.8s, 1.6s, 3.2s ...
    final delay = baseDelay * (1 << attempt);
    await Future<void>.delayed(delay);
  }
}
```

`1 << attempt` -- это битовый сдвиг, который удваивает множитель на каждом круге, что является самым дешёвым способом записать экспоненциальный backoff. В продакшене вам также нужен jitter (небольшое случайное смещение), чтобы тысяча клиентов, восстанавливающихся после одного и того же сбоя, не повторяли все на одном такте и не создавали лавину, но базовая форма -- этот цикл. Оборачивайте HTTP-вызов, а не всю функцию `fetchNames`, чтобы повтор видел сырое исключение до того, как оно отобразится на `NetworkResult`. Если работа внутри повторяемого действия нагружает процессор (например, декодирование огромной полезной нагрузки), вынесите её из isolate интерфейса, как описано в [в руководстве по isolate в Dart](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), потому что повторы умножают эту стоимость.

## dio даёт типизированные ошибки и interceptor для повторов

Пакет `http` нормален, но `dio` 5.9.2 оборачивает каждый сбой в единственное `DioException`, чьё поле `type` уже классифицирует сбой за вас, что убирает большую часть ручной обвязки `on SocketException`. Перечисление `DioExceptionType` имеет восемь значений: `connectionTimeout`, `sendTimeout`, `receiveTimeout`, `badCertificate`, `badResponse`, `cancel`, `connectionError` и `unknown`. Вы настраиваете тайм-ауты один раз на `BaseOptions`, и они применяются к каждому запросу.

```dart
// Flutter 3.44, Dart 3.x, dio 5.9.2
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://api.example.com',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 10),
));

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await dio.get<List<dynamic>>('/names');
    return Success((response.data ?? []).cast<String>());
  } on DioException catch (e) {
    return switch (e.type) {
      DioExceptionType.connectionError => const Offline(),
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout =>
        const TimedOut(),
      DioExceptionType.badResponse =>
        ServerError(e.response?.statusCode ?? 0),
      _ => BadResponse(e.message ?? 'Unknown dio error'),
    };
  }
}
```

`dio` также проверяет статусы по умолчанию: ответ, отличный от 2xx, выбрасывает `DioException` с `type == badResponse` вместо тихого возврата, поэтому ошибка "забыл проверить статус" не может произойти. А поскольку `dio` предоставляет конвейер interceptor, вы можете подключить логику повтора централизованно, а не оборачивать каждый вызов. Пакет сообщества `dio_smart_retry` встраивается в этот конвейер и повторяет идемпотентные запросы с backoff "из коробки", что стоит принять, как только у вас появится больше горстки endpoint.

## connectivity_plus сообщает о радиомодуле, а не об интернете

Частый запрос -- "проверить, в сети ли пользователь, перед выполнением вызова". `connectivity_plus` 7.1.1 делает часть этого, но внимательно прочтите его собственное предупреждение: доступность типа соединения не гарантирует доступ в интернет. Начиная с версии 5, API возвращает `List<ConnectivityResult>` (устройство может одновременно быть в Wi-Fi и в сотовой сети), а не одиночное значение, что сбивает с толку код, написанный по старым примерам.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
import 'package:connectivity_plus/connectivity_plus.dart';

Future<bool> hasNetworkInterface() async {
  final results = await Connectivity().checkConnectivity();
  return !results.contains(ConnectivityResult.none);
}
```

Ловушка в том, чтобы рассматривать это как шлагбаум: "если подключено, запрос будет успешным". Не будет. Телефон сообщает `wifi`, пока подключён к сети кофейни, не авторизованной через её captive portal, поэтому каждый запрос всё равно завершается неудачей с `SocketException` или тайм-аутом. Используйте `connectivity_plus`, чтобы реагировать на изменения (показать офлайн-баннер в момент, когда радиомодуль пропадает, скрыть его, когда он возвращается) и чтобы решить, стоит ли вообще пытаться повторять, но никогда как замену фактической обработке исключения от запроса. Проверка связи -- это оптимизация, обработчик исключений -- источник истины.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
// React to connectivity changes for a live offline banner.
final sub = Connectivity().onConnectivityChanged.listen(
  (List<ConnectivityResult> results) {
    final online = !results.contains(ConnectivityResult.none);
    // update a banner; this stream's subscription must be cancelled
    // in dispose() like any other.
  },
);
```

Эта `StreamSubscription` -- именно тот вид ресурса, который утекает, если вы забудете её отменить, а это и есть вся тема [освобождения контроллеров и подписок во Flutter](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## Граничные случаи, которые отличают надёжное приложение от демо

**Отмена при dispose.** Если пользователь уходит с экрана посреди запроса, `Future` всё равно может завершиться и вызвать `setState` на уже несуществующем `State`, выбросив исключение. Защититесь с помощью `if (!mounted) return;` после каждого `await` в виджете или перенесите вызов в слой управления состоянием, который переживает навигацию. Неправильно обработанное владение здесь -- повторяющаяся тема при перестройке приложения, что отчасти и объясняет, почему [миграция с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) должна внимательно относиться к тому, где живёт асинхронная работа.

**Тайм-ауты должны быть короче терпения пользователя, а не сервера.** Тайм-аут в 30 секунд технически корректен и ужасен как опыт. Выберите connect timeout около 5 секунд и receive timeout около 10 и показывайте повтор задолго до того, как пользователь решит, что приложение зависло.

**Ответ 200 с неправильным телом всё равно является сбоем.** Относитесь к валидации схемы как к части сетевой обработки. Если `jsonDecode` успешен, но отсутствует обязательное поле, это `BadResponse`, а не `Success`. Проверяйте форму до того, как строить вашу модель, иначе вы протолкнёте сбой глубоко в интерфейс, где его гораздо труднее диагностировать.

**Не логируйте и не делайте rethrow на каждом слое.** Выберите одно место (отображение исключений в слое данных), чтобы записать ошибку вместе с её трассировкой стека, и пусть типизированный результат несёт остальное. Запись одного и того же исключения трижды, пока оно всплывает вверх, лишь делает ваши отчёты о сбоях более шумными.

**Повторы усиливают нагрузку во время сбоя.** Когда backend уже страдает, агрессивные повторы клиента делают только хуже. Ограничьте число попыток, используйте backoff с jitter и уважайте заголовок `Retry-After`, если сервер его отправляет. Корректная деградация так же связана с тем, чтобы быть хорошим клиентом, как и с тем, чтобы показать красивый экран ошибки.

Сквозная идея в том, что "обработка сетевых ошибок" -- это на самом деле три задачи, которые люди сворачивают в одну: перехватить конкретный сбой, классифицировать его в нечто, о чём интерфейс и логика повтора могут рассуждать, и представить его как состояние, на которое пользователь может отреагировать. Сделайте правильно типизированные предложения `catch` и запечатанный результат, добавьте ограниченный backoff для временных случаев и относитесь к `connectivity_plus` как к подсказке, а не как к гарантии, и общий snackbar "Что-то пошло не так" исчезнет из вашего приложения навсегда.

## Связанное

- [Как освобождать контроллеры во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) рассказывает об отмене `StreamSubscription`, которую создаёт слушатель связи.
- [Fix: FormatException Unexpected character при разборе JSON в Dart](/ru/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) -- случай некорректного тела в деталях.
- [Как написать isolate в Dart для нагружающей процессор работы](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) -- место, где должно жить тяжёлое декодирование ответа, чтобы повторы не вызывали jank в интерфейсе.
- [Как мигрировать приложение Flutter с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) показывает, где должна жить асинхронная сетевая работа при смене управления состоянием.
- [Fix: RenderFlex overflowed во Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) не даёт вашим виджетам ошибки и загрузки ломать вёрстку.

## Источники

- [DioException class, справочник API dio](https://pub.dev/documentation/dio/latest/dio/DioException-class.html)
- [DioExceptionType enum, справочник API dio](https://pub.dev/documentation/dio/latest/dio/DioExceptionType.html)
- [connectivity_plus, pub.dev](https://pub.dev/packages/connectivity_plus)
- [Future.timeout, справочник API Dart](https://api.dart.dev/stable/dart-async/Future/timeout.html)
- [SocketException class, справочник API Dart](https://api.dart.dev/stable/dart-io/SocketException-class.html)
- [http package, pub.dev](https://pub.dev/packages/http)

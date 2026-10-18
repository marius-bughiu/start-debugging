---
title: "Как перехватывать необработанные асинхронные ошибки во Flutter с помощью runZonedGuarded и PlatformDispatcher.instance.onError"
description: "FlutterError.onError видит только ошибки, возникшие внутри колбэков фреймворка. Future без await, таймеры, потоки и код после await попадают в другое место. Здесь показано, какой обработчик какую ошибку ловит (замеры на Flutter 3.44.8), и настройка main(), которая перехватывает их все, в том числе в вебе."
pubDate: 2026-10-18
template: how-to
tags:
  - "flutter"
  - "dart"
  - "error-handling"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Короткий ответ:** во Flutter 3.44 нужны два обработчика, а не один. `FlutterError.onError` получает ошибки, возникшие внутри колбэков фреймворка (build, layout, paint, синхронный `onPressed`). `PlatformDispatcher.instance.onError` получает всё остальное, что никто не перехватил в корневом изоляте: `Future` без await, колбэк `Timer`, поток без `onError` и любой код, выполняющийся после `await`, включая тело `async`-обработчика кнопки. Задайте оба в начале `main()` и возвращайте `true` из колбэка диспетчера. `runZonedGuarded` - более старый способ поймать вторую группу, и он остаётся единственным вариантом во Flutter web, потому что веб-движок никогда не вызывает `PlatformDispatcher.onError`. Ошибки, возникшие в изоляте, который вы запускаете сами, не попадают ни в один из обработчиков, если не передать порт `onError`.

Все замеры ниже сделаны на Flutter 3.44.8 (stable) с Dart 3.12.2 на релизной сборке настольного приложения для macOS, которое вызывает каждый вид ошибки и записывает в журнал, какой обработчик её получил. Маршрутизация обработчиков одинакова на Android и iOS, поскольку она находится в общем коде движка и фреймворка.

## Почему FlutterError.onError пропускает асинхронные ошибки

Большинство вопросов вида "мой краш-репортер не видит эту ошибку" возникает из предположения, что `FlutterError.onError` - универсальный глобальный перехватчик. Это не так. Фреймворк вызывает его из собственных блоков `try`/`catch`: когда `build` виджета выбрасывает исключение, когда `RenderObject` выбрасывает его при layout или paint, когда выбрасывает колбэк распознавателя жестов, колбэк планировщика или обработчик сообщений платформы. Каждое из этих мест оборачивает ошибку в `FlutterErrorDetails` со строкой `context`, например "while handling a gesture" или "during a platform message callback", и передаёт её в `FlutterError.reportError`, который вызывает `FlutterError.onError`.

Ошибка, выброшенная тогда, когда в стеке вызовов нет ни одного кадра фреймворка, никогда не проходит через такие блоки `try`/`catch`. Рассмотрим эту кнопку:

```dart
// Flutter 3.44.8, Dart 3.12.2
ElevatedButton(
  onPressed: () async {
    await api.save();          // throws SocketException
    showSnackBar('Saved');
  },
  child: const Text('Save'),
)
```

Распознаватель жестов вызывает `onPressed`, замыкание выполняется до первого `await`, возвращает `Future`, и блок `try` распознавателя завершается без ошибок. Когда `api.save()` позднее падает, исключение завершает этот `Future` с ошибкой. Никто его не ожидает (распознаватель игнорирует возвращаемое значение), поэтому ошибка считается необработанной и поднимается вверх по цепочке зон. В корневой зоне движок Flutter направляет её в `PlatformDispatcher.instance.onError`. Если он не задан, ошибка выводится в журнал и игнорируется. Приложение продолжает работать, поэтому такие ошибки часто остаются незамеченными, пока пользователь не сообщит о кнопке, которая "ничего не делает".

## Матрица обработчиков по результатам замеров

Я собрал небольшое приложение для macOS на Flutter 3.44.8, которое после первого кадра вызывает один вид ошибки за запуск и записывает, какой обработчик её получил. Настройка была документированной: `FlutterError.onError` плюс `PlatformDispatcher.instance.onError` в `main()`, без зон.

| Что выбросило ошибку | Обработчик, который её получил |
| --- | --- |
| Синхронный throw в `onPressed` | `FlutterError.onError` (context: "while handling a gesture") |
| Throw в `build` | `FlutterError.onError` |
| Throw после `await` в `async`-обработчике `onPressed` | `PlatformDispatcher.instance.onError` |
| `Future.delayed(..., () => throw ...)` без await | `PlatformDispatcher.instance.onError` |
| Колбэк `Timer` | `PlatformDispatcher.instance.onError` |
| `Stream.error(...).listen((_) {})` без `onError` | `PlatformDispatcher.instance.onError` |
| `MethodChannel.invokeMethod` без await для отсутствующего канала | `PlatformDispatcher.instance.onError` (`MissingPluginException`) |
| `Isolate.run(() => throw ...)` без await | `PlatformDispatcher.instance.onError` |
| Точка входа `Isolate.spawn`, которая выбрасывает ошибку, порта `onError` нет | Ни один. Движок вывел `Unhandled exception` из `dart_isolate.cc` |
| То же, но с `onError: port.sendPort` | Слушатель `RawReceivePort` |

`Isolate.run` попадает в диспетчер, потому что повторно выбрасывает ошибку дочернего изолята в возвращаемый `Future` в корневом изоляте, а этот `Future` не ожидался. Обычный `Isolate.spawn` так не делает: ошибка умирает вместе с дочерним изолятом. Собственный комментарий документации движка к `onError` говорит об этом прямо: он "is not directly invoked by errors in child isolates of the root isolate."

## Рекомендуемый main() по шагам

Эта настройка перехватывает каждую строку таблицы на Android, iOS, macOS, Windows и Linux.

1. Вызовите `WidgetsFlutterBinding.ensureInitialized()` первым, если перед `runApp` выполняется любая асинхронная работа (инициализация краш-репортера, чтение настроек).
2. Назначьте `FlutterError.onError`. Вызовите внутри него `FlutterError.presentError(details)`, чтобы красный блок ошибки и вывод в консоль по-прежнему появлялись в отладочных сборках, затем передайте `details.exception` и `details.stack` вашему репортеру.
3. Назначьте `PlatformDispatcher.instance.onError`. Передайте ошибку и трассировку стека и верните `true`.
4. Вызовите `runApp`.
5. Для каждого изолята, созданного через `Isolate.spawn`, передайте порт `onError` и пересылайте всё, что в него приходит, тому же репортеру.

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ErrorReporter.instance.initialize();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details); // keep the debug console output
    ErrorReporter.instance.report(
      details.exception,
      details.stack ?? StackTrace.empty,
      fatal: false,
      context: details.context?.toDescription(),
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
    return true; // handled: do not print the default "Unhandled Exception"
  };

  runApp(const MyApp());
}

// For isolates you spawn yourself.
Future<Isolate> spawnReported<T>(void Function(T) entry, T message) {
  final errors = RawReceivePort((Object? pair) {
    final list = pair! as List<Object?>;
    ErrorReporter.instance.report(
      list[0]!,
      StackTrace.fromString(list[1]! as String),
      fatal: false,
    );
  });
  return Isolate.spawn(entry, message, onError: errors.sendPort);
}
```

Порт `onError` получает список из двух элементов: результат `toString()` ошибки и трассировку стека в виде строки. На границе изолята исходный тип исключения теряется, поэтому записывайте строку как есть, а не пытайтесь проверять её через `is`.

Если вы используете Firebase Crashlytics, его документированная настройка устроена так же: `FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError`, а `PlatformDispatcher.instance.onError` вызывает `recordError(error, stack, fatal: true)` и возвращает `true`. Другие краш-SDK, включая Sentry, устанавливают аналогичные обработчики при собственной инициализации, поэтому не перезаписывайте их позже, не вызвав предыдущий обработчик по цепочке.

## Что делает возвращаемое значение PlatformDispatcher.onError

Тип возвращаемого значения колбэка - `bool`, и это важно. Движок документирует его так: верните `true`, если вы обработали ошибку, иначе верните `false`, и "a fallback mechanism such as printing to stderr will be used". Я запустил случай с `Future` без await, когда колбэк возвращал `false`. Колбэк отработал, после чего движок дополнительно вывел `[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: unawaited Future` с полной трассировкой стека. При `true` сработал только мой обработчик.

Ни в одном из случаев процесс не завершился. Необработанная ошибка Dart во Flutter не роняет приложение: цикл событий продолжает работу со следующим событием. Это хорошо для пользователей, но плохо для наблюдаемости, потому что единственный симптом - не доведённое до конца действие. Если вам нужна политика fail-fast, реализуйте её сами в обработчике (например, `if (kReleaseMode) exit(1);`, как показано в документации Flutter для `FlutterError.onError`) и хорошо подумайте, прежде чем выпускать это в продакшен.

## runZonedGuarded: когда он всё ещё нужен

До Flutter 3.3 (август 2022), в котором появился `PlatformDispatcher.onError`, стандартным советом было оборачивать `runApp` в `runZonedGuarded`, чтобы каждая асинхронная ошибка из кода, работающего в этой зоне, попадала в его колбэк `onError`, а не в корневую зону. Это по-прежнему работает, и я проверил, что он ловит те же строки, что и диспетчер:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';

import 'package:flutter/material.dart';

void main() {
  runZonedGuarded(() {
    WidgetsFlutterBinding.ensureInitialized();
    FlutterError.onError = (details) {
      FlutterError.presentError(details);
      ErrorReporter.instance.report(details.exception, details.stack ?? StackTrace.empty);
    };
    runApp(const MyApp());
  }, (Object error, StackTrace stack) {
    ErrorReporter.instance.report(error, stack, fatal: true);
  });
}
```

При такой настройке `Future` без await, throw после `await` в `onPressed` и `Isolate.run` без await дошли до колбэка зоны. Ошибка из `build` по-прежнему попала в `FlutterError.onError`, потому что фреймворк перехватывает её раньше, чем она успевает стать ошибкой зоны. Значит, зона заменяет диспетчер, а не `FlutterError.onError`.

Если задать оба (диспетчер назначен внутри охраняемой зоны), побеждает зона. В моём запуске для `Future` без await сработал только колбэк `runZonedGuarded`, а `PlatformDispatcher.instance.onError` не вызывался ни разу, потому что ошибка была обработана до того, как достигла корневой зоны. Это безвредно, но означает, что краш-SDK, который полагается на диспетчер, ничего не увидит для ошибок, возникших внутри вашей зоны. Выберите один механизм.

В 2026 году есть три причины продолжать использовать зону:

- **Flutter web.** Веб-движок сохраняет колбэк и никогда его не вызывает. В исходниках 3.44.8 в файле `lib/web_ui/lib/src/engine/platform_dispatcher.dart` над сеттером стоит `// TODO(dnfield): make this work on web.`, а issue [flutter/flutter#100277](https://github.com/flutter/flutter/issues/100277) всё ещё открыт. В вебе `runZonedGuarded` - единственный способ глобально ловить асинхронные ошибки.
- **Значения зоны.** Если вы используете `zoneValues` (логгер в рамках запроса, тестовые часы), вы уже создаёте дочернюю зону и можете добавить обработчик ошибок туда.
- **Локальная обработка.** Зона может охватывать отдельную подсистему, например задачу синхронизации, чтобы её ошибки помечались и маршрутизировались отдельно от остального приложения.

Для кроссплатформенного приложения, которое также выходит в веб, прагматичная настройка такова: назначьте обработчик диспетчера (он покрывает мобильные и настольные платформы) и оборачивайте тело `main` в `runZonedGuarded` только когда `kIsWeb` равно true. Пусть оба колбэка указывают на одного и того же репортера.

## Предупреждение "Zone mismatch"

Начиная с Flutter 3.10, отладочные сборки проверяют, что биндинг был инициализирован в той же зоне, которая позже вызывает `runApp`. Вот типичный неверный вариант:

```dart
// Flutter 3.44.8: triggers "Zone mismatch" in debug builds
void main() {
  WidgetsFlutterBinding.ensureInitialized(); // root zone
  runZonedGuarded(() => runApp(const MyApp()), reportError); // child zone
}
```

Моя отладочная сборка сообщила об этом через `FlutterError.onError` с контекстом "during runApp":

```text
Zone mismatch.
The Flutter bindings were initialized in a different zone than is now being used.
```

Это предупреждение, а не сбой, и в моём запуске `Future` без await всё равно дошёл до колбэка зоны, потому что `initState` выполнялся в зоне `runApp`. Опасность в колбэках, которые биндинг зарегистрировал в движке, пока находился в корневой зоне: события указателя, сообщения платформы и колбэки кадров вызываются в той зоне, которая была текущей на момент регистрации. Ошибки из этих путей могут обойти вашу охраняемую зону, и именно эту несогласованность описывает предупреждение. Исправление: перенесите `ensureInitialized()` (и любой `await`, которому он нужен) внутрь тела `runZonedGuarded`, как в предыдущем разделе. Установите `BindingBase.debugZoneErrorsAreFatal = true` первой инструкцией `main`, если хотите, чтобы CI падал из-за этого.

## Подводные камни, которые всё равно скрывают ошибки

- **`catchError`, ничего не возвращающий.** `future.catchError((e) => log(e))` для `Future<int>` в Dart 3 выбрасывает `ArgumentError` во время выполнения, потому что обработчик обязан вернуть значение типа этого future. Используйте `try`/`await`/`catch`.
- **`unawaited()` скрывает намерение, а не ошибки.** Обёртка вызова в `unawaited(...)` убирает предупреждение линтера `unawaited_futures`, но ошибка всё равно уходит в диспетчер. Обычно это то, что нужно, но не считайте это обработкой ошибок.
- **`StreamSubscription` без `onError`.** Каждое событие ошибки в такой подписке считается необработанным. Для долгоживущего потока, который ошибается многократно, ваш репортер получит по отчёту на каждое событие. Добавляйте `onError` к подпискам, которыми вы владеете, и отменяйте их, как описано в [руководстве по dispose для StreamSubscription](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).
- **Нативные сбои.** Segfault в Kotlin-, Swift- или C-коде плагина никогда не доходит до Dart. Для них нужна нативная часть вашего краш-SDK.
- **`flutter test`.** Тестовый фреймворк запускает каждый тест в собственной зоне и проваливает тест при любой необработанной ошибке, поэтому обработчики, заданные в `main()`, виджет-тестами не проверяются. Тестируйте отправку отчётов, вызывая функции-обработчики напрямую.
- **Порядок обработчиков при наличии SDK.** Если SDK устанавливает `FlutterError.onError`, а вы потом назначаете его снова, вы молча его заменяете. Сохраните предыдущее значение (`final previous = FlutterError.onError;`) и вызывайте его из своего обработчика.

## Связанные материалы

- [How to handle network errors gracefully in a Flutter app](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) рассказывает о перехвате ошибок там, где они возникают, что всегда лучше, чем полагаться на глобальный обработчик.
- [How to write a Dart isolate for CPU-bound work](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) объясняет разницу между `Isolate.run` и `Isolate.spawn`, от которой зависит, дойдёт ли ошибка изолята до корневого изолята вообще.
- [What is the difference between a Dart isolate and a thread](/ru/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/) объясняет, почему ошибки не могут пересечь границу изолята как объекты.
- [How to use BuildContext safely after an await in Flutter](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) рассматривает другую классическую ошибку в `async`-обработчиках кнопок.

## Источники

- Документация Flutter: [Handling errors in Flutter](https://docs.flutter.dev/testing/errors)
- Документация Flutter: [Zone mismatch message](https://docs.flutter.dev/release/breaking-changes/zone-errors) и [flutter/flutter#122836](https://github.com/flutter/flutter/pull/122836)
- Справочник API: [PlatformDispatcher.onError](https://api.flutter.dev/flutter/dart-ui/PlatformDispatcher/onError.html), [FlutterError.onError](https://api.flutter.dev/flutter/foundation/FlutterError/onError.html), [runZonedGuarded](https://api.dart.dev/stable/dart-async/runZonedGuarded.html), [Isolate.spawn](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- Issue: [Implement PlatformDispatcher.onError for web (flutter/flutter#100277)](https://github.com/flutter/flutter/issues/100277)
- Firebase: [Customize your Crashlytics crash reports (Flutter)](https://firebase.google.com/docs/crashlytics/flutter/customize-crash-reports)

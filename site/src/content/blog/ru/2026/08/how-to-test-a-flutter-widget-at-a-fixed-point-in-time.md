---
title: "Как протестировать Flutter-виджет в фиксированный момент времени без замыкания withClock"
description: "Внутри testWidgets внешний clock из package:clock уже поддельный, но начинается с системного времени запуска теста. Зафиксируйте его для всего набора тестов, переопределив runTest в собственном AutomatedTestWidgetsFlutterBinding, который устанавливается из flutter_test_config.dart. Проверено на Flutter 3.44.2, clock 1.1.2, fake_async 1.3.3."
pubDate: 2026-08-24
template: how-to
tags:
  - "flutter"
  - "dart"
  - "testing"
  - "how-to"
  - "clock"
lang: "ru"
translationOf: "2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time"
translatedBy: "claude"
translationDate: 2026-08-24
---

Если виджет отображает "3 часа назад" или приветствует словами "Добрый вечер", его представление о `now` должно стать константой, прежде чем по выводу можно будет что-то проверять. Обычный совет состоит в том, чтобы обернуть каждое тело теста в `withClock(Clock.fixed(...), () async { ... })`, а это быстро превращается в шум. Есть способ лучше, и начинается он с факта, который почти все понимают неверно: **внутри `testWidgets` внешний `clock` из `package:clock` уже поддельный**. `FakeAsync.run` устанавливает его за вас, и продвигается он только при вызове `tester.pump`. Чего он не делает, так это не начинается с предсказуемого момента, потому что `FakeAsync()` инициализируется от реальных системных часов. Исправьте это единственное начальное значение, и весь набор тестов станет детерминированным без замыкания в каждом тесте. Всё описанное ниже запускалось на Flutter 3.44.2 (Dart 3.12.2), `clock` 1.1.2 и `fake_async` 1.3.3.

## Что на самом деле возвращает clock.now() внутри testWidgets

Начнём с минимально возможной пробы. Никаких файлов конфигурации, никаких собственных биндингов:

```dart
// Flutter 3.44.2, Dart 3.12.2, clock 1.1.2
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('the ambient clock is already fake', (WidgetTester tester) async {
    final a = clock.now();
    await tester.pump(const Duration(hours: 1));
    final b = clock.now();
    print('a=$a');
    print('b=$b delta=${b.difference(a)}');
    print('DateTime.now delta=${DateTime.now().difference(a)}');
  });
}
```

Вывод `flutter test`:

```text
a=2026-08-24 09:19:57.248297
b=2026-08-24 10:19:57.248297 delta=1:00:00.000000
DateTime.now delta=0:00:00.094231
```

Отсюда следуют две вещи. Разница между двумя вызовами `clock.now()` составляет *ровно* один час с точностью до микросекунды, чего реальные часы никогда не дают. А `DateTime.now()` сдвинулся на 94 миллисекунды, то есть на фактическую длительность теста. Значит, `clock` поддельный, а `DateTime.now()` настоящий.

Вся обвязка находится в `fake_async`. `FakeAsync.run` сам оборачивает свой callback в `withClock`:

```dart
// fake_async 1.3.3, lib/fake_async.dart
T run<T>(T Function(FakeAsync self) callback) => runZoned(
      () => withClock(_clock, () => callback(this)),
      // ...timer and microtask interception...
    );
```

А `AutomatedTestWidgetsFlutterBinding.runTest` (в `packages/flutter_test/lib/src/binding.dart`) выполняет всё тело теста именно внутри этого:

```dart
final fakeAsync = FakeAsync();
_currentFakeAsync = fakeAsync; // reset in postTest
_clock = fakeAsync.getClock(DateTime.utc(2015));
fakeAsync.run((FakeAsync localFakeAsync) { /* test body */ });
```

Обратите внимание на два разных объекта часов. `fakeAsync.getClock(DateTime.utc(2015))` сохраняется как собственные часы биндинга, поэтому `tester.binding.clock.now()` в свежем тесте сообщает `2015-01-01T00:00:00.000Z` и продвигается при `pump`:

```text
binding.clock            = 2015-01-01T00:00:00.000Z
binding.clock after pump(10m) = 2015-01-01T00:10:00.000Z
```

Часы, которые ваши виджеты видят через `package:clock`, это *другой* `Clock` над тем же `FakeAsync`, и его точка отсчёта берётся из конструктора `FakeAsync`:

```dart
// fake_async 1.3.3
FakeAsync({DateTime? initialTime, this.includeTimerStackTrace = true}) {
  final nonNullInitialTime = initialTime ?? clock.now();
  _clock = Clock(() => nonNullInitialTime.add(elapsed));
}
```

`initialTime ?? clock.now()`. Биндинг вызывает `FakeAsync()` без аргумента, поэтому точкой отсчёта поддельных часов становится то, что показывали *внешние* часы в момент старта теста. За пределами любой зоны это системные часы. Это единственный источник недетерминизма, и именно им вы можете управлять.

## Почему withClock в flutter_test_config.dart ничего не даёт

Самая частая рекомендация для настройки всего набора тестов это `flutter_test_config.dart`. Выглядит так, будто должно работать:

```dart
// test/flutter_test_config.dart -- DOES NOT WORK
import 'dart:async';
import 'package:clock/clock.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  await withClock(
    Clock.fixed(DateTime.utc(2026, 3, 14, 9, 26, 53)),
    () async => testMain(),
  );
}
```

Здесь две ловушки. Первая это ошибка компиляции, если написать очевидное `return withClock(fixed, testMain)`: `withClock<T>` выводит `T` из возвращаемого типа, поэтому требует `Future<void> Function()`, тогда как `testExecutable` передаёт вам `FutureOr<void> Function()`. Приходится вставлять собственное замыкание.

Вторая ловушка в том, что даже после успешной компиляции эффекта нет. Печать по обе стороны делает порядок очевидным:

```text
CFG before testMain, zone clock=2026-08-24T09:16:56.269316
CFG inside zone, clock=2026-03-14T09:26:53.000Z
MAIN body, clock=2026-03-14T09:26:53.000Z
CFG testMain returned, still inside zone
CFG after zone
P12 body, clock=2026-08-24T09:16:56.295534
```

Зона покрывает верхнеуровневый `main()` файла теста, который лишь *объявляет* тесты через `test` и `testWidgets`. `package:test` выполняет каждое объявленное тело позже, из собственной цепочки зон, уже давно после возврата из `testExecutable`. `withClock` действует в пределах зоны, а покинутая зона ни на что влиять не может. Любая статья, советующая обернуть `testMain` в `withClock`, это никогда не проверяла.

Для чего `flutter_test_config.dart` действительно годится, так это для однократного выполнения кода перед набором тестов. Создание биндинга это ровно такой код.

## Три шага, чтобы зафиксировать часы для всего набора тестов

1. Объявите пакеты, которые собираетесь импортировать. `clock` идёт в `dependencies`, потому что производственный код будет вызывать `clock.now()`; `meta` добавляйте в `dev_dependencies` только если вам нужна ещё и аннотация `@isTest` из последнего раздела, иначе анализатор сообщит `depend_on_referenced_packages`.

   ```yaml
   # pubspec.yaml -- Flutter 3.44.2
   dependencies:
     flutter:
       sdk: flutter
     clock: ^1.1.2
   ```

2. Унаследуйтесь от `AutomatedTestWidgetsFlutterBinding` и переопределите `runTest` так, чтобы `super.runTest` выполнялся внутри зоны с фиксированными часами. В этом и весь приём: именно `super.runTest` создаёт `FakeAsync()`, а `FakeAsync` читает внешние часы для своего `initialTime`.

   ```dart
   // test/flutter_test_config.dart -- Flutter 3.44.2
   import 'dart:async';
   import 'package:clock/clock.dart';
   import 'package:flutter/foundation.dart';
   import 'package:flutter_test/flutter_test.dart';

   final DateTime kTestEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

   class FixedStartBinding extends AutomatedTestWidgetsFlutterBinding {
     @override
     Future<void> runTest(
       Future<void> Function() testBody,
       VoidCallback invariantTester, {
       String description = '',
     }) {
       return withClock(
         Clock.fixed(kTestEpoch),
         () => super.runTest(testBody, invariantTester, description: description),
       );
     }
   }
   ```

3. Создайте экземпляр биндинга в `testExecutable`, до запуска любого теста. `TestWidgetsFlutterBinding.ensureInitialized()` возвращает `_instance ?? binding.ensureInitialized(...)`, а конструктор `AutomatedTestWidgetsFlutterBinding` присваивает `_instance` через `initInstances`, поэтому побеждает тот биндинг, который создан первым. `testWidgets` подхватит ваш.

   ```dart
   Future<void> testExecutable(FutureOr<void> Function() testMain) async {
     FixedStartBinding();
     await testMain();
   }
   ```

Это всё. Изменений ни в одном файле теста не требуется. Виджет, который читает внешние часы:

```dart
// Flutter 3.44.2
class AmbientClockBanner extends StatelessWidget {
  const AmbientClockBanner({super.key});

  @override
  Widget build(BuildContext context) => Text(
        'ambient:${clock.now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}
```

теперь отрисовывается одинаково на любой машине и в любом запуске:

```text
binding      = FixedStartBinding
ambient      = 2026-03-14T09:26:53.000Z
binding.clock= 2015-01-01T00:00:00.000Z
rendered     = ambient:2026-03-14T09:26:53.000Z
```

А поскольку вы задали `FakeAsync` начальное значение, а не подменили его часы, поддельное время по-прежнему движется под вашим управлением:

```dart
testWidgets('advances with pump only', (WidgetTester tester) async {
  final a = clock.now();
  await tester.pump(const Duration(hours: 3, minutes: 30));
  final b = clock.now();
  print('a=$a b=$b delta=${b.difference(a)}');
});
// a=2026-03-14 09:26:53.000Z
// b=2026-03-14 12:56:53.000Z delta=3:30:00.000000
```

`clock.stopwatch()` подключён к тем же поддельным часам, поэтому `pump(Duration(seconds: 42))` даёт прошедшее время ровно `0:00:42.000000`. Каждый тест снова начинается с выбранной эпохи, потому что `runTest` каждый раз создаёт новый `FakeAsync`.

## Фиксированный старт против замороженных часов: решает место, куда вы поставили withClock

Есть второй вариант, и разница в одной строке вложенности. Оберните `testBody` вместо `super.runTest`, и ваша зона будет установлена *внутри* `FakeAsync.run`, а значит полностью перекроет поддельные часы:

```dart
// test/frozen/flutter_test_config.dart -- Flutter 3.44.2
class FrozenClockBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  Future<void> runTest(
    Future<void> Function() testBody,
    VoidCallback invariantTester, {
    String description = '',
  }) {
    return super.runTest(
      () => withClock(Clock.fixed(kFrozen), testBody),
      invariantTester,
      description: description,
    );
  }
}
```

Теперь `pump` продвигает время анимаций фреймворка, а `clock.now()` не сдвигается никогда:

```text
a=2026-03-14 09:26:53.000Z b=2026-03-14 09:26:53.000Z delta=0:00:00.000000
```

Ни один из вариантов не мешает анимациям, потому что `Ticker` и `SchedulerBinding` ориентируются на кадровые метки времени из `FakeAsync`, а не на `package:clock`. `showDialog` вместе с `pumpAndSettle` под замороженным биндингом по-прежнему завершается и находит диалог. Выбирайте по тому, что именно проверяете:

| | Обернуть `super.runTest` | Обернуть `testBody` |
| --- | --- | --- |
| Начальный момент | фиксирован | фиксирован |
| Продвигается при `pump` | да | нет |
| Механизм | задаёт `FakeAsync.initialTime` | перекрывает часы `FakeAsync` |
| Подходит для | относительных метк времени, обратного отсчёта, debounce | приветствий вида "Добрый вечер", форматирования дат |

Чего делать не стоит: не создавайте ленивые часы, делегирующие собственным часам биндинга, как в `withClock(Clock(() => this.clock.now()), ...)`. Конструктор `FakeAsync` вызывает `clock.now()` до того, как биндинг вошёл в тест, а `AutomatedTestWidgetsFlutterBinding.clock` проверяет `inTest` через assert:

```text
'package:flutter_test/src/binding.dart': Failed assertion: line 2223 pos 12: 'inTest': is not true.
package:clock/src/clock.dart 44:26   Clock.now
package:fake_async/fake_async.dart 106:53   new FakeAsync
package:flutter_test/src/binding.dart 2482:23   AutomatedTestWidgetsFlutterBinding.runTest
```

Простой `Clock.fixed` снимает проблему целиком.

## Обёртка на каждый тест, когда нужно лишь в нескольких файлах

Если собственный биндинг это больше механики, чем вам хочется, напишите замыкание один раз в виде обёртки. Аннотация `@isTest` из `package:meta` устраивает и анализатор, и обнаружение тестов в IDE:

```dart
// Flutter 3.44.2, clock 1.1.2, meta 1.18.0
import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meta/meta.dart';

final DateTime kEpoch = DateTime.utc(2026, 3, 14, 9, 26, 53);

@isTest
void testWidgetsAt(
  String description,
  WidgetTesterCallback callback, {
  DateTime? at,
  bool skip = false,
}) {
  testWidgets(
    description,
    (WidgetTester tester) =>
        withClock(Clock.fixed(at ?? kEpoch), () => callback(tester)),
    skip: skip,
  );
}
```

Поскольку зона обёртки покрывает всё тело теста, каждая перестройка во время теста видит фиксированные часы, включая вызванные `tap` и `setState` после `await`. Это ключевое отличие от оборачивания только части теста. Если написать `await withClock(fixed, () async { await tester.pumpWidget(w); })`, а затем перестроить виджет после выхода из замыкания, перестройка выйдет за пределы зоны и молча вернётся к поддельным часам, начальное значение которых взято из системного времени. Я это измерил: внутри замыкания виджет отрисовал `2026-03-14T09:26:53.000Z`, а `pumpWidget` после него отрисовал `2026-08-24T09:15:30.029972`.

Локальный `withClock` по-прежнему перекрывает общий для биндинга, так что две техники сочетаются. Под `FixedStartBinding` тест, оборачивающий своё тело в `withClock(Clock.fixed(DateTime.utc(2031, 5, 2, 7)))`, отрисовывает `2031-05-02T07:00:00.000Z`.

## DateTime.now() подделать нельзя, и никакой биндинг вас не спасёт

`package:clock` это чистый поиск по зоне. Вся реализация верхнеуровневого геттера такова:

```dart
// clock 1.1.2, lib/src/default.dart
Clock get clock => Zone.current[_clockKey] as Clock? ?? const Clock();
```

Присваиваемой глобальной переменной нет. Нет и аналога для `DateTime.now()`, который идёт прямо в VM. Виджет, вызывающий его, полностью игнорирует поддельное время, даже целый год:

```text
raw:2026-08-24T09:19:57.370144
after pump(365 days) -> raw:2026-08-24T09:19:57.376244
```

Разница шесть микросекунд, оба значения реальные. Поэтому если ваш виджет или модель вызывает `DateTime.now()` напрямую, ничего из вышеописанного не поможет. Либо переведите эти места вызова на `clock.now()`, либо принимайте часы как зависимость и обойдитесь без зон совсем:

```dart
// Flutter 3.44.2
class InjectedClockBanner extends StatelessWidget {
  const InjectedClockBanner({required this.now, super.key});

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => Text(
        'injected:${now().toIso8601String()}',
        textDirection: TextDirection.ltr,
      );
}

// test
await tester.pumpWidget(InjectedClockBanner(now: () => kEpoch));
```

В новом коде я выбираю внедрение по той же причине, по которой [TimeProvider и FakeTimeProvider лучше внешних статических членов в .NET](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/): зависимость видна в конструкторе, а не спрятана в зоне. Переопределение биндинга это прагматичный ответ для существующей кодовой базы, которая уже опирается на `clock.now()`, или для сторонних пакетов, которые вы не можете править.

Если вы на Riverpod, то `Provider<Clock>`, переопределённый в `ProviderScope` теста, это та же идея с уже имеющейся у вас обвязкой, и она хорошо сочетается с подходами из [Notifier vs AsyncNotifier vs StreamNotifier](/ru/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/).

## Четыре нюанса, о которых стоит знать до коммита

**Обычные тела `test()` получают реальные часы.** `FakeAsync` существует только внутри `testWidgets`, поэтому `test('...')` в том же файле сообщает системное время и для `clock.now()`, и для `DateTime.now()`. Если фиксированные часы нужны и в модульных тестах, оборачивайте те тела через `withClock` или используйте `fakeAsync` из `package:fake_async` напрямую.

**`integration_test` и тесты, запускаемые через `flutter run`, идут в реальном времени.** Когда `FLUTTER_TEST` отсутствует, `flutter_test` выбирает `LiveTestWidgetsFlutterBinding`, чьи часы зашиты в коде:

```dart
// packages/flutter_test/lib/src/binding.dart
@override
Clock get clock => const Clock();
```

Ни `FakeAsync`, ни поддельных часов. Держите файл конфигурации в `test/`, а не в корне проекта, потому что обход поиска проверяет каталог на наличие `flutter_test_config.dart` до того, как проверит тот же каталог на маркер `pubspec.yaml`: конфигурация в корне применится и к `integration_test/`, где создание `AutomatedTestWidgetsFlutterBinding` конфликтовало бы с `IntegrationTestWidgetsFlutterBinding`. Не полагайтесь на зафиксированные часы в интеграционных тестах.

**Поиск файла конфигурации идёт от ближайшего.** `flutter_tools` поднимается от файла теста вверх в поисках `flutter_test_config.dart` и останавливается на первом каталоге, содержащем `pubspec.yaml`. Поэтому `test/frozen/flutter_test_config.dart` перекрывает `test/flutter_test_config.dart` для всего, что лежит под `test/frozen/`, и к конкретному тесту всегда применяется только один файл конфигурации. Так можно держать набор с замороженными часами и набор с фиксированным стартом рядом, но это же означает, что наслоить их нельзя.

**В веб-режиме всё так же.** `flutter test --platform chrome` идёт через `_binding_web.dart`, чей `ensureInitialized` тоже возвращает `AutomatedTestWidgetsFlutterBinding.ensureInitialized()`, а веб-бутстрап вызывает `testExecutable` точно так же. Собственный биндинг применяется без изменений.

Модель, которую стоит запомнить: `testWidgets` уже даёт вам поддельные часы, `FakeAsync` решает, откуда они начинаются, и единственный рычаг для этого решения это внешние часы в момент, когда `runTest` создаёт `FakeAsync`. Всё остальное сводится к выбору, с какой стороны от `super.runTest` стоит ваш `withClock`.

## Похожие материалы

- [Как тестировать зависящий от времени код с TimeProvider и FakeTimeProvider в .NET 11](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) разбирает ту же задачу в экосистеме .NET, где абстракция поставляется в составе BCL.
- [Как защитить setState проверкой mounted после асинхронного разрыва во Flutter](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) это вторая половина написания тестов виджетов, выживающих на границах `await`.
- [Как отменить StreamSubscription в dispose во Flutter](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/) важно здесь потому, что незавершённый таймер при разборке вызывает тот же assert из `_verifyInvariants`, что и незавершённые поддельные таймеры.
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier во Flutter](/ru/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) о том, как прокинуть внедрённые часы через переопределение провайдера, а не через зону.
- [Fix: A TextEditingController was used after being disposed во Flutter](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) о классе тестовых падений, которые появляются, когда поддельное время начинает двигаться большими скачками.

## Источники

- [Документация API `package:clock`](https://pub.dev/documentation/clock/latest/) и [реализация `withClock`](https://pub.dev/packages/clock), версия 1.1.2.
- [`package:fake_async`](https://pub.dev/packages/fake_async) 1.3.3, в частности конструктор `FakeAsync` и `FakeAsync.run`.
- [`AutomatedTestWidgetsFlutterBinding`](https://api.flutter.dev/flutter/flutter_test/AutomatedTestWidgetsFlutterBinding-class.html) и [`TestWidgetsFlutterBinding.clock`](https://api.flutter.dev/flutter/flutter_test/TestWidgetsFlutterBinding/clock.html) в справочнике API Flutter 3.44.
- [Документация библиотеки `flutter_test`](https://api.flutter.dev/flutter/flutter_test/flutter_test-library.html) о `flutter_test_config.dart` и `testExecutable`.
- Исходный код Flutter SDK на теге 3.44.2: `packages/flutter_test/lib/src/binding.dart`, `packages/flutter_test/lib/src/_binding_web.dart` и `packages/flutter_tools/lib/src/test/test_config.dart`.

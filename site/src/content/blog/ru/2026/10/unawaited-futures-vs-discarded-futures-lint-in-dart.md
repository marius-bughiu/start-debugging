---
title: "unawaited_futures и discarded_futures в Dart: какой линтер ловит какой вызов без await"
description: "unawaited_futures смотрит только внутрь async-тел, discarded_futures только внутрь синхронных, и оба пропускают стрелочные функции, tear-off и литералы коллекций. Разбор по случаям на Dart 3.12.2 и Flutter 3.44.8 и analysis_options.yaml, который я рекомендую."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "lints"
  - "async"
lang: "ru"
translationOf: "2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Короткий ответ:** два линтера делят работу по виду тела функции, в котором находится вызов. `unawaited_futures` сообщает о `Future`, потерянном внутри тела `async`. `discarded_futures` сообщает о `Future` (или `FutureOr`), потерянном внутри синхронного тела, а во Flutter это `initState`, `dispose` и каждый блок `onPressed: () { ... }`. На одной и той же строке они никогда не срабатывают вместе. Если включать только один, включайте `unawaited_futures`: он дешёвый, и каждое срабатывание, скорее всего, настоящая ошибка. Добавляйте `discarded_futures`, когда готовы писать `unawaited(...)` у каждого намеренного вызова "выстрелил и забыл" в коде виджетов. Всё ниже измерено с помощью `dart analyze` на Dart 3.12.2 (Flutter 3.44.8, `meta` 1.19.0).

Ни одно из правил не входит ни в наборы core и recommended пакета `package:lints`, ни в `package:flutter_lints` 6.0.0, поэтому свежий проект после `flutter create` не сообщает ни о том, ни о другом, пока вы их не включите.

## Сравнение вкратце

| | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- |
| Где смотрит | инструкции внутри тел `async` / `async*` | инструкции внутри синхронных тел |
| Какие типы сообщает | `Future` и подтипы (включая `TickerFuture`) | `Future`, подтипы и `FutureOr` |
| Доступно с | давно, до Dart 2.18 | Dart 2.18 |
| В `lints` / `flutter_lints` | нет / нет | нет / нет |
| Типичное срабатывание во Flutter | `Navigator.pushNamed(...)` внутри `onPressed: () async { ... }` | `_load();` в `initState`, `_controller.forward();` |
| Подавляется через `unawaited(...)` | да | да |
| Подавляется через `@awaitNotRequired` (`meta` 1.17.0+) | да | да |
| Массовое исправление через `dart fix --apply` | нет (только быстрое исправление в IDE) | нет (только быстрое исправление в IDE) |
| Уровень шума во Flutter-приложении | низкий | средний или высокий |

## Почему правил два, а не одно

Оба правила представляют собой тонкие обёртки над одним и тем же посетителем, `UnusedFuturesVisitor` в `pkg/linter/lib/src/util/unused_futures.dart`. Посетитель обходит три вида узлов: инструкции-выражения, секции каскадов и интерполяции строк. Для каждого выражения он спрашивает у правила, "интересно" ли оно, и этот фильтр и есть вся разница между двумя линтерами. Вот фильтр из `unawaited_futures.dart` на теге `3.12.2`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/unawaited_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule is not currently concerned with `FutureOr`.
  if (type == null || !type.isOrImplementsFuture) {
    return false;
  }
  // This rule is only concerned with code in async functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isAsynchronous ?? false;
},
```

А вот из `discarded_futures.dart`:

```dart
// dart-lang/sdk, tag 3.12.2, pkg/linter/lib/src/rules/discarded_futures.dart
isInteresting: (node) {
  var type = node.staticType;
  // This rule does concern itself with `FutureOr`.
  if (type == null || !type.isOrImplementsFutureOrFutureOr) {
    return false;
  }
  // This rule is only concerned with code in sync functions.
  return node.thisOrAncestorOfType<FunctionBody>()?.isSynchronous ?? false;
},
```

Из этого кода прямо следуют два вывода. Во-первых, решает ближайший охватывающий `FunctionBody`, а не внешний метод. Блочное замыкание `() { save(); }`, написанное внутри метода `async`, является синхронным телом, поэтому оно относится к `discarded_futures`. Во-вторых, `FutureOr` покрывается только на синхронной стороне. `FutureOr<int>`, потерянный внутри метода `async`, не будет замечен ни одним из правил.

Мотивация тоже разная. `unawaited_futures` нацелен на забытый `await`: вы уже находитесь в функции `async`, так что исправление занимает одно ключевое слово. `discarded_futures` нацелен на забытый `async`: синхронная функция, запускающая асинхронную работу, обычно означает, что сама функция должна была быть `async`, а её вызывающие должны были её дожидаться. Официальная документация `discarded_futures` говорит именно это и указывает на `unawaited_futures` как на правило, которое берёт управление, как только функция становится `async`.

## Набор случаев: что и где срабатывает

Я собрал в один файл все формы вызова, какие смог придумать, и запустил `dart analyze` с обоими правилами поверх `package:lints/recommended.yaml`:

```yaml
# analysis_options.yaml, Dart 3.12.2
include: package:lints/recommended.yaml
linter:
  rules:
    - unawaited_futures
    - discarded_futures
```

```dart
// Dart 3.12.2, meta 1.19.0
import 'dart:async';
import 'package:meta/meta.dart';

Future<void> save() async {}
FutureOr<int> maybeAsync() => 1;
@awaitNotRequired
Future<void> log(String m) async {}

class Repo {
  Future<void> flush() async {}
}

Future<void> asyncCaller() async {
  save(); // A1
  maybeAsync(); // A2 FutureOr in async
  final f = save(); // A3 assigned
  unawaited(save()); // A4
  log('x'); // A5 awaitNotRequired
  Repo()..flush(); // A6 cascade
  print('${save()}'); // A7 interpolation
  var list = [save()]; // A8 collection
  Future.delayed(Duration.zero, () => 1); // A9
  <String, Future<void>>{}.putIfAbsent('k', save); // A10
  void inner() {
    save(); // A11 sync closure inside async
  }
  [1].forEach((_) async {
    save(); // A12 async closure
  });
  save().then((_) {}); // A13 .then chain
  save().ignore(); // A14 ignore()
  await f;
  inner();
  list.length;
}

void syncCaller() {
  save(); // S1
  maybeAsync(); // S2 FutureOr in sync
  final f = save(); // S3 assigned
  unawaited(save()); // S4
  log('x'); // S5 awaitNotRequired
  Repo()..flush(); // S6 cascade
  takesFuture(save()); // S7 argument
  f.ignore();
}

Future<void> syncReturn() {
  return save(); // S8 returned
}

void takesFuture(Future<void> f) {}

void Function() handler = () => save(); // S9 arrow in sync closure
void Function() handler2 = () {
  save(); // S10 block sync closure
};
Future<void> Function() handler3 = () async {
  save(); // S11 async closure
};
```

Результаты, считанные с вывода `dart analyze`:

| Случай | Код | `unawaited_futures` | `discarded_futures` |
| --- | --- | --- | --- |
| A1 | `save();` в `async` | сообщает | - |
| A2 | `maybeAsync();` (`FutureOr`) в `async` | - | - |
| A3, S3 | `final f = save();` | - | - |
| A4, S4 | `unawaited(save());` | - | - |
| A5, S5 | вызываемый метод с `@awaitNotRequired` | - | - |
| A6 | `Repo()..flush();` в `async` | сообщает | - |
| A7 | `'${save()}'` в `async` | сообщает | - |
| A8 | литерал коллекции `[save()]` | - | - |
| A9 | `Future.delayed(d, computation)` | - | - |
| A10 | `Map.putIfAbsent` | - | - |
| A11 | блочное замыкание внутри метода `async` | - | сообщает |
| A12 | замыкание `async` | сообщает | - |
| A13 | `save().then((_) {});` | сообщает (на `then`) | - |
| A14 | `save().ignore();` | - | - |
| S1 | `save();` в синхронном коде | - | сообщает |
| S2 | `maybeAsync();` в синхронном коде | - | сообщает |
| S6 | `Repo()..flush();` в синхронном коде | - | сообщает |
| S7 | `takesFuture(save());` | - | - |
| S8 | `return save();` | - | - |
| S9 | стрелочное замыкание `() => save()` | - | - |
| S10 | `() { save(); }` | - | сообщает |
| S11 | `() async { save(); }` | сообщает | - |

Несколько строк заслуживают пары слов.

- **A9 и A10 являются жёстко заданными исключениями.** Посетитель пропускает `Future.delayed`, когда тот вызван с аргументом-вычислением, а также `Map.putIfAbsent`, потому что оба возвращают значения, которые люди обычно намеренно игнорируют.
- **A13 сообщается на `then`, а не на `save`.** `save().then(...)` возвращает новый `Future`, и потерян именно он. Цепочка `.then` не заменяет обработку результата.
- **A14 чист, потому что `Future.ignore()` возвращает `void`.** Это альтернатива `unawaited(...)` в виде вызова метода, доступная с Dart 2.14. В отличие от `unawaited`, он также глотает любую ошибку, которой завершается future, так что используйте его, только когда вам действительно всё равно.
- **S7 чист намеренно.** Передача future в параметр типа `Future<void>` передаёт ответственность вызываемому коду.

## Слепые зоны, общие для обоих правил

Две строки в этой таблице являются настоящими ложноотрицательными срабатываниями, и обе отслеживаются в upstream.

**Стрелочные тела (S9).** `() => save()` является синхронным телом-выражением, которое возвращает `Future`. Посетитель смотрит только на инструкции, поэтому ничего не срабатывает, даже если замыкание присвоено `void Function()` и вызывающий код выбрасывает future. Это [dart-lang/sdk#61155](https://github.com/dart-lang/sdk/issues/61155).

**Tear-off в колбэки `void`.** Я также запустил вот это:

```dart
// Dart 3.12.2
void execute(void Function() cb) => cb();

void tearoffs() {
  execute(save); // Future<void> Function() passed as void Function()
}
```

Ни одно из правил на это не сообщило. Dart позволяет передавать `Future<void> Function()` там, где ожидается `void Function()`, поэтому future теряется внутри `execute`, и ни один линтер его не видит. Этому посвящён [dart-lang/sdk#56921](https://github.com/dart-lang/sdk/issues/56921). Родственный линтер, `avoid_void_async`, ловит только функции `async`, объявленные как возвращающие `void`, но не tear-off.

Добавьте литералы коллекций (A8) и `FutureOr` внутри тел `async` (A2), и получится полный список форм, в которых потерянный future остаётся незамеченным. `unawaited` на сегодня также не принимает `FutureOr` ([dart-lang/sdk#63818](https://github.com/dart-lang/sdk/issues/63818)), поэтому для S2 чистое решение: `final _ = maybeAsync();` либо ожидание результата.

## Как это выглядит в виджете Flutter

Именно это разделение определяет уровень шума в приложении на Flutter, потому что большинство колбэков виджетов синхронны. На Flutter 3.44.8 с обоими правилами поверх `package:flutter_lints/flutter.yaml`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class _HomeState extends State<Home> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this);

  Future<void> _load() async {}

  @override
  void initState() {
    super.initState();
    _load(); // F1: discarded_futures
    _c.forward(); // F2: discarded_futures (TickerFuture implements Future)
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      TextButton(
        onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const Home())), // F3: nothing
        child: const Text('a'),
      ),
      TextButton(
        onPressed: () {
          Navigator.of(context).pushNamed('/x'); // F4: discarded_futures
        },
        child: const Text('b'),
      ),
      TextButton(
        onPressed: () async {
          await _load();
          if (!context.mounted) return;
          Navigator.of(context).pushNamed('/x'); // F5: unawaited_futures
        },
        child: const Text('c'),
      ),
    ]);
  }
}
```

F2 раздражает больше всего. `AnimationController.forward()`, `reverse()`, `repeat()` и `animateTo()` возвращают `TickerFuture`, и почти никто их не ожидает. При включённом `discarded_futures` каждый из них требует `unawaited(...)`. F1, напротив, это именно та ошибка, ради которой правило существует: `_load()` в `initState` выбрасывает свою ошибку в зону, а не в написанный вами `try`/`catch`, и если он вызывает `setState` после того, как виджета уже нет, вы попадаете на [территорию проверок mounted](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

F3 и F4 делают одно и то же. Сообщается только блочная форма, а значит, замена колбэка с `{ ... }` на `=>` заглушает `discarded_futures`, ничего не исправляя.

## Когда выбирать unawaited_futures

- **Вам нужно одно правило с почти нулевой долей ложных срабатываний.** Внутри функции `async` потерянный `Future` почти всегда означает забытый `await`, а переносимая им ошибка обойдёт ваш `try`/`catch` и попадёт в [`PlatformDispatcher.onError` или вашу защищённую зону](/ru/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/).
- **Вы пишете серверный или CLI-код на Dart.** `main` обычно `async`, поэтому большая часть кода покрыта, а в оставшемся синхронном коде редко запускается асинхронная работа.
- **Ваша команда уже использует колбэки `async`.** Если ваши обработчики имеют вид `onPressed: () async { ... }`, это правило их покрывает (F5).

## Когда добавлять discarded_futures

- **Вы публикуете пакет.** Синхронный публичный метод, который молча запускает асинхронную работу, является запахом API, и это правило находит каждый такой случай.
- **Вы хотите, чтобы "выстрелил и забыл" было видно на ревью.** При включённом правиле каждое намеренное отбрасывание выглядит как `unawaited(...)` или несёт `@awaitNotRequired` на вызываемом методе, в чём и состоит весь смысл.
- **У вас уже была ошибка из-за работы в `initState`, которую никто не ожидал.** Это случай F1, и видит его только это правило.

Если добавить его в существующее приложение на Flutter, ожидайте, что большинство срабатываний придётся на вызовы `AnimationController` и навигацию в блочных колбэках. Ни у одного из правил в Dart 3.12.2 нет массового исправления через `dart fix` (`dart fix --dry-run` в моём воспроизведении ничего для них не предложил), поэтому, в отличие от [миграций, которые можно применить по всему репозиторию с помощью `dart fix`](/ru/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/), эта чистка делается одним быстрым исправлением в IDE за раз.

## Пометка API как безопасных для отбрасывания через @awaitNotRequired

Для собственных API, задуманных как "выстрелил и забыл" (журналирование, аналитика, прогрев кеша), аннотируйте объявление, а не оборачивайте каждое место вызова:

```dart
// Dart 3.12.2, meta 1.19.0
import 'package:meta/meta.dart';

@awaitNotRequired
Future<void> track(String event) async {
  // send to analytics, errors handled inside
}

void onTap() {
  track('tap'); // neither rule reports this
}
```

`@awaitNotRequired` появился в `package:meta` 1.17.0, а в 1.18.1 его разрешили на typedef, так что параметр-колбэк, типизированный аннотированным typedef, тоже освобождается. Оба линтера учитывают его (A5 и S5 выше), а проверка обходит и переопределяемые члены, поэтому переопределение аннотированного метода остаётся освобождённым. Используйте его, только когда функция сама обрабатывает свои ошибки: аннотация сообщает анализатору, что отбрасывание future безопасно, и обеспечить это должны вы. Flutter 3.47 реэкспортирует аннотацию из `package:flutter/foundation.dart`; если пакет, который её использует, ломает вашу сборку на 3.44, см. [исправление неопределённого имени `awaitNotRequired`](/ru/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).

## Нюанс, который выбирает за вас

Если ваша кодовая база опирается на стрелочные колбэки (`onPressed: () => doThing()`), `discarded_futures` даёт меньше, чем можно судить по его шуму, потому что стрелочная форма для него невидима (S9, F3). В такой кодовой базе одного `unawaited_futures` плюс командного правила "асинхронная работа живёт в колбэках `async`" достаточно, чтобы получить основную часть пользы. Если же ваша кодовая база использует блочные колбэки и загрузчики в `initState`, то `discarded_futures` остаётся единственным правилом, которое вообще видит эти вызовы, и оно стоит возни с `unawaited`.

Разработчики на C# узнают эту проблему: это версия [CS4014, "this call is not awaited"](/ru/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) для Dart, только C# сообщает о ней лишь в методах `async`, то есть это половина `unawaited_futures`. Dart позволяет включить и другую половину.

## Моя рекомендация

Включите `unawaited_futures` в каждом проекте на Dart и Flutter уже сегодня. Добавьте `discarded_futures` в пакеты и в приложения, где вы хотите, чтобы "выстрелил и забыл" было явным, и смиритесь с записью `unawaited(_controller.forward())`. Вот конфигурация, которую использую я:

```yaml
# analysis_options.yaml, Flutter 3.44.8 / Dart 3.12.2
include: package:flutter_lints/flutter.yaml

linter:
  rules:
    - unawaited_futures
    - discarded_futures
    - avoid_void_async
```

`avoid_void_async` является дополнением: он сообщает о `void bad() async {}` и заставляет объявлять `Future<void>`, так что future существует в системе типов, где его видят два других правила (и ваши вызывающие). Он не закрывает брешь с tear-off, но не даёт создавать новые функции `async`, future которых никто не может ожидать.

## Связанные материалы

- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/ru/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)
- [How to use BuildContext safely after an await in Flutter](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [How to run dart fix across a whole repo to apply Flutter migrations](/ru/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [Fix: Undefined name 'awaitNotRequired' from material_ui or cupertino_ui on Flutter 3.44](/ru/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Fix CS4014: because this call is not awaited, execution continues](/ru/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/)

## Источники

- [unawaited_futures](https://dart.dev/tools/linter-rules/unawaited_futures) и [discarded_futures](https://dart.dev/tools/linter-rules/discarded_futures) на dart.dev.
- Исходный код правил на теге 3.12.2: [unawaited_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/unawaited_futures.dart), [discarded_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/rules/discarded_futures.dart), [unused_futures.dart](https://github.com/dart-lang/sdk/blob/3.12.2/pkg/linter/lib/src/util/unused_futures.dart).
- [`awaitNotRequired` в package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html) и [журнал изменений meta](https://pub.dev/packages/meta/changelog).
- Upstream-задачи: [#61155](https://github.com/dart-lang/sdk/issues/61155) (стрелочные тела), [#56921](https://github.com/dart-lang/sdk/issues/56921) (tear-off), [#63818](https://github.com/dart-lang/sdk/issues/63818) (`unawaited` и `FutureOr`).

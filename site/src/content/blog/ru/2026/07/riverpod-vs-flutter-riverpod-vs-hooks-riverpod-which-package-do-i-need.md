---
title: "riverpod vs flutter_riverpod vs hooks_riverpod: какой пакет мне на самом деле нужен?"
description: "Устанавливайте flutter_riverpod почти для любого приложения Flutter. Используйте riverpod только для чистого кода на Dart, а hooks_riverpod только если вы уже используете flutter_hooks."
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
lang: "ru"
translationOf: "2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need"
translatedBy: "claude"
translationDate: 2026-07-23
---

Если pub.dev показывает вам `riverpod`, `flutter_riverpod` и `hooks_riverpod`, а вы не можете решить, какой добавить, ответ почти для любого приложения Flutter -- `flutter_riverpod`. Добавляйте `riverpod` (без префикса `flutter_`) только когда пишете чистый Dart без зависимости от Flutter, например CLI или сервер. Добавляйте `hooks_riverpod` только если вы уже используете пакет `flutter_hooks` и хотите `HookConsumerWidget`. Эти три пакета не являются конкурирующими менеджерами состояния: это слои одной и той же библиотеки, и выбор неправильного означает лишь слегка неверный import, а не другую архитектуру. Все версии здесь ориентированы на Riverpod 3.3.2 (линия 3.0 вышла 2025-09-10), Flutter 3.44 и Dart 3.12.

## Это слои, а не соперники

Путаница возникает из-за того, что pub.dev перечисляет их рядом, как будто это альтернативы вроде Provider и Bloc. Это не так. `riverpod` -- это центральный движок, написанный на чистом Dart и без единого импорта Flutter. `flutter_riverpod` берёт этот движок и добавляет связующий слой Flutter: `ProviderScope`, `ConsumerWidget`, `Consumer` и `WidgetRef`, на котором вы вызываете `ref.watch`. `hooks_riverpod` берёт `flutter_riverpod` и добавляет сверху ещё одну вещь: интеграцию с отдельным пакетом `flutter_hooks`, предоставляя `HookConsumerWidget`.

Каждый пакет реэкспортирует тот, что находится ниже. Когда вы добавляете `flutter_riverpod`, вы также получаете всё из `riverpod`, не перечисляя его. Когда вы добавляете `hooks_riverpod`, вы получаете и всё из `flutter_riverpod`. Именно поэтому вы никогда не устанавливаете более одного из них одновременно, и именно поэтому установить `flutter_riverpod`, а затем импортировать из `package:riverpod/riverpod.dart` -- это ошибка, порождающая запутанные ошибки о дублирующихся символах.

## Матрица возможностей

| Возможность | `riverpod` 3.3.2 | `flutter_riverpod` 3.3.2 | `hooks_riverpod` 3.3.2 |
| --- | --- | --- | --- |
| Зависит от Flutter | Нет | Да | Да |
| Движок провайдеров (`Provider`, `Notifier`, `ref.watch`) | Да | Да | Да |
| Виджет `ProviderScope` | Нет | Да | Да |
| `ConsumerWidget` / `Consumer` | Нет | Да | Да |
| `HookConsumerWidget` / `HookConsumer` | Нет | Нет | Да |
| Требует `flutter_hooks` рядом | Нет | Нет | Да |
| Реэкспортирует пакет ниже | -- | `riverpod` | `flutter_riverpod` |
| Подходит для | Чистого кода на Dart | Большинства приложений Flutter | Приложений Flutter, уже использующих hooks |

Тип `AsyncValue`, `ref.listen`, модификаторы провайдеров вроде `.autoDispose` и поведение автоматического повтора, добавленное в 3.0, -- всё это живёт в центральном пакете `riverpod`, поэтому каждая строка, где они есть, идентична для всех трёх. Единственные реальные различия -- это базовые классы виджетов и зависимость от Flutter.

## Когда устанавливать flutter_riverpod

Это вариант по умолчанию, и он покрывает подавляющее большинство приложений.

- Вы создаёте обычное приложение Flutter (мобильное, десктопное или веб) и хотите `ProviderScope` в корне и `ConsumerWidget` на своих экранах.
- Вы не используете и не планируете использовать пакет `flutter_hooks`.
- Вы хотите минимально возможную поверхность зависимостей, которая всё ещё даёт полную интеграцию с Flutter.

Установка -- одна команда:

```bash
# Flutter 3.44, flutter_riverpod 3.3.2
flutter pub add flutter_riverpod
```

Минимальный рабочий виджет выглядит так:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.2
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;
  void increment() => state++;
}

void main() {
  // ProviderScope comes from flutter_riverpod
  runApp(const ProviderScope(child: MyApp()));
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Text('$count');
  }
}
```

`ProviderScope`, `ConsumerWidget` и `WidgetRef` -- всё это предоставляет `flutter_riverpod`. `NotifierProvider`, `Notifier` и `state` приходят из центрального движка, который `flutter_riverpod` реэкспортирует. Вы никогда не импортируете `package:riverpod/riverpod.dart` напрямую в приложении Flutter.

## Когда устанавливать чистый riverpod

Обращайтесь к голому пакету `riverpod` только когда в проекте вообще нет Flutter.

- Инструмент командной строки на Dart, который разделяет логику на основе провайдеров с приложением Flutter.
- Сервер `dart_frog` или `shelf`, которому нужен граф зависимостей Riverpod на бэкенде.
- Чистый пакет на Dart, от которого зависят другие приложения, где втягивание Flutter было бы неправильным.

```bash
# Dart 3.12, riverpod 3.3.2
dart pub add riverpod
```

В контексте только Dart нет дерева виджетов, поэтому вместо `ProviderScope` вы сами конструируете `ProviderContainer` и читаете из него:

```dart
// Dart 3.12, riverpod 3.3.2 (no Flutter)
import 'package:riverpod/riverpod.dart';

final greetingProvider = Provider<String>((ref) => 'hello from Dart');

void main() {
  final container = ProviderContainer();
  print(container.read(greetingProvider)); // hello from Dart
  container.dispose();
}
```

Если у вашего проекта есть `pubspec.yaml` с `flutter:` в разделе dependencies, это почти никогда не тот пакет, который вам нужен. Добавить чистый `riverpod` в приложение Flutter, а потом недоумевать, почему `ConsumerWidget` и `ProviderScope` не разрешаются, -- одна из самых частых ошибок настройки Riverpod.

## Когда устанавливать hooks_riverpod

Устанавливайте `hooks_riverpod` только когда вы уже привержены `flutter_hooks` и хотите использовать hooks внутри того же виджета, который читает провайдеры.

Ключевой факт: `flutter_hooks` и Riverpod -- два независимых пакета. `flutter_hooks` -- это порт хуков React, который управляет локальным состоянием виджета, такими вещами, как `TextEditingController` или `AnimationController`, ограниченными одним виджетом. Riverpod управляет общим состоянием приложения. Они решают разные задачи, и вы можете использовать любой из них без другого. `hooks_riverpod` существует исключительно для того, чтобы один виджет мог делать и то, и другое без конфликта наследования классов.

Этот конфликт реален. `HookWidget` (из `flutter_hooks`) и `ConsumerWidget` (из `flutter_riverpod`) -- оба базовые классы, а класс Dart может расширять только один суперкласс. Вы не можете написать `class X extends HookWidget, ConsumerWidget`. `hooks_riverpod` решает это, поставляя `HookConsumerWidget` -- единственный базовый класс, который является обоими сразу:

```dart
// Flutter 3.44, hooks_riverpod 3.3.2, flutter_hooks 0.21.2
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

class SearchField extends HookConsumerWidget {
  const SearchField({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // useTextEditingController is a hook: local widget state
    final controller = useTextEditingController();
    // ref.watch is Riverpod: shared app state
    final results = ref.watch(searchResultsProvider);

    return TextField(controller: controller);
  }
}
```

Два момента, на которые стоит обратить внимание. Первый: `hooks_riverpod` не включает в себя `flutter_hooks`, поэтому вы должны добавить оба:

```bash
# Flutter 3.44
flutter pub add hooks_riverpod
flutter pub add flutter_hooks
```

Второй: поскольку `hooks_riverpod` реэкспортирует `flutter_riverpod`, вам не нужно и не следует также перечислять `flutter_riverpod` в `pubspec.yaml`. Единственный импорт `hooks_riverpod` даёт вам `ProviderScope`, `ConsumerWidget` и `HookConsumerWidget` все вместе. Файл, который только читает провайдеры, всё ещё может расширять обычный `ConsumerWidget`; к `HookConsumerWidget` вы обращаетесь только в тех конкретных файлах, которые также вызывают hooks.

Официальная документация прямо говорит об этом для новичков: если вы новичок в Riverpod, не начинайте с hooks. Они добавляют вторую ментальную модель поверх уже незнакомой. Сначала изучите `flutter_riverpod`, а `hooks_riverpod` осваивайте позже, только если обнаружите, что вам нужны hooks для локального состояния. Если сегодня вы управляете контроллерами вручную, дисциплина освобождения ресурсов в [освобождении контроллеров Flutter во избежание утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) -- это именно тот шаблонный код, который стремятся убрать hooks, и это честный довод в пользу их принятия.

## Заменяет ли пакет аннотаций runtime-пакет?

Частый следующий вопрос: если я добавлю `riverpod_annotation` для codegen `@riverpod`, нужен ли мне ещё `flutter_riverpod`? Да. Пакет аннотаций предоставляет только маркер `@riverpod` и типы, относительно которых генератор порождает код. Он не содержит runtime: ни `ProviderScope`, ни `Notifier`, ни `ref`. Ваше приложение по-прежнему работает на одном из трёх runtime-пакетов, и сгенерированный код импортирует из него. Поэтому приложение Flutter с codegen зависит от обоих -- `flutter_riverpod` (runtime) и `riverpod_annotation` (аннотации), а не от одного вместо другого.

То же правило "один runtime-пакет" действует и в тестах. Тест виджета, который монтирует `ProviderScope`, использует `flutter_riverpod` (через `flutter_test`), тогда как модульный тест на чистом Dart, поднимающий `ProviderContainer`, использует голый `riverpod`. Вы не добавляете отдельный тестовый пакет для Riverpod; `ProviderContainer` и `overrides`, нужные для тестов, уже поставляются внутри установленного runtime-пакета.

## Подвох, который действительно сбивает людей: пакеты codegen версионируются иначе

Вот часть, которая удивляет даже опытных пользователей Riverpod в эпоху 3.x. Runtime-пакеты (`riverpod`, `flutter_riverpod`, `hooks_riverpod`) находятся на линии 3.3.x, но пакеты генерации кода находятся на совершенно другой мажорной версии:

| Пакет | Роль | Версия (2026-07) |
| --- | --- | --- |
| `flutter_riverpod` | runtime | 3.3.2 |
| `hooks_riverpod` | runtime | 3.3.2 |
| `riverpod` | runtime | 3.3.2 |
| `riverpod_annotation` | аннотации codegen | 4.0.3 |
| `riverpod_generator` | codegen (dev) | 4.0.4 |
| `riverpod_lint` | правила lint (dev) | 3.x |

Если вы используете аннотацию `@riverpod` для генерации провайдеров, вы устанавливаете четыре пакета, а не один. `riverpod_annotation` -- обычная зависимость; `riverpod_generator` и `build_runner` -- зависимости для разработки:

```bash
# Flutter 3.44, Riverpod 3.x
flutter pub add flutter_riverpod riverpod_annotation
flutter pub add dev:riverpod_generator dev:build_runner
flutter pub add dev:custom_lint dev:riverpod_lint   # optional, for lint rules
```

Затем генерируйте с помощью:

```bash
# runs the generator once, or use `watch` to keep it running
dart run build_runner watch -d
```

Не пытайтесь закрепить `riverpod_annotation` на `^3.0.0`, чтобы он совпал с runtime. Линия аннотаций 4.x -- это та, что соответствует runtime 3.3.x; номера версий намеренно развязаны, потому что генератор развивается в своём темпе. Позвольте `flutter pub add` разрешить ограничения и не правьте их вручную, чтобы "выровнять", потому что они и не должны выравниваться. Это самый частый сбой `pub get` в свежесозданном проекте Riverpod 3.

Генерация кода необязательна. Всё в этой статье работает без неё. Подход с аннотациями в основном избавляет вас от написания вручную шаблонного кода типов провайдеров (`NotifierProvider<Counter, int>`), и это хороший вариант по умолчанию для новых проектов, но это решение, отдельное от того, какой runtime-пакет вы устанавливаете.

## Что на самом деле набирать

Убрав объяснение, решение оказывается коротким:

- Создаёте приложение Flutter, без hooks: `flutter pub add flutter_riverpod`. Это вы, в 90% случаев.
- Чистый Dart, без Flutter: `dart pub add riverpod`.
- Приложение Flutter, которое уже использует `flutter_hooks`: `flutter pub add hooks_riverpod flutter_hooks`.
- Используете аннотацию `@riverpod` поверх любого из вышеперечисленного: добавьте `riverpod_annotation` плюс зависимости для разработки `riverpod_generator` и `build_runner`, и позвольте резолверу выбрать линию 4.x.

Какой бы runtime-пакет вы ни выбрали, провайдеры, API `Notifier` и `AsyncValue` ведут себя идентично, потому что все они происходят из одного центрального движка. Вы лишь выбираете, сколько связующего слоя Flutter и поддержки hooks наслоить сверху. Как только это решено, настоящее обучение -- в самом API: как [AsyncValue из Riverpod сравнивается с FutureBuilder и StreamBuilder](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/), как [проверять ref.mounted после асинхронного разрыва](/ru/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) и как новый [автоматический повтор провайдеров в 3.0](/ru/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/) меняет обработку ошибок. Если вы всё ещё решаете, использовать ли Riverpod вообще, [сравнение Provider vs Riverpod vs Bloc](/ru/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) принимает это решение; если вы уходите со старой линии, [руководство по миграции с Riverpod 2.x на 3.0](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) охватывает ломающие изменения.

## Источники

- [Riverpod: Getting started](https://riverpod.dev/docs/introduction/getting_started) -- официальные команды установки для `riverpod`, `flutter_riverpod`, `hooks_riverpod` и пакетов codegen.
- [Riverpod: About hooks](https://riverpod.dev/docs/concepts/about_hooks) -- связь между `flutter_hooks`, `flutter_riverpod` и `HookConsumerWidget`, а также совет для новичков.
- [riverpod_generator changelog](https://pub.dev/packages/riverpod_generator/changelog) -- подтверждает линию codegen 4.x в паре с runtime 3.3.x.
- [flutter_hooks на pub.dev](https://pub.dev/packages/flutter_hooks) -- независимый пакет hooks, с которым интегрируется `hooks_riverpod`.

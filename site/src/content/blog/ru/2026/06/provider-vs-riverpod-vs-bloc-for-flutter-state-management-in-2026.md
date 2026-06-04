---
title: "Provider vs Riverpod vs Bloc для управления состоянием во Flutter в 2026"
description: "Выбирайте Riverpod для большинства новых приложений Flutter в 2026. Берите Bloc, когда большой команде нужна строгая событийная структура, а Provider оставьте только для устаревшего кода."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "bloc"
lang: "ru"
translationOf: "2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026"
translatedBy: "claude"
translationDate: 2026-06-04
---

Если вы начинаете новое приложение Flutter в 2026 году и не можете выбрать между Provider, Riverpod и Bloc, короткий ответ - Riverpod. С Riverpod 3.3.1 (линейка 3.0 вышла 2025-09-10) он безопасен на этапе компиляции, тестируется без `BuildContext`, а путь с генерацией кода устраняет почти весь boilerplate, который раньше был главным аргументом против него. Берите Bloc (`flutter_bloc` 9.1.1), когда у вас большая команда, которой выгоден строгий событийный контракт и отслеживаемая история состояния. Оставьте Provider (6.1.5) только если он уже есть в вашей базе кода или вы объясняете кому-то лежащую в основе модель `InheritedWidget`. Все примеры здесь используют Flutter 3.44 и Dart 3.12.

## Эти три пакета - не одинаковый тип инструмента

Перед сравнением полезно увидеть, что эти библиотеки решают пересекающиеся, но разные задачи.

Provider - это тонкая, хорошо сделанная обёртка над собственным `InheritedWidget` Flutter. Он выполняет внедрение зависимостей и распространение перестроений, и по сути это всё. Класс состояния обычно представляет собой `ChangeNotifier`, который вы пишете вручную. Это пакет, к которому обратилась официальная документация Flutter, когда ей понадобился обучающий пример, поэтому так много туториалов используют его.

Riverpod - это то, что автор Provider построил следующим, специально чтобы исправить структурные проблемы Provider: `ProviderNotFoundException` во время выполнения, зависимость от позиции виджета в дереве и невозможность читать состояние из чистого Dart. Провайдеры Riverpod живут вне дерева виджетов, поэтому доступны откуда угодно и разрешаются на этапе компиляции.

Bloc - это сначала паттерн, а потом пакет. Он подталкивает вас моделировать каждое изменение как явное событие, которое поступает в компонент и порождает новое неизменяемое состояние. Эта церемония и есть суть: в большой команде принудительный конвейер `Event -> Bloc -> State` делает поведение предсказуемым и проверяемым на ревью.

## Матрица возможностей

| Возможность | Provider 6.1.5 | Riverpod 3.3.1 | Bloc 9.1.1 |
| --- | --- | --- | --- |
| Ментальная модель | `InheritedWidget` + `ChangeNotifier` | Провайдеры вне дерева | Событийная, неизменяемые состояния |
| Безопасность на этапе компиляции | Нет (поиск во время выполнения) | Да | Да |
| Нужен `BuildContext` для чтения | Да | Нет | Нет (через `context.read` или напрямую) |
| Boilerplate | Низкий | Низкий с codegen | Высокий |
| Тестируемость | Требует прокачки виджета | Чистый Dart, без дерева виджетов | Чистый Dart, помощники `bloc_test` |
| Async- / состояние загрузки | Вручную | `AsyncValue`, встроено | Состояния вручную или `emit` |
| Автоповтор при сбоях | Нет | Да (с 3.0) | Нет |
| Отслеживаемость состояния | Слабая | Средняя | Сильная (каждый переход наблюдаем) |
| Кривая обучения | Пологая | Умеренная | Крутая |
| Лучше всего подходит | Legacy, туториалы | Большинство новых приложений | Большие команды, сложные потоки |

Самая важная строка - "безопасность на этапе компиляции". Неправильно настроенный Provider бросает `ProviderNotFoundException` во время выполнения, часто только на том экране, где его не хватает. Riverpod и Bloc выявляют этот класс ошибок до запуска приложения.

## Один и тот же счётчик во всех трёх

Счётчик достаточно мал, чтобы напрямую сравнить эргономику. Обратите внимание, сколько кода нужно каждому и где живёт состояние.

### Provider

```dart
// Flutter 3.44, provider 6.1.5
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class CounterModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  void increment() {
    _count++;
    notifyListeners();
  }
}

// Register it above the widgets that need it.
ChangeNotifierProvider(
  create: (_) => CounterModel(),
  child: const CounterPage(),
);

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final count = context.watch<CounterModel>().count;
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.read<CounterModel>().increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Обратите внимание на зависимость от `context`. Если `CounterPage` отрендерен без `ChangeNotifierProvider` над ним, `context.watch<CounterModel>()` бросает исключение во время выполнения.

### Riverpod

```dart
// Flutter 3.44, flutter_riverpod 3.3.1, riverpod_annotation
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => ref.read(counterProvider.notifier).increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

`counterProvider` генерируется и доступен глобально. Нет позиции в дереве, которую можно перепутать, а `ref` разрешается на этапе компиляции. Оберните приложение один раз в `ProviderScope`, и готово.

### Bloc

```dart
// Flutter 3.44, flutter_bloc 9.1.1, equatable
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

// Events
sealed class CounterEvent {}
class Increment extends CounterEvent {}

// Bloc: Event in, int state out.
class CounterBloc extends Bloc<CounterEvent, int> {
  CounterBloc() : super(0) {
    on<Increment>((event, emit) => emit(state + 1));
  }
}

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => CounterBloc(),
      child: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: BlocBuilder<CounterBloc, int>(
              builder: (context, count) => Text('$count'),
            ),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => context.read<CounterBloc>().add(Increment()),
            child: const Icon(Icons.add),
          ),
        ),
      ),
    );
  }
}
```

Bloc самый многословный для счётчика, и это сравнение к нему несправедливо: ценность Bloc проявляется, когда событий двадцать, а состояний десять, а не одно. Событие `Increment` - это запись в истории вашего приложения. С подключённым `BlocObserver` вы можете логировать каждый переход, а это именно то, что нужно при отладке сложного экрана.

## Когда выбирать Riverpod

- **Новое приложение в 2026 году без ограничений legacy.** Это вариант по умолчанию. Riverpod даёт вам безопасность на этапе компиляции, тесты без `pumpWidget` и обработку async через `AsyncValue` из коробки. Посмотрите наш разбор [состояний загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), чтобы увидеть, насколько чистым становится async.
- **Вы читаете состояние вне виджетов.** Фоновая синхронизация, слой репозитория или сервис, которому нужен текущий токен авторизации, могут вызвать `ref.read` без `BuildContext`. Provider не умеет делать это чисто.
- **Вам нужна устойчивость для нестабильных сетевых провайдеров.** Riverpod 3.0 добавил автоповтор с экспоненциальной задержкой (200ms с удвоением до 6.4s) для провайдеров, которые падают при инициализации, плюс автоматическую приостановку слушателей, когда виджет уходит за пределы экрана.
- **Вы мигрируете с GetX или подобного.** Riverpod - обычное место назначения. Наше [руководство по миграции с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) охватывает движущиеся части.

Одна оговорка: в Riverpod 3.0 `StateProvider`, `StateNotifierProvider` и `ChangeNotifierProvider` перенесены в `package:riverpod/legacy.dart`. Новый код должен использовать классы `Notifier` и `AsyncNotifier`, показанные выше, в идеале с генерацией кода через `@riverpod`.

## Когда выбирать Bloc

- **Большая команда, которой нужен принудительный контракт.** Когда пятеро разработчиков трогают одну и ту же функциональность, жёсткий поток `Event -> Bloc -> State` не даёт каждому изобретать свой паттерн. Структура и есть результат.
- **Вам нужна проверяемая история состояния.** `BlocObserver` видит каждый переход. Для потоков вроде оформления заказа, онбординга или многошаговой формы возможность воспроизвести точную последовательность событий, породившую баг, стоит boilerplate.
- **Сложная, ветвящаяся async-логика.** Трансформеры событий Bloc (debounce, throttle, `droppable`, `concurrent`) дают тонкий контроль над тем, как обрабатываются пересекающиеся события. Это сложнее выразить в двух других.
- **Вам нужен `Cubit` для простых случаев.** Не каждому экрану нужны полноценные события. `Cubit` - это Bloc без слоя событий: вы вызываете методы, которые напрямую делают `emit` нового состояния, так что можно смешивать лёгкие Cubit и полноценные Bloc в одном приложении.

## Когда выбирать Provider

- **У вас он уже есть.** Работающее приложение на Provider не нуждается в переписывании. В `ChangeNotifier` для состояния приложения, не критичного к производительности, нет ничего плохого.
- **Вы обучаете основам.** Provider отображается почти один к одному на `InheritedWidget`, поэтому это самый понятный способ показать кому-то, как Flutter распространяет состояние без сторонней абстракции.
- **Действительно крошечное приложение.** Один экран настроек с одним переключателем не оправдывает ни генерацию кода, ни конвейер событий.

Чем Provider не должен быть в 2026 году, так это вариантом по умолчанию для нового нетривиального приложения. Модель поиска во время выполнения - это ровно та проблема, для устранения которой был создан Riverpod.

## Подводные камни, которые выбирают за вас

Некоторые ограничения перевешивают личные предпочтения.

**Чтение состояния из кода вне виджетов.** Если в вашей архитектуре есть слой сервиса или репозитория, который должен читать состояние приложения напрямую, Provider фактически выбывает. Ему нужен `BuildContext`. Riverpod и Bloc оба позволяют читать состояние из чистого Dart, что обычно само решает выбор.

**Размер команды и культура ревью.** В одиночном проекте или маленькой команде церемония Bloc - это трение с малой отдачей, и Riverpod выигрывает по скорости. В команде из 15 человек, где согласованность между функциями важнее количества строк кода, жёсткость Bloc - это преимущество, а не издержка.

**Дисциплина неизменяемого состояния.** И Bloc, и современный Riverpod подталкивают вас к неизменяемым объектам состояния. Если ваша команда комфортно работает с sealed-классами и равенством по значению (см. [Dart records vs классы Freezed](/ru/2026/05/dart-records-vs-freezed-classes/) про варианты моделирования), подходят оба. Если у вас большая база кода на изменяемых объектах `ChangeNotifier`, самый дешёвый путь - возможно, остаться на Provider, пока какой-то функции действительно не понадобится больше.

**Существующие async-паттерны.** `AsyncValue` от Riverpod - это способ с наименьшими усилиями отрисовать загрузку, данные и ошибку из единого источника истины. Если ваши экраны - это в основном async-загрузки данных, одного этого уже достаточно как веской причины выбрать его.

## Рекомендация, ещё раз

Для большинства новых приложений Flutter в 2026 году используйте Riverpod 3.3.1 с генерацией кода. Вы получаете безопасность на этапе компиляции, чтение без контекста, первоклассный async и функции устойчивости из 3.0, при затратах на boilerplate, которые codegen приближает к Provider.

Выбирайте Bloc 9.1.1, когда принудительная событийная структура и полностью отслеживаемая история состояния значат для вашей команды больше, чем краткость, что чаще всего верно для больших команд и сложных потоков. Используйте Cubit внутри приложения на Bloc для экранов, которым не нужны полноценные события.

Оставьте Provider 6.1.5 для legacy-приложений, обучения и тривиальных экранов, но не берите его по умолчанию в новом нетривиальном проекте. Решающий вопрос редко звучит как "у кого самый красивый счётчик", он звучит как "читаю ли я состояние вне виджетов, насколько велика моя команда и сколько у меня async?". Ответьте на эти три, и выбор обычно сделается сам собой. Если вы взвешиваете Flutter против совсем других стеков, наше [сравнение Flutter vs React Native vs MAUI](/ru/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) отдаляет камеру на уровень выше. И что бы вы ни выбрали, не забудьте [освобождать ваши контроллеры](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), потому что ни одна библиотека управления состоянием не подчистит их за вас.

## Источники

- [Riverpod: что нового в 3.0](https://riverpod.dev/docs/whats_new) - legacy-API, автоповтор, пауза/возобновление, офлайн-персистентность, мутации.
- [flutter_riverpod на pub.dev](https://pub.dev/packages/flutter_riverpod) и [changelog](https://pub.dev/packages/flutter_riverpod/changelog) - версия 3.3.1, 3.0.0 выпущена 2025-09-10.
- [flutter_bloc на pub.dev](https://pub.dev/packages/flutter_bloc) - версия 9.1.1, BlocProvider / BlocBuilder / BlocListener, Cubit vs Bloc.
- [provider на pub.dev](https://pub.dev/packages/provider) - версия 6.1.5, ChangeNotifierProvider, Flutter Favorite.
- [Заметки о релизах Flutter](https://docs.flutter.dev/release/release-notes) - Flutter 3.44 стабильный, Dart 3.12.

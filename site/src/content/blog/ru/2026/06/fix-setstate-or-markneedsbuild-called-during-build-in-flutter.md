---
title: "Решение: setState() or markNeedsBuild() called during build во Flutter"
description: "Эта ошибка означает, что вы изменили состояние во время сборки Flutter. Уберите setState из build или отложите его через addPostFrameCallback. Вот почему это происходит и как правильно исправить."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ru"
translationOf: "2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-02
---

Вы вызвали `setState()` (или что-то, что вызывает `notifyListeners()`, `markNeedsBuild()` или `Navigator.push`), пока Flutter находился в середине своей фазы сборки. Решение в том, чтобы не менять состояние во время `build`. Если триггер действительно является синхронным callback, выполняющимся посреди сборки, отложите изменение на следующий кадр через `WidgetsBinding.instance.addPostFrameCallback((_) => setState(...))`. В этом руководстве используется Flutter 3.44 (стабильная версия, май 2026) и Dart 3.x.

Эта ошибка является защитным механизмом, а не сбоем. Flutter собирает родителей раньше детей за один синхронный проход. Пометить виджет как требующий перестройки посреди прохода означало бы попросить фреймворк запланировать перестройку для чего-то, что он, возможно, уже посетил, а этого нельзя выполнить в текущем кадре. Поэтому он выбрасывает исключение вместо того, чтобы молча отбросить ваше обновление.

## Ошибка в контексте

Полное сообщение, которое Flutter выводит в консоль, выглядит так:

```
======== Exception caught by widgets library =======================
The following assertion was thrown while dispatching notifications for ProductModel:
setState() or markNeedsBuild() called during build.

This _MyHomePageState widget cannot be marked as needing to build because the
framework is already in the process of building widgets. A widget can be marked
as needing to be built during the build phase only if one of its ancestors is
currently building. This exception is allowed because the framework builds parent
widgets before children, which means a dirty descendant will always be built.
Otherwise, the framework might not visit this widget during this build phase.

The widget on which setState() or markNeedsBuild() was called was: _MyHomePageState
The widget which was currently being built when the offending call was made was: Consumer<ProductModel>
====================================================================
```

Важны две строки в конце. "The widget on which setState() ... was called" -- это то, что вы пытаетесь перестроить. "The widget which was currently being built" -- это место, откуда возник проблемный вызов. Разрыв между этими двумя виджетами и есть баг.

## Почему это происходит

Существует четыре распространённых триггера, примерно в порядке частоты, с которой они кусаются:

Listener уведомляет во время сборки. `ChangeNotifier`, `ValueNotifier` или provider вызывает `notifyListeners()` изнутри метода, который вы вызвали, читая его в `build`. Уведомление синхронно просит каждый слушающий виджет перестроиться, но вы уже строите один из них.

Вы вызвали `setState` прямо в `build`. Обычно по ошибке: метод, который вычисляет значение, также переключает флаг и вызывает `setState`, а вы вызываете этот метод из `build`.

Вы прочитали provider с `listen: true` во время сборки, которая также его изменяет. `Provider.of<T>(context)` (со слушанием) регистрирует зависимость. Если тот же кадр пишет в этот provider, запись пытается перестроить зависимый элемент, который ещё строится.

Вы выполнили навигацию или показали диалог из `build`. `Navigator.push`, `showDialog` и `Scaffold.of(context).showSnackBar` помечают предков как требующих перестройки. Вызов их из `build` (а не из обработчика событий) срабатывает на той же проверке.

Объединяющее правило команды Flutter простое: `build` должен быть чистой функцией конфигурации виджета и состояния. Он возвращает дерево виджетов и не делает ничего больше. Побочные эффекты, меняющие состояние, относятся к методам жизненного цикла (`initState`, `didChangeDependencies`) или обработчикам событий (`onPressed`, `onTap`), но никогда к `build`.

## Как найти проблемный вызов

Сообщение консоли называет два виджета, но строка, которую вам нужно изменить, обычно не находится ни в одном из них. Она находится в том, что выполнилось синхронно между ними. Читайте сообщение снизу вверх:

1. "The widget which was currently being built" сообщает вам о выполняющейся сборке. Найдите в своём коде метод `build` этого виджета или callback `builder`, если это `Consumer`, `Builder`, `LayoutBuilder` или `ValueListenableBuilder`.
2. Внутри этой сборки найдите каждый вызов метода, который не является чистым чтением. Геттер, увеличивающий счётчик, метод с именем `load`, `refresh`, `fetch` или `update`, всё, что касается `ChangeNotifier`. Этот вызов и есть ваш подозреваемый.
3. Если ничто в сборке не выглядит нечистым, триггер -- это listener. Посмотрите на строку "dispatching notifications for X" в самом верху: `X` -- это уведомитель, который сработал. Найдите, где вызывается `X.notifyListeners()`, и проследите назад, что вызвало его во время этого кадра.

В отладочных сборках трассировка стека под сообщением указывает прямо на место вызова `notifyListeners` или `setState`. В релизных сборках проверка вырезается при компиляции, поэтому баг проявляется как отброшенное обновление или устаревший кадр вместо сбоя. Именно поэтому вы хотите исправить причину, а не заглушить симптом: симптом существует только в отладке.

## Минимальное воспроизведение

Этот виджет выбрасывает исключение на своём первом кадре. Модель уведомляет своих слушателей из метода, который выполняется, пока `Consumer` строится.

```dart
// Flutter 3.44, Dart 3.x -- throws "setState() or markNeedsBuild() called during build".
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class ProductModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  // Looks like a harmless getter-with-side-effect. It is not.
  int countAndTrack() {
    _count++;
    notifyListeners(); // fires synchronously, during build
    return _count;
  }
}

class CounterText extends StatelessWidget {
  const CounterText({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<ProductModel>(
      builder: (context, model, _) {
        // Calling a method that notifies, from inside build:
        return Text('Seen ${model.countAndTrack()} times');
      },
    );
  }
}
```

`Consumer` строится. Его `builder` вызывает `countAndTrack()`, который вызывает `notifyListeners()`, который просит `Consumer` перестроиться, пока он ещё строится. Flutter выбрасывает исключение.

Та же форма встречается без Provider. Любой callback `addListener`, который в итоге синхронно вызывает `setState` во время сборки родителя, приведёт к этому.

## Решение подробно

Решения упорядочены по тому, насколько я их рекомендую. Первое почти всегда является настоящим ответом.

### 1. Уберите изменение состояния за пределы build (рекомендуется)

Не изменяйте состояние во время сборки. Вычисляйте производные значения в `build`, но выполняйте само изменение состояния в методе жизненного цикла или обработчике событий. В воспроизведении изменение относится к `initState`, а не к `builder`:

```dart
// Flutter 3.44, Dart 3.x -- correct: mutate once, off the build path.
class CounterText extends StatefulWidget {
  const CounterText({super.key});

  @override
  State<CounterText> createState() => _CounterTextState();
}

class _CounterTextState extends State<CounterText> {
  @override
  void initState() {
    super.initState();
    // Mutate here, before the first build, not during it.
    context.read<ProductModel>().countAndTrack();
  }

  @override
  Widget build(BuildContext context) {
    // build only reads; it does not write.
    final count = context.watch<ProductModel>().count;
    return Text('Seen $count times');
  }
}
```

`context.read<T>()` получает модель без подписки, поэтому он безопасен в `initState`. `context.watch<T>()` подписывается и безопасен в `build`, потому что он только читает. Запись происходит один раз, до кадра, а чтение управляет перестройками после.

### 2. Отложите изменение через addPostFrameCallback

Используйте это, когда триггер действительно вне вашего контроля: сторонний callback, событие потока, которое приходит посреди сборки, или `LayoutBuilder`, которому нужно отреагировать на измеренный размер в том же кадре. `WidgetsBinding.instance.addPostFrameCallback` выполняет ваше замыкание после того, как текущий кадр полностью построен и отрисован, поэтому `setState` снова становится допустимым.

```dart
// Flutter 3.44, Dart 3.x -- defer the rebuild to after this frame.
@override
Widget build(BuildContext context) {
  if (_needsRefresh) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return; // the widget may have been disposed
      setState(() => _needsRefresh = false);
    });
  }
  return Text(_label);
}
```

Две меры предосторожности делают это безопасным. Проверка `mounted` предотвращает сбой `setState after dispose`, если виджет покинул дерево до того, как callback выполнился. И callback должен быть условным (здесь управляется через `_needsRefresh`), иначе вы планируете новую перестройку на каждом кадре и сжигаете CPU в бесконечном цикле. `addPostFrameCallback` -- это отсрочка, а не разрешение перестраиваться при каждой отрисовке.

### 3. Разделите синхронный notify в микрозадачу

Если уведомитель принадлежит вам и метод законно должен уведомлять, но вы не можете гарантировать, что он никогда не будет вызван во время сборки, вытолкните уведомление с синхронного пути:

```dart
// Flutter 3.44, Dart 3.x -- notify after the current synchronous work unwinds.
int countAndTrack() {
  _count++;
  // scheduleMicrotask runs after the current build call stack returns,
  // but before the next frame -- so the UI updates without a frame of lag.
  scheduleMicrotask(notifyListeners);
  return _count;
}
```

Это крайнее средство. Оно скрывает запах дизайна (геттер с побочным эффектом), а не устраняет его, и микрозадачи всё ещё могут конкурировать с освобождением. Предпочитайте решение 1.

## Подводные камни и варианты

`setState() called after dispose()`. Другая проверка, связанная причина. Вы вызвали `setState` из асинхронного callback (`Future.then`, `Timer`, listener потока), который завершился после того, как виджет был удалён из дерева. Защищайте каждый асинхронный `setState` через `if (!mounted) return;`. Смотрите шаблоны освобождения в [руководстве по освобождению контроллеров](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`setState` в `initState`. Синхронный вызов `setState` в `initState` не является ошибкой, но он бессмыслен: первая сборка ещё не произошла, поэтому состояние и так будет прочитано. Просто присвойте полю значение напрямую. Flutter здесь не выбрасывает исключение, в отличие от случая фазы сборки.

`Navigator.push` из `build`. Частый вариант этой ошибки. Если вы хотите выполнить навигацию как побочный эффект состояния (скажем, перенаправить, когда пользователь выходит из системы), сделайте это в `addPostFrameCallback` или, лучше, с помощью пакета маршрутизации, который моделирует перенаправления декларативно, а не императивно из `build`.

`FutureBuilder` / `StreamBuilder`, который перестраивается бесконечно. Если `future` или `stream` создаётся внутри `build`, каждая перестройка создаёт новый, который завершается, который внутренне вызывает `setState`, который перестраивает. Создайте future или stream один раз в `initState` и сохраните его в поле. Это не строго то же исключение, но оно приводит вас на ту же территорию "я перестраиваюсь во время перестройки" и является частой причиной [подтормаживаний во Flutter, которые можно обнаружить в DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

Пользователи Riverpod. Чтение provider через `ref.watch` внутри callback, выполняющегося во время сборки, и затем запись в него в том же синхронном проходе натыкается на ту же стену. `AsyncValue` от Riverpod плюс `Notifier` держат чтение и запись на отдельных путях; смотрите [состояния загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) для шаблона.

Более глубокая мысль: `build` вызывается часто, непредсказуемо и, возможно, много раз за кадр. Всё, что вы туда помещаете, выполняется по расписанию Flutter, а не по вашему. Чтения в порядке, потому что они идемпотентны. Записи нет, потому что они меняют то, что вернёт следующее чтение, а у Flutter нет безопасного места, чтобы поглотить это изменение посреди сборки. Держите `build` чистым, и ошибка исчезнет навсегда. Та же дисциплина делает несвязанные баги вроде [переполнения RenderFlex](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) проще для понимания, потому что ваш макет является чистой функцией состояния, а не движущейся целью. Если вашему виджету действительно нужно реагировать на асинхронные данные, смоделируйте эти данные как состояние и позвольте [изящной обработке ошибок и загрузки](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) управлять перестройками за вас.

## Источники

- [State.setState API docs](https://api.flutter.dev/flutter/widgets/State/setState.html) -- контракт о том, когда setState допустим.
- [State.build API docs](https://api.flutter.dev/flutter/widgets/State/build.html) -- "build should be a pure function of the widget's configuration and the State."
- [WidgetsBinding.addPostFrameCallback API docs](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPostFrameCallback.html) -- планирование работы после текущего кадра.
- [ChangeNotifier.notifyListeners API docs](https://api.flutter.dev/flutter/foundation/ChangeNotifier/notifyListeners.html) -- когда слушатели вызываются синхронно.

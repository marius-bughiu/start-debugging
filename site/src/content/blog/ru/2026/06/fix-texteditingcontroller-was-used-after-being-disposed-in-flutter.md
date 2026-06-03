---
title: "Исправление: A TextEditingController was used after being disposed во Flutter"
description: "Этот сбой означает, что код обратился к контроллеру после вызова dispose(). Защищайте асинхронные колбэки проверкой mounted и никогда не освобождайте контроллер, который вам не принадлежит."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ru"
translationOf: "2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

Что-то прочитало из `TextEditingController` или записало в него после того, как его `dispose()` уже отработал. Обычный виновник -- асинхронный колбэк (`Future.then`, `await`, `Timer` или слушатель stream), который завершается после того, как пользователь покинул экран и `State` был уничтожен. Защитите код после await через `if (!mounted) return;` до обращения к контроллеру. Другая частая причина -- путаница с владением: дочерний виджет освободил контроллер, который ему передали, но который ему не принадлежит. В этом руководстве используется Flutter 3.44 (стабильный, май 2026) и Dart 3.x.

Ошибка не специфична для `TextEditingController`. То же сообщение появляется для любого `ChangeNotifier` (`ScrollController`, `FocusNode`, `AnimationController`, `ValueNotifier`, модель Provider), потому что проверка находится в самом `ChangeNotifier`. Тип времени выполнения в сообщении лишь говорит вам, к какому из них вы обратились слишком поздно.

## Ошибка в контексте

Полное сообщение, которое выбрасывает Flutter, выглядит так:

```
A TextEditingController was used after being disposed.
Once you have called dispose() on a TextEditingController, it can no longer be used.

When the exception was thrown, this was the stack:
#0      ChangeNotifier._debugAssertNotDisposed.<anonymous closure> (package:flutter/src/foundation/change_notifier.dart)
#1      ChangeNotifier._debugAssertNotDisposed (package:flutter/src/foundation/change_notifier.dart)
#2      ChangeNotifier.addListener (package:flutter/src/foundation/change_notifier.dart)
#3      TextEditingController.text= (package:flutter/src/widgets/editable_text.dart)
...
```

Кадр стека прямо под кадрами `ChangeNotifier` -- это строка в вашем коде. Он называет операцию, которая обратилась к мёртвому контроллеру: `text=`, `.text`, `addListener`, `clear()` или `.selection`. Этот кадр -- то место, где вы исправляете ошибку, но причина её срабатывания лежит раньше во времени, когда `dispose()` отработал до этой строки.

## Почему это происходит

Есть четыре причины, примерно в порядке частоты.

Асинхронный колбэк пережил виджет. Вы запустили `await`, `Future.then`, `Timer` или `stream.listen`, пока экран был жив, пользователь ушёл с него (что освобождает `State` и контроллер), а затем колбэк завершился и обратился к контроллеру. Это самая частая причина, потому что сбой случается только при совпадении тайминга: всё работает, когда ответ быстрый, и падает, когда пользователь шустрый или сеть медленная.

Дочерний элемент освободил контроллер, который ему не принадлежит. Родитель создал контроллер и передал его вниз; дочерний элемент вызвал `dispose()` на нём в своём собственном `dispose()`. Теперь родитель (или сосед, или следующая перестройка) использует контроллер, который дочерний элемент уже убил. Владение -- это обратная сторона проблемы утечки: освободите контроллер, который вам не принадлежит, и получите этот сбой; забудьте освободить тот, что принадлежит вам, и получите утечку памяти.

Слой управления состоянием освободил его. Если контроллер живёт в провайдере `autoDispose` Riverpod, в контроллере GetX или в `ChangeNotifier`, который фреймворк уничтожил, виджет, всё ещё держащий ссылку, наткнётся на освобождённый экземпляр. `autoDispose` в Riverpod -- частый триггер: провайдер пересчитывается или освобождается, когда за ним больше никто не наблюдает, забирая с собой контроллер, в то время как устаревшее замыкание всё ещё указывает на старый.

`didUpdateWidget` освободил старый слишком рано. Когда контроллер зависит от свойства `widget`, при обновлении вы освобождаете старый контроллер и создаёте новый. Если ожидающий колбэк захватил старый контроллер, он теперь обращается к освобождённому экземпляру.

Базовый контракт, согласно [документации API ChangeNotifier во Flutter](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html): после вызова `dispose()` объект становится непригодным, и любое дальнейшее использование выбрасывает исключение в отладочных сборках. Проверка удаляется из сборок release, поэтому в release тот же код не падает, а читает устаревшее или null-состояние. Вот почему вы исправляете причину, а не заглушаете проверку.

## Минимальное воспроизведение

Этот виджет падает, когда вы покидаете экран до того, как fetch вернётся. Он компилируется и работает, и проходит, когда сеть быстрая.

```dart
// Flutter 3.44, Dart 3.x -- throws "A TextEditingController was used after being disposed".
import 'package:flutter/material.dart';

class SearchBox extends StatefulWidget {
  const SearchBox({super.key});

  @override
  State<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<SearchBox> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prefill();
  }

  Future<void> _prefill() async {
    // Pretend this hits the network and takes ~500ms.
    final lastQuery = await Future.delayed(
      const Duration(milliseconds: 500),
      () => 'flutter dispose error',
    );
    // If the user popped this screen during those 500ms, the State and the
    // controller are already disposed. This line then throws.
    _controller.text = lastQuery;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(controller: _controller);
  }
}
```

Откройте этот экран, а затем закройте его в течение полусекунды. `dispose()` отрабатывает, `_controller.dispose()` убивает контроллер, `Future` завершается, и `_controller.text = ...` выбрасывает исключение. Сбой зависит от тайминга, и именно поэтому он переживает ревью кода и попадает в продакшен.

## Исправление, подробно

Исправления упорядочены по тому, насколько я их рекомендую. Выберите то, что соответствует вашей причине.

### 1. Защищайте асинхронные колбэки проверкой mounted (рекомендуется)

В каждом месте, где за `await` (или любым отложенным колбэком) следует код, обращающийся к контроллеру или вызывающий `setState`, сначала проверяйте `mounted`. `mounted` равно `false`, как только `State` был освобождён, поэтому защита замыкается до обращения к контроллеру.

```dart
// Flutter 3.44, Dart 3.x -- correct: bail out if the widget is gone.
Future<void> _prefill() async {
  final lastQuery = await Future.delayed(
    const Duration(milliseconds: 500),
    () => 'flutter dispose error',
  );
  if (!mounted) return; // the State (and the controller) may be disposed
  _controller.text = lastQuery;
}
```

Правило: после каждого `await` в методе `State` строке, которая обращается к `this`, контроллеру или `setState`, должна предшествовать проверка `mounted`. Здесь один `await`, поэтому одна защита. Если в методе два await и контроллер используется после каждого, нужны две защиты. Линт `use_build_context_synchronously` анализатора Dart ловит версию этой ошибки с `BuildContext`; относитесь к контроллеру точно так же.

Для `Timer` или `stream.listen` защита помещается внутрь колбэка:

```dart
// Flutter 3.44, Dart 3.x
_sub = someStream.listen((value) {
  if (!mounted) return;
  _controller.text = value;
});
```

Ещё лучше -- отменяйте подписку или таймер в `dispose()`, чтобы колбэк никогда не срабатывал после уничтожения. Отмена чище защиты, потому что защищённая, но не отменённая подписка всё равно просыпается, выделяет память и выполняет проверку на каждое событие для экрана, который пользователь уже покинул. Смотрите порядок освобождения в [руководстве по освобождению контроллеров](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

### 2. Исправьте владение: не освобождайте то, что вам не принадлежит

Если сбой не асинхронный, почти всегда дело во владении. Правило в одну строку: тот, кто создаёт контроллер, его и освобождает, и больше никто. Виджет, получающий контроллер через свой конструктор, никогда не должен его освобождать.

```dart
// Flutter 3.44, Dart 3.x
class ParentForm extends StatefulWidget {
  const ParentForm({super.key});
  @override
  State<ParentForm> createState() => _ParentFormState();
}

class _ParentFormState extends State<ParentForm> {
  final _email = TextEditingController(); // parent creates -> parent owns

  @override
  void dispose() {
    _email.dispose(); // owner disposes, exactly once
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => EmailField(controller: _email);
}

class EmailField extends StatelessWidget {
  final TextEditingController controller;
  const EmailField({super.key, required this.controller});

  // Receives the controller. Does NOT dispose it. No dispose() here at all.
  @override
  Widget build(BuildContext context) => TextField(controller: controller);
}
```

Если бы `EmailField` был `StatefulWidget` и освобождал `widget.controller`, последующее использование `_email` родителем выбросило бы именно эту ошибку. Исправление -- удалить этот вызов `dispose()` из дочернего элемента. Зеркальная ошибка (родитель забывает освободить) -- это утечка, рассмотренная в руководстве по освобождению выше.

### 3. Пусть слой управления состоянием владеет освобождением

Когда контроллер поднимается в провайдер Riverpod, контроллер GetX или любой объект вне виджета, освобождение перемещается вместе с ним. Виджет не должен освобождать контроллер, который он одолжил у провайдера, и `onDispose` (Riverpod) или `onClose` (GetX) провайдера -- это место, где теперь живёт вызов `dispose()`. С `autoDispose` в Riverpod держите провайдер живым, пока экран в нём нуждается (используйте `ref.keepAlive()` или провайдер без `autoDispose`), чтобы он не пересчитывался из-под виджета, который всё ещё держит контроллер. Перенос владения жизненным циклом во время миграции управления состоянием -- именно то место, где это тихо ломается; я описал [миграцию приложения Flutter с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) как осознанный, пошаговый переход именно по этой причине.

### 4. Аккуратно пересоздавайте в didUpdateWidget

Если контроллер зависит от свойства `widget` и вы заменяете его в `didUpdateWidget`, освободите старый и присвойте новый, и убедитесь, что ни один ожидающий колбэк по-прежнему не ссылается на старый экземпляр:

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(covariant MyField oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (oldWidget.initialText != widget.initialText) {
    _controller.dispose();
    _controller = TextEditingController(text: widget.initialText);
  }
}
```

Любая асинхронная работа, запущенная против старого контроллера, должна проверять `mounted` (и в идеале быть отменена) до своего завершения, иначе она запишет в освобождённый экземпляр, который вы только что заменили.

## Подводные камни и варианты

`setState() called after dispose()`. Та же корневая причина, другая проверка. Асинхронный колбэк, вызывающий `setState` после уничтожения, выбрасывает это вместо сообщения о контроллере, потому что `setState` внутренне проверяет состояние, эквивалентное `mounted`. Исправление идентично: защищайте через `if (!mounted) return;`. Это часто идёт вместе со сбоем контроллера, поскольку один и тот же колбэк обычно и записывает в контроллер, и вызывает `setState`. Смотрите [setState или markNeedsBuild called during build](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) для родственника этого семейства из фазы build.

`A ScrollController was used after being disposed`, `A FocusNode was used after being disposed`, `An AnimationController was used after being disposed`. Та же проверка, те же исправления. Сообщение называет тот `ChangeNotifier`, к которому вы обратились; диагноз (асинхронность после dispose или неверный владелец) не меняется.

Сбой случается лишь иногда. Это сигнатура асинхронной причины, а не нестабильного фреймворка. Быстрая сеть его скрывает; медленная сеть или шустрый пользователь его обнажают. Не списывайте прерывистую версию этой ошибки на шум. Воспроизведите её, добавив искусственную задержку перед записью в контроллер и закрыв экран во время задержки.

Падает в тестах, но не в приложении. Виджет-тесты агрессивно уничтожают виджеты и детерминированно прокачивают кадры, поэтому отсутствующая защита `mounted`, которая прячется в реальном приложении, немедленно всплывает под `testWidgets`. Это тест делает свою работу. Команда Flutter отслеживает один из вариантов этого в [issue 98965 flutter/flutter](https://github.com/flutter/flutter/issues/98965), где ожидающие таймеры в тестах обращаются к освобождённым контроллерам; исправление там тоже -- отменить таймер в `dispose()`.

Повторное использование одного контроллера двумя `TextField` на разных маршрутах. У контроллера один владелец. Если вы храните `TextEditingController` в долгоживущем синглтоне и передаёте его полю на экране A и другому на экране B, освобождение одного экрана освобождает контроллер из-под другого. Дайте каждому полю свой контроллер или перенесите текст в общее состояние и пусть каждое поле владеет локальным контроллером.

Единственная дисциплина, устраняющая весь этот класс багов: у контроллера ровно один владелец, этот владелец освобождает его ровно один раз, и каждый асинхронный путь, обращающийся к нему, защищён проверкой `mounted` или отменён до уничтожения. Внедрите это в свой рефлекс `dispose()`, и ошибка перестанет появляться. Если вы также хотите ловить обратный сбой (контроллеры, которые вообще не освобождаются), [рабочий процесс leak_tracker в руководстве по освобождению](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) заставит вас соблюдать обе стороны контракта, а моделирование асинхронных данных как состояния с [аккуратными состояниями загрузки и ошибки](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) полностью убирает опасные записи после await из контроллера.

## Связанные материалы

- [Как освобождать контроллеры во Flutter, чтобы избежать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) -- зеркальное отражение: этот сбой -- использование освобождённого контроллера, то руководство -- забывание освободить контроллер.
- [Исправление: setState() или markNeedsBuild() called during build во Flutter](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) разделяет исправление с защитой `mounted` для асинхронных колбэков.
- [Как изящно обрабатывать сетевые ошибки в приложении Flutter](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) -- источник медленного ответа, который запускает этот сбой.
- [Как показывать состояния загрузки и ошибки с AsyncValue во Flutter Riverpod](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) держит асинхронные результаты в состоянии, а не записывает их прямо в контроллер после await.

## Источники

- [ChangeNotifier, справочник API Flutter](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html) -- где определена проверка "used after being disposed".
- [TextEditingController, справочник API Flutter](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html) -- жизненный цикл контроллера и контракт `dispose()`.
- [State.mounted, справочник API Flutter](https://api.flutter.dev/flutter/widgets/State/mounted.html) -- флаг, который говорит, жив ли ещё контроллер.
- [Issue 98965 flutter/flutter](https://github.com/flutter/flutter/issues/98965) -- ошибка, всплывающая в виджет-тестах из-за ожидающих таймеров.

---
title: "Решение: Looking up a deactivated widget's ancestor is unsafe во Flutter"
description: "Этот сбой означает, что вы вызвали context.of() после того, как виджет покинул дерево, обычно в асинхронном callback или в dispose(). Захватите значение до await или в didChangeDependencies()."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ru"
translationOf: "2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-14
---

Вы использовали `BuildContext`, чтобы найти предка (`Navigator.of`, `Theme.of`, `ScaffoldMessenger.of`, `MediaQuery.of`, `Provider.of`, `InheritedWidget`), после того как виджет, которому принадлежит этот контекст, был удалён из дерева. Два обычных триггера: асинхронный callback, который завершается после того, как пользователь ушёл на другой экран, и поиск внутри `dispose()`. Решение в том, чтобы захватить всё нужное из контекста до `await` (или в `didChangeDependencies`) и защитить работу после await проверкой `if (!mounted) return;`. В этом руководстве используются Flutter 3.44 (стабильная версия, май 2026) и Dart 3.x.

`BuildContext` -- это всего лишь дескриптор `Element` в дереве. Как только этот элемент деактивирован, обход вверх от него может вернуть устаревшего предка или узел, который вот-вот переместится, поэтому фреймворк отказывает в поиске вместо того, чтобы выдать неверный ответ. Это та же семья ошибок жизненного цикла, что и [контроллер, использованный после освобождения](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/): объект ещё существует, но трогать его уже недопустимо.

## Ошибка в контексте

Полное сообщение, которое печатает Flutter, выглядит так:

```
FlutterError (Looking up a deactivated widget's ancestor is unsafe.
At this point the state of the widget's element tree is no longer stable.
To safely refer to a widget's ancestor in its dispose() method, save a reference
to the ancestor by calling dependOnInheritedWidgetOfExactType() in the widget's
didChangeDependencies() method.)
```

В release-сборках текст утверждения вырезается, и вместо него вы видите голый сбой или `Null check operator used on a null value` ниже по стеку, потому что поиск вернул `null`. Утверждение срабатывает из `Element._debugCheckStateIsActiveForAncestorLookup` в `package:flutter/src/widgets/framework.dart`, которое каждый вызов `dependOnInheritedWidgetOfExactType` и `findAncestorStateOfType` выполняет первым в режиме debug.

## Почему "deactivated" отличается от "disposed"

Flutter разбирает виджет в две фазы. Сначала выполняется `deactivate()`: элемент отсоединяется от родителя и перемещается в список неактивных, где он может быть реактивирован в том же кадре, если был перемещён с `GlobalKey`. Только если он не востребован к концу кадра, выполняется `dispose()` и состояние окончательно умирает.

Геттер `mounted` у `State` равен `false` для обеих фаз. Это ключевая мысль: `mounted` означает не "ещё не освобождён", а "в данный момент присоединён к дереву". Поэтому `mounted` -- правильная защита для этой ошибки, даже если слово в сообщении -- "deactivated", а не "disposed".

```dart
// Flutter 3.44, Dart 3.x
@override
void deactivate() {
  // mounted is already false by the time your async callback resumes here
  super.deactivate();
}
```

## Минимальное воспроизведение: поиск после await

Самая распространённая форма. Вы нажимаете кнопку, выполняете асинхронную работу, затем трогаете контекст. Если пользователь возвращается назад во время await, контекст деактивирован к моменту возобновления callback.

```dart
// Flutter 3.44, Dart 3.x -- crashes if the user leaves mid-await
class SaveButton extends StatefulWidget {
  const SaveButton({super.key});
  @override
  State<SaveButton> createState() => _SaveButtonState();
}

class _SaveButtonState extends State<SaveButton> {
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 2)); // network call
    // If the widget was popped during those 2s, this throws:
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Saved')),
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(onPressed: _save, child: const Text('Save'));
  }
}
```

Второе воспроизведение -- поиск в `dispose()`, который всегда небезопасен, потому что элемент к этому моменту уже отсоединён:

```dart
// Flutter 3.44, Dart 3.x -- always throws in debug
@override
void dispose() {
  // The element is detached; this ancestor lookup is the exact thing the
  // assertion forbids.
  final messenger = ScaffoldMessenger.of(context);
  messenger.clearSnackBars();
  super.dispose();
}
```

## Решение 1: захватите до await, защитите после

Это правильное решение для асинхронного случая и первое, к которому стоит обратиться. `BuildContext` безопасно читать только пока виджет смонтирован, поэтому читайте всё нужное из него синхронно, до первого `await`. После этого любой захваченный объект (`NavigatorState`, `ScaffoldMessengerState`) остаётся действительным, даже если виджет покидает дерево, потому что эти объекты состояния переживают отдельный поиск элемента.

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _save() async {
  // Capture the ancestor state objects while still mounted.
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);

  await Future<void>.delayed(const Duration(seconds: 2));

  if (!mounted) return; // the widget left the tree; stop here

  messenger.showSnackBar(const SnackBar(content: Text('Saved')));
  navigator.pop();
}
```

Здесь работают две вещи. Захват `messenger` и `navigator` до `await` означает, что вы никогда не вызываете `.of(context)` на деактивированном контексте. Затем `if (!mounted) return;` полностью пропускает обновления интерфейса, если пользователь уже ушёл, чего вы почти всегда и хотите. Обратите внимание, что `mounted` нужно проверять после `await`, а не до, потому что именно на await открывается разрыв.

Начиная с Flutter 3.7 есть также геттер `BuildContext.mounted`, поэтому если у вас есть только контекст (а не `State`), вы можете написать `if (!context.mounted) return;`. Правило линтера `use_build_context_synchronously`, включённое по умолчанию в `flutter_lints`, помечает именно отсутствующую защиту в этом воспроизведении, поэтому включите его и дайте анализатору ловить такие случаи до времени выполнения.

## Решение 2: читайте inherited widgets в didChangeDependencies

Если вам действительно нужно унаследованное значение во время `dispose()`, например чтобы отписаться от чего-то, что вы нашли через `.of(context)`, вы не можете найти его в момент dispose. Захватите его раньше. `didChangeDependencies()` выполняется сразу после `initState` и снова всякий раз, когда меняется унаследованная зависимость, и контекст там полностью действителен.

```dart
// Flutter 3.44, Dart 3.x -- safe dispose-time access
class _MyWidgetState extends State<MyWidget> {
  late MyModel _model;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Captured while mounted; survives into dispose().
    _model = MyModelScope.of(context);
  }

  @override
  void dispose() {
    _model.removeListener(_onChange); // no context lookup needed
    super.dispose();
  }
}
```

Это в точности то, что велит вам сделать сообщение об ошибке, в современном виде: текст по-прежнему говорит `dependOnInheritedWidgetOfExactType()`, и это низкоуровневый вызов, который оборачивают `Theme.of`, `MediaQuery.of` и им подобные. Вы редко вызываете его напрямую; вызов типизированного аксессора `.of` в `didChangeDependencies` делает то же самое.

## Решение 3: не ищите контекст внутри callback, которыми вы не управляете

Тонкий вариант: поиск не в вашем `dispose()`, а в callback, который срабатывает после dispose, например `Timer`, слушатель потока, слушатель статуса анимации или `Future.then`. Решение -- та же защита, но также стоит отменить источник в `dispose()`, чтобы callback вообще перестал срабатывать.

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<int>? _sub;

@override
void initState() {
  super.initState();
  _sub = someStream.listen((value) {
    if (!mounted) return;          // guard
    Navigator.of(context).pushNamed('/next');
  });
}

@override
void dispose() {
  _sub?.cancel();                  // stop the source
  super.dispose();
}
```

Отмена подписки -- это ремень; проверка `mounted` -- это подтяжки. Одной отмены обычно достаточно, но callback, уже находившийся в полёте, когда выполняется `cancel()`, всё ещё может возобновиться один раз, поэтому сохраняйте защиту. Та же пара применяется, когда вы [освобождаете контроллеры и другие ресурсы](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): освободите источник и защитите всё, что может сработать с запозданием.

## Подводные камни и похожие случаи

**`initState` слишком рано для `.of(context)` с inherited widgets.** Вы можете читать `context` в `initState` для некоторых вещей, но `dependOnInheritedWidgetOfExactType` (а значит, `Theme.of`, `MediaQuery.of`) там не разрешён, потому что элемент ещё не подключён к своим унаследованным зависимостям. Перенесите эти чтения в `didChangeDependencies`. Это бросает другое утверждение ("dependOnInheritedWidgetOfExactType was called before initState completed"), так что если ваше сообщение упоминает `initState`, перед вами вариант раннего поиска, а не деактивации.

**`Navigator.pop`, за которым следует использование контекста.** Частый паттерн в FlutterFlow и самописных формах -- `Navigator.pop(context)`, а затем, на следующей строке, ещё один вызов `.of(context)`. После pop элемент маршрута начинает деактивироваться, поэтому второй поиск может бросить ошибку. Захватите navigator или messenger до pop.

**Перемещение с `GlobalKey`.** Если вы перемещаете поддерево с `GlobalKey`, и что-то внутри него выполняет поиск предка во время кадра перемещения, вы можете столкнуться с этим временно. Это реже; решение -- отложить поиск на после кадра с `WidgetsBinding.instance.addPostFrameCallback`, а затем повторно проверить `mounted`.

**Release-сборки скрывают это.** Поскольку сообщение исходит из `assert`, оно печатается только в debug. В profile и release поиск молча возвращает `null`, и вы падаете позже на разыменовании null. Если вы видите `Null check operator used on a null value` только в release и только после навигации, подозревайте это. [Защита `setState() called during build`](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) ведёт себя так же: утверждение только для debug, скрывающее null в режиме release.

**Версия этого в Riverpod.** Если вы используете `WidgetRef` вместо `BuildContext`, эквивалентный сбой -- [`Cannot use "ref" after the widget was disposed`](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Та же первопричина, то же решение: читайте до await, защищайте после. Обращение к структурированному асинхронному паттерну вроде [`AsyncValue` для состояний загрузки и ошибки](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) обходит большинство этих ручных защит, потому что фреймворк отслеживает жизненный цикл виджета за вас.

## Одно правило, которое предотвращает все эти случаи

Считайте `BuildContext` действительным только между `build` и следующей точкой приостановки. В тот момент, когда вы вызываете `await`, контекст может исчезнуть к моменту возврата, поэтому сначала захватите нужное и защитите его с помощью `mounted`, либо перестройте так, чтобы поиск никогда не пересекал асинхронную границу. Как только эта привычка усвоена, сбой "deactivated widget's ancestor", сбой освобождённого контроллера и сбой освобождённого ref перестают появляться -- все по одной и той же причине.

## Sources

- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html) и [State.didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html), документация API Flutter.
- [BuildContext.dependOnInheritedWidgetOfExactType](https://api.flutter.dev/flutter/widgets/BuildContext/dependOnInheritedWidgetOfExactType.html), документация API Flutter (вызов, названный в сообщении об ошибке).
- [flutter/flutter#19462: "Looking up a deactivated widget's ancestor is unsafe"](https://github.com/flutter/flutter/issues/19462), канонический issue, прослеживающий это до `Navigator.push` внутри асинхронного callback.
- [use_build_context_synchronously lint](https://dart.dev/tools/linter-rules/use_build_context_synchronously), правила линтера Dart, которые статически помечают отсутствующую защиту.

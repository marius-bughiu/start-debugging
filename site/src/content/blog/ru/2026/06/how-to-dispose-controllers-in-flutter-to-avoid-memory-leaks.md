---
title: "Как освобождать контроллеры во Flutter, чтобы избежать утечек памяти"
description: "AnimationController, TextEditingController и ScrollController удерживают ресурсы, которые сборщик мусора Dart не может освободить, пока вы их не освободите. Вот правильный шаблон, правила порядка и как обнаружить утечки до публикации."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "memory"
lang: "ru"
translationOf: "2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks"
translatedBy: "claude"
translationDate: 2026-06-01
---

Если контроллер предоставляет метод `dispose()`, вы обязаны вызвать его из вашего `State.dispose()`, причём до `super.dispose()`. Конкретно: создайте контроллер в `initState` (или как поле `late final`), вызовите `controller.dispose()` в `dispose()`, а для `AnimationController` добавьте `SingleTickerProviderStateMixin`, чтобы тикер остановился, когда виджет покинет дерево. Пропуск любого из этих шагов оставляет живыми и достижимыми `Ticker`, список слушателей или подписку на поток, что удерживает всё поддерево виджетов в памяти. В этом руководстве используется Flutter 3.44 (stable, май 2026) и Dart 3.x.

Сборка мусора вас здесь не спасёт. Сборщик мусора Dart освобождает объекты, которые больше недостижимы, но работающий `AnimationController` достижим из списка тикеров `SchedulerBinding`, а `TextEditingController`, который вы передали в `TextField`, достижим из графа слушателей, пока что-либо удерживает контроллер. Утечка не является ошибкой сборщика мусора. Это ошибка владения: вы создали ресурс и никогда его не освободили.

## Почему контроллер переживает свой виджет

`StatefulWidget` дёшев и одноразов. Flutter постоянно пересоздаёт объект виджета. Объект `State` это то, что имеет жизненный цикл, и контроллеры, которые вы создаёте, принадлежат этому `State`. Когда виджет удаляется из дерева, Flutter вызывает `State.dispose()` ровно один раз. Этот вызов ваш единственный шанс освободить нативные и фреймворковые ресурсы.

Три категории контроллеров текут по-разному:

`AnimationController` регистрирует `Ticker` в `SchedulerBinding`. Тикер вызывает callback на каждом кадре, пока анимация работает. Пока вы не освободите контроллер (что освобождает тикер), `SchedulerBinding` удерживает ссылку на тикер, тикер удерживает ссылку на ваш callback, а ваш callback захватывает `this`, ваш `State` и через него всё поддерево. В отладочных сборках Flutter фактически бросает assertion по этому поводу: если вы забудете `dispose`, вы получите `AnimationController.dispose() called more than once` или assertion о всё ещё активном тикере при уничтожении виджета.

`TextEditingController`, `ScrollController` и `FocusNode` это `ChangeNotifier` (или содержат его). Они ведут список слушателей. `TextField` добавляет себя как слушателя, чтобы перерисовываться при изменении текста. Если вы также вызываете `controller.addListener(...)` и никогда не освобождаете, контроллер, его список слушателей и каждое замыкание в этом списке остаются живыми. Контроллер удерживает слушателей, а не наоборот, поэтому сборщик мусора не может собрать ни одного из них.

`StreamSubscription` и `Timer` имеют ту же форму без имени `dispose()`: вы вызываете `subscription.cancel()` и `timer.cancel()`. Живая подписка ссылается из потока, который удерживает живым ваш callback `onData`.

Объединяющее правило, прямо из [документации API State.dispose](https://api.flutter.dev/flutter/widgets/State/dispose.html) команды Flutter: "Если метод build у State зависит от объекта, который сам может менять состояние, ... подпишитесь на этот объект во время initState ... и отпишитесь в dispose".

## Минимальное воспроизведение с утечкой

Вот виджет, который течёт всеми тремя типами ресурсов. Он компилируется и работает. Он просто никогда ничего не отпускает.

```dart
// Flutter 3.44, Dart 3.x -- DO NOT COPY, this leaks on purpose.
import 'dart:async';
import 'package:flutter/material.dart';

class LeakyScreen extends StatefulWidget {
  const LeakyScreen({super.key});

  @override
  State<LeakyScreen> createState() => _LeakyScreenState();
}

class _LeakyScreenState extends State<LeakyScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(seconds: 1))
        ..repeat();
  final TextEditingController _text = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final StreamSubscription<int> _ticks =
      Stream.periodic(const Duration(seconds: 1), (i) => i).listen((_) {});

  // No dispose() override. Every push/pop of this screen leaks
  // one AnimationController, one ticker, one TextEditingController,
  // one ScrollController, and one live StreamSubscription.

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Откройте и закройте этот экран 50 раз, и у вас будет 50 тикеров, срабатывающих на каждом кадре, 50 подписок на потоки, доставляющих события, и 50 отсоединённых поддеревьев виджетов, которые сборщик мусора никогда не тронет. Одни только тикеры анимации заметно ухудшат время кадров, потому что каждый из них всё ещё хочет выполняться на каждом vsync.

## Шаблон освобождения целиком

Исправление механично, как только вы его усвоите. Отразите каждый создаваемый вами ресурс вызовом освобождения в `dispose()`, и поставьте `super.dispose()` последним.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class StableScreen extends StatefulWidget {
  const StableScreen({super.key});

  @override
  State<StableScreen> createState() => _StableScreenState();
}

class _StableScreenState extends State<StableScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim;
  late final TextEditingController _text;
  late final ScrollController _scroll;
  late final FocusNode _focus;
  StreamSubscription<int>? _ticks;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
    _text = TextEditingController();
    _scroll = ScrollController()..addListener(_onScroll);
    _focus = FocusNode();
    _ticks = Stream.periodic(const Duration(seconds: 1), (i) => i)
        .listen(_onTick);
  }

  void _onScroll() {/* react to scroll offset */}
  void _onTick(int value) {/* react to each tick */}

  @override
  void dispose() {
    // Cancel subscriptions and remove listeners first.
    _ticks?.cancel();
    _scroll.removeListener(_onScroll);
    // Then dispose every controller you own.
    _anim.dispose();
    _text.dispose();
    _scroll.dispose();
    _focus.dispose();
    // super.dispose() LAST, always.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text, focusNode: _focus),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Несколько вещей в этом коде являются несущими, поэтому стоит явно проговорить каждую.

### Создавайте в initState, а не в build

`build` выполняется много раз. Если вы пишете `final _text = TextEditingController()` как инициализатор поля со значением без `late`, всё в порядке, потому что инициализаторы полей выполняются один раз. Но если вы когда-либо создадите контроллер внутри `build`, вы выделяете новый при каждой перестройке и сразу же делаете предыдущий сиротой. Создавайте контроллеры в `initState` или как поля `late final`, никогда в `build`.

### Почему super.dispose() идёт последним

Соглашение обратно `initState`. В `initState` вы сначала вызываете `super.initState()`, затем настраиваете своё состояние. В `dispose` вы сначала разбираете своё состояние, затем вызываете `super.dispose()` последним. Базовый `State.dispose()` помечает объект как недействующий; обращение к собственным полям после этого ошибка, и отладочная сборка фреймворка отметит `dispose`, вызванный на уже освобождённом `State`. Разбор ваших ресурсов до возврата управления базовому классу сохраняет порядок согласованным.

### removeListener перед dispose, или просто dispose

Если вы вызвали `addListener` на контроллере, вы можете либо вызвать `removeListener` с тем же callback перед `dispose`, либо положиться на то, что `dispose()` отбросит весь список слушателей. Освобождение `ChangeNotifier` очищает его слушателей, поэтому явный `removeListener` прямо перед `dispose` того же объекта избыточен. Причина сохранить явный `removeListener` в том случае, когда вы добавили себя слушателем к контроллеру, которым не владеете (переданному от родителя). Вы обязаны удалить своего слушателя из этого контроллера в `dispose`, потому что не вы его освобождаете.

## AnimationController нуждается в TickerProvider

`AnimationController` единственный контроллер, которому нужно больше, чем вызов `dispose`: ему нужен аргумент `vsync`, который является `TickerProvider`. `TickerProvider` это то, что привязывает тикер контроллера к частоте обновления экрана и, что критично, к жизненному циклу виджета.

Используйте `SingleTickerProviderStateMixin`, когда `State` владеет ровно одним `AnimationController`. Используйте `TickerProviderStateMixin`, когда он владеет несколькими. Mixin с одним тикером это небольшая оптимизация, и он бросает assertion, если вы случайно создадите два контроллера против него, что является полезной защитой.

```dart
// Flutter 3.44 -- one controller
class _OneAnim extends State<OneAnim>
    with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _c.dispose(); super.dispose(); }
}

// Flutter 3.44 -- multiple controllers
class _ManyAnim extends State<ManyAnim>
    with TickerProviderStateMixin {
  late final _a = AnimationController(vsync: this, duration: ...);
  late final _b = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _a.dispose(); _b.dispose(); super.dispose(); }
}
```

Если ваша анимация проста, самый чистый способ никогда не утечь контроллером не владеть им вовсе. Виджеты неявной анимации, такие как `AnimatedContainer`, `AnimatedOpacity` и `TweenAnimationBuilder`, управляют своими контроллерами внутри и освобождают их за вас. Прибегайте к явному `AnimationController` только тогда, когда вам нужно самостоятельно управлять, разворачивать, повторять или связывать анимацию. Профилирование джанка анимации это отдельный навык: если ваши анимации плавны, но приложение всё равно дёргается, причина обычно в работе на UI-потоке, что я разбираю в [руководстве по профилированию джанка в приложении Flutter с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

## Кто владеет контроллером, тот решает, кто его освобождает

Самая частая реальная утечка (и самый частый сбой из-за двойного освобождения) исходит из неясного владения. Правило: кто создаёт контроллер, тот его освобождает. Если контроллер создан в виджете A и передан в виджет B, то A освобождает его, а B не должен.

Это важно, потому что виджеты Flutter часто принимают контроллер как параметр конструктора именно для того, чтобы родитель мог ими управлять. `TextField`, `ListView`, `PageView` и `TabBar` все принимают необязательный контроллер. Когда вы передаёте его, вы сохраняете ответственность за освобождение:

```dart
// Flutter 3.44, Dart 3.x
class FormSection extends StatefulWidget {
  // This widget OWNS the controller, so it disposes it.
  const FormSection({super.key});
  @override
  State<FormSection> createState() => _FormSectionState();
}

class _FormSectionState extends State<FormSection> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose(); // owner disposes
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The child widget receives the controller but must NOT dispose it.
    return NameField(controller: _name);
  }
}

class NameField extends StatelessWidget {
  final TextEditingController controller;
  const NameField({super.key, required this.controller});

  @override
  Widget build(BuildContext context) =>
      TextField(controller: controller); // no dispose here
}
```

Если бы `NameField` освободил контроллер, который не создавал, родитель позже попытался бы использовать освобождённый контроллер и упал бы с `A TextEditingController was used after being disposed`. У этой конкретной ошибки своя диагностика, но коренная причина почти всегда два виджета, спорящих за жизненный цикл одного контроллера.

Противоположная ошибка поднимает контроллер в слой управления состоянием (`ChangeNotifier`, `Notifier` Riverpod, контроллер GetX), а затем забывает, что теперь освобождением владеет слой. Если вы перемещаете `TextEditingController` из `State` в провайдер Riverpod, `onDispose`/`dispose` провайдера это место, где теперь живёт вызов `controller.dispose()`, а не виджет. Когда вы перестраиваете владение жизненным циклом во время миграции управления состоянием, это именно тот тип вещей, который ломается молча, что отчасти объясняет, почему я описал [миграцию приложения Flutter с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) как аккуратный, пошаговый переход, а не как поиск с заменой.

## Граничные случаи, которые кусаются

**Условное создание.** Если контроллер создаётся только на некоторых путях кода, сделайте поле допускающим null и защитите освобождение: `_optional?.dispose();`. Не оставляйте контроллер `late final` неинициализированным, а затем вызывайте на нём `dispose`, что бросает `LateInitializationError`.

**Пересоздание контроллера при обновлении виджета.** Если ваш контроллер зависит от свойства `widget`, вам может потребоваться освободить старый и создать новый в `didUpdateWidget`. Шаблон: в `didUpdateWidget` сравните `oldWidget.x` с `widget.x`, и если они различаются, `_controller.dispose()`, затем назначьте новый. Забыть освобождение в `didUpdateWidget` означает утечь по одному контроллеру на каждое релевантное изменение свойства.

**GlobalKey и контроллеры это разные вещи.** `GlobalKey` не нуждается в освобождении, но контроллер, достигаемый через key, нуждается. Не путайте эти два.

**Hot reload скрывает утечки.** Hot reload сохраняет `State`, поэтому забытый `dispose` может не проявиться во время разработки. Вы замечаете это только когда экран действительно открывается и закрывается, или под трекером утечек. Тестируйте реальный путь навигации, а не только hot reload.

**Тяжёлая работа в callback контроллера должна быть вне UI-потока.** Если ваш слушатель `ScrollController` или `AnimationController` делает существенные вычисления, эта работа выполняется в UI-изоляте и конкурирует с отрисовкой. Перенесите её в фоновый изолят; я прохожу это в [написании изолята Dart для работы, нагружающей CPU](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

## Обнаружение утечек до публикации

Вам не нужно искать их чтением кода. Flutter поставляет `leak_tracker`, и начиная с Flutter 3.x тестовый фреймворк интегрируется с ним, так что утечки освобождения автоматически проваливают ваши тесты виджетов, когда отслеживание утечек включено. Команда Flutter документирует процесс в [официальном руководстве по отслеживанию утечек](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md). Ментальная модель: ожидается, что каждый освобождаемый объект будет освобождён; если сборщик мусора собирает тот, который никогда не освобождался, это утечка "не освобождён", а если объект освобождён, но никогда не собран, это утечка "не собран сборщиком мусора". Обе сообщаются с трассировкой стека выделения, поэтому вас направляют прямо к `initState`, создавшему сироту.

Для работающего приложения откройте DevTools и используйте представление Memory. Откройте и закройте подозрительный экран несколько раз, принудительно запустите сборку мусора и наблюдайте за количеством экземпляров `AnimationController`, `TextEditingController` или вашего класса `State`. Если количество растёт и никогда не падает, у вас утечка, и представление пути удержания покажет вам, что всё ещё указывает на объект. Та же сессия DevTools это место, где вы исследовали бы тайминг кадров, что пересекается с процессом профилирования джанка.

Дисциплина достаточно проста, чтобы сформулировать её в одну строку, и её стоит превратить в рефлекс код-ревью: на каждый `Controller`, `FocusNode`, `StreamSubscription` и `Timer`, который вы создаёте в `State`, есть ровно один соответствующий вызов освобождения в `dispose()`, и `super.dispose()` это последняя инструкция метода. Подключите `leak_tracker` к вашим тестам виджетов, и фреймворк будет вас к этому принуждать.

## Похожее

- [Как профилировать джанк в приложении Flutter с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) охватывает представления Memory и Performance, которые вы используете для подтверждения утечки.
- [Как написать изолят Dart для работы, нагружающей CPU](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) это то, где должны выполняться callback контроллеров, делающие реальную работу.
- [Как мигрировать приложение Flutter с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) показывает, как смещается владение освобождением, когда вы меняете слой управления состоянием.
- [Решение: RenderFlex overflowed во Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/) это другая классическая ошибка Flutter, с которой вы сталкиваетесь, создавая те же экраны.

## Источники

- [State.dispose, справочник API Flutter](https://api.flutter.dev/flutter/widgets/State/dispose.html)
- [AnimationController, справочник API Flutter](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [TextEditingController, справочник API Flutter](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html)
- [Обзор leak_tracker, dart-lang/leak_tracker](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md)
- [Использование представления Memory, документация Flutter DevTools](https://docs.flutter.dev/tools/devtools/memory)

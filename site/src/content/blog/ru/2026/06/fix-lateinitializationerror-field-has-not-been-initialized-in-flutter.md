---
title: "Исправление: LateInitializationError: Field '...' has not been initialized в Flutter"
description: "Этот сбой означает, что вы прочитали late-поле до того, как ему что-либо присвоили. Инициализируйте его синхронно в initState или откажитесь от late и смоделируйте асинхронное значение как nullable-состояние."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "ru"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Поле `late` было прочитано до того, как какой-либо код присвоил ему значение. У поля нет выражения-инициализатора, поэтому Dart не может вычислить его лениво, и чтение произошло до задуманного вами присваивания. Самая частая причина во Flutter -- это поле `late`, которому вы присваиваете значение из асинхронного метода (сетевой запрос, чтение из базы данных), тогда как `build()` выполняется первым и обращается к полю до завершения future. Исправление зависит от тайминга: если значение доступно синхронно, присвойте его в `initState()` до первой сборки; если оно появляется только позже, вообще не используйте `late` -- объявите поле допускающим null (`Type?`) и отображайте состояние загрузки, пока оно не установлено. В этом руководстве используются Flutter 3.44 (stable, май 2026) и Dart 3.x. Сам модификатор `late` существует ещё с Dart 2.12.

## Ошибка в контексте

Полное сообщение, которое выбрасывает Dart, выглядит так:

```
LateInitializationError: Field '_user' has not been initialized.
#0      _MyScreenState._user (package:my_app/screens/my_screen.dart)
#1      _MyScreenState.build (package:my_app/screens/my_screen.dart:42:25)
#2      StatefulElement.build (package:flutter/src/widgets/framework.dart)
...
```

Верхний кадр, синтетический геттер `_user`, -- это чтение, которое не удалось. Кадр сразу под ним, здесь `build`, -- это строка вашего кода, которая обратилась к полю. На этой строке проявляется сбой, но баг -- это отсутствие присваивания, которое должно было выполниться до неё. `LateInitializationError` -- это подтип `Error`, а не `Exception`, и так Dart сообщает вам, что это ошибка программирования, а не восстановимое условие времени выполнения. Вы исправляете поток управления; вы не перехватываете её.

У сообщения есть три близких родственника, и формулировка подсказывает, на какого из них вы наткнулись:

```
LateInitializationError: Field '_user' has not been initialized.
LateInitializationError: Local 'result' has not been initialized.
LateInitializationError: Field '_id' has already been initialized.
```

"Field" означает поле экземпляра или статическое поле; "Local" означает локальную переменную внутри функции. "has already been initialized" -- противоположная ошибка: присваивание полю `late final` дважды. У них общее семейство первопричин, но не одно и то же исправление, и раздел о вариантах ниже описывает остальные.

## Почему это происходит

Есть четыре причины, в примерном порядке того, как часто они досаждают.

Значение присваивается асинхронно, но читается синхронно. Вы объявили `late User _user;` и присваиваете его внутри `async`-метода, который запускаете из `initState()`. Но `initState()` возвращается немедленно, первый `build()` выполняется, пока запрос ещё в полёте, и `build()` читает `_user`. Ничего ему ещё не присвоено, поэтому чтение выбрасывает ошибку. Это безусловно самая частая форма этого бага, и она коварна, потому что это гарантированный сбой, а не плавающий: future никогда не завершается до первого кадра, поэтому он падает каждый раз при открытии экрана.

Присваивание находится в ветке, которая не выполнилась. Вы написали `late String _label;` и присваиваете значение только внутри `if` или ветки `switch`. Когда условие ложно или ни одна ветка не совпадает, поле остаётся без присваивания, и следующее чтение выбрасывает ошибку. Компилятор Dart принимает это, потому что `late` -- это ваше обещание анализатору, что вы присвоите значение до чтения; анализатор прекращает проверку определённого присваивания и доверяет вам.

Вы вообще забыли присваивание. Поле было объявлено `late` во время рефакторинга, строка, которая его устанавливала, была удалена или никогда не написана, и анализатор промолчал, потому что `late` отключает проверку определённого присваивания. Это случай, когда исправление состоит просто в том, чтобы присвоить значение.

Полю нужны данные `InheritedWidget`, а вы присвоили их слишком рано. Если значение приходит из `Theme.of(context)`, `MediaQuery.of(context)`, `Provider` или любого `InheritedWidget`, вы не можете прочитать его в конструкторе или в инициализаторах полей, потому что элемент ещё не примонтирован в дерево. Присваивание в `initState()` тоже слишком рано для унаследованных данных. Правильный хук -- это `didChangeDependencies()`, и ошибка здесь оставляет поле `late` без присваивания на момент первой сборки.

Лежащий в основе контракт из документации языка Dart о [модификаторе `late`](https://dart.dev/language/variables#late-variables): полю `late` без инициализатора должно быть присвоено значение до его чтения, а чтение первым -- это ошибка времени выполнения. Поле `late` с инициализатором отличается: инициализатор выполняется лениво при первом чтении, поэтому оно никогда не может быть "не инициализировано". Это различие -- ключ к самым чистым исправлениям ниже.

## Минимальное воспроизведение

Этот экран падает каждый раз при открытии. Он компилируется без предупреждения.

```dart
// Flutter 3.44, Dart 3.x -- throws "LateInitializationError: Field '_user' has not been initialized".
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late User _user; // promise: I will assign this before reading it

  @override
  void initState() {
    super.initState();
    _load(); // fire-and-forget async; returns before _user is set
  }

  Future<void> _load() async {
    final fetched = await fetchUser(); // ~300ms network round trip
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    // First build runs while _load() is still awaiting. This read throws.
    return Text(_user.name);
  }
}

class User {
  final String name;
  User(this.name);
}

Future<User> fetchUser() =>
    Future.delayed(const Duration(milliseconds: 300), () => User('Ada'));
```

Последовательность такая: `initState()` выполняется и запускает `_load()`, `_load()` доходит до своего первого `await` и уступает управление, Flutter переходит к первому `build()`, `build()` читает `_user`, и ничего ему ещё не присвоено. Тот `setState(() => _user = fetched)`, который установил бы его, выполняется 300ms спустя. Первый кадр проигрывает гонку каждый раз.

## Исправление подробно

Исправления упорядочены по тому, насколько я их рекомендую. Выберите то, что соответствует вашей причине.

### 1. Если значение асинхронное, не используйте late -- смоделируйте его как nullable-состояние (рекомендуется)

`late` -- неподходящий инструмент для значения, которое приходит после первой сборки. Он обещает, что значение готово синхронно; ожидаемый через await запрос таким не является. Объявите поле допускающим null и отображайте состояние загрузки, пока оно равно null. Теперь система типов вынуждает вас обрабатывать "ещё не загружено" вместо того, чтобы падать на этом.

```dart
// Flutter 3.44, Dart 3.x -- correct: nullable field, explicit loading state.
class _ProfileScreenState extends State<ProfileScreen> {
  User? _user; // null means "not loaded yet"

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final fetched = await fetchUser();
    if (!mounted) return; // the screen may be gone by now
    setState(() => _user = fetched);
  }

  @override
  Widget build(BuildContext context) {
    final user = _user;
    if (user == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Text(user.name);
  }
}
```

Защита `if (!mounted) return;` перед `setState` здесь не опциональна: асинхронный колбэк, который разрешается после того, как пользователь покинул экран, иначе выбросит другую ошибку. Эта защита -- та же дисциплина, что нужна вам для [безопасного использования BuildContext после await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), и она сопровождает каждый ожидаемый через await колбэк в `State`.

Для чего-либо большего, чем одно значение, предпочитайте `FutureBuilder` или, если вы на Riverpod, `AsyncValue`, который кодирует загрузку, ошибку и данные как три явных случая. Запись результата прямо в поле после await -- это в точности тот паттерн, который порождает этот сбой и его родственников времени высвобождения; моделирование запроса как состояния вместо этого описано в [отображении состояний загрузки и ошибки с AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 2. Если значение синхронное, присвойте его в initState до первой сборки

`late` уместен, когда значение действительно доступно до сборки, но вы не можете вычислить его в инициализаторе поля (например, ему нужен `widget`). Присвойте его в `initState()`, который выполняется один раз до первого `build()`.

```dart
// Flutter 3.44, Dart 3.x -- correct: late assigned synchronously, before build.
class _EditorState extends State<Editor> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TextField(controller: _controller);
}
```

Это законное использование `late final` в `State`: вам нужен `widget.initialText`, который недоступен в инициализаторе поля, но доступен в `initState()`, который всё ещё выполняется до любой сборки. Поскольку контроллер создаётся ровно один раз и никогда не переприсваивается, `late final` -- правильный модификатор, и вы всё ещё обязаны вызвать для него `dispose()`, как излагает [руководство по высвобождению контроллеров](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

### 3. Используйте ленивый инициализатор, чтобы поле никогда не могло остаться без присваивания

Если значение можно вычислить по требованию и оно не зависит от `widget` или `context`, дайте полю `late` выражение-инициализатор. Тогда Dart выполняет это выражение лениво при первом чтении, поэтому поле инициализирует себя само в первый раз, когда кто-либо к нему обращается. Поле `late` с инициализатором не может выбросить "has not been initialized".

```dart
// Flutter 3.44, Dart 3.x -- correct: lazy initializer, computed on first read.
class Report {
  // Expensive to build; only built if something actually reads it.
  late final List<int> histogram = _buildHistogram();

  List<int> _buildHistogram() {
    // ...expensive work...
    return List<int>.filled(256, 0);
  }
}
```

Это тот единственный случай, когда `late` оправдывает себя чисто ради производительности: работа откладывается до тех пор, пока не понадобится, и полностью пропускается, если `histogram` никогда не читается. Если инициализатор дешёвый, откажитесь от `late` и инициализируйте при объявлении вместо этого; ленивая инициализация стоит модификатора только тогда, когда вычисление дорогое или имеет побочные эффекты, которые вы хотите отложить.

### 4. Читайте данные InheritedWidget в didChangeDependencies, не раньше

Если поле `late` питается из `Theme.of`, `MediaQuery.of` или провайдера, перенесите присваивание в `didChangeDependencies()`. Он выполняется после `initState()` и снова всякий раз, когда меняется унаследованная зависимость, и это самая ранняя точка, где `context` может безопасно разрешить унаследованные виджеты.

```dart
// Flutter 3.44, Dart 3.x -- correct: inherited data resolved in didChangeDependencies.
class _BannerState extends State<Banner> {
  late Color _accent;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _accent = Theme.of(context).colorScheme.primary;
  }

  @override
  Widget build(BuildContext context) => ColoredBox(color: _accent);
}
```

Если делать это в `initState()`, оно либо выбрасывает ошибку (в более старых версиях Flutter), либо возвращает устаревшие данные, которые никогда не обновляются при смене темы. `didChangeDependencies()` исправляет и то, и другое: поле присваивается до первой сборки и переприсваивается всякий раз, когда меняется тема.

## Подводные камни и варианты

`LateInitializationError: Field '...' has already been initialized.` Зеркальное отражение. Вы присвоили значение полю `late final` дважды. `late final` допускает ровно одну запись; вторая выбрасывает эту ошибку. Обычно это происходит, когда `initState()` присваивает значение полю, а более поздний путь выполнения (`didUpdateWidget`, колбэк, второй `_load`) присваивает его снова. Если вам действительно нужно переприсвоить, откажитесь от `final` и оставьте только `late`; если нет -- найдите дублирующую запись и удалите её.

`LateInitializationError: Local '...' has not been initialized.` Та же ошибка на локальной переменной вместо поля. Вы написали `late int total;` внутри функции, и какая-то ветка оставила её без присваивания до чтения. Локальный `late` редко того стоит: предпочитайте инициализировать переменную при её объявлении или перестроить код так, чтобы каждый путь присваивал ей значение до использования. Проверка определённого присваивания анализатора поймала бы это за вас, если бы переменная не была `late` -- именно эту проверку `late` и отключает.

Она выбрасывается в release, но сообщение пропало. В release-сборках машинерия утверждений вырезается, но чтение `late`-без-инициализатора всё равно выбрасывает `LateInitializationError`; сокращается только подробное отладочное сообщение. Не предполагайте, что сбои `late` бывают только в debug. Они доходят до продакшена.

`late` против оператора проверки на null. Хвататься за `late`, чтобы заглушить "the non-nullable field must be initialized", -- тот же инстинкт, что заставляет людей рассыпать `!`, чтобы заглушить nullability. Оба откладывают гарантию времени компиляции до сбоя времени выполнения. Если значение может законно отсутствовать, смоделируйте его как nullable и обработайте null; `late` -- только для значений, которые всегда присутствуют, но присваиваются чуть позже объявления. Более широкая ментальная модель null-безопасности, включая то, когда `late` является, а когда не является правильным запасным выходом, изложена в [чек-листе null-безопасности при переходе с Flutter 2 на 3.x](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

Поле `late`, прочитанное внутри собственного инициализатора. Если ленивый инициализатор `late final x = ...x...;` читает `x`, вы получаете `LateInitializationError` о чтении во время инициализации. Цикл -- это баг; разорвите его, вычислив значение без обращения к полю.

Единственная дисциплина, которая устраняет весь этот класс багов: используйте `late` только для значения, которое всегда присутствует и присваивается синхронно до первого чтения (обычно в `initState()` или `didChangeDependencies()`), и моделируйте всё, что приходит асинхронно, как nullable-состояние с явной веткой загрузки. Встройте это различие в свой рефлекс, и ошибка перестанет появляться. В тот момент, когда вы обнаруживаете, что присваиваете значение полю `late` после `await`, это сигнал переключить его на `Type?` и отобразить промежуточное состояние вместо этого.

## Связанные материалы

- [Как безопасно использовать BuildContext после await во Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) описывает защиту `mounted`, от которой зависит асинхронное исправление выше.
- [Как отображать состояния загрузки и ошибки с AsyncValue во Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) -- структурированная альтернатива записи асинхронных результатов в поле `late`.
- [Исправление: A TextEditingController was used after being disposed во Flutter](/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) -- другая половина жизненного цикла контроллера, в которой участвуют контроллеры `late final`.
- [Как высвобождать контроллеры во Flutter, чтобы избежать утечек памяти](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) сочетается с паттерном `late final TextEditingController` из исправления 2.
- [Перенос приложения с Flutter 2 на Flutter 3.x: чек-лист null-безопасности](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) объясняет, где `late` вписывается в null-безопасность и где nullable-типы -- лучший выбор.

## Источники

- [late variables, Dart language tour](https://dart.dev/language/variables#late-variables) -- контракт для полей `late` с инициализаторами и без них.
- [Understanding null safety, dart.dev](https://dart.dev/null-safety/understanding-null-safety#late-variables) -- обоснование `late` и то, как он взаимодействует с определённым присваиванием.
- [State.initState and State.didChangeDependencies, Flutter API reference](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html) -- какой хук жизненного цикла может безопасно читать унаследованные данные.
- [LateInitializationError, Dart core library API](https://api.dart.dev/stable/dart-core/LateInitializationError-class.html) -- тип ошибки и то, что её вызывает.

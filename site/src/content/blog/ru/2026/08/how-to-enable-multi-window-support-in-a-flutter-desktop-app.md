---
title: "Как включить поддержку нескольких окон в десктопном приложении на Flutter"
description: "Стабильный Flutter 3.44.8 по-прежнему не предоставляет публичного API для нескольких окон. Разбираем, как включить экспериментальный feature flag windowing в канале main, использовать RegularWindowController и WindowManager для настоящих окон верхнего уровня и что применять, если релиз нужен сегодня на стабильной ветке."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "desktop"
  - "multi-window"
  - "windowing"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app"
translatedBy: "claude"
translationDate: 2026-08-04
---

Поддержка нескольких окон во Flutter существует, она работает, и из стабильной сборки её использовать нельзя. По состоянию на Flutter 3.44.8 (выпущен 2026-07-23) фреймворк содержит полноценный windowing API в `packages/flutter/lib/src/widgets/_window.dart`, но каждый класс в нём помечен как `@internal`, файл не экспортируется из `package:flutter/widgets.dart`, а каждый конструктор выбрасывает `UnsupportedError`, если feature flag `windowing` не включён. Этот флаг доступен только в канале `main`. Поэтому честных ответов ровно два: перейти на `main`, выполнить `flutter config --enable-windowing` и использовать настоящий API фреймворка для прототипирования, либо остаться на стабильной ветке и взять плагин `desktop_multi_window`, который даёт отдельные окна ценой отдельных движков и отдельных isolate. В этой статье разбираются оба пути с точной поверхностью API в том виде, в каком она существует в 3.44.

## Почему `runApp` может дать только одно окно

Причина того, что одно окно так долго оставалось значением по умолчанию, не в лени: `runApp` присоединяет ваше дерево виджетов к *неявному view*, единственной `FlutterView`, которую embedder платформы создал ещё до старта Dart. В этом вызове нет шва для второго view, и никогда не было.

Обходной путь давно существует: это `runWidget`, который принимает дерево виджетов с корнем `View` или `ViewCollection` вместо того, чтобы предполагать неявный view. Не хватало второй половины: способа попросить платформу *создать* нативное окно и вернуть привязанную к нему `FlutterView`. Именно это добавляет windowing API. Реализацию ведёт Canonical, и Flutter 3.44 принёс окна-подсказки на всех трёх десктопных платформах, всплывающие окна на macOS, контроллеры окон-спутников и `showDialog`, работающий поверх windowing.

Решение в дизайне, которое сильнее всего влияет на вашу архитектуру: **все окна разделяют один движок и один isolate**. Два окна являются двумя поддеревьями одного и того же дерева виджетов. `ValueNotifier`, который держит общий предок, виден обоим окнам без сериализации, без method channel, без `SendPort`. Это главное отличие от любого подхода на плагинах, и поэтому дождаться этого API часто оказывается правильным решением.

## Включение feature flag windowing

Флаг определён в `flutter_tools` так:

```dart
// packages/flutter_tools/lib/src/features.dart, Flutter 3.44.8
const windowingFeature = Feature(
  name: 'support for windowing on macOS, Linux, and Windows',
  configSetting: 'enable-windowing',
  environmentOverride: 'FLUTTER_WINDOWING',
  runtimeId: 'windowing',
  master: FeatureChannelSetting(available: true),
);
```

Обратите внимание на то, чего здесь нет: записей `beta:` и `stable:` не существует, поэтому обе получают значение по умолчанию `FeatureChannelSetting()` с `available: false`. Бета тоже не подойдёт. Только `main`.

Включается за три шага:

1. **Перейдите на канал main.** Выполните `flutter channel main`, затем `flutter upgrade`. Если стабильный инструментарий нужно сохранить нетронутым, зафиксируйте второй SDK через FVM вместо переключения единственного checkout; тот же приём, что описан в [запуске одного проекта на нескольких SDK Flutter в CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), прекрасно работает и локально.
2. **Включите флаг.** Выполните `flutter config --enable-windowing`. Настройка сохраняется на диск, поэтому делается один раз на SDK. Для CI вместо этого задайте переменную окружения `FLUTTER_WINDOWING=true`, которую инструмент читает как переопределение.
3. **Пересоберите, не делайте hot restart.** Инструмент передаёт включённые флаги во фреймворк как константу времени компиляции с именем `FLUTTER_ENABLED_FEATURE_FLAGS`. Фреймворк читает её в `packages/flutter/lib/src/foundation/_features.dart`:

```dart
// packages/flutter/lib/src/foundation/_features.dart, Flutter 3.44.8
final Set<String> debugEnabledFeatureFlags = <String>{
  ...const String.fromEnvironment('FLUTTER_ENABLED_FEATURE_FLAGS').split(','),
};

bool isWindowingEnabled = debugEnabledFeatureFlags.contains('windowing');
```

`String.fromEnvironment` вычисляется как константа на этапе сборки, поэтому hot restart после переключения настройки её не подхватит. Завершите приложение и запустите `flutter run -d windows` (или `macos`, или `linux`) заново.

Если пропустить шаг 2, вы получите очень конкретную ошибку, которую стоит узнавать, потому что она выбрасывается из конструктора, а не во время рендеринга:

```
Windowing APIs are not enabled.

Windowing APIs are currently experimental. Do not use windowing APIs in
production applications or plugins published to pub.dev.

To try experimental windowing APIs:
1. Switch to Flutter's main release channel.
2. Turn on the windowing feature flag.
```

## Импорт API, который не экспортируется

Поскольку `_window.dart` является приватной библиотекой внутри `package:flutter`, добраться до неё через `package:flutter/widgets.dart` невозможно. Файл реализации импортируется напрямую, а два правила анализатора приглушаются. Ровно так поступает собственное приложение Flutter `examples/multiple_windows`:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member
// ignore_for_file: implementation_imports

import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';
```

Да, это некрасиво, и да, это официально одобренный способ попробовать функцию прямо сейчас. Правило `implementation_imports` существует, чтобы не дать вам сделать так в опубликованном пакете, и именно это написано в заголовке файла: не импортируйте его в приложения для продакшена и ни во что, что вы публикуете на pub.dev, потому что ломающие изменения будут приходить даже в патч-версиях.

## Минимальное приложение с двумя окнами

Самая маленькая полная программа: создайте `RegularWindowController`, оберните его в `RegularWindow` и передайте всё это в `runWidget` вместо `runApp`.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member, implementation_imports
import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final RegularWindowController controller = RegularWindowController(
    preferredSize: const Size(900, 640),
    preferredConstraints: const BoxConstraints(minWidth: 640, minHeight: 480),
    title: 'Main window',
  );

  runWidget(
    WindowManager(
      child: RegularWindow(
        controller: controller,
        child: const MaterialApp(home: HomePage()),
      ),
    ),
  );
}
```

Три вещи здесь несут основную нагрузку.

`WidgetsFlutterBinding.ensureInitialized()` должен идти первым. Фабрика `RegularWindowController` немедленно разрешает `WidgetsBinding.instance.windowingOwner`, а платформенный `WindowingOwner` проверяет утверждением, что движок уже инициализирован. Создание контроллера до появления binding и есть причина утверждения `WindowingOwner[Platform] must be created after the engine has been initialized`, зафиксированного в flutter/flutter#178706.

Контроллер создаёт нативное окно в своём конструкторе, а не при монтировании виджета. `RegularWindow` лишь рендерит в уже существующее окно, поэтому документация прямо говорит: временем жизни владеете вы и `destroy()` нужно вызывать самостоятельно.

`WindowManager` необязателен для одного окна, но брать его стоит сразу. Он устанавливает `WindowRegistry` в дерево, и именно так потомки открывают новые окна, не прокидывая контроллер вручную.

## Открытие второго окна во время выполнения

Схема такая: создать контроллер, обернуть его в `WindowEntry` вместе с builder для содержимого и зарегистрировать. `WindowManager` слушает реестр и рендерит каждую запись подходящим виджетом в зависимости от типа контроллера.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final WindowRegistry registry = WindowRegistry.of(context);

    return Scaffold(
      body: Center(
        child: FilledButton(
          onPressed: () {
            late final WindowEntry entry;
            final RegularWindowController controller = RegularWindowController(
              title: 'Inspector',
              preferredSize: const Size(480, 720),
              delegate: _UnregisterOnDestroy(
                onDestroyed: () => registry.unregister(entry),
              ),
            );
            entry = WindowEntry(
              controller: controller,
              builder: (BuildContext context) => const InspectorPane(),
            );
            registry.register(entry);
          },
          child: const Text('Open inspector'),
        ),
      ),
    );
  }
}

class _UnregisterOnDestroy with RegularWindowControllerDelegate {
  _UnregisterOnDestroy({required this.onDestroyed});

  final VoidCallback onDestroyed;

  @override
  void onWindowDestroyed() {
    super.onWindowDestroyed();
    onDestroyed();
  }
}
```

Танец с `late final WindowEntry entry` не случаен: делегату нужно снять запись с регистрации, а записи нужен контроллер, к которому этот делегат привязан. Собственное эталонное приложение Flutter использует такую же прямую ссылку вперёд.

Снятие с регистрации важно. `WindowRegistry.unregister` лишь убирает запись из списка, чтобы `WindowManager` перестал её рендерить; окно при этом не уничтожается. И наоборот, `destroy()` сносит нативное окно, но оставляет устаревшую запись в реестре. Делегат является точкой соединения: пусть стандартный `onWindowCloseRequested` уничтожит окно, а очистку реестра сделайте в `onWindowDestroyed`.

## Перехват закрытия и остальная поверхность контроллера

У `RegularWindowControllerDelegate` ровно два хука, и стандартная реализация первого из них и есть то, что действительно закрывает ваши окна:

```dart
// packages/flutter/lib/src/widgets/_window.dart, Flutter 3.44.8
void onWindowCloseRequested(RegularWindowController controller) {
  controller.destroy();
}

void onWindowDestroyed() { }
```

Переопределите `onWindowCloseRequested` и *не* вызывайте `super`, когда нужен вопрос о несохранённых изменениях, а затем сами вызовите `controller.destroy()` после подтверждения пользователем. Забыть, что окно закрывает именно `super`, это самый вероятный способ выпустить окно, которое никто не может закрыть.

Сам контроллер предоставляет ожидаемое состояние, и всё оно уведомляет об изменениях, потому что `BaseWindowController` наследует `ChangeNotifier`: `contentSize`, `title`, `isActivated`, `isMaximized`, `isMinimized`, `isFullscreen` и `rootView`. Изменяющие методы: `setSize`, `setConstraints`, `setTitle`, `setMaximized`, `setMinimized`, `setFullscreen(bool fullscreen, {Display? display})`, `activate` и `destroy`. Каждый из них документирован как *запрос*: платформа вправе его проигнорировать, поэтому стройте интерфейс на уведомляемом состоянии, а не на том, что вы попросили.

Внутри поддерева окна до контроллера добираются через inherited model `WindowScope`:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
final BaseWindowController window = WindowScope.of(context);

// Rebuilds only on size changes, not on title or activation changes.
final Size size = WindowScope.contentSizeOf(context);
```

`WindowScope` является `InheritedModel` с ключами по аспектам (размер содержимого, заголовок, активность, развёрнутость, свёрнутость, полноэкранный режим), поэтому `contentSizeOf` не перестроит ваш виджет, когда окно всего лишь получило фокус. Используйте `maybeOf`, если поддерево может выполняться и в неявном окне: у окон, созданных нативной точкой входа, к которой присоединяется `runApp`, нет `WindowScope`, и `of` там выбросит исключение.

## Остальные четыре типа окон

Обычные окна являются одним из пяти типов контроллеров, все они запечатаны под `BaseWindowController` и все рендерятся `WindowManager` через switch:

- `DialogWindowController({BaseWindowController? parent, ...})`. При ненулевом `parent` диалог модален относительно него, не имеет системного меню, скрыт из переключателя окон и закрывается вместе с родителем. При `parent: null` он немодален, может сворачиваться, но не разворачиваться, и получает **отключённую кнопку закрытия**. Последняя деталь удивляет многих; если нужно самостоятельное закрываемое окно, вам нужно обычное окно, а не диалог без родителя.
- `PopupWindowController`, позиционируется относительно якорного прямоугольника. В 3.44 реализован для macOS; Windows и Linux ещё в пути.
- `TooltipWindowController`, в 3.44 реализован на всех трёх десктопных платформах.
- `SatelliteWindowController`, самый новый в наборе, для палитр и панелей инструментов, следующих за родительским окном.

Flutter 3.44 также добавил `showDialog` поверх windowing, который открывает настоящее нативное окно вместо overlay, за флагом `useWindowing` у `MaterialApp`.

## Что делать, если это нужно на стабильной ветке

Если релиз нужен сейчас, API фреймворка отпадает: implementation imports плюс `@internal` плюс задокументированные ломающие изменения в патч-версиях не являются основанием для продакшен-приложения. Практическим ответом остаётся `desktop_multi_window` 0.3.0 (опубликован 2025-10-28) с поддержкой Windows, Linux и macOS.

```dart
// desktop_multi_window 0.3.0, Flutter 3.44.8 stable
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  final windowController = await WindowController.fromCurrentEngine();
  final arguments = parseArguments(windowController.arguments);

  switch (arguments.type) {
    case WindowType.main:
      runApp(const MainWindow());
    case WindowType.inspector:
      runApp(const InspectorWindow());
  }
}
```

Новые окна создаются через `WindowController.create(WindowConfiguration(...))`, а обмен между окнами идёт через `WindowMethodChannel`, то есть через method channel, а значит асинхронно и с ограничениями кодека:

```dart
// desktop_multi_window 0.3.0
const channel = WindowMethodChannel('inspector');
channel.setMethodCallHandler((call) async {
  return switch (call.method) {
    'refresh' => 'ok',
    _ => throw MissingPluginException('Not implemented: ${call.method}'),
  };
});
```

Планировать нужно вокруг архитектурной цены. Каждое окно является собственным движком Flutter, а значит собственным isolate, собственной кучей и собственной копией каждого синглтона, который вы инициализировали в `main`. Общее состояние приходится сериализовать через канал, ровно как при общении с [платформенным кодом по MethodChannel](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Тем, кто когда-либо строил приложение вокруг [долгоживущего isolate в Dart с SendPort и ReceivePort](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), ограничения покажутся знакомыми: никаких общих изменяемых объектов, всё через сообщения.

Заложите это в дизайн сейчас, и будущая миграция обойдётся дёшево. Держите единственного владельца состояния приложения, выставляйте его через интерфейс, а транспорт (сегодня прямая ссылка под API фреймворка, сегодня method channel под плагином) прячьте за этим интерфейсом. Это тот же тезис «сначала архитектура, потом полировка», который [десктопные приложения на Flutter доказывают снова и снова](/ru/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/).

## Подводные камни, которые стоят реального времени

**Контроллеры являются `ChangeNotifier`, и освобождать их обязаны вы.** `RegularWindowController`, хранимый в `State`, требует `controller.dispose()` в `dispose()` вдобавок к `destroy()` для нативного окна. Та же дисциплина, которую вы уже применяете к [`AnimationController` и его собратьям](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), действует и здесь, только с дополнительным нативным ресурсом.

**В widget-тестах windowing отсутствует.** В тестовом binding нет `WindowingOwner`, поэтому любой тест, доходящий до конструктора windowing, выбрасывает `UnsupportedError`. Собственный API-пример Flutter оборачивает `main` в блок `try`/`on UnsupportedError` именно ради прохождения smoke-тестов. Держите создание окон вне кода уровня виджетов и за швом, который можно подменить.

**`preferredSize` и `preferredConstraints` должны быть согласованы.** Фабрика проверяет утверждением `preferredConstraints.isSatisfiedBy(preferredSize)`, когда оба значения не равны null. В release-сборках утверждение исчезает, и платформа молча выбирает что-то другое.

**`decorated: false` означает, что рамку рисуете вы.** Окна без декораций появились в 3.44 (`Allow windows to be created undecorated`). Ни заголовка, ни рамки, ни области перетаскивания вы не получите, пока не построите их сами.

Отслеживающая задача для всей работы это flutter/flutter#30701, а оставшегося до публикации API объёма настолько мало, что это обнадёживает: flutter/flutter#177586, чек-лист перед запуском, сводится к удалению TODO из фрагментов документации и снятию игнорирования `invalid_use_of_internal_member` в примерах. Ничего архитектурного там нет. Пишите под форму этого API, держите его за интерфейсом, и в день выхода на стабильную ветку миграция сведётся к смене импорта.

## Похожие статьи

- [Как добавить платформенный код во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Как написать isolate в Dart для задач, нагружающих процессор](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Как освобождать контроллеры во Flutter и избегать утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Как собирать несколько версий Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [TypeMonkey хорошо напоминает: десктопным приложениям на Flutter нужна сначала архитектура, а полировка потом](/ru/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/)

## Источники

- [flutter/flutter#30701, отслеживающая задача по нескольким окнам](https://github.com/flutter/flutter/issues/30701)
- [flutter/flutter#177586, чек-лист перед запуском поддержки нескольких окон](https://github.com/flutter/flutter/issues/177586)
- [`packages/flutter/lib/src/widgets/_window.dart` на теге 3.44.0](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter/lib/src/widgets/_window.dart)
- [`packages/flutter_tools/lib/src/features.dart`, где объявлен `windowingFeature`](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter_tools/lib/src/features.dart)
- [Эталонное приложение Flutter `examples/multiple_windows`](https://github.com/flutter/flutter/tree/3.44.0/examples/multiple_windows)
- [Примечания к выпуску Flutter 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)
- [Canonical о нескольких окнах во Flutter Desktop](https://canonical.com/blog/multiple-window-flutter-desktop)
- [`desktop_multi_window` на pub.dev](https://pub.dev/packages/desktop_multi_window)

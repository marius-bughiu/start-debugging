---
title: "Как заблокировать ориентацию экрана для одного экрана во Flutter (и почему многозадачность на iPad её игнорирует)"
description: "Как зафиксировать один маршрут Flutter в альбомной или портретной ориентации через SystemChrome.setPreferredOrientations, не ломая остальное приложение: блокировка на основе стека, которая переживает pushReplacement и восстанавливается при pop, почему пустой список не годится для сброса, почему многозадачность iPad и большие экраны Android 16 игнорируют блокировку и что означает UIRequiresFullScreen после iPadOS 26 и iOS 27 SDK. Проверено на Flutter 3.47.8 с Dart 3.13.7 и Xcode 27.1."
pubDate: 2026-10-25
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ios"
  - "android"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-lock-screen-orientation-for-a-single-screen-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-25
---

Чтобы заблокировать ориентацию одного экрана во Flutter, вызовите `SystemChrome.setPreferredOrientations` при появлении маршрута, а когда маршрут уходит, верните обычные ориентации приложения. Не пишите наивный вариант, где `initState` включает альбомную ориентацию, а `dispose` сбрасывает на портретную. В виджет-тесте на Flutter 3.47.8 (Dart 3.13.7) такая версия возвращает портретную ориентацию только после окончания анимации pop. Хуже того, `pushReplacement` между двумя заблокированными экранами оставляет новый экран в портретной ориентации. Используйте небольшую блокировку на основе стека ниже и восстанавливайте ориентацию в `PopScope.onPopInvokedWithResult`. Но и тогда блокировка остаётся запросом, а не гарантией. iPadOS игнорирует её, пока приложение может работать в режиме многозадачности (Split View, Slide Over и оконная система iPadOS 26). Android 16 игнорирует её на дисплеях шириной не менее 600 dp, если вы нацелены на API 36, а Flutter 3.47.8 по умолчанию нацелен на API 36. Прежний запасной выход для iPad, `UIRequiresFullScreen`, объявлен устаревшим начиная с iPadOS 26 и больше не отключает изменение размера окна при сборке с iOS 27 SDK.

## Что на самом деле делает setPreferredOrientations на каждой платформе

`SystemChrome.setPreferredOrientations(List<DeviceOrientation>)` это один вызов платформенного канала, `SystemChrome.setPreferredOrientations`, который передаёт список имён enum. Он хранит состояние на уровне всего приложения. Ничто в нём не привязано к виджету или маршруту. То, что вы задали последним, действует, пока что-нибудь не задаст значение снова. Это касается и горячего перезапуска, потому что настройка живёт в нативном view controller или activity, а не в Dart.

Платформы обрабатывают её по-разному, и эти различия важны, как только вы пытаетесь "отменить" блокировку:

- **Android**: `PlatformChannel.decodeOrientations` движка превращает список в битовую маску, сопоставляет её константе `ActivityInfo.SCREEN_ORIENTATION_*` и вызывает `activity.setRequestedOrientation(...)`. `[portraitUp]` становится `SCREEN_ORIENTATION_PORTRAIT`, `[landscapeLeft, landscapeRight]` становится `SCREEN_ORIENTATION_USER_LANDSCAPE`, а пустой список становится `SCREEN_ORIENTATION_UNSPECIFIED`. Запрос во время выполнения переопределяет атрибут `android:screenOrientation` в манифесте. Поэтому если в манифесте указано `portrait`, а вы "сбрасываете" значение через `[]`, activity после этого может свободно поворачиваться.
- **iOS**: `FlutterPlatformPlugin` строит `UIInterfaceOrientationMask` и отправляет уведомление. Каждый `FlutterViewController` сохраняет маску и возвращает её из `supportedInterfaceOrientations`. В iOS 16 и новее он вызывает `requestGeometryUpdateWithPreferences:` для каждой подключённой `UIWindowScene`, а затем `setNeedsUpdateOfSupportedInterfaceOrientations`. Пустой список становится `UIInterfaceOrientationMaskAll`, который UIKit затем пересекает с ориентациями из `Info.plist`. Неудачный запрос геометрии только записывается в журнал ("Failed to change device orientation"). Future в Dart при этом завершается как обычно.

Отсюда два вывода. Во-первых, `[]` означает "всё, что разрешает ОС", а не "значение приложения по умолчанию". Всегда восстанавливайте явный список. Во-вторых, вызов работает по принципу "отправил и забыл". Ожидание future сообщает только о том, что сообщение доставлено, а не о том, что экран повернулся.

## Наивная блокировка для одного экрана и как она ломается

Вот версия, которую предлагает большинство ответов:

```dart
// Flutter 3.47.8, Dart 3.13.7 -- naive, do not ship
class _VideoPageState extends State<VideoPage> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }
}
```

Я запустил её в виджет-тесте, который перехватывает `SystemChannels.platform` и записывает каждый вызов ориентации между событиями навигации. Вот журнал на Flutter 3.47.8:

```text
naive push/pop: [landscapeLeft,landscapeRight] -- pop -- first frame of pop animation [portraitUp] -- pop animation done
naive replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [portraitUp]  => final [portraitUp]
```

Первая строка показывает ошибку тайминга. `dispose` выполняется только после завершения анимации выхода маршрута, поэтому предыдущий экран выезжает обратно, пока устройство всё ещё заблокировано в альбомной ориентации, а затем резко переключается на портретную. На реальном телефоне пользователь видит, как предыдущий экран всю анимацию pop выезжает в альбомной раскладке, и только потом поворачивается.

Вторая строка показывает ошибку корректности. При `pushReplacement` (или `replace` / `go` в `go_router` к соседнему маршруту) `initState` нового маршрута выполняется раньше, чем `dispose` старого. Входящая страница видео запрашивает альбомную ориентацию. Затем уходящая страница видео "наводит порядок" и принудительно включает портретную. Итоговое состояние: портретная ориентация на экране, которому нужна была альбомная. То же происходит всякий раз, когда времена жизни двух заблокированных экранов пересекаются, например в `TabBarView` или `PageView`, который держит соседей живыми.

## Блокировка, у которой есть владелец, стек и освобождение при pop

Решение: перестать считать ориентацию тем, что каждый экран задаёт и сбрасывает сам. Вместо этого держите один стек запросов на уровне приложения. Каждый экран кладёт свою запись и удаляет только её, а на платформу отправляется верхняя запись стека (или значение приложения по умолчанию):

```dart
// Flutter 3.47.8, Dart 3.13.7
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// App-wide orientation stack. The top entry wins; when it is empty the
/// app default applies.
class OrientationLocks {
  OrientationLocks._();

  static List<DeviceOrientation> appDefault = const [DeviceOrientation.portraitUp];
  static final List<(Object, List<DeviceOrientation>)> _stack = [];

  static void push(Object owner, List<DeviceOrientation> orientations) {
    _stack.removeWhere((e) => identical(e.$1, owner));
    _stack.add((owner, orientations));
    _apply();
  }

  static void remove(Object owner) {
    final before = _stack.length;
    _stack.removeWhere((e) => identical(e.$1, owner));
    if (_stack.length != before) _apply();
  }

  static void _apply() {
    final target = _stack.isEmpty ? appDefault : _stack.last.$2;
    SystemChrome.setPreferredOrientations(target);
  }
}
```

Виджет, который её использует, кладёт блокировку, когда его маршрут становится текущим. Он снимает блокировку в двух местах: когда начинается pop (через `PopScope`) и в `dispose` как запасной вариант для маршрутов, удалённых без pop, например старого маршрута при `pushReplacement`:

```dart
// Flutter 3.47.8, Dart 3.13.7
/// Locks orientation while this widget's route is the current route.
class OrientationLock extends StatefulWidget {
  const OrientationLock({
    super.key,
    required this.orientations,
    required this.child,
  });

  final List<DeviceOrientation> orientations;
  final Widget child;

  @override
  State<OrientationLock> createState() => _OrientationLockState();
}

class _OrientationLockState extends State<OrientationLock> {
  ModalRoute<Object?>? _route;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != _route) {
      _route = route;
      // isCurrent is false while another route covers this one.
      if (route == null || route.isCurrent) {
        OrientationLocks.push(this, widget.orientations);
      }
    }
  }

  @override
  void didUpdateWidget(OrientationLock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.orientations, widget.orientations)) {
      OrientationLocks.push(this, widget.orientations);
    }
  }

  @override
  void dispose() {
    OrientationLocks.remove(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      onPopInvokedWithResult: (didPop, result) {
        // Release the lock when the pop starts, not when the exit
        // animation ends, so the previous screen does not animate in
        // under the wrong orientation.
        if (didPop) OrientationLocks.remove(this);
      },
      child: widget.child,
    );
  }
}
```

Использование на маршруте сводится к одной обёртке:

```dart
// Flutter 3.47.8, Dart 3.13.7
Navigator.of(context).push(MaterialPageRoute<void>(
  builder: (_) => const OrientationLock(
    orientations: [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
    child: VideoPage(),
  ),
));
```

Тот же тестовый стенд, запущенный на этой версии:

```text
stack push/pop: [landscapeLeft,landscapeRight] -- pop [portraitUp] -- first frame of pop animation -- pop animation done
stack replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [landscapeLeft,landscapeRight]  => final [landscapeLeft,landscapeRight]
```

Портретная ориентация запрашивается в том же кадре, в котором начинается pop, поэтому поворот и обратная анимация перехода идут вместе. После замены видео остаётся в альбомной ориентации, потому что удаление записи уходящей страницы заново применяет запись входящей страницы, а не значение по умолчанию.

Здесь заложено одно проектное решение. Маршрут без собственного `OrientationLock` наследует ближайшую блокировку ниже по стеку. Если альбомный плеер открывает обычный экран настроек, этот экран тоже будет альбомным. Если нужно, чтобы "всё без блокировки было портретным", оберните такие маршруты явным `OrientationLock(orientations: [DeviceOrientation.portraitUp])`. С `go_router` поместите обёртку в `builder` или `pageBuilder` маршрута. `ModalRoute.of` и `PopScope` работают одинаково внутри вложенного навигатора `ShellRoute`, о чём рассказывает статья про [вложенные маршруты и deep links в go_router](/ru/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/).

## Задайте ориентацию приложения по умолчанию в нативном проекте, а не только в Dart

Если всё приложение портретное, кроме одного экрана, объявите портретную ориентацию и нативно, чтобы экран запуска и первый кадр уже были правильными:

1. В `android/app/src/main/AndroidManifest.xml` добавьте `android:screenOrientation="portrait"` к элементу `MainActivity`.
2. В `ios/Runner/Info.plist` оставьте `UISupportedInterfaceOrientations` (iPhone) и `UISupportedInterfaceOrientations~ipad` со списком всех ориентаций, которые когда-либо понадобятся любому экрану. Flutter может только сужать то, что разрешает `Info.plist`. Добавить к нему он не может. Шаблон 3.47.8 перечисляет портретную и обе альбомные ориентации для iPhone и все четыре ориентации для iPad.
3. В `main` задайте `OrientationLocks.appDefault` и примените его до `runApp`:

```dart
// Flutter 3.47.8, Dart 3.13.7
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  OrientationLocks.appDefault = const [DeviceOrientation.portraitUp];
  await SystemChrome.setPreferredOrientations(OrientationLocks.appDefault);
  runApp(const MyApp());
}
```

Не ограничивайте `Info.plist` для iPhone только портретной ориентацией, а затем запрашивайте альбомную из Dart. В iOS 16+ запрос геометрии завершится ошибкой, потому что сцена не поддерживает ни одной из запрошенных ориентаций. Ошибка при этом тихая, если не считать строки в журнале Xcode.

## Почему многозадачность iPad игнорирует блокировку

Комментарий к документации `setPreferredOrientations` во Flutter 3.47.8 говорит об этом прямо: "This setting will only be respected on iPad if multitasking is disabled." Причина в UIKit, а не во Flutter. Когда приложение может делить экран (Split View, Slide Over, Stage Manager и свободно изменяемые окна, появившиеся в iPadOS 26), размер и ориентация сцены принадлежат системе. Пользователь может повернуть iPad, пока ваше приложение стоит в раскладке рядом с другим. Система не будет поворачивать весь экран ради одного приложения, поэтому `supportedInterfaceOrientations` перестаёт учитываться. Flutter по-прежнему отправляет запрос, а UIKit просто не выполняет его.

Годами документированным обходным путём, который до сих пор упоминается в документации Flutter, был отказ от многозадачности. Его включали флажком "Requires full screen" в Xcode, который записывает `UIRequiresFullScreen = YES` в `Info.plist`. Это больше не долгосрочное решение. В [TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key) от Apple сказано:

- Начиная с iPadOS 26, `UIRequiresFullScreen` и его режим совместимости объявлены устаревшими и в будущем выпуске будут игнорироваться.
- Начиная с iOS 27 и iPadOS 27, приложения, собранные с iOS 27 SDK и задающие этот ключ, дискретно изменяют размер вместо того, чтобы оставаться на весь экран. Единственное исключение: `UIRequiresFullScreenIgnoredStartingWithVersion` указывает версию 27 или ниже.
- Чтобы поддерживать изменяемые по размеру сцены, приложение должно поддерживать все ориентации интерфейса.

Xcode 27.1 поставляется с iOS 27 SDK. Поэтому для Flutter-приложения, которое вы собираете сегодня, флажок "Requires full screen" больше не отключает изменение размера на iOS 27, а Apple призвала разработчиков перестать на него полагаться. В обсуждениях на форумах разработчиков за цикл iPadOS 26.x также сообщают, что приложения только с альбомной ориентацией отображаются в портретной, когда блокировка поворота устройства выключена. Относитесь к любой блокировке ориентации на iPad как к best effort.

Взамен Apple предлагает *временную* блокировку. View controller может переопределить `prefersInterfaceOrientationLocked` и вызвать `setNeedsUpdateOfPrefersInterfaceOrientationLocked()`. Это просит систему сохранять текущую ориентацию сцены, пока этот контроллер виден, например во время съёмки камерой или жеста управления в игре. TN3192 прямо говорит, что система "does not guarantee", что учтёт это предпочтение. `FlutterViewController` во Flutter 3.47.8 это свойство не переопределяет. Это можно сделать в подклассе и управлять им через method channel:

```swift
// Flutter 3.47.8, Xcode 27.1, iOS 26+ for prefersInterfaceOrientationLocked
import Flutter
import UIKit

class LockableFlutterViewController: FlutterViewController {
  private var locked = false
  private var channel: FlutterMethodChannel?

  override func viewDidLoad() {
    super.viewDidLoad()
    channel = FlutterMethodChannel(
      name: "app/orientation_lock", binaryMessenger: engine.binaryMessenger)
    channel?.setMethodCallHandler { [weak self] call, result in
      guard let self, call.method == "setLocked", let value = call.arguments as? Bool else {
        result(FlutterMethodNotImplemented)
        return
      }
      self.locked = value
      if #available(iOS 26.0, *) {
        self.setNeedsUpdateOfPrefersInterfaceOrientationLocked()
      }
      result(nil)
    }
  }

  override var prefersInterfaceOrientationLocked: Bool {
    locked
  }
}
```

В `ios/Runner/Base.lproj/Main.storyboard` замените `customClass` корневого view controller с `FlutterViewController` на `LockableFlutterViewController` (с `customModuleProvider="target"`). Затем вызовите его из Dart:

```dart
// Flutter 3.47.8, Dart 3.13.7
const _lockChannel = MethodChannel('app/orientation_lock');

Future<void> setIpadOrientationLocked(bool locked) =>
    _lockChannel.invokeMethod<void>('setLocked', locked);
```

Это сохраняет ту ориентацию, которая уже есть у сцены. В альбомную ориентацию оно не поворачивает, поэтому дополняет `setPreferredOrientations`, а не заменяет его. Я скомпилировал этот подкласс в приложение Flutter 3.47.8 командой `flutter build ios --simulator` на Xcode 27.1 (целевая версия развёртывания iOS 15, отсюда проверка `#available`). Поведение многозадачности на физическом iPad я не проверял, поэтому проверьте его на устройстве, прежде чем на него полагаться.

## Android 16 делает то же самое на больших экранах

Android пошёл по тому же пути. Согласно [изменениям поведения Android 16](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation), приложения, нацеленные на API 36, игнорируют `screenOrientation`, `resizableActivity`, `minAspectRatio`, `maxAspectRatio`, `setRequestedOrientation()` и `getRequestedOrientation()` на дисплеях, у которых наименьшая ширина не менее 600 dp. Сюда входят планшеты, раскрытые складные устройства и окна рабочего стола. `setPreferredOrientations` во Flutter это вызов `setRequestedOrientation()`, а Gradle-плагин Flutter 3.47.8 задаёт `flutter.targetSdkVersion` равным 36. Поэтому только что созданное приложение Flutter не будет блокировать ориентацию на планшете. Это ограничение теперь указано и в документации Flutter.

Исключения: игры (объявленные через `android:appCategory="game"`), пользователи, выбравшие для приложения поведение по умолчанию в настройках соотношения сторон устройства, и экраны уже 600 dp. Телефоны не затронуты. Есть временный способ отказаться:

```xml
<!-- android/app/src/main/AndroidManifest.xml, targetSdk 36 only -->
<activity android:name=".MainActivity" ...>
    <property
        android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
        android:value="true" />
</activity>
```

Google заявляет, что этот отказ перестаёт действовать, как только вы нацелитесь на API уровня 37. Считайте это временем, чтобы исправить раскладку для планшетов, а не исправлением. То же правило затронуло приложения MAUI, и статья про [миграцию MAUI на API level 36](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) подробнее разбирает сторону манифеста.

## Подводные камни, когда экран всё же поворачивается

- **Стройте раскладку по ограничениям, а не по блокировке.** Поворот приходит через кадр или позже после вашего вызова, а на iPad или планшетах с Android 16 может не прийти вовсе. Стройте заблокированный экран с `OrientationBuilder` или `LayoutBuilder`, чтобы он корректно отображался при любом размере, который действительно получит.
- **Чтобы решить, блокировать ли, используйте дисплей, а не `MediaQuery.size`.** На Android из-за letterboxing `MediaQueryData.size` сообщает размер области с полями. Документация Flutter рекомендует сравнивать `View.of(context).display.size / display.devicePixelRatio` с порогом в 600 логических пикселей. Блокируйте только телефоны, а на планшетах отправляйте `[]`.
- **`landscapeLeft` означает, что устройство повёрнуто против часовой стрелки.** `DeviceOrientation.landscapeLeft` это "90 degrees counterclockwise from portraitUp". Запрашивайте обе альбомные ориентации, если нет причины закреплять одну. Иначе пользователь, повернувший телефон в другую сторону, увидит экран перевёрнутым.
- **На iPhone без кнопки Home `portraitDown` не бывает никогда.** TN3192 отмечает, что система удаляет `portraitUpsideDown` из набора поддерживаемых на таких моделях, что бы вы ни объявили.
- **Возврат из фонового режима.** Нативная настройка переживает уход в фон, поэтому повторно применять её при возврате не нужно. Если у вас есть другой код жизненного цикла, [миграция на AppLifecycleListener](/ru/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/) для него подходит лучше, чем `WidgetsBindingObserver`.
- **Не вызывайте её после `await` без проверки `mounted`.** Блокировать после асинхронной загрузки видео обычное дело. Если пользователь уже закрыл маршрут, запоздалый `OrientationLocks.push` из мёртвого `State` оставит блокировку, которую никто не снимет. Здесь действуют и правила из статьи про [безопасное использование BuildContext после await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).

## Что почитать дальше

- [Вложенные маршруты и deep links в go_router](/ru/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/): куда поместить обёртку `OrientationLock` в дереве маршрутов.
- [go_router, auto_route и Navigator 2.0](/ru/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/): если вы выбираете маршрутизатор и вам важно, как освобождаются заменяемые маршруты.
- [Миграция с WidgetsBindingObserver на AppLifecycleListener](/ru/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/).
- [Миграция приложения .NET MAUI для Android на API level 36](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/): то же правило Android 16 для больших экранов со стороны MAUI.

## Источники

- [Документация API `SystemChrome.setPreferredOrientations`](https://api.flutter.dev/flutter/services/SystemChrome/setPreferredOrientations.html) и [исходный код 3.47.8](https://github.com/flutter/flutter/blob/3.47.8/packages/flutter/lib/src/services/system_chrome.dart).
- Движок Flutter 3.47.8: [`FlutterViewController.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterViewController.mm), [`FlutterPlatformPlugin.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterPlatformPlugin.mm), [`PlatformChannel.java`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/systemchannels/PlatformChannel.java).
- [TN3192: Migrating your app from the deprecated UIRequiresFullScreen key](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key).
- [Изменения поведения Android 16: игнорирование ограничений ориентации, изменения размера и соотношения сторон](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation).
- Форумы разработчиков Apple: [iPadOS 26.x ignores supportedInterfaceOrientations when orientation lock is off](https://developer.apple.com/forums/thread/811216).

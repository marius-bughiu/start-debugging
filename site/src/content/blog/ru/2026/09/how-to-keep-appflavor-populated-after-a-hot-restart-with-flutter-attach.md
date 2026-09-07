---
title: "Как сохранить значение appFlavor после hot restart при использовании flutter attach"
description: "У flutter attach нет опции --flavor, поэтому запускаемый им резидентный компилятор никогда не определяет FLUTTER_APP_FLAVOR, и константа appFlavor становится null при первом hot restart. Три решения: default-flavor в pubspec.yaml, flutter run --use-application-binary и канал платформы, читающий flavor нативно. Проверено на Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-07
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "flavors"
  - "tooling"
lang: "ru"
translationOf: "2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach"
translatedBy: "claude"
translationDate: 2026-09-07
---

`appFlavor` это константа времени компиляции, а не запрос во время выполнения, и у `flutter attach` нет опции `--flavor`. Поэтому, когда вы подключаетесь к приложению, собранному и запущенному вне `flutter run`, frontend-компилятор, который поднимает инструмент, стартует без `-DFLUTTER_APP_FLAVOR=...`, и первый же hot restart заменяет корректное `dev` на `null`. Самое быстрое решение это `default-flavor` в `pubspec.yaml`, который `FlutterCommand.getBuildInfo()` читает для каждой команды, включая `attach`. Если flavor должен меняться от вызова к вызову, используйте `flutter run --use-application-binary=<path> --flavor dev` вместо подключения или вообще перестаньте читать `appFlavor` и получайте flavor от платформы. Всё изложенное ниже проверено на Flutter 3.47.2 с Dart 3.13.2 в канале stable.

## appFlavor это одиннадцать строк const, и это вся история целиком

Многие считают, что `appFlavor` о чём-то спрашивает engine. Это не так. Вот объявление целиком, из `packages/flutter/lib/src/services/flavor.dart` в ветке stable:

```dart
// Flutter 3.47.2, packages/flutter/lib/src/services/flavor.dart
/// The flavor this app was built with.
///
/// This is equivalent to the value argued to the `--flavor` option at build time.
/// This will be `null` if the `--flavor` option was not provided.
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

`String.fromEnvironment` разрешается CFE в момент компиляции kernel, из флагов `-D`, переданных процессу компилятора. Это никак не связано ни с `Platform.environment`, ни с работающей VM, ни с установленным APK. Запекается то значение, которое было у компилятора в момент производства kernel.

Это важно, потому что в жизни отладочной сессии Flutter есть два компилятора. Первый работает при сборке приложения: `flutter build apk --flavor dev --debug` разрешает `--flavor` в `FlutterCommand.getBuildInfo()` и добавляет `FLUTTER_APP_FLAVOR=dev` к dart defines, которые оказываются как `-DFLUTTER_APP_FLAVOR=dev` в командной строке frontend server. Второй работает всю оставшуюся сессию: резидентный компилятор, который `flutter run` или `flutter attach` держит живым для обслуживания hot reload и hot restart. В `packages/flutter_tools/lib/src/compile.dart` defines передаются этому процессу ровно один раз, при запуске:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/compile.dart (abridged)
final List<String> command = <String>[
  engineDartPath,
  ...
  '--sdk-root', sdkRoot,
  '--target=$targetModel',
  '--no-print-incremental-dependencies',
  for (final Object dartDefine in dartDefines) '-D$dartDefine',
  ...buildModeOptions(buildMode, dartDefines),
  if (trackWidgetCreation) '--track-creation-locations',
  ...
];
```

Канала, чтобы изменить `dartDefines` после этого, нет. Каждый hot reload и каждый hot restart до конца сессии обслуживает этот единственный процесс с этим единственным набором defines. Если `FLUTTER_APP_FLAVOR` не было в командной строке при его запуске, никакой перезапуск это значение не вернёт.

## Что регистрирует attach, а что нет

Конструктор `AttachCommand` это список вызовов `uses*`. Вот его существенная часть, дословно из stable:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/commands/attach.dart
addBuildModeFlags(verboseHelp: verboseHelp, defaultToRelease: false, excludeRelease: true);
usesTargetOption();
usesPortOptions(verboseHelp: verboseHelp);
usesIpv6Flag(verboseHelp: verboseHelp);
usesFilesystemOptions(hide: !verboseHelp);
usesFuchsiaOptions(hide: !verboseHelp);
usesDartDefineOption();
usesDeviceUserOption();
```

`usesFlavorOption()` отсутствует. `RunCommand` вызывает его в строке 40 файла `run.dart`; `AttachCommand` не вызывает никогда. А `getBuildInfo()`, который `attach` всё же вызывает, разрешает flavor так:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
final String? defaultFlavor = project.manifest.defaultFlavor;
final String? cliFlavor = getValue(BuildInfoOptions.flavor);
final String? flavor = cliFlavor ?? defaultFlavor;

_ensureReservedDartDefineIsUnset(kAppFlavor, dartDefines);
if (flavor != null) {
  dartDefines.add('$kAppFlavor=$flavor');
}
```

Без зарегистрированной опции `--flavor` значение `cliFlavor` равно `null`. Если `defaultFlavor` тоже null, то и `flavor` null, `if` никогда не срабатывает, и резидентный компилятор запускается без define. Приложение на устройстве это сборка `dev`; компилятор, который его обслуживает, считает, что flavor не существует.

## Воспроизведение в четыре шага

Это [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), заведённый 2026-09-03 и подтверждённый при разборе на 3.47.2 stable. Воспроизводится и на `platform-android`, и на `platform-ios`.

1. Добавьте приложению product flavors и прочитайте константу в видимом месте:

   ```dart
   // Flutter 3.47.2 / Dart 3.13.2
   import 'package:flutter/material.dart';
   import 'package:flutter/services.dart';

   void main() => runApp(const FlavorApp());

   class FlavorApp extends StatelessWidget {
     const FlavorApp({super.key});

     @override
     Widget build(BuildContext context) {
       return MaterialApp(
         home: Scaffold(
           body: Center(
             child: Text('appFlavor = $appFlavor',
                 style: const TextStyle(fontSize: 28)),
           ),
         ),
       );
     }
   }
   ```

2. Соберите и запустите его с flavor, но вне `flutter run`:

   ```bash
   flutter build apk --flavor dev --debug
   adb install -r build/app/outputs/flutter-apk/app-dev-debug.apk
   adb shell monkey -p com.example.flavors.dev 1
   ```

3. Подключитесь: `flutter attach --debug`. На экране по-прежнему `appFlavor = dev`, потому что ничего ещё не перекомпилировалось.

4. Нажмите `R` для hot restart. Теперь на экране `appFlavor = null`.

Именно шаг 3 запутывает диагностику. Значение остаётся корректным вплоть до первого перезапуска, поэтому ошибка выглядит принадлежащей коду, который вы только что правили, а не инструменту.

## Решение 1: default-flavor в pubspec.yaml

`default-flavor` добавили в схему pubspec в [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968), а [#169298](https://github.com/flutter/flutter/pull/169298) перенёс его разрешение в `FlutterCommand.getBuildInfo()`, чтобы оно применялось к каждой команде, которая строит `BuildInfo`, а не только к `run` и `build`. `attach` одна из таких команд. Поэтому это и работает.

1. Добавьте поле под ключом `flutter:` в `pubspec.yaml`:

   ```yaml
   # pubspec.yaml, Flutter 3.47.2
   name: flavors_example
   environment:
     sdk: ^3.13.0

   flutter:
     uses-material-design: true
     default-flavor: dev
   ```

2. Перезапустите сессию attach. `flutter attach --debug` теперь разрешает `flavor` в `dev` из манифеста, добавляет `FLUTTER_APP_FLAVOR=dev` к defines, и hot restart продолжает возвращать `dev`.

3. Продолжайте явно указывать `--flavor` там, где опция существует. Собственный текст справки `usesFlavorOption()` гласит, что она "Overrides the value of the `default-flavor` entry in the flutter pubspec", так что `flutter run --flavor staging` по-прежнему побеждает `default-flavor: dev`.

Ограничение ровно такое, какого и ждёшь от значения, лежащего в закоммиченном файле: один flavor, для всех, при каждом attach. Если ваш CI подключается к сборке `staging` на одной машине и к `dev` на другой, `default-flavor` за ними не поспеет. Есть открытое предложение [#191376](https://github.com/flutter/flutter/pull/191376) разрешить платформозависимые значения `default-flavor`, но и оно не делает значение зависящим от вызова.

## Почему --dart-define=FLUTTER_APP_FLAVOR отклоняется

Очевидный обходной путь это задать define вручную, и `attach` действительно регистрирует `usesDartDefineOption()`, так что флаг разбирается. И всё равно не работает:

```bash
flutter attach --debug --dart-define=FLUTTER_APP_FLAVOR=dev
# FLUTTER_APP_FLAVOR is used by the framework and cannot be set using
# --dart-define or --dart-define-from-file
```

Эта защита сделана намеренно, и она покрывает также окружение процесса:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
void _ensureReservedDartDefineIsUnset(String define, List<String> dartDefines) {
  if (_platform.environment[define] != null) {
    throwToolExit('$define is used by the framework and cannot be set in the environment.');
  }
  if (dartDefines.any((String d) => d == define || d.startsWith('$define='))) {
    throwToolExit(
      '$define is used by the framework and cannot be '
      'set using --${FlutterOptions.kDartDefinesOption} or --${FlutterOptions.kDartDefineFromFileOption}',
    );
  }
}
```

`FLUTTER_APP_FLAVOR` стоит в этом списке зарезервированных рядом с `FLUTTER_BUILD_NAME`, `FLUTTER_BUILD_NUMBER` и `FLUTTER_ENABLED_FEATURE_FLAGS`. Задать переменную в оболочке перед запуском инструмента тоже не поможет: первая ветка проверяет `_platform.environment` и завершает работу с другим сообщением. Если раньше вы делали так для web-сборок, это [#172165](https://github.com/flutter/flutter/issues/172165), закрытый как некорректный: случайностью было поведение до 3.32, а не нынешний отказ.

## Решение 2: запускайте готовый бинарник вместо подключения

Большинство берётся за `flutter attach`, потому что приложение собрал не `flutter run`, а что-то другое: задача Gradle, схема Xcode, инструментальный harness. Если всё, что вам нужно, это "установи артефакт и дай цикл hot restart", то `flutter run` делает это напрямую и, в отличие от `attach`, принимает `--flavor`:

```bash
# Flutter 3.47.2. run registers both --use-application-binary and --flavor.
flutter run \
  --use-application-binary=build/app/outputs/flutter-apk/app-dev-debug.apk \
  --flavor dev
```

`RunCommand` вызывает `usesFlavorOption()` и читает `--use-application-binary` в `prebuiltApplicationBinaryPath`, так что вы получаете настоящий `HotRunner` поверх собранного вами бинарника, с `FLUTTER_APP_FLAVOR=dev` у резидентного компилятора. На iOS укажите на bundle `.app`, который производит `flutter build ios --flavor dev --debug` или ваша схема Xcode. Это ближе всего к корректному исправлению без правки кода на Dart, и в CI я берусь за него первым делом.

Оно не поможет, если вы действительно не управляете запуском, например когда нативное приложение-хост встраивает Flutter как модуль и само поднимает engine. Для этого и есть решение 3.

## Решение 3: читайте flavor у платформы, а не из kernel

Если flavor должен переживать произвольный attach, перестаньте спрашивать у константы времени компиляции значение, которого компилятор не знает. Flavor уже присутствует нативно, в `BuildConfig.FLAVOR` на Android и в том build setting, который управляет вашей схемой Xcode, а канал платформы читает его после перезапуска изолята, а не до компиляции. Приём тот же, что описан в статье про [добавление платформозависимого кода без написания плагина](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

Сначала Android. AGP 8.0 перестал генерировать `BuildConfig`, пока вы об этом не попросите, а шаблон приложения Flutter не просит, так что включите его:

```kotlin
// android/app/build.gradle.kts, AGP 8.13, Flutter 3.47.2
android {
    namespace = "com.example.flavors"

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
    }
}
```

Затем ответьте на вызов канала в `MainActivity`:

```kotlin
// android/app/src/main/kotlin/com/example/flavors/MainActivity.kt
package com.example.flavors

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.example.flavors/flavor",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "getFlavor" -> result.success(BuildConfig.FLAVOR)
                else -> result.notImplemented()
            }
        }
    }
}
```

На iOS добавьте пользовательский build setting в каждый xcconfig (`APP_FLAVOR = dev` в `Debug-dev.xcconfig`), выставьте его в `Info.plist` как строку `FLUTTER_APP_FLAVOR` со значением `$(APP_FLAVOR)` и прочитайте из bundle:

```swift
// ios/Runner/AppDelegate.swift, Xcode 26.4, Flutter 3.47.2
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(
      name: "com.example.flavors/flavor",
      binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "getFlavor" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(Bundle.main.object(forInfoDictionaryKey: "FLUTTER_APP_FLAVOR") as? String)
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

А на стороне Dart разрешите значение один раз и откатывайтесь на `appFlavor` на платформах без нативного обработчика:

```dart
// Flutter 3.47.2 / Dart 3.13.2
import 'package:flutter/services.dart';

const _channel = MethodChannel('com.example.flavors/flavor');

/// Survives hot restart under `flutter attach`, because it is a call, not a const.
Future<String?> resolveFlavor() async {
  try {
    return await _channel.invokeMethod<String>('getFlavor') ?? appFlavor;
  } on MissingPluginException {
    return appFlavor; // desktop, web, unit tests
  }
}
```

Цена в том, что `resolveFlavor()` асинхронный, а `appFlavor` нет, поэтому всё, что синхронно ветвилось по flavor в `main()`, теперь должно дождаться его до `runApp` либо читать его из provider. Это настоящий рефакторинг, и потому я взялся бы за него только тогда, когда решения 1 и 2 обе недоступны.

## Что похоже на эту ошибку, но ею не является

**Хотфикс 3.32.1.** Если искать по этому симптому, вы попадёте на [#165803](https://github.com/flutter/flutter/issues/165803) и [#169160](https://github.com/flutter/flutter/issues/169160), где `appFlavor` становился null после hot restart при обычном `flutter run --flavor` и во время `flutter test --flavor`. Там была другая причина: `KernelSnapshot` в `build_system/targets/common.dart` пропускал добавление flavor, если define уже присутствовал из ветки сборки через xcodebuild. [PR #169602](https://github.com/flutter/flutter/pull/169602) изменил это так, чтобы удалять любую существующую запись и добавлять свою последней, а запись в changelog появилась в **Flutter 3.32.1**. Если вы на 3.32.1 или новее и по-прежнему видите null при `flutter run`, это новая ошибка, а не эта.

**Hot reload, а не только hot restart.** Набор defines фиксируется при запуске резидентного компилятора, поэтому он управляет каждой инкрементальной компиляцией, а не только полными перезапусками. Hot reload, перекомпилирующий библиотеку, которая читает `appFlavor`, может пересчитать константу в null именно в этой библиотеке, пока другие сохраняют прежнее значение. Не считайте, что `r` безопасен только потому, что `R` небезопасен.

**Flavor, существующие только в Gradle.** `appFlavor` сообщает значение, переданное в `--flavor`, и оно должно совпадать с именем product flavor. Если вы переименовали flavor в `build.gradle.kts`, но продолжаете собирать со старым именем, сборка упадёт раньше, чем это станет важно. Настройка самих измерений flavor выходит за рамки статьи; если падает именно `assembleDevDebug`, то ближе будет [чеклист по assembleDebug с кодом выхода 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**Действия Attach в IDE.** IntelliJ упёрся в ту же стену с другой стороны в flutter-intellij#5237, где действие Attach передавало `--flavor` и падало с `Could not find an option named 'flavor'`. Решением на стороне IDE стало убрать флаг, и потому подключение из Android Studio или VS Code демонстрирует это же поведение. `default-flavor` сегодня единственное, что чинит путь через IDE, поскольку её командную строку вы не контролируете.

Предложение upstream в #192261 состоит из одной строки: вызвать `usesFlavorOption()` в конструкторе `AttachCommand`. `getBuildInfo()` уже превращает опцию в define, так что остальной обвязки не требуется. Пока это не приземлилось, считайте `appFlavor` под `attach` "корректным ровно один раз" и выбирайте то из трёх решений выше, которое соответствует тому, насколько вы контролируете запуск.

## Похожие материалы

- [Как добавить платформозависимый код во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) разбирает настройку `MethodChannel`, на которой держится решение 3.
- [Fix: задача Gradle assembleDebug падает с кодом выхода 1 в Android-сборке Flutter](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) покрывает ошибки конфигурации flavor и NDK, ломающие сборку ещё до того, как `appFlavor` вообще вступит в игру.
- [Как нацелиться на несколько версий Flutter из одного CI-конвейера](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) стоит прочитать рядом с решением 2, потому что `--use-application-binary` это прежде всего приём для CI.
- [Отладка Flutter iOS из Windows: реальный рабочий процесс с устройством](/ru/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) это другое место, где `flutter attach` отрабатывает своё, и там действует то же различие между константой и временем выполнения.
- [Fix: вход через Firebase Auth не сохраняется в release-сборке Flutter под Android](/ru/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) хорошее дополнение, если ваши flavor означают ещё и разные проекты Firebase.

## Источники

- [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), открытый issue об отсутствующей опции `--flavor` у `attach`, с подтверждением при разборе на 3.47.2.
- [Константа `appFlavor`](https://api.flutter.dev/flutter/services/appFlavor-constant.html) в документации API Flutter и её исходный код в `packages/flutter/lib/src/services/flavor.dart`.
- [Опции pubspec во Flutter](https://docs.flutter.dev/tools/pubspec) про поле `default-flavor` и [Настройка flavor во Flutter для Android](https://docs.flutter.dev/deployment/flavors) про саму настройку flavor.
- [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) добавил `default-flavor`; [#169298](https://github.com/flutter/flutter/pull/169298) и его roll-forward [#169602](https://github.com/flutter/flutter/pull/169602) перенесли разрешение flavor в `getBuildInfo()`.
- [CHANGELOG Flutter](https://github.com/flutter/flutter/blob/main/CHANGELOG.md) для записи о хотфиксе 3.32.1, покрывающей `appFlavor` под `flutter test` и hot restart.
- [Заметки о выпуске Android Gradle Plugin 8.0](https://developer.android.com/build/releases/past-releases/agp-8-0-0-release-notes) про изменение значения по умолчанию `buildFeatures.buildConfig`, которое решению 3 приходится обходить.

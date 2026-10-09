---
title: "Что такое flavor во Flutter и чем он отличается от режима сборки"
description: "Режим сборки (debug, profile, release) определяет, как Flutter компилирует ваш Dart-код. Flavor (dev, staging, prod) это нативный вариант сборки, который вы описываете в Gradle и Xcode и который определяет, какое именно приложение вы выпускаете. Это независимые оси: 2 flavor на 3 режима дают 6 сборок. Проверено на Flutter 3.44.8 с AGP 9.0.1, исходный код сверен с версией 3.47.7."
pubDate: 2026-10-10
tags:
  - "flutter"
  - "dart"
  - "flavors"
  - "android"
  - "ios"
  - "tooling"
lang: "ru"
translationOf: "2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode"
translatedBy: "claude"
translationDate: 2026-10-10
---

Коротко: **режим сборки** определяет, как Flutter компилирует и запускает ваш Dart-код. Их ровно три, `debug`, `profile` и `release`, они встроены в движок и инструмент, а ваш код видит их через `kDebugMode`, `kProfileMode` и `kReleaseMode`. **Flavor** это то, чем Flutter вообще не владеет: это нативный вариант сборки, который вы определяете сами, как `productFlavors` в Gradle на Android и как схемы Xcode плюс конфигурации сборки на iOS и macOS, и он определяет, *какое приложение* вы собираете (application ID, отображаемое имя, значки, проект Firebase, базовый URL API). Flutter лишь передаёт `--flavor dev` в нативную сборку и открывает имя для Dart как константу `appFlavor`. Эти понятия ортогональны, поэтому у проекта с flavor `dev` и `prod` шесть вариантов, от `devDebug` до `prodRelease`. Всё ниже собрано и проверено на Flutter 3.44.8 (Dart 3.12.2, Android Gradle Plugin 9.0.1, Gradle 9.1.0), а соответствующий исходный код `flutter_tools` сверен с текущей стабильной версией, Flutter 3.47.7.

## Две оси, одна матрица сборок

Путаница обычно начинается потому, что оба параметра передаются в одной командной строке и оба попадают в имя выходного файла:

```bash
# Flutter 3.44.8 / 3.47.7
flutter build apk --release --flavor prod
# -> Running Gradle task 'assembleProdRelease'...
# -> build/app/outputs/flutter-apk/app-prod-release.apk
```

`--release` выбирает режим. `--flavor prod` выбирает flavor. Gradle объединяет их в одно имя варианта, `prodRelease`, и запускает `assembleProdRelease`. Вот полная матрица для проекта с двумя flavor:

| | `--debug` | `--profile` | `--release` |
|---|---|---|---|
| `--flavor dev` | `app-dev-debug.apk` | `app-dev-profile.apk` | `app-dev-release.apk` |
| `--flavor prod` | `app-prod-debug.apk` | `app-prod-profile.apk` | `app-prod-release.apk` |

Столбцы определяет Flutter, и они отвечают на вопрос "как компилируется Dart-код и можно ли делать hot reload?". Строки определяют ваш `build.gradle.kts` и проект Xcode, и они отвечают на вопрос "это приложение, которое обращается к staging-бэкенду и называется `Demo Dev` на домашнем экране?". Ничто в одной оси ничего не предопределяет в другой. Отладочная сборка `prod` совершенно нормальна: именно её вы запускаете, когда нужно воспроизвести ошибку, возникающую только в продакшене, с точками останова.

## Что на самом деле меняет режим сборки

Режимы сборки относятся к конвейеру компиляции Dart и жёстко заданы Flutter:

- **Debug** компилирует в файл kernel и запускает его на JIT виртуальной машины Dart. Assert включены, service extensions включены, работают hot reload и hot restart, а производительность не показательна.
- **Profile** компилирует заранее (AOT) в нативный машинный код, как и release, но оставляет достаточно протокола сервиса для трассировки в DevTools. Он не работает на эмуляторах и симуляторах.
- **Release** компилирует заранее (AOT), удаляет assert и отладочную информацию, и именно его вы выпускаете.

Разницу видно, если заглянуть в APK. Debug APK содержит программу на Dart как `kernel_blob.bin` для JIT, а profile и release APK содержат предварительно скомпилированный `libapp.so`:

```text
# Flutter 3.44.8, flutter build apk --target-platform android-arm64 --flavor dev|prod
app-dev-debug.apk     26146208  assets/flutter_assets/kernel_blob.bin
app-dev-profile.apk    2753424  lib/arm64-v8a/libapp.so
app-prod-release.apk   1508240  lib/arm64-v8a/libapp.so
```

Ваш Dart-код узнаёт режим из трёх констант в `package:flutter/foundation.dart`. Это константы времени компиляции, производные от флагов, которые инструмент передаёт компилятору Dart, поэтому компилятор может полностью вырезать (tree-shake) блок `if (kDebugMode) { ... }` из release-сборки:

```dart
// Flutter 3.44.8, packages/flutter/lib/src/foundation/constants.dart (abridged)
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

Добавить четвёртый режим нельзя. "Staging-режима" во Flutter не существует; staging это flavor.

## Что такое flavor на самом деле

Flavor это вариант нативного приложения. У Flutter нет собственного формата конфигурации flavor. Когда вы передаёте `--flavor dev`, инструмент делает три вещи:

1. На Android он запускает задачу Gradle `assemble<Flavor><Mode>`, например `assembleDevDebug`. Если в вашем Gradle-файле не объявлен product flavor с именем `dev`, сборка завершается ошибкой.
2. На iOS и macOS он собирает схему Xcode, названную по flavor (с заглавной буквы, так что для `dev` сначала ищется `Dev`, затем совпадение без учёта регистра), используя конфигурацию сборки `<Mode>-<scheme>`, например `Debug-dev` или `Release-prod`.
3. На всех платформах он добавляет `FLUTTER_APP_FLAVOR=dev` в определения Dart (Dart defines), что в Dart отображается как `appFlavor`.

Всё, что flavor меняет в итоговом бинарном файле, приходит с нативной стороны: суффикс application ID, строка с именем приложения, `google-services.json` или `GoogleService-Info.plist`, значки запуска, конфигурация подписи. Flutter лишь пробрасывает имя.

## Описание flavor на Android с AGP 9

Вот Android-часть демонстрационного приложения. Это стандартный шаблон `flutter create` для Flutter 3.44.8 с добавленным измерением flavor:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.44.8, Android Gradle Plugin 9.0.1, Gradle 9.1.0
android {
    namespace = "com.example.flavordemo"
    compileSdk = flutter.compileSdkVersion

    defaultConfig {
        applicationId = "com.example.flavordemo"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // AGP 9 turns resValue off by default. Without this block the
    // productFlavors below fail with:
    // "Product Flavor dev contains custom resource values, but the feature is disabled."
    buildFeatures {
        resValues = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "Demo Dev")
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "Demo")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
```

Блок `buildFeatures` это то, что упускает большинство старых руководств. Руководства по flavor, написанные до AGP 9, используют `resValue` для имени приложения, и в новом проекте Flutter 3.44 такая конфигурация теперь падает на этапе конфигурации Gradle с ошибкой из комментария выше. Затем укажите в манифесте на эту строку, чтобы каждый flavor получил собственную подпись значка запуска:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application
    android:label="@string/app_name"
    android:name="${applicationName}"
    android:icon="@mipmap/ic_launcher">
```

`aapt2 dump badging` для получившихся APK подтверждает, что две оси действительно независимы. Режим ничего не изменил в идентичности, а flavor ничего не изменил в компиляции:

```text
app-dev-debug.apk     package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-profile.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-release.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-prod-release.apk  package: com.example.flavordemo      versionName 0.1.0      label 'Demo'
```

Поскольку у вариантов `dev` другой application ID, они устанавливаются рядом с продакшен-версией на одном телефоне. Одно это и есть причина, по которой большинство команд используют flavor.

## Ошибки, которые подсказывают, какая ось неверна

Как только Gradle-файл объявляет product flavor, обычный `flutter build apk` перестаёт работать:

```text
# Flutter 3.44.8, no --flavor, productFlavors declared
Running Gradle task 'assembleDebug'...                             14.5s
Gradle build failed to produce an .apk file. It's likely that this file was generated
under .../flavordemo/build, but the tool couldn't find it.
```

Сообщение вводит в заблуждение. `assembleDebug` выполнилась успешно и собрала *каждый* flavor (после этого на диске лежали и `app-dev-debug.apk`, и `app-prod-debug.apk`), но инструмент ищет `app-debug.apk`, которого больше не существует. Передайте `--flavor` или задайте значение по умолчанию (см. ниже).

Обратная ошибка, передача `--flavor` в проект без product flavor, даёт гораздо более понятное сообщение:

```text
# Flutter 3.44.8, --flavor dev, no productFlavors
[!]  Gradle project does not define a task suitable for the requested build.
The .../android/app/build.gradle.kts file does not define any custom product flavors.
You cannot use the --flavor option.
```

На iOS инструмент проверяет flavor по схемам Xcode. Запуск `flutter build ios --config-only --no-codesign --flavor dev` в том же проекте, где ещё нет схемы `dev`, вывел:

```text
The Xcode project defines schemes: FlutterFramework, FlutterGeneratedPluginSwiftPackage, Runner
You must specify a --flavor option to select one of the available schemes.
```

## Доказательство: оба параметра становятся константами в бинарном файле

`appFlavor` объявлен в `package:flutter/services.dart`, и во Flutter 3.47.7 это по-прежнему простой поиск через `String.fromEnvironment`:

```dart
// Flutter 3.47.7, packages/flutter/lib/src/services/flavor.dart
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

Значит, flavor попадает в Dart так же, как и режим: как константа времени компиляции. Чтобы это доказать, `main.dart` демонстрационного приложения выводит в журнал оба значения:

```dart
// Flutter 3.44.8, lib/main.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

void main() {
  debugPrint('FLAVORPROBE appFlavor=$appFlavor kDebugMode=$kDebugMode '
      'kProfileMode=$kProfileMode kReleaseMode=$kReleaseMode');
  runApp(const SizedBox());
}
```

Затем `strings` для AOT-снимка внутри каждого APK показывает, что компилятор свернул всю интерполяцию в один литерал. Во время выполнения не остаётся никакого поиска, который можно было бы проверить:

```text
# strings lib/arm64-v8a/libapp.so | grep FLAVORPROBE
app-dev-release.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=false kReleaseMode=true
app-prod-release.apk:  FLAVORPROBE appFlavor=prod kDebugMode=false kProfileMode=false kReleaseMode=true
app-dev-profile.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=true kReleaseMode=false
```

Из этого следуют два практических вывода. Во-первых, переключать flavor во время выполнения нельзя, потому что бинарный файл содержит только один ответ. Во-вторых, всё, что перекомпилирует Dart без нужных defines, например hot restart из `flutter attach`, получает `appFlavor == null`; эта проблема разобрана в статье [как сохранить заполненным appFlavor после hot restart при flutter attach](/ru/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).

Инструмент также защищает это имя. Попытка подделать flavor через define завершается ошибкой до начала сборки:

```text
# flutter build apk --dart-define=FLUTTER_APP_FLAVOR=qa
FLUTTER_APP_FLAVOR is used by the framework and cannot be set using --dart-define or --dart-define-from-file
```

## iOS и macOS: схемы плюс конфигурации сборки

На платформах Apple flavor состоит из двух частей, которые должны совпадать: схемы, названной по flavor, и набора конфигураций сборки с именами `Debug-<flavor>`, `Profile-<flavor>` и `Release-<flavor>`. Матрица "режим на flavor" буквально записана в именах конфигураций. В Xcode продублируйте `Debug`, `Profile` и `Release` для каждого flavor, создайте схему `dev` и задайте для её действия Run конфигурацию `Debug-dev`, для Profile `Profile-dev`, а для Archive `Release-dev`. Тогда каждая конфигурация сможет задать собственные `PRODUCT_BUNDLE_IDENTIFIER` и отображаемое имя.

Одно поведение Flutter 3.47.7, которое стоит знать: `XcodeProjectInfo.buildConfigurationFor` сначала ищет точное совпадение `Debug-dev`, затем единственную конфигурацию, в имени которой есть и режим, и схема (без учёта регистра), а если нет ни того ни другого, то **откатывается на обычную конфигурацию `Debug`**. Поэтому опечатка вроде `Debug-dve` не приводит к ошибке сборки; сборка тихо идёт с вашей базовой конфигурацией и тем bundle identifier, который в ней указан, обычно продакшен-тем. Если сборка iOS с flavor выглядит как prod, в первую очередь проверьте имена конфигураций.

`flutter run`, `flutter build ios`, `flutter build ipa` и `flutter build macos` принимают `--flavor`. У `flutter build web`, `flutter build windows` и `flutter build linux` в 3.44.8 такой опции нет, потому что для них нет нативной системы вариантов, в которую Flutter мог бы передать имя.

## Ресурсы для конкретного flavor и flavor по умолчанию

Две возможности pubspec делают работу с flavor менее болезненной. Ресурсы можно ограничить определёнными flavor, что не пускает dev-фикстуры и отладочные конфигурации в продакшен-пакет:

```yaml
# pubspec.yaml, Flutter 3.44.8
flutter:
  default-flavor: dev
  assets:
    - path: assets/dev/
      flavors:
        - dev
```

В демонстрационном приложении `assets/flutter_assets/assets/dev/config.json` присутствовал в `app-dev-debug.apk` и `app-dev-profile.apk` и отсутствовал в `app-prod-debug.apk` и `app-prod-release.apk`. Помните, что любой `rootBundle.loadString('assets/dev/config.json')` в общем коде теперь будет бросать исключение в `prod`, это та же ошибка "Unable to load asset", описанная в [статье о ресурсах pubspec](/ru/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

`default-flavor` инструмент использует, когда `--flavor` не указан. В `FlutterCommand.getBuildInfo()` логика сводится к одной строке, `cliFlavor ?? defaultFlavor`, и в 3.47.7 она не изменилась. При его наличии обычный `flutter build apk --release` в демонстрационном проекте собрал `app-dev-release.apk` вместо ошибки. Это удобно для `flutter run` во время разработки, но дважды подумайте, прежде чем коммитить `default-flavor: prod`: задача CI, в которой забыли `--flavor`, тогда молча выпустит тот flavor, который назван в файле.

## К какой оси относится параметр?

Быстрый способ решить, где должна жить та или иная настройка:

- **Она зависит от того, как код компилируется или отлаживается** (подробное журналирование, `debugPaintSizeEnabled`, отключённая отправка отчётов о сбоях во время разработки, оверлеи производительности): используйте режим через `kDebugMode` / `kReleaseMode`. Такие проверки вырезаются из release-сборок.
- **Она зависит от того, какое окружение или продукт вы выпускаете** (базовый URL API, проект Firebase, bundle ID, имя приложения, значок, идентификаторы продуктов paywall): используйте flavor, на нативной стороне для всего, что читает ОС, и через `appFlavor` для всего, что читает Dart.
- **Это значение, а не идентичность** (feature flag, номер сборки, неконфиденциальный ключ): часто проще `--dart-define` или `--dart-define-from-file`. Defines тоже являются константами времени компиляции, поэтому сочетаются с обеими осями.
- **Это секрет**: ничего из перечисленного. Flavor, режимы и defines в итоге оказываются читаемыми строками в бинарном файле, как показывает вывод `strings` выше.

Ошибка, которой стоит избегать, это сопоставление окружений с режимами, например "debug обращается к staging, release обращается к prod". Это работает, пока не понадобится профилировать против продакшена, отлаживать сбой, возникающий только в release, на staging или отправить staging-сборку тестировщикам через TestFlight, что требует release-сборки. Держите оси раздельно, и любая комбинация останется достижимой.

Именно с Firebase на практике это ломается чаще всего. Файлы `google-services.json` для каждого flavor лежат в наборах исходников Android, таких как `android/app/src/dev/`, и несоответствие там приводит к сбою только в release, подобному описанному в [Firebase Auth: вход не сохраняется в release-сборке](/ru/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/). Наборы исходников flavor также влияют на то, какие классы Kotlin компилируются, и это одна из причин из [ClassNotFoundException для MainActivity](/ru/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/), а имена выходных файлов с flavor (`app-prod-release.apk`, `app-prodRelease.aab`) важны, когда вы проверяете нативные библиотеки при [сбое release "Could not create Dart VM instance"](/ru/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Связанные материалы

- [Как сохранить заполненным appFlavor после hot restart при flutter attach](/ru/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/)
- [Fix: ClassNotFoundException for MainActivity when a Flutter Android app launches](/ru/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/)
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/ru/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [Fix: Could not create Dart VM instance in a Flutter release build after flutter upgrade](/ru/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)
- [Fix: Unable to load asset in Flutter after adding an image to pubspec.yaml](/ru/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)

## Источники

- [Flutter docs: Flutter's build modes](https://docs.flutter.dev/testing/build-modes)
- [Flutter docs: Set up Flutter flavors for Android](https://docs.flutter.dev/deployment/flavors)
- [Flutter docs: Set up Flutter flavors for iOS and macOS](https://docs.flutter.dev/deployment/flavors-ios)
- [Android developers: Configure build variants](https://developer.android.com/build/build-variants)
- [`flavor.dart` at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/services/flavor.dart)
- [`flutter_command.dart` (`getBuildInfo`, `default-flavor`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/runner/flutter_command.dart)
- [`xcodeproj.dart` (scheme and build configuration matching) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/ios/xcodeproj.dart)
- [`constants.dart` (`kReleaseMode`, `kProfileMode`, `kDebugMode`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/foundation/constants.dart)

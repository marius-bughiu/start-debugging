---
title: "Исправление: Could not create Dart VM instance в release-сборке Flutter после flutter upgrade"
description: "Release APK собран без libapp.so. Flutter 3.44.0-3.44.4 мог его потерять: обновитесь до 3.44.5 или новее и разделите объединённый блок subprojects."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "ru"
translationOf: "2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

В вашей release-сборке нет скомпилированного кода Dart. Движок ищет AOT-снапшот в `libapp.so`, ничего не находит и не может запустить VM. После обновления до Flutter 3.44.0-3.44.4 обычная причина - регрессия в Gradle-плагине, которая молча выбрасывала `libapp.so` из APK или app bundle. Проверьте APK через `unzip -l`, обновитесь до Flutter 3.44.5 или новее (актуальная стабильная версия - 3.47.3) и разделите объединённый блок `subprojects` в `android/build.gradle` на два блока.

Всё, что написано ниже, проверено по исходникам Flutter 3.44.x и 3.47.3 на GitHub, по changelog хотфиксов 3.44 и по коду движка, который печатает эти строки.

## Ошибка в том виде, как её печатает logcat

```text
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_data.cc(20)] VM snapshot invalid and could not be inferred from settings.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm.cc(253)] Could not set up VM data to bootstrap the VM from.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_lifecycle.cc(85)] Could not create Dart VM instance.
```

Приложение закрывается до запуска `main()`. В 3.44 следом обычно идёт нативный сбой в `FlutterJNI.performNativeAttach`. Старые движки добавляли четвёртую строку, `[FATAL:flutter/shell/common/shell.cc] Check failed: vm. Must be able to initialize the VM.` Вариант этой ошибки на macOS вместо строки про VM snapshot печатает `Isolate snapshot invalid and could not be inferred from settings.` в `dart_vm_data.cc(31)`. У него другая причина, о ней ниже.

Типичная картина, с которой сюда приходят: debug-сборки и `flutter run` работают, свежий проект из `flutter create` работает, а release-сборка настоящего приложения падает при запуске. Всё началось после одного лишь `flutter upgrade`, а откат на прошлую версию проблему убирает.

## Почему движок не находит VM snapshot

Release-сборка не содержит ни исходников Dart, ни байткода kernel. `gen_snapshot` заранее компилирует приложение в нативную разделяемую библиотеку: `libapp.so` на Android и `App.framework` на iOS и macOS. Эта библиотека экспортирует символы снапшота VM и снапшота изолята, и движок стартует из них.

Первая строка лога приходит из `DartVMData::Create` в движке. Сначала он берёт снапшот, переданный embedder. Если снапшота нет или он невалиден, движок обращается к `DartSnapshot::VMSnapshotFromSettings`, которая ищет символы снапшота в библиотеках из `settings.application_library_paths`. Если там ничего нет, он пишет ошибку в лог и возвращает пустой результат. Две другие строки - это вызывающий код, который сдаётся. Поэтому "VM snapshot invalid" почти никогда не означает повреждённый снапшот. Это означает, что искать было негде: AOT-библиотеки нет.

Вопрос превращается в другой: почему в пакете нет `libapp.so`? В порядке вероятности:

1. **Регрессия Gradle во Flutter 3.44.0-3.44.4.** `libapp.so` выпадал из APK и app bundle при некоторых структурах проекта. Именно эта причина проявляется после `flutter upgrade`.
2. **`debuggable true` в release build type.** Gradle-плагин Flutter тогда собирает Dart в режиме debug, и AOT-библиотека вообще не создаётся.
3. **macOS Big Sur и приложение, собранное Flutter 3.44 или новее.** Библиотека на месте, но старый динамический загрузчик не может разрешить символы в новом Mach-O.

## Проверьте: загляните внутрь APK

Не гадайте, проверьте. Это займёт десять секунд:

```bash
# Flutter 3.44.x, Android release build
flutter build apk --release
unzip -Z1 build/app/outputs/flutter-apk/app-release.apk | grep -E 'lib/[^/]+/lib(app|flutter)\.so' | sort
```

В исправном APK обе библиотеки есть для каждого поставляемого ABI:

```text
lib/arm64-v8a/libapp.so
lib/arm64-v8a/libflutter.so
lib/armeabi-v7a/libapp.so
lib/armeabi-v7a/libflutter.so
lib/x86_64/libapp.so
lib/x86_64/libflutter.so
```

В APK из [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), основного отчёта об этой регрессии, были `libflutter.so` и `libdartjni.so` для всех трёх ABI и ни одного `libapp.so`. Эта асимметрия и есть характерный признак. `libflutter.so` приходит из AAR-зависимости, поэтому уцелел. `libapp.so` доставлялся другим путём, поэтому потерялся.

В app bundle пути лежат под `base/lib/`:

```bash
# Flutter 3.44.x
unzip -Z1 build/app/outputs/bundle/release/app-release.aab | grep 'libapp.so'
```

С flavors имя файла содержит flavor (`app-prod-release.apk`, `app-prodRelease.aab`). Проверяйте каждый ABI, а не только arm64. В варианте бага с flavors один ABI может быть на месте, а остальные отсутствовать.

## Что изменилось во Flutter 3.44

До 3.44 Gradle-плагин Flutter доставлял `libapp.so` внутри jar-зависимости. Из-за этого AGP не видел библиотеку при стриппинге нативных библиотек, поэтому [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275) (слит 2026-01-26, вышел в 3.44.0 2026-05-15) перенёс её в каталог source set `jniLibs`, который заполняет плагин. Это изменение позволило стриппить `libapp.so`, но сделало доставку хрупкой в двух местах, как описано в исправлении [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119):

1. Каталог `jniLibs` вычислялся сразу при конфигурации `:app`, а задача копирования записывала его позже. Если `:app` вычислялся до того, как его каталог сборки перенаправлялся, эти две стороны расходились во мнении, где находится каталог сборки, и подготовленный `libapp.so` так и не попадал в итоговый набор. Это происходит при старом объединённом блоке `subprojects` вместе с любым плагином, имя Gradle-проекта которого по алфавиту идёт раньше `app`.
2. Задача копирования писала внутрь собственного выходного каталога задачи Flutter. Пересекающиеся выходы ломали проверки up-to-date в Gradle. В проекте с flavors `flutter run` на одном устройстве (один ABI), за которым следовал полный `flutter build appbundle`, оставлял остальные ABI без `libapp.so` ([#187388](https://github.com/flutter/flutter/issues/187388)). В связанном отчёте инкрементальные сборки с flavors поставляли `libapp.so` от предыдущей сборки ([#187553](https://github.com/flutter/flutter/issues/187553)).

App bundle падали заметнее. Та же отсутствующая библиотека проявляется при сборке как `Release app bundle failed to strip debug symbols from native libraries` ([#186810](https://github.com/flutter/flutter/issues/186810)). У APK такой проверки нет, поэтому они собираются без ошибок и падают на устройстве.

## Минимальное воспроизведение через subprojects

Именно такую структуру команда Flutter заложила в интеграционный тест `gradle_libapp_so_packaging_test.dart`, который вышел вместе с исправлением. Корневой `android/build.gradle` из старого шаблона, где обе инструкции стоят в одном блоке:

```groovy
// android/build.gradle, pre-2021 template shape, broken on Flutter 3.44.0 to 3.44.4
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
    project.evaluationDependsOn(':app')
}
```

Добавьте любой плагин с нативным кодом Android, имя которого по алфавиту идёт раньше `app`, например `android_intent_plus`, соберите через `flutter build apk --release` на 3.44.4, и в APK не будет `libapp.so`. `subprojects {}` обходит проекты в алфавитном порядке. `evaluationDependsOn(':app')` срабатывает на первом же плагине и заставляет сконфигурировать `:app` раньше, чем цикл до него дойдёт и перенаправит его `buildDir`.

## Исправление 1: обновитесь до Flutter 3.44.5 или новее

Исправление попало в master 2026-06-23 и через cherry-pick вошло во [Flutter 3.44.5](https://github.com/flutter/flutter/releases/tag/3.44.5) (2026-07-06). Запись в changelog 3.44.5 гласит: "When building Android app bundles using flavors, or with an old app template combined with a plugin coming alphabetically before app, fixes problems with failing to include libapp.so." Теперь `libapp.so` готовит отдельная задача `CopyFlutterJniLibsTask`, а её выход регистрируется через variant API в AGP, `variant.sources.jniLibs.addGeneratedSourceDirectory(...)`. AGP сам управляет зависимостью задачи и вычисляет путь отложенно, независимо от порядка вычисления проектов.

```bash
# upgrade to current stable (3.47.3 as of 2026-09-10)
flutter upgrade
flutter --version

# clear the stale intermediates that the broken versions left behind
flutter clean
flutter pub get
flutter build apk --release
```

Затем перед публикацией снова выполните проверку через `unzip`. Если нужно остаться на линейке 3.44, исправление есть во всех версиях с 3.44.5 по 3.44.9. На 3.44.0-3.44.4 один лишь `flutter clean` помогает только при сценарии с flavors, и только до следующего `flutter run` на одном устройстве. Против сценария с subprojects он бесполезен.

Если вы фиксируете версию Flutter в CI через FVM или файл `.flutter-version`, обновите и её. Локальный `flutter upgrade` не меняет версию, которой собирает ваш пайплайн, и именно так сбой, который "уже исправлен у меня на машине", всё равно попадает в Play Store. Фиксировать версию по-прежнему правильно, как объясняется в [статье о воспроизводимых сборках Flutter](/ru/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/). Просто меняйте её осознанно.

## Исправление 2: разделите объединённый блок subprojects

Сделайте это даже после обновления. Объединённый блок убрали из шаблона много лет назад ([flutter/flutter#91030](https://github.com/flutter/flutter/pull/91030)), потому что он вызывал ошибки порядка, и один из мейнтейнеров Flutter отметил в [#186810](https://github.com/flutter/flutter/issues/186810), что объединённый синтаксис, вероятно, по-прежнему не поддерживается в общем случае, хотя конкретное взаимодействие из 3.44 исправлено. Корневой `build.gradle.kts` шаблона `android-kotlin` во Flutter 3.47.3 выглядит так:

```kotlin
// android/build.gradle.kts, Flutter 3.47.3 app template
val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}
```

Если вы всё ещё на Groovy, эквивалент такой:

```groovy
// android/build.gradle, Groovy equivalent of the Flutter 3.47.3 template
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
}
subprojects {
    project.evaluationDependsOn(':app')
}
```

Два блока означают, что каталог сборки каждого проекта перенаправлен раньше, чем что-либо заставит вычислить `:app`. Поищите и остатки вроде третьего блока `subprojects { afterEvaluate { ... compileSdkVersion ... } }`, который принудительно задаёт значения плагинам. Они пришли из старых обходных решений со Stack Overflow и обычно становятся причиной следующего сбоя при обновлении Gradle. Когда Gradle падает по-настоящему, а не молча, [реальная ошибка обычно спрятана выше строки с кодом выхода](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## Исправление 3: уберите debuggable true из release build type

Эта причина старше 3.44 и никуда не делась в 3.47.3. Gradle-плагин Flutter выбирает режим сборки Dart по Android build type в `FlutterPluginUtils.buildModeFor`:

```kotlin
// Flutter 3.47.3, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun buildModeFor(buildType: BuildType): String {
    if (buildType.name == "profile") {
        return "profile"
    } else if (buildType.isDebuggable) {
        return "debug"
    }
    return "release"
}
```

Значит, такая конфигурация компилирует ваш код Dart в режиме debug, без `libapp.so`, а остальная часть пайплайна по-прежнему ждёт release-движок:

```kotlin
// android/app/build.gradle.kts, Flutter 3.47.3: this crashes on launch
android {
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isDebuggable = true // makes buildModeFor() return "debug"
        }
    }
}
```

Результат - те же три строки лога. Отчёт об этом - [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), он до сих пор открыт. Уберите `isDebuggable = true` (`debuggable true` в Groovy) из `release`. Если это было нужно, чтобы подключить нативный отладчик к подписанной сборке, используйте `flutter build apk --profile` или заведите для этого отдельный build type и примите, что Dart в нём работает в режиме JIT. Собственный build type вроде `staging` без `isDebuggable` получает Dart в режиме release, а там нужно именно это.

## Вариант на macOS Big Sur: Isolate snapshot invalid

Если лог говорит `Isolate snapshot invalid and could not be inferred from settings.`, а машина работает на macOS 11 Big Sur, библиотека существует и в пакете ничего не потеряно. Начиная с Flutter 3.44, `App.framework` на iOS и macOS записывает напрямую `gen_snapshot` (`--snapshot_kind=app-aot-macho-dylib`), а не компонует `ld64`. В новой dylib нет ни exports trie, ни таблицы содержимого. dyld в Big Sur (dyld-832) тогда переходит к двоичному поиску по таблице символов, условиям которого новый формат не удовлетворяет. Одни символы снапшота находятся, другие нет, поэтому VM snapshot загружается, а isolate snapshot - нет. dyld в Monterey в этом случае использует линейный поиск и загружает тот же бинарник без проблем.

Это разбирали в [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) и [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), и исправлять это не будут. Flutter 3.47 указывает Big Sur (11) и более ранние версии как неподдерживаемые на [странице поддерживаемых платформ](https://docs.flutter.dev/reference/supported-platforms), а команда Flutter не делает cherry-pick в старые стабильные линейки. Варианты: оставаться на Flutter 3.41.x для сборок, которые должны работать на Big Sur, или поднять `MACOSX_DEPLOYMENT_TARGET` до 12.0 и отказаться от этих пользователей. Обходное решение от сообщества переставляет записи таблицы символов после сборки и заново подписывает framework. Мейнтейнер Dart позже сказал, что анализ, на котором оно основано, отчасти неверен (не хватает таблицы содержимого, а не порядка символов), так что я бы его не выпускал.

Посмотреть, что получилось в вашей сборке, можно через `nm`:

```bash
# Flutter 3.47.3, macOS release build
flutter build macos --release
nm -p build/macos/Build/Products/Release/*.app/Contents/Frameworks/App.framework/App | grep kDart
```

## Похожие ошибки, которые не являются этим багом

- Debug-сборка iOS, которая падает при старте с `mprotect failed: 13 (Permission denied)`, - это тоже сбой Dart VM, но в режиме JIT на iOS 26. Для неё есть [отдельное исправление: обновление до Flutter 3.35 или новее](/ru/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).
- Release-сборка, которая нормально запускается, а потом ведёт себя неправильно, уже прошла этот этап: VM стартовала. Потеря входа в Firebase только в release, например, сводится к другому `google-services.json`, отклонённому обновлению токена или App Check. См. [исправление Firebase Auth только в release](/ru/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).
- Если в приложении с flavors `appFlavor` становится `null` после hot restart, это пробел в `flutter attach`, а не проблема упаковки. См. [как сохранить appFlavor после hot restart](/ru/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- Модули add-to-app, собранные как AAR, могут выдавать те же три строки, если AAR собран в другом режиме или из изменённого checkout Flutter ([#114881](https://github.com/flutter/flutter/issues/114881)). Пересоберите AAR через `flutter build aar` из неизменённого SDK и проверьте, есть ли `libapp.so` в папке `jni/` внутри AAR.

## Связанные статьи

- Что ещё изменилось в версии, которая принесла регрессию: [Flutter 3.44 и SwiftPM по умолчанию](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Ошибки Gradle, которые действительно ломают сборку: [Gradle task assembleDebug failed with exit code 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Почему важно фиксировать версию Flutter и почему менять её нужно осознанно: [воспроизводимые сборки Flutter](/ru/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).
- Другой сбой Dart VM при запуске: [mprotect permission denied на iOS](/ru/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).

## Источники

- [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), отчёт по 3.44.1 со списком содержимого APK, где `libapp.so` отсутствовал для всех ABI.
- [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119), исправление с разбором первопричины обоих сценариев.
- [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275), изменение, которое вынесло `libapp.so` из jar.
- [flutter/flutter#186810](https://github.com/flutter/flutter/issues/186810) и [#187553](https://github.com/flutter/flutter/issues/187553), варианты с app bundle и с устаревшим flavor.
- [CHANGELOG Flutter, хотфикс 3.44.5](https://github.com/flutter/flutter/blob/stable/CHANGELOG.md), где перечислены все три issue.
- [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), `debuggable true` в release build type.
- [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) и [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), сбой загрузки `App.framework` на Big Sur.
- Исходный код движка Flutter, `engine/src/flutter/runtime/dart_vm_data.cc` и `dart_snapshot.cc` в ветке `stable`, откуда берутся строки лога.

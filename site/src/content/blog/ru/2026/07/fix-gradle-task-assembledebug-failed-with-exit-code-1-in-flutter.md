---
title: "Исправление: Gradle task assembleDebug failed with exit code 1 при сборке Android в Flutter"
description: "Эта строка -- обёртка, а не ошибка. Запустите заново с flutter run --verbose или ./gradlew assembleDebug --stacktrace, прочитайте настоящий сбой Gradle и чините именно его."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "ru"
translationOf: "2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-31
---

Решение в одном предложении: `Gradle task assembleDebug failed with exit code 1` -- это не ошибка, а сообщение Flutter о том, что Gradle завершился с ненулевым кодом. Настоящий сбой печатается выше и почти всегда обрезается из консоли. Запустите заново с `flutter run --verbose` или перейдите в `android/` и выполните `./gradlew assembleDebug --stacktrace`, а затем чините то, что Gradle действительно говорит под `* What went wrong:`. В июле 2026 года самый частый ответ -- встроенный Kotlin из Android Gradle Plugin 9 конфликтует со старым плагином `kotlin-android`, что проявляется как `Cannot add extension with name 'kotlin'`.

```text
FAILURE: Build failed with an exception.

BUILD FAILED in 47s
Running Gradle task 'assembleDebug'...                             48.2s
Error: Gradle task assembleDebug failed with exit code 1
```

Это руководство написано для Flutter 3.44.7 и Dart 3.12.2, стабильного канала по состоянию на 2026-07-20, с замечаниями по Android Gradle Plugin (AGP) 8.x и 9.x, Gradle 8.13, а также JDK 17 и 21. Процедура диагностики не менялась годами; перечисленные ниже причины менялись, и первая из них появилась с выкаткой AGP 9.

## Почему сообщение ничего не говорит

`assembleDebug` -- это задача Gradle для Android. Инструмент Flutter вызывает Gradle-обёртку в каталоге `android/` вашего проекта, передаёт вывод и затем проверяет код завершения. Если код ненулевой, инструмент выдаёт ровно одну строку: имя задачи и код завершения. Он не имеет представления, что пошло не так, потому что сбои Gradle не типизированы, это просто текст.

Дальше против вас работают две вещи:

1. Инструмент Flutter фильтрует вывод Gradle. Он скрывает шум фазы конфигурации, чтобы обычная сборка выглядела чистой, и при этом иногда отбрасывает нужный вам блок.
2. Сам Gradle обрезает вывод. Без `--stacktrace` цепочка `Caused by:` глубиной в три уровня сворачивается в одну строку, которая может не назвать виновный плагин.

Поэтому первый шаг -- никогда не гадать. Первый шаг -- заставить сборку напечатать правду.

## Получите настоящую ошибку до того, как что-то менять

Выполните это по порядку и остановитесь на первом, что даст блок `* What went wrong:` с именем задачи и причиной:

```bash
# Flutter 3.44.7, Dart 3.12.2
flutter run --verbose
```

Если и это непрозрачно, полностью обойдите инструмент Flutter и говорите с Gradle напрямую. Именно этот шаг чаще всего пропускают, и именно он работает:

```bash
# From the Flutter project root. Use gradlew.bat on Windows.
cd android
./gradlew assembleDebug --stacktrace --info
```

Теперь Gradle печатает полный сбой с указанием модуля, который его вызвал:

```text
* What went wrong:
A problem occurred configuring project ':file_picker'.
> Failed to apply plugin 'kotlin-android'.
   > Cannot add extension with name 'kotlin', as there is an extension
     already registered with that name.
```

Это настоящая, исправимая ошибка. `Gradle task assembleDebug failed with exit code 1` таковой никогда не была.

Есть ещё одна диагностика, которую стоит выполнить до того, как трогать хоть один файл Gradle, потому что она сама по себе отсекает целый класс причин:

```bash
# Validates the Java, Gradle, and AGP versions against each other
flutter analyze --suggestions
```

[Руководство по миграции Android Java Gradle](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide) описывает этот валидатор: он оценивает ваш JDK, Gradle-обёртку и версию AGP как тройку и сообщает, что именно выходит за допустимые границы.

## Причина 1: встроенный Kotlin AGP 9 против плагина `kotlin-android`

Это доминирующая причина в 2026 году и та, которую чаще всего диагностируют неверно, потому что она срабатывает на фазе конфигурации Gradle, до компиляции хотя бы одной строки Dart или Kotlin.

AGP 9.0 поставляется со встроенной поддержкой Kotlin и автоматически регистрирует расширение Gradle с именем `kotlin`. Любой модуль, который всё ещё применяет старый Kotlin Gradle Plugin (`kotlin-android`, также известный как KGP), пытается зарегистрировать второе расширение с тем же именем, и Gradle отказывается:

```text
Cannot add extension with name 'kotlin', as there is an extension
already registered with that name.
```

Модуль, названный в `A problem occurred configuring project ':x'`, показывает, виновато ли ваше собственное приложение или пакет, от которого вы зависите. Если это пакет-плагин вроде `file_picker` или `wakelock_plus`, исправить его в своих файлах сборки нельзя; вы либо обновляете пакет, либо отключаете встроенный Kotlin.

Аварийный выход, согласно [руководству по миграции на встроенный Kotlin для разработчиков приложений](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), прописывается в `android/gradle.properties`:

```properties
# android/gradle.properties -- Flutter 3.44, AGP 9.x
android.newDsl=false
android.builtInKotlin=false
```

Это восстанавливает поведение до AGP 9 для всей сборки, а временная прослойка KGP от Flutter сохраняет работоспособность старого плагина. Это выигрыш времени, а не конечная точка. Flutter уже [завёл задачу на удаление поддержки KGP](https://github.com/flutter/flutter/issues/184837) и [на удаление старого DSL AGP](https://github.com/flutter/flutter/issues/184839) в одной из будущих версий.

Настоящая миграция, когда все нужные вам плагины начнут поддерживать AGP 9, состоит в удалении плагина и блока `kotlinOptions` из `android/app/build.gradle.kts`:

```kotlin
// android/app/build.gradle.kts -- AGP 9.0+, Flutter 3.47+
plugins {
    id("com.android.application")
    // id("kotlin-android")  <-- delete this line
}

android {
    // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <-- delete this block
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
```

Затем переключите флаг:

```properties
# android/gradle.properties
android.builtInKotlin=true
```

Обратите внимание на минимальные версии. Flutter 3.44 поднял минимально поддерживаемый KGP до 2.0.0, а документация указывает, что для включения встроенного Kotlin требуется Flutter 3.47 или новее. На стабильной 3.44 правильный ход -- это `android.builtInKotlin=false` плюс обновление пакетов, а не наполовину сделанная миграция. Если же ваша сборка жалуется, что сам плагин Kotlin слишком старый, это другой сбой с другим решением, разобранный в статье про [ошибку версии Kotlin Gradle plugin](/ru/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).

## Причина 2: ваш JDK и ваша Gradle-обёртка не согласуются

Признак -- номер мажорной версии файла класса:

```text
Caused by: org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
...
Unsupported class file major version 65
```

Мажорная версия 61 -- это Java 17, 65 -- Java 21. Число говорит, какой JDK выполняет сборку; сбой говорит, что ваша Gradle-обёртка слишком стара, чтобы понимать его байт-код. Версии Gradle до 7.3 вообще не запускаются под Java 17, и у каждого выпуска Gradle свой потолок по самому новому принимаемому JDK.

Больнее всего это бьёт, когда вы ничего не меняли: обновился Android Studio, встроенный в неё JDK перешёл с 17 на 21, и ваша пятилетняя Gradle-обёртка сломалась за ночь.

Проверьте, какой JDK использует Flutter:

```bash
flutter doctor -v
```

Затем либо поднимите обёртку:

```bash
# From android/. Pick the version flutter analyze --suggestions recommends.
./gradlew wrapper --gradle-version=8.13
```

Либо закрепите за Flutter тот JDK, с которым обёртка справится:

```bash
# macOS example. /usr/libexec/java_home -V lists installed JDKs.
flutter config --jdk-dir=/opt/homebrew/Cellar/openjdk@17/17.0.13/libexec/openjdk.jdk/Contents/Home
```

Предпочтительнее двигать Gradle вперёд. Закрепление старого JDK -- это решение, за которое вы заплатите снова при следующем подъёме AGP.

## Причина 3: несовпадение версий NDK между плагинами

Любой пакет с нативным кодом объявляет версию NDK. Если два из них расходятся с тем, что настроило ваше приложение, сборка останавливается:

```text
* What went wrong:
Execution failed for task ':app:configureCMakeDebug[arm64-v8a]'.
> [CXX1101] NDK at .../ndk/26.3.11579264 did not have a source.properties file
```

Или, более явно:

```text
Your project is configured with Android NDK 26.3.11579264, but the following
plugin(s) depend on a different Android NDK version:
- path_provider_android requires Android NDK 27.0.12077973
```

Выпуски NDK обратно совместимы, поэтому решение -- взять самую высокую версию, которую запрашивает любая зависимость:

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44
android {
    ndkVersion = "27.0.12077973"
}
```

Если ошибка упоминает отсутствующий `source.properties`, названный каталог NDK существует, но это неполная загрузка. Удалите этот каталог внутри папки `ndk/` вашего Android SDK, переустановите версию через SDK Manager, затем выполните `flutter clean`.

## Причина 4: плагин поднимает minSdkVersion выше вашего

Слияние манифестов происходит внутри `assembleDebug`, поэтому конфликт уровня SDK проявляется той же самой обёрткой:

```text
* What went wrong:
Execution failed for task ':app:processDebugMainManifest'.
> Manifest merger failed : uses-sdk:minSdkVersion 21 cannot be smaller than
  version 23 declared in library [:some_plugin]
```

Поднимите нижнюю границу, а не подавляйте слияние через `tools:overrideLibrary`, что лишь переносит падение в среду выполнения на тех устройствах, которые вы исключили:

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        minSdk = 23
    }
}
```

Тот же вид сбоя на конкретном пакете разобран в материале про [background_fetch, требующий minSdkVersion 21](/ru/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/). Если же слиятель жалуется на дублирующиеся классы support library, перед вами совсем другая проблема: смотрите [конфликт AndroidX при сборке Android в Flutter](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/).

## Причина 5: у заброшенного плагина нет namespace

AGP 8.0 сделал свойство `namespace` обязательным и перестал читать `package` из `AndroidManifest.xml`. Пакет, который ничего не публиковал со времён AGP 7, падает на конфигурации:

```text
* What went wrong:
A problem occurred configuring project ':some_old_plugin'.
> Namespace not specified. Specify a namespace in the module's build file.
```

Поддерживаемого способа внедрить namespace в чужой пакет из своего приложения не существует. В порядке предпочтения: обновите пакет, замените его или сделайте форк и добавьте `namespace 'com.example.some_old_plugin'` в его `android/build.gradle`. Скрипты, переписывающие файлы в `~/.pub-cache`, широко ходят по сети для этой ошибки, и это ловушка: кеш пересоздаётся, поэтому исправление исчезнет на следующей машине и в CI.

## Причина 6: всё в порядке, кроме состояния на диске

Не всякий код завершения 1 -- это проблема конфигурации. Наполовину записанный артефакт в `build/`, демон Gradle, удерживающий устаревший classpath, или каталог `.dart_tool` от другой версии SDK дают сбои, которые выглядят структурными, но таковыми не являются. Перед долгой отладочной сессией уберите дешёвые случаи:

```bash
flutter clean
cd android && ./gradlew --stop && ./gradlew clean && cd ..
flutter pub get
flutter run
```

Если после этого собирается, у вас была проблема устаревшего состояния и чинить больше нечего. Если по пути падает `pub get`, вывод решателя ограничений -- это отдельное диагностическое упражнение, разобранное в статье про [чтение ошибки version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Варианты, попадающие на эту страницу по ошибке

- **`Gradle task assembleRelease failed with exit code 1`**: та же обёртка вокруг release-варианта. Всё вышесказанное применимо, плюс R8 и сжатие кода, которые работают только в release. Если debug собирается, а release нет, начните с `isMinifyEnabled = false`, чтобы подтвердить вину R8, а затем добавьте недостающие keep-правила вместо того, чтобы оставлять сжатие выключенным.
- **`Gradle task assembleDebug failed with exit code 1` мгновенно, менее чем за две секунды**: это не сбой компиляции. Gradle не смог запуститься. Проверьте URL дистрибутива обёртки в `android/gradle/wrapper/gradle-wrapper.properties` и сетевой доступ к `services.gradle.org`.
- **`Execution failed for task ':app:checkDebugAarMetadata'`**: зависимости требуется более высокий `compileSdk`, чем объявляет ваше приложение. Поднимите `compileSdk` в `android/app/build.gradle.kts`; это потолок времени компиляции, а не цель времени выполнения, поэтому подъём не меняет поведение на устройстве.
- **Сбой возникает только в CI**: сравните версии JDK, Android SDK и NDK на раннере с вашей машиной. Причина 2 и причина 3 объясняют почти все сообщения вида "локально проходит, в CI падает", и обе имеют форму окружения, а не кода.
- **Сбой появился после обновления Flutter**: просмотрите индекс несовместимых изменений выпуска, прежде чем отлаживать симптом. Скачок фреймворка, который заодно двигает шаблонные версии AGP и Gradle, может задеть сразу несколько причин выше, ровно как это делает [обновление с Flutter 2 на Flutter 3](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

Общий урок выходит за рамки одного этого сообщения. Всякий раз, когда сбой сборки Flutter называет задачу Gradle и код завершения, инструмент -- лишь посыльный. Перейдите в `android/`, выполните задачу сами с `--stacktrace` и прочитайте блок под `* What went wrong:`. Решение всегда в этом блоке и никогда не в строке, которую напечатал Flutter.

## Похожее

- [Исправление: конфликт AndroidX при сборке Android в Flutter](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- вариант с дублирующимися классами того же сбоя конфигурации и почему отключение Jetifier в AGP 8 вернуло его.
- [Flutter: проекту требуется более новая версия Kotlin Gradle plugin](/ru/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) -- минимальная версия KGP, отдельный сбой по сравнению с коллизией расширений AGP 9 выше.
- [Исправление: background_fetch требует minSdkVersion 21](/ru/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) -- разобранный пример конфликта SDK при слиянии манифестов из причины 4.
- [Исправление: Version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- что делать, когда падает именно `flutter pub get` из последовательности очистки.
- [Миграция приложения с Flutter 2 на Flutter 3.x: чек-лист null safety](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) -- более широкий путь обновления, который обычно задевает сразу несколько из этих причин Gradle.

## Источники

- [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide), документация Flutter
- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin), документация Flutter
- [Built-in Kotlin migration for app developers](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), документация Flutter
- [Flutter maintained plugins should support AGP 9.0](https://github.com/flutter/flutter/issues/181383), flutter/flutter
- [Gradle Java compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html#java), документация Gradle
- [Android Gradle Plugin release notes](https://developer.android.com/build/releases/gradle-plugin), Android Developers

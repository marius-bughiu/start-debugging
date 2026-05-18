---
title: "Исправление: конфликт AndroidX при сборке Flutter Android"
description: "Исправление за 30 секунд: установите android.useAndroidX=true и android.enableJetifier=true в android/gradle.properties, затем найдите любой плагин, всё ещё использующий старую support library, и обновите или замените его."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "androidx"
lang: "ru"
translationOf: "2026/05/fix-androidx-conflict-during-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-05-18
---

Исправление в одном предложении: `AndroidX conflict` при сборке Flutter Android означает, что две половины вашего графа зависимостей расходятся в том, какую Android support library они используют. Движок Flutter и любой плагин, опубликованный за последние пять лет, используют `androidx.*`. Одного плагина (или транзитивной Java-библиотеки), который всё ещё ссылается на `android.support.*`, достаточно, чтобы сломать сборку. Установите `android.useAndroidX=true` и `android.enableJetifier=true` в `android/gradle.properties`, выполните `flutter clean`, затем снова `flutter pub get` и `flutter build apk`. Если Gradle всё ещё отказывается, найдите виновный плагин с помощью `./gradlew app:dependencies` и обновите или замените его. Пока не редактируйте ничего в `android/app/build.gradle`.

```text
* What went wrong:
Execution failed for task ':app:checkDebugDuplicateClasses'.
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules
    core-1.6.0-runtime (androidx.core:core:1.6.0) and
    support-compat-28.0.0-runtime (com.android.support:support-compat:28.0.0)

  Go to the documentation to learn how to <a href="d.android.com/r/tools/classpath-sync-errors">Fix dependency resolution errors</a>.

FAILURE: Build failed with an exception.
BUILD FAILED in 12s
```

Это руководство написано для Flutter 3.41.5, Dart 3.11, Android Gradle Plugin 8.7 и Gradle 8.11, стабильного канала по состоянию на май 2026. Описанное здесь поведение остаётся неизменным с тех пор, как команда Android tooling заморозила пространство имён `android.support.*` в 2018 году и выпустила Jetifier как мост для устаревшего байткода. Проект Flutter включил AndroidX по умолчанию для новых приложений в [Flutter 1.12](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (декабрь 2019); всё, что сгенерировано с тех пор, поставляется с `useAndroidX=true` из коробки. Если вы столкнулись с этой ошибкой, приложение почти наверняка было создано на Flutter SDK старше 1.12, и миграция к нему так и не была применена.

## Что на самом деле означает эта ошибка

`androidx.*` это второе поколение Android support library. Google переписал пространство имён пакетов один раз и обязался никогда больше его не переименовывать. Классы под `android.support.v4.*`, `android.support.v7.*`, `android.support.design.*` и т. д. являются оригинальными support libraries и заморожены с версии 28.0.0 в сентябре 2018.

Система сборки Android отказывается компилировать APK, содержащий обе половины одновременно, потому что дублирующиеся имена классов сталкиваются в classpath. Ошибка проявляется в одной из трёх конкретных форм:

```text
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules ...
```

```text
This app is using AndroidX dependencies, but the project does not have
the property android.useAndroidX set to true. Configure your project for
AndroidX. See https://goo.gle/flutter-androidx-migration
```

```text
Cannot fit requested classes in a single dex file (# methods: 73512 > 65536)
```

Первая это буквальное столкновение classpath. Вторая это предварительная проверка инструмента Flutter, замечающая, что в проекте всё ещё установлено устаревшее значение по умолчанию. Третья это тот же конфликт, выраженный ниже по цепочке: подтягивание обеих библиотек превышает лимит в 64K методов Dalvik, потому что у каждого support-класса есть близнец в AndroidX.

Jetifier это обходной путь, поставляемый с AGP. Во время сборки он переписывает каждую ссылку на `android.support.*` внутри любого JAR или AAR, поступающего из сторонней зависимости, в эквивалентную ссылку на `androidx.*`. С включённым Jetifier плагин, который всё ещё поставляет байткод support library, молча транслируется, и столкновение дублирующихся классов исчезает. С выключенным Jetifier дубликат становится видимым, и сборка падает. AGP 8 и более поздние версии по умолчанию устанавливают `enableJetifier` в `false` ради скорости сборки, и именно поэтому эта ошибка снова на первой странице для проектов, которые жили годами без того, чтобы кто-либо заметил устаревший плагин в их дереве зависимостей.

## Минимальное воспроизведение

Создайте свежее Flutter-приложение на актуальной SDK, затем добавьте плагин, который всё ещё ссылается на support library через транзитивную Java-зависимость:

```bash
# Flutter 3.41.5
flutter create androidx_repro
cd androidx_repro
flutter pub add some_old_plugin:^1.2.0  # any plugin whose Android side
                                        # depends on com.android.support:*
```

Затем намеренно выключите обходной путь:

```properties
# android/gradle.properties, Flutter 3.41.5, AGP 8.7
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G
android.useAndroidX=true
android.enableJetifier=false
```

Запустите сборку:

```bash
flutter build apk --debug
```

Gradle печатает сбой о дублирующихся классах выше и завершается с ненулевым кодом. Единственная строка, которая запускает регрессию, это `enableJetifier=false` в сочетании с транзитивной зависимостью от `com.android.support:*`. Включите Jetifier обратно, и та же сборка успешна, хотя в дереве плагинов ничего не изменилось.

## Исправление, в порядке того, как часто это и есть ответ

Выполняйте шаги по порядку. Каждый шаг предполагает, что предыдущий не разрешил ошибку.

### 1. Установите обе флаги AndroidX

Откройте `android/gradle.properties` (не файл Gradle в Flutter SDK, не `build.gradle` корневого проекта) и подтвердите, что обе строки присутствуют:

```properties
# android/gradle.properties, Flutter 3.41.5
android.useAndroidX=true
android.enableJetifier=true
```

`useAndroidX=true` говорит AGP, что ваш собственный код и движок Flutter используют AndroidX. `enableJetifier=true` говорит AGP переписать любой сторонний байткод, который всё ещё ссылается на support library. Вам нужны обе. Установка только `useAndroidX=true`, в то время как плагин всё ещё поставляет support-классы, это именно та конфигурация, которая производит ошибку дублирующихся классов.

Если файл не существует (редко для проекта Flutter 1.12+, обычно для приложений, мигрированных с нативного Android), создайте его. Затем выполните:

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter clean` здесь обязателен, потому что Gradle кеширует граф разрешения зависимостей; без него сборка переиспользует упавший граф и сообщит ту же ошибку.

### 2. Найдите и обновите устаревший плагин

Если Jetifier включён, а сборка всё ещё падает, дубликат это не сама support library, а плагин, чей `android/build.gradle` напрямую объявляет `com.android.support:*` и использует что-то, что Jetifier не может переписать (annotation processors самые частые нарушители, поскольку Jetifier по умолчанию работает только с JAR файлами runtime classpath).

Перечислите дерево зависимостей Android:

```bash
# from android/ directory, Flutter 3.41.5
./gradlew app:dependencies --configuration releaseRuntimeClasspath | grep -i "com.android.support"
```

Вывод называет плагин и координату support library. Сопоставьте её с вашим `pubspec.yaml`. Три разрешения, в порядке предпочтения:

1. **Обновите плагин**, если существует более новая версия. Выполните `flutter pub outdated` и найдите нарушителя. Версия, опубликованная после конца 2019 года, будет нативной для AndroidX, и конфликт исчезнет.
2. **Замените плагин**, если он не поддерживается. Сообщество Flutter переписало большинство плагинов до 1.12 под другим именем; поищите на [pub.dev](https://pub.dev) ту же область (уведомления, image picker и т. д.) и выберите самую свежую поддерживаемую опцию.
3. **Форкните и пропатчите**, если ничего не помогает. Клонируйте репозиторий плагина, измените каждую строку `com.android.support:appcompat-v7:28.0.0` в `android/build.gradle` на `androidx.appcompat:appcompat:1.6.1` ([маппинг классов AndroidX](https://developer.android.com/jetpack/androidx/migrate/class-mappings) переводит старые имена в новые), обновите ваш `pubspec.yaml`, чтобы он указывал на форк через `git:`, и выполните `flutter pub get`.

### 3. Поднимите `compileSdk` до версии, включающей AndroidX

Если вы мигрировали это приложение с нативного Android, `android/app/build.gradle` может фиксировать `compileSdkVersion` на 28 или ниже. AndroidX требует `compileSdk` 28 или выше и лучше всего работает с самой свежей стабильной версией. Flutter 3.41.5 по умолчанию устанавливает `flutter.compileSdkVersion` в 35; если вы переопределили это, восстановите значение по умолчанию или установите его явно:

```groovy
// android/app/build.gradle, Flutter 3.41.5, AGP 8.7
android {
    namespace "com.example.androidx_repro"
    compileSdk 35
    ndkVersion flutter.ndkVersion

    defaultConfig {
        applicationId "com.example.androidx_repro"
        minSdkVersion 21      // AndroidX requires at least 19; pick 21 unless you have a reason
        targetSdkVersion 35
    }
}
```

`minSdkVersion 21` это практический минимум для AndroidX-приложения в 2026 году. Идти ниже в принципе работает, но подтягивает shims совместимости, которые производят другие, но столь же запутанные ошибки classpath на этапе merge.

### 4. Включите multidex, если дубликат пропал, но ошибка лимита dex остаётся

Лимит в 64K методов старше AndroidX, и AGP автоматически включает multidex, когда `minSdkVersion >= 21`. Если вы всё ещё видите ошибку "cannot fit requested classes", у вас `minSdk` ниже 21, и вам нужно явно опт-ин:

```groovy
// android/app/build.gradle
android {
    defaultConfig {
        multiDexEnabled true
    }
}

dependencies {
    implementation "androidx.multidex:multidex:2.0.1"
}
```

Это не исправление самого конфликта AndroidX, это проход уборки, когда вы уже разрешили дублирующиеся классы, но оставшееся количество методов всё ещё переполняется.

### 5. Последнее средство: выключайте Jetifier только после аудита каждой зависимости

Как только вы подтвердили через `./gradlew app:dependencies`, что ни один плагин в дереве больше не ссылается на `com.android.support:*`, установите `android.enableJetifier=false` ради выигрыша в скорости сборки. Переписывание classpath в Jetifier это самый дорогой единичный шаг в холодной сборке Android для большого Flutter-приложения (15-30 секунд в типичном проекте по нашим измерениям). Выключение его не требует никаких изменений в вашем коде или зависимостях pub, но если вы сделаете это без предварительного аудита, конфликт вернётся в следующий раз, когда транзитивное обновление подтянет устаревшую библиотеку, и вы будете думать, что ошибка не имеет ничего общего с Jetifier, потому что вы убрали его недели назад.

## Подвохи и похожие случаи

Несколько случаев, которые производят похожую ошибку или выглядят как конфликт AndroidX, но таковыми не являются:

- **`Could not find com.android.tools.build:gradle:X.Y.Z`**: не проблема AndroidX. Репозиторий Google Maven недоступен, или ваш `settings.gradle` потерял запись о репозитории `google()`. Добавьте `google()` в `pluginManagement.repositories` и `dependencyResolutionManagement.repositories`.
- **`Manifest merger failed : Attribute application@appComponentFactory ...`**: это исторический признак столкновения AndroidX/support конкретно в манифесте, до того как существовала проверка AGP на уровне байткода. То же исправление (включить обе флаги) разрешает это, но триггер заключается в том, что `AndroidManifest.xml` плагина объявляет имя компонента `android.support.*`, а не его Java-код ссылается на support-класс.
- **`Class not found: com.android.support.FileProvider`**: `AndroidManifest.xml` плагина жёстко прописывает путь support library. Jetifier по умолчанию не переписывает XML манифеста. Либо обновите плагин, либо переопределите элемент `<provider>` в вашем собственном `AndroidManifest.xml` AndroidX-эквивалентом (`androidx.core.content.FileProvider`).
- **`Execution failed for task ':app:processDebugMainManifest'`** во время `flutter run` на release-сборке: обычно несоответствие `targetSdkVersion` между плагинами. AndroidX в порядке; merge падает, потому что два плагина расходятся в `android:exported` для activity. Не связано, хотя и проявляется в том же шаге Gradle.
- **Сборка успешна на macOS, но падает на Linux CI**: самая частая первопричина это устаревший `~/.gradle/caches` на машине разработчика, который маскирует отсутствующую флагу AndroidX. У Linux runner кеш чистый, и он разрешает граф зависимостей с нуля. Исправление то же самое (флаги), но симптом выглядит как проблема только CI.
- **Чистый проект `flutter create` сталкивается с этим**: не должен. Если новое приложение сталкивается с конфликтом AndroidX до того, как вы добавили какой-либо плагин, ваш Flutter SDK старше 1.12, и вам нужно обновиться. Выполните `flutter upgrade` и заново запустите `flutter create` на новой SDK; скопируйте ваш `lib/` поверх, а не редактируйте сломанный проект.

Если вы прибегаете к `enableJetifier=true` чаще одного раза в год в одном и том же проекте, у вас есть как минимум один плагин, чей мейнтейнер перестал следить за платформой Android. Замените его. Jetifier официально обозначен как переходный shim, и команда AGP публично заявила, что он будет удалён в будущем major-релизе.

## Связанное

- [Исправление: Version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Исправление: Gradle build failed to produce an .apk file в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)
- [Исправление: Failed to build iOS app с Xcode 16 и Flutter 3.x](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Как нацеливаться на несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Исправление: A RenderFlex overflowed by N pixels во Flutter](/ru/2026/05/fix-renderflex-overflowed-in-flutter/)

## Источники

- [Миграция на AndroidX для Flutter](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (docs.flutter.dev)
- [Migrate to AndroidX](https://developer.android.com/jetpack/androidx/migrate) (developer.android.com)
- [Маппинг классов AndroidX](https://developer.android.com/jetpack/androidx/migrate/class-mappings) (developer.android.com)
- [Release notes Android Gradle Plugin: значение по умолчанию enableJetifier](https://developer.android.com/build/releases/gradle-plugin) (developer.android.com)
- [flutter/flutter issue 25325: отслеживание поддержки AndroidX](https://github.com/flutter/flutter/issues/25325) (канонический тред оригинальной миграции)

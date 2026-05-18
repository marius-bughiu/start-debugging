---
title: "Исправление: плагин Flutter background_fetch требует minSdkVersion 21"
description: "Исправление за 30 секунд: установите minSdkVersion в 21 (или выше) в android/app/build.gradle. background_fetch построен на Android JobScheduler, который существует только начиная с API 21."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "background_fetch"
lang: "ru"
translationOf: "2026/05/fix-flutter-background-fetch-requires-minsdkversion-21"
translatedBy: "claude"
translationDate: 2026-05-18
---

Исправление одной фразой: плагин `background_fetch` (Transistor Software) поставляется с `AndroidManifest.xml` и кодом на Kotlin, который подключает Android `JobScheduler`, появившийся в API 21 (Android 5.0 Lollipop). Если `android/app/build.gradle` вашего Flutter-приложения всё ещё использует `minSdkVersion 19` (или `16`, в приложениях, сгенерированных Flutter SDK до 2023 года), manifest merger отказывает сборке с сообщением `uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]`. Откройте `android/app/build.gradle`, поменяйте `minSdkVersion` минимум на `21`, выполните `flutter clean`, затем `flutter pub get` и `flutter build apk`. Если вы на более новом Flutter SDK, который использует `minSdk flutter.minSdkVersion`, переопределите общее значение Flutter, а не вшивайте число литералом, иначе Flutter Gradle plugin молча перезапишет вашу правку при следующей сборке.

```text
> Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]
    /Users/me/myapp/build/background_fetch/intermediates/merged_manifest/debug/AndroidManifest.xml as the library might be using APIs not available in 19
    Suggestion: use a compatible library with a minSdk of at most 19,
        or increase this project's minSdk version to at least 21,
        or use tools:overrideLibrary="com.transistorsoft.flutter.backgroundfetch" to force usage (may lead to runtime failures)

FAILURE: Build failed with an exception.
BUILD FAILED in 14s
```

Это руководство написано под Flutter 3.41.5, Dart 3.11, `background_fetch` 1.6.2, Android Gradle Plugin 8.7 и Gradle 8.11, стабильный канал на май 2026 года. Сама ошибка стабильна с `background_fetch` 1.0.0; сдвинулось только значение `minSdkVersion` по умолчанию в свежесгенерированном Flutter-проекте, поэтому одни команды ловят это на первой сборке недавно обновлённого приложения, а другие никогда не видели.

## Что на самом деле говорит ошибка

Система сборки Android выполняет проход manifest merger, который объединяет `AndroidManifest.xml` приложения с манифестами каждой AAR в classpath. Каждый манифест объявляет тег `<uses-sdk android:minSdkVersion="X"/>`. Merger выбирает максимальное значение и отклоняет сборку, в которой `minSdkVersion` на уровне приложения ниже того, что объявляет любая из библиотек. `background_fetch` объявляет `minSdkVersion 21` в [манифесте своего плагина](https://github.com/transistorsoft/flutter_background_fetch/blob/master/android/src/main/AndroidManifest.xml), и единственный способ удовлетворить merger -- поднять приложение до того же значения.

Ошибка проявляется в трёх конкретных формах в зависимости от версии Android Gradle Plugin и поколения шаблона Flutter:

```text
Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21
declared in library [:background_fetch]
```

```text
The plugin background_fetch requires a higher Android SDK version.
Fix this issue by adding the following to /Users/me/myapp/android/app/build.gradle:
android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

```text
A problem occurred evaluating project ':background_fetch'.
> com.transistorsoft.flutter.backgroundfetch requires Android SDK 21 or above
```

Первое -- сырое сообщение manifest merger. Второе -- предполётная подсказка CLI `flutter`, которая срабатывает только для плагинов, объявивших свой `minSdkVersion` через дескриптор плагина Flutter. Третье -- gradle-утверждение, зашитое в `android/build.gradle` плагина. Все три сводятся к одному ограничению: `JobScheduler` и классы `android.app.job.JobInfo`, `JobService` и `JobParameters`, которые вызывает `background_fetch`, были добавлены в API 21. В API 19 их не существует вовсе; в API 20 (Android Wear 4.4W) был выпущен только подмножество `JobService`. Плагин не запустится ни на чём ниже 21, поэтому manifest merger блокирует сборку до того, как вы выпустите сломанный APK.

## Почему именно API 21

`JobScheduler` существует не просто так: до него планирование повторяющейся фоновой работы на Android означало `AlarmManager` с wake lock, `IntentService` и самописный цикл повторов. Этот подход сажал батарею, обходил режим Doze начиная с Android 6.0 и был помечен deprecated по частям в Android 8.0, 9.0 и 10. `JobScheduler` позволяет ОС склеивать фоновую работу разных приложений, откладывать её по состоянию заряда или типу сети и переживать смерть процесса. `background_fetch` внутри -- тонкая Dart-friendly обёртка над `JobScheduler` (и iOS-эквивалентом, `BGTaskScheduler`). По построению он не может целиться в API ниже 21, не переписав весь бэкенд.

[README](https://pub.dev/packages/background_fetch) плагина и его `CHANGELOG.md` фиксируют это требование с 1.0.0 в 2018 году, но ошибка снова стала массовой в 2025-м, когда Google Play начал отклонять приложения с `targetSdkVersion 33` и ниже, что спровоцировало широкие пересборки долгоживущих Flutter-кодовых баз, не трогавших свой `android/app/build.gradle` с 2019 года.

## Минимальное воспроизведение

Создайте Flutter-приложение на SDK, который по умолчанию ещё ставит `minSdkVersion 19`, добавьте плагин и запустите debug-сборку:

```bash
# Flutter 3.7.0 (December 2022), the last template before the 19 -> 21 bump
flutter create background_fetch_repro
cd background_fetch_repro
flutter pub add background_fetch
flutter build apk --debug
```

`flutter pub add background_fetch` резолвится в `^1.6.2` и прописывает транзитивную зависимость на манифест Android-плагина. Следующая сборка упадёт с `Manifest merger failed`. Та же ошибка воспроизводится в свежесгенерированном проекте Flutter 3.41.5, если вы вручную понизили `minSdkVersion`, потому что другой плагин (`flutter_blue_classic`, например) казался требующим меньшего значения.

## Исправление, подробно

Есть три рабочих пути в зависимости от того, какой Flutter SDK сгенерировал проект. Выберите тот, который соответствует вашему `android/app/build.gradle`.

### Путь A: Groovy build.gradle с жёстко прописанными числами

Если `android/app/build.gradle` содержит литерал `minSdkVersion 19`, поменяйте литерал:

```groovy
// android/app/build.gradle
// Flutter 3.0 through 3.15 era template
android {
    compileSdkVersion 34

    defaultConfig {
        applicationId "com.example.myapp"
        minSdkVersion 21        // was 19
        targetSdkVersion 34
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }
}
```

Сохраните и выполните `flutter clean && flutter pub get && flutter build apk`. Merger теперь возьмёт 21 из приложения и примет 21 плагина.

### Путь B: Groovy build.gradle через flutter.minSdkVersion

Flutter 3.16 и новее заменяют литерал на ссылку на свойство, которое выставляет Flutter Gradle plugin:

```groovy
// android/app/build.gradle
// Flutter 3.16 through 3.27 era template
android {
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
    }
}
```

`flutter.minSdkVersion` начиная с Flutter 3.16 по умолчанию равен 21, так что эта ветка уже проходит. Если ваш проект на этом шаблоне и manifest merger всё равно падает, значит что-то перебивает свойство. Проверьте `android/local.properties` на устаревшую строку `flutter.minSdkVersion=19` и удалите её, либо передавайте `-Pflutter.minSdkVersion=21` в командной строке Gradle, если CI впрыскивает старое значение. Не заменяйте ссылку на свойство литералом; Flutter Gradle plugin в 3.41 переписывает `android/app/build.gradle` при каждом `flutter run` при определённых условиях ([flutter/flutter#177141](https://github.com/flutter/flutter/issues/177141)) и откатит вашу правку.

### Путь C: build.gradle.kts в Kotlin DSL

Flutter 3.29 перевёл шаблон на Kotlin DSL. Форма та же на синтаксисе Kotlin:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.29 and later
android {
    defaultConfig {
        applicationId = "com.example.myapp"
        minSdk = flutter.minSdkVersion       // resolves to 21 on Flutter 3.29+
        targetSdk = flutter.targetSdkVersion
    }
}
```

Если нужно явно зафиксировать значение (например, потому что другой плагин требует 23), поставьте `minSdk = 23`. Flutter Gradle plugin уважает явные литералы в Kotlin DSL-шаблоне; баг перезаписи на данный момент только у Groovy-шаблона.

После любого из трёх запустите:

```bash
flutter clean
flutter pub get
flutter build apk --release
```

`flutter clean` здесь важен, потому что manifest merger кеширует своё решение в `build/app/intermediates/merged_manifest/`. Следующая сборка без шага clean будет повторно проигрывать неудачный merge с диска, и вы решите, что правка ничего не дала.

## Чего на самом деле стоит подъём minSdkVersion до 21

API 21 -- это Android 5.0 Lollipop, выпущенный в октябре 2014 года. Сам [дашборд распределения](https://developer.android.com/about/dashboards) Google (последнее значимое обновление до того, как Google перенёс его внутрь Android Studio) указывает долю устройств ниже API 21 заметно меньше 0,3 процента на 2026 год, почти полностью это старые Kindle Fire и необновлённые устройства из развивающихся рынков. Play Store больше не принимает новые релизы с `targetSdkVersion` ниже 24 в любом случае, так что для приложения, распространяемого через Play, вопрос неактуален. Если вы раздаёте APK через sideload или альтернативные магазины, у вас может быть длиннохвостая аудитория на API 19 или 20, и в этом случае `background_fetch` просто не вариант: shim'а нет. Используйте `WorkManager` напрямую через [Pigeon](https://pub.dev/packages/pigeon)-канал или согласитесь на foreground-сервис с постоянным уведомлением.

## Подводные камни после того, как merger прошёл

Несколько производных ошибок выглядят как первая, но имеют другие причины. Узнавайте их, чтобы не задирать `minSdkVersion` дальше и не ломать совместимость зря.

**Другому плагину нужно больше 21.** Если после исправления вы видите `cannot be smaller than version 23 declared in library [:flutter_blue_plus]`, это другой плагин, просящий API 23. Поднимите `minSdkVersion` до максимального, объявленного любым плагином в вашем дереве. Запустите `./gradlew app:dependencies` из `android/`, чтобы их перечислить.

**Пропал тег манифеста для headless-задач.** Если вы используете `BackgroundFetch.registerHeadlessTask`, чтобы получать колбэки, когда приложение завершено, манифест должен объявить receiver. Манифест плагина уже его содержит, но приложения, вручную ставящие `tools:replace="android:label"` на тег `<application>` (правка эпохи миграции на AndroidX), могут случайно перезаписать и `android:name` или удалить receiver. Прочитайте [руководство по конфликту AndroidX](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/), если подозреваете это; симптом тихий (ни один колбэк не срабатывает), а не ошибка сборки.

**Отсутствует идентификатор BGTaskScheduler на iOS.** Android-ошибка самая громкая, но параллельная iOS-конфигурация обязательна. В `Info.plist` нужен массив `BGTaskSchedulerPermittedIdentifiers` со значением `com.transistorsoft.fetch`, а Xcode-проект должен иметь capability `background-fetch`, включённую в Signing and Capabilities. Android-фикс выше позволит пройти сборке Android, но iOS-сборка по-прежнему упадёт или, что хуже, соберётся и в продакшене никогда не запустит колбэк.

**Gradle daemon кеширует объединённый манифест.** На CI `flutter clean` не всегда достаточно. Gradle daemon держит выходы `:app:processDebugManifest` в `~/.gradle/caches/`. Если запуск CI однажды упал со старым `minSdkVersion`, следующий может повторить падение, пока вы не вызовете `./gradlew --stop` перед следующей сборкой или не удалите каталог кеша.

**Jetifier на свежем AGP меняет вид ошибки.** AGP 8.7 отключает Jetifier по умолчанию. Если вы явно включили его обратно в `gradle.properties` (`android.enableJetifier=true`), manifest merger работает после того, как Jetifier перепишет AAR библиотеки, и сообщение об ошибке заменяет `com.transistorsoft.flutter.backgroundfetch` на имя, переписанное в `androidx.*`. Та же причина, другой текст. Исправление идентично.

**Закреплённые NDK или buildToolsVersion ниже 30.** Очень малая доля долгоживущих проектов закрепляет `buildToolsVersion "29.0.3"` в `android/app/build.gradle`. `background_fetch` 1.6 собирался против build tools Android 14 и не слинкуется с символами `JobService` ниже 30. Уберите закрепление или поднимите его до `34.0.0`.

## Смежное чтение

Миграция на AndroidX -- вторая половина того, почему сборки Flutter Android ломаются на старых проектах: см. [конфликт AndroidX при сборке Flutter Android](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/) о поведении manifest merger и Jetifier в деталях. Если падает не сборка, а `flutter pub get`, [version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) разбирает чтение цепочки "because" решателя ограничений. iOS-аналог многих тех же симптомов живёт в [Failed to build iOS app с Xcode 16 и Flutter 3.x](/ru/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/). А если настоящая Android-неудача -- это командная строка Gradle, а не manifest merger, [Gradle build failed to produce an .apk file в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) описывает те же шаги диагностики с путями, специфичными для MAUI, но заметки о кеше AGP применимы так же.

## Источники

- [Пакет `background_fetch` на pub.dev](https://pub.dev/packages/background_fetch)
- [Руководство по установке Android для `flutter_background_fetch`](https://github.com/transistorsoft/flutter_background_fetch/blob/master/help/INSTALL-ANDROID.md)
- [Справочник API `JobScheduler` Android (добавлен в API 21)](https://developer.android.com/reference/android/app/job/JobScheduler)
- [Документация manifest merger Android Gradle Plugin](https://developer.android.com/build/manage-manifests)
- [flutter/flutter#177141: Flutter Gradle plugin перезаписывает явный `minSdk`](https://github.com/flutter/flutter/issues/177141)
- [Release notes Flutter 3.16: значение `minSdkVersion` по умолчанию поднято до 21](https://docs.flutter.dev/release/release-notes/release-notes-3.16.0)

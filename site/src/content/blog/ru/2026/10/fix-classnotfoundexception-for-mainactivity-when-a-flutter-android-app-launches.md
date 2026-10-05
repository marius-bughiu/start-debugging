---
title: "Исправление: ClassNotFoundException для MainActivity при запуске Android-приложения на Flutter"
description: ".MainActivity в манифесте разрешается относительно namespace из Gradle, а класса с таким именем в APK нет. Приведите namespace, строку package в Kotlin и манифест к одному значению."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "ru"
translationOf: "2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches"
translatedBy: "claude"
translationDate: 2026-10-06
---

Класс activity, указанный в объединённом `AndroidManifest.xml`, отсутствует в dex-файлах APK. В приложении на Flutter это почти всегда означает, что при переименовании разошлось одно из трёх значений: `namespace` в `android/app/build.gradle.kts` (относительно него разрешается `.MainActivity` в манифесте), строка `package` в начале `MainActivity.kt` или набор исходников flavor, в котором лежит файл. Сделайте строку `package` равной `namespace`, не трогайте `applicationId`, если вам действительно не нужна новая идентичность в магазине, затем выполните `flutter clean` и пересоберите проект. Папка, в которой лежит файл `.kt`, значения не имеет.

Всё описанное ниже воспроизведено на macOS с Flutter 3.44.8 (Dart 3.12.2), чей шаблон `flutter create` фиксирует AGP 9.0.1, Kotlin 2.3.20 и Gradle 9.1.0, на эмуляторе Android 16 (API 36) arm64. Каждый сценарий собирался через `flutter build apk`, проверялся с помощью `aapt2` и `dexdump` из build-tools 36.1.0 и запускался через `adb shell am start`.

## Ошибка в контексте

Вот падение из моего воспроизведения после изменения только `namespace` (пути сокращены):

```text
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.RuntimeException: Unable to instantiate activity ComponentInfo{com.example.clsrepro/com.acme.shop.MainActivity}: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[[zip file "/data/app/~~.../com.example.clsrepro-.../base.apk"],nativeLibraryDirectories=[/data/app/~~.../lib/arm64, /system/lib64, /system_ext/lib64]]
E AndroidRuntime: Caused by: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[...]
```

Внимательно прочитайте часть `ComponentInfo{A/B}`: она подсказывает, какое значение неверно. `A` это идентификатор приложения, под которым оно установлено. `B` это полное имя класса, экземпляр которого пыталась создать система. Если `B` не соответствует ни одному классу в вашем Kotlin-коде, манифест и код расходятся. Сборка проходит успешно, APK устанавливается, а приложение падает до запуска движка Flutter, поэтому ни ваш Dart-код, ни журналирование не выполняются. Трассировка стека находится в `adb logcat -b crash`.

## Почему класса нет

Android запускает приложение, считывая `android:name` activity-лаунчера из объединённого манифеста и загружая класс с точно таким именем из `classes*.dex` в APK. Шаблон Flutter записывает его в сокращённой форме:

```xml
<!-- android/app/src/main/AndroidManifest.xml, Flutter 3.44.8 template -->
<activity
    android:name=".MainActivity"
    android:exported="true"
    ... >
```

Имя, начинающееся с точки, дописывается к `namespace` модуля из `build.gradle.kts`, а не к `applicationId` и не к пакету, который объявлен в вашем Kotlin-файле. Класс, попадающий в dex, получает имя по строке `package` в `MainActivity.kt`. Ничто в сборке не проверяет, что эти два значения совпадают, поэтому получить падение можно тремя способами:

1. **Изменился `namespace`, а строка `package` в Kotlin осталась прежней.** Манифест теперь указывает на `<new namespace>.MainActivity`, а в dex по-прежнему лежит `<old package>.MainActivity`.
2. **Изменилась строка `package` в Kotlin, а `namespace` остался прежним.** Зеркальный вариант пункта 1.
3. **Класс вообще не компилируется в этот вариант.** Обычно `MainActivity.kt` перенесли в набор исходников flavor (`src/free/kotlin`) и собрали другой flavor, либо файл удалили при повторной генерации папки `android/`.

Дело не в R8. Этап обработки ресурсов (AAPT2) генерирует правило keep для каждого класса, упомянутого в манифесте, поэтому release-сборка не может вырезать `MainActivity`. Подробнее об этом ниже.

## Минимальное воспроизведение

Начните с чистого шаблона и измените одну строку:

```bash
# Flutter 3.44.8, AGP 9.0.1
flutter create --org com.example --platforms android clsrepro
cd clsrepro
```

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8 template, AGP 9.0.1
android {
    namespace = "com.acme.shop"          // was "com.example.clsrepro"
    // ...
    defaultConfig {
        applicationId = "com.example.clsrepro"
        // ...
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/example/clsrepro/MainActivity.kt, unchanged
package com.example.clsrepro

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

`flutter build apk --debug` завершается успешно. Вот что на самом деле лежит внутри APK и что происходило при запуске для каждого опробованного варианта:

| Сценарий | `android:name` в манифесте (объединённом) | Класс в dex | Результат |
|---|---|---|---|
| Исходный шаблон | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | работает |
| Изменён только `namespace` | `com.acme.shop.MainActivity` | `com.example.clsrepro.MainActivity` | **ClassNotFoundException** |
| Изменён только `applicationId` | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | работает (установлено как `com.acme.shop`) |
| Изменена только строка `package` в Kotlin | `com.example.clsrepro.MainActivity` | `com.acme.shop.MainActivity` | **ClassNotFoundException** |
| Изменены `namespace` и строка `package`, файл остался в старой папке | `com.acme.shop.MainActivity` | `com.acme.shop.MainActivity` | работает |
| `MainActivity.kt` в `src/free/kotlin`, flavor `free` | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | работает |
| то же, flavor `paid` | `com.example.clsrepro.MainActivity` | (нет) | **ClassNotFoundException** |
| Исходный шаблон, `--release` (R8 включён) | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | работает |

На две строки стоит посмотреть внимательно. Изменение только `applicationId` безвредно, потому что имя класса от него никогда не зависело. А переносить файл под новый пакет не обязательно: Kotlin не требует, чтобы каталог соответствовал объявлению `package`, поэтому вариант, где файл остался в `com/example/clsrepro/`, работает без проблем. Большинство руководств "как переименовать пакет Flutter" советуют сначала перенести папки, и именно этот шаг значит меньше всего.

## Исправление по шагам

### 1. Считайте три значения из собранного APK, а не из исходников

Исходники могут обманывать (несохранённый редактор, переопределение во flavor, плейсхолдер в манифесте). APK не обманывает. Когда build-tools из Android SDK находятся в `PATH`:

```bash
# Android SDK build-tools 36.1.0, after flutter build apk --debug
APK=build/app/outputs/flutter-apk/app-debug.apk

# 1. The application ID it installs as
aapt2 dump packagename $APK

# 2. The activity class the manifest asks for
aapt2 dump xmltree --file AndroidManifest.xml $APK | grep -A2 "E: activity" | grep android:name

# 3. The MainActivity classes that actually exist
unzip -o -q $APK 'classes*.dex' -d /tmp/dex
for d in /tmp/dex/classes*.dex; do dexdump $d | grep "Class descriptor" | grep MainActivity; done
```

На сломанном воспроизведении с `namespace` шаг 2 вывел `com.acme.shop.MainActivity`, а шаг 3 вывел `Lcom/example/clsrepro/MainActivity;`. Если шаг 3 ничего не выводит, это случай "класс не компилируется в этот вариант"; переходите к шагу 4.

### 2. Приведите строку `package` в Kotlin в соответствие с `namespace`

Решите, в каком имени должен жить ваш код, и задайте его в обоих местах:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1
android {
    namespace = "com.acme.shop"
    defaultConfig {
        applicationId = "com.acme.shop"   // only if you want a new store identity, see below
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/acme/shop/MainActivity.kt, Flutter 3.44.8
package com.acme.shop

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

Для порядка можно перенести файл в `kotlin/com/acme/shop/`. Для Kotlin это необязательно. Если ваша activity написана на Java (`MainActivity.java`, что часто встречается в старых проектах Flutter), перенесите и её: соглашения Java и рефакторинги IDE ожидают, что каталог соответствует пакету.

Если вы не хотите трогать `namespace`, можно вместо этого указать в манифесте полное имя (`android:name="com.example.clsrepro.MainActivity"`). Это работает, но скрывает расхождение, а не устраняет его, и при следующем изменении `namespace` имя за вами не переедет.

### 3. Найдите остатки старого имени

Переименование, пропустившее хотя бы один файл, приводит именно к этому падению. Ищите по всему дереву `android/`, включая манифесты других наборов исходников (`src/debug/AndroidManifest.xml`, `src/profile/AndroidManifest.xml`) и любые другие файлы Kotlin или Java, объявляющие старый пакет:

```bash
# from the Flutter project root
grep -rn "com.example.clsrepro" android/ --include='*.kt' --include='*.java' --include='*.xml' --include='*.kts' --include='*.gradle'
```

Собственные подклассы `Application`, а также `BroadcastReceiver` и `Service`, объявленные с ведущей точкой, разрешаются относительно `namespace` точно так же, поэтому падают с тем же исключением (в сообщении просто будет другой класс, а для `Application` текст будет "Unable to instantiate application").

### 4. Если класса нет совсем, исправьте набор исходников

Когда `dexdump` не показывает никакого `MainActivity`, выясните, где лежит файл:

```bash
find android/app/src -name 'MainActivity.*'
```

Всё, что находится в `src/main/`, компилируется в каждый вариант. Всё, что находится в `src/<flavor>/` или `src/<buildType>/`, компилируется только для соответствующего варианта. В моём воспроизведении размещение `MainActivity.kt` в `src/free/kotlin` и запуск `flutter run --flavor paid` дали `Didn't find class "com.example.clsrepro.MainActivity"` под идентификатором приложения `com.example.clsrepro.paid`. Либо верните файл в `src/main/kotlin`, либо дайте каждому flavor собственную копию с тем же пакетом. Если файл просто пропал (папку `android/` сгенерировали заново), создайте его заново по шаблону выше.

### 5. Очистите и переустановите

```bash
# Flutter 3.44.8
flutter clean
flutter pub get
flutter run
```

Устаревшие промежуточные файлы могут сохранить старый dex после переименования, а старая установка под прежним идентификатором приложения может по-прежнему владеть иконкой лаунчера, на которую вы нажимаете. Если вы изменили `applicationId`, удалите старый пакет (`adb uninstall com.example.clsrepro`), чтобы не продолжать тестировать предыдущую сборку.

## Изменение applicationId и namespace

Эти два значения отвечают на разные вопросы, и большинство падений возникает, когда их считают одним и тем же:

- `applicationId` это идентичность на устройстве и в Google Play. Его изменение после публикации с точки зрения Play создаёт другое приложение. На имена классов он никогда не влияет.
- `namespace` это пакет для генерируемых классов `R` и `BuildConfig` и основа для всех сокращённых имён классов в манифесте. Он касается только кода.

Документация Android рекомендует всегда задавать `applicationId` явно, потому что при его отсутствии используется `namespace`, и тогда переименование на уровне кода незаметно меняет и вашу идентичность в магазине. Шаблон Flutter уже задаёт оба значения. Если вам нужен только новый bundle ID для новой страницы в магазине, измените `applicationId` и больше ничего: это единственное переименование в таблице выше, которое не может вызвать это падение.

Переименование самого класса activity после выпуска тоже имеет цену. Документация `<activity>` говорит не менять `android:name` экспортируемой activity после публикации приложения. `MainActivity` во Flutter экспортируется, а ярлыки лаунчера и закреплённые иконки на домашних экранах пользователей ссылаются на компонент по имени класса. Если перенос неизбежен, `<activity-alias>` со старым именем, указывающий на новый класс, сохранит работоспособность существующих ярлыков.

## Release-сборки и R8

Распространённое предположение: R8 удалил `MainActivity` в release-сборке. Этого не происходит, пока класс назван в манифесте. При обработке ресурсов AAPT2 записывает правило keep для каждого компонента, найденного в манифесте. В моей release-сборке файл `build/app/intermediates/aapt_proguard_file/release/processReleaseResources/aapt_rules.txt` содержал:

```text
-keep class com.example.clsrepro.MainActivity { <init>(); }
```

а `mapping.txt` отображал класс сам на себя, без переименования. Release APK запускался нормально. Поэтому если release-сборка падает с этой ошибкой, а debug работает, ищите различия между вариантами (манифест только для release в `src/release/`, набор исходников flavor), прежде чем писать правила ProGuard. Класс, который R8 действительно вырезает, это класс, к которому вы обращаетесь только через рефлексию и никогда не упоминаете в манифесте, и обычно это проявляется позже как `ClassNotFoundException` для этого класса, а не для `MainActivity`.

## Похожие ошибки

- **Ошибка сборки про `io.flutter.app.FlutterActivity` или `FlutterApplication`**: приложение всё ещё использует Android embedding v1. Это проблема миграции, она разобрана в [чек-листе миграции с Flutter 2 на 3.x](/ru/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).
- **Сборка падает до появления APK** (ошибки демона Kotlin или Gradle): до запуска дело не доходит. См. [Daemon compilation failed: null](/ru/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/) и [Timeout waiting to lock journal cache](/ru/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/).
- **`MissingPluginException` на method channel**: activity запустилась нормально, но обработчик зарегистрирован не в том месте. Схема регистрации канала описана в статье о [добавлении платформенного кода без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Связанные материалы

- [Миграция Android-проекта Flutter на AGP 9 со встроенным Kotlin](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/), включая проверку того, что ваш `MainActivity` попал в dex после миграции.
- [Исправление: e: Daemon compilation failed: null в Gradle-сборке Android-приложения на Flutter](/ru/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Как добавить платформенный код во Flutter без плагинов](/ru/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Исправление: Timeout waiting to lock journal cache в сборке Android-приложения на Flutter](/ru/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Источники

- [Configure the app module: namespace and application ID](https://developer.android.com/build/configure-app-module), Android Developers.
- [Элемент `<activity>`, `android:name`](https://developer.android.com/guide/topics/manifest/activity-element#nm), Android Developers.
- [Set the application ID](https://developer.android.com/build/configure-app-module#set-application-id), Android Developers.
- [Shrink, obfuscate, and optimize your app](https://developer.android.com/build/shrink-code), Android Developers.
- [Build and release an Android app](https://docs.flutter.dev/deployment/android), документация Flutter.

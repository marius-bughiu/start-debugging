---
title: "Исправление: e: Daemon compilation failed: null в сборке Flutter Android на Gradle"
description: "В Windows инкрементальная компиляция Kotlin падает, если проект Flutter и кеш pub находятся на разных дисках. Перенесите PUB_CACHE на диск проекта или отключите IC для плагинов из кеша pub."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "ru"
translationOf: "2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build"
translatedBy: "claude"
translationDate: 2026-09-25
---

Это происходит в Windows, когда проект Flutter лежит на одном диске (`D:\`), а кеш pub на другом (`C:\Users\<you>\AppData\Local\Pub\Cache`). Инкрементальный компилятор Kotlin хранит каждый исходный файл плагина как путь относительно папки `android\`. Относительного пути от `D:\` к `C:\` не существует, поэтому `compileDebugKotlin` падает на плагинах вроде `shared_preferences_android`. Лучшее исправление: разместить `PUB_CACHE` на том же диске, что и проекты, затем выполнить `flutter clean` и `flutter pub get`. Если это невозможно, задайте `kotlin.incremental=false` только для подпроектов плагинов (фрагмент ниже). На Kotlin Gradle Plugin 2.3.0 и более старых APK все равно собирается, и ошибка лишь засоряет вывод. Начиная с KGP 2.3.20 (шаблон Flutter 3.44) и KGP 2.4.0 (Flutter 3.47) сборка может завершиться неудачей.

Версии ниже проверены на Flutter 3.47.5 (Dart 3.13.4, AGP 9.1.0, Gradle 9.3.1, KGP 2.4.0), `shared_preferences` 2.5.5 / `shared_preferences_android` 2.4.28 и исходном коде Kotlin Gradle Plugin на тегах с `v1.9.22` по `v2.4.20`.

## Ошибка в контексте

Отчеты в [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) и [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) выглядят так, по одному разу на каждый плагин:

```text
e: Daemon compilation failed: null
java.lang.Exception
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:69)
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:65)
	at org.jetbrains.kotlin.compilerRunner.GradleKotlinCompilerWork.compileWithDaemon(GradleKotlinCompilerWork.kt:244)
	...
Caused by: java.lang.AssertionError: java.lang.Exception: Could not close incremental caches in
  D:\src\my_app\build\shared_preferences_android\kotlin\compileReleaseKotlin\cacheable\caches-jvm\jvm\kotlin:
  class-fq-name-to-source.tab, source-to-classes.tab, internal-name-to-source.tab
	at org.jetbrains.kotlin.incremental.IncrementalCachesManager.close(IncrementalCachesManager.kt:55)
	...
	Suppressed: java.lang.IllegalArgumentException: this and base files have different roots:
	  C:\Users\me\AppData\Local\Pub\Cache\hosted\pub.dev\shared_preferences_android-2.4.28\android\src\main\kotlin\io\flutter\plugins\sharedpreferences\LegacySharedPreferencesPlugin.kt
	  and D:\src\my_app\android.
```

В первой строке стоит `null`, потому что демон оборачивает настоящую ошибку в голый `java.lang.Exception` без сообщения. Полезна последняя строка: `this and base files have different roots`. Если она есть в вашем журнале, эта статья решает вашу проблему. Если нет, переходите к разделу "Похожие ошибки" в конце.

## Почему инкрементальному компилятору Kotlin нужен один диск

Инкрементальная компиляция Kotlin (IC) хранит таблицы соответствий в `build/<module>/kotlin/compile<Variant>Kotlin/cacheable/caches-jvm`. Эти таблицы сопоставляют каждый исходный файл с классами, которые из него получаются. Чтобы кеш сборки Gradle можно было переносить, начиная с Kotlin 1.9.20 эти пути хранятся относительно базового каталога, а не как абсолютные. Вот конвертер из `build-common` в репозитории Kotlin:

```kotlin
// Kotlin build-common, RelocatableFileToPathConverter.kt (unchanged through 2.4.20)
override fun toPath(file: File): String {
    // ...
    // Note: If the given file is located outside `baseDir`, the relative path will start with "../".
    // It's not "clean", but it can work.
    return file.relativeTo(baseDir).invariantSeparatorsPath
}
```

Для исходных файлов `baseDir` это **корневой каталог проекта**, который для приложения Flutter равен `<project>\android`. Плагины Flutter являются подпроектами Gradle, но их исходники лежат в кеше pub, за пределами этой папки. В macOS и Linux это работает, потому что у всех путей общий корень `/`. На моем Mac кеш IC для `shared_preferences_android` действительно содержит такую запись:

```text
../../../../../../../../Users/marius/.pub-cache/hosted/pub.dev/shared_preferences_android-2.4.28/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt
```

В Windows у `D:\src\my_app\android` и `C:\Users\...\Pub\Cache` разные корни. Никакая цепочка `..\` не переведет с одного диска на другой, поэтому `File.relativeTo` выбрасывает `IllegalArgumentException`. Исключение возникает в момент, когда IC записывает свои кеши, поэтому оно проявляется как "Could not close incremental caches", а демон сообщает о нем как "Daemon compilation failed".

Этим же объясняется, почему работают классические обходные пути: "перенесите проект на `C:`", "откатите Kotlin до 1.9.10" (последняя версия до относительных путей) и "падает только с некоторыми плагинами" (через компилятор Kotlin проходят только плагины с исходниками на Kotlin). JetBrains отслеживает первопричину как [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), и задача по-прежнему в статусе "To be discussed". Инженер JetBrains отметил, что тривиальное исправление (`relativeToOrSelf`) приведет к некорректным попаданиям в кеш сборки. Со стороны Flutter это [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), открытая с 2022 года.

Такой же сбой возникает в любой конфигурации, где исходники и корневой проект находятся на разных корнях: виртуальные диски `subst` ([KT-65155](https://youtrack.jetbrains.com/issue/KT-65155)), каталог сборки на RAM-диске или путь WSL вроде `\mnt\d\project` вперемешку с `D:\project`.

## Почему APK иногда все равно собирается

Многие сообщают, что журнал полон строк `e:`, а затем выводится `√ Built build\app\outputs\flutter-apk\app-release.apk`. Другие, особенно начиная с Flutter 3.44, получают настоящий `BUILD FAILED`. Разница в том, какой путь компиляции выбирает Kotlin Gradle Plugin после сбоя демона. Я прочитал это в исходниках KGP на каждом теге:

| Версия KGP | Путь компиляции по умолчанию | Запасной вариант после сбоя демона | Результат для проекта на разных дисках |
| --- | --- | --- | --- |
| от 1.9.20 до 2.3.0 | `GradleKotlinCompilerWork` | `compileInProcess`, который явно **неинкрементальный** ("in-process execution strategy is non-incremental") | Шумный вывод `e:`, APK собирается |
| 2.3.20 и новее | Build Tools API (`kotlin.compiler.runViaBuildToolsApi` по умолчанию `true`) | `performCompilation(IN_PROCESS)` с **той же** инкрементальной конфигурацией, включая `ROOT_PROJECT_DIR` | Запасной путь натыкается на тот же `relativeTo`, сборка может упасть |

Шаблон Flutter фиксирует версию KGP в `android/settings.gradle.kts`, поэтому версия Flutter на момент `flutter create` определяет, в какой строке вы оказались:

| Шаблон Flutter | `templateKotlinGradlePluginVersion` |
| --- | --- |
| 3.35.0 | 2.1.0 |
| 3.38.0, 3.41.0 | 2.2.20 |
| 3.44.0 | 2.3.20 |
| от 3.47.0 до 3.47.5 | 2.4.0 |

Это совпадает с обсуждениями в задачах. В отчетах 2025 года на Flutter 3.32 и 3.35 говорится "APK все равно собирается". В комментариях июня 2026 года пишут "столкнулся с этим после обновления до Flutter 3.44". В отчете августа 2026 года на 3.47.0 с AGP 9.1.0 и KGP 2.4.0 задача `:shared_preferences_android:compileDebugKotlin` роняет сборку на чистом запуске. Эти люди видят не новую ошибку. Просто запасной путь Kotlin, который раньше скрывал старую, больше этого не делает.

## Минимальное воспроизведение

Нужна Windows с двумя дисками (или одним диском `subst`). Оставьте кеш pub по умолчанию на `C:`:

```powershell
# Windows 11, Flutter 3.47.5, default PUB_CACHE on C:
D:
cd \src
flutter create --platforms=android daemon_repro
cd daemon_repro
flutter pub add shared_preferences
flutter build apk --debug
```

Только что созданный проект 3.47.5 получает `com.android.application` 9.1.0, `org.jetbrains.kotlin.android` 2.4.0 и Gradle 9.3.1, при этом IC для Kotlin включена по умолчанию. Без плагина у шаблонного приложения нет ничего за пределами `android\`, что Kotlin должен компилировать, поэтому оно собирается без ошибок. Это объясняет частое наблюдение "сломалось, как только я добавил один пакет".

## Исправление 1: разместите кеш pub на том же диске, что и проекты

Это рекомендуемое исправление. Оно устраняет причину и сохраняет инкрементальную компиляцию везде. Выберите папку на диске, где лежат ваши проекты, укажите на нее `PUB_CACHE` и заново разрешите зависимости:

```powershell
# Windows, any Flutter 3.x: user-level env var, picked up by new shells and IDEs
[Environment]::SetEnvironmentVariable("PUB_CACHE", "D:\PubCache", "User")

# open a NEW terminal (and restart VS Code / Android Studio), then:
cd D:\src\my_app
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter pub get` скачивает пакеты в новый кеш и заново генерирует `.dart_tool\package_config.json` и `.flutter-plugins-dependencies`. Плагин Flutter для Gradle читает пути плагинов из этих файлов, поэтому каждый подпроект плагина теперь указывает на `D:\PubCache\...`. `flutter clean` важен, потому что старые кеши IC в `build\` все еще содержат пути из прежней раскладки. Старый `C:\Users\<you>\AppData\Local\Pub\Cache` после этого можно удалить.

Ограничение этого исправления: если проекты лежат на нескольких дисках, с кешем может совпасть только один из них. Для такого случая используйте исправление 2.

## Исправление 2: отключите инкрементальную компиляцию только для подпроектов плагинов

Плагины из кеша pub между сборками не меняются, поэтому IC на них ничего не экономит. IC окупается в вашем собственном модуле `app`, а его исходники находятся внутри `android\`, так что проблема его не касается. KGP читает `kotlin.incremental` для каждого проекта отдельно, включая extra-свойства проекта, поэтому переключатель можно ограничить. Добавьте это в конец `android/build.gradle.kts`:

```kotlin
// android/build.gradle.kts, Flutter 3.47.5, AGP 9.1.0, KGP 2.4.0
// Kotlin incremental compilation stores source paths relative to this
// directory. Plugins from the pub cache live outside it, which breaks on
// Windows when the cache is on another drive (KT-63983). Turn IC off for
// those subprojects only; the :app module stays incremental.
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        extra["kotlin.incremental"] = "false"
    }
}
```

Для Groovy-файла `android/build.gradle` эквивалент такой:

```groovy
// android/build.gradle, Flutter 3.35 to 3.47
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        ext.set("kotlin.incremental", "false")
    }
}
```

Я проверил это в macOS на проекте воспроизведения 3.47.5, посмотрев, какие модули записывают кеши IC после `flutter clean && flutter build apk --debug`. Без фрагмента существуют и `build/app/kotlin/compileDebugKotlin/cacheable/caches-jvm`, и `build/shared_preferences_android/.../caches-jvm`. С ним остается только кеш `app`, и APK собирается. Вариант на Groovy дал тот же результат. Машины с Windows и вторым диском у меня под рукой нет, поэтому исчезновение сбоя в Windows я сам не видел, но механизм тот же: при отключенной IC KGP не строит инкрементальную конфигурацию, и `RelocatableFileToPathConverter` никто не вызывает.

Два подхода, которые выглядят правильными, **не** работают, и я попробовал оба на 3.47.5:

- `tasks.withType<KotlinCompile>().configureEach { incremental = false }` внутри `subprojects {}`. Собственное конфигурационное действие KGP позже выполняет `task.incremental = propertiesProvider.incrementalJvm ?: true` и перезаписывает ваше значение. Проверка через `doFirst` вывела `incremental=true`.
- Обертка того же кода в `afterEvaluate {}`. Результат тот же: кеши все равно записывались.

Установка свойства, которое читает сам KGP, остается единственным переключателем на уровне модуля, который не перезаписывается.

Зависимость по пути внутри вашего репозитория (`path: ../packages/my_plugin`) тоже находится за пределами `android\`, поэтому фрагмент отключает IC и для нее. Это стоит полной перекомпиляции Kotlin-кода этого плагина при каждой сборке, обычно секунда или две. Если это важно, сузьте проверку до путей кеша pub, например `projectDir.canonicalPath.contains("Pub${File.separator}Cache")`.

## Исправление 3: отключите инкрементальную компиляцию Kotlin глобально

Самое грубое исправление, и именно его чаще всего цитируют в обсуждениях. В `android/gradle.properties`:

```properties
# android/gradle.properties, any Flutter / KGP version
kotlin.incremental=false
```

Оно работает, и я убедился, что после этого папка `caches-jvm` не создается ни для одного модуля. Цена в том, что Kotlin-код вашего модуля `app` тоже перекомпилируется с нуля при каждой сборке. Для единственного `MainActivity.kt` в шаблоне Flutter это неважно. Для приложения с большим объемом нативного Kotlin (каналы платформы, виджет, модуль Wear OS) это накапливается во время `flutter run`. В таком случае предпочтите исправление 1 или 2.

## Чего делать не стоит

- **Не откатывайте KGP до 1.9.10.** Это последняя версия до относительных путей, поэтому сбой исчезает. Но Flutter 3.47 отклоняет KGP ниже 2.2.20, а AGP 9 требует современного KGP, так что вы привяжете весь набор инструментов Android к 2023 году.
- **Не задавайте `kotlin.compiler.runViaBuildToolsApi=false`, чтобы вернуть старое поведение "APK все равно собирается".** В KGP 2.4 это свойство помечено как устаревшее (KT-85433, "non-BTA JVM compiler invocation is deprecated"), и сбой по-прежнему пишется в журнал при каждой сборке. Это лишь прячет проблему до тех пор, пока следующая версия KGP не удалит свойство.
- **Не задавайте `kotlin.daemon.useFallbackStrategy=false`.** Это превращает случай "APK все равно собирается" в жесткий сбой и на старых версиях KGP.
- **Не переносите Flutter SDK.** Расположение SDK здесь не имеет значения. Плагин Flutter для Gradle подключается как included build со своим корнем, и его исходники лежат рядом с ним. Важно только расхождение дисков кеша pub и проекта.

## Похожие ошибки

Не каждая строка `Daemon compilation failed` означает эту ошибку. Проверьте строки `Caused by` и `Suppressed`:

- **`Daemon compilation failed: Could not connect to Kotlin compile daemon`**. Демон не запустился или умер, часто из-за вмешательства антивируса или нехватки памяти. Выполните `cd android; .\gradlew --stop`, затем соберите снова. На старых версиях KGP запасной путь компилирует без демона, поэтому обычно эта ошибка безвредна.
- **`OutOfMemoryError` в демоне или Gradle**. Увеличьте `kotlin.daemon.jvmargs` и `org.gradle.jvmargs` в `gradle.properties`, см. [flutter/flutter#133371](https://github.com/flutter/flutter/issues/133371).
- **`Module was compiled with an incompatible version of Kotlin`**. Плагин собран с более новой версией метаданных Kotlin, чем ваш KGP. Это несовпадение версий, а не проблема IC, и оно разобрано в [руководстве по миграции на AGP 9](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- **Общая ошибка `Gradle task assembleDebug failed with exit code 1`** без строк демона Kotlin. Начните с [общего чек-листа по assembleDebug](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

Необработанные журналы демона лежат в `android\.kotlin\errors\errors-<timestamp>.log` и `%TEMP%\kotlin-daemon.*.log`. Ищите в них `different roots`, если вывод консоли обрезан.

## Связанные материалы

- [Миграция Android-проекта Flutter на AGP 9 со встроенным Kotlin](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) объясняет шаблон с AGP 9.1 / KGP 2.4, который превратил это предупреждение в сбой.
- [Исправление: Gradle task assembleDebug failed with exit code 1 во Flutter](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) это обзорная статья о сбоях сборки Android.
- [Исправление: A restricted method in java.lang.System has been called в сборке Flutter на Gradle](/ru/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/), еще одно громкое сообщение Gradle, для которого нужно решить, фатально ли оно.
- [Исправление: flutter doctor --android-licenses падает с cmdline-tools 23](/ru/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) о другой частой в этом месяце проблеме с инструментами Android в Windows.
- [Отладка Flutter iOS из Windows](/ru/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/), если Windows ваша основная машина для Flutter.

## Источники

- [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) (открыта), включая воспроизведение от 2026-08-16 на Flutter 3.47.0, AGP 9.1.0, KGP 2.4.0, и [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), задача, отслеживающая проблему разных дисков.
- [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) и [flutter/flutter#170534](https://github.com/flutter/flutter/issues/170534), более ранние отчеты с полным стеком.
- [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), [KT-65155](https://youtrack.jetbrains.com/issue/KT-65155) и [KT-80077](https://youtrack.jetbrains.com/issue/KT-80077) в трекере Kotlin.
- Исходный код Kotlin: [`RelocatableFileToPathConverter.kt`](https://github.com/JetBrains/kotlin/blob/master/build-common/src/org/jetbrains/kotlin/incremental/storage/RelocatableFileToPathConverter.kt), `GradleKotlinCompilerWork.kt` и `btapi/BuildToolsApiCompilationWork.kt` в `libraries/tools/kotlin-gradle-plugin`, а также `PropertiesProvider.kt` / `KotlinCompileConfig.kt` на тегах `v2.3.0`, `v2.3.20` и `v2.4.0`.
- Исходный код Flutter: `packages/flutter_tools/lib/src/android/gradle_utils.dart` (`templateKotlinGradlePluginVersion`) на тегах с 3.35.0 по 3.47.5.
- [Kotlin Gradle plugin compilation and caches](https://kotlinlang.org/docs/gradle-compilation-and-caches.html) на kotlinlang.org, о `kotlin.incremental`.
- [Environment variables for pub](https://dart.dev/tools/pub/environment-variables) на dart.dev, о `PUB_CACHE`.

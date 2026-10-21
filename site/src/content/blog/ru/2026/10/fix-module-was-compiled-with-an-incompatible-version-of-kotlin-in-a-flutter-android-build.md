---
title: "Исправление: Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is X, expected version is Y (Flutter Android)"
description: "Зависимость собрана с версией Kotlin, которая как минимум на две минорные версии новее компилятора вашей сборки. Поднимите версию org.jetbrains.kotlin.android в settings.gradle.kts до X минус один или выше либо закрепите зависимость на старой версии."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "kotlin"
  - "gradle"
lang: "ru"
translationOf: "2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-21
---

Коротко: какая-то библиотека в classpath вашего Android-проекта (очень часто это более новый `kotlin-stdlib`, подтянутый транзитивно) скомпилирована версией Kotlin, которая как минимум на две минорные версии опережает компилятор, реально работающий в вашей сборке. Компилятор читает метаданные только на одну минорную версию вперёд. Поднимите версию `org.jetbrains.kotlin.android` в `android/settings.gradle.kts` как минимум до "X минус одна минорная версия" (для метаданных 2.4.0 это KGP 2.3.x или новее) и пересоберите проект. Всё описанное ниже воспроизведено на Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0 и артефактах Kotlin 2.4.21.

## Ошибка в контексте

При `flutter build apk` или `flutter run` задача `compileDebugKotlin` (или `compileReleaseKotlin`) завершается ошибкой, по одной строке на каждый файл модуля Kotlin в проблемном jar:

```text
> Task :app:compileDebugKotlin FAILED
e: file:///Users/me/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.4.21/.../kotlin-stdlib-2.4.21.jar!/META-INF/kotlin-stdlib.kotlin_module Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.4.0, expected version is 2.2.0.
e: file:///.../MainActivity.kt:6:19 Unresolved reference 'listOf'.

FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details
```

Если проблемный код находится в плагине, а не в вашем приложении, то же несоответствие сообщается для каждого класса, а формулировка новее и понятнее:

```text
> Task :shared_preferences_android:compileDebugKotlin FAILED
e: Incompatible classes were found in dependencies. Remove them from the classpath or use '-Xskip-metadata-version-check' to suppress errors
e: .../shared_preferences_android-2.5.1/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt:47:5 Class 'kotlin.Unit' was compiled with an incompatible version of Kotlin. The actual metadata version is 2.4.0, but the compiler version 2.2.0 can read versions up to 2.3.0.
```

Последующие ошибки "Unresolved reference" (`listOf`, `startsWith`, `it`) являются шумом. Когда компилятор отказывается загружать стандартную библиотеку, все символы stdlib становятся неразрешёнными. Исправьте первую ошибку, и остальные исчезнут.

## Почему компилятор отказывается читать более новые метаданные

Каждый class-файл Kotlin/JVM несёт аннотацию `@kotlin.Metadata`, а в каждом jar есть файл `META-INF/*.kotlin_module`, и оба помечены версией метаданных компилятора, который их создал. [Принципы эволюции](https://kotlinlang.org/docs/kotlin-evolution-principles.html) Kotlin гарантируют обратную совместимость (новый компилятор читает все более старые бинарные файлы), но прямую совместимость только по принципу best effort и только со следующим языковым релизом, "but not later ones". Компилятор проверяет это правило заранее: компилятор 2.2 принимает метаданные до 2.3.0 и отклоняет 2.4.0. Именно это и говорит новое сообщение: "the compiler version 2.2.0 can read versions up to 2.3.0".

Итак, два числа в ошибке означают следующее:

- **"binary version of its metadata is X"**: версия Kotlin, которой скомпилирована библиотека из jar, указанного в пути.
- **"expected version is Y"**: компилятор Kotlin, который запускает ваша сборка Gradle, он берётся из Kotlin Gradle Plugin (KGP) в classpath сборки. Это не Kotlin, установленный в Android Studio, и не обязательно та версия, которую вы указали.

Во Flutter-приложениях причиной почти всегда оказывается одно из следующего, в порядке частоты:

1. **Обновление плагина или библиотеки AndroidX/Google** транзитивно подтягивает более новый `kotlin-stdlib`. Разрешение конфликтов в Gradle выбирает самый высокий запрошенный stdlib, поэтому одна современная зависимость обновляет его для всего модуля.
2. **KGP в вашем проекте устарел**, как правило потому, что приложение создано много лет назад, а `settings.gradle.kts` (или `ext.kotlin_version` в `android/build.gradle` до Flutter 3.16) так и не обновили.
3. **Плагин, скомпилированный новым Kotlin, поставляет готовый AAR или jar** с классами Kotlin (часто встречается у плагинов-обёрток над SDK: карты, платежи, аналитика).

## Минимальное воспроизведение

Возьмите новый проект Flutter 3.44.8, понизьте KGP и добавьте одну зависимость, собранную с Kotlin 2.4:

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false // template ships 2.3.20
}
```

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44.8
dependencies {
    // Stands in for any library compiled with Kotlin 2.4.x
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.4.21")
}
```

```kotlin
// android/app/src/main/kotlin/com/example/kapp/MainActivity.kt -- Kotlin source that touches stdlib
package com.example.kapp

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    val doubled = listOf(1, 2, 3).map { it * 2 }
}
```

Перед тем как менять версии, стоит знать две детали из этого воспроизведения.

**Объявленная вами версия может не совпадать с работающей.** Я объявил KGP 2.0.21, но ошибка говорит "expected version is 2.2.0", а Flutter Gradle Plugin предупредил "Flutter support for your project's Kotlin version (2.2.10) will soon be dropped". AGP 9.0.1 объявляет runtime-зависимость от `kotlin-gradle-plugin:2.2.10`, и Gradle разрешает classpath сборки до самой высокой запрошенной версии. Объявление KGP *ниже* той, которую приносит AGP, не имеет никакого эффекта. Читайте "expected version" из ошибки, а не из файла настроек.

**Ошибка срабатывает, только когда код Kotlin обращается к более новым классам.** Со стандартным однострочным `class MainActivity : FlutterActivity()` тот же classpath собирался нормально, потому что ничто не заставляло компилятор десериализовать метаданные stdlib. Добавление `listOf(...)` всё сломало. Поэтому ошибка и появляется "из ниоткуда", когда вы добавляете несколько строк Kotlin в `MainActivity` или в обработчик method channel, хотя обновление зависимости произошло неделями раньше.

## Исправление 1: поднять Kotlin Gradle Plugin (рекомендуется)

Правило такое: минорная версия KGP должна быть как минимум на единицу меньше минорной версии метаданных библиотеки. Для метаданных 2.4.0 это 2.3.x или новее; точное совпадение (2.4.x) является самым безопасным выбором.

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}
```

С 2.3.20 то же воспроизведение собралось без ошибок (`BUILD SUCCESSFUL`): одной минорной версии запаса достаточно. Действуйте в таком порядке:

1. Прочитайте X из ошибки ("binary version of its metadata is 2.4.0").
2. Откройте `android/settings.gradle.kts` (или `settings.gradle`) и установите версию `org.jetbrains.kotlin.android` равной X минус одна минорная версия или новее. В проектах, созданных до Flutter 3.16, версия находится в `android/build.gradle` как `ext.kotlin_version = '...'` внутри `buildscript`; меняйте её там.
3. Проверьте новый KGP на совместимость с вашими AGP и Gradle по [таблице совместимости Kotlin Gradle plugin](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin). KGP 2.3.20 поддерживает Gradle от 7.6.3 до 9.3.0 и AGP от 8.2.2 до 9.0.0; KGP 2.4.20 требует AGP 8.5.2 или новее. В старых проектах Flutter на AGP 7.x AGP и Gradle придётся обновить в том же изменении.
4. Выполните `flutter clean` и пересоберите проект, чтобы не остались кешированные результаты Gradle от старого компилятора.

Это подтверждает и собственный инструментарий Flutter 3.44.8: шаблон поставляется с KGP 2.3.20, а Flutter Gradle Plugin предупреждает при версии ниже 2.2.20 и выдаёт ошибку ниже 2.0.0 (`warnKGPVersion` и `errorKGPVersion` в `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt`). Если вы всё ещё на проекте с Kotlin 1.x, вы столкнётесь с этой ошибкой почти с каждым актуальным релизом AndroidX, так что это обновление всё равно придётся сделать.

## Исправление 2: если ошибка в модуле плагина, всё равно исправляйте в приложении

Если упала задача `:some_plugin:compileReleaseKotlin`, возникает желание обвинить `build.gradle` плагина. Воспроизведение показывает, почему это не тот файл. `shared_preferences_android` 2.5.1 объявляет собственный KGP в своём buildscript:

```kotlin
// ~/.pub-cache/hosted/pub.dev/shared_preferences_android-2.5.1/android/build.gradle.kts (excerpt)
val kotlinVersion = "2.3.0"
classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
```

И всё же ошибка говорила "the compiler version 2.2.0". Плагины являются подпроектами сборки Gradle вашего приложения, и компилирует их тот KGP, который уже загружен корневой сборкой (из `settings.gradle.kts`, возможно обновлённый AGP). Объявление в плагине не побеждает. Поэтому:

1. Поднимите KGP в `android/settings.gradle.kts` вашего приложения, в точности как в исправлении 1.
2. Если сам плагин закрепляет старый Kotlin так, что ошибка всё равно остаётся, обновите плагин (`flutter pub upgrade <name>` или поднимите его ограничение в `pubspec.yaml`). Никогда не редактируйте файлы в `~/.pub-cache`: `pub get` их перезапишет.

## Исправление 3: найти и закрепить зависимость, которая принесла новый Kotlin

Иногда поднять KGP прямо сейчас нельзя (релизная ветка, замороженный образ CI). Тогда найдите, кто запросил новый stdlib, и закрепите эту зависимость на старой версии. Из папки `android/`:

```bash
./gradlew :app:dependencyInsight --dependency org.jetbrains.kotlin:kotlin-stdlib --configuration releaseRuntimeClasspath
```

В моём воспроизведении раздел "Selection reasons" объяснил всю историю одной строкой:

```text
- By conflict resolution: between versions 2.4.21, 2.2.10, 1.8.22, 2.0.21, 1.6.21, 1.7.10, 1.8.10, 1.3.20, 1.8.20, 1.9.24, 2.0.0, 1.9.25 and 2.0.20
```

Ниже каждая строка `org.jetbrains.kotlin:kotlin-stdlib:1.x -> 2.4.21` вложена под зависимость, которая её запросила. Поднимайтесь по дереву к той, что просит 2.4.x, и затем понизьте либо эту библиотеку, либо плагин Flutter, который её приносит. Для транзитивной зависимости плагина выполните ту же команду для проекта плагина (`:plugin_name:dependencyInsight`). Закрепление является краткосрочной мерой: автор библиотеки перешёл на новый Kotlin не просто так, и следующее обновление чего-либо ещё вернёт вас сюда же.

Не "исправляйте" проблему принудительным понижением `kotlin-stdlib` через `resolutionStrategy.force(...)`. Библиотека скомпилирована с более новым API stdlib и может вызывать функции, которых нет в старом, и тогда ошибка компиляции превращается в `NoSuchMethodError` во время выполнения.

## Исправление 4: -Xskip-metadata-version-check (крайняя мера)

Флаг предлагает само сообщение компилятора, и он действительно работает:

```kotlin
// android/app/build.gradle.kts -- Kotlin compiler option, use only temporarily
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
```

С ним воспроизведение собралось. Это флаг `-X`, то есть неподдерживаемый, и он лишь отключает проверку безопасности: компилятор затем читает метаданные в неизвестном ему формате. Если новая библиотека использует возможность языка, закодированную так, что ваш компилятор не может её интерпретировать, вместо понятной ошибки вы получите неверные сигнатуры или падение компилятора. Кроме того, он действует только на модуль, в который вы его добавили, так что проблемный модуль плагина всё равно не соберётся. Используйте его, чтобы разблокировать сборку для срочного исправления, и уберите, когда поднимете KGP.

## Похожие ошибки, которые приводят сюда

- **`Your project requires a newer version of the Kotlin Gradle plugin`**: это собственная предварительная проверка Flutter, а не компилятор Kotlin. У неё другой путь исправления, он описан в [статье об ошибке устаревшей версии KGP](/ru/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).
- **`Daemon compilation failed: null`**: сбой инкрементальной компиляции внутри демона Kotlin, а не несоответствие версий. См. [исправление Daemon compilation failed: null](/ru/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).
- **Ошибки Kotlin сразу после перехода на AGP 9**: если сборка сломалась после обновления AGP и вы видите `Cannot add extension with name 'kotlin'`, это миграция на встроенный Kotlin. [Руководство по миграции на AGP 9](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) разбирает её, включая причину, по которой строку KGP в `settings.gradle.kts` нужно сохранить.
- **`Execution failed for task ':app:compileFlutterBuildDebug'` или просто `exit code 1`**: итоговая строка, которую печатает Flutter, скрывает реальную ошибку Gradle. Прокрутите вывод выше или перезапустите с `--verbose`; [руководство по assembleDebug и exit code 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) показывает, куда смотреть.
- **"Expected version is 1.x" в проекте, который, как вам кажется, на Kotlin 2**: вы читаете не тот файл. Поищите оставшийся `ext.kotlin_version` в `android/build.gradle` или блок `buildscript` в корневом проекте, который всё ещё добавляет старый `kotlin-gradle-plugin` в classpath.

## Связанные материалы

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)
- [Fix: Daemon compilation failed: null in a Flutter Android Gradle build](/ru/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Fix: Gradle task assembleDebug failed with exit code 1 in Flutter](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Timeout waiting to lock journal cache in a Flutter Android build](/ru/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Источники

- [Kotlin evolution principles: binary compatibility](https://kotlinlang.org/docs/kotlin-evolution-principles.html)
- [Kotlin Gradle plugin: compatibility with Gradle and AGP](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin)
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes) (runtime-зависимость от KGP 2.2.10)
- [Flutter: Kotlin and Gradle version requirements](https://docs.flutter.dev/release/breaking-changes/kotlin-version)
- [flutter/flutter#179253](https://github.com/flutter/flutter/issues/179253), то же несоответствие, о котором сообщалось для метаданных 2.2.0 при ожидаемой 1.8.0

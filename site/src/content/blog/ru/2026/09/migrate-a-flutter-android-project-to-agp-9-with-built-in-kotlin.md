---
title: "Миграция Android-проекта Flutter на AGP 9 со встроенным Kotlin"
description: "Полный путь от Flutter-приложения на AGP 8, которое применяет kotlin-android, до AGP 9.1 с android.builtInKotlin=true на Flutter 3.47. Каждый шаг я собрал и проверил, включая две правки, которые выглядят необязательными, но таковыми не являются: kotlinOptions вызывает ошибку компиляции при KGP 2.2+, а строку KGP в settings.gradle.kts нужно оставить."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "ru"
translationOf: "2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin"
translatedBy: "claude"
translationDate: 2026-09-18
---

Для Flutter-приложения, созданного до Flutter 3.44, миграция сводится к четырём правкам: поднять Gradle wrapper до 9.3.1 и AGP до 9.1.0, поднять версию Kotlin Gradle Plugin (KGP) в `settings.gradle.kts` до 2.4.0, но саму строку оставить, заменить `kotlinOptions` на блок верхнего уровня `kotlin { compilerOptions { ... } }` и удалить `id("kotlin-android")` из `app/build.gradle.kts`. После этого можно включить `android.builtInKotlin=true` в `gradle.properties`, что требует Flutter 3.47 или новее и имеет смысл только тогда, когда все плагины, от которых вы зависите, тоже отказались от KGP. Для приложения с актуальными зависимостями закладывайте час, больше, если какой-то плагин всё ещё применяет `kotlin-android`. Заняться этим стоит уже сейчас: Flutter уже отказывается собирать проект с Gradle ниже 8.14 или AGP ниже 8.11.1 и объявил, что полностью уберёт поддержку KGP ([flutter#184837](https://github.com/flutter/flutter/issues/184837)).

Всё описанное ниже я запускал на Flutter 3.47.4 stable (ревизия фреймворка `9584c6713b`, Dart 3.13), OpenJDK 17.0.20 и Android SDK build-tools 36.1, начиная с проекта, устроенного в точности как шаблон `android-kotlin` из Flutter 3.35: AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `id("kotlin-android")` в модуле приложения и блок `kotlinOptions`. Итоговое состояние я также проверил на Flutter 3.44.8. Для каждого шага приведён точный вывод, который я получил.

## Почему от этой миграции больше не уйти

- **Flutter 3.47 требует минимальных версий, которым проект на AGP 8 из 2025 года не соответствует.** `DependencyVersionChecker.kt` в 3.47.4 выдаёт ошибку для Gradle ниже 8.14.0, AGP ниже 8.11.1 и KGP ниже 2.2.20, а предупреждение для версий ниже Gradle 9.1.0, AGP 9.0.1 и KGP 2.3.20. Мой нетронутый проект эпохи 3.35 упал на первой же сборке с `Your project's Gradle version (8.12.0) is lower than Flutter's minimum supported version of 8.14.0`.
- **AGP 9 меняет два значения по умолчанию.** Согласно [примечаниям к выпуску AGP 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes), `android.builtInKotlin` и `android.newDsl` по умолчанию равны `true`. Встроенный Kotlin означает, что AGP сам компилирует Kotlin, а применение `org.jetbrains.kotlin.android` считается ошибкой.
- **Возможность отказаться временна с обеих сторон.** Собственные шаблоны Flutter сейчас поставляются с `android.builtInKotlin=false` и `android.newDsl=false`, но в [обзоре миграции на встроенный Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) сказано, что поддержку KGP уберут в одном из будущих релизов Flutter, а Google сообщает, что лазейка `newDsl=false` исчезнет в AGP 10.
- **К вашим плагинам применяется то же правило.** Как только вы включаете встроенный Kotlin, любой плагин, который всё ещё применяет `kotlin-android`, ломает вашу сборку, а не свой собственный CI. Найти такие плагины заранее и есть основная часть реальной работы.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Gradle wrapper | Flutter 3.47 выдаёт ошибку ниже 8.14; AGP 9.1 требует 9.3.1 | высокая |
| `kotlin-android` в модуле приложения | Падает при включённом встроенном Kotlin | высокая |
| `kotlinOptions { jvmTarget = ... }` | Ошибка компиляции скрипта при KGP 2.2 и новее | высокая |
| Плагины, применяющие KGP | Ломают вашу сборку после `android.builtInKotlin=true` | высокая |
| `android.newDsl=true` | Flutter Gradle Plugin всё ещё приводит к старому DSL, `ClassCastException` | высокая (оставьте `false`) |
| Запись KGP в `settings.gradle.kts` | Если её удалить, Kotlin откатывается до встроенной в AGP версии 2.2.10, ниже минимума Flutter | средняя |
| Проекты на `build.gradle` (Groovy) | Те же правки, другой синтаксис; раскладкам с `buildscript` до 3.16 сначала нужна миграция на декларативные плагины | средняя |

## Что проверить перед началом

- **Flutter 3.47.x на машине и в CI.** Flutter 3.44 добавил поддержку AGP 9 со *отключённым* встроенным Kotlin; включать его поддерживается только начиная с 3.47. Проверьте через `flutter --version`.
- **JDK 17 или новее для Gradle.** AGP 9 требует JDK 17. `flutter doctor -v` показывает, какой JDK Flutter передаёт Gradle; если это JRE или JDK 11, сначала исправьте это (как Flutter выбирает JDK, описано в [ошибке тулчейна JAVA_COMPILER](/ru/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)).
- **Android SDK build-tools 36.0.0 или новее.** Это минимум для AGP 9.
- **Чистое рабочее дерево.** Утилита Flutter сама переписывает `gradle.properties` при первой сборке на 3.44+, поэтому сделайте коммит до начала и посмотрите diff после.
- **Список ваших Android-плагинов.** Достаточно `flutter pub deps --style=compact`. На шаге 6 вы проверите changelog каждого из них на поддержку встроенного Kotlin.

## Шаги миграции

1. **Дайте утилите Flutter добавить два флага отказа, затем проверьте их.** Запустите любую Android-сборку один раз на Flutter 3.44 или новее. Мигратор утилиты допишет оба флага в `android/gradle.properties`, если их там нет. В моём проекте сборка всё равно упала (из-за Gradle 8.12), но файл уже был переписан:

   ```properties
   # android/gradle.properties, written by the Flutter 3.47.4 migrators
   org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError
   android.useAndroidX=true
   # This builtInKotlin flag was added automatically by Flutter migrator
   android.builtInKotlin=false
   # This newDsl flag was added automatically by Flutter migrator
   android.newDsl=false
   ```

   Для проектов-хостов add-to-app мигратор не запускается никогда, потому что хост является обычным Android-проектом. Там обе строки нужно добавить вручную в `gradle.properties` хоста. Проверка: `grep -E 'builtInKotlin|newDsl' android/gradle.properties` выводит обе строки.

2. **Поднимите Gradle wrapper до 9.3.1.** AGP 9.0.x требует Gradle 9.1.0 или новее, а утилиты Flutter сочетают AGP 9.1.x с 9.3.1 или новее, и именно эту версию поставляет шаблон Flutter 3.47:

   ```properties
   # android/gradle/wrapper/gradle-wrapper.properties, Flutter 3.47.4
   distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-all.zip
   ```

   Проверка: `cd android && ./gradlew --version` сообщает `Gradle 9.3.1`.

3. **Поднимите AGP и KGP в `settings.gradle.kts` и оставьте строку Kotlin.** Вот версии, которые записывает `flutter create` в 3.47.4:

   ```kotlin
   // android/settings.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   plugins {
       id("dev.flutter.flutter-plugin-loader") version "1.0.0"
       id("com.android.application") version "9.1.0" apply false
       id("org.jetbrains.kotlin.android") version "2.4.0" apply false
   }
   ```

   Возникает соблазн удалить строку `org.jetbrains.kotlin.android`, ведь смысл миграции в том, чтобы перестать использовать KGP. Не делайте этого. С `apply false` она лишь кладёт эту версию Kotlin в classpath сборки, и встроенный Kotlin компилирует именно ею. Когда я её удалил, AGP 9.1.0 откатился на встроенный Kotlin 2.2.10, и Flutter Gradle Plugin отклонил сборку: `Your project's Kotlin version (2.2.10) is lower than Flutter's minimum supported version of 2.2.20`. Строка важна и пока действует `builtInKotlin=false`, потому что тогда Flutter Gradle Plugin сам применяет `kotlin-android` к каждому Android-подпроекту, который этого не делает, и для этого ему нужен KGP в classpath.

   Проверка: пока никакой. Сборка падает до шага 4.

4. **Замените `kotlinOptions` на DSL `compilerOptions`.** Эта правка многих удивляет, потому что она нужна ещё до того, как вы касаетесь встроенного Kotlin. С AGP 9.1.0, KGP 2.4.0, всё ещё применённым `kotlin-android` и `builtInKotlin=false` моя сборка упала на этапе компиляции скрипта:

   ```text
   Script compilation errors:
     Line 18:     kotlinOptions {
                  ^ 'fun BaseAppModuleExtension.kotlinOptions(configure: Action<DeprecatedKotlinJvmOptions>): Unit' is deprecated. Please migrate to the compilerOptions DSL.
     Line 19:         jvmTarget = JavaVersion.VERSION_11.toString()
                      ^ 'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.
   ```

   [Kotlin 2.2.0 повысил устаревание `kotlinOptions` до ошибки](https://kotlinlang.org/docs/whatsnew22.html), а Flutter 3.47 не даст остаться ниже KGP 2.2.20, так что не существует комбинации версий, при которой `kotlinOptions` выживает. Перенесите JVM target из блока `android {}` в блок верхнего уровня `kotlin {}`:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   android {
       // ...
       compileOptions {
           sourceCompatibility = JavaVersion.VERSION_17
           targetCompatibility = JavaVersion.VERSION_17
       }
       // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <- delete
   }

   kotlin {
       compilerOptions {
           jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
       }
   }
   ```

   Держите `jvmTarget` равным `targetCompatibility`. Старые шаблоны использовали 11, новые используют 17; годится любой вариант, пока оба значения совпадают. Проверка: `flutter build apk --debug` проходит успешно. На этом этапе сборка также выводит `WARNING: Your Android app project: app ... applies the Kotlin Gradle Plugin, which will cause build failures in future versions of Flutter.` Это предупреждение ожидаемо, и именно его убирает шаг 5.

5. **Удалите `kotlin-android` из модуля приложения.** Удалите строку плагина и больше ничего:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4
   plugins {
       id("com.android.application")
       // id("kotlin-android")  <- delete
       // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
       id("dev.flutter.flutter-gradle-plugin")
   }
   ```

   Если ваш модуль приложения использует форму с version catalog, удалять нужно строку `alias(libs.plugins.kotlin.android)`. В Groovy-файле `build.gradle` это `apply plugin: 'kotlin-android'` или `id "kotlin-android"`, а блок `kotlin { compilerOptions { ... } }` из шага 4 является корректным Groovy в том виде, как он написан. Проверка: `flutter build apk --debug` проходит без предупреждения KGP для `app`. Пока `builtInKotlin` остаётся `false`, Flutter Gradle Plugin теперь применяет KGP за вас, поэтому это промежуточное состояние и собирается.

6. **Найдите плагины, которые всё ещё применяют KGP.** Соберите проект ещё раз с `builtInKotlin=false` и прочитайте вывод Gradle. Flutter 3.47 сам их перечисляет:

   ```text
   WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin (KGP): oldplug
   Future versions of Flutter will fail to build if your app uses plugins that apply KGP.
   Please check the changelogs of these plugins and upgrade to a version that supports Built-in Kotlin.
   ```

   Для каждого перечисленного плагина поищите на pub.dev более новую версию, в changelog которой упоминается встроенный Kotlin или AGP 9, и обновитесь. Если такой нет, заведите issue у плагина (в руководстве Flutter для разработчиков приложений есть [шаблон issue](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers#report-incompatible-kotlin-gradle-plugin-usage-to-plugin-authors)) и остановитесь здесь: вы на AGP 9 с отключённым встроенным Kotlin, и это поддерживаемое состояние. Проверка: предупреждение больше не перечисляет ни одного плагина.

7. **Включите встроенный Kotlin.** Только после того, как шаг 6 проходит чисто:

   ```properties
   # android/gradle.properties, Flutter 3.47.4, AGP 9.1.0
   android.builtInKotlin=true
   android.newDsl=false
   ```

   Оставьте `android.newDsl=false`. Проверка: `flutter build apk --debug` проходит без предупреждений KGP, а затем `flutter run` запускает приложение на устройстве или эмуляторе.

## Чек-лист проверки

- `flutter build apk --debug` и `flutter build appbundle --release` оба проходят успешно, и в выводе нет предупреждения `applies the Kotlin Gradle Plugin`.
- Ваш Kotlin-код действительно попал в APK. Я проверял это, потому что встроенный Kotlin идёт другим путём компиляции: распакуйте APK через `unzip` и поищите ваш `MainActivity` в файлах `classes*.dex`. В моём мигрированном проекте `Lnet/sd/app347/MainActivity;` оказался в `classes4.dex`.
- `flutter test` и все наборы `integration_test` по-прежнему проходят на Android-устройстве.
- CI использует ту же версию Flutter и JDK 17. Образ CI, застрявший на Flutter 3.44, собирает проект со включённым встроенным Kotlin, но выводит вводящее в заблуждение сообщение (см. подводные камни).
- `git diff android/` показывает только перечисленные выше файлы. Если мигратор молча переписал что-то ещё, это стоит прочитать до коммита.

## План отката

Миграция обратима на каждом шаге, и самый дешёвый откат частичный. Если после шага 7 ломается плагин, снова установите `android.builtInKotlin=false`: с этим флагом AGP 9 принимает KGP, а Flutter Gradle Plugin снова применяет `kotlin-android` к модулям, которым он нужен, так что возвращать строку `kotlin-android` в модуль приложения не требуется. Полный откат на AGP 8 означает восстановление `settings.gradle.kts` и wrapper из git, но на Flutter 3.47 нельзя опуститься ниже AGP 8.11.1, Gradle 8.14 или KGP 2.2.20, так что "откат" на деле означает AGP 8.11+, а не исходную 8.9. Изменение `kotlin { compilerOptions }` из шага 4 остаётся в любом случае.

## Подводные камни, на которые я наткнулся

**Первая ошибка вообще не про Kotlin.** На немигрированном проекте Flutter 3.47.4 вывел настоящую проблему (Gradle 8.12 ниже 8.14) внутри вывода Gradle, а под ним рамку "Flutter Fix" с текстом `Starting AGP 9+, only the new DSL interface will be read` и предложением отказаться от `android.newDsl`. При этом проект был на AGP 8.9.1. Рамка является эвристикой, которая срабатывает при любой неудаче применения Flutter Gradle Plugin, поэтому сначала читайте раздел `* What went wrong:`, тот же совет, что и в [руководстве по assembleDebug exit code 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**Сообщение об ошибке для оставшегося `kotlin-android` зависит от версии KGP.** С KGP 2.4.0 оно явное:

```text
> Failed to apply plugin 'kotlin-android'.
   > ⛔ Failed to apply plugin 'org.jetbrains.kotlin.android'
     The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0.
     Solution: Remove the 'org.jetbrains.kotlin.android' plugin from this project's build file: app/build.gradle.kts.
```

Со старыми версиями KGP та же ошибка проявляется как `Cannot add extension with name 'kotlin'`, и именно эту форму цитирует большинство ответов на Stack Overflow. Строка `Solution:` полезна, когда виновником является плагин: для моего тестового плагина она указала на `../../oldplug/android/build.gradle.kts`. Для пакета с pub.dev путь указывает внутрь `~/.pub-cache/hosted/pub.dev/<package>-<version>/android/`, и это точно говорит, какой пакет нужно обновить. Не редактируйте файлы в pub cache; они перезаписываются при следующем `pub get`.

**`android.newDsl=true` по-прежнему приводит к жёсткому сбою.** Когда всё остальное было мигрировано, установка этого флага дала `class com.android.build.gradle.internal.dsl.ApplicationExtensionImpl$AgpDecorated_Decorated cannot be cast to class com.android.build.gradle.AbstractAppExtension`. Flutter Gradle Plugin всё ещё читает типы старого DSL ([flutter#180137](https://github.com/flutter/flutter/issues/180137) отслеживает перенос). Оставьте флаг в `false`, пока релиз Flutter не скажет иного, и рассчитывайте, что этот релиз выйдет раньше AGP 10.

**Flutter 3.44 наполовину работает со включённым встроенным Kotlin.** В документации сказано, что `android.builtInKotlin=true` требует 3.47. Я всё равно запустил полностью мигрированный проект на Flutter 3.44.8: APK собрался и `MainActivity` был в dex, но утилита вывела `Applying the Kotlin Android Plugin (KGP) was unsuccessful. KGP was not found on the classpath.` Это сообщение идёт от Flutter Gradle Plugin версии 3.44, который не читает флаг и пытается применить KGP в любом случае. В тривиальном приложении это безвредно, а в журнале CI сбивает с толку, так что считайте 3.47 реальным минимумом, ровно как и задокументировано.

**Проектам до 3.16 сначала нужна более ранняя миграция.** Если в вашем `android/build.gradle` всё ещё есть `buildscript { ext.kotlin_version = '...' }`, а модуль приложения использует `apply from: ".../flutter.gradle"`, описанные выше шаги не ложатся на него напрямую. Сначала выполните [миграцию на декларативные плагины](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply), затем вернитесь к шагу 2. Я не воспроизводил такую раскладку для этой статьи; здесь ориентиром служит документация Flutter. Если же вы застряли на старом сообщении о версии Kotlin, [статья об ошибке версии KGP](/ru/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) объясняет, где эта версия находится в старых раскладках.

**Gradle 9 превращает другие старые предупреждения в ошибки.** Gradle 9 удалил API, которые Gradle 8 лишь пометил устаревшими, поэтому старый плагин может упасть по причинам, не связанным с Kotlin. Если рядом появляется предупреждение JDK 24 вроде `A restricted method in java.lang.System has been called`, ему посвящена [отдельная статья](/ru/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/).

## Измеренные результаты

| Состояние проекта (Flutter 3.47.4, если не указано иное) | Результат |
| --- | --- |
| AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `kotlin-android` | Падает: Gradle ниже 8.14 |
| AGP 9.1.0, KGP 2.4.0, Gradle 9.3.1, `kotlinOptions` оставлен | Падает: ошибки компиляции скрипта |
| То же, `compilerOptions`, `kotlin-android` оставлен, `builtInKotlin=false` | Собирается, предупреждение KGP для `app` |
| То же, `builtInKotlin=true` | Падает: KGP больше не требуется начиная с AGP 9.0 |
| `kotlin-android` удалён, `builtInKotlin=true` | Собирается, 4.0 с инкрементальной сборки |
| Строка KGP удалена из `settings.gradle.kts` | Падает: Kotlin 2.2.10 ниже 2.2.20 |
| Плагин, применяющий KGP, `builtInKotlin=true` | Падает, указывает файл сборки плагина |
| Плагин, применяющий KGP, `builtInKotlin=false` | Собирается, предупреждение перечисляет плагин |
| После миграции, `newDsl=true` | Падает: `ClassCastException` в Flutter Gradle Plugin |
| После миграции, `builtInKotlin=true`, Flutter 3.44.8 | Собирается, вводящее в заблуждение сообщение "KGP was not found" |

## Связанные статьи

- [Исправление: Gradle task assembleDebug failed with exit code 1 в Android-сборке Flutter](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Исправление: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]](/ru/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)
- [Исправление: A restricted method in java.lang.System has been called в Gradle-сборке Flutter](/ru/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/)
- [Исправление: flutter doctor --android-licenses падает с cmdline-tools 23](/ru/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/)
- [Flutter: your project requires a newer version of the Kotlin Gradle plugin](/ru/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)

## Источники

- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) и [руководство для разработчиков приложений](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), документация Flutter.
- [Built-in Kotlin migration for plugin authors](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-plugin-authors), документация Flutter.
- [Примечания к выпуску Android Gradle Plugin 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes): Gradle 9.1.0, JDK 17, зависимость времени выполнения KGP 2.2.10, новые значения по умолчанию.
- [What's new in Kotlin 2.2.0](https://kotlinlang.org/docs/whatsnew22.html): устаревание `kotlinOptions` повышено до ошибки.
- Исходный код Flutter 3.47.4: `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt` (минимальные версии), `FlutterPluginUtils.kt` (`isBuiltInKotlinEnabled`, автоматически применяемый KGP), `lib/src/android/migrations/disable_built_in_kotlin_migration.dart`.
- Issues Flutter [#181383](https://github.com/flutter/flutter/issues/181383), [#183909](https://github.com/flutter/flutter/issues/183909), [#184837](https://github.com/flutter/flutter/issues/184837), [#180137](https://github.com/flutter/flutter/issues/180137).

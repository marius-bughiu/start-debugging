---
title: "Решение: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]"
description: "Gradle компилирует с помощью JRE. Он не ищет по всей машине, а использует ровно ту JVM, с которой был запущен. Укажите в flutter config --jdk-dir настоящий JDK или уберите org.gradle.java.home."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "java"
lang: "ru"
translationOf: "2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-21
---

В каталоге Java, на котором работает Gradle, нет `bin/javac`, значит это JRE, а не JDK. Gradle не ищет на вашей машине вариант получше: если toolchain нигде не настроен, он берёт ту JVM, с которой был запущен, и сразу падает. В сборке Android под Flutter эту JVM в первую очередь определяет `flutter config --jdk-dir`, поэтому выполните `flutter config --jdk-dir "/путь/к/настоящему/jdk"` и соберите заново. Если ошибка не изменилась, значит решение Flutter кто-то перекрывает: проверьте `org.gradle.java.home` в `android/gradle.properties`.

Всё описанное ниже проверено на Flutter 3.44.2 stable, чьи шаблоны Android фиксируют Gradle 9.1.0, Android Gradle Plugin 9.0.1, Kotlin Gradle Plugin 2.3.20 и `compileSdk` 36.

## Как эту ошибку печатает Gradle

```text
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:packageDebug'.
> Could not create task ':app:compileDebugJavaWithJavac'.
   > Failed to calculate the value of task ':app:compileDebugJavaWithJavac' property 'javaCompiler'.
      > Toolchain installation 'C:\path\to\some-java-home' does not provide the required capabilities: [JAVA_COMPILER]
```

Через `flutter build apk` обычно виден только её хвост, обёрнутый в `Gradle task assembleDebug failed with exit code 1`. Важна именно путь в кавычках. Это тот каталог Java, который Gradle отверг, и в девяти случаях из десяти вы не настраивали его осознанно.

## Почему Gradle винит каталог Java, который вы никогда не настраивали

Это сообщение приходит от Gradle, а не от Flutter или AGP. В Gradle 9.1.0 его бросает `JavaToolchainQueryService`, и окружающая логика объясняет всё:

```java
// Gradle 9.1.0, JavaToolchainQueryService.resolveToolchain
boolean useFallback = !requestedSpec.isConfigured();
JavaToolchainSpec actualSpec = useFallback ? fallbackToolchainSpec : requestedSpec;
```

Если toolchain не настроен нигде в сборке, Gradle подставляет запасную спецификацию со значением "текущая JVM". Этот путь ничего не ищет, не фильтрует и не ранжирует:

```java
// Gradle 9.1.0, JavaToolchainQueryService.query
if (spec instanceof CurrentJvmToolchainSpec) {
    return asToolchainOrThrow(
        InstallationLocation.autoDetected(currentJavaHome, "current JVM"),
        spec, requiredCapabilities, isFallback);
}
```

`asToolchainOrThrow` проверяет ровно одну установку и бросает ошибку, если ей не хватает требуемой возможности. Сравните это с настроенным путём `findInstalledToolchain`, который пропускает все обнаруженные установки через матчер, знающий о возможностях, и молча отбрасывает неподходящие.

Эта разница и есть самое полезное знание здесь. Ошибка означает, что Gradle получил один конкретный каталог Java и в нём нет компилятора. Она не означает "Gradle не смог найти JDK". Когда Gradle действительно ничего не находит, выводится совсем другое сообщение, о нём ниже.

Отсюда же следует, что настройки автоопределения toolchain на этом пути не играют роли. Я проверил это, запустив одну и ту же задачу дважды: с `-Dorg.gradle.java.installations.auto-detect=false` и с включённым определением. Ошибка одинаковая в обоих случаях.

## Что Gradle на самом деле проверяет, говоря JAVA_COMPILER

Меньше, чем можно подумать. Никакого зондирования, никаких запросов модулей, никаких попыток вызвать API компилятора. Это проверка существования файла:

```java
// Gradle 9.1.0, JvmInstallationMetadata.gatherCapabilities
if (getToolByExecutable("javac").exists()) {
    capabilities.add(JavaInstallationCapability.JAVA_COMPILER);
}
if (getToolByExecutable("javadoc").exists()) {
    capabilities.add(JavaInstallationCapability.JAVADOC_TOOL);
}
if (getToolByExecutable("jar").exists()) {
    capabilities.add(JavaInstallationCapability.JAR_TOOL);
}
```

`getToolByExecutable` разрешает `<javaHome>/bin/<name>` с расширением исполняемого файла для текущей платформы. Gradle помечает установку как "JDK" только если присутствуют все три файла: `javac`, `javadoc` и `jar`, а `JAVA_COMPILER` это в точности `bin/javac`.

Практическое следствие: каталог Java, который является JDK во всех смыслах, кроме того что в его каталоге `bin` буквально нет `javac`, будет опознан как JRE. Сюда попадают пакеты `java-17-openjdk` в Fedora и Debian, поставляющие только headless-среду выполнения, старый подкаталог `jre` внутри установки JDK, а также любой каталог-обёртка, который пробрасывает `java`, но не остальные инструменты.

## Воспроизведение: собрать JRE и увидеть сбой

Сломанная машина для этого не нужна. Соберите образ среды выполнения без модулей компилятора с помощью `jlink`, ведь именно это и есть JRE:

```bash
# JDK 21.0.11, jlink from the same JDK
MODS=$(java --list-modules | sed 's/@.*//' \
  | grep -vE '^(jdk\.compiler|jdk\.javadoc|jdk\.jshell|jdk\.jlink|jdk\.jdeps|jdk\.jpackage)$' \
  | paste -sd, -)
jlink --add-modules "$MODS" --no-header-files --no-man-pages --output ./real-jre-21
ls ./real-jre-21/bin/javac   # no such file
./real-jre-21/bin/java -version
# openjdk version "21.0.11" 2026-04-21 LTS
```

Исключение `jdk.jpackage` здесь принципиально. Он тянет `jdk.jlink`, тот тянет `jdk.jdeps`, а тот возвращает обратно `jdk.compiler`, и вы получаете лаунчер `javac`, которого пытались избежать.

Теперь направьте туда Flutter и соберите обычное приложение из `flutter create`:

```bash
# Flutter 3.44.2 stable, Gradle 9.1.0, AGP 9.0.1
flutter create --platforms=android toolchain_repro
flutter config --jdk-dir "$(pwd)/real-jre-21"
cd toolchain_repro && flutter build apk --debug
```

Сборка падает с точно той же ошибкой, что приведена в начале статьи, на нетронутом шаблоне, где нет ни одного блока toolchain.

## Какую Java на самом деле использует сборка Flutter?

Именно здесь теряется большая часть времени на отладку, потому что `JAVA_HOME` это не первое, куда смотрит Flutter. Согласно `packages/flutter_tools/lib/src/android/java.dart` в версии 3.44.2, `_findJavaHome` возвращает первое совпадение в таком порядке:

1. значение `jdk-dir` в собственной конфигурации Flutter, заданное через `flutter config --jdk-dir`
2. JDK, поставляемый вместе с Android Studio
3. переменная окружения `JAVA_HOME`
4. то, во что разрешается `java` в `PATH`

То есть устаревший `jdk-dir` побеждает совершенно исправный `JAVA_HOME`, причём постоянно и молча. Я столкнулся с этим, когда готовил воспроизведение: я экспортировал `JAVA_HOME` на урезанную среду выполнения, а сборка продолжала проходить, потому что побеждал `jdk-dir`, настроенный раньше. Проверьте своё значение, прежде чем менять что-либо ещё:

```bash
# Flutter 3.44.2
flutter config --list | grep jdk-dir
```

Для пункта 2 путь зависит от версии Android Studio. Studio 2022 и новее используют `<studio>/jbr`, либо `<studio>/jbr/Contents/Home` в macOS. Более старые версии используют `<studio>/jre`. Если у вас завалялась древняя установка, которую Flutter всё ещё находит, этот каталог `jre` вполне может быть причиной.

Ловушка, из-за которой всё это трудно заметить, в том, что `flutter doctor` не проверяет наличие компилятора. С настроенным JRE он печатает:

```text
[√] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Java binary at: /path/to/real-jre-21/bin/java
      This JDK is specified in your Flutter configuration.
    • Java version OpenJDK Runtime Environment Microsoft-13877171 (build 21.0.11+10-LTS)
```

Зелёная галочка и слова "This JDK". Doctor выполняет `java --version` и разбирает вывод, на что JRE отвечает совершенно нормально. Он никогда не ищет `javac`. Если вы и так разбираетесь с проблемой doctor, то `cmdline-tools component is missing` это отдельный диагноз со своим решением.

## Как указать Flutter на настоящий JDK?

Задайте `jdk-dir` явно и пересоберите. В типичном случае это и есть решение:

```bash
# Flutter 3.44.2
flutter config --jdk-dir "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
flutter build apk --debug
```

Проверьте каталог, прежде чем его задавать. Проверка, которую делает Gradle, это ровно та проверка, которую стоит сделать вам:

```bash
ls "$YOUR_JDK/bin/javac"
```

Если такого файла нет, путь ведёт к JRE, как бы каталог ни назывался. В Debian и Ubuntu до этой ошибки доводит пакет `openjdk-21-jre-headless`, а нужен `openjdk-21-jdk`. В macOS с Homebrew установите `openjdk@21` и используйте версионированный путь, который он печатает, а не промежуточную ссылку.

Чтобы вернуться к `JAVA_HOME` и обычному порядку приоритетов, снимите переопределение:

```bash
# Flutter 3.44.2, empty value removes the setting
flutter config --jdk-dir ""
```

## Что перекрывает выбор JDK, сделанный Flutter?

`android/gradle.properties` может перекрыть всё, что решил Flutter. `org.gradle.java.home` задаёт JVM, на которой работает демон Gradle, и поскольку падающий путь это "текущая JVM", указание на JRE воспроизводит ошибку даже тогда, когда `flutter config --jdk-dir` ведёт на корректный JDK. Я проверил именно эту комбинацию: правильный `jdk-dir`, одна добавленная строка, тот же самый сбой.

```properties
# android/gradle.properties, delete this line if it points at a JRE
org.gradle.java.home=/path/to/real-jre-21
```

Проверьте то же свойство в `~/.gradle/gradle.properties`, которое действует на все сборки машины и про которое легко забыть. Затем посмотрите, что видит сам Gradle:

```bash
# run from android/, Gradle 9.1.0
./gradlew -q javaToolchains
```

Этот отчёт самый быстрый доступный инструмент диагностики, потому что печатает два ключевых поля:

```text
 + Microsoft JDK 21 (21.0.11+10-LTS)
     | Location:           C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
     | Language Version:   21
     | Is JDK:             true
     | Detected by:        Current JVM

 + Oracle JDK 26 (26.0.2+10-55)
     | Location:           C:\Program Files\Java\jdk-26.0.2
     | Language Version:   26
     | Is JDK:             true
     | Detected by:        Windows Registry
```

Значение `Is JDK: false` у записи, чей Location совпадает с путём из вашего сообщения об ошибке, подтверждает диагноз одной строкой.

## Решает ли проблему добавление блока toolchain?

Самый популярный совет по этой ошибке состоит в том, чтобы объявить toolchain в `android/app/build.gradle.kts`. Результат действительно меняется, но не всегда в нужную сторону, потому что сборка уходит с пути текущей JVM на путь подбора, где Gradle примет только ту установку, которую способен реально обнаружить.

Я проверил именно это. При JRE, всё ещё заданном как `jdk-dir`, добавление:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1, Gradle 9.1.0
java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
```

дало другой сбой:

```text
> Cannot find a Java installation on your machine (Windows 11 10.0 amd64) matching:
  {languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}.
  Toolchain download repositories have not been configured.
```

JDK 21 всё это время был установлен. Gradle его не нашёл, потому что автоопределение его никогда не видело: посмотрите ещё раз на вывод `javaToolchains` выше и обратите внимание, что Microsoft JDK 21 указан как `Detected by: Current JVM`. Как только текущей JVM стал JRE, эта запись исчезла из списка кандидатов, а сканирование реестра выдало только JDK 26, который не удовлетворяет запросу на 21.

Так что одинокий блок toolchain меняет понятную ошибку на более расплывчатую. Используйте его вместе с явным путём установки, а не вместо него.

## Как зафиксировать JDK для CI, чтобы это не повторилось?

Объявите toolchain и укажите Gradle, где лежат установки. Такая комбинация собирается успешно даже тогда, когда демон работает на JRE, а это именно то свойство, которое нужно на агенте сборки, где вы не управляете `JAVA_HOME`:

```properties
# android/gradle.properties, Gradle 9.1.0
org.gradle.java.installations.paths=/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.11/x64
```

В паре с блоком `java { toolchain { ... } }` выше это и была конфигурация, которую я подтвердил зелёной, пока `jdk-dir` всё ещё указывал на среду выполнения без компилятора. Стоит знать про две смежные настройки: `org.gradle.java.installations.fromEnv=JDK21` читает пути из именованных переменных окружения, что подходит образам CI, которые их и так экспортируют, а `org.gradle.java.installations.auto-detect=false` полностью отключает сканирование, чтобы агент без зафиксированных путей падал громко, а не выбирал что-то произвольное.

Не берите `org.gradle.java.installations.auto-download=true` в качестве решения. Gradle 9 объявляет устаревшим использование автоматически предоставленных toolchain без объявленных репозиториев toolchain и предупреждает, что в Gradle 10 это станет ошибкой.

## Похожие ошибки, которые на самом деле другие

`Toolchain installation '...' could not be probed` бросается двумя строками выше в том же методе и означает, что Gradle вообще не смог запустить `java`. Это сломанная или неполная установка, проблема с правами или несовпадение архитектуры, но не JRE.

`Cannot find a Java installation on your machine ... matching` это путь настроенного toolchain, который не нашёл кандидата. Лечится добавлением пути установки, как показано выше.

`Unsupported class file major version` и `Gradle requires JVM 17 or later` это несовпадения версий, а не нехватка возможностей. Flutter 3.44.2 хранит таблицу совместимости Java и Gradle в `gradle_utils.dart`: Java 21 требует Gradle 8.4 или новее, Java 24 требует 8.14, Java 25 требует 9.1.0.

`Cannot add extension with name 'kotlin'` это встроенная поддержка Kotlin в AGP 9, конфликтующая со старым плагином `kotlin-android`, и в 2026 году это вторая частая причина падения `assembleDebug`.

## Похожие материалы

- Flutter сообщает о сбоях Gradle через строку-обёртку, а [настоящая ошибка обычно обрезана выше неё](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Зелёная галочка у Android toolchain всё равно может скрывать недостающий элемент, как в случае с [компонентом cmdline-tools](/ru/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/).
- Ещё один сбой Android SDK, который повторяется одинаково, пока вы не очистите кеш: [повреждённый архив NDK](/ru/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Другие ломающие сборку настройки, живущие в `android/gradle.properties`: [флаги AndroidX и Jetifier](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/).
- Контекст версий для упомянутых здесь значений toolchain по умолчанию: [что изменилось во Flutter 3.44](/ru/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).

## Источники

- Руководство пользователя Gradle, [Toolchains for JVM projects](https://docs.gradle.org/current/userguide/toolchains.html), про источники автоопределения, приоритеты и свойства установок.
- Исходный код Gradle 9.1.0, `JavaToolchainQueryService.java` и `JvmInstallationMetadata.java`, поставляемые в каталоге `src` дистрибутива `gradle-9.1.0-all`.
- Исходный код Flutter 3.44.2, `packages/flutter_tools/lib/src/android/java.dart` для порядка поиска Java и `gradle_utils.dart` для зафиксированных версий Gradle, AGP и Kotlin.
- Issues Gradle [#30499](https://github.com/gradle/gradle/issues/30499) и [#30421](https://github.com/gradle/gradle/issues/30421), где то же сообщение воспроизводится на пакетах OpenJDK в Linux.

---
title: "Исправление: A restricted method in java.lang.System has been called в сборке Gradle для Flutter"
description: "Предупреждение JEP 472 на JDK 24+ безобидно и выводится один раз. Решение состоит в согласовании JDK с версией Gradle, а не во вставке флагов в gradle.properties."
pubDate: 2026-08-22
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "jdk"
lang: "ru"
translationOf: "2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build"
translatedBy: "claude"
translationDate: 2026-08-22
---

С вашей сборкой всё в порядке. Это предупреждение JDK 24 и новее из [JEP 472](https://openjdk.org/jeps/472), которое выводится один раз на вызывающий модуль, когда что-то загружает нативную библиотеку через `System.load` или `System.loadLibrary` без `--enable-native-access`. Актуальный Gradle уже передаёт этот флаг собственному демону, поэтому если вы это видите, то либо ваш JDK новее, чем поддерживает ваш Gradle, либо флага не хватает какой-то ответвлённой JVM внутри сборки. Возврат к JDK 21, который поставляется с Android Studio, убирает предупреждение полностью.

Всё изложенное ниже измерено на Windows 11 с Flutter 3.44.2 stable (ревизия `c9a6c48423`), Gradle 9.1.0, JDK 26.0.2 (`26.0.2+10-55`) и Microsoft OpenJDK 21.0.11.

## Ошибка в контексте

```text
WARNING: A restricted method in java.lang.System has been called
WARNING: java.lang.System::load has been called by net.rubygrapefruit.platform.internal.NativeLibraryLoader in an unnamed module (file:/C:/Users/mariu/.gradle/wrapper/dists/gradle-9.1.0-all/7wzd0jkjit61aq2p43wpjgij9/gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module
WARNING: Restricted methods will be blocked in a future release unless native access is enabled
```

Вторая строка меняется. `java.lang.System::loadLibrary` появляется вместо `::load`, когда вызывающая сторона передала имя библиотеки, а не абсолютный путь, а вызывающим классом оказывается тот, кто действительно загрузил нативный код. `net.rubygrapefruit.platform.internal.NativeLibraryLoader` относится к собственной нативной интеграции Gradle. `com.sun.jna.Native` означает JNA, притянутую каким-то плагином.

## Что означает "a restricted method in java.lang.System has been called"?

JEP 472, вышедший в JDK 24, сделал `System::load`, `System::loadLibrary`, `Runtime::load` и `Runtime::loadLibrary` ограниченными методами, а привязка нативного метода JNI стала ограниченной операцией. Ограниченный означает, что JVM требует явного согласия, прежде чем код выйдет за пределы среды выполнения, поскольку дефектная нативная библиотека способна повредить кучу так, что JVM не сможет об этом сообщить.

Согласие выражается флагом `--enable-native-access`. Без него JDK 24 и новее выводят приведённый выше блок из четырёх строк и продолжают работу. Прежде чем искать решение, стоит знать три вещи:

Предупреждение выдаётся **один раз на вызывающий модуль**, а не на каждый вызов. Цикл, загружающий три библиотеки из одного класса, выводит один блок:

```java
// JDK 26.0.2, plain javac, no flags
public class MultiProbe {
    public static void main(String[] args) {
        for (int i = 0; i < 3; i++) {
            try { System.load("C:/Windows/System32/winhttp.dll"); }
            catch (Throwable t) { /* ignore */ }
        }
        System.out.println("DONE-MULTI");
    }
}
```

Это выводит один блок предупреждения, за которым следует `DONE-MULTI`. Если блок повторяется, значит в одном журнале сборки вы видите несколько разных JVM либо несколько разных jar-файлов. Различить их помогает путь модуля во второй строке каждого блока.

Режим по умолчанию по-прежнему `warn`. Запуск того же класса с `--illegal-native-access=warn` на JDK 26.0.2 даёт вывод, идентичный запуску вообще без флага, и именно так подтверждается, что значение по умолчанию в вашем JDK ещё не переключилось на `deny`.

А последняя строка представляет собой прогноз, а не уведомление об устаревании вашего кода. "Blocked in a future release" относится к будущему JDK, а не к будущему Gradle или Flutter.

## Какие версии JDK это выводят и почему JDK 21 не выводит?

Нижней границей служит JDK 24. На JDK 21 и 17 такого предупреждения не существует. Тот же пробник на Microsoft OpenJDK 21.0.11 выводит `DONE-MULTI` и больше ничего.

Здесь стоит быть точным, потому что ограничение приходило двумя волнами. JDK 22 и 23 предупреждают об ограниченных методах в Foreign Function and Memory API, поэтому в сообщении фигурирует `java.lang.foreign.Linker` или подобное. Часть, относящаяся к JNI, то есть рассматриваемый здесь вариант `java.lang.System::load`, появилась в JDK 24. Если в вашем предупреждении указан `java.lang.System`, вы работаете на JDK 24 или новее.

Для Flutter это важно, потому что Flutter не выбирает самый новый JDK на машине. Он разрешает один, в таком порядке, согласно `packages/flutter_tools/lib/src/android/java.dart`:

1. Путь, сохранённый командой `flutter config --jdk-dir`.
2. JBR, поставляемый с Android Studio.
3. `JAVA_HOME`.
4. Первый `java` в `PATH`.

JBR из Android Studio в текущих выпусках имеет версию 21, поэтому установка Flutter по умолчанию этого предупреждения никогда не видит. Если вы его видите, значит вы сами направили `jdk-dir` или `JAVA_HOME` на JDK 24, 25 или 26, чаще всего как побочный эффект установки "самой свежей Java" через пакетный менеджер. Проверить, какой JDK задействован, помогает `flutter doctor --verbose`, который печатает разрешённый бинарник Java и его версию.

## Передаёт ли Gradle флаг --enable-native-access своему демону?

Да, и именно это меняет способ исправления. Gradle поставляет флаг начиная с 8.14. Логика находится в `org.gradle.internal.jvm.JpmsConfiguration`, и байт-код в `gradle-base-services-8.14.jar` и в `gradle-base-services-9.1.0.jar` идентичен: `forDaemonProcesses(int, boolean)` и `forWorkerProcesses(int, boolean)` сравнивают целевую версию Java с `24`, и когда она равна 24 или выше, а логическое значение истинно, возвращают список, содержащий `--enable-native-access=ALL-UNNAMED`. Вызывающие стороны, `DefaultDaemonStarter` и `DefaultWorkerProcessBuilder`, передают в качестве этого значения `NativeServices.NativeServicesMode.isPotentiallyEnabled()`.

Это можно увидеть на работающем демоне. Запустите любую сборку, а затем спросите у JVM её командную строку:

```bash
# JDK 26.0.2 jcmd against a running Gradle 9.1.0 daemon
jps -l | grep GradleDaemon
jcmd <pid> VM.command_line
```

На демоне Gradle 9.1.0 под JDK 26.0.2 среди записей `--add-opens` выводится одиночный `--enable-native-access=ALL-UNNAMED`. Из этого следуют два вывода:

- Собственное значение `org.gradle.jvmargs` его не затирает. При `org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G` в `gradle.properties` командная строка демона по-прежнему содержит `-Xmx4G`, `-XX:MaxMetaspaceSize=2G` **и** `--enable-native-access=ALL-UNNAMED`. Для Flutter это особенно существенно, поскольку шаблон приложения по умолчанию содержит непустую строку `org.gradle.jvmargs`.
- А вот `org.gradle.native=false` флаг убирает, потому что `isPotentiallyEnabled()` возвращает ложь. Это не исправление, а полное отключение нативной интеграции Gradle, вместе с которым теряется и отслеживание файловой системы.

Поэтому предупреждение с упоминанием `net.rubygrapefruit.platform.internal.NativeLibraryLoader` от актуального демона Gradle флагом не чинится. Оно означает, что эта JVM не получила аргументы Gradle, а это указывает на одну из трёх причин: Gradle старее 8.14, JVM, ответвлённая плагином, а не worker API самого Gradle, либо IDE, общающаяся с вашей сборкой через Tooling API. На последнее указывают и собственные примечания к выпуску Gradle 8.14: потребителям Tooling API приходится включать нативный доступ при старте самостоятельно из-за использования JNI.

## Какая JVM в сборке выводит предупреждение?

Отталкивайтесь от второй строки. В ней названы и вызывающий класс, и jar-файл, из которого он пришёл, а этой пары достаточно, чтобы определить JVM:

- Вызывающая сторона в `native-platform-*.jar` внутри `~/.gradle/wrapper/dists/`, а `jcmd` показывает, что у демона флаг есть: предупреждение исходит из процесса, отличного от осмотренного демона, обычно из ответвлённого воркера или демона компиляции, запущенного плагином.
- Вызывающая сторона в `jna-*.jar`: плагин загрузил JNA. Найдите его командой `./gradlew :app:dependencies --configuration runtimeClasspath` из каталога `android/`, ориентиром служит `net.java.dev.jna`.
- Вызывающая сторона в jar-файле внутри `~/.gradle/caches/modules-2/`: это зависимость плагина, а не сам Gradle, и ответвлять процесс с флагом должен автор плагина.

Поскольку Gradle за вас запускает Flutter, сначала сохраните сырой вывод:

```bash
# Flutter 3.44.2, run from the project root
flutter build apk --debug --verbose 2>&1 | tee build.log
grep -n "restricted method" -A 3 build.log
```

## Как убрать предупреждение?

В порядке предпочтения.

**Согласуйте JDK с версией Gradle.** Матрица совместимости Gradle строга: Java 24 требует Gradle 8.14 или новее, Java 25 требует 9.1.0 или новее, а Java 26 требует 9.4.0 или новее. Flutter 3.44.2 создаёт проекты на Gradle 9.1.0 с AGP 9.0.1 и Kotlin 2.3.20, поэтому новый проект нормально работает на JDK 24 или 25 и на одну версию отстаёт для JDK 26. Поднимите wrapper в `android/gradle/wrapper/gradle-wrapper.properties`:

```properties
# Flutter 3.44.2 default is gradle-9.1.0-all; 9.4.0+ is required for JDK 26
distributionUrl=https\://services.gradle.org/distributions/gradle-9.4.0-all.zip
```

Выход за пределы матрицы не ограничивается предупреждением. Gradle 9.1.0 на JDK 26.0.2 обрушивает сборку сразу:

```text
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 70
```

Flutter распознаёт этот случай. `gradle_errors.dart` сопоставляет `Unsupported class file major version\s+\d+` и печатает рамку с сообщением о том, что ваша версия Gradle несовместима с версией Java, которую использует Flutter, со ссылкой на `flutter doctor --verbose`.

**Направьте Flutter на тот JDK, который вам действительно нужен.** Если новейший JDK для этого проекта не требуется, самый короткий путь состоит в том, чтобы перестать подсовывать его Flutter:

```bash
# Flutter 3.44.2; persists to the Flutter config, survives JAVA_HOME changes
flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"
flutter doctor --verbose
```

Поскольку `jdk-dir` стоит выше `JAVA_HOME` в порядке разрешения, это перекрывает всё, что пакетный менеджер задал глобально, и затрагивает только Flutter.

**Добавьте флаг той JVM, которой его не хватает.** Только после того, как вы определили эту JVM по второй строке. Для демона Gradle на старой версии это `org.gradle.jvmargs` в `android/gradle.properties`, дописанный к тому, что шаблон Flutter уже туда положил:

```properties
# Flutter 3.44.2 template default, plus the JEP 472 opt-in
org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError --enable-native-access=ALL-UNNAMED
```

Для демона компиляции Kotlin аналогичной настройкой служит `kotlin.daemon.jvmargs`. Учтите, что это настоящее согласие с настоящим смыслом, а не кнопка отключения звука: вы утверждаете, что всё в class path вправе вызывать нативный код.

## Безопасно ли помещать --illegal-native-access=allow в gradle.properties?

Нет, и это единственное изменение здесь, которое действительно способно сломать сборку у коллеги.

`--illegal-native-access` появился вместе с JEP 472 в JDK 24. На JDK 21 такой опции нет, а неизвестная опция с `-` фатальна при запуске JVM:

```text
Unrecognized option: --illegal-native-access=deny
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

Поместите это в `org.gradle.jvmargs`, и сборка умрёт у всех на JDK 21, включая каждого разработчика с JBR из Android Studio и большинство образов CI, закреплённых на LTS. Флаг `--enable-native-access` в этом отношении безопаснее, так как существует с JDK 21 и принимается там без нареканий, но и его лучше ограничивать проектом, а не глобальным `GRADLE_OPTS`.

У значения `allow` есть и вторая проблема: это режим совместимости, который JEP 472 описывает как временный, подлежащий постепенному сворачиванию и в итоге удалению. Строить на нём означает, что в каком-то будущем JDK предупреждение вернётся уже ошибкой, по чужому расписанию.

## Что произойдёт, когда предупреждение станет ошибкой?

Развязку можно увидеть уже сегодня, согласившись на неё заранее. Загрузка собственной нативной библиотеки Gradle на JDK 26.0.2 с `--illegal-native-access=deny`:

```text
Exception in thread "main" net.rubygrapefruit.platform.NativeException: Failed to load native library 'native-platform.dll' for Windows 11 amd64.
	at net.rubygrapefruit.platform.internal.NativeLibraryLoader.load(NativeLibraryLoader.java:67)
	at net.rubygrapefruit.platform.Native.init(Native.java:60)
Caused by: java.lang.IllegalCallerException: Illegal native access from an unnamed module (file:/C:/.../gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
	at java.base/java.lang.Module.ensureNativeAccess(Module.java:311)
	at java.base/java.lang.System$1.ensureNativeAccess(System.java:2110)
```

За `IllegalCallerException` отвечает JDK. Всё, что выше, относится к обработке сбоев самой библиотекой, и поэтому будущая версия этой проблемы вовсе не будет выглядеть как ошибка нативного доступа. Она будет выглядеть так, как библиотека сообщает о неудачной загрузке `.dll` или `.so`. Прогон CI с `--illegal-native-access=deny` в задании на JDK 24+ представляет собой дешёвый способ узнать, какой из ваших плагинов сломается первым, при условии что вы держите это вне общего `gradle.properties`.

## Связанные материалы

- [Toolchain installation does not provide the required capabilities: \[JAVA_COMPILER\]](/ru/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) раскрывает вторую половину истории с JDK во Flutter, когда Gradle разрешает JRE вместо JDK.
- [Gradle task assembleDebug failed with exit code 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) показывает, как вытащить настоящую ошибку из журнала сборки Android во Flutter.
- [flutter doctor сообщает об отсутствии компонента cmdline-tools](/ru/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) дополняет тему, когда недоволен сам `flutter doctor --verbose`.
- [Интерфейс Flutter перекрывает панель навигации Android после перехода на SDK 35](/ru/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) описывает ещё один случай, когда изменение платформы Android проявляется поздно в проекте Flutter.

## Источники

- [JEP 472: Prepare to Restrict the Use of JNI](https://openjdk.org/jeps/472), где определены ограниченные методы и согласие через `--enable-native-access`.
- [JDK 24: Prepares Restricted Native Access](https://inside.java/2024/12/09/quality-heads-up/) на Inside Java, заметка Quality Outreach об изменении в JDK 24.
- [Матрица совместимости Gradle и Java](https://docs.gradle.org/current/userguide/compatibility.html), с версией Gradle, необходимой для каждого выпуска Java.
- [Примечания к выпуску Gradle 8.14](https://docs.gradle.org/8.14/release-notes.html), где добавлена поддержка Java 24 для демона и отмечено требование JNI со стороны Tooling API.
- Исходники Flutter 3.44.2: `packages/flutter_tools/lib/src/android/java.dart` для порядка разрешения JDK и `packages/flutter_tools/lib/src/android/gradle_errors.dart` для обработчика версии class file.

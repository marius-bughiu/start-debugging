---
title: "Исправление: Timeout waiting to lock journal cache в Android-сборке Flutter"
description: "Другой процесс Gradle удерживает ~/.gradle/caches/journal-1 и не может передать блокировку. Найдите Owner PID, завершите этот демон и перестаньте удалять файлы .lock: это лишь переносит ошибку."
pubDate: 2026-10-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "ru"
translationOf: "2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-05
---

Другой процесс Gradle, "Owner PID" из сообщения, удерживает блокировку на `~/.gradle/caches/journal-1` и не ответил на запрос вашей сборки освободить её в пределах фиксированного 60-секундного тайм-аута Gradle. Решение: найти этот процесс и завершить его. Убедитесь через `jps -l` (или `ps`), что это `GradleDaemon`, затем выполните `kill -9 <Owner PID>` или `Stop-Process -Id <Owner PID> -Force` в Windows и снова запустите `flutter run`. `./gradlew --stop` здесь часто ничего не делает, потому что останавливает только демоны своей версии Gradle. Удаление `journal-1.lock` тоже не помогает: в моём воспроизведении следующая сборка просто упала по тайм-ауту на кеше хешей файлов.

Всё ниже воспроизведено на macOS с Flutter 3.44.8 (чей шаблон фиксирует Gradle 9.1.0 и AGP 9.0.1), дистрибутивами Gradle 9.3.1 и 8.14 и OpenJDK 17 с временным `GRADLE_USER_HOME`. Код блокировок я читал в исходниках Gradle на теге `v9.8.0`, текущем релизе.

## Ошибка в контексте

Это точный вывод из моего воспроизведения (пути сокращены до `~`):

```text
FAILURE: Build failed with an exception.

* What went wrong:
Gradle could not start your build.
> Cannot create service of type BuildSessionActionExecutor using method LauncherServices$ToolingBuildSessionScopeServices.createActionExecutor() as there is a problem with parameter #21 of type BuildLifecycleAwareVirtualFileSystem.
   ...
            > Could not create service of type FileAccessTimeJournal using GradleUserHomeScopeServices.createFileAccessTimeJournal().
               > Timeout waiting to lock journal cache (~/.gradle/caches/journal-1). It is currently in use by another process.
                 Owner PID: 52907
                 Our PID: 52963
                 Owner Operation: 
                 Our operation: 
                 Lock file: ~/.gradle/caches/journal-1/journal-1.lock

BUILD FAILED in 1m 1s
```

Когда сборку запускает Flutter, вы видите тот же блок под `FAILURE: Build failed with an exception.`, а следом собственное сообщение Flutter `Gradle task assembleDebug failed with exit code 1`. Эта последняя строка лишь вестник, а не причина.

Две детали подскажут, какая у вас версия Gradle. Gradle 8.x и старше пишут "It is currently in use by another **Gradle instance**". Начиная с Gradle 9.0 формулировка такая: "in use by another **process**". Строки `Owner Operation` и `Our operation` для кеша журнала почти всегда пустые, их можно игнорировать. Важна строка `Owner PID`.

## Почему Gradle не может получить блокировку

`~/.gradle/caches/journal-1` хранит информацию о том, когда каждый файл общих кешей использовался в последний раз, чтобы очистка кеша Gradle знала, что можно безопасно удалить. В отличие от `caches/9.1.0/` или `caches/8.14/`, он **не привязан к версии**: этот единственный каталог делят все версии Gradle на машине, все демоны и все синхронизации IDE. Поэтому именно эту блокировку люди ловят чаще всего.

Gradle не удерживает такие блокировки всё время сборки. Он берёт их "по требованию" и передаёт, когда о них просит кто-то другой. Алгоритм в `DefaultFileLockManager` такой:

1. Попытаться взять блокировку ОС на области состояния файла блокировки.
2. Если не вышло, прочитать PID и UDP-порт владельца из информационной области файла блокировки и отправить владельцу ping через loopback.
3. Владелец, если он сейчас не использует кеш, снимает блокировку и подтверждает это.
4. Повторять с экспоненциальной задержкой, пока блокировка не будет получена или не истечёт `DEFAULT_LOCK_TIMEOUT` (60 000 мс).

```java
// Gradle v9.8.0, DefaultFileLockManager.java
public static final int DEFAULT_LOCK_TIMEOUT = 60000;
```

Тайм-аут является константой, которую передаёт `BasicGlobalScopeServices`. Свойства Gradle или системного свойства для его увеличения нет, поэтому вариант "увеличить тайм-аут блокировки" отпадает.

Так что ошибка никогда не означает "где-то валяется устаревший файл блокировки". Если бы процесс-владелец умер, операционная система сняла бы его блокировку файла, и ваша сборка получила бы её сразу. Ошибка означает, что **блокировкой владеет живой процесс, который не ответил на ping**. Реалистичных причин четыре:

- **Владелец завис.** Демон, который буксует в сборке мусора из-за нехватки кучи, остановлен в отладчике или приостановлен. Он жив, поэтому ОС сохраняет его блокировку, но обработать ping он не может ([gradle/gradle#16299](https://github.com/gradle/gradle/issues/16299)).
- **Ping не доходит.** Известно, что продукты защиты конечных точек и межсетевые экраны (CrowdStrike, SentinelOne, Symantec WSS, Netskope, некоторые VPN-клиенты) отбрасывают loopback-трафик UDP от Gradle. Случай с брандмауэром macOS 15.1 описан в [gradle/gradle#31245](https://github.com/gradle/gradle/issues/31245), исправлен в Gradle 8.12.1.
- **Владелец в другом контейнере.** Два контейнера CI, монтирующие один том `~/.gradle`, делят файл блокировки, но не loopback-интерфейс, поэтому ping не доходят ([gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750)). В документации Gradle сказано, что параллельный доступ к кешу "is only supported if the different Gradle processes can communicate together".
- **Файловая система неправильно работает с блокировками.** ExFAT, некоторые сетевые ресурсы и некоторые синхронизируемые папки ([gradle/gradle#4329](https://github.com/gradle/gradle/issues/4329)).

На машине Flutter-разработчика преобладает первая причина, потому что у Flutter-проекта обычно несколько клиентов Gradle: `flutter run` из терминала или VS Code, синхронизация Gradle в Android Studio и `flutter build apk` из скрипта. Если они используют разные JDK (встроенный JBR Android Studio и `JAVA_HOME`) или разные версии Gradle (два проекта, созданные разными релизами Flutter), каждый получает свой демон, и все они делят `journal-1`.

## Минимальное воспроизведение

Для этого не нужны ни Flutter, ни телефон. Достаточно проекта Gradle с одной задачей, временного домашнего каталога Gradle и `kill -STOP`, имитирующего зависший демон:

```bash
# macOS 26, OpenJDK 17, Gradle 9.3.1 (same 9.x error wording as Gradle 9.1.0 in the Flutter 3.44 template)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export GRADLE_USER_HOME=/tmp/guh          # keep your real ~/.gradle out of it
mkdir -p /tmp/plain && cd /tmp/plain
echo "rootProject.name = 'plain'" > settings.gradle
echo "tasks.register('hello') { doLast { println 'hello' } }" > build.gradle

gradle hello -q                           # starts a daemon, which keeps journal-1 on demand
PID=$(jps -l | awk '/GradleDaemon/{print $1}')
kill -STOP "$PID"                         # the daemon is alive but cannot answer pings

gradle hello --no-daemon                  # fails after ~60 s: Timeout waiting to lock journal cache
kill -CONT "$PID"
```

Вот результаты, которые я измерил, каждый с тем же временным домашним каталогом:

| Сценарий | Результат |
| --- | --- |
| Здоровый простаивающий демон 9.3.1, вторая сборка 9.3.1 | Успех за 2 с (демон передаёт блокировку) |
| Замороженный демон 9.3.1, вторая сборка 9.3.1 | Падает через 62 с на `journal cache`, `Owner PID` равен замороженному демону |
| Замороженный демон 9.3.1, `journal-1.lock` удалён, вторая сборка | Вместо этого падает через 62 с на `file hash cache (caches/9.3.1/fileHashes)` |
| Замороженный демон 9.3.1, `gradle --stop` (9.3.1) | Зависает на "Stopping Daemon(s)" (всё ещё ждёт через 25 с) |
| Здоровый демон 9.3.1, `gradle --stop` из Gradle 8.14 | Выводит "No Gradle daemons are running.", а демон 9.3.1 продолжает работать |
| Замороженный демон 9.3.1, сборка Gradle 8.14 | Падает через 64 с на `journal cache` со старой формулировкой "another Gradle instance" |
| `kill -9` замороженного демона, затем сборка | Успех за 2 с |

Третья и пятая строки объясняют, почему у этой ошибки такая неприятная репутация.

## Исправление по шагам

### 1. Определите Owner PID

Возьмите PID из ошибки и посмотрите на него, прежде чем что-либо завершать:

```bash
# macOS / Linux, any Gradle version
ps -o pid,stat,etime,command -p 52907
jps -l                                    # lists every JVM; Gradle daemons show as org.gradle.launcher.daemon.bootstrap.GradleDaemon
```

```powershell
# Windows PowerShell, any Gradle version
Get-CimInstance Win32_Process -Filter "ProcessId = 52907" | Select-Object ProcessId, CommandLine
Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
  Where-Object CommandLine -match 'GradleDaemon' |
  Select-Object ProcessId, CommandLine
```

Командная строка содержит версию Gradle демона и JDK, на котором он работает, а это подсказывает, кто его запустил. Демон из папки `jbr` Android Studio появился из синхронизации IDE. Буква `T` в столбце `stat` на macOS или Linux означает, что процесс остановлен. Если PID принадлежит процессу, который вообще не является демоном Gradle (демон компиляции Kotlin, JVM тестов), запомните это: так бывает, когда сборка запустила долгоживущую JVM с вашим домашним каталогом Gradle.

Если такого PID на вашей машине нет, владелец находится где-то ещё: в другом контейнере или ВМ с тем же каталогом `.gradle`. Переходите к разделу про CI ниже.

### 2. Завершите процесс, а не файл блокировки

```bash
# macOS / Linux (a stopped or hung JVM ignores a plain kill, so use -9)
kill -9 52907
```

```powershell
# Windows
Stop-Process -Id 52907 -Force
```

Когда владелец умирает, операционная система снимает его блокировку. Снова запустите `flutter run`, и сборка стартует нормально. Ничего удалять не нужно, и `flutter clean` тоже не нужен: он всё равно не трогает `~/.gradle`.

Чтобы разом завершить все демоны всех версий (полезно после долгого дня переключения между проектами):

```bash
# macOS / Linux: stops all Gradle daemons regardless of version
jps -l | awk '/GradleDaemon/{print $1}' | xargs kill
```

`./gradlew --stop` внутри `android/` подходит, когда владелец это здоровый демон *той же* версии Gradle, что и ваш wrapper. В документации Gradle прямо сказано, что команда "terminates all Daemon processes started with the same version of Gradle used to execute the command". Моё воспроизведение показывает оба сбоя: `--stop` другой версии даже не видит владельца, а `--stop` той же версии ждёт зависший демон, вместо того чтобы убить его.

### 3. Устраните причину зависания

Если один и тот же демон продолжает зависать, выясните почему, пока это не повторилось:

- **Куча.** Шаблон Flutter 3.44 задаёт `org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G` в `android/gradle.properties`. У проектов, созданных старыми версиями Flutter, значения часто намного меньше, а большое приложение с включённым R8 может довести демон до буксования в сборке мусора. Выполните `jstack <Owner PID>` до завершения процесса: дамп, полный кадров GC или `OutOfMemoryError`, подтверждает причину.
- **Два JDK.** Сделайте так, чтобы Flutter и Android Studio использовали один и тот же JDK и делили один демон вместо двух. `flutter doctor -v` печатает `Java binary at:`, который использует Flutter. Укажите в настройке Gradle JDK в Android Studio тот же JDK или направьте Flutter на JDK Android Studio через `flutter config --jdk-dir <path>`.
- **Защитное ПО.** Если ошибка появляется, когда два проекта собираются одновременно, а владелец здоров, подозревайте межсетевой экран или агент защиты, фильтрующий loopback UDP. Обновите Gradle wrapper проекта выше 8.12.1 (проекты из актуальных шаблонов Flutter уже выше), затем попросите ИТ-отдел сделать исключение для loopback-трафика вашего JDK.

## CI-раннеры и Docker

В CI Owner PID обычно живёт в другом задании. Работают три схемы:

1. **Один домашний каталог Gradle на задание.** Задайте `GRADLE_USER_HOME` как путь внутри рабочей области задания и используйте шаг кеширования CI, чтобы сохранять его между запусками. Тогда два живых процесса никогда не делят файл блокировки.
2. **Общий кеш зависимостей только для чтения.** `GRADLE_RO_DEP_CACHE` в Gradle указывает на заранее заполненный каталог `modules-2`, который Gradle читает без блокировок, а каждый контейнер хранит собственный доступный для записи домашний каталог. В документации Gradle эта возможность всё ещё помечена как incubating, и в общую копию нельзя писать, пока из неё читают сборки.
3. **Не оставляйте демоны.** `flutter build apk --no-android-gradle-daemon` (флаг по умолчанию равен true во Flutter 3.44.8) передаёт wrapper `--no-daemon`, поэтому JVM сборки завершается вместе со сборкой. Это не предотвращает конкуренцию между двумя одновременными заданиями, но убирает самого частого владельца: демон, оставшийся от предыдущего задания на повторно используемом раннере.

```yaml
# GitHub Actions, Flutter 3.44.8: per-job Gradle home, cached between runs
env:
  GRADLE_USER_HOME: ${{ github.workspace }}/.gradle-home
steps:
  - uses: actions/cache@v4
    with:
      path: ${{ github.workspace }}/.gradle-home/caches
      key: gradle-${{ runner.os }}-${{ hashFiles('android/**/*.gradle*', 'android/gradle/wrapper/gradle-wrapper.properties') }}
  - run: flutter build apk --release --no-android-gradle-daemon
```

Запуск контейнеров с сетью хоста тоже заставляет ping работать, но лишает изоляции, ради которой вы выбирали контейнеры, поэтому я бы сначала взял домашний каталог на задание.

## Почему совет "удалите файлы .lock" возвращается снова и снова

Самый популярный совет при этой ошибке: `find ~/.gradle -type f -name "*.lock" -delete`. Моё воспроизведение показывает, что он делает, пока владелец жив. Вторая сборка создала новый `journal-1.lock`, заблокировала его, а через 60 секунд упала по тайм-ауту на `caches/9.3.1/fileHashes/fileHashes.lock`, потому что замороженный демон удерживал и его. Удаление всех файлов блокировки позволяет новой сборке продолжить, но теперь два процесса считают, что владеют одними и теми же файлами кеша. Так люди приходят к `CorruptedCacheException` и полной очистке `~/.gradle/caches`, о чём сообщают в [gradle/gradle#30135](https://github.com/gradle/gradle/issues/30135).

Когда кажется, что это сработало, дело в том, что владелец тем временем завершил работу или умер. Завершение владельца даёт тот же результат без риска повреждения.

## Похожие ошибки

- **`Timeout waiting to lock file hash cache`, `build cache`, `Generated Gradle JARs cache`, `artifact cache`.** Тот же механизм и то же решение: найти Owner PID и завершить его. Меняется только имя кеша.
- **`Timeout waiting to lock ... It is currently in use by this process.`** Строки `Owner PID` нет. Конфликт между двумя потоками одной сборки, обычно из-за неправильного использования плагина или test kit ([gradle/gradle#35592](https://github.com/gradle/gradle/issues/35592)). Завершение демонов не поможет.
- **`Gradle task assembleDebug failed with exit code 1`** сама по себе. Так Flutter резюмирует то, на чём упал Gradle. См. [как прочитать настоящую ошибку за assembleDebug failed](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- **`e: Daemon compilation failed: null`.** Несмотря на слово "daemon", это демон компиляции Kotlin и ошибка с путями на разных дисках, описанная в [исправлении Daemon compilation failed](/ru/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).

## Связанные материалы

- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) объясняет, как достать собственный блок ошибки Gradle из сборки Flutter.
- [Migrating a Flutter Android project to AGP 9 with built-in Kotlin](/ru/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) описывает версии Gradle и AGP, которые фиксируют новые шаблоны.
- [Fix: A restricted method in java.lang.System has been called](/ru/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) ещё один случай, когда важно, на каком JDK работает ваш демон Gradle.
- [Targeting multiple Flutter versions from one CI pipeline](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) показывает матричные сборки, где домашние каталоги Gradle на задание окупаются.

## Источники

- Исходники Gradle, [`DefaultFileLockManager.java` на v9.8.0](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/DefaultFileLockManager.java) и [`DefaultFileLockContentionHandler.java`](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/locklistener/DefaultFileLockContentionHandler.java).
- Документация Gradle: [The Gradle Daemon](https://docs.gradle.org/current/userguide/gradle_daemon.html) (область действия `--stop`, совместимость демонов) и [Dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html) (блокировки кеша, `GRADLE_RO_DEP_CACHE`).
- [gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750), [#16299](https://github.com/gradle/gradle/issues/16299), [#31245](https://github.com/gradle/gradle/issues/31245), [#30135](https://github.com/gradle/gradle/issues/30135), [#8375](https://github.com/gradle/gradle/issues/8375).
- Flutter 3.44.8 `flutter_tools`, `lib/src/android/gradle.dart` и `lib/src/runner/flutter_command.dart` (флаг `--android-gradle-daemon`).

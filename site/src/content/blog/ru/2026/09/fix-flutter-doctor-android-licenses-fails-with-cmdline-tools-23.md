---
title: "Исправление: flutter doctor --android-licenses пишет 'The --licenses option is no longer needed' с cmdline-tools 23"
description: "В cmdline-tools 23.0 убрали sdkmanager --licenses, поэтому Flutter до 3.47.3 сообщает, что статус лицензий неизвестен. Обновите Flutter или закрепите cmdline-tools 22.0."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "android-sdk"
  - "flutter-doctor"
lang: "ru"
translationOf: "2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23"
translatedBy: "claude"
translationDate: 2026-09-15
---

С вашими лицензиями, скорее всего, всё в порядке. В Android SDK Command-line Tools 23.0 `sdkmanager` объявлен устаревшим, и `sdkmanager --licenses` теперь выводит баннер об устаревании и строку "Warning: The --licenses option is no longer needed.", после чего завершается с кодом 0, ничего не спрашивая. Flutter до версии 3.47.2 включительно ищет в этом выводе количество лицензий, ничего не находит и сообщает "Android license status unknown" независимо от того, что лежит на диске. Обновитесь до Flutter 3.47.3 или новее (исправление есть и в бете 3.48): эта версия читает `<sdk>/licenses/` напрямую. Если обновиться нельзя, установите cmdline-tools 22.0 и убедитесь, что в `cmdline-tools/` не осталось более новой копии.

Всё описанное ниже воспроизведено на macOS с Flutter 3.44.8 и Flutter 3.47.3, с cmdline-tools 22.0 и 23.0 рядом в тестовом SDK и с OpenJDK 17.0.20.1.

## Ошибка в том виде, в каком её выводит flutter doctor

`flutter doctor -v` помечает Android toolchain, хотя всё остальное зелёное:

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at /Users/you/Library/Android/sdk
    • Platform android-36, build-tools 36.1.0
    • Java version OpenJDK Runtime Environment Homebrew (build 17.0.20.1+0)
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
      See https://flutter.dev/to/macos-android-setup for more details.
```

Вы делаете, что сказано, и вместо привычного вопроса "Review licenses that have not been accepted (y/N)?" получаете вот это, а затем немедленный выход с кодом 0:

```text
WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.
The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.
To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)

Warning: The --licenses option is no longer needed.
```

Запустите `flutter doctor` снова, и строка "license status unknown" никуда не денется. Этот замкнутый круг и есть весь баг, о котором сообщили в [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487) (macOS, Flutter 3.47.1), а затем ещё раз в [#191558](https://github.com/flutter/flutter/issues/191558) (Windows 11) и [#191963](https://github.com/flutter/flutter/issues/191963) (Windows 10, Flutter 3.47.2).

## Почему Flutter не может определить, приняты ли ваши лицензии

`AndroidLicenseValidator` во Flutter сам файлы лицензий не читает. Он запускает `sdkmanager --licenses`, построчно читает stdout и сопоставляет его с тремя регулярными выражениями. Вот код из `packages/flutter_tools/lib/src/android/android_workflow.dart` на теге 3.44.8:

```dart
// Flutter 3.44.8, packages/flutter_tools/lib/src/android/android_workflow.dart
final licenseCounts = RegExp(r'(\d+) of (\d+) SDK package licenses? not accepted.');
final licenseNotAccepted = RegExp(r'licenses? not accepted', caseSensitive: false);
final licenseAccepted = RegExp(r'All SDK package licenses accepted.');
```

Если одно из них совпадает, статус становится `some`, `none` или `all`. Если не совпадает ни одно, валидатор возвращает `LicensesAccepted.unknown`, и это та самая строка, на которую вы смотрите.

cmdline-tools 22.0 уже выводит баннер об устаревании, но после него всё ещё выполняет проверку лицензий, так что регулярные выражения по-прежнему находят свою строку. На моём тестовом SDK, где был только `android-sdk-license`, 22.0 вывел:

```text
Loading local repository...

6 of 7 SDK package licenses not accepted.
Review licenses that have not been accepted (y/N)?
```

cmdline-tools 23.0 эту часть убирает полностью. Я дважды запустил `sdkmanager --licenses` из 23.0: один раз с папкой `licenses/` на месте и один раз, переименовав её. Вывод оба раза был одинаковым: баннер, предупреждение "no longer needed", код выхода 0. Инструмент больше никак не сообщает о состоянии лицензий, поэтому Flutter нечего разбирать. Автор PR с исправлением пришёл к тому же выводу и также не нашёл в новом CLI `android` подкоманды для проверки статуса лицензий.

Вторая половина замкнутого круга возникает там же. `flutter doctor --android-licenses` всего лишь обёртка, которая запускает `sdkmanager --licenses` в интерактивном режиме и передаёт ему ваши нажатия клавиш. Когда 23.0 выводит предупреждение и завершается, принимать нечего, и при следующем запуске `flutter doctor` Flutter нечего прочитать нового.

## Воспроизведение: матрица версий

Чтобы убедиться, что дело только в этом, я собрал тестовый корень SDK с `cmdline-tools/22.0` и `cmdline-tools/23.0`, направил на него `ANDROID_HOME` и запустил `flutter doctor -v` с каждой комбинацией. Flutter сначала ищет `cmdline-tools/latest/bin/sdkmanager`, а затем переходит к папке с наибольшим номером версии, так что для переключения достаточно спрятать папку `23.0`.

| Flutter | cmdline-tools | `licenses/` на диске | `flutter doctor` сообщает |
| --- | --- | --- | --- |
| 3.44.8 | 22.0 | только `android-sdk-license` | Some Android licenses not accepted |
| 3.44.8 | 22.0 | отсутствует | Android licenses not accepted |
| 3.44.8 | 23.0 | только `android-sdk-license` | Android license status unknown |
| 3.44.8 | 23.0 | отсутствует | Android license status unknown |
| 3.47.3 | 23.0 | только `android-sdk-license` | All Android licenses accepted |
| 3.47.3 | 23.0 | отсутствует | Android licenses not accepted |
| 3.47.3 | 23.0 | `android-sdk-license` есть, но пустой | Android licenses not accepted |

На Flutter без исправления 23.0 превращает любое состояние в "unknown". На 3.47.3 ответ снова зависит от файлов.

## Решение 1: обновите Flutter до 3.47.3 или новее

Исправление находится в [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554). Его влили в master 2026-08-29 и 2026-09-02 перенесли через cherry-pick в stable ([#192133](https://github.com/flutter/flutter/pull/192133)) и beta ([#192132](https://github.com/flutter/flutter/pull/192132)). Первые релизы, в которых оно есть: stable 3.47.3 и beta 3.48.0-0.4.pre. Запись о хотфиксе 3.47.3 в `CHANGELOG.md` прямо упоминает #191487.

```bash
# Flutter 3.47.x stable channel
flutter channel stable
flutter upgrade
flutter --version   # expect 3.47.3 or later
flutter doctor -v
```

Патч делает немного. Он добавляет ещё одно регулярное выражение, `--licenses option is no longer needed`. Когда появляется эта строка и ни один из старых шаблонов не совпал, Flutter перестаёт доверять stdout и просматривает содержимое `<sdk>/licenses/`. Любой нескрытый непустой файл там означает `all`. Отсутствие подходящего файла означает `none`. Если содержимое каталога прочитать не удаётся, результат `unknown`. Старые версии `sdkmanager` по-прежнему проходят через исходный разбор без изменений.

Если вы привязаны к более старой ветке Flutter (3.44.x, 3.41.x), бэкпорта нет. Cherry-pick попали только в ветки-кандидаты 3.47 и 3.48, так что на этих ветках используйте решение 3 или смиритесь с косметическим предупреждением.

## Решение 2: убедитесь, что лицензии действительно есть на диске

Прежде чем считать, что строка doctor врёт, проверьте. Принятие лицензий всегда записывалось в виде файлов с хешами в корне SDK, и именно их читает Gradle, когда решает, можно ли ему автоматически скачать недостающую платформу или пакет build-tools:

```bash
# any OS with a POSIX shell; ANDROID_HOME points at the SDK root
ls -la "$ANDROID_HOME/licenses"
cat "$ANDROID_HOME/licenses/android-sdk-license"
```

На рабочей машине вы увидите как минимум `android-sdk-license`, содержащий один или несколько 40-символьных хешей вроде `24333f8a63b6825ea9c5514f83c2829b004d1fee`. Если файл на месте, `flutter build apk` работает, что бы ни говорил `flutter doctor` без исправления. Автор issue заметил то же самое: сборки APK продолжали проходить успешно.

Если папки нет, например на совершенно новом CI-образе, то в cmdline-tools 23.0 способ её получить изменился. Вопроса больше нет. Установка любого пакета записывает файл лицензии за вас. Я проверил это на двух пустых корнях SDK, куда была скопирована только cmdline-tools 23.0 в качестве `latest`:

```bash
# cmdline-tools 23.0, fresh SDK root with no licenses/ folder
"$ANDROID_HOME/cmdline-tools/latest/bin/android" --no-metrics --sdk="$ANDROID_HOME" sdk install platform-tools

# or, the deprecated spelling, which forwards to the same code
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --install platform-tools
```

Обе команды завершились с кодом 0 при закрытом stdin, скачали `platform-tools_r37.0.1` и оставили после себя `licenses/android-sdk-license` с хешем `24333f8a...`. Этого достаточно, чтобы Flutter 3.47.3 сообщил "All Android licenses accepted". Обратите внимание на имена пакетов: новая `android sdk install` использует слеши (`platforms/android-36`, `build-tools/36.0.0`), а не точки с запятой, как `sdkmanager`.

## Решение 3: закрепите cmdline-tools 22.0 на старом Flutter

Если вы застряли на релизе Flutter без исправления и хотите, чтобы строка doctor была чистой, дайте Flutter такой `sdkmanager`, который всё ещё выводит количество лицензий. Flutter первым выбирает `cmdline-tools/latest`, поэтому установка 22.0 рядом с 23.0 в `latest` ничего не изменит. 23.0 придётся убрать с дороги.

В Android Studio откройте **Settings > Languages & Frameworks > Android SDK > SDK Tools**, отметьте **Show Package Details**, снимите отметку с **Android SDK Command-line Tools (latest)**, отметьте **22.0** и примените. Именно этот обходной путь подтвердил автор #191558.

Из терминала:

```bash
# macOS/Linux, cmdline-tools 23.0 currently installed as cmdline-tools/latest
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;22.0"
mv "$ANDROID_HOME/cmdline-tools/latest" "$HOME/cmdline-tools-23.0-backup"
ls "$ANDROID_HOME/cmdline-tools"   # only 22.0 should remain
flutter doctor --android-licenses
```

Установка попадает в `cmdline-tools/22.0`, и без `latest` Flutter переходит к этой папке с версией. После этого `flutter doctor --android-licenses` снова показывает настоящий интерактивный вопрос, и вы можете принять недостающие лицензии. В неинтерактивной оболочке `yes | flutter doctor --android-licenses` на 22.0 по-прежнему работает.

У этого пути два подвоха. Во-первых, это закрепление версии, и следующее "update all" в Android Studio вернёт 23.0 в качестве `latest`. Во-вторых, часть инструментов жёстко прописывает `cmdline-tools/latest/bin` (автоматическая загрузка SDK в Gradle, множество CI-скриптов). Когда лицензии приняты, чище обновить Flutter и позволить 23.0 вернуться, чем держать 22.0 вечно.

## Подводные камни и похожие ошибки

**"All Android licenses accepted" на 3.47.3 щедрее, чем раньше.** Проверка по файлам на диске не отличает `some` от `all`. Когда был только `android-sdk-license`, 22.0 сообщал "6 of 7 SDK package licenses not accepted", а старый Flutter говорил "Some Android licenses not accepted". 3.47.3 на 23.0 говорит "All Android licenses accepted". Для обычных сборок это верно, поскольку `android-sdk-license` покрывает платформы, build-tools, platform-tools и NDK. У образов системы для предварительных версий, TV и XR свои файлы лицензий (это остальные шесть из счёта 22.0), так что если вы установите один из них, ищите его файл в `licenses/`, а не доверяйте строке doctor.

**Пустой файл лицензии считается непринятым.** Некоторые CI-рецепты делают `touch` файла, чтобы изобразить принятие. На 3.47.3 `android-sdk-license` нулевого размера даёт "Android licenses not accepted". Запишите настоящий хеш или, что лучше, позвольте `android sdk install` создать его.

**CI-скрипты, которые делают grep по выводу doctor.** Шаг вроде `flutter doctor -v | grep "All Android licenses accepted"` падает на любом Flutter без исправления с 23.0. `yes | flutter doctor --android-licenses` больше не падает, но и ничего больше не делает. Проверяйте файл: `test -s "$ANDROID_HOME/licenses/android-sdk-license"`. Если вы проверяете несколько версий Flutter в одном конвейере, как в статье о [нацеливании на несколько версий Flutter из одного CI-конвейера](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), ожидайте, что старые элементы матрицы выведут "unknown", а 3.47.3 и новее пройдут.

**Бинарник `android` устанавливает себя при первом использовании.** Когда я впервые запустил `cmdline-tools/23.0/bin/android`, он вывел "Downloading Android CLI...", распаковался в `~/.android/cli` и показал условия использования SDK и уведомление о сборе метрик использования. В CI добавляйте `--no-metrics`. `android --version` с cmdline-tools 23.0 сообщил `1.0.16261425`. Этот бинарник есть и в 22.0.

**"Unable to locate Android SDK" это другая проблема.** Пока я собирал тестовый SDK, первый запуск doctor упал ещё до проверки лицензий, потому что в корне были cmdline-tools, но не было `platforms` и `build-tools`. Если вы видите эту строку или "cmdline-tools component is missing", решение в [статье о cmdline-tools component is missing](/ru/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), а не здесь.

**`flutter config --android-sdk` важнее `ANDROID_HOME`.** Если вы когда-то задали путь через `flutter config`, Flutter игнорирует `ANDROID_HOME` и может проверять не тот SDK, который смотрите вы. `flutter config --list` показывает сохранённый путь, а `flutter doctor -v` выводит фактически использованный путь в строке "Android SDK at".

**Новый CLI во Flutter пока не подключён.** Открытый PR [#191826](https://github.com/flutter/flutter/pull/191826) переводит на `android sdk install` и подготовку NDK во Flutter. На 2026-09-15 он не влит, так что Flutter 3.47.3 по-прежнему вызывает устаревший `sdkmanager` для лицензий и рассчитывает, что тот сохранит старые флаги.

## Связанные статьи

- [Исправление: flutter doctor сообщает, что cmdline-tools component is missing](/ru/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) описывает порядок поиска SDK во Flutter и требования `sdkmanager` к Java, которые действуют и здесь.
- Если на ваш JDK жалуется не doctor, а Gradle, смотрите [Toolchain installation does not provide the required capabilities](/ru/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/).
- Повреждённая загрузка SDK проявляется иначе: [NDK (Side by side): Not in GZIP format](/ru/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Ещё один случай, когда настоящее решение это релиз с хотфиксом: [Could not create Dart VM instance после flutter upgrade](/ru/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Источники

- [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487), основной issue с приоритетом P1, с дубликатами [#191558](https://github.com/flutter/flutter/issues/191558) и [#191963](https://github.com/flutter/flutter/issues/191963).
- [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), исправление, с cherry-pick в stable и beta [#192133](https://github.com/flutter/flutter/pull/192133) и [#192132](https://github.com/flutter/flutter/pull/192132).
- [flutter/flutter#191826](https://github.com/flutter/flutter/pull/191826), открытый PR для полной поддержки Android CLI.
- [Flutter CHANGELOG на 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/CHANGELOG.md) и [`android_workflow.dart` на 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/packages/flutter_tools/lib/src/android/android_workflow.dart).
- [Документация Android CLI](https://developer.android.com/tools/agents/android-cli) с синтаксисом `android sdk install`, `list`, `update` и `remove`.
- [Документация sdkmanager](https://developer.android.com/tools/sdkmanager).

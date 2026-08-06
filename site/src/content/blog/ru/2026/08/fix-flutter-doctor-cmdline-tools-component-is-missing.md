---
title: "Решение: flutter doctor сообщает cmdline-tools component is missing"
description: "Установите Android SDK Command-line Tools так, чтобы бинарники оказались в <sdk>/cmdline-tools/latest/bin, укажите ANDROID_HOME на корень SDK и запустите flutter doctor снова."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "dart"
  - "tooling"
lang: "ru"
translationOf: "2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing"
translatedBy: "claude"
translationDate: 2026-08-06
---

Решение в одном предложении: `flutter doctor` проверяет, существует ли каталог с именем `cmdline-tools` непосредственно в корне вашего Android SDK, и его там нет. В Android Studio откройте **Tools > SDK Manager > SDK Tools**, отметьте **Android SDK Command-line Tools (latest)** и нажмите Apply. Без Android Studio распакуйте архив command-line tools так, чтобы бинарники оказались в `<sdk-root>/cmdline-tools/latest/bin`, задайте `ANDROID_HOME` равным `<sdk-root>` (а не папке `cmdline-tools`), после чего выполните `flutter doctor --android-licenses`. Строка "Android license status unknown" ниже -- это следствие, а не вторая проблема: инструментом лицензий является `sdkmanager`, а `sdkmanager` поставляется внутри того самого пакета, которого у вас нет.

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Android SDK at C:\Users\mariu\AppData\Local\Android\Sdk
    ✗ cmdline-tools component is missing.
      Try installing or updating Android Studio.
      Alternatively, download the tools from https://developer.android.com/studio#command-line-tools-only and make sure to set the ANDROID_HOME environment variable.
      See https://developer.android.com/studio/command-line for more details.
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
```

Всё изложенное ниже проверено на Flutter 3.44.7 stable (Dart 3.12.x), стабильном канале по состоянию на 2026-08-06, с Android SDK, содержащим `cmdline-tools;19.0`, Build-Tools 36.0.0, Platform-Tools 37.0.0 и OpenJDK 21.0.11. Максимальная ревизия command-line tools в стабильном канале на сегодня -- 22.0.

## Проверка сводится к одному тесту существования каталога

Стоит понимать, насколько мало здесь делает doctor, потому что именно это объясняет большинство запутанных случаев. В `packages/flutter_tools/lib/src/android/android_workflow.dart` валидатор делает следующее:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
_task = 'Validating Android SDK command line tools are available';
if (!androidSdk.cmdlineToolsAvailable) {
  messages.add(
    const ValidationMessage.error(
      'cmdline-tools component is missing.\n'
      'Try installing or updating Android Studio.\n'
      ...
    ),
  );
  return ValidationResult(ValidationType.missing, messages);
}
```

А `cmdlineToolsAvailable` в `android_sdk.dart` -- это одна строка:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
bool get cmdlineToolsAvailable =>
    directory.childDirectory('cmdline-tools').existsSync();
```

Никакой бинарник не запускается. Никакая версия не разбирается. Flutter берёт разрешённый корень SDK, дописывает `cmdline-tools` и вызывает `existsSync()`. Это значит, что увидеть данное сообщение можно только двумя способами: папки действительно нет, либо Flutter разрешил другой корень SDK, не тот, на который смотрите вы.

Второй случай встречается достаточно часто, чтобы выписать порядок разрешения, который использует Flutter, из `locateAndroidSdk()`:

1. Ключ `android-sdk` в собственной конфигурации Flutter, задаваемый через `flutter config --android-sdk <path>`.
2. Переменная окружения `ANDROID_HOME`.
3. Переменная окружения `ANDROID_SDK_ROOT`, которую Google объявил устаревшей, но Flutter по-прежнему её читает.
4. Путь по умолчанию для платформы: `~/Android/Sdk` в Linux, `~/Library/Android/sdk` в macOS, `%LOCALAPPDATA%\Android\sdk` в Windows.
5. Последняя попытка: сканирование PATH в поисках `aapt` (внутри `build-tools/<version>/`) или `adb` (внутри `platform-tools/`) с выводом корня из их расположения.

Устаревший `flutter config --android-sdk`, оставшийся с позапрошлого ноутбука, побеждает совершенно корректный `ANDROID_HOME`. `flutter doctor -v` печатает путь, на котором инструмент остановился, и именно эту строку нужно читать первой.

Как только папка существует, отдельный поиск находит сам исполняемый файл. `getCmdlineToolsPath` пробует по порядку:

1. `cmdline-tools/latest/bin/sdkmanager[.bat]`
2. каталог `cmdline-tools/<version>/bin/sdkmanager[.bat]` с наибольшим номером
3. `tools/bin/sdkmanager[.bat]`, раскладку до 2020 года, которая для `sdkmanager` пропускается, поскольку он запрашивается с `skipOldTools: true`

То есть `latest` имеет приоритет, но каталог с номером версии тоже работает. Это различие важно для одного из подводных камней ниже.

## Воспроизведение за десять секунд

На рабочей машине ошибка находится в одном переименовании:

```bash
# Flutter 3.44.7 stable, Windows, Android SDK at %LOCALAPPDATA%\Android\Sdk
mv "$LOCALAPPDATA/Android/Sdk/cmdline-tools" "$LOCALAPPDATA/Android/Sdk/cmdline-tools.bak"
flutter doctor
```

Вот и весь режим отказа. По этой же причине совет "переустановите Android Studio" обычно срабатывает по неверной причине: свежая установка Studio ставит галочку на command-line tools, и папка появляется.

## Решение 1: установка через SDK Manager в Android Studio

Это рекомендуемый путь, если Android Studio у вас вообще есть, поскольку Studio ещё и поддерживает пакет в актуальном состоянии.

1. **Tools > SDK Manager** (или значок SDK Manager на панели инструментов).
2. Выберите вкладку **SDK Tools**.
3. Отметьте **Android SDK Command-line Tools (latest)**. Заодно убедитесь, что отмечены **Android SDK Build-Tools** и **Android SDK Platform-Tools**, они тоже нужны Flutter.
4. Нажмите **Apply**, примите лицензию и дождитесь загрузки.
5. Выполните `flutter doctor --android-licenses` и примите всё, затем снова `flutter doctor`.

Обратите внимание на суффикс "(latest)" в подписи флажка. Это не украшение: именно он заставляет Studio устанавливать в `cmdline-tools/latest/`, а не в каталог с номером.

## Решение 2: установка через sdkmanager, если какая-то версия уже есть

Если у вас есть хоть какие-то command-line tools, пусть даже старые, используйте их для установки актуального пакета:

```bash
# Android SDK Command-line Tools 19.0, JDK 21
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;latest"
```

В Windows бинарник называется `sdkmanager.bat`. Если для CI нужна воспроизводимая фиксация, а не движущаяся цель, укажите ревизию явно:

```bash
# Pin for CI. 22.0 is the newest on the stable channel as of 2026-08-06.
sdkmanager --install "cmdline-tools;22.0"
```

Здесь есть очевидная замкнутость: `sdkmanager` живёт внутри `cmdline-tools`, поэтому при отсутствии пакета вы не можете установить его с помощью `sdkmanager`. Для этого и нужно Решение 3.

## Решение 3: собрать пакет вручную

Это путь для Linux-машин без графической оболочки, для контейнеров и для всех, кому не нужен Android Studio. Скачайте архив "Command line tools only" со страницы загрузки Android Studio, затем соберите раскладку, которую ожидает инструментарий Google. Архив распаковывается в папку, буквально названную `cmdline-tools`, и это на один уровень меньше нужного.

```bash
# Android SDK Command-line Tools, Linux, 2026-08
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q commandlinetools-linux-*.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
```

Целевая раскладка, та самая, которую задаёт документация SDK Manager:

```text
$ANDROID_HOME/
└── cmdline-tools/
    └── latest/
        ├── bin/
        ├── lib/
        ├── NOTICE.txt
        └── source.properties
```

Для справки, `bin/` в реальной установке 19.0 (Windows, отсюда обёртки `.bat`) содержит:

```text
apkanalyzer.bat  avdmanager.bat  d8.bat     lint.bat      profgen.bat
r8.bat           resourceshrinker.bat  retrace.bat  screenshot2.bat  sdkmanager.bat
```

Затем сохраните окружение и добавьте инструменты в PATH:

```bash
# ~/.bashrc or ~/.zshrc
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`ANDROID_HOME` должен указывать на корень SDK. Указание его на `$HOME/Android/Sdk/cmdline-tools` или на `.../cmdline-tools/latest/bin` -- самая распространённая самостоятельно созданная разновидность этой ошибки, и она даёт ровно то же сообщение, потому что `<этот путь>/cmdline-tools` не существует.

Наконец, установите остальное, что нужно Flutter, и проверьте:

```bash
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager --version
sdkmanager --list_installed
flutter doctor --android-licenses
flutter doctor -v
```

`sdkmanager --list_installed` -- честная проверка. На машине, на которой писалась эта статья, она печатает:

```text
Installed packages:
  Path                  | Version       | Description                             | Location
  cmdline-tools;19.0    | 19.0          | Android SDK Command-line Tools (latest) | cmdline-tools\latest
  build-tools;36.0.0    | 36.0.0        | Android SDK Build-Tools 36              | build-tools\36.0.0
  platform-tools        | 37.0.0        | Android SDK Platform-Tools              | platform-tools
  platforms;android-36  | 2             | Android SDK Platform 36, rev 2          | platforms\android-36
```

## Решение 4: указать Flutter, где SDK находится на самом деле

Если папка существует и `sdkmanager --version` работает, а `flutter doctor` всё равно жалуется, значит Flutter смотрит в другое место. Переопределите порядок разрешения на первом же шаге:

```bash
flutter config --android-sdk "$HOME/Android/Sdk"
flutter doctor -v
```

Здесь две ловушки. `flutter config --android-studio-dir` -- это другая настройка, для установки Studio, а не для SDK, и указание её на `.../cmdline-tools/latest/bin` является задокументированным способом снова получить эту же ошибку. Кроме того, `flutter config` пишет в конфигурационный файл уровня пользователя, поэтому однажды заданное значение будет следовать за вами во все проекты, пока вы не сбросите его через `flutter config --android-sdk ""`.

## Подводные камни, выглядящие как та же ошибка

**"Observed package id 'cmdline-tools;19.0' in inconsistent location"**. Каждый вызов `sdkmanager` на моей машине печатает следующее:

```text
Warning: Observed package id 'cmdline-tools;19.0' in inconsistent location
'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\latest'
(Expected 'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\19.0')
```

Это косметика. Установленный пакет записывает `Pkg.Path=cmdline-tools;19.0` в свой `source.properties`, но SDK Manager разместил его в `latest`, потому что именно это и означает пакет "(latest)". `sdkmanager` продолжает работать, `flutter doctor` продолжает проходить. Не "исправляйте" это переименованием `latest` в `19.0`: Flutter всё равно нашёл бы его через поиск по номеру версии, но автоматическая загрузка SDK в Gradle и большинство CI-скриптов жёстко зашивают `cmdline-tools/latest/bin` и сломаются.

**Две папки `latest`**. Если вы видите `latest` рядом с `latest-2`, значит SDK Manager устанавливал поверх каталога, который не смог заменить, обычно потому, что процесс `sdkmanager` или `adb` держал дескриптор файла. Удалите `latest`, переименуйте `latest-2` в `latest` и снова запустите `flutter doctor`.

**`ANDROID_SDK_ROOT` задана, а `ANDROID_HOME` пуста**. Flutter читает обе и предпочитает `ANDROID_HOME`. Gradle и Android Gradle Plugin годами движутся в обратную сторону, а некоторые сторонние инструменты сейчас читают только `ANDROID_HOME`. Задавайте `ANDROID_HOME`; задавайте `ANDROID_SDK_ROOT` с тем же значением, только если что-то в вашем инструментарии всё ещё её требует.

**Другое сообщение: "Android sdkmanager not found."** Полностью: `Android sdkmanager not found. Update to the latest Android SDK and ensure that the cmdline-tools are installed to resolve this.` Это более поздняя проверка, и она означает, что папка прошла тест существования, но бинарник `sdkmanager` не найден ни в `latest/bin`, ни в каком-либо `bin` с номером версии. Обычная причина -- вложенная распаковка, `cmdline-tools/latest/cmdline-tools/bin/`, из-за переноса папки архива вместо её содержимого.

**Третье сообщение: "Android sdkmanager tool was found, but failed to run."** Полностью: `Android sdkmanager tool was found, but failed to run ($sdkManagerPath): "$error".` Бинарник существует и запускается; что-то внутри него бросает исключение. Запустите его напрямую, чтобы увидеть настоящую трассировку стека. Классический виновник -- `JAVA_HOME`, указывающий на старую среду выполнения, что проявляется как `UnsupportedClassVersionError` с "class file version 61.0" (Java 17) против среды, которая "recognizes class file versions up to 55.0" (Java 11). Command-line tools версии 11.0 и новее скомпилированы под Java 17. Более новые JDK в обратную сторону проблем не создают: 19.0 работает без нареканий на OpenJDK 21.0.11, проверено для этой статьи.

**WSL и контейнеры**. Не указывайте linux-овый `ANDROID_HOME` на Windows-овый SDK через `/mnt/c`. Linux-бинарников там нет, биты исполнения выставлены неверно, и вы будете гоняться за разновидностью "sdkmanager not found". Установите нативный SDK внутри Linux-окружения.

**CI-раннеры**. В GitHub Actions `android-actions/setup-android` устанавливает command-line tools и добавляет их в PATH до запуска чего-либо ещё, что полностью убирает этот класс отказов из пайплайна. Фиксируйте ревизию вместо следования за `latest`, если хотите, чтобы сборки полугодовой давности оставались воспроизводимыми, та же логика применима, когда вы [собираете под несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**Строка про лицензии сама не исчезнет**. После установки пакета `flutter doctor` продолжит сообщать `Android license status unknown`, пока вы не выполните `flutter doctor --android-licenses` и не примете каждую из них. В неинтерактивной оболочке задачу решает `yes | flutter doctor --android-licenses`.

## Похожие материалы

- [Решение: Gradle task assembleDebug failed with exit code 1 в Android-сборке Flutter](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- следующая стена, в которую вы упрётесь, когда инструментарий пройдёт проверку и сборка действительно начнётся.
- [Решение: конфликт AndroidX во время Android-сборки Flutter](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- отказ Android на уровне зависимостей, а не на уровне SDK.
- [Как собирать под несколько версий Flutter из одного CI-пайплайна](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- там, где фиксация версии SDK перестаёт быть необязательной.
- [Решение: Version solving failed в pubspec.yaml](/ru/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- аналог сломанного окружения со стороны Dart, с совершенно другой диагностикой.
- [Решение: Gradle build failed to produce an .apk file в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) -- та же обвязка Android SDK, но со стороны .NET.

## Источники

- [Troubleshooting installation](https://docs.flutter.dev/install/troubleshoot), документация Flutter, где показан путь через SDK Manager именно для этого вывода doctor.
- [sdkmanager](https://developer.android.com/tools/sdkmanager), документация Android Studio, про обязательную раскладку `cmdline-tools/latest` и флаги `--install`, `--list_installed`, `--sdk_root` и `--channel`.
- [Android SDK Command-Line Tools release notes](https://developer.android.com/tools/releases/cmdline-tools).
- `packages/flutter_tools/lib/src/android/android_workflow.dart` и `android_sdk.dart` в ветке stable репозитория [flutter/flutter](https://github.com/flutter/flutter), для текста валидатора и порядка разрешения SDK.
- [flutter/flutter#139288](https://github.com/flutter/flutter/issues/139288), где автор отчёта указал путь в конфигурации Flutter на `cmdline-tools/latest/bin` вместо корня SDK.
- [flutter/flutter#167413](https://github.com/flutter/flutter/issues/167413), всё ещё открытый отчёт о том, что doctor не обнаруживает корректно разложенный SDK на Debian 12 при заданной `ANDROID_SDK_ROOT` и пустой `ANDROID_HOME`.
- [android-actions/setup-android](https://github.com/android-actions/setup-android), про подход к CI.

---
title: "Исправление: Bad state: No suitable NDK found for target architecture arm64 в сборке Flutter"
description: "Хук сборки android_libcpp_shared (версии 0.2.0 и старше) не находит ваш NDK, либо ваш minSdk выше самого нового API в NDK. Обновитесь до 0.2.1+ или установите NDK, который покрывает ваш minSdk."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "ndk"
  - "native-assets"
lang: "ru"
translationOf: "2026/10/fix-no-suitable-ndk-found-for-target-architecture-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-07
---

Эта ошибка приходит не от Gradle и не от Flutter. Её выбрасывает Dart-хук сборки пакета `android_libcpp_shared` (версии с 0.1.0 по 0.2.0), который транзитивно подтягивают некоторые FFI-пакеты, например `croppy`. Причин две. Либо собственный поиск NDK в хуке не находит тот NDK, которым без проблем пользуется Gradle, либо каждый найденный NDK заканчивается на уровне API ниже `minSdk` вашего приложения. В первом случае обновите пакет до 0.2.1 или новее (через `dependency_overrides`, если он транзитивный). Во втором установите NDK, чей sysroot покрывает ваш `minSdk`: NDK r28c и r29 заканчиваются на API 35, поэтому для `minSdk = 36` нужен r30.

Всё ниже воспроизведено на macOS с Flutter 3.44.8 (Dart 3.12.2), Gradle 9.1.0 из шаблона Flutter, OpenJDK 17 и NDK r28c (`28.2.13676358`) в Android SDK по пути `/opt/homebrew/share/android-commandlinetools`. Исходный код хука `android_libcpp_shared` с 0.1.0 по 0.3.1 я прочитал прямо из архивов pub.dev.

## Ошибка в контексте

Это вывод `flutter build apk --debug --target-platform android-arm64` на только что созданном приложении с добавленным `android_libcpp_shared: 0.2.0` и без других изменений (длинные пути `--packages` сокращены):

```text
Unhandled exception:
Bad state: No suitable NDK found for target architecture arm64.
#0      main.<anonymous closure> (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:31:7)
<asynchronous suspension>
#1      build (package:hooks/src/api/build_and_link.dart:250:5)
<asynchronous suspension>
#2      main (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:12:3)
<asynchronous suspension>

  Building assets for package:android_libcpp_shared failed.
  build.dart returned with exit code: 255.
  To reproduce run:
  (cd .../android_libcpp_shared-0.2.0/; .../dart-sdk/bin/dart --packages=.../package_config.json .../hooks_runner/android_libcpp_shared/cbb4418675/hook.dill --config=.../input.json )
  stdout:
  INFO: Searching for android NDK...

Target dart_build failed: Error: Building native assets failed. See the logs for more details.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileFlutterBuildDebug'.
```

Архитектура в конце зависит от целевой платформы: `arm64`, `arm` или `x64`. Релизная сборка без `--target-platform` собирает все три, поэтому вы увидите ту ABI, которую хук-раннер попробует первой.

Деталь, которая всех сбивает с толку: Gradle уже определил NDK `28.2.13676358` на этой машине. Собственный Gradle-плагин Flutter принудительно скачивает этот NDK при каждой Android-сборке, так что NDK был установлен, корректен и использовался. Хук просто не посмотрел там, где он лежит.

## Зачем хуку сборки вообще нужен NDK

В текущих стабильных релизах Flutter пакеты могут поставлять `hook/build.dart`, который запускается во время `flutter build` и компилирует или упаковывает нативный код (возможность "native assets", или "build hooks", построенная на `package:hooks` и `package:code_assets`). Flutter запускает эти хуки в цели `dart_build`, до того как Gradle что-либо скомпилирует, и передаёт каждому хуку JSON-конфиг с целевой ОС, архитектурой, найденным Flutter компилятором C и `targetNdkApi`.

`android_libcpp_shared` существует ради упаковки `libc++_shared.so`, общей среды выполнения C++, которая нужна FFI-библиотекам, скомпилированным с `-stl=c++_shared`, во время загрузки. Для этого ему нужно найти NDK на диске, и в 0.2.0 и ранее он запускал собственный поиск вместо того, чтобы доверять NDK, переданному Flutter. В этом поиске две ситуации могут вернуть пустой результат, и обе заканчиваются одним и тем же `StateError`.

### Причина 1: хук ищет в меньшем наборе мест, чем Gradle

В 0.2.0 `NDKLocator.locate()` собирает кандидатов ровно из четырёх источников:

1. `ndk-build` в `PATH`, но он берёт родителя каталога NDK вместо самого каталога, поэтому этот источник никогда не срабатывал (в changelog 0.2.1 это указано как исправление).
2. Переменные окружения `ANDROID_NDK`, `ANDROID_NDK_HOME`, `ANDROID_NDK_LATEST_HOME` и `ANDROID_NDK_ROOT`.
3. Жёстко заданный glob для каждой ОС: `$HOME/Library/Android/sdk/ndk/*/` на macOS, `$HOME/Android/Sdk/ndk/*/` на Linux, `$HOME/AppData/Local/Android/Sdk/ndk/*/` на Windows.
4. `ndk/*/` внутри `ANDROID_HOME`, `ANDROID_SDK_ROOT` или `ANDROID_SDK_HOME`.

Чего он не читает, так это `sdk.dir` в `android/local.properties`, откуда Gradle на самом деле берёт SDK, и значение `android-sdk`, заданное через `flutter config --android-sdk`. Сам Flutter учитывает оба. Поэтому любой SDK вне стандартного расположения Android Studio и без экспортированной `ANDROID_HOME` для хука невидим: `android-commandlinetools` из Homebrew, произвольный диск на Windows, образ CI, который записывает только `local.properties`. На Windows есть вторая ловушка: glob раскрывает `$HOME` через `Platform.environment['HOME']!`, а `HOME` не задана в обычной сессии `cmd.exe`.

### Причина 2: ваш minSdk выше самого нового API в любом найденном NDK

Даже когда NDK найден, хук принимает его, только если в его sysroot есть каталог уровня API не ниже минимального SDK вашего приложения:

```dart
// android_libcpp_shared 0.2.0, lib/src/locate_ndk.dart
NDKApiLevel? highestMatching(int minApiLevel) {
  final suitableApiLevels =
      _apiLevels.where((api) => api.level >= minApiLevel).toList()
        ..sort((a, b) => b.level.compareTo(a.level));
  return suitableApiLevels.isNotEmpty ? suitableApiLevels.first : null;
}
```

`minApiLevel` - это `targetNdkApi` из конфига хука, а Flutter заполняет его из итогового `minSdk` вашего приложения: `FlutterPlugin.kt` читает `variant.mergedFlavor.minSdkVersion` и передаёт его в `flutter assemble` как `-dMinSdkVersion`. Каталоги API берутся из `toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/`. Я перечислил их для трёх актуальных NDK:

| NDK | Ревизия | Уровни API в sysroot |
|-----|---------|----------------------|
| r28c | `28.2.13676358` (`ndkVersion` по умолчанию во Flutter 3.44) | от 21 до 35 |
| r29 | `29.0.14206865` | от 21 до 35 |
| r30 | `30.0.16248370` | от 21 до 37 |

Так что `minSdk = 36` с NDK по умолчанию во Flutter не соберётся, как бы NDK ни находился. Эта проверка сохраняется и в 0.2.1, и в 0.3.x, только сообщение стало лучше. Она и сама по себе немного странная, потому что `libc++_shared.so` лежит на уровень выше, в `sysroot/usr/lib/<triple>/`, и вообще не зависит от API. Но таково правило, которое пакет навязывает, так что его нужно выполнить.

## Минимальное воспроизведение

Обе причины воспроизводятся на шаблонном приложении. Для причины 1 нужен SDK вне стандартного расположения и отсутствие `ANDROID_HOME`; для причины 2 подойдёт любая машина.

```bash
# Flutter 3.44.8, android_libcpp_shared 0.2.0, NDK r28c
flutter create --platforms=android -e ndkapp
cd ndkapp
flutter pub add android_libcpp_shared:0.2.0
flutter build apk --debug --target-platform android-arm64
```

Чтобы посмотреть, как хук видит вашу машину, без полной сборки Gradle, вызовите его локатор из одноразового консольного пакета. Именно так я разделял две причины:

```dart
// Dart 3.12.2, android_libcpp_shared 0.2.0
// bin/repro.dart  -  dart run bin/repro.dart 36
import 'package:android_libcpp_shared/src/locate_ndk.dart';

Future<void> main(List<String> args) async {
  final minSdk = int.parse(args.first);
  final ndks = await NDKLocator.locate();
  print('NDKs found: ${ndks.length}');
  for (final ndk in ndks) {
    final target = ndk.hostArchitectures.first.findTarget(LibArch.arm64);
    print('${ndk.path.toFilePath()} '
        'match(minSdk=$minSdk): ${target?.highestMatching(minSdk)}');
  }
}
```

На моей машине без `ANDROID_HOME` выводится `NDKs found: 0` (причина 1). С заданной `ANDROID_HOME` и аргументом `24` выводится `android-35`; с `36` выводится `null` (причина 2).

## Исправление по шагам

### 1. Выясните, кто зависит от android_libcpp_shared

Вы, скорее всего, сами его не добавляли:

```bash
# Flutter 3.44.8
flutter pub deps --style=compact | grep android_libcpp_shared
flutter pub deps --style=tree | grep -B5 android_libcpp_shared
```

На момент написания от него зависят на pub.dev следующие пакеты: `croppy` (1.5.3 жёстко фиксирует `0.1.0`), `flutter_piper_tts` (`^0.1.1`), `mecab_for_dart` и `than_audiotag` (`^0.2.1`), а также `liblsl` (`^0.3.0`). Если у вас разрешается 0.2.0 или старше, шаг 2 исправляет причину 1.

### 2. Обновитесь до 0.2.1 или новее

0.2.1 (опубликована 2026-08-12) переписала обнаружение. Она добавляет в кандидаты NDK, с которым собирает инструмент Flutter, определяя его по пути к компилятору C в конфиге хука, а также `sdk.dir` и `ndk.dir` из `local.properties`, `flutter config --android-sdk`, более длинный список известных каталогов и исправленный поиск через `PATH`. Ещё она читает `USERPROFILE` на Windows.

Если зависимость прямая, поднимите версию. Если она транзитивная и зафиксирована, переопределите её:

```yaml
# pubspec.yaml, Flutter 3.44.8
dependency_overrides:
  android_libcpp_shared: ^0.2.1
```

Какую линейку выбрать, зависит от версии Flutter. 0.2.x зависит от `code_assets ^1.0.0` и `hooks ^2.0.2`. 0.3.0 и 0.3.1 переходят на `code_assets ^2.0.0`. Сам `flutter_tools` во Flutter 3.44.8 фиксирует `code_assets 1.0.0`, поэтому на 3.44 я рекомендую `^0.2.1`, именно её я и проверял. С 0.2.1 и без `ANDROID_HOME` то же шаблонное приложение собирается, а APK содержит `lib/arm64-v8a/libc++_shared.so`.

Переопределения действуют на весь граф, поэтому проверьте, что пакет, фиксирующий старую версию, по-прежнему работает с новой. Для `croppy`, который использует `android_libcpp_shared` только ради побочного эффекта хука, ломать нечего: API он не вызывает.

### 3. Если обновиться нельзя: дайте старому хуку путь, который он ищет

На 0.2.0 или старше экспортируйте перед сборкой одну из переменных, которые он читает:

```bash
# macOS / Linux, android_libcpp_shared 0.2.0
export ANDROID_HOME="$HOME/path/to/your/android/sdk"
flutter clean
flutter build apk
```

```powershell
# Windows PowerShell, android_libcpp_shared 0.2.0
$env:ANDROID_HOME = "D:\Android\Sdk"
$env:HOME = $env:USERPROFILE
flutter clean
flutter build apk
```

Эта переменная должна быть в окружении того, что запускает сборку. В моих тестах с `flutter build` и Gradle 9.1.0 прогретый демон Gradle подхватывал новое значение при следующей сборке, в обе стороны. Проблема возникает с Android Studio, запущенной из Dock, меню "Пуск" или лаунчера: GUI-приложения не читают `~/.zshrc`, поэтому `flutter run` из IDE падает, а та же команда в терминале работает. Запускайте IDE из оболочки с этой переменной или используйте шаг 2.

Не пропускайте `flutter clean` при проверке. Flutter кеширует результаты хуков в `.dart_tool/`, и в моём воспроизведении сборка без `ANDROID_HOME` продолжала проходить, потому что переиспользовала успешный результат хука из предыдущей сборки. Вам будет казаться, что исправление работает, пока чистый раннер CI не докажет обратное.

### 4. Если ваш minSdk выше 35: установите NDK, который его покрывает

При причине 2 единственное верное исправление - NDK, sysroot которого доходит до вашего `minSdk`. Задайте его явно, чтобы Gradle скачивал его на каждой машине и раннере CI:

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1
android {
    ndkVersion = "30.0.16248370" // NDK r30: sysroot API levels 21 to 37
    defaultConfig {
        minSdk = 36
    }
}
```

0.2.1 и новее сортируют все найденные NDK по версии и берут самый новый, прошедший проверку API, так что достаточно, чтобы r30 был установлен рядом с r28c. Прежде чем что-то менять, проверьте установленные NDK сами:

```bash
# any NDK r23 or later; the host folder is darwin-x86_64 even on Apple silicon
ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/
```

Наибольшее число в этом списке - это наибольший `minSdk`, который данный NDK может удовлетворить для этого хука.

## Переопределение libcpp_shared_path и ловушка с несколькими ABI

0.2.1 также добавила запасной выход: пользовательское определение, которое указывает прямо на библиотеку. Итоговое сообщение об ошибке в 0.2.1 и новее даже предлагает его:

```yaml
# pubspec.yaml, android_libcpp_shared 0.2.1
hooks:
  user_defines:
    android_libcpp_shared:
      libcpp_shared_path: /path/to/ndk/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so
```

Когда значение - файл, оно полностью пропускает обнаружение NDK и проверку API, поэтому сборка с `minSdk = 36` действительно становится зелёной. Но это один путь для всех архитектур. Я собрал релизный APK с этим переопределением и осмотрел его:

```text
lib/arm64-v8a/libc++_shared.so:   ELF 64-bit LSB shared object, ARM aarch64
lib/armeabi-v7a/libc++_shared.so: ELF 64-bit LSB shared object, ARM aarch64
lib/x86_64/libc++_shared.so:      ELF 64-bit LSB shared object, ARM aarch64
```

В слотах 32-битной ARM и x86_64 теперь лежит библиотека arm64. Сборка проходит, приложение выходит в релиз, а на любом устройстве или эмуляторе не под arm64 загрузка библиотеки падает. Используйте путь к файлу только при сборке одной ABI (`--target-platform android-arm64`). Если указать в пользовательском определении или в переменной окружения `ANDROID_LIBCPP_SHARED_PATH` корневой каталог NDK, хук корректно разрешит каждую архитектуру, но этот путь снова проходит через проверку API, так что причину 2 он не обходит.

## Что печатают новые версии

Если вы на 0.2.1 или новее и всё равно падаете, формулировки "No suitable NDK" вы не увидите. Хук теперь выбрасывает более длинный `StateError`, перечисляющий каждый рассмотренный NDK. Моё воспроизведение с `minSdk = 36` на 0.2.1 дало:

```text
Could not find libc++_shared.so for target architecture arm64 (minimum NDK API level 36).
NDK installations considered:
  - 1 NDK installation(s) found, but none support arm64 at API level 36
```

"Found, but none support ... at API level" - это причина 2, и применим шаг 4. "No Android NDK installation was found" - это причина 1 на машине, где не помогает даже расширенный поиск, что обычно означает, что NDK так и не был скачан: сначала выполните одну сборку Gradle любого Android-проекта или установите его командой `sdkmanager "ndk;28.2.13676358"`.

## Похожие ошибки

- `NDK at .../ndk/<version> did not have a source.properties file` означает наполовину распакованный NDK, и исправление - удалить этот каталог. Эта и другие проблемы несоответствия версий NDK разобраны в [разборе ошибки assembleDebug с кодом выхода 1](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- `An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format` означает, что сама загрузка NDK повреждена. См. [как очистить кеш загрузок SDK Manager](/ru/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- `No toolchains found in the NDK toolchains folder for ABI with prefix: mips64el-linux-android` - это старый Android Gradle Plugin, работающий с новым NDK. К хукам сборки это не имеет отношения.
- `Building native assets failed` с другим исключением выше - это хук другого пакета. Прочитайте строку `Building assets for package:<name> failed`, чтобы понять, какой именно.

## Связанные материалы

- [Google Play отклоняет приложение Flutter из-за размера страницы 16 KB](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) - ещё одно место, где закреплённая версия NDK решает, выйдет ли релиз.
- [Тайм-аут блокировки журнального кеша Gradle](/ru/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/) рассказывает, почему демоны Gradle переживают сборку, которая их запустила.
- [Разрешение конфликтов AndroidX в Android-сборке Flutter](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/) разбирает настройки `android/app/build.gradle`, включая `ndkVersion`.

## Источники

- [android_libcpp_shared на pub.dev](https://pub.dev/packages/android_libcpp_shared), включая [changelog](https://pub.dev/packages/android_libcpp_shared/changelog) для 0.2.1 и 0.3.x.
- [NexusDynamic/android_libcpp_shared на GitHub](https://github.com/NexusDynamic/android_libcpp_shared), исходный код хука и `locate_ndk.dart`.
- [Документация Flutter: hooks и native assets](https://docs.flutter.dev/platform-integration/bind-native-code).
- [package:hooks](https://pub.dev/packages/hooks) и [package:code_assets](https://pub.dev/packages/code_assets), протокол хуков сборки.
- [История ревизий Android NDK](https://developer.android.com/ndk/downloads/revision_history) для r28c, r29 и r30.
- Исходный код `flutter_tools` Flutter 3.44.8: `lib/src/android/gradle_utils.dart` (`ndkVersion` по умолчанию), `lib/src/android/android_sdk.dart` (`getNdkBinaryPath`) и `gradle/src/main/kotlin/FlutterPlugin.kt` (`-dMinSdkVersion`).

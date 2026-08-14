---
title: "Решение: An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format"
description: "SDK Manager заново распаковывает повреждённый архив, который он закешировал в .downloadIntermediates. Удалите эту папку и наполовину распакованный каталог ndk/<version>, затем пересоберите."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "ndk"
lang: "ru"
translationOf: "2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format"
translatedBy: "claude"
translationDate: 2026-08-14
---

Удалите кеш загрузок SDK Manager и частично распакованный каталог NDK, затем соберите проект снова. Архив, который он распаковывает, повреждён, и, поскольку архив кешируется, каждая следующая попытка будет падать одинаково, пока вы его не удалите. В Windows это `%LOCALAPPDATA%\Android\Sdk\.downloadIntermediates` плюс `%LOCALAPPDATA%\Android\Sdk\ndk\28.2.13676358`. Если после очистки кеша сборка падает снова, значит, вы за прокси или за антивирусом с инспекцией TLS, который переписывает загрузку размером 750 МБ, и ответ здесь один: установить NDK вручную с `dl.google.com`.

## Полный текст ошибки

Сообщение появляется посреди сборки, обычно на этапе конфигурации Gradle, и представляет собой строку предупреждения, а не сам верхнеуровневый сбой:

```
Preparing "Install NDK (Side by side) 28.2.13676358 v.28.2.13676358".
Warning: An error occurred while preparing SDK package NDK (Side by side) 28.2.13676358: Not in GZIP format.

FAILURE: Build failed with an exception.
```

Под ним лежит `java.util.zip.ZipException: Not in GZIP format`, брошенное из `GZIPInputStream`, а номер версии зависит от того, что зафиксировано в вашем проекте. Этот конкретный сбой опознаётся по двум признакам: имени пакета `NDK (Side by side)` и тому, что он воспроизводится байт в байт при каждой попытке, в том числе после перезагрузки, после `flutter clean` и после перезапуска Android Studio. По-настоящему нестабильная сеть каждый раз даёт другую ошибку. Эта не даёт.

## Из-за чего сборка Flutter вообще скачивает NDK?

Именно этот момент застаёт людей врасплох: приложение на Flutter без нативного кода, без C++ и без блока `externalNativeBuild` всё равно скачивает NDK размером 750 МБ при первой сборке. Так задумано, и это работа Flutter, а не Android Gradle Plugin.

AGP нужен NDK, чтобы убирать отладочные символы из нативных библиотек, но скачивает он NDK только тогда, когда считает, что компилирует нативный код. Flutter всегда поставляет нативные библиотеки (движок и ваш скомпилированный AOT-кодом Dart), поэтому очистка символов ему нужна, и он обманом заставляет AGP забрать toolchain. Проверено на локальной установке Flutter 3.44.2 stable: `FlutterPlugin.kt` вызывает это безусловно в строке 228:

```kotlin
// Flutter 3.44.2, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun forceNdkDownload(gradleProject: Project, flutterSdkRootPath: String) {
    val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)
    val forcingNotRequired: Boolean =
        gradleProjectAndroidExtension.externalNativeBuild.cmake.path != null
    if (forcingNotRequired) {
        return
    }

    // Otherwise, point to an empty CMakeLists.txt, and ignore associated warnings.
    gradleProjectAndroidExtension.externalNativeBuild.cmake.path(
        "$flutterSdkRootPath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt"
    )
    // ...
}
```

`CMakeLists.txt`, на который он указывает, это пустой файл, единственное назначение которого убедить AGP, что есть нативный код для сборки. Значит, загрузка NDK не опциональна, её нельзя пропустить, и с ней сталкивается каждая новая машина и каждый новый CI-раннер. Загрузка размером три четверти гигабайта, выполняемая один раз на окружение, это ровно тот профиль, который порождает обрезанные архивы.

Скачиваемая версия задаётся Flutter, а не вами. Та же установка, `packages/flutter_tools/lib/src/android/gradle_utils.dart`, строка 68:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/android/gradle_utils.dart
const ndkVersion = '28.2.13676358';
```

Это NDK r28c. Я проверил установленную копию на этой машине: `ndk/28.2.13676358/source.properties` содержит `Pkg.ReleaseName = r28c`, так что соответствие ревизии и релиза здесь не догадка.

## Почему архив не проходит проверку GZIP?

Причины упорядочены по тому, как часто каждая из них оказывается настоящей.

**Повреждённый архив в кеше `.downloadIntermediates`.** SDK Manager складывает загрузку пакета в `<sdk>/.downloadIntermediates` перед распаковкой. Если соединение оборвалось, диск заполнился или процесс был убит на середине, в этом каталоге остаётся обрезанный файл. Загрузчик считает закешированный файл возобновляемой загрузкой и на следующей попытке передаёт его прямо распаковщику, поэтому повторные попытки воспроизводят одно и то же исключение бесконечно. В подавляющем большинстве обращений причина именно эта, и потому фраза "я уже пробовал пять раз" ничего не опровергает.

**Прокси или антивирус с инспекцией TLS, переписывающий ответ.** `GZIPInputStream` бросает ровно эту строку, когда первые два байта не совпадают с сигнатурой gzip `1f 8b`. Корпоративный прокси, отвечающий HTML-страницей блокировки, captive portal, перехватывающий запрос, или сканер, выставляющий `Content-Encoding: gzip` на теле, которое он на самом деле не сжимал, все дают поток, проваливающий проверку сигнатуры на первом же байте. Признак такой: очистка кеша не помогает, вы получаете свежую и столь же непригодную загрузку.

**Переполненный диск.** Загрузка на 750 МБ плюс распаковка на 4 ГБ требуют запаса, который SDK Manager заранее не проверяет. Он пишет сколько может, и обрезанный результат падает точно так же.

## Как очистить кеш загрузок и наполовину распакованный NDK?

Сначала закройте Android Studio: в Windows она удерживает дескрипторы этих каталогов. Корень SDK находится в `%LOCALAPPDATA%\Android\Sdk` в Windows, в `~/Library/Android/sdk` в macOS и в `~/Android/Sdk` в Linux.

```bash
# macOS / Linux. Adjust SDK for your platform.
SDK="$HOME/Library/Android/sdk"
rm -rf "$SDK/.downloadIntermediates" "$SDK/.temp" "$SDK/temp" "$SDK/downloadIntermediates"
rm -rf "$SDK/ndk/28.2.13676358"
```

```powershell
# Windows PowerShell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Remove-Item -Recurse -Force "$sdk\.downloadIntermediates","$sdk\.temp","$sdk\temp","$sdk\downloadIntermediates" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$sdk\ndk\28.2.13676358" -ErrorAction SilentlyContinue
```

Оба написания, с ведущей точкой и без неё, встречаются в разных версиях Android Studio, поэтому удаляйте те, что существуют, а на отсутствующие не обращайте внимания. В установке, которую я изучал для этой статьи, SDK содержит `.temp` с ведущей точкой.

Удаление каталога `ndk/<version>` важно не меньше, чем очистка кеша, и это тот шаг, который пропускает большинство инструкций. О причине читайте дальше.

## Что делать, если следующая сборка падает с CXX1101?

Так происходит потому, что неудавшаяся распаковка оставила после себя неполный каталог, и теперь на него натыкается другая ветка кода.

```
> [CXX1101] NDK at /Users/you/Library/Android/sdk/ndk/28.2.13676358
  did not have a source.properties file
```

AGP определяет установленный NDK, читая `source.properties` внутри `ndk/<revision>/`. SDK Manager пишет этот файл последним, уже после полной распаковки архива, именно чтобы недоделанную установку нельзя было принять за исправную. Когда распаковка умирает на ошибке gzip, у вас остаётся каталог, полный файлов toolchain, и без `source.properties`, то есть не отсутствующий и не пригодный.

С этого момента SDK Manager видит каталог по ожидаемому пути и не скачивает заново, а AGP не видит `source.properties` и отказывается его использовать. Сборка застревает между двумя компонентами, которые расходятся во мнении, существует ли пакет, а текст ошибки меняется на что-то на вид совсем не связанное. Именно поэтому многие обсуждения на эту тему заканчиваются тем, что люди прописывают `ndk.dir` в `local.properties` или фиксируют более старую версию NDK: они обходят вторую ошибку, так и не устранив первую. Удалите каталог, и обе исчезнут разом.

Для справки, корректно установленная копия содержит оба файла:

```
ndk/28.2.13676358/source.properties   # Pkg.Revision = 28.2.13676358, Pkg.ReleaseName = r28c
ndk/28.2.13676358/package.xml         # written by the SDK Manager, not present in the standalone zip
```

## Как установить NDK из командной строки?

Если убрать из цепочки Gradle и Android Studio, сбой становится намного понятнее, а `sdkmanager` печатает исходную трассировку стека вместо однострочного предупреждения. Исполняемый файл лежит в `<sdk>/cmdline-tools/latest/bin`. Если его там нет, предварительно потребуется [установить Android SDK Command-line Tools](/ru/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/).

```bash
# Android SDK Command-line Tools 19.0, NDK r28c
cd "$HOME/Library/Android/sdk/cmdline-tools/latest/bin"
./sdkmanager --install "ndk;28.2.13676358" --verbose
```

Если вы за прокси, укажите его явно, а не полагайтесь на настройки Studio, которые `sdkmanager` не читает:

```bash
./sdkmanager --install "ndk;28.2.13676358" \
  --proxy=http --proxy_host=proxy.corp.example --proxy_port=8080
```

Не хватайтесь за `--no_https` как за решение. Он понижает передачу до обычного HTTP, из-за чего перехватывающий прокси скорее испортит тело ответа, а не наоборот. Этот флаг существует для окружений, полностью блокирующих CONNECT.

## Как установить NDK вручную, если загрузчик продолжает падать?

Это надёжный запасной путь в закрытой сети, потому что он переносит загрузку в инструмент, который контролируете вы, и позволяет проверить байты.

1. Скачайте отдельный архив по адресу `https://dl.google.com/android/repository/android-ndk-r28c-linux.zip`, подставив `windows` для Windows. Для macOS по этому URL отдаётся `.dmg`, а не zip, поэтому смонтируйте его и скопируйте содержимое.

2. Проверьте SHA-1 против значения, опубликованного на странице загрузок NDK, прежде чем доверять файлу. Для r28c zip для Linux весит 722 261 334 байта с SHA-1 `a7b54a5de87fecd125a17d54f73c446199e72a64`, а zip для Windows весит 748 118 221 байт с SHA-1 `086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d`. Если хеш не совпал, ваш прокси подтверждён как виновник и никакая очистка кеша не поможет.

```bash
# Verify, then unpack. NDK r28c.
sha1sum android-ndk-r28c-linux.zip
unzip -q android-ndk-r28c-linux.zip
```

3. Переименуйте распакованный каталог `android-ndk-r28c` в номер ревизии и перенесите его в SDK. AGP ищет именно ревизию, а не имя релиза:

```bash
mv android-ndk-r28c "$HOME/Android/Sdk/ndk/28.2.13676358"
cat "$HOME/Android/Sdk/ndk/28.2.13676358/source.properties"
# Pkg.Revision = 28.2.13676358
```

4. Соберите проект. AGP читает `source.properties` и принимает toolchain. Единственное отличие от управляемой установки это отсутствующий `package.xml`, из-за чего `sdkmanager --list_installed` не покажет пакет. Для сборки это косметика, но имеет значение, если ваш CI проверяет список пакетов, а не наличие каталога.

## Какая версия NDK на самом деле нужна проекту?

Та, которую фиксирует ваш проект, а по умолчанию её фиксирует за вас Flutter. По состоянию на август 2026 года:

| Роль | Релиз NDK | Строка ревизии |
| --- | --- | --- |
| По умолчанию во Flutter 3.44 | r28c | `28.2.13676358` |
| Последняя стабильная | r29 | `29.0.14206865` |
| Последняя LTS | r27d | `27.3.13750724` |

Не "чините" эту ошибку откатом на NDK, который случайно оказался закеширован на вашей машине. NDK r28 это первый релиз, собирающий разделяемые библиотеки с выравниванием под страницы памяти 16 КБ, чего Google Play теперь требует, поэтому откат на r27 ради обхода проблемы с загрузкой меняет ошибку сборки на [отклонение в магазине](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

Иногда версию действительно нужно поднять, когда плагину нужен toolchain новее, чем стандартный для Flutter. Flutter это замечает и прямо говорит, что писать:

```
Your project is configured with Android NDK 28.2.13676358, but the following
plugin(s) depend on a different Android NDK version:
- some_plugin requires Android NDK 29.0.14206865
Fix this issue by using the highest Android NDK version (they are backward compatible).
```

```kotlin
// android/app/build.gradle.kts, AGP 8.x
android {
    ndkVersion = "29.0.14206865"
}
```

Изменение этой строки запускает свежую загрузку другого пакета, поэтому, если вы всё ещё в сети, которая портит крупные передачи, установите новую ревизию вручную до того, как менять зафиксированное значение. Иначе вы просто увидите, как та же ошибка переезжает на новый номер версии.

## Ловушки, дающие то же сообщение по другой причине

**Образы Docker и CI с малым запасом на слой.** Контейнер сборки, у которого посреди распаковки заканчивается место для записи, падает точно так же, как при обрезанной загрузке. Проверьте свободное место на томе SDK, прежде чем винить сеть. Запекание NDK в образ это долгосрочное решение, и оно убирает загрузку на 750 МБ из каждой задачи.

**Две сборки, конкурирующие за один SDK.** Параллельные задачи CI, разделяющие смонтированный каталог SDK, чередуют записи в `.downloadIntermediates` и портят архивы друг друга. Дайте каждой задаче собственный `ANDROID_SDK_ROOT` или сделайте первичную установку последовательной.

**`Failed to install the following Android SDK packages as some licences have not been accepted`.** Другая ошибка, тот же этап сборки. Она лечится через `sdkmanager --licenses`, а не очисткой кешей.

**Обобщённое `Gradle task assembleDebug failed with exit code 1`.** Эта строка лишь обёртка, а предупреждение про gzip может оказаться намного выше по логу. Если настоящей причины не видно, [сначала пересоберите с подробным выводом](/ru/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/), а не гадайте.

**Сбой `.gz` на собственном шаге загрузки плагина.** Некоторые плагины забирают свои предсобранные бинарники на этапе конфигурации. Если имя падающего пакета не `NDK (Side by side)`, эта статья не про вашу проблему.

## Похожие материалы

Если сборка была нездорова ещё до того, как в игру вступила загрузка NDK, [конфликты AndroidX при сборке Flutter под Android](/ru/2026/05/fix-androidx-conflict-during-flutter-android-build/) и [несовпадения minSdkVersion из-за плагинов](/ru/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) чаще всего и лежат в основе сбоя первого запуска на новой машине. Для команд, где каждый раннер оплачивает эту загрузку один раз, материал про [работу с несколькими версиями Flutter из одного пайплайна CI](/ru/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) разбирает, как правильно кешировать SDK, чтобы это происходило раз на образ, а не раз на задачу.

## Источники

- [NDK Downloads](https://developer.android.com/ndk/downloads), для строк ревизий r29, r28c и r27d, размеров архивов и приведённых выше контрольных сумм SHA-1.
- [Справочник по командной строке sdkmanager](https://developer.android.com/studio/command-line/sdkmanager), для `--install`, `--sdk_root`, `--verbose` и тройки `--proxy`, `--proxy_host`, `--proxy_port`.
- [NDK does not have Source properties file in my project](https://github.com/flutter/flutter/issues/164085) и [New, default Flutter Projects fail on build with NDK...did not have a source.properties file](https://github.com/flutter/flutter/issues/102831), для последующего сбоя CXX1101 и обходных путей, к которым прибегают вместо очистки кеша.
- [Android NDK version doesn't seem to be right for new projects](https://github.com/flutter/flutter/issues/163945), о том, как выбирается ревизия по умолчанию во Flutter и когда плагин вынуждает поднять её выше.
- Исходный код процитирован из локальной установки Flutter 3.44.2 stable: `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`, `FlutterPluginUtils.kt`, `FlutterExtension.kt`, `packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt` и `packages/flutter_tools/lib/src/android/gradle_utils.dart`.
- Детали структуры SDK проверены на Android SDK этой машины: `ndk/28.2.13676358/source.properties` (`Pkg.ReleaseName = r28c`), `ndk/28.2.13676358/package.xml` и каталог кеша `.temp` с ведущей точкой.

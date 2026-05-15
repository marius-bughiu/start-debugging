---
title: "Исправление: сборка Gradle не смогла создать файл .apk в MAUI Android"
description: "В девяти случаях из десяти настоящая ошибка Gradle спрятана выше в логе MSBuild. Путь к JDK 17, отсутствующий workload maui-android и длинные пути в Windows -- обычные первопричины."
pubDate: 2026-05-15
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "android"
  - "gradle"
lang: "ru"
translationOf: "2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android"
translatedBy: "claude"
translationDate: 2026-05-15
---

Решение: эта ошибка MSBuild почти никогда не является настоящей ошибкой. Прокрутите лог сборки вверх дальше неё, пока не наткнётесь на первую строку `error` от `gradlew.bat` или `aapt2`. В девяти случаях из десяти настоящая причина -- одна из трёх вещей: `JAVA_HOME` указывает на JDK 11 (Android Gradle Plugin 8.x в MAUI 11 требует JDK 17), workload `android` или `maui-android` не был восстановлен после обновления .NET SDK, или нарушение длины пути в Windows обрезало обфусцированный вывод R8. Исправьте первопричину, и `.apk` будет создан при следующей сборке.

```text
C:\Program Files\dotnet\sdk\11.0.100\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.RuntimeIdentifierInference.targets(311,5):
error XA1029: The Gradle build failed to produce an .apk file. Please check the diagnostic log.
```

Это руководство написано для .NET 11 GA, target framework `net11.0-android`, .NET MAUI 11.0.0 и Android Gradle Plugin (AGP), поставляемого с `Xamarin.Android.Sdk` 35.x (версией, которую Microsoft фиксирует для `dotnet workload install android` в .NET 11). Код `XA1029` поднимается из `Xamarin.Android.Build.Tasks` после того, как `gradlew assembleDebug` или `assembleRelease` завершаются с ненулевым кодом. Текст "failed to produce an .apk file" -- это обёртка, а не причина.

## Почему MAUI Android оборачивает настоящую ошибку Gradle

MAUI не вызывает Gradle напрямую во время обычного `dotnet build`. Специфичный для Android target MSBuild (`_CompileToDalvikWithD8`, `_GenerateAndroidPackage`) пишет сгенерированный `build.gradle.kts` в `obj/Debug/net11.0-android/<rid>/android/`, а затем вызывает встроенный `gradlew.bat` (Windows) или `gradlew` (macOS, Linux). Когда `gradlew` завершается с ненулевым кодом, задача MSBuild проглатывает многотысячный лог Gradle в один диагностический файл `obj/Debug/net11.0-android/<rid>/android/build.log` и выдаёт `XA1029`. Visual Studio показывает только обёртку. Настоящая трассировка стека, отсутствующая зависимость, отказ JDK или сбой подписи находятся в `build.log` и в строках непосредственно над `XA1029` в панели вывода MSBuild.

Относитесь к `XA1029` как к HTTP 500: он сообщает, что сборка сломалась, а не что именно сломалось. Первый шаг -- всегда найти настоящую строку `> Task :`, которая упала.

## Как читать диагностический лог, чтобы найти настоящую причину

Из терминала в каталоге вашего проекта перезапустите сборку с уровнем подробности, который раскрывает каждую строку Gradle:

```bash
# .NET 11 SDK, MAUI 11.0.0
dotnet build -t:Run -f net11.0-android \
  -p:AndroidPackageFormat=apk \
  -bl:msbuild.binlog \
  -v:diag
```

Затем откройте `msbuild.binlog` в [MSBuild Structured Log Viewer](https://msbuildlog.com/) и найдите `FAILURE: Build failed`. Строка над ней называет упавшую задачу Gradle: `:app:processDebugResources`, `:app:mergeDebugResources`, `:app:lintVitalReportRelease` или `:app:compileDebugJavaWithJavac` -- обычные подозреваемые. Каждая указывает на конкретную категорию решений ниже.

Если binlog пуст для фазы Gradle, это означает, что Gradle вообще не запустился, что в свою очередь означает, что разрешение `JAVA_HOME` или восстановление workload упало до того, как любая задача начала выполняться. Перейдите к разделам про JDK и workload.

## Причина 1: JAVA_HOME указывает на неправильный JDK

Это самая распространённая причина после обновления .NET SDK. AGP 8.x, поставляемый с Xamarin.Android 35 (значение по умолчанию в .NET 11), отказывается стартовать под JDK 11 со следующей ошибкой внутри `build.log`:

```text
> Task :app:checkKotlinGradlePluginConfigurationErrors
A problem occurred starting Gradle worker
> Could not resolve the Java toolchain '11'.
> Android Gradle plugin requires Java 17 to run. You are currently using Java 11.
```

Соответствующий выход MSBuild -- `XA1029`. Microsoft документировала минимальную версию JDK для MAUI как Java 11 для эры .NET 6 -- .NET 8, затем как Java 17, начиная с MAUI 9, отслеживая требования AGP вверх по течению. См. долгоиграющий issue MAUI [dotnet/maui#18906](https://github.com/dotnet/maui/issues/18906) для исходной поломки.

Решение -- указать `JAVA_HOME` на установку JDK 17. На машине с Windows и Visual Studio 2026 встроенный OpenJDK 17 живёт в `C:\Program Files\Microsoft\jdk-17.0.x-hotspot`. Установите его постоянно:

```powershell
# PowerShell, as the same user that runs dotnet build
[Environment]::SetEnvironmentVariable(
  "JAVA_HOME",
  "C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot",
  "User")
```

Затем либо перезапустите оболочку, либо в CI дополнительно передайте `-p:JavaSdkDirectory=...` в командной строке `dotnet build`, чтобы MSBuild подхватил это, не полагаясь на унаследованное окружение:

```bash
dotnet build -f net11.0-android \
  -p:JavaSdkDirectory="/usr/lib/jvm/temurin-17-jdk-amd64"
```

Вы можете проверить, какой JDK действительно выбрал MSBuild, поискав `JdkDirectory` в binlog или запустив `dotnet build -t:_ResolveAndroidTooling -v:diag | findstr Jdk`.

## Причина 2: отсутствует workload maui-android или android

Вторая по распространённости причина: вы обновили .NET SDK на машине (или установили его с нуля в CI) и не восстановили workload-ы. Задача MSBuild падает на `_GenerateAndroidPackage`, потому что pack `Xamarin.Android.Sdk`, владеющий интеграцией с Gradle, отсутствует на диске. Обёртка по-прежнему `XA1029`; настоящая ошибка в `build.log`:

```text
> Task :app:processDebugResources FAILED
The 'aapt2' executable was not found at ...\Xamarin.Android.Sdk.x.x.x\tools\aapt2.exe
```

Восстановите workload, привязанный к установленному у вас уровню SDK:

```bash
# .NET 11 GA -- installs both the android pack and maui-android
dotnet workload install maui-android
dotnet workload restore
```

`dotnet workload restore` обходит каждый `*.csproj` в текущем каталоге, читает их `TargetFrameworks` и устанавливает любые pack-и, которые нужны каждому target framework. В CI это единственная команда, которую стоит запускать, потому что она идемпотентна и фиксирована по версии. Самостоятельный `dotnet workload install maui-android` -- правильный вызов на свежей машине разработчика. Microsoft документирует разделение workload-ов в [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install).

Если вы установили MAUI через инсталлятор Visual Studio 2026, а затем дополнительно запустили `dotnet workload install maui` из CLI, вы можете оказаться в состоянии, когда Visual Studio не может найти ни одну из копий. Документация по устранению неполадок MAUI описывает [полную последовательность удаления и переустановки](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), которая больше работы, чем кажется, но это единственное надёжное восстановление из расщеплённого состояния workload.

## Причина 3: нарушение длины пути в Windows в выводе obj

Третья повторяющаяся причина -- чисто артефакт Windows. R8 и `aapt2` оба пишут глубоко вложенные обфусцированные пути в `obj\Debug\net11.0-android\android\app\build\intermediates\`. Для проекта в `C:\src\MyCompany\MyProduct\Mobile\MyProduct.Mobile.csproj` полный путь промежуточного `.dex`-файла регулярно превышает унаследованный лимит `MAX_PATH` в 260 символов. Worker Gradle сообщает об этом как:

```text
> Task :app:mergeExtDexDebug FAILED
java.io.IOException: Cannot delete '...\transforms\...\classes.dex' (path too long)
```

Два решения, в порядке предпочтения:

1. Переместите репозиторий в более короткий корень: `C:\src\Mobile\` вместо `C:\Users\you\source\repos\MyCompany\Mobile\`.
2. Включите поддержку длинных путей на уровне ОС, .NET SDK и Git. Из PowerShell от имени Администратора:

   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   git config --system core.longpaths true
   ```

   Затем добавление `<UseAppHost>false</UseAppHost>` здесь не решение; вам действительно нужна запись в манифесте. Отредактируйте `.csproj`, чтобы установить `<EnableLongPaths>true</EnableLongPaths>` (Xamarin.Android 35+), и убедитесь, что `app.manifest` вашего проекта объявляет `longPathAware`. Сторона Android в сборке подхватит флаг ОС после того, как вы выйдете и снова войдёте в систему.

Первый вариант быстрее и работает на любой машине без прав администратора. Берите его, если только путь к репозиторию не зафиксирован политикой.

## Причина 4: lintVitalRelease падает только в сборке Release

Если `dotnet build -c Debug` проходит успешно, а `dotnet publish -c Release -f net11.0-android` падает с `XA1029`, упавшая задача Gradle -- это `:app:lintVitalReportRelease`. AGP 8 повысил сбои lint от предупреждений до ошибок сборки для Release-конфигураций. Вы увидите это в `build.log`:

```text
> Task :app:lintVitalReportRelease FAILED
Lint found errors in the project; aborting build.
```

Правильное решение -- прочитать отчёт lint в `obj/Release/net11.0-android/android/app/build/reports/lint-results-release.html` и устранить настоящие проблемы (отсутствующие переводы, хардкод-строки в `<application>`-метках, устаревшие Android API, нацеленные на `compileSdkVersion 35`).

Неправильно-но-соблазнительное решение -- подавить lint:

```xml
<!-- .csproj, .NET 11, MAUI 11 -- escape hatch only -->
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <AndroidLintAbortOnError>false</AndroidLintAbortOnError>
</PropertyGroup>
```

Используйте это только как тактический разблокировщик для релиза, который должен уехать сегодня. Находки lint об отсутствии объявлений `android:exported` -- это настоящие баги на Android 31+, и в конце концов они падут при запуске.

## Причина 5: отсутствующий или неправильный keystore для подписанных Release-сборок

Подписанная Release-сборка добавляет `:app:signReleaseBundle` в список задач. Если путь к keystore разрешается в ничто, AGP падает с:

```text
> Task :app:signReleaseBundle FAILED
Keystore file '/Users/runner/work/_temp/myapp.keystore' not found for signing config 'release'.
```

На машине разработчика это означает, что ваше свойство MSBuild `<AndroidSigningKeyStore>` указывает на файл, которого не существует для текущего пользователя. В CI это обычно означает, что секрет, содержащий keystore в base64, не был декодирован в путь, на который ссылается `csproj`. Минимально корректный вызов CI:

```bash
# .NET 11, MAUI 11 -- GitHub Actions
echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > $RUNNER_TEMP/release.keystore
dotnet publish src/MyApp/MyApp.csproj \
  -f net11.0-android \
  -c Release \
  -p:AndroidPackageFormat=apk \
  -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=$RUNNER_TEMP/release.keystore \
  -p:AndroidSigningStorePass=$ANDROID_KEYSTORE_PASS \
  -p:AndroidSigningKeyAlias=$ANDROID_KEY_ALIAS \
  -p:AndroidSigningKeyPass=$ANDROID_KEY_PASS
```

Все четыре свойства `AndroidSigning*` обязательны вместе. Установка только трёх из них падает с тем же `XA1029` и другой строкой задачи Gradle. Microsoft документирует имена свойств в [Publish a .NET MAUI app for Android](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli).

## Причина 6: повреждённый Gradle daemon или устаревший .gradle кеш

После долгой череды неудачных сборок пользовательский Gradle кеш в `~/.gradle/caches/` может оказаться в состоянии, когда каждая последующая сборка падает с обобщённым `XA1029` и `build.log`, жалующимся на lock-файлы. Снесите кеш и Gradle-дистрибутив на уровне workload:

```bash
# kills the daemon, deletes the cache, deletes the user gradle wrapper distribution
gradle --stop 2>/dev/null
rm -rf ~/.gradle/caches/ ~/.gradle/daemon/
rm -rf ~/.gradle/wrapper/dists/
```

В Windows эквивалент -- `Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\caches"`. Следующая сборка повторно скачает дистрибутив AGP (около 200 МБ) и регидрирует граф зависимостей; это занимает 5–10 минут в первый раз и быстро после этого.

Это правильное решение для случая "вчера работало и ничего не менялось". Это неправильное решение, когда вы можете назвать, что изменилось (обновление workload, замена JDK, новый NuGet-пакет); сначала ловите причину.

## Подводные камни и похожие ошибки

- `XA0119: Could not find android.jar for API level 35` -- родственная ошибка из той же стадии. Это всегда отсутствующая установка `android-sdk;platforms;android-35`, а не проблема Gradle. Запустите `androidsdkmanager --install platforms;android-35`.
- `error : Java.Interop.Tools.Diagnostics.XamarinAndroidException: Output directory does not exist` тоже из `Xamarin.Android.Build.Tasks`, но раньше в конвейере. Обычно это означает, что `obj/` доступен только для чтения, потому что Defender поместил файл в карантин. Проверьте `Get-Acl obj` и журнал карантина Defender.
- `MSB6006: "java.exe" exited with code 1` из фазы линкера обманчиво назван: это `R8` minification, падающий на классе, который он не может отследить. Добавьте правило ProGuard и попробуйте снова. См. разбор в [недавнем посте о настройке cold-start](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) для понимания базовой механики; те же контракты trim/AOT применяются на Android.
- "Build SUCCESS" без `.apk` в `bin/` происходит, когда `<AndroidPackageFormat>aab</AndroidPackageFormat>` установлен в родительском `Directory.Build.props`. Вместо этого сборка создаёт `.aab` (App Bundle), который и нужен Play Store. Текст `XA1029` говорит ".apk" только потому, что это исторически значение по умолчанию; базовая проверка -- "записал ли шаг упаковки ожидаемый выходной файл?".

## Связанное

- [Как упаковать MAUI-приложение для Microsoft Store](/ru/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) проходит по Windows-стороне того же конвейера публикации.
- [.NET 11 preview 4: dotnet watch наконец появляется для MAUI Android и iOS](/ru/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) описывает инструменты внутреннего цикла, которые работают поверх той же Gradle-обвязки.
- [MAUI на .NET 11 preview 4 делает CoreCLR значением по умолчанию для Android и iOS](/ru/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) объясняет, почему смена среды выполнения перевела часть правил lint из предупреждений в ошибки в Release-сборках.
- [Как мигрировать высокопроизводительный Xamarin.Forms ListView в MAUI CollectionView](/ru/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) -- самая частая причина того, что проект, который нормально собирался под Xamarin, начинает спотыкаться о `XA1029` после переноса на MAUI.

## Источники

- [Troubleshoot known issues in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), Microsoft Learn, .NET MAUI 11.
- [dotnet/maui#18906: GitHub Actions no longer builds MAUI Android: Java SDK 11.0 or above is required](https://github.com/dotnet/maui/issues/18906), канонический issue, отслеживающий повышение требования к JDK.
- [dotnet/maui Discussion #24164: Cannot build apk in Release](https://github.com/dotnet/maui/discussions/24164), ветка сообщества, перечисляющая причины `XA1029`, специфичные для Release.
- [Publish a .NET MAUI app for Android with the CLI](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli), источник истины для свойств MSBuild `AndroidSigning*`.
- [Java versions in Android builds](https://developer.android.com/build/jdks), документация команды Android о минимуме JDK по версии AGP.
- [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install), семантика установки/восстановления workload, упомянутая выше.

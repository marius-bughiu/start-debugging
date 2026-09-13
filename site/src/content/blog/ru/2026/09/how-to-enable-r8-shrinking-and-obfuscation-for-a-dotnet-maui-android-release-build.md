---
title: "Как включить сжатие и обфускацию R8 для релизной сборки .NET MAUI под Android"
description: "Установите AndroidLinkTool в r8, оставьте тримминг включённым и добавьте файл ProguardConfiguration. Почему .NET 10 и .NET 11 RC 1 всё ещё выпускают необфусцированный Java-код, как это меняет новое свойство AndroidR8ObfuscationMode и как проверить, что R8 действительно запустился."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "r8"
  - "dotnet-11"
  - "dotnet-10"
  - "google-play"
lang: "ru"
translationOf: "2026/09/how-to-enable-r8-shrinking-and-obfuscation-for-a-dotnet-maui-android-release-build"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Короткий ответ:** добавьте `<AndroidLinkTool>r8</AndroidLinkTool>` в `PropertyGroup`, действующий только для Release, в `.csproj` вашего MAUI-проекта, оставьте тримминг включённым (в Release он включён по умолчанию) и поместите правила keep в файл `proguard.cfg` с действием сборки `ProguardConfiguration`. Это включает сжатие и оптимизацию R8 для Java-части приложения. Но на сегодняшних SDK это **не** обфусцирует ничего: .NET for Android 36.1.69 (.NET 10) и 37.0.0-rc.1.2257 (.NET 11 RC 1) оба добавляют `-dontobfuscate` в конфигурацию R8. Настоящая обфускация появляется вместе с новым свойством `AndroidR8ObfuscationMode`, которое в .NET 11 после RC 1 по умолчанию равно `private-members`, а в следующем сервисном выпуске .NET 10 будет доступно как бэкпорт с явным включением.

Эта последняя деталь теперь важнее, чем раньше. 26 августа 2026 года Google объявила, что с февраля 2027 года пакеты приложений в Google Play должны иметь покрытие DEX-кода оптимизацией, сжатием и обфускацией не ниже 25% (Android vitals предупреждает, только когда пакет содержит 10 MB DEX для приложений и 50 MB для игр). MAUI-приложение тянет за собой много Java-кода AndroidX и Google Play services, так что DEX-часть у него немаленькая.

Всё изложенное ниже прослежено по исходному коду `dotnet/android` на указанных выше релизных тегах, поэтому каждое утверждение можно самостоятельно сверить с целями MSBuild.

## Что R8 затрагивает в MAUI-приложении, а что нет

Android-пакет MAUI содержит код двух видов, и сжимают их разные инструменты:

- **Управляемый код** (ваш C#, MAUI, BCL) обрезается ILLink, когда `PublishTrimmed` равно `true`. R8 его никогда не видит. Обфускация C# является отдельной задачей, которую R8 решить не может.
- **Байт-код Java** (AndroidX, Material, Google Play services, Firebase, любой привязываемый `.aar`, а также Java Callable Wrappers, которые сборка генерирует для каждого управляемого типа, наследующего Java-тип) превращается в `classes.dex`. По умолчанию это делает компилятор D8 без какого-либо сжатия. С `AndroidLinkTool=r8` R8 выполняет dex-преобразование и сжатие за один проход.

Проценты Google Play измеряются по DEX, то есть ровно по той половине, которой занимается R8. Поэтому, когда говорят "включить R8 в MAUI", имеют в виду уменьшение этой Java-половины и, со временем, её переименование.

Одно только сжатие уже того стоит. В [dotnet/android #12535](https://github.com/dotnet/android/issues/12535) разработчик измерил приложение на .NET 10 с 36.1.69: 20.18 MB несжатого DEX с D8 и 11.43 MB с R8 и правилами SDK по умолчанию. Это почти половина Java-кода, удалённая без единого написанного вручную правила keep.

## Минимальное изменение проекта

Вот вся конфигурация для MAUI-приложения, нацеленного на .NET 10 и .NET 11:

```xml
<!-- MyApp.csproj, .NET 10 (Microsoft.Android.Sdk 36.1.x) and .NET 11 RC 1 (37.0.0-rc.1) -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net11.0-android;net11.0-ios</TargetFrameworks>
    <OutputType>Exe</OutputType>
    <UseMaui>true</UseMaui>
  </PropertyGroup>

  <PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
    <AndroidLinkTool>r8</AndroidLinkTool>
    <!-- Default in Release already. Written out because R8 without trimming strips Java types your C# still uses. -->
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>

  <ItemGroup Condition="$(TargetFramework.Contains('-android'))">
    <ProguardConfiguration Include="Platforms/Android/proguard.cfg" />
  </ItemGroup>
</Project>
```

Затем публикуйте как обычно:

```bash
dotnet publish -f net11.0-android -c Release
```

Файл `proguard.cfg` поначалу может быть пустым. Правила в него добавляются, только когда R8 удаляет что-то, к чему обращаются через рефлексию; об этом речь пойдёт ниже.

## Что делает SDK, когда вы задаёте AndroidLinkTool

`AndroidLinkTool` является единственным нужным переключателем, потому что `Xamarin.Android.Common.targets` выводит из него всё остальное. В сокращённом виде из целей .NET 10 и .NET 11:

```xml
<!-- Xamarin.Android.Common.targets (dotnet/android 36.1.69 and 37.0.0-rc.1.2257), condensed -->
<AndroidDexTool   Condition=" '$(AndroidLinkTool)' == 'r8' ">d8</AndroidDexTool>
<AndroidLinkTool  Condition=" '$(AndroidLinkTool)' == 'proguard' And '$(AndroidEnableDesugar)' == 'True' ">r8</AndroidLinkTool>
<AndroidEnableProguard Condition=" '$(AndroidLinkTool)' != '' ">True</AndroidEnableProguard>
<AndroidCreateProguardMappingFile Condition="'$(AndroidCreateProguardMappingFile)' == '' And '$(AndroidLinkTool)' == 'r8'">True</AndroidCreateProguardMappingFile>
<AndroidProguardMappingFile Condition=" '$(AndroidLinkTool)' == 'r8' And '$(AndroidCreateProguardMappingFile)' == 'True' ">$(OutputPath)mapping.txt</AndroidProguardMappingFile>
```

Из этого следует несколько выводов:

- `AndroidLinkTool=proguard` незаметно повышается до `r8`, потому что с D8 десугаринг включён по умолчанию. Отдельный инструмент ProGuard современный .NET for Android не использует.
- Старые настройки эпохи Xamarin `AndroidEnableProguard=true` / `EnableProguard=true` всё ещё работают, но выдают предупреждение XA1028 (или XA1027) и по умолчанию выбирают инструмент компоновки `proguard`, который затем становится `r8`. Задавайте `AndroidLinkTool` напрямую и обходитесь без предупреждения.
- По умолчанию в `$(OutputPath)` создаётся `mapping.txt` (например, `bin/Release/net11.0-android/mapping.txt`), и `dotnet publish` копирует его в папку публикации. При сборке `.aab` файл сопоставления также встраивается в метаданные пакета как `com.android.tools.build.obfuscation/proguard.map`, поэтому Play Console подхватывает его без ручной загрузки. Для `.apk`, устанавливаемого вручную, загружать его придётся самостоятельно.

## Почему R8 нужен включённый тримминг

R8 не может сам определить, какие Java-типы всё ещё использует ваш C#. Этот список берётся из тримминга .NET: после запуска ILLink специальный шаг записывает `proguard_project_references.cfg` с правилом keep для каждого Java-типа, к которому привязан уцелевший управляемый тип. Цель, которая его генерирует, зависит от тримминга:

```xml
<!-- Microsoft.Android.Sdk.TypeMap.LlvmIr.targets, 37.0.0-rc.1.2257 -->
<Target Name="_GenerateProguardConfiguration"
    AfterTargets="_PrepareLinkedAssembliesForProguard"
    Condition=" '$(PublishTrimmed)' == 'true' and '$(_ProguardProjectConfiguration)' != '' "
```

При этом решение о запуске R8 тримминг не проверяет. `Xamarin.Android.D8.targets` нужно только, чтобы было задано свойство с путём, а `_ResolveAssemblies` задаёт его для каждой сборки, где `AndroidLinkTool` не пусто:

```xml
<!-- Xamarin.Android.D8.targets, same in 36.1.69 and 37.0.0-rc.1.2257 -->
<_UseR8 Condition=" ('$(AndroidLinkTool)' == 'r8' And '$(_ProguardProjectConfiguration)' != '') Or '$(AndroidEnableMultiDex)' == 'True' ">True</_UseR8>
```

Поэтому с `PublishTrimmed=false` (или `AndroidLinkMode=None` в Release, частым обходным путём при проблемах с рефлексией) R8 всё равно запускается, но без файла, защищающего ваши привязки. Сборка лишь записывает в журнал XA4304 ("ProGuard configuration file '...proguard_project_references.cfg' was not found"), а приложение затем падает с `java.lang.ClassNotFoundException` при первом обращении к Java-типу, который R8 удалил. Именно такая последовательность описана в [dotnet/android #6612](https://github.com/dotnet/android/issues/6612), где мейнтейнеры подтвердили, что R8 зависит от включённого компоновщика .NET.

По этой же причине условие Release в файле проекта не косметическое. Отладочные сборки не выполняют тримминг, поэтому безусловный `AndroidLinkTool=r8` заставляет и Debug запускать R8 без файла ссылок, а при включённом быстром развёртывании вы получаете ещё и XA0119: "Using fast deployment and a code shrinker at the same time is not recommended".

## Какие файлы конфигурации R8 получает на самом деле

Когда R8 запускается, SDK собирает его входные данные `--pg-conf` в следующем порядке (элементы `_ProguardConfiguration` в `Xamarin.Android.Common.targets`):

1. `$(ProguardConfigFiles)`, если вы задали это свойство.
2. `proguard-android.txt` из Android SDK (базовый вариант без оптимизаций). В новых SDK с `AndroidR8ObfuscationMode=private-members` он заменяется на `proguard-android-optimize.txt`.
3. `obj/.../proguard/proguard_xamarin.cfg`: правила keep среды выполнения для `mono.android.**`, `net.dot.jni.**` и им подобных. В выпущенных SDK этот файл начинается с `-dontobfuscate`.
4. `proguard_project_references.cfg`: правила keep для каждого Java-типа, к которому привязан уцелевший управляемый тип, генерируются после ILLink.
5. `proguard_project_primary.cfg`: по одному правилу `-keep class X { *; }` на каждый Java Callable Wrapper из карты ACW, поэтому каждый `Activity`, `Service` и пользовательский `View`, определённый в вашем C#, сохраняется.
6. Ваши элементы `@(ProguardConfiguration)`.
7. Правила для потребителей (`proguard.txt`), извлечённые из подключённых файлов `.aar`.

Пункты 4 и 5 объясняют, почему MAUI-приложению редко нужны написанные вручную правила keep для собственных типов: сборка уже знает, до каких Java-классов может дотянуться управляемая сторона. Чего она знать не может, так это того, к чему Java-код обращается через рефлексию.

## Почему сегодня вы получаете сжатие, но не обфускацию

Опции ProGuard глобальны. Если хоть один файл конфигурации содержит `-dontobfuscate`, обфускация отключается для всего запуска R8, и противоположного флага, который можно было бы добавить в собственный `proguard.cfg`, чтобы включить её обратно, не существует. Поскольку `proguard_xamarin.cfg` в 36.1.69 и 37.0.0-rc.1.2257 содержит эту строку, MAUI-сборка с включённым R8 на любом из этих SDK сжимает и оптимизирует код, но сохраняет все Java-имена нетронутыми. Записываемый ею `mapping.txt` по-прежнему фиксирует удалённые члены и изменения номеров строк, но переименований в нём не будет.

Измерения в #12535 это подтверждают: в `mapping.txt` одного приложения переименованы 34 из 15,235 классов (0.2%), а для другого Play Console показала 1% обфускации. Установка `AndroidCreateProguardMappingFile=true`, которую советуют некоторые ответы, здесь ничего не меняет: она управляет только тем, записывается ли файл сопоставления.

Сплошной `-dontobfuscate` был безопасным выбором. JNI связывает управляемые пиры с Java-классами по имени, поэтому переименование Java Callable Wrapper или привязанного метода AndroidX сломало бы поиск через `JNIEnv` во время выполнения. В той же ветке выяснилось, что и ручного удаления строки недостаточно: сгенерированные правила keep не защищали поля, которые привязки читают по имени через JNI, и приложения падали при запуске. Вместо того чтобы править конфигурацию SDK, дождитесь поддерживаемого переключателя, описанного ниже.

## Включение настоящей обфускации с AndroidR8ObfuscationMode

[dotnet/android #12668](https://github.com/dotnet/android/pull/12668), слитый 10 сентября 2026 года, заменяет сплошное правило избирательным и добавляет публичное свойство:

| `AndroidR8ObfuscationMode` | Обфускация | Базовая оптимизация | По умолчанию |
|---|---|---|---|
| `disabled` | нет, все Java-имена сохраняются | `proguard-android.txt` | сервисные выпуски .NET 10 |
| `private-members` | переименовываются private и package-private члены | `proguard-android-optimize.txt` | .NET 11 после RC 1 |

В тот же день [#12752](https://github.com/dotnet/android/pull/12752) перенёс его в `release/10.0.1xx` со значением `disabled` по умолчанию, чтобы сервисное обновление не меняло существующие приложения. Ни один выпущенный тег его пока не содержит (36.1.69 вышел раньше, а `release/11.0.1xx-rc1` был отделён до слияния), поэтому ожидайте его в .NET 11 RC 2 и в следующем сервисном обновлении .NET 10.

В режиме `private-members` задача R8 записывает вместо `-dontobfuscate` следующие правила:

```proguard
# Generated by the R8 task in dotnet/android main (post .NET 11 RC 1)
-keep,allowshrinking,allowoptimization class **
-keepclassmembers,allowshrinking,allowoptimization class ** {
   public protected *;
}
-keep,allowoptimization interface ** {
   public protected *;
}
-keep,allowshrinking class * implements **
```

Читать это следует так: каждый класс сохраняет своё имя, каждый public и protected член сохраняет своё имя, а всё private или package-private может быть переименовано. Неиспользуемый код по-прежнему может удаляться. Правила для интерфейсов нужны потому, что выбор управляемого прокси вызывает `Class.getInterfaces()`, чего R8 не видит; без них слияние классов могло бы потерять связь с интерфейсом и отдать управляемому коду не тот прокси.

Чтобы включить это на .NET 10 после выхода сервисного выпуска или отключить на .NET 11:

```xml
<!-- .NET 10 servicing (opt in) or .NET 11 (opt out with "disabled") -->
<PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
  <AndroidLinkTool>r8</AndroidLinkTool>
  <AndroidR8ObfuscationMode>private-members</AndroidR8ObfuscationMode>
</PropertyGroup>
```

Любое другое значение прерывает сборку с XA1050: "The 'AndroidR8ObfuscationMode' MSBuild property has an invalid value". PR также удаляет недокументированные переключатели `_AndroidR8DontObfuscate` и `_AndroidR8DontOptimize`, так что уберите их из проекта, если скопировали из какой-нибудь ветки обсуждения.

Не завышайте ожидания. В PR сообщается, что Google Play оценил шаблон `dotnet new maui -sc` в 62% оптимизации, 65% сжатия и 28% обфускации. Порог в 25% это преодолевает, но именно обфускация остаётся узким местом, поскольку имена, видимые через JNI, переименовывать нельзя. Рассматривайте `private-members` как "достаточно для требования Play", а не как защиту логики вашего C#.

## Правила keep, которые действительно важны

R8 удаляет только тот Java-код, недостижимость которого может доказать. Правила нужны для кода, к которому обращаются способами, невидимыми для R8:

```proguard
# Platforms/Android/proguard.cfg  (.NET 10 / .NET 11, R8 via AndroidLinkTool=r8)

# A Java SDK that loads its own classes with Class.forName and ships no consumer rules
-keep class com.example.vendorsdk.** { *; }

# Classes you look up by string from C#, e.g. Java.Lang.Class.ForName("com.example.Probe")
-keep class com.example.Probe { *; }

# JSON models serialized by a Java library (Gson, Moshi) that uses reflection
-keepattributes Signature,*Annotation*
-keep class com.example.api.models.** { <fields>; }

# Silence a known-harmless missing optional class instead of ignoring all warnings
-dontwarn androidx.window.extensions.**
```

На время настройки стоит добавить два диагностических правила, поскольку ваш собственный файл `ProguardConfiguration` считается конфигурацией приложения и может использовать глобальные опции:

```proguard
# Temporary: dump what R8 removed and the fully merged configuration
-printusage r8-usage.txt
-printconfiguration r8-merged.txt
```

R8 разрешает эти относительные пути относительно папки файла конфигурации, поэтому оба файла окажутся рядом с `proguard.cfg`. Ищите `-dontobfuscate` в `r8-merged.txt`, чтобы убедиться, какое поведение обфускации применил ваш SDK, и ищите имя класса в `r8-usage.txt`, чтобы доказать, что R8 его удалил, прежде чем писать для него правило. Перед коммитом удалите обе строки, потому что они замедляют каждую Release-сборку.

## Подводные камни, которые встречаются на практике

- **Предупреждения об отсутствующих классах по умолчанию скрыты.** `AndroidR8IgnoreWarnings` по умолчанию равно `True`, что добавляет `-ignorewarnings` и (начиная с .NET 8) передаёт `--map-diagnostics warning info`, поэтому сообщения R8 "Missing class" появляются как информационные строки в подробном журнале сборки. Именно поэтому проблемы вроде [dotnet/maui #10901](https://github.com/dotnet/maui/issues/10901) (`androidx.window.extensions.WindowExtensions`) обычно не валят сборку. Значение `False` строже и может превратить отсутствующий класс в ошибку сборки. Исправляйте это точечным `-dontwarn`, а не переключением глобального флага обратно.
- **Опечатка в пути даёт лишь предупреждение.** Если путь `ProguardConfiguration` не существует, вы получаете XA4304 ("ProGuard configuration file '...' was not found"), и R8 запускается без ваших правил. В CI считайте XA4304 ошибкой с помощью `<WarningsAsErrors>XA4304</WarningsAsErrors>`.
- **`EnableR8` и `AndroidLinkMode=r8` ничего не делают.** Ни то, ни другое не является переключателем R8. MSBuild молча принимает неизвестные свойства, а `AndroidLinkMode` управляет только триммингом управляемого кода (`None`, `SdkOnly`, `Full`). Включает R8 только `AndroidLinkTool=r8`.
- **Правила библиотек с глобальными опциями пропускаются.** Начиная с .NET 11 Preview 7, `proguard.txt` внутри `.aar`, содержащий `-dontobfuscate`, `-dontoptimize`, `-printmapping` или что-то подобное, отбрасывается с XA4322; это то же ограничение, которое ввёл AGP 9. Если сторонняя библиотека после обновления вдруг начала падать, поищите XA4322 в журнале сборки и скопируйте её правила keep (без глобальной опции) в свой `proguard.cfg`.
- **Страница MS Learn об элементах сборки устарела.** На ней сказано, что файлы `ProguardConfiguration` игнорируются, если `EnableProguard` не равно `True`. С `AndroidLinkTool=r8` значение `AndroidEnableProguard` принудительно устанавливается в `True`, поэтому элементы используются.
- **Для обфусцированных трассировок стека нужен файл сопоставления.** Когда `private-members` включён, private Java-кадры в отчёте о сбое выглядят как `a.b.c`. Сохраняйте `mapping.txt` каждой выпускаемой Release-сборки (`.aab` доставляет его в Play, а сервисам отчётов о сбоях вроде Firebase Crashlytics его нужно загружать отдельно).
- **R8 увеличивает время сборки.** Release-сборки будут идти заметно дольше, поскольку R8 выполняет анализ всей программы по всему байт-коду AndroidX и Play services. Оставляйте его только для Release.

## Как проверить, что R8 действительно запустился

Не полагайтесь на одно лишь свойство; подтвердите это по результатам сборки:

1. Соберите с бинарным журналом: `dotnet publish -f net11.0-android -c Release -bl`. Откройте `msbuild.binlog` в MSBuild Structured Log Viewer и найдите задачу `R8` внутри `_CompileToDalvik`. Если там только `D8`, свойство так и не дошло до Android-сборки, обычно потому, что его условие не совпадает с вашим `TargetFramework`. Если R8 запустился, но журнал содержит XA4304 для `proguard_project_references.cfg`, тримминг выключен и приложение упадёт во время выполнения.
2. Убедитесь, что `bin/Release/net11.0-android/mapping.txt` существует и имеет свежую отметку времени.
3. Откройте `obj/Release/net11.0-android/android-arm64/proguard/proguard_xamarin.cfg` (точная папка RID зависит от ваших `RuntimeIdentifiers`). На 36.1.69 или 37.0.0-rc.1.2257 он начинается с `-dontobfuscate`. На SDK с `AndroidR8ObfuscationMode=private-members` он вместо этого начинается с блока `-keep,allowshrinking,allowoptimization class **`.
4. Загрузите `.aab` на трек внутреннего тестирования и посмотрите проценты оптимизации, сжатия и обфускации в обозревателе пакетов приложения в Play Console. Именно это число проверяет Google, поэтому за ним и нужно следить. Play берёт проценты из файла метаданных сборки `r8.json`, если он есть в пакете, а иначе оценивает их по `mapping.txt`. SDK начинает упаковывать `r8.json` с [dotnet/android #12646](https://github.com/dotnet/android/pull/12646), который есть в `release/10.0.1xx` и `main`, но отсутствует в 37.0.0-rc.1.2257.

## Что почитать дальше

- Если Play отклонил ваш пакет ещё и из-за выравнивания нативных библиотек, решение описано в статье [Google Play отклоняет MAUI-приложение из-за размера страницы 16 KB](/ru/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).
- Смена среды выполнения меняет содержимое APK, с которым работает R8, см. [перевод Android-приложения MAUI с Mono на CoreCLR в .NET 11](/ru/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/).
- Другое требование Play в этом цикле разобрано в статье [нацеливание на Android API level 36 из .NET MAUI](/ru/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Если Release-сборка падает внутри Java-инструментария, а не молча, начните со статьи [Gradle build failed to produce an .apk file в MAUI Android](/ru/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- Приём с `-printusage`, описанный выше, использовался и для того, чтобы исключить R8 в статье [вход через Firebase Auth не сохраняется в релизной сборке Flutter под Android](/ru/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

## Источники

- [Свойства сборки .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-properties) (`AndroidLinkTool`, `AndroidCreateProguardMappingFile`, `AndroidProguardMappingFile`, `AndroidR8IgnoreWarnings`)
- [Элементы сборки .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-items) (`ProguardConfiguration`, `AndroidAppBundleMetaDataFile`)
- [Спецификация интеграции D8 и R8](https://github.com/dotnet/android/blob/main/Documentation/guides/D8andR8.md) в dotnet/android
- [`Xamarin.Android.D8.targets`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Xamarin.Android.D8.targets) и [`proguard_xamarin.cfg`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Resources/proguard_xamarin.cfg) на 37.0.0-rc.1.2257
- [dotnet/android #6612: R8 без компоновщика .NET](https://github.com/dotnet/android/issues/6612) и [#12535: безусловный -dontobfuscate против требования Play](https://github.com/dotnet/android/issues/12535)
- [dotnet/android #12668: настраиваемая обфускация private-членов и оптимизация](https://github.com/dotnet/android/pull/12668) и [бэкпорт для .NET 10 #12752](https://github.com/dotnet/android/pull/12752)
- [Android Developers Blog: снижение потребления памяти и улучшение миграции между устройствами](https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html) (требование к оптимизации DEX с февраля 2027 года)
- [Оптимизация DEX-кода в Android vitals](https://developer.android.com/topic/performance/vitals/code-optimization) (пороги DEX 10 MB / 50 MB)

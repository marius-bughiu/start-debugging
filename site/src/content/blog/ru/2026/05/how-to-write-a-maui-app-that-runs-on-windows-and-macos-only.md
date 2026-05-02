---
title: "Как написать MAUI-приложение, работающее только на Windows и macOS (без мобильных)"
description: "Уберите Android и iOS из проекта .NET MAUI 11, чтобы он публиковался только под Windows и Mac Catalyst: правки csproj, команды workload и multi-targeting, который сохраняет код чистым."
pubDate: 2026-05-02
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "windows"
  - "macos"
  - "how-to"
lang: "ru"
translationOf: "2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only"
translatedBy: "claude"
translationDate: 2026-05-02
---

Короткий ответ: откройте `.csproj`, удалите записи Android и iOS из `<TargetFrameworks>` и оставьте только `net11.0-windows10.0.19041.0` и `net11.0-maccatalyst`. Затем удалите `Platforms/Android`, `Platforms/iOS` и `Platforms/Tizen`, если он есть. Уберите соответствующие записи `<ItemGroup>` для ресурсов изображений MAUI, указывающих на иконки только для мобильных, удалите workload-ы `maui-android` и `maui-ios`, если хотите чистую машину, и ваша компоновка Single Project, `MauiProgram`, hot reload XAML и пайплайн ресурсов продолжают работать. `dotnet build -f net11.0-windows10.0.19041.0` создаёт MSIX, `dotnet build -f net11.0-maccatalyst` (запущенный на macOS) создаёт `.app`, и больше ничто никогда не пытается поднять эмулятор Android.

Этот пост описывает точные правки для .NET MAUI 11.0.0 на .NET 11, что можно безопасно удалить, а что нет, тонкие ловушки multi-targeting при удалении head-ов платформ и изменения workload-ов и CI, которые действительно экономят время. Всё ниже проверено относительно `dotnet new maui` из .NET 11 SDK и применимо аналогично к проекту Xamarin.Forms, уже мигрированному на MAUI.

## Зачем вообще выпускать MAUI-head только под десктоп

Существует устойчивый сегмент команд, разрабатывающих бизнес-приложения, выбирающих MAUI ради модели XAML и привязок, а не ради мобильного охвата. Внутренние административные инструменты, киоск-приложения, клиенты POS, дашборды цеха и приложения выездных служб, где "поле" -- это "Surface и MacBook", все попадают сюда. Эти команды платят реальную цену за мобильные head-ы, которые никогда не публикуют: каждый `dotnet build` оценивает четыре цели, каждый restore NuGet тянет reference packs Android и iOS, каждый CI-runner требует workload Android, и каждое онбординг-окружение разработчика упирается в зависимости от Xcode и Android Studio ещё до того, как удастся запустить приложение.

Удаление мобильных head-ов не является шаблоном Visual Studio по умолчанию, но полностью поддерживается SDK. Система сборки читает `<TargetFrameworks>` и эмитирует только те head-ы, которые вы объявили. Внутри самого MAUI ничего переключать не нужно. Все трения сосредоточены в файле проекта, в папке `Platforms/` и в условных MSBuild-элементах, которые шаблон добавляет для мобильных ассетов.

## Правка TargetFrameworks

Свежий `dotnet new maui -n DesktopApp` в .NET 11 SDK создаёт проект, открывающийся такой стартовой `PropertyGroup`:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Замените две строки `<TargetFrameworks>` одним явным списком:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Здесь важны две вещи. Во-первых, условный блок `IsOSPlatform('windows')` сохраняется, потому что Windows-head собирается только под Windows, как и Mac Catalyst -- только под macOS. Без условия разработчик на macOS, запустивший `dotnet build`, получит ошибку "The Windows SDK is not available." Во-вторых, суффикс версии в `net11.0-windows10.0.19041.0` -- это версия Windows 10 SDK, которую MAUI требует для WinUI; не убирайте суффикс версии и не меняйте его на `net11.0-windows10.0` отдельно, потому что target-ы WinAppSDK привязаны именно к этому моникеру.

Если вам нужна только macOS, удалите строку Windows полностью. Если только Windows -- удалите строку Mac Catalyst и условие. Форма `<TargetFramework>` (в единственном числе) тоже работает, если у вас действительно только один head, и она даёт единственное безусловное значение, с которым некоторые инструменты обращаются изящнее. Для настоящего кросс-десктопного приложения сохраняйте multi-target форму.

## Что удалить в `Platforms/`

Шаблон MAUI выдаёт `Platforms/Android`, `Platforms/iOS`, `Platforms/MacCatalyst`, `Platforms/Tizen` и `Platforms/Windows`. В каждой папке немного платформо-специфичного bootstrap-кода: `AppDelegate` для платформ Apple, `MainActivity` и `MainApplication` для Android, `App.xaml` плюс `Package.appxmanifest` для Windows, `Application.cs` для Mac Catalyst.

Для версии только под десктоп удалите `Platforms/Android`, `Platforms/iOS` и `Platforms/Tizen` напрямую. Они не используются. Сохраните `Platforms/MacCatalyst` и `Platforms/Windows`. Не трогайте папку `Resources/` совсем; это пайплайн ассетов Single Project, и он обслуживает все head-ы.

После удаления компоновка выглядит так:

```
DesktopApp/
  App.xaml
  App.xaml.cs
  AppShell.xaml
  AppShell.xaml.cs
  MainPage.xaml
  MainPage.xaml.cs
  MauiProgram.cs
  Platforms/
    MacCatalyst/
      AppDelegate.cs
      Info.plist
      Program.cs
    Windows/
      App.xaml
      App.xaml.cs
      Package.appxmanifest
      app.manifest
  Resources/
    AppIcon/
    Fonts/
    Images/
    Raw/
    Splash/
    Styles/
  DesktopApp.csproj
```

Это полное дерево исходников MAUI 11 приложения только под десктоп.

## Уберите элементы ассетов изображений только для мобильных

Если вы использовали шаблон по умолчанию, в вашем `.csproj` ближе к концу есть блок такого вида:

```xml
<!-- .NET MAUI 11.0.0 -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
  <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
  <MauiImage Include="Resources\Images\*" />
  <MauiImage Update="Resources\Images\dotnet_bot.png" Resize="True" BaseSize="300,185" />
  <MauiFont Include="Resources\Fonts\*" />
  <MauiAsset Include="Resources\Raw\**" LogicalName="%(RecursiveDir)%(Filename)%(Extension)" />
</ItemGroup>
```

Они платформо-нейтральны и остаются как есть. Пайплайн ресурсов Single Project превращает SVG в PNG для каждой платформы во время сборки только для тех head-ов, которые вы объявили. Когда вы убираете Android, никакие плотности Android не эмитируются; тот же файл `Resources/AppIcon/appicon.svg` питает `AppIcon.icns` для Mac Catalyst и `Square150x150Logo.scale-200.png` для Windows, и больше ничего не нужно.

Если ваш проект старше .NET 9, у вас могут также остаться явные элементы `<AndroidResource>` или `<BundleResource>` от миграции с Xamarin.Forms. Удалите их. Если оставить, ошибки не будет, но они засоряют вывод сборки, и вы получите предупреждения "file not found", если упомянутые файлы больше не существуют.

## Multi-targeting вашего собственного кода без `#if ANDROID`

Шаблон MAUI приходит с парой шаблонов для платформо-специфичного кода: `partial`-классы, разнесённые по файлам `Platforms/<head>/`, и директивы `#if`. Без Android и iOS вам нужно обрабатывать только Windows и Mac Catalyst. Символы препроцессора, которые вы фактически используете:

```csharp
// .NET 11, MAUI 11.0.0
public static class PlatformInfo
{
    public static string Describe()
    {
#if WINDOWS
        return "Windows";
#elif MACCATALYST
        return "macOS (Mac Catalyst)";
#else
        return "Unknown";
#endif
    }
}
```

И всё. `ANDROID` и `IOS` всё ещё являются определёнными символами, когда эти head-ы присутствуют в `<TargetFrameworks>`, но поскольку их там нет, эти ветки просто никогда не компилируются. Вы можете безопасно удалить каждый блок `#if ANDROID` и `#if IOS` из вашей кодовой базы отдельным проходом очистки.

Если вы разделяете реализации по имени файла ([официальный шаблон multi-targeting, документированный для MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)), условные блоки `<ItemGroup>` должны потерять ветки Android и iOS:

```xml
<!-- Mac Catalyst -->
<ItemGroup Condition="$(TargetFramework.StartsWith('net11.0-maccatalyst')) != true">
  <Compile Remove="**\*.MacCatalyst.cs" />
  <None Include="**\*.MacCatalyst.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>

<!-- Windows -->
<ItemGroup Condition="$(TargetFramework.Contains('-windows')) != true">
  <Compile Remove="**\*.Windows.cs" />
  <None Include="**\*.Windows.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>
```

Два правила вместо пяти. Та же логика применима к multi-targeting на основе папок; сохраните только правила для папок `MacCatalyst` и `Windows`.

## Workload-ы: ставьте то, что собираете, удаляйте то, что не собираете

Это изменение быстрее всего окупает себя на CI-runner-е. Манифест workload-ов MAUI разделён на несколько суб-workload-ов:

```bash
# .NET 11 SDK on macOS
dotnet workload install maui-maccatalyst

# .NET 11 SDK on Windows
dotnet workload install maui-windows
```

Для проекта только под десктоп вам нужны ровно эти два на соответствующем runner-е. Зонтичный workload `maui` не нужен, он тянет Android и iOS как транзитивные зависимости workload-ов. На CI-образе, где `maui` уже был установлен, выполните:

```bash
dotnet workload uninstall maui-android maui-ios
```

Mac Catalyst-head на macOS всё ещё требует Xcode, потому что `mlaunch` и инструментарий Apple выполняют фактическое построение `.app`. Вам не нужны Android SDK, Java JDK или какие-либо зависимости развёртывания на iOS-устройство. Под Windows Windows-head требует Windows App SDK и Windows 10 SDK той версии, что прибита в `<TargetFrameworks>`. Команда `dotnet workload install maui-windows` тянет оба.

Экономия CI ощутима. Linux-runner, который раньше готовил workload-ы Android и образы эмуляторов для размещённой на Linux сборки MAUI-приложения только для того, чтобы пропустить их на CI-гейте, может полностью исключить эти шаги; сборка теперь игнорирует Linux, и вы запускаете два отдельных job, по одному на ОС.

## Сборка и публикация каждого head

Команды `dotnet build` и `dotnet publish` принимают явный аргумент `-f`, чтобы вы случайно не попытались собрать head на неправильной хост-системе:

```bash
# On Windows, .NET 11 SDK
dotnet build -f net11.0-windows10.0.19041.0 -c Release
dotnet publish -f net11.0-windows10.0.19041.0 -c Release -p:WindowsAppSDKSelfContained=true -p:WindowsPackageType=MSIX

# On macOS, .NET 11 SDK
dotnet build -f net11.0-maccatalyst -c Release
dotnet publish -f net11.0-maccatalyst -c Release -p:CreatePackage=true
```

Windows-head создаёт пакет `.msix` или, с `WindowsPackageType=None`, неупакованный каталог Win32. Mac Catalyst-head создаёт `.app` и, с `CreatePackage=true`, установщик `.pkg`. Подпись кода -- отдельная тема для обоих: сертификат Authenticode для MSIX и Apple Developer ID для `.pkg`. Ни один из путей не задействует provisioning profile, то есть тот специфичный для iOS танец, от которого вы только что отказались.

Если вам также нужен Native AOT для десктопных head-ов, WinUI-head MAUI поддерживает его на .NET 11 с оговорками, аналогично [пути Native AOT для minimal API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Mac Catalyst пока не поддерживает полноценный Native AOT в MAUI 11; он поставляется с mono-AOT для платформ Apple.

## Ловушки, о которых стоит помнить

Шаблон Visual Studio "Add new MAUI Page" в некоторых сценариях незаметно добавляет обратно блок `<ItemGroup Condition="...android..."/>`. Следите за diff-ами вашего csproj. Если вы коммитите чистый csproj только под десктоп, а коллега добавляет новую view через IDE, diff может воскресить условные элементы Android и iOS, даже если `<TargetFrameworks>` больше не включает эти target-ы. Эти осиротевшие элементы безвредны, но накапливают шум.

Пакеты NuGet, зависящие от `Xamarin.AndroidX.*` или от `Microsoft.Maui.Essentials` ради API только для мобильных, всё равно будут восстанавливаться. Менеджер пакетов разрешает зависимости относительно объявленных вами target-ов, и пакет только для мобильных без совместимого ассета для `net11.0-windows10.0` или `net11.0-maccatalyst` упадёт с `NU1202`. Решение -- удалить пакет; если это транзитивная зависимость чего-то, что вы реально используете, заведите issue в upstream-пакете и зафиксируйте версию, которая явно поддерживает десктопные target-ы.

XAML hot reload работает на обоих десктопных head-ах в .NET 11. Запускающий отладчик должен быть на хост-ОС нужного head-а: невозможно отлаживать сессию Mac Catalyst из Visual Studio под Windows. Rider на macOS обслуживает оба head-а из одного workspace, и именно на этом рабочем процессе обычно останавливается большинство кросс-десктоп команд.

API MAUI Essentials, явно предназначенные только для мобильных (геокодирование, контакты, сенсоры, телефония), бросают `FeatureNotSupportedException` во время выполнения на Windows и Mac Catalyst. Они не падают на этапе компиляции. Оборачивайте использование этих API за проверкой возможностей или абстракцией, безопасной для десктопа. То же относится к MAUI Maps до [изменений pin clustering, появившихся в .NET MAUI 11](/ru/2026/04/dotnet-maui-11-map-pin-clustering/); десктопные head-ы используют под капотом другой контрол карты, чем мобильные head-ы, и паритет возможностей не идеален.

Если вам когда-либо понадобится вернуть мобильные head-ы (клиент попросил версию для iPad), изменения откатываются чисто: добавьте записи обратно в `<TargetFrameworks>`, восстановите папки `Platforms/Android` и `Platforms/iOS` из свежего шаблона `dotnet new maui`, переустановите workload-ы. Компоновка Single Project, ваш XAML, ваши view models и пайплайн ресурсов переносятся без изменений. Конфигурация только под десктоп -- это строгое подмножество шаблона с четырьмя head-ами, а не форк.

## Связанное

- [.NET MAUI 11 поставляет встроенный LongPressGestureRecognizer](/ru/2026/04/maui-11-long-press-gesture-recognizer/)
- [Pin clustering приходит в Maps .NET MAUI 11](/ru/2026/04/dotnet-maui-11-map-pin-clustering/)
- [Как использовать Native AOT с minimal API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Как сократить cold-start AWS Lambda на .NET 11](/ru/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Ссылки на источники

- [Настройка multi-targeting .NET MAUI (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)
- [Target frameworks в SDK-style проектах (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)
- [Устранение известных проблем .NET MAUI (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [Issue 11584 в `dotnet/maui` об удалении target Mac Catalyst](https://github.com/dotnet/maui/issues/11584)

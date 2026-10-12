---
title: "Fix: Settings file 'DotnetToolSettings.xml' was not found in the package"
description: "Пакет инструмента нацелен на более новую версию .NET, чем SDK, выполняющий установку, или вообще не является инструментом .NET. Используйте более новый SDK, зафиксируйте версию инструмента с подходящей папкой tools или принудительно задайте --framework."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "dotnet-tools"
  - "ef-core"
lang: "ru"
translationOf: "2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package"
translatedBy: "claude"
translationDate: 2026-10-12
---

Пакет почти никогда не бывает повреждён, и очистка кеша NuGet не поможет. Это сообщение означает, что SDK, выполняющий `dotnet tool install`, не нашёл папку `tools/<tfm>/`, которую ему разрешено использовать. Обычная причина: инструмент собран только для более новой версии .NET, чем сам SDK, например `dotnet-ef` 10.0.0/10.0.1 или 11.0 на SDK 8 или 9. Выполните `dotnet --version` в папке, где установка завершается ошибкой. Затем либо перейдите на SDK, не старше целевого фреймворка инструмента, либо зафиксируйте версию инструмента со старой папкой `tools/` (`dotnet-ef` 10.0.2 и новее снова поставляются с `net8.0`). Если пакет вообще не является инструментом .NET (`Microsoft.EntityFrameworkCore.Tools`, `Microsoft.EntityFrameworkCore.Design`), установите вместо него `dotnet-ef`. Всё ниже воспроизведено 2026-10-12 на SDK 8.0.425, 9.0.318 и 10.0.302 на macOS arm64 с живым nuget.org.

## Ошибка в контексте

`dotnet tool install` (глобально, с `--tool-path` или локально) выводит это даже на чистой машине, где раньше ничего не устанавливалось:

```
Tool 'dotnet-ef' failed to update due to the following:
The settings file in the tool's NuGet package is invalid: Settings file 'DotnetToolSettings.xml' was not found in the package.
Tool 'dotnet-ef' failed to install. Contact the tool author for assistance.
```

"Failed to update" вводит в заблуждение. Оно появляется и при первой установке. `dotnet tool restore` и `dotnet dnx` проходят по тому же коду, но не оборачивают исключение, поэтому в репозитории с манифестом инструментов вы получаете его в исходном виде:

```
Unhandled exception: Settings file 'DotnetToolSettings.xml' was not found in the package.
```

Обе формы завершаются с кодом 1. Ничто в выводе не говорит, какой фреймворк искал SDK, поэтому люди и начинают удалять кеши и переустанавливать SDK наугад.

## Почему это происходит

Пакет инструмента .NET хранит содержимое в `tools/<целевой фреймворк>/<rid>/`, и `DotnetToolSettings.xml` лежит в этой папке. Файл существует, но только внутри папки фреймворка. SDK не ищет его по всему пакету. Он строит синтетический файл assets по правилам выбора ресурсов NuGet и запрашивает элемент из **ближайшей совместимой папки фреймворка**. В исходном коде SDK .NET 10 (`ToolPackageDownloader.CreateAssetFile`) целевой фреймворк берётся из среды выполнения, на которой работает CLI:

```csharp
// dotnet/sdk, release/10.0.3xx: src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs
currentTargetFramework = new NuGetFramework(
    FrameworkConstants.FrameworkIdentifiers.NetCoreApp,
    new Version(Environment.Version.Major, Environment.Version.Minor));
```

SDK 9.0.318 работает на среде выполнения .NET 9, поэтому запрашивает `net9.0`. В пакете, где есть только `tools/net10.0/any/`, нет совместимой папки, и список выбранных элементов пуст. Затем `ToolPackageInstance.DeserializeToolConfiguration` выбрасывает `MissingToolSettingsFile`, и вы видите это сообщение. На практике текст означает: "ни одна папка `tools/` не нацелена на фреймворк, который может запустить этот SDK".

Два следствия удивляют людей:

1. **Установленные среды выполнения не учитываются.** Я добавил среду выполнения .NET 10.0.12 рядом с SDK 9.0.318, и обычная установка `dotnet-ef` 10.0.1 всё равно завершилась тем же сообщением. Значение имеет только версия среды выполнения самого SDK.
2. **Проверка типа пакета выполняется позже и только в SDK 10.** SDK 10 сначала проверяет `packageType` в nuspec и для пакетов, не являющихся инструментами, выводит понятное "is not a .NET tool". SDK 8 и 9 пропускают эту проверку и приходят к тому же вводящему в заблуждение сообщению.

Итак, за одной строкой стоят три реальные причины, отсортированные по частоте:

- **Инструмент нацелен на более новую версию .NET, чем ваш SDK.** Обычный случай после выхода нового мажорного релиза (`dotnet-ef` 10.0.0/10.0.1, `AzureSignTool` 7.0.0, любой инструмент, собранный только для `net10.0` или `net11.0`).
- **Инструмент является платформенно-зависимым (RID-specific) инструментом .NET 10.** В его корневом пакете тоже есть только папка `tools/net10.0/`, поэтому старые SDK падают так же.
- **Пакет не является инструментом.** Это библиотека или пакет MSBuild/PowerShell, ошибочно установленный через `dotnet tool install`.

## Минимальное воспроизведение

Эти команды используют `--tool-path`, чтобы не затрагивать вашу папку глобальных инструментов. Каждый блок показывает версию SDK, которая его выполнила.

```bash
# SDK 9.0.318 (also identical on SDK 8.0.425)
dotnet tool install dotnet-ef --version 10.0.1 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --version 11.0.0-rc.1.26425.128 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install AzureSignTool --version 7.0.0 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --tool-path ./tools
# Tool 'dotnet-ef' (version '10.0.12') was successfully installed.  exit 0
```

Последняя строка важна. Обычная команда `dotnet tool install dotnet-ef` сегодня разрешается в 10.0.12 и работает на SDK 8 и 9. Сбой проявляется только при закреплённой версии, например в манифесте `dotnet-tools.json` или в скрипте CI, написанном в ноябре 2025 года. Вот структура `tools/` каждой проверенной мной версии `dotnet-ef` на nuget.org:

| Версия dotnet-ef | Папка tools | Устанавливается на SDK 8 / 9 | Устанавливается на SDK 10 |
|---|---|---|---|
| 8.0.21 | `tools/net8.0/any/` | да | да |
| 9.0.10 | `tools/net8.0/any/` | да | да |
| 10.0.0, 10.0.1 | `tools/net10.0/any/` | **нет** | да |
| с 10.0.2 по 10.0.12 | `tools/net8.0/any/` | да | да |
| 11.0.0-rc.1.26425.128 | `tools/net10.0/any/` | **нет** | да |

То же происходит на одну мажорную версию выше. Я перепаковал простой инструмент так, чтобы его единственной папкой была `tools/net11.0/any/`, и SDK 10.0.302 отклонил его с тем же сообщением. `dotnet dnx` на SDK 10 вывел форму "Unhandled exception" для того же пакета.

## Исправление подробно

### 1. Проверьте, какой SDK на самом деле работает в этой папке

`global.json` выбирает SDK для каждой папки отдельно, поэтому SDK, выполняющий `dotnet tool restore` в вашем репозитории, может быть не самым новым из установленных:

```bash
# Any SDK. Run in the directory where the install fails.
dotnet --version
dotnet --list-sdks
cat global.json 2>/dev/null
```

Если `dotnet --version` выводит `8.0.x` или `9.0.x`, а инструмент нацелен на `net10.0`, это и есть ответ. На CI то же несоответствие возникает из-за образа раннера, в котором есть только старый SDK, или из-за `actions/setup-dotnet`, читающего `global.json` с закреплённой версией 8.0. То, как раннер выбирает свой SDK, описано в [разборе CI для "the command dotnet could not be found"](/ru/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

### 2. Рекомендуется: запускайте инструмент на SDK не старше его целевой версии

```json
// global.json, .NET 10 SDK. rollForward keeps you on the newest 10.0 feature band.
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

SDK .NET 10 собирает проекты `net8.0` и `net9.0` без каких-либо изменений, поэтому обновление SDK не заставляет вас менять целевую платформу приложения. Это самое чистое исправление, потому что от него выигрывают и все остальные инструменты в вашем манифесте. Если вы всё равно планируете полный переход, [чек-лист перехода с .NET 8 на .NET 11](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) перечисляет ожидаемые критические изменения на уровне SDK.

### 3. Если SDK сменить нельзя: зафиксируйте версию инструмента с подходящей папкой

Для `dotnet-ef` любая сборка 10.0.2 или новее поставляется с `tools/net8.0/` и устанавливается на SDK 8 и 9:

```bash
# SDK 8.0.425 or 9.0.318
dotnet tool install --global dotnet-ef --version 10.0.12
```

```json
// .config/dotnet-tools.json, works with SDK 8, 9 and 10
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": { "version": "10.0.12", "commands": [ "dotnet-ef" ], "rollForward": false }
  }
}
```

Инструменту по-прежнему нужна среда выполнения, на которой он может работать. Сборка `net8.0` инструмента `dotnet-ef` 10.0.12 без проблем работала на SDK 8.0.425 при установленной только среде выполнения .NET 8. Для других инструментов загляните внутрь пакета, прежде чем фиксировать версию. Это показывает вкладка "Frameworks" на nuget.org, либо можно вывести список архива напрямую:

```bash
# Any OS with curl and unzip. Replace the id and version.
curl -sL https://api.nuget.org/v3-flatcontainer/dotnet-ef/10.0.1/dotnet-ef.10.0.1.nupkg -o t.nupkg
unzip -l t.nupkg | grep DotnetToolSettings
#   tools/net10.0/any/DotnetToolSettings.xml
```

Если во всех подходящих вам версиях есть только более новая папка, вернитесь к исправлению 2.

### 4. Запасной вариант: принудительно задайте фреймворк через `--framework`

`dotnet tool install` и `dotnet tool update` принимают `--framework`, и это значение заменяет `Environment.Version` в описанном выше выборе ресурсов. Если более новая среда выполнения установлена параллельно, старый SDK может установить более новый переносимый инструмент:

```bash
# SDK 9.0.318 with the .NET 10.0.12 runtime installed next to it
dotnet tool install --global dotnet-ef --version 10.0.1 --framework net10.0
# Tool 'dotnet-ef' (version '10.0.1') was successfully installed.
dotnet-ef --version
# 10.0.1
```

Без среды выполнения .NET 10 установка всё равно "проходит успешно", но инструмент падает при первом запуске. На SDK 8.0.425, где есть только .NET 8, `dotnet-ef` сообщил "You must install or update .NET to run this application" и запросил `Microsoft.NETCore.App` 10.0.0. У `dotnet tool restore` нет параметра `--framework`, поэтому это помогает только для глобальных установок и установок с `--tool-path`. Считайте это временной мерой, а не решением для конвейера.

### 5. Если пакет не является инструментом: установите правильный пакет

`Microsoft.EntityFrameworkCore.Tools` - это пакет консоли диспетчера пакетов для Visual Studio, а `Microsoft.EntityFrameworkCore.Design` - библиотека времени разработки, на которую ссылается ваш стартовый проект. Ни один из них не является инструментом .NET. Что выводит каждый SDK, зависит от версии:

```bash
# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.

# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Design
# Unhandled exception: System.IO.DirectoryNotFoundException: Could not find a part
# of the path '.../microsoft.entityframeworkcore.design/10.0.12/tools'.

# SDK 10.0.302
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Package microsoft.entityframeworkcore.tools is not a .NET tool.
```

Инструмент командной строки - это `dotnet-ef`. Добавьте `Microsoft.EntityFrameworkCore.Design` в стартовый проект как обычный `PackageReference`. Если после этого `dotnet ef` будет на него жаловаться, исправление описано в [your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/ru/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

## Подводные камни и похожие ошибки

**RID-зависимые инструменты .NET 10 скрывают более понятное сообщение.** В .NET 10 авторы могут поставлять [платформенно-зависимые инструменты](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools): небольшой корневой пакет, чей `DotnetToolSettings.xml` использует `Version="2"` и указывает на пакеты для отдельных RID. Я упаковал такой инструмент с `<RuntimeIdentifiers>osx-arm64;linux-x64;win-x64</RuntimeIdentifiers>` на SDK 10.0.302. SDK 8.0.425 и 9.0.318 оба отклонили его общим текстом "was not found", потому что в корневом пакете есть только папка `net10.0`. Microsoft перенесла более понятную ошибку в SDK 8.0.21 ([dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414)), но вы доберётесь до неё, только когда папка будет найдена. С `--framework net10.0` SDK 9.0.318 вывел "Format version is higher than supported. This tool may not be supported in this SDK version. Update your SDK." `--framework` не спасает RID-зависимый инструмент. Единственное решение - SDK .NET 10.

**Очистка кешей не помогает.** `dotnet nuget locals all --clear` - самый частый совет при этом сообщении. Он не поможет ни в одном из трёх описанных случаев, потому что пакет был скачан правильно. Файл в пакете есть, просто не в той папке, которую выбирает ваш SDK. Обрезанная загрузка теоретически возможна, но находится в самом конце списка. Проверьте `dotnet --version` и папку `tools/` пакета, прежде чем браться за кеш.

**"Tool 'dotnet-ef' is already installed", "is not found in NuGet feeds" и конфликты shim - это другие сбои** с другими флагами. Все шесть разобраны в [every way dotnet tool install --global dotnet-ef fails](/ru/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/).

**Установка прошла, но `dotnet ef` "not found".** Это проблема `PATH`, а не пакета. Смотрите [fixing "dotnet ef" not found](/ru/2023/06/how-to-fix-command-dotnet-ef-not-found/).

**Авторы инструментов могут избавить от этого своих пользователей.** Задайте для инструмента несколько целевых платформ (`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` с `<PackAsTool>true</PackAsTool>`), чтобы старые SDK находили папку, которую могут запустить, как это делал `dotnet-ef` начиная с 10.0.2. Для RID-зависимых инструментов Andrew Lock описывает компромиссный корневой пакет, который также содержит framework-dependent сборку для старых SDK. Команда SDK согласна, что сообщение бесполезно. [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172) и [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878) на момент написания всё ещё открыты.

## Связанные материалы

- [Fix: dotnet tool install --global dotnet-ef throws an error](/ru/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/), о других сбоях установки и о несоответствии среды выполнения, которое проявляется только после успешной установки.
- [How to fix "dotnet ef" not found](/ru/2023/06/how-to-fix-command-dotnet-ef-not-found/), о стороне `PATH` того же инструмента.
- [Fix: the command dotnet could not be found on CI](/ru/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/), о том, как раннеры CI выбирают и открывают SDK.
- [Fix: your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/ru/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/), о пакете, который люди по ошибке пытаются установить как инструмент.
- [Migrate from .NET 8 to .NET 11: the full checklist](/ru/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), если обновление SDK - часть более крупного перехода.

## Источники

- [dotnet/sdk `ToolPackageDownloader.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs) и [`ToolPackageInstance.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageInstance.cs), о выборе фреймворка и выбросе `MissingToolSettingsFile`.
- [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172), "Installing a tool that targets a framework not installed gives a non-actionable error message".
- [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878), отчёт об `AzureSignTool` 7.0.0 и объяснение, что регрессия появилась в .NET 7, когда загрузка инструментов перестала проходить через restore.
- [dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414), перенос в 8.0.4xx ошибки "Format version is higher than supported".
- [Create RID-specific, self-contained, and AOT .NET tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools) на Microsoft Learn.
- [dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), о `--framework`, `--tool-path` и поведении манифеста.
- Andrew Lock, [Supporting platform-specific .NET tools on old SDKs](https://andrewlock.net/exploring-dotnet-10-preview-features-8-supporting-platform-specific-dotnet-tools-on-old-sdks/), о схемах `DotnetToolSettings.xml` версий 1 и 2.

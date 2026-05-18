---
title: "Исправление: framework_version=6.0.0 was not found при запуске бинарника .NET 6"
description: "Среда выполнения .NET 6 отсутствует или не совпадает. Установите net6.0 заново, сделайте roll forward на net8.0 через runtimeconfig, смените таргет csproj или опубликуйте self-contained."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-6"
  - "runtime"
  - "deployment"
lang: "ru"
translationOf: "2026/05/fix-framework-version-6-0-0-when-launching-dotnet-6-binary"
translatedBy: "claude"
translationDate: 2026-05-18
---

Исправление: бинарник .NET 6, который печатает `framework_version=6.0.0` и отказывается стартовать, говорит вам, что среды выполнения .NET 6 на машине нет, а не что ваше приложение сломано. На сервере, которому всё ещё разрешено держать `net6.0`, установите среду выполнения Microsoft.NETCore.App 6.0, и ошибка запуска исчезнет. На сервере, который уже перешёл на net8.0 или net10.0, либо выставьте `rollForward` в `Major` в `runtimeconfig.json`, либо переведите проект на поддерживаемый фреймворк, либо опубликуйте self-contained, чтобы бинарник нёс собственную среду выполнения. `MissingMethodException` сразу после такого исправления -- это та же самая проблема с замедленным взрывателем: roll-forward позволил приложению стартовать на более новой среде выполнения, но какая-то транзитивная сборка жёстко привязывается к методу, который был в .NET 6 и который в более новой среде выполнения переименовали.

```text
You must install or update .NET to run this application.

App: /opt/myapp/MyApp
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
.NET location: /usr/share/dotnet

The following frameworks were found:
  8.0.15 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]
  10.0.0 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=6.0.0&arch=x64&rid=linux-x64&os=linux
```

Это руководство написано для ситуации, которая существует в мае 2026 года: .NET 6 достиг конца поддержки 2024-11-12, поэтому продакшен-образы, менеджеры пакетов и базовые слои, которые обновляются автоматически, начали его деинсталлировать. Тот же самый бинарник, который два года работал в продакшене, теперь не стартует и выдаёт сообщение выше. Поведение идентично, будь хост `dotnet.exe MyApp.dll` под Windows, заглушка apphost под Linux или `dotnet exec` под macOS. Правила probing среды выполнения, описанные здесь, -- это правила хостов .NET 6, .NET 8 и .NET 10; между версиями они не менялись.

## Две ошибки, одна корневая причина

Ошибка появляется в двух обличиях, которые выглядят несвязанными, и именно вторая ловит большинство команд.

Первое обличие -- это ошибка host-fxr выше. Хост открывает `MyApp.runtimeconfig.json`, читает `tfm` и блок `framework` и решает, что ему нужен `Microsoft.NETCore.App` версии 6.0.0. Затем он обходит пути установки и находит либо ничего, либо только более новые папки SxS. Install-URL включает имя фреймворка и версию как query-параметры, поэтому любой поиск по `framework_version=6.0.0` приходит к одной и той же проблеме.

Второе обличие -- `MissingMethodException` в рантайме. Хост нашёл совместимый фреймворк, процесс стартовал, и затем поиск `JIT_GetMethodCall` провалился:

```text
System.MissingMethodException: Method not found: 'System.String System.String.IsNullOrEmpty(System.String)'
   at MyApp.Services.RequestPipeline.HandleAsync(HttpContext ctx)
```

Так бывает, когда приложение стартовало на более новой среде выполнения, но одна из загруженных сборок была скомпилирована против reference-сборки .NET 6 и ссылается на метод, чья сигнатура изменилась в .NET 8 или .NET 10. Roll-forward провёл вас мимо проверки запуска, и платой стала отложенная ошибка привязки в пользовательском коде. Оба сообщения означают, что среды выполнения .NET 6 на этой машине нет.

## Почему ваш бинарник просит именно 6.0.0

Строка версии `6.0.0` -- это не версия среды выполнения, которая стояла, когда вы собирали проект. Это нижняя граница, объявленная `<TargetFramework>`, против которой вы компилировали. Когда вы запускаете `dotnet publish` на проекте `net6.0`, MSBuild пишет `MyApp.runtimeconfig.json` вот такого вида:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    },
    "configProperties": {
      "System.Runtime.TieredCompilation": true
    }
  }
}
```

Хост использует это поле `version` как минимум, а не как точное совпадение. С политикой `rollForward` по умолчанию `Minor` он принимает любой 6.x, но никогда 7.x и выше. С `Major` принимает 7.x, 8.x, 10.x. С `LatestPatch` принимает только 6.0.x. Причина, по которой ваш поисковый запрос содержит `framework_version=6.0.0`, в том, что хост повторяет запрошенную нижнюю границу, даже когда никакого 6.x не установлено вовсе.

Запустите `dotnet --list-runtimes` на сбоящем хосте. Если вы видите `Microsoft.NETCore.App 8.0.15` и `10.0.0`, но ни одной строки 6.x, это и есть диагноз. Строка, которая должна там быть, -- `Microsoft.NETCore.App 6.0.x [/usr/share/dotnet/shared/Microsoft.NETCore.App]`.

## Минимальное воспроизведение

Соберите консольное приложение `net6.0`, опубликуйте framework-dependent и запустите на хосте, где установлены только более новые среды выполнения.

```xml
<!-- MyApp.csproj, .NET SDK 8.0.300+ still builds net6.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MyApp/Program.cs, .NET 6, C# 10
Console.WriteLine($"Running on .NET {Environment.Version}");
```

```bash
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
./out/MyApp
# You must install or update .NET to run this application.
# Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
```

Баг проявляется так же в Docker-образе, который сменил базу с `mcr.microsoft.com/dotnet/aspnet:6.0` на `mcr.microsoft.com/dotnet/aspnet:8.0` без смены таргета проекта. Тег `net6.0` в `runtimeconfig.json` переживает обновление базового образа.

## Исправление один, рекомендуемое: смените таргет проекта

Поддерживаемый ответ в 2026 году -- перестать выпускать `net6.0`. .NET 6 перестал получать патчи безопасности в ноябре 2024, .NET 7 -- в мае 2024, .NET 9 -- в мае 2026. Единственные сейчас поддерживаемые ветки -- `net8.0` (LTS, поддерживается до ноября 2026), `net10.0` (LTS, поддерживается до ноября 2028) и разрабатываемые превью `net11.0`.

Измените файл проекта, выполните restore и опубликуйте заново:

```xml
<!-- MyApp.csproj, .NET SDK 10.0.x -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```bash
dotnet restore
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
```

Теперь `runtimeconfig.json` декларирует `version: 10.0.0`, и хост с установленным `Microsoft.NETCore.App 10.0.0` запускает его без претензий. Это единственное исправление, которое также убирает вариант с `MissingMethodException`, потому что приложение теперь компилируется против тех же reference-сборок, что и среда выполнения, на которой оно будет работать.

Если проект зависит от пакета, который не выпустил сборку под `net10.0`, обычно у вас два выхода: повысить версию пакета или поставить `<TargetFrameworks>net6.0;net10.0</TargetFrameworks>` и выпускать multi-target-результат. Хост на новом сервере выбирает `net10.0`, легаси-хост на старом сервере выбирает `net6.0`, и оба продолжают работать, пока вы полностью не выведете из эксплуатации машины 6.x.

## Исправление два, малозатратное: roll forward на более новую среду выполнения

Когда смена таргета заблокирована (вендорский бинарник, который нельзя перекомпилировать, медленный релизный цикл, юридическая проверка каждой сборки), заставьте бинарник .NET 6 стартовать на более новой среде выполнения, изменив его политику `rollForward`. Это можно сделать в двух местах.

В проекте до публикации:

```xml
<!-- MyApp.csproj, still net6.0 -->
<PropertyGroup>
  <TargetFramework>net6.0</TargetFramework>
  <RollForward>Major</RollForward>
</PropertyGroup>
```

Или в уже опубликованном артефакте, отредактировав `MyApp.runtimeconfig.json` рядом с бинарником:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "rollForward": "Major",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    }
  }
}
```

Или не трогая файл, выставив переменную окружения для одного запуска:

```bash
DOTNET_ROLL_FORWARD=Major ./out/MyApp
```

`Major` принимает любую более новую major-версию. `LatestMajor` делает то же самое, но всегда выбирает самый высокий установленный major, и именно этого обычно хотят продакшен-парки, охватывающие несколько мажорных версий среды выполнения. Перезапустите процесс -- и ошибки запуска нет.

Roll-forward -- это исправление, которое позже порождает `MissingMethodException`. Если какой-то пакет в вашем графе зависимостей был скомпилирован против reference-сборок .NET 6 и вызвал метод, который был удалён или переименован в .NET 8 или .NET 10, JIT обнаружит это при первом проходе через этот путь кода. Обходного пути для такого случая нет, кроме обновления виновного пакета или возврата к исправлению один.

## Исправление три, крайняя мера: установите среду выполнения .NET 6

Когда машина обязана сохранить неподдерживаемую среду выполнения, установите её явно. Microsoft по-прежнему хостит загрузки среды выполнения .NET 6, помеченные как end-of-life, по тому же URL, на который указывала ошибка запуска.

На Debian и Ubuntu пакет называется `dotnet-runtime-6.0`:

```bash
sudo apt-get install -y dotnet-runtime-6.0
dotnet --list-runtimes
# Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
# Microsoft.NETCore.App 8.0.15 [...]
# Microsoft.NETCore.App 10.0.0 [...]
```

На Windows установите через `winget install Microsoft.DotNet.Runtime.6` или отдельный MSI. В Docker-образе верните `FROM mcr.microsoft.com/dotnet/aspnet:8.0` обратно на `FROM mcr.microsoft.com/dotnet/aspnet:6.0` или используйте multi-version-образ `mcr.microsoft.com/dotnet/runtime-deps:6.0` со слоем, явно устанавливающим `dotnet-runtime-6.0`.

Зафиксируйте `dotnet-runtime-6.0` через hold, чтобы следующее автоматическое обновление снова его не удалило:

```bash
sudo apt-mark hold dotnet-runtime-6.0
```

Это отсрочка, а не исправление. Среда выполнения больше не получает патчей безопасности, поэтому любой CVE в `System.Net.Http` или `System.Text.Json` 6.x остаётся непатченным на этой машине. Воспринимайте это как продление срока, пока вы доводите до конца исправление один.

## Исправление четыре, изоляция: публикация self-contained

Если вы контролируете сборку, но не deploy-таргет, везите среду выполнения внутри артефакта. Self-contained-публикация кладёт файлы `Microsoft.NETCore.App` рядом с вашими DLL, и хост никогда не спрашивает среду выполнения у системы.

```bash
dotnet publish -c Release -r linux-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=false \
  -o ./out
```

Размер вырастает примерно на 70 МБ, и на deploy-машине ничего ставить не нужно. Это работает и для `net6.0`, но SDK, выполняющий сборку, должен ещё уметь резолвить ref-pack `net6.0`; .NET SDK 10.0.x на момент написания всё ещё может таргетить `net6.0`, поэтому на свежем SDK сборка проходит нормально.

Self-contained -- правильный ответ для одноразовых утилит, CI-скриптов, sidecar и везде, где вы не диктуете окружение хоста. Это неправильный ответ для парков, где общий патчинг среды выполнения -- часть политики безопасности, потому что теперь каждое приложение имеет свою копию `System.Net.Http` и его придётся пересобирать при каждом CVE.

## Сначала диагностика, потом исправление

У хоста есть verbose-режим, который выводит ровно то, что он ищет и где. Выставьте `COREHOST_TRACE=1` (и опционально `COREHOST_TRACEFILE=/tmp/host.log`) и снова запустите сбоящий бинарник:

```bash
COREHOST_TRACE=1 COREHOST_TRACEFILE=/tmp/host.log ./out/MyApp
grep -E "version|framework|rollForward" /tmp/host.log
```

Лог перечисляет все версии фреймворка, которые хост рассмотрел, какую политику `rollForward` применил и какие пути обошёл. Если лог говорит, что нашёл 8.0.15, но отверг, потому что был выставлен `rollForward=LatestPatch`, вы знаете, что надо менять политику. Если лог говорит, что под `/usr/share/dotnet/shared/Microsoft.NETCore.App` ничего не нашлось, вы знаете, что надо устанавливать или переносить.

Для варианта `MissingMethodException` трассировка стека называет сборку, которая привязалась к неправильному методу. Откройте опубликованную папку, запустите `dotnet --info` против хоста, чтобы подтвердить версию среды выполнения, и инспектируйте проблемную DLL через `ildasm` или `dotnet-ildasm`, чтобы убедиться, что она ссылается на reference-сборку 6.0. Замените пакет на тот, у которого есть сборка под `net8.0` или `net10.0`, либо используйте binding redirects через `<AssemblyLoadContext>`, если вам приходится держать обе.

## Подводные камни и двойники

Параметр `framework_version` в URL -- это **не** установленная версия среды выполнения, а нижняя граница, которую запросило приложение. Поиск конкретно "install .NET 6.0.0" -- тупик, потому что поставляемый патч -- это что-то вроде 6.0.36. Ставьте последний 6.0.x, а не 6.0.0.

`MissingMethodException` на `Microsoft.AspNetCore.App`, а не на `Microsoft.NETCore.App`, следует той же логике, но указывает на общий фреймворк ASP.NET Core. Те же пути решения, та же ручка `rollForward`, другое имя общего фреймворка в .deps.json.

`dotnet --info` перечисляет SDK и среды выполнения. Среда выполнения, которую использует ваше приложение, -- та, что числится под "Microsoft.NETCore.App". Если установлено только "Microsoft.AspNetCore.App 6.0.x", приложения ASP.NET Core будут стартовать, а консольные приложения по-прежнему будут отдавать исходную ошибку, потому что общий фреймворк ASP.NET зависит от среды выполнения .NET, но это не одна и та же установка.

Под Windows apphost -- это `MyApp.exe`, а не `dotnet.exe`. Сообщение об ошибке идентично, диагностика идентична, и `where dotnet` отвечает на неправильный вопрос. Используйте `MyApp.exe --info`, чтобы подтвердить, какой хост запущен.

Если бинарник запускается из Azure App Service или хоста Functions, платформа выставляет путь к среде выполнения за вас. Исправление -- это значение "Stack" в конфигурации App Service, а не локальный файл. Связанный вариант для App Service разобран в [Указанная версия Microsoft.NetCore.App или Microsoft.AspNetCore.App не найдена](/ru/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/), где та же корневая причина проходится с порталом Azure перед глазами.

## Связанное

- [Исправление: Could not load file or assembly в опубликованном приложении](/ru/2026/05/fix-could-not-load-file-or-assembly-in-published-app/), когда хост нашёл среду выполнения, но DLL проекта отсутствует в папке публикации.
- [Azure App Service: Microsoft.NetCore.App не найден](/ru/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) для той же корневой причины, когда хостом владеет платформа.
- [Исправление: Команда 'dotnet' не найдена на CI](/ru/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/), когда среды выполнения нет даже в PATH.
- [Исправление: The type or namespace name could not be found после ProjectReference](/ru/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/), когда смена таргета приводит к расхождению TargetFramework `NU1201`.
- [Исправление: PlatformNotSupportedException в Native AOT](/ru/2026/05/fix-platformnotsupportedexception-in-native-aot/) для родственного класса ошибок runtime-хоста, всплывающих только после публикации.

## Источники

- [Объявление об окончании поддержки .NET 6](https://learn.microsoft.com/en-us/lifecycle/announcements/dotnet-6-end-of-support) и расписание релизов .NET -- что ещё патчится.
- [Roll forward для framework-dependent-приложений](https://learn.microsoft.com/en-us/dotnet/core/versions/selection#framework-dependent-apps-roll-forward) -- полная таблица политик `rollForward`.
- [Self-contained deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/) -- процесс публикации с `--self-contained`.
- [Параметры конфигурации среды выполнения .NET](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/) -- полная схема `runtimeconfig.json`.
- [dotnet/runtime issue #79286](https://github.com/dotnet/runtime/issues/79286) -- канонический тред о логике разрешения фреймворков хостом и о флаге трассировки.

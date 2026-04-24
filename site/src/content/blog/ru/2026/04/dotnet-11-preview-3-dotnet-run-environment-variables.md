---
title: ".NET 11 Preview 3: dotnet run -e задаёт переменные окружения без launch profiles"
description: "dotnet run -e в .NET 11 Preview 3 передаёт переменные окружения напрямую из CLI и поднимает их как MSBuild items RuntimeEnvironmentVariable."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "dotnet-cli"
  - "msbuild"
lang: "ru"
translationOf: "2026/04/dotnet-11-preview-3-dotnet-run-environment-variables"
translatedBy: "claude"
translationDate: 2026-04-24
---

.NET 11 Preview 3 вышел 14 апреля 2026 года с маленьким, но широко применимым изменением SDK: `dotnet run` теперь принимает `-e KEY=VALUE` для передачи переменных окружения прямо из командной строки. Без shell-exports, без правок `launchSettings.json`, без одноразовых wrapper-скриптов.

## Почему флаг важен

До Preview 3 установить env var для одиночного запуска означало один из трёх неуклюжих вариантов. На Windows у вас было `set ASPNETCORE_ENVIRONMENT=Staging && dotnet run` с сюрпризами quoting в `cmd.exe`. В bash - `ASPNETCORE_ENVIRONMENT=Staging dotnet run`, который работает, но кровоточит переменную в любой дочерний процесс, который форкается от shell. Или вы добавляли очередной profile в `Properties/launchSettings.json`, который никому больше в команде по-настоящему не нужен.

`dotnet run -e` берёт эту работу на себя и держит scope плотно привязанным к самому запуску.

## Синтаксис и что он фактически задаёт

Передавайте по одному `-e` на переменную. Флаг можно повторять сколько угодно раз:

```bash
dotnet run -e ASPNETCORE_ENVIRONMENT=Development -e LOG_LEVEL=Debug
```

SDK инжектирует эти значения в окружение запускаемого процесса. Ваше приложение видит их через `Environment.GetEnvironmentVariable` или через pipeline конфигурации ASP.NET Core как любую другую переменную:

```csharp
var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
Console.WriteLine($"Running as: {env}");
```

Есть второй, менее очевидный побочный эффект, который стоит знать: те же переменные поднимаются в MSBuild как items `RuntimeEnvironmentVariable`. Это значит, что targets, работающие во время фазы build у `dotnet run`, тоже могут их читать, что открывает сценарии вроде гейтинга кодогенерации по флагу или замены resource-файлов по окружениям.

## Чтение items RuntimeEnvironmentVariable из target

Если у вас кастомный target, который должен реагировать на флаг, перечислите items, которые MSBuild уже заполнил:

```xml
<Target Name="LogRuntimeEnvVars" BeforeTargets="Build">
  <Message Importance="high"
           Text="Runtime env: @(RuntimeEnvironmentVariable->'%(Identity)=%(Value)', ', ')" />
</Target>
```

Запустите `dotnet run -e FEATURE_X=on -e TENANT=acme`, и target напечатает `FEATURE_X=on, TENANT=acme` до старта приложения. Это обычные MSBuild items, так что их можно фильтровать `Condition`, кормить в другие properties или использовать для управления решениями `Include`/`Exclude` внутри того же build.

## Где это укладывается в workflow

`dotnet run -e` не заменяет `launchSettings.json`. Launch profiles всё ещё имеют смысл для общих конфигураций, которые вы используете каждый день, и для debug-сценариев в Visual Studio или Rider. CLI-флаг лучше подходит для one-shot-кейсов: воспроизвести баг, который кто-то сообщил под конкретным `LOG_LEVEL`, протестировать feature flag без коммита profile или быстро подвязать CI-step в `dotnet watch` без переписывания YAML.

Мелкая оговорка: значения с пробелами или shell-специальными символами всё ещё требуют quoting для вашего shell. `dotnet run -e "GREETING=hello world"` подходит в bash и PowerShell, `dotnet run -e GREETING="hello world"` работает в `cmd.exe`. Сам SDK принимает присваивание как есть, но shell парсит командную строку первым.

Самая маленькая фича .NET 11 Preview 3 на бумаге и, наверное, одна из самых используемых на практике. Полные release notes живут в [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk), а пост-анонс - в [блоге .NET](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

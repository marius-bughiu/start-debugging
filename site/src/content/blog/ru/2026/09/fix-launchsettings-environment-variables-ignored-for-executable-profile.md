---
title: "Исправление: переменные окружения из launchSettings.json игнорируются в профиле с commandName: Executable"
description: "Если ваш профиль Executable запускает dotnet run или dotnet watch, вложенная команда применяет профиль по умолчанию и перезаписывает ваши переменные. Добавьте --no-launch-profile и используйте SDK 10.0.200+."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dotnet-cli"
  - "launchsettings"
  - "dotnet-watch"
  - "dotnet-10"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/09/fix-launchsettings-environment-variables-ignored-for-executable-profile"
translatedBy: "claude"
translationDate: 2026-09-30
---

Если ваш профиль `commandName: "Executable"` запускает `dotnet run` или `dotnet watch run`, добавьте `--no-launch-profile` (или `--launch-profile <name>`) в его `commandLineArgs`. Иначе вложенная команда выбирает профиль проекта по умолчанию, и `environmentVariables` этого профиля перезаписывают те, что только что задал ваш профиль Executable. Если CLI выводит "The launch profile type 'Executable' is not supported", у вас SDK старше 10.0.200. Обновитесь, потому что такие SDK пропускают профиль целиком. Всё описанное ниже я измерял на macOS с SDK 10.0.112, 10.0.302, 10.0.401 и 11.0.100-rc.1.

## Ошибка в контексте

У этой проблемы две версии, и какая из них вам встретится, зависит от SDK.

На SDK 10.0.1xx (и более ранних SDK, которые понимали только профили Project) `dotnet run --launch-profile` сообщает об этом прямо, а затем всё равно запускает проект:

```
Using launch settings from /src/app/Properties/launchSettings.json...
The launch profile "Exe" could not be applied.
The launch profile type 'Executable' is not supported.
MY_MODE=<null> DOTNET_ENVIRONMENT=<null> DOTNET_LAUNCH_PROFILE=<null> args=[] cwd=/src/app
```

Это сообщение легко пропустить, потому что приложение запускается. Просто запускается оно вообще без профиля: без переменных окружения, без `commandLineArgs`, даже без `DOTNET_LAUNCH_PROFILE`.

На 10.0.200 и новее предупреждения нет. Профиль выполняется, но приложение видит неверные значения. Именно этот случай описан в [dotnet/sdk#56023](https://github.com/dotnet/sdk/issues/56023): профиль "Watch" задаёт `ASPNETCORE_ENVIRONMENT=Development`, а приложение всё равно сообщает `Production`. Единственная подсказка в том, что строка "Using launch settings" выводится дважды:

```
Using launch settings from /src/app/Properties/launchSettings.json...
Using launch settings from /src/app/Properties/launchSettings.json...
MY_MODE=from-Default DOTNET_ENVIRONMENT=Production DOTNET_LAUNCH_PROFILE=Default args=[] cwd=/src/app
```

## Почему переменные теряются

Причины, от самых частых к редким:

1. **Вложенная команда SDK заново применяет профиль.** `dotnet run` корректно применяет профиль Executable. Он запускает `executablePath` с заданными `environmentVariables` профиля. Но когда этот исполняемый файл сам является `dotnet` (`run`, `watch run`), дочерний процесс представляет собой новый `dotnet run` без `--launch-profile`. Он читает тот же `launchSettings.json`, выбирает *первый* профиль с поддерживаемым `commandName` и задаёт переменные этого профиля для процесса приложения. Переменные профиля приоритетнее унаследованных (см. `SetEnvironmentVariables` в [`RunCommand.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Cli/dotnet/Commands/Run/RunCommand.cs)), поэтому ваши внешние значения молча заменяются.
2. **SDK старше 10.0.200.** Поддержка Executable в `dotnet run` и `dotnet watch` появилась в [dotnet/sdk#51727](https://github.com/dotnet/sdk/pull/51727), слитом в `release/10.0.2xx` 12 декабря 2025 года. До этого CLI знал только `commandName: "Project"`. Visual Studio всегда поддерживала профили Executable, поэтому тот же файл "работает в VS".
3. **IDE никогда не читает профили Executable.** Расширение C# для VS Code указывает в [настройках отладчика](https://code.visualstudio.com/docs/csharp/debugger-settings), что "Only profiles with `"commandName": "Project"` are supported". Выбор профиля Executable там никак не задействует его переменные.

## Как dotnet run выбирает профиль и накладывает переменные

Полезно знать точный порядок, которому следует CLI, потому что каждое обходное решение ниже лишь способ управлять одним из этих шагов. На SDK 10.0.200 и новее `dotnet run` делает следующее:

1. Если передан `--no-launch-profile`, профиль не используется вообще. На этом всё.
2. Иначе он ищет `Properties/launchSettings.json` (`My Project/launchSettings.json` для VB или `<app>.run.json` рядом с файловым приложением).
3. С `--launch-profile <name>` выбирается указанный профиль. Поиск сначала учитывает регистр, затем переходит к совпадению без учёта регистра. Без этого флага выбирается первый профиль, у которого `commandName` равен `Project` или `Executable`. Любое другое имя команды (`IISExpress`, `Docker`, `DotNetCore`) пропускается.
4. Окружение дочернего процесса строится из трёх слоёв. Сначала унаследованное окружение процесса `dotnet`. Затем `DOTNET_LAUNCH_PROFILE`, плюс `ASPNETCORE_URLS` из `applicationUrl` для профилей Project и каждая запись из `environmentVariables`. Наконец, любые `-e KEY=VALUE` из командной строки. Более поздние слои побеждают.

Шаг 4 и объясняет, почему вложенный случай не работает. Внешний `dotnet run` помещает ваши значения в первый слой внутреннего `dotnet run`, а второй слой внутренней команды их заменяет. Внутренний процесс ничего не знает о том, что его запустили из профиля запуска. Любое исправление сводится к тому, чтобы заставить внутренний шаг 1 или шаг 3 вести себя иначе.

## Минимальный пример воспроизведения

Консольное приложение, которое печатает то, что реально получило:

```csharp
// .NET 10, C# 14 - Program.cs (ImplicitUsings enabled)
Console.WriteLine($"MY_MODE={Environment.GetEnvironmentVariable("MY_MODE") ?? "<null>"} " +
                  $"DOTNET_ENVIRONMENT={Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "<null>"} " +
                  $"DOTNET_LAUNCH_PROFILE={Environment.GetEnvironmentVariable("DOTNET_LAUNCH_PROFILE") ?? "<null>"} " +
                  $"args=[{string.Join(",", args)}] cwd={Environment.CurrentDirectory}");
```

И `Properties/launchSettings.json` с обычным профилем Project в начале, затем тремя профилями Executable:

```json
{
  "profiles": {
    "Default": {
      "commandName": "Project",
      "environmentVariables": { "MY_MODE": "from-Default", "DOTNET_ENVIRONMENT": "Production" }
    },
    "Exe": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "bin/Debug/net10.0/app.dll hello",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Exe", "DOTNET_ENVIRONMENT": "Development" }
    },
    "ExeDotnetRun": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "run --no-build",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-ExeDotnetRun", "DOTNET_ENVIRONMENT": "Development" }
    },
    "Watch": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "watch run --non-interactive",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
    }
  }
}
```

Запуск `dotnet run --no-build --launch-profile <name>` на каждом SDK вывел следующее:

| Профиль | 10.0.112 | 10.0.302 / 10.0.401 / 11.0.100-rc.1 |
| --- | --- | --- |
| `Default` (Project) | `from-Default` | `from-Default` |
| `Exe` (запускает `app.dll`) | предупреждение "not supported", `<null>` | `from-Exe`, `Development`, args `[hello]` |
| `ExeDotnetRun` | предупреждение "not supported", `<null>` | `from-Default`, `Production` |
| `Watch` | предупреждение "not supported", `<null>` | `from-Default`, `Production` (10.0.302) |

Строка `Exe` показывает, что сама поддержка профилей Executable на современных SDK работает. Строки `ExeDotnetRun` и `Watch` показывают перезапись: внутренняя команда сообщает `DOTNET_LAUNCH_PROFILE=Default`, то есть сама подхватила первый профиль.

## Исправление по шагам

1. **Проверьте SDK.** Выполните `dotnet --version` в каталоге проекта, потому что `global.json` может закреплять более старую ветку. Чтобы `dotnet run` и `dotnet watch` вообще учитывали профили Executable, нужна версия 10.0.200 или новее. На 10.0.1xx держите переменные в профиле `Project`.
2. **Не давайте вложенной команде выбирать профиль.** Если `executablePath` равен `dotnet`, а аргументы начинаются с `run` или `watch`, добавьте `--no-launch-profile`:

   ```json
   // .NET SDK 10.0.200+ - Properties/launchSettings.json
   "Watch": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "watch run --non-interactive --no-launch-profile",
     "workingDirectory": "..",
     "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
   }
   ```

   После этого изменения приложение под `dotnet watch` на 10.0.302 вывело `MY_MODE=from-WatchNoProfile DOTNET_ENVIRONMENT=Development`. `DOTNET_LAUNCH_PROFILE` по-прежнему показывает имя внешнего профиля, потому что его задал внешний `dotnet run`, а перезаписать его было нечему.

3. **Или укажите вложенной команде конкретный профиль.** Если переменные уже есть в профиле Project, сошлитесь на него вместо дублирования:

   ```json
   // .NET SDK 10.0.200+
   "ExeDotnetRunPinned": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "run --no-build --launch-profile Dev",
     "workingDirectory": ".."
   }
   ```

   Это вывело `MY_MODE=from-Dev DOTNET_ENVIRONMENT=Development DOTNET_LAUNCH_PROFILE=Dev`. В такой схеме переменными владеет внутренний профиль. Всё, что вы поместите в `environmentVariables` внешнего профиля, проигрывает, если оба профиля задают один и тот же ключ.

4. **В VS Code перенесите переменные в `launch.json`.** Расширение C# читает только профили Project и только их `environmentVariables`, `applicationUrl` и `commandLineArgs`. Вместо этого добавьте блок `env` в конфигурацию запуска `coreclr`. Значения из `launch.json` в любом случае приоритетнее `launchSettings.json`.

## Подводные камни и похожие проблемы

**Профиль Executable, стоящий первым, становится профилем по умолчанию и может бесконечно порождать процессы.** На 10.0.200+ профилем по умолчанию считается первый, у которого `commandName` равен `Project` *или* `Executable` (`IsDefaultProfileType` в [`LaunchSettings.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Microsoft.DotNet.ProjectTools/LaunchSettings/LaunchSettings.cs), и то же правило в `dotnet watch`). Если поместить `"commandLineArgs": "run --no-build"` в первый профиль и выполнить обычный `dotnet run`, каждый дочерний процесс снова выберет тот же профиль. На 10.0.302 я насчитал 53 процесса `dotnet run` через 12 секунд, после чего завершил их. Исправление с `--no-launch-profile` выше тоже разрывает этот цикл. Профиль Project в начале файла остаётся дешёвой страховкой.

**`dotnet run -e` тоже не переживает вложенный переход.** Я проверил `dotnet run -e KEY=VALUE` на SDK 10.0.112 и новее (см. [`dotnet run -e`](/ru/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)). Он переопределяет профиль для процесса, который запускает внешний `dotnet run`. Когда этот процесс сам является другим `dotnet run`, внутренний профиль по умолчанию перезаписывает и это значение: `-lp ExeDotnetRun -e MY_MODE=from-cli` по-прежнему вывел `from-Default`. То же относится к обычному экспорту в оболочке. `MY_MODE=from-shell dotnet run -lp Default` выводит `from-Default`, потому что значения профиля запуска всегда побеждают унаследованные.

**`%VAR%` раскрывается, `$(Property)` нет (пока).** CLI пропускает каждое значение через `Environment.ExpandEnvironmentVariables`, поэтому `%HOME%` работает и на macOS, и на Linux. `$(HOME)` и `${HOME}` передаются как есть. Свойства MSBuild вроде `$(TargetPath)` или `$(ProjectDir)` не раскрываются ни в одном выпущенном SDK, который я проверял (10.0.302, 10.0.401, 11.0.100-rc.1). Вместо молча проигнорированной переменной вы получаете `An error occurred trying to start process '$(TargetPath)' ... No such file or directory`. `ProjectLaunchTargetsProvider` в Visual Studio их раскрывает (согласно [документации по профилям запуска в project-system](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)), поэтому профиль, скопированный из настройки VS, ломается в CLI. [dotnet/sdk#56074](https://github.com/dotnet/sdk/pull/56074) добавляет раскрытие. Он слит в `main` 4 сентября 2026 года, но на сегодня его нет ни в `release/11.0.1xx-rc2`, ни в одной ветке 10.0. Пока он не вышел, используйте относительные пути.

**`workingDirectory` отсчитывается от папки `Properties`, а не от проекта.** CLI вычисляет его как `Path.Combine(Path.GetDirectoryName(launchSettingsPath), value)`, поэтому `".."` означает каталог проекта. Visual Studio и Rider разрешают его иначе, и это сейчас обсуждается в [dotnet/sdk#56129](https://github.com/dotnet/sdk/pull/56129). Для профилей Project CLI на нынешних SDK полностью игнорирует `workingDirectory`.

**Исправление вложенного случая находится на рассмотрении.** [dotnet/sdk#56087](https://github.com/dotnet/sdk/pull/56087) заставляет `dotnet run` задавать маркер `DOTNET_LAUNCH_PROFILE_APPLIED=1` для процессов, которые он запускает из профиля Executable. Вложенный `dotnet run` без явного профиля тогда пропускает профиль по умолчанию. На 2026-09-30 он всё ещё был открыт. Даже после выхода он охватывает только профили, запущенные через CLI. В описании PR отмечено, что IDE, которые запускают профиль Executable напрямую, по-прежнему требуют `--no-launch-profile`.

**`hotReloadEnabled` в профиле Project ничего не делает в `dotnet run`.** Автор #56023 тоже это заметил. Горячая перезагрузка обеспечивается `dotnet watch`, а не свойством профиля. Именно поэтому люди в первую очередь и оборачивают `dotnet watch` в профиль Executable. О том, что добавляет наблюдатель, читайте в [чем `dotnet watch` отличается от `dotnet run`](/ru/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/).

## Связанные материалы

- [.NET 11 Preview 3: dotnet run -e задаёт переменные окружения без профилей запуска](/ru/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [В чем разница между dotnet watch и dotnet run?](/ru/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)
- [Исправление: WebSocket горячей перезагрузки Blazor в dotnet watch не работает на собственном локальном домене](/ru/2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain/), ещё один случай, когда переменные профиля запуска не доходят до нужного процесса
- [Как запустить файловое приложение C# с помощью `dotnet run app.cs`](/ru/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), которое читает профили запуска `<app>.run.json` тем же кодом
- [Как добавить Aspire в существующее решение ASP.NET Core](/ru/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), где собственный профиль запуска AppHost определяет, какое окружение получает каждый сервис

## Источники

- [dotnet/sdk#56023: переменные окружения `launchSettings.json` не передаются для `commandName: Executable`](https://github.com/dotnet/sdk/issues/56023)
- [dotnet/sdk#51727: добавлена поддержка профилей запуска Executable в dotnet run и dotnet watch](https://github.com/dotnet/sdk/pull/51727)
- [dotnet/sdk#56087: сохранение окружения профиля запуска Executable во вложенном dotnet run](https://github.com/dotnet/sdk/pull/56087)
- [dotnet/sdk#56074: раскрытие свойств MSBuild в профилях запуска](https://github.com/dotnet/sdk/pull/56074)
- [dotnet/sdk#49131: разрешить `dotnet run` использовать профили запуска с `commandName: Executable`](https://github.com/dotnet/sdk/issues/49131)
- [dotnet/project-system: документация по профилям запуска](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)
- [Настройки отладчика C# в VS Code: поддержка launchSettings.json](https://code.visualstudio.com/docs/csharp/debugger-settings)
- [Справочник по команде `dotnet run` на Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnet-run)

---
title: "Semantic Kernel 1.81 закрывает утечку сведений о файлах за пределами AllowedFolders в FileIOPlugin"
description: "Semantic Kernel .NET 1.81.0 устраняет оракул в FileIOPlugin: WriteAsync сообщал модели, что файл вне AllowedFolders существует, доступен только для чтения и где он находится. Замеры до и после."
pubDate: 2026-10-09
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
lang: "ru"
translationOf: "2026/10/semantic-kernel-1-81-fileioplugin-no-longer-leaks-paths-outside-allowedfolders"
translatedBy: "claude"
translationDate: 2026-10-09
---

Semantic Kernel .NET [1.81.0](https://github.com/microsoft/semantic-kernel/releases/tag/dotnet-1.81.0) вышел 6 октября 2026 года, и в тот же день на NuGet появился `Microsoft.SemanticKernel.Plugins.Core` 1.81.0-preview. В заметках к выпуску [PR #14525](https://github.com/microsoft/semantic-kernel/pull/14525) назван "Update file handling for FileIOPlugin", и это сильно преуменьшает суть. Вплоть до 1.80.1 метод `FileIOPlugin.WriteAsync` проверял, доступен ли файл только для чтения, *до* проверки `AllowedFolders`, а выбрасываемое исключение содержало полный канонический путь. Если этот плагин доступен модели, он работает как оракул существования файлов для всего диска.

Это уже второй подряд выпуск с усилением защиты файлового и сетевого доступа после того, как [1.80.0 запретил плагинам OpenAPI следовать перенаправлениям](/ru/2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects/).

## Что модель могла узнать в 1.80.1

Я запустил одну и ту же файловую проверку на обеих версиях с SDK 10.0.302. Она создает доступный только для чтения `secrets.txt` вне разрешенной папки, рядом с ним несуществующий `nope.txt`, а также доступный только для чтения `locked.txt` внутри разрешенной папки, после чего вызывает `WriteAsync` для каждого из них:

```csharp
#:package Microsoft.SemanticKernel.Plugins.Core@1.80.1-preview
#:property PublishAot=false
#:property NoWarn=SKEXP0050
using Microsoft.SemanticKernel.Plugins.Core;

// allowed, readOnlyOutside, missingOutside, readOnlyInside: temp paths set up earlier
var plugin = new FileIOPlugin { AllowedFolders = [allowed], DisableFileOverwrite = false };

foreach (var f in new[] { readOnlyOutside, missingOutside, readOnlyInside })
{
    try { await plugin.WriteAsync(f, "y"); }
    catch (Exception e) { Console.WriteLine($"{Path.GetFileName(f)}: {e.GetType().Name}: {e.Message}"); }
}
```

Вывод на 1.80.1-preview (временный путь сокращен):

```text
secrets.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/outside/secrets.txt
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/allowed/locked.txt
```

Проблема в первых двух строках. Для файла вне песочницы выбрасывается другое исключение, чем для несуществующего, поэтому факт существования файла можно наблюдать. То же самое происходит и с `new FileIOPlugin()` по умолчанию, у которого `AllowedFolders` пуст, то есть с конфигурацией, задокументированной как "no folders allowed".

И это сообщение действительно доходит до модели. При автоматическом вызове функций `FunctionCallsProcessor` перехватывает исключение и возвращает в качестве результата инструмента `Error: Exception while invoking function. {e.Message}`. Агент, подвергшийся prompt injection, может прощупывать пути вроде `~/.ssh/id_rsa` или `/etc/shadow` и считывать ответ.

## Что меняется в 1.81.0

`TryGetAllowedFilePath` теперь сразу возвращает `false`, если папки не настроены, оборачивает канонизацию пути в перехват `IOException`, `UnauthorizedAccessException`, `InvalidOperationException` и `SecurityException` (так что циклы символических ссылок и ошибки прав доступа превращаются в обычный отказ) и выполняет проверку на режим только для чтения лишь после того, как путь совпал с разрешенной папкой. Из исключения о режиме только для чтения также убран путь. Та же проверка на 1.81.0-preview:

```text
secrets.txt: InvalidOperationException: Writing to the provided location is not allowed.
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only.
```

За пределами песочницы все случаи теперь неотличимы. Внутри нее вы по-прежнему получаете полезную ошибку, но без пути. [PR #14476](https://github.com/microsoft/semantic-kernel/pull/14476), также вошедший в 1.81.0, применяет такое же выравнивание проверок к `DocumentPlugin` и `CloudDrivePlugin`.

## Что делать

Обновите `Microsoft.SemanticKernel.Plugins.Core` до `1.81.0-preview`, если хоть один агент может вызывать `FileIOPlugin`. Публичный API не изменился, так что достаточно поднять версию. Если у вас есть собственные обертки над файловыми инструментами, позаимствуйте этот подход: сначала проверяйте песочницу, возвращайте одно и то же сообщение при любом отказе и никогда не помещайте разрешенный путь в исключение, которое результат инструмента может вернуть модели.

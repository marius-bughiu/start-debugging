---
title: "Agent Framework 1.21: LocalCodeAct больше не передает окружение хоста в Python, написанный моделью"
description: "Microsoft Agent Framework .NET 1.21.0 поставляет Microsoft.Agents.AI.LocalCodeAct 1.21.0-preview.260911.1, в котором Python-подпроцесс CodeAct больше не наследует окружение родительского процесса, когда Environment равен null. В 1.20 сгенерированный код мог прочитать любую переменную хоста, включая API-ключи."
pubDate: 2026-09-13
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "codeact"
  - "security"
lang: "ru"
translationOf: "2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment"
translatedBy: "claude"
translationDate: 2026-09-13
---

Microsoft Agent Framework [dotnet-1.21.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.21.0) вышел 2026-09-11, и одна строка в его списке изменений заслуживает больше внимания, чем, скорее всего, получит: "[BREAKING] .NET: Isolate LocalCodeAct subprocess environment" ([PR #8159](https://github.com/microsoft/agent-framework/pull/8159)). Если вы используете `Microsoft.Agents.AI.LocalCodeAct` и никогда не задавали `LocalCodeActProviderOptions.Environment`, то до этого релиза Python, который пишет ваша модель, мог прочитать любую переменную окружения процесса хоста.

## Две документации, одно поведение

`LocalCodeAct` - это вариант провайдера Hyperlight CodeAct без песочницы: модель пишет Python, а пакет после проверки AST запускает его в дочернем процессе `python` на хосте. README пакета уже обещал, что подпроцесс "does NOT inherit the host environment by default", то есть по умолчанию не наследует окружение хоста. XML-документация к `Environment` утверждала обратное: `null` означает наследование, а для очищенного окружения нужно передать пустой словарь. Код следовал XML-документации. `ProcessBridge.ConfigureEnvironment` сразу возвращал управление, если словарь был равен `null`, поэтому `ProcessStartInfo` сохранял все окружение родительского процесса.

Это важно, потому что валидатор намеренно разрешает доступ к `os.environ` только на чтение. Поэтому в 1.20 такой код проходил проверку:

```csharp
Environment.SetEnvironmentVariable("FAKE_OPENAI_API_KEY", "sk-leaked-from-host");

var fn = new LocalExecuteCodeFunction("/opt/homebrew/bin/python3.14");
var result = await fn.InvokeAsync(new AIFunctionArguments
{
    ["code"] = "import os\nprint(os.environ.get('FAKE_OPENAI_API_KEY', 'NOT_FOUND'))\nprint(len(os.environ))",
});
```

Я запустил именно эту проверку как файловое приложение .NET 10 (SDK 10.0.302, macOS, Python 3.14) на обеих версиях пакета:

```text
1.20.0-preview.260831.1  default options   -> sk-leaked-from-host, 63 variables
1.21.0-preview.260911.1  default options   -> NOT_FOUND, 2 variables
both versions            Environment set   -> NOT_FOUND, 3 variables
```

Все, что выводит `execute_code`, попадает прямо обратно в контекст модели. Внедренной через промпт инструкции "print the environment" было достаточно, чтобы ваш ключ OpenAI, строка подключения к хранилищу или `AZURE_CLIENT_SECRET` оказались в транскрипте, а оттуда в любой инструмент хоста, который может вызвать агент.

## Что теперь делает 1.21

`ConfigureEnvironment` теперь всегда вызывает `startInfo.Environment.Clear()` и затем копирует только то, что вы положили в `Environment`. `null` и пустой словарь ведут себя одинаково. В Windows переменные `SYSTEMROOT`, `SYSTEMDRIVE`, `COMSPEC`, `PATHEXT`, `TEMP` и `TMP` дозаполняются из родительского процесса, если вы их не задали, потому что без них Python не может загрузить свою стандартную библиотеку.

Обратная сторона в том, что все, на что сгенерированный код неявно полагался, исчезло, включая `PATH` и `HOME` в Linux и macOS. Если подключенному скрипту или разрешенному модулю нужна переменная, передайте ее явно:

```csharp
using Microsoft.Agents.AI.LocalCodeAct;

using var provider = new LocalCodeActProvider("/usr/bin/python3", new LocalCodeActProviderOptions
{
    Environment = new Dictionary<string, string>
    {
        ["LOG_LEVEL"] = "INFO",
        ["TZ"] = "UTC",
    },
});
```

Не кладите секреты в этот словарь. Если сгенерированному коду нужен аутентифицированный вызов, зарегистрируйте инструмент хоста, который хранит учетные данные, и дайте Python обращаться к нему через `await call_tool(...)`.

## Два связанных изменения LocalCodeAct в том же релизе

[PR #8239](https://github.com/microsoft/agent-framework/pull/8239) ужесточает валидатор, чтобы псевдонимы, полученные через OS, рефлексивный доступ и изменение окружения последовательно отклонялись, а [PR #8289](https://github.com/microsoft/agent-framework/pull/8289) приводит подтверждения в соответствие с Hyperlight: если любой зарегистрированный инструмент является `ApprovalRequiredAIFunction`, подтверждения требует и сам `execute_code`, а `LocalCodeActApprovalMode.AlwaysRequire` включает его для каждого запуска.

Ничто из этого не превращает `LocalCodeAct` в песочницу, и README по-прежнему прямо говорит об этом в блоке с предупреждением. Его место внутри контейнера, виртуальной машины или размещенного агента Foundry. Если вы еще решаете, стоит ли код, написанный моделью, такой настройки вообще, я сравнил компромиссы в статье [CodeAct против традиционного цикла вызова инструментов](/2026/07/codeact-vs-tool-calling-loop-for-agents/). Если вы уже его используете, обновитесь до `1.21.0-preview.260911.1` и проверьте, что вы передаете в `Environment`.

---
title: "Visual Studio 18.8 приносит встроенные skills агента для .NET и сразу их отключает"
description: "Visual Studio 2026 18.8 помещает написанные экспертами skills агента для .NET и Azure в выбор инструментов, в категорию Built-in и выключенными по умолчанию. Именно это значение по умолчанию и интересно."
pubDate: 2026-08-02
tags:
  - "visual-studio"
  - "dotnet"
  - "ai-agents"
  - "agent-skills"
  - "github-copilot"
lang: "ru"
translationOf: "2026/08/visual-studio-18-8-built-in-dotnet-agent-skills-off-by-default"
translatedBy: "claude"
translationDate: 2026-08-02
---

Visual Studio 2026 версии 18.8 без шума изменил то, где живёт экспертиза агента. Skills, написанные командами .NET и Azure, теперь поставляются вместе с IDE, а не являются тем, что нужно самому найти, установить и подключить. 2026-07-28 Марк Дауни свёл изменение в статью [Visual Studio July Update, Meet the New Agent](https://devblogs.microsoft.com/visualstudio/visual-studio-july-update-meet-the-new-agent-powered-by-copilot-sdk/), а GitHub зафиксировал его в [changelog Copilot](https://github.blog/changelog/2026-07-30-github-copilot-in-visual-studio-july-update/) 2026-07-30.

Skills появляются в категории **Built-in** в выборе инструментов, и только тогда, когда установлена соответствующая рабочая нагрузка. Если вы никогда не устанавливали рабочую нагрузку Azure, skills для Azure вы не увидите. И каждый из них выключен, пока вы его не включите.

## Два skills для .NET, которые стоит включить первыми

`dotnet-webapi` направляет создание и изменение HTTP-конечных точек ASP.NET Core: правильные коды состояния, метаданные OpenAPI на самой конечной точке, а не приделанные позже, и обработка ошибок, которая не сводит всё к 500.

`analyzing-dotnet-performance` пригодится на существующей кодовой базе. Он проверяет около 50 антипаттернов производительности в областях асинхронности, памяти, строк, коллекций, LINQ, регулярных выражений, сериализации и ввода-вывода и раскладывает находки по уровням серьёзности, а не выдаёт плоский список. Ищет он именно то, что проходит ревью кода, потому что читается нормально:

```csharp
// Materializes every matching row just to ask a yes/no question
if (db.Orders.Where(o => o.CustomerId == id).ToList().Count > 0)
{
    // ...
}

// One EXISTS query, no allocation, no blocking
if (await db.Orders.AnyAsync(o => o.CustomerId == id, ct))
{
    // ...
}
```

Со стороны Azure поставляется цепочка развёртывания из трёх шагов (`azure-prepare` генерирует Bicep или Terraform, а также `azure.yaml` и настройку управляемого удостоверения, `azure-validate` выполняет предварительные проверки, `azure-deploy` проводит развёртывание), плюс `azure-kusto` для KQL к Azure Data Explorer и `microsoft-foundry` для развёртывания и оценки моделей.

## Выключено по умолчанию: это решение про контекст, а не про робость

Включить всё и предоставить агенту разбираться было бы просто. Поставить их выключенными: решение лучше, и причина в бюджете контекста. Каждый включённый skill представляет собой инструкции, которые конкурируют за то же окно, что и ваш реальный код. Тому, кто пишет веб-API на .NET и поставил рабочую нагрузку Azure ради одной задачи развёртывания, не нужны шесть skills для Azure, сужающих каждый ответ до конца года.

Это та же дисциплина, что требуется плагину `dotnet-test`, [тому самому за агентом модульных тестов прошлой недели](/ru/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/): загружайте skill под задачу, а не каталог.

## Для всего этого Visual Studio не нужен

Skills для .NET открыты в [dotnet/skills](https://github.com/dotnet/skills), а для Azure в [microsoft/azure-skills](https://github.com/microsoft/azure-skills). Те же плагины ставятся в Copilot CLI, Claude Code, VS Code и Cursor:

```bash
/plugin marketplace add dotnet/skills
```

Что 18.8 действительно даёт, так это обнаруживаемость. Никто не нашёл бы `analyzing-dotnet-performance`, просматривая репозиторий. Найти его в списке рядом с уже установленной рабочей нагрузкой это совсем другое дело, и тогда выключатель по умолчанию остаётся единственным трением, которое стоит сохранить.

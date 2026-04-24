---
title: "GitHub Copilot Modernization: отчёт assessment и есть настоящий продукт"
description: "GitHub Copilot Modernization подаётся как цикл Assess, Plan, Execute для миграции legacy .NET-приложений. Фаза assessment - где живёт ценность: inventory-отчёт, категоризированные blockers, и file-level remediation guidance, которую можно diffать как код."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
  - "dotnet-10"
lang: "ru"
translationOf: "2026/04/github-copilot-modernization-assessment-dotnet"
translatedBy: "claude"
translationDate: 2026-04-24
---

Пост Microsoft от 7 апреля ["Your Migration's Source of Truth: The Modernization Assessment"](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) описывает [GitHub Copilot Modernization](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) как "Assess, Plan, Execute" цикл для вытягивания legacy .NET Framework и Java рабочих нагрузок вперёд. Если запомните только одно из поста, пусть это будет: assessment - не блестящий dashboard, это отчёт, записываемый в `.github/modernize/assessment/`, который вы коммитите рядом со своим кодом.

## Зачем класть отчёт в репозиторий

Миграции умирают, когда план живёт в Word-документе, который никто не обновляет. Записывая assessment в репозиторий, каждое изменение становится ревьюируемым через pull request, а история ветки показывает, как "список blockers" сокращался со временем. Это также значит, что assessment можно регенерировать в CI и сравнивать diff, так вы заметите, когда кто-то заново вводит deprecated API.

Сам отчёт разбивает находки на три корзины:

1. Mandatory: blockers, которые должны быть решены до того, как миграция компилируется или запускается.
2. Potential: изменения поведения, обычно требующие обновления кода, например API, удалённые между .NET Framework и .NET 10.
3. Optional: эргономические улучшения вроде перехода на `System.Text.Json` или `HttpClientFactory`.

Каждая находка привязана к файлу и диапазону строк, так что reviewer может открыть отчёт, кликнуть до кода и понять remediation без повторного запуска инструмента.

## Запуск assessment

Assessment можно запустить из расширения VS Code, но интересная поверхность - CLI, потому что она вписывается в CI:

```bash
# Run a recommended assessment against a single repo
modernize assess --path ./src/LegacyApi --target dotnet10

# Multi-repo batch mode for a portfolio
modernize assess --multi-repo ./repos --target dotnet10 --coverage deep
```

Флаг `--target` - место, где живут preset сценарии: `dotnet10` триггерит upgrade-путь .NET Framework → .NET 10, а `java-openjdk21` покрывает Java-эквивалент. Флаг `--coverage` меняет время на глубину, и deep coverage - тот, что действительно инспектирует транзитивные NuGet-ссылки.

## Обращение с assessment как с кодом

Поскольку отчёт - набор Markdown и JSON файлов, его можно линтить. Вот небольшой скрипт, роняющий CI, когда assessment получает новые Mandatory-issues:

```csharp
using System.Text.Json;

var report = JsonSerializer.Deserialize<AssessmentReport>(
    File.ReadAllText(".github/modernize/assessment/summary.json"));

var mandatory = report.Issues.Count(i => i.Severity == "Mandatory");
Console.WriteLine($"Mandatory issues: {mandatory}");

if (mandatory > report.Baseline.Mandatory)
{
    Console.Error.WriteLine("New Mandatory blockers introduced since baseline.");
    Environment.Exit(1);
}

record AssessmentReport(Baseline Baseline, Issue[] Issues);
record Baseline(int Mandatory);
record Issue(string Severity, string File, int Line, string Rule);
```

Это превращает one-off assessment в храповик: раз blocker решён, он не может вернуться молча.

## Куда это вписывается рядом с ASP.NET Core 2.3

В том же пакете постов от 7 апреля было [уведомление о end of support для ASP.NET Core 2.3](https://devblogs.microsoft.com/dotnet/aspnet-core-2-3-end-of-support/), ставящее 13 апреля 2027 как жёсткую дату. Copilot Modernization - ответ Microsoft для shops, которые всё ещё имеют ASP.NET Core 2.3 пакеты, едущие на .NET Framework: запустите assessment, закоммитьте его и отработайте Mandatory-список до того, как часы кончатся.

Инструмент не волшебство. Он не перепишет за вас extension `HttpContext` и не решит, контейнеризовать ли через App Service или AKS. Что он делает - даёт вам repo-native, diff-способный inventory работы, что первый честный разговор, который большинство долгоживущих .NET codebases вело за годы.

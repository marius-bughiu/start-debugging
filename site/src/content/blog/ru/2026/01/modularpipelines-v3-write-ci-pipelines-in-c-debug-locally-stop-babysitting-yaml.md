---
title: "ModularPipelines V3: пишите CI-пайплайны на C#, отлаживайте локально и перестаньте нянчить YAML"
description: "ModularPipelines V3 позволяет писать CI-пайплайны на C# вместо YAML. Запускайте их локально через dotnet run, получайте безопасность времени компиляции и отлаживайте с точками останова."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
lang: "ru"
translationOf: "2026/01/modularpipelines-v3-write-ci-pipelines-in-c-debug-locally-stop-babysitting-yaml"
translatedBy: "claude"
translationDate: 2026-04-29
---
На этой неделе мне снова напомнили, что CI не обязан быть слепым циклом push-and-pray: **ModularPipelines V3** активно выпускается (последний тег `v3.0.86` был опубликован 2026-01-18), и он опирается на простую идею: ваш пайплайн - это просто .NET-приложение.

Источник: [ModularPipelines repo](https://github.com/thomhurst/ModularPipelines) и [релиз v3.0.86](https://github.com/thomhurst/ModularPipelines/releases/tag/v3.0.86).

## Часть, которая меняет ваш цикл обратной связи

Если вы выпускаете сервисы на .NET 10, шаги вашего пайплайна уже имеют "форму кода": сборка, тесты, публикация, упаковка, сканирование, развёртывание. Проблема обычно в обёртке: YAML, переменные с типизацией через строки и 5-10-минутный цикл обратной связи только ради опечаток.

ModularPipelines переворачивает это:

-   Пайплайн можно запустить локально через `dotnet run`.
-   Зависимости объявляются на C#, так что движок может распараллеливать.
-   Пайплайн строго типизирован, поэтому рефакторинги и ошибки всплывают как обычные ошибки компиляции.

Вот основной вид прямо из README проекта, очищенный до минимального примера, который можно вставить:

```cs
// Program.cs
await PipelineHostBuilder.Create()
    .AddModule<BuildModule>()
    .AddModule<TestModule>()
    .AddModule<PublishModule>()
    .ExecutePipelineAsync();

public class BuildModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Build(new DotNetBuildOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}

[DependsOn<BuildModule>]
public class TestModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Test(new DotNetTestOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}
```

Это скучно в самом хорошем смысле: это обычный C#. Точки останова работают. Ваша IDE помогает. "Переименовать модуль" - это не страшный глобальный поиск.

## Обёртки инструментов, идущие в ногу с экосистемой

Релиз `v3.0.86` намеренно "маленький": он обновляет опции CLI для таких инструментов, как `pnpm`, `grype` и `vault`. Это именно тот тип сопровождения, который вы хотите переложить на фреймворк пайплайнов. Когда CLI добавляет или меняет флаг, вы хотите, чтобы двигалась типизированная обёртка, а не гнили десятки YAML-фрагментов.

## Почему мне нравится модульная модель для реальных репозиториев

В крупных кодовых базах скрытая цена YAML - не синтаксис. Это управление изменениями:

-   Разделите логику пайплайна по областям (build, test, publish, scan) вместо одного мегафайла.
-   Держите поток данных явным. Модули могут возвращать строго типизированные результаты, которые потребляют следующие модули.
-   Дайте анализаторам ловить ошибки зависимостей рано. Если вы вызываете другой модуль, забыть объявить `[DependsOn]` не должно быть сюрпризом во время выполнения.

Если вы уже живёте в .NET 9 или .NET 10, относиться к пайплайну как к небольшому C#-приложению - это не "переинженерия". Это более короткий цикл обратной связи и меньше сюрпризов в продакшене.

Если хотите углубиться, начните с "Quick Start" и документации проекта: [Full Documentation](https://thomhurst.github.io/ModularPipelines).

---
title: "System.CommandLine v2, но с уже готовой обвязкой: `Albatross.CommandLine` v8"
description: "Albatross.CommandLine v8 строится поверх System.CommandLine v2 и добавляет генератор исходного кода, интеграцию с DI и слой хостинга, чтобы убрать шаблонный код CLI в приложениях .NET 9 и .NET 10."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "ru"
translationOf: "2026/01/system-commandline-v2-but-with-the-wiring-done-for-you-albatross-commandline-v8"
translatedBy: "claude"
translationDate: 2026-04-30
---
System.CommandLine v2 вышел с гораздо более чистым фокусом: сначала разбор, упрощённый конвейер выполнения, меньше "магических" поведений. Это здорово, но большинство реальных CLI всё равно обрастают повторяющейся обвязкой: настройка DI, привязка обработчиков, общие параметры, отмена и хостинг.

`Albatross.CommandLine` v8 — это свежий взгляд именно на этот разрыв. Он строится поверх System.CommandLine v2 и добавляет генератор исходного кода и слой хостинга, чтобы вы могли определять команды декларативно и держать связующий код в стороне.

## Ценностное предложение: меньше подвижных частей, больше структуры

Тезис автора конкретен:

-   Минимум шаблонного кода: определяйте команды атрибутами, обвязка генерируется
-   Композиция через DI: сервисы для каждой команды, можно внедрять что угодно
-   Обработка async и завершения: CancellationToken и Ctrl+C из коробки
-   Остаётся настраиваемым: при необходимости можно спуститься к объектам System.CommandLine

Эта комбинация — золотая середина для CLI-приложений на .NET 9 и .NET 10, которым нужна "скучная" инфраструктура без полноценной зависимости от фреймворка.

## Минимальный хост, который остаётся читаемым

Вот форма (упрощено по анонсу):

```cs
// Program.cs (.NET 9 or .NET 10)
using Albatross.CommandLine;
using Microsoft.Extensions.DependencyInjection;
using System.CommandLine.Parsing;

await using var host = new CommandHost("Sample CLI")
    .RegisterServices(RegisterServices)
    .AddCommands() // generated
    .Parse(args)
    .Build();

return await host.InvokeAsync();

static void RegisterServices(ParseResult result, IServiceCollection services)
{
    services.RegisterCommands(); // generated registrations

    // Your app services
    services.AddSingleton<ITimeProvider, SystemTimeProvider>();
}

public interface ITimeProvider { DateTimeOffset Now { get; } }
public sealed class SystemTimeProvider : ITimeProvider { public DateTimeOffset Now => DateTimeOffset.UtcNow; }
```

Важна не часть "смотрите, хост". Важно то, что хост становится предсказуемой точкой входа, в которой можно тестировать слой обработчиков и держать определения команд отдельно от привязки сервисов.

## Где это подходит, а где нет

Это хороший вариант, если:

-   У вас больше 3-5 команд, и общие параметры начинают расползаться
-   Вы хотите DI в своём CLI, но не хотите вручную привязывать обработчики для каждой команды
-   Вам важно корректное завершение, потому что ваш CLI делает реальную работу (сеть, файловая система, длинный ввод-вывод)

Скорее всего, оно того не стоит, если:

-   Вы делаете утилиту с одной командой
-   Вам нужно экзотическое поведение разбора, и вы готовы жить во внутренностях System.CommandLine

Если хотите быстро оценить, вот лучшие точки старта:

-   Документация: [https://rushuiguan.github.io/commandline/](https://rushuiguan.github.io/commandline/)
-   Исходники: [https://github.com/rushuiguan/commandline](https://github.com/rushuiguan/commandline)
-   Анонс на Reddit: [https://www.reddit.com/r/dotnet/comments/1q800bs/updated\_albatrosscommandline\_library\_for/](https://www.reddit.com/r/dotnet/comments/1q800bs/updated_albatrosscommandline_library_for/)

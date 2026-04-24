---
title: "Hot Reload auto-restart в Visual Studio 2026: rude edits перестают убивать debug-сессию"
description: "Visual Studio 2026 добавляет HotReloadAutoRestart, project-level opt-in, перезапускающий приложение, когда rude edit иначе завершил бы debug-сессию. Особенно полезно для проектов Razor и Aspire."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "visual-studio"
  - "hot-reload"
  - "razor"
lang: "ru"
translationOf: "2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits"
translatedBy: "claude"
translationDate: 2026-04-24
---

Одна из тихих побед в мартовском апдейте Visual Studio 2026 - [Hot Reload auto-restart для rude edits](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload). "Rude edit" - это изменение, которое движок EnC Roslyn не может применить in-process: изменение сигнатуры метода, переименование класса, смена базового типа. До сих пор единственным честным ответом было остановить debugger, пересобрать и прикрепиться снова. В проектах .NET 10 с Visual Studio 2026 можно opt-in в куда лучший default: IDE перезапускает процесс за вас и удерживает debug-сессию живой.

## Opt-in одной property

Фича гейтируется на project-level MSBuild property, что значит, её можно включать выборочно для проектов, где перезапуск процесса дешёв - ASP.NET Core API, приложения Blazor Server, оркестрации Aspire - и оставлять выключенной для тяжёлых desktop-хостов.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

Можно также поднять это в `Directory.Build.props`, чтобы целый solution включил opt-in разом:

```xml
<Project>
  <PropertyGroup>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

Когда property установлена, rude edits запускают направленный rebuild изменённого проекта и его зависимых, стартует новый процесс, а debugger переприкрепляется. Не перезапущенные проекты продолжают работать, что сильно важно в Aspire: ваш контейнер Postgres и worker service не должны отскакивать только из-за того, что вы переименовали метод контроллера.

## Razor наконец ощущается быстрым

Вторая половина апдейта - компилятор Razor. В прошлых версиях билд Razor жил в отдельном процессе, и Hot Reload на файле `.razor` мог занять десятки секунд, пока компилятор стартовал на холодную. В Visual Studio 2026 компилятор Razor co-hosted внутри процесса Roslyn, так что редактирование `.razor` во время Hot Reload эффективно бесплатно.

Маленький пример, показывающий, что теперь переживает Hot Reload без полного рестарта:

```razor
@page "/counter"
@rendermode InteractiveServer

<h1>Counter: @count</h1>
<button @onclick="Increment">+1</button>

@code {
    private int count;

    private void Increment() => count++;
}
```

Смена текста `<h1>`, подправка лямбды, добавление второй кнопки - всё продолжает работать с Hot Reload. Если теперь рефакторить `Increment` в `async Task IncrementAsync()` (rude edit, потому что сигнатура изменилась), auto-restart включается, процесс отскакивает, и вы обратно на `/counter` без прикосновения к toolbar debugger.

## На что обратить внимание

Auto-restart не сохраняет in-process state. Если ваш debug-цикл зависит от тёплого кэша, аутентифицированной сессии или SignalR-подключения, вы потеряете это при рестарте. Два практических митигирования:

1. Перенесите дорогой warmup в `IHostedService` реализации, дешёвые к повторному прогону, или подкрепите общим кэшем.
2. Используйте [кастомный Hot Reload handler](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) через `MetadataUpdateHandlerAttribute`, чтобы очищать и пересеивать кэши при применении update.

```csharp
[assembly: MetadataUpdateHandler(typeof(MyApp.CacheResetHandler))]

namespace MyApp;

internal static class CacheResetHandler
{
    public static void UpdateApplication(Type[]? updatedTypes)
    {
        AppCache.Clear();
        AppCache.Warm();
    }
}
```

Для команд Blazor и Aspire комбинированный эффект - самый большой quality-of-life скачок Hot Reload с момента запуска фичи. Одна MSBuild property, один co-hosted компилятор, и ритуал "остановить, пересобрать, переприкрепиться", съедавший пять минут дюжину раз в день, наконец уходит.

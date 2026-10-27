---
title: "Polly 8.8.1: circuit breaker больше не удерживает значения AsyncLocal первого вызывающего"
description: "Polly.Core 8.8.1 запускает фоновый цикл circuit breaker под ExecutionContext.SuppressFlow, поэтому долгоживущий пайплайн больше не удерживает значения AsyncLocal того, кто его построил. Воспроизведение в 15 строк показывает утечку в 8.8.0 и исправление в 8.8.1."
pubDate: 2026-10-27
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "memory-leaks"
lang: "ru"
translationOf: "2026/10/polly-8-8-1-circuit-breaker-no-longer-keeps-the-first-callers-asynclocal-values-alive"
translatedBy: "claude"
translationDate: 2026-10-27
---

[Polly 8.8.1](https://github.com/App-vNext/Polly/releases/tag/8.8.1) вышел 2026-10-26, и главное исправление в нём касается утечки памяти, которую легко получить, не подозревая об этом. Каждая стратегия circuit breaker, построенная с Polly.Core 8.8.0 или более ранней версией, удерживала `ExecutionContext` построившего её кода в течение всего времени жизни пайплайна. Это включает каждое значение `AsyncLocal<T>`, установленное в тот момент.

## Почему circuit breaker захватывал ваш контекст

Circuit breaker использует внутренний `ScheduledTaskExecutor`, чтобы выполнять свои колбэки смены состояния (`OnOpened`, `OnClosed`, `OnHalfOpened`) вне горячего пути. Его конструктор запускал цикл обработки через `Task.Run(StartProcessingAsync)`. `Task.Run` по умолчанию передаёт текущий `ExecutionContext`, а затем цикл ожидает на `SemaphoreSlim`, пока пайплайн не будет освобождён.

Получается, что тот, кто случайно инициировал построение, отдавал своё окружающее состояние задаче, которая никогда не завершается. Для пайплайна в `ResiliencePipelineRegistry` или для того, который `Microsoft.Extensions.Http.Resilience` строит для именованного `HttpClient`, "время жизни пайплайна" означает время жизни приложения. [Issue #3275](https://github.com/App-vNext/Polly/issues/3275) описывает худший случай: в приложении Blazor Server пайплайн строит circuit первого пользователя, accessor на основе `AsyncLocal` несёт сервисы этого circuit, и после ухода пользователя circuit так и не собирается сборщиком мусора.

## Воспроизведение в файловом приложении

Это запускается как есть командой `dotnet run repro.cs` на .NET 10 SDK. Для сравнения поменяйте версию пакета:

```csharp
#:package Polly.Core@8.8.0
using System.Runtime.CompilerServices;
using Polly;

AsyncLocal<object?> current = new();

var (pipeline, value) = Build();
for (int i = 0; i < 3; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
GC.KeepAlive(pipeline);
Console.WriteLine($"alive: {value.IsAlive}");

[MethodImpl(MethodImplOptions.NoInlining)]
(ResiliencePipeline, WeakReference) Build()
{
    object payload = new byte[1024];
    current.Value = payload; // whatever the first caller's flow carries
    var p = new ResiliencePipelineBuilder().AddCircuitBreaker(new()).Build();
    current.Value = null;
    return (p, new WeakReference(payload));
}
```

На моей машине (SDK 10.0.302) `Polly.Core@8.8.0` выводит `alive: True`, а `Polly.Core@8.8.1` выводит `alive: False`. Очистка `AsyncLocal` после построения в 8.8.0 не помогает, потому что фоновая задача хранит снимок контекста, сделанный в момент её запуска, а не живое представление.

## Исправление

[PR #3284](https://github.com/App-vNext/Polly/pull/3284) состоит из трёх строк:

```csharp
public ScheduledTaskExecutor()
{
    using (ExecutionContext.SuppressFlow())
    {
        ProcessingTask = Task.Run(StartProcessingAsync);
    }
}
```

Есть одно изменение поведения, о котором стоит знать: ваши колбэки смены состояния больше не видят значения `AsyncLocal` того, кто построил пайплайн. Значения запроса, который на самом деле сработал breaker, они и раньше надёжно не видели, только значения кода, построившего пайплайн. Если вы на это полагались, например читали `Activity.Current` или accessor тенанта внутри `OnOpened`, передавайте нужное через `ResilienceContext` или аргументы колбэка.

## Что делать

Обновите `Polly.Core` (и `Polly.Extensions`, если ссылаетесь на него напрямую) до 8.8.1. `Microsoft.Extensions.Http.Resilience` подтягивает Polly транзитивно, поэтому добавьте явную ссылку, если ваш lock-файл всё ещё на 8.8.0:

```xml
<PackageReference Include="Polly.Core" Version="8.8.1" />
```

Если обновиться пока нельзя, обходной путь из issue: заранее строить пайплайны при старте внутри `ExecutionContext.SuppressFlow()`, до того как какой-либо запрос сможет стать тем, кто их строит.

Тот же релиз также ускоряет выполнение пайплайнов ([#3287](https://github.com/App-vNext/Polly/pull/3287)) и закрывает связанную дыру в очистке реестра ([#3288](https://github.com/App-vNext/Polly/pull/3288)): когда два вызывающих одновременно инициализировали один и тот же ключ, проигравший пайплайн отбрасывался, но сохранял свои ресурсы и регистрации перезагрузки. Теперь он проходит тот же путь асинхронного освобождения, что и перезагрузки, и это важно, если вы используете [`EnableReloadsWithMonitor` из Polly 8.8](/ru/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/).

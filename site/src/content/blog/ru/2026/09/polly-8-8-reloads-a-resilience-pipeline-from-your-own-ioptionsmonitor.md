---
title: "Polly 8.8 перезагружает resilience-конвейер из вашего собственного IOptionsMonitor"
description: "В Polly 8.8.0 появился EnableReloadsWithMonitor, и resilience-конвейер теперь может перезагружаться на лету из feature flag или монитора удалённой конфигурации, не зарегистрированного в DI. Тестовый прогон показывает пересборку, а заодно одну ловушку: context.GetOptions по-прежнему читает монитор из DI и возвращает значения по умолчанию."
pubDate: 2026-09-18
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "configuration"
lang: "ru"
translationOf: "2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor"
translatedBy: "claude"
translationDate: 2026-09-18
---

[Polly 8.8.0](https://github.com/App-vNext/Polly/releases/tag/8.8.0) вышел 2026-09-14, и его главное изменение невелико, но закрывает реальный пробел в `Polly.Extensions`. До сих пор единственным способом перезагружать на лету resilience-конвейер, зарегистрированный в DI, был `context.EnableReloads<TOptions>()`, который получает `IOptionsMonitor<TOptions>` из контейнера. Если число повторов или тайм-ауты берутся из SDK для feature flag, клиента удалённой конфигурации или монитора, написанного вами самостоятельно, его приходилось сначала регистрировать в DI либо отказываться от перезагрузки.

## Новая перегрузка

[PR #3140](https://github.com/App-vNext/Polly/pull/3140) добавляет `EnableReloadsWithMonitor<TOptions>(IOptionsMonitor<TOptions> monitor, string? name = null)` в `AddResiliencePipelineContext<TKey>`. Старый `EnableReloads<TOptions>()` теперь состоит из одной строки: он получает монитор из DI и вызывает новый метод. Оба пути ведут в одно место: реестр подписывается на `monitor.OnChange` и пересобирает конвейер, когда событие срабатывает.

Вот минимальный вариант, где самописный монитор изображает сервис флагов:

```csharp
var flags = new FlagMonitor<RetryFlags>(new RetryFlags { MaxRetries = 1 });

services.AddResiliencePipeline("orders", (builder, context) =>
{
    context.EnableReloadsWithMonitor(flags);

    var opts = flags.CurrentValue;
    builder.AddRetry(new() { MaxRetryAttempts = opts.MaxRetries, Delay = TimeSpan.Zero });
});

public sealed class FlagMonitor<T>(T initial) : IOptionsMonitor<T>
{
    private readonly List<Action<T, string?>> _listeners = [];
    public T CurrentValue { get; private set; } = initial;
    public T Get(string? name) => CurrentValue;

    public IDisposable OnChange(Action<T, string?> listener)
    {
        _listeners.Add(listener);
        return new Unsub(() => _listeners.Remove(listener));
    }

    public void Set(T value)
    {
        CurrentValue = value;
        foreach (var l in _listeners.ToArray()) l(value, Options.DefaultName);
    }

    private sealed class Unsub(Action a) : IDisposable { public void Dispose() => a(); }
}
```

Я запустил это как файловое приложение на SDK 10.0.302 с `Polly.Extensions` 8.8.0. Конвейер всегда выбрасывает исключение, поэтому число попыток показывает действующую настройку повторов:

```text
building pipeline with MaxRetries=1
attempts: 2
building pipeline with MaxRetries=4
attempts after change: 5
same instance: True
```

После `flags.Set(...)` callback конфигурации выполнился снова, и следующий вызов сделал пять попыток. `ResiliencePipeline`, полученный из `GetPipeline("orders")`, остаётся тем же объектом. Polly подменяет внутренний конвейер за ним, поэтому код, сохранивший конвейер в поле, получает изменение без повторного запроса. На 8.7.0 тот же файл падает с CS1061, потому что такого метода там нет.

## Ловушка с GetOptions

В callback конфигурации есть и `context.GetOptions<TOptions>()`, и его соблазнительно использовать рядом с новым методом. Не стоит. `GetOptions` по-прежнему получает `IOptionsMonitor<TOptions>` из контейнера, а `AddResiliencePipeline` регистрирует инфраструктуру options, поэтому исключения не будет. Вы получите экземпляр, созданный конструктором по умолчанию. В тестовом прогоне `context.GetOptions<RetryFlags>().MaxRetries` вернул `0` при обеих сборках, тогда как собственный монитор сообщал `1`, а затем `4`. Конвейер, построенный на этом значении, молча перестал бы выполнять повторы.

Если вы передаёте собственный монитор, читайте значения внутри callback из того же монитора (`flags.CurrentValue` или `flags.Get(name)`).

## Что ещё есть в 8.8.0

[PR #3220](https://github.com/App-vNext/Polly/pull/3220) исправляет ошибку в Simmy: пустой `FaultGenerator` или генератор, чьи веса в сумме дают ноль, выбрасывал `InvalidOperationException: Nullable object must have a value` вместо того, чтобы ничего не внедрять. Теперь генератор возвращает `null`, и chaos-стратегия пропускает вызов. В релиз также вошли работы по подготовке к .NET 11 и переход тестового набора на xunit v3.

Если вы ещё решаете, нужны ли вам вообще конвейеры Polly или обработчики `Microsoft.Extensions.Http.Resilience`, в статье [Polly и resilience-обработчики в .NET 11](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) разобраны компромиссы.

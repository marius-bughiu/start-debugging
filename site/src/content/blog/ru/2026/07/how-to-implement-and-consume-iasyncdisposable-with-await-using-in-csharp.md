---
title: "Как реализовать и использовать IAsyncDisposable с await using в C#"
description: "Полное руководство по IAsyncDisposable в C#: когда применять await using, как правильно писать DisposeAsync и DisposeAsyncCore, и какие детали со стекированием и ConfigureAwait приводят к утечке ресурсов."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "idisposable"
lang: "ru"
translationOf: "2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Когда тип удерживает ресурс, который можно освободить только асинхронно (сетевой поток, который должен сброситься, транзакция базы данных, которую нужно зафиксировать или откатить, писатель канала, который должен опустошиться), `IDisposable` -- неподходящий контракт. Его метод `Dispose()` синхронный, поэтому единственный способ выполнить из него асинхронную очистку -- заблокироваться на `Task`, что рискует взаимной блокировкой и истощением пула потоков. C# 8.0 (вышедший вместе с .NET Core 3.0) добавил `IAsyncDisposable` и инструкцию `await using` именно для этого случая. Эта статья охватывает обе стороны: как использовать async-disposable тип с `await using` и как правильно реализовать `DisposeAsync`, включая паттерн `DisposeAsyncCore` и две детали (стекирование и `ConfigureAwait`), которые незаметно приводят к утечке ресурсов. Все примеры нацелены на .NET 11 и C# 14, но API и семантика не менялись с C# 8.0.

## Почему синхронного Dispose недостаточно

`IDisposable.Dispose()` возвращает `void`. Если вашей очистке нужен `await` (сбросить буфер в сокет, отправить финальный кадр, зафиксировать транзакцию), у вас есть три плохих варианта внутри синхронного `Dispose`: заблокироваться через `.GetAwaiter().GetResult()`, заблокироваться через `.Wait()` или запустить и забыть, надеясь, что оно завершится. Первые два могут привести к взаимной блокировке в контекстах с однопоточным контекстом синхронизации и будут занимать поток из пула на всё время операции ввода-вывода; третий теряет ошибки и может освободить нижележащий дескриптор до того, как асинхронная работа завершится.

`IAsyncDisposable` исправляет это, делая саму очистку ожидаемой:

```csharp
// System namespace, available since .NET Core 3.0 / C# 8.0
public interface IAsyncDisposable
{
    ValueTask DisposeAsync();
}
```

Обратите внимание, что тип возвращаемого значения -- `ValueTask`, а не `Task`. Освобождение часто завершается синхронно (нечего сбрасывать), и `ValueTask` избегает выделения объекта `Task` на этом распространённом пути. Вы почти никогда сами не делаете `await` на голом вызове `DisposeAsync()`; компилятор делает это за вас через `await using`.

## Использование async-disposable с await using

Сторона потребителя -- это часть, которую вы будете писать чаще всего, потому что фреймворк уже реализует `IAsyncDisposable` в тех типах, которые вам важны: `Stream`, `FileStream`, `DbConnection`, `DbTransaction`, `Utf8JsonWriter`, обёртки `ChannelWriter<T>`, `ServiceProvider` и другие.

Есть две формы. Инструкция `await using` ограничивает очистку явным блоком:

```csharp
// .NET 11, C# 14
await using (var stream = new FileStream("data.bin", FileMode.Open))
{
    await stream.ReadAsync(buffer);
} // DisposeAsync() is awaited here, at the closing brace
```

Объявление `await using` ограничивает очистку концом содержащего блока, без дополнительной вложенности:

```csharp
// .NET 11, C# 14
static async Task ProcessAsync()
{
    await using var stream = new FileStream("data.bin", FileMode.Open);

    await stream.ReadAsync(buffer);

    // DisposeAsync() is awaited when ProcessAsync's body exits,
    // whether by return or by an exception.
}
```

Обе формы требуют, чтобы содержащий метод был `async`, потому что `await using` вставляет `await` в точке освобождения. Если вы напишете `await using` в не-async методе, вы получите ошибку компиляции, а если случайно опустите `await` и напишете обычный `using` на `IAsyncDisposable`, компилятор вызовет синхронный `Dispose()`, если тип также реализует `IDisposable`, или откажется компилироваться, если он реализует только `IAsyncDisposable`. Этот тихий откат к синхронному освобождению -- реальный источник ошибок: всегда используйте `await using`, когда тип является async-disposable.

Распространённая идиома, которую вы увидите в стеках EF Core и ADO.NET, объединяет два `await` в одной строке: один для фабричного вызова, а другой скрытый в освобождении:

```csharp
// .NET 11, C# 14 -- EF Core 11
await using var transaction = await context.Database.BeginTransactionAsync(token);

await context.SaveChangesAsync(token);
await transaction.CommitAsync(token);
// If CommitAsync is not reached (exception), DisposeAsync rolls back.
```

Первый `await` разворачивает `Task<IDbContextTransaction>` из `BeginTransactionAsync`; `await using` устраивает так, чтобы `DisposeAsync` был ожидан при выходе из блока. Если исключение пропускает `CommitAsync`, `DisposeAsync` транзакции выполнит откат за вас.

## Реализация IAsyncDisposable, когда класс sealed

Если ваш тип `sealed` (или вы уверены, что от него никогда не будут наследоваться), реализация короткая. Просто освободите ресурсы в `DisposeAsync`:

```csharp
// .NET 11, C# 14
public sealed class MetricsFlusher : IAsyncDisposable
{
    private readonly Channel<Metric> _channel = Channel.CreateUnbounded<Metric>();
    private readonly HttpClient _http;

    public MetricsFlusher(HttpClient http) => _http = http;

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.Complete();

        // Drain and ship whatever is buffered before we go away.
        await foreach (var metric in _channel.Reader.ReadAllAsync())
        {
            await _http.PostAsJsonAsync("/metrics", metric);
        }
    }
}
```

Поскольку класс `sealed`, нет производного типа, которому нужно передавать очистку по цепочке, поэтому вам не нужно разделение `DisposeAsyncCore`, описанное далее, и вам не нужен `GC.SuppressFinalize`, если только класс также не объявляет финализатор (sealed класс, который владеет только управляемыми асинхронными ресурсами, редко его имеет).

## Реализация полного паттерна асинхронного освобождения для базового класса

В тот момент, когда ваш класс *не* sealed, рекомендация Microsoft меняется. Любой не-sealed класс -- это потенциальный базовый класс, а производному классу нужна точка подключения, чтобы добавить собственную асинхронную очистку и скомпоновать её с очисткой базового класса. Эта точка подключения -- метод `protected virtual ValueTask DisposeAsyncCore()`. `DisposeAsync` становится шаблонным кодом, который вызывает `DisposeAsyncCore`, подавляет финализацию и возвращается:

```csharp
// .NET 11, C# 14
public class ExampleAsyncDisposable : IAsyncDisposable
{
    private IAsyncDisposable? _inner = new SomeAsyncResource();

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_inner is not null)
        {
            await _inner.DisposeAsync().ConfigureAwait(false);
        }
        _inner = null;
    }
}
```

Производный класс переопределяет `DisposeAsyncCore`, очищает собственные ресурсы и вызывает по цепочке `base.DisposeAsyncCore()`. Он никогда не трогает `DisposeAsync`, поэтому вызов `GC.SuppressFinalize(this)` выполняется ровно один раз, на самом производном уровне. Это зеркалит синхронный паттерн `Dispose()` / `protected virtual void Dispose(bool)`, только с типами возврата `ValueTask` и без параметра `bool disposing` (в чисто асинхронном случае нет пути финализатора, который нужно различать).

## Поддержка и IDisposable, и IAsyncDisposable

Часто реализуют оба интерфейса, чтобы и вызывающие с синхронным `using`, и вызывающие с `await using` получали корректную очистку. Критическая деталь: если вы реализуете только `IAsyncDisposable`, а вызывающий обернёт ваш объект в обычный `using` (или передаст его контейнеру, который знает только `IDisposable`), ваш `DisposeAsync` никогда не выполнится, и вы допустите утечку ресурса. Microsoft явно указывает на это как на предостережение.

Двойной паттерн направляет обе точки входа через общую логику и использует `Dispose(false)` из асинхронного пути, чтобы управляемые ресурсы не освобождались дважды:

```csharp
// .NET 11, C# 14
public class DualDisposable : IDisposable, IAsyncDisposable
{
    private Stream? _managed = new MemoryStream();
    private IAsyncDisposable? _asyncOnly = new SomeAsyncResource();

    public void Dispose()
    {
        Dispose(disposing: true);
        GC.SuppressFinalize(this);
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        Dispose(disposing: false); // false: async path already handled managed async resources
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (disposing)
        {
            _managed?.Dispose();
            _managed = null;

            if (_asyncOnly is IDisposable d)
            {
                d.Dispose();
                _asyncOnly = null;
            }
        }
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_asyncOnly is not null)
        {
            await _asyncOnly.DisposeAsync().ConfigureAwait(false);
        }

        if (_managed is IAsyncDisposable ad)
        {
            await ad.DisposeAsync().ConfigureAwait(false);
        }
        else
        {
            _managed?.Dispose();
        }

        _asyncOnly = null;
        _managed = null;
    }
}
```

Путь `DisposeAsync` передаёт `false` в `Dispose(bool)`, потому что `DisposeAsyncCore` уже освободил управляемые ресурсы асинхронно; передача `true` попыталась бы освободить их во второй раз. Это сохраняет оба пути функционально эквивалентными без двойного освобождения.

## Деталь со стекированием, которая пропускает DisposeAsync

Эта деталь бьёт по тем, кто пытается писать аккуратно. Вы не можете "стекировать" инструкции `await using` так, как можно стекировать синхронные инструкции `using`, потому что если конструктор после первого выбросит исключение, объекты, созданные ранее, никогда не будут освобождены:

```csharp
// .NET 11, C# 14 -- DO NOT DO THIS
var one = new ExampleAsyncDisposable();
var two = new AnotherAsyncDisposable(); // if this constructor throws...

await using (one.ConfigureAwait(false))
await using (two.ConfigureAwait(false))
{
    // ...neither one nor two has DisposeAsync called.
}
```

Проблема в том, что объекты конструируются *до* входа в блоки `await using`, поэтому исключение между конструированием и блоком оставляет их неосвобождёнными. Решение -- конструировать и ограничивать область видимости на одном шаге. Любая из этих трёх форм безопасна:

```csharp
// .NET 11, C# 14 -- nested blocks
var one = new ExampleAsyncDisposable();
await using (one.ConfigureAwait(false))
{
    var two = new AnotherAsyncDisposable();
    await using (two.ConfigureAwait(false))
    {
        // two is disposed first, then one
    }
}

// .NET 11, C# 14 -- sequential declarations (cleanest)
await using var a = new ExampleAsyncDisposable();
await using var b = new AnotherAsyncDisposable();
// b is disposed before a at the end of the method
```

Предпочитайте форму объявления. Если конструктор выбросит исключение, сгенерированная компилятором очистка для уже объявленных переменных всё равно выполнится, и вы избежите целого класса ошибок стекирования.

## ConfigureAwait на await using

В коде библиотеки вам часто нужен `ConfigureAwait(false)`, чтобы продолжение освобождения не захватывало исходный контекст синхронизации. Вы не можете просто дописать его к объекту; есть отдельное расширение, `ConfigureAwait(IAsyncDisposable, bool)`, которое возвращает `ConfiguredAsyncDisposable`:

```csharp
// .NET 11, C# 14
await using (stream.ConfigureAwait(false))
{
    await stream.ReadAsync(buffer);
}
```

В коде приложения без контекста синхронизации, который нужно захватывать (ASP.NET Core, консольные приложения, worker-сервисы), вы можете его опустить; там он не имеет эффекта. В библиотеке, которая может быть вызвана из пользовательского интерфейса или устаревшего контекста ASP.NET, добавьте его, следуя тому же рассуждению, которое вы применяете для `ConfigureAwait(false)` в обычных await.

## Где вам вообще не нужно освобождать

Внедрение зависимостей делает это за вас. Когда вы регистрируете сервис в `IServiceCollection`, контейнер отслеживает, реализует ли разрешённый экземпляр `IDisposable` или `IAsyncDisposable`, и освобождает его в конце его области видимости. Scoped-сервис, реализующий `IAsyncDisposable`, получает ожидание своего `DisposeAsync`, когда область видимости запроса завершается, при условии что сама область была создана и освобождена асинхронно (ASP.NET Core делает это). Вы не пишете `await using` на внедрённых сервисах; вы позволяете контейнеру владеть их временем жизни. Ручное освобождение внедрённого сервиса -- это ошибка, которая может освободить его из-под других потребителей.

## Когда прибегать к IAsyncDisposable

Используйте его, когда освобождение действительно должно выполнять ввод-вывод: сбросить буферизованный писатель в сокет или файл, зафиксировать или откатить транзакцию, завершить и опустошить [Channel](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) или корректно закрыть долгоживущее соединение. Не добавляйте его к типу, чья очистка чисто синхронна (освободить дескриптор, очистить поле); обычный `IDisposable` проще и не заставляет каждого вызывающего переходить в async метод. А если ваш тип производит асинхронный поток, сочетайте его с [IAsyncEnumerable&lt;T&gt;](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), а не пытайтесь приладить потоковую передачу к освобождению.

Асинхронное освобождение -- одна из частей более широкой истории асинхронной корректности. Если ваш `DisposeAsync` выполняет реальную работу, проведите через него таймаут с учётом отмены так же, как вы [задали бы таймаут любой асинхронной операции через CancellationTokenSource.CancelAfter](/ru/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/), и убедитесь, что вы [пробрасываете CancellationToken через свои async методы](/ru/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), чтобы очистка могла быть ограничена. Когда очистка подразумевает остановку выполняющейся работы, здесь применима та же дисциплина, которая позволяет вам [отменить долго выполняющуюся Task без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

Правильно примените два правила, и асинхронное освобождение станет скучным в лучшем смысле: используйте `await using` на стороне потребителя, а на стороне реализации разделите `DisposeAsync` и `DisposeAsyncCore` для не-sealed типов, реализуйте также `IDisposable`, если синхронный вызывающий может освободить вас, и никогда не стекируйте блоки `await using`.

## Источники

- [Реализация метода DisposeAsync (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync)
- [Интерфейс IAsyncDisposable (справочник API на MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.iasyncdisposable)
- [Инструкция и объявление using (справочник по языку C#)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/using)
- [Часто задаваемые вопросы о ConfigureAwait (.NET Blog)](https://devblogs.microsoft.com/dotnet/configureawait-faq/)

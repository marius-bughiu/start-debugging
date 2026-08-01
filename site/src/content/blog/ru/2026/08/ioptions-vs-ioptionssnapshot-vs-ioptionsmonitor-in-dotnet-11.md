---
title: "IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> в .NET 11"
description: "По умолчанию используйте IOptions<T>. Берите IOptionsMonitor<T>, когда синглтон должен видеть перезагрузку конфигурации, и IOptionsSnapshot<T> только тогда, когда scoped-потребителю нужно значение, стабильное в пределах одного запроса. Решает время жизни потребителя, а не форма настроек."
pubDate: 2026-08-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-01
---

Внедряйте `IOptions<T>`, если у вас нет конкретной причины поступить иначе. Это синглтон, он привязывает ваш класс настроек ровно один раз на всё время жизни процесса и разрешается дешевле остальных двух. К `IOptionsMonitor<T>` обращайтесь, когда долгоживущий сервис должен наблюдать за изменениями конфигурации без перезапуска, а к `IOptionsSnapshot<T>` только в одном узком случае: scoped- или transient-потребитель, которому нужно значение, стабильное в пределах одного запроса, но допускающее различия между запросами. Решает время жизни того класса, который выполняет внедрение, а не форма внедряемых настроек. Всё, что ниже, ориентировано на .NET 11 (проверено на Preview 6, SDK `11.0.100-preview.6.26359.118`) и C# 14, с `Microsoft.Extensions.Options` 11.0.0. Эти три интерфейса ведут себя так со времён .NET Core 2.0, поэтому всё написанное работает без изменений на .NET 10 GA; по-настоящему новым является только материал о валидации в .NET 11 в конце статьи.

## Матрица возможностей

| Возможность | `IOptions<T>` | `IOptionsSnapshot<T>` | `IOptionsMonitor<T>` |
| --- | --- | --- | --- |
| Конкретная реализация | `UnnamedOptionsManager<T>` | `OptionsManager<T>` | `OptionsMonitor<T>` |
| Время жизни в DI | Singleton | **Scoped** | Singleton |
| Можно внедрить в синглтон | Да | Нет, захваченная зависимость | Да |
| Видит перезагрузку конфигурации | Никогда | Да, в следующей области | Да, немедленно |
| Именованные опции | Нет | Да, `Get(name)` | Да, `Get(name)` |
| Обратные вызовы при изменении | Нет | Нет | Да, `OnChange` |
| Доступ к значению | `.Value` | `.Value`, `.Get(name)` | `.CurrentValue`, `.Get(name)` |
| Как часто работает binder | Один раз на процесс | Один раз на область, на имя | Один раз на изменение, на имя |
| Где кешируется экземпляр | Поле синглтона | `OptionsCache<T>` внутри scoped-менеджера | Синглтон `IOptionsMonitorCache<T>` |

Две строки несут основной вес. Строка времени жизни порождает исключения при старте, а строка "как часто работает binder" порождает неожиданную нагрузку на процессор на горячем пути. Всё остальное следует из этих двух.

Все три регистрируются вызовом `AddOptions()`, который хост делает за вас. Из [OptionsServiceCollectionExtensions](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs):

```csharp
// Microsoft.Extensions.Options 11.0.0 -- what AddOptions() actually registers
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptions<>), typeof(UnnamedOptionsManager<>)));
services.TryAdd(ServiceDescriptor.Scoped(typeof(IOptionsSnapshot<>), typeof(OptionsManager<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitor<>), typeof(OptionsMonitor<>)));
services.TryAdd(ServiceDescriptor.Transient(typeof(IOptionsFactory<>), typeof(OptionsFactory<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitorCache<>), typeof(OptionsCache<>)));
```

Обратите внимание, что `IOptionsFactory<T>` зарегистрирован как transient и делает всю настоящую работу: он по порядку выполняет каждый зарегистрированный `IConfigureOptions<T>`, затем каждый `IPostConfigureOptions<T>`, затем валидацию. Три интерфейса доступа отличаются только тем, насколько агрессивно они кешируют результат фабрики. В этом вся история, и поэтому выбор сводится ко времени жизни.

Класс настроек и регистрация одинаковы для всех трёх:

```csharp
// .NET 11, C# 14
public sealed class PaymentOptions
{
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
}

// Program.cs
builder.Services.Configure<PaymentOptions>(
    builder.Configuration.GetSection("Payment"));
```

## Когда выбирать IOptions

Сделайте его вариантом по умолчанию. Вы отказываетесь от поддержки перезагрузки, и в большинстве сервисов это не настоящая потеря.

- **Всё, что читается при старте.** Строки подключения, базовый URL, имя очереди, feature flag, который вы поменяете переразвёртыванием. `IOptions<T>` является синглтоном, поэтому его внедрение в синглтон, в scoped-сервис и в transient-сервис работает одинаково. Если при подключении настроек вы получаете ошибку `Cannot consume scoped service`, то `IOptions<T>` обычно является решением, а не причиной. Смотрите [почему возникает это исключение и как его распутать](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Горячие пути.** `UnnamedOptionsManager<T>` кеширует привязанный экземпляр в поле. После первого обращения `.Value` является чтением поля. Нет поиска по словарю, нет сравнения имён, нет выделения памяти.
- **Захват в конструкторе безопасен.** Поскольку значение никогда не меняется, `options.Value` в конструкторе корректен и не является скрытой ошибкой.

```csharp
// .NET 11, C# 14
public sealed class PaymentClient(IOptions<PaymentOptions> options)
{
    // Safe: the value is fixed for the life of the process.
    private readonly PaymentOptions _settings = options.Value;

    public TimeSpan Timeout => TimeSpan.FromSeconds(_settings.TimeoutSeconds);
}
```

Цена `IOptions<T>` ровно одна: он не поддерживает именованные опции, поэтому `Configure<Features>("Personalize", ...)` для него невидим. Если вам нужны две конфигурации одного класса, вы уже исключили `IOptions<T>`. Это же подходящий момент проверить, не подходят ли [сервисы с ключом во внедрении зависимостей .NET 11](/ru/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) лучше именованных опций для того, что вы на самом деле моделируете.

## Когда выбирать IOptionsSnapshot

Обращайтесь к нему, когда **scoped**-потребителю нужно значение, остающееся согласованным в пределах одной единицы работы, но способное меняться между единицами работы.

- **Значение на запрос, которое не должно измениться посреди запроса.** Контроллер и три вызываемых им сервиса разрешают один и тот же scoped-экземпляр `OptionsManager<T>`, поэтому все четверо видят один и тот же экземпляр `PaymentOptions`, даже если `appsettings.json` перезаписан в середине запроса. `IOptionsMonitor<T>` такой гарантии не даёт: два чтения `CurrentValue` в одном запросе могут вернуть два разных экземпляра.
- **Именованные опции в scoped-потребителе.** `Get(name)` поддерживается, а `OptionsCache<T>` на область делает второй `Get("Personalize")` в запросе попаданием в кеш.

```csharp
// .NET 11, C# 14 -- scoped service, values stable for this request
public sealed class CheckoutService(IOptionsSnapshot<PaymentOptions> snapshot)
{
    private readonly PaymentOptions _settings = snapshot.Value;

    public string Key => _settings.ApiKey;
}
```

Два жёстких ограничения. Во-первых, `IOptionsSnapshot<T>` зарегистрирован как `Scoped`, поэтому внедрение его в синглтон не работает, в том числе в `IHostedService` или `BackgroundService`, которые являются синглтонами. Хост включает `ValidateScopes` и `ValidateOnBuild` в окружении Development, поэтому там вы получите понятное `Cannot consume scoped service` на старте; вне Development эти проверки по умолчанию выключены, и тот же код разрешает захваченную зависимость, которая молча никогда не обновляется. Включите проверку областей во всех окружениях, если хотите, чтобы сбой был громким. Обходной путь состоит в том, чтобы [создать область внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) и разрешать зависимости оттуда, но если вам нужны были лишь свежие значения, `IOptionsMonitor<T>` является более простым ответом. Во-вторых, в консольном приложении или в чистом `IHost` нет окружающей области, пока вы её не создадите, поэтому `IOptionsSnapshot<T>` вне веб-хоста почти всегда означает, что на самом деле вам нужен был `IOptionsMonitor<T>`.

## Когда выбирать IOptionsMonitor

Обращайтесь к нему, когда **синглтон** должен видеть изменения или когда вам нужен обратный вызов.

- **Синглтон, который нельзя перезапускать ради нового значения.** Ограничитель частоты, политика кеширования, процент семплирования, уровень журналирования.
- **Нужно реагировать, а не только читать.** `OnChange` является единственным push-уведомлением из трёх.
- **Выборочная инвалидация.** `IOptionsMonitorCache<T>.TryRemove(name)` заставляет пересобрать один именованный экземпляр при следующем обращении, что полезно, когда именно ваш код, а не наблюдатель за файлами, знает об устаревании значения.

`OptionsMonitor<T>` подписывается на каждый зарегистрированный `IOptionsChangeTokenSource<T>`. Когда один из них срабатывает, `InvokeChanged` выполняет `_cache.TryRemove(name)`, немедленно пересобирает значение через `TOptions options = Get(name)`, а затем вызывает слушателей с новым экземпляром. `CurrentValue` является тонкой обёрткой над `Get(Options.DefaultName)`, то есть над `_cache.GetOrAdd(localName, () => localFactory.Create(localName))`.

```csharp
// .NET 11, C# 14 -- singleton, always current
public sealed class RateLimiter : IDisposable
{
    private readonly IDisposable? _subscription;
    private volatile PaymentOptions _current;

    public RateLimiter(IOptionsMonitor<PaymentOptions> monitor)
    {
        _current = monitor.CurrentValue;
        _subscription = monitor.OnChange(updated => _current = updated);
    }

    public int TimeoutSeconds => _current.TimeoutSeconds;

    public void Dispose() => _subscription?.Dispose();
}
```

Этот `IDisposable` важен. `OnChange` возвращает `ChangeTrackerDisposable`, чей `Dispose` выполняет `_monitor._onChange -= OnChange`. Зарегистрируйте обратный вызов из scoped- или transient-сервиса и выбросьте возвращённое значение, и каждый запрос будет добавлять слушателя к многоадресному делегату синглтона, который никогда не снимается. Результатом станет медленная утечка памяти плюс шторм обратных вызовов, и это один из самых частых способов сломать работу с `IOptionsMonitor<T>`.

Уведомления об изменениях существуют только для файловых провайдеров конфигурации, таких как `Microsoft.Extensions.Configuration.Json`, `.Ini`, `.Xml`, `.KeyPerFile` и `.UserSecrets`, и только если провайдер был добавлен с `reloadOnChange: true`. Провайдер переменных окружения или командной строки не срабатывает никогда, поэтому поверх таких источников `IOptionsMonitor<T>` молча вырождается в чуть более дорогой `IOptions<T>`.

## Значимое измерение здесь это счётчик, а не цифра в наносекундах

Я намеренно не публикую здесь цифры ns/op, потому что стоимость разрешения всех трёх определяется тем, что делают ваши собственные делегаты `IConfigureOptions<T>` и валидаторы, а значит, числа с моей машины ничего не скажут о вашей. Переносимым является число **сколько раз выполняется ваш binder**, и измерить его можно примерно пятнадцатью строками.

```csharp
// .NET 11 Preview 6, C# 14 -- counts how often the options are actually built
public sealed class CountingConfigure : IConfigureOptions<PaymentOptions>
{
    public static int Count;
    public void Configure(PaymentOptions options) => Interlocked.Increment(ref Count);
}

builder.Services.AddSingleton<IConfigureOptions<PaymentOptions>, CountingConfigure>();

app.MapGet("/probe", (
    IOptions<PaymentOptions> o,
    IOptionsSnapshot<PaymentOptions> s,
    IOptionsMonitor<PaymentOptions> m) =>
{
    _ = o.Value; _ = s.Value; _ = m.CurrentValue;
    return CountingConfigure.Count;
});
```

Обращайтесь к `/probe` многократно, и счётчик будет расти ровно на единицу за запрос, и эта единица приходится на `IOptionsSnapshot<T>`. `IOptions<T>` вносит вклад только в первом запросе, `IOptionsMonitor<T>` в первом запросе и затем по разу на каждую перезагрузку, а `IOptionsSnapshot<T>` в каждом без исключения запросе, потому что новая область означает новый `OptionsManager<T>` с пустым `OptionsCache<T>`. Добавьте `.ValidateDataAnnotations()` к этой регистрации, и валидаторы тоже будут выполняться заново на каждом запросе. На конечной точке с 5000 запросами в секунду это 5000 повторных привязок и 5000 проходов валидации в секунду ради значения, которое практически никогда не меняется. Это конкретная причина, по которой `IOptionsSnapshot<T>` не должен быть вашим выбором по умолчанию, и это утверждение вы можете проверить в собственном приложении, а не принимать на веру из графика.

## Подводные камни, которые решают за вас

**`OnChange` срабатывает на конфигурацию, до которой вам нет дела.** Обратные вызовы привязаны к токену изменения корня конфигурации, а не к вашей секции. Любая запись в любой части `IConfiguration` вызывает каждого слушателя `IOptionsMonitor<T>` в приложении. Команда .NET завела это как [dotnet/runtime#109445](https://github.com/dotnet/runtime/issues/109445) и закрыла как незапланированное, так что поведение постоянно: пока меняется любая часть конфигурации, все экземпляры `IOptionsMonitor` могут вызывать свои обратные вызовы. Если ваш обратный вызов пересобирает дорогой ресурс, кешируйте предыдущее значение и сравнивайте перед действием.

**`OnChange` также срабатывает больше одного раза на сохранение.** Редакторы записывают файлы несколькими операциями, а нижележащий `IFileProvider.Watch` сообщает о каждой из них, поэтому одно нажатие `Ctrl+S` обычно порождает два обратных вызова, а иногда и больше. Это [dotnet/aspnetcore#2542](https://github.com/dotnet/aspnetcore/issues/2542), и это артефакт наблюдателя за файлами, а не ошибка в стеке опций. Сделайте обратный вызов идемпотентным или примените debounce.

**Наблюдение за файлами ненадёжно на томах Docker и сетевых шарах.** Установите `DOTNET_USE_POLLING_FILE_WATCHER=1`, чтобы вместо этого выполнялся опрос. Интервал опроса составляет четыре секунды и не настраивается, что является реальным ограничением, если вы рассчитывали на более быстрое распространение изменений.

**`IOptions<T>` действительно означает навсегда.** Значение привязывается при первом чтении `.Value` и кешируется на всё время жизни процесса. Если ментальная модель вашей команды звучит как "объект настроек обновляется", то `IOptions<T>` будет выглядеть сломанным во время инцидента, когда выкатка конфигурации ничего не изменит. Решайте это для каждого класса настроек и фиксируйте письменно.

**Настраивать опции через scoped-сервисы это ловушка независимо от способа доступа.** `IConfigureOptions<T>` для `IOptions<T>` разрешается через корневой провайдер, поэтому scoped-зависимость, внедрённая в ваш делегат настройки, становится захваченной зависимостью. Вместо этого получите `IServiceProvider` и создайте область внутри `Configure`, и помните, что эта область не является областью запроса.

## Что добавляет .NET 11

Две вещи, о которых стоит знать, и обе они находятся в слое валидации, а не в слое доступа.

`OptionsBuilder<TOptions>` получает обобщённую перегрузку `Validate`, принимающую параметр типа вместо делегата. Тип должен реализовывать `IValidateOptions<TOptions>` и быть зарегистрирован в DI, что приводит валидацию опций к обычному паттерну DI:

```csharp
// .NET 11, C# 14
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

`System.ComponentModel.DataAnnotations` в .NET 11 также научился асинхронной валидации через `AsyncValidationAttribute`, `IAsyncValidatableObject` и `Validator.ValidateObjectAsync`. `Microsoft.Extensions.Options` подхватывает это через новый `IAsyncStartupValidator`, поэтому опция, корректность которой зависит от сетевого вызова, может уронить приложение на старте, а не при первом использовании. Ни одно из этих изменений не влияет на то, какой способ доступа вам следует внедрять; оба делают `ValidateOnStart` более сильным выбором по умолчанию, чем он был в .NET 10.

## Рекомендация ещё раз

Начинайте каждый класс настроек с `IOptions<T>`. Переходите к `IOptionsMonitor<T>`, когда у конкретного синглтона есть задокументированная потребность наблюдать за изменениями, и освобождайте подписку `OnChange`. Используйте `IOptionsSnapshot<T>` только тогда, когда scoped-потребителю нужна стабильность в пределах запроса для значения, которое действительно меняется, и примите, что за это вы платите полной повторной привязкой плюс повторной валидацией на каждом запросе. Если вы тянетесь к `IOptionsSnapshot<T>` потому, что так исчезла ошибка компиляции, вы решили проблему времени жизни проблемой производительности.

## Связанные материалы

- [Fix: Cannot consume scoped service 'X' from singleton 'Y'](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Как использовать scoped-сервисы внутри BackgroundService в ASP.NET Core 11](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [Как регистрировать и разрешать сервисы с ключом во внедрении зависимостей .NET 11](/ru/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [Fix: No connection string named 'DefaultConnection' could be found](/ru/2026/05/fix-no-connection-string-named-defaultconnection/)
- [Как писать интеграционные тесты с WebApplicationFactory в ASP.NET Core 11](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)

## Источники

- [Паттерн Options в .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options), Microsoft Learn
- [Что нового в библиотеках .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), Microsoft Learn
- [OptionsServiceCollectionExtensions.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs), dotnet/runtime
- [OptionsMonitor.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsMonitor.cs), dotnet/runtime
- [IOptionsMonitor OnChange срабатывает при любом изменении в IConfiguration](https://github.com/dotnet/runtime/issues/109445), issue 109445 в dotnet/runtime
- [ChangeToken.OnChange срабатывает дважды при прослушивании изменений конфигурации](https://github.com/dotnet/aspnetcore/issues/2542), issue 2542 в dotnet/aspnetcore
- [Опасности и подводные камни использования scoped-сервисов при настройке опций](https://andrewlock.net/the-dangers-and-gotchas-of-using-scoped-services-when-configuring-options-in-asp-net-core/), Andrew Lock

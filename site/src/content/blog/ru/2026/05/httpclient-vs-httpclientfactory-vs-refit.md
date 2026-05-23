---
title: "HttpClient vs HttpClientFactory vs Refit: что использовать в .NET 11?"
description: "Никогда не создавайте HttpClient на каждый запрос. Используйте IHttpClientFactory для управления временем жизни и добавляйте Refit сверху, когда нужен типизированный интерфейс вместо написанного вручную кода запроса. Чистый singleton HttpClient годится лишь для самых простых случаев."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "httpclient"
  - "httpclientfactory"
  - "refit"
  - "dotnet"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/httpclient-vs-httpclientfactory-vs-refit"
translatedBy: "claude"
translationDate: 2026-05-23
---

Первое, что нужно понять: эти три варианта на самом деле не конкуренты. Это три слоя одного и того же стека. `IHttpClientFactory` управляет временем жизни `HttpClient`, а Refit генерирует вызовы `HttpClient` за вас, поверх фабрики. Поэтому настоящий вопрос в том, насколько высоко в стеке вам стоит расположиться. Для нового кода .NET 11 в 2026 году: регистрируйте свои клиенты через **IHttpClientFactory**, чтобы время жизни соединения и DNS обрабатывались правильно, и беритесь за **Refit**, когда вам нужен типизированный интерфейс вместо написания кода построения запросов вручную. Чистый, долгоживущий singleton `HttpClient` приемлем только для самых простых случаев с одним вызовом, а `new HttpClient()` на каждый запрос -- это единственный шаблон, который всегда неверен.

Каждый пример здесь нацелен на `<TargetFramework>net11.0</TargetFramework>` с SDK .NET 11 и C# 14. Refit имеется в виду версии 10.1.6 (выпущена 2026-03-21, текущая стабильная на NuGet), а части, отвечающие за устойчивость, используют `Microsoft.Extensions.Http.Resilience` 10.6.0. `IHttpClientFactory` находится в `Microsoft.Extensions.Http`, который поставляется из коробки с SDK для ASP.NET Core и Worker.

## Матрица возможностей с первого взгляда

Это та таблица, ради которой вы пришли. Столбцы -- это три способа, которыми вы реально будете подключать HTTP-вызов, а строки -- это решения, которые меняют, какой из них вы выберете.

| Критерий | Чистый HttpClient (singleton) | IHttpClientFactory | Refit (+ HttpClientFactory) |
| ------- | -------------------------- | ------------------ | --------------------------- |
| Безопасен от исчерпания сокетов | Да, если это действительно singleton | Да | Да |
| Учитывает изменения DNS | Только с `PooledConnectionLifetime` | Да, handler ротируется (по умолчанию 2 мин.) | Да, наследует от фабрики |
| Конвейер handler-ов через DI | Вручную | Полноценно (`AddHttpMessageHandler`) | Полноценно, наследует от фабрики |
| Встроенная устойчивость | Реализуется руками | `AddStandardResilienceHandler` | `AddStandardResilienceHandler` |
| Именованные / типизированные клиенты | Нет | Да | Да, интерфейс и есть клиент |
| Код построения запросов, который вы пишете | Весь | Весь | Никакого, генерируется при сборке |
| Строго типизированные ответы | Десериализация вручную | Десериализация вручную | Автоматически |
| Native AOT / trimming | Да | Да | Да, начиная с 9.0.2 на .NET 10+ |
| Дополнительная зависимость NuGet | Нет (из коробки) | Нет для ASP.NET Core | `Refit`, `Refit.HttpClientFactory` |
| Лучше всего для | Одного-двух простых вызовов | Большей части серверного кода | Множества endpoint-ов к одному API |

Закономерность в таблице такова: каждый столбец наследует гарантии безопасности столбца слева от себя и добавляет эргономику сверху. Цена движения вправо -- это зависимость и немного косвенности, а не корректность.

## Когда чистый HttpClient на самом деле подходит

Существует устойчивый миф о том, что `HttpClient` нельзя использовать напрямую. Это чрезмерная коррекция. Единственный, долгоживущий `HttpClient`, разделяемый всем приложением, -- это совершенно допустимый и хорошо поддерживаемый шаблон. Опасность была никогда не в самом `HttpClient`, а в создании нового на каждый запрос внутри блока `using`, что приводит к утечке сокетов в `TIME_WAIT` и в итоге исчерпывает диапазон портов под нагрузкой.

Статический singleton избегает исчерпания сокетов, но вносит вторую, более тонкую проблему: `HttpClient` разрешает DNS только при открытии соединения, а долгоживущий пул соединений никогда не разрешает его повторно. Если целевой хост переключается на новый IP, ваш singleton продолжает долбить старый. Решение в .NET Core и .NET 5+ -- ограничить время жизни соединения на handler-е:

```csharp
// .NET 11, C# 14 - a singleton that still picks up DNS changes
using System.Net;

var handler = new SocketsHttpHandler
{
    // Recycle pooled connections so DNS failover is respected
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    AutomaticDecompression = DecompressionMethods.All
};

// Construct once, reuse for the entire process lifetime
var http = new HttpClient(handler)
{
    BaseAddress = new Uri("https://api.example.com")
};
```

Используйте это, когда у вас консольная утилита, небольшой worker или библиотека без DI-контейнера и вы делаете вызовы к одному-двум endpoint-ам. В тот момент, когда у вас появляется DI-контейнер и больше пары клиентов, вы переписываете `IHttpClientFactory` вручную, и вам стоит остановиться и использовать настоящую.

## Когда IHttpClientFactory -- правильный вариант по умолчанию

Для почти всего серверного кода в 2026 году `IHttpClientFactory` -- это базовый уровень. Она инкапсулирует описанное выше управление временем жизни, чтобы вам не приходилось думать о `PooledConnectionLifetime` или ротации DNS: фабрика пулит экземпляры `HttpMessageHandler` и ротирует их с настраиваемым интервалом (по умолчанию две минуты), что даёт вам переиспользование сокетов и свежесть DNS одновременно.

Больший выигрыш -- это конвейер handler-ов сообщений. Вы можете регистрировать сквозную функциональность (заголовки аутентификации, журналирование, идентификаторы корреляции, повторы) как экземпляры `DelegatingHandler` в DI, и каждый клиент, построенный фабрикой, компонует их по порядку. Типизированный клиент связывает настроенный `HttpClient` с конкретным классом сервиса:

```csharp
// .NET 11, C# 14 - typed client registered through the factory
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // Polly-backed retries, timeout, circuit breaker

public sealed class GitHubService(HttpClient client)
{
    public async Task<Repo?> GetRepoAsync(string owner, string name, CancellationToken ct)
    {
        // You still hand-write the path, the verb, and the deserialize
        return await client.GetFromJsonAsync<Repo>($"/repos/{owner}/{name}", ct);
    }
}

public record Repo(long Id, string FullName, int StargazersCount);
```

`AddStandardResilienceHandler` (из `Microsoft.Extensions.Http.Resilience` 10.6.0) выстраивает в стек ограничитель частоты, общий таймаут запроса, повтор, circuit breaker и таймаут на попытку с разумными значениями по умолчанию. Это современная замена ручному связыванию политик Polly, и это одна строка. Если после его добавления вы по-прежнему видите таймауты, причина обычно в неправильно настроенном таймауте на попытку, а не в самом handler-е, что является частым источником [TaskCanceledException, задача была отменена](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

Единственное, чего фабрика не делает, -- это не пишет ваш код запроса. Вы по-прежнему сами составляете путь, HTTP-глагол, строку запроса и десериализацию для каждого вызова. Для одного-двух endpoint-ов это нормально. Для REST API с тридцатью endpoint-ами это тридцать методов почти идентичного шаблонного кода, и это именно тот пробел, который заполняет Refit.

## Когда Refit оправдывает свою зависимость

Refit превращает интерфейс C# в работающий REST-клиент. Вы объявляете форму API с помощью атрибутов, а генератор исходного кода Refit выдаёт реализацию при сборке. Нет ни построения запросов на каждый вызов, ни ручной десериализации:

```csharp
// .NET 11, C# 14, Refit 10.1.6 - the interface IS the client
using Refit;

public interface IGitHubApi
{
    [Get("/repos/{owner}/{name}")]
    Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default);

    [Get("/users/{user}/repos")]
    Task<IReadOnlyList<Repo>> GetUserReposAsync(string user, [Query] string sort = "updated");

    [Post("/repos/{owner}/{name}/issues")]
    Task<Issue> CreateIssueAsync(string owner, string name, [Body] NewIssue issue);
}

public record Repo(long Id, string FullName, int StargazersCount);
public record Issue(long Number, string Title);
public record NewIssue(string Title, string Body);
```

Зарегистрируйте его на той же инфраструктуре фабрики через `Refit.HttpClientFactory`, чтобы сохранить все гарантии времени жизни, DNS и устойчивости из нижележащего слоя:

```csharp
// .NET 11, C# 14, Refit.HttpClientFactory 10.1.6
using Refit;
using Microsoft.Extensions.DependencyInjection;

builder.Services
    .AddRefitClient<IGitHubApi>()
    .ConfigureHttpClient(c =>
    {
        c.BaseAddress = new Uri("https://api.github.com");
        c.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
    })
    .AddStandardResilienceHandler(); // same resilience stack as a typed client
```

Это и есть весь клиент. Три метода интерфейса заменяют то, что было бы тремя написанными вручную методами плюс их логика построения запроса и разбора. Для кодовой базы, которая общается с большим сторонним API, сокращение объёма кода, который вам нужно читать и сопровождать, -- это весь аргумент. Refit также хорошо справляется с неудобными частями: `[Query]` для строк запроса, `[Body]` с сериализацией, `[Header]` и `[Authorize]` для аутентификации, multipart-загрузки и `ApiResponse<T>`, когда вам нужны код статуса и заголовки, а не только десериализованное тело.

Два практических замечания на 2026 год. Во-первых, Refit 9.0.2 (ноябрь 2025) добавил поддержку Native AOT и trimming для .NET 10 и новее, поэтому Refit больше не выбывает из обрезанных контейнеров и функций scale-to-zero так, как это происходит с клиентами, активно использующими рефлексию. Для пути AOT предоставьте сгенерированные из исходного кода метаданные `System.Text.Json` через `JsonSerializerContext`, чтобы сериализатор оставался без рефлексии, -- та же дисциплина, что разбирается в [Native AOT vs ReadyToRun vs JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/). Во-вторых, если ваш API описан документом OpenAPI, вам даже не нужно писать интерфейс вручную: инструменты могут выдавать интерфейсы Refit из спецификации, что пересекается с [генерацией строго типизированного клиента из спецификации OpenAPI](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Какова накладная стоимость на самом деле

Честный ответ о производительности таков: для HTTP-вызовов доминирует сеть, и выбор между этими тремя теряется в шуме. Полный обмен с реальным API измеряется в миллисекундах -- сотнях миллисекунд; накладные расходы на построение запроса измеряются в микросекундах. Выбирать Refit вместо типизированного клиента ради экономии CPU -- значит оптимизировать не тот слой.

При этом накладные расходы не равны нулю, и стоит знать, где они кроются:

| Аспект | Чистый / типизированный клиент | Refit |
| ------ | ------------------ | ----- |
| Построение запроса на вызов | Прямое, написано вручную | Сгенерировано, почти прямое на .NET 8+ |
| Рефлексия во время выполнения | Нет | Нет с генератором исходного кода |
| Затраты на старте | Нет | Однократная регистрация сгенерированных заглушек |
| Выделение памяти на вызов | Базовый уровень | Сопоставимо, разбор атрибутов происходит при сборке |

Ключевой методологический момент: Refit перешёл на генератор исходного кода Roslyn (`InterfaceStubGenerator`), поэтому анализ интерфейса происходит во время компиляции, а не на каждом вызове. Прежняя стоимость рефлексии и `Reflection.Emit`, которую AOT не мог терпеть, ушла. Если вам нужно реальное число для ваших собственных форм объектов, запустите BenchmarkDotNet на ваших DTO, а не доверяйте обобщённой цифре, но ожидайте, что разница между типизированным клиентом и клиентом Refit составит десятки наносекунд против сетевого вызова, который занимает миллисекунды. Решение -- о коде, который вы сопровождаете, а не о тактах, которые вы тратите.

## Подвох, который решает за вас

Несколько ограничений улаживают выбор ещё до того, как в дело вступают предпочтения.

**`new HttpClient()` на каждый запрос -- никогда не ответ.** Это единственный по-настоящему неверный шаблон, и он неверен для всех трёх столбцов. Он исчерпывает сокеты под нагрузкой, хотя `HttpClient` -- `IDisposable` и выглядит так, будто просит `using`. Если вы запомните одну вещь, запомните эту: создавайте `HttpClient` один раз или дайте фабрике создать его за вас, но никогда не на каждый вызов.

**Singleton-ы, захватывающие типизированный клиент, обходят фабрику.** Зарегистрировать типизированный клиент или клиент Refit, а затем захватить его внутри singleton-а -- значит закрепить один handler навсегда, что означает, что он перестаёт ротироваться и перестаёт видеть изменения DNS, -- ровно ту проблему, ради решения которой фабрика и существует. Внедряйте клиент туда, где вы его используете, или внедряйте `IHttpClientFactory` и создавайте по требованию. Не прячьте его в статическое поле.

**Refit требует, чтобы ответ соответствовал контракту.** Поскольку десериализация автоматическая, ответ, не соответствующий вашему record (обёртывающий конверт, другой регистр, тело ошибки, возвращённое с 200), всплывает как сбой десериализации, а не как нечто, что вы обрабатываете по месту. Используйте `ApiResponse<T>`, когда вам нужно проверить статус и заголовки, и настраивайте сериализатор так же, как вы делали бы это в другом месте. Тестирование этих клиентов тоже немного отличается, потому что нет тела метода, которое можно замокать; вы мокаете `HttpMessageHandler`, тот же подход, что и при [модульном тестировании кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/).

**Лицензирование здесь не фактор.** В отличие от некоторых споров о mapper-ах и mediator-ах в 2026 году, все три варианта бесплатны и имеют разрешительные лицензии. `HttpClient` и `IHttpClientFactory` поставляются с .NET, а Refit -- под MIT. Нет коммерческого барьера, толкающего вас к какому-либо из них или прочь от него.

## Решение в одну строку

Для нового кода .NET 11 в 2026 году: сделайте `IHttpClientFactory` своим вариантом по умолчанию, чтобы время жизни, DNS и устойчивость обрабатывались за вас, и добавляйте Refit сверху, когда вы вызываете множество endpoint-ов к одному API и хотите, чтобы код запроса генерировался, а не писался вручную. Оставьте чистый `HttpClient` для по-настоящему простого случая (singleton с `PooledConnectionLifetime`, один-два вызова, без DI) и никогда не создавайте его на каждый запрос. Это не три соперничающие библиотеки, между которыми вы выбираете; это три ступени одной лестницы, и вы поднимаетесь на ту ступень, которая соответствует тому, сколько HTTP-обвязки вы хотите перестать писать самостоятельно.

## Связанные материалы

- [Как сгенерировать строго типизированный клиент из спецификации OpenAPI в .NET 11](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Как модульно тестировать код, использующий HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException, задача была отменена в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Native AOT vs ReadyToRun vs JIT в .NET 11](/ru/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [System.Text.Json vs Newtonsoft.Json в 2026 году](/ru/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Источники

- [Use IHttpClientFactory to implement resilient HTTP requests](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory) - именованные и типизированные клиенты, время жизни handler-а и конвейер handler-ов сообщений.
- [HttpClient guidelines for .NET](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines) - исчерпание сокетов, DNS и шаблон `PooledConnectionLifetime` для singleton-ов.
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler` и стандартный стек устойчивости.
- [Refit on GitHub](https://github.com/reactiveui/refit) - генератор исходного кода, справочник по атрибутам и интеграция с `Refit.HttpClientFactory`.
- [Refit.HttpClientFactory 10.1.6 on NuGet](https://www.nuget.org/packages/refit.httpclientfactory) - текущая стабильная версия и целевые фреймворки.

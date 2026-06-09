---
title: "Как сохранить состояние через границу статического и интерактивного рендеринга в Blazor на .NET 11"
description: "Предварительно отрендеренный компонент Blazor выполняет инициализацию дважды и теряет состояние при переходе к интерактивности. Решите это с помощью атрибута [PersistentState] или сервиса PersistentComponentState в .NET 11."
pubDate: 2026-06-09
template: how-to
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "ssr"
lang: "ru"
translationOf: "2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-09
---

Компонент Blazor на шаблоне Blazor Web App выполняет инициализацию дважды: один раз во время предварительного рендеринга (статический рендеринг на стороне сервера) и снова, когда компонент рендерится интерактивно. Всё, что вы получили или вычислили в `OnInitializedAsync` в первый раз, ко второму разу исчезает, поэтому компонент запрашивает данные заново, и пользователь видит, как предварительно отрендеренный UI мерцает при замене. Решение состоит в том, чтобы захватить это состояние во время предварительного рендеринга и передать его через границу. В .NET 11 есть два способа сделать это: декларативный атрибут `[PersistentState]` (простой путь, доступен с .NET 10) и императивный сервис `PersistentComponentState` (доступен с .NET 8, для всего, что атрибут не может выразить). Эта статья ориентирована на .NET 11 (на момент написания в предварительной версии, GA запланирован на ноябрь 2026 года) и набор пакетов `Microsoft.AspNetCore.Components` 11.0.x.

## Почему компонент инициализируется дважды

Шаблон Blazor Web App рендерит страницу в два прохода. Первый проход выполняет предварительный рендеринг: сервер выполняет ваш компонент как статический HTML, выполняет `OnInitialized` / `OnInitializedAsync` и отправляет полученную разметку, чтобы страница быстро отрисовалась и хорошо индексировалась. Второй проход обеспечивает интерактивность: как только среда выполнения запускается (SignalR-цепь для `InteractiveServer`, загруженная WASM-нагрузка для `InteractiveWebAssembly` или любая из них для `InteractiveAuto`), Blazor создаёт новую копию компонента и выполняет инициализацию во второй раз.

Этот второй экземпляр не наследует ни одного поля, которое вы установили во время предварительного рендеринга. Он стартует со значений по умолчанию. Если ваша инициализация выглядела так:

```razor
@* PrerenderedCounter1.razor *@
@* .NET 11, Blazor Web App, any interactive render mode *@
@page "/prerendered-counter-1"
@inject ILogger<PrerenderedCounter1> Logger

<p role="status">Current count: @currentCount</p>

@code {
    private int currentCount;

    protected override void OnInitialized()
    {
        currentCount = Random.Shared.Next(100);
        Logger.LogInformation("currentCount set to {Count}", currentCount);
    }
}
```

вы увидите `currentCount set to 41` во время предварительного рендеринга и `currentCount set to 92` мгновением позже, когда компонент становится интерактивным, с видимым переключением с 41 на 92 в браузере. Со случайным числом это просто курьёз. С вызовом к базе данных это дублированный запрос, более медленное время до интерактивности и реальное мерцание между предварительно отрендеренным и повторно полученным значением.

Это именно граница предварительного рендеринга и интерактивности. Если ваш компонент `Routes` не определяет render mode, и вы попадаете на страницу через внутреннюю [улучшенную навигацию](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing), предварительный рендеринг вообще не происходит, поэтому инициализация выполняется один раз, и сохранять нечего. Чтобы воспроизвести двойную инициализацию, вам нужна полная перезагрузка страницы.

## Декларативное решение: атрибут `[PersistentState]`

Самый чистый способ перенести состояние через границу в .NET 11 состоит в том, чтобы поместить его в публичное свойство и аннотировать его атрибутом `[PersistentState]`. Blazor сериализует свойство в предварительно отрендеренный HTML, а затем десериализует его обратно в интерактивный экземпляр перед инициализацией. Ваша задача состоит лишь в том, чтобы определить, было ли значение восстановлено:

```razor
@* PrerenderedCounter2.razor *@
@* .NET 11 / .NET 10. [PersistentState] requires aspnetcore 10.0+ *@
@page "/prerendered-counter-2"
@inject ILogger<PrerenderedCounter2> Logger

<p role="status">Current count: @CurrentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int? CurrentCount { get; set; }

    protected override void OnInitialized()
    {
        if (CurrentCount is null)
        {
            CurrentCount = Random.Shared.Next(100);
            Logger.LogInformation("CurrentCount set to {Count}", CurrentCount);
        }
        else
        {
            Logger.LogInformation("CurrentCount restored to {Count}", CurrentCount);
        }
    }

    private void IncrementCount() => CurrentCount++;
}
```

Теперь журнал показывает `CurrentCount set to 96` во время предварительного рендеринга и `CurrentCount restored to 96`, когда включается интерактивность. То же значение, без второго `Random.Shared.Next`, без мерцания.

Три правила заставляют это работать, и о них легко споткнуться:

1. **Свойство должно быть `public`.** Фреймворк использует рефлексию над ним для сериализации, анализа trimming и генерации исходного кода. Поле `private` с этим атрибутом не будет учтено.
2. **Используйте тип, допускающий null, или такой, чьё значение по умолчанию определимо.** Вам нужно отличить «восстановлено» от «никогда не устанавливалось». Тип, допускающий null (`int?`, `WeatherForecast[]?`), это идиоматический сигнал. Для ссылочных типов `null` означает, что предварительный рендеринг должен его заполнить.
3. **Заполняйте только когда null.** Проверка `if (CurrentCount is null)` это то, что удерживает дорогостоящую работу в проходе предварительного рендеринга и пропускает её в интерактивном проходе.

Реалистичный вариант: загрузка данных. Получите при предварительном рендеринге, переиспользуйте в интерактивном:

```razor
@* ContactList.razor -- .NET 11, InteractiveAuto render mode *@
@page "/contacts"
@inject IContactService Contacts

@if (Items is null)
{
    <p>Loading...</p>
}
else
{
    <ul>@foreach (var c in Items) { <li>@c.Name</li> }</ul>
}

@code {
    [PersistentState]
    public IReadOnlyList<Contact>? Items { get; set; }

    protected override async Task OnInitializedAsync()
    {
        // Runs the query on the prerender pass; the interactive pass
        // gets Items back already populated and skips the call.
        Items ??= await Contacts.GetAllAsync();
    }
}
```

### Привязка состояния к правильному экземпляру

Когда страница рендерит несколько компонентов одного типа в цикле, сохранённое состояние должно быть сопоставлено обратно с правильным экземпляром. Используйте директиву `@key`, чтобы Blazor мог сопоставить сериализованные блобы с нужным компонентом:

```razor
@* Parent.razor -- .NET 11 *@
@page "/parent"

@foreach (var element in elements)
{
    <PersistentChild @key="element.Name" />
}
```

Внутри `PersistentChild` свойство `[PersistentState]` восстанавливается по ключу. Без `@key` два экземпляра могут поменять местами или потерять своё состояние.

### Данные только для чтения и улучшенная навигация

По умолчанию сохранённое состояние загружается только тогда, когда интерактивный компонент впервые появляется на странице. Это сделано намеренно: это не даёт более поздней улучшенной навигации к той же странице затоптать живое состояние, например наполовину отредактированную форму. Если ваше состояние доступно только для чтения и на мгновение ошибиться в нём дёшево (кешированные данные, которые редко меняются), включите обновления во время улучшенной навигации с помощью `AllowUpdates`:

```csharp
// .NET 11 -- allow the value to refresh on enhanced navigation
[PersistentState(AllowUpdates = true)]
public WeatherForecast[]? Forecasts { get; set; }

protected override async Task OnInitializedAsync()
{
    Forecasts ??= await ForecastService.GetForecastAsync();
}
```

Обратите внимание, что сохранение через улучшенную навигацию это возможность .NET 10+. В .NET 8 и .NET 9 сервис `PersistentComponentState` доставлял состояние только при первоначальной загрузке страницы, никогда через улучшенную навигацию на уже работающей цепи. Если вы зависите от этого поведения, в .NET 11 оно работает чисто.

### Пропуск восстановления в определённых ситуациях

В .NET 10 у `[PersistentState]` появилась вторая задача: сохранять состояние, когда цепь `InteractiveServer` вытесняется, и восстанавливать его при переподключении, чтобы разорванное соединение больше не стирало состояние компонента. Это вводит два случая, в которых вы можете захотеть отказаться от восстановления. `RestoreBehavior` управляет ими:

```csharp
// Do not restore the prerendered value (start fresh on interactivity)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipInitialValue)]
public string? NoPrerenderedData { get; set; }

// Do not restore the last snapshot on reconnection (force fresh data after a reconnect)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipLastSnapshot)]
public int CounterNotRestoredOnReconnect { get; set; }
```

## Императивное решение: сервис `PersistentComponentState`

Атрибут покрывает большинство случаев, но иногда вам нужно сохранить нечто, что не является одним свойством: значение, производное от нескольких полей, ключ, который вы вычисляете во время выполнения, или состояние, которое вы сохраняете только при определённых условиях. Внедрите сервис `PersistentComponentState` и зарегистрируйте обратный вызов. Это исходный механизм .NET 8, и он по-прежнему работает в .NET 11 точно так же, как раньше:

```razor
@* PrerenderedCounter3.razor -- .NET 11, PersistentComponentState service *@
@page "/prerendered-counter-3"
@implements IDisposable
@inject ILogger<PrerenderedCounter3> Logger
@inject PersistentComponentState ApplicationState

<p role="status">Current count: @currentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    private int currentCount;
    private PersistingComponentStateSubscription persistingSubscription;

    protected override void OnInitialized()
    {
        if (!ApplicationState.TryTakeFromJson<int>(
            nameof(currentCount), out var restoredCount))
        {
            currentCount = Random.Shared.Next(100);
            Logger.LogInformation("currentCount set to {Count}", currentCount);
        }
        else
        {
            currentCount = restoredCount!;
            Logger.LogInformation("currentCount restored to {Count}", currentCount);
        }

        // Register LAST to avoid a race condition at app shutdown.
        persistingSubscription = ApplicationState.RegisterOnPersisting(PersistCount);
    }

    private Task PersistCount()
    {
        ApplicationState.PersistAsJson(nameof(currentCount), currentCount);
        return Task.CompletedTask;
    }

    private void IncrementCount() => currentCount++;

    void IDisposable.Dispose() => persistingSubscription.Dispose();
}
```

Форма всегда одинакова:

1. Сначала `TryTakeFromJson<T>("key", out var value)`. Если он возвращает `true`, вы в интерактивном проходе, и значение было восстановлено. Если `false`, вы в проходе предварительного рендеринга и должны произвести значение.
2. Зарегистрируйте обратный вызов сохранения с помощью `RegisterOnPersisting` и внутри него вызовите `PersistAsJson("key", value)`. Регистрируйте его в **конце** инициализации, чтобы избежать состояния гонки при завершении работы приложения.
3. Освободите `PersistingComponentStateSubscription`, чтобы обратный вызов не утёк. Реализация `IDisposable` здесь не опциональна.

Если вам нужно управлять восстановлением императивно так же, как `RegisterOnPersisting` управляет сохранением, в .NET 10 добавлен `RegisterOnRestoring`, который позволяет подключиться к шагу восстановления. Это естественно сочетается со сценариями переподключения цепи, описанными выше.

## Сохранение состояния, которое живёт в сервисе, а не в компоненте

Состояние не всегда принадлежит компоненту. Если scoped-сервис DI хранит данные, вы можете сохранить и его свойства. Отметьте свойство атрибутом `[PersistentState]` и зарегистрируйте сервис для сохранения с помощью `RegisterPersistentService`, сообщив Blazor, к какому render mode он применяется (render mode нельзя вывести из типа сервиса):

```csharp
// CounterTracker.cs -- .NET 11
public class CounterTracker
{
    [PersistentState]
    public int CurrentCount { get; set; }

    public void IncrementCount() => CurrentCount++;
}
```

```csharp
// Program.cs -- .NET 11
using Microsoft.AspNetCore.Components.Web;

builder.Services.AddScoped<CounterTracker>();

builder.Services.AddRazorComponents()
    .RegisterPersistentService<CounterTracker>(RenderMode.InteractiveAuto);
```

Поддерживаются только scoped-сервисы. Аргумент render mode (`RenderMode.Server`, `RenderMode.Webassembly` или `RenderMode.InteractiveAuto`) решает, какие интерактивные контексты получают десериализованное состояние. Поскольку сериализация работает от фактического экземпляра, вы можете отметить абстракцию как сохраняемый сервис и держать конкретную реализацию internal, что удобно, когда сервер предварительного рендеринга и клиент WebAssembly разделяют интерфейс, но не реализацию.

## Что уходит по сети и линия безопасности, которую нельзя пересекать

Сохранённое состояние встраивается в HTML и передаётся клиенту. Куда оно попадает, зависит от render mode, и это та единственная ошибка, которая превращает удобство в утечку:

- **`InteractiveServer`**: состояние ходит туда и обратно через браузер, но защищено [ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/introduction), поэтому зашифровано при передаче.
- **`InteractiveWebAssembly` и `InteractiveAuto`**: состояние открыто браузеру в открытом виде, потому что код WebAssembly выполняется на клиенте и должен его прочитать. Режим `Auto` может разрешиться в WebAssembly, поэтому относитесь к нему как к случаю CSR.

Правило: никогда не помещайте ничего приватного в сохранённое состояние компонента WebAssembly или Auto. Сохраняйте список контактов, а не токен доступа. Если вам нужны серверные секреты, держите их на стороне сервера и получайте их после интерактивности, или оставайтесь на `InteractiveServer`.

## Сериализация, trimming и Native AOT

По умолчанию `[PersistentState]` и `PersistAsJson` сериализуют с помощью `System.Text.Json` с настройками по умолчанию. У этого есть два следствия, которые стоит запланировать.

Во-первых, сериализатор по умолчанию небезопасен для trimming. Если вы публикуете с trimming IL или [Native AOT](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), вы должны сохранить типы, которые вы сериализуете, иначе круговой проход завершится сбоем во время выполнения, как только метаданные будут обрезаны. Настройте генератор исходного кода `JsonSerializerContext` для ваших сохраняемых типов; это та же дисциплина, что вы применили бы при [написании пользовательского JsonConverter для System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

Во-вторых, если форма JSON по умолчанию вам не подходит (компактный двоичный формат, устаревшая кодировка, тип, который System.Text.Json обрабатывает неуклюже), в .NET 10 появился `PersistentComponentStateSerializer<T>`, чтобы вы могли взять на себя сериализацию конкретного типа:

```csharp
// Registered in Program.cs; applies to int? persisted state
builder.Services.AddSingleton<PersistentComponentStateSerializer<int?>,
    CustomIntSerializer>();
```

Сериализатор реализует `Persist(T value, IBufferWriter<byte> writer)` и `Restore(ReadOnlySequence<byte> data)`. Без зарегистрированного пользовательского сериализатора для типа Blazor возвращается к JSON, поэтому вы реализуете это только для типов, которым это нужно.

## Компоненты, встроенные в Razor Pages или MVC

Деталь, которая не применяется к шаблону Blazor Web App, но ловит людей при встраивании Blazor в существующее приложение: если вы помещаете интерактивные компоненты внутрь представления Razor Pages или MVC, механизму сохранения нужен вручную добавленный tag helper. Поместите `<persist-component-state />` прямо перед закрывающим `</body>` в вашем layout:

```cshtml
@* Pages/Shared/_Layout.cshtml -- only needed for Razor Pages / MVC hosts *@
<body>
    ...
    <persist-component-state />
</body>
```

Чистые проекты Blazor Web App подключают это автоматически; tag helper нужен вам только в случае смешанного хостинга.

## Как выбрать между двумя моделями

Сначала обращайтесь к `[PersistentState]`. Это меньше кода, она бесплатно обрабатывает границу предварительного рендеринга и переподключение цепи, а `AllowUpdates` плюс `RestoreBehavior` покрывают распространённые вариации декларативно. Переходите к сервису `PersistentComponentState`, когда единица состояния не является одним публичным свойством, когда вы вычисляете ключ сохранения во время выполнения или когда вам нужно сохранять условно внутри обратного вызова. Оба могут сосуществовать в одном приложении, и оба решают одну и ту же базовую проблему: гарантировать, что работа, проделанная во время предварительного рендеринга, переживёт переход к интерактивности, а не выполнится заново.

Если вы всё ещё решаете, какие render modes должны использовать ваши страницы, компромиссы в [Blazor Server vs Blazor WebAssembly vs Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) очерчивают, где предварительный рендеринг вообще применяется, а если вы переводите более старое приложение на эту модель, [контрольный список миграции с Blazor Server на Blazor Web App](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) называет двойное выполнение предварительного рендеринга единственным, что кусается. Для передачи одноразовых сообщений вместо сохранения состояния рендеринга вместо этого правильным инструментом будет [поддержка TempData в Blazor SSR в .NET 11](/ru/2026/04/blazor-ssr-tempdata-dotnet-11/).

Первоисточник: [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0) на Microsoft Learn, где задокументированы атрибут `[PersistentState]`, сервис `PersistentComponentState`, `RegisterPersistentService` и точка расширения `PersistentComponentStateSerializer<T>` для .NET 10 и .NET 11.

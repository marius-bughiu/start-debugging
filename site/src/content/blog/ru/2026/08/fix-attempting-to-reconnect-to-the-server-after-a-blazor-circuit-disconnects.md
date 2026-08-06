---
title: "Исправление: Attempting to reconnect to the server после обрыва circuit в Blazor Server"
description: "Модальное окно переподключения означает, что оборвался circuit SignalR, а не что приложение упало. Определите, чем закончилась попытка, failed или rejected, и почините привязку сессий, окно хранения в 3 минуты, лимит 32 КБ или сохраните состояние через [PersistentState]."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
lang: "ru"
translationOf: "2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects"
translatedBy: "claude"
translationDate: 2026-08-06
---

Это окно не ошибка, это Blazor сообщает, что соединение SignalR (circuit) оборвалось и клиент повторяет попытки. Важно, чем эти попытки заканчиваются. Если результат `failed` ("Reconnection failed", "Failed to rejoin"), браузер вообще не достучался до сервера: проверьте путь WebSocket через ваш прокси, тайминги keep-alive и лимит `MaximumReceiveMessageSize` в 32 КБ. Если результат `rejected` ("Could not reconnect to the server", "Failed to resume the session"), сервер был достигнут и отказал: circuit больше не существует, потому что приложение перезапустилось, потому что балансировщик отправил вас на другой экземпляр без привязки сессий, или потому что истёк `DisconnectedCircuitRetentionPeriod` в 3 минуты. В .NET 10 и .NET 11 надёжный ответ для последней группы причин состоит в том, чтобы перестать держаться за идентичность circuit и пометить состояние атрибутом `[PersistentState]`.

```text
Attempting to reconnect to the server: 3 of 8
Reconnection failed. Try reloading the page if you're unable to reconnect.
Could not reconnect to the server. Reload the page to restore functionality.
```

Это тексты .NET 8 и более ранних версий, и именно их чаще всего вставляют в поиск. В .NET 9 и новее те же состояния сформулированы иначе, поэтому результаты поиска выглядят так, будто речь о другой проблеме:

```text
Rejoining the server...
Rejoin failed... trying again in 5 seconds.
Failed to rejoin. Please retry or reload the page.
The session has been paused by the server.
Failed to resume the session. Please retry or reload the page.
```

Всё изложенное ниже проверено на .NET 11 Preview 6 (SDK `11.0.100-preview.6.26359.118`) с шаблоном Blazor Web App в режиме Interactive Server, и отмечено, где .NET 8, 9 и 10 ведут себя иначе. В Blazor WebAssembly circuit отсутствует, так что если вы видите это окно, ваши компоненты рендерятся в режиме `InteractiveServer` или в `InteractiveAuto`, который сейчас разрешился на сервер.

## Почему оборванный WebSocket даёт модальное окно, а не исключение

Серверное приложение Blazor хранит дерево компонентов, каждое поле каждого экземпляра компонента и каждый DI-сервис с областью circuit в памяти сервера. Этот набор и есть circuit. Браузер держит только отрисованный DOM и соединение SignalR: каждый клик представляет собой удалённый вызов к серверу, а каждая отрисовка приходит обратно в виде diff. Соединение рвётся, и браузеру нечем рисовать, поэтому фреймворк закрывает страницу и пытается заново привязаться к тому же circuit по его идентификатору.

Писать этот интерфейс никому не нужно. Если приложение объявляет элемент с `id="components-reconnect-modal"`, Blazor переключает на нём CSS-классы. Если такого элемента нет, Blazor подставляет собственное встроенное окно, откуда и берётся классическая формулировка. Для отладки это ключевой момент: сообщение, которое вы видите, целиком формируется на клиенте и из клиентского состояния. О том, что происходящее считает сервер, оно не говорит ничего. Серверная сторона истории находится в журналах.

## Три конечных состояния, и какое из них у вас на самом деле

Начиная с .NET 10 фреймворк вызывает на элементе окна событие `components-reconnect-state-changed` и выставляет соответствующий CSS-класс, так что результат можно прочитать, а не угадывать:

| CSS-класс | `detail.state` события | Значение |
| --- | --- | --- |
| `components-reconnect-show` | `show` | Соединение потеряно, идут повторные попытки. |
| `components-reconnect-retrying` | `retrying` | Попытка переподключения выполняется прямо сейчас. |
| `components-reconnect-paused` | `paused` | Circuit приостановлен (клиентом или сервером). |
| `components-reconnect-hide` | `hide` | Соединение восстановлено. Ничего не потеряно. |
| `components-reconnect-failed` | `failed` | До сервера не достучались. Вызовите `Blazor.reconnect()`. |
| `components-reconnect-rejected` | `rejected` | Сервер достигнут и отказал. Вызовите `location.reload()`. |

В .NET 9 и более ранних версиях доступны только CSS-классы, события нет. В любом случае `failed` и `rejected` образуют развилку диагностики, и общих причин у них почти нет. Прежде чем менять конфигурацию, запишите, какое состояние вы получаете:

```javascript
// .NET 10 or .NET 11, wwwroot or a collocated ReconnectModal.razor.js
const modal = document.getElementById("components-reconnect-modal");
modal.addEventListener("components-reconnect-state-changed", e => {
  console.log("[circuit]", e.detail.state, new Date().toISOString());
});
```

## Минимальное воспроизведение

Ломать приложение не требуется. Достаточно любого компонента в режиме Interactive Server и остановленного процесса:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();
app.Run();
```

Запустите приложение, откройте страницу счётчика, сделайте несколько кликов и остановите процесс через Ctrl+C. Окно появляется примерно через полсекунды. Запустите процесс снова и посмотрите, что произойдёт: соединение устанавливается, но идентификатор circuit новому процессу неизвестен, поэтому вы получаете `rejected`, а не `hide`, и счётчик обнуляется. Сравните это с обрывом сети (DevTools, Network, Offline): попытки никуда не доходят, вы получаете `failed`, а после восстановления сети очередная попытка попадает в исходный circuit с сохранённым значением счётчика, если вы уложились в окно хранения.

Эта разница и есть вся диагностика в миниатюре. `failed` относится к транспорту. `rejected` относится ко времени жизни.

## Исправление 1: привязка сессий, если экземпляров больше одного

Это главная причина в продакшене, и она даёт `rejected` практически при каждом переподключении. Circuit живёт в памяти одного процесса. Переподключение, попавшее на любой другой экземпляр, не находит идентификатор circuit и отказывает. Два сервера за балансировщиком с round-robin означают, что примерно половина переподключений проваливается окончательно, и выглядит это как плавающая проблема, из-за чего она переживает тестирование.

Включите привязку сессий (sticky sessions) на балансировщике: ARR affinity в Azure App Service, `sessionAffinity` в ingress, `ip_hash` или sticky-cookie в nginx. Сопутствующий симптом, который стоит искать в журналах, это `Invocation canceled due to the underlying connection being closed`. Если привязку использовать нельзя, то и держать circuit в памяти между экземплярами не получится, и вам нужно распределённое сохранение из исправления 5.

## Исправление 2: согласуйте график повторов с окном хранения

Сервер хранит отключившийся circuit в течение `DisconnectedCircuitRetentionPeriod`, по умолчанию 3 минуты, и держит не более `DisconnectedCircuitMaxRetained` таких circuit, по умолчанию 100. После этого circuit уничтожается, и любое более позднее переподключение по определению даёт `rejected`.

График на стороне клиента изменился в .NET 9 и теперь регулярно переживает это окно:

- **.NET 8 и более ранние**: `maxRetries: 8`, `retryIntervalMilliseconds: 20000`. Фиксированный интервал в 20 секунд, поэтому клиент сдаётся примерно через 160 секунд, как раз внутри серверных 3 минут.
- **.NET 9, .NET 10, .NET 11**: `maxRetries: 30` с вычисляемой задержкой. Первые 10 попыток идут так быстро, как позволяет handshake, попытки с 11 по 20 разнесены на 5 секунд, а всё последующее выполняется раз в 30 секунд. Это около 350 секунд повторов против circuit, который сервер удалил на 180-й.

Поэтому в .NET 9 и новее пользователь, отошедший на 4 минуты, получает окно, которое продолжает отсчёт, а затем отказывает. Так и задумано, но опыт получается плохой, и эти два числа стоит согласовать. Либо увеличьте срок на сервере:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents(options =>
    {
        options.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(6);
        options.DisconnectedCircuitMaxRetained = 100;
        options.JSInteropDefaultCallTimeout = TimeSpan.FromSeconds(30);
    });
```

либо сократите клиента, чтобы он быстро сдавался и перезагружал страницу, а не делал вид:

```html
<!-- .NET 10 or .NET 11, App.razor. Requires autostart="false" on the Blazor script. -->
<script src="_framework/blazor.web.js" autostart="false"></script>
<script>
  Blazor.start({
    circuit: {
      reconnectionOptions: {
        maxRetries: 8,
        retryIntervalMilliseconds:
          Array.prototype.at.bind([0, 0, 1000, 2000, 5000, 10000, 15000, 30000])
      }
    }
  });
</script>
```

Возврат `null` или `undefined` из `retryIntervalMilliseconds` останавливает повторы, и именно это делает `Array.prototype.at`, когда вы выходите за конец массива. Учтите стоимость памяти, прежде чем поднимать серверное число: каждый удерживаемый circuit это живое дерево компонентов вместе с его сервисами, и 100 таких circuit в нагруженном приложении вполне ощутимы.

## Исправление 3: лимит 32 КБ, когда окно повторяется бесконечно

Если окно появляется снова и снова при обычной работе, особенно сразу после загрузки файла, отправки крупной формы или большой полезной нагрузки JS-интеропа, вы почти наверняка упираетесь в `HubOptions.MaximumReceiveMessageSize` со значением по умолчанию 32 КБ. Превышение закрывает circuit с ошибкой, клиент переподключается, пользователь повторяет действие, и всё закрывается снова.

В консоли браузера видно только общее закрытие:

```text
Error: Connection disconnected with error 'Error: Server returned an error on close: Connection closed with an error.'
```

Настоящее сообщение появляется только при журналировании `Microsoft.AspNetCore.SignalR` на уровне Debug или Trace:

```text
System.IO.InvalidDataException: The maximum message size of 32768B was exceeded.
```

Поднять лимит можно, ценой запаса прочности против отказа в обслуживании:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.MaximumReceiveMessageSize = 64 * 1024;
    });
```

Для действительно больших данных лучше использовать потоковый JS-интероп, который разбивает данные на части ниже лимита вместо его повышения. Оставьте `MaximumParallelInvocationsPerClient` со значением по умолчанию `1`: Blazor на это рассчитывает, а увеличение ломает загрузку файлов через `InputFile`.

У той же проблемы есть второй вариант, который проявляется при первой загрузке, а не при взаимодействии. Если предварительно отрендеренное состояние, передаваемое через `PersistentComponentState`, превышает лимит, circuit вообще не стартует, и в журнале появляется `Circuit host not initialized`. Сохраняйте меньше данных или поднимите лимит.

## Исправление 4: тайм-ауты и прокси, обрывающие простаивающие WebSocket

`failed`, который случается только после простоя, на мобильных устройствах или за обратным прокси, это тайм-аут транспорта. Три числа должны быть согласованы:

```csharp
// .NET 11 preview 6. Program.cs. These are the framework defaults, stated explicitly.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
    });
```

Правило такое: тайм-аут сервера должен быть минимум вдвое больше интервала keep-alive. Увеличиваете одно, увеличивайте и другое. Затем убедитесь, что инфраструктура терпит соединение, простаивающее между keep-alive: `proxy_read_timeout` в nginx, тайм-аут простоя WebSocket в Application Gateway, а также `webSocket enabled="true"` и разумный `pingInterval` в IIS. Прокси, закрывающий соединение на 20-й секунде, будет вечно выдавать окно переподключения каждые 20 секунд, и никакая настройка Blazor это не исправит.

Мобильные браузеры и фоновые вкладки составляют вторую половину этой истории. Придушенная вкладка перестаёт выполнять таймеры, keep-alive прекращается, и сервер сбрасывает circuit. В .NET 9 и новее переподключение выполняется сразу, как только вкладка снова становится видимой, вместо ожидания следующей запланированной попытки, а `ReconnectModal.razor.js` из шаблона .NET 10 после неудачи дополнительно повторяет попытку по `visibilitychange`. Так что обновление версии действительно решает жалобу "вернулся во вкладку, а там всё пропало".

## Исправление 5: в .NET 10 и 11 сохраняйте состояние и перестаньте бороться за circuit

Всё описанное выше пытается сохранить один circuit живым. В .NET 10 появилась возможность отказаться от этого и сохранять вместо него состояние. Пометьте свойства компонентов или сервисов с областью видимости атрибутом `[PersistentState]`, и Blazor сериализует их при вытеснении circuit, а затем восстановит в новом circuit, когда та же вкладка переподключится:

```razor
@* .NET 10 or .NET 11, Counter.razor *@
@page "/counter"
@rendermode InteractiveServer

<p role="status">Current count: @CurrentCount</p>
<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int CurrentCount { get; set; }

    private void IncrementCount() => CurrentCount++;
}
```

Это включено по умолчанию при вызове `AddInteractiveServerComponents`. Провайдер в памяти хранит до 1000 сохранённых circuit в течение двух часов, и оба значения настраиваются:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.Configure<CircuitOptions>(options =>
{
    options.PersistedCircuitInMemoryMaxRetained = 2_000;
    options.PersistedCircuitInMemoryRetentionPeriod = TimeSpan.FromHours(3);
});
```

Для нескольких экземпляров назначьте `HybridCache`, и сохранённое состояние станет распределённым, со своим `PersistedCircuitDistributedRetentionPeriod`, по умолчанию восемь часов. Это запасной выход, когда привязка сессий недоступна:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddHybridCache()
    .AddRedis("{CONNECTION STRING}");

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
```

Ограничения, о которых стоит знать заранее: механизм работает только в режиме Interactive Server, состояние должно сериализоваться в JSON (сущности EF Core с циклами это не переживут), полная перезагрузка страницы его отбрасывает, и гарантии восстановления нет, так что при сбое сохранения приложение возвращается к обычному поведению при обрыве. Используйте `@key` при отрисовке сохраняемых компонентов в цикле.

Тот же механизм обеспечивает приостановку. `Blazor.pauseCircuit()` и `Blazor.resumeCircuit()` позволяют отпустить circuit скрытой вкладки и восстановить его при возвращении, а .NET 11 добавляет серверную сторону через `Circuit.RequestCircuitPauseAsync(CancellationToken)`, так что развёртывание может попросить подключённых клиентов приостановиться и сохранить состояние до остановки процесса вместо того, чтобы выдать каждому пользователю отклонённое переподключение. Клиенты могут отложить это через колбэк `onPauseRequested` в `Blazor.start`.

## Ловушки, ведущие к неправильному исправлению

- **Окно переподключения это не `blazor-error-ui`.** Жёлтая полоса с текстом "An unhandled error has occurred" означает исключение в компоненте, которое тоже разрушает circuit. Если видите оба элемента, сначала исправьте исключение: любое необработанное исключение в компоненте завершает circuit, и следующее переподключение всегда будет `rejected`.
- **Классы получает только первый подходящий элемент.** Если элемент с `id="components-reconnect-modal"` рендерят и layout, и страница, Blazor переключает только тот, который нашёл первым, а второй выглядит сломанным.
- **Задержка в 500 мс сделана намеренно.** Blazor ждёт около половины секунды перед показом окна, чтобы кратковременный сбой не приводил к мельканию интерфейса. Увеличивайте её через CSS, `transition: visibility 0s linear 1000ms`, а не через JavaScript.
- **`Reconnection failed` и `Could not reconnect` это разные состояния.** В первом случае нужно вызывать `Blazor.reconnect()`, во втором обязательно `location.reload()`. Если повесить оба на один обработчик, получится либо бесконечный цикл повторов, либо перезагрузка, выбрасывающая восстановимое состояние.
- **404 или 400 на `_blazor` это не эта проблема.** Так выглядит незамапленная конечная точка хаба или прокси, вырезающий заголовки upgrade, и тогда переподключение не удастся никогда.
- **Случай с забытой вкладкой теперь решается обновлением версии.** Переподключить вкладку двухчасовой давности с одними только circuit в памяти было невозможно. В .NET 10 и новее это возможно, через `[PersistentState]`.

## Похожие статьи

- [Blazor Server против Blazor WebAssembly и Blazor United в .NET 11](/ru/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) разбирает компромисс модели размещения, который вообще приводит вас к circuit.
- [Как сохранять состояние через границу статического и интерактивного рендеринга в Blazor на .NET 11](/ru/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) полностью раскрывает `[PersistentState]` и `PersistentComponentState`.
- [Как использовать HybridCache в ASP.NET Core 11 с Redis в роли кеша L2](/ru/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) настраивает распределённый кеш, на который опирается сохранение circuit между экземплярами.
- [Исправление: JavaScript interop calls cannot be issued at this time (предварительный рендеринг Blazor)](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) это другая ошибка Blazor, возникающая из-за неверного понимания текущего прохода рендеринга.
- [Миграция приложения Blazor Server на Blazor United (Blazor Web App) в .NET 11](/ru/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) это путь к шаблону, который поставляет настраиваемый компонент `ReconnectModal`.

## Источники

- Microsoft Learn, [ASP.NET Core Blazor SignalR guidance](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/signalr?view=aspnetcore-11.0) (CSS-классы переподключения, таблица события `components-reconnect-state-changed`, `MaximumReceiveMessageSize`, тайм-ауты хаба, привязка сессий).
- Microsoft Learn, [ASP.NET Core Blazor server-side state management](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/server?view=aspnetcore-11.0) (значения по умолчанию для сохранения состояния circuit, `PersistedCircuitInMemoryRetentionPeriod`, приостановка и возобновление, `Circuit.RequestCircuitPauseAsync`).
- Microsoft Learn, [CircuitOptions.DisconnectedCircuitRetentionPeriod](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.server.circuitoptions.disconnectedcircuitretentionperiod) (значение по умолчанию в 3 минуты).
- dotnet/aspnetcore, [`CircuitStartOptions.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/CircuitStartOptions.ts) (`maxRetries` равный 30 и ступени 0 мс / 5 с / 30 с в `computeDefaultRetryInterval`; в ветке .NET 8 указаны `maxRetries: 8` и `retryIntervalMilliseconds: 20000`).
- dotnet/aspnetcore, [`DefaultReconnectDisplay.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/DefaultReconnectDisplay.ts) (точные тексты окна для каждого состояния, и в ветке .NET 8, и в текущей).
- dotnet/aspnetcore, [`ReconnectModal.razor.js` в шаблоне Blazor Web App](https://github.com/dotnet/aspnetcore/blob/main/src/ProjectTemplates/Web.ProjectTemplates/content/BlazorWeb-CSharp/BlazorWebCSharp.1/Components/Layout/ReconnectModal.razor.js) (последовательность `Blazor.reconnect()`, затем `Blazor.resumeCircuit()`, затем `location.reload()`, и повтор по `visibilitychange`).

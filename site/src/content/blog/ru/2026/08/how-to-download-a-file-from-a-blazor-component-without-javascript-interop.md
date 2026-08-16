---
title: "Как скачать файл из компонента Blazor без взаимодействия с JavaScript"
description: "Обойдитесь без JS-модуля downloadFileFromStream. Отрисуйте якорь с атрибутом download, указывающий на конечную точку minimal API с TypedResults.File, либо отправьте POST обычной HTML-формой с AntiforgeryToken. Разбираем, почему именно атрибут download мешает улучшенной навигации Blazor перехватить клик, почему data-enhance молча выбрасывает файл, и ловушку с cookie против bearer."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "minimal-apis"
lang: "ru"
translationOf: "2026/08/how-to-download-a-file-from-a-blazor-component-without-javascript-interop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Чтобы скачать файл из компонента Blazor, не написав ни строчки JavaScript, отрисуйте обычный элемент `<a>`, у которого `href` указывает на конечную точку, возвращающую `TypedResults.File`, а атрибут `download` присутствует. В этом весь приём. Атрибут `download` не просто подсказка имени файла: это флаг, из-за которого улучшенная навигация Blazor пропускает клик и позволяет браузеру выполнить настоящий переход, а заголовок `Content-Disposition: attachment` затем превращает его в сохранение. Для файлов, содержимое которых зависит от ввода пользователя, отправляйте POST обычной HTML-формой `<form>` с `<AntiforgeryToken />` на такую же конечную точку. Всё изложенное ниже рассчитано на .NET 11 и C# 14 и проверено от начала до конца на Blazor Web App поверх ASP.NET Core 10.0.5, где поведение идентично. API не менялись со времён .NET 8.

## Почему официальное руководство тянется к JS-интеропу и когда его можно игнорировать

[Документация по загрузке файлов в Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) предлагает два рецепта, и оба начинаются с указания добавить файл `.js`. Рецепт для небольших файлов оборачивает `Stream` в `DotNetStreamReference`, отправляет его в JS-функцию `downloadFileFromStream` и заново собирает из него `Blob` и object URL на клиенте. Рецепт для крупных файлов вызывает JS-функцию `triggerFileDownload`, которая создаёт `HTMLAnchorElement` в скрипте и вызывает на нём синтетический `click`.

Перечитайте второй пункт. JavaScript существует ради того, чтобы создать элемент-якорь и кликнуть по нему. Вы находитесь в UI-фреймворке, вся работа которого состоит в отрисовке HTML-элементов. Якорь вы можете отрисовать сами.

Путь без JS не только короче по коду, он обходит целый класс ошибок, в который путь через интероп заходит прямиком. `IJSRuntime` недоступен, пока компонент находится в предварительной отрисовке, и именно поэтому [вызовы взаимодействия с JavaScript не могут быть выполнены в данный момент](/ru/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) остаётся одним из самых частых исключений Blazor. Он также недоступен в компонентах со статической серверной отрисовкой (static SSR), потому что там нет ни цепи, ни среды выполнения WebAssembly, к которой можно обратиться. Якорь работает в любом режиме отрисовки, включая static SSR, и без каких-либо правил жизненного цикла.

Есть ровно один сценарий, где интероп действительно нужен: автономное приложение Blazor WebAssembly, которое формирует байты на клиенте и должно сохранить их без обращения к серверу. Но и там URI вида `data:` покрывает почти всё, а ограничения я разбираю в конце.

## Атрибут download не даёт Blazor съесть ваш клик

Это та часть, которую никто не объясняет, и именно из-за неё совет "просто используйте якорь" так часто не срабатывает в Blazor Web App.

Blazor Web Apps включают улучшенную навигацию по умолчанию. Обработчик кликов на уровне документа перехватывает внутренние ссылки, забирает адресат через `fetch` и вносит полученный HTML в существующий DOM вместо полной перезагрузки страницы. Для страниц это отлично, для CSV катастрофично.

Защитное условие перехватчика видно в поставляемом `blazor.web.js`:

```js
return (!t || "_self" === t) && e.hasAttribute("href") && !e.hasAttribute("download")
```

Якорь становится кандидатом на перехват, только если у него есть `href` и **нет** атрибута `download`. Атрибут представляет собой намеренный отказ от перехвата, заложенный в сам фреймворк.

Опустите его, и вот что произойдёт на самом деле, по измерениям в браузере на работающем приложении. Клик по `<a href="/exports/orders.csv">` даёт:

```text
[warn] Enhanced navigation failed for destination http://localhost:5248/exports/orders.csv.
       Falling back to full page load.
```

Адресная строка меняется на `/exports/orders.csv?` вместе с лишним знаком вопроса, а в DOM по-прежнему показана предыдущая страница. Журнал сети показывает **два** обращения к конечной точке: сначала через `fetch` улучшенной навигации, которая не смогла разобраться с `text/csv`, затем через резервный переход документа, который браузер в итоге передаёт менеджеру загрузок. Ваш экспортный запрос выполняется дважды, URL у пользователя неверный, а файл всё равно приходит, и это худшее из возможных сочетаний, потому что выглядит как рабочее.

Добавьте `download`, и ничего из этого не случится. Клик не перехватывается, URL не меняется, уходит один запрос и возвращается один файл.

## Шаги для настройки загрузки без JS

1. **Напишите конечную точку, которая возвращает файл.** `MapGet` в minimal API, возвращающий `TypedResults.File`, `TypedResults.Bytes` или `TypedResults.Stream`, сам выставляет `Content-Disposition: attachment`, когда вы передаёте `fileDownloadName`.
2. **Отрисуйте якорь на неё, с присутствующим атрибутом `download`.** Не опускайте его даже тогда, когда конечная точка уже выставляет `Content-Disposition`.
3. **Для экспорта с параметрами используйте обычную `<form method="post">`**, нацеленную на конечную точку, с `<AntiforgeryToken />` внутри и без атрибута `data-enhance`.
4. **Убедитесь, что конечная точка проходит аутентификацию так же, как переход браузера**, то есть через cookie, а не через заголовок `Authorization`.
5. **Проверяйте заголовки ответа**, а не диалог сохранения в браузере. `curl -I` по конечной точке должен показать `Content-Disposition: attachment` и ожидаемое имя файла.

## Конечная точка: три формы TypedResults

Для содержимого, которое и так помещается в память, передайте конечной точке `byte[]`:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders.csv", () =>
{
    var csv = new StringBuilder("Id,Customer,Total\n");
    foreach (var order in OrderStore.Recent())
    {
        csv.Append(CultureInfo.InvariantCulture, $"{order.Id},{order.Customer},{order.Total}\n");
    }

    return TypedResults.File(
        Encoding.UTF8.GetBytes(csv.ToString()),
        contentType: "text/csv",
        fileDownloadName: "orders.csv");
});
```

Это даёт ровно те заголовки, которые нужны браузеру:

```text
HTTP/1.1 200 OK
Content-Length: 75
Content-Type: text/csv
Content-Disposition: attachment; filename=orders.csv; filename*=UTF-8''orders.csv
```

Обратите внимание на удвоенные параметры `filename` и `filename*`. ASP.NET Core выдаёт форму по RFC 6266 автоматически, и именно это позволяет именам файлов не из ASCII пережить передачу.

Для всего достаточно крупного, чтобы буферизация стала риском по памяти, используйте `TypedResults.Stream` с обратным вызовом и пишите прямо в тело ответа:

```csharp
// .NET 11, C# 14
app.MapGet("/exports/orders-stream.csv", (IOrderQuery query, CancellationToken ct) =>
    TypedResults.Stream(
        async stream =>
        {
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true);
            await writer.WriteLineAsync("Id,Customer,Total");

            await foreach (var order in query.StreamAsync(ct))
            {
                await writer.WriteLineAsync($"{order.Id},{order.Customer},{order.Total}");
            }
        },
        contentType: "text/csv",
        fileDownloadName: "orders-stream.csv"));
```

Такой ответ идёт с `Transfer-Encoding: chunked` и без `Content-Length`, так что индикатора прогресса пользователь не увидит, зато сервер никогда не держит весь экспорт целиком. Тот же компромисс возникает всякий раз, когда нужно [передать файл из конечной точки ASP.NET Core без буферизации](/ru/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

`new UTF8Encoding(false)` здесь не случаен. У `StreamWriter` кодировка `Encoding.UTF8` по умолчанию включает преамбулу BOM, поэтому сокращённый вариант пишет три лишних байта перед строкой заголовков. В тестовом приложении я на это наткнулся: конечная точка с `byte[]` выдала чистый вывод, потому что `Encoding.UTF8.GetBytes` преамбулу не пишет, а потоковая конечная точка добавила BOM перед `Id,Customer,Total`. Для CSV, открываемого в Excel, эта BOM как раз и нужна, так что выбирайте по формату, а не случайно.

Если файл уже лежит на диске, пропустите буфер целиком: `TypedResults.File(File.OpenRead(path), "application/pdf", "manual.pdf", enableRangeProcessing: true)`. Обработка диапазонов позволяет браузеру возобновить прерванную загрузку.

## Static SSR: якорь и обычная форма, цепь не нужна

Вот компонент со static SSR, без режима отрисовки, без `@onclick`, который скачивает два разных файла:

```razor
@* .NET 11, static SSR, no render mode *@
@page "/exports"

<h1>Exports</h1>

<a href="/exports/orders.csv" download>Download today's orders</a>

<a href="/exports/orders.csv" download="orders-2026-08.csv">Download with a custom name</a>

<form method="post" action="/exports/orders">
    <AntiforgeryToken />
    <label>
        Rows
        <input type="number" name="maxRows" value="500" />
    </label>
    <input type="hidden" name="format" value="csv" />
    <button type="submit">Export</button>
</form>
```

Второй якорь показывает единственное, что атрибут `download` делает помимо отказа от улучшенной навигации: его значение переопределяет предложенное сервером имя файла. Оставляйте его пустым, когда `fileDownloadName` у конечной точки и так верен.

Форма здесь обычная HTML-`<form>` с `action`, а не `EditForm`, и в ней нет ни `@formname`, ни `@onsubmit`. Это сделано намеренно. `EditForm` отправляет данные обратно в компонент Blazor, а работа компонента состоит в отрисовке HTML, поэтому вернуть файл он не может. Отправка на отдельную конечную точку остаётся единственным путём, который заканчивается загрузкой.

`<AntiforgeryToken />` отрисовывает скрытое поле `__RequestVerificationToken`. Оно обязательно, потому что конечная точка minimal API, привязывающая параметры `[FromForm]`, подпадает под проверку antiforgery начиная с .NET 8. Отправьте без токена и получите голый `400`:

```csharp
// .NET 11, C# 14
app.MapPost("/exports/orders", ([FromForm] string format, [FromForm] int maxRows) =>
{
    var bytes = ExportBuilder.Build(format, maxRows);

    return TypedResults.File(bytes, "text/csv", $"orders.{format}");
});
```

С `app.UseAntiforgery()` в конвейере и токеном в форме это отдаёт файл прямо в браузер. Без цепи, без нагрузки WebAssembly, без JavaScript.

.NET 11 добавляет здесь второй слой. Автоматическая защита от CSRF на основе заголовков включена по умолчанию в приложениях, собранных через `WebApplication.CreateBuilder`: она проверяет `Sec-Fetch-Site` и `Origin` у небезопасных методов, а отправки форм Blazor SSR возвращают `400 Bad Request` для недоверенных межсайтовых отправок. Проверка токена по-прежнему выполняется только при вызове `UseAntiforgery`, и когда работают оба механизма, вердикт токена оказывается решающим. Если форма, работавшая на .NET 10, после обновления начала отдавать 400, начинайте разбор именно с этой middleware. Её поведение я подробно разбирал, когда [ASP.NET Core 11 включил автоматическую защиту от CSRF](/ru/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/).

## Интерактивные режимы отрисовки: отдайте клиенту URL, а не байты

В интерактивном компоненте первым делом хочется заставить обработчик кнопки сформировать `byte[]`, а потом искать способ протолкнуть его в браузер. Переверните задачу. Пусть обработчик подготовит экспорт на сервере, спрячет его за токеном и отрисует якорь:

```razor
@* .NET 11, C# 14 *@
@page "/reports"
@rendermode InteractiveServer
@inject IReportService Reports

<button @onclick="Prepare" disabled="@_working">Prepare export</button>

@if (_token is not null)
{
    <a href="@($"/exports/report/{_token}")" download="report.csv">Your export is ready</a>
}

@code {
    private string? _token;
    private bool _working;

    private async Task Prepare()
    {
        _working = true;
        _token = await Reports.QueueExportAsync();
        _working = false;
    }
}
```

Пользователь кликает дважды, что для экспорта, который и так занимает реальное время, честнее с точки зрения интерфейса, а байты никогда не идут по цепи SignalR.

Если один клик принципиален, `NavigationManager.NavigateTo(url, forceLoad: true)` работает и по-прежнему не требует вашего кода интеропа. Поскольку ответ несёт `Content-Disposition: attachment`, браузер начинает загрузку и отказывается от перехода. Я проверил, что URL SPA после этого не меняется: до вызова был `/interactive` и после вызова `/interactive`, а файл доставлен.

```csharp
// .NET 11, C# 14
private void Download() => Nav.NavigateTo("/exports/orders-stream.csv", forceLoad: true);
```

Оговорка в том, что это переход, поэтому если конечная точка вернёт `404` или `500` вместо файла, браузер уведёт пользователя из приложения на страницу ошибки. Якорь ломается так же, но по крайней мере пользователь сам выбрал кликнуть.

## Blazor WebAssembly без сервера: запасной выход через data URI

Когда байты формируются на клиенте и указывать не на что, закодируйте их в base64 прямо в `href`:

```razor
@* .NET 11, C# 14, Blazor WebAssembly *@
@rendermode InteractiveWebAssembly

<button @onclick="Build">Build report</button>

@if (_href is not null)
{
    <a href="@_href" download="client-report.csv">Save client-report.csv</a>
}

@code {
    private string? _href;

    private void Build()
    {
        var bytes = Encoding.UTF8.GetBytes(ReportBuilder.ToCsv());
        _href = $"data:text/csv;base64,{Convert.ToBase64String(bytes)}";
    }
}
```

Chrome блокирует переход верхнего уровня на URI `data:`, но явно делает исключение для якорей с атрибутом `download`, так что приём выживает. Я проверил, что отрисованный якорь сохраняет `download="client-report.csv"` в DOM в целости после гидратации WebAssembly.

Два ограничения не дают считать это универсальным ответом. Base64 раздувает полезную нагрузку примерно на треть, и всё это лежит в атрибуте DOM, поэтому экспорт на 30 МБ превращается в строку на 40 МБ внутри дерева отрисовки. К тому же браузеры расходятся в предельных значениях: Chrome и Edge в некоторых контекстах `data:` вводят потолок в 2 МБ, тогда как Firefox и Safari не документируют никакого. Примерно до мегабайта это нормально. Дальше добавляйте серверную конечную точку или принимайте, что вам нужны `Blob` и `URL.createObjectURL`, а это и есть интероп.

## Подводные камни, которые действительно вас достанут

**`data-enhance` на форме молча выбрасывает ваш файл.** Улучшенная обработка форм отправляет данные через `fetch` и отказывается общаться с чем-либо, кроме конечной точки Blazor. Добавление `data-enhance` к форме экспорта выше дало в консоли вот это:

```text
Enhanced navigation does not support making a non-GET request to a non-Blazor endpoint.
Avoid enabling enhanced navigation for forms that post to a non-Blazor endpoint.
```

Вкладка сети показала `POST` с кодом `200` и полным телом CSV. Сервер собрал экспорт, отдал его, а клиент выбросил. Ничего не скачалось. `EditForm` с `Enhance` ломается точно так же.

**Токены bearer не переживают переход.** Клик по якорю и отправка формы представляют собой запросы, инициированные браузером. Заголовка `Authorization` нет, потому что нет вашего кода, который бы его прикрепил. Если ваш API аутентифицируется по JWT, хранящимся в памяти, конечная точка загрузки вернёт `401` при какой угодно правильной разметке. Либо выдайте именно этой конечной точке аутентификацию по cookie, либо выпускайте короткоживущий одноразовый токен и кладите его в путь, как в интерактивном примере. [Сравнение аутентификации по JWT и по cookie](/ru/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) стоит прочитать до выбора, потому что это настоящая архитектурная развилка, а не обходной путь.

**Атрибут `download` игнорируется между источниками.** Начиная с Chrome 65 подсказка имени файла молча отбрасывается для межсайтовых URL, а Firefox игнорирует атрибут полностью и вместо загрузки переходит по ссылке. Если ваши файлы живут на CDN или на отдельном хосте API, атрибут перестаёт быть определяющим, и единственным, что запускает сохранение, становится `Content-Disposition: attachment`, выставленный сервером-источником. Настройте его там.

**Статическим ресурсам атрибут тоже нужен.** `<a href="/docs/manual.pdf" download>` работает для файлов в `wwwroot`, но без `download` перехват улучшенной навигацией распространяется и на них, а PDF как раз тот тип ответа, на котором улучшенная навигация сдаётся на полпути.

**Не пытайтесь писать ответ из компонента.** Взять каскадный `HttpContext` в компоненте со static SSR и писать байты в `Response.Body` значит бороться с отрисовщиком и прийти к [заголовки доступны только для чтения, отправка ответа уже началась](/ru/2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore/). Компоненты отрисовывают разметку. Конечные точки возвращают файлы. Соблюдайте это разделение.

Правило, которое вытекает из всего этого, достаточно короткое, чтобы его запомнить: браузер уже умеет скачивать файлы, а Blazor уже умеет отрисовывать якоря. Единственное, что стоит между ними, это атрибут, который фреймворк явным образом проверяет.

## Источники

- [ASP.NET Core Blazor file downloads](https://learn.microsoft.com/en-us/aspnet/core/blazor/file-downloads) на Microsoft Learn, о рецептах на основе интеропа, которые эта статья заменяет
- [ASP.NET Core Blazor forms overview](https://learn.microsoft.com/en-us/aspnet/core/blazor/forms/) о компоненте `AntiforgeryToken`, улучшенной обработке форм и автоматической CSRF-middleware в .NET 11
- [Breaking change: IFormFile parameters require anti-forgery checks](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/8/antiforgery-checks) о том, почему привязке `[FromForm]` нужен токен
- [Deprecations and removals in Chrome 65](https://developer.chrome.com/blog/chrome-65-deprecations) об ограничении атрибута `download` между источниками
- Поведение подтверждено на приложении `dotnet new blazor -int Auto` поверх ASP.NET Core 10.0.5 с разбором `blazor.web.js`, заголовков ответа и консоли браузера

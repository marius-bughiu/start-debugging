---
title: "Как пробросить CancellationToken через асинхронные методы в .NET 11"
description: "Проведите CancellationToken чисто через каждый слой асинхронной цепочки вызовов в .NET 11: соглашение о последнем параметре, значения по умолчанию, связанные токены, RequestAborted в ASP.NET Core и анализатор CA2016, который находит забытые."
pubDate: 2026-07-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "ru"
translationOf: "2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-01
---

Отмена в .NET работает только тогда, когда токен доходит до кода, который выполняет блокировку. `CancellationToken`, который вы создаёте в начале запроса, но никогда не передаёте в `HttpClient.GetAsync`, `DbContext.SaveChangesAsync` или вызов `Stream.ReadAsync`, это мёртвый груз: внешняя операция всё равно выполняется до конца, потому что ниже по цепочке никто её не слушает. Пробросить токен означает провести этот единственный параметр через каждый асинхронный метод между местом, где запрашивается отмена, и местом, где работа действительно происходит. Этот пост охватывает механические правила в .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): куда идёт параметр, каким должно быть его значение по умолчанию, как комбинировать токены, как ASP.NET Core выдаёт вам его бесплатно и как анализатор `CA2016` находит вызовы, которые вы забыли передать дальше. Все примеры компилируются под .NET 11.

## Почему токен, который не путешествует, бесполезен

Отмена в .NET кооперативна. Нет никакого `Task.Kill()`, и среда выполнения никогда не прерывает поток по своей инициативе. `CancellationToken` это всего лишь сигнал, который переходит из состояния "не запрошено" в "запрошено", когда кто-то вызывает `Cancel()` на владеющем `CancellationTokenSource`. Код реагирует на это изменение только если он либо проверяет `token.IsCancellationRequested`, либо вызывает `token.ThrowIfCancellationRequested()`, либо передаёт токен в API фреймворка, который выполняет эти проверки внутри. Если токен никогда не доходит до блокирующего вызова, блокирующий вызов не может знать, что ему следует остановиться.

Это и есть вся причина, почему проброс важен. Рассмотрим эту цепочку:

```csharp
// .NET 11, C# 14 -- broken: the token stops at the top
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync();          // no token -- runs to completion
    var enriched = await EnrichAsync(rows);    // no token -- runs to completion
    return Assemble(enriched);
}
```

Вы можете вызывать `Cancel()` весь день. `LoadRowsAsync` и `EnrichAsync` никогда не видят сигнала, поэтому `BuildReportAsync` завершает всю свою работу прежде, чем `catch (OperationCanceledException)` в месте вызова вообще получит шанс сработать. Решение это не хитрый код, а дисциплина: токен должен быть параметром в каждом методе на пути, и каждый вызов должен передавать его дальше.

```csharp
// .NET 11, C# 14 -- correct: the token reaches the leaves
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync(ct);
    var enriched = await EnrichAsync(rows, ct);
    return Assemble(enriched);
}
```

## Сквозная процедура проброса

Вот последовательность, чтобы провести токен от точки входа до вызова ввода-вывода. Каждый шаг это правило, которое вы применяете механически.

1. **Принимайте токен как последний параметр.** Дайте каждому асинхронному методу в цепочке параметр `CancellationToken` и поставьте его последним, чтобы он читался единообразно во всём вашем коде и совпадал с сигнатурами самого фреймворка.
2. **Именуйте его единообразно.** Используйте `cancellationToken` в публичных API библиотек (это соглашение BCL) или `ct` во внутреннем коде приложения. Выберите одно и придерживайтесь его, чтобы проброс можно было найти через grep.
3. **Передавайте его в каждый ожидаемый вызов, который его принимает.** Если метод, который вы вызываете, имеет перегрузку или параметр `CancellationToken`, передайте ему ваш токен. Не передавайте `CancellationToken.None` "на всякий случай": это молча заставляет вызов отказаться от отмены.
4. **Давайте значение по умолчанию только в настоящих точках входа.** Методы, ориентированные на библиотеку, используют `CancellationToken cancellationToken = default`, чтобы вызывающие, которым он не нужен, могли его опустить. Внутренние методы, которые всегда имеют токен, не должны получать значение по умолчанию, чтобы отсутствующий аргумент был напоминанием во время компиляции.
5. **Комбинируйте токены, когда добавляете собственный срок.** Если методу нужен собственный тайм-аут поверх токена вызывающего, свяжите их с помощью `CancellationTokenSource.CreateLinkedTokenSource`, а не выбирайте один и отбрасывайте другой.
6. **Включите `CA2016`.** Позвольте анализатору отметить вызовы, которые вы пропустили на шагах с 3 по 5.

Остальная часть этого поста раскрывает те части этого списка, у которых есть реальные нюансы.

## Куда идёт параметр и как его называть

Соглашение по всей BCL таково: `CancellationToken` это **последний** параметр, и он называется `cancellationToken`. Посмотрите на любой современный асинхронный API, и вы увидите форму:

```csharp
// From the BCL, for reference
Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken);
Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
Task<HttpResponseMessage> GetAsync(string requestUri, CancellationToken cancellationToken);
```

Повторяйте это в своём собственном коде. Две причины, почему это не просто косметика:

- **Анализатор `CA2016` опирается на позицию последнего параметра.** Он смотрит на метод, который принимает `CancellationToken` как последний параметр, а затем проверяет, передают ли его вызовы внутри дальше. Поставьте токен в середину, и вы ослабите инструменты, которые должны ловить ваши ошибки.
- **Необязательные параметры в любом случае должны идти последними.** Когда вы даёте токену значение по умолчанию (`= default`), C# заставляет его стоять после всех обязательных параметров, так что правило последнего параметра следует из правил языка бесплатно.

Что касается имени, разделение таково: `cancellationToken` для всего публичного или библиотечного (побеждает единообразие с BCL); `ct` приемлемо и распространено во внутреннем коде приложения, где краткость помогает читаемости длинных цепочек вызовов. Важно, чтобы это было одно имя, чтобы читатель, просматривающий метод, мгновенно видел, передаётся токен дальше или отбрасывается.

## `default`, `CancellationToken.None` и когда вообще давать значение по умолчанию

`default(CancellationToken)` и `CancellationToken.None` это одно и то же значение: токен, который никогда не может быть отменён. `IsCancellationRequested` всегда `false`, а `CanBeCanceled` это `false`. Они различаются только сигнализацией намерения, и язык даёт вам `= default` как идиоматичную форму необязательного параметра:

```csharp
// .NET 11, C# 14
public async Task<User> GetUserAsync(int id, CancellationToken cancellationToken = default)
{
    return await _db.Users.FindAsync([id], cancellationToken)
        ?? throw new KeyNotFoundException();
}
```

Решение, на котором люди спотыкаются, это **давать ли параметру значение по умолчанию вообще**. Правило, которое держит вас честным:

- **Публичные / библиотечные методы: давайте значение по умолчанию.** Вызывающие, у которых действительно нет токена (`Main` консоли верхнего уровня, путь "запустил и забыл"), могут его опустить, и метод всё равно скомпилируется. Именно поэтому каждый асинхронный метод BCL даёт токену значение по умолчанию.
- **Внутренние методы, которые всегда выполняются под токеном: не давайте значение по умолчанию.** Если `BuildReportAsync` вызывается только из обработчика запросов, у которого есть токен, оставление параметра без значения по умолчанию означает, что компилятор возмущается в тот момент, когда кто-то вызывает его без проброса токена. Эта ошибка компиляции это функция. Дать ему значение по умолчанию там означало бы пропустить отброшенный токен как молчаливый `CancellationToken.None`.

Антипаттерн, которого следует избегать, это обращение к `CancellationToken.None` внутри метода, у которого уже есть настоящий токен в области видимости. Это не "безопасно", это утечка отмены, замаскированная под осторожность.

```csharp
// .NET 11, C# 14 -- wrong: leaks cancellation on purpose
public async Task ProcessAsync(CancellationToken ct)
{
    // ct is right there, and we throw it away
    await _client.PostAsync(url, content, CancellationToken.None);
}
```

Единственное законное применение `CancellationToken.None` это вызов, который вы намеренно хотите выполнить до конца, даже если внешняя операция отменена, например, запись финальной аудиторской записи или освобождение ресурса. Сделайте это намерение очевидным с помощью комментария, потому что иначе рецензент прочтёт это как баг.

## Комбинирование токена вызывающего с собственным тайм-аутом

Распространённая реальная ситуация: метод получает `CancellationToken` вызывающего, но также нуждается в собственном тайм-ауте ("сдайся на этом нижестоящем вызове через 5 секунд"). Не выбирайте один и не игнорируйте другой. Свяжите их, чтобы отмена из **любого** из источников остановила работу. `CancellationTokenSource.CreateLinkedTokenSource` создаёт источник, чей токен срабатывает, когда срабатывает любой из его родительских токенов:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithTimeoutAsync(
    string url,
    CancellationToken cancellationToken)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
        cancellationToken, timeoutCts.Token);

    try
    {
        return await _client.GetStringAsync(url, linkedCts.Token);
    }
    catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested
                                             && !cancellationToken.IsCancellationRequested)
    {
        // Distinguish "we timed out" from "the caller cancelled us"
        throw new TimeoutException($"GET {url} exceeded 5s");
    }
}
```

Две детали делают это правильным:

- **Освобождайте связанный источник.** `CreateLinkedTokenSource` регистрирует обратные вызовы на своих родителях; не освободить его означает утечку этих регистраций на всё время жизни самого долгоживущего родительского токена. `using` берёт это на себя.
- **Фильтр `when` разделяет две причины отмены.** Когда токен срабатывает, вы в любом случае получаете `OperationCanceledException`. Проверка `timeoutCts.IsCancellationRequested` против `cancellationToken.IsCancellationRequested` сообщает, какой источник сработал, так что инициированная вызывающим отмена распространяется как есть, а тайм-аут всплывает как `TimeoutException`. Это та же дисциплина, что нужна при [отмене долго выполняющейся Task без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

Если вам нужен только тайм-аут и нет входящего токена, `CancelAfter` на одном источнике проще, чем связанный. Прибегайте к связыванию именно тогда, когда и токен вызывающего, и локальный срок оба должны победить.

## ASP.NET Core выдаёт вам токен: используйте его

В веб-приложении вы редко создаёте токен вершины цепочки сами. ASP.NET Core предоставляет `HttpContext.RequestAborted`, `CancellationToken`, который срабатывает, когда клиент отключается или сервер прерывает запрос. И минимальные API, и MVC-контроллеры связывают его автоматически: объявите параметр `CancellationToken`, и фреймворк заполнит его из `RequestAborted`.

```csharp
// .NET 11, C# 14 -- minimal API
app.MapGet("/reports/{id}", async (
    int id,
    ReportService reports,
    CancellationToken cancellationToken) =>
{
    var report = await reports.BuildAsync(id, cancellationToken);
    return Results.Ok(report);
});
```

```csharp
// .NET 11, C# 14 -- MVC controller
[HttpGet("reports/{id}")]
public async Task<IActionResult> Get(int id, CancellationToken cancellationToken)
{
    var report = await _reports.BuildAsync(id, cancellationToken);
    return Ok(report);
}
```

Этот внедрённый токен это точка входа для всей цепочки проброса. Передайте его в `BuildAsync`, который передаёт его в свои запросы EF Core и вызовы `HttpClient`, и клиент, закрывающий вкладку браузера, теперь останавливает всю эту нижестоящую работу вместо того, чтобы платить за запрос, который никто не прочитает. Ожидаемое поведение: когда `RequestAborted` срабатывает в середине запроса, ваши await бросают `OperationCanceledException` (или её подкласс `TaskCanceledException`), которую фреймворк трактует как отменённый запрос, а не как 500. Если вы видите это исключение в логах `HttpClient`, это часто именно то, что работает как задумано; см. [почему TaskCanceledException всплывает из HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) для различия между тайм-аутом и отменой.

Одна оговорка, специфичная для фоновой работы: `RequestAborted` ограничен запросом. Если обработчик запроса запускает работу, которая должна пережить ответ, не давайте ей `RequestAborted`: она будет отменена в тот момент, когда ответ завершится. Эта работа принадлежит размещённому сервису с собственным временем жизни, что является паттерном за [безопасным выполнением работы "запустил и забыл" с помощью BackgroundService](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Проброс через потоковую передачу и `IAsyncEnumerable<T>`

Асинхронным потокам нужно, чтобы токен был проведён через итератор, и механизм слегка отличается, потому что токен во время перечисления поставляет потребитель, а не производитель. Производитель помечает параметр атрибутом `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
public async IAsyncEnumerable<Row> ReadRowsAsync(
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    await using var reader = await _source.OpenAsync(cancellationToken);
    while (await reader.ReadAsync(cancellationToken))
    {
        yield return reader.Current;
    }
}
```

Потребитель прикрепляет токен через `WithCancellation`, и компилятор направляет его в параметр `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
await foreach (var row in ReadRowsAsync().WithCancellation(cancellationToken))
{
    Process(row);
}
```

Без `[EnumeratorCancellation]` токен из `WithCancellation` молча игнорируется, и перечисление нельзя отменить: тонкий разрыв проброса, который анализатор `CA2016` не всегда ловит. Если вы новичок в асинхронных потоках, обзор [когда обращаться к IAsyncEnumerable](/ru/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) охватывает более широкую картину.

## Позвольте `CA2016` ловить те, что вы отбрасываете

Провести токен вручную через глубокую цепочку вызовов это именно тот тип задачи, где вы пропустите вызов. Анализатор `CA2016` ("Передайте параметр CancellationToken в методы, которые его принимают") создан для этого: он проверяет метод, у которого есть `CancellationToken` как последний параметр, а затем отмечает любой вызов внутри, который мог бы принять токен, напрямую или через перегрузку, но не делает этого. Превратите его в ошибку сборки, чтобы отброшенный токен падал в CI, а не отправлялся:

```xml
<!-- .editorconfig -- .NET 11 -->
[*.cs]
dotnet_diagnostic.CA2016.severity = error
```

`CA2016` поставляется с анализаторами .NET SDK, которые включены по умолчанию для проектов, нацеленных на .NET 11, так что вам нужно только поднять уровень серьёзности. Он идёт с исправлением кода, так что в Visual Studio или с `dotnet format analyzers` вы можете автоматически передать токен по всему файлу. Чего он не сделает, так это не изобретёт токен там, где у охватывающего метода его нет: это случай для того, чтобы сделать параметр необязательным во внутренних методах, чтобы компилятор заставил вас добавить его.

Замечание о слепых зонах `CA2016`: он опирается на соглашение о последнем параметре и на наличие подходящей перегрузки. Он не отметит вызов, который принимает токен не в последней позиции, и он не рассуждает о маршрутизации `[EnumeratorCancellation]`. Относитесь к нему как к сильной сети для распространённого случая, а не как к доказательству того, что каждый путь покрыт.

## Ошибки проброса, которые мешают токенам работать

Несколько паттернов ломают проброс, даже когда токен технически присутствует:

- **Новый источник на каждый вызов.** Создание `new CancellationTokenSource()` внутри метода и передача *его* токена полностью игнорирует токен вызывающего. Связывайте, а не заменяйте.
- **`async void`.** Токен не может распространиться наружу из метода `async void`, потому что нет `Task`, которую вызывающий мог бы ожидать или на которой наблюдать `OperationCanceledException`. Держите пути отмены на `async Task`: причины сильно пересекаются с [тем, почему async void почти всегда неправилен](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).
- **Проглатывание `OperationCanceledException`.** Перехват её и возврат значения по умолчанию скрывает отмену от вызывающих, так что внешний `Task.WhenAll` или await никогда не узнаёт, что операция остановилась. Позвольте ей всплыть, если только у вас нет конкретной причины транслировать её (как в случае с тайм-аутом выше).
- **Забытый синхронный лист.** У плотного CPU-цикла в самом низу асинхронной цепочки нет ожидаемого API, которому можно передать токен. Добавьте явный `cancellationToken.ThrowIfCancellationRequested()` внутри цикла, чтобы у токена всё же была контрольная точка.

Проброс это не функция, которую вы включаете; это свойство, которое вы поддерживаете. Каждый новый асинхронный метод это ещё одно звено, которое либо передаёт токен дальше, либо молча разрывает цепочку. Добавьте параметр, передавайте его при каждом вызове, позвольте `CA2016` охранять вызовы, которые вы забываете, и приберегите `CancellationToken.None` для той редкой операции, которую вы действительно хотите завершить во что бы то ни стало.

## Источники

- [CA2016: Forward the CancellationToken parameter to methods that take one](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2016) -- Microsoft Learn
- [HttpContext.RequestAborted Property](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpcontext.requestaborted) -- Microsoft Learn
- [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) -- Microsoft Learn
- [CancellationTokenSource.CreateLinkedTokenSource](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.createlinkedtokensource) -- Microsoft Learn
- [EnumeratorCancellationAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute) -- Microsoft Learn
</content>
</invoke>

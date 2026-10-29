---
title: "MudBlazor 9.12: медленные ServerData и поиск в Autocomplete больше не перезаписывают более новые результаты"
description: "MudBlazor 9.12.0 исправляет давнюю гонку в MudAutocomplete, MudDataGrid и MudTable: побеждал результат поиска, завершившегося последним, а не запущенного последним. Разбираем, как работает исправление и что меняется в вашем коде ServerData и SearchFunc."
pubDate: 2026-10-29
tags:
  - "blazor"
  - "mudblazor"
  - "aspnet-core"
  - "dotnet"
  - "async"
lang: "ru"
translationOf: "2026/10/mudblazor-9-12-ignores-stale-serverdata-and-autocomplete-results"
translatedBy: "claude"
translationDate: 2026-10-29
---

[MudBlazor 9.12.0](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0) вышел 29 октября 2026 года, и главная причина обновиться: состояние гонки, которое в том или ином виде было открыто со времён [issue #3722](https://github.com/MudBlazor/MudBlazor/issues/3722). `MudAutocomplete`, `MudDataGrid` с `ServerData` и `MudTable` с `ServerData` сохраняли результат запроса, который *завершился* последним, а не того, который пользователь *запустил* последним.

## Почему обычно побеждает широкий поиск

Введите "App" в автодополнение, подождите дольше задержки debounce, затем продолжите вводить "le Pie". Теперь в работе два поиска. Короткий запрос находит больше строк, поэтому обычно он и медленнее. В 9.11 и ранее сначала отображаются результаты для "Apple Pie", затем приходят результаты для "App" и заменяют их. Пользователь видит список, который не соответствует тексту в поле ввода.

То же происходило с фильтрами и пагинацией в таблице: достаточно быстро дважды изменить фильтр, и более старый, медленный вызов `ServerData` мог перезаписать более новую страницу.

## Как 9.12 определяет устаревший результат

[PR #13944](https://github.com/MudBlazor/MudBlazor/pull/13944) использует две разные стратегии. В `MudAutocomplete` каждому поиску присваивается номер версии, а поиск, замещённый более новым, завершается до того, как затронет элементы, счётчик возвращённых элементов или popover:

```csharp
var searchVersion = ++_searchVersion;
// ... await SearchFunc(text, token) ...
if (searchVersion != _searchVersion)
{
    return;
}
```

Проверка выполняется дважды, второй раз после `ReturnedItemsCountChanged`, потому что ваш обработчик может уступить управление, и за это время успеет завершиться более новый поиск. Это важно, поскольку многие реализации `SearchFunc` полностью игнорируют `CancellationToken`, так что одной отменой это не исправить.

`MudDataGrid` использует токен, который и так передаёт в `ServerData`. Если более новая загрузка его отменила, старая загрузка возвращается, не присваивая данные и не сбрасывая `Loading`, даже если выбросила исключение:

```csharp
catch (Exception) when (token.IsCancellationRequested)
{
    // A newer load cancelled this one, and it owns the data and the loading state.
    return;
}
```

Тип исключения намеренно игнорируется, потому что источники данных часто сообщают об отменённом запросе как о собственной ошибке (`HttpRequestException`, специфичный для провайдера `DbException` и так далее). [PR #14053](https://github.com/MudBlazor/MudBlazor/pull/14053) применяет то же правило к `MudTable`, а последующие правки сохраняют индикатор загрузки при сбросе страницы и не дают позднему поиску заново открыть меню автодополнения, которое уже было закрыто, в котором сделан выбор или которое очищено.

## Что меняется в вашем коде

В PR отмечены два изменения поведения:

- Замещённый поиск в автодополнении больше не вызывает `ReturnedItemsCountChanged`.
- `ReloadServerData()` больше не выбрасывает исключение, когда его замещает более новая загрузка.

Если вы оборачивали `ReloadServerData()` в `try/catch`, чтобы подавлять `TaskCanceledException`, этот код теперь мёртвый. Токен всё равно стоит передавать дальше: отменённый запрос, который действительно прекращается, обходится дешевле, чем тот, результат которого MudBlazor молча отбрасывает:

```csharp
private async Task<GridData<Order>> LoadOrders(GridState<Order> state, CancellationToken ct)
{
    var page = await Http.GetFromJsonAsync<PagedResult<Order>>(
        $"api/orders?page={state.Page}&size={state.PageSize}", ct);
    return new GridData<Order> { Items = page!.Items, TotalItems = page.Total };
}
```

Пути `VirtualizeServerData` это исправление не затрагивает, так как у каждого виртуализированного запроса уже есть собственный токен.

## Другие замечания по обновлению до 9.12.0

Столбцы-перечисления в `MudDataGrid` теперь предлагают фильтр "is any of", у которого `Value` является коллекцией, поэтому обработчику `ServerData`, который выбирает логику по операторам, нужен новый case или `Column.FilterOperators`, чтобы скрыть этот оператор. Чтение `MudStep.Title`, `MudDatePicker.MinDate` и ещё нескольких свойств через ссылку на компонент теперь вызывает диагностику анализатора `MUD0012`; используйте вместо этого `GetState(x => x.Title)`. Полный список, включая null-точки на линейных графиках и `MudText.Truncate`, приведён в [примечаниях к релизу](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0).

```bash
dotnet add package MudBlazor --version 9.12.0
```

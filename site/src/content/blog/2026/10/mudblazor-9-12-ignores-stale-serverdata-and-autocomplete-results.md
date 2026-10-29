---
title: "MudBlazor 9.12: Slow ServerData and Autocomplete Searches No Longer Overwrite Newer Results"
description: "MudBlazor 9.12.0 fixes a long-standing race in MudAutocomplete, MudDataGrid and MudTable: the result of the search that finished last used to win, not the one started last. Here is how the fix works and what changes for your ServerData and SearchFunc code."
pubDate: 2026-10-29
tags:
  - "blazor"
  - "mudblazor"
  - "aspnet-core"
  - "dotnet"
  - "async"
---

[MudBlazor 9.12.0](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0) shipped on October 29, 2026, and the change worth upgrading for is a race condition that has been open in one form or another since [issue #3722](https://github.com/MudBlazor/MudBlazor/issues/3722). `MudAutocomplete`, `MudDataGrid` with `ServerData` and `MudTable` with `ServerData` all kept the result of the request that *finished* last, not the one the user *started* last.

## Why the broad search usually wins

Type "App" into an autocomplete, pause past the debounce, then keep typing "le Pie". Two searches are now in flight. The short query matches more rows, so it is typically the slow one. On 9.11 and earlier, the "Apple Pie" results render first, then the "App" results arrive and replace them. The user sees a list that no longer matches the text box.

The same thing happened with grid filters and paging: change a filter twice quickly and the older, slower `ServerData` call could overwrite the newer page.

## How 9.12 decides which result is stale

[PR #13944](https://github.com/MudBlazor/MudBlazor/pull/13944) uses two different strategies. In `MudAutocomplete`, each search gets a version number, and a search that a newer one replaced bails out before touching the items, the returned-items count or the popover:

```csharp
var searchVersion = ++_searchVersion;
// ... await SearchFunc(text, token) ...
if (searchVersion != _searchVersion)
{
    return;
}
```

The check runs twice, the second time after `ReturnedItemsCountChanged`, because your handler can yield and let a newer search finish in between. That matters because many `SearchFunc` implementations ignore the `CancellationToken` entirely, so cancellation alone could never have fixed this.

`MudDataGrid` relies on the token it already passes to `ServerData`. If a newer load cancelled it, the old load returns without assigning data or clearing `Loading`, even if it threw:

```csharp
catch (Exception) when (token.IsCancellationRequested)
{
    // A newer load cancelled this one, and it owns the data and the loading state.
    return;
}
```

The exception type is deliberately ignored because data sources often report a cancelled request as their own failure (an `HttpRequestException`, a provider-specific `DbException`, and so on). [PR #14053](https://github.com/MudBlazor/MudBlazor/pull/14053) applies the same rule to `MudTable`, and follow-ups keep the loading indicator alive through a page reset and stop a late search from reopening an autocomplete menu that was already closed, selected or cleared.

## What changes for your code

Two behavior changes are called out in the PR:

- A superseded autocomplete search no longer raises `ReturnedItemsCountChanged`.
- `ReloadServerData()` no longer throws when a newer load replaces it.

If you wrapped `ReloadServerData()` in a `try/catch` to swallow `TaskCanceledException`, that code is now dead. You should still pass the token through, since a cancelled request that actually stops is cheaper than one MudBlazor quietly discards:

```csharp
private async Task<GridData<Order>> LoadOrders(GridState<Order> state, CancellationToken ct)
{
    var page = await Http.GetFromJsonAsync<PagedResult<Order>>(
        $"api/orders?page={state.Page}&size={state.PageSize}", ct);
    return new GridData<Order> { Items = page!.Items, TotalItems = page.Total };
}
```

The `VirtualizeServerData` paths are not covered by this fix, since each virtualized request already has its own token.

## Other upgrade notes in 9.12.0

Enum columns in `MudDataGrid` now offer an "is any of" filter whose `Value` is a collection, so a `ServerData` handler that switches on operators needs a new case or `Column.FilterOperators` to hide it. Reading `MudStep.Title`, `MudDatePicker.MinDate` and a few others through a component reference now raises the `MUD0012` analyzer diagnostic; use `GetState(x => x.Title)` instead. The full list, including null points in line charts and `MudText.Truncate`, is in the [release notes](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0).

```bash
dotnet add package MudBlazor --version 9.12.0
```

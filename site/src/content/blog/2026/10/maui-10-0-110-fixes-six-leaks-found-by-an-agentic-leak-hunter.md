---
title: ".NET MAUI 10.0.110 fixes six memory leaks found by an agentic leak hunter"
description: "MAUI 10.0.110 ships six leak fixes for BackButtonBehavior, SwipeItemView, ListView.RefreshCommand, IndicatorView, GeometryGroup and TableView. Most were filed and patched by gh-aw workflows, and they matter most if you use RelayCommand from CommunityToolkit.Mvvm."
pubDate: 2026-10-01
tags:
  - "maui"
  - "dotnet"
  - "memory-leaks"
  - "mvvm"
---

[.NET MAUI 10.0.110](https://github.com/dotnet/maui/releases/tag/10.0.110) landed on September 22, 2026 with 181 commits. Read the release notes and one pattern jumps out: six entries prefixed `[leak-fix]`, five of them authored by `github-actions[bot]`. The MAUI team now runs two agentic workflows, a "Daily Memory Leak Hunter" that files `[leak-scan]` issues and a "Memory Leak Fixer" that opens PRs against them, and 10.0.110 is the first service release where their output ships in bulk.

## The six leaks

- `BackButtonBehavior.Command` (Shell), [#36345](https://github.com/dotnet/maui/issues/36345)
- `SwipeItemView.Command`, [#36343](https://github.com/dotnet/maui/issues/36343)
- `ListView.RefreshCommand`, [#36344](https://github.com/dotnet/maui/issues/36344)
- `IndicatorView` bound to a shared `ObservableCollection`, [#35775](https://github.com/dotnet/maui/issues/35775)
- `GeometryGroup.Children` with a shared `GeometryCollection`, [#36365](https://github.com/dotnet/maui/issues/36365)
- `TableView.Root` with a shared `TableRoot`, [#36355](https://github.com/dotnet/maui/issues/36355)

All six are the same bug shape: a control subscribes to an event on something that outlives it, with a strong delegate and no teardown on unload.

## Why your app may have been hit even if the MAUI tests were not

The three command leaks are the interesting ones. `BackButtonBehavior` did this:

```csharp
newCommand.CanExecuteChanged += CanExecuteChanged;
```

and only unsubscribed when the `Command` property changed again. MAUI's own `Command` class raises `CanExecuteChanged` through a `WeakEventManager`, so it never leaked. But `CommunityToolkit.Mvvm.Input.RelayCommand`, and any hand-written `ICommand` with a plain `event EventHandler`, holds a strong reference. If that command lives on a singleton service or a reused view model, every page that bound it to a back button stayed rooted after navigation:

```text
ICommand (singleton / DI / static / reused VM)
  -> CanExecuteChanged (strong delegate)
     -> BackButtonBehavior
        -> attached page context
```

The fix, in [PR #36370](https://github.com/dotnet/maui/pull/36370), routes the subscription through the internal `WeakCommandSubscription` helper that `Button`, `ImageButton` and `RefreshView` already used:

```csharp
WeakCommandSubscription _commandSubscription;

void OnCommandChanged(ICommand oldCommand, ICommand newCommand)
{
    _commandSubscription?.Dispose();
    _commandSubscription = null;

    if (newCommand != null)
    {
        _commandSubscription = new WeakCommandSubscription(this, newCommand, CanExecuteChanged);
        IsEnabledCore = Command.CanExecute(CommandParameter);
    }
    else
    {
        IsEnabledCore = true;
    }
}
```

`WeakCommandSubscription` uses a `DependentHandle`, so the command references the control only weakly. No public API changed.

## How the bots proved it

Each `[leak-scan]` issue ships a standalone repro against the published `Microsoft.Maui.Controls` package on plain `net10.0`, with no emulator. It installs a stub `IDispatcherProvider` via `[ModuleInitializer]` so controls can be constructed headless, allocates 30 controls carrying a 1 MB payload each, drops them, forces several GC cycles, and counts surviving `WeakReference`s. The fixer PR then extends the existing `CommandsSubscribedToCanExecuteCollect` theory in `CommandTests.cs` and posts a red run (unpatched, behavior still alive) next to a green run. That is a better evidence trail than most human-written leak fixes get.

The same harness is a good template for your own controls: if you write a custom view that subscribes to a bindable `ICommand` or `INotifyCollectionChanged`, a 40-line xunit test catches the leak before a heap snapshot ever has to.

## What to do

Bump the package:

```xml
<PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
```

If you worked around these with manual `Command = null` in `OnDisappearing`, you can drop that code after upgrading. If you use `RelayCommand` on long-lived view models with `SwipeView`, `ListView` pull-to-refresh, or Shell back buttons, upgrade first and measure second: a share of your "MAUI leaks memory on navigation" reports were probably these.

For the previous MAUI 10 service release, see [MAUI 10.0.100 and UsePlatformHandler](/2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends/).

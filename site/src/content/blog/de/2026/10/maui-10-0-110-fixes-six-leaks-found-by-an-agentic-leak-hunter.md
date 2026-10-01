---
title: ".NET MAUI 10.0.110 behebt sechs Speicherlecks, die ein agentischer Leak Hunter gefunden hat"
description: "MAUI 10.0.110 liefert sechs Leak-Fixes für BackButtonBehavior, SwipeItemView, ListView.RefreshCommand, IndicatorView, GeometryGroup und TableView. Die meisten wurden von gh-aw-Workflows gemeldet und gepatcht, und sie betreffen vor allem Apps, die RelayCommand aus CommunityToolkit.Mvvm verwenden."
pubDate: 2026-10-01
tags:
  - "maui"
  - "dotnet"
  - "memory-leaks"
  - "mvvm"
lang: "de"
translationOf: "2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter"
translatedBy: "claude"
translationDate: 2026-10-01
---

[.NET MAUI 10.0.110](https://github.com/dotnet/maui/releases/tag/10.0.110) ist am 22. September 2026 mit 181 Commits erschienen. In den Release Notes fällt ein Muster sofort auf: sechs Einträge mit dem Präfix `[leak-fix]`, fünf davon von `github-actions[bot]` verfasst. Das MAUI-Team betreibt jetzt zwei agentische Workflows, einen "Daily Memory Leak Hunter", der `[leak-scan]`-Issues anlegt, und einen "Memory Leak Fixer", der dazu Pull Requests öffnet. 10.0.110 ist das erste Service Release, in dem ihre Ergebnisse gebündelt ausgeliefert werden.

## Die sechs Lecks

- `BackButtonBehavior.Command` (Shell), [#36345](https://github.com/dotnet/maui/issues/36345)
- `SwipeItemView.Command`, [#36343](https://github.com/dotnet/maui/issues/36343)
- `ListView.RefreshCommand`, [#36344](https://github.com/dotnet/maui/issues/36344)
- `IndicatorView` gebunden an eine gemeinsam genutzte `ObservableCollection`, [#35775](https://github.com/dotnet/maui/issues/35775)
- `GeometryGroup.Children` mit einer gemeinsam genutzten `GeometryCollection`, [#36365](https://github.com/dotnet/maui/issues/36365)
- `TableView.Root` mit einem gemeinsam genutzten `TableRoot`, [#36355](https://github.com/dotnet/maui/issues/36355)

Alle sechs haben dieselbe Fehlerform: Ein Steuerelement abonniert ein Ereignis eines Objekts, das länger lebt als das Steuerelement selbst, mit einem starken Delegate und ohne Abbau beim Entladen.

## Warum Ihre App betroffen gewesen sein kann, obwohl die MAUI-Tests es nicht waren

Die drei Command-Lecks sind die interessantesten. `BackButtonBehavior` tat Folgendes:

```csharp
newCommand.CanExecuteChanged += CanExecuteChanged;
```

und meldete sich nur ab, wenn sich die Eigenschaft `Command` erneut änderte. MAUIs eigene Klasse `Command` löst `CanExecuteChanged` über einen `WeakEventManager` aus und hat deshalb nie ein Leck verursacht. `CommunityToolkit.Mvvm.Input.RelayCommand` und jedes handgeschriebene `ICommand` mit einem einfachen `event EventHandler` halten dagegen eine starke Referenz. Lebt ein solches Command in einem Singleton-Dienst oder einem wiederverwendeten ViewModel, blieb jede Seite, die es an eine Zurück-Schaltfläche gebunden hatte, nach der Navigation im Speicher verankert:

```text
ICommand (singleton / DI / static / reused VM)
  -> CanExecuteChanged (strong delegate)
     -> BackButtonBehavior
        -> attached page context
```

Der Fix in [PR #36370](https://github.com/dotnet/maui/pull/36370) leitet das Abonnement über den internen Helfer `WeakCommandSubscription`, den `Button`, `ImageButton` und `RefreshView` bereits verwendeten:

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

`WeakCommandSubscription` nutzt ein `DependentHandle`, sodass das Command das Steuerelement nur schwach referenziert. Es hat sich keine öffentliche API geändert.

## Wie die Bots den Nachweis geführt haben

Jedes `[leak-scan]`-Issue enthält eine eigenständige Reproduktion gegen das veröffentlichte Paket `Microsoft.Maui.Controls` auf einfachem `net10.0`, ohne Emulator. Sie installiert über `[ModuleInitializer]` einen Stub-`IDispatcherProvider`, damit Steuerelemente headless erzeugt werden können, allokiert 30 Steuerelemente mit je 1 MB Nutzlast, verwirft sie, erzwingt mehrere GC-Zyklen und zählt die überlebenden `WeakReference`s. Der Fixer-PR erweitert dann die bestehende Theory `CommandsSubscribedToCanExecuteCollect` in `CommandTests.cs` und postet einen roten Lauf (ungepatcht, Verhalten noch aktiv) neben einem grünen Lauf. Das ist eine bessere Beweiskette, als die meisten von Menschen geschriebenen Leak-Fixes vorweisen.

Dasselbe Harness eignet sich als Vorlage für eigene Steuerelemente: Wenn Sie eine benutzerdefinierte View schreiben, die ein bindbares `ICommand` oder `INotifyCollectionChanged` abonniert, findet ein xunit-Test mit 40 Zeilen das Leck, bevor überhaupt ein Heap-Snapshot nötig wird.

## Was zu tun ist

Aktualisieren Sie das Paket:

```xml
<PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
```

Wenn Sie diese Lecks mit einem manuellen `Command = null` in `OnDisappearing` umgangen haben, können Sie diesen Code nach dem Upgrade entfernen. Wenn Sie `RelayCommand` auf langlebigen ViewModels mit `SwipeView`, Pull-to-Refresh in `ListView` oder Shell-Zurück-Schaltflächen einsetzen, gilt: erst aktualisieren, dann messen. Ein Teil Ihrer Meldungen "MAUI leakt Speicher bei der Navigation" ging vermutlich auf diese Fehler zurück.

Zum vorherigen MAUI-10-Service-Release siehe [MAUI 10.0.100 und UsePlatformHandler](/de/2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends/).

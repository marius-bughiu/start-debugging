---
title: ".NET MAUI 10.0.110 исправляет шесть утечек памяти, найденных агентным охотником за утечками"
description: "MAUI 10.0.110 содержит исправления шести утечек в BackButtonBehavior, SwipeItemView, ListView.RefreshCommand, IndicatorView, GeometryGroup и TableView. Большинство из них были заведены и исправлены рабочими процессами gh-aw, и они особенно важны, если вы используете RelayCommand из CommunityToolkit.Mvvm."
pubDate: 2026-10-01
tags:
  - "maui"
  - "dotnet"
  - "memory-leaks"
  - "mvvm"
lang: "ru"
translationOf: "2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter"
translatedBy: "claude"
translationDate: 2026-10-01
---

[.NET MAUI 10.0.110](https://github.com/dotnet/maui/releases/tag/10.0.110) вышел 2026-09-22 и содержит 181 коммит. В примечаниях к релизу бросается в глаза одна закономерность: шесть записей с префиксом `[leak-fix]`, пять из которых созданы `github-actions[bot]`. Команда MAUI теперь запускает два агентных рабочих процесса: "Daily Memory Leak Hunter", который заводит задачи `[leak-scan]`, и "Memory Leak Fixer", который открывает по ним PR. 10.0.110 стал первым сервисным релизом, в котором результаты их работы поставляются массово.

## Шесть утечек

- `BackButtonBehavior.Command` (Shell), [#36345](https://github.com/dotnet/maui/issues/36345)
- `SwipeItemView.Command`, [#36343](https://github.com/dotnet/maui/issues/36343)
- `ListView.RefreshCommand`, [#36344](https://github.com/dotnet/maui/issues/36344)
- `IndicatorView`, привязанный к общей `ObservableCollection`, [#35775](https://github.com/dotnet/maui/issues/35775)
- `GeometryGroup.Children` с общей `GeometryCollection`, [#36365](https://github.com/dotnet/maui/issues/36365)
- `TableView.Root` с общим `TableRoot`, [#36355](https://github.com/dotnet/maui/issues/36355)

Во всех шести случаях ошибка одна и та же: элемент управления подписывается на событие объекта, живущего дольше него, через сильный делегат и не отписывается при выгрузке.

## Почему ваше приложение могло пострадать, даже если тесты MAUI ничего не заметили

Интереснее всего три утечки, связанные с командами. `BackButtonBehavior` делал так:

```csharp
newCommand.CanExecuteChanged += CanExecuteChanged;
```

и отписывался только при повторном изменении свойства `Command`. Собственный класс `Command` в MAUI вызывает `CanExecuteChanged` через `WeakEventManager`, поэтому он никогда не протекал. Но `CommunityToolkit.Mvvm.Input.RelayCommand` и любая написанная вручную реализация `ICommand` с обычным `event EventHandler` хранят сильную ссылку. Если такая команда живёт в синглтон-сервисе или переиспользуемой модели представления, каждая страница, привязавшая её к кнопке "назад", оставалась достижимой от корней после навигации:

```text
ICommand (singleton / DI / static / reused VM)
  -> CanExecuteChanged (strong delegate)
     -> BackButtonBehavior
        -> attached page context
```

Исправление в [PR #36370](https://github.com/dotnet/maui/pull/36370) направляет подписку через внутренний вспомогательный класс `WeakCommandSubscription`, который уже использовали `Button`, `ImageButton` и `RefreshView`:

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

`WeakCommandSubscription` использует `DependentHandle`, поэтому команда ссылается на элемент управления лишь слабо. Публичный API не изменился.

## Как боты это доказали

Каждая задача `[leak-scan]` содержит автономный воспроизводящий пример на опубликованном пакете `Microsoft.Maui.Controls` на обычном `net10.0`, без эмулятора. Он устанавливает заглушку `IDispatcherProvider` через `[ModuleInitializer]`, чтобы элементы управления можно было создавать без интерфейса, создаёт 30 элементов управления с нагрузкой по 1 МБ каждый, отпускает их, принудительно запускает несколько циклов сборки мусора и подсчитывает уцелевшие `WeakReference`. Затем PR исполнителя исправлений расширяет существующую theory `CommandsSubscribedToCanExecuteCollect` в `CommandTests.cs` и публикует красный прогон (без исправления, поведение всё ещё живо) рядом с зелёным. Это более надёжная цепочка доказательств, чем у большинства исправлений утечек, написанных людьми.

Тот же стенд хорошо подходит как шаблон для ваших собственных элементов управления: если вы пишете пользовательское представление, которое подписывается на привязываемый `ICommand` или `INotifyCollectionChanged`, тест xunit в 40 строк поймает утечку раньше, чем понадобится снимок кучи.

## Что делать

Обновите пакет:

```xml
<PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
```

Если вы обходили эти проблемы вручную через `Command = null` в `OnDisappearing`, после обновления этот код можно убрать. Если вы используете `RelayCommand` в долгоживущих моделях представления вместе с `SwipeView`, обновлением по жесту вниз в `ListView` или кнопками "назад" в Shell, сначала обновитесь, а потом измеряйте: часть ваших жалоб вида "MAUI утекает память при навигации", вероятно, относилась именно к этим случаям.

О предыдущем сервисном релизе MAUI 10 читайте в статье [MAUI 10.0.100 и UsePlatformHandler](/ru/2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends/).

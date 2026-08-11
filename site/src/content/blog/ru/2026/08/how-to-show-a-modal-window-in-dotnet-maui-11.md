---
title: "Как показать модальное окно в .NET MAUI 11"
description: "Модальным окном в .NET MAUI 11 называют две совершенно разные вещи. PushModalAsync даёт модальную страницу на всех платформах. Настоящего окна операционной системы, блокирующего окно-владельца, в MAUI нет вообще, поэтому здесь разобрана связка WinUI OverlappedPresenter.IsModal и Win32-дескриптора владельца, которая реально работает в Windows, и что делать в Mac Catalyst."
pubDate: 2026-08-11
template: how-to
tags:
  - "dotnet-maui"
  - "dotnet"
  - "csharp"
  - "windows"
  - "winui"
  - "navigation"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-show-a-modal-window-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-08-11
---

Если вы искали именно это, скорее всего вы имеете в виду одну из двух совершенно разных вещей, и .NET MAUI обращается с ними по-разному. **Модальная страница** (полноэкранная страница, блокирующая взаимодействие с тем, что находится за ней, до закрытия) является полноценной кроссплатформенной возможностью: `Navigation.PushModalAsync`. **Модального окна** в десктопном смысле (второе окно верхнего уровня, которое затеняет и блокирует своего владельца, пока с ним не разберутся, как это делает `ShowDialog` в WPF) в MAUI нет вообще, ни в .NET MAUI 11, ни в более ранних версиях. `Application.Current.OpenWindow` открывает *немодальное* второе окно. Чтобы получить настоящую модальность в Windows, нужно спуститься через handler до `AppWindow` из WinUI, назначить владельца вызовом Win32 и включить `OverlappedPresenter.IsModal`. В Mac Catalyst эквивалента нет, и там следует использовать модальную страницу.

.NET MAUI 11 в августе 2026 года находится на NuGet в версии `11.0.0-preview.6.26360.8`, так что поверхность API ещё меняется. Все фрагменты ниже скомпилированы против стабильного workload .NET MAUI 10.0.20 на .NET SDK 10.0.201 с целевой платформой `net10.0-windows10.0.19041.0`. Предварительные версии MAUI 11 переносят все эти члены без изменений; единственное переименование, о котором нужно знать, появилось в MAUI 10 и разобрано ниже.

## Какое именно "модальное" вам нужно

| Что вам нужно | Какой API использовать | Где работает |
| --- | --- | --- |
| Страница, закрывающая приложение, с которой нельзя уйти навигацией | `Navigation.PushModalAsync` | Android, iOS, Mac Catalyst, Windows |
| Вопрос да/нет или один ввод текста | `DisplayAlertAsync`, `DisplayPromptAsync` | везде |
| Наложение меньше экрана поверх текущей страницы | `ShowPopupAsync` из Community Toolkit | везде |
| Отдельное окно ОС, блокирующее своего владельца | В MAUI API нет. Взаимодействие с WinUI и Win32 | только Windows |

Четвёртая строка и есть честный ответ на десктопный вопрос, и именно поэтому запрос открыт в репозитории MAUI с 2022 года. Всё остальное давно решено.

## Модальные страницы и чем они отличаются от `PushAsync`

Модальная навигация использует стек, отдельный от иерархической навигации. `Navigation` предоставляет оба, и модальный намеренно скромнее:

```csharp
// .NET MAUI 10.0.20 / 11.0 preview
async void OnOpenModalClicked(object sender, EventArgs e)
{
    await Navigation.PushModalAsync(new ConfirmPage());
}

async void OnCloseModalClicked(object sender, EventArgs e)
{
    await Navigation.PopModalAsync();
}
```

Для модального стека нет ни `PopModalToRootAsync`, ни `InsertPageBefore`, ни `RemovePage`, потому что эти операции не поддерживаются повсеместно на нижележащих платформах. Есть `ModalStack` для просмотра, и всё. Кроме того, для модального push не нужен `NavigationPage`, а это важно в приложении на Shell: `NavigationPage` выбрасывает исключение при использовании внутри Shell, тогда как модальная навигация там работает нормально. Если маршрутизация уже идёт через Shell, посмотрите подробности о [передаче данных через параметры маршрута и свойства запроса Shell](/ru/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/), прежде чем использовать модальную страницу для переноса состояния.

Класс `Window` вызывает события `ModalPushing`, `ModalPushed`, `ModalPopping`, `ModalPopped` и `PopCanceled`, и именно так модальный стек наблюдают извне самих страниц. `ModalPoppingEventArgs` несёт флаг `Cancel`, поэтому это же место для проверки "точно хотите отменить изменения?":

```csharp
// .NET MAUI 10.0.20: veto a modal dismissal from the Window
Window.ModalPopping += (s, e) =>
{
    if (HasUnsavedChanges(e.Modal))
        e.Cancel = true;
};
```

## Как получить результат из модальной страницы

`PushModalAsync` возвращает `Task`, которая завершается по окончании анимации показа, а не когда пользователь закончил работу. На этом спотыкаются почти все в первый раз. Идиоматичное решение состоит в `TaskCompletionSource<T>` на модальной странице:

```csharp
// .NET MAUI 10.0.20, C# 14
public sealed class ConfirmPage : ContentPage
{
    readonly TaskCompletionSource<bool> _tcs = new();

    public Task<bool> Result => _tcs.Task;

    public ConfirmPage()
    {
        var ok = new Button { Text = "OK" };
        ok.Clicked += async (s, e) =>
        {
            _tcs.TrySetResult(true);
            await Navigation.PopModalAsync();
        };
        Content = ok;
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        // Covers swipe-to-dismiss on iOS and the Android back button.
        _tcs.TrySetResult(false);
    }
}
```

В месте вызова:

```csharp
var confirm = new ConfirmPage();
await Navigation.PushModalAsync(confirm);
bool accepted = await confirm.Result;
```

`TrySetResult` вместо `SetResult` здесь не оборонительный шум: `OnDisappearing` действительно выполняется после того, как обработчик кнопки уже установил результат, и `SetResult` выбросил бы `InvalidOperationException` на втором вызове.

## Как сделать страницу по-настоящему непропускаемой

В Android аппаратная или жестовая кнопка "назад" снимает страницу с модального стека независимо от вашего желания. Переопределите `OnBackButtonPressed` на модальной странице и верните `true`, чтобы поглотить событие:

```csharp
protected override bool OnBackButtonPressed() => true;
```

В iOS модальные окна в стиле листа закрываются свайпом вниз. Это относится к стилю представления, о котором речь дальше.

## Как управлять видом модального окна в iOS и Mac Catalyst

По умолчанию модальная страница показывается на весь экран. Платформенная настройка iOS меняет это, и она одна из немногих, что влияет и на Mac Catalyst, поскольку Catalyst использует механику представления UIKit:

```xaml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:ios="clr-namespace:Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;assembly=Microsoft.Maui.Controls"
             x:Class="MyApp.ConfirmPage"
             ios:Page.ModalPresentationStyle="FormSheet">
</ContentPage>
```

Или из кода:

```csharp
using Microsoft.Maui.Controls.PlatformConfiguration;
using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;
using Page = Microsoft.Maui.Controls.Page; // see the gotcha below

On<iOS>().SetModalPresentationStyle(UIModalPresentationStyle.FormSheet);
```

`UIModalPresentationStyle` предлагает `FullScreen`, `FormSheet`, `PageSheet`, `OverFullScreen`, `Automatic` и, начиная с .NET MAUI 10, `Popover`. `FormSheet` ближе всего к десктопному диалогу из того, что даёт Mac Catalyst: центрированная панель меньше экрана поверх окна приложения. `OverFullScreen` нужен, если у модальной страницы прозрачный или полупрозрачный фон.

## Шаги для показа настоящего модального окна в Windows

Это и есть десктопный случай: по-настоящему отдельное окно со своим заголовком, блокирующее окно, из которого оно открыто.

1. Создайте `Window` и откройте его через `Application.Current.OpenWindow`. В этот момент у окна нет ни handler, ни платформенного представления, поэтому настроить пока ничего нельзя.
2. Дождитесь handler. Подпишитесь на `HandlerChanged` у нового `Window` до его открытия либо сначала проверьте `Handler` на случай, если он уже присоединён. Всё дальнейшее находится внутри блока `#if WINDOWS`.
3. Приведите платформенное представление к `MauiWinUIWindow` и прочитайте его свойство `AppWindow`. Это объект Windows App SDK, отвечающий за представление.
4. Назначьте владельца. Вызовите `SetWindowLongPtr` с `GWLP_HWNDPARENT` (`-8`), передав HWND окна-владельца. Пропуск этого шага является самой частой причиной сбоя.
5. Примените `OverlappedPresenter` и установите `IsModal` в `true`. Используйте `OverlappedPresenter.CreateForDialog()` для диалоговых значений по умолчанию: без сворачивания, без разворачивания, без изменения размера.
6. Снова активируйте окно-владельца при закрытии модального окна. Обработайте `Destroying` у `Window` из MAUI и вызовите `Activate` у владельца, иначе фокус уйдёт в другое приложение.

## Взаимодействие с Windows целиком

```csharp
// ModalWindowService.cs
// Verified against .NET MAUI 10.0.20 / .NET SDK 10.0.201, net10.0-windows10.0.19041.0
#if WINDOWS
using System.Runtime.InteropServices;
using Microsoft.Maui.Platform;   // MauiWinUIWindow
using Microsoft.UI.Windowing;    // AppWindow, OverlappedPresenter
using WinRT.Interop;             // WindowNative
#endif

namespace MyApp;

public static partial class ModalWindowService
{
    public static void ShowModal(Window owner, Page content, string title)
    {
        var modal = new Window(content) { Title = title, Width = 520, Height = 360 };

#if WINDOWS
        WhenHandlerReady(modal, () => MakeModal(modal, owner));
        modal.Destroying += (s, e) => Application.Current?.ActivateWindow(owner);
#endif

        Application.Current?.OpenWindow(modal);
    }

    static void WhenHandlerReady(Window window, Action action)
    {
        if (window.Handler?.PlatformView is not null)
        {
            action();
            return;
        }

        void OnChanged(object? sender, EventArgs e)
        {
            window.HandlerChanged -= OnChanged;
            if (window.Handler?.PlatformView is not null)
                action();
        }

        window.HandlerChanged += OnChanged;
    }

#if WINDOWS
    const int GWLP_HWNDPARENT = -8;

    static void MakeModal(Window modal, Window owner)
    {
        var nativeModal = (MauiWinUIWindow)modal.Handler!.PlatformView!;
        var nativeOwner = (MauiWinUIWindow)owner.Handler!.PlatformView!;

        nint modalHwnd = WindowNative.GetWindowHandle(nativeModal);
        nint ownerHwnd = WindowNative.GetWindowHandle(nativeOwner);

        // Ownership must be established before IsModal is set.
        SetWindowLongPtr(modalHwnd, GWLP_HWNDPARENT, ownerHwnd);

        AppWindow appWindow = nativeModal.AppWindow;
        var presenter = OverlappedPresenter.CreateForDialog();
        appWindow.SetPresenter(presenter);
        presenter.IsModal = true;
    }

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static partial nint SetWindowLongPtr(nint hWnd, int nIndex, nint dwNewLong);
#endif
}
```

Основную работу делает `IsModal`. Windows App SDK документирует это свойство так: оно имеет приоритет над окном-владельцем и блокирует любой ввод в него, пока модальное окно не закрыто или не перестало быть модальным. Отдельный вызов `EnableWindow(ownerHwnd, false)` после установки `IsModal` не нужен, а если его добавить, останется заблокированное окно-владелец, которое потом придётся вручную разблокировать.

`OverlappedPresenter.CreateForDialog()` заранее заполняет значения в диалоговом стиле, поэтому отключать `IsMinimizable`, `IsMaximizable` и `IsResizable` по отдельности не нужно. Если нужно обычное окно, которое просто оказалось модальным, используйте `OverlappedPresenter.Create()`. Обратите внимание также, что .NET MAUI 10 добавил `Window.IsMinimizable` и `Window.IsMaximizable` как привязываемые свойства кроссплатформенного `Window`, так что для этих двух настроек взаимодействие с платформой больше не требуется.

## Подводные камни, которые стоят реального времени

**`IsModal` без владельца выбрасывает исключение.** Установка `IsModal = true` для окна без владельца даёт `System.ArgumentException: Value does not fall within the expected range.` Об этом сообщено в репозитории Windows App SDK, и именно поэтому существует шаг 4. Если модальное окно работает в одной ветке кода и падает в другой, проверьте, что переданный HWND владельца был ненулевым.

**`Handler` равен null сразу после `OpenWindow`.** MAUI создаёт платформенное окно асинхронно. Чтение `window.Handler.PlatformView` строкой ниже `OpenWindow` выбрасывает `NullReferenceException`. Вспомогательный метод `WhenHandlerReady` выше существует исключительно из-за этого, а подписка на `HandlerChanged` *до* вызова `OpenWindow` делает его надёжным.

**`[LibraryImport]` требует тип `partial`.** Если вставить P/Invoke в обычный `static class`, вы получите `SYSLIB1050: Method 'SetWindowLongPtr' is contained in a type 'ModalWindowService' that is not marked 'partial'`, а следом `CS8795` и `CS0751`. Пометьте класс как `partial`. У более старого атрибута `[DllImport]` такого требования нет, но в сборке с обрезкой или Native AOT нужно именно взаимодействие, сгенерированное из исходного кода.

**Пространство имён платформенных настроек iOS перекрывает `Page`.** Добавление `using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;` в файл, где также используется `Microsoft.Maui.Controls`, даёт `CS0104: 'Page' is an ambiguous reference between 'Microsoft.Maui.Controls.Page' and 'Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.Page'`. Добавьте `using Page = Microsoft.Maui.Controls.Page;` либо указывайте полное имя.

**`DisplayAlert` переименован в .NET MAUI 10.** Методы всплывающих окон у `Page` теперь называются `DisplayAlertAsync`, `DisplayActionSheetAsync` и `DisplayPromptAsync`. `DisplayPromptAsync` сохранил своё имя, поскольку всегда его имел. При переносе кодовой базы с MAUI 8 или 9 это тихий источник ошибок сборки.

**Многооконность требует настройки на каждой платформе и никогда не работает на iPhone.** Даже немодальный путь `OpenWindow` требует `LaunchMode.Multiple` у `MainActivity` для Android, а также класса `SceneDelegate` и записи `UIApplicationSceneManifest` в `Info.plist` для iPadOS и Mac Catalyst. Windows не требует ничего. iOS на iPhone не может этого вовсе. Если приложение и так только для десктопа, [сведение проекта MAUI к Windows и Mac Catalyst](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) убирает большую часть этой конфигурационной поверхности.

**В Mac Catalyst нет эквивалента `IsModal`.** Аналога `OverlappedPresenter` в Catalyst не существует, и MAUI не предоставляет `beginSheet`. В Catalyst показывайте модальную страницу со стилем `FormSheet` и примите, что она ограничена окном, а не приложением. Если настоящие модальные окна уровня приложения являются жёстким продуктовым требованием на всех десктопных платформах, это один из конкретных случаев, где [MAUI проигрывает Avalonia и Uno](/ru/2026/05/maui-vs-avalonia-vs-uno-in-2026/).

## Когда popup оказывается лучшим ответом

Если на самом деле нужно наложение меньше экрана, парящее над текущей страницей, то ни модальная страница, ни второе окно не подходят. В .NET MAUI Community Toolkit (версия 15.0.0 на август 2026 года) есть `ShowPopupAsync`, `Popup<T>` для типизированных результатов и `IPopupService` для показа из модели представления. Установите `CanBeDismissedByTappingOutsideOfPopup` в `false`, и вы получите блокирующее наложение без всякого взаимодействия с платформой из примеров выше. Стоит знать, что popup в toolkit реализован как наложение `ContentPage`, поэтому вызывающая страница по-прежнему получает `OnNavigatingFrom`, `OnDisappearing` и `OnNavigatedFrom`. Если вы полагались на эти события как на признак того, что "пользователь ушёл с этого экрана", popup тоже их вызовет.

Выбирайте по области действия, а не по привычке. Блокировать одну задачу внутри одного окна означает модальную страницу. Блокировать всё приложение в Windows означает взаимодействие с платформой из примеров выше. Всё остальное является popup.

## Похожие материалы

- [Как использовать параметры маршрута и свойства запроса Shell для навигации в .NET MAUI 11](/ru/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/)
- [Как написать приложение MAUI только для Windows и macOS (без мобильных платформ)](/ru/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/)
- [Как реализовать перетаскивание в .NET MAUI 11](/ru/2026/05/how-to-implement-drag-and-drop-in-maui-11/)
- [Как правильно поддержать тёмную тему в приложении .NET MAUI](/ru/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)
- [MAUI против Avalonia и Uno Platform: что выбрать в 2026 году?](/ru/2026/05/maui-vs-avalonia-vs-uno-in-2026/)

## Источники

- [Window - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/window?view=net-maui-11.0)
- [NavigationPage, Perform modal navigation - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pages/navigationpage?view=net-maui-11.0)
- [Display pop-ups - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pop-ups?view=net-maui-11.0)
- [Modal page presentation style on iOS - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/ios/platform-specifics/page-presentation-style?view=net-maui-11.0)
- [OverlappedPresenter.IsModal Property, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter.ismodal)
- [OverlappedPresenter Class, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter)
- [microsoft/WindowsAppSDK#3258, ArgumentException when OverlappedPresenter.IsModal is set to true](https://github.com/microsoft/WindowsAppSDK/issues/3258)
- [microsoft/WindowsAppSDK discussion #4435, on the issue of modal windows](https://github.com/microsoft/WindowsAppSDK/discussions/4435)
- [dotnet/maui#6210, Multi-Window in Windows with all options](https://github.com/dotnet/maui/issues/6210)
- [SYSLIB1050, source-generated P/Invoke diagnostics](https://learn.microsoft.com/dotnet/fundamentals/syslib-diagnostics/syslib1050)
- [.NET MAUI Community Toolkit Popup documentation](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/views/popup)

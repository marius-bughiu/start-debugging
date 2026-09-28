---
title: "Исправление: .NET MAUI Entry с Keyboard.Numeric показывает маленькую цифровую панель, а затем полную клавиатуру на iPadOS 26"
description: "В iPadOS 26 MAUI сопоставляет Keyboard.Numeric с UIKeyboardType.DecimalPad, который теперь открывается как плавающая мини-панель с цифрами. Добавьте маппер, переключающий iPad на NumbersAndPunctuation, и проверяйте ввод самостоятельно."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
lang: "ru"
translationOf: "2026/09/fix-maui-numeric-entry-small-numpad-then-full-keyboard-on-ipados-26"
translatedBy: "claude"
translationDate: 2026-09-28
---

Если `Entry` с `Keyboard="Numeric"` в .NET MAUI 10 при первом касании на iPad открывает маленькую плавающую цифровую панель, а при следующем касании полноразмерную клавиатуру на странице цифр (иногда без десятичной точки, без знака минус или с клавишами, которые вводят не ту цифру), то клавиатуры переключает не MAUI. Это делает iPadOS 26. MAUI сопоставляет `Keyboard.Numeric` с `UIKeyboardType.DecimalPad`, а в iPadOS 26 этот тип клавиатуры отображается как компактная плавающая панель, если закреплённой клавиатуры ещё нет. Работающее сегодня исправление: добавить маппинг в `EntryHandler.Mapper`, чтобы числовые поля на iPad получали `UIKeyboardType.NumbersAndPunctuation`, и затем проверять текст самостоятельно, потому что на этой клавиатуре можно ввести и буквы. iPhone не затронут и сохраняет обычную десятичную панель.

## Ошибка в контексте

Исключения нет. Симптом: клавиатура меняет вид между событиями получения фокуса. На iPad с iPadOS 26.0 или 26.1 и обычным числовым `Entry` в MAUI:

```text
// .NET 10, Microsoft.Maui.Controls 10.0.x, iPad (10th gen), iPadOS 26.1
1st tap on Entry   -> small floating number pad (digits + decimal key), no Done bar
tap outside        -> keypad dismisses
2nd tap on Entry   -> full-width keyboard, numbers-and-symbols page
type "12.5"        -> field shows unexpected characters on some devices
switch to ABC page and back to 123 -> digits register correctly again
```

Те, кто ищет решение, обычно описывают лишь часть проблемы: "Keyboard.Numeric not working on iOS", "no decimal point on iPad numeric keyboard", "numeric keypad floating on iPad", "MAUI Done button missing on iPad" или "numbers type random characters on iPad". Отслеживающая задача MAUI: [dotnet/maui#32288](https://github.com/dotnet/maui/issues/32288) (iPad 8-го поколения, iOS 26.0.1, MAUI 10.0.0-rc.2, помечена как регрессия и всё ещё открыта в бэклоге). То же поведение проявляется во Flutter как [flutter/flutter#178096](https://github.com/flutter/flutter/issues/178096) и в нативных приложениях на UIKit, что и выдаёт: это не баг MAUI.

## Почему iPadOS 26 подменяет клавиатуру под числовым Entry в MAUI

Сопоставление клавиатур MAUI для iOS короткое. В [`KeyboardExtensions.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) в ветке `main` метод `ApplyKeyboard` для числового случая делает следующее:

```csharp
// .NET MAUI main (10.0.x and 11 previews), src/Core/src/Platform/iOS/KeyboardExtensions.cs
else if (keyboard == Keyboard.Numeric)
    textInput.SetKeyboardType(UIKeyboardType.DecimalPad);
else if (keyboard == Keyboard.Telephone)
    textInput.SetKeyboardType(UIKeyboardType.PhonePad);
```

До iPadOS 26 `DecimalPad` на iPad просто открывал обычную полную клавиатуру на странице цифр, потому что у iPad никогда не было отдельной цифровой панели. iPadOS 26 это изменил: `decimalPad` и `numberPad` теперь показывают компактную плавающую панель только с цифрами. Разработчики столкнулись с тремя отдельными проблемами:

1. **Плавающая панель появляется, только если нет закреплённой клавиатуры.** Если пользователь печатал в текстовом поле и переводит фокус на числовое, закреплённая клавиатура остаётся на месте и переключается на страницу цифр. Если числовое поле становится first responder первым, вы получаете плавающую панель. Задача во Flutter документирует именно это: всё работает, когда фокус переходит из текстового поля, и ломается, когда числовое поле получает фокус первым. Поэтому и кажется, что клавиатура "переключается" в зависимости от того, куда пользователь нажал до этого.
2. **Плавающая панель скрывает `inputAccessoryView`.** MAUI прикрепляет собственный `MauiDoneAccessoryView` к каждому `Entry` на iOS в `EntryHandler.CreatePlatformView()`. [Тема 801458 на Apple Developer Forums](https://developer.apple.com/forums/thread/801458) сообщает, что плавающая панель не показывает панель аксессуаров, так что ваша панель Done и любая собственная панель Next/Previous исчезают.
3. **Закрытие и повторный фокус дают полную клавиатуру с некорректным вводом.** [Тема 808114](https://developer.apple.com/forums/thread/808114) (FB21144039) воспроизводит это в собственном приложении Apple "Контакты" на iPadOS с 26.0 по 26.1: нажмите на числовое поле, получите маленькую панель, закройте её, нажмите снова, получите полную клавиатуру на странице цифр, и клавиши будут вводить не те символы, пока вы не переключитесь на страницу букв и обратно.

Ничто из этого MAUI не контролирует, и в UIKit нет API, позволяющего отказаться от плавающей панели. Контролировать можно то, какой `UIKeyboardType` запрашивает текстовое поле.

## Минимальное воспроизведение

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.x, run on an iPad with iPadOS 26.0 or 26.1 -->
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="KeyboardRepro.MainPage">
    <VerticalStackLayout Padding="24" Spacing="16">
        <Entry Placeholder="Amount" Keyboard="Numeric" />
        <Entry Placeholder="Notes" />
    </VerticalStackLayout>
</ContentPage>
```

Запустите приложение и сначала нажмите на "Amount": плавающая цифровая панель. Нажмите за пределами поля, снова нажмите на "Amount": полная клавиатура. Теперь сначала нажмите на "Notes", затем на "Amount": закреплённая клавиатура на странице цифр, никакой плавающей панели. Один и тот же код, три разные клавиатуры, и всё определяется исключительно историей фокуса.

## Исправление 1: сопоставьте числовые поля с NumbersAndPunctuation на iPad

Это обходной путь, к которому пришли на форуме Apple, переведённый в маппинг обработчика MAUI. `NumbersAndPunctuation` всегда закрепляется, оставляет панель аксессуаров видимой, имеет десятичный разделитель и знак минус и ведёт себя на iPad одинаково уже много релизов iOS.

Добавьте это в `MauiProgram.cs`:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x, iOS/iPadOS 26
using Microsoft.Maui.Handlers;
#if IOS
using UIKit;
#endif

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder.UseMauiApp<App>();

#if IOS
        // Runs after MAUI's own "Keyboard" mapping, so it overrides DecimalPad.
        EntryHandler.Mapper.AppendToMapping(nameof(IEntry.Keyboard), (handler, entry) =>
        {
            if (entry.Keyboard != Keyboard.Numeric)
                return;

            if (UIDevice.CurrentDevice.UserInterfaceIdiom != UIUserInterfaceIdiom.Pad)
                return;

            if (!OperatingSystem.IsIOSVersionAtLeast(26))
                return;

            handler.PlatformView.KeyboardType = UIKeyboardType.NumbersAndPunctuation;
            handler.PlatformView.ReloadInputViews();
        });
#endif

        return builder.Build();
    }
}
```

Здесь важны три детали:

- **Используйте `AppendToMapping` с ключом `"Keyboard"`.** `AppendToMapping` ставит ваше действие в цепочку после существующего маппинга для этого ключа, так что MAUI сначала выполняет `UpdateKeyboard` (который устанавливает `DecimalPad`, флаги подсказок и проверки орфографии, а затем вызывает `ReloadInputViews`), а ваше действие потом переопределяет тип клавиатуры. Если вместо этого использовать `ModifyMapping` или `PrependToMapping`, маппинг MAUI выполнится последним и вернёт `DecimalPad`. Любое последующее изменение `Entry.Keyboard` заново запускает цепочку, так что клавиатура, заданная через привязку или триггер, тоже остаётся исправленной.
- **Вызывайте `ReloadInputViews()` сами.** Если свойство меняется, когда поле уже в фокусе, UIKit не заменит клавиатуру, пока текстовое поле не попросят перезагрузить свои input views.
- **Используйте защиту `#if IOS`, а не `#if IOS || MACCATALYST`.** Mac Catalyst использует аппаратную клавиатуру, и проблемы с плавающей цифровой панелью там нет. Символ `IOS` не определён для целевой платформы `net10.0-maccatalyst`, так что этот код не попадает в сборку для Mac.

`OperatingSystem.IsIOSVersionAtLeast(26)` возвращает `true` на iPadOS, потому что iPadOS представляется как iOS. Проверка версии оставляет iPad, всё ещё работающие на iPadOS 18, на старом, корректном пути с `DecimalPad`. Верхнюю границу я намеренно не добавил: Apple не документировала изменение поведения, поэтому проверяйте заново на каждом новом релизе iPadOS, прежде чем удалять маппинг, вместо того чтобы гадать, в какой версии проблема исчезнет.

## Исправление 2: проверяйте текст, потому что NumbersAndPunctuation не только для цифр

`NumbersAndPunctuation` это страница цифр полной клавиатуры. Пользователь может нажать "ABC" и ввести буквы, а также ввести несколько десятичных разделителей. `DecimalPad` никогда этого не допускал, поэтому код, который делал `decimal.Parse(entry.Text)` без проверки, начнёт выбрасывать `FormatException`.

Это исправляет небольшое поведение (behavior), отклоняющее всё, что не может стать числом:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
using System.Globalization;

public sealed class DecimalInputBehavior : Behavior<Entry>
{
    protected override void OnAttachedTo(Entry entry)
    {
        entry.TextChanged += OnTextChanged;
        base.OnAttachedTo(entry);
    }

    protected override void OnDetachingFrom(Entry entry)
    {
        entry.TextChanged -= OnTextChanged;
        base.OnDetachingFrom(entry);
    }

    static void OnTextChanged(object? sender, TextChangedEventArgs e)
    {
        if (sender is not Entry entry || string.IsNullOrEmpty(e.NewTextValue))
            return;

        // Appending "0" lets partial input like "-", "12." or "," pass while typing.
        var candidate = e.NewTextValue + "0";
        var ok = decimal.TryParse(
            candidate,
            NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint,
            CultureInfo.CurrentCulture,
            out _);

        if (!ok)
            entry.Text = e.OldTextValue;
    }
}
```

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.x -->
<Entry Placeholder="Amount" Keyboard="Numeric" ReturnType="Done">
    <Entry.Behaviors>
        <local:DecimalInputBehavior />
    </Entry.Behaviors>
</Entry>
```

Есть две причины делать это в общем слое, а не перехватывать `UITextField.ShouldChangeCharacters` на iOS. `EntryHandler` в MAUI уже владеет этим делегатом, чтобы обеспечивать `MaxLength` (а на iOS 26 использует более новый вариант с несколькими диапазонами), так что его замена молча ломает `MaxLength`. Кроме того, поведение защищает и Android с Windows, где с аппаратной клавиатуры в числовое поле можно ввести что угодно.

Разбор с `CultureInfo.CurrentCulture` важен. На немецком iPad страница цифр показывает запятую, и `"12,5"` должно успешно разбираться. Если ваш бэкенд ожидает инвариантный ввод, преобразуйте значение один раз при чтении, а не во время ввода.

## Исправление 3: верните клавишу Done на iPad

С `DecimalPad` на iPhone `MauiDoneAccessoryView` из MAUI даёт вам кнопку Done, потому что у десятичной панели iPhone нет клавиши return. У `NumbersAndPunctuation` клавиша return есть, так что задайте `ReturnType="Done"` (как в XAML выше) и обработайте `Completed`:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
AmountEntry.Completed += (_, _) =>
{
    AmountEntry.Unfocus();
    // Commit the value, move focus to the next field, etc.
};
```

На iPhone ничего не меняется: маппинг из исправления 1 там никогда не выполняется, десятичная панель остаётся, и панель аксессуаров с Done продолжает работать.

## Включение для отдельных Entry вместо глобального

Глобальный маппинг меняет каждый числовой `Entry` в приложении, включая те, что находятся внутри сторонних элементов управления. Если нужно применить его только к некоторым полям, создайте подкласс `Entry` и проверяйте тип в маппинге:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
public class AmountEntry : Entry
{
    public AmountEntry() => Keyboard = Keyboard.Numeric;
}

#if IOS
EntryHandler.Mapper.AppendToMapping(nameof(IEntry.Keyboard), (handler, entry) =>
{
    if (entry is AmountEntry &&
        UIDevice.CurrentDevice.UserInterfaceIdiom == UIUserInterfaceIdiom.Pad &&
        OperatingSystem.IsIOSVersionAtLeast(26))
    {
        handler.PlatformView.KeyboardType = UIKeyboardType.NumbersAndPunctuation;
        handler.PlatformView.ReloadInputViews();
    }
});
#endif
```

Маппер по-прежнему глобальный (это статический член `EntryHandler`), но проверка типа ограничивает эффект. Это тот же шаблон, который MAUI использует для любой платформенной настройки, не вынесенной в свойство; документация по настройке обработчиков на [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize) подробно описывает порядок выполнения `AppendToMapping`.

## Подводные камни и похожие проблемы

- **`Keyboard.Telephone` сопоставляется с `PhonePad`.** Если поля для телефонных номеров на ваших тестовых iPad показывают ту же плавающую панель, расширьте условие в исправлении 1 до `entry.Keyboard == Keyboard.Numeric || entry.Keyboard == Keyboard.Telephone`. Для телефонных номеров `UIKeyboardType.NumbersAndPunctuation` по-прежнему даёт `+`, `(`, `)` и `-`.
- **`CustomKeyboard` не затронута.** `Keyboard.Create(KeyboardFlags...)` никогда не устанавливает `DecimalPad`, поэтому никогда не вызывает плавающую панель, но и числовую клавиатуру на iOS никогда не даёт. Не используйте её как исправление.
- **"Нет десятичной точки" на iPhone это другая проблема.** На iPhone `DecimalPad` показывает разделитель согласно региональному формату устройства, а не языку приложения. Приложение на американском английском на устройстве с регионом, где используется запятая, покажет запятую. Это не поведение iPadOS 26, и решение здесь в разборе с учётом культуры из исправления 2.
- **Клавиши вводят не те символы (FB21144039).** Этот баг живёт в полной клавиатуре после закрытия плавающей панели. Поскольку с исправлением 1 плавающая панель никогда не появляется, последовательность закрытия и повторного фокуса, которая его вызывает, не происходит. Если у пользователя он всё же возникает, переключение на страницу букв и обратно его сбрасывает.
- **Другие настройки обработчика `Entry`.** Если вы уже добавляете маппинг к `"Keyboard"` где-то ещё (например, для собственной панели инструментов), вызовы `AppendToMapping` выполняются в том порядке, в котором были сделаны. Держите все переопределения клавиатуры в одном месте, чтобы было очевидно, кто пишет последним.

## Связанные материалы

- Тот же подход с маппингом обработчиков исправляет и другие проблемы нативного внешнего вида, например в статье про [изменение цвета иконки SearchBar в .NET MAUI](/ru/2025/04/how-to-change-searchbars-icon-color-in-net-maui/).
- Ещё один сюрприз только для iOS, где исход определяет платформа, а не MAUI: [исправление UIKitThreadAccessException из MediaPicker.PickPhotosAsync на iOS](/ru/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/).
- Если вы всё ещё используете пользовательские рендереры Xamarin.Forms для настройки клавиатуры, [руководство по миграции с Xamarin.Forms на MAUI 11](/ru/2026/05/migrate-from-xamarin-forms-to-maui-11/) показывает, как рендереры соотносятся с мапперами обработчиков.
- Аналог ситуации "ОС изменила внешний вид под моим приложением" на Android: [флаг Material 3 `UseMaterial3` в MAUI 10](/ru/2026/05/maui-10-material-3-android-usematerial3-flag/).
- Полный список изменений MAUI 10 начните с [нового в .NET MAUI 10](/ru/2025/04/whats-new-in-net-maui-10/).

## Источники

- [dotnet/maui#32288: Keyboard Numeric is not working in iOS](https://github.com/dotnet/maui/issues/32288)
- [`KeyboardExtensions.cs` в MAUI для iOS](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) и [`EntryHandler.iOS.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Handlers/Entry/EntryHandler.iOS.cs)
- [Apple Developer Forums: iPad, how to prevent the new floating decimalPad](https://developer.apple.com/forums/thread/801458)
- [Apple Developer Forums: Erratic numberPad keyboard behaviour on iPadOS 26 (FB21144039)](https://developer.apple.com/forums/thread/808114)
- [flutter/flutter#178096: Weird numeric keyboard on iPadOS 26/26.1](https://github.com/flutter/flutter/issues/178096)
- [`UIKeyboardType.decimalPad` в Apple Developer Documentation](https://developer.apple.com/documentation/uikit/uikeyboardtype/decimalpad)
- [Настройка элементов управления .NET MAUI с помощью обработчиков](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize)

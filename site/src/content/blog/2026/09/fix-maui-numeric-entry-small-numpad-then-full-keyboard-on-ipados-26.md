---
title: "Fix: .NET MAUI Entry with Keyboard.Numeric shows a small numpad, then the full keyboard, on iPadOS 26"
description: "On iPadOS 26, MAUI maps Keyboard.Numeric to UIKeyboardType.DecimalPad, which now opens as a floating mini numpad. Append a mapper that switches iPad to NumbersAndPunctuation and filter input yourself."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
---

If an `Entry` with `Keyboard="Numeric"` in .NET MAUI 10 opens a small floating number pad the first time you tap it on an iPad, and then the full-width keyboard on the numbers page the next time (sometimes with no decimal point, no minus sign, or keys that type the wrong digit), MAUI is not switching keyboards on you. iPadOS 26 is. MAUI maps `Keyboard.Numeric` to `UIKeyboardType.DecimalPad`, and on iPadOS 26 that keyboard type is presented as a compact floating keypad when no keyboard is docked yet. The fix that works today is to append to `EntryHandler.Mapper` so numeric entries on iPad get `UIKeyboardType.NumbersAndPunctuation` instead, then validate the text yourself, because that keyboard can also type letters. iPhone is not affected and keeps the regular decimal pad.

## The error in context

There is no exception. The symptom is a keyboard that changes shape between focus events. On an iPad running iPadOS 26.0 or 26.1 with a plain MAUI numeric `Entry`:

```text
// .NET 10, Microsoft.Maui.Controls 10.0.x, iPad (10th gen), iPadOS 26.1
1st tap on Entry   -> small floating number pad (digits + decimal key), no Done bar
tap outside        -> keypad dismisses
2nd tap on Entry   -> full-width keyboard, numbers-and-symbols page
type "12.5"        -> field shows unexpected characters on some devices
switch to ABC page and back to 123 -> digits register correctly again
```

People searching for this usually describe one slice of it: "Keyboard.Numeric not working on iOS", "no decimal point on iPad numeric keyboard", "numeric keypad floating on iPad", "MAUI Done button missing on iPad", or "numbers type random characters on iPad". The MAUI tracking issue is [dotnet/maui#32288](https://github.com/dotnet/maui/issues/32288) (iPad 8th gen, iOS 26.0.1, MAUI 10.0.0-rc.2, flagged as a regression and still open in the backlog). The same behavior shows up in Flutter as [flutter/flutter#178096](https://github.com/flutter/flutter/issues/178096) and in native UIKit apps, which is the tell that this is not a MAUI bug.

## Why iPadOS 26 swaps the keyboard under a MAUI numeric Entry

MAUI's iOS keyboard mapping is short. In [`KeyboardExtensions.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) on `main`, `ApplyKeyboard` does this for the numeric case:

```csharp
// .NET MAUI main (10.0.x and 11 previews), src/Core/src/Platform/iOS/KeyboardExtensions.cs
else if (keyboard == Keyboard.Numeric)
    textInput.SetKeyboardType(UIKeyboardType.DecimalPad);
else if (keyboard == Keyboard.Telephone)
    textInput.SetKeyboardType(UIKeyboardType.PhonePad);
```

Before iPadOS 26, `DecimalPad` on an iPad simply opened the regular full keyboard on its numbers page, because iPad never had a dedicated number pad. iPadOS 26 changed that: `decimalPad` and `numberPad` now present a compact, floating number-only panel. Developers hit three separate problems with it:

1. **The floating pad appears only when no keyboard is docked.** If the user was typing in a text field and moves focus to the numeric field, the docked keyboard stays up and flips to its numbers page. If the numeric field is the first responder, you get the floating pad. The Flutter issue documents exactly this: it works when focus moves from a text field and misbehaves when the numeric field is focused first. That is why the keyboard looks like it "switches" depending on what the user tapped before.
2. **The floating pad hides `inputAccessoryView`.** MAUI attaches its own `MauiDoneAccessoryView` to every iOS `Entry` in `EntryHandler.CreatePlatformView()`. The [Apple Developer Forums thread 801458](https://developer.apple.com/forums/thread/801458) reports that the floating keypad does not show the accessory toolbar, so your Done bar, and any custom Next/Previous toolbar, disappears.
3. **Dismiss-and-refocus produces the full keyboard with bad input.** [Thread 808114](https://developer.apple.com/forums/thread/808114) (FB21144039) reproduces it in Apple's own Contacts app on iPadOS 26.0 through 26.1: tap a numeric field, get the small pad, dismiss it, tap again, get the full keyboard on the numbers page, and the keys register the wrong characters until you switch to the letters page and back.

None of this is under MAUI's control, and there is no UIKit API to opt out of the floating keypad. What you can control is which `UIKeyboardType` the text field asks for.

## Minimal repro

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

Launch the app, tap "Amount" first: floating numpad. Tap outside, tap "Amount" again: full keyboard. Now tap "Notes" first, then "Amount": docked keyboard on the numbers page, no floating pad. Same code, three different keyboards, decided entirely by focus history.

## Fix 1: map numeric entries to NumbersAndPunctuation on iPad

This is the workaround the Apple forum converged on, translated to a MAUI handler mapping. `NumbersAndPunctuation` always docks, keeps the accessory view visible, has a decimal separator and a minus sign, and has behaved the same way on iPad for many iOS releases.

Add this to `MauiProgram.cs`:

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

Three details matter here:

- **Use `AppendToMapping` with the key `"Keyboard"`.** `AppendToMapping` chains your action after the existing mapping for that key, so MAUI first runs `UpdateKeyboard` (which sets `DecimalPad`, prediction and spellcheck flags, then calls `ReloadInputViews`), and your action then overrides the keyboard type. If you use `ModifyMapping` or `PrependToMapping` instead, MAUI's mapping runs last and puts `DecimalPad` back. Any later change to `Entry.Keyboard` re-runs the chain, so a keyboard set from a binding or a trigger stays fixed too.
- **Call `ReloadInputViews()` yourself.** If the property changes while the field is already focused, UIKit will not swap the keyboard until the text field is asked to reload its input views.
- **Guard with `#if IOS`, not `#if IOS || MACCATALYST`.** Mac Catalyst uses a hardware keyboard and has no floating numpad problem. The `IOS` symbol is not defined for the `net10.0-maccatalyst` target, so this code stays out of the Mac build.

`OperatingSystem.IsIOSVersionAtLeast(26)` returns `true` on iPadOS because iPadOS reports itself as iOS. The version check keeps iPads still on iPadOS 18 on the old, correct `DecimalPad` path. I deliberately did not add an upper bound: Apple has not documented a change in behavior, so re-test on each new iPadOS release before you remove the mapping rather than guessing a version where it goes away.

## Fix 2: validate the text, because NumbersAndPunctuation is not numeric-only

`NumbersAndPunctuation` is the numbers page of the full keyboard. The user can tap "ABC" and type letters, and they can type several decimal separators. `DecimalPad` never let that happen, so code that did `decimal.Parse(entry.Text)` without a guard will start throwing `FormatException`.

A small behavior that rejects anything that cannot become a number fixes it:

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

Two reasons to do this in the shared layer instead of hooking `UITextField.ShouldChangeCharacters` on iOS: MAUI's `EntryHandler` already owns that delegate to enforce `MaxLength` (and on iOS 26 it uses the newer multi-range variant), so replacing it silently breaks `MaxLength`. And the behavior protects Android and Windows too, where a hardware keyboard can type anything into a numeric field.

Parsing with `CultureInfo.CurrentCulture` matters. On a German iPad the numbers page shows a comma, and `"12,5"` must parse. If your backend expects invariant input, convert once when you read the value, not while the user types.

## Fix 3: restore the Done key on iPad

With `DecimalPad` on iPhone, MAUI's `MauiDoneAccessoryView` gives you a Done button, because the iPhone decimal pad has no return key. `NumbersAndPunctuation` has a return key, so set `ReturnType="Done"` (as in the XAML above) and handle `Completed`:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
AmountEntry.Completed += (_, _) =>
{
    AmountEntry.Unfocus();
    // Commit the value, move focus to the next field, etc.
};
```

On iPhone nothing changes: the mapping in Fix 1 never runs there, the decimal pad stays, and the accessory Done bar keeps working.

## Opting in per Entry instead of globally

A global mapping changes every numeric `Entry` in the app, including ones inside third-party controls. If you only want it on some fields, subclass `Entry` and check the type in the mapping:

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

The mapper is still global (it is a static on `EntryHandler`), but the type check scopes the effect. This is the same pattern MAUI uses for any platform tweak it does not expose as a property; the handler customization docs on [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize) cover the `AppendToMapping` ordering in detail.

## Gotchas and lookalikes

- **`Keyboard.Telephone` maps to `PhonePad`.** If your phone number fields show the same floating pad on your test iPads, extend the condition in Fix 1 to `entry.Keyboard == Keyboard.Numeric || entry.Keyboard == Keyboard.Telephone`. For phone numbers, `UIKeyboardType.NumbersAndPunctuation` still gives you `+`, `(`, `)` and `-`.
- **A `CustomKeyboard` is not affected.** `Keyboard.Create(KeyboardFlags...)` never sets `DecimalPad`, so it never triggers the floating pad, and it also never gives you a numeric keyboard on iOS. Do not reach for it as a fix.
- **"No decimal point" on iPhone is a different problem.** On iPhone, `DecimalPad` shows the separator for the device's region format, not the app language. A US English app on a device set to a comma region shows a comma. That is not iPadOS 26 behavior, and Fix 2's culture-aware parse is the answer there.
- **Keys typing the wrong characters (FB21144039).** That bug lives in the full keyboard after the floating pad was dismissed. Because Fix 1 never shows the floating pad, the dismiss-and-refocus sequence that triggers it does not happen. If a user has it anyway, switching to the letters page and back resets it.
- **Other `Entry` handler customizations.** If you already append to `"Keyboard"` somewhere else (for example to add a custom toolbar), the order of `AppendToMapping` calls is the order they run. Keep all keyboard overrides in one place so the last writer is obvious.

## Related

- The same handler-mapping approach is what fixes other native look-and-feel issues, like the one in [changing the SearchBar icon color in .NET MAUI](/2025/04/how-to-change-searchbars-icon-color-in-net-maui/).
- For another iOS-only surprise where the platform, not MAUI, decides the outcome, see [fixing UIKitThreadAccessException from MediaPicker.PickPhotosAsync on iOS](/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/).
- If you are still on Xamarin.Forms custom renderers for keyboard tweaks, [the Xamarin.Forms to MAUI 11 migration guide](/2026/05/migrate-from-xamarin-forms-to-maui-11/) shows how renderers map to handler mappers.
- The Android counterpart of "the OS changed the look under my app" is [the Material 3 `UseMaterial3` flag in MAUI 10](/2026/05/maui-10-material-3-android-usematerial3-flag/).
- For the broader list of MAUI 10 changes, start with [what's new in .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/).

## Sources

- [dotnet/maui#32288: Keyboard Numeric is not working in iOS](https://github.com/dotnet/maui/issues/32288)
- [MAUI `KeyboardExtensions.cs` on iOS](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) and [`EntryHandler.iOS.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Handlers/Entry/EntryHandler.iOS.cs)
- [Apple Developer Forums: iPad, how to prevent the new floating decimalPad](https://developer.apple.com/forums/thread/801458)
- [Apple Developer Forums: Erratic numberPad keyboard behaviour on iPadOS 26 (FB21144039)](https://developer.apple.com/forums/thread/808114)
- [flutter/flutter#178096: Weird numeric keyboard on iPadOS 26/26.1](https://github.com/flutter/flutter/issues/178096)
- [`UIKeyboardType.decimalPad` on Apple Developer Documentation](https://developer.apple.com/documentation/uikit/uikeyboardtype/decimalpad)
- [Customize .NET MAUI controls with handlers](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize)

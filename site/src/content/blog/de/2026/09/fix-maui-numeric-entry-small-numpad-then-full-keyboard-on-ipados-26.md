---
title: "Fix: .NET MAUI Entry mit Keyboard.Numeric zeigt unter iPadOS 26 erst einen kleinen Ziffernblock, dann die volle Tastatur"
description: "Unter iPadOS 26 bildet MAUI Keyboard.Numeric auf UIKeyboardType.DecimalPad ab, das sich jetzt als schwebender Mini-Ziffernblock öffnet. Hängen Sie einen Mapper an, der auf dem iPad auf NumbersAndPunctuation umschaltet, und filtern Sie die Eingabe selbst."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
lang: "de"
translationOf: "2026/09/fix-maui-numeric-entry-small-numpad-then-full-keyboard-on-ipados-26"
translatedBy: "claude"
translationDate: 2026-09-28
---

Wenn ein `Entry` mit `Keyboard="Numeric"` in .NET MAUI 10 beim ersten Antippen auf einem iPad einen kleinen schwebenden Ziffernblock öffnet und beim nächsten Mal die Tastatur in voller Breite auf der Zahlenseite (manchmal ohne Dezimaltrennzeichen, ohne Minuszeichen oder mit Tasten, die die falsche Ziffer eingeben), dann wechselt nicht MAUI die Tastatur. Das tut iPadOS 26. MAUI bildet `Keyboard.Numeric` auf `UIKeyboardType.DecimalPad` ab, und unter iPadOS 26 wird dieser Tastaturtyp als kompakter schwebender Ziffernblock dargestellt, solange noch keine Tastatur angedockt ist. Der Fix, der heute funktioniert: an `EntryHandler.Mapper` anhängen, sodass numerische Eingabefelder auf dem iPad stattdessen `UIKeyboardType.NumbersAndPunctuation` erhalten, und den Text anschließend selbst validieren, weil diese Tastatur auch Buchstaben eingeben kann. Das iPhone ist nicht betroffen und behält den normalen Dezimalblock.

## Der Fehler im Kontext

Es gibt keine Exception. Das Symptom ist eine Tastatur, die zwischen Fokusereignissen ihre Form ändert. Auf einem iPad mit iPadOS 26.0 oder 26.1 und einem einfachen numerischen MAUI-`Entry`:

```text
// .NET 10, Microsoft.Maui.Controls 10.0.x, iPad (10th gen), iPadOS 26.1
1st tap on Entry   -> small floating number pad (digits + decimal key), no Done bar
tap outside        -> keypad dismisses
2nd tap on Entry   -> full-width keyboard, numbers-and-symbols page
type "12.5"        -> field shows unexpected characters on some devices
switch to ABC page and back to 123 -> digits register correctly again
```

Wer danach sucht, beschreibt meist nur einen Ausschnitt davon: "Keyboard.Numeric not working on iOS", "no decimal point on iPad numeric keyboard", "numeric keypad floating on iPad", "MAUI Done button missing on iPad" oder "numbers type random characters on iPad". Das MAUI-Tracking-Issue ist [dotnet/maui#32288](https://github.com/dotnet/maui/issues/32288) (iPad 8. Generation, iOS 26.0.1, MAUI 10.0.0-rc.2, als Regression markiert und noch offen im Backlog). Dasselbe Verhalten tritt in Flutter als [flutter/flutter#178096](https://github.com/flutter/flutter/issues/178096) und in nativen UIKit-Apps auf, und genau daran erkennt man, dass es kein MAUI-Bug ist.

## Warum iPadOS 26 die Tastatur unter einem numerischen MAUI-Entry austauscht

Die iOS-Tastaturzuordnung von MAUI ist kurz. In [`KeyboardExtensions.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) auf `main` macht `ApplyKeyboard` für den numerischen Fall Folgendes:

```csharp
// .NET MAUI main (10.0.x and 11 previews), src/Core/src/Platform/iOS/KeyboardExtensions.cs
else if (keyboard == Keyboard.Numeric)
    textInput.SetKeyboardType(UIKeyboardType.DecimalPad);
else if (keyboard == Keyboard.Telephone)
    textInput.SetKeyboardType(UIKeyboardType.PhonePad);
```

Vor iPadOS 26 öffnete `DecimalPad` auf einem iPad einfach die normale volle Tastatur auf ihrer Zahlenseite, weil das iPad nie einen eigenen Ziffernblock hatte. iPadOS 26 hat das geändert: `decimalPad` und `numberPad` zeigen jetzt ein kompaktes, schwebendes Panel nur mit Ziffern. Entwickler stoßen dabei auf drei getrennte Probleme:

1. **Der schwebende Block erscheint nur, wenn keine Tastatur angedockt ist.** Tippt der Benutzer gerade in einem Textfeld und wechselt dann den Fokus in das numerische Feld, bleibt die angedockte Tastatur stehen und springt auf ihre Zahlenseite. Ist das numerische Feld der erste Responder, erscheint der schwebende Block. Das Flutter-Issue dokumentiert genau das: Es funktioniert, wenn der Fokus von einem Textfeld kommt, und verhält sich falsch, wenn das numerische Feld zuerst fokussiert wird. Deshalb sieht es so aus, als würde die Tastatur je nachdem, was der Benutzer vorher angetippt hat, "umschalten".
2. **Der schwebende Block blendet `inputAccessoryView` aus.** MAUI hängt in `EntryHandler.CreatePlatformView()` an jedes iOS-`Entry` seine eigene `MauiDoneAccessoryView`. Der [Apple-Developer-Forums-Thread 801458](https://developer.apple.com/forums/thread/801458) berichtet, dass der schwebende Ziffernblock die Zubehör-Toolbar nicht anzeigt, sodass Ihre Done-Leiste und jede eigene Next/Previous-Toolbar verschwinden.
3. **Schließen und erneutes Fokussieren liefert die volle Tastatur mit fehlerhafter Eingabe.** [Thread 808114](https://developer.apple.com/forums/thread/808114) (FB21144039) reproduziert das in Apples eigener Kontakte-App unter iPadOS 26.0 bis 26.1: ein numerisches Feld antippen, den kleinen Block erhalten, ihn schließen, erneut antippen, die volle Tastatur auf der Zahlenseite erhalten, und die Tasten geben die falschen Zeichen ein, bis man zur Buchstabenseite und zurück wechselt.

Nichts davon liegt in der Hand von MAUI, und es gibt keine UIKit-API, um den schwebenden Ziffernblock abzuschalten. Kontrollieren können Sie, welchen `UIKeyboardType` das Textfeld anfordert.

## Minimale Reproduktion

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

Starten Sie die App und tippen Sie zuerst auf "Amount": schwebender Ziffernblock. Außerhalb tippen, erneut auf "Amount" tippen: volle Tastatur. Jetzt zuerst auf "Notes", dann auf "Amount" tippen: angedockte Tastatur auf der Zahlenseite, kein schwebender Block. Derselbe Code, drei verschiedene Tastaturen, entschieden allein durch die Fokushistorie.

## Fix 1: numerische Eingabefelder auf dem iPad auf NumbersAndPunctuation abbilden

Das ist der Workaround, auf den sich das Apple-Forum geeinigt hat, übertragen auf ein MAUI-Handler-Mapping. `NumbersAndPunctuation` dockt immer an, lässt die Zubehöransicht sichtbar, hat ein Dezimaltrennzeichen und ein Minuszeichen und verhält sich auf dem iPad seit vielen iOS-Versionen gleich.

Fügen Sie Folgendes zu `MauiProgram.cs` hinzu:

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

Drei Details sind hier wichtig:

- **Verwenden Sie `AppendToMapping` mit dem Schlüssel `"Keyboard"`.** `AppendToMapping` hängt Ihre Aktion hinter das bestehende Mapping für diesen Schlüssel, sodass MAUI zuerst `UpdateKeyboard` ausführt (das `DecimalPad` sowie die Flags für Vorschläge und Rechtschreibprüfung setzt und dann `ReloadInputViews` aufruft), und Ihre Aktion überschreibt danach den Tastaturtyp. Mit `ModifyMapping` oder `PrependToMapping` läuft das MAUI-Mapping zuletzt und setzt `DecimalPad` wieder. Jede spätere Änderung an `Entry.Keyboard` führt die Kette erneut aus, sodass auch eine per Binding oder Trigger gesetzte Tastatur korrigiert bleibt.
- **Rufen Sie `ReloadInputViews()` selbst auf.** Ändert sich die Eigenschaft, während das Feld bereits fokussiert ist, tauscht UIKit die Tastatur erst aus, wenn das Textfeld aufgefordert wird, seine Eingabeansichten neu zu laden.
- **Schützen Sie den Code mit `#if IOS`, nicht mit `#if IOS || MACCATALYST`.** Mac Catalyst verwendet eine Hardwaretastatur und hat kein Problem mit einem schwebenden Ziffernblock. Das Symbol `IOS` ist für das Ziel `net10.0-maccatalyst` nicht definiert, sodass dieser Code nicht im Mac-Build landet.

`OperatingSystem.IsIOSVersionAtLeast(26)` gibt unter iPadOS `true` zurück, weil sich iPadOS als iOS meldet. Die Versionsprüfung hält iPads, die noch auf iPadOS 18 laufen, auf dem alten, korrekten `DecimalPad`-Pfad. Eine Obergrenze habe ich bewusst nicht eingebaut: Apple hat keine Verhaltensänderung dokumentiert, also testen Sie mit jeder neuen iPadOS-Version erneut, bevor Sie das Mapping entfernen, statt eine Version zu raten, ab der das Problem verschwindet.

## Fix 2: den Text validieren, weil NumbersAndPunctuation nicht nur Ziffern zulässt

`NumbersAndPunctuation` ist die Zahlenseite der vollen Tastatur. Der Benutzer kann auf "ABC" tippen und Buchstaben eingeben, und er kann mehrere Dezimaltrennzeichen eingeben. `DecimalPad` hat das nie zugelassen, daher wird Code, der ohne Absicherung `decimal.Parse(entry.Text)` aufgerufen hat, anfangen, `FormatException` zu werfen.

Ein kleines Behavior, das alles ablehnt, was keine Zahl werden kann, behebt das:

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

Zwei Gründe sprechen dafür, das in der gemeinsamen Schicht zu tun, statt unter iOS `UITextField.ShouldChangeCharacters` einzuhängen: Der `EntryHandler` von MAUI besitzt diesen Delegate bereits, um `MaxLength` durchzusetzen (und unter iOS 26 nutzt er die neuere Variante mit mehreren Bereichen), sodass ein Ersetzen `MaxLength` stillschweigend bricht. Außerdem schützt das Behavior auch Android und Windows, wo eine Hardwaretastatur beliebige Zeichen in ein numerisches Feld eingeben kann.

Das Parsen mit `CultureInfo.CurrentCulture` ist wichtig. Auf einem deutschen iPad zeigt die Zahlenseite ein Komma, und `"12,5"` muss sich parsen lassen. Erwartet Ihr Backend kulturunabhängige Eingaben, konvertieren Sie einmal beim Auslesen des Werts, nicht während der Benutzer tippt.

## Fix 3: die Done-Taste auf dem iPad wiederherstellen

Mit `DecimalPad` auf dem iPhone liefert die `MauiDoneAccessoryView` von MAUI eine Done-Schaltfläche, weil der Dezimalblock des iPhone keine Eingabetaste hat. `NumbersAndPunctuation` hat eine Eingabetaste, also setzen Sie `ReturnType="Done"` (wie im XAML oben) und behandeln `Completed`:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
AmountEntry.Completed += (_, _) =>
{
    AmountEntry.Unfocus();
    // Commit the value, move focus to the next field, etc.
};
```

Auf dem iPhone ändert sich nichts: Das Mapping aus Fix 1 läuft dort nie, der Dezimalblock bleibt, und die Done-Zubehörleiste funktioniert weiter.

## Opt-in pro Entry statt global

Ein globales Mapping ändert jedes numerische `Entry` in der App, auch solche in Steuerelementen von Drittanbietern. Wenn Sie es nur für einige Felder möchten, leiten Sie von `Entry` ab und prüfen den Typ im Mapping:

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

Der Mapper ist weiterhin global (er ist ein statisches Member von `EntryHandler`), aber die Typprüfung begrenzt die Wirkung. Das ist dasselbe Muster, das MAUI für jede Plattformanpassung verwendet, die es nicht als Eigenschaft bereitstellt; die Dokumentation zur Handler-Anpassung auf [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize) behandelt die Reihenfolge von `AppendToMapping` im Detail.

## Stolperfallen und ähnliche Fehlerbilder

- **`Keyboard.Telephone` wird auf `PhonePad` abgebildet.** Wenn Ihre Telefonnummernfelder auf Ihren Test-iPads denselben schwebenden Block zeigen, erweitern Sie die Bedingung in Fix 1 auf `entry.Keyboard == Keyboard.Numeric || entry.Keyboard == Keyboard.Telephone`. Für Telefonnummern liefert `UIKeyboardType.NumbersAndPunctuation` weiterhin `+`, `(`, `)` und `-`.
- **Ein `CustomKeyboard` ist nicht betroffen.** `Keyboard.Create(KeyboardFlags...)` setzt nie `DecimalPad`, löst also nie den schwebenden Block aus, liefert unter iOS aber auch nie eine numerische Tastatur. Greifen Sie nicht darauf als Fix zurück.
- **"Kein Dezimaltrennzeichen" auf dem iPhone ist ein anderes Problem.** Auf dem iPhone zeigt `DecimalPad` das Trennzeichen des Regionsformats des Geräts, nicht der App-Sprache. Eine US-englische App auf einem Gerät mit Komma-Region zeigt ein Komma. Das ist kein iPadOS-26-Verhalten, und das kulturbewusste Parsen aus Fix 2 ist dort die Lösung.
- **Tasten, die falsche Zeichen eingeben (FB21144039).** Dieser Bug steckt in der vollen Tastatur, nachdem der schwebende Block geschlossen wurde. Da Fix 1 den schwebenden Block nie anzeigt, tritt die auslösende Abfolge aus Schließen und erneutem Fokussieren nicht auf. Hat ein Benutzer ihn trotzdem, setzt ein Wechsel zur Buchstabenseite und zurück ihn zurück.
- **Andere Anpassungen am `Entry`-Handler.** Wenn Sie an anderer Stelle bereits an `"Keyboard"` anhängen (etwa um eine eigene Toolbar hinzuzufügen), bestimmt die Reihenfolge der `AppendToMapping`-Aufrufe die Ausführungsreihenfolge. Halten Sie alle Tastatur-Overrides an einem Ort, damit klar ist, wer zuletzt schreibt.

## Verwandte Artikel

- Derselbe Handler-Mapping-Ansatz behebt auch andere Probleme mit dem nativen Look-and-Feel, etwa beim [Ändern der Symbolfarbe der SearchBar in .NET MAUI](/de/2025/04/how-to-change-searchbars-icon-color-in-net-maui/).
- Für eine weitere reine iOS-Überraschung, bei der die Plattform und nicht MAUI über das Ergebnis entscheidet, siehe [UIKitThreadAccessException aus MediaPicker.PickPhotosAsync unter iOS beheben](/de/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/).
- Wenn Sie für Tastaturanpassungen noch Custom Renderer aus Xamarin.Forms verwenden, zeigt [der Migrationsleitfaden von Xamarin.Forms zu MAUI 11](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/), wie Renderer auf Handler-Mapper abgebildet werden.
- Das Android-Gegenstück zu "das Betriebssystem hat das Aussehen unter meiner App geändert" ist [das Material-3-Flag `UseMaterial3` in MAUI 10](/de/2026/05/maui-10-material-3-android-usematerial3-flag/).
- Für die umfassendere Liste der Änderungen in MAUI 10 beginnen Sie mit [Neuerungen in .NET MAUI 10](/de/2025/04/whats-new-in-net-maui-10/).

## Quellen

- [dotnet/maui#32288: Keyboard Numeric is not working in iOS](https://github.com/dotnet/maui/issues/32288)
- [MAUI `KeyboardExtensions.cs` unter iOS](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) und [`EntryHandler.iOS.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Handlers/Entry/EntryHandler.iOS.cs)
- [Apple Developer Forums: iPad, how to prevent the new floating decimalPad](https://developer.apple.com/forums/thread/801458)
- [Apple Developer Forums: Erratic numberPad keyboard behaviour on iPadOS 26 (FB21144039)](https://developer.apple.com/forums/thread/808114)
- [flutter/flutter#178096: Weird numeric keyboard on iPadOS 26/26.1](https://github.com/flutter/flutter/issues/178096)
- [`UIKeyboardType.decimalPad` in der Apple Developer Documentation](https://developer.apple.com/documentation/uikit/uikeyboardtype/decimalpad)
- [.NET MAUI-Steuerelemente mit Handlern anpassen](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize)

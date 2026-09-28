---
title: "Solución: un Entry de .NET MAUI con Keyboard.Numeric muestra un teclado numérico pequeño y luego el teclado completo en iPadOS 26"
description: "En iPadOS 26, MAUI asigna Keyboard.Numeric a UIKeyboardType.DecimalPad, que ahora se abre como un mini teclado numérico flotante. Agrega un mapper que cambie el iPad a NumbersAndPunctuation y valida la entrada tú mismo."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
lang: "es"
translationOf: "2026/09/fix-maui-numeric-entry-small-numpad-then-full-keyboard-on-ipados-26"
translatedBy: "claude"
translationDate: 2026-09-28
---

Si un `Entry` con `Keyboard="Numeric"` en .NET MAUI 10 abre un pequeño teclado numérico flotante la primera vez que lo tocas en un iPad, y luego el teclado de ancho completo en la página de números la siguiente vez (a veces sin punto decimal, sin signo menos, o con teclas que escriben el dígito equivocado), no es MAUI quien te cambia el teclado. Es iPadOS 26. MAUI asigna `Keyboard.Numeric` a `UIKeyboardType.DecimalPad`, y en iPadOS 26 ese tipo de teclado se presenta como un teclado compacto flotante cuando todavía no hay ningún teclado acoplado. La solución que funciona hoy es agregar una acción a `EntryHandler.Mapper` para que los campos numéricos en iPad reciban `UIKeyboardType.NumbersAndPunctuation`, y luego validar el texto tú mismo, porque ese teclado también puede escribir letras. El iPhone no está afectado y mantiene el teclado decimal normal.

## El error en contexto

No hay ninguna excepción. El síntoma es un teclado que cambia de forma entre eventos de foco. En un iPad con iPadOS 26.0 o 26.1 y un `Entry` numérico simple de MAUI:

```text
// .NET 10, Microsoft.Maui.Controls 10.0.x, iPad (10th gen), iPadOS 26.1
1st tap on Entry   -> small floating number pad (digits + decimal key), no Done bar
tap outside        -> keypad dismisses
2nd tap on Entry   -> full-width keyboard, numbers-and-symbols page
type "12.5"        -> field shows unexpected characters on some devices
switch to ABC page and back to 123 -> digits register correctly again
```

Quienes buscan esto suelen describir solo una parte: "Keyboard.Numeric not working on iOS", "no decimal point on iPad numeric keyboard", "numeric keypad floating on iPad", "MAUI Done button missing on iPad" o "numbers type random characters on iPad". El issue de seguimiento de MAUI es [dotnet/maui#32288](https://github.com/dotnet/maui/issues/32288) (iPad de 8.ª generación, iOS 26.0.1, MAUI 10.0.0-rc.2, marcado como regresión y todavía abierto en el backlog). El mismo comportamiento aparece en Flutter como [flutter/flutter#178096](https://github.com/flutter/flutter/issues/178096) y en aplicaciones nativas de UIKit, lo que indica que no es un bug de MAUI.

## Por qué iPadOS 26 cambia el teclado bajo un Entry numérico de MAUI

La asignación de teclados de MAUI en iOS es corta. En [`KeyboardExtensions.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) en `main`, `ApplyKeyboard` hace esto para el caso numérico:

```csharp
// .NET MAUI main (10.0.x and 11 previews), src/Core/src/Platform/iOS/KeyboardExtensions.cs
else if (keyboard == Keyboard.Numeric)
    textInput.SetKeyboardType(UIKeyboardType.DecimalPad);
else if (keyboard == Keyboard.Telephone)
    textInput.SetKeyboardType(UIKeyboardType.PhonePad);
```

Antes de iPadOS 26, `DecimalPad` en un iPad simplemente abría el teclado completo normal en su página de números, porque el iPad nunca tuvo un teclado numérico dedicado. iPadOS 26 cambió eso: `decimalPad` y `numberPad` ahora presentan un panel compacto y flotante solo con números. Los desarrolladores se toparon con tres problemas distintos:

1. **El teclado flotante aparece solo cuando no hay ningún teclado acoplado.** Si el usuario estaba escribiendo en un campo de texto y mueve el foco al campo numérico, el teclado acoplado se queda y pasa a su página de números. Si el campo numérico es el primer respondedor, obtienes el teclado flotante. El issue de Flutter documenta exactamente esto: funciona cuando el foco viene de un campo de texto y falla cuando el campo numérico recibe el foco primero. Por eso parece que el teclado "cambia" según lo que el usuario tocó antes.
2. **El teclado flotante oculta `inputAccessoryView`.** MAUI adjunta su propio `MauiDoneAccessoryView` a cada `Entry` de iOS en `EntryHandler.CreatePlatformView()`. El [hilo 801458 de los Apple Developer Forums](https://developer.apple.com/forums/thread/801458) reporta que el teclado flotante no muestra la barra de accesorios, así que tu barra Done, y cualquier barra personalizada de Next/Previous, desaparece.
3. **Descartar y volver a enfocar produce el teclado completo con entrada incorrecta.** El [hilo 808114](https://developer.apple.com/forums/thread/808114) (FB21144039) lo reproduce en la propia app Contactos de Apple en iPadOS 26.0 a 26.1: tocas un campo numérico, aparece el teclado pequeño, lo descartas, vuelves a tocar, aparece el teclado completo en la página de números, y las teclas registran caracteres equivocados hasta que cambias a la página de letras y regresas.

Nada de esto está bajo el control de MAUI, y no existe ninguna API de UIKit para desactivar el teclado flotante. Lo que sí puedes controlar es qué `UIKeyboardType` solicita el campo de texto.

## Reproducción mínima

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

Inicia la app y toca "Amount" primero: teclado numérico flotante. Toca afuera y vuelve a tocar "Amount": teclado completo. Ahora toca "Notes" primero y luego "Amount": teclado acoplado en la página de números, sin teclado flotante. El mismo código, tres teclados distintos, decididos por completo por el historial de foco.

## Solución 1: asignar los campos numéricos a NumbersAndPunctuation en iPad

Esta es la solución alternativa a la que llegó el foro de Apple, traducida a un mapping de handler de MAUI. `NumbersAndPunctuation` siempre se acopla, mantiene visible la vista de accesorios, tiene separador decimal y signo menos, y se ha comportado igual en iPad durante muchas versiones de iOS.

Agrega esto a `MauiProgram.cs`:

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

Aquí importan tres detalles:

- **Usa `AppendToMapping` con la clave `"Keyboard"`.** `AppendToMapping` encadena tu acción después del mapping existente para esa clave, así que MAUI ejecuta primero `UpdateKeyboard` (que establece `DecimalPad`, los flags de predicción y corrección ortográfica, y luego llama a `ReloadInputViews`), y después tu acción sobrescribe el tipo de teclado. Si usas `ModifyMapping` o `PrependToMapping`, el mapping de MAUI se ejecuta al final y vuelve a poner `DecimalPad`. Cualquier cambio posterior a `Entry.Keyboard` vuelve a ejecutar la cadena, así que un teclado establecido desde un binding o un trigger también queda corregido.
- **Llama a `ReloadInputViews()` tú mismo.** Si la propiedad cambia mientras el campo ya tiene el foco, UIKit no cambiará el teclado hasta que se le pida al campo de texto que recargue sus vistas de entrada.
- **Protege el código con `#if IOS`, no con `#if IOS || MACCATALYST`.** Mac Catalyst usa un teclado físico y no tiene el problema del teclado flotante. El símbolo `IOS` no está definido para el target `net10.0-maccatalyst`, así que este código queda fuera de la compilación para Mac.

`OperatingSystem.IsIOSVersionAtLeast(26)` devuelve `true` en iPadOS porque iPadOS se identifica como iOS. La comprobación de versión mantiene a los iPads que siguen en iPadOS 18 en la ruta anterior y correcta de `DecimalPad`. No agregué a propósito un límite superior: Apple no ha documentado ningún cambio de comportamiento, así que vuelve a probar en cada nueva versión de iPadOS antes de quitar el mapping, en lugar de adivinar una versión en la que desaparezca.

## Solución 2: validar el texto, porque NumbersAndPunctuation no es solo numérico

`NumbersAndPunctuation` es la página de números del teclado completo. El usuario puede tocar "ABC" y escribir letras, y puede escribir varios separadores decimales. `DecimalPad` nunca permitía eso, así que el código que hacía `decimal.Parse(entry.Text)` sin ninguna protección empezará a lanzar `FormatException`.

Un pequeño behavior que rechaza todo lo que no pueda convertirse en número lo soluciona:

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

Hay dos razones para hacer esto en la capa compartida en lugar de engancharte a `UITextField.ShouldChangeCharacters` en iOS: el `EntryHandler` de MAUI ya es dueño de ese delegado para aplicar `MaxLength` (y en iOS 26 usa la variante más nueva de múltiples rangos), así que reemplazarlo rompe `MaxLength` sin avisar. Además, el behavior también protege Android y Windows, donde un teclado físico puede escribir cualquier cosa en un campo numérico.

Hacer el parseo con `CultureInfo.CurrentCulture` es importante. En un iPad en alemán la página de números muestra una coma, y `"12,5"` debe poder parsearse. Si tu backend espera entrada invariante, conviértela una sola vez al leer el valor, no mientras el usuario escribe.

## Solución 3: recuperar la tecla Done en iPad

Con `DecimalPad` en iPhone, el `MauiDoneAccessoryView` de MAUI te da un botón Done, porque el teclado decimal del iPhone no tiene tecla de retorno. `NumbersAndPunctuation` sí tiene tecla de retorno, así que establece `ReturnType="Done"` (como en el XAML anterior) y maneja `Completed`:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.x
AmountEntry.Completed += (_, _) =>
{
    AmountEntry.Unfocus();
    // Commit the value, move focus to the next field, etc.
};
```

En iPhone no cambia nada: el mapping de la Solución 1 nunca se ejecuta ahí, el teclado decimal se mantiene y la barra de accesorios con Done sigue funcionando.

## Activarlo por Entry en lugar de globalmente

Un mapping global cambia todos los `Entry` numéricos de la app, incluidos los que están dentro de controles de terceros. Si solo lo quieres en algunos campos, crea una subclase de `Entry` y comprueba el tipo en el mapping:

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

El mapper sigue siendo global (es un miembro estático de `EntryHandler`), pero la comprobación de tipo limita el efecto. Es el mismo patrón que MAUI usa para cualquier ajuste de plataforma que no expone como propiedad; la documentación sobre personalización de handlers en [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize) explica en detalle el orden de `AppendToMapping`.

## Trampas y problemas parecidos

- **`Keyboard.Telephone` se asigna a `PhonePad`.** Si tus campos de número telefónico muestran el mismo teclado flotante en tus iPads de prueba, amplía la condición de la Solución 1 a `entry.Keyboard == Keyboard.Numeric || entry.Keyboard == Keyboard.Telephone`. Para números telefónicos, `UIKeyboardType.NumbersAndPunctuation` sigue ofreciéndote `+`, `(`, `)` y `-`.
- **Un `CustomKeyboard` no está afectado.** `Keyboard.Create(KeyboardFlags...)` nunca establece `DecimalPad`, así que nunca activa el teclado flotante, pero tampoco te da nunca un teclado numérico en iOS. No lo uses como solución.
- **"Sin punto decimal" en iPhone es otro problema.** En iPhone, `DecimalPad` muestra el separador según el formato regional del dispositivo, no el idioma de la app. Una app en inglés de EE. UU. en un dispositivo configurado con una región que usa coma muestra una coma. Eso no es un comportamiento de iPadOS 26, y el parseo consciente de la cultura de la Solución 2 es la respuesta en ese caso.
- **Teclas que escriben caracteres equivocados (FB21144039).** Ese bug vive en el teclado completo después de descartar el teclado flotante. Como la Solución 1 nunca muestra el teclado flotante, la secuencia de descartar y volver a enfocar que lo provoca no ocurre. Si a un usuario le pasa de todos modos, cambiar a la página de letras y regresar lo restablece.
- **Otras personalizaciones del handler de `Entry`.** Si ya agregas acciones a `"Keyboard"` en otro lugar (por ejemplo, para añadir una barra de herramientas personalizada), el orden de las llamadas a `AppendToMapping` es el orden en que se ejecutan. Mantén todas las sobrescrituras del teclado en un solo lugar para que sea evidente cuál escribe al final.

## Relacionado

- El mismo enfoque de mapping de handlers es lo que soluciona otros problemas de apariencia nativa, como el de [cambiar el color del icono del SearchBar en .NET MAUI](/es/2025/04/how-to-change-searchbars-icon-color-in-net-maui/).
- Para otra sorpresa exclusiva de iOS donde la plataforma, y no MAUI, decide el resultado, consulta [cómo solucionar UIKitThreadAccessException de MediaPicker.PickPhotosAsync en iOS](/es/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/).
- Si todavía usas custom renderers de Xamarin.Forms para ajustar el teclado, [la guía de migración de Xamarin.Forms a MAUI 11](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/) muestra cómo los renderers se corresponden con los mappers de handlers.
- La contraparte en Android de "el sistema operativo cambió la apariencia bajo mi app" es [el flag `UseMaterial3` de Material 3 en MAUI 10](/es/2026/05/maui-10-material-3-android-usematerial3-flag/).
- Para la lista más amplia de cambios de MAUI 10, empieza por [las novedades de .NET MAUI 10](/es/2025/04/whats-new-in-net-maui-10/).

## Fuentes

- [dotnet/maui#32288: Keyboard Numeric is not working in iOS](https://github.com/dotnet/maui/issues/32288)
- [`KeyboardExtensions.cs` de MAUI en iOS](https://github.com/dotnet/maui/blob/main/src/Core/src/Platform/iOS/KeyboardExtensions.cs) y [`EntryHandler.iOS.cs`](https://github.com/dotnet/maui/blob/main/src/Core/src/Handlers/Entry/EntryHandler.iOS.cs)
- [Apple Developer Forums: iPad, how to prevent the new floating decimalPad](https://developer.apple.com/forums/thread/801458)
- [Apple Developer Forums: Erratic numberPad keyboard behaviour on iPadOS 26 (FB21144039)](https://developer.apple.com/forums/thread/808114)
- [flutter/flutter#178096: Weird numeric keyboard on iPadOS 26/26.1](https://github.com/flutter/flutter/issues/178096)
- [`UIKeyboardType.decimalPad` en Apple Developer Documentation](https://developer.apple.com/documentation/uikit/uikeyboardtype/decimalpad)
- [Personalizar controles de .NET MAUI con handlers](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize)

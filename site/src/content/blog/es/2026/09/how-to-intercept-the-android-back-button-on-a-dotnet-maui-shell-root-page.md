---
title: "Cómo interceptar el botón atrás de Android en una página raíz de .NET MAUI Shell"
description: "Sobrescribe OnBackButtonPressed en la página raíz y usa .NET MAUI 10.0.101 o posterior. Por qué las páginas raíz dejaron de recibir las pulsaciones de atrás desde 10.0.70 (Android 16) y 10.0.100 (todas las versiones de Android), por qué .NET 11 RC 1 sigue afectado, por qué Shell.OnNavigating y BackButtonBehavior.Command no ayudan, y una solución alternativa en MainActivity para las versiones rotas."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "maui-shell"
  - "predictive-back"
  - "dotnet-10"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/how-to-intercept-the-android-back-button-on-a-dotnet-maui-shell-root-page"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Respuesta corta:** sobrescribe `OnBackButtonPressed()` en la `ContentPage` raíz (o en tu `AppShell`), devuelve `true` para absorber la pulsación y asegúrate de estar en **.NET MAUI 10.0.101** (publicada el 2026-09-07) o posterior. Entre 10.0.70 y 10.0.100, y en .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`), esa sobrescritura nunca se llama en una página raíz: MAUI desactiva su callback de atrás de Android cada vez que cree que no hay nada que sacar de la pila, así que Android envía al usuario a la pantalla de inicio sin consultar a tu código. En Android 16 esto empezó con 10.0.70; en todas las demás versiones de Android empezó con 10.0.100. Si no puedes actualizar, registra tu propio `OnBackPressedCallback` en `MainActivity` (código más abajo). `Shell.OnNavigating` con `ShellNavigationSource.Pop` y `BackButtonBehavior.Command` no interceptan el botón atrás físico ni el gesto de atrás en una página raíz, ni siquiera en 10.0.101.

La corrección de 10.0.101 no está en .NET 11 RC 1. Desde entonces ha llegado a `main` y a la rama `net11.0` (a través del merge de servicio SR10, [dotnet/maui#38301](https://github.com/dotnet/maui/pull/38301)), así que espérala en .NET 11 RC 2.

## Por qué la página raíz dejó de escuchar el botón atrás

Android 16 activa el gesto de atrás predictivo por defecto para las aplicaciones que apuntan a la API 36. Con el atrás predictivo, el sistema decide *antes de que empiece el gesto* si la aplicación quiere el evento de atrás. Si no hay ningún callback habilitado, reproduce la animación de vista previa de vuelta al inicio y envía la tarea a segundo plano. Nunca llama al obsoleto `Activity.OnBackPressed()` y nunca despacha `KeyEvent.KEYCODE_BACK` a `OnKeyDown`.

.NET MAUI solía registrar su callback de atrás de forma incondicional, lo que eliminaba esa animación en todas las aplicaciones MAUI ([dotnet/maui#34594](https://github.com/dotnet/maui/issues/34594)). La corrección, [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), lo reemplazó por un `OnBackPressedCallback` de AndroidX cuyo indicador `Enabled` MAUI recalcula en cada cambio de navegación. `MauiAppCompatActivity` habilita el callback solo cuando `Window.CanConsumeBackNavigation` indica que la página actual puede consumir el atrás:

- hay una página modal en la pila, o
- la pila de navegación de la sección de Shell tiene más de una página, o
- una `NavigationPage` tiene más de una página, o
- hay un flyout abierto que el usuario puede cerrar.

Una `ContentPage` raíz simple no cumple ninguna de esas condiciones, así que el callback queda deshabilitado y la pulsación va directamente al sistema. Tu sobrescritura de `OnBackButtonPressed()` está al final de una cadena (`MauiOnBackPressedCallback` -> `AndroidLifecycle.OnBackPressed` -> `IWindow.BackButtonClicked()` -> `Shell.OnBackButtonPressed()` -> `Page.OnBackButtonPressed()`) que nunca arranca.

¿Por qué se rompió primero Android 16? De 10.0.70 a 10.0.90, `MauiAppCompatActivity` todavía sobrescribía el obsoleto `OnBackPressed()` y ejecutaba desde ahí el manejo de atrás de MAUI de forma incondicional. Los dispositivos que no usan el atrás predictivo (Android 15 y anteriores, salvo que lo hayas activado con `android:enableOnBackInvokedCallback="true"`) seguían entregando la pulsación a través de esa sobrescritura, así que la condición no importaba. 10.0.100 eliminó la sobrescritura y movió todo a `OnBackPressedDispatcher`, así que la condición se aplica en todas las versiones de Android. La clasificación de los issues coincide exactamente con esto: [#37657](https://github.com/dotnet/maui/issues/37657) y [#38030](https://github.com/dotnet/maui/issues/38030) tienen la etiqueta `regressed-in-10.0.70` para Android 16, y [#37706](https://github.com/dotnet/maui/issues/37706) reporta fallos en Android 15 y 17 a partir de 10.0.100.

## Qué cambió 10.0.101, medido

[dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709), portado hacia atrás como [#37729](https://github.com/dotnet/maui/pull/37729), agrega una comprobación al principio de `CanConsumeBackNavigation`: si el `OnBackButtonPressed` efectivo de la página está declarado en cualquier ensamblado distinto de `Microsoft.Maui.Controls`, el callback se habilita. MAUI detecta la sobrescritura a partir del `MethodInfo.DeclaringType` de un delegado, sin invocar tu código. El resultado se almacena en caché por instancia de página.

Quería ver la decisión en sí en lugar de fiarme de la descripción del PR, así que llamé por reflexión al método interno `Window.CanConsumeBackNavigation(Page)` desde una aplicación basada en archivo de .NET 10. Usa la compilación `net10.0` simple de `Microsoft.Maui.Controls`, así que no hace falta emulador:

```csharp
// probe.cs -- dotnet run probe.cs (SDK 10.0.302; net11.0 + SDK 11.0.100-rc.1 for the RC 1 run)
#:package Microsoft.Maui.Controls@10.0.101
#:property PublishAot=false
#:property TargetFramework=net10.0
using System.Reflection;
using Microsoft.Maui.Controls;

var canConsume = typeof(Window).GetMethod("CanConsumeBackNavigation",
    BindingFlags.NonPublic | BindingFlags.Static)!;
bool Check(Page p) => (bool)canConsume.Invoke(null, [p])!;

Console.WriteLine($"root page with override        -> {Check(new OverridePage())}");
Console.WriteLine($"Shell override, plain root     -> {Check(MakeShell(new OverrideShell(), new PlainPage()))}");
Console.WriteLine($"Shell OnNavigating only        -> {Check(MakeShell(new NavigatingShell(), new PlainPage()))}");
// ...plus a plain Shell + plain root, and a root with a BackButtonBehavior.Command

static Shell MakeShell(Shell shell, ContentPage root)
{
    shell.Items.Add(new ShellContent { Content = root });
    return shell;
}

class PlainPage : ContentPage { }
class OverridePage : ContentPage { protected override bool OnBackButtonPressed() => true; }
class OverrideShell : Shell { protected override bool OnBackButtonPressed() => true; }
class NavigatingShell : Shell
{
    protected override void OnNavigating(ShellNavigatingEventArgs args)
    {
        base.OnNavigating(args);
        if (args.Source == ShellNavigationSource.Pop) args.Cancel();
    }
}
```

`True` significa que MAUI habilita su callback en esa página raíz, así que tu código se ejecuta. `False` significa que Android envía la aplicación a segundo plano sin preguntar:

| Configuración de la página raíz | 10.0.90 | 10.0.101 | 11.0.0-rc.1.26451.6 |
|---|---|---|---|
| `ContentPage` simple, sin sobrescrituras | False | False | False |
| `ContentPage` que sobrescribe `OnBackButtonPressed` | False | **True** | False |
| `AppShell` que sobrescribe `OnBackButtonPressed`, raíz simple | False | **True** | False |
| `Shell` simple, página raíz que sobrescribe `OnBackButtonPressed` | False | **True** | False |
| `AppShell` que sobrescribe solo `OnNavigating` (cancela `Pop`) | False | False | False |
| Página raíz con `Command` en `Shell.BackButtonBehavior` | False | False | False |

Esta prueba mide la condición, no una ejecución en dispositivo. Para el resultado en dispositivo, #37709 incluye una verificación en un emulador de Android 16. El equipo de MAUI también confirmó la corrección con la reproducción de pestañas de Shell de #37657, y quien reportó #37706 confirmó que la compilación del PR arreglaba su aplicación con NavigationPage.

## Paso a paso: interceptar la pulsación de atrás en una página raíz

1. **Revisa tu versión de MAUI.** Busca el paquete `Microsoft.Maui.Controls` en tu `.csproj`, o ejecuta `dotnet list package`. Si resuelve a cualquier versión de 10.0.70 a 10.0.100, súbela a 10.0.101 o posterior. En .NET 11 RC 1, usa la solución alternativa del paso 4 hasta RC 2.

   ```xml
   <!-- .NET MAUI 10, MyApp.csproj -->
   <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.101" />
   ```

2. **Sobrescribe `OnBackButtonPressed` en la página que lo necesita.** El método es síncrono, así que devuelve `true` de inmediato y muestra cualquier diálogo de confirmación en el siguiente ciclo del dispatcher. No hagas la sobrescritura `async`: una sobrescritura `async` devuelve `false` en su primer `await`, antes de que el usuario responda.

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- MainPage.xaml.cs (a Shell root page)
   public partial class MainPage : ContentPage
   {
       bool _confirming;

       protected override bool OnBackButtonPressed()
       {
           if (_confirming)
               return true;

           _confirming = true;
           Dispatcher.Dispatch(async () =>
           {
               try
               {
                   bool leave = await DisplayAlertAsync(
                       "Leave the app?", "Unsaved changes will be lost.", "Leave", "Stay");
                   if (leave)
                       LeaveApp();
               }
               finally
               {
                   _confirming = false;
               }
           });
           return true; // swallow this press; the dialog decides what happens next
       }

       static void LeaveApp()
       {
   #if ANDROID
           // Same as Android's own root back since Android 12: background the task, keep the process.
           Platform.CurrentActivity?.MoveTaskToBack(true);
   #endif
       }
   }
   ```

   `MoveTaskToBack(true)` es intencional. `Application.Current.Quit()` en Android llama a `FinishAndRemoveTask()` y luego a `Environment.Exit(0)`, lo que mata el proceso y desperdicia el arranque en caliente que Android te daría en el siguiente inicio.

3. **Para reglas a nivel de pestaña, sobrescribe en `AppShell`.** Un requisito común es "atrás en la raíz de cualquier pestaña vuelve a la primera pestaña, y solo la primera pestaña sale de la aplicación". Eso pertenece al Shell, que ve todas las páginas raíz:

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- AppShell.xaml.cs
   public partial class AppShell : Shell
   {
       protected override bool OnBackButtonPressed()
       {
           var section = CurrentItem?.CurrentItem;
           bool atTabRoot = section is not null && section.Stack.Count <= 1;

           if (atTabRoot && CurrentItem is TabBar tabs && tabs.CurrentItem != tabs.Items[0])
           {
               tabs.CurrentItem = tabs.Items[0];
               return true;
           }

           return base.OnBackButtonPressed(); // pops pages, then raises Navigating(Pop)
       }
   }
   ```

   Devolver `base.OnBackButtonPressed()` conserva el comportamiento normal de Shell. Llama al `OnBackButtonPressed` de la página visible, saca páginas de la pila de la sección si hay algo que sacar y, en caso contrario, lanza `Navigating` con `ShellNavigationSource.Pop` y devuelve `args.Cancelled`. Esto también significa que el patrón documentado de cancelación en `OnNavigating` *sí* funciona en una página raíz una vez que alguna sobrescritura ha habilitado el callback. Por sí solo, nunca se ejecuta.

4. **En 10.0.70 a 10.0.100 o .NET 11 RC 1, agrega tu propio callback en `MainActivity`.** El dispatcher de AndroidX llama primero al callback habilitado agregado más recientemente. Por lo tanto, un callback agregado después de `base.OnCreate` se ejecuta antes que el de MAUI, incluso en los casos en que el callback propio de MAUI está deshabilitado:

   ```csharp
   // .NET MAUI 10.0.70-10.0.100 and 11.0.0-rc.1 only -- Platforms/Android/MainActivity.cs
   using Android.App;
   using Android.Content.PM;
   using Android.OS;
   using AndroidX.Activity;

   [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
       ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                              ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity
   {
       protected override void OnCreate(Bundle? savedInstanceState)
       {
           base.OnCreate(savedInstanceState);
           OnBackPressedDispatcher.AddCallback(this, new RootBackCallback(this));
       }

       sealed class RootBackCallback(MainActivity activity) : OnBackPressedCallback(true)
       {
           public override void HandleOnBackPressed()
           {
               // Runs the same chain MAUI would: modal stack, Shell, then the visible page.
               var window = Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()
                   as Microsoft.Maui.IWindow;
               if (window?.BackButtonClicked() == true)
                   return;

               // Nothing consumed it: step aside and let the system (or MAUI) handle this press.
               Enabled = false;
               try { activity.OnBackPressedDispatcher.OnBackPressed(); }
               finally { Enabled = true; }
           }
       }
   }
   ```

   Esto es un parche de compatibilidad, no un patrón para conservar. El callback está siempre habilitado, así que la animación de vuelta al inicio nunca se reproduce. Además, cuando el callback propio de MAUI también está habilitado (por ejemplo, con un flyout abierto) y ninguna página maneja la pulsación, tu sobrescritura se ejecuta dos veces. Elimina el parche cuando pases a 10.0.101. Dejarlo en 10.0.101 hace que cada pulsación no manejada en una página con sobrescritura pase dos veces por `OnBackButtonPressed`. [#37657](https://github.com/dotnet/maui/issues/37657) tiene una variante más corta que vuelve a entrar en el obsoleto `Activity.OnBackPressed()`. La versión de arriba evita llamar a una API obsoleta desde código nuevo.

5. **Verifica en un dispositivo real con Android 16 o en un emulador con API 36.** Usa tanto la navegación por gestos como la navegación con 3 botones. Desliza desde el borde y mantén el dedo en una página raíz que sobrescribe el método: no deberías ver la vista previa de vuelta al inicio, y al soltar debería ejecutarse tu manejador. En una página raíz sin sobrescritura deberías seguir viendo la animación de vista previa. Así sabes que no has desactivado el atrás predictivo en toda la aplicación.

## Cosas que parece que deberían funcionar pero no funcionan

**`BackButtonBehavior.Command` no es un manejador del botón atrás físico en Android.** `Shell.OnBackButtonPressed` solo ejecuta el comando bajo `#if WINDOWS || !PLATFORM`. En Android, el comando se ejecuta desde `ShellToolbarTracker.OnClick`, es decir, la flecha de la barra de navegación. Una página raíz no tiene flecha de atrás (en un Shell con flyout ese espacio es el menú hamburguesa), así que para la página raíz el comando es irrelevante. La prueba confirma que tampoco habilita el callback.

**Los eventos de ciclo de vida no abren la condición.** `builder.ConfigureLifecycleEvents(e => e.AddAndroid(a => a.OnBackPressed(...)))` registra otro delegado de `AndroidLifecycle.OnBackPressed`. La condición solo comprueba que exista *algún* delegado, y MAUI siempre registra su propio `HandleWindowBackButtonPressed`, así que el tuyo no aporta nada. Cuando la página no puede consumir el atrás, el callback sigue deshabilitado y tu delegado nunca se ejecuta.

**Las sobrescrituras de `OnKeyDown(Keycode.Back, ...)` y `OnBackPressed()` en `MainActivity` son código muerto en Android 16.** La guía de Google sobre el atrás predictivo indica que interceptar eventos de atrás desde `KEYCODE_BACK` "ya no es compatible". La lista de verificación de migración en [apuntar a la API level 36 de Android desde .NET MAUI](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) cubre las demás sobrescrituras que dejan de funcionar al apuntar a 36.

**Cada sobrescritura te cuesta la animación de vuelta al inicio en esa página.** MAUI decide por tipo, no por lo que devuelve tu sobrescritura. En cuanto una página declara `OnBackButtonPressed`, el callback se habilita en esa página aunque el método solo devuelva `base.OnBackButtonPressed()`. Lo mismo aplica a las sobrescrituras heredadas de una clase base fuera de `Microsoft.Maui.Controls`, así que una `BasePage` compartida con una sobrescritura activa el callback en todas las páginas derivadas, y una sobrescritura en `AppShell` lo activa en todas las páginas. La recomendación de Android es habilitar callbacks de atrás solo para lógica de UI (confirmar cambios sin guardar, cerrar un popup dentro de la página) y nunca para registro de eventos o analítica. Pon la sobrescritura en la página más específica que la necesite.

**`android:enableOnBackInvokedCallback="false"` no es una solución.** Desactiva las animaciones de atrás predictivo y hace que `OnBackInvokedCallback` deje de funcionar. Las llamadas a `OnBackPressedCallback`, que es lo que usa MAUI, siguen funcionando. En 10.0.70 a 10.0.90 resulta que vuelve a enrutar el atrás de Android 16 por la ruta heredada. En 10.0.100 ya no queda ninguna sobrescritura heredada, así que no cambia nada respecto a la condición de la página raíz.

**Las páginas modales nunca se vieron afectadas.** Una pila modal no vacía siempre habilita el callback, por eso `protected override bool OnBackButtonPressed() => true;` en una página modal siguió funcionando durante todo esto. Consulta [mostrar una ventana modal en .NET MAUI 11](/es/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).

**No dispares y olvides desde la sobrescritura.** Devolver `true` y luego esperar un diálogo es seguro porque `Dispatcher.Dispatch` ejecuta la lambda en el hilo de UI. Un helper `async void` que lance una excepción seguiría tumbando el proceso. [Encontrar los manejadores `async void` que causan ANR en una aplicación MAUI de Android](/es/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) muestra cómo rastrearlos.

## Lecturas relacionadas

- La navegación hacia atrás que transporta datos (`..?saved=true`) y las propiedades de `BackButtonBehavior`, incluida la `AccessibilityLabel` de .NET MAUI 11, se cubren en [parámetros de ruta y propiedades de consulta de Shell en .NET MAUI 11](/es/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/).
- El paso del atrás predictivo en la migración a la API 36, y la corrección de 10.0.90 que restauró la animación de vuelta al inicio, están en [migrar una aplicación MAUI de Android para apuntar a la API level 36](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Absorber el atrás en una página modal, y por qué una página modal no es una ventana modal, está en [cómo mostrar una ventana modal en .NET MAUI 11](/es/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).
- El patrón del dispatcher del paso 2 es la forma segura del código de disparar y olvidar analizado en [encontrar los manejadores `async void` que causan ANR](/es/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Fuentes

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation) (Microsoft Learn: `BackButtonBehavior`, `Navigating`, `ShellNavigationSource.Pop`, aplazamiento de la navegación)
- [Add support for the predictive back gesture](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture) (Android Developers: cuándo los callbacks desactivan la animación, `KEYCODE_BACK`, `enableOnBackInvokedCallback`)
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223): `OnBackPressedCallback` condicionado para la animación de vuelta al inicio
- [dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709) y el backport a 10.0.101 [#37729](https://github.com/dotnet/maui/pull/37729): `OnBackButtonPressed` en páginas raíz
- Reportes de regresión: [#37657](https://github.com/dotnet/maui/issues/37657) (pestañas de Shell), [#37706](https://github.com/dotnet/maui/issues/37706) (`ContentPage` raíz), [#38030](https://github.com/dotnet/maui/issues/38030) (`FlyoutPage`)
- Código fuente en las etiquetas de versión: [`Window.cs` en 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Window/Window.cs), [`MauiAppCompatActivity.cs` en 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Core/src/Platform/Android/MauiAppCompatActivity.cs), [`Shell.cs` en 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Shell/Shell.cs) y [`Window.cs` en 11.0.100-rc.1.26458.5](https://github.com/dotnet/maui/blob/11.0.100-rc.1.26458.5/src/Controls/src/Core/Window/Window.cs)

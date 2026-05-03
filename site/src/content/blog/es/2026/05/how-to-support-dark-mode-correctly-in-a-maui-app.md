---
title: "Cómo soportar el modo oscuro correctamente en una aplicación .NET MAUI"
description: "Modo oscuro de extremo a extremo en .NET MAUI 11: AppThemeBinding, SetAppThemeColor, RequestedTheme, anulación con UserAppTheme y persistencia, el evento RequestedThemeChanged y los detalles por plataforma de Info.plist y MainActivity que la documentación pasa por alto."
pubDate: 2026-05-03
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "dark-mode"
  - "theming"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-support-dark-mode-correctly-in-a-maui-app"
translatedBy: "claude"
translationDate: 2026-05-03
---

Respuesta corta: en .NET MAUI 11.0.0, vincula cada valor sensible al tema con la extensión de marcado `AppThemeBinding`, organiza los colores claros y oscuros como claves `StaticResource` en `App.xaml`, establece `Application.Current.UserAppTheme = AppTheme.Unspecified` en el arranque para que la aplicación siga al sistema operativo, y persiste cualquier anulación del usuario mediante `Preferences`. En Android también necesitas `ConfigChanges.UiMode` en `MainActivity` para que la actividad no se destruya al cambiar el tema del sistema; en iOS necesitas que `Info.plist` no contenga la clave `UIUserInterfaceStyle` o que tenga el valor `Automatic`, para que el sistema te pueda entregar tanto el tema claro como el oscuro. Recurre a `Application.Current.RequestedThemeChanged` solo cuando tengas que mutar algo de forma imperativa, porque la extensión de marcado ya reevalúa los enlaces.

Este artículo recorre toda la superficie del soporte de tema del sistema en .NET MAUI 11.0.0 sobre .NET 11, incluyendo las partes que duelen en producción: persistencia entre reinicios de la aplicación, configuración por plataforma de `Info.plist` y `MainActivity`, refresco dinámico de recursos al cambiar `Application.Current.UserAppTheme`, colores de la barra de estado y de la pantalla de bienvenida, y el evento `RequestedThemeChanged` que famosamente deja de dispararse si olvidas la marca del manifiesto. Cada fragmento se verificó contra `dotnet new maui` del SDK de .NET 11 con `Microsoft.Maui.Controls` 11.0.0.

## Lo que realmente te dan los sistemas operativos

El modo oscuro no es una sola característica, es la unión de tres comportamientos diferentes que se entregan a nivel de sistema operativo y a los que tienes que suscribirte de forma individual:

1. El sistema operativo informa de un tema actual. iOS 13+ expone `UITraitCollection.UserInterfaceStyle`, Android 10 (API 29)+ expone `Configuration.UI_MODE_NIGHT_MASK`, macOS 10.14+ expone `NSAppearance`, Windows 10+ expone `UISettings.GetColorValue(UIColorType.Background)` más la clave de registro `app-mode`. MAUI normaliza las cuatro en el enum `Microsoft.Maui.ApplicationModel.AppTheme`: `Unspecified`, `Light`, `Dark`.

2. El sistema operativo notifica a la aplicación cuando el usuario activa el interruptor. En iOS llega a través de `traitCollectionDidChange:`, en Android a través de `Activity.OnConfigurationChanged` (solo si te suscribes, ver más abajo), en Windows a través de `UISettings.ColorValuesChanged`. MAUI presenta la unión como el evento estático `Application.RequestedThemeChanged`.

3. El sistema operativo permite a la aplicación anular el tema renderizado. iOS usa `UIWindow.OverrideUserInterfaceStyle`, Android usa `AppCompatDelegate.SetDefaultNightMode`, Windows usa `FrameworkElement.RequestedTheme`. MAUI expone la anulación como la propiedad de lectura/escritura `Application.Current.UserAppTheme`.

Saltarte cualquiera de estas capas te da la versión "se ve bien en el simulador y se rompe en el celular del usuario" del modo oscuro. El resto de este artículo es cómo cablear las tres capas correctamente para que una aplicación MAUI responda como esperan las convenciones de la plataforma.

## Define los recursos claros y oscuros una sola vez en App.xaml

El patrón más limpio es mantener cada valor sensible al tema como un `StaticResource` en `App.xaml`, y luego vincular a través de `AppThemeBinding`. Poner los recursos en el ámbito de la aplicación significa que cada página ve la misma paleta y puedes renombrar una sola clave cuando cambia el sistema de diseño.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<?xml version = "1.0" encoding = "UTF-8" ?>
<Application xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="HelloDarkMode.App">
    <Application.Resources>
        <ResourceDictionary>

            <!-- Light palette -->
            <Color x:Key="LightBackground">#FFFFFF</Color>
            <Color x:Key="LightSurface">#F5F5F7</Color>
            <Color x:Key="LightText">#0A0A0B</Color>
            <Color x:Key="LightAccent">#0066FF</Color>

            <!-- Dark palette -->
            <Color x:Key="DarkBackground">#0F1115</Color>
            <Color x:Key="DarkSurface">#1A1D23</Color>
            <Color x:Key="DarkText">#F2F2F2</Color>
            <Color x:Key="DarkAccent">#5B9BFF</Color>

            <Style TargetType="ContentPage" ApplyToDerivedTypes="True">
                <Setter Property="BackgroundColor"
                        Value="{AppThemeBinding Light={StaticResource LightBackground},
                                                Dark={StaticResource DarkBackground}}" />
            </Style>

            <Style TargetType="Label">
                <Setter Property="TextColor"
                        Value="{AppThemeBinding Light={StaticResource LightText},
                                                Dark={StaticResource DarkText}}" />
            </Style>

        </ResourceDictionary>
    </Application.Resources>
</Application>
```

`AppThemeBinding` es la forma de extensión de marcado de la clase `AppThemeBindingExtension` en `Microsoft.Maui.Controls.Xaml`. Expone tres valores: `Default`, `Light`, `Dark`. El analizador de XAML trata `Default=` como la propiedad de contenido, por lo que `{AppThemeBinding Red, Light=Green, Dark=Blue}` es una forma abreviada legal de "usa rojo a menos que el sistema sea claro u oscuro". Cuando cambia el tema del sistema, MAUI recorre cada enlace que apunta a una `AppThemeBindingExtension`, lo reevalúa y empuja el nuevo valor a través del pipeline de propiedades enlazables. No escribes ningún código para refrescar.

Para valores únicos que no merecen una clave de recurso, escribe los colores en línea:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Border Stroke="{AppThemeBinding Light=#DDD, Dark=#333}"
        BackgroundColor="{AppThemeBinding Light={StaticResource LightSurface},
                                          Dark={StaticResource DarkSurface}}">
    <Label Text="Hello, theme" />
</Border>
```

Para imágenes, la misma extensión acepta referencias a archivos:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Image Source="{AppThemeBinding Light=logo_light.png, Dark=logo_dark.png}"
       HeightRequest="48" />
```

## Aplica temas desde el code-behind

Cuando construyes vistas en C# o las modificas después de la construcción, intercambia la extensión de marcado por las extensiones `SetAppThemeColor` y `SetAppTheme<T>` sobre `VisualElement`. Viven en `Microsoft.Maui.Controls` y se comportan exactamente como la extensión de marcado: almacenan los dos valores, evalúan el tema actual y lo reevalúan en cada cambio de tema.

```csharp
// .NET MAUI 11.0.0, .NET 11
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

var label = new Label { Text = "Hello, theme" };
label.SetAppThemeColor(
    Label.TextColorProperty,
    light: Colors.Black,
    dark: Colors.White);

var image = new Image { HeightRequest = 48 };
image.SetAppTheme<FileImageSource>(
    Image.SourceProperty,
    light: "logo_light.png",
    dark: "logo_dark.png");
```

`SetAppTheme<T>` es la llamada correcta para cualquier valor que no sea `Color`. Funciona con `FileImageSource`, `Brush`, `Thickness` y cualquier otro tipo que la propiedad de destino acepte. No hay un `SetAppThemeBrush` o `SetAppThemeThickness` separado porque la versión genérica los cubre todos.

## Detecta y anula el tema actual

`Application.Current.RequestedTheme` devuelve el valor `AppTheme` resuelto en cualquier momento, teniendo en cuenta tanto el sistema operativo como cualquier anulación de `UserAppTheme`. Recurre a él con moderación: un solo bool guardado en un viewmodel que diga "estamos en oscuro ahora mismo" es casi siempre una señal de que deberías estar usando `AppThemeBinding`.

```csharp
// .NET MAUI 11.0.0, .NET 11
AppTheme current = Application.Current!.RequestedTheme;
bool isDark = current == AppTheme.Dark;
```

Anular el tema es la contraparte dentro de la aplicación. `Application.Current.UserAppTheme` es de lectura/escritura y acepta el mismo enum:

```csharp
// .NET MAUI 11.0.0, .NET 11
Application.Current!.UserAppTheme = AppTheme.Dark;     // force dark
Application.Current!.UserAppTheme = AppTheme.Light;    // force light
Application.Current!.UserAppTheme = AppTheme.Unspecified; // follow system
```

El setter dispara `RequestedThemeChanged`, lo que significa que cada `AppThemeBinding` activo se reevalúa de inmediato. No necesitas reconstruir páginas, intercambiar diccionarios de recursos ni disparar un flush de navegación.

La anulación no sobrevive a un reinicio de la aplicación. Si quieres que la elección del usuario se mantenga entre lanzamientos, persístela mediante `Microsoft.Maui.Storage.Preferences`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public static class ThemeService
{
    private const string Key = "user_app_theme";

    public static void Apply()
    {
        var stored = (AppTheme)Preferences.Default.Get(Key, (int)AppTheme.Unspecified);
        Application.Current!.UserAppTheme = stored;
    }

    public static void Set(AppTheme theme)
    {
        Preferences.Default.Set(Key, (int)theme);
        Application.Current!.UserAppTheme = theme;
    }
}
```

Llama a `ThemeService.Apply()` desde `App.OnStart` (o el constructor de `App` justo después de `InitializeComponent`) para que la anulación esté en su lugar antes de que se renderice la primera ventana. Almacena el enum como un `int` porque `Preferences` no tiene una sobrecarga tipada para enums arbitrarios en todas las plataformas, y convertir a través de `int` es portable.

## Notifica a tus viewmodels cuando el tema cambia

Cuando tienes que reaccionar a un cambio de tema en código, por ejemplo para intercambiar un `GraphicsView` dibujado a mano o para imponer un color distinto en la `StatusBar`, suscríbete a `Application.Current.RequestedThemeChanged`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public App()
{
    InitializeComponent();
    Application.Current!.RequestedThemeChanged += OnThemeChanged;
}

private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
{
    AppTheme theme = e.RequestedTheme;
    UpdateStatusBar(theme);
    UpdateMapStyle(theme);
}
```

El manejador del evento se ejecuta en el hilo principal. `AppThemeChangedEventArgs.RequestedTheme` es el nuevo tema resuelto, por lo que no necesitas leer `Application.Current.RequestedTheme` de nuevo dentro del manejador.

Si el evento nunca se dispara en Android, a tu `MainActivity` le falta la marca `UiMode`. La plantilla por defecto de Visual Studio la incluye, pero he visto proyectos hechos a mano que la pierden durante una migración desde Xamarin.Forms. Agrégala:

```csharp
// .NET MAUI 11.0.0, .NET 11, Platforms/Android/MainActivity.cs
[Activity(
    Theme = "@style/Maui.SplashTheme",
    MainLauncher = true,
    LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges =
        ConfigChanges.ScreenSize |
        ConfigChanges.Orientation |
        ConfigChanges.UiMode |       // load-bearing for dark mode
        ConfigChanges.ScreenLayout |
        ConfigChanges.SmallestScreenSize |
        ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity { }
```

Sin `ConfigChanges.UiMode`, Android destruye y recrea la actividad en cada cambio de tema del sistema, lo que significa que MAUI ve una actividad nueva en lugar de una actualización de configuración, y el evento `RequestedThemeChanged` no se dispara desde la misma instancia de `Application`. El síntoma visible es que el primer cambio funciona, pero los cambios posteriores no hacen nada hasta que se mata la aplicación.

## Configuración por plataforma que nadie te cuenta

La superficie de MAUI es mayoritariamente multiplataforma, pero el modo oscuro tiene pequeñas perillas específicas de cada plataforma que es fácil pasar por alto.

**iOS / Mac Catalyst.** Si `Info.plist` contiene `UIUserInterfaceStyle` con valor `Light` o `Dark`, el sistema operativo bloquea la aplicación en ese modo de forma definitiva y `Application.RequestedTheme` devuelve el valor bloqueado para siempre. La plantilla por defecto de MAUI omite la clave, lo que significa que la aplicación sigue al sistema. Si necesitas darte de baja explícitamente, usa `Automatic`:

```xml
<!-- Platforms/iOS/Info.plist or Platforms/MacCatalyst/Info.plist -->
<key>UIUserInterfaceStyle</key>
<string>Automatic</string>
```

`Automatic` también es el valor correcto si un desarrollador anterior estableció la clave en `Light` para "arreglar" algo y luego se olvidó. Eliminar la clave por completo tiene el mismo efecto.

**Android.** Más allá de la marca `ConfigChanges.UiMode`, lo único que debes verificar es que el tema de la aplicación herede de una base DayNight en `Platforms/Android/Resources/values/styles.xml`. La plantilla por defecto de MAUI usa `Maui.SplashTheme` y `Maui.MainTheme`, ambos extienden `Theme.AppCompat.DayNight.NoActionBar`. Si has personalizado el tema de la pantalla de bienvenida, mantén el padre en un ancestro `DayNight` o tu pantalla de bienvenida se quedará clara para siempre incluso cuando el resto de la aplicación pase a oscuro.

Para drawables que necesitan una variante oscura, déjalos en `Resources/values-night/colors.xml` o usa las carpetas calificadoras de recursos `-night`. Cualquier cosa que fluya a través de `AppThemeBinding` no necesita esto, pero el arte nativo de la pantalla de bienvenida y los iconos de notificaciones sí.

**Windows.** No se requiere ningún cambio en `Package.appxmanifest`. El host de Windows lee el tema del sistema mediante la propiedad `Application.RequestedTheme` de la aplicación WinUI, y la mecánica de `AppThemeBinding` de MAUI se encamina automáticamente a través de ella. Si encuentras una superficie solo de Windows que no se refresca, puedes forzarla estableciendo `MauiWinUIApplication.Current.MainWindow.Content` a una raíz nueva, pero no lo he necesitado en 11.0.0.

## Barra de estado, pantalla de bienvenida y otras superficies nativas

Hay dos cosas que `AppThemeBinding` no cubre y que tropiezan a casi todos los proyectos la primera vez:

- **El color del texto/iconos de la barra de estado en Android e iOS** lo controla la plataforma, no el fondo de la página. En iOS, establece `UIViewController.PreferredStatusBarStyle` por página; en Android, establece `Window.SetStatusBarColor` desde `MainActivity`. El patrón multiplataforma más simple es poner el código por plataforma detrás de un bloque `ConditionalCompilation` en el manejador `RequestedThemeChanged` mostrado arriba.

- **Las pantallas de bienvenida** las renderiza el sistema operativo antes de que MAUI haya cargado, por lo que no pueden consumir `AppThemeBinding`. La plantilla de Android entrega colores claros y nocturnos por separado mediante `values/colors.xml` y `values-night/colors.xml`. iOS usa un solo storyboard de lanzamiento, así que o eliges un color neutro que funcione en ambos modos o suministras dos storyboards mediante la configuración `LaunchStoryboard`.

Si necesitas que un estilo de mapa personalizado, una paleta de gráficos o el contenido de un `WebView` siga el tema, haz el cambio en `RequestedThemeChanged`. Para mapas en particular, el [recorrido de clusterización de pines en mapas en MAUI 11](/es/2026/04/dotnet-maui-11-map-pin-clustering/) muestra cómo mantener el estado del control de mapa sincronizado con las transiciones de tema sin reconstruir el renderer.

## Cinco trampas que te comerán una tarde

**1. `Page.BackgroundColor` no siempre se refresca al cambiar `UserAppTheme`.** El problema conocido en [dotnet/maui#6596](https://github.com/dotnet/maui/issues/6596) significa que algunas propiedades se pierden la pasada de reevaluación cuando estableces `UserAppTheme` programáticamente. La solución fiable es establecer el fondo de la página mediante un `Setter` de `Style` (como en el ejemplo de `App.xaml` de arriba) en lugar de directamente en el elemento de la página. Los setters basados en estilos se reevalúan de forma fiable.

**2. `RequestedThemeChanged` se dispara una vez y luego se queda en silencio.** Este es el síntoma de [dotnet/maui#15350](https://github.com/dotnet/maui/issues/15350), y en Android casi siempre es la marca `ConfigChanges.UiMode` que falta. En iOS, el síntoma equivalente aparece cuando hay una página modal en la pila en el momento del cambio de tema del sistema; cerrar y reabrir la modal restaura los eventos. Suscribirse una vez en `App.xaml.cs` y mantener viva la suscripción es el patrón seguro.

**3. `AppTheme.Unspecified` no siempre se restablece al sistema operativo en iOS.** Como se rastrea en [dotnet/maui#23411](https://github.com/dotnet/maui/issues/23411), establecer `UserAppTheme = AppTheme.Unspecified` después de una anulación dura a veces deja la ventana de iOS atascada en la anulación anterior. La solución en 11.0.0 es establecer `UIWindow.OverrideUserInterfaceStyle = UIUserInterfaceStyle.Unspecified` desde un `MauiUIApplicationDelegate` personalizado después de que MAUI establezca `UserAppTheme`. Un puñado de líneas, y solo se necesita si tu aplicación expone un interruptor de "seguir al sistema" en la configuración.

**4. Los controles personalizados que capturan colores en la construcción se quedan claros para siempre.** Si almacenas en caché un valor `Color` en el constructor de tu control (o en un campo estático), nunca se actualizará. Lee los valores del tema de forma perezosa en `OnHandlerChanged` o vincúlalos a través del pipeline de propiedades enlazables para que la mecánica de `AppThemeBinding` de MAUI los pueda reevaluar.

**5. La recarga en caliente no siempre refleja los cambios de tema.** Cuando cambias el simulador o emulador de claro a oscuro mientras la aplicación está suspendida, la recarga en caliente a veces sirve el recurso en caché. Fuerza una recompilación completa después de alternar el tema del sistema durante el desarrollo. Este es un artefacto de la herramienta, no un bug de `AppThemeBinding`, y diagnosticar problemas reales es mucho más fácil cuando lo eliminas como variable.

## Donde el modo oscuro se cruza con el resto del framework

El modo oscuro es la característica de tematización más fácil que entrega MAUI y la que la documentación cubre con más detalle, pero interactúa con otras dos partes del framework que probablemente toques en la misma semana. El patrón de personalización de handlers de [cómo cambiar el color del icono de SearchBar en .NET MAUI](/es/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) es la forma correcta cuando tienes un control cuya parte nativa ignora `TextColor` en modo oscuro (el `UISearchBar` de iOS es el delincuente canónico). Para el recorrido de configuración por plataforma, el artículo [novedades en .NET MAUI 10](/es/2025/04/whats-new-in-net-maui-10/) cubre las adiciones de `Window` y `MauiWinUIApplication` que llegaron en MAUI 10 y siguen siendo los ganchos correctos en 11.0.0. Si estás empaquetando controles sensibles al tema dentro de una biblioteca de clases, [cómo registrar handlers en una biblioteca MAUI](/es/2023/11/maui-library-register-handlers/) recorre la mecánica de `MauiAppBuilder`, incluyendo las reglas de orden de operaciones que determinan cuándo un handler ve el tema resuelto. Y si tu trabajo de modo oscuro está sucediendo dentro de una compilación solo de escritorio, la [configuración de MAUI 11 solo para Windows y macOS](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) muestra cómo descartar los objetivos de Android y iOS para que solo tengas que depurar dos plataformas en lugar de cuatro.

## Enlaces a las fuentes

- [Respond to system theme changes - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/system-theme-changes?view=net-maui-10.0)
- [AppThemeBindingExtension Class - Microsoft.Maui.Controls.Xaml](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.xaml.appthemebindingextension)
- [Application.UserAppTheme Property - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.application.userapptheme?view=net-maui-9.0)
- [AppTheme Enum - Microsoft.Maui.ApplicationModel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.applicationmodel.apptheme)
- [Preferences - Microsoft.Maui.Storage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences)
- [MAUI sample: Respond to system theme changes](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/userinterface-systemthemes/)

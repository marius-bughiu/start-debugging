---
title: "Solución: los iconos de la barra de estado de Android se vuelven ilegibles tras activar UseMaterial3 en .NET MAUI 10"
description: "MAUI 10.0.100 elige el color de los iconos de la barra de estado a partir de colorPrimary, que tiene el brillo opuesto a la superficie de Material 3, así que obtienes blanco sobre blanco o negro sobre negro. Actualiza Microsoft.Maui.Controls a 10.0.101 o posterior, o restablece AppearanceLightStatusBars en MainActivity."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "android"
  - "material-3"
  - "csharp"
lang: "es"
translationOf: "2026/09/fix-android-status-bar-icons-unreadable-after-enabling-usematerial3-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-29
---

Si tu aplicación .NET MAUI 10 muestra iconos blancos de reloj y batería sobre una barra de estado blanca en modo claro, e iconos negros sobre una barra de estado negra en modo oscuro, justo después de establecer `<UseMaterial3>true</UseMaterial3>`, estás usando `Microsoft.Maui.Controls` 10.0.100. Esa versión empezó a elegir el color de los iconos de la barra de estado a partir de la luminancia de `colorPrimary` del tema. Material 3 dibuja `colorSurface` detrás de la barra de estado transparente de borde a borde, y los colores primary y surface de Material 3 siempre tienen brillo opuesto, así que los iconos salen invertidos. La solución es actualizar a 10.0.101 o posterior (10.0.110 es la actual, publicada el 2026-09-22). Si todavía no puedes actualizar, establece `AppearanceLightStatusBars` tú mismo en `MainActivity` después de `base.OnCreate`. En .NET 11 RC 1 la ventana principal se ve bien, pero las páginas modales siguen mostrando el error; RC 2 lo corrige.

## El error en contexto

No hay ninguna excepción ni nada en el registro. El síntoma es visual, y se ve así en Android 15, 16 y 17 con borde a borde (que .NET MAUI 10 habilita para API 30+):

```text
// .NET 10, Microsoft.Maui.Controls 10.0.100, <UseMaterial3>true</UseMaterial3>
Light mode: status bar background near-white (Material 3 surface), icons and clock white
Dark mode:  status bar background near-black (Material 3 surface), icons and clock black
```

El reporte es [dotnet/maui#37705](https://github.com/dotnet/maui/issues/37705), etiquetado como `i/regression` y `regressed-in-10.0.100`. Volver a 10.0.90 hace que los iconos vuelvan a ser legibles, lo cual es la primera pista de que se trata de un cambio de MAUI y no de algo en tu tema.

Esto es lo que hace cada versión, según `WindowExtensions.cs` y el controlador de ventana en cada etiqueta de versión:

| Microsoft.Maui.Controls | Cómo se elige el color de los iconos de la barra de estado | Resultado con Material 3 |
| --- | --- | --- |
| 10.0.90 y anteriores | Día/noche: el tema claro obtiene iconos oscuros | Legible |
| 10.0.100 (2026-08-20) | Luminancia de `android:colorPrimary` | Invertido, ilegible |
| 10.0.101 (2026-09-07), 10.0.110 | Luminancia de `colorSurface` para Material 3, `colorPrimary` para Material 2 | Legible |
| 11.0 RC 1 | `colorPrimary`, y luego sobrescrito por `Window.StatusBarTheme` (por defecto: día/noche) solo para la ventana principal | Ventana principal legible, páginas modales invertidas |
| Rama de 11.0 RC 2 | Igual que 10.0.101 | Legible |

## Por qué se invierten los iconos: colorPrimary frente a colorSurface

Android no permite que una aplicación elija un color exacto para los iconos de la barra de estado. Ofrece un booleano: `WindowInsetsControllerCompat.AppearanceLightStatusBars`. Cuando es `true`, el sistema asume que el fondo de la barra de estado es claro y dibuja iconos oscuros. Cuando es `false`, dibuja iconos claros.

Hasta 10.0.90, MAUI establecía esa bandera solo a partir del modo día/noche:

```csharp
// .NET MAUI 10.0.90, src/Core/src/Platform/Android/WindowExtensions.cs
var configuration = activity.Resources?.Configuration;
var isLightTheme = configuration is null ||
    (configuration.UiMode & UiMode.NightMask) != UiMode.NightYes;

windowInsetsController.AppearanceLightStatusBars = isLightTheme;
windowInsetsController.AppearanceLightNavigationBars = isLightTheme;
```

Eso funciona cuando lo que hay detrás de la barra de estado sigue el modo día/noche, y falla cuando no lo hace. [dotnet/maui#32987](https://github.com/dotnet/maui/issues/32987) fue el segundo caso: una aplicación Material 2 con tema claro y una barra de aplicación con `colorPrimary` negro bajo la barra de estado obtenía iconos oscuros sobre una barra oscura. La corrección, [dotnet/maui#36214](https://github.com/dotnet/maui/pull/36214), se fusionó el 2026-07-01 y se publicó en 10.0.100. Resuelve `android:colorPrimary` a partir del tema actual y usa su luminancia en su lugar:

```csharp
// .NET MAUI 10.0.100, src/Core/src/Platform/Android/WindowExtensions.cs
if (TryGetThemeColor(activity, global::Android.Resource.Attribute.ColorPrimary, out var statusBarColor))
    windowInsetsController.AppearanceLightStatusBars = IsLightColor(statusBarColor);
else
    windowInsetsController.AppearanceLightStatusBars = isLightTheme;

// ...
static bool IsLightColor(AColor color) =>
    ColorUtils.CalculateLuminance(color.ToArgb()) > 0.5;
```

Para una barra de aplicación de Material 2 pintada con `colorPrimary`, eso es correcto. Para Material 3 es exactamente al revés. Con `UseMaterial3` activado, MAUI cambia el tema de la actividad a `Maui.Material3.Theme.NoActionBar`, cuyo padre es `Theme.Material3.DayNight`. Los estilos de Material 3 de MAUI no sobrescriben el color primary, así que obtienes la paleta base de Material 3. Material 3 coloca el color surface detrás de la barra de estado, no el color primary, y la paleta está diseñada para que primary contraste con surface:

| Tema | `colorPrimary` | Luminancia relativa | 10.0.100 decide | Fondo real |
| --- | --- | --- | --- | --- |
| Claro | `#6750A4` | 0.11 (oscuro) | Iconos claros | Superficie casi blanca |
| Oscuro | `#D0BCFF` | 0.57 (claro) | Iconos oscuros | Superficie casi negra |

El `#512BD4` morado de la plantilla en `Platforms/Android/Resources/values/colors.xml` no te salva: ese recurso de color alimenta el `Maui.MainTheme` de Material 2, no el tema de Material 3, y de todos modos es oscuro (luminancia 0.08). Cualquier paleta de Material 3 con tema claro y un primary saturado acaba en el mismo lugar.

La corrección de 10.0.101, [dotnet/maui#37710](https://github.com/dotnet/maui/pull/37710), portada a la rama SR10 como [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730), mantiene la idea de la luminancia pero lee el atributo que realmente está detrás de la barra:

```csharp
// .NET MAUI 10.0.101 and 10.0.110, src/Core/src/Platform/Android/WindowExtensions.cs
internal static bool GetStatusBarAppearance(Context context, bool isLightTheme, bool isMaterial3)
{
    // Material 3 draws its surface behind the transparent edge-to-edge status bar.
    // The Material 2 app bar uses colorPrimary in the same area.
    var backgroundAttribute = isMaterial3
        ? Resource.Attribute.colorSurface
        : global::Android.Resource.Attribute.ColorPrimary;

    return TryGetThemeColor(context, backgroundAttribute, out var backgroundColor)
        ? IsLightColor(backgroundColor)
        : isLightTheme;
}
```

## Reproducción mínima

Parte de la plantilla por defecto y fija el paquete afectado:

```xml
<!-- .NET 10 SDK, dotnet new maui, MyApp.csproj -->
<PropertyGroup>
  <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.100" />
</ItemGroup>
```

Ejecútala en un emulador con Android 11 (API 30) o posterior. Los iconos de la barra de estado son blancos en la página de inicio en modo claro. Cambia el emulador a modo oscuro, reinicia la aplicación y serán negros. Cambia `10.0.100` por `10.0.90` y ambos modos serán legibles. Cámbialo por `10.0.110` y ambos modos vuelven a ser legibles.

Si quieres confirmar lo que decidió MAUI en lugar de entrecerrar los ojos frente al emulador, registra la bandera después del inicio:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
protected override void OnResume()
{
    base.OnResume();
    var controller = AndroidX.Core.View.WindowCompat.GetInsetsController(Window!, Window!.DecorView);
    Android.Util.Log.Info("StatusBar", $"AppearanceLightStatusBars={controller.AppearanceLightStatusBars}");
}
```

En modo claro con 10.0.100 verás `False`, que significa "el fondo es oscuro, dibuja iconos claros", sobre una superficie casi blanca.

## Solución 1: actualizar Microsoft.Maui.Controls a 10.0.101 o posterior

Esta es la solución real, y es una versión de parche dentro de la misma línea de .NET 10, así que no hay cambio de target framework. Establece la versión de forma explícita en lugar de depender de `$(MauiVersion)` de la carga de trabajo que esté instalada en la máquina de compilación:

```xml
<!-- .NET 10, MyApp.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
</ItemGroup>
```

El código modificado vive en `Microsoft.Maui.Core`, que `Microsoft.Maui.Controls` incorpora con la misma versión. Si tu proyecto también referencia directamente `Microsoft.Maui.Core` o `Microsoft.Maui.Controls.Compatibility`, súbelos a la misma versión, o NuGet podría resolver un conjunto mezclado. `dotnet list package --include-transitive` muestra lo que realmente obtuviste.

Luego limpia y vuelve a compilar. Los cambios de recursos y temas de Android son fáciles de pasar por alto en una implementación incremental, así que desinstala la aplicación del dispositivo una vez (`adb uninstall com.companyname.myapp`) antes de juzgar el resultado.

10.0.110 también incluye la corrección de la [UIKitThreadAccessException de MediaPicker.PickPhotosAsync](/es/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), otra regresión de 10.0.100, así que hay pocos motivos para quedarse en 10.0.100. Una salvedad en sentido contrario: 10.0.101 y 10.0.110 tienen un problema de Resizetizer con los [iconos de aplicación SVG que usan elementos filter o text](/es/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/). Revisa tu icono antes de actualizar una rama de versión.

## Solución 2: restablecer AppearanceLightStatusBars en MainActivity

Si por ahora estás fijado a 10.0.100, sobrescribe la bandera tú mismo. `MauiAppCompatActivity.OnCreate` llama a `CreatePlatformWindow`, que conecta el `WindowHandler`, que ejecuta `ConfigureTranslucentSystemBars` y escribe el valor incorrecto. Todo eso ocurre dentro de `base.OnCreate`, así que lo que establezcas después de esa llamada gana para la ventana principal:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
using Android.App;
using Android.Content.PM;
using Android.Content.Res;
using Android.OS;
using AndroidX.Core.View;

namespace MyApp;

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                           ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        // MAUI sets the status bar appearance inside base.OnCreate. Correct it afterwards.
        base.OnCreate(savedInstanceState);
        ApplyStatusBarIconContrast(Resources?.Configuration);
    }

    public override void OnConfigurationChanged(Configuration newConfig)
    {
        base.OnConfigurationChanged(newConfig);
        ApplyStatusBarIconContrast(newConfig);
    }

    void ApplyStatusBarIconContrast(Configuration? configuration)
    {
        // MAUI only configures edge-to-edge system bars on API 30+, so mirror that.
        if (!OperatingSystem.IsAndroidVersionAtLeast(30) || Window is null)
            return;

        var isNight = configuration is not null &&
            (configuration.UiMode & UiMode.NightMask) == UiMode.NightYes;

        // true means "light background": Android draws dark icons.
        WindowCompat.GetInsetsController(Window, Window.DecorView)
            .AppearanceLightStatusBars = !isNight;
    }
}
```

Esto restaura el comportamiento de 10.0.90. La sobrescritura de `OnConfigurationChanged` importa porque los `ConfigurationChanges` de la plantilla incluyen `ConfigChanges.UiMode`: cuando el usuario cambia el tema del sistema, Android no recrea la actividad, y MAUI 10 solo establece la bandera cuando el controlador de ventana se conecta. Sin la sobrescritura, los iconos conservan el color del modo anterior hasta el siguiente inicio en frío.

Elimina esta sobrescritura cuando pases a 10.0.101 o posterior. La corrección integrada deriva la bandera de tu `colorSurface` real, lo cual es más preciso que día/noche si personalizas el color de la superficie.

## Solución 3: en .NET 11, usar Window.StatusBarTheme

.NET 11 añadió `Window.StatusBarTheme` ([dotnet/maui#34903](https://github.com/dotnet/maui/pull/34903)), una enumeración con `Default`, `Light` y `Dark`. En RC 1, `WindowHandler.ConnectHandler` llama a `ConfigureTranslucentSystemBars` (que todavía tiene la lógica de `colorPrimary`) y luego aplica inmediatamente `StatusBarTheme`. `Default` recurre a día/noche, así que la ventana principal de una aplicación .NET 11 RC 1 es legible sin que hagas nada.

Las páginas modales son distintas. `ModalNavigationManager` muestra cada modal en su propia ventana de diálogo y llama a `ConfigureTranslucentSystemBars` en ella, pero no aplica `StatusBarTheme` después. Así que en RC 1, una página que abres con `Navigation.PushModalAsync` vuelve a tener los iconos invertidos. La corrección está en la rama `release/11.0.1xx-rc2`, así que RC 2 resuelve ambos casos.

`StatusBarTheme` también es la herramienta adecuada cuando tu página coloca detrás de la barra de estado algo distinto de la superficie, como una imagen hero oscura en un tema claro:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, App.xaml.cs
protected override Window CreateWindow(IActivationState? activationState)
{
    var window = new Window(new AppShell());

    // Light = light status bar background, so Android draws dark icons.
    window.SetAppTheme(Window.StatusBarThemeProperty, StatusBarTheme.Light, StatusBarTheme.Dark);

    return window;
}
```

O por página, cuando una sola pantalla necesita iconos claros sobre un encabezado oscuro, establécelo en la ventana de la página y restáuralo cuando la página desaparezca:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, HeroPage.xaml.cs
protected override void OnAppearing()
{
    base.OnAppearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Dark;
}

protected override void OnDisappearing()
{
    base.OnDisappearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Default;
}
```

Fíjate en la nomenclatura: `StatusBarTheme` describe la barra, no los iconos. `Dark` significa "la barra es oscura", lo que produce iconos claros, la misma convención que `AppearanceLightStatusBars`.

## Trampas y casos parecidos

**Las aplicaciones Material 2 pueden sufrir la imagen especular.** 10.0.101 y 10.0.110 siguen derivando la barra de estado de Material 2 a partir de `colorPrimary`, a propósito, porque la barra de aplicación de Material 2 está pintada con él. Si tu aplicación Material 2 oculta la barra de navegación (`Shell.NavBarIsVisible="False"`) y muestra una página blanca bajo una barra de estado mientras `colorPrimary` es oscuro, el código elegirá iconos claros sobre blanco. Eso se deduce del mismo código fuente y no se rastrea como un error, ya que el diseño por defecto de Material 2 mantiene la barra de aplicación bajo la barra de estado. La sobrescritura de `MainActivity` de la Solución 2 lo resuelve.

**Los iconos de la barra de navegación no se ven afectados.** Todas las versiones anteriores siguen estableciendo `AppearanceLightNavigationBars` a partir de día/noche. Si tu píldora de gestos o tu barra de 3 botones es ilegible, es un problema distinto, normalmente contenido dibujado bajo la barra tras los [cambios de borde a borde de API 36](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

**Android 10 y anteriores se ven bien.** MAUI solo ejecuta este código en API 30 y superiores. Por debajo, el controlador de ventana nunca llama a `ConfigureTranslucentSystemBars`, así que probar en un emulador antiguo no reproducirá el error.

**Establecer el color de la barra de estado no hace nada en Android 15+.** Una primera reacción común es `Window.SetStatusBarColor(...)` desde `MainActivity`. En aplicaciones que apuntan a API 35 o superior y se ejecutan en Android 15 y posteriores, el borde a borde es obligatorio y esa llamada se ignora. La barra permanece transparente, por lo que la bandera de apariencia de los iconos es la única palanca que importa aquí.

**No es tu configuración del modo oscuro.** Si los iconos están mal solo después de un cambio en tiempo de ejecución de `Application.Current.UserAppTheme`, y bien tras un inicio en frío, eso es la falta de reaplicación descrita en la Solución 2, no esta regresión. [Cómo dar soporte al modo oscuro correctamente en una aplicación MAUI](/es/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) cubre el resto de las superficies nativas que no siguen `AppThemeBinding`.

## Relacionado

- [.NET MAUI 10 SR6 completa Material 3 en Android tras una sola bandera UseMaterial3](/es/2026/05/maui-10-material-3-android-usematerial3-flag/) explica qué cambia la bandera y qué controles estiliza.
- [Migrar una aplicación Android de .NET MAUI para apuntar al nivel de API 36 de Android](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) para conocer los cambios de borde a borde y de área segura que hacen transparente la barra de estado en primer lugar.
- [Cómo dar soporte al modo oscuro correctamente en una aplicación MAUI](/es/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) para colores que respetan el tema y para reaccionar a `RequestedThemeChanged`.
- [Solución: .NET MAUI Resizetizer MissingMethodException (MAUIR0001) en un icono de aplicación SVG](/es/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/) antes de actualizar a 10.0.101 o 10.0.110.

## Fuentes

- [dotnet/maui#37705: Status bar icons become unreadable when UseMaterial3 is enabled in 10.0.100](https://github.com/dotnet/maui/issues/37705)
- [dotnet/maui#36214: Fix status bar icon contrast with custom colorPrimary](https://github.com/dotnet/maui/pull/36214) (el cambio que introdujo la regresión)
- [dotnet/maui#37710: Fix Material 3 status bar icon contrast](https://github.com/dotnet/maui/pull/37710) y el backport a 10.0.101 [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730)
- [dotnet/maui#34903: Add Window.StatusBarTheme](https://github.com/dotnet/maui/pull/34903)
- [`WindowExtensions.cs` en la etiqueta 10.0.100](https://github.com/dotnet/maui/blob/10.0.100/src/Core/src/Platform/Android/WindowExtensions.cs) y [en la etiqueta 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/WindowExtensions.cs)
- [`styles-material3.xml` en la etiqueta 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/Resources/values/styles-material3.xml)
- [WindowInsetsControllerCompat.setAppearanceLightStatusBars (Android Developers)](https://developer.android.com/reference/androidx/core/view/WindowInsetsControllerCompat#setAppearanceLightStatusBars(boolean))
- [Microsoft.Maui.Controls en NuGet](https://www.nuget.org/packages/Microsoft.Maui.Controls) para las fechas de publicación

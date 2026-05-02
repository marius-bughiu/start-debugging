---
title: "Cómo escribir una app MAUI que solo corra en Windows y macOS (sin móvil)"
description: "Quita Android e iOS de un proyecto .NET MAUI 11 para que solo se publique para Windows y Mac Catalyst: las ediciones del csproj, los comandos de workload y la multiplataforma que mantiene el código limpio."
pubDate: 2026-05-02
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "windows"
  - "macos"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only"
translatedBy: "claude"
translationDate: 2026-05-02
---

Respuesta corta: abre tu `.csproj`, borra las entradas de Android e iOS de `<TargetFrameworks>` y deja únicamente `net11.0-windows10.0.19041.0` y `net11.0-maccatalyst`. Después borra `Platforms/Android`, `Platforms/iOS` y `Platforms/Tizen` si existe. Quita las entradas `<ItemGroup>` de recursos de imagen MAUI que apuntan a iconos solo para móvil, desinstala los workloads `maui-android` y `maui-ios` si quieres una máquina limpia, y tu disposición Single Project, `MauiProgram`, el hot reload de XAML y el pipeline de recursos siguen funcionando. `dotnet build -f net11.0-windows10.0.19041.0` produce un MSIX, `dotnet build -f net11.0-maccatalyst` (ejecutado en macOS) produce un `.app`, y nada vuelve a intentar levantar un emulador de Android jamás.

Este artículo recorre las ediciones exactas para .NET MAUI 11.0.0 sobre .NET 11, qué se puede borrar sin riesgo y qué no, las trampas sutiles de multiplataforma cuando quitas heads, y los cambios de workload y CI que de verdad te ahorran tiempo. Todo lo de abajo se verificó contra `dotnet new maui` del SDK de .NET 11 y se aplica igual a un proyecto Xamarin.Forms ya migrado a MAUI.

## Por qué publicar un head MAUI solo de escritorio

Hay una franja constante de equipos de aplicaciones de negocio que eligen MAUI por su modelo de XAML y binding más que por su alcance móvil. Herramientas administrativas internas, apps de kiosco, clientes de punto de venta, paneles de planta de fábrica y apps de servicio de campo donde el campo es "una Surface y una MacBook" encajan todas. Estos equipos pagan un coste real por los heads móviles que nunca publican: cada `dotnet build` evalúa cuatro destinos, cada restore de NuGet baja los reference packs de Android e iOS, cada runner de CI necesita un workload de Android y cada onboarding de desarrollador choca con una dependencia de Xcode y Android Studio antes de poder ejecutar la app.

Quitar los heads móviles no es la plantilla por defecto de Visual Studio, pero el SDK lo soporta totalmente. El sistema de build lee `<TargetFrameworks>` y solo emite los heads que declares. No hay ninguna opción que tengas que activar dentro de MAUI. La fricción está enteramente en el archivo de proyecto, en la carpeta `Platforms/` y en los items condicionales de MSBuild que la plantilla añade para los assets de móvil.

## La edición de TargetFrameworks

Un `dotnet new maui -n DesktopApp` recién hecho con el SDK de .NET 11 produce un proyecto que abre con este `PropertyGroup` inicial:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Reemplaza las dos líneas `<TargetFrameworks>` por una lista explícita única:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Aquí importan dos cosas. Primero, el bloque condicional `IsOSPlatform('windows')` se conserva porque el head de Windows solo puede compilarse en Windows, igual que Mac Catalyst solo puede compilarse en macOS. Sin la condición, un desarrollador en macOS ejecutando `dotnet build` fallaría con "The Windows SDK is not available." Segundo, el sufijo de versión en `net11.0-windows10.0.19041.0` es la versión del SDK de Windows 10 que MAUI requiere para WinUI; no quites el sufijo de versión ni lo cambies a `net11.0-windows10.0` solo, porque los targets de WinAppSDK se anclan a ese moniker exacto.

Si solo quieres macOS, elimina la línea de Windows del todo. Si solo quieres Windows, elimina la línea de Mac Catalyst y el condicional. La forma `<TargetFramework>` (en singular) también funciona si de verdad solo tienes un head, y eso te da un único valor no condicional que algunas herramientas manejan con más elegancia. Para una app de verdad multiescritorio, mantén la forma multitarget.

## Qué borrar en `Platforms/`

La plantilla de MAUI te entrega `Platforms/Android`, `Platforms/iOS`, `Platforms/MacCatalyst`, `Platforms/Tizen` y `Platforms/Windows`. Cada una contiene una pequeña cantidad de código de bootstrap específico de plataforma: un `AppDelegate` para las plataformas Apple, un `MainActivity` y `MainApplication` para Android, un `App.xaml` más un `Package.appxmanifest` para Windows, un `Application.cs` para Mac Catalyst.

Para solo escritorio, borra `Platforms/Android`, `Platforms/iOS` y `Platforms/Tizen` directamente. No se usan. Mantén `Platforms/MacCatalyst` y `Platforms/Windows`. No toques la carpeta `Resources/` para nada; ese es el pipeline de assets de Single Project y sirve a todos los heads.

Tras la eliminación, la disposición queda así:

```
DesktopApp/
  App.xaml
  App.xaml.cs
  AppShell.xaml
  AppShell.xaml.cs
  MainPage.xaml
  MainPage.xaml.cs
  MauiProgram.cs
  Platforms/
    MacCatalyst/
      AppDelegate.cs
      Info.plist
      Program.cs
    Windows/
      App.xaml
      App.xaml.cs
      Package.appxmanifest
      app.manifest
  Resources/
    AppIcon/
    Fonts/
    Images/
    Raw/
    Splash/
    Styles/
  DesktopApp.csproj
```

Ese es el árbol fuente completo de una app MAUI 11 solo de escritorio.

## Quita los items de assets de imagen solo para móvil

Si usaste la plantilla por defecto, tu `.csproj` tiene un bloque así cerca del final:

```xml
<!-- .NET MAUI 11.0.0 -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
  <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
  <MauiImage Include="Resources\Images\*" />
  <MauiImage Update="Resources\Images\dotnet_bot.png" Resize="True" BaseSize="300,185" />
  <MauiFont Include="Resources\Fonts\*" />
  <MauiAsset Include="Resources\Raw\**" LogicalName="%(RecursiveDir)%(Filename)%(Extension)" />
</ItemGroup>
```

Estos son agnósticos de plataforma y se quedan tal cual. El pipeline de recursos de Single Project convierte el SVG en PNGs por plataforma en tiempo de build solo para los heads que declaraste. Cuando quitas Android no se emite ninguna densidad de Android; el mismo archivo `Resources/AppIcon/appicon.svg` alimenta el `AppIcon.icns` de Mac Catalyst y el `Square150x150Logo.scale-200.png` de Windows y eso es todo lo que necesitas.

Si tu proyecto es anterior a .NET 9 puede que también tengas items `<AndroidResource>` o `<BundleResource>` explícitos heredados de una migración Xamarin.Forms. Bórralos. No darán error si los dejas, pero ensucian la salida de build y vas a recibir advertencias "file not found" si los archivos referenciados ya no existen.

## Multiplataforma para tu propio código sin `#if ANDROID`

La plantilla de MAUI trae un par de patrones para código específico de plataforma: clases `partial` divididas en archivos `Platforms/<head>/` y directivas `#if`. Sin Android e iOS, solo necesitas manejar Windows y Mac Catalyst. Los símbolos de preprocesador que de verdad usas son:

```csharp
// .NET 11, MAUI 11.0.0
public static class PlatformInfo
{
    public static string Describe()
    {
#if WINDOWS
        return "Windows";
#elif MACCATALYST
        return "macOS (Mac Catalyst)";
#else
        return "Unknown";
#endif
    }
}
```

Eso es todo. `ANDROID` e `IOS` siguen siendo símbolos definidos cuando esos heads están presentes en `<TargetFrameworks>`, pero como no lo están, esas ramas simplemente nunca se compilan. Puedes borrar sin riesgo cada bloque `#if ANDROID` e `#if IOS` de tu base de código como una pasada de limpieza aparte.

Si separas implementaciones por nombre de archivo (el [patrón oficial de multiplataforma documentado para MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)), los bloques `<ItemGroup>` condicionales deberían perder las ramas de Android e iOS:

```xml
<!-- Mac Catalyst -->
<ItemGroup Condition="$(TargetFramework.StartsWith('net11.0-maccatalyst')) != true">
  <Compile Remove="**\*.MacCatalyst.cs" />
  <None Include="**\*.MacCatalyst.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>

<!-- Windows -->
<ItemGroup Condition="$(TargetFramework.Contains('-windows')) != true">
  <Compile Remove="**\*.Windows.cs" />
  <None Include="**\*.Windows.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>
```

Dos reglas en lugar de cinco. La misma lógica aplica a la multiplataforma basada en carpeta; mantén solo las reglas de carpeta `MacCatalyst` y `Windows`.

## Workloads: instala lo que compilas, desinstala lo que no

Este es el cambio que se paga solo más rápido en un runner de CI. El manifiesto de workload de MAUI está dividido en varios sub-workloads:

```bash
# .NET 11 SDK on macOS
dotnet workload install maui-maccatalyst

# .NET 11 SDK on Windows
dotnet workload install maui-windows
```

Para un proyecto solo de escritorio necesitas exactamente esos dos en el runner correspondiente. No necesitas el workload paraguas `maui`, que arrastra Android e iOS como dependencias transitivas de workload. En una imagen de CI que ya tenía `maui` instalado, ejecuta:

```bash
dotnet workload uninstall maui-android maui-ios
```

El head de Mac Catalyst en macOS sigue requiriendo Xcode, ya que `mlaunch` y la cadena de herramientas de Apple hacen la construcción real del `.app`. No necesitas el SDK de Android, el JDK de Java ni ninguna dependencia de despliegue a dispositivo iOS. En Windows, el head de Windows requiere el Windows App SDK y el SDK de Windows 10 en la versión anclada en `<TargetFrameworks>`. El comando `dotnet workload install maui-windows` baja ambos.

El ahorro en CI es significativo. Un runner de Linux que antes provisionaba workloads de Android e imágenes de emulador para una build hospedada en Linux de una app MAUI, solo para saltárselos en la puerta de CI, puede eliminar esos pasos del todo; la build ahora ignora Linux y ejecutas dos jobs separados, uno por SO.

## Compilar y publicar cada head

Los comandos `dotnet build` y `dotnet publish` toman un argumento `-f` de framework explícito para que no intentes accidentalmente compilar un head en el host equivocado:

```bash
# On Windows, .NET 11 SDK
dotnet build -f net11.0-windows10.0.19041.0 -c Release
dotnet publish -f net11.0-windows10.0.19041.0 -c Release -p:WindowsAppSDKSelfContained=true -p:WindowsPackageType=MSIX

# On macOS, .NET 11 SDK
dotnet build -f net11.0-maccatalyst -c Release
dotnet publish -f net11.0-maccatalyst -c Release -p:CreatePackage=true
```

El head de Windows emite un paquete `.msix` o, con `WindowsPackageType=None`, un directorio Win32 sin empaquetar. El head de Mac Catalyst emite un `.app` y, con `CreatePackage=true`, un instalador `.pkg`. La firma de código es una preocupación aparte para ambos: un certificado Authenticode para el MSIX y un Apple Developer ID para el `.pkg`. Ninguno implica un perfil de aprovisionamiento, que es la danza específica de iOS de la que acabas de salirte.

Si además quieres Native AOT para los heads de escritorio, el head WinUI de MAUI lo soporta en .NET 11 con salvedades, similar al [camino de Native AOT para minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Mac Catalyst aún no soporta Native AOT completo en MAUI 11; viene con mono-AOT para plataformas Apple.

## Trampas que conviene recordar

La plantilla "Add new MAUI Page" de Visual Studio en algunos escenarios vuelve a añadir silenciosamente un bloque `<ItemGroup Condition="...android..."/>`. Vigila los diffs de tu csproj. Si haces commit de un csproj solo de escritorio limpio y un compañero añade una nueva vista a través del IDE, el diff puede resucitar los items condicionales de Android e iOS aunque `<TargetFrameworks>` ya no incluya esos targets. Esos items huérfanos son inocuos pero acumularán ruido.

Los paquetes NuGet que dependen de `Xamarin.AndroidX.*` o `Microsoft.Maui.Essentials` para APIs solo de móvil seguirán haciéndose restore. El gestor de paquetes resuelve contra los targets que declaras, y un paquete solo de móvil sin asset compatible para `net11.0-windows10.0` o `net11.0-maccatalyst` fallará con `NU1202`. La solución es quitar el paquete; si es una dependencia transitiva de algo que de verdad usas, abre un issue con el paquete upstream y fija a una versión que soporte targets de escritorio explícitamente.

XAML hot reload funciona en ambos heads de escritorio en .NET 11. El depurador de lanzamiento tiene que ser el SO host del head: no puedes depurar dentro de una sesión de Mac Catalyst desde Visual Studio en Windows. Rider en macOS maneja ambos heads desde un único workspace, que es el flujo de trabajo en el que se asienta la mayoría de los equipos multiescritorio.

Las APIs de MAUI Essentials que son explícitamente solo de móvil (geocodificación, contactos, sensores, telefonía) lanzan `FeatureNotSupportedException` en tiempo de ejecución en Windows y Mac Catalyst. No fallan en tiempo de compilación. Envuelve el uso de esas APIs detrás de una verificación de capacidad o una abstracción segura para escritorio. Lo mismo aplica a MAUI Maps antes de los [cambios de pin clustering que llegaron en .NET MAUI 11](/es/2026/04/dotnet-maui-11-map-pin-clustering/); los heads de escritorio usan un control de mapa distinto bajo el capó al de los heads móviles, y la paridad de funcionalidades no es perfecta.

Si alguna vez necesitas volver a añadir los heads móviles (un cliente pide una versión de iPad), los cambios revierten limpiamente: vuelve a añadir las entradas a `<TargetFrameworks>`, restaura las carpetas `Platforms/Android` y `Platforms/iOS` desde una plantilla `dotnet new maui` recién hecha, reinstala los workloads. La disposición Single Project, tu XAML, tus view models y tu pipeline de recursos se trasladan sin cambios. La configuración solo de escritorio es un subconjunto estricto de la plantilla de cuatro heads, no un fork.

## Relacionado

- [.NET MAUI 11 trae un LongPressGestureRecognizer integrado](/es/2026/04/maui-11-long-press-gesture-recognizer/)
- [El pin clustering aterriza en los Maps de .NET MAUI 11](/es/2026/04/dotnet-maui-11-map-pin-clustering/)
- [Cómo usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Cómo reducir el cold-start de un AWS Lambda en .NET 11](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Enlaces de origen

- [Configurar la multiplataforma de .NET MAUI (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)
- [Target frameworks en proyectos SDK-style (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)
- [Solución de problemas conocidos de .NET MAUI (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [Issue 11584 de `dotnet/maui` sobre la eliminación del target Mac Catalyst](https://github.com/dotnet/maui/issues/11584)

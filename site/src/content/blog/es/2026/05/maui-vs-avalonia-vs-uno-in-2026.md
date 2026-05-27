---
title: "MAUI vs Avalonia vs Uno Platform: ¿cuál elegir en 2026?"
description: "Para una nueva aplicación .NET multiplataforma de escritorio y móvil en 2026, elige Avalonia cuando necesites un único conjunto de controles renderizados en todos los destinos, Uno cuando también debas llegar al navegador, y MAUI solo cuando realmente necesites iOS y Android nativos más soporte de primera mano de Microsoft."
pubDate: 2026-05-27
tags:
  - "comparison"
  - "maui"
  - "avalonia"
  - "uno-platform"
  - "dotnet"
  - "csharp"
lang: "es"
translationOf: "2026/05/maui-vs-avalonia-vs-uno-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

Para una aplicación .NET multiplataforma de interfaz de usuario nueva sobre .NET 11 en 2026, la respuesta honesta es: elige Avalonia 11.3 si necesitas un único conjunto de controles renderizados de manera consistente en Windows, macOS, Linux, iOS y Android. Elige Uno Platform 6 si el navegador y los destinos tvOS importan, o si quieres la opción de reutilizar XAML de WinUI/WPF. Elige .NET MAUI 11 si iOS más Android es todo el producto, necesitas controles totalmente nativos, y el soporte de primera mano de Microsoft no es negociable.

Este artículo cubre .NET MAUI 11 (versión preliminar al momento de escribir, GA en noviembre de 2026), Avalonia 11.3.x (estable desde marzo de 2026) y Uno Platform 6.0.x (estable desde febrero de 2026). Las tres apuntan a .NET 9 y .NET 11, las tres se publican en Windows, macOS, iOS y Android, y las tres tienen historias funcionales de WebAssembly con madurez muy distinta. Las diferencias que realmente deciden un proyecto son el modelo de renderizado, el soporte del navegador, la paridad de controles y cuánto XAML existente puedes pegar tal cual.

## Qué es cada uno en 2026

**.NET MAUI 11** es el framework de primera mano de Microsoft. Envuelve los controles nativos de la plataforma: un `Button` en MAUI es un `UIButton` en iOS, un `AppCompatButton` en Android, un `Microsoft.UI.Xaml.Controls.Button` en Windows y un `NSButton` en Mac Catalyst. Obtienes la apariencia nativa y el comportamiento de la plataforma sin costo. Mac Catalyst sigue siendo el único camino hacia macOS. Linux no es compatible. El navegador no es compatible. .NET 11 hizo de CoreCLR el runtime predeterminado en Android e iOS, lo que cierra la mayor parte de la brecha histórica de "MAUI es lento".

**Avalonia 11.3** renderiza todo por sí mismo con Skia. Un `Button` es un `Button` en cada plataforma: Avalonia dibuja los píxeles, controla el layout, controla el pipeline de entrada. Obtienes una interfaz idéntica píxel a píxel en Windows, macOS (Cocoa, no Catalyst), Linux (X11 y Wayland), iOS, Android, y un destino WebAssembly que ejecuta Skia en el navegador. El intercambio es que nada se ve 100% nativo a menos que lo diseñes así: los temas Fluent y macOS vienen incluidos y te acercan bastante, pero una biblioteca de controles escrita para el sistema operativo no se sentirá idéntica.

**Uno Platform 6** es la apuesta por la compatibilidad XAML. Implementa el dialecto XAML de WinUI 3 sobre renderizadores nativos en Windows (WinUI nativo), iOS, Android, macOS (AppKit), Linux (Skia o GTK), tvOS y WebAssembly. Desde Uno 5 también existe el modo "Uno Native" que dibuja todo con Skia como Avalonia, y "Uno Native + Hybrid" que mezcla ambos. La característica estrella de Uno es que puedes tomar una aplicación WinUI 3 y reconstruirla para las otras seis plataformas con el mismo XAML. Es el único de los tres que apunta al navegador como salida de primera clase y el único que admite tvOS en absoluto.

## La matriz de características

| Capacidad                             | .NET MAUI 11                           | Avalonia 11.3                         | Uno Platform 6                         |
| ------------------------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------- |
| Modelo de renderizado                 | controles nativos por plataforma       | Skia, idéntico en cada destino        | nativo en Win/iOS/Android, Skia o nativo en otros |
| Windows                               | sí (WinUI 3)                           | sí (Skia)                             | sí (WinUI 3 nativo)                    |
| macOS                                 | solo Mac Catalyst                      | Cocoa nativo                          | AppKit nativo y Skia                   |
| Linux                                 | no                                     | sí (X11, Wayland)                     | sí (Skia o GTK)                        |
| iOS                                   | sí                                     | sí                                    | sí                                     |
| Android                               | sí                                     | sí                                    | sí                                     |
| Navegador WebAssembly                 | no                                     | solo versión preliminar               | sí, calidad de producción              |
| tvOS                                  | no                                     | no                                    | sí                                     |
| Soporte de primera mano de Microsoft  | sí (Microsoft.Maui.*)                  | comunidad + Avalonia Inc comercial    | comunidad + nventive comercial         |
| Dialecto XAML                         | específico de MAUI                     | Avalonia (sabor WPF)                  | compatible con WinUI 3 / UWP           |
| Hot reload                            | sí (.NET 11)                           | sí (XAML y código)                    | sí (XAML y código)                     |
| Native AOT                            | parcial (.NET 11)                      | sí en la mayoría de destinos          | parcial                                |
| Runtime predeterminado en Android (.NET 11) | CoreCLR                          | Mono / CoreCLR                        | Mono / CoreCLR                         |
| Biblioteca MVVM predeterminada        | CommunityToolkit.Mvvm                  | CommunityToolkit.Mvvm o ReactiveUI    | CommunityToolkit.Mvvm                  |
| Licencia                              | MIT                                    | MIT (OSS) + Accelerate comercial      | Apache 2.0                             |
| Respaldado por                        | Microsoft                              | Avalonia Inc (anteriormente AvaloniaUI OÜ) | nventive                          |

Las dos filas que deciden la mayoría de los proyectos están en los extremos de esta tabla: modelo de renderizado y soporte del navegador. Si necesitas un único conjunto de controles idéntico píxel a píxel en cada plataforma, Avalonia es la única opción madura. Si necesitas publicar hoy el mismo XAML en un navegador sin compromisos, Uno es la única opción madura. Si necesitas iOS y Android totalmente nativos con Microsoft en el contrato de soporte, MAUI es la única opción madura. Todo lo demás es un refinamiento de esas tres afirmaciones.

## Cuándo elegir .NET MAUI 11

Elige MAUI cuando:

- **Tu producto es iOS + Android primero, Windows segundo y macOS un distante tercero.** Para esto se construyó MAUI y donde Microsoft gasta la mayor parte de su presupuesto de ingeniería. Mac Catalyst es usable para una aplicación complementaria, pero si macOS es tu superficie principal, esta es la herramienta equivocada. Aplicaciones de servicio de campo, aplicaciones POS de retail, herramientas internas solo móviles y aplicaciones móviles de prosumidor donde importa la apariencia de iOS caen aquí. El nuevo predeterminado CoreCLR en Android en .NET 11 cierra la mayor parte de la brecha histórica de tiempo de inicio, consulta [MAUI sobre CoreCLR por defecto para Android e iOS en .NET 11 Preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- **Necesitas soporte de primera mano de Microsoft y un único proveedor en el contrato.** Los equipos de adquisiciones empresariales que tienen un acuerdo Microsoft Premier obtienen el soporte de MAUI incluido. Tanto Avalonia Inc como nventive venden soporte comercial, pero es una línea de pedido separada.
- **Necesitas apariencia nativa y los controles específicos de la plataforma son parte del producto.** Mapas nativos, selectores nativos, hojas de compartir nativas, diálogos App Tracking Transparency, Live Activities en iOS. MAUI expone esto directamente porque el control subyacente es el widget real de la plataforma.
- **Estás migrando desde Xamarin.Forms.** Esta es la ruta de actualización oficial. La [guía de migración de Xamarin.Forms ListView a MAUI CollectionView](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) y el resto de la historia de migración están documentados y soportados. Avalonia y Uno ofrecen asistencia de migración, pero ninguna es la respuesta oficial.

Un `MauiProgram.cs` mínimo de MAUI 11:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

El dialecto XAML es específico de MAUI. Copiar y pegar una `Window` de WPF o una `Page` de WinUI 3 no compilará: namespaces, nombres de paneles de layout y muchos nombres de controles difieren.

## Cuándo elegir Avalonia 11.3

Elige Avalonia cuando:

- **El escritorio es la superficie principal y Linux importa.** Avalonia es el único de los tres con soporte Linux de primera clase, incluyendo Wayland. Herramientas de desarrollo, IDEs, aplicaciones científicas, herramientas internas de administración, cualquier cosa que tenga que instalarse en el Ubuntu de un desarrollador o en el Fedora de un administrador de sistemas. El experimento "New UI" de JetBrains Rider se publicó sobre Avalonia. También las reescrituras recientes de Unity Hub. El camino de Avalonia a través del equipo de diseño es directo porque el framework controla cada píxel.
- **Necesitas una interfaz idéntica píxel a píxel en cada plataforma.** Avalonia renderiza con Skia, de arriba a abajo. Un `DataGrid` con estilos personalizados se ve igual en Windows, macOS, Linux, iOS y Android porque ninguna de esas plataformas tiene permitido inyectar chrome nativo en el control. Si tu identidad de marca exige consistencia sobre apariencia nativa, esta es la respuesta.
- **Quieres un dialecto XAML con sabor a WPF con bindings modernos.** El XAML de Avalonia está lo suficientemente cerca de WPF como para que un desarrollador WPF senior sea productivo en días. `Binding`, `DataTemplate`, `ItemsControl`, `Style`, `Selector` se comportan como los desarrolladores WPF esperan. La actualización de Avalonia desde WPF es el camino de menor resistencia para una aplicación LOB solo Windows que también necesite ejecutarse en Linux.
- **Quieres soporte de grado comercial sin Microsoft en la línea.** Avalonia Inc vende "Avalonia Accelerate" con SLAs, ingenieros dedicados y un diseñador para XAML. Es un producto real, no una comunidad-de-la-semana.

Un `Program.cs` mínimo de Avalonia 11.3:

```csharp
// .NET 11, C# 14, Avalonia 11.3.x
using Avalonia;
using Avalonia.ReactiveUI;

namespace HelloAvalonia;

internal sealed class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp()
        .StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace()
            .UseReactiveUI();
}
```

`UsePlatformDetect()` es la única línea que selecciona Win32 / Cocoa / X11 / Wayland / Android / iOS / WebAssembly automáticamente según el destino de compilación. El destino del navegador está en versión preliminar a partir de Avalonia 11.3 y aún no es de grado de producción para aplicaciones grandes.

## Cuándo elegir Uno Platform 6

Elige Uno cuando:

- **Debes publicar en el navegador.** El destino WebAssembly de Uno es de grado de producción y lo ha sido desde Uno 4. Es el único de los tres con clientes reales ejecutando grandes aplicaciones XAML en el navegador. Si la misma aplicación debe ejecutarse en Windows, iOS, Android y como una PWA accesible por navegador, Uno es la única opción en 2026 que no requiere una segunda base de código.
- **Tienes una aplicación WinUI 3 o UWP que quieres reutilizar.** Uno implementa el dialecto XAML de WinUI 3, lo que significa que puedes levantar una `Page` WinUI 3 existente a un proyecto Uno y reconstruir para iOS, Android, Mac, Linux y el navegador sin reescribir el XAML. No hay otro camino que haga esto en 2026.
- **Necesitas tvOS.** Ninguno de los otros dos publica un destino Apple TV. Aplicaciones de streaming, kioscos en tienda que ejecutan hardware tvOS y aplicaciones de entretenimiento del ecosistema Apple aterrizan en Uno o en Swift.
- **El modo de renderizado nativo en iOS y Android es un requisito estricto.** El predeterminado de Uno en esos destinos son renderizadores nativos, el mismo intercambio que MAUI. La opción más reciente "Uno Skia Native" cambia a Skia para consistencia de píxeles. Este conmutador por destino es único en Uno: ningún otro framework te permite elegir la estrategia de renderizado por plataforma desde una sola base de código.

Un `App.xaml.cs` mínimo de Uno 6:

```csharp
// .NET 11, C# 14, Uno.WinUI 6.0.x
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace HelloUno;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        this.InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new Window();
        _window.Content = new MainPage();
        _window.Activate();
    }
}
```

El costo de la promesa de XAML multiplataforma es que Uno es el más pesado de los tres para configurar. Una nueva solución Uno tiene proyectos head separados para cada plataforma (iOS, Android, WebAssembly, Skia.Gtk, Skia.Wpf, Skia.MacOS, Wasm Hosted, etc.), y las plantillas incluyen un MSBuild SDK `Uno.Sdk` que oculta la mayor parte de esa complejidad pero no la hace desaparecer.

## El benchmark: arranque en frío y tamaño del paquete

Los números a continuación son de una plantilla "Hello World" por framework, publicada con `dotnet publish -c Release` en .NET 11 SDK `11.0.100-preview.4.26152.6`, medida en un Pixel 8 (Android 15), iPhone 15 (iOS 18.4) y Chrome 137 en una MacBook Pro M2. Arranque con caché en frío, sin preoptimización de perfil, sin native AOT.

| Métrica                                   | MAUI 11           | Avalonia 11.3      | Uno 6            |
| ----------------------------------------- | ----------------- | ------------------ | ---------------- |
| Arranque en frío Android, solo código     | 480 ms (CoreCLR)  | 410 ms (Mono)      | 520 ms (Mono)    |
| Tamaño APK Android, release, arquitectura única | 22 MB       | 18 MB              | 25 MB            |
| Arranque en frío iOS, solo código         | 360 ms            | 320 ms             | 380 ms           |
| Tamaño IPA iOS, release                   | 38 MB             | 31 MB              | 42 MB            |
| Bundle WebAssembly (gzip)                 | n/a               | 4.1 MB (preliminar) | 3.3 MB          |
| First Contentful Paint en WebAssembly     | n/a               | 2200 ms            | 1800 ms          |
| Arranque en frío Windows (ruta WinUI 3)   | 280 ms            | 240 ms             | 310 ms           |

Avalonia gana el arranque en frío en todos los frentes porque no hay inflación de controles nativos en el camino crítico: dibuja el primer fotograma con Skia y se acabó. MAUI 11 está más cerca de Avalonia de lo que estaba MAUI 9, gracias al predeterminado CoreCLR en Android (el número anterior con Mono para MAUI 9 era 720 ms en el mismo hardware). Uno es el más pesado porque carga la superficie de compatibilidad WinUI 3 en cada build. Ninguna de estas brechas hará o romperá una aplicación real, pero si tu KPI es el arranque en frío, Avalonia es consistentemente el más rápido.

## El obstáculo que decide por ti

Tres cosas fuerzan la decisión independientemente de la preferencia:

1. **MAUI no soporta Linux ni el navegador.** Si cualquiera de esas plataformas está en tu matriz de envío, MAUI está fuera. No hay roadmap para cambiar esto: Microsoft ha sido explícito en que Linux no está en el plan de MAUI, y el camino Blazor Hybrid es la respuesta oficial para experiencias "tipo navegador". Si necesitas un destino WebAssembly real con XAML compartido, estás mirando Uno o Avalonia.
2. **El destino del navegador de Avalonia es preliminar, no de producción.** El equipo de Avalonia ha sido claro al respecto. Si tu proyecto requiere renderizado de grado de navegador hoy (no en 12 meses) para una aplicación XAML grande, la opción realista es Uno, no Avalonia. Reevalúa en 12-18 meses a medida que el camino Skia-WASM de Avalonia madure.
3. **El dialecto XAML es pegajoso.** Levantar controles entre los tres frameworks está más cerca de una reescritura que de un port. El XAML de WinUI 3 se pega limpiamente en Uno, el XAML de MAUI no se pega en ninguna parte, y el XAML de Avalonia solo se pega en otro código Avalonia. Elige el dialecto que coincida con el mayor cuerpo de XAML existente que tengas, porque esa decisión se acumula durante toda la vida del proyecto.

Un ejemplo práctico de cómo divergen los dialectos: un control personalizado respaldado por SkiaSharp. SkiaSharp 4 se publica con [Uno Platform como nuevo co-mantenedor](/es/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/), lo que significa que el roadmap del paquete está ahora atado a las necesidades de renderizado de píxeles de Uno. Eso convierte a SkiaSharp en el camino de menor resistencia en Uno y Avalonia y en una dependencia ligeramente más incómoda en MAUI, donde Skia no es el renderizador predeterminado.

## Recomendación reformulada

Para un nuevo proyecto de UI multiplataforma .NET que empiece hoy sobre .NET 11:

- **Escritorio primero, especialmente con Linux en la mezcla**: elige **Avalonia 11.3**. Idéntico píxel a píxel, arranque en frío más rápido, maduro en cada SO de escritorio y el XAML migra desde WPF limpiamente.
- **El navegador es parte de la matriz de envío**: elige **Uno Platform 6**. Es el único destino WebAssembly maduro, el único destino tvOS y el único que te permite reutilizar XAML WinUI 3 entre plataformas.
- **iOS + Android con Microsoft en el contrato de soporte**: elige **.NET MAUI 11**. Controles nativos, ingeniería de primera mano de Microsoft, la ruta oficial de actualización Xamarin.Forms y el runtime CoreCLR por defecto en Android e iOS en .NET 11.

Si estás sopesando una migración desde una aplicación existente:

- Desde Xamarin.Forms: ve a MAUI. La ruta de migración es directa y soportada. Apóyate en los [patrones de estilo y modo oscuro de .NET MAUI](/es/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) antes de empezar, porque el modelo de tema es uno de los cambios de comportamiento más grandes.
- Desde WPF: Avalonia. El XAML es la coincidencia más cercana, incluyendo bindings, triggers y diccionarios de recursos.
- Desde UWP o WinUI 3: Uno. El XAML y los namespaces son casi idénticos, y toda la razón de ser de Uno es este escenario.

## Relacionados

- [Cómo escribir una aplicación MAUI que se ejecute solo en Windows y macOS (sin móvil)](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) para el corte MAUI solo de escritorio.
- [Cómo migrar un Xamarin.Forms ListView a MAUI CollectionView](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) para el paso de migración más preguntado.
- [Cómo empaquetar una aplicación MAUI para la Microsoft Store](/es/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) para el lado de la distribución en Windows de la ecuación.
- [SkiaSharp 4.0 preview 1 nombra a Uno Platform como co-mantenedor](/es/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) para lo que la historia de renderizador compartido significa para Uno y Avalonia.
- [MAUI sobre CoreCLR por defecto para Android e iOS en .NET 11 Preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) para las mejoras de tiempo de arranque de .NET 11.

## Fuentes

- [Documentación de .NET MAUI](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, consultado el 2026-05-27.
- [Notas de versión de Avalonia 11.3](https://github.com/AvaloniaUI/Avalonia/releases) en GitHub.
- [Anuncio de Uno Platform 6.0](https://platform.uno/blog/) y documentación de Uno Platform.
- [Estado del soporte de navegador en Avalonia](https://docs.avaloniaui.net/docs/next/guides/platforms/web/), consultado el 2026-05-27.
- [Compatibilidad de XAML WinUI 3 en Uno Platform](https://platform.uno/docs/articles/winui-doc-links-overview.html), documentación de Uno Platform.

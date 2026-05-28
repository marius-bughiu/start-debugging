---
title: "Migrar de Xamarin.Forms 5.0 a .NET MAUI 11: la lista completa"
description: "Migración integral de Xamarin.Forms 5.0 a .NET MAUI 11 GA en net11.0, cubriendo la reescritura del csproj, la conversión de renderers personalizados a handlers, el cableado de AppShell, la eliminación de DependencyService, el retiro de MessagingCenter, los recursos de Resizetizer y los problemas que muerden a un código de producción real."
pubDate: 2026-05-28
updatedDate: 2026-05-28
tags:
  - "migration"
  - "xamarin"
  - "xamarin-forms"
  - "maui"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/migrate-from-xamarin-forms-to-maui-11"
translatedBy: "claude"
translationDate: 2026-05-28
---

Xamarin.Forms quedó sin soporte el 2024-05-01 y Microsoft no ha publicado una sola corrección desde entonces. .NET MAUI 11 es el destino LTS para cada app Xamarin.Forms 5.0 que ha estado viviendo de prestado, y a partir de MAUI 11.0 GA en noviembre de 2025 la plataforma por fin tiene la plomería de renderers, el rendimiento de `RecyclerView` y el soporte para iOS 18 / Android 15 que a los primeros lanzamientos de MAUI les faltaba. Una migración enfocada de un solo desarrollador para una app mediana, de diez a veinte pantallas con un puñado de renderers personalizados, lleva entre una y tres semanas. Las partes difíciles no son XAML ni el sistema de compilación; son los renderers personalizados, `DependencyService` y cualquier código que toque directamente los proyectos de plataforma. Este post fija `Xamarin.Forms 5.0.0.2622` como origen y `.NET MAUI 11.0.0` sobre `net11.0` como destino, con `net11.0-android35.0`, `net11.0-ios18.0` y `net11.0-maccatalyst18.0` como los TFM activos.

El rollback no es trivial: una vez que el `.csproj` pasa al formato SDK con `Microsoft.NET.Sdk` y `UseMaui=true`, no se vuelve a un proyecto compartido de Xamarin.Forms sin restaurar el csproj original y `packages.config` desde el control de versiones. Trata la migración como un viaje de ida y arma las ramas en consecuencia.

## Por qué migrar ahora

- Xamarin.Forms no tiene soporte. No hay parches para el ajuste del target SDK de Android 15 que Google Play empezó a exigir el 2025-08-31, y Apple ya rechaza compilaciones enlazadas contra el SDK heredado de iOS 17 en App Store Connect.
- MAUI 11 corre sobre CoreCLR para Android e iOS por defecto, no sobre Mono. El arranque en frío de un Pixel 8 cae de aproximadamente 1.6 s a 0.9 s en una app Shell estándar, y las asignaciones en estado estacionario bajan porque el GC es generacional en lugar de `SGen`. El cambio se cubre en [nuestro artículo sobre CoreCLR por defecto en MAUI](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- La arquitectura de handlers reemplaza a los renderers personalizados con una superficie menor y evita los apaños de `Effect` más `PlatformEffect` que Xamarin.Forms acumuló a lo largo de su vida.
- Resizetizer viene incluido. El pipeline `Resources/Images/*.svg` genera los PNG específicos de plataforma en tiempo de compilación, así que por fin eliminas el zoológico de `drawable-xhdpi`, `drawable-xxhdpi`, `Assets.xcassets` y `LaunchScreen.storyboard`.

## Qué se rompe

| Área                     | Cambio                                                                       | Severidad |
| ------------------------ | ---------------------------------------------------------------------------- | --------- |
| Diseño del proyecto      | El proyecto compartido más tres proyectos head se colapsan en un csproj SDK  | alta      |
| Espacio `Xamarin.Forms`  | Reemplazado por `Microsoft.Maui.Controls`, `Microsoft.Maui.Graphics`, etc.   | alta      |
| Renderers personalizados | `ExportRenderer` y `IVisualElementRenderer` eliminados. Usa handlers         | alta      |
| `DependencyService`      | Eliminado. Usa `Microsoft.Extensions.DependencyInjection`                    | alta      |
| `MessagingCenter`        | Obsoleto y programado para eliminación. Usa [`IMessenger` de CommunityToolkit.Mvvm](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) | alta |
| `Application.Properties` | Eliminado. Usa `Microsoft.Maui.Storage.Preferences`                          | media     |
| `ListView`               | Envoltorio sobre `CollectionView`. Mejor migrarlo, ver [la guía de ListView a CollectionView](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) | media |
| `MasterDetailPage`       | Renombrado a `FlyoutPage`. El XAML debe actualizarse                         | baja      |
| `Frame`                  | Casi-obsoleto. Usa `Border` más `StrokeShape`                                | baja      |
| `OpenGLView`             | Eliminado por completo                                                       | baja      |
| `MainActivity` Android   | Se divide en `MainActivity.cs` más `MainApplication.cs`, ambos parciales     | media     |
| `AppDelegate` iOS        | Reemplaza `FormsApplicationDelegate` por `MauiUIApplicationDelegate`         | media     |
| `App.xaml.cs`            | `Application.MainPage` funciona en MAUI 11 pero Shell-first es lo nuevo      | baja      |
| Targeting                | `MonoAndroid12.0`, `Xamarin.iOS10` desaparecen. Solo `net11.0-android35.0`   | alta      |

El upgrade assistant upstream se distribuye como `dotnet tool` y cubre una fracción significativa de las reescrituras de espacios de nombres y la conversión del archivo de proyecto. No maneja renderers personalizados ni registros de `DependencyService`, que es donde se va el tiempo real.

## Lista previa al vuelo

1. Instala el SDK de .NET 11 y los workloads de MAUI. Verifica con `dotnet workload list`. Quieres `maui`, `maui-android`, `maui-ios` y `maui-maccatalyst` todos en versión `11.0.x`.

   ```bash
   # .NET 11.0
   dotnet workload install maui
   dotnet workload list
   ```

2. Fija el SDK en `global.json` para que la rama de migración no avance por su cuenta a mitad del PR:

   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```

3. Etiqueta la compilación actual de Xamarin.Forms en el control de versiones. `git tag pre-maui-migration` basta. Si la migración se tuerce en la segunda semana, quieres un punto limpio al que volver.
4. Captura una instantánea de los recursos de plataforma. Recorre las carpetas `Drawable*`, `Assets.xcassets`, los storyboard de splash y las entradas de Info.plist / AndroidManifest.xml. Resizetizer reorganiza todo ese árbol y quieres un inventario del estado anterior por si se pierde un recurso.
5. Inventaría los registros de `DependencyService`. `grep -rn "DependencyService\\|Dependency(typeof" .` devuelve la lista exhaustiva. Cada uno se convertirá en una llamada `services.AddSingleton` o `services.AddTransient`.
6. Inventaría los renderers personalizados. Grep por `ExportRenderer` y lee cada uno. Algunos pueden eliminarse directamente (los defaults de MAUI son mejores que los de Xamarin.Forms), otros se convierten en handlers, otros en `Behaviors`.
7. Ejecuta `dotnet test` sobre el árbol Xamarin.Forms y guarda el verde de referencia. Una migración que introduce tres regresiones en pruebas es mucho más fácil de diagnosticar que una que aterriza sobre una base que ya tenía cinco pruebas inestables.

## Pasos de migración

1. **Ejecuta primero el upgrade assistant sobre el proyecto compartido.** Reescribe el csproj a formato SDK, actualiza los espacios de nombres más obvios (`Xamarin.Forms` → `Microsoft.Maui.Controls`) y marca los sitios de renderer y `DependencyService` que no puede manejar.

   ```bash
   # .NET 11
   dotnet tool install -g upgrade-assistant
   upgrade-assistant upgrade ./src/MyApp/MyApp.csproj --target-tfm net11.0
   ```

   Verificación: `dotnet restore` tiene éxito sobre el nuevo csproj y `git status` muestra las reescrituras esperadas. No lo ejecutes todavía sobre los proyectos head; estás a punto de eliminarlos.

2. **Colapsa los proyectos head en un único csproj de formato SDK.** Xamarin.Forms se entrega como un proyecto compartido más `MyApp.Android`, `MyApp.iOS` y opcionalmente `MyApp.UWP`. MAUI se entrega como un csproj con multi-targeting. Mueve el código específico de Android bajo `Platforms/Android/`, el de iOS bajo `Platforms/iOS/` y elimina los csproj head. La cabecera del nuevo csproj se ve así:

   ```xml
   <!-- src/MyApp/MyApp.csproj, .NET MAUI 11, net11.0 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFrameworks>net11.0-android35.0;net11.0-ios18.0;net11.0-maccatalyst18.0</TargetFrameworks>
       <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
       <OutputType>Exe</OutputType>
       <UseMaui>true</UseMaui>
       <SingleProject>true</SingleProject>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
       <RootNamespace>MyApp</RootNamespace>
       <ApplicationId>net.mycompany.myapp</ApplicationId>
       <ApplicationDisplayVersion>1.0</ApplicationDisplayVersion>
       <ApplicationVersion>1</ApplicationVersion>
     </PropertyGroup>
   </Project>
   ```

   Verificación: `dotnet build -t:Restore` tiene éxito y el proyecto carga en Visual Studio 2026 17.14 o Rider 2026.1 sin advertencias de "tipo de proyecto no soportado".

3. **Reescribe `App.xaml.cs` para usar `MauiProgram.CreateMauiApp`.** Xamarin.Forms arrancaba en `MainActivity.OnCreate` mediante `LoadApplication(new App())`. MAUI delega eso en `MauiAppBuilder`. El punto de entrada queda así:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11, C# 14
   using Microsoft.Extensions.Logging;
   using Microsoft.Maui.Hosting;

   namespace MyApp;

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
                   fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
               });

           builder.Services.AddSingleton<IAuthService, AuthService>();
           builder.Services.AddTransient<MainPageViewModel>();

           return builder.Build();
       }
   }
   ```

   Verificación: `dotnet build -f net11.0-android35.0` termina en 0 y el IDE resuelve `MauiProgram` desde cualquier constructor de página.

4. **Convierte cada registro de `DependencyService` a `IServiceCollection`.** Esto es mecánico pero obligatorio; `DependencyService.Get<T>()` desapareció en MAUI 11. El reemplazo:

   ```csharp
   // Before, Xamarin.Forms 5.0
   DependencyService.Register<IAuthService, AuthService>();
   var auth = DependencyService.Get<IAuthService>();

   // After, .NET MAUI 11
   // Registration moves to MauiProgram.CreateMauiApp (step 3).
   // Resolution moves to the constructor or to IPlatformApplication.Current.Services.
   public partial class MainPage : ContentPage
   {
       public MainPage(IAuthService auth) // injected
       {
           InitializeComponent();
       }
   }
   ```

   Para los sitios donde la inyección por constructor es impráctica (un helper estático, un handler de `AppShell`), `IPlatformApplication.Current!.Services.GetRequiredService<IAuthService>()` es la salida de emergencia.

   Verificación: `grep -rn "DependencyService" src/` devuelve cero coincidencias. CI falla si no es así.

5. **Reemplaza los renderers personalizados por handlers.** Este es el paso que más tiempo consume. Un renderer personalizado de Xamarin.Forms que sobrescribía `OnElementPropertyChanged` se convierte en [un handler de MAUI con un diccionario `Mapper`](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize). Ejemplo: un renderer que quita el subrayado de un `Entry` Android:

   ```csharp
   // .NET MAUI 11, C# 14
   // Platforms/Android/EntryHandlerCustomization.cs
   using Microsoft.Maui.Handlers;

   public static class EntryHandlerCustomization
   {
       public static void Apply()
       {
           EntryHandler.Mapper.AppendToMapping("NoUnderline", (handler, entry) =>
           {
               handler.PlatformView.BackgroundTintList =
                   Android.Content.Res.ColorStateList.ValueOf(
                       Android.Graphics.Color.Transparent);
           });
       }
   }
   ```

   Registra la personalización en `MauiProgram.CreateMauiApp` vía `builder.ConfigureMauiHandlers(...)` o invoca `Apply()` desde un `partial void` en `MauiProgram` para que solo corra en Android. Mantén el mismo patrón para iOS bajo `Platforms/iOS/`.

   Verificación: cada página que dependía del renderer antiguo se renderiza correctamente con `dotnet build -t:Run -f net11.0-android35.0`. Prueba visual, no solo de compilación.

6. **Retira `MessagingCenter` por el messenger de CommunityToolkit.** `MessagingCenter` está marcado como obsoleto en MAUI 11 y está programado para eliminación en MAUI 12. Adopta `CommunityToolkit.Mvvm` 8.4.0 o superior:

   ```bash
   # .NET MAUI 11
   dotnet add package CommunityToolkit.Mvvm --version 8.4.0
   ```

   El cambio de patrón:

   ```csharp
   // Before, Xamarin.Forms 5.0
   MessagingCenter.Subscribe<LoginViewModel>(this, "LoggedIn", _ => RefreshUi());
   MessagingCenter.Send(this, "LoggedIn");

   // After, .NET MAUI 11 with CommunityToolkit.Mvvm 8.4.0
   public sealed record LoggedInMessage;
   WeakReferenceMessenger.Default.Register<LoggedInMessage>(this, (r, m) => RefreshUi());
   WeakReferenceMessenger.Default.Send(new LoggedInMessage());
   ```

   El `WeakReferenceMessenger` evita los bugs de ciclo de vida que hacían que `MessagingCenter` filtrara memoria en apps shell de larga duración.

7. **Mueve los recursos a Resizetizer.** Elimina `Resources/drawable-*`, `Assets.xcassets` y las pantallas de inicio duplicadas. Pon un `appicon.svg` y un `splash.svg` bajo `Resources/AppIcon/` y `Resources/Splash/`. El csproj ya los conoce por los items `MauiIcon` y `MauiSplashScreen` que emitió el upgrade assistant. El redimensionado en compilación reemplaza toda la escalera de densidades.

   ```xml
   <!-- src/MyApp/MyApp.csproj fragment -->
   <ItemGroup>
     <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
     <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
     <MauiImage Include="Resources\Images\*" />
     <MauiFont Include="Resources\Fonts\*" />
   </ItemGroup>
   ```

   Verificación: `dotnet build -f net11.0-android35.0` produce `bin/Debug/net11.0-android35.0/Resources/drawable-xxhdpi/appicon.png` sin que lo hayas creado a mano.

8. **Actualiza `MainActivity` y `MainApplication` de Android.** Xamarin.Forms tenía un `MainActivity` que derivaba de `FormsAppCompatActivity`. MAUI divide eso en `MainActivity` más `MainApplication`:

   ```csharp
   // Platforms/Android/MainActivity.cs, .NET MAUI 11
   using Android.App;
   using Android.Content.PM;
   using Android.OS;

   namespace MyApp;

   [Activity(Theme = "@style/Maui.SplashTheme",
             MainLauncher = true,
             ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation |
                                    ConfigChanges.UiMode | ConfigChanges.ScreenLayout |
                                    ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity { }

   // Platforms/Android/MainApplication.cs, .NET MAUI 11
   [Application]
   public class MainApplication : MauiApplication
   {
       public MainApplication(IntPtr handle, Android.Runtime.JniHandleOwnership ownership)
           : base(handle, ownership) { }

       protected override MauiApp CreateMauiApp() => MyApp.MauiProgram.CreateMauiApp();
   }
   ```

   En iOS el equivalente es un único `AppDelegate` derivado de `MauiUIApplicationDelegate`. El patrón es idéntico: sobrescribe `CreateMauiApp` e invoca el `MauiProgram` compartido.

9. **Convierte los espacios de nombres XAML.** Cada `xmlns="http://xamarin.com/schemas/2014/forms"` pasa a `xmlns="http://schemas.microsoft.com/dotnet/2021/maui"`. El upgrade assistant cubre la mayoría, pero los archivos con espacios mixtos (bibliotecas de controles personalizados que tiraban de `xamarin.toolkit`) necesitan un barrido manual. `Frame` sigue funcionando una versión más, pero produce una advertencia de compilación. Planea reemplazarlo por `Border` más `StrokeShape="RoundRectangle 12"` y un `BackgroundColor`. `MasterDetailPage` debe renombrarse a `FlyoutPage` tanto en XAML como en code-behind, incluyendo cualquier `x:TypeArguments`.

10. **Audita `Application.Properties` hacia `Preferences`.** Cualquier código que escribía a `Application.Current.Properties["key"] = value` debe pasar a `Preferences.Set("key", value)` de `Microsoft.Maui.Storage`. La forma es similar pero el backend de almacenamiento difiere, así que en el primer arranque puede que necesites una copia única. Hazla idempotente con un flag `"migrated_to_preferences"` para que no se vuelva a ejecutar.

11. **Fija cada dependencia NuGet a una versión compatible con MAUI.** Ejecuta `dotnet list package --vulnerable` y `dotnet list package --outdated` después del upgrade. Sospechosos habituales: `Xamarin.Essentials` (desapareció, plegado en MAUI), `Xamarin.Forms.Maps` (reemplazado por `Microsoft.Maui.Controls.Maps`), `Xamarin.Forms.Visual.Material` (reemplazado por los estilos Material 3 de MAUI, ver [el artículo sobre Material 3 en MAUI 10](/es/2026/05/maui-10-material-3-android-usematerial3-flag/)).

## Verificación

Después de los pasos anteriores:

- `dotnet restore` termina en 0 sobre un clon limpio de la rama de migración.
- `dotnet build -f net11.0-android35.0` y `-f net11.0-ios18.0` terminan ambos en 0.
- El proyecto de pruebas unitarias, retargeteado a `net11.0`, corre `dotnet test` a verde limpio.
- `dotnet build -t:Run -f net11.0-android35.0` lanza la app en un emulador y llega a la primera página sin excepción no controlada.
- Prueba manual en un dispositivo real de cada página que contenía un renderer personalizado en el árbol Xamarin.Forms.
- Compara el tiempo de arranque en frío antes y después usando un cronómetro desde el toque en el launcher hasta el primer fotograma. CoreCLR más AOT deberían dejar una app mediana bajo un segundo en un teléfono Android de gama media de 2024. Si hubo regresión, revisa el paso 5; un handler que hace trabajo de layout síncrono en el hilo de UI es el culpable habitual.

## Plan de rollback

No hay rollback automatizado una vez reescrito el csproj. El plan realista es:

1. Mantén la etiqueta git `pre-maui-migration` de la lista previa al vuelo.
2. Mantén la migración en su propia rama hasta que la verificación esté verde en Android e iOS.
3. Si tienes que revertir después de fusionar a main, el camino seguro es `git revert` del commit de merge seguido de una restauración limpia del árbol Xamarin.Forms y un redespliegue. No existe un "downgrade" in-situ de un csproj de formato SDK al diseño heredado de proyecto compartido.

Si tu ventana de release no tolera una migración de ida única, publica la build MAUI como una aplicación con ID paralelo (`net.mycompany.myapp.maui`) en las tiendas durante un ciclo, consigue un porcentaje libre de crashes superior al 99.5 % sobre tráfico de producción, y luego cambia el bundle ID con una actualización forzada.

## Tropezones que nos encontramos

- **El shrinking de recursos Android se lleva tus fuentes por delante.** `Resources/Fonts/OpenSans-Regular.ttf` termina bajo `Resources/font/opensans_regular.ttf` después del renombrado de resizetizer. El resource shrinker de R8 elimina contento las fuentes que parecen sin referencia desde XAML. Arréglalo añadiendo `<MauiAsset Include="Resources/Fonts/**/*.ttf" />` explícitamente y desactivando el shrinking hasta el próximo release: `<AndroidLinkResources>false</AndroidLinkResources>` solo en Debug.
- **El `UIRequiredDeviceCapabilities` de `Info.plist` en iOS necesita `arm64`.** El cambio de Mono a CoreCLR solo envía binarios ARM64. Si `Info.plist` todavía lista `armv7`, App Store Connect rechaza la subida.
- **La extensión de marcado `OnPlatform` se comporta distinto para `Default`**. En Xamarin.Forms un `Default` sin especificar caía al valor de plataforma. En MAUI 11 `Default` debe fijarse explícitamente cuando se usa como forma de extensión de marcado. Añade un valor `Default` o pásate a la forma de elemento `<OnPlatform>`.
- **Un `Frame` dentro de un `Grid` colapsa a altura cero.** El reemplazo `Border` no hereda el default `HorizontalOptions="Fill"` de `Frame`. Sé explícito: `HorizontalOptions="Fill" VerticalOptions="Fill"`.
- **`Microsoft.Maui.Controls.Compatibility` no sale gratis.** Existe, y te permite mantener uno o dos renderers tercos vivos mientras terminas la migración, pero cada referencia a `Compatibility` mantiene la cadena de renderers heredada en tu build y deshace parte de la ganancia de arranque en frío de CoreCLR. Úsalo como puente, no como destino.

## Relacionados

- [Migrar un ListView de alto rendimiento de Xamarin.Forms a CollectionView de MAUI](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/)
- [Migrar de .NET 8 a .NET 11: la lista completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Migrar de .NET Framework 4.8 a .NET 11 en 2026](/es/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [MAUI vs Avalonia vs Uno en 2026](/es/2026/05/maui-vs-avalonia-vs-uno-in-2026/)
- [Flutter vs React Native vs MAUI para un nuevo proyecto móvil en 2026](/es/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)

## Fuentes

- [.NET MAUI upgrade from Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) en MS Learn.
- [Documentación de handlers de .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) cubriendo el reemplazo de renderers.
- [Notas de release de .NET MAUI 11.0](https://github.com/dotnet/maui/releases) en GitHub.
- [`Microsoft.Maui.Storage.Preferences`](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences) reemplazando a `Application.Properties`.
- [Guía del messenger de CommunityToolkit.Mvvm](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) reemplazando a `MessagingCenter`.

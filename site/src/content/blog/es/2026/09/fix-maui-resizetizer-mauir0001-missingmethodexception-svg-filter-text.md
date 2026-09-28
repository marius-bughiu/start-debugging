---
title: "Corrección: MAUIR0001 MissingMethodException en el Resizetizer de .NET MAUI en un SVG con <filter> o <text>"
description: "El Resizetizer de MAUI 10.0.101 y 10.0.110 incluye referencias de System.Memory desalineadas, por lo que los SVG con filtros o texto fallan. Fija Resizetizer en 10.0.100 o elimina el filtro y el texto."
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "msbuild"
  - "csharp"
lang: "es"
translationOf: "2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text"
translatedBy: "claude"
translationDate: 2026-09-28
---

Si tu compilación de .NET MAUI 10 empezó a fallar con `error MAUIR0001: There was an exception processing the image` y un `System.MissingMethodException` para `SKImageFilter.CreateMatrixConvolution`, `SKTextBlobBuilder.AddPositionedRun` o `SKTypeface.Clone`, la causa es el propio paquete Resizetizer, no tu SVG. `Microsoft.Maui.Resizetizer` 10.0.101 y 10.0.110 incluyen una compilación de SkiaSharp 4.150.1 que pide `System.Memory` 4.0.5.0 junto a un `Svg.Skia` que pide 4.0.2.0, y MSBuild carga dos tipos `ReadOnlySpan<T>` distintos. Cualquier SVG que use un elemento `<filter>` o `<text>` falla. La solución más rápida es fijar `Microsoft.Maui.Resizetizer` en 10.0.100 mientras el resto de MAUI se queda en 10.0.110; la solución duradera es eliminar los filtros y convertir el texto en paths en tus SVG de `MauiIcon`, `MauiSplashScreen` y `MauiImage`.

## El error en contexto

Se reportaron dos variantes del error en el proyecto original (upstream). La variante de filtro, en [dotnet/maui#38319](https://github.com/dotnet/maui/issues/38319):

```text
error MAUIR0001: There was an exception processing the image '...\Resources\AppIcon\appicon.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKImageFilter SkiaSharp.SKImageFilter.CreateMatrixConvolution(
    SkiaSharp.SKSizeI, System.ReadOnlySpan`1<Single>, Single, Single,
    SkiaSharp.SKPointI, SkiaSharp.SKShaderTileMode, Boolean, SkiaSharp.SKImageFilter)'.
   at Svg.Skia.SkiaModel.ToSKImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.GetRenderImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.CreateRenderPaint(SKPaint paint)
   at Svg.Skia.SKSvg.Load(String path)
   at Microsoft.Maui.Resizetizer.SkiaSharpSvgTools..ctor(...)
```

La variante de texto en 10.0.101, en [dotnet/maui#38507](https://github.com/dotnet/maui/issues/38507):

```text
error MAUIR0001: There was an exception processing the image '.../Resources/Images/place_capsule.svg'.
System.MissingMethodException: Method not found: 'Void SkiaSharp.SKTextBlobBuilder.AddPositionedRun
(System.ReadOnlySpan`1<UInt16>, SkiaSharp.SKFont, System.ReadOnlySpan`1<SkiaSharp.SKPoint>)'.
```

En 10.0.110 la variante de texto pasó a otro método, porque 10.0.110 subió `Svg.Skia` de 5.1.1 a 5.2.3 y la nueva versión resuelve las fuentes de otra manera. Esto es lo que obtengo en 10.0.110 con un elemento `<text>` simple:

```text
error MAUIR0001: There was an exception processing the image '.../text.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKTypeface SkiaSharp.SKTypeface.Clone(System.ReadOnlySpan`1<SkiaSharp.SKFontVariationPositionCoordinate>)'.
   at Svg.Skia.SkiaModel.ApplyVariableFontWeight(SKTypeface typeface, SKFontStyle style)
   at Svg.Skia.SkiaModel.ResolveSKTypeface(SKTypeface typeface)
   at Svg.Skia.SkiaModel.ToSKFont(SKPaint paint)
```

Un comentario en #38507 también reporta una variante de la misma excepción con `HarfBuzzSharp.Font.SetVariations(ReadOnlySpan<Variation>)` desde el paso `GenerateSplashStoryboard` de iOS. Sea cual sea el nombre del método, fíjate en la firma: todos reciben un `ReadOnlySpan<T>`. Ese es todo el bug.

## Por qué el Resizetizer no encuentra un método que existe

Lo primero que hace todo el mundo es abrir `SkiaSharp.dll` en un decompilador y encontrar el método ahí mismo. Quien reportó el issue #38507 hizo exactamente eso y confirmó por reflection que `AddPositionedRun(ReadOnlySpan<ushort>, SKFont, ReadOnlySpan<SKPoint>)` está presente. Yo hice lo mismo con `System.Reflection.Metadata` contra la carpeta `buildTransitive` de cada versión del paquete, y se confirma: los métodos existen en 10.0.100, 10.0.101 y 10.0.110.

La diferencia está en las referencias de ensamblados. Esto es lo que pide cada ensamblado incluido:

| Resizetizer | SkiaSharp.dll (TFM) | SkiaSharp pide System.Memory | Svg.Skia pide System.Memory | System.Memory.dll incluido |
|---|---|---|---|---|
| 10.0.100 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |
| 10.0.101 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 10.0.110 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 11.0.0-rc.1 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |

La subida de versión de SkiaSharp llegó mediante [dotnet/maui#37731](https://github.com/dotnet/maui/pull/37731) ("Update SkiaSharp to 4.150.1"), que se retroportó (backport) a la rama de mantenimiento 10.0.1xx y se publicó en 10.0.101.

Ahora fíjate en cómo `dotnet build` carga las dependencias de una tarea. MSBuild en .NET pone cada ensamblado de tarea en su propio `MSBuildLoadContext`. Cuando se solicita una dependencia, sondea la carpeta de la tarea, y en [`MSBuildLoadContext.Load`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs) se omite el archivo local si la versión local es menor que la solicitada:

```csharp
// dotnet/msbuild main, src/Framework/Loader/MSBuildLoadContext.cs (abridged)
AssemblyName candidateAssemblyName = AssemblyLoadContext.GetAssemblyName(candidatePath);
if (candidateAssemblyName.Version < assemblyName.Version)
{
    continue;
}
return LoadFromAssemblyPath(candidatePath);
```

Entonces, en 10.0.101 y 10.0.110:

1. `Svg.Skia` pide `System.Memory` 4.0.2.0. La carpeta de la tarea tiene 4.0.2.0, así que MSBuild carga ese archivo en el contexto del plugin. Ese `System.Memory.dll` es la compilación fuera de banda del paquete netstandard2.0, que **define su propio** tipo `System.ReadOnlySpan<T>`.
2. `SkiaSharp` pide `System.Memory` 4.0.5.0. La versión local 4.0.2.0 es demasiado antigua, así que la búsqueda cae al contexto predeterminado, que resuelve el facade de `System.Memory` del framework compartido. Ese facade reenvía (type-forward) `ReadOnlySpan<T>` a `System.Private.CoreLib`.
3. `Svg.Skia` compila una llamada a `SKImageFilter.CreateMatrixConvolution(..., ReadOnlySpan<float> [from System.Memory.dll], ...)`. `SkiaSharp` expone `CreateMatrixConvolution(..., ReadOnlySpan<float> [from CoreLib], ...)`. Mismo nombre, mismo texto, distinta identidad de tipo. El runtime no puede enlazarlo y lanza `MissingMethodException` cuando compila el método que hace la llamada mediante JIT.

Esto también explica por qué la traza de #38319 menciona `CreateMatrixConvolution` aunque el SVG de reproducción solo usa `feGaussianBlur`: la excepción se dispara cuando se compila con JIT `Svg.Skia.SkiaModel.ToSKImageFilter`, y ese método contiene la llamada para cada primitiva de filtro. Cualquier SVG con cualquier `<filter>` llega a ese método. Los SVG sin filtros ni texto nunca tocan una API de SkiaSharp que reciba un span durante la rasterización, por eso el ícono de la plantilla predeterminada sigue compilando.

Para probar el mecanismo, copié la carpeta `buildTransitive` de 10.0.110, borré solo `System.Memory.dll`, y apunté la tarea a la copia. Ambos SVG que fallaban se rasterizaron bien, porque ahora toda solicitud de `System.Memory` termina en el facade del framework y solo hay un `ReadOnlySpan<T>`. No publiques ese hack en producción, pero confirma el diagnóstico.

## Reproducción mínima

No necesitas el workload de MAUI para reproducir esto, porque el Resizetizer es una tarea de MSBuild común. Extrae `microsoft.maui.resizetizer.10.0.110.nupkg` y ejecuta la tarea directamente:

```xml
<!-- .NET SDK 10.0.302, Microsoft.Maui.Resizetizer 10.0.110 (extracted nupkg), run.proj -->
<Project>
  <UsingTask AssemblyFile="$(RzDir)/Microsoft.Maui.Resizetizer.dll"
             TaskName="Microsoft.Maui.Resizetizer.ResizetizeImages" />
  <Target Name="Build">
    <ItemGroup><Img Include="$(Svg)" BaseSize="128,128" /></ItemGroup>
    <ResizetizeImages PlatformType="android"
                      IntermediateOutputPath="$(MSBuildThisFileDirectory)out/"
                      InputsFile="$(MSBuildThisFileDirectory)out/inputs.txt"
                      Images="@(Img)" />
  </Target>
</Project>
```

Con dos imágenes de prueba:

```xml
<!-- filter.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <filter id="blur"><feGaussianBlur stdDeviation="8" /></filter>
  <rect width="456" height="456" fill="#512BD4" filter="url(#blur)" />
</svg>
```

```xml
<!-- text.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <rect width="456" height="456" fill="#512BD4" />
  <text font-family="Arial" font-size="120" fill="#FFFFFF"><tspan x="60 150 240" y="280">SD!</tspan></text>
</svg>
```

Ejecutar `dotnet build run.proj -nodeReuse:false -p:RzDir=<buildTransitive folder> -p:Svg=<file>` contra cada paquete me dio esto en macOS con el SDK 10.0.302:

| Resizetizer | SVG simple | `<filter>` | `<text>` |
|---|---|---|---|
| 10.0.100 | OK | OK | OK |
| 10.0.101 | OK | `CreateMatrixConvolution` | `AddPositionedRun` |
| 10.0.110 | OK | `CreateMatrixConvolution` | `SKTypeface.Clone` |
| 11.0.0-rc.1.26451.6 | OK | OK | OK |

Cambiar `PlatformType` a `ios` falla de la misma manera en 10.0.110, así que 10.0.110 no arregló ninguna de las dos variantes en ninguna plataforma en mis pruebas. A día de hoy, #38319 y #38507 siguen abiertos, y la solución propuesta, [dotnet/maui#38883](https://github.com/dotnet/maui/pull/38883), es un borrador que cambia el SkiaSharp incluido por su compilación netstandard2.0. Su ejecución de CI mostró incompatibilidades de bibliotecas nativas, así que no cuentes con que llegue en la próxima versión de mantenimiento.

## Solución 1: fijar Microsoft.Maui.Resizetizer en 10.0.100

El Resizetizer solo actúa en tiempo de compilación. Genera PNG y archivos de recursos; nada de él termina en tu app. Eso hace que sea seguro mantenerlo una versión atrás mientras el resto de MAUI se queda en 10.0.110.

El SDK de MAUI añade `Microsoft.Maui.Resizetizer` como un `PackageReference` implícito en `$(MauiVersion)`, pero los targets eliminan el elemento implícito cuando declaras uno explícito con el mismo nombre. `Microsoft.Maui.Controls` 10.0.110 también depende de `Microsoft.Maui.Resizetizer >= 10.0.110`, así que una simple bajada de versión hace fallar el restore:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Maui.Resizetizer from 10.0.110 to 10.0.100.
  App -> Microsoft.Maui.Controls 10.0.110 -> Microsoft.Maui.Resizetizer (>= 10.0.110)
  App -> Microsoft.Maui.Resizetizer (>= 10.0.100)
```

Suprime `NU1605` solo en esa referencia, para no ocultar bajadas de versión reales en otro lugar:

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.110, App.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="$(MauiVersion)" />

  <!-- Workaround for dotnet/maui#38319 and #38507. Remove when a fixed Resizetizer ships. -->
  <PackageReference Include="Microsoft.Maui.Resizetizer"
                    Version="10.0.100"
                    PrivateAssets="all"
                    NoWarn="NU1605" />
</ItemGroup>
```

Verifiqué que esto restaura sin problemas y que `project.assets.json` resuelve `Microsoft.Maui.Resizetizer/10.0.100`. Si usas Central Package Management, pon el `Version` en un elemento `PackageVersion` y conserva `NoWarn="NU1605"` en el `PackageReference`.

La alternativa más drástica, que usaron quienes reportaron ambos issues, es fijar todo MAUI hacia atrás con `<MauiVersion>10.0.100</MauiVersion>`. Eso funciona, pero renuncias a todas las correcciones de 10.0.110 para evitar un problema de una tarea de compilación. Solo hazlo si ya tienes otra razón para mantener MAUI atrás.

## Solución 2: elimina los filtros y el texto de los SVG que procesa el Resizetizer

Esta es la solución que mantendría incluso después de que el proyecto original publique un parche, porque además hace que tus íconos se vean igual en todas partes. El Resizetizer rasteriza los SVG con `Svg.Skia`, que no es un navegador. El texto depende de las fuentes presentes en la máquina de compilación (tu runner de CI en macOS y tu laptop con Windows elegirán fallbacks distintos), y los filtros SVG siempre han sido la parte menos fiel de cualquier renderizador que no sea un navegador.

Convierte el texto en contornos. En Inkscape 1.x puedes hacerlo desde la línea de comandos, lo cual es útil para una carpeta llena de assets:

```bash
# Inkscape 1.x, converts <text> to <path> and drops editor metadata
inkscape design/splash-source.svg --export-text-to-path --export-plain-svg --export-filename=Resources/Splash/splash.svg
```

En Figma, usa "Outline stroke" / "Flatten" en la capa de texto antes de exportar; en Illustrator, "Create Outlines". Guarda el archivo editable en algún lugar fuera de `Resources/` para que el Resizetizer nunca lo vea.

Para los filtros, tienes dos opciones:

- Reemplaza el efecto con geometría. Una sombra paralela en un ícono de app normalmente es una segunda forma con menor opacidad, desplazada unos pocos píxeles. Un resplandor suave puede ser un gradiente radial. Ninguno de los dos necesita `<filter>`.
- Rasteriza tú mismo la capa del efecto y usa un PNG. `MauiIcon` y `MauiSplashScreen` aceptan PNG, y los PNG nunca pasan por `Svg.Skia`. Exporta al tamaño más grande que necesites (1024x1024 para un ícono de app de iOS). Según la [documentación de íconos de app](https://learn.microsoft.com/dotnet/maui/user-interface/images/app-icons), un bitmap usado como imagen principal solo se redimensiona cuando defines `BaseSize`, así que la configuración más simple mantiene un fondo SVG y mueve el efecto a un primer plano en PNG:

```xml
<!-- .NET 10, MAUI 10.0.110, App.csproj -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg"
            ForegroundFile="Resources\AppIcon\appiconfg.png"
            Color="#512BD4" />
</ItemGroup>
```

Para encontrar todos los archivos afectados antes de que lo haga el CI, busca con grep los dos nombres de elemento:

```bash
# any shell with grep; lists SVGs the 10.0.101/10.0.110 Resizetizer will choke on
grep -rlE "<(filter|text)[ >]" --include="*.svg" Resources/
```

## Solución 3: pasa a MAUI 11 si de todos modos ibas a hacerlo

El Resizetizer de .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`) todavía incluye SkiaSharp 3.116.1 y un `Svg.Skia` 2.0.0.4 compatible, y los tres SVG de prueba se rasterizaron bien con él. Eso no es motivo para saltar a un release candidate por un solo error de compilación, pero si la actualización ya está planeada, este problema desaparece con ella. Ten en cuenta que la rama de mantenimiento 10.0.1xx adoptó SkiaSharp 4.150.1 primero, así que una compilación posterior de MAUI 11 podría heredar la misma combinación si no se corrige en el origen.

## Trampas y casos parecidos

- **Pasa en local y falla en CI.** El Resizetizer es incremental. Si los PNG se generaron con una compilación anterior en 10.0.100, el target se omite y tu build local se mantiene en verde después de la actualización. Las compilaciones limpias en CI los regeneran y fallan. Ejecuta `dotnet clean` o borra `obj/` en local para ver el estado real.
- **`dotnet build-server shutdown` no ayuda.** No se trata de un nodo de MSBuild obsoleto que retiene un SkiaSharp viejo. Quien reportó #38319 confirmó que se reproduce con `-nodeReuse:false`, y mi reproducción también usa ese flag.
- **Añadir un `PackageReference` de SkiaSharp a tu app no ayuda.** La tarea carga las copias desde la carpeta `buildTransitive` del paquete, no desde el grafo de dependencias de tu app. Esto también explica por qué la actualización no produjo ninguna advertencia de NuGet.
- **Existen otras causas de MAUIR0001.** `MAUIR0001` es el código genérico del Resizetizer para "exception processing the image". Un `ArgumentNullException` o `Unable to allocate pixels for the bitmap` bajo el mismo código es un problema distinto con sus propios issues en el proyecto original (por ejemplo [dotnet/maui#12109](https://github.com/dotnet/maui/issues/12109)). Solo el `MissingMethodException` con un parámetro `ReadOnlySpan` es este bug.
- **Las fuentes en `MauiFont` no se ven afectadas.** El fallo está solo en la rasterización de SVG. El renderizado de texto en tiempo de ejecución (runtime), incluidas las fuentes personalizadas, no toca este código.
- **Los fallos de carga de ensamblados en tu propia app se parecen pero no son esto.** Si obtienes `MissingMethodException` o `FileLoadException` en tiempo de ejecución en lugar de durante la compilación, consulta en cambio [cómo solucionar Could not load file or assembly en una app publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/).

## Relacionado

- Si la compilación de Android también falla justo después del paso del Resizetizer, [cómo arreglar "Gradle build failed to produce an .apk file" en MAUI Android](/es/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) cubre la siguiente rotura más común de CI.
- Para los runners de CI de iOS que también dejaron de compilar tras una actualización del SDK, consulta [Unable to find a valid iOS Simulator runtime during a MAUI build](/es/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/).
- El pipeline de assets del Resizetizer y los elementos `MauiIcon` / `MauiSplashScreen` se explican paso a paso en [cómo migrar de Xamarin.Forms a .NET MAUI 11](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- El empaquetado para la Store regenera todos los tamaños de ícono, así que [cómo empaquetar una app de .NET MAUI para la Microsoft Store](/es/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) es donde un ícono SVG con filtro te va a morder en Windows.

## Fuentes

- [dotnet/maui#38319: Resizetizer fails on any SVG app icon containing a `<filter>`](https://github.com/dotnet/maui/issues/38319)
- [dotnet/maui#38507: Resizetizer 10.0.101 fails on SVG `<text>` elements](https://github.com/dotnet/maui/issues/38507)
- [dotnet/maui#37731: Update SkiaSharp to 4.150.1](https://github.com/dotnet/maui/pull/37731)
- [dotnet/maui#38883: Fix Resizetizer loading incorrect SkiaSharp assembly (draft)](https://github.com/dotnet/maui/pull/38883)
- [dotnet/msbuild `MSBuildLoadContext.cs`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs)
- [Microsoft.Maui.Resizetizer on NuGet](https://www.nuget.org/packages/Microsoft.Maui.Resizetizer)
- [Add images to a .NET MAUI app project (MS Learn)](https://learn.microsoft.com/dotnet/maui/user-interface/images/images)

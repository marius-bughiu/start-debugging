---
title: "dotnet watch por fin llega a MAUI en Android y iOS en .NET 11 Preview 4"
description: ".NET 11 Preview 4 activa dotnet watch para dispositivos Android, emuladores Android y el Simulador de iOS. Editas, guardas y la app en ejecución se actualiza sin recompilación manual. Hay un detalle del csproj que aplica a iOS."
pubDate: 2026-05-13
tags:
  - "dotnet-11"
  - "maui"
  - "dotnet-watch"
  - "hot-reload"
  - "mobile"
lang: "es"
translationOf: "2026/05/dotnet-watch-maui-android-ios-net-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-13
---

Microsoft [lanzó .NET 11 Preview 4 el 12 de mayo de 2026](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), y para quienes desarrollan en MAUI el titular es pequeño en el changelog pero enorme en el día a día: `dotnet watch` ahora impulsa Hot Reload en dispositivos Android, emuladores Android y el Simulador de iOS. Hasta esta versión preliminar, el ciclo móvil de MAUI era "editar, recompilar, redesplegar" para todo lo que no fuera XAML. Preview 4 cierra esa brecha.

## El flujo de trabajo en la práctica

Abre una app MAUI, elige un target framework y un dispositivo, y ejecuta:

```bash
dotnet watch --framework net11.0-android
```

Para iOS tiene la misma forma, con el target del Simulador de iOS:

```bash
dotnet watch --framework net11.0-ios
```

`dotnet watch` despliega la app una sola vez, luego los eventos de cambio de archivos se traducen en deltas de Hot Reload y se envían al proceso en ejecución. Los cuerpos de métodos en C#, XAML y CSS fluyen por ese mismo canal. Agregar un nuevo `PackageReference` o `ProjectReference` a mitad de sesión también funciona en .NET 11: Roslyn valida el cambio, el target `ReferenceCopyLocalPathsOutputGroup` copia los nuevos ensamblados al directorio de salida y el aplicador de deltas en el proceso los carga vía el evento `AssemblyResolving`. Sin reinicio.

## El detalle de iOS que tienes que conocer

Hay un problema conocido que conviene fijar en la pared. Según las [notas de la versión preliminar de MAUI Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/dotnetmaui.md), `dotnet watch` no funciona en proyectos iOS a menos que `MtouchLink` esté deshabilitado. Mete esto en el `PropertyGroup` de iOS de tu `.csproj`:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <MtouchLink>None</MtouchLink>
</PropertyGroup>
```

Eso deshabilita el linker administrado para compilaciones Debug de iOS, lo cual está bien para el inner loop de desarrollo, pero no lo quieres en tu configuración Release. Mantén la condición acotada al TFM de iOS y a la configuración Debug, o muévela a una condición `Debug|iPhoneSimulator` si tienes configuraciones de plataforma separadas.

Las otras correcciones que Preview 4 trae para la ruta de iOS merecen mención: los conflictos de entrada de consola con el simulador están resueltos, desapareció la excepción de WebSocket que solía matar la sesión de Hot Reload y se eliminó el interbloqueo que congelaba la app con ediciones rápidas. Estos son los errores que hacían que versiones preliminares anteriores fueran inutilizables en iOS aunque watch técnicamente arrancara.

## Por qué esto importa más de lo que parece

El ciclo de feedback de MAUI ha sido la razón más citada por la cual veteranos de Xamarin y devs cercanos a Flutter se han mantenido al margen. Una recompilación de 30 segundos tras cada edición en C# mata el trabajo exploratorio de UI. `dotnet watch` para targets de escritorio (Windows, Mac Catalyst) lleva tiempo disponible, pero móvil es donde MAUI vive o muere. Preview 4 por fin pone el inner loop móvil de MAUI en la misma liga que el hot reload de `flutter run`.

Si ya sigues las versiones preliminares de .NET 11 en una rama paralela, esta es la que vale la pena usar en un proyecto real. Si estabas esperando, [descarga Preview 4](https://dotnet.microsoft.com/download/dotnet/11.0) y actualiza el `.csproj` de iOS antes de tu primer `dotnet watch`.

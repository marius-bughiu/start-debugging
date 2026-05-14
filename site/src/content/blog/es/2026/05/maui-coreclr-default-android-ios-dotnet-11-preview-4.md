---
title: "MAUI cambia a CoreCLR de manera predeterminada en Android, iOS y Mac Catalyst en .NET 11 Preview 4"
description: ".NET 11 Preview 4 convierte a CoreCLR en el runtime predeterminado para MAUI en Android, iOS, Mac Catalyst y tvOS. Mono sigue estando a una propiedad de MSBuild de distancia. Esto es lo que cambia, lo que se rompe y cómo desactivarlo."
pubDate: 2026-05-14
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "es"
translationOf: "2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-14
---

Microsoft [cambió el runtime predeterminado de MAUI a CoreCLR en .NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), lanzado el 13 de mayo de 2026. Los nuevos proyectos MAUI dirigidos a Android, iOS, Mac Catalyst y tvOS ahora se ejecutan sobre el mismo runtime que impulsa ASP.NET Core y las aplicaciones de consola en el escritorio. Mono ya no es la opción implícita en móvil. Este es el cambio arquitectónico individual más grande en MAUI desde la fusión con Xamarin, y aterriza silenciosamente detrás de un flag predeterminado.

Si estás siguiendo la historia móvil de .NET 11, esto se basa en [la llegada de `dotnet watch` a MAUI en Android e iOS en la misma versión preliminar](/es/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/).

## Por qué importa CoreCLR en un teléfono

Durante aproximadamente una década, Xamarin y luego MAUI corrieron sobre Mono en móvil porque CoreCLR no tenía una historia AOT funcional para los destinos móviles ARM. Mono incluía su propio compilador AOT, GC, JIT, profiler y depurador. Cada inversión en herramientas que Microsoft hizo en CoreCLR (compilación por niveles, PGO dinámico, el motor de regiones del Server GC, ReadyToRun) tenía que reimplementarse o saltarse en móvil.

El cambio a CoreCLR colapsa eso. MAUI móvil ahora obtiene el mismo JIT, GC y superficie de diagnóstico que un contenedor Linux ejecutando ASP.NET Core. Las cifras de inicio de Microsoft son positivas para plantillas base con ReadyToRun y PGO, pero el anuncio es honesto sobre regresiones en aplicaciones más grandes en Android y pide a los equipos medir en modo Release sobre dispositivos reales antes de asumir una victoria gratuita.

La otra razón por la que esto importa: CoreCLR en Android desbloquea NativeAOT para MAUI, que la publicación llama "un siguiente paso natural".

## Lo que se queda fuera de manera predeterminada

CoreCLR en móvil descarta algunas plataformas que Mono mantenía:

- Android x86 desaparece.
- Android API 23 e inferiores desaparece.
- Las APIs de embedding de Android (la ruta que usaban la mayoría de los autores de bibliotecas Xamarin.Android) desaparecen.
- Android arm32 está "todavía bajo revisión".
- Blazor WebAssembly no se ve afectado. WASM permanece sobre Mono porque CoreCLR no tiene un destino WebAssembly.

Si tu aplicación o cualquier dependencia transitiva de NuGet depende de las APIs de embedding o de binarios distribuidos para x86, la actualización fallará en tiempo de compilación o de carga, no en tiempo de ejecución en producción.

## Cómo desactivarlo

Una propiedad de MSBuild revierte los target frameworks afectados a Mono:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>
```

Quita la `Condition` para revertir todas las plataformas. Trata esto como una vía de escape temporal. Microsoft no se ha comprometido a mantener Mono distribuido para MAUI móvil más allá del ciclo de vida de .NET 11, y el anuncio plantea la propiedad como una forma de desbloquear una versión mientras presentas un issue de regresión, no como una opción de configuración a largo plazo.

## Qué hacer realmente esta semana

Tres cosas valen la pena hacer ahora, mientras todavía es una versión preliminar:

1. Compila sobre .NET 11 Preview 4 y verifica fallos derivados de las plataformas descartadas.
2. Ejecuta una compilación Release sobre un dispositivo Android de gama baja representativo y compara el inicio en frío, el inicio en caliente y el tamaño del APK contra la misma aplicación compilada sobre .NET 10. Los reportes de la comunidad incluyen tanto victorias como regresiones, así que las cifras genéricas no predecirán tu aplicación.
3. Si dependes de una biblioteca Xamarin.Android que no se ha tocado en años, verifica si usa las APIs de embedding. Si lo hace, no se cargará en CoreCLR y necesitas un reemplazo antes de que parta el tren GA.

Este es el tipo de cambio que se ve bien en benchmarks y silenciosamente rompe producción seis meses después cuando una dependencia transitiva resulta ser solo Mono. Mejor aprenderlo durante la versión preliminar.

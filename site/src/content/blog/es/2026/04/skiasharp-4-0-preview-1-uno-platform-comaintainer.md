---
title: "SkiaSharp 4.0 Preview 1: SKPath inmutable, fuentes variables y un nuevo co-mantenedor"
description: "SkiaSharp 4.0 Preview 1 llega con Uno Platform como co-mantenedor junto al equipo de .NET. SKPath se vuelve inmutable detrás de un nuevo SKPathBuilder, y HarfBuzzSharp obtiene control completo de ejes de fuentes variables OpenType."
pubDate: 2026-04-29
tags:
  - "skiasharp"
  - "dotnet"
  - "maui"
  - "graphics"
  - "uno-platform"
lang: "es"
translationOf: "2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer"
translatedBy: "claude"
translationDate: 2026-04-29
---

David Ortinau [anunció SkiaSharp 4.0 Preview 1 el 28 de abril de 2026](https://devblogs.microsoft.com/dotnet/welcome-to-skia-sharp-40-preview1/), con dos noticias que importan más que el salto de versión en sí: Uno Platform es ahora co-mantenedor oficial junto al equipo de .NET, y el motor Skia ha sido adelantado años de trabajo upstream en una sola versión.

## Un SkiaSharp co-mantenido

Hasta esta versión, las actualizaciones de SkiaSharp se movían al ritmo de Microsoft, que se había desacelerado visiblemente en 2024 y 2025 mientras el foco del equipo se desplazaba a otros lados. Sumar a Uno Platform en un rol formal de co-mantenedor es significativo porque Uno ya tiene un fork interno de larga data (`unoplatform/Uno.SkiaSharp`) para WebAssembly, y ese fork ha sido la fuente de la mayoría de los engine bumps de esta preview ([PRs #3560](https://github.com/mono/SkiaSharp/pull/3560) y [#3702](https://github.com/mono/SkiaSharp/pull/3702)). El efecto práctico: los gráficos de .NET MAUI, los controles de Avalonia, las apps de Uno y cada renderer de consola que usa SkiaSharp ahora corren sobre un Skia actual en lugar de uno que estaba quedando atrás de Chromium por un año o más.

Las correcciones de build para Android API 36, el tooling generador del lado de Linux y una galería de WebAssembly renovada llegaron a través del mismo conjunto de contribuciones.

## SKPath se vuelve inmutable

El cambio de API más grande es que `SKPath` ahora es inmutable por debajo. Los métodos mutadores familiares se mantienen para compatibilidad hacia atrás, pero la forma moderna de construir un path es a través del nuevo `SKPathBuilder`:

```csharp
using var builder = new SKPathBuilder();
builder.MoveTo(50, 0);
builder.LineTo(50, -50);
builder.LineTo(-30, -80);
builder.Close();

using SKPath path = builder.Detach();
canvas.DrawPath(path, paint);
```

`Detach()` te entrega el resultado inmutable. Como el `SkPath` subyacente ya no muta tras la construcción, el runtime puede compartir, hacer hash y reutilizar geometría de paths de forma segura entre hilos, lo que importa para cualquier framework de UI que cachea primitivas de dibujo entre frames. El código existente que llama a `path.MoveTo(...)` directamente sigue compilando y ejecutándose, así que las apps de MAUI y Xamarin.Forms no necesitan cambiar nada para tomar Preview 1.

## Fuentes variables a través de HarfBuzzSharp

La otra adición destacada es el control completo de ejes de fuentes variables OpenType. HarfBuzzSharp ahora expone los ejes que una fuente declara (peso, ancho, inclinación, tamaño óptico, o cualquier eje personalizado) y te permite crear variantes de tipografía sin tener que enviar diez archivos de fuente estáticos:

```csharp
using var blob = SKData.Create("Inter.ttf");
using var typeface = SKTypeface.FromData(blob);

var variation = new SKFontVariation
{
    { "wght", 650 },
    { "wdth", 110 },
};

using var variant = typeface.CreateVariant(variation);
using var font = new SKFont(variant, size: 24);
canvas.DrawText("Hello, variable fonts", 0, 0, font, paint);
```

Antes de esto, los llamadores tenían que bajar a handles nativos de HarfBuzz para fijar coordenadas de ejes. Preview 1 expone los mismos controles en APIs administradas planas a través de SkiaSharp y HarfBuzzSharp.

## Tomar la preview

El paquete está publicado detrás de `aka.ms/skiasharp-40-package`. La preview apunta al mismo conjunto de plataformas que 3.x (`net8.0`, `net9.0`, `net10.0`, más los heads móviles habituales), y el equipo está pidiendo feedback antes de cerrar la superficie de API para la versión estable de 4.0. Si mantienes una biblioteca de controles Skia personalizada, esta es la ventana para probar la semántica de path inmutable contra tu loop de dibujo y reportar cualquier cosa que mute un path después de cachearlo: ese es exactamente el patrón que pasa de "funciona en 3.x" a "necesita un `SKPathBuilder`" en 4.0.

Para un recorrido más profundo, Uno Platform organiza un evento Focus on SkiaSharp el 30 de junio, con sesiones de los ingenieros detrás de esta versión.

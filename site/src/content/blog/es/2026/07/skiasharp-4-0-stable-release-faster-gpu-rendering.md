---
title: "SkiaSharp 4.0 llega estable: renderizado GPU 24% mas rapido y una API depurada"
description: "SkiaSharp 4.148.0 es la primera versión estable de v4. Las interfaces con mucha GPU renderizan hasta 24% mas rapido, los shaders en CPU corren ~6x mas rapido y por fin se retira la superficie de API heredada. Esto es lo que cuesta realmente actualizar."
pubDate: 2026-07-01
tags:
  - "skiasharp"
  - "dotnet"
  - "graphics"
  - "maui"
  - "performance"
lang: "es"
translationOf: "2026/07/skiasharp-4-0-stable-release-faster-gpu-rendering"
translatedBy: "claude"
translationDate: 2026-07-01
---

Matthew Leibowitz [anunció la primera versión estable de SkiaSharp 4.0 el 29 de junio de 2026](https://devblogs.microsoft.com/dotnet/skiasharp-4-0-stable/), publicada como paquete NuGet `SkiaSharp 4.148.0`. Es la versión que consolida cada versión preliminar de v4 en un paquete que puedes llevar a producción, y si aplazaste las versiones preliminares (que cubrimos aquí en [SkiaSharp 4.0 Preview 1](/es/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/)) esperando a que la API se asentara, la API ya se asentó.

## El rendimiento es real

El titular no es una característica, es un número. En el backend acelerado por GPU, el trabajo que domina las interfaces modernas (tarjetas elevadas, sombras, superficies en capas) renderiza hasta 24% mas rapido que la versión estable anterior. Los propios números de Microsoft, medidos en Windows 11 con .NET 10 sobre OpenGL: un panel de tarjetas con sombra subió de 65 a 80 FPS, y un feed de actividad con desplazamiento pasó de 47 a 58 FPS.

El trabajo limitado por CPU mejoró aun mas. Los shaders procedurales de ruido Perlin, del tipo que usarías para efectos de textura o niebla, corren cerca de 6 veces mas rapido. Para apps de MAUI, Avalonia y Uno que se apoyan en SkiaSharp para dibujo personalizado, es una mejora gratuita a tu presupuesto de fotogramas sin cambios de código en la ruta caliente.

## Que trae realmente 4.148.0

Tres adiciones concretas llegan a la API estable:

- Control total de ejes de fuentes variables OpenType en SkiaSharp y HarfBuzzSharp, de modo que fijas `wght`, `wdth` o cualquier eje personalizado desde código gestionado en lugar de bajar a handles nativos de HarfBuzz.
- Paletas de color para fuentes de emoji e iconos.
- Codificación de WebP animado.

La ruta de fuentes variables es la que la mayoría de apps usará primero:

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
canvas.DrawText("One font file, every weight", 0, 0, font, paint);
```

## La parte que el anuncio minimiza

"Una API mas limpia y correcta" es la forma diplomática de decirlo. La traducción práctica: v4 completa una larga migración y se retira la superficie de API heredada. Si tu código todavía llama a miembros obsoletos de 3.x, o si construiste una biblioteca de controles personalizados contra el modelo mutable de `SKPath`, la compilación es donde te enteras. El patrón inmutable `SKPath` mas `SKPathBuilder` introducido en las versiones preliminares es ahora el predeterminado, así que cualquier bucle de dibujo que mutaba una ruta en caché debe pasar a un builder.

Para la mayoría de los consumidores la actualización es un cambio de una línea:

```xml
<PackageReference Include="SkiaSharp" Version="4.148.0" />
```

Hazlo en una rama, compila y lee las advertencias antes de leer las notas de la versión. Una compilación verde significa que ya estabas limpio. Una roja es una lista corta y mecánica de llamadas retiradas, no una reescritura. En cualquier caso, los FPS valen la tarde.

Los detalles completos están en la [versión SkiaSharp 4.148.0 en GitHub](https://github.com/mono/SkiaSharp/releases).

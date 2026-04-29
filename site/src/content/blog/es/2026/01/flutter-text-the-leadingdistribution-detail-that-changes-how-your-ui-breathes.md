---
title: "Flutter Text: el detalle de `leadingDistribution` que cambia cómo \"respira\" tu UI"
description: "La propiedad leadingDistribution dentro de TextHeightBehavior en Flutter controla cómo se reparte el leading extra por encima y por debajo de los glifos. Aquí está cuándo importa y cómo arreglar texto que se ve desalineado vertical."
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes"
translatedBy: "claude"
translationDate: 2026-04-29
---
Un video tutorial de Flutter publicado el 2026-01-16 me recordó una fuente sutil pero muy real de bugs del tipo "¿por qué esto se ve raro?": el widget `Text` es simple hasta que empiezas a combinar fuentes personalizadas, alturas de línea ajustadas y layouts multilínea.

Fuente: [Video](https://www.youtube.com/watch?v=xen-Al9H-4k) y el [post original en r/FlutterDev](https://www.reddit.com/r/FlutterDev/comments/1qfhug1/how_well_do_you_really_know_the_text_widget/).

## La altura de línea no es solo `TextStyle.height`

En Flutter 3.x, los desarrolladores suelen ajustar:

-   `TextStyle(height: ...)` para apretar o aflojar las líneas
-   `TextHeightBehavior(...)` para controlar cómo se aplica el leading

Si solo configuras `height`, todavía puedes terminar con texto que se ve verticalmente "descentrado" en un `Row`, o con encabezados que se sienten demasiado aireados comparados con el texto del cuerpo. Aquí es donde entra `leadingDistribution`.

`leadingDistribution` controla cómo se reparte el leading extra (el espacio añadido por la altura de línea) por encima y por debajo de los glifos. El valor por defecto no siempre es lo que quieres para la tipografía de UI.

## Un pequeño widget que hace obvia la diferencia

Aquí tienes un fragmento mínimo que puedes meter en una pantalla y comparar visualmente:

```dart
import 'package:flutter/material.dart';

class LeadingDistributionDemo extends StatelessWidget {
  const LeadingDistributionDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(
      fontSize: 20,
      height: 1.1, // intentionally tight so leading behavior is visible
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: const [
        Text('Default leadingDistribution', style: style),
        SizedBox(height: 8),
        Text(
          'Even leadingDistribution\n(two lines to show it)',
          style: style,
          textHeightBehavior: TextHeightBehavior(
            leadingDistribution: TextLeadingDistribution.even,
          ),
        ),
      ],
    );
  }
}
```

Cuando ves los dos bloques lado a lado, normalmente lo notas al instante con fuentes reales: un bloque queda "mejor" en su espacio vertical, sobre todo al alinearlo con iconos o cuando limitas la altura de un contenedor.

## Dónde muerde esto en apps reales

Este detalle tiende a aparecer en las partes de las apps de Flutter que son más difíciles de mantener pixel perfect:

-   **Botones y chips**: el texto del label se ve demasiado abajo o demasiado arriba respecto al contenedor.
-   **Cards con contenido mixto**: una pila de título + subtítulo no se siente espaciada de forma uniforme.
-   **Fuentes personalizadas**: las métricas de ascent/descent varían bastante entre tipografías.
-   **Internacionalización**: los scripts con métricas de glifo distintas exponen tus suposiciones de espaciado.

El arreglo no es "siempre configurar `leadingDistribution`". El arreglo es: cuando hagas limpieza tipográfica, incluye `TextHeightBehavior` en tu modelo mental, no solo `fontSize` y `height`.

Si tu UI en Flutter 3.x está al 95% pero igual se siente un poco rara, esta es una de las primeras perillas que reviso.

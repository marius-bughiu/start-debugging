---
title: "Solución: A RenderFlex overflowed by N pixels en Flutter"
description: "La solución en 30 segundos: envuelve el hijo que se desbordó en Expanded o Flexible. Después lee el resto para entender por qué Row y Column no recortan, qué significan las constraints sin límite y qué solución corresponde a cada layout."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderflex"
lang: "es"
translationOf: "2026/05/fix-renderflex-overflowed-in-flutter"
translatedBy: "claude"
translationDate: 2026-05-16
---

La solución en una frase: envuelve el hijo que creció demasiado de ancho (o de alto) en un `Expanded` o `Flexible`, define `mainAxisSize: MainAxisSize.min` en el `Row` o `Column` que lo contiene, o envuelve todo en un `SingleChildScrollView` si el contenido realmente debe desplazarse. La franja amarilla y negra no es un fallo de renderizado, es Flutter avisándote de que un hijo sin límites dentro de un `Row`, `Column` o `Flex` pidió más espacio del que su padre podía darle.

```text
A RenderFlex overflowed by 124 pixels on the right.

The overflowing RenderFlex has an orientation of Axis.horizontal.
The edge of the RenderFlex that is overflowing has been marked in the rendering
with a yellow and black striped pattern. This is usually caused by the contents
being too big for the RenderFlex.

The relevant error-causing widget was:
  Row  lib/widgets/profile_header.dart:42
```

Esta guía está escrita contra Flutter 3.27.1, Dart 3.11 y los widgets Material 3 tal como se publican en el canal estable. Todo lo que aparece aquí aplica sin cambios desde Flutter 3.10 y a lo largo de toda la línea 3.x. La API de `Row`, `Column`, `Expanded`, `Flexible` y `Flex` no ha cambiado en años; el `RenderFlex` subyacente vive en `package:flutter/src/rendering/flex.dart` y es ahí donde se lanza la aserción.

## Por qué Row y Column se niegan a recortar en silencio

Flutter hace el layout en una sola pasada. Cada padre pasa un objeto `BoxConstraints` a sus hijos, los hijos eligen un tamaño que satisfaga esas constraints y el padre los posiciona. La mayoría de los widgets aceptan el tamaño que elija su hijo, pero `Row`, `Column` y el widget `Flex` subyacente son diferentes: primero colocan los hijos no flexibles usando sus tamaños intrínsecos y después reparten el espacio restante entre los hijos `Expanded` y `Flexible`. Si los hijos no flexibles juntos exceden el espacio en el eje principal que el padre dio al flex, no queda nada que repartir y el layout está fuera de presupuesto.

`RenderFlex` podría recortar el desbordamiento en silencio, pero eso ocultaría errores de layout que solo aparecerían en el dispositivo más pequeño de tu flota. Por eso, en modo debug Flutter imprime la aserción, pinta el rectángulo de aviso a rayas sobre el borde desbordado y sigue renderizando. En release la franja desaparece pero el layout sigue mal: el texto se corta, los objetivos táctiles quedan fuera de pantalla y los lectores de pantalla leen contenido que el usuario no puede ver. Esto está documentado en la [página de errores comunes de Flutter](https://docs.flutter.dev/testing/common-errors) y coincide con el comentario al inicio de [flex.dart en el SDK de Flutter](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart).

## Una reproducción mínima que puedes pegar en una app nueva

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: OverflowDemo()));

class OverflowDemo extends StatelessWidget {
  const OverflowDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Icon(Icons.message),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Title', style: Theme.of(context).textTheme.headlineMedium),
                const Text(
                  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
                  'sed do eiusmod tempor incididunt ut labore et dolore '
                  'magna aliqua.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
```

Este es el caso canónico. El `Row` exterior tiene ancho acotado por el `Scaffold`, el `Icon` y el `SizedBox` son no flexibles y pequeños, pero el `Column` interior también es no flexible y envuelve un `Text` que quiere ser tan ancho como todo el párrafo en una sola línea. Ejecútalo en cualquier layout de tamaño teléfono y obtendrás el desbordamiento en el borde derecho.

## Elige la solución correcta: Expanded, Flexible o desplazable

Hay tres soluciones correctas y no son intercambiables.

### Solución 1: envuelve el hijo voraz en `Expanded`

Úsala cuando el hijo deba tomar todo el espacio restante en el eje principal. En la reproducción, el hijo voraz es el `Column`:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.message),
    const SizedBox(width: 8),
    Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Title', style: Theme.of(context).textTheme.headlineMedium),
          const Text(
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
            'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
          ),
        ],
      ),
    ),
  ],
)
```

`Expanded` es `Flexible` con `flex: 1` y `fit: FlexFit.tight`. "Tight" significa que el hijo debe llenar exactamente el espacio asignado. Dentro de un `Row`, eso da al `Text` interior un ancho acotado, lo que permite al motor de texto envolver el contenido en varias líneas. El desbordamiento desaparece porque el ancho intrínseco del `Text` ya no alimenta el cálculo de ancho del `Row`.

Es la solución correcta el 80% de las veces. Úsala siempre que tengas un ícono inicial más un cuerpo de texto en una fila, o un encabezado más un cuerpo desplazable en una columna. Consulta la [referencia de la clase Expanded](https://api.flutter.dev/flutter/widgets/Expanded-class.html) para el contrato formal.

### Solución 2: envuelve un hijo en `Flexible` cuando pueda ser más pequeño que su parte

`Flexible` usa por defecto `fit: FlexFit.loose`, que significa "puedes usar hasta este espacio pero no estás obligado a llenarlo." Úsala cuando tengas dos hijos que deban compartir el espacio restante proporcionalmente pero ninguno tenga que llenar su asignación. El caso clásico son dos `TextField` igualmente importantes uno al lado del otro, cada uno ocupando la mitad de la fila:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'First'))),
    const SizedBox(width: 8),
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'Last'))),
  ],
)
```

Si usaras `Expanded` aquí, los campos seguirían repartiéndose la fila al 50/50, pero si uno de ellos fuera un `Chip` en lugar de un `TextField`, `Expanded` estiraría el área del chip hasta llenar todo el ancho, lo que se ve roto. `Flexible` con el ancho natural del chip mantiene el tamaño visual correcto y aun así soluciona el desbordamiento.

La regla práctica: `Expanded` para "llena lo que queda", `Flexible` para "puedes crecer hasta lo que queda". Elegir mal entre ambos no suele provocar un desbordamiento, solo un widget feo y estirado.

### Solución 3: haz desplazable el eje cuando el contenido realmente no entre

Los desbordamientos en la parte inferior de un `Column` dentro de la pantalla de un teléfono son casi siempre señal de que se espera que el usuario haga scroll. La solución no es `Expanded`, es meter el `Column` dentro de un `SingleChildScrollView` (o reemplazarlo por un `ListView`):

```dart
// Flutter 3.27.1, Dart 3.11
Scaffold(
  body: SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final section in sections) SectionCard(section),
      ],
    ),
  ),
)
```

Para una lista larga con un número de elementos conocido e hijos homogéneos, prefiere `ListView.builder`, que construye perezosamente solo los elementos en pantalla. Un `SingleChildScrollView` con un `Column` construye cada hijo en cada frame, lo cual está bien para una página de configuración con ocho filas pero es ruinoso para un feed de mil filas. La [documentación de scrolling de Flutter](https://docs.flutter.dev/ui/layout/scrolling) traza esta línea claramente.

## Causa por causa: las cuatro formas en que se cuela este error

### Un widget `Text` dentro de un `Row` sin ancho acotado

La causa más común, mostrada en la reproducción de arriba. Las cadenas largas, los nombres de producto largos y las cadenas de UI traducidas (el alemán es notoriamente más ancho que el inglés) revientan `Row`s que funcionaban en la máquina del desarrollador. Envuelve siempre el texto suministrado por el usuario o traducido en `Expanded` o `Flexible` cuando esté dentro de un `Row`. Si se supone que el texto debe truncarse en lugar de envolver, añade `overflow: TextOverflow.ellipsis` y `maxLines: 1` en el propio widget `Text`:

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.person),
    const SizedBox(width: 8),
    Expanded(
      child: Text(
        user.fullName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
  ],
)
```

### Eje principal sin límites: un `Column` dentro de un `Column`, o un `Row` dentro de un `Row`

Si un `Column` es hijo de otro `Column`, el interior recibe altura sin límites. Cualquier cosa dentro de él que pida "tanto como quiera" obtiene infinito, de lo que entonces RenderFlex se queja. La solución es envolver el `Column` interior en `Expanded`, o definir `mainAxisSize: MainAxisSize.min` y meter el conjunto dentro de un desplazable.

Lo mismo aplica a un `Row` dentro de un `Row`, un `ListView` dentro de un `Column` o cualquier combinación donde el eje principal esté sin acotar. Lee [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) una vez y el resto deja de sorprender; explica el mantra "constraints go down, sizes go up, parent sets position" sobre el que funciona todo el sistema de layout. La misma propagación de constraints también provoca jank en tormentas de redimensionado, algo que cubrimos en [cómo perfilar jank en una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

### `width` o `height` cableado por un SizedBox o Container

Un `SizedBox(width: 400)` dentro de un `Row` con el ancho de un teléfono se desbordará por la derecha en `400 - rowWidth + remaining children` píxeles. Este es el único caso en que la solución no es `Expanded` sino "deja de cablear el ancho". Usa un layout que se adapte: `Expanded`, `Flexible`, `FractionallySizedBox(widthFactor: 0.5)`, o calcula el tamaño a partir de `MediaQuery.sizeOf(context)`.

Lo mismo aplica a las imágenes. Un `Image.network` sin una constraint de ancho informa su tamaño intrínseco, que puede ser 2000 píxeles para un asset del servidor. O bien le das al `Image` un ancho acotado (`Image.network(url, width: 64)`), o lo envuelves en un `Expanded`.

### Localización, escalado de fuentes y tamaños de texto de accesibilidad

Un `Row` que encaja perfectamente con la escala de fuente por defecto se desbordará a 1.4x o 2.0x de escala de texto. Este es el bug que llega a la App Store y consigue una reseña de una estrella de un usuario con fuentes grandes activadas. Prueba cada pantalla con overrides de `MediaQuery` en las escalas accesibles:

```dart
// Flutter 3.27.1, Dart 3.11
MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
    child: child!,
  ),
  home: const MyHomePage(),
)
```

`TextScaler` reemplaza la API más antigua `textScaleFactor` desde Flutter 3.16 y es la forma soportada para probar el escalado de texto. Si el layout se desborda bajo este envoltorio de `MediaQuery`, se desbordará en dispositivos reales y la solución es la misma: `Expanded`, `Flexible` o desplazable.

## Depurar qué widget se está desbordando

La aserción siempre nombra un widget y una ubicación en el código fuente, pero la ubicación apunta al `Row` o `Column` que se desbordó, no al hijo que causa el problema. Tres herramientas lo acotan:

1. La franja amarilla y negra en modo debug te dice el borde (derecho, inferior, etc.), lo que ya acota la búsqueda.
2. Activa "Debug Paint" en el Flutter Inspector (también disponible como `debugPaintSizeEnabled = true;` definido en `main`) para ver el contorno de cada render box. El hijo voraz suele extenderse visiblemente más allá del padre.
3. Usa el modo de selección de widgets del Inspector y haz clic sobre el área culpable en el simulador. El panel `RenderObject` del widget seleccionado muestra su tamaño y constraints. Compáralos con los del padre.

Para herramientas que van más a fondo, la misma sesión de DevTools que usas para trabajo de rendimiento soporta depuración de layout en la pestaña Layout Explorer. Si no te resulta familiar ese flujo, la entrada sobre [cómo perfilar jank en una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) recorre cómo abrir DevTools en modo profile contra un dispositivo real.

## Trampas y errores parecidos

- `Vertical viewport was given unbounded height` es el error hermano que aparece cuando un `ListView` vive dentro de un `Column` sin un `Expanded`. La solución tiene la misma forma: acota el hijo o haz desplazable al padre. No "lo arregles" poniendo `shrinkWrap: true` en el `ListView`; eso desactiva el renderizado perezoso y reproduce el desbordamiento original en posiciones de scroll más altas.
- `RenderBox was not laid out` significa que una aserción anterior de desbordamiento de `RenderFlex` se lanzó y el pipeline de layout nunca llegó a calcular la geometría de pintura. Sube en el log de errores hasta el primer mensaje de desbordamiento; ahí está el bug real.
- `BoxConstraints forces an infinite width` lanzado por `Text` significa que el `Text` está dentro de algo que le da un eje principal sin límites, normalmente un `Row` dentro de un `ListView` horizontal. Envuelve el `Text` en un contenedor de ancho fijo o usa `Flexible`.
- `A RenderFlex overflowed by Infinity pixels` es la variante de constraint sin límites. La solución nunca es "hacer el número más pequeño", es "dar al padre una constraint acotada", normalmente añadiendo `Expanded` más arriba en el árbol.
- Silenciar el aviso con `clipBehavior: Clip.hardEdge` en el `Row` o `Column` hace desaparecer la franja pero deja el bug de layout subyacente. Recurre al recorte solo cuando hayas demostrado que el desbordamiento es intencional (por ejemplo, una marquesina deliberadamente recortada).

## Relacionado

- [Cómo perfilar jank en una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) cubre la configuración de DevTools, que también es tu depurador de layout más rápido.
- [Cómo definir el color de acento en una app Flutter con Material 3 ColorScheme](/es/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) es donde empiezan la mayoría de problemas de desbordamiento de principiantes, ya que pasar a widgets M3 cambia los tamaños intrínsecos.
- [Cómo añadir código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) se vuelve relevante en cuanto empiezas a ocultar filas en factores de forma más pequeños.
- [Cómo apuntar a varias versiones de Flutter desde un único pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) importa porque el número exacto de píxeles en el mensaje de desbordamiento cambia entre versiones del SDK cuando se mueven las métricas de texto.

## Fuentes

- [Errores comunes de Flutter -- A RenderFlex overflowed](https://docs.flutter.dev/testing/common-errors), la sección oficial de los docs de Flutter que define el error y la solución canónica.
- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints), la explicación del protocolo de layout detrás de toda decisión de flex layout de este artículo.
- [Referencia de la clase Expanded](https://api.flutter.dev/flutter/widgets/Expanded-class.html), el doc de API que fija `Expanded` como `Flexible(flex: 1, fit: FlexFit.tight)`.
- [Referencia de la clase Flexible](https://api.flutter.dev/flutter/widgets/Flexible-class.html), el doc de API que explica `FlexFit.loose` vs `FlexFit.tight`.
- [Referencia de la clase Row](https://api.flutter.dev/flutter/widgets/Row-class.html) y [referencia de la clase Column](https://api.flutter.dev/flutter/widgets/Column-class.html), que describen literalmente el algoritmo de dimensionado en el eje principal.
- [flex.dart en el tag 3.27.1](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart), la fuente donde se lanza la aserción de desbordamiento.

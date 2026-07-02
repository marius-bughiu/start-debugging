---
title: "Cómo anidar un ListView dentro de un Column en Flutter sin el error de altura sin límites"
description: "Por qué un ListView dentro de un Column lanza 'Vertical viewport was given unbounded height', y las cuatro soluciones (Expanded, Flexible, shrinkWrap, SizedBox) con los compromisos de rendimiento que deciden cuál quieres."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "constraints"
lang: "es"
translationOf: "2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error"
translatedBy: "claude"
translationDate: 2026-07-02
---

Pon un `ListView` directamente dentro de un `Column` y Flutter lanza el error antes de dibujar un solo pixel: `Vertical viewport was given unbounded height`, normalmente seguido de un muro de diagnósticos de `RenderBox`. La respuesta corta: un `Column` entrega a sus hijos un espacio vertical sin límites, y un `ListView` desplazable se niega a renderizar dentro de una altura infinita porque no tendría idea de cuán alto ser. Lo solucionas dando a la lista una altura acotada, y la herramienta correcta es casi siempre `Expanded` (rellenar el espacio sobrante) cuando la lista es el único desplazable, o `shrinkWrap: true` cuando la lista es corta y finita. Este post explica por qué ocurre el error, muestra la reproducción mínima y recorre las cuatro soluciones en Flutter 3.x (probado en 3.44) para que elijas la que encaja, no solo la que silencia la excepción.

## Por qué un Column da altura sin límites a sus hijos

El layout de Flutter funciona sobre una única regla: las restricciones bajan, los tamaños suben. Un padre le dice a cada hijo el ancho y la altura mínimos y máximos que puede ocupar, el hijo elige un tamaño dentro de esos límites, y el padre lo posiciona. Todo el framework es ese apretón de manos repetido hacia abajo por el árbol.

Un `Column` es un widget `Flex` dispuesto a lo largo del eje vertical. A lo largo de su eje principal (vertical) **no** impone una altura máxima sobre sus hijos no flexibles. Le dice a cada hijo, en efecto, "sé tan alto como quieras, te apilaré y mediré el total después". En términos de restricciones el hijo recibe `maxHeight: double.infinity`. Eso es lo que significa "sin límites" (unbounded): la restricción de altura entrante no tiene un máximo finito.

La mayoría de los widgets están bien con eso. Un `Text`, un `Row`, un `Icon`, un `Container` con hijos: todos se dimensionan a su contenido, así que un techo infinito nunca importa. Reportan de vuelta una altura concreta y el `Column` la suma.

Un `ListView` es diferente. Es un viewport desplazable, y el trabajo entero de un viewport es ser una ventana fija sobre contenido que puede ser mucho más grande que él mismo. Para hacerlo necesita saber cuán alta es la ventana. A lo largo de su eje de desplazamiento (vertical) un `ListView` intenta expandirse para rellenar toda la altura que se le ofrece. Ofrécele infinito e intentaría volverse infinitamente alto, lo cual derrota el propósito del desplazamiento y no se puede disponer. Así que en lugar de producir silenciosamente un layout roto, el framework lanza la aserción:

```
The following assertion was thrown during performResize():
Vertical viewport was given unbounded height.
Viewports expand in the scrolling direction to fill their container. In this
case, a vertical viewport was given an unlimited amount of vertical space in
which to expand.
```

Dicho claramente: un `Column` dice "toma toda la altura que quieras", un `ListView` dice "solo funciono si me dices exactamente cuánta altura recibo", y los dos son incompatibles hasta que insertas un widget que resuelva la altura. Esta es la misma familia de fallo que [RenderBox was not laid out](/es/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), donde una restricción de tamaño ausente detiene el layout antes de pintar.

## La reproducción mínima

Aquí está el widget más pequeño que lo reproduce. Nada exótico, solo un encabezado apilado sobre una lista:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class ProfilePage extends StatelessWidget {
  const ProfilePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Text('Recent activity'),
        ListView(
          children: const [
            ListTile(title: Text('Item 1')),
            ListTile(title: Text('Item 2')),
            ListTile(title: Text('Item 3')),
          ],
        ),
      ],
    );
  }
}
```

Ejecútalo y obtienes la aserción de altura sin límites en el momento en que este subárbol hace su layout. El `Column` ofreció al `ListView` altura infinita; el `ListView` se rindió. Todo lo que sigue es una manera de cambiar qué altura recibe el `ListView`.

## Solución 1: Expanded, cuando la lista debe rellenar el espacio sobrante

Esta es la solución que quieres la mayoría de las veces. `Expanded` es un hijo flex que le dice al `Column` que le dé todo el espacio vertical que quede después de medir los hijos no flexibles. Como "todo el espacio restante" es un número concreto una vez que el `Column` conoce su propia altura, el `ListView` ahora recibe un `maxHeight` acotado y hace su layout normalmente, conservando el desplazamiento perezoso completo.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

La mecánica: `Expanded` fija el factor flex de su hijo y fuerza una altura ajustada igual a su porción del espacio libre. El `Column` mide primero el `Text`, lo resta de su propia altura, y entrega el resto a `Expanded`, que lo pasa hacia abajo como una restricción acotada. El `ListView` rellena exactamente esa ventana y desplaza sus hijos dentro de ella. Esta es la elección correcta siempre que la lista sea la región desplazable principal de la pantalla y quieras que crezca y encoja con la altura disponible, que es el caso abrumadoramente común (un encabezado sobre un feed, un campo de formulario sobre resultados, un título sobre un registro de chat).

Un requisito: el propio `Column` debe tener una altura acotada para que `Expanded` tenga algo que dividir. Dentro del body de un `Scaffold`, un `SizedBox` con una altura, o cualquier padre que ya acote el espacio vertical, la tiene. Si el `Column` está a su vez dentro de otro contexto sin límites, has empujado el mismo problema un nivel hacia arriba y necesitas acotar primero la caja externa.

Si quieres que la lista tome el espacio restante pero también se le permita encoger por debajo de su porción cuando el contenido es pequeño, usa `Flexible` en lugar de `Expanded`. `Expanded` es `Flexible` con `fit: FlexFit.tight`; un `Flexible` a secas usa `FlexFit.loose`, que significa "hasta esto, pero no más de lo que tu contenido necesita". Para un `ListView`, que quiere rellenar su eje, los dos se comportan igual en la práctica, así que echa mano de `Expanded` a menos que tengas un layout mixto donde la holgura importe.

## Solución 2: shrinkWrap, cuando la lista es corta y finita

Si la lista tiene un número pequeño y más o menos conocido de elementos y quieres que sea exactamente tan alta como su contenido (para que el `Column` pueda apilar más widgets debajo de ella), fija `shrinkWrap: true`:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    ListView(
      shrinkWrap: true,
      children: const [
        ListTile(title: Text('Item 1')),
        ListTile(title: Text('Item 2')),
        ListTile(title: Text('Item 3')),
      ],
    ),
    const Text('End of list'),
  ],
)
```

`shrinkWrap: true` invierte el comportamiento del viewport: en lugar de expandirse para rellenar su eje, mide todos sus hijos, suma sus alturas y se dimensiona a ese total. Ahora reporta una altura finita hacia arriba al `Column`, la aserción desaparece, y puedes colocar widgets tanto encima como debajo de ella.

El costo es real y vale la pena entenderlo. Un `ListView` normal es perezoso: solo construye y hace el layout de los elementos actualmente visibles en el viewport más una pequeña caché. Eso es lo que mantiene una lista de 10.000 filas a 60fps. `shrinkWrap: true` descarta eso, porque para conocer su altura total el viewport debe construir y medir **todos** sus hijos por adelantado. Para un puñado de elementos eso no es nada. Para una lista larga o sin límites significa construir miles de widgets en el primer frame, lo cual dispara el tiempo de layout y causa el jank que puedes observar en el timeline (ver [cómo perfilar el jank en una app de Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Una lista con `shrinkWrap` tampoco se desplaza independientemente en el sentido habitual; crece para encajar, y si el `Column` entero se desborda estás de vuelta con una advertencia de [RenderFlex overflowed](/es/2026/05/fix-renderflex-overflowed-in-flutter/). La regla práctica: `shrinkWrap` es para listas cortas y acotadas (unas cuantas filas de ajustes, un menú fijo), no para feeds.

Si usas `shrinkWrap` y aun así quieres que el `Column` externo se desplace cuando todo junto es demasiado alto, envuelve el `Column` en un `SingleChildScrollView` y fija el `ListView` interno con `physics: const NeverScrollableScrollPhysics()` para que los dos desplazables no peleen:

```dart
// Flutter 3.x (tested 3.44)
SingleChildScrollView(
  child: Column(
    children: [
      const Text('Recent activity'),
      ListView(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
        ],
      ),
    ],
  ),
)
```

## Solución 3: SizedBox, cuando conoces la altura exacta

Si la lista ocupa una porción fija de la pantalla, envuélvela en un `SizedBox` con una altura concreta. Esta es la respuesta más directa al error: el `ListView` preguntó cuán alto debía ser, y se lo dijiste.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    SizedBox(
      height: 240,
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

El `SizedBox` impone `maxHeight: 240` sobre el `ListView`, que rellena esos 240 pixeles lógicos y desplaza su contenido perezosamente dentro de ellos, conservando la ventaja de rendimiento que `shrinkWrap` cede. Esto es correcto para carruseles horizontales (una fila de tarjetas de altura fija dentro de un `Column` vertical) y cualquier diseño donde la altura de la lista sea una constante deliberada. La desventaja es el número mágico: las alturas fijas no se adaptan a diferentes tamaños de pantalla ni a los ajustes de escala de texto, así que evítalo para una lista que se supone que debe rellenar el espacio que queda. Para eso, `Expanded` es la versión adaptable de la misma idea.

## Solución 4: cambia el Column por un CustomScrollView con slivers

Cuando el "column" es en realidad una página que se desplaza y que resulta contener una lista, la estructura más limpia no es un `Column` con un `ListView` anidado en absoluto. Es un único `CustomScrollView` cuyas secciones son slivers. Un viewport, unas físicas de desplazamiento, pereza completa, sin conflictos de anidamiento:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 3,
      itemBuilder: (context, index) => ListTile(
        title: Text('Item ${index + 1}'),
      ),
    ),
  ],
)
```

Un sliver es una región desplazable que negocia directamente con el viewport padre sobre cuánto pinta, así que no hay ningún apretón de manos de "altura sin límites" que pueda fallar. `SliverToBoxAdapter` envuelve widgets de caja ordinarios (tu encabezado) y `SliverList.builder` es la lista perezosa. Echa mano de esto cuando una pantalla tenga varias secciones desplazables apiladas, un encabezado que deba desplazarse fuera de vista, o una lista más una cuadrícula en un desplazamiento continuo. Es más verboso que un `Column`, pero es el layout que Flutter realmente quiere para esta forma, y nunca te obliga a elegir entre corrección y pereza.

## Cuál solución uso en realidad

- **La lista es el contenido principal bajo un encabezado, debe rellenar la pantalla:** `Expanded`. Conserva la pereza, se adapta a cualquier altura.
- **Unos pocos elementos fijos, quieres widgets encima y debajo en el mismo `Column`:** `shrinkWrap: true`. Barato porque la lista es corta.
- **La lista necesita una altura fija específica (carrusel, mini-lista):** `SizedBox(height: ...)`. Conserva la pereza, explícito y simple.
- **La pantalla entera es un desplazamiento con varias secciones:** `CustomScrollView` con slivers. La respuesta estructuralmente correcta.

La trampa a evitar es echar mano de `shrinkWrap: true` de forma refleja porque es el diff más corto. Hace desaparecer el error rojo, pero en una lista larga cambia silenciosamente una aserción de layout ruidosa por una regresión de rendimiento silenciosa: cada fila construida en el primer frame, frames perdidos al cargar, y memoria que escala con la cantidad de elementos en lugar del tamaño del viewport. Si la lista puede crecer, usa `Expanded` o slivers para que el framework pueda seguir reciclando filas. Notas relacionadas de depuración viven en [Fix: RenderBox was not laid out](/es/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) y [Fix: A RenderFlex overflowed](/es/2026/05/fix-renderflex-overflowed-in-flutter/), que son los dos errores que es más probable que encuentres a continuación mientras montas esto. Y si la lista usa un `ScrollController`, recuerda [liberarlo](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) para no filtrarlo cuando el widget se desmonta.

## El modelo mental de una línea que conviene retener

Un `Column` da altura sin límites; un `ListView` exige altura acotada. Cada solución de arriba es solo una manera diferente de responder "¿cuán alto?" -- `Expanded` dice "lo que sobra", `SizedBox` dice "exactamente esto", `shrinkWrap` dice "tan alto como mis hijos", y los slivers dicen "deja que el viewport externo decida". Una vez que lees el error como "olvidaste decirle al desplazable su altura", la solución es obvia cada vez.

## Fuentes

- [Documentación de Flutter: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- el modelo "las restricciones bajan, los tamaños suben" y la caja que decide acotado vs sin límites.
- [Clase ListView, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, el comportamiento del viewport, y la nota de rendimiento sobre construir todos los hijos.
- [Clase Expanded, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- el fit flex y cómo se divide el espacio restante en un `Column` o `Row`.
- [Clase CustomScrollView, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- combinar slivers en un solo viewport.

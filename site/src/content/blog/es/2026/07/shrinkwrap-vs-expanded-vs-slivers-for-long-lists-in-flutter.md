---
title: "shrinkWrap vs Expanded vs slivers para listas largas en Flutter: ¿cuál elegir?"
description: "Para una lista larga, nunca uses shrinkWrap. Usa Expanded cuando la lista es el único scrollable, y slivers (CustomScrollView) cuando comparte scroll con otras secciones. Aquí está el porqué, con un benchmark de conteo de builds."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "slivers"
lang: "es"
translationOf: "2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

Para una lista larga en Flutter, la clasificación no está reñida: usa `Expanded` cuando la lista es el único scrollable bajo un encabezado, y cambia a slivers (un `CustomScrollView`) en cuanto la lista comparta scroll con otras secciones. Nunca recurras a `shrinkWrap: true` en una lista larga. Es el diff más corto y silencia el error de layout, pero también obliga a la lista a construir cada elemento en el primer frame, desechando el reciclaje perezoso que mantiene un scroll a 60fps. Este artículo enfrenta las tres opciones en Flutter 3.x (probado en 3.44, Dart 3.x), con una matriz de características, un benchmark de conteo de builds que muestra el costo exacto, y el único detalle que decide por ti.

Las tres no son perillas intercambiables del mismo widget. `Expanded` y `shrinkWrap` son dos formas de responder "¿qué altura tiene este `ListView` dentro de un `Column`?", mientras que los slivers reemplazan por completo la forma `Column` más `ListView`. Chocan porque son las tres respuestas que la gente prueba cuando un `ListView` dentro de un `Column` lanza `Vertical viewport was given unbounded height`. Si esa aserción es lo que te trajo aquí, el análisis completo de la causa raíz está en [cómo anidar un ListView dentro de un Column sin un error de altura no acotada](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/); este artículo es la pregunta más afilada de qué solución conservar una vez que la pantalla roja desaparece.

## La matriz de características

| Propiedad                                | `shrinkWrap: true` | `Expanded`         | Slivers (`CustomScrollView`) |
| ---------------------------------------- | ------------------ | ------------------ | ---------------------------- |
| Construye solo elementos visibles (lazy) | No, construye todo | Sí                 | Sí                           |
| Costo del primer frame para N elementos  | O(N)               | O(viewport)        | O(viewport)                  |
| La memoria escala con                    | conteo de elementos| tamaño del viewport| tamaño del viewport          |
| Funciona para una lista no acotada / que crece | No           | Sí                 | Sí                           |
| Requiere altura de padre acotada         | No                 | Sí (el padre debe) | Sí (Scaffold la da)          |
| Varias secciones scrollables en una      | Pelea consigo mismo| Solo una lista     | Sí, nativo                   |
| Encabezado colapsable (`SliverAppBar`)   | No                 | No                 | Sí                           |
| Líneas de boilerplate                    | 1                  | 3                  | ~6 por sección               |

Lee primero las tres filas superiores. Son todo el argumento. `shrinkWrap` es la única de las tres cuyo costo crece con el número de elementos, y "lista larga" es exactamente el caso donde ese costo muerde.

## Por qué shrinkWrap es O(N) y las otras dos no

Un `ListView` normal es un viewport perezoso: construye y hace layout solo de los elementos visibles en su ventana más una pequeña extensión de caché, y luego recicla esos widgets al desplazarte. Construye una lista de 10.000 filas y solo existen ~15 filas en cualquier momento. Esa pereza es toda la historia del rendimiento de las listas en Flutter.

`shrinkWrap: true` lo apaga. Para dimensionarse según su contenido (en lugar de llenar su eje), el viewport debe conocer su altura total, y la única forma de saberlo es construir y medir cada hijo por adelantado. Así que `shrinkWrap` convierte una lista perezosa en una ansiosa: N elementos significan N llamadas a build en el primer frame, N layouts de `RenderBox`, y memoria proporcional a N. Para las tres filas de ajustes en las que la gente suele probarlo, eso no es nada. Para un feed, es un bloqueo en el primer frame que puedes ver en la línea de tiempo (consulta [cómo perfilar el jank en una app de Flutter con DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)).

`Expanded` mantiene la lista perezosa. Es un hijo de `Flex` que fuerza una altura ajustada igual al espacio que sobra después de que el `Column` mide sus otros hijos. El `ListView` recibe un `maxHeight` acotado, llena exactamente esa ventana y recicla filas dentro de ella. El costo es O(viewport), independiente del número de elementos.

Los slivers también mantienen la lista perezosa, mediante un mecanismo distinto: un `SliverList` nunca necesita conocer su altura total. Negocia directamente con el viewport padre ("estás desplazado al offset X, pintaré los hijos en ese rango"), así que no hay handshake de altura no acotada y ninguna razón para construir hijos fuera de pantalla. El costo es de nuevo O(viewport).

## El benchmark de conteo de builds

La forma más limpia de medir esto no son los milisegundos (que varían según la máquina) sino el número de builds de elementos en el primer frame, que es determinista y basado en el mecanismo. Instrumenta cada elemento con un contador:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
int buildCount = 0;

Widget itemBuilder(BuildContext context, int index) {
  buildCount++;                 // increment on every item build
  return ListTile(title: Text('Row $index'));
}
```

Renderiza una lista de 5.000 elementos de tres formas y lee `buildCount` después del primer frame (`WidgetsBinding.instance.addPostFrameCallback`). Los resultados no están reñidos:

| Layout para 5.000 elementos        | Builds de elementos en el primer frame | Escala con        |
| ---------------------------------- | -------------------------------------- | ----------------- |
| `ListView(shrinkWrap: true)`       | 5.000                                  | conteo de elementos |
| `Expanded(child: ListView)`        | ~12 a 15                               | solo viewport     |
| `SliverList` en `CustomScrollView` | ~12 a 15                               | solo viewport     |

El número exacto en modo perezoso depende de la altura de fila y del `cacheExtent` por defecto (250 píxeles lógicos más allá del viewport a cada lado), pero la forma es fija: `shrinkWrap` construye los 5.000, las otras dos construyen solo lo que cabe más la caché. En un Pixel 7 en modo profile el primer frame de `shrinkWrap` superó ampliamente el presupuesto de 16ms construyendo esos 5.000 tiles, mientras que las versiones con `Expanded` y con slivers renderizaron el primer frame dentro del presupuesto y se mantuvieron ahí al desplazarse. El número que importa es la proporción: ~5.000 builds frente a ~15, una diferencia que crece cada vez que la lista lo hace.

Para reproducir esto tú mismo, ejecuta en modo profile (`flutter run --profile`), no en debug, porque las mediciones en modo debug están dominadas por aserciones y no son representativas. La proporción de conteo de builds es idéntica en todos los modos; solo difiere el tiempo de reloj.

## Cuándo elegir Expanded

`Expanded` es la respuesta correcta cuando la lista es la única región scrollable de la pantalla, situada debajo (o encima) de algún chrome fijo.

- **Un encabezado sobre un feed, probado en Flutter 3.44.** Un título o una barra de búsqueda en un `Column`, luego la lista llena el resto. `Expanded` le da a la lista toda la altura sobrante y la mantiene perezosa.
- **Una lista que crece y se encoge con la pantalla.** Como `Expanded` divide el espacio disponible en lugar de fijarlo por código, la lista se adapta a distintas alturas de dispositivo y ajustes de escala de texto, a diferencia de un `SizedBox(height: ...)`.
- **Quieres el menor código que siga siendo correcto.** Tres líneas, sin vocabulario de widgets nuevo, pereza completa. Para una sola lista esto le gana a recurrir a slivers.

El único requisito: el `Column` mismo debe tener una altura acotada para que `Expanded` tenga algo que dividir. Dentro del body de un `Scaffold` la tiene. Si el `Column` está a su vez en un contexto no acotado, solo has movido el problema un nivel más arriba.

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const SearchBar(),
    Expanded(
      child: ListView.builder(       // stays lazy
        itemCount: items.length,
        itemBuilder: (context, i) => ItemTile(items[i]),
      ),
    ),
  ],
)
```

## Cuándo elegir slivers

Recurre a un `CustomScrollView` con slivers cuando la lista larga no está sola: comparte un scroll con otras secciones, o la pantalla necesita un encabezado que se desplace fuera de vista.

- **Dos o más secciones scrollables en un scroll**, por ejemplo una lista que fluye hacia una cuadrícula. Este caso está cubierto de principio a fin en [cómo mezclar un ListView y un GridView en un solo scroll con slivers](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/). Apilar dos `ListView` en un `Column` y deshabilitar su physics es el antipatrón que los slivers existen para reemplazar.
- **Un encabezado colapsable o flotante.** `SliverAppBar` con `pinned`, `floating` o `expandedHeight` es casi gratis una vez que ya tienes un `CustomScrollView`. No hay equivalente basado en `Column`.
- **Un encabezado que debe desplazarse fuera con el contenido.** `SliverToBoxAdapter` envuelve un widget de caja aislado entre secciones perezosas para que se desplace fuera de forma natural.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(title: Text('Explore'), floating: true),
    SliverList.builder(              // lazy, shares the one scroll position
      itemCount: items.length,
      itemBuilder: (context, i) => ItemTile(items[i]),
    ),
  ],
)
```

Los slivers son más verbosos, unas seis líneas por sección en lugar de tres, y esa verbosidad es la única razón para no usarlos en una lista solitaria. Cuando hay exactamente un scrollable, `Expanded` da la misma pereza con menos ceremonia.

## Cuándo shrinkWrap está realmente bien

`shrinkWrap: true` no es un bug, es una herramienta con un uso correcto estrecho: una lista **corta y acotada** cuyo número de elementos controlas y que debe dimensionarse según su contenido para que otros widgets puedan situarse encima y debajo de ella en el mismo `Column`.

- Una pantalla de ajustes con un puñado fijo de filas.
- Un desplegable o menú con un conjunto pequeño y conocido de opciones.
- Cualquier lista donde N es pequeño (cifras de una sola cifra, decenas bajas) y fijo por diseño, no por datos.

En cuanto N esté impulsado por datos que pueden crecer (publicaciones, fotos, resultados de búsqueda, mensajes), `shrinkWrap` es la herramienta equivocada, porque su costo crece con esos datos. Si lo usas para una lista corta dentro de un `Column` scrollable, establece también `physics: const NeverScrollableScrollPhysics()` para que la lista interna no pelee con el `SingleChildScrollView` externo por el gesto de scroll.

```dart
// Flutter 3.x (tested 3.44) -- fine ONLY because this list is short and fixed
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        SwitchListTile(title: Text('Notifications'), value: true, onChanged: null),
        SwitchListTile(title: Text('Dark mode'), value: false, onChanged: null),
      ],
    ),
  ],
)
```

## El detalle que decide por ti

Dos restricciones anulan por completo la preferencia.

**Si la lista puede crecer sin límite, `shrinkWrap` queda descartada.** No es cuestión de gusto ni de unos frames perdidos que podrías tolerar. Un build ansioso no acotado es un problema de correctitud y de memoria: el tiempo de build y la memoria escalan ambos con el número de elementos, así que una lista que está bien en pruebas con 20 filas puede bloquear el primer frame durante cientos de milisegundos en producción con 2.000. El framework no te advertirá, porque `shrinkWrap` hizo exactamente lo que pediste. Esta es la forma más común en que una lista de Flutter regresiona silenciosamente.

**Si tienes más de una sección scrollable, los slivers son la única respuesta limpia.** `Expanded` maneja exactamente una lista. Dos listas con `Expanded` en un `Column` dividen la altura entre ellas en dos scroll views separados, lo cual casi nunca es lo que quieres. En el instante en que tienes una lista más una cuadrícula, o una lista más otra lista, o cualquier sección que deba desplazarse como una sola superficie con la lista, un `CustomScrollView` es la forma estructuralmente correcta y todo lo demás es un apaño.

Todo lo demás, adaptabilidad de pantalla, boilerplate, un encabezado colapsable, es un desempate dentro de esas dos reglas duras.

## La recomendación, reafirmada

Para una lista larga, clasifícalas: **slivers si la lista comparte scroll con cualquier otra cosa, `Expanded` si es el único scrollable, y `shrinkWrap` nunca.** Conserva `shrinkWrap: true` en tu caja de herramientas solo para listas cortas y fijas que deban dimensionarse según su contenido dentro de un `Column`. La trampa es que las tres hacen desaparecer el error de altura no acotada, así que es fácil enviar la que además cambia silenciosamente una ruidosa aserción de layout por una regresión de rendimiento que solo aparece bajo datos reales. Lee la elección como "¿cómo mantengo la lista perezosa?", y la respuesta es siempre `Expanded` o slivers, nunca `shrinkWrap`.

Si una fila dentro de cualquiera de estos alguna vez desborda su propio ancho, ese es un problema aparte de [RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/) a nivel del tile, no relacionado con la elección de layout externa. Y sea cual sea el layout que elijas, si usa un `ScrollController`, recuerda [liberarlo](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) para no filtrarlo cuando el widget se desmonte.

## Fuentes

- [ListView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`, comportamiento del viewport, y la nota explícita de que una lista con shrink-wrap construye todos sus hijos.
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- fit de flex y cómo un `Column` divide el espacio restante.
- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- alojar varios slivers en un solo viewport perezoso.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- el protocolo de slivers y cómo un viewport negocia la extensión de pintado.
- [Flutter docs: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- el modelo de altura acotada vs no acotada detrás de toda la comparación.

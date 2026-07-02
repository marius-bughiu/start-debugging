---
title: "Cómo combinar un ListView y un GridView en una sola vista de scroll con slivers en Flutter"
description: "Coloca una lista y una cuadrícula en un solo scroll continuo sin scrollables anidados. Usa CustomScrollView con SliverList y SliverGrid, y evita la trampa de shrinkWrap que arruina el rendimiento en silencio."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "slivers"
  - "listview"
lang: "es"
translationOf: "2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-02
---

Quieres una pantalla donde una lista fluya directamente hacia una cuadrícula (o al revés) y todo se desplace como una sola cosa. El instinto equivocado es apilar un `ListView` y un `GridView` en un `Column` y recurrir a `shrinkWrap: true` para que quepan. Eso compila, pero construye cada elemento por adelantado y te deja con dos posiciones de scroll peleando entre sí. La respuesta correcta es un único `CustomScrollView` cuyas secciones son slivers: `SliverList` para la parte de la lista, `SliverGrid` para la parte de la cuadrícula, `SliverToBoxAdapter` para cualquier widget simple que quede en el medio. Un solo viewport, una sola física de scroll, laziness completa. Este post muestra el layout funcionando en Flutter 3.x (probado en 3.44, Dart 3.x), explica por qué la versión ingenua es lenta, y cubre los detalles de espaciado, padding y conteo de columnas que hacen tropezar a la gente.

## Por qué no puedes simplemente apilar dos scrollables

Un `ListView` y un `GridView` son ambos viewports desplazables. Cada uno posee su propia posición de scroll y espera que le entregues una altura acotada para saber qué tan alta es su ventana. Pon dos de ellos en un `Column` y chocas contra el mismo muro descrito en [cómo anidar un ListView dentro de un Column sin un error de altura no acotada](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/): el `Column` le ofrece a cada hijo espacio vertical no acotado, y un scrollable se niega a distribuirse hacia el infinito.

El parche habitual es `shrinkWrap: true` en ambos, envueltos en un `SingleChildScrollView`:

```dart
// Flutter 3.x (tested 3.44) -- the anti-pattern, do not ship this
SingleChildScrollView(
  child: Column(
    children: [
      ListView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: posts.length,
        itemBuilder: (context, i) => PostTile(posts[i]),
      ),
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
        ),
        itemCount: photos.length,
        itemBuilder: (context, i) => PhotoTile(photos[i]),
      ),
    ],
  ),
)
```

Esto se renderiza, y para una docena de elementos está bien. Pero `shrinkWrap: true` obliga a cada scrollable a construir y medir cada uno de sus hijos en el primer frame para poder reportar una altura finita. Has tirado a la basura el reciclaje perezoso que mantiene fluidas las listas de Flutter. En un feed de unos cientos de fotos eso significa cientos de widgets construidos antes de la primera pintura, un pico que puedes observar en la línea de tiempo (mira [cómo perfilar el jank en una app de Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Peor aún, ahora tienes tres vistas de scroll (el `SingleChildScrollView` exterior más las dos interiores que tuviste que deshabilitar con `NeverScrollableScrollPhysics`) todas presentes solo para que una de ellas pueda desplazarse de verdad. Es la forma equivocada para el problema.

## Qué es un sliver, en un párrafo

Un sliver es una región desplazable que habla directamente con un viewport padre sobre cuánto de sí misma está visible actualmente y cuánto pintar. En lugar de "aquí está mi altura total, dame una ventana", un sliver dice "estás desplazado al offset X con un viewport de altura H, así que distribuiré exactamente los hijos que caen en ese rango". Ese protocolo es lo que hace perezoso a un `SliverList`: nunca necesita conocer su propia altura total, así que no hay ningún acuerdo de altura no acotada que pueda fallar ni necesidad de construir hijos fuera de pantalla. Un `CustomScrollView` es un viewport que hospeda una lista de estos slivers y se desplaza a través de todos ellos como una única superficie continua. Como cada sección es un sliver, comparten la única posición de scroll de su padre, que es exactamente el comportamiento que querías.

## El layout que funciona: SliverList y luego SliverGrid

Aquí está todo. Un encabezado, una sección de lista y una sección de cuadrícula, en un solo scroll:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class FeedPage extends StatelessWidget {
  const FeedPage({super.key, required this.posts, required this.photos});

  final List<Post> posts;
  final List<Photo> photos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Latest posts',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverList.builder(
            itemCount: posts.length,
            itemBuilder: (context, index) => PostTile(posts[index]),
          ),
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Photos',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 1,
            ),
            itemCount: photos.length,
            itemBuilder: (context, index) => PhotoTile(photos[index]),
          ),
        ],
      ),
    );
  }
}
```

Desplázalo y la lista fluye hacia la cuadrícula como una única superficie. Ambas secciones son perezosas: solo se construyen los tiles dentro del viewport (más un pequeño caché), sin importar cuántos posts o fotos tengas. Hay una sola posición de scroll, así que un fling iniciado en la lista continúa hacia la cuadrícula sin costura.

Tres tipos de sliver están haciendo el trabajo aquí, y son los tres que usarás para casi todo:

1. **`SliverToBoxAdapter`** envuelve cualquier widget de caja ordinario (un encabezado, un banner, un divisor) para que pueda ubicarse en una lista de slivers. Construye su hijo de forma anticipada, lo cual es correcto para un solo widget pequeño pero incorrecto para una lista larga, así que nunca pongas un `ListView` o un `Column` grande dentro de uno. Úsalo para widgets aislados entre tus secciones perezosas.
2. **`SliverList.builder`** es la lista perezosa. La misma API de `itemCount` / `itemBuilder` que conoces de `ListView.builder`, menos el viewport, porque el `CustomScrollView` que lo contiene es el viewport ahora.
3. **`SliverGrid.builder`** es la cuadrícula perezosa. Toma un `gridDelegate` que controla las columnas, exactamente como `GridView.builder`.

## Controlar las columnas de la cuadrícula

El `gridDelegate` es donde decides cuántas columnas tiene la cuadrícula y cómo se espacian los tiles. Dos delegates cubren casi todos los casos.

`SliverGridDelegateWithFixedCrossAxisCount` fija un número fijo de columnas. Úsalo cuando el conteo es una decisión de diseño ("siempre 3 a lo ancho"):

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
  crossAxisCount: 3,   // exactly 3 columns
  mainAxisSpacing: 8,  // vertical gap between rows
  crossAxisSpacing: 8, // horizontal gap between columns
  childAspectRatio: 1, // width / height of each tile; 1 = square
),
```

`SliverGridDelegateWithMaxCrossAxisExtent` en cambio limita el ancho de cada tile y deja que Flutter calcule el conteo de columnas a partir del ancho disponible. Esta es la opción responsive: un teléfono obtiene 2 columnas, una tablet obtiene 5, sin un `LayoutBuilder`:

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
  maxCrossAxisExtent: 180, // each tile is at most 180px wide
  mainAxisSpacing: 8,
  crossAxisSpacing: 8,
  childAspectRatio: 1,
),
```

La frustración más común con las cuadrículas son tiles que se ven estirados o aplastados, y la causa casi siempre es `childAspectRatio`. Es el ancho dividido por la altura. El valor por defecto es `1.0` (cuadrado). Si tus tiles de fotos son más altos que anchos, baja el ratio por debajo de 1 (por ejemplo `0.75` para una tarjeta vertical 3:4); si son más anchos, súbelo por encima de 1. Un desajuste de `childAspectRatio` no lanza ninguna excepción, simplemente distorsiona en silencio cada tile, así que vale la pena configurarlo de forma deliberada en lugar de dejarlo en el valor por defecto.

## Agregar padding sin romper la laziness

Envolver un sliver en un widget `Padding` ordinario no funciona, porque `Padding` espera un hijo de caja, no un sliver. El equivalente sliver es `SliverPadding`:

```dart
// Flutter 3.x (tested 3.44)
SliverPadding(
  padding: const EdgeInsets.symmetric(horizontal: 16),
  sliver: SliverGrid.builder(
    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
      crossAxisCount: 3,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
    ),
    itemCount: photos.length,
    itemBuilder: (context, index) => PhotoTile(photos[index]),
  ),
)
```

Nota el parámetro `sliver:`, no `child:`. `SliverPadding` inserta márgenes a un sliver y permanece perezoso. Recurre a él cuando una sección necesita espacio respecto a los bordes de la pantalla; envolver todo el cuerpo del `CustomScrollView` en un gran `Padding` recortaría los cálculos de espaciado de la cuadrícula y es la capa equivocada para agregar márgenes.

## Un encabezado que se desplaza y colapsa

Como ya tienes un `CustomScrollView`, agregar un `SliverAppBar` que se expande y colapsa a medida que te desplazas es casi gratis. Esta es la razón clásica por la que la gente se pasa a los slivers en primer lugar:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(
      title: Text('Explore'),
      floating: true,      // reappears as soon as you scroll up
      expandedHeight: 160,
      flexibleSpace: FlexibleSpaceBar(
        background: ColoredBox(color: Colors.indigo),
      ),
    ),
    SliverList.builder(
      itemCount: posts.length,
      itemBuilder: (context, i) => PostTile(posts[i]),
    ),
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
      ),
      itemCount: photos.length,
      itemBuilder: (context, i) => PhotoTile(photos[i]),
    ),
  ],
)
```

Configura `pinned: true` para mantener la barra pegada arriba, `floating: true` para que se deslice de vuelta con cualquier scroll hacia arriba, y `expandedHeight` con un `flexibleSpace` para obtener el colapso de grande a pequeño. Nada de esto es posible con un `Column` simple de scrollables, que es el beneficio concreto de cambiarse a slivers.

## Los problemas que de verdad muerden

**No anides un scrollable dentro de un sliver.** Todo el punto es tener un solo viewport. Poner un `ListView` dentro de un `SliverToBoxAdapter` reintroduce el error de altura no acotada y una segunda posición de scroll. Si tienes una fila con scroll horizontal dentro de un `CustomScrollView` vertical, eso está bien (eje distinto, dale una altura fija mediante un `SliverToBoxAdapter` que envuelva un `SizedBox`), pero nunca anides un scrollable del mismo eje.

**Las keys importan cuando los elementos se reordenan.** Si los elementos de la lista o la cuadrícula pueden insertarse, eliminarse o reordenarse, dale a cada tile una `ValueKey` ligada a sus datos para que Flutter empareje el estado correcto con el widget correcto entre reconstrucciones. Sin keys, una fila eliminada puede dejar su estado adjunto al tile equivocado.

**Cuidado con el caso de sección vacía.** Un `SliverList` o `SliverGrid` con `itemCount: 0` simplemente no pinta nada, que es lo que quieres, pero si además quieres un placeholder de "aún no hay fotos", usa `SliverToBoxAdapter` o `SliverFillRemaining` para mostrarlo, no una cuadrícula vacía.

**`SliverFillRemaining` llena el viewport sobrante.** Si la lista más la cuadrícula no llenan la pantalla y quieres un pie de página o un estado vacío fijado al fondo del área visible, `SliverFillRemaining(hasScrollBody: false, child: ...)` toma exactamente la altura restante. Es la versión sliver de `Expanded` para la última sección.

**Agrupar slivers.** Si construyes varios pares de lista y cuadrícula y quieres tratar cada par como una unidad (por ejemplo para aplicar un fondo), `SliverMainAxisGroup` (Flutter 3.16+) apila slivers hijos a lo largo del eje de scroll para que se comporten como un solo sliver. Rara vez lo necesitas para una simple lista más cuadrícula, pero es la herramienta cuando una sección tiene estructura interna.

## Cuándo un GridView o ListView simple sigue siendo lo correcto

Los slivers son la respuesta cuando combinas secciones en un solo scroll. Son excesivos cuando tienes una sola lista o una sola cuadrícula y nada más desplazándose con ella. Un `GridView.builder` solitario dentro del body de un `Scaffold` ya es perezoso y ya es el viewport; envolverlo en un `CustomScrollView` con un `SliverGrid` agrega ceremonia sin ningún beneficio. Recurre a los slivers en el momento en que tengas dos o más secciones desplazables, un encabezado que colapsa, o un encabezado que debe desplazarse junto con el contenido. Para todo lo demás, los widgets simples están bien, y si tu único problema es una sola lista que se niega a caber en un `Column`, las cuatro soluciones en [el post de altura no acotada](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) son el camino más corto.

Un hábito más que vale la pena mantener: si alguna sección usa un `ScrollController` (por ejemplo para saltar la vista combinada a una sección), adjúntalo al `CustomScrollView`, no a los slivers individuales (los slivers no aceptan un controller), y [libéralo](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) en tu `State.dispose` para no filtrarlo. Y si un tile dentro de la cuadrícula alguna vez desborda su celda, eso aparece como una advertencia de [RenderFlex overflowed](/es/2026/05/fix-renderflex-overflowed-in-flutter/) dentro del tile, sin relación con el cableado de los slivers, y se resuelve a nivel del tile.

## El modelo mental que conviene conservar

Un `CustomScrollView` es un solo viewport; cada sección que pongas en él es un sliver, y los slivers comparten esa única posición de scroll mientras cada uno se mantiene perezoso. `SliverList` y `SliverGrid` son la lista y la cuadrícula perezosas, `SliverToBoxAdapter` es la vía de escape para widgets de caja aislados, `SliverPadding` agrega márgenes, y `SliverAppBar` es el encabezado que colapsa que obtienes casi gratis. Una vez que dejas de pensar "apilar dos scrollables" y empiezas a pensar "un solo scroll hecho de slivers", combinar una lista y una cuadrícula deja de ser una pelea con el motor de layout y se convierte en cuatro líneas de composición.

## Fuentes

- [CustomScrollView class, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- hospedar múltiples slivers en un viewport, incluyendo el ejemplo de SliverAppBar + SliverList + SliverGrid.
- [SliverGrid class, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/SliverGrid-class.html) -- los constructores builder/count/extent y los dos grid delegates.
- [SliverList class, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- el comportamiento de lista perezosa y la nota sobre SliverFixedExtentList.
- [Using slivers to achieve fancy scrolling, documentación de Flutter](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- el protocolo de slivers y cómo los viewports negocian el extent de pintura.

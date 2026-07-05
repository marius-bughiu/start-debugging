---
title: "Solución: A RenderViewport expected a child of type RenderSliver but received a child of type RenderBox (Flutter CustomScrollView)"
description: "La lista slivers de un CustomScrollView solo acepta slivers. Envuelve los widgets de tipo caja en SliverToBoxAdapter, o cambia ListView/Padding/Column por SliverList y SliverPadding."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "slivers"
  - "layout"
lang: "es"
translationOf: "2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview"
translatedBy: "claude"
translationDate: 2026-07-05
---

`A RenderViewport expected a child of type RenderSliver but received a child of type RenderParagraph` (o `RenderFlex`, o `RenderErrorBox`, o cualquier otro `RenderBox`) significa que colocaste un widget normal directamente dentro de la lista `slivers` de un `CustomScrollView`. Todo lo que hay en `slivers` debe ser un sliver. La solución más rápida es envolver el widget de caja que causa el problema en un `SliverToBoxAdapter`; la mejor solución, para una lista, es reemplazar `ListView` por `SliverList.builder` y `Padding` por `SliverPadding`. Probado en Flutter 3.x (3.44), Dart 3.x.

## El error en contexto

Flutter lanza este error durante el layout, antes de pintar nada. El tipo concreto que aparece después de "received a child of type" cambia según lo que hayas puesto en la lista -- `RenderParagraph` para un `Text`, `RenderFlex` para un `Column` o `Row`, `RenderErrorBox` cuando un builder dentro de la lista lanzó una excepción -- pero la forma es siempre la misma:

```
FlutterError (A RenderViewport expected a child of type RenderSliver but received a
child of type RenderParagraph.
RenderObjects expect specific types of children because they coordinate with their
children during layout and paint. For example, a RenderSliver cannot be the child of
a RenderBox because a RenderSliver does not understand the RenderBox layout protocol.

The RenderViewport that expected a RenderSliver child was created by:
  Viewport ← IgnorePointer ← Semantics ← Listener ← _GestureSemantics ←
    Scrollable ← PrimaryScrollController ← CustomScrollView ← ...

The RenderParagraph that did not match the expected child type was created by:
  Text ← ...)
```

Los dos bloques "created by" son la parte útil. El primero nombra el widget de scroll que esperaba un sliver (casi siempre tu `CustomScrollView`). El segundo nombra el widget exacto que no era un sliver. Lee primero el segundo bloque: apunta directamente a la línea que necesitas cambiar.

## Por qué un viewport rechaza un hijo de tipo caja

Flutter tiene dos protocolos de layout, no uno. Los widgets ordinarios como `Container`, `Text`, `Row` y `Column` se disponen como cajas: el padre pasa hacia abajo las restricciones de ancho y alto, el hijo devuelve un `Size` concreto, y listo. Sus render objects son subclases de `RenderBox` (`RenderParagraph`, `RenderFlex`, etc.).

Los slivers usan un protocolo distinto y más rico, pensado para el scroll. Un sliver no se limita a reportar un tamaño. Durante el layout recibe un `SliverConstraints` que describe cuánto de él está actualmente desplazado fuera de la pantalla, cuánto espacio queda en el viewport, el offset de scroll, la dirección del eje y más. Devuelve un `SliverGeometry` que describe cuánto espacio pintó, cuánto consumió en el eje de scroll, su extensión para hit-test y si quiere ser visible. Ese ida y vuelta es lo que permite que un `SliverAppBar` se encoja mientras haces scroll y que un `SliverList` construya solo las filas que están en pantalla en ese momento. Sus render objects son subclases de `RenderSliver`.

Un `RenderViewport` -- el render object detrás de `CustomScrollView` -- solo habla el protocolo de slivers con sus hijos. Le entrega a cada hijo un `SliverConstraints` y espera un `SliverGeometry` de vuelta. Si le das un `RenderBox`, esa caja no tiene idea de qué hacer con un `SliverConstraints`; no implementa el método que el viewport está a punto de llamar. En lugar de fallar en lo profundo del layout con un null confuso, el framework verifica el tipo del hijo por adelantado y lanza esta aserción. El mensaje deja clara la regla: "a RenderSliver cannot be the child of a RenderBox because a RenderSliver does not understand the RenderBox layout protocol", y lo mismo aplica al revés, que es exactamente el desajuste que estás encontrando.

Así que esto no es un error sutil de restricciones como [RenderBox was not laid out](/es/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) ni un [desbordamiento de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/). Es un desajuste de tipos: un widget de caja parado donde va un sliver.

## La reproducción mínima

Cualquier widget que no sea un sliver dentro de la lista `slivers` lo dispara. Aquí está la versión más pequeña -- un `Text` pelado donde debería ir un sliver:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Feed extends StatelessWidget {
  const Feed({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        const Text('Recent activity'), // RenderParagraph, not a sliver
        SliverList.builder(
          itemCount: 20,
          itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
        ),
      ],
    );
  }
}
```

El `SliverList.builder` está bien. El `Text` es el problema: se convierte en un `RenderParagraph`, el viewport esperaba un `RenderSliver`, y el layout lanza el error. Lo mismo ocurre si sueltas un `Column`, un `Padding`, un `Center`, un `ListView` o un widget de página personalizado completo dentro de `slivers`. Si no es un sliver, el viewport lo rechaza.

## Solución 1: envuelve un solo widget de caja en SliverToBoxAdapter

Para un widget de caja aislado -- un encabezado, un banner, una tarjeta, una fila de botones -- envuélvelo en `SliverToBoxAdapter`. Ese widget es un sliver cuyo único trabajo es hospedar un hijo `RenderBox` y traducir entre los dos protocolos: mide la caja y luego reporta el `SliverGeometry` apropiado al viewport.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 20,
      itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
    ),
  ],
)
```

Esta es la solución directa y la correcta cuando el contenido de la caja es de verdad un bloque único de tamaño fijo. Es el sliver al que recurres primero cuando un encabezado, un espaciador o una tarjeta de resumen necesita ubicarse encima de tus listas en una sola vista de scroll.

Lo único que hay que saber: `SliverToBoxAdapter` construye su hijo de forma anticipada y lo mantiene vivo esté o no en pantalla, porque una caja no tiene noción de pereza. Eso está bien para un encabezado. Está mal para una lista larga, que es la Solución 2.

## Solución 2: usa SliverList / SliverGrid para listas, no un ListView envuelto

El error más común es soltar un `ListView` dentro de `slivers` y luego, cuando aparece este error, envolver el `ListView` en `SliverToBoxAdapter`. Eso silencia la aserción, pero es la forma equivocada. Ahora tienes un scrollable dentro de un scrollable, y el `ListView` interno recibe altura no acotada del adaptador -- la misma familia de fallos que [anidar un ListView en un Column](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). Incluso si lo fuerzas a funcionar con `shrinkWrap`, tiras a la basura la construcción perezosa: cada fila se construye por adelantado.

El punto entero de un `CustomScrollView` es que sus secciones son slivers que comparten un solo viewport. Así que usa la lista sliver, no un `ListView` encajonado:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: Text('Recent activity')),

    // Lazy: only builds rows near the viewport. Direct replacement for ListView.builder.
    SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    ),

    // Grid section in the same scroll view.
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2),
      itemCount: photos.length,
      itemBuilder: (context, i) => Image.network(photos[i]),
    ),
  ],
)
```

`SliverList.builder`, `SliverList.separated`, `SliverFixedExtentList` y `SliverGrid.builder` son los equivalentes sliver de los builders de `ListView`/`GridView`. Conservan la construcción perezosa que hace que las listas largas sean baratas, y encajan directamente en `slivers`. Si quieres una lista y una grilla fluyendo en un solo scroll continuo, este es el layout para ello -- consulta [cómo mezclar un ListView y un GridView con slivers](/es/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) para ver el patrón completo.

## Solución 3: SliverPadding en lugar de Padding, SliverFillRemaining en lugar de una caja

La regla de caja-contra-sliver también atrapa a los widgets envolventes. Si envuelves un sliver en `Padding` para darle un margen interior, `Padding` es un `RenderBox` y el viewport lo rechaza. La versión consciente de slivers es `SliverPadding`, que aplica el padding a un hijo sliver y se mantiene como sliver:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    SliverPadding(
      padding: const EdgeInsets.all(16),
      sliver: SliverList.builder(       // note: 'sliver:', not 'child:'
        itemCount: items.length,
        itemBuilder: (context, i) => Text(items[i]),
      ),
    ),
  ],
)
```

Fíjate en el nombre del parámetro: `SliverPadding` toma `sliver:`, no `child:`, porque su hijo debe ser él mismo un sliver. La misma idea cubre algunas otras necesidades comunes:

- **Una caja que debe llenar el viewport sobrante** (un mensaje de estado vacío centrado en el espacio que quede): `SliverFillRemaining(child: ...)`.
- **Una caja que debe medir exactamente una pantalla de alto**: `SliverFillViewport`.
- **Un encabezado fijado o flotante que se encoge al hacer scroll**: `SliverAppBar`, que ya es un sliver, así que va directamente en `slivers`.
- **Agrupar varios slivers para aplicar un solo recorte o decoración**: `SliverMainAxisGroup` / `SliverCrossAxisGroup`.

El modelo mental: para cada widget de caja que normalmente usarías, o bien lo envuelves (`SliverToBoxAdapter`, `SliverFillRemaining`) o bien encuentras su gemelo sliver (`SliverList`, `SliverGrid`, `SliverPadding`, `SliverAppBar`).

## Trampas y casos que se parecen

**Un builder dentro de slivers que lanza una excepción muestra este mismo error.** Cuando el tipo recibido es `RenderErrorBox`, el hijo era un `ErrorWidget`: algo dentro de un `StreamBuilder` o `FutureBuilder` ubicado en tus `slivers` lanzó una excepción durante el build, Flutter sustituyó su caja de error roja (un `RenderBox`), y el viewport rechazó eso. La solución tiene dos partes: haz que el builder devuelva un sliver en todos los caminos, y maneja el caso de error. Un `StreamBuilder` dentro de `slivers` debe devolver un sliver desde su `builder`, incluyendo las ramas de error y de carga:

```dart
// Flutter 3.x (tested 3.44)
StreamBuilder<List<String>>(
  stream: feed,
  builder: (context, snapshot) {
    if (snapshot.hasError) {
      return const SliverToBoxAdapter(child: Text('Could not load feed'));
    }
    if (!snapshot.hasData) {
      return const SliverToBoxAdapter(child: Center(child: CircularProgressIndicator()));
    }
    final items = snapshot.data!;
    return SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    );
  },
)
```

Si devuelves un `Text` o un `CircularProgressIndicator` pelado desde cualquier rama, vuelves al error original. (Ya que estás aquí, si un `FutureBuilder` vuelve a ejecutar su future en cada rebuild, ese es un bug aparte que vale la pena arreglar -- consulta [cómo evitar que FutureBuilder recree su Future](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)

**El desajuste inverso se lee casi igual.** Si pones un sliver donde va una caja -- digamos un `SliverList` dentro de un `Column` -- obtienes "A RenderObjectWithChildMixin expected a child of type RenderBox but received a child of type RenderSliverList" o "expected a RenderBox but received a RenderSliverPadding". La misma regla, en dirección opuesta: los slivers solo viven dentro de un viewport (`CustomScrollView`, o el área de slivers de `NestedScrollView`), nunca directamente dentro de un `Column`, `Center` o `Padding`. Para convertir un sliver de vuelta en algo que un padre de caja acepte, por lo general no lo haces: reestructuras de modo que el sliver quede dentro de un `CustomScrollView`.

**`SliverToBoxAdapter` no es un lugar para esconder una lista larga.** Funciona, así que es tentador, pero anula la pereza: el adaptador construye todo su subárbol de hijos de inmediato. Envolver un `ListView` de 5 000 filas (o un `Column` de 5 000 hijos) en uno significa construir los 5 000 en el primer frame, lo que dispara el tiempo de layout y aparece como jank en el timeline. Úsalo para encabezados y tarjetas individuales; usa `SliverList.builder` para cualquier cosa que haga scroll.

**El hot reload a veces no puede recuperarse de esto.** Como la aserción se dispara durante el layout, un hot reload después de arreglar el código puede ocasionalmente dejar el árbol de render atascado. Si el error persiste después de que claramente arreglaste la línea que lo causaba, haz un hot restart (`R`), no un hot reload (`r`).

## Relacionado

- [Cómo mezclar un ListView y un GridView en una sola vista de scroll con slivers](/es/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- el layout correcto de `CustomScrollView` con varias secciones hacia el que este error te empuja.
- [Cómo anidar un ListView dentro de un Column sin un error de altura no acotada](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- el fallo que encuentras si "arreglas" esto encajonando un ListView.
- [Solución: RenderBox was not laid out en Flutter](/es/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- la otra aserción de tiempo de layout que encuentras al armar vistas de scroll.
- [Solución: A RenderFlex overflowed en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) -- problemas de restricciones en `Row`/`Column`, el primo del lado de las cajas de este problema.

## Fuentes

- [Clase RenderViewport, referencia de la API de Flutter](https://api.flutter.dev/flutter/rendering/RenderViewport-class.html) -- el render object que habla el protocolo de slivers y rechaza hijos de caja.
- [Clase SliverToBoxAdapter, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/SliverToBoxAdapter-class.html) -- envolver un solo widget de caja como sliver.
- [Clase SliverList, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- el sliver de lista perezosa y sus constructores `.builder` / `.separated`.
- [flutter/flutter issue 126064](https://github.com/flutter/flutter/issues/126064) -- la variante `RenderErrorBox`, donde un builder que lanza una excepción dentro de `slivers` produce esta misma aserción.
</content>
</invoke>

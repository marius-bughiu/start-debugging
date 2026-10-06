---
title: "Solución: BoxConstraints forces an infinite height en Flutter"
description: "Un widget pidió height: double.infinity dentro de un padre sin límite de altura, como un Column o un ListView. Usa Expanded, una altura finita, LimitedBox o SliverFillRemaining."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "es"
translationOf: "2026/10/fix-boxconstraints-forces-an-infinite-height-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-06
---

`BoxConstraints forces an infinite height` significa que algún widget pidió medir exactamente `double.infinity` píxeles de alto, y su padre no tenía un límite de altura al que ajustar esa petición. Los culpables habituales son `SizedBox(height: double.infinity)`, `Container(height: double.infinity)`, `SizedBox.expand` o `BoxConstraints.expand()` colocados directamente dentro de un `Column`, un `ListView` o un `SingleChildScrollView`. La solución es dejar de pedir "infinito" donde nada es finito: usa `Expanded` dentro de un `Column`, dale a la caja un número real, envuélvela en `LimitedBox`, o cambia a `SliverFillRemaining` cuando quieras "llenar el resto de la pantalla, pero seguir haciendo scroll". Todo lo que sigue se reprodujo con Flutter 3.44.8 (stable) y Dart 3.12.2.

Lo confuso es que `height: double.infinity` es un modismo perfectamente normal. Funciona la mayoría de las veces. Solo falla cuando el ancestro más cercano que fija la restricción de altura dice "elige la altura que quieras", y eso es exactamente lo que dicen las columnas y las vistas con scroll.

## El error en contexto

Este es el primer bloque que imprime Flutter. Recorté la traza de pila, que llega a unos 100 frames de `RenderProxyBoxMixin.performLayout`:

```
══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═══════════════════════════════
The following assertion was thrown during performLayout():
BoxConstraints forces an infinite height.
These invalid constraints were provided to _RenderColoredBox's layout() function by the following
function, which probably computed the invalid constraints in question:
  RenderConstrainedBox.performLayout (package:flutter/src/rendering/proxy_box.dart:296:14)
The offending constraints were:
  BoxConstraints(0.0<=w<=800.0, h=Infinity)
The relevant error-causing widget was:
  SizedBox
```

Tres líneas contienen toda la información que necesitas:

- **`h=Infinity`** en las restricciones problemáticas. Es una altura infinita *estricta* (tight): el mínimo y el máximo son ambos infinito. Nada puede satisfacer eso.
- **`RenderConstrainedBox.performLayout`** es la función que las calculó. `RenderConstrainedBox` es el render object detrás de `SizedBox`, `ConstrainedBox` y la parte de dimensionamiento de `Container`. Por lo tanto, el culpable casi siempre es uno de esos tres.
- **"The relevant error-causing widget was"** te da el archivo y la línea de ese widget. Haz clic en él en tu IDE.

Debajo de ese bloque verás una cascada de aserciones `RenderBox was not laid out`, una por cada ancestro, más una de `Scaffold`. Son consecuencias. Corrige el primer error y todas desaparecen. Si llegaste aquí desde esa cascada, el [recorrido por RenderBox was not laid out](/es/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) explica por qué se acumula de esa manera.

El mensaje hermano `BoxConstraints forces an infinite width.` es el mismo error girado 90 grados, y `BoxConstraints forces an infinite width and infinite height.` son ambos a la vez. Todo lo de este artículo se aplica a ellos intercambiando ancho y alto.

## Por qué ocurre

El layout de Flutter se resume en una regla: las restricciones bajan, los tamaños suben, el padre fija la posición. Cada padre le entrega a su hijo un `BoxConstraints` con un mínimo y un máximo de ancho y alto.

Cuando escribes `SizedBox(height: double.infinity)`, no estás fijando la altura en infinito. Estás pidiendo restricciones estrictas de `minHeight: infinity, maxHeight: infinity`, y `RenderConstrainedBox` concilia esa petición con lo que permitió su propio padre, usando `BoxConstraints.enforce`:

```dart
// Flutter 3.44.8, package:flutter/src/rendering/box.dart (simplified)
BoxConstraints enforce(BoxConstraints constraints) {
  return BoxConstraints(
    minHeight: clampDouble(minHeight, constraints.minHeight, constraints.maxHeight),
    maxHeight: clampDouble(maxHeight, constraints.minHeight, constraints.maxHeight),
    // width is clamped the same way
  );
}
```

Ese ajuste (clamp) es la razón por la que el modismo normalmente funciona. Dentro del cuerpo de un `Scaffold`, el padre dice `0 <= h <= 600`, así que el infinito se ajusta a 600 y la caja llena la pantalla. Pero un `Column` le da a cada hijo sin flex `0 <= h <= Infinity` en su eje principal, y un `ListView` vertical o un `SingleChildScrollView` hacen lo mismo. Ajustar infinito a un máximo de infinito deja infinito. Las restricciones resultantes se pasan al `layout()` del hijo, que ejecuta `debugAssertIsValid(isAppliedConstraint: true)`, ve un mínimo infinito y lanza la excepción.

Así que la regla que debes recordar: **`double.infinity` significa "tan grande como me lo permita mi padre". Solo es seguro cuando el padre permite algo finito.**

## Un ejemplo mínimo para pegar en una app nueva

Cada uno de estos tres cuerpos lanza el error en Flutter 3.44.8. Los ejecuté como pruebas de widgets dentro de `MaterialApp(home: Scaffold(body: ...))`:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

// 1. A Column gives children unbounded height.
const columnRepro = Column(
  children: [
    Text('Header'),
    SizedBox(
      height: double.infinity,
      child: ColoredBox(color: Colors.red),
    ),
  ],
);

// 2. A vertical ListView gives children unbounded height.
final listRepro = ListView(
  children: [
    Container(height: double.infinity, color: Colors.red),
  ],
);

// 3. SizedBox.expand and BoxConstraints.expand() are the same request in disguise.
const scrollRepro = SingleChildScrollView(
  child: Column(
    children: [
      SizedBox.expand(child: ColoredBox(color: Colors.red)),
    ],
  ),
);
```

Las restricciones problemáticas difieren ligeramente: el ejemplo con `Column` reporta `BoxConstraints(0.0<=w<=800.0, h=Infinity)` porque el eje transversal de una columna es flexible, mientras que los ejemplos con `ListView` y `SizedBox.expand` reportan `BoxConstraints(w=800.0, h=Infinity)`. Mismo error, misma solución.

Un detalle que confunde a la gente: si el `SizedBox` **no tiene hijo**, no obtienes este mensaje. Obtienes `RenderConstrainedBox object was given an infinite size during layout`, porque no hay un hijo al que llamar `layout()` y la caja intenta dimensionarse a sí misma en infinito. Misma causa, distinta redacción.

## La solución, en detalle

Elige la solución según lo que realmente querías que hiciera la altura infinita.

### 1. "Llenar el espacio restante del Column": usa Expanded

Esta es la intención más común. Dentro de un `Column`, la forma de decir "toma lo que sobre" es un hijo flex, no un tamaño infinito:

```dart
// Flutter 3.44.8, Dart 3.12.2
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Container(color: Colors.red), // no height at all
    ),
  ],
)
```

En mi prueba con una superficie de 800x600, la caja roja resultó con `Size(800.0, 580.0)`: la altura completa menos la línea del encabezado. `Expanded` funciona porque el `Column` posiciona a los hijos flex al final, después de saber cuánto espacio usaron los hijos de tamaño fijo, y les pasa una altura estricta y finita.

Esto solo funciona cuando el propio `Column` tiene una altura acotada. Si ese `Column` está dentro de un `SingleChildScrollView`, `Expanded` cambia este error por `RenderFlex children have non-zero flex but incoming height constraints are unbounded`. Es el mismo problema un nivel más arriba, y las soluciones 3 y 4 lo resuelven.

### 2. "Solo quiero que sea alto": dale un número finito

Si la caja está dentro de una vista con scroll, hará scroll, así que "llenar la pantalla" normalmente no es lo que querías. Dale una altura real, o derívala de la pantalla:

```dart
// Flutter 3.44.8, Dart 3.12.2
Builder(
  builder: (context) => ListView(
    children: [
      SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.5,
        child: const ColoredBox(color: Colors.red),
      ),
      // ... more children
    ],
  ),
)
```

Eso produjo una caja de `Size(800.0, 300.0)` en una superficie de 600 píxeles de alto. Prefiere `MediaQuery.sizeOf(context)` sobre `MediaQuery.of(context).size`: solo se reconstruye cuando cambia el tamaño, no con cada cambio de `MediaQuery`, como los insets del teclado.

Si el widget es reutilizable y no sabes si terminará en un padre acotado o no acotado, usa `LimitedBox`. No hace nada cuando el padre está acotado, y limita el máximo cuando no lo está:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: [
    LimitedBox(
      maxHeight: 200,
      child: Container(height: double.infinity, color: Colors.red),
    ),
  ],
)
```

Dentro del `ListView`, ese contenedor se posicionó con `Size(800.0, 200.0)` sin ningún error. Pon el mismo widget en un padre acotado y llenará el padre. Este es el patrón que recomienda la guía oficial "Understanding constraints" para exactamente esta situación.

### 3. "Llenar la pantalla, pero hacer scroll si el contenido es más alto": SliverFillRemaining

Este es el caso del formulario de inicio de sesión: una columna que debe estirarse hasta el fondo del viewport para que un botón quede abajo, pero que haga scroll en celulares pequeños o cuando el teclado está abierto. `SliverFillRemaining` con `hasScrollBody: false` es el widget hecho para esto:

```dart
// Flutter 3.44.8, Dart 3.12.2
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: SizedBox(height: 100)),
    SliverFillRemaining(
      hasScrollBody: false,
      child: Container(color: Colors.red),
    ),
  ],
)
```

La caja roja recibió `Size(800.0, 500.0)`: exactamente el viewport menos el encabezado de 100 píxeles. `hasScrollBody: false` le indica al sliver que su hijo no es un scrollable, así que dimensiona al hijo con al menos la extensión restante, y con la altura propia del hijo si esta es mayor. Si el hijo es un `ListView` u otra vista con scroll, deja `hasScrollBody` en su valor por defecto, `true`.

### 4. Lo mismo sin slivers: LayoutBuilder más ConstrainedBox

Si aún no estás listo para mover una pantalla a `CustomScrollView`, la documentación de `SingleChildScrollView` describe un patrón que lee la altura del viewport una vez y la convierte en un *mínimo* en lugar de un tamaño infinito estricto:

```dart
// Flutter 3.44.8, Dart 3.12.2
LayoutBuilder(
  builder: (context, viewport) => SingleChildScrollView(
    child: ConstrainedBox(
      constraints: BoxConstraints(minHeight: viewport.maxHeight),
      child: IntrinsicHeight(
        child: Column(
          children: [
            const Text('top'),
            Expanded(child: Container(color: Colors.red)),
            const Text('bottom'),
          ],
        ),
      ),
    ),
  ),
)
```

El `LayoutBuilder` está fuera de la vista con scroll, así que `viewport.maxHeight` es finito (600 aquí). `ConstrainedBox` le da a la columna un piso de 600 pero ningún techo, e `IntrinsicHeight` le da al `Column` una altura acotada para que `Expanded` sea válido. Mi prueba produjo una caja roja de 560 píxeles entre las dos líneas de texto. `IntrinsicHeight` cuesta una pasada de layout adicional sobre su subárbol, lo cual está bien para un formulario y mal para una lista larga. Para contenido largo, usa la solución 3 o las opciones de [shrinkWrap vs Expanded vs slivers](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

### 5. "Igualar la altura de la fila": IntrinsicHeight más stretch

Una fuente muy común de este error dentro de las listas es una barra lateral de color o un divisor vertical que debería ser tan alto como su vecino:

```dart
// Flutter 3.44.8, Dart 3.12.2
// Throws: BoxConstraints(w=4.0, h=Infinity)
ListView(
  children: const [
    Row(
      children: [
        SizedBox(width: 4, height: double.infinity, child: ColoredBox(color: Colors.blue)),
        Text('item'),
      ],
    ),
  ],
)
```

El `Row` le pasa a la barra su propia restricción vertical no acotada. Pídele a la fila que mida primero a su hijo más alto y luego estira todo para igualarlo:

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: const [
    IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 4, child: ColoredBox(color: Colors.blue)),
          Text('item\nline2'),
        ],
      ),
    ),
  ],
)
```

Sin `height` en la barra: `CrossAxisAlignment.stretch` le da una altura estricta igual a la de la fila, e `IntrinsicHeight` hace que esa altura sea finita. Un `IntrinsicHeight` por elemento de la lista es lo bastante económico para listas típicas.

## Casos particulares y errores parecidos

- **`double.maxFinite` no es una solución.** Cambiar `double.infinity` por `double.maxFinite` silencia la aserción, pero en mi prueba la caja se posicionó con `Size(0.0, 1.7976931348623157e+308)`. Has construido una caja más alta que el universo, y todo lo que queda debajo es inalcanzable. Si encuentras esta "solución" en una revisión de código, es el mismo error, escondido.
- **La verificación solo existe en modo debug.** `debugAssertIsValid` se ejecuta dentro de un `assert`, así que las compilaciones release la omiten y obtienes un área gris o contenido faltante en lugar de una pantalla roja. Reproduce siempre los errores de layout en modo debug.
- **Un `ListView` horizontal no da problemas.** `ListView(scrollDirection: Axis.horizontal)` les da a los hijos una *altura* acotada (la suya), así que `height: double.infinity` dentro de él se ajusta correctamente: mi prueba obtuvo `Size(100.0, 600.0)`. En esa lista, lo que falla es `width: double.infinity`.
- **`Vertical viewport was given unbounded height`** es la situación inversa: un scrollable colocado dentro de un `Column`, en lugar de una caja infinita colocada dentro de un scrollable. Las soluciones se solapan, y la [guía de ListView dentro de un Column](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) cubre ese caso en profundidad.
- **`TextField` dentro de un `Row`** produce `An InputDecorator, which is typically created by a TextField, cannot have an unbounded width` como primer error en Flutter 3.44.8, no el mensaje de `BoxConstraints`. Envuelve el campo en `Expanded` o en un `SizedBox` de ancho fijo.
- **`IntrinsicHeight` alrededor de un `ListView`** no lanza este error. Lanza `RenderViewport does not support returning intrinsic dimensions`, porque un viewport perezoso se niega a medir todos sus hijos. Nunca envuelvas un scrollable en un widget intrínseco.
- **`UnconstrainedBox`** elimina por completo las restricciones de su padre, así que cualquier hijo infinito dentro de él lanza este error incluso en una pantalla acotada. Pon un `LimitedBox` entre ambos, o elimina el `UnconstrainedBox`.
- **Un `Column` que se desborda en lugar de lanzar la excepción** es un problema distinto: el contenido es finito pero demasiado alto. Consulta la [guía de RenderFlex overflowed](/es/2026/05/fix-renderflex-overflowed-in-flutter/).

## Cómo encontrar al culpable en un árbol de widgets grande

Cuando el "relevant error-causing widget" apunta a un componente compartido, abre Flutter DevTools, selecciona el widget en el Widget Inspector y mira las restricciones que se muestran en el Layout Explorer. Sube por el árbol hasta encontrar el primer ancestro cuya restricción de altura sea `Infinity`: ese es el `Column`, `ListView`, `Row` o `UnconstrainedBox` que eliminó el límite. La solución va en ese ancestro (acotarlo) o en el hijo (dejar de pedir infinito). Buscar en tu código `double.infinity`, `.expand(` y `BoxConstraints.expand` suele encontrar al candidato en menos de un minuto.

## Relacionado

- [Solución: RenderBox was not laid out en Flutter](/es/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), la cascada que sigue a este error.
- [Cómo anidar un ListView dentro de un Column sin un error de altura no acotada](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/).
- [shrinkWrap vs Expanded vs slivers para listas largas en Flutter](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).
- [Solución: A RenderFlex overflowed en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/).
- [Solución: RenderViewport expected a RenderSliver en un CustomScrollView](/es/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/), si te lo encuentras al migrar a `SliverFillRemaining`.

## Fuentes

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) (documentación de Flutter), incluidos los ejemplos de `LimitedBox` y `UnconstrainedBox`.
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors) (documentación de Flutter).
- [BoxConstraints.enforce](https://api.flutter.dev/flutter/rendering/BoxConstraints/enforce.html) y [BoxConstraints.debugAssertIsValid](https://api.flutter.dev/flutter/rendering/BoxConstraints/debugAssertIsValid.html) (referencia de la API).
- [SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html), la sección "Centering, spacing, or aligning fixed-height content".
- [SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html) y [LimitedBox](https://api.flutter.dev/flutter/widgets/LimitedBox-class.html) (referencia de la API).
- `packages/flutter/lib/src/rendering/box.dart` y `proxy_box.dart` en el SDK de Flutter 3.44.8, leídos localmente.

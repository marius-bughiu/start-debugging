---
title: "Expanded vs Flexible en Flutter: FlexFit.tight vs FlexFit.loose explicado"
description: "Usa Expanded cuando un hijo deba llenar su parte de un Row o Column, y Flexible cuando pueda ser más pequeño que su parte. Diseños medidos en Flutter 3.44 muestran adónde va el espacio sobrante, por qué los hijos loose nunca se lo ceden a sus hermanos y cuándo solo Flexible sobrevive a restricciones sin límite."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "es"
translationOf: "2026/10/expanded-vs-flexible-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-22
---

**Respuesta corta:** `Expanded` es literalmente `Flexible(fit: FlexFit.tight)`. Usa `Expanded` cuando el hijo deba llenar su parte del `Row` o `Column` (listas, paneles, cualquier cosa con un fondo). Usa `Flexible` (el `FlexFit.loose` por defecto) cuando el hijo pueda ser más pequeño que su parte; el caso clásico es un `Text` que debe truncarse cuando es largo pero ajustarse a su contenido cuando es corto. Ambos reciben el mismo tamaño máximo; solo `Expanded` obliga al hijo a ocupar ese tamaño. Todo lo que sigue se midió con `flutter test` en Flutter 3.44.8 / Dart 3.12.2.

La confusión es comprensible, porque en los diseños más comunes los dos se ven idénticos. Un `ListView` o un `Container` sin hijo quiere todo el espacio que pueda conseguir, así que envolverlo en cualquiera de los dos widgets produce los mismos píxeles. La diferencia solo aparece cuando el hijo está conforme con ser pequeño, y es justo ahí donde la gente obtiene un chip estirado, un ícono empujado al borde lejano de una fila o un hueco que no sabe explicar.

## La comparación de un vistazo

| Comportamiento (Flutter 3.44)                               | `Expanded`                         | `Flexible` (por defecto)               |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| Ajuste (fit)                                                | `FlexFit.tight`                    | `FlexFit.loose`                        |
| Restricción pasada en el eje principal                      | mín = máx = parte                  | mín = 0, máx = parte                   |
| Hijo más pequeño que su parte                               | se estira hasta la parte           | conserva su propio tamaño              |
| Parte sin usar                                              | ninguna                            | se convierte en espacio libre, no se da a los hermanos |
| `mainAxisAlignment` tiene algún efecto                      | no (no queda espacio libre)        | sí                                     |
| `Row(mainAxisSize: MainAxisSize.min)` se encoge             | no, la fila ocupa todo el ancho    | sí                                     |
| Dentro de un eje principal sin límite (vista con scroll)    | siempre una aserción               | permitido si `mainAxisSize: MainAxisSize.min` |
| `fit` configurable                                          | no                                 | sí                                     |

Si solo recuerdas una fila, recuerda la tercera: tight estira, loose no.

## Qué hace realmente el framework con los dos ajustes

El código fuente es lo bastante corto como para citarlo. En `packages/flutter/lib/src/widgets/basic.dart` de la 3.44.8:

```dart
// Flutter 3.44.8, widgets/basic.dart
class Flexible extends ParentDataWidget<FlexParentData> {
  const Flexible({super.key, this.flex = 1, this.fit = FlexFit.loose, required super.child});
  // ...
}

class Expanded extends Flexible {
  const Expanded({super.key, super.flex, required super.child}) : super(fit: FlexFit.tight);
}
```

Ninguno de los dos widgets calcula ningún diseño. Son `ParentDataWidget`s que escriben `flex` y `fit` en el `FlexParentData` del hijo, que `RenderFlex` (el objeto de renderizado detrás de `Row`, `Column` y `Flex`) lee durante el diseño. Por eso ambos lanzan el mismo error "must be placed inside Flex widgets" cuando los pones bajo un padre que no es flex.

`RenderFlex._computeSizes` en `rendering/flex.dart` se ejecuta en dos pasadas:

1. Dispone cada hijo con `flex == 0` (widgets normales) usando su tamaño natural y suma sus extensiones en el eje principal.
2. Calcula `spacePerFlex = (maxMainSize - usedByNonFlexChildren) / totalFlex` **una sola vez**, y luego dispone cada hijo flex con un máximo de `spacePerFlex * flex`. Para `FlexFit.tight` el mínimo es igual a ese máximo. Para `FlexFit.loose` el mínimo es `0`.

El detalle que importa es "una sola vez". La parte se decide antes de medir cualquier hijo flexible. Si un hijo loose usa menos que su parte, el resto no se entrega a sus hermanos. Se convierte en espacio libre para `mainAxisAlignment`, que es el origen de la mayoría de las preguntas del tipo "¿por qué hay un hueco?".

## Medido: el mismo hijo con ambos ajustes

Todos los números de abajo provienen de pruebas de widgets que fijan el `Row` en una caja de 400 píxeles lógicos de ancho y leen de vuelta `tester.getSize` y `tester.getTopLeft`. Aquí está el arnés y el primer caso:

```dart
// Flutter 3.44.8, Dart 3.12.2, flutter_test
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 400, height: 100, child: child),
      ),
    );

const a = Key('a'), b = Key('b');

void main() {
  testWidgets('tight vs loose with a small child', (t) async {
    await t.pumpWidget(host(Row(children: [
      Expanded(child: SizedBox(key: a, width: 50, height: 10)),
      Flexible(child: SizedBox(key: b, width: 50, height: 10)),
    ])));
    print('Expanded=${t.getSize(find.byKey(a))} '
        'Flexible=${t.getSize(find.byKey(b))}');
  });
}
```

Salida: `Expanded=Size(200.0, 10.0) Flexible=Size(50.0, 10.0)`. A ambos hijos se les ofrecieron 200 píxeles (400 repartidos entre un flex total de 2). El `SizedBox(width: 50)` bajo `Expanded` fue anulado por la restricción tight y quedó con 200 de ancho; bajo `Flexible` conservó sus 50. El `width: 50` es una petición, y una restricción tight del padre siempre gana.

El conjunto completo de pruebas, con la misma fila de 400 px:

| Diseño (Flutter 3.44.8)                                                        | Resultado                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `Expanded(SizedBox(w: 50))` + `Flexible(SizedBox(w: 50))`                      | 200 y 50                                            |
| `Flexible(SizedBox(w: 50))` + `Flexible(SizedBox(w: 1000))`                    | 50 y 200, 150 px sin usar al final                  |
| `SizedBox(w: 100)` + `Expanded(flex: 2)` + `Flexible(flex: 1, SizedBox(w: 40))` | 200 y 40, 60 px sin usar                           |
| `Flexible(fit: FlexFit.tight, SizedBox(w: 50))` + `SizedBox(w: 100)`           | 300, idéntico a `Expanded`                          |
| `Flexible(Container(color: ...))` + `SizedBox(w: 100)`                         | 300 x 100, el ajuste loose no cambió nada           |

La segunda fila es la que hay que interiorizar. El hijo de 1000 píxeles se limitó a 200 aunque su hermano solo usó 50, porque los 150 sin usar del hermano nunca se redistribuyeron. Si quieres "el pequeño toma lo que necesita y el grande recibe el resto", el pequeño no debe ser flexible en absoluto: hazlo un hijo normal, y solo el grande `Expanded`.

La última fila explica por qué tanta gente concluye que "Flexible y Expanded son lo mismo". Un `Container` sin hijo, sin ancho y sin alineación toma el mayor tamaño que sus restricciones permitan. Si le das un máximo loose de 300, elige 300. Lo mismo ocurre con `ListView`, `TextField` (que llena su ancho) y cualquier otro widget que se expande por defecto. Con hijos voraces, el ajuste es invisible.

## Cuándo elegir Expanded

- **Un elemento desplazable dentro de un `Column`.** `Column(children: [Header(), Expanded(child: ListView(...))])` es el diseño canónico. La lista necesita una altura acotada, y debe ser exactamente la altura restante para que su extensión de scroll sea correcta. Esta es la primera solución en [la guía de ListView dentro de un Column](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/), y [la razón por la que supera a `shrinkWrap` en listas largas](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) es que la lista sigue construyendo sus hijos de forma perezosa.
- **Paneles con fondo, borde o área de toque.** Una barra lateral coloreada y un área de contenido divididas 1:3 deben usar `Expanded(flex: 1)` y `Expanded(flex: 3)` para que los colores lleguen de borde a borde, sin importar lo que mida el contenido.
- **Cuadrículas proporcionales construidas con `Row`s.** Si tres celdas deben alinearse con tres celdas de la fila siguiente, los ajustes tight garantizan los mismos anchos. Los ajustes loose dejan que cada fila se desvíe según su contenido.
- **Separar elementos.** `Spacer()` es `Expanded(flex: flex, child: SizedBox.shrink())`. En la prueba, `SizedBox(w: 50)`, `Spacer()`, `SizedBox(w: 50)` coloca la segunda caja en x = 350, pegada a la derecha.

## Cuándo elegir Flexible

- **Texto que solo debe truncarse cuando tiene que hacerlo.** Este es el caso que más importa en aplicaciones reales. Compara una etiqueta seguida de un ícono:

```dart
// Flutter 3.44.8: label that hugs its text but ellipsizes when long
Row(
  children: [
    Flexible(
      child: Text(
        userName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
    const Icon(Icons.verified, size: 16),
  ],
)
```

Medido en una fila de 400 px dentro de un `Scaffold`, con `userName = 'Short'`: bajo `Flexible` el texto mide 71.25 px de ancho y el ícono queda en x = 71.25, justo junto al nombre. Cambia a `Expanded` y el texto pasa a medir 376 px de ancho y el ícono es empujado a x = 376, el borde lejano de la fila. Con un nombre largo ambas versiones limitan el texto a 376 px y muestran puntos suspensivos, así que la solución del desbordamiento es la misma, pero solo `Flexible` mantiene bien el caso corto. Si estás aquí por la franja amarilla y negra, la [guía de RenderFlex overflowed](/es/2026/05/fix-renderflex-overflowed-in-flutter/) cubre las otras causas.

- **Chips, insignias y botones que deben conservar su tamaño natural** pero no deben desbordarse en pantallas estrechas ni con texto de accesibilidad grande. Los ajustes tight estiran su área de toque a lo largo de la fila.
- **Cuando quieres que `mainAxisAlignment` funcione.** Con dos hijos loose de 50 px y `MainAxisAlignment.spaceBetween`, el segundo hijo queda en x = 350. Con dos hijos `Expanded` la alineación se ignora y el segundo queda en x = 200, porque un diseño tight no tiene espacio libre que distribuir.
- **Filas que se ajustan a su contenido.** `Row(mainAxisSize: MainAxisSize.min, children: [Flexible(child: SizedBox(width: 50)), SizedBox(width: 20)])` midió 70 px de ancho. La misma fila con `Expanded` midió los 400 px completos, porque un hijo tight consume todo el espacio que ofrece el padre, así que no queda nada que `MainAxisSize.min` pueda minimizar. Esto afecta a quien construye un contenedor en forma de píldora que se supone que envuelve su etiqueta.

## La trampa que elige por ti: eje principal sin límite

Pon un `Column` dentro de un `SingleChildScrollView` (o un `Row` dentro de un `ListView` horizontal) y el flex recibe una restricción infinita en el eje principal. `RenderFlex` no puede dividir el infinito, así que en `_computeSizes` establece `canFlex = false` y dispone cada hijo como si no tuviera flex en absoluto.

Lo que ocurre después depende del ajuste. La verificación de depuración `_debugCheckConstraints` lanza una excepción si un hijo tiene un flex distinto de cero **y** el flex usa `MainAxisSize.max` o el hijo es `FlexFit.tight`:

```dart
// Flutter 3.44.8: throws in debug
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Expanded(child: SizedBox(height: 50)),
    ],
  ),
)
// RenderFlex children have non-zero flex but incoming height constraints are unbounded.
```

```dart
// Flutter 3.44.8: lays out fine, child is 50 px tall
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(child: SizedBox(height: 50)),
    ],
  ),
)
```

Ambos se verificaron en la prueba: la variante con `Expanded` produjo la aserción, la variante con `Flexible` dispuso un hijo de 10 x 50 sin excepción. Esto importa para los widgets reutilizables. Si un componente envuelve parte de sí mismo en `Expanded`, nunca podrá colocarse en una columna desplazable. Si usa `Flexible` y su columna usa `MainAxisSize.min`, se degrada con elegancia: con un padre acotado, flexiona; con un padre sin límite, toma su tamaño natural. Ten en cuenta que en el caso sin límite el `Flexible` es efectivamente una operación nula, así que un hijo voraz bajo él (un `ListView`) seguirá lanzando su propio error de "unbounded height".

## Trampas menores y variantes

**`flex: 0` desactiva el widget.** `RenderFlex` comprueba `flex > 0` antes de tratar a un hijo como flexible. `Flexible(flex: 0, ...)` se dispone como un hijo normal. `Spacer` afirma `flex > 0` para evitar que lo hagas por accidente.

**`Flexible(fit: FlexFit.tight)` y `Expanded` son intercambiables.** La prueba produjo tamaños idénticos. Prefiere `Expanded` por legibilidad; recurre a un `fit` explícito solo cuando se calcula, por ejemplo `Flexible(fit: isCompact ? FlexFit.loose : FlexFit.tight, child: ...)`.

**El eje transversal no se toca.** Ambos widgets solo restringen el eje principal. Si quieres que el hijo también llene el eje transversal, eso es `crossAxisAlignment: CrossAxisAlignment.stretch` en el `Row` o `Column`, no un widget flex diferente.

**`spacing` se descuenta primero.** Desde Flutter 3.27, `Row` y `Column` tienen un parámetro `spacing`. `_computeSizes` inicializa el espacio usado con `spacing * (childCount - 1)` antes de dividir, así que los espacios se restan antes de calcular cualquier parte flex.

**No los encadenes.** `Expanded(child: Flexible(...))` lanza el error de ParentDataWidget porque el padre del interno no es un flex. Consulta [la solución de "Expanded widgets must be placed inside Flex widgets"](/es/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) para la lista completa de wrappers que lo causan.

## La recomendación, con el contexto detrás

Usa `Expanded` por defecto. La mayoría de los hijos flexibles en aplicaciones reales son elementos desplazables, paneles o campos que de todos modos quieren todo el espacio, y los ajustes tight te dan diseños predecibles y alineados, sin sorpresas de espacio libre.

Cambia a `Flexible` en exactamente tres situaciones: el hijo tiene un tamaño natural que quieres conservar (texto junto a un ícono, un chip), necesitas que `mainAxisAlignment` o `MainAxisSize.min` sigan funcionando, o estás escribiendo un widget reutilizable que puede terminar dentro de una vista con scroll. Y cuando te descubras poniendo `Flexible` en dos hermanos esperando que el pequeño ceda espacio al grande, detente: haz del pequeño un hijo normal y del grande un `Expanded`, porque `RenderFlex` nunca redistribuye la parte sin usar de un hijo loose.

## Relacionado

- [Corrige "A RenderFlex overflowed by N pixels" en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) para los casos de desbordamiento donde la elección entre estos dos es la solución.
- [Por qué un ListView dentro de un Column lanza un error de altura sin límite](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) y las cuatro formas de acotarlo.
- [shrinkWrap vs Expanded vs slivers para listas largas](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/) cuando el hijo flexible es un elemento desplazable.
- [Cómo corregir "Incorrect use of ParentDataWidget"](/es/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) cuando `Expanded` o `Flexible` no es un hijo flex directo.

## Fuentes

- [Flexible class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html)
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html)
- [FlexFit enum, Flutter API reference](https://api.flutter.dev/flutter/rendering/FlexFit.html)
- [Spacer class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Spacer-class.html)
- [RenderFlex source, flutter/flutter `rendering/flex.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/rendering/flex.dart)
- [Understanding constraints, Flutter docs](https://docs.flutter.dev/ui/layout/constraints)

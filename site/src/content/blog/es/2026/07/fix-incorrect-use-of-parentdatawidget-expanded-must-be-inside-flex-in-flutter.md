---
title: "Solución: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets (Flutter)"
description: "Este error significa que un Expanded o Flexible no es hijo directo de un Row, Column o Flex. Muévelo directamente bajo el widget flex, o quita Expanded si el padre no es un flex."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
lang: "es"
translationOf: "2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

`Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets` significa que un `Expanded` (o `Flexible`) no es hijo directo de un `Row`, `Column` o `Flex`. Algún otro widget -- un `Container`, `SizedBox`, `Padding`, `Center`, `Stack` o `Wrap` -- se interpone entre ambos. Corrígelo haciendo que `Expanded` sea el hijo directo del flex, o quitando `Expanded` por completo si el padre no es un flex. Probado en Flutter 3.x (3.44), Dart 3.x.

## El error en contexto

Flutter lanza esto durante la fase de build, como una aserción, antes de que se ejecute el layout. La línea de resumen corta es la que la gente busca, pero el mensaje completo en Flutter actual te dice exactamente qué widget está mal y dentro de qué está anidado incorrectamente:

```
Incorrect use of ParentDataWidget.

The ParentDataWidget Expanded(flex: 1) wants to apply ParentData of type
FlexParentData to a RenderObject, which has been set up to accept ParentData of
incompatible type BoxParentData.

Usually, this means that the Expanded widget has the wrong ancestor
RenderObjectWidget. Typically, Expanded widgets are placed directly inside Flex
widgets.
The offending Expanded is currently placed inside a SizedBox widget.

The ownership chain for the RenderObject that received the incompatible parent data
was:
  SizedBox ← Expanded ← Column ← ...
```

Dos líneas contienen toda la información. "wants to apply ParentData of type `FlexParentData` to a RenderObject, which has been set up to accept ParentData of incompatible type `BoxParentData`" es la incompatibilidad de tipos. "The offending Expanded is currently placed inside a `SizedBox` widget" nombra el padre incorrecto por tipo de widget. En versiones anteriores de Flutter, todo se reduce al resumen que probablemente escribiste en la barra de búsqueda: `Expanded widgets must be placed inside Flex widgets`.

## Por qué un padre Flex es obligatorio, no solo recomendado

`Expanded` no dibuja nada. Es un `ParentDataWidget`: su única tarea es adjuntar un fragmento de configuración a su hijo para que el render object padre sepa cómo posicionar a ese hijo. Para `Expanded`, esa configuración es un factor flex, y vive en un objeto de tipo `FlexParentData`.

Este es el mecanismo. Un `Row`, `Column` o `Flex` está respaldado por un `RenderFlex`. Cuando `RenderFlex` adopta un hijo, configura un espacio de `FlexParentData` en ese hijo para almacenar el valor flex y el fit. `Expanded` sube hasta su render object padre y llama a `applyParentData`, que escribe `flex` y `fit` en ese espacio. `RenderFlex` lee ese espacio durante el layout: los hijos con un factor flex reparten el espacio sobrante del eje principal en proporción a sus factores. Ese acuerdo es la única razón por la que `Expanded` funciona.

Cualquier otro render object configura un tipo de `ParentData` distinto. Un `SizedBox`, `Container` o `Padding` le da a su único hijo `BoxParentData`. Un `Stack` les da a los hijos `StackParentData`. Un `Wrap` les da a los hijos `WrapParentData`. Ninguno de ellos tiene un campo `flex`, y `FlexParentData` no se puede escribir en un espacio `BoxParentData`. Así que cuando `Expanded` intenta hacer `applyParentData` en un padre que no es flex, la comprobación `debugIsValidRenderObject` del framework detecta la incompatibilidad de tipos de inmediato y lanza el error, en lugar de ignorar en silencio el factor flex o fallar más tarde durante el layout. El mensaje se genera a partir del `debugTypicalAncestorWidgetDescription` del widget, que para `Expanded` es "Flex widgets": de ahí viene la frase "must be placed inside Flex widgets".

Este es un fallo distinto de un [desbordamiento de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/), que ocurre cuando un `Row` o `Column` se queda sin espacio en tiempo de layout. Este se dispara antes, en tiempo de build, y es un error de tipo: la configuración flex no tiene ningún lugar válido donde aterrizar.

## El repro mínimo

La versión más pequeña es un `Expanded` envuelto en cualquier widget de un solo hijo:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 200,
      child: Expanded(          // wrong: SizedBox is not a Flex
        child: ListView(
          children: const [Text('a'), Text('b')],
        ),
      ),
    );
  }
}
```

`SizedBox` le da a su hijo `BoxParentData`. `Expanded` quiere escribir `FlexParentData`. El build falla. El fallo idéntico aparece si cambias `SizedBox` por `Container`, `Padding`, `Center`, `Align`, `Card`, `Wrap` o un `Stack`: cualquier cosa que no sea un `Row`, `Column` o `Flex`.

## Solución 1: haz que Expanded sea hijo directo del Row, Column o Flex

Si sí tienes un padre flex y un widget intermedio se coló, la solución es reordenar para que `Expanded` quede directamente bajo el flex. Este es de lejos el caso más común: alguien envolvió un hijo del flex en un `Padding` o `Container` para darle estilo, y el `Expanded` terminó del lado equivocado.

Incorrecto -- `Expanded` está dentro del `Padding`, y `Padding` es un box:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Padding(
      padding: const EdgeInsets.all(8),
      child: Expanded(child: content),   // throws: parent is Padding
    ),
  ],
)
```

Correcto -- `Expanded` es el hijo directo del `Column`, y el `Padding` va dentro de él:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: content,
      ),
    ),
  ],
)
```

La regla que hay que interiorizar: `Expanded` debe ser el widget más externo en ese hueco de la lista `children`. Todo lo que quieras decorar, rellenar o dimensionar va dentro de su `child`, no alrededor de él.

## Solución 2: quita Expanded cuando el padre no es un flex en absoluto

Si de verdad no hay ningún `Row`, `Column` o `Flex` por encima del widget, entonces `Expanded` es la herramienta equivocada y ningún grado de anidamiento lo hará legal. Quieres otra forma de rellenar el espacio:

- **Para rellenar el ancho o alto del padre**, dimensiona el hijo directamente. Usa `SizedBox(width: double.infinity)`, `SizedBox.expand` o `double.infinity` en las restricciones de un `Container`:

```dart
// Flutter 3.x (tested 3.44)
// Was: Container(child: Expanded(child: button))  -- illegal
SizedBox(
  width: double.infinity,
  child: button,
)
```

- **Para rellenar una fracción del padre**, usa `FractionallySizedBox`:

```dart
// Flutter 3.x (tested 3.44)
FractionallySizedBox(
  widthFactor: 0.5,
  child: button,
)
```

- **Si en realidad querías un reparto proporcional**, buscabas `Expanded` por la razón correcta pero olvidaste el padre flex. Introduce uno. Envuelve el grupo en un `Row` o `Column` y pon los hijos `Expanded` directamente dentro de él:

```dart
// Flutter 3.x (tested 3.44)
Row(
  children: [
    Expanded(flex: 2, child: leftPane),
    Expanded(flex: 1, child: rightPane),
  ],
)
```

Elige según la intención. Si solo tienes un hijo, no necesitas flex para nada: dimensiona el box. Si estás dividiendo espacio entre hermanos, necesitas un padre flex de verdad.

## Solución 3: cuidado con un RenderObjectWidget escondido en el camino

El contrato de `Expanded` es más estricto que "en algún lugar bajo un Column". La documentación establece que el camino desde `Expanded` hacia arriba hasta su `Row`, `Column` o `Flex` contenedor debe contener **solo** `StatelessWidget`s o `StatefulWidget`s. En el momento en que un `RenderObjectWidget` aparece en ese camino, se convierte en el padre que recibe los parent data, y la incompatibilidad lanza el error.

Esto muerde de dos maneras sigilosas:

**Un `Container` con ciertas propiedades inserta render widgets.** `Container` es una composición: dale `padding` y envuelve a su hijo en un `Padding`; dale un `color` o `decoration` y añade un `DecoratedBox`; dale `alignment` y añade un `Align`. Así que `Container(padding: ..., child: Expanded(...))` coloca un `Padding` (un `RenderObjectWidget`) directamente encima de tu `Expanded`, aunque nunca escribiste `Padding`. Ese es el repro de la Solución 1 disfrazado.

**Tu propio `RenderObjectWidget` en el camino.** Si tienes un render widget a medida envolviendo a los hijos antes de que lleguen al `Column`, se aplica la misma regla. Los envoltorios `StatelessWidget` y `StatefulWidget` propios están bien; un `RenderObjectWidget` propio no.

La conclusión: no basta con que un `Flex` sea ancestro. `Expanded` tiene que alcanzarlo a través de nada más que widgets de composición sencillos.

## Trampas y casos parecidos

**`flex: 0` sigue lanzando el error.** Es tentador pensar que `Expanded(flex: 0)` es un no-op que el framework dejaría pasar. No lo es. La comprobación del tipo de parent data se ejecuta sin importar el valor flex, así que `Expanded(flex: 0)` dentro de un `Wrap` falla con exactamente el mismo error, nombrando `WrapParentData` como el tipo incompatible. Esto se confirmó como comportamiento intencionado en el [issue 154950 de flutter/flutter](https://github.com/flutter/flutter/issues/154950). Si quieres un hijo que participe en un `Wrap` con un ancho fijo, dale un `SizedBox`, no un `Expanded`.

**`Flexible` tiene la regla idéntica.** `Expanded` es simplemente `Flexible` con `fit: FlexFit.tight`. `Flexible` también es un `ParentDataWidget<FlexParentData>`, así que poner un `Flexible` dentro de un padre que no es flex lanza el mismo error "Flexible widgets must be placed inside Flex widgets". Cambiar `Expanded` por `Flexible` nunca corrige este error: solo cambia el nombre del widget en el mensaje.

**`Positioned` fuera de un `Stack` es el mismo tipo de bug.** Si ves `Incorrect use of ParentDataWidget. Positioned widgets must be placed directly inside Stack widgets`, es exactamente el mismo mecanismo con tipos distintos: `Positioned` escribe `StackParentData` y necesita un `Stack` (respaldado por `RenderStack`) como padre. El patrón de solución es idéntico: haz que sea hijo directo de un `Stack`, o usa un layout sin posicionamiento.

**Un condicional o un spread que produce un `Expanded` en el nivel superior.** Construir los hijos con un helper, un spread `...[]` o un ternario puede entregar accidentalmente un `Expanded` a un padre que no es flex cuando se toma la rama que no probaste. El error nombra el padre en tiempo de ejecución, así que confía en "currently placed inside a X widget" por encima de cómo se ve el código fuente a primera vista.

**El error solo asevera en builds de debug.** La comprobación `debugIsValidRenderObject` es una aserción de modo debug. En un build de release la aserción se elimina en la compilación, los datos flex se descartan en silencio, y obtienes un layout sutilmente incorrecto en vez de un fallo, lo cual es peor de diagnosticar. Resuelve siempre esto en debug antes de publicar; no asumas que un build de release que "se ve bien" es correcto.

## Relacionados

- [Solución: A RenderFlex overflowed in Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) -- el otro error de `Row`/`Column`, lanzado en tiempo de layout cuando los hijos flex piden más espacio del que hay.
- [Solución: RenderBox was not laid out in Flutter](/es/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- una aserción de tiempo de layout que a menudo encuentras en la misma fontanería de scroll y flex.
- [Solución: A RenderViewport expected a RenderSliver en un CustomScrollView de Flutter](/es/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/) -- la misma idea de "protocolo equivocado", pero para slivers frente a boxes en lugar de parent data de flex frente a box.
- [Cómo anidar un ListView dentro de un Column sin el error de altura no acotada](/es/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- donde `Expanded` es la respuesta correcta, dándole a un `ListView` una altura acotada dentro de un `Column`.

## Fuentes

- [Clase Expanded, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- establece que `Expanded` debe ser descendiente de `Row`, `Column` o `Flex`, con solo widgets Stateless/Stateful en el camino.
- [Clase ParentDataWidget, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/ParentDataWidget-class.html) -- `applyParentData`, `debugTypicalAncestorWidgetDescription` y la comprobación de validez que genera este mensaje.
- [Clase Flexible, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/Flexible-class.html) -- la clase base de `Expanded`, sujeta al mismo requisito de padre flex.
- [issue 154950 de flutter/flutter](https://github.com/flutter/flutter/issues/154950) -- confirma que el error sigue disparándose para `Expanded(flex: 0)` dentro de un padre que no es flex, por diseño.

---
title: "Solución: Cannot provide both a color and a decoration en un Container de Flutter"
description: "Mueve el color dentro de la decoración: usa decoration: BoxDecoration(color: ...) en lugar de pasar color y decoration al mismo Container."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "container"
lang: "es"
translationOf: "2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container"
translatedBy: "claude"
translationDate: 2026-07-05
---

La solución en una línea: elimina el argumento `color:` de tu `Container` y coloca ese color dentro del `BoxDecoration`, como `decoration: BoxDecoration(color: Colors.blue, ...)`. La aserción se dispara porque el parámetro `color` de `Container` no es más que un atajo para `decoration: BoxDecoration(color: color)`, así que pasar ambos le daría al widget dos definiciones que compiten por el fondo y Flutter se niega a adivinar cuál gana.

```text
Cannot provide both a color and a decoration
The color argument is just a shorthand for "decoration: BoxDecoration(color: color)".

'package:flutter/src/widgets/container.dart':
Failed assertion: line 273 pos 15: 'color == null || decoration == null'
```

Esta publicación está escrita para Flutter 3.x (probada en 3.44) y Dart 3.x. La aserción de `Container` se lee igual desde la época de la 1.x, así que todo aquí aplica limpiamente a lo largo de toda la línea 3.x y hacia atrás hasta la 2.x. La comprobación vive en `package:flutter/src/widgets/container.dart`; el número de línea en tu traza de pila puede diferir por unas pocas entre versiones del SDK, pero la expresión de la aserción `color == null || decoration == null` es estable.

## Por qué Container prohíbe color y decoration juntos

`Container` es un widget de conveniencia. No pinta nada por sí mismo; compone una pila de widgets más simples (`Padding`, `DecoratedBox`, `ConstrainedBox`, `Transform` y compañía) según los argumentos que le pases. El argumento `color` es la porción más pequeña posible de esa composición: cuando lo estableces, `Container` construye internamente un `DecoratedBox` con un `BoxDecoration(color: color)`. Ese es el significado completo de `color`. Es azúcar sintáctico.

`decoration` es la versión con toda la potencia de lo mismo. Un `BoxDecoration` puede llevar un color de fondo, un borde, esquinas redondeadas, un gradiente, una sombra y una imagen de fondo, todo a la vez. Como un `BoxDecoration` ya tiene su propio campo `color`, dejarte pasar también un `color` de nivel superior crearía un widget ambiguo: ¿qué color pinta, el del `Container` o el del `BoxDecoration`? En lugar de elegir un ganador en silencio (y que la mitad de la comunidad asuma la regla contraria), el framework lanza la aserción en tiempo de construcción y te obliga a ser explícito. El constructor contiene un simple `assert(color == null || decoration == null, ...)`, por lo que esto solo se lanza en compilaciones de depuración y perfil, donde las aserciones se ejecutan.

Hay una segunda razón, más sutil, en las propias palabras del framework: una `decoration` puede pintar sobre el color de fondo. Un `BoxDecoration` con un `DecorationImage` o un gradiente dibuja a lo largo del relleno de la caja, así que un `color` separado por debajo a veces sería visible y a veces no, dependiendo de la opacidad de la decoración. Colapsar ambos en un solo `BoxDecoration` elimina toda esa clase de confusión de "por qué no aparece mi color".

## El repro más pequeño que lo dispara

Cualquier `Container` que quiera a la vez un fondo sólido y un borde se topa con esto de inmediato. Este es el caso canónico, porque el primer intento natural es recurrir a `color` para el relleno y a `decoration` para el borde:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: DecorationDemo()));

class DecorationDemo extends StatelessWidget {
  const DecorationDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Container(
          width: 200,
          height: 120,
          // Both set at once -> assertion throws before the first frame.
          color: Colors.blue,
          decoration: BoxDecoration(
            border: Border.all(color: Colors.black, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Center(child: Text('Card')),
        ),
      ),
    );
  }
}
```

Ejecútalo y la aplicación nunca pinta un frame. La aserción se lanza dentro del constructor de `Container`, así que el error aparece en el momento en que se ejecuta `build`, no más tarde durante el layout. Ese momento es una señal útil: a diferencia de un `RenderFlex overflowed` o un `RenderBox was not laid out`, que ocurren durante la fase de layout, este es una violación de contrato en tiempo de construcción.

## La solución, en orden de con qué frecuencia la necesitas

### Solución 1: mueve el color dentro del BoxDecoration

Esto es correcto prácticamente siempre. Si estás pasando una `decoration`, elimina el argumento `color` y establece `BoxDecoration.color` en su lugar:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  decoration: BoxDecoration(
    color: Colors.blue,               // was the top-level `color:`
    border: Border.all(color: Colors.black, width: 2),
    borderRadius: BorderRadius.circular(12),
  ),
  child: const Center(child: Text('Card')),
)
```

Un solo `BoxDecoration` ahora posee todo el aspecto visual: relleno, borde y radio de esquina. Esta es la forma que quieres para cualquier tarjeta, chip, insignia o fondo de botón, porque en el momento en que necesitas un borde o esquinas redondeadas de todos modos ibas a terminar en un `BoxDecoration`.

### Solución 2: si solo necesitas un color plano, conserva color y elimina la decoration

Si recurriste a `decoration` solo para añadir esquinas redondeadas o un borde, eso es deliberado y la Solución 1 es la correcta. Pero si la `decoration` se coló desde un copiar y pegar y todo lo que realmente necesitas es un relleno sólido sin borde, gradiente ni radio, haz lo contrario: conserva el `color` de nivel superior y elimina la `decoration` por completo.

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  color: Colors.blue,   // fine on its own; no decoration present
  child: const Center(child: Text('Card')),
)
```

El atajo `color` no está obsoleto ni desaconsejado para el caso de relleno plano. Se lee más limpio que envolver un solo color en un `BoxDecoration`, y produce el mismo `DecoratedBox` por debajo. Recurre al `BoxDecoration` completo solo cuando necesites una de sus características adicionales.

### Solución 3: descarta Container por completo para una caja de color simple

Cuando tu `Container` no tiene padding, ni restricciones más allá de un tamaño, ni una transformación, y solo quieres un rectángulo de color, `ColoredBox` es el widget más ligero y nunca tiene esta ambigüedad porque toma un `color` requerido y ninguna decoración:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
const ColoredBox(
  color: Colors.blue,
  child: SizedBox(
    width: 200,
    height: 120,
    child: Center(child: Text('Card')),
  ),
)
```

`ColoredBox` puede ser `const` cuando su hijo es `const`, lo que permite a Flutter omitir su reconstrucción y repintado. Es una ganancia real, aunque pequeña, en una lista de muchas fichas estáticas. Para cualquier cosa con un borde o radio, vuelve a la Solución 1; `ColoredBox` no puede dibujar eso.

## Dónde muerde esto en código real

### Aplicar tema a un widget difundiendo una decoración compartida

Los sistemas de diseño a menudo mantienen un `BoxDecoration` compartido y luego intentan sobrescribir solo el color por instancia:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: passes both the reused decoration AND a color override.
Container(
  color: theme.colorScheme.surfaceContainerHigh,
  decoration: cardDecoration, // already a BoxDecoration
  child: content,
)
```

No puedes superponer un `color` de nivel superior encima de un `BoxDecoration` existente. Usa `copyWith` sobre la decoración en su lugar, que es exactamente para lo que sirve:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  decoration: cardDecoration.copyWith(
    color: theme.colorScheme.surfaceContainerHigh,
  ),
  child: content,
)
```

Si aquí estás sacando colores de un `ColorScheme` de Material 3, los roles (`surface`, `surfaceContainerHigh`, `primaryContainer`) importan para el contraste tanto en modo claro como oscuro; consulta [cómo establecer el color de acento en una app de Flutter con el ColorScheme de Material 3](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) para saber a qué rol recurrir.

### AnimatedContainer tiene exactamente la misma regla

`AnimatedContainer` comparte el contrato del constructor de `Container`, así que la aserción idéntica se dispara ahí. La trampa es peor porque la gente anima un color interpolando el `color` de nivel superior mientras una `decoration` estática provee el borde:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: AnimatedContainer with both color and decoration.
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  color: _selected ? Colors.blue : Colors.grey,
  decoration: BoxDecoration(border: Border.all()),
)
```

Anima el color dentro del `BoxDecoration`, y `AnimatedContainer` interpolará toda la decoración por ti, borde incluido:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  decoration: BoxDecoration(
    color: _selected ? Colors.blue : Colors.grey,
    border: Border.all(),
  ),
)
```

`BoxDecoration` implementa la interpolación necesaria para que el borde y el color se animen juntos, algo que la versión de dos argumentos nunca podría hacer.

### Un condicional que deja ambos establecidos

La versión más desagradable compila bien y solo se lanza en una rama. Alguien añade un borde condicionalmente pero olvida mover el color:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG on the highlighted branch only.
Container(
  color: Colors.white,
  decoration: isHighlighted
      ? BoxDecoration(border: Border.all(color: Colors.amber, width: 2))
      : null,
  child: child,
)
```

Cuando `isHighlighted` es false, `decoration` es `null` y la aserción pasa, así que el código parece correcto en cada captura de pantalla hasta que un usuario resalta una fila. Empuja el color a ambas ramas (o a un solo `BoxDecoration` construido con un borde condicional) para que no haya ningún estado en el que ambos sean no nulos.

## Encontrar qué Container es el culpable en un árbol grande

El mensaje de la aserción nombra el archivo y la línea dentro de `container.dart`, no tu widget. Para encontrar tu `Container` infractor:

1. Lee la traza de pila debajo de la aserción. El primer frame en tu propio código (un archivo bajo `lib/`) es el método `build` que creó el `Container` incorrecto. Flutter imprime "The relevant error-causing widget was" seguido de tu widget y su ubicación de origen en la mayoría de las versiones.
2. Si la traza no ayuda porque el `Container` se construye en un bucle o en un builder compartido, busca en tu proyecto `color:` y `decoration:` que aparezcan juntos. La regex `Container\([^)]*color:[^)]*decoration:` captura la mayoría de los casos de una sola línea; los de varias líneas necesitan un escaneo manual de la tarjeta o ficha compartida.
3. Como esto se lanza en tiempo de construcción, el hot reload lo hace aflorar al instante. Añade el borde o la decoración, guarda, y si el frame se pone rojo tienes el widget correcto en pantalla.

Este comportamiento en tiempo de construcción es lo opuesto a las aserciones de layout como [RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/), que solo aparecen una vez que se ejecuta el pipeline de layout y a menudo apuntan a varios widgets de distancia de la causa real.

## Trampas y errores parecidos

- **`BoxDecoration.color` frente a `Container.color` y el orden de pintado.** No son idénticos en todos los casos. `Container.color` pinta detrás del hijo pero también detrás de cualquier `decoration` si se permitiera una; `BoxDecoration.color` pinta como parte de la decoración, que se sitúa detrás de `foregroundDecoration`. Para un relleno plano el resultado es el mismo píxel, pero si además usas `foregroundDecoration`, la disposición en capas importa.
- **Los splashes de `Ink` e `InkWell` desaparecen sobre un Container con color.** Si le diste a un `Container` un `color` y luego envolviste un hijo en `InkWell`, el efecto de onda pinta detrás del color del `Container` y se desvanece. La solución es el mismo movimiento: elimina `Container.color` y usa un widget `Ink` con una `decoration`, o un `Material` con un color, para que la capa de tinta se sitúe encima del relleno.
- **`The following assertion was thrown building` con un mensaje diferente.** Si tu error menciona `Incorrect use of ParentDataWidget` en lugar de color y decoration, ese es un error de contrato de layout distinto; consulta [Incorrect use of ParentDataWidget: Expanded debe estar dentro de Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/).
- **Las compilaciones de release lo ocultan, no lo arreglan.** Como la comprobación es un `assert`, una compilación de release la elimina y pinta usando el argumento que el constructor haya almacenado. No hagas envíos suponiendo que "funciona en release". Funciona por accidente, y la próxima actualización del SDK puede cambiar qué argumento gana.
- **`DecoratedBox` lanza el mismo error conceptual de forma distinta.** `DecoratedBox` no tiene ningún argumento `color`, solo `decoration`, así que no puedes toparte con esta aserción ahí. Si estabas usando `DecoratedBox` y querías un color, siempre va en el `BoxDecoration`.

## Relacionado

- [Solución: A RenderFlex overflowed en Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/) es la otra aserción con la que los principiantes se topan primero al construir layouts de tarjetas y filas.
- [Solución: RenderBox was not laid out en Flutter](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) cubre un error en tiempo de layout que, a diferencia de este, apunta lejos de la causa real.
- [Solución: Incorrect use of ParentDataWidget: Expanded debe estar dentro de Flex](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) es una aserción de contrato de construcción hermana que vale la pena reconocer.
- [Cómo establecer el color de acento en una app de Flutter con el ColorScheme de Material 3](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) explica qué rol del `ColorScheme` alimentar en tu `BoxDecoration.color`.

## Fuentes

- [Constructor Container.new -- API de Flutter](https://api.flutter.dev/flutter/widgets/Container/Container.html), que documenta el atajo `color` y la regla de "cannot provide both" textualmente.
- [Referencia de la clase BoxDecoration](https://api.flutter.dev/flutter/painting/BoxDecoration-class.html), la decoración que posee `color`, `border`, `borderRadius`, `gradient` y `boxShadow`.
- [flutter/flutter issue #119484](https://github.com/flutter/flutter/issues/119484), el issue de seguimiento que discute cómo el mensaje de error podría ser más claro.
- [flutter/flutter issue #31312](https://github.com/flutter/flutter/issues/31312), el reporte original que muestra la aserción exacta y la traza de pila de `container.dart`.

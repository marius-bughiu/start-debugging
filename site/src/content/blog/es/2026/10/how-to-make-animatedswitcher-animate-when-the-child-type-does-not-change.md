---
title: "Cómo hacer que AnimatedSwitcher anime cuando el tipo del widget hijo no cambia en Flutter"
description: "AnimatedSwitcher solo hace una transición cuando Widget.canUpdate indica que el nuevo hijo es un widget distinto, así que de Text a Text sin key simplemente se actualiza en su lugar. Aquí está la solución de una línea, dónde debe ir la key, por qué UniqueKey es una trampa, el error de dirección del slide causado por un transitionBuilder estático y el salto de layout del Stack por defecto, todo verificado con widget tests en Flutter 3.44.8."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Respuesta corta:** dale al hijo directo de `AnimatedSwitcher` una key que cambie cada vez que cambie el contenido, normalmente una `ValueKey` construida a partir de los datos que muestras: `Text('$count', key: ValueKey<int>(count))`. `AnimatedSwitcher` decide si ejecuta una transición con `Widget.canUpdate`, que compara solo `runtimeType` y `key`. Dos widgets `Text` sin key son "el mismo widget" para el framework, así que el anterior se actualiza en su lugar y nada se anima. Todo lo que sigue se verificó con widget tests en Flutter 3.44.8 (Dart 3.12.2), y el código fuente de `_AnimatedSwitcherState` es idéntico byte a byte en la rama `stable` actual.

El resto de este artículo muestra la línea exacta del framework que provoca esto, un caso mínimo reproducible con la salida de los tests, dónde debe ir la key (una key un nivel más abajo no hace nada), por qué `UniqueKey` es la solución equivocada y tres problemas que aparecen justo después de lograr la transición: transiciones de deslizamiento que se mueven en la dirección incorrecta, contenido que salta al centro e hijos que pierden su estado.

## La única comparación que hace AnimatedSwitcher

`AnimatedSwitcher` es un `StatefulWidget` que mantiene una "entrada actual" (el hijo más su propio `AnimationController`) y un conjunto de entradas salientes que aún se están desvaneciendo. Cuando el padre se reconstruye con un nuevo `child`, `didUpdateWidget` ejecuta esta comprobación, tomada directamente de `packages/flutter/lib/src/widgets/animated_switcher.dart`:

```dart
// Flutter 3.44.8, _AnimatedSwitcherState.didUpdateWidget
final hasNewChild = widget.child != null;
final hasOldChild = _currentEntry != null;
if (hasNewChild != hasOldChild ||
    hasNewChild && !Widget.canUpdate(widget.child!, _currentEntry!.widgetChild)) {
  // Child has changed, fade current entry out and add new entry.
  _childNumber += 1;
  _addEntryForNewChild(animate: true);
} else if (_currentEntry != null) {
  // Child has been updated. ... keep the key from the previous transition
  // so that we update the transition instead of replacing it.
  _currentEntry!.widgetChild = widget.child!;
  _updateTransitionForEntry(_currentEntry!);
}
```

Y `Widget.canUpdate` es una sola línea:

```dart
// Flutter 3.44.8, framework.dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

Fíjate en lo que no se compara: el texto, el color, la URL de la imagen, ningún campo. Una transición se inicia exactamente en tres casos: el hijo pasa de `null` a no nulo, pasa de no nulo a `null`, o el nuevo hijo tiene un tipo en runtime distinto o una key distinta. Si pasas de `Text('1')` a `Text('2')`, ninguno se cumple, así que la rama `else` coloca el widget en la entrada existente y el usuario ve un cambio instantáneo. La documentación de la API lo dice claramente, pero el síntoma ("mi AnimatedSwitcher no hace nada") rara vez lleva a la gente a mirar ahí. Si quieres la teoría general detrás de esta comparación, la cubrí en [qué es una Key de Flutter y cuándo omitirla causa errores](/es/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/).

## Un caso mínimo que puedes ejecutar como test

La forma más rápida de ver si se está ejecutando una transición es contar los widgets `FadeTransition` a mitad de la animación. El `transitionBuilder` por defecto envuelve cada entrada, entrante y saliente, en un `FadeTransition`, así que uno significa "sin transición" y dos significa "fundido cruzado en curso".

```dart
// Flutter 3.44.8, Dart 3.12.2 -- test/switcher_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: child,
      ),
    );

int fades(WidgetTester t) => find.byType(FadeTransition).evaluate().length;

void main() {
  testWidgets('no key: same type is updated in place', (t) async {
    await t.pumpWidget(host(const Text('1')));
    await t.pumpWidget(host(const Text('2')));
    await t.pump(const Duration(milliseconds: 100));
    print('no key -> ${fades(t)}'); // no key -> 1
  });

  testWidgets('ValueKey on the direct child animates', (t) async {
    await t.pumpWidget(host(const Text('1', key: ValueKey(1))));
    await t.pumpWidget(host(const Text('2', key: ValueKey(2))));
    await t.pump(const Duration(milliseconds: 100));
    print('ValueKey -> ${fades(t)}'); // ValueKey -> 2
    await t.pumpAndSettle();
    print('settled -> ${fades(t)}'); // settled -> 1
  });
}
```

Sin key hay un `FadeTransition` a los 100 ms de una animación de 300 ms, lo que significa que no existe animación. Con `ValueKey` hay dos, y tras `pumpAndSettle` la entrada saliente ha sido eliminada y descartada.

## Aplicar la solución en un widget real

Aquí está la misma solución en un widget de aplicación. La key va en el widget que pasas como `child`, y se deriva del valor que debe disparar la transición:

```dart
// Flutter 3.44.8, Dart 3.12.2
class Counter extends StatefulWidget {
  const Counter({super.key});
  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (child, animation) =>
              ScaleTransition(scale: animation, child: child),
          child: Text(
            '$_count',
            key: ValueKey<int>(_count), // the whole fix
            style: Theme.of(context).textTheme.displayMedium,
          ),
        ),
        FilledButton(
          onPressed: () => setState(() => _count++),
          child: const Text('Increment'),
        ),
      ],
    );
  }
}
```

El mismo patrón cubre todos los casos de "mismo tipo, distinto contenido" con los que se topa la gente:

- Cambiar imágenes: `Image.network(url, key: ValueKey(url))`.
- Cambiar íconos: `Icon(isPlaying ? Icons.pause : Icons.play_arrow, key: ValueKey(isPlaying))`.
- Cambiar entre estados de un modelo: `key: ValueKey(user.id)` en una tarjeta de perfil, de modo que editar al mismo usuario no anima pero seleccionar un usuario distinto sí.
- Ramas de carga, error y datos que casualmente devuelven el mismo tipo de widget (por ejemplo tres widgets `Center`): dales `ValueKey('loading')`, `ValueKey('error')`, `ValueKey('data')`. Si tu estado asíncrono viene de Riverpod, esto combina de forma natural con [mostrar estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

Elegir qué va en la key es elegir cuándo se dispara la animación. Una key construida con `count` anima en cada incremento. Una key construida con `count ~/ 10` anima solo cuando cambia la cifra de las decenas, mientras que el texto interno se sigue actualizando en su lugar.

## La key tiene que estar en el hijo directo

`canUpdate` solo mira `widget.child`, el widget que le pasas directamente a `AnimatedSwitcher`. Una key en algo anidado dentro es invisible para esa comparación:

```dart
// Flutter 3.44.8 -- does NOT animate
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: Padding(
    padding: const EdgeInsets.all(8),
    child: Text('$_count', key: ValueKey<int>(_count)), // too deep
  ),
)
```

En mi test esto produjo un `FadeTransition` a mitad de la animación, igual que sin ninguna key. El `Padding` exterior no tiene key y es del mismo tipo cada vez, así que el switcher lo actualiza en su lugar, y el `Text` interior obtiene un elemento nuevo por sí solo sin ninguna transición. Mueve la key al `Padding` (o a cualquiera que sea tu widget de nivel superior, a menudo un `Container`, un `Card` o tu propio `StatelessWidget`) y funciona.

Esto también afecta cuando el hijo es tu propia clase de widget:

```dart
// Flutter 3.44.8
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: StatusBadge(status: status, key: ValueKey(status)),
)
```

Pasar `key` mediante `super.key` en el constructor de `StatusBadge` es suficiente. Poner una key en algo dentro de `StatusBadge.build` no lo es.

## Por qué UniqueKey es la solución equivocada

La primera respuesta que encuentra mucha gente es `key: UniqueKey()`. Hace que el switcher anime, pero anima en cada reconstrucción del padre, no solo cuando cambia el contenido:

```dart
// Flutter 3.44.8, Dart 3.12.2
testWidgets('UniqueKey animates on every rebuild', (t) async {
  await t.pumpWidget(host(Text('1', key: UniqueKey())));
  await t.pumpWidget(host(Text('1', key: UniqueKey()))); // same text
  await t.pump(const Duration(milliseconds: 100));
  print(fades(t)); // 2
});
```

Mismo texto, un fundido cruzado completo. En una pantalla real el padre se reconstruye por motivos ajenos al contenido que se alterna: un cambio de `MediaQuery` cuando se abre el teclado, un cambio de tema, un `setState` no relacionado, un provider que notifica. Cada uno reinicia la transición, y cada uno descarta el elemento y el estado del hijo. El error opuesto es una key constante, como `ValueKey('label')` en un `Text` cuya cadena cambia. Esa key nunca cambia, así que `canUpdate` es verdadero y nada se anima. Mi test confirmó un `FadeTransition` y el nuevo texto mostrado al instante. Deriva siempre la key de los datos.

## Cambios rápidos e hijos nulos

Dos comportamientos que conviene conocer para no confundirlos con errores:

1. Si el hijo cambia otra vez antes de que termine la transición anterior, el switcher no cancela nada. La entrada actual pasa al conjunto de salientes y se invierte, de modo que varios hijos pueden estar desvaneciéndose a la vez. Cambiar de 1 a 2 a 3 en menos de 100 ms dejó tres widgets `FadeTransition` en el árbol. Por esto mismo la misma key puede volver de forma segura: cada transición está envuelta en un `KeyedSubtree` con una key basada en un contador interno (`_childNumber`), así que un hijo nuevo con key `A` nunca se confunde con un hijo saliente que también tenía key `A`.
2. Establecer `child: null` es una forma válida de animar la salida de contenido. `hasNewChild != hasOldChild` dispara la transición, el hijo anterior se desvanece y nada aparece.

## Problema: transiciones de deslizamiento que van en el sentido incorrecto

Una vez que funciona el fundido cruzado, lo siguiente que suelen pedir es un deslizamiento horizontal: el valor nuevo entra desde la derecha, el anterior sale hacia la izquierda. La versión ingenua desliza ambos hijos desde y hacia la derecha, porque el controlador del hijo saliente simplemente corre en reversa sobre el mismo tween. El truco estándar es comprobar en `transitionBuilder` si el hijo que se está envolviendo es el actual:

```dart
// Flutter 3.44.8, Dart 3.12.2
Widget _slide(Widget child, Animation<double> animation) {
  final incoming = child.key == ValueKey<int>(_count);
  final offset = Tween<Offset>(
    begin: Offset(incoming ? 1 : -1, 0),
    end: Offset.zero,
  ).animate(animation);
  return ClipRect(child: SlideTransition(position: offset, child: child));
}
```

Aquí está la parte sutil. `AnimatedSwitcher` solo vuelve a ejecutar `transitionBuilder` para las entradas salientes cuando `widget.transitionBuilder != oldWidget.transitionBuilder`. Una función literal escrita en línea en `build`, como `transitionBuilder: (c, a) => _slide(c, a)`, crea un objeto closure nuevo en cada build, así que la comparación es verdadera, todas las entradas se reconstruyen con el `_count` más reciente y el hijo anterior se marca correctamente como saliente. Un tear-off de método como `transitionBuilder: _slide`, o un builder guardado en un campo, puede resultar igual entre builds, de modo que la entrada saliente conserva la transición con la que se construyó cuando era entrante. Ejecuté ambas variantes y leí los offsets de `SlideTransition` a mitad de camino:

```text
inline closure:   child 1 dx=-0.50   child 2 dx=0.50
stored function:  child 1 dx= 0.50   child 2 dx=0.50
```

Con la función almacenada, el hijo anterior se desliza de vuelta hacia la derecha, encima del nuevo. Si escribes un `transitionBuilder` que depende de la dirección, pásalo como un closure en línea (o asegúrate de que sea un objeto nuevo cada vez que cambie la key), y agrega un test como el anterior para que una refactorización a un tear-off no lo rompa silenciosamente.

## Problema: el contenido salta al centro o el tamaño cambia de golpe

El `layoutBuilder` por defecto coloca los hijos salientes y el hijo actual en un `Stack` con `alignment: Alignment.center`. Dos efectos secundarios visibles:

- El contenido alineado a la izquierda, por ejemplo una etiqueta en un `Row` o el subtítulo de un `ListTile`, salta al centro mientras se ejecuta la transición.
- El `Stack` es tan grande como el hijo más grande, así que cuando una cadena larga se reemplaza por una corta, el espacio se reduce solo después de que el hijo anterior desaparece.

Ambos se resuelven con un `layoutBuilder` personalizado, opcionalmente envuelto en `AnimatedSize` para suavizar el cambio de tamaño:

```dart
// Flutter 3.44.8, Dart 3.12.2
AnimatedSize(
  duration: const Duration(milliseconds: 200),
  alignment: Alignment.centerLeft,
  child: AnimatedSwitcher(
    duration: const Duration(milliseconds: 200),
    layoutBuilder: (currentChild, previousChildren) => Stack(
      alignment: Alignment.centerLeft,
      children: [
        ...previousChildren,
        if (currentChild != null) currentChild,
      ],
    ),
    child: Text(status, key: ValueKey(status)),
  ),
)
```

Mantén `previousChildren` antes de `currentChild` para que el widget entrante se pinte encima, igual que en el comportamiento por defecto.

## Problema: el estado del hijo se descarta

Una key distinta significa un elemento nuevo. Cualquier `State` debajo del hijo alternado, como el controlador de un `TextField` creado en `initState`, una posición de scroll o un indicador de expansión, se crea desde cero para el hijo entrante. En mi test, el elemento antes y después de un cambio de key era un objeto distinto. Normalmente es lo que quieres para "mostrar otra cosa", pero es la herramienta equivocada para "animar una propiedad de la misma cosa". Si el usuario está escribiendo en un campo y le pones como key el texto, cada pulsación recrea el campo y pierde el foco.

Para cambios de propiedades en el mismo widget, usa en su lugar una animación implícita: `AnimatedDefaultTextStyle`, `AnimatedContainer`, `AnimatedOpacity` o `TweenAnimationBuilder` para un valor arbitrario. Estos conservan el elemento e interpolan la propiedad. `AnimatedSwitcher` es para reemplazar contenido, y la key es la forma de decirle que el contenido fue reemplazado. Si necesitas que la transición cruce pantallas en lugar de ocurrir dentro de una, mira [una animación Hero entre dos pantallas](/es/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) o [las transiciones de página personalizadas](/es/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/).

## Lista de comprobación cuando AnimatedSwitcher no hace nada

1. Pon una key en el widget que pasas directamente como `child`, no en algo dentro de él.
2. Deriva la key de los datos que deben disparar la transición, normalmente `ValueKey(value)`, nunca un `UniqueKey()` creado en `build`.
3. Comprueba que la key realmente cambia: una `ValueKey('x')` constante equivale a no tener key para este propósito.
4. Asegúrate de que el propio `AnimatedSwitcher` no se recree: si un ancestro cambia de tipo o de key, el estado del switcher se reconstruye desde cero y el primer hijo se muestra sin animación (`initState` llama a `_addEntryForNewChild(animate: false)`).
5. Si usas un `transitionBuilder` que depende de la dirección, pásalo como un closure en línea para que las entradas salientes se reconstruyan.
6. Corrige la alineación y el tamaño con un `layoutBuilder` personalizado y `AnimatedSize`.

### Lee a continuación

- [¿Qué es una Key de Flutter y cuándo causa errores omitirla?](/es/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Cómo mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Cómo agregar una animación Hero entre dos pantallas en Flutter](/es/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)
- [Migrar las transiciones de página personalizadas tras la reorganización de los page transition builders de Flutter](/es/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/)
- [Solución: setState() o markNeedsBuild() llamado durante build en Flutter](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)

## Fuentes

- [AnimatedSwitcher class, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher-class.html)
- [AnimatedSwitcher.layoutBuilder, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher/layoutBuilder.html)
- [Widget.canUpdate, Flutter API docs](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [animated_switcher.dart on the stable branch, flutter/flutter](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/widgets/animated_switcher.dart)
- [Implicit animations, Flutter docs](https://docs.flutter.dev/codelabs/implicit-animations)

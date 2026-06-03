---
title: "Solución: A TextEditingController was used after being disposed en Flutter"
description: "Este fallo significa que el código usó un controller después de ejecutar dispose(). Protege las callbacks asíncronas con una comprobación de mounted y nunca liberes un controller que no es tuyo."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

Algo leyó o escribió en un `TextEditingController` después de que su `dispose()` ya se hubiera ejecutado. El culpable habitual es una callback asíncrona (un `Future.then`, un `await`, un `Timer` o un listener de stream) que se completa después de que el usuario abandonó la pantalla y el `State` fue destruido. Protege el código posterior al await con `if (!mounted) return;` antes de tocar el controller. La otra causa común es la confusión de propiedad: un widget hijo liberó un controller que recibió pero que no le pertenece. Esta guía usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

El error no es exclusivo de `TextEditingController`. El mismo mensaje aparece con cualquier `ChangeNotifier` (`ScrollController`, `FocusNode`, `AnimationController`, `ValueNotifier`, el modelo de un Provider) porque la aserción vive en el propio `ChangeNotifier`. El tipo en tiempo de ejecución del mensaje solo te indica cuál de ellos usaste demasiado tarde.

## El error en contexto

El mensaje completo que lanza Flutter se ve así:

```
A TextEditingController was used after being disposed.
Once you have called dispose() on a TextEditingController, it can no longer be used.

When the exception was thrown, this was the stack:
#0      ChangeNotifier._debugAssertNotDisposed.<anonymous closure> (package:flutter/src/foundation/change_notifier.dart)
#1      ChangeNotifier._debugAssertNotDisposed (package:flutter/src/foundation/change_notifier.dart)
#2      ChangeNotifier.addListener (package:flutter/src/foundation/change_notifier.dart)
#3      TextEditingController.text= (package:flutter/src/widgets/editable_text.dart)
...
```

El frame de pila justo debajo de los frames de `ChangeNotifier` es la línea de tu código. Nombra la operación que tocó el controller muerto: `text=`, `.text`, `addListener`, `clear()` o `.selection`. Ese frame es donde lo corriges, pero la razón por la que se disparó está antes en el tiempo, cuando `dispose()` se ejecutó antes que esa línea.

## Por qué ocurre

Hay cuatro causas, en orden aproximado de frecuencia.

Una callback asíncrona sobrevivió al widget. Iniciaste un `await`, un `Future.then`, un `Timer` o un `stream.listen` mientras la pantalla estaba viva, el usuario navegó fuera (lo que libera el `State` y el controller) y luego la callback se completó y tocó el controller. Esta es de lejos la causa más común, porque solo falla cuando el momento coincide: pasa siempre que la respuesta es rápida y falla cuando el usuario es veloz o la red es lenta.

Un hijo liberó un controller que no le pertenece. Un padre creó el controller y lo pasó hacia abajo; el hijo llamó a `dispose()` sobre él en su propio `dispose()`. Ahora el padre (o un hermano, o el siguiente rebuild) usa un controller que el hijo ya mató. La propiedad es la inversa del problema de la fuga: libera un controller que no es tuyo y obtienes este fallo, olvida liberar uno que sí es tuyo y obtienes una fuga de memoria.

Una capa de gestión de estado lo liberó. Si el controller vive en un provider `autoDispose` de Riverpod, en un controller de GetX o en un `ChangeNotifier` que el framework destruyó, el widget que aún mantiene una referencia chocará con una instancia liberada. El `autoDispose` de Riverpod es un disparador frecuente: el provider se recalcula o se libera cuando ya nadie lo observa, llevándose el controller, mientras una closure obsoleta sigue apuntando al antiguo.

`didUpdateWidget` liberó el antiguo demasiado pronto. Cuando un controller depende de una propiedad de `widget`, liberas el controller antiguo y creas uno nuevo en la actualización. Si una callback pendiente capturó el controller antiguo, ahora toca una instancia liberada.

El contrato subyacente, según la [documentación de la API ChangeNotifier de Flutter](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html): una vez que se llama a `dispose()`, el objeto queda inservible y cualquier uso posterior lanza en compilaciones de depuración. La aserción se elimina de las compilaciones de release, así que en release el mismo código no falla sino que lee estado obsoleto o nulo. Por eso corriges la causa, no silencias la aserción.

## Una reproducción mínima

Este widget falla cuando abandonas la pantalla antes de que el fetch retorne. Compila y se ejecuta, y pasa cuando la red es rápida.

```dart
// Flutter 3.44, Dart 3.x -- throws "A TextEditingController was used after being disposed".
import 'package:flutter/material.dart';

class SearchBox extends StatefulWidget {
  const SearchBox({super.key});

  @override
  State<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<SearchBox> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prefill();
  }

  Future<void> _prefill() async {
    // Pretend this hits the network and takes ~500ms.
    final lastQuery = await Future.delayed(
      const Duration(milliseconds: 500),
      () => 'flutter dispose error',
    );
    // If the user popped this screen during those 500ms, the State and the
    // controller are already disposed. This line then throws.
    _controller.text = lastQuery;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(controller: _controller);
  }
}
```

Abre esta pantalla y luego ciérrala en menos de medio segundo. Se ejecuta `dispose()`, `_controller.dispose()` mata el controller, el `Future` se completa y `_controller.text = ...` lanza. El fallo depende del momento, que es exactamente por qué sobrevive a la revisión de código y llega a producción.

## La solución, en detalle

Las soluciones están ordenadas según cuánto las recomiendo. Elige la que coincida con tu causa.

### 1. Protege las callbacks asíncronas con mounted (recomendado)

En cada lugar donde un `await` (o cualquier callback diferida) va seguido de código que toca el controller o llama a `setState`, comprueba `mounted` primero. `mounted` es `false` una vez que el `State` ha sido liberado, así que la protección cortocircuita antes de tocar el controller.

```dart
// Flutter 3.44, Dart 3.x -- correct: bail out if the widget is gone.
Future<void> _prefill() async {
  final lastQuery = await Future.delayed(
    const Duration(milliseconds: 500),
    () => 'flutter dispose error',
  );
  if (!mounted) return; // the State (and the controller) may be disposed
  _controller.text = lastQuery;
}
```

La regla: después de cada `await` en un método de `State`, la siguiente línea que toca `this`, el controller o `setState` debe ir precedida de una comprobación de `mounted`. Aquí hay un `await`, así que hay una protección. Si un método tiene dos awaits y toca el controller después de cada uno, necesita dos protecciones. El lint `use_build_context_synchronously` del analizador de Dart detecta la versión de `BuildContext` de este error; trata un controller exactamente igual.

Para un `Timer` o un `stream.listen`, la protección va dentro de la callback:

```dart
// Flutter 3.44, Dart 3.x
_sub = someStream.listen((value) {
  if (!mounted) return;
  _controller.text = value;
});
```

Mejor aún, cancela la suscripción o el timer en `dispose()` para que la callback nunca se dispare tras la destrucción. Cancelar es más limpio que proteger, porque una suscripción protegida pero no cancelada igual despierta, asigna memoria y ejecuta la protección en cada evento de una pantalla que el usuario ya abandonó. Mira el orden de liberación en [la guía sobre liberación de controllers](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

### 2. Corrige la propiedad: no liberes lo que no es tuyo

Si el fallo no es asíncrono, casi siempre es de propiedad. La regla es una línea: quien crea el controller lo libera, y nadie más. Un widget que recibe un controller a través de su constructor nunca debe liberarlo.

```dart
// Flutter 3.44, Dart 3.x
class ParentForm extends StatefulWidget {
  const ParentForm({super.key});
  @override
  State<ParentForm> createState() => _ParentFormState();
}

class _ParentFormState extends State<ParentForm> {
  final _email = TextEditingController(); // parent creates -> parent owns

  @override
  void dispose() {
    _email.dispose(); // owner disposes, exactly once
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => EmailField(controller: _email);
}

class EmailField extends StatelessWidget {
  final TextEditingController controller;
  const EmailField({super.key, required this.controller});

  // Receives the controller. Does NOT dispose it. No dispose() here at all.
  @override
  Widget build(BuildContext context) => TextField(controller: controller);
}
```

Si `EmailField` fuera un `StatefulWidget` y liberara `widget.controller`, el uso posterior de `_email` por parte del padre lanzaría este mismo error. La solución es eliminar esa llamada a `dispose()` del hijo. El error en espejo (el padre olvidando liberar) es una fuga, cubierta en la guía de liberación anterior.

### 3. Deja que la capa de gestión de estado sea la propietaria de la liberación

Cuando un controller se sube a un provider de Riverpod, a un controller de GetX o a cualquier objeto fuera del widget, la liberación se mueve con él. El widget no debe liberar un controller que tomó prestado de un provider, y el `onDispose` (Riverpod) o el `onClose` (GetX) del provider es donde vive ahora la llamada a `dispose()`. Con `autoDispose` de Riverpod, mantén vivo el provider mientras la pantalla lo necesite (usa `ref.keepAlive()` o un provider sin `autoDispose`) para que no se recalcule por debajo de un widget que aún mantiene el controller. Mover la propiedad del ciclo de vida durante una migración de gestión de estado es justo donde esto se rompe en silencio; escribí [migrar una app de Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) como un movimiento deliberado y paso a paso por esa razón.

### 4. Recrea con cuidado en didUpdateWidget

Si un controller depende de una propiedad de `widget` y lo intercambias en `didUpdateWidget`, libera el antiguo y asigna uno nuevo, y asegúrate de que ninguna callback pendiente siga referenciando la instancia antigua:

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(covariant MyField oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (oldWidget.initialText != widget.initialText) {
    _controller.dispose();
    _controller = TextEditingController(text: widget.initialText);
  }
}
```

Cualquier trabajo asíncrono iniciado contra el controller antiguo debe comprobar `mounted` (e idealmente ser cancelado) antes de aterrizar, o escribirá en la instancia liberada que acabas de reemplazar.

## Detalles que muerden y variantes

`setState() called after dispose()`. La misma causa raíz, una aserción distinta. Una callback asíncrona que llama a `setState` tras la destrucción lanza esto en lugar del mensaje del controller, porque `setState` comprueba internamente un estado equivalente a `mounted`. La solución es idéntica: protege con `if (!mounted) return;`. A menudo viaja junto al fallo del controller, ya que la misma callback suele escribir el controller y llamar a `setState`. Mira [setState o markNeedsBuild llamado durante build](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) para el primo de fase de build de esta familia.

`A ScrollController was used after being disposed`, `A FocusNode was used after being disposed`, `An AnimationController was used after being disposed`. La misma aserción, las mismas soluciones. El mensaje nombra el `ChangeNotifier` que tocaste; el diagnóstico (asíncrono tras dispose o propietario equivocado) no cambia.

El fallo solo ocurre a veces. Esa es la firma de la causa asíncrona, no un framework inestable. Una red rápida lo oculta; una red lenta o un usuario veloz lo exponen. No descartes una versión intermitente de este error como ruido. Reprodúcelo añadiendo un retraso artificial antes de la escritura del controller y cerrando la pantalla durante el retraso.

Lanza en los tests pero no en la app. Los widget tests destruyen los widgets de forma agresiva y avanzan los frames de manera determinista, así que una protección de `mounted` faltante que se oculta en una app real aflora de inmediato bajo `testWidgets`. Eso es el test haciendo su trabajo. El equipo de Flutter rastrea una variante de esto en [el issue 98965 de flutter/flutter](https://github.com/flutter/flutter/issues/98965), donde timers pendientes en los tests tocan controllers liberados; la solución allí también es cancelar el timer en `dispose()`.

Reusar un controller entre dos `TextField` en rutas distintas. Un controller es de un solo propietario. Si guardas un `TextEditingController` en un singleton de larga vida y se lo pasas a un campo en la pantalla A y a otro en la pantalla B, liberar una pantalla libera el controller por debajo de la otra. Dale a cada campo su propio controller, o mueve el texto a un estado compartido y deja que cada campo sea propietario de un controller local.

La única disciplina que elimina toda esta clase de bug: un controller tiene exactamente un propietario, ese propietario lo libera exactamente una vez, y cada ruta asíncrona que lo toca está protegida por una comprobación de `mounted` o cancelada antes de la destrucción. Integra eso en tu reflejo de `dispose()` y el error deja de aparecer. Si además quieres detectar el fallo opuesto (controllers que nunca se liberan), el [flujo de trabajo de leak_tracker en la guía de liberación](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) te hará cumplir ambos lados del contrato, y modelar tus datos asíncronos como estado con [estados de carga y error elegantes](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) mantiene las peligrosas escrituras posteriores al await fuera del controller por completo.

## Relacionados

- [Cómo liberar controllers en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) es la imagen en espejo: este fallo es usar un controller liberado, esa guía es olvidar liberar uno.
- [Solución: setState() o markNeedsBuild() llamado durante build en Flutter](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) comparte la solución de la protección de `mounted` para callbacks asíncronas.
- [Cómo manejar errores de red con elegancia en una app de Flutter](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) es de donde suele venir la lentitud de respuesta que dispara este fallo.
- [Cómo mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) mantiene los resultados asíncronos en el estado en lugar de escribirlos directamente en un controller tras un await.

## Fuentes

- [ChangeNotifier, referencia de la API de Flutter](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html) -- donde se define la aserción "used after being disposed".
- [TextEditingController, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html) -- el ciclo de vida del controller y el contrato de `dispose()`.
- [State.mounted, referencia de la API de Flutter](https://api.flutter.dev/flutter/widgets/State/mounted.html) -- el flag que te dice si el controller sigue vivo.
- [Issue 98965 de flutter/flutter](https://github.com/flutter/flutter/issues/98965) -- el error aflorando en widget tests por timers pendientes.

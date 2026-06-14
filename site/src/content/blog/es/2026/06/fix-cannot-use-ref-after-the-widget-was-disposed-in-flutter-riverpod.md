---
title: "Solución: Bad state: Cannot use \"ref\" after the widget was disposed en Flutter Riverpod"
description: "Este fallo significa que se usó un WidgetRef después de que su widget abandonó el árbol, normalmente en una callback asíncrona. Lee lo que necesites antes del await y protege con una comprobación de mounted."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-14
---

Tu código tocó un `WidgetRef` de Riverpod después de que el widget que lo posee fue destruido. El culpable habitual es una callback asíncrona (un `await`, `Future.then`, `Timer` o listener de stream) que se completa después de que el usuario abandonó la pantalla y luego llama a `ref.read`, `ref.watch` o `ref.listen`. La solución es leer todo lo que necesites de `ref` antes del `await` y proteger cualquier trabajo posterior con una comprobación `if (!mounted) return;`. Esta guía usa Flutter 3.44 (estable, mayo de 2026), Dart 3.x y Riverpod 3.0 (lanzado en septiembre de 2025).

Un `WidgetRef` está ligado al ciclo de vida del widget del que proviene. En el momento en que ese widget se elimina del árbol, el ref queda invalidado y cualquier uso posterior lanza una excepción. Esto es intencional: un widget destruido no tiene por qué leer ni escribir providers, y Riverpod prefiere fallar de forma ruidosa antes que filtrar estado en silencio hacia una pantalla que el usuario ya abandonó.

## El error en contexto

El mensaje completo que lanza Riverpod se ve así:

```
Unhandled Exception: Bad state: Cannot use "ref" after the widget was disposed.
#0      ProviderElementBase._assertNotDisposed (package:flutter_riverpod/...)
#1      ConsumerStatefulElement.read (package:flutter_riverpod/src/consumer.dart)
#2      _CheckoutScreenState._submit.<anonymous closure> (package:my_app/checkout_screen.dart:42)
...
```

El frame de tu propio código nombra la línea que tocó el ref muerto: una llamada a `ref.read(...)`, `ref.watch(...)` o `ref.listen(...)`. Ese frame es donde aflora la excepción, pero la razón por la que se disparó es anterior en el tiempo, cuando el widget fue destruido antes de que esa línea se ejecutara.

Hay una variante muy relacionada con un sustantivo ligeramente distinto:

```
Bad state: Cannot use "ref" after the provider was disposed.
```

Esa proviene del `Ref` dentro de un `Notifier` o `AsyncNotifier`, no de un `WidgetRef` en un widget. Misma familia, misma causa raíz, propietario distinto. La versión del widget dice "widget"; la versión del provider dice "provider". La solución difiere un poco, y la sección sobre Notifiers más abajo la cubre.

## Por qué ocurre

Hay cuatro causas, en orden aproximado de frecuencia.

Un `WidgetRef` fue capturado en una callback asíncrona que sobrevivió al widget. Iniciaste un `await`, un `Future.then`, un `Timer` o un `stream.listen` mientras la pantalla estaba viva, el usuario cerró la ruta (lo que destruye el `ConsumerState` e invalida su `ref`), y luego la callback se completó y llamó a `ref.read`. Esta es de lejos la causa más común, porque solo falla cuando la temporización coincide: pasa cada vez que el trabajo esperado es rápido y falla cuando la red es lenta o el usuario es veloz.

Usaste `ref` dentro de `dispose()`. Un `ConsumerState.dispose()` que llama a `ref.read` para hacer limpieza (cancelar una suscripción, vaciar un buffer, notificar a un provider) provoca este error, porque cuando se ejecuta `dispose` el `WidgetRef` ya está destruido. El equipo de Riverpod registra exactamente esta forma en el [issue 4142](https://github.com/rrousselGit/riverpod/issues/4142): el widget aún parece montado, pero el ref del elemento ya no está. La limpieza debe ocurrir a través del propio `ref.onDispose` del provider, no del `dispose` del widget.

Almacenaste un `WidgetRef` en un objeto de larga vida. Un controller, servicio o clase de "lógica" que conserva el `ref` que recibió en `build` mantendrá una referencia obsoleta. Cuando el widget se reconstruye o se va, ese ref almacenado apunta a un elemento destruido. Un `WidgetRef` no es un handle duradero; solo es válido para la instancia de widget que lo posee.

Un provider fue destruido durante una brecha asíncrona dentro de un Notifier. En un Notifier `autoDispose`, haces `await` de algo, el provider pierde su último listener (o es invalidado) durante la brecha, Riverpod lo destruye y la línea posterior al `await` lee `ref`. Esta es la variante "after the provider was disposed". Riverpod 3.0 la hizo menos frecuente al pausar los listeners en la reconstrucción en lugar de eliminarlos de inmediato, pero un provider `autoDispose` que realmente pierde todos sus watchers a mitad del await sigue destruyéndose. El tema se discute en el [issue 4096 de riverpod](https://github.com/rrousselGit/riverpod/issues/4096).

El contrato subyacente, según las notas de la versión Riverpod 3.0: "Refs and Notifiers can no longer be interacted with after they have been disposed". Riverpod 3.0 lanza una excepción ante cualquier interacción posterior a la destrucción en lugar de tolerarla, y por eso el código que antes fallaba en silencio en 2.x ahora se cae ruidosamente. Eso es el framework haciendo su trabajo.

## Un repro mínimo

Esta pantalla se cae cuando la abandonas antes de que el envío se complete. Compila y se ejecuta, y pasa cada vez que la red es rápida.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- throws "Cannot use \"ref\" after the widget was disposed".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final cartProvider = NotifierProvider<CartNotifier, int>(CartNotifier.new);

class CartNotifier extends Notifier<int> {
  @override
  int build() => 3;
  void clear() => state = 0;
}

class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key});

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  Future<void> _submit() async {
    // Pretend this posts the order and takes ~800ms.
    await Future.delayed(const Duration(milliseconds: 800));
    // If the user popped this screen during those 800ms, the ConsumerState and
    // its WidgetRef are already disposed. This line then throws.
    ref.read(cartProvider.notifier).clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: _submit,
          child: const Text('Place order'),
        ),
      ),
    );
  }
}
```

Toca "Place order" y luego cierra la pantalla antes de 800 milisegundos. El `ConsumerState` se destruye, su `ref` se invalida, el `Future` se completa y `ref.read(cartProvider.notifier)` lanza la excepción. El fallo depende de la temporización, que es justamente por lo que sobrevive a la revisión de código y llega a producción.

## La solución, en detalle

Las soluciones están ordenadas según cuánto las recomiendo. Elige la que coincida con tu causa.

### 1. Lee antes del await, protege el resto con mounted (recomendado)

Dos reglas cubren casi todas las apariciones del lado del widget. Primero, resuelve todo lo que necesites de `ref` antes del `await`, mientras el widget está garantizado vivo. Segundo, después del `await`, comprueba `mounted` antes de tocar el árbol, llamar a `setState` o hacer cualquier otra llamada a `ref`.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- correct.
Future<void> _submit() async {
  // Resolve the notifier BEFORE the await, while ref is still valid.
  final cart = ref.read(cartProvider.notifier);

  await Future.delayed(const Duration(milliseconds: 800)); // post the order

  if (!mounted) return; // the ConsumerState (and its WidgetRef) may be gone
  cart.clear();
}
```

`cart` es una referencia a un objeto plano (el notifier); no queda obsoleta cuando el widget se destruye, así que llamar a `cart.clear()` después del await es seguro. La comprobación de `mounted` evita que también manejes la UI (un `setState`, un `Navigator.push`, una llamada a `ScaffoldMessenger`) sobre un widget muerto. `mounted` aquí es el `State.mounted` estándar, que `ConsumerState` expone como cualquier otro `State`.

La regla es la misma que arregla los fallos de destrucción de controllers: después de cada `await` en un método de `State`, la siguiente línea que toque `this`, `ref` o el árbol debe ir precedida de una comprobación de `mounted`. El lint del analizador de Dart `use_build_context_synchronously` detecta la versión con `BuildContext` de este error; trata a `ref` exactamente igual. La misma disciplina aparece en la [solución para TextEditingController usado después de ser destruido](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/), porque es la misma clase de bug con un objeto distinto.

### 2. En un Notifier, comprueba ref.mounted después de la brecha asíncrona

Si el fallo es la variante "after the provider was disposed", estás dentro de un `Notifier` o `AsyncNotifier`, no de un widget. Riverpod 3.0 agregó `Ref.mounted`, el equivalente del lado del provider de `BuildContext.mounted`. Lee las dependencias antes del await y luego condiciona la escritura de estado a `ref.mounted`.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0
class OrdersNotifier extends AsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => _repo().fetch();

  OrderRepository _repo() => ref.read(orderRepositoryProvider);

  Future<void> refresh() async {
    final repo = _repo(); // read deps before the gap
    final next = await AsyncValue.guard(repo.fetch);

    if (!ref.mounted) return; // the provider may have been disposed mid-fetch
    state = next;
  }
}
```

Antes de Riverpod 3.0 no existía `ref.mounted`, y la solución alternativa común era un pequeño mixin que activa una bandera en `ref.onDispose`. En 3.0 puedes borrar ese mixin: `ref.mounted` es la comprobación soportada. Asignar `state` en un notifier destruido es lo que lanza la excepción, así que la protección va justo antes de la asignación. Esta es la misma forma que mantiene seguros los [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) a través de una brecha asíncrona.

### 3. No almacenes un WidgetRef en una clase de lógica

Si el fallo no es asíncrono, a menudo es un ref almacenado. Un `WidgetRef` pertenece a un solo widget y muere con él, así que un controller o servicio que lo conserva acabará desreferenciando un cadáver. Mueve la lógica a un Notifier y deja que use el `Ref` siempre vivo del provider.

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- the logic owns a durable Ref, not a WidgetRef.
final sessionProvider = NotifierProvider<SessionNotifier, Session?>(SessionNotifier.new);

class SessionNotifier extends Notifier<Session?> {
  @override
  Session? build() => null;

  Future<void> signOut() async {
    await ref.read(authProvider).signOut(); // ref here is the provider's Ref
    if (!ref.mounted) return;
    state = null;
  }
}
```

Los widgets entonces llaman a `ref.read(sessionProvider.notifier).signOut()` desde un manejador de eventos, y el trabajo de larga duración vive detrás de un `Ref` que Riverpod mantiene vivo mientras el provider esté en uso. El widget nunca tiene que sobrevivir a su propio `ref`. Mover la propiedad del ciclo de vida fuera de los widgets y hacia los Notifiers es justamente la forma sobre la que se construye una [migración de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/), y es una de las razones por las que [Riverpod es la opción por defecto de gestión de estado en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

### 4. Nunca uses ref dentro del dispose() del widget

La limpieza que necesita un provider no pertenece a `ConsumerState.dispose()`, porque para entonces el `WidgetRef` ya está invalidado. Hay dos hogares correctos para ella. Si el recurso es propiedad de un provider, registra la limpieza con `ref.onDispose` dentro de ese provider, donde se ejecuta cuando el provider se destruye:

```dart
// Flutter 3.44, Dart 3.x, Riverpod 3.0 -- cleanup lives with the provider, not the widget.
final socketProvider = NotifierProvider<SocketNotifier, void>(SocketNotifier.new);

class SocketNotifier extends Notifier<void> {
  late final WebSocketChannel _channel;

  @override
  void build() {
    _channel = WebSocketChannel.connect(Uri.parse('wss://example.com'));
    ref.onDispose(_channel.sink.close); // runs when the provider goes away
  }
}
```

Si realmente debes hacer algo en el desmontaje del widget, captura el objeto plano (el notifier, la suscripción, el valor) en `initState` o `didChangeDependencies` y guárdalo en un campo, luego usa ese campo en `dispose()`. No llames a `ref.read` desde el propio `dispose`.

## Gotchas y variantes

`Cannot use "ref" after the provider was disposed`. El gemelo del lado del Notifier de este error, cubierto por la solución 2 de arriba. Si el frame del stack está dentro de un `Notifier`/`AsyncNotifier` en lugar de un `ConsumerState`, quieres `ref.mounted`, no `State.mounted`. Los dos mensajes difieren en una palabra y esa palabra te dice qué comprobación usar.

`ref.read` en `onPressed` funciona, `ref.read` después de `await` en el mismo manejador no. La parte síncrona de un manejador de eventos se ejecuta mientras el widget está vivo, así que un `ref.read` simple al inicio de `onPressed` está bien. Solo el código después de un `await` puede aterrizar sobre un widget destruido. La línea divisoria es el primer `await`, no el manejador.

El fallo solo ocurre a veces. Esa es la firma de la causa asíncrona, no de un framework inestable. Un backend rápido lo oculta; uno lento o un usuario veloz lo exponen. Reprodúcelo de forma determinista agregando un `Future.delayed` artificial antes de la llamada a `ref` y cerrando la pantalla durante el retraso, exactamente como hace el repro de arriba.

Empezó tras actualizar a Riverpod 3.0. Riverpod 3.0 lanza excepción ante la interacción posterior a la destrucción donde 2.x a veces la toleraba. El código que "funcionaba" antes ya estaba tocando un ref destruido; 3.0 sacó a la luz un bug latente en lugar de introducir uno. Las notas de la versión afirman con claridad que los refs y notifiers ya no pueden usarse después de ser destruidos. Arregla el acceso, no vuelvas a fijar la versión 2.x para ocultarlo.

`ConsumerWidget` (sin estado) provocando esto. Un `ConsumerWidget` no tiene `mounted`, porque no tiene `State`. Si capturas su `ref` en una callback que sobrevive al widget, pasa a un `ConsumerStatefulWidget` para tener una bandera `mounted` con la que protegerte, o empuja el trabajo asíncrono a un Notifier (solución 3) para que el widget nunca conserve el ref más allá de su propia vida.

`use_build_context_synchronously` no marca `ref`. El lint del analizador que detecta un `BuildContext` usado después de un await no tiene equivalente integrado para `WidgetRef`. Analizadores estáticos como DCM y el conjunto de lints de Riverpod 3.0 agregan reglas para ello (usar ref y state de forma síncrona), y vale la pena activarlos, pero de fábrica el compilador no te avisará. Trata cada `ref` después de un `await` como sospechoso igual que tratas a `context`.

La única disciplina que elimina toda esta clase de bug: un `WidgetRef` solo es válido dentro del cuerpo síncrono del widget que lo posee, así que lee lo que necesites antes de cualquier `await`, protege todo lo posterior con `mounted` (widgets) o `ref.mounted` (Notifiers), y mantén la lógica duradera en providers en lugar de en widgets que van y vienen. Integra esto en tu reflejo de manejadores asíncronos y el error deja de aparecer. Es el mismo reflejo de protección con `mounted` que arregla el [error setState o markNeedsBuild llamado durante build](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/), y la temporización de respuesta lenta que lo dispara suele rastrearse hasta [cómo maneja la app los errores de red](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Relacionados

- [Solución: A TextEditingController was used after being disposed en Flutter](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) es el mismo fallo posterior a la destrucción para controllers, con la misma solución de protección con mounted.
- [Cómo mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) mantiene los resultados asíncronos en el estado de un Notifier, fuera de la peligrosa ruta posterior al await.
- [Solución: setState() or markNeedsBuild() called during build en Flutter](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) comparte la disciplina de protección con mounted para callbacks asíncronas.
- [Cómo migrar una app de Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) muestra cómo mover la lógica a Notifiers que poseen un Ref duradero.
- [Provider vs Riverpod vs Bloc para la gestión de estado en Flutter en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) cubre por qué el ciclo de vida en manos del Notifier es el valor por defecto moderno.

## Fuentes

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- presenta `Ref.mounted` y la regla "refs and notifiers can no longer be interacted with after they have been disposed".
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- sobre la vida de `WidgetRef` frente al `Ref` de un provider.
- [rrousselGit/riverpod issue 4142](https://github.com/rrousselGit/riverpod/issues/4142) -- el error lanzado al usar `ref` en la callback `dispose` de un widget.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- usar `ref` en un Notifier después de una brecha asíncrona, y la solución de pausa de listeners en 3.0.
- [Comprobar si un AsyncNotifier está montado, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- el patrón `ref.mounted` en Riverpod 3.0 y el mixin heredado de 2.x.

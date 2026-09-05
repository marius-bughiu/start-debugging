---
title: "ref.watch vs ref.read en Riverpod: cuál es la diferencia y cuándo uso cada uno"
description: "ref.watch se suscribe y reconstruye, ref.read lee una vez y nunca reconstruye. Usa watch en cada método build y read solo dentro de callbacks de eventos. Aquí está la matriz de decisión, el código fuente de ambos métodos en flutter_riverpod 3.4.3 y los cuatro fallos silenciosos: watch en un callback, read en el cuerpo de un provider, read sobre un provider autoDispose y read usado como optimización."
pubDate: 2026-09-05
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "es"
translationOf: "2026/09/ref-watch-vs-ref-read-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-09-05
---

`ref.watch` registra una suscripción, `ref.read` no. Esa única diferencia decide todo lo demás. Usa `ref.watch` dentro de los métodos `build`, tanto el `build` de un `ConsumerWidget` como el `build` de un provider o un `Notifier`, y usa `ref.read` dentro de código que se ejecuta una sola vez en reacción a un evento: `onPressed`, `onTap`, el callback de un `Timer`, un método de mutación de un `Notifier`. La elección no es un compromiso de rendimiento, es una regla sobre el lugar de la llamada: el código que se vuelve a ejecutar cuando cambia el estado debe usar watch, el código que se ejecuta exactamente una vez debe usar read. Todo lo que sigue está verificado contra `riverpod` y `flutter_riverpod` 3.4.3 (publicados el 2026-09-03) en Flutter 3.47.2 stable con Dart 3.13.2, más `riverpod_lint` 3.1.9.

## La matriz de decisión

| | `ref.watch` | `ref.read` |
| --- | --- | --- |
| Registra una suscripción | sí | no |
| Reconstruye a quien llama cuando cambia el valor | sí | nunca |
| Mantiene vivo un provider `autoDispose` | sí | no |
| Correcto dentro de `build` | sí, es el único lugar | casi siempre es un bug |
| Correcto dentro de `onPressed` / `onTap` / timers | no | sí, es el único lugar |
| Correcto dentro de `initState` | no | sí, para una siembra puntual |
| Correcto dentro de un método de mutación de `Notifier` | no | sí |
| Se pausa cuando el widget sale de pantalla (`TickerMode` de Riverpod 3) | sí | no aplica |
| Notificaciones filtradas por `==` | sí | no aplica |
| Lanza error si lo llamas en el lugar equivocado | no, falla en silencio | no |
| Herramienta para reducir reconstrucciones | `.select` | no es esta |

Las dos filas que más tiempo de depuración cuestan son las dos últimas. No hay ninguna protección en tiempo de ejecución en ninguno de los dos métodos, y `ref.read` no es la forma de recortar reconstrucciones.

## Los dos métodos viven en dos clases distintas

Riverpod expone `watch` y `read` dos veces, en dos tipos sin relación entre sí, y las implementaciones son realmente distintas.

`WidgetRef` es lo que te da un `ConsumerWidget`, un builder de `Consumer` o un `ConsumerState`. Su implementación vive en `ConsumerStatefulElement`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> target) {
  _assertNotDisposed();
  return _dependencies
          .putIfAbsent(target, () {
            final oldDependency = _oldDependencies?.remove(target);
            if (oldDependency != null) {
              return oldDependency;
            }
            final sub = container.listen<StateT>(
              target,
              (_, _) => markNeedsBuild(),
            );
            _applyTickerMode(sub);
            return sub;
          })
          .readSafe()
          .valueOrProviderException
      as StateT;
}

@override
StateT read<StateT>(ProviderListenable<StateT> provider) {
  _assertNotDisposed();
  return ProviderScope.containerOf(this, listen: false).read(provider);
}
```

`watch` guarda una `ProviderSubscription` en un mapa `_dependencies` propio de cada element, cuyo listener llama a `markNeedsBuild()`. `read` llega al `ProviderContainer` con `listen: false` y llama a `read` sobre él. Sin entrada en el mapa, sin listener, sin reconstrucción, nunca.

`Ref` es lo que recibe el cuerpo de un provider o un `Notifier`. Mismos nombres, mecánica distinta:

```dart
// package:riverpod/src/core/ref.dart, riverpod 3.4.3
@override
StateT watch<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  late ProviderSubscription<StateT> sub;
  sub = _element.listen<StateT>(
    listenable,
    (prev, value) => _invalidateSelf(asReload: true, manual: false),
    onError: (err, stack) => _invalidateSelf(asReload: true, manual: false),
    onDependencyMayHaveChanged: _element._markDependencyMayHaveChanged,
  );
  return sub.readSafe().valueOrProviderException;
}

@override
StateT read<StateT>(ProviderListenable<StateT> listenable) {
  _throwIfInvalidUsage();
  final result = container.read(listenable);
  if (kDebugMode) _debugAssertCanDependOn(listenable);
  return result;
}
```

Del lado del provider, `watch` es `listen` más `invalidateSelf`, algo que la documentación oficial deja explícito en el comentario de documentación de `Ref.watch`. `read` es una lectura simple del container. El patrón es idéntico en ambas clases: watch construye una arista del grafo, read no.

## La regla trata sobre el lugar de la llamada, no sobre el provider

Hazte una pregunta: ¿esta línea de código necesita ejecutarse de nuevo cuando el valor cambie?

- Dentro de `build`, sí. El sentido de `build` es justamente que Riverpod pueda volver a llamarlo. Usa `ref.watch`.
- Dentro de `onPressed`, no. La persona pulsará el botón otra vez y el callback se ejecutará otra vez con un valor fresco. Usa `ref.read`.

La documentación oficial es contundente sobre cuál es el valor por defecto. De la página de refs de Riverpod: "Do not use Ref.read as a mean to 'optimize' your code by avoiding Ref.watch. This will make your code more brittle." Y del propio comentario de documentación de `Ref.read` en 3.4.3: "If possible, avoid using [read] and prefer [watch], which is generally safer to use."

Esta es la forma correcta en todas las versiones de Riverpod desde la 2.0:

```dart
// flutter_riverpod 3.4.3, Flutter 3.47.2, Dart 3.13.2
final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Rerun this line on every change: watch.
    final count = ref.watch(counterProvider);

    return Column(
      children: [
        Text('$count'),
        ElevatedButton(
          // Runs once per tap: read.
          onPressed: () => ref.read(counterProvider.notifier).increment(),
          child: const Text('increment'),
        ),
      ],
    );
  }
}
```

## `ref.watch` dentro de un callback no lanza error, y ese es todo el problema

Si mueves `ref.watch(counterProvider)` al closure de `onPressed`, la app compila, el analizador se queda callado y el valor que obtienes es correcto. Nada en `riverpod_lint` 3.1.9 lo marca: el conjunto de reglas es `missing_provider_scope`, `provider_dependencies`, `scoped_providers_should_specify_dependencies`, `avoid_build_context_in_providers`, `provider_parameters`, `avoid_public_notifier_properties`, `unsupported_provider_value`, `functional_ref`, `notifier_extends`, `avoid_ref_inside_state_dispose`, `avoid_keep_alive_dependency_inside_auto_dispose`, `notifier_build`, `riverpod_syntax_error`, `async_value_nullable_pattern` y `protected_notifier_properties`. Ninguna de ellas es "watch fuera de build".

Lo que ocurre en realidad es peor que un fallo. Vuelve a mirar `ConsumerStatefulElement.build`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
Widget build() {
  if (_tickerModeNotifier == null) {
    _updateTickerModeNotifier();
  }
  try {
    _oldDependencies = _dependencies;
    for (var i = 0; i < _listeners.length; i++) {
      _listeners[i].close();
    }
    _listeners.clear();
    _dependencies = {};
    return super.build();
  } finally {
    for (final dep in _oldDependencies!.values) {
      dep.close();
    }
    _oldDependencies = null;
  }
}
```

Cada build cambia `_dependencies` por un mapa nuevo y cierra lo que haya sobrevivido del anterior. Un `ref.watch` llamado desde `onPressed` se ejecuta cuando `_oldDependencies` es `null`, así que inserta una suscripción totalmente nueva en el mapa `_dependencies` vivo. Desde ese momento hasta la siguiente reconstrucción, el widget está suscrito a un provider que su método `build` nunca menciona. Si el provider cambia en esa ventana, se dispara `markNeedsBuild` y el widget se reconstruye. Después la reconstrucción descarta la suscripción, porque `build` no la vuelve a registrar, y el segundo cambio no hace nada.

Eso es reactividad de un solo disparo que depende del ritmo de los frames. Es exactamente el tipo de bug que solo se reproduce en un dispositivo lento.

Fíjate en el contraste con `ref.listen`, que sí se protege a sí mismo:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
@override
void listen<StateT>(
  ProviderListenable<StateT> provider,
  void Function(StateT? previous, StateT value) listener, {
  void Function(Object error, StackTrace stackTrace)? onError,
  bool weak = false,
}) {
  _assertNotDisposed();
  assert(
    debugDoingBuild,
    'ref.listen can only be used within the build method of a ConsumerWidget',
  );
  ...
}
```

`listen` lanza una aserción en compilaciones de depuración. `watch` no. No interpretes la ausencia de aserción como un permiso.

## `ref.read` en el cuerpo de un provider congela la dependencia para siempre

El mismo error del lado del provider es todavía más silencioso, porque no hay ningún widget que falle de forma visible al no reconstruirse.

```dart
// riverpod 3.4.3, WRONG
final localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

final greetingProvider = Provider<String>((ref) {
  // No graph edge. This provider will never be recomputed when the locale changes.
  final locale = ref.read(localeProvider);
  return locale.languageCode == 'fr' ? 'Bonjour' : 'Hello';
});
```

`greetingProvider` calcula una vez y guarda el resultado en caché. Cambiar el locale reconstruye `localeProvider` y todos los widgets que lo observan, y deja a `greetingProvider` sentado sobre un string obsoleto hasta que algo más lo invalide. Cambia a `ref.watch(localeProvider)` y la arista existe: `Ref.watch` llama a `_invalidateSelf(asReload: true)` en cada cambio, así que `greetingProvider` se recalcula bajo demanda.

Lo mismo aplica dentro de un `Notifier`. El comentario de documentación de `Notifier.build` en 3.4.3 lo dice directamente: "It is safe to use [Ref.watch] or [Ref.listen] inside this method." Watch en `build`. En `increment()` o `submit()`, read.

## `ref.read` sobre un provider `autoDispose` tira el trabajo a la basura

Esta es la que produce un reporte de bug titulado "mi estado se reinicia a cero".

El descarte automático se rastrea por listeners, no por lecturas. Con generación de código, `@riverpod` usa `keepAlive: false` por defecto, así que todo provider generado se auto-descarta salvo que digas lo contrario:

```dart
// riverpod_annotation 3.x
final class Riverpod {
  const Riverpod({
    this.keepAlive = false,
    ...
  });
}
```

Los providers escritos a mano funcionan al revés. `NotifierProvider` y `Provider` en `riverpod` 3.4.3 declaran ambos `super.isAutoDispose = false`, así que se mantienen vivos por defecto y tú optas por lo contrario con `NotifierProvider.autoDispose` o `isAutoDispose: true`.

Considera ahora un contador generado y auto-descartable que nada en pantalla está observando:

```dart
// riverpod_generator 4.x, riverpod 3.4.3
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

// In a widget that does NOT watch counterProvider anywhere:
onPressed: () {
  ref.read(counterProvider.notifier).increment(); // state becomes 1
},
```

`ref.read` crea el provider, ejecuta `build()`, devuelve el notifier y no añade ningún listener. La documentación de descarte describe los tiempos: cuando el número de listeners llega a cero el provider se considera "not used", Riverpod "waits for one frame", y si sigue sin usarse el provider se destruye. Así que el incremento aterriza sobre un `Counter` que se desmonta un frame después. El siguiente toque vuelve a empezar desde `0`.

La solución no es `ref.watch` en el callback. Es asegurarte de que algo observe legítimamente el provider, normalmente el widget que muestra el contador, o llamar a `ref.keepAlive()` dentro de `build` si el estado realmente debe sobrevivir a sus listeners.

## Observa el valor, lee el notifier

`ref.read(counterProvider.notifier)` es la forma canónica de llegar a los métodos de mutación, y aparece literalmente en el comentario de documentación de `Notifier`. `ref.watch(counterProvider.notifier)` no es un crimen, pero no sirve de nada: Riverpod filtra todas las notificaciones por `==` en 3.x, y el comentario de documentación de `Notifier` afirma que cuando `build` se vuelve a ejecutar "the [Notifier] will **not** be recreated. Its instance will be preserved between executions of [build]." La misma instancia se compara igual a sí misma, así que observar `.notifier` casi nunca emite. Solo emite cuando el provider se descarta por completo y se vuelve a crear. Consigues una suscripción que no te aporta nada excepto un keep-alive de auto-descarte que no pediste.

Así que: `ref.watch(provider)` para el valor, `ref.read(provider.notifier)` para los métodos.

## `initState` no quiere ninguno de los dos

En un `ConsumerState`, `initState` se ejecuta antes del primer `build`. Ahí `ref.watch` no lanza error, pero la suscripción que crea la descarta el primer build salvo que `build` observe casualmente el mismo provider, lo que convierte el comportamiento en accidental. `ref.listen` lanza su aserción de `debugDoingBuild`. La API soportada es `listenManual`:

```dart
// flutter_riverpod 3.4.3
class _FormState extends ConsumerState<MyForm> {
  late final ProviderSubscription<AsyncValue<void>> _sub;

  @override
  void initState() {
    super.initState();
    // Seed a controller once: read is correct here.
    _controller.text = ref.read(draftProvider);

    // Subscribe outside build: listenManual is correct here.
    _sub = ref.listenManual(submitProvider, (previous, next) {
      next.whenOrNull(error: (e, _) => showErrorBar(context, e));
    });
  }
}
```

`listenManual` lee deliberadamente el container con `listen: false` para que sea seguro en `initState`, y `ConsumerStatefulElement.unmount` cierra los listeners manuales después de que se ejecute `State.dispose`. No necesitas cerrarlo tú, aunque la suscripción devuelta te lo permite.

Ya que estás en código de ciclo de vida de `State`, recuerda el otro extremo: tocar `ref` en `dispose` lanza error, y la regla `avoid_ref_inside_state_dispose` de `riverpod_lint` existe justo para eso. El mensaje en 3.4.3 es `Using "ref" when a widget is about to or has been unmounted is unsafe.`, que es la redacción actual del antiguo [error Cannot use "ref" after the widget was disposed](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Riverpod 3 pausa las suscripciones de watch, lo que mata el último argumento a favor de read

El folclore de "read es más barato" es anterior a Riverpod 3. En 3.x, las suscripciones creadas por `WidgetRef.watch` participan en `TickerMode`:

```dart
// package:flutter_riverpod/src/core/consumer.dart, flutter_riverpod 3.4.3
void _updateTickerMode() {
  final isActive = _tickerModeNotifier!.value;
  if (isActive != _isActive) {
    _isActive = isActive;
    for (final sub in _dependencies.values) {
      if (isActive) {
        sub.resume();
      } else {
        sub.pause();
      }
    }
  }
}
```

Cuando un widget sale de pantalla, en una pestaña inactiva de un `TabBarView` o bajo una ruta apilada encima, todas sus suscripciones de watch se pausan y los providers detrás de ellas dejan de trabajar. No hay ningún ahorro equivalente al cambiar a `ref.read`, porque `ref.read` nunca tuvo una suscripción que pausar. El costo en tiempo de ejecución de un watch es una entrada en un `HashMap` más un callback de listener, que no es lo que está castigando tu presupuesto de frame.

Si de verdad quieres menos reconstrucciones, la herramienta es `.select`, no `read`:

```dart
// flutter_riverpod 3.4.3
// Rebuilds on every user field change:
final user = ref.watch(userProvider);
Text(user.name);

// Rebuilds only when the name changes, because select's output is compared with ==:
final name = ref.watch(userProvider.select((u) => u.name));
Text(name);
```

`select` conserva la suscripción, lo que significa que conserva la reactividad y el keep-alive, y solo filtra qué cuenta como cambio. Esa es la optimización. `ref.read` no es una optimización, es la eliminación de una funcionalidad.

Ten en cuenta que el filtrado por `==` es global en Riverpod 3.0 y aplica igual a `watch`, `select` y `listen`, lo que es su propia clase de sorpresa cuando tu clase de estado no implementa igualdad. Si un watch no se dispara cuando esperas, revisa `==` antes de culpar al lugar de la llamada: es el mismo mecanismo detrás de [StreamProvider descartando eventos en Riverpod 3.0](/es/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Qué escribir en la práctica

Usa `ref.watch` por defecto. Recurre a `ref.read` en exactamente tres lugares: el callback de un evento, un método de mutación de un `Notifier`, y un `Ref` que guardaste deliberadamente en una clase de servicio plana para que el servicio pueda obtener valores actuales sin ser recreado, que es el caso de uso que muestra la propia documentación de `Ref.read`. En todo lo demás, watch. Si te encuentras reemplazando un watch por un read para que algo deje de reconstruirse, has encontrado una oportunidad de `select` o un provider con un alcance demasiado grueso, no una razón para cortar la arista del grafo.

Y si un `ref.watch` parece pertenecer a un callback, lo que probablemente quieres es `ref.listen` en `build` (para efectos secundarios mientras el widget está vivo) o `ref.listenManual` en `initState` (para efectos secundarios atados al `State`).

## Relacionado

- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/es/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)
- [Comprobar ref.mounted después de un hueco asíncrono en Riverpod 3](/es/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Qué paquete de Riverpod instalar: riverpod, flutter_riverpod o hooks_riverpod](/es/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [Mostrar estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [La guía completa de migración de Riverpod 2.x a 3.0](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)

## Fuentes

- [Refs](https://riverpod.dev/docs/concepts2/refs), la página oficial de `Ref.watch`, `Ref.read` y `Ref.listen`.
- [Automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose), sobre el periodo de gracia de un frame y el seguimiento por número de listeners.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new), sobre el filtrado por `==` y la pausa dirigida por `TickerMode`.
- [flutter_riverpod 3.4.3 en pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.3), fuente de `ConsumerStatefulElement` citado arriba.
- [riverpod 3.4.3 en pub.dev](https://pub.dev/packages/riverpod/versions/3.4.3), fuente de `Ref.watch` y `Ref.read` citados arriba.
- [riverpod_lint 3.1.9 en pub.dev](https://pub.dev/packages/riverpod_lint), la lista completa de reglas referenciada arriba.

---
title: "Cómo comprobar Ref.mounted después de un hueco asíncrono en Flutter Riverpod 3"
description: "En un Notifier, resuelve las dependencias antes del await y luego protege la escritura de state con if (!ref.mounted) return. Es el reemplazo en Riverpod 3.0 del viejo mixin con onDispose, y evita UnmountedRefException cuando un provider se descarta a mitad de un await. Probado en flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-07-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "es"
translationOf: "2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3"
translatedBy: "claude"
translationDate: 2026-07-04
---

La regla es corta: dentro de un `Notifier` o `AsyncNotifier`, un `await` puede descartar el provider antes de que tu código se reanude, y escribir `state` en un provider descartado lanza una excepción. Así que lee todo lo que necesites de `ref` antes del primer `await`, haz el trabajo asíncrono y luego protege la escritura de `state` con `if (!ref.mounted) return;`. `Ref.mounted` es una propiedad de Riverpod 3.0, la gemela del lado del provider de `BuildContext.mounted`, y es la forma admitida de preguntar "¿sigue vivo este provider?" después de un hueco asíncrono. Esta guía está probada en `flutter_riverpod` 3.x (la línea 3.0 salió en septiembre de 2025; la versión actual es la 3.3.2), Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

Si alguna vez escribiste un mixin personalizado que cambia un booleano en `ref.onDispose` para poder comprobarlo después de un await, ya puedes borrarlo. `Ref.mounted` hace exactamente eso, de forma correcta y sin código repetitivo.

## Por qué un await puede dejar un provider descartado

El `Ref` de un provider está ligado a la vida de ese provider. Cuando el provider se descarta, su `Ref` queda invalidado, y Riverpod 3.0 lanza una excepción ante cualquier interacción posterior con él, incluyendo leer `ref`, llamar a `ref.read` o asignar `state`. La excepción que obtienes es `UnmountedRefException`: "usar `ref` o `state` después de un hueco asíncrono lanzará una excepción si el notifier ya está desmontado".

La razón por la que esto muerde específicamente después de un `await` es el hueco asíncrono. Tres cosas pueden descartar un provider mientras estás suspendido en un `Future`:

Un provider `autoDispose` pierde su último oyente. Si el widget que observa el provider se retira de la pila durante el await, el provider ya no tiene a nadie escuchando, así que Riverpod lo descarta. Tu continuación se despierta entonces con un `Ref` muerto.

El provider se invalida explícitamente. Otra parte de la aplicación llama a `ref.invalidate(myProvider)` o `ref.refresh(myProvider)` durante el hueco, lo que destruye la instancia actual y construye una nueva. El `Ref` de la instancia vieja, el que sostiene tu método suspendido, ahora está descartado.

Una dependencia cambia. El provider hace `watch` de algo que cambió, forzando una reconstrucción. El `Ref` de la compilación anterior se retira.

Riverpod 3.0 hizo el primer caso más raro al pausar los oyentes durante una reconstrucción en lugar de descartarlos de inmediato, así que un provider que meramente se reconstruye no se descarta con avidez. Pero un provider `autoDispose` genuinamente huérfano, uno que pierde todos sus observadores a mitad de un await, todavía se descarta. El cambio de ciclo de vida redujo los falsos positivos; no eliminó los reales. Este es el escenario exacto que se sigue en el [issue 4096 de riverpod](https://github.com/rrousselGit/riverpod/issues/4096).

El modelo mental importante: el fallo depende del tiempo. Cuando el trabajo esperado es rápido, el provider suele seguir vivo cuando te reanudas y todo funciona. Cuando la red es lenta o el usuario navega rápido, el provider se descarta primero y la escritura de `state` falla. Por eso este bug pasa la revisión de código, pasa en tu máquina y falla en producción.

## La reproducción más pequeña

Este `AsyncNotifier` obtiene una lista y luego la vuelve a escribir en `state` después del await. Compila, se ejecuta y pasa cada vez que la obtención es rápida.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- throws UnmountedRefException.
import 'package:flutter_riverpod/flutter_riverpod.dart';

final ordersProvider =
    AsyncNotifierProvider.autoDispose<OrdersNotifier, List<Order>>(
  OrdersNotifier.new,
);

class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    state = const AsyncLoading();
    // ~800ms round trip. If the screen that watches ordersProvider is popped
    // during this await, the autoDispose provider loses its last listener and
    // is disposed. The line below then runs on a dead Ref.
    final orders = await ref.read(orderRepositoryProvider).fetch();
    state = AsyncData(orders); // throws UnmountedRefException
  }
}
```

Dispara `refresh()`, retira la pantalla dentro de los 800 milisegundos, y la línea `state = AsyncData(orders)` lanza la excepción. No hay nada mal en la obtención. El problema es que `refresh` asumió que el provider seguiría existiendo cuando el `Future` se completara, y para un provider `autoDispose` cuyo observador se fue, no existe.

## La solución, paso a paso

Dos reglas cubren casi todas las ocurrencias. Resuelve tus dependencias antes del hueco y protege la escritura de state después de él.

1. **Lee cada dependencia que necesites antes del primer `await`.** Mientras el provider está garantizadamente vivo (la parte síncrona de tu método), llama a `ref.read` por cada servicio, repositorio o notifier que vayas a usar, y guarda los resultados en variables locales. Una referencia a un objeto plano no queda obsoleta cuando el provider se descarta; solo el `Ref` lo hace.

2. **Haz el trabajo asíncrono.** Espera tus `Future` usando las variables locales que capturaste. No toques `ref` dentro de las expresiones esperadas si puedes evitarlo.

3. **Protege la reanudación con `ref.mounted`.** Justo antes de asignar `state` (o llamar a cualquier método de `ref`), comprueba `if (!ref.mounted) return;`. Si el provider fue descartado durante el hueco, sales limpiamente en lugar de lanzar una excepción.

4. **Asigna `state`.** Ahora la escritura cae sobre un provider vivo.

Aquí está el notifier corregido:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- correct.
class OrdersNotifier extends AutoDisposeAsyncNotifier<List<Order>> {
  @override
  Future<List<Order>> build() => ref.read(orderRepositoryProvider).fetch();

  Future<void> refresh() async {
    final repo = ref.read(orderRepositoryProvider); // 1. read deps first
    state = const AsyncLoading();

    final next = await AsyncValue.guard(repo.fetch); // 2. async work

    if (!ref.mounted) return; // 3. the provider may be gone
    state = next;             // 4. safe write
  }
}
```

`repo` es un manejador de objeto duradero; funciona bien después del await incluso si el provider está muerto. La comprobación `ref.mounted` es lo que detiene el fallo: devuelve `false` cuando el provider ha sido descartado, así que la asignación de `state` nunca se ejecuta contra un `Ref` invalidado. Esta es la misma disciplina que mantiene seguros los [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), y es estructuralmente idéntica a la [protección de BuildContext después de un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) del lado del widget.

La documentación oficial de Riverpod 3.0 muestra precisamente este patrón:

```dart
// From the Riverpod 3.0 "what's new" docs.
Future<void> addTodo(String title) async {
  final newTodo = await api.addTodo(title);
  if (!ref.mounted) return;
  state = [...state, newTodo];
}
```

## ref.mounted, WidgetRef y context.mounted: qué comprobación va dónde

La fuente de confusión más común es cuál `mounted` quieres, porque hay tres de ellas y viven en tres objetos diferentes.

`ref.mounted` está en el `Ref` del provider, el que obtienes dentro de un `Notifier`, `AsyncNotifier` o el cuerpo de un provider funcional (`Ref ref`). Úsalo cuando el código asíncrono vive en un provider. Esta es la propiedad que Riverpod 3.0 añadió; no existía en 2.x.

`context.mounted` está en `BuildContext`. Úsalo cuando el código asíncrono vive en un widget y necesitas tocar el árbol después (`Navigator`, `ScaffoldMessenger`, `Theme.of`). El lint `use_build_context_synchronously` del analizador de Dart hace cumplir esta.

`State.mounted` está en `State` (y por tanto en `ConsumerState`). Úsalo en un `ConsumerStatefulWidget` antes de llamar a `setState` o de leer `WidgetRef` después de un await. Ojo con la trampa: un `WidgetRef` en un widget no es el mismo objeto que el `Ref` de un provider, y no tiene `ref.mounted`. En un widget proteges con `context.mounted` o `State.mounted`, no con `ref.mounted`.

La regla práctica: si la trama de la pila que lanza la excepción está dentro de un `Notifier` o `AsyncNotifier`, quieres `ref.mounted`. Si está dentro de un `ConsumerState` o un `ConsumerWidget` (build/callback), quieres `context.mounted` o `State.mounted`. Equivocarse en esto es la raíz del muy relacionado [fallo Cannot use "ref" after the widget was disposed](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/), cuya variante del lado del provider es la respuesta proactiva de esta guía.

## El mixin de 2.x que ahora puedes borrar

Antes de Riverpod 3.0 no había `Ref.mounted`, así que la solución alternativa de la comunidad era un mixin que rastreaba el descarte manualmente:

```dart
// Riverpod 2.x workaround -- no longer needed on 3.0.
mixin NotifierMounted {
  bool _mounted = true;
  void setUnmounted() => _mounted = false;
  bool get mounted => _mounted;
}

class SomeNotifier extends AutoDisposeAsyncNotifier<void>
    with NotifierMounted {
  @override
  FutureOr<void> build() {
    ref.onDispose(setUnmounted); // flip the flag when disposed
  }

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (mounted) {
      state = next;
    }
  }
}
```

Esto funcionaba, pero el mantenedor de Riverpod lo desaconsejó explícitamente, y tenía aristas afiladas (tenías que acordarte de registrar `onDispose`, y la bandera vivía en la instancia del notifier en lugar de en el ref). En 3.0 todo el mixin colapsa en una sola propiedad:

```dart
// Riverpod 3.x -- the mixin is gone, ref.mounted is built in.
class SomeNotifier extends AutoDisposeAsyncNotifier<void> {
  @override
  FutureOr<void> build() {}

  Future<void> doAsyncWork() async {
    final next = await AsyncValue.guard(someFuture);
    if (!ref.mounted) return;
    state = next;
  }
}
```

Si estás actualizando desde 2.x y ves un mixin `NotifierMounted` (o cualquier bandera `_mounted` hecha a mano) en tu base de código, ahora es peso muerto. Borra el mixin, borra la línea `ref.onDispose(setUnmounted)` y reemplaza `if (mounted)` por `if (!ref.mounted) return;`.

## Trampas y casos límite

**`ref.mounted` no sustituye la limpieza con `ref.onDispose`.** La protección evita una escritura en un provider descartado; no limpia recursos. Si tu provider posee una suscripción, un socket o un temporizador, registra su desmontaje con `ref.onDispose` en `build`. Y no llames a `ref.read` dentro de un callback de `onDispose`: el provider ya se está descartando en ese punto, así que `ref` es inválido y volverás a chocar con `UnmountedRefException`. El lint `avoid-ref-inside-state-dispose` de DCM marca exactamente esto.

**Leer un provider `autoDispose` a través de `.future` puede descartarlo tras el primer await.** Hay un caso sutil, discutido en la [discusión 4293 de riverpod](https://github.com/rrousselGit/riverpod/discussions/4293), donde un provider `autoDispose` leído a través de su `.future` se descarta después del primer `await` porque el oyente temporal creado por la lectura se libera. Si estás encadenando lecturas a través de awaits, mantén un oyente real vivo (obsérvalo, o usa `ref.keepAlive()`), en lugar de asumir que `.future` mantiene el provider abierto.

**`ref.keepAlive()` cambia el cálculo.** Un provider que has fijado con `ref.keepAlive()` no hará `autoDispose` cuando su último widget se vaya, así que la causa "perdió el último oyente" desaparece. Todavía puede ser descartado por un `invalidate` o `refresh` explícito, así que mantén la protección `ref.mounted`, pero entiende que fijar elimina el disparador más común.

**`AsyncValue.guard` no protege el montaje.** `AsyncValue.guard` convierte una excepción lanzada en un `AsyncError` para que el error caiga en tu estado en lugar de fallar. No hace nada respecto al descarte. Todavía necesitas el `if (!ref.mounted) return;` después de él, antes de asignar el resultado protegido a `state`. Los dos mecanismos resuelven problemas diferentes: `guard` maneja el fallo del Future, `ref.mounted` maneja la desaparición del provider.

**Un `ConsumerWidget` no tiene `ref.mounted`.** Su `ref` es un `WidgetRef`, no un `Ref` de provider. Si capturaste un `WidgetRef` en un callback asíncrono dentro de un `ConsumerWidget` sin estado, no hay `mounted` que comprobar. Mueve el trabajo asíncrono a un Notifier para que se ejecute detrás de un `Ref` de provider duradero (esta es la forma que produce una [migración de FutureBuilder a AsyncNotifier](/es/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)), o cambia a un `ConsumerStatefulWidget` para tener `State.mounted`.

**Empezó a lanzar la excepción solo después de la actualización a 3.0.** Riverpod 3.0 lanza una excepción ante la interacción posterior al descarte donde 2.x a veces la toleraba en silencio. El código que "funcionaba" antes ya estaba escribiendo en un provider descartado; 3.0 sacó a la superficie un bug latente en lugar de crearlo. Añade la protección, no vuelvas a 2.x para ocultarlo.

## Deja que el linter atrape las que se te escapan

La protección es un hábito, y los hábitos fallan. Dos reglas de análisis estático convierten "acuérdate de comprobar `ref.mounted`" en un error de compilación. DCM incluye `use-ref-and-state-synchronously`, que marca un acceso a `ref` o `state` después de un hueco asíncrono que no va precedido de una comprobación de montaje, y `avoid-ref-inside-state-dispose` para el caso de `onDispose`. El propio conjunto de lints de Riverpod incluye equivalentes. De fábrica, el compilador de Dart no te avisará sobre `ref` después de un await como sí lo hace para `BuildContext`, así que activar estas reglas es la diferencia entre atrapar el bug en CI y atraparlo en un informe de fallo.

La única disciplina que elimina toda esta clase de bug: trata el `Ref` de un provider exactamente como un `BuildContext`. Es válido de forma síncrona, un `await` puede invalidarlo, así que lee lo que necesitas antes del hueco y protege cada toque de `ref` o `state` posterior al await con `if (!ref.mounted) return;`. Integra eso en tu reflejo de async-notifier y `UnmountedRefException` deja de aparecer. Es una de las razones por las que [el ciclo de vida propiedad del Notifier de Riverpod es la elección de gestión de estado por defecto en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/).

## Relacionado

- [Fix: Cannot use "ref" after the widget was disposed in Flutter Riverpod](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) es la contraparte reactiva: el fallo que obtienes cuando te saltas esta protección, tanto del lado del widget como del provider.
- [Cómo usar BuildContext de forma segura después de un await en Flutter](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) es la misma protección para el `context.mounted` del lado del widget.
- [Cómo mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) muestra el patrón de `AsyncNotifier` más `AsyncValue.guard` que esta protección resguarda.
- [Migrar de FutureBuilder a un AsyncNotifier de Riverpod en Flutter](/es/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) mueve el trabajo asíncrono a un provider donde `ref.mounted` está disponible.
- [Provider vs Riverpod vs Bloc para la gestión de estado en Flutter en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) cubre por qué el ciclo de vida propiedad del Notifier es el estándar moderno.

## Fuentes

- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- presenta `Ref.mounted`, el patrón `if (!ref.mounted) return;` y el cambio de ciclo de vida de pausar-oyentes-en-reconstrucción.
- [Riverpod FAQ](https://riverpod.dev/docs/root/faq) -- sobre la vida del `Ref` de un provider frente a un `WidgetRef`.
- [rrousselGit/riverpod issue 4096](https://github.com/rrousselGit/riverpod/issues/4096) -- usar `ref` en un notifier después de un hueco asíncrono, y la corrección de 3.0.
- [rrousselGit/riverpod discussion 4293](https://github.com/rrousselGit/riverpod/discussions/4293) -- por qué los providers `autoDispose` se descartan tras el primer `await` cuando se leen a través de `.future`.
- [DCM use-ref-and-state-synchronously rule](https://dcm.dev/docs/rules/riverpod/use-ref-and-state-synchronously/) -- el lint que hace cumplir una comprobación de montaje después de un hueco asíncrono.
- [How to Check if an AsyncNotifier is Mounted with Riverpod, codewithandrea](https://codewithandrea.com/articles/async-notifier-mounted-riverpod/) -- el viejo mixin de 2.x y el reemplazo `ref.mounted` de 3.0.
</content>

---
title: "Migra un StatefulWidget con setState a un Notifier de Riverpod en Flutter"
description: "Un recorrido paso a paso desde el setState local del widget hacia un Notifier de Riverpod 3.x: clasifica lo que realmente sale del widget, escribe el Notifier, conviértelo a ConsumerWidget y sobrevive al filtrado por ==, a la reejecución de build() y a los valores por defecto de autoDispose que muerden a quienes vienen de setState. Probado con Flutter 3.44, Dart 3.x y flutter_riverpod 3.3.2."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "es"
translationOf: "2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-25
---

Mover una pantalla de `setState` a un `Notifier` de Riverpod toma alrededor de una hora una vez que lo has hecho dos veces, y la mayor parte de esa hora se va en decidir qué **no** debe moverse. Esta guía está probada con Flutter 3.44 (estable, mayo de 2026), Dart 3.x y `flutter_riverpod` 3.3.2, con `riverpod_generator` 4.0.4 y `riverpod_annotation` 4.0.3 para la variante con generación de código. Lo que se rompe rara vez es el compilador: las tres cosas que muerden son que Riverpod 3.0 filtra las notificaciones con `==` (así que la mutación de lista en el lugar con la que te salías con la tuya bajo `setState` ahora deja de reconstruir la interfaz en silencio), que `Notifier.build()` se vuelve a ejecutar donde `initState` corría una sola vez, y que la eliminación automática tiene valores por defecto distintos para los providers generados y los escritos a mano. Hazlo cuando dos widgets necesiten el mismo estado, o cuando quieras probar la lógica sin montar un widget. No lo hagas para una pantalla que solo es dueña de un booleano.

## Por qué este estado debe salir del widget

- **Dos lectores, una sola fuente.** Un indicador de carrito en el `AppBar` y una pantalla de carrito a dos rutas de distancia necesitan las mismas líneas. Con `setState` o elevas el estado a un ancestro común y bajas callbacks a la fuerza, o mantienes dos copias y esperas que coincidan.
- **La lógica se vuelve probable con pruebas unitarias.** Un `Notifier` es un objeto Dart común. Puedes manejarlo desde un `ProviderContainer.test()` en un bloque `test()` normal, sin `pumpWidget`, sin `WidgetTester` y sin programación de frames.
- **El estado sobrevive a la ruta cuando así lo quieres.** Un `NotifierProvider` conserva su valor a través de un `Navigator.pop`, que es justo lo que necesitan un carrito, un formulario en borrador o un asistente de varios pasos. El estado del widget muere con el elemento.
- **Las mutaciones reciben nombre.** `setState(() => _lines = [..._lines, line])` repartido entre seis callbacks se convierte en `cartProvider.notifier.add(line)`, que es un único lugar donde registrar, proteger o limitar la frecuencia.

Nada de eso justifica mover todo. Un `TextEditingController`, un `AnimationController`, un `FocusNode`, un `ScrollController` y un `GlobalKey<FormState>` pertenecen al widget y deben quedarse en un objeto `State`.

## Qué se rompe

| Área | Cambio | Severidad |
| ---- | ------ | --------- |
| Clase base del widget | `StatefulWidget` pasa a `ConsumerWidget`, o `ConsumerStatefulWidget` si se quedan controladores | alta |
| Mutación de colecciones en el lugar | Riverpod 3.0 filtra con `==`; `state.add(x)` seguido de `state = state` no reconstruye | alta |
| Llamadas a `setState` | Se reemplazan asignando `state` dentro del `Notifier` | alta |
| `initState` | Se traslada a `Notifier.build()`, que puede ejecutarse más de una vez | media |
| `dispose` | Pasa a `ref.onDispose`, solo para recursos propiedad del provider | media |
| Tiempo de vida del estado | Los providers generados se eliminan automáticamente por defecto; los escritos a mano no | media |
| `context` después de un `await` | `context.mounted` dentro del widget se convierte en `ref.mounted` dentro del notifier | media |
| Pruebas de widgets | `pumpWidget` necesita un envoltorio `ProviderScope` o cada lectura lanza una excepción | baja |

## Lista de verificación previa

1. Flutter 3.44 estable y Dart 3.x en la máquina y en CI (`flutter --version`).
2. `flutter_riverpod: ^3.3.2` en `pubspec.yaml`, y `ProviderScope` envolviendo `runApp`. Si todavía estás en 2.x, haz esa actualización primero y por separado: consulta [la migración de Riverpod 2.x a Riverpod 3.0](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/).
3. Decide ahora si usarás generación de código o no, no a mitad de camino. La generación de código necesita `riverpod_annotation: ^4.0.3` más `riverpod_generator: ^4.0.4` y `build_runner` en `dev_dependencies`.
4. `riverpod_lint` y `custom_lint` habilitados en `analysis_options.yaml`. Detecta `ref.read` dentro de un método `build`, que es el error más común de esta migración.
5. Una prueba de widget que fije el comportamiento actual de la pantalla antes de tocarla. Quieres una señal de rojo/verde, no una intuición.
6. Una rama. Esto es reversible, pero no en tres commits pequeños.

## El punto de partida

Una pantalla de carrito que guarda todo en `State`, con un callback bajado a la fuerza hasta un hijo para que el indicador pueda actualizarse:

```dart
// Flutter 3.44, Dart 3.x -- before
class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  List<CartLine> _lines = const [];
  bool _isSubmitting = false;
  final _couponController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _lines = CartStorage.instance.load();
  }

  @override
  void dispose() {
    _couponController.dispose();
    super.dispose();
  }

  void _add(CartLine line) {
    setState(() => _lines = [..._lines, line]);
  }

  void _setQuantity(String sku, int quantity) {
    setState(() {
      _lines = [
        for (final l in _lines)
          if (l.sku == sku) l.copyWith(quantity: quantity) else l,
      ];
    });
  }

  Future<void> _submit() async {
    setState(() => _isSubmitting = true);
    await CheckoutApi.submit(_lines);
    if (!mounted) return;
    setState(() => _isSubmitting = false);
  }

  @override
  Widget build(BuildContext context) => CartView(
        lines: _lines,
        isSubmitting: _isSubmitting,
        couponController: _couponController,
        onQuantityChanged: _setQuantity,
      );
}
```

## Pasos de la migración

1. **Clasifica cada campo del objeto `State`.** Divídelos en dos listas sobre papel antes de escribir código. El estado de dominio que otro widget podría necesitar de forma plausible (`_lines`, `_isSubmitting`) se mueve al notifier. Los objetos del framework atados al elemento de este widget (`_couponController`, focus nodes, controladores de animación, claves de formulario) se quedan. *Verificación:* cada campo está en exactamente una lista, y nada de la lista "se queda" es leído por otra ruta.

2. **Modela el estado como un único valor inmutable.** Dos campos sueltos se convierten en una clase para que una sola asignación de `state` describa la pantalla entera. *Verificación:* `dart analyze` está limpio y la clase tiene `copyWith`.

   ```dart
   // Flutter 3.44, Dart 3.x
   class CartState {
     const CartState({this.lines = const [], this.isSubmitting = false});
     final List<CartLine> lines;
     final bool isSubmitting;

     int get itemCount => lines.fold(0, (sum, l) => sum + l.quantity);

     CartState copyWith({List<CartLine>? lines, bool? isSubmitting}) =>
         CartState(
           lines: lines ?? this.lines,
           isSubmitting: isSubmitting ?? this.isSubmitting,
         );
   }
   ```

3. **Escribe el `Notifier`.** `build()` devuelve el estado inicial y reemplaza a `initState`. Cada antiguo closure de `setState` se convierte en un método público que asigna `state`. *Verificación:* el archivo compila sin ninguna referencia a `BuildContext`, `setState` ni ningún tipo de widget.

   ```dart
   // flutter_riverpod 3.3.2 -- no codegen
   import 'package:flutter_riverpod/flutter_riverpod.dart';

   final cartProvider = NotifierProvider<CartNotifier, CartState>(
     CartNotifier.new,
   );

   class CartNotifier extends Notifier<CartState> {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());

     void add(CartLine line) {
       state = state.copyWith(lines: [...state.lines, line]);
     }

     void setQuantity(String sku, int quantity) {
       state = state.copyWith(
         lines: [
           for (final l in state.lines)
             if (l.sku == sku) l.copyWith(quantity: quantity) else l,
         ],
       );
     }

     Future<void> submit() async {
       state = state.copyWith(isSubmitting: true);
       await CheckoutApi.submit(state.lines);
       if (!ref.mounted) return;
       state = state.copyWith(isSubmitting: false);
     }
   }
   ```

   La forma con generación de código es la misma clase con el provider inferido:

   ```dart
   // riverpod_annotation 4.0.3, riverpod_generator 4.0.4
   @Riverpod(keepAlive: true)
   class Cart extends _$Cart {
     @override
     CartState build() => CartState(lines: CartStorage.instance.load());
     // ...same methods
   }
   ```

4. **Prueba el notifier con pruebas unitarias antes de tocar un solo widget.** Esta es la recompensa, así que cóbrala temprano. *Verificación:* `flutter test test/cart_notifier_test.dart` pasa sin montar ningún widget.

   ```dart
   // flutter_riverpod 3.3.2
   test('setQuantity replaces the matching line', () {
     final container = ProviderContainer.test();
     container.read(cartProvider.notifier).add(const CartLine(sku: 'A', quantity: 1));
     container.read(cartProvider.notifier).setQuantity('A', 3);
     expect(container.read(cartProvider).itemCount, 3);
   });
   ```

5. **Convierte el widget.** Si nada del paso 1 se quedó atrás, `StatefulWidget` se reduce a `ConsumerWidget` y `build` gana un `WidgetRef`. Como el controlador del cupón se quedó, esta pantalla pasa a ser un `ConsumerStatefulWidget`. *Verificación:* `flutter analyze` reporta cero problemas, incluidas las reglas de `riverpod_lint`.

   ```dart
   // Flutter 3.44, flutter_riverpod 3.3.2 -- after
   class CartScreen extends ConsumerStatefulWidget {
     const CartScreen({super.key});
     @override
     ConsumerState<CartScreen> createState() => _CartScreenState();
   }

   class _CartScreenState extends ConsumerState<CartScreen> {
     final _couponController = TextEditingController();

     @override
     void dispose() {
       _couponController.dispose();
       super.dispose();
     }

     @override
     Widget build(BuildContext context) {
       final cart = ref.watch(cartProvider);
       return CartView(
         lines: cart.lines,
         isSubmitting: cart.isSubmitting,
         couponController: _couponController,
         onQuantityChanged: (sku, qty) =>
             ref.read(cartProvider.notifier).setQuantity(sku, qty),
       );
     }
   }
   ```

6. **Aplica la regla watch/read en cada punto de llamada.** `ref.watch` en `build` porque quieres reconstrucciones. `ref.read(provider.notifier)` en los callbacks porque no las quieres. Nunca uses `ref.watch` dentro de un `onPressed`. *Verificación:* busca `ref.read(` en el archivo y confirma que cada coincidencia está dentro de un callback o de un método asíncrono, nunca en `build`.

7. **Elimina los callbacks bajados a la fuerza y deja que el otro widget observe directamente.** Este es el paso que paga la migración. El indicador deja de recibir un conteo a través de tres constructores y lee el provider por su cuenta. *Verificación:* los widgets intermedios ya no declaran los parámetros eliminados, y agregar un artículo desde la pantalla del carrito actualiza el indicador en otra ruta.

   ```dart
   // flutter_riverpod 3.3.2
   class CartBadge extends ConsumerWidget {
     const CartBadge({super.key});
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final count = ref.watch(cartProvider.select((s) => s.itemCount));
       return Badge(label: Text('$count'));
     }
   }
   ```

   Aquí `select` importa. Sin él, el indicador se reconstruye cada vez que `isSubmitting` cambia, algo que bajo `setState` nunca ocurría porque ni siquiera estaba en el subárbol de ese widget.

8. **Traslada la limpieza propiedad del provider a `ref.onDispose`.** Todo lo que el notifier creó (un `StreamSubscription`, un temporizador, un socket) se libera ahí, no en el `dispose` del widget. *Verificación:* apaga y enciende la pantalla y confirma que no hay suscripciones duplicadas en el registro.

   ```dart
   @override
   CartState build() {
     final sub = PriceFeed.stream.listen(_onPriceChanged);
     ref.onDispose(sub.cancel);
     return CartState(lines: CartStorage.instance.load());
   }
   ```

## Verificación

Ejecuta esta lista antes de integrar:

- `flutter analyze` reporta cero problemas con `riverpod_lint` habilitado.
- `flutter test` pasa, y ahora las pruebas de widgets envuelven la pantalla en un `ProviderScope`. Sin él, el primer `ref.watch` lanza una excepción en tiempo de ejecución en lugar de en tiempo de compilación.
- La pantalla se construye y cada interacción que antes usaba `setState` sigue actualizando la interfaz. Recorre cada una; el modo de falla del filtrado por `==` (ver más abajo) no produce ningún error, solo un widget congelado.
- Empuja la pantalla, sácala de la pila y vuelve a empujarla. Confirma que la persistencia del estado coincide con lo que pretendías, no con lo que pasó por accidente.
- Revisión en modo profile con DevTools: el conteo de reconstrucciones del padre debe ser igual o menor que antes. Si subió, te falta un `select`.

## Plan de reversión

Esta migración es reversible con `git revert` mientras la hayas mantenido en su propia rama, porque nada cambia en disco ni por la red. Lo único que la reversión no restaura es el comportamiento que dependía del nuevo tiempo de vida: si ya lo publicaste y los usuarios se acostumbraron a que el carrito sobreviviera a una navegación hacia atrás, revertir al estado local del widget lo descarta en silencio al hacer pop. Revierte el código y vuelve a probar los flujos de navegación, no solo la compilación.

## Problemas que nos encontramos

**La mutación en el lugar dejó de reconstruir.** Bajo `setState`, `_lines.add(line)` dentro del closure funcionaba, porque `setState` marca el elemento como sucio sin importar qué cambió. Riverpod 3.0 compara el estado anterior con el nuevo usando `==` y omite la notificación cuando son iguales, así que esto no hace absolutamente nada:

```dart
// broken on flutter_riverpod 3.x
void add(CartLine line) {
  state.lines.add(line); // mutates the same List instance
  state = state;         // identical, == is true, no listeners notified
}
```

Construye siempre un valor nuevo, como hace el paso 3. Es el mismo filtrado por igualdad que sorprende a la gente cuando [un StreamProvider de Riverpod 3.0 deja de emitir](/es/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/). Aquí muerde más fuerte si tu clase de estado usa `equatable` o un tipo de valor de `freezed`, porque entonces incluso un objeto reconstruido correctamente con contenido sin cambios será filtrado.

**`build()` no es `initState`.** `initState` corre una vez por elemento. `Notifier.build()` se vuelve a ejecutar cada vez que cambia una dependencia observada, y restablece `state` a lo que devuelva. Si usas `ref.watch(authProvider)` dentro de `build()`, un refresco de token borra el carrito. Usa `ref.read` para los valores que solo quieres al inicializar, y reserva `ref.watch` en `build()` para las dependencias que genuinamente deban restablecer el estado.

**Los valores por defecto de la eliminación automática difieren entre las dos sintaxis.** Un `NotifierProvider(CartNotifier.new)` escrito a mano se mantiene vivo por defecto; te suscribes con `isAutoDispose: true`. Un provider generado con `@riverpod` se elimina automáticamente por defecto; te sales con `@Riverpod(keepAlive: true)`. Los equipos que escriben ambas formas en un mismo código base terminan con un carrito que se vacía solo en algunas pantallas y en otras no, sin ningún error que lo explique.

**`mounted` se mudó.** Dentro del widget sigues usando `context.mounted` y la habitual [protección con `mounted` después de un hueco asíncrono](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Dentro del notifier no hay `BuildContext`, así que la comprobación es [`ref.mounted` después del await](/es/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/). Olvidarla lanza una excepción cuando el provider fue eliminado mientras la solicitud estaba en vuelo.

**Los controladores no pertenecen al notifier.** Poner un `TextEditingController` en el estado del provider parece ordenado hasta que el provider sobrevive al widget y estás escribiendo en un controlador cuyos listeners ya no existen. Mantén las [reglas de liberación de controladores](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) exactamente donde estaban.

## Lecturas relacionadas

- [Provider vs Riverpod vs Bloc para el manejo de estado en Flutter en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) si todavía estás eligiendo destino.
- [Migrar de Riverpod 2.x a Riverpod 3.0](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), la actualización que conviene hacer antes que esta.
- [Migrar de FutureBuilder a un AsyncNotifier de Riverpod](/es/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/) para el equivalente asíncrono de esta migración.
- [Qué paquete de Riverpod necesitas realmente](/es/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/), porque `riverpod` y `flutter_riverpod` no son intercambiables.
- [Mostrar estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) cuando el notifier empiece a hacer IO.

## Fuentes

- [Novedades de Riverpod 3.0](https://riverpod.dev/docs/whats_new) para el `Ref` unificado, `ref.mounted`, `ProviderContainer.test()` y el filtrado de notificaciones por `==`.
- [Referencia de providers de Riverpod](https://riverpod.dev/docs/concepts2/providers) para el contrato de `Notifier` y `build()`.
- [Eliminación automática en Riverpod](https://riverpod.dev/docs/concepts2/auto_dispose) para `isAutoDispose` y `ref.keepAlive()`.
- [Migración de 2.0 a 3.0](https://riverpod.dev/docs/3.0_migration) para la eliminación de las interfaces `AutoDispose`.
- [flutter_riverpod en pub.dev](https://pub.dev/packages/flutter_riverpod) y [riverpod_generator en pub.dev](https://pub.dev/packages/riverpod_generator) para las versiones fijadas 3.3.2 y 4.0.4.
- [Notas de versión de Flutter](https://docs.flutter.dev/release/release-notes) para la línea base 3.44 estable.

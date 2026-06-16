---
title: "Migrar de provider a Riverpod en Flutter (de provider 6.1.5 a Riverpod 3.x)"
description: "Una migracion paso a paso del paquete provider a Riverpod 3.x en una app de Flutter real: de ChangeNotifierProvider a Notifier, de MultiProvider a ProviderScope, de context.watch a ref.watch, de ProxyProvider a composicion con ref.watch, mas los detalles de igualdad y ciclo de vida que muerden. Probado en Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "provider"
  - "state-management"
  - "migration"
lang: "es"
translationOf: "2026/06/migrate-from-provider-to-riverpod-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-16
---

La version corta: agrega `flutter_riverpod` junto a `provider`, envuelve tu app en un `ProviderScope` en vez de un `MultiProvider`, y migra una caracteristica a la vez empezando por las hojas de tu arbol de dependencias. Cada `ChangeNotifier` se convierte en un `Notifier` (o `AsyncNotifier` para trabajo asincrono), `context.watch<T>()` se convierte en `ref.watch(myProvider)`, `Provider.of` y `context.read` se convierten en `ref.read`, y cada `ProxyProvider` colapsa en un simple `ref.watch` de otro provider. Una app pequena o mediana es un trabajo de uno a tres dias; la parte que rompe no es la sintaxis, es que Riverpod compara el estado por igualdad y mantiene los providers vivos de forma distinta a como lo hace `provider`. Probado en Flutter 3.27.1, Dart 3.11, provider 6.1.5, flutter_riverpod 3.3.1, riverpod_annotation 2.6.1 y riverpod_generator 2.6.5.

El paquete `provider` (actualmente 6.1.5) ha sido la respuesta por defecto para el manejo de estado en Flutter desde 2019, y sigue funcionando. Pero su autor, Remi Rousselet, escribio Riverpod especificamente para arreglar los problemas estructurales de `provider`: leer el estado a traves de `BuildContext` significa un `ProviderNotFoundException` en tiempo de ejecucion en vez de un error de compilacion, el anidamiento de `ProxyProvider` se vuelve ilegible pasadas dos dependencias, y no puedes tener dos providers del mismo tipo sin malabares con `ValueKey`. Riverpod conserva el modelo mental (un grafo de objetos que reconstruyen widgets cuando cambian) y elimina el acoplamiento con `BuildContext`. Esta guia es la migracion mecanica, primero las hojas, que no requiere reescribir todo.

## Por que migrar fuera de provider

- **Seguridad en tiempo de compilacion en vez de `ProviderNotFoundException`.** En `provider`, leer un tipo que no esta por encima de ti en el arbol lanza una excepcion en tiempo de ejecucion. En Riverpod, los providers son globales de nivel superior, asi que un error de tipeo es un error de compilacion y no hay nada que "encontrar".
- **Se acabo la piramide de `MultiProvider`.** Riverpod no tiene un arbol de providers que ensamblar. Un solo `ProviderScope` en la raiz reemplaza toda la lista `MultiProvider(providers: [...])`, y las dependencias entre providers se expresan con `ref.watch`, no con el orden de anidamiento.
- **Dos providers del mismo tipo, gratis.** `provider` indexa todo por tipo, asi que dos `ChangeNotifierProvider<CartModel>` colisionan. Riverpod indexa por el objeto provider, asi que esto no es un problema.
- **Auto-dispose y family que de verdad componen.** Riverpod te da providers `autoDispose` y parametrizados (`family`) como caracteristicas de primera clase, algo que `provider` solo aproxima con `ChangeNotifierProvider.value` manual y manejo de keys.

## Que rompe

| Area | Cambio | Severidad |
| --- | --- | --- |
| Cableado raiz | `MultiProvider` reemplazado por un solo `ProviderScope` | media |
| Lecturas | `context.watch<T>()` / `Provider.of<T>(context)` reemplazado por `ref.watch` / `ref.read` | alta |
| Notifiers | `ChangeNotifier` + `notifyListeners()` reemplazado por `Notifier` + reasignacion de estado | alta |
| Semantica de reconstruccion | Riverpod compara el estado por `==`; la mutacion en el lugar ya no reconstruye | alta |
| Composicion | `ProxyProvider` reemplazado por `ref.watch` de la dependencia | media |
| Widgets | `StatelessWidget` / `StatefulWidget` se vuelven `ConsumerWidget` / `ConsumerStatefulWidget` | media |
| Ciclo de vida | `provider` libera cuando se quita del arbol; Riverpod mantiene el estado hasta `autoDispose` | media |

Las dos filas `alta` en las areas de reconstruccion y notifier son donde los equipos pierden tiempo. Todo lo demas es buscar y reemplazar.

## Lista de verificacion previa

- Flutter 3.27.1 / Dart 3.11 (o mas nuevo) instalado: `flutter --version`.
- Un arbol de trabajo `git` limpio y una rama que puedas desechar.
- Un inventario de cada provider que registras hoy. Haz grep en tu codigo: `grep -rn "ChangeNotifierProvider\|ProxyProvider\|FutureProvider\|StreamProvider\|Provider.of\|context.watch\|context.read" lib/`.
- Una nota junto a cada uno sobre si algo depende de el. Migra primero las cosas de las que nada depende.
- Un conjunto de pruebas que funcione, aunque sea minimo. Lo ejecutaras despues de cada paso.

## Pasos de migracion

1. **Agrega Riverpod junto a provider en `pubspec.yaml`.** No quites `provider` todavia. Ambos paquetes coexisten porque poseen arboles separados; una pieza de estado tiene exactamente un dueno a la vez, asi que migra por caracteristica, no por tipo.

   ```yaml
   # pubspec.yaml. Flutter 3.27.1, Dart 3.11.
   dependencies:
     flutter:
       sdk: flutter
     provider: ^6.1.5            # keep until migration is done
     flutter_riverpod: ^3.3.1
     riverpod_annotation: ^2.6.1

   dev_dependencies:
     build_runner: ^2.4.13
     riverpod_generator: ^2.6.5
     custom_lint: ^0.7.0
     riverpod_lint: ^2.6.5
   ```

   Verifica: `flutter pub get` resuelve sin conflictos de version.

2. **Envuelve la raiz de la app en `ProviderScope` y manten `MultiProvider` dentro de el por ahora.** `ProviderScope` es donde Riverpod almacena todo el estado de los providers. No es una lista de providers, es un solo limite. Deja tu `MultiProvider` existente debajo de el para que las pantallas no migradas sigan funcionando.

   ```dart
   // lib/main.dart, Flutter 3.27.1
   import 'package:flutter/material.dart';
   import 'package:flutter_riverpod/flutter_riverpod.dart';
   import 'package:provider/provider.dart';

   void main() {
     runApp(
       ProviderScope(                       // Riverpod root
         child: MultiProvider(              // legacy, shrinks as you migrate
           providers: [
             ChangeNotifierProvider(create: (_) => CartModel()),
             ChangeNotifierProvider(create: (_) => AuthModel()),
           ],
           child: const MyApp(),
         ),
       ),
     );
   }
   ```

   Verifica: la app sigue compilando y ejecutandose identicamente. Nada se ha movido todavia.

3. **Convierte un `ChangeNotifier` hoja en un `Notifier`.** Elige un modelo del que nada mas dependa. En `provider` mutas un campo y llamas a `notifyListeners()`. En Riverpod, `build()` devuelve el estado inicial y reasignas `state` para notificar. No hay `notifyListeners()`.

   ```dart
   // Before: provider 6.1.5
   class CartModel extends ChangeNotifier {
     final List<Item> _items = [];
     List<Item> get items => List.unmodifiable(_items);

     void add(Item item) {
       _items.add(item);
       notifyListeners();
     }
   }
   ```

   ```dart
   // After: flutter_riverpod 3.3.1, code generation
   import 'package:riverpod_annotation/riverpod_annotation.dart';

   part 'cart_model.g.dart';

   @riverpod
   class Cart extends _$Cart {
     @override
     List<Item> build() => const [];

     void add(Item item) {
       state = [...state, item];   // new list, not state.add(...)
     }
   }
   ```

   Ejecuta `dart run build_runner build --delete-conflicting-outputs` para generar `cartProvider`. Verifica: el generador produce `cart_model.g.dart` sin errores.

4. **Cambia la pantalla que lo consume a un `ConsumerWidget`.** `StatelessWidget` se vuelve `ConsumerWidget` y `build` gana un `WidgetRef ref`. `context.watch<CartModel>()` se convierte en `ref.watch(cartProvider)`. Para una llamada a un metodo, `context.read<CartModel>().add(x)` se convierte en `ref.read(cartProvider.notifier).add(x)`.

   ```dart
   // Before
   class CartView extends StatelessWidget {
     @override
     Widget build(BuildContext context) {
       final items = context.watch<CartModel>().items;
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => context.read<CartModel>().add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   ```dart
   // After
   class CartView extends ConsumerWidget {
     @override
     Widget build(BuildContext context, WidgetRef ref) {
       final items = ref.watch(cartProvider);
       return Column(children: [
         for (final i in items) Text(i.name),
         ElevatedButton(
           onPressed: () => ref.read(cartProvider.notifier).add(Item('pen')),
           child: const Text('Add'),
         ),
       ]);
     }
   }
   ```

   Si el widget ya tenia su propio estado, usa `ConsumerStatefulWidget` mas `ConsumerState`, donde `ref` esta disponible como un campo. Quita la linea `ChangeNotifierProvider(create: (_) => CartModel())` de `MultiProvider`. Verifica: la pantalla se comporta igual y la lista de `MultiProvider` es una entrada mas corta.

5. **Reemplaza `ProxyProvider` con composicion `ref.watch`.** Este es el paso que borra mas codigo. Un `ProxyProvider` que construye B a partir de A se convierte en un provider que simplemente observa A.

   ```dart
   // Before: ProxyProvider wiring
   ProxyProvider<AuthModel, ApiClient>(
     update: (_, auth, __) => ApiClient(token: auth.token),
   ),
   ```

   ```dart
   // After: a provider that watches its dependency
   @riverpod
   ApiClient apiClient(ApiClientRef ref) {
     final token = ref.watch(authProvider.select((a) => a.token));
     return ApiClient(token: token);
   }
   ```

   `ref.watch(...select(...))` es el reemplazo directo de `context.select` de `provider`, y significa que `apiClient` solo se reconstruye cuando cambia `token`, no en cada actualizacion de `AuthModel`. Verifica: los widgets dependientes se reconstruyen cuando cambia el provider de arriba.

6. **Migra `FutureProvider` y `StreamProvider` a sus equivalentes en Riverpod.** Los nombres son los mismos; solo difiere el cableado. Un `FutureProvider` de `provider` se lee con tuberia al estilo `context.watch<AsyncSnapshot>`; el de Riverpod devuelve un `AsyncValue<T>` sobre el que haces switch directamente.

   ```dart
   // After: flutter_riverpod 3.3.1
   @riverpod
   Future<User> currentUser(CurrentUserRef ref) {
     return ref.watch(apiClientProvider).fetchUser();
   }

   // in a ConsumerWidget
   final userAsync = ref.watch(currentUserProvider);
   return userAsync.when(
     data: (user) => Text(user.name),
     loading: () => const CircularProgressIndicator(),
     error: (e, _) => Text('Failed: $e'),
   );
   ```

   Verifica: los estados de carga y error se renderizan sin banderas manuales `bool isLoading`. Para mas sobre este patron, mira el articulo enlazado sobre AsyncValue mas abajo.

7. **Elimina la dependencia de `provider`.** Una vez que `MultiProvider` este vacio, quitalo de `main.dart`, luego elimina `provider: ^6.1.5` de `pubspec.yaml` y ejecuta `flutter pub get`. El compilador marcara cualquier llamada restante a `context.watch`/`context.read`/`Provider.of`. Verifica: el proyecto compila con cero referencias a `package:provider`.

## Verificacion

Ejecuta esta lista de verificacion despues del ultimo paso, no solo al final:

- `flutter analyze` no reporta errores ni advertencias de `riverpod_lint`.
- `dart run build_runner build --delete-conflicting-outputs` termina limpio.
- `flutter test` pasa. Las pruebas de Riverpod usan `ProviderContainer` (o `ProviderContainer.test()` en 3.x) y `container.read(provider)`, reemplazando tus viejas pruebas unitarias de `ChangeNotifier`.
- Una pasada manual de humo: cada pantalla migrada sigue reconstruyendose al cambiar el estado, y ninguna pantalla lanza `ProviderNotFoundException` (no deberia quedar ninguna, por construccion).
- `grep -rn "package:provider" lib/` no devuelve nada.

## Plan de reversion

Esta migracion es reversible por caracteristica precisamente porque ambos paquetes coexisten. Si una pantalla migrada se comporta mal, revierte el commit de esa pantalla: vuelve a poner la linea `ChangeNotifierProvider` en `MultiProvider`, restaura la clase `ChangeNotifier`, y cambia el widget de vuelta a `StatelessWidget`. Como migraste primero las hojas y una caracteristica por commit, ninguna reversion toca mas de una pantalla. No elimines `provider` de `pubspec.yaml` (paso 7) hasta que tengas confianza, ya que esa es la unica puerta de un solo sentido en la secuencia.

## Detalles con los que tropezamos

**La mutacion en el lugar deja de reconstruir.** Esta es la sorpresa numero uno. En `provider`, `_items.add(x); notifyListeners()` funciona porque tu controlas la notificacion. En un `Notifier` de Riverpod, el framework reconstruye solo cuando a `state` se le asigna un valor que no es `==` al anterior. `state.add(x)` muta la misma lista, la referencia no cambia, y nada se reconstruye. Siempre asigna una nueva coleccion: `state = [...state, x]`. Lo mismo aplica a los objetos de modelo, por lo cual el estado inmutable (records, `copyWith`, o una clase `freezed`) se empareja naturalmente con Riverpod.

**Los providers no se liberan cuando el widget sale del arbol.** Un `ChangeNotifierProvider` de `provider` se libera cuando se quita su subarbol. Un provider de Riverpod, por defecto, mantiene su estado durante toda la vida del `ProviderScope`. Si dependias de que el controlador de una pantalla se reiniciara al salir de ella, ahora necesitas `autoDispose` (o, con generacion de codigo, ese es el comportamiento por defecto para providers anotados a menos que llames a `ref.keepAlive()`). Audita cualquier provider cuyo comportamiento antiguo dependia de la liberacion basada en el arbol.

**`ref.read` dentro de `build()` es una trampa.** Leer otro provider con `ref.read` dentro de un `Notifier.build()` o el `build` de un widget toma una instantanea del valor una sola vez y nunca se actualiza. Usa `ref.watch` para cualquier cosa que deba reaccionar, y reserva `ref.read` para manejadores de eventos como callbacks de botones. `riverpod_lint` marca la mayoria de estos por ti, por lo cual vale la pena instalar la dependencia de desarrollo desde el primer dia.

**`Consumer` existe en ambos paquetes.** Si importas ambos durante la migracion, `Consumer` es ambiguo. El `Consumer` de Riverpod toma un builder `(context, ref, child)`; el de `provider` toma `(context, value, child)`. Prefiere convertir el widget completo a `ConsumerWidget` en vez de meter un `Consumer` de Riverpod en un widget de la era de provider, y asi evitaras por completo el choque de imports.

La migracion premia ser aburrido: una hoja, un commit, ejecuta las pruebas, repite. Para cuando elimines `provider` de `pubspec.yaml`, la parte riesgosa ya paso hace semanas en pasos pequenos y reversibles.

## Relacionados

- Si vienes de una biblioteca de estado distinta, la [migracion de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) cubre el mismo enfoque de primero las hojas para un framework mas pesado.
- Aun lo estas decidiendo? La [comparacion de provider vs Riverpod vs Bloc](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) expone las concesiones antes de que te comprometas.
- Para el lado asincrono, [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) profundiza en `when` y `AsyncNotifier`.
- Vienes de `FutureBuilder` puro? Mira [FutureBuilder/StreamBuilder vs Riverpod AsyncValue](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).
- El error en tiempo de ejecucion mas comun despues de migrar: [Cannot use ref after the widget was disposed](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

## Fuentes

- [Documentacion de Riverpod: migrar desde pkg:provider (quickstart)](https://riverpod.dev/docs/from_provider/quickstart)
- [Documentacion de Riverpod: desde ChangeNotifier](https://riverpod.dev/docs/migration/from_change_notifier)
- [Documentacion de Riverpod: novedades en 3.0](https://riverpod.dev/docs/whats_new)
- [provider 6.1.5 en pub.dev](https://pub.dev/packages/provider/versions/6.1.5)
- [changelog de flutter_riverpod](https://pub.dev/packages/flutter_riverpod/changelog)

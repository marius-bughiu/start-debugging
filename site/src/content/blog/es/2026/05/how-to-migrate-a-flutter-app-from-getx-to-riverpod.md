---
title: "Cómo migrar una app de Flutter de GetX a Riverpod"
description: "Migración paso a paso de GetX a Riverpod 3.x en una app real de Flutter: GetxController a Notifier, .obs a providers derivados, Get.find a ref.watch, Get.to a go_router, además de snackbars, theming y pruebas. Probado en Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "getx"
  - "state-management"
  - "migration"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod"
translatedBy: "claude"
translationDate: 2026-05-06
---

La versión corta: instala `flutter_riverpod` junto a GetX, envuelve tu app en un `ProviderScope` y migra una pantalla a la vez. Reemplaza cada `GetxController` con un `Notifier` (o `AsyncNotifier` para trabajo asíncrono), traduce cada campo `.obs` en estado del notifier o en un `Provider` derivado de él, cambia `Get.find<T>()` por `ref.watch(myProvider)` y mueve el enrutamiento a `go_router` para que por fin puedas dejar `Get.to`. Snackbars, diálogos y cambios de tema se reconstruyen sobre las APIs estándar de Flutter. Probado en Flutter 3.27.1, Dart 3.11, flutter_riverpod 3.3.1, riverpod_generator 2.6.5 y go_router 14.6.

GetX se hizo popular porque respondía a cada pregunta con un solo import. Estado, rutas, inyección de dependencias, snackbars, internacionalización, theming, todo desde `package:get`. Esa fue su fortaleza en 2021 y se ha convertido en su problema en 2026: una sola dependencia que controla la mitad de tu runtime, una cultura de atajos sin `BuildContext` (`Get.context!`, `Get.snackbar`) que hace difícil razonar sobre la app y un ritmo de mantenimiento que ya no coincide con la cadencia de versiones de Flutter. Riverpod es la compensación opuesta. Hace una sola cosa (un grafo de estado con dependencias explícitas) y te obliga a apoyarte en las APIs estándar de Flutter para enrutamiento y la capa de UI. La migración es en su mayoría mecánica, pero algunos patrones se resistirán. Este post recorre los que afectan a todos los equipos.

## Lo que en realidad estás traduciendo

Antes de tocar el código, anota lo que GetX hace por ti. La mayoría de las apps se apoyan en cinco cosas:

1. `GetxController` más `Rx<T>` / `.obs` para el estado.
2. `Get.put` / `Get.lazyPut` / `Get.find` para inyección de dependencias.
3. `Obx` y `GetBuilder` para reconstruir widgets cuando cambia el estado.
4. `Get.to`, `Get.toNamed`, `Get.back` para la navegación.
5. `Get.snackbar`, `Get.dialog`, `Get.changeTheme` para efectos colaterales de UI.

Riverpod resuelve los puntos 1 a 3 directamente, con el boilerplate adecuado generado por código. Los puntos 4 y 5 quedan fuera de su alcance por diseño. Reemplazarás la navegación con `go_router` (o el `Navigator` integrado), y los snackbars, diálogos y cambios de tema vuelven a ser widgets ordinarios de Flutter que leen estado desde un provider. Esta es la parte de la migración que sorprende a la gente: Riverpod tiene un alcance menor que GetX, y ese es el punto.

## Agrega Riverpod sin quitar GetX

La migración gradual solo funciona si ambas bibliotecas pueden coexistir. Pueden, con una salvedad: `Get.put` mantiene su propio service locator y Riverpod tiene su propio árbol de providers, así que cada pieza de estado tiene exactamente un dueño a la vez. Elige ese dueño por pantalla, no por tipo.

```yaml
# pubspec.yaml. Flutter 3.27.1, Dart 3.11.
dependencies:
  flutter:
    sdk: flutter
  get: ^4.7.2
  flutter_riverpod: ^3.3.1
  riverpod_annotation: ^2.6.1
  go_router: ^14.6.2

dev_dependencies:
  build_runner: ^2.4.13
  riverpod_generator: ^2.6.5
  custom_lint: ^0.7.0
  riverpod_lint: ^2.6.5
```

Envuelve tu `GetMaterialApp` existente en un `ProviderScope`. Puedes mantener `GetMaterialApp` hasta que migres el enrutamiento; los dos árboles no chocan.

```dart
// lib/main.dart, Flutter 3.27.1
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:get/get.dart';

void main() {
  runApp(const ProviderScope(child: MyApp()));
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return GetMaterialApp(
      title: 'Migrating to Riverpod',
      home: const HomePage(),
      getPages: const [
        // existing GetX routes for screens not yet migrated
      ],
    );
  }
}
```

Agrega `riverpod_lint` a `analysis_options.yaml` una sola vez. Atrapa los dos errores que más duelen: leer un provider durante el build con `ref.read` y olvidar marcar como `final` un notifier cuando lo guardas.

## GetxController a Notifier, la pasada mecánica

Toma el controlador más simple que tengas. Los contadores son el hello-world de GetX, y la conversión es casi línea por línea.

```dart
// Before: GetX 4.7, Flutter 3.27.1
import 'package:get/get.dart';

class CounterController extends GetxController {
  final RxInt count = 0.obs;
  final RxBool busy = false.obs;

  Future<void> incrementAfterDelay() async {
    busy.value = true;
    await Future.delayed(const Duration(milliseconds: 200));
    count.value++;
    busy.value = false;
  }
}
```

El equivalente en Riverpod 3.x usa generación de código. El `counterProvider` generado cumple el rol de `Get.put` más `Obx`: posee el estado, sabe cómo reconstruir a sus dependientes y se libera a sí mismo cuando nadie lo lee.

```dart
// After: flutter_riverpod 3.3.1, riverpod_generator 2.6.5, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

class CounterState {
  const CounterState({this.count = 0, this.busy = false});

  final int count;
  final bool busy;

  CounterState copyWith({int? count, bool? busy}) =>
      CounterState(count: count ?? this.count, busy: busy ?? this.busy);
}

@riverpod
class Counter extends _$Counter {
  @override
  CounterState build() => const CounterState();

  Future<void> incrementAfterDelay() async {
    state = state.copyWith(busy: true);
    await Future.delayed(const Duration(milliseconds: 200));
    state = state.copyWith(count: state.count + 1, busy: false);
  }
}
```

Ejecuta `dart run build_runner watch -d` una vez y déjalo corriendo. El generador emite `counterProvider`, y tu widget lo lee igual que antes leía un `Obx`:

```dart
// flutter_riverpod 3.3.1
class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(counterProvider);
    final ctrl = ref.read(counterProvider.notifier);
    return Scaffold(
      body: Center(
        child: s.busy
            ? const CircularProgressIndicator()
            : Text('${s.count}'),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: ctrl.incrementAfterDelay,
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Dos cosas para interiorizar. Primero, `ref.watch` se suscribe; `ref.read` no. Usa `ref.read` solo dentro de callbacks (taps de botones, métodos de ciclo de vida), nunca en el método build. Segundo, la asignación `state =` hace el equivalente a `count.value++` más la reconstrucción, de forma atómica. Ya no existe un instante entre `busy.value = true` y la reconstrucción donde alguien más pueda observar un par de campos inconsistentes. Ese único cambio elimina una categoría de bugs que las apps con GetX tienden a acumular.

## Trabajo asíncrono: AsyncNotifier reemplaza el flag manual de carga

La mayoría de los controladores de GetX cargan su propio `isLoading.obs` porque `RxFuture` tiene aristas ásperas. Riverpod trata lo asíncrono como estado de primera clase con `AsyncValue<T>`. El mismo patrón de obtener una lista de usuarios se reduce a esto:

```dart
// flutter_riverpod 3.3.1, Dart 3.11
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'users.g.dart';

@riverpod
class Users extends _$Users {
  @override
  Future<List<User>> build() async {
    final api = ref.watch(apiClientProvider);
    return api.fetchUsers();
  }

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => ref.read(apiClientProvider).fetchUsers());
  }
}
```

El widget recibe los estados de carga, error y datos sin un solo campo booleano:

```dart
class UsersPage extends ConsumerWidget {
  const UsersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(usersProvider);
    return users.when(
      data: (list) => ListView(children: [for (final u in list) Text(u.name)]),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Failed: $e')),
    );
  }
}
```

Riverpod 3.0 también reintenta automáticamente los providers fallidos por defecto. Si no quieres eso (un 401 no debería reintentarse, por ejemplo), define `retry: (count, error) => null` en el provider o globalmente en el `ProviderScope`. Lee las [notas de migración 3.0 sobre retry](https://riverpod.dev/docs/3.0_migration) antes de cambiarlo; el comportamiento por defecto es genuinamente útil pero puede enmascarar bugs transitorios en pruebas.

## Inyección de dependencias: Get.find se convierte en ref.watch

GetX usa un service locator global. En cualquier parte de la app, `Get.find<ApiClient>()` devuelve la misma instancia. Riverpod lo reemplaza con un provider que construye el valor una vez por `ProviderContainer`.

```dart
// flutter_riverpod 3.3.1
@riverpod
ApiClient apiClient(Ref ref) {
  final dio = ref.watch(dioProvider);
  return ApiClient(dio);
}

@riverpod
Dio dio(Ref ref) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.com'));
  ref.onDispose(() => dio.close(force: true));
  return dio;
}
```

`ref.onDispose` es la parte para la que GetX nunca tuvo una respuesta limpia. Cuando el último consumidor de `dioProvider` desaparece, el cliente HTTP se cierra; si vuelve, el provider se reconstruye y obtienes un `Dio` nuevo. El ciclo de vida por fin es explícito. Para servicios que realmente viven para siempre, marca el provider con `keepAlive: true` (o evita `autoDispose`) y asume esa decisión en código en lugar de esperar que `Get.put(permanent: true)` sobreviva a un hot restart.

Para mantener ambos sistemas de DI funcionando durante la migración, registra un pequeño puente que entregue los singletons resueltos por GetX a los consumidores de Riverpod:

```dart
// Bridge: read from GetX, expose as a Riverpod provider
@riverpod
LegacyAuthService legacyAuth(Ref ref) => Get.find<LegacyAuthService>();
```

Elimina el puente apenas el lado de GetX no tenga nada más que registrar.

## Derivaciones reactivas: donde .obs realmente brilla, y cómo Riverpod lo reemplaza

`.obs` hace que el estado derivado parezca gratis. `final fullName = ''.obs;` más `ever(firstName, (_) => fullName.value = '$firstName $lastName')` es una sola línea. El equivalente en Riverpod es un provider separado que lista sus entradas:

```dart
// flutter_riverpod 3.3.1
@riverpod
String fullName(Ref ref) {
  final first = ref.watch(firstNameProvider);
  final last = ref.watch(lastNameProvider);
  return '$first $last';
}
```

La ventaja es que `fullNameProvider` se recalcula solo cuando una de sus entradas realmente cambia (Riverpod 3 usa `==` para filtrar igualdad, una mejora sobre la antigua comprobación con `identical`), y cualquier widget que lo lea se reconstruye solo cuando el string derivado cambia. El costo es que tienes que nombrar cada entrada. Ese nombrado es la decisión editorial más difícil de la migración. Resiste la tentación de meter todo en un mega-notifier; los providers pequeños componen mejor y son mucho más fáciles de probar.

Para derivaciones que necesitan cancelación (un cuadro de búsqueda que pega a la red mientras el usuario escribe), usa un `AsyncNotifier` y cancela mediante `ref.onDispose` más un `CancelToken`. Eso reemplaza el `debounce(query, ..., time: ...)` de GetX con código que sobrevive a las pruebas unitarias.

## Enrutamiento: deja Get.to y adopta go_router

Este es el paso que los equipos posponen más tiempo porque el enrutamiento de GetX en realidad funciona. Paga el costo temprano. Una vez que `go_router` controla la navegación, el resto de la migración se acelera porque ya no necesitas `Get.context` en los controladores.

```dart
// go_router 14.6.2, Flutter 3.27.1
final goRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const HomePage()),
      GoRoute(path: '/users/:id', builder: (_, s) => UserPage(id: s.pathParameters['id']!)),
    ],
    redirect: (ctx, state) {
      final auth = ProviderScope.containerOf(ctx).read(authProvider);
      if (!auth.isLoggedIn && state.matchedLocation != '/login') return '/login';
      return null;
    },
  );
});

class MyApp extends ConsumerWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(goRouterProvider);
    return MaterialApp.router(
      routerConfig: router,
      theme: ref.watch(themeProvider),
    );
  }
}
```

Reemplaza `Get.to(NextPage())` con `context.go('/next')`, `Get.toNamed('/users/42')` con `context.go('/users/42')` y `Get.back()` con `context.pop()`. Las rutas tipadas como string parecen un retroceso frente a los constructores de página tipados al principio; en la práctica escribes una pequeña `extension` sobre `BuildContext` que envuelve los strings, y la verificación de enlaces viene de `go_router_builder` o de tus pruebas.

## Snackbars, diálogos, temas: de vuelta a Flutter puro

`Get.snackbar` es conveniente porque no necesita un `BuildContext`. Esa conveniencia es también la razón por la que no puedes probarlo. La respuesta idiomática de Riverpod es una señal de solo estado que la UI consume:

```dart
// flutter_riverpod 3.3.1
@riverpod
class Toast extends _$Toast {
  @override
  String? build() => null;

  void show(String message) => state = message;
  void clear() => state = null;
}

class ToastListener extends ConsumerWidget {
  const ToastListener({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(toastProvider, (_, next) {
      if (next != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(next)));
        ref.read(toastProvider.notifier).clear();
      }
    });
    return child;
  }
}
```

Envuelve la parte de tu árbol que tenga un ancestro `Scaffold` en `ToastListener`. Ahora cualquier controlador puede llamar `ref.read(toastProvider.notifier).show('Saved')` sin tocar `BuildContext`, y las pruebas hacen aserciones sobre el estado del provider en lugar de interceptar un overlay.

El theming es similar. `Get.changeTheme` se vuelve un `themeProvider` que `MaterialApp.router` observa. La localización puede seguir usando `Get.locale` hasta que la migres al final, o moverse a `flutter_localizations` más un `localeProvider`.

## Las pruebas se vuelven más rápidas y claras

El mayor beneficio está en las pruebas. Una prueba de un controlador GetX normalmente necesita `Get.testMode = true` más un cuidadoso teardown de los singletons. Una prueba de Riverpod crea un `ProviderContainer`, sobrescribe exactamente los providers que le interesan y los libera al final:

```dart
// flutter_test, flutter_riverpod 3.3.1
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('Counter increments after delay', () async {
    final container = ProviderContainer(overrides: const []);
    addTearDown(container.dispose);

    final notifier = container.read(counterProvider.notifier);
    expect(container.read(counterProvider).count, 0);

    final f = notifier.incrementAfterDelay();
    expect(container.read(counterProvider).busy, true);
    await f;
    expect(container.read(counterProvider).count, 1);
    expect(container.read(counterProvider).busy, false);
  });
}
```

Sobrescribe los providers para inyectar fakes (`apiClientProvider.overrideWithValue(FakeApi())`) y ya no necesitas un framework de mocking para la mayoría de los casos. En Riverpod 3 los listeners se pausan cuando no son visibles, pero en pruebas cada container es "visible" por defecto a menos que lo modeles explícitamente, así que el cambio es invisible para las suites de pruebas existentes.

## Tropiezos que la migración siempre encuentra

**`autoDispose` frente a singletons.** Los providers `@riverpod` generados por código son auto-dispose por defecto. Si convertiste un controlador `Get.put(permanent: true)` y notas que el estado se reinicia al salir de la pantalla, marca el provider con `@Riverpod(keepAlive: true)`. Hazlo deliberadamente; el estado permanente es una fuga de memoria esperando ocurrir.

**Leer providers en `initState`.** Un patrón común de GetX es `final c = Get.find<MyController>()` en `initState`. El equivalente en Riverpod es `ref.read(myProvider.notifier)` en `initState`, pero solo dentro de un `ConsumerStatefulWidget`. Leer dentro de `build` está bien para `ref.watch`; leer `notifier` una vez en `initState` y guardarlo es un mal olor, porque la identidad del notifier puede cambiar después de un `ref.invalidate`. Prefiere `ref.read` en el sitio de la llamada.

**Tareas en segundo plano bajo cambios de ruta.** Riverpod 3 pausa los listeners en widgets invisibles, lo cual normalmente es lo que quieres, pero cambia el momento del trabajo que antes se mantenía vivo por el ansioso `Obx` de GetX. Si una actualización de red tiene que seguir ejecutándose mientras el usuario está en otra pestaña, dale ese trabajo a un `AsyncNotifier` con `keepAlive: true` en lugar de esperar que un widget pausado lo conduzca.

**Hot restart deja caer primero el lado de GetX.** Durante la fase de doble biblioteca, un hot restart reinicia las instancias de `Get.put` pero el estado de Riverpod sobrevive si el `ProviderScope` está en la cima del árbol. Eso es genuinamente útil para la migración: puedes hacer hot-restart, ver que el estado de Riverpod se mantiene y confirmar lo que te queda por mover.

**Errores de compilación de `Obx` tras la eliminación.** Cuando eliminas el import de GetX de un archivo, las llamadas restantes a `Obx(...)` se vuelven un error de compilación duro en lugar de una advertencia en runtime. Busca en el proyecto `Obx(` y `GetBuilder<` antes de hacer commit; el compilador los atrapará pero una sola pasada con grep ahorra un ciclo de compilación.

## Cómo encaja esto con el resto de tu pipeline de Flutter

La migración rara vez es la única tarea de Flutter en curso. Si además ejecutas [una matriz de CI multi-versión](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), fija explícitamente tanto `flutter_riverpod` como los archivos `*.g.dart` generados para que un bump del SDK de Dart no regenere silenciosamente boilerplate que rompa una rama vieja. El trabajo intensivo de CPU que solía vivir en un controlador GetX (parseo, hashing, reducciones grandes) pertenece [a un isolate de Dart](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) de todos modos, y el cambio a `AsyncNotifier` hace ese traspaso más limpio porque el estado de carga ya es de primera clase. Si un notifier necesita llamar a código nativo, [agrégalo mediante un platform channel sin escribir un plugin](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) y luego expón el canal como su propio provider para que las pruebas puedan sobrescribirlo. Y cuando la migración termine y embarques una build que necesita ser depurada en un dispositivo real, el [flujo de trabajo de iOS desde Windows con un dispositivo real](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) sigue aplicando; nada sobre la biblioteca de estado cambia cómo se comporta el puerto del observatory.

El modelo mental más corto para la migración: GetX intercambia corrección por ergonomía, Riverpod intercambia ergonomía por corrección. No estás reescribiendo tu app, estás renombrando y reasignando el alcance de su grafo de estado. Hazlo pantalla por pantalla, deja la fase de doble biblioteca corriendo hasta que cada `Get.find` haya desaparecido y no te saltes el paso del enrutamiento. Para cuando el último import de `package:get` salga de `pubspec.yaml`, el código será más pequeño, y las pruebas serán la parte que dejes de temer.

## Enlaces de referencia

- [Guía de migración a Riverpod 3.0](https://riverpod.dev/docs/3.0_migration)
- [flutter_riverpod en pub.dev](https://pub.dev/packages/flutter_riverpod)
- [riverpod_generator en pub.dev](https://pub.dev/packages/riverpod_generator)
- [go_router en pub.dev](https://pub.dev/packages/go_router)
- [Recetas de pruebas de Riverpod](https://riverpod.dev/docs/essentials/testing)
- [Paquete GetX en pub.dev](https://pub.dev/packages/get)

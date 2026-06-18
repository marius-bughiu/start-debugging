---
title: "Migra de FutureBuilder a un AsyncNotifier de Riverpod en Flutter (flutter_riverpod 3.3.2)"
description: "Una migración paso a paso de un widget FutureBuilder en línea a un AsyncNotifier de Riverpod en una app real de Flutter: saca el trabajo asíncrono de build, exponlo como un provider, renderiza con .when() o coincidencia de patrones con switch, y agrega métodos de refresco y mutación. Probado en Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-06-18
updatedDate: 2026-06-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
lang: "es"
translationOf: "2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-18
---

Mover una pantalla de `FutureBuilder` a un `AsyncNotifier` de Riverpod suele ser un trabajo de 30 a 60 minutos por pantalla, y la mayor parte de ese tiempo se gasta borrando código en lugar de escribirlo. Lo que cambia: el Future que solías crear dentro de `build` se mueve a un provider, el widget pierde su plantilla repetitiva de `StatefulWidget`, y cualquier lógica manual de reintento con `setState` se reemplaza por `ref.invalidate`. Vale la pena hacerlo en el momento en que un segundo widget necesita los mismos datos, quieres caché entre navegaciones, o necesitas disparar un refresco desde un lugar distinto al widget que posee el `FutureBuilder`. Si una pantalla realmente posee un Future de una sola vez que nada más toca, déjala como un `FutureBuilder` -- esta migración no te aporta nada ahí.

Esta guía usa Flutter 3.44, Dart 3.x y `flutter_riverpod` 3.3.2. Los fragmentos de generación de código asumen `riverpod_annotation` 3.x y `riverpod_generator` 3.x con `build_runner`.

## Por qué abandonar FutureBuilder

- **El Future deja de recrearse en cada reconstrucción.** Un `FutureBuilder` cuyo `future:` se compila en línea vuelve a ejecutar su trabajo asíncrono cada vez que el padre se reconstruye. Un `AsyncNotifier` compila una vez y guarda el resultado en caché hasta que lo invalidas. (Si por ahora te quedas con `FutureBuilder`, la solución para ese error específico se trata en [evitar que FutureBuilder recree su Future](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)
- **Los datos pasan a ser compartibles.** Dos widgets que observan el mismo provider acceden a la caché, no a dos llamadas de red separadas.
- **El refresco y la mutación obtienen un hogar real.** El deslizar-para-refrescar, el reintento-en-error y las actualizaciones optimistas se convierten en métodos del notifier en lugar de gimnasia con `setState` en el widget.
- **Los errores son tipados, no tragados.** `AsyncValue` carga `loading`, `data` y `error` (con traza de pila) como estados de primera clase sobre los que haces coincidencia de patrones.

## Qué cambia

| Área | Antes (`FutureBuilder`) | Después (`AsyncNotifier`) | Severidad |
| --- | --- | --- | --- |
| Dónde vive el Future | Creado en `build` o `initState` | Método `build()` del notifier | alta |
| Tipo de widget | Normalmente `StatefulWidget` | `ConsumerWidget` (sin estado) | media |
| Renderizado de carga/error | `snapshot.connectionState` + `snapshot.hasError` | `AsyncValue.when` o `switch` | media |
| Reintento | Reconstruir + recrear el Future | `ref.invalidate(provider)` | baja |
| Mutaciones | `setState` después de `await` | método + `AsyncValue.guard` | media |
| Cancelación al desecharse | Comprobaciones manuales de `mounted` | Automática vía `ref.onDispose` | baja |

El único elemento de severidad realmente alta es dónde vive el Future: todo lo demás se deriva de moverlo.

## Lista de verificación previa

- `flutter --version` reporta 3.44 o posterior, Dart 3.x.
- `flutter_riverpod: ^3.3.2` está en `pubspec.yaml`. Si quieres generación de código, agrega también `riverpod_annotation: ^3.0.0`, y bajo `dev_dependencies` agrega `riverpod_generator: ^3.0.0` y `build_runner`.
- Tu app está envuelta en un `ProviderScope` en la raíz. Si no lo está, ese es el paso cero:

```dart
// Flutter 3.44, flutter_riverpod 3.3.2
void main() {
  runApp(const ProviderScope(child: MyApp()));
}
```

- Elige un widget para migrar primero. No conviertas toda la app en un solo commit. Haz una prueba rápida de cada pantalla conforme avanzas.

## El punto de partida: un FutureBuilder en línea

Aquí está el patrón del que estamos migrando. Una pantalla de perfil obtiene un usuario y renderiza tres estados a mano. El error incrustado en él es el clásico: `repo.fetchUser(userId)` se ejecuta de nuevo en cada reconstrucción porque el Future se crea dentro de `build`.

```dart
// Flutter 3.44, Dart 3.x -- the BEFORE
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context) {
    final repo = UserRepository();
    return FutureBuilder<User>(
      future: repo.fetchUser(userId), // re-runs on every rebuild
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text('Failed: ${snapshot.error}'));
        }
        final user = snapshot.data!;
        return Text(user.name);
      },
    );
  }
}
```

## Pasos de la migración

1. **Declara el provider.** Mueve la llamada asíncrona a un notifier. Hay dos maneras de escribirlo; elige una y mantente consistente en todo el código base.

**Estilo con generación de código (recomendado para código nuevo):**

```dart
// flutter_riverpod 3.3.2, riverpod_annotation 3.x
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'profile_controller.g.dart';

@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

El parámetro `userId` en `build` convierte esto en una familia: `profileControllerProvider(userId)` te da un notifier en caché por cada id. Ejecuta el generador y verifica que produce el archivo `.g.dart` sin errores:

```bash
# verify: the build completes and emits profile_controller.g.dart
dart run build_runner build --delete-conflicting-outputs
```

**Estilo manual (sin generación de código):**

```dart
// flutter_riverpod 3.3.2
final profileControllerProvider =
    AsyncNotifierProvider.family<ProfileController, User, String>(
  ProfileController.new,
);

class ProfileController extends FamilyAsyncNotifier<User, String> {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

Ambos producen un provider cuyo valor es un `AsyncValue<User>`. El `build` del notifier se ejecuta una vez por `userId` y el resultado se guarda en caché hasta que se invalida. Nota que ya no construyes `UserRepository()` a mano: inyéctalo a través de otro provider para que sea testeable y compartido.

2. **Convierte el widget en un `ConsumerWidget`.** El `StatefulWidget`/`StatelessWidget` se convierte en un `ConsumerWidget`, y `build` gana un `WidgetRef`. Lee el provider con `ref.watch`, luego renderiza el `AsyncValue`.

```dart
// flutter_riverpod 3.3.2 -- the AFTER
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(profileControllerProvider(userId));
    return userAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => Center(child: Text('Failed: $err')),
      data: (user) => Text(user.name),
    );
  }
}
```

Verifica: haz un hot-restart de la pantalla. Debería obtener exactamente una vez. Navega fuera y de vuelta -- no debería volver a obtener (la caché sigue viva mientras algo mantenga el provider montado). Ese comportamiento de obtención única es el punto central de la migración.

3. **Renderiza con coincidencia de patrones con switch (opcional pero más limpio).** La coincidencia de patrones de Dart 3 se lee mejor que `.when()` para algunos equipos y te permite mantener visibles los datos obsoletos durante un refresco. El tratamiento completo de estos patrones vive en [mostrar estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), pero la versión corta:

```dart
// Dart 3.x switch over AsyncValue
final userAsync = ref.watch(profileControllerProvider(userId));
return switch (userAsync) {
  AsyncData(:final value) => Text(value.name),
  AsyncError(:final error) => Text('Failed: $error'),
  _ => const Center(child: CircularProgressIndicator()),
};
```

Verifica: esto compila sin la advertencia `non-exhaustive switch`. El `_` general maneja `AsyncLoading`.

4. **Reemplaza el reintento con `ref.invalidate`.** La antigua ruta de reintento recreaba el Future mediante reconstrucción. Ahora el reintento es una sola línea. Agrega un botón a la rama de error:

```dart
// flutter_riverpod 3.3.2
error: (err, stack) => Center(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('Failed: $err'),
      ElevatedButton(
        onPressed: () => ref.invalidate(profileControllerProvider(userId)),
        child: const Text('Retry'),
      ),
    ],
  ),
),
```

`ref.invalidate` descarta el valor en caché y vuelve a ejecutar `build`, lo que regresa el `AsyncValue` a `loading` y luego a `data` o `error`. Verifica: fuerza un error (apaga la red), toca Retry con la red de vuelta, confirma que transiciona a loading y luego a data.

5. **Agrega mutaciones con `AsyncValue.guard`.** Esta es la capacidad que `FutureBuilder` nunca tuvo. Para actualizar el usuario y reflejar el resultado, agrega un método al notifier. `AsyncValue.guard` envuelve la llamada asíncrona de modo que una excepción lanzada se convierte en un `AsyncError` en lugar de un fallo no controlado.

```dart
// flutter_riverpod 3.3.2
@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
  }
}
```

Llámalo desde el widget con `ref.read(...).rename(...)` dentro de un callback (usa `read`, no `watch`, en los callbacks). Verifica: dispara un rename, observa cómo la UI pasa a loading y luego muestra el nuevo nombre; dispara un rename que falle y confirma que se renderiza el estado de error en lugar de lanzar.

## Verificación

Ejecuta esta lista de verificación después de migrar una pantalla:

- `flutter analyze` no reporta nuevas advertencias, y si usaste codegen, `dart run build_runner build` se completa limpio.
- La pantalla obtiene exactamente una vez al abrirse por primera vez (agrega un print en el repositorio u observa la pestaña de red).
- Navegar fuera y de vuelta no vuelve a obtener a menos que invalides.
- La rama de error se renderiza ante un fallo forzado y Retry se recupera.
- `flutter test` pasa. Los providers son trivialmente testeables: sobrescribe `userRepositoryProvider` con un falso en un `ProviderContainer` y haz una aserción sobre el `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.3.2
test('loads the user', () async {
  final container = ProviderContainer(overrides: [
    userRepositoryProvider.overrideWithValue(FakeUserRepository()),
  ]);
  addTearDown(container.dispose);

  final user = await container.read(profileControllerProvider('42').future);
  expect(user.name, 'Ada');
});
```

## Plan de reversión

Esta migración es reversible por pantalla porque puedes convertir un widget a la vez. Para revertir una sola pantalla, restaura el widget `FutureBuilder` y borra su provider; nada más depende de él si migraste de forma incremental. La única puerta de un solo sentido es eliminar la antigua fontanería de `StatefulWidget` en muchas pantallas en un solo commit -- no hagas eso. Mantén la migración de cada pantalla en su propio commit para que una reversión sea un `git revert` de una sola línea.

## Tropiezos que tuvimos

**`ref.watch` dentro de callbacks no reconstruye nada útil.** En un manejador `onPressed` usa `ref.read`. `watch` es para `build`; usarlo en un callback se suscribe en el momento equivocado y es una fuente común de confusión del tipo "mi botón no refresca la pantalla".

**El parámetro de la familia debe ser estable.** `profileControllerProvider(userId)` indexa la caché por `userId`. Si por accidente pasas un objeto recién construido (una nueva instancia de `User`, un map) en lugar de una clave de igual valor, obtienes un notifier nuevo en cada reconstrucción y la caché nunca acierta. Usa primitivos o tipos con un `==` adecuado.

**`ref` desechado después de un await.** Si una mutación hace await y el provider se desecha a mitad de camino (el usuario navegó fuera), tocar `ref` después lanza. Riverpod 3 expone esto con claridad; la solución y el mensaje exacto están en [solucionar "Cannot use ref after the widget was disposed"](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Protégete con `ref.mounted` si debes tocar `ref` después de un await en una mutación larga.

**El provider se desecha demasiado pronto.** Por defecto, un provider sin listeners se desecha. Si navegas fuera y de vuelta y ves una reobtención que no querías, ese es el auto-dispose haciendo su trabajo. Mantenlo vivo deliberadamente con `ref.keepAlive()` dentro de `build`, o acepta la reobtención como comportamiento correcto de caché.

**No mezcles esto con el estado del paquete `provider`.** Si tu app aún usa el paquete heredado `provider` en otros lugares, migra eso por separado; los dos coexisten pero difuminan el modelo mental. La [migración de provider a Riverpod](/es/2026/06/migrate-from-provider-to-riverpod-in-flutter/) cubre esa ruta. Y si aún estás decidiendo si `AsyncNotifier` es siquiera la opción correcta para un widget dado, la [guía de decisión FutureBuilder vs Riverpod AsyncValue](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) traza la línea.

## Fuentes

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- guía oficial de migración de Riverpod para el `Ref` unificado y los cambios del notifier.
- [(Async)NotifierProvider](https://riverpod.dev/docs/providers/notifier_provider) -- el contrato canónico de `AsyncNotifier` y `build()`.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- la lista de funcionalidades y cambios disruptivos de 3.0.
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) -- confirmación de la versión 3.3.2.

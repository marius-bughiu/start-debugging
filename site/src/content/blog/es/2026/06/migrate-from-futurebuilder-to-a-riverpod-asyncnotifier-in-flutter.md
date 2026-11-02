---
title: "Migra de FutureBuilder a un AsyncNotifier de Riverpod en Flutter (flutter_riverpod 3.3.2)"
description: "Migración de FutureBuilder a Riverpod 3 AsyncNotifier con un proveedor family manual probado, duración de caché y reintentos explícitos y mutaciones seguras."
pubDate: 2026-06-18
updatedDate: 2026-11-02
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

Mueve una petición de `FutureBuilder` a `AsyncNotifier` cuando varios widgets necesiten el mismo estado o quieras centralizar mutaciones. La migración es opcional: un Future almacenado y exclusivo de un widget sigue encajando en `FutureBuilder`. El problema es crear una petición nueva en `build()`, no el propio `FutureBuilder`.

Este ejemplo usa la API manual de Riverpod 3 con **flutter_riverpod 3.3.2**, comprobada en **Flutter 3.44.8 / Dart 3.12.2**. No usa generación de código. Los dos bloques Dart pertenecen al mismo archivo. Fija `flutter_riverpod: 3.3.2` para reproducir la versión probada; no se afirma que sea la más reciente.

## Mover la petición y la mutación al proveedor

`UserRepository` define el contrato con tu aplicación. Impleméntalo con tu cliente API y sobrescribe `userRepositoryProvider` dentro del `ProviderScope` raíz. La implementación predeterminada falla deliberadamente si falta esa configuración. En los tests, usa un fake en memoria.

En Riverpod 3, un notifier family manual extiende `AsyncNotifier<User>`, recibe el ID en el constructor y tiene `build()` sin parámetros. `FamilyAsyncNotifier<User, String>` pertenece a la API anterior. El siguiente proveedor activa la eliminación automática y desactiva los reintentos automáticos para que el botón Retry controle la recuperación del ejemplo.

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class User {
  const User(this.name);
  final String name;
}

abstract class UserRepository {
  Future<User> fetchUser(String id);
  Future<void> rename(String id, String name);
}

final userRepositoryProvider = Provider<UserRepository>(
  (ref) => throw UnimplementedError('Override with your repository'),
);

final profileControllerProvider =
    AsyncNotifierProvider.autoDispose.family<ProfileController, User, String>(
  ProfileController.new,
  retry: (retryCount, error) => null,
);

class ProfileController extends AsyncNotifier<User> {
  ProfileController(this.userId);
  final String userId;

  @override
  Future<User> build() {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    if (state.isLoading) return;
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncLoading();
    final next = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
    if (!ref.mounted) return;
    state = next;
  }
}
```

`AsyncValue.guard` convierte una mutación fallida en estado de error. Después del await, `ref.mounted` evita escribir en un notifier eliminado. La comprobación de carga evita renombres simultáneos por este método; no es una transacción ni cancela HTTP.

## Mostrar el estado compartido

Sustituye la pantalla por este `ConsumerWidget`. `ref.watch` se suscribe durante build; los callbacks usan `ref.read` o `ref.invalidate`. `skipLoadingOnRefresh: false` muestra la rama de carga tras invalidar incluso si hay datos anteriores.

```dart
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref.watch(profileControllerProvider(userId)).when(
      skipLoadingOnRefresh: false,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Column(
        children: [
          Text('Failed: $error'),
          ElevatedButton(
            onPressed: () => ref.invalidate(profileControllerProvider(userId)),
            child: const Text('Retry'),
          ),
        ],
      ),
      data: (user) => Column(
        children: [
          Text(user.name),
          ElevatedButton(
            onPressed: () => ref
                .read(profileControllerProvider(userId).notifier)
                .rename('Grace'),
            child: const Text('Rename'),
          ),
        ],
      ),
    );
  }
}
```

## Decidir cuánto vive el resultado

- Los widgets con la misma clave family en el mismo scope comparten el estado activo. Las claves necesitan igualdad y `hashCode` estables.
- `.autoDispose` permite eliminar el estado cuando no quedan listeners. Volver después de su eliminación hace otra petición. Un cambio de dependencia o una invalidación también puede ejecutar `build()` de nuevo.
- Sin generación de código, la eliminación automática es opcional. Los proveedores generados con `@riverpod` la activan por defecto. No son valores predeterminados equivalentes. Usa `ref.keepAlive()` o una política de caché solo si buscas conservar el estado.
- Riverpod 3 reintenta por defecto los fallos de inicialización elegibles. El ejemplo lo desactiva con `retry: (_, _) => null`; elige una política apropiada para tu aplicación. `AsyncValue.guard` no reintenta automáticamente los métodos de mutación.
- `ref.onDispose` es un hook, no cancelación automática de peticiones. Conéctalo al mecanismo de cancelación o limpieza de tu cliente HTTP cuando haga falta.

Un switch solo sobre `AsyncData` y `AsyncError` no garantiza conservar datos anteriores durante una actualización. Define explícitamente la política de presentación; `.when()` también ofrece opciones de carga y refresh. Para pull-to-refresh, espera `ref.refresh(profileControllerProvider(userId).future)` para que el gesto termine junto con la petición.

## Verificar la migración

El código corregido superó el análisis y tests de proveedores/widgets para lecturas compartidas, invalidación, eliminación y nueva petición, error y recuperación manual, renombre correcto y fallido, y finalización después de eliminar el notifier. Los tests usan un repositorio fake; no validan tu servicio ni tu autenticación. Ejecuta comprobaciones equivalentes en tu aplicación:

```bash
flutter analyze
flutter test
```

Migra una pantalla cada vez. Para revertirla, restaura su implementación con Future almacenado y elimina el proveedor sin uso. Evita crear un Future nuevo en cada build.

**Corrección del 2 de noviembre de 2026:** se sustituyó la API family de Riverpod 2, se explicitaron eliminación y reintentos, se corrigieron las afirmaciones sobre navegación, caché y cancelación, y se añadió la comprobación del ciclo de vida tras await. La guía de versión 2 ya no se presenta como documentación de Riverpod 3.

## Fuentes y lecturas relacionadas

- [Flutter: FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Riverpod 3: migration](https://riverpod.dev/docs/3.0_migration)
- [Riverpod: families](https://riverpod.dev/docs/concepts2/family)
- [Riverpod: automatic disposal](https://riverpod.dev/docs/concepts2/auto_dispose)
- [Riverpod: automatic retry](https://riverpod.dev/docs/concepts2/retry)
- [Riverpod: request cancellation](https://riverpod.dev/docs/how_to/cancel)
- [flutter_riverpod 3.3.2](https://pub.dev/packages/flutter_riverpod/versions/3.3.2)

- [FutureBuilder / Future](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Ref / dispose](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/)
- [provider → Riverpod](/es/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [FutureBuilder / Riverpod](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)

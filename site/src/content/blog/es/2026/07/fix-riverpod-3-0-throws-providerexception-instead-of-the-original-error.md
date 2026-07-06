---
title: "Solución: Riverpod 3.0 lanza ProviderException en lugar del error original"
description: "Riverpod 3.0 envuelve en un ProviderException los errores lanzados al leer un provider. Captura ese tipo y lee e.exception para recuperar tu error original, o usa AsyncValue.error, que viene sin envolver."
pubDate: 2026-07-06
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "es"
translationOf: "2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error"
translatedBy: "claude"
translationDate: 2026-07-06
---

Tu `on NotFoundException catch` dejó de dispararse tras la actualización a Riverpod 3.0 porque leer un provider que falló ya no vuelve a lanzar tu excepción original. Vuelve a lanzar un `ProviderException` que la envuelve. Para arreglar un `try`/`catch` roto, captura `ProviderException` e inspecciona `e.exception` en busca de tu error real, o cambia a `AsyncValue.error`, que se deja sin envolver a propósito. Esto está probado en `flutter_riverpod` 3.x (la línea 3.0 salió en septiembre de 2025; la versión actual es la 3.3.2, de junio de 2026), Flutter 3.44 y Dart 3.x.

La actualización no introdujo una falla nueva. Tu provider sigue lanzando la misma excepción que siempre lanzó. Lo que cambió es el tipo que sale por el otro lado cuando otro fragmento de código lee ese provider de forma imperativa.

## El error en contexto

Tienes un provider cuyo `build` lanza una excepción de dominio, y un llamador que lo lee dentro de un `try`/`catch`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
try {
  final user = await ref.read(userProvider.future);
  showProfile(user);
} on NotFoundException catch (e) {
  showNotFound(e.id); // never runs on Riverpod 3.0
}
```

En Riverpod 2.x esto capturaba `NotFoundException` directamente. En 3.0 la cláusula `on NotFoundException` se omite, y si no tienes un `catch` más amplio, la excepción se propaga sin capturarse. Si registras el tipo de tiempo de ejecución real, ves:

```
Unhandled exception:
ProviderException: An exception/error was thrown while building UserProvider.
  <original NotFoundException and its stack trace nested here>
```

El `NotFoundException` sigue ahí dentro. Ahora es un pasajero dentro de `ProviderException` en lugar de la cosa que se lanza.

## Por qué Riverpod 3.0 envuelve el error

Un provider puede estar en estado de error por dos razones muy distintas, y Riverpod 2.x no podía distinguirlas en el punto donde capturabas el error.

La primera razón: **este provider falló**. Su propio `build` lanzó. La segunda razón: **este provider está bien, pero un provider del que depende falló**, y el error se propagó hacia abajo por el grafo. En una cadena de dependencias como `dashboardProvider` observando `userProvider` observando `authProvider`, una excepción en `authProvider` aflora en cada lectura descendente. Si los tres volvieran a lanzar el `AuthException` crudo, un `catch` alrededor de `dashboardProvider` no podría distinguir entre "el dashboard en sí se rompió" y "algo tres niveles más arriba se rompió y estoy viendo el eco".

Riverpod 3.0 lo resuelve envolviendo. Cuando lees un provider cuyo valor no se pudo calcular, el error se encapsula en un `ProviderException` que registra **qué provider** lanzó y lleva el error original más su traza de pila. El envoltorio es la señal de que estás viendo una falla de provider propagada, y la propiedad `.exception` es la vía de escape de vuelta a tu error real. Este es el comportamiento descrito en la [guía de migración de Riverpod 3.0](https://riverpod.dev/docs/3.0_migration) y registrado en el [issue 4320 de riverpod](https://github.com/rrousselGit/riverpod/issues/4320).

Aquí hay un pequeño trozo de historia que vale la pena conocer. Riverpod temprano (anterior a 2.0) también envolvía en `ProviderException`, luego `2.0.0-dev.1` quitó el envoltorio y cambió a volver a lanzar la excepción cruda, y `3.0.0-dev.16` trajo el envoltorio de vuelta a propósito. Si recuerdas que `ProviderException` desapareció hace años, no lo recuerdas mal; 3.0 lo reintrodujo a propósito.

## Reproducción mínima

Dos archivos. Un provider que lanza, y un widget que lo lee de forma imperativa.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- reproduces the wrap.
import 'package:flutter_riverpod/flutter_riverpod.dart';

class NotFoundException implements Exception {
  const NotFoundException(this.id);
  final String id;
}

final userProvider = FutureProvider.autoDispose<User>((ref) async {
  final user = await ref.read(apiProvider).findUser('42');
  if (user == null) throw const NotFoundException('42');
  return user;
});
```

```dart
// The caller. On 2.x this printed "not found: 42".
// On 3.0 nothing prints and the ProviderException escapes.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on NotFoundException catch (e) {
    debugPrint('not found: ${e.id}');
  }
}
```

Ejecuta `load` cuando el usuario no existe. En 3.0 la cláusula `on NotFoundException` no coincide porque el objeto lanzado es un `ProviderException`, no un `NotFoundException`.

## La solución, en detalle

Elige el enfoque que coincida con cómo estás consumiendo el provider. En orden de preferencia:

### 1. Captura ProviderException y haz switch sobre e.exception

Si debes leer el provider de forma imperativa (dentro de un manejador de eventos, una mutación, un `ref.read` en un callback), captura el envoltorio y saca el error original de `.exception`:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- the direct fix.
Future<void> load(WidgetRef ref) async {
  try {
    await ref.read(userProvider.future);
  } on ProviderException catch (e) {
    switch (e.exception) {
      case NotFoundException(:final id):
        debugPrint('not found: $id');
      case SocketException():
        debugPrint('offline');
      default:
        rethrow; // do not swallow errors you did not plan for
    }
  }
}
```

`e.exception` es el objeto original que lanzaste, así que un `switch` con patrones de Dart sobre él se lee limpiamente y te permite enlazar campos (`:final id`) en la misma línea. Mantén siempre un `default: rethrow` para que un error inesperado no se coma en silencio; un `on ProviderException catch` a secas sin rethrow se tragará cada tipo de error futuro que olvides enumerar.

Si prefieres comprobaciones con `is` en lugar de patrones, el equivalente es:

```dart
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    final id = (e.exception as NotFoundException).id;
    debugPrint('not found: $id');
  } else {
    rethrow;
  }
}
```

### 2. Lee el error a través de AsyncValue, que no viene envuelto

Esta es la mejor solución cuando el código está en un widget, porque además es la forma idiomática de Riverpod. `AsyncValue.error` lleva tu excepción **original**, no el envoltorio. El envoltorio solo ocurre en la ruta de rethrow imperativo (`ref.read`/`ref.watch` lanzando); el `AsyncValue` reactivo que obtienes al observar un provider queda intacto:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x -- no ProviderException here.
class UserView extends ConsumerWidget {
  const UserView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(userProvider);
    return switch (async) {
      AsyncData(:final value) => ProfileCard(value),
      AsyncError(:final error) when error is NotFoundException =>
        NotFoundCard(error.id), // error is the raw NotFoundException
      AsyncError(:final error) => ErrorCard('$error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Fíjate que `error is NotFoundException` coincide directamente. Sin desenvolver, porque `AsyncValue.error` nunca contuvo un `ProviderException` para empezar. Si de todos modos estás renderizando interfaz de carga y de error, prefiere esto sobre un `try`/`catch` imperativo; el mismo patrón sustenta [mostrar estados de carga y error con AsyncValue](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

### 3. Maneja el error en el onError de ref.listen, también sin envolver

Para efectos secundarios (un snackbar, una navegación, analítica) impulsados por la falla de un provider, el callback `onError` de `ref.listen` también recibe el error crudo:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ref.listen<AsyncValue<User>>(userProvider, (prev, next) {}, onError: (error, stack) {
  // error is the original NotFoundException, not a ProviderException.
  if (error is NotFoundException) showSnack('User ${error.id} is gone');
});
```

## Qué APIs envuelven y cuáles no

La tabla más útil para tener en la cabeza. El envoltorio aparece solo cuando un provider **vuelve a lanzar** hacia tu código de forma imperativa.

Envuelto en `ProviderException` (lee `.exception`):

- `ref.read(p.future)` donde `p` falló al construirse.
- `ref.watch(p)` sobre un provider sincrónico que lanzó, cuando la lectura vuelve a lanzar.
- `await container.read(p.future)` en pruebas.

No envuelto (obtienes el error original directamente):

- `AsyncValue.error` de `ref.watch(asyncProvider)`. Comprueba `value.error is MyException`.
- `ref.listen(p, ..., onError: (e, s) => ...)`. El `e` es crudo.
- `ProviderObserver.providerDidFail` (y los hooks del observer en general). Los observers ven el error y la pila sin alterar.

Si tu manejo vive en el build de un widget a través de `AsyncValue`, o en un listener, o en un observer, probablemente no necesites cambiar nada. El dolor de la migración se concentra en los `try`/`catch` imperativos alrededor de `ref.read(...future)`.

## Trampas y peligros por versión

**No puedes importar ProviderException en algunas builds tempranas de 3.0.** El [issue 4320](https://github.com/rrousselGit/riverpod/issues/4320) documenta una ventana donde la documentación describía el envoltorio pero una build lanzaba un `StateError` y `ProviderException` aún no estaba exportado. Si `on ProviderException` no compila, o estás capturando `StateError` en su lugar, estás en una prerelease afectada. Actualiza a una versión estable actual (`flutter_riverpod` 3.3.2 o posterior) donde el tipo esté exportado y el comportamiento coincida con la documentación. No escribas un `on StateError` permanente para sortearlo; eso volverá a romperse cuando actualices.

**No hagas doble envoltura en tu propio mapeo de errores.** Si tienes un interceptor que captura todo y vuelve a lanzar un `AppException` normalizado, asegúrate de que desenvuelve `ProviderException` primero, de lo contrario anidas un `ProviderException` dentro de tu `AppException` dentro de otro `ProviderException` en la siguiente lectura. Desenvuelve en el límite: `final real = e is ProviderException ? e.exception : e;`.

**El reintento ignora el envoltorio.** El reintento automático de Riverpod 3.0 (backoff exponencial, duplicándose desde 200ms hasta un tope de 6.4s) reintenta las fallas genuinas de construcción de un provider pero no reintenta un `ProviderException` que simplemente se propagó desde una dependencia, lo que evita que un provider hoja que falla desencadene una tormenta de reintentos en cada provider descendente. No configuras esto; solo debes saber que un `ProviderException` capturado-y-relanzado se trata como "ya contabilizado".

**El envoltorio no es un guardia de brecha asíncrona.** Capturar `ProviderException` maneja el provider *fallando*; no hace nada respecto al provider siendo *descartado* a mitad de un await. Esos son fallos distintos. Si además ves `UnmountedRefException` después de un await, ese es el [problema de ref.mounted](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), no este, y necesita un guardia `if (!ref.mounted) return;` en lugar de un catch.

**`rethrow` dentro de `on ProviderException` vuelve a lanzar el envoltorio, no el error interno.** Si tu rama `default` hace `rethrow`, el llamador más arriba en la pila sigue viendo un `ProviderException`. Eso normalmente es lo que quieres (se preserva la procedencia), pero si una capa externa espera excepciones de dominio crudas, vuelve a lanzar la interna explícitamente: `Error.throwWithStackTrace(e.exception, e.stackTrace)`.

## Dónde encaja esto en una actualización de 2.x a 3.0

Este es un punto dentro de la migración más grande a 3.0, junto con el cambio de ciclo de vida de `Ref.mounted` y el paso a clases `Notifier` unificadas. Si estás haciendo la actualización ahora, busca con grep en tu base de código las llamadas a `ref.read(` envueltas en `try` con un `on SomeException catch` tipado, y las lecturas con `.future` dentro de bloques `catch`. Esos son los sitios de llamada que en silencio dejaron de coincidir. El código de widget que renderiza `AsyncValue` es seguro. Para el panorama más amplio de por qué el ciclo de vida y la semántica de errores gestionados por Notifier son el estándar moderno, consulta [Provider vs Riverpod vs Bloc en 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), y si aún estás en el paquete `provider` más antiguo, la [migración de provider a Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) cubre el cambio antes de que te encuentres con cualquiera de esto.

El modelo mental que lo mantiene claro: un `ProviderException` significa "un provider en el grafo falló y lo leíste de forma imperativa". Mete la mano en `.exception` para obtener la causa real o, mejor, consume la falla de forma reactiva a través de `AsyncValue` donde no ocurre ningún envoltorio en absoluto. La misma disciplina que mantiene [los errores de red manejados con elegancia](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) aplica aquí: decide, por cada sitio de llamada, si estás reaccionando a un valor o reaccionando a una falla lanzada, y elige la API que te entregue el error en la forma que esperas.

## Relacionado

- [Cómo comprobar Ref.mounted después de una brecha asíncrona en Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) es el otro error de Riverpod 3.0 que aflora solo después de la actualización, en la ruta de la brecha asíncrona en lugar de la ruta del throw.
- [Cómo mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) es la alternativa reactiva al try/catch imperativo, y no se ve afectada por el envoltorio.
- [Solución: Cannot use "ref" after the widget was disposed en Flutter Riverpod](/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) es un fallo distinto de Riverpod que la gente confunde con este.
- [Provider vs Riverpod vs Bloc para gestión de estado en Flutter en 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) cubre por qué el modelo de errores y ciclo de vida de Riverpod es el estándar actual.
- [Migrar de provider a Riverpod en Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) es el paso previo a este si aún estás en el paquete heredado.

## Fuentes

- [Migrando de 2.0 a 3.0](https://riverpod.dev/docs/3.0_migration) -- la declaración oficial de que las fallas de lectura de un provider se vuelven a lanzar como `ProviderException` y el patrón de captura `e.exception`.
- [Novedades en Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- la justificación del envoltorio (distinguir un provider que falla de uno que depende de un provider fallido), más el comportamiento de reintento que ignora `ProviderException`.
- [issue 4320 de rrousselGit/riverpod](https://github.com/rrousselGit/riverpod/issues/4320) -- la discrepancia de 3.0 temprano donde se lanzaba un `StateError` y `ProviderException` no se podía importar.
- [changelog del paquete riverpod](https://pub.dev/packages/riverpod/changelog) -- la historia: `2.0.0-dev.1` quitó el envoltorio, `3.0.0-dev.16` lo reintrodujo; estable actual 3.3.2 (junio de 2026).

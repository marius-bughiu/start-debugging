---
title: "Migra de Riverpod 2.x a Riverpod 3.0 en Flutter"
description: "Una actualización paso a paso de flutter_riverpod 2.x a 3.x: sube las versiones de los paquetes, mueve StateProvider y compañía al import legacy, elimina los tipos de ref AutoDispose y Family, maneja el envoltorio de ProviderException y el reintento automático, y arregla el filtrado de notificaciones por == que descarta silenciosamente eventos de StreamProvider. Probado en Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "es"
translationOf: "2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-09
---

Actualizar una app real de `flutter_riverpod` 2.x a 3.x suele ser un trabajo de medio día, y la mayor parte es buscar y reemplazar de forma mecánica. La línea 3.0 salió en septiembre de 2025 y la versión actual es la 3.3.2 (junio de 2026); esta guía está probada en esa versión con Flutter 3.44 (estable, mayo de 2026) y Dart 3.x. Lo que realmente se rompe: `StateProvider`, `StateNotifierProvider` y `ChangeNotifierProvider` pasan detrás de un import `legacy.dart`, cada subtipo de `Ref` (`FutureProviderRef`, `AutoDisposeNotifier`, `FamilyNotifier`) se colapsa en un solo tipo, los errores de los providers ahora salen envueltos en una `ProviderException`, y los providers ahora filtran las notificaciones con `==`. Los dos últimos son los que causan sorpresas en runtime en lugar de errores de compilación, así que lee esas secciones con atención. Si tu base de código ya usa generación de código (`@riverpod`), tienes menos que cambiar que si escribiste a mano las declaraciones de los providers.

## Por qué actualizar

Riverpod 2.x sigue funcionando, así que el argumento para migrar tiene que ser concreto:

- **Reintento automático** con retroceso exponencial viene incorporado. Un `FutureProvider` que falla en una red inestable ya no se queda fallado hasta que lo invalidas manualmente con `ref.invalidate`.
- **`Ref.mounted`** reemplaza el mixin artesanal de "¿sigue vivo este provider después del await?" que toda app no trivial solía arrastrar. Consulta [comprobar Ref.mounted tras un salto asíncrono](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) para ver el patrón completo.
- **Un tipo `Ref` unificado** y un `Notifier` por forma. Se acabaron los nombres de tipo como `AutoDisposeFamilyAsyncNotifier` que se leen como una prueba de estrés para el compilador.
- **Persistencia offline** y **mutaciones** llegan como APIs experimentales, así que el estado de envío de formularios y el caché entre reinicios dejan de ser algo que construyes a mano.

## Qué se rompe

| Área                        | Cambio                                                                              | Severidad |
| --------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Providers legacy            | `StateProvider`, `StateNotifierProvider`, `ChangeNotifierProvider` necesitan `legacy.dart` | alta     |
| Subtipos de Ref             | `FutureProviderRef`, `StreamProviderRef`, etc. se convierten todos en un único `Ref`            | alta     |
| Tipos AutoDispose / Family  | `AutoDisposeNotifier`, `FamilyNotifier` eliminados; usa modificadores sobre `Notifier`        | alta     |
| Propagación de errores      | Las lecturas relanzan `ProviderException` envolviendo tu error original                      | alta     |
| Filtrado de notificaciones  | Todos los providers usan `==` para decidir si notificar a los listeners                        | media    |
| Reintento automático        | Los providers fallidos reintentan por defecto con retroceso                                      | media    |
| `ProviderObserver`          | Los callbacks reciben un único `ProviderObserverContext`                                   | media    |
| `AsyncValue.valueOrNull`    | Renombrado a `value`; el antiguo getter `value` que lanzaba desapareció                         | baja      |

## Lista previa al vuelo

Antes de tocar un solo provider:

1. Haz commit o stash de todo. Esta migración toca muchos archivos y quieres un `git diff` limpio para revisar.
2. Confirma que tu SDK de Dart es 3.x. Riverpod 3.0 lo requiere. Ejecuta `dart --version` y verifica.
3. Si usas generación de código, asegúrate de que `build_runner` se ejecute sin problemas sobre el código 2.x actual primero. No querrás depurar errores del generador y errores de migración al mismo tiempo.
4. Anota si usas `riverpod_lint`. Trae reglas de lint y un ayudante de migración `dart fix` que automatiza varios de los pasos de abajo, así que tenerlo instalado te ahorra ediciones manuales.

## Paso 1: Sube las versiones de los paquetes

Actualiza todos los paquetes de Riverpod en `pubspec.yaml` a la línea 3.x de una sola vez. Mezclar un paquete 2.x y uno 3.x no resolverá.

```yaml
# pubspec.yaml -- flutter_riverpod 3.3.2, Dart 3.x
dependencies:
  flutter_riverpod: ^3.3.2
  riverpod_annotation: ^3.3.2   # only if you use code-generation

dev_dependencies:
  riverpod_generator: ^3.3.2    # only if you use code-generation
  riverpod_lint: ^3.3.2
  custom_lint: ^0.8.0
  build_runner: ^2.4.0
```

Luego resuelve:

```bash
# Flutter 3.44
flutter pub get
```

**Verifica:** `flutter pub deps | grep riverpod` muestra todos los paquetes de Riverpod en una versión 3.x. Si pub se queja de un conflicto de versiones, una dependencia transitiva todavía está fijando `riverpod` 2.x; ejecuta `flutter pub deps` para encontrar al culpable.

## Paso 2: Ejecuta primero las correcciones automatizadas

Riverpod 3.0 incluye reglas de migración de `dart fix` a través de `riverpod_lint`. Ejecútalas antes de hacer nada a mano, porque manejan las reescrituras mecánicas tediosas (los renombres de subtipos de `Ref`, la eliminación del prefijo `AutoDispose`) en todos los archivos a la vez.

```bash
# preview the changes without writing them
dart fix --dry-run

# apply them
dart fix --apply
```

**Verifica:** vuelve a ejecutar `dart fix --dry-run` y confirma que las correcciones específicas de Riverpod desaparecieron de la lista. Luego haz `git diff` y lee lo que cambió. La herramienta es buena pero no omnisciente, así que los pasos restantes son las partes que no puede inferir.

## Paso 3: Mueve los providers legacy detrás del import legacy

`StateProvider`, `StateNotifierProvider` y `ChangeNotifierProvider` todavía existen, pero ahora viven en una biblioteca separada para que la superficie principal del import solo exponga la API moderna. Si los importas desde el paquete principal, obtienes un error de "undefined name".

```dart
// Riverpod 3.x
// Add this import wherever you still use the legacy providers:
import 'package:flutter_riverpod/legacy.dart';

// StateProvider itself is unchanged in behaviour:
final counterProvider = StateProvider<int>((ref) => 0);
```

Esto es un empujón deliberado, no una advertencia de obsolescencia que puedas ignorar para siempre. El movimiento a largo plazo es reescribir cada `StateProvider` como un `Notifier` y cada `StateNotifierProvider` como un `Notifier` o `AsyncNotifier`, la misma forma objetivo a la que llegarías al [migrar desde el paquete provider](/2026/06/migrate-from-provider-to-riverpod-in-flutter/). Pero no tienes que hacer esa reescritura durante la subida de versión. Agrega el import, ponte en verde y convierte después.

**Verifica:** la app compila. Haz grep de `legacy.dart` y confirma que todos los archivos que usan un provider legacy tienen el import, y que ningún archivo lo importa sin necesitarlo (el linter marcará el import sin usar).

## Paso 4: Colapsa los subtipos de Ref y las variantes de Notifier

En 2.x, un provider generado por código te entregaba un ref tipado como `CounterRef`, y los providers escritos a mano usaban `FutureProviderRef<T>`, `StreamProviderRef<T>`, y demás. En 3.0 hay un único `Ref`. La pasada de `dart fix` normalmente maneja esto, pero las declaraciones escritas a mano que la herramienta omitió necesitan edición.

```dart
// Riverpod 2.x
int example(ExampleRef ref) => 0;

Future<User> user(UserRef ref) async => fetchUser();
```

```dart
// Riverpod 3.x -- one Ref type for everything
int example(Ref ref) => 0;

Future<User> user(Ref ref) async => fetchUser();
```

La misma unificación afecta a los notifiers basados en clases. `AutoDisposeNotifier`, `FamilyNotifier` y la explosión combinatoria de nombres intermedios desaparecieron. Expresas el mismo comportamiento con modificadores sobre el `Notifier` base:

```dart
// Riverpod 2.x
class TodosNotifier extends AutoDisposeAsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AutoDisposeAsyncNotifierProvider<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

```dart
// Riverpod 3.x -- autoDispose is a modifier, not a base class
class TodosNotifier extends AsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AsyncNotifierProvider.autoDispose<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

Los parámetros de family que solían vivir en `FamilyNotifier` ahora llegan como argumentos normales de `build` (generación de código) o a través del modificador `.family` (manual). Si usas `@riverpod`, el generador maneja el cableado y solo lo vuelves a ejecutar.

**Verifica (usuarios de generación de código):** borra los archivos generados y reconstruye.

```bash
dart run build_runner build --delete-conflicting-outputs
```

Confirma cero errores del generador y que los archivos `.g.dart` regenerados referencian `Ref`, no los antiguos refs tipados.

## Paso 5: Maneja el envoltorio de ProviderException

Este es el cambio con más probabilidad de pasar desapercibido en una comprobación de compilación y romperse en runtime. En 3.0, cuando el `build` de un provider lanza y otro fragmento de código lo lee de forma imperativa, la lectura no relanza tu excepción original. Relanza una `ProviderException` que la envuelve. Cualquier bloque `on MyException catch` que estuviera capturando el tipo original deja de dispararse.

```dart
// Riverpod 2.x -- this used to work
try {
  final user = await ref.read(userProvider.future);
} on NotFoundException catch (e) {
  showNotFound();
}
```

```dart
// Riverpod 3.x -- catch the wrapper, inspect .exception
try {
  final user = await ref.read(userProvider.future);
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    showNotFound();
  } else {
    rethrow;
  }
}
```

La ruta sin envolver es `AsyncValue`. Cuando renderizas un provider con `.when(error: ...)` o haces coincidencia de patrones con un `AsyncError`, el error que obtienes ahí es tu excepción original, no el envoltorio. Así que el código de UI que lee el estado de forma reactiva no se ve afectado; solo el `ref.read(...future)` imperativo dentro de un `try`/`catch` necesita el cambio. El artículo dedicado sobre [la ProviderException de Riverpod 3.0](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) cubre los casos límite.

**Verifica:** haz grep de `ref.read(` combinado con `.future` dentro de bloques `try`, y de cualquier cláusula `catch` que nombre una excepción de dominio. Agrega un test que haga que un provider lance y verifique que tu manejador aún se ejecuta.

## Paso 6: Arregla el filtrado de notificaciones por ==

En 2.x, distintos tipos de provider tenían reglas distintas para decidir cuándo notificar a los listeners. En 3.0 todos usan `==`. Para el estado de `Notifier` esto suele estar bien, pero muerde fuerte con `StreamProvider` y `StreamNotifier`: si tu stream emite objetos que son iguales por `==` (por ejemplo, clases mutables que no sobrescriben la igualdad, o dos valores que resultan comparar iguales), la segunda emisión ahora se descarta como duplicada.

El modo de fallo es una UI que deja de actualizarse aunque el stream claramente esté emitiendo. La solución es asegurarte de que el tipo emitido tenga semántica de igualdad correcta. Si emites objetos de dominio, dales igualdad por valor (un `record`, una clase Freezed, o un `==`/`hashCode` escrito a mano). Consulta [Dart records vs clases Freezed](/2026/05/dart-records-vs-freezed-classes/) para saber cuál elegir.

```dart
// Riverpod 3.x -- two distinct ticks that are == would be collapsed.
// A record gives structural equality so each tick is treated as new.
Stream<({int count, DateTime at})> ticks(Ref ref) async* {
  var n = 0;
  await for (final _ in Stream.periodic(const Duration(seconds: 1))) {
    yield (count: n++, at: DateTime.now());
  }
}
```

Si realmente necesitas que cada emisión pase sin importar la igualdad, sobrescribe `updateShouldNotify` en un `StreamNotifier` para que devuelva `true`.

**Verifica:** ejecuta la app, observa cualquier widget respaldado por un stream y confirma que aún se actualiza en cada emisión que esperas. Este no tiene señal de compilación, así que necesita una prueba de humo manual.

## Paso 7: Decide sobre el reintento automático

Los providers fallidos ahora reintentan automáticamente: un retraso inicial de 200 ms que se duplica hasta 6.4 segundos. Para la mayoría de los providers respaldados por red esto es una mejora. Pero si tienes un provider cuya falla es permanente (un error de validación, un 404 que nunca se convertirá en un 200), los reintentos silenciosos desperdician llamadas y pueden ocultar el error en la UI durante varios segundos.

Deshabilítalo globalmente en el scope, o por provider:

```dart
// Riverpod 3.x -- disable retry everywhere
ProviderScope(
  retry: (retryCount, error) => null, // null delay = do not retry
  child: MyApp(),
)
```

```dart
// Or keep it, but stop retrying non-transient errors
ProviderScope(
  retry: (retryCount, error) {
    if (error is NotFoundException) return null;
    if (retryCount >= 3) return null;
    return Duration(milliseconds: 200 * (1 << retryCount));
  },
  child: MyApp(),
)
```

**Verifica:** apunta un provider a un endpoint que devuelva un 404 y confirma que no martillea el servidor, o que tu predicado de reintento corta el circuito como se pretende.

## Paso 8: Actualiza ProviderObserver y el renombre de valueOrNull

Si tienes un `ProviderObserver` personalizado (analítica, logging), sus callbacks cambiaron de firma. Los argumentos de container y provider se fusionaron en un único `ProviderObserverContext`.

```dart
// Riverpod 3.x
class LoggingObserver extends ProviderObserver {
  @override
  void didUpdateProvider(
    ProviderObserverContext context,
    Object? previousValue,
    Object? newValue,
  ) {
    debugPrint('${context.provider.name} -> $newValue');
  }
}
```

Y el pequeño: `AsyncValue.valueOrNull` se renombra a `value`. El antiguo getter `value` (que lanzaba en loading/error) desapareció. Si dependías del comportamiento de lanzar, haz coincidencia de patrones con el caso `AsyncData` en su lugar.

**Verifica:** el analizador marca cada sitio de llamada a `valueOrNull`; la pasada de `dart fix` del Paso 2 normalmente los reescribe, pero confirma que no queda ninguno.

## Verificación: la prueba de humo completa

Después de todos los pasos, ejecuta la lista de principio a fin:

- `flutter pub get` resuelve con todos los paquetes de Riverpod en 3.x.
- `dart run build_runner build --delete-conflicting-outputs` produce cero errores (usuarios de generación de código).
- `flutter analyze` está limpio, sin referencias sobrantes a `AutoDispose`/`valueOrNull`/refs tipados.
- `flutter test` pasa, incluidos los nuevos tests que agregaste para el manejo de `ProviderException` y la emisión de streams.
- Ejercita manualmente: una pantalla respaldada por un stream, una pantalla de error y una pantalla que dispare una falla de provider, para confirmar que el reintento, el envoltorio y el filtrado por `==` se comportan bien.

## Plan de reversión

Esta migración es, en la práctica, una puerta de un solo sentido. En el momento en que escribes `import 'package:flutter_riverpod/legacy.dart'` y adoptas el tipo `Ref` único, revertir significa deshacer cada archivo. La reversión limpia es `git`, no código: haz toda la migración en una rama, mantén la rama 2.x intacta, y fusiona solo cuando la prueba de humo pase. No hagas una migración a medias y la envíes; una base de código con algunos archivos en semántica 3.x y otros en supuestos 2.x (especialmente en torno al envoltorio de errores) es peor que cualquiera de las dos versiones por separado.

## Trampas con las que topamos

- **El filtrado por `==` es invisible hasta que deja de serlo.** Un `StreamProvider<List<Item>>` respaldado por una lista que el mismo código muta en el sitio emitirá la misma instancia de lista dos veces, y 3.0 descarta la segunda notificación. Emite una lista nueva (o un tipo con igualdad por valor) cada vez.
- **`ref.read(provider.future)` en un `catch` es el traicionero.** Compila bien y solo se revela cuando el provider realmente falla en producción. Búscalo de forma proactiva.
- **`dart fix` no toca las referencias a providers de tipo string o construidas dinámicamente.** Cualquier cosa que el analizador no pueda ver estáticamente, la editas a mano.
- **No actualices `riverpod` sin actualizar `riverpod_generator` al mismo paso.** Un runtime 3.x con un generador 2.x produce código que referencia los antiguos subtipos de `Ref` y no compila de formas confusas.

## Relacionado

- [Migra del paquete provider a Riverpod en Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [Cómo comprobar Ref.mounted tras un salto asíncrono en Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Solución: Riverpod 3.0 lanza ProviderException en lugar del error original](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)
- [Provider vs Riverpod vs Bloc para la gestión de estado en Flutter en 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Migra de FutureBuilder a un AsyncNotifier de Riverpod en Flutter](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Fuentes

- [Migrating from 2.0 to 3.0, documentación de Riverpod](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0, documentación de Riverpod](https://riverpod.dev/docs/whats_new)
- [riverpod en pub.dev](https://pub.dev/packages/flutter_riverpod)
</content>
</invoke>

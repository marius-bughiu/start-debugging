---
title: "Cómo desactivar el reintento automático de providers en Riverpod 3.0"
description: "Riverpod 3.0 reintenta un provider fallido hasta 10 veces por defecto. Pasa una función de retry que devuelva null en ProviderScope, ProviderContainer o un provider individual para desactivarlo o acotarlo."
pubDate: 2026-07-20
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "async"
lang: "es"
translationOf: "2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry"
translatedBy: "claude"
translationDate: 2026-07-20
---

Riverpod 3.0 agregó el reintento automático: cuando un provider lanza una excepción mientras se está compilando, Riverpod lo reintenta silenciosamente hasta 10 veces con un backoff exponencial que empieza en 200ms y se duplica hasta 6.4 segundos. Para desactivarlo, pasa un callback `retry` que devuelva `null`. Puedes hacerlo de forma global en `ProviderScope` o `ProviderContainer`, o por provider en el constructor del provider o en la anotación `@Riverpod`. Esto está probado en `flutter_riverpod` 3.x (la línea 3.0 salió en septiembre de 2025; la versión actual es 3.3.2, de junio de 2026), Flutter 3.44 y Dart 3.x.

El one-liner, si solo quieres eliminarlo en todas partes:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) => null, // never retry
  child: MyApp(),
)
```

Todo lo demás en esta publicación trata sobre por qué existe el reintento, cuándo el valor por defecto realmente te está ayudando, y cómo acotarlo en lugar de eliminarlo por completo.

## Por qué un provider que antes fallaba una vez ahora falla diez veces

En Riverpod 2.x, un provider cuyo `build` lanzaba una excepción pasaba directamente a `AsyncError` y se quedaba ahí hasta que algo lo invalidara. Un fallo, un estado de error. Predecible.

Riverpod 3.0 cambió ese valor por defecto. El razonamiento es sólido: muchos fallos de providers son transitorios. Un `FutureProvider` que llama a un endpoint HTTP falla porque la red tuvo un parpadeo, no porque el código esté mal. Reintentar con backoff significa que la UI se recupera por sí sola en lugar de quedarse estacionada en una pantalla de error que un refresco manual habría limpiado. La documentación oficial describe el valor por defecto como reintentar "hasta 10 veces, con un backoff exponencial que va de 200ms a 6.4 segundos."

El problema es que este comportamiento es invisible hasta que te muerde. Un provider que falla de forma determinista, digamos porque parsea una respuesta mal formada o pega contra un 404 que nunca se convertirá en un 200, ahora quema los 10 intentos antes de asentarse en un estado de error. Durante esos intentos tu spinner de carga sigue girando, tus logs se llenan con el mismo stack trace diez veces, y cualquier efecto secundario dentro de `build` (un evento de analytics, una línea de log, el incremento de un contador) se dispara diez veces en lugar de una. En las pruebas es peor: un provider que se supone que debe fallar rápido en cambio se queda colgado mientras se reproduce el calendario de reintentos, y tu prueba agota su tiempo.

## Reproduciendo la tormenta de reintentos

Aquí está el provider más pequeño que muestra el comportamiento. Lanza una excepción incondicionalmente y registra cada vez que se ejecuta `build`.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';

int _attempts = 0;

final brokenProvider = FutureProvider<int>((ref) async {
  _attempts++;
  print('build attempt #$_attempts');
  throw StateError('this will never succeed');
});
```

Obsérvalo desde un widget:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
class Screen extends ConsumerWidget {
  const Screen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(brokenProvider);
    return value.when(
      data: (n) => Text('$n'),
      loading: () => const CircularProgressIndicator(),
      error: (e, _) => Text('failed: $e'),
    );
  }
}
```

En Riverpod 2.x la consola imprime `build attempt #1` una vez y el widget muestra el error de inmediato. En Riverpod 3.0 la consola imprime diez intentos repartidos a lo largo de aproximadamente 13 segundos (200ms + 400ms + 800ms + ... hasta 6.4s), y el spinner permanece arriba todo el tiempo antes de que el error finalmente se renderice. Ese hueco de 13 segundos entre "la petición falló" y "el usuario ve un error" es la sorpresa con la que la mayoría de los equipos se topa primero.

## El callback de retry, y cómo devolver null lo desactiva

Cada hook de reintento en Riverpod 3.0 tiene la misma forma. Recibe el conteo actual de reintentos y el error, y devuelve un `Duration?`. Devuelve una duración para esperar ese tiempo e intentar de nuevo; devuelve `null` para rendirte y hacer aflorar el error.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? myRetry(int retryCount, Object error) {
  if (retryCount >= 5) return null;                       // cap attempts
  if (error is ProviderException) return null;            // don't retry wrapped deps
  return Duration(milliseconds: 200 * (1 << retryCount)); // 200ms, 400ms, 800ms...
}
```

`1 << retryCount` es simplemente `2^retryCount`, así que esto reproduce la curva exponencial integrada. Para desactivar el reintento por completo, la función entera se colapsa a una sola línea que ignora sus argumentos y siempre devuelve `null`.

### Desactívalo para toda la app

`ProviderScope` es el widget que aloja el estado de tus providers en una app de Flutter. Dale un `retry` y cada provider por debajo de él hereda la política a menos que la sobrescriba.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
void main() {
  runApp(
    ProviderScope(
      retry: (retryCount, error) => null,
      child: const MyApp(),
    ),
  );
}
```

En Dart puro, o en cualquier lugar donde construyas un contenedor a mano, el mismo parámetro vive en `ProviderContainer`:

```dart
// Dart 3.x, riverpod 3.x
final container = ProviderContainer(
  retry: (retryCount, error) => null,
);
```

### Desactívalo para un solo provider

Desactivar globalmente es un instrumento tosco. Normalmente quieres el reintento para los dos providers de red donde ayuda y desactivado para el provider que parsea la configuración local y que solo puede fallar por un bug. Cada constructor de provider recibe su propio parámetro `retry`, y un valor por provider gana sobre el de nivel de scope.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final configProvider = FutureProvider<AppConfig>(
  (ref) async => AppConfig.fromAsset(await rootBundle.loadString('config.json')),
  retry: (retryCount, error) => null, // parsing bugs won't fix themselves
);
```

El mismo parámetro existe en los providers basados en clases. Para un `NotifierProvider` o `AsyncNotifierProvider`, va junto al tear-off del constructor:

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
final todoListProvider = NotifierProvider<TodoList, List<Todo>>(
  TodoList.new,
  retry: (retryCount, error) => null,
);
```

### Desactívalo en providers generados por código

Si usas `riverpod_generator`, la anotación lleva un argumento `retry`. Apúntalo a una función con nombre para que el provider generado la tome.

```dart
// Flutter 3.44, Dart 3.x, riverpod_annotation 3.x
Duration? noRetry(int retryCount, Object error) => null;

@Riverpod(retry: noRetry)
Future<int> counter(Ref ref) async {
  throw StateError('fails once, stays failed');
}
```

Ejecuta `dart run build_runner build` después de cambiar la anotación. El `counterProvider` generado ahora lleva la política de no reintentar, y nunca tocas el archivo generado.

## Qué omite ya el valor por defecto

Antes de desactivar el reintento globalmente, ten presente que el valor por defecto no es tan agresivo como "reintentar todo diez veces." Dos categorías se excluyen de fábrica.

`Error` (a diferencia de `Exception`) nunca se reintenta. En Dart, `Error` señala un error de programación: una aserción fallida, una comprobación de null sobre un null, un cast incorrecto. Estos no son recuperables esperando, así que Riverpod los hace aflorar de inmediato. Si tu provider lanza `StateError` o `TypeError`, el reintento por defecto no entra en juego en absoluto. El `brokenProvider` de arriba lanza `StateError`, que es un subtipo de `Error`, así que en una lectura estricta afloraría de inmediato; cámbialo por un `Exception` simple si quieres observar la tormenta completa de diez intentos en la consola.

`ProviderException` también se omite. Cuando el provider A lee al provider B y B ha fallado, Riverpod envuelve el fallo de B en una `ProviderException` antes de que llegue a A. Reintentar A no tendría sentido porque A en sí está bien; es B el que necesita recuperarse. El reintento por defecto reconoce este envoltorio y no lo reintenta, lo que evita una cascada donde cada provider en una cadena de dependencias ejecuta su propio calendario de reintentos. Si alguna vez te has preguntado por qué importa el tipo del envoltorio, es la misma `ProviderException` detrás del `try`/`catch` roto cuando [Riverpod 3.0 lanza ProviderException en lugar de tu error original](/es/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/).

Así que "desactivar el reintento" en la práctica significa "dejar de reintentar `Exception`s recuperables." Los errores y los fallos de dependencias ya estaban aflorando de inmediato.

## Acotar el reintento en lugar de eliminarlo

Desactivar el reintento es la decisión correcta para providers que cargan datos locales, parsean assets o realizan cualquier operación donde un fallo significa un bug en lugar de un tropiezo. Pero para I/O genuinamente inestable, un reintento acotado es mejor que ninguno. El patrón es: limita los intentos a pocos, omite los errores que sabes que son permanentes, y mantén un backoff corto.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
Duration? networkRetry(int retryCount, Object error) {
  // Give up after 3 tries.
  if (retryCount >= 3) return null;
  // A 404 will not become a 200 by waiting.
  if (error is NotFoundException) return null;
  // Otherwise back off: 300ms, 600ms, 1.2s.
  return Duration(milliseconds: 300 * (1 << retryCount));
}

final userProvider = FutureProvider<User>(
  (ref) => api.fetchUser(),
  retry: networkRetry,
);
```

Tres intentos a lo largo de unos dos segundos suele ser suficiente para sortear un fallo transitorio sin hacer que el usuario se quede mirando un spinner durante 13 segundos. El valor por defecto de 10 intentos está afinado para la resiliencia por encima de la capacidad de respuesta; la mayoría de las apps quieren el intercambio opuesto para los providers de cara al usuario.

## Desactiva el reintento en cada prueba

Este es el cambio que la mayoría de los equipos olvida, y produce el síntoma más confuso: una prueba que antes afirmaba sobre un estado de error ahora agota su tiempo. Un `ProviderContainer` creado de la forma normal hereda el reintento por defecto, así que un provider que *quieres* que falle pasa 13 segundos reintentando antes de que tu `expect` sobre el error llegue siquiera a ejecutarse.

Riverpod 3.0 incluye `ProviderContainer.test`, un constructor que agrega disposición automática para pruebas, y deberías pasarle un retry que no haga nada.

```dart
// Dart 3.x, riverpod 3.x, flutter_test
import 'package:flutter_test/flutter_test.dart';
import 'package:riverpod/riverpod.dart';

void main() {
  test('brokenProvider surfaces its error immediately', () async {
    final container = ProviderContainer.test(
      retry: (retryCount, error) => null,
    );

    await expectLater(
      container.read(brokenProvider.future),
      throwsA(isA<StateError>()),
    );
  });
}
```

Sin la sobrescritura de `retry` esta prueba eventualmente pasaría, pero solo después del calendario de reintentos completo, que o bien hace estallar el timeout de tu prueba o hace que la suite avance a rastras. Configura el retry que no hace nada en un helper de pruebas compartido para que cada contenedor lo reciba por defecto y nadie tenga que acordarse.

## El detalle con los efectos secundarios en build

La razón por la que vale la pena entender el reintento en lugar de desactivarlo a ciegas es que los métodos `build` de los providers no se supone que tengan efectos secundarios visibles externamente, pero en la práctica a menudo los tienen. Si tu `build` registra en analytics, incrementa una métrica o escribe en una caché antes de lanzar la excepción, cada reintento repite ese efecto secundario. Diez intentos significan diez eventos de analytics para un único fallo lógico. Acotar el reintento a un conteo bajo, o desactivarlo en providers cuyo `build` no es idempotente, mantiene tu telemetría honesta. Si estás echando mano de estado después de un `await` dentro de estos métodos, la misma disciplina que te mantiene [comprobando Ref.mounted tras un intervalo asíncrono](/es/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/) aplica a los providers con muchos reintentos, porque un reintento ejecuta de nuevo todo el cuerpo asíncrono.

Una sutileza más: los conteos de reintentos se reinician cuando el provider se invalida y se recompila desde cero. El presupuesto de 10 intentos es por racha continua de fallos, no por sesión de la app. Un provider que falla, agota sus reintentos, es invalidado por un pull-to-refresh, y falla de nuevo comienza un presupuesto fresco de 10 intentos. Si dependes de que el reintento eventualmente se detenga, asegúrate de que la invalidación no lo esté reiniciando silenciosamente.

## Eligiendo tu valor por defecto

Para una nueva app de Riverpod 3.0, la configuración pragmática es: mantén un reintento acotado corto a nivel de `ProviderScope` para el caso común, y sobrescribe providers individuales a `null` donde el reintento no puede ayudar. Eso te da resiliencia en las lecturas de red sin el spinner de 13 segundos en los fallos deterministas.

```dart
// Flutter 3.44, Dart 3.x, flutter_riverpod 3.x
ProviderScope(
  retry: (retryCount, error) {
    if (retryCount >= 2) return null; // app-wide default: 3 attempts max
    return Duration(milliseconds: 300 * (1 << retryCount));
  },
  child: const MyApp(),
)
```

Si vienes de Riverpod 2.x y quieres el viejo comportamiento de "falla una vez, se queda fallado" en todas partes mientras evalúas la funcionalidad, el `retry: (_, __) => null` global es el punto de partida honesto. Vuelve a activarlo por provider una vez que sepas cuáles realmente se benefician. Las notas de migración cubren el resto de lo que cambió junto con el reintento en la [actualización de Riverpod 2.x a 3.0](/es/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), y si todavía estás decidiendo si Riverpod es la herramienta correcta en absoluto, la [comparación Provider vs Riverpod vs Bloc](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) pone esto en contexto. Para el lado de renderizado de carga y error de esos mismos providers, mira cómo [mostrar estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Fuentes

- [Automatic retry](https://riverpod.dev/docs/concepts2/retry) - documentación de Riverpod sobre la firma del callback de retry, los valores por defecto y la configuración por provider.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) - el anuncio de la funcionalidad de reintento y el comportamiento de backoff por defecto.
- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) - guía de migración que incluye `ProviderContainer.test`.
- [riverpod changelog](https://pub.dev/packages/riverpod/changelog) - historial de versiones de la línea 3.x.

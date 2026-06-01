---
title: "Cómo manejar errores de red de forma elegante en una app Flutter"
description: "Una solicitud puede fallar sin conectividad, por un timeout, un fallo de DNS, un 500 o JSON malformado, y cada caso necesita una respuesta distinta. Aquí ves cómo capturar las excepciones correctas, clasificarlas, reintentar con seguridad y mostrar una interfaz sobre la que el usuario pueda actuar."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "networking"
lang: "es"
translationOf: "2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app"
translatedBy: "claude"
translationDate: 2026-06-01
---

Una llamada de red en Flutter falla de al menos cinco formas distintas, y una app elegante trata cada una de forma diferente: sin conectividad, un timeout de conexión, un fallo de DNS o de socket, un estado HTTP que no es 2xx, y un cuerpo de respuesta malformado o inesperado. La solución es capturar el tipo de excepción específico en lugar de un `catch (e)` pelado, mapearlo a un conjunto reducido de estados visibles para el usuario (sin conexión, timeout, error de servidor, reintentable, fatal), envolver la llamada en un timeout y en un reintento acotado con backoff, y renderizar un estado sobre el que el usuario pueda actuar de verdad en vez de un spinner que nunca se resuelve. Esta guía usa Flutter 3.44 (estable, mayo de 2026), Dart 3.x, el paquete `http` 1.x, `dio` 5.9.2 y `connectivity_plus` 7.1.1.

El error que casi todas las apps Flutter cometen al principio es tratar "la red" como un único modo de fallo. Envuelves la llamada en `try`/`catch`, muestras un snackbar que dice "Algo salió mal" y sigues adelante. Pero "sin Wi-Fi" y "el servidor devolvió un 503" no son el mismo problema, y un usuario mirando un error genérico no tiene idea de si reintentar, esperar o rendirse. Peor aún, el error más común ni siquiera llega al catch: un `Future` que nunca se completa porque no había timeout, dejando un spinner girando para siempre.

## Las excepciones que una llamada HTTP de Flutter realmente lanza

Cuando usas `dart:io` y el paquete `http`, una solicitud fallida aparece como una excepción tipada, y el tipo te dice qué salió mal:

- `SocketException` se lanza cuando la conexión en sí no se puede establecer o se cae: no hay ruta al host, falló la resolución de DNS, conexión rechazada, o el dispositivo está sin conexión. Este es el grupo "la red es inalcanzable".
- `TimeoutException` (de `dart:async`) se lanza cuando envuelves un `Future` con `.timeout(...)` y la duración transcurre. El paquete `http` no aplica timeout por sí solo, así que si no lo añades, una conexión colgada congela tu interfaz indefinidamente.
- `HttpException` y `ClientException` cubren problemas a nivel de protocolo: una respuesta malformada, una conexión cerrada a mitad de respuesta, o un bucle de redirección.
- `FormatException` la lanza `jsonDecode` cuando el cuerpo no es JSON válido. Un 200 OK con una página de error HTML (un portal cautivo, un proxy, un gateway mal configurado) cae aquí, no en ninguno de los grupos de red. Cubrí esta trampa concreta en [la guía sobre FormatException Unexpected character](/es/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/).

Un estado que no es 2xx no es ninguna excepción con el paquete `http`. `http.get` devuelve un `Response` con `statusCode == 500` y tienes que comprobarlo tú mismo. Esta es la razón más común de que una app muestre datos vacíos en silencio: la persona desarrolladora parseó `response.body` como JSON sin mirar nunca `response.statusCode`, y el cuerpo era una carga de error.

## Un repro que se traga todo

Aquí está el patrón a evitar. Compila, funciona con una conexión rápida, y falla de todas las formas interesantes.

```dart
// Flutter 3.44, Dart 3.x, http 1.x -- anti-pattern, do not copy.
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<String>> fetchNames() async {
  try {
    final response =
        await http.get(Uri.parse('https://api.example.com/names'));
    final data = jsonDecode(response.body) as List;
    return data.cast<String>();
  } catch (e) {
    return []; // every failure looks like "no data"
  }
}
```

Hay tres cosas rotas. No hay timeout, así que una conexión estancada se cuelga para siempre. El estado nunca se comprueba, así que un 500 con un cuerpo JSON de error o bien lanza una excepción en `cast` o bien devuelve basura. Y el `catch (e)` colapsa sin conexión, timeout, error de servidor y JSON inválido en un único resultado: una lista vacía, indistinguible de "el servidor legítimamente no tiene nombres". La interfaz no puede decirle nada útil al usuario porque la función tiró a la basura la única información que importaba.

## Clasifica el fallo en un resultado que la interfaz pueda renderizar

La primera solución real es dejar de devolver datos pelados y empezar a devolver un resultado que codifique cómo terminó la llamada. Una jerarquía de clases selladas (clases selladas de Dart 3) hace que el compilador te obligue a manejar todos los casos.

```dart
// Flutter 3.44, Dart 3.x
sealed class NetworkResult<T> {
  const NetworkResult();
}

class Success<T> extends NetworkResult<T> {
  final T data;
  const Success(this.data);
}

class Offline<T> extends NetworkResult<T> {
  const Offline();
}

class TimedOut<T> extends NetworkResult<T> {
  const TimedOut();
}

class ServerError<T> extends NetworkResult<T> {
  final int statusCode;
  const ServerError(this.statusCode);
}

class BadResponse<T> extends NetworkResult<T> {
  final String detail;
  const BadResponse(this.detail);
}
```

Ahora la capa de datos mapea cada tipo de excepción y cada estado a uno de estos, y nada se escapa como un throw sin manejar:

```dart
// Flutter 3.44, Dart 3.x, http 1.x
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await http
        .get(Uri.parse('https://api.example.com/names'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode >= 500) {
      return ServerError(response.statusCode);
    }
    if (response.statusCode >= 400) {
      // 4xx is usually a client bug or auth issue, not retryable.
      return BadResponse('HTTP ${response.statusCode}');
    }

    final decoded = jsonDecode(response.body) as List;
    return Success(decoded.cast<String>());
  } on SocketException {
    return const Offline();
  } on TimeoutException {
    return const TimedOut();
  } on FormatException catch (e) {
    return BadResponse('Malformed JSON: ${e.message}');
  } on http.ClientException catch (e) {
    return BadResponse(e.message);
  }
}
```

Fíjate en el orden de las cláusulas `on`. Dart las evalúa de arriba abajo y ejecuta la primera coincidencia, así que pon las excepciones más específicas primero. `TimeoutException` y `SocketException` son hermanas, no padre e hija, por lo que su orden relativo no importa, pero `FormatException` y `ClientException` deben ir antes de cualquier `catch` amplio. Aquí no hay deliberadamente ningún `catch (e)` pelado, porque si se lanza alguna excepción que no anticipé, quiero que falle en depuración y aparezca en mi reporte de errores, no que se mapee en silencio a `BadResponse`.

## Renderiza cada rama en el widget

Como `NetworkResult` es una clase sellada, una expresión `switch` en el widget es exhaustiva: añade un nuevo tipo de resultado y el compilador marca cada `switch` que no lo maneje. Esta es la recompensa de la jerarquía sellada.

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

Widget buildBody(NetworkResult<List<String>> result, VoidCallback onRetry) {
  return switch (result) {
    Success(data: final names) => ListView(
        children: [for (final n in names) ListTile(title: Text(n))],
      ),
    Offline() => _ErrorState(
        message: 'You appear to be offline. Check your connection.',
        onRetry: onRetry,
      ),
    TimedOut() => _ErrorState(
        message: 'The request took too long. Try again.',
        onRetry: onRetry,
      ),
    ServerError(statusCode: final code) => _ErrorState(
        message: 'The server had a problem (HTTP $code). Try again shortly.',
        onRetry: onRetry,
      ),
    BadResponse(detail: final detail) => _ErrorState(
        message: 'Something went wrong. ($detail)',
        onRetry: null, // not retryable, retry will not help
      ),
  };
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const _ErrorState({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: FilledButton(onPressed: onRetry, child: const Text('Retry')),
            ),
        ],
      ),
    );
  }
}
```

La distinción que le importa al usuario: `Offline`, `TimedOut` y `ServerError` ofrecen un botón de reintento porque reintentar podría tener éxito. `BadResponse` no lo hace, porque una carga malformada o un 400 fallarán de forma idéntica en el siguiente intento, y un botón de reintento que nunca funciona es peor que ningún botón. Mantén el widget de error simple para que no introduzca un segundo error; una pantalla de error que se desborda a sí misma es una mala imagen, y [la guía sobre el desbordamiento de RenderFlex](/es/2026/05/fix-renderflex-overflowed-in-flutter/) cubre por qué ocurre eso.

## Reintenta los fallos transitorios con backoff exponencial

`Offline`, `TimedOut` y `ServerError` (en concreto 502, 503, 504) son transitorios: la misma solicitud puede tener éxito segundos después. Una app elegante los reintenta automáticamente un número acotado de veces, con retraso creciente para no machacar a un servidor que está sufriendo. No reintentes los 4xx, y no reintentes para siempre.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'dart:io';

Future<T> withRetry<T>(
  Future<T> Function() action, {
  int maxAttempts = 3,
  Duration baseDelay = const Duration(milliseconds: 400),
}) async {
  var attempt = 0;
  while (true) {
    attempt++;
    try {
      return await action();
    } on SocketException {
      if (attempt >= maxAttempts) rethrow;
    } on TimeoutException {
      if (attempt >= maxAttempts) rethrow;
    }
    // 2^attempt backoff: 0.8s, 1.6s, 3.2s ...
    final delay = baseDelay * (1 << attempt);
    await Future<void>.delayed(delay);
  }
}
```

El `1 << attempt` es un desplazamiento de bits que duplica el multiplicador en cada ronda, que es la forma más barata de escribir backoff exponencial. En producción también quieres jitter (un pequeño desfase aleatorio) para que mil clientes recuperándose del mismo corte no reintenten todos en el mismo tic y creen una estampida, pero la forma central es este bucle. Envuelve la llamada HTTP, no toda la función `fetchNames`, para que el reintento vea la excepción cruda antes de que se mapee a un `NetworkResult`. Si el trabajo dentro de la acción reintentada es pesado para la CPU (decodificar una carga enorme, por ejemplo), muévelo fuera del isolate de la interfaz como se describe en [la guía sobre isolates de Dart](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), porque los reintentos multiplican ese coste.

## dio te da errores tipados y un interceptor para reintentos

El paquete `http` está bien, pero `dio` 5.9.2 envuelve cada fallo en una única `DioException` cuyo campo `type` ya clasifica el fallo por ti, lo que elimina mucha de la fontanería manual de `on SocketException`. El enum `DioExceptionType` tiene ocho valores: `connectionTimeout`, `sendTimeout`, `receiveTimeout`, `badCertificate`, `badResponse`, `cancel`, `connectionError` y `unknown`. Configuras los timeouts una vez en `BaseOptions` y se aplican a cada solicitud.

```dart
// Flutter 3.44, Dart 3.x, dio 5.9.2
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://api.example.com',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 10),
));

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await dio.get<List<dynamic>>('/names');
    return Success((response.data ?? []).cast<String>());
  } on DioException catch (e) {
    return switch (e.type) {
      DioExceptionType.connectionError => const Offline(),
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout =>
        const TimedOut(),
      DioExceptionType.badResponse =>
        ServerError(e.response?.statusCode ?? 0),
      _ => BadResponse(e.message ?? 'Unknown dio error'),
    };
  }
}
```

`dio` también valida los estados por defecto: una respuesta que no es 2xx lanza `DioException` con `type == badResponse` en lugar de devolver en silencio, así que el error de "olvidé comprobar el estado" no puede ocurrir. Y como `dio` expone una tubería de interceptores, puedes adjuntar la lógica de reintento de forma centralizada en lugar de envolver cada llamada. El paquete de la comunidad `dio_smart_retry` se conecta a esa tubería y reintenta solicitudes idempotentes con backoff de fábrica, lo que vale la pena adoptar una vez que tienes más de un puñado de endpoints.

## connectivity_plus te informa sobre la radio, no sobre internet

Una petición frecuente es "comprobar si el usuario está en línea antes de hacer la llamada". `connectivity_plus` 7.1.1 hace parte de esto, pero lee su propia advertencia con atención: la disponibilidad del tipo de conexión no garantiza acceso a internet. A partir de la versión 5, la API devuelve un `List<ConnectivityResult>` (un dispositivo puede estar en Wi-Fi y en datos a la vez), no un valor único, lo que descoloca al código escrito contra ejemplos antiguos.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
import 'package:connectivity_plus/connectivity_plus.dart';

Future<bool> hasNetworkInterface() async {
  final results = await Connectivity().checkConnectivity();
  return !results.contains(ConnectivityResult.none);
}
```

La trampa es tratar esto como una barrera: "si está conectado, la solicitud tendrá éxito". No será así. Un teléfono reporta `wifi` mientras está conectado a la red de una cafetería que no ha sido autorizada a través de su portal cautivo, así que cada solicitud sigue fallando con un `SocketException` o un timeout. Usa `connectivity_plus` para reaccionar a los cambios (mostrar un banner de sin conexión en el momento en que la radio se cae, ocultarlo cuando vuelve) y para decidir si siquiera vale la pena reintentar, pero nunca como sustituto de manejar de verdad la excepción de la solicitud. La comprobación de conectividad es una optimización, el manejador de excepciones es la fuente de verdad.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
// React to connectivity changes for a live offline banner.
final sub = Connectivity().onConnectivityChanged.listen(
  (List<ConnectivityResult> results) {
    final online = !results.contains(ConnectivityResult.none);
    // update a banner; this stream's subscription must be cancelled
    // in dispose() like any other.
  },
);
```

Ese `StreamSubscription` es exactamente el tipo de recurso que se fuga si olvidas cancelarlo, que es el tema completo de [liberar controladores y suscripciones en Flutter](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## Casos límite que separan una app robusta de una demo

**Cancelación al hacer dispose.** Si el usuario navega fuera a mitad de la solicitud, el `Future` puede completarse igualmente y llamar a `setState` sobre un `State` ya difunto, lanzando una excepción. Protégelo con `if (!mounted) return;` después de cada `await` en un widget, o mueve la llamada a una capa de gestión de estado que sobreviva a la navegación. La propiedad mal manejada aquí es un tema recurrente al reestructurar una app, que es parte de por qué [migrar de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) debe tener cuidado con dónde vive el trabajo asíncrono.

**Los timeouts deben ser más cortos que la paciencia del usuario, no la del servidor.** Un timeout de 30 segundos es técnicamente correcto y una experiencia terrible. Elige un connect timeout de alrededor de 5 segundos y un receive timeout de alrededor de 10, y muestra un reintento mucho antes de que un usuario concluya que la app está congelada.

**Un 200 con el cuerpo equivocado sigue siendo un fallo.** Trata la validación del esquema como parte del manejo de red. Si `jsonDecode` tiene éxito pero falta un campo requerido, eso es un `BadResponse`, no un `Success`. Valida la forma antes de construir tu modelo, o empujarás el fallo a lo profundo de la interfaz, donde es mucho más difícil de diagnosticar.

**No hagas log y rethrow en cada capa.** Elige un único lugar (el mapeo de excepciones de la capa de datos) para registrar el error con su traza de pila, y deja que el resultado tipado cargue con lo demás. Registrar la misma excepción tres veces mientras burbujea hacia arriba solo hace tus reportes de fallos más ruidosos.

**Los reintentos amplifican la carga durante un corte.** Cuando un backend ya está sufriendo, los reintentos agresivos del cliente lo empeoran. Acota los intentos, usa backoff con jitter, y respeta una cabecera `Retry-After` si el servidor la envía. La degradación elegante tiene tanto que ver con ser un buen cliente como con mostrar una pantalla de error bonita.

El hilo conductor es que el "manejo de errores de red" son en realidad tres trabajos que la gente colapsa en uno: capturar el fallo específico, clasificarlo en algo sobre lo que la interfaz y la lógica de reintento puedan razonar, y presentarlo como un estado sobre el que el usuario pueda actuar. Haz bien las cláusulas `catch` tipadas y el resultado sellado, añade un backoff acotado para los casos transitorios, y trata `connectivity_plus` como una pista en lugar de una garantía, y el snackbar genérico de "Algo salió mal" desaparece de tu app para siempre.

## Relacionado

- [Cómo liberar controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) cubre cómo cancelar el `StreamSubscription` que crea un listener de conectividad.
- [Fix: FormatException Unexpected character al parsear JSON en Dart](/es/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) es el caso del cuerpo malformado en detalle.
- [Cómo escribir un isolate de Dart para trabajo intensivo de CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) es donde debe vivir la decodificación pesada de respuestas para que los reintentos no provoquen jank en la interfaz.
- [Cómo migrar una app Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) muestra dónde debe vivir el trabajo de red asíncrono a través de un cambio de gestión de estado.
- [Fix: RenderFlex overflowed en Flutter](/es/2026/05/fix-renderflex-overflowed-in-flutter/) evita que tus widgets de error y de carga rompan el layout.

## Fuentes

- [DioException class, referencia de la API de dio](https://pub.dev/documentation/dio/latest/dio/DioException-class.html)
- [DioExceptionType enum, referencia de la API de dio](https://pub.dev/documentation/dio/latest/dio/DioExceptionType.html)
- [connectivity_plus, pub.dev](https://pub.dev/packages/connectivity_plus)
- [Future.timeout, referencia de la API de Dart](https://api.dart.dev/stable/dart-async/Future/timeout.html)
- [SocketException class, referencia de la API de Dart](https://api.dart.dev/stable/dart-io/SocketException-class.html)
- [http package, pub.dev](https://pub.dev/packages/http)

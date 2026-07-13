---
title: "Cómo cancelar un StreamSubscription en dispose para evitar un fallo setState-después-de-dispose en Flutter"
description: "Un stream sigue emitiendo después de que el usuario abandona la pantalla, su onData llama a setState sobre un State ya destruido, y Flutter lanza una excepción. Guarda la suscripción, cancélala en dispose antes de super.dispose, y el callback nunca podrá ejecutarse sobre un widget muerto. El patrón completo para Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "es"
translationOf: "2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

Cuando llamas a `stream.listen(...)` dentro de un `State`, eres dueño de la suscripción y debes cancelarla en `dispose()`. Si no lo haces, el stream sigue entregando eventos después de que el usuario abandona la pantalla, el callback `onData` ejecuta `setState` sobre un `State` que ya fue destruido, y Flutter lanza `setState() called after dispose()`. La solución son tres líneas: guarda el `StreamSubscription` en un campo, créalo en `initState`, y llama a `_sub.cancel()` en `dispose()` antes de `super.dispose()`. Cancelar detiene la entrega, así que el callback nunca llega a ejecutarse sobre un widget muerto. Esta guía usa Flutter 3.44 (versión estable actual, 2026) y Dart 3.x.

La distinción que importa: cancelar es la solución real, y una comprobación `mounted` es solo un parche sobre el síntoma. Un `StreamSubscription` es una tubería viva entre una fuente que sobrevive a tu widget (un `StreamController`, un listener de snapshots de Firestore, un WebSocket, un sensor, `connectivity_plus`) y un callback que captura `this`. Mientras esa tubería esté abierta, tu `State` es accesible y tu `onData` se ejecuta en cada evento, destruido o no. Cerrar la tubería es el punto donde desaparecen a la vez la fuga de memoria y el fallo.

## Por qué el callback sobrevive al widget

El ciclo de vida del widget de Flutter y el ciclo de vida de un stream son completamente independientes. El framework destruye tu `State` cuando su elemento abandona el árbol: el usuario hace pop de la ruta, un padre te reconstruye fuera de existencia, cambia una pestaña. Nada de eso toca el stream. El `StreamController` del otro extremo no tiene idea de que un widget estaba escuchando, y menos aún de que el widget ya no está. Sigue produciendo eventos, y Dart sigue despachándolos a cada suscripción registrada, incluida la tuya.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _PriceTickerState extends State<PriceTicker> {
  double _price = 0;

  @override
  void initState() {
    super.initState();
    priceStream.listen((value) {   // subscription is never stored
      setState(() => _price = value); // runs even after dispose()
    });
  }
}
```

Este código pasa cada prueba rápida, porque en una prueba rápida no abandonas la pantalla mientras un evento está en vuelo. Empuja una nueva ruta mientras `priceStream` todavía emite una vez por segundo, y el siguiente tick aterriza en `onData`, que llama a `setState` sobre un `State` difunto. En debug obtienes un `FlutterError`: `setState() called after dispose(): _PriceTickerState#4f2a1(lifecycle state: defunct, not mounted)`. La suscripción devuelta por `listen` se tiró, así que no hay manejador que cancelar ni nada que detenga el evento. El `State` tampoco se puede recolectar como basura, porque la lista interna de suscripciones del stream todavía referencia el closure que lo capturó. Ese es el mismo error de propiedad detrás de [cómo destruir controllers para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): un recurso que creaste y nunca liberaste.

## El patrón, paso a paso

### Paso 1: Guarda la suscripción en un campo

`listen` devuelve un `StreamSubscription<T>`. Guárdalo. Ese manejador es la única forma de cancelar después.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;
  // ...
}
```

Usa un campo anulable (`StreamSubscription<double>?`) cuando la suscripción se crea de forma condicional, para que `dispose` pueda llamar a `_sub?.cancel()` de forma segura. Si siempre te suscribes exactamente una vez en `initState`, un `late final StreamSubscription<double> _sub;` es más limpio porque documenta que el campo siempre se asigna y te deja cancelar sin condiciones.

### Paso 2: Suscríbete en initState, no en build

Crea la suscripción en `initState` (o en `didChangeDependencies` si el stream viene de un inherited widget), nunca en `build`. `build` se ejecuta en cada frame, así que suscribirse ahí apila un nuevo listener en cada reconstrucción, y cada uno dispara `setState`, que programa otra reconstrucción. Ese bucle de retroalimentación es una clase de error distinta de la de este post, y aparece como [setState() or markNeedsBuild() called during build](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

```dart
// Flutter 3.44, Dart 3.x
@override
void initState() {
  super.initState();
  _sub = priceStream.listen(
    (value) => setState(() => _price = value),
    onError: (Object e, StackTrace s) => setState(() => _price = -1),
  );
}
```

### Paso 3: Cancela en dispose, antes de super.dispose

Esta es la línea que realmente arregla el fallo.

```dart
// Flutter 3.44, Dart 3.x
@override
void dispose() {
  _sub?.cancel();
  super.dispose();
}
```

El orden importa igual que para los controllers: libera tus propios recursos primero, luego cede el control al framework con `super.dispose()`. Después de que `cancel()` retorna, la suscripción está muerta. No entregará ningún callback `onData`, `onError` ni `onDone` posterior, incluso para eventos que la fuente ya haya producido pero aún no haya despachado. Esa es la garantía que compras: el closure que llama a `setState` ya no puede ejecutarse, así que el `State` destruido queda intocable.

## Por qué no esperas cancel en dispose

`StreamSubscription.cancel()` devuelve un `Future<void>`, y `dispose()` devuelve `void`, así que no puedes usar `await` sobre él. Esto confunde a la gente, pero no es un problema. El future se completa cuando el callback `onCancel` del stream termina cualquier limpieza que necesite (cerrar un socket, liberar un file handle). La entrega a tu callback se detiene de inmediato sin importar cuándo se resuelva ese future. Para el propósito de no llamar a `setState` sobre un widget muerto, el `cancel()` sin await es plenamente efectivo en el momento en que se llama.

El future solo importa si específicamente necesitas saber cuándo la fuente terminó de limpiar, lo cual es raro dentro de un widget. Si tú mismo eres dueño del `StreamController` y quieres garantizar que su `onCancel` se ejecutó antes de continuar, haz esa limpieza fuera de `dispose`, donde sí puedes esperarla con await.

## Múltiples suscripciones en un widget

Una pantalla a menudo escucha varios streams: conectividad, un feed de datos, un stream de visibilidad del teclado. Cancela cada uno. Dos enfoques limpios.

Campos separados cuando las suscripciones son de tipos distintos y las referencias individualmente:

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<ConnectivityResult>? _connSub;
StreamSubscription<Order>? _orderSub;

@override
void dispose() {
  _connSub?.cancel();
  _orderSub?.cancel();
  super.dispose();
}
```

Una lista cuando solo necesitas desmontarlas todas juntas:

```dart
// Flutter 3.44, Dart 3.x
final _subs = <StreamSubscription<dynamic>>[];

@override
void initState() {
  super.initState();
  _subs.add(connectivity.onConnectivityChanged.listen(_onConn));
  _subs.add(orders.stream.listen(_onOrder));
}

@override
void dispose() {
  for (final s in _subs) {
    s.cancel();
  }
  super.dispose();
}
```

La lista escala sin que tengas que recordar añadir una línea `cancel` por cada campo nuevo, que es exactamente el tipo de omisión que reintroduce el fallo meses después.

## Volver a suscribirse sin filtrar la suscripción vieja

Si el stream que escuchas depende de una propiedad del widget o de un valor heredado, la fuente puede cambiar mientras el widget sigue montado. Manéjalo en `didUpdateWidget` o `didChangeDependencies`, y cancela la suscripción anterior antes de abrir una nueva. Saltarte el cancel filtra la vieja y mantiene su `setState` vivo sobre el mismo `State`.

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(PriceTicker old) {
  super.didUpdateWidget(old);
  if (old.symbol != widget.symbol) {
    _sub?.cancel();                       // drop the old stream
    _sub = priceStreamFor(widget.symbol)  // subscribe to the new one
        .listen((v) => setState(() => _price = v));
  }
}
```

## Cuando eres dueño del StreamController, ciérralo también

Cancelar una suscripción y cerrar un controller son responsabilidades distintas. Cancela tu suscripción cuando solo eres consumidor del stream de otra persona. Si tu widget además creó el `StreamController` que respalda el stream, cierra el controller en `dispose` también, de lo contrario el controller y su buffer se filtran.

```dart
// Flutter 3.44, Dart 3.x
final _controller = StreamController<String>();
StreamSubscription<String>? _sub;

@override
void initState() {
  super.initState();
  _sub = _controller.stream.listen((msg) => setState(() => _last = msg));
}

@override
void dispose() {
  _sub?.cancel();       // stop consuming
  _controller.close();  // release the source you own
  super.dispose();
}
```

Un controller de suscripción única no dejará que un segundo listener se conecte, así que si además expones este stream en otro sitio, créalo con `StreamController.broadcast()`, y recuerda que cada listener sobre un stream de tipo broadcast necesita su propio `cancel`.

## Por qué StreamBuilder es a menudo la mejor respuesta

Si lo único que hace tu suscripción es alimentar un valor a la interfaz, probablemente no necesitas gestionar una suscripción en absoluto. `StreamBuilder` se suscribe cuando se inserta, se reconstruye en cada evento a través de su `builder`, y cancela automáticamente cuando se elimina del árbol. No hay `setState`, ni campo, ni contabilidad en `dispose`, y por tanto ninguna forma de dejar una suscripción corriendo pasada la destrucción.

```dart
// Flutter 3.44, Dart 3.x
StreamBuilder<double>(
  stream: priceStream,
  builder: (context, snap) => Text('${snap.data ?? 0}'),
)
```

Recurre a un `listen` manual más `setState` solo cuando el evento hace algo distinto de renderizar: navegar en un evento de finalización, mostrar un `SnackBar`, escribir en otro controller, disparar un efecto secundario. Esos son exactamente los casos donde un callback obsoleto es peligroso, y exactamente donde cancelar en `dispose` no es negociable. El mismo compromiso entre gestión manual y gestión automática aparece con `TextEditingController`, por lo que [un controller usado después de ser destruido](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) lanza el error análogo.

## pause no es cancel, y mounted no es un sustituto

Dos atajos parecen resolver esto y no lo hacen.

`StreamSubscription.pause()` detiene la entrega temporalmente, pero una suscripción pausada sigue registrada y sigue reteniendo tu `State`. Pausar en `dispose` filtra; debes usar `cancel`.

Un `if (!mounted) return;` al principio de `onData` evita la llamada a `setState`, pero no detiene el stream. La suscripción sigue viva, sigue despachando eventos, y sigue manteniendo tu `State` accesible. El fallo queda enmascarado mientras la fuga continúa. Usa la comprobación `mounted` solo para el caso para el que está diseñada, un `await` dentro del callback que se reanuda después de que el widget se fue, y cúbrelo a fondo aprendiendo a [proteger setState con la comprobación mounted tras un hueco async](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Para el caso simple de "el stream sigue emitiendo", cancel es la solución correcta y completa.

Si tu `onData` es en sí asíncrono, puedes toparte con ambos problemas a la vez: la suscripción entrega un evento, usas `await` dentro del manejador, y el widget se destruye durante el await. Cancel maneja la entrega; la comprobación `mounted` maneja la reanudación tras el await. Ahí sí está justificado el doble seguro.

## La versión de un solo archivo para copiar

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class PriceTicker extends StatefulWidget {
  const PriceTicker({super.key, required this.stream});
  final Stream<double> stream;

  @override
  State<PriceTicker> createState() => _PriceTickerState();
}

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;

  @override
  void initState() {
    super.initState();
    _sub = widget.stream.listen(
      (value) => setState(() => _price = value),
      onError: (Object e, StackTrace s) => setState(() => _price = -1),
    );
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(_price.toStringAsFixed(2));
}
```

Guarda la suscripción, cancélala antes de `super.dispose()`, y el fallo `setState()-después-de-dispose()` se vuelve estructuralmente imposible en lugar de evitado por probabilidad. El estado en streaming que viene de la red merece el mismo cuidado en la ruta de error, algo que vale la pena combinar con una mirada a cómo [manejar errores de red con elegancia en una app Flutter](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) para que un stream fallido muestre un estado sobre el que el usuario pueda actuar en lugar de un spinner que nunca se resuelve.

## Fuentes

- [StreamSubscription.cancel API](https://api.flutter.dev/flutter/dart-async/StreamSubscription/cancel.html) - el contrato de cancel y su retorno `Future<void>`.
- [State.dispose API](https://api.flutter.dev/flutter/widgets/State/dispose.html) - "subclasses should override this method to release any resources retained by this object (e.g., stop any active animations)".
- [StreamBuilder class](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) - suscripción y cancelación automáticas ligadas al ciclo de vida del widget.
- [Dart streams tutorial](https://dart.dev/libraries/async/using-streams) - streams de suscripción única frente a broadcast y gestión de listeners.

---
title: "¿Cuál es la diferencia entre un isolate de Dart y un hilo?"
description: "Un hilo comparte memoria con todos los demás hilos del proceso. Un isolate de Dart no: es dueño de su heap, ejecuta un único bucle de eventos y solo habla con otros isolates mediante mensajes. Esto es lo que significa a nivel de la VM, dónde los isolate groups difuminan la línea y cómo se traduce en Flutter, FFI y la web."
pubDate: 2026-08-29
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "threading"
lang: "es"
translationOf: "2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread"
translatedBy: "claude"
translationDate: 2026-08-29
---

Un hilo es un contexto de ejecución que comparte el heap del proceso con todos los demás hilos, y por eso el código con hilos necesita bloqueos, atómicos y barreras de memoria. Un isolate de Dart es un contexto de ejecución que es dueño de su propia memoria y ejecuta un único bucle de eventos, y la única forma en que puede alcanzar a otro isolate es enviando un mensaje por un puerto. La consecuencia práctica es que Dart no tiene una palabra clave `lock`, ni `volatile`, ni condiciones de carrera sobre objetos Dart, y el precio es que todo lo que le pasas a otro isolate se copia salvo que uses una de dos salidas de emergencia. Los isolates sí se ejecutan sobre hilos reales del sistema operativo, tomados de un pool que administra la VM, pero el mapeo no es uno a uno y nunca programas contra él. Todo lo que sigue apunta a Dart 3.12.2 y Flutter 3.44.7.

Si llegaste aquí porque un cálculo te congela la UI y quieres el código que lo arregla, la mecánica está en la guía sobre [escribir un isolate de Dart para trabajo intensivo de CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/). Este artículo trata del modelo que hay debajo, porque la mayoría de los errores con isolates son en realidad un modelo mental equivocado de qué es un isolate.

## El modelo: un heap y un bucle de eventos por isolate

La documentación del lenguaje Dart lo resume en una frase: "los isolates son como hilos o procesos, pero cada isolate tiene su propia memoria y un único hilo ejecutando un bucle de eventos". Ahí van dos afirmaciones, y las dos importan.

Memoria propia significa que cada isolate tiene su propia copia de cada campo global y estático. Un `int requestCount = 0` de nivel superior no es una variable en tu programa, es una variable por isolate. Mutarla en un worker deja intacta la copia del isolate principal, porque, como dice la documentación, "cada isolate tiene sus propios campos globales, lo que garantiza que nada del estado de un isolate sea accesible desde ningún otro isolate".

Un bucle de eventos significa que un isolate procesa eventos de a uno, para siempre, en un bucle que conceptualmente se ve así:

```dart
// The Dart event loop, conceptually. Dart 3.12.
while (eventQueue.waitForEvent()) {
  eventQueue.processNextEvent();
}
```

Nada interrumpe un evento una vez que empezó. Un callback que pasa 90 ms parseando JSON retiene el bucle durante 90 ms, y cada temporizador, cada future completado y, en Flutter, cada frame, esperan detrás de él. Es lo contrario a un hilo, que el planificador del sistema operativo puede suspender a mitad de una instrucción para que otro hilo corra.

Junta las dos cosas y obtienes el modelo de actores: estado aislado, procesamiento secuencial, paso de mensajes. Como afirma la documentación, "que no haya estado compartido entre isolates significa que no ocurrirán complejidades de concurrencia como mutexes, bloqueos o carreras de datos".

## La condición de carrera que no puedes escribir en Dart

Esta es la forma más clara de sentir la diferencia. En C# lo siguiente es una carrera genuina, y arreglarla exige `Interlocked` o un bloqueo:

```csharp
// C# 14, .NET 11. Two threads, one heap, one bug.
static int _counter;

var t1 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
var t2 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
t1.Start(); t2.Start(); t1.Join(); t2.Join();
Console.WriteLine(_counter); // Not 200000. Ever, reliably.
```

La traducción a Dart no tiene carrera, y tampoco hace lo que espera quien recién llega:

```dart
// Dart 3.12.
import 'dart:isolate';

int counter = 0; // one copy per isolate, not one per program

void bump(int times) {
  for (var i = 0; i < times; i++) {
    counter++;
  }
}

Future<void> main() async {
  await Future.wait([
    Isolate.run(() { bump(100000); return counter; }),
    Isolate.run(() { bump(100000); return counter; }),
  ]);
  print(counter); // 0
}
```

Cada isolate lanzado incrementa su propio `counter` hasta 100000 y luego muere con él. El isolate principal imprime `0`. No hay lectura corrupta que rastrear ni bloqueo que agregar, porque nunca hubo una sola variable por la que competir. Todo valor que necesite volver tiene que volver como mensaje, que es exactamente lo que es el valor de retorno de `Isolate.run`.

## Qué ejecuta realmente un isolate: el pool de hilos de la VM

Los isolates no flotan en el aire. La VM de Dart los ejecuta sobre hilos del sistema operativo, y las reglas de esa relación están documentadas en el escrito sobre las interioridades de la VM de Dart de Vyacheslav Egorov.

Un hilo del sistema operativo "solo puede entrar en un isolate a la vez. Tiene que abandonar el isolate actual si quiere entrar en otro". Y en la dirección contraria, "solo puede haber un único hilo mutador asociado a un isolate a la vez. El hilo mutador es el hilo que ejecuta código Dart y usa la API pública de C de la VM".

Así que la invariante es de uno a la vez en ambas direcciones, no de uno a uno para siempre. Distintos hilos del sistema operativo pueden ejecutar el mismo isolate en momentos distintos, y un mismo hilo puede servir a varios isolates a lo largo de su vida. La VM no dedica un hilo a un isolate como `new Thread()` dedica uno a un delegado: "internamente la VM usa un pool de hilos para administrar los hilos del sistema operativo y el código está estructurado alrededor del concepto de ThreadPool::Task en lugar del concepto de hilo del sistema operativo". El trabajo de fondo, como la recolección de basura y la compilación JIT, se publica en ese pool como tareas.

La lección para tu código es que los isolates son la unidad sobre la que razonas y los hilos son un detalle de implementación por debajo. No puedes fijar un isolate a un núcleo, no puedes pasar un isolate a una API nativa que espera un handle de hilo, y no deberías asumir que la identidad del hilo del sistema operativo de tu isolate es estable a través de los puntos de suspensión.

## Isolate groups: el heap compartido que el lenguaje te oculta

Aquí es donde "cada isolate tiene su propia memoria" deja de ser literalmente cierto a nivel de implementación, y vale la pena saberlo porque explica los números de rendimiento.

Desde Dart 2.15 la VM organiza los isolates en isolate groups. `Isolate.spawn` e `Isolate.run` crean el nuevo isolate dentro del grupo actual; solo `Isolate.spawnUri` arranca un grupo nuevo con una copia nueva del programa. Dentro de un grupo, la VM comparte las estructuras del programa y, como dice el documento sobre las interioridades de la VM, los isolates de un grupo "comparten el mismo heap administrado por el recolector de basura".

El anuncio de Dart 2.15 cuantifica lo que eso compró: arrancar un isolate adicional dentro de un grupo existente es "más de 100 veces más rápido", y esos isolates "consumen entre 10 y 100 veces menos memoria" que antes de que existieran los grupos. Por eso `spawnUri` es el camino lento y `spawn` es el que usas.

La garantía a nivel de lenguaje no cambia. Sigues sin poder alcanzar los objetos de otro isolate, el aislamiento se aplica por encima del heap y el heap compartido es un detalle de implementación. Pero es la razón por la que otras dos cosas son posibles.

## Copiar es el precio, y hay dos salidas

Por defecto, enviar un objeto por un `SendPort` copia todo su grafo de objetos. Envía un `Map` con 50000 entradas y el isolate receptor recibe una copia profunda, y mutarla ahí es invisible para quien la envió. La mayoría de los objetos de Dart se pueden enviar. Las excepciones documentadas son los objetos respaldados por recursos nativos, como `Socket`, además de `ReceivePort`, `DynamicLibrary`, `Finalizable`, `Finalizer`, `NativeFinalizer`, `Pointer`, `UserTag` y todo lo anotado con `@pragma('vm:isolate-unsendable')`. Aparte de esos, dice la documentación, "cualquier objeto se puede enviar".

La primera salida es `Isolate.exit`. "Termina el isolate actual de forma síncrona" y entrega un mensaje final y, como emisor y receptor están en el mismo grupo y por lo tanto en el mismo heap, "este grafo de objetos del mensaje final se reasignará al isolate receptor sin copiarlo". Sin copia, al costo de que el isolate termine ahí mismo: los bloques `finally` pendientes no se ejecutan y el trabajo asíncrono encolado nunca corre.

En general lo obtienes gratis. `Isolate.run`, agregado en Dart 2.19, está implementado sobre `Isolate.spawn` más `Isolate.exit` precisamente para que el resultado vuelva sin copia:

```dart
// Dart 3.12. One-shot work, result transferred rather than copied.
final parsed = await Isolate.run(() {
  final text = File('bulk.json').readAsStringSync();
  return jsonDecode(text) as Map<String, dynamic>;
});
```

La segunda salida es `TransferableTypedData`, que mueve la propiedad de un búfer de bytes entre isolates sin copiarlo. Úsala cuando la carga son bytes (una imagen, un archivo descargado, un búfer de audio decodificado) y no un grafo de objetos.

Si te encuentras enviando resultados grandes de forma repetida, ten en cuenta el compromiso que la propia guía de Flutter deja claro: "hay una sobrecarga de rendimiento necesaria para lanzar nuevos isolates y para copiar objetos de un isolate a otro. Si haces el mismo cálculo con `Isolate.run` repetidamente, podrías tener mejor rendimiento creando isolates que no terminen de inmediato".

## async/await tampoco es un hilo

El malentendido más común de la zona es creer que `await` mueve el trabajo fuera del isolate actual. No lo hace. `Future`, `Stream` y `await` son construcciones de planificación sobre el único bucle de eventos del isolate en el que ya estás. Esperar la lectura de un socket cede el bucle mientras el sistema operativo hace la E/S, y por eso lo asíncrono alcanza para trabajo de red y de archivos. Esperar una función que pasa 200 ms en un bucle apretado no cede nada, porque no hay ningún punto de suspensión dentro de ella.

La regla es corta. La asincronía es para esperar; los isolates son para calcular. Si lo caro es trabajo de CPU síncrono, solo un isolate lo saca del bucle. Si vas a llevar el resultado a los widgets, la [comparación entre FutureBuilder, StreamBuilder y AsyncValue de Riverpod](/es/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) cubre con qué primitiva asíncrona exponerlo.

## Dónde se asoma el modelo de hilos en Flutter

Flutter ejecuta tu aplicación en el isolate principal, también llamado isolate raíz. Como dice la documentación de Flutter, "las aplicaciones de Flutter hacen todo su trabajo en un solo isolate, el isolate principal", y "todas las tareas de UI y el propio Flutter están acoplados al isolate principal".

Por debajo, el engine realmente usa varios hilos del sistema operativo para rasterización, E/S y trabajo de plataforma, y su disposición cambió hace poco: desde Flutter 3.29, "los hilos de UI y de plataforma están fusionados en iOS y Android. En concreto, el hilo de UI se elimina y el código Dart corre en el hilo nativo de plataforma". Ese es un cambio de hilos sin equivalente a nivel de isolate, lo que ilustra bien que las dos capas son independientes. Tu código Dart no se mudó a otro isolate, se mudó a otro hilo del sistema operativo, y nada en el modelo de isolates se enteró.

Dos consecuencias muerden en los isolates de fondo:

- Nada de UI ni de assets. "No puedes acceder a los assets con `rootBundle` en isolates lanzados, ni realizar trabajo de widgets o de UI en isolates lanzados". Cualquier objeto de `dart:ui` pertenece al isolate principal.
- Los canales de plataforma necesitan arranque previo. Desde que llegaron los canales de plataforma en isolates de fondo, un worker puede llamar a Android o iOS, pero solo tras registrarse con el messenger del isolate raíz, y aun así "no puede recibir mensajes no solicitados desde la plataforma anfitriona".

```dart
// Dart 3.12, Flutter 3.44.7. Platform channels from a background isolate.
Future<void> _isolateMain(RootIsolateToken rootIsolateToken) async {
  BackgroundIsolateBinaryMessenger.ensureInitialized(rootIsolateToken);
  final prefs = await SharedPreferences.getInstance();
  // ... plugin calls now work here
}
```

Si estás persiguiendo frames perdidos y todavía no sabes si un isolate es siquiera la respuesta, mide primero: el recorrido sobre [perfilar el jank con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) muestra cómo distinguir un callback síncrono largo de un problema de layout o de rasterizado, y las dos cosas tienen arreglos completamente distintos. Cuando el trabajo resulta pertenecer al lado de la plataforma, [agregar código específico de plataforma sin escribir un plugin](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) es el camino más barato.

## FFI es donde tocas hilos de verdad

El único lugar donde el hilo de abajo se vuelve visible es `dart:ffi`. Una llamada FFI síncrona corre sobre el hilo del sistema operativo que en ese momento sea el hilo mutador del isolate, y bloquea ese hilo y, por lo tanto, el bucle de eventos del isolate hasta que retorna. Las llamadas nativas largas van en un isolate worker exactamente por la misma razón que los bucles largos de Dart.

Los callbacks en la dirección contraria están limitados por la misma regla de un isolate por hilo, y por eso `NativeCallable` (Dart 3.1) tiene distintas variantes. `NativeCallable.isolateLocal` "debe invocarse desde el mismo hilo que lo creó", mientras que `NativeCallable.listener` y `NativeCallable.isolateGroupBound` "pueden invocarse desde cualquier hilo". Si una biblioteca nativa te devuelve la llamada desde su propio hilo de trabajo, `isolateLocal` es un crash esperando a ocurrir y `listener` es el constructor que quieres.

## La web no tiene ninguno de los dos

En la web no hay isolates en absoluto. Dart compilado a JavaScript corre en el único hilo del navegador, así que `compute` se degrada con elegancia en lugar de paralelizar: "en plataformas web esto ejecutará el callback en el bucle de eventos actual. En plataformas nativas esto ejecutará el callback en un isolate separado". Los web workers son la respuesta del navegador, pero no son un reemplazo directo, porque "solo puedes crear web workers declarando un punto de entrada de programa separado y compilándolo por separado", y copian datos a través de la frontera sin las APIs de transferencia que tienen los isolates.

Si una ruta de código depende del paralelismo para que su presupuesto de frame sea correcto, pruébala en la web por separado. Va a ejecutarse, y va a bloquear.

## Qué está cambiando

El modelo estricto tiene un costo conocido: los juegos, la física y los pipelines de imágenes pagan por copiar datos que lógicamente pertenecen a un solo cálculo. El equipo de Dart está explorando una relajación selectiva, que se sigue en el issue paraguas de multithreading con memoria compartida en dart-lang/sdk, con una propuesta de lenguaje de Vyacheslav Egorov. La primera fase cubre memoria nativa compartida, con isolates compartidos, campos estáticos marcados con `@pragma('vm:shared')` para tipos trivialmente compartibles, y llamadas hacia un isolate group desde un hilo nativo arbitrario. `NativeCallable.isolateGroupBound` es la punta visible de ese trabajo.

Nada de esto cambia el modelo por defecto y, a fecha de Dart 3.12, deberías tratarlo como experimental y leer el issue de seguimiento antes de diseñar alrededor de ello. La suposición segura para código de producción hoy sigue siendo: los isolates son dueños de su estado, los mensajes son copias, y `Isolate.exit` más `TransferableTypedData` son tus únicos caminos sin copia.

## Elegir el modelo mental correcto

- Si buscas un bloqueo, modelaste el problema como hilos. En Dart no hay nada que bloquear; reestructúralo como un mensaje.
- Compartir un objeto grande entre dos isolates no es posible. O envías una copia, o lo transfieres una vez con `Isolate.exit` o `TransferableTypedData`, o lo mantienes en un isolate y le envías comandos a ese isolate.
- `await` nunca agrega un hilo. Solo los isolates agregan paralelismo, y solo en targets nativos.
- Un worker de larga vida le gana a `Isolate.run` repetido cuando haces el mismo cálculo muchas veces, porque lanzar y copiar no son gratis.
- FFI, no Dart, es donde importa la identidad del hilo. Elige el constructor de `NativeCallable` que corresponda al hilo desde el que llama el lado nativo.

## Enlaces de referencia

- [Concurrency in Dart](https://dart.dev/language/concurrency)
- [Concurrency and isolates, documentación de Flutter](https://docs.flutter.dev/perf/isolates)
- [Introduction to Dart VM, interioridades de hilos e isolates](https://mrale.ph/dartvm/)
- [Announcing Dart 2.15, isolate groups](https://dart.dev/blog/announcing-dart-2-15)
- [Better isolate management with Isolate.run](https://dart.dev/blog/better-isolate-management-with-isolate-run)
- [Referencia de la API de Isolate.exit](https://api.dart.dev/stable/dart-isolate/Isolate/exit.html)
- [Referencia de la API de NativeCallable](https://api.dart.dev/stable/dart-ffi/NativeCallable-class.html)
- [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)
- [Explore shared memory multithreading, dart-lang/sdk#55991](https://github.com/dart-lang/sdk/issues/55991)

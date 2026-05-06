---
title: "Cómo perfilar jank en una app de Flutter con DevTools"
description: "Guía paso a paso para encontrar y corregir jank en Flutter 3.27 con DevTools: profile mode, el Performance overlay, la pestaña Frame Analysis, el CPU Profiler, raster vs hilo de UI, precalentamiento de shaders y particularidades de Impeller. Probado en Flutter 3.27.1, Dart 3.11, DevTools 2.40."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "devtools"
  - "performance"
  - "jank"
  - "how-to"
lang: "es"
translationOf: "2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools"
translatedBy: "claude"
translationDate: 2026-05-06
---

Respuesta corta: compila con `flutter run --profile` (nunca debug), abre DevTools, cambia a la pestaña Performance, reproduce el jank y lee el gráfico Frame Analysis. Los frames que superan el presupuesto (16.67 ms a 60 Hz, 8.33 ms a 120 Hz) aparecen coloreados. Si la barra fuera de presupuesto está roja en el hilo de UI, salta al CPU Profiler y revisa tu código Dart; si está roja en el hilo de raster, el cuello de botella está en la GPU y la solución suele ser precalentar shaders, usar imágenes más pequeñas o reducir efectos costosos. Esta guía recorre cada una de esas decisiones en Flutter 3.27.1, Dart 3.11 y DevTools 2.40.

## Por qué no puedes perfilar jank en debug

Las compilaciones de debug son lentas a propósito. Ejecutan código JIT no optimizado, incluyen todas las aserciones y omiten el pipeline AOT. El propio framework imprime `"This is a debug build"` sobre la app para recordártelo. Los números recogidos en debug suelen ser de 2x a 10x peores que en release, así que cualquier jank que "encuentres" allí podría no existir en producción. Peor aún: puedes pasar por alto jank real porque debug corre a una frecuencia de cuadro por defecto más baja en algunos dispositivos Android.

Perfila siempre con `flutter run --profile` contra un dispositivo real. El simulador y el iOS Simulator no representan el comportamiento real de la GPU, especialmente en lo relativo a la compilación de shaders. Profile mode mantiene los hooks de DevTools (eventos de timeline, seguimiento de asignaciones, observatory) pero compila tu código Dart con el pipeline AOT, así que los números están dentro de un pequeño porcentaje de release. La [documentación de rendimiento de Flutter](https://docs.flutter.dev/perf/ui-performance) es explícita al respecto.

```bash
# Flutter 3.27.1
flutter run --profile -d <your-device-id>
```

Si el dispositivo está conectado por USB, también puedes usar `--profile --trace-startup` para capturar un timeline de inicio en `build/start_up_info.json`, útil para medir específicamente el jank de arranque en frío.

## Abre DevTools y elige la pestaña correcta

Una vez que `flutter run --profile` esté arriba, la consola imprime una URL de DevTools como `http://127.0.0.1:9100/?uri=...`. Ábrela en Chrome. Las pestañas relevantes para jank son, en orden:

1. **Performance**: timeline de frames, Frame Analysis, raster cache, controles de enhance tracing.
2. **CPU Profiler**: profiler por muestreo con vistas bottom-up, top-down y árbol de llamadas.
3. **Memory**: seguimiento de asignaciones y eventos de GC. Útil si el jank correlaciona con GC.
4. **Inspector**: árbol de widgets. Útil para confirmar una tormenta de rebuilds.

El "Performance overlay" que también puedes activar desde dentro de la app en ejecución (`P` en la terminal, o `WidgetsApp.showPerformanceOverlay = true` en código) es una versión más pequeña de los mismos datos dibujada sobre tu UI. Es excelente para detectar jank en tiempo real en un dispositivo, pero no permite profundizar en un frame concreto. Usa el overlay para encontrar un escenario con jank y luego captúralo en DevTools.

## Cómo leer el gráfico Frame Analysis

En Performance, el gráfico superior muestra una barra por cada frame renderizado. Cada barra tiene dos segmentos apilados horizontalmente: el inferior es el hilo de UI (tu recorrido `build`, `layout`, `paint` en Dart), el superior es el hilo de raster (donde el motor rasteriza el árbol de capas en la GPU). Si cualquiera de los dos segmentos supera el presupuesto del frame, la barra se vuelve roja.

El presupuesto del frame es `1000 ms / refresh_rate`. En un dispositivo a 60 Hz son 16.67 ms en total, pero no dispones de 16.67 ms en cada hilo. Un frame solo llega a tiempo si tanto UI como raster terminan dentro de su presupuesto, lo que en la práctica significa más o menos 8 ms en cada uno (el resto es overhead del motor y alineación con vsync). En un dispositivo a 120 Hz, divide todo entre dos.

Haz clic en un frame rojo y el panel inferior cambiará a "Frame Analysis". Esta es la vista más útil de DevTools 2.40. Muestra:

- Los eventos de timeline para ese único frame.
- Si el coste dominante es `Build`, `Layout`, `Paint` o `Raster`.
- Si hubo compilación de shaders, decodificación de imágenes o llamadas por platform channel.
- Una pista textual como "This frame's UI work was dominated by a single Build phase" para que no tengas que adivinar.

Si la pista dice que el problema es el hilo de UI, la corrección está en tu código Dart. Si apunta al hilo de raster, la corrección está en la forma de tu árbol de widgets, en tus shaders, en tus imágenes o en tus efectos.

## Cuando el cuello de botella es el hilo de UI

El jank en el hilo de UI es tu código ejecutándose demasiado tiempo dentro de un frame. Las fuentes más comunes son:

- Un método `build` que hace trabajo real (parsear JSON, recorrer una lista de 10k elementos, regex sobre una cadena larga).
- Un `setState` que reconstruye un subárbol mucho mayor de lo necesario.
- Un `File.readAsStringSync` síncrono o cualquier I/O bloqueante.
- Un cambio pesado de `Listenable` que se propaga a muchos listeners.

Salta a la pestaña CPU Profiler mientras la interacción con jank está ocurriendo. Pon "Profile granularity" en "high" para ráfagas cortas y empieza a grabar. Detén la grabación tras los frames con jank. La vista bottom-up ("Heaviest frames at the top") suele identificar al culpable en segundos.

```dart
// Flutter 3.27.1, Dart 3.11
class ProductList extends StatelessWidget {
  const ProductList({super.key, required this.json});
  final String json;

  @override
  Widget build(BuildContext context) {
    // Bad: parses a 4 MB JSON blob on every rebuild on the UI thread.
    final products = (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();

    return ListView.builder(
      itemCount: products.length,
      itemBuilder: (_, i) => ProductTile(product: products[i]),
    );
  }
}
```

La solución es mover el trabajo fuera del hilo de UI, ya sea con una llamada puntual a `compute(...)` o, para trabajo CPU-bound recurrente, un isolate de larga duración. Hay un recorrido completo de ambos en [la guía dedicada a escribir un isolate de Dart para trabajo CPU-bound](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

Un coste más sutil del hilo de UI es reconstruir demasiado. Envuelve la parte que realmente cambia en un widget pequeño para que su `build` sea el único que se ejecute en `setState`. El control "Highlight Repaints" del Inspector (en Performance > More options) dibuja un borde de color alrededor de cada capa que se repinta, que es la forma más rápida de detectar un `Container` cerca de la raíz que reconstruye toda la pantalla.

## Cuando el cuello de botella es el hilo de raster

El jank en el hilo de raster significa que el motor está haciendo demasiado trabajo de GPU para el árbol de capas que producen tus widgets. La solución casi nunca es "usa un teléfono más rápido". Suele ser una de estas:

1. **Jank por compilación de shaders**: los efectos por primera vez (transiciones de página, gradientes, blurs, custom painters) compilan shaders en mitad del frame, lo que dispara el tiempo de raster. Se ve como uno o dos frames extremos la primera vez que se abre una pantalla.
2. **Capas fuera de pantalla**: `Opacity`, `ShaderMask`, `BackdropFilter` y `ClipRRect` con `antiAlias: true` pueden forzar al motor a renderizar un subárbol a una textura y componerlo. Esto está bien para un elemento, es caro para una lista de ellos.
3. **Imágenes sobredimensionadas**: un JPEG 4k decodificado en un `Image.asset` cubre la pantalla del teléfono con muchos más píxeles de los que ves. Usa `cacheWidth` / `cacheHeight` para reducir la resolución en la decodificación.
4. **Llamadas a `saveLayer`**: un patrón delator en el timeline del motor. `saveLayer` es lo que `Opacity` usa internamente. Reemplazar `Opacity(opacity: 0.5, child: ...)` por un `AnimatedOpacity` o un hijo que pinte ya con el alpha aplicado lo evita.

DevTools 2.40 expone esto directamente. En Performance > "Enhance Tracing", activa "Track widget builds", "Track layouts" y "Track paints" para más detalle en el timeline. Frame Analysis también ilumina un panel "Raster cache": si muestra una proporción alta de "raster cache hits / misses", el motor no está cacheando capas que podría cachear.

## Precalentamiento de shaders en Impeller y Skia

Esta es la pregunta más recurrente sobre rendimiento de Flutter: "la primera vez que abro esta pantalla, tartamudea". La causa es la compilación de shaders. La solución depende del backend de renderizado.

Impeller es el renderer moderno del motor. A partir de Flutter 3.27, Impeller está activo por defecto en iOS y es el predeterminado en Android (con Skia disponible como alternativa para dispositivos antiguos). Impeller compila todos los shaders de antemano, así que en dispositivos solo Impeller, el jank por compilación de shaders no debería existir. Si aún ves jank en el primer frame con Impeller, es decodificación de imágenes o configuración de capas, no shaders.

En la ruta de Skia (Android antiguo, web, escritorio), la compilación de shaders sigue ocurriendo en runtime. El flujo tradicional `flutter build --bundle-sksl-path` usaba el caché SkSL, pero a partir de Flutter 3.7 el motor ha desaprobado ese flujo porque Impeller lo hace innecesario. Si hoy tienes que enviar a un dispositivo Skia, la ruta recomendada es:

- Renderiza una vez cada página con efectos inusuales durante la pantalla de inicio.
- Precalienta gradientes, blurs y transiciones animadas montándolos fuera de pantalla al arrancar la app.
- Prueba en un dispositivo Android de gama baja, no en un buque insignia.

Puedes confirmar qué renderer está activo en los logs de la app en ejecución (`flutter run` imprime `Using the Impeller rendering backend`) o en la pestaña "Diagnostics" de DevTools.

## Un flujo repetible que de verdad funciona

Este es el bucle que uso, en orden:

1. `flutter run --profile -d <real-device>`. Rechaza cualquier medida de jank que venga del simulador.
2. Reproduce el jank. Activa el Performance overlay dentro de la app (`P` en la terminal) para ver las barras de UI vs raster en tiempo real. Confirma que el jank es real y reproducible.
3. Abre DevTools > Performance. Pulsa "Record" antes del jank, reprodúcelo, pulsa "Stop".
4. Haz clic en el peor frame rojo. Lee Frame Analysis. Decide UI vs raster.
5. Si es UI: abre la pestaña CPU Profiler, graba el mismo escenario, profundiza bottom-up en la función más pesada. Mueve el trabajo fuera del hilo de UI o reduce la superficie de rebuild.
6. Si es raster: activa "Track paints" y "Highlight Repaints", busca `saveLayer`, imágenes sobredimensionadas y eventos de compilación de shaders. Reemplaza, reduce o precalienta.
7. Verifica la corrección en el mismo dispositivo. Fija el presupuesto en un benchmark para que no haya regresiones.

Para el paso 7, `package:flutter_driver` está obsoleto desde Flutter 3.13 a favor de `package:integration_test` con `IntegrationTestWidgetsFlutterBinding.framework.allReportedDurations`. La [guía de pruebas de rendimiento del equipo de Flutter](https://docs.flutter.dev/cookbook/testing/integration/profiling) muestra cómo conectarlo y emitir un archivo JSON que puedes comparar en CI. Si ejecutas una matriz CI con varias versiones del SDK de Flutter, el mismo arnés encaja en [un pipeline multi-versión de Flutter](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Eventos de timeline personalizados para casos difíciles

A veces los eventos del motor no bastan y quieres ver tu propio código en el timeline. La biblioteca `dart:developer` expone una API de trazado síncrono que DevTools recoge automáticamente:

```dart
// Flutter 3.27.1, Dart 3.11
import 'dart:developer' as developer;

List<Product> parseCatalog(String json) {
  developer.Timeline.startSync('parseCatalog');
  try {
    return (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();
  } finally {
    developer.Timeline.finishSync();
  }
}
```

Ahora `parseCatalog` aparece como un span etiquetado en el timeline del hilo de UI, y Frame Analysis puede atribuirle tiempo directamente. Úsalo con moderación: cada `Timeline.startSync` tiene un coste pequeño pero no nulo, así que no envuelvas tu bucle interno caliente con uno. Úsalos en límites gruesos (un parseo, un manejador de respuesta de red, un método de controlador) donde el coste es despreciable comparado con el trabajo medido.

Para trabajo asíncrono, usa `Timeline.timeSync` para secciones síncronas dentro de funciones async, o `Timeline.startSync('name', flow: Flow.begin())` emparejado con `Flow.step` y `Flow.end` para dibujar una línea de flujo que cose eventos relacionados entre hilos. El panel Frame Analysis puede mostrar este flujo cuando se selecciona un frame.

## La presión de memoria puede parecer jank

Si ves hipos periódicos de 50 a 100 ms que aparecen en el hilo de UI pero no coinciden con ningún código en tu pila de llamadas, la causa suele ser una recolección de basura mayor. Abre la pestaña Memory y mira la línea de marcador de GC. Las recolecciones frecuentes en la generación antigua correlacionan con la asignación de muchos objetos de vida corta por frame.

Los culpables habituales son:

- Asignar nuevos objetos `TextStyle` o `Paint` dentro de `build`.
- Reconstruir listas inmutables (`List.from`, `[...spread]`) en cada frame para `ListView`.
- Usar `Future.delayed(Duration.zero, () => setState(...))` como atajo para reentradas, lo que programa una microtask cada frame.

Saca las constantes fuera de `build` (`const TextStyle(...)` a nivel de archivo es tu amigo) y prefiere listas mutables que mutas en lugar de reconstruir. La función "Profile Memory" de la pestaña Memory captura un perfil de asignación del heap que apunta a qué clase está produciendo la basura.

## Llamar a código nativo es su propio problema de profiling

Si tu app usa platform channels (un `MethodChannel`, un `EventChannel`), Dart ve esas llamadas como simples `Future`s pero el trabajo real ocurre en un hilo de plataforma. DevTools muestra la espera del lado Dart pero no puede ver dentro del manejador nativo. Si un frame tiene jank por una implementación lenta en Kotlin o Swift, tienes que adjuntar un profiler nativo (CPU Profiler de Android Studio o Xcode Instruments) al mismo proceso.

El otro detalle es que las llamadas síncronas por platform channel son ilegales en Flutter moderno (rompen con `Synchronous platform messages are not allowed`), así que cualquier bloqueo es bloqueo asíncrono en el lado Dart. Si un `MethodChannel.invokeMethod` tarda 200 ms, son 200 ms durante los cuales `await` retorna y un frame puede completarse, pero cualquier cosa encadenada al resultado caerá en un frame posterior, lo que puede parecer frames saltados. La solución es arquitecturar el canal para que la UI nunca dependa de un único round-trip para renderizar. Hay más matices en [la guía de platform channels](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Falsos positivos comunes

Un frame no es "janky" solo porque sea largo. Algunos patrones que parecen jank pero no lo son:

- El primer frame después de un hot reload. Hot reload re-resuelve widgets y deliberadamente no está optimizado. Ignora el primer frame tras cualquier reload.
- Un frame que corre mientras la app pasa a segundo plano. El sistema operativo puede pausar el renderer en mitad del frame.
- Un frame fantasma durante una recompilación en segundo plano.

Ante la duda, reproduce el jank dos veces con un `flutter run --profile` recién lanzado y solo cree lo que sea consistente entre las dos ejecuciones.

## Relacionado

- [Escribir un isolate de Dart para trabajo CPU-bound](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) cubre cómo mover parseos o cálculos pesados fuera del hilo de UI.
- [Añadir código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) profundiza en `MethodChannel` y el modelo de hilos.
- [Apuntar a varias versiones de Flutter desde un único pipeline CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) es el arnés que querrás una vez tengas un benchmark de regresión.
- [Migrar una app de Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) trata el alcance de los rebuilds, una de las mayores fuentes de jank en el hilo de UI.
- [Depurar Flutter iOS desde Windows: un flujo con dispositivo real](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) muestra cómo adjuntar DevTools a un dispositivo iOS construido en remoto cuando no puedes ejecutar Xcode localmente.

## Enlaces de referencia

- [Visión general del rendimiento de aplicaciones Flutter](https://docs.flutter.dev/perf/ui-performance) (docs.flutter.dev)
- [Vista Performance de DevTools](https://docs.flutter.dev/tools/devtools/performance) (docs.flutter.dev)
- [CPU Profiler de DevTools](https://docs.flutter.dev/tools/devtools/cpu-profiler) (docs.flutter.dev)
- [Perfilar el rendimiento de la app con pruebas de integración](https://docs.flutter.dev/cookbook/testing/integration/profiling) (docs.flutter.dev)
- [Motor de renderizado Impeller](https://docs.flutter.dev/perf/impeller) (docs.flutter.dev)
- [API Timeline de `dart:developer`](https://api.dart.dev/stable/dart-developer/Timeline-class.html) (api.dart.dev)

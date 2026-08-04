---
title: "Cómo habilitar el soporte multiventana en una app de escritorio con Flutter"
description: "Flutter 3.44.8 estable todavía no expone ninguna API multiventana pública. Aquí tienes cómo activar el feature flag experimental de windowing en el canal main, usar RegularWindowController y WindowManager para abrir ventanas de nivel superior reales, y qué usar si necesitas publicar hoy desde estable."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "desktop"
  - "multi-window"
  - "windowing"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app"
translatedBy: "claude"
translationDate: 2026-08-04
---

El soporte multiventana de Flutter existe, funciona, y no lo puedes usar desde una compilación estable. A fecha de Flutter 3.44.8 (publicado el 2026-07-23), el framework incluye una API de windowing completa en `packages/flutter/lib/src/widgets/_window.dart`, pero todas las clases están marcadas como `@internal`, el archivo no se exporta desde `package:flutter/widgets.dart`, y cada constructor lanza `UnsupportedError` a menos que el feature flag `windowing` esté activo. Ese flag solo está disponible en el canal `main`. Así que hay exactamente dos respuestas honestas: cambiar a `main`, ejecutar `flutter config --enable-windowing` y usar la API real del framework para prototipar, o quedarte en estable y usar el plugin `desktop_multi_window`, que te da ventanas separadas al costo de engines separados e isolates separados. Este post cubre ambas, con la superficie exacta de la API tal como está en 3.44.

## Por qué `runApp` solo puede darte una ventana

La razón de que una sola ventana haya sido el valor por defecto durante tanto tiempo no es pereza, es que `runApp` conecta tu árbol de widgets a la *vista implícita*: la única `FlutterView` que el embedder de la plataforma creó por ti antes de que Dart siquiera arrancara. No hay ninguna costura en esa llamada para una segunda vista, y nunca la hubo.

La vía de escape ha sido `runWidget` desde hace un tiempo, que recibe un árbol de widgets con raíz en `View` o `ViewCollection` en lugar de asumir la vista implícita. Lo que faltaba era la otra mitad: una forma de pedirle a la plataforma que *cree* una ventana nativa y te devuelva una `FlutterView` asociada a ella. Eso es lo que agrega la API de windowing. Canonical ha liderado la implementación, y Flutter 3.44 incorporó ventanas de tooltip en las tres plataformas de escritorio, ventanas popup en macOS, controladores de ventanas satélite y un `showDialog` respaldado por windowing.

La decisión de diseño que más importa para tu arquitectura: **todas las ventanas comparten un engine y un isolate**. Dos ventanas son dos subárboles del mismo árbol de widgets. Un `ValueNotifier` sostenido por un ancestro común es visible para ambas, sin serialización, sin method channel, sin `SendPort`. Esa es la mayor diferencia frente a cualquier enfoque basado en plugins, y es la razón por la que esperar a esta API suele ser la decisión correcta.

## Activar el feature flag de windowing

El flag está definido en `flutter_tools` así:

```dart
// packages/flutter_tools/lib/src/features.dart, Flutter 3.44.8
const windowingFeature = Feature(
  name: 'support for windowing on macOS, Linux, and Windows',
  configSetting: 'enable-windowing',
  environmentOverride: 'FLUTTER_WINDOWING',
  runtimeId: 'windowing',
  master: FeatureChannelSetting(available: true),
);
```

Fíjate en lo que falta: no hay entrada `beta:` ni `stable:`, así que ambas caen al valor por defecto `FeatureChannelSetting()` con `available: false`. Beta tampoco funcionará. Es `main` o nada.

Actívalo en tres pasos:

1. **Cambia al canal main.** Ejecuta `flutter channel main` seguido de `flutter upgrade`. Si necesitas conservar intacta tu cadena de herramientas estable, fija un segundo SDK con FVM en vez de mover tu único checkout; la misma técnica descrita en [ejecutar un proyecto contra varios SDK de Flutter en CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) funciona igual de bien en local.
2. **Enciende el flag.** Ejecuta `flutter config --enable-windowing`. Esto escribe una configuración persistente, así que solo lo haces una vez por SDK. Para CI, define en su lugar la variable de entorno `FLUTTER_WINDOWING=true`, que la herramienta lee como override.
3. **Recompila, no hagas hot restart.** La herramienta pasa los flags activos al framework como una constante de compilación llamada `FLUTTER_ENABLED_FEATURE_FLAGS`. El framework la lee en `packages/flutter/lib/src/foundation/_features.dart`:

```dart
// packages/flutter/lib/src/foundation/_features.dart, Flutter 3.44.8
final Set<String> debugEnabledFeatureFlags = <String>{
  ...const String.fromEnvironment('FLUTTER_ENABLED_FEATURE_FLAGS').split(','),
};

bool isWindowingEnabled = debugEnabledFeatureFlags.contains('windowing');
```

`String.fromEnvironment` se evalúa como constante en tiempo de compilación, así que un hot restart después de cambiar la configuración no lo recogerá. Cierra la app y vuelve a ejecutar `flutter run -d windows` (o `macos`, o `linux`).

Si te saltas el paso 2 obtienes un error muy concreto que vale la pena reconocer, porque se lanza desde el constructor y no en tiempo de renderizado:

```
Windowing APIs are not enabled.

Windowing APIs are currently experimental. Do not use windowing APIs in
production applications or plugins published to pub.dev.

To try experimental windowing APIs:
1. Switch to Flutter's main release channel.
2. Turn on the windowing feature flag.
```

## Importar una API que no está exportada

Como `_window.dart` es una biblioteca privada dentro de `package:flutter`, no puedes alcanzarla a través de `package:flutter/widgets.dart`. Importas el archivo de implementación directamente y silencias dos reglas del analizador. Esto es exactamente lo que hace la app `examples/multiple_windows` del propio Flutter:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member
// ignore_for_file: implementation_imports

import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';
```

Sí, es feo, y sí, es la forma oficialmente sancionada de probar la característica ahora mismo. La regla `implementation_imports` existe para impedir que hagas esto en un paquete publicado, que es precisamente la recomendación en la cabecera del archivo: no lo importes en apps de producción ni en nada que subas a pub.dev, porque llegarán cambios que rompen compatibilidad en versiones de parche.

## Una app mínima de dos ventanas

El programa completo más pequeño: crea un `RegularWindowController`, envuélvelo en un `RegularWindow` y pasa todo eso a `runWidget` en lugar de `runApp`.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member, implementation_imports
import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final RegularWindowController controller = RegularWindowController(
    preferredSize: const Size(900, 640),
    preferredConstraints: const BoxConstraints(minWidth: 640, minHeight: 480),
    title: 'Main window',
  );

  runWidget(
    WindowManager(
      child: RegularWindow(
        controller: controller,
        child: const MaterialApp(home: HomePage()),
      ),
    ),
  );
}
```

Aquí hay tres cosas que sostienen todo el peso.

`WidgetsFlutterBinding.ensureInitialized()` tiene que ir primero. La factory de `RegularWindowController` resuelve `WidgetsBinding.instance.windowingOwner` de inmediato, y el `WindowingOwner` de la plataforma verifica que el engine ya esté inicializado. Construir un controlador antes de que exista el binding es la causa del assert `WindowingOwner[Platform] must be created after the engine has been initialized` registrado en flutter/flutter#178706.

El controlador crea la ventana nativa en su constructor, no cuando el widget se monta. `RegularWindow` solo renderiza dentro de una ventana que ya existe, y por eso la documentación es explícita en que tú eres el dueño del ciclo de vida y debes llamar a `destroy()` tú mismo.

`WindowManager` es opcional para una sola ventana, pero lo quieres desde el principio. Instala un `WindowRegistry` en el árbol, que es como los descendientes abren más ventanas sin pasar un controlador a mano hacia abajo.

## Abrir una segunda ventana en tiempo de ejecución

El patrón es: construye un controlador, envuélvelo en un `WindowEntry` con un builder para su contenido, y regístralo. `WindowManager` escucha al registro y renderiza cada entrada con el widget correcto según el tipo de su controlador.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final WindowRegistry registry = WindowRegistry.of(context);

    return Scaffold(
      body: Center(
        child: FilledButton(
          onPressed: () {
            late final WindowEntry entry;
            final RegularWindowController controller = RegularWindowController(
              title: 'Inspector',
              preferredSize: const Size(480, 720),
              delegate: _UnregisterOnDestroy(
                onDestroyed: () => registry.unregister(entry),
              ),
            );
            entry = WindowEntry(
              controller: controller,
              builder: (BuildContext context) => const InspectorPane(),
            );
            registry.register(entry);
          },
          child: const Text('Open inspector'),
        ),
      ),
    );
  }
}

class _UnregisterOnDestroy with RegularWindowControllerDelegate {
  _UnregisterOnDestroy({required this.onDestroyed});

  final VoidCallback onDestroyed;

  @override
  void onWindowDestroyed() {
    super.onWindowDestroyed();
    onDestroyed();
  }
}
```

El baile del `late final WindowEntry entry` no es accidental: el delegado necesita desregistrar la entrada, y la entrada necesita el controlador al que está atado el delegado. La app de referencia del propio Flutter usa la misma referencia adelantada.

Desregistrar importa. `WindowRegistry.unregister` solo quita la entrada de la lista para que `WindowManager` deje de renderizarla; no destruye la ventana. A la inversa, `destroy()` derriba la ventana nativa pero deja una entrada obsoleta en el registro. El delegado es el punto de unión: deja que el `onWindowCloseRequested` por defecto destruya la ventana, y luego limpia el registro en `onWindowDestroyed`.

## Interceptar el cierre y el resto de la superficie del controlador

`RegularWindowControllerDelegate` tiene exactamente dos hooks, y la implementación por defecto del primero es lo que realmente cierra tus ventanas:

```dart
// packages/flutter/lib/src/widgets/_window.dart, Flutter 3.44.8
void onWindowCloseRequested(RegularWindowController controller) {
  controller.destroy();
}

void onWindowDestroyed() { }
```

Sobrescribe `onWindowCloseRequested` y *no* llames a `super` cuando quieras un aviso de "cambios sin guardar"; después llama tú mismo a `controller.destroy()` cuando el usuario confirme. Olvidar que `super` es lo que cierra la ventana es la forma más probable de publicar una ventana que nadie puede cerrar.

El controlador expone el estado que esperarías, y todo notifica cambios porque `BaseWindowController` extiende `ChangeNotifier`: `contentSize`, `title`, `isActivated`, `isMaximized`, `isMinimized`, `isFullscreen` y `rootView`. Los mutadores son `setSize`, `setConstraints`, `setTitle`, `setMaximized`, `setMinimized`, `setFullscreen(bool fullscreen, {Display? display})`, `activate` y `destroy`. Cada uno está documentado como una *solicitud*: la plataforma es libre de ignorarla, así que dirige tu interfaz según el estado notificado, nunca según lo que pediste.

Dentro del subárbol de una ventana, alcanza el controlador a través del inherited model `WindowScope`:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
final BaseWindowController window = WindowScope.of(context);

// Rebuilds only on size changes, not on title or activation changes.
final Size size = WindowScope.contentSizeOf(context);
```

`WindowScope` es un `InheritedModel` con aspectos como clave (tamaño de contenido, título, activada, maximizada, minimizada, pantalla completa), así que `contentSizeOf` no reconstruirá tu widget cuando la ventana simplemente reciba el foco. Usa `maybeOf` si el subárbol también puede ejecutarse en la ventana implícita: las ventanas creadas por el punto de entrada nativo al que se conecta `runApp` no tienen `WindowScope`, y `of` lanza una excepción ahí.

## Los otros cuatro tipos de ventana

Las ventanas regulares son uno de cinco tipos de controlador, todos sellados bajo `BaseWindowController` y todos renderizados por `WindowManager` mediante un switch:

- `DialogWindowController({BaseWindowController? parent, ...})`. Con un `parent` no nulo el diálogo es modal respecto a él, no tiene menú de sistema, se oculta del conmutador de ventanas y se cierra cuando el padre se cierra. Con `parent: null` es no modal, se puede minimizar pero no maximizar, y obtiene un **botón de cierre deshabilitado**. Ese último detalle sorprende a la gente; si quieres una ventana independiente que se pueda cerrar, lo que quieres es una ventana regular, no un diálogo sin padre.
- `PopupWindowController`, posicionado en relación a un rectángulo ancla. Implementado para macOS en 3.44; Windows y Linux todavía están llegando.
- `TooltipWindowController`, implementado en las tres plataformas de escritorio en 3.44.
- `SatelliteWindowController`, el más nuevo del conjunto, para paletas y barras de herramientas que siguen a una ventana padre.

Flutter 3.44 también agregó un `showDialog` respaldado por windowing que abre una ventana nativa real en lugar de un overlay, detrás de un flag `useWindowing` en `MaterialApp`.

## Qué hacer si necesitas esto en estable

Si vas a publicar ahora, la API del framework queda descartada: implementation imports más `@internal` más cambios que rompen compatibilidad documentados en versiones de parche no es una base para una app de producción. La respuesta práctica sigue siendo `desktop_multi_window` 0.3.0 (publicado el 2025-10-28), que soporta Windows, Linux y macOS.

```dart
// desktop_multi_window 0.3.0, Flutter 3.44.8 stable
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  final windowController = await WindowController.fromCurrentEngine();
  final arguments = parseArguments(windowController.arguments);

  switch (arguments.type) {
    case WindowType.main:
      runApp(const MainWindow());
    case WindowType.inspector:
      runApp(const InspectorWindow());
  }
}
```

Las ventanas nuevas vienen de `WindowController.create(WindowConfiguration(...))`, y la comunicación entre ventanas pasa por `WindowMethodChannel`, que es un method channel y por lo tanto asíncrono y sujeto a un códec:

```dart
// desktop_multi_window 0.3.0
const channel = WindowMethodChannel('inspector');
channel.setMethodCallHandler((call) async {
  return switch (call.method) {
    'refresh' => 'ok',
    _ => throw MissingPluginException('Not implemented: ${call.method}'),
  };
});
```

El costo arquitectónico es lo que hay que planificar. Cada ventana es su propio engine de Flutter, lo que significa su propio isolate, su propio heap y su propia copia de cada singleton que inicializaste en `main`. El estado compartido tiene que serializarse a través de un canal, exactamente igual que al hablar con [código específico de plataforma sobre un MethodChannel](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Si alguna vez estructuraste una app en torno a [un isolate de Dart de larga vida con SendPort y ReceivePort](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), las restricciones te resultarán familiares: nada de objetos mutables compartidos, todo por mensajes.

Diséñalo así ahora y la migración eventual sale barata. Mantén un único dueño del estado de la aplicación, exponlo a través de una interfaz, y deja que el transporte (referencia directa hoy bajo la API del framework, method channel hoy bajo el plugin) quede detrás de esa interfaz. Este es el mismo argumento de "arquitectura primero, pulido después" que [las apps de escritorio con Flutter siguen demostrando](/es/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/).

## Trampas que cuestan tiempo real

**Los controladores son `ChangeNotifier` y tú eres responsable de liberarlos.** Un `RegularWindowController` guardado en un `State` necesita `controller.dispose()` en `dispose()`, además de `destroy()` para la ventana nativa. La misma disciplina que ya aplicas a [`AnimationController` y compañía](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) aplica aquí, con un recurso nativo extra adjunto.

**Los widget tests no tienen windowing.** No hay `WindowingOwner` en el binding de pruebas, así que cualquier test que llegue a un constructor de windowing lanza `UnsupportedError`. El propio ejemplo de la API de Flutter envuelve `main` en un bloque `try`/`on UnsupportedError` precisamente para que los smoke tests pasen. Mantén la creación de ventanas fuera del código a nivel de widget y detrás de una costura que puedas sustituir.

**`preferredSize` y `preferredConstraints` deben ser coherentes.** La factory verifica `preferredConstraints.isSatisfiedBy(preferredSize)` cuando ambos son no nulos. En compilaciones de release el assert desaparece y la plataforma elige otra cosa en silencio.

**`decorated: false` significa que tú dibujas el marco.** Las ventanas sin decoración llegaron en 3.44 (`Allow windows to be created undecorated`). No obtienes barra de título, ni borde, ni región arrastrable hasta que los construyas.

El issue de seguimiento de todo el esfuerzo es flutter/flutter#30701, y el trabajo restante antes de que la API se haga pública es lo bastante pequeño como para ser alentador: flutter/flutter#177586, la lista de verificación previa al lanzamiento, se reduce a quitar TODOs de fragmentos de documentación y eliminar los ignores de `invalid_use_of_internal_member` de los ejemplos. Nada en ella es arquitectónico. Compila contra la forma de esta API, mantenla detrás de una interfaz, y el día que llegue a estable tu migración será un cambio de import.

## Relacionados

- [Cómo agregar código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Cómo escribir un isolate de Dart para trabajo intensivo de CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Cómo liberar controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [TypeMonkey es un buen recordatorio: las apps de escritorio con Flutter necesitan arquitectura primero y pulido después](/es/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/)

## Fuentes

- [flutter/flutter#30701, el issue de seguimiento de multiventana](https://github.com/flutter/flutter/issues/30701)
- [flutter/flutter#177586, la lista de verificación previa al lanzamiento de multiventana](https://github.com/flutter/flutter/issues/177586)
- [`packages/flutter/lib/src/widgets/_window.dart` en el tag 3.44.0](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter/lib/src/widgets/_window.dart)
- [`packages/flutter_tools/lib/src/features.dart`, donde se declara `windowingFeature`](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter_tools/lib/src/features.dart)
- [La app de referencia `examples/multiple_windows` de Flutter](https://github.com/flutter/flutter/tree/3.44.0/examples/multiple_windows)
- [Notas de la versión Flutter 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)
- [Canonical sobre traer múltiples ventanas a Flutter desktop](https://canonical.com/blog/multiple-window-flutter-desktop)
- [`desktop_multi_window` en pub.dev](https://pub.dev/packages/desktop_multi_window)

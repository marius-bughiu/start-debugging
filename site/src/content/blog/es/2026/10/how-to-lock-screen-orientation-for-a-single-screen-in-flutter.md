---
title: "Cómo bloquear la orientación de una sola pantalla en Flutter (y por qué el multitarea del iPad la ignora)"
description: "Bloquea una ruta de Flutter en horizontal o vertical con SystemChrome.setPreferredOrientations sin romper el resto de la app: un bloqueo basado en pila que sobrevive a pushReplacement y se restaura al hacer pop, por qué la lista vacía es el reinicio equivocado, por qué el multitarea del iPad y las pantallas grandes de Android 16 ignoran el bloqueo, y qué significa UIRequiresFullScreen después de iPadOS 26 y el SDK de iOS 27. Probado en Flutter 3.47.8 con Dart 3.13.7 y Xcode 27.1."
pubDate: 2026-10-25
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ios"
  - "android"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-lock-screen-orientation-for-a-single-screen-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-25
---

Para bloquear una sola pantalla en Flutter, llama a `SystemChrome.setPreferredOrientations` cuando aparece la ruta y luego devuelve las orientaciones normales de la app cuando la ruta se va. No escribas la versión ingenua, en la que `initState` fija horizontal y `dispose` restablece vertical. En una prueba de widgets con Flutter 3.47.8 (Dart 3.13.7), esa versión restaura vertical solo cuando termina la animación del pop. Peor aún, `pushReplacement` entre dos pantallas bloqueadas deja la nueva pantalla en vertical. Usa el pequeño bloqueo basado en pila que aparece abajo y restaura en `PopScope.onPopInvokedWithResult`. Aun así, el bloqueo es una solicitud, no una garantía. iPadOS lo ignora mientras la app pueda hacer multitarea (Split View, Slide Over y el sistema de ventanas de iPadOS 26). Android 16 lo ignora en pantallas de al menos 600 dp de ancho una vez que apuntas a la API 36, y Flutter 3.47.8 apunta a la API 36 por defecto. La antigua salida de emergencia en iPad, `UIRequiresFullScreen`, está obsoleta desde iPadOS 26 y ya no evita el redimensionado cuando compilas con el SDK de iOS 27.

## Qué hace realmente setPreferredOrientations en cada plataforma

`SystemChrome.setPreferredOrientations(List<DeviceOrientation>)` es una única llamada por canal de plataforma, `SystemChrome.setPreferredOrientations`, que transporta una lista de nombres de enum. Mantiene un estado global de la app. Nada de esto está limitado a un widget o a una ruta. Lo último que establezcas sigue vigente hasta que algo lo establezca de nuevo. Eso incluye un reinicio en caliente, porque la preferencia vive en el view controller o la activity nativos, no en Dart.

Las plataformas lo manejan de forma distinta, y las diferencias importan en cuanto intentas "deshacer" un bloqueo:

- **Android**: el `PlatformChannel.decodeOrientations` del motor convierte la lista en una máscara de bits, la asigna a una constante `ActivityInfo.SCREEN_ORIENTATION_*` y llama a `activity.setRequestedOrientation(...)`. `[portraitUp]` pasa a ser `SCREEN_ORIENTATION_PORTRAIT`, `[landscapeLeft, landscapeRight]` pasa a ser `SCREEN_ORIENTATION_USER_LANDSCAPE`, y la lista vacía pasa a ser `SCREEN_ORIENTATION_UNSPECIFIED`. Una solicitud en tiempo de ejecución sustituye el atributo `android:screenOrientation` de tu manifiesto. Así que si el manifiesto dice `portrait` y "restableces" con `[]`, la activity puede rotar libremente a partir de ese momento.
- **iOS**: `FlutterPlatformPlugin` construye un `UIInterfaceOrientationMask` y publica una notificación. Cada `FlutterViewController` guarda la máscara y la devuelve desde `supportedInterfaceOrientations`. En iOS 16 y posteriores llama a `requestGeometryUpdateWithPreferences:` en cada `UIWindowScene` conectada y luego a `setNeedsUpdateOfSupportedInterfaceOrientations`. La lista vacía pasa a ser `UIInterfaceOrientationMaskAll`, que UIKit luego intersecta con las orientaciones de `Info.plist`. Una solicitud de geometría fallida solo se registra ("Failed to change device orientation"). El future de Dart se completa con normalidad.

De ahí se desprenden dos consecuencias. Primero, `[]` significa "lo que permita el sistema operativo", no "el valor por defecto de la app". Restaura siempre a una lista explícita. Segundo, la llamada es de tipo "dispara y olvida". Esperar el future te dice que el mensaje se entregó, no que la pantalla rotó.

## El bloqueo ingenuo por pantalla y cómo se rompe

Esta es la versión que sugieren la mayoría de las respuestas:

```dart
// Flutter 3.47.8, Dart 3.13.7 -- naive, do not ship
class _VideoPageState extends State<VideoPage> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }
}
```

La ejecuté en una prueba de widgets que intercepta `SystemChannels.platform` y registra cada llamada de orientación entre eventos de navegación. Este es el registro en Flutter 3.47.8:

```text
naive push/pop: [landscapeLeft,landscapeRight] -- pop -- first frame of pop animation [portraitUp] -- pop animation done
naive replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [portraitUp]  => final [portraitUp]
```

La primera línea muestra el error de temporización. `dispose` se ejecuta solo después de que termina la transición de salida de la ruta, así que la pantalla anterior vuelve deslizándose mientras el dispositivo sigue bloqueado en horizontal, y luego salta a vertical. En un teléfono real, el usuario ve cómo la pantalla anterior entra con un diseño horizontal durante toda la transición del pop, y solo después rota.

La segunda línea es el error de corrección. Con `pushReplacement` (o `replace` / `go` de `go_router` hacia una ruta hermana), el `initState` de la nueva ruta se ejecuta antes que el `dispose` de la ruta anterior. La página de video entrante pide horizontal. Luego la página de video saliente "limpia" y fuerza vertical. El estado final es vertical en una pantalla que quería horizontal. Lo mismo ocurre siempre que dos pantallas bloqueadas se solapan en su ciclo de vida, por ejemplo en un `TabBarView` o un `PageView` que mantiene vivas a las vecinas.

## Un bloqueo con dueño, apilado y liberado al hacer pop

La solución es dejar de tratar la orientación como algo que cada pantalla establece y restablece. En su lugar, mantén una única pila de solicitudes para toda la app. Cada pantalla agrega su propia entrada y elimina solo esa entrada, y lo que se envía a la plataforma es la cima de la pila (o el valor por defecto de la app):

```dart
// Flutter 3.47.8, Dart 3.13.7
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// App-wide orientation stack. The top entry wins; when it is empty the
/// app default applies.
class OrientationLocks {
  OrientationLocks._();

  static List<DeviceOrientation> appDefault = const [DeviceOrientation.portraitUp];
  static final List<(Object, List<DeviceOrientation>)> _stack = [];

  static void push(Object owner, List<DeviceOrientation> orientations) {
    _stack.removeWhere((e) => identical(e.$1, owner));
    _stack.add((owner, orientations));
    _apply();
  }

  static void remove(Object owner) {
    final before = _stack.length;
    _stack.removeWhere((e) => identical(e.$1, owner));
    if (_stack.length != before) _apply();
  }

  static void _apply() {
    final target = _stack.isEmpty ? appDefault : _stack.last.$2;
    SystemChrome.setPreferredOrientations(target);
  }
}
```

El widget que lo usa agrega su bloqueo cuando su ruta pasa a ser la actual. Lo libera en dos lugares: cuando empieza un pop (a través de `PopScope`) y en `dispose` como respaldo para las rutas que se eliminan sin un pop, como la ruta anterior en un `pushReplacement`:

```dart
// Flutter 3.47.8, Dart 3.13.7
/// Locks orientation while this widget's route is the current route.
class OrientationLock extends StatefulWidget {
  const OrientationLock({
    super.key,
    required this.orientations,
    required this.child,
  });

  final List<DeviceOrientation> orientations;
  final Widget child;

  @override
  State<OrientationLock> createState() => _OrientationLockState();
}

class _OrientationLockState extends State<OrientationLock> {
  ModalRoute<Object?>? _route;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != _route) {
      _route = route;
      // isCurrent is false while another route covers this one.
      if (route == null || route.isCurrent) {
        OrientationLocks.push(this, widget.orientations);
      }
    }
  }

  @override
  void didUpdateWidget(OrientationLock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.orientations, widget.orientations)) {
      OrientationLocks.push(this, widget.orientations);
    }
  }

  @override
  void dispose() {
    OrientationLocks.remove(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      onPopInvokedWithResult: (didPop, result) {
        // Release the lock when the pop starts, not when the exit
        // animation ends, so the previous screen does not animate in
        // under the wrong orientation.
        if (didPop) OrientationLocks.remove(this);
      },
      child: widget.child,
    );
  }
}
```

Usarlo en una ruta es un solo wrapper:

```dart
// Flutter 3.47.8, Dart 3.13.7
Navigator.of(context).push(MaterialPageRoute<void>(
  builder: (_) => const OrientationLock(
    orientations: [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
    child: VideoPage(),
  ),
));
```

El mismo arnés de pruebas, ejecutado contra esta versión:

```text
stack push/pop: [landscapeLeft,landscapeRight] -- pop [portraitUp] -- first frame of pop animation -- pop animation done
stack replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [landscapeLeft,landscapeRight]  => final [landscapeLeft,landscapeRight]
```

Vertical se solicita en el mismo fotograma en que empieza el pop, así que la rotación y la transición inversa se ejecutan juntas. Tras el reemplazo, el video se queda en horizontal, porque al eliminar la entrada de la página saliente se vuelve a aplicar la entrada de la página entrante en lugar de la predeterminada.

Aquí hay una decisión de diseño incorporada. Una ruta sin su propio `OrientationLock` hereda el bloqueo más cercano por debajo de ella en la pila. Si un reproductor horizontal abre una hoja de ajustes simple, la hoja también queda en horizontal. Si quieres que "todo lo que no tenga bloqueo sea vertical", envuelve esas rutas con un `OrientationLock(orientations: [DeviceOrientation.portraitUp])` explícito. Con `go_router`, coloca el wrapper en el `builder` o el `pageBuilder` de la ruta. `ModalRoute.of` y `PopScope` funcionan igual dentro del navegador anidado de un `ShellRoute`, que el artículo sobre [rutas anidadas y enlaces profundos con go_router](/es/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) recorre paso a paso.

## Define el valor por defecto de la app en el proyecto nativo, no solo en Dart

Si toda la app es vertical excepto una pantalla, declara también vertical de forma nativa, para que la pantalla de inicio y el primer fotograma ya sean correctos:

1. En `android/app/src/main/AndroidManifest.xml`, agrega `android:screenOrientation="portrait"` al elemento `MainActivity`.
2. En `ios/Runner/Info.plist`, mantén `UISupportedInterfaceOrientations` (iPhone) y `UISupportedInterfaceOrientations~ipad` con todas las orientaciones que cualquier pantalla vaya a necesitar. Flutter solo puede restringir lo que permite `Info.plist`. No puede agregar nada. La plantilla de 3.47.8 incluye vertical y ambas horizontales para iPhone, y las cuatro orientaciones para iPad.
3. En `main`, define `OrientationLocks.appDefault` y aplícalo antes de `runApp`:

```dart
// Flutter 3.47.8, Dart 3.13.7
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  OrientationLocks.appDefault = const [DeviceOrientation.portraitUp];
  await SystemChrome.setPreferredOrientations(OrientationLocks.appDefault);
  runApp(const MyApp());
}
```

No restrinjas el `Info.plist` del iPhone solo a vertical para luego pedir horizontal desde Dart. En iOS 16+ la solicitud de geometría falla porque la escena no admite ninguna de las orientaciones solicitadas. Falla en silencio, salvo por una línea de registro en Xcode.

## Por qué el multitarea del iPad ignora el bloqueo

El comentario de documentación de `setPreferredOrientations` en Flutter 3.47.8 lo dice claramente: "This setting will only be respected on iPad if multitasking is disabled." La razón es UIKit, no Flutter. Cuando una app puede compartir la pantalla (Split View, Slide Over, Stage Manager y las ventanas redimensionables libremente que llegaron con iPadOS 26), el tamaño y la orientación de la escena pertenecen al sistema. El usuario puede rotar el iPad con tu app en un diseño lado a lado. El sistema no rotará toda la pantalla por una sola app, así que `supportedInterfaceOrientations` deja de respetarse. Flutter sigue enviando la solicitud, y UIKit simplemente no actúa sobre ella.

Durante años, la solución documentada, y la que la documentación de Flutter aún menciona, fue excluirse del multitarea. Se hacía marcando "Requires full screen" en Xcode, lo que escribe `UIRequiresFullScreen = YES` en `Info.plist`. Eso ya no es una respuesta a largo plazo. La [TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key) de Apple dice:

- A partir de iPadOS 26, `UIRequiresFullScreen` y su modo de compatibilidad están obsoletos y se ignorarán en una versión futura.
- A partir de iOS 27 e iPadOS 27, las apps compiladas con el SDK de iOS 27 que definen la clave se redimensionan de forma discreta en lugar de mantenerse a pantalla completa. La única excepción es cuando `UIRequiresFullScreenIgnoredStartingWithVersion` indica la versión 27 o anterior.
- Para admitir escenas redimensionables, una app debe admitir todas las orientaciones de interfaz.

Xcode 27.1 incluye el SDK de iOS 27. Así que, en una app de Flutter que compiles hoy, marcar "Requires full screen" ya no excluye a la app del redimensionado en iOS 27, y Apple ha pedido a los desarrolladores que dejen de depender de ello. Los hilos del foro de desarrolladores del ciclo de iPadOS 26.x también reportan apps solo horizontales que aparecen en vertical cuando el bloqueo de rotación del dispositivo está desactivado. Trata cualquier bloqueo de orientación en iPad como de mejor esfuerzo.

Lo que Apple ofrece en su lugar es un bloqueo *temporal*. Un view controller puede sobrescribir `prefersInterfaceOrientationLocked` y llamar a `setNeedsUpdateOfPrefersInterfaceOrientationLocked()`. Eso le pide al sistema que mantenga la orientación actual de la escena mientras ese controlador esté visible, por ejemplo durante una captura con la cámara o un gesto de dirección en un juego. La TN3192 es explícita en que el sistema "does not guarantee" que respetará la preferencia. El `FlutterViewController` de Flutter 3.47.8 no sobrescribe esta propiedad. Puedes hacerlo en una subclase y controlarlo mediante un method channel:

```swift
// Flutter 3.47.8, Xcode 27.1, iOS 26+ for prefersInterfaceOrientationLocked
import Flutter
import UIKit

class LockableFlutterViewController: FlutterViewController {
  private var locked = false
  private var channel: FlutterMethodChannel?

  override func viewDidLoad() {
    super.viewDidLoad()
    channel = FlutterMethodChannel(
      name: "app/orientation_lock", binaryMessenger: engine.binaryMessenger)
    channel?.setMethodCallHandler { [weak self] call, result in
      guard let self, call.method == "setLocked", let value = call.arguments as? Bool else {
        result(FlutterMethodNotImplemented)
        return
      }
      self.locked = value
      if #available(iOS 26.0, *) {
        self.setNeedsUpdateOfPrefersInterfaceOrientationLocked()
      }
      result(nil)
    }
  }

  override var prefersInterfaceOrientationLocked: Bool {
    locked
  }
}
```

En `ios/Runner/Base.lproj/Main.storyboard`, cambia el `customClass` del view controller raíz de `FlutterViewController` a `LockableFlutterViewController` (con `customModuleProvider="target"`). Luego llámalo desde Dart:

```dart
// Flutter 3.47.8, Dart 3.13.7
const _lockChannel = MethodChannel('app/orientation_lock');

Future<void> setIpadOrientationLocked(bool locked) =>
    _lockChannel.invokeMethod<void>('setLocked', locked);
```

Esto conserva la orientación que la escena ya tiene. No rota a horizontal, así que complementa a `setPreferredOrientations` y no lo reemplaza. Compilé esta subclase dentro de una app de Flutter 3.47.8 con `flutter build ios --simulator` en Xcode 27.1 (destino de implementación iOS 15, de ahí la comprobación `#available`). No probé el comportamiento del multitarea en un iPad físico, así que verifícalo en hardware antes de depender de él.

## Android 16 hace lo mismo en pantallas grandes

Android siguió el mismo camino. Según los [cambios de comportamiento de Android 16](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation), las apps que apuntan a la API 36 ignoran `screenOrientation`, `resizableActivity`, `minAspectRatio`, `maxAspectRatio`, `setRequestedOrientation()` y `getRequestedOrientation()` en pantallas cuyo ancho más pequeño es de al menos 600 dp. Eso abarca tabletas, plegables desplegados y ventanas de escritorio. `setPreferredOrientations` de Flutter es una llamada a `setRequestedOrientation()`, y el plugin de Gradle de Flutter 3.47.8 establece `flutter.targetSdkVersion` en 36. Por lo tanto, una app de Flutter recién creada no bloqueará la orientación en una tableta. La documentación de Flutter ya incluye esta limitación.

Las excepciones son los juegos (declarados con `android:appCategory="game"`), los usuarios que eligen el comportamiento predeterminado de la app en los ajustes de relación de aspecto del dispositivo, y las pantallas de menos de 600 dp. Los teléfonos no se ven afectados. Existe una exclusión temporal:

```xml
<!-- android/app/src/main/AndroidManifest.xml, targetSdk 36 only -->
<activity android:name=".MainActivity" ...>
    <property
        android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
        android:value="true" />
</activity>
```

Google indica que la exclusión deja de aplicarse una vez que apuntas al nivel de API 37. Tómala como tiempo para arreglar el diseño de tu tableta, no como una solución. La misma regla afectó a las apps MAUI, y el artículo sobre la [migración de MAUI al nivel de API 36](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) cubre con más detalle la parte del manifiesto.

## Detalles a tener en cuenta cuando la pantalla sí rota

- **Diseña a partir de las restricciones, no del bloqueo.** La rotación llega un fotograma o más después de tu llamada, y en iPad o en tabletas con Android 16 puede que nunca llegue. Construye la pantalla bloqueada con `OrientationBuilder` o `LayoutBuilder` para que se muestre correctamente con el tamaño que realmente reciba.
- **Usa la pantalla (display), no `MediaQuery.size`, para decidir si bloquear.** En Android, el letterboxing hace que `MediaQueryData.size` reporte el área con letterbox. La documentación de Flutter recomienda `View.of(context).display.size / display.devicePixelRatio` contra un punto de corte de 600 píxeles lógicos. Bloquea solo en teléfonos y envía `[]` en tabletas.
- **`landscapeLeft` significa que el dispositivo está girado en sentido antihorario.** `DeviceOrientation.landscapeLeft` es "90 degrees counterclockwise from portraitUp". Solicita ambas orientaciones horizontales a menos que tengas un motivo para fijar una sola. De lo contrario, un usuario que giró el teléfono hacia el otro lado verá la pantalla al revés.
- **Los iPhone sin botón de inicio nunca reciben `portraitDown`.** La TN3192 señala que el sistema elimina `portraitUpsideDown` del conjunto admitido en esos modelos, sin importar lo que declares.
- **Al volver del segundo plano.** La preferencia nativa sobrevive al paso a segundo plano, así que no necesitas volver a aplicarla al reanudar. Si tienes otro código de ciclo de vida, la [migración a AppLifecycleListener](/es/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/) es un lugar más limpio para él que un `WidgetsBindingObserver`.
- **No lo llames después de un `await` sin comprobar `mounted`.** Bloquear tras una carga de video asíncrona es común. Si el usuario ya hizo pop de la ruta, un `OrientationLocks.push` tardío desde un `State` muerto deja un bloqueo que nada elimina. Las reglas de [usar BuildContext de forma segura después de un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) también se aplican aquí.

## Lecturas relacionadas

- [Rutas anidadas y enlaces profundos con go_router](/es/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/), para saber dónde colocar el wrapper `OrientationLock` en un árbol de rutas.
- [go_router vs auto_route vs Navigator 2.0](/es/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/), si estás eligiendo un enrutador y te importa cómo se eliminan las rutas de reemplazo.
- [Migrar de WidgetsBindingObserver a AppLifecycleListener](/es/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/).
- [Migrar una app Android de .NET MAUI para apuntar al nivel de API 36](/es/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/), para la misma regla de pantallas grandes de Android 16 desde el lado de MAUI.

## Fuentes

- [`SystemChrome.setPreferredOrientations` API docs](https://api.flutter.dev/flutter/services/SystemChrome/setPreferredOrientations.html) y el [código fuente de 3.47.8](https://github.com/flutter/flutter/blob/3.47.8/packages/flutter/lib/src/services/system_chrome.dart).
- Motor de Flutter en 3.47.8: [`FlutterViewController.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterViewController.mm), [`FlutterPlatformPlugin.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterPlatformPlugin.mm), [`PlatformChannel.java`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/systemchannels/PlatformChannel.java).
- [TN3192: Migrating your app from the deprecated UIRequiresFullScreen key](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key).
- [Android 16 behavior changes: ignore orientation, resizability, and aspect ratio restrictions](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation).
- Apple Developer Forums: [iPadOS 26.x ignores supportedInterfaceOrientations when orientation lock is off](https://developer.apple.com/forums/thread/811216).

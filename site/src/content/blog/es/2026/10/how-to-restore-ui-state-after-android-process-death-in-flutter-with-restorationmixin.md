---
title: "Cómo restaurar el estado de la interfaz tras la muerte del proceso en Android con Flutter y RestorationMixin"
description: "Android mata las apps de Flutter en segundo plano para recuperar memoria, y cuando el usuario regresa cada StatefulWidget empieza desde cero. Así se activa la restauración con restorationScopeId, RestorationMixin y las propiedades Restorable, cómo restaurar campos de texto, posiciones de scroll y rutas, cómo escribir un RestorableValue personalizado y cómo probarlo todo con restartAndRestore y adb, verificado en Flutter 3.44.8 y un emulador de Android 16."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "android"
  - "state-restoration"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Respuesta corta:** define `restorationScopeId: 'app'` en tu `MaterialApp`, añade `RestorationMixin` a cada `State` que guarde algo que el usuario odiaría perder, almacena esos datos en `RestorableInt`, `RestorableTextEditingController`, `RestorableEnum` y similares en lugar de campos normales, registra cada uno en `restoreState` y abre las pantallas con `Navigator.restorablePush` en lugar de `Navigator.push`. Flutter serializa entonces esos valores en el `Bundle` de estado de instancia guardado de Android, y cuando Android recrea la actividad en un proceso nuevo, el framework los devuelve antes del primer fotograma. Todo lo que sigue se verificó en Flutter 3.44.8 (Dart 3.12.2) con pruebas de widgets y con muertes de proceso reales en un emulador de Android 16 (API 36); `restoration.dart` no ha cambiado en la rama `stable` desde julio de 2025.

El resto de este artículo explica qué es realmente la muerte del proceso y por qué tu estado desaparece, construye un pequeño formulario de pedido que la sobrevive, cubre rutas y posiciones de scroll, muestra cómo escribir un `RestorableValue` para tu propia clase y enumera los problemas que encontré al probar, incluido uno en el que `restorablePush` falla hasta que mueves el constructor de la ruta a una función de nivel superior.

## Qué es la muerte del proceso y por qué el estado de Flutter no la sobrevive

Cuando el usuario cambia a otra app, Android detiene la actividad pero mantiene el proceso. Si la memoria escasea, el sistema mata ese proceso en segundo plano. No avisa al usuario: la app sigue apareciendo en Recientes con su última captura de pantalla. Cuando el usuario la toca, Android inicia un proceso nuevo, crea un nuevo `FlutterActivity` y le entrega el `Bundle` que la actividad anterior escribió en `onSaveInstanceState`.

Una app de Flutter mantiene todo su estado de interfaz en objetos de Dart en el heap de ese proceso muerto. Un proceso nuevo significa un isolate de Dart nuevo, un `main()` nuevo y objetos `State` nuevos. A menos que algo haya escrito tus contadores, campos de formulario y pila de navegación en ese `Bundle`, desaparecen, y el usuario vuelve a la pantalla de inicio con un formulario vacío. Es el clásico error de "tomé una foto, regresé y la app olvidó todo".

El framework de restauración de estado de Flutter es la pieza que escribe en ese `Bundle`. En Android, `FlutterActivityAndFragmentDelegate` guarda los datos serializados del framework como un arreglo de bytes bajo la clave `"framework"` (y el estado de los plugins bajo `"plugins"`). No se guarda nada a menos que tu árbol de widgets lo active, y por eso la mayoría de las apps nunca nota que la función existe.

Dos situaciones que *no* son muerte del proceso y que, por diseño, no restauran nada:

- El usuario desliza la app fuera de Recientes. La tarea se elimina y con ella el estado guardado.
- La app se detiene a la fuerza (Ajustes, o `adb shell am force-stop`). Mismo resultado.

Comprobé ambas en el emulador, más abajo. La restauración sirve solo para el caso "el sistema me mató mientras estaba en segundo plano".

## Las tres piezas necesarias para activarla

La restauración de estado es un árbol de `RestorationBucket`. Cada pieza del árbol reclama un bucket por ID a su padre, y los valores hoja se almacenan dentro de esos buckets. Necesitas:

1. **Un ámbito raíz.** `MaterialApp(restorationScopeId: 'app')` (o `CupertinoApp`, `WidgetsApp`) crea un `RootRestorationScope` y además activa la restauración para el `Navigator` de la app. Sin él, no hay un bucket donde escribir y cada hijo recibe `null`.
2. **`RestorationMixin` en tu `State`.** Reclama un bucket hijo usando el getter `restorationId` que sobrescribes.
3. **Propiedades restaurables.** Las subclases de `RestorableProperty<T>` envuelven un valor y saben convertirlo en primitivos que `StandardMessageCodec` puede codificar. Registras cada una con una clave única dentro del bucket.

## Un formulario de pedido mínimo que sobrevive a la muerte del proceso

Esta es la pantalla que usé en todas las pruebas de este artículo. Tiene una cantidad, una casilla, un enum, dos campos de texto y una lista larga, además de un campo `int` normal como contraste.

```dart
// Flutter 3.44.8, Dart 3.12
import 'package:flutter/material.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      restorationScopeId: 'app',
      home: OrderPage(),
    );
  }
}

enum Shipping { standard, express }

class OrderPage extends StatefulWidget {
  const OrderPage({super.key});

  @override
  State<OrderPage> createState() => _OrderPageState();
}

class _OrderPageState extends State<OrderPage> with RestorationMixin {
  final RestorableInt _quantity = RestorableInt(1);
  final RestorableBool _giftWrap = RestorableBool(false);
  final RestorableEnum<Shipping> _shipping =
      RestorableEnum(Shipping.standard, values: Shipping.values);
  final RestorableTextEditingController _note = RestorableTextEditingController();
  int _plainCounter = 0; // not restorable, for contrast

  @override
  String? get restorationId => 'order_page';

  @override
  void restoreState(RestorationBucket? oldBucket, bool initialRestore) {
    registerForRestoration(_quantity, 'quantity');
    registerForRestoration(_giftWrap, 'gift_wrap');
    registerForRestoration(_shipping, 'shipping');
    registerForRestoration(_note, 'note');
  }

  @override
  void dispose() {
    _quantity.dispose();
    _giftWrap.dispose();
    _shipping.dispose();
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Order')),
      body: ListView(
        restorationId: 'order_list',
        children: [
          ListTile(
            title: Text('Quantity: ${_quantity.value}'),
            trailing: IconButton(
              icon: const Icon(Icons.add),
              onPressed: () => setState(() => _quantity.value++),
            ),
          ),
          CheckboxListTile(
            title: const Text('Gift wrap'),
            value: _giftWrap.value,
            onChanged: (v) => setState(() => _giftWrap.value = v ?? false),
          ),
          SwitchListTile(
            title: Text('Shipping: ${_shipping.value.name}'),
            value: _shipping.value == Shipping.express,
            onChanged: (v) => setState(() =>
                _shipping.value = v ? Shipping.express : Shipping.standard),
          ),
          TextField(
            controller: _note.value,
            decoration: const InputDecoration(labelText: 'Note'),
          ),
          TextField(
            restorationId: 'coupon',
            decoration: const InputDecoration(labelText: 'Coupon'),
          ),
          // ... more rows
        ],
      ),
    );
  }
}
```

Algunas cosas que conviene notar:

- Lees y escribes `.value`, y sigues llamando a `setState`. Un `RestorableValue` notifica al mixin para que el bucket se actualice, pero no reconstruye tu widget por ti.
- `restoreState` es el único lugar donde llamas a `registerForRestoration`. El framework lo invoca una vez en la primera construcción (con `initialRestore: true`) y de nuevo cada vez que el bucket se reemplaza por debajo. Registrar una propiedad carga su valor guardado si existe, o su valor por defecto si no.
- Las propiedades restaurables son `ChangeNotifier`. Libéralas en `dispose()`, tras lo cual `RestorationMixin` limpia su propia contabilidad en `super.dispose()`.
- `RestorableTextEditingController` te da un `TextEditingController` real mediante `.value`. Si solo necesitas el texto y no el controlador, `TextField(restorationId: 'coupon')` hace lo mismo internamente. Los widgets integrados que aceptan un `restorationId` incluyen `TextField`, `TextFormField`, los widgets basados en `Scrollable` (`ListView`, `GridView`, `CustomScrollView`, `SingleChildScrollView`, `PageView`), `Scaffold` (estado abierto del drawer), `FormField`, `DropdownMenu` y los selectores de fecha y hora.

## Verificarlo con una muerte de proceso real

Las pruebas de widgets son rápidas, pero lo que vale la pena demostrar es que esto sobrevive a una muerte real. Compilé un APK de release de la app anterior, lo instalé en un emulador arm64 con API 36, llené el formulario y simulé la muerte por poca memoria:

```bash
# Flutter 3.44.8 release APK on an Android 16 (API 36) emulator
flutter build apk --release
adb install -r build/app/outputs/flutter-apk/app-release.apk
# ...interact with the app, then send it to the background:
adb shell input keyevent KEYCODE_HOME
adb shell am kill net.startdebugging.restore_demo     # only kills background processes
adb shell pidof net.startdebugging.restore_demo        # prints nothing: the process is gone
adb shell am start -n net.startdebugging.restore_demo/.MainActivity
```

`am start` imprimió "Activity not started, its current task has been brought to the front", que es exactamente lo que ocurre al tocar en Recientes. El proceso nuevo tenía un PID distinto (5813 antes, 6210 después). En pantalla:

| Campo | Antes de la muerte | Después de la muerte |
| --- | --- | --- |
| `RestorableInt` cantidad | 3 | 3 |
| contador `int` normal | 1 | 0 |
| `RestorableBool` envoltorio de regalo | marcada | marcada |
| `RestorableEnum` envío | express | express |
| `RestorableTextEditingController` nota | "leave at door" | "leave at door" |
| `TextField(restorationId:)` cupón | "SAVE10" | "SAVE10" |
| `TextField` sin restorationId | "gone" | vacío |
| scroll de `ListView(restorationId:)` | desplazado | mismo offset |

Después, los casos negativos en la misma compilación: deslizar la tarea fuera de Recientes y relanzar dio cantidad 1, y lo mismo ocurrió con `am force-stop` seguido de un inicio. Como era de esperar, solo restaura la muerte iniciada por el sistema.

También puedes activar **Opciones de desarrollador > No mantener actividades** (`adb shell settings put global always_finish_activities 1`). Eso destruye la actividad en cuanto sales de ella pero mantiene vivo el proceso (el PID no cambió en mi prueba), y el estado se restauró de la misma forma. Es una comprobación manual cómoda, pero `am kill` se parece más a la muerte real del proceso porque además descarta el heap de Dart.

## Restaurar la pila de navegación

El `Navigator` de la app restaura su historial de rutas automáticamente en cuanto defines `restorationScopeId`, pero solo para las rutas que puede recrear. Una ruta abierta con `Navigator.push(context, MaterialPageRoute(...))` contiene una closure, y las closures no se pueden serializar. Usa `restorablePush`, que recibe una función estática o de nivel superior y argumentos que `StandardMessageCodec` pueda codificar:

```dart
// Flutter 3.44.8
@pragma('vm:entry-point')
Route<void> _summaryRoute(BuildContext context, Object? arguments) {
  return MaterialPageRoute<void>(
    builder: (_) => SummaryPage(quantity: arguments! as int),
  );
}

// in the button's onPressed:
Navigator.restorablePush(context, _summaryRoute, arguments: _quantity.value);
```

Mismo emulador, misma secuencia de muerte: tras `restorablePush`, la app regresó en la página Summary con "Ordering 3". Tras un `push` normal, regresó en la página Order, con la página Summary descartada en silencio.

Las rutas con nombre funcionan igual con `Navigator.restorablePushNamed`. Si abres una ruta y necesitas su resultado, envuélvela en un `RestorableRouteFuture<T>` y regístralo como cualquier otra propiedad, de modo que el callback `onComplete` se reconecte tras la restauración. Los diálogos `showDatePicker` y `showTimePicker` se restauran mediante el mismo mecanismo cuando los abres con un `RestorableRouteFuture` y el `restorationId` de `DatePickerDialog`.

Con go_router, pasa `restorationScopeId` al constructor de `GoRouter` y a `MaterialApp.router`, y dale a `ShellRoute` su propio `restorationScopeId` para los navegadores anidados. go_router construye los objetos `Page` por ti, así que no llamas a `restorablePush` ahí, pero ejecuta una prueba con `restartAndRestore` (más abajo) contra tu tabla de rutas real antes de confiar en ello.

## Escribir un RestorableValue para tu propio tipo

Los integrados cubren los primitivos (`RestorableInt`, `RestorableDouble`, `RestorableString`, `RestorableBool` y sus variantes anulables `N`), `RestorableDateTime`, `RestorableEnum`, `RestorableTimeOfDay` y `RestorableTextEditingController`. Para cualquier otra cosa, crea una subclase de `RestorableValue<T>` y convierte desde y hacia los tipos que `StandardMessageCodec` admite (null, bool, num, String, `Uint8List` y similares, `List`, `Map`):

```dart
// Flutter 3.44.8
class PriceFilter {
  const PriceFilter({required this.min, required this.max, required this.inStockOnly});
  final double min;
  final double max;
  final bool inStockOnly;
}

class RestorablePriceFilter extends RestorableValue<PriceFilter> {
  RestorablePriceFilter(this._defaultValue);
  final PriceFilter _defaultValue;

  @override
  PriceFilter createDefaultValue() => _defaultValue;

  @override
  void didUpdateValue(PriceFilter? oldValue) => notifyListeners();

  @override
  PriceFilter fromPrimitives(Object? data) {
    final map = (data! as Map<Object?, Object?>).cast<String, Object?>();
    return PriceFilter(
      min: map['min']! as double,
      max: map['max']! as double,
      inStockOnly: map['inStock']! as bool,
    );
  }

  @override
  Object toPrimitives() => <String, Object>{
        'min': value.min,
        'max': value.max,
        'inStock': value.inStockOnly,
      };
}
```

Dos detalles que hacen tropezar a la gente. `didUpdateValue` debe llamar a `notifyListeners()`; de lo contrario el mixin nunca se entera de que el valor cambió y el bucket conserva los datos antiguos. Y el mapa llega como `Map<Object?, Object?>`, no como `Map<String, Object>`, así que haz el cast en lugar de usar `as Map<String, Object>`, que lanza una excepción. En una prueba de widgets, definir el filtro con `min: 10, max: 50, inStockOnly: true` y reiniciar imprimió `50.0 true` tras la restauración.

## Probar la restauración sin un dispositivo

`flutter_test` puede simular todo el recorrido. `restartAndRestore` toma los datos de restauración actuales, desmonta el árbol de widgets y lo reconstruye a partir de esos datos, que es la parte de Dart de un reinicio de proceso:

```dart
// Flutter 3.44.8, flutter_test
testWidgets('order state survives restart', (tester) async {
  await tester.pumpWidget(const App());
  await tester.tap(find.byIcon(Icons.add));
  await tester.tap(find.byIcon(Icons.add));
  await tester.pump();

  await tester.restartAndRestore();

  expect(find.text('Quantity: 3'), findsOneWidget);
});
```

Los resultados coincidieron exactamente con el emulador: los campos restaurables y el offset del `ListView` (580.0 antes, 580.0 después) volvieron, el contador normal y el `TextField` sin registrar no, y una ruta de `restorablePush` sobrevivió mientras que una ruta de `push` no. Si la prueba falla con "The current widget tree did not inject the root bucket of the RestorationManager", olvidaste `restorationScopeId` en la app.

## Problemas que encontré al probar

**`restorablePush` con un método estático puede colgar la prueba.** La documentación de Flutter muestra el constructor de la ruta como un método `static` en la clase `State` con `@pragma('vm:entry-point')`. En Flutter 3.44.8 eso me falló bajo `flutter test` con "To access 'package:restore_demo/main.dart::_OrderPageState' from native code, it must be annotated", y la prueba nunca terminó. La VM resuelve el handle del callback a través de la clase contenedora, así que la clase también necesita el pragma. Anota también la clase `State` con `@pragma('vm:entry-point')` o, más simple, convierte el constructor en una función de nivel superior como se muestra arriba. Ambas opciones pasaron.

**Los IDs duplicados fallan en tiempo de ejecución.** Dos widgets que reclaman el mismo `restorationId` bajo el mismo bucket padre lanzan "Multiple owners claimed child RestorationBuckets with the same IDs" al final del fotograma. En las listas, construye el ID a partir de la clave estable del elemento (`'item_${item.id}'`), nunca del índice, o envuelve cada subárbol en su propio `RestorationScope`.

**Sin ámbito raíz no hay error, solo no hay restauración.** Sin `restorationScopeId`, tu `restoreState` se ejecuta igualmente, con `bucket == null`, y las propiedades funcionan como valores normales en memoria. Nada te avisa de que no se están guardando. Una sola prueba con `restartAndRestore` lo detecta.

**Mantén los datos pequeños.** Los bytes viajan por el `Bundle` de estado de instancia guardado de Android, que cruza una transacción de Binder. Una carga grande lanza `TransactionTooLargeException`. Guarda IDs y entradas de formulario, no listas de registros descargados; vuelve a pedir los datos a tu repositorio tras la restauración.

**Los motores en caché no restauran por defecto.** En configuraciones add-to-app que usan `FlutterActivity.withCachedEngine`, `shouldRestoreAndSaveState()` devuelve `false` para que los datos de restauración no sobrescriban el estado de un motor activo. Sobrescríbelo en tu subclase de `FlutterActivity` si quieres restauración ahí.

**La restauración no es persistencia.** Sobrevive a la muerte del proceso, no a cerrar la app, reiniciar el dispositivo ni deslizarla fuera de Recientes. Los borradores que el usuario espera encontrar mañana pertenecen a `shared_preferences` o a una base de datos.

**iOS necesita configuración adicional.** El mismo código de Dart funciona en iOS, pero además debes asignar un identificador de restauración al `FlutterViewController` en el proyecto de iOS. La página oficial "Restore state on iOS" cubre los pasos.

**Riverpod, Bloc y otros contenedores de estado no se restauran por ti.** El estado de un provider vive en el mismo heap de Dart que murió. Restaura las entradas (IDs, filtros, campos de formulario) con propiedades restaurables y deja que el provider recalcule, o guarda el estado serializado del provider en un `RestorableValue` y úsalo como semilla al restaurar.

## Lecturas recomendadas

- [Fix: A TextEditingController was used after being disposed in Flutter](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [How to set up nested routes and deep links with go_router in Flutter](/es/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [go_router vs auto_route vs Navigator 2.0 in Flutter](/es/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/)
- [Migrate a setState StatefulWidget to a Riverpod Notifier in Flutter](/es/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [How to catch uncaught async errors in Flutter with runZonedGuarded and PlatformDispatcher](/es/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/)

## Fuentes

- [Restore state on Android, Flutter docs](https://docs.flutter.dev/platform-integration/android/restore-state-android)
- [Restore state on iOS, Flutter docs](https://docs.flutter.dev/platform-integration/ios/restore-state-ios)
- [RestorationMixin, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorationMixin-mixin.html)
- [RestorableValue, Flutter API docs](https://api.flutter.dev/flutter/widgets/RestorableValue-class.html)
- [Navigator.restorablePush, Flutter API docs](https://api.flutter.dev/flutter/widgets/Navigator/restorablePush.html)
- [WidgetTester.restartAndRestore, Flutter API docs](https://api.flutter.dev/flutter/flutter_test/WidgetTester/restartAndRestore.html)
- [GoRouter constructor, go_router API docs](https://pub.dev/documentation/go_router/latest/go_router/GoRouter/GoRouter.html)
- [Save UI states, Android Developers](https://developer.android.com/topic/libraries/architecture/saving-states)

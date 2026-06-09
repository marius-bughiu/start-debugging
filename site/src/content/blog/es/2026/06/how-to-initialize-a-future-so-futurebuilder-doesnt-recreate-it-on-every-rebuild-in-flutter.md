---
title: "Cómo inicializar un Future para que FutureBuilder no lo recree en cada reconstruccion en Flutter"
description: "FutureBuilder vuelve a ejecutar tu trabajo asincrono cada vez que el padre se reconstruye porque creaste el Future dentro de build. Muevelo a State.initState (o memoizalo) y FutureBuilder reutilizara el mismo Future. Aqui esta el porque, el caso reproducible y cada variante que muerde."
pubDate: 2026-06-09
template: how-to
tags:
  - "flutter"
  - "dart"
  - "futurebuilder"
  - "how-to"
lang: "es"
translationOf: "2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-09
---

Si tu `FutureBuilder` parpadea volviendo a su indicador de carga, vuelve a recuperar datos o dispara la misma llamada de red varias veces, la causa casi siempre es que creaste el `Future` dentro de `build`. Cada reconstruccion del widget circundante vuelve a llamar a `build`, construye un `Future` totalmente nuevo y `FutureBuilder` lo reinicia obedientemente. La solucion es crear el `Future` exactamente una vez, almacenarlo en un campo de tu `State` y pasar ese campo almacenado a `FutureBuilder`. Esta guia usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

El equipo de Flutter es explicito sobre esto en la [documentacion de la API FutureBuilder](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): "The future must have been obtained earlier, e.g. during State.initState, State.didUpdateWidget, or State.didChangeDependencies. It must not be created during the State.build or StatelessWidget.build method call when constructing the FutureBuilder." La razon viene de inmediato: "If the future is created at the same time as the FutureBuilder, then every time the FutureBuilder's parent is rebuilt, the asynchronous task will be restarted." Ese es todo el error, expresado por el propio framework.

## Por que un Future nuevo reinicia todo

`FutureBuilder` no rastrea "la operacion que querias ejecutar". Rastrea un objeto `Future` especifico por identidad. En `didUpdateWidget`, compara `oldWidget.future` con el nuevo `widget.future`. Si no son la misma instancia, descarta la suscripcion antigua, restablece su `AsyncSnapshot` a `ConnectionState.waiting` (o `none`) y se suscribe al nuevo. No hay deduplicacion basada en valor ni memoizacion incorporada. La identidad es la unica senal que tiene.

Ahora piensa en lo que hace `build`. Llamar a `algo()` que devuelve un `Future` produce una nueva instancia de `Future` en cada invocacion, incluso si el trabajo subyacente es identico. `Future.delayed(...)`, `http.get(...)`, `repository.load()`: cada llamada asigna un objeto distinto. Asi que si el argumento `future:` es una expresion evaluada dentro de `build`, `FutureBuilder` ve una identidad diferente en cada frame y concluye, correctamente segun sus propias reglas, que le entregaste una nueva tarea.

Y `build` se ejecuta mucho mas a menudo de lo que la gente espera. Un `setState` del padre, un widget heredado que cambia (`MediaQuery` al rotar, `Theme` al alternar el brillo), un `Scaffold` que abre un teclado, una animacion ancestral, un hot reload: cualquiera de estos reconstruye tu widget y vuelve a evaluar la expresion `future:`. El trabajo asincrono no es lento ni esta roto. Se descarta y se reinicia desde cero cada vez.

## Un caso reproducible minimo que vuelve a recuperar en cada reconstruccion

Aqui esta el antipatron en su forma mas pura. El `Future` se construye en linea dentro de `build`, y un contador fuerza reconstrucciones para que puedas verlo comportarse mal.

```dart
// Flutter 3.44, Dart 3.x
// BROKEN: future is created inside build()
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  int _counter = 0;

  Future<String> _loadName() async {
    // Pretend this is a network call.
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          // New Future every build -> restarts every rebuild.
          future: _loadName(),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Toca el boton. Cada toque llama a `setState`, que llama a `build`, que llama a `_loadName()` de nuevo, que devuelve un nuevo `Future` de dos segundos. El indicador vuelve en cada toque. En una app real donde `_loadName()` es una solicitud HTTP, acabas de convertir una recuperacion en una-recuperacion-por-reconstruccion, y el usuario ve la pantalla parpadear en blanco repetidamente. Este es el mismo tipo de error que [llamar a setState durante build](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/): hacer en `build` un trabajo que `build` no tiene permitido poseer.

## La solucion, paso a paso

Mueve el `Future` fuera de `build` y a un campo que se inicialice exactamente una vez.

1. **Convierte el widget en un `StatefulWidget`** si todavia no lo es. Un `StatelessWidget` no tiene `initState` ni un lugar para retener un `Future` de forma duradera, por lo que no puede satisfacer la regla de "obtenido antes". (Mas sobre el caso sin estado abajo.)
2. **Declara un campo `late final Future<T>`** en la clase `State`. `late final` te permite asignarlo en `initState` y garantiza que se escribe exactamente una vez.
3. **Asigna el campo en `initState`**, llamando alli a tu metodo asincrono en lugar de en `build`. `initState` se ejecuta una sola vez durante la vida del `State`, sin importar cuantas veces se reconstruya el widget.
4. **Pasa el campo almacenado a `FutureBuilder`**, nunca una llamada en linea. El argumento `future:` se convierte en una referencia de campo simple sin parentesis.
5. **Verifica con una reconstruccion forzada**: dispara `setState` repetidamente y confirma que el indicador no vuelve y que el trabajo no se vuelve a ejecutar.

Aplicado al caso reproducible:

```dart
// Flutter 3.44, Dart 3.x
// FIXED: future is created once in initState
class _ProfilePageState extends State<ProfilePage> {
  late final Future<String> _nameFuture;
  int _counter = 0;

  @override
  void initState() {
    super.initState();
    _nameFuture = _loadName(); // created exactly once
  }

  Future<String> _loadName() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          future: _nameFuture, // same instance every build
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Ahora el boton incrementa el contador, `build` se ejecuta de nuevo, pero `future: _nameFuture` apunta a la instancia identica de `Future` creada antes en `initState`. `FutureBuilder.didUpdateWidget` ve que `oldWidget.future == widget.future`, mantiene su suscripcion existente y nunca restablece el snapshot. La recuperacion ocurre una vez. Este es el patron canonico y cubre la gran mayoria de los casos reales.

## Cuando el Future depende de un parametro del widget

El enfoque de `initState` tiene un borde afilado: `initState` no puede ver un nuevo valor de `widget`. Si tu `Future` depende de un `widget.userId` que el padre puede cambiar, inicializar solo en `initState` significa que los datos quedan obsoletos cuando el padre pasa un id diferente, porque el objeto `State` se reutiliza a traves de ese cambio.

La propia lista de lugares aprobados del framework ya nombro la respuesta: `State.didUpdateWidget`. Vuelve a crear el `Future` alli, pero solo cuando la entrada relevante realmente cambio, para no reintroducir el reinicio en cada reconstruccion.

```dart
// Flutter 3.44, Dart 3.x
class _UserPageState extends State<UserPage> {
  late Future<User> _userFuture;

  @override
  void initState() {
    super.initState();
    _userFuture = _fetchUser(widget.userId);
  }

  @override
  void didUpdateWidget(covariant UserPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only refetch when the id genuinely changed.
    if (oldWidget.userId != widget.userId) {
      _userFuture = _fetchUser(widget.userId);
    }
  }

  Future<User> _fetchUser(String id) async {
    // ...network call keyed by id...
    return User(id: id);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _userFuture,
      builder: (context, snapshot) {
        // ...render data / loading / error...
        return const SizedBox.shrink();
      },
    );
  }
}
```

La guarda `if (oldWidget.userId != widget.userId)` es todo el punto. Sin ella volverias a recuperar en cada reconstruccion del padre de nuevo, solo una capa mas lejos del error original. Si tu `Future` depende de un `InheritedWidget` (un valor leido via `context.dependOnInheritedWidgetOfExactType`, como un `Locale` o un ambito de proveedor), usa `didChangeDependencies` con la misma guarda de deteccion de cambios, ya que ese es el callback que Flutter dispara cuando cambia una dependencia heredada.

## Forzar una recarga deliberada

Mover el `Future` a un campo plantea una pregunta obvia: como recargar a proposito, por ejemplo en deslizar-para-actualizar? Reasigna el campo dentro de `setState`. Eso le da a `FutureBuilder` una nueva identidad exactamente cuando lo pretendes.

```dart
// Flutter 3.44, Dart 3.x
void _refresh() {
  setState(() {
    _nameFuture = _loadName(); // new instance, intentional restart
  });
}
```

Esta es la version controlada del patron roto: el nuevo `Future` se crea en respuesta a una accion del usuario, no como efecto secundario de una reconstruccion no relacionada. Combinalo con un `RefreshIndicator` cuyo `onRefresh` devuelva el nuevo future para que el indicador permanezca hasta que la recuperacion se resuelva. Mientras conectas la recarga, decide como representa el builder una recarga fallida; los patrones de [manejar errores de red con elegancia en una app de Flutter](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) se aplican directamente a la rama `snapshot.hasError`.

## Memoizar sin escribir el codigo repetitivo de initState

Si mantienes muchos de estos y la ceremonia de `initState` mas `didUpdateWidget` te molesta, el `AsyncMemoizer` del paquete `async` lo colapsa: ejecuta un callback como maximo una vez y devuelve el mismo `Future` en llamadas posteriores, asi que incluso una llamada en linea en `build` se resuelve en una sola operacion subyacente.

```dart
// Flutter 3.44, Dart 3.x
// package: async ^2.11
import 'package:async/async.dart';

class _CatalogPageState extends State<CatalogPage> {
  final _memoizer = AsyncMemoizer<List<Item>>();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Item>>(
      // runOnce returns the SAME future after the first call.
      future: _memoizer.runOnce(() => _repository.loadItems()),
      builder: (context, snapshot) => const SizedBox.shrink(),
    );
  }
}
```

`runOnce` ejecuta su callback la primera vez y cachea el `Future` resultante; las llamadas posteriores ignoran el nuevo callback y devuelven el cacheado. El memoizer sigue viviendo en el `State`, por lo que comparte las mismas garantias de vida que un campo `late final`. Para el caso dependiente de parametros tendrias que asociar un memoizer nuevo por id, lo cual es mas contabilidad que `didUpdateWidget`, asi que recurre a `AsyncMemoizer` principalmente cuando la operacion no tiene entradas.

## Por que un StatelessWidget no puede arreglar esto

Un `StatelessWidget` no tiene `initState`, ni `State`, ni un lugar estable donde guardar un `Future`. Cualquier campo que anadas se recrea cuando el padre reconstruye el widget, porque Flutter descarta y reconstruye instancias de `StatelessWidget` libremente. Asi que la regla de "crearlo antes" es insatisfacible en un `StatelessWidget`: lo mas temprano que puedes crear el `Future` es en `build`, que es exactamente el lugar que la documentacion prohibe. Si te encuentras queriendo un `Future` de larga vida dentro de un `StatelessWidget`, esa es la senal para promoverlo a un `StatefulWidget` o elevar el `Future` a una capa de gestion de estado que sobreviva al widget por completo.

Esa segunda opcion es cada vez mas la idiomatica. Un `FutureProvider` o `AsyncNotifier` de Riverpod cachea su `Future` por ti y solo recalcula cuando cambia una dependencia, lo que elimina el baile manual de `initState` y sobrevive a las reconstrucciones del widget e incluso a los cambios de ruta. Si estas eligiendo un enfoque a largo plazo en lugar de parchear una pantalla, las disyuntivas estan expuestas en [Provider vs Riverpod vs Bloc para la gestion de estado en Flutter en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), y la representacion de tres estados que obtienes del `AsyncValue` de un proveedor se cubre en [mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Dos gotchas relacionados que el patron de campo no resuelve

Mover el `Future` arregla el reinicio, pero dos problemas adyacentes sobreviven. Primero, un `FutureBuilder` dentro de una lista desplazable que usa `AutomaticKeepAliveClientMixin` de forma incorrecta todavia puede reconstruirse cuando la fila vuelve a la vista; el campo `Future` protege los datos, pero asegurate de que el estado de la fila se mantenga vivo si quieres evitar un parpadeo de reconstruccion. Segundo, un `Future` que se completa despues de que el widget se fue intentara entregar en un `State` ya destruido. El propio `FutureBuilder` se protege internamente contra `setState`-despues-de-destruir, pero si tu metodo asincrono toca otros controladores cuando se resuelve, todavia puedes encontrar errores de ciclo de vida. La disciplina de destruccion de [destruir controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) es el habito complementario: posee cada recurso que creas y liberalo en `dispose`.

El modelo mental para retener: `FutureBuilder` es un adaptador delgado que observa un `Future` por identidad. Es tu trabajo hacer esa identidad estable. Crea el `Future` en `initState`, refrescalo en `didUpdateWidget` o `didChangeDependencies` solo cuando una entrada cambio, y reasignalo en `setState` solo cuando el usuario pidio datos frescos. Haz eso y el indicador se muestra exactamente una vez, la red se golpea exactamente una vez y la pantalla deja de parpadear.

## Fuentes

- [FutureBuilder class - widgets library](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): la regla "must have been obtained earlier" y la advertencia de reinicio, citadas arriba.
- [State.initState method](https://api.flutter.dev/flutter/widgets/State/initState.html): se ejecuta una vez por vida del State.
- [State.didUpdateWidget method](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html): el gancho para reaccionar a la configuracion cambiada del widget.
- [AsyncMemoizer class - async package](https://pub.dev/documentation/async/latest/async/AsyncMemoizer-class.html): ejecuta un callback como maximo una vez.

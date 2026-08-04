---
title: "Cómo crear una lista paginada con scroll infinito en Flutter con ScrollController"
description: "Conecta un ScrollController a un ListView.builder, pide la siguiente página cuando position.extentAfter baja del umbral de precarga y protege la solicitud con banderas isLoading, hasMore y error. Implementación completa más la trampa de la primera página corta."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "listview"
  - "scrollcontroller"
  - "pagination"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller"
translatedBy: "claude"
translationDate: 2026-08-04
---

Para armar una lista con scroll infinito en Flutter, conecta un `ScrollController` a un `ListView.builder`, escucha los cambios de scroll y pide la siguiente página cuando `position.extentAfter` baja de un umbral de precarga de unos cientos de píxeles. El listener en sí mismo tiene que ser idempotente: se dispara en cada frame de scroll, así que la carga real debe estar detrás de una guarda de `isLoading`/`hasMore`/`error` o vas a lanzar una docena de solicitudes idénticas durante un solo deslizamiento. Este artículo construye todo sobre Flutter 3.44.8 (Dart 3.12.2) y luego cubre los dos modos de fallo que aparecen en producción: la primera página demasiado corta para hacer scroll y el bucle de reintentos que machaca una API caída.

## Por qué `pixels >= maxScrollExtent` es el disparador equivocado

Casi todos los tutoriales empiezan acá:

```dart
// Flutter 3.44.8, Dart 3.12.2 -- do not ship this
_controller.addListener(() {
  if (_controller.position.pixels >= _controller.position.maxScrollExtent) {
    _loadMore();
  }
});
```

Hay tres cosas mal.

Primero, un `ScrollController` notifica a sus listeners en cada cambio de posición de scroll, lo que durante un deslizamiento significa una vez por frame a 60Hz o 120Hz. Si `_loadMore()` es un `await api.fetch(...)` sin protección, la condición sigue siendo verdadera todo el tiempo que la lista queda pegada al fondo, y lanzas una solicitud nueva en cada frame hasta que llega la primera respuesta. En un dispositivo de 120Hz con 300ms de ida y vuelta eso son aproximadamente 36 solicitudes duplicadas.

Segundo, `maxScrollExtent` es exactamente el fondo. Esperar a llegar ahí significa que el usuario ya se quedó sin contenido antes de que empieces a pedir más, así que se queda mirando un hueco vacío durante lo que dure la ida y vuelta de red. El viewport de Flutter construye un `cacheExtent` de `RenderAbstractViewport.defaultCacheExtent`, que son `250.0` píxeles lógicos, más allá del borde visible. Disparar mientras todavía hay contenido en esa banda hace que la carga se superponga con el scroll en vez de ir detrás.

Tercero, `ScrollController.position` no es seguro de tocar sin condiciones. El getter tiene dos asserts:

```dart
ScrollPosition get position {
  assert(_positions.isNotEmpty, 'ScrollController not attached to any scroll views.');
  assert(_positions.length == 1, 'ScrollController attached to multiple scroll views.');
  return _positions.single;
}
```

Los dos saltan en compilaciones de depuración y los dos son alcanzables desde código común, como se ve en las trampas más abajo.

El arreglo para los dos primeros puntos es disparar con `extentAfter`, que la documentación de `ScrollPosition` define como la cantidad de contenido conceptualmente por debajo del viewport. Cuando `extentAfter` vale 400, al usuario todavía le quedan 400 píxeles lógicos de filas ya construidas por las que hacer scroll, que suele ser pista suficiente para esconder la carga por completo.

## Cómo armarlo en cuatro pasos

Todo el patrón son cuatro piezas móviles. El resto es presentación.

1. **Guarda el estado de paginación en el `State`, no en el builder.** Necesitas la `List<T>` acumulada, el cursor o número de página para la siguiente solicitud, y tres banderas: `_isLoading`, `_hasMore` y `_error`. Esas tres banderas son lo que hace seguro llamar al listener de scroll en cada frame.
2. **Conecta un `ScrollController` en `initState` y desconéctalo en `dispose`.** Llama a `removeListener` antes de `dispose()` sobre el controlador, y lanza la primera página desde `initState` para que la lista nunca quede vacía en el primer frame sin un indicador de carga.
3. **Dispara con `extentAfter`, no con `pixels`.** En el listener, sal de inmediato si el controlador no tiene clientes, si ya hay una carga en curso, si el servidor dijo que no hay más páginas, o si el último intento falló. Recién entonces compara `extentAfter` contra tu umbral de precarga.
4. **Renderiza una fila extra para el estado final.** Pon `itemCount` en `items.length + 1` mientras haya más por cargar o un error que mostrar, y haz que `itemBuilder` devuelva un indicador de carga, una fila de reintento, o nada para ese índice final. Eso es lo que convierte el estado de carga en algo que el usuario ve y sobre lo que puede actuar.

## La implementación completa

```dart
// Flutter 3.44.8, Dart 3.12.2
class FeedPage extends StatefulWidget {
  const FeedPage({super.key});

  @override
  State<FeedPage> createState() => _FeedPageState();
}

class _FeedPageState extends State<FeedPage> {
  // Default viewport cacheExtent is 250.0 px, so 400 leaves runway.
  static const double _prefetchExtent = 400;
  static const int _pageSize = 20;

  final ScrollController _controller = ScrollController();
  final List<Post> _items = [];

  String? _cursor;
  bool _isLoading = false;
  bool _hasMore = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onScroll);
    _loadMore();
  }

  @override
  void dispose() {
    _controller.removeListener(_onScroll);
    _controller.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_controller.hasClients) return;
    if (_isLoading || !_hasMore || _error != null) return;
    if (_controller.position.extentAfter > _prefetchExtent) return;
    _loadMore();
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore) return;

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final page = await api.fetchFeed(after: _cursor, limit: _pageSize);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.nextCursor != null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      _isLoading = false;
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool showTail = _hasMore || _error != null;

    return ListView.builder(
      controller: _controller,
      itemCount: _items.length + (showTail ? 1 : 0),
      itemBuilder: (context, index) {
        if (index < _items.length) {
          return PostTile(post: _items[index]);
        }
        if (_error != null) {
          return _RetryTile(error: _error!, onRetry: _retry);
        }
        return const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        );
      },
    );
  }

  void _retry() {
    setState(() => _error = null);
    _loadMore();
  }
}
```

Fíjate en la separación entre `_onScroll` y `_loadMore`. `_onScroll` se niega a ejecutarse cuando `_error != null`; `_loadMore` no. Esa asimetría es deliberada y es lo que corta el bucle de reintentos descrito más abajo. El listener de scroll nunca va a reintentar automáticamente una página fallida, pero el botón de reintento sí puede, porque primero limpia `_error`.

El bloque `finally` asigna `_isLoading = false` como asignación simple antes de comprobar `mounted`. Si pones la asignación dentro de un `setState` que solo corre cuando está montado, un desmontaje durante la solicitud deja la bandera pegada en true; inofensivo para un widget ya destruido, pero hace más difícil razonar sobre la máquina de estados cuando esta misma lógica de controlador se mueve después a un notifier de Riverpod.

## La primera página corta que nunca hace scroll

Este es el bug que más veces llega a producción, porque solo aparece en pantallas altas. Si la página uno devuelve 20 filas y en el viewport entran 30, `maxScrollExtent` vale `0.0`, no se puede hacer scroll, el `ScrollController` nunca notifica, y la lista queda permanentemente en 20 elementos. Funciona perfecto en un celular en vertical y se ve rota en una tablet, en escritorio y en web con la ventana maximizada.

`ScrollController` no ayuda acá, porque nada hizo scroll. El arreglo más barato es volver a comprobar después del frame que colocó las filas nuevas:

```dart
// Flutter 3.44.8: run after layout so maxScrollExtent is real.
void _fillViewportIfNeeded() {
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted || !_controller.hasClients) return;
    if (_error != null || !_hasMore) return;
    if (_controller.position.maxScrollExtent == 0) _loadMore();
  });
}
```

Llámalo al final de la rama de éxito de `_loadMore`. Termina siempre: cada pasada o hace el contenido más alto que el viewport (con lo que `maxScrollExtent > 0`) o agota el feed (con lo que `_hasMore` pasa a false).

El arreglo más completo es `ScrollMetricsNotification`, que Flutter despacha cuando las `ScrollMetrics` de un scrollable cambian sin que haya habido scroll, incluyendo cuando el contenido crece o se encoge y cuando la ventana padre cambia de tamaño. Envolver la lista en uno cubre el caso de la tablet, el del redimensionado de ventana en escritorio, y el caso en que el teclado en pantalla se cierra y el viewport de golpe se hace más alto:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollMetricsNotification>(
  onNotification: (notification) {
    if (notification.metrics.maxScrollExtent == 0 && _error == null) {
      _loadMore();
    }
    return false; // let it keep bubbling
  },
  child: ListView.builder(/* ... */),
)
```

Devuelve `false` desde `onNotification`. Devolver `true` cancela el viaje de la notificación hacia arriba en el árbol, lo que rompe silenciosamente a cualquier ancestro que dependa de ella, como un `Scrollbar` o un `RefreshIndicator`.

## El bucle de reintentos que machaca una API caída

Supón que la guarda en `_onScroll` fuera solo `if (_isLoading || !_hasMore) return;`. El usuario está al fondo, la solicitud falla, `_isLoading` pasa a false, `_hasMore` sigue en true, y la posición no se movió. La siguiente notificación de scroll, que llega en el micromovimiento siguiente del dedo del usuario, vuelve a llamar a `_loadMore`. Cada fallo produce de inmediato otra solicitud, así que un corte de red se convierte en una avalancha de solicitudes que mantiene la radio despierta y consume batería.

Agregar `_error != null` a la guarda de scroll convierte el fallo en un estado terminal que solo limpia una acción explícita del usuario. Si quieres recuperación automática, ponla detrás de un backoff en vez de detrás del listener de scroll, y limita los intentos. La forma general de eso, incluyendo qué excepciones vale la pena reintentar, está en [cómo manejar errores de red con elegancia en una app Flutter](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/).

## Trampas que te van a morder

1. **`ScrollController not attached to any scroll views.`** Leer `.position` antes del primer layout, o después de que el `ListView` desapareció, dispara este assert. Es fácil caer desde un callback post-frame que sobrevive a un `Navigator.pop`. Protege cada acceso con `hasClients`, que no es más que `_positions.isNotEmpty`.
2. **`ScrollController attached to multiple scroll views.`** Un controlador solo puede reportar una posición si exactamente un scrollable lo está usando. Pasar el mismo `_controller` a dos `ListView` dentro de un `TabBarView` es la forma clásica de caer. Cada pestaña necesita su propio controlador y su propio estado de paginación.
3. **La paginación por offset se desfasa con un feed vivo.** Si el servidor inserta una fila mientras el usuario está entre la página 2 y la 3, `?page=3&size=20` devuelve una ventana que se superpone con la página 2, así que el usuario ve un duplicado y se pierde otro elemento. La paginación por cursor no tiene ese modo de fallo, y por eso el ejemplo de arriba pasa un `nextCursor` en vez de un índice de página. La mitad del lado del servidor, con el SQL y el índice que necesita, está en [paginación keyset (por cursor) en EF Core 11](/es/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).
4. **`setState` después de `dispose`.** Cada `await` en `_loadMore` es un punto donde el usuario puede tocar atrás. El `if (!mounted) return;` después de cada await no es opcional; sin él obtienes `setState() called after dispose()`. La regla completa, incluyendo por qué hay que volver a comprobar `mounted` después de cada intervalo y no una sola vez arriba, está en [proteger setState con la comprobación de mounted tras un intervalo asíncrono](/es/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).
5. **El controlador es un desechable que tú posees.** `ScrollController` extiende `ChangeNotifier`; si el `State` que lo creó no lo desecha, el closure del listener mantiene vivo al `State` y a todo lo que capturó. Es la misma clase de fuga de memoria que un `TextEditingController` o un `AnimationController` sin desechar, cubierta en [cómo desechar controladores en Flutter para evitar fugas de memoria](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).
6. **`shrinkWrap: true` destruye todo el propósito.** Una lista con shrink wrap construye todos sus hijos en el primer frame para poder medirse, así que una lista infinita se convierte en un costo de primer frame que crece sin límite. Si llegaste a él para silenciar un error de altura no acotada, las alternativas correctas están desglosadas en [shrinkWrap vs Expanded vs slivers para listas largas](/es/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/).

## Cuándo usar `NotificationListener` en lugar de un controlador

`ScrollController` no es la única forma de leer las métricas de scroll. Un `NotificationListener<ScrollNotification>` obtiene los mismos números a través de `notification.metrics` sin poseer ningún controlador:

```dart
// Flutter 3.44.8, Dart 3.12.2
NotificationListener<ScrollEndNotification>(
  onNotification: (notification) {
    if (notification.metrics.extentAfter < 400) _loadMore();
    return false;
  },
  child: ListView.builder(/* ... */),
)
```

Prefiere esto cuando no eres dueño del scrollable: dentro de un `NestedScrollView`, bajo un `PrimaryScrollController`, o cuando la lista es un `CustomScrollView` con varias secciones de slivers y un solo controlador sería ambiguo sobre a cuál te referías. `ScrollEndNotification` además se dispara mucho menos que un listener de controlador, lo que elimina la preocupación por frame, aunque a costa de no precargar a mitad del deslizamiento.

Prefiere el controlador cuando además necesites *manejar* el scroll: `jumpTo`, `animateTo`, restaurar un offset, o desplazarte a un elemento recién insertado. Y si tu lista comparte viewport con otro contenido, los equivalentes con slivers aplican sin cambios; la lógica de paginación es idéntica, solo cambia el widget que envuelve, como en [mezclar un ListView y un GridView en un solo scroll con slivers](/es/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/).

## Si conviene usar el paquete

`infinite_scroll_pagination` 5.1.1 empaqueta esta máquina de estados como un `PagingController` más un `PagedListView` y un `PagingListener`, y maneja los estados finales, el caso de la primera página corta y la integración con pull to refresh. Es una dependencia razonable para una app con muchas pantallas paginadas, ya que la alternativa es copiar y pegar el `State` de arriba cinco veces.

Escríbelo a mano cuando tengas una o dos listas paginadas, cuando tu estado de paginación ya viva en Riverpod o Bloc (momento en el que el controlador es solo un disparador y el controlador propio del paquete queda de más), o cuando el contrato de paginación de tu API sea lo bastante inusual como para terminar peleando contra la abstracción. Si vas a conectar esto con Riverpod, las ramas de carga y error encajan limpiamente sobre `AsyncValue`, cubierto en [mostrar estados de carga y error con AsyncValue en Flutter Riverpod](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Fuentes

- [ScrollPosition class](https://api.flutter.dev/flutter/widgets/ScrollPosition-class.html), documentación de la API de Flutter (`extentAfter`, `maxScrollExtent`, `atEdge`)
- [ScrollController class](https://api.flutter.dev/flutter/widgets/ScrollController-class.html), documentación de la API de Flutter (`hasClients`, `position`, `keepScrollOffset`)
- [ScrollMetricsNotification class](https://api.flutter.dev/flutter/widgets/ScrollMetricsNotification-class.html), documentación de la API de Flutter
- [RenderAbstractViewport.defaultCacheExtent](https://api.flutter.dev/flutter/rendering/RenderAbstractViewport/defaultCacheExtent-constant.html), documentación de la API de Flutter
- [Notas de la versión Flutter 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0), documentación de Flutter
- [infinite_scroll_pagination en pub.dev](https://pub.dev/packages/infinite_scroll_pagination)

---
title: "Cómo mostrar estados de carga y error con AsyncValue en Flutter Riverpod"
description: "Renderiza estados de carga, datos y error desde un solo AsyncValue en Riverpod 3. Usa AsyncNotifier y AsyncValue.guard para las mutaciones, .when() y coincidencia de patrones con switch para la UI, conserva los datos previos al refrescar y migra el patrón heredado StateNotifier. Probado en flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-06-02
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "es"
translationOf: "2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-02
---

La versión corta: un provider asíncrono en Riverpod te entrega un `AsyncValue<T>`, que es un único objeto que siempre está en exactamente uno de tres estados (datos, carga o error). Renderizas los tres desde un solo lugar con `value.when(data: ..., loading: ..., error: ...)` o con un `switch` de Dart 3 sobre `AsyncData` / `AsyncLoading` / `AsyncError`. Produces esos estados desde un `AsyncNotifier` cuyo `build` devuelve un `Future`, y los mutas de forma segura con `AsyncValue.guard`, que convierte una excepción lanzada en un `AsyncError` en lugar de provocar un fallo. Si estás en el antiguo `StateNotifier`, el lado del renderizado es idéntico una vez que expones un `AsyncValue` como estado. Esta guía está probada en `flutter_riverpod` 3.x (la línea 3.0 se publicó a principios de 2026), Flutter 3.44 y Dart 3.x.

La razón por la que este patrón importa es que casi toda pantalla de una app real es asíncrona: obtiene algo, la obtención puede estar en curso y la obtención puede fallar. Los equipos que lo escriben a mano terminan con tres campos separados (`isLoading`, `data`, `errorMessage`), una maraña de ramas `if` y el clásico error donde `isLoading` es `false` pero `data` sigue siendo `null` porque un retorno temprano olvidó cambiar una bandera. `AsyncValue` hace que los estados ilegales sean irrepresentables: no existe "cargando y además tiene un error y además tiene datos" porque el tipo es una unión sellada. Manejas los tres casos que el compilador te obliga a manejar, y listo.

## Los tres estados, y por qué una unión gana a tres booleanos

`AsyncValue<T>` es una clase sellada con tres subtipos concretos:

- `AsyncData<T>` lleva un `value` de tipo `T`.
- `AsyncLoading<T>` significa que hay una carga en curso.
- `AsyncError<T>` lleva un `error` (`Object`) y un `stackTrace`.

Como la clase está sellada, el analizador sabe que la lista de subtipos es cerrada, así que un `switch` sobre ellos es exhaustivo sin caso por defecto. Ese es todo el diseño: en lugar de reconstruir "en qué estado estoy" a partir de un saco de campos anulables en cada reconstrucción, haces coincidencia de patrones sobre un valor cuyo tipo ya codifica la respuesta.

También tiene getters de conveniencia a los que recurrirás constantemente:

- `isLoading`, `hasValue`, `hasError` son booleanos.
- `value` es un `T?` anulable (puede ser no nulo incluso mientras `isLoading` es true, lo que importa para el refresco, ver más abajo).
- `valueOrNull` es el accesor seguro que nunca lanza.
- `requireValue` devuelve el valor o lanza `AsyncValueIsLoadingException` / vuelve a lanzar el error. Úsalo solo cuando ya hayas probado que estás en el estado de datos.
- `isRefreshing` e `isReloading` distinguen un refresco forzado de un recálculo provocado por dependencias.

## Una pantalla concreta: una lista de artículos que puede cargar y fallar

Aquí está la configuración realista más pequeña: un repositorio que obtiene una lista, un provider que la expone y un widget que renderiza los tres estados. Uso la variante con generación de código y `riverpod_annotation`, que es la forma recomendada de declarar providers en la línea 3.x.

```dart
// flutter_riverpod 3.x, riverpod_annotation 3.x, Dart 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'articles_provider.g.dart';

class Article {
  const Article(this.id, this.title);
  final String id;
  final String title;
}

@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll(); // may throw on a network failure
  }
}
```

El método `build` devuelve un `Future<List<Article>>`. Riverpod envuelve ese future por ti: mientras está pendiente, `ref.watch(articlesProvider)` es `AsyncLoading`; cuando se completa, `AsyncData`; si lanza, `AsyncError`. Nunca construyes esos estados a mano para la carga inicial. Solo devuelves datos o dejas que una excepción se propague.

Si no usas generación de código, la forma manual es la misma estructura de clase sin la anotación:

```dart
// Manual (no code-gen) equivalent. flutter_riverpod 3.x
final articlesProvider =
    AsyncNotifierProvider<Articles, List<Article>>(Articles.new);

class Articles extends AsyncNotifier<List<Article>> {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll();
  }
}
```

## Renderizar los tres estados con `.when()`

`.when()` es la forma más directa de mapear un `AsyncValue` a widgets. Toma tres callbacks obligatorios:

```dart
// flutter_riverpod 3.x
class ArticleListView extends ConsumerWidget {
  const ArticleListView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final articles = ref.watch(articlesProvider);

    return articles.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) => ListTile(title: Text(list[i].title)),
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => ErrorView(
        message: _humanMessage(err),
        onRetry: () => ref.invalidate(articlesProvider),
      ),
    );
  }
}
```

Fíjate en tres cosas. Primero, `ref.invalidate(articlesProvider)` es como el botón de reintentar vuelve a ejecutar `build`; descarta el estado en caché y recalcula. `ref.refresh` hace lo mismo y devuelve el nuevo valor si lo necesitas. Segundo, el callback `error` recibe tanto el objeto de error como su traza de pila, así que puedes registrar la traza y mostrarle al usuario un mensaje amigable: nunca pongas `err.toString()` directo en pantalla. Tercero, `_humanMessage` es donde traduces los tipos de excepción a texto, lo cual encaja con clasificar el fallo correctamente; consulta [cómo manejar errores de red con elegancia en una app Flutter](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) para el mapeo de excepción a mensaje que corresponde ahí.

## La alternativa de Dart 3: coincidencia de patrones con `switch`

Como `AsyncValue` está sellado, puedes hacer coincidencia de patrones directamente sobre él. Muchos equipos lo prefieren en Riverpod 3 porque se lee de forma natural y permite desestructurar en una línea:

```dart
// Dart 3.x switch expression over the sealed AsyncValue
Widget build(BuildContext context, WidgetRef ref) {
  final articles = ref.watch(articlesProvider);

  return switch (articles) {
    AsyncData(:final value) => ArticleList(items: value),
    AsyncError(:final error) => ErrorView(message: _humanMessage(error)),
    _ => const Center(child: CircularProgressIndicator()),
  };
}
```

La rama `_` captura `AsyncLoading`. Funcionalmente esto es equivalente a `.when()`, pero compone mejor cuando quieres agregar guardas (por ejemplo `AsyncData(:final value) when value.isEmpty => const EmptyState()`). Usa la que tu equipo encuentre más legible; producen la misma UI.

## Mutaciones: por qué necesitas `AsyncValue.guard`

La carga inicial es automática, pero un botón que crea o elimina un artículo es una transición de estado manual, y ahí es donde el código sin protección falla. La forma incorrecta es llamar al repositorio directamente y dejar que la excepción escape al árbol de widgets. La forma correcta pone el estado en carga, ejecuta el trabajo dentro de `AsyncValue.guard` y asigna el resultado:

```dart
// flutter_riverpod 3.x
@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() => ref.watch(articleRepositoryProvider).fetchAll();

  Future<void> add(String title) async {
    final repo = ref.read(articleRepositoryProvider);

    // Show loading while keeping the current list visible (see "refresh" below).
    state = const AsyncLoading<List<Article>>().copyWithPrevious(state);

    // guard converts a thrown exception into AsyncError instead of crashing.
    state = await AsyncValue.guard(() async {
      await repo.create(title);
      return repo.fetchAll();
    });
  }
}
```

`AsyncValue.guard` es la contraparte del envoltorio automático en `build`. Ejecuta tu callback, devuelve `AsyncData` en caso de éxito y `AsyncError` (con la traza de pila capturada) en caso de fallo, así que un corte de red durante `add` cambia la pantalla a tu UI de error en lugar de lanzar una excepción no manejada. La llamada `copyWithPrevious(state)` es lo que permite que la lista permanezca en pantalla durante la mutación en vez de mostrar un spinner a pantalla completa; el nuevo `AsyncLoading` lleva el valor antiguo, así que `value` sigue poblado.

## Conservar los datos en pantalla durante el refresco

Este es el detalle que hace tropezar a todo el mundo. Cuando haces `ref.refresh` de un provider asíncrono, el estado vuelve brevemente a carga. Si ingenuamente muestras un spinner para cada estado de carga, un "pull-to-refresh" deja la pantalla en blanco durante un frame. Riverpod 3 lo maneja con dos banderas en `.when()`:

- `skipLoadingOnRefresh` tiene `true` por defecto. Durante un `ref.refresh` (un refresco explícito, dirigido por el usuario), `.when()` sigue llamando a tu callback `data` con el valor anterior en lugar de `loading`.
- `skipLoadingOnReload` tiene `false` por defecto. Cuando el provider se recarga porque cambió una dependencia, recibes el callback `loading` por defecto.

Así que de fábrica, un "pull-to-refresh" mantiene visible la lista antigua mientras se carga la nueva, que es lo que quieres. Si en cambio quieres que el spinner aparezca al refrescar, desactívalo:

```dart
articles.when(
  skipLoadingOnRefresh: false, // show the loading callback even on refresh
  data: (list) => ArticleList(items: list),
  loading: () => const Center(child: CircularProgressIndicator()),
  error: (err, _) => ErrorView(message: _humanMessage(err)),
);
```

Para un control de "pull-to-refresh" específicamente, la combinación idiomática es mantener `skipLoadingOnRefresh: true` (para que la lista se quede en su sitio) y dirigir `RefreshIndicator` desde el future devuelto:

```dart
RefreshIndicator(
  onRefresh: () => ref.refresh(articlesProvider.future),
  child: articles.when(
    data: (list) => ListView(/* ... */),
    loading: () => const Center(child: CircularProgressIndicator()),
    error: (err, _) => ErrorView(message: _humanMessage(err)),
  ),
);
```

Esperar con `await` a `articlesProvider.future` hace que el spinner del propio `RefreshIndicator` gire hasta que llegan los nuevos datos, mientras el cuerpo sigue mostrando debajo los datos antiguos. Ese es el comportamiento que los usuarios esperan.

Una advertencia que vale la pena conocer: hay un [issue abierto](https://github.com/rrousselGit/riverpod/issues/4670) donde `skipLoadingOnRefresh` y `skipLoadingOnReload` no siempre se comportan como está documentado porque un refresco también puede disparar una recarga. Si tu refresco muestra un spinner de forma inesperada, esa interacción es lo primero que hay que revisar.

## Dónde encaja el `StateNotifier` heredado

La consulta de búsqueda que trae a la gente aquí a menudo empareja `AsyncValue` con `StateNotifier`, así que vale la pena ser preciso sobre cómo están las cosas en 2026. A partir de Riverpod 2.0, `Notifier` y `AsyncNotifier` reemplazaron a `StateNotifier`, y en Riverpod 3 los antiguos tipos `StateNotifier` y `StateNotifierProvider` se movieron fuera del archivo barril principal hacia `package:flutter_riverpod/legacy.dart`. Todavía funcionan, pero ya no son la API recomendada.

Si tienes un `StateNotifier` que expone datos asíncronos, el truco que hace el renderizado idéntico a todo lo de arriba es hacer que su estado sea un `AsyncValue` tú mismo:

```dart
// Legacy pattern. Import from the legacy barrel in flutter_riverpod 3.x.
import 'package:flutter_riverpod/legacy.dart';

class ArticlesNotifier extends StateNotifier<AsyncValue<List<Article>>> {
  ArticlesNotifier(this._repo) : super(const AsyncLoading()) {
    _load();
  }
  final ArticleRepository _repo;

  Future<void> _load() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(_repo.fetchAll);
  }
}

final articlesProvider =
    StateNotifierProvider<ArticlesNotifier, AsyncValue<List<Article>>>(
  (ref) => ArticlesNotifier(ref.watch(articleRepositoryProvider)),
);
```

Como `state` es un `AsyncValue<List<Article>>`, el código del widget no cambia en absoluto: `ref.watch(articlesProvider).when(...)` funciona exactamente como antes. La lección es que `AsyncValue` es el contrato de la UI; `AsyncNotifier` frente a `StateNotifier` es solo sobre cómo lo produces. Cuando sí migres, `AsyncNotifier` elimina el boilerplate (sin constructor manual `_load`, sin `AsyncLoading` manual en el constructor) porque `build` lo hace por ti. La [guía oficial de migración desde StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier) recorre el reemplazo mecánico, y la guía más amplia [cómo migrar una app Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) cubre la misma traducción de `Notifier` / `AsyncNotifier` en el contexto de una migración completa.

## Errores comunes

**No leas `requireValue` en un estado de carga.** Lanza `AsyncValueIsLoadingException`. Úsalo solo dentro de la rama `data` o después de comprobar `hasValue`. Cuando solo quieres un valor por defecto, usa `valueOrNull ?? const []`.

**`isLoading` es true al refrescar, no solo en la carga inicial.** Si escribes `if (value.isLoading) return Spinner()` antes de comprobar `hasValue`, dejarás la pantalla en blanco en cada refresco. Prefiere `.when()` (que respeta `skipLoadingOnRefresh`) o comprueba `value.isLoading && !value.hasValue` para distinguir "primera carga" de "refrescando con datos ya presentes".

**Una lista vacía es datos, no carga.** Una obtención exitosa que devuelve `[]` es `AsyncData([])`, así que maneja el caso vacío dentro de tu rama `data` (una vista de "Agrega tu primer artículo"), no tratando el vacío como aún-cargando.

**Los errores durante una mutación necesitan `guard`, pero los errores en `build` no.** Dentro de `build`, simplemente `throw` (o deja que el repositorio lance); Riverpod lo captura. Dentro de un método imperativo como `add`, debes envolver con `AsyncValue.guard`, de lo contrario la excepción escapa del notifier y se convierte en un error no manejado.

**Usa un modelo de error tipado, no `toString()`.** Mapea los tipos de excepción a texto para el usuario en un solo helper. Si tu modelo de datos usa clases selladas o `Freezed`, el mismo beneficio de exhaustividad que obtienes de `AsyncValue` aplica a tus errores de dominio; consulta [Dart records vs clases Freezed](/es/2026/05/dart-records-vs-freezed-classes/) para saber cuándo cada uno es la herramienta correcta para modelarlos.

## Probar los tres estados

Como el estado es solo un valor, las pruebas son sencillas: construye un `ProviderContainer`, sobrescribe el repositorio con un falso y haz aserciones sobre el `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.x
test('emits AsyncError when the repository throws', () async {
  final container = ProviderContainer(overrides: [
    articleRepositoryProvider.overrideWithValue(ThrowingRepository()),
  ]);
  addTearDown(container.dispose);

  // Wait for the first build to settle.
  await container.read(articlesProvider.future).catchError((_) => <Article>[]);

  final state = container.read(articlesProvider);
  expect(state, isA<AsyncError>());
});
```

Sobrescribe el repositorio para que devuelva datos, un error o un future que nunca se completa, y podrás hacer aserciones sobre cada rama que renderiza tu UI. Ese es el beneficio práctico de empujar los tres estados a un único valor tipado: el provider, el widget y la prueba hablan todos el mismo idioma. Cuando persigas por qué una transición de estado es entrecortada en lugar de incorrecta, la línea de tiempo de frames en DevTools te dice si una reconstrucción es el costo; consulta [cómo perfilar el jank en una app Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) para leerla.

## Fuentes

- [Referencia de la clase AsyncValue](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html), docs de la API de Riverpod (`when`, `guard`, `requireValue`, `copyWithPrevious`).
- [Novedades en Riverpod 3.0](https://riverpod.dev/docs/whats_new) y la [guía de migración de 2.0 a 3.0](https://riverpod.dev/docs/3.0_migration), riverpod.dev.
- [Migrar desde StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier), riverpod.dev.
- [Issue #4670 sobre el comportamiento de skipLoadingOnRefresh / skipLoadingOnReload](https://github.com/rrousselGit/riverpod/issues/4670), rrousselGit/riverpod.

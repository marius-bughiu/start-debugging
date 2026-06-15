---
title: "FutureBuilder/StreamBuilder vs AsyncValue de Riverpod en Flutter: cual deberias usar?"
description: "Usa FutureBuilder o StreamBuilder para un widget asincrono autocontenido y desechable. Recurre a AsyncValue de Riverpod cuando el resultado se comparte, se cachea o se muta. Aqui esta la decision, los puntos delicados y codigo ejecutable para ambos. Probado en Flutter 3.44 y flutter_riverpod 3.3.1."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "futurebuilder"
lang: "es"
translationOf: "2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-15
---

Si estas decidiendo entre los `FutureBuilder` / `StreamBuilder` integrados de Flutter y el `AsyncValue` de Riverpod, la respuesta corta es: conserva los builders para un widget unico y autocontenido que posee un resultado asincrono desechable, y pasa a `AsyncValue` de Riverpod en el momento en que ese resultado se comparte entre pantallas, se cachea, se refresca o se muta. Los builders no son "la version para principiantes" de lo mismo. Son una primitiva de UI que se suscribe a un objeto asincrono. `AsyncValue` es un modelo de estado que vive fuera del arbol de widgets. Esta guia esta probada en Flutter 3.44 (estable, 2026-05-18), Dart 3.12 y `flutter_riverpod` 3.3.1 (la linea 3.0 salio el 2025-09-10).

## Resuelven problemas que se solapan en capas distintas

`FutureBuilder` y `StreamBuilder` son widgets. Le pasas a cada uno un `Future` o `Stream`, y le entrega a tu callback `builder` un `AsyncSnapshot<T>` que describe el estado de conexion actual (waiting, active, done) mas los ultimos datos o el error. El widget se suscribe cuando se inserta, se desuscribe cuando se elimina y se vuelve a suscribir si le pasas una instancia distinta de `Future`/`Stream`. Ese es todo el contrato. No hay caching, ni compartir, ni memoria del resultado una vez que el widget sale del arbol.

El `AsyncValue<T>` de Riverpod no es un widget en absoluto. Es una union sellada con tres subtipos (`AsyncData`, `AsyncLoading`, `AsyncError`) que un provider expone como su valor. El trabajo asincrono se ejecuta dentro de un provider que vive fuera del arbol de widgets, asi que cualquier widget puede leerlo, varios widgets pueden leer la misma instancia y el resultado sobrevive a las reconstrucciones y a la navegacion. Lo renderizas con `value.when(...)` o un `switch` de Dart 3, igual que renderizas un `AsyncSnapshot`, pero la fuente de verdad es un provider en lugar de un campo del widget.

Asi que la verdadera pregunta no es "cual renderiza mejor tres estados". Ambos renderizan tres estados bien. La pregunta es donde debe vivir el resultado asincrono y cuantas cosas necesitan verlo.

## Matriz de caracteristicas

| Aspecto | FutureBuilder / StreamBuilder (Flutter 3.44) | AsyncValue de Riverpod (flutter_riverpod 3.3.1) |
| --- | --- | --- |
| Que es | Un widget que se suscribe a un Future/Stream | Un tipo de estado sellado expuesto por un provider |
| Donde vive el resultado | En el widget, muere al desmontarse el widget | En un provider, fuera del arbol, sobrevive a la navegacion |
| Compartir entre pantallas | No, cada builder reejecuta su propio trabajo | Si, un provider leido desde muchos widgets |
| Caching / dedup | Ninguno, memoizas el Future tu mismo | Integrado, el provider cachea hasta invalidar |
| Disparo en cada reconstruccion | Si, si el Future se crea en `build` | No, el `build` del provider se ejecuta una vez hasta invalidar |
| Loading + datos previos | Manual, el snapshot pierde `data` mientras espera | `value.isLoading` mantiene `value` durante el refresco |
| Mutaciones / refresco | Reasignar el Future y `setState` | `ref.invalidate` o `AsyncValue.guard` en un notifier |
| Probar sin un widget | Dificil, necesita `pumpWidget` | Facil, lee el provider en un `ProviderContainer` plano |
| Dependencias | Cero, viene con el SDK | Paquete `flutter_riverpod` |
| Lineas de boilerplate para algo unico | Minimas | Mas configuracion para una sola llamada desechable |

## Cuando FutureBuilder o StreamBuilder es la eleccion correcta

Recurre a los builders integrados cuando el resultado asincrono pertenece genuinamente a un widget y nadie mas lo necesita.

- **Un widget hoja autocontenido.** Un dialogo que carga un registro, un tile que resuelve la dimension de una imagen, una fila de ajustes que lee una sola preferencia. El trabajo empieza cuando el widget aparece y es irrelevante una vez que se va. Envolver eso en un provider es ceremonia sin beneficio.
- **Un stream que ya posees y quieres renderizar directamente.** Si tienes un `Stream` de un plugin (un stream de posicion de `Geolocator`, un stream de estado de `connectivity_plus`) y solo lo muestras en un lugar, `StreamBuilder` es el camino mas directo. El `StreamBuilder` de Flutter 3.44 maneja el ciclo de vida de suscripcion/desuscripcion por ti.
- **Cero dependencias agregadas.** Una app pequena, un ejemplo de codigo, un ejemplo de paquete o una pantalla en una base de codigo que ha evitado deliberadamente una biblioteca de gestion de estado. Los builders son parte del SDK, asi que no hay nada que agregar.
- **Estas ensenando o prototipando.** Los builders hacen visible el mapeo de asincrono a UI en un solo lugar. Esa claridad vale mucho cuando el objetivo es entender el ciclo de vida en lugar de entregar una funcionalidad.

Aqui esta la forma correcta. El `Future` se crea una vez en `initState`, no en `build`, asi que el widget no vuelve a hacer fetch en cada reconstruccion del padre.

```dart
// Flutter 3.44, Dart 3.12
class UserCard extends StatefulWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  State<UserCard> createState() => _UserCardState();
}

class _UserCardState extends State<UserCard> {
  late Future<User> _user;

  @override
  void initState() {
    super.initState();
    _user = api.fetchUser(widget.id); // created ONCE, not in build
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _user,
      builder: (context, snapshot) {
        return switch (snapshot) {
          AsyncSnapshot(connectionState: ConnectionState.waiting) =>
            const CircularProgressIndicator(),
          AsyncSnapshot(hasError: true, :final error) =>
            Text('Failed: $error'),
          AsyncSnapshot(hasData: true, :final data?) =>
            Text(data.name),
          _ => const SizedBox.shrink(),
        };
      },
    );
  }
}
```

El bug mas comun con este widget es crear el `Future` en linea, como `future: api.fetchUser(widget.id)` directamente en `build`. Cada reconstruccion entonces asigna un nuevo `Future`, `FutureBuilder` ve una nueva identidad y reinicia desde el estado de loading. Ese modo de fallo es lo bastante comun como para tener su propio articulo: consulta [por que FutureBuilder recrea su Future en cada reconstruccion](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) para la reproduccion completa y todas las variantes que lo disparan.

## Cuando AsyncValue de Riverpod es la eleccion correcta

Pasa a `AsyncValue` cuando el resultado asincrono deja de ser un detalle privado de un widget.

- **El resultado se comparte.** Dos pantallas muestran el mismo perfil de usuario, o un encabezado y un cuerpo leen ambos el carrito actual. Con builders, cada suscriptor reejecuta el fetch. Con un provider, el trabajo se ejecuta una vez y ambos widgets leen el mismo `AsyncValue`.
- **Necesitas caching y dedup.** Riverpod cachea el valor de un provider hasta que algo lo invalida. Navega a otra parte y vuelve, y los datos siguen ahi en lugar de mostrar un spinner. La linea 3.0 incluso agrega `AsyncValue.isFromCache`, asi que la UI puede distinguir los datos del servidor de los datos persistidos offline.
- **Mutas y refrescas.** Un pull-to-refresh, una actualizacion optimista, un reintento. `ref.invalidate(provider)` reejecuta la carga, y durante esa recarga `value.isLoading` es `true` mientras `value.hasValue` se mantiene `true`, asi que sigues mostrando los datos antiguos en lugar de dejar la pantalla en blanco. Hacer eso con `FutureBuilder` significa malabarear un `Future` almacenado, un `setState` y tu propia logica de "mantener los datos previos".
- **Quieres probar sin montar un widget.** La logica de un provider se puede ejercitar en un `ProviderContainer` plano sin `WidgetTester`, sin `pumpWidget` y sin un `BuildContext` falso.

El mismo render de tres estados, ahora con origen en un provider:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.1
final userProvider = FutureProvider.family<User, String>((ref, id) {
  return api.fetchUser(id); // runs once, cached per id, shared everywhere
});

class UserCard extends ConsumerWidget {
  const UserCard({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider(id));
    return switch (user) {
      AsyncData(:final value) => Text(value.name),
      AsyncError(:final error) => Text('Failed: $error'),
      _ => const CircularProgressIndicator(),
    };
  }
}
```

Dos widgets que llaman a `ref.watch(userProvider('42'))` comparten un fetch y un resultado cacheado. No hay `initState`, ni campo almacenado, ni disciplina de "crear el Future una vez" que recordar, porque el provider ya ejecuta su `build` exactamente una vez por argumento hasta que se invalida. Para el conjunto completo de estados, mutaciones con `AsyncValue.guard` y mantener los datos previos al refrescar, consulta [como mostrar estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## El comportamiento de reconstruccion y refetch que en realidad decide

El rendimiento no es el eje aqui. Ambos enfoques renderizan a la misma tasa de frames. Lo que difiere es cuantas veces se ejecuta tu trabajo asincrono, y eso es un problema de correccion y de costo, no de velocidad bruta.

Pon un contador dentro de la llamada asincrona y observa que pasa cuando el widget circundante se reconstruye (un cambio de tema, un teclado que se abre, un `setState` del padre):

- **Future creado en `build` con FutureBuilder**: el fetch se dispara en cada reconstruccion. Una pantalla que se reconstruye diez veces durante un scroll hace diez llamadas de red. Este es el error por defecto, no un caso limite.
- **Future elevado a `initState` con FutureBuilder**: el fetch se dispara una vez por instancia de widget. Navega a otra parte y vuelve, el widget se reconstruye desde cero y vuelve a hacer fetch porque el viejo `State` ya no existe.
- **FutureProvider con AsyncValue**: el fetch se dispara una vez por argumento de provider y se cachea. Las reconstrucciones no lo reejecutan. Navegar a otra parte y volver lee la cache. Solo se reejecuta cuando lo invalidas o cambian sus dependencias.

Si tu trabajo asincrono es una lectura local barata, nada de esto importa y el builder gana en simplicidad. Si es una llamada de red, una consulta a base de datos o cualquier cosa con un costo o un limite de tasa, el caching es la razon completa por la que existe `AsyncValue`, y reimplementar el mismo comportamiento a mano alrededor de `FutureBuilder` reimplementa una version peor de la cache de provider de Riverpod.

## El punto delicado que decide por ti

Algunas restricciones zanjan la decision sin importar el gusto.

**Ya estas usando Riverpod.** Si la app tiene providers, no mezcles `FutureBuilder` en una pantalla que los lee. Leer los datos de un provider y luego envolver un segundo `FutureBuilder` alrededor de otra llamada asincrona te da dos ciclos de vida no relacionados en una pantalla y dos lugares donde "loading" puede ser true. Expon la segunda llamada como un provider tambien y renderiza ambos con `AsyncValue`. La consistencia aqui previene la clase de bug donde una mitad de la pantalla queda desactualizada.

**El resultado debe sobrevivir al widget.** Cualquier cosa traida en `initState` muere con el `State`. Si el usuario navega hacia adelante y vuelve y no quieres un spinner nuevo y una llamada de red nueva cada vez, necesitas una cache que viva por encima del widget. Eso es un provider. `FutureBuilder` no puede darte persistencia entre rutas sin importar como lo organices.

**Tocas `ref` despues de un await.** Esta es una trampa especifica de Riverpod, no una razon para evitarlo: si haces `await` dentro de un notifier y luego lees `ref` despues de que el widget que lo disparo ya no existe, te encuentras con `Cannot use "ref" after the widget was disposed`. La solucion es capturar lo que necesitas antes del await. Vale la pena saberlo antes de comprometerte, y se cubre en [la solucion para usar ref despues de la disposicion](/es/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/).

**Quieres explicitamente cero dependencias.** Un ejemplo de paquete pub, un caso de reproduccion o una politica de equipo contra las bibliotecas de gestion de estado fuerza los builders. Esa es una restriccion legitima, y los builders son perfectamente capaces para UI asincrona autocontenida.

## StreamBuilder tiene un matiz extra

Todo lo anterior aplica al trabajo con `Future`. Los streams agregan un ciclo de vida de suscripcion, y eso inclina la decision un poco mas hacia Riverpod para cualquier cosa no trivial. `StreamBuilder` se resuscribe cuando le pasas una nueva instancia de `Stream` y se desuscribe cuando sale del arbol, pero no hace multicast: dos `StreamBuilder` sobre el mismo stream de suscripcion unica lanzaran un error, porque un `Stream` de suscripcion unica permite solo un listener. El `StreamProvider` de Riverpod se sienta delante del stream, asi que multiples widgets leen un `AsyncValue` sin pelear por la suscripcion, y el ultimo valor se cachea para los suscriptores tardios. Si un stream se muestra en exactamente un lugar, `StreamBuilder` esta bien. Si mas de un widget lo necesita, `StreamProvider` elimina el problema del listener unico por completo.

## La recomendacion, con todo el contexto detras

Por defecto, usa `AsyncValue` de Riverpod para cualquier resultado asincrono que se comparta, se cachee, se refresque o se mute, que en una app real es la mayoria de ellos. Obtienes un fetch en lugar de N, caching gratis entre navegaciones, un `isLoading` que preserva los datos previos al refrescar y logica que puedes probar sin un widget. Conserva `FutureBuilder` y `StreamBuilder` para UI asincrona genuinamente autocontenida y desechable: un widget hoja que carga una cosa, la muestra y la olvida al desmontarse, especialmente en apps que no cargan ninguna dependencia de gestion de estado. Los builders no son rueditas de entrenamiento que superas. Son la herramienta correcta cuando el resultado asincrono tiene una audiencia de uno, y la herramienta incorrecta en el momento en que tiene una audiencia de dos. Elige por propiedad, no por familiaridad.

Si todavia estas eligiendo un enfoque de gestion de estado de forma mas amplia, las compensaciones entre paquetes estan en [Provider vs Riverpod vs Bloc para gestion de estado en Flutter en 2026](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/). Y si tu UI asincrona sigue mostrando fallos, [como manejar errores de red con elegancia en una app Flutter](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) cubre como convertir excepciones lanzadas en un estado de error limpio en ambos modelos.

## Fuentes

- [Clase FutureBuilder, documentacion de la API de Flutter](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [Clase StreamBuilder, documentacion de la API de Flutter](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
- [Clase AsyncValue, documentacion de la API de flutter_riverpod](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/AsyncValue-class.html)
- [Novedades en Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [Changelog de riverpod en pub.dev](https://pub.dev/packages/riverpod/changelog)

---
title: "go_router vs auto_route vs Navigator 2.0 en Flutter"
description: "go_router y auto_route se apoyan ambos sobre Navigator 2.0, así que la verdadera elección es enrutamiento declarativo por URL vs rutas tipadas generadas por código vs escribir a mano la API Router. Una matriz de decisión con la configuración de cada uno, y cuándo el Navigator puro sigue ganando."
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "auto-route"
  - "navigation"
lang: "es"
translationOf: "2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

Respuesta corta: para la mayoría de las aplicaciones de Flutter en 2026, usa `go_router`. Lo mantiene el equipo de Flutter, es la opción a la que te apunta la documentación oficial, y convierte URLs en pantallas con la menor ceremonia. Recurre a `auto_route` cuando quieras llamadas de navegación fuertemente tipadas y verificadas en tiempo de compilación, y estés dispuesto a ejecutar un generador de código para conseguirlas. Baja al Navigator 2.0 puro (implementando tú mismo `RouterDelegate` y `RouteInformationParser`) solo cuando tengas un modelo de navegación genuinamente inusual que ninguno de los dos paquetes exprese, porque te estás comprometiendo a mucho código repetitivo. Y si tu aplicación es pequeña y no tiene requisitos de deep links ni de URLs web, el `Navigator.push` imperativo simple sigue siendo una respuesta perfectamente buena.

Lo que casi todo el mundo entiende mal en esta comparación es tratar los tres como opciones paralelas. No lo son. "Navigator 2.0" es la API `Router` del framework de Flutter, y tanto `go_router` como `auto_route` están construidos sobre ella. Así que la decisión no es "paquete A vs paquete B vs el framework"; es "en qué capa quiero escribir mi enrutamiento". Este artículo usa `go_router` 17.3.0, `auto_route` 11.1.0, Flutter 3.44 estable y Dart 3.x.

## El pastel de capas: qué es realmente "Navigator 2.0"

Flutter tiene dos APIs de navegación conviviendo lado a lado.

Navigator 1.0 es la imperativa que ya conoces: `Navigator.of(context).push(MaterialPageRoute(...))` y `Navigator.pop(context)`. Apilas y desapilas pantallas como una pila. Es simple y funciona, y para una aplicación pequeña es todo lo que necesitas.

Navigator 2.0, llamado con más precisión la API `Router`, es declarativo. En lugar de apilar imperativamente, le das al framework una lista de objetos `Page` que describen toda la pila, y cuando el estado de tu aplicación cambia le entregas una lista nueva. Dos piezas la hacen funcionar: un `RouteInformationParser` que convierte una URL entrante (`RouteInformation`) en tu propio tipo de datos específico de la aplicación, y un `RouterDelegate` que lee esos datos más el estado de tu aplicación y construye el `Navigator` con las `pages` correctas. La [documentación oficial de navegación y enrutamiento](https://docs.flutter.dev/ui/navigation) describe exactamente esta división.

El truco es que escribir a mano un `RouterDelegate` y un `RouteInformationParser` correctos es mucho trabajo. Eres responsable de parsear rutas, mantener la lista de páginas, manejar el botón de retroceso del sistema, sincronizar las URLs del navegador y restaurar deep links. La documentación de Flutter es directa al respecto:

> Si prefieres no usar un paquete de enrutamiento y te gustaría tener control total sobre la navegación y el enrutamiento en tu aplicación, sobrescribe `RouteInformationParser` y `RouterDelegate`.

Ese "si prefieres control total" es la señal. Para todos los demás, un paquete de enrutamiento envuelve esa maquinaria. `go_router` y `auto_route` son ambos ese envoltorio. Consumen Navigator 2.0; no compiten con él. Así que cuando alguien pregunta "¿go_router o Navigator 2.0?", la respuesta honesta es que go_router *es* Navigator 2.0 con el código repetitivo ya escrito por ti.

## Para qué optimiza go_router: las URLs como fuente de verdad

`go_router` lo publica el publicador verificado `flutter.dev` y lo [mantiene el equipo de Flutter](https://pub.dev/packages/go_router). Su modelo es primero-la-URL: declaras una tabla de rutas con patrones de path, y navegar es cuestión de ir a un path. Los deep links, las URLs web y la navegación dentro de la aplicación se resuelven todos a través de la misma tabla, y por eso un deep link y un toque de botón aterrizan en la misma pantalla.

Una configuración mínima:

```dart
// Flutter 3.44, go_router 17.3.0
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'orders/:id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) =>
      MaterialApp.router(routerConfig: router);
}
```

Navegar es una cadena:

```dart
// go_router 17.3.0 - navigate by URL
context.go('/orders/42');   // replace the stack, land on order 42
context.push('/orders/42'); // push on top of the current stack
```

La fortaleza aquí es también el filo peligroso: los destinos de navegación son cadenas. `context.go('/orders/42')` no lo verifica el compilador. Si te equivocas al teclear el path o renombras una ruta, te enteras en runtime. `go_router` tiene una respuesta, [rutas tipadas mediante `go_router_builder`](https://pub.dev/packages/go_router_builder), que genera clases `GoRouteData` tipadas para que puedas llamar a `OrderRoute(id: 42).go(context)` en su lugar. Pero eso es generación de código opcional atornillada sobre un paquete cuyo modismo por defecto son las cadenas, y en la práctica muchas bases de código de go_router nunca lo activan.

`go_router` también posee las dos características por las que la gente realmente lo adopta. `ShellRoute` y `StatefulShellRoute.indexedStack` te dan una carcasa persistente (una barra de navegación inferior que sobrevive a los cambios de pestaña), y un callback `redirect` de nivel superior maneja el control de acceso (auth gating) para todo el árbol. Si quieres el recorrido completo de carcasas y la configuración de deep links, mira [cómo configurar rutas anidadas y deep links con go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/).

Una nota de estado que importa para una decisión de varios años: el equipo de Flutter lista `go_router` como feature-complete. Su [declaración de hoja de ruta](https://pub.dev/packages/go_router) dice:

> Este paquete se considera feature-complete. El foco principal del equipo de Flutter será atender correcciones de errores y asegurar la estabilidad.

Léelo como estabilidad, no como abandono. Significa que la API que aprendes hoy es poco probable que cambie bajo tus pies, y las correcciones de errores siguen llegando. También significa que las capacidades nuevas grandes es más probable que lleguen como paquetes de la comunidad que como características centrales de go_router.

## Para qué optimiza auto_route: rutas tipadas desde la generación de código

`auto_route` 11.1.0 es un paquete de la comunidad de Milad Akarie. Ataca la debilidad exacta del comportamiento por defecto de go_router: la navegación tipada como cadenas. Anotas cada página con `@RoutePage()`, ejecutas `build_runner`, y genera una ruta fuertemente tipada para cada pantalla. Las llamadas de navegación quedan entonces verificadas por el compilador y sus argumentos son tipados.

```dart
// Flutter 3.44, auto_route 11.1.0
@RoutePage()
class OrderScreen extends StatelessWidget {
  const OrderScreen({super.key, required this.orderId});
  final int orderId; // a real int, not a string yanked from a path

  @override
  Widget build(BuildContext context) => const Placeholder();
}

@AutoRouterConfig()
class AppRouter extends RootStackRouter {
  @override
  List<AutoRoute> get routes => [
        AutoRoute(page: HomeRoute.page, initial: true),
        AutoRoute(page: OrderRoute.page, path: '/orders/:id'),
      ];
}
```

Después de `dart run build_runner build`, la navegación queda tipada de punta a punta:

```dart
// auto_route 11.1.0 - typed navigation, checked by the compiler
context.router.push(OrderRoute(orderId: 42)); // orderId is an int
```

Renombra `orderId`, cambia su tipo, o elimina la ruta, y el código que navega hacia ella deja de compilar. Ese es todo el argumento de venta, y para una aplicación grande con decenas de pantallas y argumentos no triviales es una diferencia de productividad real y diaria. Nunca serializas un objeto en una query string para volver a parsearlo a mano.

`auto_route` también trae equivalentes de primera clase de las características de go_router. La navegación anidada usa un widget `AutoRouter` como salida para las rutas hijas; la navegación con pestañas usa [`AutoTabsRouter`](https://pub.dev/packages/auto_route), que preserva el estado de las pestañas fuera de pantalla igual que `StatefulShellRoute`. El control de acceso usa guardias: extiendes `AutoRouteGuard`, implementas `onNavigation`, y adjuntas la guardia por ruta o globalmente.

```dart
// auto_route 11.1.0 - a route guard
class AuthGuard extends AutoRouteGuard {
  @override
  void onNavigation(NavigationResolver resolver, StackRouter router) {
    if (isSignedIn) {
      resolver.next(true);
    } else {
      router.push(const LoginRoute());
    }
  }
}
```

El costo es el generador de código. Agregas `auto_route_generator` y `build_runner` como dependencias de desarrollo, y cada vez que agregas o cambias un `@RoutePage` regeneras. En desarrollo activo ejecutas `build_runner watch`. Ese es un impuesto real: compilaciones en frío más lentas, un archivo `.gr.dart` generado en tu árbol, y la necesidad ocasional de borrar la salida generada y volver a compilar cuando las cosas se desincronizan. Si la navegación tipada vale un paso de generación de código es el intercambio central de toda esta comparación.

## La decisión, como una matriz

| Cuestión | go_router 17.3.0 | auto_route 11.1.0 | Navigator 2.0 puro |
| --- | --- | --- | --- |
| Mantenedor | Equipo de Flutter (flutter.dev) | Comunidad (Milad Akarie) | Framework de Flutter |
| Llamadas de navegación | Cadenas (`context.go('/x')`), tipado opcional vía builder | Tipadas, verificadas por el compilador por defecto | Lo defines tú |
| Generación de código | No (opcional para rutas tipadas) | Sí (`build_runner`) | No |
| Deep links / URLs web | Incorporado | Incorporado | Lo implementas tú |
| Carcasa persistente / pestañas | `StatefulShellRoute` | `AutoTabsRouter` | Lo implementas tú |
| Control de acceso | callback `redirect` | `AutoRouteGuard` | Lo implementas tú |
| Código repetitivo | Bajo | De bajo a medio (más archivos generados) | Alto |
| Mejor cuando | La mayoría de las aplicaciones; web; deep links | Aplicación grande, muchos argumentos tipados, te gusta el codegen | Modelo de navegación verdaderamente a medida |

Las filas que deberían guiar tu elección son "llamadas de navegación" y "generación de código". Si la navegación verificada en tiempo de compilación importa lo suficiente como para justificar un paso de compilación, `auto_route`. Si prefieres no ejecutar un generador y estás cómodo con paths en forma de cadena (o te sumarás a `go_router_builder` más adelante), `go_router`. Todo lo demás, ambos paquetes lo hacen competentemente.

## Cuándo el Navigator 2.0 puro es la decisión correcta (rara vez)

No recurras a un `RouterDelegate` escrito a mano solo para sentirte en control. Las situaciones donde genuinamente vale la pena son estrechas:

- Tu estado de navegación no mapea a un árbol de URLs en absoluto. Piensa en un editor de grafos de nodos, un asistente cuya pila se computa a partir de una máquina de estados, o una aplicación donde "la pila" es una proyección de alguna otra estructura de datos. Las tablas de rutas de los paquetes asumen un árbol de paths; si tu modelo no es eso, puede que pelees más con el paquete que con el framework.
- Estás construyendo tu propio paquete de enrutamiento o una abstracción a nivel de framework y necesitas los primitivos directamente.
- Necesitas comportamiento a nivel de `Page`/`Navigator.pages` que ninguno de los dos paquetes expone.

Para esos casos, la API pura te da control total sobre la `List<Page>` y el ciclo de parseo-y-restauración. Para todo lo demás, el código repetitivo que escribirías es código repetitivo que los paquetes ya escribieron, probaron y distribuyen. La guía de la documentación de Flutter es inequívoca: las aplicaciones con necesidades de navegación avanzadas "deberían usar un paquete de enrutamiento como go_router", y la API pura se presenta como la vía de escape para quienes explícitamente quieren control total.

## No lo olvides: para una aplicación pequeña, Navigator 1.0 sigue estando bien

Hay un modo de fallo donde una aplicación de cinco pantallas adopta un paquete de enrutamiento, un generador de código y una abstracción de tabla de rutas que nunca necesitó. Si tu aplicación no tiene destino web, ni deep links, ni requisito de reconstruir una pantalla desde una URL, la navegación imperativa no es un error heredado, es la herramienta del tamaño correcto:

```dart
// Flutter 3.44 - imperative navigation, still correct for simple apps
Navigator.of(context).push(
  MaterialPageRoute<void>(
    builder: (context) => const SecondScreen(),
  ),
);
```

La documentación oficial bendice esto explícitamente para "aplicaciones pequeñas sin deep linking complejo". En el momento en que agregas una compilación web, enlaces compartibles, o una barra de navegación inferior que debe sobrevivir a los cambios de pestaña, muévete a `go_router` o `auto_route`. No antes.

## Los tropiezos que te entrega cada elección

Algunas cosas muerden a la gente después de haberse comprometido:

- **go_router: las cadenas no se verifican.** Renombrar un path es una rotura silenciosa hasta que te topas con ella en runtime. O adoptas `go_router_builder` para rutas tipadas temprano, o mantienes cada path en un único archivo de constantes y nunca insertas una cadena en crudo.
- **go_router: `context` después de un await.** La navegación declarativa no te exime del lint `use_build_context_synchronously`. Navegar con un `BuildContext` obsoleto después de un hueco `async` es el mismo error que siempre fue; mira [cómo usar BuildContext de forma segura después de un await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- **auto_route: desfase de archivos generados.** Después de un merge desordenado o una subida de versión del SDK de Dart, el `.gr.dart` generado puede quedar obsoleto y producir errores desconcertantes. La solución es casi siempre `dart run build_runner build --delete-conflicting-outputs`, no quedarse mirando el diff.
- **auto_route: otra herramienta de codegen en tu pipeline.** Si ya ejecutas Freezed, json_serializable, o el generador de Riverpod, `auto_route` es una cosa más que debe mantenerse en sincronía. En CI, un paso de `build_runner` olvidado hace fallar la compilación, no tu máquina.
- **Ambos: los deep links todavía necesitan configuración nativa.** Ninguno de los dos paquetes puede hacer que Android e iOS le entreguen una URL a Flutter por sí solo. Todavía editas `AndroidManifest.xml` y los entitlements de iOS para registrar tu esquema o app links. El paquete resuelve la URL una vez que llega; lograr que llegue es trabajo de plataforma.
- **Migrar entre ellos no es gratis.** Las tablas de rutas de go_router y las clases anotadas de auto_route son estructuralmente diferentes. Cambiar a mitad de proyecto significa reescribir la capa de rutas, así que elige con el horizonte de dos años en mente, no este sprint.

Si todavía estás decidiendo tu stack más amplio en lugar de solo el enrutamiento, la misma tensión de "oficial-y-aburrido vs rico-en-características-de-la-comunidad" aparece también en la gestión de estado, que recorro en [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/), y en la propia elección de plataforma en [Flutter vs React Native vs MAUI](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/).

El resumen que sobrevive al contacto con un proyecto real: `go_router` es la opción por defecto porque es oficial, estable y nativo de URLs. `auto_route` se gana su lugar en aplicaciones grandes donde la navegación verificada en tiempo de compilación vale un generador de código. El Navigator 2.0 puro es para la rara aplicación cuyo modelo de navegación no encaja en una tabla de rutas. Y el `Navigator.push` simple sigue siendo la respuesta correcta para una aplicación pequeña que no necesita nada de esto. Elige la capa más baja que resuelva tu problema real, no la más potente.

## Relacionados

- [How to set up nested routes and deep links with go_router in Flutter](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [How to use BuildContext safely after an await in Flutter](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Flutter vs React Native vs MAUI for a new mobile project in 2026](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)
- [Migrate a Flutter 2 app to Flutter 3.x: null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Fuentes

- [Navigation and routing - Flutter docs](https://docs.flutter.dev/ui/navigation)
- [go_router - pub.dev (maintained by flutter.dev)](https://pub.dev/packages/go_router)
- [go_router_builder - pub.dev](https://pub.dev/packages/go_router_builder)
- [auto_route - pub.dev](https://pub.dev/packages/auto_route)
- [auto_route_library - Milad-Akarie on GitHub](https://github.com/Milad-Akarie/auto_route_library)

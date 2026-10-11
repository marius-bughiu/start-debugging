---
title: "Cómo mantener la pestaña seleccionada de NavigationBar sincronizada con la ruta actual usando StatefulShellRoute en go_router"
description: "Controla NavigationBar.selectedIndex desde StatefulNavigationShell.currentIndex, nunca desde un campo de setState ni desde una copia hecha en initState. Medido en Flutter 3.44.8 y go_router 18.0.2: qué patrones se desincronizan con deep links, context.go y push entre ramas, por qué los índices basados en la ubicación mienten y cómo reaccionar a los cambios de pestaña con didUpdateWidget."
pubDate: 2026-10-11
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
  - "how-to"
lang: "es"
translationOf: "2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Respuesta corta:** no guardes tú mismo la pestaña seleccionada. Dentro de un `StatefulShellRoute`, go_router ya sabe qué rama está activa y te la entrega como `navigationShell.currentIndex`. Pásalo directamente a `NavigationBar.selectedIndex` en cada compilación del widget y cambia de pestaña con `navigationShell.goBranch(index)`. Un campo `_selectedIndex` actualizado en `onDestinationSelected`, o una copia de `currentIndex` tomada en `initState`, solo cambia cuando el usuario toca la barra, así que queda desactualizado en cuanto un deep link, un `context.go` desde dentro de una página o un manejador de notificaciones cambia la ruta. Todo lo que sigue se ejecutó con `flutter test` en Flutter 3.44.8 (Dart 3.12.2) y go_router 18.0.2, la última versión a octubre de 2026.

El reporte de error suele sonar así: "abro la app desde un enlace a `/profile` y la barra sigue resaltando Home", o "un botón de la página Orders lleva al usuario a Settings, se muestra la página Settings, pero la barra sigue diciendo Orders". La página es correcta y la barra es incorrecta, porque dos fuentes de verdad no coinciden: la ubicación del router y un fragmento de estado del widget que solo actualiza la propia barra.

## Por qué la barra y la ruta se desincronizan

Un `NavigationBar` es un widget sin lógica propia. Dibuja el `selectedIndex` que le des y llama a `onDestinationSelected` cuando el usuario toca. No sabe que existe un router. Si guardas el índice en un `StatefulWidget`, el único camino de código que lo actualiza es el manejador del toque, y los toques son solo una de las muchas maneras en que cambia la ruta:

- la app arranca con un deep link o un `initialLocation` que apunta a la segunda pestaña
- una página llama a `context.go('/profile/settings')` (un enlace "ver todo", una redirección posterior al inicio de sesión, un manejador de notificaciones push)
- un `redirect` envía al usuario a otro lugar
- el botón de retroceso del navegador en Flutter web, o la restauración de estado después de que el sistema operativo terminó el proceso

Ninguna de estas toca tu campo `_selectedIndex`. El router reconstruye el shell con la nueva rama, tu scaffold se reconstruye con el valor antiguo de su campo y la barra miente.

go_router resuelve esto por ti, siempre que lo dejes. Cuando construye un `StatefulShellRoute`, crea un `StatefulNavigationShell` y calcula `currentIndex` en el constructor a partir de la clave del navegador de la rama que coincidió con la ubicación actual (consulta `route.dart` en el código fuente de go_router, `_indexOfBranchNavigatorKey`). Se crea un nuevo widget shell en cada cambio de ruta, así que `currentIndex` es siempre la respuesta del propio router a "qué rama se está mostrando ahora mismo".

## Una app mínima que reproduce la desincronización

Dos ramas, Orders y Profile. La página Orders tiene un botón que salta directamente a la rama Profile, justo el tipo de navegación dentro de una página que rompe un índice hecho a mano:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
final router = GoRouter(
  initialLocation: '/orders',
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) =>
          AppScaffold(navigationShell: navigationShell),
      branches: [
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/orders',
            builder: (context, state) => const OrdersPage(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) =>
                    OrderPage(id: state.pathParameters['id']!),
              ),
            ],
          ),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/profile',
            builder: (context, state) => const ProfilePage(),
            routes: [
              GoRoute(
                path: 'settings',
                builder: (context, state) => const SettingsPage(),
              ),
            ],
          ),
        ]),
      ],
    ),
  ],
);
```

Y el scaffold que la mayoría escribe primero, porque así se ve cada ejemplo de `NavigationBar` sin router:

```dart
// Flutter 3.44.8, go_router 18.0.2 -- DRIFTS, do not copy
class AppScaffold extends StatefulWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  @override
  State<AppScaffold> createState() => _AppScaffoldState();
}

class _AppScaffoldState extends State<AppScaffold> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: widget.navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) {
          setState(() => _selectedIndex = index);
          widget.navigationShell.goBranch(index);
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

Una variante algo más astuta inicializa el campo desde el shell (`_selectedIndex = widget.navigationShell.currentIndex;` en `initState`). Eso arregla el arranque en frío y nada más. `StatefulNavigationShell` lleva una clave estable por cada shell route, y tu scaffold está en la misma posición del árbol con el mismo tipo, así que Flutter conserva su `State` entre cambios de ruta. `initState` se ejecuta una vez por sesión de la app, no una vez por navegación.

## Qué muestra realmente cada patrón

Probé todos con tests de widgets (`tester.tap`, `GoRouter.go`, `GoRouter.push`) y leí `NavigationBar.selectedIndex` después de `pumpAndSettle`. "Correcto" es la pestaña cuya rama contiene la página visible.

| Escenario | Página mostrada | Campo con `setState` | Copia en `initState` | `navigationShell.currentIndex` |
| --- | --- | --- | --- | --- |
| Arranque en frío en `/profile` | Profile | 0 (incorrecto) | 1 | 1 |
| `context.go('/profile/settings')` desde Orders | Settings | 0 (incorrecto) | 0 (incorrecto) | 1 |
| `router.go('/profile')` desde fuera del árbol de widgets | Profile | 0 (incorrecto) | 0 (incorrecto) | 1 |
| `context.go('/orders/42')` desde Profile | Order 42 | 0 | 1 (incorrecto) | 0 |
| El usuario toca Profile y luego Orders | Profile, Orders | 1, 0 | 1, 0 | 1, 0 |

Solo la última fila, la que todo desarrollador prueba a mano, funciona con los tres. El índice del shell fue correcto en todos los escenarios.

## La solución: leer currentIndex en cada compilación

El scaffold correcto no tiene estado. No tiene nada que guardar, porque lo guarda el router:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class AppScaffold extends StatelessWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  void _onTap(int index) {
    navigationShell.goBranch(
      index,
      // Tapping the tab you are already on pops that branch back to its root.
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: _onTap,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

Los pasos, en orden:

1. Haz que el scaffold del shell reciba el `StatefulNavigationShell` desde el builder de `StatefulShellRoute` y lo muestre como `body`.
2. Asigna `navigationShell.currentIndex` a `NavigationBar.selectedIndex`. Elimina cualquier campo `_selectedIndex` y todos los `setState` que lo tocaban.
3. En `onDestinationSelected`, llama a `navigationShell.goBranch(index)`. No llames a `context.go('/profile')` para cambiar de pestaña: funciona, pero descarta la pila guardada de esa rama en lugar de restaurarla.
4. Pasa `initialLocation: index == navigationShell.currentIndex` para que un segundo toque en la pestaña activa la devuelva a la raíz de la rama, que es el comportamiento que esperan los usuarios de iOS y Android.
5. Si el mismo scaffold muestra un `NavigationRail` en pantallas anchas, aliméntalo con el mismo `currentIndex`. Una sola fuente, dos widgets, ningún código de sincronización.

No hay un paso de "actualizar la barra cuando cambia la ruta". Un toque llama a `goBranch`, el router cambia la ubicación, go_router construye un nuevo shell con un nuevo `currentIndex` y la barra lo sigue. El toque ni siquiera necesita reconstruir nada localmente.

La guía de 2026/06 sobre [rutas anidadas y deep links con go_router](/es/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) muestra esta misma conexión como parte de una configuración completa de shell. Esta publicación trata de por qué fallan los atajos para evitarla.

## Reaccionar a los cambios de pestaña sin guardar el índice

A veces sí necesitas saber cuándo cambió la pestaña: registrar la vista de una pantalla, pausar un video en la pestaña que dejaste, devolver una lista al inicio. La tentación es recuperar el campo `_selectedIndex` "solo para eso". No lo necesitas. Vuelve a hacer del scaffold un `StatefulWidget`, pero compara el shell anterior y el nuevo en `didUpdateWidget`:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class _AppScaffoldState extends State<AppScaffold> {
  @override
  void didUpdateWidget(AppScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    final from = oldWidget.navigationShell.currentIndex;
    final to = widget.navigationShell.currentIndex;
    if (from != to) {
      analytics.logTabChange(from: from, to: to);
    }
  }

  @override
  Widget build(BuildContext context) {
    // selectedIndex still comes from widget.navigationShell.currentIndex
    return Scaffold(body: widget.navigationShell /* , bottomNavigationBar: ... */);
  }
}
```

Con `router.go('/profile')` y luego `router.go('/orders')`, esto registró `initState 0`, `tab changed 0 -> 1`, `tab changed 1 -> 0`. Se dispara con toques, deep links y navegación programática por igual, porque observa la respuesta del router y no la entrada de la barra. Mantén el trabajo en `didUpdateWidget` barato y libre de navegación: llamar a `goBranch` desde dentro de un callback de la fase de compilación es una buena forma de provocar [setState() or markNeedsBuild() called during build](/es/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

## Casos límite y trampas

### Derivar el índice de la ubicación miente tras un push entre ramas

El otro patrón común, heredado de `ShellRoute` simple, es calcular el índice a partir de la URL: `state.uri.path.startsWith('/profile') ? 1 : 0`. Sobrevive a los deep links y a `context.go`, por eso la gente confía en él. Falla con `push`.

Cuando la página Profile llama a `context.push('/orders/42')`, go_router 18.0.2 empuja la página del pedido al navegador de la rama *actual*. Lo comprobé en un test: la página empujada queda dentro del scaffold del shell, `currentIndex` se mantiene en 1 y, tras cambiar a Orders y volver a Profile, la pestaña Profile sigue mostrando Order 42 encima de su pila. Sin embargo, la ubicación ahora es `/orders/42`, así que la barra derivada de la ubicación resalta Orders mientras el usuario está dentro de la pila de Profile. Toca Orders y obtienes la rama Orders, no la página que estabas viendo. `currentIndex` informó 1 todo el tiempo, lo que coincide con dónde vive realmente la página.

Si quieres que el detalle de un pedido se abra bajo la pestaña Orders, usa `context.go('/orders/42')` (cambia de rama y `currentIndex` pasa a 0). Si quieres que quede encima de la pestaña actual, `push` está bien. En cualquier caso, deja que `currentIndex` decida qué pestaña se ilumina.

### ShellRoute simple no tiene currentIndex

Un `ShellRoute` sin estado te da un único navegador anidado y un `child`, sin ramas ni índice. Ahí tienes que mapear la ubicación a la pestaña tú mismo. Hazlo desde el `GoRouterState` del builder (o `GoRouterState.of(context)`) y compara con `uri.path`, no con `matchedLocation`. En mi test, tras `push('/orders/7')` desde `/profile`, el estado del shell informó `uri=/orders/7`, `fullPath=/orders/:id` y `matchedLocation=/profile`. Se aplica la misma advertencia sobre push de la sección anterior, y es una razón más para mover los diseños con pestañas a `StatefulShellRoute.indexedStack` si además quieres que cada pestaña conserve su propia pila de retroceso (la [comparación de go_router vs auto_route vs Navigator 2.0](/es/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) cubre lo que ofrece cada router para pestañas).

### Rutas de pantalla completa en el navegador raíz

Un checkout o un visor de medios suele vivir bajo la ruta de una rama pero debe cubrir la barra, así que se declara con `parentNavigatorKey: rootNavigatorKey`. Al empujarlo desde Profile, `currentIndex` quedó en 1 sin ningún scaffold en escena, y al cerrarlo se volvió a Profile con la pestaña correcta iluminada. Al ir directamente con `router.go('/orders/checkout')`, se construyó el shell debajo con `currentIndex` 0, porque la ruta pertenece a la rama Orders. En ambos casos la barra es correcta cuando reaparece, sin código adicional.

### Una rama sin destino en la barra

Es común tener una rama accesible solo por enlace, por ejemplo una rama Inbox que se abre desde una notificación, sin ícono en la barra. Entonces `currentIndex` será 2 con dos destinos, y `NavigationBar` lanza una aserción sobre `0 <= selectedIndex && selectedIndex < destinations.length` en compilaciones de depuración. Mapea las ramas a los destinos explícitamente en lugar de pasar el índice tal cual:

```dart
// Flutter 3.44.8, go_router 18.0.2
// Branch order: 0 orders, 1 profile, 2 inbox (no bar destination).
const _branchForDestination = [0, 1];

int _destinationFor(int branch) {
  final i = _branchForDestination.indexOf(branch);
  return i == -1 ? 0 : i; // NavigationBar cannot show "nothing selected"
}

NavigationBar(
  selectedIndex: _destinationFor(navigationShell.currentIndex),
  onDestinationSelected: (i) =>
      navigationShell.goBranch(_branchForDestination[i]),
  destinations: const [ /* Orders, Profile */ ],
);
```

`NavigationRail.selectedIndex` admite valores nulos, así que en un rail puedes devolver `null` y no mostrar ninguna selección para las ramas ocultas.

### Reordenar u ocultar pestañas en tiempo de ejecución

Si los destinos cambian según un feature flag o el rol del usuario, la lista de ramas del router normalmente no cambia. Mantén fijos los índices de las ramas y reasígnalos mediante una tabla como la anterior. Cambiar las ramas mismas sobre la marcha implica una nueva configuración del router, y el changelog de go_router 18.0.2 menciona una corrección para rutas empujadas dentro de un shell que se perdían cuando cambia una configuración de enrutamiento dinámica, así que quédate en 18.0.2 o posterior si haces eso.

### Probar la sincronización

Cada escenario de la tabla anterior es un test de widget barato. Construye un `MaterialApp.router` con tu router real, arráncalo en un deep link con `initialLocation`, llama a `router.go(...)` desde el test y verifica `tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex`. Si tus pestañas muestran contenido dependiente del tiempo, combínalo con el enfoque de [probar un widget de Flutter en un punto fijo en el tiempo](/es/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) para que las verificaciones sean deterministas. Un test por cada punto de entrada de navegación (deep link, `go` dentro de una página, manejador de notificaciones) detecta la desincronización antes que un usuario.

## La regla general

Si te encuentras escribiendo `setState` junto a un `NavigationBar` dentro de un shell de go_router, detente. El router es dueño de la ubicación, la ubicación decide la rama y `StatefulNavigationShell.currentIndex` es esa decisión. Léelo, nunca lo copies, y la barra no podrá desincronizarse sin importar cómo llegó el usuario hasta allí.

## Fuentes

- [go_router 18.0.2 en pub.dev](https://pub.dev/packages/go_router) y su [changelog](https://pub.dev/packages/go_router/changelog)
- [API de la clase StatefulShellRoute](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [API de la clase StatefulNavigationShell](https://pub.dev/documentation/go_router/latest/go_router/StatefulNavigationShell-class.html) (`currentIndex`, `goBranch`)
- [Código fuente de go_router: `lib/src/route.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/route.dart)
- [Ejemplo oficial de StatefulShellRoute](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/stateful_shell_route.dart)
- [API de la clase NavigationBar](https://api.flutter.dev/flutter/material/NavigationBar-class.html)

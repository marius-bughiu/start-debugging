---
title: "Cómo configurar rutas anidadas y deep links con go_router en Flutter"
description: "Construye un shell persistente con rutas anidadas usando ShellRoute y StatefulShellRoute, y luego configura deep links basados en rutas que reconstruyen toda la pila de páginas. Configuración completa para Android e iOS, más los problemas que rompen la pila de retroceso."
pubDate: 2026-06-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
lang: "es"
translationOf: "2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

Para anidar rutas en Flutter con `go_router`, coloca las rutas hijas en la lista `routes:` de una `GoRoute` padre para que la URL construya una pila de páginas, y envuelve un grupo de rutas en un `ShellRoute` (o `StatefulShellRoute.indexedStack` para conservar el estado de las pestañas) cuando deban compartir una interfaz persistente como una barra de navegación inferior. Los deep links vienen entonces casi gratis: `go_router` analiza la ruta entrante contra ese árbol de rutas y reconstruye la pila correspondiente, de modo que un enlace a `/orders/42` lleva al usuario a la página de detalle del pedido con `/orders` debajo en la pila de retroceso. El único trabajo manual es la configuración nativa de la plataforma que le indica a Android e iOS que entreguen la URL a Flutter en primer lugar. Esta guía usa `go_router` 17.3.0 (junio de 2026), Flutter 3.44 stable y Dart 3.x.

Las dos ideas que la gente confunde son el anidamiento y los deep links, y son realmente distintas. El anidamiento tiene que ver con la forma de tu árbol de rutas: qué pantallas viven dentro de cuáles y qué diseño persiste entre ellas. Los deep links tienen que ver con una URL externa que entra a la aplicación y se resuelve en una pantalla. Se encuentran en exactamente un punto: `go_router` usa la misma tabla de rutas declarativa para renderizar la navegación interna y para resolver un deep link, y por eso un árbol de rutas bien formado te da deep links correctos sin código adicional.

## Cómo las sub-rutas convierten una URL en una pila de páginas

Una `GoRoute` puede llevar su propia lista `routes:`. Cuando la ruta coincidente baja más allá del padre, `go_router` recorre el árbol y agrega una página por nivel, de modo que la pila de retroceso resultante refleja los segmentos de la URL.

```dart
// go_router 17.3.0, Flutter 3.44, Dart 3.x
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/orders',
      builder: (context, state) => const OrdersScreen(),
      routes: [
        // matches /orders/42 -> stack is [OrdersScreen, OrderDetailScreen]
        GoRoute(
          path: ':id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderDetailScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);
```

Aquí importan dos detalles. Primero, las rutas hijas son relativas: la hija es `':id'`, no `'/orders/:id'`. Una barra inicial en una sub-ruta la convierte en una ruta absoluta de nivel superior y rompe el anidamiento, lo cual es uno de los errores de configuración más comunes. Segundo, como la pila se construye a partir de la URL, presionar el botón de retroceso del sistema en `/orders/42` regresa a `/orders` aunque el usuario haya llegado directamente por un deep link. Esa es la recompensa completa del enrutamiento declarativo: la pila de retroceso es una función de la ruta, no de cómo llegó allí el usuario.

Lee un parámetro de ruta desde `state.pathParameters` y un parámetro de consulta desde `state.uri.queryParameters`. Ambos son simples strings, así que analízalos y valídalos en el builder en lugar de confiar en la URL.

## Compartir un diseño con ShellRoute

Las sub-rutas te dan profundidad, pero no te dan un marco persistente. Si `/orders` y `/profile` deben renderizarse ambas dentro del mismo scaffold con la misma barra inferior, lo que quieres es un `ShellRoute`. Un `ShellRoute` introduce un `Navigator` anidado: sus rutas hijas se renderizan en un widget `child` que colocas dentro de tu shell, y el shell mismo nunca se reconstruye a medida que el usuario se mueve entre las hijas.

```dart
// go_router 17.3.0 -- one shared scaffold, swappable body
ShellRoute(
  builder: (context, state, child) => ScaffoldWithNavBar(child: child),
  routes: [
    GoRoute(path: '/orders', builder: (_, __) => const OrdersScreen()),
    GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
  ],
),
```

El `child` que se pasa al builder del shell es la sub-ruta coincidente actual. Tu `ScaffoldWithNavBar` coloca `child` en el `body` y renderiza el `BottomNavigationBar` a su alrededor. Tocar una pestaña llama a `context.go('/profile')`, el navigator anidado intercambia el body y el scaffold permanece montado. Esa persistencia es toda la razón para recurrir a `ShellRoute` en lugar de una simple lista de rutas de nivel superior.

La limitación: `ShellRoute` mantiene un solo navigator, así que todas las pestañas comparten una pila de retroceso y el body se reconstruye desde cero cada vez que cambias. La posición de desplazamiento, la entrada de formularios y cualquier estado efímero dentro de una pestaña se pierden al cambiar. Para muchas aplicaciones eso está bien. Para una aplicación estilo Instagram donde cada pestaña debe recordar dónde estaba, necesitas la variante con estado.

## Darle a cada pestaña su propia pila de retroceso con StatefulShellRoute

`StatefulShellRoute.indexedStack` crea un `Navigator` separado por rama y mantiene todas las ramas vivas en un `IndexedStack`, de modo que cambiar de pestaña conserva la pila y el estado de cada pestaña. Este es el valor por defecto en 2026 para cualquier aplicación con una barra de navegación inferior donde las pestañas deben ser independientes.

```dart
// go_router 17.3.0 -- independent stacks per tab
StatefulShellRoute.indexedStack(
  builder: (context, state, navigationShell) =>
      ScaffoldWithNavBar(navigationShell: navigationShell),
  branches: [
    StatefulShellBranch(
      routes: [
        GoRoute(
          path: '/orders',
          builder: (_, __) => const OrdersScreen(),
          routes: [
            GoRoute(
              path: ':id',
              builder: (context, state) =>
                  OrderDetailScreen(orderId: state.pathParameters['id']!),
            ),
          ],
        ),
      ],
    ),
    StatefulShellBranch(
      routes: [
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
      ],
    ),
  ],
)
```

El builder te entrega un `StatefulNavigationShell` en lugar de un `child` simple. Cambias de rama con `navigationShell.goBranch(index)`, no con `context.go(...)`, porque `goBranch` restaura la pila existente de esa rama en lugar de iniciar una navegación nueva:

```dart
// go_router 17.3.0 -- the nav bar drives the shell, not context.go
BottomNavigationBar(
  currentIndex: navigationShell.currentIndex,
  onTap: (index) => navigationShell.goBranch(
    index,
    // re-tapping the active tab pops to its root, like native apps
    initialLocation: index == navigationShell.currentIndex,
  ),
  items: const [
    BottomNavigationBarItem(icon: Icon(Icons.list), label: 'Orders'),
    BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
  ],
)
```

Las versiones recientes también exponen un flag `preload` en `StatefulShellBranch`, que construye la primera ruta de una rama antes de que el usuario la visite, intercambiando algo de costo de inicio por un primer cambio de pestaña instantáneo. Déjalo desactivado a menos que un profiler muestre que el primer cambio tiene tirones.

## Configurar las plataformas para que un deep link llegue a Flutter

Un deep link solo funciona si el sistema operativo enruta la URL a tu aplicación. `go_router` no puede hacer esta parte por ti; toma el control solo después de que Flutter recibe el enlace. Los deep links integrados de Flutter están activados por defecto en Flutter 3.44, así que mayormente agregas las rutas de la plataforma y, en Android, activas la verificación de App Links.

Hay dos tipos de enlaces y la configuración nativa difiere:

- **Esquema personalizado** (`myapp://orders/42`): trivial de configurar, funciona sin conexión, pero cualquier aplicación puede reclamar el mismo esquema. Apto para traspasos internos de aplicación a aplicación.
- **Universal links / App Links** (`https://example.com/orders/42`): vinculados a un dominio que posees mediante un archivo de asociación alojado, así que solo tu aplicación puede reclamarlos. Esto es lo que quieres para enlaces compartidos en la web.

En Android, agrega un `intent-filter` a la actividad principal en `android/app/src/main/AndroidManifest.xml`. El atributo `android:autoVerify="true"` es lo que promueve un simple enlace `https` a un App Link verificado:

```xml
<!-- AndroidManifest.xml -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
</intent-filter>
```

Los deep links de Flutter están activados por defecto, pero si alguna vez necesitas alternarlos, el flag explícito es una entrada `meta-data` llamada `flutter_deeplinking_enabled` con valor `true` o `false`. Los App Links también requieren un archivo `assetlinks.json` alojado en `https://example.com/.well-known/assetlinks.json` que contenga el nombre del paquete de tu aplicación y la huella de firma, o el sistema operativo recurrirá a abrir el navegador.

En iOS, la clave equivalente en `Info.plist` es `FlutterDeepLinkingEnabled`. Los universal links necesitan un entitlement de Associated Domains (`applinks:example.com`) más un archivo `apple-app-site-association` alojado en tu dominio. Un esquema personalizado en cambio usa una entrada `CFBundleURLTypes` en `Info.plist`. El XML preciso para ambas plataformas vive en los cookbooks de Flutter enlazados al final; los nombres de clave de arriba son las partes que sostienen todo.

## La configuración paso a paso

Esta es la secuencia completa para pasar de una aplicación plana a rutas anidadas con deep links funcionando.

1. **Agrega y fija la dependencia.** Ejecuta `flutter pub add go_router` y confirma que `pubspec.yaml` muestre `go_router: ^17.3.0`. Fija la versión mayor porque `go_router` ha tenido cambios incompatibles en la API del shell entre versiones mayores.
2. **Define el árbol de rutas.** Construye un solo `GoRouter` con tus rutas de nivel superior. Anida las pantallas de detalle dentro de la lista `routes:` de su padre usando rutas relativas (`':id'`, nunca `'/parent/:id'`).
3. **Agrega un shell para el diseño compartido.** Envuelve las rutas con pestañas en `StatefulShellRoute.indexedStack` (pilas de pestañas independientes) o `ShellRoute` (una pila compartida). Renderiza `navigationShell` o `child` dentro del body de tu scaffold.
4. **Conecta el router a la aplicación.** Pásalo a `MaterialApp.router(routerConfig: router)` para que el widget `Router` de Flutter controle la navegación y se conecte el manejador de deep links de la plataforma.
5. **Navega por ruta.** Usa `context.go('/orders/42')` para reemplazar la pila, `context.push('/orders/42')` para apilar encima y `navigationShell.goBranch(index)` para cambiar de pestaña sin perder su estado.
6. **Configura las plataformas.** Agrega el `intent-filter` de Android con `autoVerify` y el entitlement de Associated Domains de iOS, y aloja los archivos `assetlinks.json` / `apple-app-site-association` para los enlaces verificados.
7. **Prueba el enlace de extremo a extremo.** En Android, `adb shell am start -W -a android.intent.action.VIEW -d "https://example.com/orders/42"`. En el simulador de iOS, `xcrun simctl openurl booted "https://example.com/orders/42"`. La aplicación debería abrirse directamente en la pantalla de detalle del pedido con `/orders` en la pila de retroceso.

## Problemas que rompen la navegación en silencio

**Rutas hijas absolutas.** Una ruta hija escrita como `'/orders/:id'` en lugar de `':id'` se convierte silenciosamente en una ruta de nivel superior. El anidamiento se rompe y el botón de retroceso deja de volver a `/orders`. Este es el error más común.

**Mostrar un diálogo o una ruta de pantalla completa dentro de un shell.** Una pantalla de inicio de sesión o un modal usualmente no deberían renderizarse dentro del scaffold de la barra de navegación inferior. Dale a la ruta un `parentNavigatorKey` que apunte a la clave del navigator raíz para que se apile sobre el shell en lugar de dentro de él. Sin esto, tu página de inicio de sesión aparece con una barra inferior adjunta.

**Usar `context.go` para cambiar de pestaña.** Dentro de un `StatefulShellRoute`, llamar a `context.go('/profile')` funciona pero descarta la pila guardada de esa rama. Usa siempre `navigationShell.goBranch(index)` desde la barra de navegación para que cada pestaña recuerde dónde estaba.

**Leer un context después de una redirección asíncrona.** Las redirecciones y la navegación asíncrona pueden reconstruir o desechar el widget que las disparó. Si navegas después de un `await`, protege la reanudación igual que lo harías en cualquier otro lugar, como se cubre en [usar BuildContext de forma segura después de un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/). Ignorar esto provoca el [fallo de buscar el ancestro de un widget desactivado](/es/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

**Suponer que un deep link es válido.** `state.pathParameters['id']` es lo que sea que contuviera la URL, incluida basura de un enlace escrito a mano u obsoleto. Analízalo, valídalo y enruta a una pantalla de no encontrado en caso de fallo. Combina esto con un [manejo elegante de errores de red](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) cuando el recurso del deep link tiene que obtenerse y podría no existir.

**Desechar controllers en pantallas que persisten.** Con `StatefulShellRoute.indexedStack`, las pantallas de las pestañas siguen vivas en segundo plano, así que sus controllers no se desechan al cambiar de pestaña. Eso suele ser lo que quieres, pero sé deliberado al respecto, igual que lo serías al [desechar controllers para evitar fugas](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) en rutas que realmente aparecen y desaparecen.

## Cuándo injertar rutas tipadas encima

Todo lo anterior usa rutas en forma de string. Son fáciles de leer pero fáciles de teclear mal, y un string de ruta incorrecto falla en tiempo de ejecución, no en tiempo de compilación. Para una aplicación grande, agrega `go_router_builder` para generar clases de ruta con seguridad de tipos a partir de definiciones anotadas, de modo que `OrderDetailRoute(id: 42).go(context)` reemplace al string crudo y el compilador detecte un parámetro faltante. La forma del árbol de rutas, los shells y la configuración de deep links son idénticos; las rutas tipadas son una capa de generación de código sobre el mismo `GoRouter`. Empieza con strings, confirma que el modelo de navegación es correcto y luego introduce rutas tipadas una vez que la estructura sea estable. Si además estás eligiendo un enfoque de gestión de estado para las pantallas que renderizan estas rutas, las ventajas y desventajas en [Provider vs Riverpod vs Bloc](/es/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) combinan de forma natural con esta configuración de enrutamiento.

## Fuentes

- [Paquete go_router en pub.dev](https://pub.dev/packages/go_router) (versión 17.3.0, junio de 2026)
- [API de la clase ShellRoute](https://pub.dev/documentation/go_router/latest/go_router/ShellRoute-class.html)
- [API de la clase StatefulShellRoute](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [Tema de deep linking, documentación de go_router](https://pub.dev/documentation/go_router/latest/topics/Deep%20linking-topic.html)
- [Documentación de deep linking de Flutter](https://docs.flutter.dev/ui/navigation/deep-linking)

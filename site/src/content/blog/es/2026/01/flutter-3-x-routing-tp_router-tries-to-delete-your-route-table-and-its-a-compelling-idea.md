---
title: "Routing en Flutter 3.x: tp_router intenta borrar tu tabla de rutas (y es una idea atractiva)"
description: "tp_router es un router de Flutter dirigido por generador que elimina las tablas de rutas manuales. Anota tus páginas, ejecuta build_runner y navega con APIs tipadas en lugar de paths basados en strings."
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "es"
translationOf: "2026/01/flutter-3-x-routing-tp_router-tries-to-delete-your-route-table-and-its-a-compelling-idea"
translatedBy: "claude"
translationDate: 2026-04-30
---
El routing de Flutter es una de esas cosas que solo notas cuando duele. Las primeras pantallas son fáciles. Después la app crece, los paths evolucionan y "agregar otra ruta" se convierte en un impuesto de mantenimiento. El 7 de enero de 2026, una publicación de la comunidad propuso una solución opinada: `tp_router`, un router dirigido por generador que apunta a **cero configuración manual de tabla de rutas**.

Hilo de origen: [tp_router: Stop Writing Route Tables (r/FlutterDev)](https://www.reddit.com/r/FlutterDev/comments/1q6dq85/tp_router_stop_writing_route_tables/)  
Enlaces del proyecto: [GitHub](https://github.com/lwj1994/tp_router), [pub.dev](https://pub.dev/packages/tp_router)

## El modo de fallo: strings por todas partes

La mayoría de los equipos ha vivido alguna versión de esto:

```dart
// Define route table
final routes = {
  '/user': (context) => UserPage(
    id: int.parse(ModalRoute.of(context)!.settings.arguments as String),
  ),
};

// Navigate
Navigator.pushNamed(context, '/user', arguments: '42');
```

"Funciona", hasta que no: el nombre de la ruta cambia, el tipo del argumento cambia y obtienes crashes en runtime en partes de la app que no tocaste.

## Anotación primero, generación después

La propuesta de `tp_router` es simple: anota la página, ejecuta el generador y luego navega a través de tipos generados en vez de strings.

De la publicación:

```dart
@TpRoute(path: '/user/:id')
class UserPage extends StatelessWidget {
  final int id; // Auto-parsed from path
  final String section;

  const UserPage({
    required this.id,
    this.section = 'profile',
    super.key,
  });
}

// Navigate by calling .tp()
UserRoute(id: 42, section: 'posts').tp(context);
```

Esa última línea es todo el punto: si renombras `section` o cambias `id` de `int` a `String`, quieres que el compilador rompa tu build, no a tus usuarios.

## La pregunta real: ¿mantiene la fricción baja a medida que la app crece?

Si has usado `auto_route`, ya sabes que el routing dirigido por anotaciones puede funcionar bien, pero todavía terminas escribiendo una lista central:

```dart
@AutoRouterConfig(routes: [
  AutoRoute(page: UserRoute.page, path: '/user/:id'),
  AutoRoute(page: HomeRoute.page, path: '/'),
])
class AppRouter extends RootStackRouter {}
```

`tp_router` está intentando eliminar ese último paso por completo.

## Ponerlo a funcionar en un proyecto Flutter 3.x

Las dependencias mostradas en el hilo son:

```yaml
dependencies:
  tp_router: ^0.1.0
  tp_router_annotation: ^0.1.0

dev_dependencies:
  build_runner: ^2.4.0
  tp_router_generator: ^0.1.0
```

Generar las rutas:

-   `dart run build_runner build`

Y conectarlo:

```dart
void main() {
  final router = TpRouter(routes: tpRoutes);
  runApp(MaterialApp.router(routerConfig: router.routerConfig));
}
```

Si quieres menos boilerplate de routing y más seguridad en tiempo de compilación, vale la pena probar `tp_router` con un spike rápido. Incluso si no lo adoptas, la dirección es correcta: trata la navegación como una API tipada, no como folklore basado en strings.

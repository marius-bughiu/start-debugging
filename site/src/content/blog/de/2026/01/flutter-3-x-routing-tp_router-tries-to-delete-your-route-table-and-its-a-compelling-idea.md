---
title: "Flutter 3.x Routing: tp_router will Ihre Routentabelle löschen (und das ist eine überzeugende Idee)"
description: "tp_router ist ein generatorgetriebener Flutter-Router, der manuelle Routentabellen eliminiert. Annotieren Sie Ihre Seiten, führen Sie build_runner aus und navigieren Sie mit typisierten APIs statt mit stringbasierten Pfaden."
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "de"
translationOf: "2026/01/flutter-3-x-routing-tp_router-tries-to-delete-your-route-table-and-its-a-compelling-idea"
translatedBy: "claude"
translationDate: 2026-04-30
---
Flutter-Routing ist eines dieser Dinge, die einem erst auffallen, wenn es weh tut. Die ersten Bildschirme sind einfach. Dann wächst die App, Pfade entwickeln sich weiter, und "einfach noch eine Route hinzufügen" wird zur Wartungssteuer. Am 7. Januar 2026 schlug ein Community-Post eine meinungsstarke Lösung vor: `tp_router`, einen generatorgetriebenen Router, der **null manuelle Routentabellen-Konfiguration** anpeilt.

Quell-Thread: [tp_router: Stop Writing Route Tables (r/FlutterDev)](https://www.reddit.com/r/FlutterDev/comments/1q6dq85/tp_router_stop_writing_route_tables/)  
Projekt-Links: [GitHub](https://github.com/lwj1994/tp_router), [pub.dev](https://pub.dev/packages/tp_router)

## Der Fehlermodus: Strings überall

Die meisten Teams haben eine Version davon erlebt:

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

Es "funktioniert", bis es nicht mehr funktioniert: Der Routenname ändert sich, der Argumenttyp ändert sich, und Sie bekommen Laufzeit-Abstürze in Teilen der App, die Sie nicht angefasst haben.

## Annotation zuerst, Generierung danach

Der Pitch von `tp_router` ist einfach: Annotieren Sie die Seite, führen Sie den Generator aus und navigieren Sie dann über generierte Typen statt über Strings.

Aus dem Post:

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

Diese letzte Zeile ist der ganze Punkt: Wenn Sie `section` umbenennen oder `id` von `int` auf `String` ändern, wollen Sie, dass der Compiler Ihren Build kaputt macht, nicht Ihre Nutzer.

## Die eigentliche Frage: Bleibt die Reibung niedrig, wenn die App wächst?

Wenn Sie `auto_route` verwendet haben, wissen Sie bereits, dass annotationsgetriebenes Routing gut funktionieren kann, aber Sie schreiben am Ende dennoch eine zentrale Liste:

```dart
@AutoRouterConfig(routes: [
  AutoRoute(page: UserRoute.page, path: '/user/:id'),
  AutoRoute(page: HomeRoute.page, path: '/'),
])
class AppRouter extends RootStackRouter {}
```

`tp_router` versucht, diesen letzten Schritt vollständig zu entfernen.

## Es in einem Flutter 3.x Projekt zum Laufen bringen

Die im Thread gezeigten Abhängigkeiten sind:

```yaml
dependencies:
  tp_router: ^0.1.0
  tp_router_annotation: ^0.1.0

dev_dependencies:
  build_runner: ^2.4.0
  tp_router_generator: ^0.1.0
```

Routen generieren:

-   `dart run build_runner build`

Und verdrahten:

```dart
void main() {
  final router = TpRouter(routes: tpRoutes);
  runApp(MaterialApp.router(routerConfig: router.routerConfig));
}
```

Wenn Sie weniger Routing-Boilerplate und mehr Compile-Time-Sicherheit wollen, ist `tp_router` einen schnellen Spike wert. Auch wenn Sie es nicht übernehmen, ist die Richtung richtig: Behandeln Sie Navigation als typisierte API, nicht als stringbasierte Folklore.

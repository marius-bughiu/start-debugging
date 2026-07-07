---
title: "go_router vs. auto_route vs. Navigator 2.0 in Flutter"
description: "go_router und auto_route setzen beide auf Navigator 2.0 auf, die eigentliche Wahl lautet also: deklaratives URL-Routing vs. code-generierte typisierte Routen vs. die Router-API selbst schreiben. Eine Entscheidungsmatrix mit Konfiguration für jede Option, und wann der reine Navigator immer noch gewinnt."
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "auto-route"
  - "navigation"
lang: "de"
translationOf: "2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

Kurze Antwort: Für die meisten Flutter-Apps im Jahr 2026 verwenden Sie `go_router`. Es wird vom Flutter-Team gepflegt, es ist die Option, auf die Sie die offizielle Dokumentation verweist, und es macht aus URLs Screens mit dem geringsten Aufwand. Greifen Sie zu `auto_route`, wenn Sie zur Kompilierzeit geprüfte, stark typisierte Navigationsaufrufe möchten und bereit sind, dafür einen Code-Generator laufen zu lassen. Steigen Sie nur dann auf den reinen Navigator 2.0 hinab (indem Sie `RouterDelegate` und `RouteInformationParser` selbst implementieren), wenn Sie ein wirklich ungewöhnliches Navigationsmodell haben, das keines der beiden Pakete ausdrückt, denn Sie handeln sich damit eine Menge Boilerplate ein. Und wenn Ihre App klein ist und keine Deep-Link- oder Web-URL-Anforderungen hat, ist das schlichte imperative `Navigator.push` immer noch eine völlig gute Antwort.

Was in diesem Vergleich fast alle falsch machen: Sie behandeln die drei als parallele Optionen. Das sind sie nicht. "Navigator 2.0" ist die `Router`-API des Flutter-Frameworks, und sowohl `go_router` als auch `auto_route` bauen darauf auf. Die Entscheidung lautet also nicht "Paket A vs. Paket B vs. das Framework", sondern "auf welcher Ebene möchte ich mein Routing schreiben". Dieser Beitrag verwendet `go_router` 17.3.0, `auto_route` 11.1.0, Flutter 3.44 stable und Dart 3.x.

## Die Schichttorte: was "Navigator 2.0" tatsächlich ist

Flutter hat zwei Navigations-APIs, die nebeneinander existieren.

Navigator 1.0 ist die imperative, die Sie bereits kennen: `Navigator.of(context).push(MaterialPageRoute(...))` und `Navigator.pop(context)`. Sie schieben und entfernen Screens wie einen Stapel. Es ist einfach und es funktioniert, und für eine kleine App ist es alles, was Sie brauchen.

Navigator 2.0, genauer die `Router`-API genannt, ist deklarativ. Statt imperativ zu pushen, geben Sie dem Framework eine Liste von `Page`-Objekten, die den gesamten Stapel beschreiben, und wenn sich der Zustand Ihrer App ändert, übergeben Sie eine neue Liste. Zwei Teile lassen das funktionieren: ein `RouteInformationParser`, der eine eingehende URL (`RouteInformation`) in Ihren eigenen app-spezifischen Datentyp verwandelt, und ein `RouterDelegate`, der diese Daten plus den Zustand Ihrer App liest und den `Navigator` mit den richtigen `pages` aufbaut. Die offizielle [Dokumentation zu Navigation und Routing](https://docs.flutter.dev/ui/navigation) beschreibt genau diese Aufteilung.

Der Haken ist, dass es viel Arbeit ist, einen korrekten `RouterDelegate` und `RouteInformationParser` von Hand zu schreiben. Sie sind verantwortlich für das Parsen von Pfaden, das Pflegen der Seitenliste, das Behandeln der System-Zurück-Taste, das Synchronisieren von Browser-URLs und das Wiederherstellen von Deep Links. Die Flutter-Dokumentation ist da direkt:

> If you prefer not to use a routing package and would like full control over navigation and routing in your app, override `RouteInformationParser` and `RouterDelegate`.

Dieses "if you prefer full control" ist das entscheidende Signal. Für alle anderen umhüllt ein Routing-Paket diese Maschinerie. `go_router` und `auto_route` sind beide diese Hülle. Sie konsumieren Navigator 2.0, sie konkurrieren nicht mit ihm. Wenn also jemand fragt "go_router oder Navigator 2.0?", lautet die ehrliche Antwort, dass go_router Navigator 2.0 *ist*, mit der Boilerplate, die bereits für Sie geschrieben wurde.

## Worauf go_router optimiert: URLs als Quelle der Wahrheit

`go_router` wird vom verifizierten Publisher `flutter.dev` veröffentlicht und [vom Flutter-Team gepflegt](https://pub.dev/packages/go_router). Sein Modell ist URL-first: Sie deklarieren eine Routentabelle aus Pfadmustern, und Navigation ist eine Frage des Wechsels zu einem Pfad. Deep Links, Web-URLs und In-App-Navigation lösen sich alle über dieselbe Tabelle auf, weshalb ein Deep Link und ein Button-Tap auf demselben Screen landen.

Ein minimales Setup:

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

Navigation ist ein String:

```dart
// go_router 17.3.0 - navigate by URL
context.go('/orders/42');   // replace the stack, land on order 42
context.push('/orders/42'); // push on top of the current stack
```

Die Stärke hier ist zugleich die scharfe Kante: Navigationsziele sind Strings. `context.go('/orders/42')` wird nicht vom Compiler geprüft. Vertippen Sie sich im Pfad oder benennen Sie eine Route um, erfahren Sie es zur Laufzeit. `go_router` hat eine Antwort, [typisierte Routen über `go_router_builder`](https://pub.dev/packages/go_router_builder), das typisierte `GoRouteData`-Klassen generiert, sodass Sie `OrderRoute(id: 42).go(context)` statt eines Strings aufrufen können. Aber das ist eine optionale Code-Generierung, die auf ein Paket aufgesetzt wird, dessen Standard-Idiom Strings sind, und in der Praxis schalten viele go_router-Codebasen sie nie ein.

`go_router` besitzt außerdem die zwei Funktionen, für die Leute es tatsächlich einsetzen. `ShellRoute` und `StatefulShellRoute.indexedStack` geben Ihnen eine persistente Hülle (eine untere Navigationsleiste, die Tab-Wechsel übersteht), und ein `redirect`-Callback auf oberster Ebene übernimmt das Auth-Gating für den gesamten Baum. Wenn Sie den vollständigen Durchgang zu Hüllen und Deep-Link-Konfiguration möchten, siehe [Nested Routes und Deep Links mit go_router einrichten](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/).

Eine Statusanmerkung, die für eine mehrjährige Entscheidung zählt: Das Flutter-Team führt `go_router` als feature-complete. Ihre [Roadmap-Aussage](https://pub.dev/packages/go_router) lautet:

> This package is considered feature-complete. The Flutter team's primary focus will be on addressing bug fixes and ensuring stability.

Lesen Sie das als Stabilität, nicht als Aufgabe. Es bedeutet, dass die API, die Sie heute lernen, wahrscheinlich nicht unter Ihnen weg mutiert, und Bugfixes weiterhin landen. Es bedeutet auch, dass große neue Fähigkeiten eher als Community-Pakete ankommen als als Kernfunktionen von go_router.

## Worauf auto_route optimiert: typisierte Routen aus Code-Generierung

`auto_route` 11.1.0 ist ein Community-Paket von Milad Akarie. Es greift genau die Schwäche im Standard von go_router an: die stringbasierte Navigation. Sie annotieren jede Seite mit `@RoutePage()`, lassen `build_runner` laufen, und es generiert eine stark typisierte Route für jeden Screen. Navigationsaufrufe werden dann vom Compiler geprüft, und ihre Argumente sind typisiert.

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

Nach `dart run build_runner build` ist die Navigation von Ende zu Ende typisiert:

```dart
// auto_route 11.1.0 - typed navigation, checked by the compiler
context.router.push(OrderRoute(orderId: 42)); // orderId is an int
```

Benennen Sie `orderId` um, ändern Sie seinen Typ oder löschen Sie die Route, und der Code, der dorthin navigiert, kompiliert nicht mehr. Das ist der ganze Kern der Sache, und für eine große App mit dutzenden Screens und nicht-trivialen Argumenten ist es ein echter, täglicher Produktivitätsunterschied. Sie serialisieren nie ein Objekt in einen Query-String und parsen es von Hand wieder heraus.

`auto_route` liefert außerdem erstklassige Entsprechungen der go_router-Funktionen. Nested Navigation verwendet ein `AutoRouter`-Widget als Auslass für Kindrouten, tab-basierte Navigation verwendet [`AutoTabsRouter`](https://pub.dev/packages/auto_route), das den Zustand von Tabs außerhalb des Bildschirms so bewahrt, wie es `StatefulShellRoute` tut. Auth-Gating verwendet Guards: Sie leiten von `AutoRouteGuard` ab, implementieren `onNavigation` und hängen den Guard pro Route oder global an.

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

Der Preis ist der Code-Generator. Sie fügen `auto_route_generator` und `build_runner` als Dev-Abhängigkeiten hinzu, und jedes Mal, wenn Sie ein `@RoutePage` hinzufügen oder ändern, generieren Sie neu. In der aktiven Entwicklung lassen Sie `build_runner watch` laufen. Das ist eine echte Steuer: langsamere Cold Builds, eine generierte `.gr.dart`-Datei in Ihrem Baum und die gelegentliche Notwendigkeit, generierte Ausgaben zu löschen und neu zu kompilieren, wenn die Dinge aus dem Takt geraten. Ob typisierte Navigation einen Code-Generierungsschritt wert ist, ist der zentrale Kompromiss in diesem ganzen Vergleich.

## Die Entscheidung, als Matrix

| Aspekt | go_router 17.3.0 | auto_route 11.1.0 | Reiner Navigator 2.0 |
| --- | --- | --- | --- |
| Maintainer | Flutter-Team (flutter.dev) | Community (Milad Akarie) | Flutter-Framework |
| Navigationsaufrufe | Strings (`context.go('/x')`), typisiert optional über Builder | Typisiert, standardmäßig compilergeprüft | Sie definieren es |
| Code-Generierung | Nein (optional für typisierte Routen) | Ja (`build_runner`) | Nein |
| Deep Links / Web-URLs | Eingebaut | Eingebaut | Sie implementieren es |
| Persistente Hülle / Tabs | `StatefulShellRoute` | `AutoTabsRouter` | Sie implementieren es |
| Auth-Gating | `redirect`-Callback | `AutoRouteGuard` | Sie implementieren es |
| Boilerplate | Gering | Gering bis mittel (plus generierte Dateien) | Hoch |
| Am besten wenn | Die meisten Apps; Web; Deep Links | Große App, viele typisierte Argumente, Sie mögen Codegen | Wirklich individuelles Navigationsmodell |

Die Zeilen, die Ihre Wahl bestimmen sollten, sind "Navigationsaufrufe" und "Code-Generierung". Wenn zur Kompilierzeit geprüfte Navigation wichtig genug ist, um einen Build-Schritt zu rechtfertigen, dann `auto_route`. Wenn Sie lieber keinen Generator laufen lassen und mit String-Pfaden zufrieden sind (oder sich später für `go_router_builder` entscheiden), dann `go_router`. Alles andere beherrschen beide Pakete kompetent.

## Wann der reine Navigator 2.0 die richtige Wahl ist (selten)

Greifen Sie nicht zu einem handgeschriebenen `RouterDelegate`, nur um sich in Kontrolle zu fühlen. Die Situationen, in denen es sich wirklich auszahlt, sind eng begrenzt:

- Ihr Navigationszustand lässt sich überhaupt nicht auf einen URL-Baum abbilden. Denken Sie an einen Knotengraph-Editor, einen Assistenten, dessen Stapel aus einer Zustandsmaschine berechnet wird, oder eine App, in der "der Stapel" eine Projektion einer anderen Datenstruktur ist. Routentabellen von Paketen setzen einen Baum aus Pfaden voraus; wenn Ihr Modell das nicht ist, kämpfen Sie möglicherweise mehr mit dem Paket als mit dem Framework.
- Sie bauen Ihr eigenes Routing-Paket oder eine Abstraktion auf Framework-Ebene und brauchen die Primitive direkt.
- Sie brauchen Verhalten auf der Ebene von `Page`/`Navigator.pages`, das keines der Pakete offenlegt.

Für diese Fälle gibt Ihnen die reine API totale Kontrolle über die `List<Page>` und den Parse-und-Wiederherstellungs-Zyklus. Für alles andere ist die Boilerplate, die Sie schreiben würden, Boilerplate, die die Pakete bereits geschrieben, getestet und ausgeliefert haben. Die Anleitung der Flutter-Dokumentation ist eindeutig: Apps mit anspruchsvollen Navigationsanforderungen "should use a routing package such as go_router", und die reine API wird als die Notausstiegsluke für Leute dargestellt, die explizit volle Kontrolle wollen.

## Nicht vergessen: für eine kleine App ist Navigator 1.0 immer noch in Ordnung

Es gibt einen Fehlermodus, bei dem eine App mit fünf Screens ein Routing-Paket, einen Code-Generator und eine Routentabellen-Abstraktion übernimmt, die sie nie brauchte. Wenn Ihre App kein Web-Ziel, keine Deep Links und keine Anforderung hat, einen Screen aus einer URL zu rekonstruieren, ist imperative Navigation kein Altlasten-Fehler, sondern das richtig dimensionierte Werkzeug:

```dart
// Flutter 3.44 - imperative navigation, still correct for simple apps
Navigator.of(context).push(
  MaterialPageRoute<void>(
    builder: (context) => const SecondScreen(),
  ),
);
```

Die offizielle Dokumentation segnet dies ausdrücklich ab für "small applications without complex deep linking". In dem Moment, in dem Sie einen Web-Build, teilbare Links oder eine untere Navigationsleiste hinzufügen, die Tab-Wechsel überstehen muss, wechseln Sie zu `go_router` oder `auto_route`. Nicht früher.

## Die Fallstricke, die jede Wahl Ihnen mitgibt

Ein paar Dinge beißen Leute, nachdem sie sich festgelegt haben:

- **go_router: Strings sind ungeprüft.** Das Umbenennen eines Pfades ist ein stiller Bruch, bis Sie zur Laufzeit darauf stoßen. Übernehmen Sie entweder früh `go_router_builder` für typisierte Routen, oder halten Sie jeden Pfad in einer einzigen Konstantendatei und schreiben Sie nie einen rohen String inline.
- **go_router: `context` nach einem await.** Deklarative Navigation befreit Sie nicht vom `use_build_context_synchronously`-Lint. Das Navigieren mit einem veralteten `BuildContext` nach einer `async`-Lücke ist derselbe Bug, der es immer war; siehe [BuildContext sicher nach einem await verwenden](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/).
- **auto_route: Drift generierter Dateien.** Nach einem chaotischen Merge oder einem Sprung der Dart-SDK-Version kann die generierte `.gr.dart` veralten und verwirrende Fehler produzieren. Die Behebung ist fast immer `dart run build_runner build --delete-conflicting-outputs`, nicht das Starren auf das Diff.
- **auto_route: ein weiteres Codegen-Tool in Ihrer Pipeline.** Wenn Sie bereits Freezed, json_serializable oder den Generator von Riverpod laufen lassen, ist `auto_route` eine weitere Sache, die synchron bleiben muss. In der CI lässt ein vergessener `build_runner`-Schritt den Build fehlschlagen, nicht Ihre Maschine.
- **Beide: Deep Links brauchen immer noch native Konfiguration.** Kein Paket kann Android und iOS dazu bringen, eine URL von sich aus an Flutter zu übergeben. Sie bearbeiten immer noch die `AndroidManifest.xml` und die iOS-Entitlements, um Ihr Schema oder Ihre App-Links zu registrieren. Das Paket löst die URL auf, sobald sie eintrifft; sie zum Eintreffen zu bringen, ist Plattformarbeit.
- **Die Migration zwischen ihnen ist nicht kostenlos.** go_router-Routentabellen und die annotierten Klassen von auto_route sind strukturell verschieden. Ein Wechsel mitten im Projekt bedeutet, die Routing-Schicht neu zu schreiben, wählen Sie also mit dem Zwei-Jahres-Horizont im Blick, nicht mit diesem Sprint.

Wenn Sie noch Ihren breiteren Stack entscheiden statt nur das Routing, zeigt sich dieselbe Spannung "offiziell-und-langweilig vs. funktionsreich-Community" auch beim State-Management, das ich in [Provider vs. Riverpod vs. Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) durchgehe, und bei der Plattformwahl selbst in [Flutter vs. React Native vs. MAUI](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/).

Die Zusammenfassung, die den Kontakt mit einem echten Projekt übersteht: `go_router` ist der Standard, weil es offiziell, stabil und URL-nativ ist. `auto_route` verdient sich seinen Platz bei großen Apps, in denen zur Kompilierzeit geprüfte Navigation einen Code-Generator wert ist. Der reine Navigator 2.0 ist für die seltene App, deren Navigationsmodell nicht in eine Routentabelle passt. Und das schlichte `Navigator.push` ist immer noch die korrekte Antwort für eine kleine App, die nichts davon braucht. Wählen Sie die niedrigste Ebene, die Ihr tatsächliches Problem löst, nicht die mächtigste.

## Ähnliche Beiträge

- [Nested Routes und Deep Links mit go_router in Flutter einrichten](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/)
- [BuildContext sicher nach einem await in Flutter verwenden](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [Provider vs. Riverpod vs. Bloc für Flutter-State-Management im Jahr 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Flutter vs. React Native vs. MAUI für ein neues Mobilprojekt im Jahr 2026](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)
- [Eine Flutter-2-App auf Flutter 3.x migrieren: Null-Safety-Checkliste](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Quellen

- [Navigation and routing - Flutter docs](https://docs.flutter.dev/ui/navigation)
- [go_router - pub.dev (maintained by flutter.dev)](https://pub.dev/packages/go_router)
- [go_router_builder - pub.dev](https://pub.dev/packages/go_router_builder)
- [auto_route - pub.dev](https://pub.dev/packages/auto_route)
- [auto_route_library - Milad-Akarie on GitHub](https://github.com/Milad-Akarie/auto_route_library)

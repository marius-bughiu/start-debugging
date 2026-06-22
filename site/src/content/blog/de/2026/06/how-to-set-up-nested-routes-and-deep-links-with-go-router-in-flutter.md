---
title: "Verschachtelte Routen und Deep Links mit go_router in Flutter einrichten"
description: "Bauen Sie eine persistente Shell mit verschachtelten Routen über ShellRoute und StatefulShellRoute und richten Sie dann pfadbasierte Deep Links ein, die den gesamten Seitenstapel wiederherstellen. Vollständige Konfiguration für Android und iOS sowie die Fallstricke, die den Zurück-Stapel zerstören."
pubDate: 2026-06-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
lang: "de"
translationOf: "2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-22
---

Um Routen in Flutter mit `go_router` zu verschachteln, legen Sie die Kindrouten in die `routes:`-Liste einer übergeordneten `GoRoute`, damit die URL einen Seitenstapel aufbaut, und umschließen Sie eine Gruppe von Routen mit einem `ShellRoute` (oder `StatefulShellRoute.indexedStack`, um den Tab-Zustand zu erhalten), wenn diese eine persistente Oberfläche wie eine untere Navigationsleiste teilen sollen. Deep Links ergeben sich dann fast von selbst: `go_router` analysiert den eingehenden Pfad anhand dieses Routenbaums und rekonstruiert den passenden Stapel, sodass ein Link zu `/orders/42` den Benutzer auf die Detailseite der Bestellung führt, mit `/orders` darunter im Zurück-Stapel. Die einzige manuelle Arbeit ist die native Plattformkonfiguration, die Android und iOS anweist, die URL überhaupt erst an Flutter zu übergeben. Dieser Leitfaden verwendet `go_router` 17.3.0 (Juni 2026), Flutter 3.44 stable und Dart 3.x.

Die beiden Konzepte, die Menschen verwechseln, sind Verschachtelung und Deep Linking, und sie sind tatsächlich getrennt. Bei der Verschachtelung geht es um die Form Ihres Routenbaums: welche Bildschirme in welchen liegen und welches Layout über sie hinweg bestehen bleibt. Beim Deep Linking geht es um eine externe URL, die in die App gelangt und sich zu einem Bildschirm auflöst. Sie treffen sich an genau einem Punkt: `go_router` verwendet dieselbe deklarative Routentabelle, um die In-App-Navigation zu rendern und um einen Deep Link aufzulösen. Deshalb liefert ein gut geformter Routenbaum korrekte Deep Links ohne zusätzlichen Code.

## Wie Sub-Routen eine URL in einen Seitenstapel verwandeln

Eine `GoRoute` kann ihre eigene `routes:`-Liste tragen. Wenn der passende Pfad tiefer geht als das übergeordnete Element, durchläuft `go_router` den Baum und fügt pro Ebene eine Seite hinzu, sodass der resultierende Zurück-Stapel die URL-Segmente widerspiegelt.

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

Zwei Details sind hier wichtig. Erstens sind Kindpfade relativ: das Kind ist `':id'`, nicht `'/orders/:id'`. Ein führender Schrägstrich an einer Sub-Route macht sie zu einer absoluten Route der obersten Ebene und zerstört die Verschachtelung, was einer der häufigsten Konfigurationsfehler ist. Zweitens: Da der Stapel aus der URL aufgebaut wird, springt das Drücken der System-Zurück-Taste auf `/orders/42` zurück zu `/orders`, selbst wenn der Benutzer direkt über einen Deep Link angekommen ist. Das ist der gesamte Gewinn deklarativen Routings: Der Zurück-Stapel ist eine Funktion des Pfads, nicht der Art, wie der Benutzer dorthin gelangt ist.

Lesen Sie einen Pfadparameter aus `state.pathParameters` und einen Abfrageparameter aus `state.uri.queryParameters`. Beide sind einfache strings, also parsen und validieren Sie sie im Builder, statt der URL zu vertrauen.

## Ein Layout mit ShellRoute teilen

Sub-Routen geben Ihnen Tiefe, aber keinen persistenten Rahmen. Wenn `/orders` und `/profile` beide innerhalb desselben Scaffold mit derselben unteren Leiste gerendert werden sollen, möchten Sie einen `ShellRoute`. Ein `ShellRoute` führt einen verschachtelten `Navigator` ein: Seine Kindrouten werden in ein `child`-Widget gerendert, das Sie in Ihre Shell legen, und die Shell selbst wird nie neu aufgebaut, während sich der Benutzer zwischen den Kindern bewegt.

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

Das an den Shell-Builder übergebene `child` ist die aktuell passende Sub-Route. Ihr `ScaffoldWithNavBar` legt `child` in den `body` und rendert die `BottomNavigationBar` darum herum. Das Antippen eines Tabs ruft `context.go('/profile')` auf, der verschachtelte Navigator tauscht den Body aus, und das Scaffold bleibt eingehängt. Diese Persistenz ist der ganze Grund, zum `ShellRoute` zu greifen, statt zu einer einfachen Liste von Routen der obersten Ebene.

Die Einschränkung: Ein `ShellRoute` hält einen einzigen Navigator, sodass alle Tabs einen Zurück-Stapel teilen und der Body bei jedem Wechsel von Grund auf neu aufgebaut wird. Scroll-Position, Formulareingabe und jeder kurzlebige Zustand innerhalb eines Tabs gehen beim Wechsel verloren. Für viele Apps ist das in Ordnung. Für eine App im Instagram-Stil, bei der sich jeder Tab merken muss, wo er war, benötigen Sie die zustandsbehaftete Variante.

## Jedem Tab seinen eigenen Zurück-Stapel mit StatefulShellRoute geben

`StatefulShellRoute.indexedStack` erstellt einen separaten `Navigator` pro Zweig und hält alle Zweige in einem `IndexedStack` am Leben, sodass das Wechseln der Tabs den Stapel und den Zustand jedes Tabs erhält. Dies ist der Standard für 2026 für jede App mit einer unteren Navigationsleiste, bei der Tabs unabhängig sein sollen.

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

Der Builder übergibt Ihnen einen `StatefulNavigationShell` statt eines einfachen `child`. Sie wechseln den Zweig mit `navigationShell.goBranch(index)`, nicht mit `context.go(...)`, weil `goBranch` den vorhandenen Stapel dieses Zweigs wiederherstellt, statt eine neue Navigation zu starten:

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

Neuere Versionen stellen außerdem ein `preload`-Flag an `StatefulShellBranch` bereit, das die erste Route eines Zweigs aufbaut, bevor der Benutzer sie jemals besucht, und so etwas Startkosten gegen einen sofortigen ersten Tab-Wechsel eintauscht. Lassen Sie es deaktiviert, es sei denn, ein Profiler zeigt, dass der erste Wechsel ruckelt.

## Die Plattformen so konfigurieren, dass ein Deep Link Flutter erreicht

Ein Deep Link funktioniert nur, wenn das Betriebssystem die URL an Ihre App weiterleitet. `go_router` kann diesen Teil nicht für Sie erledigen; es übernimmt erst die Kontrolle, nachdem Flutter den Link empfangen hat. Das eingebaute Deep Linking von Flutter ist in Flutter 3.44 standardmäßig aktiviert, sodass Sie meist nur die Plattformrouten hinzufügen und unter Android die App-Links-Verifizierung aktivieren.

Es gibt zwei Arten von Links, und die native Einrichtung unterscheidet sich:

- **Benutzerdefiniertes Schema** (`myapp://orders/42`): trivial einzurichten, funktioniert offline, aber jede App kann dasselbe Schema beanspruchen. Geeignet für interne App-zu-App-Übergaben.
- **Universal Links / App Links** (`https://example.com/orders/42`): an eine Domain gebunden, die Ihnen gehört, über eine gehostete Zuordnungsdatei, sodass nur Ihre App sie beanspruchen kann. Das ist es, was Sie für über das Web geteilte Links möchten.

Fügen Sie unter Android der Hauptaktivität in `android/app/src/main/AndroidManifest.xml` einen `intent-filter` hinzu. Das Attribut `android:autoVerify="true"` ist das, was einen einfachen `https`-Link zu einem verifizierten App Link befördert:

```xml
<!-- AndroidManifest.xml -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
</intent-filter>
```

Das Deep Linking von Flutter ist standardmäßig aktiviert, aber falls Sie es je umschalten müssen, ist das explizite Flag ein `meta-data`-Eintrag namens `flutter_deeplinking_enabled`, der auf `true` oder `false` gesetzt wird. App Links erfordern außerdem eine `assetlinks.json`-Datei, die unter `https://example.com/.well-known/assetlinks.json` gehostet wird und den Paketnamen Ihrer App sowie den Signatur-Fingerabdruck enthält, sonst greift das Betriebssystem auf das Öffnen des Browsers zurück.

Unter iOS ist der entsprechende `Info.plist`-Schlüssel `FlutterDeepLinkingEnabled`. Universal Links benötigen ein Associated-Domains-Entitlement (`applinks:example.com`) sowie eine `apple-app-site-association`-Datei, die auf Ihrer Domain gehostet wird. Ein benutzerdefiniertes Schema verwendet stattdessen einen `CFBundleURLTypes`-Eintrag in `Info.plist`. Das genaue XML für beide Plattformen befindet sich in den am Ende verlinkten Flutter-Cookbooks; die obigen Schlüsselnamen sind die tragenden Teile.

## Die Schritt-für-Schritt-Einrichtung

Dies ist die vollständige Abfolge, um von einer flachen App zu verschachtelten Routen mit funktionierenden Deep Links zu gelangen.

1. **Abhängigkeit hinzufügen und fixieren.** Führen Sie `flutter pub add go_router` aus und bestätigen Sie, dass `pubspec.yaml` `go_router: ^17.3.0` zeigt. Fixieren Sie die Hauptversion, weil `go_router` über Hauptversionen hinweg inkompatible Änderungen an der Shell-API hatte.
2. **Den Routenbaum definieren.** Bauen Sie einen einzigen `GoRouter` mit Ihren Routen der obersten Ebene. Verschachteln Sie Detailbildschirme in der `routes:`-Liste ihres übergeordneten Elements mit relativen Pfaden (`':id'`, niemals `'/parent/:id'`).
3. **Eine Shell für geteiltes Layout hinzufügen.** Umschließen Sie Tab-Routen mit `StatefulShellRoute.indexedStack` (unabhängige Tab-Stapel) oder `ShellRoute` (ein geteilter Stapel). Rendern Sie `navigationShell` oder `child` im Body Ihres Scaffold.
4. **Den Router in die App einbinden.** Übergeben Sie ihn an `MaterialApp.router(routerConfig: router)`, damit das `Router`-Widget von Flutter die Navigation steuert und der Plattform-Deep-Link-Handler verbunden wird.
5. **Per Pfad navigieren.** Verwenden Sie `context.go('/orders/42')`, um den Stapel zu ersetzen, `context.push('/orders/42')`, um darauf zu stapeln, und `navigationShell.goBranch(index)`, um Tabs zu wechseln, ohne ihren Zustand zu verlieren.
6. **Die Plattformen konfigurieren.** Fügen Sie den Android-`intent-filter` mit `autoVerify` und das iOS-Associated-Domains-Entitlement hinzu und hosten Sie die Dateien `assetlinks.json` / `apple-app-site-association` für die verifizierten Links.
7. **Den Link von Anfang bis Ende testen.** Unter Android `adb shell am start -W -a android.intent.action.VIEW -d "https://example.com/orders/42"`. Im iOS-Simulator `xcrun simctl openurl booted "https://example.com/orders/42"`. Die App sollte sich direkt auf dem Detailbildschirm der Bestellung öffnen, mit `/orders` im Zurück-Stapel.

## Fallstricke, die die Navigation stillschweigend zerstören

**Absolute Kindrouten-Pfade.** Eine Kindroute, die als `'/orders/:id'` statt `':id'` geschrieben ist, wird stillschweigend zu einer Route der obersten Ebene. Die Verschachtelung bricht, und die Zurück-Taste kehrt nicht mehr zu `/orders` zurück. Dies ist der häufigste Fehler.

**Einen Dialog oder eine Vollbildroute innerhalb einer Shell anzeigen.** Ein Anmeldebildschirm oder ein Modal sollten normalerweise nicht innerhalb des Scaffold der unteren Navigationsleiste gerendert werden. Geben Sie der Route einen `parentNavigatorKey`, der auf den Schlüssel des Root-Navigators zeigt, damit sie über die Shell statt in sie hinein gestapelt wird. Ohne dies erscheint Ihre Anmeldeseite mit einer angehängten unteren Leiste.

**`context.go` zum Wechseln von Tabs verwenden.** Innerhalb eines `StatefulShellRoute` funktioniert der Aufruf von `context.go('/profile')`, verwirft aber den gespeicherten Stapel dieses Zweigs. Verwenden Sie immer `navigationShell.goBranch(index)` aus der Navigationsleiste, damit sich jeder Tab merkt, wo er war.

**Einen context nach einer asynchronen Weiterleitung lesen.** Weiterleitungen und asynchrone Navigation können das Widget, das sie ausgelöst hat, neu aufbauen oder verwerfen. Wenn Sie nach einem `await` navigieren, sichern Sie die Fortsetzung genauso ab, wie Sie es überall sonst tun würden, wie in [BuildContext nach einem await sicher verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) behandelt. Dies zu ignorieren führt zum [Absturz beim Nachschlagen des Vorfahren eines deaktivierten Widgets](/de/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

**Annehmen, dass ein Deep Link gültig ist.** `state.pathParameters['id']` ist, was auch immer die URL enthielt, einschließlich Müll aus einem von Hand eingegebenen oder veralteten Link. Parsen Sie ihn, validieren Sie ihn und leiten Sie bei einem Fehler zu einem Nicht-gefunden-Bildschirm weiter. Kombinieren Sie dies mit einer eleganten [Behandlung von Netzwerkfehlern](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), wenn die per Deep Link verlinkte Ressource abgerufen werden muss und möglicherweise nicht mehr existiert.

**Controller auf Bildschirmen verwerfen, die bestehen bleiben.** Mit `StatefulShellRoute.indexedStack` bleiben Tab-Bildschirme im Hintergrund am Leben, sodass ihre Controller beim Tab-Wechsel nicht verworfen werden. Das ist normalerweise das, was Sie möchten, aber gehen Sie bewusst damit um, genauso wie Sie es beim [Verwerfen von Controllern zur Vermeidung von Lecks](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) auf Routen tun würden, die wirklich kommen und gehen.

## Wann typisierte Routen daraufzusetzen sind

Alles oben verwendet string-basierte Routen. Sie sind leicht zu lesen, aber leicht zu vertippen, und ein falscher Routen-string scheitert zur Laufzeit, nicht zur Kompilierzeit. Fügen Sie für eine große App `go_router_builder` hinzu, um typsichere Routenklassen aus annotierten Definitionen zu generieren, sodass `OrderDetailRoute(id: 42).go(context)` den rohen string ersetzt und der Compiler einen fehlenden Parameter abfängt. Die Form des Routenbaums, die Shells und die Deep-Link-Konfiguration sind identisch; typisierte Routen sind eine Codegenerierungsschicht über demselben `GoRouter`. Beginnen Sie mit strings, bestätigen Sie, dass das Navigationsmodell stimmt, und führen Sie dann typisierte Routen ein, sobald die Struktur stabil ist. Wenn Sie außerdem einen Ansatz für die Zustandsverwaltung der Bildschirme wählen, die diese Routen rendern, passen die Abwägungen in [Provider vs Riverpod vs Bloc](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) natürlich zu dieser Routing-Einrichtung.

## Quellen

- [go_router-Paket auf pub.dev](https://pub.dev/packages/go_router) (Version 17.3.0, Juni 2026)
- [API der Klasse ShellRoute](https://pub.dev/documentation/go_router/latest/go_router/ShellRoute-class.html)
- [API der Klasse StatefulShellRoute](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [Deep-Linking-Thema, go_router-Dokumentation](https://pub.dev/documentation/go_router/latest/topics/Deep%20linking-topic.html)
- [Flutter-Deep-Linking-Dokumentation](https://docs.flutter.dev/ui/navigation/deep-linking)

---
title: "So halten Sie den ausgewählten Tab der NavigationBar mit StatefulShellRoute in go_router synchron zur aktuellen Route"
description: "Steuern Sie NavigationBar.selectedIndex über StatefulNavigationShell.currentIndex, nie über ein setState-Feld oder eine Kopie aus initState. Gemessen mit Flutter 3.44.8 und go_router 18.0.2: Welche Muster bei Deep Links, context.go und Cross-Branch-Pushes abweichen, warum ortsbasierte Indizes lügen und wie Sie mit didUpdateWidget auf Tab-Wechsel reagieren."
pubDate: 2026-10-11
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router"
translatedBy: "claude"
translationDate: 2026-10-11
---

**Kurze Antwort:** Speichern Sie den ausgewählten Tab nicht selbst. Innerhalb einer `StatefulShellRoute` weiß go_router bereits, welcher Branch aktiv ist, und liefert ihn als `navigationShell.currentIndex`. Reichen Sie diesen Wert bei jedem Build direkt an `NavigationBar.selectedIndex` weiter und wechseln Sie Tabs mit `navigationShell.goBranch(index)`. Ein `_selectedIndex`-Feld, das in `onDestinationSelected` aktualisiert wird, oder eine in `initState` angelegte Kopie von `currentIndex` ändert sich nur, wenn der Nutzer die Leiste antippt. Sobald ein Deep Link, ein `context.go` aus einer Seite heraus oder ein Notification-Handler die Route ändert, ist der Wert veraltet. Alles Folgende wurde mit `flutter test` auf Flutter 3.44.8 (Dart 3.12.2) und go_router 18.0.2 ausgeführt, dem aktuellen Release im Oktober 2026.

Der Fehlerbericht lautet meist so: "Ich öffne die App über einen Link auf `/profile`, und die Leiste hebt immer noch Home hervor", oder "ein Button auf der Orders-Seite schickt den Nutzer zu Settings, die Settings-Seite erscheint, aber die Leiste zeigt weiter Orders". Die Seite stimmt, die Leiste nicht, weil zwei Quellen der Wahrheit einander widersprechen: der Ort des Routers und ein Stück Widget-State, das nur die Leiste selbst aktualisiert.

## Warum Leiste und Route auseinanderlaufen

Eine `NavigationBar` ist ein einfaches Widget. Sie zeigt, was Sie ihr als `selectedIndex` geben, und ruft `onDestinationSelected` auf, wenn der Nutzer tippt. Dass ein Router existiert, weiß sie nicht. Wenn Sie den Index in einem `StatefulWidget` halten, ist der Tap-Handler der einzige Codepfad, der ihn aktualisiert, und Taps sind nur eine von vielen Möglichkeiten, wie sich die Route ändert:

- die App startet mit einem Deep Link oder einer `initialLocation`, die in den zweiten Tab zeigt
- eine Seite ruft `context.go('/profile/settings')` auf (ein "Alle anzeigen"-Link, eine Weiterleitung nach dem Login, ein Push-Notification-Handler)
- ein `redirect` schickt den Nutzer woandershin
- die Zurück-Taste des Browsers bei Flutter Web oder die Zustandswiederherstellung, nachdem das Betriebssystem den Prozess beendet hat

Keiner dieser Fälle berührt Ihr Feld `_selectedIndex`. Der Router baut die Shell mit dem neuen Branch neu auf, Ihr Scaffold baut sich mit dem alten Feldwert neu auf, und die Leiste zeigt Falsches an.

go_router löst das für Sie, solange Sie es lassen. Beim Aufbau einer `StatefulShellRoute` erzeugt es eine `StatefulNavigationShell` und berechnet `currentIndex` im Konstruktor aus dem Navigator-Key des Branches, der zum aktuellen Ort passt (siehe `route.dart` im go_router-Quellcode, `_indexOfBranchNavigatorKey`). Bei jeder Routenänderung entsteht ein neues Shell-Widget, daher ist `currentIndex` immer die eigene Antwort des Routers auf die Frage, welcher Branch gerade angezeigt wird.

## Eine minimale App, die die Abweichung reproduziert

Zwei Branches, Orders und Profile. Die Orders-Seite hat einen Button, der direkt in den Profile-Branch springt. Genau diese Art von Navigation innerhalb einer Seite bringt einen selbst gebauten Index durcheinander:

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

Und das Scaffold, das die meisten zuerst schreiben, weil so jedes `NavigationBar`-Beispiel ohne Router aussieht:

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

Eine etwas klügere Variante initialisiert das Feld aus der Shell (`_selectedIndex = widget.navigationShell.currentIndex;` in `initState`). Das behebt den Kaltstart und sonst nichts. `StatefulNavigationShell` besitzt pro Shell-Route einen stabilen Key, und Ihr Scaffold steht an derselben Stelle im Baum mit demselben Typ, daher behält Flutter seinen `State` über Routenwechsel hinweg. `initState` läuft einmal pro App-Sitzung, nicht einmal pro Navigation.

## Was jedes Muster tatsächlich anzeigt

Ich habe alle Varianten mit Widget-Tests (`tester.tap`, `GoRouter.go`, `GoRouter.push`) durchgespielt und nach `pumpAndSettle` den Wert von `NavigationBar.selectedIndex` gelesen. "Richtig" ist der Tab, zu dessen Branch die sichtbare Seite gehört.

| Szenario | Angezeigte Seite | `setState`-Feld | Kopie in `initState` | `navigationShell.currentIndex` |
| --- | --- | --- | --- | --- |
| Kaltstart bei `/profile` | Profile | 0 (falsch) | 1 | 1 |
| `context.go('/profile/settings')` aus Orders | Settings | 0 (falsch) | 0 (falsch) | 1 |
| `router.go('/profile')` von außerhalb des Widget-Baums | Profile | 0 (falsch) | 0 (falsch) | 1 |
| `context.go('/orders/42')` aus Profile | Order 42 | 0 | 1 (falsch) | 0 |
| Nutzer tippt auf Profile, dann auf Orders | Profile, Orders | 1, 0 | 1, 0 | 1, 0 |

Nur die letzte Zeile, die jeder Entwickler von Hand testet, funktioniert bei allen dreien. Der Shell-Index war in jedem Szenario richtig.

## Die Lösung: currentIndex bei jedem Build lesen

Das richtige Scaffold ist zustandslos. Es muss nichts behalten, weil der Router das tut:

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

Die Schritte der Reihe nach:

1. Lassen Sie das Shell-Scaffold die `StatefulNavigationShell` aus dem Builder der `StatefulShellRoute` entgegennehmen und als `body` rendern.
2. Setzen Sie `NavigationBar.selectedIndex` auf `navigationShell.currentIndex`. Löschen Sie jedes `_selectedIndex`-Feld und jedes `setState`, das es berührt hat.
3. Rufen Sie in `onDestinationSelected` `navigationShell.goBranch(index)` auf. Verwenden Sie nicht `context.go('/profile')`, um Tabs zu wechseln: Das funktioniert, verwirft aber den gespeicherten Stack des Branches, statt ihn wiederherzustellen.
4. Übergeben Sie `initialLocation: index == navigationShell.currentIndex`, damit ein zweiter Tap auf den aktiven Tab ihn auf die Wurzel des Branches zurücksetzt. Das erwarten iOS- und Android-Nutzer.
5. Wenn dasselbe Scaffold auf breiten Bildschirmen eine `NavigationRail` rendert, speisen Sie sie mit demselben `currentIndex`. Eine Quelle, zwei Widgets, kein Synchronisationscode.

Einen Schritt "Leiste aktualisieren, wenn sich die Route ändert" gibt es nicht. Ein Tap ruft `goBranch` auf, der Router ändert den Ort, go_router baut eine neue Shell mit neuem `currentIndex`, und die Leiste folgt. Der Tap muss lokal nicht einmal etwas neu aufbauen.

Die Anleitung vom Juni 2026 zu [verschachtelten Routen und Deep Links mit go_router](/de/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) zeigt dieselbe Verdrahtung als Teil eines vollständigen Shell-Setups. Dieser Beitrag erklärt, warum die Abkürzungen drumherum scheitern.

## Auf Tab-Wechsel reagieren, ohne den Index zu speichern

Manchmal müssen Sie wissen, wann sich der Tab geändert hat: um einen Screen View zu protokollieren, ein Video im verlassenen Tab anzuhalten oder eine Liste nach oben zu scrollen. Es ist verlockend, das Feld `_selectedIndex` "nur dafür" zurückzuholen. Sie brauchen es nicht. Machen Sie das Scaffold wieder zu einem `StatefulWidget`, vergleichen Sie aber in `didUpdateWidget` die alte mit der neuen Shell:

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

Gesteuert über `router.go('/profile')` und danach `router.go('/orders')`, protokollierte das `initState 0`, `tab changed 0 -> 1`, `tab changed 1 -> 0`. Es feuert gleichermaßen bei Taps, Deep Links und programmatischer Navigation, weil es die Antwort des Routers beobachtet und nicht die Eingabe der Leiste. Halten Sie die Arbeit in `didUpdateWidget` billig und frei von Navigation: `goBranch` aus einem Callback der Build-Phase aufzurufen ist ein sicherer Weg zu [setState() or markNeedsBuild() called during build](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

## Stolperfallen und Sonderfälle

### Den Index aus dem Ort abzuleiten lügt nach einem Cross-Branch-Push

Das andere verbreitete Muster, übernommen vom einfachen `ShellRoute`, berechnet den Index aus der URL: `state.uri.path.startsWith('/profile') ? 1 : 0`. Es übersteht Deep Links und `context.go`, weshalb ihm viele vertrauen. Bei `push` bricht es.

Wenn die Profile-Seite `context.push('/orders/42')` aufruft, legt go_router 18.0.2 die Bestellseite auf den Navigator des *aktuellen* Branches. Ich habe das in einem Test geprüft: Die gepushte Seite liegt innerhalb des Shell-Scaffolds, `currentIndex` bleibt 1, und nach dem Wechsel zu Orders und zurück zu Profile zeigt der Profile-Tab weiterhin Order 42 oben auf seinem Stack. Der Ort ist jedoch jetzt `/orders/42`, sodass die aus dem Ort abgeleitete Leiste Orders hervorhebt, während sich der Nutzer im Profile-Stack befindet. Tippt man auf Orders, landet man im Orders-Branch und nicht auf der Seite, die man gerade angesehen hat. `currentIndex` meldete die ganze Zeit 1, was dem tatsächlichen Ort der Seite entspricht.

Wenn eine Bestelldetailseite unter dem Orders-Tab öffnen soll, verwenden Sie `context.go('/orders/42')` (das wechselt den Branch, und `currentIndex` wird 0). Wenn sie oben auf dem aktuellen Tab liegen soll, ist `push` in Ordnung. In beiden Fällen sollte `currentIndex` entscheiden, welcher Tab leuchtet.

### Ein einfaches ShellRoute hat kein currentIndex

Ein nicht zustandsbehaftetes `ShellRoute` liefert einen einzelnen verschachtelten Navigator und ein `child`, ohne Branches und ohne Index. Dort müssen Sie den Ort selbst auf einen Tab abbilden. Tun Sie das über den `GoRouterState` des Builders (oder `GoRouterState.of(context)`) und vergleichen Sie mit `uri.path`, nicht mit `matchedLocation`. Nach `push('/orders/7')` von `/profile` aus meldete der State der Shell in meinem Test `uri=/orders/7`, `fullPath=/orders/:id` und `matchedLocation=/profile`. Der Vorbehalt zu `push` aus dem vorigen Abschnitt gilt auch hier, und er ist ein weiterer Grund, Tab-Layouts auf `StatefulShellRoute.indexedStack` umzustellen, wenn jeder Tab außerdem seinen eigenen Back-Stack behalten soll (der [Vergleich von go_router, auto_route und Navigator 2.0](/de/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) zeigt, was jeder Router für Tabs bietet).

### Vollbild-Routen im Root-Navigator

Ein Checkout oder ein Medienbetrachter liegt oft unter dem Pfad eines Branches, soll aber die Leiste überdecken und wird deshalb mit `parentNavigatorKey: rootNavigatorKey` deklariert. Beim Pushen aus Profile blieb `currentIndex` bei 1, ohne dass ein Scaffold auf der Bühne stand, und das Zurückgehen führte zu Profile mit dem richtigen leuchtenden Tab. Der direkte Aufruf mit `router.go('/orders/checkout')` baute die Shell darunter mit `currentIndex` 0 auf, weil die Route zum Orders-Branch gehört. In beiden Fällen stimmt die Leiste, wenn sie wieder erscheint, ganz ohne Code.

### Ein Branch ohne Ziel in der Leiste

Es kommt häufig vor, dass ein Branch nur per Link erreichbar ist, zum Beispiel ein Inbox-Branch, der aus einer Benachrichtigung geöffnet wird und kein Symbol in der Leiste hat. `currentIndex` ist dann 2 bei zwei Zielen, und `NavigationBar` prüft in Debug-Builds per Assertion `0 <= selectedIndex && selectedIndex < destinations.length`. Bilden Sie Branches daher explizit auf Ziele ab, statt den Index durchzureichen:

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

`NavigationRail.selectedIndex` ist nullbar, daher können Sie bei einer Rail `null` zurückgeben und für versteckte Branches keine Auswahl anzeigen.

### Tabs zur Laufzeit umordnen oder ausblenden

Wenn sich die Ziele aufgrund eines Feature Flags oder der Rolle des Nutzers ändern, ändert sich die Branch-Liste im Router in der Regel nicht. Halten Sie die Branch-Indizes fest und bilden Sie sie wie oben über eine Tabelle ab. Die Branches selbst im laufenden Betrieb zu ändern bedeutet eine neue Router-Konfiguration, und der Changelog von go_router 18.0.2 erwähnt einen Fix dafür, dass gepushte Routen in einer Shell verloren gingen, wenn sich eine dynamische Routing-Konfiguration ändert. Bleiben Sie in diesem Fall also bei 18.0.2 oder neuer.

### Die Synchronisation testen

Jedes Szenario in der Tabelle oben ist ein günstiger Widget-Test. Bauen Sie eine `MaterialApp.router` mit Ihrem echten Router, starten Sie sie mit `initialLocation` an einem Deep Link, rufen Sie im Test `router.go(...)` auf und prüfen Sie `tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex`. Wenn Ihre Tabs zeitabhängige Inhalte zeigen, kombinieren Sie das mit dem Ansatz aus [Flutter-Widget zu einem festen Zeitpunkt testen](/de/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/), damit die Assertions deterministisch sind. Ein Test pro Navigationseinstieg (Deep Link, `go` innerhalb einer Seite, Notification-Handler) fängt die Abweichung ab, bevor es ein Nutzer tut.

## Die Faustregel

Wenn Sie in einer go_router-Shell `setState` neben einer `NavigationBar` schreiben, halten Sie inne. Der Router besitzt den Ort, der Ort bestimmt den Branch, und `StatefulNavigationShell.currentIndex` ist diese Entscheidung. Lesen Sie ihn, kopieren Sie ihn nie, und die Leiste kann nicht aus dem Takt geraten, egal wie der Nutzer dorthin gekommen ist.

## Quellen

- [go_router 18.0.2 auf pub.dev](https://pub.dev/packages/go_router) und der zugehörige [Changelog](https://pub.dev/packages/go_router/changelog)
- [API der Klasse StatefulShellRoute](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [API der Klasse StatefulNavigationShell](https://pub.dev/documentation/go_router/latest/go_router/StatefulNavigationShell-class.html) (`currentIndex`, `goBranch`)
- [go_router-Quellcode: `lib/src/route.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/route.dart)
- [Offizielles StatefulShellRoute-Beispiel](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/stateful_shell_route.dart)
- [API der Klasse NavigationBar](https://api.flutter.dev/flutter/material/NavigationBar-class.html)

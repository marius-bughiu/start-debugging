---
title: "Wie man ein Future so initialisiert, dass FutureBuilder es nicht bei jedem Rebuild neu erstellt in Flutter"
description: "FutureBuilder fuehrt Ihre asynchrone Arbeit bei jedem Rebuild des Elternteils erneut aus, weil Sie das Future innerhalb von build erstellt haben. Verlagern Sie es nach State.initState (oder memoizen Sie es), und FutureBuilder verwendet dasselbe Future erneut. Hier das Warum, der reproduzierbare Fall und jede Variante, die beisst."
pubDate: 2026-06-09
template: how-to
tags:
  - "flutter"
  - "dart"
  - "futurebuilder"
  - "how-to"
lang: "de"
translationOf: "2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-09
---

Wenn Ihr `FutureBuilder` zum Ladeindikator zurueckspringt, Daten erneut abruft oder denselben Netzwerkaufruf mehrfach ausloest, ist die Ursache fast immer, dass Sie das `Future` innerhalb von `build` erstellt haben. Jeder Rebuild des umgebenden Widgets ruft dann `build` erneut auf, konstruiert ein voellig neues `Future`, und `FutureBuilder` startet es pflichtbewusst neu. Die Loesung ist, das `Future` genau einmal zu erstellen, es in einem Feld Ihres `State` zu speichern und dieses gespeicherte Feld an `FutureBuilder` zu uebergeben. Diese Anleitung verwendet Flutter 3.44 (stabil, Mai 2026) und Dart 3.x.

Das Flutter-Team ist diesbezueglich in der [FutureBuilder-API-Dokumentation](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html) eindeutig: "The future must have been obtained earlier, e.g. during State.initState, State.didUpdateWidget, or State.didChangeDependencies. It must not be created during the State.build or StatelessWidget.build method call when constructing the FutureBuilder." Die Begruendung folgt sofort: "If the future is created at the same time as the FutureBuilder, then every time the FutureBuilder's parent is rebuilt, the asynchronous task will be restarted." Das ist der gesamte Fehler, vom Framework selbst formuliert.

## Warum ein frisches Future das Ganze neu startet

`FutureBuilder` verfolgt nicht "die Operation, die Sie ausfuehren wollten". Es verfolgt ein bestimmtes `Future`-Objekt anhand der Identitaet. In `didUpdateWidget` vergleicht es `oldWidget.future` mit dem neuen `widget.future`. Sind sie nicht dieselbe Instanz, verwirft es die alte Subscription, setzt seinen `AsyncSnapshot` auf `ConnectionState.waiting` (oder `none`) zurueck und abonniert das neue. Es gibt keine wertbasierte Deduplizierung und keine eingebaute Memoization. Identitaet ist das einzige Signal, das es hat.

Bedenken Sie nun, was `build` tut. Der Aufruf von `etwas()`, das ein `Future` zurueckgibt, erzeugt bei jeder Invokation eine neue `Future`-Instanz, selbst wenn die zugrunde liegende Arbeit identisch ist. `Future.delayed(...)`, `http.get(...)`, `repository.load()`: jeder Aufruf alloziert ein eigenes Objekt. Wenn das `future:`-Argument also ein innerhalb von `build` ausgewerteter Ausdruck ist, sieht `FutureBuilder` bei jedem Frame eine andere Identitaet und schliesst, nach seinen eigenen Regeln korrekt, dass Sie ihm eine neue Aufgabe uebergeben haben.

Und `build` laeuft weit haeufiger, als man erwartet. Ein `setState` des Elternteils, ein sich aenderndes Inherited Widget (`MediaQuery` bei Rotation, `Theme` beim Umschalten der Helligkeit), ein `Scaffold`, das eine Tastatur oeffnet, eine Animation eines Vorfahren, ein Hot Reload: jedes davon baut Ihr Widget neu und wertet den `future:`-Ausdruck erneut aus. Die asynchrone Arbeit ist nicht langsam oder kaputt. Sie wird jedes Mal verworfen und von Grund auf neu gestartet.

## Ein minimaler reproduzierbarer Fall, der bei jedem Rebuild neu abruft

Hier das Antipattern in seiner reinsten Form. Das `Future` wird inline in `build` konstruiert, und ein Zaehler erzwingt Rebuilds, damit Sie das Fehlverhalten beobachten koennen.

```dart
// Flutter 3.44, Dart 3.x
// BROKEN: future is created inside build()
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  int _counter = 0;

  Future<String> _loadName() async {
    // Pretend this is a network call.
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          // New Future every build -> restarts every rebuild.
          future: _loadName(),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Tippen Sie auf den Button. Jeder Tipp ruft `setState` auf, das `build` aufruft, das `_loadName()` erneut aufruft, das ein neues Zwei-Sekunden-`Future` zurueckgibt. Der Indikator kehrt bei jedem Tipp zurueck. In einer echten App, in der `_loadName()` eine HTTP-Anfrage ist, haben Sie gerade aus einem Abruf einen Abruf-pro-Rebuild gemacht, und der Benutzer sieht, wie der Bildschirm wiederholt weiss aufblitzt. Das ist dieselbe Fehlerfamilie wie [setState waehrend build aufzurufen](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/): in `build` Arbeit zu verrichten, die `build` nicht besitzen darf.

## Die Loesung, Schritt fuer Schritt

Verlagern Sie das `Future` aus `build` heraus in ein Feld, das genau einmal initialisiert wird.

1. **Wandeln Sie das Widget in ein `StatefulWidget` um**, falls es noch keines ist. Ein `StatelessWidget` hat kein `initState` und keinen Ort, um ein `Future` dauerhaft zu halten, sodass es die Regel "vorher beschafft" nicht erfuellen kann. (Mehr zum zustandslosen Fall weiter unten.)
2. **Deklarieren Sie ein `late final Future<T>`-Feld** in der `State`-Klasse. `late final` erlaubt die Zuweisung in `initState` und garantiert, dass es genau einmal geschrieben wird.
3. **Weisen Sie das Feld in `initState` zu** und rufen Sie Ihre asynchrone Methode dort statt in `build` auf. `initState` laeuft einmalig fuer die Lebensdauer des `State`, egal wie oft das Widget neu baut.
4. **Uebergeben Sie das gespeicherte Feld an `FutureBuilder`**, niemals einen Inline-Aufruf. Das `future:`-Argument wird zu einer einfachen Feldreferenz ohne Klammern.
5. **Verifizieren Sie mit einem erzwungenen Rebuild**: loesen Sie `setState` wiederholt aus und bestaetigen Sie, dass der Indikator nicht zurueckkehrt und die Arbeit nicht erneut laeuft.

Auf den reproduzierbaren Fall angewendet:

```dart
// Flutter 3.44, Dart 3.x
// FIXED: future is created once in initState
class _ProfilePageState extends State<ProfilePage> {
  late final Future<String> _nameFuture;
  int _counter = 0;

  @override
  void initState() {
    super.initState();
    _nameFuture = _loadName(); // created exactly once
  }

  Future<String> _loadName() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    return 'Marius';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        FutureBuilder<String>(
          future: _nameFuture, // same instance every build
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const CircularProgressIndicator();
            }
            return Text('Hello, ${snapshot.data}');
          },
        ),
        ElevatedButton(
          onPressed: () => setState(() => _counter++),
          child: Text('Rebuilt $_counter times'),
        ),
      ],
    );
  }
}
```

Jetzt erhoeht der Button den Zaehler, `build` laeuft erneut, aber `future: _nameFuture` zeigt auf die identische `Future`-Instanz, die zuvor in `initState` erstellt wurde. `FutureBuilder.didUpdateWidget` sieht `oldWidget.future == widget.future`, behaelt seine bestehende Subscription und setzt den Snapshot nie zurueck. Der Abruf geschieht einmal. Das ist das kanonische Muster und deckt die grosse Mehrheit der realen Faelle ab.

## Wenn das Future von einem Widget-Parameter abhaengt

Der `initState`-Ansatz hat eine scharfe Kante: `initState` kann keinen neuen Wert von `widget` sehen. Wenn Ihr `Future` von einer `widget.userId` abhaengt, die das Elternteil aendern kann, bedeutet eine Initialisierung nur in `initState`, dass die Daten veralten, wenn das Elternteil eine andere id uebergibt, weil das `State`-Objekt ueber diese Aenderung hinweg wiederverwendet wird.

Die eigene Liste der zugelassenen Orte des Frameworks hat die Antwort bereits benannt: `State.didUpdateWidget`. Erstellen Sie das `Future` dort neu, aber nur, wenn sich die relevante Eingabe tatsaechlich geaendert hat, damit Sie den Neustart-pro-Rebuild nicht wieder einfuehren.

```dart
// Flutter 3.44, Dart 3.x
class _UserPageState extends State<UserPage> {
  late Future<User> _userFuture;

  @override
  void initState() {
    super.initState();
    _userFuture = _fetchUser(widget.userId);
  }

  @override
  void didUpdateWidget(covariant UserPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only refetch when the id genuinely changed.
    if (oldWidget.userId != widget.userId) {
      _userFuture = _fetchUser(widget.userId);
    }
  }

  Future<User> _fetchUser(String id) async {
    // ...network call keyed by id...
    return User(id: id);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<User>(
      future: _userFuture,
      builder: (context, snapshot) {
        // ...render data / loading / error...
        return const SizedBox.shrink();
      },
    );
  }
}
```

Die Schutzbedingung `if (oldWidget.userId != widget.userId)` ist der ganze Punkt. Ohne sie wuerden Sie wieder bei jedem Rebuild des Elternteils neu abrufen, nur eine Ebene weiter weg vom urspruenglichen Fehler. Wenn Ihr `Future` von einem `InheritedWidget` abhaengt (ein ueber `context.dependOnInheritedWidgetOfExactType` gelesener Wert, etwa ein `Locale` oder ein Provider-Scope), verwenden Sie `didChangeDependencies` mit derselben Aenderungserkennung, da dies der Callback ist, den Flutter ausloest, wenn sich eine geerbte Abhaengigkeit aendert.

## Ein bewusstes Neuladen erzwingen

Das Verlagern des `Future` in ein Feld wirft eine offensichtliche Frage auf: wie laedt man absichtlich neu, etwa bei Pull-to-Refresh? Weisen Sie das Feld innerhalb von `setState` neu zu. Das gibt `FutureBuilder` eine neue Identitaet genau dann, wenn Sie es beabsichtigen.

```dart
// Flutter 3.44, Dart 3.x
void _refresh() {
  setState(() {
    _nameFuture = _loadName(); // new instance, intentional restart
  });
}
```

Das ist die kontrollierte Version des kaputten Musters: das neue `Future` wird als Reaktion auf eine Benutzeraktion erstellt, nicht als Nebeneffekt eines unzusammenhaengenden Rebuilds. Kombinieren Sie es mit einem `RefreshIndicator`, dessen `onRefresh` das neue Future zurueckgibt, damit der Indikator bestehen bleibt, bis der Abruf aufloest. Waehrend Sie das Neuladen verdrahten, entscheiden Sie, wie der Builder ein fehlgeschlagenes Neuladen darstellt; die Muster aus [Netzwerkfehler in einer Flutter-App elegant behandeln](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) gelten direkt fuer den `snapshot.hasError`-Zweig.

## Memoization ohne den initState-Boilerplate zu schreiben

Wenn Sie viele davon pflegen und die Zeremonie aus `initState` plus `didUpdateWidget` Sie stoert, fasst der `AsyncMemoizer` des `async`-Pakets sie zusammen: er fuehrt einen Callback hoechstens einmal aus und gibt bei nachfolgenden Aufrufen dasselbe `Future` zurueck, sodass selbst ein Inline-Aufruf in `build` zu einer einzigen zugrunde liegenden Operation aufloest.

```dart
// Flutter 3.44, Dart 3.x
// package: async ^2.11
import 'package:async/async.dart';

class _CatalogPageState extends State<CatalogPage> {
  final _memoizer = AsyncMemoizer<List<Item>>();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Item>>(
      // runOnce returns the SAME future after the first call.
      future: _memoizer.runOnce(() => _repository.loadItems()),
      builder: (context, snapshot) => const SizedBox.shrink(),
    );
  }
}
```

`runOnce` fuehrt seinen Callback beim ersten Mal aus und cacht das resultierende `Future`; spaetere Aufrufe ignorieren den neuen Callback und geben das gecachte zurueck. Der Memoizer lebt weiterhin im `State`, teilt also dieselben Lebensdauer-Garantien wie ein `late final`-Feld. Fuer den parameterabhaengigen Fall muessten Sie pro id einen frischen Memoizer schluesseln, was mehr Buchhaltung ist als `didUpdateWidget`, greifen Sie also vor allem dann zu `AsyncMemoizer`, wenn die Operation keine Eingaben hat.

## Warum ein StatelessWidget das nicht beheben kann

Ein `StatelessWidget` hat kein `initState`, kein `State` und keinen stabilen Ort, um ein `Future` zu verstauen. Jedes Feld, das Sie hinzufuegen, wird neu erstellt, wann immer das Elternteil das Widget neu baut, weil Flutter `StatelessWidget`-Instanzen frei verwirft und neu konstruiert. Die Regel "erstelle es vorher" ist in einem `StatelessWidget` also nicht erfuellbar: der frueheste Zeitpunkt, an dem Sie das `Future` erstellen koennen, ist `build`, genau der Ort, den die Dokumentation verbietet. Wenn Sie feststellen, dass Sie ein langlebiges `Future` in einem `StatelessWidget` wollen, ist das das Signal, es entweder zu einem `StatefulWidget` hochzustufen oder das `Future` in eine Zustandsverwaltungsschicht zu heben, die das Widget vollstaendig ueberlebt.

Diese zweite Option ist zunehmend die idiomatische. Ein `FutureProvider` oder `AsyncNotifier` von Riverpod cacht sein `Future` fuer Sie und berechnet nur neu, wenn sich eine Abhaengigkeit aendert, was den manuellen `initState`-Tanz entfernt und Widget-Rebuilds und sogar Routenwechsel ueberlebt. Wenn Sie einen langfristigen Ansatz waehlen, statt einen Bildschirm zu flicken, sind die Kompromisse in [Provider vs Riverpod vs Bloc fuer Flutter-Zustandsverwaltung 2026](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) dargelegt, und die Drei-Zustands-Darstellung, die Sie vom `AsyncValue` eines Providers erhalten, wird in [Lade- und Fehlerzustaende mit AsyncValue in Flutter Riverpod anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) behandelt.

## Zwei verwandte Fallstricke, die das Feldmuster nicht loest

Das Verlagern des `Future` behebt den Neustart, aber zwei angrenzende Probleme ueberleben. Erstens kann ein `FutureBuilder` in einer scrollbaren Liste, die `AutomaticKeepAliveClientMixin` falsch verwendet, weiterhin neu bauen, wenn die Zeile zurueck ins Sichtfeld scrollt; das `Future`-Feld schuetzt die Daten, aber stellen Sie sicher, dass der Zeilenzustand selbst am Leben gehalten wird, wenn Sie ein Rebuild-Flackern vermeiden wollen. Zweitens versucht ein `Future`, das nach dem Verschwinden des Widgets abschliesst, in ein bereits verworfenes `State` zu liefern. `FutureBuilder` selbst schuetzt intern vor `setState`-nach-Dispose, aber wenn Ihre asynchrone Methode beim Aufloesen andere Controller beruehrt, koennen Sie weiterhin auf Lebenszyklusfehler stossen. Die Dispose-Disziplin aus [Controller in Flutter entsorgen, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) ist die begleitende Gewohnheit: besitzen Sie jede Ressource, die Sie erstellen, und geben Sie sie in `dispose` frei.

Das mentale Modell zum Behalten: `FutureBuilder` ist ein duenner Adapter, der ein `Future` anhand der Identitaet beobachtet. Es ist Ihre Aufgabe, diese Identitaet stabil zu machen. Erstellen Sie das `Future` in `initState`, aktualisieren Sie es in `didUpdateWidget` oder `didChangeDependencies` nur, wenn sich eine Eingabe geaendert hat, und weisen Sie es in `setState` nur neu zu, wenn der Benutzer frische Daten angefordert hat. Tun Sie das, und der Indikator erscheint genau einmal, das Netzwerk wird genau einmal angesprochen, und der Bildschirm hoert auf zu flackern.

## Quellen

- [FutureBuilder class - widgets library](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html): die Regel "must have been obtained earlier" und die Neustart-Warnung, oben zitiert.
- [State.initState method](https://api.flutter.dev/flutter/widgets/State/initState.html): laeuft einmal pro State-Lebensdauer.
- [State.didUpdateWidget method](https://api.flutter.dev/flutter/widgets/State/didUpdateWidget.html): der Hook, um auf geaenderte Widget-Konfiguration zu reagieren.
- [AsyncMemoizer class - async package](https://pub.dev/documentation/async/latest/async/AsyncMemoizer-class.html): fuehrt einen Callback hoechstens einmal aus.

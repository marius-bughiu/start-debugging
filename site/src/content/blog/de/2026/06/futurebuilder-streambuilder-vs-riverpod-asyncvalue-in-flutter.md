---
title: "FutureBuilder/StreamBuilder vs AsyncValue von Riverpod in Flutter: was sollten Sie verwenden?"
description: "Verwenden Sie FutureBuilder oder StreamBuilder fuer ein in sich geschlossenes, wegwerfbares asynchrones Widget. Greifen Sie zu AsyncValue von Riverpod, sobald das Ergebnis geteilt, gecacht oder mutiert wird. Hier sind die Entscheidung, die Fallstricke und ausfuehrbarer Code fuer beide. Getestet mit Flutter 3.44 und flutter_riverpod 3.3.1."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "futurebuilder"
lang: "de"
translationOf: "2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-15
---

Wenn Sie sich zwischen den eingebauten `FutureBuilder` / `StreamBuilder` von Flutter und dem `AsyncValue` von Riverpod entscheiden, lautet die kurze Antwort: Behalten Sie die Builder fuer ein einzelnes, in sich geschlossenes Widget, das ein wegwerfbares asynchrones Ergebnis besitzt, und wechseln Sie zu `AsyncValue` von Riverpod in dem Moment, in dem dieses Ergebnis ueber Bildschirme hinweg geteilt, gecacht, aktualisiert oder mutiert wird. Die Builder sind nicht "die Anfaengerversion" derselben Sache. Sie sind eine UI-Primitive, die ein asynchrones Objekt abonniert. `AsyncValue` ist ein Zustandsmodell, das ausserhalb des Widget-Baums lebt. Diese Anleitung wurde mit Flutter 3.44 (stabil, 2026-05-18), Dart 3.12 und `flutter_riverpod` 3.3.1 getestet (die 3.0-Linie erschien am 2025-09-10).

## Sie loesen ueberlappende Probleme auf unterschiedlichen Ebenen

`FutureBuilder` und `StreamBuilder` sind Widgets. Sie uebergeben jedem ein `Future` oder `Stream`, und es gibt Ihrem `builder`-Callback ein `AsyncSnapshot<T>`, das den aktuellen Verbindungszustand (waiting, active, done) plus die neuesten Daten oder den Fehler beschreibt. Das Widget abonniert beim Einfuegen, kuendigt beim Entfernen und abonniert erneut, wenn Sie eine andere `Future`/`Stream`-Instanz uebergeben. Das ist der gesamte Vertrag. Es gibt kein Caching, kein Teilen und kein Gedaechtnis fuer das Ergebnis, sobald das Widget den Baum verlaesst.

Das `AsyncValue<T>` von Riverpod ist ueberhaupt kein Widget. Es ist eine versiegelte Union mit drei Untertypen (`AsyncData`, `AsyncLoading`, `AsyncError`), die ein Provider als seinen Wert bereitstellt. Die asynchrone Arbeit laeuft innerhalb eines Providers, der ausserhalb des Widget-Baums lebt, sodass jedes Widget sie lesen kann, mehrere Widgets dieselbe Instanz lesen koennen und das Ergebnis Neuaufbauten und die Navigation ueberlebt. Sie rendern es mit `value.when(...)` oder einem Dart-3-`switch`, genauso wie Sie ein `AsyncSnapshot` rendern, aber die Quelle der Wahrheit ist ein Provider statt eines Widget-Felds.

Die eigentliche Frage ist also nicht "was rendert drei Zustaende besser". Beide rendern drei Zustaende gut. Die Frage ist, wo das asynchrone Ergebnis leben soll und wie viele Dinge es sehen muessen.

## Funktionsmatrix

| Aspekt | FutureBuilder / StreamBuilder (Flutter 3.44) | AsyncValue von Riverpod (flutter_riverpod 3.3.1) |
| --- | --- | --- |
| Was es ist | Ein Widget, das ein Future/Stream abonniert | Ein versiegelter Zustandstyp, den ein Provider bereitstellt |
| Wo das Ergebnis lebt | Im Widget, stirbt beim Aushaengen des Widgets | In einem Provider, ausserhalb des Baums, ueberlebt die Navigation |
| Teilen ueber Bildschirme | Nein, jeder Builder fuehrt seine eigene Arbeit erneut aus | Ja, ein Provider von vielen Widgets gelesen |
| Caching / Dedup | Keines, Sie memoisieren das Future selbst | Eingebaut, der Provider cacht bis zur Invalidierung |
| Ausloesung bei jedem Neuaufbau | Ja, wenn das Future in `build` erstellt wird | Nein, der `build` des Providers laeuft einmal bis zur Invalidierung |
| Loading + vorherige Daten | Manuell, der Snapshot verliert `data` waehrend des Wartens | `value.isLoading` behaelt `value` waehrend der Aktualisierung |
| Mutationen / Aktualisierung | Future neu zuweisen und `setState` | `ref.invalidate` oder `AsyncValue.guard` in einem Notifier |
| Testen ohne ein Widget | Schwierig, braucht `pumpWidget` | Einfach, lesen Sie den Provider in einem einfachen `ProviderContainer` |
| Abhaengigkeiten | Null, kommt mit dem SDK | Paket `flutter_riverpod` |
| Boilerplate-Zeilen fuer Einmaliges | Minimal | Mehr Einrichtung fuer einen einzelnen wegwerfbaren Aufruf |

## Wann FutureBuilder oder StreamBuilder die richtige Wahl ist

Greifen Sie zu den eingebauten Buildern, wenn das asynchrone Ergebnis wirklich zu einem Widget gehoert und niemand sonst es braucht.

- **Ein in sich geschlossenes Blatt-Widget.** Ein Dialog, der einen Datensatz laedt, ein Tile, das eine Bilddimension aufloest, eine Einstellungszeile, die eine einzelne Praeferenz liest. Die Arbeit beginnt, wenn das Widget erscheint, und ist irrelevant, sobald es weg ist. Das in einen Provider zu verpacken ist Zeremonie ohne Nutzen.
- **Ein Stream, den Sie bereits besitzen und direkt rendern wollen.** Wenn Sie einen `Stream` von einem Plugin halten (einen Positions-Stream von `Geolocator`, einen Status-Stream von `connectivity_plus`) und ihn nur an einer Stelle anzeigen, ist `StreamBuilder` der direkteste Weg. Der `StreamBuilder` von Flutter 3.44 uebernimmt den Abonnier-/Abmeldelebenszyklus fuer Sie.
- **Null hinzugefuegte Abhaengigkeiten.** Eine kleine App, ein Codebeispiel, ein Paketbeispiel oder ein Bildschirm in einer Codebasis, die bewusst eine Bibliothek zur Zustandsverwaltung vermieden hat. Die Builder sind Teil des SDK, also gibt es nichts hinzuzufuegen.
- **Sie unterrichten oder prototypisieren.** Die Builder machen die Abbildung von asynchron zu UI an einer Stelle sichtbar. Diese Klarheit ist viel wert, wenn das Ziel darin besteht, den Lebenszyklus zu verstehen, statt eine Funktion auszuliefern.

Hier ist die korrekte Form. Das `Future` wird einmal in `initState` erstellt, nicht in `build`, sodass das Widget nicht bei jedem Neuaufbau des Eltern-Widgets erneut abruft.

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

Der haeufigste Bug bei diesem Widget ist, das `Future` inline zu erstellen, wie `future: api.fetchUser(widget.id)` direkt in `build`. Jeder Neuaufbau allokiert dann ein neues `Future`, `FutureBuilder` sieht eine neue Identitaet und startet erneut aus dem Loading-Zustand. Dieser Fehlermodus ist haeufig genug, um einen eigenen Beitrag zu haben: siehe [warum FutureBuilder sein Future bei jedem Neuaufbau neu erstellt](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) fuer die vollstaendige Reproduktion und jede Variante, die ihn ausloest.

## Wann AsyncValue von Riverpod die richtige Wahl ist

Wechseln Sie zu `AsyncValue`, wenn das asynchrone Ergebnis aufhoert, ein privates Detail eines Widgets zu sein.

- **Das Ergebnis wird geteilt.** Zwei Bildschirme zeigen dasselbe Benutzerprofil, oder ein Header und ein Body lesen beide den aktuellen Warenkorb. Mit Buildern fuehrt jeder Abonnent den Abruf erneut aus. Mit einem Provider laeuft die Arbeit einmal und beide Widgets lesen dasselbe `AsyncValue`.
- **Sie brauchen Caching und Dedup.** Riverpod cacht den Wert eines Providers, bis etwas ihn invalidiert. Navigieren Sie weg und zurueck, und die Daten sind noch da, statt einen Spinner aufblitzen zu lassen. Die 3.0-Linie fuegt sogar `AsyncValue.isFromCache` hinzu, sodass die UI Serverdaten von offline-persistierten Daten unterscheiden kann.
- **Sie mutieren und aktualisieren.** Ein Pull-to-Refresh, ein optimistisches Update, ein erneuter Versuch. `ref.invalidate(provider)` fuehrt das Laden erneut aus, und waehrend dieses Neuladens ist `value.isLoading` `true`, waehrend `value.hasValue` `true` bleibt, sodass Sie weiterhin die alten Daten anzeigen, statt den Bildschirm leer zu machen. Das mit `FutureBuilder` zu tun bedeutet, mit einem gespeicherten `Future`, einem `setState` und Ihrer eigenen Logik fuer "vorherige Daten behalten" zu jonglieren.
- **Sie wollen testen, ohne ein Widget aufzubauen.** Die Logik eines Providers kann in einem einfachen `ProviderContainer` ohne `WidgetTester`, ohne `pumpWidget` und ohne einen falschen `BuildContext` ausgefuehrt werden.

Dasselbe Rendern dreier Zustaende, jetzt aus einem Provider bezogen:

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

Zwei Widgets, die `ref.watch(userProvider('42'))` aufrufen, teilen einen Abruf und ein gecachtes Ergebnis. Es gibt kein `initState`, kein gespeichertes Feld und keine Disziplin "das Future einmal erstellen", an die man sich erinnern muss, weil der Provider seinen `build` bereits genau einmal pro Argument ausfuehrt, bis er invalidiert wird. Fuer die vollstaendige Menge an Zustaenden, Mutationen mit `AsyncValue.guard` und das Behalten vorheriger Daten bei der Aktualisierung siehe [wie man Loading- und Fehlerzustaende mit AsyncValue anzeigt](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Das Verhalten bei Neuaufbau und erneutem Abruf, das tatsaechlich entscheidet

Performance ist hier nicht die Achse. Beide Ansaetze rendern mit derselben Bildrate. Was sich unterscheidet, ist, wie oft Ihre asynchrone Arbeit laeuft, und das ist eine Frage der Korrektheit und der Kosten, nicht der reinen Geschwindigkeit.

Setzen Sie einen Zaehler in den asynchronen Aufruf und beobachten Sie, was passiert, wenn das umgebende Widget neu aufgebaut wird (ein Themenwechsel, eine sich oeffnende Tastatur, ein `setState` des Eltern-Widgets):

- **Future in `build` mit FutureBuilder erstellt**: Der Abruf wird bei jedem Neuaufbau ausgeloest. Ein Bildschirm, der waehrend eines Scrollvorgangs zehnmal neu aufgebaut wird, macht zehn Netzwerkaufrufe. Das ist der Standardfehler, kein Randfall.
- **Future in `initState` mit FutureBuilder ausgelagert**: Der Abruf wird einmal pro Widget-Instanz ausgeloest. Navigieren Sie weg und zurueck, das Widget wird von Grund auf neu aufgebaut und ruft erneut ab, weil der alte `State` weg ist.
- **FutureProvider mit AsyncValue**: Der Abruf wird einmal pro Provider-Argument ausgeloest und gecacht. Neuaufbauten fuehren ihn nicht erneut aus. Wegnavigieren und zurueck liest den Cache. Er laeuft nur erneut, wenn Sie ihn invalidieren oder sich seine Abhaengigkeiten aendern.

Wenn Ihre asynchrone Arbeit ein billiges lokales Lesen ist, spielt nichts davon eine Rolle und der Builder gewinnt durch Einfachheit. Wenn es ein Netzwerkaufruf, eine Datenbankabfrage oder irgendetwas mit Kosten oder einem Ratenlimit ist, ist das Caching der ganze Grund, warum `AsyncValue` existiert, und dasselbe Verhalten von Hand um `FutureBuilder` herum nachzubauen reimplementiert eine schlechtere Version des Provider-Caches von Riverpod.

## Der Fallstrick, der fuer Sie entscheidet

Einige Einschraenkungen klaeren die Entscheidung unabhaengig vom Geschmack.

**Sie verwenden bereits Riverpod.** Wenn die App Provider hat, mischen Sie keinen `FutureBuilder` in einen Bildschirm, der sie liest. Die Daten eines Providers zu lesen und dann einen zweiten `FutureBuilder` um einen anderen asynchronen Aufruf zu wickeln, gibt Ihnen zwei unzusammenhaengende Lebenszyklen auf einem Bildschirm und zwei Stellen, an denen "loading" true sein kann. Stellen Sie den zweiten Aufruf ebenfalls als Provider bereit und rendern Sie beide mit `AsyncValue`. Konsistenz hier verhindert die Klasse von Bugs, bei denen eine Haelfte des Bildschirms veraltet ist.

**Das Ergebnis muss das Widget ueberleben.** Alles, was in `initState` abgerufen wird, stirbt mit dem `State`. Wenn der Benutzer vorwaerts und zurueck navigiert und Sie nicht jedes Mal einen frischen Spinner und einen frischen Netzwerkaufruf wollen, brauchen Sie einen Cache, der ueber dem Widget lebt. Das ist ein Provider. `FutureBuilder` kann Ihnen keine routenuebergreifende Persistenz geben, egal wie Sie es arrangieren.

**Sie greifen nach einem await auf `ref` zu.** Das ist eine Riverpod-spezifische Falle, kein Grund, es zu vermeiden: Wenn Sie innerhalb eines Notifiers `await` machen und dann `ref` lesen, nachdem das Widget, das ihn ausgeloest hat, weg ist, treffen Sie auf `Cannot use "ref" after the widget was disposed`. Die Loesung besteht darin, das, was Sie brauchen, vor dem await zu erfassen. Es lohnt sich, das zu wissen, bevor Sie sich festlegen, und es wird in [der Loesung fuer die Verwendung von ref nach dem Verwerfen](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/) behandelt.

**Sie wollen ausdruecklich null Abhaengigkeiten.** Ein Pub-Paketbeispiel, ein Reproduktionsfall oder eine Teamrichtlinie gegen Bibliotheken zur Zustandsverwaltung erzwingt die Builder. Das ist eine legitime Einschraenkung, und die Builder sind fuer in sich geschlossene asynchrone UI vollkommen geeignet.

## StreamBuilder hat eine zusaetzliche Feinheit

Alles oben Genannte gilt fuer `Future`-Arbeit. Streams fuegen einen Abonnement-Lebenszyklus hinzu, und das neigt die Entscheidung fuer alles Nicht-Triviale ein wenig weiter zu Riverpod. `StreamBuilder` abonniert erneut, wenn Sie ihm eine neue `Stream`-Instanz uebergeben, und meldet sich ab, wenn er den Baum verlaesst, aber er macht kein Multicast: Zwei `StreamBuilder` auf demselben Single-Subscription-Stream werfen einen Fehler, weil ein Single-Subscription-`Stream` nur einen Listener erlaubt. Der `StreamProvider` von Riverpod sitzt vor dem Stream, sodass mehrere Widgets ein `AsyncValue` lesen, ohne um das Abonnement zu kaempfen, und der neueste Wert wird fuer spaete Abonnenten gecacht. Wenn ein Stream an genau einer Stelle angezeigt wird, ist `StreamBuilder` in Ordnung. Wenn mehr als ein Widget ihn braucht, beseitigt `StreamProvider` das Single-Listener-Problem vollstaendig.

## Die Empfehlung, mit dem vollen Kontext dahinter

Verwenden Sie standardmaessig `AsyncValue` von Riverpod fuer jedes asynchrone Ergebnis, das geteilt, gecacht, aktualisiert oder mutiert wird, was in einer echten App die meisten sind. Sie erhalten einen Abruf statt N, kostenloses Caching ueber Navigationen hinweg, ein `isLoading`, das vorherige Daten bei der Aktualisierung bewahrt, und Logik, die Sie ohne ein Widget testen koennen. Behalten Sie `FutureBuilder` und `StreamBuilder` fuer wirklich in sich geschlossene, wegwerfbare asynchrone UI: ein Blatt-Widget, das eine Sache laedt, sie anzeigt und beim Aushaengen vergisst, besonders in Apps, die keine Abhaengigkeit zur Zustandsverwaltung tragen. Die Builder sind keine Stuetzraeder, die man entwaechst. Sie sind das richtige Werkzeug, wenn das asynchrone Ergebnis ein Publikum von einem hat, und das falsche Werkzeug in dem Moment, in dem es ein Publikum von zwei hat. Waehlen Sie nach Eigentuemerschaft, nicht nach Vertrautheit.

Wenn Sie noch breiter einen Ansatz zur Zustandsverwaltung waehlen, finden sich die Abwaegungen zwischen den Paketen in [Provider vs Riverpod vs Bloc fuer Flutter-Zustandsverwaltung in 2026](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/). Und wenn Ihre asynchrone UI weiterhin Fehler zutage foerdert, behandelt [wie man Netzwerkfehler in einer Flutter-App elegant behandelt](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), wie man geworfene Ausnahmen in beiden Modellen in einen sauberen Fehlerzustand umwandelt.

## Quellen

- [FutureBuilder-Klasse, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/FutureBuilder-class.html)
- [StreamBuilder-Klasse, Flutter-API-Dokumentation](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
- [AsyncValue-Klasse, flutter_riverpod-API-Dokumentation](https://pub.dev/documentation/flutter_riverpod/latest/flutter_riverpod/AsyncValue-class.html)
- [Was ist neu in Riverpod 3.0](https://riverpod.dev/docs/whats_new)
- [riverpod-Changelog auf pub.dev](https://pub.dev/packages/riverpod/changelog)

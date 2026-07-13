---
title: "So sichern Sie setState mit der mounted-Prüfung nach einer asynchronen Lücke in Flutter ab"
description: "Nach einem await kann das Widget bereits verworfen sein, und der Aufruf von setState wirft eine Ausnahme. Sichern Sie die Fortsetzung mit if (!mounted) return; ab und, besser noch, brechen Sie die auslösende Arbeit ab. Das vollständige Muster für Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "de"
translationOf: "2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

Die Regel passt in eine Zeile: Rufen Sie innerhalb eines `State` niemals `setState` nach einem `await` auf, ohne zuvor `if (!mounted) return;` zu prüfen. Ein `await` gibt die Kontrolle an die Ereignisschleife zurück, der Benutzer kann den Bildschirm schließen, während Ihre asynchrone Arbeit läuft, und wenn Ihr Code fortgesetzt wird, ist das Widget möglicherweise bereits verworfen. Der Aufruf von `setState` auf einem verworfenen `State` wirft `setState() called after dispose()`. Der Getter `mounted` sagt Ihnen, ob der `State` noch im Baum ist, sodass das Absichern der Fortsetzung damit den Absturz unmöglich macht. Noch besser: Brechen Sie den Timer, das Abonnement oder die Anfrage ab, die `setState` aufrufen würde, damit der Callback niemals auf einem toten Widget läuft. Dieser Leitfaden verwendet Flutter 3.44 (aktuell stabil, 2026) und Dart 3.x.

`mounted` ist ein Getter auf `State<T>`. Er ist `true` ab dem Moment, in dem das Framework Ihren `State` mit seinem `BuildContext` verbindet, noch bevor `initState` läuft, und bleibt `true`, bis `dispose` aufgerufen wird, danach ist er für immer `false`. Unter der Haube ist er nicht mehr als eine null-Prüfung auf die Elementreferenz: `bool get mounted => _element != null;`. Das ist der gesamte Mechanismus. Wenn das Element, das Ihr Widget stützt, aus dem Baum gerissen wird, wird `_element` zu null, `mounted` wechselt auf `false`, und jedes `setState`, das Sie ab diesem Punkt versuchen, ist ein Fehler, den das Framework aktiv zurückweist.

## Warum ein await die Stelle ist, an der das kaputtgeht

Flutter steuert alles von einem einzigen UI-Thread aus. Solange Ihr Ereignishandler synchron läuft, kann das Widget, das Sie betrachten, nicht mitten in der Methode verschwinden: Nichts anderes kommt an die Reihe. In dem Moment, in dem Sie `await` schreiben, ist diese Garantie weg. Die Kontrolle geht zurück an die Ereignisschleife, andere Frames werden gerendert, Gesten-Callbacks laufen, Routenübergänge werden abgeschlossen. Ihre Fortsetzung wird für eine spätere Mikrotask geplant, und zwischen "vor dem await" und "nach dem await" könnte der Benutzer auf Zurück getippt haben, ein übergeordnetes Widget könnte Sie aus der Existenz neu gebaut haben, oder ein `Navigator.pop` an anderer Stelle könnte Ihre Route verworfen haben.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _ProfileState extends State<Profile> {
  bool _loading = false;
  User? _user;

  Future<void> _load() async {
    setState(() => _loading = true);      // fine: still on the same frame
    final user = await api.fetchUser();    // control leaves; frames run
    setState(() {                          // may run after dispose()
      _user = user;
      _loading = false;
    });
  }
}
```

Nichts an `_load` sieht falsch aus, und es funktioniert jedes Mal, wenn Sie es auf einem Bildschirm testen, den Sie nicht verlassen. Navigieren Sie jedoch weg, während `fetchUser` unterwegs ist, und das zweite `setState` landet auf einem verworfenen `State`. Im Debug erhalten Sie einen `FlutterError`: `setState() called after dispose(): _ProfileState#1a2b3(lifecycle state: defunct, not mounted)`. Dies ist derselbe strukturelle Fehler, der aus der Kontext-Perspektive in [BuildContext nach einem await sicher verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) beschrieben wird, aber hier ist das Opfer die Zustandsmutation und nicht eine Suche nach einem geerbten Widget.

## Die minimale Absicherung, Schritt für Schritt

Befolgen Sie diese drei Schritte für jede asynchrone Methode in einem `State`, die nach dem Aussetzen `setState` aufruft.

1. **Erledigen Sie die asynchrone Arbeit.** Lassen Sie das `await` so lange dauern, wie es muss. Sie halten noch nichts Zerbrechliches darüber; `mounted` ist ein lebendiger Getter, kein Wert, den Sie zwischengespeichert haben.
2. **Sichern Sie die Fortsetzung ab.** Schreiben Sie unmittelbar nach dem `await`, vor jedem `setState`, `if (!mounted) return;`. Wenn das Widget während des await den Baum verlassen hat, stoppen Sie hier und berühren niemals den verworfenen `State`.
3. **Rufen Sie setState nur nach der Absicherung auf.** Alles, was den Zustand mutiert und das Widget neu baut, kommt nach der Prüfung, im selben synchronen Tick, sodass nichts Sie zwischen der Absicherung und dem Aufruf verwerfen kann.

Angewendet auf das kaputte Beispiel:

```dart
// Flutter 3.44, Dart 3.x -- guarded
Future<void> _load() async {
  setState(() => _loading = true);
  final user = await api.fetchUser();   // 1. async work

  if (!mounted) return;                 // 2. guard the resume

  setState(() {                         // 3. safe: State is still mounted
    _user = user;
    _loading = false;
  });
}
```

Das ist die gesamte Korrektur für den häufigen Fall. `mounted` ist `false` in dem Moment, in dem `dispose` gelaufen ist, sodass die Absicherung das `setState` genau dann überspringt, wenn es die Ausnahme geworfen hätte. Beachten Sie, dass die Absicherung `mounted` nach dem await frisch liest; eine Prüfung, die *vor* dem await platziert wird, sagt Ihnen nichts, denn die Lücke, die zählt, ist das await selbst.

## Warum die mounted-Prüfung die Untergrenze ist, nicht die Obergrenze

Das Flutter-Framework ist darüber im Text des `setState`-Fehlers selbst deutlich. Seine empfohlene Korrektur ist nicht nur, `mounted` zu prüfen, sondern die Arbeit abzubrechen, die `setState` überhaupt aufrufen würde. Die Begründung: Eine `mounted`-Absicherung verhindert die Ausnahme, aber die asynchrone Arbeit lief trotzdem bis zum Ende und verbrannte CPU, Netzwerk und Akku, um ein Ergebnis zu erzeugen, das Sie dann verwerfen. Wenn ein `Timer` jede Sekunde auf einem Bildschirm feuert, den der Benutzer vor zehn Minuten verlassen hat, stoppt das Absichern jedes Ticks mit `mounted` zwar den Absturz, lässt den Timer aber für immer laufen.

Behandeln Sie `if (!mounted) return;` also als letzte Verteidigungslinie und brechen Sie die Quelle in `dispose` als die eigentliche Korrektur ab, wo immer die Quelle abbrechbar ist.

```dart
// Flutter 3.44, Dart 3.x -- cancel the source, then guard as backup
class _ClockState extends State<Clock> {
  Timer? _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;             // backstop
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();                   // the real fix: stop the source
    super.dispose();
  }
}
```

Mit dem `cancel()` in `dispose` hört der Callback in dem Moment auf zu feuern, in dem das Widget verschwindet, sodass die `mounted`-Absicherung fast nie auslöst. Die Absicherung trotzdem zu behalten kostet nichts und deckt die schmale Race-Condition ab, bei der ein Tick bereits in der Warteschlange steht, wenn `dispose` läuft. Das ist dieselbe Disziplin, die Sie anwenden, wenn Sie [Controller freigeben, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): Übernehmen Sie den Lebenszyklus von allem, was in Ihr Widget zurückrufen kann.

## Stream-Abonnements sind der klassische Übeltäter

Eine `StreamSubscription`, deren `onData` `setState` aufruft, liefert weiterhin Ereignisse aus, nachdem das Widget verschwunden ist, es sei denn, Sie brechen sie ab. Speichern Sie das Abonnement und brechen Sie es in `dispose` ab.

```dart
// Flutter 3.44, Dart 3.x
class _FeedState extends State<Feed> {
  StreamSubscription<Item>? _sub;
  final _items = <Item>[];

  @override
  void initState() {
    super.initState();
    _sub = repository.itemStream.listen((item) {
      if (!mounted) return;
      setState(() => _items.add(item));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
```

Das `cancel()` hier zu vergessen ist eine der häufigsten Arten, `setState() called after dispose()` in Produktions-Logs zu sehen: Der Stream überlebt das Widget, und jedes Ereignis, das nach dem Verwerfen eintrifft, ist ein Absturz, den die `mounted`-Absicherung stillschweigend abfängt. Brechen Sie das Abonnement ab, und die Ereignisse hören an der Quelle auf. Jeden Listener, den Sie öffnen, in `dispose` abzubrechen, lohnt es sich so automatisch zu machen wie die [Controller-Freigabe, die Lecks verhindert](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## mounted auf State gegenüber mounted auf BuildContext

Es gibt zwei `mounted`-Getter, und den richtigen zu wählen zählt. `State.mounted` ist der, um den es in diesem ganzen Leitfaden geht: Er lebt in Ihrer Zustandsklasse, folgt dem Lebenszyklus des Widgets, das Ihnen gehört, und ist das, was Sie vor `setState` prüfen. Er existiert seit den frühesten Flutter-Versionen.

`BuildContext.mounted` kam in Flutter 3.7 für Code, der nur einen Kontext hat, keinen `State`: Hilfsfunktionen, `StatelessWidget`-Callbacks, Erweiterungsmethoden. Er beantwortet dieselbe Frage "ist dieses Element noch im Baum?", aber Sie greifen dazu, wenn kein `State` im Gültigkeitsbereich ist.

```dart
// Flutter 3.44, Dart 3.x
// Inside a State subclass, before setState:
if (!mounted) return;          // State.mounted

// In a helper that only has a BuildContext:
if (!context.mounted) return;  // BuildContext.mounted
```

Bevorzugen Sie innerhalb eines `State` `mounted` gegenüber `context.mounted`. Meist stimmen sie überein, aber `State.mounted` liest den Lebenszyklus genau des Objekts, auf dem Sie gleich `setState` aufrufen, was genau das ist, was defunkt sein kann. Reservieren Sie `context.mounted` für die Situationen, die in [BuildContext nach einem await sicher verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) behandelt werden, wo die Nutzlast eine `Navigator`- oder `ScaffoldMessenger`-Suche statt einer Zustandsmutation ist.

## Mehrere awaits bedeuten mehrere Absicherungen

Jeder Aussetzungspunkt öffnet das Fenster erneut. Wenn eine Methode zweimal await ausführt und nach jedem `setState` aufruft, braucht sie nach jedem await eine Absicherung, nicht nur nach dem ersten.

```dart
// Flutter 3.44, Dart 3.x
Future<void> _submit() async {
  setState(() => _status = 'validating');
  final valid = await validate(form);
  if (!mounted) return;                 // guard after await #1

  setState(() => _status = valid ? 'saving' : 'invalid');
  if (!valid) return;

  await repository.save(form);
  if (!mounted) return;                 // guard after await #2

  setState(() => _status = 'done');
}
```

Eine Absicherung deckt nur die awaits ab, die ihr vorausgehen. Fügen Sie ein neues `await` zwischen einer bestehenden Absicherung und einem `setState` ein, und Sie haben die Lücke stillschweigend wieder geöffnet. Wenn eine Methode mehr als zwei dieser Absicherungen hervorbringt, ist das meist ein Zeichen, dass die asynchrone Arbeit zu einem Controller, einem `AsyncNotifier` oder einem Stream gehört, den Ihr Widget deklarativ rendert, statt zu einem Haufen imperativer `setState`-Aufrufe. Sie als [Lade- und Fehlerzustände mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) zu modellieren, übergibt die Lebenszyklus-Buchhaltung an das Framework und entfernt die meisten manuellen Absicherungen vollständig.

## Der Linter fängt diese hier nicht

Es lohnt sich, klar zu sein, was das Werkzeug hier tut und nicht tut. Der Linter `use_build_context_synchronously` aus `flutter_lints` markiert einen `BuildContext`, der nach einer asynchronen Lücke ohne Absicherung verwendet wird. Er markiert **nicht** ein nacktes `setState` nach einem await, denn `setState` nimmt keinen Kontext, und der Linter sucht nicht danach. Es gibt keine Analyseregel, die das ungesicherte `setState` im ersten Beispiel dieses Beitrags unterstreicht. Das macht die Gewohnheit ganz zu Ihrer Sache: Der Compiler ist still, der Analyzer ist still, und das einzige Signal ist ein Absturz in einem Log, nachdem ein Benutzer im falschen Moment weggenavigiert ist.

Die praktische Folge ist, dass Sie sich nicht auf eine rote Schlangenlinie verlassen können, um sie zu finden. Prüfen Sie jede `State`-Methode, die zugleich `await` ausführt und `setState` aufruft, und machen Sie die Absicherung so reflexartig, wie Sie `super.dispose()` bereits behandeln.

## Fallstricke und Doppelgänger

**Dies ist ein anderer Fehler als setState während des Builds.** Der Fehler `setState() called after dispose()` und der Fehler `setState() or markNeedsBuild() called during build` sind trotz des ähnlichen Textes nicht verwandt. Der dispose-Fehler geht darum, `setState` zu spät aufzurufen, nachdem das Widget verschwunden ist; der build-Fehler geht darum, es zu früh aufzurufen, synchron innerhalb eines Build-Durchlaufs. Die Korrekturen sind unterschiedlich, und die [Absicherung für setState während des Builds](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) deckt den zweiten ab. Wenn Ihr Stack Trace "during build" sagt, ist die `mounted`-Prüfung nicht Ihre Korrektur.

**Release-Builds stürzen trotzdem ab, nur später.** Der Fehler `setState() called after dispose()` ist ein tatsächlich geworfener `FlutterError`, keine reine Debug-Assertion, sodass er im Gegensatz zu den Suchen nach verworfenem Kontext auch im Release auftaucht. Aber weil er von einem asynchronen Callback ausgelöst wird, zeigt der Stack Trace oft auf Framework-Code weit weg von Ihrer `_load`-Methode, was es leicht macht, ihn falsch zuzuordnen. Ein Absturz, der nur nach der Navigation auftaucht, aus einem `Future.then` oder einem Stream-Handler heraus, ist fast immer ein ungesichertes `setState` nach dem await.

**`FutureBuilder` und `StreamBuilder` umgehen die Absicherung.** Wenn Sie die asynchrone Arbeit einem `FutureBuilder` oder `StreamBuilder` übergeben, statt `setState` von Hand aufzurufen, verfolgt der Builder den Widget-Lebenszyklus für Sie und ruft niemals `setState` auf einem toten `State` auf. Zu [FutureBuilder oder StreamBuilder statt manuellem setState](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) zu greifen, entfernt eine ganze Kategorie dieser Fehler, um den Preis, den asynchronen Ablauf um den Builder herum umzustrukturieren.

**Das Riverpod-Äquivalent.** Wenn Sie einen `WidgetRef` oder den `Ref` eines Notifiers statt eines `State` halten, ist der entsprechende Absturz ein Fehler wegen eines verworfenen ref statt eines verworfenen `State`, und die Absicherung ist `ref.mounted` statt `mounted`. Dieselbe Grundursache, dieselbe Form der Korrektur, behandelt in [Ref.mounted nach einer asynchronen Lücke in Riverpod 3.0 prüfen](/de/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).

## Die Gewohnheit, die den Absturz in Rente schickt

Lesen Sie einen `State` nur vom Beginn eines synchronen Laufs bis zum nächsten `await` als gültig. Prüfen Sie nach der Fortsetzung `mounted`, bevor Sie `setState` aufrufen. Und wo immer das, was `setState` auslöst, ein Timer, ein Abonnement oder eine langlebige Quelle ist, brechen Sie es in `dispose` ab, damit der Callback niemals auf einem Widget feuert, das bereits verschwunden ist. Tun Sie das mechanisch, und `setState() called after dispose()` hört auf, in Ihren Logs aufzutauchen, denn Sie haben sowohl den Absturz als auch die verschwendete Arbeit dahinter entfernt.

## Quellen

- [Eigenschaft State.mounted](https://api.flutter.dev/flutter/widgets/State/mounted.html), Flutter-API-Dokumentation, dazu, wann `mounted` über den `State`-Lebenszyklus hinweg true und false ist.
- [Methode State.setState](https://api.flutter.dev/flutter/widgets/State/setState.html), Flutter-API-Dokumentation, die den Fehler `setState() called after dispose()` darlegt und empfiehlt, die Quelle abzubrechen, statt nur `mounted` zu prüfen.
- [Methode State.dispose](https://api.flutter.dev/flutter/widgets/State/dispose.html), Flutter-API-Dokumentation, dazu, Timer und Abonnements freizugeben, wenn das Widget den Baum verlässt.
- [Linter-Regel use_build_context_synchronously](https://dart.dev/tools/linter-rules/use_build_context_synchronously), Dart-Linter-Regeln, dazu, was der Analyzer markiert und was nicht.

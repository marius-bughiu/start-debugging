---
title: "Lösung: Looking up a deactivated widget's ancestor is unsafe in Flutter"
description: "Dieser Absturz bedeutet, dass Sie context.of() aufgerufen haben, nachdem das Widget den Baum verlassen hat, meist in einem asynchronen Callback oder in dispose(). Erfassen Sie den Wert vor dem await oder in didChangeDependencies()."
pubDate: 2026-06-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "de"
translationOf: "2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-14
---

Sie haben einen `BuildContext` verwendet, um einen Vorfahren nachzuschlagen (`Navigator.of`, `Theme.of`, `ScaffoldMessenger.of`, `MediaQuery.of`, `Provider.of`, ein `InheritedWidget`), nachdem das Widget, dem dieser Kontext gehört, aus dem Baum entfernt wurde. Die zwei üblichen Auslöser sind ein asynchroner Callback, der abschließt, nachdem der Benutzer weiternavigiert ist, und ein Nachschlagen innerhalb von `dispose()`. Die Lösung ist, alles Benötigte vor dem `await` aus dem Kontext zu erfassen (oder in `didChangeDependencies`) und die Arbeit nach dem await mit `if (!mounted) return;` abzusichern. Diese Anleitung verwendet Flutter 3.44 (stabil, Mai 2026) und Dart 3.x.

Ein `BuildContext` ist lediglich ein Verweis auf ein `Element` im Baum. Sobald dieses Element deaktiviert ist, kann ein Aufwärtslauf von dort einen veralteten Vorfahren oder einen Knoten zurückgeben, der sich gleich verschiebt, also verweigert das Framework das Nachschlagen, anstatt Ihnen eine falsche Antwort zu geben. Es ist dieselbe Familie von Lebenszyklus-Fehler wie ein [Controller, der nach seiner Freigabe verwendet wurde](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/): Das Objekt existiert noch, aber es ist nicht mehr gültig, es anzufassen.

## Der Fehler im Kontext

Die vollständige Meldung, die Flutter ausgibt, sieht so aus:

```
FlutterError (Looking up a deactivated widget's ancestor is unsafe.
At this point the state of the widget's element tree is no longer stable.
To safely refer to a widget's ancestor in its dispose() method, save a reference
to the ancestor by calling dependOnInheritedWidgetOfExactType() in the widget's
didChangeDependencies() method.)
```

In Release-Builds wird der Assertion-Text entfernt, und Sie sehen stattdessen einen blanken Absturz oder einen `Null check operator used on a null value` weiter unten im Stack, weil das Nachschlagen `null` zurückgegeben hat. Die Assertion wird von `Element._debugCheckStateIsActiveForAncestorLookup` in `package:flutter/src/widgets/framework.dart` ausgelöst, die jeder Aufruf von `dependOnInheritedWidgetOfExactType` und `findAncestorStateOfType` im Debug-Modus zuerst ausführt.

## Warum "deactivated" anders ist als "disposed"

Flutter baut ein Widget in zwei Phasen ab. Zuerst läuft `deactivate()`: Das Element wird vom Elternknoten getrennt und in eine Inaktiv-Liste verschoben, wo es im selben Frame reaktiviert werden könnte, falls es mit einem `GlobalKey` umgehängt wurde. Nur wenn es bis zum Ende des Frames nicht zurückgeholt wird, läuft `dispose()` und der Zustand wird endgültig tot.

Der `mounted`-Getter auf `State` ist in beiden Phasen `false`. Das ist die zentrale Erkenntnis: `mounted` bedeutet nicht "noch nicht freigegeben", sondern "aktuell am Baum angebunden". Deshalb ist `mounted` die richtige Absicherung für diesen Fehler, auch wenn das Wort in der Meldung "deactivated" ist und nicht "disposed".

```dart
// Flutter 3.44, Dart 3.x
@override
void deactivate() {
  // mounted is already false by the time your async callback resumes here
  super.deactivate();
}
```

## Minimaler Reproduktionsfall: ein Nachschlagen nach dem await

Die häufigste Form. Sie tippen auf einen Button, erledigen asynchrone Arbeit und fassen dann den Kontext an. Verlässt der Benutzer während des await den Bildschirm, ist der Kontext deaktiviert, wenn der Callback fortsetzt.

```dart
// Flutter 3.44, Dart 3.x -- crashes if the user leaves mid-await
class SaveButton extends StatefulWidget {
  const SaveButton({super.key});
  @override
  State<SaveButton> createState() => _SaveButtonState();
}

class _SaveButtonState extends State<SaveButton> {
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 2)); // network call
    // If the widget was popped during those 2s, this throws:
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Saved')),
    );
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(onPressed: _save, child: const Text('Save'));
  }
}
```

Der zweite Reproduktionsfall ist ein Nachschlagen in `dispose()`, das immer unsicher ist, weil das Element zu diesem Zeitpunkt bereits getrennt ist:

```dart
// Flutter 3.44, Dart 3.x -- always throws in debug
@override
void dispose() {
  // The element is detached; this ancestor lookup is the exact thing the
  // assertion forbids.
  final messenger = ScaffoldMessenger.of(context);
  messenger.clearSnackBars();
  super.dispose();
}
```

## Lösung 1: vor dem await erfassen, danach absichern

Das ist die richtige Lösung für den asynchronen Fall und die erste, zu der Sie greifen sollten. Ein `BuildContext` ist nur sicher zu lesen, solange das Widget eingehängt ist, also lesen Sie alles Benötigte synchron daraus, vor dem ersten `await`. Danach bleibt jedes erfasste Objekt (ein `NavigatorState`, ein `ScaffoldMessengerState`) gültig, auch wenn das Widget den Baum verlässt, weil diese Zustandsobjekte das einzelne Element-Nachschlagen überleben.

```dart
// Flutter 3.44, Dart 3.x -- safe
Future<void> _save() async {
  // Capture the ancestor state objects while still mounted.
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);

  await Future<void>.delayed(const Duration(seconds: 2));

  if (!mounted) return; // the widget left the tree; stop here

  messenger.showSnackBar(const SnackBar(content: Text('Saved')));
  navigator.pop();
}
```

Zwei Dinge leisten hier die Arbeit. `messenger` und `navigator` vor dem `await` zu erfassen bedeutet, dass Sie `.of(context)` nie auf einem deaktivierten Kontext aufrufen. Das `if (!mounted) return;` überspringt dann die UI-Aktualisierungen vollständig, falls der Benutzer bereits weg ist, was ohnehin fast immer gewünscht ist. Beachten Sie, dass `mounted` nach dem `await` geprüft werden muss, nicht davor, denn der await ist die Stelle, an der sich die Lücke öffnet.

Seit Flutter 3.7 gibt es auch einen `BuildContext.mounted`-Getter, also können Sie, wenn Sie nur einen Kontext (kein `State`) haben, `if (!context.mounted) return;` schreiben. Die Lint-Regel `use_build_context_synchronously`, in `flutter_lints` standardmäßig aktiv, markiert genau die fehlende Absicherung in diesem Reproduktionsfall, also aktivieren Sie sie und lassen Sie den Analyzer diese Fälle vor der Laufzeit abfangen.

## Lösung 2: Inherited Widgets in didChangeDependencies lesen

Wenn Sie während `dispose()` wirklich einen vererbten Wert brauchen, etwa um sich von etwas abzumelden, das Sie über `.of(context)` gefunden haben, können Sie ihn nicht zur Dispose-Zeit nachschlagen. Erfassen Sie ihn früher. `didChangeDependencies()` läuft direkt nach `initState` und erneut, wann immer sich eine vererbte Abhängigkeit ändert, und der Kontext ist dort vollständig gültig.

```dart
// Flutter 3.44, Dart 3.x -- safe dispose-time access
class _MyWidgetState extends State<MyWidget> {
  late MyModel _model;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Captured while mounted; survives into dispose().
    _model = MyModelScope.of(context);
  }

  @override
  void dispose() {
    _model.removeListener(_onChange); // no context lookup needed
    super.dispose();
  }
}
```

Das ist genau das, was die Fehlermeldung Ihnen vorgibt, modernisiert: Der Text sagt noch `dependOnInheritedWidgetOfExactType()`, was der Low-Level-Aufruf ist, den `Theme.of`, `MediaQuery.of` und Konsorten umhüllen. Sie rufen ihn selten direkt auf; der typisierte `.of`-Zugriff in `didChangeDependencies` tut dasselbe.

## Lösung 3: kein Kontext-Nachschlagen in Callbacks, die Sie nicht kontrollieren

Eine subtile Variante: Das Nachschlagen steht nicht in Ihrem `dispose()`, sondern in einem Callback, der nach dem dispose feuert, etwa ein `Timer`, ein Stream-Listener, ein Animations-Status-Listener oder ein `Future.then`. Die Lösung ist dieselbe Absicherung, aber Sie sollten auch die Quelle in `dispose()` abbrechen, damit der Callback gar nicht mehr feuert.

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<int>? _sub;

@override
void initState() {
  super.initState();
  _sub = someStream.listen((value) {
    if (!mounted) return;          // guard
    Navigator.of(context).pushNamed('/next');
  });
}

@override
void dispose() {
  _sub?.cancel();                  // stop the source
  super.dispose();
}
```

Das Abbrechen des Abonnements ist der Gürtel; die `mounted`-Prüfung sind die Hosenträger. Abbrechen allein behebt es meist, aber ein Callback, der bei der Ausführung von `cancel()` bereits unterwegs war, kann noch einmal fortsetzen, also behalten Sie die Absicherung. Dieselbe Paarung gilt, wenn Sie [Controller und andere Ressourcen freigeben](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): Geben Sie die Quelle frei und sichern Sie alles ab, das verspätet feuern könnte.

## Fallstricke und ähnlich aussehende Fehler

**`initState` ist zu früh für `.of(context)` mit Inherited Widgets.** Sie können `context` in `initState` für manche Dinge lesen, aber `dependOnInheritedWidgetOfExactType` (und damit `Theme.of`, `MediaQuery.of`) ist dort nicht erlaubt, weil das Element noch nicht mit seinen vererbten Abhängigkeiten verdrahtet ist. Verschieben Sie diese Lesevorgänge in `didChangeDependencies`. Dies wirft eine andere Assertion ("dependOnInheritedWidgetOfExactType was called before initState completed"), also wenn Ihre Meldung `initState` erwähnt, haben Sie die Frühes-Nachschlagen-Variante vor sich, nicht die Deaktivierungs-Variante.

**`Navigator.pop` gefolgt von einer Kontext-Verwendung.** Ein häufiges Muster in FlutterFlow und handgeschriebenen Formularen ist `Navigator.pop(context)` und dann, in der nächsten Zeile, ein weiterer `.of(context)`-Aufruf. Nach dem Pop beginnt das Element der Route zu deaktivieren, also kann das zweite Nachschlagen den Fehler werfen. Erfassen Sie den Navigator oder Messenger vor dem Pop.

**Umhängen mit `GlobalKey`.** Wenn Sie einen Teilbaum mit einem `GlobalKey` verschieben und etwas darin während des Umhäng-Frames ein Vorfahren-Nachschlagen durchführt, können Sie vorübergehend darauf stoßen. Das ist seltener; die Lösung ist, das Nachschlagen mit `WidgetsBinding.instance.addPostFrameCallback` auf nach dem Frame zu verschieben und dann `mounted` erneut zu prüfen.

**Release-Builds verbergen es.** Da die Meldung von einem `assert` stammt, wird sie nur im Debug ausgegeben. In Profile und Release gibt das Nachschlagen stillschweigend `null` zurück und Sie stürzen später mit einer Null-Dereferenzierung ab. Wenn Sie einen `Null check operator used on a null value` nur im Release und nur nach dem Navigieren sehen, vermuten Sie dies. Die [Absicherung von `setState() called during build`](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) verhält sich genauso: eine reine Debug-Assertion, die einen Null im Release-Modus verbirgt.

**Die Riverpod-Variante davon.** Wenn Sie einen `WidgetRef` statt `BuildContext` verwenden, ist der entsprechende Absturz [`Cannot use "ref" after the widget was disposed`](/de/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Dieselbe Grundursache, dieselbe Lösung: vor dem await lesen, danach absichern. Der Griff zu einem strukturierten asynchronen Muster wie [`AsyncValue` für Lade- und Fehlerzustände](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) umgeht die meisten dieser manuellen Absicherungen, weil das Framework den Widget-Lebenszyklus für Sie verfolgt.

## Die eine Regel, die all diese Fälle verhindert

Behandeln Sie den `BuildContext` nur zwischen `build` und dem nächsten Suspendierungspunkt als gültig. In dem Moment, in dem Sie `await` aufrufen, kann der Kontext bei der Rückkehr verschwunden sein, also erfassen Sie zuerst, was Sie brauchen, und sichern Sie es mit `mounted` ab, oder strukturieren Sie so um, dass das Nachschlagen nie eine asynchrone Grenze überquert. Sobald diese Gewohnheit sitzt, hören der "deactivated widget's ancestor"-Absturz, der Freigegebener-Controller-Absturz und der Freigegebener-Ref-Absturz alle aus demselben Grund auf zu erscheinen.

## Sources

- [State.mounted property](https://api.flutter.dev/flutter/widgets/State/mounted.html) und [State.didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html), Flutter-API-Dokumentation.
- [BuildContext.dependOnInheritedWidgetOfExactType](https://api.flutter.dev/flutter/widgets/BuildContext/dependOnInheritedWidgetOfExactType.html), Flutter-API-Dokumentation (der in der Fehlermeldung genannte Aufruf).
- [flutter/flutter#19462: "Looking up a deactivated widget's ancestor is unsafe"](https://github.com/flutter/flutter/issues/19462), das kanonische Issue, das es bis zu `Navigator.push` innerhalb eines asynchronen Callbacks zurückverfolgt.
- [use_build_context_synchronously lint](https://dart.dev/tools/linter-rules/use_build_context_synchronously), Dart-Linter-Regeln, die die fehlende Absicherung statisch markiert.

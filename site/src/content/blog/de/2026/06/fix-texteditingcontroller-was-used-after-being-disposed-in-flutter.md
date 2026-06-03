---
title: "Fix: A TextEditingController was used after being disposed in Flutter"
description: "Dieser Absturz bedeutet, dass Code einen Controller nach dem Aufruf von dispose() angefasst hat. Sichern Sie asynchrone Callbacks mit einer mounted-Prüfung ab und geben Sie nie einen Controller frei, der Ihnen nicht gehört."
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "de"
translationOf: "2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

Etwas hat aus einem `TextEditingController` gelesen oder in ihn geschrieben, nachdem dessen `dispose()` bereits gelaufen war. Der übliche Verursacher ist eine asynchrone Callback (ein `Future.then`, ein `await`, ein `Timer` oder ein Stream-Listener), die abschließt, nachdem der Nutzer den Bildschirm verlassen hat und der `State` abgebaut wurde. Sichern Sie den Code nach dem await mit `if (!mounted) return;` ab, bevor Sie den Controller anfassen. Die andere häufige Ursache ist Verwirrung über die Eigentümerschaft: ein Kind-Widget hat einen Controller freigegeben, den es übergeben bekommen hat, der ihm aber nicht gehört. Dieser Leitfaden verwendet Flutter 3.44 (stabil, Mai 2026) und Dart 3.x.

Der Fehler ist nicht spezifisch für `TextEditingController`. Dieselbe Meldung erscheint bei jedem `ChangeNotifier` (`ScrollController`, `FocusNode`, `AnimationController`, `ValueNotifier`, das Modell eines Providers), weil die Assertion im `ChangeNotifier` selbst liegt. Der Laufzeittyp in der Meldung sagt Ihnen nur, welchen davon Sie zu spät angefasst haben.

## Der Fehler im Kontext

Die vollständige Meldung, die Flutter wirft, sieht so aus:

```
A TextEditingController was used after being disposed.
Once you have called dispose() on a TextEditingController, it can no longer be used.

When the exception was thrown, this was the stack:
#0      ChangeNotifier._debugAssertNotDisposed.<anonymous closure> (package:flutter/src/foundation/change_notifier.dart)
#1      ChangeNotifier._debugAssertNotDisposed (package:flutter/src/foundation/change_notifier.dart)
#2      ChangeNotifier.addListener (package:flutter/src/foundation/change_notifier.dart)
#3      TextEditingController.text= (package:flutter/src/widgets/editable_text.dart)
...
```

Der Stack-Frame direkt unter den `ChangeNotifier`-Frames ist die Zeile in Ihrem Code. Er benennt die Operation, die den toten Controller angefasst hat: `text=`, `.text`, `addListener`, `clear()` oder `.selection`. Dieser Frame ist die Stelle, an der Sie es beheben, aber der Grund für das Auslösen liegt früher in der Zeit, als `dispose()` vor dieser Zeile lief.

## Warum das passiert

Es gibt vier Ursachen, grob nach Häufigkeit geordnet.

Eine asynchrone Callback hat das Widget überlebt. Sie haben ein `await`, ein `Future.then`, einen `Timer` oder ein `stream.listen` gestartet, während der Bildschirm aktiv war, der Nutzer hat weggenavigiert (was den `State` und den Controller freigibt), und dann hat die Callback abgeschlossen und den Controller angefasst. Das ist mit Abstand die häufigste Ursache, weil sie nur dann abstürzt, wenn das Timing zusammenpasst: sie funktioniert, wenn die Antwort schnell ist, und stürzt ab, wenn der Nutzer schnell oder das Netzwerk langsam ist.

Ein Kind hat einen Controller freigegeben, der ihm nicht gehört. Ein Elternteil hat den Controller erstellt und nach unten gereicht; das Kind hat in seinem eigenen `dispose()` `dispose()` darauf aufgerufen. Jetzt verwendet das Elternteil (oder ein Geschwister oder der nächste Rebuild) einen Controller, den das Kind bereits getötet hat. Die Eigentümerschaft ist das Gegenteil des Leak-Problems: Geben Sie einen Controller frei, der Ihnen nicht gehört, bekommen Sie diesen Absturz, vergessen Sie, einen freizugeben, der Ihnen gehört, bekommen Sie ein Speicherleck.

Eine State-Management-Schicht hat ihn freigegeben. Wenn der Controller in einem `autoDispose`-Provider von Riverpod, einem GetX-Controller oder einem `ChangeNotifier` lebt, den das Framework abgebaut hat, trifft das Widget, das noch eine Referenz hält, auf eine freigegebene Instanz. Riverpods `autoDispose` ist ein häufiger Auslöser: der Provider wird neu berechnet oder freigegeben, wenn er nicht mehr beobachtet wird, und nimmt den Controller mit, während eine veraltete Closure noch auf den alten zeigt.

`didUpdateWidget` hat den alten zu früh freigegeben. Wenn ein Controller von einer `widget`-Eigenschaft abhängt, geben Sie beim Update den alten Controller frei und erstellen einen neuen. Wenn eine ausstehende Callback den alten Controller eingefangen hat, fasst sie nun eine freigegebene Instanz an.

Der zugrunde liegende Vertrag, laut der [ChangeNotifier-API-Dokumentation von Flutter](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html): Sobald `dispose()` aufgerufen wurde, ist das Objekt unbrauchbar, und jede weitere Verwendung wirft in Debug-Builds. Die Assertion wird aus Release-Builds entfernt, sodass derselbe Code in Release nicht abstürzt, sondern veralteten oder null-Zustand liest. Deshalb beheben Sie die Ursache und unterdrücken nicht die Assertion.

## Eine minimale Reproduktion

Dieses Widget stürzt ab, wenn Sie den Bildschirm verlassen, bevor der Fetch zurückkehrt. Es kompiliert und läuft, und es funktioniert, wenn das Netzwerk schnell ist.

```dart
// Flutter 3.44, Dart 3.x -- throws "A TextEditingController was used after being disposed".
import 'package:flutter/material.dart';

class SearchBox extends StatefulWidget {
  const SearchBox({super.key});

  @override
  State<SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<SearchBox> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _prefill();
  }

  Future<void> _prefill() async {
    // Pretend this hits the network and takes ~500ms.
    final lastQuery = await Future.delayed(
      const Duration(milliseconds: 500),
      () => 'flutter dispose error',
    );
    // If the user popped this screen during those 500ms, the State and the
    // controller are already disposed. This line then throws.
    _controller.text = lastQuery;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(controller: _controller);
  }
}
```

Öffnen Sie diesen Bildschirm und schließen Sie ihn dann innerhalb einer halben Sekunde. `dispose()` läuft, `_controller.dispose()` tötet den Controller, das `Future` schließt ab, und `_controller.text = ...` wirft. Der Absturz hängt vom Timing ab, was genau der Grund ist, warum er die Code-Review übersteht und ausgeliefert wird.

## Der Fix im Detail

Die Fixes sind danach geordnet, wie sehr ich sie empfehle. Wählen Sie den, der zu Ihrer Ursache passt.

### 1. Sichern Sie asynchrone Callbacks mit mounted ab (empfohlen)

An jeder Stelle, an der auf ein `await` (oder eine andere aufgeschobene Callback) Code folgt, der den Controller anfasst oder `setState` aufruft, prüfen Sie zuerst `mounted`. `mounted` ist `false`, sobald der `State` freigegeben wurde, sodass die Absicherung kurzschließt, bevor der Controller angefasst wird.

```dart
// Flutter 3.44, Dart 3.x -- correct: bail out if the widget is gone.
Future<void> _prefill() async {
  final lastQuery = await Future.delayed(
    const Duration(milliseconds: 500),
    () => 'flutter dispose error',
  );
  if (!mounted) return; // the State (and the controller) may be disposed
  _controller.text = lastQuery;
}
```

Die Regel: Nach jedem `await` in einer `State`-Methode muss der nächsten Zeile, die `this`, den Controller oder `setState` anfasst, eine `mounted`-Prüfung vorausgehen. Hier gibt es ein `await`, also gibt es eine Absicherung. Wenn eine Methode zwei awaits hat und den Controller nach jedem anfasst, braucht sie zwei Absicherungen. Der Lint `use_build_context_synchronously` des Dart-Analyzers fängt die `BuildContext`-Version dieses Fehlers; behandeln Sie einen Controller genau gleich.

Für einen `Timer` oder ein `stream.listen` gehört die Absicherung in die Callback:

```dart
// Flutter 3.44, Dart 3.x
_sub = someStream.listen((value) {
  if (!mounted) return;
  _controller.text = value;
});
```

Noch besser: Brechen Sie das Abonnement oder den Timer in `dispose()` ab, damit die Callback nach dem Abbau nie ausgelöst wird. Abbrechen ist sauberer als absichern, denn ein abgesichertes, aber nicht abgebrochenes Abonnement wacht trotzdem auf, allokiert und führt die Absicherung bei jedem Ereignis für einen Bildschirm aus, den der Nutzer bereits verlassen hat. Siehe die Freigabereihenfolge im [Leitfaden zur Freigabe von Controllern](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

### 2. Korrigieren Sie die Eigentümerschaft: Geben Sie nicht frei, was Ihnen nicht gehört

Wenn der Absturz nicht asynchron ist, geht es fast immer um Eigentümerschaft. Die Regel ist eine Zeile: Wer den Controller erstellt, gibt ihn frei, und niemand sonst. Ein Widget, das einen Controller über seinen Konstruktor empfängt, darf ihn nie freigeben.

```dart
// Flutter 3.44, Dart 3.x
class ParentForm extends StatefulWidget {
  const ParentForm({super.key});
  @override
  State<ParentForm> createState() => _ParentFormState();
}

class _ParentFormState extends State<ParentForm> {
  final _email = TextEditingController(); // parent creates -> parent owns

  @override
  void dispose() {
    _email.dispose(); // owner disposes, exactly once
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => EmailField(controller: _email);
}

class EmailField extends StatelessWidget {
  final TextEditingController controller;
  const EmailField({super.key, required this.controller});

  // Receives the controller. Does NOT dispose it. No dispose() here at all.
  @override
  Widget build(BuildContext context) => TextField(controller: controller);
}
```

Wäre `EmailField` ein `StatefulWidget` und würde `widget.controller` freigeben, würde die spätere Verwendung von `_email` durch das Elternteil genau diesen Fehler werfen. Der Fix besteht darin, diesen `dispose()`-Aufruf aus dem Kind zu löschen. Der Spiegelbild-Fehler (das Elternteil vergisst die Freigabe) ist ein Leak, behandelt im obigen Freigabe-Leitfaden.

### 3. Lassen Sie die State-Management-Schicht die Freigabe besitzen

Wenn ein Controller in einen Riverpod-Provider, einen GetX-Controller oder ein beliebiges Objekt außerhalb des Widgets gehoben wird, wandert die Freigabe mit ihm. Das Widget darf einen Controller, den es von einem Provider geliehen hat, nicht freigeben, und das `onDispose` (Riverpod) oder `onClose` (GetX) des Providers ist die Stelle, an der der `dispose()`-Aufruf nun lebt. Halten Sie mit Riverpods `autoDispose` den Provider am Leben, solange der Bildschirm ihn braucht (verwenden Sie `ref.keepAlive()` oder einen Provider ohne `autoDispose`), damit er nicht unter einem Widget, das den Controller noch hält, neu berechnet wird. Die Verlagerung der Lebenszyklus-Eigentümerschaft während einer State-Management-Migration ist genau die Stelle, an der das still bricht; ich habe [die Migration einer Flutter-App von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) aus genau diesem Grund als bewussten, schrittweisen Vorgang beschrieben.

### 4. Erstellen Sie in didUpdateWidget vorsichtig neu

Wenn ein Controller von einer `widget`-Eigenschaft abhängt und Sie ihn in `didUpdateWidget` austauschen, geben Sie den alten frei und weisen einen neuen zu, und stellen Sie sicher, dass keine ausstehende Callback noch die alte Instanz referenziert:

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(covariant MyField oldWidget) {
  super.didUpdateWidget(oldWidget);
  if (oldWidget.initialText != widget.initialText) {
    _controller.dispose();
    _controller = TextEditingController(text: widget.initialText);
  }
}
```

Jede asynchrone Arbeit, die gegen den alten Controller gestartet wurde, muss `mounted` prüfen (und idealerweise abgebrochen werden), bevor sie landet, sonst schreibt sie in die freigegebene Instanz, die Sie gerade ersetzt haben.

## Fallstricke und Varianten

`setState() called after dispose()`. Dieselbe Grundursache, eine andere Assertion. Eine asynchrone Callback, die `setState` nach dem Abbau aufruft, wirft dies statt der Controller-Meldung, weil `setState` intern einen `mounted`-äquivalenten Zustand prüft. Der Fix ist identisch: absichern mit `if (!mounted) return;`. Er reist oft zusammen mit dem Controller-Absturz, da dieselbe Callback meist sowohl den Controller schreibt als auch `setState` aufruft. Siehe [setState oder markNeedsBuild called during build](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) für den Build-Phasen-Cousin dieser Familie.

`A ScrollController was used after being disposed`, `A FocusNode was used after being disposed`, `An AnimationController was used after being disposed`. Dieselbe Assertion, dieselben Fixes. Die Meldung benennt, welchen `ChangeNotifier` Sie angefasst haben; die Diagnose (asynchron nach dispose oder falscher Eigentümer) ändert sich nicht.

Der Absturz passiert nur manchmal. Das ist die Signatur der asynchronen Ursache, nicht eines instabilen Frameworks. Ein schnelles Netzwerk verbirgt ihn; ein langsames Netzwerk oder ein schneller Nutzer legt ihn offen. Tun Sie eine sporadische Version dieses Fehlers nicht als Rauschen ab. Reproduzieren Sie ihn, indem Sie eine künstliche Verzögerung vor dem Controller-Schreibvorgang einfügen und den Bildschirm während der Verzögerung schließen.

Er wirft in Tests, aber nicht in der App. Widget-Tests bauen Widgets aggressiv ab und pumpen Frames deterministisch, sodass eine fehlende `mounted`-Absicherung, die sich in einer echten App versteckt, unter `testWidgets` sofort auftaucht. Das ist der Test, der seine Arbeit macht. Das Flutter-Team verfolgt eine Variante davon in [flutter/flutter Issue 98965](https://github.com/flutter/flutter/issues/98965), wo ausstehende Timer in Tests freigegebene Controller anfassen; der Fix dort besteht ebenfalls darin, den Timer in `dispose()` abzubrechen.

Einen Controller über zwei `TextField` auf verschiedenen Routen wiederverwenden. Ein Controller hat genau einen Eigentümer. Wenn Sie einen `TextEditingController` in einem langlebigen Singleton ablegen und ihn einem Feld auf Bildschirm A und einem weiteren auf Bildschirm B übergeben, gibt das Freigeben eines Bildschirms den Controller unter dem anderen frei. Geben Sie jedem Feld seinen eigenen Controller, oder verschieben Sie den Text in einen gemeinsamen Zustand und lassen Sie jedes Feld einen lokalen Controller besitzen.

Die eine Disziplin, die diese ganze Fehlerklasse beseitigt: Ein Controller hat genau einen Eigentümer, dieser Eigentümer gibt ihn genau einmal frei, und jeder asynchrone Pfad, der ihn anfasst, ist durch eine `mounted`-Prüfung abgesichert oder vor dem Abbau abgebrochen. Verankern Sie das in Ihrem `dispose()`-Reflex, und der Fehler hört auf zu erscheinen. Wenn Sie auch das gegenteilige Versagen abfangen wollen (Controller, die nie freigegeben werden), wird der [leak_tracker-Workflow im Freigabe-Leitfaden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) Sie an beide Seiten des Vertrags halten, und Ihre asynchronen Daten als Zustand mit [eleganten Lade- und Fehlerzuständen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) zu modellieren hält die gefährlichen Schreibvorgänge nach dem await komplett vom Controller fern.

## Verwandte Artikel

- [Wie man Controller in Flutter freigibt, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) ist das Spiegelbild: Dieser Absturz ist die Verwendung eines freigegebenen Controllers, jener Leitfaden ist das Vergessen, einen freizugeben.
- [Fix: setState() oder markNeedsBuild() called during build in Flutter](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) teilt den Fix mit der `mounted`-Absicherung für asynchrone Callbacks.
- [Wie man Netzwerkfehler in einer Flutter-App elegant behandelt](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) ist die Quelle der langsamen Antwortzeiten, die diesen Absturz auslösen.
- [Wie man Lade- und Fehlerzustände mit AsyncValue in Flutter Riverpod anzeigt](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) hält asynchrone Ergebnisse im Zustand, statt sie nach einem await direkt in einen Controller zu schreiben.

## Quellen

- [ChangeNotifier, Flutter-API-Referenz](https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html) -- wo die "used after being disposed"-Assertion definiert ist.
- [TextEditingController, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html) -- der Lebenszyklus des Controllers und der `dispose()`-Vertrag.
- [State.mounted, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/State/mounted.html) -- das Flag, das Ihnen sagt, ob der Controller noch lebt.
- [flutter/flutter Issue 98965](https://github.com/flutter/flutter/issues/98965) -- der Fehler, der in Widget-Tests durch ausstehende Timer auftaucht.

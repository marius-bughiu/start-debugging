---
title: "So animiert AnimatedSwitcher auch dann, wenn sich der Typ des Child-Widgets in Flutter nicht ändert"
description: "AnimatedSwitcher startet nur dann einen Übergang, wenn Widget.canUpdate das neue Child als anderes Widget einstuft. Text zu Text ohne Key wird daher einfach an Ort und Stelle aktualisiert. Hier die Ein-Zeilen-Lösung, wo der Key sitzen muss, warum UniqueKey eine Falle ist, der Fehler bei der Slide-Richtung durch einen statischen transitionBuilder und der Layout-Sprung durch den Standard-Stack, alles mit Widget-Tests unter Flutter 3.44.8 verifiziert."
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change"
translatedBy: "claude"
translationDate: 2026-10-19
---

**Kurzantwort:** Geben Sie dem direkten Child von `AnimatedSwitcher` einen Key, der sich immer dann ändert, wenn sich der Inhalt ändert, meist ein `ValueKey` aus den angezeigten Daten: `Text('$count', key: ValueKey<int>(count))`. `AnimatedSwitcher` entscheidet mit `Widget.canUpdate`, ob ein Übergang läuft, und diese Methode vergleicht nur `runtimeType` und `key`. Zwei `Text`-Widgets ohne Key sind für das Framework "dasselbe Widget", also wird das alte an Ort und Stelle aktualisiert und nichts animiert. Alles Folgende wurde mit Widget-Tests unter Flutter 3.44.8 (Dart 3.12.2) verifiziert, und der Quelltext von `_AnimatedSwitcherState` ist auf dem aktuellen `stable`-Branch byte-identisch.

Der Rest dieses Beitrags zeigt die genaue Zeile im Framework, die dieses Verhalten verursacht, ein minimales Repro mit Testausgabe, wo der Key sitzen muss (ein Key eine Ebene tiefer bewirkt nichts), warum `UniqueKey` die falsche Lösung ist und drei Stolperfallen, die direkt nach dem Funktionieren des Übergangs auftauchen: Slide-Übergänge in die falsche Richtung, Inhalt, der in die Mitte springt, und Children, die ihren State verlieren.

## Der eine Vergleich, den AnimatedSwitcher durchführt

`AnimatedSwitcher` ist ein `StatefulWidget`, das einen "aktuellen Eintrag" (das Child plus einen eigenen `AnimationController`) und eine Menge ausgehender Einträge verwaltet, die noch ausgeblendet werden. Wenn der Parent mit einem neuen `child` neu aufgebaut wird, läuft in `didUpdateWidget` diese Prüfung, direkt aus `packages/flutter/lib/src/widgets/animated_switcher.dart`:

```dart
// Flutter 3.44.8, _AnimatedSwitcherState.didUpdateWidget
final hasNewChild = widget.child != null;
final hasOldChild = _currentEntry != null;
if (hasNewChild != hasOldChild ||
    hasNewChild && !Widget.canUpdate(widget.child!, _currentEntry!.widgetChild)) {
  // Child has changed, fade current entry out and add new entry.
  _childNumber += 1;
  _addEntryForNewChild(animate: true);
} else if (_currentEntry != null) {
  // Child has been updated. ... keep the key from the previous transition
  // so that we update the transition instead of replacing it.
  _currentEntry!.widgetChild = widget.child!;
  _updateTransitionForEntry(_currentEntry!);
}
```

Und `Widget.canUpdate` besteht aus einer einzigen Zeile:

```dart
// Flutter 3.44.8, framework.dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

Beachten Sie, was nicht verglichen wird: der Text, die Farbe, die Bild-URL, überhaupt kein Feld. Ein Übergang startet in genau drei Fällen: Das Child wechselt von `null` zu nicht-null, von nicht-null zu `null`, oder das neue Child hat einen anderen Laufzeittyp oder einen anderen Key. Bei einem Wechsel von `Text('1')` zu `Text('2')` trifft keiner dieser Fälle zu, also tauscht der `else`-Zweig das Widget in den bestehenden Eintrag ein, und die Nutzer sehen einen sofortigen Wechsel. Die API-Dokumentation sagt das deutlich, aber das Symptom ("mein AnimatedSwitcher macht nichts") führt selten dazu, dort nachzulesen. Die allgemeine Theorie hinter diesem Vergleich habe ich in [was ein Flutter Key ist und wann sein Weglassen Fehler verursacht](/de/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/) behandelt.

## Ein minimales Repro als Test

Der schnellste Weg zu sehen, ob ein Übergang läuft, ist, die `FadeTransition`-Widgets mitten in der Animation zu zählen. Der Standard-`transitionBuilder` hüllt jeden Eintrag, ein- wie ausgehend, in genau eine `FadeTransition`. Eine bedeutet also "kein Übergang", zwei bedeuten "Überblendung läuft".

```dart
// Flutter 3.44.8, Dart 3.12.2 -- test/switcher_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: child,
      ),
    );

int fades(WidgetTester t) => find.byType(FadeTransition).evaluate().length;

void main() {
  testWidgets('no key: same type is updated in place', (t) async {
    await t.pumpWidget(host(const Text('1')));
    await t.pumpWidget(host(const Text('2')));
    await t.pump(const Duration(milliseconds: 100));
    print('no key -> ${fades(t)}'); // no key -> 1
  });

  testWidgets('ValueKey on the direct child animates', (t) async {
    await t.pumpWidget(host(const Text('1', key: ValueKey(1))));
    await t.pumpWidget(host(const Text('2', key: ValueKey(2))));
    await t.pump(const Duration(milliseconds: 100));
    print('ValueKey -> ${fades(t)}'); // ValueKey -> 2
    await t.pumpAndSettle();
    print('settled -> ${fades(t)}'); // settled -> 1
  });
}
```

Ohne Key gibt es 100 ms nach Beginn einer 300 ms langen Animation eine `FadeTransition`, was bedeutet, dass keine Animation existiert. Mit `ValueKey` sind es zwei, und nach `pumpAndSettle` wurde der ausgehende Eintrag verworfen und entfernt.

## Die Lösung in einem echten Widget

Hier dieselbe Lösung in einem App-Widget. Der Key sitzt auf dem Widget, das Sie als `child` übergeben, und wird aus dem Wert abgeleitet, der den Übergang auslösen soll:

```dart
// Flutter 3.44.8, Dart 3.12.2
class Counter extends StatefulWidget {
  const Counter({super.key});
  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (child, animation) =>
              ScaleTransition(scale: animation, child: child),
          child: Text(
            '$_count',
            key: ValueKey<int>(_count), // the whole fix
            style: Theme.of(context).textTheme.displayMedium,
          ),
        ),
        FilledButton(
          onPressed: () => setState(() => _count++),
          child: const Text('Increment'),
        ),
      ],
    );
  }
}
```

Dasselbe Muster deckt jeden Fall "gleicher Typ, anderer Inhalt" ab, auf den man trifft:

- Bilder austauschen: `Image.network(url, key: ValueKey(url))`.
- Icons austauschen: `Icon(isPlaying ? Icons.pause : Icons.play_arrow, key: ValueKey(isPlaying))`.
- Zwischen Zuständen eines Modells wechseln: `key: ValueKey(user.id)` auf einer Profilkarte, sodass das Bearbeiten desselben Benutzers nicht animiert, die Auswahl eines anderen Benutzers aber schon.
- Lade-, Fehler- und Datenzweige, die zufällig denselben Widget-Typ zurückgeben (zum Beispiel drei `Center`-Widgets): Geben Sie ihnen `ValueKey('loading')`, `ValueKey('error')`, `ValueKey('data')`. Stammt Ihr asynchroner Zustand aus Riverpod, passt das gut zu [Lade- und Fehlerzuständen mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

Die Wahl dessen, was im Key steht, ist die Wahl, wann die Animation feuert. Ein Key aus `count` animiert bei jedem Inkrement. Ein Key aus `count ~/ 10` animiert nur, wenn sich die Zehnerstelle ändert, während sich der innere Text weiterhin an Ort und Stelle aktualisiert.

## Der Key muss auf dem direkten Child sitzen

`canUpdate` betrachtet immer nur `widget.child`, das Widget, das Sie direkt an `AnimatedSwitcher` übergeben. Ein Key auf etwas darin Verschachteltem ist für diesen Vergleich unsichtbar:

```dart
// Flutter 3.44.8 -- does NOT animate
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: Padding(
    padding: const EdgeInsets.all(8),
    child: Text('$_count', key: ValueKey<int>(_count)), // too deep
  ),
)
```

In meinem Test ergab das mitten in der Animation eine `FadeTransition`, genau wie ganz ohne Key. Das äußere `Padding` hat keinen Key und jedes Mal denselben Typ, also aktualisiert der Switcher es an Ort und Stelle, und das innere `Text` bekommt ein frisches Element ganz ohne Übergang. Verschieben Sie den Key auf das `Padding` (oder auf Ihr oberstes Widget, oft ein `Container`, eine `Card` oder Ihr eigenes `StatelessWidget`), und es funktioniert.

Das tritt auch auf, wenn das Child Ihre eigene Widget-Klasse ist:

```dart
// Flutter 3.44.8
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: StatusBadge(status: status, key: ValueKey(status)),
)
```

Den `key` im Konstruktor von `StatusBadge` über `super.key` durchzureichen genügt. Einen Key auf etwas innerhalb von `StatusBadge.build` zu setzen genügt nicht.

## Warum UniqueKey die falsche Lösung ist

Die erste Antwort, die viele finden, ist `key: UniqueKey()`. Damit animiert der Switcher zwar, aber bei jedem Neuaufbau des Parents, nicht nur bei einer Inhaltsänderung:

```dart
// Flutter 3.44.8, Dart 3.12.2
testWidgets('UniqueKey animates on every rebuild', (t) async {
  await t.pumpWidget(host(Text('1', key: UniqueKey())));
  await t.pumpWidget(host(Text('1', key: UniqueKey()))); // same text
  await t.pump(const Duration(milliseconds: 100));
  print(fades(t)); // 2
});
```

Gleicher Text, trotzdem eine volle Überblendung. In einem echten Screen baut der Parent aus Gründen neu auf, die mit dem umgeschalteten Inhalt nichts zu tun haben: eine `MediaQuery`-Änderung, wenn die Tastatur sich öffnet, ein Theme-Wechsel, ein unabhängiges `setState`, ein Provider, der benachrichtigt. Jeder dieser Fälle startet den Übergang neu, und jeder wirft Element und State des Childs weg. Der umgekehrte Fehler ist ein konstanter Key wie `ValueKey('label')` auf einem `Text`, dessen String sich ändert. Dieser Key ändert sich nie, also ist `canUpdate` wahr, und nichts animiert. Mein Test bestätigte eine `FadeTransition` und den sofort angezeigten neuen Text. Leiten Sie den Key immer aus den Daten ab.

## Schnelle Wechsel und null-Children

Zwei Verhaltensweisen, die man kennen sollte, damit man sie nicht für Fehler hält:

1. Ändert sich das Child erneut, bevor der vorherige Übergang endet, bricht der Switcher nichts ab. Der aktuelle Eintrag wird in die Menge der ausgehenden verschoben und rückwärts abgespielt, sodass mehrere Children gleichzeitig ausgeblendet werden können. Ein Wechsel von 1 zu 2 zu 3 innerhalb von 100 ms hinterließ drei `FadeTransition`-Widgets im Baum. Deshalb kann derselbe Key auch sicher wiederkehren: Jeder Übergang ist in einen `KeyedSubtree` gehüllt, der mit einem internen Zähler (`_childNumber`) verschlüsselt ist, sodass ein neues Child mit dem Key `A` nie mit einem ausgehenden Child verwechselt wird, das ebenfalls den Key `A` hatte.
2. `child: null` zu setzen ist ein gültiger Weg, Inhalt auszublenden. `hasNewChild != hasOldChild` löst den Übergang aus, das alte Child wird ausgeblendet, und nichts wird eingeblendet.

## Stolperfalle: Slide-Übergänge in die falsche Richtung

Sobald die Überblendung funktioniert, lautet der nächste Wunsch meist ein horizontaler Slide: Der neue Wert schiebt sich von rechts herein, der alte nach links hinaus. Die naive Version schiebt beide Children von rechts herein und nach rechts hinaus, weil der Controller des ausgehenden Childs einfach rückwärts über denselben Tween läuft. Der übliche Trick ist, im `transitionBuilder` zu prüfen, ob das gerade umhüllte Child das aktuelle ist:

```dart
// Flutter 3.44.8, Dart 3.12.2
Widget _slide(Widget child, Animation<double> animation) {
  final incoming = child.key == ValueKey<int>(_count);
  final offset = Tween<Offset>(
    begin: Offset(incoming ? 1 : -1, 0),
    end: Offset.zero,
  ).animate(animation);
  return ClipRect(child: SlideTransition(position: offset, child: child));
}
```

Hier kommt der subtile Teil. `AnimatedSwitcher` führt `transitionBuilder` für ausgehende Einträge nur dann erneut aus, wenn `widget.transitionBuilder != oldWidget.transitionBuilder` gilt. Ein direkt in `build` geschriebenes Funktionsliteral wie `transitionBuilder: (c, a) => _slide(c, a)` erzeugt bei jedem Build ein neues Closure-Objekt, der Vergleich ist also wahr, jeder Eintrag wird mit dem aktuellen `_count` neu aufgebaut, und das alte Child wird korrekt als ausgehend erkannt. Ein Methoden-Tear-off wie `transitionBuilder: _slide` oder ein in einem Feld gespeicherter Builder kann über Builds hinweg gleich sein, sodass der ausgehende Eintrag den Übergang behält, mit dem er als eingehender gebaut wurde. Ich habe beide Varianten ausgeführt und die `SlideTransition`-Offsets zur Hälfte der Animation gelesen:

```text
inline closure:   child 1 dx=-0.50   child 2 dx=0.50
stored function:  child 1 dx= 0.50   child 2 dx=0.50
```

Mit der gespeicherten Funktion gleitet das alte Child wieder nach rechts hinaus, direkt über dem neuen. Wenn Sie einen richtungsabhängigen `transitionBuilder` schreiben, übergeben Sie ihn als Inline-Closure (oder stellen Sie anderweitig sicher, dass er ein neues Objekt ist, sobald sich der Key ändert), und fügen Sie einen Test wie den obigen hinzu, damit ein Refactoring zu einem Tear-off ihn nicht unbemerkt kaputt macht.

## Stolperfalle: Inhalt springt in die Mitte oder die Größe schnappt

Der Standard-`layoutBuilder` legt die ausgehenden Children und das aktuelle Child in einen `Stack` mit `alignment: Alignment.center`. Zwei sichtbare Nebenwirkungen:

- Linksbündiger Inhalt, zum Beispiel ein Label in einer `Row` oder ein `ListTile`-Untertitel, springt während des Übergangs in die Mitte.
- Der `Stack` ist so groß wie das größte Child. Wird also ein langer String durch einen kurzen ersetzt, schrumpft der Platz erst, wenn das alte Child verschwunden ist.

Beides lässt sich mit einem eigenen `layoutBuilder` beheben, optional in `AnimatedSize` gehüllt, um die Größenänderung zu glätten:

```dart
// Flutter 3.44.8, Dart 3.12.2
AnimatedSize(
  duration: const Duration(milliseconds: 200),
  alignment: Alignment.centerLeft,
  child: AnimatedSwitcher(
    duration: const Duration(milliseconds: 200),
    layoutBuilder: (currentChild, previousChildren) => Stack(
      alignment: Alignment.centerLeft,
      children: [
        ...previousChildren,
        if (currentChild != null) currentChild,
      ],
    ),
    child: Text(status, key: ValueKey(status)),
  ),
)
```

Lassen Sie `previousChildren` vor `currentChild` stehen, damit das eingehende Widget oben gezeichnet wird, wie im Standard.

## Stolperfalle: Der State des Childs wird verworfen

Ein geänderter Key bedeutet ein neues Element. Jeder `State` unterhalb des umgeschalteten Childs, etwa ein in `initState` erzeugter `TextField`-Controller, eine Scrollposition oder ein Aufklappstatus, wird für das eingehende Child frisch angelegt. In meinem Test war das Element vor und nach einer Key-Änderung ein anderes Objekt. Das ist meist genau das, was man für "zeige etwas anderes" will, aber das falsche Werkzeug für "animiere eine Eigenschaft derselben Sache". Tippt der Benutzer gerade in ein Feld und Sie vergeben den Key anhand des Textes, wird das Feld bei jedem Tastendruck neu erzeugt und verliert den Fokus.

Für Eigenschaftsänderungen am selben Widget nutzen Sie stattdessen eine implizite Animation: `AnimatedDefaultTextStyle`, `AnimatedContainer`, `AnimatedOpacity` oder `TweenAnimationBuilder` für einen beliebigen Wert. Diese behalten das Element und interpolieren die Eigenschaft. `AnimatedSwitcher` dient dazu, Inhalt zu ersetzen, und der Key ist die Art, ihm mitzuteilen, dass der Inhalt ersetzt wurde. Soll der Übergang über Screens hinweg statt innerhalb eines Screens stattfinden, werfen Sie stattdessen einen Blick auf [eine Hero-Animation zwischen zwei Screens](/de/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) oder [eigene Seitenübergänge](/de/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/).

## Checkliste, wenn AnimatedSwitcher nichts tut

1. Setzen Sie einen Key auf das Widget, das direkt als `child` übergeben wird, nicht auf etwas darin.
2. Leiten Sie den Key aus den Daten ab, die den Übergang auslösen sollen, meist `ValueKey(value)`, niemals ein in `build` erzeugtes `UniqueKey()`.
3. Prüfen Sie, dass sich der Key tatsächlich ändert: Ein konstanter `ValueKey('x')` ist für diesen Zweck dasselbe wie kein Key.
4. Stellen Sie sicher, dass der `AnimatedSwitcher` selbst nicht neu erzeugt wird: Ändert ein Vorfahr Typ oder Key, wird der State des Switchers von Grund auf neu aufgebaut, und das erste Child wird ohne Animation angezeigt (`initState` ruft `_addEntryForNewChild(animate: false)` auf).
5. Wenn Sie einen richtungsabhängigen `transitionBuilder` verwenden, übergeben Sie ihn als Inline-Closure, damit ausgehende Einträge neu aufgebaut werden.
6. Beheben Sie Ausrichtung und Größe mit einem eigenen `layoutBuilder` und `AnimatedSize`.

### Weiterlesen

- [Was ist ein Flutter Key und wann verursacht sein Weglassen Fehler?](/de/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Lade- und Fehlerzustände mit AsyncValue in Flutter Riverpod anzeigen](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [So fügen Sie in Flutter eine Hero-Animation zwischen zwei Screens hinzu](/de/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)
- [Eigene Seitenübergänge nach der Neuorganisation der Flutter-Page-Transition-Builder migrieren](/de/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/)
- [Fix: setState() or markNeedsBuild() called during build in Flutter](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)

## Quellen

- [AnimatedSwitcher class, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher-class.html)
- [AnimatedSwitcher.layoutBuilder, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher/layoutBuilder.html)
- [Widget.canUpdate, Flutter API docs](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [animated_switcher.dart on the stable branch, flutter/flutter](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/widgets/animated_switcher.dart)
- [Implicit animations, Flutter docs](https://docs.flutter.dev/codelabs/implicit-animations)

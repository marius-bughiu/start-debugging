---
title: "Rücktaste in einem leeren Flutter-TextField einer OTP-Eingabe erkennen"
description: "onChanged feuert nie, weil keine Bearbeitung stattfindet, und unter iOS kehrt deleteBackward im Engine zurück, ohne irgendetwas anzufassen, wenn das Feld leer ist. Zwei Ansätze, die auf allen Plattformen funktionieren: ein Sentinel-Zeichen mit Breite null, das eine Bearbeitung garantiert, und ein einzelnes EditableText hinter gezeichneten Zellen. Verifiziert mit Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "textfield"
  - "forms"
lang: "de"
translationOf: "2026/09/how-to-detect-a-backspace-press-on-an-empty-flutter-textfield-in-an-otp-input"
translatedBy: "claude"
translationDate: 2026-09-06
---

Es gibt kein Callback, das feuert. Ist ein `TextField` bereits leer und der Benutzer tippt auf der Bildschirmtastatur die Rücktaste, läuft `onChanged` nicht, `TextEditingController` benachrichtigt nicht, und unter iOS sendet die Engine überhaupt nichts an das Framework. Das ist kein Flutter-Fehler, sondern genau das, was ein IME ist: eine Touch-Anwendung, die Textbearbeitungen ausgibt, und das Löschen eines leeren Feldes erzeugt keine Bearbeitung. Die Antwort auf "wie setze ich den Fokus zurück auf die vorherige OTP-Zelle" lautet deshalb, nicht länger nach dem Ereignis zu fragen, sondern die Daten zu ändern. Entweder enthält jede Zelle ein unsichtbares Sentinel-Zeichen, damit die Rücktaste immer eine echte Bearbeitung erzeugt, oder Sie geben das Design mit sechs getrennten Feldern auf und setzen ein einzelnes `EditableText` hinter sechs gezeichnete Zellen, so wie es [`pinput`](https://pub.dev/packages/pinput) intern macht. Alles Folgende wurde gegen den aktuellen Stable-Kanal geschrieben und ausgeführt, Flutter 3.47.2 mit Dart 3.13.2.

## Die Version dieses Widgets, die jeder zuerst schreibt

Sechs Controller, sechs Focus Nodes, bei Eingabe vorrücken, beim Löschen zurückspringen. Das sieht offensichtlich richtig aus:

```dart
// Flutter 3.47.2, Dart 3.13.2
class _NaiveOtpRowState extends State<NaiveOtpRow> {
  static const int _length = 6;

  final List<TextEditingController> _controllers =
      List<TextEditingController>.generate(_length, (_) => TextEditingController());
  final List<FocusNode> _nodes = List<FocusNode>.generate(_length, (_) => FocusNode());

  @override
  void dispose() {
    for (final TextEditingController c in _controllers) {
      c.dispose();
    }
    for (final FocusNode n in _nodes) {
      n.dispose();
    }
    super.dispose();
  }

  void _onChanged(String value, int index) {
    if (value.isNotEmpty && index < _length - 1) {
      _nodes[index + 1].requestFocus();
      return;
    }
    // This branch runs when a filled cell is emptied.
    // It never runs when the cell was already empty.
    if (value.isEmpty && index > 0) {
      _nodes[index - 1].requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: <Widget>[
        for (int i = 0; i < _length; i++)
          SizedBox(
            width: 44,
            child: TextField(
              controller: _controllers[i],
              focusNode: _nodes[i],
              textAlign: TextAlign.center,
              keyboardType: TextInputType.number,
              maxLength: 1,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (String value) => _onChanged(value, i),
            ),
          ),
      ],
    );
  }
}
```

Tippen Sie `1 2 3`, und der Fokus landet in Zelle vier. Drücken Sie einmal die Rücktaste, dann leert sich Zelle drei und der Fokus wandert in Zelle zwei. Drücken Sie die Rücktaste erneut, passiert nichts mehr, dauerhaft. Der Benutzer sitzt in einer bereits leeren Zelle fest, ohne Rückweg außer durch Antippen.

Der Grund steht sichtbar im Code darüber, sobald man danach sucht. `_onChanged` wird von `TextField` nur aufgerufen, wenn sich der Bearbeitungswert ändert. Nichts zu löschen ändert nichts, also gibt es nichts, womit es aufgerufen werden könnte.

## Bildschirmtastaturen haben keine Rücktaste

Der Reflex sagt, hier fehle eine Funktion und Flutter solle den Tastendruck einfach ausliefern. Greg Spencer, der das Tastenereignis-System verantwortet, hat das mehrfach in [flutter/flutter#14809](https://github.com/flutter/flutter/issues/14809) beantwortet, dem kanonischen Issue zu genau diesem OTP-Widget. Seine Formulierung lohnt sich zu verinnerlichen. Eine Bildschirmtastatur ist ein Input Method Editor: eine eigene Anwendung, die Toucheingaben entgegennimmt und einen Strom von Bearbeitungsereignissen erzeugt, der über eine Texteingabeverbindung an Ihre App geht. Sie "betätigt nie einen Knopf am Gerät", also gibt es von vornherein keinen Tastendruck zum Weiterreichen.

Eine physische Tastatur löst ein Hardware-Ereignis auf Betriebssystemebene aus, und jede App im Vordergrund sieht es. Eine Bildschirmtastatur zeichnet das Bild einer Taste, bemerkt eine Berührung und ruft eine Bearbeitungs-API auf Ihrem Textfeld auf. Ist das Feld leer, gibt es keine Bearbeitung anzufordern, also rufen die meisten IMEs gar nichts auf.

Dieses Issue wurde am 2018-02-21 eröffnet und am 2021-08-17 mit dem Ergebnis geschlossen, dass Flutter es nicht beheben kann. [Issue #50587](https://github.com/flutter/flutter/issues/50587), das dieselbe Frage im selben OTP-Kontext stellt, wurde als Duplikat davon geschlossen. Wer nach einem offenen Tracking-Issue zum Abonnieren sucht: es gibt keines, und das ist Absicht.

## Was die Engine auf jeder Plattform tatsächlich tut

Die Erklärung auf Framework-Ebene ist korrekt, aber abstrakt, und das Verhalten unterscheidet sich je nach Plattform so stark, dass ein Workaround auf einem Gerät richtig aussehen und auf einem anderen tot sein kann. Der Quelltext der Engine klärt das.

Unter iOS implementiert `FlutterTextInputView` das Protokoll `UIKeyInput`, also ruft UIKit `deleteBackward` auf, wenn der Benutzer die Löschtaste antippt. So sieht diese Methode in `shell/platform/darwin/ios/framework/Source/FlutterTextInputPlugin.mm` im Tag 3.47.2 aus:

```objc
// Flutter engine 3.47.2, abridged.
- (void)deleteBackward {
  _selectionAffinity = kTextAffinityDownstream;
  // ...
  if (_selectedTextRange.isEmpty && [self hasText]) {
    // Move the collapsed selection back one grapheme cluster,
    // widening it into a one-character range to delete.
  }

  if (!_selectedTextRange.isEmpty) {
    [self replaceRange:_selectedTextRange withText:@""];
  }
}
```

Lesen Sie die beiden Wächter für ein leeres Feld zusammen. `hasText` ist false, also wird der erste Block übersprungen und die Auswahl nie erweitert. Die Auswahl ist weiterhin leer, also wird der zweite Block übersprungen und `replaceRange:` nie aufgerufen. `replaceRange:` ist das, was am Ende einen neuen Bearbeitungszustand über den Platform Channel meldet, also gelangt überhaupt nichts nach Dart. Unter iOS gibt es kein Tastenereignis abzufangen, weil UIKit nie eines erzeugt hat, und es gibt kein Bearbeitungsereignis, weil die Engine sich korrekt geweigert hat, eines zu erfinden.

Android ist anders, und daher kommt die Verwirrung. `InputConnection` erlaubt es einem IME, statt eines Bearbeitungsaufrufs ein echtes `KeyEvent` zu senden, und Flutters `InputConnectionAdaptor` leitet es direkt in dieselbe Pipeline wie eine physische Taste:

```java
// engine/src/flutter/shell/platform/android/io/flutter/plugin/editing/InputConnectionAdaptor.java, 3.47.2
// This function is called both when hardware key events occur and aren't
// handled by the framework, as well as when soft keyboard editing events
// occur, and need a chance to be handled by the framework.
@Override
public boolean sendKeyEvent(KeyEvent event) {
  return keyboardDelegate.handleEvent(event);
}
```

Unter Android erzeugt ein IME, das `InputConnection.sendKeyEvent` mit `KEYCODE_DEL` aufruft, also ein echtes `KeyDownEvent` in Ihrem Flutter-Baum, egal ob das Feld leer ist oder nicht. Ob es das tut, entscheidet allein die Tastatur. Die Ziffern- und Symbolblöcke von Gboard haben das Tastenereignis historisch gesendet, das Standard-QWERTY-Layout historisch nicht; die Samsung-Tastatur, SwiftKey und jeder OEM-IME treffen ihre eigene Entscheidung; und ein Benutzer kann alles Mögliche installieren. Flutter-Mitarbeiter LongCatIsLooong hat es in [flutter/flutter#148375](https://github.com/flutter/flutter/issues/148375) auf den Punkt gebracht: eine Bildschirmtastatur kann jeden beliebigen Tastendruck als Hardware-Tastenereignis senden, bis hin zu einem gewöhnlichen Buchstaben, und Flutter hat keine Möglichkeit, diese von echten zu unterscheiden.

## Warum die KeyboardListener-Antwort auf Ihrem Testgerät funktioniert

Die am häufigsten hochgestimmte Antwort zu diesem Thema lautet, die Taste abzufangen. Im modernen Flutter heißt das ein `Focus`-Wrapper, denn `RawKeyboardListener` und `RawKeyEvent` tragen `'This feature was deprecated after v3.18.0-2.0.pre.'`, und jedes Stack-Overflow-Snippet mit `event.data.logicalKey` kompiliert heute nicht mehr sauber:

```dart
// Flutter 3.47.2. Works on hardware keyboards. Works on *some* Android IMEs.
// Never works on iOS.
Focus(
  onKeyEvent: (FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey != LogicalKeyboardKey.backspace) {
      return KeyEventResult.ignored;
    }
    if (_controllers[index].text.isNotEmpty) {
      return KeyEventResult.ignored; // Let the field handle a real delete.
    }
    if (index > 0) {
      _controllers[index - 1].clear();
      _nodes[index - 1].requestFocus();
    }
    return KeyEventResult.handled;
  },
  child: TextField(controller: _controllers[index], focusNode: _nodes[index]),
)
```

Das ist es wert, ausgeliefert zu werden, aber nur als Ergänzung. Es ist die vollständige Antwort im Web, unter Windows, macOS, Linux und auf jedem Tablet mit angeschlossener Tastatur, wo Hardware-Tastenereignisse immer ankommen. Unter Android ist es ein Münzwurf, abhängig vom IME des Benutzers und vom Tastenlayout, das Ihr `keyboardType` geöffnet hat. Unter iOS ist es tot.

Justin McCandless aus dem Flutter-Team selbst hat die `Shortcuts`/`Actions`-Variante im Juli 2021 in #14809 gepostet und den Kommentar danach so bearbeitet, dass er mit "*Update*: Not fixed, this only works for hardware keyboards." beginnt. Trägt ein gefundenes Snippet diesen Vorbehalt nicht, wurde es vor der Bearbeitung kopiert.

## Lösung 1: die Zelle nie wirklich leer werden lassen

Wenn das Problem ist, dass das Löschen von nichts keine Bearbeitung erzeugt, geben Sie der Tastatur etwas zu löschen. Initialisieren Sie jeden Controller mit einem Leerzeichen der Breite null, `U+200B`, das als nichts gerendert wird und null Pixel misst. Die Rücktaste in einer optisch leeren Zelle löscht nun ein echtes Zeichen, `onChanged` feuert mit `''`, und Sie haben Ihr Signal.

```dart
// Flutter 3.47.2, Dart 3.13.2
const String _zwsp = '\u200B';

class _SentinelOtpRowState extends State<SentinelOtpRow> {
  static const int _length = 6;

  late final List<TextEditingController> _controllers = List<TextEditingController>.generate(
    _length,
    (_) => TextEditingController(text: _zwsp),
  );
  late final List<FocusNode> _nodes = List<FocusNode>.generate(_length, (_) => FocusNode());

  String get code => _controllers.map((TextEditingController c) => c.text.replaceAll(_zwsp, '')).join();

  // Always rewrite the whole value so the caret is guaranteed to sit
  // after the sentinel. If it sits before it, backspace deletes nothing
  // and you are back where you started.
  void _setCell(int index, String digit) {
    final String text = '$_zwsp$digit';
    _controllers[index].value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  void _onChanged(String value, int index) {
    if (value.isEmpty) {
      // The sentinel itself was deleted: backspace on an empty cell.
      _setCell(index, '');
      if (index > 0) {
        _setCell(index - 1, '');
        _nodes[index - 1].requestFocus();
      }
      return;
    }

    final String digits = value.replaceAll(_zwsp, '');
    if (digits.isEmpty) {
      // A filled cell was emptied. Stay put; the next backspace steps left.
      _setCell(index, '');
      return;
    }

    if (digits.length > 1) {
      // A paste, or a fast typist. Spread it across the remaining cells.
      for (int i = 0; i < digits.length && index + i < _length; i++) {
        _setCell(index + i, digits[i]);
      }
      final int next = index + digits.length;
      _nodes[next < _length ? next : _length - 1].requestFocus();
      return;
    }

    _setCell(index, digits);
    if (index < _length - 1) {
      _nodes[index + 1].requestFocus();
    }
  }
}
```

Zwei Details entscheiden über Erfolg oder Misserfolg. Der Cursor muss immer hinter dem Sentinel stehen, weshalb `_setCell` einen vollständigen `TextEditingValue` schreibt, statt `controller.text` zuzuweisen (der Setter kollabiert die Auswahl auf Offset -1 und hinterlässt den IME in einem sonderbaren Zustand). Und `maxLength: 1` können Sie nicht mehr verwenden, weil das Sentinel mitzählt; begrenzen Sie die Länge stattdessen in `_onChanged`, wie oben.

## Was das Sentinel kostet

Es ist ein Workaround, und die Rechnung kommt in sechs Teilen.

- **Die Großschreibung unter iOS bricht.** Ein Feld, dessen Wert mit einem unsichtbaren Zeichen beginnt, steht für iOS nicht am Satzanfang, also bietet die Tastatur keinen Großbuchstaben mehr an. Von kasyr im August 2021 in #14809 gemeldet und für jeden getesteten unsichtbaren Codepunkt bestätigt, nicht nur für `U+200B`. Für numerische OTPs irrelevant, für alphanumerische Codes fatal. Der Workaround in jenem Thread ist, ein echtes Leerzeichen zu speichern und `TextEditingController` abzuleiten, um `buildTextSpan` zu überschreiben, sodass das Leerzeichen nur beim Zeichnen gegen eines der Breite null getauscht wird.
- **Jeder Lesezugriff braucht eine Bereinigung.** Jeder Codepfad, der `controller.text` anfasst und `.replaceAll(_zwsp, '')` vergisst, schickt ein unsichtbares Zeichen in Ihre API-Anfrage, und es ist weder in einer Logzeile noch in der String-Vorschau eines Debuggers sichtbar.
- **Die Barrierefreiheit wird trüb.** TalkBack und VoiceOver sehen ein nicht leeres Feld ohne ansagbaren Inhalt. Setzen Sie pro Zelle ein explizites `InputDecoration.labelText` oder ein `Semantics`-Label, damit der Zustand beschreibbar bleibt.
- **Autofill funktioniert weitgehend nicht.** `AutofillHints.oneTimeCode` wird unter Android auf `AUTOFILL_HINT_SMS_OTP` abgebildet, unter iOS auf `oneTimeCode` und im Web auf `one-time-code`. Keine der beiden mobilen Plattformen verteilt einen sechsstelligen Code auf sechs getrennte Felder; iOS füllt nur das fokussierte Feld.
- **Die Auswahl ist für den Benutzer erreichbar.** Ein langer Druck oder ein Ziehen des Cursors kann diesen vor das Sentinel setzen. Sie brauchen pro Zelle einen `onTap`-Handler, der die Auswahl wieder festsetzt.
- **Die Formatter-Liste muss angepasst werden.** `FilteringTextInputFormatter.digitsOnly` frisst Ihr Sentinel. Verwenden Sie `FilteringTextInputFormatter.allow(RegExp('[0-9\u200B]'))`.

Wenn Ihr Produkt einen alphanumerischen Code verwendet, hören Sie hier auf und nehmen Sie den nächsten Ansatz. Handelt es sich um ein sechsstelliges numerisches OTP und die Lösung läuft bereits produktiv, ist das Sentinel vertretbar.

## Lösung 2: ein Feld, sechs gezeichnete Zellen

Die sauberere Antwort lautet, dass das Design mit sechs Feldern der eigentliche Fehler ist. Die Rücktaste in einer leeren Zelle ist nur deshalb ein Problem, weil der Fokus auf sechs Eingaben verteilt ist. Halten Sie den gesamten Code in einem einzigen `TextField` und zeichnen Sie die Kästchen selbst, dann verschwindet diese ganze Problemklasse: jede Rücktaste außer der auf einem vollständig leeren Code ist eine gewöhnliche Bearbeitung, die `onChanged` normal auslöst, und eine Rücktaste auf einem vollständig leeren Code soll nichts tun, was genau das ist, was passiert.

```dart
// Flutter 3.47.2, Dart 3.13.2
class OtpInput extends StatefulWidget {
  const OtpInput({super.key, this.length = 6, required this.onCompleted});

  final int length;
  final ValueChanged<String> onCompleted;

  @override
  State<OtpInput> createState() => _OtpInputState();
}

class _OtpInputState extends State<OtpInput> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    _controller.addListener(_handleChange);
  }

  @override
  void dispose() {
    _controller.removeListener(_handleChange);
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _handleChange() {
    setState(() {});
    if (_controller.text.length == widget.length) {
      widget.onCompleted(_controller.text);
    }
  }

  Widget _cell(int index) {
    final String code = _controller.text;
    final bool filled = index < code.length;
    final bool active = _focusNode.hasFocus && index == code.length;
    return Container(
      width: 44,
      height: 56,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          width: active ? 2 : 1,
          color: active ? Theme.of(context).colorScheme.primary : Theme.of(context).dividerColor,
        ),
      ),
      child: Text(filled ? code[index] : '', style: Theme.of(context).textTheme.headlineSmall),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        IgnorePointer(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: <Widget>[for (int i = 0; i < widget.length; i++) _cell(i)],
          ),
        ),
        // The real input sits on top, invisible, and owns every gesture.
        Positioned.fill(
          child: TextField(
            controller: _controller,
            focusNode: _focusNode,
            autofocus: true,
            keyboardType: TextInputType.number,
            autofillHints: const <String>[AutofillHints.oneTimeCode],
            maxLength: widget.length,
            showCursor: false,
            enableInteractiveSelection: false,
            inputFormatters: <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly],
            style: const TextStyle(color: Colors.transparent, height: 0.01),
            decoration: const InputDecoration(
              counterText: '',
              border: InputBorder.none,
              contentPadding: EdgeInsets.zero,
            ),
          ),
        ),
      ],
    );
  }
}
```

`enableInteractiveSelection: false` zusammen mit `showCursor: false` hält den Cursor ohne manuelle Auswahl-Jonglage am Ende fest und entfernt die Auswahlleiste, die sonst über Ihren gezeichneten Kästchen aufklappen würde. Bauen Sie auch bei Fokuswechsel neu auf, entweder mit einem Listener auf `_focusNode` oder durch Umschließen mit einem `Focus`-Widget, damit die Hervorhebung der aktiven Zelle korrekt mitläuft.

## Warum das die Version ist, die man ausliefert

Das ist kein cleverer Trick, sondern das Design, auf das sich das Ökosystem geeinigt hat. `pinput` 6.0.2, das meistgenutzte OTP-Paket auf pub.dev, baut in `lib/src/pinput_state.dart` ein einzelnes `EditableText` und zeichnet die Zellen darum herum, aus genau diesen Gründen:

- **Autofill funktioniert.** Ein Feld mit `AutofillHints.oneTimeCode` ist genau das, was die QuickType-Leiste von iOS und das SMS-OTP-Autofill von Android füllen sollen. Sechs Felder nicht.
- **Einfügen funktioniert.** Ein Benutzer, der einen Code aus einer Nachricht kopiert, fügt sechs Zeichen in ein Feld ein, und sie landen korrekt, ohne Verteilungslogik.
- **Screenreader funktionieren.** Ein beschriftetes Feld mit einem Wert statt sechs Feldern, deren Zusammenhang ein Screenreader nicht vermitteln kann.
- **Der Zustand ist ein String.** Kein Array von Controllern, das synchron gehalten, freigegeben und durchdacht werden muss, was eine ganze Familie von Lebenszyklusfehlern beseitigt. Siehe [Controller in Flutter freigeben, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) und [Fix: A TextEditingController was used after being disposed in Flutter](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) für das, was die Variante mit sechs Controllern später zu kosten pflegt.
- **Die Rücktaste ist nichts Besonderes.** Sie ist ein gewöhnliches Löschen gegen einen nicht leeren String, bis der String leer ist, und dann tut sie korrekterweise nichts.

Behalten Sie den `Focus`/`onKeyEvent`-Handler von vorhin nur dann, wenn Sie zusätzlich eine physische Tastatur unterstützen und bei der Rücktaste auf einem leeren Code etwas Zusätzliches auslösen wollen, etwa ein Fehlerbanner zu leeren oder die Route zu schließen. Das ist die eine Aufgabe, die er überall zuverlässig erledigt, weil er nur dann funktionieren muss, wenn eine Hardware-Tastatur vorhanden ist.

## Wie man das testet, ohne sich selbst zu täuschen

`WidgetTester.sendKeyEvent` verteilt über `HardwareKeyboard`, den Pfad der physischen Tastatur. Ein damit geschriebener Test besteht gegen die `Focus`/`onKeyEvent`-Implementierung, auch auf dem iOS-Target, während die echte App auf einem echten iPhone nichts tut. Dieser Test ist schlimmer als gar kein Test, weil er ausgerechnet die Plattform zertifiziert, auf der der Ansatz nicht funktionieren kann.

Steuern Sie stattdessen den Texteingabekanal an. `tester.enterText` läuft über `TextInputConnection.updateEditingValue`, den Pfad, den ein IME tatsächlich verwendet, also ist das Kürzen des Strings eine getreue Simulation einer Rücktaste auf der Bildschirmtastatur:

```dart
// Flutter 3.47.2, package:flutter_test
testWidgets('deleting the last digit clears the cell without losing focus', (WidgetTester tester) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: OtpInput(onCompleted: (_) {}))));

  await tester.enterText(find.byType(TextField), '123456');
  await tester.pump();
  expect(find.text('6'), findsOneWidget);

  await tester.enterText(find.byType(TextField), '12345'); // soft-keyboard backspace
  await tester.pump();
  expect(find.text('6'), findsNothing);

  await tester.enterText(find.byType(TextField), ''); // and again on an empty code
  await tester.pump();
  expect(tester.widget<TextField>(find.byType(TextField)).focusNode!.hasFocus, isTrue);
});
```

Für die Sentinel-Implementierung lautet die entsprechende Zusicherung, dass die Eingabe von `''` in Zelle `n` die Zelle `n - 1` fokussiert zurücklässt und beide Zellen genau ein `\u200B` enthalten. Wenn Sie in diesen Tests weiteren Umgebungszustand fixieren, deckt [einen Flutter-Widget zu einem festen Zeitpunkt testen](/de/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) dieselbe Idee auf Binding-Ebene ab.

Die Kurzfassung, falls Sie hierher gesprungen sind: das gewünschte Ereignis existiert nicht, also bauen Sie das Widget, das es nicht braucht.

### Weiterlesen

- [How to dispose controllers in Flutter to avoid memory leaks](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Fix: A TextEditingController was used after being disposed in Flutter](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Fix: A RenderFlex overflowed by N pixels on the bottom when the keyboard opens in Flutter](/de/2026/08/fix-renderflex-overflowed-on-the-bottom-when-the-keyboard-opens-in-flutter/)
- [What is a Flutter Key and when does omitting it cause bugs?](/de/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [How to test a Flutter widget at a fixed point in time without a withClock closure](/de/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/)

### Quellen

- [Issue #14809: Detect when delete is typed into a TextField](https://github.com/flutter/flutter/issues/14809), flutter/flutter
- [Issue #50587: How do I listen to backspace/delete key (from the on screen keyboard) on an empty TextField?](https://github.com/flutter/flutter/issues/50587), flutter/flutter
- [Issue #148375: On Android, KeyboardListener catches software keyboard input](https://github.com/flutter/flutter/issues/148375), flutter/flutter
- [`InputConnection.sendKeyEvent`](https://developer.android.com/reference/android/view/inputmethod/InputConnection#sendKeyEvent(android.view.KeyEvent)), Android-API-Referenz
- [`UIKeyInput.deleteBackward()`](https://developer.apple.com/documentation/uikit/uikeyinput/deletebackward()), UIKit-Dokumentation
- [Migrate RawKeyEvent/RawKeyboard to the KeyEvent/HardwareKeyboard system](https://docs.flutter.dev/release/breaking-changes/key-event-migration), Breaking Changes von Flutter
- [`AutofillHints.oneTimeCode`](https://api.flutter.dev/flutter/services/AutofillHints/oneTimeCode-constant.html), Flutter-API-Referenz
- [`pinput` 6.0.2](https://pub.dev/packages/pinput), pub.dev

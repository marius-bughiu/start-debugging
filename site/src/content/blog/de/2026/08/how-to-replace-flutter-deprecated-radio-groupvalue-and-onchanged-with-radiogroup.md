---
title: "Veraltetes groupValue und onChanged von Radio in Flutter durch RadioGroup ersetzen"
description: "Radio.groupValue und Radio.onChanged wurden nach Flutter 3.32 als veraltet markiert, RadioGroup kam in 3.35. Eine schrittweise Migration für Radio, RadioListTile und CupertinoRadio, warum dart fix sie nicht übernehmen kann, und die Falle bei der generischen Typinferenz, die ein migriertes Radio stillschweigend deaktiviert. Geprüft mit Flutter 3.44.2 stable."
pubDate: 2026-08-11
updatedDate: 2026-08-11
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material"
  - "accessibility"
lang: "de"
translationOf: "2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup"
translatedBy: "claude"
translationDate: 2026-08-11
---

Wenn `flutter analyze` meldet, dass `groupValue` und `onChanged` bei `Radio`, `RadioListTile` oder `CupertinoRadio` veraltet sind, besteht die Lösung darin, beide Eigenschaften aus den einzelnen Radios herauszuziehen und in einen einzigen `RadioGroup<T>`-Vorfahren zu verschieben, der sie umschließt. Rechnen Sie mit etwa zehn Minuten pro Bildschirm: die Arbeit ist mechanisch, aber `dart fix` kann sie nicht für Sie erledigen (ich habe es geprüft, siehe unten), und es gibt eine Falle, die überhaupt keinen Fehler erzeugt, sondern nur ein Radio, das stillschweigend nicht mehr auf Tippen reagiert. Die Markierung als veraltet erfolgte nach `v3.32.0-0.0.pre`, `RadioGroup` erschien in Flutter 3.35, und die alten Eigenschaften sind in stable 3.44 weiterhin vorhanden. Alles hier ist gegen Flutter 3.44.2 stable mit Dart 3.12 geprüft.

## Warum Flutter den Gruppenzustand aus dem Radio herausgezogen hat

Die alte API kannte keinen Gruppenbegriff. Jedes `Radio` verglich unabhängig seinen eigenen `value` mit einem `groupValue`, den Sie jedem einzeln übergaben. Das Framework selbst wusste also nie, welche Radios zusammengehören. Zum Zeichnen eines Punktes reicht das, für Barrierefreiheit ist es nutzlos.

Das [WAI-ARIA-Muster für Radiogruppen](https://www.w3.org/WAI/ARIA/apg/patterns/radio) verlangt, dass sich eine Gruppe wie eine einzige Station in der Tab-Reihenfolge verhält und die Pfeiltasten die Auswahl innerhalb der Gruppe verschieben. Das lässt sich ohne ein Widget, dem die Menge gehört, nicht umsetzen. `RadioGroup` ist dieses Widget, und deshalb gab es eine Neugestaltung statt einer kosmetischen API-Bereinigung.

Das Verhalten, das Sie nach der Migration geschenkt bekommen, bestätigt in einem Widget-Test mit 3.44.2:

- **Tab und Shift+Tab** bewegen den Fokus in die gesamte Gruppe hinein und wieder heraus, nicht durch jedes Radio einzeln.
- **Pfeiltasten** verschieben die Auswahl zwischen den Radios in Leserichtung und springen an den Enden um. Von `Flavor.vanilla` aus führte zweimal Pfeil-nach-unten von `vanilla` zu `chocolate` und zurück zu `vanilla`.
- **Leertaste** schaltet das fokussierte Radio um.

Es gibt noch einen kleineren Gewinn: die Radios selbst werden kürzer. Ein `Radio<int>` in einem migrierten Baum ist `Radio<int>(value: 0)` und sonst nichts.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| `Radio.groupValue` / `Radio.onChanged` | Veraltet; in einen `RadioGroup<T>`-Vorfahren verschieben | hoch |
| `RadioListTile.groupValue` / `.onChanged` | Gleiche Markierung, gleiche Lösung | hoch |
| `CupertinoRadio.groupValue` / `.onChanged` | Gleiche Markierung, gleiche Lösung | hoch |
| Ein einzelnes Radio deaktivieren | `onChanged: null` ersetzt durch `enabled: false` | mittel |
| Generische Typinferenz | `RadioGroup<T>` wird über den exakten Typ gefunden, und `T` wird anders inferiert als beim Radio | hoch |
| Tab-Reihenfolge | Die Gruppe ist jetzt eine Station statt N | mittel |
| `RadioListTile.selected` | Koordiniert sich weiterhin nicht automatisch mit dem angehakten Zustand | niedrig |
| Automatisierte Migration | Es existiert keine `dart fix`-Regel; das ist Handarbeit | mittel |

## Checkliste vor dem Start

- Flutter 3.35 oder neuer. `RadioGroup` kam in `3.34.0-0.0.pre` und erreichte stable in 3.35, in älteren Versionen existiert die Klasse also nicht. Prüfen Sie das mit `flutter --version`.
- Finden Sie jede Aufrufstelle: `flutter analyze` meldet jede einzelne als `deprecated_member_use`. Bei einer Beispieldatei kam `'groupValue' is deprecated and shouldn't be used. Use a RadioGroup ancestor to manage group value instead. This feature was deprecated after v3.32.0-0.0.pre.`
- Erwarten Sie keine Hilfe von `dart fix`. Ich habe `dart fix --dry-run` auf ein Projekt voller veralteter `Radio`-Verwendungen unter 3.44.2 angewendet und `Nothing to fix!` erhalten. Im Verzeichnis `lib/fix_data/fix_material` des Frameworks gibt es keine `fix_radio*.yaml`, was folgerichtig ist: Widgets in einen neuen Vorfahren einzupacken ist eine strukturelle Änderung, keine Parameterumbenennung.
- Prüfen Sie Ihre Abhängigkeiten. Einige pub.dev-Pakete verwenden intern noch die alte API ([flutter/flutter#170915](https://github.com/flutter/flutter/issues/170915) verfolgt das für die offiziellen Pakete). Ein Widget, das Ihnen nicht gehört, können Sie nicht migrieren, und Sie müssen es auch nicht: die veralteten Eigenschaften funktionieren weiterhin.

## Migrationsschritte

1. **Die Gruppe in `RadioGroup<T>` einpacken und `groupValue` und `onChanged` dorthin verschieben.** Das ist die gesamte Migration in einer Änderung. Die Zustandsvariable und der `setState`-Aufruf wandern nicht mit, nur die Eigenschaften.

   Vorher, unter Flutter 3.44:

   ```dart
   // Flutter 3.44, Dart 3.12 - deprecated API
   Widget build(BuildContext context) {
     return Column(
       children: <Widget>[
         Radio<Flavor>(
           value: Flavor.vanilla,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
         Radio<Flavor>(
           value: Flavor.chocolate,
           groupValue: _flavor,
           onChanged: (Flavor? v) => setState(() => _flavor = v),
         ),
       ],
     );
   }
   ```

   Nachher:

   ```dart
   // Flutter 3.44, Dart 3.12 - RadioGroup API
   Widget build(BuildContext context) {
     return RadioGroup<Flavor>(
       groupValue: _flavor,
       onChanged: (Flavor? v) => setState(() => _flavor = v),
       child: const Column(
         children: <Widget>[
           Radio<Flavor>(value: Flavor.vanilla),
           Radio<Flavor>(value: Flavor.chocolate),
         ],
       ),
     );
   }
   ```

   Prüfung: `flutter analyze` fällt für diese Datei von vier `deprecated_member_use`-Hinweisen auf null, und ein Tippen auf das zweite Radio aktualisiert weiterhin den Zustand.

2. **Schreiben Sie das Typargument immer explizit, sowohl bei der Gruppe als auch bei den Radios.** Die Typinferenz liefert nicht das Erwartete, wenn der Werttyp nullbar ist. Schreiben Sie `RadioGroup<Flavor?>` und `Radio<Flavor?>`, niemals ein nacktes `RadioGroup(...)`. Der nächste Abschnitt erklärt, warum das wichtiger ist, als es aussieht.

   Prüfung: Suchen Sie im Diff nach `RadioGroup(` ohne `<`. Jeder Treffer ist ein latenter Fehler.

3. **Ersetzen Sie `onChanged: null` durch `enabled: false` bei jedem Radio, das Sie deaktiviert hatten.** In der alten API war ein Null-Callback der Weg, eine Option auszugrauen. `RadioGroup.onChanged` ist `required` und nicht nullbar, dieser Hebel ist auf Gruppenebene also verschwunden und zu jedem Radio gewandert.

   ```dart
   // Flutter 3.44 - one disabled option inside an otherwise live group
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: const Column(
       children: <Widget>[
         Radio<int>(value: 0),
         Radio<int>(value: 2, enabled: false),
       ],
     ),
   )
   ```

   Prüfung: Das deaktivierte Radio wird grau gezeichnet, und sein Semantik-Knoten trägt `hasEnabledState` ohne `isEnabled`.

4. **Nehmen Sie dieselbe Änderung für `RadioListTile` und `CupertinoRadio` vor.** Beide akzeptieren denselben `RadioGroup`-Vorfahren. `RadioListTile` behält zusätzlich seine eigene `enabled`-Eigenschaft, aufgelöst als `widget.enabled ?? (widget.onChanged != null || registry != null)`.

   ```dart
   // Flutter 3.44 - RadioListTile inside a lazy list
   RadioGroup<int>(
     groupValue: _value,
     onChanged: (int? v) => setState(() => _value = v),
     child: ListView.builder(
       itemCount: options.length,
       itemBuilder: (BuildContext context, int i) =>
           RadioListTile<int>(value: i, title: Text(options[i])),
     ),
   )
   ```

   Prüfung: Das funktioniert auch mit verzögertem Aufbau. In einem `ListView.builder` mit 200 Einträgen, von denen nur 11 tatsächlich aufgebaut waren, setzte ein Tippen auf Eintrag 3 den Gruppenwert auf 3.

5. **Gemischte Gruppen nach Typ trennen oder verschachteln.** Enthält eine Spalte Radios mit zwei verschiedenen Werttypen, packen Sie die innere Menge in eine eigene `RadioGroup`. Verschachtelung funktioniert, weil die Suche über den Typ läuft und bei identischen Typen der nächstgelegene Vorfahre gewinnt. Ich habe bestätigt, dass eine `RadioGroup<String>`, verschachtelt in einer weiteren `RadioGroup<String>`, Tipp-Ereignisse ausschließlich an das `onChanged` der inneren Gruppe weiterleitet.

   Prüfung: Tippen Sie je ein Radio aus jeder Untergruppe an und bestätigen Sie, dass jeder Callback genau einmal auslöst.

6. **Analyzer und Widget-Tests ausführen.** `flutter analyze` darf keinen `deprecated_member_use`-Treffer für Radio-Mitglieder mehr melden, und jeder Test, der ein Radio antippt, muss weiterhin bestehen. In den Tests wird der unten beschriebene stille Fehler gefangen.

## Verifikation

Führen Sie nach der Migration diese vier Prüfungen aus, bevor Sie einen Bildschirm als fertig betrachten:

- `flutter analyze` meldet keinen radiobezogenen `deprecated_member_use`-Hinweis.
- Jedes Radio reagiert sichtbar auf ein Tippen. Ein migriertes Radio, das grau erscheint, ist der unten beschriebene Fehlerfall und kein Styling-Problem.
- Tastatur: In die Gruppe tabben, Pfeil-nach-unten drücken, bestätigen, dass sich die Auswahl bewegt. Das ist die Funktion, für die Sie migriert haben, sie einmal pro Bildschirm auszuprobieren lohnt sich.
- Screenreader oder `debugDumpSemanticsTree`: Der Semantik-Knoten eines funktionierenden Radios trägt `isEnabled` und eine `tap`-Aktion. Ein totes trägt `hasEnabledState`, aber nicht `isEnabled`.

## Rollback-Plan

Diese Migration ist tatsächlich umkehrbar. Die veralteten Eigenschaften existieren in stable 3.44 weiterhin und sind für keine angekündigte Version zur Entfernung vorgesehen, ein `git revert` des Migrations-Commits kompiliert und läuft also genau wie vorher. Arbeiten Sie trotzdem in einem Branch, denn der Fehlerfall hier ist still, und Sie wollen ein sauberes Diff zum Bisecten haben.

## Die Falle: ein migriertes Radio, das still den Dienst einstellt

Das ist der Teil, den der offizielle Migrationsleitfaden nicht abdeckt, und er steckt hinter [flutter/flutter#175705](https://github.com/flutter/flutter/issues/175705), einem Issue, das ohne Diagnose geschlossen wurde.

Zwei Umstände kommen ungünstig zusammen.

Erstens wirft ein `Radio` ohne `RadioGroup`-Vorfahren und ohne `onChanged` keine Ausnahme. So löst `_RadioState` das auf:

```dart
// packages/flutter/lib/src/material/radio.dart, Flutter 3.44 stable
bool get _enabled =>
    widget.enabled ??
    (widget.onChanged != null ||
        widget.groupRegistry != null ||
        RadioGroup.maybeOf<T>(context) != null);
```

Sind alle drei null, ist `_enabled` gleich `false`, und das Radio wird als deaktiviertes Steuerelement gezeichnet. Die Zusicherung `'Radio is enabled but has no Radio.onChange or registry above'` greift nur, wenn Sie explizit `enabled: true` übergeben. Ich habe zwei `Radio<Flavor>`-Widgets ganz ohne Gruppe gerendert: keine Ausnahme, und der Semantik-Knoten kam als `flags: [hasCheckedState, hasEnabledState, isInMutuallyExclusiveGroup]` zurück. Beachten Sie, was fehlt: `isEnabled` und jede Tipp-Aktion.

Zweitens wird `RadioGroup` über den exakten generischen Typ gefunden:

```dart
// packages/flutter/lib/src/widgets/radio_group.dart, Flutter 3.44 stable
static RadioGroupRegistry<T>? maybeOf<T>(BuildContext context) {
  return context.dependOnInheritedWidgetOfExactType<_RadioGroupStateScope<T>>()?.state;
}
```

`dependOnInheritedWidgetOfExactType` bedeutet, dass `_RadioGroupStateScope<Flavor>` eine Suche nach `_RadioGroupStateScope<Flavor?>` nicht erfüllt. Kovarianz hilft hier nicht.

Kombinieren Sie das nun mit der Inferenz von Dart. `RadioGroup` deklariert `T? groupValue`, während `Radio` und `RadioListTile` `T value` deklarieren. Übergeben Sie beiden eine nullbare Variable, inferieren sie unterschiedliche Typargumente:

```dart
// Flutter 3.44, Dart 3.12
String? selected;
final group = RadioGroup(groupValue: selected, onChanged: (v) {}, child: const SizedBox());
final tile = RadioListTile(value: selected, title: const Text('x'));
// group.runtimeType -> RadioGroup<String>
// tile.runtimeType  -> RadioListTile<String?>
```

Das sind die Laufzeittypen aus einem echten Testlauf. Die Gruppe ist `RadioGroup<String>`, die Kachel ist `RadioListTile<String?>`. Die Kachel sucht `_RadioGroupStateScope<String?>`, findet nichts, löst `_enabled` zu `false` auf und wird tot gezeichnet. Keine Ausnahme, keine Analyzer-Warnung.

Die Reproduktion hat genau die Form, auf die Entwickler stoßen, wenn sie eine Option "System default" migrieren, bei der `null` eine legitime Wahl ist. In einer Gruppe, in der eine Kachel `Flavor?` und ihr Geschwister `Flavor` bekam, sah die Semantik so aus:

```text
System  -> flags: [hasEnabledState, hasSelectedState]
Vanilla -> actions: [focus, tap], flags: [hasEnabledState, isEnabled, isFocusable, hasSelectedState]
```

Ein Tippen auf "System" löste das `onChanged` der Gruppe null Mal aus. Ein Tippen auf "Vanilla" löste es einmal aus.

Die Lösung besteht darin, das Typargument auf beiden Seiten festzunageln:

```dart
// Flutter 3.44 - explicit nullable type argument on group and tiles
RadioGroup<Flavor?>(
  groupValue: _flavor,
  onChanged: (Flavor? v) => setState(() => _flavor = v),
  child: const Column(
    children: <Widget>[
      RadioListTile<Flavor?>(value: null, title: Text('System')),
      RadioListTile<Flavor?>(value: Flavor.vanilla, title: Text('Vanilla')),
    ],
  ),
)
```

Mit ausgeschriebenem `RadioGroup<Flavor?>` setzt ein Tippen auf "System" den Gruppenwert korrekt auf `null`. Das ist die Antwort auf das geschlossene Issue: nullbare Werte sind nicht absichtlich deaktiviert, die inferierten Typargumente passten schlicht nicht zusammen.

## Kleinere Fallstricke, die man kennen sollte

**`toggleable` ist beim Radio geblieben.** Es ist keine Eigenschaft auf Gruppenebene. Ein `Radio<Flavor>(value: Flavor.vanilla, toggleable: true)` innerhalb einer `RadioGroup<Flavor>` ruft das `onChanged` der Gruppe weiterhin mit `null` auf, wenn Sie die bereits ausgewählte Option antippen. Geprüft unter 3.44.2. Ihr `groupValue` muss also nullbar sein, wenn Sie das nutzen, was Sie direkt in die obige Inferenzfalle zurückführt.

**Es gibt kein Deaktivieren auf Gruppenebene.** `RadioGroup.onChanged` ist erforderlich und nicht nullbar, Sie können eine ganze Gruppe also nicht mehr wie früher durch einen genullten Callback ausgrauen. Setzen Sie `enabled: false` an jedem Radio, oder iterieren Sie über Ihre Optionen und übergeben Sie ein Flag.

**`RadioListTile.selected` bleibt manuell.** Das Framework dokumentiert, dass "no effort is made to automatically coordinate the selected state and the checked state", und weist an, `selected: true` zu setzen, wenn `value` zu `RadioGroup.groupValue` passt. Die Migration ändert daran nichts; Sie vergleichen weiterhin von Hand.

**Tastaturnavigation erreicht nur aufgebaute Radios.** In einem `ListView.builder` können sich die Pfeiltasten nur durch die Kacheln bewegen, die gerade im Widget-Baum stehen. In meiner Probe mit 200 Einträgen waren 11 aufgebaut. Für eine lange Optionsliste ist das eine echte Einschränkung der Barrierefreiheit und ein guter Grund, für Radiogruppen eine begrenzte `Column` in einem Scroll-View dem verzögerten Aufbau vorzuziehen. Wenn Sie die verzögerte Liste dennoch brauchen, gelten die [Muster für unendlich scrollende Listen](/de/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/) unverändert.

**`Radio.adaptive` ist unproblematisch.** Es reicht `groupRegistry: _effectiveRegistry` und `enabled: _enabled` an `CupertinoRadio` weiter, ein adaptives Radio in einer `RadioGroup` greift die Registry unter iOS und macOS also ohne Zusatzaufwand ab.

**Für eigene radioartige Widgets implementieren Sie die Registry.** `RadioGroupRegistry<T>` ist eine kleine öffentliche Schnittstelle (`groupValue`, `onChanged`, `registerClient`, `unregisterClient`), und `RawRadio` nimmt eine `groupRegistry` direkt entgegen. Das ist der unterstützte Weg, wenn Sie ein eigens gestaltetes Steuerelement bauen, das an der Tastaturnavigation der Gruppe teilnehmen soll. `RawRadio` sichert `'an enabled raw radio must have a registry'` zu, verdrahten Sie es also, bevor Sie es aktivieren.

Die Migration ist nicht dringend, da die veralteten Eigenschaften unter 3.44 weiterhin kompilieren. Sie lohnt sich trotzdem, weil sich das Verhalten für Barrierefreiheit nicht nachträglich selbst nachrüsten lässt und weil jeder Bildschirm, den Sie auf der alten API belassen, ein Bildschirm ist, den Sie später unter Zeitdruck migrieren. Machen Sie es jetzt, schreiben Sie die Typargumente aus, und lassen Sie den Analyzer Ihnen sagen, wann Sie fertig sind.

## Verwandte Beiträge

- [Fehler beheben: No Material widget found in Flutter](/de/2026/08/fix-no-material-widget-found-in-flutter/)
- [So sichern Sie setState mit der mounted-Prüfung nach einer asynchronen Lücke in Flutter ab](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/)
- [Von Riverpod 2.x auf Riverpod 3.0 in Flutter migrieren](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Controller in Flutter freigeben, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Eine paginierte Liste mit unendlichem Scrollen in Flutter mit ScrollController bauen](/de/2026/08/how-to-build-an-infinite-scrolling-paginated-list-in-flutter-with-scrollcontroller/)

## Quellen

- [Redesigned the Radio widget, Breaking Changes von Flutter](https://docs.flutter.dev/release/breaking-changes/radio-api-redesign)
- [Klasse RadioGroup, Flutter API-Dokumentation](https://api.flutter.dev/flutter/widgets/RadioGroup-class.html)
- [Klasse Radio, Flutter API-Dokumentation](https://api.flutter.dev/flutter/material/Radio-class.html)
- [Klasse RadioListTile, Flutter API-Dokumentation](https://api.flutter.dev/flutter/material/RadioListTile-class.html)
- [Issue 113562: Semantik der Radiogruppe](https://github.com/flutter/flutter/issues/113562)
- [PR 168161: Einführung von RadioGroup](https://github.com/flutter/flutter/pull/168161)
- [Issue 175705: RadioGroup mit null-Wert](https://github.com/flutter/flutter/issues/175705)
- [WAI-ARIA Authoring Practices: Muster für Radiogruppen](https://www.w3.org/WAI/ARIA/apg/patterns/radio)

---
title: "Lösung: ScaffoldMessenger.of() wurde mit einem Kontext aufgerufen, der kein Scaffold enthält (Flutter)"
description: "Dieser Fehler bedeutet, dass der übergebene BuildContext oberhalb des Scaffold oder ScaffoldMessenger liegt, nicht darunter. Umschließen Sie den Aufruf mit einem Builder, lagern Sie ihn in ein eigenes Widget aus oder verwenden Sie einen GlobalKey."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "snackbar"
lang: "de"
translationOf: "2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-18
---

`ScaffoldMessenger.of() was called with a context that does not contain a Scaffold` (und sein älterer Zwilling `Scaffold.of() called with a context that does not contain a Scaffold`) bedeutet, dass der `BuildContext`, den Sie an `.of()` übergeben haben, *oberhalb* des `Scaffold` oder `ScaffoldMessenger` liegt, den er zu finden versucht, nicht darunter. Fast immer passiert das, wenn Sie ihn aus derselben `build`-Methode aufrufen, die das `Scaffold` zurückgibt. Beheben Sie es, indem Sie den Aufruf mit einem `Builder` umschließen, ihn in ein eigenes Widget auslagern oder den Messenger über einen `GlobalKey` erreichen. Getestet mit Flutter 3.x (3.44), Dart 3.x.

## Der Fehler im Kontext

Es gibt zwei eng verwandte Meldungen, und welche Sie erhalten, hängt davon ab, welche API Sie aufgerufen haben. Die klassische, aus der `Scaffold.of()`-API vor Version 2.0, die viele alte Stack-Overflow-Antworten noch verwenden:

```
Scaffold.of() called with a context that does not contain a Scaffold.
No Scaffold ancestor could be found starting from the context that was passed
to Scaffold.of(). This usually happens when the context provided is from the
same StatefulWidget as that whose build function actually creates the Scaffold
widget being sought.
```

Die moderne, aus `ScaffoldMessenger.of()`, der API, die Sie zum Anzeigen einer `SnackBar` verwenden sollten:

```
No ScaffoldMessenger widget found.
Scaffold widgets require a ScaffoldMessenger widget ancestor.
Typically, the ScaffoldMessenger widget is introduced by the MaterialApp at
the top of your application widget tree.
```

Beide sind derselbe Bug in anderer Kleidung: eine Vorfahrensuche, die zu weit oben im Baum beginnt und in die falsche Richtung läuft. Zu verstehen, *warum* die Suche fehlschlägt, ist der Unterschied zwischen dem Einfügen eines `Builder` auf gut Glück und dem genauen Wissen, welche Lösung Ihre Situation braucht.

## Warum die Suche an der falschen Stelle beginnt

`ScaffoldMessenger.of(context)` und `Scaffold.of(context)` führen beide einen Vorfahrenlauf durch. Intern rufen sie `context.dependOnInheritedWidgetOfExactType` auf (über einen geerbten `_ScaffoldMessengerScope`), der beim Element von `context` beginnt und *nach oben* zur Wurzel klettert, auf der Suche nach dem nächstgelegenen passenden Vorfahren. Er schaut niemals nach unten.

Stellen Sie sich nun das Widget vor, das fehlschlägt. Sie haben eine `build`-Methode geschrieben, die ein `Scaffold` zurückgibt, und irgendwo in dieser Methode rufen Sie `Scaffold.of(context)` oder `ScaffoldMessenger.of(context)` mit dem `context`-Parameter derselben `build`-Methode auf. Dieser `context` gehört zum Element *Ihres* Widgets. Ihr Widget ist der **Elternteil** des `Scaffold`, das es zurückgibt. Wenn die Suche also von Ihrem Element aufsteigt, liegt das gerade erstellte `Scaffold` unterhalb des Startpunkts, und der Lauf erreicht es nie. Er zieht an Ihrem Widget vorbei und steigt in das auf, was auch immer über Ihnen liegt, findet nichts Passendes und löst die Assertion aus.

Genau dieses Szenario benennt die klassische Meldung: "the context provided is from the same StatefulWidget as that whose build function actually creates the Scaffold widget being sought".

Es gibt eine Feinheit, die man kennen sollte, denn sie erklärt, warum Sie den Fehler sehen oder nicht sehen. `MaterialApp` fügt für Sie einen `ScaffoldMessenger` nahe der Spitze Ihres Baums ein. Das bedeutet, dass `ScaffoldMessenger.of(context)` normalerweise erfolgreich ist, *sogar aus einem Kontext, der überhaupt kein Scaffold über sich hat*, weil er den Messenger auf App-Ebene findet. Die Variante "No ScaffoldMessenger widget found" wird also nur ausgelöst, wenn es tatsächlich keinen Messenger-Vorfahren gibt: Sie befinden sich oberhalb von `MaterialApp`, haben die App mit einem nackten `WidgetsApp` ohne Messenger gebaut oder einen benutzerdefinierten `ScaffoldMessenger`-Bereich erstellt und rufen von außerhalb auf. Der weitaus häufigere Fehler in echtem Code ist der von `Scaffold.of()`, oder eine `SnackBar`, die am falschen Ort erscheint, weil Sie den falschen Messenger aufgelöst haben.

## Die minimale Reproduktion

Der kleinste zuverlässige Auslöser ist ein Button, der direkt in der `build`-Methode platziert wird, die das `Scaffold` zurückgibt, und `.of()` mit dem `context` dieser Methode aufruft:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: ElevatedButton(
          onPressed: () {
            // context here is HomePage's context, which is ABOVE the Scaffold.
            Scaffold.of(context).showSnackBar(   // throws
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        ),
      ),
    );
  }
}
```

Tauschen Sie `Scaffold.of` gegen `ScaffoldMessenger.of` und, da `MaterialApp` einen Messenger bereitstellt, verschwindet der Absturz, aber die `SnackBar` wird nun vom Wurzel-Messenger statt vom `Scaffold` dieses Bildschirms verwaltet. Das ist für die meisten Apps in Ordnung und genau der Grund, warum die Migration zu `ScaffoldMessenger` durchgeführt wurde. Wenn Sie jedoch verschachtelte `ScaffoldMessenger`-Bereiche haben, können Sie immer noch den falschen aus dem falschen Kontext auflösen.

## Lösung 1: Verwenden Sie ScaffoldMessenger.of, nicht Scaffold.of

Wenn Ihr Fehler die `Scaffold.of()`-Variante ist und Sie nur versuchen, eine `SnackBar` anzuzeigen, auszublenden oder zu entfernen, ist die erste und beste Lösung, `Scaffold.of()` einfach nicht mehr zu verwenden. `Scaffold.of().showSnackBar()` wurde in Flutter 2.0 als veraltet markiert und entfernt; die aktuelle API liegt bei `ScaffoldMessenger`:

```dart
// Flutter 3.x (tested 3.44)
// Before (deprecated, throws from the same build context):
Scaffold.of(context).showSnackBar(mySnackBar);
Scaffold.of(context).hideCurrentSnackBar();
Scaffold.of(context).removeCurrentSnackBar();

// After (current API):
ScaffoldMessenger.of(context).showSnackBar(mySnackBar);
ScaffoldMessenger.of(context).hideCurrentSnackBar();
ScaffoldMessenger.of(context).removeCurrentSnackBar();
```

Da der Messenger oberhalb des `Scaffold` Ihres Bildschirms lebt (normalerweise auf `MaterialApp`-Ebene), gelingt die Aufwärtssuche aus dem Kontext Ihrer `build`-Methode. Als Bonus bleiben `SnackBar`s nun über Routenübergänge hinweg erhalten und animieren, statt beim Navigieren zu verschwinden, was der ganze Sinn der `ScaffoldMessenger`-Neugestaltung war. `showSnackBar` gibt außerdem einen `ScaffoldFeatureController` zurück, mit dem Sie auf den Schließgrund warten können:

```dart
// Flutter 3.x (tested 3.44)
final controller = ScaffoldMessenger.of(context).showSnackBar(
  SnackBar(
    content: const Text('Item deleted'),
    action: SnackBarAction(label: 'Undo', onPressed: _undo),
  ),
);
final reason = await controller.closed; // SnackBarClosedReason.action, .timeout, ...
```

## Lösung 2: Holen Sie sich mit einem Builder einen Kontext unterhalb des Scaffold

Manchmal brauchen Sie wirklich einen Kontext, der ein Nachfahre des `Scaffold` ist: Sie rufen `Scaffold.of(context)` für etwas anderes als eine `SnackBar` auf (den Drawer mit `Scaffold.of(context).openDrawer()` öffnen, `Scaffold.of(context).hasAppBar` lesen) oder haben einen lokalen `ScaffoldMessenger` eingerichtet und müssen *diesen* auflösen. Die günstigste Lösung ist ein `Builder`, der einen frischen Kontext einführt, dessen Position im Baum unterhalb des `Scaffold` liegt:

```dart
// Flutter 3.x (tested 3.44)
@override
Widget build(BuildContext context) {
  return Scaffold(
    body: Builder(
      builder: (innerContext) {          // innerContext is BELOW the Scaffold
        return ElevatedButton(
          onPressed: () {
            ScaffoldMessenger.of(innerContext).showSnackBar(
              const SnackBar(content: Text('Saved')),
            );
          },
          child: const Text('Save'),
        );
      },
    ),
  );
}
```

Der `Builder` tut nichts anderes, als seine `builder`-Funktion aufzurufen, aber der `innerContext`, den er übergibt, gehört zu einem Element, das ein Kind des `Scaffold` ist. Nun trifft der Aufwärtslauf das `Scaffold` (und den Messenger-Bereich) sofort. Verwenden Sie den inneren Kontext, nicht den äußeren -- das ist der ganze Trick.

## Lösung 3: Lagern Sie den Aufrufer in ein eigenes Widget aus

`Builder` ist eine Abkürzung für eine strukturelle Lösung: Trennen Sie den Button in ein eigenes `StatelessWidget` oder `StatefulWidget` heraus. Seine `build`-Methode erhält einen Kontext, der natürlich unterhalb des `Scaffold` liegt, sodass `.of()` korrekt auflöst und Sie nie wieder darüber nachdenken müssen:

```dart
// Flutter 3.x (tested 3.44)
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: const Center(child: SaveButton()),
    );
  }
}

class SaveButton extends StatelessWidget {
  const SaveButton({super.key});

  @override
  Widget build(BuildContext context) {
    // This context is a descendant of the Scaffold above.
    return ElevatedButton(
      onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      ),
      child: const Text('Save'),
    );
  }
}
```

Dies ist die zu bevorzugende Option für alles jenseits eines Wegwerf-Callbacks. Es ist lesbarer als ein verschachtelter `Builder`, hält Ihr Bildschirm-Widget schlank und macht den Button unabhängig testbar.

## Lösung 4: Verwenden Sie einen GlobalKey, wenn kein brauchbarer Kontext vorhanden ist

Die kontextbasierten Lösungen setzen voraus, dass Sie sich im Moment des Anzeigens der Nachricht im Widget-Baum befinden. Wenn das nicht der Fall ist (eine `SnackBar`, die aus einem `bloc`, einem Repository, einem Hintergrund-Callback oder einem Fehlerhandler ohne `BuildContext` ausgelöst wird), erreichen Sie den Messenger über einen `GlobalKey<ScaffoldMessengerState>`, der in `MaterialApp` eingebunden ist:

```dart
// Flutter 3.x (tested 3.44)
final rootScaffoldMessengerKey = GlobalKey<ScaffoldMessengerState>();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      scaffoldMessengerKey: rootScaffoldMessengerKey,
      home: const HomePage(),
    );
  }
}

// Anywhere, with no BuildContext at all:
void notifySaved() {
  rootScaffoldMessengerKey.currentState?.showSnackBar(
    const SnackBar(content: Text('Saved')),
  );
}
```

`currentState` ist null, bis die App gemountet wurde, also sichern Sie es mit `?.` ab. Dies ist das offiziell empfohlene Muster, um eine `SnackBar` von außerhalb eines Widgets anzuzeigen, und es umgeht die Frage "welcher Kontext?" vollständig, weil kein Kontext beteiligt ist.

## Fallstricke und Verwechslungen

**`maybeOf` gibt null zurück, statt zu werfen.** Wenn Sie *versuchen* möchten, eine Nachricht anzuzeigen, und stillschweigend nichts tun wollen, wenn kein Messenger vorhanden ist (selten, aber nützlich in geteiltem Code, der außerhalb eines Material-Baums laufen kann), verwenden Sie `ScaffoldMessenger.maybeOf(context)?.showSnackBar(...)`. Es führt dieselbe Suche durch, gibt aber `null` zurück, statt die Assertion auszulösen. Greifen Sie nicht darauf zurück, um einen echten strukturellen Bug zu überdecken: Wenn Sie erwarten, dass ein Messenger dort ist, tut Ihnen die Assertion einen Gefallen.

**`.of()` in `initState` aufrufen.** Eine häufige Variante ist der Versuch, eine `SnackBar` in `initState` anzuzeigen. Der Kontext existiert, aber der Frame wurde noch nicht angeordnet, und Sie befinden sich noch in build/mount. Verschieben Sie es: `WidgetsBinding.instance.addPostFrameCallback((_) => ScaffoldMessenger.of(context).showSnackBar(...))`. Besser noch: Verwenden Sie den `GlobalKey` aus Lösung 4, damit Sie nicht vom Timing des `context` abhängen.

**Den Kontext nach einem `await` verwenden.** `ScaffoldMessenger.of(context)` nach einer asynchronen Lücke zu holen, kann werfen oder einen veralteten Messenger auflösen, falls das Widget während des Wartens disposed wurde. Erfassen Sie den Messenger *vor* dem await oder sichern Sie mit `mounted` ab. Das ist dieselbe Disziplin wie [BuildContext nach einem await sicher zu verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) und [setState mit der mounted-Prüfung abzusichern](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/).

**Die `SnackBar` erscheint auf dem falschen Bildschirm.** Kein Absturz, aber die Nachricht erscheint auf einer anderen Route als erwartet. Das ist ein *welcher Messenger*-Problem, kein *kein Messenger*-Problem: Sie haben den Wurzel-Messenger der `MaterialApp` aufgelöst, obwohl Sie einen verschachtelten `ScaffoldMessenger` wollten, mit dem Sie einen Teilbaum umschlossen haben. Lösen Sie aus einem Kontext innerhalb dieses verschachtelten Bereichs auf (Lösung 2 oder Lösung 3) oder halten Sie einen Key auf den konkreten Messenger.

**`showModalBottomSheet` und `openDrawer` stoßen an dieselbe Wand.** Jeder `Scaffold.of(context)`-Aufruf aus dem eigenen `build`-Kontext des Bildschirms schlägt identisch fehl, nicht nur `showSnackBar`. `Scaffold.of(context).openDrawer()` und `showModalBottomSheet(context: context, ...)` brauchen beide einen Kontext unterhalb des `Scaffold`. Die Lösungen mit `Builder` und Widget-Auslagerung gelten unverändert.

**Es ist eine Assertion, daher verhalten sich Release-Builds anders.** Der `of()`-Fehler löst in Debug die Assertion aus und wirft in Release eine Exception. Nehmen Sie nicht an, dass ein Release-Build, der "im Test nicht abgestürzt ist", sicher ist: Wenn der Messenger wirklich fehlt, wirft auch Release. Beheben Sie es in Debug.

Wenn Ihr tatsächlicher Fehler ein anderes Material-Widget ist, das sich beschwert, dass es keinen Vorfahren findet (`No MaterialLocalizations found`, `No Directionality widget found`, `No MediaQuery widget ancestor found`), ist der Mechanismus dieselbe verfehlte Aufwärtssuche, und die Lösung hat dieselbe Form: Geben Sie dem Aufrufer einen Kontext, der unterhalb des benötigten Widgets liegt, oder fügen Sie den fehlenden Vorfahren hinzu. Flutters Fehler [das Nachschlagen des Vorfahren eines deaktivierten Widgets ist unsicher](/de/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) ist der zeitbasierte Cousin dieses strukturellen Fehlers.

## Verwandt

- [Wie man BuildContext nach einem await in Flutter sicher verwendet](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) -- den Messenger vor einer asynchronen Lücke erfassen, damit er noch gültig ist, wenn die `SnackBar` ausgelöst wird.
- [Wie man setState mit der mounted-Prüfung nach einer asynchronen Lücke in Flutter absichert](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) -- dieselbe Lebenszyklus-Disziplin, die `.of()`-Aufrufe nach einem await sicher hält.
- [Lösung: Das Nachschlagen des Vorfahren eines deaktivierten Widgets ist unsicher in Flutter](/de/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/) -- der zeitbasierte Vorfahrensuchfehler, im Gegensatz zu diesem strukturellen.
- [Lösung: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/de/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) -- ein weiterer "falsche Stelle im Widget-Baum"-Fehler, den das Framework zur Build-Zeit abfängt.

## Quellen

- [SnackBars managed by the ScaffoldMessenger, Flutter Breaking Changes](https://docs.flutter.dev/release/breaking-changes/scaffold-messenger) -- die Migration von `Scaffold.of().showSnackBar` zu `ScaffoldMessenger.of().showSnackBar`, der `scaffoldMessengerKey` und die exakte "No ScaffoldMessenger widget found"-Assertion.
- [ScaffoldMessenger.of, Flutter API-Referenz](https://api.flutter.dev/flutter/material/ScaffoldMessenger/of.html) -- dokumentiert, dass `of()` in Debug die Assertion auslöst und in Release eine Exception wirft, wenn kein Messenger im Bereich ist, und verweist auf `maybeOf` und das `GlobalKey`-Muster.
- [ScaffoldMessenger.maybeOf, Flutter API-Referenz](https://api.flutter.dev/flutter/material/ScaffoldMessenger/maybeOf.html) -- die null zurückgebende Suche für den Fall, dass ein Messenger legitim fehlen kann.
- [Scaffold.of, Flutter API-Referenz](https://api.flutter.dev/flutter/material/Scaffold/of.html) -- die klassische "context that does not contain a Scaffold"-Meldung und das `Builder`-Heilmittel.

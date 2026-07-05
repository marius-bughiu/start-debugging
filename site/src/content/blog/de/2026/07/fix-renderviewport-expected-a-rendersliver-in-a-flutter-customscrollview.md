---
title: "Fix: A RenderViewport expected a child of type RenderSliver but received a child of type RenderBox (Flutter CustomScrollView)"
description: "Die slivers-Liste einer CustomScrollView akzeptiert nur Sliver. Verpacken Sie Box-Widgets in SliverToBoxAdapter oder ersetzen Sie ListView/Padding/Column durch SliverList und SliverPadding."
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "slivers"
  - "layout"
lang: "de"
translationOf: "2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview"
translatedBy: "claude"
translationDate: 2026-07-05
---

`A RenderViewport expected a child of type RenderSliver but received a child of type RenderParagraph` (oder `RenderFlex`, oder `RenderErrorBox`, oder ein beliebiges anderes `RenderBox`) bedeutet, dass Sie ein einfaches Widget direkt in die `slivers`-Liste einer `CustomScrollView` gesetzt haben. Alles in `slivers` muss ein Sliver sein. Die schnellste Lösung ist, das störende Box-Widget in einen `SliverToBoxAdapter` zu verpacken; die bessere Lösung für eine Liste ist, `ListView` durch `SliverList.builder` und `Padding` durch `SliverPadding` zu ersetzen. Getestet mit Flutter 3.x (3.44), Dart 3.x.

## Der Fehler im Kontext

Flutter wirft diesen Fehler zur Layout-Zeit, bevor überhaupt etwas gezeichnet wird. Der konkrete Typ nach "received a child of type" ändert sich je nachdem, was Sie in die Liste setzen -- `RenderParagraph` für ein `Text`, `RenderFlex` für ein `Column` oder `Row`, `RenderErrorBox`, wenn ein Builder in der Liste eine Exception geworfen hat -- aber die Form ist immer dieselbe:

```
FlutterError (A RenderViewport expected a child of type RenderSliver but received a
child of type RenderParagraph.
RenderObjects expect specific types of children because they coordinate with their
children during layout and paint. For example, a RenderSliver cannot be the child of
a RenderBox because a RenderSliver does not understand the RenderBox layout protocol.

The RenderViewport that expected a RenderSliver child was created by:
  Viewport ← IgnorePointer ← Semantics ← Listener ← _GestureSemantics ←
    Scrollable ← PrimaryScrollController ← CustomScrollView ← ...

The RenderParagraph that did not match the expected child type was created by:
  Text ← ...)
```

Die beiden "created by"-Blöcke sind der nützliche Teil. Der erste nennt das Scroll-Widget, das einen Sliver erwartet hat (fast immer Ihre `CustomScrollView`). Der zweite nennt das genaue Widget, das kein Sliver war. Lesen Sie den zweiten Block zuerst: er zeigt direkt auf die Zeile, die Sie ändern müssen.

## Warum ein Viewport ein Box-Kind ablehnt

Flutter hat zwei Layout-Protokolle, nicht eines. Gewöhnliche Widgets wie `Container`, `Text`, `Row` und `Column` werden als Boxen ausgelegt: das Elternobjekt gibt Breiten- und Höhen-Constraints nach unten, das Kind gibt eine konkrete `Size` zurück, fertig. Ihre Render-Objekte sind Unterklassen von `RenderBox` (`RenderParagraph`, `RenderFlex` und so weiter).

Sliver verwenden ein anderes, reichhaltigeres Protokoll, das für das Scrollen gebaut ist. Ein Sliver meldet nicht einfach eine Größe. Während des Layouts erhält es ein `SliverConstraints`, das beschreibt, wie viel davon aktuell aus dem sichtbaren Bereich gescrollt ist, wie viel Platz im Viewport übrig ist, den Scroll-Offset, die Achsenrichtung und mehr. Es gibt ein `SliverGeometry` zurück, das beschreibt, wie viel Platz es gezeichnet hat, wie viel es auf der Scroll-Achse verbraucht hat, seine Hit-Test-Ausdehnung und ob es sichtbar sein möchte. Genau dieses Hin und Her lässt eine `SliverAppBar` beim Scrollen schrumpfen und eine `SliverList` nur die aktuell sichtbaren Zeilen bauen. Ihre Render-Objekte sind Unterklassen von `RenderSliver`.

Ein `RenderViewport` -- das Render-Objekt hinter `CustomScrollView` -- spricht mit seinen Kindern nur das Sliver-Protokoll. Es übergibt jedem Kind `SliverConstraints` und erwartet `SliverGeometry` zurück. Wenn Sie ihm ein `RenderBox` geben, hat diese Box keine Ahnung, was sie mit `SliverConstraints` anfangen soll; sie implementiert die Methode nicht, die der Viewport gleich aufrufen wird. Statt tief im Layout mit einem verwirrenden Null-Wert abzustürzen, prüft das Framework den Typ des Kindes vorab und wirft diese Assertion. Die Meldung buchstabiert die Regel aus: "a RenderSliver cannot be the child of a RenderBox because a RenderSliver does not understand the RenderBox layout protocol", und dasselbe gilt umgekehrt, was genau die Diskrepanz ist, auf die Sie stoßen.

Das ist also kein subtiler Constraint-Fehler wie [RenderBox was not laid out](/de/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) oder ein [RenderFlex-Überlauf](/de/2026/05/fix-renderflex-overflowed-in-flutter/). Es ist eine Typdiskrepanz: ein Box-Widget steht dort, wo ein Sliver hingehört.

## Das minimale Repro

Jedes Nicht-Sliver-Widget in der `slivers`-Liste löst es aus. Hier ist die kleinste Variante -- ein nacktes `Text`, wo ein Sliver hingehören sollte:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Feed extends StatelessWidget {
  const Feed({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        const Text('Recent activity'), // RenderParagraph, not a sliver
        SliverList.builder(
          itemCount: 20,
          itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
        ),
      ],
    );
  }
}
```

Der `SliverList.builder` ist in Ordnung. Das `Text` ist das Problem: es wird zu einem `RenderParagraph`, der Viewport erwartete ein `RenderSliver`, und das Layout wirft eine Exception. Dasselbe passiert, wenn Sie ein `Column`, ein `Padding`, ein `Center`, ein `ListView` oder ein ganzes benutzerdefiniertes Seiten-Widget in `slivers` ablegen. Wenn es kein Sliver ist, lehnt der Viewport es ab.

## Fix 1: ein einzelnes Box-Widget in SliverToBoxAdapter verpacken

Für ein einzelnes Box-Widget -- eine Überschrift, ein Banner, eine Karte, eine Button-Zeile -- verpacken Sie es in `SliverToBoxAdapter`. Dieses Widget ist ein Sliver, dessen einzige Aufgabe darin besteht, ein `RenderBox`-Kind zu beherbergen und zwischen den beiden Protokollen zu übersetzen: es misst die Box und meldet dann das passende `SliverGeometry` an den Viewport.

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 20,
      itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
    ),
  ],
)
```

Das ist die direkte Lösung und die richtige, wenn der Box-Inhalt tatsächlich ein einzelner, fest dimensionierter Block ist. Es ist der Sliver, zu dem Sie zuerst greifen, wenn ein Header, ein Abstandhalter oder eine Zusammenfassungskarte über Ihren Listen in einer Scroll-Ansicht sitzen soll.

Das Einzige, was man wissen muss: `SliverToBoxAdapter` baut sein Kind eifrig und hält es am Leben, egal ob es auf dem Bildschirm ist oder nicht, denn eine Box kennt keine Trägheit. Das ist für einen Header in Ordnung. Für eine lange Liste ist es falsch, was Fix 2 ist.

## Fix 2: SliverList / SliverGrid für Listen verwenden, nicht ein verpacktes ListView

Der häufigste Fehler ist, ein `ListView` in `slivers` abzulegen und dann, wenn dieser Fehler auftaucht, das `ListView` in `SliverToBoxAdapter` zu verpacken. Das bringt die Assertion zum Schweigen, aber es ist die falsche Form. Sie haben jetzt ein scrollbares Element in einem scrollbaren Element, und das innere `ListView` erhält unbegrenzte Höhe vom Adapter -- dieselbe Fehlerfamilie wie [das Verschachteln eines ListView in einem Column](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/). Selbst wenn Sie es mit `shrinkWrap` zum Funktionieren zwingen, werfen Sie das träge Bauen weg: jede Zeile wird vorab konstruiert.

Der ganze Sinn einer `CustomScrollView` ist, dass ihre Abschnitte Sliver sind, die sich einen Viewport teilen. Verwenden Sie also die Sliver-Liste, nicht ein verpacktes `ListView`:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: Text('Recent activity')),

    // Lazy: only builds rows near the viewport. Direct replacement for ListView.builder.
    SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    ),

    // Grid section in the same scroll view.
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2),
      itemCount: photos.length,
      itemBuilder: (context, i) => Image.network(photos[i]),
    ),
  ],
)
```

`SliverList.builder`, `SliverList.separated`, `SliverFixedExtentList` und `SliverGrid.builder` sind die Sliver-Entsprechungen der `ListView`/`GridView`-Builder. Sie behalten das träge Bauen bei, das lange Listen günstig macht, und sie passen direkt in `slivers`. Wenn Sie eine Liste und ein Grid in einem durchgehenden Scroll fließen lassen wollen, ist dies das Layout dafür -- siehe [das Mischen eines ListView und eines GridView mit Slivern](/de/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) für das vollständige Muster.

## Fix 3: SliverPadding statt Padding, SliverFillRemaining statt einer Box

Die Box-gegen-Sliver-Regel erwischt auch die Wrapper-Widgets. Wenn Sie einen Sliver in `Padding` verpacken, um ihn einzurücken, ist `Padding` ein `RenderBox` und der Viewport lehnt es ab. Die Sliver-bewusste Version ist `SliverPadding`, das ein Sliver-Kind mit Abstand versieht und ein Sliver bleibt:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    SliverPadding(
      padding: const EdgeInsets.all(16),
      sliver: SliverList.builder(       // note: 'sliver:', not 'child:'
        itemCount: items.length,
        itemBuilder: (context, i) => Text(items[i]),
      ),
    ),
  ],
)
```

Achten Sie auf den Parameternamen: `SliverPadding` nimmt `sliver:`, nicht `child:`, denn sein Kind muss selbst ein Sliver sein. Dieselbe Idee deckt ein paar andere häufige Bedürfnisse ab:

- **Eine Box, die den übrigen Viewport füllen soll** (eine Leerzustand-Meldung, zentriert im verbleibenden Platz): `SliverFillRemaining(child: ...)`.
- **Eine Box, die genau eine Bildschirmhöhe hoch sein soll**: `SliverFillViewport`.
- **Ein angehefteter oder schwebender Header, der beim Scrollen schrumpft**: `SliverAppBar`, das bereits ein Sliver ist, also direkt in `slivers` kommt.
- **Mehrere Sliver gruppieren, um einen Clip oder eine Dekoration anzuwenden**: `SliverMainAxisGroup` / `SliverCrossAxisGroup`.

Das mentale Modell: für jedes Box-Widget, das Sie normalerweise verwenden würden, verpacken Sie es entweder (`SliverToBoxAdapter`, `SliverFillRemaining`) oder finden Sie seinen Sliver-Zwilling (`SliverList`, `SliverGrid`, `SliverPadding`, `SliverAppBar`).

## Fallstricke und Verwechslungen

**Ein Builder in slivers, der eine Exception wirft, zeigt denselben Fehler.** Wenn der empfangene Typ `RenderErrorBox` ist, war das Kind ein `ErrorWidget`: etwas in einem `StreamBuilder` oder `FutureBuilder`, das in Ihren `slivers` sitzt, hat während des Baus eine Exception geworfen, Flutter hat seine rote Fehlerbox (ein `RenderBox`) eingesetzt, und der Viewport hat diese abgelehnt. Die Lösung ist zweiteilig: sorgen Sie dafür, dass der Builder auf jedem Pfad ein Sliver zurückgibt, und behandeln Sie den Fehlerfall. Ein `StreamBuilder` in `slivers` muss aus seinem `builder` ein Sliver zurückgeben, einschließlich der Fehler- und Ladezweige:

```dart
// Flutter 3.x (tested 3.44)
StreamBuilder<List<String>>(
  stream: feed,
  builder: (context, snapshot) {
    if (snapshot.hasError) {
      return const SliverToBoxAdapter(child: Text('Could not load feed'));
    }
    if (!snapshot.hasData) {
      return const SliverToBoxAdapter(child: Center(child: CircularProgressIndicator()));
    }
    final items = snapshot.data!;
    return SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    );
  },
)
```

Wenn Sie aus irgendeinem Zweig ein nacktes `Text` oder `CircularProgressIndicator` zurückgeben, sind Sie wieder beim ursprünglichen Fehler. (Wenn Sie gerade dabei sind: falls ein `FutureBuilder` seinen Future bei jedem Rebuild erneut ausführt, ist das ein separater Fehler, den es sich zu beheben lohnt -- siehe [wie man FutureBuilder daran hindert, seinen Future neu zu erstellen](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)

**Die umgekehrte Diskrepanz liest sich fast gleich.** Wenn Sie einen Sliver dorthin setzen, wo eine Box hingehört -- etwa eine `SliverList` in einem `Column` -- erhalten Sie "A RenderObjectWithChildMixin expected a child of type RenderBox but received a child of type RenderSliverList" oder "expected a RenderBox but received a RenderSliverPadding". Dieselbe Regel, entgegengesetzte Richtung: Sliver leben nur in einem Viewport (`CustomScrollView` oder dem Slivers-Bereich von `NestedScrollView`), niemals direkt in einem `Column`, `Center` oder `Padding`. Um ein Sliver wieder in etwas zu verwandeln, das ein Box-Elternobjekt akzeptiert, tut man das im Allgemeinen nicht: man strukturiert um, sodass der Sliver in einer `CustomScrollView` liegt.

**`SliverToBoxAdapter` ist kein Ort, um eine lange Liste zu verstecken.** Es funktioniert, also ist es verlockend, aber es hebelt die Trägheit aus: der Adapter baut seinen gesamten Kind-Teilbaum sofort. Ein `ListView` mit 5.000 Zeilen (oder ein `Column` mit 5.000 Kindern) in einem zu verpacken bedeutet, alle 5.000 im ersten Frame zu bauen, was die Layout-Zeit in die Höhe treibt und sich als Ruckeln in der Timeline zeigt. Verwenden Sie es für Header und einzelne Karten; verwenden Sie `SliverList.builder` für alles, was scrollt.

**Hot Reload kann sich manchmal nicht davon erholen.** Weil die Assertion während des Layouts auslöst, kann ein Hot Reload nach dem Beheben des Codes den Render-Baum gelegentlich verklemmt lassen. Wenn der Fehler bestehen bleibt, nachdem Sie die störende Zeile klar behoben haben, führen Sie einen Hot Restart (`R`) durch, keinen Hot Reload (`r`).

## Verwandt

- [Wie man ein ListView und ein GridView in einer Scroll-Ansicht mit Slivern mischt](/de/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) -- das korrekte mehrteilige `CustomScrollView`-Layout, zu dem dieser Fehler Sie drängt.
- [Wie man ein ListView in einem Column ohne unbegrenzte-Höhe-Fehler verschachtelt](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) -- der Fehler, auf den Sie stoßen, wenn Sie dies "beheben", indem Sie ein ListView einboxen.
- [Fix: RenderBox was not laid out in Flutter](/de/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) -- die andere Layout-Zeit-Assertion, der Sie beim Verkabeln von Scroll-Ansichten begegnen.
- [Fix: A RenderFlex overflowed in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) -- Constraint-Ärger in `Row`/`Column`, der Box-seitige Verwandte dieses Problems.

## Quellen

- [RenderViewport class, Flutter API reference](https://api.flutter.dev/flutter/rendering/RenderViewport-class.html) -- das Render-Objekt, das das Sliver-Protokoll spricht und Box-Kinder ablehnt.
- [SliverToBoxAdapter class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverToBoxAdapter-class.html) -- das Verpacken eines einzelnen Box-Widgets als Sliver.
- [SliverList class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- das träge Listen-Sliver und seine `.builder` / `.separated` Konstruktoren.
- [flutter/flutter issue 126064](https://github.com/flutter/flutter/issues/126064) -- die `RenderErrorBox`-Variante, bei der ein Exception werfender Builder in `slivers` dieselbe Assertion erzeugt.

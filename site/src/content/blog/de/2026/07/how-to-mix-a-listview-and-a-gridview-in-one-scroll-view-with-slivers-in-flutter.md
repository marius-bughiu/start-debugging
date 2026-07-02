---
title: "Wie man eine ListView und eine GridView mit Slivern in einer Scroll-Ansicht kombiniert in Flutter"
description: "Bringen Sie eine Liste und ein Raster in einen einzigen durchgehenden Scroll ohne verschachtelte Scrollables. Verwenden Sie CustomScrollView mit SliverList und SliverGrid und umgehen Sie die shrinkWrap-Falle, die still die Performance ruiniert."
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "slivers"
  - "listview"
lang: "de"
translationOf: "2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-02
---

Sie möchten einen Bildschirm, auf dem eine Liste direkt in ein Raster übergeht (oder umgekehrt) und das Ganze als eine Einheit scrollt. Der falsche Instinkt ist, eine `ListView` und eine `GridView` in einer `Column` zu stapeln und zu `shrinkWrap: true` zu greifen, damit sie hineinpassen. Das kompiliert, aber es baut jedes Element im Voraus auf und liefert Ihnen zwei Scroll-Positionen, die gegeneinander kämpfen. Die richtige Antwort ist eine einzige `CustomScrollView`, deren Abschnitte Sliver sind: `SliverList` für den Listenteil, `SliverGrid` für den Rasterteil, `SliverToBoxAdapter` für jedes einfache Widget dazwischen. Ein Viewport, eine Scroll-Physik, volle Faulheit. Dieser Beitrag zeigt das funktionierende Layout auf Flutter 3.x (getestet auf 3.44, Dart 3.x), erklärt, warum die naive Version langsam ist, und behandelt die Details zu Abständen, Padding und Cross-Axis-Count, über die man stolpert.

## Warum man nicht einfach zwei Scrollables stapeln kann

Eine `ListView` und eine `GridView` sind beide scrollbare Viewports. Jede besitzt ihre eigene Scroll-Position und erwartet, eine begrenzte Höhe übergeben zu bekommen, damit sie weiß, wie hoch ihr Fenster ist. Setzen Sie zwei davon in eine `Column` und Sie stoßen an dieselbe Wand, die in [wie man eine ListView in einer Column ohne Unbounded-Height-Fehler verschachtelt](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) beschrieben ist: Die `Column` bietet jedem Kind unbegrenzten vertikalen Platz, und ein Scrollable weigert sich, sich in die Unendlichkeit hinein zu layouten.

Der übliche Behelf ist `shrinkWrap: true` auf beiden, verpackt in eine `SingleChildScrollView`:

```dart
// Flutter 3.x (tested 3.44) -- the anti-pattern, do not ship this
SingleChildScrollView(
  child: Column(
    children: [
      ListView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: posts.length,
        itemBuilder: (context, i) => PostTile(posts[i]),
      ),
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
        ),
        itemCount: photos.length,
        itemBuilder: (context, i) => PhotoTile(photos[i]),
      ),
    ],
  ),
)
```

Das rendert, und für ein Dutzend Elemente ist es in Ordnung. Aber `shrinkWrap: true` zwingt jedes Scrollable, jedes einzelne seiner Kinder im ersten Frame aufzubauen und zu vermessen, damit es eine endliche Höhe melden kann. Sie haben das faule Recycling weggeworfen, das Flutter-Listen flüssig hält. Bei einem Feed von einigen Hundert Fotos sind das Hunderte von Widgets, die vor dem ersten Paint aufgebaut werden, ein Spike, den Sie in der Timeline beobachten können (siehe [wie man Jank in einer Flutter-App mit DevTools profiliert](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)). Schlimmer noch: Sie haben jetzt drei Scroll-Ansichten (die äußere `SingleChildScrollView` plus zwei innere, die Sie mit `NeverScrollableScrollPhysics` deaktivieren mussten), alle nur vorhanden, damit eine davon tatsächlich scrollen kann. Es ist die falsche Form für das Problem.

## Was ein Sliver ist, in einem Absatz

Ein Sliver ist eine scrollbare Region, die direkt mit einem übergeordneten Viewport darüber kommuniziert, wie viel von sich selbst aktuell sichtbar ist und wie viel gemalt werden soll. Statt "hier ist meine Gesamthöhe, gib mir ein Fenster" sagt ein Sliver "du bist zu Offset X gescrollt mit einem Viewport der Höhe H, also layoute ich genau die Kinder, die in diesen Bereich fallen." Dieses Protokoll ist es, was eine `SliverList` faul macht: Sie muss ihre eigene Gesamthöhe nie kennen, also gibt es keinen Unbounded-Height-Handshake, der scheitern könnte, und keine Notwendigkeit, außerhalb des Bildschirms liegende Kinder aufzubauen. Eine `CustomScrollView` ist ein Viewport, der eine Liste dieser Sliver aufnimmt und durch sie alle als eine durchgehende Fläche scrollt. Weil jeder Abschnitt ein Sliver ist, teilen sie sich die einzige Scroll-Position ihres Elternteils, was genau das Verhalten ist, das Sie wollten.

## Das funktionierende Layout: erst SliverList, dann SliverGrid

Hier ist das Ganze. Ein Header, ein Listenabschnitt und ein Rasterabschnitt in einem Scroll:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class FeedPage extends StatelessWidget {
  const FeedPage({super.key, required this.posts, required this.photos});

  final List<Post> posts;
  final List<Photo> photos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Latest posts',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverList.builder(
            itemCount: posts.length,
            itemBuilder: (context, index) => PostTile(posts[index]),
          ),
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Photos',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 1,
            ),
            itemCount: photos.length,
            itemBuilder: (context, index) => PhotoTile(photos[index]),
          ),
        ],
      ),
    );
  }
}
```

Scrollen Sie es und die Liste geht als eine einzige Fläche in das Raster über. Beide Abschnitte sind faul: Nur die Kacheln innerhalb des Viewports (plus ein kleiner Cache) werden aufgebaut, egal wie viele Beiträge oder Fotos Sie haben. Es gibt eine Scroll-Position, sodass ein in der Liste gestarteter Fling ohne Naht in das Raster hineinträgt.

Drei Sliver-Typen erledigen hier die Arbeit, und es sind die drei, die Sie für fast alles verwenden werden:

1. **`SliverToBoxAdapter`** verpackt jedes gewöhnliche Box-Widget (eine Überschrift, ein Banner, eine Trennlinie), damit es in einer Sliver-Liste sitzen kann. Es baut sein Kind eifrig auf, was für ein einzelnes kleines Widget korrekt ist, aber für eine lange Liste falsch, also setzen Sie niemals eine `ListView` oder eine große `Column` hinein. Verwenden Sie es für einmalige Widgets zwischen Ihren faulen Abschnitten.
2. **`SliverList.builder`** ist die faule Liste. Dieselbe `itemCount` / `itemBuilder`-API, die Sie von `ListView.builder` kennen, abzüglich des Viewports, weil die umschließende `CustomScrollView` jetzt der Viewport ist.
3. **`SliverGrid.builder`** ist das faule Raster. Es nimmt ein `gridDelegate`, das die Spalten steuert, genau wie `GridView.builder`.

## Die Rasterspalten steuern

Das `gridDelegate` ist der Ort, an dem Sie entscheiden, wie viele Spalten das Raster hat und wie die Kacheln beabstandet sind. Zwei Delegates decken nahezu jeden Fall ab.

`SliverGridDelegateWithFixedCrossAxisCount` legt eine feste Anzahl von Spalten fest. Verwenden Sie es, wenn die Anzahl eine Design-Entscheidung ist ("immer 3 nebeneinander"):

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
  crossAxisCount: 3,   // exactly 3 columns
  mainAxisSpacing: 8,  // vertical gap between rows
  crossAxisSpacing: 8, // horizontal gap between columns
  childAspectRatio: 1, // width / height of each tile; 1 = square
),
```

`SliverGridDelegateWithMaxCrossAxisExtent` begrenzt stattdessen die Breite jeder Kachel und lässt Flutter die Spaltenanzahl aus der verfügbaren Breite berechnen. Das ist die responsive Wahl: Ein Telefon bekommt 2 Spalten, ein Tablet bekommt 5, ohne einen `LayoutBuilder`:

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
  maxCrossAxisExtent: 180, // each tile is at most 180px wide
  mainAxisSpacing: 8,
  crossAxisSpacing: 8,
  childAspectRatio: 1,
),
```

Die mit Abstand häufigste Rasterfrustration sind Kacheln, die gestreckt oder gestaucht aussehen, und die Ursache ist fast immer `childAspectRatio`. Es ist die Breite geteilt durch die Höhe. Der Standardwert ist `1.0` (quadratisch). Wenn Ihre Fotokacheln höher als breit sind, senken Sie das Verhältnis unter 1 (zum Beispiel `0.75` für eine 3:4-Hochformat-Karte); wenn sie breiter sind, schieben Sie es über 1. Ein `childAspectRatio`-Missverhältnis wirft keine Ausnahme, es verzerrt einfach still jede Kachel, also lohnt es sich, es bewusst zu setzen, anstatt es dem Standard zu überlassen.

## Padding hinzufügen, ohne die Faulheit zu brechen

Einen Sliver in ein gewöhnliches `Padding`-Widget zu verpacken funktioniert nicht, weil `Padding` ein Box-Kind erwartet, keinen Sliver. Das Sliver-Äquivalent ist `SliverPadding`:

```dart
// Flutter 3.x (tested 3.44)
SliverPadding(
  padding: const EdgeInsets.symmetric(horizontal: 16),
  sliver: SliverGrid.builder(
    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
      crossAxisCount: 3,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
    ),
    itemCount: photos.length,
    itemBuilder: (context, index) => PhotoTile(photos[index]),
  ),
)
```

Beachten Sie den `sliver:`-Parameter, nicht `child:`. `SliverPadding` rückt einen Sliver ein und bleibt faul. Greifen Sie danach, wann immer ein Abschnitt Abstand zu den Bildschirmrändern braucht; den gesamten `CustomScrollView`-Body in ein großes `Padding` zu verpacken würde die Abstandsberechnung des Rasters beschneiden und ist die falsche Ebene, um Ränder hinzuzufügen.

## Ein scrollender Header, der einklappt

Da Sie bereits eine `CustomScrollView` haben, ist das Hinzufügen einer `SliverAppBar`, die beim Scrollen aus- und einklappt, fast gratis. Das ist der klassische Grund, warum Leute überhaupt auf Sliver umsteigen:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(
      title: Text('Explore'),
      floating: true,      // reappears as soon as you scroll up
      expandedHeight: 160,
      flexibleSpace: FlexibleSpaceBar(
        background: ColoredBox(color: Colors.indigo),
      ),
    ),
    SliverList.builder(
      itemCount: posts.length,
      itemBuilder: (context, i) => PostTile(posts[i]),
    ),
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
      ),
      itemCount: photos.length,
      itemBuilder: (context, i) => PhotoTile(photos[i]),
    ),
  ],
)
```

Setzen Sie `pinned: true`, um die Leiste oben festzuhalten, `floating: true`, damit sie bei jedem Aufwärts-Scroll wieder hereingleitet, und `expandedHeight` mit einem `flexibleSpace`, um den Groß-zu-klein-Einklappeffekt zu erhalten. Nichts davon ist mit einer einfachen `Column` von Scrollables möglich, was der konkrete Gewinn für den Umstieg auf Sliver ist.

## Die Fallstricke, die wirklich beißen

**Verschachteln Sie kein Scrollable in einem Sliver.** Der ganze Sinn ist ein Viewport. Eine `ListView` in einen `SliverToBoxAdapter` zu setzen führt den Unbounded-Height-Fehler und eine zweite Scroll-Position wieder ein. Wenn Sie eine horizontal scrollende Zeile innerhalb einer vertikalen `CustomScrollView` haben, ist das in Ordnung (andere Achse, geben Sie ihr eine feste Höhe über einen `SliverToBoxAdapter`, der eine `SizedBox` umschließt), aber verschachteln Sie niemals ein Scrollable derselben Achse.

**Keys sind wichtig, wenn Elemente umsortiert werden.** Wenn die Listen- oder Rasterelemente eingefügt, entfernt oder umsortiert werden können, geben Sie jeder Kachel einen `ValueKey`, der an ihre Daten gebunden ist, damit Flutter den richtigen State über Rebuilds hinweg dem richtigen Widget zuordnet. Ohne Keys kann eine entfernte Zeile ihren State an der falschen Kachel hängen lassen.

**Achten Sie auf den Fall des leeren Abschnitts.** Eine `SliverList` oder `SliverGrid` mit `itemCount: 0` malt einfach nichts, was Sie wollen, aber wenn Sie zusätzlich einen "noch keine Fotos"-Platzhalter möchten, verwenden Sie `SliverToBoxAdapter` oder `SliverFillRemaining`, um ihn anzuzeigen, nicht ein leeres Raster.

**`SliverFillRemaining` füllt den übrigen Viewport.** Wenn Liste plus Raster den Bildschirm nicht füllen und Sie eine Fußzeile oder einen leeren Zustand am unteren Rand des sichtbaren Bereichs verankert haben möchten, nimmt `SliverFillRemaining(hasScrollBody: false, child: ...)` genau die verbleibende Höhe ein. Es ist die Sliver-Version von `Expanded` für den letzten Abschnitt.

**Sliver zusammengruppieren.** Wenn Sie mehrere Listen-und-Raster-Paare bauen und jedes Paar als Einheit behandeln möchten (zum Beispiel um einen gemeinsamen Hintergrund anzuwenden), stapelt `SliverMainAxisGroup` (Flutter 3.16+) Kind-Sliver entlang der Scroll-Achse, sodass sie sich wie ein einzelner Sliver verhalten. Sie brauchen es für eine einfache Liste-plus-Raster selten, aber es ist das Werkzeug, wenn ein Abschnitt eine interne Struktur hat.

## Wann eine einfache GridView oder ListView immer noch richtig ist

Sliver sind die Antwort, wenn Sie Abschnitte in einem Scroll kombinieren. Sie sind überdimensioniert, wenn Sie eine einzelne Liste oder ein einzelnes Raster haben und nichts anderes damit scrollt. Eine einzelne `GridView.builder` in einem `Scaffold`-Body ist bereits faul und bereits der Viewport; sie in eine `CustomScrollView` mit einem `SliverGrid` zu verpacken fügt Zeremonie ohne Nutzen hinzu. Greifen Sie zu Slivern in dem Moment, in dem Sie zwei oder mehr scrollbare Abschnitte, einen einklappenden Header oder einen Header haben, der mit dem Inhalt wegscrollen muss. Für alles andere sind die einfachen Widgets in Ordnung, und wenn Ihr einziges Problem eine einzelne Liste ist, die sich weigert, in eine `Column` zu passen, sind die vier Fixes im [Unbounded-Height-Beitrag](/de/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) der kürzere Weg.

Noch eine Angewohnheit, die es sich zu behalten lohnt: Wenn ein Abschnitt einen `ScrollController` verwendet (zum Beispiel um die kombinierte Ansicht zu einem Abschnitt zu springen), hängen Sie ihn an die `CustomScrollView`, nicht an die einzelnen Sliver (Sliver nehmen keinen Controller entgegen), und [entsorgen Sie ihn](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) in Ihrem `State.dispose`, damit Sie ihn nicht lecken. Und wenn eine Kachel im Raster jemals ihre Zelle überläuft, taucht das als [RenderFlex overflowed](/de/2026/05/fix-renderflex-overflowed-in-flutter/)-Warnung innerhalb der Kachel auf, unabhängig von der Sliver-Verdrahtung, behoben auf Kachelebene.

## Das mentale Modell, das man behalten sollte

Eine `CustomScrollView` ist ein Viewport; jeder Abschnitt, den Sie hineinsetzen, ist ein Sliver, und Sliver teilen sich diese einzige Scroll-Position, während jeder faul bleibt. `SliverList` und `SliverGrid` sind die faule Liste und das faule Raster, `SliverToBoxAdapter` ist die Notluke für einmalige Box-Widgets, `SliverPadding` fügt Ränder hinzu, und `SliverAppBar` ist der einklappende Header, den Sie fast gratis bekommen. Sobald Sie aufhören, "zwei Scrollables stapeln" zu denken, und anfangen, "ein Scroll aus Slivern" zu denken, ist das Kombinieren einer Liste und eines Rasters kein Kampf mit der Layout-Engine mehr, sondern wird zu vier Zeilen Komposition.

## Quellen

- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- mehrere Sliver in einem Viewport hosten, einschließlich des SliverAppBar + SliverList + SliverGrid-Beispiels.
- [SliverGrid class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverGrid-class.html) -- die builder/count/extent-Konstruktoren und die zwei Grid-Delegates.
- [SliverList class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- faules Listenverhalten und der SliverFixedExtentList-Hinweis.
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- das Sliver-Protokoll und wie Viewports den Paint-Extent aushandeln.

---
title: "Provider vs Riverpod vs Bloc für State Management in Flutter 2026"
description: "Wählen Sie Riverpod für die meisten neuen Flutter-Apps in 2026. Greifen Sie zu Bloc, wenn ein großes Team eine erzwungene ereignisbasierte Struktur will, und behalten Sie Provider nur für Legacy-Code."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "bloc"
lang: "de"
translationOf: "2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026"
translatedBy: "claude"
translationDate: 2026-06-04
---

Wenn Sie 2026 eine neue Flutter-App starten und sich nicht zwischen Provider, Riverpod und Bloc entscheiden können, lautet die kurze Antwort Riverpod. Mit Riverpod 3.3.1 (die 3.0-Linie erschien am 2025-09-10) ist es sicher zur Kompilierzeit, ohne `BuildContext` testbar, und der Pfad über Codegenerierung beseitigt fast das gesamte Boilerplate, das früher das Hauptargument dagegen war. Greifen Sie zu Bloc (`flutter_bloc` 9.1.1), wenn Sie ein großes Team haben, das von einem strengen ereignisbasierten Vertrag und einer nachvollziehbaren Zustandshistorie profitiert. Behalten Sie Provider (6.1.5) nur, wenn Sie ihn bereits in einer Codebasis haben oder jemandem das zugrunde liegende `InheritedWidget`-Modell beibringen. Alle Beispiele hier verwenden Flutter 3.44 und Dart 3.12.

## Die drei Pakete sind nicht dieselbe Art von Werkzeug

Bevor man sie vergleicht, hilft es zu sehen, dass diese Bibliotheken überlappende, aber unterschiedliche Probleme lösen.

Provider ist ein dünner, gut gemachter Wrapper über Flutters eigenem `InheritedWidget`. Er macht Dependency Injection und die Weitergabe von Rebuilds, und im Wesentlichen war es das. Die Zustandsklasse ist meist ein `ChangeNotifier`, den Sie von Hand schreiben. Es ist das Paket, zu dem die offizielle Flutter-Dokumentation griff, als sie ein didaktisches Beispiel brauchte, weshalb so viele Tutorials es verwenden.

Riverpod ist das, was der Autor von Provider als Nächstes baute, gezielt um die strukturellen Probleme von Provider zu beheben: die `ProviderNotFoundException` zur Laufzeit, die Abhängigkeit von der Position des Widgets im Baum und die Unmöglichkeit, den Zustand aus reinem Dart zu lesen. Riverpod-Provider leben außerhalb des Widget-Baums, sind also von überall erreichbar und werden zur Kompilierzeit aufgelöst.

Bloc ist zuerst ein Muster und dann ein Paket. Es drängt Sie dazu, jede Änderung als explizites Ereignis zu modellieren, das in eine Komponente fließt und einen neuen unveränderlichen Zustand erzeugt. Diese Zeremonie ist genau der Punkt: In einem großen Team macht eine erzwungene `Event -> Bloc -> State`-Pipeline das Verhalten vorhersehbar und überprüfbar.

## Funktionsmatrix

| Funktion | Provider 6.1.5 | Riverpod 3.3.1 | Bloc 9.1.1 |
| --- | --- | --- | --- |
| Gedankenmodell | `InheritedWidget` + `ChangeNotifier` | Provider außerhalb des Baums | Ereignisbasiert, unveränderliche Zustände |
| Sicherheit zur Kompilierzeit | Nein (Suche zur Laufzeit) | Ja | Ja |
| Braucht `BuildContext` zum Lesen | Ja | Nein | Nein (über `context.read` oder direkt) |
| Boilerplate | Gering | Gering mit Codegen | Hoch |
| Testbarkeit | Braucht Widget-Pumping | Reines Dart, kein Widget-Baum | Reines Dart, `bloc_test`-Helfer |
| Async- / Ladezustand | Manuell | `AsyncValue`, eingebaut | Manuelle Zustände oder `emit` |
| Automatischer Retry bei Fehlern | Nein | Ja (seit 3.0) | Nein |
| Nachverfolgbarkeit des Zustands | Schwach | Mittel | Stark (jeder Übergang beobachtbar) |
| Lernkurve | Sanft | Moderat | Steil |
| Beste Eignung | Legacy, Tutorials | Die meisten neuen Apps | Große Teams, komplexe Abläufe |

Die wichtigste Zeile ist "Sicherheit zur Kompilierzeit". Ein falsch konfigurierter Provider wirft `ProviderNotFoundException` zur Laufzeit, oft nur auf dem Bildschirm, wo er fehlt. Riverpod und Bloc bringen diese Fehlerklasse ans Licht, bevor die App läuft.

## Derselbe Zähler in allen dreien

Ein Zähler ist klein genug, um die Ergonomie direkt zu vergleichen. Beachten Sie, wie viel Code jeder braucht und wo der Zustand lebt.

### Provider

```dart
// Flutter 3.44, provider 6.1.5
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class CounterModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  void increment() {
    _count++;
    notifyListeners();
  }
}

// Register it above the widgets that need it.
ChangeNotifierProvider(
  create: (_) => CounterModel(),
  child: const CounterPage(),
);

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final count = context.watch<CounterModel>().count;
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.read<CounterModel>().increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Beachten Sie die Abhängigkeit von `context`. Wird `CounterPage` ohne einen `ChangeNotifierProvider` darüber gerendert, wirft `context.watch<CounterModel>()` zur Laufzeit.

### Riverpod

```dart
// Flutter 3.44, flutter_riverpod 3.3.1, riverpod_annotation
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'counter.g.dart';

@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;

  void increment() => state++;
}

class CounterPage extends ConsumerWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Scaffold(
      body: Center(child: Text('$count')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => ref.read(counterProvider.notifier).increment(),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

Der `counterProvider` wird generiert und ist global erreichbar. Es gibt keine Baumposition, die man falsch machen könnte, und `ref` wird zur Kompilierzeit aufgelöst. Umhüllen Sie die App einmal mit `ProviderScope`, und Sie sind fertig.

### Bloc

```dart
// Flutter 3.44, flutter_bloc 9.1.1, equatable
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

// Events
sealed class CounterEvent {}
class Increment extends CounterEvent {}

// Bloc: Event in, int state out.
class CounterBloc extends Bloc<CounterEvent, int> {
  CounterBloc() : super(0) {
    on<Increment>((event, emit) => emit(state + 1));
  }
}

class CounterPage extends StatelessWidget {
  const CounterPage({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => CounterBloc(),
      child: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: BlocBuilder<CounterBloc, int>(
              builder: (context, count) => Text('$count'),
            ),
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () => context.read<CounterBloc>().add(Increment()),
            child: const Icon(Icons.add),
          ),
        ),
      ),
    );
  }
}
```

Bloc ist für einen Zähler am ausführlichsten, und dieser Vergleich ist ihm gegenüber unfair: Der Wert von Bloc zeigt sich, wenn es zwanzig Ereignisse und zehn Zustände gibt, nicht eines. Das `Increment`-Ereignis ist ein Eintrag in der Historie Ihrer App. Mit einem angehängten `BlocObserver` können Sie jeden Übergang protokollieren, was genau das ist, was Sie beim Debuggen eines komplexen Bildschirms wollen.

## Wann Sie Riverpod wählen sollten

- **Eine neue App in 2026 ohne Legacy-Einschränkungen.** Das ist die Standardwahl. Riverpod gibt Ihnen Sicherheit zur Kompilierzeit, Tests ohne `pumpWidget` und Async-Handling über `AsyncValue` von Haus aus. Sehen Sie sich unsere Anleitung zu [Lade- und Fehlerzuständen mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) an, um zu sehen, wie sauber Async wird.
- **Sie lesen den Zustand außerhalb von Widgets.** Eine Hintergrundsynchronisation, eine Repository-Schicht oder ein Dienst, der das aktuelle Auth-Token braucht, können `ref.read` ohne `BuildContext` aufrufen. Provider kann das nicht sauber.
- **Sie wollen Resilienz für unzuverlässige Netzwerk-Provider.** Riverpod 3.0 fügte automatischen Retry mit exponentiellem Backoff (200ms, verdoppelt bis 6.4s) für Provider hinzu, die während der Initialisierung fehlschlagen, plus das automatische Pausieren der Listener, wenn ein Widget aus dem Bild scrollt.
- **Sie migrieren von GetX oder Ähnlichem.** Riverpod ist das übliche Ziel. Unser [Migrationsleitfaden von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) behandelt die beweglichen Teile.

Ein Vorbehalt: In Riverpod 3.0 wurden `StateProvider`, `StateNotifierProvider` und `ChangeNotifierProvider` nach `package:riverpod/legacy.dart` verschoben. Neuer Code sollte die oben gezeigten Klassen `Notifier` und `AsyncNotifier` verwenden, idealerweise mit Codegenerierung über `@riverpod`.

## Wann Sie Bloc wählen sollten

- **Ein großes Team, das einen erzwungenen Vertrag will.** Wenn fünf Entwickler dieselbe Funktion anfassen, verhindert der starre `Event -> Bloc -> State`-Fluss, dass jeder sein eigenes Muster erfindet. Die Struktur ist das Ergebnis.
- **Sie brauchen eine prüfbare Zustandshistorie.** Ein `BlocObserver` sieht jeden Übergang. Für Abläufe wie Checkout, Onboarding oder ein mehrstufiges Formular ist es das Boilerplate wert, die exakte Ereignisfolge wiederzugeben, die einen Bug erzeugt hat.
- **Komplexe, verzweigte Async-Logik.** Blocs Event-Transformatoren (debounce, throttle, `droppable`, `concurrent`) geben Ihnen feine Kontrolle darüber, wie überlappende Ereignisse behandelt werden. Das ist in den anderen beiden schwerer auszudrücken.
- **Sie wollen `Cubit` für die einfachen Fälle.** Nicht jeder Bildschirm braucht vollständige Ereignisse. Ein `Cubit` ist ein Bloc ohne die Ereignisschicht: Sie rufen Methoden auf, die neuen Zustand direkt `emit`-en, sodass Sie leichtgewichtige Cubits und vollständige Blocs in derselben App mischen können.

## Wann Sie Provider wählen sollten

- **Sie haben ihn bereits.** Eine funktionierende Provider-App braucht keine Neuschreibung. An `ChangeNotifier` für App-Zustand, der nicht leistungskritisch ist, ist nichts falsch.
- **Sie vermitteln die Grundlagen.** Provider bildet fast eins zu eins auf `InheritedWidget` ab, also ist es der klarste Weg, jemandem zu zeigen, wie Flutter Zustand ohne eine Drittanbieter-Abstraktion weitergibt.
- **Eine wirklich winzige App.** Ein einzelner Einstellungsbildschirm mit einem Schalter rechtfertigt weder Codegenerierung noch eine Ereignis-Pipeline.

Was Provider 2026 nicht sein sollte, ist die Standardwahl für eine neue, nicht triviale App. Das Suchmodell zur Laufzeit ist genau das Problem, zu dessen Beseitigung Riverpod gebaut wurde.

## Die Stolpersteine, die für Sie entscheiden

Einige Einschränkungen überstimmen die persönliche Vorliebe.

**Den Zustand aus Nicht-Widget-Code lesen.** Wenn Ihre Architektur eine Service- oder Repository-Schicht hat, die den App-Zustand direkt lesen muss, ist Provider praktisch raus. Er braucht einen `BuildContext`. Riverpod und Bloc erlauben beide das Lesen des Zustands aus reinem Dart, was die Entscheidung meist von selbst klärt.

**Teamgröße und Review-Kultur.** In einem Solo-Projekt oder einem kleinen Team ist Blocs Zeremonie Reibung mit wenig Ertrag, und Riverpod gewinnt bei der Geschwindigkeit. In einem 15-köpfigen Team, wo Konsistenz über Funktionen hinweg mehr zählt als Codezeilen, ist Blocs Starrheit eine Funktion, keine Kosten.

**Disziplin bei unveränderlichem Zustand.** Sowohl Bloc als auch das moderne Riverpod drängen Sie zu unveränderlichen Zustandsobjekten. Wenn Ihr Team mit versiegelten Klassen und Wertgleichheit vertraut ist (siehe [Dart Records vs Freezed-Klassen](/de/2026/05/dart-records-vs-freezed-classes/) für die Modellierungsoptionen), passen beide. Wenn Sie eine große Codebasis auf veränderlichen `ChangeNotifier`-Objekten haben, ist der günstigste Weg vielleicht, bei Provider zu bleiben, bis eine Funktion tatsächlich mehr braucht.

**Vorhandene Async-Muster.** Riverpods `AsyncValue` ist der aufwandsärmste Weg, Laden, Daten und Fehler aus einer einzigen Wahrheitsquelle zu rendern. Wenn Ihre Bildschirme größtenteils Async-Datenabrufe sind, ist das allein schon ein starker Grund, es zu wählen.

## Die Empfehlung, noch einmal

Verwenden Sie für die meisten neuen Flutter-Apps in 2026 Riverpod 3.3.1 mit Codegenerierung. Sie erhalten Sicherheit zur Kompilierzeit, kontextfreie Lesezugriffe, erstklassiges Async und die Resilienz-Funktionen von 3.0, bei Boilerplate-Kosten, die Codegen nahe an Provider heranbringt.

Wählen Sie Bloc 9.1.1, wenn eine erzwungene ereignisbasierte Struktur und eine vollständig nachverfolgbare Zustandshistorie Ihrem Team mehr wert sind als Knappheit, was bei großen Teams und komplexen Abläufen meist zutrifft. Verwenden Sie Cubits innerhalb einer Bloc-App für die Bildschirme, die keine vollständigen Ereignisse brauchen.

Behalten Sie Provider 6.1.5 für Legacy-Apps, Lehre und triviale Bildschirme, aber greifen Sie nicht standardmäßig in einem neuen, nicht trivialen Projekt dazu. Die entscheidende Frage ist selten "welcher hat den schönsten Zähler", sondern "lese ich Zustand außerhalb von Widgets, wie groß ist mein Team und wie viel Async habe ich?". Beantworten Sie diese drei, und die Wahl trifft sich meist von selbst. Wenn Sie Flutter gegen ganz andere Stacks abwägen, zoomt unser [Vergleich von Flutter vs React Native vs MAUI](/de/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) eine Ebene heraus. Und was auch immer Sie wählen, denken Sie daran, [Ihre Controller freizugeben](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/), denn keine State-Management-Bibliothek räumt diese für Sie auf.

## Quellen

- [Riverpod: Was ist neu in 3.0](https://riverpod.dev/docs/whats_new) - Legacy-APIs, automatischer Retry, Pause/Resume, Offline-Persistenz, Mutationen.
- [flutter_riverpod auf pub.dev](https://pub.dev/packages/flutter_riverpod) und [Changelog](https://pub.dev/packages/flutter_riverpod/changelog) - Version 3.3.1, 3.0.0 veröffentlicht am 2025-09-10.
- [flutter_bloc auf pub.dev](https://pub.dev/packages/flutter_bloc) - Version 9.1.1, BlocProvider / BlocBuilder / BlocListener, Cubit vs Bloc.
- [provider auf pub.dev](https://pub.dev/packages/provider) - Version 6.1.5, ChangeNotifierProvider, Flutter Favorite.
- [Flutter-Release-Notes](https://docs.flutter.dev/release/release-notes) - Flutter 3.44 stabil, Dart 3.12.

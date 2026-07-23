---
title: "riverpod vs flutter_riverpod vs hooks_riverpod: welches Paket brauche ich wirklich?"
description: "Installieren Sie flutter_riverpod für fast jede Flutter-App. Nutzen Sie riverpod nur für reinen Dart-Code und hooks_riverpod nur, wenn Sie bereits flutter_hooks verwenden."
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
lang: "de"
translationOf: "2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need"
translatedBy: "claude"
translationDate: 2026-07-23
---

Wenn pub.dev Ihnen `riverpod`, `flutter_riverpod` und `hooks_riverpod` anzeigt und Sie nicht entscheiden können, welches Sie hinzufügen sollen, lautet die Antwort für fast jede Flutter-App `flutter_riverpod`. Fügen Sie `riverpod` (ohne das Präfix `flutter_`) nur hinzu, wenn Sie reines Dart ohne Flutter-Abhängigkeit schreiben, etwa eine CLI oder einen Server. Fügen Sie `hooks_riverpod` nur hinzu, wenn Sie bereits das Paket `flutter_hooks` verwenden und `HookConsumerWidget` möchten. Diese drei sind keine konkurrierenden State-Manager: Sie sind Schichten derselben Bibliothek, und das falsche zu wählen bedeutet nur einen leicht falschen Import, keine andere Architektur. Alle Versionen hier zielen auf Riverpod 3.3.2 (die 3.0-Linie erschien am 2025-09-10), Flutter 3.44 und Dart 3.12.

## Es sind Schichten, keine Rivalen

Die Verwirrung entsteht, weil pub.dev sie nebeneinander auflistet, als wären sie Alternativen wie Provider und Bloc. Das sind sie nicht. `riverpod` ist der zentrale Motor, in reinem Dart geschrieben und ohne jeden Flutter-Import. `flutter_riverpod` nimmt diesen Motor und fügt den Flutter-Klebstoff hinzu: `ProviderScope`, `ConsumerWidget`, `Consumer` und den `WidgetRef`, auf dem Sie `ref.watch` aufrufen. `hooks_riverpod` nimmt `flutter_riverpod` und fügt eine weitere Sache obendrauf: die Integration mit dem eigenständigen Paket `flutter_hooks`, das `HookConsumerWidget` bereitstellt.

Jedes Paket reexportiert das darunterliegende. Wenn Sie `flutter_riverpod` hinzufügen, erhalten Sie auch alles aus `riverpod`, ohne es aufzulisten. Wenn Sie `hooks_riverpod` hinzufügen, erhalten Sie auch alles aus `flutter_riverpod`. Deshalb installieren Sie nie mehr als eines davon gleichzeitig, und deshalb ist es ein Fehler, `flutter_riverpod` zu installieren und dann aus `package:riverpod/riverpod.dart` zu importieren, was verwirrende Fehler wegen doppelter Symbole erzeugt.

## Funktionsmatrix

| Funktion | `riverpod` 3.3.2 | `flutter_riverpod` 3.3.2 | `hooks_riverpod` 3.3.2 |
| --- | --- | --- | --- |
| Hängt von Flutter ab | Nein | Ja | Ja |
| Provider-Motor (`Provider`, `Notifier`, `ref.watch`) | Ja | Ja | Ja |
| Widget `ProviderScope` | Nein | Ja | Ja |
| `ConsumerWidget` / `Consumer` | Nein | Ja | Ja |
| `HookConsumerWidget` / `HookConsumer` | Nein | Nein | Ja |
| Erfordert `flutter_hooks` daneben | Nein | Nein | Ja |
| Reexportiert das untere Paket | -- | `riverpod` | `flutter_riverpod` |
| Geeignet für | Reinen Dart-Code | Die meisten Flutter-Apps | Flutter-Apps, die bereits hooks nutzen |

Der Typ `AsyncValue`, `ref.listen`, die Provider-Modifikatoren wie `.autoDispose` und das in 3.0 hinzugefügte automatische Retry-Verhalten leben alle im zentralen Paket `riverpod`, daher ist jede Zeile, die sie enthält, zwischen den dreien identisch. Die einzigen echten Unterschiede sind die Widget-Basisklassen und die Flutter-Abhängigkeit.

## Wann Sie flutter_riverpod installieren

Dies ist der Standard, und er deckt die große Mehrheit der Apps ab.

- Sie bauen eine normale Flutter-Anwendung (mobil, Desktop oder Web) und möchten `ProviderScope` an der Wurzel und `ConsumerWidget` in Ihren Bildschirmen.
- Sie nutzen das Paket `flutter_hooks` nicht und planen es auch nicht.
- Sie möchten die kleinstmögliche Abhängigkeitsfläche, die immer noch die vollständige Flutter-Integration bietet.

Die Installation ist ein einziger Befehl:

```bash
# Flutter 3.44, flutter_riverpod 3.3.2
flutter pub add flutter_riverpod
```

Ein minimal funktionierendes Widget sieht so aus:

```dart
// Flutter 3.44, Dart 3.12, flutter_riverpod 3.3.2
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = NotifierProvider<Counter, int>(Counter.new);

class Counter extends Notifier<int> {
  @override
  int build() => 0;
  void increment() => state++;
}

void main() {
  // ProviderScope comes from flutter_riverpod
  runApp(const ProviderScope(child: MyApp()));
}

class CounterView extends ConsumerWidget {
  const CounterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);
    return Text('$count');
  }
}
```

`ProviderScope`, `ConsumerWidget` und `WidgetRef` werden alle von `flutter_riverpod` bereitgestellt. Der `NotifierProvider`, `Notifier` und `state` stammen aus dem zentralen Motor, den `flutter_riverpod` reexportiert. Sie importieren `package:riverpod/riverpod.dart` niemals direkt in einer Flutter-App.

## Wann Sie das reine riverpod installieren

Greifen Sie nur dann zum nackten Paket `riverpod`, wenn im Projekt überhaupt kein Flutter vorhanden ist.

- Ein Dart-Kommandozeilenwerkzeug, das Provider-basierte Logik mit einer Flutter-App teilt.
- Ein `dart_frog`- oder `shelf`-Server, der den Abhängigkeitsgraphen von Riverpod im Backend möchte.
- Ein reines Dart-Paket, von dem andere Apps abhängen, wo das Hereinziehen von Flutter falsch wäre.

```bash
# Dart 3.12, riverpod 3.3.2
dart pub add riverpod
```

In einem reinen Dart-Kontext gibt es keinen Widget-Baum, daher konstruieren Sie statt `ProviderScope` selbst einen `ProviderContainer` und lesen daraus:

```dart
// Dart 3.12, riverpod 3.3.2 (no Flutter)
import 'package:riverpod/riverpod.dart';

final greetingProvider = Provider<String>((ref) => 'hello from Dart');

void main() {
  final container = ProviderContainer();
  print(container.read(greetingProvider)); // hello from Dart
  container.dispose();
}
```

Wenn Ihr Projekt ein `pubspec.yaml` mit `flutter:` unter dependencies hat, ist dies fast nie das Paket, das Sie möchten. Reines `riverpod` zu einer Flutter-App hinzuzufügen und sich dann zu fragen, warum `ConsumerWidget` und `ProviderScope` nicht aufgelöst werden, ist einer der häufigsten Einrichtungsfehler bei Riverpod.

## Wann Sie hooks_riverpod installieren

Installieren Sie `hooks_riverpod` nur, wenn Sie sich bereits auf `flutter_hooks` festgelegt haben und hooks innerhalb desselben Widgets nutzen möchten, das Provider liest.

Die entscheidende Tatsache: `flutter_hooks` und Riverpod sind zwei eigenständige Pakete. `flutter_hooks` ist eine Portierung der React-Hooks, die lokalen Widget-State verwaltet, Dinge wie einen `TextEditingController` oder einen `AnimationController`, die auf ein einzelnes Widget beschränkt sind. Riverpod verwaltet gemeinsamen Anwendungs-State. Sie lösen unterschiedliche Probleme, und Sie können jedes ohne das andere nutzen. `hooks_riverpod` existiert rein dafür, dass ein einzelnes Widget beides tun kann, ohne einen Klassen-Vererbungskonflikt.

Dieser Konflikt ist real. `HookWidget` (aus `flutter_hooks`) und `ConsumerWidget` (aus `flutter_riverpod`) sind beide Basisklassen, und eine Dart-Klasse kann nur eine Superklasse erweitern. Sie können nicht `class X extends HookWidget, ConsumerWidget` schreiben. `hooks_riverpod` löst dies, indem es `HookConsumerWidget` liefert, eine einzige Basisklasse, die beides zugleich ist:

```dart
// Flutter 3.44, hooks_riverpod 3.3.2, flutter_hooks 0.21.2
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

class SearchField extends HookConsumerWidget {
  const SearchField({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // useTextEditingController is a hook: local widget state
    final controller = useTextEditingController();
    // ref.watch is Riverpod: shared app state
    final results = ref.watch(searchResultsProvider);

    return TextField(controller: controller);
  }
}
```

Zwei Dinge sind zu beachten. Erstens bündelt `hooks_riverpod` nicht `flutter_hooks`, daher müssen Sie beide hinzufügen:

```bash
# Flutter 3.44
flutter pub add hooks_riverpod
flutter pub add flutter_hooks
```

Zweitens: Da `hooks_riverpod` `flutter_riverpod` reexportiert, müssen und sollten Sie `flutter_riverpod` nicht zusätzlich im `pubspec.yaml` auflisten. Der einzelne `hooks_riverpod`-Import liefert Ihnen `ProviderScope`, `ConsumerWidget` und `HookConsumerWidget` alle zusammen. Eine Datei, die nur Provider liest, kann immer noch das einfache `ConsumerWidget` erweitern; zu `HookConsumerWidget` greifen Sie nur in den konkreten Dateien, die auch hooks aufrufen.

Die offizielle Dokumentation ist dazu für Einsteiger deutlich: Wenn Sie neu bei Riverpod sind, beginnen Sie nicht mit hooks. Sie fügen ein zweites mentales Modell zu einem bereits ungewohnten hinzu. Lernen Sie zuerst `flutter_riverpod` und übernehmen Sie `hooks_riverpod` später nur, wenn Sie feststellen, dass Sie hooks für lokalen State möchten. Wenn Sie heute Controller von Hand verwalten, ist die Freigabedisziplin in [Flutter-Controller freigeben, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) genau der Boilerplate, den hooks entfernen sollen, was das ehrliche Argument für ihre Übernahme ist.

## Ersetzt das Annotationspaket das Runtime-Paket?

Eine häufige Anschlussfrage: Wenn ich `riverpod_annotation` für den `@riverpod`-Codegen hinzufüge, brauche ich dann noch `flutter_riverpod`? Ja. Das Annotationspaket liefert nur den Marker `@riverpod` und die Typen, gegen die der Generator erzeugt. Es enthält keine Runtime: kein `ProviderScope`, kein `Notifier`, kein `ref`. Ihre App läuft weiterhin auf einem der drei Runtime-Pakete, und der generierte Code importiert daraus. Eine Codegen-Flutter-App hängt also von beiden ab, `flutter_riverpod` (Runtime) und `riverpod_annotation` (Annotationen), nicht von dem einen anstelle des anderen.

Dieselbe Regel "ein Runtime-Paket" gilt in Tests. Ein Widget-Test, der ein `ProviderScope` pumpt, nutzt `flutter_riverpod` (über `flutter_test`), während ein reiner Dart-Unittest, der einen `ProviderContainer` hochfährt, das einfache `riverpod` nutzt. Sie fügen kein separates Testpaket für Riverpod hinzu; der `ProviderContainer` und die `overrides`, die Sie für Tests brauchen, sind bereits im installierten Runtime-Paket enthalten.

## Der Haken, der wirklich Leute stolpern lässt: die Codegen-Pakete werden anders versioniert

Hier ist der Teil, der selbst erfahrene Riverpod-Nutzer in der 3.x-Ära überrascht. Die Runtime-Pakete (`riverpod`, `flutter_riverpod`, `hooks_riverpod`) liegen auf der 3.3.x-Linie, aber die Codegenerierungs-Pakete liegen auf einer völlig anderen Hauptversion:

| Paket | Rolle | Version (2026-07) |
| --- | --- | --- |
| `flutter_riverpod` | runtime | 3.3.2 |
| `hooks_riverpod` | runtime | 3.3.2 |
| `riverpod` | runtime | 3.3.2 |
| `riverpod_annotation` | Codegen-Annotationen | 4.0.3 |
| `riverpod_generator` | Codegen (dev) | 4.0.4 |
| `riverpod_lint` | Lint-Regeln (dev) | 3.x |

Wenn Sie die Annotation `@riverpod` nutzen, um Provider zu generieren, installieren Sie vier Pakete, nicht eines. `riverpod_annotation` ist eine normale Abhängigkeit; `riverpod_generator` und `build_runner` sind Entwicklungsabhängigkeiten:

```bash
# Flutter 3.44, Riverpod 3.x
flutter pub add flutter_riverpod riverpod_annotation
flutter pub add dev:riverpod_generator dev:build_runner
flutter pub add dev:custom_lint dev:riverpod_lint   # optional, for lint rules
```

Dann generieren Sie mit:

```bash
# runs the generator once, or use `watch` to keep it running
dart run build_runner watch -d
```

Versuchen Sie nicht, `riverpod_annotation` auf `^3.0.0` festzupinnen, um es an die Runtime anzugleichen. Die 4.x-Annotationslinie ist die, die zur 3.3.x-Runtime passt; die Versionsnummern sind bewusst entkoppelt, weil sich der Generator in eigenem Takt weiterentwickelt. Lassen Sie `flutter pub add` die Einschränkungen auflösen und bearbeiten Sie sie nicht von Hand, um sie "in Reihe zu bringen", denn sie sollen nicht in Reihe sein. Dies ist der häufigste `pub get`-Fehler in einem frisch angelegten Riverpod-3-Projekt.

Die Codegenerierung ist optional. Alles in diesem Artikel funktioniert ohne sie. Der Annotationsansatz erspart Ihnen hauptsächlich, den Provider-Typ-Boilerplate (`NotifierProvider<Counter, int>`) von Hand zu schreiben, und er ist ein guter Standard für neue Projekte, aber es ist eine separate Entscheidung davon, welches Runtime-Paket Sie installieren.

## Was Sie tatsächlich tippen

Nimmt man die Erklärung weg, ist die Entscheidung kurz:

- Sie bauen eine Flutter-App, keine hooks: `flutter pub add flutter_riverpod`. Das sind Sie, in 90 % der Fälle.
- Reines Dart, kein Flutter: `dart pub add riverpod`.
- Flutter-App, die bereits `flutter_hooks` nutzt: `flutter pub add hooks_riverpod flutter_hooks`.
- Nutzung der Annotation `@riverpod` auf einem der obigen: fügen Sie `riverpod_annotation` sowie die Entwicklungsabhängigkeiten `riverpod_generator` und `build_runner` hinzu und lassen Sie den Resolver die 4.x-Linie wählen.

Welches Runtime-Paket Sie auch wählen, die Provider, die `Notifier`-API und `AsyncValue` verhalten sich identisch, weil sie alle aus demselben zentralen Motor stammen. Sie wählen nur, wie viel Flutter-Klebstoff und hook-Unterstützung Sie obendrauf schichten. Ist das geklärt, liegt das eigentliche Lernen in der API selbst: wie [Riverpods AsyncValue im Vergleich zu FutureBuilder und StreamBuilder abschneidet](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/), wie man [ref.mounted nach einer async-Lücke prüft](/de/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/), und wie das neue [automatische Provider-Retry in 3.0](/de/2026/07/how-to-disable-riverpod-3-0-automatic-provider-retry/) die Fehlerbehandlung verändert. Wenn Sie noch entscheiden, ob Sie Riverpod überhaupt nutzen, trifft der [Vergleich Provider vs Riverpod vs Bloc](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) diese Entscheidung; wenn Sie von der alten Linie wegwechseln, deckt der [Migrationsleitfaden von Riverpod 2.x zu 3.0](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) die Breaking Changes ab.

## Quellen

- [Riverpod: Getting started](https://riverpod.dev/docs/introduction/getting_started) -- offizielle Installationsbefehle für `riverpod`, `flutter_riverpod`, `hooks_riverpod` und die Codegen-Pakete.
- [Riverpod: About hooks](https://riverpod.dev/docs/concepts/about_hooks) -- die Beziehung zwischen `flutter_hooks`, `flutter_riverpod` und `HookConsumerWidget` sowie der Rat für Einsteiger.
- [riverpod_generator changelog](https://pub.dev/packages/riverpod_generator/changelog) -- bestätigt die 4.x-Codegen-Linie gepaart mit der 3.3.x-Runtime.
- [flutter_hooks auf pub.dev](https://pub.dev/packages/flutter_hooks) -- das eigenständige hooks-Paket, mit dem sich `hooks_riverpod` integriert.

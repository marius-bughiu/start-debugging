---
title: "Dart Records vs Freezed-Klassen: Was sollten Sie 2026 wählen?"
description: "Wählen Sie Dart-3.12-Records für kurzlebige, lokal geformte Daten ohne Methoden und Freezed-3.x-Klassen für benannte Domänenmodelle, die copyWith, versiegelte Unions, JSON-Serialisierung oder irgendein Verhalten benötigen."
pubDate: 2026-05-27
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "freezed"
  - "records"
lang: "de"
translationOf: "2026/05/dart-records-vs-freezed-classes"
translatedBy: "claude"
translationDate: 2026-05-27
---

In Dart 3.12 (der Version, die mit Flutter 3.44 auf der Google I/O 2026 erschienen ist) lösen Records und Freezed beide das Problem "Ich brauche einen unveränderlichen Werttyp mit strukturbasierter Gleichheit", aber sie tun das aus entgegengesetzten Richtungen. Records sind ein eingebauter, anonymer, struktureller Typ ohne Code-Generierung. Freezed 3.x ist ein codegenerierter, nominaler Typ mit `copyWith`, versiegelten Unions, JSON-Serialisierung und dem Rest des Datenklassen-Werkzeugkastens. Die kurze Antwort: Nutzen Sie einen Record, wenn die Daten eine lokale, kurzlebige Form sind, die weder einen Namen noch eine Methode braucht, und nutzen Sie Freezed für jede Klasse, die Teil Ihres Domänenmodells, Ihres State-Baums oder Ihres API-Drahtformats ist.

Dieser Beitrag behandelt Dart-3.12-Records (stabil seit Dart 3.0 im Mai 2023, mit der Kurzschreibweise für benannte Felder in 3.7 und privaten benannten Feldern in 3.12) sowie Freezed 3.x auf `build_runner` 2.4 (Freezed 3.0 erschien im März 2025 mit kleinerer generierter Ausgabe und einem Standard `@Freezed(toJson: false)` für Unions). Beide zielen auf dieselbe Basis aus Flutter 3.44 und Dart 3.12. Die Entscheidung lautet nicht "Records sind neu, Freezed ist alt", denn beide werden aktiv gepflegt und beide haben ihren Platz in einer Flutter-App von 2026. Die Entscheidung dreht sich darum, wofür der Typ gedacht ist.

## Was beides tatsächlich ist

Ein **Dart-Record** ist ein eingebauter, unveränderlicher, anonymer Aggregat-Typ. Der Typ `(int, String)` ist ein Record mit zwei positionalen Feldern. Der Typ `({int id, String name})` ist ein Record mit zwei benannten Feldern. Records sind strukturell: Zwei Records mit derselben Feldform sind derselbe Typ, auch wenn sie in unterschiedlichen Dateien deklariert wurden. Der Compiler erzeugt `==`, `hashCode` und `toString` automatisch. Sie können keine Methoden hinzufügen. Sie können kein Verhalten anhängen. Sie können einem Record keinen Namen auf Klassenebene geben (Sie können `typedef User = ({int id, String name});` schreiben, aber das typedef ist nur ein Alias für den strukturellen Typ, kein neuer nominaler Typ).

Eine **Freezed-3.x-Klasse** ist eine echte Dart-Klasse mit einem generierten Mixin. Sie schreiben eine normale Klasse mit einem `factory`-Konstruktor, der die Felder auflistet, führen `dart run build_runner build` aus, und Freezed generiert `==`, `hashCode`, `toString`, `copyWith`, optional `fromJson` und `toJson`, sowie (für versiegelte Unions) die Mustervergleichshelfer `when` und `map`. Die Klasse ist nominal: `User` und `Customer` mit denselben Feldern sind nicht austauschbar. Sie können Methoden, berechnete Getter und Factory-Konstruktoren hinzufügen. Sie können die Klasse als `sealed` markieren und mehrere Union-Fälle deklarieren, über die erschöpfend per Pattern-Matching verzweigt werden kann.

Die beiden sind keine direkten Ersatzkandidaten füreinander. Sie überschneiden sich im Fall "In etwas tupelartiges destrukturieren" und divergieren überall sonst.

## Die Feature-Matrix

| Funktion                                | Dart-3.12-Record                     | Freezed-3.x-Klasse                      |
| --------------------------------------- | ------------------------------------ | --------------------------------------- |
| Deklarationskosten                      | inline, ohne Datei                   | Klasse + factory + part-Direktive + build_runner |
| Code-Generierung                        | keine                                | ja (`*.freezed.dart` + optional `*.g.dart`) |
| Typidentität                            | strukturell                          | nominal                                 |
| Benannter Typ                           | nur per `typedef`                    | ja, vollständige Klasse                 |
| Feldnamen in IDE / Fehlern              | nur wenn als benannt deklariert      | immer (der Klassenname erscheint)       |
| `==` und `hashCode`                     | automatisch, wertbasiert             | automatisch, wertbasiert                |
| `toString`                              | automatisch (`(1, name: 'a')`)       | automatisch (`User(id: 1, name: 'a')`)  |
| `copyWith`                              | nein                                 | ja, inkl. tiefem `copyWith.field(...)`  |
| `fromJson` / `toJson`                   | nein (manuell)                       | ja über `json_serializable`             |
| Versiegelte Union / Summentyp           | nein                                 | ja (`sealed class` + mehrere factories) |
| Eigene Methoden oder Getter             | nein                                 | ja (privater Konstruktor + Methoden)    |
| Standardwerte für Felder                | nein (müssen bei jedem Aufruf gesetzt werden) | ja (Default-Werte in der factory)  |
| Assertions / Validierung                | nein                                 | ja (im factory-Body oder `@Assert`)     |
| Vererbung                               | nein                                 | ja nur über versiegelte Unions          |
| Mustervergleich                         | ja (positional und benannt)          | ja über generiertes `when` / Pattern-Matching auf dem sealed |
| Build- / IDE-Kosten                     | null                                 | `build_runner watch` läuft, generierte Dateien im Baum |
| Stabilität der öffentlichen API         | Feldumbenennung ist ein Breaking Change, weil sich die Form ändert | Feldumbenennung ist derselbe Breaking Change, aber der Klassenname ankert den Typ |
| Speicherbedarf                          | eine Allokation, keine v-Table über Object hinaus | eine Allokation, generierte Mixin-Methoden |

Die drei Zeilen, die die meisten Fälle entscheiden: Deklarationskosten, benannter vs. struktureller Typ und ob Sie `copyWith` oder JSON brauchen. Brauchen Sie keines davon, gewinnt der Record beim Gewicht. Brauchen Sie auch nur eines davon, gewinnt Freezed bei der Ergonomie.

## Wann ein Dart-Record sinnvoll ist

Wählen Sie einen Record, wenn:

- **Sie zwei oder mehr Werte aus einer einzigen Methode zurückgeben.** Das ist der ursprünglich motivierende Anwendungsfall aus Dart 3.0 und bleibt der stärkste. Ein Record schlägt einen Out-Parameter, eine zweielementige Liste oder eine winzige Hilfsklasse. Die Aufrufstelle destrukturiert mit einem Pattern.

  ```dart
  // Dart 3.12, Flutter 3.44
  (int rowsAffected, Duration elapsed) executeBatch(List<Update> updates) {
    final stopwatch = Stopwatch()..start();
    final n = _runBatch(updates);
    stopwatch.stop();
    return (n, stopwatch.elapsed);
  }

  // Caller
  final (rows, elapsed) = executeBatch(updates);
  print('Updated $rows rows in $elapsed');
  ```

  Eine Freezed-Klasse wären hier drei Dateien (`batch_result.dart`, `batch_result.freezed.dart`, optional `batch_result.g.dart`) für einen Wert, der eine Zeile lang lebt.

- **Die Form ist lokal in einer Funktion oder einem Widget.** Ein `_HitTestResult`, das zehn Zeilen lang in Layout-Berechnungen existiert, sollte ein Record sein, keine Klasse. Sobald die Form die Datei verlässt, ist das das Signal, dass sie zu einer Freezed-Klasse heranwachsen sollte.

- **Sie machen Mustervergleich auf der Form der zurückgegebenen Daten.** Switch-Ausdrücke über Records sind die Art, wie Dart 3 von Ihnen erwartet, Parser-Ergebnisse, Validator-Ergebnisse oder allgemein "Tag plus Payload"-Rückgaben zu behandeln, bei denen das Payload eine aus einer Handvoll Formen ist und nur an der Aufrufstelle lebt.

  ```dart
  // Dart 3.12
  sealed class ParseTag {}
  final ok = ParseTag(); // marker only - real code uses sealed subclasses

  ({bool ok, String? error, Map<String, dynamic>? data}) tryParse(String s) {
    try {
      return (ok: true, error: null, data: jsonDecode(s) as Map<String, dynamic>);
    } catch (e) {
      return (ok: false, error: e.toString(), data: null);
    }
  }

  final result = tryParse(input);
  switch (result) {
    case (ok: true, data: final m?, error: _):
      handle(m);
    case (ok: false, error: final msg?, data: _):
      reportError(msg);
    default:
      reportError('unknown parse failure');
  }
  ```

  Für ein reines Fehler-oder-Payload-Ergebnis, das zwei Stack-Frames nach oben fließt, ist ein Record sauberer als das Einführen einer versiegelten `Result<T>`-Freezed-Union. In dem Moment, in dem drei verschiedene Aufrufstellen über dieselbe Form schalten, sollten Sie sie zu einem benannten Typ befördern.

- **Sie wollen für diesen Teil der Codebasis null `build_runner`-Kosten.** Records bringen keine Code-Generierung, keine part-Direktiven, keinen Watch-Prozess mit. In einem Flutter-Paket oder einer reinen Dart-Bibliothek, in der Sie ohne Generator-Schritt ausliefern wollen, sind Records die einzige Option für einen unveränderlichen Werttyp neben einer handgeschriebenen Klasse.

- **Die Anzahl der Felder ist klein und die Feldtypen sind aus dem Kontext offensichtlich.** Zwei oder drei Felder, deren Bedeutung an der Aufrufstelle klar ist. Sobald Sie fünf Felder haben und die Aufrufstelle IntelliSense braucht, um sich zu erinnern, wofür jedes einzelne ist, sind Sie aus einem Record herausgewachsen und brauchen eine benannte Klasse.

## Wann eine Freezed-3.x-Klasse sinnvoll ist

Wählen Sie Freezed, wenn:

- **Der Typ ein Domänenmodell, ein API-DTO oder ein Stück App-State ist.** Alles, was eine Schichtgrenze überquert, geloggt, serialisiert wird oder in Stack Traces auftaucht, profitiert davon, einen echten Klassennamen zu haben. `User`, `Order`, `LineItem`, `AppState`, `AuthState`. Diese Typen verdienen nominale Identität, ein `toString`, das den Klassennamen ausgibt, und eine Debug-Erfahrung, in der die IDE `User { id, email, createdAt }` zeigt und nicht `({int id, String email, DateTime createdAt})`.

  ```dart
  // Dart 3.12, Flutter 3.44, freezed 3.x, json_serializable 6.x
  import 'package:freezed_annotation/freezed_annotation.dart';

  part 'user.freezed.dart';
  part 'user.g.dart';

  @freezed
  class User with _$User {
    const User._();

    const factory User({
      required int id,
      required String email,
      DateTime? createdAt,
      @Default(false) bool emailVerified,
    }) = _User;

    factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);

    bool get isVerified => emailVerified && email.contains('@');
  }
  ```

  Führen Sie `dart run build_runner build --delete-conflicting-outputs` aus und Sie erhalten `==`, `hashCode`, `toString`, `copyWith`, `fromJson`, `toJson` und den Getter `isVerified`, alles in einer Klasse.

- **Sie `copyWith` für State-Unveränderlichkeit brauchen.** Das ist der häufigste Grund, warum Flutter-Projekte Freezed wählen. Riverpod, Bloc und jede Reducer-artige State-Verwaltung stützen sich auf `state = state.copyWith(loading: true)`. Records haben kein `copyWith`. Sie können eines von Hand schreiben, verlieren dann aber den Sinn, warum Sie überhaupt einen Record verwendet haben.

- **Sie versiegelte Unions für State- oder Ergebnistypen brauchen.** Ein `LoadingState` mit den Fällen `Initial`, `Loading`, `Success(data)`, `Failure(error)` ist die kanonische versiegelte Freezed-Klasse. Mustervergleich ist in Dart 3 erschöpfend, der Compiler warnt, wenn Sie einen Fall hinzufügen und ein `switch` vergessen, und `copyWith` funktioniert pro Fall.

  ```dart
  // freezed 3.x
  @freezed
  sealed class AuthState with _$AuthState {
    const factory AuthState.signedOut() = AuthSignedOut;
    const factory AuthState.signingIn() = AuthSigningIn;
    const factory AuthState.signedIn(User user) = AuthSignedIn;
    const factory AuthState.failed(String reason) = AuthFailed;
  }

  // Pattern match
  Widget build(BuildContext context, AuthState state) => switch (state) {
        AuthSignedOut() => const LoginPage(),
        AuthSigningIn() => const Spinner(),
        AuthSignedIn(:final user) => HomePage(user: user),
        AuthFailed(:final reason) => ErrorPage(reason: reason),
      };
  ```

  Das lässt sich mit einem Record nicht modellieren. Records sind anonym; versiegelte Vererbung erfordert benannte Typen.

- **Sie JSON-Serialisierung brauchen.** Freezed integriert sich mit `json_serializable`, sodass Sie `User.fromJson` und `user.toJson()` kostenlos bekommen. Ein Record hat keine eingebaute JSON-Unterstützung; Sie schreiben die Konvertierung jedes Mal von Hand.

- **Die Klasse Validierung, Standardwerte oder Methoden braucht.** Ein factory-Body kann Invarianten zusichern. `@Default(0)` setzt einen Standardwert. Ein privater Konstruktor (`const User._();`) plus reguläre Methoden oder Getter erlaubt der Klasse, Verhalten zu tragen. Records können das alles nicht.

- **Sie möchten, dass die Feldnamen in IDEs und Crash-Logs auftauchen.** Ein Record gibt sich aus als `(1, 'a@b.com', 2026-05-27 00:00:00.000)`. Eine Freezed-Klasse gibt sich aus als `User(id: 1, email: a@b.com, createdAt: 2026-05-27 00:00:00.000, emailVerified: false)`. In einem Stack Trace ist die zweite Ausgabe den Codegen-Schritt wert.

## Das Benchmark: Instanziierungskosten, Gleichheit und Build-Zeit

Die Zahlen unten stammen aus einem Flutter-3.44-Release-Build, Dart 3.12 AOT, auf einem Pixel 8 mit derselben fünfteiligen Feldform (`int`, `String`, `DateTime`, `bool`, `String?`). Gleichheit und Hash laufen innerhalb des `BenchmarkRunner` für 1.000.000 Iterationen.

| Metrik                                   | Dart-3.12-Record    | Freezed-3.x-Klasse |
| ---------------------------------------- | ------------------- | ------------------ |
| Allokation, ns / op                      | 18                  | 24                 |
| `==`, ns / op                            | 11                  | 14                 |
| `hashCode`, ns / op                      | 9                   | 12                 |
| `copyWith`, ns / op                      | n/a (keine API)     | 31                 |
| Build-Kosten (kalter `build_runner build`) | 0 ms              | 4,1 s für 50 Klassen |
| Generierte Bytes pro Klasse              | 0                   | ~2 KB              |
| Auswirkung auf Hot-Reload-Latenz         | keine               | keine (Freezed kommt in 3.x gut mit Hot Reload zurecht) |

Der Laufzeitabstand ist klein genug, um für Anwendungscode nicht ins Gewicht zu fallen. Der Build-Zeit-Abstand ist die einzige Zahl, die den Alltag beeinflusst: In einem Projekt mit 200 Freezed-Klassen dauert ein kalter `build_runner build` etwa 15 bis 25 Sekunden, und `build_runner watch` baut inkrementell in unter einer Sekunde pro berührter Datei neu. Wenn Sie schon einmal eine Flutter-App mit `json_serializable` ausgeliefert haben, ist das dasselbe Kostenprofil.

Der eigentliche "Performance"-Unterschied zwischen den beiden sind nicht Nanosekunden. Es ist der mentale Overhead an der Aufrufstelle. Ein Record hat keine Klassendatei, keine part-Direktive, keine generierte Datei in Versionskontroll-Diffs. Eine Freezed-Klasse hat alle drei, plus den Build-Schritt, der laufen muss, bevor Ihre IDE aufhört, rote Schlangenlinien zu malen.

## Der Knackpunkt, der für Sie entscheidet

Einige Randbedingungen entscheiden für Sie, unabhängig von Vorlieben:

1. **JSON über eine Netzwerkgrenze hinweg erzwingt Freezed.** Records haben kein `fromJson` und kein `toJson`. Sie können einen manuellen Konverter schreiben, aber für jede Klasse, die wegen einer Backend-Antwort existiert, ist Freezed plus `json_serializable` der reibungsärmste Weg. Wenn Sie versuchen würden, Records für DTOs zu behalten, würden Sie die Hälfte von `json_serializable` von Hand neu erfinden.

2. **State-Verwaltung mit `copyWith` erzwingt Freezed.** Reducer in Riverpod und Bloc werden um `state = state.copyWith(loading: true)` herum geschrieben. Records können das nicht ohne eine handgeschriebene Extension, die den Sinn untergräbt, überhaupt einen Record zu verwenden. Wenn Sie von GetX zu Riverpod migrieren (der kanonische Modernisierungspfad 2026, den der [Migrationsleitfaden von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) behandelt), sollten Ihre State-Klassen Freezed sein.

3. **Versiegelte Unions mit Payload erzwingen Freezed.** Records können nicht "einen aus diesen drei benannten Fällen, jeder mit eigenem Payload" modellieren. Versiegelte Klassen in Dart 3 können das, aber Sie brauchen weiterhin benannte Subklassen, und genau die Reibung, jede einzelne von Hand zu schreiben, nimmt Ihnen Freezed ab.

4. **Ein Typ, der die Datei verlässt, erzwingt einen Namen.** Wenn jemand anderes im Team den Typ importieren muss, geben Sie ihm einen Namen. Records sind innerhalb einer Funktion nützlich und in einer einzigen Datei akzeptabel. Sobald eine andere Datei ihn per `typedef` importiert, rechnet sich das typedef nur, weil der zugrundeliegende Typ anonym ist. An dem Punkt schreiben Sie die Klasse.

5. **Ein Typ mit ein oder zwei Feldern und null Verhalten, der nur eine Anweisung lang lebt, erzwingt einen Record.** Ein Paar doubles, das eine Hit-Test-Routine zurückgibt. Ein `(width, height)` aus einem Layout-Helfer. Ein `(success, errorOrNull)` aus einer try-artigen Funktion. Eine Freezed-Klasse dafür zu schreiben ist Bürokratie.

Eine praktische Heuristik: Wenn die Feldnamen in Ihrem `print`-Debugging oder in Ihren Crash-Logs auftauchen, wollen Sie eine Freezed-Klasse. Wenn der Wert nie eine einzige Funktion verlässt und nie geloggt wird, ist ein Record die richtige Wahl.

## Empfehlung in Kurzform

Für eine Flutter-3.44- / Dart-3.12-Codebasis im Jahr 2026:

- **Lokale, kurzlebige, anonyme Form, kein Verhalten, kein JSON**: nehmen Sie einen **Record**. Mehrfachrückgaben, destrukturierte Tupel, Pattern-Matching-Formen innerhalb einer einzigen Funktion.
- **Benannt, verlässt eine Datei, braucht `copyWith` / JSON / versiegelte Union / Methoden**: nehmen Sie eine **Freezed-3.x-Klasse**. Domänenmodelle, State-Klassen, API-DTOs, alles, was in einem Stack Trace landet.

In einer realen App existieren beide nebeneinander. Die Records sitzen in Funktionen und Widget-Dateien; die Freezed-Klassen sitzen in `models/` und `state/`. Der Fehler besteht darin, das eine für die Aufgabe des anderen zu verwenden: Eine Freezed-Klasse für einen zweifeldigen Rückgabewert ist überengineering, und ein Record-typedef für ein `User`-Modell ist unterengineering.

Wenn Sie eine Codebasis voller `equatable`-basierter Modelle geerbt haben, ist der Modernisierungspfad 2026, sie nach Freezed 3.x zu überführen, nicht zu Records, aus genau demselben Grund: Diese Klassen haben Namen, verlassen Dateien und brauchen `copyWith`. Records sind ein neues Werkzeug, kein Ersatz.

## Verwandt

- [Flutter vs React Native vs .NET MAUI für ein neues Mobile-Projekt 2026](/de/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) für die Framework-Entscheidung eine Ebene über dieser Wahl.
- [Dart 3.12 verzichtet auf die Initialisierungsliste für private Felder](/de/2026/05/dart-3-12-private-named-parameters-initializing-formals/) für die Sprachänderung, die mit der Deklaration von Freezed-Factory-Parametern 2026 zusammenspielt.
- [Wie Sie eine Flutter-App von GetX zu Riverpod migrieren](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) für die State-Modernisierung, in der Freezed die kanonische State-Klasse ist.
- [Wie Sie ein Dart-Isolate für CPU-gebundene Arbeit schreiben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) für den Fall, dass Records eine Isolate-Grenze überqueren und Sie überlegen müssen, was serialisiert.
- [Wie Sie Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) für den Performance-Workflow, wenn die Allokation einer State-Klasse tatsächlich in der Zeitleiste erscheint.

## Quellen

- [Dart-Sprachtour zu Records](https://dart.dev/language/records), Dart-Dokumentation, abgerufen 2026-05-27.
- [Ankündigung von Dart 3.0](https://medium.com/dartlang/announcing-dart-3-0-79bff52e1bb6), Dart-Team, Mai 2023.
- [Freezed-Paket auf pub.dev](https://pub.dev/packages/freezed), Remi Rousselet.
- [json_serializable-Paket](https://pub.dev/packages/json_serializable), Dart-Team.
- [Flutter-3.44-Release-Notes](https://docs.flutter.dev/release/release-notes), Flutter-Dokumentation, abgerufen 2026-05-27.

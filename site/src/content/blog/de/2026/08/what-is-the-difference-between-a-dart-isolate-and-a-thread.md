---
title: "Was ist der Unterschied zwischen einem Dart-Isolate und einem Thread?"
description: "Ein Thread teilt sich den Speicher mit jedem anderen Thread im Prozess. Ein Dart-Isolate nicht: Es besitzt seinen eigenen Heap, führt eine einzige Event Loop aus und spricht mit anderen Isolates nur über Nachrichten. Was das auf VM-Ebene bedeutet, wo Isolate Groups die Grenze verwischen und wie sich das in Flutter, FFI und im Web auswirkt."
pubDate: 2026-08-29
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "threading"
lang: "de"
translationOf: "2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread"
translatedBy: "claude"
translationDate: 2026-08-29
---

Ein Thread ist ein Ausführungskontext, der sich den Prozess-Heap mit jedem anderen Thread teilt, und genau deshalb benötigt Thread-Code Locks, Atomics und Speicherbarrieren. Ein Dart-Isolate ist ein Ausführungskontext, der seinen eigenen Speicher besitzt und eine einzige Event Loop ausführt, und der einzige Weg zu einem anderen Isolate führt über eine Nachricht durch einen Port. Die praktische Folge: Dart hat kein `lock`-Schlüsselwort, kein `volatile` und keine Data Races auf Dart-Objekten, und der Preis dafür ist, dass alles, was Sie einem anderen Isolate übergeben, kopiert wird, sofern Sie nicht einen von zwei Auswegen nutzen. Isolates laufen tatsächlich auf echten Betriebssystem-Threads aus einem Pool, den die VM verwaltet, aber die Zuordnung ist nicht eins zu eins, und Sie programmieren nie dagegen. Alles Folgende bezieht sich auf Dart 3.12.2 und Flutter 3.44.7.

Wenn Sie hier sind, weil eine Berechnung Ihre UI einfriert und Sie den Code suchen, der das behebt: Die Mechanik steht im Leitfaden zum [Schreiben eines Dart-Isolates für CPU-gebundene Arbeit](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/). Dieser Beitrag behandelt das Modell darunter, denn die meisten Isolate-Fehler sind in Wahrheit ein falsches mentales Modell davon, was ein Isolate ist.

## Das Modell: ein Heap und eine Event Loop pro Isolate

Die Dokumentation der Sprache Dart fasst es in einem Satz zusammen: "Isolates sind wie Threads oder Prozesse, aber jedes Isolate hat seinen eigenen Speicher und einen einzigen Thread, der eine Event Loop ausführt." Darin stecken zwei Aussagen, und beide sind wichtig.

Eigener Speicher bedeutet, dass jedes Isolate seine eigene Kopie jedes globalen und statischen Feldes hat. Ein `int requestCount = 0` auf oberster Ebene ist nicht eine Variable in Ihrem Programm, sondern eine Variable pro Isolate. Sie in einem Worker zu verändern lässt die Kopie des Haupt-Isolates unberührt, denn, so die Dokumentation: "Jedes Isolate hat seine eigenen globalen Felder, wodurch sichergestellt ist, dass kein Zustand eines Isolates von einem anderen Isolate aus erreichbar ist."

Eine Event Loop bedeutet, dass ein Isolate Ereignisse einzeln verarbeitet, dauerhaft, in einer Schleife, die konzeptionell so aussieht:

```dart
// The Dart event loop, conceptually. Dart 3.12.
while (eventQueue.waitForEvent()) {
  eventQueue.processNextEvent();
}
```

Nichts unterbricht ein Ereignis, sobald es begonnen hat. Ein Callback, der 90 ms mit dem Parsen von JSON verbringt, hält die Loop 90 ms lang, und jeder Timer, jedes abgeschlossene Future und in Flutter jeder Frame wartet dahinter. Das ist das Gegenteil eines Threads, den der Scheduler des Betriebssystems mitten in einer Instruktion anhalten kann, damit ein anderer Thread läuft.

Zusammengenommen ergibt das das Aktorenmodell: isolierter Zustand, sequenzielle Verarbeitung, Nachrichtenaustausch. Die Dokumentation formuliert es so: "Kein geteilter Zustand zwischen Isolates bedeutet, dass Nebenläufigkeitsprobleme wie Mutexe, Locks und Data Races nicht auftreten."

## Die Race Condition, die Sie in Dart nicht schreiben können

Das ist der klarste Weg, den Unterschied zu spüren. In C# ist Folgendes eine echte Race Condition, und die Korrektur erfordert `Interlocked` oder ein Lock:

```csharp
// C# 14, .NET 11. Two threads, one heap, one bug.
static int _counter;

var t1 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
var t2 = new Thread(() => { for (var i = 0; i < 100_000; i++) _counter++; });
t1.Start(); t2.Start(); t1.Join(); t2.Join();
Console.WriteLine(_counter); // Not 200000. Ever, reliably.
```

Die Dart-Übersetzung hat keine Race Condition, und sie tut auch nicht das, was Neulinge erwarten:

```dart
// Dart 3.12.
import 'dart:isolate';

int counter = 0; // one copy per isolate, not one per program

void bump(int times) {
  for (var i = 0; i < times; i++) {
    counter++;
  }
}

Future<void> main() async {
  await Future.wait([
    Isolate.run(() { bump(100000); return counter; }),
    Isolate.run(() { bump(100000); return counter; }),
  ]);
  print(counter); // 0
}
```

Jedes gestartete Isolate erhöht seinen eigenen `counter` auf 100000 und stirbt dann damit. Das Haupt-Isolate gibt `0` aus. Es gibt keinen zerrissenen Lesezugriff zu suchen und kein Lock hinzuzufügen, weil es nie eine einzelne Variable gab, um die konkurriert wurde. Jeder Wert, der zurückkommen soll, muss als Nachricht zurückkommen, und genau das ist der Rückgabewert von `Isolate.run`.

## Was ein Isolate tatsächlich ausführt: der Thread-Pool der VM

Isolates schweben nicht frei. Die Dart-VM führt sie auf Betriebssystem-Threads aus, und die Regeln dieser Beziehung sind im Text zu den Interna der Dart-VM von Vyacheslav Egorov dokumentiert.

Ein Betriebssystem-Thread "kann jeweils nur ein Isolate betreten. Er muss das aktuelle Isolate verlassen, wenn er ein anderes betreten will." Und in der Gegenrichtung: "Es kann immer nur ein einziger Mutator-Thread mit einem Isolate verbunden sein. Der Mutator-Thread ist der Thread, der Dart-Code ausführt und die öffentliche C-API der VM nutzt."

Die Invariante lautet also: jeweils eins in beide Richtungen, nicht eins zu eins auf Dauer. Verschiedene Betriebssystem-Threads können dasselbe Isolate zu verschiedenen Zeitpunkten ausführen, und ein Thread kann im Lauf seines Lebens mehrere Isolates bedienen. Die VM widmet einem Isolate keinen Thread so, wie `new Thread()` einem Delegate einen widmet: "Intern nutzt die VM einen Thread-Pool zur Verwaltung der Betriebssystem-Threads, und der Code ist um das Konzept ThreadPool::Task herum strukturiert statt um das Konzept eines Betriebssystem-Threads." Hintergrundarbeit wie Garbage Collection und JIT-Kompilierung wird als Task in diesen Pool eingestellt.

Für Ihren Code heißt das: Isolates sind die Einheit, über die Sie nachdenken, Threads sind ein Implementierungsdetail darunter. Sie können ein Isolate nicht an einen Kern binden, Sie können ein Isolate nicht an eine native API übergeben, die ein Thread-Handle erwartet, und Sie sollten nicht annehmen, dass die Betriebssystem-Thread-Identität Ihres Isolates über Unterbrechungspunkte hinweg stabil bleibt.

## Isolate Groups: der geteilte Heap, den die Sprache vor Ihnen verbirgt

Hier hört "jedes Isolate hat seinen eigenen Speicher" auf, auf Implementierungsebene wörtlich zu stimmen, und das ist wissenswert, weil es die Performancezahlen erklärt.

Seit Dart 2.15 organisiert die VM Isolates in Isolate Groups. `Isolate.spawn` und `Isolate.run` erzeugen das neue Isolate innerhalb der aktuellen Gruppe; nur `Isolate.spawnUri` startet eine frische Gruppe mit einer frischen Kopie des Programms. Innerhalb einer Gruppe teilt die VM die Programmstrukturen, und wie der Text zu den VM-Interna sagt, teilen sich Isolates einer Gruppe "denselben vom Garbage Collector verwalteten Heap".

Die Ankündigung zu Dart 2.15 beziffert den Gewinn: Ein zusätzliches Isolate in einer bestehenden Gruppe zu starten ist "mehr als 100-mal schneller", und diese Isolates "verbrauchen zwischen 10- und 100-mal weniger Speicher" als vor Einführung der Gruppen. Deshalb ist `spawnUri` der langsame Weg und `spawn` der, zu dem Sie greifen.

Die Garantie auf Sprachebene bleibt unverändert. Sie erreichen die Objekte eines anderen Isolates weiterhin nicht, die Isolation wird oberhalb des Heaps durchgesetzt, und der geteilte Heap ist ein Implementierungsdetail. Aber er ist der Grund, warum zwei weitere Dinge möglich sind.

## Kopieren ist der Preis, und es gibt zwei Auswege

Standardmäßig kopiert das Senden eines Objekts über einen `SendPort` dessen gesamten Objektgraphen. Senden Sie eine `Map` mit 50000 Einträgen, erhält das empfangende Isolate eine tiefe Kopie, und Änderungen dort sind für den Sender unsichtbar. Die meisten Dart-Objekte lassen sich senden. Die dokumentierten Ausnahmen sind Objekte mit nativen Ressourcen wie `Socket`, dazu `ReceivePort`, `DynamicLibrary`, `Finalizable`, `Finalizer`, `NativeFinalizer`, `Pointer`, `UserTag` und alles, was mit `@pragma('vm:isolate-unsendable')` annotiert ist. Abgesehen davon gilt laut Dokumentation: "Jedes Objekt kann gesendet werden."

Der erste Ausweg ist `Isolate.exit`. Es "beendet das aktuelle Isolate synchron" und übergibt eine letzte Nachricht, und da Sender und Empfänger in derselben Gruppe und damit auf demselben Heap liegen, "wird dieser Objektgraph der letzten Nachricht dem empfangenden Isolate ohne Kopieren zugewiesen". Keine Kopie, um den Preis, dass das Isolate genau dort endet: ausstehende `finally`-Blöcke laufen nicht mehr, und eingereihte asynchrone Arbeit läuft nie.

Meist bekommen Sie das geschenkt. `Isolate.run`, hinzugefügt in Dart 2.19, ist auf `Isolate.spawn` plus `Isolate.exit` aufgebaut, gerade damit das Ergebnis ohne Kopie zurückkommt:

```dart
// Dart 3.12. One-shot work, result transferred rather than copied.
final parsed = await Isolate.run(() {
  final text = File('bulk.json').readAsStringSync();
  return jsonDecode(text) as Map<String, dynamic>;
});
```

Der zweite Ausweg ist `TransferableTypedData`, das den Besitz eines Byte-Puffers zwischen Isolates verschiebt, ohne ihn zu kopieren. Nutzen Sie das, wenn die Nutzlast aus Bytes besteht (ein Bild, eine heruntergeladene Datei, ein dekodierter Audiopuffer) und nicht aus einem Objektgraphen.

Wenn Sie große Ergebnisse wiederholt senden, beachten Sie den Kompromiss, den Flutters eigener Leitfaden benennt: "Das Starten neuer Isolates und das Kopieren von Objekten von einem Isolate zum anderen kostet Performance. Wenn Sie dieselbe Berechnung wiederholt mit `Isolate.run` ausführen, erzielen Sie möglicherweise bessere Performance mit Isolates, die nicht sofort enden."

## async/await ist ebenfalls kein Thread

Das häufigste Missverständnis in diesem Umfeld ist, dass `await` Arbeit vom aktuellen Isolate wegbewegt. Das tut es nicht. `Future`, `Stream` und `await` sind Planungskonstrukte auf der einen Event Loop des Isolates, in dem Sie ohnehin schon sind. Ein `await` auf einen Socket-Read gibt die Loop frei, während das Betriebssystem die I/O erledigt, und deshalb reicht Asynchronität für Netzwerk- und Dateiarbeit. Ein `await` auf eine Funktion, die 200 ms in einer engen Schleife verbringt, gibt nichts frei, weil es darin keinen Unterbrechungspunkt gibt.

Die Faustregel ist kurz. Asynchronität ist zum Warten da, Isolates sind zum Rechnen da. Ist das Teure synchrone CPU-Arbeit, holt nur ein Isolate sie von der Loop. Wenn Sie das Ergebnis in Widgets zurückführen, deckt der [Vergleich von FutureBuilder, StreamBuilder und Riverpods AsyncValue](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) ab, mit welcher asynchronen Primitive Sie es darstellen.

## Wo das Thread-Modell in Flutter durchscheint

Flutter führt Ihre App im Haupt-Isolate aus, auch Root-Isolate genannt. Die Flutter-Dokumentation sagt: "Flutter-Apps erledigen ihre gesamte Arbeit in einem einzigen Isolate, dem Haupt-Isolate", und "alle UI-Aufgaben und Flutter selbst sind an das Haupt-Isolate gekoppelt".

Darunter nutzt die Engine tatsächlich mehrere Betriebssystem-Threads für Rasterisierung, I/O und Plattformarbeit, und ihre Anordnung hat sich kürzlich geändert: Seit Flutter 3.29 sind "der UI- und der Plattform-Thread unter iOS und Android zusammengelegt. Konkret entfällt der UI-Thread, und der Dart-Code läuft auf dem nativen Plattform-Thread." Das ist eine Thread-Änderung ohne Entsprechung auf Isolate-Ebene, was gut zeigt, dass die beiden Schichten unabhängig sind. Ihr Dart-Code ist nicht in ein anderes Isolate gewandert, sondern auf einen anderen Betriebssystem-Thread, und im Isolate-Modell hat das niemand bemerkt.

Zwei Konsequenzen treffen Hintergrund-Isolates:

- Keine UI und keine Assets. "Sie können in gestarteten Isolates weder über `rootBundle` auf Assets zugreifen noch Widget- oder UI-Arbeit ausführen." Jedes `dart:ui`-Objekt gehört zum Haupt-Isolate.
- Platform Channels brauchen eine Initialisierung. Seit es Platform Channels in Hintergrund-Isolates gibt, kann ein Worker Android oder iOS aufrufen, aber erst nach der Registrierung beim Messenger des Root-Isolates, und er "kann weiterhin keine unaufgeforderten Nachrichten von der Host-Plattform empfangen".

```dart
// Dart 3.12, Flutter 3.44.7. Platform channels from a background isolate.
Future<void> _isolateMain(RootIsolateToken rootIsolateToken) async {
  BackgroundIsolateBinaryMessenger.ensureInitialized(rootIsolateToken);
  final prefs = await SharedPreferences.getInstance();
  // ... plugin calls now work here
}
```

Wenn Sie verlorenen Frames nachjagen und noch nicht wissen, ob ein Isolate überhaupt die Antwort ist, messen Sie zuerst: Die Anleitung zum [Profiling von Jank mit DevTools](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) zeigt, wie Sie einen langen synchronen Callback von einem Layout- oder Rasterproblem unterscheiden, und beide erfordern völlig unterschiedliche Korrekturen. Stellt sich heraus, dass die Arbeit auf die Plattformseite gehört, ist [plattformspezifischer Code ohne eigenes Plugin](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) der günstigere Weg.

## FFI ist der Ort, an dem Sie echte Threads berühren

Der einzige Ort, an dem der Thread darunter sichtbar wird, ist `dart:ffi`. Ein synchroner FFI-Aufruf läuft auf dem Betriebssystem-Thread, der gerade der Mutator-Thread des Isolates ist, und blockiert diesen Thread und damit die Event Loop des Isolates bis zur Rückkehr. Lange native Aufrufe gehören aus demselben Grund in ein Worker-Isolate wie lange Dart-Schleifen.

Callbacks in die Gegenrichtung unterliegen derselben Regel von einem Isolate pro Thread, und deshalb hat `NativeCallable` (Dart 3.1) verschiedene Varianten. `NativeCallable.isolateLocal` "muss von demselben Thread aufgerufen werden, der es erzeugt hat", während `NativeCallable.listener` und `NativeCallable.isolateGroupBound` "von jedem Thread aufgerufen werden können". Ruft eine native Bibliothek Sie aus ihrem eigenen Worker-Thread zurück, ist `isolateLocal` ein Absturz mit Ansage, und `listener` ist der Konstruktor, den Sie wollen.

## Im Web gibt es beides nicht

Im Web gibt es überhaupt keine Isolates. Nach JavaScript kompilierter Dart-Code läuft auf dem einen Thread des Browsers, deshalb degradiert `compute` sauber, statt zu parallelisieren: "Auf Web-Plattformen führt dies den Callback auf der aktuellen Event Loop aus. Auf nativen Plattformen führt dies den Callback in einem separaten Isolate aus." Web Worker sind die Antwort des Browsers, aber kein direkter Ersatz, denn "Web Worker lassen sich nur erstellen, indem ein separater Programm-Einstiegspunkt deklariert und separat kompiliert wird", und sie kopieren Daten über die Grenze, ohne die Transfer-APIs zu haben, die Isolates bieten.

Wenn ein Codepfad für sein Frame-Budget auf Parallelität angewiesen ist, testen Sie ihn im Web separat. Er wird laufen, und er wird blockieren.

## Was sich ändert

Das strikte Modell hat bekannte Kosten: Spiele, Physik und Bildpipelines bezahlen dafür, Daten zu kopieren, die logisch zu einer einzigen Berechnung gehören. Das Dart-Team untersucht eine selektive Lockerung, verfolgt im Sammel-Issue zu Shared-Memory-Multithreading in dart-lang/sdk, mit einem Sprachvorschlag von Vyacheslav Egorov. Die erste Phase deckt geteilten nativen Speicher ab, mit geteilten Isolates, statischen Feldern mit `@pragma('vm:shared')` für trivial teilbare Typen und Aufrufen in eine Isolate Group von einem beliebigen nativen Thread aus. `NativeCallable.isolateGroupBound` ist die sichtbare Spitze dieser Arbeit.

Nichts davon ändert das Standardmodell, und mit Dart 3.12 sollten Sie es als experimentell behandeln und das Tracking-Issue lesen, bevor Sie darauf aufbauen. Die sichere Annahme für Produktionscode bleibt heute: Isolates besitzen ihren Zustand, Nachrichten sind Kopien, und `Isolate.exit` plus `TransferableTypedData` sind Ihre einzigen kopierfreien Wege.

## Das passende mentale Modell wählen

- Wer nach einem Lock greift, hat das Problem als Threads modelliert. In Dart gibt es nichts zu sperren; strukturieren Sie es als Nachricht um.
- Ein großes Objekt zwischen zwei Isolates zu teilen ist nicht möglich. Senden Sie entweder eine Kopie, übertragen Sie es einmalig mit `Isolate.exit` oder `TransferableTypedData`, oder halten Sie es in einem Isolate und senden Sie diesem Isolate Kommandos.
- `await` fügt nie einen Thread hinzu. Nur Isolates bringen Parallelität, und das nur auf nativen Zielen.
- Ein langlebiger Worker schlägt wiederholtes `Isolate.run`, wenn Sie dieselbe Berechnung viele Male ausführen, denn Starten und Kopieren sind nicht kostenlos.
- FFI, nicht Dart, ist der Ort, an dem Thread-Identität zählt. Wählen Sie den `NativeCallable`-Konstruktor, der zu dem Thread passt, von dem die native Seite aufruft.

## Quellen

- [Concurrency in Dart](https://dart.dev/language/concurrency)
- [Concurrency and isolates, Flutter-Dokumentation](https://docs.flutter.dev/perf/isolates)
- [Introduction to Dart VM, Interna zu Threads und Isolates](https://mrale.ph/dartvm/)
- [Announcing Dart 2.15, Isolate Groups](https://dart.dev/blog/announcing-dart-2-15)
- [Better isolate management with Isolate.run](https://dart.dev/blog/better-isolate-management-with-isolate-run)
- [API-Referenz zu Isolate.exit](https://api.dart.dev/stable/dart-isolate/Isolate/exit.html)
- [API-Referenz zu NativeCallable](https://api.dart.dev/stable/dart-ffi/NativeCallable-class.html)
- [Flutter architectural overview](https://docs.flutter.dev/resources/architectural-overview)
- [Explore shared memory multithreading, dart-lang/sdk#55991](https://github.com/dart-lang/sdk/issues/55991)

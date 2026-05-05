---
title: "Wie Sie einen Dart-Isolate für CPU-gebundene Arbeit schreiben"
description: "Wenn async/await nicht reicht: Starten Sie einen Dart-Isolate, um CPU-gebundene Arbeit aus dem UI-Thread herauszuhalten. Isolate.run, Flutters compute, langlebige Worker mit SendPort/ReceivePort, was die Grenze passieren darf, und der JS/Web-Vorbehalt. Getestet mit Dart 3.11 und Flutter 3.27.1."
pubDate: 2026-05-05
tags:
  - "dart"
  - "flutter"
  - "isolates"
  - "concurrency"
  - "performance"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work"
translatedBy: "claude"
translationDate: 2026-05-05
---

Kurze Antwort: Für eine einmalige Berechnung rufen Sie `await Isolate.run(myFunction)` auf (Dart 2.19+) oder in Flutter `await compute(myFunction, arg)`. Für einen Worker, der viele Anfragen abarbeitet, verwenden Sie `Isolate.spawn` mit einem `ReceivePort` auf jeder Seite und leiten Nachrichten über einen `SendPort`. Die Funktion, die Sie an den Isolate übergeben, muss eine Top-Level- oder `static`-Funktion sein, Nachricht und Ergebnis müssen sendbar sein, und im Web läuft `compute` auf der Event-Loop, weil dart2js keine echten Isolates besitzt. Getestet mit Dart 3.11 und Flutter 3.27.1 sowie Android Gradle Plugin 8.7.3.

Async ist in Dart kein Parallelismus. `Future`, `await` und `Stream` planen Arbeit auf derselben Single-Thread-Event-Loop, auf der auch Ihre UI läuft. Wenn ein synchroner Schritt innerhalb dieses Future 80 ms damit verbringt, ein 4 MB großes JSON-Dokument zu parsen oder einen Datei-Hash zu berechnen, blockiert die Loop für 80 ms, die GPU verpasst zwei Frames bei 60 fps und `Skipped 5 frames!` taucht in Ihren Logs auf. Ein Isolate ist die Art, wie Dart dem Single-Thread entkommt: ein eigener VM-Heap mit eigener Event-Loop, eigener Garbage Collection und ohne gemeinsamen Speicher mit dem aufrufenden Isolate. Sie verschieben die Arbeit dorthin, bekommen die Antwort zurück, und der UI-Thread zeichnet weiter.

## Wann ein Isolate das richtige Werkzeug ist

Die teure Operation muss **synchrone CPU-Arbeit** sein, kein langer Netzwerkaufruf. `http.get` in einen Isolate zu wickeln, bringt Ihnen nichts, weil `http.get` bereits asynchron ist und auf die Event-Loop zurückgibt, während es auf den Socket wartet. Echte Kandidaten:

- Parsen eines JSON-Payloads über ~1 MB. `jsonDecode` ist synchron und skaliert linear mit der Payload-Größe.
- Bilddekodierung und -skalierung mit `package:image`. Reines Dart, kein Plattform-Plugin, und ein 12-MP-JPEG dauert mehrere hundert Millisekunden.
- Kryptografisches Hashing einer Datei (SHA-256 über einen gepufferten Stream, BCrypt zur Passwortprüfung).
- Regex über ein großes Dokument, insbesondere mit `multiline: true` und Lookbehinds.
- Komprimierung / Dekomprimierung mit `package:archive`.
- Numerische Arbeit: Matrixmultiplikation für ein kleines ML-Modell, FFT, Bildkernel-Faltung.

Wenn Sie keinen Stack-Frame benennen können, der länger als ~16 ms (das Budget eines Frames bei 60 fps) synchron läuft, hilft Ihnen ein Isolate nicht. Profilieren Sie zuerst mit dem CPU-Profiler in Flutter DevTools; die Timeline des "UI thread" ist die, auf die Sie schauen müssen.

## Der billigste Weg: Isolate.run

`Isolate.run<R>(FutureOr<R> Function() computation, {String? debugName})` wurde in Dart 2.19 hinzugefügt und ist die API, auf die Sie die Doku 2026 lenkt. Sie startet einen Isolate, führt den Callback aus, schickt das Ergebnis ohne Kopie auf der VM zurück und baut den Isolate ab.

```dart
// Dart 3.11
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

Future<List<dynamic>> parseLargeJson(File file) async {
  final text = await file.readAsString();
  return Isolate.run(() => jsonDecode(text) as List<dynamic>);
}
```

Hier passieren zwei Dinge. Erstens bleibt das Lesen der Datei im aufrufenden Isolate, weil `readAsString` bereits asynchron ist und die Event-Loop nicht blockiert. Zweitens läuft `jsonDecode` in einem frischen Isolate, und die resultierende `List<dynamic>` kommt über die Grenze zurück. Einen Isolate zu starten kostet auf einem modernen Smartphone etwa 1 bis 3 ms, also lohnt es sich nur, wenn die eigentliche Arbeit mindestens das Zehnfache davon braucht.

Ein häufiger Fehler ist, eine Closure zu übergeben, die den umgebenden Scope einfängt:

```dart
// Dart 3.11 - works, but copies state you did not intend to send
Future<int> countWordsBuggy(String text, Set<String> stopWords) async {
  return Isolate.run(() {
    return text
        .split(RegExp(r'\s+'))
        .where((w) => !stopWords.contains(w))
        .length;
  });
}
```

Die Closure fängt `text` und `stopWords` ein, also werden beide in den neuen Isolate kopiert. Bei kleinen Eingaben in Ordnung, aber wenn `text` 50 MB groß ist, haben Sie gerade 50 MB Allokation und einen Serialisierungsdurchlauf bezahlt. Schlimmer: Wenn der eingefangene Zustand ein nicht sendbares Objekt enthält (einen offenen `Socket`, eine `DynamicLibrary`, einen `ReceivePort`, alles, was mit `@pragma('vm:isolate-unsendable')` markiert ist), bekommen Sie zur Laufzeit einen `ArgumentError` aus dem Spawn-Aufruf. Die Lösung ist entweder, den eingefangenen Zustand minimal zu halten, oder einen Top-Level-Einstiegspunkt zu binden und Argumente explizit zu übergeben.

## Flutters compute und was es tatsächlich ist

`compute<M, R>(ComputeCallback<M, R> callback, M message)` aus `package:flutter/foundation.dart` ist älter als `Isolate.run` und immer noch die in Flutter-Tutorials am häufigsten zitierte API. Stand Flutter 3.27.1 ist sie auf nativen Plattformen als äquivalent zu `Isolate.run(() => callback(message))` dokumentiert. Auf dem Web-Target führt sie den Callback synchron auf derselben Event-Loop aus, weil dart2js zu JavaScript kompiliert und es im Browser keine echten Isolates gibt; im Web bekommen Sie keinen Parallelismus, egal welche API Sie aufrufen.

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/foundation.dart';

List<Person> _parsePeople(String body) {
  final raw = jsonDecode(body) as List<dynamic>;
  return raw.cast<Map<String, dynamic>>().map(Person.fromJson).toList();
}

Future<List<Person>> fetchPeople(http.Client client) async {
  final res = await client.get(Uri.parse('https://api.example.com/people'));
  return compute(_parsePeople, res.body);
}
```

`_parsePeople` ist eine Top-Level-Funktion, keine Closure und keine Methode. Das ist die Regel, die die meisten Leute trifft: Der Callback, den Sie an `compute` (oder an `Isolate.spawn`) übergeben, muss eine Top-Level- oder `static`-Funktion sein, damit nur seine Identität übergeben wird, nicht der umschließende Scope. Wenn Sie `compute(this._parsePeople, body)` schreiben, tappen Sie in dieselbe Closure-Capture-Falle wie zuvor, und Sie könnten am Ende versuchen, den gesamten umschließenden Widget-Baum mitzuschicken.

## Langlebige Worker: Isolate.spawn mit bidirektionalen Ports

`Isolate.run` ist einmalig. Wenn Sie einen Worker wollen, der viele Anfragen abarbeitet (ein Suchindex, der einmal 200 MB lädt und danach 50 Anfragen beantwortet), brauchen Sie `Isolate.spawn` plus Ihr eigenes Protokoll auf `SendPort` / `ReceivePort`.

Das Muster ist symmetrisch: Jede Seite öffnet einen `ReceivePort` und schickt den passenden `SendPort` an die andere Seite, anschließend reden beide Seiten über diese Ports.

```dart
// Dart 3.11
import 'dart:async';
import 'dart:isolate';

class SearchWorker {
  late final SendPort _toWorker;
  late final ReceivePort _fromWorker;
  final Map<int, Completer<List<int>>> _pending = {};
  int _nextId = 0;

  static Future<SearchWorker> start(List<String> corpus) async {
    final fromWorker = ReceivePort('search.fromWorker');
    await Isolate.spawn(_entry, [fromWorker.sendPort, corpus],
        debugName: 'search-worker');
    final ready = Completer<SendPort>();
    final iter = StreamIterator(fromWorker);
    if (await iter.moveNext()) ready.complete(iter.current as SendPort);

    final w = SearchWorker._();
    w._toWorker = await ready.future;
    w._fromWorker = fromWorker;
    fromWorker.listen(w._onMessage);
    return w;
  }

  SearchWorker._();

  Future<List<int>> query(String term) {
    final id = _nextId++;
    final c = Completer<List<int>>();
    _pending[id] = c;
    _toWorker.send([id, term]);
    return c.future;
  }

  void _onMessage(dynamic msg) {
    final list = msg as List;
    final id = list[0] as int;
    final hits = (list[1] as List).cast<int>();
    _pending.remove(id)?.complete(hits);
  }

  void dispose() {
    _toWorker.send(null); // sentinel
    _fromWorker.close();
  }
}

void _entry(List args) async {
  final replyTo = args[0] as SendPort;
  final corpus = (args[1] as List).cast<String>();
  final inbound = ReceivePort('search.inbound');
  replyTo.send(inbound.sendPort);

  await for (final msg in inbound) {
    if (msg == null) {
      inbound.close();
      break;
    }
    final list = msg as List;
    final id = list[0] as int;
    final term = (list[1] as String).toLowerCase();
    final hits = <int>[];
    for (var i = 0; i < corpus.length; i++) {
      if (corpus[i].toLowerCase().contains(term)) hits.add(i);
    }
    replyTo.send([id, hits]);
  }
  Isolate.exit();
}
```

Ein paar Details lohnen die Erwähnung. Der Handshake (der Worker erzeugt einen eingehenden `ReceivePort` und sendet seinen `SendPort` über den vom Host gelieferten Port zurück) ist Boilerplate, aber unvermeidbar: Es gibt keine globale Registry für Isolate-Ports. Die `_pending`-Map plus eine monoton steigende Id ist das, was Ihnen mehrere parallel laufende Anfragen erlaubt; ohne Ids können Sie Anfragen nur serialisieren. Das Sentinel `null` fährt den Worker sauber herunter, und `Isolate.exit()` ist schneller, als `main` einfach zurückkehren zu lassen, weil es die letzte Nachricht ohne Kopie sendet.

Wenn Sie Pause / Resume oder Kill-Semantik wollen, fangen Sie das von `Isolate.spawn` zurückgegebene `Isolate` ein und rufen `isolate.kill(priority: Isolate.immediate)` auf. Beachten Sie, dass `kill` keine Finalizer im Worker ausführt, also lecken jede offene Datei und jedes DB-Handle, das der Worker hielt, bis zum Prozessende.

## Was die Grenze passieren darf

Die meisten Dart-Objekte können gesendet werden. Die Ausnahmen, Stand Dart 3.11, sind:

- Objekte mit nativen Ressourcen: `Socket`, `RawSocket`, `RandomAccessFile`, `Process`.
- `ReceivePort`, `RawReceivePort`, `DynamicLibrary`, `Pointer`, alle `dart:ffi`-Finalizer.
- Alles, was mit `@pragma('vm:isolate-unsendable')` annotiert ist.
- Closures, die nicht sendbaren Zustand einfangen. Die Capture wird transitiv geprüft, also ist eine Closure, die eine Klasseninstanz mit einem `Socket`-Feld referenziert, ebenfalls nicht sendbar.

Sendbare Typen umfassen alle Primitiven, `String`, `Uint8List` und die anderen typisierten Listen, `List`, `Map`, `Set`, `DateTime`, `Duration`, `BigInt`, `RegExp` sowie jede Klasseninstanz, deren Felder selbst sendbar sind. Einen Typed-Data-Buffer zu senden, kopiert ihn über den Heap, es sei denn, Sie verpacken ihn in `TransferableTypedData`, was eine Zero-Copy-Übergabe ergibt:

```dart
// Dart 3.11
import 'dart:typed_data';
import 'dart:isolate';

Future<int> sumBytes(Uint8List bytes) async {
  final transferable = TransferableTypedData.fromList([bytes]);
  return Isolate.run(() {
    final view = transferable.materialize().asUint8List();
    var sum = 0;
    for (final b in view) {
      sum += b;
    }
    return sum;
  });
}
```

`materialize()` ist pro `TransferableTypedData` einmalig, also verliert der Sender den Zugriff auf den Buffer, sobald der Worker ihn materialisiert. Genau das ist der Punkt: Der Speicher wird verschoben, nicht dupliziert. Bei Payloads über ein paar Megabyte ist der Unterschied zwischen `TransferableTypedData` und einer schlichten Kopie der Unterschied zwischen 1 ms und 30 ms.

## Stolperfallen, die jedes Team treffen

**Closures fangen mehr ein, als Sie denken.** Selbst eine leere Closure innerhalb einer Methode fängt `this` ein. Wenn `this` der State eines `StatefulWidget` ist, haben Sie gerade den gesamten Widget-Subbaum auf dem Heap des Workers gehalten, bis der Aufruf abgeschlossen ist. Ziehen Sie die benötigten Daten immer in lokale Variablen und übergeben Sie sie als Argumente an eine Top-Level-Funktion.

**Spawnen ist nicht kostenlos.** Ein nacktes `Isolate.run` mit einem No-Op-Callback kostet auf einem Pixel 7 etwa 2 ms und auf einem älteren Android-Gerät 4 bis 6 ms. Wenn Sie merken, dass Sie `compute` 60-mal pro Sekunde aufrufen, um Taps zu verarbeiten, haben Sie sich Ihren eigenen Engpass geschrieben. Entweder bündeln Sie die Arbeit, oder Sie bauen einen langlebigen Worker.

**Das Web-Target ist eine Lüge in Sachen Parallelismus.** `compute` und `Isolate.run` fallen im Web beide darauf zurück, auf der aktuellen Event-Loop zu laufen, weil zu JavaScript kompiliertes Dart in einem einzigen Browser-Thread läuft. Wenn Web-Parallelismus zählt, brauchen Sie einen echten Web Worker, separat geschrieben, mit eigenem Nachrichtenprotokoll. Es gibt laufende Arbeit am Worker-Support in `dart:js_interop`, aber Stand Dart 3.11 ist er kein Drop-in-Ersatz für `Isolate.run`.

**`debugPrint` aus einem Worker kann sich verschachteln.** Jeder Isolate hat seine eigene `print`-Pipeline. Auf Android ist die Reihenfolge in `logcat` Best-Effort. Wenn Sie eine Race Condition debuggen, hängen Sie an jede Logzeile im Worker eine Sequenznummer, damit Sie sie offline neu sortieren können.

**Teilen Sie keinen Zustand per Referenz.** Ein häufiges Bug-Muster ist die Annahme, dass eine `Map`, die Sie in einen Isolate geschickt haben, "dieselbe" Map ist. Ist sie nicht; der Worker hat eine Tiefenkopie erhalten. Sie im Worker zu mutieren hat keine Wirkung beim Aufrufer. Behandeln Sie jede Isolate-Grenze als Serialisierungsgrenze.

## Wie sich das in den Rest Ihrer Flutter-Pipeline einfügt

Speziell für Flutter-Projekte zählen die Teile drumherum genauso wie der Isolate selbst. Profilieren Sie die Cold-Start-Kosten in DevTools, bevor Sie zum Spawnen greifen, da die Arbeit für den ersten Frame auf schwächeren Android-Geräten dazu neigt, dominant zu werden. Wenn Sie einen langlebigen Worker schreiben, der native Ressourcen lädt, gelten dieselben Threading-Regeln wie beim [Zugriff auf Plattform-Code per Method Channels](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/), denn `MethodChannel`-Aufrufe aus einem Worker-Isolate sind auf Android nicht unterstützt (nur der Root-Isolate hat standardmäßig den Binary Messenger). Für Reproduzierbarkeit im CI pinnen Sie sowohl Flutter als auch Dart explizit und führen Isolate-lastige Tests gegen jede Version aus, die Sie ausliefern; der [Matrix-CI-Workflow](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) ist die billigste Methode, eine Regression einzufangen, bei der sich die Spawn-Kosten oder der Codec unter Ihnen geändert haben. Und wenn Sie einen Worker debuggen, der hängt, deckt der [iOS-aus-Windows-Workflow](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) ab, wie Sie den Observer-Port übers Netzwerk attachen, sodass Sie Worker-Stack-Frames live sehen.

Die kürzeste Version der Regel: Wenn Sie `await` geschrieben haben und die UI trotzdem einfriert, gibt es irgendwo in der awaiteten Kette synchrone Arbeit. `Isolate.run` für einen einzelnen Aufruf, `compute` wenn Sie in Flutter leben und einen Import weniger wollen, `Isolate.spawn` plus Ihr eigenes Port-Protokoll, wenn der Worker Setup-Zustand hat, der es wert ist, warm gehalten zu werden. Alles andere (die Typtabellen, die Closure-Fallen, der Web-Vorbehalt) ist die Buchhaltung um diese drei Wahlmöglichkeiten herum.

## Source links

- [Dart concurrency and isolates](https://dart.dev/language/concurrency)
- [Isolate.run API reference](https://api.dart.dev/stable/dart-isolate/Isolate/run.html)
- [Isolate.spawn API reference](https://api.dart.dev/stable/dart-isolate/Isolate/spawn.html)
- [Flutter compute function](https://api.flutter.dev/flutter/foundation/compute.html)
- [TransferableTypedData](https://api.dart.dev/stable/dart-isolate/TransferableTypedData-class.html)
- [`@pragma('vm:isolate-unsendable')` annotation](https://github.com/dart-lang/sdk/blob/main/runtime/docs/pragmas.md)

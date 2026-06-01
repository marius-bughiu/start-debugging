---
title: "Netzwerkfehler in einer Flutter-App elegant behandeln"
description: "Eine Anfrage kann ohne Konnektivität, durch einen Timeout, einen DNS-Fehler, einen 500er oder fehlerhaftes JSON scheitern, und jeder Fall braucht eine andere Reaktion. So fangen Sie die richtigen Exceptions, klassifizieren sie, wiederholen sicher und zeigen eine Oberfläche, auf die der Nutzer reagieren kann."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "networking"
lang: "de"
translationOf: "2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app"
translatedBy: "claude"
translationDate: 2026-06-01
---

Ein Netzwerkaufruf in Flutter scheitert auf mindestens fünf verschiedene Arten, und eine elegante App behandelt jede davon anders: keine Konnektivität, ein Verbindungs-Timeout, ein DNS- oder Socket-Fehler, ein HTTP-Status, der nicht 2xx ist, und ein fehlerhafter oder unerwarteter Antwortkörper. Die Lösung besteht darin, den spezifischen Exception-Typ zu fangen statt eines nackten `catch (e)`, ihn auf eine kleine Menge nutzersichtbarer Zustände abzubilden (offline, Timeout, Serverfehler, wiederholbar, fatal), den Aufruf in einen Timeout und einen begrenzten Retry mit Backoff zu hüllen und einen Zustand zu rendern, auf den der Nutzer tatsächlich reagieren kann, statt eines Spinners, der sich nie auflöst. Dieser Leitfaden verwendet Flutter 3.44 (stable, Mai 2026), Dart 3.x, das Paket `http` 1.x, `dio` 5.9.2 und `connectivity_plus` 7.1.1.

Der Fehler, den fast jede Flutter-App am Anfang macht, ist, "das Netzwerk" als einen einzigen Fehlermodus zu behandeln. Sie hüllen den Aufruf in `try`/`catch`, zeigen einen Snackbar mit "Etwas ist schiefgelaufen" und machen weiter. Aber "kein Wi-Fi" und "der Server hat einen 503 zurückgegeben" sind nicht dasselbe Problem, und ein Nutzer, der auf einen generischen Fehler starrt, hat keine Ahnung, ob er es erneut versuchen, warten oder aufgeben soll. Schlimmer noch: Der häufigste Fehler erreicht nicht einmal den catch: ein `Future`, das sich nie abschließt, weil es keinen Timeout gab, sodass ein Spinner für immer kreist.

## Die Exceptions, die ein Flutter-HTTP-Aufruf tatsächlich wirft

Wenn Sie `dart:io` und das Paket `http` verwenden, erscheint eine fehlgeschlagene Anfrage als typisierte Exception, und der Typ verrät Ihnen, was schiefging:

- `SocketException` wird geworfen, wenn die Verbindung selbst nicht aufgebaut werden kann oder abbricht: keine Route zum Host, DNS-Auflösung fehlgeschlagen, Verbindung verweigert, oder das Gerät ist offline. Das ist die Gruppe "das Netzwerk ist nicht erreichbar".
- `TimeoutException` (aus `dart:async`) wird geworfen, wenn Sie ein `Future` mit `.timeout(...)` umhüllen und die Dauer verstreicht. Das Paket `http` läuft nicht von sich aus in einen Timeout, wenn Sie das also nicht hinzufügen, blockiert eine hängende Verbindung Ihre Oberfläche auf unbestimmte Zeit.
- `HttpException` und `ClientException` decken Probleme auf Protokollebene ab: eine fehlerhafte Antwort, eine mitten in der Antwort geschlossene Verbindung, oder eine Weiterleitungsschleife.
- `FormatException` wird von `jsonDecode` geworfen, wenn der Körper kein gültiges JSON ist. Ein 200 OK mit einer HTML-Fehlerseite (ein Captive Portal, ein Proxy, ein falsch konfiguriertes Gateway) landet hier, nicht in einer der Netzwerkgruppen. Diese spezielle Falle habe ich in [im Leitfaden zu FormatException Unexpected character](/de/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) behandelt.

Ein Status, der nicht 2xx ist, ist mit dem Paket `http` überhaupt keine Exception. `http.get` gibt eine `Response` mit `statusCode == 500` zurück, und Sie müssen das selbst prüfen. Das ist der häufigste Grund, warum eine App stillschweigend leere Daten anzeigt: Die entwickelnde Person hat `response.body` als JSON geparst, ohne jemals `response.statusCode` anzusehen, und der Körper war eine Fehler-Payload.

## Ein Repro, das alles verschluckt

Hier ist das zu vermeidende Muster. Es kompiliert, funktioniert über eine schnelle Verbindung und scheitert auf jede interessante Weise.

```dart
// Flutter 3.44, Dart 3.x, http 1.x -- anti-pattern, do not copy.
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<String>> fetchNames() async {
  try {
    final response =
        await http.get(Uri.parse('https://api.example.com/names'));
    final data = jsonDecode(response.body) as List;
    return data.cast<String>();
  } catch (e) {
    return []; // every failure looks like "no data"
  }
}
```

Drei Dinge sind kaputt. Es gibt keinen Timeout, sodass eine stehengebliebene Verbindung für immer hängt. Der Status wird nie geprüft, sodass ein 500er mit einem JSON-Fehlerkörper entweder in `cast` eine Exception wirft oder Müll zurückgibt. Und das `catch (e)` lässt offline, Timeout, Serverfehler und ungültiges JSON in einem einzigen Ergebnis zusammenfallen: einer leeren Liste, ununterscheidbar von "der Server hat legitim keine Namen". Die Oberfläche kann dem Nutzer nichts Nützliches sagen, weil die Funktion die einzige Information weggeworfen hat, die zählte.

## Klassifizieren Sie den Fehler zu einem Ergebnis, das die Oberfläche rendern kann

Die erste echte Lösung besteht darin, keine nackten Daten mehr zurückzugeben, sondern ein Ergebnis, das kodiert, wie der Aufruf endete. Eine Hierarchie versiegelter Klassen (sealed classes aus Dart 3) zwingt Sie über den Compiler dazu, jeden Fall zu behandeln.

```dart
// Flutter 3.44, Dart 3.x
sealed class NetworkResult<T> {
  const NetworkResult();
}

class Success<T> extends NetworkResult<T> {
  final T data;
  const Success(this.data);
}

class Offline<T> extends NetworkResult<T> {
  const Offline();
}

class TimedOut<T> extends NetworkResult<T> {
  const TimedOut();
}

class ServerError<T> extends NetworkResult<T> {
  final int statusCode;
  const ServerError(this.statusCode);
}

class BadResponse<T> extends NetworkResult<T> {
  final String detail;
  const BadResponse(this.detail);
}
```

Nun bildet die Datenschicht jeden Exception-Typ und jeden Status auf eines davon ab, und nichts entkommt als unbehandelter Throw:

```dart
// Flutter 3.44, Dart 3.x, http 1.x
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await http
        .get(Uri.parse('https://api.example.com/names'))
        .timeout(const Duration(seconds: 10));

    if (response.statusCode >= 500) {
      return ServerError(response.statusCode);
    }
    if (response.statusCode >= 400) {
      // 4xx is usually a client bug or auth issue, not retryable.
      return BadResponse('HTTP ${response.statusCode}');
    }

    final decoded = jsonDecode(response.body) as List;
    return Success(decoded.cast<String>());
  } on SocketException {
    return const Offline();
  } on TimeoutException {
    return const TimedOut();
  } on FormatException catch (e) {
    return BadResponse('Malformed JSON: ${e.message}');
  } on http.ClientException catch (e) {
    return BadResponse(e.message);
  }
}
```

Beachten Sie die Reihenfolge der `on`-Klauseln. Dart wertet sie von oben nach unten aus und führt die erste Übereinstimmung aus, setzen Sie also die spezifischsten Exceptions zuerst. `TimeoutException` und `SocketException` sind Geschwister, nicht Eltern und Kind, ihre Reihenfolge zueinander spielt also keine Rolle, aber `FormatException` und `ClientException` müssen vor jedem breiten `catch` stehen. Hier gibt es bewusst kein nacktes `catch (e)`, denn wenn eine Exception geworfen wird, die ich nicht vorhergesehen habe, soll sie im Debug abstürzen und in meiner Fehlerberichterstattung auftauchen, nicht stillschweigend auf `BadResponse` abgebildet werden.

## Rendern Sie jeden Zweig im Widget

Da `NetworkResult` eine versiegelte Klasse ist, ist ein `switch`-Ausdruck im Widget erschöpfend: Fügen Sie einen neuen Ergebnistyp hinzu, und der Compiler markiert jeden `switch`, der ihn nicht behandelt. Das ist der Lohn der versiegelten Hierarchie.

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

Widget buildBody(NetworkResult<List<String>> result, VoidCallback onRetry) {
  return switch (result) {
    Success(data: final names) => ListView(
        children: [for (final n in names) ListTile(title: Text(n))],
      ),
    Offline() => _ErrorState(
        message: 'You appear to be offline. Check your connection.',
        onRetry: onRetry,
      ),
    TimedOut() => _ErrorState(
        message: 'The request took too long. Try again.',
        onRetry: onRetry,
      ),
    ServerError(statusCode: final code) => _ErrorState(
        message: 'The server had a problem (HTTP $code). Try again shortly.',
        onRetry: onRetry,
      ),
    BadResponse(detail: final detail) => _ErrorState(
        message: 'Something went wrong. ($detail)',
        onRetry: null, // not retryable, retry will not help
      ),
  };
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const _ErrorState({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: FilledButton(onPressed: onRetry, child: const Text('Retry')),
            ),
        ],
      ),
    );
  }
}
```

Die Unterscheidung, die für den Nutzer zählt: `Offline`, `TimedOut` und `ServerError` bieten eine Wiederholen-Schaltfläche an, weil ein erneuter Versuch erfolgreich sein könnte. `BadResponse` tut das nicht, denn eine fehlerhafte Payload oder ein 400er scheitert beim nächsten Versuch identisch, und eine Wiederholen-Schaltfläche, die nie funktioniert, ist schlimmer als keine Schaltfläche. Halten Sie das Fehler-Widget einfach, damit es keinen zweiten Bug einführt; ein Fehlerbildschirm, der selbst überläuft, macht einen schlechten Eindruck, und [der Leitfaden zum RenderFlex-Überlauf](/de/2026/05/fix-renderflex-overflowed-in-flutter/) erklärt, warum das passiert.

## Wiederholen Sie vorübergehende Fehler mit exponentiellem Backoff

`Offline`, `TimedOut` und `ServerError` (konkret 502, 503, 504) sind vorübergehend: Dieselbe Anfrage kann Sekunden später erfolgreich sein. Eine elegante App wiederholt sie automatisch eine begrenzte Anzahl von Malen, mit steigender Verzögerung, um einen leidenden Server nicht zu hämmern. Wiederholen Sie keine 4xx, und wiederholen Sie nicht ewig.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'dart:io';

Future<T> withRetry<T>(
  Future<T> Function() action, {
  int maxAttempts = 3,
  Duration baseDelay = const Duration(milliseconds: 400),
}) async {
  var attempt = 0;
  while (true) {
    attempt++;
    try {
      return await action();
    } on SocketException {
      if (attempt >= maxAttempts) rethrow;
    } on TimeoutException {
      if (attempt >= maxAttempts) rethrow;
    }
    // 2^attempt backoff: 0.8s, 1.6s, 3.2s ...
    final delay = baseDelay * (1 << attempt);
    await Future<void>.delayed(delay);
  }
}
```

Das `1 << attempt` ist ein Bit-Shift, der den Multiplikator in jeder Runde verdoppelt, was die billigste Art ist, exponentiellen Backoff zu schreiben. In der Produktion wollen Sie zusätzlich Jitter (einen kleinen zufälligen Versatz), damit nicht tausend Clients, die sich vom selben Ausfall erholen, alle im selben Takt wiederholen und einen Ansturm erzeugen, aber die Grundform ist diese Schleife. Hüllen Sie den HTTP-Aufruf, nicht die gesamte `fetchNames`-Funktion, sodass die Wiederholung die rohe Exception sieht, bevor sie auf ein `NetworkResult` abgebildet wird. Wenn die Arbeit innerhalb der wiederholten Aktion CPU-lastig ist (etwa das Dekodieren einer riesigen Payload), schieben Sie diese aus dem Oberflächen-Isolate heraus, wie in [im Leitfaden zu Dart-Isolates](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) beschrieben, denn Wiederholungen vervielfachen diese Kosten.

## dio liefert typisierte Fehler und einen Interceptor für Wiederholungen

Das Paket `http` ist in Ordnung, aber `dio` 5.9.2 hüllt jeden Fehler in eine einzige `DioException`, deren Feld `type` den Fehler bereits für Sie klassifiziert, was einen Großteil der manuellen `on SocketException`-Verrohrung entfernt. Das Enum `DioExceptionType` hat acht Werte: `connectionTimeout`, `sendTimeout`, `receiveTimeout`, `badCertificate`, `badResponse`, `cancel`, `connectionError` und `unknown`. Sie konfigurieren die Timeouts einmal auf `BaseOptions`, und sie gelten für jede Anfrage.

```dart
// Flutter 3.44, Dart 3.x, dio 5.9.2
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://api.example.com',
  connectTimeout: const Duration(seconds: 5),
  receiveTimeout: const Duration(seconds: 10),
));

Future<NetworkResult<List<String>>> fetchNames() async {
  try {
    final response = await dio.get<List<dynamic>>('/names');
    return Success((response.data ?? []).cast<String>());
  } on DioException catch (e) {
    return switch (e.type) {
      DioExceptionType.connectionError => const Offline(),
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout =>
        const TimedOut(),
      DioExceptionType.badResponse =>
        ServerError(e.response?.statusCode ?? 0),
      _ => BadResponse(e.message ?? 'Unknown dio error'),
    };
  }
}
```

`dio` validiert die Status standardmäßig: Eine Antwort, die nicht 2xx ist, wirft `DioException` mit `type == badResponse` statt still zurückzukehren, sodass der Bug "vergessen, den Status zu prüfen" nicht passieren kann. Und da `dio` eine Interceptor-Pipeline bereitstellt, können Sie die Wiederholungslogik zentral anhängen, statt jeden Aufruf zu umhüllen. Das Community-Paket `dio_smart_retry` klinkt sich in diese Pipeline ein und wiederholt idempotente Anfragen ab Werk mit Backoff, was sich lohnt, sobald Sie mehr als eine Handvoll Endpunkte haben.

## connectivity_plus informiert über das Funkmodul, nicht über das Internet

Eine häufige Anforderung ist "prüfen, ob der Nutzer online ist, bevor der Aufruf erfolgt". `connectivity_plus` 7.1.1 erledigt einen Teil davon, aber lesen Sie dessen eigene Warnung genau: Die Verfügbarkeit eines Verbindungstyps garantiert keinen Internetzugang. Ab Version 5 gibt die API eine `List<ConnectivityResult>` zurück (ein Gerät kann gleichzeitig im Wi-Fi und im Mobilfunk sein), nicht einen einzelnen Wert, was Code stolpern lässt, der gegen alte Beispiele geschrieben wurde.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
import 'package:connectivity_plus/connectivity_plus.dart';

Future<bool> hasNetworkInterface() async {
  final results = await Connectivity().checkConnectivity();
  return !results.contains(ConnectivityResult.none);
}
```

Die Falle besteht darin, dies als Schranke zu behandeln: "wenn verbunden, wird die Anfrage erfolgreich sein". Wird sie nicht. Ein Telefon meldet `wifi`, während es mit dem Netz eines Cafés verbunden ist, das nicht über dessen Captive Portal autorisiert wurde, sodass jede Anfrage weiterhin mit einer `SocketException` oder einem Timeout scheitert. Verwenden Sie `connectivity_plus`, um auf Änderungen zu reagieren (ein Offline-Banner einblenden, sobald das Funkmodul ausfällt, es ausblenden, wenn es zurückkehrt) und um zu entscheiden, ob sich ein erneuter Versuch überhaupt lohnt, aber nie als Ersatz für das tatsächliche Behandeln der Exception aus der Anfrage. Die Konnektivitätsprüfung ist eine Optimierung, der Exception-Handler ist die Quelle der Wahrheit.

```dart
// Flutter 3.44, Dart 3.x, connectivity_plus 7.1.1
// React to connectivity changes for a live offline banner.
final sub = Connectivity().onConnectivityChanged.listen(
  (List<ConnectivityResult> results) {
    final online = !results.contains(ConnectivityResult.none);
    // update a banner; this stream's subscription must be cancelled
    // in dispose() like any other.
  },
);
```

Diese `StreamSubscription` ist genau die Art von Ressource, die ein Speicherleck verursacht, wenn Sie vergessen, sie abzubrechen, was das ganze Thema von [Controller und Subscriptions in Flutter freigeben](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) ist.

## Grenzfälle, die eine robuste App von einer Demo trennen

**Abbruch beim Dispose.** Wenn der Nutzer mitten in der Anfrage wegnavigiert, kann sich das `Future` trotzdem abschließen und `setState` auf einem bereits defunkten `State` aufrufen, was eine Exception wirft. Sichern Sie mit `if (!mounted) return;` nach jedem `await` in einem Widget ab, oder verlagern Sie den Aufruf in eine Zustandsverwaltungsschicht, die die Navigation überlebt. Falsch gehandhabte Eigentümerschaft ist hier ein wiederkehrendes Thema beim Umbau einer App, was ein Teil davon ist, warum [die Migration von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) darauf achten muss, wo die asynchrone Arbeit lebt.

**Timeouts müssen kürzer sein als die Geduld des Nutzers, nicht die des Servers.** Ein Timeout von 30 Sekunden ist technisch korrekt und ein schreckliches Erlebnis. Wählen Sie einen Connect-Timeout um die 5 Sekunden und einen Receive-Timeout um die 10, und zeigen Sie eine Wiederholung weit bevor ein Nutzer folgert, die App sei eingefroren.

**Ein 200er mit dem falschen Körper ist trotzdem ein Fehler.** Behandeln Sie die Schemavalidierung als Teil der Netzwerkbehandlung. Wenn `jsonDecode` erfolgreich ist, aber ein erforderliches Feld fehlt, ist das ein `BadResponse`, kein `Success`. Validieren Sie die Form, bevor Sie Ihr Modell konstruieren, sonst schieben Sie den Fehler tief in die Oberfläche, wo er weit schwerer zu diagnostizieren ist.

**Loggen und werfen Sie nicht in jeder Schicht erneut.** Wählen Sie einen einzigen Ort (die Exception-Abbildung der Datenschicht), um den Fehler mit seinem Stack Trace aufzuzeichnen, und lassen Sie das typisierte Ergebnis den Rest tragen. Dieselbe Exception dreimal zu loggen, während sie nach oben blubbert, macht Ihre Absturzberichte nur lauter.

**Wiederholungen verstärken die Last während eines Ausfalls.** Wenn ein Backend bereits leidet, machen es aggressive Client-Wiederholungen schlimmer. Begrenzen Sie die Versuche, verwenden Sie Backoff mit Jitter, und respektieren Sie einen `Retry-After`-Header, wenn der Server ihn sendet. Elegante Degradierung hat ebenso viel damit zu tun, ein guter Client zu sein, wie damit, einen schönen Fehlerbildschirm zu zeigen.

Der rote Faden ist, dass "Netzwerkfehlerbehandlung" eigentlich drei Aufgaben sind, die man zu einer zusammenfallen lässt: den spezifischen Fehler fangen, ihn in etwas klassifizieren, mit dem die Oberfläche und die Wiederholungslogik arbeiten können, und ihn als Zustand präsentieren, auf den der Nutzer reagieren kann. Bringen Sie die typisierten `catch`-Klauseln und das versiegelte Ergebnis in Ordnung, fügen Sie einen begrenzten Backoff für die vorübergehenden Fälle hinzu, und behandeln Sie `connectivity_plus` als Hinweis statt als Garantie, und der generische "Etwas ist schiefgelaufen"-Snackbar verschwindet endgültig aus Ihrer App.

## Verwandt

- [Controller in Flutter freigeben, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) behandelt das Abbrechen der `StreamSubscription`, die ein Konnektivitäts-Listener erzeugt.
- [Fix: FormatException Unexpected character beim Parsen von JSON in Dart](/de/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) ist der Fall des fehlerhaften Körpers im Detail.
- [Ein Dart-Isolate für CPU-lastige Arbeit schreiben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) ist der Ort, an dem die schwere Antwortdekodierung leben sollte, damit Wiederholungen die Oberfläche nicht ruckeln lassen.
- [Eine Flutter-App von GetX zu Riverpod migrieren](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) zeigt, wo die asynchrone Netzwerkarbeit über einen Wechsel der Zustandsverwaltung hinweg leben sollte.
- [Fix: RenderFlex overflowed in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) bewahrt Ihre Fehler- und Lade-Widgets davor, das Layout zu zerbrechen.

## Quellen

- [DioException class, dio API-Referenz](https://pub.dev/documentation/dio/latest/dio/DioException-class.html)
- [DioExceptionType enum, dio API-Referenz](https://pub.dev/documentation/dio/latest/dio/DioExceptionType.html)
- [connectivity_plus, pub.dev](https://pub.dev/packages/connectivity_plus)
- [Future.timeout, Dart API-Referenz](https://api.dart.dev/stable/dart-async/Future/timeout.html)
- [SocketException class, Dart API-Referenz](https://api.dart.dev/stable/dart-io/SocketException-class.html)
- [http package, pub.dev](https://pub.dev/packages/http)

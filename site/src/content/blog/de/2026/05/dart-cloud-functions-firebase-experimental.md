---
title: "Cloud Functions for Firebase spricht jetzt Dart (experimentell)"
description: "Firebase hat am 2026-05-06 experimentelle Dart-Unterstützung für Cloud Functions veröffentlicht. HTTPS- und Callable-Trigger, AOT-Cold-Starts und die Firebase CLI übernimmt die Kompilierung."
pubDate: 2026-05-19
tags:
  - "dart"
  - "flutter"
  - "firebase"
  - "cloud-functions"
  - "backend"
lang: "de"
translationOf: "2026/05/dart-cloud-functions-firebase-experimental"
translatedBy: "claude"
translationDate: 2026-05-19
---

Am 2026-05-06 hat das Firebase-Team [experimentelle Dart-Unterstützung](https://firebase.blog/posts/2026/05/dart-functions-exp) für Cloud Functions angekündigt, wenige Tage vor der Google I/O 2026. Für Flutter-Teams, die ihre Backends bisher aus Notwendigkeit in TypeScript geschrieben haben, ist das der erste offizielle Weg zu einem reinen Dart-Stack auf Firebase, bei dem die Firebase CLI Kompilierung und Bereitstellung durchgängig übernimmt.

## Warum das für Flutter-Teams wichtig ist

Heute schickt eine typische Flutter-App ihre Server-Logik an Cloud Functions in Node.js oder Python. Das bedeutet zwei Sprachen, zwei Typsysteme, zwei Sätze von Validierungsregeln und einen ständigen Kontextwechsel, wenn dasselbe Domänenobjekt auf beiden Seiten modelliert wird. Mit nativen Dart-Funktionen können Sie Ihre geteilten Datenklassen, Validatoren und Ergebnistypen in ein einziges `package:` legen und sie sowohl aus der App als auch aus dem Backend ohne Übersetzungsschicht konsumieren.

Das Firebase-Team hebt den Cold Start zudem als bewusste Designentscheidung hervor. Da die Firebase CLI Ihre Funktion lokal mit `dart compile exe` kompiliert und das AOT-Binary direkt nach Cloud Run hochlädt, gibt es keine VM-Aufwärmphase. Erste Zahlen aus dem Launch-Beitrag sprechen von Cold Starts um 10 ms, deutlich unter dem typischen Node.js-TypeScript-Niveau.

## Voraussetzungen und das Experiment-Flag

Laut dem [offiziellen Einstieg](https://firebase.google.com/docs/functions/start-dart) benötigen Sie:

- Dart SDK 3.9 oder höher
- Firebase CLI 15.15.0 oder höher

Das Feature liegt hinter einem Experiment-Flag, das Sie einmal pro Maschine aktivieren:

```bash
firebase experiments:enable dartfunctions
firebase init functions
```

Wenn der Init-Assistent nach der Sprache fragt, erscheint Dart jetzt neben JavaScript, TypeScript und Python.

## Eine minimale HTTPS-Funktion

Das generierte Gerüst legt eine `functions/bin/server.dart` mit einem HTTPS-Trigger ab. Die Form liegt nah am JS-SDK, liest sich aber wie idiomatisches Dart:

```dart
import 'package:firebase_functions/firebase_functions.dart';

void main(List<String> args) {
  runFunctions((firebase) {
    firebase.https.onRequest(
      name: 'hello',
      (request) async {
        return Response.ok('Hello from Dart!');
      },
    );
  });
}
```

Stellen Sie mit dem gewohnten Befehl bereit und die CLI kompiliert und liefert das Binary für Sie aus:

```bash
firebase deploy --only functions
```

Für lokale Iterationen funktioniert `firebase emulators:start` genauso wie bei Node.js. Heiße Änderungen an Ihren Dart-Dateien laden die emulierte Funktion neu, ohne das Suite-Setup neu zu starten.

## Was noch nicht geht

Das ist eine experimentelle Version und die rauen Kanten sind explizit. Aus der Dokumentation:

- Nur HTTPS- (`onRequest`) und Callable-Trigger (`onCall`) lassen sich bereitstellen. Firestore-, Auth-, Pub/Sub- und geplante Trigger werden noch nicht unterstützt.
- Bereitgestellte Callable-Funktionen können nicht über den `httpsCallable`-Helper des Client-SDKs aufgerufen werden. Sie müssen `httpsCallableFromURL` mit der vollständigen Cloud-Run-URL verwenden.
- Dart-Funktionen tauchen während dieser Preview nicht in der Firebase Console auf. Sie erscheinen stattdessen in der Cloud Console.

Wenn Ihr Backend hauptsächlich auf HTTP-Endpunkten lebt und Ihr Team bereits tief in Dart steckt, reicht das, um einen echten Service zu portieren. Wenn Sie auf Firestore-Trigger oder geplante Jobs angewiesen sind, lohnt es sich, das [firebase-functions-dart-Repo](https://github.com/firebase/firebase-functions-dart) und das [Dart Admin SDK](https://pub.dev/packages/firebase_admin) im Auge zu behalten, aber vorerst auf der Node.js-Laufzeit zu bleiben.

Mehr dazu wird auf der Google I/O 2026 erwartet, wo das Flutter-Team eine [Breakout-Session](https://io.google/2026/explore/pa-keynote-12) zur Ankündigung anbietet.

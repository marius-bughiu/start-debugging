---
title: "Fix: Version solving failed in pubspec.yaml"
description: "Die Korrektur in 30 Sekunden: Lesen Sie die 'because'-Kette im Fehler, finden Sie die eine Einschränkung, die pub blockiert, und erweitern Sie diese entweder oder fügen Sie einen dependency_overrides-Eintrag hinzu. Beginnen Sie nicht mit flutter clean."
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "pubspec"
lang: "de"
translationOf: "2026/05/fix-version-solving-failed-in-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-05-17
---

Die Korrektur in einem Satz: `Version solving failed` ist kein Bug, sondern `dart pub` teilt Ihnen mit, dass die in `pubspec.yaml` angegebenen Einschränkungen nicht gleichzeitig erfüllt werden können. Lesen Sie die Kette der `because ... depends on ...`-Zeilen von unten nach oben, finden Sie die eine Einschränkung, die unmöglich zu erfüllen ist (üblicherweise eine untere Grenze des Dart SDK oder ein Paket, das auf eine ältere Version festgelegt ist, als eine seiner Abhängigkeiten benötigt), und erweitern Sie dann diese Einschränkung oder fügen Sie einen `dependency_overrides`-Eintrag hinzu, um eine bestimmte Version zu erzwingen. `flutter clean` und das Löschen von `pubspec.lock` werden das nicht beheben.

```text
Resolving dependencies...
Because every version of flutter_test from sdk depends on collection 1.19.0
        and my_app depends on collection ^1.18.0, flutter_test from sdk is forbidden.
So, because my_app depends on flutter_test any from sdk, version solving failed.

pub get failed (1; So, because my_app depends on flutter_test any from sdk,
version solving failed.)
exit code 1
```

Diese Anleitung wurde gegen Dart 3.11 und Flutter 3.41.5 geschrieben, den stable-Kanal Stand Mai 2026. Das Verhalten des Resolvers, das unten beschrieben wird, ist derselbe `PubGrub`-Algorithmus, der seit Dart 2.10 in `dart pub` ausgeliefert wird, daher gilt alles hier sauber für jedes Flutter 3.x- oder Dart 3.x-Projekt. Der relevante Quellcode liegt in [dart-lang/pub](https://github.com/dart-lang/pub) unter `lib/src/solver/`.

## Was der Fehler tatsächlich bedeutet

`dart pub get` führt einen Resolver im SAT-Stil namens [PubGrub](https://github.com/dart-lang/pub/blob/master/doc/solver.md) aus. Er geht jede Einschränkung in Ihrer `pubspec.yaml` durch, einschließlich der transitiven Einschränkungen aus der `pubspec.yaml` jeder Abhängigkeit, und versucht, eine einzige Menge von Paketversionen zu finden, in der jede Einschränkung gleichzeitig erfüllt ist. Wenn keine solche Menge existiert, gibt er nach einem Versuch nicht auf. Er macht einen Rückschritt, lernt eine Tatsache darüber, welche Kombinationen unmöglich sind, und versucht es erneut. Die Ausgabe, die Sie sehen, ist die **Erklärung** des Beweises, dass keine Lösung existiert.

Jede Zeile ist eine Tatsache. Lesen Sie von unten nach oben: Die unterste Zeile ist die Schlussfolgerung (`version solving failed`), und die Zeilen darüber sind die Kette von Tatsachen, die diese Schlussfolgerung erzwungen hat. Die Tatsache an der Spitze der Kette ist die Einschränkung, die Sie tatsächlich geschrieben haben, und wahrscheinlich die, die Sie ändern müssen.

Die Fehlermeldung ist strukturiert. Pub benennt jedes relevante Paket, gibt die exakte Einschränkung aus und sagt Ihnen, wer sie fordert. Wenn Sie langsam machen und lesen, gibt es nichts zu raten.

## Eine minimale Reproduktion, die den Fehler zeigt

Erstellen Sie ein frisches Paket und fixieren Sie zwei Abhängigkeiten, deren transitive Einschränkungen sich widersprechen:

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: '>=2.17.0 <3.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.5.0
  some_legacy_package: 0.4.2
```

Führen Sie `flutter pub get` aus und Sie erhalten:

```text
Because http >=1.0.0 requires SDK version >=3.0.0 <4.0.0
        and my_app requires SDK version >=2.17.0 <3.0.0, http >=1.0.0 is forbidden.
So, because my_app depends on http ^1.5.0, version solving failed.
```

Das ist die häufigste Form des Fehlers in realen Projekten. Die Einschränkung, die die Auflösung bricht, ist Ihre eigene untere SDK-Grenze. Das Paket, das Sie angefordert haben, ist in Ordnung; das SDK, das Sie zu unterstützen erklärt haben, ist der unmögliche Teil.

Eine zweite häufige Form ist eine transitive Kollision:

```text
Because flutter_test from sdk depends on collection 1.19.0
        and riverpod 3.0.0 depends on collection ^1.18.0,
        flutter_test from sdk is incompatible with riverpod 3.0.0.
So, because my_app depends on both flutter_test from sdk and riverpod ^3.0.0,
version solving failed.
```

Gleicher Algorithmus, andere Ursache. Hier ist der SDK-Pin von `flutter_test` exakt (`1.19.0`), und `riverpod` akzeptiert alles von `1.18.0` bis ausschließlich `2.0.0`. Beides kann erfüllt werden, wenn Sie `riverpod` auf eine Version aktualisieren, deren untere `collection`-Grenze `1.19.0` oder höher ist. Die Korrektur liegt in der Version, die Sie wählen, nicht in der Syntax der Einschränkung.

## Korrektur, in der Reihenfolge der Häufigkeit als richtige Antwort

Führen Sie die folgenden Schritte der Reihe nach aus. Überspringen Sie nichts. Jeder Schritt setzt voraus, dass der vorherige den Fehler nicht behoben hat.

### 1. Lesen Sie den Fehler und identifizieren Sie den Engpass

Öffnen Sie die Terminal-Ausgabe. Finden Sie die erste `Because ...`-Zeile und die Einschränkung, die ganz oben in der Kette benannt ist. Das ist die unmögliche Tatsache. Im SDK-Beispiel oben ist es `my_app requires SDK version >=2.17.0 <3.0.0`. Im transitiven Beispiel ist es `flutter_test from sdk depends on collection 1.19.0`.

Notieren Sie zwei Dinge:

1. Das Paket, dessen Einschränkung nicht erfüllt werden kann (das **Opfer**).
2. Die Einschränkung, die es einengt (der **Schuldige**).

Wenn Sie beides nicht identifizieren können, haben Sie die Kette nicht sorgfältig genug gelesen. Lesen Sie sie erneut.

### 2. Heben Sie Ihre untere SDK-Grenze an

2026 ist die häufigste Ursache eine veraltete SDK-Einschränkung. Jedes Paket, das in den letzten 18 Monaten veröffentlicht wurde und Dart-3-Funktionen verwendet (records, patterns, sealed classes, die neuen `switch`-Ausdrücke), wird seine SDK-Einschränkung auf `^3.0.0` setzen. Wenn Ihre `pubspec.yaml` immer noch `>=2.17.0 <3.0.0` sagt, können Sie dieses Paket nicht installieren. Aktualisieren Sie auf Caret-Syntax gegen die Dart-Version, die Sie tatsächlich haben:

```yaml
# pubspec.yaml, after running `dart --version`
environment:
  sdk: ^3.0.0
  flutter: '>=3.10.0'
```

Verwenden Sie `^3.0.0` (alles von 3.0.0 bis ausschließlich 4.0.0), nicht `^3.11.0`. Die untere Grenze kommuniziert "dies ist das älteste Dart, gegen das ich getestet habe"; sie gleich der Version auf Ihrem Laptop zu setzen, zwingt jeden Beitragenden ohne Grund zu aktualisieren. Siehe die [pubspec-Dokumentation](https://dart.dev/tools/pub/pubspec) zur Syntax.

### 3. Aktualisieren Sie die widersprüchliche Abhängigkeit

Wenn der Schuldige ein Drittanbieterpaket ist, ist die zweithäufigste Korrektur, dass Sie auf eine alte Major-Version festgelegt sind. `flutter pub outdated` zeigt Ihnen jede Abhängigkeit, welche Version aufgelöst wurde und welche die aktuellste ist:

```bash
# Flutter 3.41.5
flutter pub outdated
```

Suchen Sie nach dem Paket, das in Schritt 1 benannt wurde. Wenn seine **latest**-Spalte höher ist als Ihre aktuelle, führen Sie aus:

```bash
flutter pub upgrade --major-versions <package_name>
```

Dies schreibt die Einschränkung in `pubspec.yaml` auf die neueste kompatible Major-Version um und führt den Resolver erneut aus. Wenn das Paket semver folgt, müssen Sie möglicherweise inkompatible Änderungen in Ihrem Code beheben, aber der Resolver-Fehler verschwindet.

### 4. Lockern Sie eine zu enge Einschränkung

Wenn Sie eine Einschränkung von Hand geschrieben und sie enger als nötig festgelegt haben, erweitern Sie sie. Die zwei häufigsten Über-Fixierungsfehler:

```yaml
# Zu eng: exakter Pin
some_package: 1.5.3

# Zu eng: Caret auf eine Pre-1.0-Version
some_package: ^0.4.2  # erlaubt >=0.4.2 <0.5.0, oft zu schmal
```

Ersetzen Sie durch einen Caret auf der Major-Version (`^1.5.3` erlaubt `>=1.5.3 <2.0.0`) oder durch einen expliziten Bereich, der die Versionen abdeckt, die Sie akzeptieren wollen (`'>=0.4.0 <0.6.0'`). Die [Dart-Dokumentation zu Abhängigkeitseinschränkungen](https://dart.dev/tools/pub/dependencies) erklärt die Caret-Syntax sowohl für Pre-1.0- als auch für Post-1.0-Pakete.

### 5. Verwenden Sie `dependency_overrides` für transitive Konflikte, die Sie nicht beheben können

Wenn der Schuldige eine transitive Abhängigkeit ist, über die sich zwei Ihrer direkten Abhängigkeiten uneinig sind, und keine ein Release hat, das den Konflikt löst, überschreiben Sie sie explizit. Dies gehört nur in die `pubspec.yaml` des Root-Pakets; Overrides in einer Abhängigkeit, die Sie konsumieren, werden vom Resolver ignoriert.

```yaml
# pubspec.yaml, Flutter 3.41.5, Dart 3.11
name: my_app
environment:
  sdk: ^3.0.0

dependencies:
  flutter:
    sdk: flutter
  riverpod: ^3.0.0
  some_other_package: ^2.0.0

dependency_overrides:
  collection: ^1.19.0
```

`dependency_overrides` ist ein Vorschlaghammer. Der Resolver erzwingt keine Einschränkungen mehr für das überschriebene Paket und verwendet Ihre Version überall, wo es im Graphen erscheint. Wenn ein Konsument von `collection` auf eine in `1.19.0` entfernte API angewiesen war, wird kompiliert, aber zur Laufzeit schlägt es fehl. Verwenden Sie dies nur, nachdem Sie überprüft haben, dass die erzwungene Version tatsächlich kompatibel ist, und entfernen Sie den Override, sobald die Upstream-Abhängigkeit aufholt.

### 6. Letztes Mittel: `pubspec.lock` neu generieren

Die Lockfile liegt stromabwärts der Auflösung, nicht stromaufwärts. Sie zu löschen kann ein Einschränkungsproblem nicht beheben, und die meisten Blogposts, die das als ersten Schritt empfehlen, liegen falsch. Die einzige Zeit, in der das Löschen von `pubspec.lock` hilft, ist, wenn Sie `pubspec.yaml` bereits geändert haben und die Lockfile jetzt den Resolver daran hindert, eine neue kompatible Version zu wählen:

```bash
# Flutter 3.41.5
rm pubspec.lock
flutter pub get
```

Tun Sie das nur nach Schritt 1 bis 5. Wenn `pub get` nach dem Neugenerieren der Lockfile immer noch fehlschlägt, sind die Einschränkungen immer noch unmöglich, und Sie haben nichts wirklich behoben.

## Fallstricke und ähnlich aussehende Fälle

Einige Fälle, die einen ähnlichen Fehler erzeugen oder wie Version-Solving aussehen, aber keiner sind:

- **`pub get failed (server unavailable)`**: Dies ist ein Netzwerk- oder Registry-Problem, kein Auflösungsproblem. Prüfen Sie `PUB_HOSTED_URL`, falls Sie es gesetzt haben; eine falsche Mirror-URL liefert 404er zurück, und der Fehler erscheint in der Nähe von, aber nicht als `version solving failed`.
- **`The current Dart SDK version is X.Y.Z. Because my_app requires SDK version ^A.B.C, version solving failed.`**: Dies ist die direkteste Form des Fehlers. Sie haben `flutter pub get` mit einem Dart SDK ausgeführt, das älter ist, als Ihre eigene `pubspec.yaml` deklariert. Aktualisieren Sie entweder Flutter (`flutter upgrade`) oder senken Sie die Einschränkung.
- **`pub get` funktioniert lokal, schlägt aber in CI fehl**: Ihre CI-Flutter-Version ist älter als Ihre lokale. Fixieren Sie die Flutter-Version in CI passend. Der Beitrag [wie Sie aus einer einzigen CI-Pipeline mehrere Flutter-Versionen targetieren](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) behandelt das Matrix-Muster.
- **`Gradle build failed to produce an .apk file` direkt nach einem `pub get`**: Überhaupt kein Resolver-Fehler. Die native Build-Stufe schlägt fehl. Siehe [Gradle build failed to produce an apk file](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) (dieselbe Korrektur gilt für Flutter Android).
- **Pre-Release-Versionen werden stillschweigend ignoriert**: Standardmäßig wählt der Resolver kein `2.0.0-beta.1`, wenn Sie `^1.0.0` anfordern, selbst wenn es kein stabiles `2.0.0` gibt. Um es zu aktivieren, verwenden Sie die explizite Version: `some_package: ^2.0.0-beta.1`.
- **Ein Paket mit `git:`- oder `path:`-Abhängigkeiten**: Der Resolver wendet weiterhin Versionseinschränkungen an, aber die Quelle ist die git-Referenz oder der Pfad, den Sie geschrieben haben, nicht pub.dev. Ein fehlgeschlagenes Version-Solve auf einer git-Abhängigkeit liegt fast immer daran, dass die `pubspec.yaml` des referenzierten Branches selbst kaputt ist; klonen Sie das Paket lokal und führen Sie `dart pub get` darin aus, um es zu sehen.

Wenn Sie öfter als einmal pro Quartal zu `dependency_overrides` greifen, hat Ihr Abhängigkeitsbaum strukturelle Probleme. Entweder verwenden Sie zu viele Pakete aus derselben Mikro-Domäne (drei HTTP-Clients, zwei State-Manager), oder Ihre direkten Abhängigkeiten halten mit ihren eigenen transitiven nicht Schritt. Den Baum zu beschneiden behebt mehr Resolver-Fehler als jede einzelne Einschränkungsbearbeitung.

## Verwandt

- [Fix: FormatException: Unexpected character beim Parsen von JSON in Dart](/de/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/)
- [Fix: A RenderFlex overflowed by N pixels in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/)
- [Wie Sie aus einer einzigen CI-Pipeline mehrere Flutter-Versionen targetieren](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Wie Sie einen Dart-Isolate für CPU-gebundene Arbeit schreiben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Wie Sie Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)

## Quellen

- [The pubspec file](https://dart.dev/tools/pub/pubspec) (dart.dev)
- [Package dependencies](https://dart.dev/tools/pub/dependencies) (dart.dev)
- [PubGrub solver design doc](https://github.com/dart-lang/pub/blob/master/doc/solver.md) (dart-lang/pub)
- [dart-lang/pub issue 2470: "version solving failed"](https://github.com/dart-lang/pub/issues/2470) (kanonischer Bug-Report-Thread)
- [dart-lang/pub issue 3755: SDK version constraint edge cases](https://github.com/dart-lang/pub/issues/3755)

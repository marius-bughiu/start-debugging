---
title: "Eine Flutter-2-App auf Flutter 3.x migrieren: die Null-Safety-Checkliste"
description: "Eine versionsfixierte Anleitung, um eine alte Flutter-2.x-App auf eine aktuelle Flutter-3.x-Version zu bringen, mit der Migration zu Sound Null Safety als harter Hürde: warum Sie einen Weg in zwei Schritten über Dart 2.19 brauchen, was dart migrate tut und was dabei kaputtgeht."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "flutter"
  - "flutter-2"
  - "flutter-3"
  - "dart"
  - "null-safety"
lang: "de"
translationOf: "2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist"
translatedBy: "claude"
translationDate: 2026-06-16
---

Wenn Sie noch eine Flutter-2.x-App haben, die sich gegen Sound Null Safety entschieden hat, können Sie nicht direkt auf eine aktuelle Flutter-3.x-Version springen. Dart 3, das mit Flutter 3.10 (Mai 2023) kam, hat unsicheres (unsound) Null Safety vollständig entfernt und das Werkzeug `dart migrate` gelöscht. Das Upgrade ist daher eine Migration in zwei Schritten: zuerst die Codebasis auf Dart 2.19 (Flutter 3.7.x) null-safe machen, dann auf die neueste Flutter-3.x-Version anheben. Rechnen Sie mit einem Tag für eine kleine App und drei bis fünf Tagen für eine große mit vielen transitiven Abhängigkeiten. Der Null-Safety-Durchlauf ist die Hürde; alles andere (Gradle, iOS-Mindestwerte, entfernte Widgets) ist mechanisch, sobald der Analyzer grün ist. Diese Anleitung fixiert Flutter 2.10 / Dart 2.16 als Ausgangspunkt und eine aktuelle Flutter-3.x-Linie mit Dart 3 als Ziel.

## Warum dies eine Reise in zwei Schritten ist, nicht in einem

Der erste Impuls ist, das neueste Flutter herunterzuladen, `flutter pub get` auszuführen und zu reparieren, was kaputtgeht. Bei einer unsound Flutter-2-App scheitert das sofort, weil das benötigte Werkzeug im Ziel-SDK nicht mehr existiert.

Sound Null Safety kam als optional mit Dart 2.12 (Flutter 2.0, März 2021). Zwei Jahre lang erlaubte ein gemischter Modus die Koexistenz von null-safe und alten Bibliotheken. Dart 3 hat das beendet. Aus der offiziellen Anleitung: "In Dart 3, null safety is built in; you cannot turn it off." Eine nie migrierte Bibliothek erzeugt zur Auflösungszeit:

```
Because pkg1 doesn't support null safety, version solving failed.
The lower bound of "sdk: '>=2.9.0 <3.0.0'" must be 2.12.0 or higher to enable null safety.
```

und zur Laufzeit, auf der alten Engine, `Library doesn't support null safety`. Das interaktive Werkzeug `dart migrate`, das dies behebt, wurde in Dart 3 entfernt. Dart 2.19.6 ist das letzte SDK, das es enthält. Der einzige unterstützte Weg lautet also: zu Null Safety migrieren, solange Sie noch auf einem Dart-2.x-SDK sind, und danach das SDK aktualisieren.

## Warum 2026 migrieren

- Jedes aktuelle Paket auf pub.dev verlangt eine Dart-3-SDK-Beschränkung (`sdk: '>=3.0.0 <4.0.0'`). Auf Flutter 2 zu bleiben sperrt Sie aus von neuen Versionen von `http`, `provider`, `go_router` und allen Firebase-Plugins, einschließlich ihrer Sicherheits-Patches.
- Dart 3 hat Records, Pattern, versiegelte Klassen und Klassenmodifikatoren freigeschaltet. Keines davon kompiliert auf einer Flutter-2-Toolchain.
- Sound Null Safety ist ein echter Korrektheitsgewinn: der Compiler beweist, dass ein `String` nie `null` ist, sodass eine ganze Klasse von `NoSuchMethodError: The method '...' was called on null`-Abstürzen unmöglich auszuliefern wird. Wenn Sie diesen Fehler je in Produktion gejagt haben, ist dies die Lösung auf Ebene des Typsystems.
- Die Anforderungen der App-Stores von Apple und Google (Mindest-SDK-Level, 64 Bit, aktuelle Build-Werkzeuge) sind weit über das hinausgewachsen, was ein Flutter-2-Build erfüllen kann.

## Was kaputtgeht

Die Schwere gibt an, wie wahrscheinlich die Änderung eine typische App bricht, nicht wie schwer die Lösung ist.

| Bereich | Änderung | Schwere |
| ------- | -------- | ------- |
| Null Safety | Der unsound-Modus wurde in Dart 3 entfernt; jede Zeile Ihres Codes und jede Abhängigkeit muss null-safe sein | hoch |
| Werkzeug `dart migrate` | In Dart 3 entfernt; existiert nur bis Dart 2.19.6 | hoch |
| SDK-Beschränkung | Die Untergrenze in `pubspec.yaml` muss `2.12.0`, dann `3.0.0` sein | hoch |
| Abhängigkeiten | Jedes Paket ohne null-safe Version blockiert die gesamte Auflösung | hoch |
| Entfernte veraltete Widgets | `ThemeData.accentColor`, `textSelectionColor`, `toggleableActiveColor` in der 3.0-Bereinigung veralteter APIs entfernt | hoch |
| Android-Toolchain | Die Mindestwerte für Gradle, Android Gradle Plugin und Kotlin stiegen; alte `build.gradle` schlagen fehl | hoch |
| iOS-Minimum | Das minimale Deployment-Target stieg auf iOS 12; 32-Bit-armv7 wurde fallengelassen | mittel |
| Plugin-Embedding | Apps noch im v1-Android-Embedding müssen auf v2 wechseln | mittel |

## Pre-Flight-Checkliste

Erledigen Sie all dies, bevor Sie Code anfassen:

- Committen Sie eine saubere Basis und versehen Sie sie mit einem Tag: `git tag pre-flutter3-migration`. Sie werden mehr als einmal dorthin zurückkehren.
- Notieren Sie Ihre genauen aktuellen Versionen: `flutter --version` und `dart --version`. Fixieren Sie sie irgendwo, damit die Migration reproduzierbar ist.
- Stellen Sie sicher, dass die CI die App zuerst auf dem alten SDK grün baut. Auf einem bereits kaputten Build zu migrieren verschwendet Stunden.
- Installieren Sie eine Dart-2.19- / Flutter-3.7.12-Toolchain neben der aktuellen. Verwenden Sie `fvm` (Flutter Version Management), um pro Projekt zu wechseln: `fvm install 3.7.12`.
- Inventarisieren Sie die Abhängigkeiten: `flutter pub deps --no-dev` und notieren Sie alles Ungewartete. Ein einziges aufgegebenes Paket ohne null-safe Version kann die gesamte Migration zum Stillstand bringen.

## Migrationsschritte

1. **Fixieren Sie Flutter 3.7.12 (Dart 2.19) für die Migration.** Dies ist die letzte Toolchain mit `dart migrate`. Mit `fvm` führen Sie im Projekt `fvm use 3.7.12` aus, dann `fvm flutter --version`, um `Dart 2.19.x` zu bestätigen. Überprüfung: `fvm flutter pub get` löst ohne SDK-Fehler auf.

2. **Prüfen Sie die Bereitschaft der Abhängigkeiten, bevor Sie eigenen Code migrieren.** Führen Sie `dart pub outdated --mode=null-safety` aus. Es gibt eine Tabelle aus, die zeigt, welche Pakete bereits null-safe Versionen haben und welche nicht. Überprüfung: jede direkte Abhängigkeit zeigt eine auflösbare null-safe Version in der Spalte "Upgradable" oder "Resolvable". Wenn eine das nicht tut, suchen Sie jetzt einen Ersatz oder forken Sie sie, bevor Sie weitermachen.

3. **Aktualisieren Sie die Abhängigkeiten von unten nach oben auf ihre null-safe Versionen.** Abhängigkeiten migrieren in Reihenfolge: wenn C von B abhängt, das von A abhängt, dann muss A zuerst null-safe sein. Die Werkzeuge übernehmen die Reihenfolge, wenn Sie `dart pub upgrade --null-safety` gefolgt von `dart pub get` ausführen. Überprüfung: `pubspec.lock` listet nun null-safe Versionen und `dart pub get` endet mit 0.

4. **Führen Sie das interaktive Migrationswerkzeug auf Ihrem Code aus.** Führen Sie im Projektstamm `dart migrate` aus. Es analysiert das gesamte Paket, schlägt für jeden Typ Nullbarkeit vor und stellt eine lokale Web-Oberfläche bereit, in der Sie jedes abgeleitete `?`, `late` und `required` prüfen. Wo es falsch rät, lenken Sie es mit Hinweismarkierungen im Quelltext: `/*?*/` erzwingt nullable, `/*!*/` erzwingt non-nullable, `/*late*/` markiert späte Initialisierung, `/*required*/` markiert einen erforderlichen Parameter. Überprüfung: das Werkzeug meldet in seiner Zusammenfassung null verbleibende Analysefehler, bevor Sie anwenden.

5. **Wenden Sie die Migration an und heben Sie die SDK-Beschränkung an.** Klicken Sie auf "Apply migration". Das Werkzeug schreibt Ihre `.dart`-Dateien um, entfernt die Hinweiskommentare und setzt die Untergrenze in `pubspec.yaml`:

   ```yaml
   # pubspec.yaml -- after the null safety migration, still on Dart 2.19
   environment:
     sdk: '>=2.12.0 <3.0.0'
   ```

   Überprüfung: `dart analyze` meldet keine Fehler und `flutter test` besteht auf Flutter 3.7.12. Committen Sie dies als eigenständigen Checkpoint: Sie haben jetzt eine sound, null-safe App, die noch auf der alten Toolchain läuft.

6. **Wechseln Sie zur aktuellen Flutter-3.x-Toolchain.** Machen Sie nun den zweiten Schritt. Führen Sie `fvm install stable` und `fvm use stable` aus (oder Ihr fixiertes Ziel wie `3.35.x`). Heben Sie die SDK-Beschränkung auf Dart 3 an:

   ```yaml
   # pubspec.yaml -- targeting the current Flutter 3.x / Dart 3 line
   environment:
     sdk: '>=3.0.0 <4.0.0'
     flutter: '>=3.10.0'
   ```

   Führen Sie `flutter pub get` aus. Überprüfung: die Auflösung gelingt. Schlägt sie mit "version solving failed" fehl, fehlt einer Abhängigkeit noch eine Dart-3-Beschränkung; führen Sie `dart pub outdated` aus, um sie zu finden. Derselbe Fehler tritt auch bei einfachen pubspec-Fehlern auf; siehe die [Lösung für version solving failed](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) für den vollständigen Entscheidungsbaum.

7. **Beseitigen Sie Fehler durch entfernte und veraltete APIs mit `dart fix`.** Flutter 3.0 löschte APIs, die in der 2.x-Linie veraltet waren. Führen Sie `dart fix --dry-run` zur Vorschau aus, dann `dart fix --apply`, um die mechanischen automatisch umzuschreiben. Die häufigsten Opfer sind Theme-Eigenschaften: `ThemeData.accentColor` ist weg, was genau der [accentColor-Kompilierfehler](/de/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/) ist, über den fast jedes 2-auf-3-Upgrade stolpert. Überprüfung: `flutter analyze` ist sauber.

8. **Reparieren Sie die Android-Build-Werkzeuge.** Ein Flutter-2-Ordner `android/` hat fast immer Gradle-, AGP- und Kotlin-Versionen, die für das neue Embedding zu alt sind. Aktualisieren Sie `android/gradle/wrapper/gradle-wrapper.properties`, `android/build.gradle` und `android/app/build.gradle` auf die Versionen, die das aktuelle Flutter erwartet (die `flutter create`-Vorlage für eine Wegwerf-App ist die Referenz). Überprüfung: `flutter build apk --debug` gelingt. Stoßen Sie auf einen `AndroidX conflict`, führt Sie die [Lösung des AndroidX-Konflikts](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/) durch die Auflösung.

## Verifikation

Führen Sie nach Schritt 8 diesen Smoke-Test auf beiden Plattformen aus:

- `flutter analyze` meldet null Probleme.
- `flutter test` besteht mit derselben Anzahl wie Ihre Basis vor der Migration. Ein Rückgang bedeutet, dass eine Testdatei still nicht kompiliert hat.
- `flutter build apk --release` und `flutter build ios --release --no-codesign` gelingen beide.
- Starten Sie auf einem echten Gerät, nicht nur im Simulator, und durchlaufen Sie die Bildschirme, die zuvor mit Null-Fehlern abstürzten. Sound Null Safety sollte diese Fehlermodi vollständig entfernt haben.
- Vergleichen Sie die App-Startzeit und die Frame-Zeiten mit der getaggten Basis. Der AOT-Compiler von Dart 3 ist im Allgemeinen schneller, aber prüfen Sie es, statt es anzunehmen.

## Rollback-Plan

Die Null-Safety-Migration ist auf Code-Ebene praktisch eine Einbahnstraße: sobald Typen `?` und `late` tragen, ist das händische Zurücksetzen undurchführbar. Deshalb ist Schritt 5 ein eigenständiger Commit. Geht der Dart-3-Schritt (Schritte 6 bis 8) schief, machen Sie die Null-Safety-Arbeit nicht rückgängig: Sie setzen mit `git reset --hard` auf den Checkpoint von Schritt 5 zurück, der eine voll funktionsfähige null-safe App auf Flutter 3.7.12 ist, und versuchen die Toolchain-Anhebung erneut. Behalten Sie das Tag `pre-flutter3-migration`, bis der neue Build einen Release-Zyklus in Produktion hinter sich hat.

## Fallen, in die wir traten

**Eine aufgegebene Abhängigkeit ohne null-safe Version.** Dies ist mit Abstand der häufigste Blocker. `dart pub outdated --mode=null-safety` markiert ihn, aber die Lösung ist menschlich: ersetzen Sie das Paket, forken und migrieren Sie es selbst, oder nehmen Sie es in Ihr eigenes Repository auf. Entscheiden Sie das im Pre-Flight, denn es mitten in der Migration zu entdecken bedeutet Rückschritt.

**`late` als Krücke.** Das Migrationswerkzeug markiert ein Feld bereitwillig als `late`, um Sie nicht zu einem Initialisierer zu zwingen. Jedes `late` ist ein aufgeschobener `LateInitializationError`, der auf einen Code-Pfad wartet, der vor dem Schreiben liest. Prüfen Sie jedes vom Werkzeug eingefügte `late` und bevorzugen Sie einen echten nullable Typ oder die Initialisierung im Konstruktor, wo der Lebenszyklus nicht lückenlos ist.

**`dynamic` verbirgt Nulls vor dem Analyzer.** Null Safety schützt nur statisch typisierten Code. Als `dynamic` typisierte Felder und JSON-Maps lassen `null` weiterhin durch und stürzen an der Verwendungsstelle ab. Die Migration ist der richtige Moment, Ihren `fromJson`-Factories echte Typen zu geben; ein falsch typisiertes Feld dort wirft `FormatException` oder einen Null-Absturz, den das Typsystem nicht abfangen kann. Wenn Sie viel JSON parsen, straffen Sie diese Modelle, solange Sie hier sind.

**Plugin-v1-Embedding.** Apps, die älter als das v2-Android-Embedding sind, schlagen im aktuellen Flutter mit einem `MainActivity`- oder `FlutterApplication`-Fehler beim Build fehl. Regenerieren Sie `android/app/src/main/.../MainActivity.kt` aus der aktuellen Vorlage und entfernen Sie die alten `GeneratedPluginRegistrant`-Referenzen.

**Die Zwischen-Toolchain überspringen.** Es ist verlockend, das aktuelle Flutter zu installieren und sich durchzukämpfen. Ohne `dart migrate` annotieren Sie Tausende von Typen aus Analyzer-Fehlern von Hand, was genau die Arbeit ist, die das Werkzeug automatisiert. Machen Sie die zwei Schritte.

## Verwandt

- [Fix: version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Flutter: the getter accentColor isn't defined for the class ThemeData](/de/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/)
- [Fix: AndroidX-Konflikt während eines Flutter-Android-Builds](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/)
- [Wie man eine Flutter-App von GetX auf Riverpod migriert](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)
- [Provider vs Riverpod vs Bloc für Flutter-State-Management 2026](/de/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)

## Quellen

- [Dart 3 migration guide](https://dart.dev/resources/dart-3-migration) -- Null Safety verpflichtend in Dart 3, `dart migrate` entfernt, zuerst mit Dart 2.19 migrieren.
- [Migrating to null safety](https://github.com/dart-community/migrate-to-null-safety/blob/main/docs/migrate.md) -- `dart pub outdated --mode=null-safety`, `dart migrate`, Hinweismarkierungen, Abhängigkeitsreihenfolge von unten nach oben, Dart 2.19.6 als letztes SDK mit dem Werkzeug.
- [Flutter breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes) -- die Liste entfernter und geänderter APIs pro Version.
</content>

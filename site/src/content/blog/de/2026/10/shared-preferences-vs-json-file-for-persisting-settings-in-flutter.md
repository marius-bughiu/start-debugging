---
title: "shared_preferences vs eine JSON-Datei mit path_provider zum Speichern von Einstellungen in Flutter"
description: "shared_preferences (SharedPreferencesWithCache) für eine Handvoll flacher Flags, eine JSON-Datei in getApplicationSupportDirectory für ein strukturiertes Einstellungsobjekt. Behandelt das atomare Schreibmuster, die Race Condition bei parallelen Speichervorgängen, die Documents-Ordner-Falle unter Windows und Linux, Web-Unterstützung und gemessene Schreibkosten unter Flutter 3.44.8."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "shared-preferences"
  - "path-provider"
  - "local-storage"
lang: "de"
translationOf: "2026/10/shared-preferences-vs-json-file-for-persisting-settings-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-30
---

Bestehen Ihre Einstellungen aus einem Dutzend flacher, voneinander unabhängiger Werte (Theme, ein "Onboarding gesehen"-Flag, der zuletzt gewählte Tab), dann ist `shared_preferences` mit der API `SharedPreferencesWithCache` die richtige Wahl: synchrone Lesezugriffe, Web-Unterstützung, keine Dateiverwaltung. Sobald die Einstellungen zu einem einzigen strukturierten Objekt mit verschachtelten Maps, Listen oder einem Schema werden, das migriert werden muss, wechseln Sie zu einer einzelnen JSON-Datei, die atomar (temporäre Datei plus Rename, serialisiert) in `getApplicationSupportDirectory()` geschrieben wird, nicht in `getApplicationDocumentsDirectory()`. Alles Folgende wurde unter Flutter 3.44.8 (Dart 3.12.2) mit `shared_preferences` 2.5.6 und `path_provider` 2.1.6 getestet, als echter macOS-Debug-Build auf einem Apple M4.

## Der Vergleich auf einen Blick

| | `shared_preferences` 2.5.6 | JSON-Datei über `path_provider` 2.1.6 |
| --- | --- | --- |
| Werttypen | `bool`, `int`, `double`, `String`, `List<String>` | Alles, was `jsonEncode` verarbeitet (verschachtelte Maps, Listen, Nulls) |
| Lese-API | Synchron (`SharedPreferencesWithCache`) oder asynchron (`SharedPreferencesAsync`) | Einmal asynchron laden, danach Ihr eigenes Objekt im Speicher |
| Dauerhaftigkeit von Schreibvorgängen | "Keine Garantie", dass Schreibvorgänge beim Return auf der Platte sind (README) | Sie steuern es selbst: `flush: true` + atomarer Rename |
| Teilaktualisierungen | Pro Schlüssel, eingebaut | Komplette Datei neu schreiben (unproblematisch unter einigen hundert KB) |
| Schemamigration | Pro Schlüssel, manuell | Ein Feld `schemaVersion`, eine Migrationsfunktion |
| Web | Ja (`localStorage`) | Nein: `path_provider` hat keine Web-Implementierung |
| Speicherort unter Android | DataStore Preferences (neue APIs) oder `SharedPreferences` (Legacy) | Eine Datei im privaten Datenverzeichnis der App |
| Speicherort unter iOS/macOS | `NSUserDefaults`-Plist | Eine Datei in Application Support |
| Lesbar für nativen Code / Widgets | Ja, es ist der Plattformspeicher | Nur wenn nativer Code Ihre Datei liest |
| Fallstricke bei Nebenläufigkeit | Caches pro Isolate veralten | Parallele Speichervorgänge zerstören die temporäre Datei, wenn sie nicht serialisiert werden |
| Eigener Code | Fast keiner | Etwa 60 Zeilen |

Keines von beiden ist "die Datenbank". Wer Benutzerinhalte, wachsende Listen oder abzufragende Daten speichert, braucht SQLite (drift, sqflite), keine der beiden Varianten.

## Wann shared_preferences die richtige Wahl ist

- **Eine Handvoll flacher, unabhängiger Flags.** `onboardingDone`, `themeMode`, `lastTabIndex`, `analyticsOptIn`. Jeder Schlüssel wird für sich gelesen und geschrieben, es gibt keine Beziehungen zwischen ihnen, und ein verlorener Schreibvorgang kostet höchstens, dass ein Dialog zweimal erscheint.
- **Der Wert wird beim Start synchron gebraucht.** `SharedPreferencesWithCache` lädt alles einmal in `create()`, danach ist jeder Getter synchron. Das Theme lässt sich also in `build()` ohne `FutureBuilder` lesen.
- **Die App läuft im Web.** `shared_preferences_web` 2.4.3 bildet auf `localStorage` ab. Der JSON-Datei-Ansatz läuft dort überhaupt nicht, weil `File` aus `dart:io` im Browser nicht existiert und `path_provider` keine Web-Unterstützung aufführt.
- **Nativer Code braucht denselben Wert.** Ein Homescreen-Widget, eine Notification Extension oder eine bestehende native App, von der Sie migrieren, liest `NSUserDefaults` oder Androids `SharedPreferences` direkt. Eine eigene JSON-Datei ist für all diese unsichtbar.

Das ist die Version, die ich heute ausliefern würde. Sie verwendet `SharedPreferencesWithCache` mit einer Allow List, die das README für neuen Code statt der Legacy-Klasse `SharedPreferences` empfiehlt:

```dart
// Flutter 3.44.8, Dart 3.12.2, shared_preferences 2.5.6
import 'package:shared_preferences/shared_preferences.dart';

class PrefsSettingsStore {
  PrefsSettingsStore._(this._prefs);

  final SharedPreferencesWithCache _prefs;

  static const _themeMode = 'themeMode';
  static const _fontScale = 'fontScale';
  static const _onboardingDone = 'onboardingDone';

  static Future<PrefsSettingsStore> open() async {
    final prefs = await SharedPreferencesWithCache.create(
      cacheOptions: const SharedPreferencesWithCacheOptions(
        allowList: {_themeMode, _fontScale, _onboardingDone},
      ),
    );
    return PrefsSettingsStore._(prefs);
  }

  // Synchronous reads after open(): safe to call from build().
  String get themeMode => _prefs.getString(_themeMode) ?? 'system';
  double get fontScale => _prefs.getDouble(_fontScale) ?? 1.0;
  bool get onboardingDone => _prefs.getBool(_onboardingDone) ?? false;

  Future<void> setThemeMode(String value) => _prefs.setString(_themeMode, value);
  Future<void> setFontScale(double value) => _prefs.setDouble(_fontScale, value);
  Future<void> completeOnboarding() => _prefs.setBool(_onboardingDone, true);
}
```

Die Allow List ist keine Dekoration. Mit ihr wirft ein Tippfehler wie `getString('themMode')` einen `ArgumentError` ("themMode is not included in the PreferencesFilter allowlist"), statt stillschweigend `null` zurückzugeben, und `clear()` entfernt nur Ihre Schlüssel statt allem, was das Plugin sehen kann.

## Wann eine JSON-Datei die richtige Wahl ist

- **Die Einstellungen sind ein Objekt, keine Sammlung von Schlüsseln.** Benachrichtigungseinstellungen pro Kanal, eine Liste gespeicherter Filter, Overrides pro Konto. Wer das in Schlüssel wie `notifications.replies`, `notifications.digest`, `filters.0.name` plattdrückt, landet bei halb aktualisiertem Zustand, sobald die App zwischen zwei `setString`-Aufrufen beendet wird.
- **Eine Schemaversion wird gebraucht.** Mit einer Datei schreiben Sie einmal `"schemaVersion": 2` und führen beim Laden eine einzige Migrationsfunktion aus. Mit Schlüsseln migrieren Sie jeden einzeln und hoffen, dass zwischendurch keiner von einem älteren Build geschrieben wurde.
- **Eine echte Dauerhaftigkeitsgarantie ist nötig.** Das README von `shared_preferences` sagt klar, dass es keine Garantie gibt, dass Schreibvorgänge beim Return auf der Platte persistiert sind, und dass das Plugin nicht für kritische Daten gedacht ist. Mit einer eigenen Datei liefern `flush: true` und ein atomarer Rename nach einem Absturz entweder die alten oder die neuen Einstellungen, nie eine abgeschnittene Mischung.
- **Die Einstellungen sollen als Text exportiert, gesichert oder debuggt werden.** Ein Support-Mitarbeiter kann einen Desktop-Benutzer bitten, `settings.json` anzuhängen. Niemand wird einen Benutzer zu einem DataStore-Protobuf lotsen.

Der folgende Store ist der, den ich verwende. Achten Sie auf die drei Details, die die meisten Tutorials auslassen: das Verzeichnis, den atomaren Schreibvorgang und die Schreibwarteschlange.

```dart
// Flutter 3.44.8, Dart 3.12.2, path_provider 2.1.6
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

class AppSettings {
  const AppSettings({
    this.themeMode = 'system',
    this.fontScale = 1.0,
    this.notifications = const {'replies': true, 'digest': 'weekly'},
  });

  final String themeMode;
  final double fontScale;
  final Map<String, Object?> notifications;

  static const schemaVersion = 2;

  AppSettings copyWith({String? themeMode, double? fontScale}) => AppSettings(
        themeMode: themeMode ?? this.themeMode,
        fontScale: fontScale ?? this.fontScale,
        notifications: notifications,
      );

  Map<String, Object?> toJson() => {
        'schemaVersion': schemaVersion,
        'themeMode': themeMode,
        'fontScale': fontScale,
        'notifications': notifications,
      };

  factory AppSettings.fromJson(Map<String, dynamic> json) => AppSettings(
        themeMode: json['themeMode'] as String? ?? 'system',
        fontScale: (json['fontScale'] as num?)?.toDouble() ?? 1.0,
        notifications:
            (json['notifications'] as Map<String, dynamic>?) ?? const {},
      );
}

class JsonSettingsStore {
  JsonSettingsStore._(this._file);

  final File _file;
  Future<void> _tail = Future<void>.value();

  static Future<JsonSettingsStore> open() async {
    // Application Support, not Documents: see the Windows/Linux gotcha below.
    final dir = await getApplicationSupportDirectory();
    await dir.create(recursive: true);
    return JsonSettingsStore._(File('${dir.path}/settings.json'));
  }

  Future<AppSettings> load() async {
    if (!await _file.exists()) return const AppSettings();
    try {
      final json = jsonDecode(await _file.readAsString()) as Map<String, dynamic>;
      return AppSettings.fromJson(_migrate(json));
    } on FormatException {
      // Truncated or hand-edited file: keep a copy for diagnostics, start fresh.
      await _file.copy('${_file.path}.corrupt');
      return const AppSettings();
    }
  }

  Future<void> save(AppSettings settings) {
    // Chain every write so two saves never share the temp file.
    return _tail = _tail.then((_) => _writeAtomic(settings.toJson()));
  }

  Future<void> _writeAtomic(Map<String, Object?> data) async {
    final tmp = File('${_file.path}.tmp');
    await tmp.writeAsString(jsonEncode(data), flush: true);
    await tmp.rename(_file.path);
  }

  static Map<String, dynamic> _migrate(Map<String, dynamic> json) {
    final version = json['schemaVersion'] as int? ?? 1;
    if (version < 2) {
      // v1 stored a bool 'darkMode'; v2 stores a 'themeMode' string.
      json['themeMode'] = (json.remove('darkMode') as bool? ?? false) ? 'dark' : 'light';
    }
    return json;
  }
}
```

Laden Sie ihn einmal beim Start, halten Sie das `AppSettings` in Ihrer State-Management-Schicht (ein `ValueNotifier`, ein Riverpod-`Notifier`, was auch immer Sie schon verwenden) und rufen Sie bei jeder Änderung `save()` auf. Lesezugriffe berühren nach dem Start nie die Platte, genau der Kompromiss, den `SharedPreferencesWithCache` für Sie eingeht.

## Die Race Condition bei parallelen Speichervorgängen, die naive JSON-Stores bricht

Die verbreitetste Variante dieses Musters im Netz ist `writeAsString` in eine `.tmp`-Datei, dann `rename`, ohne Warteschlange. Das sieht atomar aus. Für einen einzelnen Aufrufer ist es das auch. Hängt man es an das `onChanged` eines Sliders, entstehen viele überlappende Speichervorgänge, die sich denselben temporären Pfad teilen. Ich habe in reinem Dart 3.12.2 gleichzeitig 50 Speichervorgänge ohne `await` abgesetzt:

```dart
// Dart 3.12.2
await Future.wait([
  for (var i = 0; i < 50; i++)
    writeAtomic(file, {'counter': i}).catchError((Object e) { errors++; }),
]);
```

Ergebnis: 49 der 50 Schreibvorgänge warfen `PathNotFoundException: Cannot rename file ... (OS Error: No such file or directory, errno = 2)`. Der erste Rename hat die temporäre Datei weggeschoben, und jeder weitere Speichervorgang versuchte, eine Datei umzubenennen, die nicht mehr existierte. Je nach Timing kann auch der Inhalt eines Speichervorgangs an seinen Platz verschoben werden, während ein anderer noch in denselben Pfad schreibt. Mit der Kette `_tail = _tail.then(...)` aus dem Store oben erzeugten dieselben 50 Speichervorgänge 0 Fehler, und die Datei enthielt den letzten Wert. In meinem Lauf war die finale Datei selbst im fehlerhaften Fall korrekt, und genau deshalb übersteht dieser Bug jedes Code Review: Er taucht nur als Exceptions im Crash Reporting auf.

Wer bei jedem Tastendruck oder jeder Slider-Bewegung speichert, sollte zusätzlich debouncen (300 ms reichen). Die Warteschlange macht parallele Speichervorgänge sicher, das Debouncing macht sie billig.

## Was die Schreibvorgänge tatsächlich kosten

Beide Ansätze sind schnell genug, dass die Leistung die Entscheidung nicht treffen sollte, aber "schnell genug" verdient eine Zahl. Gemessen habe ich den Schreibpfad des JSON-Stores (encodieren, temporäre Datei schreiben, Rename) mit einer 927 Byte großen Einstellungs-Payload (etwa 40 Schlüssel, eine verschachtelte Map, eine Liste mit 20 Einträgen), 200 Aufwärmiterationen und danach 2.000 gemessenen Iterationen, mit `Stopwatch` unter einem JIT-`dart run` (Dart 3.12.2) auf einem Apple M4, macOS, APFS:

| Operation | Median | p95 | p99 |
| --- | --- | --- | --- |
| Encodieren + schreiben + `flush: true` + Rename | 177 µs | 235 µs | 318 µs |
| Encodieren + schreiben + Rename (ohne Flush) | 155 µs | 247 µs | 328 µs |
| Lesen + `jsonDecode` | 62 µs | 69 µs | n/a |

Zwei Einschränkungen. Auf der SSD des M4 hat der Flush den Median nur um etwa 20 µs erhöht; auf günstigem Android-Flash-Speicher kostet er spürbar mehr, ein weiterer Grund für Debouncing. Und die Schreibvorgänge von `shared_preferences` habe ich nicht gemessen, weil sie über einen Platform Channel zu `NSUserDefaults` oder DataStore laufen und die Kosten von der Plattform abhängen, nicht vom Plugin. Bei Payloads in Einstellungsgröße taucht keine der beiden Varianten im Frame-Budget auf. Der Datei-Ansatz wird erst zum Problem, wenn die "Einstellungen" auf Megabytes an Cache-Daten anwachsen, und dann sollten sie keine Einstellungsdatei mehr sein.

## Die Fallstricke, die die Entscheidung für Sie treffen

**`getApplicationDocumentsDirectory()` ist auf dem Desktop der Dokumente-Ordner des Benutzers.** Unter Windows bildet `path_provider_windows` es auf `WindowsKnownFolder.Documents` ab. Unter Linux ist es das XDG-Benutzerverzeichnis `DOCUMENTS`. Ihre `settings.json` landet neben der Steuererklärung des Benutzers, wird von OneDrive synchronisiert und von Leuten gelöscht, die aufräumen. Unter iOS ist sie für den Benutzer sichtbar, sobald Sie `UIFileSharingEnabled` aktivieren. Die Dokumentation von `path_provider` sagt dasselbe mit eigenen Worten: Documents ist für vom Benutzer erzeugte Daten, andernfalls sollten Sie `getApplicationSupportDirectory()` in Betracht ziehen. Application Support entspricht unter Windows dem Roaming-AppData, unter Linux `XDG_DATA_HOME/<app id>` und unter macOS dem sandboxed `Library/Application Support/<bundle id>` (im macOS-Build landete `settings.json` nachweislich in `~/Library/Containers/com.example.settingsDemo/Data/Library/Application Support/com.example.settingsDemo/`). Jedes JSON-Einstellungs-Tutorial, das Documents verwendet, ist auf dem Desktop falsch.

**Das Web schließt die Datei aus.** Zielt die App aufs Web, ist die Entscheidung gefallen: Verwenden Sie `shared_preferences` und speichern Sie Ihr strukturiertes Objekt als einen einzigen mit `jsonEncode` erzeugten String unter einem Schlüssel, falls Sie Verschachtelung brauchen. Die Dauerhaftigkeitsgarantie geht verloren, das Ein-Objekt-Modell bleibt.

**Hintergrund-Isolates und -Engines sehen veraltete Caches.** Das README von `shared_preferences` ist eindeutig: `SharedPreferences` und `SharedPreferencesWithCache` halten einen Cache pro Isolate, ein Wert, der aus einem Hintergrund-Handler von `firebase_messaging` oder einer zweiten Engine geschrieben wird, ist für das Haupt-Isolate also unsichtbar, bis Sie `reload()` aufrufen. Schreiben mehrere Isolates dieselben Einstellungen, verwenden Sie `SharedPreferencesAsync`, das den Cache umgeht. Eine JSON-Datei hat dasselbe Problem in schlimmerer Form: Zwei Isolates mit jeweils eigener Schreibwarteschlange können sich trotzdem verschränken. Halten Sie also alle Schreibvorgänge in einem Isolate und schicken Sie ihm aus den anderen Nachrichten. Wenn Sie bereits schwere Arbeit in einem [Hintergrund-Isolate für CPU-lastige Aufgaben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) erledigen, lassen Sie dieses nicht die Einstellungsdatei besitzen.

**Legacy-Schlüssel haben ein Präfix, neue nicht.** Die Legacy-Klasse `SharedPreferences` speichert jeden Schlüssel mit dem Präfix `flutter.`. `SharedPreferencesWithCache` und `SharedPreferencesAsync` tun das nicht: In meinem macOS-Build enthielt die Plist einen nackten Schlüssel `themeMode`. Unter Android verwenden die neuen APIs standardmäßig DataStore, eine ganz andere Datei. Ein API-Wechsel in einer bereits ausgelieferten App ist also eine Datenmigration, kein Refactoring. Führen Sie beim Start `migrateLegacySharedPreferencesToSharedPreferencesAsyncIfNecessary` aus `package:shared_preferences/util/legacy_to_async_migration_util.dart` aus, sonst verlieren Ihre Benutzer beim Update ihre Einstellungen.

**Android-Backup betrifft beide.** Auto Backup schließt standardmäßig die privaten Dateien der App und ihre Preference-Speicher ein, der Umstieg auf eine JSON-Datei nimmt Sie also nicht aus dem Cloud-Backup heraus. Ist eine Einstellung gerätespezifisch (eine gecachte Server-URL, ein Debug-Schalter), schließen Sie sie in beiden Fällen über Ihre Backup-Regeln aus.

## Meine Empfehlung

Beginnen Sie mit `shared_preferences` und `SharedPreferencesWithCache` für flache Flags. Das ist für die meisten Apps der richtige Standard, funktioniert auf jeder Plattform, die Flutter unterstützt, und ist die einzige Option im Web. Sobald Sie sich dabei ertappen, Schlüsselnamen mit Punkten zu erfinden, drei zusammengehörige Schlüssel zu schreiben, die sich gemeinsam ändern müssen, oder eine Schemaversion zu wollen, verschieben Sie den strukturierten Teil in eine einzelne JSON-Datei in `getApplicationSupportDirectory()`, geschrieben mit Flush, Rename und einer serialisierten Warteschlange. Viele Apps landen bei beidem: ein paar Flags in `shared_preferences`, die nativer Code oder der erste Frame braucht, und eine `settings.json` für das eigentliche Einstellungsobjekt.

Sind die Daten gar keine Einstellungen (Benutzerinhalte, Verlauf, alles, was wächst), lassen Sie beides weg und verwenden Sie SQLite. Wie man die lokalen Daten einer App auf diese Weise umzieht, habe ich in [Migration einer Flutter-App von Hive zu drift](/de/2026/10/migrate-a-flutter-app-from-hive-to-drift/) beschrieben.

### Weiterlesen

- Wenn `getAll` nach dem Hinzufügen des Plugins eine `MissingPluginException` wirft, siehe [wie man die MissingPluginException bei shared_preferences behebt](/de/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/).
- Einstellungen sind nicht dasselbe wie flüchtiger UI-Zustand: Für Scrollpositionen und Formulareingaben, die überleben müssen, wenn das Betriebssystem Ihre App beendet, verwenden Sie [RestorationMixin, um den UI-Zustand nach dem Prozesstod unter Android wiederherzustellen](/de/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/).
- Enthält Ihr Einstellungsobjekt einen polymorphen Typ, zeigt [eine Dart-Sealed-Class-Hierarchie nach und von JSON serialisieren](/de/2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json/) die passende Form für `toJson`/`fromJson`.
- Das Laden von Einstellungen ist asynchron, also wartet der Bildschirm, der sie ändert, auf einen Speichervorgang: [BuildContext nach einem await sicher verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) behandelt die nötige `mounted`-Prüfung.

### Quellen

- [README von `shared_preferences`: API-Vergleich, Cache-Hinweise, Speicherorte](https://pub.dev/packages/shared_preferences)
- [Paket `path_provider` und Tabelle der Plattformunterstützung](https://pub.dev/packages/path_provider)
- [Doc-Kommentar zu `getApplicationDocumentsDirectory` (flutter/packages)](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider/lib/path_provider.dart)
- [Known-Folder-Zuordnung in `path_provider_windows`](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider_windows/lib/src/path_provider_windows_real.dart)
- [`File.rename` und `File.writeAsString` in `dart:io`](https://api.dart.dev/dart-io/File-class.html)
- [Android DataStore](https://developer.android.com/topic/libraries/architecture/datastore) und [Auto Backup für Apps](https://developer.android.com/identity/data/autobackup)

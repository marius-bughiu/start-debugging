---
title: "shared_preferences vs a JSON File in path_provider for Persisting Settings in Flutter"
description: "Use shared_preferences (SharedPreferencesWithCache) for a handful of flat flags and a JSON file in getApplicationSupportDirectory for a structured settings object. Covers the atomic-write pattern, the concurrent-save race, the Documents-folder trap on Windows and Linux, web support, and measured write costs on Flutter 3.44.8."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "shared-preferences"
  - "path-provider"
  - "local-storage"
---

If your settings are a dozen independent flat values (theme, a "seen onboarding" flag, last selected tab), use `shared_preferences` with the `SharedPreferencesWithCache` API: synchronous reads, web support, no file handling. Once the settings become one structured object with nested maps, lists, or a schema you need to migrate, switch to a single JSON file written atomically (temp file plus rename, serialized) into `getApplicationSupportDirectory()`, not `getApplicationDocumentsDirectory()`. Everything below was tested on Flutter 3.44.8 (Dart 3.12.2) with `shared_preferences` 2.5.6 and `path_provider` 2.1.6, running as a real macOS debug build on an Apple M4.

## The comparison at a glance

| | `shared_preferences` 2.5.6 | JSON file via `path_provider` 2.1.6 |
| --- | --- | --- |
| Value types | `bool`, `int`, `double`, `String`, `List<String>` | Anything `jsonEncode` handles (nested maps, lists, nulls) |
| Read API | Sync (`SharedPreferencesWithCache`) or async (`SharedPreferencesAsync`) | Async load once, then your own in-memory object |
| Write durability | "No guarantee" writes reach disk after returning (README) | You control it: `flush: true` + atomic rename |
| Partial updates | Per key, built in | Whole-file rewrite (fine below a few hundred KB) |
| Schema migration | Per key, manual | One `schemaVersion` field, one migration function |
| Web | Yes (`localStorage`) | No: `path_provider` has no web implementation |
| Storage on Android | DataStore Preferences (new APIs) or `SharedPreferences` (legacy) | A file in the app's private data dir |
| Storage on iOS/macOS | `NSUserDefaults` plist | A file in Application Support |
| Readable by native code / widgets | Yes, it is the platform store | Only if native code reads your file |
| Concurrency footguns | Per-isolate caches go stale | Concurrent saves corrupt the temp file unless serialized |
| Code you own | Almost none | About 60 lines |

Neither is "the database". If you are storing user content, lists that grow, or anything you query, you want SQLite (drift, sqflite), not either of these.

## When to pick shared_preferences

- **A handful of flat, independent flags.** `onboardingDone`, `themeMode`, `lastTabIndex`, `analyticsOptIn`. Each key is read and written on its own, there are no relationships between them, and a lost write costs nothing more than showing a dialog twice.
- **You need the value synchronously at startup.** `SharedPreferencesWithCache` loads everything once in `create()` and then every getter is synchronous, so you can read the theme in `build()` without a `FutureBuilder`.
- **You ship to the web.** `shared_preferences_web` 2.4.3 maps to `localStorage`. The JSON-file approach cannot run there at all, because `dart:io` `File` does not exist in the browser and `path_provider` lists no web support.
- **Native code needs the same value.** A home-screen widget, a notification extension, or an existing native app you are migrating from reads `NSUserDefaults` or Android `SharedPreferences` directly. A custom JSON file is invisible to all of them.

Here is the version I would ship today. It uses `SharedPreferencesWithCache` with an allow list, which the README recommends for new code over the legacy `SharedPreferences` class:

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

The allow list is not decoration. With it, a typo like `getString('themMode')` throws an `ArgumentError` ("themMode is not included in the PreferencesFilter allowlist") instead of silently returning `null`, and `clear()` only removes your keys instead of everything the plugin can see.

## When to pick a JSON file

- **The settings are one object, not a bag of keys.** Notification preferences per channel, a list of saved filters, per-account overrides. Flattening that into `notifications.replies`, `notifications.digest`, `filters.0.name` keys is how you end up with half-updated state when the app is killed between two `setString` calls.
- **You need a schema version.** With one file you write `"schemaVersion": 2` once and run a single migration function on load. With keys you are migrating each one and hoping none were written by an older build in between.
- **You want a real durability guarantee.** The `shared_preferences` README says plainly that "there is no guarantee that writes will be persisted to disk after returning" and warns against using it for critical data. With your own file, `flush: true` and an atomic rename give you either the old settings or the new settings after a crash, never a truncated mix.
- **You want to export, back up, or debug the settings as text.** A support engineer can ask a desktop user to attach `settings.json`. Nobody is going to walk a user through finding a DataStore protobuf.

The store below is what I use. Note the three details that most tutorials skip: the directory, the atomic write, and the write queue.

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

Load it once at startup, keep the `AppSettings` in your state management layer (a `ValueNotifier`, a Riverpod `Notifier`, whatever you already use), and call `save()` on change. Reads never touch disk after startup, which is the same trade `SharedPreferencesWithCache` makes for you.

## The concurrent-save race that breaks naive JSON stores

The most common version of this pattern online is `writeAsString` to a `.tmp` file, then `rename`, with no queue. It looks atomic. It is, for one caller. Wire it to a slider's `onChanged` and you get many overlapping saves that all share the same temp path. I fired 50 unawaited saves at once in plain Dart 3.12.2:

```dart
// Dart 3.12.2
await Future.wait([
  for (var i = 0; i < 50; i++)
    writeAtomic(file, {'counter': i}).catchError((Object e) { errors++; }),
]);
```

Result: 49 of the 50 writes threw `PathNotFoundException: Cannot rename file ... (OS Error: No such file or directory, errno = 2)`. The first rename moved the temp file away, and every other save tried to rename a file that no longer existed. Depending on timing you can also get one save's bytes renamed into place while another is still writing to the same path. With the `_tail = _tail.then(...)` chain from the store above, the same 50 saves produced 0 errors and the file held the last value. On my run the final file was correct even in the broken case, which is exactly why this bug survives code review: it only shows up as exceptions in your crash reporter.

If you save on every keystroke or slider tick, also debounce (300 ms is plenty). The queue makes concurrent saves safe; the debounce makes them cheap.

## What the writes actually cost

Both approaches are fast enough that performance should not drive the decision, but "fast enough" deserves a number. I measured the JSON store's write path (encode, write the temp file, rename) with a 927-byte settings payload (about 40 keys, a nested map, a 20-item list), 200 warm-up iterations then 2,000 timed iterations, `Stopwatch` under a JIT `dart run` (Dart 3.12.2) on an Apple M4, macOS, APFS:

| Operation | Median | p95 | p99 |
| --- | --- | --- | --- |
| Encode + write + `flush: true` + rename | 177 µs | 235 µs | 318 µs |
| Encode + write + rename (no flush) | 155 µs | 247 µs | 328 µs |
| Read + `jsonDecode` | 62 µs | 69 µs | n/a |

Two caveats. On the M4's SSD the flush added only about 20 µs to the median; on low-end Android flash storage expect it to cost measurably more, which is another reason to debounce. And I did not benchmark `shared_preferences` writes, because they go through a platform channel to `NSUserDefaults` or DataStore and the cost depends on the platform, not on the plugin. Neither side will show up in a frame budget at settings-sized payloads. The file approach only becomes a problem if the "settings" grow into megabytes of cached data, at which point it should not be a settings file anymore.

## The gotchas that pick for you

**`getApplicationDocumentsDirectory()` is the user's Documents folder on desktop.** On Windows, `path_provider_windows` maps it to `WindowsKnownFolder.Documents`. On Linux, it is the XDG `DOCUMENTS` user directory. Your `settings.json` lands next to the user's tax returns, gets synced by OneDrive, and gets deleted by people tidying up. On iOS it is exposed to the user the moment you turn on `UIFileSharingEnabled`. The `path_provider` docs say the same thing in their own words: Documents is for "user-generated" data, and you should consider `getApplicationSupportDirectory()` otherwise. Application Support maps to roaming AppData on Windows, `XDG_DATA_HOME/<app id>` on Linux, and the sandboxed `Library/Application Support/<bundle id>` on macOS (I confirmed `settings.json` ended up in `~/Library/Containers/com.example.settingsDemo/Data/Library/Application Support/com.example.settingsDemo/` on the macOS build). Every JSON-settings tutorial that uses Documents is wrong on desktop.

**Web rules out the file.** If the app targets the web, the decision is made: use `shared_preferences`, and store your structured object as one `jsonEncode`d string under a single key if you need nesting. You lose the durability guarantee but keep the one-object model.

**Background isolates and engines see stale caches.** The `shared_preferences` README is explicit that `SharedPreferences` and `SharedPreferencesWithCache` keep a per-isolate cache, so a value written from a `firebase_messaging` background handler or a second engine is invisible to the main isolate until you call `reload()`. If several isolates write the same settings, use `SharedPreferencesAsync`, which skips the cache. A JSON file has the same problem in a worse form: two isolates each with their own write queue can still interleave, so keep all writes in one isolate and send the others a message. If you are already doing heavy work in a [background isolate for CPU-bound tasks](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), do not let it own the settings file.

**Legacy keys are prefixed, new ones are not.** The legacy `SharedPreferences` class stores every key with a `flutter.` prefix. `SharedPreferencesWithCache` and `SharedPreferencesAsync` do not: in my macOS build the plist contained a bare `themeMode` key. On Android the new APIs default to DataStore, a different file entirely. So switching APIs in an app that has shipped is a data migration, not a refactor. Run `migrateLegacySharedPreferencesToSharedPreferencesAsyncIfNecessary` from `package:shared_preferences/util/legacy_to_async_migration_util.dart` at startup, or your users lose their settings on update.

**Android backup applies to both.** Auto Backup includes the app's private files and its preference stores by default, so moving to a JSON file does not opt you out of cloud backup. If a setting is device-specific (a cached server URL, a debug toggle), exclude it in your backup rules either way.

## What I recommend

Start with `shared_preferences` and `SharedPreferencesWithCache` for flat flags. It is the right default for most apps, it works on every platform Flutter targets, and it is the only option on the web. The moment you catch yourself inventing dotted key names, writing three related keys that must change together, or wanting a schema version, move the structured part into one JSON file in `getApplicationSupportDirectory()`, written with flush, rename, and a serialized queue. Many apps end up with both: a few flags in `shared_preferences` that native code or the first frame needs, and one `settings.json` for the real settings object.

If the data is not settings at all (user content, history, anything that grows), skip both and use SQLite. I walked through moving an app's local data that way in [migrating a Flutter app from Hive to drift](/2026/10/migrate-a-flutter-app-from-hive-to-drift/).

### Read next

- If `getAll` throws a `MissingPluginException` after adding the plugin, see [how to fix MissingPluginException for shared_preferences](/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/).
- Settings are not the same as transient UI state: for scroll positions and form input that must survive the OS killing your app, use [RestorationMixin to restore UI state after Android process death](/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/).
- If your settings object holds a polymorphic type, [serializing a Dart sealed class hierarchy to and from JSON](/2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json/) shows the `toJson`/`fromJson` shape to use.
- Loading settings is async, so the screen that changes them awaits a save: [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) covers the `mounted` check you need.

### Sources

- [`shared_preferences` README: API comparison, caching caveats, storage locations](https://pub.dev/packages/shared_preferences)
- [`path_provider` package and platform support table](https://pub.dev/packages/path_provider)
- [`getApplicationDocumentsDirectory` doc comment (flutter/packages)](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider/lib/path_provider.dart)
- [`path_provider_windows` known-folder mapping](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider_windows/lib/src/path_provider_windows_real.dart)
- [`File.rename` and `File.writeAsString` in `dart:io`](https://api.dart.dev/dart-io/File-class.html)
- [Android DataStore](https://developer.android.com/topic/libraries/architecture/datastore) and [Auto Backup for apps](https://developer.android.com/identity/data/autobackup)

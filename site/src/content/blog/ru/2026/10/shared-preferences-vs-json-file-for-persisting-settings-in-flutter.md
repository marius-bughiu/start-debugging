---
title: "shared_preferences или JSON-файл через path_provider для хранения настроек во Flutter"
description: "shared_preferences (SharedPreferencesWithCache) подходит для нескольких плоских флагов, а JSON-файл в getApplicationSupportDirectory подходит для структурированного объекта настроек. Разбираем атомарную запись, состояние гонки при параллельных сохранениях, ловушку с папкой Documents в Windows и Linux, поддержку веба и измеренную стоимость записи на Flutter 3.44.8."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "shared-preferences"
  - "path-provider"
  - "local-storage"
lang: "ru"
translationOf: "2026/10/shared-preferences-vs-json-file-for-persisting-settings-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-30
---

Если ваши настройки это дюжина плоских независимых значений (тема, флаг "онбординг пройден", последняя выбранная вкладка), используйте `shared_preferences` с API `SharedPreferencesWithCache`: синхронное чтение, поддержка веба, никакой работы с файлами. Как только настройки превращаются в один структурированный объект с вложенными map, списками или схемой, которую нужно мигрировать, переходите на один JSON-файл, записываемый атомарно (временный файл плюс rename, с сериализацией записей) в `getApplicationSupportDirectory()`, а не в `getApplicationDocumentsDirectory()`. Всё описанное ниже проверено на Flutter 3.44.8 (Dart 3.12.2) с `shared_preferences` 2.5.6 и `path_provider` 2.1.6 в реальной отладочной сборке под macOS на Apple M4.

## Сравнение в одной таблице

| | `shared_preferences` 2.5.6 | JSON-файл через `path_provider` 2.1.6 |
| --- | --- | --- |
| Типы значений | `bool`, `int`, `double`, `String`, `List<String>` | Всё, что умеет `jsonEncode` (вложенные map, списки, null) |
| API чтения | Синхронный (`SharedPreferencesWithCache`) или асинхронный (`SharedPreferencesAsync`) | Одна асинхронная загрузка, дальше ваш собственный объект в памяти |
| Надёжность записи | "Нет гарантии", что запись попала на диск к моменту возврата (README) | Под вашим контролем: `flush: true` + атомарный rename |
| Частичные обновления | По ключу, из коробки | Перезапись всего файла (нормально до нескольких сотен КБ) |
| Миграция схемы | По каждому ключу, вручную | Одно поле `schemaVersion`, одна функция миграции |
| Веб | Да (`localStorage`) | Нет: у `path_provider` нет веб-реализации |
| Хранилище на Android | DataStore Preferences (новые API) или `SharedPreferences` (устаревший API) | Файл в приватном каталоге данных приложения |
| Хранилище на iOS/macOS | plist `NSUserDefaults` | Файл в Application Support |
| Доступно нативному коду / виджетам | Да, это хранилище платформы | Только если нативный код читает ваш файл |
| Подводные камни конкурентности | Кэши на уровне isolate устаревают | Параллельные сохранения портят временный файл без сериализации |
| Ваш собственный код | Почти ничего | Около 60 строк |

Ни один из вариантов не является "базой данных". Если вы храните пользовательский контент, растущие списки или что-то, по чему делаются запросы, вам нужен SQLite (drift, sqflite), а не эти подходы.

## Когда выбирать shared_preferences

- **Несколько плоских независимых флагов.** `onboardingDone`, `themeMode`, `lastTabIndex`, `analyticsOptIn`. Каждый ключ читается и пишется сам по себе, связей между ними нет, а потерянная запись стоит максимум повторного показа диалога.
- **Значение нужно синхронно при старте.** `SharedPreferencesWithCache` загружает всё один раз в `create()`, после чего каждый геттер синхронный, так что тему можно прочитать в `build()` без `FutureBuilder`.
- **Приложение работает в вебе.** `shared_preferences_web` 2.4.3 использует `localStorage`. Подход с JSON-файлом там не работает в принципе: `File` из `dart:io` в браузере не существует, а `path_provider` веб не поддерживает.
- **То же значение нужно нативному коду.** Виджет домашнего экрана, расширение уведомлений или существующее нативное приложение, с которого вы мигрируете, читают `NSUserDefaults` или `SharedPreferences` Android напрямую. Собственный JSON-файл для них невидим.

Вот версия, которую я выпустил бы сегодня. Она использует `SharedPreferencesWithCache` с allow list, которую README рекомендует для нового кода вместо устаревшего класса `SharedPreferences`:

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

Allow list здесь не для красоты. С ней опечатка вроде `getString('themMode')` бросает `ArgumentError` ("themMode is not included in the PreferencesFilter allowlist") вместо того, чтобы молча вернуть `null`, а `clear()` удаляет только ваши ключи, а не всё, что видит плагин.

## Когда выбирать JSON-файл

- **Настройки это один объект, а не мешок ключей.** Настройки уведомлений по каналам, список сохранённых фильтров, переопределения для каждой учётной записи. Если расплющить это в ключи вида `notifications.replies`, `notifications.digest`, `filters.0.name`, вы получите наполовину обновлённое состояние, когда приложение убьют между двумя вызовами `setString`.
- **Нужна версия схемы.** С одним файлом вы один раз пишете `"schemaVersion": 2` и при загрузке запускаете одну функцию миграции. С ключами приходится мигрировать каждый и надеяться, что ни один из них не был записан более старой сборкой в промежутке.
- **Нужна реальная гарантия надёжности.** README `shared_preferences` прямо говорит, что нет гарантии сохранения записи на диск к моменту возврата и что плагин не предназначен для критичных данных. С собственным файлом `flush: true` и атомарный rename дают после сбоя либо старые настройки, либо новые, но никогда обрезанную смесь.
- **Нужно экспортировать, бэкапить или отлаживать настройки как текст.** Инженер поддержки может попросить пользователя десктопа приложить `settings.json`. Никто не станет объяснять пользователю, как найти protobuf DataStore.

Ниже хранилище, которым пользуюсь я. Обратите внимание на три детали, которые большинство туториалов пропускает: каталог, атомарную запись и очередь записей.

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

Загружайте его один раз при старте, держите `AppSettings` в своём слое управления состоянием (`ValueNotifier`, `Notifier` из Riverpod, что вы уже используете) и вызывайте `save()` при изменении. После старта чтение никогда не обращается к диску, это тот же компромисс, который за вас делает `SharedPreferencesWithCache`.

## Состояние гонки при параллельных сохранениях, которое ломает наивные JSON-хранилища

Самый распространённый вариант этого паттерна в сети: `writeAsString` во временный файл `.tmp`, потом `rename`, без очереди. Выглядит атомарно. Для одного вызывающего так и есть. Подключите это к `onChanged` слайдера, и вы получите множество перекрывающихся сохранений с одним и тем же временным путём. Я запустил 50 сохранений без `await` одновременно на чистом Dart 3.12.2:

```dart
// Dart 3.12.2
await Future.wait([
  for (var i = 0; i < 50; i++)
    writeAtomic(file, {'counter': i}).catchError((Object e) { errors++; }),
]);
```

Результат: 49 из 50 записей бросили `PathNotFoundException: Cannot rename file ... (OS Error: No such file or directory, errno = 2)`. Первый rename переместил временный файл, а все остальные сохранения пытались переименовать файл, которого уже не было. В зависимости от тайминга можно также получить ситуацию, когда байты одного сохранения переименованы на место, пока другое ещё пишет по тому же пути. С цепочкой `_tail = _tail.then(...)` из хранилища выше те же 50 сохранений дали 0 ошибок, а файл содержал последнее значение. В моём прогоне итоговый файл был корректным даже в сломанном варианте, и именно поэтому этот баг переживает код-ревью: он проявляется только как исключения в отчётах о сбоях.

Если вы сохраняете при каждом нажатии клавиши или движении слайдера, добавьте ещё и debounce (300 мс хватает). Очередь делает параллельные сохранения безопасными, debounce делает их дешёвыми.

## Сколько на самом деле стоит запись

Оба подхода достаточно быстры, чтобы производительность не определяла выбор, но "достаточно быстро" заслуживает цифры. Я измерил путь записи JSON-хранилища (кодирование, запись временного файла, rename) на полезной нагрузке настроек размером 927 байт (около 40 ключей, вложенная map, список из 20 элементов): 200 итераций прогрева, затем 2000 замеренных итераций, `Stopwatch` под JIT `dart run` (Dart 3.12.2) на Apple M4, macOS, APFS:

| Операция | Медиана | p95 | p99 |
| --- | --- | --- | --- |
| Кодирование + запись + `flush: true` + rename | 177 мкс | 235 мкс | 318 мкс |
| Кодирование + запись + rename (без flush) | 155 мкс | 247 мкс | 328 мкс |
| Чтение + `jsonDecode` | 62 мкс | 69 мкс | n/a |

Две оговорки. На SSD M4 flush добавил к медиане всего около 20 мкс; на бюджетной флеш-памяти Android он обойдётся заметно дороже, это ещё одна причина использовать debounce. И я не замерял запись в `shared_preferences`, потому что она идёт через platform channel к `NSUserDefaults` или DataStore, и её стоимость зависит от платформы, а не от плагина. При объёмах, типичных для настроек, ни один из вариантов не появится в бюджете кадра. Подход с файлом становится проблемой, только если "настройки" разрастаются до мегабайт закэшированных данных, но тогда это уже не должно быть файлом настроек.

## Подводные камни, которые выбирают за вас

**На десктопе `getApplicationDocumentsDirectory()` это папка "Документы" пользователя.** В Windows `path_provider_windows` сопоставляет её с `WindowsKnownFolder.Documents`. В Linux это пользовательский каталог XDG `DOCUMENTS`. Ваш `settings.json` окажется рядом с налоговыми декларациями пользователя, будет синхронизироваться через OneDrive и удаляться теми, кто наводит порядок в папках. В iOS он становится видимым пользователю, как только вы включаете `UIFileSharingEnabled`. Документация `path_provider` говорит то же самое своими словами: Documents предназначен для данных, созданных пользователем, а в остальных случаях стоит рассмотреть `getApplicationSupportDirectory()`. Application Support соответствует roaming AppData в Windows, `XDG_DATA_HOME/<app id>` в Linux и `Library/Application Support/<bundle id>` внутри песочницы в macOS (я убедился, что в сборке под macOS `settings.json` оказался в `~/Library/Containers/com.example.settingsDemo/Data/Library/Application Support/com.example.settingsDemo/`). Любой туториал по JSON-настройкам, который использует Documents, неверен для десктопа.

**Веб исключает файл.** Если приложение нацелено на веб, решение принято: используйте `shared_preferences` и, если нужна вложенность, храните структурированный объект как одну строку, полученную через `jsonEncode`, под одним ключом. Гарантию надёжности вы теряете, но модель одного объекта сохраняете.

**Фоновые isolate и engine видят устаревший кэш.** README `shared_preferences` говорит об этом прямо: `SharedPreferences` и `SharedPreferencesWithCache` держат кэш на каждый isolate, поэтому значение, записанное из фонового обработчика `firebase_messaging` или из второго engine, невидимо для главного isolate, пока вы не вызовете `reload()`. Если одни и те же настройки пишут несколько isolate, используйте `SharedPreferencesAsync`, который обходит кэш. У JSON-файла та же проблема в худшей форме: два isolate, у каждого своя очередь записи, всё равно могут перемежаться, поэтому держите все записи в одном isolate, а из остальных отправляйте ему сообщения. Если вы уже выполняете тяжёлую работу в [фоновом isolate для CPU-нагруженных задач](/ru/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), не делайте его владельцем файла настроек.

**У устаревших ключей есть префикс, у новых нет.** Устаревший класс `SharedPreferences` хранит каждый ключ с префиксом `flutter.`. `SharedPreferencesWithCache` и `SharedPreferencesAsync` этого не делают: в моей сборке под macOS plist содержал ключ `themeMode` без префикса. На Android новые API по умолчанию используют DataStore, совсем другой файл. Поэтому смена API в уже выпущенном приложении это миграция данных, а не рефакторинг. Вызывайте `migrateLegacySharedPreferencesToSharedPreferencesAsyncIfNecessary` из `package:shared_preferences/util/legacy_to_async_migration_util.dart` при старте, иначе пользователи потеряют настройки при обновлении.

**Резервное копирование Android касается обоих вариантов.** Auto Backup по умолчанию включает приватные файлы приложения и его хранилища настроек, так что переход на JSON-файл не исключает вас из облачного бэкапа. Если настройка привязана к устройству (закэшированный URL сервера, отладочный переключатель), исключите её в правилах резервного копирования в любом из вариантов.

## Что я рекомендую

Начинайте с `shared_preferences` и `SharedPreferencesWithCache` для плоских флагов. Это правильный выбор по умолчанию для большинства приложений, он работает на всех платформах, которые поддерживает Flutter, и это единственный вариант для веба. Как только вы ловите себя на том, что придумываете имена ключей с точками, пишете три связанных ключа, которые должны меняться вместе, или хотите версию схемы, переносите структурированную часть в один JSON-файл в `getApplicationSupportDirectory()`, записываемый с flush, rename и сериализованной очередью. Многие приложения в итоге используют оба: несколько флагов в `shared_preferences`, нужных нативному коду или первому кадру, и один `settings.json` для настоящего объекта настроек.

Если данные вообще не настройки (пользовательский контент, история, всё, что растёт), пропустите оба варианта и используйте SQLite. Как перенести локальные данные приложения таким образом, я показал в статье о [миграции Flutter-приложения с Hive на drift](/ru/2026/10/migrate-a-flutter-app-from-hive-to-drift/).

### Что почитать дальше

- Если `getAll` бросает `MissingPluginException` после добавления плагина, смотрите [как исправить MissingPluginException в shared_preferences](/ru/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/).
- Настройки это не то же самое, что временное состояние UI: для позиций прокрутки и данных форм, которые должны пережить завершение приложения системой, используйте [RestorationMixin для восстановления состояния UI после смерти процесса на Android](/ru/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/).
- Если объект настроек содержит полиморфный тип, статья о [сериализации иерархии sealed-классов Dart в JSON и обратно](/ru/2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json/) показывает нужную форму `toJson`/`fromJson`.
- Загрузка настроек асинхронна, поэтому экран, который их меняет, ожидает сохранения: [безопасное использование BuildContext после await](/ru/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) описывает нужную проверку `mounted`.

### Источники

- [README `shared_preferences`: сравнение API, оговорки о кэше, места хранения](https://pub.dev/packages/shared_preferences)
- [Пакет `path_provider` и таблица поддержки платформ](https://pub.dev/packages/path_provider)
- [Doc-комментарий к `getApplicationDocumentsDirectory` (flutter/packages)](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider/lib/path_provider.dart)
- [Сопоставление known folders в `path_provider_windows`](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider_windows/lib/src/path_provider_windows_real.dart)
- [`File.rename` и `File.writeAsString` в `dart:io`](https://api.dart.dev/dart-io/File-class.html)
- [Android DataStore](https://developer.android.com/topic/libraries/architecture/datastore) и [Auto Backup для приложений](https://developer.android.com/identity/data/autobackup)

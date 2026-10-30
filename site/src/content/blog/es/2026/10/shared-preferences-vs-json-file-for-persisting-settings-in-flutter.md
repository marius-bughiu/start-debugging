---
title: "shared_preferences vs un archivo JSON con path_provider para guardar ajustes en Flutter"
description: "Usa shared_preferences (SharedPreferencesWithCache) para un puñado de flags planos y un archivo JSON en getApplicationSupportDirectory para un objeto de ajustes estructurado. Cubre el patrón de escritura atómica, la condición de carrera de los guardados concurrentes, la trampa de la carpeta Documentos en Windows y Linux, el soporte web y costos de escritura medidos en Flutter 3.44.8."
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "shared-preferences"
  - "path-provider"
  - "local-storage"
lang: "es"
translationOf: "2026/10/shared-preferences-vs-json-file-for-persisting-settings-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-30
---

Si tus ajustes son una docena de valores planos e independientes (tema, un flag de "onboarding visto", la última pestaña seleccionada), usa `shared_preferences` con la API `SharedPreferencesWithCache`: lecturas síncronas, soporte web y nada de manejo de archivos. En cuanto los ajustes se conviertan en un solo objeto estructurado con mapas anidados, listas o un esquema que necesites migrar, cambia a un único archivo JSON escrito de forma atómica (archivo temporal más rename, serializado) en `getApplicationSupportDirectory()`, no en `getApplicationDocumentsDirectory()`. Todo lo que sigue se probó en Flutter 3.44.8 (Dart 3.12.2) con `shared_preferences` 2.5.6 y `path_provider` 2.1.6, ejecutándose como una build de depuración real de macOS en un Apple M4.

## La comparación de un vistazo

| | `shared_preferences` 2.5.6 | Archivo JSON vía `path_provider` 2.1.6 |
| --- | --- | --- |
| Tipos de valor | `bool`, `int`, `double`, `String`, `List<String>` | Todo lo que maneja `jsonEncode` (mapas anidados, listas, nulls) |
| API de lectura | Síncrona (`SharedPreferencesWithCache`) o asíncrona (`SharedPreferencesAsync`) | Carga asíncrona una vez, luego tu propio objeto en memoria |
| Durabilidad de escritura | "No hay garantía" de que las escrituras lleguen al disco al retornar (README) | Tú la controlas: `flush: true` + rename atómico |
| Actualizaciones parciales | Por clave, integradas | Reescritura del archivo completo (bien por debajo de unos cientos de KB) |
| Migración de esquema | Por clave, manual | Un campo `schemaVersion`, una función de migración |
| Web | Sí (`localStorage`) | No: `path_provider` no tiene implementación web |
| Almacenamiento en Android | DataStore Preferences (APIs nuevas) o `SharedPreferences` (legacy) | Un archivo en el directorio de datos privado de la app |
| Almacenamiento en iOS/macOS | plist de `NSUserDefaults` | Un archivo en Application Support |
| Legible por código nativo / widgets | Sí, es el almacén de la plataforma | Solo si el código nativo lee tu archivo |
| Trampas de concurrencia | Las cachés por isolate quedan desactualizadas | Los guardados concurrentes corrompen el archivo temporal si no se serializan |
| Código que mantienes | Casi nada | Unas 60 líneas |

Ninguno de los dos es "la base de datos". Si guardas contenido del usuario, listas que crecen o cualquier cosa que consultes, quieres SQLite (drift, sqflite), no ninguno de estos.

## Cuándo elegir shared_preferences

- **Un puñado de flags planos e independientes.** `onboardingDone`, `themeMode`, `lastTabIndex`, `analyticsOptIn`. Cada clave se lee y se escribe por separado, no hay relaciones entre ellas y una escritura perdida no cuesta más que mostrar un diálogo dos veces.
- **Necesitas el valor de forma síncrona al arrancar.** `SharedPreferencesWithCache` carga todo una vez en `create()` y a partir de ahí cada getter es síncrono, así que puedes leer el tema en `build()` sin un `FutureBuilder`.
- **Publicas en la web.** `shared_preferences_web` 2.4.3 se mapea a `localStorage`. El enfoque del archivo JSON no puede ejecutarse ahí en absoluto, porque `File` de `dart:io` no existe en el navegador y `path_provider` no declara soporte web.
- **El código nativo necesita el mismo valor.** Un widget de pantalla de inicio, una extensión de notificaciones o una app nativa existente desde la que migras leen `NSUserDefaults` o `SharedPreferences` de Android directamente. Un archivo JSON propio es invisible para todos ellos.

Esta es la versión que publicaría hoy. Usa `SharedPreferencesWithCache` con una allow list, que el README recomienda para código nuevo en lugar de la clase legacy `SharedPreferences`:

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

La allow list no es decoración. Con ella, un error tipográfico como `getString('themMode')` lanza un `ArgumentError` ("themMode is not included in the PreferencesFilter allowlist") en lugar de devolver `null` en silencio, y `clear()` solo elimina tus claves en vez de todo lo que el plugin puede ver.

## Cuándo elegir un archivo JSON

- **Los ajustes son un objeto, no una bolsa de claves.** Preferencias de notificación por canal, una lista de filtros guardados, overrides por cuenta. Aplanar eso en claves como `notifications.replies`, `notifications.digest`, `filters.0.name` es como terminas con un estado a medio actualizar cuando la app muere entre dos llamadas a `setString`.
- **Necesitas una versión de esquema.** Con un archivo escribes `"schemaVersion": 2` una vez y ejecutas una sola función de migración al cargar. Con claves migras cada una y esperas que ninguna haya sido escrita por una build anterior entre medio.
- **Quieres una garantía de durabilidad real.** El README de `shared_preferences` dice claramente que no hay garantía de que las escrituras se persistan en disco al retornar y que el plugin no debe usarse para datos críticos. Con tu propio archivo, `flush: true` y un rename atómico te dan los ajustes viejos o los nuevos tras un crash, nunca una mezcla truncada.
- **Quieres exportar, respaldar o depurar los ajustes como texto.** Un ingeniero de soporte puede pedirle a un usuario de escritorio que adjunte `settings.json`. Nadie va a guiar a un usuario para encontrar un protobuf de DataStore.

El almacén de abajo es el que uso. Fíjate en los tres detalles que la mayoría de los tutoriales omiten: el directorio, la escritura atómica y la cola de escrituras.

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

Cárgalo una vez al arrancar, mantén el `AppSettings` en tu capa de gestión de estado (un `ValueNotifier`, un `Notifier` de Riverpod, lo que ya uses) y llama a `save()` en cada cambio. Las lecturas nunca tocan el disco después del arranque, que es el mismo intercambio que `SharedPreferencesWithCache` hace por ti.

## La condición de carrera de los guardados concurrentes que rompe los almacenes JSON ingenuos

La versión más común de este patrón en internet es `writeAsString` a un archivo `.tmp` y luego `rename`, sin cola. Parece atómico. Lo es, para un solo llamador. Conéctalo al `onChanged` de un slider y obtienes muchos guardados superpuestos que comparten la misma ruta temporal. Lancé 50 guardados sin `await` a la vez en Dart 3.12.2 puro:

```dart
// Dart 3.12.2
await Future.wait([
  for (var i = 0; i < 50; i++)
    writeAtomic(file, {'counter': i}).catchError((Object e) { errors++; }),
]);
```

Resultado: 49 de las 50 escrituras lanzaron `PathNotFoundException: Cannot rename file ... (OS Error: No such file or directory, errno = 2)`. El primer rename movió el archivo temporal y cada uno de los demás guardados intentó renombrar un archivo que ya no existía. Según el timing también puedes acabar con los bytes de un guardado renombrados a su lugar mientras otro sigue escribiendo en la misma ruta. Con la cadena `_tail = _tail.then(...)` del almacén de arriba, los mismos 50 guardados produjeron 0 errores y el archivo contenía el último valor. En mi ejecución el archivo final era correcto incluso en el caso roto, que es justamente por lo que este bug sobrevive a la revisión de código: solo aparece como excepciones en tu reporte de crashes.

Si guardas en cada pulsación de tecla o movimiento del slider, aplica también un debounce (300 ms es suficiente). La cola hace que los guardados concurrentes sean seguros; el debounce los hace baratos.

## Lo que cuestan realmente las escrituras

Ambos enfoques son lo bastante rápidos como para que el rendimiento no decida, pero "lo bastante rápido" merece un número. Medí la ruta de escritura del almacén JSON (codificar, escribir el archivo temporal, rename) con un payload de ajustes de 927 bytes (unas 40 claves, un mapa anidado, una lista de 20 elementos), 200 iteraciones de calentamiento y luego 2 000 iteraciones cronometradas, con `Stopwatch` bajo un `dart run` JIT (Dart 3.12.2) en un Apple M4, macOS, APFS:

| Operación | Mediana | p95 | p99 |
| --- | --- | --- | --- |
| Codificar + escribir + `flush: true` + rename | 177 µs | 235 µs | 318 µs |
| Codificar + escribir + rename (sin flush) | 155 µs | 247 µs | 328 µs |
| Leer + `jsonDecode` | 62 µs | 69 µs | n/a |

Dos advertencias. En el SSD del M4 el flush agregó solo unos 20 µs a la mediana; en almacenamiento flash de Android de gama baja espera que cueste bastante más, otra razón para aplicar debounce. Y no medí las escrituras de `shared_preferences`, porque pasan por un platform channel hacia `NSUserDefaults` o DataStore y el costo depende de la plataforma, no del plugin. Ninguno de los dos aparecerá en el presupuesto de un frame con payloads del tamaño de unos ajustes. El enfoque del archivo solo se vuelve un problema si los "ajustes" crecen hasta megabytes de datos en caché, y en ese punto ya no debería ser un archivo de ajustes.

## Las trampas que deciden por ti

**`getApplicationDocumentsDirectory()` es la carpeta Documentos del usuario en escritorio.** En Windows, `path_provider_windows` la mapea a `WindowsKnownFolder.Documents`. En Linux es el directorio de usuario XDG `DOCUMENTS`. Tu `settings.json` termina junto a las declaraciones de impuestos del usuario, OneDrive lo sincroniza y la gente que ordena sus carpetas lo borra. En iOS queda expuesto al usuario en cuanto activas `UIFileSharingEnabled`. La documentación de `path_provider` dice lo mismo a su manera: Documents es para datos generados por el usuario y, si no es el caso, conviene considerar `getApplicationSupportDirectory()`. Application Support se mapea a AppData roaming en Windows, a `XDG_DATA_HOME/<app id>` en Linux y a `Library/Application Support/<bundle id>` dentro del sandbox en macOS (confirmé que `settings.json` terminó en `~/Library/Containers/com.example.settingsDemo/Data/Library/Application Support/com.example.settingsDemo/` en la build de macOS). Todo tutorial de ajustes en JSON que usa Documents está mal en escritorio.

**La web descarta el archivo.** Si la app apunta a la web, la decisión está tomada: usa `shared_preferences` y guarda tu objeto estructurado como un solo string generado con `jsonEncode` bajo una única clave si necesitas anidación. Pierdes la garantía de durabilidad pero conservas el modelo de un solo objeto.

**Los isolates y engines en segundo plano ven cachés desactualizadas.** El README de `shared_preferences` es explícito: `SharedPreferences` y `SharedPreferencesWithCache` mantienen una caché por isolate, así que un valor escrito desde un handler en segundo plano de `firebase_messaging` o desde un segundo engine es invisible para el isolate principal hasta que llames a `reload()`. Si varios isolates escriben los mismos ajustes, usa `SharedPreferencesAsync`, que se salta la caché. Un archivo JSON tiene el mismo problema en una forma peor: dos isolates, cada uno con su propia cola de escritura, todavía pueden intercalarse, así que mantén todas las escrituras en un solo isolate y envíale mensajes desde los demás. Si ya haces trabajo pesado en un [isolate en segundo plano para tareas intensivas de CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/), no dejes que sea el dueño del archivo de ajustes.

**Las claves legacy llevan prefijo, las nuevas no.** La clase legacy `SharedPreferences` guarda cada clave con el prefijo `flutter.`. `SharedPreferencesWithCache` y `SharedPreferencesAsync` no: en mi build de macOS el plist contenía una clave `themeMode` sin prefijo. En Android las APIs nuevas usan DataStore por defecto, un archivo completamente distinto. Así que cambiar de API en una app ya publicada es una migración de datos, no un refactor. Ejecuta `migrateLegacySharedPreferencesToSharedPreferencesAsyncIfNecessary` de `package:shared_preferences/util/legacy_to_async_migration_util.dart` al arrancar, o tus usuarios perderán sus ajustes al actualizar.

**El backup de Android aplica a ambos.** Auto Backup incluye por defecto los archivos privados de la app y sus almacenes de preferencias, así que pasar a un archivo JSON no te saca del backup en la nube. Si un ajuste es específico del dispositivo (una URL de servidor en caché, un toggle de depuración), exclúyelo en tus reglas de backup en cualquiera de los dos casos.

## Lo que recomiendo

Empieza con `shared_preferences` y `SharedPreferencesWithCache` para flags planos. Es el valor por defecto correcto para la mayoría de las apps, funciona en todas las plataformas a las que apunta Flutter y es la única opción en la web. En el momento en que te sorprendas inventando nombres de clave con puntos, escribiendo tres claves relacionadas que deben cambiar juntas o queriendo una versión de esquema, mueve la parte estructurada a un único archivo JSON en `getApplicationSupportDirectory()`, escrito con flush, rename y una cola serializada. Muchas apps terminan con ambos: unos pocos flags en `shared_preferences` que necesitan el código nativo o el primer frame, y un `settings.json` para el objeto de ajustes real.

Si los datos no son ajustes en absoluto (contenido del usuario, historial, cualquier cosa que crezca), sáltate ambos y usa SQLite. Expliqué cómo mover los datos locales de una app de esa manera en [migrar una app de Flutter de Hive a drift](/es/2026/10/migrate-a-flutter-app-from-hive-to-drift/).

### Para leer después

- Si `getAll` lanza una `MissingPluginException` después de agregar el plugin, mira [cómo solucionar MissingPluginException en shared_preferences](/es/2023/10/how-to-fix-missingpluginexception-no-implementation-found-for-method-getall/).
- Los ajustes no son lo mismo que el estado transitorio de la UI: para posiciones de scroll y datos de formularios que deben sobrevivir a que el sistema mate tu app, usa [RestorationMixin para restaurar el estado de la UI tras la muerte del proceso en Android](/es/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/).
- Si tu objeto de ajustes contiene un tipo polimórfico, [serializar una jerarquía de sealed classes de Dart a y desde JSON](/es/2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json/) muestra la forma de `toJson`/`fromJson` a usar.
- Cargar ajustes es asíncrono, así que la pantalla que los cambia espera un guardado: [usar BuildContext de forma segura después de un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) cubre la comprobación de `mounted` que necesitas.

### Fuentes

- [README de `shared_preferences`: comparación de APIs, advertencias de caché, ubicaciones de almacenamiento](https://pub.dev/packages/shared_preferences)
- [Paquete `path_provider` y tabla de soporte de plataformas](https://pub.dev/packages/path_provider)
- [Comentario de documentación de `getApplicationDocumentsDirectory` (flutter/packages)](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider/lib/path_provider.dart)
- [Mapeo de known folders en `path_provider_windows`](https://github.com/flutter/packages/blob/main/packages/path_provider/path_provider_windows/lib/src/path_provider_windows_real.dart)
- [`File.rename` y `File.writeAsString` en `dart:io`](https://api.dart.dev/dart-io/File-class.html)
- [Android DataStore](https://developer.android.com/topic/libraries/architecture/datastore) y [Auto Backup para apps](https://developer.android.com/identity/data/autobackup)

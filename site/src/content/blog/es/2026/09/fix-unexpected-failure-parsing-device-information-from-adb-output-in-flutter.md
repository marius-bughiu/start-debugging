---
title: "Solución: Unexpected failure parsing device information from adb output en Flutter"
description: "Flutter 3.47.0 no puede analizar las filas de adb cuyo serial tiene 22 caracteres o más, así que los dispositivos Android inalámbricos y algunos USB desaparecen. Actualiza a 3.47.1 o posterior, o usa adb connect por IP."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "adb"
  - "flutter-tools"
lang: "es"
translationOf: "2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-16
---

Es un bug del parser de Flutter 3.47.0, y no necesitas reportarlo de nuevo. `adb devices -l` rellena la columna del serial hasta 22 caracteres y luego agrega un espacio, así que cualquier serial de 22 caracteres o más (todos los nombres `adb-...._adb-tls-connect._tcp` de la depuración inalámbrica, además de algunos seriales USB) va seguido de un solo espacio. El parser de 3.47.0 exige ahí dos espacios o un tabulador, rechaza la fila y deja fuera el dispositivo. Ejecuta `flutter upgrade` para obtener 3.47.1 o posterior (3.47.4 es la versión estable actual). Si tienes que quedarte en 3.47.0, conecta los dispositivos inalámbricos con `adb connect <ip>:<port>`, ya que el serial corto con la IP sí se analiza correctamente.

Reproduje todo lo que sigue en macOS con Flutter 3.44.8, 3.47.0 y 3.47.4 (Dart 3.13.0 y 3.13.3). Apunté cada versión a un Android SDK de prueba cuyo `platform-tools/adb` es un script falso, y le pasé las mismas nueve filas de dispositivos.

## El error en contexto

`flutter devices` lista los destinos de escritorio y web, pero no el teléfono que `adb devices` ve sin problemas:

```text
Found 2 connected devices:
  macOS (desktop) • macos  • darwin-arm64   • macOS 26.6.1 25G76 darwin-arm64
  Chrome (web)    • chrome • web-javascript • Google Chrome 151.0.7922.140

No wireless devices were found.

Unexpected failure parsing device information from adb output:
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:1
Please report a bug at https://github.com/flutter/flutter/issues.
```

En `flutter doctor` es fácil pasarlo por alto, porque la sección "Connected device" sigue mostrando la marca verde y la advertencia queda debajo:

```text
[✓] Connected device (2 available)
    ! Unexpected failure parsing device information from adb output:
      9b01005930533036340043eb2a5c2c device usb:17907712X product:serenity_p_in model:25028PC03I device:serenity transport_id:1
      Please report a bug at https://github.com/flutter/flutter/issues.
```

Ese segundo caso es un teléfono USB, no uno inalámbrico, y por eso el consejo de "solo pasa con la depuración inalámbrica" que encontrarás en algunos hilos está incompleto. Android Studio y VS Code obtienen su lista de dispositivos del mismo código de descubrimiento, así que el dispositivo también falta en el selector del IDE, y `flutter run -d <serial>` no tiene nada con qué coincidir.

Los reportes son [flutter/flutter#191167](https://github.com/flutter/flutter/issues/191167) (USB, Flutter 3.47.0 en macOS), [#191119](https://github.com/flutter/flutter/issues/191119) (emparejamiento por Wi-Fi en Fedora), [#191343](https://github.com/flutter/flutter/issues/191343) (Ubuntu), y los issues de origen [#189430](https://github.com/flutter/flutter/issues/189430) y [#189972](https://github.com/flutter/flutter/issues/189972).

## Por qué Flutter 3.47.0 rechaza una fila válida de adb

adb construye cada fila del listado largo en `append_transport` dentro de `transport.cpp`:

```cpp
// adb (platform/packages/modules/adb), transport.cpp
android::base::StringAppendF(result, "%-22s %s", serial.c_str(),
                             to_string(t->GetConnectionState()).c_str());
```

`%-22s` es un ancho mínimo, no una columna. Un serial de 10 caracteres como `ZN52278M76` recibe 12 espacios de relleno más el espacio literal, 13 espacios en total. Un serial de 21 caracteres recibe dos. Un serial de 22 caracteres o más recibe exactamente uno. Los seriales de la depuración inalámbrica son el nombre del servicio mDNS, y solo el sufijo `._adb-tls-connect._tcp` ya tiene 22 caracteres. Muchos seriales USB también: el serial de 30 caracteres de #191167 es un ejemplo.

Flutter 3.44.x analizaba las filas con `^(\S+)\s+(\S+)(.*)`: primer token, cualquier espacio en blanco, segundo token. Eso maneja bien un solo espacio, pero falla cuando el propio serial contiene un espacio. Si activas y desactivas la depuración inalámbrica rápidamente, mDNS agrega un sufijo de conflicto y el serial pasa a ser `adb-26151FDF60083B-9tP4nl (2)._adb-tls-connect._tcp`. Flutter 3.44.8 corta entonces el serial en el primer espacio. Mi adb falso registró la llamada recibida como `adb -s adb-26151FDF60083B-9tP4nl shell getprop`, y un servidor adb real no conoce ese serial truncado.

Corregir eso llevó tres intentos durante el ciclo de 3.47:

1. [#187943](https://github.com/flutter/flutter/pull/187943) cambió a una coincidencia perezosa del serial, `^(.*?)\s+(no permissions|\S+)...`, que salió en 3.47.0-0.1.pre. Rompió las filas que llevan un devpath sin el prefijo `key:`.
2. [#189369](https://github.com/flutter/flutter/pull/189369) lo corrigió listando explícitamente los estados conocidos de adb y exigiendo `(?:\s{2,}|\t+)` antes del estado. Se hizo cherry-pick a beta y salió en 3.47.0. Esa regla de dos espacios es el bug del que trata este artículo.
3. [#189973](https://github.com/flutter/flutter/pull/189973) cambió a una captura codiciosa del serial anclada en las palabras de estado conocidas, y luego recorta el relleno. Se hizo cherry-pick a stable como [#191296](https://github.com/flutter/flutter/pull/191296) y salió en 3.47.1 el 19 de agosto de 2026.

Esta es la regex de 3.47.0, tomada de `packages/flutter_tools/lib/src/android/android_device_discovery.dart`:

```dart
// Flutter 3.47.0, android_device_discovery.dart
static final _kDeviceRegex = RegExp(
  r'^(.*?)(?:\s{2,}|\t+)'
  r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)'
  r'(?:\s+(.*)|$)',
);
```

El único cambio en 3.47.1 es la primera línea, que pasó a ser `r'^(.*)\s+'`, más un `trimRight()` sobre el serial capturado. El archivo es idéntico desde 3.47.1 hasta 3.47.4 y en la beta 3.48.0-0.5.pre.

## Reproducción mínima con un adb falso

No necesitas un teléfono para ver esto. Flutter encuentra `adb` en `$ANDROID_HOME/platform-tools/adb`, así que un script de shell en esa ruta puede imprimir las filas que quieras. Usa el mismo formato `%-22s %s` que usa adb:

```bash
#!/bin/bash
# Fake adb for Flutter 3.44.8 / 3.47.0 / 3.47.4 repros: $SDK/platform-tools/adb
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  printf '%-22s %s\n' "adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" \
    "device product:oriole model:Pixel_6 device:oriole transport_id:2"
  echo
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
  printf '[ro.build.characteristics]: [phone]\n[ro.build.version.release]: [16]\n'
  printf '[ro.build.version.sdk]: [36]\n[ro.product.cpu.abi]: [arm64-v8a]\n'
  exit 0
fi
exit 0
```

```bash
# Flutter 3.47.0 vs 3.47.4, same fake SDK
chmod +x sdk/platform-tools/adb
ANDROID_HOME=$PWD/sdk XDG_CONFIG_HOME=$PWD/xdg flutter devices
```

`XDG_CONFIG_HOME` evita que una ruta que alguna vez guardaste con `flutter config --android-sdk` tenga prioridad sobre `ANDROID_HOME`. Pasé nueve filas por cada versión. La tabla muestra lo que imprimió `flutter devices`:

| Fila de adb | 3.44.8 | 3.47.0 | 3.47.4 |
|---|---|---|---|
| USB, serial de 10 caracteres `ZN52278M76` | listado | listado | listado |
| USB, serial de 21 caracteres | listado | listado | listado |
| USB, serial de 22 caracteres | listado | fallo de análisis | listado |
| USB, serial de 30 caracteres | listado | fallo de análisis | listado |
| mDNS inalámbrico `adb-...._adb-tls-connect._tcp` | listado | fallo de análisis | listado |
| mDNS inalámbrico con sufijo `(2)` | listado con serial truncado | fallo de análisis | listado |
| Inalámbrico `192.168.1.3:36809` | listado | listado | listado |
| mDNS inalámbrico, `unauthorized` | aviso "is not authorized" | fallo de análisis | aviso "is not authorized" |
| USB, `detached` | listado como dispositivo | fallo de análisis | fallo de análisis |

El límite entre 21 y 22 caracteres lo explica todo. La última fila es un problema aparte, que se trata más abajo en los detalles a tener en cuenta.

## Solución 1: actualiza Flutter a 3.47.1 o posterior

Primero comprueba qué versión tienes:

```bash
# Flutter 3.47.x
flutter --version
```

Si la primera línea dice `Flutter 3.47.0`, actualiza en el canal stable:

```bash
# moves 3.47.0 to the latest 3.47.x hotfix (3.47.4 as of 2026-09-16)
flutter upgrade
flutter devices
```

La corrección aparece en la [entrada del CHANGELOG de 3.47.1](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md) como "Fix ADB device list parsing for long wireless mDNS serials separated from state by a single space". El texto menciona seriales inalámbricos, pero la corrección también cubre los seriales USB largos, como muestra la tabla. Si fijas versiones con FVM o con una matriz de CI, sube la versión fijada a `3.47.4` en lugar de ejecutar `flutter upgrade`. Cada entrada fijada conserva su propio snapshot de la herramienta, así que una entrada en 3.47.0 seguirá fallando por su cuenta. Lo mismo aplica si [apuntas a varias versiones de Flutter desde un solo pipeline](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

No necesitas borrar `bin/cache/flutter_tools.snapshot` a mano. `flutter upgrade` recompila la herramienta. Si en cambio haces checkout de un tag con git, el siguiente comando `flutter` detecta la nueva revisión y también recompila el snapshot.

## Solución 2: quédate en 3.47.0 y conecta los dispositivos inalámbricos por IP

Si hoy no puedes actualizar, por ejemplo porque una rama de release está fijada a 3.47.0, acorta el serial. `adb connect` con una IP y un puerto crea un transporte cuyo serial es algo como `192.168.1.3:36809`. Tiene 17 caracteres, recibe dos o más espacios de relleno y se analiza bien en 3.47.0:

```bash
# Android 11+ wireless debugging, Flutter 3.47.0
# IP address & Port from Settings > Developer options > Wireless debugging
adb connect 192.168.1.3:36809
adb devices -l
flutter devices
```

Usa el puerto de conexión que aparece en la pantalla Wireless debugging, no el puerto de un solo uso del diálogo "Pair device with pairing code". El issue #191343 muestra el resultado en hardware real: las filas mDNS siguen imprimiendo la advertencia, y el dispositivo aparece listado con su serial de IP.

Para evitar que adb conecte automáticamente el transporte mDNS, y así también desaparezca la advertencia, define `ADB_MDNS_AUTO_CONNECT=0` antes de que arranque el servidor adb. En `adb_mdns.cpp` de adb, el valor `0` vacía la lista de servicios permitidos para la conexión automática, que por defecto solo contiene `adb-tls-connect`. La variable la lee el proceso del servidor, así que reinícialo:

```bash
# adb (platform-tools), macOS/Linux shell
adb kill-server
ADB_MDNS_AUTO_CONNECT=0 adb start-server
adb connect 192.168.1.3:36809
```

En Windows, ejecuta `set ADB_MDNS_AUTO_CONNECT=0` en cmd o `$env:ADB_MDNS_AUTO_CONNECT = "0"` en PowerShell antes de `adb start-server`. Android Studio arranca su propio servidor adb si no hay ninguno en ejecución, así que inicia el tuyo primero.

No hay un truco equivalente para dispositivos USB con seriales largos, porque no puedes acortar un serial de hardware. Para esos, la solución es actualizar. Si de verdad no puedes actualizar, usa una conexión inalámbrica por IP para ese dispositivo como se describe arriba.

## Comprueba tu propia salida de adb con ambos parsers

Si no estás seguro de si tus filas caen en este bug, este script de Dart ejecuta las regex de 3.47.0 y 3.47.1, copiadas textualmente de la herramienta, sobre lo que imprima `adb devices -l`:

```dart
// Dart 3.13 (Flutter 3.47). Run: adb devices -l | dart run check_adb_rows.dart
import 'dart:convert';
import 'dart:io';

const states =
    r'(device|offline|unauthorized|no permissions|bootloader|recovery|sideload|rescue|connecting|authorizing|host|unknown)';

final flutter3470 = RegExp(r'^(.*?)(?:\s{2,}|\t+)' + states + r'(?:\s+(.*)|$)');
final flutter3471 = RegExp(r'^(.*)\s+' + states + r'(?:\s+(.*)|$)');

Future<void> main() async {
  final lines = await stdin.transform(utf8.decoder).transform(const LineSplitter()).toList();
  for (final raw in lines) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('List of devices') || line.startsWith('* daemon ')) {
      continue;
    }
    final old = flutter3470.firstMatch(line);
    final fixed = flutter3471.firstMatch(line);
    print(line);
    print('  3.47.0:  ${old == null ? 'PARSE FAILURE' : 'serial="${old[1]}" state=${old[2]}'}');
    print('  3.47.1+: ${fixed == null ? 'PARSE FAILURE' : 'serial="${fixed[1]!.trimRight()}" state=${fixed[2]}'}');
  }
}
```

Con mis nueve filas de prueba coincidió con la herramienta real en todos los casos. Para la fila inalámbrica imprime:

```text
adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp device product:oriole model:Pixel_6 device:oriole transport_id:2
  3.47.0:  PARSE FAILURE
  3.47.1+: serial="adb-26151FDF60083B-9tP4nl._adb-tls-connect._tcp" state=device
```

## Detalles a tener en cuenta y errores parecidos

**Un dispositivo `detached` sigue fallando desde 3.47.1 hasta 3.47.4.** Las platform-tools recientes tienen `adb detach` y `adb attach`, que liberan un dispositivo USB para que otro proceso pueda usarlo. El nombre que adb le da a ese estado de conexión es `detached` (ver `to_string(ConnectionState)` en `adb.cpp`), y esa palabra no está en la lista de estados de Flutter, así que incluso el parser corregido reporta "Unexpected failure parsing device information" para esa fila. Flutter 3.44.8 listaba la misma fila como un dispositivo normal. Ejecuta `adb -s <serial> attach` y la fila vuelve a `device`. La beta 3.48.0-0.5.pre tiene la misma lista de estados, así que esto todavía no está corregido.

**Después de actualizar, puede que obtengas "is not authorized" en su lugar.** En 3.47.0, un dispositivo con serial largo que espera la aprobación de la depuración USB también aparece como fallo de análisis, lo que oculta el problema real. Una vez que 3.47.1+ analiza la fila, obtienes "Device ... is not authorized. You might need to check your device for an authorization dialog." Desbloquea el teléfono y acepta el aviso de la clave RSA.

**El sufijo `(2)` es un serial real y distinto.** Si `adb devices -l` muestra tanto `adb-XXXX._adb-tls-connect._tcp` como `adb-XXXX (2)._adb-tls-connect._tcp`, adb tiene dos transportes al mismo teléfono tras un conflicto de nombres mDNS. Flutter 3.47.1+ analiza cada fila por separado, así que ambos aparecen como entradas distintas. Elige cualquiera de los dos con `-d`, o activa y desactiva otra vez la depuración inalámbrica en el teléfono para volver a una sola entrada. En 3.44.x, el que tiene sufijo aparece con un serial truncado que luego los comandos de adb no encuentran, que es el bug que #187943 se propuso corregir.

**"No supported devices connected" con una fila de adb limpia es otro problema.** Si la fila se analiza pero el dispositivo sigue sin aparecer, revisa la ABI y el nivel de API, no el parser. El equivalente de ese problema en MAUI se trata en [doesn't support required ABI](/es/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/). Si el propio `adb` no se encuentra, el problema es la búsqueda del SDK, y el [artículo sobre cmdline-tools component is missing](/es/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) explica el orden en que Flutter resuelve el SDK.

**`adb server version doesn't match this client` no es un fallo de análisis.** Flutter reporta esa línea como un diagnóstico aparte. Normalmente significa que dos instalaciones de platform-tools compiten entre sí, a menudo la de Homebrew y la de Android Studio. Pon una de ellas primero en `PATH` y ejecuta `adb kill-server`.

## Relacionado

- [Solución: flutter doctor --android-licenses falla con cmdline-tools 23](/es/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) es otro bug de las herramientas de Android cuya solución real es un hotfix de 3.47.x.
- [Qué más incluyó el hotfix Flutter 3.47.1](/es/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/), incluido el cambio en la validación del plugin registrant.
- Si te conectas a una app que instalaste con `adb install`, consulta [cómo mantener appFlavor con valor tras un hot restart con flutter attach](/es/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- [Could not create Dart VM instance después de flutter upgrade](/es/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) es un caso en el que la solución es dejar atrás una versión rota concreta.
- Para el lado de iOS de la depuración en dispositivos reales, consulta [depurar Flutter en un iPhone físico desde Windows](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/).

## Fuentes

- [flutter/flutter#189972](https://github.com/flutter/flutter/issues/189972) y [#189430](https://github.com/flutter/flutter/issues/189430), los issues de origen, con los reportes de usuarios [#191167](https://github.com/flutter/flutter/issues/191167), [#191119](https://github.com/flutter/flutter/issues/191119) y [#191343](https://github.com/flutter/flutter/issues/191343).
- [flutter/flutter#189973](https://github.com/flutter/flutter/pull/189973), la corrección, y [#191296](https://github.com/flutter/flutter/pull/191296), su cherry-pick a stable.
- [flutter/flutter#189369](https://github.com/flutter/flutter/pull/189369) y [#187943](https://github.com/flutter/flutter/pull/187943), los cambios anteriores en el parser.
- [`android_device_discovery.dart` en 3.47.0](https://github.com/flutter/flutter/blob/3.47.0/packages/flutter_tools/lib/src/android/android_device_discovery.dart) y [en 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/android/android_device_discovery.dart).
- [CHANGELOG de Flutter en 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/CHANGELOG.md).
- Código fuente de adb: [`transport.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/transport.cpp) (`append_transport`), [`adb.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb.cpp) (nombres de los estados de conexión) y [`adb_mdns.cpp`](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/adb_mdns.cpp) (`ADB_MDNS_AUTO_CONNECT`).
- [Documentación de Android Debug Bridge](https://developer.android.com/tools/adb), incluida la depuración inalámbrica en Android 11+.

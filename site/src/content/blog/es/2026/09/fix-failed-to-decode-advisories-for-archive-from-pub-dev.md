---
title: "Solución: Failed to decode advisories for archive from https://pub.dev en flutter pub get"
description: "El aviso de advisories en pub get es inofensivo: pub get termina con código 0. pub.dev corrigió la respuesta defectuosa el 2026-05-04. Si todavía lo ves, la causa es un mirror o un proxy."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "ci"
lang: "es"
translationOf: "2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev"
translatedBy: "claude"
translationDate: 2026-09-25
---

Tus paquetes están bien. El mensaje viene de la comprobación de avisos de seguridad (security advisories) de pub, que se ejecuta después de la resolución, y `flutter pub get` sigue terminando con código 0. El brote masivo (todos los proyectos que dependen de `archive`, `http`, `dio`, `shared_preferences_android`, etc.) fue un bug del servidor de pub.dev. Entre el 2026-05-02 y el 2026-05-04 la API de advisories devolvió `"advisoriesUpdated": null`, y pub.dev lo corrigió el 2026-05-04. Si todavía lo ves hoy, la respuesta viene de un mirror de paquetes (`PUB_HOSTED_URL`, Artifactory, Nexus, un servidor pub privado) o de un proxy. Corrige ese servidor, o actualiza a Flutter 3.47.0 / Dart 3.13.0 o posterior, donde la traza de pila se reduce a un aviso de una sola línea. Si tu CI falla por esto, el problema real es un paso que trata stderr como un fallo.

Reproduje todas las variantes de abajo en macOS con Dart 3.12.2 (el SDK de Flutter 3.44.x) y Dart 3.13.4 (el SDK de Flutter 3.47.5). Ambos se ejecutaron contra un repositorio pub local de 40 líneas que implementa la [especificación de repositorio hospedado v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md) y me permite elegir qué devuelve el endpoint de advisories.

## El error en contexto

En Flutter 3.44.x y anteriores (Dart 3.12.x y anteriores), `flutter pub get` o `dart pub get` imprime esto para un paquete tras otro:

```text
Resolving dependencies...
Downloading packages...
Failed to decode advisories for archive from https://pub.dev.
FormatException: advisoriesUpdated must be a String
package:pub/src/source/hosted.dart 670                        HostedSource._extractAdvisoryDetailsForPackage
package:pub/src/source/hosted.dart 622                        HostedSource._fetchAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 839                        HostedSource._getAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 1120                       HostedSource.getAdvisoriesForPackageVersion
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 425                        SolveReport._reportPackage
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 221                        SolveReport._reportChanges
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 76                         SolveReport.show
===== asynchronous gap ===========================
package:pub/src/entrypoint.dart 642                           Entrypoint.acquireDependencies
...
Failed to decode advisories for http from https://pub.dev.
FormatException: advisoriesUpdated must be a String
...
```

En Flutter 3.47.0 y posteriores (Dart 3.13.0 y posteriores) la misma condición produce una línea por paquete:

```text
Failed to decode advisories for archive from https://pub.dev: advisoriesUpdated must be a String
```

`archive` suele ser el primer nombre que ves. El reporte recorre los paquetes en orden alfabético, y `archive` es una dependencia transitiva de `image` y de muchas herramientas de compilación, así que aparece pronto en la mayoría de los lock files de Flutter. Solo los paquetes que alguna vez tuvieron un aviso de seguridad disparan la consulta, por eso `http` y `dio` aparecían en todos los reportes y `path` nunca.

## Por qué pub consulta los advisories

Desde Dart 3.4 ([dart-lang/pub#4062](https://github.com/dart-lang/pub/pull/4062)), `pub get`, `pub upgrade` y `pub add` reportan los avisos de seguridad conocidos para las versiones que resolviste. Los datos vienen de [osv.dev](https://osv.dev), y pub.dev los reexporta a través de dos campos de su API:

1. El listado de versiones, `GET /api/packages/<name>`, tiene una marca de tiempo opcional `advisoriesUpdated`. Si está presente, el cliente asume que el servidor admite el endpoint de advisories para ese paquete.
2. El endpoint de advisories, `GET /api/packages/<name>/advisories`, devuelve `{"advisories": [...], "advisoriesUpdated": "<date-time>"}`.

El cliente guarda en caché la segunda respuesta en `$PUB_CACHE/hosted/<host>/.cache/<name>-advisories.json`, y usa la marca de tiempo para decidir si esa caché está desactualizada. En `_extractAdvisoryDetailsForPackage` dentro de [`hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart), el parser es estricto con la marca de tiempo:

```dart
// dart-lang/pub, lib/src/source/hosted.dart (Dart 3.12 and 3.13)
final advisoriesUpdated = body['advisoriesUpdated'];
if (advisoriesUpdated is! String) {
  throw const FormatException('advisoriesUpdated must be a String');
}
```

Esa `FormatException` se captura en `_fetchAdvisories`, se registra como aviso, y el método devuelve `null`, es decir, "no hay datos de advisories para este paquete". Para entonces la resolución ya terminó, y nada en `pubspec.lock` depende de ello. Lo único que se pierde es el reporte de advisories de ese paquete.

## Qué se rompió en pub.dev en mayo de 2026

El [post mortem](https://github.com/dart-lang/pub-dev/issues/9372) del equipo de pub.dev explica la secuencia. El 2026-04-23 una imagen Docker `FROM scratch` más ligera eliminó `unzip`, así que el job que descarga la exportación de osv.dev dejó de funcionar. El 2026-05-01 se reemplazó por una implementación de unzip en Dart a la que le faltaba una llamada a `init()`. Esa implementación extraía cero archivos, así que la siguiente sincronización del 2026-05-02 "no encontró" advisories y los borró todos del datastore.

El endpoint de advisories derivaba `advisoriesUpdated` del advisory almacenado más reciente, y no quedaba ninguno, así que devolvía `null`. El listado de versiones seguía llevando la marca de tiempo antigua de la entidad del paquete. Por lo tanto, cada cliente veía "este paquete tiene advisories", los consultaba y se atragantaba con:

```json
{"advisories": [], "advisoriesUpdated": null}
```

[dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368) ("Fix advisoriesUpdated") salió el 2026-05-04. Los advisories se recargaron y el issue se cerró el 2026-05-05. Hoy un paquete sin advisories devuelve el epoch de Unix en lugar de `null`:

```bash
# pub.dev, checked 2026-09-25
curl -s https://pub.dev/api/packages/path/advisories
# {"advisories":[],"advisoriesUpdated":"1970-01-01T00:00:00.000"}
```

Del lado del cliente, [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817) ("Quiet warning instead of stack trace when failing to parse advisories") reemplazó la traza de pila por un mensaje de una línea. Revisé el `pub_rev` fijado en el archivo `DEPS` del Dart SDK para cada tag de versión. El cambio no está en 3.12.0 a 3.12.2, y sí está en todas las versiones 3.13.x. En términos de Flutter, 3.44.0 a 3.44.9 todavía imprimen la traza completa, y 3.47.0 es la primera versión estable que no lo hace.

## Reproducción mínima con un servidor pub local

No necesitas que pub.dev esté roto para ver esto. Un pequeño servidor Node que sigue la especificación del repositorio, con un interruptor para la respuesta de advisories, reproduce todas las variantes. Esta es la parte relevante:

```js
// Node 24, server.mjs: minimal pub repository (spec v2)
if (req.url === '/api/packages/fakepkg') {
  res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' });
  return res.end(JSON.stringify({
    name: 'fakepkg',
    advisoriesUpdated: '2026-04-20T10:00:00.000Z', // tells pub to fetch advisories
    latest: { version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec },
    versions: [{ version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec }],
  }));
}
if (req.url === '/api/packages/fakepkg/advisories') {
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ advisories: [], advisoriesUpdated: null }));
}
```

La app apunta una dependencia a él:

```yaml
# pubspec.yaml, Dart 3.12.2 / 3.13.4
name: app
publish_to: none
environment:
  sdk: ^3.0.0
dependencies:
  fakepkg:
    hosted: http://localhost:8123
    version: ^1.0.0
```

Ejecutándolo en ambos SDK, con un `PUB_CACHE` nuevo cada vez:

```bash
# Dart 3.12.2
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# out.txt: Resolving dependencies... Downloading packages... + fakepkg 1.0.0  Changed 1 dependency!
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123.
#          FormatException: advisoriesUpdated must be a String
#          package:pub/src/source/hosted.dart 648  HostedSource._extractAdvisoryDetailsForPackage
#          ... (full async stack trace)

# Dart 3.13.4
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123: advisoriesUpdated must be a String
```

Tres cosas que la reproducción deja claras:

- **El código de salida es 0 en ambas versiones.** El paquete se descarga y `pubspec.lock` se escribe.
- **Todo va a stderr.** stdout queda limpio.
- **La respuesta defectuosa nunca se guarda en caché.** Después, `$PUB_CACHE/hosted/localhost%588123/.cache/` contiene `fakepkg-versions.json` pero no `fakepkg-advisories.json`. La escritura en caché ocurre después de un parseo exitoso, así que pub vuelve a preguntar en cada ejecución, incluido un `pub get` en el que nada cambió. Borrar la caché de pub no ayuda, porque la caché nunca fue el problema. Eso coincide con los reportes en el issue de pub-dev de personas que ejecutaron `flutter pub cache clean` y aun así obtuvieron el error.

## Cómo solucionarlo, en orden de probabilidad

### 1. Confirma de dónde viene la respuesta

Ejecuta un get en modo verbose y busca la solicitud de advisories:

```bash
# Flutter 3.47.5 / Dart 3.13.4
dart pub get --verbose 2>&1 | grep -A3 "Fetching security advisories"
# IO  : Fetching security advisories from https://pub.dev/api/packages/archive/advisories.
# IO  : HTTP GET https://pub.dev/api/packages/archive/advisories
```

Luego consulta tú mismo esa URL exacta:

```bash
curl -s https://pub.dev/api/packages/archive/advisories | head -c 300
```

Si el host es `pub.dev` y el cuerpo tiene un `advisoriesUpdated` de tipo string, el lado del servidor está sano. Cualquier mensaje restante viene de algo entre tú y pub.dev, normalmente un proxy con inspección TLS que reescribe las respuestas. Si el host no es pub.dev, revisa `echo $PUB_HOSTED_URL` y cualquier URL `hosted:` en `pubspec.yaml`. Ese servidor es el culpable.

### 2. Evita que el CI trate el aviso como un fallo

pub termina con 0, así que si un pipeline se puso en rojo por este mensaje, algún paso está fallando por la salida en stderr. Los sospechosos habituales son las tareas de script de Azure Pipelines con `failOnStderr: true`, y los scripts de Windows PowerShell 5.1 que ejecutan `flutter pub get 2>&1` bajo `$ErrorActionPreference = 'Stop'`. PowerShell 5.1 convierte cada línea de stderr redirigida en un `ErrorRecord`, y con `Stop` la primera termina el script. Condiciona el resultado al código de salida:

```yaml
# Azure Pipelines, Flutter 3.47.5
- script: flutter pub get
  displayName: Restore packages
  failOnStderr: false   # pub prints advisory warnings to stderr and still exits 0
```

```powershell
# Windows PowerShell 5.1, Flutter 3.47.5
$ErrorActionPreference = 'Continue'
flutter pub get
if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed ($LASTEXITCODE)" }
```

Los wrappers que buscan `Exception` o `Error` en el registro con grep tienen el mismo problema. Un fallo real de resolución como [`version solving failed`](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) establece un código de salida distinto de cero, así que el código de salida es suficiente.

### 3. Actualiza a Flutter 3.47.0 o posterior

Esto no detiene el aviso, pero la forma de una línea es mucho menos alarmante en los registros y no entierra la salida que te importa. Si tu CI fija Flutter por rama, el enfoque de [apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) te permite mover el job por defecto a 3.47.x sin tocar los demás.

### 4. Corrige el mirror o el servidor pub privado

La especificación le da a un mirror dos opciones válidas, y debe elegir una:

- Hacer de proxy de `/api/packages/<name>/advisories` fielmente, con `advisoriesUpdated` siempre como string.
- O eliminar `advisoriesUpdated` del listado de versiones que sirve. La especificación hace el campo opcional, y cuando está ausente, el cliente no llama al endpoint de advisories en absoluto. Pierdes el reporte de advisories, pero pub deja de preguntar.

Los repositorios remotos en Artifactory y productos similares guardan en caché los metadatos del upstream. Un usuario de Artifactory en el issue de pub-dev se topó con un fallo distinto: el propio parser del proxy lanzó una `NullPointerException` por el campo `null`. Si tu proxy guardó en caché una respuesta de la ventana de mayo de 2026, limpiar la caché de metadatos de ese repositorio remoto (Artifactory lo llama "zap cache") hace que obtenga la respuesta corregida. Esto lo tiene que hacer quien administra el proxy. Nada del lado del cliente lo va a cambiar.

### 5. Omite la comprobación donde realmente no importa

`dart pub get --offline` / `flutter pub get --offline` nunca consulta advisories. El código retorna antes en modo offline. Esto solo funciona cuando todos los paquetes ya están en la caché local de pub, así que encaja en agentes de compilación herméticos con una caché precalentada, no como solución general. No lo uses para ocultar un mirror roto en las máquinas de los desarrolladores, porque también pierdes el reporte de seguridad para el que existe la comprobación.

## Variantes que se parecen

**`Failed to decode advisories for X from ...: Unexpected character (at character 1)`** seguido de una línea de HTML. La solicitud de advisories recibió una página HTML, normalmente un portal cautivo, un login de proxy o una página de error que devuelve HTTP 200. Lo reproduje devolviendo `<html>proxy login</html>`. El código de salida sigue siendo 0 y la solución está en la ruta de red, no en pub.

**`Warning: Unable to fetch advisories for "X" from "https://my-mirror/"`**. El endpoint de advisories devolvió un estado que no es 2xx desde un host que no es pub.dev. Es un aviso, código de salida 0. Este comportamiento se remonta a [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275) en 2024. Antes de eso, un mirror sin el endpoint hacía fallar `pub get`.

**`Failed to fetch advisories for "X" from "https://pub.dev"`**. La misma situación, pero el host es pub.dev. pub trata este caso como fatal (`fail(...)`) y termina con un código distinto de cero, ya que se supone que pub.dev siempre sirve el endpoint. Si ves este, realmente es una caída de pub.dev o algo que bloquea esa ruta. Revisa [el issue tracker de pub.dev](https://github.com/dart-lang/pub-dev/issues) antes de cambiar nada localmente.

**`FormatException: advisories must be a list`** o **`advisory must be a map`**. La misma ruta de código, un campo mal formado distinto. Un servidor pub casero está devolviendo la forma incorrecta. Compara su respuesta con la sección del formato OSV de la especificación.

## Relacionado

- [Solución: version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) cubre el error de pub que sí detiene una compilación, y cómo leer su salida.
- [Cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), útil al mover el CI a un SDK 3.47.x.
- [Fijar la versión del engine de Flutter para compilaciones reproducibles](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/), ya que saber exactamente qué SDK ejecutan tus agentes es cómo distingues la salida de 3.44 de la de 3.47.
- [Solución: Unexpected failure parsing device information from adb output](/es/2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter/) es otro mensaje ruidoso de las herramientas de Flutter donde lo correcto es una versión específica del SDK.
- [Qué más incluyó el hotfix de Flutter 3.47.1](/es/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/).

## Fuentes

- [dart-lang/pub-dev#9372](https://github.com/dart-lang/pub-dev/issues/9372), el reporte original y el post mortem, más los duplicados [dart-lang/sdk#63308](https://github.com/dart-lang/sdk/issues/63308) y [flutter/flutter#185943](https://github.com/flutter/flutter/issues/185943).
- [dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368), la corrección del servidor.
- [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817), el aviso más discreto del cliente, y [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275), el manejo elegante de un endpoint de advisories ausente.
- [`lib/src/source/hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) en dart-lang/pub (`_fetchAdvisories`, `_extractAdvisoryDetailsForPackage`, `_getAdvisories`).
- [Hosted Pub Repository Specification v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md), secciones sobre `advisoriesUpdated` y "List security advisories for a package".
- [`DEPS` del Dart SDK](https://github.com/dart-lang/sdk/blob/3.13.0/DEPS) (`pub_rev`) en los tags 3.12.x y 3.13.x, y el [manifiesto de versiones de Flutter](https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json) para la correspondencia de Flutter a Dart.
- [Troubleshooting pub](https://dart.dev/tools/pub/troubleshoot) en dart.dev.

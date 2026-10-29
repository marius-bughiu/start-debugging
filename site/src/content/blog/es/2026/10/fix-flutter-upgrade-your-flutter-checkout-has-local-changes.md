---
title: "Solución: flutter upgrade dice \"Your flutter checkout has local changes that would be erased by upgrading\""
description: "flutter upgrade se aborta si git status en la carpeta del SDK imprime algo. Inspecciónalo, restaura pubspec.lock o usa git stash -u, y deja --force como último recurso."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "git"
lang: "es"
translationOf: "2026/10/fix-flutter-upgrade-your-flutter-checkout-has-local-changes"
translatedBy: "claude"
translationDate: 2026-10-29
---

`flutter upgrade` ejecuta `git status -s` dentro de la carpeta del SDK de Flutter y se niega a continuar si imprime una sola línea, incluidos archivos sin seguimiento que nunca quisiste conservar. Encuentra el SDK con `flutter --version --machine` (el campo `flutterRoot`), ejecuta `git status --short` ahí y luego restaura el archivo (normalmente `pubspec.lock`), guarda tus ediciones con `git stash push -u` o, si nada del SDK te importa, ejecuta `flutter upgrade --force`. Todo lo que sigue se comprobó en Flutter 3.44.8 y 3.47.7/3.47.8 (stable, Dart 3.12.2) el 2026-10-29.

## El error en contexto

Ejecutas `flutter upgrade` en una máquina donde estás seguro de que nunca tocaste Flutter en sí, y obtienes esto:

```text
$ flutter upgrade
Your flutter checkout has local changes that would be erased by upgrading. If you want to keep these changes, it is recommended that you stash them via "git stash" or else commit the changes to a local branch. If it is okay to remove local changes, then re-run this command with "--force".
```

El código de salida es 1 y no ha cambiado nada. El mensaje trata sobre el checkout de git **del SDK**, no del repositorio de tu app. El `git status` de tu app puede estar completamente limpio y aun así verás este mensaje.

## Por qué ocurre

El SDK de Flutter es un clon de git de `flutter/flutter`, y `flutter upgrade` es en esencia `git fetch` más `git reset --hard <new revision>` con algunas comprobaciones de seguridad alrededor. El código relevante vive en `packages/flutter_tools/lib/src/commands/upgrade.dart`, y el orden de las operaciones importa:

1. `git fetch --tags`, y luego se resuelve la revisión upstream de tu rama (`stable`, `beta`, `main`).
2. Si ya estás en esa revisión, imprime "Flutter is already up to date" y sale con 0. **No se hace ninguna comprobación de cambios locales.**
3. Si se pasó `--verify-only`, imprime la versión disponible y sale.
4. Si el commit actual no tiene una etiqueta de versión reconocible y no pasaste `--force`, aborta con "Unknown flutter tag".
5. Si no pasaste `--force` y `hasUncommittedChanges()` devuelve true, aborta con el error de arriba.
6. `git reset --hard <upstream revision>`, y luego vuelve a lanzar la nueva herramienta con `flutter upgrade --continue` para precargar artefactos, ejecutar `pub upgrade` en tu proyecto y ejecutar `flutter doctor`.

`hasUncommittedChanges()` es un envoltorio fino sobre `git status -s`. En el canal stable, cualquier salida no vacía cuenta como un cambio. Desde Flutter 3.47.0 ([PR #184997](https://github.com/flutter/flutter/pull/184997)), los canales beta y main omiten las líneas que terminan en `pubspec.lock`, porque main escribe por su cuenta restricciones de SDK de desarrollo en ese archivo. Stable no recibe esa excepción.

De usar `git status -s` se derivan dos consecuencias directas:

- **Los archivos sin seguimiento cuentan.** Un `notes.txt` suelto en la carpeta del SDK bloquea la actualización, aunque `git reset --hard` nunca lo borraría.
- **Los archivos ignorados por git no cuentan.** El `.gitignore` del SDK ya cubre `.idea/`, `.vscode/*`, `.pub-cache/`, `.dart_tool/`, `bin/cache/`, `*.log` y todos los `*.lock` salvo el `/pubspec.lock` de la raíz. `.pub-cache/` se agregó tras el [issue #128635](https://github.com/flutter/flutter/issues/128635), donde una instalación con snap mantenía su caché de pub dentro del SDK.

Así que la pregunta real nunca es "¿tengo cambios locales?", sino "¿qué imprime `git status --short` en la carpeta del SDK y quién lo puso ahí?".

## Reproducción mínima

Reproduje cada caso en un clon de prueba de `flutter/flutter` reseteado a la etiqueta `3.47.7`, una versión por detrás de `stable` (3.47.8). Para no ejecutar código recién clonado, manejé la lógica de actualización desde mi Flutter 3.44.8 instalado con el flag oculto `--working-directory` de la herramienta, que apunta el comando a otro checkout y omite la segunda mitad reentrante. La comprobación del canal stable es idéntica byte a byte entre 3.44.8 y 3.47.8.

```bash
# Flutter 3.44.8 tool, scratch checkout at 3.47.7, upstream stable = 3.47.8
C=~/scratch/flutter
git -C "$C" reset -q --hard 3.47.7

echo hi > "$C/notes.txt"                       # untracked file only
flutter upgrade --working-directory="$C"
# Your flutter checkout has local changes that would be erased by upgrading. ...
# exit=1
```

Esto es lo que hizo cada escenario:

| Estado del checkout del SDK | `git status -s` | Resultado de `flutter upgrade` |
| --- | --- | --- |
| Limpio, una versión por detrás | (vacío) | Actualiza |
| `notes.txt` sin seguimiento | `?? notes.txt` | Bloqueado |
| Archivos en `.idea/`, `.pub-cache/`, `debug.log` | (vacío, solo se muestran con `--ignored`) | No bloqueado |
| `pubspec.lock` de la raíz editado | ` M pubspec.lock` | Bloqueado |
| Código fuente del framework editado + archivo sin seguimiento, `--force` | ` M packages/flutter/...`, `?? notes.txt` | Actualiza; la edición del framework desaparece, `notes.txt` sigue ahí |
| Ya en 3.47.8 con `?? notes.txt` | `?? notes.txt` | "Flutter is already up to date", salida 0 |

La última fila explica un patrón confuso: el archivo suelto lleva meses ahí sin quejas, y el error solo aparece el día de un lanzamiento, cuando por fin hay algo a lo que actualizar.

## La causa más común: el `pubspec.lock` del propio SDK

Si `git status --short` muestra ` M pubspec.lock` y nada más, Flutter modificó su propio archivo de bloqueo. El repositorio de Flutter es un workspace de pub, y su `pubspec.lock` de la raíz es el único archivo de bloqueo con seguimiento en el árbol. Cualquier cosa que ejecute `pub upgrade` con la raíz del SDK como proyecto lo reescribe, porque los paquetes publicados después de la versión (por ejemplo un `objective_c` más reciente) cumplen las mismas restricciones.

Hasta Flutter 3.44.x incluido, `flutter upgrade` se hacía esto a sí mismo. El `flutter upgrade --continue` reentrante se lanzaba con la raíz del SDK como directorio de trabajo, así que el paso de "actualizar los paquetes de tu proyecto" llamaba a `findProjectRoot()`, que sube desde el directorio actual buscando un `pubspec.yaml`, encontraba el del propio SDK y ejecutaba `pub upgrade` sobre él. La actualización tenía éxito, dejaba un archivo de bloqueo sucio y la *siguiente* actualización fallaba. Ese es el [issue #187977](https://github.com/flutter/flutter/issues/187977), y coincide con los reportes de "solo ocurre en instalaciones que ya se actualizaron una vez".

Puedes ver la deriva tú mismo. En un checkout limpio de la etiqueta `3.44.0`, ejecutar `pub upgrade` en la raíz del SDK con Dart 3.12.2 (la línea de Dart que incluye 3.44) reescribió el archivo de bloqueo (14 inserciones, 6 eliminaciones):

```bash
# Flutter 3.44.0 checkout, Dart 3.12.2, 2026-10-29
cd ~/scratch/flutter && dart pub upgrade
git diff --stat
#  pubspec.lock | 20 ++++++++++++++------
```

```diff
       name: jni
-    version: "1.0.0"
+    version: "1.1.1"
       name: jni_flutter
-    version: "1.0.1"
+    version: "1.0.4+1"
       name: objective_c
-    version: "9.2.3"
+    version: "9.3.0"
```

`objective_c` de 9.2.3 a 9.3.0 es exactamente el diff del reporte del issue. El [PR #188794](https://github.com/flutter/flutter/pull/188794) lo corrigió lanzando la segunda mitad en tu directorio de trabajo original, y llegó en Flutter 3.47.0. Así que si estás en 3.44.x, espera ver este error una vez más de camino a 3.47, y después debería desaparecer.

Esa corrección tiene una trampa. La segunda mitad ahora ejecuta `pub upgrade` sobre el proyecto que `findProjectRoot()` encuentre desde **tu** directorio actual, y esa función sube por el árbol. Si ejecutas `flutter upgrade` desde dentro del árbol del SDK, por ejemplo `~/development/flutter/bin`, vuelve a encontrar el `pubspec.yaml` del SDK y ensucia el archivo de bloqueo también en 3.47. Ejecuta las actualizaciones desde tu directorio home o desde la carpeta de una app, nunca desde dentro del SDK. (Ejecutarlo desde la carpeta de una app actualiza las dependencias de esa app, lo cual es otro tema, tratado en [por qué cambia `pubspec.lock` después de `flutter upgrade`](/es/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).)

## Solución, en detalle

### 1. Encuentra el SDK y mira antes de forzar

No recurras a `--force` primero. Averigua qué hay realmente ahí.

```bash
# Flutter 3.44+ on macOS / Linux (needs jq)
SDK="$(flutter --version --machine | jq -r .flutterRoot)"
git -C "$SDK" status --short
git -C "$SDK" diff --stat
```

```powershell
# Flutter 3.44+ on Windows PowerShell
$sdk = (flutter --version --machine | ConvertFrom-Json).flutterRoot
git -C $sdk status --short
git -C $sdk diff --stat
```

`flutter doctor -v` imprime la misma ruta en la línea "Flutter version X on channel Y at <path>" si prefieres no analizar JSON. En una instalación de Homebrew cask, `flutterRoot` es el checkout real (`/opt/homebrew/share/flutter` en mi máquina), no el enlace simbólico `bin/flutter`.

### 2a. Solo `pubspec.lock` está modificado: restáuralo

Este es el caso de "lo escribió Flutter" de arriba. El archivo se regenera de todos modos, así que descarta el cambio y actualiza con normalidad:

```bash
# Flutter 3.44.x -> 3.47.x, stable channel
git -C "$SDK" checkout -- pubspec.lock
cd ~ && flutter upgrade
```

Ejecutar la actualización desde `~` evita que la segunda mitad encuentre un `pubspec.yaml` dentro del SDK.

### 2b. Cambiaste archivos del framework a propósito: guárdalos con stash

Quizá parcheaste un widget mientras perseguías un bug, o agregaste un `debugPrint` dentro de `packages/flutter`. Si quieres recuperar esas ediciones después de la actualización, guárdalas con stash, incluidos los archivos sin seguimiento:

```bash
# Flutter 3.47.7 -> 3.47.8, verified 2026-10-29
git -C "$SDK" stash push -u -m "before flutter upgrade"
flutter upgrade
git -C "$SDK" stash pop
```

En mi reproducción esto actualizó limpiamente a 3.47.8 y `stash pop` restauró tanto el `text.dart` modificado como el `notes.txt` sin seguimiento. Si los archivos que tocaste cambiaron upstream entre las dos versiones, `stash pop` puede generar conflictos, que es el resultado honesto: tu parche se escribió contra una versión distinta del framework.

Si mantienes parches de larga duración sobre el framework, un stash es la herramienta equivocada. Haz commit de ellos en una rama local o, mejor, mantén un fork y apunta a él un SDK específico del proyecto mediante un gestor de versiones, de modo que el SDK que actualizas no sea el que parcheas.

### 2c. Nada de lo que hay importa: `--force`

Cuando `git status --short` muestra solo ruido que no te importa, fuérzalo:

```bash
# Flutter 3.47.x, stable channel
flutter upgrade --force    # or: flutter upgrade -f
```

Entiende qué hace `--force`, porque no es lo que la mayoría supone:

- Omite la comprobación de "Unknown flutter tag" y la de cambios locales. Eso es todo.
- Luego ejecuta `git reset --hard <upstream revision>`. Las ediciones con seguimiento se descartan sin respaldo, y cualquier commit que hayas hecho en tu rama `stable` local sale de la rama, recuperable solo mediante `git reflog`.
- **No** borra los archivos sin seguimiento. En mi reproducción, `notes.txt` sobrevivió a `--force` y `git status` lo seguía listando después. No bloqueó la siguiente ejecución solo porque esta llegó primero a "already up to date". En el siguiente lanzamiento vuelve a bloquear.

Para eliminar los archivos sin seguimiento de forma definitiva, primero previsualízalos y luego bórralos:

```bash
# Run inside the SDK folder; -n is a dry run
git -C "$SDK" clean -n -d
git -C "$SDK" clean -f -d
```

`git clean` borra archivos de forma permanente y respeta `.gitignore`, así que no tocará `bin/cache/` ni `.pub-cache/`. Lee la salida de `-n` antes de ejecutar la versión real.

### 3. Evita que vuelva a pasar

- Pasa a Flutter 3.47.0 o posterior, que contiene la corrección del directorio de trabajo reentrante.
- Nunca ejecutes `flutter upgrade` desde dentro del árbol del SDK.
- No guardes archivos temporales, notas ni proyectos de experimento dentro de la carpeta del SDK. Crea las apps junto a él, no dentro.
- En Windows, no instales el SDK extrayendo el archivo con "Extraer todo" del Explorador de archivos. El Explorador no puede crear algunas rutas profundas del SDK (los goldens de la app de escenarios de iOS superan `MAX_PATH`), las omite, y esos archivos con seguimiento que faltan aparecen como eliminados en `git status`, lo que bloquea todas las actualizaciones futuras ([issue #193197](https://github.com/flutter/flutter/issues/193197), seguido en [#183172](https://github.com/flutter/flutter/issues/183172)). Instala con `git clone` en su lugar, tras habilitar las rutas largas en Git (`core.longpaths`) y en Windows, como describe la [documentación de actualización de Flutter](https://docs.flutter.dev/install/upgrade). Si ya tienes una instalación así, `git -C $sdk checkout -- .` después de habilitar las rutas largas restaura los archivos que faltan.

## Trampas y casos parecidos

**"Unknown flutter tag. Abandoning upgrade to avoid destroying local changes."** Es otra comprobación, de la misma familia. Se dispara cuando `git describe` no encuentra una etiqueta de versión cerca de tu commit, normalmente tras un clon superficial sin etiquetas o tras hacer checkout de un commit arbitrario. En un canal oficial el mensaje te dice que uses git directamente; en otros sugiere `--force`. Descarga las etiquetas (`git -C "$SDK" fetch --tags`) antes de forzar.

**"Your Flutter checkout is currently not on a release branch."** Estás en un HEAD desacoplado, normalmente porque seguiste el consejo de la documentación de `git checkout <version>` para fijar una versión. Ejecuta `flutter channel stable` para volver a una rama y luego actualiza.

**"The current Flutter branch/channel is not tracking any remote repository."** Tu rama local no tiene upstream. La corrección documentada es reinstalar; `git -C "$SDK" branch -u origin/stable` también funciona si `origin` es el remoto oficial.

**Ruido de modos de archivo o de finales de línea.** Si `git diff` en el SDK muestra solo líneas `old mode 100755` / `new mode 100644`, algo (un `chmod -R`, una copia entre sistemas de archivos, una carpeta sincronizada) cambió los permisos. Si en Windows todos los archivos aparecen como modificados, el checkout se copió con finales de línea distintos. En ambos casos no cambió nada que te importe; `git -C "$SDK" checkout -- .` o `--force` es lo correcto. El `.gitattributes` del SDK usa `* text=auto`, así que un clon nuevo es la salida más limpia si la copia quedó muy deteriorada.

**El error aparece en CI.** Si una imagen de CI guarda en caché el SDK entre ejecuciones y un trabajo anterior ejecutó `flutter upgrade` en un SDK 3.44.x (o desde dentro del árbol del SDK), el checkout en caché arrastra el archivo de bloqueo sucio y todos los pasos de actualización posteriores fallan. Fija la versión en lugar de actualizar en CI; consulta [cómo apuntar a varias versiones de Flutter desde un mismo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**`flutter upgrade` funcionó, pero ahora tu proyecto no se resuelve.** Eso es la segunda mitad ejecutando `pub upgrade` en tu app con los pines del nuevo SDK, no este error. Empieza por [cómo corregir "version solving failed" en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Relacionado

- [Solución: pubspec.lock aparece modificado después de flutter upgrade o de cambiar de versión de Flutter](/es/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) cubre la misma deriva en el archivo de bloqueo de tu app en lugar del del SDK.
- [Cómo apuntar a varias versiones de Flutter desde un mismo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) para fijar SDKs en lugar de actualizarlos en el sitio.
- [Solución: "version solving failed" en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) para lo que puede romperse justo después de una actualización.
- [Solución: flutter doctor --android-licenses falla con cmdline-tools 23](/es/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/), otro error de herramientas donde la solución depende de la versión de Flutter que uses.

## Fuentes

- [`upgrade.dart` en la rama stable](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/upgrade.dart), el orden de las comprobaciones y la llamada a `git status -s`.
- [`findProjectRoot` en `os.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/base/os.dart), la búsqueda ascendente de `pubspec.yaml`.
- [PR #188794: Run re-entrant upgrade in original CWD](https://github.com/flutter/flutter/pull/188794), publicado en 3.47.0.
- [PR #184997: Ignore pubspec.lock dirty checkout modifications on non-stable channels](https://github.com/flutter/flutter/pull/184997), publicado en 3.47.0.
- [Issue #187977](https://github.com/flutter/flutter/issues/187977) (deriva de `objective_c` en stable), [issue #178777](https://github.com/flutter/flutter/issues/178777) (deriva en main), [issue #128635](https://github.com/flutter/flutter/issues/128635) (`.pub-cache` dentro del SDK), [issue #193197](https://github.com/flutter/flutter/issues/193197) (extracción con el Explorador de Windows).
- [Upgrading Flutter](https://docs.flutter.dev/install/upgrade) en docs.flutter.dev, incluida la sección "Filename too long" de Windows.

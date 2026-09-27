---
title: "Cómo acelerar un servidor de análisis de Dart lento en VS Code para un monorepo grande de Flutter"
description: "Un monorepo con decenas de archivos pubspec.yaml hace que el servidor de análisis de Dart construya un contexto de análisis por paquete, y ahí se van la memoria y el arranque de un minuto. Conviértelo en un pub workspace, excluye el código generado en analysis_options.yaml, elimina los plugins legacy del analizador y usa la página Insights para comprobarlo. Medido en Dart 3.12.2: 2.3x menos memoria pico y la mitad del tiempo de análisis en frío."
pubDate: 2026-09-27
template: "how-to"
tags:
  - "dart"
  - "flutter"
  - "vs-code"
  - "performance"
  - "monorepo"
  - "how-to"
lang: "es"
translationOf: "2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo"
translatedBy: "claude"
translationDate: 2026-09-27
---

**Respuesta corta:** en un monorepo de Flutter, el servidor de análisis de Dart es lento sobre todo porque crea un contexto de análisis separado para cada paquete que tiene su propio `pubspec.yaml` y su propio `.dart_tool/package_config.json`, y cada contexto carga su propia copia del SDK, de Flutter y de cada dependencia compartida. Convierte el repo en un [pub workspace](https://dart.dev/tools/pub/workspaces) (Dart 3.6+) para que todos los paquetes se resuelvan en un único contexto compartido, excluye el código generado con `analyzer: exclude:` en el `analysis_options.yaml` raíz, elimina los plugins legacy del analizador como `custom_lint` y abre la raíz del workspace en VS Code. En un repo sintético de 40 paquetes y 3 240 archivos, eso redujo la memoria pico de unos 1.2 GB a 0.5 GB y el análisis en frío de 17-22 s a 11-12 s, antes de tocar siquiera el código generado.

Todo lo que sigue se midió con Dart 3.12.2 (Flutter 3.44.8) en una Mac con Apple Silicon. La versión estable actual es Dart 3.13.3, que se distribuye con la línea Flutter 3.47; las claves de configuración y el comportamiento descrito aquí no cambian ahí, y 3.13.2 además marca como obsoleto el sistema legacy de plugins que la sección 4 te pide abandonar.

## Por qué un repo se convierte en cuarenta analizadores

El servidor de análisis (el proceso detrás de `dart language-server`, que inicia la extensión Dart-Code, y detrás de `dart analyze`) organiza el trabajo en contextos de análisis. Un contexto es un conjunto de archivos que comparten una misma resolución de paquetes y un mismo conjunto de opciones de análisis. Cada contexto mantiene su propio modelo de elementos resuelto de todo lo que puede ver, lo que en un paquete de Flutter significa el SDK de Dart, el paquete `flutter` completo y cada dependencia transitiva.

Cuando abres la raíz de un monorepo que contiene `apps/customer`, `apps/driver` y 38 paquetes bajo `packages/`, cada uno con su propio `pubspec.lock` y `.dart_tool/package_config.json`, el servidor no tiene opción: esos paquetes podrían resolver `collection` o `riverpod` a versiones distintas, así que construye 40 contextos y resuelve `package:flutter` 40 veces. El equipo de Dart lo dice exactamente así en la página de workspaces: abrir la raíz sin workspaces "crearía contextos de análisis separados para cada paquete, aumentando el uso de memoria". El issue de seguimiento de larga data para la solución, [dart-lang/sdk#53874](https://github.com/dart-lang/sdk/issues/53874), pone la reducción del número de contextos en el centro del trabajo de rendimiento del servidor.

Los síntomas en VS Code son conocidos: "Analyzing..." girando durante un minuto después de abrir la carpeta, completados que tardan segundos, sugerencias de importación automática que van detrás de lo que escribes y, en máquinas de 16 GB, el servidor terminado a la fuerza y reiniciado.

## Mide antes de cambiar nada

Adivinar sale caro aquí, así que primero consigue dos números.

En VS Code, ejecuta **Dart: Open Analyzer Diagnostics / Insights** desde la paleta de comandos. Abre la página web de diagnóstico del servidor. La página Contexts lista cada contexto de análisis con su ubicación, su raíz de workspace y el conteo de archivos "added" (los tuyos) e "implicit" (los archivos del SDK y de dependencias que ese contexto tuvo que cargar). Si ves un contexto por paquete, cada uno con miles de archivos implícitos, encontraste el problema. La página "Memory and CPU usage" muestra lo que retiene el proceso, y la página "Legacy Plugins" lista los isolates de plugins que haya. **Dart: Capture Analysis Server Timings** registra qué solicitudes son lentas si la queja son los completados y no el arranque.

Para un número repetible que puedas ejecutar en CI o antes y después de un cambio, usa la línea de comandos. `dart analyze` ejecuta el mismo servidor de análisis, y dos flags ocultos (visibles con `dart analyze -h -v`) lo vuelven útil como benchmark:

```bash
# Dart 3.12.2. --cache points at an empty dir so every run is cold.
rm -rf /tmp/dart-cache
/usr/bin/time -l dart analyze --cache=/tmp/dart-cache .
# "maximum resident set size" in the time output is peak memory (macOS, bytes).
# On Linux use: /usr/bin/time -v dart analyze --cache=/tmp/dart-cache .

# Server-reported heap, printed only with JSON output:
dart analyze --cache=/tmp/dart-cache --memory --format=json . | jq .memory
```

El flag `--cache` importa. Sin él, la ejecución reutiliza `~/.dartServer`, y las ejecuciones en caliente ocultan la mayor parte de la diferencia que intentas medir.

## El repo que medí

Para obtener números que no estén atados al código de una empresa concreta, generé un monorepo de 40 paquetes de Dart puro, cada uno con 80 archivos de biblioteca, un archivo barrel y dependencias por path hacia los dos paquetes anteriores, de modo que el grafo de dependencias es una cadena como en una aplicación real por capas (`core` -> `data` -> `features`). Eso da 3 240 archivos. Los paquetes de Flutter se comportan igual para este propósito; solo hacen que cada contexto extra sea más caro, porque `package:flutter` es grande.

Dos variantes: `separate`, donde cada paquete ejecutó su propio `dart pub get`, y `workspace`, el mismo código convertido en un pub workspace. Tres ejecuciones en frío de cada una:

| Variante | Package configs | `dart analyze` en frío | RSS pico |
| --- | --- | --- | --- |
| separate | 40 | 16.5 s / 20.7 s / 22.4 s | 1 225 / 1 291 / 1 067 MB |
| workspace | 1 | 11.1 s / 11.6 s / 11.7 s | 499 / 495 / 490 MB |

Mismos diagnósticos, mismo código, menos de la mitad de la memoria. En el IDE la brecha es peor que en una ejecución puntual por CLI, porque el servidor vive durante toda tu sesión y cada contexto permanece residente.

## Paso a paso: haz que el analizador vuelva a ser rápido

1. Actualiza el SDK más allá de las regresiones conocidas.
2. Convierte el repo en un pub workspace.
3. Excluye el código generado y el código de terceros en `analysis_options.yaml`.
4. Elimina los plugins legacy del analizador.
5. Abre la raíz del workspace en VS Code y recorta lo que ve el IDE.

### 1. Actualiza más allá de las regresiones conocidas

Dart 3.11.0 salió con un problema de rendimiento en workspaces con muchos archivos y muchos directorios, corregido en 3.11.1 ([dart-lang/sdk#62456](https://github.com/dart-lang/sdk/issues/62456)). También hay un reporte abierto, [dart-lang/sdk#62704](https://github.com/dart-lang/sdk/issues/62704), de un workspace de 18 paquetes que pasó de unos 10 s a más de 6 minutos tras actualizar a 3.11.0. Si estás exactamente en 3.11.0, actualiza primero y vuelve a medir. Dart 3.12 también mejoró el arranque con un mejor almacenamiento en caché de los archivos de opciones de análisis, lo que ayuda sobre todo cuando cada paquete tiene su propio `analysis_options.yaml` que hace `include:` de uno compartido.

### 2. Convierte el repo en un pub workspace

Un workspace necesita que cada miembro declare `resolution: workspace` y una cota inferior de SDK de al menos 3.6. El `pubspec.yaml` raíz lista los miembros:

```yaml
# pubspec.yaml at the repo root. Dart 3.6+ (measured on 3.12.2).
name: _
publish_to: none
environment:
  sdk: ^3.12.0
workspace:
  - apps/customer
  - apps/driver
  - packages/core
  - packages/data
  - packages/design_system
```

```yaml
# packages/data/pubspec.yaml
name: data
publish_to: none
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
resolution: workspace
dependencies:
  flutter:
    sdk: flutter
  core:
    path: ../core
```

Luego limpia los artefactos de resolución por paquete y resuelve una sola vez desde la raíz:

```bash
# Remove stale per-package lockfiles and package configs, then resolve the workspace.
find . -name pubspec.lock -not -path './pubspec.lock' -delete
find . -path '*/.dart_tool/package_config.json' -not -path './.dart_tool/*' -delete
flutter pub get   # or: dart pub get
```

Después de esto hay un solo `pubspec.lock` y un solo `.dart_tool/package_config.json`, ambos en la raíz. Reinicia el servidor de análisis (**Dart: Restart Analysis Server**) y revisa de nuevo la página Contexts: deberías ver un único contexto para el workspace.

La contrapartida es que el workspace tiene una única resolución de versiones. Si `apps/driver` fija `intl` a una versión mayor y `apps/customer` necesita otra, `pub get` falla hasta que las alinees. Ese fallo es el trabajo de migración; la mayoría de los repos descubren dos o tres conflictos de este tipo. Si usas Melos, la versión 7.0.0 pasó a pub workspaces y reemplazó `melos.yaml` por una sección `melos:` en el `pubspec.yaml` raíz, así que actualizar Melos y convertir el repo en un workspace son el mismo trabajo.

### 3. Excluye el código generado y el de terceros

El Dart generado suele ser tan grande como el código que escribiste. La salida de `freezed`, `json_serializable`, `mockito`, `drift` e `intl` se ubica junto a tus fuentes como `*.g.dart`, `*.freezed.dart` y `*.mocks.dart`, y el servidor resuelve y analiza con el linter cada línea. (Si la propia generación de código está fallando, consulta [el desajuste de versiones entre source_gen y analyzer que rompe build_runner](/es/2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl/); si estás eligiendo entre modelos generados y los integrados, [Dart records vs clases freezed](/es/2026/05/dart-records-vs-freezed-classes/) es la comparación relevante.)

```yaml
# analysis_options.yaml at the workspace root. Dart 3.12.2.
include: package:flutter_lints/flutter.yaml

analyzer:
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - "**/*.mocks.dart"
    - "**/build/**"
    - "third_party/**"
```

Agregué 10 archivos con estilo de código generado (unas 1 000 líneas) a cada uno de los 40 paquetes y volví a medir en la variante workspace:

| Workspace + código generado | `dart analyze` en frío | RSS pico |
| --- | --- | --- |
| archivos generados analizados | 19.4 s / 14.7 s | 1 148 / 1 185 MB |
| `**/*.g.dart` excluido | 6.9 s / 6.9 s | 523 / 523 MB |

Cuatro detalles sobre `exclude` que la documentación no explicita, todos verificados en 3.12.2:

- **Los globs son relativos al archivo de opciones.** La [documentación de análisis](https://dart.dev/tools/analysis) lo dice explícitamente. `**/*.g.dart` funciona desde cualquier lugar; `lib/**` en el archivo raíz significa el `lib` de la raíz, no el de cada paquete.
- **En un workspace, el exclude del archivo raíz cubre a los miembros que tienen su propio `analysis_options.yaml`.** En mi prueba cada paquete conservó su propio archivo de opciones, y un `exclude` solo en la raíz igual quitó sus archivos generados del análisis. Sin workspace no pasa: cada paquete es su propia raíz de contexto, el archivo raíz se ignora para ellos y necesitas el exclude en cada paquete, o una línea `include: ../../analysis_options.yaml` en el archivo de cada paquete, que sí arrastra el exclude.
- **Excluir un archivo no impide que se resuelva cuando algo lo importa.** Excluí una biblioteca que otros archivos importan y le puse una advertencia. La advertencia desapareció y los importadores siguieron pasando la verificación de tipos. Así que la exclusión ahorra el trabajo de lints y diagnósticos, y lo ahorra todo para archivos que nadie importa (mocks, fixtures de pruebas, salida obsoleta), pero un `part` `*.g.dart` de un modelo que usas se seguirá leyendo.
- **`build/` no se omite por defecto.** Las carpetas cuyo nombre empieza con punto (`.dart_tool`, `.git`) se ignoran, pero un directorio `build/` o `ios/Pods/` que casualmente contenga archivos `.dart` se analiza. Las aplicaciones `example/` anidadas con su propio `pubspec.yaml` que no son miembros del workspace también se convierten en contextos extra. O las agregas al workspace o las excluyes.

### 4. Elimina los plugins legacy del analizador

Los plugins legacy del analizador, del tipo `analyzer: plugins:` que usan `custom_lint` y herramientas más antiguas, se ejecutan en isolates separados asociados a los contextos de análisis. La documentación de Dart advierte que habilitar uno "aumenta la cantidad de memoria que usa el analizador" y recomienda evitarlos por completo si tienes menos de 16 GB de RAM o un monorepo con 10 o más archivos `pubspec.yaml` o `analysis_options.yaml`. Dart 3.13.2 marcó formalmente como obsoleto el sistema legacy.

Búscalos:

```bash
grep -rn --include=analysis_options.yaml -A3 'plugins:' .
```

Si los lints importan, pásate al [nuevo sistema de plugins](https://dart.dev/tools/analyzer-plugins) añadido en Dart 3.10, configurado con una clave `plugins:` de nivel superior y soportado tanto por el IDE como por `dart analyze`. Dart 3.11 hizo que reutilizara un snapshot AOT del punto de entrada del plugin, lo que según el changelog ahorra del orden de 10 segundos al inicio de cada sesión del IDE. Si los lints no importan lo suficiente como para portarlos, borra el plugin y mide la diferencia; suele ser la mayor caída individual después de la conversión a workspace.

### 5. Abre la carpeta correcta y recorta lo que ve el IDE

Con un workspace, abre la raíz del repo en VS Code en lugar de la carpeta de una sola aplicación, para que una sola sesión del servidor cubra a todos los miembros y la navegación entre paquetes, el renombrado y la búsqueda de referencias funcionen en todo el repo.

Vale la pena conocer dos ajustes de Dart-Code, y vale la pena evitar uno:

```jsonc
// .vscode/settings.json (Dart-Code extension)
{
  // Folders the IDE analysis server ignores entirely, including for project detection.
  "dart.analysisExcludedFolders": [
    "tools/legacy_scripts",
    "third_party"
  ],
  // Keep SDK and dependency symbols out of Ctrl+T if workspace symbol search is slow.
  "dart.includeDependenciesInWorkspaceSymbols": false
}
```

`dart.analysisExcludedFolders` solo afecta al editor, así que prefiere `analyzer: exclude:` para todo lo que también deba omitir `dart analyze` en CI. Recurre al ajuste de VS Code cuando una carpeta deba seguir analizándose en CI pero no en local, como una aplicación archivada grande que nadie de tu equipo edita.

Evita `dart.onlyAnalyzeProjectsWithOpenFiles`. Está obsoleto, y su propia descripción advierte que "puede empeorar significativamente el rendimiento al moverse por un proyecto", porque el servidor destruye y reconstruye contextos continuamente a medida que cambias de archivo.

## Cuando sigue siendo lento

Si la página Contexts muestra un solo contexto y el código generado está excluido, el costo restante es código real. Algunas cosas a revisar:

- **Exports barrel circulares o muy amplios.** Un archivo barrel que reexporta un paquete entero hace que cada importador dependa de cada archivo de ese paquete, así que una edición invalida mucho más de lo necesario. Importa desde rutas `src/` dentro de un paquete y deja los barrels para la API pública.
- **Un megapaquete.** Dividir un paquete `app` de 3 000 archivos en features no reduce el trabajo total, pero sí permite que el servidor omita reanalizar las bibliotecas no afectadas tras una edición.
- **Un reinicio del servidor después de operaciones grandes de git.** Cambiar a ramas que tocan cientos de archivos encola mucho trabajo. **Dart: Restart Analysis Server** es más rápido que esperar la invalidación incremental en algunos casos.
- **Instrumentación para un reporte de bug.** Asigna una ruta a `dart.analyzerInstrumentationLogFile`, reproduce el problema y adjunta el archivo a un issue en [dart-lang/sdk](https://github.com/dart-lang/sdk/issues). Las regresiones mencionadas arriba se encontraron así.

Estos son los mismos contextos que recorre `dart fix`, por eso [ejecutar dart fix en todo el repo](/es/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) también se vuelve más rápido tras la conversión a workspace. Y si ejecutas un agente de IA contra el repo mediante [el servidor MCP de Dart y Flutter](/es/2026/05/dart-flutter-mcp-server-claude-code-cursor/), ese agente también está hablando con un servidor de análisis, así que una disposición de contextos más ligera ayuda ahí tanto como en tu editor.

## Fuentes

- [Pub workspaces (monorepo support)](https://dart.dev/tools/pub/workspaces), dart.dev
- [Customizing static analysis](https://dart.dev/tools/analysis), dart.dev
- [Analyzer plugins](https://dart.dev/tools/analyzer-plugins), dart.dev
- [Dart SDK CHANGELOG](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md), entradas de 3.10.0, 3.11.0, 3.11.1, 3.12.0 y 3.13.2
- [Referencia de ajustes de Dart-Code](https://dartcode.org/docs/settings/)
- [dart-lang/sdk#53874: reduce the number of analysis contexts](https://github.com/dart-lang/sdk/issues/53874)
- [Changelog de Melos, 7.0.0](https://pub.dev/packages/melos/changelog)

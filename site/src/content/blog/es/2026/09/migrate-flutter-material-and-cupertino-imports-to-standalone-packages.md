---
title: "Migra las importaciones de Material y Cupertino de Flutter a los paquetes material_ui y cupertino_ui"
description: "La migración completa desde package:flutter/material.dart y package:flutter/cupertino.dart hacia material_ui 1.1.1 y cupertino_ui 1.0.2: qué reescribe dart fix --code=migrate_design_widgets, por qué los widgets de terceros empiezan a lanzar errores de búsqueda de ancestros, qué arregla realmente MaterialUiCompatibilityBridge y cómo cambia la dependencia de flutter_localizations."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material-design"
  - "cupertino"
lang: "es"
translationOf: "2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages"
translatedBy: "claude"
translationDate: 2026-09-03
---

Para una aplicación cuya única superficie Material es su propio código, esta es una migración de un comando y una tarde: `flutter pub add material_ui`, luego `dart fix --apply --code=migrate_design_widgets`, y después ejecuta las pruebas. Las APIs de los widgets son una copia idéntica de lo que había en el SDK, así que nada se renderiza distinto y ningún golden debería moverse. Lo que realmente cuesta tiempo es el grafo de dependencias. Cada paquete que todavía importa `package:flutter/material.dart` arrastra a tu programa una segunda copia, incompatible a nivel de tipos, de `Theme`, `Material` y `MaterialLocalizations`, y sus widgets fallarán al buscar ancestros dentro de tu árbol migrado hasta que envuelvas la aplicación en `MaterialUiCompatibilityBridge`. Esta guía apunta al canal stable actual, Flutter 3.47.2 con Dart 3.13.2, más [`material_ui`](https://pub.dev/packages/material_ui) 1.1.1 y [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.0.2.

Aquí el reloj importa. Las bibliotecas dentro del SDK ya están congeladas, y la deprecación formal está programada para la versión stable de noviembre de 2026.

## Por qué esto no es una limpieza opcional

- **Las copias dentro del SDK no reciben correcciones.** Flutter cerró los directorios de Material y Cupertino en `flutter/flutter` a toda contribución el 2026-04-07. Desde entonces, cada corrección de errores ha caído en `flutter/packages`. `material_ui` 1.1.1 ya trae correcciones que la copia del SDK nunca tendrá, incluida la condición de carrera de `SearchAnchor` en la que un conjunto de sugerencias asíncronas obsoleto reemplazaba a uno más nuevo, y las etiquetas del indicador de valor de `Slider` que se recortaban en lugar de terminar en puntos suspensivos al borde de la pantalla.
- **Las actualizaciones de diseño dejan de esperar al tren del SDK.** Material y Cupertino solían publicarse con la cadencia trimestral de Flutter, así que un ajuste de tokens o un nuevo argumento de `MenuAnchor` esperaba al siguiente corte stable. Fijar `material_ui: ^1.1.1` desacopla eso: 1.1.0 y 1.1.1 aparecieron ambas entre la stable 3.47 y hoy.
- **Por fin puedes descartar un sistema de diseño que nunca usaste.** Una vez que se eliminen las copias del SDK, una aplicación solo con Cupertino deja de cargar el theming, la tipografía y los metadatos de iconos de Material a través del tree-shaking, y viceversa.
- **Las localizaciones se mudan con los widgets.** Las cadenas traducidas y los delegados de Material y Cupertino ahora viven dentro de los paquetes, y por eso `flutter_localizations` deja de ser algo que tengas que declarar.
- **Si publicas un paquete, eres un bloqueo.** Un solo paquete hoja sin migrar obliga al puente de compatibilidad a todos los que están más abajo.

## Qué se rompe

| Área | Cambio | Severidad |
| ---- | ------ | --------- |
| Importaciones | `package:flutter/material.dart` pasa a `package:material_ui/material_ui.dart`; `package:flutter/cupertino.dart` pasa a `package:cupertino_ui/cupertino_ui.dart` | alta, totalmente automatizable |
| Identidad de tipos | El `Material` del SDK y el `Material` de `material_ui` son tipos distintos en runtime, así que las búsquedas de ancestros no cruzan la frontera | alta, requiere el puente |
| Delegados de localización | `GlobalMaterialLocalizations` y `GlobalCupertinoLocalizations` vienen de los paquetes, no de `flutter_localizations` | media |
| `pubspec.yaml` | Dos dependencias directas nuevas; `flutter_localizations` ya no es una dependencia directa que necesites | media |
| Código generado | Todo lo que emita `package:flutter/material.dart` en un archivo `.g.dart` o `.freezed.dart` necesita regenerarse después de la pasada sobre el código fuente | media |
| Paquetes publicados | Migrar tu propio paquete es un cambio incompatible para quienes lo consumen, así que necesita un incremento de versión mayor | media |
| APIs de widgets | Ninguna. Constructores, parámetros y renderizado quedan igual | ninguna |

Esa última fila es la razón entera de que esta migración sea manejable. `material_ui` 1.0.0 es una copia de la biblioteca incluida en el SDK tal como estaba en el congelamiento de abril de 2026, no un rediseño.

## Lista de comprobación previa

- Flutter 3.44 o posterior. `material_ui` subió su mínimo a Flutter 3.44 / Dart 3.12 cuando el código salió de `flutter/flutter`, y 3.47.2 es la stable actual. Compruébalo con `flutter --version`.
- Un `flutter analyze` limpio antes de empezar. Quieres que la ejecución posterior a la migración sea comparable.
- Una rama. `dart fix --apply` reescribe cada archivo coincidente en una sola pasada y no hay bandera para deshacerlo.
- Un inventario de las dependencias que renderizan widgets de Material o Cupertino. `flutter pub deps --style=compact` junto con `flutter pub outdated` te da la lista; cualquier cosa publicada por última vez antes de agosto de 2026 no ha migrado.
- Si tienes pruebas golden, ejecútalas primero y confirma la línea base. No deberían cambiar, y eso es precisamente lo que se afirma.

## Pasos de la migración

1. **Agrega los paquetes antes de tocar una sola importación.** La regla de `dart fix` reescribe cadenas de importación; no edita `pubspec.yaml`. Hazlo en el orden equivocado y terminarás con un archivo lleno de importaciones sin resolver.

   ```sh
   # Flutter 3.47.2, Dart 3.13.2
   flutter pub add material_ui
   flutter pub add cupertino_ui
   ```

   Eso hoy resuelve a `material_ui: ^1.1.1` y `cupertino_ui: ^1.0.2`. Si tu aplicación es solo Material, igual obtienes `cupertino_ui` de forma transitiva, porque `material_ui` depende de `cupertino_ui: ^1.0.0` desde su versión 1.0.1, pero decláralo explícitamente si lo importas directamente. Verifica con `flutter pub deps --style=compact | grep -E 'material_ui|cupertino_ui'` y confirma que ambos se resuelven.

2. **Reescribe las importaciones con la corrección incluida.** Ambos paquetes registran la misma corrección del analizador, así que un comando cubre Material y Cupertino a la vez.

   ```sh
   dart fix --dry-run --code=migrate_design_widgets   # review first
   dart fix --apply  --code=migrate_design_widgets
   ```

   El resultado es un diff de una línea por archivo:

   ```dart
   // Before: Flutter 3.43 and earlier
   import 'package:flutter/material.dart';

   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';
   ```

   Nada por debajo de la línea de importación cambia. `MaterialApp`, `Scaffold`, `ThemeData`, `Colors`, `showDialog` y cualquier otro nombre se exportan bajo el mismo identificador. Verifica con `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" lib test` sin resultados, y luego `flutter analyze`.

3. **Apunta los delegados de localización a los paquetes.** Los delegados y las cadenas traducidas se mudaron a `material_ui` y `cupertino_ui`, y los paquetes exponen un getter agregado que te ahorra listar tres delegados a mano.

   ```dart
   // Before: flutter_localizations, Flutter 3.43
   import 'package:flutter_localizations/flutter_localizations.dart';

   localizationsDelegates: const <LocalizationsDelegate<Object>>[
     GlobalMaterialLocalizations.delegate,
     GlobalCupertinoLocalizations.delegate,
     GlobalWidgetsLocalizations.delegate,
   ],
   ```

   ```dart
   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';

   localizationsDelegates: GlobalMaterialLocalizations.delegates,
   ```

   `GlobalMaterialLocalizations.delegates` ya incluye los delegados de Cupertino y de Widgets. Si además usas `gen-l10n`, tu `AppLocalizations.delegate` generado no se ve afectado y se agrega a esa lista como antes. Ahora puedes quitar `flutter_localizations` de tus propias `dependencies`, aunque seguirá en `pubspec.lock`: `cupertino_ui` 1.0.2 todavía depende de él, junto con `collection: ^1.19.1` e `intl: ^0.20.2`. Verifica arrancando con una configuración regional distinta del inglés y comprobando una cadena integrada, por ejemplo mantén pulsado un `TextField` y confirma que la opción de pegar está traducida.

4. **Pon un puente para las dependencias que no han migrado.** Este es el paso que la gente se salta y luego depura durante una hora. Envuelve a nivel de aplicación con `MaterialApp.builder`:

   ```dart
   // material_ui 1.1.1
   MaterialApp(
     theme: ThemeData(useMaterial3: true),
     builder: (BuildContext context, Widget? child) {
       return MaterialUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   El lado de Cupertino es simétrico:

   ```dart
   // cupertino_ui 1.0.2
   CupertinoApp(
     builder: (BuildContext context, Widget? child) {
       return CupertinoUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   También puedes envolver un subárbol más reducido si solo una pantalla incrusta widgets heredados, lo que mantiene los widgets heredados adicionales fuera del resto del árbol. Verifica navegando a cada pantalla que aloje un widget de terceros. El puente es un andamio temporal: elimínalo en cuanto `flutter pub outdated` no muestre nada que siga con las importaciones antiguas.

5. **Regenera todo lo que haya escrito un generador de código.** `dart fix` ve tu código fuente, no las plantillas que lo produjeron. Vuelve a ejecutar el generador después del paso 2 para que los archivos emitidos dejen de importar la biblioteca del SDK:

   ```sh
   dart run build_runner build --delete-conflicting-outputs
   ```

   Luego revisa los restos que `dart fix` no puede alcanzar: los `export` barrel que reexportan Material para quienes te consumen, las importaciones condicionales que eligen una implementación de Material por plataforma, y cualquier plantilla propia de generador con la ruta de importación escrita a mano como cadena. Verifica con el mismo `grep` del paso 2, ampliado a todo el repositorio en lugar de solo `lib` y `test`.

6. **Si publicas un paquete, incrementa la versión mayor.** Cambiar un paquete publicado a `material_ui` altera lo que quienes lo consumen deben tener en su propio `pubspec.yaml`. Publicar eso como una versión menor rompe aplicaciones en silencio: su árbol de widgets acaba mezclando orígenes sin ningún error de compilación que lo señale. Sube a la siguiente versión mayor, anota en el changelog la restricción de `material_ui` requerida, y mantén la versión mayor anterior en una rama de mantenimiento si das soporte a versiones antiguas de Flutter. Verifica con `dart pub publish --dry-run`.

## Verificación

- `flutter analyze` informa el mismo número que tu línea base previa a la migración, sin `uri_does_not_exist` y sin `deprecated_member_use` en una línea de importación.
- `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" .` no encuentra nada fuera de `.dart_tool` y `pubspec.lock`.
- `flutter test` pasa, incluidas las pruebas golden y sin cambios en ellas. Un golden que se mueve significa que hay dos copias de la biblioteca renderizando en el mismo árbol, no que Material haya cambiado.
- La aplicación corre en un dispositivo y cada pantalla que incrusta un widget de terceros se renderiza con tu tema, no con valores por defecto.
- Una configuración regional distinta del inglés sigue mostrando cadenas integradas traducidas después del paso 3.
- `flutter build apk --release --analyze-size` (o el equivalente de iOS) como línea base de tamaño para más adelante, una vez que se eliminen las copias del SDK y el tree-shaking pueda descartar de verdad el sistema de diseño que no usas.

## Plan de reversión

Totalmente reversible hoy. Los cambios son un diff de `pubspec.yaml`, una línea de importación por archivo, una lista de delegados y un widget puente opcional, así que un `git revert` del commit de migración te devuelve a las bibliotecas del SDK sin datos ni artefactos de compilación que deshacer. Dos advertencias: no existe un `dart fix` inverso, así que una reversión manual implica editar cada importación de vuelta a mano, y por eso el paso cero es una rama. Y después de la stable de noviembre de 2026, revertir te deja sobre APIs formalmente deprecadas que serán eliminadas, así que trata la reversión como una forma de desbloquear un lanzamiento, no como una decisión.

## Detalles que muerden

**"Could not find an ancestor of type MaterialLocalizations" en código que no escribiste.** Es el problema de identidad de tipos apareciendo en runtime. Un widget compilado contra la biblioteca del SDK llama a `MaterialLocalizations.of(context)`, que recorre el árbol buscando el inherited widget de *su* tipo `MaterialLocalizations`. Tu `MaterialApp` de `material_ui` insertó un tipo distinto con el mismo nombre, la búsqueda falla y salta el assert. `Theme.of(context)` falla de la misma manera, con "Could not find an ancestor of type Theme". El puente del paso 4 existe precisamente para insertar los inherited widgets heredados junto a los nuevos, de modo que ambas búsquedas se resuelvan. No es un parche para un `Scaffold` ausente: si el error viene de tu propio código migrado, tienes el problema ordinario descrito en [no Material widget found en Flutter](/es/2026/08/fix-no-material-widget-found-in-flutter/), y el puente no ayudará.

**Importación sin resolver justo después de ejecutar la corrección.** Ejecutaste `dart fix` antes de `flutter pub add`. Agrega el paquete y vuelve a ejecutar `dart fix --apply --code=migrate_design_widgets`; la regla es idempotente.

**No dejes ambas importaciones en un mismo archivo.** `package:flutter/material.dart` y `package:material_ui/material_ui.dart` exportan los mismos identificadores, así que cualquier archivo con las dos recibe errores de importación ambigua en `Material`, `Theme`, `Colors` y compañía. Poner un prefijo a una de ellas compila, pero te deja dos sistemas de diseño en un archivo, que es peor que el error. Elige uno por archivo.

**La fecha del congelamiento y la de la deprecación no son la misma.** El [anuncio del congelamiento de código](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze) decía que las bibliotecas del SDK quedarían deprecadas en la versión stable *posterior* a 3.44. Eso se corrió: 3.47 se publicó el 2026-08-12 sin la deprecación, y [las notas de la versión 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47) ahora sitúan la deprecación formal en la stable de noviembre. Congeladas desde abril, deprecadas en noviembre, eliminadas más tarde. Planifica contra noviembre, no contra lo que tu analizador calle hoy.

**Los manifiestos de assets pueden moverse aunque los widgets no.** `material_ui` 1.1.0 expuso el asset del shader `ink_sparkle` a través de su propio `pubspec.yaml` y descartó el shader `stretch_effect`. Si haces afirmaciones sobre el manifiesto de assets o eliminas assets sin usar en un paso de compilación, ese es un diff real que revisar.

**Migra las importaciones y las versiones de Flutter en commits separados.** Si saltas de versión del SDK en la misma pasada, cualquier regresión visual tendrá dos causas candidatas. Aterriza primero la actualización del SDK, confirma que la aplicación está limpia y luego migra las importaciones.

## Relacionado

- El anuncio del que esta migración es continuación, incluido el valor por defecto de SwiftPM que llegó en la misma versión, está en [Flutter 3.44 saca Material y Cupertino del SDK](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Estructuralmente esta es la misma forma de pasada amplia y mecánica que [migrar una aplicación web de Flutter de dart:html a package:web](/es/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), incluida la parte en la que `dart fix` se encarga del 95 % fácil y el grafo de dependencias se encarga de ti.
- Para una deprecación que `dart fix` explícitamente no puede automatizar, compara [reemplazar Radio.groupValue y onChanged por RadioGroup](/es/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- Si además vas a pasar a la stable actual en este ciclo, lee [qué cambió Flutter 3.47 en el renderizado de escritorio](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) antes de atribuir una regresión visual al cambio de paquetes.
- Los fallos de búsqueda de ancestros son una familia, no un caso aislado. [ScaffoldMessenger.of(context) does not contain a Scaffold](/es/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) es el mismo método de depuración aplicado a otro inherited widget.

## Fuentes

- [material_ui en pub.dev](https://pub.dev/packages/material_ui), versión 1.1.1, y su [changelog](https://pub.dev/packages/material_ui/changelog)
- [cupertino_ui en pub.dev](https://pub.dev/packages/cupertino_ui), versión 1.0.2
- [Flutter's Material and Cupertino code freeze](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze), el blog de Flutter
- [What's new in Flutter 3.44](https://flutter.dev/blog/whats-new-in-flutter-3-44), el blog de Flutter
- [What's new in Flutter 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47), el blog de Flutter
- [Issue de seguimiento del desacople del sistema de diseño](https://github.com/flutter/flutter/issues/172932), flutter/flutter
- [Notas de la versión Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0), docs.flutter.dev

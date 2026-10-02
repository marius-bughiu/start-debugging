---
title: "Solución: Undefined name 'awaitNotRequired' en material_ui o cupertino_ui con Flutter 3.44"
description: "material_ui 1.3.0 y cupertino_ui 1.1.0 usan una anotación que Flutter 3.44 no exporta. Ambas versiones están retiradas, pero un lockfile las conserva. Haz downgrade y luego upgrade para llegar a 1.2.0 y 1.0.2."
pubDate: 2026-10-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-44"
  - "dart"
  - "pub"
lang: "es"
translationOf: "2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44"
translatedBy: "claude"
translationDate: 2026-10-02
---

Tu `pubspec.lock` fija `material_ui` 1.3.0 y/o `cupertino_ui` 1.1.0, dos versiones que usan `@awaitNotRequired`, algo que `package:flutter/foundation.dart` solo exporta desde Flutter 3.47.0. Ambas versiones están ahora retiradas en pub.dev, pero pub conserva una versión retirada que ya tienes bloqueada, y en Flutter 3.44 ni siquiera `flutter pub upgrade` te saca de ella. Ejecuta `flutter pub downgrade material_ui cupertino_ui` seguido de `flutter pub upgrade` (terminas en `material_ui` 1.2.0 y `cupertino_ui` 1.0.2), o actualiza Flutter a 3.47. Todo lo que sigue se midió en Flutter 3.44.8 (Dart 3.12.2) y Flutter 3.47.6 (Dart 3.13.5) el 2026-10-02.

## El error en contexto

El analizador no dice nada, `flutter pub get` termina bien, y luego la primera compilación real falla dentro del caché de pub. Esto es `flutter build web` en 3.44.8; cualquier otro destino ejecuta el mismo frontend de Dart sobre las mismas fuentes, así que `flutter run` falla en las mismas líneas:

```text
Target dart2js failed: ProcessException: Process exited abnormally with exit code 1:
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/bottom_sheet.dart:1304:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/carousel.dart:1982:4:
Error: Not a constant expression.
  @awaitNotRequired
   ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/dialog.dart:1672:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
...
/Users/marius/.pub-cache/hosted/pub.dev/cupertino_ui-1.1.0/lib/src/route.dart:1347:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
```

`material_ui` 1.3.0 produce ocho de estos errores (`showModalBottomSheet`, `CarouselController.animateToItem`, `showDatePicker`, `showDateRangePicker`, `showDialog`, `showAdaptiveDialog`, `showMenu`, `showTimePicker`) y `cupertino_ui` 1.1.0 añade dos más (`showCupertinoModalPopup`, `showCupertinoDialog`). La variante `Not a constant expression` es el mismo error: la anotación sobre un método de instancia se reporta de otra forma en el frontend. Ten en cuenta que `flutter analyze` en tu proyecto no reporta nada, porque el analizador no muestra errores dentro de las dependencias. Solo lo hace un paso de compilación.

No necesitas depender de `material_ui` directamente para caer en esto. `shimmer` 4.0.0, por ejemplo, depende de `material_ui: ^1.0.1`, así que ejecutar `flutter pub add shimmer` en Flutter 3.44 entre el 2026-09-15 y la retirada incorporó 1.3.0 de forma transitiva. Así fue exactamente como lo encontró quien reportó [flutter/flutter#192839](https://github.com/flutter/flutter/issues/192839).

## Por qué Flutter 3.44 no ve una anotación que existe en su propio paquete meta

`awaitNotRequired` no es nueva. Vive en `package:meta` desde la versión 1.17.0, y Flutter 3.44.8 fija `meta` 1.18.0, que ya la contiene. La constante está ahí mismo, en tu caché de pub. Lo que le falta a 3.44 es la reexportación.

`material_ui` y `cupertino_ui` nunca importan `package:meta`. Sus archivos de biblioteca importan `package:flutter/foundation.dart` y dependen de lo que este reexporta de `meta`. En Flutter 3.44 esa lista es cerrada:

```dart
// packages/flutter/lib/foundation.dart, Flutter 3.44.8
export 'package:meta/meta.dart'
    show
        factory,
        immutable,
        internal,
        // ignore: experimental_member_use
        mustBeConst,
        mustCallSuper,
        nonVirtual,
        optionalTypeArgs,
        protected,
        required,
        visibleForOverriding,
        visibleForTesting;
```

[flutter/flutter#181513](https://github.com/flutter/flutter/pull/181513) ("Add @awaitNotRequired annotation to flutter sdk") añadió `awaitNotRequired` a esa lista `show` el 2026-04-25. No llegó a la rama 3.44 y se publicó en Flutter 3.47.0 el 2026-08-12. En cualquier versión 3.44.x (de 3.44.0 a 3.44.9), el identificador simplemente no está en el ámbito para el código que solo importa `foundation.dart`.

Mientras tanto, los paquetes se desarrollan contra el canal main de Flutter. [flutter/packages#12622](https://github.com/flutter/packages/pull/12622) y [#12817](https://github.com/flutter/packages/pull/12817) añadieron las anotaciones, y `material_ui` 1.3.0 y `cupertino_ui` 1.1.0 salieron el 2026-09-15 con las anotaciones pero con el mismo `environment` que tenían antes:

```yaml
# material_ui 1.3.0 pubspec.yaml
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
```

Pub confía en esa restricción, así que en Flutter 3.44 eligió 1.3.0 como la versión compatible más reciente. La corrección upstream fue doble: `material_ui` 1.4.0 y `cupertino_ui` 1.1.1 (ambas del 2026-09-21/22) subieron el mínimo a `flutter: ">=3.47.0"` y `sdk: ^3.13.0`, y se retiraron 1.3.0 y 1.1.0. El issue se cerró el 2026-09-21.

## Reproducción mínima

Las versiones retiradas aún se pueden forzar con un pin en `dependency_overrides`, que es la forma más fácil de reproducir el fallo de compilación a propósito:

```yaml
# pubspec.yaml, Flutter 3.44.8 / Dart 3.12.2
name: repro
publish_to: 'none'
environment:
  sdk: ^3.12.0
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
dependency_overrides:
  material_ui: 1.3.0
  cupertino_ui: 1.1.0
```

```dart
// lib/main.dart, Flutter 3.44.8, material_ui 1.3.0
import 'package:material_ui/material_ui.dart';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('hi')))),
);
```

`flutter pub get` termina bien, `flutter analyze` no reporta errores, y `flutter build web` falla con la salida de arriba. Sin el override, `flutter pub add material_ui:1.3.0` ahora se niega de plano con `Because repro depends on material_ui 1.3.0 which doesn't match any versions, version solving failed.`, ya que el solver oculta las versiones retiradas a menos que estén fijadas o ya bloqueadas.

## Por qué la retirada no arregló tu proyecto

Si ejecutaste `pub get` mientras 1.3.0 estaba disponible, tu `pubspec.lock` dice `version: "1.3.0"`, y una retirada no toca los lockfiles. La [documentación de pub](https://dart.dev/tools/pub/publishing#retract) es explícita en que una versión retirada ya bloqueada sigue funcionando. `flutter pub outdated` es la forma más rápida de confirmar que estás en este estado:

```text
Package Name              Current             Upgradable          Resolvable          Latest

direct dependencies:
material_ui               *1.3.0 (retracted)  *1.3.0 (retracted)  *1.3.0 (retracted)  1.5.0

transitive dependencies:
cupertino_ui              *1.1.0 (retracted)  *1.1.0 (retracted)  *1.1.0 (retracted)  1.1.1
...
material_ui
    Version 1.3.0 is retracted. See https://dart.dev/go/package-retraction
cupertino_ui
    Version 1.1.0 is retracted. See https://dart.dev/go/package-retraction
```

Fíjate en las columnas Upgradable y Resolvable: el propio pub dice que no te va a mover. La misma documentación de pub recomienda `dart pub upgrade <package>` para salir de una versión retirada, y en Flutter 3.44 eso no hace nada:

```text
$ flutter pub upgrade material_ui cupertino_ui
  cupertino_ui 1.1.0 (retracted, 1.1.1 available)
  material_ui 1.3.0 (retracted, 1.5.0 available)
No dependencies changed.
```

La razón está en el solver. En `lib/src/solver/version_solver.dart`, `_getAllowedRetracted` devuelve `_lockFile.packages[package]?.version` sin importar si el paquete se desbloqueó para la actualización. Así que durante `upgrade`, la versión retirada bloqueada sigue siendo un candidato válido. Todas las versiones más nuevas (1.4.0, 1.5.0, 1.1.1) requieren Flutter 3.47, por lo que la versión más alta que el solver puede elegir en 3.44 es la retirada que ya tienes. El consejo de la documentación solo funciona cuando existe una versión *compatible* más nueva, y en 3.44 no existe ninguna.

## Solución 1: quedarte en Flutter 3.44 y retroceder a material_ui 1.2.0

Quieres que el lockfile deje de mencionar 1.3.0 y 1.1.0. La forma más limpia es hacer downgrade y luego upgrade, para que la versión retirada salga del lock antes de que corra el upgrade:

```bash
# Flutter 3.44.8: escape the retracted versions
flutter pub downgrade material_ui cupertino_ui
flutter pub upgrade
```

El primer comando mueve ambos paquetes a las versiones más bajas que permiten tus restricciones (`material_ui` 1.0.0 y `cupertino_ui` 0.0.2 con `^1.0.0`), lo que también elimina las entradas retiradas de `pubspec.lock`. El segundo vuelve a subir a las versiones más nuevas no retiradas que 3.44 acepta:

```text
> cupertino_ui 1.0.2 (was 0.0.2) (1.1.1 available)
> material_ui 1.2.0 (was 1.0.0) (1.5.0 available)
```

Después de eso, `flutter build web` en 3.44.8 funciona. Borrar a mano las entradas de `material_ui` y `cupertino_ui` de `pubspec.lock` y ejecutar `flutter pub get` da el mismo resultado (1.2.0 y 1.0.2), y también borrar el lockfile completo, aunque eso además vuelve a resolver todo lo demás de tu grafo. No te saltes `cupertino_ui`: suele ser una dependencia transitiva, y nombrar solo `material_ui` deja 1.1.0 bloqueada y todavía rota.

Haz commit del nuevo `pubspec.lock`. Si tu CI ejecuta `flutter pub get --enforce-lockfile`, instala exactamente lo que dice el lockfile del commit, así que la compilación seguirá fallando allí hasta que llegue el nuevo lockfile.

## Solución 2: pasar a Flutter 3.47, que es lo que los paquetes esperan ahora

`material_ui` 1.4.0 y posteriores requieren Flutter 3.47, y las nuevas correcciones llegan solo allí. Si puedes actualizar, esta es la respuesta a largo plazo:

```bash
# Flutter 3.47.6 / Dart 3.13.5
flutter upgrade
flutter pub upgrade
```

En 3.47.6 la actualización funciona como describe la documentación de pub, porque ahora existen versiones compatibles más nuevas:

```text
> cupertino_ui 1.1.1 (was 1.1.0)
> material_ui 1.5.0 (was 1.3.0)
```

Estrictamente hablando, ni siquiera necesitas actualizar los paquetes: la 1.3.0 retirada compila sin problemas en Flutter 3.47.6, porque `foundation.dart` ahora reexporta la anotación. Aun así recomiendo ejecutar `flutter pub upgrade` para que el lockfile deje de apuntar a una versión retirada, algo que `flutter pub outdated` seguiría señalando.


Pasar a 3.47 es un cambio más grande que subir la versión de los paquetes. Trae Dart 3.13 (que, entre otras cosas, [rechaza `final` en parámetros ordinarios](/es/2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters/)) y convierte a Impeller en el renderizador predeterminado en escritorio, así que trátalo como una actualización planificada y no como un arreglo urgente.

## Solución 3: mantener una restricción en pubspec.yaml para que no vuelva a pasar en 3.44

Si te vas a quedar en 3.44 por un tiempo, limita los paquetes de forma explícita. Eso documenta la decisión y evita que el `pub upgrade` de un compañero se desvíe si sale otra versión con un `environment` incorrecto:

```yaml
# pubspec.yaml, Flutter 3.44.x
dependencies:
  material_ui: ">=1.0.0 <1.3.0"
  cupertino_ui: ">=1.0.0 <1.1.0"
```

Añade `cupertino_ui` aunque no lo importes. Cuando limité solo `material_ui` y ejecuté `flutter pub get` contra el lockfile roto, pub movió `material_ui` a 1.2.0 pero dejó el `cupertino_ui` transitivo en la 1.1.0 retirada, porque nada lo obligaba a cambiar. Con ambos límites puestos, el mismo `flutter pub get` los movió a 1.2.0 y 1.0.2.

## Cosas que parecen soluciones pero no lo son

- **Subir la versión de `meta`.** `meta` 1.18.0 ya declara `awaitNotRequired`, y el framework de Flutter 3.44 fija `meta` exactamente en 1.18.0 en su propio `pubspec.yaml`, así que de todos modos no podrías subirla. El problema es la lista `show` de `foundation.dart`, no la versión de `meta`.
- **Declarar tu propia `awaitNotRequired`.** La resolución de nombres ocurre dentro de las bibliotecas de `material_ui`. Una constante de nivel superior en tu aplicación no está en su ámbito.
- **`flutter clean` o borrar el caché de pub.** La versión defectuosa la selecciona tu lockfile, no una salida de compilación obsoleta, así que se descarga de nuevo en el siguiente `pub get`.
- **Fijar `material_ui: 1.3.0` en `dependencies`.** Una versión retirada no se puede seleccionar así en absoluto. Solo `dependency_overrides` puede forzarla, y eso solo reproduce el error.

Si te encuentras con `Undefined name` para otro identificador de Flutter después de migrar a los paquetes independientes, la causa suele ser el mismo patrón en otra dirección: código compilado contra un framework más nuevo que el instalado. `flutter --version` y el bloque `environment` del paquete que aparece en la ruta del error te dirán rápido qué lado va por delante.

## Relacionado

- El contexto sobre por qué Material y Cupertino salieron del SDK está en [Flutter 3.44 separa Material y Cupertino en paquetes](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Para la migración completa de imports, incluidos `dart fix --code=migrate_design_widgets` y los puentes de compatibilidad, consulta [migrar a los paquetes material_ui y cupertino_ui](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Otro desajuste de tipos entre los dos mundos de Material se trata en [el error de TextTheme de google_fonts con material_ui](/es/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).
- Cuando pub se niega a resolver en lugar de resolver a algo roto, empieza por [solucionar "version solving failed" en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Antes de pasar a 3.47, lee sobre [Impeller como renderizador predeterminado en escritorio en Flutter 3.47](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).

## Fuentes

- [flutter/flutter#192839: material_ui 1.3.0 & cupertino_ui 1.1.0 on Flutter 3.44 Error: Undefined name 'awaitNotRequired'](https://github.com/flutter/flutter/issues/192839)
- [flutter/flutter#181513: Add @awaitNotRequired annotation to flutter sdk](https://github.com/flutter/flutter/pull/181513)
- [flutter/packages#12622: Add awaitNotRequired annotation to material_ui](https://github.com/flutter/packages/pull/12622) y el revert sin fusionar [#12942](https://github.com/flutter/packages/pull/12942)
- [changelog de material_ui](https://pub.dev/packages/material_ui/changelog) y [changelog de cupertino_ui](https://pub.dev/packages/cupertino_ui/changelog)
- [Retract a package version](https://dart.dev/tools/pub/publishing#retract), documentación de Dart
- [`version_solver.dart` en dart-lang/pub](https://github.com/dart-lang/pub/blob/master/lib/src/solver/version_solver.dart)
- [Documentación de la API de `awaitNotRequired` en package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html)

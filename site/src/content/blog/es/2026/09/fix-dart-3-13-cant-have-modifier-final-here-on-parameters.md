---
title: "Solución: Can't have modifier 'final' here en parámetros tras actualizar a Dart 3.13"
description: "Dart 3.13 reserva final y var en las listas de parámetros para los constructores primarios. Ejecuta dart fix --apply --code=extraneous_modifier para quitarlos y usa parameter_assignments en su lugar."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
  - "dart-3-13"
lang: "es"
translationOf: "2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters"
translatedBy: "claude"
translationDate: 2026-09-30
---

Dart 3.13 (el SDK de Flutter 3.47) ya no permite escribir `final` ni `var` en los parámetros de funciones normales, métodos, closures y constructores con cuerpo. Ambas palabras clave quedan reservadas para declarar parámetros en constructores primarios, así que `int add(int a, final int b)` falla con `extraneous_modifier` en cuanto tu `pubspec.yaml` dice `sdk: ^3.13.0`. Ejecuta `dart fix --apply --code=extraneous_modifier` para eliminar todos los modificadores problemáticos de una sola vez. Si usabas `final` para impedir que se reasignaran los parámetros, activa en su lugar el lint `parameter_assignments`.

Todo lo que sigue se reprodujo en Dart 3.13.3 (Flutter 3.47.4) y Dart 3.12.2 (Flutter 3.44.8) sobre macOS arm64, y se contrastó con el changelog de 3.13.0, la especificación aceptada de los constructores primarios y el triage de [dart-lang/sdk#64151](https://github.com/dart-lang/sdk/issues/64151), donde el equipo de Dart confirmó que la restricción es intencional.

## El error en contexto

`dart analyze` y el IDE lo reportan como un error del analizador:

```text
error - lib/a.dart:2:16 - Can't have modifier 'final' here. Try removing 'final'. - extraneous_modifier
```

`dart run`, `flutter run` y `flutter build` pasan en cambio por el compilador front-end, que imprime el mismo texto con un acento circunflejo bajo la palabra clave:

```text
lib/a.dart:2:16: Error: Can't have modifier 'final' here.
Try removing 'final'.
int add(int a, final int b) => a + b;
               ^^^^^
```

Con `var` el mensaje cambia la palabra clave: `Can't have modifier 'var' here. Try removing 'var'.` Un parámetro `var int n` con tipo además reporta `var_and_type`, pero ese ya era un error antes de 3.13.

Lo desconcertante es el detonante. Nadie tocó el archivo. Lo que cambió es la restricción del SDK: alguien subió `environment: sdk:` a `^3.13.0` para probar los constructores primarios, o una plantilla generó un paquete nuevo con el límite inferior 3.13, y código que compilaba desde hace años empezó a fallar. Un fallo típico de CI se parece al de #64151: un método auxiliar privado escrito meses antes con `final int precision` en su lista de parámetros, en una clase que no tiene ningún constructor primario.

## Por qué Dart 3.13 rechaza final en los parámetros

Dart 3.13.0 incluyó los [constructores primarios](https://dart.dev/language/primary-constructors) el 2026-08-12. Un constructor primario vive en el encabezado de la clase, y un parámetro marcado con `final` o `var` ahí es un *parámetro declarante*: declara un campo de instancia además de un parámetro del constructor.

```dart
// Dart 3.13.3
class Point(final int x, final int y); // declares fields x and y
```

Para que ese significado sea inequívoco, la [especificación de la característica](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md) prohíbe `var x`, `final x` y `final T x` como declaraciones de parámetros formales en cualquier función que no sea un constructor primario. El equipo de Dart eligió la consistencia en lugar de una regla más acotada: en #64151 Leaf Petersen respondió con un sí rotundo a la pregunta "¿se pretendía que fuera más acotado?", es intencional.

Dos detalles hacen que parezca una regresión y no un cambio del lenguaje:

1. **Depende de la versión del lenguaje.** La restricción solo se aplica a las bibliotecas cuya versión del lenguaje es 3.13 o posterior. La versión del lenguaje sale del límite inferior de `sdk:` en `pubspec.yaml`, de modo que el mismo código con `sdk: ^3.12.0` sigue compilando en el SDK 3.13. Por eso el equipo de Dart no lo trató como un cambio incompatible en el sentido formal.
2. **Casi no estaba documentado en el lanzamiento.** El changelog original de 3.13.0 describía los constructores primarios pero no advertía del efecto sobre las funciones normales. Tras #64151 el changelog incorporó una entrada "**Breaking change**: You can no longer use `final` or `var` on non-declaring parameters" en la sección Language, y la página de constructores primarios recibió una sección "Constraints and breaking changes". La única señal previa fue la deprecación del lint `prefer_final_parameters` en Dart 3.11.

## Reproducción mínima

Bastan dos archivos. El pubspec fija la versión del lenguaje:

```yaml
# Dart 3.13.3
name: fp
environment:
  sdk: ^3.13.0
```

Y una biblioteca que usa `final` y `var` en todas las posiciones de parámetro habituales:

```dart
// Dart 3.13.3, language version 3.13
int add(int a, final int b) => a + b;                   // error

void named({required final String id, final int retries = 3}) {} // 2 errors

void positional([final int? x]) {}                      // error

void callback(final void Function(int) onTap) {}        // error

void untypedVar(var x) {}                               // error

class Money {
  final int cents;
  Money(final int c) : cents = c;                       // error, in-body constructor
  Money operator +(final Money other) => Money(cents + other.cents); // error
  set value(final int v) {}                             // error
  static Money zero(final int unused) => Money(0);      // error
}

void loops(List<int> xs) {
  for (final x in xs) {                                 // fine, not a parameter
    print(x);
  }
  final local = xs.length;                              // fine, local variable
  xs.forEach((final v) => print(v + local));            // error, closure parameter
}

class Point(final int x, final int y);                  // fine, declaring parameters
```

`dart analyze` en 3.13.3 reporta un error `extraneous_modifier` por cada parámetro marcado arriba. Al cambiar el pubspec a `sdk: ^3.12.0` todos desaparecen, y los únicos errores que quedan están en la línea de `Point`, que ahora dice `This requires the 'primary-constructors' language feature to be enabled`.

También se detectan los parámetros de campo y los super parámetros. `T2(final this.x)` y `C(final super.y)` producen `extraneous_modifier` en 3.13, además de una advertencia `unnecessary_final`, porque esos parámetros siempre fueron implícitamente finales.

Lo que *no* se ve afectado: variables locales, `for (final ... in ...)`, variables de patrón, campos y los parámetros simples `this.x` / `super.x`.

## Solución en detalle

Elige una de estas opciones, en orden de preferencia.

### 1. Deja que dart fix quite los modificadores

El analizador incluye una corrección para `extraneous_modifier`, así que la migración es mecánica:

```bash
dart fix --dry-run
```

En el paquete de reproducción eso reporta `extraneous_modifier - 11 fixes` en `lib/a.dart`, uno por error. Aplica solo ese código para no reescribir nada más del proyecto:

```bash
dart fix --apply --code=extraneous_modifier
```

El diff resultante es exactamente lo que escribirías a mano:

```dart
// Dart 3.13.3, after dart fix
int add(int a, int b) => a + b;
void named({required String id, int retries = 3}) {}
void positional([int? x]) {}
void callback(void Function(int) onTap) {}
void untypedVar(x) {}

class Money {
  final int cents;
  Money(int c) : cents = c;
  Money operator +(Money other) => Money(cents + other.cents);
  set value(int v) {}
  static Money zero(int unused) => Money(0);
}
```

Tras la corrección, `dart analyze` no reporta problemas y el programa se ejecuta. En una aplicación Flutter el comando es el mismo; `flutter` simplemente usa el SDK de Dart que trae incluido, así que ejecuta `dart fix` desde la raíz del proyecto con Flutter 3.47 en el path.

Ten en cuenta que `var x` pasa a ser un simple `x`, que es un parámetro implícitamente `dynamic`. Compila, pero si usas `strict-raw-types` u otras opciones similares del analizador, aprovecha para darle un tipo real.

### 2. Conserva la regla de no reasignar parámetros con un lint

Casi todos escribían `final` en los parámetros para que reasignarlos fuera un error de compilación. Esa garantía ahora la da el linter:

```yaml
# analysis_options.yaml, Dart 3.13.3
linter:
  rules:
    - parameter_assignments
```

```dart
// Dart 3.13.3
int clamp(int value, int max) {
  if (value > max) value = max; // info: Invalid assignment to the parameter 'value'.
  return value;
}
```

No recurras a `prefer_final_parameters` para recuperar el comportamiento anterior. Está deprecado desde Dart 3.11, y en 3.13 activarlo produce `The lint rule 'prefer_final_parameters' is deprecated and shouldn't be enabled`. Su consejo te llevaría ahora a código que no compila. Si el paquete de lints compartido de tu equipo todavía lo activa, ese paquete también necesita una actualización.

### 3. Fija un solo archivo a la versión anterior del lenguaje

Cuando hoy no puedes tocar un archivo, por ejemplo código generado o una biblioteca incluida en el repositorio, un comentario de versión del lenguaje al inicio del archivo excluye esa biblioteca:

```dart
// @dart=3.12
// Dart 3.13.3 SDK, this library uses language version 3.12
int legacyAdd(int a, final int b) => a + b; // compiles
```

El resto del paquete puede usar constructores primarios. Es un parche temporal: un archivo fijado en 3.12 no puede usar ninguna característica de 3.13, y conviene borrar el comentario en cuanto el archivo esté limpio.

### 4. Deja la restricción del SDK en 3.12 hasta que estés listo

Como la comprobación depende de la versión del lenguaje de tu paquete y no del SDK que ejecutas, el SDK 3.13 compila sin problema un paquete cuya restricción es `sdk: ^3.12.0`. Si subiste la restricción solo porque una plantilla o un `pub upgrade --major-versions` lo hizo por ti, revertir el límite inferior es una solución válida a corto plazo. Las dependencias no se ven afectadas en ningún caso: en mi reproducción una dependencia por path con `sdk: ^3.12.0` y `final` en un parámetro compiló y se ejecutó sin problemas dentro de una aplicación 3.13, porque cada paquete se compila con su propia versión del lenguaje.

## Prepara una base de código 3.12 antes de actualizar

Si todavía estás en Flutter 3.44 / Dart 3.12, puedes encontrar y corregir todo antes de subir la restricción. La página de constructores primarios recomienda dos lints que existen en 3.12.2:

```yaml
# analysis_options.yaml, Dart 3.12.2
linter:
  rules:
    - avoid_final_parameters
    - var_with_no_type_annotation
```

En 3.12.2 reportan `Parameters should not be marked as 'final'` y `Avoid declaring parameters with var and no type annotation`, y ambos tienen soporte de `dart fix` (`--code=avoid_final_parameters` y `--code=var_with_no_type_annotation`). Corrige las advertencias, sube `sdk:` a `^3.13.0` y la actualización no produce ningún error `extraneous_modifier`.

## Trampas y casos parecidos

- **Los generadores de código también lo emiten.** freezed 3.x generaba constructores como `const _Example({required final List<String> someField})` para los campos de colección, lo que falla en un paquete 3.13 ([rrousselGit/freezed#1365](https://github.com/rrousselGit/freezed/issues/1365)). freezed 4.0.0 (2026-08-22) eliminó `final` dentro de los parámetros de los constructores generados, y 4.0.2 es la versión actual. Actualiza el generador y vuelve a ejecutar `dart run build_runner build`. Ejecutar `dart fix` sobre archivos `.freezed.dart` no sirve de nada, porque la siguiente compilación los regenera. Si usas otro generador, revisa su changelog buscando "Dart 3.13" o "primary constructors" antes de culpar a tu propio código.
- **Las herramientas que analizan tu código pueden toparse con esto incluso en 3.12.** En #64151 el fallo venía de una herramienta que llamaba a `parseString()` del analizador sin un `featureSet`. Eso toma por defecto la versión del lenguaje más reciente que conoce el analizador, así que analyzer 13.1.0 y posteriores rechazaron parámetros `final` en un paquete que seguía en una versión anterior del lenguaje. Si un builder personalizado, una herramienta de documentación o un script de métricas de código falla mientras `dart analyze` pasa, esa es la causa, y la corrección corresponde a la herramienta.
- **El mensaje nunca menciona los constructores primarios.** El equipo de Dart discutió un mensaje más largo en #64151 y decidió no hacerlo, así que lo que obtienes es `Try removing 'final'`. Si llegaste aquí desde esa cadena exacta, esta página es la explicación.
- **`var` sin tipo pasa a `dynamic`.** `dart fix` convierte `(var x)` en `(x)`, no en `(Object? x)`. Añade un tipo si te importa.
- **Correspondencia de versiones de Flutter.** Flutter 3.47.0 a 3.47.5 incluyen Dart 3.13.0 a 3.13.4. Actualizar solo Flutter no cambia nada; los errores aparecen únicamente cuando el límite inferior de `sdk:` de un paquete llega a 3.13, así que tras esa subida, los fragmentos copiados de respuestas antiguas que usan parámetros `final` fallan de inmediato.
- **No es lo mismo que los campos `final` en un constructor primario.** `class User(final String name);` es código válido de 3.13 y declara un campo. Si obtienes `extraneous_modifier` en un parámetro de constructor primario, comprueba que la lista de parámetros esté realmente en el encabezado de la clase y no en un constructor con cuerpo.

## Relacionado

- La característica que causó esto, desde su etapa experimental: [constructores primarios en Dart 3.12](/es/2026/06/dart-3-12-experimental-primary-constructors/).
- Otra sorpresa de la actualización a 3.13 que no se ve en tu diff: [CERTIFICATE_VERIFY_FAILED en la imagen Docker de Dart 3.13](/es/2026/09/fix-certificate-verify-failed-in-dart-3-13-docker-image/).
- Si subir la restricción del SDK también rompió la resolución de dependencias, consulta [cómo corregir version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Para elegir entre clases de datos generadas y tipos integrados tras la actualización a freezed 4.0: [records de Dart frente a clases freezed](/es/2026/05/dart-records-vs-freezed-classes/).
- Si `dart fix` y el analizador van lentos en un repositorio grande, [acelera el servidor de análisis de Dart en VS Code](/es/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

## Fuentes

- [dart-lang/sdk#64151: `final` no longer allowed on parameters of normal functions/methods](https://github.com/dart-lang/sdk/issues/64151)
- [Dart SDK CHANGELOG, 3.13.0 Language section](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [Primary constructors feature specification (accepted/3.13)](https://github.com/dart-lang/language/blob/main/accepted/3.13/primary-constructors/feature-specification.md)
- [Primary constructors, dart.dev](https://dart.dev/language/primary-constructors)
- [`parameter_assignments` lint rule](https://dart.dev/tools/linter-rules/parameter_assignments)
- [`avoid_final_parameters` lint rule](https://dart.dev/tools/linter-rules/avoid_final_parameters)
- [rrousselGit/freezed#1365: invalid `final` keyword in generated constructor parameters](https://github.com/rrousselGit/freezed/issues/1365)
- [freezed CHANGELOG (4.0.0, 4.0.2)](https://github.com/rrousselGit/freezed/blob/master/packages/freezed/CHANGELOG.md)

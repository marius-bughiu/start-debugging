---
title: "Dart 3.12 incorpora los constructores primarios tras un flag experimental"
description: "Dart 3.12 agrega una sintaxis experimental de constructores primarios que declara los campos y un constructor en el encabezado de la clase, reduciendo la clásica clase de datos de tres líneas a una sola."
pubDate: 2026-06-04
tags:
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/06/dart-3-12-experimental-primary-constructors"
translatedBy: "claude"
translationDate: 2026-06-04
---

Dart 3.12 (lanzado el 2026-05-20) incorporó una de las características más solicitadas del lenguaje como versión preliminar experimental: los constructores primarios. Si alguna vez escribiste el mismo campo, más el parámetro de constructor `this.field`, más la asignación tres veces para una clase de datos sencilla, esta es la sintaxis que elimina ese patrón. Por ahora está detrás de `--enable-experiment=primary-constructors`, pero vale la pena integrarla en una rama hoy mismo porque cambia cómo se lee buena parte del código Dart cotidiano.

Esto da continuidad al otro recorte de código repetitivo de Dart 3.12, los [parámetros nombrados privados como formales de inicialización](/es/2026/05/dart-3-12-private-named-parameters-initializing-formals/). Los constructores primarios van más allá: trasladan toda la declaración al encabezado de la clase.

## Una línea en lugar de cuatro

Esta es la clase de datos que todo el mundo escribe, la parte que el compilador debería haber generado desde siempre:

```dart
class Point {
  final int x;
  final int y;
  Point(this.x, this.y);
}
```

Con un constructor primario, las declaraciones de campos y el constructor se colapsan en el encabezado. Un cuerpo de clase vacío se convierte en un punto y coma:

```dart
class Point(final int x, final int y);
```

La regla es simple: un parámetro marcado como `final` o `var` en el encabezado se convierte en un campo de instancia. Quita el modificador y queda como un parámetro de constructor común, no un campo. Así, `class User(String name);` toma `name` como argumento sin almacenarlo, mientras que `class User(final String name);` lo almacena.

## Los campos pueden depender de los parámetros del encabezado

Los parámetros del encabezado están en el ámbito dentro del cuerpo de la clase, así que puedes inicializar otros campos no `late` a partir de ellos sin una lista de inicialización:

```dart
class DeltaPoint(final int x, int delta) {
  final int y = x + delta;
}
```

Aquí `delta` es un parámetro de constructor (sin `final`, así que no es un campo) y `y` se calcula a partir de él.

## Agregar validación con un cuerpo

Cuando necesitas un assert o algo de configuración, escribes un cuerpo de constructor introducido por `this`. La forma de solo lista de inicialización termina en punto y coma:

```dart
class Point(var int x, var int y) {
  this : assert(x >= 0 && y >= 0) {
    print('Point initialized at ($x, $y)');
  }
}
```

Los constructores nombrados también tienen una forma más compacta, usando `new` en el cuerpo:

```dart
class Pet {
  String name;

  new() : name = 'Fluffy';
  new withName(this.name);
}
```

## Cómo activarlo

La característica es experimental, así que la habilitas por ejecución:

```bash
dart run --enable-experiment=primary-constructors bin/main.dart
```

Como es experimental, trátala como una versión preliminar: la sintaxis aún puede cambiar antes de estabilizarse, y `final` y `var` ahora tienen un significado especial en una lista de parámetros, así que no la lleves todavía a código de producción compartido. Pero para una rama lateral, los constructores primarios hacen mucho más cortos los modelos de widgets de Flutter, los objetos de valor y los contenedores de configuración. La especificación completa, incluidos los parámetros super y las reglas de los constructores nombrados, está en la [documentación de constructores primarios de Dart](https://dart.dev/language/primary-constructors).

---
title: "Dot shorthands en Dart 3.12: elimina el nombre del tipo en tu código Flutter"
description: "Los dot shorthands se volvieron estables en Dart 3.12.2. Escribe .center o .new y deja que el compilador infiera el tipo a partir del contexto. Así funcionan con enums, miembros estáticos y constructores."
pubDate: 2026-07-05
tags:
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/07/dart-dot-shorthands-drop-the-type-name-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

Si tu árbol de widgets de Flutter es un muro de `MainAxisAlignment.center`, `CrossAxisAlignment.start` y `EdgeInsets.all`, Dart acaba de darte una forma de eliminar buena parte de esa repetición. Los dot shorthands, la característica que te deja escribir `.center` y que el compilador deduzca el tipo, se volvieron estables en Dart 3.12.2. Flutter 3.44 ya incluye Dart 3.12, así que si estás en el canal stable actual puedes usar esto hoy.

## Qué hace realmente el punto inicial

Un dot shorthand es una expresión que comienza con un `.` pelado. Cuando el contexto que la rodea hace que el tipo objetivo sea inequívoco, Dart resuelve el miembro contra ese tipo en lugar de obligarte a escribirlo por completo. El caso clásico es un enum en una asignación:

```dart
Status currentStatus = .running; // Instead of Status.running
```

La variable está declarada como `Status`, así que `.running` solo puede significar `Status.running`. La misma inferencia entra en juego dentro de un `switch`, donde el valor que se compara ya fija el tipo:

```dart
return switch (level) {
  .debug => 'gray',
  .info => 'blue',
  .warning => 'orange',
  .error => 'red',
};
```

## No es solo para enums

El mecanismo es general: cualquier miembro estático accesible a través del tipo de contexto es válido. Eso incluye métodos estáticos, getters estáticos, constructores con nombre y constructores de fábrica.

```dart
int port = .parse('8080');      // int.parse('8080')
BigInt zero = .zero;            // BigInt.zero
Point origin = .origin();       // Point.origin() named constructor
Point p = .fromList([1.0, 2.0]); // Point.fromList(...) factory
```

El constructor sin nombre recibe un nombre para este propósito: `.new`. Ese único detalle es lo que hace que la característica valga la pena en código Flutter real, donde asignas constantemente objetos recién construidos a campos con tipo:

```dart
final ScrollController _scrollController = .new();
final GlobalKey<ScaffoldMessengerState> scaffoldKey = .new();
```

## La única regla que hace tropezar a la gente

La igualdad tiene un caso especial. Cuando usas un shorthand en el lado derecho de `==` o `!=`, Dart toma el tipo estático del operando izquierdo como contexto:

```dart
if (myColor == .green) {
  print('The color is green.');
}
```

Aquí `myColor` está tipado como `Color`, así que `.green` se resuelve a `Color.green`. El shorthand tiene que ir en el lado derecho. Dale la vuelta a `.green == myColor` y no hay tipo de operando izquierdo del cual inferir, así que no compilará.

## Cómo activarlo

Los dot shorthands requieren una versión de lenguaje de al menos 3.10, y la característica llegó a stable en Dart 3.12.2. Si ya estás en Flutter 3.44, la tienes. Sube la restricción del SDK en `pubspec.yaml` a `^3.12.0` y el analizador deja de marcar el punto inicial. No hay costo en runtime ni cambio en el código generado: esto es pura sintaxis que se resuelve en tiempo de compilación al miembro totalmente calificado que habrías escrito de todas formas.

La ganancia no es código más corto por sí mismo. Es que el tipo aparece una sola vez, en la declaración, en lugar de repetirse en cada valor. Consulta la [página de lenguaje sobre dot shorthands](https://dart.dev/language/dot-shorthands) para conocer todas las reglas de resolución.

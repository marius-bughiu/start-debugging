---
title: "Dart 3.12 elimina la lista de inicialización para los campos privados"
description: "Dart 3.12 permite que los constructores inicialicen campos privados directamente con parámetros nombrados, eliminando uno de los patrones de código repetitivo más persistentes del lenguaje."
pubDate: 2026-05-25
tags:
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/05/dart-3-12-private-named-parameters-initializing-formals"
translatedBy: "claude"
translationDate: 2026-05-25
---

Dart 3.12 llegó en Google I/O 2026 junto con Flutter 3.44, y dentro de la versión se esconde un pequeño cambio en el lenguaje que elimina un fragmento de código repetitivo que todo desarrollador de Dart ha escrito un centenar de veces. Ahora puedes usar parámetros nombrados privados como initializing formals. En términos sencillos: un constructor puede recibir un argumento nombrado y asignarlo directamente a un campo privado, sin necesidad de una lista de inicialización.

## El problema del guion bajo que Dart arrastró durante años

Dart marca un campo como privado anteponiéndole un guion bajo. Esa convención chocaba con los parámetros nombrados del constructor, porque el lenguaje se negaba a permitir que un parámetro nombrado empezara con `_`. El resultado era un baile familiar: aceptar un parámetro con nombre público y luego copiarlo manualmente al campo privado en la lista de inicialización.

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required String petName, required int wingbeatsPerSecond})
    : _petName = petName,
      _wingbeatsPerSecond = wingbeatsPerSecond;
}
```

Cada campo privado significaba una declaración de parámetro más una entrada en la inicialización. Para una clase con ocho campos privados, eso son dieciséis líneas de pura plomería. Los initializing formals (`this.field`) resolvieron esto para los campos públicos hace años, pero los campos privados se quedaron en el camino lento.

## Lo que 3.12 realmente cambia

Dart 3.12 hace que lo obvio funcione. Escribe `this._field` como parámetro nombrado y el compilador se encarga del resto:

```dart
class Hummingbird {
  final String _petName;
  final int _wingbeatsPerSecond;

  Hummingbird({required this._petName, required this._wingbeatsPerSecond});
}
```

El campo sigue siendo privado, pero el nombre del parámetro expuesto a quien llama es la versión pública con el guion bajo eliminado. Así que el sitio de la llamada se lee exactamente igual que antes:

```dart
void main() {
  print(Hummingbird(petName: 'Dash', wingbeatsPerSecond: 75));
}
```

Este es un cambio puramente del lado del constructor. La API pública es idéntica, quien llama no toca nada y los campos privados siguen siendo privados. Solo estás eliminando la lista de inicialización, nada más.

## Las restricciones que conviene conocer

Esta excepción se aplica únicamente a los initializing formals. Un parámetro nombrado normal sigue sin poder empezar con un guion bajo, porque eso filtraría un nombre privado en la firma pública sin un nombre público al que recurrir. El nombre con guion bajo también debe corresponder a un identificador público legal: `this._` y `this._2x` se rechazan, porque al quitar el guion bajo queda `` y `2x`, ninguno de los cuales es un nombre de parámetro válido.

La característica también se combina con los primary constructors, que llegaron como experimento en el mismo ciclo y requieren una versión del lenguaje de al menos 3.13. Con ambos en juego puedes declarar un campo privado directamente en el encabezado del constructor y dejar que el compilador publique automáticamente el nombre de cara al público.

Si ya estás en Flutter 3.44, tienes Dart 3.12 y puedes usar esto hoy. Sube la restricción de SDK en tu `pubspec.yaml` a `^3.12.0`, ejecuta `dart fix` y empieza a borrar listas de inicialización. Consulta el [anuncio de Dart 3.12](https://dart.dev/blog/announcing-dart-3-12) para ver las notas de la versión completas.

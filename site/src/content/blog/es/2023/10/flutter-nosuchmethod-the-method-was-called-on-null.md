---
title: "Flutter NoSuchMethod: the method was called on null"
description: "Este error de Flutter ocurre cuando llamas a un método sobre una referencia de objeto null. Aprende a diagnosticarlo y arreglarlo usando la pila de llamadas y breakpoints."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "es"
translationOf: "2023/10/flutter-nosuchmethod-the-method-was-called-on-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
Este error ocurre al intentar llamar a un método sobre una referencia de objeto `null`. No existe tal método porque el destino de la llamada es `null` o no está asignado. Por ejemplo:

```dart
foo.bar()
```

fallará con un error `NoSuchMethod` siempre que `foo` sea `null`. El error dirá: `NoSuchMethod: the method 'bar' was called on null`.

Esto es el equivalente a una `NullReferenceException` en C#.

## ¿Cómo lo arreglo?

Usa la pila de llamadas para determinar la línea en la que ocurrió el error. Como el nombre del método aparece en el mensaje de error, normalmente con eso es suficiente. Si no, pon un breakpoint en esa línea y, al alcanzarlo, inspecciona los valores de las variables buscando un `null`. Cuando lo encuentres, intenta entender qué llevó a ese estado y soluciónalo.

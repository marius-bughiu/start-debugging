---
title: "Asignación de fusión nula ??= en C# 8.0"
description: "Aprende cómo funciona el operador de asignación de fusión nula (??=) de C# 8.0, con ejemplos prácticos como caché y asignaciones condicionales."
pubDate: 2020-04-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2020/04/c-8-0-null-coalescing-assignment"
translatedBy: "claude"
translationDate: 2026-05-01
---
El operador te permite asignar el valor del operando de la derecha al operando de la izquierda solo si el valor del operando de la izquierda evalúa a null.

Veamos un ejemplo muy básico:

```cs
int? i = null;

i ??= 1;
i ??= 2;
```

En el ejemplo anterior declaramos una variable `int` anulable `i` y luego hacemos dos asignaciones de fusión nula sobre ella. En la primera asignación, `i` evaluará a `null`, lo que significa que a `i` se le asignará el valor `1`. En la siguiente asignación, `i` será `1` -- que no es `null` -- así que la asignación se omitirá.

Como cabe esperar, el valor del operando de la derecha solo se evaluará si el operando de la izquierda es `null`.

```cs
int? i = null;

i ??= Method1();
i ??= Method2(); // Method2 is never called because i != null
```

## Casos de uso

El operador ayuda a simplificar el código y hacerlo más legible en situaciones en las que normalmente recorrerías distintas ramas `if` hasta que se establezca el valor de una determinada variable.

Un ejemplo es el caché. En el ejemplo de abajo, la llamada a `GetUserFromServer` solo se haría cuando `user` siga siendo null tras intentar recuperarlo desde la caché.

```cs
var user = GetUserFromCache(userId);
user ??= GetUserFromServer(userId);
```

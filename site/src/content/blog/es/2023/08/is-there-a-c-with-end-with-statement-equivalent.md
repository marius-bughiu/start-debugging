---
title: "¿Existe en C# un equivalente a la sentencia With...End With?"
description: "La sentencia With...End With de VB te permite ejecutar una serie de instrucciones que se refieren repetidamente a un mismo objeto, usando una sintaxis simplificada para acceder a sus miembros. ¿Existe un equivalente en C#? No. Lo más parecido serían los inicializadores de objetos, pero solo sirven para crear instancias nuevas."
pubDate: 2023-08-05
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/08/is-there-a-c-with-end-with-statement-equivalent"
translatedBy: "claude"
translationDate: 2026-05-01
---
La sentencia With...End With de VB te permite ejecutar una serie de instrucciones que se refieren repetidamente a un mismo objeto. De esta manera, las instrucciones pueden usar una sintaxis simplificada para acceder a los miembros del objeto. Por ejemplo:

```vb
With car
    .Make = "Mazda"
    .Model = "MX5"
    .Year = 1989
End With
```

## ¿Existe un equivalente sintáctico en C#?

No. No existe. Lo más parecido serían los inicializadores de objetos, pero estos solo se usan al instanciar objetos nuevos; no pueden emplearse para actualizar instancias de objetos ya existentes, como sí lo permite la sentencia with.

Por ejemplo, al crear una nueva instancia de un objeto puedes usar el inicializador de objetos:

```cs
var car = new Car
{
    Make = "Mazda",
    Model = "MX5",
    Year = 1989
};
```

Pero al actualizar el objeto no hay una sintaxis simplificada equivalente. Tendrías que referenciar el objeto en cada asignación o llamada a miembro, así:

```cs
car.Make = "Aston Martin";
car.Model = "DBS";
car.Year = 1967;
```

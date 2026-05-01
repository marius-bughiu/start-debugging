---
title: "C# ¿Qué es una NullReferenceException y cómo arreglarla?"
description: "Aprende qué provoca una NullReferenceException en C#, cómo depurarla y cómo prevenirla usando comprobaciones de null, el operador null-conditional y los tipos de referencia anulables."
pubDate: 2023-10-20
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/10/c-what-is-a-nullreferenceexception-and-how-to-fix-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
Una `NullReferenceException` es un error en tiempo de ejecución frecuente que ocurre cuando tu código intenta acceder a un objeto o a un miembro de un objeto, o manipularlo, pero la referencia al objeto está establecida en `null` (es decir, no referencia a ningún objeto válido en memoria). En otras palabras, estás intentando realizar una operación sobre algo que no existe.

Aquí tienes un ejemplo muy sencillo:

```cs
string myString = null;
int length = myString.Length;
```

En este ejemplo tenemos una variable string `myString` a la que se asigna el valor `null`. Cuando intentamos acceder a su propiedad `Length`, se lanza una `NullReferenceException` porque no puedes obtener la longitud de una cadena que no existe.

## ¿Cómo depurar?

Tu principal objetivo debe ser identificar el origen de la referencia nula. El depurador te permite localizar con precisión la ubicación del problema.

Primero, fíjate atentamente en los detalles de la excepción que ofrece el depurador, que indicarán la línea exacta de código donde ocurrió la excepción. Esta línea es clave para identificar la variable o el objeto responsable de la referencia nula.

A continuación, inspecciona variables y objetos pasando el ratón por encima o usando las ventanas `Locals` y `Watch` de tu editor. Estas herramientas te permiten examinar el estado de la aplicación en el momento de la excepción. Presta especial atención a las variables que se usan o se acceden en la línea que provocó la excepción. Si alguna de esas variables es null cuando no debería serlo, probablemente has encontrado el origen del problema.

Además, examina la pila de llamadas en la ventana Call Stack para retroceder por las llamadas a método que conducen hasta la excepción. Eso puede ayudarte a entender el contexto en el que se produjo la referencia nula, facilitando la identificación de la causa raíz. Una vez identificada la variable o el objeto responsable, puedes proceder a corregir el problema comprobando los valores nulos e introduciendo comprobaciones de null adecuadas para evitar futuras excepciones.

## ¿Cómo prevenirla?

Para prevenir `NullReferenceException`s es crucial comprobar valores `null` antes de intentar acceder a propiedades o métodos de objetos. Puedes usar sentencias condicionales como `if` para comprobar si algo es `null` antes de acceder a sus miembros. Por ejemplo:

```cs
string myString = null; 

if (myString != null) 
{ 
    int length = myString.Length; // This will only execute if 'myString' is not null. 
}
```

O puedes usar el operador null-conditional (introducido en C# 6.0) para acceder de forma segura a miembros de objetos que podrían ser null:

```cs
string myString = null; 
int? length = myString?.Length; // 'length' will be null if 'myString' is null.
```

### Tipos de referencia anulables

Otra forma de evitar `NullReferenceException`s es habilitar los tipos de referencia anulables, una característica introducida en C# 8.0. Ayuda a los desarrolladores a escribir código más seguro y fiable proporcionando una forma de expresar si un tipo de referencia (por ejemplo, clases e interfaces) puede ser null o no. Esta característica ayuda a detectar posibles excepciones de referencia nula en tiempo de compilación y mejora la legibilidad y el mantenimiento del código.

Cuando habilitas los tipos de referencia anulables en tu código, el compilador generará advertencias para posibles problemas de referencia nula. Tienes que añadir anotaciones para dejar claras tus intenciones, lo que ayuda a reducir o eliminar estas advertencias.

Los tipos de referencia anulables usan anotaciones para indicar si un tipo de referencia puede ser `null`:

-   `T?`: indica que un tipo de referencia `T` puede ser `null`.
-   `T`: indica que un tipo de referencia `T` es no anulable.

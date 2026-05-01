---
title: "C# 11 - Atributos genéricos"
description: "Aprende a definir y usar atributos genéricos en C# 11, incluyendo las restricciones sobre los argumentos de tipo y los mensajes de error más comunes."
pubDate: 2023-03-21
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/03/c-sharp-11-generic-attributes"
translatedBy: "claude"
translationDate: 2026-05-01
---
¡Por fin, los atributos genéricos son una realidad en C#! 🥳

Puedes definir uno igual que cualquier otra clase genérica:

```cs
public class GenericAttribute<T> : Attribute { }
```

Y usarlo igual que cualquier otro atributo:

```cs
[GenericAttribute<string>]
public class MyClass { }
```

## Restricciones de los atributos genéricos

Al aplicar el atributo, deben proporcionarse todos los argumentos de tipo genérico. En otras palabras, el atributo genérico debe estar totalmente construido.

Por ejemplo, esto no funcionará:

```cs
public class MyGenericType<T>
{
    [GenericAttribute<T>()]
    public string Foo { get; set; }
}
```

Los tipos que requieren anotaciones de metadatos no se permiten como argumentos de tipo de un atributo genérico. Veamos algunos ejemplos de lo que no está permitido y sus alternativas:

-   `dynamic` no está permitido. Usa `object` en su lugar
-   los tipos de referencia anulables no están permitidos. En lugar de `string?` puedes simplemente usar `string`
-   los tipos de tupla con la sintaxis de tuplas de C# no están permitidos. Puedes usar `ValueTuple` en su lugar (por ejemplo, `ValueTuple<string, int>` en lugar de `(string foo, int bar)`)

## Errores

> CS8968 'T': an attribute type argument cannot use type parameters

Este error significa que no has especificado todos los argumentos de tipo para tu atributo. Los atributos genéricos deben estar totalmente construidos, lo que significa que no puedes usar parámetros **T** al aplicarlos (véanse los ejemplos anteriores).

> CS8970 Type 'string' cannot be used in this context because it cannot be represented in metadata.

Los tipos de referencia anulables no se permiten como parámetros de tipo en atributos genéricos. Usa `string` en lugar de `string?`.

> CS8970 Type 'dynamic' cannot be used in this context because it cannot be represented in metadata.

`dynamic` no se puede usar como argumento de tipo para un atributo genérico. Usa `object` en su lugar.

> CS8970 Type '(string foo, int bar)' cannot be used in this context because it cannot be represented in metadata.

Las tuplas no se permiten como parámetro de tipo en atributos genéricos. Usa el `ValueTuple` equivalente en su lugar.

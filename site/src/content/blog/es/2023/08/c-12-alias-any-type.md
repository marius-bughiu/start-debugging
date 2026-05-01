---
title: "C# 12 alias para cualquier tipo"
description: "La directiva using alias se ha flexibilizado en C# 12 para permitir crear alias de cualquier tipo, no solo de tipos con nombre. Esto significa que ahora puedes crear alias de tuplas, punteros, tipos de array, tipos genéricos, etc. Así, en lugar de usar la forma estructural completa de una tupla, puedes ponerle un alias corto y descriptivo..."
pubDate: 2023-08-06
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/08/c-12-alias-any-type"
translatedBy: "claude"
translationDate: 2026-05-01
---
La directiva using alias se ha flexibilizado en C# 12 para permitir crear alias de cualquier tipo, no solo de tipos con nombre. Esto significa que ahora puedes crear alias de tuplas, punteros, tipos de array, tipos genéricos, etc. Así, en lugar de usar la forma estructural completa de una tupla, ahora puedes ponerle un alias corto y descriptivo que puedes utilizar en cualquier lugar.

Veamos un ejemplo rápido de alias de una tupla. Primero, declara el alias:

```cs
using Point = (int x, int y);
```

Luego úsalo como cualquier otro tipo. Puedes usarlo como tipo de retorno, en la lista de parámetros de un método o incluso para construir nuevas instancias de ese tipo. Prácticamente no hay límites.

Un ejemplo usando el alias de tupla declarado arriba:

```cs
Point Copy(Point source)
{
    return new Point(source.x, source.y);
}
```

Como hasta ahora, los alias de tipo solo son válidos en el archivo en el que se definen.

### Restricciones

Al menos por ahora, tendrás que especificar el nombre completo del tipo para todo lo que no sea un tipo primitivo. Por ejemplo:

```cs
using CarDictionary = System.Collections.Generic.Dictionary<string, ConsoleApp8.Car<System.Guid>>;
```

Como mucho, puedes ahorrarte el espacio de nombres de tu aplicación definiendo el alias dentro del propio namespace.

```cs
namespace ConsoleApp8
{
    using CarDictionary = System.Collections.Generic.Dictionary<string, Car<System.Guid>>;
}
```

### Error CS8652

> The feature 'using type alias' is currently in Preview and _unsupported_. To use Preview features, use the 'preview' language version.

Este error significa que tu proyecto aún no usa C# 12, así que no puedes usar las nuevas características del lenguaje. Si quieres cambiar a C# 12 y no sabes cómo, consulta [nuestra guía para migrar tu proyecto a C# 12](/2023/06/how-to-switch-to-c-12/).

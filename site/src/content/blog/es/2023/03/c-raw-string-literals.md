---
title: "Literales raw string en C# 11 (sintaxis con triple comilla)"
description: "Usa los literales raw string de C# 11 (sintaxis con triple comilla `\"\"\"`) para incrustar espacios en blanco, saltos de línea y comillas sin secuencias de escape. Reglas y ejemplos."
pubDate: 2023-03-15
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2023/03/c-raw-string-literals"
translatedBy: "claude"
translationDate: 2026-05-01
---
Los literales raw string son un nuevo formato que te permite incluir espacios en blanco, saltos de línea, comillas incrustadas y otros caracteres especiales en tu cadena, sin necesidad de secuencias de escape.

Cómo funciona:

-   un literal raw string comienza con tres o más caracteres de comilla doble (**"""**). Tú decides cuántas comillas dobles usas para envolver el literal.
-   termina con el mismo número de comillas dobles que usaste al inicio
-   los literales raw string multilínea requieren que las secuencias de apertura y cierre estén en líneas separadas. Los saltos de línea que siguen a la comilla de apertura y preceden a la comilla de cierre no se incluyen en el contenido final.
-   cualquier espacio en blanco a la izquierda de las comillas dobles de cierre se eliminará del literal de cadena (de todas las líneas; entramos en más detalle un poco más abajo)
-   las líneas deben empezar con la misma cantidad de espacios en blanco (o más) que la secuencia de cierre
-   en los literales raw multilínea, los espacios en blanco que siguen a la secuencia de apertura, en la misma línea, se ignoran

Un ejemplo rápido:

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
    """;
```

La salida será la siguiente:

```plaintext
Lorem ipsum "dolor" sit amet,
    consectetur adipiscing elit.
```

## Espacios en blanco antes de la secuencia de cierre

Los espacios en blanco antes de las comillas dobles de cierre controlan los espacios en blanco que se eliminan de tu expresión raw string. En el ejemplo anterior, había 4 espacios en blanco antes de la secuencia **"""**, por lo que se eliminaron cuatro espacios de cada línea de la expresión. Si solo hubiéramos tenido 2 espacios en blanco antes de la secuencia final, solo se habrían eliminado 2 caracteres de espacio de cada línea de la cadena raw.

### Ejemplo: sin espacios en blanco antes de la secuencia de cierre

En el ejemplo anterior, si no especificáramos ningún espacio antes de la secuencia de cierre, la cadena resultante mantendría la indentación exactamente como estaba.

**Expresión:**

```cs
string rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
""";
```

**Salida:**

```plaintext
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.
```

## Usar más de 3 comillas dobles en la secuencia de apertura / cierre

Esto es útil cuando hay una secuencia de 3 comillas dobles dentro del propio raw string. En el ejemplo siguiente usamos una secuencia de 5 comillas dobles para iniciar y terminar el literal raw string, de modo que podemos incluir en el contenido secuencias de 3 y 4 comillas dobles.

```cs
string rawString = """""
    3 double-quotes: """
    4 double-quotes: """"
    """"";
```

**Salida:**

```plaintext
3 double-quotes: """
4 double-quotes: """"
```

## Errores asociados

> CS8997: Unterminated raw string literal.

```cs
string rawString = """Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit. 
    """;
```

> CS9000: Raw string literal delimiter must be on its own line.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
        consectetur adipiscing elit.""";
```

> CS8999: Line does not start with the same whitespace as the closing line of the raw string literal.

```cs
var rawString = """
    Lorem ipsum "dolor" sit amet,
consectetur adipiscing elit.
    """;
```

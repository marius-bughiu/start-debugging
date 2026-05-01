---
title: "C# using var (using declaration)"
description: "Usa las using declarations de C# 8 (`using var`) para liberar objetos IDisposable sin llaves anidadas. Sintaxis, reglas de ámbito y cuándo preferir bloques `using`."
pubDate: 2020-05-01
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "es"
translationOf: "2020/05/c-using-var-using-declaration"
translatedBy: "claude"
translationDate: 2026-05-01
---
¿Alguna vez deseaste poder declarar algo que se libere automáticamente al terminar su ámbito contenedor, sin añadir otro par de llaves e indentación a tu código? No estás solo. Saluda a las using declarations de C# 8 🥰.

Con using var ahora puedes hacer:

```cs
void Foo()
{
    using var file = new System.IO.StreamWriter("myFile.txt");
    // code using file
}
```

en lugar de:

```cs
void Foo()
{
    using (var file = new System.IO.StreamWriter("myFile.txt"))
    {
        // code using file
    }
}
```

Se acabaron las llaves innecesarias y la indentación de más. El ámbito del disposable coincide con el de su padre.

Ahora un ejemplo más completo de using var:

```cs
static int SplitFile(string filePath)
{
    var dir = Path.GetDirectoryName(filePath);
    using var sourceFile = new StreamReader(filePath);

    int count = 0;
    while(!sourceFile.EndOfStream)
    {
        count++;

        var line = sourceFile.ReadLine();

        var linePath = Path.Combine(dir, $"{count}.txt");
        using var lineFile = new StreamWriter(linePath);

        lineFile.WriteLine(line);

    } // lineFile is disposed here, at the end of each individual while loop

    return count;

} // sourceFile is disposed here, at the end of its enclosing scope
```

Como puedes notar en el ejemplo anterior, el ámbito contenedor no tiene por qué ser un método. También puede ser el interior de una sentencia `for`, `foreach` o `while`, por ejemplo, o incluso un bloque `using` si te atreves. En cada uno de estos casos el objeto se liberará al final del ámbito contenedor.

## Error CS1674

Las using var declarations también vienen con errores en tiempo de compilación si la expresión que sigue a `using` no es un `IDisposable`.

> Error CS1674 'string': type used in a using statement must be implicitly convertible to 'System.IDisposable'.

## Buenas prácticas

En cuanto a las buenas prácticas para `using var`, en gran medida siguen las mismas pautas que al trabajar con using statements. Además de esas, puede que quieras:

-   declarar tus variables disposable al principio del ámbito, separadas de las demás variables, para que destaquen y sean fáciles de identificar al revisar el código
-   prestar atención al ámbito en el que las creas, porque vivirán durante todo ese ámbito. Si el valor disposable solo se necesita dentro de un ámbito hijo de vida más corta, puede tener sentido crearlo allí.

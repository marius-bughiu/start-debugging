---
title: "Cómo solucionar: 'Point' no tiene un tamaño predefinido, por lo tanto sizeof solo se puede usar en un contexto unsafe"
description: "Soluciona el error de C# en el que sizeof no se puede usar con Point fuera de un contexto unsafe. Dos soluciones: habilitar código unsafe o usar Marshal.SizeOf."
pubDate: 2023-11-09
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/11/how-to-fix-point-does-not-have-a-predefined-size-therefore-sizeof-can-only-be-used-in-an-unsafe-context"
translatedBy: "claude"
translationDate: 2026-05-01
---
El error que te aparece se debe a que, en C#, `sizeof` solo se puede usar con tipos que tienen un tamaño predefinido conocido en tiempo de compilación, y la estructura `Point` no es uno de esos tipos a menos que estés en un contexto unsafe.

Hay dos formas de resolverlo.

## Usar código `unsafe`

Esto permitiría usar el operador `sizeof` con tipos de cualquier tamaño. Para hacerlo, tendrás que marcar tu método con la palabra clave `unsafe` y también habilitar el código unsafe en la configuración de compilación de tu proyecto.

Básicamente, la firma de tu método cambia a esto:

```cs
public static unsafe void YourMethod()
{
    // ... your unsafe code
    // IntPtr sizeOfPoint = (IntPtr)sizeof(Point);
}
```

Y para permitir código unsafe, vas a las propiedades del proyecto, a la pestaña `Build`, y marcas la opción "Allow unsafe code". Una vez hecho esto, el error de compilación debería desaparecer.

## Usar `Marshal.SizeOf`

`Marshal.SizeOf` es seguro y no requiere un contexto unsafe. El método `SizeOf` devuelve el tamaño no administrado de un objeto en bytes.

Lo único que tienes que hacer es reemplazar `sizeof(Point)` por `Marshal.SizeOf(typeof(Point))`. Así:

```cs
IntPtr sizeOfPoint = (IntPtr)Marshal.SizeOf(typeof(Point));
```

`Marshal.SizeOf` forma parte del namespace `System.Runtime.InteropServices`, así que asegúrate de tener la directiva using correspondiente al inicio de tu archivo:

```cs
using System.Runtime.InteropServices;
```

Una cosa a tener en cuenta es que `Marshal.SizeOf` conlleva una penalización de rendimiento muy ligera en comparación con el `sizeof` unsafe. Es algo que quizás quieras tomar en consideración al elegir la solución que mejor se adapte a tus necesidades.

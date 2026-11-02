---
title: "C# UnsafeAccessor: miembros privados sin reflexión (.NET 8)"
description: "Accede a constructores, métodos, propiedades y campos privados conocidos con UnsafeAccessor de .NET 8: ejemplos probados y límites de versión."
pubDate: 2023-10-31
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
`UnsafeAccessorAttribute`, introducido en .NET 8, permite vincular un método `static extern` a un miembro conocido e inaccesible. El runtime aporta la implementación. Resulta útil cuando el tipo que declara el miembro y su firma se conocen al compilar; no sustituye la reflexión para descubrir miembros en ejecución.

**Corrección — 2 de noviembre de 2026:** el artículo original descartaba incorrectamente las sobrecargas y exigía una instancia para acceder a miembros estáticos. Ambas afirmaciones se corrigen aquí. El ejemplo restaurado se ejecutó en .NET 8.0.33; el rendimiento se trata por separado, sin afirmar sobrecoste cero universal.

## Descargar el ejemplo completo

[Descarga el código ejecutable en ZIP](/examples/unsafe-accessor.zip) o consulta las [instrucciones](/examples/#unsafe-accessor). Incluye proyecto, tipos declarantes, imports y comprobaciones de todos los patrones siguientes.

```sh
dotnet run -c Release
```

El programa comprueba los valores esperados y termina con error si difieren. Una ejecución correcta imprime:

```text
PASS: constructors, instance/static members, field access, readonly accessor observation
```

## Constructores privados y sobrecargas

En una clase auxiliar se permiten las sobrecargas habituales de métodos C#. Un accessor de constructor devuelve el tipo declarante y recibe los parámetros del constructor de destino:

```cs
using System.Runtime.CompilerServices;

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create();

    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create(string value);
}
```

Estas declaraciones se vinculan a `Foo()` y `Foo(string)`. El ZIP contiene el tipo `Foo` completo. Las funciones locales de nivel superior siguen reglas de nombres C# distintas de los métodos de una clase auxiliar; no es una limitación de `UnsafeAccessor`.

## Métodos de instancia y propiedades

El primer parámetro identifica el tipo declarante y proporciona la instancia. Los demás tipos de parámetros y el retorno deben coincidir con el miembro de destino. Las propiedades se acceden mediante sus métodos accessor:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
internal static extern string CallInstance(Foo instance, int value);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
internal static extern string GetProperty(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
internal static extern void SetProperty(Foo instance, string value);
```

El ejemplo comprueba el resultado del método privado, lee el valor inicial de la propiedad, lo escribe y vuelve a leerlo. Para miembros de instancia de un struct, el primer parámetro debe pasarse por `ref`.

## Miembros estáticos

Usa `StaticMethod` o `StaticField`. El primer parámetro sigue identificando el tipo declarante, pero **su valor no se utiliza** y puede ser null:

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
internal static extern string CallStatic(Foo? typeMarker, int value);

var result = Accessors.CallStatic(null, 42);
```

El tipo declarante de este ejemplo no es una clase estática. C# no permite usar una clase estática como tipo de parámetro; no deduzcas que este patrón de .NET 8 permite acceder a cualquier API de una clase estática.

## Campos

Un accessor de campo devuelve una referencia. El ejemplo lee y escribe campos tanto de instancia como estáticos:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
internal static extern ref int InstanceField(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
internal static extern ref int StaticField(Foo? typeMarker);
```

Para campos readonly, consulta el [ejemplo específico](/es/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/). Acceder por referencia no convierte la modificación arbitraria de estado inmutable en un diseño admitido.

## Límites y rendimiento

Solo se busca en el tipo declarante indicado; el runtime no recorre su jerarquía de herencia. Los vínculos inexistentes a campos o métodos fallan al usarse. Firmas y restricciones incorrectas pueden causar otros errores de vinculación. El soporte de parámetros genéricos se añadió en .NET 9, por lo que esos ejemplos requieren comprobar la versión por separado.

Un accessor puede evitar la búsqueda por reflexión y el manejo de argumentos de `Invoke`, pero siguen importando la operación de destino y el código generado. El [benchmark restaurado](/es/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) incluye acceso directo, reflexión almacenada y un delegado almacenado, con trabajo observable.

Fuente: [referencia de UnsafeAccessorAttribute de Microsoft](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute).

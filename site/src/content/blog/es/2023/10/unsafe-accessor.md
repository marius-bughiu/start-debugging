---
title: "C# UnsafeAccessor: miembros privados sin reflexión (.NET 8)"
description: "Usa el atributo `[UnsafeAccessor]` en .NET 8 para leer campos privados y llamar a métodos privados sin sobrecarga, sin reflexión y totalmente compatible con AOT."
pubDate: 2023-10-31
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
La reflexión te permite obtener información de tipos en tiempo de ejecución y acceder a miembros privados de una clase usando esa información. Esto puede ser especialmente útil al trabajar con clases que están fuera de tu control, proporcionadas por un paquete de terceros. Aunque es potente, la reflexión también es muy lenta, lo que es uno de los principales motivos para no usarla. Eso se acabó.

.NET 8 introduce una nueva forma de acceder a miembros privados sin sobrecarga mediante el uso del atributo `UnsafeAccessor`. El atributo se puede aplicar a un método `extern static`. La implementación del método la proporciona el runtime basándose en la información del atributo y la firma del método. Si no se encuentra coincidencia para la información proporcionada, la llamada al método lanzará una `MissingFieldException` o una `MissingMethodException`.

Veamos algunos ejemplos de cómo usar `UnsafeAccessor`. Consideremos la siguiente clase con miembros privados:

```cs
class Foo
{
    private Foo() { }
    private Foo(string value) 
    {
        InstanceProperty = value;
    }

    private string InstanceProperty { get; set; } = "instance-property";
    private static string StaticProperty { get; set; } = "static-property";

    private int instanceField = 1;
    private static int staticField = 2;

    private string InstanceMethod(int value) => $"instance-method:{value}";
    private static string StaticMethod(int value) => $"static-method:{value}";
}
```

## Crear instancias de objeto usando constructores privados

Como se describió arriba, empezamos declarando los métodos `static extern`.

-   anotamos los métodos con el atributo `UnsafeAccessor`: `[UnsafeAccessor(UnsafeAccessorKind.Constructor)]`
-   y hacemos coincidir las firmas de los constructores. En el caso de los constructores, el tipo de retorno debe ser el tipo de la clase a la que estamos redirigiendo (`Foo`). La lista de parámetros también debe coincidir.
-   el nombre del método extern no necesita coincidir con nada ni seguir ninguna convención. Algo importante que notarás es que no puedes tener dos métodos `extern static` con el mismo nombre pero distintos parámetros, similar a la sobrecarga, así que tendrás que proporcionar nombres únicos para cada sobrecarga.

Deberías terminar con esto:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructor();

[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructorWithParameters(string value);
```

Crear instancias de objeto usando los constructores privados es trivial a partir de este punto.

```cs
var instance1 = PrivateConstructor();
var instance2 = PrivateConstructorWithParameters("bar");
```

## Invocar métodos privados de instancia

El primer argumento del método `extern static` será una instancia de objeto del tipo que contiene el método privado. El resto de los argumentos deben coincidir con la firma del método al que estamos apuntando. El tipo de retorno también debe coincidir.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
extern static string InstanceMethod(Foo @this, int value);

Console.WriteLine(InstanceMethod(instance1, 42)); 
// Output: "instance-method:42"
```

## Leer / escribir propiedades privadas de instancia

Notarás que no existe `UnsafeAccessorKind.Property`. Eso es porque, igual que con los métodos de instancia, las propiedades de instancia se acceden a través de sus métodos getter y setter:

-   `get_{PropertyName}`
-   `set_{PropertyName}`

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
extern static string InstanceGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
extern static void InstanceSetter(Foo @this, string value);

Console.WriteLine(InstanceGetter(instance1));
// Output: "instance-property"

InstanceSetter(instance1, "bar");

Console.WriteLine(InstanceGetter(instance1));
// Output: "bar"
```

## Métodos y propiedades estáticos

Se comportan de forma idéntica a los miembros de instancia, con la única diferencia de que tienes que especificar `UnsafeAccessorKind.StaticMethod` en el atributo `UnsafeAccessor`. Incluso necesitas proporcionar una instancia de objeto de ese tipo al hacer la llamada.

¿Y las clases `static`? Las clases estáticas no son compatibles actualmente con `UnsafeAccessor`. Hay una propuesta de API que pretende cubrir este vacío, apuntando a .NET 9: [\[API Proposal\]: UnsafeAccessorTypeAttribute for static or private type access](https://github.com/dotnet/runtime/issues/90081)

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
extern static string StaticMethod(Foo @this, int value);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "get_StaticProperty")]
extern static string StaticGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "set_StaticProperty")]
extern static void StaticSetter(Foo @this, string value);
```

## Campos privados

Los campos son un poco más especiales en cuanto a la sintaxis del método `extern static`. Ya no tenemos métodos getter y setter disponibles, así que en su lugar usaremos la palabra clave `ref` para obtener una referencia al campo que podemos usar tanto para leer como para escribir el valor.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
extern static ref int InstanceField(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
extern static ref int StaticField(Foo @this);

// Read the field value
var x = InstanceField(instance1);
var y = StaticField(instance1);

// Update the field value
InstanceField(instance1) = 3;
StaticField(instance1) = 4;
```

¿Quieres probar esta característica? Puedes [encontrar todos los ejemplos anteriores en GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor/Program.cs).

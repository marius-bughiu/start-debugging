---
title: "C# 12 Interceptors"
description: "Aprende sobre los interceptors de C# 12, una característica experimental del compilador en .NET 8 que te permite reemplazar llamadas a métodos en tiempo de compilación usando el atributo InterceptsLocation."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2023/10/c-12-interceptors"
translatedBy: "claude"
translationDate: 2026-05-01
---
Los interceptors son una característica experimental del compilador introducida en .NET 8, lo que significa que puede cambiar o ser eliminada en una futura versión del framework. Para ver qué más hay nuevo en .NET 8, echa un vistazo a nuestra página [What's new in .NET 8](/2023/06/whats-new-in-net-8/).

Para activar la característica, tendrás que activar un feature flag añadiendo `<Features>InterceptorsPreview</Features>` a tu archivo `.csproj`.

## ¿Qué es un interceptor?

Un interceptor es un método que puede reemplazar una llamada a un método interceptable con una llamada a sí mismo. El vínculo entre los dos métodos se hace de forma declarativa, usando el atributo `InterceptsLocation`, y la sustitución se realiza durante el proceso de compilación, sin que el runtime sepa nada al respecto.

Los interceptors se pueden usar en combinación con source generators para modificar código existente añadiendo nuevo código a una compilación que reemplace por completo al método interceptado.

## Primeros pasos

Antes de empezar a usar interceptors, primero tendrás que declarar el `InterceptsLocationAttribute` en el proyecto donde planeas hacer la interceptación. Esto se debe a que la característica todavía está en preview y el atributo aún no se distribuye con .NET 8.

Aquí tienes la implementación de referencia:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int column)
        {
            
        }
    }
}
```

Veamos un ejemplo rápido de cómo funciona. Empezamos con una configuración muy simple que contiene una clase `Foo`, con un método `Interceptable` y unas pocas llamadas a ese método que querremos interceptar dentro de un momento.

```cs
var foo = new Foo();

foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(2); // "interceptable 2"
foo.Interceptable(1); // "interceptable 1"

class Foo
{
    public void Interceptable(int param)
    {
        Console.WriteLine($"interceptable {param}");
    }
}
```

A continuación, hacemos la interceptación propiamente dicha:

```cs
static class MyInterceptor
{
    [InterceptsLocation(@"C:\test\Program.cs", line: 5, column: 5)]
    public static void InterceptorA(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor A: {param}");
    }

    [InterceptsLocation(@"C:\test\Program.cs", line: 6, column: 5)]
    [InterceptsLocation(@"C:\test\Program.cs", line: 7, column: 5)]
    public static void InterceptorB(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor B: {param}");
    }
}
```

Asegúrate de actualizar la ruta del archivo (`C:\test\Program.cs`) con la ubicación de tu archivo de código fuente interceptable. Cuando termines, ejecuta todo de nuevo y la salida de las llamadas a `Interceptable(...)` cambiará a esto:

```plaintext
interceptable 1
interceptor A: 1
interceptor B: 2
interceptor B: 1
```

¿Qué clase de magia negra acabamos de hacer? Vamos a entrar un poco en detalles.

### Firma del método interceptor

Lo primero que hay que notar es la firma del método interceptor: es un método de extensión cuyo parámetro `this` tiene el mismo tipo que el propietario del método interceptable.

```cs
public static void InterceptorA(this Foo foo, int param)
```

Esto es una limitación de la preview que se eliminará antes de que la característica salga de preview.

### El parámetro `filePath`

Representa la ruta al archivo de código fuente que se necesita interceptar.

Cuando apliques el atributo en source generators, asegúrate de normalizar la ruta del archivo aplicando la misma transformación que realiza el compilador:

```cs
string GetInterceptorFilePath(SyntaxTree tree, Compilation compilation)
{
    return compilation.Options.SourceReferenceResolver?.NormalizePath(tree.FilePath, baseFilePath: null) ?? tree.FilePath;
}
```

### `line` y `column`

Son posiciones 1-indexadas que apuntan al lugar exacto donde se invoca el método interceptable.

En el caso de `column`, la ubicación de la llamada representa la posición de la primera letra del nombre del método interceptable. Por ejemplo:

-   para `foo.Interceptable(...)` sería la posición de la letra `I`. Suponiendo que no hay espacios antes del código, sería `5`.
-   para `System.Console.WriteLine(...)` sería la posición de la letra `W`. Suponiendo que no hay espacios antes del código, `column` sería `16`.

### Limitaciones

Los interceptors solo funcionan con métodos ordinarios. De momento no puedes interceptar constructores, propiedades ni funciones locales, aunque la lista de miembros soportados podría cambiar en el futuro.

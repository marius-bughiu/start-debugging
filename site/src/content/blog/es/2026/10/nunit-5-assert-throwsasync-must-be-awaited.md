---
title: "NUnit 5: Assert.ThrowsAsync ahora devuelve una Task, y si no la esperas pasa en silencio"
description: "NUnit 5.0.0 hace que Assert.ThrowsAsync, CatchAsync y DoesNotThrowAsync sean realmente asíncronos. Si olvidas el await, la aserción nunca se ejecuta. Qué se rompe, qué detecta la regla NUnit2059 de NUnit.Analyzers y los demás cambios de NUnit 5 que conviene revisar antes de actualizar."
pubDate: 2026-10-04
tags:
  - "nunit"
  - "testing"
  - "dotnet"
  - "csharp"
lang: "es"
translationOf: "2026/10/nunit-5-assert-throwsasync-must-be-awaited"
translatedBy: "claude"
translationDate: 2026-10-04
---

[NUnit 5.0.0](https://github.com/nunit/nunit/releases/tag/v5.0.0) se publicó el 27 de septiembre de 2026. Los mantenedores lo describen como una versión mayor pequeña, y la mayoría de los [cambios incompatibles](https://docs.nunit.org/articles/nunit/V5BreakingChanges.html) convierten fallos en runtime en errores del compilador. Un cambio va en sentido contrario: si actualizas sin cuidado, una prueba que falla puede empezar a pasar.

## ThrowsAsync antes bloqueaba, ahora devuelve una Task

En NUnit 4, `Assert.ThrowsAsync<T>`, `Assert.CatchAsync` y `Assert.DoesNotThrowAsync` tenían nombre asíncrono pero ejecutaban el delegado de forma síncrona, bloqueando el hilo que llamaba, y devolvían la excepción directamente. El [issue #4384](https://github.com/nunit/nunit/issues/4384) lo corrigió en 5.0.0: los tres ahora devuelven una `Task` y hay que esperarlos con await.

```csharp
// NUnit 4.6.1
var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());

// NUnit 5.0.0
var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());
```

La nueva forma es la correcta. El problema es el código que ya tienes.

## El paso silencioso

Las pruebas antiguas llaman a `ThrowsAsync` desde un método de prueba `void` normal. En NUnit 5 eso sigue compilando: la `Task` devuelta se descarta y, como el método no es `async`, el compilador ni siquiera emite CS4014. Lo ejecuté con .NET SDK 10.0.302 y NUnit3TestAdapter 6.3.0, donde `DoesNotThrowAsync` nunca lanza una excepción:

```csharp
static async Task DoesNotThrowAsync() => await Task.Delay(10);

[Test]
public void Unawaited()
{
    var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}

[Test]
public async Task Awaited()
{
    var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}
```

Los resultados:

| Configuración | `Unawaited` | `Awaited` |
| --- | --- | --- |
| NUnit 4.6.1 | falla (correcto) | CS1061, `ArgumentException` no tiene `GetAwaiter` |
| NUnit 5.0.0, NUnit.Analyzers 4.13.0 | **pasa** | falla (correcto) |
| NUnit 5.0.0, NUnit.Analyzers 4.14.0 o 4.15.0 | error de compilación NUnit2059 | falla (correcto) |

La fila del medio es la preocupante. La prueba que debería detectar la falta de una `ArgumentException` se pone en verde, y nada en la salida de la prueba sugiere que la aserción nunca se ejecutó.

## Deja que el analizador haga la migración

[NUnit.Analyzers](https://www.nuget.org/packages/NUnit.Analyzers) 4.14.0 añadió NUnit2059, "Method 'ThrowsAsync' returns a Task and is not being observed", reportada como error por defecto. Su corrección automática agrega el `await` y cambia el método que lo contiene a `async Task`. Por eso el orden de la actualización importa:

```xml
<PackageReference Include="NUnit" Version="5.0.0" />
<PackageReference Include="NUnit.Analyzers" Version="4.15.0" />
<PackageReference Include="NUnit3TestAdapter" Version="6.3.0" />
```

Sube el analizador en el mismo commit que el framework. Si tus proyectos fijan NUnit.Analyzers de forma centralizada en `Directory.Packages.props` con una versión anterior, o lo eliminaron, la compilación sigue en verde y terminas en la fila del paso silencioso.

## Los demás cambios de NUnit 5 que vale la pena buscar con grep

- `TestDelegate`, `AsyncTestDelegate` y `ActualValueDelegate<T>` desaparecieron. Las lambdas no se ven afectadas; los usos explícitos pasan a `Action`, `Func<Task>` y `Func<T>`.
- `[Platform("NET")]` y `"DotNET"` ahora significan .NET moderno, no .NET Framework. Usa el nuevo identificador `"NETFramework"` si es lo que querías, o las pruebas empezarán (o dejarán) de ejecutarse en silencio en el runtime equivocado.
- `Is.SameAs` solo acepta tipos de referencia, y `Has.Attribute<T>()` exige `T : Attribute`. Ambos eran fallos en runtime antes.
- `StringAssert`, `CollectionAssert`, `FileAssert` y `DirectoryAssert` vuelven a `NUnit.Framework`.
- El framework apunta a `net462`, `net8.0` y `net10.0`. El destino `net6.0` ya no existe.
- `[Order]` ahora es `[Obsolete]`. Los reemplazos son los nuevos atributos `[DependsOnTest]` y `[DependsOnFixture]`, que omiten una prueba cuando falla su dependencia.

Si estás decidiendo si NUnit sigue siendo el framework adecuado para un proyecto nuevo, mi [comparación de xUnit v3, NUnit y MSTest](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) se midió con NUnit 4.6.1. Los números de ahí son anteriores a 5.0.0, pero la recomendación no depende de nada que haya cambiado esta versión.

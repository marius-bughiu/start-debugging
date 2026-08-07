---
title: "xUnit v3 vs NUnit vs MSTest en 2026: ¿cuál deberías elegir?"
description: "Elige xUnit v3 para proyectos .NET nuevos, NUnit 4.6 si vives en su modelo de restricciones, y MSTest 4 si ya lo tienes en producción. Una comparación medida sobre .NET SDK 10.0.201 que cubre los valores por defecto de paralelismo, el ciclo de vida de la clase de prueba, los mensajes de fallo de las aserciones y el conflicto de versiones de Microsoft.Testing.Platform que rompe el runner de NUnit."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "testing"
  - "xunit"
  - "nunit"
  - "mstest"
  - "dotnet"
lang: "es"
translationOf: "2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026"
translatedBy: "claude"
translationDate: 2026-08-07
---

Elige **xUnit v3** para un proyecto .NET nuevo en 2026. Paraleliza por defecto, sus mensajes de fallo son los más precisos de los tres y es lo que usa el equipo de .NET. Elige **NUnit 4.6** si tu suite se apoya en su modelo de restricciones o en `[Retry]`. Elige **MSTest 4** si ya tienes MSTest y no estás sufriendo, porque la v4 cerró casi toda la brecha.

Todos los números de abajo se midieron sobre .NET SDK 10.0.201 (runtime 10.0.5) contra xunit.v3 3.2.2, NUnit 4.6.1 con NUnit3TestAdapter 5.1.0 y MSTest 4.3.3. Cada afirmación sobre comportamiento en este artículo se verificó ejecutando código, no leyendo un changelog, porque buena parte de la sabiduría heredada sobre estos tres frameworks ya está desactualizada.

## La matriz de características

| Comportamiento (versiones probadas) | xUnit v3 3.2.2 | NUnit 4.6.1 | MSTest 4.3.3 |
| --- | --- | --- | --- |
| Paralelo por defecto | Sí, entre colecciones | No, hay que activarlo | No, hay que activarlo |
| Nueva instancia de clase por prueba | Sí | No, una por fixture | Sí |
| Atributo de prueba | `[Fact]` / `[Theory]` | `[Test]` / `[TestCase]` | `[TestMethod]` / `[DataRow]` |
| Requiere atributo marcador de clase | No | No | Sí, `[TestClass]` |
| Estilo de aserción | `Assert.Equal` | Restricciones, `Assert.That(x, Is...)` | `Assert.AreEqual`, `Assert.That` |
| Muestra la expresión que falló | No | Sí | Sí |
| `Assert.Multiple` | Sí | Sí | No |
| Atributo de reintento incorporado | No | Sí, `[Retry(n)]` | Sí, `[Retry(n)]` |
| Tipo de proyecto | Exe, siempre | Exe al usar el runner de NUnit | Exe al usar el runner de MSTest |
| Microsoft.Testing.Platform | Nativo, incorporado | Vía adaptador 5.0+ | Nativo desde 3.2 |
| Objetivo mínimo | .NET 8 / .NET Framework 4.7.2 | .NET 6 / .NET Framework 4.6.2 | .NET 8 / .NET Framework 4.6.2 |

Dos filas de esa tabla contradicen lo que dice la mayoría de las comparaciones. Ambas merecen su propia sección.

## La afirmación sobre el ciclo de vida de la instancia que está mal en todas partes

La frase más repetida en esta comparación es que xUnit crea una instancia nueva de la clase de prueba por cada prueba mientras que NUnit y MSTest reutilizan una sola instancia. La mitad de eso es falso. MSTest siempre ha construido una instancia nueva por cada método de prueba.

Aquí está la sonda, idéntica en los tres proyectos salvo por los atributos:

```csharp
// MSTest 4.3.3, .NET 10.0.201
[TestClass]
public class LifecycleTests
{
    private static int _instances;
    private readonly int _id;
    public LifecycleTests() { _id = Interlocked.Increment(ref _instances); }

    private void Record(string n) =>
        File.AppendAllText(Log, $"{n} ctorId={_id} totalInstances={_instances}");

    [TestMethod] public void A() => Record("A");
    [TestMethod] public void B() => Record("B");
    [TestMethod] public void C() => Record("C");
}
```

Ejecutando cada uno de los tres:

```text
# xunit.v3 3.2.2
A ctorId=3 totalInstances=3
B ctorId=1 totalInstances=1
C ctorId=2 totalInstances=2

# MSTest 4.3.3
A ctorId=1 totalInstances=1
B ctorId=2 totalInstances=2
C ctorId=3 totalInstances=3

# NUnit 4.6.1
A ctorId=1 totalInstances=1
B ctorId=1 totalInstances=1
C ctorId=1 totalInstances=1
```

xUnit y MSTest construyeron tres instancias cada uno. NUnit construyó una y la compartió. NUnit es la excepción, y es el único de los tres donde un campo de instancia mutable filtra estado de una prueba a la siguiente.

Esto importa más de lo que parece. Una única instancia por fixture es exactamente el escenario donde una suite dependiente del orden crece en silencio, y encaja mal con el paralelismo: los campos de instancia se convierten en estado mutable compartido en cuanto dos pruebas del mismo fixture se ejecutan concurrentemente. La propia documentación de NUnit lo dice, y te da la salida, añadida ya en NUnit 3.13:

```csharp
// NUnit 4.6.1
[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]
public class LifecycleTests { /* ... */ }
```

Con ese atributo aplicado, la misma sonda imprime `ctorId=1`, `2`, `3`. Si estás en NUnit y piensas activar el paralelismo, aplícalo a nivel de ensamblado antes de hacerlo. Ten en cuenta que `OneTimeSetUp` y `OneTimeTearDown` deben pasar a ser `static` cuando lo hagas, ya que ahora se ejecutan una vez para un fixture que no tiene una instancia única.

## El benchmark de paralelismo

Esta es la única diferencia real de rendimiento, y tiene que ver enteramente con los valores por defecto.

**Montaje**: cuatro clases de prueba, cinco pruebas cada una, cada prueba con `Thread.Sleep(200)`. Veinte pruebas, así que una ejecución estrictamente secuencial tiene un piso de 4.0 segundos y una ejecución perfectamente paralela por clase tiene un piso de 1.0 segundo. Compilación en Release, ejecutado como el ejecutable de pruebas directamente a través de Microsoft.Testing.Platform, tiempo de reloj sobre tres ejecuciones tras un calentamiento, Intel Core Ultra 7 265KF (20 núcleos, 20 lógicos), Windows 11, .NET SDK 10.0.201.

| Framework | Configuración por defecto | Con paralelismo a nivel de clase activado |
| --- | --- | --- |
| xunit.v3 3.2.2 | 1.29 - 1.32 s | 1.29 - 1.32 s (ya es el valor por defecto) |
| NUnit 4.6.1 | 4.71 - 4.73 s | 1.53 - 1.64 s |
| MSTest 4.3.3 | 4.80 - 4.89 s | 1.66 - 1.69 s |

Sin tocar nada, xUnit es 3.6 veces más rápido que NUnit y 3.7 veces más rápido que MSTest en esta suite. Ese es el número que se cita. También es engañoso, porque mide un valor por defecto, no una capacidad. Un solo atributo a nivel de ensamblado borra casi toda la diferencia:

```csharp
// NUnit 4.6.1
[assembly: Parallelizable(ParallelScope.Fixtures)]
```

```csharp
// MSTest 4.3.3
[assembly: Parallelize(Workers = 0, Scope = ExecutionScope.ClassLevel)]
```

Con eso en su lugar, los tres se sitúan entre 1.29 y 1.69 segundos. La diferencia residual de 240 a 380 ms es sobrecarga de arranque del runner, no ejecución de pruebas: xUnit v3 aloja Microsoft.Testing.Platform de forma nativa, mientras que NUnit 4.6.1 llega a él a través del puente VSTest de NUnit3TestAdapter, que cuesta un poco más al arrancar.

Así que el encuadre honesto es este. La ventaja de xUnit es que el valor por defecto seguro también es el rápido, y es seguro gracias al modelo de instancia por prueba. NUnit y MSTest te obligan a activarlo, y en NUnit deberías arreglar antes el ciclo de vida del fixture. Si tu CI lleva tres años ejecutando en serie una suite de MSTest de 12 minutos, el arreglo es una línea, no una migración.

## Mensajes de fallo de aserciones, lado a lado

Esto solía ser una goleada. Ya no lo es. Los mismos tres fallos, salida real de cada runner:

```text
# xunit.v3 3.2.2
Assert.Equal() Failure: Strings differ
                  ↓ (pos 7)
Expected: "hello world"
Actual:   "hello wurld"
                  ↑ (pos 7)

Assert.Equal() Failure: Collections differ
                 ↓ (pos 2)
Expected: [1, 2, 3, 8]
Actual:   [1, 2, 4, 8]
                 ↑ (pos 2)
```

```text
# NUnit 4.6.1
Assert.That("hello wurld", Is.EqualTo("hello world"))
String lengths are both 11. Strings differ at index 7.
Expected: "hello world"
But was:  "hello wurld"
------------------^

Assert.That(actual, Is.EqualTo(expected))
Expected and actual are both <System.Int32[4]>
Values differ at index [2]
Expected: 3
But was:  4
```

```text
# MSTest 4.3.3
Assertion failed. Expected strings to be equal.
Strings have same length (11) and differ at 1 location(s). First difference at index 7.

expected: "hello world"
actual:   "hello wurld"

Assert.AreEqual("hello world", "hello wurld")
```

Los tres apuntan al índice exacto. NUnit y MSTest 4 muestran además la expresión fuente que falló, cosa que xUnit no hace, porque MSTest 4 añadió `CallerArgumentExpression` a todas las APIs de `Assert` y NUnit lo tiene desde la 4.0. xUnit compensa con los marcadores visuales de posición, que son mejores para cadenas largas y colecciones.

Donde MSTest todavía se queda atrás es en el caso de las colecciones: `CollectionAssert.AreEqual` imprime "Element at index 2 do not match" sin mostrar ninguna de las dos secuencias, así que obtienes el índice pero no la forma de la diferencia. Si comparas colecciones a menudo, eso es una molestia real.

Dos detalles de API que conviene conocer antes de escribir aserciones en MSTest 4. `Assert.That` recibe una `Expression<Func<bool>>`, no un `bool`, así que `Assert.That(1 + 1 == 2)` no compila y `Assert.That(() => 1 + 1 == 2)` sí. Y MSTest no tiene `Assert.Multiple`; tanto xUnit v3 como NUnit 4.6 sí.

## El detalle que decide por ti

Si hoy levantas un proyecto NUnit sobre el SDK .NET 10.0.201 con el runner nativo de NUnit, esto es lo que obtienes:

```text
error CS1705: Assembly 'NUnit3.TestAdapter' with identity 'NUnit3.TestAdapter, Version=5.1.0.0'
uses 'Microsoft.Testing.Platform, Version=1.8.1.0' which has a higher version than referenced
assembly 'Microsoft.Testing.Platform' with identity 'Microsoft.Testing.Platform, Version=1.7.3.0'
```

NUnit3TestAdapter 5.1.0 está compilado contra Microsoft.Testing.Platform 1.8.1, pero nada en el grafo de paquetes declara esa dependencia, así que gana la versión que inyecta el SDK: la 1.7.3. El proyecto no compila. El arreglo es fijar tú mismo ambos ensamblados de la plataforma:

```xml
<!-- NUnit 4.6.1 + NUnit3TestAdapter 5.1.0 on .NET SDK 10.0.201 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <EnableNUnitRunner>true</EnableNUnitRunner>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="NUnit" Version="4.6.1" />
  <PackageReference Include="NUnit3TestAdapter" Version="5.1.0" />
  <PackageReference Include="Microsoft.Testing.Platform" Version="1.8.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.VSTestBridge" Version="1.8.1" />
</ItemGroup>
```

Hacen falta las dos fijaciones. Añadir solo `Microsoft.Testing.Platform` elimina el error pero deja una advertencia de conflicto MSB3277 sobre `Microsoft.Testing.Extensions.VSTestBridge`. Con ambas, la compilación queda limpia.

Los proyectos equivalentes de xUnit v3 y MSTest 4 no necesitan fijar nada, porque ambos frameworks controlan su dependencia de plataforma de principio a fin:

```xml
<!-- xunit.v3 3.2.2 on .NET SDK 10.0.201: this is the whole file -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="xunit.v3" Version="3.2.2" />
</ItemGroup>
```

Esa única `PackageReference` es la historia más limpia de las tres. El runner de NUnit es un puente sobre VSTest con abrigo de MTP, y se nota la costura. También se nota en la CLI: xUnit v3 usa su propio lenguaje de consulta con un solo guion (`-filter "/*/*/FailingTests/*"`), mientras que el runner de NUnit acepta sintaxis de VSTest (`--filter "FullyQualifiedName~FailingTests"`) y MSTest acepta consultas de grafo de MTP. Tres frameworks sobre una plataforma, tres dialectos de filtro.

## Dónde sigue ganando cada uno

**Elige xUnit v3 3.2.2 cuando** empiezas de cero en .NET 8 o posterior. El modelo de instancia por prueba elimina toda una categoría de errores dependientes del orden antes de que puedas escribirlos, el paralelismo está activo sin pedirlo, y la v3 trajo añadidos realmente útiles: `Assert.Skip`/`Assert.SkipWhen` para omitir en tiempo de ejecución, `MatrixTheoryData`, fixtures de ensamblado vía `[assembly: AssemblyFixture(...)]` y `[CaptureConsole]` para redirigir un `Console.WriteLine` perdido a la salida de la prueba.

**Elige NUnit 4.6.1 cuando** tu equipo ya piensa en restricciones. `Assert.That(items, Has.Exactly(1).EqualTo(2).And.Length.EqualTo(3))` compone de una forma que ninguno de los otros dos iguala, y `[TestCase]`, `[Values]` y `[Combinatorial]` cubren las pruebas parametrizadas de forma más completa que `[Theory]` o `[DataRow]`. También es el único de los tres que sigue soportando .NET 6, lo que importa si tienes algún proyecto rezagado. Reserva tiempo para la fijación de MTP de arriba y establece el ciclo de vida del fixture de forma explícita.

**Elige MSTest 4.3.3 cuando** ya tienes MSTest. La v4 es un release de verdad, no mantenimiento: `CallerArgumentExpression` en cada aserción, `Assert.ThrowsExactly`, `AssemblyFixtureProvider` para compartir la preparación de ensamblado entre proyectos (nuevo en 4.3.0) y el aislamiento por AppDomain ahora desactivado por defecto bajo MTP, que Microsoft midió como hasta un 30% más rápido. La migración desde la v3 no es gratis, ya que la v4 no es compatible a nivel binario y abandona de .NET Core 3.1 a .NET 7, pero los analizadores y las correcciones automáticas se encargan de casi todo el trabajo mecánico.

## Qué haría yo

Proyecto nuevo en 2026: xUnit v3. La configuración por defecto es la configuración correcta, que es justo la propiedad que quieres de un framework de pruebas, y el archivo de proyecto de un solo paquete es difícil de discutir.

Suite existente de NUnit o MSTest: quédate donde estás. La diferencia medida entre los tres, una vez activado el paralelismo, es de menos de 400 ms de sobrecarga de arranque en una suite de veinte pruebas. Eso no es presupuesto para una migración. Dedica la tarde a añadir `[assembly: Parallelizable(ParallelScope.Fixtures)]` (más `[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]`) o `[assembly: Parallelize(...)]`, y capturarás casi toda la ganancia disponible.

La elección de framework importa mucho menos en 2026 que en 2022, porque Microsoft.Testing.Platform ahora está debajo de los tres. El runner, los informes, la integración con CI y la CLI están convergiendo. Lo que queda por elegir es el modelo de ciclo de vida y el dialecto de aserciones, y esas son preferencias con una única consecuencia real de corrección: la instancia de fixture compartida de NUnit.

## Relacionado

- Si estás montando pruebas de ASP.NET Core, empieza por [pruebas de integración con `WebApplicationFactory<T>`](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/), que funciona igual en los tres frameworks.
- Para pruebas que necesitan una base de datos real en lugar de un doble, consulta [ejecutar pruebas de integración contra un SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Las pruebas dependientes del tiempo son la otra fuente habitual de inestabilidad: [probar con `TimeProvider` y `FakeTimeProvider`](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- Del lado de los informes, [Microsoft.Testing.Platform 2.3 pone los fallos en el diff del PR](/es/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) sin importar qué framework los produjo.
- Dos patrones de pruebas más que son independientes del framework: [probar código que usa `HttpClient`](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) y [simular `DbContext` sin romper el seguimiento de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

## Fuentes

- [What's New in xUnit.net v3](https://xunit.net/docs/getting-started/v3/whats-new) y [Microsoft Testing Platform support in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
- [Documentación de contexto compartido de xUnit.net](https://xunit.net/docs/shared-context) sobre el modelo de instancia por prueba
- [Documentación de `FixtureLifeCycle` de NUnit](https://docs.nunit.org/articles/nunit/writing-tests/attributes/fixturelifecycle.html)
- [NUnit y Microsoft.Testing.Platform](https://docs.nunit.org/articles/vs-test-adapter/NUnit-And-Microsoft-Test-Platform.html)
- [Migración de MSTest v3 a v4](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-migration-v3-v4) y [ciclo de vida de las pruebas de MSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-writing-tests-lifecycle)
- [Microsoft.Testing.Platform: ahora soportado por todos los principales frameworks de pruebas de .NET](https://devblogs.microsoft.com/dotnet/mtp-adoption-frameworks/)
- Versiones de paquetes desde NuGet: [xunit.v3 3.2.2](https://www.nuget.org/packages/xunit.v3), [NUnit 4.6.1](https://www.nuget.org/packages/NUnit), [MSTest 4.3.3](https://www.nuget.org/packages/MSTest)

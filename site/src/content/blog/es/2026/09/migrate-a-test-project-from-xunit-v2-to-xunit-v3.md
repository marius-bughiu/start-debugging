---
title: "Migrar un proyecto de pruebas de xUnit v2 a xUnit v3 (de 2.9.3 a 4.0.0)"
description: "Migración paso a paso de xunit 2.9.3 a xunit.v3 4.0.0: cambios de paquetes, el cambio de OutputType a Exe, IAsyncLifetime devolviendo ValueTask, la eliminación de Xunit.Abstractions y la sintaxis de filtros de CI que deja de coincidir en silencio."
pubDate: 2026-09-01
template: migration
tags:
  - "migration"
  - "xunit"
  - "xunit-v3"
  - "testing"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
lang: "es"
translationOf: "2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3"
translatedBy: "claude"
translationDate: 2026-09-01
---

Migrar un proyecto de pruebas normal de `xunit` 2.9.3 a `xunit.v3` 4.0.0 toma alrededor de una hora de trabajo mecánico: cambia cuatro referencias de paquetes, pon `OutputType` en `Exe`, elimina cada `using Xunit.Abstractions;` y cambia `IAsyncLifetime` de `Task` a `ValueTask`. Lo que de verdad se lleva el día es todo lo que rodea al proyecto de pruebas: un paquete de terceros sin compilación para v3 romperá la compilación con un error de `FactAttribute` duplicado, y tu expresión `dotnet test --filter` en CI dejará de coincidir con nada sin que la compilación falle. Vale la pena hacer la migración (v3 es la única línea que recibe funcionalidades desde que salió 2.9.3 en enero de 2025), y es reversible hasta el momento en que borres la rama antigua. Todo lo de abajo está verificado contra `xunit.v3` 4.0.0, publicado el 2026-08-15, sobre los SDK de .NET 10 y .NET 11.

## Por qué esto no es solo un cambio de versión

- **v2 está congelado en funcionalidades.** 2.9.3 (2025-01-08) es la última versión de v2. `TestContext`, los tiempos límite con cancelación real, los fixtures a nivel de ensamblado, el salto dinámico de pruebas y el lenguaje de consultas de filtro existen solo en v3.
- **Los proyectos de pruebas se convierten en ejecutables.** Un proyecto v3 tiene un punto de entrada generado y se ejecuta a sí mismo. Eso elimina por completo la clase de errores de desajuste entre versión del runner y versión del framework, y es lo que hace posibles las compilaciones de pruebas con Native AOT en 4.0.0.
- **`TestContext.Current.CancellationToken` hace reales los tiempos límite.** En v2, un `[Fact(Timeout = ...)]` sobre una prueba no asíncrona no podía interrumpir nada. En v3 el token fluye hacia tu código, así que una llamada HTTP colgada realmente se cancela.
- **Microsoft.Testing.Platform es opcional pero nativo.** El metapaquete `xunit.v3` 4.0.0 resuelve a `xunit.v3.mtp-v2`, que trae MTP v2 por ti. Obtienes `--report-trx`, salida CTRF y un arranque mucho más rápido sin un proceso host de VSTest.

## Qué se rompe

| Área | Cambio | Severidad |
| ---- | ------ | --------- |
| `xunit.abstractions` | El paquete y el espacio de nombres desaparecen. `ITestOutputHelper` se movió a `Xunit` | alta |
| Forma del proyecto | `OutputType` debe ser `Exe`; solo proyectos con formato SDK | alta |
| Framework de destino | El mínimo es `net472` o `net8.0`. `netcoreapp3.1` hasta `net7.0` quedan fuera | alta |
| `IAsyncLifetime` | Hereda de `IAsyncDisposable`; ambos métodos devuelven `ValueTask`, no `Task` | alta |
| Pruebas `async void` | Fallan de inmediato en tiempo de ejecución en lugar de ejecutarse | alta |
| Paquetes de terceros | Cualquier paquete que referencie `xunit.core` 2.x choca con `xunit.v3.core` | alta |
| Filtros de CI | Las expresiones `--filter` de VSTest no están soportadas bajo MTP | alta |
| `MemberDataAttribute` | `Parameters` se renombró a `Arguments`; `ConvertDataItem` ahora es `ConvertDataRow` | media |
| Atributos de ordenamiento / framework | `CollectionBehavior`, `TestCaseOrderer` y `TestFramework` toman `Type`, no cadenas | media |
| `AssemblyTraitAttribute` | Eliminado. Usa `[assembly: Trait(...)]` en su lugar | baja |
| `PropertyDataAttribute` | Eliminado (obsoleto desde v1) | baja |
| Liberación de recursos | Cuando un fixture implementa `IDisposable` e `IAsyncDisposable`, solo se llama a `DisposeAsync` | media |

Las dos filas que hay que planificar son la de terceros y la de CI. De todo lo demás te avisa el compilador.

## Lista de verificación previa

- **SDK de .NET 8 o posterior instalado.** `xunit.v3` 4.0.0 apunta a `net472` y `net8.0`; no hay superficie `netstandard2.0` para el paquete principal.
- **Todos los proyectos de pruebas tienen formato SDK.** Los archivos `.csproj` anteriores al formato SDK no están soportados en absoluto. Conviértelos primero, en una confirmación aparte.
- **Inventaría tus paquetes relacionados con xUnit.** Ejecuta `dotnet list package --include-transitive | grep -i xunit` en cada proyecto de pruebas y anota la lista. Esa lista decide si la migración toma una hora o una semana.
- **Sabe qué runner usa tu CI.** Busca en tu pipeline `dotnet test`, `--filter`, `--logger` y `vstest.console.exe`.
- **Crea una rama.** Migra primero un proyecto de pruebas, hasta pasar por CI, antes de tocar el resto.

## Pasos de la migración

1. **Cambia el framework de destino del proyecto de pruebas y conviértelo en ejecutable.**

   Sube `TargetFramework` a `net8.0` o posterior y define `OutputType`. El punto de entrada generado viene del paquete; no escribes un `Main`.

   ```xml
   <!-- MyApp.Tests.csproj, .NET 10 SDK, xunit.v3 4.0.0 -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <OutputType>Exe</OutputType>
     <Nullable>enable</Nullable>
     <ImplicitUsings>enable</ImplicitUsings>
   </PropertyGroup>
   ```

   Verifica: `dotnet build` falla por tipos de xUnit faltantes, no por errores de forma del proyecto. Si ya tienes instrucciones de nivel superior en el proyecto de pruebas, define `<XunitAutoGeneratedEntryPoint>false</XunitAutoGeneratedEntryPoint>` y hazte cargo del punto de entrada tú mismo.

2. **Cambia las referencias de paquetes.**

   La correspondencia de v2 a v3 es uno a uno, salvo que `xunit.abstractions` desaparece y `xunit.console` no tiene sucesor.

   ```xml
   <!-- before: xunit 2.9.3 -->
   <ItemGroup>
     <PackageReference Include="xunit" Version="2.9.3" />
     <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>

   <!-- after: xunit.v3 4.0.0 -->
   <ItemGroup>
     <PackageReference Include="xunit.v3" Version="4.0.0" />
     <PackageReference Include="xunit.runner.visualstudio" Version="4.0.0" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>
   ```

   `xunit.v3` 4.0.0 resuelve a `xunit.v3.mtp-v2`, que trae `xunit.v3.core.mtp-v2`, `xunit.v3.assert` y `xunit.analyzers` 2.0.0. Conserva `xunit.runner.visualstudio` 4.0.0 y `Microsoft.NET.Test.Sdk` por ahora: el paquete del runner maneja v1, v2 y v3, así que el Explorador de pruebas y VSTest siguen funcionando mientras migras el resto de la solución. Si usas Central Package Management, haz esto en `Directory.Packages.props`, que es justamente el punto de [mover una solución a Directory.Packages.props](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).

   Verifica: `dotnet restore` termina sin advertencias NU1605 de degradación y sin errores de tipos duplicados.

3. **Elimina cada `using Xunit.Abstractions;`.**

   `ITestOutputHelper` ahora vive en `Xunit`, junto a `Fact` y `Assert`, así que en la mayoría de los archivos la corrección es borrar una línea.

   ```csharp
   // xunit.v3 4.0.0 - no Xunit.Abstractions anywhere
   using Xunit;

   public class OrderServiceTests(ITestOutputHelper output)
   {
       [Fact]
       public void Prices_include_tax()
       {
           output.WriteLine("running");   // v3 also adds Write(), not just WriteLine()
           Assert.Equal(120m, new OrderService().Total(100m));
       }
   }
   ```

   Verifica: `grep -rn "Xunit.Abstractions" .` no devuelve nada dentro de tus proyectos de pruebas.

4. **Convierte las implementaciones de `IAsyncLifetime` a `ValueTask`.**

   Este es el cambio que la gente hace mal, porque el error del compilador apunta al tipo de retorno y esconde detrás la semántica de liberación de recursos. `IAsyncLifetime` ahora hereda de `IAsyncDisposable`, y ambos miembros devuelven `ValueTask`.

   ```csharp
   // v2: xunit 2.9.3
   public class DbFixture : IAsyncLifetime
   {
       public Task InitializeAsync() => _container.StartAsync();
       public Task DisposeAsync()    => _container.DisposeAsync().AsTask();
   }

   // v3: xunit.v3 4.0.0
   public class DbFixture : IAsyncLifetime
   {
       public ValueTask InitializeAsync() => new(_container.StartAsync());
       public ValueTask DisposeAsync()    => _container.DisposeAsync();
   }
   ```

   La trampa: si tu fixture implementa `IDisposable` **e** `IAsyncLifetime`, v2 llamaba a `Dispose()` y v3 no lo hace. Solo llama a `DisposeAsync()`, siguiendo la guía de .NET de invocar uno u otro. Cualquier limpieza que viviera exclusivamente en `Dispose()` deja de ejecutarse en silencio, lo que suele aparecer como un contenedor de Testcontainers filtrado o un directorio temporal sin borrar, no como una prueba fallida. Mueve esa limpieza a `DisposeAsync()`. Esto importa sobre todo para el patrón de un contenedor por fixture de las [pruebas de integración contra SQL Server real con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).

   Verifica: ejecuta la suite y confirma que no quedan contenedores huérfanos con `docker ps -a`.

5. **Corrige las pruebas `async void` y los renombrados mecánicos de atributos.**

   v3 hace fallar de inmediato las pruebas `async void` en tiempo de ejecución en vez de ejecutarlas sin esperar el resultado, así que cambia la firma a `async Task`. Es el mismo razonamiento expuesto en [async void vs async Task en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), solo que ahora el framework lo obliga. Después aplica las conversiones de atributos de cadena a `Type`:

   ```csharp
   // v2
   [assembly: CollectionBehavior("MyTests.MyCollectionFactory", "MyTests")]
   [assembly: AssemblyTrait("Category", "Integration")]

   // v3, xunit.v3 4.0.0
   [assembly: CollectionBehavior(typeof(MyCollectionFactory))]
   [assembly: Trait("Category", "Integration")]
   ```

   `TestCaseOrdererAttribute`, `TestCollectionOrdererAttribute` y `TestFrameworkAttribute` reciben el mismo tratamiento. `MemberDataAttribute.Parameters` ahora es `Arguments`, y si creaste una subclase de `MemberDataAttributeBase`, `ConvertDataItem` pasó a llamarse `ConvertDataRow` y devuelve `ITheoryDataRow` en lugar de `object[]`.

   Verifica: `dotnet build` sale limpio salvo por advertencias `xUnit1051`, que son el tema del siguiente paso.

6. **Haz fluir `TestContext.Current.CancellationToken` por tus `await`.**

   `xunit.analyzers` 2.0.0 emite `xUnit1051` en cada llamada que acepta un `CancellationToken` y no recibe ninguno. Es una advertencia, no un error, y puedes migrar sin tocarlo, pero el token es la mayor parte de la razón para estar en v3.

   ```csharp
   // xunit.v3 4.0.0 - the token cancels when the test times out or the run is aborted
   [Fact(Timeout = 5000)]
   public async Task Fetches_the_order()
   {
       var ct = TestContext.Current.CancellationToken;
       var response = await _client.GetAsync("/orders/1", ct);
       Assert.Equal(HttpStatusCode.OK, response.StatusCode);
   }
   ```

   Verifica: `dotnet build -warnaserror:xUnit1051` pasa una vez que termines, o déjalo como advertencia y vuelve después.

7. **Apunta tu CI a la nueva sintaxis de filtros.**

   Luego decide si habilitas Microsoft.Testing.Platform. Bajo MTP, xUnit no acepta el lenguaje de expresiones `--filter` de VSTest; expone `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, sus equivalentes `--filter-not-*` y `--filter-query`. En los SDK de .NET 8 y 9 lo habilitas por proyecto:

   ```xml
   <!-- .NET 8/9 SDK -->
   <PropertyGroup>
     <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   </PropertyGroup>
   ```

   En el SDK de .NET 10 y posteriores lo habilitas una sola vez para todo el repositorio:

   ```json
   // global.json
   {
     "test": { "runner": "Microsoft.Testing.Platform" }
   }
   ```

   Y el filtro en sí cambia de forma:

   ```bash
   # before, VSTest
   dotnet test --filter "Category!=Integration"

   # after, MTP with xunit.v3 4.0.0
   dotnet test -- --filter-not-trait "Category=Integration"
   ```

   Verifica: ejecuta el comando filtrado y confirma que el número de pruebas reportadas es menor que el total sin filtro. No confíes en una compilación en verde aquí, porque un filtro que no coincide con nada sale con código cero.

## Verifica la migración

Ejecuta esto en orden, y trata cualquier sorpresa en el conteo de pruebas como un fallo aunque el código de salida sea cero.

- `dotnet build -c Release` sin advertencias más allá de las que ya clasificaste.
- `dotnet run --project MyApp.Tests -- --list` para confirmar que el descubrimiento encuentra la cantidad de pruebas que esperas.
- `dotnet test` y compara el total contra la última ejecución en v2. Una caída casi siempre significa un filtro o una prueba `async void` omitida.
- Abre el Explorador de pruebas una vez. Si las pruebas corren desde la línea de comandos pero Visual Studio se cuelga, eso es el [bloqueo del Explorador de pruebas en proyectos xUnit v3](/es/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/), no una mala migración.
- Revisa tus números de cobertura. Coverlet se acopla de forma distinta bajo MTP, y un informe de cobertura que de pronto marca 0 % es un problema de cableado, no una regresión.

## Reversión

Esta migración es totalmente reversible: son referencias de paquetes más ediciones de código fuente, sin estado en disco ni esquema de base de datos. Un `git revert` de la confirmación devuelve la suite v2 a funcionar, siempre que no hayas bajado también el framework de destino por debajo de `net8.0` en esa misma confirmación. Mantén el cambio de framework aparte precisamente por eso. La parte irreversible es cualquier fork de terceros que hayas tenido que publicar (ver abajo), que sigue siendo útil de todas formas.

## Detalles que conviene conocer antes de empezar

**El error de `FactAttribute` duplicado.** Si algún paquete del grafo todavía referencia `xunit.core` 2.x, obtienes:

```
error CS0433: The type 'FactAttribute' exists in both
'xunit.core, Version=2.4.2.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c' and
'xunit.v3.core, Version=4.0.0.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c'
```

No hay ningún truco de alias que valga la pena intentar. O el paquete tiene una compilación para v3 o no la tiene. A septiembre de 2026: `Verify.XunitV3` 32.0.0, `AutoFixture.Xunit3` 4.19.0, `Xunit.DependencyInjection` 12.0.1 y `MartinCostello.Logging.XUnit.v3` 0.7.1 referencian todos `xunit.v3.*` 4.x. `Serilog.Sinks.XUnit` 3.0.19 sigue arrastrando `xunit.abstractions` 2.0.3 y `xunit.extensibility.core` 2.9.2, así que es un bloqueo duro; la solución habitual es un pequeño sink dentro del repositorio que escriba directamente en `ITestOutputHelper`, unas treinta líneas.

**`Xunit.SkippableFact` ahora sobra.** Elimínalo. v3 tiene `Assert.Skip(reason)`, `Assert.SkipWhen(condition, reason)` y `Assert.SkipUnless(condition, reason)`, además de las propiedades `SkipWhen` y `SkipUnless` en `[Fact]` y `[Theory]` que apuntan a una propiedad pública estática `bool` de la clase de pruebas. Poner `SkipWhen` y `SkipUnless` a la vez en un mismo atributo es un fallo en tiempo de ejecución, no un error de compilación.

**Las instancias de atributos se almacenan en caché en v3.** v2 creaba una instancia nueva por consulta; v3 la guarda en caché, igual que el comportamiento normal de reflexión de .NET. Los atributos personalizados que mutaban su propio estado entre el descubrimiento y la ejecución se comportarán de otra manera.

**Fijar versiones en toda la solución.** `xunit.v3` 4.0.0 fija `xunit.v3.mtp-v2` a un rango exacto `[4.0.0, 4.0.0]`, así que las versiones mezcladas entre proyectos aparecen como conflictos de restauración en vez de rarezas en tiempo de ejecución. Eso es una ventaja, pero significa que actualizas todos los proyectos de pruebas en una sola confirmación o ninguno.

**Las implementaciones personalizadas de `ITestCaseOrderer` cambiaron en 4.0.0**, no solo entre v2 y v3. El ordenamiento ahora corre por colección, luego clase, luego método y luego caso, y hay puntos de extensión separados para ordenar clases y métodos. Si arrastraste un orderer de v2 sin cambios a través de v3.2.2, 4.0.0 es donde deja de compilar.

**`WebApplicationFactory<T>` no necesita cambios.** Las pruebas de integración de ASP.NET Core migran sin fricción; el patrón de fixture de [pruebas de integración con WebApplicationFactory](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) funciona tal cual una vez que `IAsyncLifetime` devuelve `ValueTask`.

## Relacionado

- [xUnit v3 vs NUnit vs MSTest en 2026: cuál deberías elegir](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [Fix: el Explorador de pruebas de Visual Studio se cuelga en un proyecto xUnit v3 mientras dotnet test pasa](/es/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)
- [Microsoft.Testing.Platform 2.3 pone los fallos de pruebas en el diff del PR](/es/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [Cómo escribir pruebas de integración con WebApplicationFactory en ASP.NET Core 11](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Migrar una solución .NET a Central Package Management con Directory.Packages.props](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Fuentes

- [Migrating Unit Tests from v2 to v3](https://xunit.net/docs/getting-started/v3/migration) -- xUnit.net
- [What's New in v3?](https://xunit.net/docs/getting-started/v3/whats-new) -- xUnit.net
- [Microsoft Testing Platform (xUnit.net v3)](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform) -- xUnit.net
- [Notas de la versión xUnit.net v3 4.0.0](https://xunit.net/releases/v3/4.0.0) -- xUnit.net
- [Guía de migración de VSTest a Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) -- Microsoft Learn
- [xunit.v3 en NuGet](https://www.nuget.org/packages/xunit.v3/4.0.0) -- metadatos del paquete y rangos de dependencias
- [Migrating from XUnit v2 to v3: troubleshooting](https://bartwullems.blogspot.com/2025/09/migrating-from-xunit-v2-to.html) -- Bart Wullems

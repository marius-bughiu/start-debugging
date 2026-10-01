---
title: "Solución: dotnet test termina con código 5 y \"Zero tests ran\" en Microsoft.Testing.Platform"
description: "El código de salida 5 significa que MTP rechazó una opción de línea de comandos, no que falten pruebas. Ejecuta el exe de pruebas directamente para ver el error real y luego agrega el paquete de la extensión o enruta la opción por proyecto."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "testing"
  - "microsoft-testing-platform"
  - "dotnet-10"
lang: "es"
translationOf: "2026/10/fix-dotnet-test-exit-code-5-zero-tests-ran-microsoft-testing-platform"
translatedBy: "claude"
translationDate: 2026-10-01
---

Si `dotnet test` imprime `Zero tests ran` seguido de `Exit code: 5`, tus pruebas nunca se descubrieron porque la aplicación de pruebas rechazó uno de los argumentos que le pasaste. En Microsoft.Testing.Platform (MTP), el código de salida 5 significa "argumentos de línea de comandos no válidos", y `dotnet test` descarta la explicación. Ejecuta el ejecutable de pruebas compilado con los mismos argumentos (`./bin/Debug/net10.0/MyTests --logger trx`) para ver el mensaje real. Luego puedes referenciar el paquete de extensión que provee la opción, reemplazar la bandera de la era VSTest por su equivalente de MTP, o enrutar la opción solo a los proyectos que la entienden con `TestingPlatformCommandLineArguments`.

Todo lo que sigue se midió con el SDK de .NET 10 10.0.302 y el SDK de .NET 11 RC 1 (11.0.100-rc.1.26425.128) en macOS arm64, con MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1), MSTest.Sdk 4.3.3 (MTP 2.3.3) y xunit.v3.mtp-v2 4.0.1, usando un `global.json` que cambia `dotnet test` al modo MTP.

## El error en contexto

Esta es la salida completa de `dotnet test --project MsTests --logger trx` en el SDK 10.0.302 contra un proyecto MSTest con dos pruebas perfectamente válidas:

```text
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0) Zero tests ran
Exit code: 5

Test run summary: Zero tests ran
  error: 1

  total: 0
  failed: 0
  succeeded: 0
  skipped: 0
  duration: 82ms
Test run completed with non-success exit code: 5 (see: https://aka.ms/testingplatform/exitcodes)
```

Fíjate en lo que falta: el target framework aparece como `(net10.0)` en lugar de `(net10.0|arm64)` y no hay ninguna línea `Running tests from ...`. El host de pruebas nunca llegó al descubrimiento de pruebas. Agregar `--output Detailed`, `-v detailed` o `--diagnostic` no devuelve el motivo, y el archivo `.diag` que escribe `--diagnostic` solo registra la línea de comandos sin procesar.

En el SDK de .NET 11 RC 1 la línea de resumen cambia a `Test run summary: Failed!` y una nueva sección `Handshake failures:` lista el módulo, pero el motivo sigue sin imprimirse.

En una solución con varios proyectos de pruebas es más fácil malinterpretarlo, porque un proyecto falla y el otro pasa:

```text
XTests/bin/Debug/net10.0/XTests.dll (net10.0) Zero tests ran
Exit code: 5
MsTests/bin/Debug/net10.0/MsTests.dll (net10.0|arm64) passed (848ms)
Test run summary: Failed!
  error: 1
  total: 2
```

## Por qué MTP devuelve el código de salida 5 y dice que se ejecutaron cero pruebas

Un proyecto de pruebas MTP es un ejecutable de consola normal. `dotnet test` en modo MTP compila cada proyecto de pruebas, lanza el ejecutable, reenvía todos los argumentos que él mismo no consume y se comunica con el proceso a través de una canalización con nombre. La aplicación de pruebas valida su línea de comandos antes de hacer cualquier otra cosa. Si alguna opción es desconocida, o una opción conocida recibe un valor no válido, termina con el código 5 sin descubrir una sola prueba. La [tabla de códigos de salida de MTP](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting#exit-codes) define el 5 como "los argumentos de línea de comandos pasados a la aplicación de pruebas no eran válidos".

Luego `dotnet test` reporta el módulo igual que cualquier módulo que no produjo resultados: `Zero tests ran`. El texto es técnicamente cierto y totalmente engañoso, porque te manda a buscar atributos `[TestMethod]` faltantes o un filtro roto.

Las opciones se vuelven desconocidas por cuatro razones, en el orden en que las veo en pipelines reales:

1. **Una bandera de VSTest sobrevivió a la migración.** `--logger trx`, `--collect "XPlat Code Coverage"`, `--blame-hang-timeout 5m` y `--blame-crash` pertenecen a VSTest. MTP no tiene `--logger` ni `--collect` en absoluto.
2. **Falta el paquete de la extensión.** El núcleo de MTP no incluye reporteros, cobertura, volcados ni reintentos. `--report-trx` solo existe cuando se referencia `Microsoft.Testing.Extensions.TrxReport`, `--coverage` necesita `Microsoft.Testing.Extensions.CodeCoverage`, y así sucesivamente.
3. **Frameworks mezclados en una solución.** MSTest.Sdk habilita TRX y cobertura de código por defecto. Un proyecto xUnit v3 simple no. La misma línea de comandos `dotnet test --solution` es válida para un proyecto y no válida para el otro.
4. **Un valor incorrecto para una opción válida.** `--settings` apuntando a un archivo que no existe en el agente, o `--timeout 30` sin sufijo de unidad.

El código de salida 8 es un fallo distinto que produce el mismo texto `Zero tests ran`. En ese caso los argumentos eran correctos y la aplicación de pruebas ejecutó el descubrimiento, pero nada coincidió. Puedes distinguirlos por la línea `Exit code:` y por si aparece o no `Running tests from ...`.

## Reproducción mínima

El `global.json` activa el modo MTP en `dotnet test` (necesario en el SDK de .NET 10 y posteriores; sin él sigues en el puente de VSTest):

```json
// .NET 10 SDK 10.0.302
{
  "sdk": { "version": "10.0.302" },
  "test": { "runner": "Microsoft.Testing.Platform" }
}
```

Un proyecto MSTest que usa el SDK de MSTest:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 (Microsoft.Testing.Platform 2.4.1) -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MsTests/Tests.cs, .NET 10, MSTest 4.4.1
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace MsTests;

[TestClass]
public class CalculatorTests
{
    [TestMethod]
    public void Adds() => Assert.AreEqual(4, 2 + 2);

    [TestMethod, TestCategory("Slow")]
    public void Multiplies() => Assert.AreEqual(6, 2 * 3);
}
```

Y un proyecto xUnit v3 a su lado:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  </ItemGroup>
</Project>
```

Esto es lo que devolvió cada comando en el SDK 10.0.302:

| Comando | Código de salida | Qué decía el resumen |
| --- | --- | --- |
| `dotnet test --project MsTests` | 0 | Passed, 2 pruebas |
| `dotnet test --project MsTests --logger trx` | 5 | Zero tests ran |
| `dotnet test --project MsTests --collect "XPlat Code Coverage"` | 5 | Zero tests ran |
| `dotnet test --project MsTests --blame-hang-timeout 5m` | 5 | Zero tests ran |
| `dotnet test --project MsTests --report-trx` | 0 | Passed, TRX escrito |
| `dotnet test --solution All.sln --report-trx` | 5 | MSTest pasó, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --coverage` | 5 | MSTest pasó, xUnit "Zero tests ran" |
| `dotnet test --solution All.sln --settings x.runsettings` (archivo inexistente) | 5 | ambos "Zero tests ran" |
| `dotnet test --project MsTests --filter "TestCategory=DoesNotExist"` | 8 | Zero tests ran (uno real) |
| `dotnet test --project MsTests --minimum-expected-tests 5` | 9 | Minimum expected tests policy violation |

## La solución, en detalle

### 1. Obtén el mensaje de error real de la aplicación de pruebas

Ejecuta tú mismo el ejecutable compilado con los argumentos exactos que pasa CI. En Windows es `MsTests.exe`; en Linux y macOS no tiene extensión:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1
./MsTests/bin/Debug/net10.0/MsTests --logger trx
```

```text
Unknown option '--logger'
Option '--logger' uses VSTest syntax, which is not supported by Microsoft.Testing.Platform.
Use '--report-trx' instead.
Run '--help' to see the options registered by this test application. If the option belongs to an extension, ensure its package is referenced and the extension is registered.
Command line: --logger trx
```

`dotnet run --project MsTests --no-build -- --logger trx` imprime lo mismo y también devuelve 5. La pista "uses VSTest syntax ... Use '--report-trx' instead" es nueva en MTP 2.4. MTP 2.3.3 (MSTest.Sdk 4.3.3) imprime solo `Unknown option '--logger'` seguido del texto de ayuda, lo cual sigue siendo suficiente.

Después, pregunta a la aplicación qué opciones tiene realmente. `--help` lista las opciones de la plataforma y, por separado, las "Extension options" aportadas por los paquetes referenciados. `--info` imprime la versión de la plataforma y cada extensión registrada con su propia versión:

```bash
# .NET 10 SDK 10.0.302
./XTests/bin/Debug/net10.0/XTests --help
./XTests/bin/Debug/net10.0/XTests --info
```

Si la opción que estás pasando no está en esa lista, fallará con el código de salida 5. Esa sola comprobación resuelve la mayoría de estos tickets.

### 2. Reemplaza las banderas de VSTest por sus equivalentes de MTP

| Argumento de VSTest | Argumento de MTP | Paquete que lo provee |
| --- | --- | --- |
| `--logger trx` | `--report-trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--logger trx;LogFileName=x.trx` | `--report-trx --report-trx-filename x.trx` | `Microsoft.Testing.Extensions.TrxReport` |
| `--collect "Code Coverage"` | `--coverage` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--collect "XPlat Code Coverage"` | `--coverage --coverage-output-format cobertura` | `Microsoft.Testing.Extensions.CodeCoverage` |
| `--blame-hang-timeout 5m` | `--hangdump --hangdump-timeout 5m` | `Microsoft.Testing.Extensions.HangDump` |
| `--blame-crash` | `--crashdump` | `Microsoft.Testing.Extensions.CrashDump` |
| `--results-directory` | `--results-directory` | incluido de fábrica |

Al momento de escribir esto, las versiones actuales son 2.4.1 para TrxReport, HangDump y CrashDump, y 18.11.2 para CodeCoverage. La [referencia de opciones de la CLI de MTP](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options) tiene la correspondencia completa. `--filter` conserva su sintaxis de expresiones de VSTest para MSTest y NUnit, así que normalmente no necesita cambios.

### 3. Referencia la extensión en cada proyecto que reciba la opción

En la reproducción, el `--report-trx` a nivel de solución falló solo porque el proyecto xUnit no tenía el reportero. Agregarlo arregló la ejecución:

```xml
<!-- XTests/XTests.csproj, xunit.v3.mtp-v2 4.0.1 -->
<ItemGroup>
  <PackageReference Include="xunit.v3.mtp-v2" Version="4.0.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.4.1" />
</ItemGroup>
```

```text
MsTests.dll (net10.0|arm64) passed (837ms)
XTests.dll (net10.0|arm64) passed (922ms)
Test run summary: Passed!
  total: 4
```

Si todos los proyectos de pruebas deben producir TRX y cobertura, pon las referencias en un `Directory.Build.props` condicionado a `IsTestProject` para que los proyectos nuevos las incorporen automáticamente. Los proyectos MSTest.Sdk ya las incluyen, así que agrega la condición `'$(UsingMSTestSdk)' != 'true'` si quieres evitar referencias duplicadas.

### 4. Enruta las opciones por proyecto con TestingPlatformCommandLineArguments

A veces no quieres la extensión en todas partes. La cobertura de un proyecto de pruebas de integración suele ser ruido, y los volcados solo sirven para el proyecto que se cuelga. En lugar de pasar la opción en la línea de comandos de `dotnet test`, ponla en el proyecto que la entiende:

```xml
<!-- MsTests/MsTests.csproj, MSTest.Sdk 4.4.1 -->
<Project Sdk="MSTest.Sdk/4.4.1">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <TestingPlatformCommandLineArguments>$(TestingPlatformCommandLineArguments) --coverage --coverage-output-format cobertura</TestingPlatformCommandLineArguments>
  </PropertyGroup>
</Project>
```

Con eso en su lugar, un simple `dotnet test --solution All.sln` devolvió el código de salida 0, el proyecto xUnit se ejecutó sin cobertura y el proyecto MSTest escribió un `.cobertura.xml` en `TestResults`. Microsoft documenta el mismo enfoque para [soluciones con frameworks de pruebas o extensiones mixtos](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions). Mantén `$(TestingPlatformCommandLineArguments)` al inicio para que los valores de `Directory.Build.props` no se sobrescriban.

### 5. Valida los valores, no solo los nombres

Si la opción aparece en `--help` y aun así obtienes el código de salida 5, el valor es incorrecto. En la reproducción, `--settings x.runsettings` con un archivo inexistente hizo fallar ambos proyectos con el código de salida 5. Las rutas se resuelven desde el directorio de trabajo del proceso de pruebas, que en CI no siempre es la raíz del repositorio. Los valores de tiempo necesitan unidades en MTP: `--timeout 30m` funciona, un número solo no.

## Código de salida 8: cuando realmente se ejecutaron cero pruebas

Si el código de salida es 8, los argumentos fueron aceptados y el filtro o el proyecto simplemente no produjeron pruebas. MTP lo trata como un fallo por defecto, a diferencia de VSTest, que devolvía 0. Tienes tres opciones:

```bash
# .NET 10 SDK 10.0.302, MTP 2.4.1

# Accept an empty run for this invocation (returns 0)
dotnet test --project MsTests --filter "TestCategory=Nightly" --ignore-exit-code 8

# Or demand a floor: fewer than 50 tests returns exit code 9
dotnet test --solution All.sln --minimum-expected-tests 50
```

`--ignore-exit-code` también lee de la variable de entorno `TESTINGPLATFORM_EXITCODE_IGNORE`, útil cuando el mismo filtro se ejecuta en muchos pipelines. Úsalo con moderación: un filtro que no coincide silenciosamente con nada es exactamente el error que el código de salida 8 fue diseñado para detectar.

La versión del SDK importa en las ejecuciones con varios proyectos. En el SDK 10.0.302, una ejecución de solución donde un proyecto coincidía con el filtro y el otro con nada devolvió 8 para toda la ejecución. En el SDK de .NET 11 RC 1 el mismo comando devolvió 0 con `Test run summary: Passed!`, aunque seguía imprimiendo `Exit code: 8` junto al módulo vacío. Ese es el nuevo [veredicto de cero pruebas para toda la ejecución](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp) del SDK de .NET 11. Si tu CI se pone en rojo con .NET 10 y en verde con .NET 11 con el mismo filtro, esta es la razón. El código de salida 5 no cambió: ambos SDK hacen fallar toda la ejecución cuando cualquier módulo rechaza sus argumentos.

## Detalles a tener en cuenta y casos parecidos

- **`error: 1` en el resumen es el módulo, no una prueba.** Cuenta los módulos que terminaron de forma anómala. `failed: 0` se queda en cero porque no se ejecutó ninguna prueba.
- **`dotnet test -- --some-option` no ayuda.** En modo MTP los argumentos se reenvían de cualquier forma, así que el doble guion no los oculta de la aplicación de pruebas.
- **Un filtro de MTP que no coincide con nada devuelve 8, no 5.** Si ves `Running tests from ...` antes de `Zero tests ran`, tus argumentos estaban bien. Revisa la sintaxis del filtro para el framework.
- **`--zero-tests-policy strict` no cambió mi ejecución con todo omitido.** La documentación dice que strict trata las pruebas omitidas como no ejecutadas. En MTP 2.4.1, un proyecto cuya única prueba tenía `[Ignore]` aun así devolvió 0 bajo strict, así que no lo uses como tu única protección. `--minimum-expected-tests` es explícito y confiable.
- **"No test projects were found" es un problema distinto.** Ese viene de la evaluación del proyecto (típicamente `--no-restore` en una etapa de contenedor sin la carpeta `obj`), no de la aplicación de pruebas. La página de solución de problemas de MTP lo cubre.
- **Test Explorer puede mostrar su propia versión de esto.** Si la CLI está en verde y Visual Studio se cuelga con xUnit v3, es un desajuste del ejecutor, no un problema de argumentos.

## Relacionado

- La [migración paso a paso de VSTest a Microsoft.Testing.Platform](/es/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) cubre el resto de los cambios de CI, incluido `.runsettings` a `testconfig.json`.
- Si Visual Studio se cuelga mientras la CLI pasa, consulta [Test Explorer colgado con xUnit v3 mientras dotnet test pasa](/es/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).
- Elegir un framework para una solución nueva, comparando el soporte de MTP: [xUnit v3 vs NUnit vs MSTest en 2026](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- Mover primero un proyecto xUnit antiguo a MTP: [migrar un proyecto de pruebas de xUnit v2 a xUnit v3](/es/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).
- Obtener fallos anotados directamente en los pull requests: [anotaciones de GitHub Actions en Microsoft.Testing.Platform 2.3](/es/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/).

## Fuentes

- [Solución de problemas de Microsoft.Testing.Platform: códigos de salida y opciones de extensión no reconocidas](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-troubleshooting)
- [Referencia de opciones de la CLI de Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-cli-options)
- [Pruebas con dotnet test: soluciones con frameworks de pruebas o extensiones mixtos](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test#solutions-with-mixed-test-frameworks-or-extensions)
- [dotnet test en modo MTP, incluidos los mínimos para toda la ejecución](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-mtp)
- [Repositorio microsoft/testfx (MSTest y Microsoft.Testing.Platform)](https://github.com/microsoft/testfx)

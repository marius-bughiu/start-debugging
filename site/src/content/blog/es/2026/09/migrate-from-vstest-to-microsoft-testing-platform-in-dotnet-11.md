---
title: "Migrar de VSTest a Microsoft.Testing.Platform en el SDK de .NET 11"
description: "Una migración paso a paso de VSTest a Microsoft.Testing.Platform 2.3.3: el opt-in de OutputType Exe, el cambio de runner en global.json, los loggers convertidos en reporters, .runsettings reemplazado por testconfig.json y los códigos de salida que ponen en rojo un job de CI que estaba en verde."
pubDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "vstest"
  - "microsoft-testing-platform"
  - "testing"
  - "dotnet-11"
  - "dotnet"
  - "ci-cd"
lang: "es"
translationOf: "2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-02
---

Mover una solución de VSTest a Microsoft.Testing.Platform (MTP) es medio día de trabajo para los archivos de proyecto y un día completo para CI. La parte del proyecto son tres líneas por cada proyecto de pruebas: `<OutputType>Exe</OutputType>`, una propiedad de opt-in para tu framework de pruebas y un `global.json` que define `"runner": "Microsoft.Testing.Platform"`. Lo que realmente cuesta tiempo es todo lo que viene después: cada flag `--logger`, `--collect` y `--blame` de tu pipeline se traduce a una opción distinta que solo existe si además agregas un paquete NuGet, tu archivo `.runsettings` pierde casi todo su sentido, y un proyecto de pruebas que ejecuta cero pruebas ahora falla la compilación con el código de salida 8 en lugar de pasar. Esta guía está escrita contra el SDK de .NET 11 (Preview 7, agosto de 2026), Microsoft.Testing.Platform 2.3.3, MSTest 4.3.3, NUnit3TestAdapter 6.3.0 y xunit.v3 4.0.0.

## Por qué conviene hacer el cambio ahora

- **Es hacia donde va todo.** MSTest tiene su propio runner de MTP desde 3.2.0, NUnit desde NUnit3TestAdapter 5.0.0, y xUnit v3 se construyó sobre MTP desde el principio. VSTest está en mantenimiento: el cambio más visible que recibió este año fue [eliminar su dependencia de Newtonsoft.Json](/es/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/).
- **Los módulos de prueba corren en paralelo por defecto.** VSTest serializa los ensamblados salvo que pelees con él. MTP ejecuta hasta `Environment.ProcessorCount` módulos de prueba en simultáneo, con tope en `--max-parallel-test-modules`.
- **Sin runner externo.** El proyecto de pruebas es un ejecutable. `./MyApp.Tests` corre la suite sin `vstest.console.exe`, sin `dotnet test` y sin una pasada de descubrimiento de adaptadores. Eso importa para las imágenes de contenedor y para reproducir localmente una falla de CI.
- **Políticas a nivel de ejecución que antes había que programar.** `--timeout`, `--maximum-failed-tests`, `--minimum-expected-tests` e `--ignore-exit-code` son de primera clase, y las últimas tres existen precisamente porque CI las necesita.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| Forma del proyecto | Los proyectos de pruebas deben definir `<OutputType>Exe</OutputType>` | alta |
| Consistencia de la solución | Con MTP habilitado en `global.json`, **todos** los proyectos de pruebas deben usar MTP. Una solución mixta es un error, no una advertencia | alta |
| `--logger` | Renombrado a "reporters". `--logger trx` pasa a ser `--report-trx` y requiere `Microsoft.Testing.Extensions.TrxReport` | alta |
| `--collect "Code Coverage"` | Pasa a ser `--coverage`, requiere `Microsoft.Testing.Extensions.CodeCoverage`, y `IncludeTestAssembly` ahora tiene valor por defecto `false` | alta |
| `--blame-crash` / `--blame-hang` | Pasan a ser `--crashdump` / `--hangdump` desde paquetes separados. `--blame-crash-collect-always` no tiene equivalente | media |
| Cero pruebas ejecutadas | VSTest devuelve 0. MTP devuelve el código de salida 8 | alta |
| `.runsettings` | Solo se soporta mediante los puentes VSTest de MSTest y NUnit. La plataforma en sí lee `testconfig.json` | media |
| `dotnet test MyTests.csproj` | Las rutas de proyecto posicionales desaparecieron. Usa `--project`, `--solution` o `--test-modules` | media |
| Filtros de xUnit | `--filter` no está implementado. Usa `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, `--filter-query` | alta (solo xUnit) |
| `RunConfiguration.TargetPlatform=x86` | Pasa a ser `--arch x86` | baja |
| Codificación de consola | MTP siempre fija UTF-8. El modo de aislamiento por defecto de VSTest no lo hacía | baja |

Las dos filas que definen tu cronograma son la de consistencia de la solución y la de `--logger`. Del resto te avisa la herramienta.

## Lista de verificación previa

- **SDK de .NET 10 o posterior.** La selección de runner llegó con el SDK de .NET 10. En .NET 9 y anteriores quedas atado al puente `TestingPlatformDotnetTestSupport` y a un separador `--` obligatorio.
- **MTP 1.7 o posterior** en cada proyecto de pruebas. La integración de MTP con `dotnet test` solo está soportada desde 1.7 en adelante; 2.3.3 es la versión estable actual.
- **Inventaria el pipeline primero.** Busca con grep en tu CI: `dotnet test`, `vstest.console`, `--logger`, `--collect`, `--blame`, `--settings` y `--filter`. Ese grep es tu lista de trabajo real.
- **Encuentra cada `.runsettings`.** Ejecuta `find . -name "*.runsettings"` y lee cada uno. Todo lo que esté bajo `DataCollectionRunSettings` se vuelve una opción de CLI o desaparece.
- **Conoce tus frameworks.** Una solución con proyectos MSTest y xUnit a la vez necesita enrutar argumentos por proyecto (ver el paso 6). Descúbrelo ahora, no cuando CI falle con el código de salida 5.
- **Migra un proyecto de punta a punta primero**, pasando por una ejecución real de CI, antes de tocar el resto.

## Pasos de migración

1. **Fija el SDK y selecciona el runner en `global.json`.**

   La selección de runner es una decisión a nivel de repositorio, no por proyecto.

   ```json
   // global.json - .NET 11 SDK
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     },
     "test": {
       "runner": "Microsoft.Testing.Platform"
     }
   }
   ```

   `VSTest` es el otro valor válido y sigue siendo el predeterminado cuando la sección `test` está ausente. En el SDK de .NET 11 también puedes sobrescribir esto por shell con la variable de entorno `DOTNET_TEST_RUNNER`, que es la forma más rápida de comparar dos configuraciones de un job de CI sin editar un archivo versionado.

   Verifica: `dotnet test --help` ahora lista `--project`, `--solution` y `--test-modules`. Si todavía lista `--logger` y `--collect`, el cambio de runner no surtió efecto.

2. **Convierte cada proyecto de pruebas en un ejecutable.**

   Este es el opt-in universal, sin importar el framework. Ponlo en `Directory.Build.props` junto a tus proyectos de pruebas en vez de repetirlo.

   ```xml
   <!-- tests/Directory.Build.props - .NET 11 SDK, MTP 2.3.3 -->
   <Project>
     <PropertyGroup>
       <OutputType>Exe</OutputType>
     </PropertyGroup>
   </Project>
   ```

   No escribes un `Main`. `Microsoft.Testing.Platform.MSBuild`, que cada framework compatible con MTP trae de forma transitiva, genera un `TestingPlatformEntryPoint` por ti.

   Verifica: `dotnet build` produce un ejecutable `MyApp.Tests` (o `.exe`) en la carpeta de salida, y ejecutarlo directamente corre la suite.

3. **Activa el runner de tu framework de pruebas.**

   Cada framework tiene su propia propiedad, y las versiones mínimas difieren.

   ```xml
   <!-- tests/Directory.Build.props - pick the one that matches your framework -->
   <PropertyGroup>
     <!-- MSTest 3.2.0+, current 4.3.3 -->
     <EnableMSTestRunner>true</EnableMSTestRunner>

     <!-- NUnit3TestAdapter 5.0.0+, current 6.3.0 -->
     <EnableNUnitRunner>true</EnableNUnitRunner>

     <!-- xunit.v3 1.0.1+, current 4.0.0 -->
     <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
   </PropertyGroup>
   ```

   Los proyectos MSTest pueden saltarse la propiedad por completo cambiando el SDK del proyecto a `MSTest.Sdk`, donde MTP está activo por defecto. xunit.v3 4.0.0 resuelve a la variante de paquete de MTP v2; la línea 3.x usaba MTP v1 por defecto, algo que 4.0.0 eliminó. Si todavía estás en xUnit v2 no hay un camino de primera parte hacia MTP, así que haz primero la [migración de v2 a v3](/es/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/).

   Verifica: ejecuta el ejecutable de pruebas con `--help`. Deberías ver las opciones de la plataforma (`--filter-uid`, `--timeout`, `--list-tests`) más las que registre tu framework.

4. **Elimina las propiedades puente de la era .NET 9.**

   Muchos artículos de blog e incluso partes de la página de MSTest en MS Learn todavía las muestran. En el SDK de .NET 10 u 11 con selección de runner por `global.json` están obsoletas y deben eliminarse:

   ```xml
   <!-- delete these from every test project and Directory.Build.props -->
   <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   <TestingPlatformShowTestsFailure>true</TestingPlatformShowTestsFailure>
   ```

   El separador `--` que exigían también pasa a ser opcional, aunque sigue valiendo la pena conservarlo en CI por un motivo que se cubre en el paso 6.

   Verifica: `dotnet test` sigue ejecutándose y la salida de consola muestra el reporter de terminal de MTP en lugar del de VSTest.

5. **Vuelve a agregar los loggers y collectors como paquetes de extensión.**

   El núcleo de MTP no incluye ninguno. Si tu pipeline pasa una opción cuyo paquete falta, la ejecución falla con **código de salida 5** porque la opción no se reconoce.

   ```xml
   <!-- tests/Directory.Build.props - MTP 2.3.3 extensions -->
   <ItemGroup>
     <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.10.0" />
     <PackageReference Include="Microsoft.Testing.Extensions.HangDump" Version="2.3.3" />
     <PackageReference Include="Microsoft.Testing.Extensions.CrashDump" Version="2.3.3" />
   </ItemGroup>
   ```

   La extensión de cobertura de código se versiona de forma independiente a la plataforma: sigue la numeración de la plataforma de pruebas de Visual Studio, así que la versión actual es 18.10.0 mientras el resto está en 2.3.3. La tabla de compatibilidad documentada empareja la línea 18.1.x con MTP 2.0.x, 18.0.x con 1.8.x y 17.14.x con 1.6.2, y la recomendación es mantener ambos en su última versión. Si usas Central Package Management, estos van en `Directory.Packages.props`, que es un argumento más para [mover la solución a Directory.Packages.props](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) antes de empezar.

   Verifica: `dotnet test --help` lista `--report-trx`, `--coverage`, `--hangdump` y `--crashdump`.

6. **Traduce la línea de comandos de CI.**

   Aquí está el grueso del trabajo. El mapeo:

   ```bash
   # before - VSTest, .NET 9 SDK
   dotnet test MyApp.sln \
     --logger "trx;LogFileName=results.trx" \
     --collect "Code Coverage" \
     --blame-hang-timeout 5m \
     --results-directory ./artifacts/tests \
     --filter "TestCategory=Integration"
   ```

   ```bash
   # after - MTP 2.3.3, .NET 11 SDK
   dotnet test --solution MyApp.sln \
     --results-directory ./artifacts/tests \
     -- --report-trx --report-trx-filename results.trx \
        --coverage --coverage-output-format cobertura \
        --hangdump --hangdump-timeout 5m \
        --filter "TestCategory=Integration"
   ```

   Tres cosas para notar. El `MyApp.sln` posicional pasó a ser `--solution`, porque `dotnet test` en modo MTP ya no acepta una ruta suelta. El `--` es técnicamente opcional en el SDK de .NET 10 y posteriores, pero `dotnet test` reenvía a la aplicación de pruebas los tokens que no reconoce, y una opción del SDK reconocida ubicada entre el nombre de una opción no reconocida y su valor cambia cómo se enlazan los tokens restantes. Pon los argumentos de la aplicación de pruebas después de `--` y la ambigüedad desaparece. Por último, `--results-directory` lo entienden tanto el SDK como la plataforma, así que puede ir de cualquier lado.

   Para una solución que mezcla frameworks o conjuntos de extensiones, enruta los argumentos por proyecto en lugar de globalmente:

   ```xml
   <!-- only the projects that reference HangDump get the option -->
   <PropertyGroup Condition="'$(MSBuildProjectName)' == 'MyApp.Integration.Tests'">
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --hangdump --hangdump-timeout 5m
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Verifica: la ejecución produce `results.trx` y un archivo Cobertura bajo `./artifacts/tests`, y el código de salida es 0.

7. **Reemplaza `.runsettings` por `testconfig.json`.**

   MSTest y NUnit siguen respetando `--settings config.runsettings` a través de sus puentes VSTest, así que puedes posponer esto. xUnit v3 no lo hace, y la plataforma en sí nunca lee runsettings. El reemplazo:

   ```json
   // testconfig.json at the repo root - MTP 2.3.3
   {
     "platformOptions": {
       "resultDirectory": "./artifacts/tests",
       "exitProcessOnUnhandledException": false
     },
     "environmentVariables": {
       "DOTNET_ENVIRONMENT": "Testing"
     },
     "mstest": {
       "parallelism": { "enabled": true, "workers": 4, "scope": "method" },
       "timeout": { "test": 30000 }
     }
   }
   ```

   El mapeo no es uno a uno. `RunConfiguration/ResultsDirectory` pasa a ser `platformOptions.resultDirectory`. `RunConfiguration/MaxCpuCount` no tiene equivalente, porque el paralelismo a nivel de proceso ahora es `--max-parallel-test-modules`. `LoggerRunSettings/Loggers` y todo lo que esté bajo `DataCollectionRunSettings` se convierten en las opciones de CLI del paso 5. `TestRunParameters` pasa a ser `--test-parameter key=value`. Desde MTP 2.3.0 también puedes poner las propias opciones de CLI en `testconfig.json`, incluidas las de extensiones, que es la forma de mantener `--coverage-output-format cobertura` fuera de cada archivo de pipeline; la sección `environmentVariables` también es de 2.3.0 en adelante.

   Apunta cada proyecto a un archivo compartido desde `Directory.Build.props`:

   ```xml
   <PropertyGroup>
     <TestingPlatformCommandLineArguments>
       $(TestingPlatformCommandLineArguments) --config-file $(MSBuildThisFileDirectory)testconfig.json
     </TestingPlatformCommandLineArguments>
   </PropertyGroup>
   ```

   Verifica: elimina la referencia a `.runsettings` de CI y confirma que los resultados siguen cayendo en el directorio configurado.

8. **Cambia la tarea de CI en sí.**

   En Azure DevOps, reemplaza la tarea `VSTest@2` por `DotNetCoreCLI@2`. Es una invocación de `dotnet test` como cualquier otra, así que las reglas del paso 6 aplican textualmente:

   ```yml
   # azure-pipelines.yml - .NET 11 SDK, MTP 2.3.3
   - task: DotNetCoreCLI@2
     inputs:
       command: 'test'
       arguments: '--solution MyApp.sln -- --report-trx --results-directory $(Agent.TempDirectory)'
   ```

   En GitHub Actions, `Microsoft.Testing.Extensions.GitHubActionsReport` junto con `--report-gh` pone las fallas directamente en el diff del pull request, que es [la historia de reportes que se volvió estable en MTP 2.3](/es/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/). Ojo con el parecido: el paquete de terceros `GitHubActionsTestLogger` usa `--report-github`, a un carácter de distancia de la opción oficial.

   Verifica: una prueba que falla a propósito produce un job en rojo con la falla visible en el resumen de la ejecución, no solo en el log crudo.

## Verifica la migración

Corre esta lista contra un proyecto antes de extender el cambio a toda la solución:

- `dotnet build` emite un ejecutable por proyecto de pruebas, y ejecutarlo directamente (`./MyApp.Tests`) reporta la misma cantidad de pruebas que `dotnet test`.
- `dotnet test --help` lista cada opción que pasa tu pipeline. Si falta alguna, falta su paquete.
- La cantidad de pruebas coincide con la de VSTest antes de la migración. Una caída suele significar que una expresión de filtro dejó de coincidir, no que se perdieron pruebas.
- El archivo TRX y el reporte de cobertura existen en las rutas que leen tus pasos posteriores.
- El Test Explorer de Visual Studio sigue descubriendo y ejecutando pruebas. El soporte de MTP requiere Visual Studio 17.14 o posterior; VS Code necesita C# Dev Kit.
- `echo $?` después de una ejecución exitosa es 0, y después de una que falla a propósito es 2.

## Reversión

Esta migración es reversible en un solo commit mientras mantengas referenciados `Microsoft.NET.Test.Sdk` y el paquete adaptador de VSTest de tu framework. Elimina la sección `test` de `global.json` y el runner vuelve a VSTest; `OutputType=Exe` y las propiedades de opt-in quedan inertes bajo VSTest. Justamente por eso no deberías eliminar `xunit.runner.visualstudio` ni `Microsoft.NET.Test.Sdk` en el mismo pull request. Haz esa limpieza una semana después, cuando CI y el IDE de cada persona del equipo ya hayan corrido sobre MTP.

## Trampas que conviene conocer antes de empezar

**El código de salida 8 pone en rojo un job verde.** Un proyecto que ejecuta cero pruebas sale con 8 bajo MTP y con 0 bajo VSTest. Esto muerde en soluciones con un proyecto de pruebas de relleno o con un filtro que no coincide con nada. O arreglas el filtro, o te sales explícitamente:

```xml
<PropertyGroup>
  <TestingPlatformCommandLineArguments>
    $(TestingPlatformCommandLineArguments) --ignore-exit-code 8
  </TestingPlatformCommandLineArguments>
</PropertyGroup>
```

`--ignore-exit-code` acepta una lista separada por punto y coma (`--ignore-exit-code 2;8`), y `TESTINGPLATFORM_EXITCODE_IGNORE` hace lo mismo desde el entorno. Aparte, MTP 2.3.0 cambió el caso de todo omitido: una ejecución en la que todas las pruebas fueron omitidas ahora tiene éxito por defecto, y `--zero-tests-policy strict` restaura la falla anterior a 2.3.0.

**Una solución mixta es un error, no una advertencia.** Una vez que `global.json` selecciona MTP, `dotnet test` espera que cada proyecto de pruebas del grafo sea un proyecto MTP. Un rezagado en VSTest hace fallar toda la ejecución. Migra primero los proyectos hoja y cambia `global.json` al final.

**El código de salida 5 significa un paquete faltante, no un error de tipeo.** Si la mitad de tus proyectos referencia `Microsoft.Testing.Extensions.HangDump` y la otra mitad no, `--hangdump` es válida para unos y desconocida para otros, y la ejecución muere con 5. Usa las condiciones de `TestingPlatformCommandLineArguments` por proyecto del paso 6.

**xUnit ignora `--filter`.** MSTest y NUnit conservan la sintaxis de expresiones de VSTest (`FullyQualifiedName~UnitTest1|TestCategory=CategoryA`) bajo MTP. xUnit v3 no la implementa en absoluto: necesitas `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait` o `--filter-query`, más sus variantes negadas. Un filtro de CI que silenciosamente no coincide con nada dispara después el código de salida 8, que es como esto aparece en la práctica. Vale la pena entender esta misma clase de problema de filtros silenciosos si además estás evaluando [xUnit v3 frente a NUnit y MSTest](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).

**Los números de cobertura se mueven.** `IncludeTestAssembly` tiene valor por defecto `false` en `Microsoft.Testing.Extensions.CodeCoverage` y era `true` en VSTest. Tu porcentaje total de cobertura va a cambiar en el commit de la migración por razones ajenas a tu código. Avisa a quien vigile la barrera de cobertura antes de hacer push.

**El punto de entrada generado produce dos errores de compilación raros.** `Microsoft.Testing.Platform.MSBuild` emite `TestingPlatformEntryPoint` y `SelfRegisteredExtensions` dentro de `$(RootNamespace)`, cuyo valor por defecto es el nombre del proyecto. Un proyecto llamado `Contoso.Serialization.Tests` que además referencia un paquete `Contoso.Serialization` puede producir `CS0118: 'Serialization' is a namespace but is used like a type`; define `<RootNamespace>Contoso.SerializationTests</RootNamespace>` o límpialo con `<RootNamespace />`. Aparte, un proyecto que no es de pruebas y referencia uno que sí lo es choca con `CS8892` porque el punto de entrada generado colisiona con su `Main`; define `<IsTestingPlatformApplication>false</IsTestingPlatformApplication>` en el proyecto que referencia, o `<GenerateTestingPlatformEntryPoint>false</GenerateTestingPlatformEntryPoint>` en el proyecto de pruebas.

**Las rarezas del Test Explorer tienen su propio interruptor.** Si el descubrimiento se comporta mal en un IDE, `<DisableTestingPlatformServerCapability>true</DisableTestingPlatformServerCapability>` apaga el modo servidor de MTP para que el IDE vuelva al adaptador de VSTest. Eso es un rodeo, no una solución, y es un problema distinto al de [Test Explorer colgándose mientras `dotnet test` pasa](/es/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/).

El SDK de .NET 11 hace que el momento sea bueno: `--timeout` y `--maximum-failed-tests` a nivel de ejecución, `--no-dependencies`, `--use-current-runtime`, patrones de exclusión con prefijo `!` para `--test-modules`, soporte de `Microsoft.Build.Traversal` y una vista en vivo de las pruebas en curso en terminales interactivas. Nada de eso existe en el camino de VSTest.

## Relacionados

- [Migrar un proyecto de pruebas de xUnit v2 a xUnit v3](/es/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/)
- [Microsoft.Testing.Platform 2.3 y las anotaciones de GitHub Actions](/es/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [xUnit v3 vs NUnit vs MSTest en 2026](/es/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [VSTest elimina Newtonsoft.Json en .NET 11 Preview 4](/es/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/)
- [Migrar una solución .NET a Central Package Management](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Fuentes

- [Guía de migración de VSTest a Microsoft.Testing.Platform (MTP)](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) en MS Learn
- [Comando dotnet test con Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp), la referencia de CLI en modo MTP
- [Referencia de opciones de CLI de Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-cli-options), incluida la tabla de opciones de extensión por escenario
- [Solución de problemas de Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-troubleshooting) para la tabla completa de códigos de salida
- [Opciones de configuración de Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-config) para `testconfig.json` y el mapeo de runsettings
- [Cobertura de código de Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-code-coverage) para las opciones de la extensión y la tabla de compatibilidad de versiones
- [Enhance your CLI testing workflow with the new dotnet test](https://devblogs.microsoft.com/dotnet/dotnet-test-with-mtp/) en el blog de .NET
- [Novedades del SDK y las herramientas de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk) para las mejoras de pruebas de Preview 7
- [Soporte de Microsoft Testing Platform en xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)

---
title: "Migrar de .NET 8 a .NET 11: la lista de verificación completa"
description: "Una lista de verificación de migración con versiones fijadas, de .NET 8 LTS a .NET 11 LTS, que cubre instalación del SDK, target framework del csproj, cambios incompatibles en ASP.NET Core, EF Core, System.Text.Json, y el giro de resolución de sobrecargas de C# 14, con notas de rollback."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
lang: "es"
translationOf: "2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist"
translatedBy: "claude"
translationDate: 2026-05-28
---

Saltarse dos ciclos LTS de una sola vez es la actualización de .NET más barata que la mayoría de los equipos hará esta década. .NET 8 deja el soporte estándar en noviembre de 2026, .NET 11 es el LTS actual, y el camino entre ambos atraviesa tres tandas de cambios incompatibles (.NET 9, 10, 11) más tres versiones del lenguaje C# (C# 13, 14, con C# 12 ya entregado en 8). Un fin de semana de trabajo concentrado suele bastar para un servicio pequeño. Un monolito de tamaño mediano con EF Core, middleware personalizado y un par de generadores de código fuente suele costar de tres a cinco días. Las bases de código que dependen de `BinaryFormatter`, se apoyan en shims de `System.Web.HttpContext` o ejecutan Azure Functions en proceso cuestan más, y ese dolor aparece primero.

Esta entrada usa `net8.0` como origen y `net11.0` como destino. Cada bloque de código fija versiones de forma explícita para que los pasos sigan siendo reproducibles después de unas cuantas versiones de parche.

## Por qué migrar ahora

- El soporte estándar de .NET 8 termina el 2026-11-10. Después de esa fecha, no hay parches de seguridad ni servicing. Tu código de producción en 8 queda expuesto a auditoría tres semanas antes del Black Friday.
- .NET 11 entrega mejoras de runtime significativas y gratis: PGO dinámico está activado por defecto, el nuevo JIT escalonado maneja las máquinas de estado `async` sin la penalización histórica, y Native AOT ahora soporta las minimal APIs de ASP.NET Core y la mayor parte del camino de lectura de EF Core.
- El tipo `System.Threading.Lock` introducido en .NET 9 elimina una clase de errores de reentrada de monitor. Saltarse la migración deja sobre la mesa el viejo patrón `lock(object)`.
- C# 14 trae la palabra clave `field` estable en propiedades y constructores `partial`. Útiles, pero no son la razón para migrar; trátalos como extras.

## Qué se rompe

| Área                       | Cambio                                                                              | Severidad |
| -------------------------- | ----------------------------------------------------------------------------------- | --------- |
| `lock(object)`             | El nuevo tipo `System.Threading.Lock` cambia la semántica del monitor cuando se adopta | baja      |
| `BinaryFormatter`          | Eliminado por completo en .NET 9. Sin interruptor de compatibilidad                 | alta      |
| `System.Text.Json`         | El `JsonNumberHandling` por defecto para round-trips de `JsonObject` cambió en .NET 10 | media     |
| Pipeline de consultas de EF Core | La traducción de colecciones primitivas cambió en EF Core 10; algo de LINQ ahora lanza excepción | alta |
| Middleware de ASP.NET Core | Las firmas de sobrecarga de `UseExceptionHandler` cambiaron en .NET 10              | baja      |
| Avisos de trim de Native AOT | Varios caminos de `System.Reflection.Emit` emiten ahora avisos `IL2026`             | media     |
| Resolución de sobrecargas de C# 14 | Las sobrecargas de Span ahora ganan sobre las de array en casos ambiguos      | media     |
| `IWebHostBuilder`          | Ya estaba obsoleto en 8, eliminado en 11. Migra a `WebApplication.CreateBuilder`    | alta      |
| Herramienta `dotnet ef`    | Se requiere un salto de versión mayor (`dotnet tool update --global dotnet-ef --version 11.*`) | baja |
| Azure Functions            | El modelo en proceso fue eliminado; el isolated worker es obligatorio               | alta      |

La lista oficial completa vive en la [documentación de cambios incompatibles de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0). Léela de principio a fin antes de tocar un `.csproj`.

## Lista previa al vuelo

Ejecuta esto antes de cambiar cualquier target framework.

1. Instala el SDK de .NET 11 en todas las máquinas de desarrollo y en los runners de CI. Verifica con `dotnet --list-sdks` y confirma que aparece `11.0.x`. El SDK es lado a lado, así que .NET 8 sigue funcionando.
2. Fija el SDK en `global.json` para que CI no avance silenciosamente:
   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```
3. Captura una línea base: ejecuta `dotnet test` en .NET 8 y guarda los resultados. Quieres un verde limpio antes de empezar para que el primer rojo después del upgrade sea inequívoco.
4. Toma una instantánea del runtime de producción: vuelca `dotnet --info` desde un host en vivo. Si algo enlaza contra un runtime anterior a 8.0.0 (una publicación self-contained vieja, un plugin de terceros), encuéntralo ahora.
5. Inventaría los paquetes NuGet con `dotnet list package --outdated --include-transitive`. Cualquier cosa que fije `Microsoft.*` a `8.0.x` necesitará un salto mayor; cualquier cosa fijada a `7.*` o anterior es una señal de alarma.
6. Crea una rama para la migración. Un PR por paso lógico es más fácil de revertir que un único PR luz-verde gigante.

## Pasos de migración

1. **Sube el target framework.** Abre cada `.csproj` y cambia el valor de `TargetFramework` (o `TargetFrameworks`). Verifica con `dotnet build` y trata la primera tanda de errores de compilación como el verdadero alcance de la migración.

   ```xml
   <!-- src/MyApi.csproj, .NET 11 -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
   </Project>
   ```

   Verificación: `dotnet build` sale con 0 al menos para los proyectos hoja, o falla con errores que reconoces.

2. **Actualiza todos los paquetes NuGet `Microsoft.*` a la línea 11.x.** Hazlo como un único lote con `dotnet add package` por proyecto en lugar de tocar a ciegas `Directory.Packages.props`. El runtime, ASP.NET Core, EF Core y los paquetes `Microsoft.Extensions.*` versionan al unísono con el SDK.

   ```bash
   # .NET 11
   dotnet add package Microsoft.AspNetCore.OpenApi --version 11.0.0
   dotnet add package Microsoft.EntityFrameworkCore.SqlServer --version 11.0.0
   dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
   ```

   Verificación: `dotnet restore` tiene éxito y `dotnet list package` no muestra ningún `8.0.x` restante bajo el namespace `Microsoft.*`.

3. **Elimina el uso de `BinaryFormatter`.** Si la base de código serializa algo con `BinaryFormatter`, reemplázalo ahora. `System.Text.Json`, MessagePack o `protobuf-net` son los reemplazos habituales según si necesitas un formato JSON o binario. No hay flag de compatibilidad en .NET 9 o posterior; el tipo ya no existe.

   Verificación: `grep -r "BinaryFormatter" src/` no devuelve nada. Si necesitas leer blobs heredados de `BinaryFormatter` desde almacenamiento, escribe una herramienta de migración de un solo uso en .NET 8 para convertirlos antes de apagar el entorno de .NET 8.

4. **Reemplaza `IWebHostBuilder` por `WebApplication.CreateBuilder`.** El viejo shim del host genérico quedó obsoleto en .NET 6 y fue eliminado en .NET 11. Cualquier `Program.cs` que aún llame a `Host.CreateDefaultBuilder().ConfigureWebHostDefaults(...)` no compilará.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.MapOpenApi();
   app.MapControllers();
   app.Run();
   ```

   Verificación: la app arranca con `dotnet run` y el endpoint `/openapi/v1.json` responde HTTP 200.

5. **Audita `System.Text.Json` en busca de cambios de comportamiento.** El manejo por defecto de los round-trips de números en `JsonObject` cambió en .NET 10 para que los enteros ya no pierdan precisión al re-serializarse, y el deserializador polimórfico es más estricto con los discriminadores desconocidos por defecto. Si mantienes un contrato de API público, ejecuta tus pruebas de contrato y lee los fallos con cuidado. A menudo el contrato no cambió, pero una discrepancia antes silenciosa ahora lanza excepción. La entrada complementaria sobre la [corrección de "JSON value could not be converted to System.DateTime"](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cubre el modo de fallo de conversión más común.

   Verificación: `dotnet test` sale limpio para cualquier proyecto que ejercite serialización contra archivos JSON de fixtures.

6. **Migra las consultas de EF Core que usan colecciones primitivas.** EF Core 10 rehizo cómo se traduce `List<int>.Contains(x)` para que las colecciones parametrizadas produzcan un único parámetro SQL en lugar de expandirse en una cláusula `IN`. Eso arregló el problema de inflado del plan de caché, pero rompió un pequeño conjunto de consultas que combinaban `Contains` con otras expresiones evaluadas en el servidor. Vuelve a ejecutar todas las pruebas de integración de EF Core e inspecciona cualquier consulta que ahora lance `InvalidOperationException: The LINQ expression ... could not be translated`. La escotilla de escape es materializar la colección con `.ToList()` antes del join.

   Verificación: pasa cada prueba de integración que ejercite LINQ crudo sobre `DbSet<T>`; revisa por muestreo el SQL generado con `LogTo(Console.WriteLine, LogLevel.Information)` en una consulta representativa.

7. **Adopta `System.Threading.Lock` de forma selectiva, no por reemplazo masivo.** Reemplazar `private readonly object _gate = new();` por `private readonly System.Threading.Lock _gate = new();` es correcto en la mayoría de los casos, pero cambia si la reentrada desde el mismo hilo es observable. Recorre los caminos del código primero. Una comparación de compromisos más profunda está en [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/).

   Verificación: la revisión de código cubre explícitamente cada sitio `lock(...)` que se modificó; sin cambio funcional en la suite de pruebas.

8. **Vuelve a ejecutar los analizadores de trim y AOT.** Si el proyecto pone `<PublishAot>true</PublishAot>` o `<TrimMode>full</TrimMode>`, .NET 11 emite nuevos avisos alrededor de los caminos de `System.Reflection.Emit` que estaban silenciados en .NET 8. La corrección suele ser añadir anotaciones `[DynamicallyAccessedMembers]` o registrar un generador de código fuente JSON. La [comparación Native AOT vs ReadyToRun vs JIT](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) cubre cuándo merece la pena cada modelo.

   Verificación: `dotnet publish -c Release` emite cero avisos `IL2026` o `IL3050` en el proyecto hoja; el binario nativo resultante arranca localmente.

9. **Ajusta las sorpresas de resolución de sobrecargas de C# 14.** C# 14 cambió las reglas de resolución para que las sobrecargas que aceptan `ReadOnlySpan<T>` sean preferidas sobre las que aceptan `T[]` cuando ambas aplican. La mayoría del código no se ve afectado. Los casos que se rompen suelen ser mocks, librerías de aserciones fluidas y métodos de extensión personalizados escritos asumiendo que ganaría la sobrecarga de array. El compilador emite un diagnóstico claro; la corrección generalmente es un cast. El [cambio incompatible de resolución de sobrecargas de C# 14 con spans](/es/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) recorre el diagnóstico y el patrón del cast.

   Verificación: `dotnet build` está libre de avisos con `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`.

10. **Actualiza las imágenes de los runners de CI.** Sube la `dotnet-version` de `actions/setup-dotnet` de GitHub Actions a `11.0.x`, actualiza cualquier Dockerfile a la imagen base `mcr.microsoft.com/dotnet/sdk:11.0` y `mcr.microsoft.com/dotnet/aspnet:11.0`, y elimina las fijaciones a la imagen del SDK de .NET 8. Los runners auto-hospedados necesitan el SDK instalado manualmente antes de que CI pase.

    Verificación: una ejecución del pipeline en una rama de feature está verde de principio a fin, incluyendo el paso de publish.

## Verificación (lista de humo)

Después de los pasos anteriores, la app debería pasar cada línea de esta lista antes de que el PR de migración se fusione:

- `dotnet --list-sdks` muestra 11.0.x como la versión realmente usada por la compilación (`dotnet --version` desde la raíz del repo imprime `11.0.x`).
- `dotnet restore && dotnet build -c Release` sale con 0 y cero avisos.
- `dotnet test -c Release` está verde y el conteo de pruebas coincide con la línea base de .NET 8.
- `dotnet publish -c Release` produce un artefacto que arranca localmente y sirve `/health`.
- Se ejercita una ruta de lectura representativa y una ruta de escritura representativa contra un entorno de staging; la latencia p50/p95 está dentro del 10 por ciento de la línea base de .NET 8.
- Los logs no muestran referencias de first-chance a `BinaryFormatter`, `IWebHostBuilder` o `IL2026`.

Si algo de eso falla, detente. No fusiones una base de código parcialmente migrada.

## Rollback

Esta migración es reversible hasta el primer deploy de producción que reciba una escritura bajo .NET 11. Hasta entonces, revierte el `global.json`, el `TargetFramework` y los saltos de NuGet en un solo commit. Después de la primera escritura de producción en .NET 11, el rollback es técnicamente posible pero raramente vale la pena: los cambios de esquema que pudiste haber hecho bajo el traductor de EF Core 11, las salidas JSON serializadas bajo los nuevos valores por defecto y cualquier adopción de `System.Threading.Lock` requieren razonamiento por separado. Planifica avanzar y arreglar adelante.

## Trampas que encontramos

- **Un paquete NuGet que solo apunta a `net8.0` no está necesariamente roto en net11.0**, pero cargará silenciosamente la fachada de .NET Standard 2.0 si el paquete expone una. Eso a veces arrastra dependencias `System.*` viejas. Después del salto, `dotnet list package --include-transitive` no es opcional.
- **Las versiones de `Microsoft.Data.SqlClient` importan.** EF Core 11 quiere `Microsoft.Data.SqlClient` 7.x o posterior. Una fijación transitiva más vieja compilará, y luego fallará en tiempo de ejecución durante la negociación TLS 1.3 contra cajas SQL Server más nuevas.
- **Los generadores de código fuente construidos sobre Roslyn 4.6 emiten avisos sobre el Roslyn que viene con .NET 11.** La mayoría se resuelven subiendo la referencia `Microsoft.CodeAnalysis.CSharp` del generador. Si publicas tu propio generador, hazlo en un PR separado.
- **Las Azure Functions en proceso ya no existen.** Si un único proyecto de función todavía usa el modelo en proceso en .NET 8, .NET 11 no lo ejecutará. Migra al modelo de isolated worker primero, luego sube.
- **La semántica de cancelación de `HttpClient` en .NET 11** lanza correctamente `TaskCanceledException` cuyo `CancellationToken` coincide con el token suministrado, donde antes algunos caminos lanzaban con `CancellationToken.None`. Los bloques catch que hacen pattern-match sobre el token necesitarán un pequeño ajuste; la justificación está en la discusión de [async void vs async Task en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Relacionados

- [ConfigureAwait(false) vs default en .NET 11](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [EF Core 11 vs Dapper para inserciones masivas: benchmark real](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fuentes

- [Cambios incompatibles de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [Calendario y política de soporte de .NET](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [Cambios incompatibles de EF Core 10 y 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [Referencia del lenguaje C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
- [Referencia de la API `System.Threading.Lock`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock)

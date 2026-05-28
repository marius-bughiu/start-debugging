---
title: "Migrar de .NET Framework 4.8 a .NET 11 en 2026"
description: "Manual de migración con versiones fijas para mover una base de código en .NET Framework 4.8 a .NET 11 LTS en 2026: reescritura del csproj al estilo SDK, paso de System.Web a ASP.NET Core, WCF, EF6 a EF Core 11, eliminación de BinaryFormatter, reemplazos de AppDomain y un plan de reversión realista."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
lang: "es"
translationOf: "2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026"
translatedBy: "claude"
translationDate: 2026-05-28
---

Mover una base de código en .NET Framework 4.8 a .NET 11 no es un salto de versión. Es un ejercicio de cambio de plataforma que toca el formato del proyecto, el stack web, la capa de acceso a datos, el modelo de hospedaje y una larga lista de APIs que desaparecieron silenciosamente entre 2017 y 2026. La ventana oficial de mantenimiento de .NET Framework 4.8 sigue abierta en 2026, pero el runtime no recibe una actualización de características desde 2019, todo plan moderno de Azure App Service está en el stack Core por defecto, y casi todo paquete de NuGet que vale la pena ha dejado de incluir destinos `net48`. El esfuerzo realista para una aplicación típica de negocio es de dos a seis semanas para un servicio pequeño, y de dos a cuatro meses para una base de código mediana con WCF, EF6 y un frontend en WebForms o MVC 5. Las aplicaciones WebForms se quedan donde están o se reescriben; no hay un port en sitio. Este post fija `net48` como origen y `net11.0` como destino, y asume que el proyecto está en Windows.

## Por qué migrar ahora

- .NET Framework 4.8 está solo en mantenimiento desde la versión 4.8.1 en agosto de 2022. Sin APIs nuevas, sin características nuevas del lenguaje C#. El runtime de .NET 11 trae PGO dinámico activado por defecto, el JIT por niveles modernizado y Native AOT para APIs mínimas de ASP.NET Core.
- Cada nuevo framework de Microsoft (Aspire, Microsoft Agent Framework, Semantic Kernel 1.x, Azure Functions isolated worker) apunta a `net8.0` o superior y no será portado hacia atrás. Quedarse en 4.8 significa que ninguno de estos es alcanzable desde tu proceso.
- Costo en la nube. La huella de memoria del runtime de .NET 11 para una API mínima de ASP.NET Core en reposo es aproximadamente del 35 al 50 por ciento de un proceso worker de ASP.NET 4.8 con carga comparable, lo que se traduce directamente en planes más pequeños de App Service o mayor densidad de pods en Kubernetes.
- Contratación y herramientas. Los analizadores de Roslyn, los generadores de código fuente y la CLI moderna de `dotnet` asumen un proyecto al estilo SDK. La versión de C# en `net48` está limitada a C# 7.3 a menos que pelees con el compilador, lo que deja una década de características del lenguaje fuera de la mesa.

Si la base de código es una aplicación de escritorio de Windows (WinForms o WPF) que solo corre en Windows y no tiene planes de desplegarse en otro lado, la pregunta es válida. La respuesta sigue siendo en general que sí, porque el ciclo de vida soportado de net48 termina con la ventana de soporte extendido de Windows 10, y el soporte de herramientas ya es escaso.

## Qué se rompe

| Área                          | Cambio                                                                                              | Severidad   |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| Formato del proyecto          | `packages.config` y el XML antiguo de csproj no son soportados por el SDK de .NET 11                | alta       |
| `System.Web`                  | Eliminado por completo. `HttpContext.Current`, módulos, handlers, WebForms no tienen equivalente en .NET 11 | alta       |
| Servidor WCF                  | `System.ServiceModel` del lado del servidor no es soportado. Usa CoreWCF o reescribe a gRPC o HTTP  | alta       |
| Cliente WCF                   | Soportado vía los paquetes NuGet `System.ServiceModel.*` 6.x, con bindings limitados                | media      |
| Entity Framework 6            | Corre en .NET 11 con EF6 6.5.0 o superior, pero el desarrollo nuevo debería usar EF Core 11         | media      |
| `AppDomain`                   | Solo existe el `AppDomain` por defecto. No hay `CreateDomain`, ni contenedores de plugins descargables | alta    |
| `BinaryFormatter`             | Eliminado en .NET 9, sin interruptor opcional                                                       | alta       |
| .NET Remoting                 | Desaparecido. Sin reemplazo; reescribe a un protocolo de red que realmente quieras                  | alta       |
| Code Access Security          | Desaparecido. `[SecurityCritical]`, `PermissionSet`, sandboxing, todo eliminado                     | alta       |
| `web.config`                  | La configuración se mueve a `appsettings.json`. Las secciones `system.web` no aplican               | alta       |
| `app.config`                  | La mayoría de los ajustes aún funcionan vía `Microsoft.Extensions.Configuration.Xml`, pero las redirecciones de binding desaparecieron | media |
| WPF y WinForms                | Soportados en .NET 11, solo en Windows. La mayoría de los controles de terceros requieren una compilación 6.x o superior | media |
| `System.Drawing.Common`       | El soporte multiplataforma fue eliminado en .NET 6. Solo Windows desde entonces                     | media      |

Lee el [resumen de portabilidad de .NET Framework a .NET](https://learn.microsoft.com/en-us/dotnet/core/porting/) y la [lista de cambios disruptivos de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0) una vez antes de tocar un `.csproj`. La primera lista es de lejos la más larga de las dos.

## Lista previa al despegue

Ejecuta esto antes de cambiar un solo archivo de proyecto.

1. Instala el SDK de .NET 11 en cada máquina de desarrollo y runner de CI. Verifica con `dotnet --list-sdks` y confirma que aparece `11.0.x`. Mantén instalado el developer pack de .NET Framework 4.8 para que la solución antigua aún abra en Visual Studio.
2. Instala la CLI del .NET Upgrade Assistant y ejecútalo primero en modo de análisis. No migra código; produce un reporte accionable.
   ```bash
   # .NET 11, upgrade-assistant 0.6.x
   dotnet tool install --global upgrade-assistant
   upgrade-assistant analyze MySolution.sln
   ```
3. Ejecuta el .NET Portability Analyzer o `apiport` contra los ensamblados compilados. Cualquier cosa marcada como "not portable" es trabajo de migración que la herramienta upgrade-assistant no hará por ti.
4. Captura una línea base. Ejecuta la suite de pruebas existente en .NET Framework 4.8 y guarda el resultado. Un verde limpio en el runtime antiguo significa que el primer rojo en .NET 11 es inequívocamente una regresión por la migración.
5. Inventaría los paquetes NuGet de terceros. Cualquiera que solo distribuya ensamblados `net48` o `net472` es un bloqueador. Reemplazos: `log4net` 2.0.16, `Newtonsoft.Json` 13.x, `AutoMapper` 13.x, `Dapper` 2.1.x, todos con múltiples destinos y funcionando en .NET 11. Cualquier otra cosa necesita un ticket de actualización contra el proveedor.
6. Ramifica la migración. Planea al menos un PR por proyecto, y un PR separado para los proyectos de prueba. Un mega-PR único para una base de código mediana es irrevisable.

## Pasos de migración

1. **Convierte cada `.csproj` al estilo SDK.** Reemplaza el XML antiguo con el encabezado al estilo SDK. El nuevo formato infiere los archivos, elimina la mayoría de las referencias a ensamblados y usa `PackageReference` en lugar de `packages.config`. La herramienta `try-convert` (incluida con el .NET Upgrade Assistant) maneja la parte mecánica.

   ```xml
   <!-- src/MyApi.csproj, .NET 11, after conversion -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
       <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     </ItemGroup>
   </Project>
   ```

   Verificación: `dotnet build` sale con errores que nombran APIs eliminadas en lugar de errores del parser contra el propio archivo de proyecto. Elimina `packages.config` después de que la conversión tenga éxito.

2. **Elimina el uso de `BinaryFormatter` en todas partes.** El tipo fue eliminado en .NET 9 sin interruptor de compatibilidad. Reemplázalo con `System.Text.Json`, MessagePack o `protobuf-net` según necesites un formato JSON o binario en cable. Si tienes blobs almacenados serializados con `BinaryFormatter`, escribe una utilidad de conversión de un solo uso que aún corra en .NET Framework 4.8 para traducirlos al nuevo formato antes de dar de baja el entorno antiguo. Hacer esta conversión desde .NET 11 no es posible.

   Verificación: `grep -r "BinaryFormatter" src/` está vacío. Cualquier almacenamiento de blobs que antes contenía payloads en formato binario fue re-serializado y el nuevo formato pasa un test unitario de ida y vuelta.

3. **Reescribe el stack web de `System.Web` a ASP.NET Core 11.** Esta es la pieza individual de trabajo más grande. Los controladores de MVC 5 se mapean casi uno a uno a controladores de ASP.NET Core, pero los atributos de enrutado, el binding de modelos, los action filters y la inyección de dependencias difieren. `HttpContext.Current` desapareció; los controladores y el middleware reciben `HttpContext` explícitamente. `Application_Start` en `Global.asax` se convierte en código de arranque en `Program.cs`. Los controladores de WebAPI 2 son muy cercanos a los controladores de ASP.NET Core, pero heredan de `ControllerBase` en lugar de `ApiController`.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddControllers();
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.UseAuthentication();
   app.UseAuthorization();
   app.MapControllers();
   app.MapOpenApi();
   app.Run();
   ```

   WebForms (`.aspx`) no tiene ruta de migración. O bien mantienes la aplicación WebForms en .NET Framework 4.8 por el resto de su vida detrás de un proxy inverso, o reescribes las páginas afectadas como Blazor, MVC o Razor Pages. La comparación [Blazor Server vs Blazor WebAssembly vs Blazor United](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) es el punto correcto de partida si Blazor está sobre la mesa.

   Verificación: cada controlador tiene al menos una prueba de integración que ejercita una ruta HTTP contra `WebApplicationFactory<Program>` y afirma tanto el código de estado como el cuerpo de la respuesta.

4. **Mueve `web.config` a `appsettings.json`.** Las cadenas de conexión, los appSettings personalizados y la configuración de registro se mueven a JSON. Las secciones `system.web` no aplican. Las secciones `system.webServer` que configuran IIS siguen aplicando si hospedas detrás de IIS vía el módulo in-process, pero la mayoría de los despliegues de producción ahora usan Kestrel directamente. La configuración de autenticación se mueve de las secciones `<authentication>` y `<authorization>` de web.config a `builder.Services.AddAuthentication(...)` y a la API de políticas de autorización.

   ```json
   // appsettings.json, .NET 11
   {
     "ConnectionStrings": {
       "Default": "Server=.;Database=App;Trusted_Connection=True;TrustServerCertificate=True;"
     },
     "Logging": {
       "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" }
     }
   }
   ```

   Verificación: la aplicación lee cada valor previamente dirigido por configuración a través de `IConfiguration` o el patrón fuertemente tipado `IOptions<T>`; no sobreviven llamadas a `ConfigurationManager.AppSettings` en el código de producción.

5. **Maneja WCF.** WCF del lado del servidor no es soportado en .NET 11. Dos rutas realistas:
   - **CoreWCF** (el port mantenido por la comunidad). Agrega `CoreWCF.Primitives`, `CoreWCF.Http` y los bindings que realmente uses. La mayoría de los servicios `BasicHttpBinding` y `NetTcpBinding` migran con una referencia al contrato y una llamada de configuración `UseServiceModel`. El streaming, las transacciones y la seguridad a nivel de mensaje tienen grados variables de soporte; consulta la [matriz de compatibilidad de CoreWCF](https://github.com/CoreWCF/CoreWCF) antes de comprometerte.
   - **Reescribir a gRPC o a una API HTTP.** Techo más alto, más trabajo. La decisión correcta cuando la interfaz de WCF solo fue consumida por clientes que controlas.

   WCF del lado del cliente es soportado vía los paquetes NuGet `System.ServiceModel.*` 6.x con `BasicHttpBinding`, `NetTcpBinding` (limitado) y `WSHttpBinding` (solo seguridad de transporte). Si tu cliente usa `WSFederationHttpBinding` o seguridad a nivel de mensaje, reescribirás al consumidor.

   Verificación: cada endpoint de WCF tiene un test de contrato que ejecuta el cliente de .NET 11 contra el nuevo host de CoreWCF o el reemplazo reescrito, y afirma los mismos payloads que el cliente antiguo de .NET Framework.

6. **Mueve Entity Framework 6 a EF Core 11 (cuando valga la pena).** EF6 corre en .NET 11 vía el paquete `EntityFramework` 6.5.0, por lo que un lift-and-shift estricto es posible. Pero EF6 no recibe nuevas características, la API `DbContext` en EF Core está más cerca de lo que quieres para la inyección de dependencias de ASP.NET Core, y las consultas compiladas y la traducción de colecciones primitivas de EF Core 11 son significativamente más rápidas. Para la mayoría de los equipos, la decisión correcta es entregar la migración primero en EF6, luego pasar a EF Core en un PR de seguimiento. El post [EF Core compiled queries vs raw SQL vs Dapper](/es/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) cuantifica las ganancias en el camino caliente.

   Verificación: el ORM elegido pasa la misma suite de pruebas de integración que corría bajo EF6 en .NET Framework, incluyendo cualquier prueba que afirmara el SQL generado.

7. **Reemplaza los cargadores de plugins con `AppDomain.CreateDomain`.** `AppDomain` ya no es un límite de aislamiento en .NET 11; solo existe el dominio por defecto. Los sistemas de plugins que antes cargaban ensamblados en un `AppDomain` hijo para la semántica de descarga o el aislamiento de fallos deben moverse a `AssemblyLoadContext` con `isCollectible: true` y llamar a `Unload()` al terminar. Los plugins fuera de proceso vía procesos worker de `dotnet` son el patrón más seguro cuando el plugin no es de confianza.

   Verificación: una prueba unitaria carga un ensamblado de plugin, lo invoca, descarga el `AssemblyLoadContext` y afirma que una `WeakReference` al contexto se vuelve `null` después de un ciclo de `GC.Collect()`.

8. **Audita los saltos de versión del lenguaje C#.** Pasar de C# 7.3 a C# 14 son doce versiones del lenguaje en un solo paso. La mayoría es aditiva y segura, pero los tipos de referencia anulable (introducidos en C# 8) marcarán miles de advertencias en el código heredado si activas `<Nullable>enable</Nullable>` globalmente. La ruta realista es `<Nullable>annotations</Nullable>` primero (solo anotaciones, sin diagnósticos), luego conversión archivo por archivo usando pragmas `#nullable enable`. El cambio de resolución de sobrecargas de C# 14 alrededor de las sobrecargas con span está documentado en el post de fix [C# 14 overload resolution breaking change with spans](/es/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).

   Verificación: `dotnet build -warnaserror` está limpio en el alcance anulable acordado antes de hacer merge.

9. **Actualiza las imágenes de runners de CI.** Sube `actions/setup-dotnet` de GitHub Actions a `dotnet-version: 11.0.x`, actualiza cualquier imagen base de Dockerfile a `mcr.microsoft.com/dotnet/sdk:11.0` y `mcr.microsoft.com/dotnet/aspnet:11.0`, y elimina la imagen antigua de MSBuild de .NET Framework. Si algún proyecto todavía tiene que compilar bajo .NET Framework (por ejemplo, la herramienta de conversión de `BinaryFormatter` de un solo uso del paso 2), mantén un único runner `windows-2022` con el developer pack de .NET Framework 4.8 instalado y limítalo con un filtro de ruta.

   Verificación: una ejecución de pipeline en una rama de característica está verde de extremo a extremo, incluyendo `dotnet publish`, la construcción de la imagen del contenedor y un despliegue smoke a un entorno de staging.

## Verificación (checklist smoke)

Después de los pasos anteriores, la aplicación debe pasar cada línea de esta lista antes de que se haga merge del PR de migración:

- `dotnet --list-sdks` muestra `11.0.x` y `dotnet --version` desde la raíz del repo imprime `11.0.x`.
- `dotnet restore && dotnet build -c Release` sale con 0 con cero advertencias en el alcance anulable acordado.
- `dotnet test -c Release` está verde y la cuenta de pruebas coincide (o excede) la línea base de .NET Framework 4.8.
- `dotnet publish -c Release` produce un artefacto autocontenido que arranca en un host de staging limpio sin el redistribuible de .NET Framework 4.8 instalado.
- Cada ruta HTTP tiene al menos una prueba de integración contra `WebApplicationFactory<Program>`.
- Los logs no muestran referencias de primera oportunidad a `BinaryFormatter`, `IWebHostBuilder`, `HttpContext.Current` o `ConfigurationManager` en las rutas de código de producción.
- Un despliegue de staging sirve el camino feliz; la latencia p50/p95 está dentro del 20 por ciento de la línea base de .NET Framework en hardware equivalente.

Si alguno de esos falla, detente. Una migración parcial a .NET 11 es peor que un despliegue limpio de .NET Framework 4.8 porque te compromete a ambos runtimes.

## Reversión

La migración es reversible solo mientras el esquema de la base de datos y cualquier formato en cable no hayan cambiado. El intercambio del runtime en sí es reversible: revierte los cambios del `.csproj` y reinstala el redistribuible de .NET Framework 4.8 en el host. Las decisiones que hacen costosa la reversión suelen ser ortogonales:

- Una nueva migración de EF Core 11 corrió contra la base de datos de producción. Revierte primero el esquema.
- Los payloads JSON fueron re-serializados bajo los valores por defecto de `System.Text.Json` que difieren de `Newtonsoft.Json`. Los consumidores aguas abajo que hacen pattern-matching en el orden de los campos o en el manejo de nulos verán deriva.
- La autenticación se movió de cookies de `FormsAuthentication` a las cookies de data-protection de ASP.NET Core. Las sesiones existentes se invalidan de cualquier forma.

El plan pragmático es mantener el despliegue de .NET Framework caliente en un slot separado durante una semana después del corte, y restringir el corte detrás de un feature flag en el balanceador de carga en lugar de en el momento del despliegue. Arregla hacia adelante después de esa ventana.

## Tropiezos que tuvimos

- **`HttpClient` en .NET 11 aplica estrictamente la indicación del nombre de servidor TLS (SNI).** Las llamadas a servicios internos que presentan un certificado sin un SAN coincidente fallan con `AuthenticationException`. Arregla el certificado o configura `SslOptions.RemoteCertificateValidationCallback` deliberadamente. Los valores por defecto de .NET Framework eran más laxos, y eso enmascaraba la falta del SAN.
- **`DateTime.Parse` en .NET 11 es más estricto con formatos ambiguos que .NET Framework 4.8.** El código que hacía round-trip de `DateTime` a través de cadenas sin un `IFormatProvider` explícito empezará a lanzar `FormatException` con entradas que antes aceptaba. Pasa siempre `CultureInfo.InvariantCulture` y un formato conocido. El fix [JSON value could not be converted to System.DateTime](/es/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) cubre la variante más común cuando la fecha llega vía JSON.
- **`Microsoft.Data.SqlClient` reemplaza a `System.Data.SqlClient` en cualquier ruta moderna.** EF Core 11 quiere `Microsoft.Data.SqlClient` 7.x o superior. Un pin transitivo al viejo `System.Data.SqlClient` compilará pero fallará en runtime en la negociación de TLS 1.3 contra cajas más nuevas de SQL Server.
- **El binding de configuración es sensible a mayúsculas en JSON, insensible a mayúsculas en `app.config`.** Una propiedad llamada `MaxRetries` en `appsettings.json` no enlaza desde una clave `maxretries`. El `ConfigurationManager` de .NET Framework no le importaba.
- **`HostingEnvironment.MapPath` desapareció.** Reemplázalo con `IWebHostEnvironment.ContentRootPath` y `Path.Combine`. La sintaxis de ruta virtual `~/` no es entendida por nada en ASP.NET Core.
- **Los surrogates de datacontract de WCF no hacen round-trip idéntico a través de CoreWCF.** Si dependes de `IDataContractSurrogate`, escribe un test de contrato que afirme el formato exacto en cable antes y después de la migración, no solo la igualdad de objetos.

## Relacionados

- [Migrate from .NET 8 to .NET 11: the full checklist](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [System.Text.Json vs Newtonsoft.Json in 2026](/es/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)
- [EF Core 11 vs Dapper for bulk inserts: real benchmark](/es/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Fuentes

- [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/)
- [.NET 11 breaking changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET Upgrade Assistant documentation](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
- [CoreWCF project and compatibility matrix](https://github.com/CoreWCF/CoreWCF)
- [Migrate from ASP.NET to ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/migration/proper-to-2x/)
- [AssemblyLoadContext API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.loader.assemblyloadcontext)

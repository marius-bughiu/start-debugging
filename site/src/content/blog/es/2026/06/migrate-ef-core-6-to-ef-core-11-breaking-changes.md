---
title: "Migrar de EF Core 6 a EF Core 11: los cambios incompatibles que de verdad duelen"
description: "Una guía de migración con versiones fijadas, de EF Core 6.0 a EF Core 11.0, recorriendo los cambios incompatibles de EF7, 8, 9, 10 y 11 que rompen apps reales: Encrypt=True, Contains con OPENJSON, PendingModelChangesWarning, la columna json nativa y la división de SqlClient 7.0."
pubDate: 2026-06-04
updatedDate: 2026-06-04
template: migration
tags:
  - "migration"
  - "ef-core"
  - "ef-core-6"
  - "ef-core-11"
  - "dotnet-11"
lang: "es"
translationOf: "2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes"
translatedBy: "claude"
translationDate: 2026-06-04
---

Pasar de EF Core 6.0 a EF Core 11.0 son cinco versiones mayores de un solo salto, y las partes dolorosas casi nunca son los renombrados de API. Son los cambios silenciosos de comportamiento: una cadena de conexión que funcionó durante años ahora lanza un error de SSL, una consulta `Contains` que de repente agota el tiempo de espera en un SQL Server antiguo, y una implementación que se aborta porque EF decidió que tu modelo tiene cambios pendientes. Calcula medio día para un servicio pequeño y de dos a cuatro días para un monolito con un modelo no trivial, conversores de valor personalizados y un flujo de scaffolding database-first. Nada de esto es una puerta de un solo sentido a nivel de base de datos, pero dos cambios (el valor por defecto de `Encrypt` en EF Core 7 y la excepción de `PendingModelChangesWarning` en EF Core 9) impedirán que tu app arranque el primer día si no los planificas.

Esta guía fija `Microsoft.EntityFrameworkCore` 6.0 como origen y 11.0 como destino, ejecutándose sobre .NET 11. Como el piso de target framework de EF Core sube por el camino (EF Core 7 necesita .NET 6, EF Core 8 y 9 necesitan .NET 8, EF Core 10 necesita .NET 10 y EF Core 11 necesita .NET 11), esta es además una migración de runtime. Si todavía no moviste el runtime, hazlo primero usando la [lista de verificación de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) y vuelve.

## Por qué migrar ahora

- EF Core 6.0 dejó de tener soporte en noviembre de 2024. Estás ejecutando una capa de datos sin soporte contra un runtime con soporte, que es lo peor de ambos mundos para una revisión de seguridad.
- EF Core 11 trae mejoras reales de consulta gratis: la traducción de `Contains` basada en `OPENJSON` (refinada tres veces desde EF 8), mejores estimaciones de cardinalidad con múltiples parámetros escalares y el tipo de columna `json` nativo de SQL Server con indexación de primera clase.
- `ExecuteUpdate` y `ExecuteDelete`, añadidos en EF Core 7 y mejorados en cada versión desde entonces, convierten las escrituras basadas en conjuntos en una única sentencia SQL. Si todavía cargas entidades para mutarlas, estás dejando uno o dos órdenes de magnitud sobre la mesa. Mira [ExecuteUpdate frente a cargar entidades y SaveChanges](/es/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) para el benchmark.
- Las barreras de migración que llegaron en EF 9 (detección de cambios pendientes del modelo) y EF 11 (detección de ausencia de migraciones) atrapan toda una clase de incidentes de producción del tipo "la base de datos y el modelo se desincronizaron en silencio".

## Qué se rompe

Esta es la lista acumulada a través de las cinco versiones. La severidad es qué tan probable es que rompa una app típica, no qué tan difícil es la corrección.

| Área | Cambio | Versión | Severidad |
| ---- | ------ | ------- | --------- |
| Conexiones a SQL Server | `Encrypt` ahora vale `true` por defecto; los certificados no confiables lanzan excepción | EF 7 | alta |
| SaveChanges con triggers | La ruta con cláusula OUTPUT se rompe en tablas con triggers o ciertas columnas calculadas | EF 7 | alta |
| Relaciones opcionales | Los dependientes huérfanos ya no se eliminan automáticamente al cortar la relación | EF 7 | media |
| `Contains` sobre una lista | Se traduce vía `OPENJSON`; falla por debajo de SQL Server 2016 / nivel de compatibilidad 130 | EF 8 | alta |
| Rendimiento de `Contains` | El plan de `OPENJSON` puede degradarse mucho en algunas cargas de trabajo | EF 8 | alta |
| Enums en columnas JSON | Se almacenan como `int` por defecto en lugar de `string` | EF 8 | alta |
| Claves de tipo string en SQL Server | Se comparan sin distinguir mayúsculas en el rastreador de cambios | EF 8 | media |
| Aplicar migraciones | `PendingModelChangesWarning` ahora lanza excepción en `Migrate()` | EF 9 | alta |
| Migraciones en una transacción | Una transacción externa alrededor de `Migrate()` ahora lanza excepción | EF 9 | alta |
| `EF.Constant` / `EF.Parameter` | Lanzan `InvalidCastException` dentro de consultas compiladas | EF 9 | baja |
| Herramientas de EF, proyectos multi-target | Ahora se requiere `--framework` | EF 10 | media |
| Colecciones parametrizadas | La traducción por defecto ahora son múltiples parámetros escalares | EF 10 | baja |
| Almacenamiento JSON en SQL Server | El JSON en `nvarchar(max)` migra al `json` nativo en nivel de compatibilidad 170 / Azure SQL | EF 10 | baja |
| Migrate sin migraciones | Lanza excepción por defecto en lugar de registrar | EF 11 | baja |
| `Microsoft.Data.SqlClient` 7.0 | Las dependencias de autenticación Entra ID se separan en otro paquete | EF 11 | media |

Las listas autoritativas por versión están enlazadas al final. Lee las páginas de [EF 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes), [EF 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes) y [EF 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) antes de empezar; esas tres concentran los cambios de severidad alta.

## Lista de verificación previa

1. Mueve el runtime a .NET 11 y confirma un `dotnet test` limpio con los paquetes antiguos de EF Core 6 primero. Quieres que cambie una sola variable a la vez, para que el primer rojo tras subir EF sea inequívoco.
2. Haz inventario de tu proveedor. SQL Server, SQLite, PostgreSQL (Npgsql) y Cosmos tienen cada uno sus propios cambios incompatibles. Esta guía se centra en SQL Server y señala SQLite donde difiere.
3. Revisa la versión y el nivel de compatibilidad de tu SQL Server. El cambio de `Contains` de EF 8 necesita nivel de compatibilidad 130 o superior:
   ```sql
   -- run against your target database
   SELECT name, compatibility_level FROM sys.databases;
   ```
4. Busca `Database.Migrate(` y `MigrateAsync(`. Cada punto de llamada es candidato a la excepción de cambios pendientes de EF 9 y a la excepción de transacción explícita de EF 9.
5. Busca `.HasConversion<string>()` en enums y cualquier propiedad enum mapeada dentro de tipos owned mapeados a JSON. Esos son el cambio de enums en JSON de EF 8.
6. Anota si usas autenticación Entra ID (Azure AD) en alguna cadena de conexión (`Authentication=Active Directory Default`, identidad administrada, entidad de servicio). Eso es la división de SqlClient de EF 11.
7. Crea una rama para la migración y respalda la base de datos. Las migraciones que alteran el esquema (longitud máxima del discriminador, `json` nativo) se generan automáticamente y deben revisarse antes de ejecutarse contra producción.

## Pasos de migración

1. **Sube todos los paquetes de EF Core a 11.0 de una sola vez.** No subas una versión a la vez; los cambios incompatibles son acumulativos y están documentados por versión, así que un único salto con la documentación abierta es más rápido que cinco compilaciones intermedias. Actualiza `Microsoft.EntityFrameworkCore`, el proveedor (`Microsoft.EntityFrameworkCore.SqlServer`) y `Microsoft.EntityFrameworkCore.Design`. Verifica con `dotnet restore` y `dotnet build`, y trata los primeros errores de compilación como el alcance real.
   ```xml
   <!-- src/MyApp.csproj, EF Core 11 on .NET 11 -->
   <ItemGroup>
     <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0" PrivateAssets="all" />
   </ItemGroup>
   ```

2. **Actualiza la herramienta `dotnet ef` a una versión mayor que coincida.** La herramienta 6.x no puede leer un modelo 11.0. Verifica con `dotnet ef --version` y confirma `11.0.x`.
   ```bash
   dotnet tool update --global dotnet-ef --version 11.*
   ```

3. **Corrige el valor por defecto `Encrypt=True` antes que nada.** Este es el cambio de EF Core 7 que vive en `Microsoft.Data.SqlClient`, no en EF, así que no hay interruptor del lado de EF. En una máquina de desarrollo sin un certificado de servidor confiable, tu primera conexión lanza un error de SSL. Para desarrollo local, añade `TrustServerCertificate=True`; en producción, instala un certificado válido. Verifica abriendo una conexión: `dotnet ef dbcontext info` debe conectarse sin un error de proveedor SSL.
   ```text
   Server=localhost;Database=App;Trusted_Connection=True;TrustServerCertificate=True
   ```

4. **Maneja las barreras de migración en cada llamada a `Migrate()`.** EF Core 9 lanza `PendingModelChangesWarning` si el modelo difiere de la última migración, y EF Core 11 lanza `MigrationsNotFound` si no hay migraciones en absoluto. Si gestionas el esquema con migraciones, la corrección es añadir la migración faltante. Si gestionas el esquema de otra forma (Dapper, DACPAC, SQL escrito a mano) y solo llamas a `Migrate()` por costumbre, elimina la llamada o suprime las advertencias. Verifica ejecutando `dotnet ef migrations has-pending-model-changes` y obteniendo un resultado limpio.
   ```csharp
   // EF Core 11. Only suppress if you intentionally manage schema elsewhere.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.ConfigureWarnings(w =>
       {
           w.Ignore(RelationalEventId.PendingModelChangesWarning);
           w.Ignore(RelationalEventId.MigrationsNotFound);
       });
   ```

5. **Elimina cualquier transacción explícita que envuelva a `Migrate()`.** El patrón habitual de "migración resiliente" (iniciar transacción, migrar, confirmar, dentro de una estrategia de ejecución) lanza `MigrationsUserTransactionWarning` en EF Core 9 porque EF ahora gestiona la transacción y el bloqueo de la base de datos por sí mismo. Borra el envoltorio y llama directamente a `MigrateAsync`. Verifica que la app arranque y aplique las migraciones una vez.
   ```csharp
   // EF Core 9+. EF manages the transaction and execution strategy.
   await dbContext.Database.MigrateAsync(cancellationToken);
   ```

6. **Confirma el nivel de compatibilidad de SQL Server para el cambio de `Contains`.** Si `sys.databases` reporta un nivel inferior a 130, la traducción `OPENJSON` de EF Core 8 fallará en tiempo de ejecución. Sube el nivel si puedes, o fija el modo de traducción. Verifica ejecutando una consulta que use `.Where(x => list.Contains(x.Id))` y confirmando un SQL válido.
   ```csharp
   // EF Core 10+: pick the translation strategy explicitly.
   // Constant = pre-EF8 inlining, Parameter = OPENJSON, MultipleParameters = EF10 default.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.UseSqlServer(connectionString,
           o => o.UseParameterizedCollectionMode(ParameterTranslationMode.MultipleParameters));
   ```

7. **Fija el almacenamiento de enums en JSON si dependes de los valores de tipo string.** EF Core 8 cambió los enums dentro de tipos owned mapeados a JSON de strings a enteros. Los documentos existentes escritos por EF 6 contienen strings; tras la actualización EF los lee como enteros y falla. Fuerza la conversión a string para mantener los datos antiguos legibles. Verifica haciendo un round-trip de una entidad con una propiedad enum en una columna JSON.
   ```csharp
   protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
       => configurationBuilder.Properties<OrderStatus>().HaveConversion<string>();
   ```

8. **Añade una migración para los cambios de esquema que EF ahora quiere.** EF Core 8 da a las columnas de discriminador de TPH una longitud máxima acotada, y EF Core 10 mapea las columnas JSON al tipo `json` nativo en Azure SQL o en nivel de compatibilidad 170. Genera la migración, léela y solo entonces aplícala. Verifica con una revisión de las operaciones `AlterColumn` generadas.
   ```bash
   dotnet ef migrations add UpgradeToEfCore11
   dotnet ef migrations script --idempotent --output migrate.sql
   ```

9. **Separa la autenticación Entra ID si la usas.** EF Core 11 pasa a `Microsoft.Data.SqlClient` 7.0, que elimina las dependencias de autenticación de Azure del paquete principal. Si una cadena de conexión usa autenticación `Active Directory`, añade el paquete de extensiones. Verifica conectándote con la identidad administrada en un entorno implementado, no solo localmente.
   ```xml
   <PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.0" />
   ```

## Verificación

Ejecuta esta prueba de humo después de la migración, en orden:

1. `dotnet build` está limpio, incluyendo la resolución de la referencia a `Microsoft.EntityFrameworkCore.Design` (las herramientas de EF 11 ya no la traen transitivamente).
2. `dotnet ef migrations has-pending-model-changes` reporta que no hay cambios pendientes.
3. La app arranca y `Migrate()` (si lo llamas) se aplica limpiamente, sin `PendingModelChangesWarning` ni `MigrationsNotFound`.
4. `dotnet test` está en verde. Presta atención a las pruebas que afirman sobre cadenas de SQL generadas; las traducciones de `Contains` y de colecciones parametrizadas cambiaron, así que las aserciones de snapshot necesitarán actualizarse.
5. Ejecuta una consulta que filtre por un `Contains` sobre una lista y confirma que se ejecuta, no solo que compila.
6. Verifica puntualmente una entidad mapeada a JSON con un enum, y una entidad con clave de tipo string usada en una relación, para confirmar valores correctos.

## Plan de reversión

Los cambios de paquetes y de código son reversibles: revierte la rama, restaura los paquetes de EF Core 6.0 y baja la herramienta `dotnet-ef`. El riesgo es la migración de esquema del paso 8. Las alteraciones de longitud máxima del discriminador y de `json` nativo cambian la base de datos, y EF Core 6.0 no conocerá una migración sellada por EF Core 11. Si necesitas poder revertir el runtime después de aplicar esa migración, genera primero un script de reversión (`dotnet ef migrations script UpgradeToEfCore11 PreviousMigration`) y guárdalo con el release. Sin ese script, el cambio de esquema es efectivamente de un solo sentido para un binario de EF 6.

## Tropiezos que tuvimos

**El timeout de `Contains` es el más traicionero.** La consulta compila, devuelve resultados correctos y pasa todas las pruebas con un conjunto de datos pequeño. Luego una tabla de producción con millones de filas pega con el plan de `OPENJSON` y la consulta agota el tiempo de espera. El equipo de EF lo refinó tres veces: EF 8 introdujo `OPENJSON`, EF 9 añadió `TranslateParameterizedCollectionsToConstants` y EF 10 cambió el valor por defecto a múltiples parámetros escalares. Si ves una regresión, la válvula de escape por consulta es `EF.Constant(list).Contains(...)` para incrustar los valores en esa única consulta dejando intacto el valor por defecto global. La [guía de detección de N+1](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) y la [guía de división de consultas](/es/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) cubren las trampas de forma de consulta adyacentes que vale la pena revisar en la misma pasada.

**Las claves de string sin distinción de mayúsculas cambian la coincidencia en silencio.** EF Core 8 hizo que el proveedor de SQL Server comparara los valores de claves de string sin distinguir mayúsculas en el rastreador de cambios, para coincidir con cómo SQL Server compara las claves foráneas. Si tu código dependía de que `"ABC"` y `"abc"` fueran claves distintas en memoria, el rastreador de cambios ahora las trata como la misma entidad. La corrección es un `ValueComparer` personalizado que distinga mayúsculas en esas claves, pero primero confirma que realmente dependes de eso; la mayoría de las apps quieren el nuevo comportamiento.

**La excepción de cambios pendientes salta con datos de seed dinámicos.** Un modelo que hace seed con `HasData` usando `DateTime.UtcNow` o `Guid.NewGuid()` le parece "modificado" a EF en cada compilación, así que EF 9 lanza `PendingModelChangesWarning` aunque no hayas cambiado nada. Reemplaza los valores dinámicos por constantes estáticas en el seed, o pásate al patrón de seeding de EF 9. Este es fácil de diagnosticar mal como un bug de migración real.

**La salida del scaffolding database-first cambia de forma.** Si vuelves a hacer scaffolding desde la base de datos, EF 8 ahora genera `DateOnly` y `TimeOnly` para columnas `date` y `time`, quita el envoltorio anulable en columnas booleanas con un valor por defecto y nombra las navegaciones de forma distinta para claves foráneas compuestas. Ninguno de estos rompe una app en ejecución, pero producen un diff grande y ruidoso que es fácil confundir con un error. Vuelve a hacer scaffolding en su propio commit para que el diff sea revisable.

Cinco versiones mayores suena más pesado de lo que es. Dos cambios detendrán tu app en seco en la primera ejecución (el valor por defecto de `Encrypt` y la excepción de migración), y uno es una trampa de rendimiento latente (la traducción de `Contains`). Planifica para esos tres, genera y lee la única migración de esquema, y el resto son subidas de paquetes y una pasada de pruebas en verde. Para el lado más amplio del runtime de la misma actualización, la [lista de verificación de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) cubre los cambios de framework, ASP.NET Core y C# 14 que viajan junto a este.

## Fuentes

- [Breaking changes in EF Core 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes)
- [Breaking changes in EF Core 8.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes)
- [Breaking changes in EF Core 9.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [Breaking changes in EF Core 10.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [Breaking changes in EF Core 11.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Microsoft.Data.SqlClient 7.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md)

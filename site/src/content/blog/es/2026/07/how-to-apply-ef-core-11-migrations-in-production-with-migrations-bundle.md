---
title: "Cómo aplicar migraciones de EF Core 11 en producción con dotnet ef migrations bundle"
description: "Una guía completa para implementar cambios de esquema de EF Core 11 con bundles de migración: compilar efbundle en CI, la trampa de appsettings.json con cadenas de conexión con nombre, bundles autocontenidos y el RID musl de Alpine, el bloqueo de migraciones desde EF Core 9, revertir con una migración objetivo y por qué las transacciones por migración no te salvan en MySQL."
pubDate: 2026-07-28
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
  - "devops"
lang: "es"
translationOf: "2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle"
translatedBy: "claude"
translationDate: 2026-07-28
---

Para aplicar migraciones de EF Core 11 a una base de datos de producción, compila un bundle de migración en CI con `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle`, publica ese único ejecutable como artefacto de compilación y ejecútalo como su propio paso de implementación con `./efbundle --connection "$CONNECTION_STRING"`. El bundle lleva tus migraciones compiladas y el runtime de EF Core dentro de un solo archivo. La máquina que lo ejecuta no necesita el SDK de .NET, ni la herramienta `dotnet-ef`, ni acceso a tu código fuente, y tu aplicación nunca necesita permisos para alterar el esquema en la base de datos. Este artículo apunta a EF Core 11 y .NET 11 (preview 6 al momento de escribir, GA en noviembre de 2026) con C# 14. Los bundles existen desde EF Core 6, así que todo lo de aquí funciona de EF Core 6 a 11, y señalo los pisos de versión donde el comportamiento difiere.

## Qué está realmente mal con las otras tres estrategias

Todo equipo .NET termina eligiendo una de cuatro formas de llevar cambios de esquema a producción, y tres de ellas tienen un modo de fallo que solo aparece bajo carga o bajo presión.

**Llamar a `Database.Migrate()` al arrancar** es la que más duele. La propia guía de Microsoft la califica de inapropiada para producción, y las razones se acumulan: tu proceso de aplicación necesita `db_ddladmin` o equivalente para siempre, no solo durante las implementaciones; la migración se ejecuta sin que ningún humano mire el SQL; y la reversión implica publicar una compilación nueva. Desde EF Core 9 el riesgo de concurrencia al menos está resuelto, porque `Migrate()` y `MigrateAsync()` adquieren un bloqueo a nivel de base de datos antes de aplicar nada, así que diez réplicas desplegándose a la vez se serializan en lugar de corromperse entre sí. Eso arregló el peor síntoma, pero ninguno de los problemas estructurales.

**Ejecutar `dotnet ef database update` en el agente de implementación** significa instalar el SDK de .NET y la herramienta `dotnet-ef` en ese agente, descargar el código fuente y compilar el proyecto solo para aplicar un `CREATE INDEX`. Si ese agente es tu máquina de producción, acabas de poner un compilador en ella.

**Generar un script SQL** con `dotnet ef migrations script --idempotent` es la estrategia que Microsoft sigue recomendando en primer lugar, y tiene una ventaja real: un DBA puede leerlo antes de que se ejecute. El costo es que ahora necesitas una herramienta para ejecutarlo y, como lo plantea el equipo de EF en la documentación, el manejo de transacciones y el comportamiento de continuar-tras-error de esas herramientas es inconsistente y a veces inesperado. `sqlcmd` seguirá alegremente después de que falle la instrucción 40 de 120, dejando tu esquema en algún punto intermedio entre dos migraciones sin registro de dónde.

Los bundles eliminan esa clase de problema: el ejecutable aplica las migraciones por la misma ruta de código de EF Core que `dotnet ef database update`, con la misma semántica transaccional, y o reporta éxito o devuelve un código de salida distinto de cero.

## El pipeline de cuatro pasos

Esta es la forma completa de la implementación, y el resto del artículo es el detalle de cada paso.

1. **Verifica que el modelo y las migraciones concuerden.** Ejecuta `dotnet ef migrations has-pending-model-changes` en CI. Sale con código distinto de cero si alguien cambió una entidad y olvidó ejecutar `migrations add`.
2. **Compila el bundle una sola vez**, en CI, desde el mismo commit que produjo los binarios de tu aplicación: `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle --force`.
3. **Publica `efbundle` como artefacto de compilación**, junto con cualquier `appsettings.json` que necesite.
4. **Ejecútalo como un paso de implementación discreto**, antes de que la nueva versión de la aplicación empiece a atender tráfico: `./efbundle --connection "$CONNECTION_STRING"`.

## Compilar el bundle

El comando es de tiempo de diseño, así que necesita que el proyecto de arranque referencie `Microsoft.EntityFrameworkCore.Design` y una instalación funcional de `dotnet ef`:

```bash
# EF Core 11, .NET 11
dotnet tool install --global dotnet-ef
dotnet ef migrations bundle
```

```output
Build started...
Build succeeded.
Building bundle...
Done. Migrations Bundle: /src/App.Api/efbundle
```

Por defecto la salida queda junto al proyecto de arranque y se llama `efbundle` (`efbundle.exe` en Windows), compilada para el RID de la máquina que hace la compilación. Las opciones son lo bastante pocas como para listarlas completas:

| Opción | Corta | Qué hace |
| --- | --- | --- |
| `--output <FILE>` | `-o` | Ruta del ejecutable a crear. |
| `--force` | `-f` | Sobrescribe un bundle existente. |
| `--self-contained` | | Incluye también el runtime de .NET, para que la máquina de destino no necesite tenerlo instalado. |
| `--target-runtime <RID>` | `-r` | El identificador de runtime para el que compilar. |

Más las opciones habituales de tiempo de diseño: `--project`, `--startup-project`, `--context`, `--configuration`, `--framework`, `--no-build`.

En una solución real el contexto vive en una biblioteca de clases y el host en otro lado, así que CI ejecuta algo más parecido a esto:

```bash
# EF Core 11, .NET 11 - context in a class library, host in the API project
dotnet ef migrations bundle \
  --project src/App.Infrastructure \
  --startup-project src/App.Api \
  --context AppDbContext \
  --configuration Release \
  --self-contained -r linux-x64 \
  -o ./artifacts/efbundle \
  --force
```

EF Core 11 te permite dejar de repetir casi todo eso. Deja un archivo `.config/dotnet-ef.json` en la raíz del repositorio y `dotnet ef` sube por el árbol de directorios desde el directorio de trabajo hasta encontrarlo:

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "context": "AppDbContext",
  "configuration": "Release"
}
```

Las opciones explícitas de línea de comandos siguen ganando sobre el archivo, así que un desarrollador puede sobrescribir cualquiera de ellas localmente. Esto es nuevo en EF Core 11 y es la mejor razón para actualizar la herramienta en tus agentes de compilación.

## Qué hace el bundle en tiempo de ejecución

Ejecuta el binario y aplica todas las migraciones del ensamblado que no estén ya registradas en `__EFMigrationsHistory`:

```bash
./efbundle --connection "Server=prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true"
```

```output
Applying migration '20260721104512_AddOrderIndexes'.
Applying migration '20260726091133_AddCustomerTier'.
Done.
```

Ejecútalo una segunda vez y no hace nada, que es exactamente lo que quieres de un paso de implementación que podría reintentarse:

```output
No migrations were applied. The database is already up to date.
Done.
```

Toda su superficie es un argumento y cuatro opciones. El argumento es la migración objetivo: pasa un nombre o ID de migración para subir o **bajar** hasta ese punto, y pasa `0` para revertir todas las migraciones. Las opciones son `--connection`, `--verbose` (`-v`), `--no-color` y `--prefix-output`. Eso es todo. No hay opción `--timeout`, y por eso la creación de un índice largo sobre una tabla grande necesita `Command Timeout=600` dentro de la propia cadena de conexión; cubrí ese modo de fallo en detalle al escribir sobre [el timeout que mata las migraciones de EF Core a mitad de implementación](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

Vale la pena activar `--prefix-output` en CI: etiqueta cada línea con su severidad, lo que le da a tu agregador de registros algo por lo que filtrar.

## La trampa de appsettings.json

Este es el fallo que le cuesta una tarde a los equipos, y no es evidente en la documentación.

Si tu `DbContext` está configurado con una cadena de conexión **con nombre**, por ejemplo `optionsBuilder.UseSqlServer("name=ConnectionStrings:DefaultConnection")`, el bundle sigue necesitando un `appsettings.json` en su directorio de trabajo que contenga esa clave. Incluso cuando pasas `--connection` por línea de comandos. Sin él obtienes:

```output
A named connection string was used, but the name 'ConnectionStrings:DefaultConnection'
was not found in the application's configuration. Note that named connection strings
are only supported when using 'IConfiguration' and a service provider, such as in a
typical ASP.NET Core application.
```

El valor de ese archivo es irrelevante, porque `--connection` lo sobrescribe; la *clave* solo tiene que existir para que el enlace de configuración funcione. Esto se reportó como [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) y se cerró como no planificado, así que planifica alrededor de ello en lugar de esperar un arreglo. Dos salidas:

- Envía un `appsettings.json` de relleno junto al bundle en tu artefacto, con un valor de marcador bajo la clave esperada.
- O deja de usar una cadena de conexión con nombre en la ruta de tiempo de diseño, para que el bundle no tenga nada que resolver.

La documentación de EF Core también es tajante sobre el caso general: no olvides copiar `appsettings.json` junto a tu bundle, porque el bundle depende de su presencia en el directorio de ejecución. Si tu configuración está separada por entorno, define `ASPNETCORE_ENVIRONMENT` (o `DOTNET_ENVIRONMENT` para un host que no sea web) antes de ejecutar el bundle y copia también el `appsettings.Production.json` correspondiente. El bundle no tiene una opción `--environment` propia.

Mi preferencia es esquivar la configuración por completo: pasa la cadena de conexión completa con `--connection`, tomada de tu almacén de secretos al momento de implementar, y mantén un `appsettings.json` de relleno solo para satisfacer al enlazador. Eso convierte al bundle en una función pura de sus argumentos, que es lo que quieres cuando el mismo artefacto asciende de staging a producción.

## Bundles autocontenidos y la trampa de Alpine

`--self-contained -r linux-x64` produce un ejecutable que lleva el runtime de .NET consigo. Ese es el valor predeterminado correcto para implementaciones en contenedores, porque significa que tu paso de migración puede ejecutarse en una imagen mínima sin .NET instalado.

El RID tiene que coincidir con la libc del destino, no solo con su arquitectura. Un bundle autocontenido `linux-x64` apunta a glibc y no se ejecutará en Alpine ni en ninguna otra imagen basada en musl; ahí quieres `linux-musl-x64`. El fallo es un confuso "not found" o un error del cargador en lugar de un mensaje claro, así que fija el RID deliberadamente:

```bash
# EF Core 11, .NET 11 - for an Alpine-based runner
dotnet ef migrations bundle --self-contained -r linux-musl-x64 -o ./artifacts/efbundle --force
```

La globalización es el segundo tropiezo de Alpine. Un bundle autocontenido espera ICU, y las imágenes de Alpine necesitan `icu-libs` instalado. Añadir `apk add --no-cache icu-libs` a la imagen de migración sale más barato que depurar `Couldn't find a valid ICU package installed on the system` dentro de una ventana de implementación.

Si tu máquina de producción ya tiene el runtime de .NET correspondiente, quita `--self-contained` y obtén un artefacto mucho más pequeño. En un init container de Kubernetes o en un Job que corre antes del despliegue, la versión autocontenida suele ganar igual, porque desacopla el paso de migración de la versión de runtime de la imagen de tu aplicación. El mismo razonamiento aplica cuando estás [construyendo la imagen de la aplicación con `dotnet publish /t:PublishContainer`](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/): mantén el paso de esquema y el paso de aplicación como artefactos separados.

## El bloqueo de migraciones y lo que no cubre

Desde EF Core 9, aplicar migraciones adquiere primero un bloqueo a nivel de base de datos. Esto aplica a `dotnet ef database update`, a `Update-Database`, a `Migrate()` y `MigrateAsync()`, y a los bundles de migración. El bloqueo se mantiene durante toda la operación, incluido cualquier código de sembrado que se ejecute como parte de ella, así que si siembras con [`UseSeeding` y `UseAsyncSeeding`](/es/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) ese trabajo también queda cubierto.

Lo que el bloqueo **no** cubre son los scripts SQL, porque esos se ejecutan totalmente fuera de EF Core. Si la mitad de tu pipeline ejecuta un bundle y la otra mitad un script generado, no tienes exclusión mutua entre ambos. Elige uno.

El mecanismo de bloqueo es específico del proveedor y tiene aristas. En SQLite está implementado con una tabla de bloqueo que puede quedar abandonada si el proceso muere a mitad de la migración, lo que luego bloquea toda migración posterior hasta que la limpies a mano. Eso importa si ejecutas pruebas de integración contra SQLite y matas el host de pruebas.

Hay una limitación más que conviene conocer antes de diseñar alrededor de esto: no puedes envolver `MigrateAsync` en una transacción explícita. Desde EF Core 9 eso lanza una excepción.

## Las transacciones son por migración, no por bundle

Una lectura errónea común es que un bundle aplica todas las migraciones pendientes de forma atómica. No lo hace. EF Core envuelve **cada migración** en su propia transacción. Tres migraciones pendientes significan tres transacciones. Si la segunda falla, la primera queda aplicada y registrada en `__EFMigrationsHistory`, y la tercera nunca se ejecuta.

Ese suele ser el comportamiento que quieres, porque volver a ejecutar el bundle retoma exactamente donde se detuvo. Pero significa que "la implementación falló, revierte la base de datos" no es una sola operación, y deberías razonar sobre los estados intermedios que tu esquema puede ocupar.

Dos advertencias específicas de proveedor lo afinan:

- En bases de datos sin DDL transaccional, notablemente MySQL, una migración fallida puede dejar cambios de esquema parciales sin reversión alguna. Cada instrucción DDL confirma implícitamente. En MySQL, trata cada migración como si fuera no transaccional y mantén las migraciones lo bastante pequeñas como para razonarlas a mano.
- Algunas operaciones no pueden ejecutarse dentro de una transacción ni siquiera en SQL Server o PostgreSQL, por ejemplo crear un índice de forma concurrente. Para esas, pasa `suppressTransaction: true` a `migrationBuilder.Sql(...)` y acepta que la instrucción no queda cubierta.

```csharp
// EF Core 11, C# 14 - a statement that must not run inside the migration transaction
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql(
        "CREATE INDEX CONCURRENTLY IX_Orders_CustomerId ON \"Orders\" (\"CustomerId\");",
        suppressTransaction: true);
}
```

## Revertir

El bundle toma una migración objetivo como argumento posicional, y migrar "hacia abajo" es el mismo comando con un objetivo anterior:

```bash
# EF Core 11 - revert to the state right after AddOrderIndexes
./efbundle 20260721104512_AddOrderIndexes

# EF Core 11 - revert everything. Read that twice before running it.
./efbundle 0
```

Para que esto funcione, el bundle que ejecutas debe *contener* las migraciones a las que estás revirtiendo, lo que es un argumento para conservar todos los artefactos de bundle que hayas implementado y no solo el último. Los métodos `Down` también tienen que ser correctos, y son el código menos probado de la mayoría de los repositorios. Un `Down` que elimina una columna no es una reversión; es pérdida de datos con pasos extra. Esta es exactamente la revisión que te compra generar un script, y nada te impide producir ambos artefactos en CI: ejecuta el bundle en el pipeline y adjunta `dotnet ef migrations script --idempotent -o schema.sql` a la misma compilación para que el DBA lo lea.

## Detectar el desajuste antes de implementar

Desde EF Core 9, `Migrate()` lanza una excepción cuando el modelo tiene cambios pendientes respecto a la última migración (`RelationalEventId.PendingModelChangesWarning`). No quieres descubrir eso durante una implementación. Pon la comprobación en CI:

```bash
# EF Core 11 - fails the build if an entity changed without a migration
dotnet ef migrations has-pending-model-changes \
  --project src/App.Infrastructure \
  --startup-project src/App.Api
```

El comando se añadió en EF Core 8 y sale con código distinto de cero cuando el modelo y las migraciones se han desviado. Combínalo con la compilación del bundle en el mismo job, para que el artefacto y la comprobación vengan de un solo commit.

Mientras endureces el pipeline, vale la pena anticipar dos modos de fallo relacionados: que `dotnet ef` necesite una fábrica de tiempo de diseño cuando [no puede crear tu DbContext](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), y los cambios de comportamiento que muerden al [actualizar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Dónde encaja `database update --add` y dónde no

EF Core 11 añadió `dotnet ef database update <NAME> --add`, que genera una migración y la aplica en un solo comando, usando Roslyn para compilar la migración en tiempo de ejecución. Es una herramienta de ciclo interno genuinamente buena, y escribí sobre [el flujo de migración en un solo paso](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) cuando salió. También es exactamente lo contrario de lo que quieres en producción: genera y aplica cambios de esquema sin artefacto y sin paso de revisión intermedio. Úsalo mientras prototipas y reserva el bundle para todo lo que tenga datos reales detrás. Lo mismo vale para las otras adiciones de herramientas de EF Core 11, `--connection` en `database drop` y `migrations remove` y `--offline` en `migrations remove`: comodidades del ciclo de desarrollo, no herramientas de implementación.

Si un bundle aplica migraciones y algo se ve mal después, reprodúcelo localmente con el registro subido, que es cuestión de [hacer que EF Core 11 registre el SQL que genera](/es/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) contra una copia desechable del esquema.

## Relacionados

- [Fix: SqlException Timeout expired durante migraciones de EF Core](/es/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add falla con "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Migrar de EF Core 6 a EF Core 11: los cambios incompatibles que de verdad muerden](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [EF Core 11 te deja crear y aplicar una migración en un solo comando](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Cómo publicar una aplicación .NET 11 como imagen de contenedor con dotnet publish /t:PublishContainer](/es/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Fuentes

- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) cubre las cuatro estrategias de implementación, las tablas de argumentos y opciones de `efbundle` y el bloqueo de migraciones.
- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) es la autoridad sobre las opciones de `dotnet ef migrations bundle` y el nuevo archivo de configuración `.config/dotnet-ef.json` de EF Core 11.
- [Introducing DevOps-friendly EF Core Migration Bundles](https://devblogs.microsoft.com/dotnet/introducing-devops-friendly-ef-core-migration-bundles/) es el anuncio original y explica la intención del diseño.
- [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) documenta el requisito de `appsettings.json` para cadenas de conexión con nombre, cerrado como no planificado.
- [Managing Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) describe las transacciones por migración y `suppressTransaction`.
- [SQLite provider limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations) cubre los bloqueos de migración abandonados.

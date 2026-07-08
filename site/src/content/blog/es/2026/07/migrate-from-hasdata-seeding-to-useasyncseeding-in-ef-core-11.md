---
title: "Migrar del seeding con HasData a UseAsyncSeeding en EF Core 11"
description: "Guia paso a paso para mover los datos de seed de HasData a UseSeeding y UseAsyncSeeding en EF Core 11, incluida la trampa de la migracion DeleteData que borra tus filas existentes si la pasas por alto."
pubDate: 2026-07-08
updatedDate: 2026-07-08
template: migration
tags:
  - "migration"
  - "efcore"
  - "dotnet"
lang: "es"
translationOf: "2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-08
---

Mover los datos de seed de `HasData` a `UseSeeding`/`UseAsyncSeeding` en EF Core 11 es un trabajo de medio dia para una aplicacion tipica, y lo unico que te va a morder no es la API nueva: es que borrar una llamada a `HasData` hace que el siguiente `dotnet ef migrations add` emita una instruccion `DeleteData` que elimina esas mismas filas de cada base de datos contra la que se ejecute la migracion. Si borras el `HasData` y agregas el `UseSeeding` en el mismo despliegue sin pensar en el orden, puedes borrar datos de referencia en produccion. Esta guia recorre la migracion en el orden que evita eso, usando .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) y C# 14. Reserva una tarde para una aplicacion mediana, la mayor parte gastada en auditar que seeds deberian haberse movido hace anios.

Vale la pena? Para cualquier cosa dinamica, con clave generada, calculada o condicional: si, y era necesario desde hace tiempo. Para una tabla de referencia genuinamente estatica de tres filas, dejala en `HasData`. El objetivo aqui no es "borrar todos los `HasData`", es "mover los seeds que nunca pertenecieron al modelo".

## Por que dejar HasData

`HasData` incrusta tus datos de seed en el snapshot del modelo. Ese unico hecho de diseno es la raiz de cada razon para dejarlo:

- **Los valores no deterministas generan migraciones fantasma.** Un `DateTime.UtcNow`, un `Guid.NewGuid()` o una contrasenia con hash dentro de una fila `HasData` hace que el diff del modelo nunca coincida, asi que EF cree que el modelo cambio en cada compilacion y o bien advierte con `PendingModelChangesWarning` o suelta un goteo interminable de migraciones sin efecto. Este es el muro que la mayoria de los equipos golpea, a menudo a mitad de una [migracion de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Las claves generadas por la base de datos son imposibles.** `HasData` requiere cada clave primaria escrita a mano. Las columnas identity y las secuencias quedan descartadas, asi que terminas inventando claves y rezando para que nunca choquen con inserciones reales.
- **Sin logica condicional, sin grafos de navegacion, sin transformaciones.** "Sembrar un tenant de demo solo en Development" o "insertar este grafo de objetos a traves de sus propiedades de navegacion" no puede expresarse en `HasData` en absoluto.
- **El seed es parte del diff de tu esquema, lo quieras o no.** Cada edicion de valor se convierte en un `UpdateData` en una migracion, lo cual es una caracteristica para los codigos de pais y una molestia para cualquier cosa que preferirias gestionar como codigo.

El equipo de EF renombro `HasData` a "model-managed data" precisamente para desalentar su uso como herramienta general de seeding. `UseSeeding` y `UseAsyncSeeding`, introducidos en EF Core 9 y vigentes en EF Core 11, son codigo de aplicacion corriente que se ejecuta contra un `DbContext` vivo, sin ninguno de esos limites. Si todavia estas decidiendo que seeds mover, la [matriz de decision HasData vs UseSeeding](/es/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) traza la linea fila por fila.

## Que se rompe

| Area | Cambio | Severidad |
| ---- | ------ | --------- |
| Bases de datos existentes | Borrar una llamada `HasData` genera `DeleteData`, que elimina las filas del seed en la migracion | alta |
| Idempotencia | `HasData` se difundia automaticamente; `UseSeeding` se ejecuta cada vez y necesita una comprobacion de existencia escrita a mano | alta |
| Dos rutas de codigo | El tooling llama al `UseSeeding` sincrono, el arranque async llama a `UseAsyncSeeding`; implementa solo uno y el otro no hace nada en silencio | alta |
| Control de versiones | Los valores del seed salen del snapshot de la migracion y viven en el codigo de arranque; ya no quedan capturados en el historial de migraciones | media |
| Integridad referencial | Los datos de los que dependen claves foraneas de otras tablas ahora aterrizan en un callback de arranque, no dentro de la transaccion de la migracion | media |
| Configuracion de pruebas | Las pruebas que dependian de que `HasData` se ejecutara via `EnsureCreated` siguen funcionando, pero solo si se implementan ambos overloads | baja |

La fila superior es la que termina en un informe de incidente. Todo lo demas es mecanico.

## Lista previa al despegue

Antes de tocar una linea de codigo de seeding:

- **Confirma que tu version de EF Core es 9.0 o posterior.** `UseSeeding`/`UseAsyncSeeding` no existen antes de EF Core 9. Ejecuta `dotnet list package | findstr EntityFrameworkCore` y confirma 11.0 (o como minimo 9.0).
- **Inventaria cada llamada a `HasData`.** Haz grep en el codigo: `grep -rn "HasData" .` (o `findstr /s HasData *.cs` en Windows). Para cada una, decide conservar o mover usando la regla de abajo.
- **Clasifica cada seed.** Consérvalo en `HasData` si el dato es pequenio, fijo, determinista, con clave escrita a mano y algo sin lo cual el esquema carece de sentido (enums de estado de pedido, codigos de pais ISO). Muevelo a `UseSeeding` si tiene claves generadas por la base de datos, valores calculados o no deterministas, logica condicional, propiedades de navegacion o transformaciones externas.
- **Respalda produccion, o ensaya sobre una copia restaurada.** Estas a punto de generar una migracion que emite instrucciones `DELETE`. No descubras su comportamiento en produccion.
- **Ten una base de datos de staging que ya tenga las filas `HasData` aplicadas.** Necesitas ver que hace la migracion de eliminacion sobre una base de datos que fue sembrada a la manera antigua, no solo sobre una vacia.

## Pasos de migracion

El orden importa. Hacer esto en la secuencia equivocada es exactamente como borras datos de referencia de produccion.

### 1. Escribe primero los callbacks UseSeeding y UseAsyncSeeding

Agrega la nueva ruta de seeding antes de borrar nada. Ambos overloads, logica identica, comprobacion de existencia en la parte superior de cada uno. Factoriza el cuerpo en metodos compartidos para que las versiones sincrona y async no se desvien:

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedStatuses(context))
        .UseAsyncSeeding((context, _, ct) => SeedStatusesAsync(context, ct)));

static void SeedStatuses(DbContext context)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        context.SaveChanges();
    }
}

static async Task SeedStatusesAsync(DbContext context, CancellationToken ct)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = await context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToListAsync(ct);

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        await context.SaveChangesAsync(ct);
    }
}
```

Fijate en que esta version ya no fija `Id` a mano. La base de datos lo asigna. Ese es todo el punto: si antes asignabas claves a mano en `HasData`, las referencias de clave foranea existentes pueden apuntar a esos valores especificos, que es lo que hace delicado el paso 2.

**Verifica:** ejecuta la aplicacion contra una base de datos local vacia con las llamadas `HasData` todavia presentes. Deberia arrancar limpiamente sin filas duplicadas. La comprobacion de existencia deberia hacer que un segundo arranque no haga nada (una consulta de lectura, cero escrituras).

### 2. Decide como preservar las filas existentes antes de borrar HasData

Este es el paso que todos se saltan y lamentan. Cuando borras una llamada `HasData` y ejecutas `dotnet ef migrations add`, EF genera un `DeleteData` en el metodo `Up` para cada fila previamente sembrada:

```csharp
// .NET 11, EF Core 11 -- what removing HasData generates
migrationBuilder.DeleteData(
    table: "OrderStatuses",
    keyColumn: "Id",
    keyValues: new object[] { 1, 2, 3 });
```

En una base de datos existente, ese `DELETE` se ejecuta. Si otras tablas tienen claves foraneas apuntando a esas filas, el borrado o bien falla con un error `FOREIGN KEY constraint failed` o, peor, se propaga en cascada. Tienes tres opciones seguras:

- **A. Manten las claves estables y deja que el seed reinserte.** Si las filas son datos de referencia puros sin claves foraneas entrantes, dejar que la migracion las borre y que `UseSeeding` las reinserte en el siguiente arranque esta bien, pero las nuevas claves diferiran (generadas por la base de datos), asi que esto solo es seguro cuando nada referencia las claves viejas.
- **B. Edita a mano la migracion generada para quitar el `DeleteData`.** Despues de `dotnet ef migrations add RemoveStatusSeed`, abre el archivo generado y borra la llamada `DeleteData` (y el `InsertData` correspondiente en `Down`). Las filas se quedan; solo el snapshot del modelo deja de rastrearlas. Esta es la opcion mas segura cuando las claves foraneas referencian las filas sembradas y quieres dejarlas intactas.
- **C. Preserva las claves en el nuevo seeder.** Si debes conservar los valores exactos de clave (porque las claves foraneas dependen de ellos), sigue asignandolos explicitamente en `UseSeeding` y aun asi edita a mano el `DeleteData`. Pierdes el beneficio de la clave generada por la base de datos para esta tabla, pero conservas la integridad referencial.

Para cualquier cosa con claves foraneas entrantes, la opcion B es casi siempre lo que quieres. Las filas no necesitan moverse; solo la propiedad de ellas.

**Verifica:** despues de generar la migracion de eliminacion, lee el archivo generado antes de aplicarlo. Confirma que las llamadas `DeleteData` apuntan exactamente a las filas que esperas, y que has elegido y aplicado A, B o C para cada tabla.

### 3. Quita las llamadas HasData de OnModelCreating

Ahora borra el bloque `HasData` de los seeds que estas moviendo:

```csharp
// Before -- .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}

// After -- the HasData block is gone; seeding lives in UseSeeding now
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    // OrderStatus seeding moved to UseSeeding in Program.cs
}
```

**Verifica:** el proyecto sigue compilando, y `dotnet ef migrations has-pending-model-changes` reporta un cambio pendiente (el seed eliminado) que estas a punto de capturar.

### 4. Genera y revisa la migracion de eliminacion

```bash
# .NET 11, EF Core 11
dotnet ef migrations add RemoveOrderStatusSeed
```

Abre la migracion generada y aplica tu decision del paso 2. Si elegiste la opcion B, borra el `DeleteData` de `Up` y el `InsertData` correspondiente de `Down`. Deja intactos los cambios del snapshot del modelo; esos son correctos y necesarios.

**Verifica:** ejecuta `dotnet ef migrations script` contra tu base de datos de staging y lee el SQL. Confirma que no sobrevive ningun `DELETE FROM OrderStatuses` inesperado si tu intencion era preservar las filas.

### 5. Aplica contra staging y confirma que los datos sobreviven

```bash
# .NET 11, EF Core 11
dotnet ef database update
```

Luego arranca la aplicacion para que `UseAsyncSeeding` se ejecute.

**Verifica:** consulta la tabla. Las filas de referencia estan presentes exactamente una vez. Arranca la aplicacion una segunda vez y confirma que no aparecieron duplicados, lo cual prueba que la comprobacion de existencia funciona. Si las claves foraneas referencian las filas, confirma que esas relaciones estan intactas.

## Prueba de humo posterior a la migracion

Ejecuta esta lista de verificacion contra staging antes de enviar:

- `dotnet build` tiene exito sin `PendingModelChangesWarning`.
- `dotnet ef migrations has-pending-model-changes` no reporta nada pendiente.
- La aplicacion arranca via su ruta async (`await context.Database.MigrateAsync()`) y las filas sembradas existen una vez.
- `dotnet ef database update` sobre una base de datos nueva tambien siembra correctamente (esto ejercita el `UseSeeding` sincrono, que el tooling llama).
- Reiniciar la aplicacion no inserta nada nuevo (la idempotencia se mantiene).
- Las relaciones de clave foranea que apuntaban a las claves viejas del seed siguen resolviendose.
- Ninguna tabla muestra el sintoma de migracion fantasma: agregar una migracion nueva no produce ningun `InsertData`/`DeleteData` relacionado con el seed.

## Plan de reversion

Esta migracion es reversible, pero lee la letra pequenia. Si elegiste la opcion B (editaste a mano quitando el `DeleteData`), el `Down` a nivel de esquema no hace nada para los datos, asi que revertir la migracion deja las filas en su lugar y simplemente restaura el snapshot del modelo. Volver a agregar el bloque `HasData` y generar una migracion nueva te devuelve al mundo antiguo, aunque EF querra hacer `InsertData` de cualquier fila que falte.

Si elegiste la opcion A (dejaste que ocurriera el borrado y resiembra), la reversion es mas arriesgada: las filas ahora tienen claves generadas por la base de datos, asi que volver a un modelo `HasData` que espera claves fijas no coincidira. En ese caso, no intentes una reversion en el sitio de datos en vivo. Restaura desde el respaldo que tomaste en el paso previo al despegue. Por eso el respaldo previo al despegue no es opcional.

## Trampas que golpeamos

- **El borrado se propago en cascada a traves de una clave foranea.** Una tabla `Order` referenciaba `OrderStatus.Id`. El `DeleteData` de la migracion de eliminacion disparo un `FOREIGN KEY constraint failed`, lo cual al menos falla ruidosamente. Si la relacion hubiera estado configurada con borrado en cascada, se habria llevado los pedidos silenciosamente. La opcion B (editar quitando el `DeleteData`) es el arreglo. Consulta el [arreglo de FOREIGN KEY constraint failed](/es/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) para la mecanica de por que el borrado se propaga.
- **Solo se implemento el overload async, asi que `dotnet ef database update` no sembro nada.** El tooling llama al `UseSeeding` sincrono. La aplicacion funcionaba en produccion (ruta de arranque async) pero el `database update` de CI produjo una tabla de lookup vacia y las pruebas de integracion fallaron. Implementa ambos, siempre.
- **La comprobacion de existencia consultaba un `DateTime`, no una clave.** Alguien escribio el guardia como `if (!context.Set<User>().Any(u => u.CreatedAt == seedTime))`. Como `CreatedAt` era `DateTime.UtcNow`, la comprobacion nunca coincidia y el seeder insertaba un nuevo admin en cada arranque. Guardate sobre una clave natural estable (el email, el nombre del estado), nunca sobre una columna no determinista. El patron completo esta en [como sembrar datos con UseSeeding y UseAsyncSeeding](/es/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).
- **Sembrar en el arranque de cada instancia requeria permiso de escritura en todas partes.** `UseSeeding` se ejecuta en `Migrate` en cada replica. Si tus pods de aplicacion de produccion corren con permisos de base de datos mayormente de lectura, el callback del seed lanza. Para produccion, prefiere un paso de inicializacion de una sola vez en tiempo de despliegue en lugar de sembrar en cada arranque; `UseSeeding` brilla para dev local y pruebas.
- **Un movimiento parcial dejo una fila `HasData` de la que otros seeds dependian.** Migrar la mitad de los seeds significo que una insercion de callback de arranque referenciaba una fila de lookup que la migracion de eliminacion acababa de borrar. Mueve juntos los seeds dependientes, o manten el lookup en `HasData` y mueve solo los datos dependientes.

Si tus entidades son records, nada de esto cambia: [los records funcionan correctamente con EF Core 11](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/) bajo tanto `HasData` como `UseSeeding`. Y si estas ajustando la capa de datos mientras estas aqui, la misma disciplina de "que se ejecuta y cuando" aparece en [los interceptores de EF Core 11 para auditoria](/es/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Relacionado

- [HasData vs UseSeeding para sembrar datos en EF Core 11](/es/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/)
- [Como sembrar datos con UseSeeding y UseAsyncSeeding en EF Core 11](/es/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [Migrar de EF Core 6 a EF Core 11: cambios rompedores que de verdad muerden](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix: FOREIGN KEY constraint failed al borrar una entidad en EF Core 11](/es/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [Como usar records con EF Core 11 correctamente](/es/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Fuentes

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)

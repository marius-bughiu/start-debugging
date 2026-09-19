---
title: "Migra una app de EF Core con Cosmos tras el cambio en el escape de los id generados en EF Core 11"
description: "EF Core 11 deja de escapar '/', '\\', '?' y '#' en los valores id generados para Cosmos DB, así que los documentos escritos por EF Core 8-10 dejan de resolverse por clave. Cómo saber si te afecta, cuándo activar el switch EscapeIllegalCosmosIdCharacters y cómo reescribir los id de forma segura con un lote transaccional."
pubDate: 2026-09-19
updatedDate: 2026-09-19
template: migration
tags:
  - "migration"
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
lang: "es"
translationOf: "2026/09/migrate-an-ef-core-cosmos-app-after-the-generated-id-escaping-change"
translatedBy: "claude"
translationDate: 2026-09-19
---

EF Core 11 cambia la forma en que el proveedor de Azure Cosmos DB construye el `id` de un documento cuando ese `id` está formado por más de un valor. EF Core 8, 9 y 10 reemplazaban `/`, `\`, `?` y `#` en cada parte por `^2F`, `^5C`, `^3F` y `^23`. EF Core 11 (el cambio llegó en la versión preliminar 5 de 11.0, y lo verifiqué en 11.0.0 RC 1) escribe los caracteres tal cual. Si ninguno de los valores de tus claves compuestas contiene esos cuatro caracteres, la actualización no cambia nada y puedes dejar de leer después de la siguiente sección. Si alguno los contiene, `FindAsync` y las búsquedas por clave dejan de encontrar esos documentos tras la actualización. Entonces tienes dos opciones: activar el switch `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters` antes de que arranque la app, o reescribir los id afectados. Para las claves que contienen `/` o `\`, el switch es la única opción que funciona, porque Cosmos DB rechaza esos caracteres en un `id`. Calcula alrededor de una hora para la auditoría; la mayoría de los equipos no encontrará nada que hacer.

## A quién le afecta realmente

El escape solo se aplicaba a los id de varias partes. Leí `JsonIdDefinition` en la etiqueta de EF Core 11 RC 1: una clave formada por un solo valor se escribe tal cual, y el escape solo ocurre cuando se unen varios valores con `|`. Las propiedades de la clave de partición se quitan del id antes de esa comprobación. Así que un tipo de entidad entra en el alcance solo si se cumple una de estas condiciones:

- Su clave primaria sigue teniendo dos o más propiedades después de quitar las propiedades de la clave de partición. Por ejemplo, `HasKey(x => new { x.TenantId, x.OrderId, x.Sku })` con `HasPartitionKey(x => x.TenantId)` da el id `OrderId|Sku`.
- Usa `HasDiscriminatorInJsonId()`. Las apps que se actualizaron desde EF Core 8 a menudo lo activaron en EF Core 9 para conservar sus antiguos id `Post|1`, así que esta es la forma más común de verse afectado.

Además, uno de los valores de la clave tiene que contener `/`, `\`, `?` o `#`. Las claves GUID y enteras no pueden. Las claves de tipo string con texto libre o con forma de ruta (SKU como `shoes/red`, slugs como `2026/09/hello`, nombres de archivo, URL) son donde esto muerde.

Pasé las mismas entidades por EF Core 10.0.12 y EF Core 11.0.0 RC 1 sin base de datos. Agregar una entidad a un `DbContext` ejecuta el generador de valores del id, así que el id generado se puede leer directamente del change tracker:

| Valores de la clave | EF Core 10.0.12 | EF Core 11 RC 1 | EF Core 11 RC 1 + switch |
| ---------- | --------------- | --------------- | ------------------------ |
| `o-1`, `shoes/red` | `o-1\|shoes^2Fred` | `o-1\|shoes/red` | `o-1\|shoes^2Fred` |
| `o-1`, `shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` |
| `o-1`, `C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` | `o-1\|C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` |
| `o-1`, `a\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` |
| clave única `shoes/red` | `shoes/red` | `shoes/red` | `shoes/red` |
| `HasDiscriminatorInJsonId`, `2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` | `LegacyPost\|2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` |

Las dos primeras filas son el motivo del cambio ([dotnet/efcore#38244](https://github.com/dotnet/efcore/issues/38244)). El carácter de escape `^` nunca se escapaba a sí mismo, así que `shoes/red` y `shoes^2Fred` obtenían el mismo id y la segunda inserción sobrescribía en silencio el primer documento. El equipo de EF decidió dejar de escapar en lugar de escapar también `^`, porque escapar `^` habría roto todos los id existentes que contienen un acento circunflejo. La corrección es [dotnet/efcore#38245](https://github.com/dotnet/efcore/pull/38245), fusionada el 2026-05-08. Ten en cuenta que el separador `|` se sigue escapando como `^|` en ambas versiones, así que esa parte de tus id no cambia.

## Qué se rompe

| Área | Cambio tras actualizar a EF Core 11 | Gravedad |
| ---- | ------------------------------------ | -------- |
| `FindAsync`, y las consultas que filtran por la clave completa más la clave de partición | EF las convierte en una lectura puntual usando el id recién generado, así que los documentos guardados con un id escapado devuelven `null` o un resultado vacío | alta |
| Insertar una entidad cuya clave coincide con un documento antiguo | El nuevo id es distinto, así que para `?` y `#` obtienes un segundo documento con los mismos valores de clave en lugar de un conflicto | alta |
| Claves nuevas que contienen `/` o `\` | EF 11 ahora envía esos caracteres en el id, y el servicio de Cosmos DB no permite `/` ni `\` en un id ([límites del servicio](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)), así que la escritura falla | alta |
| Actualizaciones y eliminaciones de entidades cargadas por una consulta | Siguen funcionando: `SaveChanges` usa el valor `__id` que se materializó desde el documento, no uno generado de nuevo | ninguna |
| Consultas que no filtran por la clave completa | Siguen funcionando, no usan el id | ninguna |

La segunda fila es la peligrosa. El patrón habitual de "búscalo y agrégalo si falta" devuelve `null` para el documento antiguo y crea un duplicado junto a él. No se lanza ninguna excepción.

## Lista de comprobación previa

- La app compila contra `Microsoft.EntityFrameworkCore.Cosmos` 11.0.0-rc.1.26425.128 (o la versión GA cuando salga), y leíste el resto de los [cambios importantes de EF Core 11](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes). El proveedor de Cosmos tiene varios cambios en 11, incluida la eliminación de la E/S síncrona y del round-tripping de propiedades no mapeadas.
- Tienes acceso con Data Explorer o con el SDK a cada contenedor en el que escribe EF.
- El backup continuo o la restauración a un punto en el tiempo está habilitado en la cuenta antes de reescribir ningún id.
- Sabes qué propiedades de clave contienen strings proporcionados por usuarios o de texto libre.

## Pasos de migración

1. **Lista los tipos de entidad con id de varias partes.**
   Esto recorre el modelo de EF con las APIs públicas de metadatos de Cosmos y aplica la misma regla que usa el proveedor:

   ```csharp
   // EF Core 11.0 RC 1, .NET 11 RC 1
   foreach (var entityType in db.Model.GetEntityTypes().Where(t => !t.IsOwned()))
   {
       var key = entityType.FindPrimaryKey()!;
       var partitionKeyNames = entityType.GetPartitionKeyPropertyNames();
       var idParts = key.Properties.Count(p => !partitionKeyNames.Contains(p.Name));
       var discriminatorInId = entityType.GetDiscriminatorInKey()
           is IdDiscriminatorMode.EntityType or IdDiscriminatorMode.RootEntityType;

       Console.WriteLine($"{entityType.DisplayName(),-12} container={entityType.GetContainer(),-8} " +
           $"id parts={idParts} discriminator in id={discriminatorInId} " +
           $"-> {(idParts > 1 || discriminatorInId ? "AFFECTED" : "not affected")}");
   }
   ```

   Para un modelo con un `OrderLine` particionado (clave `TenantId, OrderId, Sku`) y un `Product` de clave única, imprime:

   ```text
   OrderLine    container=Orders   id parts=2 discriminator in id=False -> AFFECTED
   Product      container=Catalog  id parts=1 discriminator in id=False -> not affected
   ```

   Verifica: cada tipo de entidad marcado como `AFFECTED` tiene al menos una propiedad de clave `string`. Si todas son `Guid`, `int` o `long`, terminaste. EF Core 11 genera para ellas los mismos id que EF Core 10.

2. **Cuenta los documentos que realmente llevan una secuencia de escape.**
   Ejecuta esto en Data Explorer contra cada contenedor que tenga un tipo afectado:

   ```sql
   -- Azure Cosmos DB for NoSQL
   SELECT c.id, c["$type"] FROM c
   WHERE CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C")
      OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23")
   ```

   `$type` es el nombre del discriminador JSON que EF escribe desde EF Core 9. EF Core 11 renombró la propiedad del modelo a `Discriminator`, pero el nombre en el JSON sigue siendo `$type`. Verifica: cero filas significa que ningún documento guardado cambiará su id. Entonces la única pregunta abierta es si las claves *nuevas* pueden contener esos caracteres, y el paso 3 sigue aplicando a ellas.

3. **Decide: conservar el escape antiguo o pasar a id sin escapar.**
   Usa esta regla:

   - Las claves pueden contener `/` o `\`: conserva el escape antiguo con el switch (paso 4). Los id sin escapar que contienen esos caracteres no se pueden guardar en Cosmos DB, así que no hay nada a lo que migrar. La única alternativa es cambiar los propios valores de la clave.
   - Las claves solo pueden contener `?` o `#`: puedes reescribir los id (paso 5) y abandonar el escape antiguo para siempre. Eso también elimina el bug de colisión.
   - Los valores de la clave pueden venir de los usuarios: ten en cuenta que, con el switch activado, un usuario que envíe el string literal `shoes^2Fred` puede sobrescribir `shoes/red`. Si eso importa, valida la entrada de la clave para que nunca contenga `^`.

   Verifica: anota la decisión por cada tipo de entidad. Un contenedor mixto puede necesitar ambas.

4. **Si conservas el escape, activa el switch antes de que se cargue EF.**
   El proveedor lee el switch una sola vez, en un campo `static readonly` de `JsonIdDefinition`. El lugar más seguro para él es el archivo del proyecto, porque MSBuild lo escribe en `runtimeconfig.json`:

   ```xml
   <!-- EF Core 11.0, .NET 11 -->
   <ItemGroup>
     <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters"
                                     Value="true" />
   </ItemGroup>
   ```

   `AppContext.SetSwitch("Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters", true)` también funciona, siempre que sea la primera línea de `Program.cs`, antes de que se haya creado cualquier `DbContext`. Verifícalo con el propio generador de id (paso 6). Probé tanto la entrada en `runtimeconfig.json` como una llamada a `SetSwitch` al inicio en RC 1, y ambas dieron `o-1|shoes^2Fred`.

5. **Si pasas a id sin escapar, reescribe los documentos en su lugar.**
   Cosmos DB no puede renombrar un `id`, así que cada documento se vuelve a crear con el nuevo id y el antiguo se elimina. Ambos documentos comparten clave de partición, así que un lote transaccional hace que el intercambio sea atómico. Calcula el nuevo id con el propio EF Core 11 en lugar de reimplementar el formato: agrega una instancia que solo tenga la clave a un contexto desechable y lee `__id`. Haz la reescritura con el JSON en bruto y no a través de EF, porque EF Core 11 ya no conserva las propiedades JSON que no están mapeadas en el modelo, así que guardar a través de EF las perdería.

   ```csharp
   // EF Core 11.0 RC 1, Microsoft.Azure.Cosmos 3.x, .NET 11 RC 1
   // Run with the switch OFF, so EF generates the new ids.
   using var client = new CosmosClient(connectionString);
   var container = client.GetContainer("shop", "Orders");
   var query = new QueryDefinition(
       """
       SELECT * FROM c
       WHERE c["$type"] = "OrderLine"
         AND (CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C") OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23"))
       """);

   await using var idContext = new ShopContext(connectionString); // never saved
   using var iterator = container.GetItemQueryStreamIterator(query);
   while (iterator.HasMoreResults)
   {
       using var page = await iterator.ReadNextAsync();
       page.EnsureSuccessStatusCode();
       var documents = JsonNode.Parse(page.Content)!["Documents"]!.AsArray();

       foreach (var doc in documents.Select(d => d!.AsObject()))
       {
           var oldId = (string)doc["id"]!;
           var line = new OrderLine
           {
               TenantId = (string)doc["TenantId"]!,
               OrderId = (string)doc["OrderId"]!,
               Sku = (string)doc["Sku"]!,
           };
           var entry = idContext.Add(line);
           var newId = (string)entry.Property("__id").CurrentValue!;
           entry.State = EntityState.Detached;

           if (newId == oldId) continue; // the key really contains "^2F"
           if (newId.Contains('/') || newId.Contains('\\'))
           {
               Console.WriteLine($"BLOCKED  {oldId} -> {newId}");
               continue;
           }

           Console.WriteLine($"{(apply ? "REWRITE " : "DRY RUN ")} {oldId} -> {newId}");
           if (!apply) continue;

           var etag = (string)doc["_etag"]!;
           foreach (var system in new[] { "_rid", "_self", "_etag", "_attachments", "_ts" })
               doc.Remove(system);
           doc["id"] = newId;

           using var body = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(doc));
           using var result = await container
               .CreateTransactionalBatch(new PartitionKey(line.TenantId))
               .CreateItemStream(body)
               .DeleteItem(oldId, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag })
               .ExecuteAsync();

           if (!result.IsSuccessStatusCode)
               Console.WriteLine($"  FAILED {result.StatusCode}: {result.ErrorMessage}");
       }
   }
   ```

   La clave se lee de las propias propiedades del documento, no se recupera del id escapado. Eso es lo que hace que la herramienta sea segura para el caso de colisión: un documento guardado como `o-1|shoes^2Fred` cuyo `Sku` realmente es `shoes^2Fred` produce el mismo id en EF 11, así que se omite. Ejecuté la lógica del id sin conexión en RC 1 contra cuatro documentos de ejemplo. Imprimió `BLOCKED o-1|shoes^2Fred -> o-1|shoes/red`, `DRY RUN o-1|gift^23card -> o-1|gift#card`, `DRY RUN o-1|what^3F -> o-1|what?`, y omitió el del literal `shoes^2Fred`. No ejecuté el lote contra una cuenta real ni contra el emulador, así que ejecuta primero la simulación y luego `--apply` contra una copia restaurada de la base de datos. El `IfMatchEtag` en la eliminación hace que el lote falle en lugar de perder una escritura concurrente. Si falla, vuelve a ejecutar la herramienta. Verifica: la consulta del paso 2 devuelve solo documentos `BLOCKED`, o ninguno.

6. **Fija el formato del id con una prueba.**
   El generador de id se ejecuta en `Add`, así que una prueba unitaria puede comprobar el formato sin Cosmos DB:

   ```csharp
   // EF Core 11.0 RC 1, xUnit v3
   [Theory]
   [InlineData("shoes/red", "o-1|shoes^2Fred")] // expected with the switch on
   [InlineData("gift#card", "o-1|gift^23card")]
   public void Generated_id_matches_stored_documents(string sku, string expectedId)
   {
       using var db = new ShopContext("AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdA==");
       var entry = db.Add(new OrderLine { TenantId = "t1", OrderId = "o-1", Sku = sku });
       Assert.Equal(expectedId, entry.Property("__id").CurrentValue);
   }
   ```

   Verifica: la prueba pasa en CI con el mismo `runtimeconfig.json` con el que se distribuye la app. Si alguien quita el `RuntimeHostConfigurationOption`, falla esta prueba en lugar de producción.

## Verificación

Después de implementar EF Core 11, comprueba estas tres cosas contra datos reales:

- `await db.OrderLines.FindAsync("t1", "o-1", "shoes/red")` (una clave que antes se escapaba) devuelve la entidad y no `null`.
- La consulta del paso 2 devuelve el mismo recuento que antes si conservaste el switch, y cero (aparte de las filas `BLOCKED`) si migraste.
- Una consulta de duplicados no devuelve nada: `SELECT c.TenantId, c.OrderId, c.Sku, COUNT(1) AS n FROM c GROUP BY c.TenantId, c.OrderId, c.Sku`, y luego busca cualquier `n` mayor que 1. Eso detecta las inserciones duplicadas silenciosas de la tabla "Qué se rompe".

## Plan de reversión

Conservar el switch es totalmente reversible: quita la actualización del paquete y EF Core 10 genera los mismos id de siempre. Reescribir los id no se revierte volviendo a implementar. EF Core 10 vuelve a generar id escapados y no puede encontrar los documentos reescritos. Así que reescribir te compromete con EF Core 11. Si necesitas una vía de vuelta, restaura el contenedor desde el backup que hiciste antes de la reescritura, o implementa EF Core 11 con el switch activado (los id antiguos siguen siendo válidos con él) y vuelve a ejecutar la herramienta a la inversa. Prueba ese camino antes de depender de él.

## Trampas

- **El nombre del switch circula con dos grafías.** El issue y un comentario de código en `JsonIdDefinition` dicen `Microsoft.EntityFrameworkCore.EscapeIllegalIdCharacters`. El código en realidad lee `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters`, que es también lo que dice la documentación de cambios importantes. Puse el nombre corto en `runtimeconfig.json` en RC 1 y no tuvo efecto: los id siguieron sin escapar.
- **Activar el switch tarde no hace nada.** En mi prueba, `AppContext.SetSwitch` llamado después de que el primer `DbContext` hubiera generado un id se ignoró, y el siguiente contexto siguió produciendo `o-2|shoes/red`. Las apps hospedadas que activan switches desde la configuración después de `builder.Build()` caen en esto.
- **Los id de clave única nunca se escaparon.** Un `Product` con `Id = "shoes/red"` siempre se escribió como `shoes/red`, en 10 y en 11, así que la restricción de Cosmos DB sobre `/` ya le aplicaba. El cambio solo afecta a los id formados por varios valores.
- **Las propiedades de la clave de partición no forman parte del id.** Cuando revises tus claves, ignora las propiedades que pasas a `HasPartitionKey`. Esos valores pueden contener cualquier cosa, porque el proveedor los envía como clave de partición y no en el id.
- **Los lotes son por partición y tienen un tope de 100 operaciones.** La herramienta emite un lote por documento para que los fallos queden localizados. Si agrupas varios documentos en un lote, agrúpalos por clave de partición y mantente por debajo del límite.

## Relacionado

- La herramienta de reescritura se apoya en el mismo mecanismo que EF Core 11 usa ahora en cada `SaveChanges`: [EF Core 11 activa los lotes transaccionales de Cosmos DB por defecto](/es/2026/04/efcore-11-cosmos-transactional-batches/).
- Si te saltas varias versiones mayores de golpe, [migrar de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) enumera los demás cambios importantes que encontrarás por el camino.
- Otro valor por defecto de EF Core 11 que cambia en silencio con una actualización: [nivel de compatibilidad de SQL Server 150 vs 160](/es/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/).
- Para registrar cada lectura puntual y ver qué id le pide EF a Cosmos DB, [un interceptor de EF Core](/es/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) es el gancho más ligero.
- Si los tipos owned de tus documentos de Cosmos también están en la lista de la actualización, consulta [tipos complejos vs entidades owned en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/).

## Fuentes

- [Cambios importantes de EF Core 11: los caracteres `id` no válidos de Cosmos ya no se escapan](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes#cosmos-no-id-escape)
- [dotnet/efcore#38244: Generated `id` values can collide when key values contain escape sequences](https://github.com/dotnet/efcore/issues/38244)
- [dotnet/efcore#38245: Don't escape illegal id characters](https://github.com/dotnet/efcore/pull/38245)
- [`JsonIdDefinition.cs` en v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinition.cs)
- [`JsonIdDefinitionFactory.cs` en v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinitionFactory.cs)
- [Cuotas del servicio Azure Cosmos DB: caracteres permitidos para el valor de ID](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)
- [Operaciones de lote transaccional en Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [Cambios importantes de EF Core 9: el discriminador ya no se incluye en el `id`](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/breaking-changes#cosmos-id-property-changes)

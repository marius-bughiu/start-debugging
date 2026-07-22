---
title: "TPH vs TPT vs TPC para mapeo de herencia en EF Core 11: ¿cuál deberías elegir?"
description: "En EF Core 11, usa TPH de forma predeterminada para casi toda jerarquía, recurre a TPC solo cuando consultas casi siempre un único tipo hoja y un benchmark demuestra que gana, y usa TPT solo cuando una restricción externa te obligue."
pubDate: 2026-07-22
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
lang: "es"
translationOf: "2026/07/tph-vs-tpt-vs-tpc-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

En EF Core 11 (con .NET 11 y C# 14), mapea una jerarquía de clases con **table-per-hierarchy (TPH)** salvo que tengas una razón medida para no hacerlo. TPH coloca toda la jerarquía en una sola tabla con una columna discriminadora, así que las lecturas son escaneos de una sola tabla sin joins. Recurre a **table-per-concrete-type (TPC)** solo cuando tu código consulta de forma abrumadora un único tipo hoja y un benchmark sobre tus datos demuestra que supera a TPH. Usa **table-per-type (TPT)** solo cuando una restricción externa lo obligue, porque el propio benchmark de Microsoft sitúa a TPT en aproximadamente el doble de tiempo y casi el doble de asignaciones que TPH en una consulta del tipo base. La regla en una línea: TPH por defecto, TPC para cargas de trabajo centradas en tipos hoja que midan más rápido, TPT nunca por elección.

Este artículo es la decisión, no el recorrido completo de configuración. Si quieres la API del discriminador, las columnas compartidas y la mecánica de columnas anulables en profundidad, lee [cómo configurar el mapeo de herencia table-per-hierarchy (TPH) en EF Core 11](/es/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/). Aquí ponemos las tres estrategias lado a lado, mostramos el esquema que genera cada una y nombramos las restricciones que toman la decisión por ti.

## La matriz de características en una pantalla

Toma una jerarquía de dos niveles: una clase base `Blog` y una derivada `RssBlog` que añade un `RssUrl`. Las tres estrategias mapean esto a tres esquemas completamente distintos, y cada compensación de abajo se deriva de esa forma.

| Dimensión                              | TPH                          | TPT                                | TPC                                   |
| -------------------------------------- | ---------------------------- | ---------------------------------- | ------------------------------------- |
| Tablas generadas                       | una, toda la jerarquía       | una por tipo (incluidos abstractos)| una por tipo concreto solamente       |
| Columna discriminadora                 | sí                           | no                                 | no                                    |
| Columnas de tipo derivado              | anulables, tabla compartida  | tabla propia, pueden ser `NOT NULL`| tabla propia, pueden ser `NOT NULL`   |
| Consulta del tipo base (`context.Blogs`)| un `SELECT`, sin join       | `LEFT JOIN` entre todas las tablas | `UNION ALL` entre tablas concretas    |
| Consulta de un tipo hoja (`OfType<RssBlog>`)| predicado discriminador | join tabla base + hoja             | una tabla, sin filtro                 |
| Forma de almacenamiento                | ancha, dispersa, muchos nulls| normalizada, sin nulls             | desnormalizada, columnas repetidas    |
| Generación de claves                   | cualquiera (Identity vale)   | cualquiera (Identity en la base)   | secuencia compartida, sin Identity simple |
| Restricción FK hacia el tipo base      | sí                           | sí                                 | no (la clave vive en la tabla hoja)   |
| Tipos complejos / columnas JSON        | sí                           | sí (nuevo en EF Core 11)           | sí (nuevo en EF Core 11)              |
| Lectura del tipo base: velocidad relativa| más rápida (referencia)    | ~2x más lenta                      | ~igual que TPH                        |
| Postura de Microsoft                   | predeterminada recomendada   | "solo si estás obligado"           | buena para consultas de un tipo hoja  |

El patrón no es sutil. TPH gana o empata en casi toda fila que importa, TPC lo iguala salvo cuando consultas entre tipos, y TPT cambia un esquema de aspecto más limpio por joins que te cuestan en tiempo de consulta. Tres de esas celdas cambiaron en EF Core 11: los tipos complejos y las columnas JSON ahora funcionan en jerarquías TPT y TPC, lo cual antes no estaba soportado y empujaba a la gente de vuelta a las entidades propietarias para cualquier objeto de valor heredado. Eso cierra una de las últimas razones no relacionadas con el rendimiento para evitar TPT y TPC, pero no cambia el veredicto de rendimiento.

## Qué escribe realmente cada estrategia en la base de datos

Los esquemas concretan las compensaciones abstractas. TPH es una sola tabla con un discriminador y columnas derivadas anulables:

```sql
-- TPH: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [RssUrl] nvarchar(max) NULL,          -- nullable: base Blogs have no RssUrl
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);
```

TPT divide cada tipo en su propia tabla, enlazadas por una clave foránea sobre la clave primaria compartida:

```sql
-- TPT: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL,
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId]),
    CONSTRAINT [FK_RssBlogs_Blogs_BlogId] FOREIGN KEY ([BlogId])
        REFERENCES [Blogs] ([BlogId]) ON DELETE NO ACTION
);
```

TPC da a cada tipo concreto una tabla autocontenida con cada columna heredada repetida, con clave basada en una secuencia compartida:

```sql
-- TPC: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,             -- inherited column, repeated here
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId])
);
```

Configurar cada una es una sola línea sobre la entidad raíz. TPH es la predeterminada y no necesita nada; TPT y TPC se activan con una llamada de estrategia de mapeo:

```csharp
// EF Core 11: choosing a strategy on the root entity type
modelBuilder.Entity<Blog>().UseTphMappingStrategy(); // default, can be omitted
modelBuilder.Entity<Blog>().UseTptMappingStrategy(); // one table per type
modelBuilder.Entity<Blog>().UseTpcMappingStrategy(); // one table per concrete type
```

## Cuándo elegir TPH

TPH es la respuesta correcta para la gran mayoría de jerarquías. Elígela cuando:

- **Consultas a través de la jerarquía.** Cualquier código que lea el tipo base (una lista de todas las filas `Payment`, un panel que mezcla `CardPayment` y `BankTransferPayment`) es un escaneo de una tabla indexada bajo TPH. No hay join ni `UNION`. Este es el patrón de acceso más común, y es exactamente donde TPT falla.
- **La jerarquía es superficial o los tipos derivados añaden pocas columnas.** Dos o tres subtipos que añaden un puñado de propiedades cada uno producen una tabla solo levemente dispersa. Las bases de datos manejan bien las columnas vacías, y en SQL Server puedes marcar columnas TPH poco pobladas como [columnas dispersas (sparse columns)](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns) para recuperar el espacio.
- **Quieres las escrituras más simples.** Un insert TPH es una fila en una tabla. `ExecuteUpdate` y `ExecuteDelete` contra un tipo derivado aplican el predicado discriminador por ti y tocan una sola tabla, que es la ruta limpia de escritura masiva descrita en [cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/).
- **Necesitas una clave foránea hacia el tipo base.** Como cada fila vive en una tabla, una relación que apunta al tipo base obtiene una restricción FK real. TPC no puede imponer esa restricción, como se cubre más abajo.

El único costo que aceptas es que una propiedad requerida en un tipo derivado igualmente se mapea a una columna anulable, porque las filas hermanas la dejan vacía. Si la no-nulidad impuesta por la base de datos en propiedades derivadas es un requisito estricto, esa es la razón clásica para dejar TPH, y apunta a TPT.

## Cuándo elegir TPC

TPC es el especialista. Iguala a TPH de cerca en consultas entre tipos y se adelanta en una forma específica:

- **Casi siempre consultas un único tipo hoja.** Si tu ruta caliente es `context.RssBlogs.Where(...)` y rara vez `context.Blogs`, TPC lee una tabla autocontenida sin filtro discriminador y sin join. La guía de Microsoft es explícita: TPC destaca "al consultar entidades de un único tipo hoja". Mídelo contra TPH sobre tus datos antes de comprometerte, porque la ganancia depende de la carga de trabajo.
- **Quieres columnas derivadas no nulas sin los joins de TPT.** Cada tabla TPC contiene todas las columnas de un tipo concreto en línea, así que una propiedad derivada requerida puede ser `NOT NULL` en su propia tabla, y leer ese tipo sigue siendo de una sola tabla. Esa es la propiedad que TPT compra con un join y TPC compra sin él.

El precio es un esquema desnormalizado y claves incómodas. TPC no puede usar una columna `Identity` simple, porque no hay una única tabla que posea la secuencia; EF Core 11 usa por defecto una secuencia de base de datos compartida (`NEXT VALUE FOR [BlogSequence]`) para que las claves sigan siendo únicas entre tablas hermanas. En SQLite, que no tiene secuencias, la generación de claves enteras no está disponible para TPC y recurres a GUIDs generados en el cliente. Y como la clave primaria de un tipo base puede vivir en cualquier tabla concreta, una clave foránea que referencie el tipo base no puede imponerse con una restricción de base de datos en absoluto. Si todas tus escrituras pasan por EF Core con navegaciones, eso suele estar bien, pero es una pérdida real de integridad a nivel de base de datos.

## Cuándo elegir TPT (y por qué la respuesta suele ser "no lo hagas")

TPT produce el esquema que más se parece a tu diagrama de clases: una tabla por tipo, unidas por la clave. Esa estética es la trampa. Recurre a TPT solo cuando:

- **Una restricción externa dicta el esquema.** Un DBA obliga a una tabla normalizada por tipo, un esquema heredado que no puedes cambiar ya luce así, u otro sistema lee las tablas por tipo directamente. Estos son los casos de "estar obligado a hacerlo por factores externos" que Microsoft nombra.
- **Realmente necesitas tablas por tipo con restricciones FK y columnas derivadas no nulas y las consultas entre tipos son raras.** Esta es una intersección estrecha, e incluso entonces deberías hacer benchmark contra TPC primero.

No elijas TPT porque se sienta más limpio. Cada consulta del tipo base hace join entre todo el conjunto de tablas, y los joins son una de las principales fuentes de problemas de rendimiento relacional. Los números lo respaldan, que es la siguiente sección.

## El benchmark: TPT cuesta aproximadamente 2x

Esto no es palabrería. El propio benchmark de herencia de Microsoft arma una jerarquía de 7 tipos, siembra 5000 filas por tipo (35000 filas en total) y carga cada fila de la base de datos. Los resultados:

| Método | Media     | Asignado  |
| ------ | --------- | --------- |
| TPH    | 149.0 ms  | 40 MB     |
| TPT    | 312.9 ms  | 75 MB     |
| TPC    | 158.2 ms  | 46 MB     |

TPT es aproximadamente 2.1x más lento que TPH y asigna casi el doble de memoria, porque cargar la jerarquía hace join de siete tablas. TPC queda dentro de un 6 por ciento de TPH en esta consulta de todos los tipos, y se adelantaría a TPH en una consulta de un solo tipo hoja donde lee una tabla y TPH todavía escanea la tabla compartida con un filtro discriminador. La metodología importa: esta es una consulta del tipo base que toca cada tabla, que es el peor caso de TPC y de TPT, así que la brecha que veas en tu carga de trabajo depende de con qué frecuencia consultas entre tipos frente a un tipo hoja. Aun así, la conclusión es estable entre ejecuciones: TPT paga un impuesto de join que TPH y TPC no pagan, y ningún argumento de estética de esquema lo recupera.

Ejecuta el benchmark contra tu propio modelo antes de tomar una decisión irreversible. Cambiar una estrategia de herencia después de tener datos en producción significa una migración de esquema que mueve filas entre tablas, así que esta es una decisión que vale la pena medir una vez, temprano.

## Las trampas que deciden por ti

Tres restricciones pueden decidir la estrategia independientemente de la preferencia.

La primera es la **no-nulidad impuesta por la base de datos en una propiedad derivada**. TPH no puede hacerlo, porque la columna compartida tiene que ser anulable para las filas hermanas. Si necesitas que la base de datos (no solo tu aplicación) garantice que cada `CardPayment` tiene un `Last4`, necesitas esa columna en su propia tabla, lo que significa TPT o TPC.

La segunda es la **generación de claves en tu base de datos**. TPC necesita secuencias para claves enteras. En SQL Server eso es automático, pero en SQLite no puedes usar claves de identidad enteras con TPC en absoluto y debes cambiar a GUIDs. Si estás en SQLite y quieres claves enteras, TPC queda descartado.

La tercera es la **integridad de clave foránea hacia el tipo base**. Si otras tablas referencian tu tipo base y quieres que la base de datos imponga esas referencias, TPC no puede darte la restricción. TPH y TPT sí. Esto por sí solo descarta a TPC para muchos esquemas normalizados.

Una cosa igual en las tres: no puedes cambiar el tipo de una entidad en tiempo de ejecución. Convertir un `CardPayment` en un `BankTransferPayment` es un delete más un insert en cada estrategia, porque el discriminador (o la tabla misma) codifica el tipo. Eso es una realidad de modelado, no un diferenciador.

## La recomendación, dicha claramente

Usa TPH por defecto. Es la más rápida para la consulta común entre tipos, la más simple para escribir contra ella, la única estrategia sin fricción de generación de claves, y la predeterminada recomendada por Microsoft para un amplio rango de escenarios. Recurre a TPC solo cuando tu carga de trabajo esté dominada por consultas de un único tipo hoja y un benchmark sobre tus datos demuestre que supera a TPH, y acepta el esquema desnormalizado, las claves de secuencia compartida y la restricción FK hacia el tipo base ausente que la acompañan. Usa TPT solo cuando un factor externo no te deje elección, y hazlo sabiendo que pagas un impuesto de consulta de aproximadamente 2x por un esquema que luce más ordenado.

El modelo mental es el mismo que imponen los números: una tabla es rápida, muchas tablas unidas por join son lentas, y muchas tablas sin join son rápidas pero desnormalizadas. Si esta decisión es parte de una actualización de versión más amplia, los cambios de herencia y mapeo tienden a aparecer junto a los de la [guía de migración de EF Core 6 a EF Core 11](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Lecturas relacionadas

- [Cómo configurar el mapeo de herencia table-per-hierarchy (TPH) en EF Core 11](/es/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) es el recorrido completo de TPH: API del discriminador, columnas compartidas y la regla de columnas anulables.
- [Tipos complejos vs entidades propietarias en EF Core 11](/es/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) cubre el mapeo de objetos de valor, que ahora funciona dentro de jerarquías TPT y TPC.
- [Cómo mapear y consultar columnas JSON en EF Core 11](/es/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) explica el almacenamiento JSON que las jerarquías de herencia ganaron en EF Core 11.
- [Cómo usar ExecuteUpdate y ExecuteDelete para escrituras masivas en EF Core 11](/es/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) muestra la ruta de escritura masiva de una sola tabla que TPH hace limpia.
- [Cómo detectar consultas N+1 en EF Core 11](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11) ayuda a atrapar los patrones de consulta con muchos joins que TPT puede fomentar.

## Fuentes

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Modeling for performance: inheritance mapping (with the TPH/TPT/TPC benchmark)](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core inheritance benchmark source](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Benchmarks/Inheritance.cs)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [SQL Server sparse columns](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns)

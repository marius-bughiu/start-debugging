---
title: "Tipos complejos vs entidades propias en EF Core 11: ¿cuál deberías elegir?"
description: "En EF Core 11, usa por defecto tipos complejos para los objetos de valor y recurre a entidades propias solo cuando necesites una tabla separada o una colección mapeada a sus propias filas."
pubDate: 2026-07-22
tags:
  - "comparison"
  - "complex-types"
  - "owned-entities"
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
lang: "es"
translationOf: "2026/07/complex-types-vs-owned-entities-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

En EF Core 11 (con .NET 11 y C# 14), mapea un objeto de valor como `Address`, `Money` o `DateRange` como un **tipo complejo**, y recurre a una **entidad propia** solo cuando la forma de almacenamiento te obligue: el valor necesita su propia tabla, o necesitas una colección almacenada como filas separadas. Ese único eje decide casi todos los casos. Los tipos complejos tienen semántica de valor y no tienen identidad, que es exactamente lo que es un objeto de valor; las entidades propias son tipos de entidad completos disfrazados de objeto de valor, y el disfraz se cae constantemente. EF Core 11 es la versión en la que las últimas razones para preferir entidades propias prácticamente desaparecieron, porque los tipos complejos ahora funcionan con herencia TPT/TPC, admiten `ExecuteUpdate`, permiten colecciones cuando se mapean a JSON, y pueden llevar claves e índices.

Este post es la decisión, no la mecánica. Si quieres la configuración paso a paso, lee [cómo mapear un tipo complejo en lugar de una entidad propia en EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Aquí comparamos los dos mapeos frente a frente, mostramos dónde gana cada uno, y nombramos las trampas que deciden por ti.

## La matriz de características en una pantalla

La razón de que existan ambos mapeos es que responden preguntas diferentes. Una entidad propia es la forma que tiene EF Core de decir "esta es una entidad dependiente que almaceno dentro de su propietaria". Un tipo complejo es la forma que tiene EF Core de decir "esto es un valor, sin identidad propia". Todo lo de abajo se deriva de eso.

| Dimensión                                  | Tipo complejo                        | Entidad propia                        |
| ------------------------------------------ | ------------------------------------ | ------------------------------------- |
| Tipo de modelo subyacente                  | valor, sin clave                     | entidad, clave primaria en sombra     |
| Semántica de identidad                     | por valor (contenido)                | por referencia (identidad)            |
| `a == b` en LINQ compara                   | contenido                            | identidad                             |
| Asignar copia campos (`x.A = x.B`)         | sí, copia                            | lanza (referencia compartida)         |
| Misma tabla que la propietaria (table splitting) | sí (por defecto)               | sí (por defecto)                      |
| Tabla separada (`ToTable`)                 | no                                   | sí                                    |
| Columna JSON única (`ToJson`)              | sí                                   | sí                                    |
| Colección como filas hijas separadas       | no                                   | sí (`OwnsMany`)                       |
| Colección dentro de un documento JSON       | sí (`ComplexCollection` + `ToJson`)  | sí (`OwnsMany` + `ToJson`)            |
| `ExecuteUpdate` en un miembro anidado       | sí (EF Core 11)                      | no                                    |
| El tipo CLR puede ser `struct` o `record`   | sí                                   | solo tipo de referencia               |
| Claves / índices sobre escalar anidado      | sí (EF Core 11)                      | sí                                    |
| Herencia TPT / TPC en la propietaria        | sí (EF Core 11)                      | sí                                    |
| Huella en el rastreador de cambios         | a nivel de columna, sin nodo separado | nodo rastreado separado + clave en sombra |

Lee esa tabla de arriba abajo y el patrón es obvio: los tipos complejos ganan cada fila que trata sobre semántica, y las entidades propias ganan las dos filas que tratan sobre la forma de almacenamiento (tabla separada, filas hijas separadas). Esa es toda la comparación en miniatura. Las versiones importan aquí porque tres de esas celdas "sí" para los tipos complejos solo se volvieron ciertas en EF Core 11; en EF Core 9 el cálculo era diferente.

## Cuándo elegir un tipo complejo

Recurre a `ComplexProperty` (o al atributo `[ComplexType]`) en estos casos, que cubren la gran mayoría de los objetos de valor en una base de código real:

- **El tipo está definido enteramente por sus datos.** `Address`, `Money`, `GeoPoint`, `DateRange`, `PersonName`. Si dos instancias con campos idénticos son intercambiables, es un valor, y un valor quiere semántica de valor. En EF Core 11 escribes `b.ComplexProperty(c => c.ShippingAddress)` y los campos aterrizan en línea en la tabla de la propietaria.
- **Quieres asignar o comparar el valor de forma natural.** `customer.BillingAddress = customer.ShippingAddress` copia los campos y guarda limpiamente, y `Where(c => c.BillingAddress == c.ShippingAddress)` filtra por contenido. Ambas cosas están rotas con entidades propias, como se cubre más abajo.
- **Quieres que las escrituras masivas alcancen el interior del valor.** EF Core 11 admite `ExecuteUpdate` en miembros de tipos complejos: `ExecuteUpdateAsync(s => s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"))`. Las entidades propias nunca han permitido esto. Si te importa la ruta de escritura rápida, esto solo es decisivo; los compromisos son los mismos que en [ExecuteUpdate vs cargar entidades y SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).
- **El valor es un `struct` o un `record`.** Las entidades propias deben ser tipos de referencia que EF Core pueda clavar y rastrear. Un tipo complejo puede ser un `readonly struct Money` o un `record`, lo cual encaja con la idea de "sin identidad". La interacción con los records vale la pena leerla completa en [cómo usar records con EF Core 11 correctamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

La guía de Microsoft no es sutil sobre este valor por defecto. Las notas de la versión de EF Core 11 declaran que el trabajo de estabilización de los tipos complejos se hizo específicamente "para desbloquear el uso de tipos complejos como alternativa al enfoque de mapeo de entidades propias", y las notas de EF Core 10 les dijeron a los usuarios existentes de entidades propias que cambiaran. Trata los tipos complejos como el valor por defecto y las entidades propias como la excepción.

## Cuándo elegir una entidad propia

Hay exactamente dos razones estructurales y una razón de modelado para quedarse con `OwnsOne` / `OwnsMany`:

- **El valor debe vivir en su propia tabla.** Los tipos complejos siempre están en línea: ya sea columnas con table splitting en la propietaria, o una columna JSON en la propietaria. No existe `ComplexProperty(...).ToTable("Addresses")`. Si tu esquema requiere los datos en una tabla separada con una clave foránea de vuelta a la propietaria (una vista de reporte se apoya en ella, otra tabla la referencia, un DBA lo exige), eso es una entidad propia mapeada con `OwnsOne(...).ToTable(...)`.
- **Necesitas una colección como filas separadas.** Una relación uno a muchos de objetos de valor que deben ser cada uno su propia fila en una tabla hija es `OwnsMany`. Un tipo complejo con table splitting debe ser un único valor, y aunque EF Core 11 agregó `ComplexCollection` para las colecciones, esas se almacenan **dentro de un documento JSON**, no como filas hijas. Si quieres indexar, unir o consultar los elementos como filas de primera clase, `OwnsMany` sigue siendo la herramienta.
- **No es realmente un objeto de valor.** Si dos instancias con el mismo contenido deben permanecer distinguibles, o la cosa tiene un ciclo de vida que sobrevive a sus datos actuales, tiene identidad. Eso es una entidad relacionada real, no un tipo propio y no un tipo complejo. Modélala con una relación uno a muchos normal y una clave que tú controles.

Nota que ninguna de estas razones trata sobre semántica o conveniencia. Tratan sobre el esquema físico. Si tu respuesta a "¿esto necesita una tabla separada o filas separadas?" es no, no tienes una razón para usar una entidad propia en EF Core 11.

## Los tres filos de las entidades propias que empujan a la gente a abandonarlas

La comparación se vuelve concreta cuando chocas con los filos afilados. Los tres vienen de la misma causa raíz: una entidad propia es una entidad, así que EF Core le da una clave en sombra y razona sobre ella por identidad de referencia.

Primero, no puedes compartir una instancia. Esto parece que debería funcionar y no lo hace:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws: the same owned instance is referenced twice
```

Porque ambas propiedades son el mismo tipo de entidad, EF Core ve una entidad referenciada desde dos lugares y la rechaza. Con un tipo complejo, la asignación copia los campos y guarda limpiamente.

Segundo, la igualdad en LINQ compara identidad, no contenido:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var same = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress) // not what you meant
    .ToListAsync();
```

Con una entidad propia esto no se traduce a una comparación campo por campo. Con un tipo complejo, EF Core 11 compara el contenido (incluidos los tipos complejos anidados, tras una corrección de error específica de EF Core 11), así que la consulta significa "las dos direcciones son genuinamente iguales".

Tercero, `ExecuteUpdate` no admite en absoluto propiedades de entidades propias, mientras que la versión con tipo complejo funciona:

```csharp
// .NET 11, EF Core 11 - complex type mapping
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

Si tu código choca con cualquiera de estos tres, el mapeo de entidad propia está peleando contra ti, y la solución es cambiar el mapeo, no rodear el síntoma.

## Rendimiento: se trata de nodos de rastreo y joins, no de una cifra llamativa

No hay una brecha dramática de throughput para poner en un gráfico aquí, y deberías sospechar de cualquiera que te muestre una. La diferencia de rendimiento real y estructural está en dos lugares.

El primero es el rastreo de cambios. Una entidad propia se rastrea como su propio nodo en el rastreador de cambios, con una clave en sombra que EF Core administra. Un tipo complejo no es un nodo separado: sus columnas se rastrean como parte de la propietaria, a nivel de diff de columnas. En un grafo de objetos con muchos objetos de valor por agregado, eso son menos entradas que capturar en instantáneas, reconciliar y comparar en `SaveChanges`. La diferencia suele ser pequeña por entidad pero escala con cuántos objetos de valor cargas, y está estrictamente a favor del tipo complejo porque simplemente hay menos contabilidad.

El segundo es el join, y solo aplica al caso de entidad propia que realmente elegirías por razones de almacenamiento. Un mapeo `OwnsOne(...).ToTable("Addresses")` vive en una tabla separada, así que leer la propietaria con su objeto de valor es un join. Un tipo complejo con table splitting no tiene tabla separada y por lo tanto no tiene join. Si moviste un objeto de valor a una entidad propia puramente por costumbre y de todos modos aterrizó en la tabla de la propietaria (el valor por defecto), los dos son equivalentes en almacenamiento y la diferencia de rastreo es la única que queda. En el momento en que realmente usas la característica llamativa de la entidad propia (una tabla separada), asumes el costo del join que los tipos complejos evitan por construcción. Para el panorama más amplio del costo de rastreo, las mismas fuerzas aparecen en [AsNoTracking vs AsNoTrackingWithIdentityResolution en EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/).

Así que la afirmación honesta sobre rendimiento es: los tipos complejos nunca son más lentos que una entidad propia equivalente en la misma tabla y son estructuralmente más ligeros de rastrear; las entidades propias asumen un join precisamente cuando las usas para lo único que los tipos complejos no pueden hacer.

## La trampa que decide por ti: la versión de EF Core y la regla de anulabilidad

Dos cosas pueden tomar la decisión por ti sin importar tu preferencia.

La primera es tu versión de EF Core. Todo lo anterior asume EF Core 11. En EF Core 9 y anteriores, los tipos complejos no podían usarse en entidades con herencia TPT/TPC, `ExecuteUpdate` en miembros anidados tenía errores, la comparación de tipos complejos anidados estaba mal, y no existía `ComplexCollection`. Si estás anclado a EF Core 9, las entidades propias pueden seguir siendo la elección pragmática para un objeto de valor heredado o una colección, y deberías planear el cambio como parte de tu actualización. La [guía de migración de EF Core 6 a EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) cubre los cambios disruptivos que tienden a aparecer junto con este, y ten en cuenta que `UseSqlServer` en EF Core 11 ahora usa por defecto el nivel de compatibilidad 160 (SQL Server 2022), lo que afecta algunas traducciones de JSON.

La segunda es la regla del valor opcional. Un tipo complejo opcional (anulable) debe tener **al menos una propiedad requerida y no anulable**, porque EF Core usa esa columna para distinguir "el valor entero es null" de "el valor está presente pero sus campos opcionales son null". Si tienes un objeto de valor donde genuinamente todos los campos son anulables, un tipo complejo opcional no compilará, y o bien agregas un discriminador, reconsideras la anulabilidad, o recurres a una entidad propia. En la práctica un `Address` o `Money` real siempre tiene un campo requerido, así que esto rara vez muerde, pero es la única restricción de modelado que puede forzar tu mano hacia las entidades propias.

Los filtros de consulta se comportan igual para ambos: un filtro global o con nombre se define en la entidad propietaria, no en el objeto de valor, así que el borrado lógico y la multitenencia funcionan idénticamente sin importar qué mapeo elijas. Si esa es tu preocupación, mira [filtros de consulta con nombre vs un único filtro de consulta global en EF Core 11](/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/); no es un diferenciador entre tipos complejos y entidades propias.

## La recomendación, dicha sin rodeos

En EF Core 11, usa por defecto tipos complejos para los objetos de valor. Mapea `Address`, `Money`, `GeoPoint`, `DateRange` y sus parientes con `ComplexProperty`, obtén semántica de valor gratis, y disfruta de `ExecuteUpdate`, soporte de struct/record, e igualdad limpia. Baja a una entidad propia solo cuando el esquema físico lo exija: el valor debe estar en su propia tabla, o una colección de valores debe almacenarse como filas hijas separadas. Y si la cosa tiene una identidad genuina que sobrevive a sus datos, nunca fue un objeto de valor, así que modélala como una entidad relacionada real con una clave que tú poseas.

La regla general es la misma que separa un `record` de una `class`: si la cosa está definida por sus datos, es un valor, y un valor es un tipo complejo. Si tiene una identidad que necesitas rastrear, es una entidad. EF Core 11 por fin permite que ese modelo mental se mapee uno a uno sobre el framework, con las entidades propias reservadas para los casos estrechos de almacenamiento en los que siempre fueron mejores.

## Lecturas relacionadas

- [Cómo mapear un tipo complejo en lugar de una entidad propia en EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) es el paso a paso completo, incluida la migración de `OwnsOne` a `ComplexProperty`.
- [Cómo usar records con EF Core 11 correctamente](/2026/04/how-to-use-records-with-ef-core-11-correctly/) profundiza en los records como tipos complejos frente a entidades.
- [Cómo mapear y consultar columnas JSON en EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) cubre la opción de almacenamiento JSON que ambos mapeos comparten.
- [ExecuteUpdate vs cargar entidades y SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) enmarca la ruta de actualización masiva que los tipos complejos desbloquean para los objetos de valor.
- [Cómo configurar el mapeo de herencia tabla por jerarquía (TPH) en EF Core 11](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) es el complemento cuando tu propietaria se sitúa en una jerarquía de herencia.

## Fuentes

- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)

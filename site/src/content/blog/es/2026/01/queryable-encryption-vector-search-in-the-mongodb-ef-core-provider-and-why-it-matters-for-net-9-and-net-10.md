---
title: "Queryable Encryption + búsqueda vectorial en el proveedor MongoDB EF Core (y por qué importa para .NET 9 y .NET 10)"
description: "El proveedor MongoDB EF Core ahora soporta Queryable Encryption y búsqueda vectorial. Esto es lo que significa para apps .NET 9 y .NET 10 que ya usan EF Core."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/01/queryable-encryption-vector-search-in-the-mongodb-ef-core-provider-and-why-it-matters-for-net-9-and-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
Microsoft publicó el 7 de enero de 2026 una agradable actualización donde se cruzan seguridad y búsqueda: el proveedor MongoDB EF Core ahora soporta **Queryable Encryption** (igualdad y rango) y **búsqueda vectorial** desde una superficie LINQ al estilo EF Core. Si tu app .NET 9 o .NET 10 ya habla EF Core con fluidez, esta es una de esas características que pueden reducir la cantidad de "código especial de MongoDB" que se filtra a tu capa de dominio.

### Consultas cifradas que siguen pareciendo LINQ

Queryable Encryption es interesante porque no es solo "cifrado en reposo". El punto es que aún puedes expresar predicados de _igualdad_ y _rango_ manteniendo cifrados los campos sensibles.

El mapeo es explícito en `OnModelCreating`. El post muestra una configuración de cifrado así:

```cs
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Employee>(entity =>
    {
        entity.Property(e => e.TaxPayerId)
            .IsEncryptedForEquality(<Your Data Encryption Key GUID>));

        entity.Property(e => e.Salary)
            .HasBsonRepresentation(BsonType.Decimal128)
            // Salaries from 0 to 10 million, no decimal place precision
            .IsEncryptedForRange(0m, 10000000m, 0,
                <Your Data Encryption Key GUID>));              
    });
}
```

Una vez mapeadas, las consultas se leen como consultas normales de EF Core:

```cs
// Encrypted Equality Query
var specificEmployee = db.Employees.Where(e => e.TaxPayerId == "45678");

// Encrypted Range Query
var seniorEmployees = db.Employees.Where(e => e.Salary >= 100000m && e.Salary < 200000m);
```

La gran ganancia es arquitectónica: puedes mantener la intención de la consulta en los code reviews (quién filtra por salario, quién coincide por ID fiscal) sin esparcir plomería de cifrado ad hoc por toda la app.

### Búsqueda vectorial desde tu DbContext

La búsqueda vectorial está apareciendo en todos lados porque la búsqueda está pasando del match por palabras clave al match por similitud. El proveedor agrega el mapeo para campos vectoriales y una API de consulta de búsqueda vectorial.

Desde el post de DevBlogs, mapeas un arreglo de floats como vector binario:

```cs
b.Property(e => e.PlotEmbedding)
   .HasElementName("plot_embedding_voyage_3_large")
   .HasBinaryVectorDataType(BinaryVectorDataType.Float32);

// OR in the model:
[BinaryVector(BinaryVectorDataType.Float32)]
public float[]? PlotEmbedding { get; set; }
```

Luego puedes consultar por similitud:

```cs
var similarMovies = await db.Movies.VectorSearch(
        e => e.PlotEmbedding,
        myCustom.PlotEmbedding,
        limit: 10)
    .ToListAsync();
```

Si construyes sobre .NET 9 o .NET 10, esto puede mantener tu lógica de "recomendaciones/búsqueda" más cerca de tus patrones existentes de EF Core, con menos pipelines de consulta personalizados que mantener.

Si quieres el contexto completo y los detalles del proveedor, lee el post original: [Secure and Intelligent: Queryable Encryption and Vector Search in MongoDB EF Core Provider](https://devblogs.microsoft.com/dotnet/mongodb-efcore-provider-queryable-encryption-vector-search/).

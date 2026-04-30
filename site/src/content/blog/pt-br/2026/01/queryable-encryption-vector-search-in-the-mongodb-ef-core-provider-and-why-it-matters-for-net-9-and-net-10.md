---
title: "Queryable Encryption + busca vetorial no provider MongoDB EF Core (e por que isso importa para .NET 9 e .NET 10)"
description: "O provider MongoDB EF Core agora suporta Queryable Encryption e busca vetorial. Veja o que isso significa para apps .NET 9 e .NET 10 que já usam EF Core."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "pt-br"
translationOf: "2026/01/queryable-encryption-vector-search-in-the-mongodb-ef-core-provider-and-why-it-matters-for-net-9-and-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
A Microsoft publicou em 7 de janeiro de 2026 uma boa atualização que mistura segurança e busca: o provider MongoDB EF Core agora suporta **Queryable Encryption** (igualdade e intervalo) e **busca vetorial** a partir de uma superfície LINQ no estilo EF Core. Se a sua app .NET 9 ou .NET 10 já fala EF Core fluentemente, este é um daqueles recursos que conseguem reduzir a quantidade de "código especial do MongoDB" que vaza para a sua camada de domínio.

### Consultas criptografadas que continuam parecendo LINQ

Queryable Encryption é interessante porque não é apenas "criptografia em repouso". O ponto é que você ainda consegue expressar predicados de _igualdade_ e _intervalo_ enquanto mantém os campos sensíveis criptografados.

O mapeamento é explícito no `OnModelCreating`. O post mostra a configuração de criptografia assim:

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

Uma vez mapeadas, as consultas se leem como consultas normais de EF Core:

```cs
// Encrypted Equality Query
var specificEmployee = db.Employees.Where(e => e.TaxPayerId == "45678");

// Encrypted Range Query
var seniorEmployees = db.Employees.Where(e => e.Salary >= 100000m && e.Salary < 200000m);
```

O grande ganho é arquitetural: você consegue manter a intenção da consulta nos code reviews (quem está filtrando por salário, quem está casando por CPF/ID fiscal) sem espalhar encanamento ad hoc de criptografia pela aplicação.

### Busca vetorial a partir do seu DbContext

A busca vetorial está aparecendo em todo lugar porque a busca está migrando de match por palavra-chave para match por similaridade. O provider adiciona o mapeamento para campos vetoriais e uma API de consulta para busca vetorial.

No post do DevBlogs, você mapeia um array de floats como um vetor binário:

```cs
b.Property(e => e.PlotEmbedding)
   .HasElementName("plot_embedding_voyage_3_large")
   .HasBinaryVectorDataType(BinaryVectorDataType.Float32);

// OR in the model:
[BinaryVector(BinaryVectorDataType.Float32)]
public float[]? PlotEmbedding { get; set; }
```

Depois você pode consultar por similaridade:

```cs
var similarMovies = await db.Movies.VectorSearch(
        e => e.PlotEmbedding,
        myCustom.PlotEmbedding,
        limit: 10)
    .ToListAsync();
```

Se você está construindo sobre .NET 9 ou .NET 10, isso pode manter a sua lógica de "recomendações/busca" mais perto dos seus padrões já existentes de EF Core, com menos pipelines customizados de consulta para manter.

Se você quer o contexto completo e os detalhes do provider, leia o post original: [Secure and Intelligent: Queryable Encryption and Vector Search in MongoDB EF Core Provider](https://devblogs.microsoft.com/dotnet/mongodb-efcore-provider-queryable-encryption-vector-search/).

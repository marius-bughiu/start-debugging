---
title: "Queryable Encryption + Vector Search in the MongoDB EF Core Provider (and why it matters for .NET 9 and .NET 10)"
description: "Microsoft published a nice security-meets-search update on Jan 7, 2026: the MongoDB EF Core provider now supports Queryable Encryption (equality and range) and vector search from an EF Core style LINQ surface. If your .NET 9 or .NET 10 app already speaks EF Core fluently, this is one of those features that can reduce the…"
pubDate: 2026-01-08
tags:
  - "net"
  - "net-10"
---
Microsoft published a nice security-meets-search update on Jan 7, 2026: the MongoDB EF Core provider now supports **Queryable Encryption** (equality and range) and **vector search** from an EF Core style LINQ surface. If your .NET 9 or .NET 10 app already speaks EF Core fluently, this is one of those features that can reduce the amount of “special MongoDB code” that leaks into your domain layer.

### Encrypted queries that still look like LINQ

Queryable Encryption is interesting because it is not just “encrypt at rest”. The point is that you can still express _equality_ and _range_ predicates, while keeping sensitive fields encrypted.

The mapping is explicit in `OnModelCreating`. The post shows encryption configuration like this:

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

Once mapped, the queries read like normal EF Core queries:

```cs
// Encrypted Equality Query
var specificEmployee = db.Employees.Where(e => e.TaxPayerId == "45678");

// Encrypted Range Query
var seniorEmployees = db.Employees.Where(e => e.Salary >= 100000m && e.Salary < 200000m);
```

The big win is architectural: you can keep query intent in code reviews (who is filtering by salary, who is matching by tax id) without sprinkling ad-hoc encryption plumbing across the app.

### Vector search from your DbContext

Vector search is showing up everywhere because “search” is shifting from keyword matching to similarity matching. The provider adds mapping for vector fields and a vector search query API.

From the DevBlogs post, you map a float array as a binary vector:

```cs
b.Property(e => e.PlotEmbedding)
   .HasElementName("plot_embedding_voyage_3_large")
   .HasBinaryVectorDataType(BinaryVectorDataType.Float32);

// OR in the model:
[BinaryVector(BinaryVectorDataType.Float32)]
public float[]? PlotEmbedding { get; set; }
```

Then you can query by similarity:

```cs
var similarMovies = await db.Movies.VectorSearch(
        e => e.PlotEmbedding,
        myCustom.PlotEmbedding,
        limit: 10)
    .ToListAsync();
```

If you are building on .NET 9 or .NET 10, this can keep your “recommendations/search” logic closer to your existing EF Core patterns, with fewer custom query pipelines to maintain.

If you want the full context and provider details, read the original post: [Secure and Intelligent: Queryable Encryption and Vector Search in MongoDB EF Core Provider](https://devblogs.microsoft.com/dotnet/mongodb-efcore-provider-queryable-encryption-vector-search/).

---
title: "Queryable Encryption + Vector Search im MongoDB EF Core Provider (und warum das für .NET 9 und .NET 10 zählt)"
description: "Der MongoDB EF Core Provider unterstützt jetzt Queryable Encryption und Vector Search. Was das für .NET 9- und .NET 10-Apps bedeutet, die bereits EF Core verwenden."
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/queryable-encryption-vector-search-in-the-mongodb-ef-core-provider-and-why-it-matters-for-net-9-and-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
Microsoft hat am 7. Januar 2026 ein hübsches Update veröffentlicht, in dem Sicherheit auf Suche trifft: Der MongoDB EF Core Provider unterstützt jetzt **Queryable Encryption** (Gleichheit und Bereich) sowie **Vector Search** über eine LINQ-Oberfläche im EF Core-Stil. Wenn Ihre .NET 9- oder .NET 10-App schon flüssig EF Core spricht, ist das eines dieser Features, die die Menge an "speziellem MongoDB-Code", die in Ihre Domain-Schicht sickert, reduzieren können.

### Verschlüsselte Abfragen, die weiterhin nach LINQ aussehen

Queryable Encryption ist deshalb interessant, weil es nicht nur "Encryption at Rest" ist. Der Punkt ist, dass Sie weiterhin _Gleichheits-_ und _Bereichs_-Prädikate ausdrücken können, während sensible Felder verschlüsselt bleiben.

Das Mapping ist explizit in `OnModelCreating`. Der Beitrag zeigt eine Verschlüsselungskonfiguration so:

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

Sind die Mappings einmal gesetzt, lesen sich die Abfragen wie normale EF Core-Abfragen:

```cs
// Encrypted Equality Query
var specificEmployee = db.Employees.Where(e => e.TaxPayerId == "45678");

// Encrypted Range Query
var seniorEmployees = db.Employees.Where(e => e.Salary >= 100000m && e.Salary < 200000m);
```

Der große Gewinn ist architektonisch: Die Abfrageabsicht bleibt im Code-Review sichtbar (wer filtert nach Gehalt, wer matcht nach Steuer-ID), ohne dass ad-hoc-Verschlüsselungssanitärinstallationen über die App verstreut werden.

### Vector Search aus Ihrem DbContext

Vector Search taucht überall auf, weil sich Suche von Keyword-Matching zu Ähnlichkeits-Matching verschiebt. Der Provider ergänzt ein Mapping für Vektor-Felder sowie eine Vector-Search-Abfrage-API.

Aus dem DevBlogs-Beitrag: Sie mappen ein Float-Array als Binärvektor:

```cs
b.Property(e => e.PlotEmbedding)
   .HasElementName("plot_embedding_voyage_3_large")
   .HasBinaryVectorDataType(BinaryVectorDataType.Float32);

// OR in the model:
[BinaryVector(BinaryVectorDataType.Float32)]
public float[]? PlotEmbedding { get; set; }
```

Dann können Sie nach Ähnlichkeit abfragen:

```cs
var similarMovies = await db.Movies.VectorSearch(
        e => e.PlotEmbedding,
        myCustom.PlotEmbedding,
        limit: 10)
    .ToListAsync();
```

Wenn Sie auf .NET 9 oder .NET 10 bauen, bleibt damit Ihre "Empfehlungen/Suche"-Logik näher an Ihren bestehenden EF Core-Mustern, und Sie müssen weniger eigene Abfrage-Pipelines pflegen.

Wer den vollständigen Kontext und die Provider-Details möchte, liest den Originalbeitrag: [Secure and Intelligent: Queryable Encryption and Vector Search in MongoDB EF Core Provider](https://devblogs.microsoft.com/dotnet/mongodb-efcore-provider-queryable-encryption-vector-search/).

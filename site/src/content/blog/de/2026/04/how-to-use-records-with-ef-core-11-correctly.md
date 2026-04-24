---
title: "Wie man Records mit EF Core 11 korrekt verwendet"
description: "Eine praktische Anleitung zur Kombination von C#-Records und EF Core 11. Wo Records passen, wo sie das Change Tracking brechen, und wie man Value Objects, Entities und Projections modelliert, ohne mit dem Framework zu kämpfen."
pubDate: 2026-04-21
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "records"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/04/how-to-use-records-with-ef-core-11-correctly"
translatedBy: "claude"
translationDate: 2026-04-24
---

Kurze Antwort: Auf EF Core 11 und C# 14 verwenden Sie `record class`-Typen für Projections, DTOs und Complex Types (Value Objects), und bevorzugen eine einfache `class` mit init-only Properties und einem Binding-Konstruktor für getrackte Entities. `record struct` ist als Complex Type in Ordnung, aber niemals als getrackte Entity. Die Reibung, in die Leute laufen, kommt fast immer davon, positionale Records als vollständige Entities zu verwenden und dann überrascht zu sein, wenn `with`-Ausdrücke, Werte­gleichheit oder schreibgeschützte Primärschlüssel mit dem Identity Tracking von EF Core kollidieren. Die Lösung ist keine Einstellung, es ist zu wissen, welche Form von Record auf welchen Platz gehört.

Dieser Beitrag deckt die drei Plätze ab (Entity, Complex Type, Projection), zeigt die Konstruktor-Binding-Regeln, die in EF Core 11 tatsächlich ausgeliefert werden, und geht durch die spezifischen Fallstricke, die Leute zu Fall bringen: store-generierte Schlüssel, der `with`-Ausdruck, Navigation Properties, Werte­gleichheits-Fallen und JSON-gemappte Records.

## Warum Records und EF Core den Ruf haben, sich zu streiten

C#-Records wurden entworfen, um unveränderliche, werte­gleiche Datentypen einfach zu machen. Zwei Instanzen eines `record Address(string City, string Zip)` sind gleich, wenn ihre Felder gleich sind, nicht wenn sie dieselbe Referenz sind. Genau das ist die richtige Semantik für ein Value Object.

Der Change Tracker von EF Core baut auf der gegenteiligen Annahme. Der [ChangeTracker](https://learn.microsoft.com/en-us/ef/core/change-tracking/) speichert einen Snapshot der Property-Werte jeder Entity, wenn die Entity zum ersten Mal angefügt wird, und [Identity Resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution) sagt, dass es innerhalb eines einzelnen `DbContext` genau eine CLR-Instanz pro Primärschlüssel gibt. Beides hängt von Referenz-Identität ab, nicht von Werte-Identität. Wenn Sie einen `record` mit einem Primärschlüssel stempeln und ihn dann durch Erzeugen einer neuen Instanz via `with` mutieren, haben Sie nun zwei CLR-Referenzen, die gleich vergleichen, aber nicht dieselbe getrackte Entity sind. Der Change Tracker wirft entweder, weil der PK bereits getrackt ist, oder ignoriert Ihre Bearbeitungen stillschweigend.

Die offizielle C#-Dokumentation sagt seit Jahren, dass "Record-Typen nicht für die Verwendung als Entity-Typen in Entity Framework Core geeignet sind." Diese Warnung ist eine grobe Zusammenfassung der obigen Situation, kein hartes Verbot. Sie können Records als Entities verwenden, und EF Core 11 unterstützt weiterhin jeden notwendigen Mechanismus dafür. Sie müssen nur die nicht-positionale, init-only Form wählen und nach den Konstruktor-Binding-Regeln in [der EF Core Konstruktor-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/constructors) spielen.

## Platz 1: Records als Complex Types (der Sweet Spot)

EF Core 8 hat `ComplexProperty` eingeführt, und EF Core 11 hat Complex Types stabil genug gemacht, um sie als Standard-Ersatz für Owned Entities in den meisten Fällen zu empfehlen. Complex Types sind genau dort, wo Records glänzen: ein Complex Type hat keine eigene Identität, seine Werte­gleichheit deckt sich mit der Datenbank-Semantik, und er ist dafür gedacht, vollständig ersetzt zu werden, wenn ein Feld sich ändert.

```csharp
// .NET 11, C# 14, EF Core 11
public record Address(string Street, string City, string PostalCode);

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Address ShippingAddress { get; set; } = new("", "", "");
    public Address BillingAddress { get; set; } = new("", "", "");
}

// OnModelCreating
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress);
    b.ComplexProperty(c => c.BillingAddress);
});
```

Was das funktionieren lässt:

- `Address` ist eine positionale `record class`. EF Core mappt positionale Records out of the box für Complex Types, weil der primäre Konstruktor eins zu eins zu den Property-Namen passt.
- `Address` braucht keinen eigenen Primärschlüssel, weil Complex Types keine Identität haben.
- Den `ShippingAddress` eines Kunden mit `customer.ShippingAddress = customer.ShippingAddress with { City = "Cluj" };` zu ersetzen, aktualisiert die getrackte Entity, wie Sie es erwarten. EF Core sieht den `Customer`-Snapshot von seinen vorherigen Werten abweichen und markiert die drei gemappten Spalten als dirty.

Wenn Sie einen Werttyp brauchen, ist auch ein `record struct` für eine Complex Property gültig und vermeidet die zusätzliche Heap-Allokation pro Zeile. Der Trade-off ist der übliche: größere Feldsätze tun beim Kopieren weh, und Sie verlieren die Möglichkeit, einen parameterlosen Konstruktor für EF-Konventionen ohne Umwege hinzuzufügen.

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency);
```

Verwenden Sie `record struct` für kleine, festgeformte Werte (Geld, Koordinaten, Datumsbereiche). Verwenden Sie `record class` für alles andere.

## Platz 2: Records als Entities (funktioniert, aber braucht Disziplin)

Wenn Sie eine unveränderlich aussehende Entity wollen, ist die Form, die Change Tracking überlebt, eine `record class` mit **nicht-positionalen** init-only Properties und einem Binding-Konstruktor, den EF Core während der Materialisierung aufrufen kann.

```csharp
// .NET 11, C# 14, EF Core 11
public record class BlogPost
{
    // EF binds to this ctor during materialization
    public BlogPost(int id, string title, DateTime publishedAt)
    {
        Id = id;
        Title = title;
        PublishedAt = publishedAt;
    }

    // Parameterless ctor lets EF (and serializers) create instances
    // before setting properties one at a time when needed.
    private BlogPost() { }

    public int Id { get; init; }
    public string Title { get; init; } = "";
    public DateTime PublishedAt { get; init; }

    // Navigation props cannot be bound via constructor.
    public List<Comment> Comments { get; init; } = new();
}
```

Die Regeln aus [der Konstruktor-Binding-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/constructors), auf Records angewendet:

1. Wenn EF Core einen Konstruktor findet, dessen Parameter-Namen und -Typen zu gemappten Properties passen, verwendet es diesen Konstruktor während der Materialisierung. Pascal-Case-Properties können zu camelCase-Parametern passen.
2. Navigation Properties (Collections, Referenzen) können nicht durch den Konstruktor gebunden werden. Halten Sie sie aus dem primären Konstruktor heraus und initialisieren Sie sie mit einem Default.
3. Properties ohne jeglichen Setter werden per Konvention nicht gemappt. `init` zählt als Setter, also werden init-only Properties gemappt. Eine Property, deklariert als `public string Title { get; }` ganz ohne Setter, wird als Computed Property behandelt und übersprungen.
4. Store-generierte Schlüssel brauchen einen schreibbaren Schlüssel. `init` ist zur Object-Initialization-Zeit schreibbar, was genau dann ist, wenn EF Core den Wert setzt, also funktioniert `int Id { get; init; }` für store-generierte Identity-Spalten.

Warum keinen positionalen Record für die Entity selbst verwenden? Zwei Gründe.

Erstens hat ein positionaler Record einen **impliziten compiler-generierten Property Set** mit `init`-Settern, aber er hat auch eine geschützte `<Clone>$`-Methode und einen Copy-Konstruktor, den `with`-Ausdrücke verwenden. In dem Moment, in dem Sie `post with { Title = "New title" }` aufrufen, bekommen Sie eine brandneue `BlogPost`-Instanz, die denselben Primärschlüssel wie die getrackte hat. Wenn Sie versuchen `context.Update(newPost)`, schlagen Sie auf `InvalidOperationException: The instance of entity type 'BlogPost' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked.` Identity Resolution macht ihre Arbeit; Sie haben ihr zwei Referenzen auf das gegeben, was sie für dieselbe Zeile hält.

Zweitens generieren positionale Records werte-basierte `Equals` und `GetHashCode`. Der Change Tracker von EF Core, Relationship Fixup und `DbSet.Find` lehnen sich alle auf Referenz-Identität. Werte­gleichheit bricht das nicht direkt, aber sie erzeugt überraschende Verhalten: zwei frisch geladene Entities aus verschiedenen Queries können hash-gleich sein, während sie unterschiedliche getrackte Instanzen sind, und `HashSet<BlogPost>` lässt sie kollabieren. Halten Sie Werte­gleichheit fern von allem, was eine Identität hat.

Eine record class mit expliziten Properties, wie oben, vermeidet beide Fallstricke. Sie bekommen die Unveränderlichkeit und das schöne `ToString` und geben die `with`-basierte Mutation auf (was das Feature ist, das Sie auf einer getrackten Entity sowieso nicht wollten).

### Eine immutable-style Entity aktualisieren

Da die Entity "unveränderlich" ist, kann der Update-Pfad nicht "mutieren, dann SaveChanges" sein. Die zwei praktikablen Patterns auf EF Core 11:

```csharp
// .NET 11, EF Core 11
// Pattern A: load, assign to a local with init setters cleared.
// Requires exposing init setters on the class.
var post = await db.BlogPosts.SingleAsync(p => p.Id == id);

// This mutates the tracked instance. Works because 'init' is
// a settable accessor from EF Core's point of view, and nothing
// stops you from assigning through reflection or source-gen.
// If you want real immutability, use Pattern B.
db.Entry(post).Property(p => p.Title).CurrentValue = "New title";
await db.SaveChangesAsync();

// Pattern B: detach the old, attach a freshly-constructed one,
// mark the touched columns modified. No 'with' expression.
var updated = new BlogPost(post.Id, "New title", post.PublishedAt);
db.Entry(post).State = EntityState.Detached;
db.Attach(updated);
db.Entry(updated).Property(p => p.Title).IsModified = true;
await db.SaveChangesAsync();
```

Pattern A ist, wo die meisten Teams landen: Sie verwenden Records für das ergonomische `ToString`, die Deconstruction und Per-Field-Equality bei Reads, und akzeptieren, dass der Schreib-Pfad durch den Change Tracker geht, der die init-Properties über die EF-Core-Metadaten mutiert. Das ist keine Verletzung der Unveränderlichkeit auf Sprachebene, es ist nur, wie EF Core Properties bindet. Es gibt ein länger laufendes EF-Core-Issue, das First-Class-Support für unveränderliche Updates verfolgt ([efcore#11457](https://github.com/dotnet/efcore/issues/11457)), wenn Sie die ganze Geschichte wollen.

## Platz 3: Records als Projections und DTOs (immer sicher)

Jedes Mal, wenn ein Record außerhalb des Change Trackers materialisiert wird, gilt keines der obigen Probleme. Record-Projections sind das langweiligste und nützlichste Pattern:

```csharp
// .NET 11, C# 14, EF Core 11
public record PostSummary(int Id, string Title, DateTime PublishedAt);

// No tracking, no identity, no ChangeTracker snapshot.
var summaries = await db.BlogPosts
    .AsNoTracking()
    .Select(p => new PostSummary(p.Id, p.Title, p.PublishedAt))
    .ToListAsync();
```

Die Query-Pipeline von EF Core 11 bindet bereitwillig an positionale Records in Projections. Sie können diese direkt aus einer Web-API mit `System.Text.Json` ausliefern, das Record-Serialisierung seit .NET 5 und positionale-Record-Deserialisierung seit .NET 7 unterstützt.

Dasselbe Argument gilt für Input-DTOs auf Commands: Akzeptieren Sie einen positionalen Record vom Controller, validieren Sie ihn, mappen Sie ihn auf die Entity-Form oben und lassen Sie EF Core die Entity tracken. Den Wire-Type (Record) vom Persistence-Type (class mit init) zu trennen, beseitigt die ganze Bug-Kategorie, um die es in diesem Beitrag geht.

Mehr zu Records als Return-Shapes siehe die [Entscheidungstabelle am Ende des Multiple-Values-Beitrags](/de/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/).

## Store-generierte Schlüssel und init-only Properties

Das ist der mit Abstand häufigste Ort, an dem Leute hängenbleiben. Wenn `Id` als `public int Id { get; }` ohne Setter deklariert ist, mappt EF Core es nicht, und Migrationen beklagen einen fehlenden Schlüssel. Wenn es `public int Id { get; init; }` ist, ist es gemappt und während der Object Initialization schreibbar, was genau dann ist, wenn EF Core den aus der Datenbank gelesenen Wert setzt.

Für Inserts muss EF Core den generierten Wert nach `SaveChanges` auch zurück in die Entity schreiben. Es macht das durch den Setter der Property, der für init-only Properties weiterhin funktioniert, weil EF Core Property-Access-Metadaten verwendet statt der öffentlichen C#-Syntax. Bestätigt seit EF Core 11; das ist seit EF Core 5 stabil.

Was nicht funktioniert: `public int Id { get; } = GetNextId();` mit einem Field Initializer und ohne Setter. EF Core sieht keinen Setter, mappt die Property nicht, und Sie bekommen entweder einen Build-Fehler wegen fehlendem Schlüssel oder einen unbeabsichtigten Shadow Key.

## Der `with`-Ausdruck ist ein Fußschuss auf getrackten Entities

Wenn die Entity ein `record` (positional oder nicht) mit einer Primärkonstruktor-Kopie ist, produziert `with` einen Klon, der gleich zum Original vergleicht, aber eine andere CLR-Referenz ist. EF Core behandelt das als "gleicher Schlüssel, andere Instanz", was Identity Resolution auslöst. Die sichere Regel:

```csharp
// .NET 11, EF Core 11
// BAD: creates a second instance with the same PK.
var edited = post with { Title = "New" };
db.Update(edited); // throws InvalidOperationException on SaveChanges

// GOOD: mutate the tracked instance.
post.Title = "New"; // via init (within EF) or a regular setter
await db.SaveChangesAsync();
```

Wenn Sie wirklich "detach, clone, re-attach"-Semantik wollen, gehen Sie zuerst über `db.Entry(post).State = EntityState.Detached;`, dann den Klon attachen und Properties als `IsModified` markieren. Meistens wollen Sie das nicht. Sie wollen Pattern A aus dem vorherigen Abschnitt.

Complex Types haben dieses Problem nicht. Ein `with` auf einer `Address` innerhalb eines `Customer` produziert einen neuen Wert, Sie weisen ihn `customer.ShippingAddress` zurück, und EF Core vergleicht Feld für Feld gegen den Snapshot. Das ist der ganze Sinn von Complex Types.

## Werte­gleichheit vs Identität auf heißen Pfaden

Wenn Sie auf einer positionalen Record-Entity bestehen, denken Sie daran, dass Werte­gleichheit in jede Collection durchsickert, die von `GetHashCode` getragen wird. Ein `HashSet<BlogPost>` lässt zwei "verschiedene Entities mit denselben Daten" kollabieren. Ein Dictionary, das auf der Entity gekeyt ist, verhält sich unvorhersehbar, wenn zwei verschiedene PKs denselben Payload enthalten. Der Standard-Workaround ist, `Equals` und `GetHashCode` auf dem Record zu überschreiben, um nur den Primärschlüssel zu nutzen, was den ganzen Grund zunichtemacht, warum Sie überhaupt einen Record gewählt haben.

Der Change Tracker selbst verwendet ab EF Core 11 intern weiterhin Referenz-Identität. Sie können [die Change-Tracking-Quelle](https://github.com/dotnet/efcore) für die Details ansehen, aber die Kurzfassung ist: EF Core "verschmilzt" zwei Entities nicht versehentlich, nur weil sie werte-gleich sind. Es macht diese Verschmelzung jedoch über `DbSet.Find`, `FirstOrDefault` auf einer getrackten Query und Relationship Fixup sichtbar, weshalb Teams immer noch seltsames Verhalten sehen, das sie nicht sofort erklären können.

Auch hier ist die Lösung nicht, mit der Runtime zu streiten. Es ist, Werte­gleichheit auf Werttypen (Complex Types, DTOs) zu halten und Entity-Typen mit Default-Referenz-Identität zu lassen.

## JSON-Spalten und Records

EF Core 7 hat JSON-Column-Mapping hinzugefügt, und EF Core 11 erweitert es weiter mit [JSON_CONTAINS-Übersetzung auf SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) und Complex Types innerhalb von JSON-Dokumenten. Positionale Records sind ein ergonomischer Fit für owned JSON-Typen:

```csharp
// .NET 11, C# 14, EF Core 11
public record TagSet(List<string> Tags, DateTime UpdatedAt);

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public TagSet Metadata { get; set; } = new(new(), DateTime.UtcNow);
}

// OnModelCreating
modelBuilder.Entity<Article>()
    .OwnsOne(a => a.Metadata, b => b.ToJson());
```

Der Record ist eine Complex Property, die als JSON gespeichert wird. Sie ersetzen ihn vollständig via `article.Metadata = article.Metadata with { Tags = [..article.Metadata.Tags, "net11"] };` und EF Core serialisiert den ganzen Subtree bei `SaveChanges`. Kein Identity Tracking, keine `with`-vs-Mutation-Debatte.

## Alles zusammenbringen

Eine realistische Domäne, von Anfang bis Ende:

```csharp
// .NET 11, C# 14, EF Core 11
// Complex types (records)
public record Address(string Street, string City, string PostalCode);
public readonly record struct Money(decimal Amount, string Currency);

// Entity (class with init-only properties + binding ctor)
public class Order
{
    public Order(int id, string customerName, Money total, Address shipTo)
    {
        Id = id;
        CustomerName = customerName;
        Total = total;
        ShipTo = shipTo;
    }

    private Order() { } // EF fallback

    public int Id { get; init; }
    public string CustomerName { get; init; } = "";
    public Money Total { get; init; }
    public Address ShipTo { get; init; } = new("", "", "");

    public List<OrderLine> Lines { get; init; } = new();
}

// Projection/DTO (positional record)
public record OrderSummary(int Id, string CustomerName, decimal Total);

// Input command (positional record, validated before mapping)
public record CreateOrder(string CustomerName, Money Total, Address ShipTo);
```

Das ist die ganze Faustregel: Klassen für Dinge mit Identität, Records für Dinge, die durch ihre Daten definiert sind. EF Core 11s Konstruktor-Binding, Complex-Type-Mapping und JSON-Mapping unterstützen diese Trennung alle ohne zusätzliche Konfiguration jenseits von `ComplexProperty` oder `OwnsOne(..ToJson())` wo angemessen.

## Verwandte Lektüre

- [EF Core 11 fügt GetEntriesForState hinzu, um DetectChanges zu überspringen](/2026/04/efcore-11-changetracker-getentriesforstate/) deckt die Change-Tracker-Internals ab, auf die sich dieser Beitrag stützt.
- [EF Core 11 entfernt unnötige Reference Joins in Split Queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) ist ein guter Begleiter, wenn Ihre Entities stark auf Navigations setzen.
- [EF Core 11 übersetzt Contains zu JSON_CONTAINS auf SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) verbindet sich mit dem JSON-gemappten-Record-Pattern oben.
- [Wie man mehrere Werte aus einer Methode in C# 14 zurückgibt](/de/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) geht tiefer darauf ein, wann Records über Tupel und Klassen auf Methoden-Return-Ebene gewinnen.

## Quellen

- [EF Core Konstruktoren und Property-Binding](https://learn.microsoft.com/en-us/ef/core/modeling/constructors)
- [EF Core Change-Tracking-Übersicht](https://learn.microsoft.com/en-us/ef/core/change-tracking/)
- [EF Core Identity Resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution)
- [Was ist neu in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [C# Record-Typen Referenz](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records)
- [Unterstützung für unveränderliche Entity-Updates (efcore#11457)](https://github.com/dotnet/efcore/issues/11457)
- [Record-Typen als Entities dokumentieren (EntityFramework.Docs#4438)](https://github.com/dotnet/EntityFramework.Docs/issues/4438)

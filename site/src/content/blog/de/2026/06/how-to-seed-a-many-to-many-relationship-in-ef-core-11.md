---
title: "Eine Many-to-Many-Beziehung in EF Core 11 mit Seed-Daten befüllen"
description: "Befüllen Sie die Join-Tabelle einer Many-to-Many-Beziehung in EF Core 11: die impliziten Shadow-Keys, die Sie selbst benennen müssen, das UsingEntity-HasData-Muster und die UseSeeding-Alternative zur Laufzeit, die mit Skip-Navigations funktioniert."
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "de"
translationOf: "2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

Um eine Many-to-Many-Beziehung in EF Core 11 mit Seed-Daten zu befüllen, befüllen Sie nicht die Skip-Navigation. Sie befüllen die Join-Tabelle direkt, weil `HasData` keine Navigation füllen kann. Beim impliziten Standard-Join (ohne Klasse für die Join-Entität) greifen Sie mit `UsingEntity` in die Beziehung hinein und rufen `HasData` auf der Join-Entität auf, wobei Sie anonyme Objekte übergeben, deren Eigenschaftsnamen die von EF erzeugten Shadow-Fremdschlüssel sind -- für eine `Post.Tags` / `Tag.Posts`-Beziehung sind das `PostsId` und `TagsId`. Außerdem müssen Sie beide Enden (`Post` und `Tag`) mit festen Primärschlüsselwerten befüllen, weil das migrationsverwaltete Seeding jeden Schlüssel von Hand ausgeschrieben verlangt. Wenn Sie lieber zur Laufzeit gegen Live-Daten befüllen möchten, verwenden Sie `UseSeeding`/`UseAsyncSeeding` und laden die Entitäten, sodass Sie ganz normal zur Skip-Navigation hinzufügen können. Dieser Beitrag verwendet .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) und C# 14.

Der Grund, warum das so viele Leute aus der Bahn wirft, ist, dass eine Many-to-Many-Beziehung im typischen Modell keine dritte Klasse hat. Sie schreiben `Post` mit einer `List<Tag>` und `Tag` mit einer `List<Post>`, und EF zaubert die Join-Tabelle für Sie herbei. Dieser Komfort verflüchtigt sich in dem Moment, in dem Sie Seed-Daten wollen, denn `HasData` operiert auf Entitätstypen und ihren Schlüsseln, und die Join-"Entität", die Sie ansprechen müssen, ist in Ihrem Code unsichtbar.

## Warum HasData die Navigation nicht einfach befüllen kann

Beginnen Sie mit dem Modell, das tatsächlich jeder schreibt:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public List<Tag> Tags { get; } = [];
}

public class Tag
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = [];
}
```

EF Core bildet dies per Konvention auf drei Tabellen ab: `Posts`, `Tags` und eine Join-Tabelle namens `PostTag` mit zwei Spalten, `PostsId` und `TagsId`. Diese Spaltennamen sind nicht willkürlich. Der Shadow-Fremdschlüssel, der zurück auf die `Posts`-Tabelle verweist, ist nach der Navigation benannt, die auf Posts zielt (`Tag.Posts`), und entsprechend stammt `TagsId` von `Post.Tags`. Sie haben diese Eigenschaften nie deklariert; EF hat sie als Shadow-Properties auf einem Shared-Type-Entitätstyp erstellt, den es für Sie verwaltet.

`HasData` ist der Seeding-Mechanismus zur Migrationszeit. Er funktioniert, indem er Zeilen an einen bestimmten Entitätstyp anhängt und Inserts berechnet, indem er gegen den Modell-Snapshot abgleicht. Es gibt in Ihrem Code keinen Entitätstyp für die Verknüpfung zwischen einem Post und einem Tag, also gibt es nichts, woran `HasData` anhängen könnte. Sie können auch nicht `post.Tags.Add(tag)` in `OnModelCreating` schreiben: Der Modellaufbau konfiguriert die Form des Modells, er läuft nicht gegen einen `DbContext`, und Skip-Navigations werden dort nicht befüllt. Die Verknüpfung lebt in der Join-Tabelle, und die Join-Tabelle ist das, was Sie befüllen müssen.

Dies ist dieselbe Art von Einschränkung, die `HasData` generell unhandlich macht: Es braucht deterministische, explizit verschlüsselte Daten und gehört den Migrationen statt Ihrer Anwendung. Falls Ihnen dieser Kompromiss neu ist, finden Sie das größere Bild in [So befüllen Sie Daten mit UseSeeding und UseAsyncSeeding in EF Core 11](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), wo behandelt wird, wann migrationsverwaltetes `HasData` schlicht das falsche Werkzeug ist.

## Den impliziten Join mit UsingEntity und HasData befüllen

Der Ansatz zur Migrationszeit hat drei Teile, und wenn Sie einen davon auslassen, bleibt Ihnen ein kaputter Seed. Hier ist die vollständige Vorgehensweise.

1. **Befüllen Sie beide Principal-Entitätstypen** mit `HasData` und geben Sie jeder Zeile einen festen Primärschlüssel. EF erzeugt keine Schlüssel für Seed-Daten, also vergeben Sie sie selbst.
2. **Greifen Sie in die Join-Entität hinein** mit `UsingEntity` und benennen Sie die Join-Tabelle explizit, damit die Konfiguration stabil ist.
3. **Rufen Sie `HasData` auf der Join-Entität auf** und übergeben Sie anonyme Objekte, deren Eigenschaftsnamen den Shadow-Fremdschlüsseln (`PostsId`, `TagsId`) entsprechen.

Zusammengesetzt sieht die Konfiguration in `OnModelCreating` so aus:

```csharp
// .NET 11, EF Core 11, C# 14 -- seeding an implicit (unmapped) join table
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().HasData(
        new Post { Id = 1, Title = "Span<T> in depth" },
        new Post { Id = 2, Title = "EF Core 11 changes" });

    modelBuilder.Entity<Tag>().HasData(
        new Tag { Id = 1, Name = "dotnet" },
        new Tag { Id = 2, Name = "performance" },
        new Tag { Id = 3, Name = "efcore" });

    modelBuilder.Entity<Post>()
        .HasMany(p => p.Tags)
        .WithMany(t => t.Posts)
        .UsingEntity(
            "PostTag",
            r => r.HasOne(typeof(Tag)).WithMany().HasForeignKey("TagsId"),
            l => l.HasOne(typeof(Post)).WithMany().HasForeignKey("PostsId"),
            j => j.HasData(
                new { PostsId = 1, TagsId = 1 },   // "Span<T>" tagged "dotnet"
                new { PostsId = 1, TagsId = 2 },   // "Span<T>" tagged "performance"
                new { PostsId = 2, TagsId = 1 },   // "EF Core 11" tagged "dotnet"
                new { PostsId = 2, TagsId = 3 })); // "EF Core 11" tagged "efcore"
}
```

Die Eigenschaftsnamen in den anonymen Objekten sind hier der Vertrag. Sie müssen exakt `PostsId` und `TagsId` lauten und mit den Shadow-Fremdschlüsseln übereinstimmen, die EF deklariert hat. Schreiben Sie einen falsch, pluralisieren ihn anders oder verwenden den Singular `PostId`, und die Migrationserzeugung wirft `The seed entity for entity type 'PostTag' cannot be added because the value 'PostId' is not present`, weil diese Eigenschaft auf der Join-Entität nicht existiert.

Führen Sie `dotnet ef migrations add SeedPostTags` aus, und die erzeugte Migration fügt die Posts, die Tags und vier Zeilen in `PostTag` ein. Von da an wendet jedes `dotnet ef database update` diese Daten einmal an, und EF verfolgt sie im Modell-Snapshot, sodass es weiß, sie nicht erneut einzufügen.

Sie können die Join-Entität benennen, ohne die Tabelle zu benennen, indem Sie nur die Lambda-Konfiguration übergeben, aber ich empfehle, stets den expliziten `"PostTag"`-Namensstring zu übergeben. Der Standardname leitet sich von Ihren Typnamen ab, und wenn Sie jemals `Post` in `Article` umbenennen, benennt ein unbenannter Join die Tabelle stillschweigend um und verwaist Ihre vorhandenen Daten. Den Namen festzunageln macht die Umbenennung zu einer bewussten, überprüfbaren Änderung.

## Wenn Sie eine Join-Klasse mit Payload haben

Wenn Ihre Join-Tabelle zusätzliche Spalten trägt -- einen `CreatedOn`-Zeitstempel, eine Sortierreihenfolge, ein "Primär-Tag"-Flag -- haben Sie eine echte Klasse dafür, und die Fremdschlüssel folgen der Singular-Konvention `PostId` / `TagId` statt der verdoppelten `PostsId` / `TagsId` des impliziten Falls. Dieser Unterschied erwischt Leute, die von einem impliziten Join zu einem expliziten aufsteigen.

```csharp
// .NET 11, EF Core 11, C# 14 -- join entity with payload
public class PostTag
{
    public int PostId { get; set; }
    public int TagId { get; set; }
    public DateTime TaggedOn { get; set; }
}
```

Nun befüllen Sie die Join-Entität genauso, wie Sie jede Entität befüllen, denn sie ist ein normaler Entitätstyp:

```csharp
modelBuilder.Entity<Post>()
    .HasMany(p => p.Tags)
    .WithMany(t => t.Posts)
    .UsingEntity<PostTag>();

modelBuilder.Entity<PostTag>().HasData(
    new PostTag { PostId = 1, TagId = 1, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 1, TagId = 2, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 2, TagId = 3, TaggedOn = new DateTime(2026, 6, 2) });
```

Beachten Sie, dass das `DateTime` eine fest codierte Konstante ist, kein `DateTime.UtcNow`. Seed-Daten müssen deterministisch sein: Ein Wert, der sich bei jedem Build ändert, lässt das Modell verändert aussehen, und EF gibt eine `PendingModelChangesWarning` aus und will jedes Mal eine neue Migration scaffolden. Dies ist eine der rauen Kanten, die bei einer [Migration von EF Core 6 zu EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) zubeißen, wo die strengere Modelländerungserkennung das stille Re-Seed von gestern in eine Build-Warnung verwandelt. Wenn Sie einen Einfüge-Zeitstempel brauchen, konfigurieren Sie einen Datenbankstandard mit `HasDefaultValueSql("GETUTCDATE()")` auf der Eigenschaft und lassen ihn vollständig aus dem Seed-Objekt heraus.

## Ein Vorbehalt zum impliziten Join-Typ

Das EF-Team ist diesbezüglich in der Dokumentation deutlich: Die implizite Join-Entität wird derzeit durch `Dictionary<string, object>` repräsentiert, aber Sie dürfen sich nicht darauf verlassen. Ein zukünftiges EF-Core-Release könnte den Laufzeittyp aus Performance-Gründen ändern. Für das Seeding ist das auf eine praktische Weise von Bedeutung. Versuchen Sie nicht, durch das Konstruieren eines `Dictionary<string, object>` selbst oder durch direkten Verweis auf den Typ zu befüllen. Bleiben Sie bei der Form mit anonymen Objekten innerhalb von `UsingEntity(...).HasData(...)`. Das anonyme Objekt wird per Eigenschaftsnamen gegen die Eigenschaften der Join-Entität abgeglichen, sodass es gegen den konkreten CLR-Typ, den EF intern verwendet, abgeschirmt ist.

Wenn Sie merken, dass Sie auf den Join-Typ verweisen wollen, ist das das Signal, ihn zu einer echten Klasse hochzustufen wie im vorherigen Abschnitt. Eine benannte Klasse ist der unterstützte Weg, eine stabile, referenzierbare Join-Entität zu erhalten, und sie macht Seeding, Abfragen und das Hinzufügen von Payload-Spalten unkompliziert.

## Stattdessen zur Laufzeit mit UseSeeding befüllen

Migrationsverwaltetes `HasData` ist das richtige Werkzeug für kleine, feste Referenz-Verknüpfungen, die mit Ihrem Schema ausgeliefert werden -- ein bekannter Satz von System-Tags, verdrahtet mit bekannten Posts. Es ist das falsche Werkzeug für alles Dynamische, alles, was über die Datenbank verschlüsselt ist, oder alles, was Sie lieber als "füge dieses Tag zu diesem Post hinzu" gegen Live-Objekte ausdrücken würden. Dafür befüllen Sie zur Laufzeit mit `UseSeeding` und `UseAsyncSeeding`, wo Sie einen echten `DbContext` haben und die Skip-Navigation so verwenden können, wie sie gedacht war.

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedPostTags(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedPostTagsAsync(context, ct)));

static void SeedPostTags(DbContext context)
{
    var post = context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefault(p => p.Title == "EF Core 11 changes");
    if (post is null) return;

    var efcore = context.Set<Tag>().FirstOrDefault(t => t.Name == "efcore");
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);   // EF inserts the join row for you
        context.SaveChanges();
    }
}

static async Task SeedPostTagsAsync(DbContext context, CancellationToken ct)
{
    var post = await context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefaultAsync(p => p.Title == "EF Core 11 changes", ct);
    if (post is null) return;

    var efcore = await context.Set<Tag>().FirstOrDefaultAsync(t => t.Name == "efcore", ct);
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);
        await context.SaveChangesAsync(ct);
    }
}
```

Zwei Dinge sind zu beachten. Erstens verwenden Sie `Include(p => p.Tags)`, damit die vorhandenen Verknüpfungen geladen werden; ohne das sieht die `!post.Tags.Any(...)`-Schutzbedingung eine leere Sammlung, und Sie riskieren einen Insert mit doppeltem Schlüssel in der Join-Tabelle. Zweitens ist die Existenzprüfung obligatorisch, weil diese Callbacks bei jedem `Migrate`, `EnsureCreated` oder `dotnet ef database update` laufen, nicht nur beim ersten Mal. Fügen Sie das Tag bedingungslos hinzu, und Sie laufen beim zweiten Lauf des Seeders in eine Primärschlüsselverletzung auf `PostTag`. Die vollständigen Regeln dafür, wann diese Callbacks ausgelöst werden, und warum Sie sowohl die synchrone als auch die asynchrone Überladung implementieren müssen, finden Sie im [UseSeeding-Tiefgang](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

Der Lohn ist, dass `post.Tags.Add(efcore)` die natürliche API ist. EFs Change Tracker sieht einen neuen Eintrag in der Skip-Navigation und gibt den Insert in die Join-Tabelle selbst aus. Sie benennen niemals `PostsId` oder `TagsId`, Sie konstruieren niemals ein anonymes Objekt, und der Code liest sich wie der Rest Ihrer Anwendung. Der Preis ist, dass dies beim Start gegen eine Live-Datenbank läuft, statt in eine Migration eingebacken zu sein, sodass es sich am besten für Entwicklung, Tests und idempotente Referenzdaten eignet statt für produktive, schema-versionierte Daten.

## Fehler, die verwirrende Fehlermeldungen erzeugen

Einige Fehlermodi treten wiederholt auf, und die Fehlermeldungen weisen nicht immer auf die eigentliche Ursache hin.

Nur die Join-Zeilen zu befüllen und zu vergessen, die Principals zu befüllen, beschert Ihnen zur `database update`-Zeit eine Fremdschlüsselverletzung, weil `PostsId = 1` auf eine `Posts`-Zeile verweist, die nicht existiert. Befüllen Sie immer beide Enden mit denselben festen Schlüsseln, die Sie im Join referenzieren.

Die Verwendung der falschen Shadow-Key-Namen -- `PostId` statt `PostsId` für den impliziten Join -- scheitert beim Migrations-Scaffolding mit einer Meldung über eine Eigenschaft, die auf der Join-Entität nicht vorhanden ist. Die verdoppelte Form (`PostsId`, `TagsId`) ist für den impliziten, nicht gemappten Join; die Singular-Form (`PostId`, `TagId`) ist für eine explizite Join-Klasse. Sie sind nicht austauschbar.

Eine Payload-Spalte im Seed-Objekt auf einen nicht-deterministischen Wert wie `DateTime.UtcNow` defaulten zu lassen, erzeugt einen endlosen Strom von "model changed"-Migrationen. Codieren Sie den Wert fest oder schieben Sie ihn auf einen Datenbankstandard.

Wenn Ihre Principal-Entität schließlich überhaupt keinen Schlüssel definiert hat -- ein keyless oder fehlkonfigurierter Typ -- kommt der Seed gar nicht so weit; Sie sehen zuerst [the entity type requires a primary key to be defined](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/). Beheben Sie das Modell, bevor Sie sich um die Seed-Daten kümmern.

Die Entscheidung zwischen den beiden Ansätzen läuft auf die Zugehörigkeit hinaus. Wenn die Verknüpfungen Teil der Identität Ihres Schemas sind und innerhalb von Migrationen mitreisen sollen, befüllen Sie die Join-Entität mit `UsingEntity(...).HasData(...)` und nehmen die manuelle Schlüsselbuchhaltung in Kauf. Wenn es sich um Laufzeitdaten handelt, die Sie lieber gegen Live-Objekte ausdrücken würden, verwenden Sie `UseSeeding` und fügen zur Skip-Navigation hinzu. Die meisten realen Anwendungen verwenden am Ende `HasData` für eine Handvoll System-Verknüpfungen und `UseSeeding` für alles andere, und genau diese Aufteilung haben die beiden Mechanismen, die das EF-Team entworfen hat, abdecken sollen.

Quellen: Die EF-Core-[Dokumentation zu Many-to-Many-Beziehungen](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) auf Microsoft Learn beschreibt den impliziten Join, die `PostsId`/`TagsId`-Shadow-Keys, die `UsingEntity`-Überladungen und die Warnung davor, sich auf `Dictionary<string, object>` zu verlassen; die EF-Core-[Dokumentation zum Data Seeding](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) behandelt `HasData` gegenüber `UseSeeding`/`UseAsyncSeeding` und die Determinismus-Anforderung; die GitHub-Diskussion in [dotnet/efcore#23363](https://github.com/dotnet/efcore/issues/23363) zeigt das von der Community bestätigte `UsingEntity(...).HasData(...)`-Muster zum Befüllen der Join-Tabelle.

---
title: "Benannte Query-Filter für Soft Delete und Multi-Tenancy in EF Core 11 verwenden"
description: "Wenden Sie zwei unabhängige globale Query-Filter auf dieselbe Entität in EF Core 11 an: einen Soft-Delete-Filter und einen Tenant-Filter, jeweils benannt, sodass Sie einen ohne den anderen per IgnoreQueryFilters deaktivieren können."
pubDate: 2026-07-03
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "de"
translationOf: "2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

Um in EF Core 11 einen Soft-Delete-Filter und einen Multi-Tenancy-Filter auf dieselbe Entität anzuwenden, geben Sie jedem einen Namen: Rufen Sie `HasQueryFilter("SoftDeletionFilter", e => !e.IsDeleted)` und `HasQueryFilter("TenantFilter", e => e.TenantId == _tenantId)` in `OnModelCreating` auf. Beide werden standardmäßig auf jede Abfrage angewendet. Wenn eine Admin-Ansicht soft-gelöschte Zeilen sehen muss, deaktivieren Sie nur diesen Filter mit `IgnoreQueryFilters(["SoftDeletionFilter"])`, und der Tenant-Filter bleibt aktiv, sodass Sie niemals die Daten eines anderen Tenants preisgeben. Benannte Query-Filter kamen mit EF Core 10 und sind in EF Core 11 die Standardmethode, um Filter zu stapeln (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). Dieser Beitrag zeigt die vollständige Einrichtung: die Tenant-ID an den Kontext anbinden, Löschungen automatisch stempeln, Filter selektiv deaktivieren und der Join-Fallstrick, der Zeilen stillschweigend verwirft.

## Warum ein Filter pro Entität nie ausreichte

Ein globaler Query-Filter ist eine zusätzliche `Where`-Klausel, die EF Core in jede Abfrage eines Entitätstyps einfügt. Zwei Anwendungsfälle dominieren. Soft Delete behält die Zeilen in der Tabelle mit einem `IsDeleted`-Flag, anstatt ein `DELETE` abzusetzen, sodass Sie einen Prüfpfad und einen Weg zum Rückgängigmachen erhalten. Multi-Tenancy speichert die Zeilen vieler Kunden in einer Tabelle mit einer `TenantId`-Spalte, und der Filter garantiert, dass eine Abfrage nur die Zeilen des aktuellen Tenants sieht. Beide sind genau die Art von querschneidendem Prädikat, das Sie niemals von Hand in jedes `Where` schreiben wollen, denn die eine Stelle, die Sie vergessen, ist ein Datenleck-Bug.

Das Problem vor EF Core 10 war, dass jeder Entitätstyp genau einen Filter haben konnte. `HasQueryFilter` zweimal aufzurufen stapelte die Prädikate nicht, es ersetzte das erste stillschweigend:

```csharp
// EF Core 9 and earlier -- the second call WINS, soft delete is lost
modelBuilder.Entity<Invoice>().HasQueryFilter(i => !i.IsDeleted);
modelBuilder.Entity<Invoice>().HasQueryFilter(i => i.TenantId == _tenantId);
// Result: only the tenant filter is active. Deleted rows come back.
```

Der Workaround bestand darin, alles mit `&&` in einen einzigen Ausdruck zu kombinieren:

```csharp
// EF Core 9 -- works, but the two concerns are now welded together
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

Das kompiliert und filtert korrekt, hat aber eine scharfe Kante: Sie können nicht die Hälfte abschalten. `IgnoreQueryFilters()` ist Alles-oder-nichts. Sobald ein Admin-Bericht soft-gelöschte Rechnungen einschließen muss, rufen Sie `IgnoreQueryFilters()` auf, und nun ist auch der Tenant-Filter weg. In einem Multi-Tenant-System ist das keine Unannehmlichkeit, es ist ein Sicherheitsvorfall. Benannte Filter existieren genau dazu, das "einen deaktivieren, den anderen behalten" zu ermöglichen.

## Zwei benannte Filter auf einer Entität definieren

In EF Core 11 hat `HasQueryFilter` eine Überladung, die einen Filterschlüssel als erstes Argument nimmt. Geben Sie einen Namen an, und die Aufrufe setzen sich zusammen, statt sich zu überschreiben:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Invoice
{
    public int Id { get; set; }
    public int TenantId { get; set; }
    public bool IsDeleted { get; set; }
    public decimal Amount { get; set; }
}

public class BillingContext(string tenantId) : DbContext
{
    private readonly int _tenantId = int.Parse(tenantId);

    public DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == _tenantId);
    }
}
```

Nun wird eine einfache Abfrage von beiden Prädikaten gefiltert:

```csharp
// SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
var invoices = await context.Invoices.ToListAsync();
```

Beide Prädikate landen in derselben SQL-`WHERE`-Klausel, verknüpft mit `AND`, genau wie es die `&&`-Version erzeugte. Der Unterschied liegt vollständig darin, was Sie als Nächstes tun können: Jedes Prädikat hat nun einen Griff, den Sie über seinen Namen fassen können.

Eine Regel, die der Compiler nicht abfängt: Sie können auf demselben Entitätstyp keinen benannten und einen unbenannten Filter mischen. Sobald irgendein Filter auf `Invoice` einen Namen hat, müssen alle einen haben. Ein unbenanntes `HasQueryFilter(i => ...)` auf einer Entität, die bereits benannte Filter hat, wirft zur Modellerstellungszeit eine Ausnahme. Wählen Sie einen Stil pro Entität und bleiben Sie dabei.

## Die Tenant-ID an den Kontext bringen

Ein Soft-Delete-Filter ist ein konstanter Ausdruck, aber ein Tenant-Filter braucht einen Laufzeitwert, und der Filter kann nur Zustand lesen, der auf der Kontextinstanz lebt. Die sauberste Anbindung besteht darin, den aktuellen Tenant einmalig aufzulösen, wenn der Kontext konstruiert wird. In einer ASP.NET-Core-Anwendung bedeutet das üblicherweise, ihn vom authentifizierten Benutzer zu lesen und ihn dem Kontext über Dependency Injection zu übergeben:

```csharp
// .NET 11 -- resolve tenant per request and feed it to the context
builder.Services.AddScoped<ITenantProvider, HttpTenantProvider>();

builder.Services.AddDbContext<BillingContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
});

// A small provider that pulls the tenant from the current principal
public sealed class HttpTenantProvider(IHttpContextAccessor accessor) : ITenantProvider
{
    public int TenantId =>
        int.Parse(accessor.HttpContext!.User.FindFirstValue("tenant_id")!);
}
```

Referenzieren Sie dann den Provider aus dem Kontext. Den Tenant lazy innerhalb des Filters zu lesen (statt ihn in einem Feld zwischenzuspeichern) ist wichtiger, als es aussieht, und der nächste Abschnitt erklärt, warum:

```csharp
// EF Core 11 -- the filter closes over a field EF re-reads on each query
public class BillingContext(DbContextOptions<BillingContext> options,
                            ITenantProvider tenant) : DbContext(options)
{
    private int TenantId => tenant.TenantId;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == TenantId);
    }
}
```

EF Core wertet den Tenant-Ausdruck zur Abfragezeit aus, nicht bei der Modellerstellung, sodass die Eigenschaft für jede Abfrage gelesen und in einen Parameter übersetzt wird. Das hält den kompilierten Abfrageplan über Tenants hinweg wiederverwendbar und isoliert die Zeilen dennoch.

### Die Falle beim DbContext-Pooling

Wenn Sie `AddDbContextPool` verwenden, ist Vorsicht geboten: Ein gepoolter Kontext wird über Anfragen hinweg wiederverwendet, und sein Konstruktor läuft bei der Wiederverwendung nicht erneut. Eine im Konstruktor in ein Feld erfasste Tenant-ID ist für die zweite Anfrage, die diese gepoolte Instanz erhält, veraltet. Vermeiden Sie entweder das Pooling für einen tenant-bezogenen Kontext, oder lösen Sie den Tenant über einen scoped Provider auf, der zur Abfragezeit gelesen wird, wie oben gezeigt, niemals ein bei der Konstruktion eingefrorener Wert. Das ist der häufigste Weg, auf dem benannte Tenant-Filter in Produktion Daten preisgeben.

## Soft Delete, ohne jede Aufrufstelle anzufassen

Der Filter verbirgt die gelöschten Zeilen, aber irgendetwas muss immer noch `IsDeleted = true` setzen. Sie wollen das nicht über die Services verstreut haben. Überschreiben Sie `SaveChangesAsync` und wandeln Sie Löschungen in Aktualisierungen an dem Engpass um, den jede Schreiboperation passieren muss:

```csharp
// EF Core 11 -- intercept deletes and turn them into soft deletes
public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
{
    ChangeTracker.DetectChanges();

    foreach (var entry in ChangeTracker.Entries<Invoice>()
                 .Where(e => e.State == EntityState.Deleted))
    {
        entry.State = EntityState.Modified;
        entry.CurrentValues["IsDeleted"] = true;
    }

    return await base.SaveChangesAsync(ct);
}
```

Nun setzt `context.Invoices.Remove(invoice)` gefolgt von `SaveChangesAsync` ein `UPDATE` ab, das das Flag umlegt, und der Query-Filter lässt die Zeile aus gewöhnlichen Lesevorgängen verschwinden. Wenn Sie bereits einen `ISaveChangesInterceptor` zum Audit-Stempeln ausführen, ist das ein noch besserer Ort für diese Logik. Siehe [wie man EF-Core-11-Interceptoren für Auditing verwendet](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) für die Interceptor-Variante, die `SaveChanges` unberührt lässt und es übersteht, aus jedem beliebigen Repository aufgerufen zu werden.

## Einen Filter deaktivieren, den anderen behalten

Das ist der ganze Sinn der Benennung. `IgnoreQueryFilters` akzeptiert eine Sammlung von Filternamen, und nur diese werden abgeschaltet:

```csharp
// EF Core 11 -- see deleted invoices, but STILL scoped to the current tenant
var withDeleted = await context.Invoices
    .IgnoreQueryFilters(["SoftDeletionFilter"])
    .ToListAsync();
// SQL: WHERE TenantId = @__tenantId   (soft-delete predicate dropped, tenant kept)
```

Der Tenant-Filter bleibt unberührt, sodass ein Administrator, der "alle Rechnungen einschließlich der gelöschten" ansieht, niemals die Daten eines anderen Kunden sieht. Das parameterlose `IgnoreQueryFilters()` existiert weiterhin und deaktiviert weiterhin alles, was Sie bei einer tenant-gefilterten Entität fast nie wollen. Behandeln Sie den parameterlosen Aufruf als Code Smell bei jeder Tabelle, die eine Tenant-Spalte trägt.

### Benennen Sie Ihre Filter mit Konstanten, nicht mit String-Literalen

Filternamen sind magische Strings, und ein Tippfehler in `IgnoreQueryFilters(["SoftDeletonFilter"])` schlägt stillschweigend fehl, indem er nichts deaktiviert. Fixieren Sie die Namen ein einziges Mal:

```csharp
// EF Core 11 -- one source of truth for filter names
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant = nameof(Tenant);
}

modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant, i => i.TenantId == TenantId);
```

Umhüllen Sie dann den Ignore-Aufruf mit einer Erweiterungsmethode, sodass kein Aufrufer jemals einen Filternamen tippt:

```csharp
// EF Core 11 -- intent-revealing API, filter name hidden
public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> query)
    => query.IgnoreQueryFilters([InvoiceFilters.SoftDelete]);

// Call site reads like English and cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

## Der Join über eine erforderliche Navigation, der Zeilen stillschweigend verwirft

Der übelste Fallstrick bei Query-Filtern hat nichts mit der Benennung zu tun, und er beißt am härtesten in Multi-Tenant-Modellen, in denen jede Tabelle einen Filter trägt. Wenn eine gefilterte Entität auf der erforderlichen Seite einer Navigation sitzt, übersetzt EF Core ein `Include` in ein `INNER JOIN`. Wenn der Filter die übergeordnete Zeile entfernt, entfernt das Inner Join auch das Kind, und Sie erhalten weniger Ergebnisse als erwartet.

Betrachten Sie einen gefilterten `Blog` mit erforderlichen `Post`-Kindern:

```csharp
// EF Core 11 -- required navigation plus a filter on the principal
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired();
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));

var allPosts = await db.Posts.ToListAsync();                       // returns 6
var withBlog = await db.Posts.Include(p => p.Blog).ToListAsync();  // returns 3
```

Die zweite Abfrage verwirft alle Posts, deren Blog herausgefiltert wurde, weil das `INNER JOIN` eine passende Blog-Zeile verlangt. Die Microsoft-Dokumentation weist direkt darauf hin: Eine erforderliche Navigation zu verwenden, um eine Entität zu erreichen, die einen globalen Query-Filter hat, "kann zu unerwarteten Ergebnissen führen". Es gibt zwei Lösungen. Machen Sie die Navigation optional, damit EF ein `LEFT JOIN` erzeugt:

```csharp
// EF Core 11 -- LEFT JOIN keeps the children even when the parent is filtered
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired(false);
```

Oder, besser für Multi-Tenancy, wenden Sie denselben Filter konsistent auf beide Enden an, sodass die Kindzeilen, die sonst herrenlos wären, an ihrer Quelle entfernt werden:

```csharp
// EF Core 11 -- matching filters on both entities keep the two queries in sync
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));
modelBuilder.Entity<Post>().HasQueryFilter("UrlFilter", p => p.Blog.Url.Contains("fish"));
```

Der Ansatz mit konsistentem Filter ist der richtige Standard, wenn Ihre Tenant-Spalte in jeder Tabelle lebt: Ein `TenantFilter` sowohl auf `Blog` als auch auf `Post` bedeutet, dass weder ein `INNER JOIN` noch ein `LEFT JOIN` eine tenant-fremde Zeile zutage fördern kann.

## Grenzen, die man kennen sollte, bevor man sich festlegt

Einige Einschränkungen bestimmen, wie weit Sie das treiben können. Filter können nur auf dem Wurzel-Entitätstyp einer Vererbungshierarchie definiert werden, sodass Sie bei einem Table-per-Hierarchy-Mapping keinen unterschiedlichen Filter auf jeden abgeleiteten Typ setzen können. EF Core erkennt keine Zyklen in Filterdefinitionen, sodass ein Filter auf `Blog`, der `Post` referenziert, dessen Filter `Blog` referenziert, während der Übersetzung in eine Endlosschleife geraten kann, definieren Sie sie also sorgfältig. Und wenn Sie Entitäten über `IEntityTypeConfiguration<T>`-Klassen konfigurieren statt direkt in `OnModelCreating`, gibt es keine Kontextinstanz, aus der Sie den Tenant innerhalb von `Configure` lesen könnten; der dokumentierte Workaround besteht darin, der Konfigurationsklasse ein privates Kontextfeld hinzuzufügen und es aus dem Filterausdruck zu referenzieren.

Ein Performance-Hinweis: Da der Tenant-Wert zu einem Abfrageparameter wird, fragmentieren die Soft-Delete- und Tenant-Prädikate Ihren Abfrageplan-Cache nicht so, wie es eine inline eingesetzte Konstante täte. Das hält benannte Filter selbst unter hoher Multi-Tenant-Last günstig. Wenn Sie die Abfrageanzahl beim Hinzufügen von Filtern prüfen, gleichen Sie mit [wie man N+1-Abfragen in EF Core 11 erkennt](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) ab, da ein Filter, der durch eine Navigation greift, ein Join hinzufügen kann, das Sie nicht eingeplant hatten.

Benannte Query-Filter verwandeln globale Filter von einem stumpfen Werkzeug in ein zusammensetzbares. Zwei Prädikate, zwei Namen und die Fähigkeit, genau eines davon für genau eine Abfrage anzuheben, ist der Unterschied zwischen einem Soft-Delete-Schalter und einem versehentlichen Tenant-Leck.

## Verwandt

- [Wie man EF-Core-11-Interceptoren für Auditing verwendet](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Wie man ExecuteUpdate und ExecuteDelete für Massen-Schreibvorgänge in EF Core 11 verwendet](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: FOREIGN KEY constraint failed beim Löschen einer Entität in EF Core 11](/de/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/de/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [Wie man Keyset-(Cursor-)Paginierung in EF Core 11 umsetzt](/de/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)

## Quellen

- [Global Query Filters, EF-Core-Dokumentation (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)

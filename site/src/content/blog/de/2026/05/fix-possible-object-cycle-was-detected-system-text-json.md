---
title: "Fix: A possible object cycle was detected"
description: "System.Text.Json weigert sich, Graphen mit Rückverweisen zu serialisieren. Setzen Sie ReferenceHandler.IgnoreCycles, projizieren Sie auf ein DTO oder markieren Sie den Rückzeiger mit [JsonIgnore]. Preserve ist letzte Wahl."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
  - "ef-core"
lang: "de"
translationOf: "2026/05/fix-possible-object-cycle-was-detected-system-text-json"
translatedBy: "claude"
translationDate: 2026-05-14
---

Die Lösung: `System.Text.Json` weigert sich, jeden Objektgraphen zu serialisieren, der auf sich selbst zurückführt. In einer EF Core-Entität mit einer `Parent`-Eigenschaft und einer `Children`-Sammlung, die sich gegenseitig referenzieren, läuft der Writer endlos im Kreis, trifft auf den Tiefen-Guard und wirft die Ausnahme. Setzen Sie `JsonSerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles` für einen einzeiligen Fix, markieren Sie den Rückzeiger mit `[JsonIgnore]` für einen dauerhaften, oder projizieren Sie die Entität auf ein DTO, das den Rückzeiger schlicht nicht enthält. `ReferenceHandler.Preserve` funktioniert, ändert aber das Wire-Format zu `$id`/`$ref`, was selten das ist, was ein API-Konsument möchte.

```text
System.Text.Json.JsonException: A possible object cycle was detected. This can either be due to a cycle or if the object depth is larger than the maximum allowed depth of 32. Consider using ReferenceHandler.Preserve on JsonSerializerOptions to support cycles. Path: $.Children.Parent.Children.Parent.Children.Parent...
   at System.Text.Json.ThrowHelper.ThrowJsonException_SerializerCycleDetected(Int32 maxDepth)
   at System.Text.Json.Serialization.JsonConverter`1.TryWrite(Utf8JsonWriter writer, T& value, JsonSerializerOptions options, WriteStack& state)
   at System.Text.Json.Serialization.Metadata.JsonTypeInfo`1.SerializeAsObject(Utf8JsonWriter writer, Object rootValue)
   at System.Text.Json.JsonSerializer.WriteString[TValue](TValue value, JsonTypeInfo jsonTypeInfo)
```

Diese Anleitung ist gegen .NET 11 preview 4 und `System.Text.Json` 11.0.0-preview.4 geschrieben. Die Ausnahmemeldung hat sich nicht geändert, seit `System.Text.Json` in .NET 5 die Zyklus-Erkennung erhielt, und `ReferenceHandler.IgnoreCycles` ist seit .NET 6 verfügbar. Der `Path`-Abschnitt in der Ausnahme ist der JSON-Pfad, an dem der Writer aufgab. Wenn der Pfad ein wiederholtes Muster wie `$.Children.Parent.Children.Parent` ist, haben Sie einen echten Zyklus. Wenn der Pfad ein gerader Abstieg wie `$.Order.Customer.Address.Country.Region.Continent...` ist, haben Sie keinen Zyklus, sondern einen Graphen, der echt tiefer als 32 Ebenen ist, und benötigen `MaxDepth`, was eine andere Lösung ist.

## Warum der Writer sich weigert, dem Loop zu folgen

`System.Text.Json` serialisiert Graphen als Bäume. Ein JSON-Dokument ist per Definition ein Baum, es gibt keine Syntax für "dieser Knoten ist derselbe wie jener Knoten dort drüben". Also durchläuft der Writer den Objektgraphen in der Tiefe und gibt jede Referenz als frisches verschachteltes Objekt aus. In dem Moment, in dem eine Eigenschaft auf einen Vorgänger zurückzeigt, terminiert der Lauf nicht.

Damit der Prozess nicht läuft, bis er den Stack erschöpft, verfolgt der Writer die aktuelle Tiefe und wirft eine `JsonException`, wenn sie `JsonSerializerOptions.MaxDepth` überschreitet, was standardmäßig 64 ist. Die Standard-Fehlermeldung vermischt zwei Fälle (einen echten Zyklus und einen ehrlich tiefen Baum), weil der Writer sie von innen nicht unterscheiden kann, er sieht nur, dass es zu tief ist. Der Hinweis `Consider using ReferenceHandler.Preserve` am Ende der Meldung ist die beste Vermutung der Laufzeit. Es stimmt, dass `Preserve` den Aufruf erfolgreich machen würde, aber es ist selten die richtige Lösung für eine API. Auf ein DTO zu projizieren oder den Rückzeiger zu brechen ist es.

Der Standardwert in ASP.NET Core wurde in .NET 6 so geändert, dass die `JsonOptions` des Frameworks (verwendet von Minimal APIs und Controller-Aktionen) nicht automatisch auf `IgnoreCycles` umschalten. Sie entscheiden sich ausdrücklich dafür. Die Begründung war, dass stilles Verwerfen von Zyklen Bugs im Response-Modell verbirgt, die kanonische Antwort ist, das Modell zu reparieren.

## Eine minimale Reproduktion

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4, System.Text.Json 11.0.0-preview.4
public class Author
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Book> Books { get; set; } = new();
}

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }
    public Author Author { get; set; } = null!;
}
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var author = new Author { Id = 1, Name = "Carla" };
var book = new Book { Id = 1, Title = "Refactoring", Author = author };
author.Books.Add(book);

var json = JsonSerializer.Serialize(author); // throws
```

`author.Books[0].Author` ist dieselbe Instanz wie `author`. Der Writer steigt in `Books` ab, steigt in das erste `Book` ab, dann in dessen `Author`, findet wieder `Books` und läuft im Kreis. Der 64-Ebenen-Tiefen-Guard feuert, bevor der Prozess stirbt.

Dieselbe Form erscheint, sobald Sie eine Navigationseigenschaft in EF Core mit `Include` einbinden und die getrackte Entität aus einem Controller zurückgeben, ohne sie zu projizieren. EF Core fixiert die Navigationseigenschaften so, dass das Eltern-Objekt auf seine Kinder zeigt und die Kinder zurück auf das Eltern-Objekt zeigen. Das ist das richtige Verhalten für Change Tracking. Es ist die falsche Form für JSON.

## Lösung im Detail

### 1. Auf ein DTO projizieren

Die kanonische Antwort ist, EF Core-Entitäten niemals direkt zu serialisieren. Geben Sie ein DTO zurück, das den Rückzeiger abflacht oder weglässt:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public record AuthorDto(int Id, string Name, IReadOnlyList<BookDto> Books);
public record BookDto(int Id, string Title);

var dto = await db.Authors
    .Where(a => a.Id == 1)
    .Select(a => new AuthorDto(
        a.Id,
        a.Name,
        a.Books.Select(b => new BookDto(b.Id, b.Title)).ToList()))
    .FirstAsync();

var json = JsonSerializer.Serialize(dto); // works
```

Das ist die Antwort, die das .NET-Team empfiehlt, und es ist die richtige Antwort für jede öffentliche API. Das DTO ist, was der Konsument tatsächlich will, die Entität ist ein interner Typ, der zufällig dieselben Feldnamen hat. Das Projizieren in der EF Core-Abfrage macht auch das SQL kleiner, die Datenbank gibt nur die Spalten zurück, die das DTO benötigt. Für Hintergrund zur EF Core-Seite dieses Musters behandelt der Post [EF Cores Modell vor der ersten Abfrage aufwärmen](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) die Projektionsmechanik ausführlicher.

### 2. ReferenceHandler.IgnoreCycles global setzen

Wenn Sie eine Entität direkt serialisieren müssen (ein schneller interner Endpunkt, ein Admin-Werkzeug, ein Debug-Dump), setzen Sie die Option einmal im Host:

```csharp
// .NET 11, C# 14, ASP.NET Core 11
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

Für Controller (System.Text.Json):

```csharp
// .NET 11, C# 14, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
});
```

`IgnoreCycles` schreibt `null`, sobald der Writer erkennt, dass er gerade eine Instanz besuchen will, die bereits im aktuellen Zweig liegt. Der Zyklus ist gebrochen, der Aufruf gelingt, und der Konsument erhält einen Baum. Der Preis ist, dass `book.Author` als `null` serialisiert wird, obwohl es eindeutig befüllt war, was verwirren kann, wenn der Konsument Roundtrip-Treue erwartet.

`IgnoreCycles` wurde in .NET 6 gerade deshalb ergänzt, weil `Preserve` als Standard zu disruptiv war und `[JsonIgnore]` nur fallweise wirkt. Greifen Sie als globale Serialisierer-Einstellung für reine Lese-Antwortpfade darauf zurück und lassen Sie das Modell unverändert.

### 3. Den Rückzeiger mit [JsonIgnore] markieren

Wenn der Rückzeiger in JSON nie nützlich ist (der Konsument kennt das Eltern-Objekt immer, weil er es gerade angefragt hat), markieren Sie ihn direkt:

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

public class Book
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int AuthorId { get; set; }

    [JsonIgnore]
    public Author Author { get; set; } = null!;
}
```

`[JsonIgnore]` entfernt die Eigenschaft sowohl aus dem Serializer als auch aus dem Deserializer für diesen Typ. Der Zyklus verschwindet zur Kompilierzeit, keine Laufzeit-Option nötig. Das ist die richtige Lösung für eine Navigationseigenschaft, die nur für Change Tracking existiert und die kein JSON-Konsument je braucht.

Der Kompromiss ist, dass `Author` jetzt überall für die JSON-Schicht unsichtbar ist. Wenn Sie einen anderen Endpunkt haben, der ein `Book` mit eingebettetem `Author` zurückgeben möchte, ist `[JsonIgnore]` zu pauschal und Sie sollten stattdessen auf ein DTO projizieren.

### 4. ReferenceHandler.Preserve, wenn Sie wirklich einen Roundtrip brauchen

Wenn Ihr Szenario intern-zu-intern ist (ein Actor-System, ein Server-zu-Server-Protokoll, ein Snapshot, den Sie in einem anderen .NET-Prozess wieder einlesen), ist `Preserve` die Option, die den Graphen unversehrt lässt:

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    ReferenceHandler =
        System.Text.Json.Serialization.ReferenceHandler.Preserve
};

var json = JsonSerializer.Serialize(author, options);
```

Die Ausgabe bekommt `$id`- und `$ref`-Eigenschaften:

```json
{
  "$id": "1",
  "Id": 1,
  "Name": "Carla",
  "Books": {
    "$id": "2",
    "$values": [
      {
        "$id": "3",
        "Id": 1,
        "Title": "Refactoring",
        "Author": { "$ref": "1" }
      }
    ]
  }
}
```

`Preserve` ist **niemals** die richtige Antwort für eine öffentliche REST-API. JavaScript-Clients, mobile Clients, Postman, jeder Code-Generator, jeder Swagger-Validator erwarten reines JSON. `$id` und `$ref` sind eine Eigenkonvention von System.Text.Json (ursprünglich aus Newtonsoft), sie sind kein Standard. Browser werden sie nicht entpacken. Wenn Sie auf der Gegenseite nicht mit `System.Text.Json` und derselben `Preserve`-Option deserialisieren, geben Sie sie nicht aus.

Die legitime Verwendung ist Server-zu-Server, wo beide Enden .NET sind, Sie den Vertrag kontrollieren und Sie tatsächlich den Graphen ohne Duplikation roundtrippen müssen.

### 5. MaxDepth erhöhen, aber nur für ehrlich tiefe Bäume

Wenn Sie den Pfad in der Ausnahme inspiziert haben und er kein wiederholtes Muster, sondern ein langer gerader Abstieg ist, ist Ihr Graph echt tiefer als 64 Ebenen:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    MaxDepth = 128
};
```

Das ist selten. Die meisten Domänen haben keine 64 Ebenen tiefen Bäume, und wenn Ihre es haben, möchten Sie die Antwort fast sicher in Stücke zerlegen oder paginieren. Aber es ist der richtige Hebel für Dinge wie rekursive Ordnerstrukturen, Organisationshierarchien oder Ausdrucksbäume, wo Tiefe Daten ist und kein Bug.

Erhöhen Sie `MaxDepth` **nicht**, um einen Zyklus zu "umgehen". Der Tiefen-Guard ist das einzige, was zwischen Ihrem Prozess und einem Stack Overflow steht.

## Häufige Formen, die das auslösen

### EF Core-Navigationseigenschaften an einer serialisierten Entität

Der Lehrbuchfall. `Order` hat `Customer`, `Customer` hat `List<Order> Orders`, und ein `Include` befüllt beide Seiten. Die Lösung ist, auf ein DTO zu projizieren oder den Rückzeiger mit `[JsonIgnore]` zu versehen. Entitäten aus einem Controller zurückzugeben ist die häufigste einzelne Quelle dieser Ausnahme.

### Selbstreferenzierende Bäume

Eine `Category` mit einem `Parent` und `List<Category> Children`, befüllt durch rekursive `Include`s. Der Zyklus ist `category.Children[0].Parent == category`. `IgnoreCycles` behandelt das sauber, weil der Writer den Loop am Rückzeiger erkennt und dort `null` ausgibt.

### Anonyme Typen, aus LINQ gebaut

Eine LINQ-Projektion, die ihren Weg in einen Graphen anonym-typisiert, ist meist sicher (anonyme Typen haben keine Rückzeiger). Aber eine Projektion wie `Select(a => new { a, Books = a.Books })` reintroduziert die Entität, und der Zyklus ist zurück. Inspizieren Sie, was Sie tatsächlich geschrieben haben, nicht, was Sie schreiben wollten.

### Ein DTO, das die Navigationseigenschaften seiner Quelle übernommen hat

Eine Mapping-Konfiguration, die `Author Author` von der Entität auf das DTO überträgt, hebelt den Zweck des DTOs aus. Entweder entfernen Sie die Eigenschaft aus dem DTO, oder ändern Sie ihren Typ in `AuthorDto` (ein blattförmiges Record ohne Rückzeiger).

### Ein Graph tiefer als 32, mit der alten Standardmeldung

Vor .NET 8 war `MaxDepth` nur dann standardmäßig 64, wenn nicht explizit gesetzt; der Source-Generator-Pfad und einige Legacy-Initialisierer verwendeten 32. Die Ausnahmemeldung hat in einigen älteren Versionen "32" hartkodiert, und "64" oder Ihren benutzerdefinierten Wert in neueren. Lesen Sie die tatsächliche Ausnahme, nicht die Doku, die Laufzeit-Version bestimmt die Zahl.

## Varianten, die so aussehen, aber es nicht sind

### "The object or value could not be serialized. There was a recursive call detected."

Andere Fehlermeldung, dieselbe Familie. Das ist die Meldung, die Newtonsoft.Json ausgibt, wenn sein `ReferenceLoopHandling` auf dem Standard `Error` belassen wird. Die Lösung in Newtonsoft ist `ReferenceLoopHandling.Ignore` (das Analogon von `IgnoreCycles`) oder `PreserveReferencesHandling.All` (das Analogon von `Preserve`). Wenn Sie mitten in der Migration sind, ist die [Migrationsspur von Newtonsoft zu System.Text.Json](/de/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) am ehesten eine kanonische Fallstudie; beide Bibliotheken landen bei derselben Lösungsform, schreiben die Optionen aber unterschiedlich.

### "JsonException: The JSON value could not be converted to ..."

Andere Ausnahme, anderer Stack. Diese betrifft das Parsen von Eingaben, die nicht zum Zieltyp passen. Die Zyklus-Ausnahme ist ein Problem auf der Schreibseite; die Konvertierungs-Ausnahme ist ein Problem auf der Leseseite. Der [System.DateTime-Konvertierungsleitfaden](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) ist der kanonische Beitrag zur Lese-Familie.

### "Self referencing loop detected for property ..."

Das ist die Newtonsoft-Meldung wortwörtlich. Wenn Sie sie 2026 in einer Codebasis sehen, von der Sie dachten, sie nutze `System.Text.Json`, ist irgendwo noch ein Newtonsoft-Serializer verdrahtet, meist ein übriggebliebener `AddNewtonsoftJson()`-Aufruf am MVC-Builder. Suchen Sie im Host-Startup; das Framework nimmt den JSON-Formatter, der zuletzt registriert wird.

### "An item with the same key has already been added. Key: $id"

Das ist der `Preserve`-Deserializer, der fehlschlägt, weil dieselbe `$id` zweimal in der Eingabe erscheint. Entweder ist das Payload fehlerhaft (zwei verschiedene Objekte haben dieselbe id bekommen), oder es wurde mit `Preserve` serialisiert und dann durch einen Transformator umgeschrieben, der die ids neu vergab. Die Lösung liegt beim Erzeuger, nicht beim Konsumenten.

### "PossibleCycleDetected" aus einem Blazor-Render

Ganz andere Schicht. Die Diff-Engine von Blazor hat ihren eigenen Zyklus-Guard für Komponenten-Parameter; Ausnahmetyp und Stack sind anders. Ändern Sie nicht `JsonSerializerOptions`, um einen Blazor-Render-Loop zu reparieren.

## Arbeit mit dem Source Generator

Bei Verwendung der `System.Text.Json`-Source-Generation gelten dieselben Optionen. Setzen Sie `ReferenceHandler` an den `JsonSerializerOptions`, die Sie an den generierten Kontext übergeben, oder verwenden Sie das `[JsonSourceGenerationOptions]`-Attribut am Kontext-Typ:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json.Serialization;

[JsonSourceGenerationOptions(
    ReferenceHandler = JsonKnownReferenceHandler.IgnoreCycles)]
[JsonSerializable(typeof(Author))]
public partial class ApiJsonContext : JsonSerializerContext { }
```

`JsonKnownReferenceHandler` ist das attribut-freundliche Enum, es mappt zur Laufzeit auf dieselben Handler wie `ReferenceHandler.IgnoreCycles` / `Preserve`. Der Source-Generator-Post [Interceptors und Ergonomie der System.Text.Json-Source-Generation](/de/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) zeigt die Form der Kontext-Registrierung, die Trimming und AOT-Veröffentlichung übersteht, dieselbe Form gilt hier.

## Verwandt

Für das Lesependant dieser Ausnahme siehe den [Fix für The JSON value could not be converted to System.DateTime](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/). Das allgemeine Gerüst, um eigene Konverter zu schreiben, die das Standard-Referenzhandling umgehen, liegt im [Walkthrough für benutzerdefinierte JsonConverter](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Wenn die zu serialisierende Entität aus EF Core 11 stammt und Sie die Datenbank-Roundtrip-Geschichte wollen, behandelt der [Walkthrough zu SQL Server 2025 JSON contains](/de/2026/04/efcore-11-json-contains-sql-server-2025/) wie der JSON-Spaltentyp Graphen auf der Datenbankebene handhabt. Für den breiteren Fall, eine gesamte Codebasis vom `ReferenceLoopHandling` von Newtonsoft wegzubekommen, enthält die Notiz zu [vstest entfernt Newtonsoft.Json in .NET 11 preview 4](/de/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) das Playbook des .NET-Teams selbst.

## Quellen

- [Preserve references and handle circular references in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references), Microsoft Learn.
- [`JsonSerializerOptions.ReferenceHandler`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.referencehandler), Microsoft Learn.
- [`JsonSerializerOptions.MaxDepth`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.maxdepth), Microsoft Learn.
- [`JsonIgnoreAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonignoreattribute), Microsoft Learn.
- [dotnet/runtime issue 30820: cycle detection in JSON serialization](https://github.com/dotnet/runtime/issues/30820), die ursprüngliche Design-Diskussion, die `Preserve` und später `IgnoreCycles` einführte.

---
title: "Lösung: ASP.NET Core liefert 400 \"The X field is required\" für eine nicht nullbare string-Eigenschaft"
description: "Mit <Nullable>enable</Nullable> behandelt MVC jeden nicht nullbaren Referenztyp wie [Required(AllowEmptyStrings = true)]. Markieren Sie optionale Eigenschaften als string?, geben Sie ihnen einen Standardwert oder setzen Sie SuppressImplicitRequiredAttributeForNonNullableReferenceTypes."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "validation"
  - "nullable-reference-types"
lang: "de"
translationOf: "2026/09/fix-aspnetcore-400-the-field-is-required-non-nullable-string"
translatedBy: "claude"
translationDate: 2026-09-25
---

Ein `400 Bad Request` mit `"The Name field is required."` für eine Eigenschaft, die Sie nie mit `[Required]` markiert haben, stammt aus der impliziten Required-Regel von MVC: Wenn das Projekt `<Nullable>enable</Nullable>` gesetzt hat, wird jeder nicht nullbare Referenztyp auf einem gebundenen Modell oder Aktionsparameter so validiert, als hätte er `[Required(AllowEmptyStrings = true)]`. Ist der Wert tatsächlich optional, deklarieren Sie ihn als `string?`. Wenn Sie überall das alte Verhalten wollen, setzen Sie `options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true` in `AddControllers`. Ist er wirklich erforderlich, behalten Sie den Fehler und passen ihn mit einem expliziten `[Required]` an.

Jedes Ergebnis unten wurde auf ASP.NET Core 10.0.10 (SDK 10.0.302) mit einem einzigen `dotnet new web`-Projekt reproduziert, das sowohl Controller als auch Minimal-API-Endpunkte hostet. Die Regel selbst existiert seit ASP.NET Core 3.0, die Erklärung gilt also für jede Version von 3.0 bis .NET 11.

## Der Fehler im Kontext

Der Client sendet einen JSON-Body, in dem eine Eigenschaft fehlt oder als `null` gesendet wird, und erhält den standardmäßigen `ValidationProblemDetails`-Body zurück, bevor Ihre Aktion ausgeführt wird:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Name": ["The Name field is required."]
  },
  "traceId": "00-41532a7ee5071512e476fa1aa31447c3-141fcd7662d71a76-00"
}
```

Dieselbe Meldung erscheint bei Query-String-Parametern (`"q": ["The q field is required."]`), Formularfeldern und sehr oft bei EF Core-Navigationseigenschaften auf Entitäten, die direkt gebunden werden (`"Customer": ["The Customer field is required."]`). Ohne `[ApiController]` bekommen Sie kein automatisches 400, aber `ModelState.IsValid` ist `false` mit demselben Fehler. So begegnen ihm Razor Pages und MVC-Formular-Posts.

## Warum das passiert

Der `DataAnnotationsMetadataProvider` von MVC erstellt Validierungsmetadaten für jede gebundene Eigenschaft und jeden gebundenen Parameter. Für jeden Referenztyp ohne explizites `[Required]` fragt er `NullabilityInfoContext`, was der Compiler festgehalten hat. Ist der Lesezustand `NotNull`, fügt er der Validatorliste ein `RequiredAttribute` hinzu. Der entsprechende Kommentar im ASP.NET Core-Quellcode ist da unmissverständlich: "For non-nullable reference types, treat them as-if they had an implicit [Required]."

Vier Details dieses Codes entscheiden fast jeden Fall, dem Sie begegnen werden:

1. **Das implizite Attribut verwendet `AllowEmptyStrings = true`.** Es lehnt nur `null` ab, nicht `""`. Ein JSON-Body mit `"name": ""` besteht die Validierung.
2. **Formular- und Query-Werte lehnen leere Strings trotzdem ab,** weil die Modellbindung von MVC leere und nur aus Leerzeichen bestehende Eingaben vor der Validierung in `null` umwandelt (`ConvertEmptyStringToNull` ist standardmäßig `true`). `?q=` und `?q=%20` scheitern beide mit "The q field is required."
3. **Parameter mit Standardwert sind ausgenommen.** `string sort = "name"` ist nie implizit erforderlich, weil der Provider Parameter überspringt, bei denen `HasDefaultValue` true ist.
4. **Oblivious-Code ist ausgenommen.** Wurde der Typ mit deaktivierten Nullable-Annotationen kompiliert, ist der Lesezustand `Unknown` statt `NotNull`, also wird nichts hinzugefügt. Deshalb taucht der Fehler meist an dem Tag auf, an dem jemand in einem älteren Projekt `<Nullable>enable</Nullable>` einschaltet, ohne dass sich ein einziges Modell ändert.

Nur MVC macht das. Controller, Razor Pages und MVC-Views laufen alle über `DataAnnotationsMetadataProvider`. Minimal APIs nicht, auch nicht die neue quellgenerierte Validierung aus `AddValidation()` in .NET 10, die unten bei den Stolperfallen behandelt wird.

## Minimale Reproduktion

```csharp
// ASP.NET Core 10.0.10, <Nullable>enable</Nullable>, Program.cs
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run();

public record CreateProduct(string Name, string? Nickname, string Sku = "");

public class Order
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!; // EF Core navigation
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController, Route("api")]
public class ProductsController : ControllerBase
{
    [HttpPost("create")] public IActionResult Create(CreateProduct p) => Ok(p);
    [HttpPost("order")]  public IActionResult Order(Order o) => Ok(o);
    [HttpGet("search")]  public IActionResult Search(string q) => Ok(q);
}
```

Was jede Anfrage zurückgab:

| Anfrage | Status | Fehlerschlüssel |
| --- | --- | --- |
| `POST /api/create` mit `{}` | 400 | `Name` |
| `POST /api/create` mit `{"name":null}` | 400 | `Name` |
| `POST /api/create` mit `{"name":""}` | 200 | keiner |
| `POST /api/create` mit `{"name":"x"}` | 200 | keiner |
| `POST /api/order` mit `{"title":"t","customerId":1}` | 400 | `Customer` |
| `GET /api/search` | 400 | `q` |
| `GET /api/search?q=` | 400 | `q` |

`Nickname` (deklariert als `string?`) und `Sku` (ein Parameter mit Standardwert) erzeugten nie einen Fehler. `Title` ebenfalls nicht, weil der Initialisierer `= ""` dafür sorgt, dass die JSON-Deserialisierung ihn bei fehlender Eigenschaft auf `""` belässt, und `""` erfüllt `AllowEmptyStrings = true`.

Die `Order`-Zeile verwirrt die meisten. `Customer` ist nicht nullbar, weil EF Core das für eine erforderliche Beziehung so will, `= null!` bringt [CS8618](/de/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) zum Schweigen, und dann liest MVC dieselbe Annotation und verlangt, dass der Client ein ganzes `Customer`-Objekt im Body mitschickt.

## Lösung 1: optionale Werte als nullbar deklarieren (empfohlen)

Wenn ein Wert legitimerweise fehlen darf, sollte der Typ das ausdrücken. Das behebt die Validierung und liefert Ihnen innerhalb der Aktion die Null-Prüfungen des Compilers:

```csharp
// ASP.NET Core 10.0.10
public record CreateProduct(string Name, string? Nickname, string? Description);

[HttpGet("search")]
public IActionResult Search(string? q) => Ok(q ?? "(all)");
```

Für Query- und Routenparameter mit sinnvollem Fallback funktioniert auch ein Standardwert, und er liest sich besser als eine Null-Prüfung:

```csharp
// ASP.NET Core 10.0.10
[HttpGet("list")]
public IActionResult List(string sort = "name", int page = 1) => Ok(new { sort, page });
```

Bei EF Core-Entitäten besteht die richtige Lösung darin, die Entität nicht mehr zu binden. Nehmen Sie ein Anfrage-DTO entgegen, das `CustomerId` und sonst nichts enthält, und mappen Sie es dann:

```csharp
// ASP.NET Core 10.0.10, EF Core 10
public record CreateOrder(string Title, int CustomerId);

[HttpPost("order")]
public async Task<IActionResult> Order(CreateOrder dto, AppDbContext db)
{
    var order = new Order { Title = dto.Title, CustomerId = dto.CustomerId };
    db.Orders.Add(order);
    await db.SaveChangesAsync();
    return CreatedAtAction(nameof(Order), new { id = order.Id }, new { order.Id });
}
```

Wenn Sie die Entitätsbindung gerade nicht ändern können, weist `[ValidateNever]` auf der Navigationseigenschaft (aus `Microsoft.AspNetCore.Mvc.ModelBinding.Validation`) MVC an, deren Validierung zu überspringen:

```csharp
// ASP.NET Core 10.0.10
[ValidateNever]
public Customer Customer { get; set; } = null!;
```

Damit wurde `{"title":"t"}` problemlos gebunden, und `Customer` blieb `null`. Das ist ein Flicken, kein Design. Ein Client kann weiterhin ein verschachteltes `customer`-Objekt senden, das EF Core bereitwillig einzufügen versucht.

## Lösung 2: die implizite Regel global abschalten

Wenn Sie nullbare Referenztypen in einer großen bestehenden API aktivieren und nicht jedes Modell auf einmal prüfen können, unterdrücken Sie die Ableitung in `AddControllers` (oder `AddMvc`, `AddRazorPages().AddMvcOptions(...)`):

```csharp
// ASP.NET Core 10.0.10, Program.cs
builder.Services.AddControllers(options =>
{
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true;
});
```

Mit dieser Option lieferte jede Zeile der obigen Tabelle 200, außer der leeren Abfrage, die `204 No Content` zurückgab, weil die Aktion `null` erhielt und `Ok(null)` zu einem 204 wird. Beachten Sie, was das bedeutet: Die Aktion lief mit `q == null`, obwohl die Signatur `string q` lautet. Sie haben ein 400 gegen einen Wert eingetauscht, von dem der Compiler schwört, dass er nicht null sein kann. Betrachten Sie das als Migrationsschalter und planen Sie, ihn zu entfernen, sobald die Modelle ehrlich annotiert sind.

## Lösung 3: die Regel behalten, die Meldung selbst bestimmen

Wenn die Eigenschaft wirklich erforderlich ist, erfüllt die implizite Validierung ihren Zweck, und die einzige Beschwerde ist der Wortlaut. Ein explizites Attribut ersetzt das implizite (der Provider fügt sein eigenes nur hinzu, wenn kein `[Required]` vorhanden ist):

```csharp
// ASP.NET Core 10.0.10
using System.ComponentModel.DataAnnotations;

public class CreateCustomer
{
    [Required(AllowEmptyStrings = false, ErrorMessage = "Customer name is required.")]
    public string Name { get; set; } = default!;
}
```

Auf diesem Weg lässt sich auch ein leerer JSON-String ablehnen, was die implizite Regel nie tut. Ein einfaches `[Required]` (bei dem `AllowEmptyStrings` standardmäßig `false` ist) lehnte `{"name":""}` in meiner Reproduktion mit einem 400 ab. Umgekehrt akzeptierte `[Required(AllowEmptyStrings = true)]` in meiner Reproduktion `""`, passend zum impliziten Verhalten.

Wenn Sie statt der Meldung die Form der Antwort ändern wollen, ist das ein Thema für Problem Details, nicht für die Validierung. Der Ansatz aus [Validierungsfehlerantworten mit IProblemDetailsService anpassen](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) funktioniert auch für Controller.

## Stolperfallen und ähnliche Fehler

**Minimal APIs verhalten sich anders.** Derselbe `CreateProduct`-Record, gebunden in einem Minimal-API-Endpunkt, akzeptierte `{}` und `{"name":null}` mit 200 und `Name == null`, selbst mit registriertem `builder.Services.AddValidation()` und einem `[StringLength(20)]` auf einer anderen Eigenschaft (das bei Verletzung sehr wohl ein 400 erzeugte, der Validator lief also). Der Validierungs-Source-Generator von .NET 10 berücksichtigt Attribute, leitet `[Required]` aber nicht aus der Nullbarkeit ab. Wenn Sie [Anfrage-Bodys in Minimal APIs validieren](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), fügen Sie `[Required]` explizit hinzu. Minimal-API-*Parameter* sind eine andere Geschichte: Ein fehlender nicht nullbarer Query-Parameter `string q` liefert ein 400 direkt vom Parameter-Binder, und in Development zeigt die Ausnahmeseite `BadHttpRequestException: Required parameter "string q" was not provided from query string.`

**Das C#-Schlüsselwort `required` ist ein anderer Fehler.** Ein `public required string Name { get; set; }` wird von System.Text.Json während der Deserialisierung erzwungen, noch vor der MVC-Validierung. Der Body in meiner Reproduktion war:

```json
{
  "$": ["JSON deserialization for type 'ReqKw' was missing required properties including: 'name'."],
  "o": ["The o field is required."]
}
```

Der zweite Eintrag, benannt nach dem Aktionsparameter, ist wieder die implizite Regel: Die Deserialisierung schlug fehl, der Parameter blieb `null`, und der nicht nullbare Parameter `ReqKw o` wurde daraufhin markiert. Wenn Sie den Parameter als `[FromBody] ReqKw? o` deklarieren, verschwindet dieser Störeintrag. Das Schlüsselwort `required` und `[JsonRequired]` wirken auf eigene Weise zusammen, behandelt in [System.Text.Json eine Eigenschaft mit dem required-Modifizierer ignorieren lassen](/de/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/) und [CS9035](/de/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**"The p field is required" bei leerem Body.** Ein Post ganz ohne Body an `Create(CreateProduct p)` lieferte zwei Fehler: `"": ["A non-empty request body is required."]` und `"p": ["The p field is required."]`. Deklarieren Sie den Parameter als `CreateProduct? p`, wird der leere Body zu einer erfolgreichen Bindung mit `p == null` (die Aktion gab 204 aus `Ok(null)` zurück). Tun Sie das also nur, wenn ein leerer Body für den Endpunkt gültig ist. `MvcOptions.AllowEmptyInputInBodyModelBinding` ist der globale Schalter für die erste Meldung.

**Nullable-Kontext in einer anderen Assembly.** Die Regel liest die Annotationen der Assembly, die das Modell deklariert, nicht die des Webprojekts. Modelle in einer gemeinsamen Bibliothek, die mit `<Nullable>disable</Nullable>` kompiliert wurde, bekommen nie das implizite Attribut, selbst wenn das API-Projekt Nullable aktiviert. Umgekehrt gilt das auch: Aktivieren Sie Nullable in der gemeinsamen Bibliothek, ändert sich das Verhalten der API, ohne dass das API-Projekt angefasst wird.

**Geerbte Eigenschaften.** Die Annotation wird von dem Member gelesen, der die Eigenschaft deklariert. Leitet ein DTO von einer Basisklasse in einem anderen Projekt ab, entscheidet der Nullable-Kontext der Basisklasse, nicht der des abgeleiteten Typs. Wenn eine Eigenschaft, die Sie für `string?` halten, trotzdem "required" meldet, suchen Sie die Stelle, an der sie tatsächlich deklariert ist.

**Werttypen brauchen eine andere Lösung.** Ein fehlendes `int` löst diese Regel gar nicht aus (Werttypen werden übersprungen). Es wird stillschweigend zu `0`. Wenn Sie "muss angegeben werden" brauchen, verwenden Sie `int?` mit `[Required]`.

## Verwandte Artikel

- [Anfrage-Bodys in Minimal APIs ohne Controller in ASP.NET Core 11 validieren](/de/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), wo Attribute die einzige Quelle für Pflichtfelder sind.
- [Minimal-API-Validierung vs. FluentValidation in ASP.NET Core 11](/de/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/), falls Sie entscheiden, wo Regeln wie diese leben sollen.
- [CS8618 beheben: Nicht nullbare Eigenschaft muss einen Wert ungleich null enthalten](/de/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/), die Compiler-Seite derselben Annotationen.
- [Eine RFC 9457 ProblemDetails-Antwort aus einem typisierten HttpClient verarbeiten](/de/2026/09/how-to-consume-an-rfc-9457-problemdetails-response-from-a-typed-httpclient/), für Clients, die das `errors`-Dictionary von oben auslesen.

## Quellen

- [Non-nullable reference types and [Required] attribute](https://learn.microsoft.com/aspnet/core/mvc/models/validation#non-nullable-reference-types-and-required-attribute) in "Model validation in ASP.NET Core MVC and Razor Pages" auf Microsoft Learn.
- [`MvcOptions.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes) API-Referenz.
- [`DataAnnotationsMetadataProvider.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Mvc/Mvc.DataAnnotations/src/DataAnnotationsMetadataProvider.cs) im Branch `release/10.0`, für die Ableitung von `AllowEmptyStrings = true` und die Ausnahme bei `HasDefaultValue`.
- [dotnet/aspnetcore#16654](https://github.com/dotnet/aspnetcore/issues/16654), ein früher Bericht über die Regel, die Nutzer bei geerbten Eigenschaften überraschte.

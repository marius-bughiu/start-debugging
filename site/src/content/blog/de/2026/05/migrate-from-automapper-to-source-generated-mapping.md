---
title: "Von AutoMapper zu Source-Generator-Mapping mit Mapperly migrieren"
description: "Eine Schritt-fuer-Schritt-Checkliste, um Profiles, IMapper, ForMember und ProjectTo von AutoMapper 15 durch von Riok.Mapperly 4.3 generierte Mapper in .NET 11 zu ersetzen."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/migrate-from-automapper-to-source-generated-mapping"
translatedBy: "claude"
translationDate: 2026-05-30
---

AutoMapper durch einen Source Generator zu ersetzen ist eine mechanische Refaktorierung Datei für Datei, keine Neuentwicklung. Für einen typischen Dienst mit 30-80 Mappings, verteilt über einige `Profile`-Klassen, planen Sie einen halben bis einen Tag ein: Jedes `CreateMap<Source, Dest>()` wird zu einer `partial`-Methode in einer `[Mapper]`-Klasse, Aufrufe von `IMapper.Map<T>` werden zu direkten Methodenaufrufen, und `ProjectTo<T>()` wird zu einer generierten `IQueryable`-Erweiterung. Was bricht, ist alles, was sich auf die Laufzeitflexibilität von AutoMapper stützte: dynamische `Map(object)`-Aufrufe, `IValueResolver` mit injizierten Diensten und die Registrierung per Assembly-Scan. Es lohnt sich, wenn Sie über AutoMappers Umsatzgrenze von 5.000.000 USD liegen und keine Lizenz kaufen wollen, wenn Sie möchten, dass Native AOT und Trimming funktionieren, oder wenn Sie möchten, dass nicht gemappte Eigenschaften die Kompilierung fehlschlagen lassen, anstatt zur Laufzeit stillschweigend verworfen zu werden.

Referenzierte Versionen: Dieser Leitfaden behandelt das Verlassen von AutoMapper 14.x (das letzte MIT-Release) und 15.0 (das erste Release mit dualer Reciprocal Public License 1.5 / kommerzieller Lizenz von Lucky Penny Software). Der Ersatz zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET 11 SDK, C# 14 und Riok.Mapperly 4.3.1 (veröffentlicht am 2025-12-22) ab. Falls Sie noch entscheiden, ob Sie überhaupt wechseln, ist es dieselbe Anbietergeschichte wie bei MediatR; lesen Sie daher [von MediatR zu einfacher Dependency Injection migrieren](/de/2026/05/migrate-from-mediatr-to-plain-dependency-injection/) für den parallelen Fall. Dieser Artikel setzt voraus, dass die Entscheidung gefallen ist.

## Warum Teams gerade jetzt AutoMapper verlassen

- **Die Lizenz erzwingt eine Entscheidung oberhalb von 5 Mio. USD.** AutoMapper 15.0 wird unter der reziproken Copyleft-Lizenz RPL-1.5 plus einer kostenpflichtigen kommerziellen Stufe veröffentlicht. Die kostenlose Nutzung deckt Unternehmen unter 5.000.000 USD Bruttojahresumsatz und Nicht-Produktionsumgebungen ab. Oberhalb dieser Grenze kann kommerzielle Closed-Source-Software den RPL-Build nicht nutzen, also heißt es kaufen oder gehen. Alles, was unter MIT (14.x und früher) veröffentlicht wurde, bleibt für immer unter MIT nutzbar, aber Sie erhalten keine Fixes mehr.
- **Mapping-Fehler verschieben sich von der Laufzeit zur Kompilierzeit.** AutoMapper validiert die Konfiguration nur, wenn Sie `AssertConfigurationIsValid()` aufrufen oder das Mapping zur Laufzeit erreichen. Mapperly meldet eine nicht gemappte Eigenschaft als `RMG`-Diagnose zur Kompilierzeit, sodass ein vergessenes Feld eine Build-Warnung ist, keine `NullReferenceException` in der Produktion.
- **Der Start wird günstiger und AOT wird einfacher.** AutoMapper baut und kompiliert Mapping-Ausdrücke beim ersten Gebrauch per Reflexion. Mapperly emittiert reines C# zur Kompilierzeit, also gibt es keine Startkosten und keine Reflexion, die mit dem Trimmer ringt, was beim [Reduzieren der Kaltstartzeit einer .NET 11 AWS Lambda](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) oder beim Ausliefern von [Native AOT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) wichtig ist.
- **Sie können den generierten Code lesen.** Mapperly schreibt einen lesbaren partiellen Methodenrumpf, in den Sie hineinspringen können, anstelle eines undurchsichtigen kompilierten Ausdrucksbaums.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| `IMapper`-Injektion | Ersetzt durch die konkrete generierte Mapper-Klasse, direkt injiziert | hoch |
| `Profile` + `CreateMap<,>()` | Kollabieren zu einer partiellen `[Mapper]`-Klasse mit einer `partial`-Methode pro Richtung | hoch |
| `ForMember(... MapFrom ...)` | Ersetzt durch `[MapProperty]` oder eine private Mapping-Methode | hoch |
| `ReverseMap()` | Keine automatische Umkehrung; Sie deklarieren die Rückrichtungsmethode explizit | mittel |
| `IValueResolver` / `ITypeConverter` mit DI | Ersetzt durch einen Konstruktor am Mapper plus eine private Methode | mittel |
| `ProjectTo<T>(config)` | Ersetzt durch eine generierte `IQueryable<T>`-Projektionserweiterung | mittel |
| `AddAutoMapper(assembly)`-Scan | Ersetzt durch explizite `AddSingleton<TMapper>()`-Registrierung | mittel |
| `mapper.Map(object, type)` (dynamisch) | Kein untypisierter Laufzeit-Einstiegspunkt; jedes Mapping ist eine typisierte Methode | hoch |
| `AssertConfigurationIsValid()`-Test | Überflüssig; der Build ist die Zusicherung | niedrig |

## Pre-Flight-Checkliste

1. **Installieren Sie das .NET 11 SDK** und bestätigen Sie, dass `dotnet --version` `11.0.x` meldet.
2. **Inventarisieren Sie Ihre Mappings.** Führen Sie ein grep nach `CreateMap<` aus, um die Konfigurationen zu zählen, und nach `\.Map<` und `ProjectTo<`, um die Aufrufstellen zu zählen. Das ist der Umfang Ihrer Migration.
3. **Finden Sie die dynamischen Mappings.** Suchen Sie per grep nach `Map(`-Aufrufen, die ein `Type`-Argument oder eine `object`-Quelle übergeben. Diese haben kein direktes Mapperly-Äquivalent und brauchen eine typisierte Methode oder einen manuellen Switch; kümmern Sie sich zuerst darum.
4. **Finden Sie die Resolver.** Suchen Sie per grep nach `IValueResolver`, `ITypeConverter` und `IMappingAction`. Jeder braucht eine private Methode am Mapper.
5. **Kein spezielles Backup nötig, verzweigen Sie normal.** Diese Änderung ist Datei für Datei reversibel (siehe Rollback-Plan), also genügt ein Feature-Branch.

## Migrationsschritte

### 1. Fügen Sie Mapperly neben AutoMapper hinzu

Installieren Sie beide Pakete, um ein Profile nach dem anderen migrieren zu können:

```bash
# .NET 11 SDK, run from the project directory
dotnet add package Riok.Mapperly --version 4.3.1
```

Mapperly liefert nur einen Analyzer und die Attribute aus `Riok.Mapperly.Abstractions`, fügt also keine Laufzeitabhängigkeit hinzu. Stellen Sie sicher, dass der Build weiterhin gelingt: `dotnet build` ohne neue Fehler. Lassen Sie das AutoMapper-Paket referenziert, bis das letzte Profile verschwunden ist.

### 2. Konvertieren Sie ein einfaches Profile zu einer `[Mapper]`-Klasse

Nehmen Sie zuerst das kleinste Profile. Das Vorher:

```csharp
// AutoMapper 15.0
public class CarProfile : Profile
{
    public CarProfile()
    {
        CreateMap<Car, CarDto>();
    }
}
```

Das Nachher ist eine partielle Klasse mit einer partiellen Methode. Mapperly füllt den Rumpf:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
using Riok.Mapperly.Abstractions;

[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
}
```

Verifizieren: Bauen Sie das Projekt und öffnen Sie die generierte Datei (sie erscheint in der Analyzer-Ausgabe, oder setzen Sie `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` in der `.csproj`, um sie auf die Festplatte zu schreiben). Bestätigen Sie, dass jede Eigenschaft von `CarDto` zugewiesen wird. Falls eine nicht zugewiesen wird, emittiert Mapperly eine Diagnose wie `RMG020` für ein nicht gemapptes Zielmitglied; das ist die Funktion, kein Fehlschlag.

### 3. Übersetzen Sie `ForMember` zu `[MapProperty]`

AutoMappers Anpassung pro Mitglied bildet sich auf Mapperly-Attribute ab. Eine Umbenennung:

```csharp
// AutoMapper 15.0
CreateMap<Car, CarDto>()
    .ForMember(d => d.ModelName, o => o.MapFrom(s => s.Model));
```

wird zu einem `[MapProperty]`-Attribut, das die Quell- und Zielmitglieder benennt:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[MapProperty(nameof(Car.Model), nameof(CarDto.ModelName))]
public partial CarDto ToDto(Car car);
```

Für einen berechneten Wert wird AutoMappers Inline-`MapFrom`-Lambda zu einer privaten Mapping-Methode, die per `Use` referenziert wird:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => price.ToString("C");
}
```

Um eine Eigenschaft bewusst zu verwerfen, ersetzen Sie AutoMappers `Ignore()` durch `[MapperIgnoreTarget(nameof(CarDto.Internal))]` oder `[MapperIgnoreSource(nameof(Car.Secret))]`. Verifizieren Sie jede Konvertierung, indem Sie prüfen, dass der generierte Rumpf genau die erwarteten Mitglieder zuweist.

### 4. Ersetzen Sie `ReverseMap()` durch eine explizite Methode

AutoMappers `ReverseMap()` ist ein einzelner Aufruf. Mapperly hat keine automatische Umkehrung, also deklarieren Sie die Rückrichtung als eigene Methode am selben Mapper:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    public partial CarDto ToDto(Car car);
    public partial Car ToEntity(CarDto dto);
}
```

Das ist mehr Code, aber ehrlich: Das umgekehrte Mapping ist nicht mehr implizit, sodass eine asymmetrische Eigenschaft (ein Zielfeld ohne Quelle) als eigene Diagnose auftaucht, statt stillschweigend ignoriert zu werden. Verifizieren Sie beide generierten Rümpfe.

### 5. Verschieben Sie Resolver mit Abhängigkeiten in den Konstruktor des Mappers

Ein AutoMapper-`IValueResolver`, der einen injizierten Dienst benötigt:

```csharp
// AutoMapper 15.0
public class PriceResolver : IValueResolver<Car, CarDto, string>
{
    private readonly ICurrencyService _currency;
    public PriceResolver(ICurrencyService currency) => _currency = currency;
    public string Resolve(Car s, CarDto d, string m, ResolutionContext ctx)
        => _currency.Format(s.Price);
}
```

wird zu einem Konstruktor am Mapper plus einer privaten Methode. Mapperly generiert einen Konstruktor, der die von Ihnen deklarierten Parameter weiterleitet, sodass der Mapper an der normalen Konstruktorinjektion teilnimmt:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public partial class CarMapper
{
    private readonly ICurrencyService _currency;
    public CarMapper(ICurrencyService currency) => _currency = currency;

    [MapProperty(nameof(Car.Price), nameof(CarDto.Price), Use = nameof(FormatPrice))]
    public partial CarDto ToDto(Car car);

    private string FormatPrice(decimal price) => _currency.Format(price);
}
```

Verifizieren Sie, indem Sie den Mapper in einem Test aus dem Container auflösen und den formatierten Preis prüfen.

### 6. Konvertieren Sie `ProjectTo<T>` zu einer generierten Projektion

AutoMappers `ProjectTo<T>()` baut einen `Expression`-Baum, damit EF Core das Mapping in SQL übersetzen kann. Mapperly generiert dieselbe Art von `IQueryable`-Erweiterung, wenn Sie eine Methode deklarieren, die `IQueryable<T>` entgegennimmt und zurückgibt:

```csharp
// .NET 11, C# 14, Riok.Mapperly 4.3.1
[Mapper]
public static partial class CarQueryMapper
{
    public static partial IQueryable<CarDto> ProjectToDto(this IQueryable<Car> q);
}
```

Die Aufrufstelle ändert sich von `.ProjectTo<CarDto>(_config)` zu `.ProjectToDto()`:

```csharp
// .NET 11, EF Core 11
var dtos = await db.Cars
    .Where(c => c.NumberOfSeats > 4)
    .ProjectToDto()
    .ToListAsync();
```

Verifizieren Sie, indem Sie das generierte SQL erfassen (`db.Cars...ToQueryString()` oder das EF-Core-Logging) und bestätigen, dass die Projektion in der Datenbank läuft, nicht im Speicher. Beachten Sie, dass Mapperlys Projektionspfad keine Object Factories oder benutzerdefinierte objekterzeugende Methoden ausführt, da er einen übersetzbaren Ausdrucksbaum erzeugen muss.

### 7. Ersetzen Sie die DI-Registrierung

Löschen Sie die AutoMapper-Registrierung und den Assembly-Scan:

```csharp
// AutoMapper 15.0 - remove this
builder.Services.AddAutoMapper(typeof(CarProfile).Assembly);
```

Registrieren Sie jeden Mapper explizit. Ein Mapper ohne injizierte Abhängigkeiten ist zustandslos und threadsicher, registrieren Sie ihn also als Singleton; einer mit einer scoped Abhängigkeit muss zu diesem Lebenszyklus passen:

```csharp
// .NET 11
builder.Services.AddSingleton<CarMapper>();        // no dependencies
builder.Services.AddScoped<InvoiceMapper>();       // depends on a scoped service
```

Ändern Sie dann die Konsumenten von `IMapper` auf den konkreten Mapper. `_mapper.Map<CarDto>(car)` wird zu `_carMapper.ToDto(car)`. Statische Mapper benötigen überhaupt keine Registrierung; rufen Sie `CarQueryMapper.ProjectToDto(query)` direkt auf. Verifizieren Sie, dass die App startet: Eine fehlende Registrierung ist nun eine `InvalidOperationException` beim Start, genau das frühe Fehlschlagen, das Sie wollen.

### 8. Entfernen Sie AutoMapper

Sobald das grep nach `using AutoMapper` und `CreateMap<` nichts mehr zurückgibt, entfernen Sie das Paket:

```bash
dotnet remove package AutoMapper
```

Verifizieren Sie mit einem sauberen `dotnet build` und einem vollständigen `dotnet test`-Lauf.

## Verifizierung

Führen Sie diese Checkliste aus, nachdem das letzte Profile verschwunden ist:

- `dotnet build` erzeugt null Fehler, und Sie haben jede `RMG`-Diagnose geprüft und Warnungen über nicht gemappte Mitglieder als beabsichtigt behandelt oder behoben.
- `dotnet test` läuft mit null Fehlschlägen durch, einschließlich jedes Tests, der zuvor `AssertConfigurationIsValid()` aufrief (löschen Sie diese; der Build ist nun die Zusicherung).
- Die Projektionsabfragen werden weiterhin in SQL übersetzt: Bestätigen Sie mit `ToQueryString()`, dass kein `ProjectToDto()` auf clientseitige Auswertung zurückfällt.
- Für einen AOT- oder getrimmten Build erzeugt `dotnet publish -c Release` keine `IL2xxx`-Trim-Warnungen, die zuvor aus AutoMappers Reflexion kamen.
- Eine kaltstartempfindliche Arbeitslast startet messbar schneller; das erste Mapping zahlt nicht mehr die Kosten der Ausdruckskompilierung.

## Rollback-Plan

Diese Migration ist Datei für Datei reversibel, was ihre wichtigste Sicherheitseigenschaft ist. Da Sie AutoMapper bis Schritt 7 referenziert gelassen haben, kann jeder einzelne Mapper, der sich falsch verhält, rückgängig gemacht werden, indem Sie sein `Profile` wiederherstellen und diesen einen Konsumenten zurück auf `IMapper` umstellen; die beiden Systeme koexistieren ohne Konflikt. Der einzige Punkt ohne Wiederkehr ist Schritt 8, das Entfernen des Pakets. Löschen Sie AutoMapper nicht, bevor jeder Konsument konvertiert ist und die gesamte Testsuite grün ist. Wenn Sie nervös sind, liefern Sie die Mapper-Konvertierungen in einem Release und das Entfernen des Pakets im nächsten aus.

## Stolpersteine, auf die wir trafen

- **`RMG020` bei Eigenschaften, die Sie tatsächlich verwerfen wollten.** Mapperly warnt, wenn ein Quellmitglied auf nichts abbildet. Bringen Sie es bewusst mit `[MapperIgnoreSource(...)]` zum Schweigen, statt die Diagnose global zu unterdrücken, damit der nächste unbeabsichtigte Wegfall weiterhin warnt.
- **Das Abflachen ist nicht automatisch, wie Sie erwarten.** AutoMapper flacht `Order.Customer.Name` per Namenskonvention in `OrderDto.CustomerName` ab. Mapperly unterstützt das Abflachen verschachtelter Mitglieder, aber wenn Ihr DTO-Name nicht dem gepunkteten Quellpfad entspricht, müssen Sie ihn mit `[MapProperty([nameof(Order.Customer), nameof(Customer.Name)], nameof(OrderDto.CustomerName))]` ausschreiben.
- **Kein untypisiertes `Map(object, Type)`.** Wenn Sie eine generische Pipeline hatten, die `object` auf einen Laufzeit-`Type` abbildete, gibt es kein von einem Source Generator erzeugtes Äquivalent. Ersetzen Sie es durch eine typisierte Methode pro Paar oder behalten Sie einen kleinen handgeschriebenen Switch. Dies ist die einzige Stelle, an der ein sauberer Wechsel unmöglich ist.
- **`record`-Ziele mit `init` und primärem Konstruktor.** Mapperly mappt über den Konstruktor, wenn ein Ziel ein `record` ist oder nur `init`-Setter hat, was meist gewollt ist; wenn er den falschen Konstruktor wählt, klären Sie es mit `[MapperConstructor]`. AutoMappers Verhalten war hier lockerer, sodass ein zuvor funktionierendes Mapping eine echte Mehrdeutigkeit zutage fördern kann. Zu den Zielformen siehe [record vs class vs struct in C#](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/).
- **Enum-Mapping ist nach Namen strenger.** Mapperly mappt Enums standardmäßig nach Wert und kann vor nicht gemappten Enum-Mitgliedern warnen, wo AutoMapper den Integer stillschweigend durchreichte. Entscheiden Sie sich explizit zwischen nach Wert und nach Namen mit der Strategie `[MapEnum]`.

Wenn Sie verstehen wollen, wie der Generator dies zur Kompilierzeit tut, bevor Sie ihm in der Produktion vertrauen, ist die Mechanik dieselbe wie in [wie man einen Source Generator für INotifyPropertyChanged schreibt](/de/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/).

## Quellen

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/), Jimmy Bogard
- [AutoMapper and MediatR Licensing Update](https://www.jimmybogard.com/automapper-and-mediatr-licensing-update/), Jimmy Bogard
- [Mapperly-Dokumentation: Konfiguration und Queryable-Projektionen](https://mapperly.riok.app/docs/configuration/mapper/)
- [riok/mapperly auf GitHub](https://github.com/riok/mapperly) und [Riok.Mapperly 4.3.1 auf NuGet](https://www.nuget.org/packages/Riok.Mapperly)

---
title: "Sensible Werte mit LogProperties und Data Redaction in .NET aus Logs entfernen"
description: "Ein vollständiger Leitfaden zur Redaktion klassifizierter Daten in per Source Generator erzeugten Logs: Taxonomie aufbauen, einen Redactor schreiben, EnableRedaction und AddRedaction verdrahten und den Diskriminator verstehen, der partielle Maskierung stillschweigend zerstört. Mit echter Ausgabe aus Microsoft.Extensions.Compliance.Redaction 10.9.0."
pubDate: 2026-08-17
template: how-to
tags:
  - "dotnet"
  - "logging"
  - "security"
  - "source-generators"
lang: "de"
translationOf: "2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet"
translatedBy: "claude"
translationDate: 2026-08-17
---

Die Redaktion sensibler Werte in .NET-Logs erfordert drei Bausteine, die alle vorhanden sein müssen: ein Datenklassifizierungsattribut an der Eigenschaft, `AddRedaction` zur Registrierung der Redactors in der Dependency Injection und `EnableRedaction` am Logging-Builder. Fehlt die Klassifizierung, wird nichts geschützt. Fehlt `EnableRedaction`, verschwinden die klassifizierten Werte vollständig aus dem strukturierten Zustand. Fehlt `AddRedaction`, während `EnableRedaction` aktiv ist, landen die Rohwerte im Klartext in Ihren Logs. Dieser Artikel behandelt alle drei sowie den Redaktions-Diskriminator, der jeden Redactor mit partieller Maskierung stillschweigend zerstört.

Alles Folgende wurde gegen `Microsoft.Extensions.Compliance.Redaction` 10.9.0, `Microsoft.Extensions.Compliance.Abstractions` 10.9.0 und `Microsoft.Extensions.Telemetry` 10.9.0 kompiliert und ausgeführt, auf dem .NET SDK 10.0.201 mit Ziel `net10.0`. Diese Pakete erscheinen im Rhythmus von `dotnet/extensions` und nicht in dem der Runtime, und 10.9.0 (veröffentlicht am 2026-08-11) zielt auf `net8.0`, `net9.0`, `net10.0` und `net462`. Derselbe Code gilt also von .NET 8 bis zu den aktuellen .NET 11 Previews. Eine 11.x-Version dieser Pakete existiert noch nicht.

## Was der Source Generator für eine klassifizierte Eigenschaft tatsächlich erzeugt

Das gesamte Feature ruht auf einer einzigen Tatsache: Der Source Generator von `[LoggerMessage]` schreibt klassifizierte Werte in ein *separates Array*, getrennt von den gewöhnlichen Tags. Gegeben diese Log-Methode:

```csharp
// Microsoft.Extensions.Telemetry.Abstractions 10.9.0, net10.0
public static partial class Log
{
    [LoggerMessage(2, LogLevel.Information, "Via LogProperties")]
    public static partial void ViaProps(this ILogger logger, [LogProperties] Payment payment);
}
```

erzeugt der Generator (gekürzt, ansonsten wörtlich aus `EmitCompilerGeneratedFiles`):

```csharp
var state = LoggerMessageHelper.ThreadLocalState;

_ = state.ReserveTagSpace(2);
state.TagArray[1] = new("{OriginalFormat}", "Via LogProperties");
state.TagArray[0] = new("payment.Amount", payment?.Amount);

_ = state.ReserveClassifiedTagSpace(2);
state.ClassifiedTagArray[1] = new("payment.CardNumber", payment?.CardNumber,
    new DataClassificationSet(_SensitiveAttribute));
state.ClassifiedTagArray[0] = new("payment.Cvv", payment?.Cvv,
    new DataClassificationSet(_SensitiveAttribute));
```

`Amount` landet in `TagArray`. `CardNumber` und `Cvv` landen in `ClassifiedTagArray`, zusammen mit dem `DataClassificationSet` aus dem Attribut. Hier redigiert nichts irgendetwas: Der Generator *kennzeichnet* die Werte lediglich. Wer `LoggerMessageState` konsumiert, entscheidet über den weiteren Verlauf, und genau deshalb ist die Verdrahtung so wichtig. Falls Sie noch nicht wissen, wie `[LoggerMessage]` überhaupt Code erzeugt, lohnt der Umweg über [was ein Source Generator ist und wann Sie einen brauchen](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## Taxonomie, Attribute und einen Redactor aufbauen

Eine Klassifizierung ist ein Paar aus `(TaxonomyName, Value)`. Definieren Sie sie einmal in einer statischen Klasse, damit die gesamte Solution dasselbe Vokabular teilt:

```csharp
// Microsoft.Extensions.Compliance.Abstractions 10.9.0
using Microsoft.Extensions.Compliance.Classification;

public static class Taxonomy
{
    public const string Name = "Contoso";

    public static DataClassification Sensitive => new(Name, nameof(Sensitive));
    public static DataClassification Pii => new(Name, nameof(Pii));
}
```

Die MS-Learn-Beispiele zu diesem Feature zeigen klassifizierte Parameter in der Form `[MyTaxonomyClassifications.Private] string SSN`. Das kompiliert nicht: Eine statische Eigenschaft ist kein Attribut. Sie brauchen pro Klassifizierung eine echte Unterklasse von `DataClassificationAttribute`, so wie es die [Dokumentation zur Datenklassifizierung](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification) korrekt beschreibt:

```csharp
public sealed class SensitiveAttribute : DataClassificationAttribute
{
    public SensitiveAttribute() : base(Taxonomy.Sensitive) { }
}

public sealed class PiiAttribute : DataClassificationAttribute
{
    public PiiAttribute() : base(Taxonomy.Pii) { }
}
```

Nun das Modell annotieren. Alles ohne Attribut wird unverändert protokolliert:

```csharp
public sealed class Payment
{
    [Sensitive] public string CardNumber { get; set; } = "";
    [Pii] public string Email { get; set; } = "";
    public int Amount { get; set; }
    [LogPropertyIgnore] public string InternalTrace { get; set; } = "";
}
```

Ein Redactor ist eine abstrakte Klasse mit zwei Membern. `GetRedactedLength` dimensioniert den Zielpuffer, `Redact` füllt ihn und gibt zurück, wie viele Zeichen geschrieben wurden:

```csharp
// Microsoft.Extensions.Compliance.Redaction 10.9.0
using Microsoft.Extensions.Compliance.Redaction;

public sealed class LastFourRedactor : Redactor
{
    public override int GetRedactedLength(ReadOnlySpan<char> input)
        => input.Length <= 4 ? input.Length : 4 + 4;

    public override int Redact(ReadOnlySpan<char> source, Span<char> destination)
    {
        if (source.Length <= 4)
        {
            source.CopyTo(destination);
            return source.Length;
        }

        "****".CopyTo(destination);
        source[^4..].CopyTo(destination[4..]);
        return 8;
    }
}
```

Die span-basierte Signatur ist Absicht: Die Logging-Pipeline redigiert über einen gepoolten `JustInTimeRedactor` von Span zu Span, sodass ein gut geschriebener Redactor pro Log-Eintrag nichts allokiert.

## Die Verdrahtung

Vier Schritte, und alle vier sind tragend:

1. Installieren Sie `Microsoft.Extensions.Compliance.Redaction` für die Redactors und `Microsoft.Extensions.Telemetry` für die Logging-Integration. Die Klassifizierungstypen kommen transitiv über `Microsoft.Extensions.Compliance.Abstractions`.
2. Rufen Sie `AddRedaction` auf der Service Collection auf und ordnen Sie jeder Klassifizierung einen Redactor zu.
3. Rufen Sie `EnableRedaction` auf dem Logging-Builder auf. Das tauscht den `ExtendedLogger` ein, die einzige Komponente, die `ClassifiedTagArray` liest.
4. Protokollieren Sie über eine per Source Generator erzeugte `[LoggerMessage]`-Methode. Redaktion gilt nicht für `logger.LogInformation(...)`.

```csharp
var services = new ServiceCollection();

services.AddLogging(b =>
{
    b.AddJsonConsole();
    b.EnableRedaction();          // Microsoft.Extensions.Logging namespace
});

services.AddRedaction(r =>
{
    r.SetRedactor<LastFourRedactor>(Taxonomy.Sensitive);
    r.SetFallbackRedactor<ErasingRedactor>();
});
```

`EnableRedaction` liegt im Namespace `Microsoft.Extensions.Logging`, obwohl es im Paket `Microsoft.Extensions.Telemetry` ausgeliefert wird. Das `using Microsoft.Extensions.Telemetry;` aus dem offiziellen Beispiel wird also nicht benötigt.

## Die drei Konfigurationen und was jede davon wirklich protokolliert

Hier beißt das Feature. Dasselbe `Payment` unter drei verschiedenen Verdrahtungen, entnommen der tatsächlichen `JsonConsole`-Ausgabe.

**`AddRedaction` registriert, `EnableRedaction` nicht aufgerufen.** Der gewöhnliche `ILogger` schaut nie in `ClassifiedTagArray`, daher fehlen die klassifizierten Eigenschaften im strukturierten Zustand und die abgeflachte Nachricht zeigt einen Platzhalter:

```json
{"State":{"Message":"customer.Plan=enterprise,customer.Id=42,customer.CardNumber=<omitted> ([Contoso:Sensitive]),customer.Email=<omitted> ([Contoso:Pii])","customer.Plan":"enterprise","customer.Id":42}}
```

Kein Leck, aber auch keine Daten, und kein Fehler weist darauf hin, dass die Redaktion abgeschaltet ist. Dieses Verhalten wird in [dotnet/extensions Issue 5163](https://github.com/dotnet/extensions/issues/5163) verfolgt.

**`EnableRedaction` aufgerufen, `AddRedaction` nie aufgerufen.** Das ist der gefährliche Fall. Ohne `IRedactorProvider` im Container fällt die Pipeline auf einen durchreichenden Redactor zurück und schreibt den Rohwert:

```json
{"State":{"customer.CardNumber":"4111111111111111:customer.CardNumber","customer.Email":"ada@contoso.com:customer.Email"}}
```

Ihre Kartennummern stehen jetzt in der Logdatei, mit hilfsbereit angehängtem Tag-Namen. Nichts warnt Sie. Falls Sie nur eines aus diesem Artikel mitnehmen: `EnableRedaction` und `AddRedaction` müssen gemeinsam hinzugefügt werden, und ein Integrationstest, der die Log-Senke nach einem bekannten Geheimnis durchsucht, ist eine billige Versicherung.

**Beide aufgerufen.** Klassifizierte Werte werden redigiert, nicht klassifizierte gehen unverändert durch, und Eigenschaften mit `[LogPropertyIgnore]` tauchen überhaupt nicht auf:

```json
{"State":{"payment.Email":"****","payment.CardNumber":"****","payment.Amount":1999}}
```

`AddRedaction()` ganz ohne Konfiguration aufzurufen ist sicher: Der Standard-Fallback ist `ErasingRedactor`, sodass jeder klassifizierte Wert zur leeren Zeichenkette wird. Direkt gegen den Provider verifiziert: `GetRedactor` liefert `ErasingRedactor` für eine nicht zugeordnete Klassifizierung und für `DataClassification.Unknown`, und `NullRedactor` (Durchreichen) nur für `DataClassification.None`.

## Der Diskriminator, der partielle Maskierung zerstört

Registrieren Sie den `LastFourRedactor` von oben, protokollieren Sie die Kartennummer `4111111111111111`, und Sie erhalten dies:

```json
{"payment.CardNumber":"****mber","payment.Email":"****mail"}
```

`mber` sind die letzten vier Zeichen von `payment.CardNumber`, nicht die der Karte. Der Redactor hat den Wert nie für sich allein gesehen. Eine Instrumentierung von `Redact` mit einem Spion zeigt genau, was ankommt:

```text
[spy] Redact saw: "4111111111111111:payment.CardNumber" (len 35)
[spy] Redact saw: "ada@contoso.com:payment.Email"      (len 29)
```

Das ist Absicht, kein Fehler. Der `ExtendedLogger` baut jede Redaktion über `JustInTimeRedactor.Get(value, redactor, discriminator)`, wobei der Diskriminator der Tag-Name ist, und `LoggerRedactionOptions.ApplyDiscriminator` ist standardmäßig `true`. Die dokumentierte Begründung ist Korrelationsresistenz: Wird der Tag-Name in den redigierten Text aufgenommen, lässt sich nicht mehr erkennen, dass ein gehashtes `user.Email` und ein gehashtes `contact.Email` dieselbe Adresse sind. Für hashende Redactors ist das ein wirklich guter Standard, für alles, was die Eingabe auswertet, ein stiller Korrektheitsfehler.

Die Korrektur ist eine einzige Option:

```csharp
b.EnableRedaction(o => o.ApplyDiscriminator = false);
```

Mit abgeschaltetem Diskriminator liefert derselbe Redactor das Erwartete:

```json
{"payment.CardNumber":"****1111","payment.Email":"****.com"}
```

Schalten Sie ihn nur für Redactors ab, die den echten Wert sehen müssen. Wenn Sie sich auf gehashte Werte verlassen, um Wiederholungen innerhalb eines einzelnen Feldes zu erkennen, lassen Sie ihn an. Beachten Sie: Ein direkt über `IRedactorProvider` aufgerufener Redactor sieht nie einen Diskriminator. Ein isolierter Unit-Test Ihres Redactors besteht also, während sich die Logging-Pipeline falsch verhält. Testen Sie über den Logger.

## Hashen statt löschen

`HmacRedactor` erzeugt einen stabilen `HMACSHA256`-Hash, mit dem sich Vorkommen desselben Wertes korrelieren lassen, ohne ihn zu speichern:

```csharp
#pragma warning disable EXTEXP0002
services.AddRedaction(r => r.SetHmacRedactor(o =>
{
    o.KeyId = 42;
    o.Key = Convert.ToBase64String(keyBytes);   // base64, at least 44 chars
}, Taxonomy.Pii));
#pragma warning restore EXTEXP0002
```

Echte Ausgabe, mit abgeschaltetem `ApplyDiscriminator`:

```json
{"payment.Email":"42:AjapxXMS14J9i8GFw62JBQ==","payment.CardNumber":""}
```

Das Präfix `42:` ist die `KeyId`, sodass nach einer Rotation erkennbar bleibt, welcher Schlüssel einen Hash erzeugt hat. Zwei Vorbehalte. `SetHmacRedactor` ist experimentell und löst `EXTEXP0002` aus, Sie brauchen also eine explizite Unterdrückung oder `<NoWarn>$(NoWarn);EXTEXP0002</NoWarn>`. Und `CardNumber` kam oben leer heraus, weil es als `Sensitive` klassifiziert ist, wofür hier kein Redactor zugeordnet wurde und daher der `ErasingRedactor`-Fallback greift. Ordnen Sie jeder von Ihnen definierten Klassifizierung einen Redactor zu, sonst entscheidet der Fallback stillschweigend für Sie.

## Der Rest der LogProperties-Oberfläche

`[LogProperties]` hat mehr Stellschrauben, als die meisten nutzen:

```csharp
[LoggerMessage(4, LogLevel.Information, "Charging customer")]
public static partial void Charging(this ILogger logger,
    [LogProperties(OmitReferenceName = false, SkipNullProperties = true)] Customer customer);
```

`OmitReferenceName` ist standardmäßig `false`, und genau das erzeugt das Präfix `customer.` an jedem Tag-Namen; auf `true` gesetzt werden die Tags schlicht zu `Id`, `Plan` und so weiter. `SkipNullProperties = true` lässt Eigenschaften mit Nullwert aus dem Zustand weg, statt Nullen zu schreiben. Beides sind gewöhnliche Compile-Zeit-Optionen ohne Laufzeitkosten.

Verschachtelte Objekte werden standardmäßig nicht durchlaufen. Ein `Customer.Address` eines komplexen Typs erzeugt eine Build-Warnung, statt stillschweigend in eine Zeichenkette umgewandelt zu werden:

```text
warning LOGGEN036: The type "Address?" doesn't implement ToString(), IConvertible, or IFormattable
(did you forget to apply [LogProperties] or [TagProvider] to "Address"?)
```

Die Lösung besteht darin, `[LogProperties]` an die verschachtelte Eigenschaft selbst zu schreiben, die dann `customer.Address.Street`-Tags erzeugt, samt der Klassifizierungsattribute auf `Address`. Es gibt außerdem `[LogProperties(Transitive = true)]`, um den Graphen automatisch zu durchlaufen, doch das ist als experimentell markiert und lässt den Build mit `EXTEXP0003` scheitern, bis es unterdrückt wird.

## Werte klassifizieren, die Sie nicht attributieren können

Attribute funktionieren nur an Typen, die Ihnen gehören. Für ein DTO eines Drittanbieters, oder wenn die Klassifizierung vom Laufzeitzustand abhängt, verwenden Sie `[TagProvider]` und klassifizieren innerhalb einer selbst geschriebenen Collector-Methode:

```csharp
public static class SessionTagProvider
{
    public static void Provide(ITagCollector collector, Session session)
    {
        collector.Add("user", session.User);
        collector.Add("token", session.Token, new DataClassificationSet(Taxonomy.Sensitive));
    }
}

[LoggerMessage(2, LogLevel.Information, "Session opened")]
public static partial void Opened(this ILogger logger,
    [TagProvider(typeof(SessionTagProvider), nameof(SessionTagProvider.Provide),
                 OmitReferenceName = true)] Session session);
```

Die Überladung von `ITagCollector.Add` mit einem `DataClassificationSet` ist das programmatische Äquivalent eines Klassifizierungsattributs, und der Wert fließt auf genau demselben Weg in `ClassifiedTagArray`. Achten Sie auf die Benennung: Standardmäßig wird der Parametername dem übergebenen Schlüssel vorangestellt, sodass `collector.Add("session.token", ...)` an einem Parameter namens `session` das Tag `session.session.token` erzeugt. Übergeben Sie schlichte Schlüssel und lassen Sie den Parameternamen das Präfix liefern, oder übergeben Sie schlichte Schlüssel und setzen `OmitReferenceName = true`, um das Präfix ganz zu entfernen. Schreiben Sie das Präfix nicht selbst aus.

## Der Nachweis per Test

`FakeLogger` aus `Microsoft.Extensions.Diagnostics.Testing` 10.9.0 läuft hinter demselben `ExtendedLogger`, sodass die Redaktion greift und die redigierten Tags über `FakeLogCollector` lesbar sind. Damit wird die Leck-Assertion unkompliziert:

```csharp
var services = new ServiceCollection();
services.AddLogging(b => { b.AddFakeLogging(); b.EnableRedaction(); });
services.AddRedaction(r => r.SetRedactor<StarRedactor>(Taxonomy.Sensitive));

using var sp = services.BuildServiceProvider();
sp.GetRequiredService<ILoggerFactory>().CreateLogger("T")
  .Taken(new Payment { CardNumber = "4111111111111111", Amount = 1999 });

var records = sp.GetRequiredService<FakeLogCollector>().GetSnapshot();
Assert.DoesNotContain("4111111111111111",
    string.Join('\n', records.SelectMany(r => r.StructuredState ?? [])
                             .Select(kv => $"{kv.Key}={kv.Value}")));
```

Der strukturierte Zustand dieses Eintrags lautet exakt `payment.CardNumber = ****`, `payment.Amount = 1999`, `{OriginalFormat} = Payment taken`. Prüfen Sie auf die Abwesenheit des Geheimnisses statt auf die Anwesenheit von `****`, damit der Test eine Regression auch dann erkennt, wenn jemand den Redactor austauscht.

Zwei Dinge haben mich überrascht. Redaktion greift nur bei per Source Generator erzeugten Log-Methoden, jedes verbliebene `logger.LogInformation($"card {card}")` im Code ist also völlig ungeschützt. Falls Sie diesen Durchlauf noch nicht gemacht haben, ist die [Umstellung interpolierter ILogger-Aufrufe auf Message Templates](/de/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) die Voraussetzung für dieses gesamte Feature. Zweitens ändert `EnableRedaction`, was `JsonConsole` in das verschachtelte Feld `State.Message` schreibt: Es wird zur wörtlichen Zeichenkette `Microsoft.Extensions.Logging.ExtendedLogger+ModernTagJoiner`. Das `Message` auf oberster Ebene bleibt korrekt und jedes einzelne Tag bleibt vorhanden, aber ein nachgelagerter Parser, der `State.Message` liest, geht kaputt. Strukturierte Senken, die den Zustand enumerieren, etwa die im [Leitfaden zur Einrichtung von Serilog und Seq](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) oder in einer [OpenTelemetry-Logging-Pipeline](/de/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/) beschriebenen, sind nicht betroffen.

Das stärkste Argument für dieses Feature: Die Klassifizierung steht am Modell, direkt neben der Eigenschaft, wo sie jeder sieht, der ein Feld hinzufügt. Die Redaktionsrichtlinie steht in einem einzigen Aufruf in der Composition Root, den eine Sicherheitsprüfung in zehn Sekunden liest. Diese Trennung ist den Einrichtungsaufwand wert, sofern Sie sie auch tatsächlich absichern: Fügen Sie einen Test hinzu, der ein vollständig befülltes Modell in eine In-Memory-Senke protokolliert und fehlschlägt, sobald eine bekannte Geheimnis-Zeichenkette in der Ausgabe auftaucht.

## Quellen

- [Logging-Quellcodegenerierung zur Compile-Zeit](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/source-generation), MS Learn
- [Datenklassifizierung in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-classification), MS Learn
- [Datenredaktion in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/data-redaction), MS Learn
- [ExtendedLogger.ModernPath](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/ExtendedLogger.cs) und [JustInTimeRedactor](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/JustInTimeRedactor.cs), dotnet/extensions
- [LoggerRedactionOptions.ApplyDiscriminator](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry/Logging/LoggerRedactionOptions.cs), dotnet/extensions
- [dotnet/extensions Issue 5163](https://github.com/dotnet/extensions/issues/5163), zur LogProperties-Ausgabe bei deaktivierter Redaktion

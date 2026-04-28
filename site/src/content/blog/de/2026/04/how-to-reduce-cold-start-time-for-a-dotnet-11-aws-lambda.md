---
title: "Wie man die Kaltstartzeit eines .NET 11 AWS Lambda reduziert"
description: "Ein praxisorientiertes, versionsspezifisches Playbook, um Kaltstarts von .NET-11-Lambda zu kürzen. Behandelt Native AOT auf provided.al2023, ReadyToRun, SnapStart auf der gemanagten dotnet10-Runtime, Speicherabstimmung, statische Wiederverwendung, Trim-Sicherheit und wie man INIT_DURATION wirklich liest."
pubDate: 2026-04-27
template: how-to
tags:
  - "aws"
  - "aws-lambda"
  - "dotnet-11"
  - "native-aot"
  - "performance"
lang: "de"
translationOf: "2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda"
translatedBy: "claude"
translationDate: 2026-04-29
---

Ein typisches .NET-Lambda kommt von einem Standard-`dotnet new lambda.EmptyFunction` mit 1500-2500 ms Kaltstart auf unter 300 ms, indem man vier Hebel stapelt: die richtige Runtime wählen (Native AOT auf `provided.al2023` oder SnapStart auf der gemanagten Runtime), der Funktion genug Speicher geben, damit Init auf einer vollen vCPU läuft, alles Wiederverwendbare in die statische Initialisierung hochziehen und aufhören, Code zu laden, den man nicht braucht. Diese Anleitung geht jeden Hebel für ein .NET-11-Lambda durch (`Amazon.Lambda.RuntimeSupport` 1.13.x, `Amazon.Lambda.AspNetCoreServer.Hosting` 1.7.x, .NET 11 SDK, C# 14), erklärt die Reihenfolge, in der man sie anwendet, und zeigt, wie man jeden Schritt anhand der `INIT_DURATION`-Zeile in CloudWatch verifiziert.

## Warum ein Standard-.NET-Lambda so langsam kaltstartet

Ein Kaltstart auf der gemanagten Runtime in Lambda führt vier Dinge nacheinander aus, und eine Standard-.NET-Funktion zahlt für alle. Erstens bootet die **Firecracker-microVM** und Lambda holt Ihr Deployment-Paket. Zweitens **initialisiert sich die Runtime**: bei einer gemanagten Runtime heißt das, CoreCLR lädt, der Host-JIT wärmt sich, und die Assemblies Ihrer Funktion werden in den Speicher abgebildet. Drittens wird Ihre **Handler-Klasse konstruiert**, einschließlich aller Constructor-Injection, Konfigurations-Ladens und der Konstruktion von AWS-SDK-Clients. Erst danach ruft Lambda Ihren `FunctionHandler` für die erste Invocation auf.

Die .NET-spezifischen Kosten zeigen sich in den Schritten zwei und drei. CoreCLR JIT-kompiliert jede Methode beim ersten Aufruf. ASP.NET Core (wenn Sie die API-Gateway-Hosting-Brücke verwenden) baut einen vollständigen Host mit Logging, Konfiguration und einer Option-Binding-Pipeline. Die Standard-AWS-SDK-Clients lösen Anmeldedaten träge auf, indem sie die Credential-Provider-Kette ablaufen, was auf Lambda zwar schnell ist, aber dennoch alloziert. Reflection-lastige Serializer wie die Standardpfade von `System.Text.Json` inspizieren jede Eigenschaft jedes Typs, den sie zum ersten Mal sehen.

Sie können an vier Hebeln ziehen, in dieser Reihenfolge, mit abnehmenden Erträgen:

1. **Native AOT** liefert ein vorkompiliertes Binary aus, sodass JIT-Kosten auf null gehen und die Runtime ein winziges, in sich geschlossenes Executable startet.
2. **SnapStart** schnappt eine bereits aufgewärmte Init-Phase und stellt sie beim Kaltstart von der Festplatte wieder her.
3. **Speichergröße** kauft Ihnen proportional CPU, was alles im Init beschleunigt.
4. **Statische Wiederverwendung und Trimming** verkleinern, was während Init läuft und was bei jedem Kaltstart neu erledigt wird.

## Hebel 1: Native AOT auf provided.al2023 (der größte Einzelgewinn)

Native AOT kompiliert Ihre Funktion und die .NET-Runtime in ein einziges statisches Binary, eliminiert den JIT und kürzt den Kaltstart ungefähr auf die Zeit, die Lambda braucht, um einen Prozess zu starten. AWS veröffentlicht dafür [erstklassige Anleitungen](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) auf der Custom-Runtime `provided.al2023`. Mit .NET 11 entspricht das Toolchain dem, was mit .NET 8 ausgeliefert wurde, der Trim-Analyzer ist aber strenger und `ILLink`-Warnungen, die in .NET 8 grün waren, können aufleuchten.

Die minimale, AOT-fertige Funktion sieht so aus:

```csharp
// .NET 11, C# 14
// PackageReference: Amazon.Lambda.RuntimeSupport 1.13.0
// PackageReference: Amazon.Lambda.Serialization.SystemTextJson 2.4.4
using System.Text.Json.Serialization;
using Amazon.Lambda.Core;
using Amazon.Lambda.RuntimeSupport;
using Amazon.Lambda.Serialization.SystemTextJson;

var serializer = new SourceGeneratorLambdaJsonSerializer<LambdaFunctionJsonContext>();

var handler = static (Request req, ILambdaContext ctx) =>
    new Response($"hello {req.Name}", DateTimeOffset.UtcNow);

await LambdaBootstrapBuilder.Create(handler, serializer)
    .Build()
    .RunAsync();

public record Request(string Name);
public record Response(string Message, DateTimeOffset At);

[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Response))]
public partial class LambdaFunctionJsonContext : JsonSerializerContext;
```

Die wichtigen `csproj`-Schalter:

```xml
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <PublishAot>true</PublishAot>
  <StripSymbols>true</StripSymbols>
  <InvariantGlobalization>true</InvariantGlobalization>
  <RootNamespace>MyFunction</RootNamespace>
  <AssemblyName>bootstrap</AssemblyName>
  <TieredCompilation>false</TieredCompilation>
</PropertyGroup>
```

`AssemblyName` mit Wert `bootstrap` ist von der Custom-Runtime gefordert. `InvariantGlobalization=true` entfernt ICU, spart Paketgröße und vermeidet die berüchtigte ICU-Initialisierung beim Kaltstart. Wenn Sie echte Kulturdaten brauchen, tauschen Sie es gegen `<PredefinedCulturesOnly>false</PredefinedCulturesOnly>` und nehmen den Größenzuwachs in Kauf.

Bauen Sie auf Amazon Linux (oder in einem Linux-Container), damit der Linker zum Lambda-Environment passt:

```bash
# .NET 11 SDK
dotnet lambda package --configuration Release \
  --framework net11.0 \
  --msbuild-parameters "--self-contained true -r linux-x64 -p:PublishAot=true"
```

Das globale Tool `Amazon.Lambda.Tools` packt das `bootstrap`-Binary in ein ZIP, das Sie als Custom-Runtime hochladen. Mit einer 256-MB-Funktion und dem obigen Boilerplate liegen Kaltstarts im Bereich **150 ms bis 300 ms**, gegenüber 1500-2000 ms auf der gemanagten Runtime.

Der Trade-off: Jede reflection-lastige Bibliothek, die Sie hineinziehen, wird zu einer Trim-Warnung. Source-Generatoren von `System.Text.Json` übernehmen Serialisierung, aber wenn Sie irgendetwas verwenden, das zur Laufzeit über generische Typen reflektiert (älteres AutoMapper, Newtonsoft, reflection-basierte MediatR-Handler), bekommen Sie ILLink-Warnungen oder eine Laufzeitausnahme. Behandeln Sie jede Warnung als echten Bug. Eine trim-freundliche Mediator-Alternative wird in [SwitchMediator v3, ein Zero-Alloc-Mediator, der AOT-freundlich bleibt](/2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot/) behandelt.

## Hebel 2: SnapStart auf der gemanagten dotnet10-Runtime

Wenn Ihr Code nicht AOT-freundlich ist (viel Reflection, dynamische Plugins, EF Core 11 mit Modellaufbau zur Laufzeit), ist Native AOT nicht praktikabel. Die nächstbeste Option ist **Lambda SnapStart**, das heute auf der **gemanagten `dotnet10`-Runtime** unterstützt wird. Stand April 2026 ist die gemanagte `dotnet11`-Runtime noch nicht GA, also ist das praktische "gemanagte" Ziel für .NET-11-Code, `net10.0` mitzutargettieren und auf der SnapStart-fähigen `dotnet10`-Runtime zu laufen, oder die oben beschriebene Custom-Runtime zu verwenden. AWS hat die .NET-10-Runtime Ende 2025 angekündigt ([AWS-Blog: .NET-10-Runtime jetzt in AWS Lambda verfügbar](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/)) und SnapStart-Support für gemanagte .NET-Runtimes ist in [Startperformance mit Lambda SnapStart verbessern](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) dokumentiert.

SnapStart friert die Funktion nach Init ein, nimmt einen Snapshot der Firecracker-microVM und stellt beim Kaltstart den Snapshot wieder her, statt Init erneut auszuführen. Für .NET, wo Init der teure Teil ist, reduziert das Kaltstarts typischerweise um 60-90%.

Zwei Dinge sind für die Korrektheit von SnapStart wichtig:

1. **Determinismus nach dem Restore.** Alles, was während Init eingefangen wird (Random-Seeds, maschinenspezifische Tokens, Netzwerk-Sockets, zeitabhängige Caches), wird zwischen jeder restaurierten Instanz geteilt. Verwenden Sie die Runtime-Hooks, die AWS bereitstellt:

```csharp
// .NET 10 target multi-targeted with .NET 11
using Amazon.Lambda.RuntimeSupport;

Core.SnapshotRestore.RegisterBeforeSnapshot(() =>
{
    // flush anything that should not be captured
    return ValueTask.CompletedTask;
});

Core.SnapshotRestore.RegisterAfterRestore(() =>
{
    // re-seed RNG, refresh credentials, reopen sockets
    return ValueTask.CompletedTask;
});
```

2. **Pre-JIT, was warm sein soll.** SnapStart erfasst den JITeten Zustand. Tiered Compilation hat heiße Methoden während Init noch nicht auf Tier-1 befördert, sodass Sie einen Snapshot von vorwiegend Tier-0-Code bekommen, sofern Sie nicht nachhelfen. Gehen Sie den Hot Path während Init einmal durch (rufen Sie Ihren Handler mit einem synthetischen Aufwärm-Payload auf oder rufen Sie wichtige Methoden explizit auf), damit der Snapshot ihre JITeten Formen enthält. Mit `<TieredPGO>true</TieredPGO>` (dem .NET-11-Default) zählt das etwas weniger, hilft aber messbar weiter.

SnapStart ist heute kostenlos für gemanagte .NET-Runtimes, mit der Einschränkung, dass die Snapshot-Erstellung Deploys leicht verzögert.

## Hebel 3: Speichergröße kauft CPU

Lambda allokiert CPU proportional zum Speicher. Bei 128 MB bekommen Sie einen Bruchteil einer vCPU. Bei 1769 MB bekommen Sie eine volle vCPU, und darüber mehr als eine. **Init läuft auf derselben proportionalen CPU**, also zahlt eine bei 256 MB konfigurierte Funktion eine deutlich langsamere JIT- und DI-Rechnung als derselbe Code bei 1769 MB.

Konkrete Zahlen für ein kleines ASP.NET-Core-Minimal-API-Lambda:

| Speicher | INIT_DURATION (gemanagt dotnet10) | INIT_DURATION (Native AOT) |
| -------- | --------------------------------- | -------------------------- |
| 256 MB   | ~1800 ms                          | ~280 ms                    |
| 512 MB   | ~1100 ms                          | ~200 ms                    |
| 1024 MB  | ~700 ms                           | ~180 ms                    |
| 1769 MB  | ~480 ms                           | ~160 ms                    |

Die Lehre lautet nicht "immer 1769 MB". Sondern dass Sie aus einer Messung bei 256 MB nichts über den Kaltstart schließen können. Benchmarken Sie auf der Speichergröße, mit der Sie tatsächlich deployen wollen, und denken Sie daran, dass die **[AWS Lambda Power Tuning State Machine](https://github.com/alexcasalboni/aws-lambda-power-tuning)** in wenigen Minuten die kostenoptimale Speichergröße für Ihre Workload findet.

## Hebel 4: Statische Wiederverwendung und Trimming des Init-Graphen

Sobald Sie Runtime und Speicher gewählt haben, kommen die verbleibenden Gewinne daraus, während Init weniger Arbeit zu leisten und zwischen Invocations mehr wiederzuverwenden. Drei Muster decken den größten Teil ab.

### Clients und Serializer in statische Felder hochziehen

Lambda verwendet dieselbe Ausführungsumgebung zwischen Invocations wieder, bis sie abkühlt. Alles, was Sie in ein statisches Feld legen, überlebt. Der klassische Fehler ist, einen `HttpClient` oder AWS-SDK-Client innerhalb des Handlers zu allozieren:

```csharp
// .NET 11 - bad: per-invocation construction
public async Task<Response> Handler(Request req, ILambdaContext ctx)
{
    using var http = new HttpClient(); // pays DNS, TCP, TLS every time
    var s3 = new AmazonS3Client();      // re-resolves credentials chain
    // ...
}
```

Hochziehen:

```csharp
// .NET 11 - good: shared across warm invocations
public sealed class Function
{
    private static readonly HttpClient Http = new();
    private static readonly AmazonS3Client S3 = new();

    public async Task<Response> Handler(Request req, ILambdaContext ctx)
    {
        // reuses Http and S3 across warm invocations on the same instance
    }
}
```

Dieses Muster ist in [Wie man Code, der HttpClient verwendet, unit-testet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) dokumentiert, das die Testbarkeitsseite behandelt. Für Lambda lautet die Regel schlicht: Alles, was teuer zu konstruieren und sicher wiederverwendbar ist, geht statisch.

### Verwenden Sie immer System.Text.Json-Source-Generatoren

Standard-`System.Text.Json` reflektiert beim ersten Gebrauch über Ihre DTO-Typen, was die Init-Zeit aufbläht und mit Native AOT inkompatibel ist. Source-Generatoren erledigen die Arbeit zur Build-Zeit:

```csharp
// .NET 11
[JsonSerializable(typeof(APIGatewayProxyRequest))]
[JsonSerializable(typeof(APIGatewayProxyResponse))]
[JsonSerializable(typeof(MyDomainObject))]
public partial class LambdaJsonContext : JsonSerializerContext;
```

Geben Sie den generierten Context an `SourceGeneratorLambdaJsonSerializer<T>`. Das schneidet Hunderte Millisekunden vom Kaltstart der gemanagten Runtime ab und ist für AOT verpflichtend.

### Vollwertiges ASP.NET Core meiden, wenn nicht nötig

Der Adapter `Amazon.Lambda.AspNetCoreServer.Hosting` lässt Sie eine echte ASP.NET-Core-Minimal-API hinter API Gateway laufen. Das ist ein großer DX-Gewinn, aber er bootet den vollständigen ASP.NET-Core-Host: Konfigurationsanbieter, Logging-Anbieter, Optionsvalidierung, den Routing-Graph. Für ein 5-Endpunkt-Lambda sind das hunderte Millisekunden Init. Vergleichen Sie mit einem handgeschriebenen `LambdaBootstrapBuilder`-Handler, der in zehnern von Millisekunden bootet.

Wählen Sie bewusst:

-   **Viele Endpunkte, komplexe Pipeline, Middleware gewünscht**: ASP.NET-Core-Hosting ist in Ordnung, nehmen Sie die SnapStart-Route.
-   **Ein Handler, eine Route, Performance zählt**: Schreiben Sie einen rohen Handler gegen `Amazon.Lambda.RuntimeSupport`. Wenn Sie auch HTTP-Request-Formen wollen, nehmen Sie `APIGatewayHttpApiV2ProxyRequest` direkt entgegen.

### ReadyToRun, wenn AOT zu restriktiv ist

Wenn Sie wegen einer reflection-lastigen Abhängigkeit kein Native AOT ausliefern können, aber auch kein SnapStart nutzen können (vielleicht weil Sie eine gemanagte Runtime targettieren, die es noch nicht unterstützt), aktivieren Sie **ReadyToRun**. R2R kompiliert IL in nativen Code vor, den der JIT beim Erstaufruf ohne Rekompilierung verwenden kann. Es kürzt die JIT-Kosten beim Kaltstart um etwa 50-70% zu Lasten eines größeren Pakets:

```xml
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
  <PublishReadyToRunComposite>true</PublishReadyToRunComposite>
</PropertyGroup>
```

R2R bringt auf der gemanagten Runtime üblicherweise 100-300 ms Kaltstart-Gewinn. Es stapelt sich mit allem anderen und ist im Wesentlichen kostenlos, also ist es das Erste, was man probiert, wenn man nicht zu AOT oder SnapStart wechseln kann.

## INIT_DURATION richtig lesen

Die CloudWatch-`REPORT`-Zeile für eine kaltgestartete Invocation hat die Form:

```
REPORT RequestId: ... Duration: 12.34 ms Billed Duration: 13 ms
Memory Size: 512 MB Max Memory Used: 78 MB Init Duration: 412.56 ms
```

`Init Duration` sind die Kaltstartkosten: VM-Boot + Runtime-Init + Ihr statischer Konstruktor und die Konstruktion der Handler-Klasse. Ein paar Regeln zum Lesen:

-   `Init Duration` wird auf der gemanagten Runtime **nicht abgerechnet**. Auf AOT-Custom-Runtimes über das `provided.al2023`-Modell schon.
-   Die erste Invocation pro nebenläufiger Instanz zeigt sie. Warme Invocations lassen sie weg.
-   SnapStart-Funktionen melden statt `Init Duration` ein `Restore Duration`. Das ist Ihre Kaltstart-Metrik bei SnapStart.
-   `Max Memory Used` ist die Spitze. Liegt sie dauerhaft unter ~30% von `Memory Size`, sind Sie wahrscheinlich überprovisioniert und könnten eine kleinere Größe versuchen, aber erst nach Messung bei der kleineren Größe, da CPU mit Speicher fällt.

Das Werkzeug, das das lesbar macht: eine CloudWatch-Log-Insights-Abfrage wie

```
fields @timestamp, @initDuration, @duration
| filter @type = "REPORT"
| sort @timestamp desc
| limit 200
```

Für tiefere Traces deckt [Wie man eine .NET-App mit dotnet-trace profiliert und die Ausgabe liest](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) ab, wie man einen Init-Flame-Graph aus einer lokalen Lambda-Emulator-Sitzung aufnimmt und liest.

## Provisioned Concurrency ist die Notbremse, nicht die Antwort

Provisioned Concurrency hält `N` Instanzen dauerhaft warm. Kaltstarts auf diesen Instanzen sind null, weil sie nicht kalt sind. Es ist die richtige Antwort, wenn Sie ein hartes Latenz-SLO haben, das die obigen Hebel nicht erreichen, oder wenn die Restore-Semantik von SnapStart mit Ihrem Code kollidiert. Es ist die falsche Antwort als Ersatz dafür, Init wirklich zu optimieren: Sie zahlen für warme Kapazität rund um die Uhr, um ein behebbares Problem zu kaschieren, und die Rechnung skaliert mit der Anzahl warmer Instanzen. Verwenden Sie Application Auto Scaling, um Provisioned Concurrency nach Plan zu skalieren, wenn Ihr Traffic vorhersagbar ist.

## Die Reihenfolge, in der ich das in Produktion anwende

Über etwa ein Dutzend .NET-Lambdas hinweg, die ich getunt habe:

1. **Immer**: quellgenerierte JSON, statische Felder für Clients, R2R an, `InvariantGlobalization=true`, sofern locale-unabhängig.
2. **Wenn reflection-frei**: Native AOT auf `provided.al2023`. Das schlägt für sich genommen meist jeden anderen Hebel zusammen.
3. **Wenn Reflection unvermeidbar ist**: gemanagte `dotnet10`-Runtime mit SnapStart, plus ein synthetischer Aufwärm-Aufruf während Init, um den Hot Path vorzu-JITen.
4. **Verifizieren** mit INIT_DURATION bei der tatsächlichen Deploy-Speichergröße. Power Tuning verwenden, wenn die Kosten-vs-Latenz-Kurve zählt.
5. **Provisioned Concurrency** nur danach, und nur mit Auto-Scaling.

Den Rest der .NET-11-Lambda-Geschichte (Runtime-Versionen, Deploy-Form, was sich ändert, wenn Sie von `dotnet10` auf eine zukünftige gemanagte `dotnet11`-Runtime umstellen) deckt [AWS Lambda unterstützt .NET 10: was vor dem Runtime-Wechsel zu prüfen ist](/2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime/) ab, das das Begleitstück zu diesem Beitrag ist.

## Quellen

-   [.NET-Lambda-Funktionscode in ein natives Runtime-Format kompilieren](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) - AWS-Doku.
-   [Startperformance mit Lambda SnapStart verbessern](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) - AWS-Doku.
-   [.NET-10-Runtime jetzt in AWS Lambda verfügbar](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/) - AWS-Blog.
-   [Übersicht der Lambda-Runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) - inklusive `provided.al2023`.
-   [aws/aws-lambda-dotnet](https://github.com/aws/aws-lambda-dotnet) - die Quelle für `Amazon.Lambda.RuntimeSupport`.
-   [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) - der Kosten-vs-Latenz-Tuner.

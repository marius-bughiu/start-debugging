---
title: "IAsyncDisposable mit await using in C# implementieren und konsumieren"
description: "Ein vollständiger Leitfaden zu IAsyncDisposable in C#: wann await using zu verwenden ist, wie DisposeAsync und DisposeAsyncCore korrekt geschrieben werden und welche Stacking- und ConfigureAwait-Details Ressourcen lecken lassen."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "idisposable"
lang: "de"
translationOf: "2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Wenn ein Typ eine Ressource hält, die nur asynchron freigegeben werden kann (ein Netzwerk-Stream, der geleert werden muss, eine Datenbank-Transaktion, die bestätigt oder zurückgerollt werden muss, ein Channel-Writer, der geleert werden muss), ist `IDisposable` der falsche Vertrag. Seine Methode `Dispose()` ist synchron, sodass die einzige Möglichkeit, daraus asynchrone Aufräumarbeiten auszuführen, das Blockieren auf einer `Task` ist, was Deadlocks und eine Erschöpfung des Thread-Pools riskiert. C# 8.0 (ausgeliefert mit .NET Core 3.0) hat genau für diesen Fall `IAsyncDisposable` und die `await using`-Anweisung hinzugefügt. Dieser Artikel behandelt beide Seiten: wie man einen async-disposable Typ mit `await using` konsumiert und wie man `DisposeAsync` korrekt implementiert, einschließlich des `DisposeAsyncCore`-Musters und der beiden Details (Stacking und `ConfigureAwait`), die Ressourcen unbemerkt lecken lassen. Alle Beispiele zielen auf .NET 11 und C# 14 ab, aber die API und die Semantik haben sich seit C# 8.0 nicht geändert.

## Warum ein synchrones Dispose nicht ausreicht

`IDisposable.Dispose()` gibt `void` zurück. Wenn Ihre Aufräumarbeit `await` benötigt (einen Puffer in einen Socket leeren, einen finalen Frame senden, eine Transaktion bestätigen), haben Sie drei schlechte Optionen innerhalb eines synchronen `Dispose`: mit `.GetAwaiter().GetResult()` blockieren, mit `.Wait()` blockieren oder Fire-and-Forget und hoffen, dass es fertig wird. Die ersten beiden können in Kontexten mit einem Single-Thread-Synchronisationskontext Deadlocks verursachen und binden für die Dauer der E/A einen Thread des Thread-Pools; die dritte verliert Fehler und kann das zugrunde liegende Handle freigeben, bevor die asynchrone Arbeit abgeschlossen ist.

`IAsyncDisposable` behebt dies, indem es die Aufräumarbeit selbst awaitbar macht:

```csharp
// System namespace, available since .NET Core 3.0 / C# 8.0
public interface IAsyncDisposable
{
    ValueTask DisposeAsync();
}
```

Beachten Sie, dass der Rückgabetyp `ValueTask` ist, nicht `Task`. Die Freigabe wird häufig synchron abgeschlossen (nichts zu leeren), und `ValueTask` vermeidet auf diesem gängigen Pfad die Allokation eines `Task`-Objekts. Sie führen fast nie selbst ein `await` auf einem reinen `DisposeAsync()`-Aufruf aus; der Compiler erledigt das über `await using` für Sie.

## Einen async-disposable Typ mit await using konsumieren

Die Konsumentenseite ist der Teil, den Sie am häufigsten schreiben, weil das Framework `IAsyncDisposable` bereits auf den Typen implementiert, die für Sie relevant sind: `Stream`, `FileStream`, `DbConnection`, `DbTransaction`, `Utf8JsonWriter`, die Wrapper von `ChannelWriter<T>`, `ServiceProvider` und mehr.

Es gibt zwei Formen. Die `await using`-Anweisung begrenzt die Aufräumarbeit auf einen expliziten Block:

```csharp
// .NET 11, C# 14
await using (var stream = new FileStream("data.bin", FileMode.Open))
{
    await stream.ReadAsync(buffer);
} // DisposeAsync() is awaited here, at the closing brace
```

Die `await using`-Deklaration begrenzt die Aufräumarbeit auf das Ende des umschließenden Blocks, ohne zusätzliche Verschachtelung:

```csharp
// .NET 11, C# 14
static async Task ProcessAsync()
{
    await using var stream = new FileStream("data.bin", FileMode.Open);

    await stream.ReadAsync(buffer);

    // DisposeAsync() is awaited when ProcessAsync's body exits,
    // whether by return or by an exception.
}
```

Beide erfordern, dass die umschließende Methode `async` ist, weil `await using` am Freigabepunkt ein `await` einfügt. Wenn Sie `await using` in einer nicht-async Methode schreiben, erhalten Sie einen Kompilierungsfehler, und wenn Sie versehentlich das `await` weglassen und ein einfaches `using` auf einem `IAsyncDisposable` schreiben, ruft der Compiler das synchrone `Dispose()` auf, sofern der Typ auch `IDisposable` implementiert, oder er kann nicht kompilieren, wenn er nur `IAsyncDisposable` implementiert. Dieses stille Zurückfallen auf die synchrone Freigabe ist eine echte Fehlerquelle: Greifen Sie immer zu `await using`, wenn der Typ async-disposable ist.

Ein gängiges Idiom, das Sie bei EF Core- und ADO.NET-Stacks sehen, stapelt zwei `await` auf einer Zeile, eines für den Fabrikaufruf und eines versteckt in der Freigabe:

```csharp
// .NET 11, C# 14 -- EF Core 11
await using var transaction = await context.Database.BeginTransactionAsync(token);

await context.SaveChangesAsync(token);
await transaction.CommitAsync(token);
// If CommitAsync is not reached (exception), DisposeAsync rolls back.
```

Das erste `await` packt die `Task<IDbContextTransaction>` aus `BeginTransactionAsync` aus; das `await using` sorgt dafür, dass `DisposeAsync` erwartet wird, wenn der Block verlassen wird. Wenn eine Ausnahme `CommitAsync` überspringt, rollt das `DisposeAsync` der Transaktion für Sie zurück.

## IAsyncDisposable implementieren, wenn die Klasse sealed ist

Wenn Ihr Typ `sealed` ist (oder Sie sicher sind, dass er nie abgeleitet wird), ist die Implementierung kurz. Geben Sie einfach Ihre Ressourcen in `DisposeAsync` frei:

```csharp
// .NET 11, C# 14
public sealed class MetricsFlusher : IAsyncDisposable
{
    private readonly Channel<Metric> _channel = Channel.CreateUnbounded<Metric>();
    private readonly HttpClient _http;

    public MetricsFlusher(HttpClient http) => _http = http;

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.Complete();

        // Drain and ship whatever is buffered before we go away.
        await foreach (var metric in _channel.Reader.ReadAllAsync())
        {
            await _http.PostAsJsonAsync("/metrics", metric);
        }
    }
}
```

Da die Klasse `sealed` ist, gibt es keinen abgeleiteten Typ, an den die Aufräumarbeit weitergereicht werden könnte, sodass Sie die im Folgenden beschriebene `DisposeAsyncCore`-Aufteilung nicht benötigen, und Sie brauchen `GC.SuppressFinalize` nicht, es sei denn, die Klasse deklariert zusätzlich einen Finalizer (eine sealed Klasse, die nur verwaltete asynchrone Ressourcen besitzt, tut dies selten).

## Das vollständige asynchrone Freigabemuster für eine Basisklasse implementieren

In dem Moment, in dem Ihre Klasse *nicht* sealed ist, ändert sich die Empfehlung von Microsoft. Jede nicht-sealed Klasse ist eine potenzielle Basisklasse, und eine abgeleitete Klasse benötigt einen Einstiegspunkt, um ihre eigene asynchrone Aufräumarbeit hinzuzufügen und sie mit der Aufräumarbeit der Basisklasse zu komponieren. Dieser Einstiegspunkt ist eine `protected virtual ValueTask DisposeAsyncCore()`-Methode. `DisposeAsync` wird zu Boilerplate, der `DisposeAsyncCore` aufruft, die Finalisierung unterdrückt und zurückkehrt:

```csharp
// .NET 11, C# 14
public class ExampleAsyncDisposable : IAsyncDisposable
{
    private IAsyncDisposable? _inner = new SomeAsyncResource();

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_inner is not null)
        {
            await _inner.DisposeAsync().ConfigureAwait(false);
        }
        _inner = null;
    }
}
```

Eine abgeleitete Klasse überschreibt `DisposeAsyncCore`, räumt ihre eigenen Ressourcen auf und kettet zu `base.DisposeAsyncCore()`. Sie berührt `DisposeAsync` nie, sodass der Aufruf `GC.SuppressFinalize(this)` genau einmal ausgeführt wird, auf der am weitesten abgeleiteten Ebene. Dies spiegelt das synchrone Muster `Dispose()` / `protected virtual void Dispose(bool)` wider, nur mit `ValueTask`-Rückgabetypen und ohne den Parameter `bool disposing` (im rein asynchronen Fall gibt es keinen Finalizer-Pfad zu unterscheiden).

## Sowohl IDisposable als auch IAsyncDisposable unterstützen

Es ist üblich, beide Schnittstellen zu implementieren, sodass sowohl Aufrufer mit synchronem `using` als auch Aufrufer mit `await using` eine korrekte Aufräumarbeit erhalten. Das entscheidende Detail: Wenn Sie nur `IAsyncDisposable` implementieren und ein Aufrufer Ihr Objekt in ein einfaches `using` wickelt (oder es an einen Container übergibt, der nur `IDisposable` kennt), wird Ihr `DisposeAsync` nie ausgeführt und Sie lecken die Ressource. Microsoft weist ausdrücklich als Warnung darauf hin.

Das duale Muster leitet beide Einstiegspunkte durch gemeinsame Logik und verwendet `Dispose(false)` aus dem asynchronen Pfad, damit verwaltete Ressourcen nicht zweimal freigegeben werden:

```csharp
// .NET 11, C# 14
public class DualDisposable : IDisposable, IAsyncDisposable
{
    private Stream? _managed = new MemoryStream();
    private IAsyncDisposable? _asyncOnly = new SomeAsyncResource();

    public void Dispose()
    {
        Dispose(disposing: true);
        GC.SuppressFinalize(this);
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        Dispose(disposing: false); // false: async path already handled managed async resources
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (disposing)
        {
            _managed?.Dispose();
            _managed = null;

            if (_asyncOnly is IDisposable d)
            {
                d.Dispose();
                _asyncOnly = null;
            }
        }
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_asyncOnly is not null)
        {
            await _asyncOnly.DisposeAsync().ConfigureAwait(false);
        }

        if (_managed is IAsyncDisposable ad)
        {
            await ad.DisposeAsync().ConfigureAwait(false);
        }
        else
        {
            _managed?.Dispose();
        }

        _asyncOnly = null;
        _managed = null;
    }
}
```

Der `DisposeAsync`-Pfad übergibt `false` an `Dispose(bool)`, weil `DisposeAsyncCore` die verwalteten Ressourcen bereits asynchron freigegeben hat; die Übergabe von `true` würde versuchen, sie ein zweites Mal freizugeben. Dies hält beide Pfade funktional äquivalent, ohne eine doppelte Freigabe.

## Das Stacking-Detail, das DisposeAsync überspringt

Dieses trifft Leute, die versuchen, ordentlich zu sein. Sie können `await using`-Anweisungen nicht so "stapeln", wie Sie synchrone `using`-Anweisungen stapeln können, denn wenn ein Konstruktor nach dem ersten eine Ausnahme wirft, werden die zuvor erstellten Objekte nie freigegeben:

```csharp
// .NET 11, C# 14 -- DO NOT DO THIS
var one = new ExampleAsyncDisposable();
var two = new AnotherAsyncDisposable(); // if this constructor throws...

await using (one.ConfigureAwait(false))
await using (two.ConfigureAwait(false))
{
    // ...neither one nor two has DisposeAsync called.
}
```

Das Problem ist, dass die Objekte *vor* dem Eintritt in die `await using`-Blöcke konstruiert werden, sodass eine Ausnahme zwischen der Konstruktion und dem Block sie unfreigegeben zurücklässt. Die Lösung besteht darin, Konstruktion und Gültigkeitsbereich im selben Schritt zu erledigen. Jede dieser drei Formen ist sicher:

```csharp
// .NET 11, C# 14 -- nested blocks
var one = new ExampleAsyncDisposable();
await using (one.ConfigureAwait(false))
{
    var two = new AnotherAsyncDisposable();
    await using (two.ConfigureAwait(false))
    {
        // two is disposed first, then one
    }
}

// .NET 11, C# 14 -- sequential declarations (cleanest)
await using var a = new ExampleAsyncDisposable();
await using var b = new AnotherAsyncDisposable();
// b is disposed before a at the end of the method
```

Bevorzugen Sie die Deklarationsform. Wenn ein Konstruktor eine Ausnahme wirft, läuft die vom Compiler generierte Aufräumarbeit für die bereits deklarierten Variablen trotzdem, und Sie vermeiden diese ganze Klasse von Stacking-Fehlern.

## ConfigureAwait auf await using

In Bibliothekscode möchten Sie oft `ConfigureAwait(false)`, damit die Fortsetzung der Freigabe nicht den ursprünglichen Synchronisationskontext erfasst. Sie können es nicht einfach an das Objekt anhängen; es gibt eine dedizierte Erweiterung, `ConfigureAwait(IAsyncDisposable, bool)`, die ein `ConfiguredAsyncDisposable` zurückgibt:

```csharp
// .NET 11, C# 14
await using (stream.ConfigureAwait(false))
{
    await stream.ReadAsync(buffer);
}
```

In Anwendungscode ohne einen zu erfassenden Synchronisationskontext (ASP.NET Core, Konsolenanwendungen, Worker-Dienste) können Sie es weglassen; dort hat es keine Wirkung. In einer Bibliothek, die möglicherweise aus einer Benutzeroberfläche oder einem Legacy-ASP.NET-Kontext aufgerufen wird, fügen Sie es hinzu, mit derselben Begründung, die Sie für `ConfigureAwait(false)` bei gewöhnlichen await verwenden.

## Wo Sie überhaupt nicht freigeben müssen

Die Dependency Injection erledigt dies für Sie. Wenn Sie einen Dienst in einer `IServiceCollection` registrieren, verfolgt der Container, ob die aufgelöste Instanz `IDisposable` oder `IAsyncDisposable` implementiert, und gibt sie am Ende ihrer Lebensdauer frei. Ein scoped Dienst, der `IAsyncDisposable` implementiert, erhält sein `DisposeAsync` erwartet, wenn der Anfrage-Scope endet, vorausgesetzt, der Scope selbst wurde asynchron erstellt und freigegeben (ASP.NET Core tut dies). Sie schreiben kein `await using` auf injizierte Dienste; Sie überlassen dem Container den Besitz ihrer Lebensdauer. Einen injizierten Dienst manuell freizugeben ist ein Fehler, der ihn unter anderen Konsumenten wegfreigeben kann.

## Wann Sie zu IAsyncDisposable greifen sollten

Verwenden Sie es, wenn die Freigabe wirklich E/A durchführen muss: einen gepufferten Writer in einen Socket oder eine Datei leeren, eine Transaktion bestätigen oder zurückrollen, einen [Channel](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) abschließen und leeren oder eine langlebige Verbindung ordnungsgemäß schließen. Fügen Sie es nicht einem Typ hinzu, dessen Aufräumarbeit rein synchron ist (ein Handle freigeben, ein Feld leeren); ein einfaches `IDisposable` ist einfacher und zwingt nicht jeden Aufrufer in eine async Methode. Und wenn Ihr Typ einen asynchronen Stream produziert, kombinieren Sie ihn mit [IAsyncEnumerable&lt;T&gt;](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), anstatt zu versuchen, das Streaming an die Freigabe anzuflanschen.

Die asynchrone Freigabe ist ein Teil der umfassenderen Geschichte der asynchronen Korrektheit. Wenn Ihr `DisposeAsync` echte Arbeit leistet, fädeln Sie einen abbruch-bewussten Timeout genauso hindurch, wie Sie [jede asynchrone Operation mit CancellationTokenSource.CancelAfter mit einem Timeout versehen würden](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/), und stellen Sie sicher, dass Sie [einen CancellationToken durch Ihre async Methoden propagieren](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), damit die Aufräumarbeit begrenzt werden kann. Wenn die Aufräumarbeit das Stoppen laufender Arbeit umfasst, gilt hier dieselbe Disziplin, die es Ihnen erlaubt, [eine langlaufende Task ohne Deadlock abzubrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

Wenn Sie die beiden Regeln richtig anwenden, wird die asynchrone Freigabe im besten Sinne langweilig: Verwenden Sie `await using` auf der Konsumentenseite, und teilen Sie auf der Implementierungsseite `DisposeAsync` von `DisposeAsyncCore` für nicht-sealed Typen ab, implementieren Sie auch `IDisposable`, falls ein synchroner Aufrufer Sie freigeben könnte, und stapeln Sie niemals `await using`-Blöcke.

## Quellen

- [Eine DisposeAsync-Methode implementieren (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync)
- [IAsyncDisposable-Schnittstelle (API-Referenz auf MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.iasyncdisposable)
- [using-Anweisung und -Deklaration (C#-Sprachreferenz)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/using)
- [ConfigureAwait-FAQ (.NET Blog)](https://devblogs.microsoft.com/dotnet/configureawait-faq/)

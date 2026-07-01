---
title: "C# で await using を使って IAsyncDisposable を実装・利用する方法"
description: "C# における IAsyncDisposable の完全ガイド。await using をいつ使うか、DisposeAsync と DisposeAsyncCore を正しく書く方法、そしてリソースをリークさせるスタッキングと ConfigureAwait の落とし穴を解説します。"
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "idisposable"
lang: "ja"
translationOf: "2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

ある型が、非同期でしか解放できないリソース (フラッシュが必要なネットワークストリーム、コミットまたはロールバックが必要なデータベーストランザクション、ドレインが必要なチャネルライターなど) を保持している場合、`IDisposable` は適切なコントラクトではありません。その `Dispose()` メソッドは同期的なので、そこから非同期のクリーンアップを実行する唯一の方法は `Task` 上でブロックすることであり、これはデッドロックとスレッドプールの枯渇のリスクを伴います。C# 8.0 (.NET Core 3.0 とともにリリース) は、まさにこのケースのために `IAsyncDisposable` と `await using` ステートメントを追加しました。この記事では両方の側面を扱います。`await using` で async-disposable な型を利用する方法と、`DisposeAsyncCore` パターンおよびリソースを静かにリークさせる 2 つの落とし穴 (スタッキングと `ConfigureAwait`) を含めて、`DisposeAsync` を正しく実装する方法です。すべての例は .NET 11 と C# 14 を対象としていますが、API とセマンティクスは C# 8.0 以来変わっていません。

## なぜ同期的な Dispose では不十分なのか

`IDisposable.Dispose()` は `void` を返します。クリーンアップに `await` が必要な場合 (バッファをソケットにフラッシュする、最終フレームを送信する、トランザクションをコミットするなど)、同期的な `Dispose` の内部では 3 つの悪い選択肢があります。`.GetAwaiter().GetResult()` でブロックする、`.Wait()` でブロックする、あるいはファイア・アンド・フォーゲットで完了を祈る、です。最初の 2 つはシングルスレッドの同期コンテキストを持つ状況でデッドロックを引き起こす可能性があり、I/O の間ずっとスレッドプールのスレッドを占有します。3 つ目はエラーを失い、非同期処理が完了する前に基盤となるハンドルを破棄してしまう可能性があります。

`IAsyncDisposable` は、クリーンアップそのものを待機可能にすることでこれを解決します。

```csharp
// System namespace, available since .NET Core 3.0 / C# 8.0
public interface IAsyncDisposable
{
    ValueTask DisposeAsync();
}
```

戻り値の型が `Task` ではなく `ValueTask` であることに注目してください。解放は同期的に完了することが多く (フラッシュするものが何もない)、`ValueTask` はその一般的なパスで `Task` オブジェクトの割り当てを回避します。生の `DisposeAsync()` 呼び出しを自分で `await` することはほとんどありません。コンパイラーが `await using` を通じて代わりにそれを行います。

## await using で async-disposable を利用する

利用側は最も頻繁に書く部分です。なぜなら、フレームワークが重要な型にすでに `IAsyncDisposable` を実装しているからです。`Stream`、`FileStream`、`DbConnection`、`DbTransaction`、`Utf8JsonWriter`、`ChannelWriter<T>` のラッパー、`ServiceProvider` などです。

2 つの形式があります。`await using` ステートメントは、クリーンアップを明示的なブロックにスコープします。

```csharp
// .NET 11, C# 14
await using (var stream = new FileStream("data.bin", FileMode.Open))
{
    await stream.ReadAsync(buffer);
} // DisposeAsync() is awaited here, at the closing brace
```

`await using` 宣言は、追加のネストなしで、クリーンアップを囲んでいるブロックの終わりにスコープします。

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

どちらも、囲んでいるメソッドが `async` である必要があります。なぜなら `await using` は解放地点に `await` を挿入するからです。async でないメソッドに `await using` を書くとコンパイルエラーになり、誤って `await` を省いて `IAsyncDisposable` に通常の `using` を書くと、その型が `IDisposable` も実装していればコンパイラーは同期的な `Dispose()` を呼び出し、`IAsyncDisposable` のみを実装している場合はコンパイルに失敗します。この同期解放への静かなフォールバックは実際のバグの原因になります。型が async-disposable の場合は常に `await using` を使ってください。

EF Core や ADO.NET のスタックでよく見かける慣用句は、2 つの `await` を 1 行にスタックします。1 つはファクトリー呼び出しのため、もう 1 つは解放に隠れています。

```csharp
// .NET 11, C# 14 -- EF Core 11
await using var transaction = await context.Database.BeginTransactionAsync(token);

await context.SaveChangesAsync(token);
await transaction.CommitAsync(token);
// If CommitAsync is not reached (exception), DisposeAsync rolls back.
```

最初の `await` は `BeginTransactionAsync` からの `Task<IDbContextTransaction>` をアンラップします。`await using` は、ブロックを抜けるときに `DisposeAsync` が待機されるように手配します。例外が `CommitAsync` をスキップすると、トランザクションの `DisposeAsync` が代わりにロールバックします。

## クラスが sealed の場合の IAsyncDisposable の実装

型が `sealed` の場合 (またはサブクラス化されないと確信している場合)、実装は短くなります。単にリソースを `DisposeAsync` で解放するだけです。

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

クラスが `sealed` なので、クリーンアップをカスケードする派生型がありません。したがって次に説明する `DisposeAsyncCore` の分割は不要で、クラスがファイナライザーも宣言していない限り `GC.SuppressFinalize` も不要です (マネージドな非同期リソースのみを所有する sealed クラスがファイナライザーを持つことはまれです)。

## 基底クラスのための完全な非同期解放パターンを実装する

クラスが sealed *ではない* 瞬間に、Microsoft のガイダンスは変わります。sealed でないクラスはすべて潜在的な基底クラスであり、派生クラスには独自の非同期クリーンアップを追加して基底クラスのクリーンアップと合成するためのフックが必要です。そのフックが `protected virtual ValueTask DisposeAsyncCore()` メソッドです。`DisposeAsync` は、`DisposeAsyncCore` を呼び出し、ファイナライズを抑制して戻る定型コードになります。

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

派生クラスは `DisposeAsyncCore` をオーバーライドし、自身のリソースをクリーンアップして `base.DisposeAsyncCore()` にチェーンします。派生クラスは `DisposeAsync` に触れないため、`GC.SuppressFinalize(this)` 呼び出しは最も派生したレベルでちょうど 1 回実行されます。これは同期的な `Dispose()` / `protected virtual void Dispose(bool)` パターンを反映していますが、戻り値の型が `ValueTask` であり、`bool disposing` パラメーターがありません (純粋に非同期のケースでは区別すべきファイナライザーのパスがないためです)。

## IDisposable と IAsyncDisposable の両方をサポートする

両方のインターフェースを実装するのは一般的で、それにより同期的な `using` を使う呼び出し元と `await using` を使う呼び出し元の両方が正しいクリーンアップを得られます。重要な点は、`IAsyncDisposable` だけを実装し、呼び出し元がオブジェクトを通常の `using` でラップした場合 (または `IDisposable` しか知らないコンテナーに渡した場合)、`DisposeAsync` は決して実行されず、リソースをリークするということです。Microsoft はこれを注意事項として明示的に指摘しています。

デュアルパターンは、両方のエントリーポイントを共有ロジックにルーティングし、マネージドリソースが 2 回解放されないように非同期パスから `Dispose(false)` を使います。

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

`DisposeAsync` のパスが `Dispose(bool)` に `false` を渡すのは、`DisposeAsyncCore` がすでにマネージドリソースを非同期に解放したためです。`true` を渡すと、それらを 2 回目に解放しようとしてしまいます。これにより、二重解放なしで両方のパスを機能的に等価に保ちます。

## DisposeAsync をスキップするスタッキングの落とし穴

これは整理整頓しようとする人を苦しめます。同期的な `using` ステートメントをスタックできるようには `await using` ステートメントを「スタック」できません。なぜなら、最初のコンストラクターの後のコンストラクターが例外をスローすると、それ以前に作成されたオブジェクトが決して解放されないからです。

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

問題は、オブジェクトが `await using` ブロックに入る *前に* 構築されるため、構築とブロックの間の例外がそれらを未解放のまま残すことです。解決策は、構築とスコープ設定を同じステップで行うことです。次の 3 つの形式のいずれも安全です。

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

宣言形式を優先してください。コンストラクターが例外をスローしても、すでに宣言された変数に対するコンパイラー生成のクリーンアップは実行され、この種のスタッキングバグ全体を回避できます。

## await using での ConfigureAwait

ライブラリコードの内部では、解放の継続が元の同期コンテキストをキャプチャしないように、`ConfigureAwait(false)` が必要になることがよくあります。それを単にオブジェクトに付加することはできません。専用の拡張メソッド `ConfigureAwait(IAsyncDisposable, bool)` があり、これは `ConfiguredAsyncDisposable` を返します。

```csharp
// .NET 11, C# 14
await using (stream.ConfigureAwait(false))
{
    await stream.ReadAsync(buffer);
}
```

キャプチャすべき同期コンテキストがないアプリケーションコード (ASP.NET Core、コンソールアプリ、ワーカーサービス) では、省略できます。そこでは効果がありません。UI やレガシーな ASP.NET コンテキストから呼び出される可能性のあるライブラリでは、通常の await に対して `ConfigureAwait(false)` を使うのと同じ理由で、これを追加してください。

## そもそも解放する必要がない場所

依存性注入がこれを代わりに処理します。`IServiceCollection` にサービスを登録すると、コンテナーは解決されたインスタンスが `IDisposable` または `IAsyncDisposable` を実装しているかを追跡し、そのスコープの終わりに解放します。`IAsyncDisposable` を実装する scoped サービスは、スコープ自体が非同期で作成・解放されている限り (ASP.NET Core はこれを行います)、リクエストスコープが終わるときに `DisposeAsync` が待機されます。注入されたサービスに `await using` を書くことはありません。コンテナーにそれらのライフタイムを所有させます。注入されたサービスを手動で解放するのは、他の利用者の足元でそれを解放してしまうバグです。

## いつ IAsyncDisposable に頼るべきか

解放が本当に I/O を行う必要があるときに使ってください。バッファリングされたライターをソケットやファイルにフラッシュする、トランザクションをコミットまたはロールバックする、[Channel](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) を完了させてドレインする、あるいは長命の接続を優雅に閉じる、などです。クリーンアップが純粋に同期的な型 (ハンドルの解放、フィールドのクリア) には追加しないでください。通常の `IDisposable` の方がシンプルで、すべての呼び出し元を async メソッドに強制しません。そして型が非同期ストリームを生成する場合は、ストリーミングを解放に無理やり組み込もうとするのではなく、[IAsyncEnumerable&lt;T&gt;](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) と組み合わせてください。

非同期解放は、より広範な非同期の正しさの物語の 1 つのピースです。`DisposeAsync` が実際の処理を行う場合は、[CancellationTokenSource.CancelAfter で任意の非同期操作にタイムアウトを設定する](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)のと同じ方法で、キャンセルを意識したタイムアウトをそこに通し、クリーンアップを制限できるように [CancellationToken を async メソッドに伝播する](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)ようにしてください。クリーンアップが進行中の処理の停止を伴う場合、[長時間実行される Task をデッドロックせずにキャンセルする](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)ことを可能にするのと同じ規律がここに当てはまります。

2 つのルールを正しく守れば、非同期解放は最良の意味で退屈なものになります。利用側では `await using` を使い、実装側では sealed でない型に対して `DisposeAsync` を `DisposeAsyncCore` から分離し、同期的な呼び出し元が解放する可能性があるなら `IDisposable` も実装し、`await using` ブロックを決してスタックしないでください。

## 出典

- [DisposeAsync メソッドの実装 (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync)
- [IAsyncDisposable インターフェース (MS Learn API リファレンス)](https://learn.microsoft.com/en-us/dotnet/api/system.iasyncdisposable)
- [using ステートメントと宣言 (C# 言語リファレンス)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/using)
- [ConfigureAwait FAQ (.NET Blog)](https://devblogs.microsoft.com/dotnet/configureawait-faq/)

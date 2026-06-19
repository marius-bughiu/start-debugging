---
title: "IAsyncEnumerable<T> とは何か、いつ使うべきか"
description: "IAsyncEnumerable<T> は非同期ストリームのためのインターフェースです。要素が時間とともに到着し、それぞれの生成に await が必要になり得るシーケンスです。それが実際に何であるか、await foreach と yield がどう駆動するか、そして Task<List<T>> ではなくこれを選ぶ基準を解説します。"
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "iasyncenumerable"
lang: "ja"
translationOf: "2026/06/what-is-iasyncenumerable-and-when-should-i-use-it"
translatedBy: "claude"
translationDate: 2026-06-19
---

`IAsyncEnumerable<T>` は非同期ストリームのためのインターフェースです。一度に 1 要素ずつ取り出すシーケンスで、各要素の生成には何か（ネットワークの読み取り、データベースの行、ファイルのチャンク）を待機する必要があり得ます。これは `IEnumerable<T>` の非同期版の兄弟です。`yield return` と `await` を組み合わせたイテレーターメソッドで生成し、`await foreach` で消費します。時間とともに到着する要素が多数あり、最初の 1 つを処理する前にそれらすべてをメモリにバッファリングしたくない場合に、これを使ってください。結果を 1 つしか生成しない場合や、コレクション全体がすでにメモリにある場合は、必要ありません。この記事（.NET 11、C# 14 時点で有効）では、その仕組み、明白な代替手段が失敗する理由、そして判断基準を説明します。

## `Task<T>` と `IEnumerable<T>` が残す空白

4 つの形を並べると、欠けているセルが明らかになります。

| | 単一の値 | 複数の値 |
| --- | --- | --- |
| **同期** | `T` | `IEnumerable<T>` |
| **非同期** | `Task<T>` | `IAsyncEnumerable<T>` |

`Task<T>` は後で 1 つの値を提供します。`IEnumerable<T>` は複数の値を提供しますが、それぞれを取得する行為は同期的です。`MoveNext()` は `bool` を返し、待機できるものではありません。長年、右下のセルにはファーストクラスの型がなく、人々は 2 つの不適切な回避策でそれを偽装していました。

1 つ目は `Task<IEnumerable<T>>`（または `Task<List<T>>`）です。これは一度待機し、その後コレクション全体を渡します。動作はしますが、ストリーミングの目的を台無しにします。すべてが取得されるまで、あなたのコードには何も見えません。500 万行を返すクエリは、ループ本体が一度でも実行される前に 500 万件のリストを割り当てます。

2 つ目は `IEnumerable<Task<T>>` です。これはもっと悪いものです。これはタスクの同期シーケンスであり、イテレーターが作業の全体集合を前もって決定することを意味し、バックプレッシャーを適用したり、コンシューマーが関心を失った時点でタスクの生成を止めたりする自然な方法がありません。さらに、次のタスクを生成する `MoveNext` の中で `await` することもできないため、要素ごとのレイテンシがスレッドをブロックします。

C# 8 と .NET Core 3.0 で追加された `IAsyncEnumerable<T>` は、このセルを適切に埋めます。イテレーションの各ステップ自体が待機可能であるため、プロデューサーは要素の間で待機でき、コンシューマーは準備ができたときにのみ次の要素を取り出します。

## インターフェースが実際にどう見えるか

ここに魔法はありません。契約は小さなものです。

```csharp
// System.Collections.Generic
public interface IAsyncEnumerable<out T>
{
    IAsyncEnumerator<T> GetAsyncEnumerator(
        CancellationToken cancellationToken = default);
}

public interface IAsyncEnumerator<out T> : IAsyncDisposable
{
    T Current { get; }
    ValueTask<bool> MoveNextAsync();
    ValueTask DisposeAsync();
}
```

2 つの細部が設計全体を担っています。

`MoveNextAsync` は `Task<bool>` ではなく `ValueTask<bool>` を返します。この選択は意図的です。`MoveNextAsync` は要素ごとに 1 回呼ばれるので、10 万件の要素のストリームは 10 万回の呼び出しを意味します。もしそれぞれがヒープ上に `Task` オブジェクトを割り当てたら、非同期ストリームは割り当ての惨事になります。`ValueTask<bool>` は、結果がすでに同期的に利用可能なとき（たとえばバッファ済みの行）は何も割り当てません。これは高速なプロデューサーでは一般的なケースです。ヒープのコストを払うのは、要素が本当に待機しなければならないときだけです。

`IAsyncEnumerator<T>` は `IDisposable` ではなく `IAsyncDisposable` を実装します。クリーンアップが非同期なのは、基盤となるリソース（ソケット、`DbDataReader`）を閉じること自体が I/O を必要とし得るからです。だからこそ、消費側のループは単純な `foreach` ではなく `await foreach` を必要とします。イテレーションの終わりでの破棄は待機されなければなりません。

これらのメンバーを手で呼び出すことはほとんどありません。コンパイラーが両端であなたの代わりに行います。

## ストリームの生成: `yield return` が `await` と出会う

非同期イテレーターメソッドとは、`IAsyncEnumerable<T>` を返し、`await` と `yield return` の両方を含むメソッドです。コンパイラーはそれを、各 `await` で中断し次の `MoveNextAsync` で再開する方法を知っているステートマシンへと書き換えます。

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var reader = new StreamReader(path);
    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

これが何をもたらすか読んでみてください。各行は非同期に読み取られ、すぐに返されます。呼び出し元は、2 行目がまだディスクから読み取られている間に 1 行目を処理できます。ファイルが 10 行であろうと 10 ギガバイトであろうと、メモリが保持するのは 1 行とリーダーの内部バッファだけです。リーダーの `using` は生成された `DisposeAsync` を通じて守られるため、コンシューマーが早期に抜けたり例外がループを巻き戻したりした場合も含め、イテレーションが終わるとファイルハンドルが閉じられます。

トークンパラメーターに付ける `[EnumeratorCancellation]` 属性は、人々が忘れる部分です。これは、このパラメーターがコンシューマーが `WithCancellation` 経由で渡すトークンを受け取るべきだとコンパイラーに伝え、外部のキャンセルをイテレーター本体へ通します。これがないと、パラメーターは既定で `CancellationToken.None` を取り、コンシューマーが供給したものを無視する、ただの通常の引数になります。これについては後で詳しく述べます。非同期ストリームで最もよくある正しさのバグだからです。

## ストリームの消費: `await foreach`

コンシューマー側は通常のループよりキーワードが 1 つ長いだけです。

```csharp
// .NET 11, C# 14
await foreach (var line in ReadLinesAsync("huge.log", ct))
{
    if (line.Contains("ERROR"))
        await alertSink.WriteAsync(line, ct);
}
```

コンパイラーはこれを、`GetAsyncEnumerator` の呼び出し、毎回 `Current` を読む `await MoveNextAsync()` のループ、そして finally ブロック内の `await DisposeAsync()` へと展開します。ループは完全に逐次的です。要素 N+1 は、本体が要素 N を処理し終えるまで要求されません。この逐次的で需要駆動の形は、制限ではなく機能です。これがメモリを抑え、自然なバックプレッシャーを与えます。遅いコンシューマーは自動的にプロデューサーを減速させます。プロデューサーの次の `await` は、次の `MoveNextAsync` 呼び出しまで再開しないからです。

イテレーション順序が重要でなく並行性が欲しい場合、`await foreach` は誤ったツールです。`IAsyncEnumerable<T>` を消費し、並列度の上限つきで複数の要素に対して本体を一度に実行できる [Parallel.ForEachAsync](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) を使ってください。`await foreach` は順序つきで一度に 1 つずつの処理のためのものです。

## キャンセル: `WithCancellation` と `[EnumeratorCancellation]` のペア

裸の `await foreach (var x in stream)` はトークンを渡す場所を与えません。言語構文にそのためのスロットがないからです。輪を閉じる 2 つの部品は、コンシューマー側の `WithCancellation` とプロデューサー側の `[EnumeratorCancellation]` です。

```csharp
// Producer: token parameter is tagged
public static async IAsyncEnumerable<int> ProduceAsync(
    [EnumeratorCancellation] CancellationToken ct = default)
{
    for (var i = 0; ; i++)
    {
        await Task.Delay(100, ct);
        yield return i;
    }
}

// Consumer: token is forwarded into GetAsyncEnumerator
await foreach (var n in ProduceAsync().WithCancellation(ct))
{
    Console.WriteLine(n);
}
```

`WithCancellation` はシーケンスを別のイテレーターでラップしたり、オーバーヘッドを追加したりしません。トークンを記録するだけで、コンパイラーが `GetAsyncEnumerator(token)` を呼ぶとトークンが中へ流れ込み、`[EnumeratorCancellation]` がそれをプロデューサーのパラメーターへ通します。トークンをキャンセルすると、保留中の `await Task.Delay` が `OperationCanceledException` をスローし、それがあなたの `await foreach` を通じて外へ伝播します。

トークンを省略することが、本番環境でハングしたバックグラウンドジョブや行き詰まったリクエストを生む原因です。ネットワークやデータベース上のストリームはループ全体の間コネクションを保持し、トークンがなければ呼び出し元が去ったときにそれを中止する方法がありません。I/O に支えられたあらゆるストリームでは、`WithCancellation(ct)` を必須として扱ってください。

## `ConfigureAwait` はループ上でも機能する

`await foreach` は内部で待機するので、通常の `await` と同じように同期コンテキストのキャプチャを拾います。キャプチャされたコンテキストへ戻るべきでないライブラリコードでは、`ConfigureAwait` を使ってループ全体に `ConfigureAwait(false)` を適用します。

```csharp
await foreach (var item in stream.ConfigureAwait(false))
{
    Process(item);
}
```

これは `MoveNextAsync` の await と、最後の `DisposeAsync` の await の両方を構成します。最新の ASP.NET Core アプリにはキャプチャすべき同期コンテキストがないので、そこでは何もしませんが、ライブラリコード、コンソールホスト、UI やレガシーのコンテキスト下で動作し得るものにとっては依然として重要です。トレードオフは非同期コードのほかの場所と同じで、[ConfigureAwait は .NET 11 でまだ重要か](/2026/05/configureawait-false-vs-default-in-dotnet-11/) で扱っています。

## 非同期ストリーム上の LINQ は今や標準で同梱される

長年の粗削りな点は、`IAsyncEnumerable<T>` に LINQ がなかったことでした。`stream.Where(...).Select(...)` を書くには、コミュニティが保守する NuGet パッケージ `System.Linq.Async` を持ち込んでいました。.NET 10 からそれが変わりました。ランタイムが `System.Linq.AsyncEnumerable` を BCL に同梱するので、標準の演算子はパッケージ参照なしであらゆる `IAsyncEnumerable<T>` 上で機能し、.NET 11 はこれを継承します。

```csharp
// .NET 11: Where/Select/Take resolve from the BCL, no NuGet package
var firstTenErrors = ReadLinesAsync("huge.log", ct)
    .Where(l => l.Contains("ERROR"))
    .Take(10);

await foreach (var line in firstTenErrors.WithCancellation(ct))
    Console.WriteLine(line);
```

古いプロジェクトを移行している場合は、.NET 10 以降へ移るときに明示的な `System.Linq.Async` 参照を削除してください。残しておくと、今や組み込みのメソッドに対してあいまいなオーバーロードのエラーを引き起こします。知っておくべき名前の変更が 1 つあります。非同期ラムダを取っていた古い `SelectAwait`/`WhereAwait` 演算子はなくなり、代わりに通常の `Select`/`Where` に非同期デリゲートを渡します。複数の古いランタイムをターゲットにするコードは、`System.Linq.Async` ではなく `System.Linq.AsyncEnumerable` パッケージを参照すべきです。

## いつこれに手を伸ばすべきか

次の 3 つがすべて成り立つときに `IAsyncEnumerable<T>` を使ってください。

1. 要素が **多数** ある、または数が不明あるいは無制限である。
2. 各要素の生成が **非同期 I/O**（データベース、ネットワーク、ファイル、メッセージキュー）を伴う。
3. **最後の要素が到着する前に処理を開始したい**、またはそれらを一度にすべてメモリに保持する余裕がない。

具体的に当てはまるケース: [EF Core 11 で IAsyncEnumerable を使う](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) で扱っているように、エクスポートのためにデータベースから行をストリーミングする。ページ分割された API をページごとに読み、ページが到着するたびに各要素を返す。決して終わらないログやメッセージのストリームを追う。データを [Channel](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) や `PipeWriter` へ流し込む。ASP.NET Core では、minimal API やコントローラーアクションから `IAsyncEnumerable<T>` を返すと、レスポンス全体をバッファリングする代わりに JSON 配列を要素ごとにクライアントへストリーミングします。

## いつ使うべきでないか

非同期ストリームは無料ではなく、常に正しい形であるわけでもありません。

- **データがすでにメモリにある。** `List<T>` や配列をイテレートする? `foreach` を使ってください。メモリ上のコレクションを非同期ストリームでラップするのはステートマシンのオーバーヘッドを加えるだけで、何も買いません。実際に待機する要素が 1 つもないからです。
- **結果がちょうど 1 つ。** 単一のレコードを返すメソッドは `Task<T>` を返すべきです。1 つだけのストリームは儀式にすぎません。
- **集合が小さく有界で、ランダムアクセス、`Count`、または複数回のパスが必要。** `Task<List<T>>`（`ToListAsync` 経由）の方が単純で、インデックス付け、カウント、再列挙ができます。ストリーミングが与えるのは前方向・単一パスのシーケンスです。それ以上が必要なら、マテリアライズしてください。
- **要素にわたる真の並列性が必要。** 単一の `await foreach` は設計上逐次的です。ファンアウトには `Parallel.ForEachAsync` を使うか、タスクを集めて `Task.WhenAll` してください。

役立つ経験則: ストリームに対してすぐに `ToListAsync()` を呼んでいる自分に気づいたら、欲しかったのはストリームではなくリストです。そして、メソッドのシグネチャを満たすためだけにメモリ上のリストを `IAsyncEnumerable<T>` としてラップしたくなったら、そのシグネチャを見直してください。

## 破棄と早期終了についての注記

列挙子が `IAsyncDisposable` であるため、`await foreach` はループが何らかの理由で終わるとき、`DisposeAsync` が実行されることを保証します。正常な完了、`break`、または本体を貫く例外のいずれでもです。これが非同期イテレーター内の `using` を安全にしています。微妙な帰結は、早期に抜けても基盤となるソースが即座に止まるとは限らないことです。データベースはサーバー側ですでに行をスプールしているかもしれませんし、バッファ済みのネットワークリーダーは次のチャンクをプリフェッチしているかもしれません。破棄はキャンセルのシグナルを送りますが、すでに進行中の少量の作業はそれでも完了し得ます。これはほとんど問題になりませんが、プロファイラーで「ループを抜けたあとなのに、なぜこのクエリがまだ走っているのか」という時折の瞬間を説明します。

非同期ストリームは、値／コレクションの行列の扱いにくい右下のセルをファーストクラスの言語機能へと変えました。心的モデルがすべてです。これは各ステップが `await` できる `IEnumerable<T>` であり、`await foreach` によって駆動され、要素が時間とともに到着し、それらすべてを待つよりも到着するそばから処理したい、まさにそのときに使う価値があります。

## 関連

- [How to use IAsyncEnumerable<T> with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) は、これらすべてをデータベースの行のストリーミングに適用します。
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) は、3 つのシーケンスインターフェースの並列の判断ガイドです。
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) は、ストリームを生成する側の HTTP レスポンス版の対応物です。
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は、非同期ストリームが依存するキャンセルトークンをより深く掘り下げます。
- [Streaming tasks with .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) は、結果が完了するそばから消費するもう 1 つの主要な方法です。

## 出典

- [IAsyncEnumerable<T> interface, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1?view=net-10.0).
- [Generate and consume async streams, C# docs](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream).
- [EnumeratorCancellationAttribute class, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute?view=net-10.0).
- [Breaking change: System.Linq.AsyncEnumerable in .NET 10, MS Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/asyncenumerable).
- [async-streams design doc, dotnet/roslyn on GitHub](https://github.com/dotnet/roslyn/blob/main/docs/features/async-streams.md).

---
title: "C# のリポジトリメソッドで Task を直接返す vs async/await でパススルーする: どちらを使うべきか"
description: "リポジトリのパススルーメソッドで async/await を省略すると約 6 ns と 72 バイトを節約できますが、スタックフレーム、try/catch のセマンティクス、安全なリソース破棄を失います。計測済みのホットパス上の純粋なパススルーでない限り、return await を残してください。"
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "performance"
lang: "ja"
translationOf: "2026/09/return-task-directly-vs-async-await-passthrough-in-a-csharp-repository-method"
translatedBy: "claude"
translationDate: 2026-09-01
---

EF Core、Dapper、あるいは `HttpClient` へ転送するだけのリポジトリメソッドがあるとします。これは `public Task<Order> GetAsync(int id) => _db.Orders.FindAsync(id).AsTask();` と書いてステートマシンを省くこともできますし、`public async Task<Order> GetAsync(int id) => await _db.Orders.FindAsync(id);` と書いて残すこともできます。**`await` は残してください。** 省略して得られるのは .NET 10 で 1 回の呼び出しあたりおよそ 6 ナノ秒と 72 バイトであり、これはデータベースへのラウンドトリップに比べれば見えない差です。その代わりに、すべてのスタックトレースから 1 フレームが失われ、さらにそのメソッドがいずれ `using`、`try`、`lock` を持つようになったときに黙って変わる 3 つの挙動を抱え込むことになります。省略してよいのは、そのメソッドが本当に 1 行のパススルーであり、かつプロファイルを取った経路上にある場合だけです。以下の計測はすべて .NET 10.0.10、C# 14 上のものです。.NET 11 (Preview 7、正式リリースは 2026-11-10) の話は最後にありますが、それは省略を支持する論拠を強めるのではなく弱めます。

## 2 つの書き方の比較

| 挙動                                             | `return await inner()` (async) | `return inner()` (省略)   |
| ------------------------------------------------ | ------------------------------ | ------------------------- |
| ステートマシンが生成される                       | はい                           | いいえ                    |
| 例外のスタックトレースに現れる                   | はい                           | **いいえ**                |
| コスト、内部呼び出しが同期的に完了する場合       | 8.5 ns / 144 B                 | 2.6 ns / 72 B             |
| コスト、内部呼び出しが実際に中断する場合         | 1111 ns / 286 B                | 1010 ns / 191 B           |
| `using` / `await using` の中で安全               | はい                           | **いいえ**                |
| 呼び出しを囲む `try`/`catch` が実際に機能する    | はい                           | **いいえ**                |
| 引数検証の例外が発生する場所                     | `await` 時                     | 呼び出し箇所              |
| 戻り値の型が内部と異なってよい                   | はい (共変性、`ValueTask`)     | いいえ (CS0029)           |
| `ConfigureAwait(false)` を適用できる             | はい                           | 該当なし (内部を継承)     |
| 最後の await を消すと CS1998 が出る              | はい                           | 該当なし                  |

この表のうち 2 行はコンパイル時の事実で、残りは本番環境でしか気づけない実行時の挙動です。この非対称性こそが、既定を選ぶ理由のすべてです。

## コンパイラーが実際に出力するもの

`async` は呼び出し規約ではなく、書き換えです。メソッドに `async` を付けると、Roslyn はそれを `IAsyncStateMachine` を実装する struct に変換し、すべてのローカル変数をその struct のフィールドに引き上げ、本体を `MoveNext()` 内の switch に置き換えます。メソッド自体は `AsyncTaskMethodBuilder<T>` を生成し、ステートマシンを起動して `builder.Task` を返すだけのスタブになります。この返される `Task<T>` は、内部呼び出しが生成したものとは別の**新しい**タスクであり、内部タスクが完了したときにそれを完了させる責任は builder が負います。

`async` を省略すると、これらは一切起きません。メソッドは単なる呼び出しと return にコンパイルされ、呼び出し側は内部メソッドが生成した `Task<T>` の*まったく同じ*インスタンスを受け取ります。builder もヒープ上のステートマシンも継続の登録も、2 つ目のタスクもありません。

```csharp
// .NET 10, C# 14
public sealed class OrderRepository(AppDbContext db)
{
    // elided: the caller gets the exact Task instance EF Core created
    public Task<List<Order>> GetOpenAsync(CancellationToken ct) =>
        db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);

    // await passthrough: EF Core's task is awaited, and a second task is handed out
    public async Task<List<Order>> GetOpenAwaitedAsync(CancellationToken ct) =>
        await db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);
}
```

どちらもコンパイルできます。どちらも*この本体そのものに対しては*正しいです。違いが出てくるのは、本体がこの形でなくなった瞬間からです。

## 余分な await が実際にかかるコスト

BenchmarkDotNet 0.15.8 を使い、Apple M4 (10 コア)、macOS 26.6.2、.NET SDK 10.0.302、ホストランタイム .NET 10.0.10、Arm64 RyuJIT、`MemoryDiagnoser` 有効、ワークステーション GC の条件で 2 つの書き方を計測しました。シナリオは 2 つです。同期的に完了する内部メソッド (`Task.FromResult`、EF Core の一次キャッシュにヒットするケース) と、実際に中断する内部メソッド (`await Task.Yield()`、本物の I/O のケース) です。

| メソッド            | 平均       | Ratio | 割り当て  | 割り当て比 |
| ------------------- | ---------- | ----- | --------- | ---------- |
| `Elided_Completed`  | 2.63 ns    | 1.00  | 72 B      | 1.00       |
| `Awaited_Completed` | 8.47 ns    | 3.22  | 144 B     | 2.00       |
| `Elided_Suspends`   | 1009.95 ns | 383.5 | 191 B     | 2.65       |
| `Awaited_Suspends`  | 1110.81 ns | 421.8 | 286 B     | 3.97       |

比率だけを見ると、省略は 3 倍の勝利に見えます。絶対値を見れば、同期パスで 5.8 ナノ秒と 72 バイト、中断するパスで 101 ナノ秒と 95 バイトです。高速パスの 72 バイトは builder が割り当てる 2 つ目の `Task<int>` であり、低速パスの 95 バイトはヒープ上のステートマシンとそのタスクです。

これをリポジトリメソッドが実際に行う作業と並べてみてください。ローカルの PostgreSQL へのラウンドトリップは 200 から 500 マイクロ秒です。アベイラビリティゾーンをまたぐ場合は数ミリ秒です。101 ナノ秒は 1 クエリの 0.002% から 0.05% にあたります。1 回のクエリ分の時間を取り戻すには、省略したパススルーが 1 万回規模で必要になります。比率がまるごと飲み込まれないのは同期完了のケースだけであり、そのケースが効いてくるのは予想どおりの場所です。すでにキャッシュ済みの値をまわすタイトなループ、`ValueTask` の高速パス、シリアライザーのホットループ。`GetOrderByIdAsync` ではありません。

## 省略が黙って挙動を変える場所

### スタックフレームが消える

これは毎日払っていながら、午前 3 時にしか気づかないコストです。タスクを待機せずに返すメソッドは、return した瞬間に終わっています。例外が投げられる頃には、そのフレームはとうに消えています。非同期コードのスタックトレースは、保留中の継続の記録であって、誰が誰を呼んだかの記録ではありません。

```csharp
// .NET 10, C# 14
static Task ElidedPassthroughAsync() => ThrowAsync();
static async Task AwaitedPassthroughAsync() => await ThrowAsync();

static async Task ThrowAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}
```

最上位で捕捉して `ex.StackTrace` を出力すると、2 つの異なる姿が見えます。

```text
=== ELIDED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<Main>$(String[] args) in Program.cs:line 4

=== AWAITED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<<Main>$>g__AwaitedPassthroughAsync|0_1() in Program.cs:line 11
   at Program.<Main>$(String[] args) in Program.cs:line 7
```

`ElidedPassthroughAsync` はトレースにまったく現れません。メソッド 2 つのサンプルなら、これは面白い豆知識です。しかし実際のサービスで、`ThrowAsync` に相当するもの (`ToListAsync` から出てくる `SqlException`) が 11 個の異なるリポジトリメソッドから到達される場合、省略されたフレームこそが、どの機能が壊れたのかを教えてくれるはずだったものです。[.NET 11 の Runtime Async が非同期スタックトレースを整理する仕組み](/ja/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)をすでに読んでいるなら、あれは*残っている*フレームを大幅に読みやすくしますが、継続を一度も登録しなかったフレームを復活させることはできない点に注意してください。

### `using` が処理の完了前に破棄する

これはトレードオフではなく、バグです。`using var` はスコープの残りを囲む `try`/`finally` にコンパイルされ、`finally` はメソッドが return したときに実行されます。await を省略したメソッドは、内部呼び出しが未完了のタスクを返した時点で return します。

```csharp
// .NET 10, C# 14 -- broken: the resource is disposed while the task is still running
static Task<int> BadAsync()
{
    using var res = new Resource();
    return res.UseAsync();
}

// correct: the finally runs after the awaited work completes
static async Task<int> GoodAsync()
{
    using var res = new Resource();
    return await res.UseAsync();
}
```

`BadAsync` は毎回 `ObjectDisposedException: Cannot access a disposed object. Object name: 'Resource'` を投げ、`GoodAsync` は正常に完了します。同じことが `IAsyncDisposable` に対する `await using`、`finally` で解放する `SemaphoreSlim`、あらゆるトランザクションスコープにも当てはまります。リポジトリが接続を開いたり、トランザクションを開始したり、プールから借りたりしているなら、省略は最適化ではなく解放後使用です。破棄の順序に関するルールは[await using で IAsyncDisposable を実装して利用する方法](/ja/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)で詳しく扱っています。

### `try`/`catch` が捕捉しなくなる

同じ仕組みで、症状が違います。`catch` ブロックが捕捉するのは、フレームがスタック上にある間に投げられた例外だけです。内部メソッドが中断した後に投げられた例外は、返されたタスク経由で配送され、それはあなたの `try` ブロックを抜けたずっと後のことです。

```csharp
// .NET 10, C# 14
static Task<string> ElidedTryAsync()
{
    try { return ThrowAsync(); }                              // catch never runs
    catch (InvalidOperationException) { return Task.FromResult("caught"); }
}

static async Task<string> AwaitedTryAsync()
{
    try { return await ThrowAsync(); }                        // catch runs
    catch (InvalidOperationException) { return "caught"; }
}
```

省略版は `InvalidOperationException` を呼び出し側へ逃がし、await 版は `"caught"` を返します。これはコードレビューを生き延びるタイプのバグです。`try`/`catch` が*まさにそこに*あって、何かしているように見えるからです。

### 検証の例外が呼び出し箇所へ移動する

`async` メソッドは決して同期的に例外を投げません。1 行目からの例外も含め、すべての例外は捕捉されて返されるタスクに載せられます。await を省略したメソッドには捕捉先の builder がないため、ガード句は即座に、呼び出し式の位置で例外を投げます。呼び出し側が待機するタスクを手にする前です。

```csharp
// .NET 10, C# 14
static Task<int> ElidedValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws at the call site
    return Task.FromResult(id.Length);
}

static async Task<int> AsyncValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws when the task is awaited
    await Task.Yield();
    return id.Length;
}
```

`var t = repo.GetAsync(null); /* ... */ await t;` と書く呼び出し側や、`Select` の中でこのメソッドを `Task.WhenAll` に渡す呼び出し側は、2 つの書き方で挙動が変わります。省略版では `Select(x => repo.GetAsync(x)).ToList()` が*マテリアライズ中に*例外を投げることがあり、`WhenAll` に到達する前に終わってしまうため、すでに開始済みのタスクはどれも観測されません。どちらの挙動も単独では誤りではありませんが、`await` を足したり消したりするだけでこの 2 つを行き来するのは、読み手が予期するリファクタリングではありません。

## そもそもコンパイルできないケース

`Task<T>` はクラスなので不変 (invariant) です。`Task<Dog>` は `Task<Animal>` ではなく、コンパイラーがそう伝えてきます。

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.Task<Dog>'
              to 'System.Threading.Tasks.Task<Animal>'
```

内部メソッドが `ValueTask<int>` を返し、契約が `Task<int>` である場合にも同じ壁にぶつかります。これは `FindAsync` や `IAsyncEnumerable` との橋渡しに触れた途端によくあることです。

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.ValueTask<int>'
              to 'System.Threading.Tasks.Task<int>'
```

`await` はこの変換を無料で行います。それがなければ `.AsTask()` (割り当てが発生し、節約が帳消しになります) か、存在しない明示的キャストが必要になります。リポジトリのインターフェイスはほぼ常に、プロバイダーの具体的な戻り値の型 (`Task<List<Order>>`) ではなく抽象 (`Task<IReadOnlyList<Order>>`) を公開するので、これは端のケースではなくインターフェイスの大半です。代わりに `ValueTask` を上位レイヤーへ押し上げようと考えているなら、先に[ValueTask が割に合うのはいつか](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/)を読んでください。制約のコストは割り当てのコストを上回ります。

省略はまた、`ConfigureAwait(false)` を置くはずの継ぎ目も消します。`SynchronizationContext` を持つホストをまだ対象にしているライブラリでは、省略したパススルーは内部メソッドが設定したものをそのまま継承し、それは何も設定されていないかもしれません。注釈を書く場所が 1 つ減るということは、修正できる場所が 1 つ減るということでもあります。2026 年にその継ぎ目がまだ価値を持つかどうかは[.NET 11 における ConfigureAwait(false) と既定の比較](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)で扱っています。

## .NET 11 の runtime async がこの取引に与える影響

`net11.0` を対象とするプロジェクトで `<EnablePreviewFeatures>` を必要としなくなった runtime async は、中断処理をコンパイラー生成のステートマシンから CLR へ移します。Preview 7 では、この比較に直接効く 2 点が追加されました。非同期メソッドが tier0 のコードを永続的に実行するのをやめて階層型コンパイルを通るようになったこと、そして JIT が **tail-await 最適化**を得たことです。非同期メソッドの最後の動作が、返されるタスクがそのメソッド自身の戻り値の型と一致する呼び出しの待機である場合、ランタイムは暗黙の末尾呼び出しを生成でき、「コードサイズと命令数を大幅に削減」します。この最適化はまさに `async Task<T> M() => await Inner();` を指しています。つまり、ソースコードがフレームのセマンティクスを手放すことなく、ランタイムが省略と同じ効果を与えてくれるということです。

同じリリースノートには、tier0 での tail-await 対応により TechEmpower `platform-json` のウォームアップ中の最大割り当てレートが 110,580,952 B/秒 から 8,030,616 B/秒 へ下がったと報告されています。方向性は明確です。あなたが手作業で最適化しようとしている差を、ランタイムが埋めつつあります。72 バイトを節約するために今日 `return inner()` と書くのは、11 月に出荷されるコンパイラー最適化を捨てつつ、挙動上の危険をすべて恒久的に抱え込むことです。

## 間違った方向へ押してくるアナライザー

よく使われる 2 つのアナライザーが `return await` を冗長だと指摘します。最初にぶつかるのは Roslynator の **RCS1174「Remove redundant async/await」**で、Stephen Cleary と .NET チームがこの変換を一律のルールとしては安全でないと考えているまさにその理由から、既定でオフにしてほしいという長年の要望が出ています。**AsyncFixer01「Unnecessary async/await usage」**も同じ提案をします。どちらのアナライザーも、あなたのメソッドが次のスプリントで `using` を持つようになるかどうかは見えませんし、あなたが本番のトレースでそのフレームに頼っていることも知りません。

実務的な設定は、両方ともオフにするか、`suggestion` にしてソリューション全体への自動修正を絶対に行わないことです。「RCS1174 をすべてのドキュメントに適用」という一括操作は、動いているコードベースに `ObjectDisposedException` を持ち込みうる数少ないリファクタリングの 1 つです。これは CS1998 とは逆方向である点に注意してください。あの警告は `async` メソッドに `await` が*まったくない*ときに出るもので、そこでは修飾子を外すのが本当に正しい修正です。詳しくは[メソッドを壊さずに CS1998 を直す方法](/ja/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/)をご覧ください。

## リポジトリのコードで私が使っているルール

- **既定は `return await`。** 6 ナノ秒は実質存在しませんが、失われたスタックフレームと破棄の危険は実在します。
- **次の 4 つがすべて成り立つときだけ省略する**: メソッド本体がちょうど 1 つの `return` 文であること、その中のどこにも `using`、`try`、`lock`、`finally` がないこと、戻り値の型が内部呼び出しと同一であること、そしてそのパススルーがホットパス上にあるとプロファイルが示していること。3 つは読めば確認できます。4 つ目が、みんなが飛ばすものです。
- **RCS1174 や AsyncFixer01 を一括適用しない。** メソッドごとに直すのではなく、プロジェクト単位で抑制してください。
- **.NET 11 では省略そのものをやめる。** tail-await 最適化がコード生成を無料で与えてくれますし、省略した書き方はランタイムが保持したはずのフレームを手放します。

この比較で居心地が悪いのは、省略した書き方が遅くも醜くも間違ってもいないことです。それは本当に速く、ただしどのリポジトリも一生気づかない程度の差で、その見返りに、誰かが編集したらセマンティクスが変わるメソッドを抱えることになります。どんなレートで見ても割の悪い取引ですし、.NET 11 はまもなく分子をゼロにします。

## 関連記事

- [.NET 11 の Runtime Async はステートマシンを置き換えてスタックトレースをきれいにする](/ja/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)
- [CS1998「This async method lacks 'await' operators and will run synchronously」の直し方](/ja/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/)
- [.NET 11 における ConfigureAwait(false) と既定の比較: まだ意味はあるのか](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [ValueTask とは何か、そしていつ割に合うのか](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [C# で await using を使って IAsyncDisposable を実装して利用する方法](/ja/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)
- [C# における .Result と .Wait() と GetAwaiter().GetResult() と await の比較](/ja/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

## 参考資料

- [Eliding Async and Await](https://blog.stephencleary.com/2016/12/eliding-async-await.html) -- Stephen Cleary
- [.NET 11 Preview 7 ランタイムリリースノート: runtime-async tiering and tail-await optimizations](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/runtime.md) -- dotnet/core
- [.NET 11 Preview 7 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/) -- .NET Blog
- [RCS1174: Remove redundant async/await](https://josefpihrt.github.io/docs/roslynator/analyzers/RCS1174/) -- Roslynator
- [Disable by default RCS1174 (issue #429)](https://github.com/JosefPihrt/Roslynator/issues/429) -- dotnet/roslynator
- [async および await のコンパイラーメッセージリファレンス](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) -- Microsoft Learn

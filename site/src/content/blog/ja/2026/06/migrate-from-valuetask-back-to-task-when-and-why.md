---
title: "ValueTask<T> から Task<T> へ戻す移行: いつ、なぜ (.NET 11, C# 14)"
description: "ValueTask および ValueTask<T> の戻り値型を Task と Task<T> に戻すための実践的なチェックリスト。呼び出し側で何が壊れるか、各変更をどう検証するか、その入れ替えに価値があったかをどう見極めるか。"
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "ja"
translationOf: "2026/06/migrate-from-valuetask-back-to-task-when-and-why"
translatedBy: "claude"
translationDate: 2026-06-06
---

`ValueTask<T>` の API を `Task<T>` に戻す作業は通常は半日で済み、ほぼ常に安全です。なぜなら `Task<T>` のほうが寛容な型だからです。`ValueTask<T>` に対してコンパイルできていたものはそのままコンパイルでき、呼び出し側に潜んでいたいくつかのバグは入れ替えた瞬間に消えます。時間がかかるのは戻り値型の変更そのものではなく、`ValueTask` のセマンティクスに依存していた呼び出し箇所の監査です。二度待機されているメソッド、フィールドにキャッシュされた結果、ホットパス上の `.GetAwaiter().GetResult()` などです。本ガイドでは、戻すのが正しい判断となるのはどんなときか、宣言と各呼び出し側に対する正確な編集、各ステップの検証方法、そしてその後に、元々 `ValueTask` を採用して修正したはずのアロケーションプロファイルを悪化させていないことをどう確認するかを扱います。

これは 2026 年 6 月時点で最新の .NET 11 と C# 14 を対象としていますが、内容はバージョン固有ではありません。`ValueTask` の契約は .NET Core 2.1 で導入されて以来安定しています。本稿の助言は Stephen Toub の正典的なガイド [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) に従っており、その結論は率直です。「既定の選択は依然として `Task` / `Task<TResult>` です。」プロファイラーに勧められたわけでもなく `ValueTask` を採用したのなら、本稿はあなたを引き戻すための記事です。

## そもそもなぜ戻すのか

`ValueTask<T>` は、ある特定のアロケーションを避けるために存在します。非同期メソッドが同期的に完了する場合でもヒープに確保してしまう `Task<T>` オブジェクトです。それは、ほぼ常に待機せずに終わるホットパス (キャッシュヒット、バッファ済みの読み取り、メモ化された計算) では実在するコストです。しかしこの型は、その利得を、容易に破れる契約という代償で支払っており、これに手を伸ばすコードベースの大半は、そもそもアロケーションの問題を抱えていません。戻すべき具体的な理由は次のとおりです。

- **呼び出し箇所が CA2012 を繰り返し発火させる。** チームが同じ `ValueTask` を二度待機したり、フィールドに保存したり、その上でブロックしたりを繰り返しているなら、この型はあなたに正しさという代償を能動的に払わせています。`Task<T>` ではそれらの操作はすべて合法になります。
- **利得を一度も測っていない。** `ValueTask` はプロファイラー主導の最適化です。反射的に採用しただけで、ベンチマークがアロケーション差を示さないなら、加わった慎重さは純粋なオーバーヘッドです。
- **メソッドが今では大抵は非同期で完了する。** `ValueTask` は同期完了が一般的なケースであるときにのみ報われます。メソッドがほとんどの呼び出しで実際の I/O を待機するようになったのなら、いずれにせよ裏付けオブジェクトを確保しており、加えて構造体の制約を無駄に背負っています。
- **`WhenAll` / `WhenAny` のエルゴノミクスが欲しい。** コンビネーターは `Task` を取るので、`ValueTask` を返す API は各呼び出し側に対し、ファンアウトの前に `.AsTask()` を書くことを強います。戻せばその摩擦が消えます。

逆方向を検討している場合や、そもそも `ValueTask` が自分のコードに属するのかをまだ判断している場合は、以下のルールは判断材料としても役立ちます。

## 何が壊れるか (ネタバレ: ごくわずか)

| 領域 | 変更 | 重大度 |
| --- | --- | --- |
| メソッド宣言 | `ValueTask<T>` が `Task<T>` に、`ValueTask` が `Task` に | 低 |
| 直接 `await` する呼び出し箇所 | 変更不要。どちらの型も待機可能 | なし |
| `.AsTask()` の呼び出し | 今や冗長。削除する | 低 |
| `IValueTaskSource<T>` の実装 | 本物の `Task` ソースまたは `TaskCompletionSource<T>` に置き換える必要がある | 高 |
| 同期ファストパスの戻り | `return new ValueTask<T>(value)` が `return Task.FromResult(value)` に | 中 |
| インターフェース / 基底クラスのシグネチャ | すべての実装側とオーバーライドを同時に変更する必要がある | 中 |
| 公開 API 面 | 外部の利用者にとってバイナリ破壊的な変更 | 高 |

本当に難しいケースは、手書きの `IValueTaskSource<T>` (まれであり、もしあるなら意図的に `ValueTask` を採用しているので、二度考えてください) と、戻り値型の変更がバイナリ破壊となる公開 NuGet 面だけです。それ以外はすべて機械的です。

## 事前チェックリスト

シグネチャを 1 つでも触る前に:

- アナライザーが有効であることを確認します。`ValueTask` の正しさを検査するルール **CA2012** は、.NET 10 以降では既定で提案として有効です。これを警告に昇格させて、どの呼び出し箇所が `ValueTask` のセマンティクスに依存していたかをコンパイラーに正確に示させます。`.editorconfig` に `dotnet_diagnostic.CA2012.severity = warning` を追加してください。
- ベースラインを取得します。アロケーションがかつて `ValueTask` の理由だったなら、後で比較できるよう、今のうちにホットパスに対して `[MemoryDiagnoser]` 付きの `BenchmarkDotNet` を一度走らせます。
- 契約の境界を特定します。メソッドがインターフェースを実装するか基底メンバーをオーバーライドしているなら、関連するすべての宣言を同じコミットで変更します。まずソリューション全体でメソッド名を検索してください。
- 公開面を確認します。この型が NuGet パッケージで出荷されている場合、戻り値型の変更はソースコード互換であってもバイナリ破壊的です。メジャーバージョンの引き上げを計画してください。

## 移行の手順

以下の各ステップは検証行を伴う個別の変更です。順番に行ってください。契約がすべての箇所で更新されるまで、ビルドが赤くなる中間状態を見込んでおいてください。

1. **CA2012 を警告にしてビルドする。** 何かを変更する前にアナライザーを騒がしくして、`ValueTask` のシグネチャがまだ残っているうちに、危険な消費パターンをすべてビルドに表示させます。

   ```ini
   # .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
   [*.cs]
   dotnet_diagnostic.CA2012.severity = warning
   ```

   `dotnet build` を実行します。CA2012 の各警告は、`ValueTask` を二度待機したか、保存したか、その上でブロックした呼び出し箇所であり、まさに戻した途端に自明に正しくなるコードです。それぞれを書き留めておきます。回避策はステップ 4 で削除します。**検証:** ビルドが完了し、CA2012 のヒットの書面リストが手元にある (多くの場合ゼロであり、それ自体が有用な情報です)。

2. **宣言を変更する。** 戻り値型を入れ替えます。メソッド本体は通常、具現化された値を返す各 `return` ごとに 1 か所の編集を要します。

   ```csharp
   // Before: .NET 11, C# 14
   public ValueTask<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return new ValueTask<User>(user);          // synchronous fast path

       return new ValueTask<User>(LoadFromDbAsync(id)); // wraps a Task
   }

   // After: .NET 11, C# 14
   public Task<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return Task.FromResult(user);              // synchronous fast path

       return LoadFromDbAsync(id);                     // already a Task<User>
   }
   ```

   `async` キーワードを持つメソッドでは、変更はシグネチャだけです。残りはコンパイラーが書き換えます。

   ```csharp
   // Before
   public async ValueTask<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }

   // After: only the return type changed
   public async Task<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }
   ```

   **検証:** プロジェクトがコンパイルできる。`async` キーワード形式はこれ以上の編集を要しません。手書き形式は、各 `new ValueTask<T>(...)` を `Task.FromResult(...)` に書き換えるか、内部の `Task` を直接返す必要があります。

3. **インターフェースと基底クラスの宣言を一緒に更新する。** メソッドが契約に由来する場合は、契約とすべての実装側を同じパスで変更します。さもないとビルドが中途半端に壊れます。

   ```csharp
   // Before
   public interface IUserRepository
   {
       ValueTask<User> GetUserAsync(int id);
   }

   // After
   public interface IUserRepository
   {
       Task<User> GetUserAsync(int id);
   }
   ```

   **検証:** 1 つのプロジェクトだけでなく、ソリューション全体で `dotnet build` を実行する。見落とした実装は `CS0535` (インターフェースメンバーを実装していない) または `CS0508` (オーバーライドでの戻り値型の不一致) として現れます。

4. **`.AsTask()` の回避策と二重 await の修正を削除する。** ここで戻しが報われます。呼び出し側が `ValueTask` の単一 await ルールに対して防御していた箇所はどこでも、その防御は今やデッドコードです。

   ```csharp
   // Before: caller had to convert because it awaited twice / fanned out
   ValueTask<User> vt = repo.GetUserAsync(id);
   Task<User> safe = vt.AsTask();        // required for ValueTask
   var a = await safe;
   var b = await safe;

   // After: Task is awaitable repeatedly; no conversion needed
   Task<User> t = repo.GetUserAsync(id);
   var a = await t;
   var b = await t;
   ```

   `Task.WhenAll` と `Task.WhenAny` は今や結果を直接取ります。

   ```csharp
   // Before: each ValueTask needed .AsTask() before combining
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id).AsTask()));

   // After
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id)));
   ```

   **検証:** ステップ 1 の CA2012 警告がすべて消え、警告の数と少なくとも同じだけの `.AsTask()` 呼び出しを削除した。

5. **`IValueTaskSource<T>` の配管を置き換える。** メソッドが、カスタムの `IValueTaskSource<T>` を裏付けとするプール化された `ValueTask<T>` を返していた場合 (`ManualResetValueTaskSourceCore<T>` が可能にするパターン)、そのまま差し替えられるものはありません。プーリングを手放すのですから、代わりに `TaskCompletionSource<T>` を使い、再導入を選んだそのアロケーションを受け入れてください。

   ```csharp
   // After: a Task source replaces the pooled IValueTaskSource<T>
   private readonly TaskCompletionSource<int> _tcs =
       new(TaskCreationOptions.RunContinuationsAsynchronously);

   public Task<int> WaitForValueAsync() => _tcs.Task;

   public void Complete(int value) => _tcs.TrySetResult(value);
   ```

   `RunContinuationsAsynchronously` フラグは重要です。これがないと `TrySetResult` は完了スレッド上でインラインに継続を実行し、同期ブロックと同じようにデッドロックを起こしたりスレッドプールを枯渇させたりしかねません。これは戻すことが実際に何かを犠牲にする唯一のステップなので、プーリングがベンチマークで正当化されたことが一度もない場合にのみ行ってください。**検証:** 型が `IValueTaskSource<T>` を実装しなくなり、操作を数千回完了させるストレステストが、再入の問題なく依然として通る。

## 入れ替え後の検証

移行を完了とみなす前に、このチェックリストを端から端まで実行します。

- `dotnet build` が CA2012 を `warning` にした状態でクリーンであり、ヒットがゼロ。
- `dotnet test` が新たな失敗なく通る。特に、以前は待機可能オブジェクトをキャッシュしていたコードの周辺で。
- 事前準備で取った `[MemoryDiagnoser]` 付き `BenchmarkDotNet` の実行が、期待どおりのアロケーション差分を示す。同期完了するホットパスが今では呼び出しごとに 1 つの `Task<T>` (64 ビットで 24 バイト) を確保し、そのパスが毎秒数百万回実行されるなら、`ValueTask` がその場所に値していて戻したのは誤りだったという証拠になります。数字が横ばいなら、戻しは正しさを無料で手に入れたということです。
- 見落とした `new ValueTask`、`.AsTask()`、`ValueTask<` が残っていないか、diff を grep します。

## ロールバック計画

この移行はソースコードレベルで完全に可逆であり、元に戻すリスクも低いです。`Task<T>` を `ValueTask<T>` に戻すのは、同じ機械的な編集を逆向きに行うだけです。唯一の注意点は公開 API のケースです。`Task<T>` 版をリリース済みの NuGet パッケージで出荷していた場合、`ValueTask<T>` に戻すのはもう 1 つのバイナリ破壊的変更であり、外部の利用者は二度リコンパイルすることになります。内部コードにはその制約はありません。移行はブランチに留め、ベンチマークが悪化したと示したらコミットを戻してください。

## 私たちがぶつかった落とし穴

**`Task.FromResult` は、いずれにせよ確保する参照型に対しては無料ではない。** `Task.FromResult(value)` は、任意の値に対して依然として `Task<T>` を確保します。ランタイムは `Task.FromResult(true)`、`false`、小さな整数についてはタスクをキャッシュしますが、あなたの `User` についてはしません。メソッドが今では同期完了することがまれだからこそ戻しているのなら、これは問題になりません。依然としてほとんどの場合に同期完了するなら、そのアロケーションこそが `ValueTask` が避けていたものです。戻しが無害だと仮定する前に測定してください。

**同期本体の上の `async` はステートマシンを再導入する。** `return new ValueTask<T>(cachedValue)` を `cachedValue` を返す `async` メソッドに書き換えると、`Task<T>` の上にステートマシンのアロケーションが加わります。ファストパスは `async` なしに保ってください。ステップ 2 のとおり、素のメソッドから `Task.FromResult(...)` を返します。[ConfigureAwait が .NET 11 でも依然として重要である](/2026/05/configureawait-false-vs-default-in-dotnet-11/)のと同じ理屈がここにも当てはまります。最も安い非同期パスは、ステートマシンを一切構築しないものです。

**キャンセルのセマンティクスは変わらないが、それでも検証する。** `Task<T>` も `ValueTask<T>` も、キャンセルを失敗/キャンセル済みの待機可能オブジェクトとして公開します。戻しても `CancellationToken` の流れ方は変わりません。それでも、書き換えはすべての return 文に触れるので、キャンセルのパスを再テストしてください。キャンセル処理がもともと脆かったなら、[デッドロックなしで長時間実行 Task をキャンセルする方法](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)を参照してください。

**`IAsyncEnumerable<T>` は `ValueTask` を残すべき唯一の場所。** `IAsyncEnumerator<T>.MoveNextAsync` は設計上 `ValueTask<bool>` を返し、`DisposeAsync` は `ValueTask` を返します。これらは「戻さない」でください。async ストリームの仕組みは、裏付けソースを反復間で再利用するように作られており、まさに `ValueTask` が報われる教科書的なケースです。ストリームを扱っているなら、[EF Core 11 で IAsyncEnumerable<T> を使う](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)が文脈の中でそのパターンを示しています。

**Fire-and-forget が二重消費を隠していた。** 戻す際に見つけたパターン: `ValueTask` がフィールドに代入され、後で観測されていました。これは不正であり、負荷の下で結果を静かに破損させていました。`Task<T>` への変更でそれは合法になりましたが、正しい修正は fire-and-forget をそもそもやめることでした。これを見かけたら、型の変更で覆い隠す前に[fire-and-forget の作業を安全に実行する方法](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/)を読み、同じ fire-and-forget パターンが生みがちな[破棄済みコンテキストでの ObjectDisposedException](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/)に注意してください。

正直な要約: `ValueTask<T>` を `Task<T>` に戻すことは、プロファイラーを手にせずに構造体を採用したコードにとって正しい既定です。おそらく得られてもいなかったマイクロ最適化を、チーム全員がルールのリストを読まずに使える型と引き換えにするのです。`ValueTask` は、データがその場所に値すると示すところ (同期完了のホットパスと async ストリーム) にだけ残し、それ以外はすべて `Task<T>` に担わせてください。

## 出典

- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)

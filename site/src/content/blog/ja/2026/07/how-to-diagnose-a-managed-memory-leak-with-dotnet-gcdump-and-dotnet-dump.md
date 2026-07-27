---
title: "dotnet-gcdump と dotnet-dump でマネージドメモリリークを診断する方法"
description: ".NET 11 でマネージドメモリリークを見つけるための完全な手順です。dotnet-counters で増加を確認し、gcdump を 2 回取得して差分を見て、その後ダンプを収集して dotnet-dump analyze の dumpheap、gcroot、objsize で参照を保持しているものを突き止めます。"
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "diagnostics"
  - "memory"
  - "performance"
lang: "ja"
translationOf: "2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump"
translatedBy: "claude"
translationDate: 2026-07-27
---

.NET でマネージドメモリリークを診断するには、まず `dotnet-counters monitor` で増加が本物であることを確認し、次に `dotnet-gcdump collect` のスナップショットを数分間隔で 2 回取得してどの型の数が増えているかを確認し、そのうえで `dotnet-dump collect` を取得して `dotnet-dump analyze` の中で `dumpheap -stat`、`dumpheap -type <Name>`、`gcroot <address>` を実行し、それらのオブジェクトを生かし続けている参照のチェーンを見つけます。gcdump はほとんどオーバーヘッドなしで *何が* 増えているかを教えてくれ、ダンプは *誰が保持しているか* を教えてくれます。この順番で両方が必要です。この記事では .NET 11 (執筆時点では Preview 6、GA は 2026 年 11 月) に対して `dotnet-gcdump` と `dotnet-dump` の 10.0 を使いますが、ここに出てくるコマンドはすべて .NET Core 3.1 以降で安定しています。

## GC がここで助けてくれない理由

マネージドメモリリークは C 言語の意味でのリークではありません。解放されていないものは何もありません。ガベージコレクションは設計どおりに動作しています。ルートから到達可能なオブジェクトは回収されませんし、あなたのコードが数十万個のオブジェクトを誤って到達可能にしてしまったのです。ルートとは、静的フィールド、どこかのスレッドのスタック上で生きているローカル変数や引数、強い GC ハンドル、あるいはファイナライザーキューです。それ以外はすべて、そこから推移的に到達可能になっています。

つまり診断の問いは「なぜ GC が動かないのか」ではありません。「どのルートのチェーンがまだこのオブジェクトを指しているのか」です。以下のツールはすべて、その 1 つの問いに答えるために存在します。ASP.NET Core アプリでの典型的な原因は次のとおりです。

- 増える一方の静的コレクションまたはシングルトンのコレクション。退避のないキャッシュとして使われている `ConcurrentDictionary`、「最近のリクエスト」を保持する `List<T>` など。
- 解除されないイベントの購読。発行側がデリゲートを保持し、デリゲートが購読側を保持するので、発行側がシングルトンや静的フィールドであれば、すべての購読側が永久に生き続けます。
- シングルトンに捕捉されたスコープ付きサービス。スコープのオブジェクトグラフ全体を一緒に引きずります。これはたいてい最初に [破棄済み DbContext に対する ObjectDisposedException](/ja/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) として現れます。この捕捉は同時に [シングルトンからスコープ付きサービスを取得するライフタイムのバグ](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) でもあるからです。
- 大きなオブジェクトグラフをキャプチャするコールバックを持つ `Timer` や、長寿命の `CancellationTokenSource` の登録。

## ステップ 0: 本当にリークがあることを証明する

マネージドヒープが時間とともに増えていくのを確認するまでは、何も収集しないでください。ワーキングセットの増加だけではマネージドリークとは言えません。ネイティブの割り当てかもしれませんし、断片化かもしれませんし、単に何も圧力をかけていないので GC が OS にメモリを返していないだけかもしれません。

ツールを一度インストールして PID を調べます。

```bash
# Verified with the .NET 11 SDK, July 2026
dotnet tool install --global dotnet-counters
dotnet tool install --global dotnet-gcdump
dotnet tool install --global dotnet-dump

dotnet-counters ps
# 4807  MyApi  /srv/myapi/MyApi
```

そして、プロセスではなくヒープを観察します。

```bash
dotnet-counters monitor --refresh-interval 5 --process-id 4807 \
  --counters System.Runtime[dotnet.gc.last_collection.heap.size,dotnet.process.memory.working_set]
```

.NET 9 以降では `System.Runtime` は `Meter` であり、カウンター名は上記のような OpenTelemetry スタイルになります。.NET 8 以前では `dotnet-counters` は従来の EventCounters にフォールバックするので、代わりに `GC Heap Size (MB)` を見てください。

重要なのは世代別に分解された `dotnet.gc.last_collection.heap.size` です。2 回の測定で、何を相手にしているかが分かります。

- **コレクションをまたいで gen2 が単調に増加している**: 本物のマネージドリークです。オブジェクトが最も古い世代まで生き残り、決して死にません。この記事を読み進めてください。
- **gen0/gen1 は激しく回転しているが gen2 は横ばいで、ワーキングセットは大きい**: リークではありません。割り当ての圧力か断片化です。代わりに [gc-verbose プロファイルを使った dotnet-trace](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) で割り当てのホットスポットを探してください。
- **ヒープサイズは横ばいなのにワーキングセットが増えている**: リークはネイティブ側です。gcdump も SOS も有用な情報は出しません。ネイティブ相互運用、`SafeHandle` の寿命、あるいはコミットされたまま解放されない LOH を確認してください。

## リークする最小の再現コード

両方のツールで見つけられる形でリークする、最小の ASP.NET Core サービスです。あるシングルトンが別のシングルトンのイベントを購読し、決して購読を解除しません。

```csharp
// .NET 11, C# 14
public sealed class TelemetryBus
{
    public event EventHandler<string>? MetricRecorded;
    public void Record(string metric) => MetricRecorded?.Invoke(this, metric);
}

public sealed class ReportSession
{
    private readonly byte[] _buffer = new byte[64 * 1024];
    private readonly List<string> _log = [];

    public ReportSession(TelemetryBus bus)
    {
        // Nothing ever removes this handler, so `bus` roots every ReportSession
        // ever created, and each one roots 64 KB plus a growing List<string>.
        bus.MetricRecorded += OnMetric;
    }

    private void OnMetric(object? sender, string metric) => _log.Add(metric);
}

app.MapPost("/reports", (TelemetryBus bus) =>
{
    _ = new ReportSession(bus);   // per-request, never released
    return Results.Accepted();
});
```

`TelemetryBus` はシングルトンなので、その呼び出しリストはプロセスが生きている間ずっとルートに保持されます。すべての `ReportSession` はそのデリゲートから到達可能であり、したがってすべての `byte[64*1024]` も到達可能です。`/reports` に負荷をかけると、gen2 のヒープは永遠に増え続けます。

## 手順の全体

1. **マネージドヒープが増えていることを確認します**。`dotnet-counters monitor --counters System.Runtime[dotnet.gc.last_collection.heap.size]` を実行し、特に gen2 を見ます。
2. **基準となる gcdump を取得します**。`dotnet-gcdump collect --process-id <PID> --output baseline.gcdump` を実行します。
3. **アプリを負荷のもとで動かし続けます**。リークが明白になるだけの時間、通常は 5 分から 15 分です。
4. **2 回目の gcdump を取得します**。`dotnet-gcdump collect --process-id <PID> --output after.gcdump` を実行し、2 つの型ごとの個数を比較して増えている型を見つけます。
5. **完全なダンプを収集します**。何を探すべきか分かったら `dotnet-dump collect --process-id <PID> --type Heap --output leak.dmp` を実行します。
6. **ダンプを開きます**。`dotnet-dump analyze leak.dmp` を実行し、`dumpheap -stat` または `dumpheap -type <TypeName> -stat` で型を確認します。
7. **インスタンスのアドレスを 1 つ取得します**。`dumpheap -type <TypeName>` の出力から取り、`gcroot <address>` を実行してルートからそのオブジェクトまでの参照チェーンを出力します。
8. **オブジェクトではなくチェーンを修正します**。`gcroot` の出力であなたの型の直前にあるホップが、参照を保持している当のものです。

## ステップ 2 から 4: gcdump という安価な最初の一手

`dotnet-gcdump` はプロセスダンプを書き出しません。gen2 のコレクションを誘発し、GC のヒープ生存イベントを有効にして、[EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe) のストリームからオブジェクトグラフを再構築します。結果として得られる `.gcdump` ファイルには型、個数、サイズ、辺が含まれますが、フィールドの値もスレッドのスタックも含まれません。同じプロセスの完全なダンプが数百 MB になるところ、通常は 1 桁 MB で済みます。

```bash
dotnet-gcdump collect --process-id 4807 --output baseline.gcdump
# Writing gcdump to './baseline.gcdump'...
#     Finished writing 5763432 bytes.

# ... let it run under load ...

dotnet-gcdump collect --process-id 4807 --output after.gcdump
```

比較に GUI は必要ありません。`report` 動詞はヒープ統計のテーブルを標準出力に直接出力するので、`.gcdump` ファイルを開く手段が何もない Linux でも使えます。

```bash
dotnet-gcdump report ./after.gcdump
#           Size (Bytes) Count       Type
#         ============== =====       ====
#          1,603,588,000 22,000,000  System.String
#            201,096,000  2,010,000  System.Byte[]
#             25,000,000    250,000  MyApi.Reports.ReportSession
```

両方のファイルに対して `report` を実行し、個数を比較してください。Windows であれば 2 つの `.gcdump` ファイルを Visual Studio で同時に開き、差分列付きの本格的な並列比較ビューを使えます。Windows マシンが手元にあるなら、その手間をかける価値はあります。PerfView でも読めます。現時点で Linux や macOS で `.gcdump` を開く方法はないので、そこでは `dotnet-gcdump report` が唯一の選択肢です。

`report` は `--process-id` を直接受け取ることもできます。ファイルが不要なら、収集と表示を一度に済ませられます。

```bash
dotnet-gcdump report --process-id 4807
```

このステップが終わった時点で、型名が 1 つ手に入っているはずです。gcdump が提供してくれるのはそこまでです。

## ステップ 5 から 7: ルートを見つける dotnet-dump

gcdump は、どの *オブジェクト* のどの *フィールド* が参照を保持しているかを教えてくれませんし、スレッドのスタックも見せてくれません。それには本物のダンプと SOS が必要です。

```bash
dotnet-dump collect --process-id 4807 --type Heap --output leak.dmp
```

`--type` の既定値は `Full` で、マップされたモジュールイメージまで含むため、たいていは必要以上に大きくなります。`Heap` ならモジュール一覧、スレッド一覧、すべてのスタック、例外情報とハンドル情報、そしてマップされたイメージ以外のすべてのメモリが得られ、この作業に必要なものはすべて揃います。`Mini` はクラッシュのトリアージ専用です。GC ヒープは含まれません。

続いて対話型の SOS シェルを開きます。

```bash
dotnet-dump analyze leak.dmp
```

まずは統計ビューから始めます。`-live` を付けると GC のマークフェーズが使われ、すでにガベージだがまだ回収されていないオブジェクトが除外されるので、ノイズが大きく減ります。

```console
> dumpheap -stat -live

Statistics:
              MT    Count    TotalSize Class Name
00007f6c1dc014c0      467       416464 System.Byte[]
00007f6c20a67498   250000     16000000 MyApi.Reports.ReportSession
00007f6c1dc00f90   206770     19494060 System.String
```

同じコマンドの便利なバリエーションです。

- `dumpheap -stat -bycount` は合計サイズではなくインスタンス数で並べ替えます。バイト数の合計では隠れてしまう「小さなオブジェクトが 100 万個」型のリークを浮かび上がらせます。
- `dumpheap -type MyApi.Reports -stat` は型名の部分文字列でフィルタリングします。テーブルを 1 つの名前空間に絞り、フレームワークのノイズを無視できます。
- `dumpheap -gen loh -stat` はラージオブジェクトヒープに限定します。`gen0`、`gen1`、`gen2`、`loh`、`poh`、`foh` を受け付けます。
- `dumpheap -min 100000 -stat` は 100,000 バイト未満をすべて無視します。

次に具体的なアドレスを 1 つ取得して、そのルートをたどります。

```console
> dumpheap -type MyApi.Reports.ReportSession
         Address               MT     Size
00007f6ad09421f8 00007f6c20a67498       32
...

> gcroot 00007f6ad09421f8

HandleTable:
    00007F6C98BB15F8 (pinned handle)
    -> 00007F6BDFFFF038 System.Object[]
    -> 00007F69D0033570 MyApi.Telemetry.TelemetryBus
    -> 00007F69D0033588 System.EventHandler`1[[System.String, System.Private.CoreLib]]
    -> 00007F69D00335A0 System.Object[]
    -> 00007F6AD0942258 MyApi.Reports.ReportSession

Found 1 root.
```

このチェーンは下から上へ読みます。リークしているオブジェクトが一番下、ルートが一番上です。あなたの型のすぐ上のホップが犯人であり、ここでは疑いようがありません。呼び出しリスト (`System.Object[]`) がすべてのセッションを保持している `EventHandler<string>` のマルチキャストデリゲートです。これは `-=` の対になっていない `bus.MetricRecorded += OnMetric` の行に直接対応します。

`gcroot` は既定では一意なルートだけを出力します。すべての経路が欲しいときは `-all` を、古いレジスタ値によるスタックスキャンの誤検出が出ているときは検索をハンドルと到達可能なオブジェクトに限定する `-nostacks` を渡してください。

この段階で知っておく価値のあるコマンドがあと 2 つあります。`objsize <address>` は、あるオブジェクトが推移的に保持しているものすべてを含めた保持サイズを報告します。「これは 32 バイトだ」を「これは 68 KB を生かし続けている」に変えてくれるのがこれです。そして `dumpobj <address>` はフィールドごとのレイアウトを出力するので、保持側のどのフィールドがこちらを指しているのかを確認できます。

```console
> dumpobj 00007F69D0033570
Name:        MyApi.Telemetry.TelemetryBus
MethodTable: 00007f6c20a67498
Size:        24(0x18) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007f6c1dc00f90  4000001        8 ...EventHandler`1  0 instance 00007F69D0033588 MetricRecorded
```

## 半日を無駄にしがちな落とし穴

**gcdump は完全なブロッキング gen2 コレクションを引き起こします。** それがヒープを走査する仕組みだからです。ヒープが大きいプロセスでは、ランタイムが長時間停止することがあります。レイテンシに敏感な本番インスタンスに対して短い間隔で繰り返し実行しないでください。実行するときはメトリクスに目に見えるポーズのスパイクが出ることを覚悟してください。

**巨大なヒープでは gcdump が黙って失敗することがあります。** イベントバッファは対象アプリケーション側が所有し、最大 256 MB まで拡張されます。ヒープが十分に大きくてイベントが落ちると、`System.ApplicationException: ETL file shows the start of a heap dump but not its completion` が出るか、ヒープの一部しか含まない `.gcdump` が黙って生成されます。そうなったら gcdump は諦めて、直接 `dotnet-dump collect` に進んでください。

**どちらのツールも同じユーザーと同じ `TMPDIR` を必要とします。** Linux と macOS では、`--process-id` と `--name` はランタイムが `TMPDIR` 配下に作成する Unix ドメインソケットに接続することで動作します。ツールが別のユーザーで動いていたり、別の `TMPDIR` の下で動いていたりすると、コマンドは有用なエラーを出さないまま 30 秒でタイムアウトするだけです。対象プロセスと同じユーザー、または root で実行してください。

**コンテナーでは `ptrace` が必要です。** `dotnet-dump collect` には `ptrace` の権限が必要で、通常は `--cap-add=SYS_PTRACE` で付与します。それとは別に、ヒープダンプや完全なダンプの収集は対象プロセスの大量の仮想メモリを OS にページインさせるため、メモリ制限のあるコンテナーが cgroup の上限を超え、収集の途中で OOM により停止させられることがあります。プラットフォームが許すなら、制限を引き上げるか一時的に外してください。

**`Free` の行はオブジェクトではありません。** `dumpheap -stat` で `Free` の数が多いのは断片化であって、リークではありません。GC が圧縮していない生存オブジェクト間の隙間で、たいていは LOH 上にあります。別の問題であり、対処も別です (プーリング、`ArrayPool<T>`、`GCSettings.LargeObjectHeapCompactionMode` など)。

**キャッシュ型のリークは、コードのバグではなく設定のバグかもしれません。** 増えている型が `IMemoryCache` の中に入っている自作の DTO なら、その「リーク」はたいてい暴走した参照ではなく、サイズ上限や有効期限ポリシーの設定漏れです。その判断はデバッガーではなく [HybridCache と IMemoryCache と IDistributedCache の比較](/ja/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) の領域です。

**自分のコードを疑う前にファイナライザーキューを確認してください。** 解析シェルの `finalizequeue` は、ファイナライズ用に登録されたオブジェクトを一覧表示します。キューが詰まっているということは、ファイナライズ可能なオブジェクトが gen2 に昇格し、余分に 1 回分のコレクションサイクルのあいだ保持されているということで、グラフ上ではまさに緩やかなリークのように見えます。この場合の対処はほぼ常に確定的な破棄であり、それこそが [IAsyncDisposable の実装と await using の利用](/ja/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) の目的です。

**非同期ステートマシンは自分のルートを隠します。** 増えている型が `<SomeMethod>d__12` のようなコンパイラー生成の構造体なら、`gcroot` ではなく `dumpasync -roots` を使ってください。継続のチェーンを理解しているので、どの待機中のタスクがステートマシンを保持しているかを示してくれます。素の `gcroot` の走査では、これは `Task` と `Action` のオブジェクトが積み重なった読めない出力になってしまいます。

## 答えが出たあとにすること

`gcroot` が保持側を名指ししたら、あとの修正はごく普通のコードです。`Dispose` で購読を解除する。キャッシュにサイズ上限と有効期限を設定する。スコープ付きサービスをシングルトンに捕捉するのをやめ、代わりに [BackgroundService の中で作業単位ごとにスコープを作成する](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)。そのあとでステップ 1 から 4 を繰り返します。負荷をかけて動かし、gcdump を 2 回取り、その型の個数が横ばいであることを確認します。リークが直ったと言えるのは、2 回目の gcdump がそれを証明したときだけです。

参考資料: [dotnet-gcdump リファレンス](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-gcdump)、[dotnet-dump リファレンス](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dump)、[メモリリークのデバッグチュートリアル](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-memory-leak)、[SOS デバッグ拡張機能](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/sos-debugging-extension)、[dotnet-counters リファレンス](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-counters)。

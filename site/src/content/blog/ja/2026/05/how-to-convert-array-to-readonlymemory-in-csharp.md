---
title: "C# で T[] を ReadOnlyMemory<T> に変換する方法 (暗黙の演算子と明示的なコンストラクター)"
description: ".NET 11 で T[] を ReadOnlyMemory<T> にラップする 3 つの方法。暗黙の変換、明示的なコンストラクター、AsMemory()。それぞれが正解となる場面を解説します。"
pubDate: 2026-05-04
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
template: "how-to"
lang: "ja"
translationOf: "2026/05/how-to-convert-array-to-readonlymemory-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-04
---

既存の配列に対して `ReadOnlyMemory<T>` のビューが欲しいだけなら、最短の方法は暗黙の変換です。`ReadOnlyMemory<byte> rom = bytes;` と書きます。スライスが必要であれば `bytes.AsMemory(start, length)` または `new ReadOnlyMemory<byte>(bytes, start, length)` を選びます。3 つともゼロアロケーションですが、オフセットと長さを受け取れるのはコンストラクターと `AsMemory` だけで、呼び出し位置で変換が明示されるのはコンストラクターだけです (これはコードレビューで効いてきます)。

この記事で参照しているバージョン: .NET 11 (ランタイム)、C# 14。最新の .NET では `System.Memory` が `System.Runtime` の一部として出荷されているため、追加のパッケージは不要です。

## 変換経路が 1 つではない理由

`ReadOnlyMemory<T>` は .NET Core 2.1 から BCL に含まれています (.NET Standard 2.0 では `System.Memory` NuGet パッケージとして提供)。Microsoft が複数のエントリーポイントを意図的に追加したのには理由があります。90% のケースで摩擦のないものを 1 つ、変換を明示する必要があるコード向けの明示的なコンストラクターを 1 つ、そして `AsSpan()` をミラーした拡張メソッドを 1 つ用意することで、span と memory の間をコンテキストスイッチなしに頭の中で切り替えられるようにしたのです。

具体的には、BCL は次のものを公開しています。

1. `T[]` から `Memory<T>` への暗黙の変換、および `T[]` から `ReadOnlyMemory<T>` への暗黙の変換。
2. `Memory<T>` から `ReadOnlyMemory<T>` への暗黙の変換。
3. コンストラクター `new ReadOnlyMemory<T>(T[])` と、スライス用のオーバーロード `new ReadOnlyMemory<T>(T[] array, int start, int length)`。
4. `MemoryExtensions` で定義されている拡張メソッド `AsMemory<T>(this T[])`、`AsMemory<T>(this T[], int start)`、`AsMemory<T>(this T[], int start, int length)`、`AsMemory<T>(this T[], Range)`。

すべての経路はアロケーションフリーです。選択は主にスタイルの問題ですが、本質的な違いが 2 つあります。スライスを受け付けるのはコンストラクターと `AsMemory` だけであること、そして呼び出し側が何も書かずに `T[]` の引数を `ReadOnlyMemory<T>` のパラメーターに渡せるのは暗黙の変換だけであること、です。

## 最小の例

```csharp
// .NET 11, C# 14
using System;

byte[] payload = "hello"u8.ToArray();

// Path 1: implicit operator
ReadOnlyMemory<byte> a = payload;

// Path 2: explicit constructor, full array
ReadOnlyMemory<byte> b = new ReadOnlyMemory<byte>(payload);

// Path 3: explicit constructor, slice
ReadOnlyMemory<byte> c = new ReadOnlyMemory<byte>(payload, start: 1, length: 3);

// Path 4: AsMemory extension, full array
ReadOnlyMemory<byte> d = payload.AsMemory();

// Path 5: AsMemory extension, slice with start + length
ReadOnlyMemory<byte> e = payload.AsMemory(start: 1, length: 3);

// Path 6: AsMemory extension, range
ReadOnlyMemory<byte> f = payload.AsMemory(1..4);
```

6 つすべてが、同じバッキング配列を指す `ReadOnlyMemory<byte>` のインスタンスを生成します。どれも配列をコピーしません。コストは小さな構造体のコピーであってバッファのコピーではないため、6 つすべてがタイトループ内でも安全に使えます。

## 暗黙の演算子が正解となる場面

`T[]` から `ReadOnlyMemory<T>` への暗黙の変換は、変換先の型がすでに `ReadOnlyMemory<T>` のパラメーターになっている呼び出し位置で最もきれいに収まります。

```csharp
// .NET 11
public Task WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
{
    // ...
    return Task.CompletedTask;
}

byte[] payload = GetPayload();
await WriteAsync(payload); // implicit conversion happens here
```

`payload.AsMemory()` も `new ReadOnlyMemory<byte>(payload)` も書きません。コンパイラーが変換を生成してくれます。これが効いてくる点が 2 つあります。ホットなコードで呼び出し位置が読みやすいまま保てること、そして API 側が `ReadOnlyMemory<T>` を受け取れるようになり、すべての呼び出し側に新しい型を学ばせる必要がないことです。

トレードオフは、変換が見えなくなることです。コードレビュアーに「このコードは配列ではなく `ReadOnlyMemory<T>` のビューを渡すようになった」と気づかせたい場合、暗黙の演算子はそれを隠してしまいます。

## コンストラクターの冗長さに価値がある場面

`new ReadOnlyMemory<byte>(payload, start, length)` は明示的な形式です。次の 3 つの状況で使います。

1. **オフセットと長さを伴うスライスが必要なとき。** 暗黙の変換は常に配列全体を対象にします。
2. **呼び出し位置で変換を見えるようにしたいとき。** `private ReadOnlyMemory<byte> _buffer;` のようなフィールドをコンストラクターで初期化していれば、暗黙の演算子よりも grep しやすくなります。
3. **オフセットと長さの境界チェックを構築時に一度だけ行わせたいとき。** どの経路も最終的には境界チェックを行いますが、コンストラクターは `start` と `length` をパラメーターとして受け取り、それらが配列の範囲外であれば、コンシューマーがメモリーに触れる前にすぐに `ArgumentOutOfRangeException` をスローします。

```csharp
// .NET 11
byte[] frame = ReceiveFrame();
const int headerLength = 16;

// Skip the header. Bounds-checked here, not when the consumer reads.
var payload = new ReadOnlyMemory<byte>(frame, headerLength, frame.Length - headerLength);

await ProcessAsync(payload);
```

`frame.Length < headerLength` の場合、`ArgumentOutOfRangeException` は構築位置でスローされます。この時点ではローカル変数がまだスコープ内にあり、デバッガーで `frame.Length` の実際の値を確認できます。スライス処理を `ProcessAsync` まで遅延させると、この局所性が失われ、最終的にスライスが具体化されたどこかで失敗が現れることになります。

## 代わりに `AsMemory()` を使うべき場面

`AsMemory()` はコンストラクターと同じものですが、人間工学的な利点が 2 つあります。左から右に読めること (`new ReadOnlyMemory<byte>(payload, 1, 3)` ではなく `payload.AsMemory(1, 3)`)、そして `Range` のオーバーロードを持っていることです。これにより C# のスライス構文が使えます。

```csharp
// .NET 11, C# 14
byte[] payload = GetPayload();
const int headerLength = 16;

ReadOnlyMemory<byte> body = payload.AsMemory(headerLength..);
ReadOnlyMemory<byte> first16 = payload.AsMemory(..headerLength);
ReadOnlyMemory<byte> middle = payload.AsMemory(8..24);
```

`AsMemory(Range)` は `Memory<T>` を返し、ここでの `ReadOnlyMemory<T>` へのキャストは `Memory<T>` から `ReadOnlyMemory<T>` への暗黙の変換を経由します。これもアロケーションフリーです。

すでに `AsSpan()` (`Span<T>` 用の同じパターン) を頭の中に染み込ませているなら、`AsMemory()` はその習慣を `await` をまたいで生き延びさせる版です。

## `null` 配列の場合の挙動

`null` 配列を暗黙の変換や `AsMemory()` に渡してもスローされません。デフォルトの `ReadOnlyMemory<T>` が生成され、これは意味的には `ReadOnlyMemory<T>.Empty` と同等です (`IsEmpty == true`、`Length == 0`)。

```csharp
// .NET 11
byte[]? maybeNull = null;

ReadOnlyMemory<byte> a = maybeNull;            // default, not a NullReferenceException
ReadOnlyMemory<byte> b = maybeNull.AsMemory(); // also default
// new ReadOnlyMemory<byte>(maybeNull) also returns default
```

引数 1 つのコンストラクター `new ReadOnlyMemory<T>(T[]? array)` はこの動作を明示的にドキュメント化しています。null 参照は default 値の `ReadOnlyMemory<T>` を生成します。引数 3 つの `new ReadOnlyMemory<T>(T[]? array, int start, int length)` は、配列が null で start や length にゼロ以外を指定した場合は `ArgumentNullException` をスローします。`null` に対して境界条件を満たすことができないからです。

この `null` 許容は省略可能なペイロードには便利ですが、足を撃つ罠でもあります。`null` を渡した呼び出し側はクラッシュではなく空のバッファをサイレントに受け取ることになり、上流のバグを覆い隠してしまう可能性があります。メソッドが配列の非 null に依存しているなら、ラップする前に検証してください。

## 結果のスライスもコストフリー

`ReadOnlyMemory<T>` を一度手にすれば、`.Slice(start, length)` を呼び出すと、同じバッキングストレージに対する別の `ReadOnlyMemory<T>` が生成されます。2 度目のコピーも 2 度目のアロケーションも発生しません。

```csharp
// .NET 11
ReadOnlyMemory<byte> all = payload.AsMemory();

ReadOnlyMemory<byte> head = all.Slice(0, 16);
ReadOnlyMemory<byte> body = all.Slice(16);
```

`ReadOnlyMemory<T>` 構造体は、元の `T[]` (または `MemoryManager<T>`) への参照、ストレージ内のオフセット、そして長さを保持します。スライス操作は調整されたオフセットと長さを持つ新しい構造体を返すだけです。これが、上記の 6 つの変換経路すべてがタイトループでも安全に使える理由です。コストはバッファのコピーではなく構造体のコピーだからです。

## `ReadOnlyMemory<T>` から `Span<T>` に戻す

同期メソッドの中では、通常は memory ではなく span が欲しくなります。

```csharp
// .NET 11
public int CountZeroBytes(ReadOnlyMemory<byte> data)
{
    ReadOnlySpan<byte> span = data.Span; // allocation-free
    int count = 0;
    foreach (byte b in span)
    {
        if (b == 0) count++;
    }
    return count;
}
```

`.Span` は `ReadOnlyMemory<T>` のプロパティで、同じメモリーに対する `ReadOnlySpan<T>` を返します。内側のループには span を使い、フィールドや `await` をまたぐ場面には memory を保持します。逆方向 (span から memory への変換) は意図的に提供されていません。span はスタックに置かれることがあり、`Memory<T>` はそこに到達できないためです。

## できないこと (および回避策)

`ReadOnlyMemory<T>` は公開 API の範囲では本当に読み取り専用です。基になる可変の `Memory<T>` を返す公開の `ToMemory()` は存在しません。エスケープハッチは `MemoryMarshal` にあります。

```csharp
// .NET 11
using System.Runtime.InteropServices;

ReadOnlyMemory<byte> ro = payload.AsMemory();
Memory<byte> rw = MemoryMarshal.AsMemory(ro);
```

これは「型システムが何かを伝えていた」という意味で安全ではありません。たとえばユニットテスト内や、バッファを末端まで所有しているコード内など、いま破ろうとしている読み取り専用の契約に他のコンシューマーが依存していないと確信できる場合にのみ使ってください。

`ReadOnlyMemory<T>` はまた、配列変換経路を通じて `string` を指すこともできません。`string.AsMemory()` は文字列自体をラップする `ReadOnlyMemory<char>` を返すのであって、`T[]` をラップするわけではありません。上で扱った `T[]` からの変換経路は文字列には適用されませんが、API のその他の部分 (スライス、`Span`、等値性) は同じように振る舞います。

## コードベースで 1 つ選ぶ

.NET 11 のコードベースにおける合理的なデフォルト。

- **API のシグネチャ**: `ReadOnlyMemory<T>` を受け取ります。`T[]` を持つ呼び出し側はそのまま渡せ (暗黙の演算子)、スライスを持つ呼び出し側は `array.AsMemory(start, length)` を渡します。失うものはありません。
- **配列全体を渡す呼び出し位置**: 暗黙の変換を使い、`.AsMemory()` は書きません。ノイズになります。
- **スライスを渡す呼び出し位置**: `array.AsMemory(start, length)` または `array.AsMemory(range)` を使います。呼び出し位置での明示性そのものが目的でない限り、`new ReadOnlyMemory<T>(array, start, length)` は避けます。
- **ホットパス**: パフォーマンスには関係ありません。JIT は 6 つの経路すべてを同じ構造体構築に lowering します。最も読みやすいものを選んでください。

## 関連記事

- [.NET 11 で `SearchValues<T>` を正しく使う方法](/ja/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/): `ReadOnlyMemory<T>.Span` と自然に組み合わせられる span フレンドリーな検索について。
- [C# で `BlockingCollection` の代わりに Channels を使う方法](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/): `ReadOnlyMemory<T>` のペイロードを受け渡す非同期パイプラインを組みたいときに。
- [EF Core 11 で `IAsyncEnumerable<T>` を使う方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/): メモリービューと相性の良いストリーミングパターンに。
- [.NET 11 で大きな CSV をメモリー不足にせずに読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/): コピーなしのスライスに大きく依存します。
- [.NET 11 の新しい `System.Threading.Lock` 型を使う方法](/ja/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/): スレッド間で共有される可変の `Memory<T>` の周りで使いたい同期プリミティブについて。

## 参考資料

- [`ReadOnlyMemory<T>` リファレンス (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.readonlymemory-1)
- [`MemoryExtensions.AsMemory` リファレンス (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.memoryextensions.asmemory)
- [Memory<T> および Span<T> の使用ガイドライン (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-span/)
- [`MemoryMarshal.AsMemory` リファレンス (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.memorymarshal.asmemory)

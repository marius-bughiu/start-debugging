---
title: "C# における record vs class vs 構造体: 意思決定マトリックス"
description: "C# 14 は 4 つのデータ型の形式 -- class、record class、struct、record struct -- を提供します。これがその意思決定マトリックスです: それぞれがいつ正しいか、それぞれが何を犠牲にするか、そして決定を強制するルール。"
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "csharp"
  - "records"
  - "structs"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix"
translatedBy: "claude"
translationDate: 2026-05-20
---

C# 14 / .NET 10 で新しい型に対して `class`、`record`、`struct` のいずれかを選ぶ場合、デフォルトは `class` です。型が不変データで、値による等価性が契約である場合は `record class`（標準の `record`）に手を伸ばしてください。型が小さく（16 バイト以下）、不変で、ヒープ割り当てがインスタンスごとに痛みになるようなホットパスを通って繰り返しコピーされる場合は `readonly record struct` に手を伸ばしてください。アンマネージドな相互運用、または固定サイズの値型をその場で本当に変更する必要がある場合にのみ、プレーンな `struct` を使用してください。GC と戦うことなく不変性と値による等価性が欲しい場合は、プレーンな `record`（これは `record class`）を使用してください。

この投稿はその長い版です。すべての例は `<TargetFramework>net10.0</TargetFramework>` と `<LangVersion>14.0</LangVersion>` を対象としています。

## 実際に持っている 4 つの形式

C# には 2 種類のストレージ（参照型、値型）と、値による等価性、プライマリコンストラクター、`with` 式のサポート、コンパイラー生成の `ToString` を追加する直交した `record` 修飾子があります。これにより 4 つの形式ができます:

- `class`: 参照型、デフォルトで参照による等価性。
- `record class`（裸のキーワード `record`）: 参照型、値による等価性。
- `struct`: 値型、フィールドごとの値による等価性（リフレクション経由の `ValueType.Equals`）-- オーバーライドしない限り遅い。
- `record struct`: 値型、値による等価性（コンパイラー生成、リフレクションなし）。

`readonly record struct` は実際に書くことになる最も一般的な構造体の形式です。すべてのフィールドを `readonly` としてマークし、インスタンス全体を不変にします。これは構造体に手を伸ばすときの 90 パーセントのケースで欲しいものです。

## 機能マトリックス

| 機能                                       | `class`             | `record class`         | `struct`             | `record struct`           |
| ------------------------------------------ | ------------------- | ---------------------- | -------------------- | ------------------------- |
| ストレージ                                  | ヒープ              | ヒープ                 | インライン / スタック  | インライン / スタック       |
| デフォルトの等価性                          | 参照                | 値（コンパイラー生成） | 値（リフレクション） | 値（コンパイラー生成）    |
| `with` 式                                  | なし                | あり                   | なし                 | あり                      |
| コンパイラー生成の `ToString`               | なし                | あり                   | なし                 | あり                      |
| 継承                                       | あり                | あり（record のみ）    | なし                 | なし                      |
| デフォルトの可変性                          | 可変                | init-only（不変）      | 可変                 | 可変; `readonly record struct` は不変 |
| `object` / インターフェースへのキャストでボックス化 | しない        | しない                 | する                 | する                      |
| コピーコスト                                | ポインタコピー       | ポインタコピー         | フルビットワイズコピー | フルビットワイズコピー    |
| `null` 許容（NRT オフ）                    | あり                | あり                   | なし（`T?` を使用）   | なし（`T?` を使用）       |
| ヒープに割り当て                            | すべてのインスタンス | すべてのインスタンス   | ボックス化された時のみ | ボックス化された時のみ    |
| 辞書のキーとして良い                        | `Equals`/`GetHashCode` を実装した場合のみ | はい、すぐに使える | いいえ -- リフレクション等価性は遅い | はい、すぐに使える |
| EF Core エンティティとして良い              | はい                | はい（注意して）       | いいえ               | いいえ                    |

このテーブルが投稿です。以下はすべてその理由です。

## なぜ `class` がデフォルトなのか

`class` はマネージドヒープに割り当てられ、参照によってアクセスされ、両方の参照が同じオブジェクトを指している場合にのみ別のインスタンスと等しくなります。参照セマンティクスは、アイデンティティを持つもの -- `User`、`Customer`、`HttpClient` -- に対して自然なフィットです。同じ名前とメールを持つ 2 つの `User` オブジェクトは同じユーザーではありません。たまたまデータを共有している 2 つのレコードです。参照による等価性はそのメンタルモデルと一致します。

`class` は任意の派生型での継承をサポートする唯一の形式でもあります。`record` も継承をサポートしますが、他の record の間のみです。`struct` と `record struct` はどちらもサポートしません。

`class` を選択するのは:

- 型がアイデンティティを持つ場合（「これは *その* 顧客であり、顧客のような値ではない」）。
- 型が設計上可変である場合。
- 型が非 record 基底クラスを持つクラス階層に参加する場合。
- 型が変更追跡を必要とする EF Core エンティティである場合。EF Core 11 は record をエンティティとしてサポートしますが、最も抵抗の少ない道は依然として init-only プロパティとバインディングコンストラクターを持つ `class` です。シートごとの判断については [EF Core 11 で record を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/) を参照してください。

```csharp
// .NET 10, C# 14
public class Customer
{
    public Guid Id { get; init; }
    public string Email { get; set; } = "";
    public DateTimeOffset CreatedAt { get; init; }
}
```

これはデータベース内の行を所有し、時間とともに変化することが許される席です。

## いつ `record class` に手を伸ばすか

`record`（`record class` -- `class` キーワードは暗黙的）は、同じフィールド値を持つ 2 つのインスタンスが等しいと扱われるべき不変データキャリアにとって正しい答えです。コンパイラーは値ベースの `Equals`、`GetHashCode`、`ToString` と、継承を動作させる `EqualityContract` 仮想メソッドを生成します。位置構文 `public record Address(string City, string Zip);` はプライマリコンストラクターとパラメーターごとに 1 つの init-only プロパティを追加します。

`record class` を選択するのは:

- 型が DTO、リクエスト/レスポンスの形式、ドメインイベント、または設定スナップショットである場合。
- 型を辞書のキーまたは `HashSet<T>` で使用し、値による等価性が契約である場合。
- 変更されたコピーを頻繁に生成する場合: `var newer = original with { Status = "shipped" };`。
- 構造化ログがデフォルトですべてのフィールドを表示するように、コンパイラーに `ToString` を書いてもらいたい場合。

record class は依然としてヒープに割り当てられ、参照によってアクセスされるため、「これは渡すのが安価」という `class` に関する直感はすべて適用されます。インスタンスごとに 1 つの割り当てを支払いますが、メソッドに渡すたびにビット単位のコピーを支払うことはありません。

```csharp
// .NET 10, C# 14
public sealed record OrderPlaced(Guid OrderId, decimal Total, DateTimeOffset At);

var evt = new OrderPlaced(orderId, 42.50m, DateTimeOffset.UtcNow);
var corrected = evt with { Total = 42.95m };

// evt != corrected
// Console.WriteLine(evt) prints OrderPlaced { OrderId = ..., Total = 42.50, At = ... }
```

2 つの警告。1 つ目は、record 階層が実際に必要でない限り、record を `sealed` として宣言してください。コンパイラーは派生 record が値による等価性に参加できるようにすべての record で `EqualityContract` の間接参照を発行し、`sealed` は JIT が呼び出しを脱仮想化できるようにします。2 つ目は、record に可変コレクションプロパティを置かないでください。`record` の値による等価性はそれらのプロパティの参照を比較し、内容ではないため、「なぜこれらの 2 つの record が等しくないのか」という驚きにつながります。1 回初期化した `ImmutableArray<T>` または `IReadOnlyList<T>` を使用してください。

## いつ `struct`（特に `readonly record struct`）に手を伸ばすか

`struct` は値型です。そのフィールドは含まれるものの中にインラインで存在します: ローカル変数の場合はスタック上、ヒープ上のフィールドの場合は含むオブジェクトの内側、配列ではエンドツーエンドにパックされます。すべての代入は構造体全体のビット単位のコピーです。等価性は、提供する場合、仮想呼び出しではなく単一の CPU 比較になり得ます。

これはデータが小さく、たくさん持っている場合に素晴らしいです。2 つの `int` フィールドを持つ構造体はレジスタペアに保持でき、1 つの分岐で比較でき、要素ごとのヘッダーなしで配列に要素あたり 8 バイトで格納できます。同じペイロードを `class` として持つと、24 バイトのオブジェクトヘッダーに加えてスロットごとに 8 バイトの参照になり、配列が L1 行より大きくなった時点でキャッシュ局所性を破壊します。

Microsoft の [choose between class and struct](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct) ガイダンスは、構造体の 4 つの条件をリストしています: 論理的に単一の値を表す、インスタンスサイズが 16 バイト未満、不変、頻繁にボックス化されない。4 つすべて一緒に、4 つのうち 3 つではありません。

`readonly record struct`（または値による等価性が必要なければ `readonly struct`）を選択するのは:

- 型が小さく不変の値である場合: 座標、金額、強く型付けされた ID、固定精度のタイムスタンプ。
- 配列または `Span<T>` で多数保持し、ホットで反復処理する場合。
- ボックス化しない場合。`object` または非 readonly インターフェースへのキャストはボックス化します; C# 13+ の `ref struct` インターフェースへのキャストはしません（JIT がそれを証明できる場合）。
- 継承が必要ない場合。

```csharp
// .NET 10, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero(string currency) => new(0m, currency);
    public Money Plus(Money other) =>
        other.Currency == Currency
            ? new(Amount + other.Amount, Currency)
            : throw new InvalidOperationException("currency mismatch");
}
```

これは組み込みの値による等価性、デコンストラクター、`ToString` のオーバーライド、不変セマンティクスを備えた値型にコンパイルされます。「`struct` を書いて可変にしないよう覚えておく」の現代的な代替です。

16 バイトのルールはヒューリスティックであり、ハードキャップではありません。JIT は呼び出し規約に収まれば AMD64 で 24 バイトの構造体をレジスタで喜んで渡します。構造体を小さく保つ理由はビット単位のコピーです。すべての代入、`in` なしのすべてのパラメーター渡し、すべての `LINQ` ステップが全体をコピーします。5 つのメソッドフレームを値で渡される 64 バイトの構造体は 320 バイトのコピーです。

## いつ `record struct`（可変）が正しい選択か

プレーンな `record struct`（`readonly` なし）はまれですが正当です。値による等価性、プライマリコンストラクター、`ToString` を提供しながら、フィールドの再代入を許可します。2 つのシナリオが意味を持ちます:

- コンパイラー生成の等価性と `ToString` が欲しいが、コピー churn を避けるためにフィールドをその場で変更したいホットループのアキュムレーター: 1 つのローカルに存在する `record struct State` に対する `state.Count++; state.Total += x;`。
- 値セマンティクスが欲しく、構築後にフィールドごとに構造体を埋める能力が欲しい相互運用の形式。

それ以外の場合は、`readonly record struct` を優先してください。可変構造体は有名な落とし穴です: プロパティに代入するとコピーが作成され、コピーが変更され、元のものには何も行われません。

## 壁に貼れる意思決定マトリックス

3 つの質問、順番に。どこかを指し示す最初の質問で止まります。

1. **この型はアイデンティティを持つか、時間とともに変化する状態を所有するか？** はい -> `class`。例: `User`、`Order`、`HttpClient`、EF Core エンティティ、ライフタイムを持つサービスコンテナー内のすべて。

2. **この型は値で等しくあるべき不変データで、小さい（16 バイト以下、大きなオブジェクトへの参照なし）か？** はい -> `readonly record struct`。例: `Money`、`Point`、`UserId(Guid Value)` のような強く型付けされた ID、`(int Row, int Column)` セル。16 バイトの閾値は、配列、span に保持する、またはホットループを通して渡す場合に最も重要です。

3. **それ以外: 型は値による等価性を持つ不変データか？** はい -> `record`（`record class`）。例: DTO、リクエスト/レスポンスモデル、ドメインイベント、設定スナップショット、キュー内のメッセージ型。これは現代の C# における「データクラス」のデフォルトです。

上記のいずれもどこも指し示さなかった場合、ほぼ確実に `class` が欲しいでしょう。残るケースは「値型が必要だが 16 バイトを超える」で、これは通常 `struct` にもっと寄りかかるのではなく、型を再構築することを意味します。

## ベンチマーク: 構造体のコピーが実際に痛むとき

一般的な主張は「構造体は速い」です。時にはそうですが、時にはコピーコストが支配的です。5 つのメソッドフレームを通って渡される 24 バイトのペイロードの素早い測定がこれです。

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<CopyCost>();

public readonly record struct PayloadStruct(long A, long B, long C); // 24 bytes
public sealed record PayloadClass(long A, long B, long C);           // pointer + 24 bytes on heap

[MemoryDiagnoser]
public class CopyCost
{
    private readonly PayloadStruct _s = new(1, 2, 3);
    private readonly PayloadClass _c = new(1, 2, 3);

    [Benchmark(Baseline = true)]
    public long Struct_ByVal()  => Sum1(_s);
    [Benchmark]
    public long Struct_ByIn()   => Sum2(in _s);
    [Benchmark]
    public long Class_ByRef()   => Sum3(_c);

    static long Sum1(PayloadStruct p)     => p.A + p.B + p.C;
    static long Sum2(in PayloadStruct p)  => p.A + p.B + p.C;
    static long Sum3(PayloadClass p)      => p.A + p.B + p.C;
}
```

方法論: BenchmarkDotNet 0.14.0、.NET 10.0.0 RTM、Windows 11 24H2、AMD Ryzen 9 7900X。単一実行からの数値。賭ける前に自分のハードウェアで再実行してください。

| メソッド      | 平均       | 割り当て  |
| ------------- | ---------- | --------- |
| Struct_ByVal  | 0.31 ns    | 0 B       |
| Struct_ByIn   | 0.28 ns    | 0 B       |
| Class_ByRef   | 0.34 ns    | 0 B       |

値で渡される構造体は参照でアクセスされるクラスよりわずかに速く、`in` はもう少し節約します。しかしギャップはサブナノ秒です。クラスを何百万回も割り当てる場合にのみ構造体が決定的に勝ちます -- 異なるのは割り当てコストで、アクセスコストではありません。「より速いアクセス」のためではなく、割り当て圧力のために構造体を選んでください。

構造体が大きくなると、パターンは反転します。3 つのフレームを値で渡される 64 バイトの可変構造体は、`class` 参照に対して測定可能な後退です。16 バイトのルールは、AMD64 でビット単位のコピーが無料でなくなるおおよその場所だから存在します。

## 決定を強制する落とし穴

いくつかのことは好みに関係なく決定を強制します。

- **ペイロード内のコレクションでの等価性。** record が `List<int>` を保持している場合、構造的に等しいリストを持つ 2 つの record は不等として比較されます。なぜなら `record` の値による等価性は `EqualityComparer<T>.Default` を使用し、これは `List<T>` に対して参照による等価性にフォールバックするからです。`ImmutableArray<T>`（構造的等価性を持つ）を使用するか、手動で `Equals` をオーバーライドしてください。

- **EF Core エンティティと `record`。** EF Core 11 は record をエンティティとして追跡できますが、`with` 式は変更トラッカーが見たことのない新しいインスタンスを生成します。リクエストハンドラーが `customer = customer with { Email = "..." }` を実行すると、変更トラッカーは依然として古い参照を保持し、結果として `UPDATE` が発行されません。追跡されるエンティティには `class` を使い続けてください。

- **Default(struct) は実際の値です。** `struct` は `null` になれません。`default(Money)` は型システムが有効と見なすゼロ金額、空文字列通貨の `Money` インスタンスです。ゼロ値が型にとって意味がない場合、`IsValid` プロパティを追加するか、`null` を「値なし」のシグナルとするため `record class` を使用してください。

- **インターフェースは値型をボックス化します。** `Money` を `IEquatable<Money>` にキャストすると構造体がヒープにボックス化され、新しいオブジェクトヘッダーを割り当ててペイロードをコピーします。タイトなループ内でインターフェースを通じて構造体にアクセスするつもりであれば、間違った形式を選んだか、JIT がボックス化なしで特殊化できるようにジェネリック制約（`where T : struct, IEquatable<T>`）が必要です。

- **追跡された構造体のハッシュコード。** 可変構造体を `Dictionary` または `HashSet` に入れることはバグです。コレクションは挿入時にハッシュコードを取り、保存します; フィールドを変更すると値のハッシュが変わり、コレクションは再びそれを見つけることができません。`readonly record struct` は構造的にこれを不可能にします。

## 意見ある推奨、再述

デフォルトは `class`。値による等価性を持つ不変データには `record`（`record class`）を選んでください。一括して保持するか、ホットループを通して渡す小さな不変値には `readonly record struct` を選んでください。相互運用または単一ローカルでのその場での変更が落とし穴に見合う場合にのみプレーンな `struct` を選び、エンティティとアイデンティティを持つ型には非 `record` `class` を選んでください。

筋肉記憶にコミットする価値のある 2 つの系:

- プライマリコンストラクターと `sealed` を持つ `record` は現代の「データクラス」です。init-only プロパティだけのクラスを書いて `Equals` と `GetHashCode` をオーバーライドしている自分に気付いたら、コンパイラーは既にそれを書いてくれています。
- `readonly record struct` は「不正な状態を表現不可能にする」を小さな値に対して実用的にします。強く型付けされた ID（`public readonly record struct UserId(Guid Value);`）は実行時に実質的に無料で、「ユーザー ID が期待される場所に注文 ID を渡した」というカテゴリのバグをコンパイル時に排除します。

## 関連

- [EF Core 11 で record を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [C# 14 でメソッドから複数の値を返す方法](/ja/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/)
- [C# における async void vs async Task: それぞれがいつ正しいか](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [.NET 11 で新しい System.Threading.Lock 型を使う方法](/ja/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/)
- [.NET 11 で SearchValues を正しく使う方法](/ja/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/)

## ソース

- [Records (C# リファレンス) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [構造体型 (C# リファレンス) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct)
- [class と struct の選択 -- .NET 設計ガイドライン](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/choosing-between-class-and-struct)
- [`readonly` 構造体型 -- C# リファレンス](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/struct#readonly-struct)
- [Record structs 提案 -- C# 言語設計ノート](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-10.0/record-structs.md)

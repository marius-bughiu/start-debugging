---
title: "C# の `with` 式は実際に何をコピーするのか、そしてレコードの計算プロパティが再計算されないのはなぜか"
description: "with 式はレコードのコンパイラー生成メソッド <Clone>$ を呼び出し、そこでコピーコンストラクターが全インスタンスフィールドをコピーし、すべての初期化子をスキップします。そのため、他のプロパティから初期化されるプロパティ、キャッシュされた値、Guid の ID は古いまま残ります。.NET 10 と C# 14 で計測し、実際に有効な対処法を紹介します。"
pubDate: 2026-10-16
tags:
  - "csharp"
  - "csharp-14"
  - "records"
  - "dotnet-10"
  - "immutability"
lang: "ja"
translationOf: "2026/10/what-does-a-csharp-with-expression-actually-copy"
translatedBy: "claude"
translationDate: 2026-10-16
---

**結論:** .NET 10 上の C# 14 では (レコードが C# 9 で登場して以降のすべてのバージョンでも)、レコードクラスに対する `a with { X = 1 }` は 2 つのことを行います。まずコンパイラーが生成する `<Clone>$` メソッドを呼び出し、それがレコードのコピーコンストラクターを呼び出します。その後、指定した `init` アクセサーを順番に実行します。コピーコンストラクターは **すべてのインスタンスフィールド** をバイト単位でコピーし (シャローコピー)、フィールドやプロパティの初期化子は **一切実行しません**。したがって `public string FullName { get; } = $"{First} {Last}";` のようなプロパティは、元のコンストラクターで一度だけ計算され、保存された値としてコピーされ、再計算されることはありません。派生値は式形式メンバー (`=> $"{First} {Last}"`) にするか、依存するプロパティの `init` アクセサー内でキャッシュをリセットしてください。

この記事の残りでは、コンパイラーが実際に何を生成するのか、どの種類の "計算" メンバーが `with` を生き延びてどれが生き延びないのか、レコード内でキャッシュすることによる厄介な等価性の副作用、そして実用に耐えるパターンを順に示します。以下の出力はすべて、SDK 10.0.302、ランタイム 10.0.10 のファイルベースアプリ (`dotnet run probe.cs`) で得たものです。

## レコードに対してコンパイラーが生成するもの

単純な位置指定レコードを例にします。

```csharp
// .NET 10, C# 14
record Person(string First, string Last);
```

プライマリコンストラクター、プロパティ、等価性、`ToString` のほかに、コンパイラーはコピー用のメンバーを 2 つ生成します。[レコードの仕様](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members)ではこれらを "コピーコンストラクター" と "クローン" メソッドと呼んでいます。リフレクションで両方を確認できます。

```csharp
// .NET 10, C# 14
using System.Reflection;

foreach (var m in typeof(Person).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
                                .Where(m => m.Name.Contains("Clone")))
    Console.WriteLine($"method: {m.Name} virtual={m.IsVirtual} returns {m.ReturnType.Name}");

foreach (var c in typeof(Person).GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
    Console.WriteLine($"ctor: ({string.Join(",", c.GetParameters().Select(p => p.ParameterType.Name))}) protected={c.IsFamily}");
```

出力:

```text
method: <Clone>$ virtual=True returns Person
ctor: (String,String) protected=False
ctor: (Person) protected=True
```

`<Clone>$` は C# では書けない名前なので、呼び出せるのはコンパイラーだけです。本体は単に `return new Person(this);` です。コピーが行われるのは protected の `Person(Person original)` コンストラクターで、その動作は仕様に正確に書かれています。基底のコピーコンストラクター (または `object()`) を呼び出した後、"レコード型内で暗黙的または明示的に宣言されたすべてのインスタンスフィールドの値をコピーし"、"レコード宣言に存在するインスタンスフィールドやプロパティの初期化子は実行しません。"

したがって次のコードは、

```csharp
var b = a with { First = "Grace" };
```

おおよそ次のように変換されます。

```csharp
var tmp = a.<Clone>$();   // new Person(a): field-by-field copy, no initializers
tmp.First = "Grace";       // the init accessor, legal here because the compiler emits it
var b = tmp;
```

この変換から 2 つの帰結がそのまま導かれます。第一に、コピー中にレコード本体に書いたコードのうち実行されるのは、名前を指定したメンバーの `init` アクセサーだけです。第二に、それらの `init` アクセサーはコピーの後で、元のインスタンスのすべてのフィールドをすでに保持しているインスタンスに対して実行されます。

## "計算" プロパティの 4 通りの書き方と 4 通りの結果

次のレコードには、どれも `First` と `Last` から導出されているように見えるメンバーが 4 つあります。

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string Init { get; } = $"{First} {Last}";   // property initializer
    public string Expr => $"{First} {Last}";            // expression-bodied
    private string? _cached;
    public string Cached => _cached ??= $"{First} {Last}"; // lazy cache in a field
}
```

コピーの前にキャッシュへ触れる実行例です。

```csharp
var a = new Name("Ada", "Lovelace");
Console.WriteLine(a.Cached);              // fills the cache on a
var b = a with { First = "Grace" };
Console.WriteLine($"{b.Init} | {b.Expr} | {b.Cached}");
Console.WriteLine(b);
```

出力:

```text
Ada Lovelace
Ada Lovelace | Grace Lovelace | Ada Lovelace
Name { First = Grace, Last = Lovelace, Init = Ada Lovelace, Expr = Grace Lovelace, Cached = Ada Lovelace }
```

正しいのは式形式のプロパティだけです。理由は先ほどの変換にそのまま対応しています。

- **`Init { get; } = ...`** は隠れた `<Init>k__BackingField` に支えられています。初期化子は `a` のプライマリコンストラクター内で一度だけ実行されました。コピーコンストラクターはバッキングフィールドを文字列としてコピーしただけで、初期化子は再実行しません。その後 `First` は変わりましたが、`Init` を再代入するものは何もありません。
- **`Expr => ...`** にはバッキングフィールドがありません。呼び出されるたびに `First` と `Last` を読み取るメソッドなので、コピーが現在保持している値が反映されます。
- **`Cached => _cached ??= ...`** は最も気づきにくいケースです。元のオブジェクトで誰かが `Cached` を読む *前に* `with` を呼ぶと、`_cached` はまだ `null` で、`null` のままコピーされ、コピー側が正しい値を計算します。元のキャッシュがすでに埋まっていると、コピーは `"Ada Lovelace"` を引き継ぎ、`??=` は発動しません。このバグは、無関係なコードパスがたまたま先にそのプロパティを読んだかどうかに依存するため、再現するのが非常に厄介です。

フィールド初期化子が生成するものすべてに同じことが起こります。`public Guid Id { get; } = Guid.NewGuid();` を持つレコードは、`with` で作ったどのコピーでも **同じ** `Id` を保持します。初期化子が実行されないことは、カウンターで確認しました。

```csharp
// .NET 10, C# 14
var t = new Tracked("x");
var t2 = t with { Value = "y" };
Console.WriteLine($"initializer runs: {Counter.Count}, stamp same: {t.Stamp == t2.Stamp}");

static class Counter { public static int Count; }
record Tracked(string Value)
{
    public long Stamp { get; } = ++Counter.Count;
}
```

```text
initializer runs: 1, stamp same: True
```

構築は 1 回、初期化子の実行も 1 回で、インスタンスは 2 つです。生成された ID やタイムスタンプを持つイベントやコマンドにレコードを使っている場合、`with` は同じイベントだと主張する 2 つ目のオブジェクトを作ってしまいます。

## 等価性の罠: 隠れたフィールドも `==` に関与する

レコードの等価性もインスタンスフィールドから合成され、private なものも含まれます。そのため、上記の古いコピーは、見た目のデータが同じで新しく作ったレコードとは等しくなりません。

```csharp
var c = new Name("Grace", "Lovelace");
Console.WriteLine(b == c); // False: b.Init and b._cached still say "Ada Lovelace"
```

さらに悪いことに、遅延キャッシュがあると、`with` を使わなくても等価性が *読み取り履歴* に依存します。

```csharp
// .NET 10, C# 14
var x = new Name2("Ada", "Lovelace");
var y = new Name2("Ada", "Lovelace");
Console.WriteLine(x == y);   // True
_ = x.FullName;              // only reads a property
Console.WriteLine(x == y);   // False

record Name2(string First, string Last)
{
    private string? _fullName;
    public string FullName => _fullName ??= $"{First} {Last}";
}
```

```text
True
False
```

ゲッターを読んだだけで `==` の結果が変わりました。そうしたレコードをディクショナリのキーやセットのメンバーにしたり、テストのアサーションで比較したりすると、デバッグ用に `Console.WriteLine` を追加すると消えてしまう失敗が起こります。これは、レコード内でそもそもキャッシュを行うべきでないことの最も強力な根拠です。

## 徹頭徹尾シャローコピーである

コピーコンストラクターはフィールドの値をコピーします。参照型フィールドでは、その値は参照なので、2 つのレコードは同じオブジェクトを指します。

```csharp
// .NET 10, C# 14
var o = new Order(1, new List<string> { "apple" });
var o2 = o with { Id = 2 };
o2.Items.Add("pear");
Console.WriteLine($"o.Items: {string.Join(",", o.Items)} same list: {ReferenceEquals(o.Items, o2.Items)}");

record Order(int Id, List<string> Items);
```

```text
o.Items: apple,pear same list: True
```

`Lazy<T>` フィールド (両方のコピーが評価済みの `Lazy` を共有します)、`StringBuilder`、入れ子になった可変クラスでも同様です。レコードの不変性は、最も不変でないフィールドの水準までしかありません。`ImmutableArray<T>` か、変更しない配列を裏に持つ `IReadOnlyList<T>` を使い、`with` は "最上位のコピー" だと考えてください。

## 継承: `with` は実行時の型を保つ

`<Clone>$` は仮想メソッドで、各派生レコードは共変の戻り値型でこれをオーバーライドします。基底型の変数を通して `with` を使うと、派生型が生成されます。

```csharp
// .NET 10, C# 14
Person p = new Student("Alan", "Turing", "King's");
var q = p with { First = "Alonzo" };
Console.WriteLine(q.GetType().Name); // Student

record Person(string First, string Last);
record Student(string First, string Last, string College) : Person(First, Last);
```

`Student` をリフレクションで調べると `<Clone>$ returns Student` と表示されます。通常は望ましい動作ですが、基底参照に対する `with` は、呼び出し側のコードから見えない派生型だけの状態 (ここでは `College`) もコピーすることを意味します。派生レコードで宣言された古いキャッシュフィールドも含まれます。

`sealed record` の場合、コンパイラーはコピーコンストラクターを `private` にし、`<Clone>$` を非仮想にします (プローブは `sealed copy ctor private: True; clone virtual: False` と出力しました)。

## `with` 式が代入できるもの

`with` はクローンの後でアクセサーを実行するため、設定できるのは `set` または `init` アクセサーを持ち、呼び出し箇所からアクセス可能なメンバーだけです。古くなった計算プロパティを代入で "修正" しようとすると失敗します。

```csharp
// .NET 10, C# 14
record A(int X) { public int Computed { get; } = X * 2; }

var b = new A(1) with { Computed = 3 };
// error CS0200: Property or indexer 'A.Computed' cannot be assigned to -- it is read only
```

通常のクラスに対する `with` は、クラスに `<Clone>$` がないため、即座に拒否されます。

```text
error CS8858: The receiver type 'Svc' is not a valid record type and is not a struct type.
```

C# 10 以降、`with` は構造体 (`record struct` を含む)、タプル、匿名型でも使えます。これらにはクローンメソッドもコピーコンストラクターもありません。値は通常の構造体代入と同じ方法でコピーされ、その後に列挙したメンバーが代入されます。[`with` 式のドキュメント](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression)は、構造体型のコピーの動作をカスタマイズできないことを明記しています。

`required` メンバーがあっても、`with` で繰り返し指定する必要はありません。合成されるコピーコンストラクターには `[SetsRequiredMembers]` が付いているため、`required string Name` を持つレコードに対する `r with { }` はコンパイルでき、`Name` もコピーされます。初期化子での `required` メンバーに戸惑う場合は、オブジェクト初期化子側を扱う [CS9035 の解説](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)を参照してください。

## 実際に有効な対処法

### 1. アクセス時に計算する (基本の答え)

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    public string FullName => $"{First} {Last}";
}
```

バッキングフィールドがないのでコピーするものも、古くなるものもなく、`Equals` や `GetHashCode` に余計なものが入ることもありません。`with` のページにある Microsoft 自身のガイダンスも同じ内容で、レコードの計算プロパティは "インスタンス作成時に初期化するのではなく、アクセス時に計算する" べきだとしています。2 つの文字列の補間は軽い処理です。そうでないと判断する前に計測してください。

### 2. `init` アクセサーで検証または再計算する

`init` アクセサーは、`with` の間に実際に実行される、あなたのコードの唯一の部分です。C# 14 の [`field` キーワード](/ja/2025/04/c-14-the-field-keyword-and-field-backed-properties/)を使うと、バッキングフィールドを宣言せずにそこへロジックを置けます。検証は期待どおりに動作します。

```csharp
// .NET 10, C# 14
record Person(string First, string Last)
{
    public string Last { get; init => field = string.IsNullOrEmpty(value)
        ? throw new ArgumentException("Last required")
        : value; } = Last;
}

var bad = new Person("Ada", "Lovelace") with { Last = "" }; // throws ArgumentException: Last required
```

値の計算コストが本当に高く、どうしてもキャッシュが必要な場合は、入力側の `init` アクセサーからキャッシュを無効化し、キャッシュを等価性から外してください。

```csharp
// .NET 10, C# 14
record Name(string First, string Last)
{
    private string? _fullName;
    public string First { get; init { field = value; _fullName = null; } } = First;
    public string Last  { get; init { field = value; _fullName = null; } } = Last;
    public string FullName => _fullName ??= $"{First} {Last}";

    public virtual bool Equals(Name? other) =>
        other is not null && EqualityContract == other.EqualityContract
        && First == other.First && Last == other.Last;
    public override int GetHashCode() => HashCode.Combine(First, Last);
}
```

このバージョンでは、`a.FullName` が先に読まれていても `a with { First = "Grace" }` は `Grace Lovelace` を出力し、`b == new Name("Grace", "Lovelace")` は `True` になります。代償として、`Equals` と `GetHashCode` を手作業で保守することになり、プロパティを追加して含め忘れても、コンパイラーは警告してくれません。

### 3. 独自のコピーコンストラクターを書く

コピーコンストラクターを自分で宣言し、残すべきものだけをコピーできます。

```csharp
// .NET 10, C# 14
record Fixed(string First, string Last)
{
    private string? _full;
    public string FullName => _full ??= $"{First} {Last}";

    protected Fixed(Fixed original)
    {
        First = original.First;
        Last = original.Last;
        // _full deliberately not copied
    }
}
```

これは動作し (元のキャッシュが埋まっていても `f with { First = "Grace" }` は `Grace Lovelace` を返します)、リストのディープコピーを行うための文書化された方法でもあります。同時に、最も鋭い落とし穴もあります。

- **すべての** フィールドのコピーを自分で管理することになります。来月プロパティを追加してこのコンストラクターを直し忘れると、`with` は黙ってそれを `default` にリセットします。
- 派生レコードでは、基底のコピーコンストラクターへチェーンしなければなりません。省略すると、`CS1729: 'Base' does not contain a constructor that takes 0 arguments` と `CS8868: A copy constructor in a record must call a copy constructor of the base, or a parameterless object constructor if the record inherits from object.` の 2 つのエラーが出ます。修正は `protected Derived(Derived other) : base(other) { ... }` です。
- レコードが sealed でない限り、`public` または `protected` でなければなりません。
- `Equals` には何の効果もありません。キャッシュフィールドがあれば、`==` は引き続き読み取り履歴に依存します。

キャッシュ無効化の仕組みとしてではなく、コレクションのディープコピーに使ってください。

### 4. 初期化子に ID を入れない

インスタンスごとに一意でなければならない ID やタイムスタンプは、`with` を使うつもりのレコードではプロパティ初期化子で生成しないでください。明示的に渡す (`evt with { Id = Guid.NewGuid() }`) か、`with` の代わりにファクトリ経由で新しいイベントを作成します。イベントをコピーしてその ID を保持することは、まさに `with` が設計されている動作です。

## `with` を使うレコード型のチェックリスト

- 派生値はすべて式形式メンバーにするか、`init` アクセサーから再計算する。
- `Equals` と `GetHashCode` もオーバーライドしない限り、private のキャッシュフィールドを持たない。
- 可変コレクションを持たない。持つ場合は、それらをクローンするカスタムコピーコンストラクターを用意する。
- コピーされる型に `= Guid.NewGuid()` や `= DateTime.UtcNow` の初期化子を置かない。
- コピーコンストラクターを宣言する派生レコードは `base(original)` へチェーンする。

そもそも型をレコードにすべきか迷っている場合は、[record、class、struct の判断マトリクス](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)がトレードオフを扱っています。EF Core の観点 (`with` で作ったコピーは、変更トラッカーがまだ見たことのないインスタンスです) は、[EF Core 11 でレコードを正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)で扱っています。Dart の開発者も `copyWith` で同じシャローコピーの問題に直面しますが、これは [Dart のレコードと Freezed クラス](/ja/2026/05/dart-records-vs-freezed-classes/)で取り上げています。

## 関連記事

- [C# の record、class、struct: 判断マトリクス](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)
- [EF Core 11 でレコードを正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)
- [C# 14: `field` キーワードとフィールド裏付けプロパティ](/ja/2025/04/c-14-the-field-keyword-and-field-backed-properties/)
- [CS9035 の修正: required メンバーはオブジェクト初期化子で設定する必要があります](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)

## 参考資料

- [The `with` expression, C# reference (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/with-expression)
- [Records, nondestructive mutation (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record#nondestructive-mutation)
- [Records proposal, "Copy and Clone members" (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-9.0/records.md#copy-and-clone-members)
- [The `field` keyword (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/field)
